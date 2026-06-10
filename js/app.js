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
    let minMatchCount = 0; // 0 = 全品目一致（デフォルト）
    let isMinMatchUserSelected = false; // ユーザーが手動で最低一致数を選んだかどうかのフラグ

    // ===== 処方日数計算用データ =====
    let calcCalendarDate = new Date();

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

        // 最低一致数セレクター変更イベント
        const minMatchSelect = document.getElementById('min-match-count');
        if (minMatchSelect) {
            minMatchSelect.addEventListener('change', () => {
                minMatchCount = parseInt(minMatchSelect.value, 10) || 0;
                isMinMatchUserSelected = true;
                doSearch();
            });
        }

        // あいまい検索チェックボックス切り替えイベント
        const chkFuzzy = document.getElementById('chk-fuzzy-search');
        if (chkFuzzy) {
            chkFuzzy.addEventListener('change', () => {
                isMinMatchUserSelected = false;
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

        // モーダルの閉じるイベント
        const modal = document.getElementById('drug-detail-modal');
        const modalClose = document.getElementById('modal-close-btn');
        const modalOverlay = document.getElementById('modal-overlay');
        if (modal && modalClose && modalOverlay) {
            const closeModal = () => modal.classList.add('hidden');
            modalClose.addEventListener('click', closeModal);
            modalOverlay.addEventListener('click', closeModal);
        }

        // 不足薬品タップ時のイベント委譲
        const resultsList = document.getElementById('results-list');
        if (resultsList) {
            resultsList.addEventListener('click', (e) => {
                const missingRow = e.target.closest('.store-centric-drug-row.missing');
                if (missingRow) {
                    const drugName = missingRow.dataset.drugName;
                    if (drugName) {
                        showDrugDetailModal(drugName);
                    }
                }
            });
        }

        // 画面切り替えイベント
        const btnToggleView = document.getElementById('btn-toggle-view');
        const btnCalcBack = document.getElementById('btn-calc-back');
        const searchView = document.getElementById('search-view');
        const calcView = document.getElementById('calc-view');

        if (btnToggleView && btnCalcBack && searchView && calcView) {
            const toggleView = () => {
                const isSearchHidden = searchView.classList.toggle('hidden');
                calcView.classList.toggle('hidden');
                
                if (isSearchHidden) {
                    btnToggleView.textContent = '🔍 在庫検索';
                    initCalc();
                } else {
                    btnToggleView.textContent = '🧮 処方計算';
                }
            };
            btnToggleView.addEventListener('click', toggleView);
            btnCalcBack.addEventListener('click', toggleView);
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
                isMinMatchUserSelected = false;
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
        isMinMatchUserSelected = false;
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
        isMinMatchUserSelected = false;
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
            isMinMatchUserSelected = false;
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
        isMinMatchUserSelected = false;
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
            updateMinMatchSelector();
        } else {
            selector.classList.add('hidden');
            const minMatchEl = document.getElementById('min-match-selector');
            if (minMatchEl) minMatchEl.classList.add('hidden');
            setViewMode('normal');
        }
    }

    function calculateMaxMatchedCount() {
        if (drugData.length === 0 || selectedSearchDrugs.length < 2) return 0;

        const fuzzySearchChecked = document.getElementById('chk-fuzzy-search')?.checked ?? true;
        const normalizedKeywords = selectedSearchDrugs.map(k => normalizeDrugName(k, fuzzySearchChecked));

        // 検索タグに一致する薬品データを抽出
        const matchedDrugs = drugData.filter(d => {
            const normalizedDrug = normalizeDrugName(d.n, fuzzySearchChecked);
            return normalizedKeywords.some(k => normalizedDrug.includes(k));
        });

        let maxCount = 0;

        selectedStores.forEach(storeName => {
            let matchedCount = 0;
            selectedSearchDrugs.forEach((keyword, idx) => {
                const kwNormalized = normalizedKeywords[idx];
                const hasStock = matchedDrugs.some(drug => {
                    const normalizedDrug = normalizeDrugName(drug.n, fuzzySearchChecked);
                    if (!normalizedDrug.includes(kwNormalized)) return false;
                    const storeStatus = drug.s.find(s => s.sn === storeName);
                    return storeStatus && storeStatus.h;
                });
                if (hasStock) {
                    matchedCount++;
                }
            });
            if (matchedCount > maxCount) {
                maxCount = matchedCount;
            }
        });

        return maxCount;
    }

    function updateMinMatchSelector() {
        const select = document.getElementById('min-match-count');
        const container = document.getElementById('min-match-selector');
        if (!select || !container) return;

        const total = selectedSearchDrugs.length;
        select.innerHTML = '';

        // 「全品目」オプション
        const optAll = document.createElement('option');
        optAll.value = '0';
        optAll.textContent = `全(${total})`;
        select.appendChild(optAll);

        // N品目〜2品目までのオプションを降順で生成
        for (let i = total - 1; i >= 2; i--) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = String(i);
            select.appendChild(opt);
        }

        // ユーザーの手動変更がない場合、自動最適化を行う
        if (!isMinMatchUserSelected && total >= 2) {
            const maxMatched = calculateMaxMatchedCount();
            if (maxMatched < total && maxMatched >= 2) {
                minMatchCount = maxMatched;
            } else {
                minMatchCount = 0; // 全品目一致
            }
        }

        // 現在の値を維持、範囲外なら「全品目」にリセット
        if (minMatchCount > 0 && minMatchCount <= total) {
            select.value = String(minMatchCount);
        } else {
            select.value = '0';
            minMatchCount = 0;
        }

        // 同時保有モード中かつ3薬品以上のときだけ表示
        if (currentViewMode === 'and' && total >= 3) {
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
    }

    function setViewMode(mode) {
        currentViewMode = mode;
        isMinMatchUserSelected = false;
        
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

        // 最低一致数セレクターの表示制御
        updateMinMatchSelector();
        
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

            let touchStartY = 0;
            let hasMoved = false;

            item.addEventListener('touchstart', (e) => {
                touchStartY = e.touches[0].clientY;
                hasMoved = false;
            }, { passive: true });

            item.addEventListener('touchmove', (e) => {
                const currentY = e.touches[0].clientY;
                if (Math.abs(currentY - touchStartY) > 8) {
                    hasMoved = true;
                }
            }, { passive: true });

            item.addEventListener('touchend', (e) => {
                if (!hasMoved) {
                    e.preventDefault();
                    addSearchDrug(item.dataset.value);
                }
            });
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
        const totalKeywords = normalizedKeywords.length;

        // 最低一致数の決定（0 = 全品目一致）
        const requiredCount = (minMatchCount > 0 && minMatchCount <= totalKeywords)
            ? minMatchCount
            : totalKeywords;

        // 各店舗のキーワードごとの保有状況を判定
        const storeResults = [];

        selectedStores.forEach(storeName => {
            let matchedCount = 0;
            const drugDetails = [];
            const missingKeywords = [];

            selectedSearchDrugs.forEach((keyword, idx) => {
                const kwNormalized = normalizedKeywords[idx];
                const matchedDrugsInStore = results.filter(drug => {
                    const normalizedDrug = normalizeDrugName(drug.n, fuzzySearchChecked);
                    if (!normalizedDrug.includes(kwNormalized)) return false;
                    const storeStatus = drug.s.find(s => s.sn === storeName);
                    return storeStatus && storeStatus.h;
                });

                if (matchedDrugsInStore.length > 0) {
                    matchedCount++;
                    matchedDrugsInStore.forEach(drug => {
                        const storeStatus = drug.s.find(s => s.sn === storeName);
                        drugDetails.push({
                            drugName: drug.n,
                            freq: storeStatus ? storeStatus.f : '／',
                            hasStock: true
                        });
                    });
                } else {
                    missingKeywords.push(keyword);
                }
            });

            if (matchedCount >= requiredCount) {
                storeResults.push({
                    storeName,
                    drugs: drugDetails,
                    missingKeywords,
                    matchedCount,
                    totalKeywords
                });
            }
        });

        // 一致数が多い順に並べ替え
        storeResults.sort((a, b) => b.matchedCount - a.matchedCount);

        // 表示件数を設定
        if (requiredCount === totalKeywords) {
            countEl.textContent = `📋 全${totalKeywords}品目を保有: ${storeResults.length}店舗`;
        } else {
            countEl.textContent = `📋 ${requiredCount}品目以上を保有: ${storeResults.length}店舗`;
        }

        if (storeResults.length === 0) {
            const msg = requiredCount === totalKeywords
                ? '選択したすべての薬品を同時に保有している店舗はありません'
                : `${requiredCount}品目以上を保有している店舗はありません`;
            container.innerHTML = `
                <div class="empty-results">
                    <div class="empty-icon">🤝</div>
                    <p>${msg}</p>
                </div>
            `;
            return;
        }

        // 店舗ごとにカードを描画
        storeResults.forEach(store => {
            const card = document.createElement('div');
            card.className = 'store-centric-card';

            const isFullMatch = store.matchedCount === store.totalKeywords;

            // 保有薬品の行
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

            // 不足薬品の行（部分一致の場合のみ表示）
            const missingRows = store.missingKeywords.map(kw => {
                return `
                    <div class="store-centric-drug-row missing" data-drug-name="${escapeHtml(kw)}">
                        <span class="store-centric-drug-name">${escapeHtml(kw)}</span>
                        <span class="store-stock-badge out-stock-small">在庫なし 🔎</span>
                        <span class="store-freq freq-none">—</span>
                    </div>
                `;
            }).join('');

            const badgeClass = isFullMatch ? 'full' : 'partial';
            const badgeText = isFullMatch
                ? '全て揃います'
                : `${store.matchedCount}/${store.totalKeywords} 品目`;

            card.innerHTML = `
                <div class="store-centric-header">
                    <span class="store-centric-name">🏢 ${escapeHtml(store.storeName)}</span>
                    <span class="store-centric-badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="store-centric-body">
                    ${drugRows}
                    ${missingRows}
                </div>
            `;

            container.appendChild(card);
        });

        if (storeResults.length > 0) {
            resultsArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function showDrugDetailModal(keyword) {
        const modal = document.getElementById('drug-detail-modal');
        const modalTitle = document.getElementById('modal-drug-name');
        const modalBody = document.getElementById('modal-store-list');
        if (!modal || !modalTitle || !modalBody) return;

        modalTitle.textContent = `「${keyword}」の在庫あり店舗`;
        modalBody.innerHTML = '';

        const fuzzySearchChecked = document.getElementById('chk-fuzzy-search')?.checked ?? true;
        const normalizedKeyword = normalizeDrugName(keyword, fuzzySearchChecked);

        // 部分一致するすべての薬を抽出
        const matchedDrugs = drugData.filter(d => {
            const normalizedDrug = normalizeDrugName(d.n, fuzzySearchChecked);
            return normalizedDrug.includes(normalizedKeyword);
        });

        if (matchedDrugs.length === 0) {
            modalBody.innerHTML = '<div class="empty-results"><p>該当する薬品が見つかりませんでした</p></div>';
            modal.classList.remove('hidden');
            return;
        }

        // 店舗ごとの在庫情報を集計
        const storeStockMap = new Map(); // storeName => [{ drugName, freq }]

        matchedDrugs.forEach(drug => {
            drug.s.forEach(s => {
                if (s.h && selectedStores.has(s.sn)) {
                    if (!storeStockMap.has(s.sn)) {
                        storeStockMap.set(s.sn, []);
                    }
                    storeStockMap.get(s.sn).push({
                        drugName: drug.n,
                        freq: s.f
                    });
                }
            });
        });

        if (storeStockMap.size === 0) {
            modalBody.innerHTML = '<div class="empty-results"><p>選択された店舗の中に在庫ありの店舗はありません</p></div>';
            modal.classList.remove('hidden');
            return;
        }

        // 店舗名の五十音順などでソート
        const sortedStores = Array.from(storeStockMap.keys()).sort((a, b) => a.localeCompare(b, 'ja'));

        const rowsHtml = sortedStores.map(storeName => {
            const drugs = storeStockMap.get(storeName);
            
            const drugsHtml = drugs.map(d => {
                const freqClass = getFreqClass(d.freq);
                return `
                    <div class="modal-drug-item">
                        <span class="modal-drug-item-name">${escapeHtml(d.drugName)}</span>
                        <span class="store-freq ${freqClass}">${escapeHtml(d.freq)}</span>
                    </div>
                `;
            }).join('');

            return `
                <div class="modal-store-row">
                    <span class="modal-store-name">🏢 ${escapeHtml(storeName)}</span>
                    <div class="modal-store-drugs">
                        ${drugsHtml}
                    </div>
                </div>
            `;
        }).join('');

        modalBody.innerHTML = rowsHtml;
        modal.classList.remove('hidden');
    }

    function getFreqClass(freq) {
        if (freq === '◎') return 'freq-excellent';
        if (freq === '〇' || freq === '○') return 'freq-good';
        if (freq === '△') return 'freq-low';
        return 'freq-none';
    }

    // ===== 処方日数計算機能ロジック =====
    let isCalcInitialized = false;

    function initCalc() {
        if (isCalcInitialized) return;
        isCalcInitialized = true;

        const startDateInput = document.getElementById('calc-startDate');
        const nextVisitDateInput = document.getElementById('calc-nextVisitDate');
        const excludeEndDayCheckbox = document.getElementById('calc-excludeEndDay');
        const prescriptionDaysInput = document.getElementById('calc-prescriptionDays');
        const medicationsContainer = document.getElementById('calc-medicationsContainer');
        const addMedBtn = document.getElementById('calc-addMedBtn');
        const prevMonthBtn = document.getElementById('calc-prevMonth');
        const nextMonthBtn = document.getElementById('calc-nextMonth');
        const resetBtn = document.getElementById('calc-resetBtn');

        if (!startDateInput) return;

        // デフォルト値設定
        setCalcDefaults();

        // イベント登録
        [startDateInput, nextVisitDateInput].forEach(el => {
            el.addEventListener('input', () => calculateCalcAll('date'));
            el.addEventListener('click', function() {
                if (this.type === 'text') this.type = 'date';
                if (typeof this.showPicker === 'function') {
                    try { this.showPicker(); } catch(err) {}
                }
            });
        });

        if (excludeEndDayCheckbox) {
            excludeEndDayCheckbox.addEventListener('change', () => {
                calculateCalcAll(nextVisitDateInput.value ? 'date' : 'days');
            });
        }

        prescriptionDaysInput.addEventListener('input', () => calculateCalcAll('days'));
        resetBtn.addEventListener('click', setCalcDefaults);

        medicationsContainer.addEventListener('input', (e) => {
            if (e.target.classList.contains('calc-leftover-input') || e.target.classList.contains('calc-dosage-input')) {
                calculateCalcAll(nextVisitDateInput.value ? 'date' : 'days');
            }
        });

        addMedBtn.addEventListener('click', () => {
            const items = medicationsContainer.querySelectorAll('.calc-medication-item');
            if (items.length === 0) return;
            const newItem = items[0].cloneNode(true);
            newItem.querySelector('.calc-med-name').value = '';
            newItem.querySelector('.calc-leftover-input').value = 0;
            newItem.querySelector('.calc-dosage-input').value = 1;
            newItem.querySelector('.calc-lock-leftover').checked = false;
            newItem.querySelector('.calc-lock-dosage').checked = false;

            medicationsContainer.appendChild(newItem);
            updateCalcMedicationLabels();
            calculateCalcAll(nextVisitDateInput.value ? 'date' : 'days');
        });

        medicationsContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('calc-remove-med-btn')) {
                const items = medicationsContainer.querySelectorAll('.calc-medication-item');
                if (items.length > 1) {
                    e.target.closest('.calc-medication-item').remove();
                    updateCalcMedicationLabels();
                    calculateCalcAll(nextVisitDateInput.value ? 'date' : 'days');
                }
            }
        });

        if (prevMonthBtn) {
            prevMonthBtn.addEventListener('click', () => {
                calcCalendarDate.setMonth(calcCalendarDate.getMonth() - 1);
                renderCalcCalendar();
            });
        }
        if (nextMonthBtn) {
            nextMonthBtn.addEventListener('click', () => {
                calcCalendarDate.setMonth(calcCalendarDate.getMonth() + 1);
                renderCalcCalendar();
            });
        }
    }

    function setCalcDefaults() {
        const startDateInput = document.getElementById('calc-startDate');
        const nextVisitDateInput = document.getElementById('calc-nextVisitDate');
        const excludeEndDayCheckbox = document.getElementById('calc-excludeEndDay');
        const prescriptionDaysInput = document.getElementById('calc-prescriptionDays');
        const medicationsContainer = document.getElementById('calc-medicationsContainer');
        const endDateDisplay = document.getElementById('calc-endDate');

        if (!startDateInput) return;

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        startDateInput.valueAsDate = tomorrow;

        const lockNextVisit = document.getElementById('calc-lockNextVisit');
        if (!lockNextVisit || !lockNextVisit.checked) {
            nextVisitDateInput.value = '';
            if (nextVisitDateInput.type === 'date') {
                nextVisitDateInput.type = 'text';
            }
        }

        prescriptionDaysInput.value = 0;
        endDateDisplay.textContent = '--/--';
        if (excludeEndDayCheckbox) excludeEndDayCheckbox.checked = false;

        const items = medicationsContainer.querySelectorAll('.calc-medication-item');
        for (let i = 1; i < items.length; i++) items[i].remove();

        const firstItem = items[0];
        firstItem.querySelector('.calc-med-name').value = '';
        if (!firstItem.querySelector('.calc-lock-leftover').checked) {
            firstItem.querySelector('.calc-leftover-input').value = 0;
        }
        if (!firstItem.querySelector('.calc-lock-dosage').checked) {
            firstItem.querySelector('.calc-dosage-input').value = 1;
        }
        updateCalcMedicationLabels();

        calcCalendarDate = new Date();
        calculateCalcAll('date');
    }

    function updateCalcMedicationLabels() {
        const medicationsContainer = document.getElementById('calc-medicationsContainer');
        if (!medicationsContainer) return;
        const items = medicationsContainer.querySelectorAll('.calc-medication-item');
        items.forEach((item, index) => {
            item.querySelector('.calc-med-number').textContent = (index + 1) + '.';
            const removeBtn = item.querySelector('.calc-remove-med-btn');
            if (items.length > 1) {
                removeBtn.style.display = 'inline-block';
            } else {
                removeBtn.style.display = 'none';
            }
        });
    }

    function setCalcText(el, val, skipUnit = false) {
        if (!el) return;
        if (skipUnit || isNaN(val)) {
            el.innerHTML = val;
        } else {
            el.innerHTML = `${val}<span class="calc-r-unit">日</span>`;
        }
    }

    function formatCalcDate(d) {
        if (!d) return '--/--';
        const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
        return `${d.getMonth() + 1}/${d.getDate()} (${w})`;
    }

    function normCalcDate(d) {
        if (!d) return null;
        const x = new Date(d);
        x.setHours(0, 0, 0, 0);
        return x;
    }

    function calculateCalcAll(mode = 'date') {
        const startDateInput = document.getElementById('calc-startDate');
        const nextVisitDateInput = document.getElementById('calc-nextVisitDate');
        const excludeEndDayCheckbox = document.getElementById('calc-excludeEndDay');
        const prescriptionDaysInput = document.getElementById('calc-prescriptionDays');
        const daysUntilVisitDisplay = document.getElementById('calc-daysUntilVisit');
        const daysCoveredDisplay = document.getElementById('calc-daysCovered');
        const endDateDisplay = document.getElementById('calc-endDate');
        const medicationsContainer = document.getElementById('calc-medicationsContainer');
        const mainResultSection = document.getElementById('calc-mainResultSection');
        const multiMedNotice = document.getElementById('calc-multiMedNotice');
        const calendarSection = document.getElementById('calc-calendarSection');

        if (!startDateInput || !prescriptionDaysInput || !medicationsContainer) return;

        const startDateRaw = startDateInput.value;
        if (!startDateRaw) return;
        const startDate = normCalcDate(startDateRaw);

        const excludeEndDay = excludeEndDayCheckbox ? excludeEndDayCheckbox.checked : false;
        const items = medicationsContainer.querySelectorAll('.calc-medication-item');
        const isMulti = items.length > 1;

        if (isMulti) {
            if (multiMedNotice) multiMedNotice.style.display = 'block';
            if (calendarSection) calendarSection.style.display = 'none';
            if (mainResultSection) mainResultSection.style.display = 'none';
        } else {
            if (multiMedNotice) multiMedNotice.style.display = 'none';
            if (calendarSection) calendarSection.style.display = 'block';
            if (mainResultSection) mainResultSection.style.display = 'block';
        }

        let daysDiffUntilVisit = 0;

        if (mode === 'date') {
            const nextVisitDateRaw = nextVisitDateInput.value;
            if (nextVisitDateRaw) {
                const nextVisitDate = normCalcDate(nextVisitDateRaw);
                if (nextVisitDate <= startDate) {
                    daysDiffUntilVisit = 0;
                    prescriptionDaysInput.value = 0;
                    if (!isMulti && endDateDisplay) endDateDisplay.textContent = '--/--';
                } else {
                    const timeDiff = nextVisitDate - startDate;
                    const baseDaysDiff = Math.ceil(timeDiff / 864e5);
                    daysDiffUntilVisit = excludeEndDay ? baseDaysDiff : baseDaysDiff + 1;
                }
            } else {
                setCalcText(daysUntilVisitDisplay, '-', true);
            }
        } else {
            const firstItem = items[0];
            const leftover = parseInt(firstItem.querySelector('.calc-leftover-input').value) || 0;
            const dosage = parseInt(firstItem.querySelector('.calc-dosage-input').value) || 1;
            const daysCovered = Math.floor(leftover / dosage);
            const prescriptionDaysGlobal = parseInt(prescriptionDaysInput.value) || 0;

            const totalDuration = daysCovered + prescriptionDaysGlobal;
            if (totalDuration > 0) {
                daysDiffUntilVisit = totalDuration;

                const nextVisit = new Date(startDate);
                if (excludeEndDay) {
                    nextVisit.setDate(nextVisit.getDate() + totalDuration);
                } else {
                    nextVisit.setDate(nextVisit.getDate() + totalDuration - 1);
                }
                nextVisitDateInput.valueAsDate = nextVisit;
            } else {
                daysDiffUntilVisit = 0;
                if (endDateDisplay) endDateDisplay.textContent = '--/--';
            }
        }

        if (nextVisitDateInput.value || mode === 'days') {
            setCalcText(daysUntilVisitDisplay, daysDiffUntilVisit);
        }

        items.forEach((item, index) => {
            const leftover = parseInt(item.querySelector('.calc-leftover-input').value) || 0;
            const dosage = parseInt(item.querySelector('.calc-dosage-input').value) || 1;
            const daysCovered = Math.floor(leftover / dosage);

            item.querySelector('.calc-med-covered-days').textContent = daysCovered;

            let targetPrescriptionDays = 0;
            if (daysDiffUntilVisit > 0) {
                targetPrescriptionDays = daysDiffUntilVisit - daysCovered;
                if (targetPrescriptionDays < 0) targetPrescriptionDays = 0;
            }

            item.querySelector('.calc-med-prescription-days').textContent = targetPrescriptionDays;

            if (index === 0) {
                if (!isMulti) setCalcText(daysCoveredDisplay, daysCovered);

                if (mode === 'date' && nextVisitDateInput.value) {
                    prescriptionDaysInput.value = targetPrescriptionDays;
                }

                const totalDays = daysCovered + (parseInt(prescriptionDaysInput.value) || targetPrescriptionDays);
                const endDate = new Date(startDate);
                endDate.setDate(endDate.getDate() + totalDays - 1);

                if (!isMulti && endDateDisplay) {
                    if (totalDays > 0) {
                        endDateDisplay.textContent = formatCalcDate(endDate);
                    } else {
                        endDateDisplay.textContent = '--/--';
                    }
                }
            }
        });

        if (!isMulti) {
            renderCalcCalendar();
        }
    }

    function renderCalcCalendar() {
        const calendarSection = document.getElementById('calc-calendarSection');
        const calendarGrid = document.getElementById('calc-calendarGrid');
        const currentMonthYearDisplay = document.getElementById('calc-currentMonthYear');
        const startDateInput = document.getElementById('calc-startDate');
        const nextVisitDateInput = document.getElementById('calc-nextVisitDate');
        const medicationsContainer = document.getElementById('calc-medicationsContainer');

        if (!calendarSection || !calendarGrid || !currentMonthYearDisplay) return;
        if (calendarSection.style.display === 'none') return;

        calendarGrid.innerHTML = '';
        const year = calcCalendarDate.getFullYear();
        const month = calcCalendarDate.getMonth();
        currentMonthYearDisplay.textContent = `${year}年 ${month + 1}月`;

        ['日', '月', '火', '水', '木', '金', '土'].forEach(d => {
            const el = document.createElement('div');
            el.className = 'calc-cal-head';
            el.textContent = d;
            calendarGrid.appendChild(el);
        });

        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        for (let i = 0; i < firstDay; i++) {
            const el = document.createElement('div');
            el.className = 'calc-cal-day';
            calendarGrid.appendChild(el);
        }

        const startDate = startDateInput.value ? normCalcDate(startDateInput.value) : null;
        const nextVisitDate = nextVisitDateInput.value ? normCalcDate(nextVisitDateInput.value) : null;

        const firstItem = medicationsContainer.querySelector('.calc-medication-item');
        let daysCovered = 0;
        if (firstItem) {
            const leftover = parseInt(firstItem.querySelector('.calc-leftover-input').value) || 0;
            const dosage = parseInt(firstItem.querySelector('.calc-dosage-input').value) || 1;
            daysCovered = Math.floor(leftover / dosage);
        }

        const today = normCalcDate(new Date());

        for (let d = 1; d <= daysInMonth; d++) {
            const el = document.createElement('div');
            el.className = 'calc-cal-day';
            el.textContent = d;
            const thisDate = new Date(year, month, d);

            if (thisDate.getTime() === today.getTime()) el.classList.add('today');

            if (startDate && nextVisitDate) {
                const offset = Math.ceil((thisDate - startDate) / 864e5);
                if (thisDate.getTime() === nextVisitDate.getTime()) {
                    el.classList.add('visit-date');
                } else if (thisDate.getTime() === startDate.getTime()) {
                    el.classList.add('start-date');
                } else if (thisDate > startDate && thisDate < nextVisitDate) {
                    el.classList.add(offset >= 0 && offset < daysCovered ? 'covered' : 'prescription');
                }
            } else if (startDate && !nextVisitDate) {
                if (thisDate.getTime() === startDate.getTime()) {
                    el.classList.add('start-date');
                } else if (thisDate > startDate) {
                    const offset = Math.floor((thisDate - startDate) / 864e5);
                    if (offset < daysCovered) el.classList.add('covered');
                }
            }
            calendarGrid.appendChild(el);
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
