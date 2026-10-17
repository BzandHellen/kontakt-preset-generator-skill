// scripts/apply-snapshot.mjs —— 把 .nksn 套到 multi 上（加密库的麦克风通路）
//
// 两种用法：
//   对已有 .nkm：--nkm=<in> --snapshot=<.nksn> [--slots=0,2] [--out=<新 .nkm>]
//   摆对照：    --visual --snapshot=<.nksn> --patch=<a.nki> [--patch=<b.nki> …]
// 输入 multi 绝不覆盖：输出默认写成 "<名> (snap).nkm"。

import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import {
  EXIT,
  bullet,
  launchKontakt,
  parseArgs,
  parseMachineBlock,
  preflight,
  reportsDir,
  tableText,
  workspaceDir,
} from "./lib.mjs"
import { renderJob } from "./job.mjs"

const args = parseArgs()
const ws = workspaceDir(args)
const repDir = reportsDir(args)
const timeoutS = args.num("timeout", 180)
const stamp = stampText()
const snapshot = args.get("snapshot", "") ? resolve(args.get("snapshot")) : ""
const pairs = args.getAll("pair").filter(Boolean)

if (!snapshot && !pairs.length) {
  console.error("[用法] 要 --snapshot=<某个 .nksn>（或 --visual --pair=\"<.nki>|<.nksn>\"）")
  process.exit(EXIT.USAGE)
}
if (snapshot && !existsSync(snapshot)) {
  console.error(`[用法] snapshot 文件不存在：${snapshot}`)
  process.exit(EXIT.USAGE)
}

