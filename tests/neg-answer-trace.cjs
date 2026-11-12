#!/usr/bin/env node
/**
 * neg-answer-trace.cjs —— 答案册要写出「错在哪一步」（2026-11-13 立，批次 4）
 *
 * 事故形态（改前）：复习屏判分时会问一句"转折点：我想到哪一步、在哪拐错？"，答案存进
 * `reviews[].note`；复习屏也以"✎ 转折点"图标悬停可见，落库时还会拼进批改备注。
 * **但家长手里那份答案册上一个字都没有** —— 而家长批改时要看的恰恰不是"错了"（卷面有红叉），
 * 而是"孩子当时是怎么想错的"。
 *
 * 本用例**真跑** `traceLines()`（把函数抽成临时模块，注入一个会转义的 `U`），守：
 *   ① 没有转折点 ⇒ 不产生空块；
 *   ② 有 ⇒ 带日期显示；
 *   ③ **只显示最近 2 次**（旧记录常已被后来的理解推翻，全量列出来会误导家长），并写明总次数；
 *   ④ note 里的 HTML **必须被转义**（这是要打进打印页的字符串）；
 *   ⑤ 超长截断（答案册一页要塞下多题）。
 * 另守接线（`ansHtml` 里在"当时错答/错因"之后调用）与 CSS（打印不许拆页）、阴性自证。
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

function member(src, sig, indent) {
  const lines = src.split('\n');
  const i = lines.findIndex(l => l.includes(sig));
  if (i < 0) return null;
  const close = new RegExp('^' + indent + '\\}');
  let j = i + 1;
  while (j < lines.length && !close.test(lines[j])) j++;
  return lines.slice(i, j + 1).join('\n');
}
const fn = member(paper, 'function traceLines(c) {', '  ');
console.log('测试环境：' + E.describe());

(async () => {
  A('从真源码抽到 traceLines', !!fn, fn ? fn.split('\n')[0].trim() : '抽不到（签名变了？）');
  if (!fn) { console.log(`\n[neg-answer-trace] 断言=${passed} 失败=${worst + 1}`); process.exit(1); }

  const HARNESS = 'const U = { esc: s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;" }[c])) };\n';
  const load = async (body, tag) => {
    const p = path.join(E.allocTempDir('gn-trace-' + tag + '-'), 'm.mjs');
    fs.writeFileSync(p, HARNESS + body + '\nexport { traceLines };\n', 'utf8');
    return import(pathToFileURL(p).href);
  };
  const M = await load(fn, 'real');

  console.log('\n══ ① 没有转折点 ⇒ 不产生空块 ══');
  A('无 reviews ⇒ 空串', M.traceLines({}) === '' && M.traceLines({ reviews: [] }) === '', '');
  A('有 reviews 但都没 note ⇒ 空串（不打印一个空标题）',
    M.traceLines({ reviews: [{ date: '2026-11-01', result: '对' }] }) === '', '');

  console.log('\n══ ② 有 ⇒ 带日期显示 ══');
  {
    const html = M.traceLines({ reviews: [{ date: '2026-11-10', result: '错', note: '想到用面积公式，但没注意单位换算' }] });
    A('★ 含标题「错在哪一步」', /错在哪一步/.test(html), '');
    A('★ 含日期', /2026-11-10/.test(html), '');
    A('★ 含原话', /没注意单位换算/.test(html), '');
    A('缺日期时写「未记日期」（不许留个空括号）',
      /未记日期/.test(M.traceLines({ reviews: [{ note: '忘了约分' }] })), '');
  }

  console.log('\n══ ③ 只显示最近 2 次 + 写明总次数 ══');
  {
    const card = { reviews: [
      { date: '2026-11-01', note: '第一次的旧想法' },
      { date: '2026-11-05', note: '第二次的想法' },
      { date: '2026-11-10', note: '最近的想法' },
    ] };
    const html = M.traceLines(card);
    A('★ 含最近 2 条', /第二次的想法/.test(html) && /最近的想法/.test(html), '');
    A('★ **不含**最早那条（旧理解常已被推翻，列出来会误导家长）', !/第一次的旧想法/.test(html), '');
    A('★ 写明总次数与显示条数', /共 3 次记录/.test(html) && /只显示最近 2 次/.test(html),
      (html.match(/（共[^）]*）/) || [''])[0]);
    A('只有 2 条时不写"共 N 次"那句（避免噪音）',
      !/共 2 次/.test(M.traceLines({ reviews: card.reviews.slice(1) })), '');
  }

  console.log('\n══ ④ note 里的 HTML 必须被转义 ══');
  {
    const html = M.traceLines({ reviews: [{ date: '2026-11-10', note: '<script>alert(1)</script> 我当时以为…' }] });
    A('★ `<script>` 不落地（这是要打进打印页的字符串）', !/<script>/.test(html) && /&lt;script&gt;/.test(html),
      html.slice(0, 90));
  }

  console.log('\n══ ⑤ 超长截断 ══');
  {
    const long = '啊'.repeat(400);
    const html = M.traceLines({ reviews: [{ date: '2026-11-10', note: long }] });
    const body = (html.match(/）([^<（]*)/) || ['', ''])[1];
    A('★ 单条 note 被截到 140 字以内（一页要塞下多题）', body.length <= 140, body.length + ' 字');
  }

  console.log('\n══ ⑥ 接线与样式 ══');
  A('★ `ansHtml` 在"当时错答/错因"之后调用 traceLines（顺序：主体在前、旁注在后）',
    /<div class="why">[\s\S]{0,200}traceLines\(c\)/.test(paper), '');
  A('★ 打印时不许拆页（旁注与它的题分到两页就没人看得懂）',
    /\.sheet \.trace\{[^}]*break-inside:avoid/.test(css) && /page-break-inside:avoid/.test(css), '');
  A('卷面（重做卷）**不带**转折点（那是答案册的内容，印到卷面上等于泄答案）',
    !/qHtml[\s\S]{0,4000}traceLines/.test(paper.slice(paper.indexOf('function qHtml'), paper.indexOf('function ansHtml'))), '');

  console.log('\n══ ⑦ 阴性自证：把"取最近 2 条"改成"取最早 2 条" ⇒ ③ 必须红 ══');
  {
    const broken = fn.replace('const shown = rs.slice(-2);', 'const shown = rs.slice(0, 2);');
    A('变异点命中', broken !== fn, '');
    const M2 = await load(broken, 'mut');
    const html = M2.traceLines({ reviews: [
      { date: '2026-11-01', note: '第一次的旧想法' },
      { date: '2026-11-05', note: '第二次的想法' },
      { date: '2026-11-10', note: '最近的想法' },
    ] });
    A('★ 掏成"取最早"后，最近那条不再出现（这条判据确实有牙齿）', !/最近的想法/.test(html), '');
  }

  console.log(`\n[neg-answer-trace] 断言=${passed} 失败=${worst}`);
  process.exit(worst ? 1 : 0);
})().catch(e => { console.error('用例自身异常：' + (e && e.stack || e)); process.exit(1); });
