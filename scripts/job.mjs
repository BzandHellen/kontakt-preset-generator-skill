// scripts/job.mjs —— 作业渲染：把配置塞进模板，写成可执行的 job.lua
//
// Kontakt 只能「一个 .lua + 没有参数」地跑，所以配置必须以源码形式注入：
// 模板里用 @LIB@（公共库路径）和 @JOB@（配置表）两个占位符。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SKILL_DIR, workDir, workspaceDir } from "./lib.mjs"

const TEMPLATES = join(SKILL_DIR, "templates")
export const LIB_LUA = join(SKILL_DIR, "scripts", "kontakt_lib.lua")

// ------------------------------------------------------------------ Lua 字面量
const LUA_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const LUA_RESERVED = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto","if","in",
  "local","nil","not","or","repeat","return","then","true","until","while",
])

function luaString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`
}

function luaNumber(n) {
  if (Number.isNaN(n)) return "nil"
  if (n === Infinity) return "math.huge"
  if (n === -Infinity) return "-math.huge"
  return String(n)
}

export function luaValue(v, ind = 0) {
  const pad = "\t".repeat(ind)
  const padIn = "\t".repeat(ind + 1)
  if (v === null || v === undefined) return "nil"
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return luaNumber(v)
  if (typeof v === "string") return luaString(v)
  if (Array.isArray(v)) {
    if (!v.length) return "{}"
    const items = v.map((x) => `${padIn}${luaValue(x, ind + 1)},`)
    return `{\n${items.join("\n")}\n${pad}}`
  }
  const keys = Object.keys(v)
  if (!keys.length) return "{}"
  const items = keys.map((k) => {
    const key = LUA_KEY.test(k) && !LUA_RESERVED.has(k) ? k : `[${luaString(k)}]`
    return `${padIn}${key} = ${luaValue(v[k], ind + 1)},`
  })
  return `{\n${items.join("\n")}\n${pad}}`
}

// ------------------------------------------------------------------ 渲染
export function slugify(s, max = 60) {
  const t = String(s).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")
  return t.slice(0, max) || "job"
}

function stamp() {
  const d = new Date()
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

// 把模板 + 配置写成 <工作区>\jobs\<时间戳>-<slug>\job.lua
export function renderJob(templateFile, job, { args, slug } = {}) {
  const tplPath = join(TEMPLATES, templateFile)
  if (!existsSync(tplPath)) throw new Error(`没有模板：${tplPath}`)
  const tpl = readFileSync(tplPath, "utf8")
  const src = tpl
    .replaceAll("@LIB@", LIB_LUA.replace(/\\/g, "/"))
    .replaceAll("@JOB@", luaValue(job))

  const dir = join(workDir(args), "jobs", `${stamp()}-${slugify(slug ?? job.multi ?? job.nkm ?? "job")}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "job.lua")
  writeFileSync(file, src, "utf8")
  return { file, dir, source: src }
}
