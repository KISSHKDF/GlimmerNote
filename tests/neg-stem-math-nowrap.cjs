#!/usr/bin/env node
/**
 * neg-stem-math-nowrap.cjs —— 卷面「数学表达式不许被折行」回归护栏（2026-11-04 建）
 *
 * 用户报障原话：M0066「表格最左下角，负5分之一的3次方，打印版换行了，
 * 这一换行会造成很多误解，能不能不换行？」（附打印件截图：`(−` / `1⁄5` / `)³` 三行）
 *
 * 为什么这是一个**真缺陷**（而不是"排版偏好"）：
 *   「(−1/5)³」被拆成三行后，纸面上出现的是「(−」「)³」两个**独立片段**——
 *   负号和右括号各自离开了原来的表达式，孩子（和大人）极易把「(−」读成
 *   一个独立的负号、把「)³」读成另一段内容。这正是这张卡要纠正的错误
 *   （负底数写乘方不加括号），印成三行反而**强化了错误读法**。
 *
 * 根因（实测，不是猜）——**边距被扣了两遍**：
 *   打印时 @page 已经给了 16mm 左右边距 ⇒ body 可用宽 = 210−32 = 178mm（673px）；
 *   而 .sheet 自己又有 `padding:16mm 16mm 18mm` ⇒ 题干内容区只剩 **542px**
 *   （print 媒体实测 contentW=542）。M0066 这张 8 列表自然宽 580px，被挤爆后
 *   单元格只剩 66px、内容区可用 42px；而那个表达式要 **46px**
 *   （「(−」18 + 分数 14 + 「)」6 + 上标 8）⇒ **缺 4px** ⇒ 必然被拆。
 *
 * 本用例守五段（每段都有阴性自证，证明断言活着而不是恒真）：
 *   A. 渲染链真实性：合成卡走真实 qHtml/stemHtmlSafe，.fr 与 sup 真的在格子里
 *      （没有这条，下面的 CSS 断言就是在守一个不存在的问题）。
 *   B. CSS 规则在场（剥注释匹配，删规则即红）。
 *   C. headless Edge **打印媒体**真排版：含分数的格必须 0 折行、0 溢出纸面、0 横向溢出。
 *      ⚠★ 必须用 CDP 的 `Emulation.setEmulatedMedia({media:'print'})` + 正确视口：
 *        ① `--dump-dom` **不吃** setEmulatedMedia（它没有这条通道）⇒ 量的是屏幕态；
 *        ② 视口必须是「@page 内容区宽」（210mm−16mm×2 = 673 CSS px）——
 *           视口给宽了 ⇒ .sheet 按 210mm 排 ⇒ 量到的断行比真打印轻 ⇒ 假阴性。
 *        （本用例第一版就踩了这两个坑：headless 默认视口 800×600、且用 --dump-dom，
 *          量出来的 contentW=629 与真打印的 542 差 87px，断言口径整个是错的。）
 *      ⚠ 行归属必须按**垂直重叠**判定：sup 与同行正文重叠 ⇒ 同一行；
 *        若按"top 值去重"会把上标误算成另起一行 ⇒ 假阳性。
 *   D. 阴性自证：掏掉 nowrap 规则 ⇒ 必须重新量出折行；
 *      把 .sheet 的打印内边距改回去 ⇒ 必须重新量出「内容区变窄」。
 *   E. 全库体检（对着真库）：所有含表格的卡里，含分数的格子必须 0 折行、0 溢出。
 *
 * C/D/E 需要本机 Edge（WebView2 机器都有；找不到时 [SKIP] 可见，不影响绿）。
 * 用法：node tests/neg-stem-math-nowrap.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');
const ROOT = E.REPO;

let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};
const SKIP = (label, why) => console.log('  [SKIP] ' + label + '  → ' + why);

const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* 库里的文件按**绝对路径**读（E.LIB 是绝对路径，不能再拼 ROOT） */
const rdAbs = f => fs.readFileSync(f, 'utf8');
const CSS = rd('src/app/css/app.css');
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // 先剥注释：说明文字里的样式字样不许喂进判据

