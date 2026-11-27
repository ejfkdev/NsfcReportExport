import {
    DashboardOpenMessage,
    HudTaskPayload,
    PageState,
    Task,
    TaskStatus,
} from "./types";
import {
    CancelledError,
    EngineHooks,
    finalizeTask,
    getProgress,
    isCancelled,
    retrySinglePage,
    runTask,
} from "./engine";
import { deleteProjectPages, getPage } from "./idb";

const STORAGE_KEY = "nsfc_tasks_v2";
const MAX_RENDER_PAGES = 500;

/* ------------------------------ DOM 工具 ------------------------------ */

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
    document.querySelector(sel) as T;

const esc = (value: unknown): string =>
    String(value ?? "").replace(/[&<>"']/g, (c) => {
        switch (c) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            default:
                return "&#39;";
        }
    });

const statusText: Record<TaskStatus, string> = {
    queued: "排队中",
    running: "下载中",
    completed: "已完成",
    partial: "部分完成",
    cancelled: "已取消",
    failed: "失败",
    interrupted: "已中断",
};

const statusPillClass = (status: TaskStatus): string => {
    if (status === "queued") return "pill";
    return `pill ${status}`;
};

/* ------------------------------- 状态 -------------------------------- */

let tasks: Task[] = [];
let selectedId: string | null = null;
let activeTaskId: string | null = null;
let activeAbort: AbortController | null = null;
let queueRunning = false;
/** 用户加入队列的顺序（任务 id） */
let queueOrder: string[] = [];

/** projectId -> 报告详情页所在 tabId */
const pageTabs = new Map<string, number>();

const thumbCache = new Map<string, string>();
const thumbQueued = new Set<string>();
const thumbJobs: Array<{ task: Task; index: number; blob?: Blob }> = [];
let thumbWorkers = 0;

const notified = new Set<string>();

/* ------------------------------ 持久化 ------------------------------- */

let saveTimer: number | null = null;

const stateSnapshot = () => ({ tasks, selectedId });

const persistNow = async (): Promise<void> => {
    if (saveTimer != null) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: stateSnapshot() });
};

const persist = (): void => {
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void chrome.storage.local.set({ [STORAGE_KEY]: stateSnapshot() });
    }, 250);
};

/* ------------------------------ 渲染调度 ------------------------------ */

let renderTimer: number | null = null;

const render = (): void => {
    renderTaskList();
    renderDetail();
    renderQueueState();
    updateBadge();
};

const scheduleRender = (): void => {
    if (renderTimer != null) return;
    renderTimer = window.setTimeout(() => {
        renderTimer = null;
        render();
    }, 140);
};

const selectedTask = (): Task | null =>
    tasks.find((t) => t.id === selectedId) ?? null;

/* ------------------------------ 任务 UI ------------------------------ */

const renderTaskList = (): void => {
    const root = $("#taskList");
    $("#taskCount").textContent = String(tasks.length);
    if (tasks.length === 0) {
        root.innerHTML =
            '<div class="empty-state" style="min-height:120px;padding:18px 0">' +
            '<p>还没有任务。粘贴报告链接或 ID 开始下载。</p></div>';
        return;
    }
    root.innerHTML = tasks
        .map((task) => {
            const progress = getProgress(task);
            const total = task.totalPages;
            const percent = total > 0
                ? Math.min(100, Math.round((progress.done / total) * 100))
                : progress.done > 0
                ? 6
                : 0;
            return (
                `<div class="task-item${
                    task.id === selectedId ? " selected" : ""
                }" data-task-id="${esc(task.id)}">` +
                '<div class="task-item-head">' +
                `<span class="task-item-name">${esc(
                    task.projectName || task.projectId.slice(0, 10),
                )}</span>` +
                `<span class="${statusPillClass(task.status)}">${
                    statusText[task.status]
                }</span>` +
                "</div>" +
                `<div class="mini-bar"><i style="width:${percent}%"></i></div>` +
                '<div class="task-item-meta">' +
                `<span>${progress.done}${
                    total > 0 ? "/" + total : ""
                } 页</span>` +
                `<span>${task.projectId.slice(0, 8)}</span>` +
                "</div>" +
                "</div>"
            );
        })
        .join("");
};

const statusLine = (task: Task): string => {
    const progress = getProgress(task);
    const total = task.totalPages;
    const parts: string[] = [];
    parts.push(`${progress.done}${total > 0 ? "/" + total : ""} 页`);
    if (progress.failed > 0) parts.push(`失败 ${progress.failed}`);
    if (progress.downloading > 0) parts.push(`下载中 ${progress.downloading}`);
    if (task.status === "running" && total === 0) parts.push("正在探测页数");
    return parts.join(" · ");
};

const pageStateOf = (task: Task, index: number): PageState =>
    task.pages[index] ?? { status: "pending" };

const thumbKey = (projectId: string, index: number) =>
    `${projectId}:${index}`;

