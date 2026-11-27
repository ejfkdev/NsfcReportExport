/**
 * kd.nsfc.cn 滑块验证码（AJ-Captcha blockPuzzle）自动识别
 *
 * 流程：
 * 1. POST /api/captcha/get 取得底图、拼图（base64 PNG）与 secretKey
 * 2. 用 ZNCC 在底图上滑窗匹配拼图块，得到水平偏移 x
 * 3. AES-128-ECB 加密 {x, y: 5} 后 POST /api/captcha/check 校验
 * 4. AES-128-ECB 加密 `${token}---${JSON.stringify({x, y: 5})}`，即业务接口的 tryCode
 *
 * 说明：AJ-Captcha 对底图缺口做了「模糊 + 白描边」，相当于对像素做了一次
 * a*x+b 的仿射变换，ZNCC 对此免疫，因此能稳定命中真缺口。
 */

import { fetchSignal } from "./utils";

const host = "https://kd.nsfc.cn";
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type DecodedPNG = {
    w: number;
    h: number;
    ch: number;
    data: Uint8Array;
};

export type CaptchaResult = {
    ok: boolean;
    x: number;
    z: number;
    farZ: number;
    repCode: string;
    /** 业务接口使用的 tryCode */
    captchaVerification: string;
};

/* ------------------------------ 基础工具 ------------------------------ */

const b64ToBytes = (b64: string): Uint8Array => {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
};

const bytesToB64 = (u8: Uint8Array): string => {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
        s += String.fromCharCode(...u8.subarray(i, i + chunk));
    }
    return btoa(s);
};

