-- job_probe_structure.lua —— 探"技法/力度层是脚本实现的，还是 Kontakt 原生实现的"
--
-- 判据：
--   · 库脚本（尤其 protected 的）→ 技法在脚本里 → **不可程序化设置**，只能靠 snapshot
--   · group start 条件（get_group_start_options）→ 原生机制 → **可程序化设**
--   · zone 的力度范围分布 → 若不同 group 覆盖不同力度段 = 原生"力度切层" → **可程序化设**
-- 由 kontakt_probe_library --structure 生成。只读。

local K = dofile("@LIB@")

local JOB = @JOB@

K.log("==== 结构探测：技法/力度层是脚本还是原生 ====")
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))

-- 把 get_group_start_options 返回的表展开成一行（递归、去 tab/换行、限长）
local function ser(v, depth, maxdepth, seen)
  if type(v) ~= "table" then
    return tostring(v)
  end
  depth = depth or 0
  maxdepth = maxdepth or 3
  seen = seen or {}
  if seen[v] then return "<cycle>" end
  if depth >= maxdepth then
    return "{…}"
  end
  seen[v] = true
  local bits = {}
  for k, x in pairs(v) do
    local kk = type(k) == "number" and tostring(k) or tostring(k)
    bits[#bits + 1] = kk .. ":" .. ser(x, depth + 1, maxdepth, seen)
  end
  table.sort(bits)
  seen[v] = nil
  return "{" .. table.concat(bits, " , ") .. "}"
end

local function flat(t, maxlen)
  maxlen = maxlen or 400
  if type(t) ~= "table" then return tostring(t) end
  if next(t) == nil then return "" end
  local s = ser(t)
  s = string.gsub(s, "[\t\r\n]", " ")
  if #s > maxlen then s = string.sub(s, 1, maxlen) .. "…" end
  return s
end

local maxs = Kontakt.max_num_scripts or 5

for i, p in ipairs(JOB.patches) do
  K.log("\n======== [%d/%d] %s", i, #JOB.patches, p)
  K.try("reset_multi", Kontakt.reset_multi)
  local ok, idx = K.try("load_instrument", Kontakt.load_instrument, p)
  if ok and type(idx) == "number" then
    K.log("[ OK ] 乐器名=%s", tostring(Kontakt.get_instrument_name(idx)))

    -- 脚本槽
    local scripts, nprot = {}, 0
    for s = 0, maxs - 1 do
      local o, nm = pcall(Kontakt.get_instrument_script_name, idx, s)
      if o and nm and tostring(nm) ~= "" then
        local _, pr = pcall(Kontakt.is_instrument_script_protected, idx, s)
        local _, by = pcall(Kontakt.is_instrument_script_bypassed, idx, s)
        local _, src = pcall(Kontakt.get_instrument_script_source, idx, s)
        scripts[#scripts + 1] = {
          slot = s,
          name = tostring(nm),
          protected = tostring(pr),
          bypassed = tostring(by),
          src_len = type(src) == "string" and #src or 0,
        }
        if pr then nprot = nprot + 1 end
      end
    end
    K.log("---- 脚本槽（%d 个，其中受保护 %d）----", #scripts, nprot)
    for _, line in ipairs(K.machine_block({ "slot", "name", "protected", "bypassed", "src_len" }, scripts, "SCRIPTS" .. i)) do K.log(line) end

    -- group：start 条件 + zone 分布
    local okg, ng = pcall(Kontakt.get_num_groups, idx)
    ng = (okg and type(ng) == "number") and ng or 0
    local okz, nz = pcall(Kontakt.get_num_zones, idx)
    nz = (okz and type(nz) == "number") and nz or 0
    K.log("---- group=%d  zone=%d ----", ng, nz)

    -- zone 一趟扫：按 zone_group 归到 group 上，累计 key/vel/去重
    local agg = {}
    local zlimit = JOB.zones or 150000
    local scanned = math.min(nz, zlimit)
    for z = 0, scanned - 1 do
      local o1, gz = pcall(Kontakt.get_zone_group, idx, z)
      if o1 and type(gz) == "number" then
        local a = agg[gz]
        if a == nil then
          a = { n = 0, klo = nil, khi = nil, vlo = nil, vhi = nil, vset = {} }
          agg[gz] = a
        end
        a.n = a.n + 1
        local _, kl = pcall(Kontakt.get_zone_low_key, idx, z)
        local _, kh = pcall(Kontakt.get_zone_high_key, idx, z)
        local _, vl = pcall(Kontakt.get_zone_low_velocity, idx, z)
        local _, vh = pcall(Kontakt.get_zone_high_velocity, idx, z)
        if type(kl) == "number" then a.klo = (a.klo == nil or kl < a.klo) and kl or a.klo end
        if type(kh) == "number" then a.khi = (a.khi == nil or kh > a.khi) and kh or a.khi end
        if type(vl) == "number" then a.vlo = (a.vlo == nil or vl < a.vlo) and vl or a.vlo end
        if type(vh) == "number" then a.vhi = (a.vhi == nil or vh > a.vhi) and vh or a.vhi end
        if type(vl) == "number" and type(vh) == "number" then
          a.vset[string.format("%d-%d", vl, vh)] = true
        end
      end
    end
    if scanned < nz then K.log("（zone 太多，只扫了前 %d 个，共 %d 个）", scanned, nz) end

    local grows, nstart, nvelsplit = {}, 0, 0
    for g = 0, ng - 1 do
      local _, nm = pcall(Kontakt.get_group_name, idx, g)
      local _, vol = pcall(Kontakt.get_group_volume, idx, g)
      local _, pm = pcall(Kontakt.get_group_playback_mode, idx, g)
      local o, so = pcall(Kontakt.get_group_start_options, idx, g)
      local desc = o and flat(so) or ""
      local has_start = (o and type(so) == "table" and next(so) ~= nil) and "yes" or ""
      if has_start ~= "" then nstart = nstart + 1 end
      local a = agg[g]
      local vcount = 0
      if a then
        for _ in pairs(a.vset) do vcount = vcount + 1 end
      end
      if vcount > 1 then nvelsplit = nvelsplit + 1 end
      grows[#grows + 1] = {
        g = g,
        name = tostring(nm or ""),
        vol = vol ~= nil and vol or "",
        playmode = tostring(pm or ""),
        has_start = has_start,
        start = desc,
        zones = a and a.n or "",
        klo = a and a.klo or "",
        khi = a and a.khi or "",
        vlo = a and a.vlo or "",
        vhi = a and a.vhi or "",
        vel_buckets = a and vcount or "",
      }
    end
    for _, line in ipairs(K.machine_block({ "g", "name", "vol", "playmode", "has_start", "start", "zones", "klo", "khi", "vlo", "vhi", "vel_buckets" }, grows, "GROUPS" .. i)) do K.log(line) end

    -- 结论线索
    K.log("\n---- 判据汇总 ----")
    K.log("[ OK ] 脚本槽 = %d（受保护 %d）", #scripts, nprot)
    K.log("[ OK ] 有 start 条件的 group = %d / %d", nstart, ng)
    K.log("[ OK ] 自己覆盖多段力度范围的 group（原生力度切层）= %d / %d", nvelsplit, ng)
  end
end

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