const renderPageTile = (task: Task, index: number): string => {
    const state = pageStateOf(task, index);
    const key = thumbKey(task.projectId, index);
    const url = thumbCache.get(key);
    const stateIcon = state.status === "done"
        ? "✓"
        : state.status === "failed"
        ? "!"
        : state.status === "downloading"
        ? '<span class="spinner"></span>'
        : "";
    const skeleton = state.status === "done" && !url
        ? `<div class="page-skeleton">第 ${index} 页</div>`
        : "";
    return (
        `<button class="page-tile ${state.status}" data-action="preview" data-index="${index}" ` +
        `title="${state.status === "done" ? "点击预览" : esc(state.error ?? statusText[
            task.status
        ])}">` +
        (url ? `<img data-thumb-key="${esc(key)}" src="${url}" alt="">` : `<img data-thumb-key="${esc(key)}" alt="">`) +
        skeleton +
        `<span class="page-num">${index}</span>` +
        `<span class="page-state">${stateIcon}</span>` +
        "</button>"
    );
};

const renderDetail = (): void => {
    const root = $("#detail");
    const task = selectedTask();
    if (!task) {
        root.innerHTML =
            '<div class="empty-state">' +
            '<div class="empty-icon">▤</div>' +
            "<h3>从一份报告开始</h3>" +
            "<p>在左侧粘贴报告链接或 32 位报告 ID，会自动识别验证码并逐页下载，最后合并成 PDF。已下载的页面会保存在本地，失败或取消后再次继续不会重复下载。</p>" +
            "</div>";
        return;
    }

    const progress = getProgress(task);
    const total = task.totalPages;
    const known = total > 0;
    const percent = known
        ? Math.min(100, Math.round((progress.done / total) * 100))
        : progress.done > 0
        ? 6
        : 0;
    const running = task.status === "running";
    const allDone = known && progress.done >= total && progress.failed === 0;
    const canStart = !running && !allDone && progress.failed === 0;
    const canRetry = !running && progress.failed > 0;
    const canPdf = !running && allDone && task.pdf.status !== "generating";
    const canForcePdf = !running && !allDone && progress.done > 0 &&
        task.pdf.status !== "generating" && task.pdf.status !== "done";
    const hasPageTab = !!task.sourceTabId ||
        pageTabs.has(task.projectId);

    const actions: string[] = [];
    if (running || task.status === "queued") {
        actions.push(
            `<button class="btn danger" data-action="cancel">${
                task.status === "queued" ? "取消排队" : "取消下载"
            }</button>`,
        );
    }
    if (canStart) {
        actions.push(
            `<button class="btn primary" data-action="start">${
                progress.done > 0 ? "继续下载" : "开始下载"
            }</button>`,
        );
    }
    if (canRetry) {
        actions.push(
            `<button class="btn soft" data-action="start">重试失败页 (${progress.failed})</button>`,
        );
    }
    if (canPdf) {
        actions.push(
            `<button class="btn ghost" data-action="start">${
                task.pdf.status === "done" ? "重新生成 PDF" : "生成 PDF"
            }</button>`,
        );
    }
    if (canForcePdf) {
        actions.push(
            '<button class="btn soft" data-action="pdf-force">跳过失败页生成 PDF</button>',
        );
    }
    if (hasPageTab) {
        actions.push(
            '<button class="btn ghost" data-action="show-hud">在报告页显示悬浮窗</button>',
        );
    }
    actions.push(
        '<button class="btn ghost" data-action="open-page">打开报告页</button>',
    );
    actions.push(
        '<button class="btn ghost" data-action="clear-cache">清理图片缓存</button>',
    );
    actions.push(
        '<button class="btn danger" data-action="delete">删除任务</button>',
    );

    const pagesCount = known
        ? total
        : Math.min(
            MAX_RENDER_PAGES,
            Math.max(
                task.exploredPages,
                ...Object.keys(task.pages).map((k) => Number(k)),
                0,
            ),
        );
    const tiles: string[] = [];
    for (let index = 1; index <= pagesCount; index++) {
        tiles.push(renderPageTile(task, index));
    }
    const pagesBlock = pagesCount > 0
        ? `<div class="pages-head"><h3>页面</h3><span>点击已下载页面可预览，失败页可在预览里重试</span></div>
           <div class="page-grid">${tiles.join("")}</div>`
        : '<div class="pages-head"><h3>页面</h3><span>开始下载后这里会显示每一页的缩略图</span></div>';

    const errorBlock = task.error
        ? task.status === "partial"
            ? `<div class="amber-note">${esc(task.error)}${
                progress.failed > 0
                    ? "。已下载页面都保存在本地，点击「重试失败页」只会补下载失败的页面。"
                    : ""
            }</div>`
            : `<div class="error-note">${esc(task.error)}</div>`
        : "";
    const pdfBlock = task.pdf.status === "failed"
        ? `<div class="error-note">PDF 生成失败：${esc(
            task.pdf.error ?? "",
        )}。图片仍在本地，可点击上方按钮重试。</div>`
        : "";

    root.innerHTML =
        '<div class="detail-head">' +
        "<div>" +
        `<h2 class="detail-title">${esc(
            task.projectName || "未命名报告",
        )}</h2>` +
        '<div class="detail-sub">' +
        `<span class="mono">${esc(task.projectId)}</span>` +
        `<span>${esc(
            [task.projectAdmin, task.projectUnit].filter(Boolean).join(" · ") ||
                "—",
        )}</span>` +
        `<span>创建于 ${new Date(task.createdAt).toLocaleString()}</span>` +
        "</div></div>" +
        `<span class="${statusPillClass(task.status)}">${
            statusText[task.status]
        }</span>` +
        "</div>" +
        `<div class="detail-actions">${actions.join("")}</div>` +
        '<div class="progress-block">' +
        '<div class="progress-top">' +
        `<strong>${running ? "正在下载" : statusText[task.status]}</strong>` +
        `<span>${esc(statusLine(task))}</span>` +
        "</div>" +
        `<div class="progress${
            known ? "" : " indeterminate"
        }"><i style="width:${percent}%"></i></div>` +
        '<div class="stat-row">' +
        `<span class="stat done">已下载 <b>${progress.done}</b></span>` +
        `<span class="stat failed">失败 <b>${progress.failed}</b></span>` +
        `<span class="stat">总页数 <b>${known ? total : "探测中"}</b></span>` +
        "</div></div>" +
        errorBlock +
        pdfBlock +
        pagesBlock;

    // 已缓存页面按需生成缩略图
    for (const [index, state] of Object.entries(task.pages)) {
        if (state.status === "done") {
            enqueueThumb(task, Number(index));
        }
    }
};

