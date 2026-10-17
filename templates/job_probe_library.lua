-- job_probe_library.lua —— 进新库先探测：库类型、group 名规律、麦克风候选
--
-- 两种模式：
--   JOB.mode = "patches"  对 JOB.patches 里每个 .nki 做一遍普查
--   JOB.mode = "api"      把 Kontakt 这张表里能用的函数列出来（确认某版本有没有某个 API）
-- 由 kontakt_probe_library 生成。

local K = dofile("@LIB@")

local JOB = @JOB@

K.log("==== 库探测 ====")
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))

-- ---------------------------------------------------------------- 模式一：列 API
if JOB.mode == "api" then
  K.log("\n-------- Kontakt 表里的函数/常量 --------")
  local names = {}
  local ok = pcall(function()
    for k, v in pairs(Kontakt) do
      names[#names + 1] = { key = tostring(k), kind = type(v) }
    end
  end)
  if not ok or #names == 0 then
    K.log("[WARN] pairs(Kontakt) 取不到 —— 这个版本的表可能不给遍历")
  end
  table.sort(names, function(a, b) return a.key < b.key end)
  local groups = {}
  for _, n in ipairs(names) do
    local pre = string.match(n.key, "^(%a+)_") or "(其它)"
    groups[pre] = groups[pre] or {}
    table.insert(groups[pre], n.key .. " : " .. n.kind)
  end
  local prefixes = {}
  for p in pairs(groups) do prefixes[#prefixes + 1] = p end
  table.sort(prefixes)
  for _, p in ipairs(prefixes) do
    K.log("\n  -- %s (%d)", p, #groups[p])
    for _, line in ipairs(groups[p]) do K.log("     %s", line) end
  end
  K.log("\n合计 %d 个键", #names)
  K.log("[ OK ] 关心这几个：%s", JOB.check and table.concat(JOB.check, ", ") or "（未指定）")
  for _, want in ipairs(JOB.check or {}) do
    local has = false
    for _, n in ipairs(names) do if n.key == want then has = true break end end
    K.log("[%s] API %s", has and " OK " or "FAIL", want)
  end
  K.log("\n==== end ====")
  K.write_report(JOB.report)
  os.exit(0)
end

-- ---------------------------------------------------------------- 模式二：逐 patch 普查
local keywords = JOB.keywords or { "CLOSE", "AB", "TREE", "SURROUND", "SOLO", "MAIN", "MIX", "ROOM", "SPOT", "AMB", "DECCA", "FULL" }

for i, p in ipairs(JOB.patches) do
  K.log("\n======== [%d/%d] %s", i, #JOB.patches, p)
  K.try("reset_multi", Kontakt.reset_multi)
  local ok, idx = K.try("load_instrument", Kontakt.load_instrument, p)
  if ok and type(idx) == "number" then
    local si = K.script_info(idx)
    K.log("[ OK ] 库类型：%s", si.protected and "受保护（加密/Player → 麦克风只能走 snapshot）" or "未保护（可直接写 group 音量）")
    if #si.names > 0 then K.log("       脚本槽：%s", table.concat(si.names, " | ")) end
    local _, nz = pcall(Kontakt.get_num_zones, idx)
    K.log("[ OK ] 乐器名=%s  group=%s  zone=%s", tostring(Kontakt.get_instrument_name(idx)),
      tostring(Kontakt.get_num_groups(idx)), tostring(nz))

    local ng, counts, order = K.group_census(idx)
    K.log("   —— group 名字（前 %d 个，按出现次数）——", JOB.census or 20)
    for j = 1, math.min(#order, JOB.census or 20) do
      K.log("      %5d x  %s", counts[order[j]], order[j])
    end

    -- 精确命中关键词的 group 名
    K.log("   —— 精确命中关键词 ——")
    local hit = false
    for _, nm in ipairs(order) do
      for _, kw in ipairs(keywords) do
        if K.upper(nm) == K.upper(kw) then
          K.log("      %5d x  %s  ->  建议别名 %s", counts[nm], nm, kw)
          hit = true
          break
        end
      end
    end
    if not hit then K.log("      （没有精确命中，看下面的词频）") end

    -- 词频：把 group 名切成词，找出「出现 >=2 次、但不是所有 group 都有」的词 —— 麦克风名的候选
    local words, total = {}, 0
    for _, nm in ipairs(order) do
      total = total + counts[nm]
      local seen = {}
      for w in string.gmatch(K.upper(nm), "[%w#]+") do
        if not seen[w] then
          seen[w] = true
          words[w] = (words[w] or 0) + counts[nm]
        end
      end
    end
    local cand = {}
    for w, n in pairs(words) do
      if n >= 2 and n < total * 0.9 and #w > 1 then cand[#cand + 1] = { w = w, n = n } end
    end
    table.sort(cand, function(a, b)
      if a.n ~= b.n then return a.n > b.n end
      return a.w < b.w
    end)
    K.log("   —— 词频候选（作为别名表线索，需你确认）——")
    for j = 1, math.min(#cand, JOB.words or 25) do
      K.log("      %5d 次  %s", cand[j].n, cand[j].w)
    end

    if #si.names == 0 then
      K.log("   —— 未保护：直接读麦克风名对应的音量区间 ——")
      local lv = K.mic_levels(idx, keywords)
      local keys = {}
      for k in pairs(lv) do keys[#keys + 1] = k end
      table.sort(keys)
      for _, k in ipairs(keys) do
        local a = lv[k]
        K.log("      %-10s n=%3d  min=%s  max=%s", k, a.n, tostring(a.min), tostring(a.max))
      end
    end
  end
end

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
