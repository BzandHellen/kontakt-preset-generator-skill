// scripts/lib.mjs —— 共享工具
//
// 参数解析 / 路径 / 配置 / CSV / TSV / Lua 字面量读取 / 目录遍历 / 文本输出。
// 只跑 Node 标准库，不依赖 PowerShell（见 README「为什么脚本是 .mjs」）。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawn } from "node:child_process"

// ---------------------------------------------------------------- 退出码
export const EXIT = {
  OK: 0, // 跑完，无问题
  ISSUES: 1, // 跑完，但发现了问题（lint 有 ERROR / 校验有 FAIL）
  USAGE: 2, // 用法或配置不对（缺参数、配置非法、找不到清单…）
  ENV: 3, // 环境不满足（Kontakt 没装 / Lua API 开关关着…）
}

// ---------------------------------------------------------------- 参数
// 只认 `--key=value`（没有值即 "true"）。重复出现时 get() 取最后一个，getAll() 拿全部。
export function parseArgs(argv = process.argv.slice(2)) {
  const all = new Map()
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/s.exec(a)
    if (!m) continue
    const k = m[1]
    if (!all.has(k)) all.set(k, [])
    all.get(k).push(m[2] === undefined ? "true" : m[2])
  }
  const vals = (k) => all.get(k) ?? []
  return {
    raw: argv,
    has: (k) => all.has(k),
    getAll: (k) => vals(k),
    get: (k, dflt = undefined) => (vals(k).length ? vals(k)[vals(k).length - 1] : dflt),
    bool: (k) => {
      if (!all.has(k)) return false
      return !["0", "false", "no", "off"].includes(vals(k)[vals(k).length - 1].toLowerCase())
    },
    num: (k, dflt = undefined) => {
      if (!all.has(k)) return dflt
      const n = Number(vals(k)[vals(k).length - 1])
      return Number.isFinite(n) ? n : dflt
    },
  }
}

// ---------------------------------------------------------------- 路径
export const SKILL_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "")
export const SKILL_SCRIPTS = join(SKILL_DIR, "scripts")
export const SKILL_DATA = join(SKILL_DIR, "data")
export const SKILL_CONFIG = join(SKILL_DIR, "config")
export const DEFAULT_WORKSPACE = "C:\\VEPRO\\Kontakt Patch"

// 工作区顺序：--workspace > $KONTAKT_WORKSPACE > 配置里的 workspace > 默认
export function workspaceDir(args) {
  const w = args?.get?.("workspace") || process.env.KONTAKT_WORKSPACE || loadConfig().workspace || DEFAULT_WORKSPACE
  return resolve(w)
}

export function dbPath(args) {
  return resolve(args?.get?.("db") || join(SKILL_DATA, "kontakt-patches.csv"))
}

export function manifestPath(args) {
  return resolve(args?.get?.("manifest") || join(workspaceDir(args), "manifest", "manifest.tsv"))
}

export function profilesPath(args) {
  return resolve(args?.get?.("profiles") || join(workspaceDir(args), "manifest", "profiles.json"))
}

// 迁移前的旧文件；只有 migrate-profiles 与提示信息会用到
export function legacyProfilesPath(args) {
  return resolve(join(workspaceDir(args), "manifest", "profiles.lua"))
}

export function loadProfilesJson(args) {
  const p = profilesPath(args)
  if (!existsSync(p)) return { path: p, ok: false, value: {} }
  try {
    return { path: p, ok: true, value: JSON.parse(readFileSync(p, "utf8")) }
  } catch (e) {
    return { path: p, ok: false, value: {}, error: e.message }
  }
}

export function reportsDir(args) {
  return resolve(args?.get?.("reports") || join(workspaceDir(args), "Reports"))
}

// ---------------------------------------------------------------- 配置
// config/libraries.json 是本机私有的（不进 git）；没有就返回 {}，由调用方决定怎么办。
export function loadConfig() {
  const p = join(SKILL_CONFIG, "libraries.json")
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch (e) {
    throw new UsageError(`config/libraries.json 不是合法 JSON：${e.message}`)
  }
}

export class UsageError extends Error {}

