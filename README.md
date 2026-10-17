# Kontakt Preset Generator — skill

本机（Windows 工作站）Kontakt 8 批量生成 **multi / 预设** 的 skill：把
「一张清单 → 批量产出 `.nkm` + 校验报告 → 交给 VEP 通道」这套流程脚本化。

与 `vsl-preset-generator-skill`（Vienna Synchron Player 侧）并列，同一套做法：
**skill 装知识 + 同目录 plugin 出工具**，权威副本放在
`C:\Agent Program Files\Skills\kontakt-preset-generator-skill`，
再 junction 到 harness 目录供 OpenCode 使用。

> 状态：骨架。内容（SKILL.md / plugin / scripts / data / references）逐步补。

## 事实来源

方案与实测结论在工作区 `C:\VEPRO\Kontakt Patch`
（`README.md`、`docs\Kontakt-Lua-发现与坑.md`、`Reports\`）。
本仓库只放**代码与文档**，不下库、不放产物。
