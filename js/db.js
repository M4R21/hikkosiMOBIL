/* ============================================
   db.js — IndexedDB ラッパー（通常版）
   ============================================ */

const DB = (() => {
    const DB_NAME = 'KusuriOhikkoshi';
    const DB_VERSION = 3;
    let db = null;

    function open() {
        return new Promise((resolve, reject) => {
            if (db) return resolve(db);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains('stores')) {
                    d.createObjectStore('stores', { keyPath: 'storeIndex' });
                }
                if (!d.objectStoreNames.contains('inventory')) {
                    const inv = d.createObjectStore('inventory', { keyPath: 'id' });
                    inv.createIndex('drugName', 'drugName', { unique: false });
                    inv.createIndex('storeIndex', 'storeIndex', { unique: false });
                }
                if (!d.objectStoreNames.contains('excludedDrugs')) {
                    d.createObjectStore('excludedDrugs', { keyPath: 'drugName' });
                }
                if (!d.objectStoreNames.contains('moveRequests')) {
                    const mr = d.createObjectStore('moveRequests', { keyPath: 'id', autoIncrement: true });
                    mr.createIndex('storeIndex', 'storeIndex', { unique: false });
                }
                if (!d.objectStoreNames.contains('settings')) {
                    d.createObjectStore('settings', { keyPath: 'key' });
                }
                // バラ錠用
                if (!d.objectStoreNames.contains('bulkInventory')) {
                    const bi = d.createObjectStore('bulkInventory', { keyPath: 'id' });
                    bi.createIndex('drugName', 'drugName', { unique: false });
                    bi.createIndex('storeName', 'storeName', { unique: false });
                }
                if (!d.objectStoreNames.contains('bulkExcluded')) {
                    d.createObjectStore('bulkExcluded', { keyPath: 'id' }); // id: storeName_drugName
                }
                if (!d.objectStoreNames.contains('bulkSettings')) {
                    d.createObjectStore('bulkSettings', { keyPath: 'key' });
                }
            };
            req.onsuccess = (e) => { db = e.target.result; resolve(db); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function tx(storeName, mode) { return db.transaction(storeName, mode).objectStore(storeName); }
    function promisify(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function put(storeName, data) { await open(); return promisify(tx(storeName, 'readwrite').put(data)); }
    async function get(storeName, key) { await open(); return promisify(tx(storeName, 'readonly').get(key)); }
    async function getAll(storeName) { await open(); return promisify(tx(storeName, 'readonly').getAll()); }
    async function remove(storeName, key) { await open(); return promisify(tx(storeName, 'readwrite').delete(key)); }
    async function clear(storeName) { await open(); return promisify(tx(storeName, 'readwrite').clear()); }
    async function count(storeName) { await open(); return promisify(tx(storeName, 'readonly').count()); }

    async function putBatch(storeName, items, onProgress) {
        await open();
        const BATCH = 500;
        for (let i = 0; i < items.length; i += BATCH) {
            const batch = items.slice(i, i + BATCH);
            await new Promise((resolve, reject) => {
                const t = db.transaction(storeName, 'readwrite');
                const store = t.objectStore(storeName);
                batch.forEach(item => store.put(item));
                t.oncomplete = resolve;
                t.onerror = () => reject(t.error);
            });
            if (onProgress) onProgress(Math.min(i + BATCH, items.length), items.length);
        }
    }

    async function getAllByIndex(storeName, indexName, value) {
        await open();
        const store = tx(storeName, 'readonly');
        return promisify(store.index(indexName).getAll(value));
    }

    async function getStores() { return getAll('stores'); }
    async function getActiveStores() {
        return (await getAll('stores')).filter(s => !s.excluded);
    }
    async function getInventoryByDrug(drugName) { return getAllByIndex('inventory', 'drugName', drugName); }
    async function getInventoryByStore(storeIndex) { return getAllByIndex('inventory', 'storeIndex', storeIndex); }
    async function setSetting(key, value) { return put('settings', { key, value }); }
    async function getSetting(key) {
        const result = await get('settings', key);
        return result ? result.value : null;
    }

    async function resetAll() {
        await open();
        for (const name of ['stores', 'inventory', 'excludedDrugs', 'moveRequests', 'settings', 'bulkInventory', 'bulkExcluded', 'bulkSettings']) {
            await clear(name);
        }
    }

    async function resetInventory() {
        await open();
        await clear('inventory');
        await clear('stores');
    }

    async function resetBulk() {
        await open();
        await clear('bulkInventory');
        await clear('bulkSettings');
    }

    async function getMoveRequestsByStore(storeIndex) {
        return getAllByIndex('moveRequests', 'storeIndex', storeIndex);
    }

    async function clearMoveRequestsByStore(storeIndex) {
        const items = await getMoveRequestsByStore(storeIndex);
        for (const item of items) {
            await remove('moveRequests', item.id);
        }
    }

    return {
        open, put, get, getAll, remove, clear, count,
        putBatch, getAllByIndex,
        getStores, getActiveStores,
        getInventoryByDrug, getInventoryByStore,
        setSetting, getSetting,
        resetAll, resetInventory, resetBulk,
        getMoveRequestsByStore, clearMoveRequestsByStore
    };
})();
