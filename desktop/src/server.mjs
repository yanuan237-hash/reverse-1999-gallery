/**
 * 重返未来:1999 图画集下载器 —— 本地服务（零依赖）
 *
 * 功能：
 *  - 联网列出官网图画集（含缩略图，按需生成并缓存）
 *  - 多选下载、实时进度（SSE）、断点续传
 *  - 浏览本地已下载的画廊（搜索 / 日期 / 横竖版筛选）
 *  - 设置并发数、保存目录、代理
 */

import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  fetchGallery,
  fetchCollections,
  filterItems,
  formatBytes,
  parseTitle,
  dateFromUrl,
  encodeUrl,
  imageSize,
  SITE_ORIGIN,
  REFERER,
} from "../../src/crawler.mjs";
import { makeThumbnail, isProgressive } from "../lib/jpeg.mjs";

/** 代理支持（Node 内置 undici） */
let proxyAgent = null;
try {
  const { ProxyAgent, setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
  const proxy = (await (async () => {
    try {
      return JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "settings.json"), "utf8")).proxy;
    } catch {
      return "";
    }
  })());
  if (proxy) {
    proxyAgent = new ProxyAgent(proxy);
    setGlobalDispatcher(proxyAgent);
  } else if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
} catch {
  /* undici 不可用时直连 */
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, ".."); // desktop/ 目录
const DATA_DIR = path.join(APP_DIR, "data");
const CACHE_DIR = path.join(DATA_DIR, "thumb-cache");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0";

/* --------------------------------------------------------------- 设置存取 */

const DEFAULT_SETTINGS = {
  // 默认放在项目根目录（与命令行版 crawl.mjs 的输出位置一致）
  outDir: path.resolve(HERE, "..", "..", "1999-wallpapers"),
  concurrency: 8,
  proxy: "",
  thumbSize: 480,
  thumbQuality: 80,
};

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/* --------------------------------------------------------------- 小工具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}
function text(res, code, s, type = "text/plain; charset=utf-8") {
  const body = Buffer.from(s, "utf8");
  res.writeHead(code, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
}
function readBody(req, limit = 4 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* --------------------------------------------------- 缩略图生成（限并发） */

await fs.mkdir(CACHE_DIR, { recursive: true });

let thumbQueue = Promise.resolve();
function withThumbSlot(fn) {
  const run = thumbQueue.then(fn, fn);
  thumbQueue = run.then(
    () => sleep(0),
    () => sleep(0),
  );
  return run;
}

const remoteCache = new Map(); // url -> Buffer（原始图，限制条数）

async function fetchRemote(url, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(encodeUrl(url), {
        headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: REFERER },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error(`内容过小 ${buf.length}`);
      return buf;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(400 * i);
    }
  }
  throw lastErr;
}

/**
 * 渐进式图片名单（键为图片直链，与缩略图尺寸无关）。
 * 渐进式 JPEG 走不了 DC 快速路径，前端会改用原图直链；
 * 这里记下来，避免换个缩略图尺寸又重新下载一遍大图。
 */
const progressiveUrls = new Set();
const PROG_LIST = path.join(CACHE_DIR, "progressive.txt");
try {
  const txt = await fs.readFile(PROG_LIST, "utf8");
  for (const line of txt.split("\n")) if (line.trim()) progressiveUrls.add(line.trim());
} catch {
  /* 首次运行 */
}
let progListDirty = false;
async function markProgressive(url) {
  if (progressiveUrls.has(url)) return;
  progressiveUrls.add(url);
  progListDirty = true;
  // 合并写，避免每个请求都落一次盘
  clearTimeout(markProgressive._t);
  markProgressive._t = setTimeout(async () => {
    if (!progListDirty) return;
    progListDirty = false;
    await fs.writeFile(PROG_LIST, [...progressiveUrls].join("\n"), "utf8").catch(() => {});
  }, 1500);
}

