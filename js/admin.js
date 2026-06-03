/* ============================================
   admin.js — 管理者画面ロジック
   ============================================ */

const Admin = (() => {

    // ===== 在庫データ読み込み =====
    let invFile1Data = null;  // 1枚目の生データ
    let invFile2Data = null;  // 2枚目の生データ

    /**
     * 在庫Excelファイルをパース
     *
     * ■ ファイル構造
     *   - 1ファイルに20店舗分のデータが格納
     *   - 店舗ごとのデータは6列1セットで横に繰り返し
     *
     * ■ 共通基本情報（固定列）
     *   E列(4):  薬品名
     *   F列(5):  薬価
     *   G列(6):  単位
     *   J列(9):  規制情報（麻薬判定用）
     *
     * ■ 除外する合計列
     *   P列(15): 在庫数（全店合計）
     *   Q列(16): 在庫金額（全店合計）
     *   S列(18): 出庫頻度（全店合計）
     *
     * ■ 店舗別データ（AC列=col28 から開始、6列×20店舗）
     *   +0: 在庫数     ← 取得
     *   +1: 在庫金額   ← 取得
     *   +2: 月数       ← 取得
     *   +3: 引渡金額   ← 対象外（読み込み不要）
     *   +4: 不動区分   ← 取得
     *   +5: 出庫頻度   ← 取得
     *
     * @param {File} file
     * @param {number} fileIndex - 0(1枚目) or 1(2枚目)
     */
    async function parseInventoryFile(file, fileIndex) {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

        if (rows.length < 2) throw new Error('データが空です');

        const headers = rows[0];

        // ===== 列位置の設定（明示的な固定値） =====

        // --- 共通基本情報 ---
        const COL_DRUG_NAME  = 4;   // E列: 薬品名
        const COL_UNIT_PRICE = 5;   // F列: 薬価
        const COL_UNIT       = 6;   // G列: 単位
        const COL_REGULATION = 9;   // J列: 規制情報

        // --- 店舗別データ ---
        const STORE_START_COL  = 28; // AC列: 在庫数1 から開始
        const COLS_PER_STORE   = 6;  // 1店舗あたり6列固定
        const STORES_PER_FILE  = 20; // 1ファイルあたり20店舗

        // 店舗ブロック内のオフセット（固定）
        const OFFSET_STOCK_QTY  = 0; // 在庫数
        const OFFSET_STOCK_AMT  = 1; // 在庫金額
        const OFFSET_MONTHS     = 2; // 月数
        //     OFFSET 3 = 引渡金額（読み込み対象外）
        const OFFSET_FUDOU      = 4; // 不動区分
        const OFFSET_SHIP_FREQ  = 5; // 出庫頻度

        // 店舗数を計算（ヘッダー列数から算出、最大20）
        const totalStoreCols = headers.length - STORE_START_COL;
        const storeCount = Math.min(
            Math.floor(totalStoreCols / COLS_PER_STORE),
            STORES_PER_FILE
        );

        // 2枚目は店舗21〜
        const storeOffset = fileIndex * STORES_PER_FILE;

        console.log(`在庫データ読込: 薬品名=col${COL_DRUG_NAME}, 規制=col${COL_REGULATION}, 店舗開始=col${STORE_START_COL}, 店舗幅=${COLS_PER_STORE}, 店舗数=${storeCount}, オフセット=${storeOffset}`);

        const items = [];

        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            const rawDrugName = row[COL_DRUG_NAME];
            if (!rawDrugName) continue;
            const drugName = normalizeDrugName(String(rawDrugName));

            const unitPrice = parseFloat(row[COL_UNIT_PRICE]) || 0;
            const unit = String(row[COL_UNIT] || '');
            const regulation = String(row[COL_REGULATION] || '');
            const isNarcotic = regulation.includes('麻');

            for (let s = 0; s < storeCount; s++) {
                const base = STORE_START_COL + s * COLS_PER_STORE;
                const storeIndex = storeOffset + s + 1; // 1-indexed

                const stockQty    = parseFloat(row[base + OFFSET_STOCK_QTY]) || 0;
                const stockAmount = parseFloat(row[base + OFFSET_STOCK_AMT]) || 0;
                const months      = parseFloat(row[base + OFFSET_MONTHS]) || 0;
                // 引渡金額 (base + 3) は読み込み対象外
                const fudouClass  = String(row[base + OFFSET_FUDOU] || '');
                const shipFreq    = String(row[base + OFFSET_SHIP_FREQ] || '');

                items.push({
                    id: `${drugName}__${storeIndex}`,
                    drugName,
                    unitPrice,
                    unit,
                    storeIndex,
                    stockQty,
                    stockAmount,
                    months,
                    fudouClass,
                    shipFreq,
                    regulation,
                    isNarcotic
                });
            }
        }

        return { items, storeCount, drugCount: rows.length - 1 };
    }

    /**
     * 店舗名データをパース
     */
    async function parseStoreNames(file) {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

        const stores = [];
        for (let r = 1; r < rows.length; r++) {
            const storeName = rows[r][7]; // H列(index 7)
            if (storeName) {
                stores.push({
                    storeIndex: r, // 1-indexed
                    storeName: String(storeName).trim(),
                    excluded: false
                });
            }
        }
        return stores;
    }

    // ===== 在庫データアップロード処理 =====
    async function handleInventoryUpload(file, fileIndex) {
        const statusEl = document.getElementById(`status-inv-${fileIndex + 1}`);
        const dropZone = document.getElementById(`drop-inv-${fileIndex + 1}`);

        try {
            statusEl.textContent = '読み込み中...';
            statusEl.className = 'file-status';

            const result = await parseInventoryFile(file, fileIndex);

            if (fileIndex === 0) {
                invFile1Data = result;
            } else {
                invFile2Data = result;
            }

            statusEl.textContent = `✓ ${file.name} (${result.drugCount}品目 × ${result.storeCount}店舗)`;
            statusEl.className = 'file-status success';
            dropZone.classList.add('loaded');

            // ファイルがアップロードされるたびに保存（1枚目だけでも反映させるため）
            await saveInventoryData();

            if (fileIndex === 0 && !invFile2Data) {
                App.showToast('1枚目のデータを反映しました。21店舗以上ある場合は続けて2枚目をアップロードしてください。', 'info');
            }

        } catch (err) {
            statusEl.textContent = `✗ エラー: ${err.message}`;
            statusEl.className = 'file-status error';
            App.showToast(`読み込みエラー: ${err.message}`, 'error');
        }
    }

    async function saveInventoryData() {
        const progressArea = document.getElementById('inv-progress');
        const progressBar = document.getElementById('inv-progress-bar');
        const progressText = document.getElementById('inv-progress-text');

        progressArea.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = 'データを保存中...';

        try {
            // 既存データをクリア
            await DB.clear('inventory');

            // 読み込み済みのデータをすべてマージ
            const allItems = [];
            if (invFile1Data) {
                allItems.push(...invFile1Data.items);
            }
            if (invFile2Data) {
                allItems.push(...invFile2Data.items);
            }

            await DB.putBatch('inventory', allItems, (done, total) => {
                const pct = Math.round((done / total) * 100);
                progressBar.style.width = `${pct}%`;
                progressText.textContent = `保存中... ${done.toLocaleString()} / ${total.toLocaleString()} 件`;
            });

            progressBar.style.width = '100%';
            progressText.textContent = `✓ 完了: ${allItems.length.toLocaleString()} 件のデータを保存しました`;

            await DB.setSetting('lastInventoryUpdate', new Date().toISOString());
            await DB.setSetting('inventoryItemCount', allItems.length);

            App.showToast(`在庫データを登録しました（${allItems.length.toLocaleString()}件）`, 'success');
            await updateSummary();

        } catch (err) {
            progressText.textContent = `✗ 保存エラー: ${err.message}`;
            App.showToast(`保存エラー: ${err.message}`, 'error');
        }
    }

    // ===== 店舗名アップロード処理 =====
    async function handleStoreNamesUpload(file) {
        const statusEl = document.getElementById('status-store-names');
        const dropZone = document.getElementById('drop-store-names');

        try {
            statusEl.textContent = '読み込み中...';
            statusEl.className = 'file-status';

            const stores = await parseStoreNames(file);

            // 既存の除外設定を保持
            const existingStores = await DB.getStores();
            const excludedSet = new Set(existingStores.filter(s => s.excluded).map(s => s.storeIndex));

            // 保存（除外設定を引き継ぎ）
            await DB.clear('stores');
            for (const store of stores) {
                store.excluded = excludedSet.has(store.storeIndex);
                await DB.put('stores', store);
            }

            statusEl.textContent = `✓ ${file.name} (${stores.length}店舗)`;
            statusEl.className = 'file-status success';
            dropZone.classList.add('loaded');

            await DB.setSetting('lastStoreUpdate', new Date().toISOString());
            App.showToast(`${stores.length}店舗のデータを登録しました`, 'success');
            await updateSummary();
            await renderExcludeStoreList();

        } catch (err) {
            statusEl.textContent = `✗ エラー: ${err.message}`;
            statusEl.className = 'file-status error';
            App.showToast(`読み込みエラー: ${err.message}`, 'error');
        }
    }

    // ===== 除外薬品 =====
    let acDrugCache = null;  // 薬品名キャッシュ
    let acActiveIdx = -1;    // オートコンプリートの選択インデックス

    async function addExcludedDrug() {
        const input = document.getElementById('exclude-drug-input');
        const drugName = input.value.trim();
        if (!drugName) return;

        const includeOthers = document.getElementById('exclude-include-others').checked;

        await DB.put('excludedDrugs', { drugName, includeOthers });
        input.value = '';
        hideAutocomplete();
        await renderExcludeDrugList();
        App.showToast(`「${drugName}」を除外薬品に追加しました`, 'success');
    }

    // ===== オートコンプリート =====
    async function getDrugNameCache() {
        if (acDrugCache) return acDrugCache;
        const allInv = await DB.getAll('inventory');
        const nameSet = new Set();
        allInv.forEach(inv => { if (inv.drugName) nameSet.add(inv.drugName); });
        acDrugCache = [...nameSet].sort();
        return acDrugCache;
    }

    // ひらがな→カタカナ変換
    function hiraToKana(str) {
        return str.replace(/[\u3041-\u3096]/g, function(match) {
            return String.fromCharCode(match.charCodeAt(0) + 0x60);
        });
    }

    async function onAutocompleteInput() {
        const input = document.getElementById('exclude-drug-input');
        const term = input.value.trim();
        if (term.length < 3) {
            hideAutocomplete();
            return;
        }

        const drugNames = await getDrugNameCache();
        const termLower = term.toLowerCase();
        const termKana = hiraToKana(termLower);
        const matches = drugNames.filter(n => hiraToKana(n.toLowerCase()).includes(termKana)).slice(0, 20);

        const list = document.getElementById('exclude-drug-autocomplete');
        if (matches.length === 0) {
            hideAutocomplete();
            return;
        }

        acActiveIdx = -1;
        list.innerHTML = matches.map((name, i) => {
            // ハイライト対象部分
            const nameKana = hiraToKana(name.toLowerCase());
            const idx = nameKana.indexOf(termKana);
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

        // クリックイベント
        list.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();  // inputのblurを防止
                input.value = item.dataset.value;
                hideAutocomplete();
                addExcludedDrug();
            });
        });
    }

    function onAutocompleteKeydown(e) {
        const list = document.getElementById('exclude-drug-autocomplete');
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
            const input = document.getElementById('exclude-drug-input');
            input.value = items[acActiveIdx].dataset.value;
            hideAutocomplete();
            addExcludedDrug();
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
        const list = document.getElementById('exclude-drug-autocomplete');
        if (list) {
            list.classList.add('hidden');
            list.innerHTML = '';
        }
        acActiveIdx = -1;
    }

    async function removeExcludedDrug(drugName) {
        await DB.remove('excludedDrugs', drugName);
        await renderExcludeDrugList();
        App.showToast(`「${drugName}」を除外薬品から削除しました`, 'info');
    }

    async function renderExcludeDrugList() {
        const list = document.getElementById('exclude-drug-list');
        const searchTerm = (document.getElementById('search-exclude-drug')?.value || '').trim().toLowerCase();
        const searchKana = hiraToKana(searchTerm);
        const drugs = await DB.getAll('excludedDrugs');

        const filtered = searchKana
            ? drugs.filter(d => hiraToKana(d.drugName.toLowerCase()).includes(searchKana))
            : drugs;

        if (filtered.length === 0) {
            list.innerHTML = '<p class="empty-message">除外薬品は登録されていません</p>';
            return;
        }

        list.innerHTML = filtered.map(d => `
            <div class="exclude-item">
                <span class="item-name">
                    ${escapeHtml(d.drugName)}
                    ${d.includeOthers ? '<span class="badge" style="background:var(--accent); color:#fff; font-size:0.7rem; padding:2px 6px; margin-left:6px;">他メーカー含む</span>' : ''}
                </span>
                <button class="btn-remove" data-drug="${escapeHtml(d.drugName)}" title="削除">✕</button>
            </div>
        `).join('');

        // 削除ボタンイベント
        list.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', () => removeExcludedDrug(btn.dataset.drug));
        });
    }

    // ===== 除外店舗 =====
    async function renderExcludeStoreList() {
        const list = document.getElementById('store-exclude-list');
        const stores = await DB.getStores();

        if (stores.length === 0) {
            list.innerHTML = '<p class="empty-message">店舗データが登録されていません</p>';
            return;
        }

        list.innerHTML = stores.map(s => `
            <div class="store-exclude-item ${s.excluded ? 'excluded' : ''}">
                <input type="checkbox" id="exc-store-${s.storeIndex}" 
                       ${s.excluded ? 'checked' : ''} 
                       data-store="${s.storeIndex}">
                <label for="exc-store-${s.storeIndex}">
                    ${escapeHtml(s.storeName)}
                    ${s.excluded ? ' (除外中)' : ''}
                </label>
            </div>
        `).join('');

        list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', async () => {
                const storeIndex = parseInt(cb.dataset.store);
                const store = await DB.get('stores', storeIndex);
                if (store) {
                    store.excluded = cb.checked;
                    await DB.put('stores', store);
                    await renderExcludeStoreList();
                    App.showToast(
                        cb.checked ? `${store.storeName}を除外しました` : `${store.storeName}の除外を解除しました`,
                        'info'
                    );
                }
            });
        });
    }

    // ===== データリセット =====
    async function resetInventory() {
        App.showConfirm(
            '在庫データリセット',
            '在庫データと店舗名データをすべて削除します。この操作は取り消せません。よろしいですか？',
            async () => {
                await DB.resetInventory();
                invFile1Data = null;
                invFile2Data = null;
                resetUploadUI();
                await updateSummary();
                App.showToast('在庫データをリセットしました', 'success');
            }
        );
    }

    async function resetAll() {
        App.showConfirm(
            '全データリセット',
            'すべてのデータ（在庫、店舗名、除外設定、移動希望データ）を削除します。この操作は取り消せません。よろしいですか？',
            async () => {
                await DB.resetAll();
                invFile1Data = null;
                invFile2Data = null;
                resetUploadUI();
                await renderExcludeDrugList();
                await renderExcludeStoreList();
                await updateSummary();
                App.showToast('全データをリセットしました', 'success');
            }
        );
    }

    function resetUploadUI() {
        ['inv-1', 'inv-2'].forEach(id => {
            const status = document.getElementById(`status-${id}`);
            const drop = document.getElementById(`drop-${id}`);
            if (status) { status.textContent = ''; status.className = 'file-status'; }
            if (drop) drop.classList.remove('loaded');
        });
        const statusNames = document.getElementById('status-store-names');
        const dropNames = document.getElementById('drop-store-names');
        if (statusNames) { statusNames.textContent = ''; statusNames.className = 'file-status'; }
        if (dropNames) dropNames.classList.remove('loaded');

        const progressArea = document.getElementById('inv-progress');
        if (progressArea) progressArea.classList.add('hidden');
    }

    // ===== サマリー更新 =====
    async function updateSummary() {
        const card = document.getElementById('data-summary-card');
        const container = document.getElementById('data-summary');

        const invCount = await DB.count('inventory');
        const storeCount = (await DB.getStores()).length;
        const excludedDrugCount = (await DB.getAll('excludedDrugs')).length;
        const excludedStores = (await DB.getStores()).filter(s => s.excluded).length;
        const lastUpdate = await DB.getSetting('lastInventoryUpdate');

        if (invCount > 0 || storeCount > 0) {
            card.style.display = 'block';
            container.innerHTML = `
                <div class="summary-item">
                    <div class="summary-value">${invCount.toLocaleString()}</div>
                    <div class="summary-label">在庫レコード数</div>
                </div>
                <div class="summary-item">
                    <div class="summary-value">${storeCount}</div>
                    <div class="summary-label">登録店舗数</div>
                </div>
                <div class="summary-item">
                    <div class="summary-value">${excludedDrugCount}</div>
                    <div class="summary-label">除外薬品数</div>
                </div>
                <div class="summary-item">
                    <div class="summary-value">${excludedStores}</div>
                    <div class="summary-label">除外店舗数</div>
                </div>
            `;
        } else {
            card.style.display = 'none';
        }

        // ロール選択画面のステータス更新
        App.updateDataStatus(invCount, storeCount, lastUpdate);
    }

    // ===== 初期化 =====
    async function init() {
        // ドロップゾーンのイベント設定
        setupDropZone('drop-inv-1', 'file-inv-1', (f) => handleInventoryUpload(f, 0));
        setupDropZone('drop-inv-2', 'file-inv-2', (f) => handleInventoryUpload(f, 1));
        setupDropZone('drop-store-names', 'file-store-names', handleStoreNamesUpload);
        
        // 共有データ手動インポートのイベント設定
        const dropShared = document.getElementById('drop-shared-import');
        if (dropShared && typeof SharedData !== 'undefined') {
            setupDropZone('drop-shared-import', 'file-shared-import', (f) => SharedData.importFromFile(f));
        }

        // ボタンイベント
        document.getElementById('btn-add-exclude-drug').addEventListener('click', addExcludedDrug);
        // オートコンプリート
        const drugInput = document.getElementById('exclude-drug-input');
        drugInput.addEventListener('input', onAutocompleteInput);
        drugInput.addEventListener('keydown', (e) => {
            onAutocompleteKeydown(e);
            if (e.key === 'Enter' && acActiveIdx < 0) addExcludedDrug();
        });
        drugInput.addEventListener('blur', () => setTimeout(hideAutocomplete, 200));

        document.getElementById('search-exclude-drug').addEventListener('input', renderExcludeDrugList);
        document.getElementById('btn-reset-inventory').addEventListener('click', resetInventory);
        document.getElementById('btn-reset-all').addEventListener('click', resetAll);

        // タブ切り替え
        document.querySelectorAll('.admin-tabs .tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.admin-tabs .tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('#admin-section .tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab).classList.add('active');
            });
        });

        // 初期データ表示
        await renderExcludeDrugList();
        await renderExcludeStoreList();
        await updateSummary();
    }

    // ===== ドロップゾーンセットアップ =====
    function setupDropZone(dropId, fileInputId, handler) {
        const zone = document.getElementById(dropId);
        const input = document.getElementById(fileInputId);

        zone.addEventListener('click', () => input.click());

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('dragover');
        });

        zone.addEventListener('dragleave', () => {
            zone.classList.remove('dragover');
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) handler(file);
        });

        input.addEventListener('change', () => {
            if (input.files[0]) handler(input.files[0]);
        });
    }

    // ===== HTMLエスケープ =====
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ===== 薬品名正規化 =====
    function normalizeDrugName(name) {
        if (!name) return '';
        // 先頭の〇（全角丸）、○（白丸）、◯（大きい丸）を除去
        let result = name.replace(/^[〇○◯Ｏ]+/, '').trim();
        // 半角→全角変換
        result = toFullWidth(result);
        return result;
    }

    /**
     * 半角カナ・半角括弧を全角に変換するユーティリティ
     * （PDF出力時やデータ表示時にも使用）
     */
    function toFullWidth(str) {
        if (!str) return '';
        let result = halfToFullKana(String(str));
        // 半角英数字・一部記号を全角に変換
        result = result.replace(/[A-Za-z0-9!-/:-@\[-`{-~]/g, function(s) {
            return String.fromCharCode(s.charCodeAt(0) + 0xFEE0);
        });
        // 半角スペースを全角スペースに
        result = result.replace(/ /g, '　');
        // 半角括弧「｢｣」→ 全角括弧「「」」変換
        result = result.replace(/｢/g, '「').replace(/｣/g, '」');
        return result;
    }

    /**
     * 半角カタカナを全角カタカナに変換する
     * 濁点・半濁点の結合も処理
     */
    function halfToFullKana(str) {
        // 半角カタカナ → 全角カタカナ マッピング
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
            'ﾜ': 'ワ', 'ﾝ': 'ン', 'ﾞ': '゛', 'ﾟ': '゜'
        };

        // 濁点・半濁点の結合マッピング
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
                // 次の文字が濁点(ﾞ)または半濁点(ﾟ)なら結合
                const next = str[i + 1];
                if (next === 'ﾞ' && dakutenMap[fullChar]) {
                    result += dakutenMap[fullChar];
                    i++; // 濁点をスキップ
                } else if (next === 'ﾟ' && handakutenMap[fullChar]) {
                    result += handakutenMap[fullChar];
                    i++; // 半濁点をスキップ
                } else {
                    result += fullChar;
                }
            } else {
                result += ch;
            }
        }
        return result;
    }

    return { init, updateSummary, normalizeDrugName, toFullWidth };
})();
