// scripts/db-build.mjs —— 扫库，建 patch 索引
//
// 扫描根顺序：--root（可重复）> config/libraries.json > 都没有时只探测候选并退出（绝不静默扫全盘）。

import { existsSync } from "node:fs"
import { relative, sep } from "node:path"
import {
  EXIT,
  UsageError,
  bullet,
  dbPath,
  detectLibraryRoots,
  extOf,
  fileInfo,
  humanSize,
  loadConfig,
  parseArgs,
  tableText,
  walkFiles,
  writeCsv,
} from "./lib.mjs"

const args = parseArgs()
const started = Date.now()

// ---------------------------------------------------------------- 定扫描根
function resolveRoots() {
  const explicit = args.getAll("root").filter(Boolean)
  if (explicit.length) return { roots: explicit.map((p) => ({ path: p })), source: "参数 --root" }

  let cfg = {}
  try {
    cfg = loadConfig()
  } catch (e) {
    throw new UsageError(e.message)
  }
  const fromCfg = (cfg.scan_roots ?? []).filter((r) => r && r.path)
  if (fromCfg.length) return { roots: fromCfg, source: "config/libraries.json" }

  const candidates = detectLibraryRoots()
  if (!candidates.length) {
    throw new UsageError("没有扫描根：给了 --root、也没有 config/libraries.json，探测也没找到候选。")
  }
  return { roots: [], source: "detect", candidates }
}

let plan
try {
  plan = resolveRoots()
} catch (e) {
  if (e instanceof UsageError) {
    console.log(`[用法] ${e.message}`)
    process.exit(EXIT.USAGE)
  }
  throw e
}

if (!plan.roots.length) {
  console.log(bullet("没有扫描配置 —— 探测到的候选"))
  console.log(tableText(["#", "路径"], plan.candidates.map((c, i) => ({ "#": i + 1, 路径: c.path }))))
  console.log(
    `\n没有 config/libraries.json，且没有给 --root，所以**什么都没扫**。\n` +
      `确认上面这些就是要索引的库之后，写一份 config/libraries.json（形状见 config/libraries.example.jsonc），例如：\n` +
      `  { "scan_roots": [${plan.candidates.map((c) => `{ "path": ${JSON.stringify(c.path)} }`).join(", ")}] }\n` +
      `或直接：node scripts/db-build.mjs --root="D:\\..." --db=<要写的 csv>`,
  )
  process.exit(EXIT.USAGE)
}

// ---------------------------------------------------------------- 定规则
const cfg = (() => {
  try {
    return loadConfig()
  } catch {
    return {}
  }
})()
const extensions = (args.getAll("ext").length ? args.getAll("ext") : cfg.extensions ?? [".nki", ".nkm"]).map((e) =>
  e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
)
const exclude = [...(cfg.exclude ?? []), ...args.getAll("exclude")].filter(Boolean)
const maxDepth = args.num("max-depth", cfg.max_depth ?? 0)
const tokens = cfg.library_tokens ?? {}
const out = dbPath(args)

// ---------------------------------------------------------------- 扫
const seen = new Set()
const rows = []
const perRoot = []
for (const r of plan.roots) {
  const root = String(r.path)
  if (!existsSync(root)) {
    perRoot.push({ 根: root, 库数: 0, 文件数: 0, 说明: "不存在，跳过" })
    continue
  }
  const files = walkFiles(root, { maxDepth, exclude, extensions })
  const libs = new Set()
  let added = 0
  for (const full of files) {
    const key = full.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const rel = relative(root, full)
    const parts = rel.split(sep)
    const library = r.label || (parts.length > 1 ? parts[0] : "(root)")
    libs.add(library)

    const st = fileInfo(full)
    rows.push({
      Library: library,
      Token: tokens[library] ?? "",
      RelDir: parts.slice(1, -1).join("/"),
      PatchFile: parts[parts.length - 1],
      Ext: extOf(full),
      Size: st ? st.size : "",
      MTime: st ? Math.floor(st.mtimeMs / 1000) : "",
      Path: full,
    })
    added++
  }
  perRoot.push({ 根: root, 库数: libs.size, 文件数: added, 说明: "" })
}

rows.sort((a, b) => a.Library.localeCompare(b.Library) || a.RelDir.localeCompare(b.RelDir) || a.PatchFile.localeCompare(b.PatchFile))
writeCsv(out, ["Library", "Token", "RelDir", "PatchFile", "Ext", "Size", "MTime", "Path"], rows)

// ---------------------------------------------------------------- 报告
const byLib = new Map()
for (const r of rows) {
  const e = byLib.get(r.Library) ?? { Library: r.Library, Token: r.Token, 文件数: 0, 体积: 0 }
  e.文件数++
  e.体积 += Number(r.Size) || 0
  byLib.set(r.Library, e)
}
const libRows = [...byLib.values()]
  .sort((a, b) => b.文件数 - a.文件数)
  .map((e) => ({ ...e, 体积: humanSize(e.体积), Token: e.Token || "-" }))

console.log(bullet(`扫描根（来自：${plan.source}）`))
console.log(tableText(["根", "库数", "文件数", "说明"], perRoot))
console.log(bullet(`索引结果 —— ${rows.length} 个文件 / ${byLib.size} 个库${exclude.length ? `（排除：${exclude.join("、")}）` : ""}`))
console.log(tableText(["Library", "Token", "文件数", "体积"], libRows.slice(0, 40)))
if (libRows.length > 40) console.log(`… 还有 ${libRows.length - 40} 个库，见 CSV`)
console.log(`\n写入：${out}（${(Date.now() - started) / 1000}s）`)
console.log(`扩展名：${extensions.join(" ")}　深度上限：${maxDepth === 0 ? "不限" : maxDepth}`)

process.exit(EXIT.OK)