/** 取缩略图；渐进式 JPEG 无法用快速路径，返回 { buf: null } 让前端用原图 */
async function getThumbnail(url, maxSize, quality) {
  const key = createHash("md5").update(`${url}|${maxSize}|${quality}`).digest("hex");
  const file = path.join(CACHE_DIR, `${key}.jpg`);

  try {
    const st = await fs.stat(file);
    if (st.size > 256) return { buf: await fs.readFile(file), cached: true };
  } catch {
    /* 未缓存 */
  }
  // 已知是渐进式：直接让前端用原图，不再下载大图
  if (progressiveUrls.has(url)) return { buf: null, progressive: true };

  let src = remoteCache.get(url);
  if (!src) {
    src = await fetchRemote(url);
    if (remoteCache.size > 160) remoteCache.delete(remoteCache.keys().next().value);
    remoteCache.set(url, src);
  }

  // 渐进式：无法走 DC 快速路径，交给浏览器直接解码原图
  if (isProgressive(src)) {
    markProgressive(url);
    return { buf: null, progressive: true };
  }

  const t = makeThumbnail(src, maxSize, quality);
  await fs.writeFile(file, t.buf);
  return { buf: t.buf, cached: false, width: t.width, height: t.height };
}

/** 清空缩略图缓存（渐进式名单保留，它不是缓存而是图片属性） */
async function clearThumbCache() {
  let n = 0;
  for (const f of await fs.readdir(CACHE_DIR)) {
    if (f === "progressive.txt") continue;
    await fs.unlink(path.join(CACHE_DIR, f)).catch(() => {});
    n++;
  }
  return n;
}

/* --------------------------------------------------------------- 下载任务 */

const state = {
  job: null, // { total, done, ok, skip, fail, bytes, startedAt, items, finished, listeners:Set }
};

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function runDownload(items, settings, onEvent) {
  const outDir = path.resolve(settings.outDir);
  const imgDir = path.join(outDir, "wallpapers");
  await fs.mkdir(imgDir, { recursive: true });

  const used = new Set();
  const planned = items.map((it) => {
    const { name } = parseTitle(it.title, it.id);
    const date = dateFromUrl(it.pictureUrl);
    const ext = path.extname(new URL(it.pictureUrl).pathname) || ".jpg";
    const base = `${String(it.id).padStart(4, "0")}_${name.replace(/[\\/:*?"<>|]/g, "_").trim() || "wallpaper"}`;
    let fileName = `${base}${ext}`;
    let n = 2;
    while (used.has(`${date}/${fileName}`.toLowerCase())) fileName = `${base}_${n++}${ext}`;
    used.add(`${date}/${fileName}`.toLowerCase());
    return { it, name, date, dir: path.join(imgDir, date), fileName };
  });

  /** 下载任务：manifest 的 file 字段相对 wallpapers/ 目录 */
  const wallpapersDir = path.join(path.resolve(settings.outDir), "wallpapers");
  const manifestPath = path.join(wallpapersDir, "manifest.json");
  let existing = { items: [] };
  try {
    existing = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    /* 首次下载 */
  }
  const byId = new Map((existing.items ?? []).map((x) => [x.id, x]));

  let cursor = 0;
  let done = 0;
  let bytes = 0;
  const startedAt = Date.now();

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= planned.length) return;
      const plan = planned[i];
      const abs = path.join(plan.dir, plan.fileName);
      const rel = path.relative(wallpapersDir, abs).split(path.sep).join("/");
      const label = `#${plan.it.id} ${plan.name}`;
      try {
        let buf = null;
        let skipped = false;
        try {
          const st = await fs.stat(abs);
          if (st.size > 512) {
            buf = await fs.readFile(abs);
            skipped = true;
          }
        } catch {
          /* 需要下载 */
        }
        if (!buf) {
          buf = await fetchRemote(plan.it.pictureUrl);
          await fs.mkdir(plan.dir, { recursive: true });
          await fs.writeFile(abs, buf);
        }
        const size = imageSize(buf);
        const orientation =
          size.width && size.height
            ? size.width > size.height
              ? "desktop"
              : "mobile"
            : (plan.it.title ?? "").includes("竖")
              ? "mobile"
              : "desktop";
        byId.set(plan.it.id, {
          id: plan.it.id,
          title: plan.it.title ?? null,
          name: plan.name,
          date: plan.date,
          width: size.width,
          height: size.height,
          orientation,
          file: rel,
          bytes: buf.length,
          md5: createHash("md5").update(buf).digest("hex"),
          sourceUrl: plan.it.pictureUrl,
        });
        done++;
        bytes += buf.length;
        onEvent({ type: skipped ? "skip" : "ok", label, rel, bytes: buf.length, done, total: planned.length, bytesTotal: bytes, elapsed: Date.now() - startedAt });
      } catch (e) {
        done++;
        onEvent({ type: "fail", label, msg: e.message, done, total: planned.length, elapsed: Date.now() - startedAt });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(settings.concurrency, planned.length)) }, worker));

  const items2 = [...byId.values()].sort((a, b) => b.id - a.id);
  const meta = {
    source: "重返未来:1999 官方网站图画集",
    site: SITE_ORIGIN,
    crawledAt: new Date().toISOString(),
    totalBytes: items2.reduce((s, x) => s + (x.bytes || 0), 0),
    items: items2,
  };
  await fs.writeFile(manifestPath, JSON.stringify(meta, null, 2), "utf8");
  return { imgDir, manifestPath, count: items2.length };
}

