// scripts/env.mjs —— 环境闸门
//
// 所有「要启动 Kontakt」的动作都先过这里。最重要的是 DeveloperFeatures 开关：
// 关着的时候 Kontakt 会**静默不执行**脚本，不报错、不写报告 —— 不先查就白等。

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  EXIT,
  KONTAKT_EXE_CANDIDATES,
  SKILL_DIR,
  bullet,
  dbPath,
  fileInfo,
  humanSize,
  listKontaktProcesses,
  loadConfig,
  mtimeText,
  parseArgs,
  readDeveloperFeatures,
  tableText,
  workspaceDir,
} from "./lib.mjs"

const args = parseArgs()
const json = args.bool("json")
const rows = []
const add = (item, status, detail) => rows.push({ 项目: item, 结果: status, 说明: detail })

// ---------------------------------------------------------------- Kontakt 可执行
const exes = KONTAKT_EXE_CANDIDATES.filter((p) => existsSync(p))
const exe = args.get("exe") || exes[0] || ""
if (exe && existsSync(exe)) {
  const st = fileInfo(exe)
  add("Kontakt 可执行", "OK", `${exe}（${humanSize(st?.size)}，${mtimeText(st)}）`)
  if (exes.length > 1) add("其它已装版本", "WARN", exes.slice(1).join("；"))
} else {
  add("Kontakt 可执行", "FAIL", exe ? `不存在：${exe}` : `没找到（试过 ${KONTAKT_EXE_CANDIDATES.join(" / ")}）`)
}

// ---------------------------------------------------------------- Lua API 开关
const dev = readDeveloperFeatures()
if (!dev) {
  add("Lua API 开关", "FAIL", "HKCU\\Software\\Native Instruments\\Kontakt 8 → DeveloperFeatures 读不到（Kontakt 没启动过？）")
} else if (dev.value === 1) {
  add("Lua API 开关", "OK", "DeveloperFeatures = 1（Lua 会执行）")
} else {
  add("Lua API 开关", "FAIL", `DeveloperFeatures = ${dev.value}（0 = 脚本静默不执行，先置 1）`)
}

// ---------------------------------------------------------------- 正在跑的实例
const instances = listKontaktProcesses()
if (instances.length) add("正在跑的 Kontakt", "WARN", `${instances.join("；")} —— 批量会抢音频设备，确认不是你在用的工程`)
else add("正在跑的 Kontakt", "OK", "无")

// ---------------------------------------------------------------- 工作区
const ws = workspaceDir(args)
if (!existsSync(ws)) {
  add("工作区", "FAIL", `不存在：${ws}`)
} else {
  const probe = join(ws, `.kontakt-skill-write-test-${process.pid}`)
  try {
    writeFileSync(probe, "ok", "utf8")
    unlinkSync(probe)
    add("工作区", "OK", `${ws}（可写）`)
  } catch (e) {
    add("工作区", "FAIL", `${ws} 不可写：${e.message}`)
  }
}

// ---------------------------------------------------------------- 配置与数据库
const cfgPath = join(SKILL_DIR, "config", "libraries.json")
try {
  const cfg = loadConfig()
  const roots = (cfg.scan_roots ?? []).map((r) => r.path).filter(Boolean)
  if (!existsSync(cfgPath)) add("库扫描配置", "WARN", "config/libraries.json 还没有 —— db_build 会先探测候选让你确认")
  else if (!roots.length) add("库扫描配置", "WARN", `${cfgPath} 里 scan_roots 是空的`)
  else add("库扫描配置", "OK", `${roots.length} 个根：${roots.join("；")}`)
} catch (e) {
  add("库扫描配置", "FAIL", e.message)
}

const db = dbPath(args)
const dbSt = fileInfo(db)
if (dbSt) {
  const n = readFileSync(db, "utf8").split("\n").filter((l) => l.trim()).length - 1
  add("库索引", "OK", `${db}：${n} 条，${mtimeText(dbSt)}`)
} else {
  add("库索引", "WARN", `还没有：${db} —— 先跑 db_build`)
}

// ---------------------------------------------------------------- 结论
const fails = rows.filter((r) => r.结果 === "FAIL").length
const warns = rows.filter((r) => r.结果 === "WARN").length

if (json) {
  console.log(JSON.stringify({ ok: fails === 0, fails, warns, rows }, null, 2))
} else {
  console.log(bullet("Kontakt 环境"))
  console.log(tableText(["项目", "结果", "说明"], rows))
  console.log(
    `\n结论：${fails === 0 ? "可以跑 Kontakt 作业" : "先解决 FAIL"}` +
      `${warns ? `（另有 ${warns} 条 WARN，不影响是否能跑）` : ""}`,
  )
}

process.exit(fails === 0 ? EXIT.OK : EXIT.ENV)
