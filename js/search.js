/* ============================================
   search.js — 薬品検索モジュール
   在宅往診同行中にスマホから全店舗の在庫を
   素早く検索するための機能
   ============================================ */

const DrugSearch = (() => {

    let allStores = [];
    let selectedStoreIndices = new Set(); // 空 = 全店舗表示
    let searchResults = [];
    let acDrugCache = null;
    let acActiveIdx = -1;
    let isFilterOpen = false;

    // ===== 初期化 =====
    async function init() {
        // 戻るボタン
        document.getElementById('search-back').addEventListener('click', () => App.navigateTo('home'));

        // 検索ボタン
        document.getElementById('btn-drug-search').addEventListener('click', doSearch);

        // 入力欄のEnterキー
        const input = document.getElementById('drug-search-input');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && acActiveIdx < 0) {
                e.preventDefault();
                doSearch();
            }
            onAutocompleteKeydown(e);
        });
        input.addEventListener('input', onAutocompleteInput);
        input.addEventListener('blur', () => setTimeout(hideAutocomplete, 200));

        // 店舗フィルタトグル
        document.getElementById('btn-search-filter-toggle').addEventListener('click', toggleFilter);

        // 全選択 / 全解除
        document.getElementById('btn-search-store-all').addEventListener('click', () => {
            document.querySelectorAll('.search-store-checkbox').forEach(cb => cb.checked = true);
            updateSelectedStores();
        });
        document.getElementById('btn-search-store-clear').addEventListener('click', () => {
            document.querySelectorAll('.search-store-checkbox').forEach(cb => cb.checked = false);
            updateSelectedStores();
        });
    }

    // ===== 画面表示時 =====
    async function onShow() {
        // 店舗一覧を読み込み
        allStores = await DB.getActiveStores();
        allStores.sort((a, b) => a.storeName.localeCompare(b.storeName, 'ja'));
        selectedStoreIndices = new Set(); // 全店舗

        // 検索欄リセット
        document.getElementById('drug-search-input').value = '';
        document.getElementById('search-results-area').classList.add('hidden');
        document.getElementById('search-filter-panel').classList.add('hidden');
        isFilterOpen = false;
        acDrugCache = null;

        // 店舗チェックボックス生成
        renderStoreFilter();

        // 自動フォーカス
        setTimeout(() => document.getElementById('drug-search-input').focus(), 300);
    }

    // ===== 店舗フィルタ描画 =====
    function renderStoreFilter() {
        const container = document.getElementById('search-store-list');
        container.innerHTML = '';

        allStores.forEach(s => {
            const label = document.createElement('label');
            label.className = 'search-store-label';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'search-store-checkbox';
            cb.value = s.storeIndex;
            cb.checked = true; // デフォルトで全選択
            cb.addEventListener('change', updateSelectedStores);

            const span = document.createElement('span');
            span.textContent = s.storeName;

            label.appendChild(cb);
            label.appendChild(span);
            container.appendChild(label);
        });
    }

    function updateSelectedStores() {
        const checked = document.querySelectorAll('.search-store-checkbox:checked');
        const total = document.querySelectorAll('.search-store-checkbox');

        if (checked.length === total.length || checked.length === 0) {
            // 全選択 or 全解除 → 全店舗表示
            selectedStoreIndices = new Set();
        } else {
            selectedStoreIndices = new Set(Array.from(checked).map(cb => parseInt(cb.value)));
        }

        // フィルタバッジ更新
        const badge = document.getElementById('search-filter-badge');
        if (selectedStoreIndices.size > 0) {
            badge.textContent = selectedStoreIndices.size;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }

        // 検索結果がある場合は再描画
        if (searchResults.length > 0) {
            renderResults();
        }
    }

    function toggleFilter() {
        const panel = document.getElementById('search-filter-panel');
        isFilterOpen = !isFilterOpen;
        if (isFilterOpen) {
            panel.classList.remove('hidden');
        } else {
            panel.classList.add('hidden');
        }
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

    function hiraToKana(str) {
        return str.replace(/[\u3041-\u3096]/g, function (match) {
            return String.fromCharCode(match.charCodeAt(0) + 0x60);
        });
    }

    async function onAutocompleteInput() {
        const input = document.getElementById('drug-search-input');
        const term = input.value.trim();
        if (term.length < 2) {
            hideAutocomplete();
            return;
        }

        const drugNames = await getDrugNameCache();
        const termKana = hiraToKana(term.toLowerCase());
        const matches = drugNames.filter(n => hiraToKana(n.toLowerCase()).includes(termKana)).slice(0, 15);

        const list = document.getElementById('drug-search-autocomplete');
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
        });
    }

    function onAutocompleteKeydown(e) {
        const list = document.getElementById('drug-search-autocomplete');
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
            const input = document.getElementById('drug-search-input');
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
        const list = document.getElementById('drug-search-autocomplete');
        if (list) {
            list.classList.add('hidden');
            list.innerHTML = '';
        }
        acActiveIdx = -1;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ===== 検索実行 =====
    async function doSearch() {
        const input = document.getElementById('drug-search-input').value.trim();
        if (!input) {
            App.showToast('薬品名を入力してください', 'warning');
            return;
        }

        // 入力を正規化（ひらがな→カタカナ、全角半角統一）
        const termKana = hiraToKana(input.toLowerCase());

        try {
            const allInventory = await DB.getAll('inventory');
            if (!allInventory || allInventory.length === 0) {
                App.showToast('在庫データが登録されていません', 'error');
                return;
            }

            // 店舗名マップ
            const storeMap = {};
            allStores.forEach(s => { storeMap[s.storeIndex] = s.storeName; });

            // 薬品名でフィルタ → 店舗ごとに集計
            const resultMap = new Map(); // drugName → { stores: Map<storeIndex, {storeName, stockQty, shipFreq}> }

            for (const rec of allInventory) {
                if (!rec.drugName) continue;

                // 薬品名の部分一致チェック
                const recNameKana = hiraToKana(rec.drugName.toLowerCase());
                if (!recNameKana.includes(termKana)) continue;

                // 店舗フィルタ
                if (selectedStoreIndices.size > 0 && !selectedStoreIndices.has(rec.storeIndex)) continue;

                // アクティブ店舗チェック
                if (!storeMap[rec.storeIndex]) continue;

                if (!resultMap.has(rec.drugName)) {
                    resultMap.set(rec.drugName, {
                        unitPrice: rec.unitPrice || 0,
                        unit: rec.unit || '',
                        regulation: rec.regulation || '',
                        stores: new Map()
                    });
                }

                const entry = resultMap.get(rec.drugName);
                entry.stores.set(rec.storeIndex, {
                    storeIndex: rec.storeIndex,
                    storeName: storeMap[rec.storeIndex],
                    stockQty: rec.stockQty || 0,
                    shipFreq: rec.shipFreq || '／'
                });
            }

            // 結果を配列化
            searchResults = [];
            for (const [drugName, data] of resultMap) {
                const storesArr = Array.from(data.stores.values())
                    .sort((a, b) => {
                        // 在庫あり（stockQty > 0）を上に、なしを下に
                        const aHas = a.stockQty > 0 ? 0 : 1;
                        const bHas = b.stockQty > 0 ? 0 : 1;
                        if (aHas !== bHas) return aHas - bHas;
                        // 同じグループ内は五十音順
                        return a.storeName.localeCompare(b.storeName, 'ja');
                    });
                
                const totalStock = storesArr.reduce((sum, s) => sum + s.stockQty, 0);
                const inStockCount = storesArr.filter(s => s.stockQty > 0).length;

                searchResults.push({
                    drugName,
                    unitPrice: data.unitPrice,
                    unit: data.unit,
                    regulation: data.regulation,
                    stores: storesArr,
                    totalStock,
                    inStockCount
                });
            }

            // 薬品名順にソート
            searchResults.sort((a, b) => a.drugName.localeCompare(b.drugName, 'ja'));

            renderResults();
            document.getElementById('search-results-area').classList.remove('hidden');

            if (searchResults.length === 0) {
                App.showToast('該当する薬品が見つかりませんでした', 'info');
            } else {
                App.showToast(`${searchResults.length}件の薬品が見つかりました`, 'success');
            }

        } catch (err) {
            console.error('薬品検索エラー:', err);
            App.showToast(`検索エラー: ${err.message}`, 'error');
        }
    }

    // ===== 結果描画 =====
    function renderResults() {
        const container = document.getElementById('search-results-list');
        const countEl = document.getElementById('search-result-count');
        container.innerHTML = '';

        // フィルタ適用された結果を再計算
        const filtered = searchResults.map(item => {
            if (selectedStoreIndices.size > 0) {
                const filteredStores = item.stores.filter(s => selectedStoreIndices.has(s.storeIndex));
                return {
                    ...item,
                    stores: filteredStores,
                    totalStock: filteredStores.reduce((sum, s) => sum + s.stockQty, 0),
                    inStockCount: filteredStores.filter(s => s.stockQty > 0).length
                };
            }
            return item;
        }).filter(item => item.stores.length > 0);

        countEl.textContent = `${filtered.length}件`;

        if (filtered.length === 0) {
            container.innerHTML = '<div class="search-empty"><p>🔍 該当する薬品がありません</p></div>';
            return;
        }

        for (const item of filtered) {
            const card = document.createElement('div');
            card.className = 'search-result-card';

            // 規制バッジ
            let regulationBadge = '';
            if (item.regulation && item.regulation.includes('麻')) {
                regulationBadge = '<span class="search-reg-badge narcotic">麻薬</span>';
            } else if (item.regulation && item.regulation.includes('向')) {
                regulationBadge = '<span class="search-reg-badge psychotropic">向精神薬</span>';
            }

            // ヘッダー
            card.innerHTML = `
                <div class="search-card-header" data-drug="${escapeHtml(item.drugName)}">
                    <div class="search-card-title">
                        <span class="search-drug-name">${escapeHtml(Admin.toFullWidth(item.drugName))}</span>
                        ${regulationBadge}
                    </div>
                    <div class="search-card-meta">
                        <span class="search-meta-item">💰 ${item.unitPrice.toFixed(1)}円/${item.unit || '-'}</span>
                        <span class="search-meta-item">📦 在庫あり: ${item.inStockCount}/${item.stores.length}店舗</span>
                        <span class="search-card-toggle">▼</span>
                    </div>
                </div>
                <div class="search-card-body hidden">
                    <table class="search-store-table">
                        <thead>
                            <tr>
                                <th>店舗</th>
                                <th>在庫数</th>
                                <th>出庫頻度</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${item.stores.map(s => `
                                <tr class="${s.stockQty > 0 ? 'has-stock' : 'no-stock'}">
                                    <td>${escapeHtml(s.storeName)}</td>
                                    <td class="stock-qty">${s.stockQty > 0 ? s.stockQty.toLocaleString() : '-'}</td>
                                    <td class="ship-freq">
                                        <span class="freq-indicator ${getFreqClass(s.shipFreq)}">${s.shipFreq}</span>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;

            // アコーディオン開閉
            const header = card.querySelector('.search-card-header');
            const body = card.querySelector('.search-card-body');
            const toggle = card.querySelector('.search-card-toggle');

            header.addEventListener('click', () => {
                const isOpen = !body.classList.contains('hidden');
                if (isOpen) {
                    body.classList.add('hidden');
                    toggle.textContent = '▼';
                    card.classList.remove('expanded');
                } else {
                    body.classList.remove('hidden');
                    toggle.textContent = '▲';
                    card.classList.add('expanded');
                }
            });

            // 結果が1件だけなら自動展開
            if (filtered.length === 1) {
                body.classList.remove('hidden');
                toggle.textContent = '▲';
                card.classList.add('expanded');
            }

            container.appendChild(card);
        }
    }

    function getFreqClass(freq) {
        if (freq === '◎') return 'freq-excellent';
        if (freq === '〇' || freq === '○') return 'freq-good';
        if (freq === '△') return 'freq-low';
        return 'freq-none';
    }

    return { init, onShow };
})();
