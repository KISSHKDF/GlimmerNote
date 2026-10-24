# 贡献指南（CONTRIBUTING）

> 本仓库单人维护，但这套规则是**给自己下次回来时看的**——也是 onboarding 任何人的唯一入口。

## 一、分支策略

- **主干开发**（trunk-based）：只有 `main` 一条长期分支，每次提交都直接进 `main`。
- 不建长期 `develop` / `release` 分支。改动大时开短命分支（≤3 天），合完即删。
- 理由：单人维护 + 日发版节奏，多分支只会让"哪个是线上版本"变成需要推理的问题。
  版本由 `VERSION.json` 与 git tag 表达，不由分支表达。
- `main` 上任何时刻都必须能通过 `node tests\run.mjs quick`。

## 二、提交信息

格式：`<type>(<scope>): <subject>`

- `type`：`feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `perf` / `style` / `ci` / `build`
- `scope`：模块名，如 `shell` / `server` / `panel` / `release`
- **subject 首行 ≤ 72 字符**，中文按字符数算
- 破坏性变更在 type 后加 `!`，并在正文写 `BREAKING CHANGE:` 说明

示例：

```
fix(server): 同前缀兄弟目录不再被误判为库内路径

BREAKING CHANGE: _服务端.mjs 的 ROOT 结尾现在必须带分隔符
```

## 三、提交错了怎么办（回退三层，**不要混用**）

| 场景 | 用什么 | 绝不用什么 |
|---|---|---|
| ① **提交写错了**（刚提交，还没发布） | `git revert <sha>` 生成一个反向提交 | ❌ 不用 `git commit --amend` 改历史，❌ 不用 `git reset --hard` |
| ② **版本有问题**（已发布，要回退线上） | `scripts\rollback.ps1`，从 `release\` 的归档件重装 | ❌ **绝不重新构建一个"看起来一样"的包**——本机构建产物字节不可复现，回退只能是归档字节 |
| ③ **数据损坏** | 从 `_backup-*/` 快照恢复，恢复后必须比对数据目录哈希 | ❌ 不手工拼接文件 |

### 关于 `git revert` 的用法

```powershell
# 看最近提交，拿到要撤销的那个 sha
git log --oneline -10

# 生成一个"反向提交"，历史完整保留，可以再 revert 回来
git revert <sha>

# 撤销一次 merge
git revert -m 1 <merge-sha>

# revert 后如果冲突：解决冲突，git add，然后 git revert --continue
```

**为什么必须用 revert 而不是改历史：** 已经发布出去的版本对应一个 tag。
如果 `reset` 掉再重写提交，同一个 tag 会指向不同的树，归档件与源码的对应关系就断了。
2026-10-23 真实发生过一次 `git reset --hard` 把自研改动打回历史点的事件，
导致当天的产物无法追溯到任何一份源码——这就是下面这条铁律的由来。

## 四、禁止事项（铁律）

1. ❌ **禁止 `git reset --hard`**、禁止 `git push --force` 到 `main`、禁止 `git commit --amend`
   修改已经打过 tag 的提交。要撤销就用 `git revert`。
2. ❌ **禁止把构建产物、日志、截图、用户数据提交进仓库**（`.gitignore` 已挡，不要用 `-f` 绕过）。
3. ❌ **禁止在 `release\` 之外重新构建来"回退"**——回退只能用归档件。
4. ❌ **禁止在源码里写死本机绝对路径**（`D:\...` / `C:\Users\...`）。
   本机路径由 `src\app\js\host.js` 自推导；脚本用 `$PSScriptRoot`。
   `tests\portability.cjs` 会拦住这条。
5. ❌ **禁止让测试依赖真实用户数据**。测试数据一律走 `fixtures\`。

## 五、编码与换行的硬规矩（违反会直接打断运行）

| 文件类型 | 要求 | 为什么 |
|---|---|---|
| **`.ps1` / `.psm1`** | **UTF-8 带 BOM**，CRLF 换行 | Windows PowerShell 5.1 读**无 BOM** 的 UTF-8 会按 **GBK** 解码：中文注释变成乱码，`'`/`"` 的配对被打断，脚本直接语法报错。本项目所有 `.ps1` 都是带 BOM 的（7/7 实测），新增的必须一致 |
| `.psm1` 之外的 `*.go / *.js / *.mjs / *.cjs / *.json / *.md` | UTF-8 **无 BOM**，LF 换行 | 这些由 Go/Node 读，无 BOM 更干净；BOM 会被某些解析器当成内容 |
| `*.bat / *.cmd` | CRLF | cmd.exe 对 LF 支持不稳定 |

**自查**（PowerShell）：

```powershell
# 前 3 字节是 239,187,191 就是有 BOM
[System.IO.File]::ReadAllBytes('scripts\你的脚本.ps1')[0..2] -join ','
```

**这条规矩是 2026-10-24 踩了两次才写下的**：新建 `tools\lint.mjs` 与 `scripts\setup-remote.ps1`
时都忘了加 BOM，前者导致我的复测脚本把中文判据全读成乱码、结果整片回退，
后者导致 `ParseFile` 报三个假语法错。两次都是"看起来像代码写错了，其实是编码"。

## 六、提交前自检

```powershell
# 1) 快测（门禁主体，1 分钟内）
node tests\run.mjs quick

# 2) 全量门禁（发版前必跑）
node tests\run.mjs full

# 3) 可移植性（有没有写死本机路径）
node tests\portability.cjs
```

三条任一失败就不许提交。

## 七、新功能必须补测试

新增功能或修 BUG 时，**同一次提交里**必须包含：

- 一个能复现问题的**阴性对照**（`tests\neg-*.cjs` / `neg-*.mjs`），
  未修复时必须 FAIL、修复后必须 PASS；
- 在 `tests\run.mjs` 里登记该测试文件名（否则算游离测试）。

只改代码不补测试的提交，视为未完成。
