// scripts/load-test.mjs —— 装载体检：这一批 .nki 哪个装得开（区分"库的问题"和"文件坏了"）
//
// 只做 load_instrument，不扫 zone、不读参数 → 快。
// 用途：某几个库有 0 字节文件时，先跑这个拿到**到底哪几个 patch 不能用**；
//       也可以拿它快速验证"这个库的这批 patch 都还在不在"。
//
// 用法：
//   --library="Vista|Caspian"      库名子串（竖线/逗号分隔）
//   --folder="Synth\\3 - Bass"     路径子串（正则）
//   --patch=<绝对路径>             直接点名（可多个）
//   --skip="Vista"                 跳过匹配的 patch（正则，按 库名+路径；坏采样的库先跳开）
//   --limit=200                    最多测几个（默认 200）
//   --chunk=40                     一次进程几个（默认 40）
//   --write                        结论写进成果库（load_test）

import { existsSync } from "node:fs"
import { EXIT, bullet, dbPath, launchKontakt, parseArgs, parseMachineBlock, preflight, readCsv, recordFindings, reportsDir, tableText } from "./lib.mjs"
import { renderJob } from "./job.mjs"

const args = parseArgs()
const repDir = reportsDir(args)
const db = dbPath(args)
const timeoutS = args.num("timeout", 900)
const limit = args.num("limit", 200)
const chunkSize = args.num("chunk", 40)

