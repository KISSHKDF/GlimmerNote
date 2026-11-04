# family-b / periodic-symbols

**一句话**：写化学式之前，先把题给的条件（化合价、原子团、相对原子质量）列成一张小表；区域只圈卷面事实。

## 这是什么

跨学科复用同一条方法的一次**学科扩展**示例：方法本体是「整页只登记错的小问，区域要带全它的解题条件」
（见 `family-a/shared-stem`），这里把它落到**化学**这一科：条件分散且多小题共用时，先列一张条件小表。

## 装 / 停 / 退

```powershell
# 装（手动复制目录即可；默认根 = %LOCALAPPDATA%\拾光小册\经验包）
Copy-Item -Recurse "src\packs\family-b" "$env:LOCALAPPDATA\拾光小册\经验包\"
# 选卡（配方组装时带上）
node src\tools\_配方.mjs 组装 --recipe ingest-page --card family-b/periodic-symbols/periodic-symbols@1.0.0 ...
# 停用（不删内容，只停用）
New-Item "$env:LOCALAPPDATA\拾光小册\经验包\family-b\periodic-symbols\1.0.0\.停用"
# 回退：把 1.0.0 换成上一版目录名即可（本包目前只有 1.0.0）
```

## 扩展声明（`pack.json` 的 `extensions[]`）

| 字段 | 内容 |
|---|---|
| 学科 | 化学 |
| 适用条件 | 题面条件**分散**给出**且**对多个小题必需时才用；条件只服务一个小题、或已集中在题首时不要用 |
| 反例 | ①把「公共条件」表圈进「错误位置」（误伤对照）②条件在未提供的下一页 ③小题自带条件仍追加「公共条件」区域 —— 三条都能在 `cases/periodic-symbols` 的 `expected.json → controls[]` 里查到并按它复核 |
| 维护者 | 拾光小册维护者（问题请开 Issue，口径见 `CONTRIBUTING.md §八「经验贡献与复核」`） |

> 「能发现误伤的反例」是**门禁判据**，不是形容词：`_经验包.mjs 校验` 会去案例的 `controls[]` 里核对这三条，
> 查不到就判红（见 `docs\经验包规范.md` 的「学科扩展的声明与门禁」一节）。

## 许可

CC-BY-4.0（与 `family-a` 同口径）。案例素材为**合成**内容，不含任何真实学生信息。
