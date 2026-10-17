// scripts/compare.mjs —— 期望值 vs 回读值
//
// gen 与 verify 共用。空期望 = 不检查；数字按容差，字符串按完全相等。

const NUM_FIELDS = new Set(["midi", "out", "vol", "pan", "keysw", "kmin", "kmax", "vmin", "vmax", "trans"])
const EPS = { vol: 0.05, pan: 0.05 }

function num(v) {
  if (v === "" || v === null || v === undefined) return null
  if (String(v) === "-inf") return -Infinity
  if (String(v) === "inf") return Infinity
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function compareSlots(expectRows, actualRows) {
  const bySlot = new Map(actualRows.map((r) => [String(r.slot), r]))
  const issues = []
  const checks = []

  for (const e of expectRows) {
    const slot = String(e.slot)
    const a = bySlot.get(slot)
    if (!a) {
      issues.push({ slot, field: "(整个槽)", expect: "存在", actual: "找不到", level: "ERROR" })
      continue
    }
    for (const [field, expected] of Object.entries(e)) {
      if (field === "slot") continue
      if (expected === "" || expected === null || expected === undefined) continue
      const actual = a[field] ?? ""
      let ok
      if (NUM_FIELDS.has(field)) {
        const en = num(expected)
        const an = num(actual)
        if (en === null) ok = String(expected) === String(actual)
        else if (en === Infinity || en === -Infinity) ok = en === an
        else ok = an !== null && Math.abs(en - an) <= (EPS[field] ?? 0.01)
      } else {
        ok = String(expected) === String(actual)
      }
      checks.push({ slot, field, expect: expected, actual, ok })
      if (!ok) issues.push({ slot, field, expect: expected, actual, level: "ERROR" })
    }
  }
  return { checks, issues }
}

// 麦克风回读：expect 表的每条 mic 在 actual 里应当是 min==max==期望值
export function compareMics(micExpectRows, micActualRows) {
  const key = (r) => `${r.slot}|${String(r.mic).toUpperCase()}`
  const byKey = new Map()
  for (const r of micActualRows) byKey.set(key(r), r)
  const checks = []
  const issues = []

  for (const e of micExpectRows) {
    const a = byKey.get(key(e))
    const expected = num(e.expect)
    if (!a) {
      checks.push({ slot: e.slot, mic: e.mic, expect: e.expect, actual: "（没读到该 group）", ok: false })
      issues.push({ slot: e.slot, field: `mic ${e.mic}`, expect: e.expect, actual: "找不到 group", level: "ERROR" })
      continue
    }
    const mn = num(a.min)
    const mx = num(a.max)
    let ok
    if (expected === -Infinity) ok = mn === -Infinity && mx === -Infinity
    else ok = mn !== null && mx !== null && Math.abs(mn - expected) <= 0.05 && Math.abs(mx - expected) <= 0.05
    checks.push({
      slot: e.slot,
      mic: e.mic,
      expect: e.expect,
      actual: mn === mx ? String(mn) : `${a.min} … ${a.max}`,
      ok,
    })
    if (!ok) {
      issues.push({
        slot: e.slot,
        field: `mic ${e.mic}`,
        expect: e.expect,
        actual: `${a.min} … ${a.max}（${a.n} 个 group）`,
        level: "ERROR",
      })
    }
  }
  return { checks, issues }
}

export function protectedSlots(rows) {
  const s = new Set()
  for (const r of rows) if (String(r.protected).toLowerCase() === "true") s.add(String(r.slot))
  return s
}
