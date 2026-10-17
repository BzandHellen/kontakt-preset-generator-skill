# Kontakt Preset Generator — skill

本机（Windows 工作站）Kontakt 8 批量生成 **multi / 预设** 的 skill：把
「一张清单 → 批量产出 `.nkm` + 校验报告 → 交给 VEP 灌通道」这套流程脚本化。

与 `vsl-preset-generator-skill`（Vienna Synchron Player 侧）并列，同一套做法：
**skill 装知识 + 同目录 plugin 出工具**。权威副本在
`C:\Agent Program Files\Skills\kontakt-preset-generator-skill`，junction 到 harness：

| 用途 | 路径 |
|---|---|
| 技能入口 | `~/.config/opencode/skills/kontakt-preset-generator-skill`（junction → 本目录） |
| 工具插件 | `~/.config/opencode/plugins/kontakt-preset-generator-skill`（junction → `plugin/`） |

改了插件代码后 `opencode reload`（比重启服务轻）。

## 它做什么

工作区（数据与产物）在 `C:\VEPRO\Kontakt Patch`，**不在本仓库**。这个仓库放代码与说明：

| 目录 | 内容 |
|---|---|
| `SKILL.md` | 技能正文：已注册工具、Kontakt Lua 的核心事实与坑、写盘安全、标准工作流 |
| `plugin/index.ts` | 把 `scripts/*.mjs` 注册成 `kontakt` 命名空间的 OpenCode 工具 |
| `scripts/` | Node 脚本（`env` / `db-build` / `db-query` / `manifest-lint` / `profiles` / `reports` / `run-lua`） |
| `config/` | 本机配置：库扫描根（真文件 gitignore，只留 `.example.jsonc`） |
| `data/` | 扫库生成的 patch 索引（可重建，不进 git） |

只跑 Node 标准库，不依赖 PowerShell。脚本都能单独跑：
`node scripts/env.mjs`、`node scripts/db-query.mjs --library=Berlin`…

## 配置：库扫描根

`db_build` 找库的顺序（**永远不静默扫全盘**）：

1. 调用时显式给的 `roots` → 用它，不读配置文件；
2. `config/libraries.json` 存在 → 用它；
3. 都没有 → 只**探测候选**（各盘符下的 `Kontakt Library`、
   `C:\VEPRO\Channel Sets\NKI` 之类）回给你确认，确认后再写 `config/libraries.json`。

`config/libraries.json` 是本机私有的（已 gitignore），形状见
`config/libraries.example.jsonc`：`workspace` / `scan_roots` / `exclude` / `extensions`
/ `max_depth` / `library_tokens`。

## 进度

| 期 | 内容 | 状态 |
|---|---|---|
| M1 | `env` / `db_build` / `db_query` / `manifest_lint` / `profiles` / `reports` / `run_lua` | ✅ |
| M2 | `probe_library` / `gen_multi`（写 `gen_multis.lua`）/ `inspect_multi` / `verify_multi` | — |
| M3 | `plan` / `learn_mic` / `apply_snapshot` | — |
| M4 | `to_vepro`（可选） | — |

## 事实来源

方案与实测结论在工作区 `C:\VEPRO\Kontakt Patch`
（`README.md`、`docs\Kontakt-Lua-发现与坑.md`、`Reports\`）。
本仓库只放**代码与文档**，不下库、不放产物。
