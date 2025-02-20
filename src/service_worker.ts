import { jsPDF } from "jspdf";
import { AsyncPool } from "./async-pool/async-pool";
import { TaskItem } from "./async-pool/type";
import { sleep } from "./async-pool/utils";
import { Getter, ImgResultType, ProjectInfo } from "./types";
import {
  checkCache,
  getCachedData,
  getset,
  pageToast,
  setCachedData,
  show,
  sortByProperty,
} from "./utils";
import { getImgBlob, getImgURL, getProjectInfo } from "./nsfc";

let downloading = false;
// 标签页id，用于发送页内通知
let tabId: number = 0;

// 初始化，增加右键菜单项
chrome.runtime.onInstalled.addListener(() => {
  console.log("onInstalled");
  chrome.contextMenus.create({
    type: "normal",
    id: "@ejfkdev/NsfcReportExportContextMenus",
    title: "下载结题报告",
    documentUrlPatterns: ["https://kd.nsfc.cn/finalDetails*"],
  });
  checkCache();
});

// 右键菜单下载
chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case "@ejfkdev/NsfcReportExportContextMenus":
      setTask(tab);
  }
});

// 插件小图标下载
chrome.action.onClicked.addListener((tab) => {
  setTask(tab);
});

chrome.runtime.onMessageExternal.addListener(
  (data: any, sender: chrome.runtime.MessageSender) => {
    if (!Array.isArray(data) || data.length != 2) return;
    console.log("sw.js onMessage get message:", data);
    console.log("sw.js onMessage get sender:", sender);
    ReportExport(data[0]);
    return true;
  },
);

// 创建名为 "checkCache" 的定时任务，每 10080 分钟（7 天）运行一次，清理缓存
chrome.alarms.create("checkCache", {
  periodInMinutes: 60 * 24 * 7,
});

// 监听定时任务事件
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkCache") {
    checkCache();
  }
});

/**
 * 设置下载任务
 * @param tab - Chrome标签页对象
 * @description
 * 1. 从URL中获取项目ID
 * 2. 设置下载状态和徽标
 * 3. 执行报告导出
 * 4. 处理错误和清理工作
 */
const setTask = async (tab?: chrome.tabs.Tab) => {
  // 检查标签页是否有效
  if (!tab?.url || !tab?.id) return;

  // 从URL中解析项目ID
  const url = new URL(tab.url);
  const id = url.searchParams.get("id");

  // 检查ID是否存在且当前没有下载任务在进行
  if (id == null || downloading) return;

  // 设置下载状态为true
  downloading = true;
  console.log("setTask", id);

  // 保存当前标签页ID
  tabId = tab.id;

  // 绘制进度条提示框
  chrome.scripting.executeScript({
    target: { tabId },
    func: pageToast,
  });

  // 显示下载中徽标
  await chrome.action.setBadgeText({ text: "⏬" });

  try {
    // 执行报告导出
    await ReportExport(id);
  } catch (e: any) {
    // 错误处理：记录错误并显示失败提示
    console.log((e as Error).name, (e as Error).message);
    show(
      tabId,
      "导出失败",
      "导出失败，重新下载多试几次  " + (e as Error).message,
    );
  }

  // 清理工作：重置状态
  downloading = false;
  tabId = 0;

  // 清除徽标
  await chrome.action.setBadgeText({ text: "" });

  // 检查并清理缓存
  checkCache();
};

/**
 * 导出项目报告为PDF文件
 * @param id - 项目ID
 */
