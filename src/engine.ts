import { jsPDF } from "jspdf";
import { getImgBlob, getImgURL, getProjectInfo } from "./nsfc";
import { listPages, putPage } from "./idb";
import { Task, TaskProgress } from "./types";
import { abortableSleep, getCachedData, setCachedData } from "./utils";

const MAX_PAGE = 500;
const PARALLEL = 6;
const PAGE_RETRY = 3;
const RETRY_ROUNDS = 30;
const RETRY_DELAY_MS = 10_000;
const DISCOVERY_RETRY = 3;
const MAX_PAGE_CACHE_KEY = (id: string) => `img_${id}_maxpage`;

export class CancelledError extends Error {
    constructor() {
        super("任务已取消");
        this.name = "CancelledError";
    }
}

export const isCancelled = (e: unknown): boolean =>
    e instanceof CancelledError ||
    (e instanceof DOMException && e.name === "AbortError");

const errorMessage = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    return String(e);
};

const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new CancelledError();
};

export type EngineHooks = {
    signal: AbortSignal;
    onChange: () => void;
    onPageSaved?: (
        index: number,
        blob: Blob,
        width: number,
        height: number,
    ) => void;
    onNotice?: (message: string) => void;
    /** 某页返回 404：说明报告到此为止 */
    onPageMissing?: (index: number) => void;
};

const pageIndices = (task: Task): number[] =>
    Object.keys(task.pages).map((k) => Number(k)).sort((a, b) => a - b);

export const getProgress = (task: Task): TaskProgress => {
    const progress: TaskProgress = {
        done: 0,
        failed: 0,
        downloading: 0,
        pending: 0,
    };
    for (const state of Object.values(task.pages)) {
        progress[state.status]++;
    }
    return progress;
};

/** 把 IndexedDB 里已存在的页面同步到任务状态，返回可复用页数 */
export const hydrateTaskFromCache = async (task: Task): Promise<number> => {
    const stored = await listPages(task.projectId);
    const storedIndices = new Set(stored.map((p) => p.index));

    for (const page of stored) {
        task.pages[page.index] = {
            status: "done",
            width: page.width,
            height: page.height,
        };
    }
    // 状态是 done 但缓存已被清理的页面，重新排队
    for (const index of pageIndices(task)) {
        if (
            task.pages[index].status === "done" &&
            !storedIndices.has(index)
        ) {
            task.pages[index] = { status: "pending" };
        }
        if (task.pages[index].status === "downloading") {
            task.pages[index] = { status: "pending" };
        }
    }
    return stored.length;
};

/**
 * 下载单页，内部最多重试 PAGE_RETRY 次。
 * 每次重试都会重新申请签名地址（顺带处理 token/URL 过期）。
 */
const downloadPage = async (
    task: Task,
    index: number,
    initialURL: string,
    hooks: EngineHooks,
): Promise<void> => {
    const { signal } = hooks;
    let url = initialURL;

    for (let attempt = 1; attempt <= PAGE_RETRY; attempt++) {
        throwIfAborted(signal);
        try {
            if (attempt > 1) {
                const [fresh] = await getImgURL(task.projectId, index, signal);
                if (fresh === "404") {
                    // 404 表示报告到此为止，交给任务层收缩总页数
                    hooks.onPageMissing?.(index);
                    task.pages[index] = { status: "pending" };
                    task.updatedAt = Date.now();
                    hooks.onChange();
                    return;
                }
                url = fresh;
            }

            const img = await getImgBlob(url, signal);
            throwIfAborted(signal);

            const width = Number(img.width) || 0;
            const height = Number(img.height) || 0;
            if (!width || !height) throw new Error("无法解析图片尺寸");
            if (img.imageData.byteLength < 1024) throw new Error("图片过小");

            const blob = new Blob([new Uint8Array(img.imageData)], {
                type: "image/png",
            });
            await putPage({
                projectId: task.projectId,
                index,
                blob,
                width,
                height,
                savedAt: Date.now(),
            });
            throwIfAborted(signal);

            task.pages[index] = { status: "done", width, height };
            task.updatedAt = Date.now();
            hooks.onPageSaved?.(index, blob, width, height);
            hooks.onChange();
            return;
        } catch (e) {
            if (signal.aborted || isCancelled(e)) {
                if (task.pages[index]?.status === "downloading") {
                    task.pages[index] = { status: "pending" };
                }
                // 取消不向调用方抛错，避免并发任务产生未处理的 rejection
                return;
            }
            if (attempt === PAGE_RETRY) {
                task.pages[index] = {
                    status: "failed",
                    error: errorMessage(e),
                };
                task.updatedAt = Date.now();
                hooks.onChange();
                return;
            }
            try {
                await abortableSleep(1200 * attempt, signal);
            } catch {
                return;
            }
        }
    }
};

