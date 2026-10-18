# 环境与执行

> 通用文档（去个人化）。本机特有的盘符 / 用户目录 / 库清单不在**硬编码**里；
> 它们由工作区配置（`config/libraries.json` 的 `scan_roots` / `workspace`）或环境变量给出。

这篇管「怎么把 Lua 喂给 Kontakt、跑起来会怎样、结果从哪看」。

## 1. Kontakt 可执行与 Lua API 开关（不查就白等）

| 项 | 事实 |
|---|---|
| 可执行 | Kontakt 8。工具按候选路径表探测，也可用 `--exe=<路径>` 显式指定（见 `lib.mjs` 的 `KONTAKT_EXE_CANDIDATES`）；实测版本 8.9.0。 |
| Lua API 开关 | `HKCU\Software\Native Instruments\Kontakt 8` → `DeveloperFeatures`。`0` = 关，`1` = 开。 |
| 关键 | **关着的时候 Kontakt 收到脚本什么都不做，也不报错、不写报告**（静默）→ 要启动 Kontakt 的动作**先跑 `kontakt_env`**。 |

## 2. 一次运行 = 一个进程，而且不能传参

- 执行方式：`"Kontakt 8.exe" "<脚本.lua>"` —— **只能给一个 `.lua` 文件**，没有 `--flags`，脚本里也没有 `arg`。
- 所以配置只能：**写在脚本里**，或 `dofile()` 读进来。
- **不能在运行中的实例里被外部触发**；固定动作是「带脚本启动 → 跑完退出」。
- 脚本环境是 **Lua 5.4 + `os` / `io`**；**没有 JSON 库**。
  → 本仓库的做法：**Node 侧把配置渲染成 Lua 字面量**塞进 `jobs\<时间戳>-<slug>\job.lua`。
- `os.exit(0)` 生效、干净退出；**不写就留着进程**（但如果脚本中途抛了未 `pcall` 的错误，后续语句包括 `os.exit` 都不会执行 → 进程不退、报告不写，见 `pitfalls.md`）。
- **只有窗口 / 未受保护的库才能被脚本看见内容**：未加密库的乐器数据明文可读，加密 / Player 库数据不透明（熵 ≈ 8）→ 不要试图解析。

## 3. 报告就是接口

无人值守时终端输出看不到 → **每个作业必须自己写 `Reports\*.txt`**。

成功的判据：**报告里有 `==== end ====`**（不是退出码，见 §5）。

报告里固定有几段机器可读块（TSV，Node 侧解析）：

| 块 | 列 |
|---|---|
| `SLOTS` | `slot idx name midi out vol pan mute solo tune poly keysw kmin kmax vmin vmax trans` |
| `LIBS` | `slot protected scripts` |
| `MICS` | `slot mic n min max`（gen 还会多 `base_min base_max` = **写之前的基线**） |
| `BASELINES` | `slot mic base_min base_max`（verify 用「干净装载」读出来的库默认值） |
| `ADAPTERS` | `slot script_slot groups src_len` |

## 4. Lua 的报错写在 stderr 里（不是静默）

```
[kontakt.scripting] [info]  [VM.cpp:72] Run Lua script 'C:\...\x.lua'
[kontakt.scripting] [error] [VM.cpp:79] C:\...\x.lua:91: '}' expected near '='
```

- **没有报告 + stderr 有 `[kontakt.scripting] [error]` = 脚本根本没跑起来**（编译错或运行错）。
- `kontakt_run_lua` 会把这类错误单独列出来，并在看到 `scriptError` 时**提前收工**、打印日志尾巴。
- 顺带：**`print()` 的输出也进 stderr**（`BindPrint.cpp`），所以报告文件才是最可靠的通道；要看日志尾巴要看 stderr，不是 stdout。

## 5. 退出时报 `0xC0000005` 是正常的

- 退出码 `3221225477`，stderr 里刷一屏 `[kontakt.app] [error] [bmemory.cpp] DoVMUnLock: VirtualUnlock(addr = …) failed with errno = 158`。
- 这是**关机阶段**的内存解锁噪音，**与作业成败无关**。判据永远是**报告有没有结尾 `==== end ====`**。
- 实测已复现十几次，产物（`.nkm`）完好、能反复回读。

## 6. ⚠️ agent 启动的 Kontakt 没有窗口

- 实测：进程活着，但 `list_windows` 里**连隐藏窗口都找不到**（只有用户自己启动的实例有窗口）。
- 后果：
  - 靠"留个实例给人看"的模式（`--visual`）**对 AI 自己没用**；
  - 要人眼确认的东西，要么**生成可打开的 `.nkm` 给用户**，要么**用户开实例、AI 截屏**；
  - 坏采样弹的模态框没人点 → 整块作业卡死（见 `pitfalls.md`）。
- 截屏：用 `capture` 类工具（`list_windows` / `capture_window` / `capture_screen` / `capture_region`），它用 PrintWindow 渲染、**不抢焦点**；产物落在工作区的 `.captures\`。
- **用户点槽、AI 读图**，是"库 UI 状态"唯一可行的验证闭环。

## 7. 其它环境事实

| 项 | 值 |
|---|---|
| 常量 | `Kontakt.version` / `.windows` / `.max_num_instruments`（64）/ `.max_num_scripts`（5）/ `.max_num_groups`（4096） |
| 路径常量 | `.ni_content_path`（NI 内容根，通常在公共 Documents 下）、`.snapshot_path`（用户 Documents 下的 `Native Instruments\User Content\`） |
| `Kontakt.get_file_info()` | 返回 **table**，不能当布尔；字段名要 `pairs` 才知道 |

> 路径一律用**正斜杠** `/` 最稳（含空格没问题）。

## 8. 执行卫生

- **Kontakt 的存盘 / 读盘不吃非 ASCII 路径**（中文路径静默失败）→ 走 ASCII 中转名 + Node 改名，见 `pitfalls.md` 第「存盘与路径」组。
- **agent 的 shell 是阻塞的**：前台跑会开 Kontakt / 等界面的长命令时，用户消息看不到、弹框也没人点 → 表现就是"永久超时"。凡这类命令**一律后台跑 + 合理超时**。
- **两个 Kontakt 启动挨太近会撞音频设备** → 新进程可能卡住；批量链里每两段之间**留 20–25 秒**，工具也支持 `--kill-on-timeout` 把卡住的那个掐掉（默认不掐）。
- **跑之前确认没有用户在用的实例**（会抢音频设备、两个实例还可能共用同一个浏览器数据库）。
- **`save_multi` 不会自己建目录** → 写盘测试前先建目录，目录不存在会直接 `[FAIL] save_multi -> path doesn't exist`。

## 9. 编码注意事项（本仓库中文文件的维护纪律）

- ⛔ **不要用 PowerShell 的 `Get-Content | Set-Content` 往返改中文文件** —— PS 5.1 按 ANSI 读、按 UTF-8+BOM 写，**中文直接写坏**（本项目踩过多次）。一律用**编辑工具**改（`README.md` / `references\*.md` / 脚本注释都算）。
- **控制台里中文会乱码**（PowerShell 管道编码）→ 要看中文就 `| Out-File -Encoding UTF8` 写进文件再用读取工具看；或让脚本输出的标签全用 **ASCII**。**别拿乱码输出当结论。**
- 仓库行尾统一 **LF**（`.gitattributes`：`* text=auto eol=lf`；`*.nkm` / `*.nki` / `*.nksn` 等按二进制不 diff / merge）。
