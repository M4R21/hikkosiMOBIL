/* ============================================
   matching.js — 移動先選定アルゴリズム
   ============================================ */

const Matching = (() => {

    // 出庫頻度スコア
    const FREQ_SCORE = {
        '◎': 30,
        '〇': 20,
        '○': 20,  // 全角○のバリエーション
        '△': 10,
        '▲': 0    // 除外
    };

    // 不動区分→日本語変換
    const FUDOU_LABELS = {
        'R': '180日不動',
        'O': '120日不動',
        'B': '90日不動'
    };

    function getFudouLabel(code) {
        return FUDOU_LABELS[code] || code || '—';
    }

    let excludedDrugsCache = null;
    let lastExcludeFetch = 0;

    // ひらがな→カタカナ変換
    function hiraToKana(str) {
        return str.replace(/[\u3041-\u3096]/g, function(match) {
            return String.fromCharCode(match.charCodeAt(0) + 0x60);
        });
    }

    // マッチング用の正規化（Adminに依存しない独立実装）
    function normalizeForMatch(str) {
        if (!str) return '';
        // 半角英数記号→全角
        str = String(str).replace(/[A-Za-z0-9!-/:-@\[-`{-~]/g, function(s) {
            return String.fromCharCode(s.charCodeAt(0) + 0xFEE0);
        });
        // 半角スペース→全角スペース
        str = str.replace(/ /g, '　');
        // 半角括弧→全角括弧
        str = str.replace(/｢/g, '「').replace(/｣/g, '」');
        // ひらがな→カタカナ
        str = hiraToKana(str);
        // 小文字化
        str = str.toLowerCase();
        // 全角・半角スペースを全て削除
        return str.replace(/[\s　]/g, '');
    }

    // メーカー名（「〇〇」）を除去して基本薬品名を取得
    function stripManufacturer(str) {
        // 「〇〇」の部分を除去（末尾の「...」を取り除く）
        return str.replace(/「[^」]*」\s*$/g, '').trim();
    }

    async function checkExcluded(drugName) {
        const now = Date.now();
        if (!excludedDrugsCache || now - lastExcludeFetch > 3000) {
            excludedDrugsCache = await DB.getAll('excludedDrugs');
            lastExcludeFetch = now;
        }

        const targetNormalized = normalizeForMatch(drugName);

        return excludedDrugsCache.some(d => {
            if (d.includeOthers) {
                // メーカー名を除去した基本名で前方一致
                const baseName = normalizeForMatch(stripManufacturer(d.drugName));
                return targetNormalized.startsWith(baseName);
            }
            // 完全一致
            const excludeNormalized = normalizeForMatch(d.drugName);
            return targetNormalized === excludeNormalized;
        });
    }

    /**
     * 指定薬品の移動先候補を算出（上位5件）
     * @param {string} drugName - 薬品名
     * @param {number} selfStoreIndex - 自店舗のインデックス
     * @returns {Array} candidates - [{storeIndex, storeName, score, freq, months, stockQty}]
     */
    async function findCandidates(drugName, selfStoreIndex) {
        // 除外薬品チェック（前方一致で規格のみ登録に対応）
        const isExcluded = await checkExcluded(drugName);
        if (isExcluded) {
            return { status: 'excluded', message: '移動不可（除外薬品）', candidates: [] };
        }

        // 該当薬品の全店舗在庫を取得
        const inventoryRecords = await DB.getInventoryByDrug(drugName);

        if (!inventoryRecords || inventoryRecords.length === 0) {
            return { status: 'none', message: '引き取り先なし', candidates: [] };
        }

        // 麻薬チェック（最初のレコードの規制情報で判定）
        const sampleRecord = inventoryRecords[0];
        if (sampleRecord && sampleRecord.isNarcotic) {
            return { status: 'narcotic', message: '移動不可（麻薬）', candidates: [] };
        }

        // アクティブ店舗リスト取得
        const activeStores = await DB.getActiveStores();
        const activeStoreSet = new Set(activeStores.map(s => s.storeIndex));

        // 店舗名マップ
        const storeMap = {};
        activeStores.forEach(s => { storeMap[s.storeIndex] = s.storeName; });

        // 候補をフィルタ・スコアリング
        const candidates = [];
        let allBlackTriangle = true;

        for (const rec of inventoryRecords) {
            // 自店舗を除外
            if (rec.storeIndex === selfStoreIndex) continue;

            // 除外店舗を除外
            if (!activeStoreSet.has(rec.storeIndex)) continue;

            // （修正）相手の在庫数が0であっても、出庫頻度（動き）があるなら候補として非常に有力なため、在庫0でスキップしないように変更
            // if (!rec.stockQty || rec.stockQty <= 0) continue;

            const freq = rec.shipFreq || '';
            let freqScore = FREQ_SCORE[freq];

            // △かつ在庫0の場合は一時使用の可能性があるため、通常の△(10)より優先度を下げる(5にする)
            if (freq === '△' && (!rec.stockQty || rec.stockQty <= 0)) {
                freqScore = 5;
            }

            // ▲は除外だが記録は残す
            if (freq === '▲') {
                continue;
            }

            if (freqScore === undefined || freqScore === 0) continue;

            allBlackTriangle = false;

            candidates.push({
                storeIndex: rec.storeIndex,
                storeName: storeMap[rec.storeIndex] || `店舗${rec.storeIndex}`,
                freq: freq,
                freqScore: freqScore,
                months: rec.months != null ? rec.months : 999,
                stockQty: rec.stockQty != null ? rec.stockQty : 0,
                stockAmount: rec.stockAmount != null ? rec.stockAmount : 0,
                fudouClass: rec.fudouClass || ''
            });
        }

        if (candidates.length === 0) {
            // ▲のみか候補なしかを判定
            const hasBlackTriangle = inventoryRecords.some(r => 
                r.storeIndex !== selfStoreIndex && 
                activeStoreSet.has(r.storeIndex) && 
                r.shipFreq === '▲' && 
                r.stockQty > 0
            );
            if (hasBlackTriangle) {
                return { status: 'black_triangle', message: '▲', candidates: [] };
            }
            return { status: 'none', message: '引き取り先なし', candidates: [] };
        }

        // ソート: 出庫頻度(降順) → 月数(昇順) → 在庫数(昇順)
        candidates.sort((a, b) => {
            if (b.freqScore !== a.freqScore) return b.freqScore - a.freqScore;
            if (a.months !== b.months) return a.months - b.months;
            return a.stockQty - b.stockQty;
        });

        // 上位5件
        const top5 = candidates.slice(0, 5);

        return {
            status: 'found',
            message: '',
            candidates: top5
        };
    }

    /**
     * 不動区分のバッジHTML
     */
    function getFudouBadge(code) {
        const label = getFudouLabel(code);
        const cls = code === 'R' ? 'badge-r' : code === 'O' ? 'badge-o' : code === 'B' ? 'badge-b' : 'badge-none';
        return `<span class="badge ${cls}">${label}</span>`;
    }

    return {
        findCandidates,
        checkExcluded,
        getFudouLabel,
        getFudouBadge,
        FREQ_SCORE
    };
})();