const renderQueueState = (): void => {
    const el = $("#queueState");
    const queued = tasks.filter((t) => t.status === "queued").length;
    if (activeTaskId) {
        el.textContent = queued > 0
            ? `正在下载 · 队列还有 ${queued} 个`
            : "正在下载";
        el.classList.add("busy");
    } else if (queued > 0) {
        el.textContent = `队列中有 ${queued} 个任务`;
        el.classList.add("busy");
    } else {
        el.textContent = "空闲";
        el.classList.remove("busy");
    }
};

const updateBadge = (): void => {
    const running = tasks.some((t) => t.status === "running") ||
        !!activeTaskId;
    void chrome.action.setBadgeText({ text: running ? "⏬" : "" });
    if (running) {
        void chrome.action.setBadgeBackgroundColor({ color: "#3b5bfd" });
    }
};

/* ------------------------------ 缩略图 ------------------------------- */

const makeThumb = async (blob: Blob): Promise<string> => {
    const bitmap = await createImageBitmap(blob);
    const maxWidth = 240;
    const scale = Math.min(1, maxWidth / (bitmap.width || maxWidth));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    return canvas.toDataURL("image/webp", 0.72);
};

const updateTileThumb = (key: string, dataUrl: string): void => {
    document
        .querySelectorAll<HTMLImageElement>(
            `img[data-thumb-key="${key}"]`,
        )
        .forEach((img) => {
            img.src = dataUrl;
            const skeleton = img.parentElement?.querySelector(
                ".page-skeleton",
            );
            skeleton?.remove();
        });
};

const pumpThumbs = (): void => {
    while (thumbWorkers < 3 && thumbJobs.length > 0) {
        const job = thumbJobs.shift()!;
        thumbWorkers++;
        const key = thumbKey(job.task.projectId, job.index);
        void (async () => {
            let blob = job.blob;
            if (!blob) {
                const record = await getPage(job.task.projectId, job.index);
                blob = record?.blob;
            }
            if (!blob) return;
            const dataUrl = await makeThumb(blob);
            thumbCache.set(key, dataUrl);
            thumbQueued.delete(key);
            updateTileThumb(key, dataUrl);
            sendThumb(job.task, job.index, dataUrl);
        })()
            .catch(() => {
                thumbQueued.delete(key);
            })
            .finally(() => {
                thumbWorkers--;
                pumpThumbs();
            });
    }
};

const enqueueThumb = (
    task: Task,
    index: number,
    blob?: Blob,
): void => {
    const key = thumbKey(task.projectId, index);
    if (thumbCache.has(key) || thumbQueued.has(key)) return;
    thumbQueued.add(key);
    thumbJobs.push({ task, index, blob });
    pumpThumbs();
};

/* ------------------------------ HUD 同步 ------------------------------ */

const hudPayload = (task: Task): HudTaskPayload => ({
    id: task.id,
    projectId: task.projectId,
    projectName: task.projectName,
    status: task.status,
    totalPages: task.totalPages,
    exploredPages: task.exploredPages,
    pages: { ...task.pages },
    error: task.error,
});

const hudTimers = new Map<string, number>();

const hudTabId = (task: Task): number | undefined =>
    task.sourceTabId ?? pageTabs.get(task.projectId);

const sendHud = (task: Task): void => {
    const tabId = hudTabId(task);
    if (tabId == null) return;
    task.sourceTabId = tabId;
    void chrome.tabs
        .sendMessage(tabId, {
            type: "nsfc-task-update",
            task: hudPayload(task),
        })
        .catch(() => {
            // 报告页可能已经关闭
        });
};

