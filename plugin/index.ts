/**
 * Kontakt preset generator tools — bundled with the `kontakt-preset-generator-skill`.
 *
 * 把 skill 的 scripts/*.mjs 注册成 OpenCode 工具（`kontakt` 命名空间，Code Mode 可用），
 * 这样 agent 不必手搓 node 命令行。
 *
 * 注册方式（与本仓库姊妹 skill vsl-synchron-player 同款）：
 * `~/.config/opencode/plugins/kontakt-preset-generator-skill`
 *   ┘ junction → `<skill>\plugin`
 * `plugins/` 下的插件会被自动发现。改了插件代码后 `opencode service restart`。
 */
import { Plugin } from "@opencode/plugin"
import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// 定位 skill 自己的目录：优先插件自身位置（直接挂或经 junction 都能用），否则退到已知路径。
const SKILL = (() => {
  const cands: string[] = []
  try {
    cands.push(fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, ""))
  } catch {}
  cands.push("C:\\Agent Program Files\\Skills\\kontakt-preset-generator-skill")
  cands.push("C:\\Users\\Administrator\\.config\\opencode\\skills\\kontakt-preset-generator-skill")
  for (const c of cands) if (existsSync(join(c, "scripts", "env.mjs"))) return c
  return cands[0]
})()

const SCRIPTS = join(SKILL, "scripts")

// 找真正的 node。
// 注意：插件里 `process.execPath` **不是** node —— 它是 OpenCode 自己那个 Bun 单文件
// （opencode.exe），拿它当解释器只会得到一支 opencode CLI 的参数错误。所以这里显式找。
const NODE = (() => {
  const cands = [
    process.env.KONTAKT_NODE,
    "C:\\Program Files\\nodejs\\node.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs\\nodejs\\node.exe") : "",
  ].filter((c): c is string => !!c)
  for (const c of cands) if (existsSync(c)) return c
  try {
    const out = execFileSync("where.exe", ["node"], { encoding: "utf8", windowsHide: true })
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    if (first) return first
  } catch {}
  return "node" // 交给 PATH
})()

const text = (s: unknown) => ({ content: String(s ?? "") })

// 脚本用 --key=value 收参数；数组 → 重复出现。
function opt(key: string, value: unknown): string[] {
  if (value === undefined || value === null || value === "") return []
  if (Array.isArray(value)) return value.flatMap((v) => opt(key, v))
  if (value === true) return [`--${key}`]
  return [`--${key}=${String(value)}`]
}

function run(script: string, args: string[], timeoutMs = 180_000, cap = 60_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      NODE,
      [join(SCRIPTS, script), ...args],
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        let out = String(stdout ?? "")
        const errs = String(stderr ?? "")
        let tail = ""
        if (err) tail += `\n[exit] ${err.message}`
        if (errs.trim()) tail += `\n[stderr]\n${errs.trim()}`
        if (out.length > cap) out = `…[${out.length - cap} chars trimmed]…\n` + out.slice(-cap)
        resolve(out + tail)
      },
    )
  })
}

const WORKSPACE = { type: "string" as const, description: "工作区，默认 C:\\VEPRO\\Kontakt Patch（也可用 $KONTAKT_WORKSPACE 或 config/libraries.json 的 workspace）" }

