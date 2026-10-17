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

// 麦克风回读不一致时，判一下是哪种：
//   "reset"   库把它复位回默认（所有值塌成同一个 ≈0 的数）→ 这类库的 group 音量存不住，只能走 snapshot
//   "missing" 该 patch 里根本没有这个名字的 group（n=0）→ 是别名表没覆盖，不是生成出错
//   "real"    其它不一致 → 真问题
// 一个槽里只要有一个麦克风是 reset，就认为这个槽的麦克风层不持久化，把它其它不一致也并进 reset。
export function classifyMicIssues(issues, actualRows) {
  const byKey = new Map(actualRows.map((r) => [`${r.slot}|${String(r.mic).toUpperCase()}`, r]))
  const real = []
  const reset = []
  const missing = []

  const slotReset = new Set()
  for (const r of actualRows) {
    const mn = num(r.min)
    const mx = num(r.max)
    if (Number(r.n) > 0 && mn !== null && mx !== null && mn === mx && Math.abs(mn) < 0.01) slotReset.add(String(r.slot))
  }

  for (const i of issues) {
    const mic = String(i.field).replace(/^mic\s+/i, "").toUpperCase()
    const a = byKey.get(`${i.slot}|${mic}`)
    const row = { ...i, mic, actual: a ? (Number(a.n) === 0 ? "（没有这个 group）" : `${a.min} … ${a.max}`) : i.actual }
    if (a && Number(a.n) === 0) missing.push(row)
    else if (slotReset.has(String(i.slot))) reset.push(row)
    else real.push(row)
  }
  return { real, reset, missing }
}

// 作业有没有跑完（报告写了结尾）：用它区分「Kontakt 退出时崩了」和「作业真失败」
export function jobCompleted(reportText) {
  return /====\s*end\s*====/.test(reportText ?? "")
}
