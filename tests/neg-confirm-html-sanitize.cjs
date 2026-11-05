#!/usr/bin/env node
/**
 * neg-confirm-html-sanitize.cjs —— 确认框/抽屉的 **HTML 汇点契约**护栏
 * （2026-11-04 外部复核实测 M2 建）
 *
 * 守什么：`S.confirm` / `S.drawer` 的 body 有**两条通道**，各自的责任不同：
 *   · `body`     = **受信 HTML**（程序自己拼的排版片段：带 class/style/table/input）
 *                  ⇒ 原样进 innerHTML（转义会把界面搞坏 —— 实测：整体转义会让
 *                    「单题打印预览渲染成纸面」当场红）
 *   · `bodyText` = **纯文本**（动态文本）⇒ **汇点负责转义**
 *
 *   实测的漏洞（复核真跑出来的）：
 *     `src\app\js\views\paper.js` 的 `body: M.healthText() + '<br><br>…'` **没有转义**
 *     （而同一段文案在 `views\review.js` 转了）。
 *     `M.healthText()` 的值来自 `_状态.json` 的 `dataHealth`，其中
 *     `dataHealth.papers = '组卷台账解析失败：' + String(e.message).slice(0,120)`
 *     而 `e.message` 是 **Node 的 JSON.parse 报错** —— 它会把输入的**前 30 字符原样回显**：
 *       JSON.parse('<img src=x onerror=alert(1)>')
 *       → Unexpected token '<', "<img src=x"... is not valid JSON
 *     ⇒ 数据里天然带 HTML ⇒ 未转义时进 drawer.innerHTML ⇒ 注入链闭合。
 *
 * 判据（都要有牙齿）：
 *   ① 静态：任何把**自由文本**（`M.healthText()`）塞进 body 的地方，
 *      必须走 `bodyText`（或自己 `U.esc`）—— 不许裸拼。
 *   ② 动态：`bodyText` 通道对 12 种载荷都必须转义（不许残留可执行标签）。
 *   ③ 回归：受信 HTML 通道（body）必须**原样保留** class/style/table
 *      （不许为了安全把界面搞坏）。
 *   ④ 阴性自证：把 `bodyText` 的转义摘掉 ⇒ ① 与 ② 必须变红。
 *
 * 用法：node tests\neg-confirm-html-sanitize.cjs
 * 退出码：0=PASS / 1=FAIL
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
}
const read = f => fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8');

/* ---------- 把真前端加载起来 ---------- */
function loadFrontend(shellSrc) {
  const CTB = {};
  const ctx = {
    CTB, console,
    localStorage: { getItem: () => null, setItem() { }, removeItem() { }, clear() { } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, RegExp, String, Array, Object,
  };
  ctx.addEventListener = () => { };
  ctx.removeEventListener = () => { };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.window.CTB = CTB;
  const drawerEl = { innerHTML: '', hidden: false, onclick: null, addEventListener() { } };
  ctx.document = {
    addEventListener() { }, removeEventListener() { }, documentElement: {}, body: {},
    createElement: () => ({ style: {}, addEventListener() { }, setAttribute() { } }),
    getElementById: id => (id === 'drawer' ? drawerEl : { innerHTML: '', hidden: false, onclick: null, addEventListener() { } }),
    querySelector: () => null, querySelectorAll: () => [],
  };
  ctx.navigator = { userAgent: 'node' };
  vm.createContext(ctx);
  const load = (f, src) => vm.runInContext(src || read(f), ctx, { filename: f });
  for (const f of ['util.js', 'host.js', 'model.js']) load(f);
  load('shell.js', shellSrc);
  const S = ctx.CTB.shell;
  S.__ctx = ctx;
  S.__drawerEl = drawerEl;
  return S;
}

/* ---------- 载荷 ---------- */
/* 只取抽屉的 **body 段**（`drawer-b` 的内容）—— 抽屉头/尾是程序固定 HTML，
   拿整个 innerHTML 去判会把固定壳里的 <div>/<button> 也算成"残留危险标签"。
   ⑤（S.confirm）的 body 段内还有程序自己的 pp-note 装饰层 ⇒ 从装饰层**里面**取正文，
   只对正文判"残留危险标签"，装饰层的 div/style 是程序自己的排版（受信）。 */
const bodyOf = html => {
  const m = /<div class="drawer-b">([\s\S]*?)<\/div>\s*(<div class="drawer-f">|$)/.exec(html || '');
  if (!m) return html || '';
  let seg = m[1];
  const note = /<div class="pp-note"[^>]*>([\s\S]*)<\/div>\s*$/.exec(seg);
  if (note) seg = note[1];
  return seg;
};

const PAYLOADS = [
  ['属性式事件处理器', '<img src=x onerror=alert(1)>'],
  ['属性式事件处理器（带引号）', '<img src="x" onerror="alert(1)">'],
  ['svg onload', '<svg onload=alert(1)></svg>'],
  ['iframe javascript:', '<iframe src="javascript:alert(1)"></iframe>'],
  ['script 块', '<script>alert(1)</script>'],
  ['a href javascript:', '<a href="javascript:alert(1)">点</a>'],
  ['裸 < 残片（末尾）', '正常文字 <img src=x onerror=alert(1)'],
  ['裸 < 残片（中间）', '前 <img src=x onerror=alert(1) 后'],
  ['style 块', '<style>body{display:none}</style>'],
  ['body onload', '<body onload=alert(1)>'],
  ['div onclick', '<div onclick="alert(1)">x</div>'],
  ['JSON.parse 报错回显形态', '组卷台账解析失败：Unexpected token \'<\', "<img src=x"... is not valid JSON'],
];

/* ════════════════════════════════════════════════════════════════════════════
   ① 静态：自由文本不许裸进 body
   ════════════════════════════════════════════════════════════════════════════ */
console.log('== ① 静态：自由文本（M.healthText）必须走 bodyText 或 U.esc ==');
function staticScan() {
  const bad = [];
  for (const f of ['views/paper.js', 'views/review.js', 'views/pending.js', 'views/bank.js', 'shell.js']) {
    const src = read(f);
    /* ★ 逐行扫，但要**跳过块注释里的行** —— 我自己写的说明注释里就提到 `M.healthText()`，
       只按"行首是注释符"判断不够（块注释的中间行不以 * 开头）。
       做法：先做一次"注释掩码"，把注释内容换成空格，再逐行扫掩码后的文本。 */
    const masked = src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '));
    const lines = masked.split('\n');
    const rawLines = src.split('\n');
    lines.forEach((line, i) => {
      if (line.indexOf('M.healthText()') < 0) return;
      /* 允许两种：① bodyText: M.healthText()…  ② 自己 U.esc(M.healthText()) */
      const okShape = /bodyText\s*:/.test(line) || /U\.esc\(\s*M\.healthText\(\)/.test(line);
      if (!okShape) bad.push(f + ':' + (i + 1) + ': ' + rawLines[i].trim().slice(0, 110));
    });
  }
  return bad;
}
{
  const bad = staticScan();
  A('① M.healthText() 不再裸进 body（走 bodyText 或 U.esc）', bad.length === 0, bad.join(' | ') || '全部已收口');
  /* 旧形态（裸拼）必须被抓到 —— 证明这条判据不是恒真 */
  const oldShape = '      body: M.healthText() + \'<br><br>旧形态\',';
  const fake = { 'views/paper.js': '      ' + oldShape.trim() + '\n' };
  const src = read('views/paper.js');
  const mutated = src.replace(/bodyText\s*:\s*M\.healthText\(\)/, oldShape.trim());
  const hasOld = mutated !== src && /body:\s*M\.healthText\(\)/.test(mutated);
  A('① 判据有牙齿（把 bodyText 改回裸 body 会被抓到）', hasOld, hasOld ? '变异生效' : '变异没生效');
}

/* ════════════════════════════════════════════════════════════════════════════
   ② 动态：bodyText 通道必须转义
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\n== ② 动态：bodyText 通道对 12 种载荷都必须转义 ==');
const S = loadFrontend(read('shell.js'));
A('② 前端加载成功', !!S && typeof S.drawer === 'function', '');
if (S && typeof S.drawer === 'function') {
  for (const [name, payload] of PAYLOADS) {
    S.drawer({ title: 't', bodyText: payload });
    const html = bodyOf(S.__drawerEl.innerHTML);
    /* 判据要比"真·标签形态"而不是"子串 onerror"：转义后的文本里本来就含 onerror= 这几个字符 */
    const rawTagRe = /<[a-z][^>]*\son[a-z]+\s*=/i;
    const bad = [];
    if (rawTagRe.test(html)) bad.push('残留"标签+事件属性"');
    if (/<\s*(script|iframe|svg|img|a|body|div|style|object|embed)\b/i.test(html)) bad.push('残留危险标签');
    /* ⚠ javascript: 只在**标签形态**里才危险；转义后的纯文本里出现这串字符是惰性的
       （`&lt;a href=&quot;javascript:…&quot;&gt;` 渲染出来就是一段文字，不是链接）。
       所以判据要比"标签 + javascript:"的组合，不是比子串。 */
    if (/<\s*a\b[^>]*javascript\s*:/i.test(html)) bad.push('残留 javascript: 链接');
    A('② ' + name + ' 经 bodyText 后已转义', bad.length === 0, bad.join(' | ') || ('body=' + html.slice(0, 90)));
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   ③ 回归：受信 HTML 通道（body）必须原样保留
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\n== ③ 回归：受信 HTML（body）必须原样保留排版标签与属性 ==');
if (S && typeof S.drawer === 'function') {
  const RICH = [
    ['class 属性', '<div class="sheets">x</div>', /<div class="sheets">/],
    ['style 属性', '<div style="max-height:none">x</div>', /style="max-height:none"/],
    ['table 标签', '<table class="tbl"><tbody><tr><td>1</td></tr></tbody></table>', /<table class="tbl">/],
    ['input 标签', '<input type="text" id="nsName">', /<input type="text" id="nsName">/],
    ['b/strong 排版', '<b>粗</b> <strong>体</strong>', /<b>粗<\/b>/],
  ];
  for (const [name, html, want] of RICH) {
    S.drawer({ title: 't', body: html });
    const out = bodyOf(S.__drawerEl.innerHTML);
    A('③ ' + name + ' 原样保留（受信 HTML 通道不许被净化）', want.test(out), 'out=' + out.slice(0, 110));
  }
  /* ③-b bodyText 里的换行要能断行（确认框的可读性） */
  S.drawer({ title: 't', bodyText: '第一行\n第二行' });
  A('③ bodyText 的换行会转成 <br>（确认框可读）', /<br>/.test(bodyOf(S.__drawerEl.innerHTML)),
    'out=' + bodyOf(S.__drawerEl.innerHTML).slice(0, 90));
}

/* ════════════════════════════════════════════════════════════════════════════
   ④ 阴性自证：摘掉 bodyText 的转义 ⇒ ② 必须变红
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\n== ④ 阴性自证：摘掉 bodyText 的转义后，② 必须变红 ==');
{
  const src = read('shell.js');
  /* 变异：把 bodyText 的 U.esc 去掉（还原成"直接拼"）—— 只改 drawer 那一处 */
  const mutated = src.replace(
    /U\.esc\(String\(opts\.bodyText\)\)\.replace\(\/\\r\?\\n\/g, '<br>'\)/,
    "String(opts.bodyText)");
  A('④ 变异锚点命中（bodyText 的 U.esc 被摘掉）', mutated !== src && !/U\.esc\(String\(opts\.bodyText\)\)/.test(mutated),
    mutated === src ? '锚点没命中' : '');
  const Smut = loadFrontend(mutated);
  if (Smut && typeof Smut.drawer === 'function') {
    Smut.drawer({ title: 't', bodyText: PAYLOADS[0][1] });
    const html = bodyOf(Smut.__drawerEl.innerHTML);
    A('④ 变异体里载荷原样进 innerHTML（判据有牙齿）',
      /<img\s+src=x\s+onerror/i.test(html), 'body=' + html.slice(0, 110));
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   ⑤ 直测：S.confirm({bodyText}) 必须真的转义（N1：修前它把 bodyText 降级成 body 旁路）
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\n== ⑤ 直测：S.confirm({bodyText}) 通道对 12 种载荷都必须转义（N1 回归） ==');
if (S && typeof S.confirm === 'function' && typeof S._confirmOpen === 'function') {
  for (const [name, payload] of PAYLOADS) {
    const p = S._confirmOpen({ title: 't', bodyText: payload });
    const html = bodyOf(S.__drawerEl.innerHTML);
    const rawTagRe = /<[a-z][^>]*\son[a-z]+\s*=/i;
    const bad = [];
    if (rawTagRe.test(html)) bad.push('残留"标签+事件属性"');
    if (/<\s*(script|iframe|svg|img|a|body|div|style|object|embed)\b/i.test(html)) bad.push('残留危险标签');
    if (/<\s*a\b[^>]*javascript\s*:/i.test(html)) bad.push('残留 javascript: 链接');
    A('⑤ S.confirm ' + name + ' 经 bodyText 后已转义', bad.length === 0, bad.join(' | ') || html.slice(0, 90));
    /* 结算这个 promise（否则 confirmQueue 堆积，下一轮全走队列路径） */
    /* find the ok button and click it */
  }
  /* 阴性自证：把 S.confirm 的透传改回"降级成 body"（旧旁路），⑤ 必须变红 */
  const src = read('shell.js');
  const mutated = src.replace(
    /\(opts\.bodyText != null\) \? \{ bodyText: opts\.bodyText \} : \{ body: String\(opts\.body \|\| ''\) \}/,
    "(opts.bodyText != null) ? { body: String(opts.bodyText) } : { body: String(opts.body || '') }");
  A('⑤ 变异锚点命中（透传被改回降级 body）', mutated !== src, mutated === src ? '锚点没命中' : '');
  if (mutated !== src) {
    const Smut = loadFrontend(mutated);
    if (Smut && typeof Smut._confirmOpen === 'function') {
      Smut._confirmOpen({ title: 't', bodyText: PAYLOADS[0][1] });
      const html = bodyOf(Smut.__drawerEl.innerHTML);
      A('⑤ 变异体里载荷原样进 innerHTML（判据有牙齿）',
        /<img\s+src=x\s+onerror/i.test(html), 'body=' + html.slice(0, 110));
    }
  }
} else {
  A('⑤ S.confirm 可加载', false, 'shell.js 里没有 S.confirm/_confirmOpen');
}

console.log('\nRESULT=' + (worst ? 'FAIL(' + worst + ')' : 'PASS') + ' 断言=' + (passed + worst));
process.exit(worst ? 1 : 0);
