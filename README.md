# 重返未来:1999 官网图画集爬虫

抓取《重返未来：1999》官方网站「游戏壁纸」图画集，按日期归档保存到本地，并生成一个**离线画廊网页**用于浏览、筛选和查看原图。

- 数据来源：官网 <https://re.bluepoch.com/home/> 页面自身调用的公开接口
- 图片直链：官方 CDN `gamecms-res.sl916.com`
- 运行环境：**Node.js ≥ 18**（使用内置 `fetch`，零第三方依赖，无需 `npm install`）

> 本项目仅供个人学习与技术研究使用。图片版权归深蓝互动（BLUEPOCH）所有，请勿用于任何商业用途，如有侵权请联系删除。

---

## 两种用法

这个项目有两个入口，**共用同一份下载目录和代码**：

| 入口 | 怎么用 | 适合 |
| --- | --- | --- |
| **图形界面版** | 双击根目录的 **`启动.bat`** | 想点鼠标挑图、看图、看进度 |
| 命令行版 | `node crawl.mjs` | 想批量、写脚本、定时抓取 |

### 图形界面版（推荐先试这个）

双击 `启动.bat` → 会自动打开一个独立应用窗口（Edge/Chrome 的 app 模式，没有地址栏）：

- **官网图集**：拉取全部 1001 张，带缩略图；搜索、按批次筛选、横竖版切换；点卡片多选 → 「下载选中」
- **本地画廊**：浏览已下载的图片，同样的筛选 + 点击看大图
- **设置**：保存目录、并发数、缩略图尺寸与质量、HTTP 代理

启动脚本支持自检，排障时很有用：

```
启动.bat --test
```

详见 [`desktop/README.md`](desktop/README.md)。

---

## 命令行用法

```powershell
# 进入项目目录
cd "D:\AI perfect\1999"

# 1) 先看看有哪些分类
node crawl.mjs --collections

# 2) 只看清单，不下载
node crawl.mjs --list --limit 20

# 3) 全量下载（1000+ 张，约 2GB，默认 6 并发，可续传）
node crawl.mjs

# 4) 打开生成的离线画廊
start .\1999-wallpapers\wallpapers\index.html
```

## 目录结构

```
1999/
├─ 启动.bat                   # ★ 图形界面版启动器（自动定位 desktop\）
├─ start.bat                  # 同上，ASCII 文件名版本
├─ crawl.mjs                  # 命令行入口
├─ src/                       # 命令行版共用模块
│  ├─ crawler.mjs             # 接口请求 / 筛选 / 下载 / 清单
│  ├─ build-index.mjs         # 生成离线画廊页
│  └─ template.html           # 画廊页模板
├─ desktop/                   # 图形界面版
│  ├─ src/server.mjs          # 零依赖本地服务（接口 / 缩略图 / 下载任务）
│  ├─ lib/jpeg.mjs            # 纯 JS JPEG 缩略图引擎
│  ├─ public/app.html         # 界面
│  ├─ data/settings.json      # 设置
│  └─ README.md
└─ 1999-wallpapers/           # 下载结果（两个入口共用）
   └─ wallpapers/
      ├─ index.html           # ★ 离线画廊：双击即可浏览、搜索、放大、下载
      ├─ manifest.json        # 清单：标题/分辨率/尺寸/MD5/来源 URL
      ├─ 2026-09-07/
      │  ├─ 1012_1012 竖版.jpg
      │  └─ 1011_1011 横版.jpg
      ├─ 2026-07-29/
      └─ ...                  # 按官网发布批次（日期）分文件夹
```

> `desktop/data/thumb-cache/` 只存界面缩略图，**可以随时删**，浏览时会自动重建。
> 其中的 `progressive.txt` 记录哪些图是渐进式 JPEG（属性而非缓存），删了也只是多探测一次。

文件名规则：`序号_名称.jpg`，例如 `1012_1012 竖版.jpg`；若标题重复会自动加 `_2`、`_3` 后缀。

---

