import { imageDimensionsFromData } from "image-dimensions";
import { jsPDF } from "jspdf";
import {
  AsyncPool,
  Resolve,
  TaskCallbackArgs,
  sleep,
} from "@ejfkdev/async-pool";
import sortBy from "lodash/sortBy";

const host = "https://kd.nsfc.cn";

let downloading = false;
// 标签页id，用于发送页内通知
let tabId: number = 0;

const init = () => {
  console.log("onInstalled");
  chrome.contextMenus.create({
    type: "normal",
    id: "@ejfkdev/NsfcReportExportContextMenus",
    title: "下载结题报告",
    documentUrlPatterns: ["https://kd.nsfc.cn/finalDetails*"],
  });
  checkCache();
};

chrome.runtime.onInstalled.addListener(init);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case "@ejfkdev/NsfcReportExportContextMenus":
      setTask(tab);
  }
});

chrome.action.onClicked.addListener((tab) => {
  setTask(tab);
});

// 网页内进度通知
const pageToast = () => {
  const callback = (data: ToastMsg) => {
    let root = document.querySelector(
      `div#NsfcReportExportToastRoot`
    ) as HTMLDivElement;
    let title = document.querySelector(
      `div#NsfcReportExportToastTitle`
    ) as HTMLDivElement;
    let message = document.querySelector(
      `div#NsfcReportExportToastMessage`
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
      title.style.cssText = `font-size:1.25rem; font-weight:bold; color:#444;`;
      message = document.createElement("div");
      message.id = `NsfcReportExportToastMessage`;
      message.style.cssText = `color:#666; text-wrap: pretty; word-break: break-word;`;
      root.appendChild(title);
      root.appendChild(message);
      document.body.appendChild(root);
    } else {
      //@ts-ignore
      clearInterval(window["NsfcReportExportToastRootSetTimeout"]);
    }

    title.innerText = data.title;
    message.innerText = data.message;

    if (data.type === "done") {
      // chrome.runtime.onMessage.removeListener(callback);
      //@ts-ignore
      window["NsfcReportExportToastRootSetTimeout"] = setTimeout(
        () => document.body.removeChild(root),
        10000
      );
    }
    return undefined;
  };
  chrome.runtime.onMessage.addListener(callback);
};

// 启动下载任务
const setTask = async (tab?: chrome.tabs.Tab) => {
  if (tab == undefined || tab.url == undefined || tab.id == undefined) return;
  const url = new URL(tab.url);
  const id = url.searchParams.get("id");
  if (id == null || downloading) return;
  downloading = true;
  console.log("setTask", id);
  tabId = tab.id;
  chrome.scripting.executeScript({
    target: { tabId },
    func: pageToast,
  });
  await chrome.action.setBadgeText({ text: "⏬" });
  try {
    await ReportExport(id);
  } catch (e: any) {
    console.log((e as Error).name, (e as Error).message);
    chrome.tabs.sendMessage(tabId, {
      type: "done",
      title: "导出失败",
      message: (e as Error).message,
    });
  }
  downloading = false;
  tabId = 0;
  await chrome.action.setBadgeText({ text: "" });
};

let fetchFromCache = false;
/**
 * 获取一页报告图片
 * @param id 报告id
 * @param index 第几页
 * @returns
 */
const fetchTask = async ([id, index, info]: [
  string,
  number,
  ProjectInfo,
]): Promise<ImgResultType> => {
  console.log(
    "ReportExport",
    id,
    "正在导出",
    `${info.projectName} 第${index}页`
  );
  chrome.tabs.sendMessage(tabId, {
    title: "正在导出",
    message: `${info.projectName} 第${index}页`,
  });
  let imgURL = "";
  const cacheData = await getCachedData(`img_${id}_${index}`);
  if (cacheData?.data) {
    imgURL = cacheData.data;
  } else {
    const data = await fetch(`${host}/api/baseQuery/completeProjectReport`, {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `id=${id}&index=${index}`,
      method: "POST",
    }).then((response) => response.json());
    imgURL = host + data.data.url;
  }
  await setCachedData(`img_${id}_${index}`, imgURL, 60 * 60 * 24 * 7);
  console.log(id, index, imgURL);
  // 获取图片内容
  const blob = await fetch(imgURL, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "GET",
  })
    .then((response) => {
      if (response.ok) return response;
      else {
        const err = new Error(`HTTP error! status: ${response.status}`);
        err.name = response.status.toString();
        throw err;
      }
    })
    .then((response) => response.blob());
  const per = performance
    .getEntriesByName(imgURL)
    .slice(-1)[0] as PerformanceResourceTiming;
  fetchFromCache = per.transferSize == 0;
  const imgArrayBuffer = new Uint8Array(await blob.arrayBuffer());
  // 从图片内容解析宽高
  const size = imageDimensionsFromData(imgArrayBuffer);
  return {
    index,
    imageData: imgArrayBuffer,
    width: size?.width,
    height: size?.height,
    // pdf竖版或横版页
    orientation: (size?.width ?? 0) < (size?.height ?? 0) ? "p" : "l",
  };
};

