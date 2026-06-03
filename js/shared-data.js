/* ============================================
   shared-data.js — 共有データ管理モジュール (ローカル＆SharePoint同期版)
   ============================================ */

const SharedData = (() => {

    // ===== エクスポート: IndexedDB → JSON ファイル =====
    async function exportSharedData() {
        const statusEl = document.getElementById('status-export-shared');
        try {
            statusEl.textContent = 'エクスポート中...';
            statusEl.className = 'file-status';

            // 全データをIndexedDBから取得
            const stores = await DB.getAll('stores');
            const inventory = await DB.getAll('inventory');
            const excludedDrugs = await DB.getAll('excludedDrugs');
            const bulkInventory = await DB.getAll('bulkInventory');
            const bulkExcluded = await DB.getAll('bulkExcluded');

            // 設定情報を取得
            const lastInventoryUpdate = await DB.getSetting('lastInventoryUpdate');
            const inventoryItemCount = await DB.getSetting('inventoryItemCount');

            const sharedData = {
                version: new Date().toISOString(),
                exportedAt: new Date().toLocaleString('ja-JP'),
                summary: {
                    inventoryCount: inventory.length,
                    storeCount: stores.length,
                    excludedDrugCount: excludedDrugs.length,
                    bulkInventoryCount: bulkInventory.length,
                    bulkExcludedCount: bulkExcluded.length,
                    lastInventoryUpdate,
                    inventoryItemCount
                },
                data: {
                    stores,
                    inventory,
                    excludedDrugs,
                    bulkInventory,
                    bulkExcluded
                }
            };

            // JSONファイルをダウンロード
            const jsonStr = JSON.stringify(sharedData);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'shared-data.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            const sizeMB = (jsonStr.length / 1024 / 1024).toFixed(1);
            statusEl.textContent = `✓ エクスポート完了（${sizeMB}MB）— このファイルをSharePointのツールと同じフォルダ、またはOneDriveの同期フォルダに配置してください`;
            statusEl.className = 'file-status success';

            App.showToast('共有データをエクスポートしました。', 'success');

        } catch (err) {
            statusEl.textContent = `✗ エクスポートエラー: ${err.message}`;
            statusEl.className = 'file-status error';
            App.showToast(`エクスポートエラー: ${err.message}`, 'error');
        }
    }

    // ===== インポート共通処理: パースされたオブジェクトをIndexedDBへ取り込み =====
    async function processImportedData(sharedData, showToasts = true) {
        if (!sharedData || !sharedData.data) {
            throw new Error('無効なデータ形式です。');
        }

        const d = sharedData.data;

        // 店舗データ
        if (d.stores && d.stores.length > 0) {
            await DB.clear('stores');
            await DB.putBatch('stores', d.stores);
        }

        // 在庫データ
        if (d.inventory && d.inventory.length > 0) {
            await DB.clear('inventory');
            await DB.putBatch('inventory', d.inventory, (done, total) => {
                // 進捗表示（大量データの場合）
                if (done % 5000 === 0 || done === total) {
                    console.log(`共有データ取り込み中: ${done.toLocaleString()} / ${total.toLocaleString()}`);
                }
            });
        }

        // 除外薬品
        if (d.excludedDrugs) {
            await DB.clear('excludedDrugs');
            for (const item of d.excludedDrugs) {
                await DB.put('excludedDrugs', item);
            }
        }

        // バラ錠データ
        if (d.bulkInventory && d.bulkInventory.length > 0) {
            await DB.clear('bulkInventory');
            await DB.putBatch('bulkInventory', d.bulkInventory);
        }

        // バラ錠除外データ
        if (d.bulkExcluded) {
            await DB.clear('bulkExcluded');
            for (const item of d.bulkExcluded) {
                await DB.put('bulkExcluded', item);
            }
        }

        // 設定を復元
        if (sharedData.summary) {
            if (sharedData.summary.lastInventoryUpdate) {
                await DB.setSetting('lastInventoryUpdate', sharedData.summary.lastInventoryUpdate);
            }
            if (sharedData.summary.inventoryItemCount) {
                await DB.setSetting('inventoryItemCount', sharedData.summary.inventoryItemCount);
            }
        }

        // バージョンを記録
        await DB.setSetting('sharedDataVersion', sharedData.version);

        if (showToasts) {
            const count = sharedData.summary?.inventoryCount || 0;
            App.showToast(`✓ 共有データを取り込みました（${count.toLocaleString()}件）`, 'success');
        }

        // メイン画面のデータステータス更新
        if (typeof App !== 'undefined' && App.updateDataStatus) {
            const invCount = await DB.count('inventory');
            const storeCount = (await DB.getStores()).length;
            const lastUpdate = await DB.getSetting('lastInventoryUpdate');
            App.updateDataStatus(invCount, storeCount, lastUpdate);
        }

        return true;
    }

    // ===== 自動インポート: 相対パスの shared-data.json を取得 =====
    async function importSharedData(showToasts = true) {
        try {
            // キャッシュ回避のためタイムスタンプを付加
            const fetchUrl = `./shared-data.json?t=${Date.now()}`;
            const response = await fetch(fetchUrl);

            if (!response.ok) {
                if (response.status === 404) {
                    console.log('自動読み込み: shared-data.json が同一フォルダ内に見つかりません。');
                    return false;
                }
                throw new Error(`HTTP ${response.status}`);
            }

            const sharedData = await response.json();

            // バージョン比較（前回取得時のバージョンと同じならスキップ）
            const lastVersion = await DB.getSetting('sharedDataVersion');
            if (lastVersion === sharedData.version) {
                console.log('自動読み込み: 共有データは最新です。再読み込みをスキップします。');
                return true; // データは既にある
            }

            // 新しいデータがある場合、IndexedDBに取り込む
            if (showToasts) {
                App.showToast('📥 同一フォルダ上の最新の共有データを取り込んでいます...', 'info');
            }

            await processImportedData(sharedData, showToasts);
            return true;

        } catch (err) {
            // ローカルで index.html を直接起動した場合はCORSエラーになりますが、正常な動作ですので静かにスキップします
            console.log('自動読み込みスキップ (CORS制限または非表示環境):', err.message);
            return false;
        }
    }

    // ===== 手動インポート: ドラッグ＆ドロップまたはファイル選択されたファイルを処理 =====
    async function importFromFile(file) {
        const statusEl = document.getElementById('status-shared-import');
        if (!statusEl) return;

        try {
            statusEl.textContent = 'インポート中...';
            statusEl.className = 'file-status';

            if (!file) {
                throw new Error('ファイルが選択されていません。');
            }

            if (!file.name.endsWith('.json')) {
                throw new Error('JSONファイル（shared-data.json）を選択してください。');
            }

            const text = await file.text();
            let sharedData;
            try {
                sharedData = JSON.parse(text);
            } catch (e) {
                throw new Error('ファイルのパースに失敗しました。JSON形式が崩れています。');
            }

            if (!sharedData.version || !sharedData.data) {
                throw new Error('ファイルの形式が正しくありません。shared-data.json であることを確認してください。');
            }

            // IndexedDBへのインポート実行
            await processImportedData(sharedData, true);

            statusEl.textContent = `✓ インポート完了（${sharedData.exportedAt || '不明'} 時点のエクスポートデータ）`;
            statusEl.className = 'file-status success';

        } catch (err) {
            console.error('手動インポートエラー:', err);
            statusEl.textContent = `✗ インポートエラー: ${err.message}`;
            statusEl.className = 'file-status error';
            App.showToast(`インポートエラー: ${err.message}`, 'error');
        }
    }

    // ===== 初期化 =====
    async function init() {
        // ボタンイベント
        const btnExport = document.getElementById('btn-export-shared');
        if (btnExport) btnExport.addEventListener('click', exportSharedData);
    }

    return { init, importSharedData, importFromFile, exportSharedData };
})();
