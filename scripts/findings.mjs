// scripts/findings.mjs —— 本机探测成果库（data\findings.json）
//
// 存的是"这个库到底是什么"：类型（加密/未加密）、脚本槽、group 数、有没有原生 start 条件、
// group 音量能不能存住、麦克风别名/形态、有哪些 patch 家族、有哪些快照、快照里的参数定在哪。
// 文档 `docs\Kontakt-库档案.md` 是它的人读版；工具往里写，避免"每轮重新摸一遍 + 手抄进文档"。
//
// 用法：
//   --show                 列所有库的一句话摘要
//   --library="CSS"        （子串匹配）看这个库的完整条目
//   --merge='{"…":"…"}'    （或 --merge-file=<x.json>）深度合并进该库条目
//   --json                 原样输出 JSON

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { copyFileSync } from "node:fs"
import { join } from "node:path"
import { EXIT, SKILL_DATA, bullet, parseArgs, tableText } from "./lib.mjs"

const FILE = join(SKILL_DATA, "findings.json")
const args = parseArgs()

function load() {
  if (!existsSync(FILE)) return { schema: 1, updated: "", global: {}, libraries: {} }
  try {
    return JSON.parse(readFileSync(FILE, "utf8"))
  } catch (e) {
    console.error(`[用法] ${FILE} 不是合法 JSON：${e.message}`)
    process.exit(EXIT.USAGE)
  }
}

const db = load()
db.libraries = db.libraries ?? {}

const pick = (name) => {
  const keys = Object.keys(db.libraries)
  const hit = keys.filter((k) => k.toLowerCase().includes(String(name).toLowerCase()))
  return hit.length ? hit : null
}

// ---------------------------------------------------------------- 写
if (args.has("merge") || args.has("merge-file")) {
  const raw = args.has("merge-file") ? readFileSync(args.get("merge-file"), "utf8") : args.get("merge")
  let patch
  try {
    patch = JSON.parse(raw)
  } catch (e) {
    console.error(`[用法] 要合并的不是合法 JSON：${e.message}`)
    process.exit(EXIT.USAGE)
  }
  const name = args.get("library", "")
  if (!name) {
    console.error("[用法] --merge 要配 --library=<库名>（不存在则新建）")
    process.exit(EXIT.USAGE)
  }
  const keys = pick(name)
  const key = keys ? keys[0] : name
  const before = JSON.stringify(db.libraries[key] ?? null)
  db.libraries[key] = deepMerge(db.libraries[key] ?? {}, patch)
  db.libraries[key].updated = new Date().toISOString().slice(0, 10)
  db.updated = db.libraries[key].updated
  copyFileSync(FILE, `${FILE}.bak`)
  writeFileSync(FILE, JSON.stringify(db, null, 2) + "\n", "utf8")
  console.log(`[ OK ] 已合并进「${key}」（原文件备份 .bak）`)
  console.log(`  合并前：${before.slice(0, 200)}`)
  console.log(`  合并后：${JSON.stringify(db.libraries[key]).slice(0, 400)}`)
  process.exit(EXIT.OK)
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch
  if (patch && typeof patch === "object") {
    const out = { ...(base ?? {}) }
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base?.[k], v)
    return out
  }
  return patch
}

// ---------------------------------------------------------------- 读
if (args.bool("json")) {
  console.log(JSON.stringify(db, null, 2))
  process.exit(EXIT.OK)
}

const name = args.get("library", "")
if (name) {
  const keys = pick(name)
  if (!keys) {
    console.error(`[用法] findings 里没有匹配「${name}」的库。现有：\n  ${Object.keys(db.libraries).join("\n  ")}`)
    process.exit(EXIT.USAGE)
  }
  for (const k of keys) {
    console.log(bullet(k))
    const e = db.libraries[k]
    const lines = []
    const flat = (o, pre = "") => {
      for (const [kk, vv] of Object.entries(o ?? {})) {
        if (kk === "updated") continue
        if (vv && typeof vv === "object" && !Array.isArray(vv)) flat(vv, `${pre}${kk}.`)
        else lines.push({ 键: `${pre}${kk}`, 值: Array.isArray(vv) ? vv.join(" | ") : String(vv) })
      }
    }
    flat(e)
    console.log(tableText(["键", "值"], lines))
  }
  process.exit(EXIT.OK)
}

// ---------------------------------------------------------------- 列表
console.log(bullet(`本机成果库　${FILE}`))
console.log(`更新：${db.updated ?? "?"}　库数：${Object.keys(db.libraries).length}`)
const rows = Object.entries(db.libraries).map(([k, e]) => ({
  库: k,
  类型: e.kind ?? "?",
  "脚本(受保护)": e.scripts ? `${e.scripts.count ?? "?"}(${e.scripts.protected ?? "?"})` : "—",
  group: e.groups ?? "—",
  "原生start": e.native_start_conditions ?? "—",
  "音量可存": e.group_volume_persists === undefined ? "—" : e.group_volume_persists ? "✅" : "❌",
  快照: e.snapshots ? e.snapshots.length : 0,
  备注: (e.notes ?? []).length ? `${(e.notes ?? []).length} 条` : ""
}))
console.log(tableText(["库", "类型", "脚本(受保护)", "group", "原生start", "音量可存", "快照", "备注"], rows))

console.log(`\n全局事实：${Object.keys(db.global ?? {}).join(" / ")}`)
console.log(`\n看某个库： --library="<名字子串>"　　写回： --library="<名>" --merge='{"key":"value"}'`)
process.exit(EXIT.OK)
