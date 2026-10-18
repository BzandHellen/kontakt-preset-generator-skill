// scripts/snapshot-diff.mjs —— 两份 .nksn 的**对齐感知差分**（用来"反推"库内参数）
//
// 背景（实测 2026-10-18）：
//   · 首 4 字节 = 整个文件长度（小端 uint32）
//   · 偏移 24..40 = 16 字节，**每次保存都不同** → 疑似 nonce / 校验
//   · 本体是对齐的，两份之间只差 **几字节的增删 + 若干值**
//   → 所以必须**先对齐再比**，否则错位会让"99% 都不同"这种假象出现。
//
// 思路：同一个 patch 只改**一个** UI 开关，各存一份 → 差异那块就是那个参数的存处。
// 只读：不写、不改任何快照。

import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import { EXIT, bullet, humanSize, parseArgs, tableText } from "./lib.mjs"

const args = parseArgs()
const files = (args.getAll("file").length ? args.getAll("file") : [args.get("a"), args.get("b")]).filter(Boolean).map((f) => resolve(f))
if (files.length < 2) {
  console.error("[用法] 至少两份：--a=<a.nksn> --b=<b.nksn>（或 --file=… 多次）")
  process.exit(EXIT.USAGE)
}
const CTX = args.num("context", 96)
const MAXREG = args.num("max-regions", 40)
const ANCHOR = args.num("anchor", 128) // 每隔多少字节取一个锚
const NEEDLE = args.num("needle", 40) // 锚长度

const load = (p) => {
  const buf = readFileSync(p)
  return { path: p, name: basename(p), buf, size: buf.length, sha: createHash("sha256").update(buf).digest("hex").slice(0, 16), st: statSync(p) }
}
const L = files.map(load)

console.log(bullet("对齐感知差分（只读）"))
console.log(
  tableText(
    ["文件", "大小", "头部长度字段", "sha256(前16)"],
    L.map((f) => ({ 文件: f.name, 大小: humanSize(f.size), 头部长度字段: String(f.buf.readUInt32LE(0)), "sha256(前16)": f.sha })),
  ),
)

function asciiList(buf, from, to, max = 8) {
  const a = Math.max(0, from - CTX)
  const b = Math.min(buf.length, to + CTX)
  const slice = buf.subarray(a, b)
  const out = []
  let cur = ""
  let start = 0
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i]
    if (c >= 0x20 && c < 0x7f) {
      if (!cur) start = i
      cur += String.fromCharCode(c)
    } else {
      if (cur.length >= 4) out.push(cur)
      cur = ""
    }
  }
  if (cur.length >= 4) out.push(cur)
  return out.slice(0, max).map((s) => s.slice(0, 60))
}

const hexOf = (buf, from, to, cap = 20) =>
  [...buf.subarray(from, Math.min(to, from + cap))].map((b) => b.toString(16).padStart(2, "0")).join(" ") + (to - from > cap ? " …" : "")

function interpret(buf, at, len) {
  const bits = []
  if (len >= 4 && at + 4 <= buf.length) {
    const f = buf.readFloatLE(at)
    if (Number.isFinite(f) && Math.abs(f) < 1e7) bits.push(`f32=${Number(f.toFixed(6))}`)
    bits.push(`i32=${buf.readInt32LE(at)}`)
  }
  if (len >= 8 && at + 8 <= buf.length) {
    const d = buf.readDoubleLE(at)
    if (Number.isFinite(d) && Math.abs(d) < 1e12) bits.push(`f64=${Number(d.toPrecision(8))}`)
  }
  return bits.join(" ")
}

// ---------------------------------------------------------------- 对齐
// 用锚把 A 的坐标映射到 B 的坐标；锚找不到时，两侧各留出"只有 A / 只有 B"的区间
function align(A, B) {
  const anchors = []
  let searchFrom = 0
  const tries = [NEEDLE, 32, 24, 16, 12]
  let failed = 0
  for (let p = 0; p + 12 <= A.buf.length; p += ANCHOR) {
    let q = -1
    let used = 0
    for (const n of tries) {
      if (p + n > A.buf.length) continue
      const needle = A.buf.subarray(p, p + n)
      const at = B.buf.indexOf(needle, Math.max(0, searchFrom - 256))
      if (at >= 0) {
        q = at
        used = n
        break
      }
    }
    if (q >= 0) {
      anchors.push({ a: p, b: q, len: used })
      searchFrom = q + used
    } else {
      failed++
    }
  }
  if (failed) console.log(`  （${failed} 个锚位置在对方文件里找不到 —— 通常是插入/删除点或头部区）`)
  if (anchors.length) {
    const lens = new Map()
    for (const a of anchors) lens.set(a.len, (lens.get(a.len) ?? 0) + 1)
    console.log(`  锚长度分布：${[...lens.entries()].sort((x, y) => y[1] - x[1]).map(([l, c]) => `${l}B×${c}`).join(", ")}`)
  }
  return anchors
}

