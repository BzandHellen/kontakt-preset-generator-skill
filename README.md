# Kontakt Preset Generator — skill

本机（Windows 工作站）Kontakt 8 批量生成 **multi / 预设** 的 skill：把
「一张清单 → 批量产出 `.nkm` + 校验报告 → 交给 VEP 通道」这套流程脚本化。

与 `vsl-preset-generator-skill`（Vienna Synchron Player 侧）并列，同一套做法：
**skill 装知识 + 同目录 plugin 出工具**，权威副本放在
`C:\Agent Program Files\Skills\kontakt-preset-generator-skill`，
再 junction 到 harness 目录供 OpenCode 使用。

> 状态：骨架。内容（SKILL.md / plugin / scripts / data / references）逐步补。

## 配置：库扫描根

`db_build` 找库的顺序（**永远不静默扫全盘**）：

1. 调用时显式给的 `roots` → 用它，不读配置文件；
2. `config/libraries.json` 存在 → 用它；
3. 都没有 → 只**探测候选**（各盘符下的 `Kontakt Library`、
   `C:\VEPRO\Channel Sets\NKI` 之类）回给你确认，确认后再写 `config/libraries.json`。

`config/libraries.json` 是本机私有的（已 gitignore），形状见
`config/libraries.example.jsonc`：`scan_roots` / `exclude` / `extensions` / `max_depth`
/ `library_tokens`。

## 事实来源

方案与实测结论在工作区 `C:\VEPRO\Kontakt Patch`
（`README.md`、`docs\Kontakt-Lua-发现与坑.md`、`Reports\`）。
本仓库只放**代码与文档**，不下库、不放产物。
