/* ============================================
   hikitori.js — 引き取り検索ロジック
   備蓄品目拡充のため、他店舗で出庫頻度◎/〇かつ
   自店舗で在庫0の薬品を検索する
   ============================================ */

const Hikitori = (() => {

    let currentStoreIndex = null;
    let currentStoreName = '';
    let searchResults = [];
    let sortKey = 'unitPrice';
    let sortAsc = true;

    // 対象とする出庫頻度
    const TARGET_FREQ = new Set(['◎', '〇', '○']);

    // 検索対象の単位リスト（UI表示用）
    const UNIT_LIST = ['ｇ', 'ｍｌ', 'ｍＬＶ', 'カプセル', 'キット', 'シート', 'ブリスター', '管', '缶', '丸', '個', '錠', '袋', '筒', '瓶', '分', '包', '本', '枚'];

    // ===== 初期化 =====
    async function init() {
        document.getElementById('hikitori-back').addEventListener('click', () => App.navigateTo('home'));
        document.getElementById('hikitori-store-select').addEventListener('change', onStoreSelect);
        document.getElementById('btn-hikitori-search').addEventListener('click', search);
        document.getElementById('btn-hikitori-csv').addEventListener('click', exportCSV);
        document.getElementById('btn-hikitori-store-all').addEventListener('click', () => toggleCheckboxes('.hikitori-store-checkbox', true));
        document.getElementById('btn-hikitori-store-clear').addEventListener('click', () => toggleCheckboxes('.hikitori-store-checkbox', false));
        document.getElementById('btn-hikitori-unit-all').addEventListener('click', () => toggleCheckboxes('.hikitori-unit-checkbox', true));
        document.getElementById('btn-hikitori-unit-clear').addEventListener('click', () => toggleCheckboxes('.hikitori-unit-checkbox', false));

        // テーブルヘッダーのソート
        document.querySelectorAll('#hikitori-table th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                if (sortKey === key) {
                    sortAsc = !sortAsc;
                } else {
                    sortKey = key;
                    sortAsc = true;
                }
                renderResults();
                updateSortIndicators();
            });
        });
    }

    function toggleCheckboxes(selector, checked) {
        document.querySelectorAll(selector).forEach(cb => {
            const label = cb.closest('label');
            // 非表示のものはチェック状態を変更しない（店舗リストの自店舗対策）
            if (!label || label.style.display !== 'none') {
                cb.checked = checked;
            }
        });
    }

    // ===== 画面表示時 =====
    async function onShow() {
        await populateStoreSelect();
        // リセット
        currentStoreIndex = null;
        currentStoreName = '';
        searchResults = [];
        document.getElementById('hikitori-store-select').value = '';
        document.getElementById('hikitori-price-max').value = '';
        document.getElementById('hikitori-table-body').innerHTML = '';
        document.getElementById('hikitori-results-card').classList.add('hidden');
        document.getElementById('hikitori-count').textContent = '';
        document.getElementById('hikitori-search-area').classList.add('hidden');
    }

    async function populateStoreSelect() {
        const select = document.getElementById('hikitori-store-select');
        const stores = await DB.getActiveStores();
        stores.sort((a, b) => a.storeName.localeCompare(b.storeName, 'ja'));
        while (select.options.length > 1) select.remove(1);
        stores.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.storeIndex;
            opt.textContent = s.storeName;
            select.appendChild(opt);
        });

        // 絞り込み用の店舗チェックボックスリストも構築
        const listEl = document.getElementById('hikitori-target-stores');
        listEl.innerHTML = '';
        stores.forEach(s => {
            const label = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'hikitori-store-checkbox';
            cb.value = s.storeIndex;
            cb.checked = true; // デフォルトは全て選択

            const span = document.createElement('span');
            span.textContent = s.storeName;

            label.appendChild(cb);
            label.appendChild(span);
            listEl.appendChild(label);
        });

        // 対象単位のチェックボックスリストも構築
        const unitListEl = document.getElementById('hikitori-target-units');
        if (unitListEl && unitListEl.children.length === 0) {
            UNIT_LIST.forEach(u => {
                const label = document.createElement('label');
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'hikitori-unit-checkbox';
                cb.value = u;
                // 初期状態は「錠」と「カプセル」のみチェック
                if (u === '錠' || u === 'カプセル') {
                    cb.checked = true;
                } else {
                    cb.checked = false;
                }

                const span = document.createElement('span');
                span.textContent = u;

                label.appendChild(cb);
                label.appendChild(span);
                unitListEl.appendChild(label);
            });
        }
    }

    function onStoreSelect() {
        const select = document.getElementById('hikitori-store-select');
        const searchArea = document.getElementById('hikitori-search-area');
        if (select.value) {
            currentStoreIndex = parseInt(select.value);
            currentStoreName = select.options[select.selectedIndex].textContent;
            searchArea.classList.remove('hidden');

            // 引き取り元候補リストから自店舗を非表示にし、チェックを外す
            document.querySelectorAll('.hikitori-store-checkbox').forEach(cb => {
                const label = cb.closest('label');
                if (parseInt(cb.value) === currentStoreIndex) {
                    label.style.display = 'none';
                    cb.checked = false;
                } else {
                    label.style.display = 'flex';
                }
            });
        } else {
            currentStoreIndex = null;
            currentStoreName = '';
            searchArea.classList.add('hidden');
            document.getElementById('hikitori-results-card').classList.add('hidden');
        }
    }

    // ===== メイン検索ロジック =====
    async function search() {
        if (!currentStoreIndex) {
            App.showToast('店舗を選択してください', 'warning');
            return;
        }

        const priceMaxInput = document.getElementById('hikitori-price-max').value.trim();
        const priceMax = priceMaxInput ? parseFloat(priceMaxInput) : null;

        if (priceMaxInput && (isNaN(priceMax) || priceMax < 0)) {
            App.showToast('薬価上限に正しい金額を入力してください', 'warning');
            return;
        }

        // --- 対象単位の取得と正規化 ---
        const targetUnitCheckboxes = document.querySelectorAll('.hikitori-unit-checkbox:checked');
        if (targetUnitCheckboxes.length === 0) {
            App.showToast('対象とする単位を1つ以上選択してください', 'warning');
            return;
        }
        
        // 正規化関数：全角英字を半角にし、小文字化。gやGは'g'に、ml等は'ml'に統一する。
        const normalizeUnit = (str) => {
            if (!str) return '';
            let s = String(str).replace(/[A-Za-z0-9!-/:-@\[-`{-~]/g, function(ch) {
                return String.fromCharCode(ch.charCodeAt(0) + 0xFEE0);
            });
            s = s.toLowerCase();
            // gとｍｌの表記揺れを吸収
            s = s.replace(/[ｇＧgG]/g, 'g').replace(/[ｍＭm][ｌＬl]/g, 'ml');
            return s;
        };

        const targetUnits = Array.from(targetUnitCheckboxes).map(cb => normalizeUnit(cb.value));
        const includeKampo = document.getElementById('hikitori-include-kampo').checked;

        const targetStoreCheckboxes = document.querySelectorAll('.hikitori-store-checkbox:checked');
        const targetStoreSet = new Set(Array.from(targetStoreCheckboxes).map(cb => parseInt(cb.value)));

        if (targetStoreSet.size === 0) {
            App.showToast('引き取り元店舗が1つも選択されていません', 'warning');
            return;
        }

        App.showToast('検索中... しばらくお待ちください', 'info');

        try {
            // 全在庫データを取得
            const allInventory = await DB.getAll('inventory');
            if (!allInventory || allInventory.length === 0) {
                App.showToast('在庫データが登録されていません', 'error');
                return;
            }

            // アクティブ店舗
            const activeStores = await DB.getActiveStores();
            const activeSet = new Set(activeStores.map(s => s.storeIndex));
            const storeMap = {};
            activeStores.forEach(s => { storeMap[s.storeIndex] = s.storeName; });

            // 除外薬品リスト
            const excludedDrugs = await DB.getAll('excludedDrugs');

            // 薬品名ごとにデータを集約
            const drugMap = {}; // { drugName: { unitPrice, selfStockQty, otherStores: [{storeIndex, storeName, freq}] } }

            for (const rec of allInventory) {
                if (!rec.drugName) continue;

                // 除外店舗チェック
                if (!activeSet.has(rec.storeIndex)) continue;

                // 漢方薬の判定
                const isKampo = includeKampo && (rec.drugName.includes('ツムラ') || rec.drugName.includes('クラシエ'));

                // 単位のチェック
                if (!isKampo && rec.unit) {
                    const unitStr = normalizeUnit(rec.unit);
                    // rec.unit の中に、選択された targetUnits のいずれかが含まれるか
                    // ただし 'g' の場合は 'mg' を除外するため、単体での存在を確認する
                    const hasTargetUnit = targetUnits.some(tu => {
                        if (tu === 'g') {
                            return /(?<!m)g/.test(unitStr);
                        }
                        return unitStr.includes(tu);
                    });
                    
                    if (!hasTargetUnit) continue; // 選択した単位が含まれていなければスキップ
                } else if (!isKampo && !rec.unit) {
                    // 単位が空で漢方でもない場合はスキップ（単位不明のため）
                    continue;
                }

                if (!drugMap[rec.drugName]) {
                    drugMap[rec.drugName] = {
                        unitPrice: rec.unitPrice || 0,
                        selfStockQty: 0,
                        otherStores: []
                    };
                }

                const entry = drugMap[rec.drugName];

                if (rec.storeIndex === currentStoreIndex) {
                    // 自店舗のデータ
                    entry.selfStockQty = rec.stockQty || 0;
                } else {
                    // 絞り込み対象店舗のみ
                    if (!targetStoreSet.has(rec.storeIndex)) continue;

                    // 他店舗のデータ
                    if (TARGET_FREQ.has(rec.shipFreq)) {
                        entry.otherStores.push({
                            storeIndex: rec.storeIndex,
                            storeName: storeMap[rec.storeIndex] || `店舗${rec.storeIndex}`,
                            freq: rec.shipFreq,
                            stockQty: rec.stockQty || 0
                        });
                    }
                }
            }

            // フィルタリング: 自店舗で在庫0 かつ 他店舗で◎/〇あり
            searchResults = [];

            for (const [drugName, data] of Object.entries(drugMap)) {
                // 自店舗在庫0チェック
                if (data.selfStockQty > 0) continue;

                // 他店舗で◎/〇ありチェック
                if (data.otherStores.length === 0) continue;

                // 薬価上限チェック
                if (priceMax !== null && data.unitPrice > priceMax) continue;

                // 除外薬品チェック
                const isExcluded = await checkExcludedDrug(drugName, excludedDrugs);
                if (isExcluded) continue;

                // 麻薬チェック - 全在庫レコードの最初のものを確認
                const sampleRec = allInventory.find(r => r.drugName === drugName);
                if (sampleRec && sampleRec.isNarcotic) continue;

                // 最高出庫頻度を判定（◎ > 〇）
                const hasDoubleCircle = data.otherStores.some(s => s.freq === '◎');
                const bestFreq = hasDoubleCircle ? '◎' : '〇';

                // ◎の店舗を先に、同じ頻度なら在庫数で降順
                const sortedStores = [...data.otherStores].sort((a, b) => {
                    const freqOrder = { '◎': 0, '〇': 1, '○': 1 };
                    const diff = (freqOrder[a.freq] || 9) - (freqOrder[b.freq] || 9);
                    if (diff !== 0) return diff;
                    return (b.stockQty || 0) - (a.stockQty || 0);
                });

                searchResults.push({
                    drugName,
                    unitPrice: data.unitPrice,
                    bestFreq,
                    storeCount: data.otherStores.length,
                    stores: sortedStores
                });
            }

            // デフォルトソート: 薬価昇順
            sortKey = 'unitPrice';
            sortAsc = true;

            renderResults();
            updateSortIndicators();
            document.getElementById('hikitori-results-card').classList.remove('hidden');

            App.showToast(`${searchResults.length}件の候補が見つかりました`, 'success');

        } catch (err) {
            console.error('引き取り検索エラー:', err);
            App.showToast(`検索エラー: ${err.message}`, 'error');
        }
    }

    // ===== 除外薬品チェック（matching.jsと同等） =====
    function normalizeForMatch(str) {
        if (!str) return '';
        str = String(str).replace(/[A-Za-z0-9!-/:-@\[-`{-~]/g, function(s) {
            return String.fromCharCode(s.charCodeAt(0) + 0xFEE0);
        });
        str = str.replace(/ /g, '\u3000');
        str = str.replace(/｢/g, '「').replace(/｣/g, '」');
        str = str.replace(/[\u3041-\u3096]/g, function(match) {
            return String.fromCharCode(match.charCodeAt(0) + 0x60);
        });
        str = str.toLowerCase();
        return str.replace(/[\s\u3000]/g, '');
    }

    function stripManufacturer(str) {
        return str.replace(/「[^」]*」\s*$/g, '').trim();
    }

    function checkExcludedDrug(drugName, excludedDrugs) {
        const targetNormalized = normalizeForMatch(drugName);
        return excludedDrugs.some(d => {
            if (d.includeOthers) {
                const baseName = normalizeForMatch(stripManufacturer(d.drugName));
                return targetNormalized.startsWith(baseName);
            }
            return targetNormalized === normalizeForMatch(d.drugName);
        });
    }

    // ===== 結果描画 =====
    function renderResults() {
        // ソート
        const sorted = [...searchResults].sort((a, b) => {
            let valA, valB;
            switch (sortKey) {
                case 'unitPrice':
                    valA = a.unitPrice;
                    valB = b.unitPrice;
                    break;
                case 'drugName':
                    valA = a.drugName;
                    valB = b.drugName;
                    return sortAsc ? valA.localeCompare(valB, 'ja') : valB.localeCompare(valA, 'ja');
                case 'bestFreq':
                    valA = a.bestFreq === '◎' ? 0 : 1;
                    valB = b.bestFreq === '◎' ? 0 : 1;
                    break;
                case 'storeCount':
                    valA = a.storeCount;
                    valB = b.storeCount;
                    break;
                default:
                    valA = a.unitPrice;
                    valB = b.unitPrice;
            }
            return sortAsc ? valA - valB : valB - valA;
        });

        const tbody = document.getElementById('hikitori-table-body');
        tbody.innerHTML = '';

        const countEl = document.getElementById('hikitori-count');
        countEl.textContent = `${sorted.length}件`;

        const emptyEl = document.getElementById('hikitori-empty');

        if (sorted.length === 0) {
            emptyEl.classList.remove('hidden');
            return;
        }

        emptyEl.classList.add('hidden');

        for (const item of sorted) {
            const tr = document.createElement('tr');

            // 薬品名
            const tdDrug = document.createElement('td');
            tdDrug.textContent = Admin.toFullWidth(item.drugName);
            tr.appendChild(tdDrug);

            // 薬価
            const tdPrice = document.createElement('td');
            tdPrice.textContent = item.unitPrice.toFixed(1);
            tdPrice.style.textAlign = 'right';
            tr.appendChild(tdPrice);

            // 最高出庫頻度
            const tdFreq = document.createElement('td');
            const freqBadge = document.createElement('span');
            freqBadge.className = `hikitori-freq-badge ${item.bestFreq === '◎' ? 'freq-double' : 'freq-single'}`;
            freqBadge.textContent = item.bestFreq;
            tdFreq.appendChild(freqBadge);
            tdFreq.style.textAlign = 'center';
            tr.appendChild(tdFreq);

            // 該当店舗数
            const tdCount = document.createElement('td');
            tdCount.textContent = `${item.storeCount}店舗`;
            tdCount.style.textAlign = 'center';
            tr.appendChild(tdCount);

            // 該当店舗リスト
            const tdStores = document.createElement('td');
            const storeList = document.createElement('div');
            storeList.className = 'hikitori-store-list';

            // 最大5店舗まで表示
            const displayStores = item.stores.slice(0, 5);
            displayStores.forEach(s => {
                const tag = document.createElement('span');
                tag.className = `hikitori-store-tag ${s.freq === '◎' ? 'freq-double' : 'freq-single'}`;
                tag.textContent = `${s.storeName}(${s.freq})`;
                storeList.appendChild(tag);
            });

            if (item.stores.length > 5) {
                const more = document.createElement('span');
                more.className = 'hikitori-store-more';
                more.textContent = `+${item.stores.length - 5}店舗`;
                storeList.appendChild(more);
            }

            tdStores.appendChild(storeList);
            tr.appendChild(tdStores);

            tbody.appendChild(tr);
        }
    }

    // ===== ソートインジケーター更新 =====
    function updateSortIndicators() {
        document.querySelectorAll('#hikitori-table th[data-sort]').forEach(th => {
            const key = th.dataset.sort;
            const baseText = th.dataset.label || th.textContent.replace(/ [⇅↑↓]$/, '');
            th.dataset.label = baseText;
            if (key === sortKey) {
                th.textContent = `${baseText} ${sortAsc ? '↑' : '↓'}`;
                th.classList.add('sorted');
            } else {
                th.textContent = `${baseText} ⇅`;
                th.classList.remove('sorted');
            }
        });
    }

    // ===== CSV出力 =====
    function exportCSV() {
        if (!searchResults || searchResults.length === 0) {
            App.showToast('出力するデータがありません', 'warning');
            return;
        }

        // 現在のソート順で出力
        const sorted = [...searchResults].sort((a, b) => {
            let valA, valB;
            switch (sortKey) {
                case 'unitPrice':
                    valA = a.unitPrice; valB = b.unitPrice; break;
                case 'drugName':
                    return sortAsc ? a.drugName.localeCompare(b.drugName, 'ja') : b.drugName.localeCompare(a.drugName, 'ja');
                case 'bestFreq':
                    valA = a.bestFreq === '◎' ? 0 : 1; valB = b.bestFreq === '◎' ? 0 : 1; break;
                case 'storeCount':
                    valA = a.storeCount; valB = b.storeCount; break;
                default:
                    valA = a.unitPrice; valB = b.unitPrice;
            }
            return sortAsc ? valA - valB : valB - valA;
        });

        // 各行の店舗リストを展開し、最大店舗数を求める
        let maxStoreCount = 0;
        sorted.forEach(item => {
            if (item.stores.length > maxStoreCount) maxStoreCount = item.stores.length;
        });

        const headers = ['薬品名', '薬価', '最高出庫頻度', '該当店舗数'];
        for (let i = 1; i <= maxStoreCount; i++) {
            headers.push(`該当店舗${i}`);
        }

        const rows = sorted.map(item => {
            const row = [
                Admin.toFullWidth(item.drugName),
                item.unitPrice.toFixed(1),
                item.bestFreq,
                item.storeCount
            ];
            
            // 出庫頻度◎を優先してソート
            const sortedStores = [...item.stores].sort((a, b) => {
                const getFreqRank = (freq) => freq === '◎' ? 0 : 1;
                return getFreqRank(a.freq) - getFreqRank(b.freq);
            });

            for (let i = 0; i < maxStoreCount; i++) {
                if (i < sortedStores.length) {
                    const s = sortedStores[i];
                    row.push(`${s.storeName}(${s.freq})`);
                } else {
                    row.push('');
                }
            }
            return row;
        });

        const csvContent = [headers, ...rows].map(row =>
            row.map(cell => {
                const str = String(cell ?? '');
                if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                    return '"' + str.replace(/"/g, '""') + '"';
                }
                return str;
            }).join(',')
        ).join('\n');

        const bom = '\uFEFF';
        const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const now = new Date();
        const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        a.download = `1200品目検索_${currentStoreName}_${dateStr}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        App.showToast('CSVを出力しました', 'success');
    }

    return { init, onShow };
})();
