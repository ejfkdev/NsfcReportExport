import { CacheData, GetterSetter } from "./types";

export const getSecureRandomInt = (min: number, max: number) => {
    const range = max - min + 1;
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    const maxRange = Math.floor(0xffffffff / range) * range;
    let result;
    do {
        crypto.getRandomValues(array);
        result = array[0];
    } while (result >= maxRange);
    return min + (result % range);
};

export const inRange = (num: number, min: number, max: number) => {
    return num > min && num < max;
};

export const inRangeInclusive = (num: number, min: number, max: number) => {
    return num >= min && num <= max;
};

export const abortableSleep = (
    ms: number,
    signal?: AbortSignal,
): Promise<void> => {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
};

/**
 * 合并「请求超时」与外部取消信号。
 * AbortSignal.any 需要 Chrome 116+，旧版本用监听器兜底。
 */
export const fetchSignal = (
    timeoutMs: number,
    signal?: AbortSignal,
): AbortSignal => {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeout;

    const anyFn = (AbortSignal as unknown as {
        any?: (signals: AbortSignal[]) => AbortSignal;
    }).any;
    if (typeof anyFn === "function") return anyFn([signal, timeout]);

    const controller = new AbortController();
    const forward = (s: AbortSignal) => {
        if (s.aborted) {
            controller.abort(s.reason);
        } else {
            s.addEventListener("abort", () => controller.abort(s.reason), {
                once: true,
            });
        }
    };
    forward(signal);
    forward(timeout);
    return controller.signal;
};

export const genFetch = async (url: string, signal: AbortSignal) => {
    const u = new URL(url);
    const response = await fetch(url, {
        headers: {
            accept: "application/json, text/plain, */*",
            "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "content-type": "application/x-www-form-urlencoded",
            "origin": u.origin,
            "referer": `https://${u.host}/`,
        },
        // cache: "no-store",
        method: "GET",
        signal,
    });
    if (!response.ok) {
        throw new Error(
            `fetchImageByProxy Error: status ${response.status} ${url}`,
        );
    }
    // 代理失败时可能返回 HTML/JSON 错误页，避免把它当作图片
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html") || contentType.includes("json")) {
        throw new Error(
            `fetchImageByProxy Error: content-type ${contentType} ${url}`,
        );
    }
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    if (buffer.byteLength < 1024 * 10) {
        throw new Error("fetchImageByProxy Error:  too small " + url);
    }
    return buffer;
};

// 图片地址带签名参数（?e=...&s=...），作为代理的 query 参数时必须整体编码
const encodeProxyURL = (imgURL: string) => encodeURIComponent(imgURL);

export const fetchImageByProxyBatch = async (
    imgURL: string,
    signal?: AbortSignal,
) => {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (signal?.aborted) {
        abort.abort();
    } else {
        signal?.addEventListener("abort", onAbort, { once: true });
    }
    const innerSignal = abort.signal;
    const encoded = encodeProxyURL(imgURL);
    // 实测 trace.moe 对带签名 query 的 URL 兼容性最好，作为固定代理；
    // 其余代理随机，直连始终作为最后的兜底
    const traceProxy = `https://trace.moe/image-proxy?url=` + encoded;
    const extras = [
        `https://img03.sogoucdn.com/v2/thumb/?appid=100520147&url=` + encoded,
        `https://img02.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto?appid=122&url=` +
        encoded,
        `https://img01.sogoucdn.com/v2/thumb/?appid=122&url=` + encoded,
        `https://img.noobzone.ru/getimg.php?url=` + encoded,
        `https://99z.top/` + imgURL,
        `https://cors.zme.ink/` + imgURL,
        `https://wsrv.nl/?url=` + encoded,
        `https://images.weserv.nl/?url=` + encoded,
        `https://down.npee.cn/?` + encoded,
        `https://get.2sb.org/` + imgURL,
        `https://cdn.cdnjson.com/pic.html?url=` + encoded,
    ]
        .sort(() => Math.random() - 0.5)
        .slice(0, 2);
    const fetchs = [imgURL, traceProxy, ...extras].map((url) =>
        genFetch(url, innerSignal)
    );
    const timeout = setTimeout(() => abort.abort(), 60000);
    try {
        const buffer = await Promise.any(fetchs);
        return new Uint8Array(buffer);
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        setTimeout(() => abort.abort(), 1);
    }
};

