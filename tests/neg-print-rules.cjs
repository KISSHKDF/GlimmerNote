#!/usr/bin/env node
/**
 * neg-print-rules.cjs —— 打印硬规则（2026-11-12 立，批次 4）
 *
 * 背景：外部调研（exam-zh / wrong-notebook）给了三条打印硬规则。逐条核对本仓现状后：
 *   ① **选项按内容宽度自动 4/2/1 列** —— 本仓缺，本次实现。列数由 **`paper.js` 的 `optsGrid()`
 *      按"最长选项的字数"算**（≤8 字 4 列 / ≤16 字 2 列 / 更长 1 列），CSS 只负责排布。
 *   ② **括号排到行末** —— 本仓**不适用**：那是 LaTeX 两栏排版里括号被挤到下一行的问题，
 *      本仓是单栏 A4 直排、括号本来就在行末。**明知不适用就不照抄**（照抄只会引入新的排版风险）。
 *   ③ **按题型自动留白** —— 本仓**已有**，且比建议更细：`qHtml` 按卡片的 `answerMode` 契约
 *      （figure/none/blank/zone）+ 题型 + 难度决定答题区高度。
 *
 * 本用例做**真实行为验证**：把 `optsGrid` 抽成临时模块跑真函数（不是正则猜源码），外加接线与 CSS 断言。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const PAPER = path.join(E.REPO, 'src', 'app', 'js', 'views', 'paper.js');
const CSS = path.join(E.REPO, 'src', 'app', 'css', 'app.css');
const paper = fs.readFileSync(PAPER, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

/** 按缩进法抽出完整函数（含大括号体）——与 tests\neg-stem-readability.cjs 同法 */
function member(src, sig, indent) {
  const lines = src.split('\n');
  const i = lines.findIndex(l => l.includes(sig));
  if (i < 0) return null;
  const close = new RegExp('^' + indent + '\\}');
  let j = i + 1;
  while (j < lines.length && !close.test(lines[j])) j++;
  return lines.slice(i, j + 1).join('\n');
}

const fn = member(paper, 'function optsGrid(html) {', '  ');
A('从真源码抽到 optsGrid', !!fn, fn ? fn.split('\n')[0].trim() : '抽不到（签名变了？）');

console.log('测试环境：' + E.describe());

