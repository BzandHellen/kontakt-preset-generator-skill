---
name: Kontakt multi 批量生成
description: >-
  用 Kontakt 8 自带的 Lua API 把「拖 patch + 调参数 + 存 multi」流程脚本化：一张清单批量产出 .nkm 与
  校验报告，交给 VEP 灌通道。含库 patch 索引（扫盘建 CSV）、清单体检、库级默认与麦克风 profile、
  报告汇总、以及带前置检查的 Lua 作业启动器。当用户提到 Kontakt、multi、nkm、nki、Kontakt Patch、
  Kontakt 徽标、批量建 multi、灌 VEP 通道、麦克风比例、snapshot(nksn)、Berlin/Spitfire/CSS/8Dio/
  Orchestral Tools 等 Kontakt 库，或要查某个库有哪些 patch 时使用。
---

# Kontakt multi 批量生成

**skill 目录 = 这份文件所在目录。** 权威副本在
`C:\Agent Program Files\Skills\kontakt-preset-generator-skill`，junction 到 harness：
`C:\Users\Administrator\.config\opencode\skills\kontakt-preset-generator-skill`（junction）。
相对路径都相对本目录：`scripts/`（Node 脚本）、`plugin/`（工具插件）、`data/`（索引）、`config/`（本机配置）。

