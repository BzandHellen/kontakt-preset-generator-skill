# 工作流与数据模型

> 通用文档（去个人化）。本机特有的库名 / 路径 / 快照文件名 / 偏好数值**不在**这里；
> 那些在工作区的 `work\manifest\profiles.json`、成果库（`data/findings.json`）与个人文档里。

这篇管两件事：**清单怎么变成 `.nkm`**，以及 **multi / instrument / group / zone 长什么样、哪些字段能程序化写**。
**动手前先判：要改的东西属于哪一层。**

## 1. 作业模型（一次运行 = 一个进程，所以这样落地）

Kontakt 只能「带一个 `.lua` 启动」，脚本里拿不到参数、也没有 JSON 库。所以：

```
① Node 算好每个槽的最终值（plan：defaults / pan_by_section / mic profile 全部落成具体值）
② 渲染 jobs\<时间戳>-<slug>\job.lua ：模板 + 把配置序列化成 Lua 字面量塞进去
③ 启动 Kontakt 跑它；等退出 / 等报告
④ 解析报告里的机器可读块（SLOTS / LIBS / MICS / BASELINES / ADAPTERS），跟期望值比对
```

- 模板用 `@LIB@`（公共 Lua 库 `scripts/kontakt_lib.lua`）与 `@JOB@`（配置表）两个占位符。
- **作业 Lua 可以直接看懂、也能手动重跑**（配置就在文件顶部的 `JOB` 表里）。
- 公共 Lua 库负责：日志 / 报告 / 机器块 / 麦克风三种匹配 / 槽位读取 / `pcall` 包装 / `wait_file`。

## 2. 清单列字典（`manifest\manifest.tsv`）

| 列 | 必填 | 含义 |
|---|---|---|
| `multi` | ✓ | multi 名（= VEP 通道名 = 预设名 = 文件名）。 |
| `slot` | | 槽位 0–63；留空则顺序排（有 `slot` 的行先按它升序装，其余接在后面）。 |
| `patch` | ✓ | `.nki` 绝对路径。 |
| `name` | | 槽内乐器名。**留空 = 保持 patch 原名**（核对时看得到原始 patch 名，推荐留空）。 |
| `midi` | | 1–16（缺省 = 该 multi 内第几个，封顶 16）。 |
| `port` | | A–D（与 `midi` 合成 Kontakt 的 1–64）。 |
| `out` | | 输出通道号。 |
| `vol` | | 音量 dB。 |
| `pan` | | 声像 %（缺省按 `pan_by_section` 里的声部匹配，匹配不到用 `defaults.pan`）。 |
| `mic` | | profile 名 / 内联 `名=dB;others=off` / `snap:<.nksn>` / `learn:<已调好的 .nki>`。 |
| `keysw` | | `ks=C0;tr=-12`（也认 `kmin/kmax/vmin/vmax`）。 |
| `snapshot` | | 逐槽强制套某个 `.nksn`（覆盖 `mic` 里的 snapshot 规则）。 |
| `note` | | 备注（工具不读）。 |

- `#` 开头是注释行；第一个非注释行是表头。
- **清单是唯一事实来源**：手工在 Kontakt 里改过的内容，下次生成会被清单覆盖。
- 列若整列空白，**先怀疑表头与数据 key 不一致**（不是"没数据"）。

## 3. 期望值与报告

| 文件 | 谁写 | 说明 |
|---|---|---|
| `Generated\_expect\<multi>.csv` | `gen_multi` | 期望槽位值；**第一列 `src` = 来源清单**（同名 multi 来自不同清单时会提醒覆盖）。 |
| `Generated\_expect\<multi>.mic.csv` | `gen_multi` | 期望麦克风 dB（`others` 不进这张表，它的命中数写在报告里）。 |
| `Reports\gen-<multi>-<时间戳>.txt` | 作业 | 生成 + 重载回读；含 `SLOTS` / `LIBS` / `MICS` / `ADAPTERS` 块。 |
| `Reports\verify-…` / `inspect-…` / `probe-…` / `apply-snap-…` | 作业 | 各自的报告。 |

报告里的机器块（TSV，Node 侧解析）：

| 块 | 列 |
|---|---|
| `SLOTS` | `slot idx name midi out vol pan mute solo tune poly keysw kmin kmax vmin vmax trans` |
| `LIBS` | `slot protected scripts` |
| `MICS` | `slot mic n min max`（gen 还会多 `base_min base_max` = **写之前的基线**） |
| `BASELINES` | `slot mic base_min base_max`（用"干净装载"读出来的库默认值） |
| `ADAPTERS` | `slot script_slot groups src_len`（注入了脚本适配器的槽） |

