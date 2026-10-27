#!/usr/bin/env node
/**
 * 卷面超宽三连回归（2026-10-27，用户实测 P20261027-01「M0111 生物园填表右侧两列被裁掉」）。
 *
 * 三类「卷面元素比纸宽」的实测形态（headless Edge 量过全库 452 张卡，纸面内容宽 635px）：
 *   ① 表格里的空位被 applySlotWidths 按答案撑到行内 min-width:14.3em × 6 列 ⇒ 表格 1351px（M0111）；
 *   ② 无空位的宽表（M0066 乘方 8 列，757px）超出 122px，末列裁边；
 *   ③ 题干内联 <svg> 带像素 width（640~1120px，物理 43 + 化学 2 + 数学 1 共 46 张卡）——10-12 修过 <img>，svg 漏了。
 *
 * 本用例守四段：
 *   A. 渲染链真实性：合成卡走真实 qHtml/stemHtmlSafe，空位真的带行内 min-width、svg 真的带像素 width
 *      （没有这两条，下面的 CSS 断言就是在守一个不存在的问题）。
 *   B. CSS 规则在场（剥注释匹配，删规则即红——同 neg-stem-img-fit 判据法）。
 *   C. headless Edge 真排版实测：真 CSS 下合成页 0 溢出。
 *   D. 阴性自证：把「表内空位封顶」一条规则掏掉，同一页必须重新量出溢出——证明断言活着，不是恒真。
 *
 * C/D 需要本机 Edge（WebView2 机器都有；找不到时 [SKIP] 可见，不影响绿）。
 * 用法：node tests/neg-stem-table-fit.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');
const ROOT = E.REPO;

let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};

const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = rd('src/app/css/app.css');
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // 先剥注释：说明文字里的样式字样不许喂进判据

/* ---------- 内存沙箱：载真实 util/host/model + qHtml 抽取（与 neg-paper-order-blank 同法） ---------- */
const store = new Map();
const CTB = { util: {}, host: {}, model: {}, shell: {}, views: {} };
const sandbox = {
  console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, CTB,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  window: { addEventListener() { } },
};
sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['src/app/js/util.js', 'src/app/js/host.js', 'src/app/js/model.js'])
  vm.runInContext(rd(f), sandbox, { filename: f });
sandbox.CTB.views = {};
vm.runInContext(rd('src/app/js/views/paper.js'), sandbox, { filename: 'views/paper.js' });
const M = sandbox.CTB.model, U = sandbox.CTB.util, H = sandbox.CTB.host;
const mQ = rd('src/app/js/views/paper.js').match(/function qHtml\(x, i, form\) \{[\s\S]*?\n  \}/);
A('qHtml 可从 paper.js 抽取（渲染口径唯一）', !!mQ);
const qHtml = new Function('U', 'M', 'H', 'return (' + mQ[0].replace(/^function qHtml/, 'function') + ')')(U, M, H);

/* ---------- 合成卡（M0111 同形：6 列填表 + 带注解的逐空答案；P0006 同形：带像素 width 的 svg） ---------- */
const mk = (id, stemHtml, type, answerSlots) => ({
  key: '学生A|数学|' + id, kid: '学生A', subject: '数学',
  card: {
    id, type: type || '填空题', difficulty: '易',
    question: '依次取 1、2、3、4、5，把对应的 S 填入下表。',
    stemHtml, answer: '—', answerMode: answerSlots ? 'blank' : 'none',
    answerSlots: answerSlots || undefined,
  },
});
const TABLE_STEM = '<div class="stem"><p>a 依次取 1、2、3、4、5，把对应的生物园面积 S 填入下表．</p>'
  + '<table class="stem-table"><tr><th>a/m</th><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr>'
  + '<tr><th>S/m<sup>2</sup></th><td><span class="blank"></span></td><td><span class="blank"></span></td>'
  + '<td><span class="blank"></span></td><td><span class="blank"></span></td><td><span class="blank"></span></td></tr></table></div>';