/* ------------------------------------------------------------------ 本地库 */

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.toLowerCase().startsWith(rootAbs.toLowerCase() + path.sep)) throw new Error("非法路径");
  return abs;
}

/**
 * manifest 的 file 字段可能有两种写法：
 *   - 命令行版 crawl.mjs： "wallpapers/2026-09-07/xxx.jpg"
 *   - 本应用下载：          "2026-09-07/xxx.jpg"
 * 统一成相对 wallpapers/ 的路径。
 */
function normalizeRel(rel) {
  let f = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
  if (f.toLowerCase().startsWith("wallpapers/")) f = f.slice("wallpapers/".length);
  return f;
}

async function loadLibrary(settings) {
  const imgDir = path.join(path.resolve(settings.outDir), "wallpapers");
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(imgDir, "manifest.json"), "utf8"));
  } catch {
    /* 没有清单 */
  }
  const items = [];
  const dates = new Set();
  if (manifest?.items) {
    for (const it of manifest.items) {
      const rel = normalizeRel(it.file);
      const abs = path.join(path.resolve(settings.outDir), "wallpapers", rel);
      let exists = false;
      let bytes = it.bytes ?? 0;
      try {
        const st = await fs.stat(abs);
        exists = st.size > 512;
        bytes = st.size;
      } catch {
        exists = false;
      }
      if (!exists) continue;
      items.push({ ...it, file: rel, bytes });
      dates.add(it.date);
    }
  }
  return {
    imgDir,
    hasManifest: !!manifest,
    crawledAt: manifest?.crawledAt ?? null,
    totalBytes: items.reduce((s, x) => s + (x.bytes || 0), 0),
    dates: [...dates].sort().reverse(),
    items,
  };
}