const buildPdf = async (
    task: Task,
    totalPages: number,
    allowMissing = false,
): Promise<Blob> => {
    const stored = await listPages(task.projectId);
    const byIndex = new Map(stored.map((p) => [p.index, p]));

    const doc = new jsPDF({ compress: true });
    doc.setDocumentProperties({
        title: task.projectName || "结题报告",
        subject: task.conclusionAbstract,
        author: [task.projectAdmin, task.projectUnit]
            .filter(Boolean)
            .join(" "),
        keywords: task.projectKeywordC,
        creator: "@ejfkdev",
    });
    doc.deletePage(1);

    let added = 0;
    for (let index = 1; index <= totalPages; index++) {
        const page = byIndex.get(index);
        if (!page) {
            if (allowMissing) continue;
            throw new Error(`第${index}页缓存丢失`);
        }
        added++;
        const width = page.width || 595;
        const height = page.height || 842;
        doc.addPage(
            [width, height],
            width < height ? "p" : "l",
        );
        const data = new Uint8Array(await page.blob.arrayBuffer());
        doc.addImage({
            imageData: data,
            x: 0,
            y: 0,
            width,
            height,
            compression: "FAST",
        });
    }

    if (added === 0) throw new Error("没有可用的页面");
    const buffer = doc.output("arraybuffer");
    return new Blob([buffer], { type: "application/pdf" });
};

export const pdfFileName = (task: Task): string => {
    // Windows/macOS/Linux 都不允许这些字符，直接删除
    const clean = (value: string) =>
        (value || "")
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/[. ]+$/g, "");

    const firstOf = (value: string) =>
        (clean(value).split(/[,，;；、]/)[0] || "").trim();

    const title = clean(task.projectName) || "结题报告";
    const unit = firstOf(task.projectUnit);
    const author = firstOf(task.projectAdmin);
    const idPart = task.projectId.slice(0, 8);
    const suffix = `-${idPart}.pdf`;

    // 报告标题-单位-作者-报告ID前8位，按 UTF-8 字节安全截断（win 255 字节限制）
    const encoder = new TextEncoder();
    const chars = Array.from(
        [title, unit, author].filter(Boolean).join("-"),
    );
    while (
        chars.length > 0 &&
        encoder.encode(chars.join("") + suffix).length > 245
    ) {
        chars.pop();
    }
    const base = chars.join("") || "结题报告";
    const filename = `${base}${suffix}`;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(`${base}-${idPart}`)) {
        return `_${filename}`;
    }
    return filename;
};

