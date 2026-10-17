// scripts/run-lua.mjs —— 逃生舱：跑一个 .lua，把结果带回来
//
// Kontakt 的固定动作是「杀掉旧实例 → 带脚本启动 → 跑完退出」（一个 Lua 脚本 = 一次进程，
// 不能从外部驱动运行中的实例）。这个脚本负责：前置检查 → 启动 → 等退出/等报告 → 回传。
//
// 报告怎么找：给了 --report 就用它；没给就盯着 Reports\ 里有没有新增/更新的 .txt，
// 拿最新的那份当结果（脚本自己写文件的约定，见工作区 docs 坑 10）。

import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import {
  EXIT,
  KONTAKT_EXE_CANDIDATES,
  SKILL_SCRIPTS,
  bullet,
  listKontaktProcesses,
  parseArgs,
  readDeveloperFeatures,
  reportsDir,
  workspaceDir,
} from "./lib.mjs"

const args = parseArgs()
const ws = workspaceDir(args)
const script = resolve(args.get("script", ""))
const timeoutS = args.num("timeout", 180)
const dryRun = args.bool("dry-run")
const exe = args.get("exe") || KONTAKT_EXE_CANDIDATES.find((p) => existsSync(p)) || ""
const explicitReport = args.has("report") ? resolve(args.get("report")) : null

if (!script) {
  console.error("[用法] 要 --script=<某个 .lua>")
  process.exit(EXIT.USAGE)
}

// ---------------------------------------------------------------- 前置检查
const problems = []
const notes = []

if (!existsSync(script)) problems.push(`脚本不存在：${script}`)

// 只跑工作区 / 本 skill scripts 里的脚本，除非显式放开
const lower = (p) => p.toLowerCase().replace(/\//g, "\\")
const inside = lower(script).startsWith(lower(ws)) || lower(script).startsWith(lower(SKILL_SCRIPTS))
if (!inside && !args.bool("allow-outside")) {
  problems.push(`脚本在工作区和 skill scripts 之外：${script}（要跑加 --allow-outside）`)
}

if (!exe || !existsSync(exe)) problems.push(`找不到 Kontakt 可执行${exe ? `：${exe}` : ""}`)

const dev = readDeveloperFeatures()
if (!dev) problems.push("读不到 DeveloperFeatures（Kontakt 至少启动过一次再试）")
else if (dev.value !== 1) problems.push(`DeveloperFeatures = ${dev.value}，脚本会静默不执行 —— 先置 1`)

const instances = listKontaktProcesses()
if (instances.length) notes.push(`已经有一个 Kontakt 在跑：${instances.join("；")} —— 会抢音频设备，确认不是你在用的工程`)

// ---------------------------------------------------------------- 报告快照
function reportSnapshot() {
  const d = reportsDir(args)
  const m = new Map()
  if (!existsSync(d)) return m
  for (const f of readdirSync(d)) {
    if (!f.toLowerCase().endsWith(".txt")) continue
    const p = join(d, f)
    try {
      m.set(p, statSync(p).mtimeMs)
    } catch {
      /* 忽略 */
    }
  }
  return m
}
const before = reportSnapshot()

// ---------------------------------------------------------------- dry-run
if (dryRun) {
  console.log(bullet("run_lua —— 只是演练，没启动任何东西"))
  console.log(`脚本    ：${script}`)
  console.log(`可执行  ：${exe}`)
  console.log(`工作区  ：${ws}`)
  console.log(`超时    ：${timeoutS}s`)
  console.log(`命令行  ："${exe}" "${script}"`)
  console.log(`报告    ：${explicitReport ?? "（自动：盯 Reports 里最新变动的那份）"}`)
  if (notes.length) console.log(`\n注意：\n  ${notes.join("\n  ")}`)
  console.log(
    problems.length
      ? `\n前置检查未过：\n  ${problems.join("\n  ")}`
      : `\n前置检查：通过（DeveloperFeatures=${dev?.value}）`,
  )
  process.exit(problems.length ? EXIT.ENV : EXIT.OK)
}

if (problems.length) {
  console.error(`[环境] ${problems.join("；")}`)
  process.exit(EXIT.ENV)
}

// ---------------------------------------------------------------- 启动
console.log(bullet("run_lua"))
console.log(`启动："${exe}" "${script}"   超时 ${timeoutS}s`)
if (notes.length) console.log(`注意：${notes.join("；")}`)

const child = spawn(exe, [script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: false })
let stdout = ""
let stderr = ""
child.stdout.on("data", (b) => (stdout += b.toString()))
child.stderr.on("data", (b) => (stderr += b.toString()))

const started = Date.now()
let timedOut = false
const exitCode = await new Promise((resolvePromise) => {
  const timer = setTimeout(() => {
    timedOut = true
    resolvePromise(null)
  }, timeoutS * 1000)
  child.on("exit", (code) => {
    clearTimeout(timer)
    resolvePromise(code)
  })
})

console.log(
  timedOut
    ? `\n${timeoutS}s 内没退出（pid ${child.pid}）—— 有些脚本故意留着机架给人看，不 kill，你自己决定。`
    : `\n已退出：code ${exitCode}（${((Date.now() - started) / 1000).toFixed(1)}s）`,
)

// ---------------------------------------------------------------- 报告
function showReport(label, text) {
  const fails = (text.match(/\[\s*FAIL\s*\]/g) ?? []).length
  const oks = (text.match(/\[\s*OK\s*\]/g) ?? []).length
  console.log(bullet(`${label}　OK ${oks} / FAIL ${fails}`))
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const tail = lines.length > 200 ? lines.slice(-200) : lines
  if (lines.length > 200) console.log(`（太长，只列最后 200 行，共 ${lines.length} 行）`)
  console.log(tail.join("\n"))
  return fails
}

let failCount = 0
let usedReport = null
if (explicitReport) {
  if (existsSync(explicitReport)) {
    usedReport = explicitReport
    failCount = showReport(basename(explicitReport), readFileSync(explicitReport, "utf8"))
  } else {
    console.log(`\n（指定的报告没出现：${explicitReport}）`)
  }
} else {
  const after = reportSnapshot()
  const changed = [...after.entries()].filter(([p, m]) => !before.has(p) || before.get(p) !== m).sort((a, b) => b[1] - a[1])
  if (changed.length) {
    usedReport = changed[0][0]
    failCount = showReport(basename(usedReport), readFileSync(usedReport, "utf8"))
    if (changed.length > 1) console.log(`\n（另外还有 ${changed.length - 1} 份报告变了：${changed.slice(1).map(([p]) => basename(p)).join("、")}）`)
  } else {
    console.log("\n（没发现新报告 —— 这个脚本可能不写 Reports，或没跑到写报告那一步）")
  }
}

if (stdout.trim()) {
  console.log(bullet("stdout"))
  console.log(stdout.trim().split("\n").slice(-80).join("\n"))
}
if (stderr.trim()) {
  console.log(bullet("stderr"))
  console.log(stderr.trim().split("\n").slice(-40).join("\n"))
}

console.log(`\n结果：${timedOut ? "未退出（结果未知）" : failCount ? `${failCount} 个 FAIL` : "没看到 FAIL"}`)
if (usedReport) console.log(`报告：${usedReport}`)

process.exit(timedOut || failCount ? EXIT.ISSUES : EXIT.OK)
