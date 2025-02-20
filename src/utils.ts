import { CacheData, GetterSetter, ToastMsg } from "./types";

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

export const genFetch = async (url: string, signal: AbortSignal) => {
    const u = new URL(url);
    const blob = await fetch(url, {
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
    }).then((response) => response.blob());
    const buffer = await blob.arrayBuffer();
    if (buffer.byteLength < 1024 * 10) {
        throw new Error("fetchImageByProxy Error:  too small " + url);
    }
    return buffer;
};

export const fetchImageByProxyBatch = async (imgURL: string) => {
    const abort = new AbortController();
    const signal = abort.signal;
    const fetchs = [
        `https://img03.sogoucdn.com/v2/thumb/?appid=100520147&url=` + imgURL,
        `https://img02.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto?appid=122&url=` +
        imgURL,
        `https://img01.sogoucdn.com/v2/thumb/?appid=122&url=` + imgURL,
        `https://img.noobzone.ru/getimg.php?url=` + imgURL,
        `https://trace.moe/image-proxy?url=` + imgURL,
        `https://99z.top/` + imgURL,
        `https://cors.zme.ink/` + imgURL,
        `https://wsrv.nl/?url=` + imgURL,
        `https://down.npee.cn/?` + imgURL,
        `https://get.2sb.org/` + imgURL,
        `https://cdn.cdnjson.com/pic.html?url=` + imgURL,
        imgURL,
    ]
        .sort(() => Math.random() - 0.5) // 随机排序
        .slice(0, 3) // 选择前3个
        .map((url) => genFetch(url, signal));
    let timeout = setTimeout(() => abort.abort(), 60000);
    return await Promise.any(fetchs).then((buffer) => {
        clearTimeout(timeout);
        setTimeout(() => abort.abort(), 1);
        return new Uint8Array(buffer);
    });
};

export const fetchImageByProxy = async (imgURL: string) => {
    const rand = getSecureRandomInt(1, 105);
    let proxyUrl = imgURL;
    if (inRangeInclusive(rand, 1, 10)) {
        proxyUrl = `https://img03.sogoucdn.com/v2/thumb/?appid=100520147&url=` +
            imgURL;
    } else if (inRangeInclusive(rand, 11, 20)) {
        proxyUrl =
            `https://img02.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto?appid=122&url=` +
            imgURL;
    } else if (inRangeInclusive(rand, 21, 30)) {
        proxyUrl = `https://img01.sogoucdn.com/v2/thumb/?appid=122&url=` +
            imgURL;
    } else if (inRangeInclusive(rand, 31, 40)) {
        proxyUrl = `https://img.noobzone.ru/getimg.php?url=` + imgURL;
    } else if (inRangeInclusive(rand, 41, 50)) {
        proxyUrl = `https://trace.moe/image-proxy?url=` + imgURL;
    } else if (inRangeInclusive(rand, 51, 60)) {
        proxyUrl = `https://99z.top/` + imgURL;
    } else if (inRangeInclusive(rand, 61, 70)) {
        proxyUrl = `https://cors.zme.ink/` + imgURL;
    } else if (inRangeInclusive(rand, 71, 80)) {
        proxyUrl = `https://wsrv.nl/?url=` + imgURL;
    } else if (inRangeInclusive(rand, 81, 90)) {
        proxyUrl = `https://down.npee.cn/?` + imgURL;
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
export const checkCache = async () => {
    const keys = await chrome.storage.local.getKeys();
    for (const key of keys) {
        const cacheData = await getCachedData(key);
        if (!cacheData || cacheData.expire < Date.now()) {
            await chrome.storage.local.remove(key);
        }
    }
};

// 网页内进度通知
export const pageToast = () => {
    const callback = (data: ToastMsg) => {
        let root = document.querySelector(
            `div#NsfcReportExportToastRoot`,
        ) as HTMLDivElement;
        let title = document.querySelector(
            `div#NsfcReportExportToastTitle`,
        ) as HTMLDivElement;
        let message = document.querySelector(
            `div#NsfcReportExportToastMessage`,
        ) as HTMLDivElement;
        if (document.querySelector(`div#NsfcReportExportToastRoot`) == null) {
            root = document.createElement("div");
            root.id = `NsfcReportExportToastRoot`;
            root.style.cssText = `
        top: 80%;
        left: 0;
        right: 0;
        margin: 0 auto;
        padding: 0.5rem;
        position: fixed;
        display: flex;
        flex-direction: column;
        width: 20rem;
        outline: 0.25rem solid rgb(0 128 255 / 30%);
        border-radius: 1.25rem;
        background-color: rgb(255 255 255 / 50%);
        backdrop-filter: blur(1rem);`;
            title = document.createElement("div");
            title.id = `NsfcReportExportToastTitle`;
            title.style.cssText =
                `font-size:1.25rem; font-weight:bold; color:#444;`;
            message = document.createElement("div");
            message.id = `NsfcReportExportToastMessage`;
            message.style.cssText =
                `color:#666; text-wrap: pretty; word-break: break-word;`;
            root.appendChild(title);
            root.appendChild(message);
            document.body.appendChild(root);
        } else {
            //@ts-ignore
            clearInterval(window["NsfcReportExportToastRootSetTimeout"]);
        }

        title.innerText = data.title;
        message.innerText = data.message;

        if (data.title === "导出完成" || data.title === "导出失败") {
            // chrome.runtime.onMessage.removeListener(callback);
            //@ts-ignore
            window["NsfcReportExportToastRootSetTimeout"] = setTimeout(
                () => document.body.removeChild(root),
                10000,
            );
        }
        return undefined;
    };
    chrome.runtime.onMessage.addListener(callback);
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