## 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--out <目录>` | 输出目录，默认 `./1999-wallpapers`（脚本同级） |
| `--list` | 只列清单不下载 |
| `--collections` | 列出官网全部图集分类后退出 |
| `--dry-run` | 演示模式，仅显示将要保存的路径，不写入任何文件 |
| `--limit <n>` | 最多处理 n 张（`0` 或省略 = 全部） |
| `--resolution <WxH>` | 仅保留指定分辨率，如 `2560x1440`、`1125x2436` |
| `--orientation <类型>` | `desktop`（横版/PC）或 `mobile`（竖版/手机） |
| `--date <YYYY-MM-DD>` | 仅保留某个批次日期，如 `2026-09-07` |
| `--from <id>` / `--to <id>` | 按官网 id 区间筛选 |
| `--ids <1,2,3>` | 只下载指定 id |
| `--concurrency <n>` | 并发下载数，默认 `6`（网络好可设 `10`~`16`） |
| `--page-size <n>` | 列表接口分页大小，默认 `100` |
| `--force` | 已存在的文件也重新下载 |
| `--no-index` | 不生成 `index.html` |
| `--json <文件>` | 额外导出一份清单 JSON |
| `-h, --help` | 查看帮助 |

### 常用示例

```powershell
# 只要 PC 横版 2K 壁纸
node crawl.mjs --orientation desktop --resolution 2560x1440

# 只要手机竖版
node crawl.mjs --orientation mobile --concurrency 12

# 只要最新一批（2026-09-07 发布）
node crawl.mjs --date 2026-09-07

# 补下载某几张
node crawl.mjs --ids 1012,1011,1010

# 中断后继续（已下载的文件会秒跳过）
node crawl.mjs

# 自定义输出目录 + 导出清单
node crawl.mjs --out "D:\壁纸\1999" --json "D:\壁纸\1999\list.json"
```

---

## 离线画廊（index.html）

下载结束会自动生成 `wallpapers/index.html`，双击用浏览器打开即可：

- 缩略图瀑布流，懒加载，**不需要联网**
- 按名称 / 编号 / 分辨率搜索
- 按发布批次日期筛选
- 一键切换到「横版 PC」或「竖版 手机」
- 点击缩略图放大原图，`Esc` 关闭；卡片上的「下载原图」按钮可另存
- 随机排序，方便挑选壁纸

> 页面直接读取同目录下的图片文件，所以请**保持 `index.html` 与图片文件夹的相对位置不变**。

---

## 实现说明

### 使用到的官方接口

```
POST https://re.bluepoch.com/activity/official/websites/picture/query
     body: {"current":1,"pageSize":100}
     → data.total = 1001（「游戏壁纸」分类 collectionId=16）

POST https://re.bluepoch.com/activity/official/websites/collection/query
     → 官网全部图集分类：最新/公告/活动/新闻/banner合集/游戏壁纸/游戏视频/游戏音乐
```

### 两个关键坑

1. **CDN 只接受 HTTP/2**
   官方图片 CDN `gamecms-res.sl916.com` 对 HTTP/1.1 请求一律返回 `567`，
   因此程序使用 Node 内置 `fetch`（undici，走 HTTP/2），实测稳定下载。
   用 Python `urllib`/`requests`、PowerShell、curl 直接抓会全部失败。

2. **直链里带中文和空格**
   形如 `.../PICTURE/20260907/1012.竖版-2560x1440_xxx.jpg`，
   必须**逐段百分号编码**后再请求（代码见 `encodeUrl()`）。

### 其他细节

- 标题里的「横版/竖版」与真实分辨率经常对调，所以程序**读取图片文件头**（JPEG/PNG/WebP/GIF）得到真实宽高，
  再据此判定横竖版并写入清单，界面显示以真实尺寸为准。
- 列表按 `weight` 倒序，即 id 越大越新；`--limit` 取的就是最新的一批。
- 支持断点续传：文件已存在且大于 512 字节即跳过，不重复占用带宽。
- 下载失败会自动重试 4 次（递增退避），最后把失败项记录到 `manifest.json`，退出码为 `1`。

---

## 作为模块调用

```js
import { fetchGallery, filterItems, downloadGallery } from "./src/crawler.mjs";

const all = await fetchGallery({ pageSize: 100 });
const items = filterItems(all.filter((i) => i.collectionId === 16), {
  resolution: "2560x1440",
  limit: 10,
});
const result = await downloadGallery({ items, outDir: "./out", concurrency: 8 });
console.log(result.downloaded, result.failed);
```

---

## 常见问题

**Q：提示 `HTTP 567`？**
说明请求没有走 HTTP/2。请确认使用本项目（Node `fetch`），不要改成 `axios`（HTTP/1.1）或 Python 脚本。

**Q：想抓官网其他图集（banner、资讯配图）怎么办？**
`--collections` 能看到全部分类 id，把 `crawl.mjs` 里的 `collectionId === 16` 换成目标 id 即可；
非壁纸类资源的图片字段名可能不同，需要相应调整。

**Q：下载中断了？**
再次运行 `node crawl.mjs` 即可，已下好的会自动跳过。
