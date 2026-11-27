/**
 * 已下载页面图片的本地持久化（IndexedDB）。
 *
 * 任务取消、失败或页面关闭后，图片仍保留，下一次继续/重试时直接复用，
 * 不会重新下载已完成的页面。
 */

const DB_NAME = "nsfc-report-export";
const DB_VERSION = 1;
const PAGE_STORE = "pages";
const PAGE_INDEX = "byProject";

export type StoredPage = {
    projectId: string;
    index: number;
    blob: Blob;
    width: number;
    height: number;
    savedAt: number;
};

type PageRecord = StoredPage & { key: string };

let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(PAGE_STORE)) {
                    const store = db.createObjectStore(PAGE_STORE, {
                        keyPath: "key",
                    });
                    store.createIndex(PAGE_INDEX, "projectId", {
                        unique: false,
                    });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error("IndexedDB 被阻塞"));
        });
    }
    return dbPromise;
};

const pageKey = (projectId: string, index: number) =>
    `${projectId}:${index}`;

const txDone = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
        tx.onabort = () =>
            reject(tx.error ?? new Error("IndexedDB 事务中止"));
    });

export const putPage = async (page: StoredPage): Promise<void> => {
    const db = await openDB();
    const tx = db.transaction(PAGE_STORE, "readwrite");
    tx.objectStore(PAGE_STORE).put({
        ...page,
        key: pageKey(page.projectId, page.index),
    });
    await txDone(tx);
};

export const getPage = async (
    projectId: string,
    index: number,
): Promise<PageRecord | null> => {
    const db = await openDB();
    const tx = db.transaction(PAGE_STORE, "readonly");
    const req = tx.objectStore(PAGE_STORE).get(pageKey(projectId, index));
    const record = await new Promise<PageRecord | undefined>(
        (resolve, reject) => {
            req.onsuccess = () => resolve(req.result as PageRecord | undefined);
            req.onerror = () => reject(req.error);
        },
    );
    await txDone(tx);
    return record ?? null;
};

export const listPages = async (projectId: string): Promise<PageRecord[]> => {
    const db = await openDB();
    const tx = db.transaction(PAGE_STORE, "readonly");
    const index = tx.objectStore(PAGE_STORE).index(PAGE_INDEX);
    const req = index.getAll(IDBKeyRange.only(projectId));
    const records = await new Promise<PageRecord[]>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as PageRecord[]);
        req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    return records.sort((a, b) => a.index - b.index);
};

export const countPages = async (projectId: string): Promise<number> => {
    const db = await openDB();
    const tx = db.transaction(PAGE_STORE, "readonly");
    const index = tx.objectStore(PAGE_STORE).index(PAGE_INDEX);
    const req = index.count(IDBKeyRange.only(projectId));
    const count = await new Promise<number>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    return count;
};

export const deleteProjectPages = async (projectId: string): Promise<void> => {
    const db = await openDB();
    const tx = db.transaction(PAGE_STORE, "readwrite");
    const index = tx.objectStore(PAGE_STORE).index(PAGE_INDEX);
    const req = index.openKeyCursor(IDBKeyRange.only(projectId));
    req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        tx.objectStore(PAGE_STORE).delete(cursor.primaryKey);
        cursor.continue();
    };
    await txDone(tx);
};

/** 删除所有项目缓存（保留任务本身） */
export const clearAllPages = async (): Promise<void> => {
    const db = await openDB();
    const tx = db.transaction(PAGE_STORE, "readwrite");
    tx.objectStore(PAGE_STORE).clear();
    await txDone(tx);
};