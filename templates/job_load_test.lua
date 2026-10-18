-- job_load_test.lua —— 装载体检：这一批 .nki 到底哪个装得开
--
-- 只做 load_instrument（不扫 zone、不读参数）→ 快。失败就是失败（多半是 0 字节采样/patch）。
-- 由 kontakt_load_test 生成。

local K = dofile("@LIB@")
local JOB = @JOB@

K.log("==== 装载体检（%d 个 patch）====", #JOB.patches)
K.log("time: %s   Kontakt %s", os.date("%Y-%m-%d %H:%M:%S"), tostring(Kontakt.version))

local rows, nfail = {}, 0
for i, p in ipairs(JOB.patches) do
  K.try("reset_multi", Kontakt.reset_multi)
  local ok, idx = K.try("load_instrument", Kontakt.load_instrument, p)
  local row = { i = i, loaded = "no", name = "", groups = "", scripts = "", path = p }
  if ok and type(idx) == "number" then
    row.loaded = "yes"
    local o, nm = pcall(Kontakt.get_instrument_name, idx)
    row.name = (o and nm) and tostring(nm) or ""
    local okg, ng = pcall(Kontakt.get_num_groups, idx)
    row.groups = (okg and type(ng) == "number") and ng or ""
    local si = K.script_info(idx)
    row.scripts = string.format("%d%s", #si.names, si.protected and "(受保护)" or "")
    K.log("[ OK ] %s（%s 个 group，脚本 %s）", row.name, tostring(row.groups), row.scripts)
  else
    nfail = nfail + 1
    K.log("[FAIL] 装不上：%s", p)
  end
  rows[#rows + 1] = row
end

K.log("\n---- 装载体检汇总：成功 %d / 失败 %d ----", #rows - nfail, nfail)
for _, l in ipairs(K.machine_block({ "i", "loaded", "name", "groups", "scripts", "path" }, rows, "LOADS")) do K.log(l) end

K.log("\n==== end ====")
K.write_report(JOB.report)
os.exit(0)
