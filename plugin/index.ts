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
          "看工作区 manifest/profiles.json：defaults（缺省值）、pan_by_section（声部声像）、mic_aliases（库 → " +
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
        name: "gen_multi",
        description:
          "【核心】清单 → .nkm：A1 建空 multi → A2 逐槽装载 → A3 设参数（名字/MIDI 通道/输出/音量/声像/" +
          "keysw 等 instrument options，麦克风按未加密·加密分流）→ A5 存盘 → A6 **重载回读并与期望值自动比对**。\n" +
          "一条 multi 一个 Kontakt 进程。默认先出计划表；planOnly=true 只出计划，dryRun=true 会写 job.lua 但不启动。" +
          "期望值写到 Generated\\_expect\\<multi>.csv，供 verify_multi 复用。",
        input: {
          type: "object",
          properties: {
            manifest: { type: "string", description: "清单路径，默认 <工作区>\\manifest\\manifest.tsv" },
            profiles: { type: "string" },
            multi: { type: "array", items: { type: "string" }, description: "只做这些 multi（默认全部）" },
            outDir: { type: "string", description: "产物目录，默认 <工作区>\\Generated" },
            saveMode: { type: "string", description: "patch（默认）| monolith | samples" },
            planOnly: { type: "boolean", description: "只出计划" },
            dryRun: { type: "boolean", description: "写 job.lua 但不启动 Kontakt" },
            timeout: { type: "number", description: "秒，默认 300" },
            exe: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["manifest", "profiles", "exe", "workspace"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("multi", i.multi), ...opt("out-dir", i.outDir), ...opt("save-mode", i.saveMode), ...opt("timeout", i.timeout))
          args.push(...opt("plan-only", i.planOnly), ...opt("dry-run", i.dryRun))
          return text(await run("gen-multi.mjs", args, 900_000, 120_000))
        },
      })

      editor.add({
        name: "inspect_multi",
        description:
          "侦察一个 .nkm（只读）：槽位参数（名字/MIDI/输出/音量/声像/调音/复音/keysw）、每个槽**是不是加密/Player 库**、" +
          "group 名普查、麦克风读数。自己的旧的、别人给的、手做的都能看。",
        input: {
          type: "object",
          properties: {
            nkm: { type: "string", description: ".nkm 路径" },
            multi: { type: "string", description: "或者给 multi 名，去 Generated\\<名>.nkm 找" },
            census: { type: "number", description: "每个槽列多少 group 名，默认 15" },
            mic: { type: "array", items: { type: "string" }, description: "要读的麦克风名" },
            dryRun: { type: "boolean" },
            timeout: { type: "number" },
            exe: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["nkm", "multi", "census", "timeout", "exe", "workspace"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("mic", i.mic), ...opt("dry-run", i.dryRun))
          return text(await run("inspect-multi.mjs", args, 900_000, 120_000))
        },
      })

      editor.add({
        name: "verify_multi",
        description:
          "回读一个已有 .nkm 并与期望值比对：有 Generated\\_expect\\<multi>.csv 就逐字段比（PASS/FAIL 表），" +
          "没有就只回读。适合检查「上次生成的东西现在还是不是那样」。",
        input: {
          type: "object",
          properties: {
            nkm: { type: "string" },
            multi: { type: "string", description: "或给 multi 名去 Generated 找" },
            expect: { type: "string", description: "期望值 CSV（默认按 multi 名找）" },
            manifest: { type: "string", description: "清单路径：给了就能读「库里默认值」当基线，判定「是库复位还是真不一致」" },
            micExpect: { type: "string" },
            mic: { type: "array", items: { type: "string" } },
            dryRun: { type: "boolean" },
            timeout: { type: "number" },
            exe: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["nkm", "multi", "expect", "manifest", "timeout", "exe", "workspace"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("mic-expect", i.micExpect), ...opt("mic", i.mic), ...opt("dry-run", i.dryRun))
          return text(await run("verify-multi.mjs", args, 900_000, 120_000))
        },
      })

      editor.add({
        name: "probe_library",
        description:
          "进新库先探测（只读）：库类型（加密/Player？）、group 数、group 名普查、麦克风名候选（精确命中 + 词频线索）、" +
          "未加密库还能读到各麦克风的音量区间。\n" +
          "对象：patch=[.nki 路径…] 或 library=<库名>（从索引里挑几个浅的，spread=true 尽量分布在不同目录）。" +
          "api=true 则只列 Kontakt 里可用的函数（确认某版本有没有某个 API）。",
        input: {
          type: "object",
          properties: {
            patch: { type: "array", items: { type: "string" }, description: "要探测的 .nki" },
            library: { type: "string", description: "或给库名（用索引挑）" },
            limit: { type: "number", description: "挑几个，默认 3" },
            spread: { type: "boolean", description: "尽量来自不同目录" },
            census: { type: "number", description: "列多少 group 名，默认 20" },
            words: { type: "number", description: "列多少词频候选，默认 25" },
            api: { type: "boolean", description: "只列 API" },
            structure: { type: "boolean", description: "探结构：技法/力度层是脚本还是 Kontakt 原生（含 group start 条件与 zone 力度分布）" },
            check: { type: "array", items: { type: "string" }, description: "api 模式下重点确认的 API 名" },
            dryRun: { type: "boolean" },
            timeout: { type: "number" },
            exe: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["library", "limit", "census", "words", "timeout", "exe", "workspace"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("patch", i.patch), ...opt("check", i.check))
          args.push(...opt("spread", i.spread), ...opt("api", i.api), ...opt("structure", i.structure), ...opt("dry-run", i.dryRun))
          return text(await run("probe-library.mjs", args, 900_000, 150_000))
        },
      })

      editor.add({
        name: "apply_snapshot",
        description:
          "把一份 .nksn 套到 multi 上 —— **加密库（Berlin/CSS/8Dio/LASS）唯一能落地麦克风比例的通路**。\n" +
          "用法一：对已有 .nkm 套（nkm= 或 multi=），产出新文件（默认 \"<名> (snap).nkm\"，绝不覆盖输入），" +
          "slots=\"0,2\" 可只套部分槽；报告里会比对套之前/之后 header 参数有没有被 snapshot 动过。\n" +
          "用法二：visual=true 摆对照槽（第 1 槽不套、其余套上）**不退出**，留着你在 Kontakt 里点开看 mixer。\n" +
          "注意：snapshot 的比例不体现在 group 音量上（数值读不出来），且会连带承载该库 UI 的其它状态。",
        input: {
          type: "object",
          properties: {
            snapshot: { type: "string", description: ".nksn 绝对路径（必填）" },
            nkm: { type: "string", description: "输入 .nkm" },
            multi: { type: "string", description: "或给 multi 名去 Generated 找" },
            slots: { type: "string", description: "只套这些槽，如 \"0,2\"；默认全部" },
            out: { type: "string", description: "输出 .nkm 路径" },
            outDir: { type: "string" },
            force: { type: "boolean", description: "允许覆盖已存在的输出" },
            visual: { type: "boolean", description: "摆对照槽（配合 pair/patch/save 用）" },
            save: { type: "string", description: "visual 模式：把机架存成这个 .nkm 给人打开（存完退出；不给就留着机架不退出）" },
            patch: { type: "array", items: { type: "string" }, description: "visual 模式要摆的 .nki；第 1 个是对照组" },
            multiName: { type: "string", description: "visual 模式的 multi 名" },
            pair: {
              type: "array",
              items: { type: "string" },
              description: "visual 模式：\"<.nki>|<.nksn>\"，每个槽各自的 patch 与快照（快照留空 = 该槽当对照）。两个库可混在一个 multi 里",
            },
            dryRun: { type: "boolean" },
            timeout: { type: "number" },
            exe: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["snapshot", "nkm", "multi", "slots", "out", "exe", "timeout", "workspace", "save", "save-mode"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("out-dir", i.outDir), ...opt("multi", i.multiName))
          args.push(...opt("patch", i.patch), ...opt("pair", i.pair), ...opt("force", i.force), ...opt("visual", i.visual), ...opt("dry-run", i.dryRun))
          return text(await run("apply-snapshot.mjs", args, 900_000, 120_000))
        },
      })

      editor.add({
        name: "learn_mic",
        description:
          "从一个**你已手调好**的乐器（.nki）学出各麦克风的 dB，输出可直接粘进 profiles.lua 的 " +
          "`mic_profiles` 片段（只打印，不写回）。只对**未加密库**有意义 —— 加密库的 group 音量存不住，" +
          "学出来是默认值，工具会明确报「学不出，走 snapshot」。",
        input: {
          type: "object",
          properties: {
            patch: { type: "array", items: { type: "string" }, description: "已调好的 .nki（可多个）" },
            name: { type: "string", description: "输出 profile 名，默认从文件名推" },
            profiles: { type: "string", description: "profiles.lua 路径（写回时用），默认工作区那份" },
            write: { type: "boolean", description: "把学到的值写回 profiles.lua 的 mic_profiles（先备份 .bak）" },
            force: { type: "boolean", description: "写回时允许覆盖同名 profile" },
            mic: { type: "array", items: { type: "string" }, description: "只学这些麦克风名" },
            keyword: { type: "array", items: { type: "string" }, description: "没有别名表时用的关键词" },
            census: { type: "number", description: "报告里列多少 group 名，默认 12" },
            dryRun: { type: "boolean" },
            timeout: { type: "number" },
            exe: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["name", "census", "timeout", "exe", "workspace", "profiles"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("patch", i.patch), ...opt("mic", i.mic), ...opt("keyword", i.keyword))
          args.push(...opt("write", i.write), ...opt("force", i.force), ...opt("dry-run", i.dryRun))
          return text(await run("learn-mic.mjs", args, 900_000, 120_000))
        },
      })

      editor.add({
        name: "migrate_profiles",
        description:
          "一次性迁移：把工作区的 `manifest\\profiles.lua` 转成 `profiles.json`（原名留成 .bak）。\n" +
          "背景：这份配置只有 Node 工具在读（Kontakt 侧的 Lua 一个都不读它），JSON 读写都是原生的。\n" +
          "`-math.huge`（把麦克风关掉）会写成字符串 `\"off\"` —— 和清单里 `mic = CLOSE=off` 的内联写法一致。",
        input: {
          type: "object",
          properties: {
            workspace: WORKSPACE,
            force: { type: "boolean", description: "允许覆盖已存在的 profiles.json" },
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          return text(await run("migrate-profiles.mjs", [...opt("workspace", i.workspace), ...opt("force", i.force)], 60_000))
        },
      })

      editor.add({
        name: "snapshot",
        description:
          "`.nksn` 只读体检（**不需要 Kontakt**）。实测：.nksn **不是加密的**，是明文参数容器 —— 参数名大部分可读。\n" +
          "列出：可读参数名（引擎样式 / 语义词 / 疑似混淆的短 token）、关键词命中（默认查 ks/articulation/xfade/" +
          "legato/mic/dyn…）、给两份以上时做名字集合差异。\n" +
          "用途：判断一份 snapshot 里有没有带着技法/键位/xfade/mic 那些块，以及你的「库标准状态」有没有变。\n" +
          "⚠ 只读：**绝不修改 snapshot**（改了会破坏 NI 的格式与校验）。值读不出来，别指望从里面读出「KS=C-2」。",
        input: {
          type: "object",
          properties: {
            file: { type: "array", items: { type: "string" }, description: ".nksn（可多个，2 个以上自动做差异）" },
            find: { type: "string", description: "关键词，逗号分隔；默认查 ks/articulation/xfade/legato/mic/dyn…" },
            limit: { type: "number", description: "每类列多少条，默认 60" },
            json: { type: "boolean" },
          },
          required: ["file"],
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["find", "limit"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("file", i.file), ...opt("json", i.json))
          return text(await run("snapshot.mjs", args, 120_000, 120_000))
        },
      })

      editor.add({
        name: "snapshot_diff",
        description:
          "两份 `.nksn` 的**对齐感知差分**（只读，不需要 Kontakt）—— 用来**反推库内参数**（不是解密）。\n" +
          "原理：首 4 字节是整个文件长度；偏移 24..40 每次保存都不同（疑似 nonce/校验）；**本体是对齐的**，" +
          "两份之间只差几字节的增删 + 若干值 → 必须先对齐再比，否则错位会给出「99% 都不同」的假象。\n" +
          "输出：对齐块内的**值差异**（偏移/字节/float 解释/附近的明文名）与**增删段**。\n" +
          "用法：同一个 patch **只改一个开关**各存一份 → 差异那块就是那个参数的存处；数值型参数（如某麦 dB）最好。",
        input: {
          type: "object",
          properties: {
            a: { type: "string", description: "第一份 .nksn" },
            b: { type: "string", description: "第二份 .nksn" },
            file: { type: "array", items: { type: "string" }, description: "或者给多份（第一份当基准）" },
            anchor: { type: "number", description: "锚间隔，默认 128" },
            needle: { type: "number", description: "锚长度，默认 40" },
            maxRegions: { type: "number", description: "最多列多少处差异，默认 40" },
            context: { type: "number", description: "找明文时的上下文半径，默认 96" },
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["anchor", "needle", "context"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("a", i.a), ...opt("b", i.b), ...opt("file", i.file), ...opt("max-regions", i.maxRegions))
          return text(await run("snapshot-diff.mjs", args, 300_000, 200_000))
        },
      })

      editor.add({
        name: "snapshot_lookup",
        description:
          "把 `.nksn` 当**可读的参数表**来查（只读，不需要 Kontakt，秒级）。\n" +
          "① `find=\"mic,xfade,legato\"`：列出名字里含这些词的明文串 + 它后面那串字节 + 候选数值。\n" +
          "② `value=[-6,-12]`：把数值按 f32/f64/i32/i16/十进制串各编码一遍搜位置，报出前后最近的明文名。\n" +
          "⚠️ 实测：**名字是明文，但 CAPSULE 那种 mixer 数值不是明文数值**（搜 -15 一个都搜不到）——\n" +
          "所以「读值 / 改值」对这类参数不成立；定位「哪块变了、那块叫什么」用 snapshot_diff。",
        input: {
          type: "object",
          properties: {
            file: { type: "array", items: { type: "string" }, description: "要查的 .nksn（可多个）" },
            find: { type: "string", description: "按名字找，逗号分隔，如 mic,xfade,legato" },
            value: { type: "array", items: { type: "number" }, description: "按值找（各编码都试一遍）" },
            window: { type: "number", description: "名字与值之间允许的最大距离，默认 256" },
            max: { type: "number", description: "每类最多列多少条，默认 40" },
          },
          required: ["file"],
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["find", "window", "max"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("file", i.file), ...opt("value", i.value))
          return text(await run("snapshot-lookup.mjs", args, 120_000, 120_000))
        },
      })

      editor.add({
        name: "findings",
        description:
          "本机探测**成果库**（`data/findings.json`）：每个库「是什么类型、属于哪条麦克风路、有哪些 patch 家族、" +
          "有哪些快照、快照里已定位的参数」。\n" +
          "`library=\"CSS\"` 看某个库（子串匹配）；不带参数列全部；" +
          "`library=\"<名>\"` + `merge='{\"key\":\"value\"}'` 深度合并写回（先备份 .bak）。\n" +
          "`probe_library(structure:true)` 会自动写进这里，所以认库的结论不用手抄。\n" +
          "人读版在工作区 `docs\\Kontakt-库档案.md`。",
        input: {
          type: "object",
          properties: {
            library: { type: "string", description: "库名（子串匹配）；写回时不存在则新建" },
            merge: { type: "string", description: "要合并进去的 JSON 片段" },
            mergeFile: { type: "string", description: "或者给一个 JSON 文件路径" },
            json: { type: "boolean", description: "原样输出整个成果库" },
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["library", "merge"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("merge-file", i.mergeFile), ...opt("json", i.json))
          return text(await run("findings.mjs", args, 60_000, 200_000))
        },
      })

      editor.add({
        name: "library_info",
        description:
          "**库总表（秒级，不启动 Kontakt）**：扫所有 `.nicnt` 拿明文 XML 里的正式库名 / 厂牌 / **授权系统**" +
          "（RAS2 / RAS3 / 无）/ SNPID，并统计每库的 nki 数与采样形态（松散 .wav/.ncw vs 打包 .nkx）。\n" +
          "⚠️ 授权系统与采样形态都**判不出"是否加密"**（实测 Performance Samples 是 RAS3 却未加密）——" +
          "那是**弱先验**，加密与否仍要靠探测。`merge=true` 把先验写进成果库。",
        input: {
          type: "object",
          properties: {
            root: { type: "array", items: { type: "string" }, description: "扫描根；默认取 config/libraries.json 或自动探测" },
            merge: { type: "boolean", description: "把结果并进 data/findings.json" },
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = opt("root", i.root)
          args.push(...opt("merge", i.merge))
          return text(await run("library-info.mjs", args, 600_000, 120_000))
        },
      })

      editor.add({
        name: "probe_libraries",
        description:
          "**批量读库**：一次 Kontakt 进程装一批库的代表 patch，逐个 dump 结构，结果**自动写进成果库**。\n" +
          "把「每库摸一次」从 N 次启动压成几次（`chunk` 控制每块几个库）。每库默认取 1 个最浅的 patch 代表它。\n" +
          "产出：加密与否（看脚本 protected）、脚本槽名、group 数、原生 start 条件数、多段力度 group 数、" +
          "group 名形态、**麦克风名词频候选**。`dryRun=true` 先看计划。",
        input: {
          type: "object",
          properties: {
            library: { type: "string", description: "只测名字匹配这些子串的库（竖线或逗号分隔）；默认全部" },
            perLibrary: { type: "number", description: "每库取几个代表 patch，默认 1" },
            chunk: { type: "number", description: "一次进程装几个库，默认 8" },
            zones: { type: "number", description: "每个 patch 最多扫多少 zone，默认 4000" },
            timeout: { type: "number", description: "每块秒数，默认 600" },
            dryRun: { type: "boolean" },
            exe: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["library", "zones", "timeout", "exe", "workspace"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("per-library", i.perLibrary), ...opt("chunk", i.chunk), ...opt("dry-run", i.dryRun))
          return text(await run("probe-libraries.mjs", args, 3_600_000, 150_000))
        },
      })

      editor.add({
        name: "group_persist",
        description:
          "**验证这个库的 group 音量能不能存住**（决定麦克风能不能全自动）：把全部 group 设成固定 dB → 存 multi → " +
          "重载 → 再读；存活即"这个库的麦克风比例可以直接脚本写"。\n" +
          "默认只测成果库里**未加密/未知**的库（加密的已知写不住）。结论写进 `group_volume_persists`。\n" +
          "⚠️ 实测校准过：MSB 样板 / Pacific 判"能存住"、Berlin 判"复位"，与已知一致才采信。",
        input: {
          type: "object",
          properties: {
            library: { type: "string", description: "只测匹配这些子串的库；默认全部未加密/未知" },
            all: { type: "boolean", description: "连加密库也测" },
            db: { type: "number", description: "测试用的 dB，默认 -12" },
            perLibrary: { type: "number", description: "每库几个代表 patch，默认 1" },
            chunk: { type: "number", description: "一次进程几个库，默认 6" },
            dryRun: { type: "boolean" },
            timeout: { type: "number" },
            exe: { type: "string" },
            workspace: WORKSPACE,
          },
          additionalProperties: false,
        },
        options: { namespace: "kontakt", codemode: true },
        execute: async (input) => {
          const i = input as Record<string, unknown>
          const args = ["library", "db", "timeout", "exe", "workspace"].flatMap((k) => opt(k, i[k]))
          args.push(...opt("per-library", i.perLibrary), ...opt("chunk", i.chunk), ...opt("all", i.all), ...opt("dry-run", i.dryRun))
          return text(await run("group-persist.mjs", args, 3_600_000, 150_000))
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
