// scripts/vepro-bridge.mjs —— Kontakt multi → VE Pro 通道（"薄桥"）
//
// 现实约束（实测）：**VEP 的 instrument state 只能由 Kontakt 自己产出**——
//   自己拼 state 会被 Kontakt 静默拒绝；所以每条 multi 需要**人工在 VEP 里加载一次**
//   （在 VEP 的 Kontakt 面板里用 File → Load multi；⚠️ 拖动 .nkm 进 VEP 会让 Kontakt 崩）。
// 之后由本工具接管：缓存 state / 存成 VEP 用户预设 / 灌到任意通道 / 校验。
//
// 用法：
//   --list                                    列出已缓存的 multi（含"源 .nkm 是否变了"）
//   --cache --instance=<id> --channel=<addr> --multi="<名>"   把某通道的 state 缓存下来 + savepreset
//   --apply --instance=<id> --multi="<名>" [--title=<通道名>] [--channel=<addr>]
//                                             用缓存建/灌通道（不给 --channel 就新建一条 Kontakt 通道）
//   --verify --instance=<id> --channel=<addr> --multi="<名>"  导出并与缓存比对
//
// 说明：VEP 的 API 是本地 stdio JSON-RPC 服务端（vepro-api-mcp.exe），本工具自己拉起来驱动，
// 大 payload 走管道、不进对话。

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { EXIT, bullet, parseArgs, tableText, workspaceDir } from "./lib.mjs"

const MCP_EXE = "C:/ProgramData/VSL/Vienna Ensemble Pro/mcp/vepro-api-mcp.exe"
const KONTAKT_PLUGIN = "5653544e-694b-386b-6f6e-74616b742038" // "Kontakt 8" VST3
const args = parseArgs()
const ws = workspaceDir(args)
const cacheDir = `${ws}/Generated/_vepro`.replace(/\\/g, "/")
const repDir = `${ws}/Reports`.replace(/\\/g, "/")
if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })

