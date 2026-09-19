#!/usr/bin/env node
/**
 * 重返未来:1999 官网图画集下载器
 *
 * 用法示例：
 *   node crawl.mjs --list
 *   node crawl.mjs --list --resolution 2560x1440
 *   node crawl.mjs --dry-run --limit 20
 *   node crawl.mjs
 *   node crawl.mjs --orientation desktop --concurrency 8
 *   node crawl.mjs --collections
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

import {
  fetchGallery,
  fetchCollections,
  filterItems,
  downloadGallery,
  formatBytes,
  parseTitle,
  dateFromUrl,
} from "./src/crawler.mjs";
import { buildIndex } from "./src/build-index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
重返未来:1999 官网图画集下载器

用法:
  node crawl.mjs [选项]

选项:
  --out <目录>            输出目录（默认 ./1999-wallpapers，即脚本同级）
  --list                  只列出清单，不下载
  --collections           列出官网所有图集分类后退出
  --dry-run               演示模式：显示将要保存的文件名，不发起下载
  --limit <n>             最多处理 n 张（0 = 全部，默认全部）
  --resolution <WxH>      仅保留指定分辨率，如 2560x1440
  --orientation <类型>     desktop(横版/PC) | mobile(竖版/手机)
  --date <YYYY-MM-DD>     仅保留某个上传日期的图片
  --from <id>             仅保留 id >= n
  --to <id>               仅保留 id <= n
  --ids <1,2,3>           仅下载指定 id
  --concurrency <n>       并发下载数（默认 6）
  --page-size <n>         接口分页大小（默认 100）
  --force                 已存在的文件也重新下载
  --no-index              不生成 index.html 预览页
  --json <文件>           额外把清单写成 JSON
  -h, --help              显示帮助

示例:
  node crawl.mjs --list --resolution 2560x1440
  node crawl.mjs --orientation mobile --concurrency 10
  node crawl.mjs --from 900 --dry-run
`.trim();

function parseArgs(argv) {
  const opts = {
    out: path.join(HERE, "1999-wallpapers"),
    limit: null,
    concurrency: 6,
    pageSize: 100,
    force: false,
    list: false,
    collections: false,
    dryRun: false,
    index: true,
    json: null,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`选项 ${name} 缺少参数`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--out": opts.out = path.resolve(need(i, a)); i++; break;
      case "--list": opts.list = true; break;
      case "--collections": opts.collections = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--limit": opts.limit = Number(need(i, a)); i++; break;
      case "--resolution": opts.resolution = need(i, a); i++; break;
      case "--orientation": opts.orientation = need(i, a); i++; break;
      case "--date": opts.date = need(i, a); i++; break;
      case "--from": opts.from = Number(need(i, a)); i++; break;
      case "--to": opts.to = Number(need(i, a)); i++; break;
      case "--ids":
        opts.ids = need(i, a).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        i++;
        break;
      case "--concurrency": opts.concurrency = Math.max(1, Number(need(i, a))); i++; break;
      case "--page-size": opts.pageSize = Math.max(1, Number(need(i, a))); i++; break;
      case "--force": opts.force = true; break;
      case "--no-index": opts.index = false; break;
      case "--json": opts.json = path.resolve(need(i, a)); i++; break;
      default:
        throw new Error(`未知选项: ${a}（用 --help 查看用法）`);
    }
  }
  return opts;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}
function info(msg) {
  process.stdout.write(`${styleText("cyan", "›")} ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`${styleText("yellow", "!")} ${msg}\n`);
}
function bad(msg) {
  process.stderr.write(`${styleText("red", "✗")} ${msg}\n`);
}
function good(msg) {
  process.stdout.write(`${styleText("green", "✓")} ${msg}\n`);
}

function shortError(msg) {
  const s = String(msg);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    bad(err.message);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    log(HELP);
    return;
  }

  log(styleText(["bold", "yellow"], "\n重返未来:1999 官网图画集下载器"));
  log(styleText("dim", "  数据来源：re.bluepoch.com 官方公开接口\n"));

  if (opts.collections) {
    const cols = await fetchCollections();
    log("官网图集分类：");
    for (const c of cols) {
      const typeName = { 1: "资讯", 2: "视频", 3: "图片", 4: "音乐" }[c.type] ?? `类型${c.type}`;
      log(`  [${String(c.id).padStart(3)}] ${c.name}  (${typeName})`);
    }
    log("");
    return;
  }

  info("正在获取图画集清单…");
  const all = await fetchGallery({
    pageSize: opts.pageSize,
    onProgress: (m) => process.stdout.write(`\r  ${m}      `),
  });
  process.stdout.write("\r");
  const wallpapers = all.filter((it) => it.collectionId === 16);
  good(`接口返回 ${all.length} 条，其中「游戏壁纸」分类 ${wallpapers.length} 条`);

  const items = filterItems(wallpapers, opts);
  if (items.length === 0) {
    warn("筛选后没有匹配的图片，试试放宽 --resolution / --orientation / --date 条件");
    return;
  }
  info(`筛选后待处理 ${items.length} 张`);

  if (opts.list) {
    log("");
    log("  ID     日期        分辨率       名称");
    log("  " + "-".repeat(62));
    for (const it of items) {
      const { name, resolution } = parseTitle(it.title, it.id);
      log(
        `  ${String(it.id).padEnd(6)} ${dateFromUrl(it.pictureUrl)}  ${(resolution ?? "-").padEnd(12)} ${name}`,
      );
    }
    log("");
    good(`共 ${items.length} 张（未下载，去掉 --list 即开始下载）`);
    return;
  }

  info(`输出目录：${path.resolve(opts.out)}`);
  info(`并发数：${opts.concurrency}${opts.dryRun ? "（演示模式，不会写入文件）" : ""}`);
  log("");

  const result = await downloadGallery({
    items,
    outDir: opts.out,
    concurrency: opts.concurrency,
    force: opts.force,
    dryRun: opts.dryRun,
    onEvent: (e) => {
      const pct = e.total ? Math.floor((e.done / e.total) * 100) : 0;
      const barLen = 20;
      const filled = Math.round((pct / 100) * barLen);
      const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
      if (e.type === "ok") {
        const tag = e.skipped ? styleText("dim", "已存在") : styleText("green", "下载完成");
        const speed = e.elapsed > 0 ? formatBytes((e.bytesTotal / e.elapsed) * 1000) + "/s" : "";
        process.stdout.write(
          `\r  [${bar}] ${String(pct).padStart(3)}%  ${tag}  ${shortError(e.label)}` +
            `  ${formatBytes(e.bytes)}  ${styleText("dim", speed)}          \n`,
        );
      } else if (e.type === "fail") {
        process.stdout.write(
          `\r  [${bar}] ${String(pct).padStart(3)}%  ${styleText("red", "失败")}  ${shortError(e.label)}` +
            `  ${styleText("red", shortError(e.msg))}          \n`,
        );
      } else if (e.type === "retry") {
        process.stdout.write(`\r  ${styleText("yellow", "重试")} ${shortError(e.label)} (第 ${e.attempt} 次: ${shortError(e.msg)})\n`);
      } else if (e.type === "dry") {
        process.stdout.write(`  ${styleText("dim", "将保存")} ${e.rel}\n`);
      }
    },
  });

  log("");
  if (!opts.dryRun) {
    good(
      `完成：新增 ${result.downloaded} 张，跳过 ${result.skipped} 张，失败 ${result.failed} 张，` +
        `共 ${formatBytes(result.bytes)}，耗时 ${result.seconds.toFixed(1)}s`,
    );
    log(`  图片目录：${result.imgDir}`);

    if (opts.index) {
      const indexPath = await buildIndex(result.imgDir);
      good(`已生成预览页：${indexPath}（浏览器打开即可浏览）`);
    }

    if (opts.json) {
      const fs = await import("node:fs/promises");
      const meta = { crawledAt: new Date().toISOString(), counts: result, items: result.manifest };
      await fs.writeFile(opts.json, JSON.stringify(meta, null, 2), "utf8");
      good(`已写出清单：${opts.json}`);
    }
  } else {
    good(`演示结束：共 ${result.total} 张将按上述路径保存（未写入任何文件）`);
  }

  if (result.failed > 0) {
    warn("存在失败条目，直接再次运行本命令即可续传（已下载的文件会自动跳过）");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  bad(err?.stack ?? String(err));
  process.exitCode = 1;
});
