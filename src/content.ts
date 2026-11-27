import { HudTaskPayload, TaskStatus } from "./types";

/**
 * 报告详情页内的悬浮进度窗。
 * 由下载页通过 chrome.tabs.sendMessage 推送任务状态，命令通过 runtime.sendMessage 回传。
 */

const projectId = (
    new URLSearchParams(location.search).get("id") ?? ""
).toLowerCase();

const HOST_ID = "nsfc-report-export-hud";
const POS_KEY = "nsfc-report-export-hud-pos";

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let task: HudTaskPayload | null = null;
let closedByUser = false;
let panelEl: HTMLElement | null = null;
let pillEl: HTMLElement | null = null;
let renderTimer: number | null = null;
let bound = false;

const thumbs = new Map<number, string>();

const statusText: Record<TaskStatus, string> = {
    queued: "排队中",
    running: "正在下载",
    completed: "已完成",
    partial: "部分完成",
    cancelled: "已取消",
    failed: "下载失败",
    interrupted: "已中断",
};

const styles = `
:host { all: initial; }
* { box-sizing: border-box; }

.panel {
    position: fixed;
    right: 22px;
    bottom: 22px;
    width: 336px;
    z-index: 2147483647;
    pointer-events: auto;
    color: #1b2437;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(220, 226, 240, 0.95);
    border-radius: 16px;
    box-shadow: 0 24px 60px -24px rgba(20, 30, 55, 0.45);
    backdrop-filter: blur(14px);
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", sans-serif;
    font-size: 13px;
    line-height: 1.5;
    overflow: hidden;
    animation: hud-in 0.18s ease;
}

@keyframes hud-in {
    from { opacity: 0; transform: translateY(8px); }
}

.panel-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 13px 8px;
    cursor: grab;
    user-select: none;
}

.panel-head:active { cursor: grabbing; }

.dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3b5bfd;
    box-shadow: 0 0 0 4px rgba(59, 91, 253, 0.14);
    flex: none;
}

.dot.done { background: #12a150; box-shadow: 0 0 0 4px rgba(18, 161, 80, 0.14); }
.dot.bad { background: #d92d20; box-shadow: 0 0 0 4px rgba(217, 45, 32, 0.14); }
.dot.warn { background: #b26a00; box-shadow: 0 0 0 4px rgba(178, 106, 0, 0.14); }

.panel-title {
    font-weight: 700;
    font-size: 12.5px;
    letter-spacing: 0.2px;
    flex: 1;
}

.close {
    appearance: none;
    border: 0;
    background: transparent;
    color: #97a2b6;
    font-size: 18px;
    line-height: 1;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    cursor: pointer;
}

.close:hover { background: rgba(25, 35, 55, 0.06); color: #46536b; }

.project {
    padding: 0 14px;
    font-size: 12.5px;
    font-weight: 650;
    color: #23304a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.status-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 14px 8px;
    color: #6b778c;
    font-size: 11.5px;
}

.status-row b { color: #23304a; font-size: 12px; }

.progress {
    height: 7px;
    margin: 0 14px 10px;
    background: #edf0f7;
    border-radius: 999px;
    overflow: hidden;
}

.progress i {
    display: block;
    height: 100%;
    width: 0;
    border-radius: inherit;
    background: linear-gradient(90deg, #3b5bfd, #6d4aff);
    transition: width 0.3s ease;
}

.progress.indeterminate i {
    width: 34% !important;
    animation: hud-slide 1.5s ease-in-out infinite;
}

@keyframes hud-slide {
    0% { transform: translateX(-110%); }
    100% { transform: translateX(390%); }
}

.thumbs {
    display: flex;
    gap: 6px;
    padding: 0 14px 10px;
    overflow-x: auto;
    scrollbar-width: none;
}

.thumbs::-webkit-scrollbar { display: none; }

.thumb {
    position: relative;
    flex: none;
    width: 44px;
    height: 58px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid #e2e7f1;
    background: #f6f8fc;
}

.thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.thumb span {
    position: absolute;
    left: 2px;
    bottom: 2px;
    padding: 0 4px;
    border-radius: 4px;
    background: rgba(18, 26, 43, 0.62);
    color: #fff;
    font-size: 9px;
    line-height: 14px;
    font-weight: 700;
}

.actions {
    display: flex;
    gap: 7px;
    padding: 9px 13px 12px;
    border-top: 1px solid rgba(230, 235, 245, 0.9);
    background: rgba(249, 250, 254, 0.75);
}

.btn {
    appearance: none;
    border: 1px solid #dfe5f0;
    background: #fff;
    color: #3b4a66;
    padding: 6px 10px;
    border-radius: 9px;
    font: inherit;
    font-size: 11.5px;
    font-weight: 650;
    cursor: pointer;
    white-space: nowrap;
}

.btn:hover { background: #f7f9fd; }

.btn.primary {
    border-color: transparent;
    color: #fff;
    background: linear-gradient(135deg, #3b5bfd, #6d4aff);
}

.btn.danger {
    border-color: #ffd9d4;
    background: #ffefed;
    color: #d92d20;
}

.btn.grow { flex: 1; }

.pill {
    position: fixed;
    right: 22px;
    bottom: 22px;
    z-index: 2147483647;
    pointer-events: auto;
    width: 54px;
    height: 54px;
    border-radius: 50%;
    border: 1px solid rgba(219, 226, 240, 0.95);
    background: rgba(255, 255, 255, 0.94);
    box-shadow: 0 18px 40px -18px rgba(20, 30, 55, 0.5);
    backdrop-filter: blur(12px);
    color: #3b5bfd;
    font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
    font-size: 12px;
    font-weight: 800;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    padding: 0;
}

.pill small {
    font-size: 8.5px;
    font-weight: 600;
    color: #8a96ab;
    margin-top: 1px;
}

.pill.done { color: #12a150; }
.pill.bad { color: #d92d20; }
`;

