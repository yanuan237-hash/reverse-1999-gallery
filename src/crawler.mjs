/**
 * 重返未来:1999 官网图画集爬虫 —— 核心模块
 *
 * 数据来源（官方网站 /home 页面使用的公开接口）：
 *   列表: POST https://re.bluepoch.com/activity/official/websites/picture/query
 *   分类: POST https://re.bluepoch.com/activity/official/websites/collection/query
 *   图片: https://gamecms-res.sl916.com/official_website_resource/...
 *
 * 注意：图片 CDN 只接受 HTTP/2 请求，故这里使用 Node 内置的 fetch（undici，HTTP/2 友好），
 *       不依赖任何第三方包。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const SITE_ORIGIN = "https://re.bluepoch.com";
export const API_BASE = `${SITE_ORIGIN}/activity/official/websites`;
export const REFERER = `${SITE_ORIGIN}/home/`;
export const WALLPAPER_COLLECTION_ID = 16; // 分类名「游戏壁纸」

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 网络层 */

async function apiPost(endpoint, payload, { timeout = 30000, retries = 3 } = {}) {
  const url = `${API_BASE}/${endpoint}`;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json, text/plain, */*",
          Referer: REFERER,
          Origin: SITE_ORIGIN,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = await res.json();
      if (json.code !== 200) throw new Error(`接口返回 code=${json.code} msg=${json.msg}`);
      return json.data;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(600 * attempt);
    }
  }
  throw new Error(`请求 ${endpoint} 失败：${lastErr?.message ?? lastErr}`);
}

/** 拉取全部分类（图集/壁纸/视频…） */
export async function fetchCollections() {
  const data = await apiPost("collection/query", { current: 1, pageSize: 200 });
  return data.pageData ?? [];
}

/**
 * 分页拉取图画集列表。
 * @param {object} opts
 * @param {number} opts.pageSize 每页条数（接口上限未知，100 稳定）
 * @param {number} [opts.maxPages] 最多拉取页数，默认全部
 * @param {(msg:string)=>void} [opts.onProgress]
 */
export async function fetchGallery({ pageSize = 100, maxPages = Infinity, onProgress } = {}) {
  const all = [];
  let current = 1;
  let total = Infinity;

  while (current <= maxPages && all.length < total) {
    const data = await apiPost("picture/query", { current, pageSize });
    const rows = data.pageData ?? [];
    total = Number(data.total ?? rows.length);
    all.push(...rows);
    onProgress?.(`已获取列表 ${all.length}/${total} 条`);
    if (rows.length === 0) break;
    current += 1;
  }

  // 接口按 weight 倒序返回：id 越大越新
  all.sort((a, b) => (b.weight ?? b.id) - (a.weight ?? a.id));
  return all;
}

/* ------------------------------------------------------------ 文件名与解析 */

/** Windows/Linux 非法字符清洗，并限制长度 */
export function sanitizeName(input, fallback = "untitled") {
  let s = String(input ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") // 非法字符
    .replace(/[\s\u3000]+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "") // 去掉首尾的点与空格（Windows 不允许）
    .trim();
  if (!s) s = fallback;
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

/** 从标题中解析出 (有序号?) 名称 与 分辨率 */
export function parseTitle(rawTitle, id) {
  const raw = String(rawTitle ?? "").trim();
  if (!raw) return { name: `wallpaper_${id}`, resolution: null };

  const resMatch = raw.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/);
  const resolution = resMatch ? `${resMatch[1]}x${resMatch[2]}` : null;

  let name = raw;
  if (resMatch) name = raw.slice(0, resMatch.index) + raw.slice(resMatch.index + resMatch[0].length);
  name = name
    .replace(/^(\d{1,4})\s*[.、,\-]\s*/, "$1 ") // "1012.竖版" -> "1012 竖版"
    .replace(/[\s\-_.、,]+$/g, "")
    .replace(/^[\s\-_.、,]+/g, "")
    .trim();

  if (!name) name = `wallpaper_${id}`;
  return { name, resolution };
}

/** 由图片真实字节判断横竖版（优先于标题） */
export function classifyOrientation(width, height, title = "") {
  if (Number.isFinite(width) && Number.isFinite(height) && width !== height) {
    return width > height ? "desktop" : "mobile";
  }
  if (title.includes("竖")) return "mobile";
  if (title.includes("横")) return "desktop";
  return "unknown";
}

/** 从 pictureUrl 的目录中取上传日期目录，如 .../PICTURE/20260907/xxx.jpg -> "2026-09-07" */
export function dateFromUrl(url) {
  const m = String(url).match(/\/PICTURE\/(\d{8})\//);
  if (!m) return "unknown";
  const d = m[1];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** 逐段编码 URL 路径，保留目录分隔符 */
export function encodeUrl(rawUrl) {
  const u = new URL(rawUrl);
  u.pathname = u.pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");
  return u.toString();
}

export function extFromUrl(rawUrl) {
  const clean = String(rawUrl).split("?")[0];
  const m = clean.match(/\.(jpe?g|png|webp|gif|bmp|avif)$/i);
  return m ? `.${m[1].toLowerCase().replace("jpeg", "jpg")}` : ".jpg";
}

/* ------------------------------------------------------------------ 过滤层 */

/**
 * @param {Array} items 原始列表
 * @param {{resolution?:string, orientation?:string, date?:string, ids?:number[], from?:number, to?:number, limit?:number}} f
 */
export function filterItems(items, f = {}) {
  let out = items;

  if (f.resolution) {
    const want = f.resolution.toLowerCase().replace(/×/g, "x").replace(/\s/g, "");
    out = out.filter((it) => {
      const r = String(it.title ?? "").replace(/×/g, "x").replace(/\s/g, "");
      return r.includes(want);
    });
  }

  if (f.orientation) {
    const want = f.orientation === "pc" ? "desktop" : f.orientation === "phone" ? "mobile" : f.orientation;
    out = out.filter((it) => {
      const { resolution } = parseTitle(it.title, it.id);
      const [w, h] = (resolution ?? "0x0").split("x").map(Number);
      let o = "unknown";
      if (w && h && w !== h) o = w > h ? "desktop" : "mobile";
      else if (String(it.title ?? "").includes("竖")) o = "mobile";
      else if (String(it.title ?? "").includes("横")) o = "desktop";
      return o === want;
    });
  }

  if (f.date) out = out.filter((it) => dateFromUrl(it.pictureUrl) === f.date);

  if (f.from != null) out = out.filter((it) => it.id >= f.from);
  if (f.to != null) out = out.filter((it) => it.id <= f.to);
  if (f.ids?.length) {
    const set = new Set(f.ids);
    out = out.filter((it) => set.has(it.id));
  }
  if (f.limit != null && f.limit >= 0) out = out.slice(0, f.limit);

  return out;
}

/* ------------------------------------------------------------------ 下载层 */

/** 读取 JPEG/PNG/WebP/GIF 文件头得到像素尺寸 */
export function imageSize(buf) {
  if (buf.length < 24) return { width: null, height: null };

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP (VP8X / VP8 / VP8L)
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fourcc = buf.toString("ascii", 12, 16);
    if (fourcc === "VP8X") {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
    if (fourcc === "VP8 ") {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  // JPEG: 扫描 SOFn 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = buf[off + 1];
      off += 2;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const len = buf.readUInt16BE(off);
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        return { height: buf.readUInt16BE(off + 3), width: buf.readUInt16BE(off + 5) };
      }
      off += len;
    }
  }
  return { width: null, height: null };
}

async function fetchBinary(url, { timeout = 60000, retries = 4, onRetry } = {}) {
  const encoded = encodeUrl(url);
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(encoded, {
        headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: REFERER },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error(`内容过小（${buf.length} 字节），疑似错误页`);
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        onRetry?.(attempt, err.message);
        await sleep(800 * attempt);
      }
    }
  }
  throw new Error(lastErr?.message ?? String(lastErr));
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/** Node 中基于 Promise 的并发池 */
export async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 下载图画集。
 * @param {object} opts
 * @param {Array} opts.items 经筛选后的条目
 * @param {string} opts.outDir 输出根目录
 * @param {number} [opts.concurrency] 并发数
 * @param {boolean} [opts.force] 已存在也重新下载
 * @param {boolean} [opts.dryRun] 只打印不下载
 * @param {(e:object)=>void} [opts.onEvent] 事件回调 { type, ... }
 */
export async function downloadGallery({
  items,
  outDir,
  concurrency = 6,
  force = false,
  dryRun = false,
  onEvent = () => {},
}) {
  const imgDir = path.resolve(outDir, "wallpapers");
  await fs.mkdir(imgDir, { recursive: true });

  const manifest = [];
  const usedNames = new Set();
  let done = 0;
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let bytesTotal = 0;
  const startedAt = Date.now();

  // 先规划好文件名，保证唯一且可读
  const planned = items.map((it) => {
    const { name, resolution } = parseTitle(it.title, it.id);
    const date = dateFromUrl(it.pictureUrl);
    const dir = path.join(imgDir, date);
    const ext = extFromUrl(it.pictureUrl);
    const base = `${String(it.id).padStart(4, "0")}_${sanitizeName(name)}`;
    let fileName = `${base}${ext}`;
    let n = 2;
    while (usedNames.has(`${date}/${fileName}`.toLowerCase())) {
      fileName = `${base}_${n++}${ext}`;
    }
    usedNames.add(`${date}/${fileName}`.toLowerCase());
    return { it, name, resolution, date, dir, fileName, ext };
  });

  await mapPool(planned, concurrency, async (plan, index) => {
    const { it, name, resolution, date, dir, fileName, ext } = plan;
    const abs = path.join(dir, fileName);
    const rel = path.relative(outDir, abs).split(path.sep).join("/");
    const label = `#${it.id} ${name}`;

    try {
      let buf;
      let skipped = false;

      if (!force) {
        try {
          const stat = await fs.stat(abs);
          if (stat.size > 512) {
            buf = await fs.readFile(abs);
            skipped = true;
          }
        } catch {
          /* 文件不存在，正常下载 */
        }
      }

      if (!buf) {
        if (dryRun) {
          onEvent({ type: "dry", label, rel });
          return;
        }
        buf = await fetchBinary(it.pictureUrl, {
          onRetry: (attempt, msg) => onEvent({ type: "retry", label, attempt, msg }),
        });
      }

      const size = imageSize(buf);
      const orientation = classifyOrientation(size.width, size.height, it.title ?? "");

      if (!skipped) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(abs, buf);
      }

      bytesTotal += buf.length;
      done += 1;
      if (skipped) skipCount += 1;
      else okCount += 1;

      manifest.push({
        id: it.id,
        title: it.title ?? null,
        name,
        date,
        resolution,
        width: size.width,
        height: size.height,
        orientation,
        file: rel,
        bytes: buf.length,
        md5: createHash("md5").update(buf).digest("hex"),
        sourceUrl: it.pictureUrl,
        collectionId: it.collectionId,
        onlineTime: it.onlineTime ?? null,
        updateTime: it.updateTime ?? null,
      });

      onEvent({
        type: "ok",
        label,
        rel,
        bytes: buf.length,
        skipped,
        width: size.width,
        height: size.height,
        orientation,
        done,
        total: planned.length,
        elapsed: Date.now() - startedAt,
        bytesTotal,
        index,
      });
    } catch (err) {
      done += 1;
      failCount += 1;
      manifest.push({
        id: it.id,
        title: it.title ?? null,
        name,
        date,
        resolution,
        file: rel,
        bytes: 0,
        md5: null,
        sourceUrl: it.pictureUrl,
        error: err.message,
      });
      onEvent({
        type: "fail",
        label,
        rel,
        msg: err.message,
        done,
        total: planned.length,
        elapsed: Date.now() - startedAt,
        index,
      });
    }
  });

  manifest.sort((a, b) => b.id - a.id);

  if (!dryRun) {
    const meta = {
      source: "重返未来:1999 官方网站图画集",
      site: SITE_ORIGIN,
      api: `${API_BASE}/picture/query`,
      collectionId: WALLPAPER_COLLECTION_ID,
      collectionName: "游戏壁纸",
      crawledAt: new Date().toISOString(),
      counts: { total: manifest.length, downloaded: okCount, skipped: skipCount, failed: failCount },
      totalBytes: bytesTotal,
      items: manifest,
    };
    await fs.writeFile(path.join(imgDir, "manifest.json"), JSON.stringify(meta, null, 2), "utf8");
  }

  return {
    total: planned.length,
    downloaded: okCount,
    skipped: skipCount,
    failed: failCount,
    bytes: bytesTotal,
    seconds: (Date.now() - startedAt) / 1000,
    manifest,
    imgDir,
  };
}
