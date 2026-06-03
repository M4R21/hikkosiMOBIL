/* ============================================
   hq.js — 本部画面ロジック
   ============================================ */

const HQ = (() => {

    let allHQData = [];       // 全店不動在庫データキャッシュ
    let filteredData = [];    // フィルタ後のデータ
    let currentSort = { key: 'storeName', dir: 'asc' };  // ソート状態

    // ===== 初期化 =====
    async function init() {
        document.getElementById('hq-store-filter').addEventListener('change', applyFilters);
        document.getElementById('hq-fudou-filter').addEventListener('change', applyFilters);
        document.getElementById('btn-hq-pdf').addEventListener('click', exportPDF);
        document.getElementById('btn-hq-csv').addEventListener('click', exportCSV);

        // 金額フィルター
        document.getElementById('hq-amount-mode').addEventListener('change', applyFilters);
        document.getElementById('hq-amount-value').addEventListener('input', debounce(applyFilters, 400));

        // テーブルヘッダーのソートイベント
        document.querySelectorAll('#hq-table thead th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                if (currentSort.key === key) {
                    currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSort.key = key;
                    currentSort.dir = 'asc';
                }
                updateSortIndicators();
                renderTable(filteredData);
            });
        });
    }

    // デバウンス用ヘルパー
    function debounce(fn, delay) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    // ===== 表示 =====
    async function onShow() {
        await populateStoreFilter();
        await loadData();
        applyFilters();
    }

    async function populateStoreFilter() {
        const select = document.getElementById('hq-store-filter');
        while (select.options.length > 1) select.remove(1);

        const stores = await DB.getActiveStores();
        // 五十音順にソート
        stores.sort((a, b) => a.storeName.localeCompare(b.storeName, 'ja'));
        stores.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.storeIndex;
            opt.textContent = s.storeName;
            select.appendChild(opt);
        });
    }

    // ===== データ読み込み =====
    async function loadData() {
        allHQData = [];

        const stores = await DB.getActiveStores();
        const storeMap = {};
        stores.forEach(s => { storeMap[s.storeIndex] = s.storeName; });

        const allInventory = await DB.getAll('inventory');

        for (const inv of allInventory) {
            if (!storeMap[inv.storeIndex]) continue;
            if (!inv.fudouClass || !['R', 'O', 'B'].includes(inv.fudouClass)) continue;
            if (!inv.stockQty || inv.stockQty <= 0) continue;

            // Matching.checkExcluded を使用（includeOthers前方一致に対応）
            const isExcluded = inv.isNarcotic || await Matching.checkExcluded(inv.drugName);

            let candidateText = '';
            if (isExcluded) {
                candidateText = '移動不可';
            }

            allHQData.push({
                storeIndex: inv.storeIndex,
                storeName: storeMap[inv.storeIndex],
                drugName: inv.drugName,
                stockQty: inv.stockQty,
                stockAmount: inv.stockAmount,
                months: inv.months,
                fudouClass: inv.fudouClass,
                fudouLabel: Matching.getFudouLabel(inv.fudouClass),
                shipFreq: inv.shipFreq,
                isExcluded,
                candidateText
            });
        }

        // 移動先候補を算出（出庫頻度付き）
        const uniqueDrugs = [...new Set(allHQData.filter(d => !d.isExcluded).map(d => d.drugName))];

        for (const drugName of uniqueDrugs) {
            const result = await Matching.findCandidates(drugName, -1);
            const relatedItems = allHQData.filter(d => d.drugName === drugName && !d.isExcluded);
            for (const item of relatedItems) {
                const filtered = result.candidates.filter(c => c.storeIndex !== item.storeIndex);
                if (filtered.length > 0) {
                    // 店舗名(出庫頻度) のフォーマットで上位3件表示
                    item.candidateText = filtered.slice(0, 3).map(c =>
                        `${c.storeName}(${c.freq})`
                    ).join(', ');
                } else if (result.status === 'black_triangle') {
                    item.candidateText = '▲';
                } else {
                    item.candidateText = result.message || '引き取り先なし';
                }
            }
        }
    }

    // ===== フィルタ適用 =====
    function applyFilters() {
        const storeFilter = document.getElementById('hq-store-filter').value;
        const fudouFilter = document.getElementById('hq-fudou-filter').value;
        const amountMode = document.getElementById('hq-amount-mode').value;
        const amountValue = parseFloat(document.getElementById('hq-amount-value').value) || 0;

        filteredData = allHQData.slice();

        if (storeFilter) {
            filteredData = filteredData.filter(d => d.storeIndex === parseInt(storeFilter));
        }
        if (fudouFilter) {
            filteredData = filteredData.filter(d => d.fudouClass === fudouFilter);
        }

        // 金額フィルター
        if (amountMode && amountValue > 0) {
            filteredData = filteredData.filter(d => {
                const amt = Number(d.stockAmount) || 0;
                switch (amountMode) {
                    case 'gte': return amt >= amountValue;
                    case 'lte': return amt <= amountValue;
                    case 'eq':  return amt === amountValue;
                    default:    return true;
                }
            });
        }

        renderTable(filteredData);
    }

    // ===== ソート =====
    function sortData(data) {
        const key = currentSort.key;
        const dir = currentSort.dir === 'asc' ? 1 : -1;

        return data.slice().sort((a, b) => {
            let valA = a[key];
            let valB = b[key];

            // 数値キーは数値比較
            if (['stockQty', 'stockAmount', 'months'].includes(key)) {
                valA = Number(valA) || 0;
                valB = Number(valB) || 0;
                return (valA - valB) * dir;
            }

            // 文字列比較
            valA = String(valA || '');
            valB = String(valB || '');
            return valA.localeCompare(valB, 'ja') * dir;
        });
    }

    function updateSortIndicators() {
        document.querySelectorAll('#hq-table thead th[data-sort]').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
            if (th.dataset.sort === currentSort.key) {
                th.classList.add(currentSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
            }
        });
    }

    // ===== テーブル描画 =====
    function renderTable(data) {
        const tbody = document.getElementById('hq-table-body');
        const emptyMsg = document.getElementById('hq-empty');
        const countEl = document.getElementById('hq-count');

        if (data.length === 0) {
            tbody.innerHTML = '';
            emptyMsg.classList.remove('hidden');
            if (countEl) countEl.textContent = '';
            return;
        }

        emptyMsg.classList.add('hidden');
        if (countEl) countEl.textContent = `${data.length.toLocaleString()} 件`;

        const sorted = sortData(data);
        updateSortIndicators();

        tbody.innerHTML = sorted.map(row => `
            <tr>
                <td>${escapeHtml(row.storeName)}</td>
                <td>${escapeHtml(Admin.toFullWidth(row.drugName))}</td>
                <td style="text-align:right">${row.stockQty}</td>
                <td style="text-align:right">¥${Number(row.stockAmount || 0).toLocaleString()}</td>
                <td>${Matching.getFudouBadge(row.fudouClass)}</td>
                <td style="text-align:center">${escapeHtml(row.shipFreq)}</td>
                <td>${escapeHtml(row.candidateText)}</td>
            </tr>
        `).join('');
    }

    // ===== 現在のフィルタラベル取得 =====
    function getFilterLabel() {
        const storeFilter = document.getElementById('hq-store-filter');
        const fudouFilter = document.getElementById('hq-fudou-filter');
        const amountMode = document.getElementById('hq-amount-mode');
        const amountValue = document.getElementById('hq-amount-value').value;

        let filterLabel = '';
        if (storeFilter.value) {
            filterLabel += `店舗: ${storeFilter.options[storeFilter.selectedIndex].textContent}  `;
        }
        if (fudouFilter.value) {
            filterLabel += `区分: ${fudouFilter.options[fudouFilter.selectedIndex].textContent}  `;
        }
        if (amountMode.value && amountValue) {
            const modeLabel = { gte: '以上', lte: '以下', eq: '一致' }[amountMode.value] || '';
            filterLabel += `金額: ¥${Number(amountValue).toLocaleString()}${modeLabel}`;
        }
        if (!filterLabel) filterLabel = '全店舗・全区分';
        return filterLabel;
    }

    // ===== 現在表示中データ取得（ソート適用済み） =====
    function getCurrentSortedData() {
        return sortData(filteredData);
    }

    // ===== PDF出力 =====
    async function exportPDF() {
        if (filteredData.length === 0) {
            App.showToast('出力するデータがありません', 'warning');
            return;
        }

        const sorted = getCurrentSortedData();
        const filterLabel = getFilterLabel();

        const pdfData = sorted.map(row => ({
            storeName: row.storeName,
            drugName: row.drugName,
            stockQty: row.stockQty,
            stockAmount: row.stockAmount,
            fudouLabel: row.fudouLabel,
            shipFreq: row.shipFreq,
            candidateText: row.candidateText
        }));

        try {
            const doc = await PDF.generateHQReport(pdfData, filterLabel);
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            PDF.download(doc, `不動在庫レポート_${dateStr}.pdf`);
            App.showToast('PDFを出力しました', 'success');
        } catch (err) {
            App.showToast(`PDF出力エラー: ${err.message}`, 'error');
        }
    }

    // ===== CSV出力 =====
    function exportCSV() {
        if (filteredData.length === 0) {
            App.showToast('出力するデータがありません', 'warning');
            return;
        }

        const sorted = getCurrentSortedData();

        // ヘッダー行
        const headers = ['店舗名', '薬品名', '在庫数', '在庫金額', '不動期間', '出庫頻度', '移動先候補'];

        // データ行
        const rows = sorted.map(row => [
            row.storeName,
            Admin.toFullWidth(row.drugName),
            row.stockQty,
            Number(row.stockAmount || 0),
            row.fudouLabel,
            row.shipFreq,
            row.candidateText
        ]);

        // CSV文字列生成
        const csvContent = [headers, ...rows].map(row =>
            row.map(cell => {
                const str = String(cell ?? '');
                // カンマや改行、ダブルクォートを含む場合はエスケープ
                if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                    return '"' + str.replace(/"/g, '""') + '"';
                }
                return str;
            }).join(',')
        ).join('\n');

        // BOM付きUTF-8でダウンロード
        const bom = '\uFEFF';
        const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        a.href = url;
        a.download = `不動在庫レポート_${dateStr}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        App.showToast('CSVを出力しました', 'success');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    return { init, onShow };
})();