// 没有配置时只「探测候选」，绝不静默扫全盘。
export function detectLibraryRoots() {
  const out = []
  for (const d of "DEFGHIJKLMNOPQRSTUVWXYZ") {
    const p = `${d}:\\Kontakt Library`
    if (existsSync(p)) out.push({ path: p })
  }
  const cs = "C:\\VEPRO\\Channel Sets\\NKI"
  if (existsSync(cs)) out.push({ path: cs, label: "Channel Sets" })
  return out
}

// ---------------------------------------------------------------- 文本输出
export function tableText(headers, rows) {
  const cells = rows.map((r) => headers.map((h) => String(r[h] ?? "")))
  const w = headers.map((h, i) => Math.max(strWidth(h), ...cells.map((c) => strWidth(c[i]))))
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - strWidth(s)))
  const line = (cs) => cs.map((c, i) => pad(c, w[i])).join("  ").trimEnd()
  const sep = w.map((n) => "-".repeat(n)).join("  ")
  return [line(headers), sep, ...cells.map(line)].join("\n")
}

// 中文字符按 2 列宽算，表格在终端里才对得齐
function strWidth(s) {
  let n = 0
  for (const ch of String(s)) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}

export function humanSize(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function bullet(title) {
  return `\n== ${title} ==`
}

// ---------------------------------------------------------------- 目录遍历
export function extOf(name) {
  return extname(name).toLowerCase()
}

// maxDepth: 0 = 不限。exclude 是完整路径的子串（大小写不敏感）。跳过符号链接/junction。
export function walkFiles(root, { maxDepth = 0, exclude = [], extensions = null } = {}) {
  const out = []
  const ex = exclude.map((s) => String(s).toLowerCase())
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let ents
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 权限 / 消失的目录：跳过
    }
    for (const e of ents) {
      const full = join(dir, e.name)
      const low = full.toLowerCase()
      if (ex.some((x) => low.includes(x))) continue
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (maxDepth === 0 || depth + 1 < maxDepth) stack.push({ dir: full, depth: depth + 1 })
      } else if (e.isFile()) {
        if (extensions && !extensions.includes(extOf(e.name))) continue
        out.push(full)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- CSV
export function csvEscape(v) {
  const s = String(v ?? "")
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function writeCsv(path, header, rows) {
  const body = rows.map((r) => header.map((h) => csvEscape(r[h])).join(","))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [header.join(","), ...body].join("\n") + "\n", "utf8")
  return rows.length
}

export function readCsv(path) {
  const text = readFileSync(path, "utf8")
  const rows = []
  let row = []
  let field = ""
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += c
    } else if (c === '"') inQ = true
    else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (c !== "\r") field += c
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (!rows.length) return []
  const header = rows.shift()
  return rows
    .filter((r) => r.some((c) => c !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])))
}

// ---------------------------------------------------------------- TSV（清单）
// `#` 开头是注释行；第一个非注释行是表头。
export function parseTsv(text) {
  const lines = text.split(/\r?\n/)
  let header = null
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trim()
    if (!t || t.startsWith("#")) continue
    const cells = raw.split("\t").map((s) => s.trim())
    if (!header) {
      header = cells
      continue
    }
    const idx = (name) => header.indexOf(name)
    rows.push({
      line: i + 1,
      cells,
      get: (name) => {
        const k = idx(name)
        return k < 0 ? "" : (cells[k] ?? "")
      },
      has: (name) => idx(name) >= 0,
    })
  }
  return { header: header ?? [], rows }
}

