-- job_learn_mic.lua —— 从一个"你已调好的乐器"里学出各麦克风的 dB
--
-- 目的：把「每个 patch 调一次」变成「每个库调一次」。
-- 只对**未加密库**有意义 —— 加密库的 group 音量根本存不住，学到的是默认值。
-- 由 kontakt_learn_mic 生成。

local K = dofile("@LIB@")

local JOB = @JOB@

K.log("==== 学麦克风比例 ====")
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))

-- 注意：Lua 里空表是真值，`JOB.keywords or {...}` 会被空表顶掉 —— 必须判长度
local keywords = JOB.keywords
if keywords == nil or #keywords == 0 then
  keywords = { "CLOSE", "AB", "TREE", "SURROUND", "SOLO", "MAIN", "MIX", "ROOM", "SPOT", "DECCA", "CDECCA", "FULL", "AMB" }
end

local libs = {}
for i, p in ipairs(JOB.patches) do
  K.log("\n======== [%d/%d] %s", i, #JOB.patches, p)
  K.try("reset_multi", Kontakt.reset_multi)
  local ok, idx = K.try("load_instrument", Kontakt.load_instrument, p)
  if ok and type(idx) == "number" then
    local si = K.script_info(idx)
    local iname = tostring(Kontakt.get_instrument_name(idx))
    libs[#libs + 1] = { slot = i, lane = iname, protected = tostring(si.protected) }
    K.log("[ OK ] 乐器名=%s", iname)
    K.log("[%s] 库类型：%s", si.protected and "WARN" or " OK ", si.protected and "受保护（加密/Player）" or "未保护")
    if si.protected then
      K.log("       ⛔ 受保护库的 group 音量存不住，学出来的会是默认值（没意义）。")
      K.log("          这类库的麦克风只能靠 snapshot：人在 UI 里调好 → 存 .nksn → 用 apply_snapshot 套。")
    end

    local ng, counts, order = K.group_census(idx)
    K.log("[ OK ] group 数 = %d，不同名字 = %d", ng, #order)
    for j = 1, math.min(#order, JOB.census or 20) do
      K.log("       %5d x  %s", counts[order[j]], order[j])
    end

    -- 有别名表就按别名归类，否则用关键词
    local micKeys = JOB.mic_keys
    if micKeys == nil or #micKeys == 0 then micKeys = keywords end    local lv = K.mic_levels(idx, micKeys, JOB.mic_aliases)
    local keys = {}
    for k in pairs(lv) do keys[#keys + 1] = k end
    table.sort(keys)
    local rows = {}
    for _, k in ipairs(keys) do
      local a = lv[k]
      rows[#rows + 1] = { slot = i, mic = k, n = a.n, min = a.min, max = a.max }
    end
    for _, line in ipairs(K.machine_block({ "slot", "mic", "n", "min", "max" }, rows, "MICS")) do K.log(line) end
    if #rows == 0 then K.log("       ⚠ 一个麦克风名都没匹配上 —— 先 probe_library 普查，把别名填进 profiles") end
  end
end

K.log("\n---- 库类型汇总 ----")
for _, line in ipairs(K.machine_block({ "slot", "lane", "protected" }, libs, "LIBS")) do K.log(line) end

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