**每个机器块必须各自命名**：早期三个块都叫同一个名字，解析只拿到第一个 → 所有比对"实际"为空。

## 4. 槽位与索引（最容易踩的坑）

| 概念 | 事实 |
|---|---|
| 一个 multi | **64 个 instrument slot**；每个 slot 放一个 instrument，或一个 instrument bank（bank 内最多 128 个乐器）。 |
| Lua 的 `instrument_idx` | **128 一跳**：slot0→`0`、slot1→`128`、slot2→`256`… |
| `load_instrument(path, idx?)` | 省略 idx = 下一个空位；**idx 被占用会自动换到下一个空位** → **必须用返回值当落点**。 |
| `add_instrument(slot?)` / `add_instrument_bank(slot?)` | 参数是 **slot 序号 0..63**，与 `instrument_idx` 不是一回事。 |
| `set_instrument_midi_channel(idx, ch)` | **`0` = Omni；`1..64` = A–D 端口 × 16 通道**（界面上是 1–16，跨端口要自己换算）。 |
| `get_instrument_indices()` | 返回所有 instrument 的 idx（**不是** 0..N−1 连续，是 128 的倍数）。 |
| `load_multi` 的返回值 | **不是** instrument 索引；重载后要回读得另取 `get_instrument_indices()`。 |

## 5. 参数面三层：先判"能不能写"

| 层 | 例子 | 能不能程序化 |
|---|---|---|
| **Kontakt 原生属性** | 音量 / 声像 / 输出 / MIDI 通道 / 名字 / 静音 / 独奏 / 复音 / 调音；instrument options（keysw / 音域 / 移调 / 力度范围）；**group start 条件**；group 音量·声像·调音·播放模式；zone 键域·力度域·音量 | ✅ **能写、能持久** |
| **库自己的脚本 UI** | 库的 mixer / 键位开关 / xfade 模式 / 其它设置页 | ❌ **读不到也设不了**（受保护脚本）→ 只能靠 **snapshot 整包搬运**，或注入脚本适配器 |
| **宿主侧 MIDI** | 把某个键 / CC 换掉 | ✅ 但那是 VEP / DAW 的活 |

⚠️ 上面"能持久"是**实测口径，不是"有没有 protected"**：存在"脚本受保护却照样写得进去、存得住"的库，也存在"某层能存、但 group 音量这一层会被库复位"的库。**判据一律是回读比对**。

## 6. instrument 级 API

| 清单列 | API |
|---|---|
| `name` | `set_instrument_name(idx, name)` |
| `midi` + `port` | `set_instrument_midi_channel(idx, 1..64)`（0 = Omni） |
| `out` | `set_instrument_output_channel(idx, ch)` |
| `vol` | `set_instrument_volume(idx, dB)`（−inf…12） |
| `pan` | `set_instrument_pan(idx, %)`（−100…100） |
| `keysw` / 音域 / 移调 | `set_instrument_options(idx, { key_switch, key_range_from/to, velocity_range_from/to, midi_transpose })` |
| `snapshot` | `load_snapshot(idx, 绝对路径)`（**绕过 GUI 的按乐器过滤**，见 `snapshots.md`） |

补充：

- `get_instrument_options` 里 `key_switch` 缺省是 **nil**、`key_range_from/to` 缺省 **0/127**、`velocity_range_*` 缺省 **0/127** → **只写 key_switch / transpose 不会顺手改掉音域**。
- 音名换算按 **C3 = 60**（所以 `C0` = 12、`C-1` = 0）。
- `set_instrument_mute` / `solo` / `polyphony` / `tune` / `aux_level` 都在；`reset_instrument(idx)` 可复位单个乐器。
- 写麦相关的 KSP 刻度：`$ENGINE_PAR_VOLUME` 是**立方刻度** `unit = 630000 × 10^(dB/60)`（`630000` = 0 dB），**不是** `10^(dB/20)`。

## 7. group start 条件：原生层，可写可持久

**"哪个 CC / 哪个键触发哪些 group"这一层能脚本化。**