// ---------------------------------------------------------------- Lua 字面量
// 只为读工作区里那几份 `return { ... }` 的数据文件（profiles.lua）而写。
// 支持：嵌套表、字符串、数字、-math.huge、`--` 与 `#` 行注释。
function tokenizeLua(src) {
  const t = []
  let i = 0
  const atLineStart = (p) => p === 0 || src[p - 1] === "\n"
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "-" && src[i + 1] === "-") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "#" && atLineStart(i)) {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if ("{}=,;".includes(c)) {
      t.push({ k: c })
      i++
      continue
    }
    if (c === "-" && src.startsWith("-math.huge", i)) {
      t.push({ k: "num", v: -Infinity })
      i += "-math.huge".length
      continue
    }
    // 负号 + 数字（`-30`）：负号必须自己吃掉，否则会被上面那句「认不出的字符跳过」丢掉
    if (c === "-" && /[0-9.]/.test(src[i + 1] ?? "")) {
      let s = "-"
      i++
      while (i < src.length && /[0-9a-fA-FxX.]/.test(src[i])) {
        s += src[i]
        i++
      }
      if (/[eE]/.test(src[i] ?? "")) {
        s += src[i++]
        if (/[+-]/.test(src[i] ?? "")) s += src[i++]
        while (i < src.length && /[0-9]/.test(src[i])) s += src[i++]
      }
      t.push({ k: "num", v: Number(s) })
      continue
    }
    if (src.startsWith("math.huge", i)) {
      t.push({ k: "num", v: Infinity })
      i += "math.huge".length
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      let s = ""
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") {
          s += src[i + 1]
          i += 2
        } else {
          s += src[i]
          i++
        }
      }
      i++
      t.push({ k: "str", v: s })
      continue
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let s = ""
      while (i < src.length && /[0-9a-fA-FxX.]/.test(src[i])) {
        s += src[i]
        i++
      }
      if (/[eE]/.test(src[i] ?? "")) {
        s += src[i++]
        if (/[+-]/.test(src[i] ?? "")) s += src[i++]
        while (i < src.length && /[0-9]/.test(src[i])) s += src[i++]
      }
      t.push({ k: "num", v: Number(s) })
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = ""
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) s += src[i++]
      t.push({ k: "id", v: s })
      continue
    }
    i++ // 认不出来的字符直接跳过，别卡住
  }
  return t
}

function parseLuaTableText(src) {
  const tokens = tokenizeLua(src)
  let p = 0
  // 开头的 `return` 跳过（它前面可能还有注释行，所以不能靠字符串替换）
  if (tokens[0] && tokens[0].k === "id" && tokens[0].v === "return") p = 1
  const peek = () => tokens[p]
  const next = () => tokens[p++]
  const expect = (k) => {
    const tok = next()
    if (!tok || tok.k !== k) throw new Error(`Lua 解析失败：期望 ${k}，得到 ${tok ? tok.k + ":" + (tok.v ?? "") : "文件结尾"}`)
  }
  function parseValue() {
    const tok = next()
    if (!tok) throw new Error("Lua 解析失败：意外的结尾")
    if (tok.k === "num" || tok.k === "str") return tok.v
    if (tok.k === "id") return tok.v
    if (tok.k === "{") {
      p-- // 退回，交给 parseTable
      return parseTable()
    }
    throw new Error(`Lua 解析失败：意外的 token ${tok.k}`)
  }
  function parseTable() {
    expect("{")
    const obj = {}
    const arr = []
    let sawKey = false
    while (peek() && peek().k !== "}") {
      const tok = peek()
      if ((tok.k === "str" || tok.k === "id") && tokens[p + 1] && tokens[p + 1].k === "=") {
        next()
        next()
        obj[tok.v] = parseValue()
        sawKey = true
      } else {
        arr.push(parseValue())
      }
      if (peek() && (peek().k === "," || peek().k === ";")) next()
    }
    expect("}")
    if (sawKey) return obj
    return arr.length ? arr : {}
  }
  return parseValue()
}

export function parseLuaFile(path) {
  const src = readFileSync(path, "utf8")
  return {
    value: parseLuaTableText(src),
    // 合法 Lua 里没有 `#` 注释：这份文件如果用了，dofile 会直接报语法错
    hashComment: /^\s*#/m.test(src),
  }
}

// ---------------------------------------------------------------- 本机成果库（findings）
// 存"这个库到底是什么"：类型 / 脚本 / group / 原生 start 条件 / 音量能否存 / 家族 / 快照 / 已定位参数。
export const FINDINGS_PATH = join(SKILL_DATA, "findings.json")

export function loadFindings() {
  if (!existsSync(FINDINGS_PATH)) return { schema: 1, updated: "", global: {}, libraries: {} }
  const db = JSON.parse(readFileSync(FINDINGS_PATH, "utf8"))
  db.libraries = db.libraries ?? {}
  return db
}

export function saveFindings(db) {
  db.updated = new Date().toISOString().slice(0, 10)
  if (existsSync(FINDINGS_PATH)) copyFileSync(FINDINGS_PATH, `${FINDINGS_PATH}.bak`)
  writeFileSync(FINDINGS_PATH, JSON.stringify(db, null, 2) + "\n", "utf8")
}

export function deepMergeInto(base, patch) {
  if (Array.isArray(patch)) return patch
  if (patch && typeof patch === "object") {
    const out = { ...(base ?? {}) }
    for (const [k, v] of Object.entries(patch)) out[k] = deepMergeInto(base?.[k], v)
    return out
  }
  return patch
}

