# data/ —— 索引与成果库

这里的内容分三类，**归属不同**：

| 文件 | 进 git？ | 是什么 | 怎么来 |
|---|---|---|---|
| `kontakt-patches.csv` | ❌ | 扫库得到的 patch 索引（本机 1.6 万条） | `kontakt_db_build` |
| `findings.json` | ❌ | ★ **本机探测成果库**：每个库的类型 / 脚本 / group / 原生 start 条件 / 音量能否存 / 家族 / 快照 / 已定位的参数 | `probe_libraries` / `probe_library` / `group_persist` / `mic_mine` / `load_test` / `library_info` 会自动往里写；`kontakt_findings` 读写 |
| `findings.example.json` | ✅ | 成果库的**形状示例**（无本机路径） | 手维护 |

前两类含你的本机路径与库信息，**故意不进 git**（换机器要重建）。
第三类是 schema，跟着仓库走。

## 成果库存什么

一句话：**"这个库到底是什么"** —— 免得每轮重新摸一遍，也免得结论只躺在散文文档里。

- 库级：`kind`（加密/未加密）、`scripts`（数量/受保护/脚名）、`groups`、`native_start_conditions`、
  `velocity_split_groups`、`group_volume_persists`、`mic_aliases`、`mic_name_shape`
- 结构异常：`structure.mic_variant_dirs` / `structure.technique_dirs` / `structure.note`
- 快照：`snapshots[]`（出自哪个 patch、改了啥、**属于哪个 patch 家族**、验证过什么、注册成哪个 token、
  以及**已定位的参数字节**）
- 结论：`notes[]`（一行一条、可执行；不留历史）

用法：

```
kontakt_findings()                          # 列所有库
kontakt_findings(library: "CSS")            # 看一个库
kontakt_findings(library: "CSS", merge: '{"notes":["…"]}')   # 写回（先备份 .bak）
```

人读版在工作区 `docs\Kontakt-库档案.md`；**改动优先写成果库**（机器可读），文档按需同步。
