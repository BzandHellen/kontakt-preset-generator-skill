// scripts/migrate-profiles.mjs —— profiles.lua → profiles.json（一次性迁移）
//
// 为什么换：profiles.lua 只有 Node 工具在读（Kontakt 侧的 Lua 一个都不读它），
// 读的时候得硬啃 Lua 字面量、写的时候得数字符括号 —— 换成 JSON 两件事都变成原生的。
//
// 注意：JSON 没有 -Infinity，所以 `-math.huge`（= 把麦克风关掉）写成字符串 "off"，
// 语义和清单里 `mic = CLOSE=off` 的内联写法一致。

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { EXIT, bullet, parseArgs, parseLuaFile, profilesPath, workDir, workspaceDir } from "./lib.mjs"
import { join } from "node:path"

const args = parseArgs()
const ws = workspaceDir(args)
const luaPath = join(workDir(args), "manifest", "profiles.lua")
const jsonPath = join(workDir(args), "manifest", "profiles.json")

if (!existsSync(luaPath)) {
  console.error(`[用法] 找不到 ${luaPath}`)
  process.exit(EXIT.USAGE)
}
if (existsSync(jsonPath) && !args.bool("force")) {
  console.error(`[用法] ${jsonPath} 已存在（要覆盖加 --force）`)
  process.exit(EXIT.USAGE)
}

const { value, hashComment } = parseLuaFile(luaPath)

// -Infinity → "off"；Infinity → "inf"；其余原样
const replacer = (k, v) => (v === -Infinity ? "off" : v === Infinity ? "inf" : v)
const json = JSON.stringify(value, replacer, 2) + "\n"

copyFileSync(luaPath, `${luaPath}.bak`)
writeFileSync(jsonPath, json, "utf8")

console.log(bullet("profiles.lua → profiles.json"))
console.log(`源：${luaPath}（已备份到 .bak）`)
console.log(`新：${jsonPath}`)
if (hashComment) console.log(`（源文件里有 \`#\` 注释 —— 合法 Lua 没有这种注释，正好一起扔掉）`)

const mics = Object.keys(value.mic_profiles ?? {})
const snaps = Object.keys(value.mic_snapshots ?? {})
const aliases = Object.keys(value.mic_aliases ?? {})
console.log(`\n搬过来：mic_profiles ${mics.length} 个（${mics.join("、")}）`)
console.log(`        mic_snapshots ${snaps.length} 个（${snaps.join("、")}）`)
console.log(`        mic_aliases ${aliases.length} 个库（${aliases.join("、")}）`)
console.log(`        defaults / pan_by_section 照搬`)
console.log(`\n-Infinity 已写成 "off"（= 把这个麦克风关掉）。`)
console.log(`\n下一步：profiles.lua 可以留着当备份，但工具以后只读 profiles.json。`)
