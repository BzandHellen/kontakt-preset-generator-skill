// scripts/reports.mjs —— 把 Reports\*.txt 归约成看得懂的体检表
//
// 脚本自己写的报告是「无人值守时唯一的输出」（终端可能看不到），这个工具负责把它们汇总。
//   list      默认：每个报告一行（标题 / 时间 / OK / FAIL）
//   read      --file=<名字或路径>：打印一份报告的段落与 FAIL 明细
//   summarize --write：写 Reports/manifest.verify.csv（已存在要 --force）

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { EXIT, bullet, mtimeText, parseArgs, reportsDir, tableText, writeCsv } from "./lib.mjs"

const args = parseArgs()
const dir = reportsDir(args)

if (!existsSync(dir)) {
  console.error(`[用法] 没有报告目录：${dir}`)
  process.exit(EXIT.USAGE)
}

// ---------------------------------------------------------------- 报告解析
const RE_OK = /^\s*\[\s*OK\s*\]\s*(.*)$/
const RE_FAIL = /^\s*\[\s*FAIL\s*\]\s*(.*)$/
const RE_SEC = /^\s*={2,}\s*(.*?)\s*=*\s*$/
const RE_SUB = /^\s*-{3,}\s*(.*?)\s*-*\s*$/

function parseReport(path) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/)
  const sections = []
  let cur = { name: "(开头)", rows: [], text: [] }
  sections.push(cur)
  const oks = []
  const fails = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let m
    if ((m = RE_SEC.exec(t))) {
      cur = { name: m[1] || "(无标题段)", rows: [], text: [] }
      sections.push(cur)
      continue
    }
    if ((m = RE_SUB.exec(t)) && !RE_OK.test(t) && !RE_FAIL.test(t)) {
      cur.text.push(`-- ${m[1]}`)
      continue
    }
    if ((m = RE_OK.exec(t))) {
      const [name, value] = splitArrow(m[1])
      cur.rows.push({ 状态: "OK", name, value })
      oks.push(name)
      continue
    }
    if ((m = RE_FAIL.exec(t))) {
      const [name, value] = splitArrow(m[1])
      cur.rows.push({ 状态: "FAIL", name, value })
      fails.push(`${name} -> ${value}`)
      continue
    }
    cur.text.push(t)
  }
  const title = (() => {
    const first = lines.find((l) => l.trim())?.trim() ?? basename(path)
    const m = RE_SEC.exec(first)
    return m ? m[1] || basename(path) : first
  })()
  return { path, title, sections, oks, fails }
}

function splitArrow(s) {
  const i = s.indexOf("->")
  if (i < 0) return [s.trim(), ""]
  return [s.slice(0, i).trim(), s.slice(i + 2).trim()]
}

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".txt"))
  .map((f) => join(dir, f))

// ---------------------------------------------------------------- read
if (args.has("file")) {
  const want = args.get("file")
  const target = existsSync(want) ? resolve(want) : join(dir, want)
  if (!existsSync(target)) {
    console.error(`[用法] 找不到报告：${want}`)
    process.exit(EXIT.USAGE)
  }
  const r = parseReport(target)
  console.log(bullet(basename(target)))
  console.log(`${r.title}`)
  for (const s of r.sections) {
    if (!s.rows.length && !s.text.length) continue
    console.log(`\n-- ${s.name}`)
    for (const t of s.text) console.log(`   ${t}`)
    if (s.rows.length) console.log(tableText(["状态", "name", "value"], s.rows).split("\n").map((l) => "   " + l).join("\n"))
  }
  const bad = r.sections.flatMap((s) => s.rows.filter((x) => x.状态 === "FAIL")).map((x) => `${x.name} -> ${x.value}`)
  console.log(`\n合计：OK ${r.oks.length} / FAIL ${bad.length}`)
  if (bad.length) console.log(bad.map((b) => `  FAIL ${b}`).join("\n"))
  process.exit(bad.length ? EXIT.ISSUES : EXIT.OK)
}

// ---------------------------------------------------------------- summarize
if (args.bool("summarize") || args.bool("write")) {
  const out = join(dir, args.get("out", "manifest.verify.csv"))
  if (existsSync(out) && !args.bool("force") && !args.bool("overwrite")) {
    console.error(`[用法] 已存在，不覆盖：${out}（要覆盖加 --force）`)
    process.exit(EXIT.USAGE)
  }
  const rows = files.map((f) => {
    const r = parseReport(f)
    const st = statSync(f)
    return {
      File: basename(f),
      MTime: mtimeText(st),
      Title: r.title,
      OK: r.oks.length,
      FAIL: r.fails.length,
      FailDetail: r.fails.join(" | "),
    }
  })
  writeCsv(out, ["File", "MTime", "Title", "OK", "FAIL", "FailDetail"], rows)
  const bad = rows.filter((r) => r.FAIL > 0)
  console.log(bullet("报告汇总"))
  console.log(tableText(["File", "MTime", "Title", "OK", "FAIL"], rows))
  console.log(`\n写入：${out}`)
  console.log(`结论：${bad.length ? `${bad.length} 份报告有 FAIL` : "全部报告无 FAIL"}`)
  process.exit(bad.length ? EXIT.ISSUES : EXIT.OK)
}

// ---------------------------------------------------------------- list
const rows = files.map((f) => {
  const r = parseReport(f)
  const st = statSync(f)
  return {
    File: basename(f),
    MTime: mtimeText(st),
    Title: r.title.slice(0, 60),
    OK: r.oks.length,
    FAIL: r.fails.length,
  }
})
console.log(bullet(`Reports —— ${rows.length} 份（${dir}）`))
if (rows.length) {
  console.log(tableText(["File", "MTime", "Title", "OK", "FAIL"], rows))
  const bad = rows.filter((r) => r.FAIL > 0)
  console.log(`\n结论：${bad.length ? `${bad.length} 份有 FAIL：${bad.map((b) => b.File).join("、")}` : "全部无 FAIL"}`)
} else {
  console.log("（还没有报告）")
}
process.exit(EXIT.OK)