const syncHud = (task: Task, immediate = false): void => {
    if (!hudTabId(task)) return;
    if (immediate) {
        const timer = hudTimers.get(task.id);
        if (timer != null) {
            clearTimeout(timer);
            hudTimers.delete(task.id);
        }
        sendHud(task);
        return;
    }
    if (hudTimers.has(task.id)) return;
    const timer = window.setTimeout(() => {
        hudTimers.delete(task.id);
        sendHud(task);
    }, 250);
    hudTimers.set(task.id, timer);
};

const sendThumb = (
    task: Task,
    index: number,
    dataUrl: string,
): void => {
    const tabId = hudTabId(task);
    if (tabId == null) return;
    void chrome.tabs
        .sendMessage(tabId, {
            type: "nsfc-page-thumb",
            taskId: task.id,
            index,
            dataUrl,
        })
        .catch(() => {});
};

/** HUD 重新挂载（页面刷新/任务恢复）时补齐已下载页面的缩略图 */
const sendAllThumbs = (task: Task): void => {
    const tabId = hudTabId(task);
    if (tabId == null) return;
    for (const [rawIndex, state] of Object.entries(task.pages)) {
        if (state.status !== "done") continue;
        const index = Number(rawIndex);
        const dataUrl = thumbCache.get(thumbKey(task.projectId, index));
        if (dataUrl) {
            void chrome.tabs
                .sendMessage(tabId, {
                    type: "nsfc-page-thumb",
                    taskId: task.id,
                    index,
                    dataUrl,
                })
                .catch(() => {});
        } else {
            enqueueThumb(task, index);
        }
    }
};

/* ------------------------------ 任务执行 ------------------------------ */

const hooksFor = (task: Task, signal: AbortSignal): EngineHooks => ({
    signal,
    onChange: () => {
        task.updatedAt = Date.now();
        persist();
        scheduleRender();
        syncHud(task);
    },
    onPageSaved: (index, blob) => {
        enqueueThumb(task, index, blob);
        syncHud(task, true);
    },
    onNotice: (message) => toast(message),
});

const notifyTask = (task: Task): void => {
    if (!["completed", "partial", "failed"].includes(task.status)) return;
    if (notified.has(task.id)) return;
    notified.add(task.id);
    const total = task.totalPages;
    const title = task.status === "completed" ? "导出完成" : "导出未完成";
    const message = task.status === "completed"
        ? `${task.projectName} 共 ${total} 页，PDF 已保存到下载目录`
        : `${task.projectName}：${task.error ?? statusText[task.status]}`;
    void chrome.notifications.create(`nsfc-${task.id}`, {
        type: "basic",
        iconUrl: "images/logo128.png",
        title,
        message,
        silent: true,
    });
};

const ENGINE_LOCK = "nsfc-report-export-engine";

const withExclusive = async (
    task: Task,
    run: (signal: AbortSignal) => Promise<void>,
): Promise<void> => {
    if (activeTaskId) return;

    const execute = async (): Promise<void> => {
        if (activeTaskId) return;
        activeTaskId = task.id;
        selectedId = task.id;
        const controller = new AbortController();
        activeAbort = controller;
        notified.delete(task.id);
        if (!task.sourceTabId) {
            task.sourceTabId = pageTabs.get(task.projectId);
        }
        syncHud(task, true);
        sendAllThumbs(task);
        updateBadge();
        render();

        try {
            await run(controller.signal);
        } catch (e) {
            if (!isCancelled(e) && !(e instanceof CancelledError)) {
                toast(`任务失败：${(e as Error).message ?? e}`, true);
            }
        } finally {
            if (activeAbort === controller) {
                activeAbort = null;
                activeTaskId = null;
            }
            persistNow();
            render();
            syncHud(task, true);
            notifyTask(task);
            updateBadge();
            void processQueue();
        }
    };

    // 跨标签页串行：即使误开了两个下载页，也保证同一时间只有一个任务在下载
    if (navigator.locks?.request) {
        await navigator.locks.request(ENGINE_LOCK, execute);
    } else {
        await execute();
    }
};

const startTask = (task: Task): Promise<void> =>
    withExclusive(task, (signal) => runTask(task, hooksFor(task, signal)));

const enqueueTask = (id: string): void => {
    queueOrder = queueOrder.filter((item) => item !== id);
    queueOrder.push(id);
};

const dequeueTask = (id: string): void => {
    queueOrder = queueOrder.filter((item) => item !== id);
};

const processQueue = async (): Promise<void> => {
    if (queueRunning || activeTaskId) return;
    queueRunning = true;
    renderQueueState();
    try {
        while (!activeTaskId) {
            // 优先按用户加入队列的顺序，其次按任务列表顺序
            let next: Task | undefined;
            while (queueOrder.length > 0 && !next) {
                const id = queueOrder.shift()!;
                const task = tasks.find((t) => t.id === id);
                if (task && task.status === "queued") next = task;
            }
            next ??= tasks.find((t) => t.status === "queued");
            if (!next) break;
            dequeueTask(next.id);
            await startTask(next);
        }
    } finally {
        queueRunning = false;
        renderQueueState();
    }
};

