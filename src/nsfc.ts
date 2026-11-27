import { imageDimensionsFromData } from "image-dimensions";
import { ImgResultType, ProjectInfo } from "./types";
import {
    abortableSleep,
    fetchImageByProxyBatch,
    fetchSignal,
    getCachedData,
    setCachedData,
} from "./utils";
import { solveCaptcha } from "./captcha";

const host = "https://kd.nsfc.cn";

// 图片签名地址有效期（秒）。URL 自带过期参数，且使用前会 HEAD 校验，过期会自动重新申请
const IMG_URL_TTL = 60 * 60;
// reportToken 缓存时间（秒），失效时自动重新过验证码
const REPORT_TOKEN_TTL = 30 * 60;
// 单页取地址的最大尝试次数（第二次会强制刷新 token）
const PAGE_ATTEMPTS = 2;

type ReportPageData = {
    url: string;
    reportToken?: string;
};

type ReportPageResult =
    | { kind: "ok"; url: string; reportToken?: string }
    | { kind: "missing" }
    | { kind: "error"; message: string };

const tokenKey = (id: string) => `reportToken_${id}`;

// 内存中的 token 缓存 + 并发去重（同一项目只过一次验证码）
const tokenMemory = new Map<string, { token: string; expire: number }>();
const tokenPending = new Map<string, Promise<string>>();

/**
 * 获取一页报告图片
 * @param imgURL 图片地址
 * @returns ImgResultType
 */
export const getImgBlob = async (
    imgURL: string,
    signal?: AbortSignal,
): Promise<ImgResultType> => {
    // 获取图片内容
    const imgArrayBuffer = await fetchImageByProxyBatch(imgURL, signal);
    // 从图片内容解析宽高
    const size = imageDimensionsFromData(imgArrayBuffer);
    return {
        imageData: imgArrayBuffer,
        width: size?.width,
        height: size?.height,
        // pdf竖版或横版页
        orientation: (size?.width ?? 0) < (size?.height ?? 0) ? "p" : "l",
    };
};

/**
 * 统一 POST 表单接口，带重试（源站偶尔返回 HTML 网关错误页）
 */
const postForm = async (
    path: string,
    body: Record<string, string | number>,
    attempts = 3,
    signal?: AbortSignal,
): Promise<any> => {
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) form[k] = String(v);

    let lastErr: Error = new Error(`请求失败: ${path}`);
    for (let i = 0; i < attempts; i++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const response = await fetch(host + path, {
                headers: {
                    accept: "application/json, text/plain, */*",
                    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                    "content-type": "application/x-www-form-urlencoded",
                    authorization: "Bearer false",
                },
                body: new URLSearchParams(form).toString(),
                method: "POST",
                signal: fetchSignal(15000, signal),
            });
            const text = await response.text();
            const t = text.trimStart();
            if (!t.startsWith("{") && !t.startsWith("[")) {
                lastErr = new Error(
                    `非 JSON 响应 (HTTP ${response.status}): ${
                        text.slice(0, 100)
                    }`,
                );
            } else {
                return JSON.parse(text);
            }
        } catch (e) {
            if (signal?.aborted) throw e;
            lastErr = e as Error;
        }
        await abortableSleep(500 * (i + 1), signal);
    }
    throw lastErr;
};

const absUrl = (u: string) => u.startsWith("http") ? u : host + u;

/**
 * 保存 / 读取 / 清除 reportToken
 */
const saveReportToken = async (id: string, token: string) => {
    tokenMemory.set(id, {
        token,
        expire: Date.now() + REPORT_TOKEN_TTL * 1000,
    });
    await setCachedData(tokenKey(id), token, REPORT_TOKEN_TTL);
};

const readReportToken = async (id: string): Promise<string | null> => {
    const mem = tokenMemory.get(id);
    if (mem && mem.expire > Date.now()) return mem.token;

    const cached = await getCachedData(tokenKey(id));
    if (cached?.data && cached.expire > Date.now()) {
        tokenMemory.set(id, { token: cached.data, expire: cached.expire });
        return cached.data;
    }
    return null;
};

const clearReportToken = async (id: string) => {
    tokenMemory.delete(id);
    await chrome.storage.local.remove(tokenKey(id));
};

/**
 * 过一次验证码并打开报告首页，换取 reportToken
 */
const openReport = async (
    id: string,
    signal?: AbortSignal,
): Promise<string> => {
    let lastErr: Error = new Error("验证码未通过");
    for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const captcha = await solveCaptcha(signal);
            if (!captcha.ok) {
                lastErr = new Error(`验证码未通过: ${captcha.repCode}`);
                continue;
            }
            const data = await postForm(
                "/api/baseQuery/completeProjectReport",
                {
                    id,
                    index: 1,
                    tryCode: captcha.captchaVerification,
                },
                3,
                signal,
            );
            if (data.code === 200 && data.data?.reportToken) {
                return data.data.reportToken as string;
            }
            lastErr = new Error(
                `打开报告失败: ${data.code} ${data.message ?? ""}`.trim(),
            );
        } catch (e) {
            if (signal?.aborted) throw e;
            lastErr = e as Error;
        }
    }
    throw lastErr;
};

/**
 * 获取（必要时自动刷新）reportToken。
 * 同一项目并发调用会共享同一次验证码流程。
 * @param force 强制刷新（token 被判失效时使用）
 */
