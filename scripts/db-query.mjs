// scripts/db-query.mjs —— 查 patch 索引
//
// 过滤器除 --patch / --folder 是正则外，其余都是大小写不敏感的子串。

import { existsSync } from "node:fs"
import { EXIT, bullet, dbPath, humanSize, parseArgs, readCsv, tableText } from "./lib.mjs"

const args = parseArgs()
const db = dbPath(args)

if (!existsSync(db)) {
  console.error(`[用法] 还没有索引：${db} —— 先跑 db_build`)
  process.exit(EXIT.USAGE)
}

const want = (name) => args.get(name, "").trim()
let rePatch = null
let reFolder = null
try {
  if (want("patch")) rePatch = new RegExp(want("patch"), "i")
  if (want("folder")) reFolder = new RegExp(want("folder"), "i")
} catch (e) {
  console.error(`[用法] 正则写错了：${e.message}`)
  process.exit(EXIT.USAGE)
}

const has = (v, sub) => String(v ?? "").toLowerCase().includes(sub.toLowerCase())

const all = readCsv(db)
const rows = all.filter((r) => {
  if (want("library") && !has(r.Library, want("library"))) return false
  if (want("token") && !has(r.Token, want("token"))) return false
  if (want("ext") && String(r.Ext).toLowerCase() !== want("ext").toLowerCase().replace(/^\./, ".")) return false
  if (rePatch && !rePatch.test(r.PatchFile)) return false
  if (reFolder && !reFolder.test(r.RelDir)) return false
  return true
})

// ---------------------------------------------------------------- 计数模式
if (args.bool("count")) {
  const key = want("by") || "Library"
  const m = new Map()
  for (const r of rows) m.set(r[key] ?? "", (m.get(r[key] ?? "") ?? 0) + 1)
  const out = [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ [key]: k, 文件数: n }))
  console.log(bullet(`按 ${key} 计数 —— 命中 ${rows.length} 个文件 / ${out.length} 组（库总量 ${all.length}）`))
  console.log(tableText([key, "文件数"], out.slice(0, 100)))
  if (out.length > 100) console.log(`… 还有 ${out.length - 100} 组`)
  process.exit(EXIT.OK)
}

const limit = args.num("limit", 60)
const shown = args.bool("all") ? rows : rows.slice(0, limit)
const table = shown.map((r, i) => ({
  "#": i + 1,
  Library: r.Library,
  RelDir: r.RelDir,
  PatchFile: r.PatchFile,
  体积: humanSize(r.Size),
}))

console.log(bullet(`命中 ${rows.length} 个文件（库总量 ${all.length}）${rows.length > shown.length ? `，只列前 ${shown.length} 个` : ""}`))
if (table.length) {
  console.log(tableText(["#", "Library", "RelDir", "PatchFile", "体积"], table))
  if (args.bool("paths") || args.num("limit", 60) <= 20) {
    console.log("\n完整路径：")
    for (const r of shown) console.log(`  ${r.Path}`)
  }
} else {
  console.log("（没命中）")
}

process.exit(EXIT.OK)