for (let k = 1; k < L.length; k++) {
  const A = L[0]
  const B = L[k]
  console.log(bullet(`${A.name}  ↔  ${B.name}`))

  if (A.sha === B.sha) {
    console.log(`✅ **逐字节完全相同**（${A.size} 字节）→ 同一状态两次保存是确定性的。`)
    continue
  }

  const anchors = align(A, B)
  console.log(`锚点数 ${anchors.length}（每 ${ANCHOR} 字节取一个 ${NEEDLE}B 锚）`)

  if (anchors.length < 4) {
    console.log(`⚠️ 锚太少，没法对齐——两份内容可能整体不同（比如来自不同的 patch/状态）。`)
    continue
  }

  // 分段：相邻锚之间，若 A 与 B 的间距不变 → 视为"对齐块"，逐字节比
  const diffs = []
  const shifts = []
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]
    const cur = anchors[i]
    const dPrev = prev.b - prev.a
    const dCur = cur.b - cur.a
    const aFrom = prev.a + NEEDLE
    const aTo = cur.a
    const bFrom = prev.b + NEEDLE
    const bTo = cur.b
    const lenA = aTo - aFrom
    const lenB = bTo - bFrom

    if (lenA === lenB && dPrev === dCur) {
      // 长度一致 → 逐字节找真正的值差异
      let run = null
      for (let t = 0; t < lenA; t++) {
        if (A.buf[aFrom + t] !== B.buf[bFrom + t]) {
          if (run && t - run.to <= 8) run.to = t + 1
          else {
            if (run) diffs.push(run)
            run = { a: aFrom + t, to: aFrom + t + 1, b: bFrom + t }
          }
        }
      }
      if (run) diffs.push(run)
    } else {
      shifts.push({ a: aFrom, lenA, lenB, delta: lenB - lenA, b: bFrom })
    }
  }

  // 收尾：最后一个锚之后到文件尾
  const last = anchors[anchors.length - 1]
  const taFrom = last.a + NEEDLE
  const tbFrom = last.b + NEEDLE
  const tailA = A.length - taFrom
  const tailB = B.length - tbFrom
  if (tailA === tailB && tailA > 0) {
    let run = null
    for (let t = 0; t < tailA; t++) {
      if (A.buf[taFrom + t] !== B.buf[tbFrom + t]) {
        if (run && t - run.to <= 8) run.to = t + 1
        else {
          if (run) diffs.push(run)
          run = { a: taFrom + t, to: taFrom + t + 1, b: tbFrom + t }
        }
      }
    }
    if (run) diffs.push(run)
  } else if (tailA !== tailB) {
    shifts.push({ a: taFrom, lenA: tailA, lenB: tailB, delta: tailB - tailA, b: tbFrom })
  }

  console.log(`对齐块内的**值差异**：${diffs.length} 处　增删段：${shifts.length} 处`)

  if (diffs.length) {
    const big = diffs.filter((r) => r.to - r.a > 64)
    const small = diffs.filter((r) => r.to - r.a <= 64)
    console.log(
      "\n" +
        tableText(
          ["#", "偏移(A)", "长度", "A 的字节", "B 的字节", "数值解释(A)", "数值解释(B)", "附近的明文（A）"],
          small.slice(0, MAXREG).map((r, i) => ({
            "#": i + 1,
            偏移: `0x${r.a.toString(16)}`,
            长度: `${r.to - r.a}B`,
            "A 的字节": hexOf(A.buf, r.a, r.to),
            "B 的字节": r.b === undefined ? "" : hexOf(B.buf, r.b, r.b + (r.to - r.a)),
            "数值解释(A)": interpret(A.buf, r.a, r.to - r.a),
            "数值解释(B)": r.b === undefined ? "" : interpret(B.buf, r.b, r.to - r.a),
            "附近的明文（A）": asciiList(A.buf, r.a, r.to).join(" · ").slice(0, 60),
          })),
        ),
    )
    if (small.length > MAXREG) console.log(`… 小差异还有 ${small.length - MAXREG} 处`)
    if (big.length) {
      console.log(`\n另有 ${big.length} 处**大段差异**（>64B，通常是整块结构变了，不是单个值）：`)
      for (const r of big.slice(0, 10)) {
        console.log(`  A@0x${r.a.toString(16)}  ${r.to - r.a} B 字节　附近的明文：${asciiList(A.buf, r.a, r.to).join(" · ").slice(0, 70)}`)
      }
      if (big.length > 10) console.log(`  … 还有 ${big.length - 10} 处`)
    }
  }

  if (shifts.length) {
    const rows = shifts
      .filter((s) => Number.isFinite(s.lenA) && Number.isFinite(s.lenB))
      .slice(0, 20)
      .map((s, i) => ({
        "#": i + 1,
        偏移: `0x${s.a.toString(16)}`,
        "A 侧长度": s.lenA,
        "B 侧长度": s.lenB,
        差: s.delta > 0 ? `+${s.delta}` : `${s.delta}`,
        "附近的明文（A）": asciiList(A.buf, s.a, s.a + Math.max(0, s.lenA)).join(" · ").slice(0, 80),
      }))
    console.log("\n**增删段**（长度对不上，往往是「多写/少写了一个字段」）：\n" + tableText(["#", "偏移(A)", "A 侧长度", "B 侧长度", "差", "附近的明文（A）"], rows))
  }
}

console.log(`
怎么用这份结果（差分定位，不是解密）：
  · 「逐字节完全相同」→ 同一状态两次保存是确定性的 → 偏移稳定，定位／改写都可靠。
  · 某个值差异只在你要找的那个开关变化时出现 → 那就是它的存处；
    「数值解释」里出现合理的数（0 / 1 / 0.0–1.0 / dB）说明**值是明文**，不是加密的。
  · 「附近的明文」出现参数名（xfade / mic / ARTICULATION…）→ 直接知道它叫什么。
  · 「增删段」说明两侧字段数量不同（某个开关会让快照多/少写一块）——这也是一条线索。
  · 最佳实验：同一个 patch、**只改一个开关**、连着存两三份（含两份完全相同的状态）。
  · ⚠️ 只改副本、永不改用户原件；真要改写，写完必须 load_snapshot + 人眼确认。`)
process.exit(EXIT.OK)
