-- job_snapshot_visual.lua —— 摆一组对照槽，让人直接在 Kontakt 里看 mixer
--
-- 加密库的麦克风比例数值上读不出来，只能人眼确认。这里按 JOB.entries 逐槽装载，
-- 需要套的槽套上 snapshot，然后**故意不退出** —— 机架留着给你点着看。
-- 由 kontakt_apply_snapshot --visual 生成。

local K = dofile("@LIB@")

local JOB = @JOB@

K.log("==== snapshot 对照（人眼看 mixer）====")
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))

K.try("reset_multi", Kontakt.reset_multi)
K.try("set_multi_name", Kontakt.set_multi_name, JOB.multi or "SNAPSHOT TEST")

local libs = {}
for i, e in ipairs(JOB.entries) do
  local ok, idx = K.try(string.format("load #%d %s", i, tostring(e.label)), Kontakt.load_instrument, e.path, (i - 1) * 128)
  if ok and type(idx) == "number" then
    if e.snapshot and e.snapshot ~= "" then
      K.try("  load_snapshot", Kontakt.load_snapshot, idx, e.snapshot)
    else
      K.log("  （对照组：不套 snapshot）")
    end
    K.try("  set_instrument_name", Kontakt.set_instrument_name, idx, e.name or e.label)
    K.try("  set_instrument_midi_channel", Kontakt.set_instrument_midi_channel, idx, i)
    local si = K.script_info(idx)
    libs[#libs + 1] = {
      slot = i - 1,
      protected = tostring(si.protected),
      label = e.label,
      -- 注意：Lua 里空串是真值，不能写 `e.snapshot and "套了" or "没套"`
      snapshot = (e.snapshot ~= nil and e.snapshot ~= "") and "套了" or "没套（对照组）",
    }
  end
end

K.log("\n---- 对照表（请在 Kontakt 里逐个槽点开看 mixer）----")
for _, line in ipairs(K.machine_block({ "slot", "label", "snapshot", "protected" }, libs, "LIBS")) do K.log(line) end
K.log("")
K.log("槽 1 = 对照组（库默认，没套）；其余 = 套了同一个 snapshot。")
K.log("期待：套了 snapshot 的槽显示该 snapshot 的比例（跨 patch 也该生效）。")

K.log("\n==== end ====")
K.write_report(JOB.report)
-- 故意不 os.exit：机架留着给人看。看完了自己关 Kontakt。
print("（不自动退出：机架留着给人看）")
