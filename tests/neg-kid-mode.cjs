#!/usr/bin/env node
/**
 * neg-kid-mode.cjs —— 「孩子模式」必须真的挡住家长向信息（2026-11-12 立，批次 3 / UX-11）
 *
 * 事故形态（改前）：做题屏混着**家长向**信息 —— 错因码 K/L/S、入册天数、批次号、难度标签、
 * 工具名，以及「下次≈N 天后」这种排程承诺。孩子看这些既看不懂，又会被"还有几天"带偏；
 * 而家长恰恰需要它们。审计结论是「**没有"给孩子的界面"**」。
 *
 * 本用例守四件事（零依赖：只读本仓源码）：
 *   ① 开关是**一个**：家长向元素一律带 class `adm`，隐藏只由 CSS 的
 *      `body[data-kid="1"] .adm{display:none}` **一处**完成 —— 防止以后新增元素"忘了加判断"；
 *   ② 开关**记得住**：`S.mount` 必须按上次选择恢复（否则重开程序就退回家长视图）；
 *   ③ 做题屏上那几处家长向信号**都**在 `adm` 覆盖范围内（逐条点名）；
 *   ④ 阴性自证：把 CSS 的 `display:none` 改成 `display:block` ⇒ ① 必须红。
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

const shell = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'shell.js'), 'utf8');
const review = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'review.js'), 'utf8');
const css = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'css', 'app.css'), 'utf8');

console.log('测试环境：' + E.describe());

console.log('\n══ ① 隐藏只有一个收口 ══');
{
  const rule = /body\[data-kid="1"\]\s*\.adm\s*\{\s*display:\s*none\s*!important\s*\}/.exec(css);
  A('★ CSS 里有 `body[data-kid="1"] .adm{display:none !important}`（唯一收口）', !!rule, rule ? rule[0] : '找不到');
  A('孩子模式下没有把隐藏散写在行内 style（`style="display:none"` 0 处）',
    !/style="display:\s*none"/.test(review), '');
}

console.log('\n══ ② 开关记得住 ══');
A('shell.js 定义了 S.kidMode / S.applyKidMode / S.toggleKidMode',
  /S\.kidMode\s*=/.test(shell) && /S\.applyKidMode\s*=/.test(shell) && /S\.toggleKidMode\s*=/.test(shell), '');
A('applyKidMode 设的是 `document.body.dataset.kid`（CSS 选择器与它对得上）',
  /document\.body\.dataset\.kid\s*=/.test(shell), '');
A('★ S.mount 里按上次选择恢复（否则重开程序退回家长视图）',
  /S\.applyKidMode\(S\.kidMode\(\)\)/.test(shell), '');
A('状态存 localStorage（不落库、不写索引）',
  /U\.lsSet\('gn\.kidMode'/.test(shell) && !/writeFile|_安全写/.test(shell.slice(shell.indexOf('S.kidMode'), shell.indexOf('S.kidMode') + 600)), '');

console.log('\n══ ③ 做题屏的家长向信号都在 adm 覆盖内 ══');
{
  const cases = [
    ['meta 行（学生·学科 / 卡号 / 难度 / 错因码 / 重做次数 / 入册天数）', /class="rv-meta adm"/],
    ['对·半对·错 计数', /<span class="adm">' \+ ztag\('ok'/],
    ['错因码（causeLayer + causeCode）', /class="adm ' \+ layerCls\(c\.causeLayer\)/],
    ['「错因未经孩子口述确认」提示', /cause-warn adm"/],
  ];
  for (const [what, re] of cases) A(`  ${what}`, re.test(review), '');
  A('★ 孩子模式下判分按钮不再承诺「下次≈N 天」（排程承诺是家长向信息）',
    /S\.kidMode\(\)/.test(review) && /M\.session && M\.session\.quick \|\| S\.kidMode\(\)/.test(review), '');
  A('开关按钮存在并绑定了 toggleKidMode',
    /id="rvKid"/.test(review) && /kidBtn\.onclick\s*=\s*\(\)\s*=>\s*S\.toggleKidMode\(\)/.test(review), '');
  A('开关按钮绑定时**判空**（本文件老教训：$id 取不到就是 null）',
    /const kidBtn = U\.\$id\('rvKid'\); if \(kidBtn\)/.test(review), '');
}

console.log('\n══ ④ 阴性自证：掏掉隐藏 ⇒ ① 必须红 ══');
{
  const mutated = css.replace(/body\[data-kid="1"\]\s*\.adm\s*\{\s*display:\s*none\s*!important\s*\}/,
    'body[data-kid="1"] .adm { display: block !important }');
  A('变异点命中', mutated !== css, '');
  A('★ 掏掉后确实能被 ① 的判据抓到',
    !/body\[data-kid="1"\]\s*\.adm\s*\{\s*display:\s*none\s*!important\s*\}/.test(mutated), '');
}

console.log(`\n[neg-kid-mode] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
