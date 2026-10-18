// scripts/group-persist.mjs —— 验证"这个库的 group 音量能不能存住"（库无关的批量测试）
//
// 做法：对每个 patch 把所有 group 设成固定 dB → 存 multi → 重载 → 再读一遍。
//   存活 = 重载后全 ≈ 该 dB（→ 这个库的麦克风可以**全自动写 group 音量**）
//   复位 = 回到原值（→ 只能走 snapshot）
// 结论写进成果库的 group_volume_persists。
//
// 默认只测成果库里 kind 为 unencrypted / 未知的库（加密的已知写不住，没必要测）。
//
// 用法：--library="LASS|Modern Scoring"  只测匹配的库　--db=-12　--chunk=6　--dry-run
//       --patch=<绝对路径>（可多个）　　直接点名要测的 patch（测"这一批 patch"能不能存住）

import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { EXIT, bullet, dbPath, launchKontakt, loadFindings, matchLibraryKey, parseArgs, parseMachineBlock, preflight, readCsv, recordFindings, reportsDir, tableText } from "./lib.mjs"
import { renderJob } from "./job.mjs"

const args = parseArgs()
const repDir = reportsDir(args)
const db = dbPath(args)
if (!existsSync(db)) {
  console.error(`[用法] 没有库索引（${db}）—— 先 kontakt_db_build`)
  process.exit(EXIT.USAGE)
}
const testDb = args.num("db", -12)
const perLib = args.num("per-library", 1)
const chunkSize = args.num("chunk", 6)
const timeoutS = args.num("timeout", 600)
const findings = loadFindings()

const want = args
  .get("library", "")
  .split(/[|,]/)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
const onlyUnenc = !want.length && !args.bool("all")

const rows = readCsv(db).filter((r) => String(r.Ext) === ".nki")
const byLib = new Map()
for (const r of rows) {
  const lib = r.Library
  if (want.length) {
    if (!want.some((w) => lib.toLowerCase().includes(w))) continue
  } else if (onlyUnenc) {
    const key = matchLibraryKey(findings, lib)
    const kind = key ? findings.libraries[key].kind : undefined
    if (kind === "player-encrypted") continue // 已知写不住，跳过
  }
  if (!byLib.has(lib)) byLib.set(lib, [])
  byLib.get(lib).push(r)
}

// 每库挑代表 patch：优先名字里带常见弦乐/主乐器的，其次最浅的
const PREFER = /(legato|sustain|longs?|sus|ensemble|main|violins?|vl ?1)/i
const direct = args.getAll("patch").filter(Boolean).map((p) => resolve(p))
const picks = []
if (direct.length) {
  // 直接点名的 patch（测"这一类 patch"能不能存住，例如 LASS 的 legacy 分技法 patch）
  for (const p of direct) {
    const hit = rows.find((r) => String(r.Path).replace(/\\/g, "/").toLowerCase() === p.replace(/\\/g, "/").toLowerCase())
    picks.push({ lib: hit ? hit.Library : "(指定)", path: p.replace(/\\/g, "/"), patch: hit ? hit.PatchFile : p.split(/[\\/]/).pop() })
  }
} else {
  for (const [lib, list] of byLib) {
    const byDepth = [...list].sort((a, b) => a.Path.split("/").length - b.Path.split("/").length || a.Path.localeCompare(b.Path))
    const preferred = byDepth.filter((r) => PREFER.test(r.PatchFile))
    const chosen = (preferred.length ? preferred : byDepth).slice(0, perLib)
    for (const r of chosen) picks.push({ lib, path: r.Path, patch: r.PatchFile })
  }
}

console.log(bullet(`group 音量持久化测试 —— ${byLib.size} 个库 / ${picks.length} 个代表 patch（全设 ${testDb} dB）`))
console.log(
  tableText(
    ["库", "代表 patch"],
    picks.map((p) => ({ 库: p.lib.slice(0, 40), "代表 patch": p.patch.slice(0, 48) })),
  ).split("\n").slice(0, 40).join("\n"),
)
if (picks.length > 38) console.log(`… 还有 ${picks.length - 38} 行`)
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

const outDir = args.get("out-dir", "C:/VEPRO/Kontakt Patch/Generated/_test/persist/")
mkdirSync(outDir, { recursive: true }) // ⚠️ Kontakt 的 save_multi 不会自己建目录，必须先建
console.log(`产物目录：${outDir}`)
const chunks = []
for (let i = 0; i < picks.length; i += chunkSize) chunks.push(picks.slice(i, i + chunkSize))

const summary = []
let ci = 0
for (const chunk of chunks) {
  ci++
  const report = `${repDir}/group-persist-${ci}-${Date.now()}.txt`.replace(/\\/g, "/")
  const job = { db: testDb, outdir: outDir, report, patches: chunk.map((c) => c.path.replace(/\\/g, "/")) }
  const rendered = renderJob("job_group_persist.lua", job, { args, slug: `group-persist-${ci}` })
  console.log(`\n第 ${ci}/${chunks.length} 块（${chunk.length} 个库）：启动 Kontakt…`)
  const res = await launchKontakt({ exe: pf.exe, script: rendered.file, timeoutS, explicitReport: report, reportsDirPath: repDir, killOnTimeout: args.bool("kill-on-timeout") })
  if (!res.reportPath) {
    console.log(`  ⛔ 没拿到报告（超时=${res.timedOut}）`)
    for (const c of chunk) summary.push({ 库: c.lib, 结果: "无报告" })
    continue
  }
  const block = parseMachineBlock(res.reportText, "PERSIST") ?? []
  for (const row of block) {
    const pick = chunk[Number(row.i) - 1]
    if (!pick) continue
    const state = row.persisted === "yes" ? "✅ 能存住" : row.persisted === "no" ? "❌ 复位" : row.persisted === "save-failed" ? "⛔ 存不进去（Kontakt 侧拒绝写盘）" : "⚠️ 判不了"
    if (row.persisted === "yes" || row.persisted === "no") {
      recordFindings(pick.lib, {
        group_volume_persists: row.persisted === "yes",
        group_volume_test: {
          db: testDb,
          groups: Number(row.groups) || 0,
          before: `${row.before_min} … ${row.before_max}`,
          after_reload: `${row.after_min} … ${row.after_max}`,
          tested_from: pick.path,
          at: new Date().toISOString().slice(0, 10)
        }
      })
    }
    summary.push({
      库: pick.lib.slice(0, 34),
      结果: state,
      group: row.groups,
      写之前: Number.isFinite(Number(row.before_min)) && row.before_min !== "" ? Number(row.before_min).toFixed(4) : "—",
      重载后: Number.isFinite(Number(row.after_min)) && row.after_min !== "" ? Number(row.after_min).toFixed(4) : "—"
    })
  }
  console.log(`  完成（${(res.ms / 1000).toFixed(0)}s）`)
}

console.log(bullet("结论"))
console.log(tableText(["库", "结果", "group", "写之前(min)", "重载后(min)"], summary.map((s) => ({ 库: s.库, 结果: s.结果, group: s.group, "写之前(min)": s.写之前, "重载后(min)": s.重载后 }))))
const ok = summary.filter((s) => s.结果.includes("能存住")).length
const bad = summary.filter((s) => s.结果.includes("复位")).length
const blocked = summary.filter((s) => s.结果.includes("存不进去")).length
console.log(`\n共 ${summary.length} 个库：能存住 ${ok}　复位 ${bad}　**存不进去 ${blocked}**　判不了 ${summary.length - ok - bad - blocked}`)
console.log(`已写进成果库 group_volume_persists（kontakt_findings 查）`)
process.exit(EXIT.OK)
