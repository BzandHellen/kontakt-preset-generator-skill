# data/ —— 索引数据

这里的东西**都是从本机已安装（有授权）的音色库提取出来的**，可随时重建，不进 git。

| 文件 | 谁写的 | 怎么重建 |
|---|---|---|
| `kontakt-patches.csv` | `scripts/db-build.mjs` | `kontakt_db_build`，或 `node scripts/db-build.mjs` |

列：`Library, Token, RelDir, PatchFile, Ext, Size, MTime, Path`。

扫描根是你本机的目录结构，所以这份 CSV 换机器就不适用 —— 重建即可（本机 1.6 万个文件约 3 秒）。
