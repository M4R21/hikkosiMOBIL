/* ============================================
   app.js — スマホ用 薬品検索アプリ（軽量版）
   shared-data-mobile.json を読み込み、
   薬品名で検索 → 在庫有無＋出庫頻度を表示
   ============================================ */

const App = (() => {

    // ===== 設定 =====
    // ※後ほど新しいGitHubリポジトリのURLに変更する場合は、ここを書き換えてください。
    const GITHUB_REPO_URL = 'https://github.com/M4R21/hikkosiMOBIL';

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

    // ===== フィルター関連 =====
    let allStores = [];
    let selectedStores = new Set();
    let isFilterOpen = false;

    // ===== 複数検索タグ ＆ 表示モード =====
    let selectedSearchDrugs = [];
    let currentViewMode = 'normal'; // 'normal' または 'and'

    // ===== オートコンプリート =====
    let acActiveIdx = -1;

    // ===== 初期化 =====
    async function init() {
        // イベントバインド
        const input = document.getElementById('search-input');
        input.addEventListener('input', onAutocompleteInput);
        input.addEventListener('blur', () => setTimeout(hideAutocomplete, 200));

        // ＋（追加）ボタン
        const btnAdd = document.getElementById('btn-add-drug');
        if (btnAdd) {
            btnAdd.addEventListener('click', () => {
                addSearchDrugFromInput();
            });
        }

        // 入力欄のEnterキーで追加
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (acActiveIdx >= 0) {
                    const items = document.querySelectorAll('.autocomplete-item');
                    if (items[acActiveIdx]) {
                        addSearchDrug(items[acActiveIdx].dataset.value);
                    }
                } else {
                    addSearchDrugFromInput();
                }
            } else {
                onKeydown(e);
            }
        });

        // ドロップゾーン（データ未読み込み時）
        setupDropZone();

        // 店舗フィルターイベント
        const btnToggle = document.getElementById('btn-filter-toggle');
        if (btnToggle) btnToggle.addEventListener('click', toggleFilterPanel);

        const btnAll = document.getElementById('btn-store-all');
        if (btnAll) btnAll.addEventListener('click', selectAllStores);

        const btnClear = document.getElementById('btn-store-clear');
        if (btnClear) btnClear.addEventListener('click', clearAllStores);

        // 表示モード切り替えイベント
        const btnModeNormal = document.getElementById('btn-mode-normal');
        if (btnModeNormal) btnModeNormal.addEventListener('click', () => setViewMode('normal'));

        const btnModeAnd = document.getElementById('btn-mode-and');
        if (btnModeAnd) btnModeAnd.addEventListener('click', () => setViewMode('and'));

        // あいまい検索チェックボックス切り替えイベント
        const chkFuzzy = document.getElementById('chk-fuzzy-search');
        if (chkFuzzy) {
            chkFuzzy.addEventListener('change', () => {
                if (chkFuzzy.checked) {
                    // あいまい検索がONになったら、現在追加されているタグからメーカー名を除去
                    selectedSearchDrugs = selectedSearchDrugs.map(d => removeMakerName(d));
                    // 重複を除去
                    selectedSearchDrugs = Array.from(new Set(selectedSearchDrugs));
                    renderDrugTags();
                }
                doSearch();
            });
        }

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

        // ユニークな店舗名の動的抽出
        const storeSet = new Set();
        drugData.forEach(drug => {
            if (Array.isArray(drug.s)) {
                drug.s.forEach(s => {
                    if (s.sn) storeSet.add(s.sn);
                });
            }
        });
        allStores = Array.from(storeSet).sort((a, b) => a.localeCompare(b, 'ja'));
        
        // 選択店舗の初期化（全店舗）
        selectedStores = new Set(allStores);

        // フィルターコンテナの表示とチェックボックス生成
        const filterContainer = document.getElementById('filter-toggle-container');
        if (filterContainer && allStores.length > 0) {
            filterContainer.classList.remove('hidden');
            renderStoreFilter();
        }

        updateDataInfo();
    }

    function renderStoreFilter() {
        const container = document.getElementById('store-filter-list');
        if (!container) return;
        container.innerHTML = '';

        allStores.forEach(sn => {
            const label = document.createElement('label');
            label.className = 'store-filter-label';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = sn;
            cb.checked = selectedStores.has(sn);
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    selectedStores.add(sn);
                } else {
                    selectedStores.delete(sn);
                }
                updateFilterCount();
                // 検索欄に入力があれば再検索して反映
                if (selectedSearchDrugs.length > 0) {
                    doSearch();
                }
            });

            const span = document.createElement('span');
            span.textContent = sn;

            label.appendChild(cb);
            label.appendChild(span);
            container.appendChild(label);
        });

        updateFilterCount();
    }

    function updateFilterCount() {
        const countEl = document.getElementById('filter-count');
        if (!countEl) return;
        if (selectedStores.size === allStores.length) {
            countEl.textContent = '(全店舗)';
        } else {
            countEl.textContent = `(${selectedStores.size}/${allStores.length})`;
        }
    }

    function toggleFilterPanel() {
        const panel = document.getElementById('filter-panel');
        const btn = document.getElementById('btn-filter-toggle');
        if (!panel || !btn) return;
        isFilterOpen = !isFilterOpen;
        if (isFilterOpen) {
            panel.classList.remove('hidden');
            btn.classList.add('active');
        } else {
            panel.classList.add('hidden');
            btn.classList.remove('active');
        }
    }

    function selectAllStores() {
        allStores.forEach(sn => selectedStores.add(sn));
        document.querySelectorAll('#store-filter-list input[type="checkbox"]').forEach(cb => {
            cb.checked = true;
        });
        updateFilterCount();
        if (selectedSearchDrugs.length > 0) {
            doSearch();
        }
    }

    function clearAllStores() {
        selectedStores.clear();
        document.querySelectorAll('#store-filter-list input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
        updateFilterCount();
        if (selectedSearchDrugs.length > 0) {
            doSearch();
        }
    }

    // ===== 薬品タグ追加・削除管理 =====
    function addSearchDrugFromInput() {
        const input = document.getElementById('search-input');
        const term = input.value.trim();
        if (term) {
            const fuzzySearchChecked = document.getElementById('chk-fuzzy-search')?.checked ?? true;
            const finalName = fuzzySearchChecked ? removeMakerName(term) : term;
            addSearchDrug(finalName);
        }
    }

    function addSearchDrug(drugName) {
        if (!drugName) return;
        
        const fuzzySearchChecked = document.getElementById('chk-fuzzy-search')?.checked ?? true;
        const finalName = fuzzySearchChecked ? removeMakerName(drugName) : drugName;
        
        if (!selectedSearchDrugs.includes(finalName)) {
            selectedSearchDrugs.push(finalName);
            renderDrugTags();
            updateViewModeSelector();
            doSearch();
        }
        
        const input = document.getElementById('search-input');
        if (input) {
            input.value = '';
            input.focus();
        }
        hideAutocomplete();
    }

    function removeSearchDrug(drugName) {
        selectedSearchDrugs = selectedSearchDrugs.filter(d => d !== drugName);
        renderDrugTags();
        updateViewModeSelector();
        doSearch();
    }

    function renderDrugTags() {
        const container = document.getElementById('selected-drugs-container');
        if (!container) return;
        container.innerHTML = '';

        selectedSearchDrugs.forEach(name => {
            const tag = document.createElement('span');
            tag.className = 'drug-tag';

            const tagText = document.createElement('span');
            tagText.className = 'tag-text';
            tagText.textContent = name;

            const removeBtn = document.createElement('span');
            removeBtn.className = 'remove-tag';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeSearchDrug(name);
            });

            tag.appendChild(tagText);
            tag.appendChild(removeBtn);
            container.appendChild(tag);
        });
    }

    function updateViewModeSelector() {
        const selector = document.getElementById('view-mode-selector');
        if (!selector) return;

        if (selectedSearchDrugs.length >= 2) {
            selector.classList.remove('hidden');
        } else {
            selector.classList.add('hidden');
            setViewMode('normal');
        }
    }

    function setViewMode(mode) {
        currentViewMode = mode;
        
        const btnNormal = document.getElementById('btn-mode-normal');
        const btnAnd = document.getElementById('btn-mode-and');
        
        if (btnNormal && btnAnd) {
            if (mode === 'normal') {
                btnNormal.classList.add('active');
                btnAnd.classList.remove('active');
            } else {
                btnNormal.classList.remove('active');
                btnAnd.classList.add('active');
            }
        }
        
        if (selectedSearchDrugs.length > 0) {
            doSearch();
        }
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

    // ===== メーカー名「」の除去 =====
    function removeMakerName(name) {
        if (!name) return '';
        // 「」で囲まれたメーカー名と、その前後の空白（全角半角）を除去
        return name.replace(/[\s　]*「[^」]+」[\s　]*/g, '').trim();
    }

    // ===== 薬品名・検索語の正規化 =====
    function normalizeDrugName(name, removeMaker = false) {
        if (!name) return '';
        let res = name;

        if (removeMaker) {
            res = removeMakerName(res);
        }

        // 小文字化
        res = res.toLowerCase();

        // ひらがな→カタカナ
        res = hiraToKana(res);

        // 全角英数→半角英数
        res = res.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) =>
            String.fromCharCode(s.charCodeAt(0) - 0xfee0)
        );

        // 代表的な全角記号や特殊単位、スペース、ハイフンの表記揺れを統一
        res = res.replace(/　/g, ' ')
                 .replace(/㎎/g, 'mg')
                 .replace(/ℊ/g, 'g')
                 .replace(/㎖/g, 'ml')
                 .replace(/％/g, '%')
                 .replace(/μg/g, 'ug')
                 .replace(/㎍/g, 'ug')
                 .replace(/[-－‐—ー]/g, '-');

        return res.trim();
    }

    // ===== オートコンプリート =====
    async function onAutocompleteInput() {
        const input = document.getElementById('search-input');
        const term = input.value.trim();

        if (term.length < 2 || drugData.length === 0) {
            hideAutocomplete();
            return;
        }

        const fuzzySearchChecked = document.getElementById('chk-fuzzy-search')?.checked ?? true;
        const termNormalized = normalizeDrugName(term, fuzzySearchChecked);

        // 候補のベースとなる薬品名リスト
        let candidates = [];
        if (fuzzySearchChecked) {
            const uniqueNames = new Set();
            drugData.forEach(d => {
                const cleanName = removeMakerName(d.n);
                if (cleanName) uniqueNames.add(cleanName);
            });
            candidates = Array.from(uniqueNames);
        } else {
            candidates = drugNameIndex;
        }

        // 候補の絞り込み
        const matches = candidates
            .filter(name => normalizeDrugName(name, false).includes(termNormalized))
            .slice(0, 12);

        const list = document.getElementById('autocomplete-list');
        if (matches.length === 0) {
            hideAutocomplete();
            return;
        }

        acActiveIdx = -1;
        list.innerHTML = matches.map((name, i) => {
            let html;
            if (fuzzySearchChecked) {
                // あいまい検索ON時は簡易的な一致ハイライト
                const lowerName = name.toLowerCase();
                const lowerTerm = term.toLowerCase();
                const idx = lowerName.indexOf(lowerTerm);
                if (idx >= 0) {
                    html = escapeHtml(name.substring(0, idx))
                        + '<span class="ac-match">'
                        + escapeHtml(name.substring(idx, idx + term.length))
                        + '</span>'
                        + escapeHtml(name.substring(idx + term.length));
                } else {
                    html = escapeHtml(name);
                }
            } else {
                // あいまい検索OFF時は従来通りのかな一致ハイライト
                const termKana = hiraToKana(term.toLowerCase());
                const nameKana = hiraToKana(name.toLowerCase());
                const idx = nameKana.indexOf(termKana);
                if (idx >= 0) {
                    html = escapeHtml(name.substring(0, idx))
                        + '<span class="ac-match">'
                        + escapeHtml(name.substring(idx, idx + term.length))
                        + '</span>'
                        + escapeHtml(name.substring(idx + term.length));
                } else {
                    html = escapeHtml(name);
                }
            }
            return `<div class="autocomplete-item" data-index="${i}" data-value="${escapeHtml(name)}">${html}</div>`;
        }).join('');

        list.classList.remove('hidden');

        list.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                addSearchDrug(item.dataset.value);
            });
            item.addEventListener('touchstart', (e) => {
                e.preventDefault();
                addSearchDrug(item.dataset.value);
            }, { passive: false });
        });
    }

    function onKeydown(e) {
        const list = document.getElementById('autocomplete-list');
        if (list.classList.contains('hidden')) {
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
                addSearchDrug(items[acActiveIdx].dataset.value);
            }
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
        if (selectedSearchDrugs.length === 0) {
            document.getElementById('results-area').classList.add('hidden');
            document.getElementById('welcome-area').classList.remove('hidden');
            return;
        }

        if (drugData.length === 0) {
            showToast('データが読み込まれていません', 'error');
            return;
        }

        hideAutocomplete();

        const fuzzySearchChecked = document.getElementById('chk-fuzzy-search')?.checked ?? true;
        const normalizedKeywords = selectedSearchDrugs.map(k => normalizeDrugName(k, fuzzySearchChecked));

        const results = drugData.filter(d => {
            const normalizedDrug = normalizeDrugName(d.n, fuzzySearchChecked);
            return normalizedKeywords.some(k => normalizedDrug.includes(k));
        });

        if (currentViewMode === 'and' && selectedSearchDrugs.length >= 2) {
            renderStoreCentricResults(results);
        } else {
            renderNormalResults(results);
        }
    }

    // ===== 薬品別の結果描画 (通常モード) =====
    function renderNormalResults(results) {
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

            const filteredStores = drug.s.filter(s => selectedStores.has(s.sn));

            const inStockCount = filteredStores.filter(s => s.h).length;
            const totalStores = filteredStores.length;

            let badgeClass = 'has-none';
            if (totalStores === 0) badgeClass = 'has-none';
            else if (inStockCount > totalStores * 0.5) badgeClass = 'has-many';
            else if (inStockCount > 0) badgeClass = 'has-some';

            const sortedStores = [...filteredStores].sort((a, b) => {
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

    // ===== 同時保有店舗メインの結果描画 (ANDモード) =====
    function renderStoreCentricResults(results) {
        const container = document.getElementById('results-list');
        const countEl = document.getElementById('results-count');
        const resultsArea = document.getElementById('results-area');
        const welcomeArea = document.getElementById('welcome-area');

        container.innerHTML = '';
        welcomeArea.classList.add('hidden');
        resultsArea.classList.remove('hidden');

        // タグで登録されている各検索キーワード
        const fuzzySearchChecked = document.getElementById('chk-fuzzy-search')?.checked ?? true;
        const normalizedKeywords = selectedSearchDrugs.map(k => normalizeDrugName(k, fuzzySearchChecked));
        
        // 選択されている店舗の中で、すべてのキーワードに合致する薬品の在庫がある店舗を抽出
        const andStores = [];

        selectedStores.forEach(storeName => {
            const hasAllKeywords = normalizedKeywords.every(k => {
                return results.some(drug => {
                    const normalizedDrug = normalizeDrugName(drug.n, fuzzySearchChecked);
                    if (!normalizedDrug.includes(k)) return false;
                    
                    const storeStatus = drug.s.find(s => s.sn === storeName);
                    return storeStatus && storeStatus.h;
                });
            });

            if (hasAllKeywords) {
                // その店舗が「すべてを保有」している場合の詳細情報（店舗における各薬の在庫状況と頻度）を構築
                const drugDetails = [];
                selectedSearchDrugs.forEach(keyword => {
                    const kwNormalized = normalizeDrugName(keyword, fuzzySearchChecked);
                    const matchedDrugsInStore = results.filter(drug => {
                        const normalizedDrug = normalizeDrugName(drug.n, fuzzySearchChecked);
                        if (!normalizedDrug.includes(kwNormalized)) return false;
                        const storeStatus = drug.s.find(s => s.sn === storeName);
                        return storeStatus && storeStatus.h;
                    });

                    matchedDrugsInStore.forEach(drug => {
                        const storeStatus = drug.s.find(s => s.sn === storeName);
                        drugDetails.push({
                            drugName: drug.n,
                            freq: storeStatus ? storeStatus.f : '／'
                        });
                    });
                });

                andStores.push({
                    storeName,
                    drugs: drugDetails
                });
            }
        });

        // 表示件数を設定
        countEl.textContent = `📋 同時保有している店舗: ${andStores.length}店舗`;

        if (andStores.length === 0) {
            container.innerHTML = `
                <div class="empty-results">
                    <div class="empty-icon">🤝</div>
                    <p>選択したすべての薬品を同時に保有している店舗はありません</p>
                </div>
            `;
            return;
        }

        // 店舗ごとにカードを描画
        andStores.forEach(store => {
            const card = document.createElement('div');
            card.className = 'store-centric-card';

            const drugRows = store.drugs.map(d => {
                const freqClass = getFreqClass(d.freq);
                return `
                    <div class="store-centric-drug-row">
                        <span class="store-centric-drug-name">${escapeHtml(d.drugName)}</span>
                        <span class="store-stock-badge in-stock">在庫あり</span>
                        <span class="store-freq ${freqClass}">${escapeHtml(d.freq)}</span>
                    </div>
                `;
            }).join('');

            card.innerHTML = `
                <div class="store-centric-header">
                    <span class="store-centric-name">🏢 ${escapeHtml(store.storeName)}</span>
                    <span class="store-centric-badge">揃います</span>
                </div>
                <div class="store-centric-body">
                    ${drugRows}
                </div>
            `;

            container.appendChild(card);
        });

        if (andStores.length > 0) {
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