// 找一个已存在的条目名（"CSS" ↔ "Cinematic Studio Strings" 这种要先能对上）
export function matchLibraryKey(db, name) {
  const keys = Object.keys(db.libraries ?? {})
  const n = String(name).toLowerCase().replace(/[\s_-]+/g, "")
  const hit = keys.find((k) => {
    const kk = k.toLowerCase().replace(/[\s_-]+/g, "")
    return kk === n || kk.includes(n) || n.includes(kk)
  })
  return hit ?? null
}

// 从 patch 路径推库名：取 "Kontakt Library" / "Library" / "Channel Sets" 之后那一段
export function deriveLibraryKey(p) {
  const parts = String(p).replace(/\\/g, "/").split("/").filter(Boolean)
  const i = parts.findIndex((s) => /^(Kontakt Library|Library|Channel Sets)$/i.test(s))
  if (i >= 0 && parts[i + 1]) return parts[i + 1]
  if (parts.length >= 2) return parts[parts.length - 2]
  return "unknown"
}

export function recordFindings(name, patch) {
  const db = loadFindings()
  const key = matchLibraryKey(db, name) ?? name
  db.libraries[key] = deepMergeInto(db.libraries[key] ?? {}, patch)
  db.libraries[key].updated = new Date().toISOString().slice(0, 10)
  saveFindings(db)
  return key
}

// ---------------------------------------------------------------- 杂项
// 存在的普通文件才返回 stat，否则 null（junction / 坏路径统一当「没有」）。
export function fileInfo(p) {
  try {
    const st = statSync(p)
    return st.isFile() ? st : null
  } catch {
    return null
  }
}

