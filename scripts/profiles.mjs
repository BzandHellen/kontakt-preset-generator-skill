// scripts/profiles.mjs —— 看库级默认与习惯值（工作区 manifest/profiles.lua）
//
// M1 只读：写回等「profiles 是否改单一来源 JSON」定了再说。

import { existsSync } from "node:fs"
import { EXIT, bullet, parseArgs, parseLuaFile, profilesPath, tableText } from "./lib.mjs"

const args = parseArgs()
const path = profilesPath(args)
const section = args.get("section", "all")

if (!existsSync(path)) {
  console.error(`[用法] 找不到 ${path}`)
  process.exit(EXIT.USAGE)
}

let parsed
try {
  parsed = parseLuaFile(path)
} catch (e) {
  console.error(`[用法] ${path} 解析失败：${e.message}`)
  process.exit(EXIT.USAGE)
}
const { value, hashComment } = parsed

if (args.bool("json")) {
  console.log(JSON.stringify(value, (k, v) => (v === -Infinity ? "-math.huge" : v === Infinity ? "math.huge" : v), 2))
  process.exit(EXIT.OK)
}

console.log(bullet("profiles"))
console.log(`文件：${path}`)
if (hashComment) {
  console.log(
    `⚠ 这份文件里有 \`#\` 开头的行注释。合法 Lua 没有这种注释 —— 现在能读是因为本工具自己容忍它，\n` +
      `  但 \`dofile()\` 会直接语法错，将来 gen_multis.lua 读它就会失败。建议改成 \`--\`。`,
  )
}

const show = (s) => section === "all" || section === s

if (show("defaults")) {
  const d = value.defaults ?? {}
  console.log(bullet("defaults —— 清单缺省时用的值"))
  console.log(tableText(["键", "值"], Object.entries(d).map(([k, v]) => ({ 键: k, 值: fmt(v) }))))
}

if (show("pan_by_section")) {
  const p = value.pan_by_section ?? {}
  console.log(bullet("pan_by_section —— 声部默认声像"))
  console.log(
    tableText(
      ["声部", "pan"],
      Object.entries(p).map(([k, v]) => ({ 声部: k, pan: fmt(v) })),
    ),
  )
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
  console.log(bullet("mic_profiles —— 麦克风比例（dB）"))
  const rows = []
  for (const [name, spec] of Object.entries(p)) {
    const entries = Object.entries(spec ?? {})
    if (!entries.length) rows.push({ profile: name, 麦克风: "（不改）", dB: "" })
    for (const [mic, db] of entries) rows.push({ profile: name, 麦克风: mic, dB: fmt(db) })
  }
  console.log(tableText(["profile", "麦克风", "dB"], rows))

  // 顺带体检：值必须是数字或 -inf
  const bad = []
  for (const [name, spec] of Object.entries(p)) {
    for (const [mic, db] of Object.entries(spec ?? {})) {
      if (typeof db !== "number") bad.push(`${name}.${mic} = ${JSON.stringify(db)}`)
    }
  }
  if (bad.length) console.log(`\n⚠ 这些值不是数字：${bad.join("；")}`)
}

function fmt(v) {
  if (v === Infinity) return "math.huge"
  if (v === -Infinity) return "-math.huge（关掉）"
  if (Array.isArray(v)) return v.join(" / ")
  if (v && typeof v === "object") return "{}"
  return String(v)
}

process.exit(EXIT.OK)
