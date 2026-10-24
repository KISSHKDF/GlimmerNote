# 拾光小册（GlimmerNote）

> **完全离线、数据全留在本机的错题本工具。** 不联网、不上传、不收集任何信息。
> 本仓库是**开发区**（唯一代码真源）。运行区另有目录，只装产物，不装源码。

## 它解决什么问题

孩子做完错题后，复习最怕两件事：**错题散在纸质卷上找不到**、**复习没有节奏**。
拾光小册把错题录进来（题干、配图、答案、错因），按间隔重复排复习计划，
并按「孩子的水平」重新组卷打印——全过程在本机完成，家长自己就能维护数据。

## 界面

![今日总览](docs/images/面板-首页-浅色.png)

![组卷工作台](docs/images/组卷-预览.png)

![统计分析](docs/images/统计-深色.png)

> 界面是真的，数据是假的：这三张图由 `scripts\make-doc-shots.mjs` 用**纯合成演示库**渲染
> （学生A / 学生B，合成题），不是手绘示意，也不含任何真实题库内容。

## 三区模型

| 区 | 目录 | 放什么 | 能不能手改 |
|---|---|---|---|
| **开发区** | 本仓库（GlimmerNotedev） | 源码、测试、fixtures、打包脚本 | ✅ 只在这里改 |
| **运行区** | 与仓库同级的 `GlimmerNote\` | `app\`（部署产物）+ `数据\`（真实题库） | ❌ 产物不手改 |
| **冻结区** | 旧版目录（本机只读保留，不出网） | 旧版，只读保留 | ❌ 不再改 |

**口诀：源码只住在 dev；运行区是「装出来的」，不是「写出来的」。**

## 系统要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | **Windows 10 1809+ 或 Windows 11**（64 位） | 桌面壳依赖 WebView2 |
| **WebView2 运行时** | **必须安装**：Evergreen Runtime | 多数 Win11 已内置；Win10 若提示缺组件，装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 即可 |
| 磁盘空间 | **≥ 2 GB** 可用 | 程序约 2 MB（内置 Node 后约 30 MB）；题库含扫描图，按每张 200 KB～1 MB 估算 |
| Node.js | **发行包内已内置** | 最终用户**不需要**安装 Node.js——包里的 `app\node.exe` 就是它。从源码构建或跑门禁才需要装 **≥ 18** |
| 浏览器 | 不需要 | 程序自带桌面壳，不依赖系统浏览器 |

> 程序与数据**物理分离**：`app\` 可以整个删掉重装，`数据\` 不受影响。

## 获取

发行包通过 **GitHub Releases** 提供。本仓**不含**打包产物（`release\` 被 `.gitignore` 挡住），
要从源码自己出包见下文「常用命令」：

- 每个版本一个文件：`GlimmerNote-<版本>-win-x64.zip`（版本形如 `2026.10.24.02`）
- 同目录有 `.sha256` 校验文件，**下载后请先校验再解压**：

```powershell
# 把 <版本> 换成实际版本号
Get-FileHash .\GlimmerNote-<版本>-win-x64.zip -Algorithm SHA256
# 与 .sha256 文件里的那一行逐字比对
Get-Content .\GlimmerNote-<版本>-win-x64.zip.sha256
```

解压后运行 `app\` 目录里的 **`拾光小册.exe`** 即可，**绿色免安装**，无需管理员权限。

> **为什么包有 38 MB**：程序本体只有 0.2 MB，另 38 MB 是**内置的 Node.js**（`app\node.exe`）。
> 本程序的写盘动作（新建学生／组卷／批改／待办办结）由 `app\tools\` 里的 .mjs 工具完成，
> 桌面壳按名字调用 `node.exe`。把它放在程序同目录，程序就能自己找到——**你不用装 Node，也不用联网**。
> 内置版本与 SHA256 见包内 `内置Node说明.txt`，许可见 `node-LICENSE.txt`。
> 想自己检查这一点：任何一个 19 个工具都只用 Node 内置模块，没有 `node_modules`。

## 反馈

- **发现 BUG / 想提需求**：请开 [Issue](../../issues)，按模板填（模板会问版本号、复现步骤、期望结果）。
- 提问前建议先看 [常见问题](#常见问题faq)。
- **安全漏洞请走 [`SECURITY.md`](SECURITY.md) 里的私密渠道，不要公开提 issue。**

## 贡献

单人维护项目，但欢迎 PR。**动手前必读 [`CONTRIBUTING.md`](CONTRIBUTING.md)**，里面有：

- 分支策略（主干开发）
- 提交信息格式（`type(scope): subject`，首行 ≤72 字符）
- **回退三层**：提交错了用 `git revert`，版本有问题用归档件回滚，数据损坏用快照恢复
- 禁止事项（含**禁止 `git reset --hard`**）
- 新功能必须同提交补阴性对照测试

最小自检：

```powershell
node tests\run.mjs quick      # 门禁主体
node tools\lint.mjs           # 语法 / 硬编码路径 / 行尾空白 / 调试残留
```

## 常用命令

```powershell
# 【新克隆 / 换机 第一步】零依赖自检：不需要 exe、不需要真实题库，3 秒
node tests\run.mjs fixture

# 打一个发布包（产出 release\GlimmerNote-<版本>-win-x64.zip + .sha256）
powershell -File scripts\build-release.ps1

# 部署到运行区（只替换 app\，数据\ 全程不碰）
powershell -File scripts\deploy.ps1 -Zip release\GlimmerNote-2026.10.24.02-win-x64.zip

# 看部署历史
powershell -File scripts\rollback.ps1 -List

