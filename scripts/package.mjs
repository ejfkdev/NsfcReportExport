#!/usr/bin/env node
/**
 * 打包 dist 为可发布的 zip / crx。
 *
 *   pnpm run package
 *   CRX_KEY=/path/to/key.pem pnpm run package
 *
 * CRX 私钥必须和 manifest 里的 "key" 对应，否则生成的 CRX 会使用新的扩展 ID。
 * 私钥不会进入仓库（.gitignore 已忽略 *.pem）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const release = path.join(root, "release");

if (!fs.existsSync(path.join(dist, "manifest.json"))) {
    console.error("dist/manifest.json 不存在，请先执行 pnpm run build");
    process.exit(1);
}
const manifest = JSON.parse(
    fs.readFileSync(path.join(dist, "manifest.json"), "utf8"),
);
const version = manifest.version;
fs.mkdirSync(release, { recursive: true });

const zipName = `NsfcReportExport-${version}.zip`;
const zipPath = path.join(release, zipName);
fs.rmSync(zipPath, { force: true });
execFileSync(
    "zip",
    ["-r", "-q", zipPath, ".", "-x", "*.map", "-x", "*.DS_Store"],
    { cwd: dist, stdio: "inherit" },
);
console.log(`zip  -> ${path.relative(root, zipPath)}`);

const chromeCandidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => fs.existsSync(candidate));
const keyPath = process.env.CRX_KEY || path.join(root, "extension-key.pem");

if (!chrome) {
    console.warn(
        "未找到 Chrome/Chromium，跳过 CRX。可设置 CHROME_BIN 指向 Chrome for Testing。",
    );
    process.exit(0);
}
if (!fs.existsSync(keyPath)) {
    console.warn(
        `未找到 CRX 私钥（${keyPath}）。设置 CRX_KEY=/path/to/key.pem 后重新执行，可生成带固定扩展 ID 的 .crx。`,
    );
    process.exit(0);
}

const generatedCrx = path.join(root, "dist.crx");
fs.rmSync(generatedCrx, { force: true });
console.log(`使用 Chrome: ${chrome}`);
console.log(`使用私钥: ${path.relative(root, keyPath)}`);
const result = spawnSync(
    chrome,
    [
        `--pack-extension=${dist}`,
        `--pack-extension-key=${keyPath}`,
        "--no-message-box",
    ],
    { stdio: "inherit" },
);
if (result.status !== 0) {
    console.error("CRX 打包失败。可尝试 CHROME_BIN 指向 Chrome for Testing。");
    process.exit(1);
}
if (!fs.existsSync(generatedCrx)) {
    console.error("Chrome 未生成 dist.crx");
    process.exit(1);
}
const crxName = `NsfcReportExport-${version}.crx`;
const crxPath = path.join(release, crxName);
fs.rmSync(crxPath, { force: true });
fs.renameSync(generatedCrx, crxPath);
const head = fs.readFileSync(crxPath).subarray(0, 4).toString("latin1");
console.log(`crx  -> ${path.relative(root, crxPath)} (${head})`);