const ReportExport = async (
  id: string,
) => {
  // 记录开始时间,用于计算总耗时
  console.log("ReportExport", id);
  const startTime = Date.now();

  // 获取项目基本信息
  const info = await getProjectInfo(id);
  show(tabId, "正在导出", info.projectName);

  // 用于存储所有图片数据的缓存数组
  let imgCache: ImgResultType[] = [];
  // 页数递增获取图片，遇到404即为最后一页

  // 当前处理的页码
  let index = 0;

  // 获取已缓存的最大页数,如果没有缓存则默认为0
  let [getImgFetchDonePage, setImgFetchDonePage] = getset<number>(parseInt(
    (await getCachedData(`img_${id}_maxpage`))?.data ?? 0,
  ));

  const imgPool = getImgPool(imgCache, getImgFetchDonePage, info);
  const tobeBreak = imgPool.events.tobeBreak;

  // 循环添加图片获取任务,直到遇到404
  while (++index) {
    console.log(index);
    // 如果已知最大页数,且当前页码超过最大页数,则退出循环
    if (getImgFetchDonePage() > 0 && index >= getImgFetchDonePage()) {
      break;
    }

    show(tabId, "正在导出", `${info.projectName} 第${index}页`);
    try {
      const [url, cached] = await getImgURL(id, index);
      if (url === "404") {
        setImgFetchDonePage(index);
        // 缓存最大页数，有效期7天
        setCachedData(`img_${id}_maxpage`, index);
        break;
      }
      imgPool.add({
        worker: getImgBlob,
        args: [url, index],
      });
      if (!cached) {
        await sleep(1000);
      }
    } catch {
      index--;
      await sleep(3000);
    }
  }

  if (
    getImgFetchDonePage() > 0 &&
    imgCache.length === getImgFetchDonePage() - 1
  ) {
    imgPool.tobeBreak();
  } else {
    // 等待所有任务完成
    await tobeBreak;
    await imgPool.events.allTaskDone;
    await imgPool.events.parallelZero;
  }

  // 开始生成PDF文件
  show(tabId, "生成文件", `${info.projectName}.pdf 生成中`);

  // 将图片转换为PDF并获取文件名和数据URL
  const [filename, pdfUrl] = projectImg2pdf(info, imgCache);

  // 触发浏览器下载
  chrome.downloads.download(
    {
      url: pdfUrl,
      filename: filename,
      conflictAction: "uniquify", // 文件名冲突时自动重命名
      saveAs: false, // 不弹出保存对话框
    },
    function (downloadId) {
      console.log(`文件下载，ID: ${downloadId}`);
    },
  );

  // 显示导出完成信息
  show(
    tabId,
    "导出完成",
    `${filename}保存在浏览器默认下载目录 共${imgCache.length}页 用时${
      Math.ceil((Date.now() - startTime) / 1000 / 60)
    }分钟`,
  );

  // 清理过期缓存
  checkCache();
};

const getImgPool = (
  imgCache: ImgResultType[],
  getImgFetchDonePage: Getter<number>,
  info: ProjectInfo,
) => {
  // 创建异步任务池，配置并行数、重试策略等
  const pool = new AsyncPool<[string, number], ImgResultType>({
    parallel: 8, // 最大并行任务数
    autoRetry: false, // 禁用自动重试
    autoRun: true, // 启用自动运行
    retryCount: 50, // 最大重试次数
    retryDelay: 0, // 重试延迟时间(ms)
    waitTime: 5000,
  });

  // 单个任务完成时的回调处理
  pool.callbacks.oneTaskDone = (
    result: ImgResultType,
    _error: Error,
    task: TaskItem<[string, number]>,
  ) => {
    if (result) {
      result.index = task.args![1];
      imgCache.push(result);
      show(tabId, "正在导出", `${info.projectName} 第${result.index}页图片`);
    }
    if (
      getImgFetchDonePage() > 0 &&
      imgCache.length === getImgFetchDonePage() - 1
    ) {
      pool.tobeBreak();
    } else if (_error) {
      task.ctx?.retry?.();
    }
  };
  return pool;
};

/**
 * 将项目图片转换为PDF文件
 * @param info - 项目信息对象
 * @param imgCache - 图片缓存数组
 * @returns [filename, pdfUrl] - 返回文件名和PDF的DataURI字符串
 */
const projectImg2pdf = (info: ProjectInfo, imgCache: ImgResultType[]) => {
  // 创建新的PDF文档，启用压缩
  const doc = new jsPDF({
    compress: true,
  });

  // 设置PDF文档属性
  doc.setDocumentProperties({
    title: info.projectName, // 项目名称作为标题
    subject: info.conclusionAbstract, // 结题摘要作为主题
    author: info.projectAdmin, // 项目管理员作为作者
    keywords: info.projectKeywordC, // 项目关键词
    creator: "@ejfkdev", // 创建者标识
  });

  // 删除默认的第一页
  doc.deletePage(1);

  // 图片下载可能乱序，保存前按页码排序
  imgCache = sortByProperty(imgCache, "index");

  // 遍历图片缓存，将每张图片添加到PDF中
  for (const data of imgCache) {
    // 根据图片尺寸和方向添加新页面
    doc.addPage([data.width, data.height], data.orientation);
    // 将图片添加到当前页面
    // const filetype = doc.getImageProperties(data.imageData).fileType;
    doc.addImage({
      imageData: data.imageData, // 图片数据
      // format: "JPG", // 图片格式
      // format: filetype,
      x: 0, // X坐标起点
      y: 0, // Y坐标起点
      width: data.width, // 图片宽度
      height: data.height, // 图片高度
      compression: "FAST", // 使用快速压缩
    });
  }

  // 生成PDF的DataURI字符串
  const pdfUrl = doc.output("datauristring");
  // 生成文件名，移除不合法的文件名字符
  const filename = `${info.projectName}.pdf`.replace(/[/\\?%*:|"<>]/g, "-");

  return [filename, pdfUrl];
};

// https://kd.nsfc.cn/finalDetails?id=18762a8003cdc2a63d65957925f6c67d
// ReportExport('18762a8003cdc2a63d65957925f6c67d');
// https://kd.nsfc.cn/finalDetails?id=161cd5723f90c0d39423fb838e32f809
