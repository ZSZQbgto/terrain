/**
 * IndexedDB 存 glb 二进制。
 *
 * 编辑器里的模型来自用户本地文件，刷新页面后浏览器不允许再读原路径，
 * 所以把原始 ArrayBuffer 存进 IndexedDB：工程（transform / 标签）存 localStorage，
 * 模型文件按 assetId 从这里取回。
 *
 * 两个 store：
 *   assets —— { id, buffer, type }        二进制本体
 *   meta   —— { id, name, size, type, createdAt }  列表用的元数据（避免为此读大 buffer）
 */
const DB_NAME = 'terrain-modeldesigner';
const DB_VERSION = 1;
const ASSET_STORE = 'assets';
const META_STORE = 'meta';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 一个事务里写两个 store（元数据 + 二进制） */
export async function putAsset({ id, name, type, buffer, createdAt = Date.now() }) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ASSET_STORE, META_STORE], 'readwrite');
    // assets 记录里也带上 name：下载/移入文件夹时要靠它还原文件名
    tx.objectStore(ASSET_STORE).put({ id, name, buffer, type });
    tx.objectStore(META_STORE).put({ id, name, size: buffer.byteLength, type, createdAt });
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAsset(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(ASSET_STORE, 'readonly').objectStore(ASSET_STORE).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAsset(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ASSET_STORE, META_STORE], 'readwrite');
    tx.objectStore(ASSET_STORE).delete(id);
    tx.objectStore(META_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 只读元数据列表，不加载二进制 */
export async function listAssets() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []).sort((a, b) => a.createdAt - b.createdAt));
    req.onerror = () => reject(req.error);
  });
}

export async function clearAssets() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ASSET_STORE, META_STORE], 'readwrite');
    tx.objectStore(ASSET_STORE).clear();
    tx.objectStore(META_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