export const ensureReportToken = async (
    id: string,
    force = false,
    signal?: AbortSignal,
): Promise<string> => {
    if (force) {
        await clearReportToken(id);
    } else {
        const token = await readReportToken(id);
        if (token) return token;
    }

    const pending = tokenPending.get(id);
    if (pending) return pending;

    const task = openReport(id, signal)
        .then(async (token) => {
            await saveReportToken(id, token);
            return token;
        })
        .finally(() => tokenPending.delete(id));
    tokenPending.set(id, task);
    return task;
};

const headStatus = async (
    url: string,
    signal?: AbortSignal,
): Promise<number> => {
    try {
        const response = await fetch(url, {
            method: "HEAD",
            cache: "no-store",
            signal: fetchSignal(15000, signal),
        });
        return response.status;
    } catch {
        return signal?.aborted ? -1 : 0;
    }
};

/**
 * 越界页的地址会在有效页路径后再拼一段固定 32 位串（共 64 位 hex）
 */
const isOutOfRangeURL = (url: string): boolean => {
    const path = url.split("?")[0];
    const seg = path.split("/").pop() ?? "";
    return /^[0-9a-f]{64}$/i.test(seg);
};

/**
 * 请求某一页的签名图片地址
 * @param token reportToken
 */
const requestReportPage = async (
    id: string,
    index: number,
    token: string,
    signal?: AbortSignal,
): Promise<ReportPageResult> => {
    const data = await postForm("/api/baseQuery/completeProjectReport", {
        id,
        index,
        reportToken: token,
    }, 3, signal);
    if (data.code === 400) {
        // 页码错误，即越界
        return { kind: "missing" };
    }
    if (data.code !== 200 || !data.data?.url) {
        return {
            kind: "error",
            message: `${data.code} ${data.message ?? ""}`.trim(),
        };
    }
    const page = data.data as ReportPageData;
    return {
        kind: "ok",
        url: absUrl(page.url),
        reportToken: page.reportToken,
    };
};

/**
 * 获取某一页的图片地址（先过验证码换取 reportToken，再带 token 请求）
 * @param id 报告id
 * @param index 第几页
 * @returns [图片地址 | "404", 是否来自缓存]
 */
export const getImgURL = async (
    id: string,
    index: number,
    signal?: AbortSignal,
): Promise<[string, boolean]> => {
    const cacheKey = `img_${id}_${index}`;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // 先尝试缓存地址：HEAD 通过才算可用，签名过期则重新申请
    const cacheData = await getCachedData(cacheKey);
    if (cacheData?.data) {
        const status = await headStatus(cacheData.data, signal);
        if (status === 200) {
            return [cacheData.data as string, true];
        }
        if (status === -1) throw new DOMException("Aborted", "AbortError");
        // 签名过期 / 资源不存在时清掉缓存；429、5xx 等临时错误保留，下次仍可复用
        if ([401, 403, 404, 410].includes(status)) {
            await chrome.storage.local.remove(cacheKey);
        }
    }

    let token = await ensureReportToken(id, false, signal);
    let refreshed = false;

    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const page = await requestReportPage(id, index, token, signal);

        if (page.kind === "missing") {
            return ["404", false];
        }

        if (page.kind === "error") {
            if (!refreshed) {
                refreshed = true;
                token = await ensureReportToken(id, true, signal);
                continue;
            }
            throw new Error(`获取第${index}页失败: ${page.message}`);
        }

        // 接口有时会随响应下发新的 reportToken
        if (page.reportToken) {
            await saveReportToken(id, page.reportToken);
        }

        if (isOutOfRangeURL(page.url)) {
            return ["404", false];
        }

        const status = await headStatus(page.url, signal);
        if (status === -1) throw new DOMException("Aborted", "AbortError");
        if (status === 404) {
            return ["404", false];
        }
        // 站点的图片服务器可能返回 429/5xx（限流/网关），不应因此中断整份报告；
        // 地址本身是刚签发的，交给下载阶段重试即可
        if (status !== 200) {
            console.warn(`HEAD ${status} ${page.url}`);
        }

        await setCachedData(cacheKey, page.url, IMG_URL_TTL);
        return [page.url, false];
    }

    throw new Error(`获取第${index}页失败`);
};

/**
 * 获取报告名称等基础信息
 * @param id
 * @returns
 */
export const getProjectInfo = async (
    id: string,
    signal?: AbortSignal,
): Promise<ProjectInfo> => {
    console.log("getProjectInfo", id);
    const response = await fetch(
        `${host}/api/baseQuery/conclusionProjectInfo/${id}`,
        {
            headers: {
                accept: "application/json, text/plain, */*",
                "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                "content-type": "application/x-www-form-urlencoded",
            },
            body: null,
            method: "POST",
            mode: "cors",
            signal: fetchSignal(15000, signal),
        },
    );
    if (response.ok) {
        const data = await response.json();
        return {
            projectName: data?.data?.projectName ?? "projectName",
            projectAdmin: data?.data?.projectAdmin ?? "",
            projectUnit: data?.data?.dependUnit ?? "",
            conclusionAbstract: data?.data?.conclusionAbstract ?? "",
            projectKeywordC: data?.data?.projectKeywordC ?? "",
        };
    } else {
        return {
            projectName: "projectName",
            projectAdmin: "",
            projectUnit: "",
            conclusionAbstract: "",
            projectKeywordC: "",
        };
    }
};