export default Plugin.define({
  id: "kontakt-preset-generator.tools",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "kontakt", description: "Kontakt 8 multi / 预设批量生成（清单、库索引、报告）" })

      editor.add({
        name: "env",
        description:
          "环境闸门：查 Kontakt 可执行、Lua API 开关（HKCU DeveloperFeatures）、正在跑的实例、工作区可写、" +
          "库扫描配置、库索引。要启动 Kontakt 的动作先过这个 —— 开关为 0 时脚本会静默不执行，不先查就白等。",
        input: {
          type: "object",
          properties: { workspace: WORKSPACE, json: { type: "boolean" } },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as { workspace?: string; json?: boolean }
          return text(await run("env.mjs", [...opt("workspace", i.workspace), ...opt("json", i.json)], 60_000))
        },
      })

      editor.add({
        name: "db_build",
        description:
          "扫库建 patch 索引（data/kontakt-patches.csv）：Library / RelDir / PatchFile / 大小 / 路径。\n" +
          "扫描根顺序：本工具的 root（可多个）> config/libraries.json > 两者都没有时**只探测候选并退出**，" +
          "绝不静默扫全盘。扫完给出每个根的库数与文件数。",
        input: {
          type: "object",
          properties: {
            root: { type: "array", items: { type: "string" }, description: "扫描根，可多个（给了就不读配置）" },
            exclude: { type: "array", items: { type: "string" }, description: "完整路径的子串，命中就跳过" },
            ext: { type: "array", items: { type: "string" }, description: "默认 .nki / .nkm" },
            maxDepth: { type: "number", description: "0 = 不限" },
            db: { type: "string", description: "输出 CSV 路径，默认 data/kontakt-patches.csv" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = [
            ...opt("root", i.root),
            ...opt("exclude", i.exclude),
            ...opt("ext", i.ext),
            ...opt("max-depth", i.maxDepth),
            ...opt("db", i.db),
            ...opt("workspace", i.workspace),
          ]
          return text(await run("db-build.mjs", args, 900_000, 100_000))
        },
      })

      editor.add({
        name: "db_query",
        description:
          "查 patch 索引，拿精确的 .nki 路径给清单供料。library / token / ext 是子串，patch（文件名）" +
          "与 folder（相对目录）是正则。--count 可换成计数模式（按 Library 或 --by 指定的列）。",
        input: {
          type: "object",
          properties: {
            library: { type: "string", description: "库名子串，如 Berlin" },
            token: { type: "string" },
            folder: { type: "string", description: "相对目录的正则，如 'Violins I|Violas'" },
            patch: { type: "string", description: "文件名的正则，如 'Longs|Shorts'" },
            ext: { type: "string" },
            limit: { type: "number", description: "默认 60" },
            all: { type: "boolean", description: "不限条数" },
            paths: { type: "boolean", description: "始终打印完整路径" },
            count: { type: "boolean", description: "只出计数" },
            by: { type: "string", description: "计数模式的列，默认 Library" },
            db: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const keys = ["library", "token", "folder", "patch", "ext", "limit", "db", "by", "workspace"]
          const args = keys.flatMap((k) => opt(k, i[k]))
          for (const k of ["all", "paths", "count"] as const) args.push(...opt(k, i[k]))
          return text(await run("db-query.mjs", args, 120_000, 100_000))
        },
      })

      editor.add({
        name: "manifest_lint",
        description:
          "清单体检：必填列、文件是否存在、slot 0–63 与重复、midi 1–16 / port A–D / out 正整数 / vol·pan 数字、" +
          "multi 名与声部前缀、mic（profile 名 / 内联 `名=dB` / `learn:<已调好的 .nki>`）、keysw 格式。\n" +
          "ERROR 会挡住生成，WARN 只提醒。默认读 <工作区>\\manifest\\manifest.tsv。",
        input: {
          type: "object",
          properties: {
            manifest: { type: "string", description: "清单路径，默认 <工作区>\\manifest\\manifest.tsv" },
            profiles: { type: "string", description: "profiles.lua 路径，默认 <工作区>\\manifest\\profiles.lua" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          return text(await run("manifest-lint.mjs", ["manifest", "profiles", "workspace"].flatMap((k) => opt(k, i[k])), 120_000))
        },
      })

      editor.add({
        name: "profiles",
        description:
          "看工作区 manifest/profiles.lua：defaults（缺省值）、pan_by_section（声部声像）、mic_aliases（库 → " +
          "标准名 → 该库 group 名）、mic_profiles（各麦克风 dB，支持 -math.huge = 关掉）。只读；" +
          "写回等「是否改单一来源 JSON」定了再说。顺带会指出文件里的 `#` 注释（dofile 会语法错）。",
        input: {
          type: "object",
          properties: {
            profiles: { type: "string" },
            section: { type: "string", description: "defaults | pan_by_section | mic_aliases | mic_profiles | all" },
            json: { type: "boolean" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          return text(await run("profiles.mjs", ["profiles", "section", "workspace"].flatMap((k) => opt(k, i[k])).concat(opt("json", i.json)), 60_000))
        },
      })

      editor.add({
        name: "reports",
        description:
          "把工作区 Reports\\*.txt 归约成体检表。默认列表（每份报告的标题 / 时间 / OK / FAIL 数）；" +
          "file= 打印一份报告的段落与 FAIL 明细；summarize=true 写 Reports\\manifest.verify.csv（已存在要 force）。",
        input: {
          type: "object",
          properties: {
            file: { type: "string", description: "报告文件名或完整路径" },
            summarize: { type: "boolean", description: "写汇总 CSV" },
            out: { type: "string", description: "汇总 CSV 的路径，默认 manifest.verify.csv" },
            force: { type: "boolean", description: "允许覆盖已存在的汇总 CSV" },
            reports: { type: "string", description: "报告目录，默认 <工作区>\\Reports" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["file", "out", "reports", "workspace"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("summarize", i.summarize), ...opt("force", i.force))
          return text(await run("reports.mjs", args, 120_000, 100_000))
        },
      })

      editor.add({
        name: "run_lua",
        description:
          "逃生舱：带一个 .lua 启动 Kontakt 并等结果（一个 Lua 脚本 = 一次进程，不能驱动运行中的实例）。\n" +
          "前置检查：脚本存在、只在工作区 / skill scripts 内（要跑别处加 allowOutside）、Kontakt 可执行、" +
          "DeveloperFeatures = 1；有实例在跑会提醒（抢音频设备）。dryRun=true 只打印命令行不启动。\n" +
          "结果来源：report= 指定的文件，否则自动取 Reports 里最新变动的那份 .txt；超时不 kill。",
        input: {
          type: "object",
          properties: {
            script: { type: "string", description: "要跑的 .lua 绝对路径" },
            timeout: { type: "number", description: "秒，默认 180" },
            report: { type: "string", description: "报告文件；不给就自动盯 Reports" },
            dryRun: { type: "boolean", description: "只演练" },
            allowOutside: { type: "boolean", description: "允许跑工作区外的脚本" },
            exe: { type: "string", description: "Kontakt 可执行路径" },
            workspace: WORKSPACE,
          },
          required: ["script"],
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["script", "timeout", "report", "exe", "workspace"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("dry-run", i.dryRun), ...opt("allow-outside", i.allowOutside))
          return text(await run("run-lua.mjs", args, 600_000, 100_000))
        },
      })
    })
  },
})
