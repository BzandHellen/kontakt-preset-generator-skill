// scripts/manifest-lint.mjs —— 清单体检
//
// 「任一 FAIL 只报告不继续铺开」的前置。ERROR 会挡住生成，WARN 只是提醒。

import { existsSync, readFileSync } from "node:fs"
import {
  EXIT,
  bullet,
  manifestPath,
  parseArgs,
  parseLuaFile,
  parseTsv,
  profilesPath,
  tableText,
} from "./lib.mjs"

const args = parseArgs()
const manifest = manifestPath(args)
const issues = []
const err = (line, field, msg) => issues.push({ 行: line, 级别: "ERROR", 字段: field, 说明: msg })
const warn = (line, field, msg) => issues.push({ 行: line, 级别: "WARN", 字段: field, 说明: msg })

if (!existsSync(manifest)) {
  console.error(`[用法] 找不到清单：${manifest}`)
  process.exit(EXIT.USAGE)
}

const KNOWN = ["multi", "slot", "patch", "name", "midi", "port", "out", "vol", "pan", "mic", "keysw", "snapshot", "note"]
const REQUIRED = ["multi", "patch", "name"]
const SECTIONS = ["STR", "BRS", "WW", "PERC", "ETH", "CHO"]

const { header, rows } = parseTsv(readFileSync(manifest, "utf8"))

for (const col of REQUIRED) {
  if (!header.includes(col)) {
    console.error(`[用法] 清单缺必填列 \`${col}\`；表头是：${header.join(" | ")}`)
    process.exit(EXIT.USAGE)
  }
}
for (const col of header) if (!KNOWN.includes(col)) warn(0, col, `未知列（会被忽略）`)

// ---------------------------------------------------------------- mic profile 表
let profileNames = null
let snapshotTokens = new Set()
const profPath = profilesPath(args)
if (existsSync(profPath)) {
  try {
    const { value, hashComment } = parseLuaFile(profPath)
    profileNames = new Set(Object.keys(value.mic_profiles ?? {}))
    snapshotTokens = new Set(Object.keys(value.mic_snapshots ?? {}))
    if (hashComment) {
      warn(
        0,
        "mic",
        `${profPath} 用了 \`#\` 注释 —— 合法 Lua 没有这种注释，将来 dofile 它会语法错（本工具自己容忍，mic 名字照常校验）`,
      )
    }
  } catch (e) {
    warn(0, "mic", `${profPath} 读不动（${e.message}）—— mic 名字先不校验`)
  }
} else {
  warn(0, "mic", `没有 ${profPath} —— mic 名字先不校验`)
}

// ---------------------------------------------------------------- 逐行
const isInt = (v) => /^-?\d+$/.test(v)
const isNum = (v) => v !== "" && Number.isFinite(Number(v))
const used = new Map() // multi -> Set(slot)
const seenPatch = new Map() // multi -> Set(patch)
const seenName = new Map() // multi -> Set(name)
const multiOrder = []

