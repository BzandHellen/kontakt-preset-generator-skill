// scripts/profiles.mjs —— 看库级默认与习惯值（工作区 manifest/profiles.json）
//
// 2026-10-17 起这份配置是 JSON（原来叫 profiles.lua）。原因：只有 Node 工具读它
// （Kontakt 侧的 Lua 一个都不读），JSON 读写都是原生的，不用再啃 Lua 字面量。
// 迁移用 scripts/migrate-profiles.mjs；旧的 profiles.lua 会留成 .bak。

import { existsSync } from "node:fs"
import { EXIT, bullet, legacyProfilesPath, loadProfilesJson, parseArgs, profilesPath, tableText } from "./lib.mjs"

const args = parseArgs()
const path = profilesPath(args)
const section = args.get("section", "all")

const j = loadProfilesJson(args)
if (!j.ok) {
  console.error(`[用法] ${j.error ? `读不动 ${path}：${j.error}` : `找不到 ${path}`}`)
  if (existsSync(legacyProfilesPath(args))) {
    console.error(`       工作区里还有 profiles.lua —— 跑 kontakt_migrate_profiles 转成 profiles.json`)
  }
  process.exit(EXIT.USAGE)
}
const value = j.value

if (args.bool("json")) {
  console.log(JSON.stringify(value, null, 2))
  process.exit(EXIT.OK)
}

console.log(bullet("profiles"))
console.log(`文件：${path}`)

const show = (s) => section === "all" || section === s

if (show("defaults")) {
  const d = value.defaults ?? {}
  console.log(bullet("defaults —— 清单缺省时用的值"))
  console.log(tableText(["键", "值"], Object.entries(d).map(([k, v]) => ({ 键: k, 值: fmt(v) }))))
}

if (show("pan_by_section")) {
  const p = value.pan_by_section ?? {}
  console.log(bullet("pan_by_section —— 声部默认声像"))
  console.log(tableText(["声部", "pan"], Object.entries(p).map(([k, v]) => ({ 声部: k, pan: fmt(v) }))))
}

if (show("mic_aliases")) {
  const a = value.mic_aliases ?? {}
  console.log(bullet("mic_aliases —— 库 → 标准名 → 该库里的 group 名"))
  const rows = []
  for (const [lib, mics] of Object.entries(a)) {
    const names = Object.entries(mics ?? {})
    if (!names.length) rows.push({ 库: lib, 标准名: "（空 —— 待普查）", "group 名": "" })
    for (const [std, list] of names) rows.push({ 库: lib, 标准名: std, "group 名": [].concat(list).join(" / ") })
  }
  console.log(tableText(["库", "标准名", "group 名"], rows))
}

if (show("mic_profiles")) {
  const p = value.mic_profiles ?? {}
  console.log(bullet("mic_profiles —— 麦克风比例（dB；\"off\" = 关掉）"))
  const rows = []
  for (const [name, spec] of Object.entries(p)) {
    const entries = Object.entries(spec ?? {})
    if (!entries.length) rows.push({ profile: name, 麦克风: "（不改）", dB: "" })
    for (const [mic, db] of entries) rows.push({ profile: name, 麦克风: mic, dB: fmt(db) })
  }
  console.log(tableText(["profile", "麦克风", "dB"], rows))

  const bad = []
  for (const [name, spec] of Object.entries(p)) {
    for (const [mic, db] of Object.entries(spec ?? {})) {
      if (typeof db !== "number" && db !== "off") bad.push(`${name}.${mic} = ${JSON.stringify(db)}`)
    }
  }
  if (bad.length) console.log(`\n⚠ 这些值既不是数字也不是 "off"：${bad.join("；")}`)
}

if (show("mic_snapshots")) {
  const s = value.mic_snapshots ?? {}
  console.log(bullet("mic_snapshots —— 加密/Player 库的麦克风通路（.nksn）"))
  const rows = []
  for (const [tok, v] of Object.entries(s)) {
    if (typeof v === "string") rows.push({ token: tok, 规则: "整库一个文件", 路径: v })
    else if (Array.isArray(v)) {
      for (const rule of v) rows.push({ token: tok, 规则: `match=${rule.match ?? "（任意）"}`, 路径: rule.path ?? "" })
    }
  }
  console.log(rows.length ? tableText(["token", "规则", "路径"], rows) : "（空）")
}

function fmt(v) {
  if (v === "off") return "off（关掉）"
  if (v === Infinity) return "inf"
  if (Array.isArray(v)) return v.join(" / ")
  if (v && typeof v === "object") return "{}"
  return String(v)
}

process.exit(EXIT.OK)
