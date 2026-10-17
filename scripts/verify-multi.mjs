// scripts/verify-multi.mjs —— 回读一个已有 .nkm，并与期望值比对
//
// 期望值来自 gen_multi 写下的 Generated\_expect\<multi>.csv（没有就只回读、不比对）。

import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import {
  EXIT,
  bullet,
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
import { expectPaths, loadProfiles, mergedAliases } from "./plan.mjs"
import { classifyMicIssues, compareMics, compareSlots, jobCompleted } from "./compare.mjs"

const args = parseArgs()
const ws = workspaceDir(args)
const repDir = reportsDir(args)
const timeoutS = args.num("timeout", 240)

// .nkm：--nkm 直接给；或 --multi=<名> 去 Generated\<名>.nkm 找
let nkm = args.get("nkm", "")
if (!nkm) {
  const multi = args.get("multi", "")
  if (!multi) {
    console.error("[用法] 要 --nkm=<文件> 或 --multi=<multi 名>")
    process.exit(EXIT.USAGE)
  }
  const cands = [join(ws, "Generated", `${multi}.nkm`), join(ws, "Generated", "_test", `${multi}.nkm`)]
  nkm = cands.find((p) => existsSync(p)) ?? cands[0]
}
nkm = resolve(nkm)
if (!existsSync(nkm)) {
  console.error(`[用法] 找不到：${nkm}`)
  process.exit(EXIT.USAGE)
}

// 期望值：--expect 指定，或按 multi 名去 Generated\_expect\ 找
const multiName = basename(nkm).replace(/\.nkm$/i, "")
let slotCsv = args.get("expect", "")
let micCsv = args.get("mic-expect", "")
if (!slotCsv) {
  const p = expectPaths(args, multiName)
  if (existsSync(p.slotCsv)) slotCsv = p.slotCsv
  if (!micCsv && existsSync(p.micCsv)) micCsv = p.micCsv
}
const expectRows = slotCsv && existsSync(slotCsv) ? readCsv(slotCsv) : null
const micExpect = micCsv && existsSync(micCsv) ? readCsv(micCsv) : null
const micNames = args.getAll("mic").filter(Boolean)
const micNamesFinal = micNames.length
  ? micNames.map((s) => s.toUpperCase())
  : micExpect
    ? [...new Set(micExpect.map((r) => r.mic.toUpperCase()))]
    : ["SOLO", "CLOSE", "AB", "TREE", "SURROUND", "MAIN", "MIX", "ROOM"]

const report = join(repDir, `verify-${multiName}-${stampText()}.txt`).replace(/\\/g, "/")
const job = {
  nkm: nkm.replace(/\\/g, "/"),
  report,
  mic_names: micNamesFinal,
  mic_aliases: mergedAliases(loadProfiles(args).value),
}
const rendered = renderJob("job_verify_multi.lua", job, { args, slug: `verify-${multiName}` })

console.log(bullet("回读 multi"))
console.log(`文件：${nkm}`)
console.log(`作业：${rendered.file}`)
console.log(`期望：${expectRows ? `${slotCsv}（${expectRows.length} 行）` : "（没有期望值 —— 只回读，不比对）"}`)
console.log(`麦克风名：${micNamesFinal.join(" ")}`)

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

const res = await launchKontakt({ exe: pf.exe, script: rendered.file, timeoutS, explicitReport: report, reportsDirPath: repDir })
console.log(`\n退出：${res.timedOut ? `超时（${timeoutS}s，pid ${res.pid} 留着没杀）` : `code ${res.exitCode}`}　${(res.ms / 1000).toFixed(1)}s`)
console.log(`报告：${res.reportPath ?? "（没找到）"}　OK ${res.oks} / FAIL ${res.fails}`)

const rows = parseMachineBlock(res.reportText, "SLOTS") ?? []
if (rows.length) {
  console.log(`\n---- 槽位（${rows.length}）`)
  console.log(
    tableText(
      ["槽", "乐器名", "MIDI", "输出", "音量", "声像", "调音", "keysw", "音域", "移调"],
      rows.map((r) => ({
        槽: r.slot,
        乐器名: r.name,
        MIDI: r.midi,
        输出: r.out,
        音量: r.vol,
        声像: r.pan,
        调音: r.tune,
        keysw: r.keysw === "" ? "—" : r.keysw,
        音域: r.kmin === "" ? "—" : `${r.kmin}-${r.kmax}`,
        移调: r.trans,
      })),
    ),
  )
}

const micActual = parseMachineBlock(res.reportText, "MICS") ?? []
if (micActual.length) {
  console.log(`\n---- 麦克风读数`)
  console.log(
    tableText(
      ["槽", "麦克风", "group 数", "min", "max"],
      micActual.map((r) => ({ 槽: r.slot, 麦克风: r.mic, "group 数": r.n, min: r.min, max: r.max })),
    ),
  )
}

let failTotal = res.fails
if (expectRows) {
  const cmp = compareSlots(expectRows, rows)
  console.log(`\n---- 与期望比对（${cmp.checks.length} 项：PASS ${cmp.checks.filter((c) => c.ok).length} / FAIL ${cmp.issues.length}）`)
  if (cmp.issues.length) {
    console.log(
      tableText(["槽", "字段", "期望", "实际"], cmp.issues.map((i) => ({ 槽: i.slot, 字段: i.field, 期望: i.expect, 实际: i.actual }))),
    )
    failTotal += cmp.issues.length
  } else if (cmp.checks.length) console.log("全部一致。")
  else console.log("（期望值是空的）")

  if (micExpect && micExpect.length) {
    const cm = compareMics(micExpect, micActual)
    const { real, reset, missing } = classifyMicIssues(cm.issues, micActual, { noBaseline: true })
    console.log(`\n---- 麦克风比对（${cm.checks.length} 项：PASS ${cm.checks.filter((c) => c.ok).length} / FAIL ${real.length}）`)
    if (real.length) {
      console.log(
        tableText(["槽", "麦克风", "期望 dB", "实际"], real.map((i) => ({ 槽: i.slot, 麦克风: i.mic, "期望 dB": i.expect, 实际: i.actual }))),
      )
      failTotal += real.length
    } else if (cm.checks.length) console.log("全部一致。")
    if (reset.length) {
      console.log(
        `\n⚠ ${reset.length} 条麦克风与期望不一致（槽 ${[...new Set(reset.map((i) => i.slot))].join("、")}）。\n` +
          `   verify 是读已存盘的 .nkm，**拿不到"写之前的基线"**，所以没法判定是「库复位」还是「真不一致」——\n` +
          `   这里只作提醒。要判定请用 gen_multi（它读了写之前的基线，能区分复位与真失败）。`,
      )
    }
    if (missing.length) {
      const pairs = [...new Set(missing.map((i) => `${i.slot}/${i.mic}`))].join("、")
      console.log(`\n⚠ ${missing.length} 条期望的麦克风在这些 patch 里找不到对应 group（${pairs}）—— 别名表没覆盖，用 probe_library 普查后补。`)
    }
  }
}

if (!res.timedOut && res.exitCode !== 0 && jobCompleted(res.reportText)) {
  console.log(`\n注：作业跑完了（报告有结尾），只是 Kontakt 退出时崩了（code ${res.exitCode}）。`)
}

console.log(`\n结论：${failTotal ? `${failTotal} 处 FAIL` : "回读正常"}`)
process.exit(failTotal ? EXIT.ISSUES : EXIT.OK)

function stampText() {
  const d = new Date()
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}
