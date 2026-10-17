// scripts/learn-mic.mjs —— 从一个"已调好的乐器"学出麦克风 profile
//
// 输出可直接粘进 profiles.lua 的 Lua 片段。**不写回**（改的是你的数据文件，等你点头再说）。
// 只对未加密库有意义：加密库的 group 音量存不住，学到的是默认值。

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import {
  EXIT,
  bullet,
  launchKontakt,
  parseArgs,
  parseMachineBlock,
  preflight,
  reportsDir,
  tableText,
} from "./lib.mjs"
import { renderJob } from "./job.mjs"
import { loadProfiles, mergedAliases } from "./plan.mjs"

const args = parseArgs()
const repDir = reportsDir(args)
const timeoutS = args.num("timeout", 240)

let patches = args.getAll("patch").filter(Boolean).map((p) => resolve(p))
if (!patches.length) {
  console.error("[用法] 要 --patch=<某个你已调好的 .nki>（可多个，会各自学一遍）")
  process.exit(EXIT.USAGE)
}
const bad = patches.filter((p) => !existsSync(p))
if (bad.length) {
  console.error(`[用法] 这些文件不存在：\n  ${bad.join("\n  ")}`)
  process.exit(EXIT.USAGE)
}

const prof = loadProfiles(args)
const micKeys = args.getAll("mic").map((s) => s.toUpperCase())
const name = args.get("name", "") || basename(patches[0]).replace(/\.nki$/i, "").replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40).toLowerCase()
const report = join(repDir, `learn-${name}-${stampText()}.txt`).replace(/\\/g, "/")

const rendered = renderJob(
  "job_learn_mic.lua",
  {
    patches: patches.map((p) => p.replace(/\\/g, "/")),
    report,
    census: args.num("census", 12),
    keywords: args.getAll("keyword"),
    mic_keys: micKeys,
    mic_aliases: mergedAliases(prof.value),
  },
  { args, slug: `learn-${name}` },
)

console.log(bullet("学麦克风比例"))
console.log(`乐器：${patches.join("、")}`)
console.log(`作业：${rendered.file}`)
console.log(`报告：${report}`)
console.log(`输出 profile 名：${name}`)
console.log(`\n⚠ 只有**你已手调好**的乐器才学得出东西；加密库学不出（先看报告里的库类型）。`)

const pf = preflight(args)
if (pf.notes.length) console.log(`注意：${pf.notes.join("；")}`)

if (args.bool("dry-run")) {
  console.log(`\n（dry-run：没启动 Kontakt。前置检查：${pf.problems.length ? pf.problems.join("；") : "通过"}）`)
  process.exit(pf.problems.length ? EXIT.ENV : EXIT.OK)
}
if (pf.problems.length) {
  console.error(`[环境] ${pf.problems.join("；")}`)
  process.exit(EXIT.ENV)
}

const res = await launchKontakt({ exe: pf.exe, script: rendered.file, timeoutS, explicitReport: report, reportsDirPath: repDir })
console.log(`\n退出：${res.timedOut ? `超时（${timeoutS}s）` : `code ${res.exitCode}`}　${(res.ms / 1000).toFixed(1)}s`)
console.log(`报告：${res.reportPath ?? "（没找到）"}　OK ${res.oks} / FAIL ${res.fails}`)

const libs = parseMachineBlock(res.reportText, "LIBS") ?? []
const mics = parseMachineBlock(res.reportText, "MICS") ?? []
const protectedLibs = libs.filter((r) => String(r.protected).toLowerCase() === "true")

if (mics.length) {
  console.log(`\n---- 读到各麦克风（${mics.length}）`)
  console.log(
    tableText(
      ["麦克风", "group 数", "min", "max", "是否一致"],
      mics.map((r) => ({
        麦克风: r.mic,
        "group 数": r.n,
        min: r.min,
        max: r.max,
        "是否一致": String(r.min) === String(r.max) ? "是" : `否（${r.min} … ${r.max}）`,
      })),
    ),
  )
}

if (protectedLibs.length) {
  console.log(
    `\n⛔ 有 ${protectedLibs.length} 个受保护（加密/Player）库：**学不出东西** —— 它的 group 音量存不住，\n` +
      `   这里读到的是默认值。这类库的麦克风只能靠 snapshot（人在 UI 里调一次 → 存 .nksn → 用 apply_snapshot 套）。`,
  )
}