// ---------------------------------------------------------------- VEP 客户端（stdio JSON-RPC）
function connect() {
  const child = spawn(MCP_EXE, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let buf = ""
  const waiting = new Map()
  child.stdout.on("data", (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
    }
  })
  child.stderr.on("data", () => {})
  let id = 0
  const rpc = (method, params) => new Promise((res) => { const myId = ++id; waiting.set(myId, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n") })
  return {
    close: () => { try { child.kill() } catch {} },
    async init() {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "kontakt-bridge", version: "1" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      await new Promise((r) => setTimeout(r, 300))
      await this.call("vepro_api_agent_instructions_get", {}) // 门禁：必须先读一次
    },
    async call(name, a) {
      const r = await rpc("tools/call", { name, arguments: a })
      const c = r?.result?.content?.[0]?.text ?? r?.result ?? r
      try { return JSON.parse(typeof c === "string" ? c : JSON.stringify(c)) } catch { return c }
    },
  }
}
const data = (x) => x?.response?.data ?? x?.data ?? x
const fail = (msg) => { console.error(`[失败] ${msg}`); process.exit(EXIT.ISSUES) }

// ---------------------------------------------------------------- 子命令
const vep = connect()
await vep.init()
const t0 = Date.now()

if (args.bool("list") || (!args.has("cache") && !args.has("apply") && !args.has("verify"))) {
  const files = existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.endsWith(".json")) : []
  const rows = files.map((f) => {
    const meta = JSON.parse(readFileSync(`${cacheDir}/${f}`, "utf8"))
    let stale = "—"
    if (meta.nkm && existsSync(meta.nkm)) {
      const st = statSync(meta.nkm)
      stale = st.size === meta.nkmSize ? "没变" : `⚠ 变了（${meta.nkmSize} → ${st.size} 字节）`
    } else if (meta.nkm) stale = "⚠ .nkm 不在了"
    return { multi: meta.multi, "state 字节": meta.bytes, "缓存于": meta.at, 源文件: stale, 预设: meta.presetPath ?? "—" }
  })
  console.log(bullet(`已缓存的 multi（${cacheDir}）`))
  console.log(rows.length ? tableText(["multi", "state 字节", "缓存于", "源文件", "预设"], rows) : "（还没有缓存。先 --cache）")
  vep.close()
  process.exit(EXIT.OK)
}

const multi = args.get("multi", "")
const iid = args.get("instance", "")
if (!multi) fail("要 --multi=\"<multi 名>\"")
if (!iid) fail("要 --instance=<实例 GUID>（用 instance/list 查）")
const stateFile = `${cacheDir}/${multi.replace(/[\\/:*?"<>|]/g, "_")}.state`
const metaFile = `${cacheDir}/${multi.replace(/[\\/:*?"|]/g, "_")}.json`

// ---------------------------------------------------------------- cache：导出 + 存预设
if (args.bool("cache")) {
  const addr = args.get("channel", "")
  if (!addr) fail("--cache 要 --channel=<通道地址>（instance/channelsummary 里的 channelAddress）")
  console.log(bullet(`缓存 VEP state：${multi}`))

  const ex = data(await vep.call("vepro_channel_instrument_state_export", { instanceId: iid, channelAddress: addr }))
  const ref = ex?.blobRef
  if (!ref?.blobId) fail(`导出失败：${JSON.stringify(ex).slice(0, 200)}`)
  console.log(`  导出：${ref.bytes} 字节  sha256 ${String(ref.sha256).slice(0, 16)}…`)

  // 分块拉成文件（每次 ≤2048 字节，避免响应被 deferred）
  const parts = []
  let off = 0
  while (off < ref.bytes) {
    const len = Math.min(2048, ref.bytes - off)
    const r = data(await vep.call("vepro_api_blob_read", { blobRef: { blobId: ref.blobId, bytes: ref.bytes, sha256: ref.sha256 }, offset: off, length: len }))
    const b64 = r?.base64 ?? r?.data ?? (typeof r === "string" ? r : "")
    const buf = Buffer.from(typeof b64 === "string" ? b64 : "", "base64")
    if (!buf.length) fail(`blob/read 在偏移 ${off} 读回 0 字节`)
    parts.push(buf)
    off += buf.length
  }
  const all = Buffer.concat(parts)
  const sha = createHash("sha256").update(all).digest("hex")
  writeFileSync(stateFile, all)
  console.log(`  已写：${stateFile}（${all.length} 字节，sha256 ${sha.slice(0, 16)}…${sha === ref.sha256 ? " 与导出一致 ✅" : " ⚠ 与导出不一致"}）`)

  // 存成 VEP 用户预设（按名字以后也能载入）
  const presetPath = args.get("preset", `AI/${multi}`)
  let saved = false
  try {
    const sp = data(await vep.call("vepro_channel_instrument_savepreset", { instanceId: iid, channelAddress: addr, path: presetPath, overwrite: true, idempotencyKey: `sp-${multi}-${Date.now()}` }))
    saved = sp?.saved === true
    console.log(`  savepreset：${saved ? "✅" : "⚠"} ${presetPath}`)
  } catch (e) { console.log(`  savepreset 失败：${String(e.message).slice(0, 120)}`) }

  const nkm = `${ws}/Generated/${multi}.nkm`
  const nkmSt = existsSync(nkm) ? statSync(nkm) : null
  writeFileSync(metaFile, JSON.stringify({
    multi, bytes: all.length, sha256: sha, exportSha: ref.sha256,
    at: new Date().toISOString().slice(0, 19).replace("T", " "),
    instance: iid, channel: addr, presetPath: saved ? presetPath : null,
    nkm: nkmSt ? nkm : null, nkmSize: nkmSt?.size ?? null, nkmMtime: nkmSt?.mtimeMs ?? null,
  }, null, 2) + "\n")
  console.log(`  元数据：${metaFile}`)
  vep.close()
  process.exit(EXIT.OK)
}

// ---------------------------------------------------------------- apply：建/灌通道
if (args.bool("apply")) {
  if (!existsSync(stateFile)) fail(`没有缓存：${stateFile}（先 --cache，或在 VEP 里加载一次这条 multi）`)
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {}
  const bytes = readFileSync(stateFile)
  console.log(bullet(`应用 VEP state：${multi}（${bytes.length} 字节）`))
  if (meta.nkmSize && existsSync(meta.nkm) && statSync(meta.nkm).size !== meta.nkmSize) {
    console.log(`  ⚠ 源 .nkm 之后变过（${meta.nkmSize} → ${statSync(meta.nkm).size} 字节）—— 缓存可能过期，建议在 VEP 里重新加载一次再 --cache`)
  }

  // 注册 blob
  const reg = data(await vep.call("vepro_api_blob_register", { data: bytes.toString("base64"), idempotencyKey: `blob-${multi}-${Date.now()}` }))
  const blobRef = reg?.blobRef ?? reg
  if (!blobRef?.blobId) fail(`blob/register 失败：${JSON.stringify(reg).slice(0, 200)}`)

  let addr = args.get("channel", "")
  if (!addr) {
    // 新建一条 Kontakt 通道
    const title = args.get("title", multi)
    const ch = data(await vep.call("vepro_channel_add", { instanceId: iid, pluginId: KONTAKT_PLUGIN, providerId: "VST3", title, parentFolderAddress: args.get("parent", "root"), idempotencyKey: `ch-${multi}-${Date.now()}` }))
    addr = ch?.channels?.[0]?.channelAddress
    if (!addr) fail(`channel/add 失败：${JSON.stringify(ch).slice(0, 200)}`)
    console.log(`  新建通道：${addr}「${title}」`)
  }

  const set = data(await vep.call("vepro_channel_instrument_state_set", { instanceId: iid, selector: { addresses: [addr] }, blobRef: { blobId: blobRef.blobId, bytes: blobRef.bytes, sha256: blobRef.sha256 }, idempotencyKey: `set-${multi}-${Date.now()}` }))
  const okSet = Array.isArray(set?.results) ? set.results.every((r) => r?.result?.status === "success") : set?.status === "success"
  console.log(`  state/set：${okSet ? "✅ success" : "⚠ " + JSON.stringify(set).slice(0, 160)}`)

  // 校验：再导出，比大小
  await new Promise((r) => setTimeout(r, Number(args.num("settle", 12)) * 1000))
  const ex2 = data(await vep.call("vepro_channel_instrument_state_export", { instanceId: iid, channelAddress: addr }))
  const got = ex2?.bytes ?? ex2?.blobRef?.bytes ?? 0
  const diff = Math.abs(got - bytes.length)
  console.log(`  校验：导出 ${got} 字节 vs 缓存 ${bytes.length}（差 ${diff}）${diff < Math.max(4096, bytes.length * 0.02) ? " ✅ 一致" : " ⚠ 相差过大"}`)
  console.log(`\n通道地址 ${addr}；实例 ${iid}`)
  vep.close()
  process.exit(EXIT.OK)
}

// ---------------------------------------------------------------- verify
if (args.bool("verify")) {
  const addr = args.get("channel", "")
  if (!addr) fail("--verify 要 --channel=<通道地址>")
  const bytes = existsSync(stateFile) ? readFileSync(stateFile) : null
  const ex = data(await vep.call("vepro_channel_instrument_state_export", { instanceId: iid, channelAddress: addr }))
  const got = ex?.bytes ?? 0
  console.log(`通道 ${addr} 的 state = ${got} 字节${bytes ? `；缓存 ${bytes.length} 字节（差 ${Math.abs(got - bytes.length)}）` : ""}`)
  vep.close()
  process.exit(EXIT.OK)
}

vep.close()
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