/* ------------------------------------------------------------------- 路由 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);

  /* ---- 页面 ---- */
  if (p === "/" || p === "/index.html") {
    const html = await fs.readFile(path.join(PUBLIC_DIR, "app.html"));
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
    return res.end(html);
  }

  /* ---- 设置 ---- */
  if (p === "/api/settings" && req.method === "GET") {
    return json(res, 200, await loadSettings());
  }
  if (p === "/api/settings" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const patch = {};
    if (typeof body.concurrency === "number") patch.concurrency = Math.min(32, Math.max(1, Math.round(body.concurrency)));
    if (typeof body.outDir === "string" && body.outDir.trim()) patch.outDir = path.resolve(body.outDir.trim());
    if (typeof body.proxy === "string") patch.proxy = body.proxy.trim();
    if (typeof body.thumbSize === "number") patch.thumbSize = Math.min(900, Math.max(200, Math.round(body.thumbSize)));
    if (typeof body.thumbQuality === "number") patch.thumbQuality = Math.min(95, Math.max(40, Math.round(body.thumbQuality)));
    return json(res, 200, await saveSettings(patch));
  }

  /* ---- 官网分类 ---- */
  if (p === "/api/collections") {
    try {
      const cols = await fetchCollections();
      return json(res, 200, { ok: true, collections: cols });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  /* ---- 远程清单 ---- */
  if (p === "/api/remote") {
    const settings = await loadSettings();
    try {
      const all = await fetchGallery({ pageSize: 100 });
      const items = all.map((it) => {
        const { name, resolution } = parseTitle(it.title, it.id);
        const [w, h] = (resolution ?? "0x0").split("x").map(Number);
        const orientation = w && h && w !== h ? (w > h ? "desktop" : "mobile") : (it.title ?? "").includes("竖") ? "mobile" : "desktop";
        return {
          id: it.id,
          name,
          resolution,
          orientation,
          date: dateFromUrl(it.pictureUrl),
          title: it.title,
          pictureUrl: it.pictureUrl,
          collectionId: it.collectionId,
        };
      });
      return json(res, 200, { ok: true, items, settings: { concurrency: settings.concurrency, outDir: settings.outDir } });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  /* ---- 远程缩略图（按需生成 + 磁盘缓存） ---- */
  if (p === "/api/thumb") {
    const target = url.searchParams.get("u");
    if (!target) return text(res, 400, "missing u");
    const settings = await loadSettings();
    try {
      const r = await withThumbSlot(() =>
        getThumbnail(target, Number(url.searchParams.get("s")) || settings.thumbSize, settings.thumbQuality),
      );
      if (!r.buf) {
        // 渐进式图片：告诉前端改用原图直链
        res.writeHead(204, { "X-Thumb": "use-original" });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": r.buf.length,
        "Cache-Control": "public, max-age=604800",
        "X-Thumb": r.cached ? "cached" : "generated",
      });
      return res.end(r.buf);
    } catch (e) {
      return text(res, 502, "缩略图失败: " + e.message);
    }
  }

  /* ---- 清空缩略图缓存 ---- */
  if (p === "/api/thumb-clear" && req.method === "POST") {
    const n = await clearThumbCache();
    return json(res, 200, { ok: true, cleared: n });
  }

  /* ---- 开始下载 ---- */
  if (p === "/api/download" && req.method === "POST") {
    if (state.job && !state.job.finished) return json(res, 409, { ok: false, error: "已有下载任务在进行中" });
    const body = JSON.parse((await readBody(req)) || "{}");
    const settings = await loadSettings();
    let items = body.items ?? [];
    if (body.filter) {
      const all = await fetchGallery({ pageSize: 100 });
      items = filterItems(all, body.filter);
    }
    if (!items.length) return json(res, 400, { ok: false, error: "没有要下载的图片" });

    const job = {
      total: items.length,
      done: 0,
      ok: 0,
      skip: 0,
      fail: 0,
      bytes: 0,
      startedAt: Date.now(),
      finished: false,
      listeners: new Set(),
      recent: [],
      error: null,
    };
    state.job = job;

    runDownload(items, settings, (e) => {
      job.done = e.done;
      if (e.type === "ok") job.ok++;
      else if (e.type === "skip") job.skip++;
      else if (e.type === "fail") job.fail++;
      job.bytes = e.bytesTotal ?? job.bytes;
      const line = { ...e, at: Date.now() };
      job.recent.push(line);
      if (job.recent.length > 200) job.recent.shift();
      for (const l of job.listeners) sseSend(l, e.type, line);
    })
      .then((r) => {
        job.finished = true;
        job.result = r;
        for (const l of job.listeners) sseSend(l, "done", { ok: true, ...r, ok_count: job.ok, skip: job.skip, fail: job.fail, bytes: job.bytes });
      })
      .catch((err) => {
        job.finished = true;
        job.error = err.message;
        for (const l of job.listeners) sseSend(l, "done", { ok: false, error: err.message });
      });

    return json(res, 200, { ok: true, total: items.length });
  }

  /* ---- 当前任务状态（JSON，SSE 之外的兜底查询） ---- */
  if (p === "/api/status") {
    const j = state.job;
    return json(res, 200, {
      ok: true,
      job: j
        ? {
            total: j.total,
            done: j.done,
            ok: j.ok,
            skip: j.skip,
            fail: j.fail,
            bytes: j.bytes,
            finished: j.finished,
            error: j.error,
            result: j.result ?? null,
            elapsed: Date.now() - j.startedAt,
            recent: j.recent.slice(-40),
          }
        : null,
    });
  }

  /* ---- 进度 SSE ---- */
  if (p === "/api/progress") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const job = state.job;
    res.write(`event: hello\ndata: ${JSON.stringify(job ? { total: job.total, done: job.done, ok: job.ok, skip: job.skip, fail: job.fail, finished: job.finished, recent: job.recent.slice(-30) } : null)}\n\n`);
    if (!job) return res.end();
    job.listeners.add(res);
    const keep = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(keep);
      job.listeners.delete(res);
    });
    return;
  }

  /* ---- 本地库清单 ---- */
  if (p === "/api/library") {
    const settings = await loadSettings();
    try {
      return json(res, 200, { ok: true, ...(await loadLibrary(settings)), outDir: settings.outDir });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  /* ---- 本地图片 ---- */
  if (p === "/api/file") {
    const rel = url.searchParams.get("f");
    if (!rel) return text(res, 400, "missing f");
    const settings = await loadSettings();
    // manifest 里的 file 字段统一按相对 wallpapers/ 处理
    const libRoot = path.join(path.resolve(settings.outDir), "wallpapers");
    let abs;
    try {
      abs = safeJoin(libRoot, normalizeRel(rel));
    } catch {
      return text(res, 403, "forbidden");
    }
    try {
      const st = await fs.stat(abs);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": "public, max-age=86400",
      });
      return createReadStream(abs).pipe(res);
    } catch {
      return text(res, 404, "not found");
    }
  }

  /* ---- 健康检查 ---- */
  if (p === "/api/ping") return json(res, 200, { ok: true, port: server.address().port });

  return text(res, 404, "404");
}

/* ------------------------------------------------------------------- 启动 */

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try {
      json(res, 500, { ok: false, error: e.message });
    } catch {
      /* 已发送 */
    }
  });
});

// 端口优先级：命令行参数 > 环境变量 PORT > 随机空闲端口
const argPort = Number((process.argv[2] ?? "").trim());
const preferred = Number.isFinite(argPort) && argPort > 0 ? argPort : Number(process.env.PORT || 0);
const PORT = await new Promise((resolve, reject) => {
  const s = server.listen(preferred || 0, "127.0.0.1", () => resolve(s.address().port));
  s.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`[X] 端口 ${preferred} 已被占用。请关掉占用它的程序，或修改 启动.bat 里的 PORT。`);
      process.exit(2);
    }
    reject(e);
  });
});

console.log(`PORT=${PORT}`);
console.log(`URL=http://127.0.0.1:${PORT}/`);
void launchHint(PORT);

async function launchHint(port) {
  const s = await loadSettings();
  console.log(`保存目录=${path.resolve(s.outDir)}`);
  console.log(`并发=${s.concurrency}`);
  if (process.env.DSH_NO_OPEN !== "1") {
    // 由启动器负责打开窗口；这里只提示
  }
}

process.on("SIGINT", () => process.exit(0));
