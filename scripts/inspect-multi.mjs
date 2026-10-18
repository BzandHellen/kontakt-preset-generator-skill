// scripts/inspect-multi.mjs —— 侦察一个 .nkm（只读）
//
// 自己的旧的、别人给的、手做的都行：槽位参数 + 库类型（是否加密）+ group 名普查 + 麦克风读数。

import { existsSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import {
  EXIT,
  bullet,
  cleanupInputNkm,
  launchKontakt,
  parseArgs,
  parseMachineBlock,
  preflight,
  reportsDir,
  stageInputNkm,
  tableText,
  workspaceDir,
} from "./lib.mjs"
import { renderJob } from "./job.mjs"
import { loadProfiles, mergedAliases } from "./plan.mjs"

const args = parseArgs()
const ws = workspaceDir(args)
const repDir = reportsDir(args)
const timeoutS = args.num("timeout", 300)

let nkm = args.get("nkm", "")
if (!nkm) {
  const multi = args.get("multi", "")
  if (!multi) {
    console.error("[用法] 要 --nkm=<文件> 或 --multi=<multi 名>")
    process.exit(EXIT.USAGE)
  }
  nkm = join(ws, "Generated", `${multi}.nkm`)
}
nkm = resolve(nkm)
if (!existsSync(nkm)) {
  console.error(`[用法] 找不到：${nkm}`)
  process.exit(EXIT.USAGE)
}

const name = basename(nkm).replace(/\.nkm$/i, "")
const micNames = (
  args.getAll("mic").length
    ? args.getAll("mic")
    : ["SOLO", "CLOSE", "AB", "TREE", "SURROUND", "MAIN", "MIX", "ROOM", "SPOT", "DECCA", "FULL"]
).map((s) => s.toUpperCase())
const report = join(repDir, `inspect-${name}-${stampText()}.txt`).replace(/\\/g, "/")

const staged = stageInputNkm(nkm)
const rendered = renderJob(
  "job_inspect_multi.lua",
  {
    nkm: staged.path.replace(/\\/g, "/"),
    report,
    census: args.num("census", 15),
    mic_names: micNames,
    mic_aliases: mergedAliases(loadProfiles(args).value),
  },
  { args, slug: `inspect-${name}` },
)

console.log(bullet("侦察 multi（只读）"))
console.log(`文件：${nkm}`)
if (staged.staged) console.log(`      （名字带非 ASCII → 复制成 ASCII 中转名给 Kontakt：${staged.staged}）`)
console.log(`作业：${rendered.file}`)

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
cleanupInputNkm(staged.staged)
console.log(`\n退出：${res.timedOut ? `超时（${timeoutS}s）` : `code ${res.exitCode}`}　${(res.ms / 1000).toFixed(1)}s`)
console.log(`报告：${res.reportPath ?? "（没找到）"}`)

const rows = parseMachineBlock(res.reportText, "SLOTS") ?? []
if (rows.length) {
  console.log(`\n---- 槽位（${rows.length}）`)
  console.log(
    tableText(
      ["槽", "乐器名", "MIDI", "输出", "音量", "声像", "调音", "复音", "keysw"],
      rows.map((r) => ({
        槽: r.slot,
        乐器名: r.name,
        MIDI: r.midi,
        输出: r.out,
        音量: r.vol,
        声像: r.pan,
        调音: r.tune,
        复音: r.poly,
        keysw: r.keysw === "" ? "—" : r.keysw,
      })),
    ),
  )
}

if (res.reportPath && existsSync(res.reportPath)) {
  console.log(`\n---- 明细（报告原文）----`)
  const text = readFileSync(res.reportPath, "utf8")
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("----"))
  const tail = lines.length > 160 ? lines.slice(-160) : lines
  if (lines.length > 160) console.log(`（太长，只列最后 160 行，共 ${lines.length} 行）`)
  console.log(tail.join("\n"))
}

console.log(`\n结论：${res.timedOut ? "超时，结果未知" : res.fails ? `${res.fails} 个 FAIL` : "读完"}`)
process.exit(res.timedOut || res.fails ? EXIT.ISSUES : EXIT.OK)

function stampText() {
  const d = new Date()
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}