export const fetchImageByProxy = async (imgURL: string) => {
    const encoded = encodeProxyURL(imgURL);
    const rand = getSecureRandomInt(1, 105);
    let proxyUrl = imgURL;
    if (inRangeInclusive(rand, 1, 10)) {
        proxyUrl = `https://img03.sogoucdn.com/v2/thumb/?appid=100520147&url=` +
            encoded;
    } else if (inRangeInclusive(rand, 11, 20)) {
        proxyUrl =
            `https://img02.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto?appid=122&url=` +
            encoded;
    } else if (inRangeInclusive(rand, 21, 30)) {
        proxyUrl = `https://img01.sogoucdn.com/v2/thumb/?appid=122&url=` +
            encoded;
    } else if (inRangeInclusive(rand, 31, 40)) {
        proxyUrl = `https://img.noobzone.ru/getimg.php?url=` + encoded;
    } else if (inRangeInclusive(rand, 41, 50)) {
        proxyUrl = `https://trace.moe/image-proxy?url=` + encoded;
    } else if (inRangeInclusive(rand, 51, 60)) {
        proxyUrl = `https://99z.top/` + imgURL;
    } else if (inRangeInclusive(rand, 61, 70)) {
        proxyUrl = `https://cors.zme.ink/` + imgURL;
    } else if (inRangeInclusive(rand, 71, 80)) {
        proxyUrl = `https://wsrv.nl/?url=` + encoded;
    } else if (inRangeInclusive(rand, 81, 90)) {
        proxyUrl = `https://down.npee.cn/?` + encoded;
    } else if (inRangeInclusive(rand, 91, 100)) {
        proxyUrl = `https://get.2sb.org/` + imgURL;
    } else if (inRangeInclusive(rand, 101, 110)) {
        // proxyUrl = `https://cdn.cdnjson.com/pic.html?url=` + imgURL;
    } else {
        proxyUrl = imgURL;
    }

    const signal = AbortSignal.timeout(30000);
    const u = new URL(proxyUrl);
    const blob = await fetch(proxyUrl, {
        headers: {
            accept: "application/json, text/plain, */*",
            "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "content-type": "application/x-www-form-urlencoded",
            "origin": u.origin,
            "referer": `https://${u.host}/`,
        },
        method: "GET",
        signal,
    })
        .then((response) => {
            if (
                response.ok &&
                response.headers.get("content-type") === "image/png"
            ) {
                return response;
            } else {
                const err = new Error(
                    `fetchImageByProxy Error:  status: ${response.status} content-type ${
                        response.headers.get("content-type")
                    }`,
                );
                err.name = response.status.toString();
                throw err;
            }
        })
        .then((response) => response.blob());
    return blob;
};

export const show = (
    tabId: number | null | undefined,
    title: string,
    message: string,
) => {
    let notiId = "ReportExportNotificationId";
    try {
        notiId && chrome.notifications.create(notiId.toString(), {
            type: "basic",
            iconUrl: "images/logo.png",
            title,
            message,
            silent: true,
        });
    } catch {}

    try {
        notiId && chrome.notifications.update(notiId.toString(), {
            type: "basic",
            iconUrl: "images/logo.png",
            title,
            message,
            silent: true,
        });
    } catch {}

    tabId && chrome.tabs.sendMessage(tabId, {
        title: "正在导出",
        message,
    });
};

export const sortByProperty = <T>(array: T[], key: keyof T): T[] => {
    return array.sort((a, b) => {
        const valueA = a[key];
        const valueB = b[key];
        if (valueA < valueB) return -1;
        if (valueA > valueB) return 1;
        return 0;
    });
};

// 本地缓存
export const setCachedData = async (
    key: string,
    data: any,
    ttl: number = 60 * 60 * 24 * 7,
) => {
    const now = Date.now();
    const cacheData = {
        data,
        expire: now + ttl * 1000, // ttl是秒
    } as CacheData;
    await chrome.storage.local.set({ [key]: cacheData });
};

// 获取本地缓存
export const getCachedData = async (key: string): Promise<CacheData | null> => {
    const result = await chrome.storage.local.get(key);
    const cacheData = result[key] as CacheData;
    if (cacheData) {
        return cacheData;
    } else {
        return null;
    }
};

// 清理过期缓存
const CACHE_KEY_PREFIXES = ["img_", "reportToken_"];

export const checkCache = async () => {
    // 不用 storage.local.getKeys（Chrome 130+），兼容更低版本；
    // 只清理缓存类 key，避免误删任务列表等业务数据
    const all = await chrome.storage.local.get() as Record<string, any>;
    const expired = Object.keys(all).filter((key) => {
        if (!CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
            return false;
        }
        const cacheData = all[key] as CacheData | undefined;
        return !cacheData || cacheData.expire < Date.now();
    });
    if (expired.length > 0) {
        await chrome.storage.local.remove(expired);
    }
};

/**
 * 创建一个简单的 getter/setter 对
 * @template T - 数据类型，默认为 any
 * @returns [getter, setter] - 返回一个包含 getter 和 setter 函数的数组
 * - getter: () => T - 获取存储的值
 * - setter: (v: T) => T - 设置新值并返回设置的值
 *
 * @example
 * const [getValue, setValue] = getset<string>();
 * setValue("hello"); // 设置值
 * console.log(getValue()); // 获取值，输出 "hello"
 */
export const getset = <T = any>(initVal?: T): GetterSetter<T> => {
    let data: T;
    if (initVal != undefined) data = initVal;
    return [
        () => {
            return data;
        },
        (v: T) => {
            return data = v;
        },
    ];
};