const downloadPdf = async (blob: Blob, filename: string): Promise<number> => {
    const url = URL.createObjectURL(blob);
    try {
        return await chrome.downloads.download({
            url,
            filename,
            conflictAction: "uniquify",
            saveAs: false,
        });
    } finally {
        // 给下载器留出读取 blob 的时间
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
};

/** 汇总下载结果，必要时生成 PDF */
export const finalizeTask = async (
    task: Task,
    hooks: EngineHooks,
    options: { allowMissing?: boolean } = {},
): Promise<void> => {
    throwIfAborted(hooks.signal);

    const failed = pageIndices(task).filter(
        (i) => task.pages[i].status === "failed",
    );
    if (failed.length > 0 && !options.allowMissing) {
        task.status = "partial";
        task.error = `${failed.length} 页下载失败`;
        task.pdf = { status: "idle" };
        task.updatedAt = Date.now();
        hooks.onChange();
        return;
    }

    let totalPages = task.totalPages;
    if (!totalPages) {
        // 取消/中断时可能还没探明总页数；强制导出时以已探测/已缓存的最大页码为准
        const highest = Math.max(
            task.exploredPages,
            ...pageIndices(task),
            0,
        );
        if (options.allowMissing && highest > 0) {
            totalPages = highest;
        } else {
            task.status = "failed";
            task.error = "报告没有可下载的页面";
            task.updatedAt = Date.now();
            hooks.onChange();
            return;
        }
    }

    const missing: number[] = [];
    for (let index = 1; index <= totalPages; index++) {
        if (task.pages[index]?.status !== "done") missing.push(index);
    }
    if (missing.length > 0 && !options.allowMissing) {
        task.status = "partial";
        task.error = `还有 ${missing.length} 页未完成`;
        task.pdf = { status: "idle" };
        task.updatedAt = Date.now();
        hooks.onChange();
        return;
    }

    task.pdf = { status: "generating" };
    task.updatedAt = Date.now();
    hooks.onChange();

    try {
        const blob = await buildPdf(
            task,
            totalPages,
            !!options.allowMissing,
        );
        throwIfAborted(hooks.signal);
        const filename = pdfFileName(task);
        console.log("保存 PDF:", filename);
        const downloadId = await downloadPdf(blob, filename);
        task.pdf = { status: "done", downloadId };
        task.status = missing.length > 0 ? "partial" : "completed";
        task.error = missing.length > 0
            ? `已生成 PDF，跳过 ${missing.length} 页未完成页面`
            : undefined;
        task.updatedAt = Date.now();
        hooks.onChange();
        hooks.onNotice?.(
            missing.length > 0
                ? `${filename} 已保存（跳过 ${missing.length} 页）`
                : `${filename} 已保存到下载目录`,
        );
    } catch (e) {
        if (isCancelled(e) || hooks.signal.aborted) throw new CancelledError();
        task.pdf = { status: "failed", error: errorMessage(e) };
        task.status = "partial";
        task.error = `PDF 生成失败: ${errorMessage(e)}`;
        task.updatedAt = Date.now();
        hooks.onChange();
    }
};

/**
 * 第一轮下载结束后，对临时失败的页面再自动补一轮（不包含确定为不存在的页面）。
 * 仍然失败的页面保留给用户手动重试。
 */
const retryPageBatch = async (
    task: Task,
    indices: number[],
    hooks: EngineHooks,
): Promise<void> => {
    const queue = [...indices];
    const workers = Array.from(
        { length: Math.min(3, queue.length) },
        async () => {
            while (queue.length > 0) {
                throwIfAborted(hooks.signal);
                const index = queue.shift()!;
                // 期间可能已经探测到更小的总页数
                if (task.totalPages > 0 && index > task.totalPages) continue;

                task.pages[index] = { status: "downloading" };
                task.updatedAt = Date.now();
                hooks.onChange();
                try {
                    const [url] = await getImgURL(
                        task.projectId,
                        index,
                        hooks.signal,
                    );
                    if (url === "404") {
                        hooks.onPageMissing?.(index);
                        task.pages[index] = { status: "pending" };
                        task.updatedAt = Date.now();
                        hooks.onChange();
                        continue;
                    }
                    await downloadPage(task, index, url, hooks);
                } catch (e) {
                    if (hooks.signal.aborted || isCancelled(e)) {
                        throw new CancelledError();
                    }
                    task.pages[index] = {
                        status: "failed",
                        error: errorMessage(e),
                    };
                    task.updatedAt = Date.now();
                    hooks.onChange();
                }
            }
        },
    );
    await Promise.all(workers);
};

/**
 * 执行/继续一个任务：
 * 1. 复用 IndexedDB 中已下载的页面
 * 2. 探测总页数（若未知），边探测边并发下载
 * 3. 逐页失败重试，token/签名过期自动重新申请
 * 4. 全部完成后生成 PDF 并下载
 */
export const runTask = async (
    task: Task,
    hooks: EngineHooks,
): Promise<void> => {
    const { signal } = hooks;

    hooks = {
        ...hooks,
        onPageMissing: (index: number) => {
            const lastPage = Math.max(0, index - 1);
            if (task.totalPages === 0 || lastPage < task.totalPages) {
                task.totalPages = lastPage;
                task.updatedAt = Date.now();
                void setCachedData(MAX_PAGE_CACHE_KEY(task.projectId), index);
                hooks.onChange();
            }
        },
    };

    task.status = "running";
    task.error = undefined;
    task.pdf = { status: "idle" };
    task.updatedAt = Date.now();
    hooks.onChange();

    const active = new Set<Promise<void>>();
    let mainDone = false;
    let stopRetry = false;
    let retryLoop: Promise<void> = Promise.resolve();

    try {
        // 每次执行都刷新项目信息，确保单位/负责人等字段可用于文件名
        {
            const info = await getProjectInfo(task.projectId, signal)
                .catch(() => null);
            if (info) {
                if (info.projectName && info.projectName !== "projectName") {
                    task.projectName = info.projectName;
                }
                task.projectAdmin = info.projectAdmin || task.projectAdmin;
                task.projectUnit = info.projectUnit || task.projectUnit;
                task.conclusionAbstract = info.conclusionAbstract ||
                    task.conclusionAbstract;
                task.projectKeywordC = info.projectKeywordC ||
                    task.projectKeywordC;
            }
            if (!task.projectName || task.projectName === "projectName") {
                task.projectName = `结题报告 ${task.projectId.slice(0, 8)}`;
            }
            hooks.onChange();
        }

        const cachedCount = await hydrateTaskFromCache(task);
        hooks.onChange();
        if (cachedCount > 0) {
            hooks.onNotice?.(`已复用本地缓存的 ${cachedCount} 页`);
        }

        const knownTotal = task.totalPages > 0;
        const limit = knownTotal ? task.totalPages : MAX_PAGE;
        let reachedEnd = knownTotal;

        // 失败页自动重试循环：下载过程中每 10 秒补一次，主流程结束后再补最多 RETRY_ROUNDS 轮
        retryLoop = (async () => {
            try {
                let postDoneBatches = 0;
                while (!stopRetry) {
                    const failed = pageIndices(task).filter(
                        (index) =>
                            task.pages[index].status === "failed" &&
                            (task.totalPages === 0 ||
                                index <= task.totalPages),
                    );
                    if (failed.length === 0) {
                        if (mainDone) return;
                        await abortableSleep(2000, signal);
                        continue;
                    }
                    if (mainDone) {
                        if (postDoneBatches >= RETRY_ROUNDS) return;
                        postDoneBatches++;
                    }
                    hooks.onNotice?.(
                        `${failed.length} 页下载失败，${
                            RETRY_DELAY_MS / 1000
                        } 秒后自动重试…`,
                    );
                    await abortableSleep(RETRY_DELAY_MS, signal);
                    if (stopRetry) return;
                    const stillFailed = pageIndices(task).filter(
                        (index) =>
                            task.pages[index].status === "failed" &&
                            (task.totalPages === 0 ||
                                index <= task.totalPages),
                    );
                    if (stillFailed.length === 0) continue;
                    console.log(
                        `auto retry ${stillFailed.length} page(s):`,
                        stillFailed.slice(0, 3).join(","),
                    );
                    await retryPageBatch(
                        task,
                        stillFailed.slice(0, 3),
                        hooks,
                    );
                }
            } catch (e) {
                if (!hooks.signal.aborted && !isCancelled(e)) {
                    console.warn("retry loop error", e);
                }
            }
        })();

        const startDownload = (index: number, url: string) => {
            const promise: Promise<void> = downloadPage(
                task,
                index,
                url,
                hooks,
            ).finally(() => {
                active.delete(promise);
            });
            active.add(promise);
        };
        const throttle = async () => {
            while (active.size >= PARALLEL) {
                await Promise.race(active);
            }
        };

        for (let index = 1; index <= limit; index++) {
            throwIfAborted(signal);
            if (task.pages[index]?.status === "done") continue;
            // 下载过程中发现 404 后总页数可能变小
            if (task.totalPages > 0 && index > task.totalPages) {
                reachedEnd = true;
                break;
            }

            const maxCache = knownTotal
                ? 0
                : Number(
                    (await getCachedData(MAX_PAGE_CACHE_KEY(task.projectId)))
                        ?.data ?? 0,
                );
            if (!knownTotal && maxCache > 0 && index >= maxCache) {
                task.totalPages = maxCache - 1;
                reachedEnd = true;
                hooks.onChange();
                break;
            }

            task.exploredPages = Math.max(task.exploredPages, index);
            hooks.onChange();

            let url = "";
            let cached = false;
            let lastError: unknown = null;
            for (let attempt = 1; attempt <= DISCOVERY_RETRY; attempt++) {
                throwIfAborted(signal);
                try {
                    [url, cached] = await getImgURL(
                        task.projectId,
                        index,
                        signal,
                    );
                    lastError = null;
                    break;
                } catch (e) {
                    if (signal.aborted || isCancelled(e)) throw e;
                    lastError = e;
                    if (attempt < DISCOVERY_RETRY) {
                        await abortableSleep(1500 * attempt, signal);
                    }
                }
            }
            if (lastError) throw lastError;

            if (url === "404") {
                task.totalPages = index - 1;
                await setCachedData(MAX_PAGE_CACHE_KEY(task.projectId), index);
                reachedEnd = true;
                hooks.onChange();
                break;
            }

            task.pages[index] = { status: "downloading" };
            hooks.onChange();
            startDownload(index, url);
            await throttle();
            if (!cached) await abortableSleep(1000, signal);
        }

        await Promise.all(active);
        mainDone = true;
        await retryLoop;
        throwIfAborted(signal);

        if (!reachedEnd && task.totalPages === 0) {
            task.totalPages = MAX_PAGE;
        }

        // 清理超出总页数的历史状态；补齐缺失的页码状态
        for (const index of pageIndices(task)) {
            if (task.totalPages > 0 && index > task.totalPages) {
                delete task.pages[index];
            }
        }
        for (let index = 1; index <= task.totalPages; index++) {
            if (!task.pages[index]) task.pages[index] = { status: "pending" };
        }

        // 最终以 IndexedDB 为准，避免状态与缓存不一致
        const stored = new Set(
            (await listPages(task.projectId)).map((p) => p.index),
        );
        for (const index of pageIndices(task)) {
            if (
                task.pages[index].status === "done" &&
                !stored.has(index)
            ) {
                task.pages[index] = { status: "pending" };
            }
        }

        await finalizeTask(task, hooks);
    } catch (e) {
        stopRetry = true;
        mainDone = true;
        // 等待已经在跑的下载/重试收尾，避免任务结束后仍有页面在后台写入
        await Promise.allSettled([...active]);
        await retryLoop.catch(() => {});
        if (signal.aborted || isCancelled(e)) {
            for (const index of pageIndices(task)) {
                if (task.pages[index].status === "downloading") {
                    task.pages[index] = { status: "pending" };
                }
            }
            task.status = "cancelled";
            task.updatedAt = Date.now();
            hooks.onChange();
            throw new CancelledError();
        }
        const hasDone = pageIndices(task).some(
            (i) => task.pages[i].status === "done",
        );
        task.status = hasDone ? "partial" : "failed";
        task.error = errorMessage(e);
        task.updatedAt = Date.now();
        hooks.onChange();
        throw e;
    }
};

/** 手动重试单页，成功后自动收尾（可能触发 PDF） */
export const retrySinglePage = async (
    task: Task,
    index: number,
    hooks: EngineHooks,
): Promise<void> => {
    task.status = "running";
    task.error = undefined;
    task.updatedAt = Date.now();
    hooks.onChange();

    try {
        throwIfAborted(hooks.signal);
        const [url] = await getImgURL(task.projectId, index, hooks.signal);
        if (url === "404") {
            task.pages[index] = { status: "failed", error: "页面不存在" };
            task.updatedAt = Date.now();
            hooks.onChange();
            await finalizeTask(task, hooks);
            return;
        }
        task.pages[index] = { status: "downloading" };
        hooks.onChange();
        await downloadPage(task, index, url, hooks);
        if (task.totalPages > 0) {
            await finalizeTask(task, hooks);
        } else {
            // 总页数还没探明，单页重试后保持可继续状态
            task.status = "interrupted";
            task.updatedAt = Date.now();
            hooks.onChange();
        }
    } catch (e) {
        if (hooks.signal.aborted || isCancelled(e)) {
            task.status = "cancelled";
            task.updatedAt = Date.now();
            hooks.onChange();
            throw new CancelledError();
        }
        task.status = "failed";
        task.error = errorMessage(e);
        task.updatedAt = Date.now();
        hooks.onChange();
        throw e;
    }
};