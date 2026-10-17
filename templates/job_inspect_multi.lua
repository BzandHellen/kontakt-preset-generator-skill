-- job_inspect_multi.lua —— 侦察一个 .nkm（自己的旧的、别人给的、手做的都行）
--
-- 只读：不保存任何东西。由 kontakt_inspect_multi 生成。

local K = dofile("@LIB@")

local JOB = @JOB@

K.log("==== 侦察 multi：%s ====", JOB.nkm)
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))

local ok = K.try("load_multi", Kontakt.load_multi, JOB.nkm)
if not ok then
  K.log("[FAIL] 载入失败，后面没法看")
  K.write_report(JOB.report)
  os.exit(0)
end
K.try("get_multi_name", Kontakt.get_multi_name)
local rows = K.dump_all_slots()
K.log("  槽位数 = %d（multi 名：%s）", #rows, tostring(Kontakt.get_multi_name()))
for _, line in ipairs(K.machine_block(K.SLOT_COLS, rows, "SLOTS")) do K.log(line) end

-- 逐槽细看：脚本槽 + group 名普查 + 麦克风读数
for _, r in ipairs(rows) do
  K.log("\n-------- 槽 %s  %s", tostring(r.slot), tostring(r.name))
  local si = K.script_info(r.idx)
  K.log("[ OK ] 库类型：%s", si.protected and "受保护（加密/Player → 麦克风只能靠 snapshot）" or "未保护（可以写 group 音量）")
  if #si.names > 0 then K.log("       脚本槽：%s", table.concat(si.names, " | ")) end

  local ng, counts, order = K.group_census(r.idx)
  K.log("[ OK ] group 数 = %d，不同名字 = %d", ng, #order)
  for i = 1, math.min(#order, JOB.census or 15) do
    K.log("       %5d x  %s", counts[order[i]], order[i])
  end
  if JOB.mic_names and #JOB.mic_names > 0 then
    local lv = K.mic_levels(r.idx, JOB.mic_names, JOB.mic_aliases)
    local keys = {}
    for k in pairs(lv) do keys[#keys + 1] = k end
    table.sort(keys)
    for _, k in ipairs(keys) do
      local a = lv[k]
      K.log("       %-10s n=%3d  min=%s  max=%s", k, a.n, tostring(a.min), tostring(a.max))
    end
  end
end

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
