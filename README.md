![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/hahfllhcnfmefcoaebpboecfhlppoeoi)
![Chrome Web Store Rating](https://img.shields.io/chrome-web-store/rating/hahfllhcnfmefcoaebpboecfhlppoeoi)

国家自然科学基金 kd.nsfc.cn 结题报告下载导出 PDF。

chrome 商店地址：https://chromewebstore.google.com/detail/%E5%9B%BD%E8%87%AA%E7%84%B6%E7%BB%93%E9%A2%98%E6%8A%A5%E5%91%8A%E4%B8%8B%E8%BD%BD/hahfllhcnfmefcoaebpboecfhlppoeoi?hl=zh-CN

离线安装：https://docs.qq.com/aio/DZHVYbHd5d2lQbnpq?p=KBqlBRg6rIfSwfgAKdjSiM

## 功能

- 自动识别 kd.nsfc.cn 的 AJ-Captcha 滑块验证码（本地识别，无需打码平台）
- 独立的下载管理页：粘贴多个报告链接 / 32 位 ID，自动识别、排队逐个下载
- 404 页面视为报告结尾，自动收缩总页数
- 逐页下载并实时显示缩略图，支持单页预览、取消、失败页每 10 秒自动重试 + 手动重试
- 已下载图片保存在本地 IndexedDB：取消、失败、关闭页面后再次继续，只补缺失页，不会从头下载
- reportToken / 图片签名地址过期后自动重新过验证码、重新签名
- 收尾自动合并为 PDF 并保存到浏览器下载目录；图片不足时可选择「跳过失败页生成 PDF」
- 报告详情页内提供悬浮进度窗：进度、缩略图、取消、重试、打开下载页，可关闭折叠为小圆点
- 批量任务严格串行：同一时间只下载一个报告（跨标签页也用 Web Locks 互斥）
- 页脚展示作者 GitHub / 小红书 / 微博，以及本项目的开源仓库链接

## 使用

- 点击工具栏图标：打开下载管理页（在报告详情页点击会自动带入当前报告 ID）
- 在报告详情页右键「下载结题报告」：打开管理页并立即开始
- 在管理页粘贴多行内容即可批量下载，链接和裸 ID 可以混排
- 同一个报告再次下载时会直接复用本地已下载的图片，不会创建重复任务
- PDF 文件名格式：`报告标题-单位-作者-报告ID前8位.pdf`，特殊字符已过滤，兼容 macOS/Linux/Windows

## 编译 / 打包

需要 Chrome 116+、Node 22.22+、pnpm 11。

```bash
pnpm i --registry=https://registry.npmmirror.com
pnpm run build
```

构建产物在 `dist/`，可直接在 `chrome://extensions` 中「加载已解压的扩展程序」。

生成发布包（zip + 可选 crx，产物在 `release/`，已被 git 忽略）：

```bash
pnpm run package
# 需要固定扩展 ID 的 CRX 时，提供与 manifest key 对应的私钥：
CRX_KEY=/path/to/key.pem pnpm run package
```

`CRX_KEY` 未设置时只生成 zip。CRX 私钥不会提交到仓库（`*.pem` 已忽略），
发布时把 `release/` 下的 zip / crx 作为 GitHub Release 附件上传即可。