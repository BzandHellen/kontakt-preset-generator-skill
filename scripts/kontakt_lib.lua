-- kontakt_lib.lua —— Kontakt 作业脚本的公共部分
--
-- 由工作区里的作业脚本 dofile 进来（绝对路径）。所有作业共享同一套：
-- 日志 / 报告落盘 / 机器可读块 / group 名匹配 / 参数落点 / PASS-FAIL 表。
--
-- 约定：不要在函数名里用 Lua 里会撞名的东西；所有 Kontakt 调用都 pcall 包住。

local M = {}

M.LOG = {}

local function fmt(...)
  if select("#", ...) == 0 then return "" end
  return string.format(...)
end

function M.log(s, ...)
  local line = select("#", ...) > 0 and string.format(s, ...) or tostring(s)
  M.LOG[#M.LOG + 1] = line
  print(line)
  return line
end

-- 和已有脚本一致的 [ OK ] / [FAIL] 前缀（reports.mjs 会数它们）
function M.try(name, fn, ...)
  local ok, a = pcall(fn, ...)
  M.log("[%s] %s -> %s", ok and " OK " or "FAIL", name, a == nil and "nil" or tostring(a))
  return ok, a
end

function M.upper(s)
  return string.upper(tostring(s or ""))
end

function M.tonum(v)
  if type(v) == "number" then return v end
  local n = tonumber(v)
  return n
end

-- 数值比较：-math.huge 按相等算；其它按 eps 容差
function M.eq_num(a, b, eps)
  a, b = M.tonum(a), M.tonum(b)
  if a == nil or b == nil then return false end
  if a == b then return true end
  if a == -math.huge or b == -math.huge or a == math.huge or b == math.huge then return false end
  return math.abs(a - b) <= (eps or 0.01)
end

function M.pass_fail(label, expected, actual, eps)
  local ok = M.eq_num(expected, actual, eps)
  M.log("[%s] %s  期望=%s  实际=%s", ok and " OK " or "FAIL", label, tostring(expected), tostring(actual))
  return ok
end

function M.pass_eq(label, expected, actual)
  local ok = tostring(expected) == tostring(actual)
  M.log("[%s] %s  期望=%s  实际=%s", ok and " OK " or "FAIL", label, tostring(expected), tostring(actual))
  return ok
end

-- ---------------------------------------------------------------- 报告
function M.machine_block(cols, rows)
  local out = { "---- MACHINE ----", table.concat(cols, "\t") }
  for _, r in ipairs(rows) do
    local cells = {}
    for i, c in ipairs(cols) do
      local v = r[c]
      if v == nil then v = ""
      elseif type(v) == "number" and v == -math.huge then v = "-inf"
      elseif type(v) == "number" and v == math.huge then v = "inf"
      elseif type(v) == "boolean" then v = tostring(v) end
      cells[i] = tostring(v)
    end
    out[#out + 1] = table.concat(cells, "\t")
  end
  out[#out + 1] = "---- /MACHINE ----"
  return out
end

function M.write_report(path)
  local f = io.open(path, "w")
  if not f then
    print("REPORT WRITE FAILED: " .. tostring(path))
    return false
  end
  f:write(table.concat(M.LOG, "\n"), "\n")
  f:close()
  print("REPORT WRITTEN: " .. path)
  return true
end

-- 纯 CSV（无引号版，值里不会出现逗号/换行）
function M.write_csv(path, cols, rows)
  local out = { table.concat(cols, ",") }
  for _, r in ipairs(rows) do
    local cells = {}
    for i, c in ipairs(cols) do
      local v = r[c]
      if v == nil then v = ""
      elseif type(v) == "number" and v == -math.huge then v = "-inf"
      elseif type(v) == "number" and v == math.huge then v = "inf"
      else v = tostring(v) end
      cells[i] = v
    end
    out[#out + 1] = table.concat(cells, ",")
  end
  local f = io.open(path, "w")
  if not f then return false end
  f:write(table.concat(out, "\n"), "\n")
  f:close()
  return true
end

-- ---------------------------------------------------------------- 库类型 / group
-- 受保护（加密 / Player 库）的判据：任一脚本槽 is_instrument_script_protected = true
function M.script_info(idx)
  local names, protected = {}, false
  local maxs = Kontakt.max_num_scripts or 5
  for s = 0, maxs - 1 do
    local ok, nm = pcall(Kontakt.get_instrument_script_name, idx, s)
    if ok and nm and tostring(nm) ~= "" then
      local _, pr = pcall(Kontakt.is_instrument_script_protected, idx, s)
      names[#names + 1] = string.format("%s%s", tostring(nm), pr and "(protected)" or "")
      if pr then protected = true end
    end
  end
  return { protected = protected, names = names }
end

-- group 名字普查：返回 总数 / 名字出现次数 / 去重后的名字（按出现次数降序）
function M.group_census(idx, cap)
  local ok, ng = pcall(Kontakt.get_num_groups, idx)
  if not ok or type(ng) ~= "number" then return 0, {}, {} end
  local counts, order = {}, {}
  for g = 0, ng - 1 do
    local o, nm = pcall(Kontakt.get_group_name, idx, g)
    local key = (o and nm) and tostring(nm) or "<err>"
    if counts[key] == nil then counts[key] = 0; order[#order + 1] = key end
    counts[key] = counts[key] + 1
  end
  table.sort(order, function(a, b)
    if counts[a] ~= counts[b] then return counts[a] > counts[b] end
    return a < b
  end)
  return ng, counts, order, cap
end

-- 三种匹配：精确 → 结尾词 → 包含（多命中时取最长键，避免 "AB" 撞进别的词）
function M.match_mic(upper_name, keys)
  for _, k in ipairs(keys) do
    if upper_name == k then return k, "exact" end
  end
  local best, how
  for _, k in ipairs(keys) do
    if #k > 0 and string.sub(upper_name, -#k) == k then
      if best == nil or #k > #best then best, how = k, "suffix" end
    end
  end
  if best then return best, how end
  for _, k in ipairs(keys) do
    if #k > 0 and string.find(upper_name, k, 1, true) then
      if best == nil or #k > #best then best, how = k, "contains" end
    end
  end
  return best, how
end

-- spec: { CLOSE = -6, SOLO = "off", others = "off" }
-- 返回 keys（去掉 others）与 others 值
function M.split_spec(spec)
  local keys, others = {}, nil
  for k, v in pairs(spec or {}) do
    if k == "others" then others = v else keys[#keys + 1] = M.upper(k) end
  end
  table.sort(keys)
  return keys, others, spec
end

function M.spec_value(spec, key)
  for k, v in pairs(spec or {}) do
    if M.upper(k) == key then
      if v == "off" or v == "mute" then return -math.huge end
      return M.tonum(v)
    end
  end
  return nil
end

-- 写 group 音量（未加密库这条路）
function M.apply_group_mics(idx, spec)
  local keys, others = M.split_spec(spec)
  local ok, ng = pcall(Kontakt.get_num_groups, idx)
  if not ok or type(ng) ~= "number" then return { err = "get_num_groups 失败" } end
  local hits = {}
  for g = 0, ng - 1 do
    local o, nm = pcall(Kontakt.get_group_name, idx, g)
    if o and nm then
      local u = M.upper(nm)
      local key, how = M.match_mic(u, keys)
      local val
      if key then val = M.spec_value(spec, key) end
      if val == nil and others ~= nil then
        if others == "off" or others == "mute" then val = -math.huge else val = M.tonum(others) end
        key, how = "(others)", "others"
      end
      if val ~= nil then
        pcall(Kontakt.set_group_volume, idx, g, val)
        local h = hits[key]
        if h == nil then h = { key = key, how = how, n = 0 }; hits[key] = h end
        h.n = h.n + 1
      end
    end
  end
  local list, names = {}, {}
  for _, h in pairs(hits) do list[#list + 1] = h; names[#names + 1] = h.key end
  table.sort(list, function(a, b) return a.key < b.key end)
  for _, h in ipairs(list) do
    M.log("   写入 group：%-12s (%s)  %d 个", h.key, h.how, h.n)
  end
  if #list == 0 then M.log("   ⚠ 一个 group 都没匹配上 —— 检查 mic 别名表") end
  return hits
end

-- 读某个麦克风名下所有 group 的音量区间
function M.mic_levels(idx, keys)
  local ok, ng = pcall(Kontakt.get_num_groups, idx)
  if not ok or type(ng) ~= "number" then return {} end
  local agg = {}
  for g = 0, ng - 1 do
    local o, nm = pcall(Kontakt.get_group_name, idx, g)
    if o and nm then
      local key = M.match_mic(M.upper(nm), keys)
      if key then
        local _, v = pcall(Kontakt.get_group_volume, idx, g)
        local a = agg[key]
        if a == nil then a = { n = 0, min = nil, max = nil }; agg[key] = a end
        a.n = a.n + 1
        if type(v) == "number" then
          if a.min == nil or v < a.min then a.min = v end
          if a.max == nil or v > a.max then a.max = v end
        end
      end
    end
  end
  return agg
end

-- ---------------------------------------------------------------- 槽位
-- 读一个 instrument 的全部可读参数（用 instrument_idx，不是 slot 序号）
function M.slot_row(idx)
  local function g(fn, ...)
    local ok, v = pcall(fn, idx, ...)
    if not ok then return "" end
    if type(v) == "number" and v == -math.huge then return "-inf" end
    if type(v) == "boolean" then return tostring(v) end
    if v == nil then return "" end
    return v
  end
  local o = {}
  local ok, opts = pcall(Kontakt.get_instrument_options, idx)
  if ok and type(opts) == "table" then o = opts end
  return {
    idx = idx,
    slot = math.floor(idx / 128),
    name = g(Kontakt.get_instrument_name),
    midi = g(Kontakt.get_instrument_midi_channel),
    out = g(Kontakt.get_instrument_output_channel),
    vol = g(Kontakt.get_instrument_volume),
    pan = g(Kontakt.get_instrument_pan),
    mute = g(Kontakt.get_instrument_mute),
    solo = g(Kontakt.get_instrument_solo),
    tune = g(Kontakt.get_instrument_tune),
    poly = g(Kontakt.get_instrument_polyphony),
    keysw = o.key_switch == nil and "" or o.key_switch,
    kmin = o.key_range_from == nil and "" or o.key_range_from,
    kmax = o.key_range_to == nil and "" or o.key_range_to,
    vmin = o.velocity_range_from == nil and "" or o.velocity_range_from,
    vmax = o.velocity_range_to == nil and "" or o.velocity_range_to,
    trans = o.midi_transpose == nil and "" or o.midi_transpose,
  }
end

M.SLOT_COLS = { "slot", "idx", "name", "midi", "out", "vol", "pan", "mute", "solo", "tune", "poly", "keysw", "kmin", "kmax", "vmin", "vmax", "trans" }

function M.dump_all_slots()
  local rows = {}
  local ok, t = pcall(Kontakt.get_instrument_indices)
  if not ok or type(t) ~= "table" then return rows end
  local list = {}
  for _, idx in ipairs(t) do list[#list + 1] = idx end
  table.sort(list)
  for _, idx in ipairs(list) do rows[#rows + 1] = M.slot_row(idx) end
  return rows
end

return M