/** zlib(deflate) 解压，service worker 中同样可用 */
const inflateZlib = async (u8: Uint8Array): Promise<Uint8Array> => {
    const ds = new DecompressionStream("deflate");
    // 复制一份，避免 Uint8Array<ArrayBufferLike> 与 BlobPart 的类型问题
    const stream = new Blob([new Uint8Array(u8)]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

/* ------------------------------ PNG 解码 ------------------------------ */

/**
 * 解码 8-bit 非隔行 PNG（灰度 / RGB / RGBA），验证码两张图均为 RGBA
 */
export const decodePNG = async (buf: Uint8Array): Promise<DecodedPNG> => {
    if (
        buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e ||
        buf[3] !== 0x47
    ) {
        throw new Error("not a PNG");
    }

    let off = 8;
    let w = 0, h = 0, bitDepth = 0, colorType = 0;
    const idat: Uint8Array[] = [];

    while (off + 8 <= buf.length) {
        const dv = new DataView(buf.buffer, buf.byteOffset + off, 8);
        const len = dv.getUint32(0);
        const type = String.fromCharCode(
            buf[off + 4],
            buf[off + 5],
            buf[off + 6],
            buf[off + 7],
        );
        const data = buf.subarray(off + 8, off + 8 + len);
        off += 12 + len;

        if (type === "IHDR") {
            const ih = new DataView(data.buffer, data.byteOffset, data.byteLength);
            w = ih.getUint32(0);
            h = ih.getUint32(4);
            bitDepth = data[8];
            colorType = data[9];
            if (data[12] !== 0) throw new Error("interlaced PNG unsupported");
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
    }

    if (bitDepth !== 8) throw new Error("bitDepth " + bitDepth);
    const ch = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
    if (!ch) throw new Error("colorType " + colorType);

    let total = 0;
    for (const p of idat) total += p.length;
    const z = new Uint8Array(total);
    let zo = 0;
    for (const p of idat) {
        z.set(p, zo);
        zo += p.length;
    }

    const raw = await inflateZlib(z);
    const stride = w * ch;
    const out = new Uint8Array(w * h * ch);
    let prev = new Uint8Array(stride);

    for (let y = 0; y < h; y++) {
        const ft = raw[y * (stride + 1)];
        const lineOff = y * (stride + 1) + 1;
        const cur = new Uint8Array(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? cur[i - ch] : 0;
            const b = prev[i];
            const c = i >= ch ? prev[i - ch] : 0;
            let v = raw[lineOff + i];
            switch (ft) {
                case 0:
                    break;
                case 1:
                    v = (v + a) & 0xff;
                    break;
                case 2:
                    v = (v + b) & 0xff;
                    break;
                case 3:
                    v = (v + ((a + b) >> 1)) & 0xff;
                    break;
                case 4: {
                    const p = a + b - c;
                    const pa = Math.abs(p - a),
                        pb = Math.abs(p - b),
                        pc = Math.abs(p - c);
                    const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                    v = (v + pr) & 0xff;
                    break;
                }
                default:
                    throw new Error("filter " + ft);
            }
            cur[i] = v;
        }
        out.set(cur, y * stride);
        prev = cur;
    }

    return { w, h, ch, data: out };
};

const grayAt = (img: DecodedPNG, x: number, y: number): number => {
    const i = (y * img.w + x) * img.ch;
    const d = img.data;
    if (img.ch >= 3) return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    return d[i];
};

const alphaAt = (img: DecodedPNG, x: number, y: number): number => {
    if (img.ch === 4) return img.data[(y * img.w + x) * 4 + 3];
    if (img.ch === 2) return img.data[(y * img.w + x) * 2 + 1];
    return 255;
};

/* ---------------------------- 滑块位置识别 ---------------------------- */

/**
 * ZNCC 滑窗匹配拼图块
 * @returns x 水平偏移；z 最佳相关度；farZ 远离最佳位置（>5px）的最高相关度
 */
export const solveOffset = (
    original: DecodedPNG,
    jigsaw: DecodedPNG,
): { x: number; z: number; farZ: number } => {
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
    for (let y = 0; y < jigsaw.h; y++) {
        for (let x = 0; x < jigsaw.w; x++) {
            if (alphaAt(jigsaw, x, y) > 128) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) throw new Error("empty jigsaw");

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    // 展开为平行数组，避免热点循环里反复分配对象
    const px: number[] = [],
        py: number[] = [],
        pg: number[] = [];
    for (let j = 0; j < bh; j++) {
        for (let i = 0; i < bw; i++) {
            if (alphaAt(jigsaw, minX + i, minY + j) > 128) {
                px.push(i);
                py.push(j);
                pg.push(grayAt(jigsaw, minX + i, minY + j));
            }
        }
    }

    const n = px.length;
    let st = 0, stt = 0;
    for (let k = 0; k < n; k++) {
        st += pg[k];
        stt += pg[k] * pg[k];
    }
    const tss = n * stt - st * st;

    const limit = original.w - bw;
    if (limit < 0) throw new Error("jigsaw larger than original");
    const curve = new Float64Array(limit + 1);

    for (let dx = 0; dx <= limit; dx++) {
        let sp = 0, spp = 0, stp = 0;
        for (let k = 0; k < n; k++) {
            const p = grayAt(original, minX + dx + px[k], minY + py[k]);
            sp += p;
            spp += p * p;
            stp += pg[k] * p;
        }
        const num = n * stp - st * sp;
        const den = Math.sqrt(tss * (n * spp - sp * sp));
        curve[dx] = den > 1e-9 ? num / den : 0;
    }

    let bestDx = 0, bestZ = -2;
    for (let dx = 0; dx <= limit; dx++) {
        if (curve[dx] > bestZ) {
            bestZ = curve[dx];
            bestDx = dx;
        }
    }

    let farZ = -2;
    for (let dx = 0; dx <= limit; dx++) {
        if (Math.abs(dx - bestDx) <= 5) continue;
        if (curve[dx] > farZ) farZ = curve[dx];
    }

    return { x: bestDx, z: bestZ, farZ };
};

/* ------------------------------- AES -------------------------------- */

/**
 * AES-128-ECB + PKCS7 → base64
 * WebCrypto 没有 ECB，但「单块 CBC + 全零 IV」与 ECB 等价，按 16 字节分块加密
 */
export const aesEcbBase64 = async (
    plain: string,
    keyStr: string,
): Promise<string> => {
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(keyStr),
        { name: "AES-CBC" },
        false,
        ["encrypt"],
    );
    const data = enc.encode(plain);
    const pad = 16 - (data.length % 16);
    const padded = new Uint8Array(data.length + pad);
    padded.set(data);
    padded.fill(pad, data.length);

    const out = new Uint8Array(padded.length);
    for (let off = 0; off < padded.length; off += 16) {
        const ct = await crypto.subtle.encrypt(
            { name: "AES-CBC", iv: new Uint8Array(16) },
            key,
            padded.subarray(off, off + 16),
        );
        out.set(new Uint8Array(ct).subarray(0, 16), off);
    }
    return bytesToB64(out);
};

/* ------------------------------- HTTP -------------------------------- */

/**
 * 统一请求 + 重试。源站偶尔在 HTTP 200 下返回 HTML 网关错误页，
 * 直接 r.json() 会抛 "Unexpected token '<'"，这里按内容判断后重试。
 */
const postJSON = async (
    path: string,
    body: unknown,
    attempts = 4,
    signal?: AbortSignal,
): Promise<any> => {
    let lastErr: Error = new Error(`请求失败: ${path}`);
    for (let i = 0; i < attempts; i++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const response = await fetch(host + path, {
                method: "POST",
                headers: {
                    "content-type": "application/json;charset=UTF-8",
                },
                body: JSON.stringify(body),
                signal: fetchSignal(15000, signal),
            });
            const text = await response.text();
            const t = text.trimStart();
            if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(text);
            lastErr = new Error(
                `非 JSON 响应 (HTTP ${response.status}): ${text.slice(0, 100)}`,
            );
        } catch (e) {
            if (signal?.aborted) throw e;
            lastErr = e as Error;
        }
        await sleep(500 * (i + 1));
    }
    throw lastErr;
};

/* ---------------------------- 验证码流程 ---------------------------- */

type CaptchaGetData = {
    originalImageBase64: string;
    jigsawImageBase64: string;
    secretKey: string;
    token: string;
};

/**
 * 完整过一次滑块验证码
 * @returns captchaVerification 即业务接口需要的 tryCode
 */
export const solveCaptcha = async (
    signal?: AbortSignal,
): Promise<CaptchaResult> => {
    const clientUid = "slider-" + crypto.randomUUID();

    const getResponse = await postJSON("/api/captcha/get", {
        captchaType: "blockPuzzle",
        clientUid,
        ts: Date.now(),
    }, 4, signal);
    if (getResponse.repCode !== "0000") {
        throw new Error(
            `captcha/get 失败: ${getResponse.repCode} ${getResponse.repMsg ?? ""}`,
        );
    }

    const rd = getResponse.repData as CaptchaGetData;
    const original = await decodePNG(b64ToBytes(rd.originalImageBase64));
    const jigsaw = await decodePNG(b64ToBytes(rd.jigsawImageBase64));

    const { x, z, farZ } = solveOffset(original, jigsaw);

    const point = JSON.stringify({ x, y: 5 });
    const pointJson = await aesEcbBase64(point, rd.secretKey);
    const checkResponse = await postJSON("/api/captcha/check", {
        captchaType: "blockPuzzle",
        pointJson,
        token: rd.token,
    }, 4, signal);

    const ok = checkResponse.repCode === "0000" &&
        !!(checkResponse.repData && checkResponse.repData.result);
    const captchaVerification = await aesEcbBase64(
        rd.token + "---" + point,
        rd.secretKey,
    );
    console.log(
        `captcha x=${x} z=${z.toFixed(3)} farZ=${farZ.toFixed(3)} ` +
            `repCode=${checkResponse.repCode}`,
    );

    return {
        ok,
        x,
        z,
        farZ,
        repCode: checkResponse.repCode,
        captchaVerification,
    };
};