```lua
Kontakt.set_group_start_options(idx, group_idx,
  { [1] = { mode = "controller", controller = 110, cc_min = 1, cc_max = 30, next = "and" } })
-- 读回来：{1={cc_max:30, cc_min:1, controller:110, mode:controller, next:and}}
-- save_multi → load_multi → 回读一致
```

| 可用值 | |
|---|---|
| `mode` | `controller` / **`key`** / `random` / `round_robin` / `slice_trigger` |
| `next`（组合符） | `and` / `and_not` / `or` |

- 只在**用原生 start 条件实现切换**的库上有意义（用脚本实现切换的库，这一层没有内容）。
- ⚠️ **持久化程度按库实测**：有的"复位库"其实**只有 group 音量这一层会被复位**，group 声像 / 播放模式 / start 条件 / zone 域都能存住；也有的库会复位更多。**只有回读一致才算数。**
- `mode = "key"` 存在，意味着"原生实现的键位切换"理论上也能设；具体哪个库用它、字段名怎么填，**待确认**。

## 8. 受保护脚本 = 库内部黑盒

- 判据：`is_instrument_script_protected(idx, slot) = true` → `get_instrument_script_source` 拿不到内容。
- ⚠️ **同一库里不同 patch 的 protected 标记可能不一样**，而且 protected ≠ 写不住 → **别用 protected 当唯一判据**。
- **Lua ≠ KSP**：不能借 Lua 执行脚本、也没有宿主自动化参数接口。
- ⚠️ **Lua 不能注入 MIDI** → "切换行为是否真的生效"**没法程序化测**，只能人眼 / 人耳。

## 9. group / zone / 其它数据结构

| 项 | 说明 |
|---|---|
| group | `get_num_groups(idx)`、`get/set_group_name`、音量 / 声像 / 调音 / playback mode、`get/set_group_start_options` |
| zone | `get_num_zones(idx)`、`get_zone_group(idx, z)`、`get/set_zone_low_key\|high_key(low_velocity\|high_velocity)`、`get/set_zone_volume\|tune\|pan` |
| zone 数量级 | 单 patch 可达**数万个**（实测有 8 万+ 的例子）→ 普查 zone 一定要**设上限并说明截断**，否则很慢 |
| 一个 multi 的内容 | **唯一可读窗口是 Lua**（`get_instrument_name` / `get_instrument_midi_channel` …） |

API 细节速记：`set_group_playback_mode` 要传**字符串**（`"dfd"` / `"sampler"`）；`get_group_pan` 会返回 `39.999996` 这种浮点 → 比较**必须留容差**（0.01 量级）。

## 10. 文件层：不透明，别碰

- **`.nkm` / `.nki` 对加密库不透明**：熵 ≈ 8、无明文、**每次导出字节都不同**（重新加密 / nonce）。
- 它还整份原样躺在 VEP 工程 / autosave 里 → **改工程文件同样无效**。只有 Kontakt 自己能读写。
- 所以边界是：**不解析、不手改 `.nkm` / `.nki`**，只让 Kontakt 自己写、自己读，脚本负责"喂料 + 校验"。
- `.nksn` 不一样（是**明文参数容器**）——见 `snapshots.md`，但同样**只读、绝不改**。

## 11. 生成流程 A1–A6（`gen_multi` 内部）

| 步 | 做什么 |
|---|---|
| A1 | 建空 multi。 |
| A2 | 逐槽 `load_instrument`（用返回值当落点）。 |
| A3 | 逐槽设参数（instrument options / MIDI 通道 / 输出 / 音量 / 声像 / keysw）+ 麦克风分流（① 写 group 音量，② 或注入脚本适配器）。 |
| A5 | `save_multi`（先删旧文件；写不出就判失败，不重载）。 |
| A6 | 重载 + 回读，跟期望值逐字段比对（数字按容差，字符串完全相等）；空期望 = 不检查。 |

> 源码注释里就是 A1 / A2 / A3 / A5 / A6，**没有 A4**（编号跳了一格）——按现状沿用。

## 12. 标准流程（用工具时）

1. `env` —— 环境能不能跑。
2. `db_query` —— 找到目标库的真实 `.nki` 路径（**不要凭记忆写路径**）。
3. 写清单；`manifest_lint` 过一遍（要 0 ERROR）。
4. `profiles` —— 确认声部声像与麦克风 profile。
5. `gen_multi` 出 `.nkm` 并自动回读校验；`reports` 看体检表。
6. 需要时 `apply_snapshot` 套快照；最后 `vepro_bridge` 灌通道。
