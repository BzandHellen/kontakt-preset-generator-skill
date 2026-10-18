-- job_gen_multi.lua —— 清单 → multi（A1–A6）
--
-- 由 kontakt_gen_multi 生成，不要手改（下次生成会覆盖）。
-- 配置在下面的 JOB 表里（Node 侧注入）；公共函数在 kontakt_lib.lua。

local K = dofile("@LIB@")

local JOB = @JOB@

K.log("==== 生成 multi：%s ====", JOB.multi)
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))
K.log("清单：%s", JOB.manifest or "（直接给的行）")
K.log("产物：%s", JOB.out_nkm)

-- ---------------------------------------------------------------- A1 建空 multi
K.try("reset_multi", Kontakt.reset_multi)
K.try("set_multi_name", Kontakt.set_multi_name, JOB.multi)

-- ---------------------------------------------------------------- A2 装载
-- instrument_idx 是 128 一跳：slot N -> N*128。请求的落点被占了 Kontakt 会自动换 —— 记 WARN。
local placed = {}
for i, s in ipairs(JOB.slots) do
  local want = (tonumber(s.slot) or (i - 1)) * 128
  local ok, idx = K.try(string.format("load_instrument #%d (slot %s)", i, tostring(s.slot)), Kontakt.load_instrument, s.path, want)
  if ok and type(idx) == "number" then
    placed[i] = idx
    if idx ~= want then K.log("[WARN] 落点是 %d，不是请求的 %d", idx, want) end
  else
    K.log("[FAIL] 槽 %s 装载失败，后面的参数都不设了", tostring(s.slot))
  end
end

