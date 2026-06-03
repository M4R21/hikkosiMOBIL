/* ============================================
   pdf.js — PDF出力処理（日本語フォント対応）
   ============================================ */

const PDF = (() => {

    // フォントキャッシュ
    let fontLoaded = false;
    let fontLoadPromise = null;

    /**
     * jsPDFインスタンスを安全に生成
     */
    function getJsPDFClass() {
        if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
        if (window.jsPDF) return window.jsPDF;
        if (window.jspdf && typeof window.jspdf === 'function') return window.jspdf;
        throw new Error('jsPDFライブラリが読み込まれていません。ページを再読み込みしてください。');
    }

    /**
     * NotoSansJP フォントを動的に読み込んでjsPDFに登録
     */
    async function loadJapaneseFont() {
        if (fontLoaded) return;
        if (fontLoadPromise) return fontLoadPromise;

        fontLoadPromise = (async () => {
            try {
                const JsPDF = getJsPDFClass();

                // Google Fonts API から NotoSansJP Regular のttfを取得
                // 直接ttf URLを使用（Google Fonts CDN）
                const fontUrl = 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-jp@latest/japanese-400-normal.ttf';

                const response = await fetch(fontUrl);
                if (!response.ok) {
                    throw new Error(`フォント取得失敗: ${response.status}`);
                }

                const fontBuffer = await response.arrayBuffer();
                const fontBase64 = arrayBufferToBase64(fontBuffer);

                // jsPDFのVFSにフォントファイルを登録
                const callAddFont = function () {
                    this.addFileToVFS('NotoSansJP-Regular.ttf', fontBase64);
                    this.addFont('NotoSansJP-Regular.ttf', 'NotoSansJP', 'normal');
                };

                JsPDF.API.events.push(['addFonts', callAddFont]);

                fontLoaded = true;
                console.log('Japanese font loaded successfully');
            } catch (err) {
                console.error('フォント読み込みエラー:', err);
                // フォールバック: フォントなしでも動作し続ける
                fontLoaded = false;
                throw err;
            }
        })();

        return fontLoadPromise;
    }

    /**
     * ArrayBuffer -> Base64 変換
     */
    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }

    /**
     * jsPDFインスタンスを生成して日本語フォントを設定
     */
    function createDoc(options) {
        const JsPDF = getJsPDFClass();
        const doc = new JsPDF(options);

        if (fontLoaded) {
            try {
                doc.setFont('NotoSansJP', 'normal');
            } catch (e) {
                console.warn('NotoSansJPフォントの設定に失敗、デフォルトフォントを使用:', e);
                doc.setFont('helvetica');
            }
        } else {
            doc.setFont('helvetica');
        }

        return doc;
    }

    /**
     * 店舗用 引き取り依頼PDF生成
     */
    async function generatePickupRequest(fromStoreName, toStoreName, items) {
        await loadJapaneseFont();

        const doc = createDoc({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        const fontName = fontLoaded ? 'NotoSansJP' : 'helvetica';
        const pageWidth = doc.internal.pageSize.getWidth();
        const margin = 20;
        let y = 30;

        // 日付（左寄せ）
        const today = new Date();
        const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
        doc.setFontSize(10);
        doc.text(dateStr, margin, y);

        // 宛先（右寄せ）
        doc.setFontSize(14);
        doc.text(`${toStoreName} 様`, pageWidth - margin, y, { align: 'right' });
        
        y += 20;

        // 挨拶文
        doc.setFontSize(11);
        doc.text('お疲れ様です。', margin, y);
        y += 8;
        doc.text('引き取りをお願いしたいお薬がございます。', margin, y);
        y += 15;

        // テーブル
        doc.autoTable({
            startY: y,
            head: [['引取可否', '薬品名', '錠数', '期限', 'ロット', '備考']],
            body: items.map(item => [
                '',
                Admin.toFullWidth(item.drugName || ''),
                String(item.qty || ''),
                item.expiry || '',
                item.lot || '',
                item.memo || ''
            ]),
            margin: { left: margin, right: margin },
            styles: {
                font: fontName,
                fontSize: 9,
                cellPadding: 4,
                lineWidth: 0.3,
                lineColor: [100, 100, 100],
                textColor: [30, 30, 30]
            },
            headStyles: {
                fillColor: [220, 230, 220],
                textColor: [30, 30, 30],
                fontStyle: 'normal',
                halign: 'center'
            },
            columnStyles: {
                0: { cellWidth: 16, halign: 'center' },
                1: { cellWidth: 'auto' },
                2: { cellWidth: 16, halign: 'right' },
                3: { cellWidth: 30, halign: 'center' },
                4: { cellWidth: 24, halign: 'center' },
                5: { cellWidth: 30 }
            }
        });

        y = doc.lastAutoTable.finalY + 15;

        doc.setFontSize(11);
        doc.text('ご検討よろしくお願いいたします。', margin, y);
        y += 12;

        doc.setFontSize(12);
        doc.text(fromStoreName, pageWidth - margin, y, { align: 'right' });

        return doc;
    }

    /**
     * 複数の引き取り先に一括PDF生成
     */
    async function generateAllPickupRequests(fromStoreName, groupedItems) {
        await loadJapaneseFont();

        const doc = createDoc({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        const fontName = fontLoaded ? 'NotoSansJP' : 'helvetica';
        const entries = Object.entries(groupedItems);
        
        entries.forEach(([toStoreName, items], index) => {
            if (index > 0) doc.addPage();
            
            const pageWidth = doc.internal.pageSize.getWidth();
            const margin = 20;
            let y = 30;

            // 日付（左寄せ）
            const today = new Date();
            const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
            doc.setFontSize(10);
            doc.text(dateStr, margin, y);

            // 宛先（右寄せ）
            doc.setFontSize(14);
            doc.text(`${toStoreName} 様`, pageWidth - margin, y, { align: 'right' });

            y += 20;
            doc.setFontSize(11);
            doc.text('お疲れ様です。', margin, y);
            y += 8;
            doc.text('引き取りをお願いしたいお薬がございます。', margin, y);
            y += 15;

            doc.autoTable({
                startY: y,
                head: [['引取可否', '薬品名', '錠数', '期限', 'ロット', '備考']],
                body: items.map(item => [
                    '',
                    Admin.toFullWidth(item.drugName || ''),
                    String(item.qty || ''),
                    item.expiry || '',
                    item.lot || '',
                    item.memo || ''
                ]),
                margin: { left: margin, right: margin },
                styles: {
                    font: fontName,
                    fontSize: 9,
                    cellPadding: 4,
                    lineWidth: 0.3,
                    lineColor: [100, 100, 100],
                    textColor: [30, 30, 30]
                },
                headStyles: {
                    fillColor: [220, 230, 220],
                    textColor: [30, 30, 30],
                    fontStyle: 'normal',
                    halign: 'center'
                },
                columnStyles: {
                    0: { cellWidth: 16, halign: 'center' },
                    1: { cellWidth: 'auto' },
                    2: { cellWidth: 16, halign: 'right' },
                    3: { cellWidth: 30, halign: 'center' },
                    4: { cellWidth: 24, halign: 'center' },
                    5: { cellWidth: 30 }
                }
            });

            y = doc.lastAutoTable.finalY + 15;
            doc.setFontSize(11);
            doc.text('ご検討よろしくお願いいたします。', margin, y);
            y += 12;
            doc.setFontSize(12);
            doc.text(fromStoreName, pageWidth - margin, y, { align: 'right' });
        });

        return doc;
    }

    /**
     * 本部用 不動在庫レポートPDF
     */
    async function generateHQReport(data, filterLabel) {
        await loadJapaneseFont();

        const doc = createDoc({
            orientation: 'landscape',
            unit: 'mm',
            format: 'a4'
        });

        const fontName = fontLoaded ? 'NotoSansJP' : 'helvetica';
        const pageWidth = doc.internal.pageSize.getWidth();
        const margin = 15;
        let y = 20;

        doc.setFontSize(16);
        doc.text('不動在庫状況レポート', pageWidth / 2, y, { align: 'center' });
        y += 8;
        
        doc.setFontSize(9);
        doc.text(`出力日: ${new Date().toLocaleDateString('ja-JP')}  ${filterLabel}`, pageWidth / 2, y, { align: 'center' });
        y += 10;

        doc.autoTable({
            startY: y,
            head: [['店舗名', '薬品名', '在庫数', '在庫金額', '不動期間', '出庫頻度', '移動先候補']],
            body: data.map(row => [
                row.storeName || '',
                Admin.toFullWidth(row.drugName || ''),
                String(row.stockQty || 0),
                row.stockAmount ? `¥${Number(row.stockAmount).toLocaleString()}` : '¥0',
                row.fudouLabel || '',
                row.shipFreq || '',
                row.candidateText || ''
            ]),
            margin: { left: margin, right: margin },
            styles: {
                font: fontName,
                fontSize: 8,
                cellPadding: 3,
                lineWidth: 0.2,
                lineColor: [150, 150, 150],
                textColor: [30, 30, 30]
            },
            headStyles: {
                fillColor: [50, 80, 100],
                textColor: [255, 255, 255],
                fontStyle: 'normal',
                halign: 'center',
                fontSize: 8
            },
            columnStyles: {
                0: { cellWidth: 40 },
                1: { cellWidth: 'auto' },
                2: { cellWidth: 20, halign: 'right' },
                3: { cellWidth: 28, halign: 'right' },
                4: { cellWidth: 28, halign: 'center' },
                5: { cellWidth: 20, halign: 'center' },
                6: { cellWidth: 45 }
            },
            didDrawPage: (hookData) => {
                const pageCount = doc.internal.getNumberOfPages();
                doc.setFontSize(8);
                doc.text(
                    `${hookData.pageNumber} / ${pageCount}`,
                    pageWidth - margin,
                    doc.internal.pageSize.getHeight() - 10,
                    { align: 'right' }
                );
            }
        });

        return doc;
    }

    /**
     * PDFをダウンロード
     */
    function download(doc, filename) {
        doc.save(filename);
    }

    /**
     * フォントのプリロード（アプリ起動時に呼ぶ）
     */
    async function preloadFont() {
        try {
            await loadJapaneseFont();
        } catch (e) {
            console.warn('フォントのプリロードに失敗:', e);
        }
    }

    return {
        generatePickupRequest,
        generateAllPickupRequests,
        generateHQReport,
        download,
        preloadFont
    };
})();
