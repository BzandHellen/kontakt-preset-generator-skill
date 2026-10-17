// scripts/snapshot.mjs —— .nksn 只读体检
//
// 加密库的麦克风/技法设置只能靠 snapshot 承载，而 snapshot 里到底装了什么，一直没人看过。
// 实测结论：**.nksn 不是加密的** —— 是明文参数容器，参数名大部分可读、一部分被混淆。
// 这个工具只做「读」：给一份或几份 snapshot 列出可读参数名、关键词命中、两份之间的差异。
// **绝不修改 snapshot**（改了会破坏 NI 的格式与校验）。
//
// 用法：
//   --file=<a.nksn> [--file=<b.nksn> ...]   ← 给两份以上会自动做名字集合差异
//   --find=ks,articulation,xfade,mic        关键词（大小写不敏感子串）
//   --limit=60                              每类列多少条

import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import { EXIT, bullet, humanSize, parseArgs, tableText } from "./lib.mjs"

const args = parseArgs()
const files = args.getAll("file").filter(Boolean).map((f) => resolve(f))
if (!files.length) {
  console.error("[用法] 要 --file=<某个 .nksn>（可多个）")
  process.exit(EXIT.USAGE)
}
const bad = files.filter((f) => !existsSync(f))
if (bad.length) {
  console.error(`[用法] 这些文件不存在：\n  ${bad.join("\n  ")}`)
  process.exit(EXIT.USAGE)
}

const limit = args.num("limit", 60)
const find = args
  .get("find", "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

const DEFAULT_FIND = [
  "ks", "keyswitch", "key_switch", "switch", "articulation", "xfade", "legato", "velocity", "vel",
  "dyn", "mic", "mix", "release", "attack", "volume", "pan", "tune", "slot", "bank", "purge",
]
const keywords = find.length ? find : DEFAULT_FIND

// ---------------------------------------------------------------- 读
function readNames(buf, min = 4) {
  const out = []
  let cur = ""
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f
    if (ok) cur += String.fromCharCode(c)
    else {
      if (cur.length >= min) out.push(cur)
      cur = ""
    }
  }
  if (cur.length >= min) out.push(cur)
  return [...new Set(out)]
}

function entropy(buf) {
  const counts = new Array(256).fill(0)
  const step = Math.max(1, Math.floor(buf.length / 300000))
  let n = 0
  for (let i = 0; i < buf.length; i += step) {
    counts[buf[i]]++
    n++
  }
  let h = 0
  for (const c of counts) if (c) {
    const p = c / n
    h -= p * Math.log2(p)
  }
  return h
}

function magicOf(buf) {
  const head = [...buf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ")
  for (const [name, mag] of [
    ["zstd", [0x28, 0xb5, 0x2f, 0xfd]],
    ["gzip", [0x1f, 0x8b]],
    ["zip", [0x50, 0x4b, 0x03, 0x04]],
    ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a]],
    ["7z", [0x37, 0x7a, 0xbc, 0xaf]],
  ]) {
    if (buf.indexOf(Buffer.from(mag)) >= 0) return `${head}（含 ${name} 帧）`
  }
  return head
}

const reports = files.map((f) => {
  const st = statSync(f)
  const buf = readFileSync(f)
  const names = readNames(buf)
  const lower = names.map((s) => s.toLowerCase())
  const hits = names.filter((s, i) => keywords.some((k) => lower[i].includes(k)))
  const engine = names.filter((s) => /^[A-Z][A-Z0-9_]{3,}$/.test(s))
  const semantic = names.filter((s) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s) && !/^[A-Z][A-Z0-9_]{3,}$/.test(s) && s.length >= 5)
  const obfuscated = names.filter((s) => /^[a-z]{4,6}$/.test(s))
  return { path: f, name: basename(f), size: st.size, head: magicOf(buf), H: entropy(buf), names, hits, engine, semantic, obfuscated }
})

// ---------------------------------------------------------------- 报告
if (args.bool("json")) {
  console.log(
    JSON.stringify(
      reports.map((r) => ({ file: r.name, size: r.size, head: r.head, entropy: Number(r.H.toFixed(3)), hits: r.hits, names: r.names.length })),
      null,
      2,
    ),
  )
  process.exit(EXIT.OK)
}

console.log(bullet("snapshot 体检（只读，不修改）"))
console.log(
  tableText(
    ["文件", "大小", "熵/8", "可读参数名", "关键词命中"],
    reports.map((r) => ({ 文件: r.name, 大小: humanSize(r.size), "熵/8": r.H.toFixed(2), 可读参数名: r.names.length, 关键词命中: r.hits.length })),
  ),
)
console.log(`\n熵：接近 8 = 已加密/压缩；6–7 附近 = 明文结构为主。`.trim())

for (const r of reports) {
  console.log(bullet(`${r.name}　${humanSize(r.size)}　头部 ${r.head}`))
  console.log(`关键词（${keywords.join(", ")}）命中 ${r.hits.length} 条：`)
  console.log(r.hits.length ? `  ${r.hits.slice(0, limit).join(", ")}` : "  （无）")

  console.log(`\n引擎样式的大写参数名（${r.engine.length} 条）：`)
  console.log(r.engine.length ? `  ${r.engine.slice(0, limit).join(", ")}` : "  （无）")

  console.log(`\n语义词（${r.semantic.length} 条）：`)
  console.log(r.semantic.length ? `  ${r.semantic.slice(0, limit).join(", ")}` : "  （无）")

  console.log(`\n疑似被混淆的短 token（${r.obfuscated.length} 条）：`)
  console.log(r.obfuscated.length ? `  ${r.obfuscated.slice(0, 20).join(", ")}…` : "  （无）")
}

// ---------------------------------------------------------------- 两份以上做差异
if (reports.length >= 2) {
  console.log(bullet(`名字集合差异（${reports.length} 份）`))
  const base = reports[0]
  for (const r of reports.slice(1)) {
    const a = new Set(base.names)
    const b = new Set(r.names)
    const onlyA = [...a].filter((x) => !b.has(x))
    const onlyB = [...b].filter((x) => !a.has(x))
    console.log(`\n---- ${base.name}  ↔  ${r.name}`)
    console.log(`只在前者（${onlyA.length}）：${onlyA.slice(0, 30).join(", ") || "（无）"}`)
    console.log(`只在后者（${onlyB.length}）：${onlyB.slice(0, 30).join(", ") || "（无）"}`)
  }
}

console.log(`
怎么用这个结果：
  · 关键词里有 articulation / legato / xfade / mic / dyn，说明这份 snapshot 里确实带着这些块
    —— 但它**不能告诉你具体值**（值在混淆段里），也不能安全地改。
  · 所以 KS 键位 / xfade→velocity 这类**库 UI 开关**，唯一落地手段仍是：
    人在 GUI 里调一次 → 存 snapshot → apply_snapshot 套到全库。
  · 两份对比用来看「你的标准状态有没有变」，不是用来 patch 字节。`)
process.exit(EXIT.OK)
