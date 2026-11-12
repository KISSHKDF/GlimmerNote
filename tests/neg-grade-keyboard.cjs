#!/usr/bin/env node
/**
 * neg-grade-keyboard.cjs —— 批改回录必须能**不靠鼠标**做完（2026-11-12 立，批次 3 / UX-14）
 *
 * 事故形态（改前）：`paper.js` 的批改抽屉是"一题一行 + 对/半对/错三个按钮"，
 * 30 题就是 **30 次点选**；没有键盘通道，也没有批量入口（审计 UX-14，P1）。
 * 家长在电脑前对着纸质卷判 30 题时，手在纸和鼠标之间来回换。
 *
 * 本用例守五件事（零依赖：只读本仓源码）：
 *   ① 有键盘通道：↑↓ 选题、1/2/3 判「对/半对/错」并自动跳下一行、Ctrl+Enter 提交；
 *   ② **点选与键盘共用同一个入口** `pick()`（两条路各写一份必然漂，本仓 L-286 族）；
 *   ③ **输入框守卫**：焦点在备注框里打字时，1/2/3 不许被判分吞掉；
 *   ④ 有批量入口且**带二次确认**（"剩余全判对"会写进复习排程，判多了要整批重判）；另有"清空本次"；
 *   ⑤ 当前行**可见**（CSS `.lg-gline.cur`）—— 没有可见焦点时键盘判分等于盲操作。
 * 另含阴性自证：把共用入口拆成两份 ⇒ ② 必须红。
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

const paper = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
const css = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'css', 'app.css'), 'utf8');

console.log('测试环境：' + E.describe());

console.log('\n══ ① 键盘通道 ══');
A('★ 绑定了 keydown（且是**可自行解绑**的具名函数）',
  /const keyFn = e => \{/.test(paper) && /document\.addEventListener\('keydown', keyFn\)/.test(paper), '');
A('★ ↑↓ 移动当前行', /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/.test(paper), '');
A('★ 1/2/3 → 对/半对/错', /const KEY2V = \{ 1: '对', 2: '半对', 3: '错' \}/.test(paper), '');
A('★ 判完自动跳下一行（否则每题还要按 ↓）', /pick\(rows\[curI\], KEY2V\[e\.key\]\); setCur\(curI \+ 1\)/.test(paper), '');
A('★ Ctrl/Cmd+Enter 提交', /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/.test(paper), '');
A('抽屉关掉后自行解绑（shell 的 closeDrawer 不会通知这里）',
  /if \(!document\.body\.contains\(d\)\) \{ document\.removeEventListener\('keydown', keyFn\); return; \}/.test(paper), '');
A('键盘提示写在界面上（藏起来的快捷键等于没有）',
  /class="small muted lg-keys"/.test(paper) && /Ctrl\+Enter/.test(paper), '');

console.log('\n══ ② 点选与键盘共用同一个入口 ══');
A('★ 有唯一的 `pick(row, v)`', /const pick = \(row, v\) => \{/.test(paper), '');
A('★ 点选走 `pick(...)`（不是自己再写一份赋值）',
  /btn\.onclick = \(\) => pick\(btn\.closest\('\.lg-gline'\), btn\.dataset\.v\)/.test(paper), '');
A('★ 键盘也走 `pick(...)`', /pick\(rows\[curI\], KEY2V\[e\.key\]\)/.test(paper), '');

console.log('\n══ ③ 输入框守卫 ══');
A('★ 焦点在 INPUT/TEXTAREA/SELECT 时直接返回（备注框里打字不会被判分吞掉）',
  /if \(tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT'\) return;/.test(paper), '');

console.log('\n══ ④ 批量入口 + 二次确认 ══');
A('★ 「剩余全判对」按钮存在', /id="lgAllYes"/.test(paper), '');
A('★ 且**必须**过 S.confirm（判分会写进复习排程，判多了要整批重判）',
  /await S\.confirm\(\{[\s\S]{0,240}全判对/.test(paper), '');
A('★ 只在"确实都对"的语义下提示（按钮 title 与确认文案都讲明代价）',
  /只在确实都对时用/.test(paper) && /判多了要整批重判/.test(paper), '');
A('「清空本次」按钮存在（点错了能撤，不用重开抽屉）', /id="lgClear"/.test(paper), '');
A('清空只撤**本次点选**，不碰已入库结果（文案讲明）',
  /已入库的结果不受影响/.test(paper), '');

console.log('\n══ ⑤ 当前行可见 ══');
A('★ CSS 有 `.lg-gline.cur`（键盘判分必须有可见焦点）', /\.lg-gline\.cur\s*\{/.test(css), '');
A('JS 会挂/摘这个 class', /rows\.forEach\(\(r, k\) => r\.classList\.toggle\('cur', k === curI\)\)/.test(paper), '');

console.log('\n══ ⑥ 阴性自证：拆掉共用入口 ⇒ ② 必须红 ══');
{
  const broken = paper.replace(/btn\.onclick = \(\) => pick\(btn\.closest\('\.lg-gline'\), btn\.dataset\.v\)/,
    "btn.onclick = () => { /* 各写一份 */ btn.classList.add('on'); };");
  A('变异点命中', broken !== paper, '');
  A('★ 拆掉后确实能被 ② 的判据抓到',
    !/btn\.onclick = \(\) => pick\(btn\.closest\('\.lg-gline'\), btn\.dataset\.v\)/.test(broken), '');
}

console.log(`\n[neg-grade-keyboard] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