const direct = args.getAll("patch").filter(Boolean)
const want = args.get("library", "").split(/[|,]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
const folder = args.get("folder", "")
let folderRe = null
if (folder) {
  try {
    folderRe = new RegExp(folder, "i")
  } catch (e) {
    console.error(`[用法] --folder 不是合法正则：${e.message}`)
    process.exit(EXIT.USAGE)
  }
}

let picks = []
if (direct.length) {
  picks = direct.map((p) => ({ lib: "(直接指定)", path: p.replace(/\\/g, "/") }))
} else {
  if (!existsSync(db)) {
    console.error(`[用法] 没有库索引（${db}）—— 先 kontakt_db_build，或直接给 --patch`)
    process.exit(EXIT.USAGE)
  }
  const rows = readCsv(db).filter((r) => String(r.Ext) === ".nki")
  if (!want.length && !folderRe) {
    console.error(`[用法] 至少给一个范围：--library=<库名> 或 --folder=<正则> 或 --patch=<文件>`)
    process.exit(EXIT.USAGE)
  }
  picks = rows
    .filter((r) => (!want.length || want.some((w) => String(r.Library).toLowerCase().includes(w))) && (!folderRe || folderRe.test(String(r.Path))))
    .map((r) => ({ lib: r.Library, path: String(r.Path).replace(/\\/g, "/"), rel: `${r.RelDir}/${r.PatchFile}` }))
}
// ⚠️ 坏采样的库要跳过：Kontakt 会弹模态框「Sample could not be loaded」，脚本就停在那儿等回答 →
// 整块超时、**同块里其它 patch 的结果也一起丢**。要测就 --skip 掉，或者重下库之后再测。
const skip = args.get("skip", "")
if (skip) {
  let re = null
  try {
    re = new RegExp(skip, "i")
  } catch (e) {
    console.error(`[用法] --skip 不是合法正则：${e.message}`)
    process.exit(EXIT.USAGE)
  }
  const before = picks.length
  const skipped = picks.filter((p) => re.test(`${p.lib} ${p.rel ?? ""} ${p.path}`))
  picks = picks.filter((p) => !re.test(`${p.lib} ${p.rel ?? ""} ${p.path}`))
  if (skipped.length) {
    console.log(bullet(`⚠ 跳过 ${skipped.length} 个（--skip=${skip}）—— 这些多半有 0 字节采样，装载会弹模态框阻塞脚本`))
    for (const p of skipped.slice(0, 12)) console.log(`   · ${p.lib} → ${p.rel ?? p.path}`)
    if (skipped.length > 12) console.log(`   … 还有 ${skipped.length - 12} 个`)
  }
  if (!picks.length) {
    console.log(`（全被跳过了：${before} 个）`)
    process.exit(EXIT.OK)
  }
}
picks = picks.slice(0, limit)

console.log(bullet(`装载体检 —— ${picks.length} 个 patch`))
console.log(tableText(["库", "patch"], picks.slice(0, 25).map((p) => ({ 库: String(p.lib).slice(0, 30), patch: (p.rel ?? p.path).slice(0, 60) }))).split("\n").slice(0, 28).join("\n"))
if (picks.length > 25) console.log(`… 还有 ${picks.length - 25} 个`)

if (args.bool("dry-run")) {
  console.log("\n（--dry-run：没启动 Kontakt）")
  process.exit(EXIT.OK)
}

const pf = preflight(args)
if (pf.notes.length) console.log(`\n注意：${pf.notes.join("；")}`)
if (pf.problems.length) {
  console.error(`[环境] ${pf.problems.join("；")}`)
  process.exit(EXIT.ENV)
}

const chunks = []
for (let i = 0; i < picks.length; i += chunkSize) chunks.push(picks.slice(i, i + chunkSize))

const all = []
let ci = 0
for (const chunk of chunks) {
  ci++
  const report = `${repDir}/load-test-${ci}-${Date.now()}.txt`.replace(/\\/g, "/")
  const job = { report, patches: chunk.map((c) => c.path) }
  const rendered = renderJob("job_load_test.lua", job, { args, slug: `load-test-${ci}` })
  console.log(`\n第 ${ci}/${chunks.length} 块（${chunk.length} 个）：启动 Kontakt…`)
  const res = await launchKontakt({ exe: pf.exe, script: rendered.file, timeoutS, explicitReport: report, reportsDirPath: repDir, killOnTimeout: args.bool("kill-on-timeout") })
  if (!res.reportPath) {
    console.log(
      `  ⛔ 没拿到报告（超时=${res.timedOut}）` +
        (res.timedOut ? `\n     —— 多半是某个 patch 弹了「Sample could not be loaded (file seems to be corrupted)」模态框，\n` +
          `        脚本停在弹框上等回答 → 整块超时，**这一块所有 patch 的结果都丢了**。\n` +
          `        对策：给这批加 --skip=<坏采样的库>，或者把库重下后再测。\n` +
          `        ${res.killed ? "（已按 --kill-on-timeout 把这次起的 Kontakt 掐掉）" : "（超时不掐进程，可能还留着）"}` : ""),
    )
    for (const c of chunk) all.push({ lib: c.lib, rel: c.rel ?? c.path, loaded: res.timedOut ? "挂住(弹框?)" : "无报告", name: "", groups: "", scripts: "", path: c.path })
    continue
  }
  const loads = parseMachineBlock(res.reportText, "LOADS") ?? []
  const byI = new Map(loads.map((r) => [Number(r.i), r]))
  for (let k = 1; k <= chunk.length; k++) {
    const c = chunk[k - 1]
    const r = byI.get(k)
    all.push({
      lib: c.lib,
      rel: c.rel ?? c.path,
      loaded: r ? (r.loaded === "yes" ? "能装" : "装不上") : "无数据",
      name: String(r?.name ?? ""),
      groups: String(r?.groups ?? ""),
      scripts: String(r?.scripts ?? ""),
      path: c.path,
    })
  }
  const bad = all.filter((r) => r.loaded === "装不上").length
  console.log(`  完成（${(res.ms / 1000).toFixed(0)}s，累计装不上 ${bad}）`)
}

console.log(bullet("结果"))
console.log(tableText(["库", "patch", "结果", "乐器名", "group"], all.map((r) => ({ 库: String(r.lib).slice(0, 26), patch: String(r.rel).slice(0, 46), 结果: r.loaded, 乐器名: String(r.name).slice(0, 22), group: r.groups }))))

const bad = all.filter((r) => r.loaded !== "能装")
const okN = all.filter((r) => r.loaded === "能装").length
console.log(`\n共 ${all.length} 个：能装 ${okN}　装不上 ${bad.length}`)
if (bad.length) {
  console.log(`\n装不上的：`)
  for (const r of bad) console.log(`  [${r.loaded}] ${r.lib} → ${r.rel}`)
}

if (args.bool("write")) {
  const byLib = new Map()
  for (const r of all) {
    if (!byLib.has(r.lib)) byLib.set(r.lib, { ok: 0, fail: [], total: 0 })
    const a = byLib.get(r.lib)
    a.total++
    if (r.loaded === "能装") a.ok++
    else a.fail.push(r.rel)
  }
  for (const [lib, a] of byLib) {
    const key = recordFindings(lib, {
      load_test: { at: new Date().toISOString().slice(0, 10), checked: a.total, ok: a.ok, failed: a.fail },
    })
    console.log(`  写进成果库：${key}（${a.ok}/${a.total} 能装）`)
  }
} else {
  console.log(`\n（没写成果库 —— 要写加 --write）`)
}
process.exit(bad.length ? EXIT.ISSUES : EXIT.OK)
