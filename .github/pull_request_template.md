# 拉取请求（PR）

## 这个 PR 做了什么

<!-- 一两句话说清，不要写"若干优化" -->

## 关联

- 关联 issue：<!-- #123 或"无" -->
- 影响的版本号：<!-- 是否要改 VERSION.json？改成了什么？ -->

## 自检清单（逐项打勾，**不打勾不要提 PR**）

- [ ] 首次克隆后已跑 `powershell -File scripts\install-hooks.ps1`（否则本地门禁钩子根本没挂上）
- [ ] `node tools\lint.mjs` 通过（语法 / 编码 / 行尾 / 硬编码路径 / 调试残留 / CHANGELOG 逐版字段）
- [ ] `node tests\run.mjs quick` 通过
- [ ] 若是发版前：`node tests\run.mjs full` 通过
- [ ] `node tests\portability.cjs` 通过（没有写死本机绝对路径）
- [ ] 新增/修改功能**同一次提交**里补了阴性对照测试，并在 `tests\run.mjs` 登记
- [ ] 没提交构建产物、日志、截图、用户真实数据
- [ ] 新增/改动的 `.ps1` 是 **UTF-8 带 BOM + CRLF**（**不是 UTF-16**——那会被 git 当二进制，
      新克隆时被检出环节插坏成语法错；见 `CONTRIBUTING.md §五`）
- [ ] `CHANGELOG.md` 已加条目，且该条目含 `**变更分类**：…` 与 `**升级影响**：…` 两行
- [ ] 改了 `VERSION.json` 的话，`CHANGELOG.md` 顶部条目与之一致

## 破坏性变更

- [ ] 本 PR **含**破坏性变更（数据格式变化 / 行为不兼容）
      → 必须在 `CHANGELOG.md` 该版本下写 `⚠ 破坏性变更` 并说明**升级影响**
- [ ] 本 PR **不含**破坏性变更

## 回退方式

<!-- 如果这个 PR 上线后出问题，怎么退？用 git revert 还是要回滚产物？ -->
