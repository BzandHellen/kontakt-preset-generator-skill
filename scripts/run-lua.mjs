// scripts/run-lua.mjs —— 逃生舱：跑一个 .lua，把结果带回来
//
// Kontakt 的固定动作是「带脚本启动 → 跑完退出」（一个 Lua 脚本 = 一次进程，不能驱动运行中的实例）。
// 这个脚本负责：前置检查 → 启动 → 等退出/等报告 → 回传。

import { readFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import {
  EXIT,
  bullet,
  launchKontakt,
  parseArgs,
  preflight,
  reportsDir,
  workspaceDir,
} from "./lib.mjs"

const args = parseArgs()
const ws = workspaceDir(args)
const script = args.get("script", "") ? resolve(args.get("script")) : ""
const timeoutS = args.num("timeout", 180)
const explicitReport = args.has("report") ? resolve(args.get("report")) : null

if (!script) {
  console.error("[用法] 要 --script=<某个 .lua>")
  process.exit(EXIT.USAGE)
}

const pf = preflight(args, script)

// ---------------------------------------------------------------- dry-run
if (args.bool("dry-run")) {
  console.log(bullet("run_lua —— 只是演练，没启动任何东西"))
  console.log(`脚本    ：${script}`)
  console.log(`可执行  ：${pf.exe}`)
  console.log(`工作区  ：${ws}`)
  console.log(`超时    ：${timeoutS}s`)
  console.log(`命令行  ："${pf.exe}" "${script}"`)
  console.log(`报告    ：${explicitReport ?? "（自动：盯 Reports 里最新变动的那份）"}`)
  if (pf.notes.length) console.log(`\n注意：\n  ${pf.notes.join("\n  ")}`)
  console.log(pf.problems.length ? `\n前置检查未过：\n  ${pf.problems.join("\n  ")}` : `\n前置检查：通过（DeveloperFeatures=${pf.dev?.value}）`)
  process.exit(pf.problems.length ? EXIT.ENV : EXIT.OK)
}

if (pf.problems.length) {
  console.error(`[环境] ${pf.problems.join("；")}`)
  process.exit(EXIT.ENV)
}

// ---------------------------------------------------------------- 启动
console.log(bullet("run_lua"))
console.log(`启动："${pf.exe}" "${script}"   超时 ${timeoutS}s`)
if (pf.notes.length) console.log(`注意：${pf.notes.join("；")}`)

const res = await launchKontakt({
  exe: pf.exe,
  script,
  timeoutS,
  explicitReport,
  reportsDirPath: reportsDir(args),
})

console.log(
  res.timedOut
    ? `\n${timeoutS}s 内没退出（pid ${res.pid}）—— 有些脚本故意留着机架给人看，不 kill，你自己决定。`
    : `\n已退出：code ${res.exitCode}（${(res.ms / 1000).toFixed(1)}s）`,
)

// ---------------------------------------------------------------- 报告
if (res.reportPath) {
  console.log(bullet(`${basename(res.reportPath)}　OK ${res.oks} / FAIL ${res.fails}`))
  const lines = res.reportText.split(/\r?\n/).filter((l) => l.trim())
  const tail = lines.length > 200 ? lines.slice(-200) : lines
  if (lines.length > 200) console.log(`（太长，只列最后 200 行，共 ${lines.length} 行）`)
  console.log(tail.join("\n"))
} else {
  console.log("\n（没发现报告 —— 这个脚本可能不写 Reports，或没跑到写报告那一步）")
}

if (res.stdout.trim()) {
  console.log(bullet("stdout"))
  console.log(res.stdout.trim().split("\n").slice(-80).join("\n"))
}
if (res.stderr.trim()) {
  console.log(bullet("stderr"))
  console.log(res.stderr.trim().split("\n").slice(-40).join("\n"))
}

// Kontakt 把 Lua 的编译/运行错误写进 stderr —— 这是最容易漏掉的一条通道
const luaErrors = res.stderr
  .split(/\r?\n/)
  .filter((l) => /\[kontakt\.scripting\]\s*\[error\]/.test(l) || /^\S+\.lua:\d+:/.test(l.trim()))
if (luaErrors.length) {
  console.log(bullet("⛔ Lua 报错（编译或运行失败）"))
  for (const l of luaErrors) console.log(`  ${l.trim()}`)
  console.log(`\n（脚本没能跑到写报告那一步。改完再跑。）`)
}

console.log(`\n结果：${res.timedOut ? "未退出（结果未知）" : res.fails ? `${res.fails} 个 FAIL` : "没看到 FAIL"}`)
if (res.reportPath) console.log(`报告：${res.reportPath}`)

process.exit(res.timedOut || res.fails ? EXIT.ISSUES : EXIT.OK)