**工作区（数据与产物在那边，不在本仓库）**：`C:\VEPRO\Kontakt Patch`
—— 清单 `manifest\manifest.tsv`、库级默认 `manifest\profiles.json`、产物 `Generated\`、报告 `Reports\`。
方案与实测证据在工作区 `README.md` 与 `docs\Kontakt-Lua-发现与坑.md`（**动手前先读那份**）。

## 已注册的工具（OpenChamber / Code Mode 直接调用）

`plugin/index.ts` 把 `scripts/*.mjs` 注册成 `kontakt` 命名空间的工具：

| 工具 | 需要 Kontakt？ | 作用 |
|---|---|---|
| `kontakt_env` | 否 | 环境闸门：可执行、Lua API 开关、在跑的实例、工作区可写、扫描配置、库索引 |
| `kontakt_db_build` | 否 | 扫库建 `data/kontakt-patches.csv`（Library / RelDir / PatchFile / 大小 / 路径） |
| `kontakt_db_query` | 否 | 查索引拿精确 `.nki` 路径（`--patch` / `--folder` 是正则，其余子串） |
| `kontakt_manifest_lint` | 否 | 清单体检：必填列、文件存在、slot/midi/port/out/vol/pan、multi 名、mic profile |
| `kontakt_profiles` | 否 | 看 `profiles.json`：defaults / pan_by_section / mic_aliases / mic_profiles / mic_snapshots |
| `kontakt_reports` | 否 | 汇总 `Reports\*.txt`（列表 / 单份明细 / 写 `manifest.verify.csv`） |
| `kontakt_gen_multi` | **是** | 清单 → `.nkm`（A1–A6），存盘后重载回读并与期望值自动比对 |
| `kontakt_inspect_multi` | **是** | 侦察 `.nkm`：槽位参数、库是否加密、group 名普查、麦克风读数（只读） |
| `kontakt_verify_multi` | **是** | 回读已有 `.nkm` 并与 `Generated\_expect\<multi>.csv` 比对 |
| `kontakt_probe_library` | **是** | 进新库先探测：库类型、group 名规律、麦克风名候选；`api=true` 列 API；**`structure=true` 探技法/力度层是脚本还是原生**（只读） |
| `kontakt_apply_snapshot` | **是** | 把 `.nksn` 套到 multi 的槽上（**OT 全系 / 8Dio Requiem 这类"槽受保护或注入不持久"的库的麦通路**；有空脚本槽的复位库走 MIC-ADAPTER 更好）；`visual=true` + `save=<路径>` 产出可打开的检查 multi |
| `kontakt_learn_mic` | **是** | 从你已调好的 `.nki` 学出麦克风 dB → 打印片段；`write=true` 直接写回 `profiles.json`（先备份 `.bak`） |
| `kontakt_snapshot` | 否 | `.nksn` **只读体检**：列出可读参数名、关键词命中、两份差异。**绝不修改 snapshot** |
| `kontakt_snapshot_diff` | 否 | `.nksn` **对齐感知差分**：找"哪几个字节变了 + 旁边叫什么"（反推参数用）；只读 |
| `kontakt_snapshot_lookup` | 否 | `.nksn` 按**名字**或按**值**查（秒级）；只读 |
| `kontakt_findings` | 否 | ★ **本机成果库** `data\findings.json`：每个库的类型/家族/快照/麦克风 token/已定位参数。探测类工具会自动往里写 |
| `kontakt_probe_libraries` | **是** | **批量读库**：一次进程装一批库（`chunk`），逐个 dump 结构并**自动写进成果库**（几十个库几分钟） |
| `kontakt_group_persist` | **是** | **验证这个库的 group 音量能不能存住**（= 麦克风能不能全自动）：全 group 设 −12 → 存 → 重载 → 再读 |
| `kontakt_load_test` | **是** | **装载体检**：这批 `.nki` 哪个装得开（只 `load_instrument`，很快）。范围 `library` / `folder` / `patch`；**坏采样的库要 `skip` 掉**（否则弹模态框把脚本卡死） |
| `kontakt_mic_mine` | 否 | **从已有报告里挖麦克风 token**（不启动 Kontakt）：把 group 名的字段拆出来当候选；`write=true` 写进 `mic_tokens` |
| `kontakt_library_info` | 否 | **库总表**（秒级，不启动 Kontakt）：扫 `.nicnt` 拿正式库名/厂牌/授权系统/SNPID + nki 数与采样形态 |
| `kontakt_vepro_bridge` | 否 | **multi → VE Pro 通道**：`list` / `cache`（导出并缓存 state + 存 VEP 预设）/ `apply`（**克隆**一条已知能用的通道再灌 state）/ `verify` |
| `kontakt_run_lua` | **是** | 逃生舱：前置检查 → 启动 Kontakt 跑一个 `.lua` → 回传报告（`dryRun` 只演练） |

## 核心事实（决定一切设计）

1. **Lua API 要开关**：`HKCU\Software\Native Instruments\Kontakt 8` → `DeveloperFeatures`。
   **0 时脚本根本不会执行**（无报错、静默）→ 任何要跑 Kontakt 的事都先 `kontakt_env`。
2. **一个 Lua 脚本 = 一次进程**：只能传一个 `.lua` 文件、**没有参数、没有 JSON 库**（Lua 5.4 + `os`/`io`）。
   所以固定动作是「带脚本启动 → 跑完 `os.exit(0)`」；配置只能写死在脚本里或 `dofile()`。
   **不能在运行中的实例里被外部触发。**
3. **报告必须自己写文件**：无人值守时终端看不到 → 脚本写 `Reports\*.txt`，工具再去读。
4. **索引坑**：一个 multi = 64 个 instrument slot；Lua 的 `instrument_idx` 是 **128 一跳**（slot0=0、slot1=128…）。
   `load_instrument` 落在已被占用的 idx 上会**自动用下一个空位** → 必须用它的返回値当落点。
5. **加密库的 group 音量写不进去**：写进去立刻能回读，`save_multi` → `load_multi` 后被库复位。
   → 麦克风比例分两类：
   **38 个库**（含 CSS / SCS / Cinesamples 全家 / Spitfire Studio 系列 / 8Dio Anthology·Lacrimosa·Silka /
   Audiobro 主 patch / Performance Samples 全家 / SonicCouture / Heavyocity / 自己的 `MSB *.nki` 样板）
   **直接写 group 音量**，清单 `mic` 列写这些 token 即可（例 `Close=-6;Stage=-4;Surround=off`）；
   剩下的是**复位库**，分两条路（2026-10-19 定稿）：
   - **有空脚本槽**（例 **Strezov 五套**）→ gen 自动往空槽注入 **`MIC-ADAPTER`** 脚本适配器
     （`on init` 写 group 音量 + `persistence_changed`/`ui_update` 兜底，**随 `.nkm` 存住**）→ 清单照写 dB 即可，**不用快照**；
   - **槽全 protected / 注入不持久**（**Orchestral Tools 全系**、**8Dio Requiem**）→ **每库一份人工调好的 snapshot（`.nksn`）**。
   ⚠️ **判据一律是实测，不是"有没有 protected"**：
   - LASS 3 的 263 个 `z - Legacy Instruments\` 分技法 patch **脚本受保护，却照样写得进去、存得住**（4/4 实测）；
   - **CSS / SCS 曾被推断为"要 snapshot"，实测 group 音量能写能存**；
   → 所以工具**不再**因为 `protected` 就跳过写入，而是**照写 + 回读比对**；真存不住会被判成「库复位」。
   → 查整库：`kontakt_group_persist --all`；查单点：`kontakt_group_persist --patch=<那个 .nki>`。
   ⚠️ 另外"能写 group 音量"≠"麦克风能按名字切"：还要看 group 名怎么组织（SCS 的四套麦是四个 patch 目录）。
6. **snapshot 必须用 UI 调出来**：脚本先改 group 音量再 `save_snapshot` 是**无效的**（快照存的是库自己的 UI 状态）。
   而且 snapshot 会连带承载该库 UI 的其它状态 → **一个库的 snapshot 要当「该库的标准状态」维护**。
7. **`.nkm` / `.nki` 对加密库不透明**：熵≈8、无明文、每次导出字节都不同 → **不解析、不手改**。
   一个 multi 的内容唯一可读窗口是 Lua（`get_instrument_name` / `get_instrument_midi_channel`）。
8. **VEP 侧的 Kontakt 参数面是空的**（4131 个参数只有 Disable/Bypass/#000..#511 全 0）→
   麦克风/库参数**不能从 VEP 侧读写**，必须在 Kontakt 侧解决。
9. **`.nksn` 不是加密的**：是**明文参数容器**（熵 6.5–7.1，不是 8）。实测能读到
   `ARTICULATION` / `legato` / `ks_mono_poly` / `_switch` / `xfade` / `_mic` / `_dyna` / `artic_name`
   这类参数名，以及 `Blurred` / `Tremolo` / `Trills` / `Pizzicato` 这类技法名 ——
   但**值在被混淆的段里，读不出来**，也**绝不能改**（会破坏 NI 的格式与校验）。
   → 它只能用来「体检」（这份快照里有没有带技法/键位/xfade 那些块）和「两份对比」（标准状态有没有变）。
   → 库 UI 上的开关（CSS 的 **KS 键位**、Berlin 单音的 **xfade→velocity**、CAPSULE mixer）**唯一落地手段**
   仍是：人在 GUI 里调一次 → 存 snapshot → `apply_snapshot` 套到全库。**不能"口述 → 直接落地"**。
10. **Kontakt 原生的 group start 条件可以程序化读写，而且存得住**（未加密库实测）：
   `set_group_start_options(idx, group, {[n] = { mode = "controller", controller = 110, cc_min = 1, cc_max = 30, next = "and" }})`
   → 写进去 → `save_multi` → `load_multi` → 回读**一致**。条件类型 `controller` / **`key`** /
   `random` / `round_robin` / `slice_trigger`，组合符 `and` / `and_not` / `or`。
   → 所以「哪个 CC / 哪个键触发哪些 group」这一层**是能脚本化的**——但只对"用原生 start 条件实现切换"的库
   （实测 CSS 是：609 个 group 带 CC110/111 区间条件；Berlin / MSB / Pacific 都没有）。
11. **Lua 的编译/运行错误写在 stderr**（`[kontakt.scripting] [error] <文件>:<行>: …`）——不是静默的。
   `kontakt_run_lua` 会把这类错误单独列出来。**没有报告 + stderr 里有 scripting error = 脚本没跑起来**。
12. Kontakt 退出时那一串 `bmemory.cpp DoVMUnLock: VirtualUnlock(...) errno = 158` 就是
   `0xC0000005` 的来源（关机阶段），**与作业成败无关**。
13. **坏采样会弹模态框把整个作业卡死**：0 字节采样 → 「Sample could not be loaded … Do you want to continue loading?」
   → Lua 停在 `load_instrument` 等回答 → 整块超时、**同块里其它 patch 的结果也一起丢**（机器可读块是跑完才写）。
   agent 起的实例没窗口，看不到弹框。**对策：坏库（0 字节）用 `kontakt_load_test --skip=<库>` 跳开，`chunk` 调小。**

## 写盘与安全（硬约束）

- **只写工作区**；不动 `C:\VEPRO` 下其它工程、不动 `Documents` 里的 VSL 预设、不动音色盘（D/E/F/G）。
- **产物只进 `Generated\`**；不覆盖手做的 multi。
- **默认只报告**：工具里带 drain 的动作默认只出计划，写盘要显式要求；已存在的文件要覆盖须显式 `force`。
- **跑 Kontakt 前确认不是用户在用的工程**（会抢音频设备）；`kontakt_run_lua` 会先列出在跑的实例。
- **清单是唯一事实来源**：手工在 Kontakt 里改过的内容，下次生成会被清单覆盖。
- **进新库先跑探测**（枚举 group 名 → 确认麦克风别名），再批量。

## 配置

`config/libraries.json`（本机私有，已 gitignore；形状见 `config/libraries.example.jsonc`）：

- 扫描根顺序：工具参数 `root` > 该配置 > 两者都没有时**只探测候选并退出**（绝不静默扫全盘）。
- 另外可放 `workspace`（工作区路径）、`exclude`、`extensions`、`max_depth`、`library_tokens`。
- 环境变量 `KONTAKT_WORKSPACE` 也可改工作区。

## 标准工作流

1. `kontakt_env` —— 环境能不能跑。
2. `kontakt_db_query` —— 找到目标库的真实 `.nki` 路径（不要凭记忆写路径）。
3. 写清单 `manifest\manifest.tsv`；`kontakt_manifest_lint` 过一遍（要 0 ERROR）。
4. `kontakt_profiles` —— 确认声部声像与麦克风 profile。
5. （M2 起）`kontakt_gen_multi` 出 `.nkm` 并自动回读校验；`kontakt_reports` 看体检表。
6. （M4 起）交 `vepro-api` 灌通道。

## 麦克风的三条路（最重要的规范）

| 库 | 怎么写 | 清单写法 | 能否自动 |
|---|---|---|---|
| **能写能存**（Performance Samples、Aaron Venture、`MSB *.nki` 样板，**以及 CSS / SCS / LASS / Cinesamples** —— 加密也能写） | 直接写 group 音量 | `mic = CLOSE=-6;others=off` 或 profile 名 | ✅ 全自动，且**能数值验证** |
| **复位但有空脚本槽**（**Strezov 五套**；个别未受保护的库也是） | gen 自动注入 **`MIC-ADAPTER`**（KSP 改 group 音量，随 `.nkm` 存住） | 同上（照写 dB） | ✅ 全自动（`--adapter=auto`，默认开） |
| **槽全 protected / 注入不持久**（**OT 全系**、**8Dio Requiem**） | 库自己的 UI 状态，只能靠 `.nksn` | `mic = berlin`（→ `profiles.mic_snapshots`）；或 `mic = snap:<文件>` | ⚠ 需**每库人工调一次** snapshot |

- snapshot **必须人在 UI 里调出来**才有效（脚本改完 group 音量再存是无效的）。
- snapshot 会**连带承载该库 UI 的其它状态** → 一个库的 snapshot 当「该库的标准状态」维护。
- 快照那条路的比例**不落在 group 音量上**，数值读不出来 → 只能人眼确认（`apply_snapshot --visual` 摆对照）。
- 判「库复位」要看**写之前的基线**：各库基线不同（MSB 0.037 / Berlin 0.001627），不能拿「值很小」当判据。
- 往空槽注入脚本的**硬规矩**：`set_instrument_script_source` 收**正文**不是路径；KSP 里顶层 `declare` 不能带初值、
  `on init` 不能 `call` 用户函数、`function` 要在调用点之前、`{ }` 注释要闭合；**判"真跑了"必须留可回读副作用**。

## 两条铁律（会静默出错，必须记）

1. **`save_multi` / `load_multi` 只吃 ASCII 路径**：路径里有中文（或其它非 ASCII）会**静默失败**
   （`pcall` 返回 true、无报错、磁盘上什么都没有）→ Lua 侧用 ASCII 中转名，Node 跑完再改名
   （`lib.mjs` 的 `asciiNkmPath` / `stageInputNkm` / `stageOutputNkm` 已封装）。
2. **VEP 的通道要"克隆"，不能"新建裸通道"**：`channel/add` 建的通道灌了 state 也**不发 MIDI**
   （Kontakt 提示检查 DAW 连接），且没有默认通道条 FX → 用 `instance/clonechannels` 克隆一条
   已知能用的通道，再 `channel/title/set` 改名（`vepro_bridge --apply --from=<源通道>`）。

**一种例外，能直接设**：如果库的切换是**原生 group start 条件**（CSS 的 CC110/111 区间就是），
那 `set_group_start_options` 能程序化改、而且存得住（未加密库实测）。
先 `kontakt_probe_library(structure: true)` 看目标是哪一类。

## 进度

- **M1 已完成**（harness 工具接口验过）：`env` / `db_build` / `db_query` / `manifest_lint` / `profiles` / `reports` / `run_lua`。
- **M2 已完成**（真跑 Kontakt 验过）：`gen_multi` / `inspect_multi` / `verify_multi` / `probe_library`。
- **M3 已完成**（真跑验过）：`apply_snapshot`（含 `--visual` 对照）/ `learn_mic`（含 `--write` 写回）。
- **M3+ 已完成**：`snapshot`（`.nksn` 只读体检）、`probe_library --structure`、`verify_multi` 基线判定、
  `migrate_profiles`（`profiles.lua` → `profiles.json`，**一次性，已删**）；并实测**原生 start 条件可写可持久**。
- **M4 已完成**（2026-10-19）：`library_info` / `probe_libraries` / `group_persist` / `mic_mine` / `load_test` /
  `findings` / `snapshot_diff` / `snapshot_lookup` / **`vepro_bridge`**（multi → VEP 通道）；
  以及 **MIC-ADAPTER 脚本适配器**（复位库全自动）、**ASCII 路径铁律**。
- **24 个工具**（其中 `migrate_profiles` 是一次性迁移，已用毕、保留供重跑）。新增发现见工作区 `docs\` 与 `references\`。

## 维护

- 脚本是 **Node `.mjs`**（不是 PowerShell）：这层全是文本/JSON/进程编排，一种语言更省事。
  姊妹 skill `vsl-synchron-player` 用的是 PowerShell。
- ⚠️ **插件里 `process.execPath` 不是 node**：它是 OpenCode 自己那个 Bun 单文件（`opencode.exe`），
  拿它当解释器只会得到一支 `opencode` CLI 的参数错误。所以 `plugin/index.ts` 显式找 node
  （`$KONTAKT_NODE` > `C:\Program Files\nodejs\node.exe` > `where node` > `PATH`）。
- 插件注册：`C:\Users\Administrator\.config\opencode\plugins\kontakt-preset-generator-skill`
  → junction 到本目录的 `plugin\`（`plugins/` 下的目录会被自动发现）。
- 改了插件代码：`opencode reload` 即可（比重启服务轻，不用 `opencode service restart`）。
- ⛔ **改工作区里的中文文件（`README.md` / `docs\*.md`）一律用编辑工具，不要用 PowerShell 的
  `Get-Content | Set-Content` 往返** —— PS 5.1 会按 ANSI 读、按 UTF-8+BOM 写，中文直接写坏。
  本轮这个坑踩了两次（`probe-library.mjs`、工作区 `README.md`）。同样适用于改脚本文件。
- 细节与踩坑见工作区 `docs\Kontakt-Lua-发现与坑.md`；外部参考：Kontakt Lua API 官方手册
  `https://docs.native-instruments.com/ni-tech-manuals/kontakt-api-reference-manual/en/`
