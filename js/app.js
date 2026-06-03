/* ============================================
   app.js — スマホ用 薬品検索アプリ（軽量版）
   shared-data-mobile.json を読み込み、
   薬品名で検索 → 在庫有無＋出庫頻度を表示
   ============================================ */

const App = (() => {

    // ===== 設定 =====
    // ※後ほど新しいGitHubリポジトリのURLに変更する場合は、ここを書き換えてください。
    const GITHUB_REPO_URL = 'https://github.com/M4R21/kusuri-ohikkoshi';

    // GitHubリポジトリURLからrawコンテンツのベースURLを生成するヘルパー
    function getGithubRawBaseUrl(repoUrl) {
        if (!repoUrl) return '';
        const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
        if (!match) return '';
        const [, user, repo] = match;
        return `https://raw.githubusercontent.com/${user}/${repo.replace(/\.git$/, '')}/main`;
    }

    // ===== データ =====
    let drugData = [];       // [{n: "薬品名", s: [{sn: "店舗名", h: true, f: "◎"}, ...]}, ...]
    let drugNameIndex = [];  // 検索用: 薬品名の配列
    let dataVersion = '';
    let dataExportedAt = '';

    // ===== オートコンプリート =====
    let acActiveIdx = -1;

    // ===== 初期化 =====
    async function init() {
        // イベントバインド
        const input = document.getElementById('search-input');
        input.addEventListener('input', onAutocompleteInput);
        input.addEventListener('keydown', onKeydown);
        input.addEventListener('blur', () => setTimeout(hideAutocomplete, 200));

        document.getElementById('btn-search').addEventListener('click', doSearch);

        // ドロップゾーン（データ未読み込み時）
        setupDropZone();

        // データの自動読み込みを試行
        const loaded = await tryAutoLoad();

        if (loaded) {
            showApp();
        } else {
            // ローカルストレージからキャッシュされたデータを試行
            const cached = loadFromCache();
            if (cached) {
                showApp();
            } else {
                showNoDataScreen();
            }
        }
    }

    // ===== 標準データ(PC用)からスマホ用簡略データへの変換 =====
    function convertStandardToMobile(data) {
        if (!data.data || !Array.isArray(data.data.stores) || !Array.isArray(data.data.inventory)) {
            return null;
        }
        try {
            const stores = data.data.stores;
            const inventory = data.data.inventory;

            // アクティブ店舗マップ
            const activeStores = stores.filter(s => !s.excluded);
            const activeStoreSet = new Set(activeStores.map(s => s.storeIndex));
            const storeNameMap = {};
            activeStores.forEach(s => { storeNameMap[s.storeIndex] = s.storeName; });

            const drugMap = new Map();
            for (const rec of inventory) {
                if (!rec.drugName) continue;
                if (!activeStoreSet.has(rec.storeIndex)) continue;

                if (!drugMap.has(rec.drugName)) {
                    drugMap.set(rec.drugName, new Map());
                }

                const storeData = drugMap.get(rec.drugName);
                storeData.set(rec.storeIndex, {
                    sn: storeNameMap[rec.storeIndex],
                    h: (rec.stockQty || 0) > 0,
                    f: rec.shipFreq || '／'
                });
            }

            const drugs = [];
            for (const [drugName, storesMap] of drugMap) {
                const storesArr = Array.from(storesMap.values())
                    .sort((a, b) => a.sn.localeCompare(b.sn, 'ja'));

                drugs.push({
                    n: drugName,
                    s: storesArr
                });
            }
            drugs.sort((a, b) => a.n.localeCompare(b.n, 'ja'));

            return {
                version: data.version || new Date().toISOString(),
                exportedAt: data.exportedAt || new Date().toLocaleString('ja-JP'),
                storeCount: activeStores.length,
                drugCount: drugs.length,
                drugs: drugs
            };
        } catch (e) {
            console.error('データ変換エラー:', e);
            return null;
        }
    }

    // ===== データ自動読み込み（複数URLパス自動フォールバック対応） =====
    async function tryAutoLoad() {
        const loadingSub = document.getElementById('loading-sub');

        const targets = [
            { name: 'ローカル (モバイル版)', url: `./shared-data-mobile.json?t=${Date.now()}` },
            { name: 'ローカル (標準版)', url: `./shared-data.json?t=${Date.now()}` }
        ];

        const rawBase = getGithubRawBaseUrl(GITHUB_REPO_URL);
        if (rawBase) {
            targets.push(
                { name: 'GitHub (モバイル版)', url: `${rawBase}/shared-data-mobile.json?t=${Date.now()}` },
                { name: 'GitHub (標準版)', url: `${rawBase}/shared-data.json?t=${Date.now()}` },
                { name: 'GitHub (dataフォルダ/モバイル版)', url: `${rawBase}/data/shared-data-mobile.json?t=${Date.now()}` },
                { name: 'GitHub (dataフォルダ/標準版)', url: `${rawBase}/data/shared-data.json?t=${Date.now()}` }
            );
        }

        for (const target of targets) {
            try {
                if (loadingSub) {
                    loadingSub.textContent = `${target.name}を取得中...`;
                }
                console.log(`フェッチ試行: ${target.name} (${target.url})`);
                
                const response = await fetch(target.url);
                if (!response.ok) {
                    console.log(`フェッチ失敗 (HTTP ${response.status}): ${target.name}`);
                    continue;
                }

                let data = await response.json();
                
                if (!data.drugs || !Array.isArray(data.drugs)) {
                    console.log(`${target.name}は標準形式の可能性があります。変換を試みます。`);
                    const converted = convertStandardToMobile(data);
                    if (converted) {
                        data = converted;
                        console.log(`${target.name}をスマホ用形式に変換しました。`);
                    } else {
                        console.log(`形式エラー: ${target.name}`);
                        continue;
                    }
                }

                setData(data);
                saveToCache(data);
                console.log(`データ自動読み込み成功: ${target.name}`);
                return true;
            } catch (err) {
                console.log(`取得エラー (${target.name}):`, err.message);
            }
        }

        return false;
    }

    // ===== ローカルストレージキャッシュ =====
    function saveToCache(data) {
        try {
            localStorage.setItem('mobile_drug_data', JSON.stringify(data));
        } catch (e) {
            console.warn('キャッシュ保存エラー（容量超過の可能性）:', e.message);
        }
    }

    // ===== キャッシュからの読み込み =====
    function loadFromCache() {
        try {
            const raw = localStorage.getItem('mobile_drug_data');
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data.drugs || !Array.isArray(data.drugs)) return false;
            setData(data);
            return true;
        } catch (e) {
            console.warn('キャッシュ読み込みエラー:', e.message);
            return false;
        }
    }

    // ===== データ設定 =====
    function setData(data) {
        drugData = data.drugs;
        drugNameIndex = drugData.map(d => d.n);
        dataVersion = data.version || '';
        dataExportedAt = data.exportedAt || '';

        updateDataInfo();
    }

    function updateDataInfo() {
        const el = document.getElementById('data-info');
        if (drugData.length > 0) {
            el.textContent = `📊 ${drugData.length.toLocaleString()}品目 | 更新: ${dataExportedAt || '不明'}`;
        } else {
            el.textContent = '';
        }
    }

    // ===== 画面切り替え =====
    function showApp() {
        const loading = document.getElementById('loading-screen');
        loading.classList.add('fade-out');
        setTimeout(() => {
            loading.style.display = 'none';
            document.getElementById('app').classList.remove('hidden');
            document.getElementById('welcome-area').classList.remove('hidden');
            document.getElementById('no-data-area').classList.add('hidden');
            setTimeout(() => document.getElementById('search-input').focus(), 300);
        }, 500);
    }

    // ===== データ未読み込み画面表示 =====
    function showNoDataScreen() {
        const loading = document.getElementById('loading-screen');
        loading.classList.add('fade-out');
        setTimeout(() => {
            loading.style.display = 'none';
            document.getElementById('app').classList.remove('hidden');
            document.getElementById('welcome-area').classList.add('hidden');
            document.getElementById('no-data-area').classList.remove('hidden');
        }, 500);
    }

    // ===== ドロップゾーンの設定 =====
    function setupDropZone() {
        const zone = document.getElementById('drop-zone-mobile');
        const fileInput = document.getElementById('file-mobile-import');
        if (!zone || !fileInput) return;

        zone.addEventListener('click', () => fileInput.click());

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
            if (file) importFile(file);
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) importFile(fileInput.files[0]);
        });
    }

    // ===== ファイルの手動インポート =====
    async function importFile(file) {
        const statusEl = document.getElementById('status-mobile-import');
        try {
            statusEl.textContent = '読み込み中...';
            statusEl.className = 'file-status';

            if (!file.name.endsWith('.json')) {
                throw new Error('JSONファイルを選択してください');
            }

            const text = await file.text();
            let data = JSON.parse(text);

            if (!data.drugs || !Array.isArray(data.drugs)) {
                // PC用データからの変換を試みる
                const converted = convertStandardToMobile(data);
                if (converted) {
                    data = converted;
                } else {
                    throw new Error('データの形式が正しくありません (モバイル形式でも標準形式でもありません)');
                }
            }

            setData(data);
            saveToCache(data);

            statusEl.textContent = `✓ 読み込み完了（${data.drugCount || data.drugs.length}品目）`;
            statusEl.className = 'file-status success';

            showToast(`✓ ${data.drugs.length.toLocaleString()}品目のデータを読み込みました`, 'success');

            // 検索画面に切り替え
            document.getElementById('welcome-area').classList.remove('hidden');
            document.getElementById('no-data-area').classList.add('hidden');
            setTimeout(() => document.getElementById('search-input').focus(), 300);

        } catch (err) {
            statusEl.textContent = `✗ エラー: ${err.message}`;
            statusEl.className = 'file-status error';
            showToast(`読み込みエラー: ${err.message}`, 'error');
        }
    }

    // ===== ひらがな→カタカナ変換 =====
    function hiraToKana(str) {
        return str.replace(/[\u3041-\u3096]/g, (ch) =>
            String.fromCharCode(ch.charCodeAt(0) + 0x60)
        );
    }

    // ===== オートコンプリート =====
    async function onAutocompleteInput() {
        const input = document.getElementById('search-input');
        const term = input.value.trim();
        if (term.length < 2 || drugData.length === 0) {
            hideAutocomplete();
            return;
        }

        const termKana = hiraToKana(term.toLowerCase());
        const matches = drugNameIndex
            .filter(n => hiraToKana(n.toLowerCase()).includes(termKana))
            .slice(0, 12);

        const list = document.getElementById('autocomplete-list');
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
                    + escapeHtml(name.substring(idx, idx + term.length))
                    + '</span>'
                    + escapeHtml(name.substring(idx + term.length));
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
            // タッチ対応
            item.addEventListener('touchstart', (e) => {
                e.preventDefault();
                input.value = item.dataset.value;
                hideAutocomplete();
                doSearch();
            }, { passive: false });
        });
    }

    function onKeydown(e) {
        const list = document.getElementById('autocomplete-list');
        if (list.classList.contains('hidden')) {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSearch();
            }
            return;
        }

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
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (acActiveIdx >= 0) {
                document.getElementById('search-input').value = items[acActiveIdx].dataset.value;
                hideAutocomplete();
            }
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
        const list = document.getElementById('autocomplete-list');
        if (list) {
            list.classList.add('hidden');
            list.innerHTML = '';
        }
        acActiveIdx = -1;
    }

    // ===== 検索実行 =====
    function doSearch() {
        const term = document.getElementById('search-input').value.trim();
        if (!term) {
            showToast('薬品名を入力してください', 'warning');
            return;
        }

        if (drugData.length === 0) {
            showToast('データが読み込まれていません', 'error');
            return;
        }

        hideAutocomplete();

        const termKana = hiraToKana(term.toLowerCase());

        const results = drugData.filter(d =>
            hiraToKana(d.n.toLowerCase()).includes(termKana)
        );

        renderResults(results);
    }

    // ===== 結果描画 =====
    function renderResults(results) {
        const container = document.getElementById('results-list');
        const countEl = document.getElementById('results-count');
        const resultsArea = document.getElementById('results-area');
        const welcomeArea = document.getElementById('welcome-area');

        container.innerHTML = '';
        welcomeArea.classList.add('hidden');
        resultsArea.classList.remove('hidden');

        countEl.textContent = `📋 ${results.length}件の薬品が見つかりました`;

        if (results.length === 0) {
            container.innerHTML = `
                <div class="empty-results">
                    <div class="empty-icon">🔍</div>
                    <p>該当する薬品が見つかりませんでした</p>
                </div>
            `;
            return;
        }

        for (const drug of results) {
            const card = document.createElement('div');
            card.className = 'result-card';

            // 在庫あり店舗数を計算
            const inStockCount = drug.s.filter(s => s.h).length;
            const totalStores = drug.s.length;

            // バッジクラス
            let badgeClass = 'has-none';
            if (inStockCount > totalStores * 0.5) badgeClass = 'has-many';
            else if (inStockCount > 0) badgeClass = 'has-some';

            // 店舗行HTML（在庫あり → なしの順にソート）
            const sortedStores = [...drug.s].sort((a, b) => {
                if (a.h !== b.h) return a.h ? -1 : 1;
                return a.sn.localeCompare(b.sn, 'ja');
            });

            const storeRows = sortedStores.map(s => {
                const rowClass = s.h ? 'has-stock' : 'no-stock';
                const badgeCls = s.h ? 'in-stock' : 'out-stock';
                const badgeText = s.h ? '在庫あり' : '在庫なし';
                const freqClass = getFreqClass(s.f);

                return `
                    <div class="store-row ${rowClass}">
                        <span class="store-name">${escapeHtml(s.sn)}</span>
                        <span class="store-stock-badge ${badgeCls}">${badgeText}</span>
                        <span class="store-freq ${freqClass}">${escapeHtml(s.f)}</span>
                    </div>
                `;
            }).join('');

            card.innerHTML = `
                <div class="result-header">
                    <div class="result-title-row">
                        <span class="result-drug-name">${escapeHtml(drug.n)}</span>
                        <span class="result-toggle">▼</span>
                    </div>
                    <div class="result-meta">
                        <span class="meta-stock ${badgeClass}">📦 在庫あり: ${inStockCount}/${totalStores}店舗</span>
                    </div>
                </div>
                <div class="result-body">
                    <div class="store-list">
                        ${storeRows}
                    </div>
                </div>
            `;

            // アコーディオン開閉
            const header = card.querySelector('.result-header');
            header.addEventListener('click', () => {
                card.classList.toggle('expanded');
            });

            // 1件のみなら自動展開
            if (results.length === 1) {
                card.classList.add('expanded');
            }

            container.appendChild(card);
        }

        // 最初のカードまでスクロール
        if (results.length > 0) {
            resultsArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function getFreqClass(freq) {
        if (freq === '◎') return 'freq-excellent';
        if (freq === '〇' || freq === '○') return 'freq-good';
        if (freq === '△') return 'freq-low';
        return 'freq-none';
    }

    // ===== トースト通知 =====
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icons = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
        toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${message}</span>`;

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ===== ユーティリティ =====
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ===== DOMContentLoaded =====
    document.addEventListener('DOMContentLoaded', init);

    return { showToast };
})();