/* ---------- 内存沙箱：载真实 util/host/model + qHtml 抽取（与 neg-stem-table-fit 同法） ---------- */
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

/* ---------- 合成卡（M0066 同形：8 列乘方表 + 窄格里的分数表达式） ---------- */
const FR = '<span class="fr"><span class="nu">1</span><span class="de">5</span></span>';
const mk = (id, stemHtml) => ({
  key: '学生A|数学|' + id, kid: '学生A', subject: '数学',
  card: { id, type: '填空题', difficulty: '中', question: '填表：', stemHtml, answer: '—', answerMode: 'none' },
});
const T1 = '<div class="stem"><p>填表：</p><table class="stem-table">'
  + '<tr><th>乘方</th><th>底数</th><th>指数</th><th>乘方的结果</th><th>乘方</th><th>底数</th><th>指数</th><th>乘方的结果</th></tr>'
  + '<tr><td>5<sup>2</sup></td><td>x</td><td>y</td><td>z</td><td>a</td><td>b</td><td>4</td><td>16</td></tr>'
  + '<tr><td>(−' + FR + ')<sup>3</sup></td><td>x</td><td>y</td><td>z</td><td>a</td><td>b</td><td>3</td><td>−27</td></tr>'
  + '</table></div>';
/* 散文格（库里有 130 个）：必须**仍然能折行**，且不得被 nowrap 顶成一条长线 */
const T2 = '<div class="stem"><p>散文格：</p><table class="stem-table">'
  + '<tr><th>动力 F1/N</th><th>动力臂 l1/m</th></tr>'
  + '<tr><td>一段说明文字，里面夹着一个分数 ' + FR + '，用来验证 nowrap 只作用于纯数学格。</td><td>x</td></tr>'
  + '</table></div>';
const cardT1 = mk('T9101', T1);
const cardT2 = mk('T9102', T2);

/* ---------- A. 渲染链真实性 ---------- */
console.log('\n═══ A. 渲染链真实性（缺陷的前提必须真的在） ═══');
const htmlT1 = qHtml(cardT1, 0, 'stem');
const htmlT2 = qHtml(cardT2, 0, 'stem');
A('① 分数（.fr）真的渲染进格子里（M0066 同形）', /class="fr"/.test(htmlT1));
A('① 上标（sup）真的渲染进格子里', /<sup>3<\/sup>/.test(htmlT1));
A('① 表是 8 列（乘方|底数|指数|乘方的结果 × 2）',
  (htmlT1.match(/<th>/g) || []).length === 8, 'th=' + (htmlT1.match(/<th>/g) || []).length);
A('② 散文卡也在（验证 nowrap 不误伤散文）', /class="fr"/.test(htmlT2) && /说明文字/.test(htmlT2));

/* ---------- B. CSS 规则在场 ---------- */
console.log('\n═══ B. CSS 规则（删掉即红） ═══');
A('① 打印态 .sheet 内边距必须归零（@page 已给过边距，不许再扣一遍）',
  /@media print\{[^}]*\.sheet\{[^}]*padding:\s*0(?:[;\s]|\})/.test(RULES),
  (/@media print\{[^}]*\.sheet\{[^}]*\}/.exec(RULES) || [''])[0]);
A('② 格内左右留白必须 ≤ 8px（12px 会让 8 列表溢出纸面）',
  /\.sheet \.q-stem th,\.sheet \.q-stem td\{[^}]*padding:\s*2px\s+(?:[0-7]|8)px/.test(RULES),
  (/\.sheet \.q-stem th,\.sheet \.q-stem td\{[^}]*padding:[^}]*\}/.exec(RULES) || [''])[0]);
