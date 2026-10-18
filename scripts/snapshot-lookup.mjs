// scripts/snapshot-lookup.mjs —— 把 .nksn 当"可读的参数表"来查（只读，不需要 Kontakt）
//
// 两种用法（都秒级）：
//   ① 按名字找：  --find=mic,mix,xfade         列出匹配的明文名 + 它后面那串字节 + 候选数值
//   ② 按值找：    --value=-6 --value=-12        把数值按 f32/f64/i32/i16/十进制串各编码一遍，
//                                               搜出现位置，并报出**前后最近的明文名**
// 搭配 snapshot_diff：diff 找出"哪块变了"，lookup 告诉你"这块叫什么、值是多少"。

import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import { EXIT, bullet, humanSize, parseArgs, tableText } from "./lib.mjs"

const args = parseArgs()
const files = (args.getAll("file").length ? args.getAll("file") : [args.get("a")]).filter(Boolean).map((f) => resolve(f))
if (!files.length) {
  console.error("[用法] --file=<a.nksn>（可多个），配 --find=名字 或 --value=数值")
  process.exit(EXIT.USAGE)
}
const bad = files.filter((f) => !existsSync(f))
if (bad.length) {
  console.error(`[用法] 不存在：\n  ${bad.join("\n  ")}`)
  process.exit(EXIT.USAGE)
}

const findList = args
  .get("find", "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
const values = args.getAll("value").filter((v) => v !== "")
const WIN = args.num("window", 256) // 名字与值之间允许的最大距离
const MAX = args.num("max", 40)

const load = (p) => ({ path: p, name: basename(p), buf: readFileSync(p), st: statSync(p) })

// 所有可读 ASCII 串（>=4），带偏移
function strings(buf, min = 4) {
  const out = []
  let cur = ""
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c >= 0x20 && c < 0x7f) {
      if (!cur) start = i
      cur += String.fromCharCode(c)
    } else {
      if (cur.length >= min) out.push({ at: start, s: cur })
      cur = ""
    }
  }
  if (cur.length >= min) out.push({ at: start, s: cur })
  return out
}

const nearNames = (strs, at) => {
  const before = [...strs].reverse().find((x) => x.at + x.s.length <= at && at - (x.at + x.s.length) <= WIN)
  const after = strs.find((x) => x.at >= at && x.at - at <= WIN)
  return [before ? `⟵ ${before.s.slice(0, 40)}` : "", after ? `⟶ ${after.s.slice(0, 40)}` : ""].filter(Boolean).join("  ")
}

const candidateValues = (buf, at, len = 24) => {
  const bits = []
  if (at + 4 <= buf.length) {
    const f = buf.readFloatLE(at)
    if (Number.isFinite(f) && Math.abs(f) < 1e7 && (f === 0 || Math.abs(f) > 1e-6)) bits.push(`f32=${Number(f.toFixed(6))}`)
    bits.push(`i32=${buf.readInt32LE(at)}`)
  }
  if (at + 8 <= buf.length) {
    const d = buf.readDoubleLE(at)
    if (Number.isFinite(d) && Math.abs(d) < 1e9 && (d === 0 || Math.abs(d) > 1e-9)) bits.push(`f64=${Number(d.toPrecision(6))}`)
  }
  return bits.join(" ")
}

const encodings = (v) => {
  const n = Number(v)
  const out = []
  const f32 = Buffer.alloc(4)
  f32.writeFloatLE(n)
  out.push({ how: "float32 LE", buf: f32 })
  const f64 = Buffer.alloc(8)
  f64.writeDoubleLE(n)
  out.push({ how: "float64 LE", buf: f64 })
  const i32 = Buffer.alloc(4)
  i32.writeInt32LE(Math.round(n))
  out.push({ how: "int32 LE", buf: i32 })
  const i16 = Buffer.alloc(2)
  i16.writeInt16LE(Math.round(n))
  out.push({ how: "int16 LE", buf: i16 })
  out.push({ how: "十进制串", buf: Buffer.from(String(v), "latin1") })
  return out
}

const L = files.map(load)

for (const f of L) {
  const strs = strings(f.buf)
  console.log(bullet(`${f.name}　${humanSize(f.buf.length)}　可读串 ${strs.length} 条`))

  // ① 按名字
  if (findList.length) {
    const hits = strs.filter((x) => findList.some((k) => x.s.toLowerCase().includes(k)))
    console.log(`\n-- 名字里含 ${findList.join(" / ")} 的串：${hits.length} 条`)
    console.log(
      tableText(
        ["偏移", "名字", "紧随其后的 24 字节", "候选值（名字之后 4/8 字节处）"],
        hits.slice(0, MAX).map((x) => {
          const from = Math.min(f.buf.length - 1, x.at + x.s.length + 1)
          const hex = [...f.buf.subarray(from, from + 24)].map((b) => b.toString(16).padStart(2, "0")).join(" ")
          return {
            偏移: `0x${x.at.toString(16)}`,
            名字: x.s.slice(0, 36),
            "紧随其后的 24 字节": hex,
            "候选值（名字之后 4/8 字节处）": candidateValues(f.buf, from),
          }
        }),
      ),
    )
    if (hits.length > MAX) console.log(`… 还有 ${hits.length - MAX} 条`)
  }

  // ② 按值
  for (const v of values) {
    console.log(`\n-- 搜值 ${v}（按 5 种编码）`)
    const rows = []
    for (const enc of encodings(v)) {
      let from = 0
      let count = 0
      while (count < MAX) {
        const at = f.buf.indexOf(enc.buf, from)
        if (at < 0) break
        rows.push({ 编码: enc.how, 偏移: `0x${at.toString(16)}`, "前后最近的明文名": nearNames(strs, at) || "（窗口内没有明文名）" })
        from = at + 1
        count++
      }
    }
    console.log(
      rows.length
        ? tableText(["编码", "偏移", "前后最近的明文名"], rows)
        : `（没找到 —— 值可能不是明文，或被编码/混淆过）`,
    )
  }
}

console.log(`
读法：
  · 「名字」命中 + 紧随其后的候选值合理 → 这个参数**是明文的**，值就在名字后面。
  · 「按值」命中且前后有明文名 → 直接知道"哪个参数的值为 X"。
  · 都没命中 → 这一层被混淆/编码了（那就换 snapshot_diff 做差分，只看"哪里变了"）。
  · 想更省事：拿你的快照与同乐器目录下的 Empty.nksn 比（Empty = 库默认状态）→ 差异就是你改过的。
  · ⚠️ 只读：本工具不写任何快照。`)
process.exit(EXIT.OK)
