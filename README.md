# Kontakt multi 批量生成 — skill

**一句话**：一张清单（`.tsv`）→ 一批 Kontakt multi（`.nkm`，参数与麦克风自动回读对账）→（可选）一条命令灌进 VE Pro 通道。

```
清单 manifest\*.tsv ──kontakt_gen_multi──→ Generated\*.nkm ──kontakt_vepro_bridge──→ VE Pro 通道
   ▲                                            │
   └── kontakt_db_build / kontakt_db_query 供料  └── 库内设置（麦克风 / 开关）：三条路，见 §3
```

本仓库放**代码与文档**：知识在 `SKILL.md` 与 `references/`，工具在 `plugin/index.ts`（把 `scripts/*.mjs` 注册成 `kontakt` 命名空间的 OpenCode 工具）。
**数据与产物在工作区**（默认 `C:\VEPRO\Kontakt Patch`；可用 `$KONTAKT_WORKSPACE` 或 `config/libraries.json` 的 `workspace` 改），不在本仓库。

与 `vsl-synchron-player` 是姊妹 skill：做法一样（skill 装知识 + 同目录 plugin 出工具），但那边的脚本是 PowerShell，这边是 Node `.mjs`。

## 1. 前提

| 前提 | 说明 |
|---|---|
| **Kontakt 8** | 实测 8.9.0（Kontakt 7 也装着，本流程按 8）。 |
| **Lua API 开关** | `HKCU\Software\Native Instruments\Kontakt 8` → `DeveloperFeatures = 1`。**= 0 时脚本静默不执行**（不报错、不写报告，最容易白等）→ 任何要跑 Kontakt 的动作先 `kontakt_env`。 |
| **工作区目录** | 清单 `manifest\manifest.tsv`、库级默认 `manifest\profiles.json`、产物 `Generated\`、报告 `Reports\`、作业 `jobs\`。 |
| **一个 Lua 作业 = 一次 Kontakt 进程** | 只能带一个 `.lua` 文件，**没有参数、没有 JSON 库**（Lua 5.4 + `os`/`io`）。配置只能写死在脚本里或 `dofile()`；**不能驱动运行中的实例**。固定动作是「带脚本启动 → 跑完退出」。 |

另外两条执行事实（细节见 `references/environment.md`）：

- **报告即接口**：无人值守时终端看不到，作业必须自己写 `Reports\*.txt`。成功判据是报告里有 `==== end ====`，**不是退出码**——Kontakt 退出时那串 `0xC0000005` / `DoVMUnLock … errno = 158` 是关机噪音，与成败无关。
- 起 Kontakt 前确认**没有用户在用的实例**（会抢音频设备）；批量链里两个 Kontakt 启动**别挨太近**（间隔 20–25 s，否则新进程可能卡住）。

## 2. 工具（24 个，`kontakt` 命名空间）

⚙ = 需要 Kontakt（会起一次进程）；没有 ⚙ 的秒级、可离线跑。

### 环境 / 索引

| 工具 | ⚙ | 一句话 |
|---|---|---|
| `kontakt_env` | | 环境闸门：可执行、Lua API 开关、在跑的实例、工作区可写、扫描配置、库索引。 |
| `kontakt_db_build` | | 扫库建 `data/kontakt-patches.csv`（Library / RelDir / PatchFile / 大小 / 路径）；**永远不静默扫全盘**。 |
| `kontakt_db_query` | | 查索引拿精确 `.nki` 路径（`patch` / `folder` 是正则，其余子串；`count` 出计数）。 |
| `kontakt_library_info` | | 库总表：读 `.nicnt` 的**明文 XML**（正式名 / 厂牌 / 授权系统 / SNPID）+ 采样形态；给的是**先验**，不启动 Kontakt。 |

### 生成链

| 工具 | ⚙ | 一句话 |
|---|---|---|
| `kontakt_manifest_lint` | | 清单体检：必填列、文件存在、slot / midi / port / out / vol / pan、multi 名、`mic` 引用、`keysw` 格式。 |
| `kontakt_profiles` | | 看库级默认 `manifest/profiles.json`（defaults / pan_by_section / mic_aliases / mic_profiles / mic_snapshots）。 |
| `kontakt_gen_multi` | ⚙ | **核心**：清单 → `.nkm`（A1–A6），写麦（含**自动注入 MIC-ADAPTER**），存盘后**重载回读并自动比对**。 |
| `kontakt_inspect_multi` | ⚙ | 侦察一个 `.nkm`（只读）：槽位参数、库是否加密、group 名普查、麦克风读数。 |
| `kontakt_verify_multi` | ⚙ | 回读已有 `.nkm` 并与 `Generated\_expect\<multi>.csv` 逐字段比对；给 `manifest=` 会干净装载读库默认基线，判「是库复位还是真不一致」。 |
| `kontakt_reports` | | 把 `Reports\*.txt` 归约成体检表（列表 / 单份明细 / 写 `manifest.verify.csv`）。 |

### 库知识 / 测量

| 工具 | ⚙ | 一句话 |
|---|---|---|
| `kontakt_probe_library` | ⚙ | 进新库先探测（只读）：库类型、group 名规律、麦克风名候选；`api=true` 列 API；`structure=true` 探技法 / 力度层是脚本还是原生。 |
| `kontakt_probe_libraries` | ⚙ | 批量读库：一次进程装一批库（`chunk`），逐个 dump 结构并**自动写进成果库**。 |
| `kontakt_group_persist` | ⚙ | 验证「这个库的 group 音量能不能存住」（= 麦克风能不能全自动）：全 group 设 dB → 存 → 重载 → 再读。 |
| `kontakt_mic_mine` | | 不启 Kontakt，从已有读库报告里挖每个库的麦克风 token（`write` 写回 `mic_tokens`）。 |
| `kontakt_load_test` | ⚙ | 装载体检：这批 `.nki` 哪一个装得开（只 `load_instrument`，很快）；有坏采样的库要 `skip` 掉。 |
| `kontakt_findings` | | 本机成果库 `data/findings.json` 的读与写回：每库的类型 / 加密 / group / 麦克风 token / 快照 / 已定位参数。 |

### 快照（`.nksn`）

| 工具 | ⚙ | 一句话 |
|---|---|---|
| `kontakt_snapshot` | | `.nksn` **只读体检**：列可读参数名、关键词命中、两份名集合差异。**绝不修改快照**。 |
| `kontakt_snapshot_diff` | | `.nksn` **对齐感知差分**：找「哪几个字节变了 + 旁边叫什么」（反推参数用）。只读。 |
| `kontakt_snapshot_lookup` | | 把 `.nksn` 当**参数表**查：按名字或按值找（秒级）。只读。 |
| `kontakt_apply_snapshot` | ⚙ | 把 `.nksn` 套到 multi 的槽上（**槽受保护的库，库内设置唯一落地通路**）；`visual=true` + `save=` 产出可打开的对照 multi。 |
| `kontakt_learn_mic` | ⚙ | 从你已手调好的 `.nki` 学出各麦克风 dB → 打印片段；`write=true` 写回 profiles（先备份）。 |

### VEP / 杂

| 工具 | ⚙ | 一句话 |
|---|---|---|
| `kontakt_vepro_bridge` | | Kontakt multi → VE Pro 通道的薄桥：`cache` 用户手装的 state / `apply` 克隆通道并灌 state / `verify`。 |
| `kontakt_migrate_profiles` | | 一次性迁移 `profiles.lua` → `profiles.json`（已完成，一般不用）。 |
| `kontakt_run_lua` | ⚙ | 逃生舱：前置检查 → 带 `.lua` 启动 Kontakt → 等报告回传（`dryRun` 只演练）。 |

## 3. 库内设置（麦克风 / xfade / 开关）：三条路

**先认库属于哪条路，再动手。判据一律是实测**（`kontakt_group_persist` / `gen_multi` 的回读比对），**不用 `protected` 猜**——有"加密却能写"的反例。

| 路 | 用在什么库上 | 清单怎么写 | 能否全自动 | 能否数值验证 |
|---|---|---|---|---|
| ① **清单里直接写 group 音量** | 多数**未加密**库（本机成果库记到 38 个能写的） | `mic = 别名=-6;others=off`，或 profile 名 | ✅ | ✅ 能（回读比对） |
| ② **脚本适配器 `MIC-ADAPTER`** | **group 音量会被库复位、但有空脚本槽**的库（实测数套） | 还是 `mic = 别名=-6;others=off`，`gen_multi` **自动注入** | ✅ | ✅ 能（注入可回读） |
| ③ **快照 `.nksn`** | **脚本槽全受保护**的库全系；以及注入不持久 / 被库清槽的库 | `mic = <profile 名>`（→ `profiles.mic_snapshots`）或 `mic = snap:<.nksn>` | ⚠ 每条 multi 要套一次（`apply_snapshot`） | ❌ 只能人眼看 |

### ① 直接写 group 音量（`gen_multi` 内建）

清单 `mic` 列三种写法：profile 名 / 内联 `名=dB;others=off` / `snap:<.nksn>`。
匹配规则走 `mic_aliases`，三种匹配：**精确 → 结尾词 → 包含**，多命中时取**最长键**（因为同一支麦在不同库里既有纯名 group，也有复合名 group）。
`others` 是**通配**不是麦名：没被点名的 group 全按它设；`off` / `mute` / `-math.huge` = 关掉。

⚠ **判「库复位」要比"写之前的基线"**，不能拿「值很小」当判据——各库默认基线不同。`gen_multi` 写之前先读基线，重载后**回读 == 基线** → 判「库复位」→ 报 WARN 而不是 FAIL。

### ② MIC-ADAPTER（脚本适配器）

**思路**：库在载入时把 group 音量写回默认（覆盖我们写的值）→ 那就在**它之后**再写一遍。
`kontakt_lib.lua` 的 `inject_mic_adapter()` 往该乐器一个**空脚本槽**注入一小段 KSP（名 `MIC-ADAPTER`，`on init` 写一次、`on persistence_changed` / `on ui_update` 每次兜一遍）——**它随 `.nkm` 存盘、跟着 multi 走，加载即生效，不依赖快照**。

- `gen_multi --adapter=auto|off`（默认 `auto`，`off` 退回旧行为）；报告里出 `ADAPTERS` 机器块（槽 → 脚本槽 / group 数 / 字节数）。
- 条件：库要**有空脚本槽**（名字空或 `<empty>` 且非 protected），且**载入时不清槽**。
- ⚠️ KSP 语言与 `set_instrument_script_source` 的硬规矩见 §4 铁律 2。

### ③ 快照 `.nksn`

- **必须人在 GUI 里调出来才有效**：脚本先改 group 音量再 `save_snapshot` 那份是**无效的**（快照存的是**库自己的 UI 状态**）。
- 快照会**连带承载该库 UI 的其它状态**（不只是麦克风，还可能改掉 patch 家族的面板模式）→ **一个库的 snapshot 当「该库的标准状态」维护**，而且**快照与 patch 家族绑定**（跨家族套用会把目标 patch 的界面状态改掉）。一个库可能要好几份快照。
- 这类库的比例**不落在 group 音量上**，数值读不出来 → 只能人眼确认：`apply_snapshot --visual --pair="<.nki>|<.nksn>" --save=<对照 .nkm>` 摆对照槽，用户点槽看。
- 细节与实测见 `references/snapshots.md`。

**一条例外**：如果库的切换是用 **Kontakt 原生 group start 条件**实现的，那一层能用 `set_group_start_options` 程序化写、而且能持久（只对"用原生 start 条件切换"的库成立；用脚本实现的仍只能走快照）。先 `kontakt_probe_library(structure: true)` 看目标是哪一类。

## 4. 两条铁律

**① Kontakt 的存盘 / 读盘不吃非 ASCII 路径（静默失败）。**
`save_multi` / `load_multi` 遇到含中文等非 ASCII 的路径：`pcall` 返回 true、无异常、无 stderr、磁盘上什么都没有。对策：Lua 侧一律用**同目录的 ASCII 中转名**，跑完由 **Node 改名**（`scripts/lib.mjs`：`asciiNkmPath` 造 `<可打印名>__<hash>.nkm`，`stageInputNkm` 复制输入、跑完 `cleanupInputNkm` 删，`stageOutputNkm` 给 Kontakt ASCII 名、跑完 `finalize()` 改回最终中文名）。
**判存盘要两头都对**：先删旧文件 → 要求"文件确实（重新）出现"才重载回读。旧文件还在会读成假 PASS，文件没出现别默认解释成"还没写完"（实测是立刻落盘的，真因是路径字符）。

**② `set_instrument_script_source` 收的是「脚本正文」，不是文件路径。**
传路径 → Kontakt 把**路径当 KSP 编译**，stderr 报 `syntax error [<乐器>, script N, line 1]`，**但 `pcall` 仍返回 true**，回读还会拿回你写进去的那串文本 → 只看 pcall / 长度会得出"注入成功"的错误结论。要用文件走 `set_instrument_script_linked_filename`。
KSP 四条硬规矩：**顶层 `declare` 不能带初值**（初值只能写在 `on init`）／**`on init` 里不能 `call` 用户函数**／**`function` 必须写在调用点之前**／**`{ }` 注释必须闭合**。
判"脚本真跑了"**只看可回读的副作用**（例：让 KSP 写一个 group 声像，再用 Lua `get_group_pan` 读回）。

## 5. VEP 桥（`kontakt_vepro_bridge`）

- **每条 multi 需要人工在 VEP 里加载一次**：在 VEP 的 Kontakt 面板里用 **File → Load multi**。⚠️ **不要把 `.nkm` 拖进 VEP**（会让 Kontakt 崩）。之后 `cache` / `apply` / `verify` 全自动。
- **`--apply` 克隆一条已知能用的通道**（`--from=<源通道>`，或 `--cache` 时记下的源通道），克隆后改名；⛔ **不要用 `channel/add` 建裸通道**——灌了 state 也不发 MIDI、也没有默认通道条 FX。只有"给已有通道换 state"才用 `state/set`。
- **state 只有 Kontakt 自己产出的才认**：自己拼的 state 会被 Kontakt 静默拒绝。
- VEP 的 API 是本地 stdio JSON-RPC 服务端（`vepro-api-mcp.exe`），本工具自己拉起来驱动，**大 payload 走管道、不进对话**。

## 6. 目录结构

| 目录 / 文件 | 内容 |
|---|---|
| `SKILL.md` | 技能正文（工具已注册清单、核心事实、写盘安全、标准工作流）。 |
| `README.md` | 本文件：入口。 |
| `references/` | 去个人化的通用文档：`workflow.md`（工具与工作流 + 数据模型）、`environment.md`（环境与执行）、`snapshots.md`（`.nksn` 纪律）、`pitfalls.md`（通用踩坑）。`references/user-habits.md` 已 gitignore，留给个人偏好。 |
| `plugin/index.ts` | 把 `scripts/*.mjs` 注册成 `kontakt` 命名空间的工具。 |
| `scripts/` | Node `.mjs`（`env` / `db-build` / `db-query` / `manifest-lint` / `profiles` / `reports` / `plan` / `job` / `compare` / `gen-multi` / `inspect-multi` / `verify-multi` / `probe-library` / `probe-libraries` / `group-persist` / `load-test` / `mic-mine` / `apply-snapshot` / `learn-mic` / `snapshot` / `snapshot-diff` / `snapshot-lookup` / `library-info` / `findings` / `vepro-bridge` / `run-lua` / `migrate-profiles` / `lib`）+ `kontakt_lib.lua`（Lua 侧公共库）。 |
| `templates/` | 10 个 Lua 作业模板（`job_gen_multi` / `job_inspect_multi` / `job_verify_multi` / `job_group_persist` / `job_apply_snapshot` / `job_snapshot_visual` / `job_probe_library` / `job_probe_structure` / `job_load_test` / `job_learn_mic`），配置由 Node 注入。 |
| `config/` | 库扫描根（真文件 `libraries.json` gitignore，只留 `libraries.example.jsonc`）。 |
| `data/` | 扫库得到的 patch 索引（可重建）+ 本机成果库 `findings.json`（形状见 `findings.example.json`）；两者含本机路径，**故意不进 git**。 |

工具是薄包装，脚本都能单独跑：`node scripts/env.mjs`、`node scripts/db-query.mjs --library=<库> --paths`…

### 库扫描根（`config/libraries.json`）

`db_build` 找库的顺序（**永远不静默扫全盘**）：① 调用时显式给的 `roots` → 用它，不读配置；② `config/libraries.json` 存在 → 用它；③ 都没有 → 只**探测候选**并回给你确认。形状见 `config/libraries.example.jsonc`：`workspace` / `scan_roots` / `exclude` / `extensions` / `max_depth` / `library_tokens`。

## 7. 开发约定

- **脚本是 Node `.mjs`**，只跑 Node 标准库，不依赖 PowerShell（这层全是文本 / JSON / 进程编排）。模板用 `@LIB@`（公共 Lua 库路径）与 `@JOB@`（配置表）两个占位符，`scripts/job.mjs` 负责渲染。
- **一个 Lua job = 一次进程**：Node 先算好每个槽的最终值（`plan.mjs`），渲染成 `<工作区>\jobs\<时间戳>-<slug>\job.lua`（配置以 Lua 字面量内嵌），再启动 Kontakt 跑它、解析报告里的机器可读块（`SLOTS` / `LIBS` / `MICS` / `BASELINES` / `ADAPTERS`）。作业**能直接看懂、也能手动重跑**。
- **产物 / 报告 / 作业 / 索引 / 成果库都不进版本库**（见 `.gitignore`）：仓库只放代码与文档。行尾统一 LF（`.gitattributes`），`*.nkm` / `*.nki` / `*.nksn` 等按二进制不 diff / merge。
- 改了 `plugin/index.ts` 用 `opencode reload`（比重启服务轻）；工具参数改了也要 reload 才生效。
- ⚠️ **插件里 `process.execPath` 不是 node**（是 OpenCode 那个 Bun 单文件），所以 `plugin/index.ts` 显式找 node（`$KONTAKT_NODE` > `C:\Program Files\nodejs\node.exe` > `where node` > `PATH`）。
- ⛔ **改本仓库的中文文件（`README.md` / `references\*.md` / 注释）一律用编辑工具**，不要用 PowerShell 的 `Get-Content | Set-Content` 往返（PS 5.1 按 ANSI 读、按 UTF-8+BOM 写，中文直接写坏）；看控制台中文输出要写进文件再用读取工具看。
- 改完先跑不启动 Kontakt 的冒烟：`manifest_lint`、`gen_multi --dry-run`、`vepro_bridge --list`。

## 8. 事实来源与外部参考

- 方案与实测证据在工作区 `C:\VEPRO\Kontakt Patch`（清单、`Generated\`、`Reports\`、库档案）；通用结论已整理进 `references/`。
- 外部参考：Kontakt Lua API 官方手册 <https://docs.native-instruments.com/ni-tech-manuals/kontakt-api-reference-manual/en/>
