// scripts/plan.mjs —— 清单 + profiles → 每个 multi 每槽的「最终值」
//
// 这是 gen 与 verify 共用的那一步：把 defaults / pan_by_section / mic profile 全部落成具体值，
// 顺便产出「期望值」（存成 CSV，给 verify_multi 用来比对）。

import { existsSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { EXIT, UsageError, manifestPath, noteToMidi, parseLuaFile, parseTsv, profilesPath, writeCsv, workspaceDir } from "./lib.mjs"

export const SECTIONS = ["STR", "BRS", "WW", "PERC", "ETH", "CHO"]
const PORTS = { A: 0, B: 1, C: 2, D: 3 }

// port A–D + midi 1–16 → Kontakt 的 1..64（0 = Omni）
export function kontaktChannel(port, midi) {
  const p = PORTS[String(port || "A").toUpperCase()]
  if (p === undefined) return null
  const m = Number(midi)
  if (!Number.isFinite(m) || m < 1 || m > 16) return null
  return p * 16 + m
}

// keysw 列：`ks=C0;tr=-12`（也认 kmin/kmax/vmin/vmax）
export function parseKeysw(text) {
  const out = {}
  const o = {}
  for (const part of String(text || "").split(";")) {
    const m = /^\s*(ks|tr|kmin|kmax|vmin|vmax)\s*=\s*(.+?)\s*$/i.exec(part)
    if (!m) continue
    const key = m[1].toLowerCase()
    const raw = m[2]
    if (key === "ks" || key === "kmin" || key === "kmax") {
      const n = noteToMidi(raw)
      if (n === null) o[key] = raw // 数字就直接当 MIDI 号
      else o[key] = n
    } else o[key] = Number(raw)
  }
  const opt = {}
  if (o.ks !== undefined) opt.key_switch = Number(o.ks)
  if (o.kmin !== undefined) opt.key_range_from = Number(o.kmin)
  if (o.kmax !== undefined) opt.key_range_to = Number(o.kmax)
  if (o.vmin !== undefined) opt.velocity_range_from = Number(o.vmin)
  if (o.vmax !== undefined) opt.velocity_range_to = Number(o.vmax)
  if (o.tr !== undefined) opt.midi_transpose = Number(o.tr)
  out.options = opt
  out.raw = o
  return out
}

function findSection(name, panBySection) {
  const hay = String(name).toLowerCase()
  for (const key of Object.keys(panBySection)) {
    if (hay.includes(key.toLowerCase())) return key
  }
  return null
}

export function loadProfiles(args) {
  const p = profilesPath(args)
  if (!existsSync(p)) return { path: p, value: {}, ok: false }
  try {
    const { value } = parseLuaFile(p)
    return { path: p, value, ok: true }
  } catch (e) {
    return { path: p, value: {}, ok: false, error: e.message }
  }
}

// mic 列 → { mode, spec, aliases, snapshot, note }
//   ""                 → defaults.mic 的 profile
//   "berlin_close_main"→ profiles.mic_profiles 里的 profile
//   "CLOSE=-6;TREE=-8" → 内联
//   "learn:<文件>"     → M3 才有，这里标记出来不静默丢
function resolveMic(raw, defaults, profiles, patchPath) {
  const text = String(raw || defaults.mic || "").trim()
  const aliases = aliasesFor(patchPath, profiles.mic_aliases)
  if (!text || text === "unity") return { mode: "groups", spec: {}, aliases, note: "unity（不改麦克风）" }
  if (text.startsWith("learn:")) {
    return { mode: "skipped", spec: {}, aliases, note: `learn:（M3 才实现，本次跳过）：${text.slice(6)}` }
  }
  if (text.includes("=")) {
    const spec = {}
    for (const part of text.split(";")) {
      const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(part)
      if (!m) continue
      const v = m[2].toLowerCase()
      spec[m[1]] = v === "off" || v === "mute" ? "off" : Number(m[2])
    }
    return { mode: "groups", spec, aliases, note: "内联" }
  }
  const spec = profiles.mic_profiles?.[text]
  if (!spec) return { mode: "skipped", spec: {}, aliases, note: `profiles 里没有 profile「${text}」` }
  return { mode: "groups", spec, aliases, note: text }
}

// 该 patch 属于哪个库的别名表：拿 mic_aliases 的键（berlin / css …）去比 patch 路径
export function aliasesFor(patchPath, micAliases) {
  const p = String(patchPath || "").toLowerCase().replace(/\\/g, "/")
  for (const [key, table] of Object.entries(micAliases ?? {})) {
    if (key && p.includes(key.toLowerCase())) return table
  }
  return {}
}

// 所有库的别名表并起来（verify 时不知道槽属于哪个库，用并集）
export function mergedAliases(profiles) {
  const out = {}
  for (const table of Object.values(profiles.mic_aliases ?? {})) {
    for (const [std, names] of Object.entries(table ?? {})) {
      out[std] = [...new Set([...(out[std] ?? []), ...[].concat(names)])]
    }
  }
  return out
}

export function planManifest(args) {
  const manifest = manifestPath(args)
  if (!existsSync(manifest)) throw new UsageError(`找不到清单：${manifest}`)

  const prof = loadProfiles(args)
  const defaults = prof.value.defaults ?? { vol: 0, pan: 0, out: 1, port: "A", mic: "unity" }
  const panBySection = prof.value.pan_by_section ?? {}

  const { rows } = parseTsv(readFileSync(manifest, "utf8"))
  const want = args.getAll("multi").filter(Boolean)
  const order = []
  const byMulti = new Map()
  for (const r of rows) {
    const multi = r.get("multi")
    if (want.length && !want.includes(multi)) continue
    if (!byMulti.has(multi)) {
      byMulti.set(multi, [])
      order.push(multi)
    }
    byMulti.get(multi).push(r)
  }

  const multis = []
  for (const multi of order) {
    const list = byMulti.get(multi)
    // 有 slot 的按 slot 升序在前，没 slot 的按原顺序接在后面
    const withSlot = list.filter((r) => r.get("slot") !== "").sort((a, b) => Number(a.get("slot")) - Number(b.get("slot")))
    const noSlot = list.filter((r) => r.get("slot") === "")
    const ordered = [...withSlot, ...noSlot]
    const usedSlots = new Set(withSlot.map((r) => Number(r.get("slot"))))
    let next = 0
    const slots = []
    const section = findSection(multi, panBySection)
    ordered.forEach((r, i) => {
      let slot
      if (r.get("slot") !== "") slot = Number(r.get("slot"))
      else {
        while (usedSlots.has(next)) next++
        slot = next
        usedSlots.add(slot)
        next++
      }
      const port = (r.get("port") || defaults.port || "A").toUpperCase()
      const midi = r.get("midi") !== "" ? Number(r.get("midi")) : Math.min(i + 1, 16)
      const mic = resolveMic(r.get("mic"), defaults, prof.value, r.get("patch"))
      const ks = parseKeysw(r.get("keysw"))
      const explicitPan = r.get("pan") !== ""
      slots.push({
        slot,
        line: r.line,
        path: r.get("patch").replace(/\\/g, "/"),
        name: r.get("name"),
        midi: kontaktChannel(port, midi),
        midiRaw: `${port}${midi}`,
        out: r.get("out") !== "" ? Number(r.get("out")) : (defaults.out ?? 1),
        vol: r.get("vol") !== "" ? Number(r.get("vol")) : (defaults.vol ?? 0),
        pan: explicitPan ? Number(r.get("pan")) : (section !== null ? panBySection[section] : (defaults.pan ?? 0)),
        panFrom: explicitPan ? "清单" : section !== null ? `声部 ${section}` : "defaults",
        mic,
        snapshot: r.get("snapshot"),
        options: ks.options,
        keyswRaw: r.get("keysw"),
        note: r.get("note"),
      })
    })
    multis.push({ multi, section, slots })
  }
  return { manifest, prof, defaults, panBySection, multis }
}

// 期望值 CSV：给 verify_multi 比对用（空 = 不检查）
export const EXPECT_COLS = ["slot", "name", "midi", "out", "vol", "pan", "keysw", "kmin", "kmax", "vmin", "vmax", "trans"]
export const MIC_COLS = ["slot", "mic", "expect"]

export function expectPaths(args, multi) {
  const dir = join(workspaceDir(args), "Generated", "_expect")
  mkdirSync(dir, { recursive: true })
  return { slotCsv: join(dir, `${multi}.csv`), micCsv: join(dir, `${multi}.mic.csv`) }
}

export function writeExpect(args, m) {
  const { slotCsv, micCsv } = expectPaths(args, m.multi)
  const slotRows = m.slots.map((s) => ({
    slot: s.slot,
    name: s.name,
    midi: s.midi,
    out: s.out,
    vol: s.vol,
    pan: s.pan,
    keysw: s.options.key_switch ?? "",
    kmin: s.options.key_range_from ?? "",
    kmax: s.options.key_range_to ?? "",
    vmin: s.options.velocity_range_from ?? "",
    vmax: s.options.velocity_range_to ?? "",
    trans: s.options.midi_transpose ?? "",
  }))
  writeCsv(slotCsv, EXPECT_COLS, slotRows)

  const micRows = []
  for (const s of m.slots) {
    for (const [k, v] of Object.entries(s.mic.spec ?? {})) {
      micRows.push({ slot: s.slot, mic: k.toUpperCase(), expect: v === "off" ? "-inf" : v })
    }
  }
  writeCsv(micCsv, MIC_COLS, micRows)
  return { slotCsv, micCsv }
}

export { EXIT }
