// scripts/plan.mjs —— 清单 + profiles → 每个 multi 每槽的「最终值」
//
// 这是 gen 与 verify 共用的那一步：把 defaults / pan_by_section / mic profile 全部落成具体值，
// 顺便产出「期望值」（存成 CSV，给 verify_multi 用来比对）。

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { EXIT, UsageError, manifestPath, noteToMidi, parseLuaFile, parseTsv, profilesPath, readCsv, writeCsv, workspaceDir } from "./lib.mjs"

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

// mic 列 → { mode, spec, aliases, snapshotPath, note }
//   ""                 → defaults.mic 的 profile
//   "berlin_close_main"→ profiles.mic_profiles 里的 profile（未加密库：写 group 音量）
//   "CLOSE=-6;TREE=-8" → 内联
//   "snap:<文件>"      → 直接指定 snapshot（加密库：套库自己的 UI 状态）
//   "<token>"          → 若 profiles.mic_snapshots 里有这个 token，按规则表挑 snapshot；
//                        否则当 mic_profiles 的 profile 名
//   "learn:<文件>"     → M3 的 learn_mic 产的 profile 名（这里只标记，不实现）
function resolveMic(raw, defaults, profiles, patchPath) {
  const text = String(raw || defaults.mic || "").trim()
  const aliases = aliasesFor(patchPath, profiles.mic_aliases)

  if (!text || text === "unity") return { mode: "groups", spec: {}, aliases, note: "unity（不改麦克风）" }

  if (text.startsWith("learn:")) {
    return { mode: "skipped", spec: {}, aliases, note: `learn:（用 learn_mic 先产出 profile，再把 profile 名填进清单）：${text.slice(6)}` }
  }

  if (text.startsWith("snap:")) {
    return { mode: "snapshot", spec: {}, aliases, snapshotPath: text.slice(5).trim(), note: "snap:（直接指定）" }
  }

  const snaps = profiles.mic_snapshots?.[text]
  if (snaps !== undefined) {
    const picked = pickSnapshot(snaps, patchPath)
    if (!picked) {
      return { mode: "skipped", spec: {}, aliases, note: `mic_snapshots.${text} 里没有匹配这个 patch 的规则：${patchPath}` }
    }
    return { mode: "snapshot", spec: {}, aliases, snapshotPath: picked, note: `snapshot：${text}` }
  }

  if (text.includes("=")) {
    const spec = {}
    for (const part of text.split(";")) {
      const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(part)
      if (!m) continue
      const v = m[2].toLowerCase()
      if (v === "off" || v === "mute" || v === "-math.huge") spec[m[1]] = "off"
      else spec[m[1]] = Number(m[2])
    }
    return { mode: "groups", spec, aliases, note: "内联" }
  }

  const spec = profiles.mic_profiles?.[text]
  if (!spec) return { mode: "skipped", spec: {}, aliases, note: `profiles 里既没有 mic_profiles.${text}，也没有 mic_snapshots.${text}` }
  return { mode: "groups", spec, aliases, note: text }
}

// mic_snapshots 的一条：字符串（整库一个）或规则表 [{ match, path }]（按 patch 路径挑，匹配你的
// User Content\<库>\<乐器>\Empty.nksn 习惯）。match 是 patch 路径的子串（大小写不敏感）。
export function pickSnapshot(snaps, patchPath) {
  const p = String(patchPath || "").toLowerCase().replace(/\\/g, "/")
  if (typeof snaps === "string") return snaps
  if (Array.isArray(snaps)) {
    for (const rule of snaps) {
      if (!rule || !rule.path) continue
      if (!rule.match || p.includes(String(rule.match).toLowerCase().replace(/\\/g, "/"))) return rule.path
    }
  }
  return null
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
      // mic 走 snapshot 时，把它落到 snapshot 列上（gen 模板里 snapshot 的装载在 header 参数之前）
      const slotSnapshot = r.get("snapshot") !== "" ? r.get("snapshot") : (mic.snapshotPath ?? "")
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
        snapshot: slotSnapshot,
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
// src 列记来源清单 —— multi 名相同但清单不同时，能发现"期望值被另一份清单覆盖了"
export const EXPECT_COLS = ["src", "slot", "name", "midi", "out", "vol", "pan", "keysw", "kmin", "kmax", "vmin", "vmax", "trans"]
export const MIC_COLS = ["src", "slot", "mic", "expect"]

export function expectPaths(args, multi) {
  const dir = join(workspaceDir(args), "Generated", "_expect")
  mkdirSync(dir, { recursive: true })
  return { slotCsv: join(dir, `${multi}.csv`), micCsv: join(dir, `${multi}.mic.csv`) }
}

export function writeExpect(args, m) {
  const { slotCsv, micCsv } = expectPaths(args, m.multi)
  const src = args.get("manifest") || ""
  const existing = existsSync(slotCsv) ? readCsv(slotCsv)[0] : null
  const clash = existing && existing.src && src && existing.src !== src

  const slotRows = m.slots.map((s) => ({
    src,
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
      // others 是通配（"其余全关"），不是麦克风名 —— 不进期望表，它的命中数在报告里
      if (k.toLowerCase() === "others") continue
      micRows.push({ src, slot: s.slot, mic: k.toUpperCase(), expect: v === "off" ? "-inf" : v })
    }
  }
  writeCsv(micCsv, MIC_COLS, micRows)
  return { slotCsv, micCsv, clash: clash ? existing.src : null }
}

export { EXIT }
