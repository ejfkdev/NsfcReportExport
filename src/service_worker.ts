import { DashboardOpenMessage } from "./types";
import { checkCache } from "./utils";

const DASHBOARD_PAGE = "dashboard.html";
const MENU_ID = "@ejfkdev/NsfcReportExportContextMenus";
const CACHE_ALARM = "checkCache";

const extractProjectId = (text?: string): string | undefined => {
    if (!text) return undefined;
    const match = text.match(/[0-9a-fA-F]{32}/);
    return match ? match[0].toLowerCase() : undefined;
};

const findDashboardContext = async () => {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ["TAB"],
    });
    const url = chrome.runtime.getURL(DASHBOARD_PAGE);
    return contexts.find((ctx) => ctx.documentUrl?.startsWith(url));
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OpenOptions = {
    id?: string;
    taskId?: string;
    auto?: boolean;
    sourceTabId?: number;
};

/**
 * 打开（或聚焦已有的）下载管理页。
 * 下载任务在管理页里执行，不受 service worker 生命周期影响。
 */
const openDashboard = async (opts: OpenOptions): Promise<void> => {
    const { id, taskId, auto, sourceTabId } = opts;
    const params = new URLSearchParams();
    if (id) params.set("id", id);
    if (taskId) params.set("task", taskId);
    if (auto) params.set("auto", "1");
    if (sourceTabId != null) params.set("sourceTabId", String(sourceTabId));
    const query = params.toString();
    const targetUrl = chrome.runtime.getURL(DASHBOARD_PAGE) +
        (query ? `?${query}` : "");

    const existing = await findDashboardContext();
    if (existing && existing.tabId >= 0) {
        try {
            await chrome.tabs.update(existing.tabId, { active: true });
            if (existing.windowId >= 0) {
                await chrome.windows.update(existing.windowId, {
                    focused: true,
                });
            }
        } catch {
            // 标签页可能已被关闭
        }

        const message: DashboardOpenMessage = {
            type: "nsfc-dashboard-open",
            id,
            taskId,
            auto,
            sourceTabId,
        };
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await chrome.runtime.sendMessage(message);
                return;
            } catch {
                await delay(300);
            }
        }
        // 页面可能还在初始化，先存起来等它启动后读取
        await chrome.storage.session.set({ nsfcPendingOpen: message });
        return;
    }

    await chrome.tabs.create({ url: targetUrl });
};

// 初始化右键菜单与缓存清理
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            type: "normal",
            id: MENU_ID,
            title: "下载结题报告",
            documentUrlPatterns: ["https://kd.nsfc.cn/finalDetails*"],
        });
        void chrome.runtime.lastError;
    });
    void checkCache();
});

// 右键菜单：打开管理页并立即开始下载
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    const id = extractProjectId(tab?.url);
    void openDashboard({
        id,
        auto: !!id,
        sourceTabId: tab?.id,
    });
});

// 点击工具栏图标：打开管理页（报告页会带入当前报告 ID）
chrome.action.onClicked.addListener((tab) => {
    const id = extractProjectId(tab?.url);
    void openDashboard({
        id,
        auto: false,
        sourceTabId: tab?.id,
    });
});

// 站点页面通过 externally_connectable 调用：沿用 [id, ...] 的消息格式
chrome.runtime.onMessageExternal.addListener(
    (data: any, sender, sendResponse) => {
        const raw = Array.isArray(data)
            ? data[0]
            : typeof data === "string"
            ? data
            : data?.id;
        const id = extractProjectId(String(raw ?? ""));
        if (!id) {
            sendResponse?.({ ok: false, error: "invalid id" });
            return false;
        }
        void openDashboard({
            id,
            auto: true,
            sourceTabId: sender.tab?.id,
        })
            .then(() => sendResponse?.({ ok: true }))
            .catch((e) => sendResponse?.({ ok: false, error: String(e) }));
        return true;
    },
);

// 页内悬浮窗点击「打开下载页」
chrome.runtime.onMessage.addListener((message: any) => {
    if (message?.type === "nsfc-open-dashboard") {
        void openDashboard({ taskId: message.taskId });
    }
});

// 每 7 天清理过期缓存（含 reportToken / 图片地址）
chrome.alarms.create(CACHE_ALARM, {
    periodInMinutes: 60 * 24 * 7,
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CACHE_ALARM) {
        void checkCache();
    }
});