-- ---------------------------------------------------------------- A3 逐槽设参数
-- 顺序：先 snapshot（它承载库自己 UI 的状态，会连带改一些东西），再设 header 上的参数。
local libs = {}
local baselines = {} -- [i] = { [MIC] = { min=, max= } }  写之前读到的基线（判断"库复位"用）
for i, s in ipairs(JOB.slots) do
  local idx = placed[i]
  if idx then
    K.log("\n---- 槽 %s  %s", tostring(s.slot), tostring(s.name))
    K.try("  实际乐器名", Kontakt.get_instrument_name, idx)

    local si = K.script_info(idx)
    libs[#libs + 1] = { slot = s.slot, protected = tostring(si.protected), scripts = table.concat(si.names, " | ") }

    -- ⚠️ 以前这里"受保护就直接不写"，但那是**假设**：实测 LASS 的分技法 legacy patch 受保护却**写得进去也存得住**。
    -- 所以现在**照写**，让"存盘→重载→回读"来判：真存不住会被判成「库复位」（WARN，不是 FAIL），
    -- 那时再给这个库配 snapshot 也不迟。
    if si.protected and s.mic and s.mic.mode == "groups" and next(s.mic.spec or {}) ~= nil then
      K.log("[WARN] 这个 patch 的库脚本受保护（加密/Player）—— 照写，回读见分晓：")
      K.log("       存不住 = 这条库要配 snapshot；存得住（有先例）= 就这样用")
    end

    if s.snapshot and s.snapshot ~= "" then
      K.try("  load_snapshot", Kontakt.load_snapshot, idx, s.snapshot)
    end

    if s.mic and s.mic.mode == "groups" and next(s.mic.spec or {}) ~= nil then
      K.log("  —— 麦克风（直接写 group 音量）——")
      -- 写之前先读基线：重载后如果值 == 基线，说明是库把它复位了，不是我们写错
      local keys = {}
      for k in pairs(s.mic.spec) do
        if k ~= "others" then keys[#keys + 1] = K.upper(k) end
      end
      local base = K.mic_levels(idx, keys, s.mic.aliases)
      baselines[i] = {}
      for k, a in pairs(base) do
        baselines[i][K.upper(k)] = { min = a.min, max = a.max }
        K.log("     写之前 %-10s n=%3d  min=%s  max=%s", K.upper(k), a.n, tostring(a.min), tostring(a.max))
      end
      K.apply_group_mics(idx, s.mic.spec, s.mic.aliases)
    elseif s.mic and s.mic.mode == "snapshot" then
      K.log("  —— 麦克风：走 snapshot（加密库，group 音量写不住）——")
    elseif s.mic and s.mic.mode == "skipped" then
      K.log("  —— 麦克风：%s ——", tostring(s.mic.note))
    end

    if s.name and s.name ~= "" then K.try("  set_instrument_name", Kontakt.set_instrument_name, idx, s.name) end
    if s.midi then K.try("  set_instrument_midi_channel", Kontakt.set_instrument_midi_channel, idx, s.midi) end
    if s.out then K.try("  set_instrument_output_channel", Kontakt.set_instrument_output_channel, idx, s.out) end
    if s.vol then K.try("  set_instrument_volume", Kontakt.set_instrument_volume, idx, s.vol) end
    if s.pan then K.try("  set_instrument_pan", Kontakt.set_instrument_pan, idx, s.pan) end
    if s.options and next(s.options) ~= nil then K.try("  set_instrument_options", Kontakt.set_instrument_options, idx, s.options) end
  end
end

-- ---------------------------------------------------------------- A5 存盘
K.log("\n---- 库类型（受保护 = 加密/Player，group 音量那条路对它无效）----")
for _, line in ipairs(K.machine_block({ "slot", "protected", "scripts" }, libs, "LIBS")) do K.log(line) end

K.log("\n---- 存盘 ----")
K.try("save_multi", Kontakt.save_multi, JOB.out_nkm, { mode = JOB.save_mode or "patch" })
local info = Kontakt.get_file_info(JOB.out_nkm)
if info ~= nil then
  local bits = {}
  if type(info) == "table" then
    for k, v in pairs(info) do bits[#bits + 1] = string.format("%s=%s", tostring(k), tostring(v)) end
    table.sort(bits)
  else
    bits[1] = tostring(info)
  end
  K.log("[ OK ] 文件已写出 -> %s  %s", JOB.out_nkm, table.concat(bits, "  "))
else
  K.log("[FAIL] 文件没写出来 -> %s", JOB.out_nkm)
end

-- ---------------------------------------------------------------- A6 重载 + 回读
K.log("\n---- 重载回读（判断参数是否真写进文件）----")
local reloaded = K.try("load_multi", Kontakt.load_multi, JOB.out_nkm)
local rows = reloaded and K.dump_all_slots() or {}
K.log("  槽位数 = %d", #rows)
for _, line in ipairs(K.machine_block(K.SLOT_COLS, rows, "SLOTS")) do K.log(line) end

-- 麦克风读数（未加密库才有意义；加密库重载后会被库复位）
-- 每个期望的麦克风都出一行，找不到的 n=0 —— 这样 Node 侧能区分「别名没覆盖」和「库复位」
local mics = {}
for i, s in ipairs(JOB.slots) do
  local idx = placed[i]
  if idx and s.mic and s.mic.spec then
    local keys = {}
    for k in pairs(s.mic.spec) do
      if k ~= "others" then keys[#keys + 1] = K.upper(k) end
    end
    table.sort(keys)
    local lv = K.mic_levels(idx, keys, s.mic.aliases)
    for _, k in ipairs(keys) do
      local a = lv[k] or { n = 0, min = nil, max = nil }
      local b = (baselines[i] or {})[k] or {}
      mics[#mics + 1] = { slot = s.slot, mic = k, n = a.n, min = a.min, max = a.max, base_min = b.min, base_max = b.max }
    end
  end
end
table.sort(mics, function(a, b)
  if tostring(a.slot) ~= tostring(b.slot) then return tostring(a.slot) < tostring(b.slot) end
  return tostring(a.mic) < tostring(b.mic)
end)
for _, line in ipairs(K.machine_block({ "slot", "mic", "n", "min", "max", "base_min", "base_max" }, mics, "MICS")) do K.log(line) end

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
