export type ImgResultType = {
    index?: number;
    imageData: Uint8Array;
    width: any;
    height: any;
    orientation: "p" | "l" | "portrait" | "landscape" | undefined;
};

export type ProjectInfo = {
    projectName: string;
    /** 项目负责人（一个人） */
    projectAdmin: string;
    /** 依托单位 */
    projectUnit: string;
    conclusionAbstract: string;
    projectKeywordC: string;
};

export type CacheData = {
    data: any;
    expire: number;
};

export type Getter<T> = () => T;
export type Setter<T> = (v: T) => T | void;

export type GetterSetter<T> = [
    getter: Getter<T>,
    setter: Setter<T>,
];

/* ------------------------------ 下载任务 ------------------------------ */

export type PageStatus =
    | "pending"
    | "downloading"
    | "done"
    | "failed";

export type PageState = {
    status: PageStatus;
    error?: string;
    width?: number;
    height?: number;
};

export type TaskStatus =
    | "queued"
    | "running"
    | "completed"
    | "partial"
    | "cancelled"
    | "failed"
    | "interrupted";

export type TaskPdfState = {
    status: "idle" | "generating" | "done" | "failed";
    error?: string;
    downloadId?: number;
};

export type Task = {
    /** 任务唯一 id */
    id: string;
    /** 报告 id（32 位 hex） */
    projectId: string;
    projectName: string;
    /** 项目负责人（一个人） */
    projectAdmin: string;
    /** 依托单位 */
    projectUnit: string;
    conclusionAbstract: string;
    projectKeywordC: string;
    status: TaskStatus;
    /** 已探明的总页数，0 表示未知 */
    totalPages: number;
    /** 已探测到的最远页码 */
    exploredPages: number;
    pages: Record<number, PageState>;
    createdAt: number;
    updatedAt: number;
    /** 从报告详情页发起时记录来源标签页，用于页内悬浮窗 */
    sourceTabId?: number;
    error?: string;
    pdf: TaskPdfState;
};

export type TaskProgress = {
    done: number;
    failed: number;
    downloading: number;
    pending: number;
};

/* ------------------------------ 消息协议 ------------------------------ */

/** 发给页面内悬浮窗的精简任务数据 */
export type HudTaskPayload = {
    id: string;
    projectId: string;
    projectName: string;
    status: TaskStatus;
    totalPages: number;
    exploredPages: number;
    pages: Record<number, PageState>;
    error?: string;
};

export type HudCommandAction =
    | "cancel"
    | "retry-failed"
    | "open-dashboard"
    | "hide";

/** 下载页 -> 悬浮窗 */
export type ToHudMessage =
    | { type: "nsfc-task-update"; task: HudTaskPayload }
    | { type: "nsfc-page-thumb"; taskId: string; index: number; dataUrl: string };

/** 悬浮窗 -> 下载页 / service worker */
export type FromHudMessage =
    | {
        type: "nsfc-hud-command";
        taskId: string;
        action: HudCommandAction;
    }
    | { type: "nsfc-open-dashboard"; taskId?: string }
    | { type: "nsfc-page-hello"; projectId: string };

/** service worker / 其他入口 -> 下载页 */
export type DashboardOpenMessage = {
    type: "nsfc-dashboard-open";
    id?: string;
    taskId?: string;
    auto?: boolean;
    sourceTabId?: number;
};

export type AnyMessage = ToHudMessage | FromHudMessage | DashboardOpenMessage;