/**
 * 获取报告名称等基础信息
 * @param id
 * @returns
 */
const getProjectInfo = async (id: string): Promise<ProjectInfo> => {
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
    }
  );
  if (response.ok) {
    const data = await response.json();
    return {
      projectName: data?.data?.projectName ?? "projectName",
      projectAdmin:
        (data?.data?.projectAdmin ?? "") + " " + (data?.data?.dependUnit ?? ""),
      conclusionAbstract: data?.data?.conclusionAbstract ?? "",
      projectKeywordC: data?.data?.projectKeywordC ?? "",
    };
  } else {
    return {
      projectName: "projectName",
      projectAdmin: "",
      conclusionAbstract: "",
      projectKeywordC: "",
    };
  }
};

/**
 * 获取完整报告并保存pdf
 * @param id
 */
const ReportExport = async (id: string) => {
  console.log("ReportExport", id);
  const startTime = Date.now();
  const info = await getProjectInfo(id);
  let notiId = "ReportExportStart";
  try {
    notiId = await chrome.notifications.create(notiId, {
      type: "basic",
      iconUrl: "images/logo.png",
      title: "正在导出",
      message: info.projectName,
      silent: true,
    });
  } catch {}

  chrome.tabs.sendMessage(tabId, {
    title: "正在导出",
    message: info.projectName,
  });

  const doc = new jsPDF({
    compress: true,
  });
  doc.setDocumentProperties({
    title: info.projectName,
    subject: info.conclusionAbstract,
    author: info.projectAdmin,
    keywords: info.projectKeywordC,
    creator: "@ejfkdev",
  });
  doc.deletePage(1);
  let imgFetchDone = false;
  let imgCache: ImgResultType[] = [];
  // const [pend, done, cancel] = WaitDelayPend(5000, 1000 * 60 * 60);
  // 页数递增获取图片，遇到404即为最后一页
  const imgPool = new AsyncPool<[string, number, ProjectInfo]>({
    name: "获取图片并插入PDF",
    parallel: 4,
    maxRetryCount: 100,
    worker: fetchTask,
    rateLimiter: async (done: Resolve) => {
      console.log("rate", fetchFromCache);
      if (!fetchFromCache) {
        await sleep(1050);
      }
      done();
    },
    allWorkerDoneCallback: () => {
      // done();
    },
    taskErrorCallback: async (
      args: TaskCallbackArgs<[string, number, ProjectInfo]>
    ) => {
      console.log(args.error, args.data);
      fetchFromCache = false;
      if (!args.error.message.includes("404")) {
        // cancel();
        // console.log(Date.now(), `暂停`, args.error.message, args.data);
        // await args.pool.pause(async (resolve) => {
        //   await sleep(2050);
        //   console.log(Date.now(), `恢复`);
        //   resolve();
        // });
        args.retry();
      } else {
        imgFetchDone = true;
        console.log(`imgFetchDone 报告图片获取完成`, index);
      }
    },
    taskResultCallback: (
      args: TaskCallbackArgs<[string, number, ProjectInfo]>
    ) => {
      // cancel();
      if (args.error != null) return;
      console.log("图片下载完成", args.data);
      imgCache.push(args.result as ImgResultType);
    },
  });

  let index = 0;
  while (++index) {
    if (imgFetchDone) break;
    await imgPool.waitParallelIdel();
    try {
      await chrome.notifications.update(notiId, {
        type: "basic",
        iconUrl: "images/logo.png",
        title: "正在导出",
        message: `${info.projectName} 第${index}页`,
        silent: true,
      });
    } catch {}
    // cancel();
    imgPool.addTodo([id, index, info]);
    await sleep(50);
  }

  // await sleep(5000);
  await imgPool.waitAllWorkerDone();
  // await pend();

  console.log("生成中", imgCache.length);
  try {
    await chrome.notifications.update(notiId, {
      type: "basic",
      iconUrl: "images/logo.png",
      title: "正在导出",
      message: `${info.projectName}.pdf 生成中`,
      silent: true,
    });
  } catch {}

  chrome.tabs.sendMessage(tabId, {
    title: "正在导出",
    message: `${info.projectName}.pdf 生成中`,
  });

  // 图片下载可能乱序，保存前按页码排序
  imgCache = sortBy(imgCache, "index");

  for (const data of imgCache) {
    doc.addPage([data.width, data.height], data.orientation);
    doc.addImage({
      imageData: data.imageData,
      format: "PNG",
      x: 0,
      y: 0,
      width: data.width,
      height: data.height,
      compression: "FAST",
    });
  }

  const pdfUrl = doc.output("datauristring");
  const filename = `${info.projectName}.pdf`.replace(/[/\\?%*:|"<>]/g, "-");
  chrome.downloads.download(
    {
      url: pdfUrl,
      filename: filename,
      conflictAction: "uniquify",
      saveAs: false,
    },
    function (downloadId) {
      console.log(`文件下载，ID: ${downloadId}`);
    }
  );
  let costTime = (Date.now() - startTime) / 1000 / 60;
  costTime = Math.ceil(costTime);
  console.log(
    "ReportExport",
    id,
    "导出完成",
    filename,
    `耗时${costTime}分钟`,
    `共${imgCache.length}页`
  );
  try {
    await chrome.notifications.update(notiId, {
      type: "basic",
      iconUrl: "images/logo.png",
      title: "导出完成",
      message: `${filename}保存在浏览器默认下载 共${imgCache.length}页 用时${costTime}分钟`,
      silent: false,
    });
  } catch {}
  chrome.tabs.sendMessage(tabId, {
    type: "done",
    title: "导出完成",
    message: `${filename}保存在浏览器默认下载 共${imgCache.length}页 用时${costTime}分钟`,
  });
  checkCache();
};

const onMessage = (data: any, sender: chrome.runtime.MessageSender) => {
  if (!Array.isArray(data) || data.length != 2) return;
  console.log("sw.js onMessage get message:", data);
  console.log("sw.js onMessage get sender:", sender);
  ReportExport(data[0]);
  return true;
};

// 本地缓存
const setCachedData = async (key: string, data: string, ttl: number) => {
  const now = Date.now();
  const cacheData = {
    data,
    expire: now + ttl * 1000, // ttl是秒
  } as CacheData;
  await chrome.storage.local.set({ [key]: cacheData });
};

// 获取本地缓存
const getCachedData = async (key: string): Promise<CacheData | null> => {
  const result = await chrome.storage.local.get(key);
  const cacheData = result[key] as CacheData;
  if (cacheData && cacheData.expire > Date.now()) {
    return cacheData;
  } else {
    return null;
  }
};

const checkCache = async () => {
  const keys = await chrome.storage.local.getKeys();
  for (const key of keys) {
    const cacheData = await getCachedData(key);
    if (!cacheData || cacheData.expire > Date.now()) {
      await chrome.storage.local.remove(key);
    }
  }
};

// 创建名为 "checkCache" 的定时任务，每 10080 分钟（7 天）运行一次
chrome.alarms.create("checkCache", {
  periodInMinutes: 60 * 24 * 7,
});

// 监听定时任务事件
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkCache") {
    checkCache();
  }
});

// https://kd.nsfc.cn/finalDetails?id=18762a8003cdc2a63d65957925f6c67d
// ReportExport('18762a8003cdc2a63d65957925f6c67d');
// https://kd.nsfc.cn/finalDetails?id=161cd5723f90c0d39423fb838e32f809

chrome.runtime.onMessageExternal.addListener(onMessage);

type ImgResultType = {
  index: number;
  imageData: Uint8Array;
  width: any;
  height: any;
  orientation: "p" | "l" | "portrait" | "landscape" | undefined;
};

type ToastMsg = {
  type?: "show" | "done";
  title: string;
  message: string;
};

type ProjectInfo = {
  projectName: string;
  projectAdmin: string;
  conclusionAbstract: string;
  projectKeywordC: string;
};

type CacheData = {
  data: string;
  expire: number;
};