/** 用户点击开始/继续/重试/生成 PDF 都走队列，保证同一时间只有一个任务在跑 */
const requestStart = (task: Task): void => {
    if (activeTaskId === task.id) return;
    task.status = "queued";
    enqueueTask(task.id);
    selectedId = task.id;
    if (activeTaskId || queueRunning) {
        toast("已加入队列，当前任务结束后开始");
    }
    persist();
    render();
    void processQueue();
};

const cancelTask = (task: Task): void => {
    if (activeTaskId === task.id && activeAbort) {
        activeAbort.abort();
        return;
    }
    if (task.status === "queued") {
        task.status = "cancelled";
        dequeueTask(task.id);
        task.updatedAt = Date.now();
        persist();
        render();
    }
};

const retryPage = async (task: Task, index: number): Promise<void> => {
    if (activeTaskId || queueRunning) {
        toast("请等待当前任务结束再重试单页");
        return;
    }
    await withExclusive(task, (signal) =>
        retrySinglePage(task, index, hooksFor(task, signal))
    );
};

/* ------------------------------ 批量解析 ------------------------------ */

const parseProjectIds = (text: string): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const re = /[0-9a-fA-F]{32}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
        const id = match[0].toLowerCase();
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }
    return ids;
};

const updateParseHint = (): void => {
    const text = $<HTMLTextAreaElement>("#batchInput").value;
    const ids = parseProjectIds(text);
    const hint = $("#parseHint");
    if (!text.trim()) {
        hint.textContent = "等待粘贴…";
        hint.className = "parse-hint";
    } else if (ids.length === 0) {
        hint.textContent = "未识别到有效报告 ID（需要 32 位十六进制）";
        hint.className = "parse-hint bad";
    } else {
        hint.textContent = `识别到 ${ids.length} 个报告`;
        hint.className = "parse-hint ok";
    }
};

const createTask = (projectId: string, sourceTabId?: number): Task => ({
    id: crypto.randomUUID(),
    projectId,
    projectName: "",
    projectAdmin: "",
    projectUnit: "",
    conclusionAbstract: "",
    projectKeywordC: "",
    status: "queued",
    totalPages: 0,
    exploredPages: 0,
    pages: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceTabId,
    pdf: { status: "idle" },
});

/**
 * 添加任务：每个报告只保留一个任务。
 * 已存在的任务直接复用（缓存按 projectId 存储，图片不会重下）。
 * autoStart 时，已完成的旧任务会复用缓存重新导出 PDF。
 */
const addTasks = (
    ids: string[],
    autoStart: boolean,
    sourceTabId?: number,
): Task[] => {
    const uniqueIds = [...new Set(ids)];
    const touched: Task[] = [];
    const created: Task[] = [];
    const byProject = new Map(tasks.map((t) => [t.projectId, t]));

    for (const projectId of uniqueIds) {
        let task = byProject.get(projectId);
        if (!task) {
            task = createTask(
                projectId,
                sourceTabId ?? pageTabs.get(projectId),
            );
            byProject.set(projectId, task);
            created.push(task);
        } else if (task.sourceTabId == null) {
            task.sourceTabId = sourceTabId ?? pageTabs.get(projectId);
        }
        touched.push(task);
    }

    // 新任务按输入顺序放到列表顶部
    for (const task of [...created].reverse()) tasks.unshift(task);

    if (touched.length > 0) selectedId = touched[0].id;
    persistNow();
    render();

    if (autoStart && touched.length > 0) {
        for (const task of touched) {
            if (task.status === "running") continue;
            task.status = "queued";
            enqueueTask(task.id);
        }
        persist();
        render();
        void processQueue();
    }
    return touched;
};

const handleAdd = (autoStart: boolean): void => {
    const ids = parseProjectIds($<HTMLTextAreaElement>("#batchInput").value);
    if (ids.length === 0) {
        toast("没有识别到有效的报告 ID", true);
        return;
    }
    const beforeCount = tasks.length;
    addTasks(ids, autoStart);
    const createdCount = tasks.length - beforeCount;
    $<HTMLTextAreaElement>("#batchInput").value = "";
    updateParseHint();

    if (autoStart) {
        toast(
            createdCount > 0
                ? "已添加并开始下载"
                : "已使用现有任务，复用本地缓存重新导出",
        );
    } else {
        toast(
            createdCount > 0
                ? "已添加到任务列表"
                : "已选中现有任务，缓存可直接复用",
        );
    }
};

/* ------------------------------ 页面预览 ------------------------------ */

let modalUrl: string | null = null;

const closeModal = (): void => {
    $("#modalRoot").innerHTML = "";
    if (modalUrl) {
        URL.revokeObjectURL(modalUrl);
        modalUrl = null;
    }
};

