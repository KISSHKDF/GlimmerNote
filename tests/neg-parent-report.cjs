#!/usr/bin/env node
/**
 * neg-parent-report.cjs —— 家长只读报告（2026-11-13 立，批次 4 最后一项）
 *
 * 依据（审计建议）：**家长只读报告导出**（单文件 HTML/PDF，含**薄弱点 / 趋势 / 待复习清单**），
 * 并明确"**走导出文件、不上云**"——本仓的离线红线正好要求如此。
 *
 * 实现路线是**复用既有通道**，不新增任何网络/落库动作：
 *   · 「🖨 打印家长报告」→ `S.printHtml`（系统打印对话框，可选「Microsoft Print to PDF」存单文件）；
 *   · 「📄 存为 PDF」→ `H.pdf`（不依赖打印机，直接落 `组卷\` 下的唯一文件名）。
 *
 * 本用例**真跑** `V.reportHtml`（抽成临时模块 + 注入 `U.esc`），守：
 *   ① 三大块都在（薄弱点 / 趋势 / 待复习清单）；
 *   ② **无外链、无脚本**（"不上云"的机械判据——报告里出现 http/img src/@import/script 就是红线）；
 *   ③ 空库不崩（total=0、无逾期、无考点 —— 新用户第一次点它也必须出得来）；
 *   ④ 数字与转义正确（条形宽度按比例、学生名里的 `<` 不许逃逸）。
 * 另守接线：`S.printHtml` 已收敛到 shell.js 并被 paper 与 stats 共用、stats 有导出按钮与事件、
 * `H` 在 stats 作用域里（**这一条是写完才发现漏的**：stats.js 原先没 import H，存 PDF 会当场 ReferenceError）。
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

const STATS = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'stats.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'shell.js'), 'utf8');
const PAPER = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
const CSS = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'css', 'app.css'), 'utf8');

function member(src, sig, indent) {
  const lines = src.split('\n');
  const i = lines.findIndex(l => l.includes(sig));
  if (i < 0) return null;
  const close = new RegExp('^' + indent + '\\};?');
  let j = i + 1;
  while (j < lines.length && !close.test(lines[j])) j++;
  return lines.slice(i, j + 1).join('\n');
}
const fn = member(STATS, 'V.reportHtml = function (d) {', '  ');

console.log('测试环境：' + E.describe());

(async () => {
  A('从真源码抽到 V.reportHtml', !!fn, fn ? fn.split('\n')[0].trim() : '抽不到（签名变了？）');
  if (!fn) { console.log(`\n[neg-parent-report] 断言=${passed} 失败=${worst + 1}`); process.exit(1); }

  const HARNESS = 'const U = { esc: s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;" }[c])) };\nconst V = {};\n';
  const load = async (body, tag) => {
    const p = path.join(E.allocTempDir('gn-report-' + tag + '-'), 'm.mjs');
    fs.writeFileSync(p, HARNESS + body + '\nexport { V };\n', 'utf8');
    return import(pathToFileURL(p).href);
  };
  const M = await load(fn, 'real');

  const FULL = {
    student: '小红', today: '2026-11-13', total: 40, archived: 3,
    layers: [['K 知识性', 20], ['L 逻辑性', 12], ['S 习惯性', 8]],
    codes: [['K1', 12], ['S2', 7]],
    kp: [['反比例函数', 9], ['全等三角形', 5]],
    days: ['11-01', '11-02', '11-03'], vals: [1, 4, 2],
    risk: [{ id: 'M0007', title: '如图，求阴影面积', due: '2026-11-01', over: 12 }],
    advice: '当前最漏的是 <b>K 知识性</b>',
  };

  console.log('\n══ ① 三大块都在 ══');
  {
    const h = M.V.reportHtml(FULL);
    A('★ 薄弱点（含错因三层与薄弱考点）', /薄弱点/.test(h) && /K 知识性/.test(h) && /反比例函数/.test(h), '');
    A('★ 趋势（14 天入册）', /趋势/.test(h) && /rp-trend/.test(h) && /rp-col/.test(h), '');
    A('★ 待复习清单（题号 + 逾期天数）', /待复习清单/.test(h) && /M0007/.test(h) && /12 天/.test(h), '');
    A('有"现在该做什么"的行动句（报告不能只是数字）', /现在该做什么/.test(h) && /K 知识性/.test(h), '');
    A('页脚写明口径与"本机生成、不含联网动作"', /本机/.test(h) && /不含任何联网动作/.test(h), '');
  }

  console.log('\n══ ② 无外链、无脚本（"不上云"的机械判据）══');
  {
    const h = M.V.reportHtml(FULL);
    A('★ 不含 http/https 链接', !/https?:\/\//i.test(h), '');
    A('★ 不含 `<script`', !/<script/i.test(h), '');
    A('★ 不含 `@import` / 外部样式表', !/@import|<link/i.test(h), '');
    A('★ 不含任何 `<img`（报告不需要图，也就不可能带出原图）', !/<img/i.test(h), '');
    A('★ 不含答案字样（这是"计划与薄弱点"，不是答案册）', !/正确答案|答案：/.test(h), '');
  }

  console.log('\n══ ③ 空库/边界不崩（新用户第一次点它也要出得来）══');
  {
    let ok = true, msg = '';
    try {
      const empty = M.V.reportHtml({ student: '', today: '', total: 0, layers: [], codes: [], kp: [], days: [], vals: [], risk: [] });
      ok = /错题复习报告/.test(empty) && /暂无逾期题/.test(empty);
      msg = '空参数也出了报告';
      const noArg = M.V.reportHtml();
      ok = ok && typeof noArg === 'string' && noArg.length > 100;
    } catch (e) { ok = false; msg = '抛了：' + (e && e.message); }
    A('★ 空数据/无参调用不抛、且出得来（含"暂无逾期题"兜底）', ok, msg);
  }

  console.log('\n══ ④ 数字与转义 ══');
  {
    const h = M.V.reportHtml(FULL);
    A('★ 条形宽度按比例（K 20/40 = 50%）', /width:50%/.test(h), (h.match(/width:\d+%/g) || []).slice(0, 3).join(' '));
    A('★ 超总量不会超过 100%（clamp 在 pct 里）',
      !/width:(1[1-9]\d|[2-9]\d\d)%/.test(M.V.reportHtml({ total: 2, layers: [['X', 99]], codes: [], kp: [], days: [], vals: [], risk: [] })), '');
    const x = M.V.reportHtml({ student: '<b>坏</b>', today: '', total: 1, layers: [], codes: [], kp: [], days: [], vals: [], risk: [] });
    A('★ 学生名里的 HTML 被转义（不许逃逸）', !/<b>坏<\/b>/.test(x) && /&lt;b&gt;/.test(x), '');
  }

  console.log('\n══ ⑤ 接线：通道已收敛、按钮与事件在场、H 在作用域里 ══');
  A('★ `S.printHtml` 已收敛到 shell.js（唯一出口）', /S\.printHtml = function \(html, tip\)/.test(SHELL), '');
  A('★ paper.js 不再自带一份（改为调 S.printHtml）',
    !/function printHtml\(/.test(PAPER) && /S\.printHtml\(V\.printUnit\(kind\)/.test(PAPER), '');
  A('★★ shell.js 保留了"壳通道下绝不自动清空打印区"那条铁律的说明（不是只搬代码不搬教训）',
    /绝不自动清空/.test(SHELL), '');
  A('stats 有「🖨 打印家长报告」与「📄 存为 PDF」两个入口', /id="stPrint"/.test(STATS) && /id="stPdf"/.test(STATS), '');
  A('两个入口都判空后绑定（视图可能被换掉）', /const stPrint = U\.\$id\('stPrint'\);\s*\n\s*if \(stPrint\)/.test(STATS) && /const stPdf = U\.\$id\('stPdf'\)/.test(STATS), '');
  A('★★ stats.js 的 `H` 在作用域里（**写这段时漏过一次**：只用 U/M/S ⇒ `H.pdf` 当场 ReferenceError）',
    /const U = CTB\.util, M = CTB\.model, H = CTB\.host, S = CTB\.shell;/.test(STATS), '');
  A('★ PDF 文件名带 HHmm（固定名 + 文件被 PDF 程序打开 ⇒ 必然失败且报错无线索）',
    /家长报告-' \+ hm \+ '\.pdf'/.test(STATS), '');
  A('★ 真浏览器下点「存为 PDF」有明确提示（不静默）', /存 PDF 需要桌面壳/.test(STATS), '');
  A('CSS 有报告样式（打印友好、字号 rem）', /\.rp\{color:#111/.test(CSS) && /\.rp-trend\{/.test(CSS), '');

  console.log('\n══ ⑥ 阴性自证：往报告里塞一条外链 ⇒ ② 必须红 ══');
  {
    const broken = fn.replace("'<div class=\"rp-h\">", "'<div class=\"rp-h\"><img src=\"https://example.com/x.png\">");
    A('变异点命中', broken !== fn, '');
    const M2 = await load(broken, 'mut');
    const h2 = M2.V.reportHtml(FULL);
    A('★ 塞进外链后，② 的"无外链/无 img"判据确实会红', /https?:\/\//i.test(h2) && /<img/i.test(h2), '');
  }

  console.log(`\n[neg-parent-report] 断言=${passed} 失败=${worst}`);
  process.exit(worst ? 1 : 0);
})().catch(e => { console.error('用例自身异常：' + (e && e.stack || e)); process.exit(1); });
