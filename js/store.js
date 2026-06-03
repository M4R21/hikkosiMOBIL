/* ============================================
   store.js — 店舗画面ロジック（通常版）
   ============================================ */

const Store = (() => {

    let currentStoreIndex = null;
    let currentStoreName = '';
    let moveItems = [];
    let _customSorted = false; // 引き取り先ソート時にtrueにし、デフォルトソートをスキップ

    // ===== 初期化 =====
    async function init() {
        await populateStoreSelect();

        document.getElementById('store-select').addEventListener('change', onStoreSelect);
        setupDropZone('drop-fudou', 'file-fudou', handleFudouUpload);
        document.getElementById('btn-export-pdf-all').addEventListener('click', exportPDFAll);
        document.getElementById('btn-export-pdf-each').addEventListener('click', exportPDFEach);
        document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
        document.getElementById('btn-sort-by-dest').addEventListener('click', sortByDestination);
        document.getElementById('btn-store-reset').addEventListener('click', resetStoreData);
        document.getElementById('btn-manual-add').addEventListener('click', showManualAddModal);
        document.getElementById('manual-cancel').addEventListener('click', hideManualAddModal);
        document.getElementById('manual-save').addEventListener('click', handleManualAddSave);

        // バラ検索モーダル
        document.getElementById('btn-bulk-search-modal').addEventListener('click', () => {
            document.getElementById('bulk-search-modal').classList.remove('hidden');
        });
        document.getElementById('bulk-search-close').addEventListener('click', () => {
            document.getElementById('bulk-search-modal').classList.add('hidden');
        });

        // 手動追加のオートコンプリート
        const manualDrugInput = document.getElementById('manual-drug-name');
        manualDrugInput.addEventListener('input', onAutocompleteInput);
        manualDrugInput.addEventListener('keydown', onAutocompleteKeydown);
        manualDrugInput.addEventListener('blur', () => setTimeout(hideAutocomplete, 200));
    }

    async function populateStoreSelect() {
        const select = document.getElementById('store-select');
        const stores = await DB.getActiveStores();
        // 五十音順にソート
        stores.sort((a, b) => a.storeName.localeCompare(b.storeName, 'ja'));
        while (select.options.length > 1) select.remove(1);
        stores.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.storeIndex;
            opt.textContent = s.storeName;
            select.appendChild(opt);
        });
    }

    function onStoreSelect() {
        const select = document.getElementById('store-select');
        const storeMain = document.getElementById('store-main');
        const selectCard = document.getElementById('store-select-card');
        const badge = document.getElementById('store-name-badge');

        if (select.value) {
            currentStoreIndex = parseInt(select.value);
            currentStoreName = select.options[select.selectedIndex].textContent;

            // 店舗選択カードを非表示、メインコンテンツを表示
            selectCard.classList.add('hidden');
            storeMain.classList.remove('hidden');
            badge.textContent = currentStoreName;
            badge.classList.remove('hidden');

            // 既存データを復元
            loadExistingMoveRequests();
        } else {
            currentStoreIndex = null;
            storeMain.classList.add('hidden');
            selectCard.classList.remove('hidden');
            badge.classList.add('hidden');
        }
    }

    // ===== 戻る =====
    function goBack() {
        const storeMain = document.getElementById('store-main');
        const selectCard = document.getElementById('store-select-card');
        const badge = document.getElementById('store-name-badge');

        storeMain.classList.add('hidden');
        selectCard.classList.remove('hidden');
        badge.classList.add('hidden');
        document.getElementById('store-results').classList.add('hidden');
        document.getElementById('store-table-body').innerHTML = '';
        document.getElementById('status-fudou').textContent = '';
        document.getElementById('status-fudou').className = 'file-status';
        document.getElementById('store-select').value = '';
        currentStoreIndex = null;
        currentStoreName = '';
        moveItems = [];

        App.navigateTo('home');
    }

    // ===== 既存データ復元 =====
    async function loadExistingMoveRequests() {
        const existing = await DB.getMoveRequestsByStore(currentStoreIndex);
        if (existing && existing.length > 0) {
            moveItems = existing;
            await renderResults();
            document.getElementById('store-results').classList.remove('hidden');
        } else {
            moveItems = [];
            document.getElementById('store-results').classList.add('hidden');
            document.getElementById('store-table-body').innerHTML = '';
        }
    }

    // ===== 店舗データリセット =====
    function resetStoreData() {
        App.showConfirm(
            `${currentStoreName}のデータリセット`,
            `${currentStoreName}の不動品データを全て削除します。他の店舗のデータには影響しません。\nよろしいですか？`,
            async () => {
                await DB.clearMoveRequestsByStore(currentStoreIndex);
                moveItems = [];
                document.getElementById('store-results').classList.add('hidden');
                document.getElementById('store-table-body').innerHTML = '';
                document.getElementById('status-fudou').textContent = '';
                document.getElementById('status-fudou').className = 'file-status';
                document.getElementById('drop-fudou').classList.remove('loaded');
                App.showToast(`${currentStoreName}のデータをリセットしました`, 'success');
            }
        );
    }

    // ===== ヘッダー行から列を自動検出 =====
    /**
     * Excelの全行をスキャンし、ヘッダー行と各項目の列インデックスを特定する。
     * 最初の20行以内で「薬品名」を含む行をヘッダーとみなす。
     */
    function detectColumns(rows) {
        const HEADER_KEYWORDS = {
            drug:   ['薬品名'],
            qty:    ['在庫数'],
            expiry: ['有効期限'],
            lot:    ['ロットNO', 'ロットNo', 'ロットno', 'ロット'],
            person: ['担当者名', '担当者']
        };

        let headerRowIndex = -1;
        const colMap = { drug: -1, qty: -1, expiry: -1, lot: -1, person: -1 };

        const searchLimit = Math.min(rows.length, 20);
        for (let r = 0; r < searchLimit; r++) {
            const row = rows[r];
            if (!row) continue;

            const hasDrugCol = row.some(cell => {
                const cellStr = String(cell || '').trim();
                return HEADER_KEYWORDS.drug.some(kw => cellStr.includes(kw));
            });

            if (hasDrugCol) {
                headerRowIndex = r;
                for (let c = 0; c < row.length; c++) {
                    const cellStr = String(row[c] || '').trim();
                    for (const [key, keywords] of Object.entries(HEADER_KEYWORDS)) {
                        if (colMap[key] === -1 && keywords.some(kw => cellStr.includes(kw))) {
                            colMap[key] = c;
                        }
                    }
                }
                break;
            }
        }

        return { headerRowIndex, colMap };
    }

    // ===== 不動データアップロード =====
    async function handleFudouUpload(file) {
        const statusEl = document.getElementById('status-fudou');
        const dropZone = document.getElementById('drop-fudou');

        try {
            statusEl.textContent = '読み込み中...';
            statusEl.className = 'file-status';

            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

            if (rows.length < 2) throw new Error('データが空です');

            // ヘッダー行から列を自動検出
            const { headerRowIndex, colMap } = detectColumns(rows);

            if (headerRowIndex === -1 || colMap.drug === -1) {
                throw new Error('「薬品名」の列が見つかりません。Excelのヘッダー行に「薬品名」という項目があるか確認してください。');
            }

            // 見つからなかった列の警告
            const warnings = [];
            if (colMap.qty === -1)    warnings.push('在庫数');
            if (colMap.expiry === -1) warnings.push('有効期限');
            if (colMap.lot === -1)    warnings.push('ロットNO');
            if (warnings.length > 0) {
                App.showToast(`⚠ 「${warnings.join('」「')}」の列が見つかりませんでした（空欄として処理します）`, 'warning');
            }

            await DB.clearMoveRequestsByStore(currentStoreIndex);
            moveItems = [];

            const dataStartRow = headerRowIndex + 1;

            for (let r = dataStartRow; r < rows.length; r++) {
                const row = rows[r];
                const rawDrugName = row[colMap.drug];
                if (!rawDrugName) continue;
                const drugName = Admin.normalizeDrugName(String(rawDrugName));

                const qty = colMap.qty !== -1 ? (parseFloat(row[colMap.qty]) || 0) : 0;

                let expiry = '';
                if (colMap.expiry !== -1) {
                    const rawExpiry = row[colMap.expiry];
                    if (rawExpiry) {
                        expiry = typeof rawExpiry === 'number'
                            ? formatDate(excelDateToJSDate(rawExpiry))
                            : String(rawExpiry);
                    }
                }

                const lot = colMap.lot !== -1 ? String(row[colMap.lot] || '') : '';
                const person = colMap.person !== -1 ? String(row[colMap.person] || '') : '';

                const result = await Matching.findCandidates(drugName, currentStoreIndex);

                const item = {
                    storeIndex: currentStoreIndex,
                    storeName: currentStoreName,
                    drugName,
                    qty, expiry, lot, person,
                    memo: '',
                    candidates: result.candidates,
                    candidateStatus: result.status,
                    candidateMessage: result.message,
                    selectedCandidate: result.candidates.length > 0 ? result.candidates[0].storeName : '',
                    createdAt: new Date().toISOString()
                };

                await DB.put('moveRequests', item);
            }

            moveItems = await DB.getMoveRequestsByStore(currentStoreIndex);

            statusEl.textContent = `✓ ${file.name} (${moveItems.length}品目)`;
            statusEl.className = 'file-status success';
            dropZone.classList.add('loaded');

            await renderResults();
            document.getElementById('store-results').classList.remove('hidden');
            App.showToast(`${moveItems.length}品目のデータを読み込みました`, 'success');

        } catch (err) {
            statusEl.textContent = `✗ エラー: ${err.message}`;
            statusEl.className = 'file-status error';
            App.showToast(`読み込みエラー: ${err.message}`, 'error');
        }
    }

    // ===== テーブル描画 =====
    async function renderResults() {
        if (_customSorted) {
            // カスタムソート済みの場合はそのまま描画
            _customSorted = false;
        } else {
            // 手動追加・バラ検索のものを上にするデフォルトソート
            moveItems.sort((a, b) => {
                const aIsTop = a.person === '手動追加' || a.person === 'バラ検索';
                const bIsTop = b.person === '手動追加' || b.person === 'バラ検索';
                if (aIsTop && !bIsTop) return -1;
                if (!aIsTop && bIsTop) return 1;
                if (aIsTop && bIsTop) return (b.id || 0) - (a.id || 0);
                return (a.id || 0) - (b.id || 0);
            });
        }

        const tbody = document.getElementById('store-table-body');
        tbody.innerHTML = '';

        for (const item of moveItems) {
            const tr = document.createElement('tr');

            const tdDrug = document.createElement('td');
            const flexContainer = document.createElement('div');
            flexContainer.style.display = 'flex';
            flexContainer.style.alignItems = 'center';
            flexContainer.style.justifyContent = 'space-between';
            
            const spanDrug = document.createElement('span');
            spanDrug.textContent = Admin.toFullWidth(item.drugName);
            
            const btnDel = document.createElement('button');
            btnDel.innerHTML = '✖';
            btnDel.title = '手動削除';
            btnDel.style.background = 'none';
            btnDel.style.border = 'none';
            btnDel.style.color = '#ef4444';
            btnDel.style.cursor = 'pointer';
            btnDel.style.padding = '4px 8px';
            btnDel.style.borderRadius = '4px';
            btnDel.onmouseover = () => btnDel.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
            btnDel.onmouseout = () => btnDel.style.backgroundColor = 'transparent';
            
            btnDel.addEventListener('click', () => {
                App.showConfirm('削除の確認', `「${item.drugName}」を一覧から削除しますか？`, async () => {
                    await DB.remove('moveRequests', item.id);
                    moveItems = moveItems.filter(m => m.id !== item.id);
                    await renderResults();
                    App.showToast('削除しました', 'success');
                });
            });

            flexContainer.appendChild(spanDrug);
            flexContainer.appendChild(btnDel);
            tdDrug.appendChild(flexContainer);
            tr.appendChild(tdDrug);

            const tdQty = document.createElement('td');
            const inputQty = document.createElement('input');
            inputQty.type = 'number';
            inputQty.className = 'editable';
            inputQty.value = item.qty;
            inputQty.dataset.id = item.id;
            inputQty.dataset.field = 'qty';
            inputQty.addEventListener('change', onFieldChange);
            tdQty.appendChild(inputQty);
            tr.appendChild(tdQty);

            const tdExpiry = document.createElement('td');
            const inputExpiry = document.createElement('input');
            inputExpiry.type = 'text';
            inputExpiry.className = 'editable';
            inputExpiry.value = item.expiry || '';
            inputExpiry.dataset.id = item.id;
            inputExpiry.dataset.field = 'expiry';
            inputExpiry.addEventListener('change', onFieldChange);
            
            // 期限切れなら背景色を赤くするクラスを追加
            if (isExpired(item.expiry)) {
                inputExpiry.classList.add('expired');
                inputExpiry.title = '期限が切れています';
            }

            tdExpiry.appendChild(inputExpiry);
            tr.appendChild(tdExpiry);

            const tdLot = document.createElement('td');
            const inputLot = document.createElement('input');
            inputLot.type = 'text';
            inputLot.className = 'editable';
            inputLot.value = item.lot || '';
            inputLot.dataset.id = item.id;
            inputLot.dataset.field = 'lot';
            inputLot.addEventListener('change', onFieldChange);
            tdLot.appendChild(inputLot);
            tr.appendChild(tdLot);

            const tdMemo = document.createElement('td');
            const inputMemo = document.createElement('input');
            inputMemo.type = 'text';
            inputMemo.className = 'editable';
            inputMemo.value = item.memo || '';
            inputMemo.placeholder = '備考';
            inputMemo.dataset.id = item.id;
            inputMemo.dataset.field = 'memo';
            inputMemo.addEventListener('change', onFieldChange);
            tdMemo.appendChild(inputMemo);
            tr.appendChild(tdMemo);

            const tdCandidate = document.createElement('td');
            if (item.candidates && item.candidates.length > 0) {
                const select = document.createElement('select');
                select.className = 'select-candidate';
                select.dataset.id = item.id;

                item.candidates.forEach((c, i) => {
                    const opt = document.createElement('option');
                    opt.value = c.storeName;
                    opt.textContent = `${i + 1}. ${c.storeName}（${c.freq} / 月数${c.months}）`;
                    if (c.storeName === item.selectedCandidate) opt.selected = true;
                    select.appendChild(opt);
                });

                select.addEventListener('change', async () => {
                    const rec = await DB.get('moveRequests', parseInt(select.dataset.id));
                    if (rec) {
                        rec.selectedCandidate = select.value;
                        await DB.put('moveRequests', rec);
                    }
                });

                tdCandidate.appendChild(select);
            } else {
                const msg = item.candidateMessage || '引き取り先なし';
                const span = document.createElement('span');
                span.textContent = msg;
                span.style.color = msg === '▲' ? 'var(--warning)' : 'red';
                tdCandidate.appendChild(span);
            }

            tr.appendChild(tdCandidate);
            tbody.appendChild(tr);
        }
    }

    // ===== 期限切れ判定ヘルパー =====
    function isExpired(expiryStr) {
        if (!expiryStr) return false;
        
        let cleanStr = expiryStr.trim();
        if (cleanStr === '') return false;

        // スラッシュやハイフンで分割
        let parts = cleanStr.split(/[\/\-]/);
        let year, month, day;
        
        if (parts.length >= 2) {
            year = parseInt(parts[0], 10);
            month = parseInt(parts[1], 10);
            
            // 年が2桁の場合（例：25/10）は2000年代を補正
            if (year < 100) {
                year += 2000;
            }
            
            if (parts.length >= 3) {
                day = parseInt(parts[2], 10);
            } else {
                // "YYYY/MM" 形式の場合は、その月の最終日とする
                day = new Date(year, month, 0).getDate();
            }
            
            const expiryDate = new Date(year, month - 1, day, 23, 59, 59); // その日の終わり
            const today = new Date();
            today.setHours(0, 0, 0, 0); // 今日の始まり
            
            return expiryDate < today;
        }
        
        // パースできなかった場合は Date.parse を試みる
        const parsed = Date.parse(cleanStr);
        if (!isNaN(parsed)) {
            const expiryDate = new Date(parsed);
            expiryDate.setHours(23, 59, 59, 999);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            return expiryDate < today;
        }
        
        return false;
    }

    async function onFieldChange(e) {
        const id = parseInt(e.target.dataset.id);
        const field = e.target.dataset.field;
        const value = e.target.value;
        const rec = await DB.get('moveRequests', id);
        if (rec) {
            rec[field] = field === 'qty' ? (parseFloat(value) || 0) : value;
            await DB.put('moveRequests', rec);
        }

        // 期限フィールドが変更された場合、リアルタイムで背景色をアップデート
        if (field === 'expiry') {
            if (isExpired(value)) {
                e.target.classList.add('expired');
                e.target.title = '期限が切れています';
            } else {
                e.target.classList.remove('expired');
                e.target.removeAttribute('title');
            }
        }
    }

    // ===== ソート =====
    async function sortByDestination() {
        try {
            moveItems = await DB.getMoveRequestsByStore(currentStoreIndex);
            if (!moveItems || moveItems.length === 0) {
                App.showToast('ソートするデータがありません', 'warning');
                return;
            }
            moveItems.sort((a, b) => {
                const aName = a.selectedCandidate || 'ｺｺｺ';
                const bName = b.selectedCandidate || 'ｺｺｺ';
                if (aName !== bName) return aName.localeCompare(bName);
                return a.drugName.localeCompare(b.drugName);
            });
            _customSorted = true; // デフォルトソートをスキップさせる
            await renderResults();
            App.showToast('引き取り先でソートしました', 'info');
        } catch (err) {
            console.error('ソートエラー:', err);
            App.showToast(`ソートエラー: ${err.message}`, 'error');
        }
    }

    // ===== PDF出力 =====
    // ===== PDF一括出力（印刷用） =====
    async function exportPDFAll() {
        const items = await DB.getMoveRequestsByStore(currentStoreIndex);
        if (!items || items.length === 0) {
            App.showToast('出力するデータがありません', 'warning');
            return;
        }

        const grouped = {};
        for (const item of items) {
            if (item.selectedCandidate && item.candidates && item.candidates.length > 0) {
                if (!grouped[item.selectedCandidate]) grouped[item.selectedCandidate] = [];
                grouped[item.selectedCandidate].push({
                    drugName: item.drugName, qty: item.qty,
                    expiry: item.expiry, lot: item.lot, memo: item.memo
                });
            }
        }

        if (Object.keys(grouped).length === 0) {
            App.showToast('引き取り先が設定されている薬品がありません', 'warning');
            return;
        }

        try {
            const doc = await PDF.generateAllPickupRequests(currentStoreName, grouped);
            PDF.download(doc, `引き取り依頼_${currentStoreName}_${formatDateForFile(new Date())}.pdf`);
            App.showToast('一括PDFを出力しました', 'success');
        } catch (err) {
            App.showToast(`PDF出力エラー: ${err.message}`, 'error');
        }
    }

    // ===== PDF個別出力（配信用） =====
    async function exportPDFEach() {
        const items = await DB.getMoveRequestsByStore(currentStoreIndex);
        if (!items || items.length === 0) {
            App.showToast('出力するデータがありません', 'warning');
            return;
        }

        const grouped = {};
        for (const item of items) {
            if (item.selectedCandidate && item.candidates && item.candidates.length > 0) {
                if (!grouped[item.selectedCandidate]) grouped[item.selectedCandidate] = [];
                grouped[item.selectedCandidate].push({
                    drugName: item.drugName, qty: item.qty,
                    expiry: item.expiry, lot: item.lot, memo: item.memo
                });
            }
        }

        if (Object.keys(grouped).length === 0) {
            App.showToast('引き取り先が設定されている薬品がありません', 'warning');
            return;
        }

        try {
            const today = new Date();
            const dateStr = formatDateForFile(today);
            const storeCount = Object.keys(grouped).length;

            App.showToast(`${storeCount}店舗分の個別PDFの圧縮処理を開始します...`, 'info');

            const zip = new JSZip();

            // 各店舗ごとに個別にPDFを生成し、ZIPに追加
            for (const [toStoreName, storeItems] of Object.entries(grouped)) {
                const doc = await PDF.generatePickupRequest(currentStoreName, toStoreName, storeItems);
                const pdfBlob = doc.output('blob');
                zip.file(`引き取り依頼_${toStoreName}_${dateStr}.pdf`, pdfBlob);
            }

            // ZIPファイルを非同期で生成（Blob形式）
            const zipBlob = await zip.generateAsync({ type: 'blob' });

            // ダウンロード処理
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `店舗別引き取り依頼_${currentStoreName}_${dateStr}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            App.showToast('店舗別の個別PDF（ZIP形式）を出力しました', 'success');
        } catch (err) {
            App.showToast(`ZIP出力エラー: ${err.message}`, 'error');
        }
    }

    // ===== CSV出力 =====
    async function exportCSV() {
        const items = await DB.getMoveRequestsByStore(currentStoreIndex);
        if (!items || items.length === 0) {
            App.showToast('出力するデータがありません', 'warning');
            return;
        }

        const headers = ['薬品名', '在庫数', '有効期限', 'ロット', '備考', '引き取り先'];
        const rows = items.map(item => [
            Admin.toFullWidth(item.drugName),
            item.qty,
            item.expiry || '',
            item.lot ? `="${item.lot}"` : '',
            item.memo || '',
            item.selectedCandidate || (
                item.candidateMessage || '引き取り先なし'
            )
        ]);

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
        a.download = `移動先候補_${currentStoreName}_${formatDateForFile(new Date())}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        App.showToast('CSVを出力しました', 'success');
    }

    // ===== 手動追加 =====
    function showManualAddModal() {
        document.getElementById('manual-drug-name').value = '';
        document.getElementById('manual-qty').value = '';
        document.getElementById('manual-expiry').value = '';
        document.getElementById('manual-lot').value = '';
        document.getElementById('manual-memo').value = '';
        document.getElementById('manual-add-modal').classList.remove('hidden');
    }

    function hideManualAddModal() {
        document.getElementById('manual-add-modal').classList.add('hidden');
        hideAutocomplete();
    }

    async function handleManualAddSave() {
        const drugNameInput = document.getElementById('manual-drug-name').value.trim();
        const qtyInput = document.getElementById('manual-qty').value;
        const expiry = document.getElementById('manual-expiry').value.trim();
        const lot = document.getElementById('manual-lot').value.trim();
        const memo = document.getElementById('manual-memo').value.trim();

        if (!drugNameInput) {
            App.showToast('薬品名を入力してください', 'error');
            return;
        }

        const drugName = Admin.normalizeDrugName(drugNameInput);
        const qty = parseFloat(qtyInput) || 0;

        hideManualAddModal();

        try {
            const result = await Matching.findCandidates(drugName, currentStoreIndex);

            const item = {
                storeIndex: currentStoreIndex,
                storeName: currentStoreName,
                drugName,
                qty, expiry, lot, memo: memo, person: '手動追加',
                candidates: result.candidates,
                candidateStatus: result.status,
                candidateMessage: result.message,
                selectedCandidate: result.candidates.length > 0 ? result.candidates[0].storeName : '',
                createdAt: new Date().toISOString()
            };

            await DB.put('moveRequests', item);
            moveItems = await DB.getMoveRequestsByStore(currentStoreIndex);
            
            // 一連のDOM更新
            await renderResults();
            document.getElementById('store-results').classList.remove('hidden');

            App.showToast(`${Admin.toFullWidth(drugName)} を追加しました`, 'success');
        } catch (err) {
            App.showToast(`エラー: ${err.message}`, 'error');
        }
    }

    // ===== バラ錠から引き取り先として追加 =====
    async function addBulkTransfer(drugNameRaw, targetStoreName) {
        if (!drugNameRaw || !targetStoreName) return;

        const drugName = Admin.normalizeDrugName(drugNameRaw);
        
        try {
            // 引き取り先を検索済みの状態としてオブジェクトを作成
            const item = {
                storeIndex: currentStoreIndex,
                storeName: currentStoreName,
                drugName,
                qty: 0, // 利用者が後で入力
                expiry: '', 
                lot: '', 
                memo: 'バラ錠', 
                person: 'バラ検索',
                candidates: [{ storeName: targetStoreName, freq: '実績あり', months: 0 }],
                candidateStatus: 'ok',
                candidateMessage: 'OK',
                selectedCandidate: targetStoreName,
                createdAt: new Date().toISOString()
            };

            await DB.put('moveRequests', item);
            moveItems = await DB.getMoveRequestsByStore(currentStoreIndex);
            
            // 一覧を再描画
            await renderResults();
            document.getElementById('store-results').classList.remove('hidden');

            App.showToast(`${Admin.toFullWidth(drugName)} の移動先に ${targetStoreName} を追加しました`, 'success');
            
            // モーダルを閉じる
            document.getElementById('bulk-search-modal').classList.add('hidden');
            
        } catch (err) {
            App.showToast(`エラー: ${err.message}`, 'error');
        }
    }

    // ===== オートコンプリート (手動追加用) =====
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

    function hiraToKana(str) {
        return str.replace(/[\u3041-\u3096]/g, function(match) {
            return String.fromCharCode(match.charCodeAt(0) + 0x60);
        });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async function onAutocompleteInput() {
        const input = document.getElementById('manual-drug-name');
        const term = input.value.trim();
        if (term.length < 3) {
            hideAutocomplete();
            return;
        }

        const drugNames = await getDrugNameCache();
        const termKana = hiraToKana(term.toLowerCase());
        const matches = drugNames.filter(n => hiraToKana(n.toLowerCase()).includes(termKana)).slice(0, 20);

        const list = document.getElementById('manual-drug-autocomplete');
        if (matches.length === 0) {
            hideAutocomplete();
            return;
        }

        acActiveIdx = -1;
        list.innerHTML = matches.map((name, i) => {
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

        list.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = item.dataset.value;
                hideAutocomplete();
            });
        });
    }

    function onAutocompleteKeydown(e) {
        const list = document.getElementById('manual-drug-autocomplete');
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
            const input = document.getElementById('manual-drug-name');
            input.value = items[acActiveIdx].dataset.value;
            hideAutocomplete();
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
        const list = document.getElementById('manual-drug-autocomplete');
        if (list) {
            list.classList.add('hidden');
            list.innerHTML = '';
        }
        acActiveIdx = -1;
    }

    // ===== ユーティリティ =====
    function excelDateToJSDate(serial) { return new Date((serial - 25569) * 86400 * 1000); }
    function formatDate(d) {
        if (!d || isNaN(d.getTime())) return '';
        return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    }
    function formatDateForFile(d) {
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }
    function setupDropZone(dropId, fileInputId, handler) {
        const zone = document.getElementById(dropId);
        const input = document.getElementById(fileInputId);
        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault(); zone.classList.remove('dragover');
            if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
        });
        input.addEventListener('change', async () => { if (input.files[0]) { await handler(input.files[0]); input.value = ''; } });
    }

    async function onShow() {
        await populateStoreSelect();
        // 完全リセット（他の店舗のデータが見えないように）
        document.getElementById('store-main').classList.add('hidden');
        document.getElementById('store-select-card').classList.remove('hidden');
        document.getElementById('store-name-badge').classList.add('hidden');
        document.getElementById('store-results').classList.add('hidden');
        document.getElementById('store-table-body').innerHTML = '';
        document.getElementById('store-select').value = '';
        currentStoreIndex = null;
        currentStoreName = '';
        moveItems = [];
    }

    return { init, onShow, goBack, addBulkTransfer };
})();