const openPreview = async (task: Task, index: number): Promise<void> => {
    const record = await getPage(task.projectId, index);
    if (!record) {
        toast("这一页还没有下载完成", true);
        return;
    }
    closeModal();
    modalUrl = URL.createObjectURL(record.blob);
    const doneIndices = Object.keys(task.pages)
        .map(Number)
        .filter((i) => task.pages[i].status === "done")
        .sort((a, b) => a - b);
    const pos = doneIndices.indexOf(index);
    const prev = pos > 0 ? doneIndices[pos - 1] : null;
    const next = pos >= 0 && pos < doneIndices.length - 1
        ? doneIndices[pos + 1]
        : null;

    $("#modalRoot").innerHTML =
        '<div class="modal-backdrop" data-backdrop="1">' +
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-head">' +
        `<h3>第 ${index} 页<span class="sub">${esc(
            task.projectName || task.projectId,
        )}</span></h3>` +
        '<button class="icon-btn" data-close="1" title="关闭">×</button>' +
        "</div>" +
        `<div class="modal-body"><img src="${modalUrl}" alt="第 ${index} 页"></div>` +
        '<div class="modal-foot">' +
        '<div class="left">' +
        `<button class="btn ghost small" data-nav="${prev ?? ""}" ${
            prev == null ? "disabled" : ""
        }>上一页</button>` +
        `<button class="btn ghost small" data-nav="${next ?? ""}" ${
            next == null ? "disabled" : ""
        }>下一页</button>` +
        "</div>" +
        '<div class="right">' +
        `<button class="btn soft small" data-retry="${index}">重试此页</button>` +
        `<a class="btn ghost small" href="${modalUrl}" download="第${index}页.png">下载此页 PNG</a>` +
        '<button class="btn ghost small" data-close="1">关闭</button>' +
        "</div></div></div></div>";
};

/* ------------------------------- 其他动作 ------------------------------ */

const showHudForTask = async (task: Task): Promise<void> => {
    await discoverPageTabs();
    const tabId = task.sourceTabId ?? pageTabs.get(task.projectId);
    if (tabId == null) {
        toast("没有找到这个报告对应的页面，请先打开报告详情页", true);
        return;
    }
    try {
        await chrome.tabs.sendMessage(tabId, {
            type: "nsfc-task-update",
            task: hudPayload(task),
        });
    } catch {
        delete task.sourceTabId;
        persist();
        render();
        toast("报告页面已关闭，请重新打开报告详情页", true);
        return;
    }
    task.sourceTabId = tabId;
    persist();
    syncHud(task, true);
    sendAllThumbs(task);
    toast("已在报告页显示悬浮窗");
};

const clearTaskCache = async (task: Task): Promise<void> => {
    if (activeTaskId) {
        toast("请先取消正在进行的任务", true);
        return;
    }
    if (!confirm("确定要删除这个报告已下载的图片缓存吗？")) return;
    await deleteProjectPages(task.projectId);
    for (const key of [...thumbCache.keys()]) {
        if (key.startsWith(task.projectId + ":")) {
            thumbCache.delete(key);
            thumbQueued.delete(key);
        }
    }
    for (const t of tasks) {
        if (t.projectId !== task.projectId) continue;
        for (const index of Object.keys(t.pages).map(Number)) {
            t.pages[index] = { status: "pending" };
        }
        t.totalPages = 0;
        t.exploredPages = 0;
        t.pdf = { status: "idle" };
        t.status = "interrupted";
        t.error = undefined;
    }
    persistNow();
    render();
    toast("图片缓存已清理");
};

const deleteTask = (task: Task): void => {
    if (activeTaskId === task.id) {
        toast("请先取消正在进行的任务", true);
        return;
    }
    if (!confirm("确定删除这个任务吗？已下载的图片缓存会保留。")) return;
    tasks = tasks.filter((t) => t.id !== task.id);
    dequeueTask(task.id);
    if (selectedId === task.id) {
        selectedId = tasks[0]?.id ?? null;
    }
    persistNow();
    render();
};

const discoverPageTabs = async (): Promise<void> => {
    try {
        const tabs = await chrome.tabs.query({});
        await Promise.all(
            tabs.map(async (tab) => {
                if (tab.id == null) return;
                try {
                    const reply = await chrome.tabs.sendMessage(tab.id, {
                        type: "nsfc-hud-ping",
                    });
                    if (reply?.projectId) {
                        pageTabs.set(
                            String(reply.projectId).toLowerCase(),
                            tab.id,
                        );
                    }
                } catch {
                    // 该标签页没有内容脚本
                }
            }),
        );
    } catch {
        // 忽略
    }
};

const toast = (message: string, bad = false): void => {
    const el = document.createElement("div");
    el.className = `toast${bad ? " bad" : ""}`;
    el.textContent = message;
    $("#toastRoot").appendChild(el);
    window.setTimeout(() => el.remove(), 3200);
};

/* ------------------------------ 消息处理 ------------------------------ */

const handleHudCommand = (message: {
    taskId: string;
    action: string;
}): void => {
    const task = tasks.find((t) => t.id === message.taskId);
    if (!task) return;
    if (message.action === "cancel") {
        cancelTask(task);
    } else if (message.action === "retry-failed") {
        requestStart(task);
    } else if (message.action === "open-dashboard") {
        selectedId = task.id;
        render();
        window.focus();
    }
};

