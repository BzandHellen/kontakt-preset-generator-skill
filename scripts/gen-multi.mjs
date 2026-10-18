// scripts/gen-multi.mjs —— 清单 → .nkm（核心）
//
// A1 建空 multi → A2 逐槽装载 → A3 设参数（麦克风分流）→ A5 存盘 → A6 重载回读比对。
// 一条 multi 一个 Kontakt 进程（一个 Lua 脚本 = 一次进程）。
// 默认 dry-run 之外会真的启动 Kontakt；`--dry-run` 只写 job.lua 并打印计划。

import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  EXIT,
  UsageError,
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
import { expectPaths, planManifest, writeExpect } from "./plan.mjs"
import { compareMics, compareSlots, classifyMicIssues, jobCompleted, protectedSlots } from "./compare.mjs"

const args = parseArgs()
const dry = args.bool("dry-run")
const ws = workspaceDir(args)
const outDir = resolve(args.get("out-dir") || join(ws, "Generated"))
const repDir = reportsDir(args)
const timeoutS = args.num("timeout", 300)

let plan
try {
  plan = planManifest(args)
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`[用法] ${e.message}`)
    process.exit(EXIT.USAGE)
  }
  throw e
}

if (!plan.multis.length) {
  console.error(`[用法] 清单里没有匹配的 multi（--multi 指了：${args.getAll("multi").join("、") || "（空）"}）`)
  process.exit(EXIT.USAGE)
}

const parts = plan.manifest.replace(/\\/g, "/").split("/")
const stamp = new Date()
const z = (n) => String(n).padStart(2, "0")
const stampText = `${stamp.getFullYear()}${z(stamp.getMonth() + 1)}${z(stamp.getDate())}-${z(stamp.getHours())}${z(stamp.getMinutes())}${z(stamp.getSeconds())}`

// ---------------------------------------------------------------- 计划表
console.log(bullet("计划"))
console.log(`清单：${plan.manifest}`)
console.log(`profiles：${plan.prof.path}${plan.prof.ok ? "" : `　⚠ ${plan.prof.error ?? "读不到"}`}`)
console.log(`产物目录：${outDir}`)
for (const m of plan.multis) {
  console.log(`\n---- ${m.multi}　（声部 ${m.section ?? "—"}，${m.slots.length} 槽）`)
  console.log(
    tableText(
      ["槽", "乐器名", "MIDI", "输出", "音量", "声像", "声像来源", "麦克风", "snapshot"],
      m.slots.map((s) => ({
        槽: s.slot,
        乐器名: s.name,
        MIDI: s.midiRaw,
        输出: s.out,
        音量: s.vol,
        声像: s.pan,
        声像来源: s.panFrom,
        麦克风: `${s.mic.note}`,
        snapshot: s.snapshot ? s.snapshot.split(/[\\/]/).pop() : "—",
      })),
    ),
  )
  const missing = m.slots.filter((s) => !existsSync(s.path))
  for (const s of missing) console.log(`⚠ 第 ${s.line} 行的 patch 不存在：${s.path}`)
  const badMic = m.slots.filter((s) => s.mic.mode === "skipped")
  for (const s of badMic) console.log(`⚠ 槽 ${s.slot} 麦克风跳过：${s.mic.note}`)
}

if (args.bool("plan-only")) {
  console.log(`\n（--plan-only：只出计划，没渲染作业）`)
  process.exit(EXIT.OK)
}

// ---------------------------------------------------------------- 预检
const pf = preflight(args)
if (pf.notes.length) console.log(`\n注意：${pf.notes.join("；")}`)

mkdirSync(outDir, { recursive: true })
mkdirSync(repDir, { recursive: true })

const summary = []
let failTotal = 0