# 退回上一版（数据不动）
powershell -File scripts\rollback.ps1

# 退回指定版本
powershell -File scripts\rollback.ps1 -Version 2026.10.24.01

# 流水线自检（回滚演练，不动真实运行区）
powershell -File scripts\selftest-pipeline.ps1
```

## 新克隆自检（拿到源码后按这个顺序）

**为什么需要这一节**：本仓的门禁分三档，各需要不同的前置条件。
不知道这件事的人第一次克隆完跑 `quick`，会看到一堆红，然后以为代码坏了。

| 档 | 命令 | 需要什么 | 干净克隆能跑吗 |
|---|---|---|---|
| **零依赖自检** | `node tests\run.mjs fixture` | 只要 Node ≥18 | **能，约 3 秒 exit 0** |
| 全量单元+界面 | `node tests\run.mjs quick` | 已构建的 `src\app\拾光小册.exe` + 真实题库影像 | 不能，要先补齐 |
| 发版前 | `node tests\run.mjs full` | quick + 重编 + 带调试口重启 | 不能，要先补齐 |

**三步补齐**：

```powershell
# 1) 零依赖自检（立刻可跑）
node tests\run.mjs fixture

# 2) 拉三方依赖 + 编桌面壳（产出被 .gitignore 挡住的 exe 与 dll）
powershell -File scripts\fetch-deps.ps1      # 首次需要联网拉 WebView2 包；离线见脚本头注释
powershell -File src\shell\build.ps1

# 3) 指向一个题库（开发机直接跑就用同级 ..\错题本；否则设环境变量）
$env:CTB_TEST_LIB = 'D:\你的题库目录'
node tests\run.mjs quick
```

> 没有题库也能跑一部分：仓库自带合成库 `fixtures\库-最小\`，
> 当检测不到真库时会自动用它（`tests\_测试环境.cjs` 的第三个候选）。
> 合成库只够跑源码级断言，**包含真实影像的门禁（配图门禁 / 原卷台账门禁）会 SKIP 并写明原因**。

## 版本号规则（日期制）

格式：`YYYY.MM.DD.NN`　例：`2026.10.23.01`

- 前四段是**发版日期**（不是代码写成的日期）
- `NN` 是**当天第几版**，两位数，从 `01` 起
- 同一天再发就 `02`、`03`……换天自动重置为 `01`
- 好处：一眼看出新旧、天然有序、不需要维护"主.次.修订"的语义判断
- 不兼容变更（数据格式变化）另在 `CHANGELOG.md` 里用 `⚠ 破坏性变更` 标注，不靠版本号表达

版本号唯一真源：`VERSION.json`。打包脚本会校验格式，不符合 `YYYY.MM.DD.NN` 直接报错。

## 发版检查单

1. 改 `VERSION.json` 的 `version`
2. `CHANGELOG.md` 顶部加条目（含**升级影响**一行）
3. 跑门禁：`node tests\run.mjs quick`（发版前 `full`）+ `node tools\lint.mjs`
4. `powershell -File scripts\build-release.ps1`
5. `powershell -File scripts\deploy.ps1 -Zip <刚出的包>`
6. 自用 1~2 天
7. `git tag -a v<版本> -m "<版本> release point"` + 推 GitHub Release

## 常见问题（FAQ）

**Q：数据存在哪？会上传吗？**
A：全部在运行区的 `数据\` 目录。程序**不联网**，
没有任何上传代码。备份就是复制这个目录。

**Q：升级会不会弄坏我的题库？**
A：不会。部署脚本只替换 `app\`，`数据\` 在脚本层面被排除。
每次发版前后都可以用 `scripts\selftest-pipeline.ps1` 演练一遍（会在临时沙箱里跑，不碰真实数据）。

**Q：怎么彻底卸载？**
A：删掉整个运行区目录即可（程序是绿色免安装，没有注册表残留）。
只想清空数据就删 `数据\` 子目录——**删之前请先备份**。

**Q：升级后发现不好用，怎么退回上一版？**
A：`powershell -File scripts\rollback.ps1`。回滚用的是 `release\` 里的**归档字节**，不是重新构建
（本机构建产物不保证跨机可复现，回滚只能用原样字节）。

**Q：为什么杀毒软件报警？**
A：程序用的是**自签证书**（不是花钱买的正规代码签名证书），所以 Windows 仍会提示"未知发布者"。
这属预期行为；请核对 SHA256 与 Release 页面公布的一致后再放行。

## 铁律

1. **运行区里的东西永远是产物，不是源头。** 谁都不在 `GlimmerNote\app\` 里改代码。
2. **部署只动 `app\`。** `数据\` 由脚本层面保证不触碰。
3. **每次发布必须留三样**：git tag、zip 产物、SHA256。
4. **回滚必须演练过。** 没演练过的回滚等于没有。
5. **dev 里能跑测试，靠 `fixtures\`，不靠真数据。**

## 目录说明

```
GlimmerNotedev\
├─ src\          源码（app 前端 / tools 工具链 / shell 桌面壳）
├─ fixtures\     假数据（测试专用，绝不含真实用户数据）
├─ release\      打包产物（不入 git）
├─ scripts\      build-release / deploy / rollback / fetch-deps / selftest-pipeline
├─ tests\        门禁（run.mjs 是唯一入口）
├─ tools\        lint 等开发工具
├─ docs\         文档 + docs\images\ 界面截图
├─ 归档\          过时物料的去处（不入 git 的除外）
├─ VERSION.json  版本号唯一真源
└─ CHANGELOG.md
```