const SVG_STEM = '<div class="stem"><p>小球从 A 点运动到 C 点，轨迹如图所示。</p>'
  + '<div class="stem-figure"><svg viewBox="0 0 900 460" width="700" height="358" xmlns="http://www.w3.org/2000/svg">'
  + '<line x1="10" y1="450" x2="890" y2="450" stroke="#333"/><circle cx="120" cy="120" r="10" fill="#f50"/></svg></div></div>';
const cardTable = mk('T9001', TABLE_STEM, '填空题', ['7（a=1：1×7）', '12（a=2：2×6）', '15（a=3：3×5）', '16（a=4：4×4）', '15（a=5：5×3）']);
const cardSvg = mk('T9002', SVG_STEM, '解答题', null);

/* ---------- A. 渲染链真实性 ---------- */
console.log('\n═══ A. 渲染链真实性（缺陷的前提必须真的在） ═══');
const htmlTable = qHtml(cardTable, 0, 'stem');
const htmlSvg = qHtml(cardSvg, 1, 'stem');
A('① 表内空位渲染后被按答案撑到行内 min-width ≥ 14em（M0111 同形）',
  /class="blank" style="min-width:1[0-9]+(\.[0-9]+)?em"/.test(htmlTable),
  (htmlTable.match(/class="blank" style="min-width:[^"]*"/g) || []).slice(0, 1).join(''));
A('① 表格是 6 列（5 空 + 表头列）', (htmlTable.match(/<td>/g) || []).length >= 10, 'td≥10');
A('③ svg 渲染后保留像素 width=700（> 纸面内容宽 635px）',
  /<svg[^>]*width="700"/.test(htmlSvg), 'width=700 在场');

/* ---------- B. CSS 规则在场 ---------- */
console.log('\n═══ B. CSS 规则（删掉即红） ═══');
A('① 表格封顶 max-width:100%', /\.sheet \.q-stem table\{[^}]*max-width:\s*100%/.test(RULES));
A('① 表内空位 min-width 必须能压过行内 style（!important）',
  /\.sheet \.q-stem table \.blank\{[^}]*min-width:\s*0\s*!important/.test(RULES));
A('① 表内空位宽度跟随格子（width:calc(100% - 8px)，覆盖 .blank 自带 2×3px margin）',
  /\.sheet \.q-stem table \.blank\{[^}]*width:\s*calc\(100%\s*-\s*8px\)/.test(RULES));
A('③ 纸面 svg 与 img 同规（max-width:100% !important + height:auto）',
  /\.sheet[^{]*svg[^{]*\{[^}]*max-width:\s*100%\s*!important[^}]*height:\s*auto/.test(RULES)
  || /\.sheet[^{]*svg[^{]*\{[^}]*height:\s*auto[^}]*max-width:\s*100%\s*!important/.test(RULES));
A('③ 抽屉侧 svg 也不能缺（.stembox svg）',
  /\.stembox[^{]*svg\s*\{[^}]*max-width:\s*100%\s*!important/.test(RULES));
/* 打印态：题号/题干不许断（.q-stem 的 avoid 在 @media print 里；题号孤行靠 q-hd break-after:avoid）。
   ⚠ 有意不保整题（anszone 可跨页）：整题 avoid 让 30 题卷 7→14 页，保到题干粒度是 11 页
   （print-to-pdf 实测）。若日后想收紧到整题，这条断言会红，属有意提醒纸量代价。 */
A('打印态题干不许从中间断页（.sheet .q-stem 的 break-inside:avoid 在 @media print 里）',
  /@media print\{[\s\S]*?\.sheet \.q-hd,\.sheet \.q-stem\{[^}]*break-inside:avoid/.test(CSS));
A('打印态题号不与题干分离（q-hd 的 break-after:avoid）',
  /@media print\{[\s\S]*?\.sheet \.q-hd\{[^}]*break-after:avoid/.test(CSS));

/* ---------- C/D. headless Edge 真排版实测 + 阴性自证 ---------- */
function findEdge() {
  const cands = [];
  if (process.env['ProgramFiles(x86)']) cands.push(path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  return cands.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
const MEASURE_JS = `
window.addEventListener('load', () => {
  try {
    const sheet = document.querySelector('.sheet');
    const cs = getComputedStyle(sheet);
    const r = sheet.getBoundingClientRect();
    const cRight = r.right - parseFloat(cs.paddingRight);
    const out = [];
    document.querySelectorAll('[data-q]').forEach(qw => {
      let worstOver = 0, total = 0;
      qw.querySelectorAll('*').forEach(el => {
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) return;
        const over = b.right - cRight;
        if (over > 1) { total++; if (over > worstOver) worstOver = Math.round(over); }
      });
      out.push({ q: qw.getAttribute('data-q'), total: total, worst: worstOver });
    });
    const pre = document.createElement('pre');
    pre.id = 'MEASURE'; pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
  } catch (e) {
    const pre = document.createElement('pre');
    pre.id = 'MEASURE'; pre.setAttribute('data-err', String(e && e.message || e));
    document.body.appendChild(pre);
  }
});
`;

function edgeMeasure(cssText, tagLabel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-tablefit-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.css'), cssText);
    const page = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#printArea{display:block!important}</style>'
      + '<link rel="stylesheet" href="app.css"></head><body><div id="printArea" class="print-area"><div class="sheet">'
      + '<div class="q-wrap" data-q="T9001-table">' + htmlTable + '</div>'
      + '<div class="q-wrap" data-q="T9002-svg">' + htmlSvg + '</div>'
      + '</div></div><script>' + MEASURE_JS + '<\/script></body></html>';
    fs.writeFileSync(path.join(dir, 'page.html'), page);
    const edge = findEdge();
    if (!edge) return { skipped: true };
    let html;
    {
      const prof = path.join(dir, 'edge-profile');
      const r = spawnSync(edge, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--user-data-dir=' + prof, '--virtual-time-budget=8000', '--dump-dom', pathToFileURL(path.join(dir, 'page.html')).href,
      ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
      html = String(r.stdout || '');
    }
    const m = html.match(/<pre id="MEASURE"([^>]*)>([\s\S]*?)<\/pre>/);
    if (!m) return { error: 'dump 里没有 MEASURE（headless Edge 未产出？）' };
    if (m[1].indexOf('data-err') >= 0) return { error: (m[1].match(/data-err="([^"]*)"/) || [])[1] || '测量脚本异常' };
    return { rows: JSON.parse(m[2]) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
}

console.log('\n═══ C. headless Edge 真排版（真 CSS 必须 0 溢出） ═══');
const good = edgeMeasure(CSS, 'real');
if (good.skipped) {
  console.log('  [SKIP] 本机没找到 msedge.exe —— C/D 两段真排版实测跳过（A/B 段的源码级判据仍生效）');
} else if (good.error) {
  A('C 真排版实测可运行', false, good.error);
} else {
  const t1 = good.rows.find(x => x.q === 'T9001-table');
  const t2 = good.rows.find(x => x.q === 'T9002-svg');
  A('C1 表格卡 0 溢出（M0111 同形：空位跟随格宽）', t1 && t1.total === 0, JSON.stringify(t1));
  A('C2 svg 卡 0 溢出（width=700 被等比缩进纸面）', t2 && t2.total === 0, JSON.stringify(t2));

  console.log('\n═══ D. 阴性自证（掏掉封顶规则必须复现溢出） ═══');
  const broken = CSS.replace(/^\.sheet \.q-stem table \.blank\{[^}]*\}\s*$/m, '');
  if (broken === CSS) A('D0 变异源码就位（找到目标规则并删除）', false, '没匹配到 .sheet .q-stem table .blank 规则');
  else {
    const bad = edgeMeasure(broken, 'mutated');
    if (bad.skipped) console.log('  [SKIP] Edge 缺席，D 段跳过');
    else if (bad.error) A('D 阴性自证可运行', false, bad.error);
    else {
      const bt = bad.rows.find(x => x.q === 'T9001-table');
      A('D1 规则被掏掉 → 表格卡必须重新量出溢出（>360px）',
        bt && bt.total > 0 && bt.worst > 360, JSON.stringify(bt));
    }
  }
}

console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL(' + fail + ')') + '  断言=' + (pass + fail) + ' 失败=' + fail);
process.exit(fail === 0 ? 0 : 1);