if (!mics.length) {
  console.log(`\n⚠ 一个麦克风名都没匹配上 —— 先跑 kontakt_probe_library 普查 group 名，把别名填进 profiles.lua 的 mic_aliases。`)
  process.exit(EXIT.ISSUES)
}

// 只对一致（min == max）的值给出片段；不一致的说明这个乐器里同一麦克风有多个音量，得人工定
const usable = mics.filter((r) => String(r.min) === String(r.max) && r.min !== "")
const vary = mics.filter((r) => String(r.min) !== String(r.max))
const fmt = (v) => {
  if (String(v) === "-inf") return "-math.huge"
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return String(Math.round(n * 100) / 100)
}

if (usable.length) {
  console.log(`\n---- 可直接粘进 profiles.lua 的 mic_profiles 片段 ----`)
  console.log(`  ${name} = {`)
  console.log(`    ${usable.map((r) => `${r.mic} = ${fmt(r.min)}`).join(", ")}`)
  console.log(`  },`)
}

// ---------------------------------------------------------------- 写回（可选）
if (args.bool("write") && usable.length) {
  if (!prof.ok) {
    console.log(`\n[写回失败] 读不到 profiles：${prof.path}`)
  } else {
    const line = `    ${name} = { ${usable.map((r) => `${r.mic} = ${fmt(r.min)}`).join(", ")} },`
    const r = writeProfile(prof.path, name, line, args.bool("force"))
    console.log(`\n---- 写回 profiles.lua ----`)
    console.log(r.ok ? `  ✅ ${r.message}` : `  ⛔ ${r.message}`)
  }
} else if (!args.bool("write")) {
  console.log(`\n（没有写回 profiles.lua —— 你自己粘。要自动写回加 --write，会先备份 .bak。）`)
}
console.log(`\n结论：${protectedLibs.length ? "加密库 —— 学不出来，走 snapshot" : usable.length ? `学出 ${usable.length} 个值` : "没学到可用值"}`)
process.exit(res.fails ? EXIT.ISSUES : EXIT.OK)

// ---------------------------------------------------------------- 往 profiles.lua 的 mic_profiles 里插/换一条
// 保守做法：定位 `mic_profiles` 后的第一个 `{`，用括号计数找到配对的 `}`，
// 在这之前插入（若同名条目已存在则替换那一行）。先写 .bak。
function writeProfile(path, profileName, line, force) {
  const text = readFileSync(path, "utf8")
  const at = text.indexOf("mic_profiles")
  if (at < 0) return { ok: false, message: `profiles.lua 里找不到 mic_profiles（${path}）` }
  const open = text.indexOf("{", at)
  if (open < 0) return { ok: false, message: "找不到 mic_profiles 的 { " }

  // 括号计数（跳过字符串与注释）
  let depth = 0
  let end = -1
  let inStr = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === "\\") i++
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") {
      inStr = c
      continue
    }
    if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i)
      i = nl < 0 ? text.length : nl
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return { ok: false, message: "mic_profiles 的括号没配对" }

  const body = text.slice(open + 1, end)
  const existing = new RegExp(`^[ \\t]*${profileName}[ \\t]*=.*$`, "m")
  let next
  if (existing.test(body)) {
    if (!force) return { ok: false, message: `mic_profiles 里已经有 ${profileName} 了（要覆盖加 --force）` }
    next = text.slice(0, open + 1) + body.replace(existing, line) + text.slice(end)
  } else {
    // 插在收尾之前：保留原有的缩进风格
    const trimmed = body.replace(/[ \t]+\n?$/, "")
    next = text.slice(0, open + 1) + trimmed + "\n" + line + "\n" + text.slice(end)
  }

  writeFileSync(`${path}.bak`, text, "utf8")
  writeFileSync(path, next, "utf8")
  return {
    ok: true,
    message: `${existing.test(body) ? "替换" : "插入"} mic_profiles.${profileName}；原文件已备份到 ${path}.bak`,
  }
}

function stampText() {
  const d = new Date()
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}
