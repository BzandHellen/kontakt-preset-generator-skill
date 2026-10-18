-- job_group_persist.lua —— 库无关的"group 音量能否存活重载"测试
--
-- 对每个 patch：读一遍全 group 音量（记 min/max）→ 全部设成 JOB.db → 存 multi
-- → 重载 → 再读一遍。存活 = 重载后 min/max 都 ≈ JOB.db；复位 = 回到原值（或默认小值）。
-- 由 kontakt_group_persist 生成。

local K = dofile("@LIB@")
local JOB = @JOB@

K.log("==== group 音量持久化测试（全部设为 %s dB）====", tostring(JOB.db))
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))

local function scan(idx)
  local ok, ng = pcall(Kontakt.get_num_groups, idx)
  if not ok or type(ng) ~= "number" then return nil, 0 end
  local mn, mx, n = nil, nil, 0
  for g = 0, ng - 1 do
    local o, v = pcall(Kontakt.get_group_volume, idx, g)
    if o and type(v) == "number" and v == v then
      if mn == nil or v < mn then mn = v end
      if mx == nil or v > mx then mx = v end
      n = n + 1
    end
  end
  return { mn = mn, mx = mx, n = n }, ng
end

local rows = {}
for i, p in ipairs(JOB.patches) do
  K.log("\n---- [%d/%d] %s", i, #JOB.patches, p)
  K.try("reset_multi", Kontakt.reset_multi)
  local ok, idx = K.try("load_instrument", Kontakt.load_instrument, p)
  local row = { i = i, patch = p, groups = 0, before_min = "", before_max = "", after_min = "", after_max = "", persisted = "?" }
  if ok and type(idx) == "number" then
    local before, ng = scan(idx)
    row.groups = ng
    row.before_min, row.before_max = before and before.mn or "", before and before.mx or ""
    K.log("   写之前：min=%s max=%s（%d 个 group）", tostring(row.before_min), tostring(row.before_max), ng)

    local set = 0
    for g = 0, ng - 1 do
      local o = pcall(Kontakt.set_group_volume, idx, g, JOB.db)
      if o then set = set + 1 end
    end
    K.log("   已写 %d 个 group = %s dB", set, tostring(JOB.db))

    local out = (JOB.outdir or "") .. "persist_" .. i .. ".nkm"
    K.try("set_instrument_name", Kontakt.set_instrument_name, idx, "PERSIST TEST " .. i)
    K.try("set_multi_name", Kontakt.set_multi_name, "PERSIST " .. i)
    -- ⚠️ 先删旧文件：否则 save 失败时下面会"重载"到上一次留下的旧文件，
    --    而旧文件里恰好也是 −12（上次测试写的）→ 判成"能存住"，**假 PASS**（2026-10-18 踩过）。
    os.remove(out)
    local savedOk = K.try("save_multi", Kontakt.save_multi, out, { mode = "patch" })
    -- ⚠️ save_multi 异步落盘 → 用 K.wait_file 等（否则会假 FAIL）
    local info = K.wait_file(out, 20)
    local fileNew = info ~= nil
    K.log("   存盘：save=%s  文件=%s", tostring(savedOk), fileNew and "有（新写的）" or "没有")

    if not (savedOk and fileNew) then
      K.log("[FAIL] **存不进去** —— 这个库/这个 patch 的 multi 现在写不出文件（后面不判了）")
      row.persisted = "save-failed"
      rows[#rows + 1] = row
      goto continue
    end

    K.try("reset_multi(2nd)", Kontakt.reset_multi)
    -- ⚠️ load_multi 的返回值**不是** instrument 索引，必须用 get_instrument_indices 取
    local ok2 = K.try("load_multi", Kontakt.load_multi, out)
    local idx2 = nil
    if ok2 then
      local oi, t = pcall(Kontakt.get_instrument_indices)
      if oi and type(t) == "table" and t[1] then idx2 = t[1] end
    end
    if idx2 then
      local after = scan(idx2)
      row.after_min, row.after_max = after and after.mn or "", after and after.mx or ""
      K.log("   重载后：min=%s max=%s（%s 个 group）", tostring(row.after_min), tostring(row.after_max), tostring(after and after.n))
      local okp = after and K.eq_num(after.mn, JOB.db, 0.05) and K.eq_num(after.mx, JOB.db, 0.05)
      row.persisted = okp and "yes" or "no"
      K.log("[%s] 存活：%s", okp and " OK " or "FAIL", okp and "全部 ≈ " .. tostring(JOB.db) .. " dB（能存住）" or "没保住（库复位了）")
    else
      K.log("[FAIL] 重载后取不到 instrument 索引，判不了")
      row.persisted = "error"
    end
  else
    row.persisted = "loadfail"
  end
  rows[#rows + 1] = row
  ::continue::
end

K.log("\n---- 机器可读 ----")
for _, l in ipairs(K.machine_block({ "i", "groups", "before_min", "before_max", "after_min", "after_max", "persisted", "patch" }, rows, "PERSIST")) do
  K.log(l)
end

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