(async () => {
  if (!fn) { console.log(`\n[neg-print-rules] 断言=${passed} 失败=${worst + 1}`); process.exit(1); }
  const tmp = path.join(E.allocTempDir('gn-optsgrid-'), 'm.mjs');
  fs.writeFileSync(tmp, fn + '\nexport { optsGrid };\n', 'utf8');
  const M = await import(pathToFileURL(tmp).href);

  const seg = items => '<p class="stem-lead">选出正确答案（　）</p><p class="stem-q">' + items.join(' ') + '</p>';

  console.log('\n══ ① 列数：按最长选项的字数（真实跑函数）══');
  {
    const short4 = seg(['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁']);
    const mid4 = seg(['A. 甲的选项文字', 'B. 乙的选项文字', 'C. 丙的选项文字', 'D. 丁的选项文字']);
    const long4 = seg(['A. 这是一个相当长的选项文字描述内容超过十六个字了吧', 'B. 第二个同样很长的选项文字内容也超过十六个字',
      'C. 第三个依然很长的选项文字内容同样超过十六个字', 'D. 第四个还是很长的选项文字内容也超过十六个字']);
    const r1 = M.optsGrid(short4), r2 = M.optsGrid(mid4), r3 = M.optsGrid(long4);
    A('★ 短选项（≤8 字）⇒ 4 列', /class="stem-opts cols-4"/.test(r1), (r1.match(/class="stem-opts[^"]*"/) || [''])[0]);
    A('★ 中等选项（≤16 字）⇒ 2 列', /class="stem-opts cols-2"/.test(r2), (r2.match(/class="stem-opts[^"]*"/) || [''])[0]);
    A('★ 长选项（>16 字）⇒ 1 列', /class="stem-opts cols-1"/.test(r3), (r3.match(/class="stem-opts[^"]*"/) || [''])[0]);
    A('每个选项都被包成独立 span（不再是空格分隔的一整段）',
      (r1.match(/<span class="opt">/g) || []).length === 4, (r1.match(/<span class="opt">/g) || []).length + ' 个');
  }

  console.log('\n══ ② 识别不确定就不动（宁可不变，不许排错）══');
  {
    const three = seg(['A. 甲', 'B. 乙', 'C. 丙']);
    const r = M.optsGrid(three);
    A('★ 只识别到 3 个选项 ⇒ 原样返回（不硬塞成网格）', !/stem-opts/.test(r), r.slice(0, 60));
    const noOpts = '<p class="stem-lead">请画出力的示意图。</p>';
    A('★ 题面里根本没有选项段 ⇒ 原样返回', M.optsGrid(noOpts) === noOpts, '');
    const plain = seg(['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁']);
    A('★ 未被改动的部分（题面段）保留', /stem-lead/.test(M.optsGrid(plain)), '');
  }

  console.log('\n══ ③ 长度按"剥掉标签后"的字数算（别被 <i>/<sub> 带偏）══');
  {
    const tagged = seg(['A. <i>x</i>', 'B. <i>y</i>', 'C. <i>z</i>', 'D. <i>w</i>']);
    const r = M.optsGrid(tagged);
    A('★ 选项只含短标签 ⇒ 仍按短选项处理（4 列）', /cols-4/.test(r), (r.match(/class="stem-opts[^"]*"/) || [''])[0]);
    A('标签被原样保留（不做净化，题干已在别处净化过）', /<i>x<\/i>/.test(r), '');
  }

  console.log('\n══ ④ 接线：只在"印刷版题干"这条路上用 ══');
  A('★ 印刷版题干走 optsGrid（`form===\'img\'` 的整页图那条**不**走——整页图本来就不分列）',
    /else stem = '<div class="q-stem">' \+ optsGrid\(/.test(paper), '');
  A('暴露成 V.optsGrid 供 e2e/单测直接断言（与 V.printUnit 同惯例）', /V\.optsGrid = optsGrid;/.test(paper), '');

  console.log('\n══ ⑤ CSS 三种列 + 打印不许拆行 ══');
  A('cols-4 / cols-2 / cols-1 三条规则都在', /\.stem-opts\.cols-4\{/.test(css) && /\.stem-opts\.cols-2\{/.test(css) && /\.stem-opts\.cols-1\{/.test(css), '');
  A('★ 打印时 `break-inside:avoid`（四选项被拆到两页会让孩子以为只有两个选项）',
    /@media print\{\.stem-opts\{break-inside:avoid/.test(css), '');

  console.log('\n══ ⑥ 第 ③ 条硬规则（按题型留白）本仓已有 ══');
  A('★ 答题区按 `answerMode` 契约决定（figure/none 不留、blank 就坑写、zone 按题型）',
    /mode === 'figure' \|\| mode === 'none'/.test(paper) && /mode === 'blank'/.test(paper), '');
  A('★ 且按题型与难度分档（计算/解答/其他各不同）',
    /计算/.test(paper) && /解答\|应用\|压轴\|证明\|简答/.test(paper) && /c\.difficulty === '难'/.test(paper), '');

  console.log('\n══ ⑦ 阴性自证：把列数算成恒定 4 列 ⇒ ① 必须红 ══');
  {
    const broken = fn.replace(/const cols = maxLen <= 8 \? 4 : \(maxLen <= 16 \? 2 : 1\);/,
      'const cols = 4;');
    A('变异点命中', broken !== fn, '');
    const tmp2 = path.join(E.allocTempDir('gn-optsgrid-mut-'), 'm.mjs');
    fs.writeFileSync(tmp2, broken + '\nexport { optsGrid };\n', 'utf8');
    const M2 = await import(pathToFileURL(tmp2).href);
    const long4 = seg(['A. 这是一个相当长的选项文字描述内容超过十六个字了吧', 'B. 第二个同样很长的选项文字内容也超过十六个字',
      'C. 第三个依然很长的选项文字内容同样超过十六个字', 'D. 第四个还是很长的选项文字内容也超过十六个字']);
    A('★ 掏成恒定 4 列后，长选项不再得到 cols-1（这条判据确实有牙齿）',
      !/cols-1/.test(M2.optsGrid(long4)), (M2.optsGrid(long4).match(/class="stem-opts[^"]*"/) || [''])[0]);
  }

  console.log(`\n[neg-print-rules] 断言=${passed} 失败=${worst}`);
  process.exit(worst ? 1 : 0);
})().catch(e => { console.error('用例自身异常：' + (e && e.stack || e)); process.exit(1); });