for (const r of rows) {
  const L = r.line
  const multi = r.get("multi")
  const patch = r.get("patch")
  const name = r.get("name")

  if (!multi) err(L, "multi", "空")
  else {
    if (/[\\/:*?"<>|]/.test(multi)) err(L, "multi", `含文件名非法字符：${multi}`)
    if (!SECTIONS.some((s) => multi.startsWith(s))) warn(L, "multi", `不以前缀 ${SECTIONS.join("/")} 开头：${multi}`)
    if (!multiOrder.includes(multi)) multiOrder.push(multi)
  }

  if (!patch) err(L, "patch", "空")
  else {
    if (!existsSync(patch)) err(L, "patch", `文件不存在：${patch}`)
    if (!/\.nki$/i.test(patch)) warn(L, "patch", `不是 .nki：${patch}`)
    const set = seenPatch.get(multi) ?? new Set()
    if (set.has(patch.toLowerCase())) warn(L, "patch", "同一个 multi 里重复出现")
    set.add(patch.toLowerCase())
    seenPatch.set(multi, set)
  }

  if (!name) err(L, "name", "空")
  else {
    const set = seenName.get(multi) ?? new Set()
    if (set.has(name)) warn(L, "name", `同一个 multi 里槽名重复：${name}`)
    set.add(name)
    seenName.set(multi, set)
  }

  const slot = r.get("slot")
  if (slot !== "") {
    if (!isInt(slot) || Number(slot) < 0 || Number(slot) > 63) err(L, "slot", `要在 0–63：${slot}`)
    else {
      const set = used.get(multi) ?? new Set()
      if (set.has(slot)) err(L, "slot", `同一个 multi 里重复占用 slot ${slot}`)
      set.add(slot)
      used.set(multi, set)
    }
  }

  const midi = r.get("midi")
  if (midi !== "" && (!isInt(midi) || Number(midi) < 1 || Number(midi) > 16)) err(L, "midi", `要在 1–16：${midi}`)

  const port = r.get("port")
  if (port !== "" && !/^[A-Da-d]$/.test(port)) err(L, "port", `要是 A–D：${port}`)

  const out = r.get("out")
  if (out !== "" && (!isInt(out) || Number(out) < 1)) err(L, "out", `要是正整数：${out}`)

  for (const f of ["vol", "pan"]) {
    const v = r.get(f)
    if (v !== "" && !isNum(v)) err(L, f, `不是数字：${v}`)
  }

  const mic = r.get("mic")
  if (mic !== "") {
    if (mic.startsWith("learn:")) {
      const p = mic.slice("learn:".length).trim()
      if (!p) err(L, "mic", "learn: 后面没写文件")
      else if (!existsSync(p)) err(L, "mic", `learn 指的文件不存在：${p}`)
      else warn(L, "mic", `learn: 是「先手调好再学」的入口 —— 现在还没有自动跑 learn_mic`)
    } else if (mic.startsWith("snap:")) {
      const p = mic.slice(5).trim()
      if (!p) err(L, "mic", "snap: 后面没写文件")
      else if (!existsSync(p)) err(L, "mic", `snap 指的文件不存在：${p}`)
    } else if (mic.includes("=")) {
      // 内联：`名=dB`，值可以是数字 / off / mute / -math.huge
      const one = "[A-Za-z0-9 _-]+=(-?[0-9.]+|off|mute|-math\\.huge)"
      if (!new RegExp(`^${one}(;${one})*$`).test(mic)) err(L, "mic", `内联写成 \`名=dB;名=off\`：${mic}`)
    } else if (snapshotTokens.has(mic)) {
      warn(L, "mic", `用 snapshot 规则 \`${mic}\`（按 patch 路径挑 .nksn）`)
    } else if (profileNames) {
      if (!profileNames.has(mic)) {
        err(
          L,
          "mic",
          `profiles 里既没有 mic_profiles.${mic} 也没有 mic_snapshots.${mic}` +
            `（有：${[...profileNames].join("/") || "（空）"}｜${[...snapshotTokens].join("/") || "（无 snapshot）"}）`,
        )
      }
    }
  }

  const ks = r.get("keysw")
  if (ks !== "" && !/^(\s*(ks|tr)\s*=\s*-?\d+\s*;?)+$/.test(ks)) warn(L, "keysw", `格式像 \`ks=C0;tr=-12\`：${ks}`)

  const snap = r.get("snapshot")
  if (snap !== "" && !existsSync(snap)) warn(L, "snapshot", `文件不存在：${snap}`)
}

// ---------------------------------------------------------------- 汇总
const errors = issues.filter((i) => i.级别 === "ERROR")
const warns = issues.filter((i) => i.级别 === "WARN")

console.log(bullet("清单"))
console.log(`文件：${manifest}`)
console.log(`共 ${rows.length} 行 / ${multiOrder.length} 个 multi：${multiOrder.join("、") || "（空）"}`)

if (issues.length) {
  console.log(bullet(`问题 —— ${errors.length} ERROR / ${warns.length} WARN`))
  console.log(tableText(["行", "级别", "字段", "说明"], issues.sort((a, b) => a.行 - b.行)))
} else {
  console.log("\n没问题。")
}

console.log(`\n结论：${errors.length ? "有 ERROR，别急着生成" : warns.length ? "可以生成（先看一眼 WARN）" : "可以生成"}`)
process.exit(errors.length ? EXIT.ISSUES : EXIT.OK)
