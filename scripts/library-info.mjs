// scripts/library-info.mjs —— 库总表（秒级，**不启动 Kontakt**）
//
// ⛔ 维护提醒：这个仓库的中文文件**不要用 PowerShell 的 Get-Content/Set-Content/-replace 改**
//    （PS 5.1 按 ANSI 读、按 UTF-8+BOM 写，中文会变乱码；本项目已踩三次）。一律用编辑工具改。
//
// 拿三样东西：
//   ① `.nicnt` 里的**明文 XML**：正式库名 / 厂牌 / 授权系统（RAS2 / RAS3 / 无）/ SNPID / 大小
//   ② patch 与目录形态：nki 数、采样文件数（有没有 _Advanced_ 之类变体目录要另外看）
//   ③ 采样形态：松散采样（.wav/.ncw）vs 打包（.nkx）→ **弱先验**
//
// ⚠️ **`AuthSystem` 和 `.nkx` 都不能判定"是否加密"**：实测 Performance Samples 是 RAS3 却未加密、
//    group 音量能存住。加密与否只能靠探测（脚本 protected + 音量是否存活）。本工具给的是先验与总表。
//
// 用法：--merge 把结果写进成果库（data/findings.json）

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { EXIT, bullet, detectLibraryRoots, loadConfig, parseArgs, recordFindings, tableText } from "./lib.mjs"

const args = parseArgs()
const cfg = loadConfig()
const explicit = args.getAll("root").filter(Boolean)
const fromCfg = (cfg.scan_roots ?? []).map((r) => r.path).filter(Boolean)
const roots = explicit.length ? explicit : fromCfg.length ? fromCfg : detectLibraryRoots().map((r) => r.path)
if (!roots.length) {
  console.error("[用法] 没有扫描根：给 --root=…，或在 config/libraries.json 里配 scan_roots")
  process.exit(EXIT.USAGE)
}
console.log(`扫描根（${explicit.length ? "参数" : fromCfg.length ? "config" : "自动探测"}）：${roots.join("　")}`)

const grab = (text, tag) => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text)
  return m ? m[1].trim() : ""
}

function countExt(dir, depth = 3) {
  const out = { nkx: 0, ncw: 0, wav: 0, nki: 0 }
  const walk = (d, k) => {
    if (k > depth) return
    let es = []
    try {
      es = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (e.isSymbolicLink()) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, k + 1)
      else {
        const x = e.name.toLowerCase()
        if (x.endsWith(".nkx")) out.nkx++
        else if (x.endsWith(".ncw")) out.ncw++
        else if (x.endsWith(".wav")) out.wav++
        else if (x.endsWith(".nki")) out.nki++
      }
    }
  }
  walk(dir, 0)
  return out
}

const rows = []
for (const root of roots) {
  let libs = []
  try {
    libs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    continue
  }
  for (const lib of libs) {
    const dir = join(root, lib)
    let nicnts = []
    try {
      nicnts = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".nicnt"))
    } catch {
      continue
    }
    for (const f of nicnts) {
      const p = join(dir, f)
      const buf = readFileSync(p)
      const text = buf.subarray(0, Math.min(buf.length, 65536)).toString("latin1")
      const cnt = countExt(dir)
      rows.push({
        目录: lib,
        根: root,
        正式名: grab(text, "Name"),
        厂牌: grab(text, "Company"),
        授权: grab(text, "AuthSystem") || "无",
        SNPID: grab(text, "SNPID"),
        nki: cnt.nki,
        nkx: cnt.nkx,
        ncw: cnt.ncw,
        wav: cnt.wav,
        "nicnt MB": (statSync(p).size / 1048576).toFixed(2)
      })
    }
  }
}

rows.sort((a, b) => a.授权.localeCompare(b.授权) || a.目录.localeCompare(b.目录))
console.log(bullet(`库总表 —— ${rows.length} 个库（不需要 Kontakt）`))
console.log(
  tableText(
    ["目录", "授权", "厂牌", "正式名", "SNPID", "nki", "nkx", "ncw", "wav"],
    rows.slice(0, 118).map((r) => ({ ...r, 目录: r.目录.slice(0, 34), 正式名: String(r.正式名).slice(0, 28) })),
  ),
)
if (rows.length > 118) console.log(`… 还有 ${rows.length - 118} 行`)

const byAuth = {}
for (const r of rows) byAuth[r.授权] = (byAuth[r.授权] ?? 0) + 1
console.log(`\n授权系统分布：${Object.entries(byAuth).map(([k, v]) => `${k} × ${v}`).join("　")}`)
console.log(`
怎么读：
  · 授权 = "无" → 没有授权登记 → **大概率非 Player**（可以直接写 group 音量）。
  · 松散采样多（wav/ncw）→ 大概率非 Player；全 .nkx → 打包，**倾向 Player**。
  · ⚠️ 两者都是**弱先验**：实测 Performance Samples 是 RAS3 却未加密。**"是否加密"只能探测**（每库一次）。

写进成果库：加 --merge（把 正式名/厂牌/授权/SNPID/采样形态 并进 findings.json）`)

if (args.bool("merge")) {
  let n = 0
  for (const r of rows) {
    recordFindings(r.目录, {
      nicnt: { name: r.正式名, company: r.厂牌, auth_system: r.授权, snpid: r.SNPID },
      patch_counts: { nki: r.nki, nkx: r.nkx, ncw: r.ncw, wav: r.wav },
      kind_prior: r.授权 === "无" ? "likely-unencrypted" : r.nkx > 0 && r.ncw === 0 && r.wav === 0 ? "likely-player" : "unknown",
      kind_prior_note: "弱先验：AuthSystem 与采样形态都不能判定加密；kind 要靠探测"
    })
    n++
  }
  console.log(`\n[ OK ] ${n} 个库的先验信息已合并进 data/findings.json`)
}
process.exit(EXIT.OK)