A('③ 含分数的格必须 nowrap（:has(.fr)）',
  /\.sheet \.q-stem (td|th):has\(\.fr\)[^{]*\{[^}]*white-space:\s*nowrap/.test(RULES));
A('③ 含分数的格必须有 min-width 兜底（列宽自动分配可能给不到 4.6em）',
  /\.sheet \.q-stem (td|th):has\(\.fr\)[^{]*\{[^}]*min-width:\s*4\.[0-9]+em/.test(RULES));
A('④ nowrap 不得扩到 sup/sub（散文格会被顶成一条长线、撑爆纸面）',
  !/\.sheet \.q-stem (td|th):has\(sup\)/.test(RULES) && !/\.sheet \.q-stem (td|th):has\(sub\)/.test(RULES));

/* ---------- C/D/E. headless Edge 打印媒体真排版（CDP：能真正切 print 媒体 + 控制视口） ---------- */
function findEdge() {
  const cands = [];
  if (process.env['ProgramFiles(x86)']) cands.push(path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  return cands.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
/* ★ 打印布局视口 = @page 内容区宽（A4 210mm − margin 16mm×2 = 178mm ≈ 673 CSS px）。 */
const PAGE_CONTENT_W = Math.round(210 / 25.4 * 96 - 16 / 25.4 * 96 * 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 测量脚本：打印媒体下逐格量。
 *   · 行归属按**垂直重叠**判定（sup 与同行正文重叠 ⇒ 同一行）；
 *   · .fr 内部的行不算"表达式折行"（分数本就该两行）；
 *   · 顺带量「横向溢出本格」——nowrap 的风险就是内容放不下时顶到邻格去。 */
const MEASURE_JS = `
(() => {
  const sheet = document.querySelector('.sheet');
  const cs = getComputedStyle(sheet);
  const sr = sheet.getBoundingClientRect();
  const cRight = sr.right - parseFloat(cs.paddingRight);
  const cLeft = sr.left + parseFloat(cs.paddingLeft);
  const tables = []; const cells = [];
  document.querySelectorAll('[data-q]').forEach(qw => {
    const qid = qw.getAttribute('data-q');
    qw.querySelectorAll('table').forEach(t => {
      const tb = t.getBoundingClientRect();
      tables.push({ q: qid, over: Math.round(tb.right - cRight), w: Math.round(tb.width) });
    });
    qw.querySelectorAll('td,th').forEach((c, i) => {
      const text = (c.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text) return;
      const rects = [];
      const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())) {
        if (!n.nodeValue.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        for (const r of rg.getClientRects()) {
          if (r.height <= 0) continue;
          const inFr = n.parentElement && n.parentElement.closest('.fr');
          rects.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, inFr: !!inFr });
        }
      }
      if (!rects.length) return;
      const outer = rects.filter(r => !r.inFr);
      const fr = c.querySelector('.fr');
      let frRect = null;
      if (fr) { const r = fr.getBoundingClientRect(); frRect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }
      const pool = frRect ? outer.concat([frRect]) : outer;
      const lines = [];
      for (const r of pool) {
        let hit = null;
        for (const L of lines) if (r.top < L.bottom && r.bottom > L.top) { hit = L; break; }
        if (hit) { hit.bottom = Math.max(hit.bottom, r.bottom); hit.left = Math.min(hit.left, r.left); hit.right = Math.max(hit.right, r.right); }
        else lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
      const b = c.getBoundingClientRect();
      const ccs = getComputedStyle(c);
      const padR = parseFloat(ccs.paddingRight) + parseFloat(ccs.borderRightWidth);
      cells.push({
        q: qid, i, text: text.slice(0, 26), lines: lines.length,
        need: Math.round(Math.max(...pool.map(r => r.right)) - Math.min(...pool.map(r => r.left))),
        avail: Math.round(b.width - parseFloat(ccs.paddingLeft) - parseFloat(ccs.paddingRight)
          - parseFloat(ccs.borderLeftWidth) - parseFloat(ccs.borderRightWidth)),
        over: Math.round(b.right - cRight),
        spill: pool.length ? Math.round(Math.max(...pool.map(r => r.right)) - (b.right - padR)) : 0,
        hasFr: !!c.querySelector('.fr'), hasSup: !!c.querySelector('sup'), hasSub: !!c.querySelector('sub'),
      });
    });
  });
  return JSON.stringify({ contentW: Math.round(cRight - cLeft), tables, cells });
})()`;

class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) {
        const p = c.pm.get(m.id); c.pm.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pm.delete(id); rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + method)); }, timeoutMs);
      this.pm.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch { } }
}
function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer(); s.unref(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* 一次 CDP 会话量一批（CSS 变体 → 结果）；变体之间换页重新加载。
 * 夹具走 E.allocTempDir（统一登记 + 退出时切除 + 被杀后由清扫表认领）。 */
async function measureAll(variants, bodyHtml) {
  const edge = findEdge();
  if (!edge) return { skipped: true };
  const dir = E.allocTempDir('gn-mathnowrap-');
  try {
    const CDP_PORT = await freePort();
    const profile = path.join(dir, 'edge-profile');
    const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
      '--window-size=' + PAGE_CONTENT_W + ',1600', 'about:blank'], { stdio: 'ignore' });
    let home = null;
    for (let i = 0; i < 60 && !home; i++) {
      try { const ts = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json(); home = ts.find(t => t.type === 'page'); } catch { }
      if (!home) await sleep(500);
    }
    if (!home) { try { proc.kill(); } catch { } return { error: 'Edge 调试口未就绪' }; }
    const cdp = await Cdp.connect(home.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    const out = {};
    try {
      for (const [name, cssText] of Object.entries(variants)) {
        fs.writeFileSync(path.join(dir, 'app.css'), cssText);
        const pageFile = path.join(dir, 'page-' + name + '.html');
        fs.writeFileSync(pageFile,
          '<!doctype html><html><head><meta charset="utf-8">'
          + '<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="app.css">'
          + '<style>html,body{margin:0;padding:0;background:#fff}</style>'
          + '</head><body><div id="printArea" class="print-area"><div class="sheet">'
          + bodyHtml
          + '</div></div></body></html>');
        await cdp.send('Emulation.setDeviceMetricsOverride',
          { width: PAGE_CONTENT_W, height: 1600, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.navigate', { url: pathToFileURL(pageFile).href });
        await sleep(1200);
        /* ★ 真正切到打印媒体（--dump-dom 没有这条通道） */
        await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
        await sleep(500);
        try {
          const raw = await cdp.evalJs(MEASURE_JS);
          out[name] = JSON.parse(raw);
        } catch (e) {
          out[name] = { error: String(e && e.message || e) };
        }
      }
    } finally {
      cdp.close(); try { proc.kill(); } catch { }
    }
    return { out };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
}

const SYN_BODY = '<div class="q-wrap" data-q="T9101">' + htmlT1 + '</div>'
  + '<div class="q-wrap" data-q="T9102">' + htmlT2 + '</div>';

(async () => {
console.log('\n═══ C. headless Edge 打印媒体真排版 ═══');
/* 变异体（每条都是**能复现原缺陷**的负对照）：
 *   real    = 当前 app.css（修复后）
 *   restore = 恢复改前原状（.sheet 打印内边距 16mm + 格内留白 12px + 无 min-width/nowrap）
 *             ⇒ M0066 形状的格必须重新折行、表格必须重新溢出
 *   pad16   = 只把 .sheet 打印内边距改回 16mm ⇒ 内容区必须重新变窄（证明重复扣边距是真因） */
const restore = CSS
  .replace(/@media print\{\.sheet\{padding:0\}\}/, '@media print{.sheet{padding:16mm 16mm 18mm}}')
  .replace(/\.sheet \.q-stem th,\.sheet \.q-stem td\{padding:2px 8px\}/,
    '.sheet .q-stem th,.sheet .q-stem td{padding:2px 12px}')
  .replace(/^\.sheet \.q-stem td:has\(\.fr\)[^\n]*\{[^}]*\}\s*$/m, '');
const padBack = CSS.replace(/(@media print\{[^}]*\.sheet\{[^}]*padding:\s*)0(\s*[;}])/, '$116mm$2');
const variants = { real: CSS };
if (restore !== CSS) variants['restore'] = restore;
if (padBack !== CSS) variants['pad16'] = padBack;

const res = await measureAll(variants, SYN_BODY);
if (res.skipped) {
  SKIP('C/D 两段真排版实测', '本机没找到 msedge.exe（A/B 段的源码级判据仍生效）');
} else if (res.error) {
  A('C 真排版实测可运行', false, res.error);
} else {
  const g = res.out['real'];
  if (!g || g.error) A('C 真排版实测可运行', false, (g && g.error) || '无结果');
  else {
    /* 打印态题干内容区：.sheet 内边距归零后应 ≈ 673px（= @page 内容区宽）；
     * 若还是 ~542px ⇒ .sheet 的重复内边距没去掉。 */
    A('C0 打印态题干内容区 = @page 内容区宽（≥640px，说明 .sheet 没再二次扣边距）',
      g.contentW >= 640, 'contentW=' + g.contentW);
    const mathCells = g.cells.filter(x => x.hasFr);
    const brokenMath = mathCells.filter(x => x.lines > 1);
    A('C1 含分数的格 0 折行（M0066 同形：分数表达式必须一行）',
      brokenMath.length === 0, brokenMath.length ? JSON.stringify(brokenMath) : '共 ' + mathCells.length + ' 个含分数格');
    const overT = g.tables.filter(t => t.over > 0);
    A('C2 表格 0 溢出纸面', overT.length === 0, overT.length ? JSON.stringify(overT) : '');
    const spill = g.cells.filter(x => x.spill > 1);
    A('C3 0 横向溢出本格（nowrap 不得把内容顶到邻格）', spill.length === 0, spill.length ? JSON.stringify(spill) : '');
    /* 散文格：库里的散文格**没有**分数标记（实测扫描：含 .fr 的 14 个格全是纯数学，
       散文格走的是普通 <td>）⇒ 散文格必须仍能折行。
       合成卡 T9102 那个格**故意**同时含散文与分数 ⇒ 它是「最坏情况」：
       nowrap 作用在它上面 ⇒ 不许把格撑爆纸面（over 必须 ≤ 0、spill 必须 ≤ 1）。 */
    const prose = g.cells.find(x => x.q === 'T9102' && /说明文字/.test(x.text));
    A('C4 最坏情况（散文 + 分数）不溢出纸面、也不顶出本格',
      !prose || (prose.over <= 0 && prose.spill <= 1), prose ? JSON.stringify(prose) : '未找到该格');

    console.log('\n═══ D. 阴性自证（把修复撤掉必须复现缺陷） ═══');
    /* D1：撤掉整条修复（恢复改前原状）⇒ M0066 形状的格必须重新折行 */
    const d1 = res.out['restore'];
    if (!d1) A('D1 变异源码就位（能撤掉本次修复）', false, '没匹配到本次改动的三条规则');
    else if (d1.error) A('D1 阴性自证可运行', false, d1.error);
    else {
      const b1 = d1.cells.filter(x => x.hasFr && x.lines > 1);
      A('D1 撤掉修复 ⇒ 含分数的格必须重新折行（证明断言活着）',
        b1.length > 0, b1.length ? JSON.stringify(b1) : '撤掉后仍 0 折行 ⇒ 断言恒真');
      /* D1b「表格重新溢出」放在 E 段做（合成卡内容太窄，本来就不会溢出；
         真库里的 M0004/C0011 才会溢出——用真数据做这条负对照更强）。 */
    }
    /* D2：只把 .sheet 打印内边距改回 16mm ⇒ 内容区必须重新变窄 */
    const d2 = res.out['pad16'];
    if (!d2) A('D2 变异源码就位（把打印态 .sheet 内边距改回 16mm）', false, '没匹配到 @media print 的 .sheet padding:0');
    else if (d2.error) A('D2 阴性自证可运行', false, d2.error);
    else {
      A('D2 内边距改回 16mm ⇒ 内容区必须重新变窄（证明 .sheet 重复扣边距是真因）',
        d2.contentW < g.contentW - 20,
        'contentW=' + d2.contentW + '（修复后 ' + g.contentW + '）');
    }
  }
}

/* ---------- E. 全库体检（对着真库） ---------- */
console.log('\n═══ E. 全库体检（真库里所有含表格的卡） ═══');
let libCards = [];
try {
  const st = JSON.parse(rdAbs(path.join(E.LIB, '_状态.json')).replace(/^\uFEFF/, ''));
  M.applyState(st);
  libCards = M.cards.filter(x => x.card && x.card.stemHtml && /<table/i.test(String(x.card.stemHtml)));
} catch (e) {
  SKIP('E 全库体检', '读不到库状态：' + String(e && e.message || e));
}
if (libCards.length) {
  const body = libCards.map(x =>
    '<div class="q-wrap" data-q="' + x.kid + '|' + x.subject + '|' + x.card.id + '">' + qHtml(x, 0, 'stem') + '</div>'
  ).join('');
  /* E 段自带阴性自证：同一批真库卡片，用「撤掉修复」的 CSS 再量一遍。
   * 合成卡证明不了「表格重新溢出」（它内容太窄），真库里的 M0004/C0011 才溢出。 */
  const lib = await measureAll({ real: CSS, restore: restore }, body);
  if (lib.skipped) SKIP('E 全库体检', '本机没找到 msedge.exe');
  else if (lib.error) A('E 全库体检可运行', false, lib.error);
  else {
    const g = lib.out['real'];
    if (!g || g.error) A('E 全库体检可运行', false, (g && g.error) || '无结果');
    else {
      const mathCells = g.cells.filter(x => x.hasFr);
      const brokenAll = mathCells.filter(x => x.lines > 1);
      A('E1 真库 ' + libCards.length + ' 张含表格的卡：含分数的格 0 折行',
        brokenAll.length === 0, brokenAll.length ? JSON.stringify(brokenAll) : '共 ' + mathCells.length + ' 个含分数格');
      const overAll = g.tables.filter(t => t.over > 0);
      A('E2 真库：表格 0 溢出纸面', overAll.length === 0, overAll.length ? JSON.stringify(overAll) : '');
      const spillAll = g.cells.filter(x => x.spill > 1);
      A('E3 真库：0 横向溢出本格', spillAll.length === 0, spillAll.length ? JSON.stringify(spillAll.slice(0, 5)) : '');
      /* E4 阴性自证（真数据）：撤掉修复 ⇒ 必须重新量出「M0066 那个格折行」+「表格溢出纸面」 */
      const r = lib.out['restore'];
      if (!r || r.error) A('E4 阴性自证可运行', false, (r && r.error) || '无结果');
      else {
        const b4 = r.cells.filter(x => x.hasFr && x.lines > 1);
        A('E4 撤掉修复 ⇒ 真库里含分数的格必须重新折行（M0066 就是这一格）',
          b4.length > 0, b4.length ? JSON.stringify(b4.slice(0, 3)) : '撤掉后仍 0 折行 ⇒ 断言恒真');
        const o4 = r.tables.filter(t => t.over > 0);
        A('E4b 撤掉修复 ⇒ 真库里必须有表格重新溢出纸面（证明「边距扣两遍」是真因）',
          o4.length > 0, o4.length ? JSON.stringify(o4) : '撤掉后仍不溢出 ⇒ 溢出另有他因');
      }
    }
  }
}

console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL(' + fail + ')') + '  断言=' + (pass + fail) + ' 失败=' + fail);
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('EXC ' + (e && e.stack || e)); process.exit(1); });
