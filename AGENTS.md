# AGENTS.md — 给 AI 协作方的最小作业面

> 本文件只写**不可从代码推断**的东西：红线、必须跑的检查、文档该往哪写。
> 其余细节一律给指针，不在此重述——重述就会漂移。用户文档见 `README.md`，开发者细节见 `CONTRIBUTING.md`。

## 身份

拾光小册：完全离线的本地错题本工具。**运行区是产物，不是源头**；真源永远是 `数据\`（用户库）与本仓库 `src\`。

## 设计红线（违反即返工，不接受"下次注意"）

1. **不在运行区 `GlimmerNote\app\` 里改任何文件**。改 `src\`，走 `scripts\build-release.ps1` → `deploy.ps1` → `verify-deploy.mjs`。
2. **部署只动 `app\`**。`数据\` 是用户的，任何脚本都不得写它（导入/补录类工具除外，且必须走 `_安全写.mjs`）。
3. **`answerSlots` 与 `answerMode` 只能由 `src\tools\_作答门禁.mjs` 写入**。手工改索引不算数，门禁会重新数空位对账并报红。
4. **不写死本机路径**（`D:\…`、`C:\Users\…`）。前端由 `src\app\js\host.js` 自推导，脚本用 `$PSScriptRoot`；`tests\portability.cjs` 会拦。
5. **测试不依赖真实用户数据**，一律走 `fixtures\`。
6. **不改写历史**：禁 `git reset --hard`、禁 `push --force` 到 `main`、禁 amend 已打 tag 的提交，回退只 `git revert`。
7. **文件编码与换行按类型分**（判据见 `CONTRIBUTING.md §五`）：
   `*.ps1`/`*.psm1` = **UTF-8 带 BOM + CRLF**（PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解码 ⇒ 中文乱码 + 假语法错）；
   其余文本（`.js/.mjs/.cjs/.json/.md/.html/.css/.yml`）= **UTF-8 无 BOM + LF**。
   **禁止 UTF-16**——它会被 git 当二进制，而 `.gitattributes` 的 `text eol=crlf` 会往 UTF-16 码流里插游离 `0D`，
   导致**新克隆拿到的脚本语法错、而你本机永远看不见**（本轮真实事故，21+10 个解析错）。
   `node tools\lint.mjs` 已有编码/行尾断言，违反会红在提交前。
8. **一份事实只住一个家**：用户用法 → `README.md`；开发者流程 → `CONTRIBUTING.md`；契约规则 → `docs\作答契约.md`；历史 → `CHANGELOG.md`。同一句规则不在两处各写一份。
9. **不写会过期的当前状态**（"目前支持 X 版本""已修复"）。这类内容进 `CHANGELOG.md`，不进正文——它是文档最容易被写坏的一类。

## 每次改完必须跑（少一条就不算完成）

```powershell
powershell -File scripts\install-hooks.ps1   # 只需一次：把钩子路径指向 .githooks（core.hooksPath）
node tools\lint.mjs                 # 语法/编码/行尾/硬编码路径/调试残留
node tests\run.mjs quick            # 门禁主体（约 3 分钟；发版前跑 full）
node tests\portability.cjs          # 有没有写死本机路径
git diff --check                    # 行尾空白/换行污染
```

改了 `CHANGELOG.md`：每个版本条目**必须**有 `**变更分类**：…` 与 `**升级影响**：…` 两行（`tools\lint.mjs` 逐版校验）。

改了作答契约相关（`_作答门禁.mjs` / `_空位.mjs` / `answerSlots` 消费方）**另加**：

```powershell
node tests\neg-answer-slot-contract.cjs   # 两份实现对拍 + 阴性自证（门禁必须真的会红）
```

## 文档

- `README.md` 给用户（三区模型 / 常用命令 / 铁律 / 目录说明），改功能必须同步。
- `CONTRIBUTING.md` 给开发者（分支 / 提交 / 回退 / 禁止事项 / 自检）。
- `CHANGELOG.md` 记历史：**每个用户可见改动加一条**，版本号真源是 `VERSION.json`（日期制 `YYYY.MM.DD.NN`）。
- 断言数量以 `tests\run.mjs` 输出的 `RESULT=… 断言=N` 为准，不许自己数。

## 与用户协作

- 用户说中文，回复用中文；代码、注释、提交信息可用中文但须与既有风格一致。
- **发布、打 tag、推远端、删远端分支前必须先问**；不要替用户做不可逆决定。
- 报错先给根因与证据（文件:行），再给修法；不要只描述现象。
- **发现自己判断错了要当场说明并纠正**，不要悄悄改口——本仓库的历史事故多数来自"静默降级"。