const statusClass = (status: TaskStatus): string => {
    if (status === "running") return "";
    if (status === "completed") return "done";
    if (status === "failed") return "bad";
    if (status === "partial") return "warn";
    return "";
};

const percentOf = (t: HudTaskPayload): number => {
    const done = Object.values(t.pages).filter(
        (p) => p.status === "done",
    ).length;
    if (t.totalPages > 0) {
        return Math.min(100, Math.round((done / t.totalPages) * 100));
    }
    return done > 0 ? 6 : 0;
};

const ensureHost = (): void => {
    if (host && shadow) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
};

const render = (): void => {
    if (!task) return;
    ensureHost();
    if (!shadow) return;

    const doneCount = Object.values(task.pages).filter(
        (p) => p.status === "done",
    ).length;
    const failedCount = Object.values(task.pages).filter(
        (p) => p.status === "failed",
    ).length;
    const percent = percentOf(task);
    const totalLabel = task.totalPages > 0 ? `/${task.totalPages}` : "";
    const running = task.status === "running" || task.status === "queued";

    if (!panelEl) {
        panelEl = document.createElement("div");
        panelEl.className = "panel";
        panelEl.innerHTML =
            '<div class="panel-head">' +
            '<span class="dot"></span>' +
            '<span class="panel-title">报告下载</span>' +
            '<button class="close" data-act="close" title="关闭">×</button>' +
            "</div>" +
            '<div class="project"></div>' +
            '<div class="status-row"><span class="status-text"></span><b class="count"></b></div>' +
            '<div class="progress"><i></i></div>' +
            '<div class="thumbs"></div>' +
            '<div class="actions">' +
            '<button class="btn danger" data-act="cancel">取消</button>' +
            '<button class="btn" data-act="retry-failed">重试失败页</button>' +
            '<button class="btn primary grow" data-act="open-dashboard">打开下载页</button>' +
            "</div>";
        shadow.appendChild(panelEl);
        bindPanel();
    }

    if (!pillEl) {
        pillEl = document.createElement("button");
        pillEl.className = "pill";
        pillEl.dataset.act = "pill";
        pillEl.innerHTML = '<span class="pill-value">0%</span><small>下载中</small>';
        shadow.appendChild(pillEl);
        bindPanel();
    }

    // 位置恢复
    applyStoredPosition();

    const dot = panelEl.querySelector(".dot") as HTMLElement;
    dot.className = `dot ${statusClass(task.status)}`;

    panelEl.querySelector(".project")!.textContent =
        task.projectName || task.projectId.slice(0, 12);

    const statusTextEl = panelEl.querySelector(".status-text")!;
    statusTextEl.textContent = task.status === "running"
        ? `${statusText.running} · ${doneCount}${totalLabel} 页`
        : `${statusText[task.status]}${
            failedCount > 0 ? ` · 失败 ${failedCount} 页` : ""
        }`;
    panelEl.querySelector(".count")!.textContent = `${percent}%`;

    const progress = panelEl.querySelector(".progress") as HTMLElement;
    progress.classList.toggle(
        "indeterminate",
        task.status === "running" && task.totalPages === 0,
    );
    (progress.querySelector("i") as HTMLElement).style.width = `${percent}%`;

    const thumbRoot = panelEl.querySelector(".thumbs") as HTMLElement;
    const sorted = [...thumbs.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(-40);
    thumbRoot.innerHTML = sorted
        .map(
            ([index, dataUrl]) =>
                `<div class="thumb"><img src="${dataUrl}" alt=""><span>${index}</span></div>`,
        )
        .join("");
    thumbRoot.style.display = sorted.length > 0 ? "flex" : "none";

    const cancelBtn = panelEl.querySelector(
        '[data-act="cancel"]',
    ) as HTMLButtonElement;
    cancelBtn.style.display = running ? "" : "none";

    const retryBtn = panelEl.querySelector(
        '[data-act="retry-failed"]',
    ) as HTMLButtonElement;
    retryBtn.style.display = failedCount > 0 && !running ? "" : "none";

    // 收起状态的小圆点
    const pillValue = pillEl.querySelector(".pill-value") as HTMLElement;
    const pillLabel = pillEl.querySelector("small") as HTMLElement;
    pillEl.className = `pill ${statusClass(task.status)}`;
    if (task.status === "completed") {
        pillValue.textContent = "✓";
        pillLabel.textContent = "完成";
    } else if (task.status === "partial" || task.status === "failed") {
        pillValue.textContent = "!";
        pillLabel.textContent = "未完成";
    } else if (task.status === "cancelled" || task.status === "interrupted") {
        pillValue.textContent = "…";
        pillLabel.textContent = statusText[task.status];
    } else {
        pillValue.textContent = `${percent}%`;
        pillLabel.textContent = "下载中";
    }

    applyVisibility();
};

const applyVisibility = (): void => {
    if (!panelEl || !pillEl) return;
    panelEl.style.display = closedByUser ? "none" : "";
    pillEl.style.display = closedByUser ? "" : "none";
};

const applyStoredPosition = (): void => {
    if (!panelEl) return;
    try {
        const raw = sessionStorage.getItem(POS_KEY);
        if (!raw) return;
        const pos = JSON.parse(raw) as { left: number; top: number };
        if (typeof pos.left === "number" && typeof pos.top === "number") {
            panelEl.style.left = `${pos.left}px`;
            panelEl.style.top = `${pos.top}px`;
            panelEl.style.right = "auto";
            panelEl.style.bottom = "auto";
        }
    } catch {
        // 忽略
    }
};

const bindPanel = (): void => {
    if (!panelEl || !shadow || bound) return;
    bound = true;

    shadow.addEventListener("click", (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-act]",
        );
        if (!target) return;
        const act = target.dataset.act;
        if (act === "close") {
            closedByUser = true;
            applyVisibility();
        } else if (act === "pill") {
            closedByUser = false;
            applyVisibility();
        } else if (act === "cancel") {
            if (task) {
                void chrome.runtime.sendMessage({
                    type: "nsfc-hud-command",
                    taskId: task.id,
                    action: "cancel",
                });
            }
        } else if (act === "retry-failed") {
            if (task) {
                void chrome.runtime.sendMessage({
                    type: "nsfc-hud-command",
                    taskId: task.id,
                    action: "retry-failed",
                });
            }
        } else if (act === "open-dashboard") {
            void chrome.runtime.sendMessage({
                type: "nsfc-open-dashboard",
                taskId: task?.id,
            });
        }
    });

    const head = panelEl.querySelector(".panel-head") as HTMLElement;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    head.addEventListener("pointerdown", (event) => {
        if ((event.target as HTMLElement).closest(".close")) return;
        const rect = panelEl!.getBoundingClientRect();
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        head.setPointerCapture(event.pointerId);
    });
    head.addEventListener("pointermove", (event) => {
        if (!dragging || !panelEl) return;
        const left = Math.max(
            8,
            Math.min(
                window.innerWidth - panelEl.offsetWidth - 8,
                startLeft + event.clientX - startX,
            ),
        );
        const top = Math.max(
            8,
            Math.min(
                window.innerHeight - panelEl.offsetHeight - 8,
                startTop + event.clientY - startY,
            ),
        );
        panelEl.style.left = `${left}px`;
        panelEl.style.top = `${top}px`;
        panelEl.style.right = "auto";
        panelEl.style.bottom = "auto";
    });
    head.addEventListener("pointerup", () => {
        if (!dragging || !panelEl) return;
        dragging = false;
        try {
            sessionStorage.setItem(
                POS_KEY,
                JSON.stringify({
                    left: parseFloat(panelEl.style.left) || 0,
                    top: parseFloat(panelEl.style.top) || 0,
                }),
            );
        } catch {
            // 忽略
        }
    });
};

const scheduleRender = (): void => {
    if (renderTimer != null) return;
    renderTimer = window.setTimeout(() => {
        renderTimer = null;
        render();
    }, 100);
};

const applyTask = (next: HudTaskPayload): void => {
    if (projectId && next.projectId !== projectId) return;
    const isNewTask = !task || task.id !== next.id;
    task = next;
    if (isNewTask) {
        closedByUser = false;
        thumbs.clear();
    }
    scheduleRender();
};

chrome.runtime.onMessage.addListener(
    (message: any, _sender, sendResponse) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "nsfc-hud-ping") {
            sendResponse({ projectId });
            return;
        }
        if (message.type === "nsfc-task-update") {
            if (message.task) applyTask(message.task as HudTaskPayload);
            return;
        }
        if (message.type === "nsfc-page-thumb") {
            if (task && message.taskId === task.id) {
                thumbs.set(Number(message.index), String(message.dataUrl));
                scheduleRender();
            }
        }
    },
);

if (projectId) {
    void chrome.runtime
        .sendMessage({ type: "nsfc-page-hello", projectId })
        .catch(() => {});
}