/* ============================================
   bulk.js — バラ錠・一包化薬品管理ロジック
   ============================================ */

const Bulk = (() => {

    // ===== 初期化 =====
    async function init() {
        // ドロップゾーン設定
        const dropZone = document.getElementById('drop-bulk');
        const fileInput = document.getElementById('file-bulk');

        if (dropZone && fileInput) {
            dropZone.addEventListener('click', () => {
                fileInput.value = ''; // クリック前にリセットして、同じフォルダでもchangeが発火するようにする
                fileInput.click();
            });
            
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            });
            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('dragover');
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                // フォルダドロップは WebKit API を使う必要があるが、ここでは簡略化のため input からの読み込みを主とする
                App.showToast('フォルダのドラッグ＆ドロップは対応していません。クリックして選択してください。', 'warning');
            });

            fileInput.addEventListener('change', async (e) => {
                if (fileInput.files.length > 0) {
                    await handleBulkUpload(fileInput.files);
                }
            });
        }

        // 検索ボタンイベント
        document.getElementById('btn-bulk-search').addEventListener('click', doSearch);
        
        const bulkSearchInput = document.getElementById('bulk-search-input');
        bulkSearchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                hideAutocomplete();
                doSearch();
            }
        });
        bulkSearchInput.addEventListener('input', onAutocompleteInput);
        bulkSearchInput.addEventListener('keydown', onAutocompleteKeydown);
        bulkSearchInput.addEventListener('blur', () => setTimeout(hideAutocomplete, 200));

        // 除外設定関連
        document.getElementById('btn-add-bulk-exclude').addEventListener('click', addExcludedBulk);
        document.getElementById('search-bulk-exclude').addEventListener('input', renderBulkExcludeList);
    }

    // ===== アプリ表示時 =====
    async function onShow() {
        await refreshExcludeStoreSelect();
        await renderBulkExcludeList();
        await renderBulkDashboard();
    }

    // ===== クレンジングロジック =====
    // ひらがな→全角カタカナ
    function hiraToFullKana(str) {
        return str.replace(/[\u3041-\u3096]/g, match => String.fromCharCode(match.charCodeAt(0) + 0x60));
    }

    // 全角英数→半角英数
    function fullAlphanumToHalf(str) {
        return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
    }

    // 半角カタカナ→全角カタカナ
    function halfKanaToFullKana(str) {
        const kanaMap = {
            'ｦ': 'ヲ', 'ｧ': 'ァ', 'ｨ': 'ィ', 'ｩ': 'ゥ', 'ｪ': 'ェ', 'ｫ': 'ォ',
            'ｬ': 'ャ', 'ｭ': 'ュ', 'ｮ': 'ョ', 'ｯ': 'ッ', 'ｰ': 'ー',
            'ｱ': 'ア', 'ｲ': 'イ', 'ｳ': 'ウ', 'ｴ': 'エ', 'ｵ': 'オ',
            'ｶ': 'カ', 'ｷ': 'キ', 'ｸ': 'ク', 'ｹ': 'ケ', 'ｺ': 'コ',
            'ｻ': 'サ', 'ｼ': 'シ', 'ｽ': 'ス', 'ｾ': 'セ', 'ｿ': 'ソ',
            'ﾀ': 'タ', 'ﾁ': 'チ', 'ﾂ': 'ツ', 'ﾃ': 'テ', 'ﾄ': 'ト',
            'ﾅ': 'ナ', 'ﾆ': 'ニ', 'ﾇ': 'ヌ', 'ﾈ': 'ネ', 'ﾉ': 'ノ',
            'ﾊ': 'ハ', 'ﾋ': 'ヒ', 'ﾌ': 'フ', 'ﾍ': 'ヘ', 'ﾎ': 'ホ',
            'ﾏ': 'マ', 'ﾐ': 'ミ', 'ﾑ': 'ム', 'ﾒ': 'メ', 'ﾓ': 'モ',
            'ﾔ': 'ヤ', 'ﾕ': 'ユ', 'ﾖ': 'ヨ',
            'ﾗ': 'ラ', 'ﾘ': 'リ', 'ﾙ': 'ル', 'ﾚ': 'レ', 'ﾛ': 'ロ',
            'ﾜ': 'ワ', 'ﾝ': 'ン'
        };
        const dakutenMap = {
            'カ': 'ガ', 'キ': 'ギ', 'ク': 'グ', 'ケ': 'ゲ', 'コ': 'ゴ',
            'サ': 'ザ', 'シ': 'ジ', 'ス': 'ズ', 'セ': 'ゼ', 'ソ': 'ゾ',
            'タ': 'ダ', 'チ': 'ヂ', 'ツ': 'ヅ', 'テ': 'デ', 'ト': 'ド',
            'ハ': 'バ', 'ヒ': 'ビ', 'フ': 'ブ', 'ヘ': 'ベ', 'ホ': 'ボ',
            'ウ': 'ヴ'
        };
        const handakutenMap = {
            'ハ': 'パ', 'ヒ': 'ピ', 'フ': 'プ', 'ヘ': 'ペ', 'ホ': 'ポ'
        };

        let result = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            const fullChar = kanaMap[ch];
            if (fullChar) {
                const next = str[i + 1];
                if (next === 'ﾞ' && dakutenMap[fullChar]) {
                    result += dakutenMap[fullChar];
                    i++;
                } else if (next === 'ﾟ' && handakutenMap[fullChar]) {
                    result += handakutenMap[fullChar];
                    i++;
                } else {
                    result += fullChar;
                }
            } else {
                result += ch === 'ﾞ' ? '゛' : (ch === 'ﾟ' ? '゜' : ch);
            }
        }
        return result;
    }

    function normalizeDrugName(name) {
        if (!name) return '';
        let res = String(name).trim();
        res = Admin.normalizeDrugName(res); // 既存の丸記号除去など（もしあれば）
        res = hiraToFullKana(res);
        res = halfKanaToFullKana(res);
        res = fullAlphanumToHalf(res);
        return res;
    }

    // ===== アップロード処理 =====
    async function handleBulkUpload(files) {
        const dropZone = document.getElementById('drop-bulk');
        const statusEl = document.getElementById('status-bulk');
        const progressArea = document.getElementById('bulk-progress');
        const progressBar = document.getElementById('bulk-progress-bar');
        const progressText = document.getElementById('bulk-progress-text');

        try {
            statusEl.textContent = 'ファイルを読み込み中...';
            statusEl.className = 'file-status';
            dropZone.classList.add('disabled');
            progressArea.classList.remove('hidden');

            const allItems = [];
            const processedStores = [];
            const excludedMap = new Set();
            const bulkSettings = await DB.getAll('bulkExcluded');
            bulkSettings.forEach(exc => excludedMap.add(exc.id)); // storeName_drugName

            // 店舗マスターを先に読み込み、ファイル名→正式名への解決に使用
            const masterStores = await DB.getStores();

            /**
             * ファイル名から月情報を除去して店舗名部分を抽出する。
             * 例: "あんじょう店2月" → { name: "あんじょう店", month: "2月" }
             * 例: "あんじょう店_202604" → 既に "_" で分割済み
             */
            function extractStoreAndMonth(basename) {
                // マスキングツール由来の「_masked」サフィックスを除去
                basename = basename.replace(/_masked$/i, '');
                const parts = basename.split('_');
                let rawName = parts[0].trim();
                let month = parts[1] || '';

                // "_" で分割できた場合の月処理
                if (month) {
                    if (month.length === 6 && /^\d{6}$/.test(month)) {
                        month = month.substring(4, 6) + '月';
                    }
                } else {
                    // "_" がない場合、末尾の月パターンを除去して分離する
                    // 例: "あんじょう店2月" → name="あんじょう店", month="2月"
                    // 例: "あんじょう店１２月" → name="あんじょう店", month="12月"
                    const monthMatch = rawName.match(/^(.+?)([0-9０-９]+月)$/);
                    if (monthMatch) {
                        rawName = monthMatch[1];
                        // 全角数字を半角に変換して統一
                        month = monthMatch[2].replace(/[０-９]/g, function(s) {
                            return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
                        });
                    }
                    // 末尾に6桁数字 (YYYYMM) がある場合
                    const yyyymmMatch = rawName.match(/^(.+?)(\d{6})$/);
                    if (!month && yyyymmMatch) {
                        rawName = yyyymmMatch[1];
                        month = yyyymmMatch[2].substring(4, 6) + '月';
                    }
                }

                if (!rawName) rawName = '不明な店舗';
                if (!month) month = '不明';

                return { name: rawName, month };
            }

            /**
             * ファイル名から抽出した店舗名（例: "あんじょう店"）を
             * 店舗マスターの正式名（例: "〇〇薬局あんじょう店"）に解決する。
             * 完全一致 > マスターが店舗名を含む > 店舗名がマスターを含む の優先度。
             */
            function resolveStoreName(rawName) {
                if (!rawName) return rawName;
                // 完全一致
                const exact = masterStores.find(s => s.storeName === rawName);
                if (exact) return exact.storeName;
                // マスターがファイル名を含む（例: "〇〇薬局あんじょう店".includes("あんじょう店")）
                const partial = masterStores.find(s => s.storeName.includes(rawName));
                if (partial) return partial.storeName;
                // ファイル名がマスターを含む
                const reverse = masterStores.find(s => rawName.includes(s.storeName));
                if (reverse) return reverse.storeName;
                return rawName; // 見つからなければ元のまま
            }

            // 全エクセルパース
            let fileCount = 0;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (!file.name.match(/\.(xls|xlsx|xlsm)$/i)) continue;

                // ファイル名から店舗名と年月を抽出
                const basename = file.name.replace(/\.[^/.]+$/, "");
                const extracted = extractStoreAndMonth(basename);
                const rawStoreName = extracted.name;
                const month = extracted.month;

                // 店舗マスターと照合して正式名に解決
                const storeName = resolveStoreName(rawStoreName);

                processedStores.push({ storeName, rawStoreName, month });

                const data = await file.arrayBuffer();
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

                fileCount++;

                for (let r = 0; r < rows.length; r++) {
                    const row = rows[r];
                    // BA列 (52) -> 薬品名, K列 (10) -> 使用量
                    // I列 (8) -> 調剤年月日
                    let drugNameRaw = row[52];
                    if (!drugNameRaw && row[48]) drugNameRaw = row[48]; // フォールバック
                    const qtyRaw = row[10];
                    const rawDate = row[8];

                    // ==============================================
                    // ==== セキュリティ: 患者氏名の読み込み回避 ====
                    // M列(12) と N列(13) に患者氏名が含まれています。
                    // 誤ってシステムに取り込まれたり変数に保存されたり
                    // しないよう、一切の処理から除外します。
                    // ==============================================
                    // M列, N列のへのアクセスは絶対に行わない

                    if (drugNameRaw && !isNaN(parseFloat(qtyRaw))) {
                        const drugNameNorm = normalizeDrugName(drugNameRaw);
                        const qty = parseFloat(qtyRaw);

                        // 調剤年月日のフォーマット変換
                        let dispenseDate = '';
                        if (rawDate) {
                            if (typeof rawDate === 'number') {
                                // Excelのシリアル値をJSのDateへと変換
                                const d = new Date((rawDate - 25569) * 86400 * 1000);
                                dispenseDate = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
                            } else {
                                dispenseDate = String(rawDate);
                            }
                        }

                        if (drugNameNorm && qty > 0) {
                            const excludeId = `${storeName}_${drugNameNorm}`;
                            if (!excludedMap.has(excludeId)) {
                                allItems.push({
                                    id: `${storeName}__${drugNameNorm}__${r}`,
                                    storeName,
                                    drugNameRaw: String(drugNameRaw),
                                    drugName: drugNameNorm,
                                    qty,
                                    month,
                                    dispenseDate
                                });
                            }
                        }
                    }
                }

                const pct = Math.round(((i + 1) / files.length) * 50); // パースは50%まで
                progressBar.style.width = `${pct}%`;
                progressText.textContent = `解析中... ${i + 1} / ${files.length} ファイル`;
            }

            // DB保存
            progressText.textContent = 'データベースに保存中...';
            await DB.clear('bulkInventory');
            
            // stores はステータス用に設定オブジェクトとして保存
            console.log('processedStores:', JSON.stringify(processedStores));
            await DB.put('bulkSettings', { key: 'processedStores', value: processedStores });
            await DB.setSetting('lastBulkUpdate', new Date().toISOString());

            await DB.putBatch('bulkInventory', allItems, (done, total) => {
                const pct = 50 + Math.round((done / total) * 50);
                progressBar.style.width = `${pct}%`;
                progressText.textContent = `保存中... ${done.toLocaleString()} / ${total.toLocaleString()} 件`;
            });

            progressBar.style.width = '100%';
            progressText.textContent = `✓ 完了: ${fileCount}店舗・${allItems.length.toLocaleString()}件 のデータを保存しました`;
            statusEl.textContent = `アップロード成功（${fileCount}ファイル処理）`;
            statusEl.className = 'file-status success';
            dropZone.classList.add('loaded');

            App.showToast('バラ錠データの取り込みが完了しました', 'success');
            await renderBulkDashboard();

        } catch (err) {
            console.error(err);
            statusEl.textContent = `✗ エラー: ${err.message}`;
            statusEl.className = 'file-status error';
            App.showToast(`読み込みエラー: ${err.message}`, 'error');
            progressArea.classList.add('hidden');
        } finally {
            dropZone.classList.remove('disabled');
        }
    }

    // ===== 検索 ======
    async function doSearch() {
        const input = document.getElementById('bulk-search-input').value.trim();
        if (!input) return;

        const term = normalizeDrugName(input);
        const allItems = await DB.getAll('bulkInventory');
        
        // ハッシュマップ集計
        const resultsMap = new Map();

        for (const item of allItems) {
            if (item.drugName.includes(term)) {
                // key = 薬品名 + 店舗名
                const key = `${item.drugName}__${item.storeName}`;
                if (!resultsMap.has(key)) {
                    resultsMap.set(key, {
                        drugName: item.drugNameRaw,
                        storeName: item.storeName,
                        qty: 0,
                        count: 0,
                        lastDispense: ''
                    });
                }
                const res = resultsMap.get(key);
                res.qty += item.qty;
                res.count += 1;
                if (item.dispenseDate && item.dispenseDate > res.lastDispense) {
                    res.lastDispense = item.dispenseDate;
                }
            }
        }

        const results = Array.from(resultsMap.values());
        results.sort((a, b) => b.qty - a.qty); // 多い順

        renderSearchResults(results);
    }

    function renderSearchResults(results) {
        const tbody = document.getElementById('bulk-table-body');
        const emptyMsg = document.getElementById('bulk-empty');

        if (results.length === 0) {
            tbody.innerHTML = '';
            emptyMsg.classList.remove('hidden');
            return;
        }

        emptyMsg.classList.add('hidden');
        tbody.innerHTML = results.map(r => `
            <tr>
                <td>${escapeHtml(r.drugName)}</td>
                <td>${escapeHtml(r.storeName)}</td>
                <td style="text-align: right; padding-right: 15px;">
                    ${r.qty.toLocaleString()} 錠 (${r.count}回)<br>
                    <span style="font-size:0.8rem; color:#666;">最終: ${escapeHtml(r.lastDispense || '不明')}</span>
                </td>
                <td style="text-align: center;">
                    <button class="btn btn-primary btn-bulk-add" style="padding: 4px 12px; font-size: 0.85rem;" 
                            data-drug="${escapeHtml(r.drugName)}" 
                            data-store="${escapeHtml(r.storeName)}">確定</button>
                </td>
            </tr>
        `).join('');

        // 確定ボタンのイベントバインディング
        tbody.querySelectorAll('.btn-bulk-add').forEach(btn => {
            btn.addEventListener('click', async () => {
                const drug = btn.dataset.drug;
                const destStore = btn.dataset.store;
                if (typeof Store !== 'undefined' && Store.addBulkTransfer) {
                    await Store.addBulkTransfer(drug, destStore);
                }
            });
        });
    }

    // ===== オートコンプリート (在庫データに基づく) =====
    let acDrugCache = null;
    let acActiveIdx = -1;

    async function getDrugNameCache() {
        if (acDrugCache) return acDrugCache;
        const allInv = await DB.getAll('inventory');
        const nameSet = new Set();
        allInv.forEach(inv => { if (inv.drugName) nameSet.add(inv.drugName); });
        acDrugCache = [...nameSet].sort();
        return acDrugCache;
    }

    async function onAutocompleteInput() {
        const input = document.getElementById('bulk-search-input');
        const term = input.value.trim();
        if (term.length < 3) {
            hideAutocomplete();
            return;
        }

        const drugNames = await getDrugNameCache();
        // ひらがな→カタカナ変換を含む正規化で、ひらがな検索にも対応
        const termKana = normalizeDrugName(term);
        // カタカナ・ひらがなの揺れを吸収して検索
        const matches = drugNames.filter(n => n.includes(termKana)).slice(0, 20);

        const list = document.getElementById('bulk-drug-autocomplete');
        if (matches.length === 0) {
            hideAutocomplete();
            return;
        }

        acActiveIdx = -1;
        list.innerHTML = matches.map((name, i) => {
            const idx = name.indexOf(termKana);
            let html;
            if (idx >= 0) {
                html = escapeHtml(name.substring(0, idx))
                     + '<span class="ac-match">'
                     + escapeHtml(name.substring(idx, idx + termKana.length))
                     + '</span>'
                     + escapeHtml(name.substring(idx + termKana.length));
            } else {
                html = escapeHtml(name);
            }
            return `<div class="autocomplete-item" data-index="${i}" data-value="${escapeHtml(name)}">${html}</div>`;
        }).join('');

        list.classList.remove('hidden');

        list.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = item.dataset.value;
                hideAutocomplete();
                doSearch();
            });
        });
    }

    function onAutocompleteKeydown(e) {
        const list = document.getElementById('bulk-drug-autocomplete');
        if (list.classList.contains('hidden')) return;

        const items = list.querySelectorAll('.autocomplete-item');
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            acActiveIdx = Math.min(acActiveIdx + 1, items.length - 1);
            updateAcActive(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            acActiveIdx = Math.max(acActiveIdx - 1, 0);
            updateAcActive(items);
        } else if (e.key === 'Enter' && acActiveIdx >= 0) {
            e.preventDefault();
            const input = document.getElementById('bulk-search-input');
            input.value = items[acActiveIdx].dataset.value;
            hideAutocomplete();
            doSearch();
        } else if (e.key === 'Escape') {
            hideAutocomplete();
        }
    }

    function updateAcActive(items) {
        items.forEach((it, i) => {
            it.classList.toggle('active', i === acActiveIdx);
        });
        if (acActiveIdx >= 0 && items[acActiveIdx]) {
            items[acActiveIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    function hideAutocomplete() {
        const list = document.getElementById('bulk-drug-autocomplete');
        if (list) {
            list.classList.add('hidden');
            list.innerHTML = '';
        }
        acActiveIdx = -1;
    }

    // ===== ダッシュボード ======
    async function renderBulkDashboard() {
        const masterStores = await DB.getStores(); // 全店舗マスター
        const processedObj = await DB.get('bulkSettings', 'processedStores');
        const processed = processedObj ? processedObj.value : [];
        
        const procMap = new Map();
        // storeName(正式名)とrawStoreName(ファイル名由来)の両方でマッピング
        processed.forEach(p => {
            procMap.set(p.storeName, p.month);
            if (p.rawStoreName && p.rawStoreName !== p.storeName) {
                procMap.set(p.rawStoreName, p.month);
            }
        });

        const tbody = document.getElementById('bulk-status-body');
        
        if (masterStores.length === 0) {
            tbody.innerHTML = '<tr><td colspan="2">店舗名データが登録されていません。管理者メニューから登録してください。</td></tr>';
            return;
        }

        tbody.innerHTML = masterStores.map(s => {
            // 店舗名の表記揺れ対策として、大まかな一致を探す (例: "〇〇薬局△店" と "△店")
            let status = 'データなし';
            let isMissing = true;

            const exactMatch = procMap.get(s.storeName);
            if (exactMatch) {
                status = exactMatch;
                isMissing = false;
            } else {
                // 部分一致チェック
                for (const [pName, pMonth] of procMap.entries()) {
                    if (s.storeName.includes(pName) || pName.includes(s.storeName)) {
                        status = pMonth;
                        isMissing = false;
                        break;
                    }
                }
            }

            const bgClass = isMissing ? 'style="background: var(--danger-light, #ffebee);"' : '';

            return `
                <tr ${bgClass}>
                    <td>${escapeHtml(s.storeName)}</td>
                    <td>
                        ${isMissing ? '<strong>データなし</strong>' : `${escapeHtml(status)}`}
                    </td>
                </tr>
            `;
        }).join('');
    }

    // ===== 除外設定 ======
    async function refreshExcludeStoreSelect() {
        const select = document.getElementById('bulk-exclude-store');
        const stores = await DB.getStores();
        select.innerHTML = '<option value="">店舗を選択</option>' + stores.map(s => `
            <option value="${escapeHtml(s.storeName)}">${escapeHtml(s.storeName)}</option>
        `).join('');
    }

    async function addExcludedBulk() {
        const storeName = document.getElementById('bulk-exclude-store').value;
        const drugNameRaw = document.getElementById('bulk-exclude-drug').value.trim();

        if (!storeName || !drugNameRaw) {
            App.showToast('店舗と薬品名の両方を入力してください', 'warning');
            return;
        }

        const drugName = normalizeDrugName(drugNameRaw);
        const id = `${storeName}_${drugName}`;

        await DB.put('bulkExcluded', { id, storeName, drugName, rawDrugName: drugNameRaw });
        document.getElementById('bulk-exclude-drug').value = '';
        
        App.showToast('除外設定を追加しました。結果に反映するにはデータを再読込してください。', 'success');
        await renderBulkExcludeList();
    }

    async function removeExcludedBulk(id) {
        await DB.remove('bulkExcluded', id);
        App.showToast('除外設定を削除しました', 'info');
        await renderBulkExcludeList();
    }

    async function renderBulkExcludeList() {
        const list = document.getElementById('bulk-exclude-list');
        const searchTerm = (document.getElementById('search-bulk-exclude').value || '').trim();
        const searchKana = normalizeDrugName(searchTerm);
        
        const excluded = await DB.getAll('bulkExcluded');

        const filtered = searchKana
            ? excluded.filter(d => normalizeDrugName(d.drugName).includes(searchKana) || d.storeName.includes(searchTerm))
            : excluded;

        if (filtered.length === 0) {
            list.innerHTML = '<p class="empty-message">除外リストは登録されていません</p>';
            return;
        }

        list.innerHTML = filtered.map(d => `
            <div class="exclude-item">
                <span class="item-name">
                    <span style="color:var(--text-secondary); margin-right:8px;">[${escapeHtml(d.storeName)}]</span>
                    ${escapeHtml(d.rawDrugName || d.drugName)}
                </span>
                <button class="btn-remove" data-id="${escapeHtml(d.id)}" title="削除">✕</button>
            </div>
        `).join('');

        list.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', () => removeExcludedBulk(btn.dataset.id));
        });
    }

    // HTMLエスケープヘルパー
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    return { init, onShow };
})();
