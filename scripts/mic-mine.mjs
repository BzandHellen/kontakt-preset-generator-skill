// scripts/mic-mine.mjs —— 从**已有的读库报告**里挖出每个库的"麦克风维度"
//
// 不启动 Kontakt：直接读 Reports/probe-libs-*.txt 里的 GROUPS<i> 机器块（含每个 group 的名字），
// 名字里的"最后一个字段 / 破折号尾段 / 首个词"往往就是麦克风位置（Audiobro 的 `00 Close`、
// Cinesamples 的 ` - FL`、Performance Samples 的 `cl ...`）。
//
// 输出：每库的候选麦克风维度 + 取值 + 覆盖度；--write 写进成果库 mic_tokens。
//
// 用法：
//   node scripts/mic-mine.mjs                   只用最新一套 probe-libs 报告
//   --report=<文件或目录>                        指定报告（可多个）
//   --all-reports                               用目录里所有 probe-libs-*.txt
//   --library="LASS|MSB"                        只看匹配的库
//   --write                                     写进成果库

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { EXIT, SKILL_DATA, bullet, dbPath, parseArgs, parseMachineBlock, readCsv, recordFindings, reportsDir, tableText, workspaceDir } from "./lib.mjs"

const args = parseArgs()
const repDir = reportsDir(args)

// ---------------------------------------------------------------- 找报告
function reportFiles() {
  const given = args.getAll("report").filter(Boolean).map((p) => resolve(p))
  const out = []
  for (const g of given) {
    if (!existsSync(g)) continue
    if (statSync(g).isDirectory()) {
      for (const f of readdirSync(g)) if (/^probe-libs-.*\.txt$/i.test(f)) out.push(join(g, f))
    } else out.push(g)
  }
  if (!given.length) {
    if (!existsSync(repDir)) return []
    const all = readdirSync(repDir).filter((f) => /^probe-libs-.*\.txt$/i.test(f)).map((f) => join(repDir, f))
    if (args.bool("all-reports")) return all
    // 默认：最新那一套（同一次运行的前缀相同，取最新时间戳那一组）
    const stamp = (f) => (/probe-libs-\d+-(\d+)\.txt$/i.exec(f) ?? [])[1] ?? ""
    const times = [...new Set(all.map(stamp))].sort()
    const latest = times[times.length - 1]
    return all.filter((f) => stamp(f) === latest)
  }
  return out
}

const files = reportFiles()
if (!files.length) {
  console.error(`[用法] 没找到读库报告（${repDir}\\probe-libs-*.txt）—— 先 kontakt_probe_libraries`)
  process.exit(EXIT.USAGE)
}
files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

// ---------------------------------------------------------------- 路径 → 库名
const db = dbPath(args)
const byPath = new Map()
if (existsSync(db)) {
  for (const r of readCsv(db)) byPath.set(String(r.Path).replace(/\\/g, "/").toLowerCase(), r.Library)
}

