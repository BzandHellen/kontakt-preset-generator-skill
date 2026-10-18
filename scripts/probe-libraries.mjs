// scripts/probe-libraries.mjs —— 批量读库：一次 Kontakt 进程装一批库的代表 patch，逐个 dump 结构
//
// 目的：把"每库摸一次"从 52 次启动压缩成几次；结果**自动写进成果库**（data/findings.json）。
// 每库取 1 个（或 --per-library=N 个）最浅的 patch 代表它。
//
// ⚠️ 只是**先验之外的事实**：加密与否看脚本 protected；group 名给麦克风别名做线索。
//
// 用法：
//   --library="Berlin|CSS"   只测名字匹配这些子串的库（默认全部）
//   --per-library=1          每库取几个代表 patch
//   --chunk=8                一次 Kontakt 进程装几个（崩了只丢这一块）
//   --dry-run                只打印计划

import { existsSync } from "node:fs"
import { EXIT, bullet, dbPath, launchKontakt, parseArgs, parseMachineBlock, preflight, readCsv, recordFindings, reportsDir, tableText } from "./lib.mjs"
import { renderJob } from "./job.mjs"

const args = parseArgs()
const repDir = reportsDir(args)
const db = dbPath(args)
if (!existsSync(db)) {
  console.error(`[用法] 还没有库索引（${db}）—— 先 kontakt_db_build`)
  process.exit(EXIT.USAGE)
}

// 挑代表 patch：浅的优先（路径段少 → 通常是一体机 / 主要乐器）
const want = args
  .get("library", "")
  .split(/[|,]/)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
const perLib = args.num("per-library", 1)
const chunkSize = args.num("chunk", 8)
const timeoutS = args.num("timeout", 600)

const rows = readCsv(db).filter((r) => String(r.Ext) === ".nki")
const byLib = new Map()
for (const r of rows) {
  const lib = r.Library
  if (want.length && !want.some((w) => lib.toLowerCase().includes(w))) continue
  if (!byLib.has(lib)) byLib.set(lib, [])
  byLib.get(lib).push(r)
}
const picks = []
for (const [lib, list] of byLib) {
  const sorted = [...list].sort((a, b) => a.Path.split("/").length - b.Path.split("/").length || a.Path.localeCompare(b.Path))
  for (const r of sorted.slice(0, perLib)) picks.push({ lib, path: r.Path, rel: r.RelDir, patch: r.PatchFile })
}

console.log(bullet(`批量读库计划 —— ${byLib.size} 个库 / ${picks.length} 个代表 patch`))
console.log(
  tableText(
    ["库", "代表 patch"],
    picks.map((p) => ({ 库: p.lib.slice(0, 42), "代表 patch": `${p.rel}/${p.patch}`.slice(0, 70) })),
  ).split("\n").slice(0, 60).join("\n"),
)
if (picks.length > 58) console.log(`… 还有 ${picks.length - 58} 行`)
if (args.bool("dry-run")) {
  console.log("\n（--dry-run：没启动 Kontakt）")
  process.exit(EXIT.OK)
}

const pf = preflight(args)
if (pf.notes.length) console.log(`\n注意：${pf.notes.join("；")}`)
if (pf.problems.length) {
  console.error(`[环境] ${pf.problems.join("；")}`)
  process.exit(EXIT.ENV)
}

const chunks = []
for (let i = 0; i < picks.length; i += chunkSize) chunks.push(picks.slice(i, i + chunkSize))

const summary = []
let ci = 0
for (const chunk of chunks) {
  ci++
  const label = `第 ${ci}/${chunks.length} 块（${chunk.length} 个库）`
  const report = `${repDir}/probe-libs-${ci}-${stampText()}.txt`.replace(/\\/g, "/")
  const job = { mode: "structure", report, patches: chunk.map((c) => c.path.replace(/\\/g, "/")), zones: args.num("zones", 4000) }
  const rendered = renderJob("job_probe_structure.lua", job, { args, slug: `probe-libs-${ci}` })
  console.log(`\n${label}：启动 Kontakt…`)

  const res = await launchKontakt({ exe: pf.exe, script: rendered.file, timeoutS, explicitReport: report, reportsDirPath: repDir })
  if (!res.reportPath) {
    console.log(`  ⛔ 没拿到报告（超时=${res.timedOut}）；跳过这一块`)
    for (const c of chunk) summary.push({ 库: c.lib, 结果: "无报告" })
    continue
  }

  for (let k = 1; k <= chunk.length; k++) {
    const c = chunk[k - 1]
    const scripts = parseMachineBlock(res.reportText, `SCRIPTS${k}`) ?? []
    const groups = parseMachineBlock(res.reportText, `GROUPS${k}`) ?? []
    if (!scripts.length && !groups.length) {
      summary.push({ 库: c.lib, 结果: "无数据" })
      continue
    }
    const nProt = scripts.filter((r) => String(r.protected).toLowerCase() === "true").length
    const withStart = groups.filter((r) => r.has_start === "yes")
    const velSplit = groups.filter((r) => r.vel_buckets !== "" && Number(r.vel_buckets) > 1)
    const scriptNames = [...new Set(scripts.map((r) => String(r.name).replace(/\(protected\)$/, "")))]

    // group 名里的"词频候选"（给麦克风别名做线索）
    const wordCount = new Map()
    let total = 0
    for (const g of groups) {
      total++
      const seen = new Set()
      for (const w of String(g.name).toUpperCase().match(/[A-Z0-9#]+/g) ?? []) {
        if (w.length < 2 || seen.has(w)) continue
        seen.add(w)
        wordCount.set(w, (wordCount.get(w) ?? 0) + 1)
      }
    }
    const micCandidates = [...wordCount.entries()]
      .filter(([, n]) => n >= 2 && n < total * 0.9)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([w, n]) => `${w}×${n}`)

    const key = recordFindings(c.lib, {
      paths: [c.rel.replace(/[/\\][^/\\]*$/, "") ? c.path.replace(/[/\\][^/\\]*$/, "") : c.path],
      kind: nProt > 0 ? "player-encrypted" : "unencrypted",
      scripts: { count: scripts.length, protected: nProt, names: scriptNames },
      groups: groups.length,
      native_start_conditions: withStart.length,
      velocity_split_groups: velSplit.length,
      group_name_shape: groups.slice(0, 3).map((g) => String(g.name).slice(0, 50)),
      mic_candidates: micCandidates,
      probed_from: c.path,
      probed_at: new Date().toISOString().slice(0, 10)
    })
    summary.push({
      库: key.slice(0, 34),
      结果: nProt > 0 ? "加密" : "未加密",
      脚本: `${scripts.length}(${nProt})`,
      group: groups.length,
      start条件: withStart.length,
      多段力度: velSplit.length,
      麦克风候选: micCandidates.slice(0, 3).join(" ")
    })
  }
  console.log(`  完成（${(res.ms / 1000).toFixed(0)}s，报告 ${res.reportPath.split(/[\\/]/).pop()}）`)
}

console.log(bullet("批量读库结果"))
console.log(tableText(["库", "结果", "脚本", "group", "start条件", "多段力度", "麦克风候选"], summary))
const enc = summary.filter((s) => s.结果 === "加密").length
console.log(
  `\n共 ${summary.length} 个库：加密 ${enc}　未加密 ${summary.filter((s) => s.结果 === "未加密").length}　无数据 ${
    summary.filter((s) => String(s.结果).startsWith("无")).length
  }`,
)
console.log(`结果已写进成果库：data/findings.json（用 kontakt_findings 查）`)
process.exit(EXIT.OK)

function stampText() {
  const d = new Date()
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}
