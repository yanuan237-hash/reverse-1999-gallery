/**
 * 根据 manifest.json 生成离线浏览用的 index.html（双击即可看图）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, "template.html");

export async function buildIndex(imgDir) {
  const manifestPath = path.join(imgDir, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  const html = (await fs.readFile(TEMPLATE, "utf8")).replace(
    "__MANIFEST__",
    // 防止 </script> 提前闭合，并保证 JSON 内联安全
    JSON.stringify(manifest).replace(/</g, "\\u003c"),
  );

  const out = path.join(imgDir, "index.html");
  await fs.writeFile(out, html, "utf8");
  return out;
}