export function mtimeText(st) {
  if (!st) return ""
  const d = new Date(st.mtimeMs)
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`
}

// ---------------------------------------------------------------- Kontakt 环境探测
export const KONTAKT_EXE_CANDIDATES = [
  "C:\\Program Files\\Native Instruments\\Kontakt 8\\Kontakt 8.exe",
  "C:\\Program Files\\Native Instruments\\Kontakt 7\\Kontakt 7.exe",
]

// DeveloperFeatures: 0 = 关（脚本静默不执行）1 = 开。读不到返回 null。
export function readDeveloperFeatures() {
  const key = "HKCU\\Software\\Native Instruments\\Kontakt 8"
  for (const extra of [["/reg:64"], []]) {
    try {
      const out = execFileSync("reg.exe", ["query", key, "/v", "DeveloperFeatures", ...extra], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      })
      const m = /DeveloperFeatures\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out)
      if (m) return { value: parseInt(m[1], 16), key }
    } catch {
      /* 试下一档 */
    }
  }
  return null
}

export function listKontaktProcesses() {
  try {
    const out = execFileSync("tasklist.exe", ["/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true })
    return out
      .split(/\r?\n/)
      .map((l) => /^"([^"]+)","(\d+)"/.exec(l.trim()))
      .filter((m) => m && /kontakt/i.test(m[1]))
      .map((m) => `${m[1]} (pid ${m[2]})`)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- 启动 Kontakt 跑一个 Lua 作业
// 约定（见 SKILL.md）：一个 Lua 脚本 = 一次进程；结果靠「报告文件」而不是 stdout。
// 报告定位：显式给路径就用它；否则盯 reportsDir 里新增/更新的 .txt，取最新的那份。
// 超时默认**不 kill** —— 有些脚本故意留着机架给人看。
// 但坏采样弹模态框会把作业卡死（脚本停在 load_instrument 上）→ 那种情况用 killOnTimeout: true
// 把**我们自己刚起的**这个进程掐掉（只掐 agent 起的那个；永远不碰用户自己的实例）。
export async function launchKontakt({ exe, script, timeoutS = 180, explicitReport = null, reportsDirPath = null, killOnTimeout = false }) {
  const snapshot = () => {
    const m = new Map()
    if (!reportsDirPath || !existsSync(reportsDirPath)) return m
    for (const f of readdirSync(reportsDirPath)) {
      if (!f.toLowerCase().endsWith(".txt")) continue
      const p = join(reportsDirPath, f)
      const st = fileInfo(p)
      if (st) m.set(p, st.mtimeMs)
    }
    return m
  }

  const before = snapshot()
  const started = Date.now()
  const child = spawn(exe, [script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: false })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (b) => (stdout += b.toString()))
  child.stderr.on("data", (b) => (stderr += b.toString()))

  let timedOut = false
  let killed = false
  const exitCode = await new Promise((done) => {
    const timer = setTimeout(() => {
      timedOut = true
      if (killOnTimeout) {
        try {
          child.kill()
          killed = true
        } catch {
          /* 掐不掉就算了，别把作业流程也搞挂 */
        }
      }
      done(null)
    }, timeoutS * 1000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done(code)
    })
  })

  // 报告：优先显式路径，其次 Reports 里变动过的最新一份
  let reportPath = null
  if (explicitReport && existsSync(explicitReport)) reportPath = explicitReport
  else {
    const after = snapshot()
    const changed = [...after.entries()].filter(([p, m]) => !before.has(p) || before.get(p) !== m).sort((a, b) => b[1] - a[1])
    if (changed.length) reportPath = changed[0][0]
  }

  const reportText = reportPath ? readFileSync(reportPath, "utf8") : ""
  const oks = (reportText.match(/\[\s*OK\s*\]/g) ?? []).length
  const fails = (reportText.match(/\[\s*FAIL\s*\]/g) ?? []).length

  return {
    timedOut,
    killed,
    exitCode,
    pid: child.pid,
    ms: Date.now() - started,
    stdout,
    stderr,
    reportPath,
    reportText,
    oks,
    fails,
  }
}

// ---------------------------------------------------------------- 启动前检查
// 所有「要启动 Kontakt」的脚本共用：脚本存在 + 在允许的目录内 + 可执行 + API 开关。
export function preflight(args, script = null) {
  const ws = workspaceDir(args)
  const problems = []
  const notes = []
  const exe = args.get("exe") || KONTAKT_EXE_CANDIDATES.find((p) => existsSync(p)) || ""

  if (script) {
    if (!existsSync(script)) problems.push(`脚本不存在：${script}`)
    const low = (p) => p.toLowerCase().replace(/\//g, "\\")
    const inside = low(script).startsWith(low(ws)) || low(script).startsWith(low(SKILL_SCRIPTS))
    if (!inside && !args.bool("allow-outside")) problems.push(`脚本在工作区和 skill scripts 之外：${script}（要跑加 --allow-outside）`)
  }
  if (!exe || !existsSync(exe)) problems.push(`找不到 Kontakt 可执行${exe ? `：${exe}` : ""}`)

  const dev = readDeveloperFeatures()
  if (!dev) problems.push("读不到 DeveloperFeatures（Kontakt 至少启动过一次再试）")
  else if (dev.value !== 1) problems.push(`DeveloperFeatures = ${dev.value}，脚本会静默不执行 —— 先置 1`)

  const instances = listKontaktProcesses()
  if (instances.length) notes.push(`已经有一个 Kontakt 在跑：${instances.join("；")} —— 会抢音频设备，确认不是你在用的工程`)

  return { exe, problems, notes, dev, workspace: ws }
}

// Lua 侧用 kontakt_lib.machine_block() 往报告里塞一段 TSV，Node 侧在这里取回来。
export function parseMachineBlock(text, name = "MACHINE") {
  const begin = `---- ${name} ----`
  const end = `---- /${name} ----`
  const i = text.indexOf(begin)
  if (i < 0) return null
  const j = text.indexOf(end, i + begin.length)
  if (j < 0) return null
  const body = text.slice(i + begin.length, j).trim()
  const lines = body.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const header = lines[0].split("\t")
  return lines.slice(1).map((l) => Object.fromEntries(header.map((h, k) => [h, (l.split("\t")[k] ?? "").trim()])))
}

// ---------------------------------------------------------------- 音名 ↔ MIDI
// Kontakt 的默认八度记法：C3 = 60（所以 C0 = 12，C-1 = 0）。
export function noteToMidi(name, c3 = 60) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(name).trim())
  if (!m) return null
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()]
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0
  return base + acc + (Number(m[3]) + 1) * 12 + (c3 - 60)
}

export function midiToNote(n, c3 = 60) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
  const v = Number(n)
  if (!Number.isFinite(v)) return ""
  const oct = Math.floor((v - (c3 - 60)) / 12) - 1
  return `${names[((v - (c3 - 60)) % 12 + 12) % 12]}${oct}`
}