// ---------------------------------------------------------------- 名字 → 候选字段
const clean = (s) =>
  String(s)
    .replace(/^[\s\d.#]*/, "") // 去掉 "00 " / "#3 " 这类序号前缀
    .replace(/[\s._-]+$/, "")
    .trim()

function candidates(name) {
  const out = []
  const raw = String(name)
  const pipes = raw.split("|").map((s) => s.trim())
  if (pipes.length > 1) out.push({ how: "末段(|)", v: clean(pipes[pipes.length - 1]) })
  const dash = raw.split(/\s+-\s+/)
  if (dash.length > 1) out.push({ how: "末段(-)", v: clean(dash[dash.length - 1]) })
  const words = raw.trim().split(/\s+/)
  if (words.length > 1) {
    out.push({ how: "首词", v: clean(words[0]) })
    out.push({ how: "末词", v: clean(words[words.length - 1]) })
  }
  // 连写名字（Performance Samples 常见）：前 2/3 个字母是麦克风
  const compact = raw.replace(/[^A-Za-z0-9]/g, "")
  if (compact.length >= 3) {
    out.push({ how: "前2字母", v: compact.slice(0, 2) })
    out.push({ how: "前3字母", v: compact.slice(0, 3) })
  }
  return out
}

function tally(rows, pick) {
  const counts = new Map()
  let hit = 0
  for (const r of rows) {
    const v = pick(r)
    if (!v) continue
    hit++
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const vals = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return { vals, hit, cover: rows.length ? hit / rows.length : 0 }
}

// 一个"维度"好不好：覆盖高、取值 2..20 个、不是每个 group 一个值
function judge(dim) {
  const n = dim.vals.length
  if (dim.cover < 0.6) return -1
  if (n < 2 || n > 20) return -1
  const share = dim.cover / n // 每个取值平均占比
  return dim.cover * 10 + Math.min(share, 0.3) * 20 - n * 0.05
}

// ---------------------------------------------------------------- 逐报告扫
const perLib = new Map() // lib → Map(how → Map(value → count))
let nPatch = 0
for (const file of files) {
  const text = readFileSync(file, "utf8")
  const secs = [...text.matchAll(/^=+ \[(\d+)\/(\d+)\] (.+?)\s*$/gm)].map((m) => ({ i: Number(m[1]), path: m[3].trim() }))
  for (const s of secs) {
    const groups = parseMachineBlock(text, `GROUPS${s.i}`) ?? []
    if (!groups.length) continue
    const lib = byPath.get(s.path.replace(/\\/g, "/").toLowerCase()) ?? s.path.split("/").slice(0, -2).join("/")
    if (!perLib.has(lib)) perLib.set(lib, { patches: [], dims: new Map() })
    const rec = perLib.get(lib)
    rec.patches.push({ path: s.path, n: groups.length })
    nPatch++
    for (const how of ["末段(|)", "末段(-)", "首词", "末词", "前2字母", "前3字母"]) {
      const dim = tally(groups, (r) => {
        const c = candidates(r.name).find((x) => x.how === how)
        return c ? c.v : ""
      })
      if (!dim.vals.length) continue
      if (!rec.dims.has(how)) rec.dims.set(how, new Map())
      const acc = rec.dims.get(how)
      for (const [v, c] of dim.vals) acc.set(v, (acc.get(v) ?? 0) + c)
    }
  }
}

const want = args
  .get("library", "")
  .split(/[|,]/)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

console.log(bullet(`从报告里挖麦克风维度 —— ${files.length} 份报告 / ${nPatch} 个 patch`))
console.log(files.map((f) => `  ${f.split(/[\\/]/).pop()}`).join("\n"))

const conclusions = []
for (const [lib, rec] of perLib) {
  if (want.length && !want.some((w) => lib.toLowerCase().includes(w))) continue
  const total = rec.patches.reduce((a, p) => a + p.n, 0)
  const ranked = []
  for (const [how, acc] of rec.dims) {
    const vals = [...acc.entries()].sort((a, b) => b[1] - a[1])
    const hit = vals.reduce((a, [, c]) => a + c, 0)
    const dim = { how, vals, hit, cover: total ? hit / total : 0 }
    dim.score = judge(dim)
    ranked.push(dim)
  }
  ranked.sort((a, b) => b.score - a.score)
  const only = args.get("how", "")
  const best = (only ? ranked.filter((d) => d.how === only) : ranked.filter((d) => d.score > 0)).slice(0, args.num("top", 2))
  conclusions.push({ lib, total, patches: rec.patches, best, dims: rec.dims })
}

conclusions.sort((a, b) => a.lib.localeCompare(b.lib))
for (const c of conclusions) {
  console.log(`\n=== ${c.lib}　（${c.patches.length} 个 patch / ${c.total} 个 group）`)
  for (const p of c.patches.slice(0, 3)) console.log(`    · ${p.path.split(/[\\/]/).pop()}（${p.n} group）`)
  if (!c.best.length && !args.bool("dump")) {
    console.log(`    ⚠ 没挖到明显的麦克风维度（名字里可能没有麦克风，例如只有一个混音）`)
    continue
  }
  if (args.bool("dump")) {
    // 把每个萃取器的取值全列出来（不排名）——人眼看名字结构用
    for (const [how, acc] of c.dims) {
      const vals = [...acc.entries()].sort((a, b) => b[1] - a[1])
      if (!vals.length) continue
      console.log(`    · [${how}] ${vals.length} 种：` + vals.slice(0, 16).map(([v, n]) => `${v}×${n}`).join("  ") + (vals.length > 16 ? " …" : ""))
    }
    continue
  }
  for (const d of c.best) {
    const vals = d.vals.slice(0, 12).map(([v, n]) => `${v}×${n}`).join("  ")
    console.log(`    ▸ [${d.how}] 覆盖 ${(d.cover * 100).toFixed(0)}%　取值 ${d.vals.length}：${vals}${d.vals.length > 12 ? " …" : ""}`)
  }
}

if (args.bool("write")) {
  let n = 0
  for (const c of conclusions) {
    const best = c.best.find((d) => d.how) ?? null
    const prev = best ? Object.fromEntries(best.vals.map(([v, k]) => [v, k])) : null
    const key = recordFindings(c.lib, {
      mic_tokens: best ? Object.fromEntries(best.vals.map(([v, k]) => [v, k])) : {},
      mic_dimension: best ? best.how : null,
      mic_coverage: best ? Number(best.cover.toFixed(3)) : null,
      mic_mined_from: c.patches.slice(0, 2).map((p) => p.path),
      mic_mined_at: new Date().toISOString().slice(0, 10),
    })
    n++
    if (prev) console.log(`  ${key}: ${best.how} → ${Object.keys(prev).slice(0, 10).join(", ")}`)
  }
  console.log(`\n已写进成果库 ${n} 个库的 mic_tokens（kontakt_findings 查）`)
} else {
  console.log(`\n（只看不写 —— 满意的话加 --write）`)
}

// 汇总一张速查表
console.log("\n" + bullet("速查"))
console.log(
  tableText(
    ["库", "维度", "取值数", "覆盖", "取值"],
    conclusions.map((c) => {
      const d = c.best[0]
      return {
        库: c.lib.slice(0, 36),
        维度: d ? d.how : "—",
        取值数: d ? d.vals.length : 0,
        覆盖: d ? `${(d.cover * 100).toFixed(0)}%` : "—",
        取值: d ? d.vals.slice(0, 6).map(([v]) => v).join(" ") : "—",
      }
    }),
  ),
)
process.exit(EXIT.OK)
