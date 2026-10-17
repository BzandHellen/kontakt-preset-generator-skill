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
    console.log(`\n[写回失败] 读不到 profiles：${prof.path}${prof.error ? `（${prof.error}）` : ""}`)
  } else {
    const spec = {}
    for (const r of usable) spec[r.mic] = Number(fmt(r.min))
    const res2 = writeProfileJson(prof.path, name, spec, args.bool("force"))
    console.log(`\n---- 写回 profiles ----`)
    console.log(res2.ok ? `  ✅ ${res2.message}` : `  ⛔ ${res2.message}`)
  }
} else if (!args.bool("write")) {
  console.log(`\n（没有写回 profiles —— 你自己粘。要自动写回加 --write，会先备份 .bak。）`)
}
console.log(`\n结论：${protectedLibs.length ? "加密库 —— 学不出来，走 snapshot" : usable.length ? `学出 ${usable.length} 个值` : "没学到可用值"}`)
process.exit(res.fails ? EXIT.ISSUES : EXIT.OK)

// ---------------------------------------------------------------- 往 profiles.json 的 mic_profiles 里写一条
// JSON 就是原生了：读 → 改 → 写回（先备份 .bak）。不用再数字符括号。
function writeProfileJson(path, profileName, spec, force) {
  const text = readFileSync(path, "utf8")
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, message: `profiles.json 不是合法 JSON：${e.message}` }
  }
  data.mic_profiles = data.mic_profiles ?? {}
  const exists = Object.prototype.hasOwnProperty.call(data.mic_profiles, profileName)
  if (exists && !force) return { ok: false, message: `mic_profiles 里已经有 ${profileName} 了（要覆盖加 --force）` }
  data.mic_profiles[profileName] = spec
  writeFileSync(`${path}.bak`, text, "utf8")
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8")
  return { ok: true, message: `${exists ? "替换" : "插入"} mic_profiles.${profileName}；原文件已备份到 ${path}.bak` }
}

function stampText() {
  const d = new Date()
  const z = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}