const handleOpenRequest = (message: DashboardOpenMessage): void => {
    if (message.taskId) {
        const task = tasks.find((t) => t.id === message.taskId);
        if (task) {
            selectedId = task.id;
            persist();
            render();
            return;
        }
    }
    if (!message.id) return;
    const projectId = message.id.toLowerCase();
    $<HTMLTextAreaElement>("#batchInput").value = projectId;
    updateParseHint();

    if (message.auto) {
        addTasks([projectId], true, message.sourceTabId);
        return;
    }

    const existing = tasks.find((t) => t.projectId === projectId);
    if (existing) {
        selectedId = existing.id;
        persist();
        render();
        toast("该报告已在任务列表，缓存可直接复用");
    } else {
        toast("已识别当前报告，点击「添加并开始」");
    }
};

chrome.runtime.onMessage.addListener(
    (
        message: any,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void,
    ) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "nsfc-page-hello") {
            const projectId = String(message.projectId ?? "").toLowerCase();
            if (sender.tab?.id != null && projectId) {
                pageTabs.set(projectId, sender.tab.id);
                const task = tasks.find(
                    (t) =>
                        t.projectId === projectId &&
                        ["running", "partial", "queued", "interrupted"].includes(
                            t.status,
                        ),
                );
                if (task) {
                    task.sourceTabId = sender.tab.id;
                    persist();
                    scheduleRender();
                    syncHud(task, true);
                    sendAllThumbs(task);
                }
            }
            sendResponse?.({ ok: true });
        } else if (message.type === "nsfc-hud-command") {
            handleHudCommand(message);
            sendResponse?.({ ok: true });
        } else if (message.type === "nsfc-dashboard-open") {
            handleOpenRequest(message as DashboardOpenMessage);
            sendResponse?.({ ok: true });
        }
    },
);

/* ------------------------------- 事件绑定 ------------------------------ */

$<HTMLTextAreaElement>("#batchInput").addEventListener("input", updateParseHint);
$("#addOnly").addEventListener("click", () => handleAdd(false));
$("#addStart").addEventListener("click", () => handleAdd(true));

$("#taskList").addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-task-id]",
    );
    if (!item) return;
    selectedId = item.dataset.taskId ?? null;
    persist();
    render();
});

$("#detail").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>("[data-action]");
    const navEl = target.closest<HTMLElement>("[data-nav]");
    const task = selectedTask();

    if (navEl && task) {
        const index = Number(navEl.dataset.nav);
        if (index > 0) void openPreview(task, index);
        return;
    }
    if (!actionEl || !task) return;
    const action = actionEl.dataset.action;
    switch (action) {
        case "start":
            requestStart(task);
            break;
        case "pdf-force":
            if (activeTaskId || queueRunning) {
                toast("请等待当前任务结束");
                break;
            }
            void withExclusive(task, (signal) =>
                finalizeTask(task, hooksFor(task, signal), {
                    allowMissing: true,
                })
            );
            break;
        case "cancel":
            cancelTask(task);
            break;
        case "delete":
            deleteTask(task);
            break;
        case "clear-cache":
            void clearTaskCache(task);
            break;
        case "show-hud":
            void showHudForTask(task);
            break;
        case "open-page":
            window.open(
                `https://kd.nsfc.cn/finalDetails?id=${task.projectId}`,
                "_blank",
                "noopener",
            );
            break;
        case "preview": {
            const index = Number(actionEl.dataset.index);
            if (task.pages[index]?.status === "done") {
                void openPreview(task, index);
            } else if (task.pages[index]?.status === "failed") {
                const error = task.pages[index].error ?? "下载失败";
                if (confirm(`第 ${index} 页下载失败：${error}\n\n要重试这一页吗？`)) {
                    void retryPage(task, index);
                }
            }
            break;
        }
        default:
            break;
    }
});

// 预览弹窗事件
$("#modalRoot").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.dataset.backdrop === "1" || target.closest("[data-close]")) {
        closeModal();
        return;
    }
    const retryEl = target.closest<HTMLElement>("[data-retry]");
    if (retryEl) {
        const task = selectedTask();
        const index = Number(retryEl.dataset.retry);
        closeModal();
        if (task) void retryPage(task, index);
        return;
    }
    const navEl = target.closest<HTMLElement>("[data-nav]");
    if (navEl) {
        const task = selectedTask();
        const index = Number(navEl.dataset.nav);
        if (task && index > 0) void openPreview(task, index);
    }
});

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#modalRoot").children.length > 0) {
        closeModal();
    }
});

window.addEventListener("beforeunload", (event) => {
    if (activeTaskId) {
        event.preventDefault();
        event.returnValue = "";
    }
});

window.addEventListener("pagehide", () => {
    if (activeTaskId) {
        const task = tasks.find((t) => t.id === activeTaskId);
        if (task && task.status === "running") {
            task.status = "interrupted";
            for (const state of Object.values(task.pages)) {
                if (state.status === "downloading") state.status = "pending";
            }
        }
        void persistNow();
    }
    void chrome.action.setBadgeText({ text: "" });
});

/* -------------------------------- 启动 -------------------------------- */

