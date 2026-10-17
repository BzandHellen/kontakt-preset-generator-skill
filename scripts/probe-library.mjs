// scripts/probe-library.mjs —— 进新库先探测
//
// 两种模式：
//   --patch=<x.nki>（可多个）或 --library=<库名>（从索引里挑几个浅的）
//   --api  → 只列 Kontakt 这张表里能用的函数（确认某版本有没有某个 API）
// 只读：不保存任何东西。

import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { EXIT, UsageError, bullet, dbPath, launchKontakt, parseArgs, preflight, readCsv, reportsDir, workspaceDir } from "./lib.mjs"
import { renderJob } from "./job.mjs"

const args = parseArgs()
const ws = workspaceDir(args)
const repDir = reportsDir(args)
const timeoutS = args.num("timeout", 300)

const CHECK = args.getAll("check").length
  ? args.getAll("check")
  : [
      "set_instrument_options",
      "get_instrument_options",
      "set_instrument_output_channel",
      "set_instrument_mute",
      "set_instrument_solo",
      "set_instrument_tune",
      "set_instrument_polyphony",
      "load_snapshot",
      "save_snapshot",
      "get_num_zones",
      "set_group_volume",
    ]

let job
let label

if (args.bool("api")) {
  label = "api"
  job = { mode: "api", report: join(repDir, `probe-api-${stampText()}.txt`).replace(/\\/g, "/"), check: CHECK }
} else {
  let patches = args.getAll("patch").filter(Boolean)
  if (!patches.length) {
    const library = args.get("library", "")
    if (!library) {
      console.error("[用法] 要 --patch=<x.nki>（可多个）、--library=<库名>，或 --api")
      process.exit(EXIT.USAGE)
    }
    const db = dbPath(args)
    if (!existsSync(db)) {
      console.error(`[用法] 还没有库索引（${db}）—— 先 db_build，或直接给 --patch`)
      process.exit(EXIT.USAGE)
    }
    const limit = args.num("limit", 3)
    const rows = readCsv(db)
      .filter((r) => String(r.Library).toLowerCase().includes(library.toLowerCase()) && String(r.Ext) === ".nki")
      // 浅的优先：路径段少的通常是一体化的乐器（而不是多层 articulation）
      .sort((a, b) => a.Path.split("/").length - b.Path.split("/").length || a.Path.localeCompare(b.Path))
    const pick = []
    const seen = new Set()
    for (const r of rows) {
      const dir = r.RelDir
      if (args.bool("spread") && seen.has(dir)) continue
      seen.add(dir)
      pick.push(r)
      if (pick.length >= limit) break
    }
    if (!pick.length) {
      console.error(`[用法] 索引里没有库名含「${library}」的 .nki`)
      process.exit(EXIT.USAGE)
    }
    patches = pick.map((r) => r.Path)
    label = `${library}（${patches.length} 个）`
    for (const p of patches) console.log(`选中：${p}`)
  } else {
    label = `${patches.length} 个 patch`
  }
  const bad = patches.filter((p) => !existsSync(resolve(p)))
  if (bad.length) {
    console.error(`[用法] 这些文件不存在：\n  ${bad.join("\n  ")}`)
    process.exit(EXIT.USAGE)
  }
  job = {
    mode: "patches",
    report: join(repDir, `probe-${slugText(args.get("library", "patch"))}-${stampText()}.txt`).replace(/\\/g, "/"),
    patches: patches.map((p) => resolve(p).replace(/\\/g, "/")),
    census: args.num("census", 20),
    words: args.num("words", 25),
  }
}

const rendered = renderJob("job_probe_library.lua", job, { args, slug: `probe-${label}` })

console.log(bullet("库探测（只读）"))
console.log(`对象：${label}`)
console.log(`作业：${rendered.file}`)
console.log(`报告：${job.report}`)

const pf = preflight(args)
if (pf.notes.length) console.log(`\n注意：${pf.notes.join("；")}`)

if (args.bool("dry-run")) {
  console.log(`\n（dry-run：没启动 Kontakt。前置检查：${pf.problems.length ? pf.problems.join("；") : "通过"}）`)
  process.exit(pf.problems.length ? EXIT.ENV : EXIT.OK)
}
if (pf.problems.length) {
  console.error(`[环境] ${pf.problems.join("；")}`)
  process.exit(EXIT.ENV)
}

const res = await launchKontakt({ exe: pf.exe, script: rendered.file, timeoutS, explicitReport: job.report, reportsDirPath: repDir })
console.log(`\n退出：${res.timedOut ? `超时（${timeoutS}s）` : `code ${res.exitCode}`}　${(res.ms / 1000).toFixed(1)}s`)
console.log(`报告：${res.reportPath ?? "（没找到）"}　OK ${res.oks} / FAIL ${res.fails}`)
console.log(`\n---- 报告原文 ----`)
const lines = res.reportText.split(/\r?\n/).filter((l) => l.trim())
const tail = lines.length > 200 ? lines.slice(-200) : lines
if (lines.length > 200) console.log(`（太长，只列最后 200 行，共 ${lines.length} 行）`)
console.log(tail.join("\n"))

process.exit(res.timedOut || res.fails ? EXIT.ISSUES : EXIT.OK)

function stampText() {
  const d = new Date()
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}
function slugText(s) {
  return String(s || "patch").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 40)
}
