-- job_verify_multi.lua —— 重载一个已有 .nkm，回读全部槽位参数
--
-- 由 kontakt_verify_multi 生成，不要手改。配置在 JOB 表里。

local K = dofile("@LIB@")

local JOB = @JOB@

K.log("==== 回读 multi：%s ====", JOB.nkm)
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))

local ok = K.try("load_multi", Kontakt.load_multi, JOB.nkm)
if ok then
  K.try("get_multi_name", Kontakt.get_multi_name)
  K.try("get_num_instruments", Kontakt.get_num_instruments)
end
local rows = ok and K.dump_all_slots() or {}
K.log("  槽位数 = %d", #rows)
for _, line in ipairs(K.machine_block(K.SLOT_COLS, rows, "SLOTS")) do K.log(line) end

-- 每个槽的脚本槽状态（受保护 = 加密/Player 库，group 音量那条路对它无效）
for _, r in ipairs(rows) do
  local si = K.script_info(r.idx)
  K.log("[ OK ] 槽 %s 库类型：%s  脚本槽：%s", tostring(r.slot), si.protected and "受保护（加密/Player）" or "未保护",
    #si.names > 0 and table.concat(si.names, ", ") or "（无）")
end

-- 麦克风读数（只报能读到的名字，来自 JOB.mic_names）
local mics = {}
if JOB.mic_names and #JOB.mic_names > 0 then
  for _, r in ipairs(rows) do
    local names = {}
    for _, n in ipairs(JOB.mic_names) do names[#names + 1] = K.upper(n) end
    table.sort(names)
    local lv = K.mic_levels(r.idx, names, JOB.mic_aliases)
    for _, k in ipairs(names) do
      local a = lv[k] or { n = 0, min = nil, max = nil }
      mics[#mics + 1] = { slot = r.slot, mic = k, n = a.n, min = a.min, max = a.max }
    end
  end
end
table.sort(mics, function(a, b)
  if tostring(a.slot) ~= tostring(b.slot) then return tostring(a.slot) < tostring(b.slot) end
  return tostring(a.mic) < tostring(b.mic)
end)
for _, line in ipairs(K.machine_block({ "slot", "mic", "n", "min", "max" }, mics, "MICS")) do K.log(line) end

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
