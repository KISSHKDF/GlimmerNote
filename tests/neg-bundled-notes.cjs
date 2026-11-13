#!/usr/bin/env node
/**
 * neg-bundled-notes.cjs —— 包内说明书（`怎么试用.txt`）必须讲清两件最容易卡住用户的事（2026-11-12 立，批次 3）
 *
 * 背景（审计批次 3）：这份 txt 随包走（`build-release.ps1` 拷到包根、`deploy.ps1` 更新到运行区根），
 * 是**发行包里唯一的用户文档**（包里没有 `docs\`）。它缺两件事：
 *   ① **程序自己不带 AI** —— 很多用户以为"程序会帮我看照片"，卡在这一步；
 *   ② 日志落点只写了第 ① 个，而壳是**三级降级**（写不进 %LOCALAPPDATA% 时还有两个退路）。
 *
 * 本用例守四件事（零依赖：只读本仓文件）：
 *   ① 文件在（打包脚本缺它会直接 throw）且提到"不带 AI / 你自己的 AI"；
 *   ② 日志的三级落点**都在**，且**与壳源码逐条对拍**（`CTBShellV2.cs` 里那三个路径字面量）——
 *      这样改壳的落点而忘改说明书会被当场抓住（本仓 L-286 族：同一事实两处实现必然漂）。
 *   ③ 说明书里不出现 `docs\`（发行包没有它，指路就是死链）；
 *   ④ 阴性自证：把"不带 AI"那句挖掉 ⇒ ① 必须红。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const TXT = path.join(E.REPO, '怎么试用.txt');
const CS = path.join(E.REPO, 'src', 'shell', 'CTBShellV2.cs');
const buildPs1 = fs.readFileSync(path.join(E.REPO, 'scripts', 'build-release.ps1'), 'utf8');

console.log('测试环境：' + E.describe());

console.log('\n══ ① 文件在场 + 讲清"要你自己的 AI" ══');
A('`怎么试用.txt` 在仓库根（打包脚本缺它会 throw）', fs.existsSync(TXT), '');
A('打包脚本确实会把它放进包（并有缺件断言）',
  /怎么试用\.txt/.test(buildPs1) && /缺 怎么试用\.txt/.test(buildPs1), '');
const txt = fs.readFileSync(TXT, 'utf8');
A('★ 明说**程序自己不带 AI**', /自己不带\s*AI/.test(txt), '');
A('★ 明说要用**你自己的 AI** 执行任务单', /你自己的\s*AI/.test(txt), '');
A('★ 明说"没有 AI 也照样用"（免得用户以为这软件没 AI 就没用）', /没有\s*AI\s*也照样用/.test(txt), '');

console.log('\n══ ② 日志三级落点：说明书 ↔ 壳源码 对拍 ══');
{
  const cs = fs.readFileSync(CS, 'utf8');
  /* 壳的三个落点（唯一实现 LogPath / LogTarget） */
  const shellTargets = [
    ['① %LOCALAPPDATA%\\拾光小册\\shell.log', /Path\.Combine\(UserDataDir,\s*"shell\.log"\)/],
    ['② app\\shell.log', /Path\.Combine\(AppRoot,\s*"shell\.log"\)/],
    ['③ %TEMP%\\拾光小册-shell.log', /Path\.Combine\(Path\.GetTempPath\(\),\s*"拾光小册-shell\.log"\)/],
  ];
  A('壳源码里三个日志落点都在（判据没抽空）', shellTargets.every(([, re]) => re.test(cs)),
    shellTargets.filter(([, re]) => re.test(cs)).length + '/3');
  const docTargets = [
    ['① %LOCALAPPDATA%\\拾光小册\\shell.log', /%LOCALAPPDATA%\\拾光小册\\shell\.log/],
    ['② app\\shell.log', /app\\shell\.log/],
    ['③ %TEMP%\\拾光小册-shell.log', /%TEMP%\\拾光小册-shell\.log/],
  ];
  for (let i = 0; i < 3; i++) {
    A(`★ 说明书里有 ${docTargets[i][0]}（与壳第 ${i + 1} 个落点对应）`, docTargets[i][1].test(txt), '');
  }
  A('★ 说明书提示"按顺序找"（用户不知道该看哪一个）', /按顺序找/.test(txt), '');
}

console.log('\n══ ③ 不指路到包里没有的东西 ══');
A('说明书里不出现 `docs\\`（发行包不含 docs\\）', !/docs\\/.test(txt), '');

console.log('\n══ ④ 阴性自证：挖掉"不带 AI" ⇒ ① 必须红 ══');
{
  const mutated = txt.replace(/自己不带\s*AI/, '（已删）');
  A('变异点命中', mutated !== txt, '');
  A('★ 挖掉后确实能被 ① 的判据抓到', !/自己不带\s*AI/.test(mutated), '');
}

console.log(`\n[neg-bundled-notes] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