// ---------------------------------------------------------------- 对照模式
if (args.bool("visual")) {
  let entries
  if (pairs.length) {
    // 每个槽各自的 patch 与 snapshot（snapshot 留空 = 该槽是对照组）；两库可以混在一个 multi 里
    entries = pairs.map((p, i) => {
      const [patchRaw, snapRaw = ""] = p.split("|")
      const patch = resolve(String(patchRaw).trim())
      const snap = String(snapRaw).trim() ? resolve(String(snapRaw).trim()) : ""
      return {
        path: patch.replace(/\\/g, "/"),
        label: `${i + 1}. ${basename(patch).replace(/\.nki$/i, "")}${snap ? " + snap" : "（对照）"}`,
        name: `SNAP${i + 1} ${basename(patch).replace(/\.nki$/i, "")}`.slice(0, 60),
        snapshot: snap.replace(/\\/g, "/"),
      }
    })
    const badPair = entries.filter((e) => !existsSync(e.path) || (e.snapshot && !existsSync(e.snapshot)))
    if (badPair.length) {
      console.error(`[用法] 这些文件不存在：\n  ${badPair.map((e) => e.path + (e.snapshot ? `  +  ${e.snapshot}` : "")).join("\n  ")}`)
      process.exit(EXIT.USAGE)
    }
  } else {
    const patches = args.getAll("patch").filter(Boolean).map((p) => resolve(p))
    if (!patches.length) {
      console.error("[用法] --visual 要 --pair=\"<.nki>|<.nksn>\"（可多个），或 --patch=<.nki>（第 1 个当对照组）")
      process.exit(EXIT.USAGE)
    }
    const bad = patches.filter((p) => !existsSync(p))
    if (bad.length) {
      console.error(`[用法] 这些 patch 不存在：\n  ${bad.join("\n  ")}`)
      process.exit(EXIT.USAGE)
    }
    entries = patches.map((p, i) => ({
      path: p.replace(/\\/g, "/"),
      label: `${i + 1}. ${basename(p).replace(/\.nki$/i, "")}`,
      name: `SNAP${i + 1} ${basename(p).replace(/\.nki$/i, "")}`.slice(0, 60),
      snapshot: i === 0 ? "" : snapshot.replace(/\\/g, "/"), // 第 1 槽不套 = 对照组
    }))
  }

  const report = join(repDir, `visual-${stamp}.txt`).replace(/\\/g, "/")
  const savePath = args.get("save", "") ? resolve(args.get("save")) : null
  const rendered = renderJob(
    "job_snapshot_visual.lua",
    { multi: args.get("multi", "SNAPSHOT TEST"), report, entries, save: savePath, save_mode: args.get("save-mode", "patch") },
    { args, slug: `visual-${stamp}` },
  )

  console.log(bullet("snapshot 对照"))
  console.log(
    tableText(
      ["槽", "装上什么", "套的快照"],
      entries.map((e, i) => ({ 槽: i, 装上什么: e.label.replace(/^\d+\. /, ""), 套的快照: e.snapshot ? basename(e.snapshot) : "（不套 = 对照）" })),
    ),
  )
  console.log(`作业：${rendered.file}`)
  if (savePath) console.log(`产出：${savePath}（存完就退出，你直接打开它看）`)
  else console.log(`产出：不落盘，机架留着不退出（要落盘加 --save=<路径>）`)
  const pf = preflight(args)
  if (pf.notes.length) console.log(`\n注意：${pf.notes.join("；")}`)
  if (args.bool("dry-run")) {
    console.log(`\n（dry-run：没启动。前置检查：${pf.problems.length ? pf.problems.join("；") : "通过"}）`)
    process.exit(pf.problems.length ? EXIT.ENV : EXIT.OK)
  }
  if (pf.problems.length) {
    console.error(`[环境] ${pf.problems.join("；")}`)
    process.exit(EXIT.ENV)
  }
  // 有 --save 时脚本存完就自己退出；没有才需要等它超时（它故意留着机架）
  const res = await launchKontakt({ exe: pf.exe, script: rendered.file, timeoutS, explicitReport: report, reportsDirPath: repDir })
  console.log(`\n${res.reportPath ? `报告：${res.reportPath}` : "（报告没写出来）"}`)
  if (savePath) {
    console.log(existsSync(savePath) ? `\n✅ 已写出可打开的 multi：${savePath}\n   在你的 Kontakt 里打开它，逐个点槽看。` : `\n⛔ 没写出 ${savePath}`)
  } else {
    console.log(res.timedOut ? `\nKontakt 还在开着（pid ${res.pid} 没杀）—— 去点开这 ${entries.length} 个槽看，看完自己关。` : `\n退出：code ${res.exitCode}`)
  }
  const rows = parseMachineBlock(res.reportText, "LIBS") ?? []
  if (rows.length) {
    console.log(`\n---- 对照表`)
    console.log(tableText(["槽", "label", "snapshot", "protected"], rows.map((r) => ({ 槽: r.slot, label: r.label, snapshot: r.snapshot, protected: r.protected }))))
  }
  process.exit(EXIT.OK)
}

// ---------------------------------------------------------------- 套到已有 .nkm
let nkm = args.get("nkm", "")
if (!nkm) {
  const multi = args.get("multi", "")
  if (!multi) {
    console.error("[用法] 要 --nkm=<文件> 或 --multi=<multi 名>（或 --visual）")
    process.exit(EXIT.USAGE)
  }
  const cands = [join(ws, "Generated", `${multi}.nkm`), join(ws, "Generated", "_test", `${multi}.nkm`)]
  nkm = cands.find((p) => existsSync(p)) ?? cands[0]
}
nkm = resolve(nkm)
if (!existsSync(nkm)) {
  console.error(`[用法] 找不到输入 multi：${nkm}`)
  process.exit(EXIT.USAGE)
}

const name = basename(nkm).replace(/\.nkm$/i, "")
let outNkm = args.get("out", "")
if (!outNkm) {
  const d = args.get("out-dir", "")
  outNkm = join(d ? resolve(d) : join(ws, "Generated"), `${name} (snap).nkm`)
}
outNkm = resolve(outNkm)
if (outNkm.toLowerCase() === nkm.toLowerCase()) {
  console.error("[用法] 输出不能等于输入（绝不覆盖输入 multi）")
  process.exit(EXIT.USAGE)
}
if (existsSync(outNkm) && !args.bool("force")) {
  console.error(`[用法] 输出已存在：${outNkm}（要覆盖加 --force）`)
  process.exit(EXIT.USAGE)
}

