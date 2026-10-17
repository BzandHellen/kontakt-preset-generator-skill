-- job_apply_snapshot.lua —— 把一份 .nksn 套到已有 .nkm 的槽上，存成新 multi
--
-- 加密库（Berlin / CSS / 8Dio / LASS…）唯一能落地麦克风比例的通路：
-- 人在 UI 里调好一次 → 存 snapshot → 这个脚本对每个槽 load_snapshot。
-- 由 kontakt_apply_snapshot 生成。

local K = dofile("@LIB@")

local JOB = @JOB@

K.log("==== 套 snapshot ====")
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))
K.log("输入：%s", JOB.in_nkm)
K.log("输出：%s", JOB.out_nkm)
K.log("snapshot：%s", JOB.snapshot)
local f = io.open(JOB.snapshot, "r")
if f == nil then
  K.log("[FAIL] snapshot 文件读不到：%s", JOB.snapshot)
else
  f:close()
  K.log("[ OK ] snapshot 文件在")
end

local loaded = K.try("load_multi", Kontakt.load_multi, JOB.in_nkm)
if not loaded then
  K.log("[FAIL] 输入 multi 载入失败，后面没法做")
  K.write_report(JOB.report)
  os.exit(0)
end
K.try("get_multi_name", Kontakt.get_multi_name)
local before = K.dump_all_slots()
K.log("\n---- 套之前 ----")
for _, line in ipairs(K.machine_block(K.SLOT_COLS, before, "BEFORE")) do K.log(line) end

-- 要套哪些槽：JOB.slots 空/缺省 = 全部
local want = {}
if JOB.slots then
  for _, s in ipairs(JOB.slots) do want[tostring(s)] = true end
end

local libs = {}
local n = 0
for _, r in ipairs(before) do
  if (not JOB.slots) or JOB.slots == nil or #JOB.slots == 0 or want[tostring(r.slot)] then
    local si = K.script_info(r.idx)
    libs[#libs + 1] = { slot = r.slot, protected = tostring(si.protected), name = r.name }
    K.try(string.format("槽 %s  load_snapshot", tostring(r.slot)), Kontakt.load_snapshot, r.idx, JOB.snapshot)
    n = n + 1
  end
end
K.log("共 %d 个槽套了 snapshot", n)

K.log("\n---- 库类型 ----")
for _, line in ipairs(K.machine_block({ "slot", "protected", "name" }, libs, "LIBS")) do K.log(line) end

K.log("\n---- 存盘 ----")
K.try("save_multi", Kontakt.save_multi, JOB.out_nkm, { mode = JOB.save_mode or "patch" })

K.log("\n---- 重载回读（确认槽位与 header 参数没被 snapshot 弄坏）----")
K.try("load_multi(重载)", Kontakt.load_multi, JOB.out_nkm)
local after = K.dump_all_slots()
K.log("  槽位数 = %d", #after)
for _, line in ipairs(K.machine_block(K.SLOT_COLS, after, "AFTER")) do K.log(line) end

K.log("")
K.log("⚠ 注意：snapshot 的麦克风比例**不体现在 group 音量上**（那是库自己的 UI 状态），")
K.log("   所以数值上读不出来 —— 要人眼看 mixer（用 kontakt_apply_snapshot --visual 摆对照，")
K.log("   或直接在 Kontakt 里打开这个 multi）。")
K.log("⚠ snapshot 会连带承载该库 UI 的其它状态 —— 一个库的 snapshot 当「该库的标准状态」维护。")

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
