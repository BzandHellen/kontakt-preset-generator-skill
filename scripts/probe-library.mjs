// scripts/probe-library.mjs —— 进新库先探测
//
// 三种模式：
//   --patch=<x.nki>（可多个）或 --library=<库名>   普查 group 名 / 库类型 / 麦克风名候选
//   --api                                       只列 Kontakt 这张表里能用的函数（确认某版本有没有某个 API）
//   --structure                                 探「技法/力度层是脚本实现的，还是 Kontakt 原生实现的」
// 全部只读：不保存任何东西。

import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import {
  EXIT,
  bullet,
  dbPath,
  launchKontakt,
  parseArgs,
  parseMachineBlock,
  preflight,
  readCsv,
  reportsDir,
  tableText,
  workspaceDir,
} from "./lib.mjs"
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
      "set_group_start_options",
      "get_group_start_options",
      "set_zone_low_velocity",
      "set_zone_high_velocity",
      "load_snapshot",
      "save_snapshot",
      "get_num_zones",
      "set_group_volume",
    ]

// 从索引里挑几个浅的 patch（--library 用）
function pickFromDb(library, limit, spread) {
  const db = dbPath(args)
  if (!existsSync(db)) {
    console.error(`[用法] 还没有库索引（${db}）—— 先 db_build，或直接给 --patch`)
    process.exit(EXIT.USAGE)
  }
  const rows = readCsv(db)
    .filter((r) => String(r.Library).toLowerCase().includes(library.toLowerCase()) && String(r.Ext) === ".nki")
    .sort((a, b) => a.Path.split("/").length - b.Path.split("/").length || a.Path.localeCompare(b.Path))
  const pick = []
  const seen = new Set()
  for (const r of rows) {
    if (spread && seen.has(r.RelDir)) continue
    seen.add(r.RelDir)
    pick.push(r)
    if (pick.length >= limit) break
  }
  return pick
}

let job
let label
let mode

if (args.bool("structure")) {
  mode = "structure"
  let patches = args.getAll("patch").filter(Boolean).map((p) => resolve(p))
  if (!patches.length) {
    const library = args.get("library", "")
    if (!library) {
      console.error("[用法] --structure 要 --patch=<x.nki>（可多个）或 --library=<库名>")
      process.exit(EXIT.USAGE)
    }
    const pick = pickFromDb(library, args.num("limit", 2), args.bool("spread"))
    if (!pick.length) {
      console.error(`[用法] 索引里没有库名含「${library}」的 .nki`)
      process.exit(EXIT.USAGE)
    }
    patches = pick.map((r) => r.Path)
    label = `structure ${library}（${patches.length} 个）`
    for (const p of patches) console.log(`选中：${p}`)
  } else {
    label = `structure ${patches.length} 个 patch`
  }
  const bad = patches.filter((p) => !existsSync(p))
  if (bad.length) {
    console.error(`[用法] 这些文件不存在：\n  ${bad.join("\n  ")}`)
    process.exit(EXIT.USAGE)
  }
  job = {
    mode,
    report: join(repDir, `structure-${slugText(args.get("library", "patch"))}-${stampText()}.txt`).replace(/\\/g, "/"),
    patches: patches.map((p) => p.replace(/\\/g, "/")),
    zones: args.num("zones", 150000),
  }
} else if (args.bool("api")) {
  mode = "api"
  label = "api"
  job = { mode, report: join(repDir, `probe-api-${stampText()}.txt`).replace(/\\/g, "/"), check: CHECK }
} else {
  mode = "patches"
  let patches = args.getAll("patch").filter(Boolean).map((p) => resolve(p))
  if (!patches.length) {
    const library = args.get("library", "")
    if (!library) {
      console.error("[用法] 要 --patch=<x.nki>（可多个）、--library=<库名>、--api 或 --structure")
      process.exit(EXIT.USAGE)
    }
    const pick = pickFromDb(library, args.num("limit", 3), args.bool("spread"))
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
    mode,
    report: join(repDir, `probe-${slugText(args.get("library", "patch"))}-${stampText()}.txt`).replace(/\\/g, "/"),
    patches: patches.map((p) => resolve(p).replace(/\\/g, "/")),
    census: args.num("census", 20),
    words: args.num("words", 25),
  }
}

const rendered = renderJob(mode === "structure" ? "job_probe_structure.lua" : "job_probe_library.lua", job, { args, slug: `probe-${label}` })

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

// ---------------------------------------------------------------- structure 的判读
if (mode === "structure") {
  // 每个 patch 一组块：SCRIPTS1/GROUPS1、SCRIPTS2/GROUPS2…
  const nPatches = job.patches.length
  const perPatch = []
  for (let k = 1; k <= nPatches; k++) {
    const scripts = parseMachineBlock(res.reportText, `SCRIPTS${k}`) ?? []
    const groups = parseMachineBlock(res.reportText, `GROUPS${k}`) ?? []
    const nProt = scripts.filter((r) => String(r.protected).toLowerCase() === "true").length
    const withStart = groups.filter((r) => r.has_start === "yes")
    const velSplit = groups.filter((r) => r.vel_buckets !== "" && Number(r.vel_buckets) > 1)
    perPatch.push({ file: job.patches[k - 1], scripts, groups, nProt, withStart, velSplit })
  }

  console.log(`\n---- 逐 patch 判据`)
  console.log(
    tableText(
      ["patch", "脚本槽", "受保护", "group", "带 start 条件", "自带多段力度"],
      perPatch.map((p) => ({
        patch: basename(p.file).slice(0, 34),
        脚本槽: p.scripts.length,
        受保护: p.nProt,
        group: p.groups.length,
        "带 start 条件": p.withStart.length,
        自带多段力度: p.velSplit.length,
      })),
    ),
  )

  for (const p of perPatch) {
    console.log(`\n---- ${basename(p.file)}`)
    if (p.withStart.length) {
      console.log(`  带原生 start 条件的 group（前 10）：`)
      for (const r of p.withStart.slice(0, 10)) console.log(`    g${r.g} ${String(r.name).slice(0, 40)} → ${r.start}`)
    }
    console.log(`  结论：`)
    if (p.nProt > 0) console.log(`    ⛔ ${p.nProt} 个受保护脚本槽 → 技法/键位/xfade 在库脚本里，读不到也设不了。`)
    else if (p.scripts.length) console.log(`    👀 ${p.scripts.length} 个脚本槽都未保护 → 源码可读（能看懂它怎么切技法）；但 Kontakt 没有"设脚本 UI 变量"的 API。`)
    if (p.withStart.length) console.log(`    ✅ ${p.withStart.length} 个 group 带原生 start 条件 → 这类切换可程序化设。`)
    if (p.velSplit.length) console.log(`    ✅ ${p.velSplit.length} 个 group 自带多段力度范围 → 原生力度切层可程序化设。`)
    if (!p.withStart.length && !p.velSplit.length) console.log(`    ⚠️ 没有原生 start 条件、也没有自带多段力度 → 切换不是用 Kontakt 原生机制表达的。`)
  }
  console.log(`\n（只能看结构，不能证明"库脚本实际用的是哪一层" —— Lua 不能注入 MIDI，行为只能人眼/人耳确认。）`)
}

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