const slots = args
  .get("slots", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const report = join(repDir, `apply-snap-${name}-${stamp}.txt`).replace(/\\/g, "/")
const rendered = renderJob(
  "job_apply_snapshot.lua",
  {
    in_nkm: nkm.replace(/\\/g, "/"),
    out_nkm: outNkm.replace(/\\/g, "/"),
    report,
    snapshot: snapshot.replace(/\\/g, "/"),
    slots: slots.length ? slots : null,
    save_mode: args.get("save-mode", "patch"),
  },
  { args, slug: `apply-snap-${name}` },
)

console.log(bullet("套 snapshot"))
console.log(`输入：${nkm}`)
console.log(`输出：${outNkm}`)
console.log(`snapshot：${snapshot}`)
console.log(`槽：${slots.length ? slots.join("、") : "全部"}`)
console.log(`作业：${rendered.file}`)
console.log(`\n⚠ snapshot 会连带承载该库 UI 的其它状态 —— 一个库的 snapshot 当「该库的标准状态」维护。`)

const pf = preflight(args)
if (pf.notes.length) console.log(`注意：${pf.notes.join("；")}`)

if (args.bool("dry-run")) {
  console.log(`\n（dry-run：没启动 Kontakt。前置检查：${pf.problems.length ? pf.problems.join("；") : "通过"}）`)
  process.exit(pf.problems.length ? EXIT.ENV : EXIT.OK)
}
if (pf.problems.length) {
  console.error(`[环境] ${pf.problems.join("；")}`)
  process.exit(EXIT.ENV)
}

const res = await launchKontakt({ exe: pf.exe, script: rendered.file, timeoutS, explicitReport: report, reportsDirPath: repDir })
console.log(`\n退出：${res.timedOut ? `超时（${timeoutS}s）` : `code ${res.exitCode}`}　${(res.ms / 1000).toFixed(1)}s`)
console.log(`报告：${res.reportPath ?? "（没找到）"}　OK ${res.oks} / FAIL ${res.fails}`)

const before = parseMachineBlock(res.reportText, "BEFORE") ?? []
const after = parseMachineBlock(res.reportText, "AFTER") ?? []
if (after.length) {
  console.log(`\n---- 套完重载回读（${after.length} 槽）`)
  console.log(
    tableText(
      ["槽", "乐器名", "MIDI", "输出", "音量", "声像"],
      after.map((r) => ({ 槽: r.slot, 乐器名: r.name, MIDI: r.midi, 输出: r.out, 音量: r.vol, 声像: r.pan })),
    ),
  )
}
// snapshot 不该动 header 上的参数：比对套之前的 dtype
if (before.length && after.length) {
  const changed = []
  const key = (r) => String(r.slot)
  const b = new Map(before.map((r) => [key(r), r]))
  for (const a of after) {
    const o = b.get(key(a))
    if (!o) continue
    for (const f of ["name", "midi", "out", "vol", "pan"]) {
      if (String(o[f]) !== String(a[f])) changed.push({ 槽: a.slot, 字段: f, 套之前: o[f], 套之后: a[f] })
    }
  }
  console.log(`\n---- header 参数有没有被 snapshot 改动（${changed.length} 处）`)
  if (changed.length) {
    console.log(tableText(["槽", "字段", "套之前", "套之后"], changed))
    console.log(`（一般来说 snapshot 只该动库自己的 UI 状态；这里变了说明这个 snapshot 承载了更多东西）`)
  } else console.log("没变 —— snapshot 没碰 header 参数。")
}

console.log(`\n结论：${res.timedOut ? "超时，结果未知" : res.fails ? `${res.fails} 个 FAIL` : `已写出 ${outNkm}`}`)
console.log(`\n麦克风比例数值上读不出来 —— 要看就得人眼确认：kontakt_apply_snapshot --visual --snapshot="…" --patch="…"`)
process.exit(res.timedOut || res.fails ? EXIT.ISSUES : EXIT.OK)

function stampText() {
  const d = new Date()
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}