for (const m of plan.multis) {
  const outNkm = join(outDir, `${m.multi}.nkm`).replace(/\\/g, "/")
  const report = join(repDir, `gen-${m.multi}-${stampText}.txt`).replace(/\\/g, "/")
  const job = {
    multi: m.multi,
    manifest: plan.manifest.replace(/\\/g, "/"),
    out_nkm: outNkm,
    report,
    save_mode: args.get("save-mode", "patch"),
    slots: m.slots.map((s) => ({
      slot: s.slot,
      path: s.path,
      name: s.name,
      midi: s.midi,
      out: s.out,
      vol: s.vol,
      pan: s.pan,
      mic: { mode: s.mic.mode, spec: s.mic.spec, aliases: s.mic.aliases, note: s.mic.note },
      snapshot: s.snapshot ? s.snapshot.replace(/\\/g, "/") : null,
      options: s.options,
    })),
  }

  const rendered = renderJob("job_gen_multi.lua", job, { args, slug: `gen-${m.multi}` })
  const exp = writeExpect(args, m)
  if (exp.clash) {
    console.log(
      `\n⚠ 期望值文件原本记的是**另一份清单**：${exp.clash}\n` +
        `   这次已用当前清单覆盖（${exp.slotCsv}）。multi 名相同、清单不同时会互相覆盖，注意别搞混。`,
    )
  }

  console.log(`\n${"=".repeat(72)}`)
  console.log(`作业：${rendered.file}`)
  console.log(`期望值：${exp.slotCsv}`)

  if (dry) {
    console.log(`（dry-run：没启动 Kontakt。要真跑就去掉 --dry-run）`)
    summary.push({ multi: m.multi, state: "dry-run", pass: 0, fail: 0 })
    continue
  }

  if (pf.problems.length) {
    console.error(`[环境] ${pf.problems.join("；")}`)
    process.exit(EXIT.ENV)
  }

  const res = await launchKontakt({
    exe: pf.exe,
    script: rendered.file,
    timeoutS,
    explicitReport: report,
    reportsDirPath: repDir,
  })

  console.log(`退出：${res.timedOut ? `超时（${timeoutS}s，pid ${res.pid}${res.killed ? "，已按 --kill-on-timeout 掐掉" : "，留着没杀"}）` : `code ${res.exitCode}`}　${(res.ms / 1000).toFixed(1)}s`)
  if (res.timedOut) {
    const tail = String(res.stdout ?? "").split(/\r?\n/).filter((l) => l.trim()).slice(-30)
    console.log(`\n⛔ 超时 —— 作业最后跑到（stdout 尾巴，能看出卡在哪一步）：`)
    for (const l of tail) console.log(`  ${l}`)
    const serr = String(res.stderr ?? "").split(/\r?\n/).filter((l) => /\[kontakt\.scripting\]/.test(l)).slice(-10)
    if (serr.length) {
      console.log(`\nstderr 里的 Lua 报错：`)
      for (const l of serr) console.log(`  ${l}`)
    }
  }
  console.log(`报告：${res.reportPath ?? "（没找到）"}　OK ${res.oks} / FAIL ${res.fails}`)

  // 作业里的 [FAIL] 行
  const repFails = res.reportText.split(/\r?\n/).filter((l) => /\[\s*FAIL\s*\]/.test(l))
  if (repFails.length) {
    console.log(`\n作业侧 FAIL：`)
    for (const l of repFails.slice(0, 40)) console.log(`  ${l.trim()}`)
  }

  // 期望 vs 回读
  const actual = parseMachineBlock(res.reportText, "SLOTS")
  const actualMics = parseMachineBlock(res.reportText, "MICS")
  const libs = parseMachineBlock(res.reportText, "LIBS") ?? []
  const prot = protectedSlots(libs)

  const expectRows = readCsv(exp.slotCsv)
  const micExpect = readCsv(exp.micCsv)

  const slots = compareSlots(expectRows, actual ?? [])
  const mics = compareMics(micExpect, actualMics ?? [])

  console.log(`\n---- 参数比对（${slots.checks.length} 项：PASS ${slots.checks.filter((c) => c.ok).length} / FAIL ${slots.issues.length}）`)
  if (slots.issues.length) {
    console.log(
      tableText(
        ["槽", "字段", "期望", "实际"],
        slots.issues.map((i) => ({ 槽: i.slot, 字段: i.field, 期望: i.expect, 实际: i.actual })),
      ),
    )
  } else console.log("全部一致。")

  const { real: micReal, reset: micReset, missing: micMissing } = classifyMicIssues(mics.issues, actualMics ?? [])
  console.log(
    `\n---- 麦克风比对（${mics.checks.length} 项：PASS ${mics.checks.filter((c) => c.ok).length} / FAIL ${micReal.length}）`,
  )
  if (micReal.length) {
    console.log(
      tableText(["槽", "麦克风", "期望 dB", "实际"], micReal.map((i) => ({ 槽: i.slot, 麦克风: i.mic, "期望 dB": i.expect, 实际: i.actual }))),
    )
  } else if (mics.checks.length) console.log("全部一致。")
  if (micReset.length) {
    const slots = [...new Set(micReset.map((i) => i.slot))].join("、")
    console.log(
      `\n⚠ 有 ${micReset.length} 条麦克风写进去又被库**复位**了（槽 ${slots}）：重载后读回默认值。\n` +
        `   这不是我们写错 —— 这类库（加密/Player）根本不持久化 group 音量。给这些库在清单里配 snapshot=<库的 .nksn>。`,
    )
  }
  if (micMissing.length) {
    const pairs = [...new Set(micMissing.map((i) => `${i.slot}/${i.mic}`))].join("、")
    console.log(
      `\n⚠ 有 ${micMissing.length} 条期望的麦克风在这些 patch 里**找不到对应的 group**（槽/名字：${pairs}）。\n` +
        `   这是 profiles 的 mic_aliases 没覆盖到这些 patch，用 probe_library 普查后补别名。`,
    )
  }
  // 以前这里会把"受保护槽"的麦克风期望整条排除；现在**照写照比**（LASS 的分技法 patch 就是受保护但能存住）。
  // 真存不住的会被 classifyMicIssues 判成「库复位」，在下面那条 WARN 里提示配 snapshot。
  if (prot.size) {
    console.log(
      `\nℹ 这批里有 ${prot.size} 个槽的库脚本受保护（加密/Player）：${[...prot].join("、")}\n` +
        `   照写、回读见分晓 —— 存不住会出现在上面的「库复位」提示里（那就给它配 snapshot）。`,
    )
  }

  const completed = jobCompleted(res.reportText)
  if (!res.timedOut && res.exitCode !== 0 && completed) {
    console.log(
      `\n注：Kontakt 退出时崩了（code ${res.exitCode}），但报告有结尾（==== end ====）—— 作业本身跑完了。\n` +
        `   这是 Kontakt 关机阶段的问题，不影响产物；报告在 ${res.reportPath}。`,
    )
  }
  const othersHits = res.reportText.split(/\r?\n/).filter((l) => /\(others\)/.test(l))
  if (othersHits.length) {
    console.log(`\n通配 (others) 的命中（清单里写了 others=…）：`)
    for (const l of othersHits) console.log(`  ${l.trim()}`)
  }

  const fail = slots.issues.length + micReal.length + res.fails
  failTotal += fail
  summary.push({ multi: m.multi, state: res.timedOut ? "超时" : "完成", pass: slots.checks.filter((c) => c.ok).length + mics.checks.filter((c) => c.ok).length, fail })
}

// ---------------------------------------------------------------- 收尾
console.log(`\n${"=".repeat(72)}`)
console.log(
  tableText(
    ["multi", "状态", "PASS", "FAIL"],
    summary.map((s) => ({ multi: s.multi, 状态: s.state, PASS: s.pass, FAIL: s.fail })),
  ),
)
if (failTotal) console.log(`\n结论：${failTotal} 处 FAIL —— 报告在 ${repDir}，期望值在 ${join(ws, "Generated", "_expect")}`)
else console.log(`\n结论：${dry ? "计划没问题（dry-run，没生成）" : "生成且回读一致"}`)

process.exit(failTotal ? EXIT.ISSUES : EXIT.OK)