const normalizeTasks = (): void => {
    for (const task of tasks) {
        if (task.status === "running") task.status = "interrupted";
        if (!task.pdf) task.pdf = { status: "idle" };
        if (!task.pages) task.pages = {};
        if (typeof task.projectUnit !== "string") task.projectUnit = "";
        for (const state of Object.values(task.pages)) {
            if (state.status === "downloading") state.status = "pending";
        }
    }
};

const handleQueryParams = (): void => {
    const params = new URLSearchParams(location.search);
    const id = (params.get("id") ?? "").trim().toLowerCase();
    const auto = params.get("auto") === "1";
    const taskId = params.get("task");
    const sourceTabId = Number(params.get("sourceTabId")) || undefined;
    if (!id && !auto && !taskId && !sourceTabId) return;

    history.replaceState(null, "", location.pathname);

    if (taskId) {
        const task = tasks.find((t) => t.id === taskId);
        if (task) selectedId = task.id;
    }
    if (id) {
        $<HTMLTextAreaElement>("#batchInput").value = id;
        updateParseHint();
        if (auto) {
            addTasks([id], true, sourceTabId);
        } else {
            toast("已识别当前报告，点击「添加并开始」");
        }
    }
};

const STATUS_PRIORITY: Record<TaskStatus, number> = {
    running: 6,
    queued: 5,
    interrupted: 4,
    partial: 3,
    completed: 2,
    cancelled: 1,
    failed: 0,
};

const mergeTaskState = (base: Task, extra: Task): void => {
    for (const [rawIndex, page] of Object.entries(extra.pages)) {
        const index = Number(rawIndex);
        const current = base.pages[index];
        if (!current || (page.status === "done" && current.status !== "done")) {
            base.pages[index] = page;
        }
    }
    base.totalPages = Math.max(base.totalPages, extra.totalPages);
    base.exploredPages = Math.max(base.exploredPages, extra.exploredPages);
    base.projectName ||= extra.projectName;
    base.projectAdmin ||= extra.projectAdmin;
    base.projectUnit ||= extra.projectUnit;
    base.conclusionAbstract ||= extra.conclusionAbstract;
    base.projectKeywordC ||= extra.projectKeywordC;
    base.sourceTabId ??= extra.sourceTabId;
    if (base.pdf.status !== "done" && extra.pdf.status === "done") {
        base.pdf = extra.pdf;
    }
    base.updatedAt = Math.max(base.updatedAt, extra.updatedAt);
    if (STATUS_PRIORITY[extra.status] > STATUS_PRIORITY[base.status]) {
        base.status = extra.status;
    }
};

/** 同一个报告只保留一个任务；合并重复任务已下载的页面与状态 */
const dedupeTasks = (): void => {
    const byProject = new Map<string, Task>();
    const result: Task[] = [];
    for (const task of tasks) {
        const base = byProject.get(task.projectId);
        if (!base) {
            byProject.set(task.projectId, task);
            result.push(task);
            continue;
        }
        mergeTaskState(base, task);
    }
    tasks = result;

    for (const task of tasks) {
        if (task.totalPages <= 0) continue;
        let allDone = true;
        for (let index = 1; index <= task.totalPages; index++) {
            if (task.pages[index]?.status !== "done") {
                allDone = false;
                break;
            }
        }
        if (allDone && task.status !== "running" && task.status !== "queued") {
            task.status = task.pdf.status === "done" ? "completed" : "partial";
            task.error = task.status === "completed"
                ? undefined
                : "PDF 尚未生成，可重新导出";
        }
    }

    const ids = new Set(tasks.map((t) => t.id));
    if (selectedId && !ids.has(selectedId)) {
        selectedId = tasks[0]?.id ?? null;
    }
    if (!selectedId && tasks.length > 0) selectedId = tasks[0].id;
};

const validateSourceTabs = async (): Promise<void> => {
    for (const task of tasks) {
        if (task.sourceTabId == null) continue;
        try {
            await chrome.tabs.get(task.sourceTabId);
        } catch {
            delete task.sourceTabId;
        }
    }
};

const boot = async (): Promise<void> => {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const saved = data?.[STORAGE_KEY];
    if (saved && Array.isArray(saved.tasks)) {
        tasks = saved.tasks as Task[];
        selectedId = saved.selectedId ?? null;
    }
    normalizeTasks();
    dedupeTasks();
    await validateSourceTabs();
    if (!selectedId && tasks.length > 0) selectedId = tasks[0].id;
    if (selectedId && !tasks.some((t) => t.id === selectedId)) {
        selectedId = tasks[0]?.id ?? null;
    }

    handleQueryParams();

    try {
        const pending = (await chrome.storage.session.get("nsfcPendingOpen"))
            ?.nsfcPendingOpen as DashboardOpenMessage | undefined;
        if (pending) {
            await chrome.storage.session.remove("nsfcPendingOpen");
            handleOpenRequest(pending);
        }
    } catch {
        // session storage 不可用时忽略
    }

    updateParseHint();
    render();
    void persistNow();
    void discoverPageTabs().finally(() => {
        // 上次关闭页面时还在排队的任务，重新打开后继续队列
        if (tasks.some((t) => t.status === "queued")) {
            void processQueue();
        }
    });
};

void boot();