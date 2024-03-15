// @ts-ignore
import { PNG } from 'pngjs';
import { jsPDF } from 'jspdf';

const host = 'https://kd.nsfc.cn';

let downloading = false;

const setTask = async (tab?: chrome.tabs.Tab) => {
  if (tab == undefined || tab.url == undefined) return;
  const url = new URL(tab.url);
  const id = url.searchParams.get('id');
  if (id == null || downloading) return;
  downloading = true;
  await chrome.action.setBadgeText({ text: '🩷' });
  await ReportExport(id);
  downloading = false;
  await chrome.action.setBadgeText({ text: '' });
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    type: 'normal',
    id: '@ejfkdev/NsfcReportExportContextMenus',
    title: '下载结题报告',
    documentUrlPatterns: ['https://kd.nsfc.cn/finalDetails*'],
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    setTask(tab);
  });

  chrome.action.onClicked.addListener(tab => {
    setTask(tab);
  });
});

const fetchReportImage = async (id: string, index: number) => {
  try {
    const data = await fetch(`${host}/api/baseQuery/completeProjectReport`, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `id=${id}&index=${index}`,
      method: 'POST',
    }).then(response => response.json());
    const url = host + data.data.url;
    // 获取图片内容
    const blob = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'GET',
    })
      .then(response => {
        if (response.ok) return response;
        else throw new Error(`HTTP error! status: ${response.status}`);
      })
      .then(response => response.blob());
    const img = await blob.arrayBuffer();
    return img;
  } catch (error) {
    console.log(error);
  }
  return null;
};

const getProjectInfo = async (id: string) => {
  const response = await fetch(
    `${host}/api/baseQuery/conclusionProjectInfo/${id}`,
    {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: null,
      method: 'POST',
      mode: 'cors',
    },
  );
  if (response.ok) {
    const data = await response.json();
    return {
      projectName: data?.data?.projectName ?? 'projectName',
      projectAdmin:
        (data?.data?.projectAdmin ?? '') + ' ' + (data?.data?.dependUnit ?? ''),
      conclusionAbstract: data?.data?.conclusionAbstract ?? '',
      projectKeywordC: data?.data?.projectKeywordC ?? '',
    };
  } else {
    return {
      projectName: 'projectName',
      projectAdmin: '',
      conclusionAbstract: '',
      projectKeywordC: '',
    };
  }
};

const ReportExport = async (id: string) => {
  const info = await getProjectInfo(id);
  const notiId = await chrome.notifications.create('ReportExportStart', {
    type: 'basic',
    iconUrl: 'images/logo.png',
    title: '正在导出',
    message: info.projectName,
    silent: true,
  });
  let index = 0;
  const doc = new jsPDF({
    compress: true,
  });
  doc.setDocumentProperties({
    title: info.projectName,
    subject: info.conclusionAbstract,
    author: info.projectAdmin,
    keywords: info.projectKeywordC,
    creator: '@ejfkdev',
  });
  doc.deletePage(1);
  while (++index) {
    await chrome.notifications.update(notiId, {
      type: 'basic',
      iconUrl: 'images/logo.png',
      title: '正在导出',
      message: `${info.projectName} 第${index}页`,
      silent: true,
    });
    const img = await fetchReportImage(id, index);
    if (img == null) break;
    const png = new PNG().parse(img as Buffer);
    doc.addPage([png.width, png.height], png.width < png.height ? 'p' : 'l');
    doc.addImage(new Uint8Array(img), 'PNG', 0, 0, png.width, png.height);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const pdfUrl = doc.output('datauristring');
  const filename = `${info.projectName}.pdf`;
  chrome.downloads.download(
    {
      url: pdfUrl,
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: false,
    },
    function (downloadId) {
      console.log(`文件下载，ID: ${downloadId}`);
    },
  );
  await chrome.notifications.create('ReportExportStart', {
    type: 'basic',
    iconUrl: 'images/logo.png',
    title: '导出完成',
    message: filename,
    silent: true,
  });
};

const onMessage = (data: any, sender: chrome.runtime.MessageSender) => {
  if (!Array.isArray(data) || data.length != 2) return;
  console.log('sw.js onMessage get message:', data);
  console.log('sw.js onMessage get sender:', sender);
  ReportExport(data[0]);
  return true;
};

// https://kd.nsfc.cn/finalDetails?id=18762a8003cdc2a63d65957925f6c67d
// ReportExport('18762a8003cdc2a63d65957925f6c67d');

chrome.runtime.onMessageExternal.addListener(onMessage);
