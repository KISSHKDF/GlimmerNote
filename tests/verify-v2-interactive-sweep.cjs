#!/usr/bin/env node
/**
 * 错题本 2.0 · 交互元素穷举扫描（真实桌面壳 CDP 9223 / file:// 通道）—— 2026-10-11
 *
 * 来由（上一轮教训的直接延续）：「只要还有没被点过的按钮，就可能还有一条没被走过的崩溃路径。」
 * 既有 `verify-v2-route-cta.cjs` 只覆盖 `[data-a]|[data-go]|[data-anchor]|[data-pend]` 这四类
 * **路由型**按钮（17 个），完全没碰：筛选 chip、排序 select、全选进篮、抽屉开关、灯箱、
 * 命令面板(Ctrl+K)、主题切换、学生分段、搜索框、待办的办结/作废、组卷的生成/打印、统计的按钮……
 * 本轮把这些**全部**点一遍，每点一次断言三条：
 *   ① `#view` 内不出现「视图渲染出错 / 界面出错」文本；
 *   ② 无未捕获异常（`Runtime.exceptionThrown`）；
 *   ③ **无 console.error / console.warning**（递归吞栈那类 bug 只在这里露头）。
 *
 * ⚠ 安全红线：绝不真落库。跑前把写通道全部替换为记录型 no-op：
 *   `CTB.host.mark` / `CTB.host.regen` / `CTB.host.pendingResolve` / `CTB.host.pendingAdd`
 *   / `CTB.host.openFile` / `CTB.host.reveal` / `CTB.host.quit` / `window.print` / `confirm`
 *   / `CTB.host.print` / `CTB.host.pdf`（2026-10-11 补：打印/存 PDF 走宿主通道后会**阻塞式弹框**，不打桩必卡门禁）
 *   / 带 download 的 `<a>.click()` / `navigator.clipboard.writeText`。
 *   跑完对 8 个真源文件做 SHA256 前后比对（比 `git status` 更强的证据）。
 *
 * ⚠ 状态隔离（L-405）：壳的 WebView2 user-data-dir 是**持久**的。跑前快照 localStorage →
 *   把 `ctb2.filters` 复位到中性 → 跑完**原样还原**并断言「与快照逐字节一致」。
 *   连跑两次必须都稳定（L-405 的强制点）。
 *
 * 用法：`node tests\verify-v2-interactive-sweep.cjs`（先 `node tests\launch-dev.cjs`）
 * 壳不在 ⇒ 打印 `RESULT=SKIP`，exit 0（**不是**静默通过）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
/* ★ 2026-10-12：单次 CDP 调用超时（基础设施缺陷修复）。
   原 send() 挂上 pending 就永远不超时，而 evalJs 用 awaitPromise:true ——
   页面里只要有一个卡住的 Promise，整条门禁就无限期挂住（实测卡过 20~40 分钟，只能人工 kill）。
   门禁必须永远能自己跑完。覆盖：CTB_CDP_TIMEOUT（毫秒，默认 20000）。 */
function cdpTimeout() { const v = Number(process.env.CTB_CDP_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 20000; }
const PORT = +(process.env.CTB_CDP_PORT || 9223);
const BASE = 'http://127.0.0.1:' + PORT;
const OUT_SHOTS = path.join(ROOT, '_probe', 'sweep-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* 单次 CDP 调用超时（可由 CTB_CDP_TIMEOUT 覆盖，毫秒）。见 send() 处注释。 */

const dec = u => { try { return decodeURIComponent(u || ''); } catch { return u || ''; } };

let fails = 0, asserts = 0, skips = 0, clicks = 0, gone = 0;
const A = (n, ok, d) => { asserts++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 260) : ''}`); if (!ok) fails++; };
const S = (n, why) => { skips++; console.log(`[SKIP] ${n}  → ${why}`); };

/* ---------------- 真源指纹（比 git status 更强的证据） ---------------- */
/* ★ 2026-10-24 B-09 顺手修一个既有缺陷：这里原先写死两个真实库索引路径，且用仓库根（ROOT）
   去拼——程序与数据分家（2026-10-23）后这些路径在仓库里根本不存在 ⇒ 恒 'MISSING' ⇒
   前后一致是**假绿**（指纹根本没在算）。现在改用库根 E.lib() + findIndexes 动态发现，
   'MISSING' 只该出现在"库里本来就没有这个台账"的场景。 */
const TRUTH = [
  '_组卷台账.json', '_待确认.json', '_原卷台账.json', '_配图台账.json', '_盲解双路.json',
  ...E.findIndexes(), '_状态.json',
];
function truthFingerprint() {
  const o = {};
  for (const rel of TRUTH) {
    try { o[rel] = crypto.createHash('sha256').update(fs.readFileSync(E.lib(rel))).digest('hex').slice(0, 12); }
    catch (e) { o[rel] = 'MISSING'; }
  }
  let batches = -1;
  try { batches = (JSON.parse(fs.readFileSync(E.lib('_组卷台账.json'), 'utf8')).batches || []).length; } catch { }
  o['__batches.length'] = batches;
  return o;
}

/* ---------------- CDP ---------------- */
class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); this.runtime = []; this.log = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连不上')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) { const p = c.pm.get(m.id); c.pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') c.runtime.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
      else if (m.method === 'Runtime.consoleAPICalled') {
        const t = m.params.type;
        if (t === 'error' || t === 'warning' || t === 'assert') {
          c.runtime.push(t + ' :: ' + (m.params.args || []).map(a => (a.value != null ? a.value : (a.description || a.type || ''))).join(' ').slice(0, 400));
        }
      } else if (m.method === 'Log.entryAdded') c.log.push(m.params.entry.level + ' ' + String(m.params.entry.text || '').slice(0, 200));
    };
    return c;
  }
  /* ★ 2026-10-12 加超时（基础设施缺陷修复）：
       原实现 `new Promise(...)` 挂上 pending 就**永远不超时**。
       而 evalJs 用 `awaitPromise: true` —— 页面里只要有一个卡住的 Promise
       （定时器没清、事件没触发、网络悬挂），整条链就无限期等待，
       实测两次各卡 20~40 分钟，门禁只能靠人工 kill。
       这与「断言红不红」无关，是**脚本自己挂住**——门禁必须永远能自己跑完。
       规则：单次 CDP 调用超过 `cdpTimeout()`（默认 20s，可由 CTB_CDP_TIMEOUT 覆盖）即抛错并中止扫描。 */
  send(m, params = {}, timeoutMs = cdpTimeout()) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const entry = { res, rej };
      const timer = setTimeout(() => {
        this.pm.delete(id);
        rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + m));
      }, timeoutMs);
      entry.res = v => { clearTimeout(timer); res(v); };
      entry.rej = e => { clearTimeout(timer); rej(e); };
      this.pm.set(id, entry);
      try { this.ws.send(JSON.stringify({ id, method: m, params })); }
      catch (e) { clearTimeout(timer); rej(e); }
    });
  }
  async evalJs(e) {
    // 页面内 Promise 最多给 15s（比外层略短，好留时间做清理与报错）
    const r = await this.send('Runtime.evaluate',
      { expression: e, returnByValue: true, awaitPromise: true }, Math.min(cdpTimeout(), 15000));
    if (r.exceptionDetails) throw new Error('eval 抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch { } }
}

/* ---------------- 页面内助手（每次 reload 后必须重装） ---------------- */
const SEL = [
  'button', 'a[href]', '[role=button]', 'input', 'select', 'textarea', 'label.sw', '[onclick]',
  '[data-a]', '[data-go]', '[data-anchor]', '[data-pend]', '[data-code]', '[data-risk]', '[data-card]',
  '[data-print]', '[data-v]', '.chip', '.lrow', '.nav-item',
  '[data-ask]', '[data-auto]', '[data-rm]', '[data-basket]', '[data-grade]', '[data-solve]', '[data-void]',
  '[data-copy]', '[data-zoom]', '[data-open]', '[data-k]', '[data-r]', '[data-s]', '[data-w]', '[data-i]',
  '[data-lbsolve]', '[data-lbvoid]',
].join(',');

const HELPERS = `
window.__SWSEL = ${JSON.stringify(SEL)};
window.__SWKEY = function (el) {
  var d = []; try { for (var k in el.dataset) d.push(k + '=' + el.dataset[k]); } catch (e) { }
  d.sort();
  var t = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 28);
  var v = ''; try { if (el.value != null) v = String(el.value).slice(0, 24); } catch (e) { }
  var cn = String(el.className || '').split(/\\s+/).filter(Boolean).sort().join('.');
  return el.tagName + '|' + (el.id || '') + '|' + cn + '|' + d.join(',') + '|' + t + '|' + v;
};
window.__SWCOLLECT = function (rootSel, sel) {
  var out = [];
  var roots = [].slice.call(document.querySelectorAll(rootSel));
  roots.forEach(function (r) {
    var cand = [];
    if (r.matches && r.matches(sel)) cand.push(r);
    cand = cand.concat([].slice.call(r.querySelectorAll(sel)));
    cand.forEach(function (e) { if (out.indexOf(e) < 0) out.push(e); });
  });
  return out.filter(function (e) { return !(e.tagName === 'INPUT' && e.type === 'hidden'); });
};
window.__SWENUM = function (rootSel, sel) {
  var seen = {}, out = [], nodes = window.__SWCOLLECT(rootSel, sel);
  nodes.forEach(function (e) {
    var k = window.__SWKEY(e), o = (seen[k] || 0); seen[k] = o + 1;
    var r = e.getBoundingClientRect();
    var kind = 'click';
    if (e.tagName === 'SELECT') kind = 'select';
    else if (e.tagName === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio')) kind = 'toggle';
    else if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') kind = 'type';
    out.push({ k: k, o: o, tag: e.tagName, kind: kind, disabled: !!e.disabled,
      invisible: (r.width === 0 && r.height === 0),
      text: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26) });
  });
  return out;
};
/* 一步：keep=false 时先关浮层/清会话/回视图/复位模块态；随后同步找到目标并交互。 */
window.__SWSTEP = function (opts) {
  function id(x) { return document.getElementById(x); }
  if (!opts.keep) {
    try { if (id('drawerWrap') && !id('drawerWrap').hidden) CTB.shell.closeDrawer(); } catch (e) { }
    try { if (id('lightbox') && !id('lightbox').hidden) CTB.shell.closeLightbox(); } catch (e) { }
    try { if (id('paletteWrap') && !id('paletteWrap').hidden) CTB.shell.closePalette(); } catch (e) { }
    try { CTB.model.session = null; } catch (e) { }
    try {
      var nav = [].slice.call(document.querySelectorAll('.nav-item[data-r]')).filter(function (e) { return e.dataset.r === opts.view; })[0];
      if (nav) nav.click();
    } catch (e) { }
    try {
      if (opts.view === 'paper') CTB.shell.route('paper', { reset: true });
      if (opts.reset === 'bank') { var rb = id('bkReset'); if (rb) rb.click(); }
      if (opts.reset === 'pending') {
        var a1 = [].slice.call(document.querySelectorAll('#view [data-ask]')).filter(function (e) { return e.dataset.ask === '全部'; })[0];
        if (a1) a1.click();
        var c2 = [].slice.call(document.querySelectorAll('#view #pdKinds .chip')).filter(function (e) { return e.dataset.v === '全部'; })[0];
        if (c2) c2.click();
        var d2 = id('pdDone'); if (d2 && d2.checked) { d2.checked = false; d2.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      if (opts.reset === 'review') {
        /* ⚠ 这里故意不点 #rvSrc：该 seg 的 onclick 是 src=...; draw()，绕过 setup() 里的
           到期池为空则自动切 all ⇒ 点了 due 就把界面钉死在 0 题空态（run2 dump 实证）。
           只写 LS=due，让 setup() 自己按池子自动选题源。 */
        var j1 = [].slice.call(document.querySelectorAll('#view #rvSj .chip')).filter(function (e) { return (e.textContent || '').trim() === '全部'; })[0];
        if (j1) j1.click();
      }
    } catch (e) { }
  }
  var nodes = window.__SWCOLLECT(opts.root, window.__SWSEL);
  var seen = {}, hit = null;
  for (var i = 0; i < nodes.length; i++) {
    var e = nodes[i], k = window.__SWKEY(e), o = (seen[k] || 0); seen[k] = o + 1;
    if (k === opts.key && o === opts.occ) { hit = e; break; }
  }
  if (!hit) return 'gone';
  if (hit.disabled) return 'disabled';
  var r = hit.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return 'invisible';
  var tag = hit.tagName, ty = (hit.type || '');
  var fire = function (t) { try { hit.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) { } };
  if (tag === 'SELECT') { if (hit.options.length > 1) hit.selectedIndex = (hit.selectedIndex + 1) % hit.options.length; fire('change'); return 'select'; }
  if (tag === 'INPUT' && (ty === 'checkbox' || ty === 'radio')) { hit.click(); return 'toggle'; }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    try { hit.focus(); } catch (e) { }
    hit.value = (ty === 'number' ? '5' : 'SWEEP测试');
    fire('input'); fire('change');
    return 'type';
  }
  hit.click();
  return 'click';
};
window.__SWPROBE = function () {
  var v = document.getElementById('view');
  var t = v ? v.textContent : '';
  var m = t.match(/(视图渲染出错|界面出错|Cannot read propert|is not a function|undefined is not|Maximum call stack)[^\\n]{0,140}/);
  return JSON.stringify({ err: m ? m[0].replace(/\\s+/g, ' ').slice(0, 180) : '', len: v ? v.innerHTML.length : -1 });
};
window.__SWCLEAN = function () {
  try { if (!document.getElementById('drawerWrap').hidden) CTB.shell.closeDrawer(); } catch (e) { }
  try { if (!document.getElementById('lightbox').hidden) CTB.shell.closeLightbox(); } catch (e) { }
  try { if (!document.getElementById('paletteWrap').hidden) CTB.shell.closePalette(); } catch (e) { }
  try { CTB.model.session = null; } catch (e) { }
  return 1;
};
1;
`;

/* ---------------- 打桩（写通道） ---------------- */
const STUB = `
window.__SWSTUB = { calls: [], n: 0, dl: 0, confirms: 0, prints: 0 };
(function () {
  var S = window.__SWSTUB;
  function rec(op, arg) { S.n++; S.calls.push(op + (arg === undefined ? '' : ':' + String(arg).slice(0, 60))); }
  var clone = function () { try { return JSON.parse(JSON.stringify(CTB.model.state)); } catch (e) { return null; } };
  /* 唯一写通道（组卷/批改/撤批/归档/状态）→ 返回合法形状，并给出可解析的批次号，
     让上层走完它的完整分支（比单纯 null 覆盖更多行，同时零写盘）。 */
  CTB.host.mark = function (action, flags) { rec('mark', action); return Promise.resolve({ code: 0, out: 'SWEEP-STUB ' + (action || '') + ' P20261011-01 已生成（打桩，未写盘）' }); };
  CTB.host.regen = function () { rec('regen'); return Promise.resolve(clone()); };
  CTB.host.pendingResolve = function (rs) {
    rec('pendingResolve', (rs || []).length);
    return Promise.resolve({ ok: true, results: (rs || []).map(function (r) { return { id: r.id, status: 'ok' }; }), state: clone() });
  };
  CTB.host.pendingAdd = function (f) { rec('pendingAdd', (f && f.student) || ''); return Promise.resolve({ ok: true, newId: 'TSWEEP9', state: clone() }); };
  CTB.host.openFile = function (p) { rec('openFile', p); return Promise.resolve({ ok: true }); };
  CTB.host.reveal = function (p) { rec('reveal', p); return Promise.resolve({ ok: true }); };
  CTB.host.quit = function () { rec('quit'); return Promise.resolve({ ok: true }); };
  if (CTB.shell && CTB.shell.regenBackground) {
    var _rb = CTB.shell.regenBackground;
    CTB.shell.regenBackground = function () { rec('regenBackground'); return _rb.apply(this, arguments); };
  }
  window.print = function () { S.prints++; rec('print'); };
  /* ⚠ 2026-10-11 补：打印/存 PDF 已改为**宿主通道**（H.print → op=print → ShowPrintUI；H.pdf → PrintToPdfAsync）。
     只打桩 window.print 已经不够 —— 扫描点到「🖨 打印试卷/答案册」会真弹系统打印对话框，
     那是**阻塞式**的，会把整条门禁卡住（实测被用户手工点掉才恢复）。
     所以这两个通道也必须打桩：打印=记一次调用并假装成功；存 PDF=假装成功且不落盘。 */
  CTB.host.print = function (kind) { rec('print', kind || 'system'); return Promise.resolve({ ok: true, mode: 'showprintui', kind: kind || 'system' }); };
  CTB.host.pdf = function (rel) { rec('pdf', rel); return Promise.resolve({ ok: true, path: rel, bytes: 0 }); };
  window.confirm = function (m) { S.confirms++; rec('confirm', String(m || '').slice(0, 40)); return true; };
  window.alert = function (m) { rec('alert', String(m || '').slice(0, 40)); };
  try { navigator.clipboard.writeText = function () { rec('clipboard'); return Promise.resolve(); }; } catch (e) { }
  try { URL.createObjectURL = function () { rec('createObjectURL'); return 'blob:SWEEP-STUB'; }; } catch (e) { }
  try { URL.revokeObjectURL = function () { }; } catch (e) { }
  /* 只拦「带 download 的 a」——普通 a[data-go] 的 click 必须原样放行（否则覆盖不到路由） */
  try {
    var _ac = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute && this.hasAttribute('download')) { S.dl++; rec('download', this.getAttribute('download')); return; }
      return _ac.apply(this, arguments);
    };
  } catch (e) { }
})();
1;
`;

/* ---------------- 主流程 ---------------- */
(async () => {
  let pg = null;
  try {
    const list = await (await fetch(BASE + '/json/list')).json();
    pg = list.find(t => E.isAppUrl(dec(t.url)) && t.type === 'page');
  } catch (e) { }
  if (!pg) {
    S('交互穷举扫描', `CDP ${PORT} 上没有 v2 页面（真实桌面壳没跑）。先 node tests\\launch-dev.cjs 再跑本脚本。`);
    console.log(`\nRESULT=SKIP 断言=0 跳过=${skips}`);
    process.exit(0);
  }

  fs.mkdirSync(OUT_SHOTS, { recursive: true });
  const c = await Cdp.connect(pg.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('Log.enable');

  /* ══ 崩溃兜底（★ 2026-10-23 加，真实事故）══
     本测试会把 CTB.host.mark/regen/print/pdf、window.confirm、a[download].click 全换成打桩函数。
     这些桩是**页面全局变量**，原本只有走到最后的第 7 段才会 Page.reload 复位。
     实测（run7）：扫描在第 6 段末尾 `Runtime.evaluate` 超时崩溃 ⇒ 复位段没跑 ⇒ 桩留在页面上，
     紧随其后的 e2e-writepath 拿到的全是 "SWEEP-STUB …（打桩，未写盘）" 的假结果，
     于是把"写路径坏了"报成三条 FAIL —— 一次崩溃把后面整条门禁的可信度全毁了。
     修法：崩溃/异常/信号一律先**重载页面**（reload 清空所有页面全局，桩自然消失），再退出。
     注意只做 reload，不动 localStorage —— 那是用户态，只有正常路径的第 7 段有权还原。 */
  let SWEEP_DONE = false;
  const unstub = async (why) => {
    if (SWEEP_DONE) return;
    SWEEP_DONE = true;
    try {
      await c.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 2500));
      console.log(`[兜底] 异常退出（${why}）→ 已重载页面清掉打桩，避免污染后续测试`);
    } catch (e) { console.log('[兜底] 重载失败：' + (e && e.message)); }
  };
  process.on('uncaughtException', async (e) => { await unstub('uncaught ' + (e && e.message)); console.log('EXC ' + (e && e.stack || e)); process.exit(3); });
  process.on('unhandledRejection', async (e) => { await unstub('rejection ' + (e && e.message)); console.log('EXC ' + (e && e.stack || e)); process.exit(3); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await unstub('signal ' + sig); process.exit(130); });

  const BEFORE = truthFingerprint();
  const findings = [];
  const stats = {};
  const B = (scope) => stats[scope] || (stats[scope] = { total: 0, clicked: 0, skipDis: 0, skipInv: 0, gone: 0, problems: 0 });

  console.log('通道 =', E.isFileAppUrl(dec(pg.url)) ? '真实桌面壳 file:// ✔' : pg.url);
  console.log('URL  =', dec(pg.url).slice(0, 110));

  /* ---- 0 强制重载（壳是启动时把 js 读进内存的；不重载就测旧代码） ---- */
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(4200);
  await c.evalJs(HELPERS);

  const vp = JSON.parse(await c.evalJs(`JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,sw:screen.width,sh:screen.height})`));
  console.log('== 0 真实壳视口 ==', JSON.stringify(vp));
  A('走 file:// 真实壳通道（不是本机服务端）', E.isFileAppUrl(dec(pg.url)), dec(pg.url));
  A('宿主模式 = shell', (await c.evalJs(`String(CTB.host.mode)`)) === 'shell', await c.evalJs(`String(CTB.host.mode)`));
  /* ★ 2026-10-12 判据重写：原为 `A('真实 CSS 视口 = 1536×808（1500 壳宽 + 最大化 + 系统 125%）', vp.w === 1536 && vp.h === 808)`
     与 `A('DPR = 1.25', Math.abs(vp.dpr-1.25)<0.01)` —— 同样是写死了**当年那台机器**的分辨率与缩放，
     换机器必红 ⇒ 门禁长期红 = 失去门禁作用。改为跨机器成立的不变量。
     ⚠⚠ 第二版又踩了一个坑，一并记下：`screen.width` 在 Chromium 里**已经是 CSS 像素**
     （本机实测 screen.width=2458 == innerWidth=2458；Windows 报的物理分辨率是 3072 = 2458×1.25）。
     所以"有没有把设备像素当 CSS 像素"**不能**写成 `w ≈ screen.width / dpr` ——
     我第一版就这么写，又造出一条恒红断言（期望 1966 vs 实际 2458）。
     正确判法：dpr 在常见档位 + 物理像素落在常见桌面分辨率区间。
      ⚠⚠ 连踩两坑（写下来免得再犯）：坑1 `screen.width` 已是 CSS 像素（2458==2458，物理 3072=2458×1.25）
      ⇒ 不能写 `w ≈ screen.width/dpr`（我第一版的错）；坑2 物理像素不能要求 8 的倍数
      （CSS 宽取整过，2458×1.25=3072.5，我第二版的错）。 */
  const phys = Math.round(vp.sw * vp.dpr);
  A('★ CSS 视口宽 ≤ 屏幕宽', vp.w <= vp.sw + 1, `w=${vp.w} screen=${vp.sw}`);
  A('★ dpr 落在常见系统缩放档位（本机实测，不写死）', [1, 1.25, 1.5, 1.75, 2].some(x => Math.abs(vp.dpr - x) < 0.01), `dpr=${vp.dpr}`);
  A('★ 物理像素自洽：screen.width(CSS) × dpr 落在常见桌面分辨率区间',
    phys >= 1280 && phys <= 8192, `物理像素≈${phys}（${vp.sw} × ${vp.dpr}）`);
  /* 自证条（⚠ 上次写成恒真，教训见 L-422）：
     断言的是"错误的 dpr 不该满足主判据"，不是"错误的 dpr 该满足"。
     写法必须是 inTier(坏值)===false && inTier(实测值)===true —— 这样才既证明有牙齿、又能真绿。 */
  const inTier = d => [1, 1.25, 1.5, 1.75, 2].some(x => Math.abs(d - x) < 0.01);
  const physOk = d => { const x = Math.round(vp.sw * d); return x >= 1280 && x <= 8192; };
  /* ⚠ 2026-10-16 修：坏值原先用 4.0 —— 在写测试的那台 2458 CSS 宽屏上 4.0×2458=9832>8192 超界成立，
     但在 1536 CSS 宽的机器上 4.0×1536=6144<8192 **仍在界内** ⇒ 断言恒红（又一个"写死当年机器"的坑）。
     改用 10.0：任何 ≥820 CSS px 的真实桌面屏都超界（1024×10=10240>8192），跨机器成立。 */
  A('★ 自证 · 判据有牙齿（错误 dpr 不满足档位与区间判据）',
    inTier(1.3) === false && inTier(10.0) === false && physOk(10.0) === false
    && inTier(vp.dpr) === true && physOk(vp.dpr) === true,
    `坏 dpr=1.3/10.0 → 档位 ${inTier(1.3)}/${inTier(10.0)}（应 false），区间 ${physOk(10.0)}（应 false）；实测 dpr=${vp.dpr} → 档位 ${inTier(vp.dpr)}（应 true）区间 ${physOk(vp.dpr)}（应 true）`);

  /* ---- 1 localStorage 状态隔离（L-405） ---- */
  const LS_SNAP = await c.evalJs(`(function(){var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k);}return JSON.stringify(o);})()`);
  const snapObj = JSON.parse(LS_SNAP);
  console.log('== 1 localStorage 快照 ==', Object.keys(snapObj).length, '键：', Object.keys(snapObj).join(', '));
  const wasDirty = (JSON.parse(snapObj['ctb2.filters'] || '{}').blind || '全部') !== '全部';
  await c.evalJs(`(function(){
    try{
      var f=JSON.parse(localStorage.getItem('ctb2.filters')||'{}');
      f.q='';f.subject='全部';f.diff='全部';f.layer='全部';f.state='全部';f.blind='全部';f.code='';f.hasImg=false;f.sort='new';
      localStorage.setItem('ctb2.filters',JSON.stringify(f));
      localStorage.setItem('ctb2.theme',JSON.stringify('light'));
    }catch(e){}
    return 1;})()`);
  console.log('（快照前 ctb2.filters.blind 非中性 =', wasDirty, '；跑前已复位到中性，跑完原样还原）');
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(4000);
  await c.evalJs(HELPERS);
  await c.evalJs(STUB);
  console.log('== 1b 写通道打桩 ==', await c.evalJs(`JSON.stringify({mark:typeof CTB.host.mark,regen:typeof CTB.host.regen,pr:typeof CTB.host.pendingResolve,pa:typeof CTB.host.pendingAdd})`), '| confirm 恒 true（配合打桩，真写路径不可达）');

  /* ---- 通用：单元素一步 ---- */
  async function step(scope, opts, label, pre) {
    if (pre) { await c.evalJs(pre); await sleep(260); }
    const mark = c.runtime.length;
    const status = await c.evalJs(`window.__SWSTEP(${JSON.stringify(opts)})`);
    const st = B(scope);
    if (status === 'gone') { gone++; st.gone++; return status; }
    if (status === 'disabled') { st.skipDis++; return status; }
    if (status === 'invisible') { st.skipInv++; return status; }
    await sleep(opts.kind === 'type' ? 420 : 300);
    clicks++;
    const p = JSON.parse(await c.evalJs(`window.__SWPROBE()`));
    const msgs = c.runtime.slice(mark);
    st.clicked++;
    if (p.err || msgs.length) {
      st.problems++;
      findings.push({ scope, label, status, err: p.err, msgs: msgs.slice(0, 4), len: p.len });
      console.log(`  [问题] ${scope} ${label} (${status})`);
      if (p.err) console.log(`         视图文本: ${p.err}`);
      for (const m of msgs.slice(0, 4)) console.log(`         console : ${String(m).slice(0, 220)}`);
    }
    return status;
  }

  /* ⚠ 枚举前必须先 prep：否则 `#view` 里还是**上一个视图**的 DOM，枚举出来的键全都是错的
     （首版实测：view:review 枚举到 12 个却全部 gone、view:paper 枚举到 266 个 = 题库的行数…… 错位整整一个视图）。
     prep = 关浮层 → 清会话 → 回本视图（paper 带 reset）→ 可选 pre 片段。 */
  async function prepView(view, reset, pre) {
    await c.evalJs(`(function(){
      window.__SWCLEAN();
      CTB.model.session = null;
      var nav=[].slice.call(document.querySelectorAll('.nav-item[data-r]')).filter(function(e){return e.dataset.r===${JSON.stringify(view)}})[0];
      if(nav) nav.click();
      if(${JSON.stringify(view)}==='paper') CTB.shell.route('paper',{reset:true});
      if(${JSON.stringify(reset)}==='bank'){var rb=document.getElementById('bkReset');if(rb)rb.click();}
      if(${JSON.stringify(reset)}==='pending'){
        var a1=[].slice.call(document.querySelectorAll('#view [data-ask]')).filter(function(e){return e.dataset.ask==='全部'})[0];if(a1)a1.click();
        var c2=[].slice.call(document.querySelectorAll('#view #pdKinds .chip')).filter(function(e){return e.dataset.v==='全部'})[0];if(c2)c2.click();
        var d2=document.getElementById('pdDone');if(d2&&d2.checked){d2.checked=false;d2.dispatchEvent(new Event('change',{bubbles:true}));}
      }
      if(${JSON.stringify(reset)}==='review'){
        try{localStorage.setItem('ctb2.rvSj',JSON.stringify('全部'));localStorage.setItem('ctb2.rvSrc',JSON.stringify('due'));localStorage.setItem('ctb2.rvCap',JSON.stringify(15));}catch(e){}
        /* 同上：不点 #rvSrc，让 setup() 自己按池子自动选题源 */
        var j1=[].slice.call(document.querySelectorAll('#view #rvSj .chip')).filter(function(e){return (e.textContent||'').trim()==='全部'})[0];if(j1)j1.click();
      }
      return 1;})()`);
    await sleep(240);
    if (pre) { await c.evalJs(pre); await sleep(320); }
  }
  async function sweep(scope, root, view, reset, extra) {
    extra = extra || {};
    await prepView(view, reset, extra.pre);
    const list = JSON.parse(await c.evalJs(`JSON.stringify(window.__SWENUM(${JSON.stringify(root)}, window.__SWSEL))`));
    const st = stats[scope] = Object.assign(B(scope), { total: list.length, root, view });
    console.log(`\n== ${scope}：可交互元素 ${list.length} 个 ==`);
    if (!list.length) { S(scope, '该范围当前 0 个可交互元素（空态）⇒ 不静默通过'); return; }
    let n = 0;
    for (const it of list) {
      n++;
      await step(scope, { root, view, reset, key: it.k, occ: it.o, kind: it.kind, keep: !!extra.keep }, `${it.tag}「${it.text}」${it.kind}`, extra.pre);
      if (n % 40 === 0) process.stdout.write(`   … ${n}/${list.length}\n`);
    }
    console.log(`   → 已点 ${st.clicked}，禁用 ${st.skipDis}，不可见 ${st.skipInv}，已消失 ${st.gone}，问题 ${st.problems}`);
  }

  /* 预置片段（overlay / 深路径场景：每次迭代都要先把被点掉的屏重新搭起来）。
     ⚠ 一律以 `window.__SWCLEAN()` 起手：先把上一轮点开又被点掉的浮层收干净，
     否则浮层会一层层叠着留下来（`.click()` 是程序化点击，被遮住也照样命中，反而掩盖问题）。 */
  const PRE_CARD_DRAWER = `(async function(){window.__SWCLEAN();CTB.shell.route('bank');await new Promise(function(r){setTimeout(r,60)});var rb=document.getElementById('bkReset');if(rb)rb.click();var rows=[].slice.call(document.querySelectorAll('#view .lrow'));if(rows.length)rows[0].click();await new Promise(function(r){setTimeout(r,120)});return 1})()`;
  const PRE_LIGHTBOX = `(async function(){window.__SWCLEAN();CTB.shell.route('bank');await new Promise(function(r){setTimeout(r,60)});var rb=document.getElementById('bkReset');if(rb)rb.click();var rows=[].slice.call(document.querySelectorAll('#view .lrow'));if(rows.length)rows[0].click();await new Promise(function(r){setTimeout(r,180)});var d=document.getElementById('drawer');var z=d&&d.querySelector('[data-open]');if(z)z.click();else{var b=d&&d.querySelector('#dvImg');if(b)b.click();}await new Promise(function(r){setTimeout(r,300)});return 1})()`;
  const PRE_PEND_LB = `(async function(){window.__SWCLEAN();CTB.shell.route('pending');await new Promise(function(r){setTimeout(r,180)});var z=document.querySelector('#view [data-zoom]');if(z)z.click();await new Promise(function(r){setTimeout(r,400)});return 1})()`;
  const PRE_PEND_ADD = `(async function(){window.__SWCLEAN();CTB.shell.route('pending');await new Promise(function(r){setTimeout(r,180)});var b=document.getElementById('pdAdd');if(b)b.click();await new Promise(function(r){setTimeout(r,280)});return 1})()`;
  const PRE_RV_CARD = `(async function(){window.__SWCLEAN();try{localStorage.setItem('ctb2.rvSj',JSON.stringify('全部'));localStorage.setItem('ctb2.rvSrc',JSON.stringify('due'));localStorage.setItem('ctb2.rvCap',JSON.stringify(15));}catch(e){}CTB.shell.route('review');await new Promise(function(r){setTimeout(r,200)});/* 不点 #rvSrc（见 prepView 注释） */var j=[].slice.call(document.querySelectorAll('#view #rvSj .chip')).filter(function(e){return (e.textContent||'').trim()==='全部'})[0];if(j)j.click();var b=document.getElementById('rvStart');if(b)b.click();await new Promise(function(r){setTimeout(r,280)});return 1})()`;
  const PRE_RV_SUM = `(async function(){window.__SWCLEAN();try{localStorage.setItem('ctb2.rvSj',JSON.stringify('全部'));localStorage.setItem('ctb2.rvSrc',JSON.stringify('due'));localStorage.setItem('ctb2.rvCap',JSON.stringify(15));}catch(e){}CTB.shell.route('review');await new Promise(function(r){setTimeout(r,200)});/* 不点 #rvSrc（见 prepView 注释） */var j=[].slice.call(document.querySelectorAll('#view #rvSj .chip')).filter(function(e){return (e.textContent||'').trim()==='全部'})[0];if(j)j.click();var b=document.getElementById('rvStart');if(b)b.click();await new Promise(function(r){setTimeout(r,220)});var g=0;while(CTB.model.session&&!CTB.model.sessionDone()&&g++<90){var rv=document.getElementById('rvReveal');if(rv)rv.click();await new Promise(function(r){setTimeout(r,25)});var gg=document.querySelector('[data-grade="错"]');if(gg)gg.click();await new Promise(function(r){setTimeout(r,40)});}await new Promise(function(r){setTimeout(r,260)});return 1})()`;
  const PRE_PAPER_COMPOSE = `(async function(){window.__SWCLEAN();CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name);CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,12).map(function(x){return x.kid+'|'+x.card.id}));CTB.shell.route('paper',{reset:true});await new Promise(function(r){setTimeout(r,220)});return 1})()`;
  const PRE_PAPER_PREVIEW = `(async function(){window.__SWCLEAN();CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name);CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,12).map(function(x){return x.kid+'|'+x.card.id}));CTB.shell.route('paper',{reset:true});await new Promise(function(r){setTimeout(r,200)});var b=document.getElementById('pbPrev2')||document.getElementById('ppPrev');if(b&&!b.disabled)b.click();await new Promise(function(r){setTimeout(r,340)});return 1})()`;
  const PRE_PAPER_LEDGER = `(async function(){window.__SWCLEAN();CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name);CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,12).map(function(x){return x.kid+'|'+x.card.id}));CTB.shell.route('paper',{reset:true});await new Promise(function(r){setTimeout(r,200)});var b=document.getElementById('pbLedger2');if(b)b.click();await new Promise(function(r){setTimeout(r,900)});return 1})()`;
  const PRE_PAPER_GRADE = `(async function(){window.__SWCLEAN();CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name);CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,12).map(function(x){return x.kid+'|'+x.card.id}));CTB.shell.route('paper',{reset:true});await new Promise(function(r){setTimeout(r,200)});var b=document.getElementById('pbLedger2');if(b)b.click();await new Promise(function(r){setTimeout(r,900)});var g=document.querySelector('#view [data-grade]');if(g)g.click();await new Promise(function(r){setTimeout(r,340)});return 1})()`;
  const PRE_SINGLE_PREVIEW = `(async function(){window.__SWCLEAN();CTB.shell.route('bank');await new Promise(function(r){setTimeout(r,200)});var p=document.querySelector('#view [data-print]');if(p)p.click();await new Promise(function(r){setTimeout(r,320)});return 1})()`;
  const PRE_HELP = `(async function(){window.__SWCLEAN();CTB.shell.route('dash');CTB.shell.help();await new Promise(function(r){setTimeout(r,200)});return 1})()`;

  /* ---- 2 全局外壳 ---- */
  console.log('\n════════ 2 全局外壳（主题 / 学生分段 / 搜索 / 折叠 / 状态条）════════');
  await sweep('shell', '#topbar,#sidebar,#statusbar', 'dash', null);
  await c.evalJs(`(function(){ if(document.documentElement.dataset.side==='mini'){var b=document.getElementById('btnSide');if(b)b.click();} return 1 })()`);
  /* 学生固定到**第一名孩子**（★ B-09：动态取 state.data[0]，不再写死真实学生名；本机=卡最多、组卷池最深的那名）：范围可控 ⇒ 深路径可达。
     跑完由 localStorage 还原 + reload 复位，不影响用户态。 */
  await c.evalJs(`(function(){ CTB.shell.applyTheme('light'); CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name); CTB.shell.route('dash'); return 1 })()`);
  await sleep(250);

  /* ---- 3 六个视图 ---- */
  console.log('\n════════ 3 六视图 #view 内元素穷举 ════════');
  const VIEWS = [
    { id: 'dash', name: '今日总览', reset: null },
    { id: 'review', name: '复习流', reset: 'review' },
    { id: 'bank', name: '题库浏览', reset: 'bank' },
    { id: 'paper', name: '组卷工作台', reset: null },
    { id: 'pending', name: '待办工作台', reset: 'pending' },
    { id: 'stats', name: '统计分析', reset: null },
  ];
  for (const v of VIEWS) await sweep('view:' + v.id, '#view', v.id, v.reset);

  /* ---- 3b ★ 统计「学科 × 错因层」轴标签几何（肉眼 + DOM 双证据；见 docs §3 问题#2）---- */
  {
    const g = JSON.parse(await c.evalJs(`(async function(){
      window.__SWCLEAN(); CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name); CTB.shell.route('stats');
      await new Promise(function(r){setTimeout(r,700)});
      var card=[].slice.call(document.querySelectorAll('#view .card')).filter(function(e){return /学科 × 错因层/.test(e.textContent||'')})[0];
      if(!card) return JSON.stringify({skip:'no-card'});
      var svg=card.querySelector('svg'), row=svg&&svg.nextElementSibling;
      if(!row) return JSON.stringify({skip:'no-labelrow'});
      var spans=[].slice.call(row.querySelectorAll('span'));
      var rc=card.getBoundingClientRect(), rr=row.getBoundingClientRect();
      var cs=getComputedStyle(row);
      return JSON.stringify({n:spans.length,
        over:Math.round(rr.right-rc.right), rowW:Math.round(rr.width), cardW:Math.round(rc.width),
        pad:cs.paddingLeft+'/'+cs.paddingRight,
        widths:spans.map(function(s){return Math.round(s.getBoundingClientRect().width)}),
        txt:spans.map(function(s){return s.textContent})});
    })()`));
    const st3 = stats['stats:axis-label'] = { total: g.n || 0, clicked: 0, skipDis: 0, skipInv: 0, gone: 0, problems: 0 };
    console.log('\n== stats:axis-label：' + JSON.stringify(g) + ' ==');
    const badW = (g.widths || []).filter(w => w <= 1).length;
    const badOver = (g.over || 0) > 0;
    const okAxis = !g.skip && badW === 0 && !badOver;
    if (!okAxis) {
      st3.problems++;
      findings.push({ scope: 'stats:axis-label', label: 'C.bars 轴标签：单学科时学科名被压成 0 宽（不可见）+ 标签行撑出卡片', status: 'geometry', err: '', msgs: [], len: 0 });
    }
    A('★ 统计「学科×错因层」轴标签：每个学科名可见（宽>1）且标签行不超出卡片（单学科场景）',
      okAxis, JSON.stringify(g));
  }

  /* ---- 4 次级界面 ---- */
  console.log('\n════════ 4 次级界面 ════════');

  /* 4a 卡详情抽屉 */
  const drew = await c.evalJs(PRE_CARD_DRAWER);
  const drawerOpen = await c.evalJs(`document.getElementById('drawerWrap').hidden===false`);
  if (!drawerOpen) S('卡详情抽屉', '题库当前 0 行（学生范围/筛选为空）⇒ 无对象可点');
  else { console.log('  （卡详情抽屉已开）'); await sweep('drawer:card', '#drawer', 'bank', 'bank', { keep: true, pre: PRE_CARD_DRAWER }); }
  await c.evalJs(`window.__SWCLEAN()`);

  /* 4b 灯箱 */
  await c.evalJs(PRE_LIGHTBOX);
  const lbOpen = await c.evalJs(`document.getElementById('lightbox').hidden===false`);
  if (!lbOpen) S('灯箱（原卷/裁图）', '该卡无原卷图与缩略图可点 ⇒ 无对象');
  else {
    console.log('  （灯箱已开 ' + await c.evalJs(`JSON.stringify(CTB.shell.lbState())`) + '）');
    await sweep('lightbox', '#lightbox', 'bank', 'bank', { keep: true, pre: PRE_LIGHTBOX });
    /* ⚠ sweep 的最后一个控件就是 #lbClose ⇒ 跑完灯箱已经关了。不重新打开就断言 = 拿「没对象」当「通过」，
       正是本仓铁律禁止的空真（run1 实测 skip:'not-open'）。 */
    await c.evalJs(PRE_LIGHTBOX); await sleep(450);
    const mk = c.runtime.length;
    const kb = await c.evalJs(`(function(){
      var el=document.getElementById('lightbox');
      if(!el||el.hidden) return JSON.stringify({skip:'not-open'});
      var before=JSON.stringify(CTB.shell.lbState());
      function key(k){ el.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true})); }
      key('p'); var afterP=JSON.stringify(CTB.shell.lbState());
      key('ArrowRight'); key('ArrowLeft'); key('Escape');
      return JSON.stringify({before:before,afterP:afterP,closed:document.getElementById('lightbox').hidden});
    })()`);
    const K = JSON.parse(kb);
    A('★ 灯箱键盘：P 切模式 / ←→ 翻页 / Esc 关闭，全程无异常（灯箱确已重开）', K.before !== undefined && K.closed === true && c.runtime.length === mk, kb + ' | 新消息 ' + (c.runtime.length - mk));
    await c.evalJs(`window.__SWCLEAN()`);
  }

  /* 4c 命令面板 Ctrl+K */
  const palOpened = await c.evalJs(`(function(){ var b=document.getElementById('btnPalette'); if(b){b.click(); return document.getElementById('paletteWrap').hidden===false;} return false; })()`);
  if (!palOpened) S('命令面板 Ctrl+K', '搜索框点击后 paletteWrap 仍 hidden');
  else {
    const items = JSON.parse(await c.evalJs(`(function(){
      var inp=document.getElementById('paletteInput'); inp.value=''; inp.dispatchEvent(new Event('input',{bubbles:true}));
      return JSON.stringify([].slice.call(document.querySelectorAll('#paletteList .p-item')).map(function(e,i){ return {i:i,t:(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,26)}; }));
    })()`));
    console.log(`  （命令面板已开，导航项 ${items.length} 条；逐条点击）`);
    stats['palette'] = { total: items.length, clicked: 0, skipDis: 0, skipInv: 0, gone: 0, problems: 0 };
    for (const it of items) {
      const mk = c.runtime.length;
      const stt = await c.evalJs(`(async function(){
        CTB.shell.palette();
        var list=[].slice.call(document.querySelectorAll('#paletteList .p-item'));
        var e=list[${it.i}]; if(!e) return 'gone';
        e.click(); await new Promise(function(r){setTimeout(r,120)}); return 'click';
      })()`);
      const ps = stats['palette'];
      if (stt === 'gone') { gone++; ps.gone++; continue; }
      await sleep(350); clicks++; ps.clicked++;
      const p = JSON.parse(await c.evalJs(`window.__SWPROBE()`));
      const msgs = c.runtime.slice(mk);
      if (p.err || msgs.length) { ps.problems++; findings.push({ scope: 'palette', label: `命令「${it.t}」`, status: stt, err: p.err, msgs: msgs.slice(0, 4), len: p.len }); console.log(`  [问题] palette 「${it.t}」 ${p.err} ${msgs.join(' | ').slice(0, 200)}`); }
    }
    const mk2 = c.runtime.length;
    const typ = await c.evalJs(`(async function(){
      var out=[];
      function open(){ CTB.shell.palette(); }
      function type(q){ var inp=document.getElementById('paletteInput'); inp.value=q; inp.dispatchEvent(new Event('input',{bubbles:true})); return [].slice.call(document.querySelectorAll('#paletteList .p-item')).length; }
      function key(k){ document.getElementById('paletteInput').dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true})); }
      open(); out.push(['空态条目',type('')]);
      out.push(['搜「题」',type('题')]);
      out.push(['搜「数学」',type('数学')]);
      out.push(['搜「P0012」',type('P0012')]);
      out.push(['> 命令',type('>')]);
      out.push(['>复',type('>复')]);
      key('ArrowDown'); key('ArrowDown'); key('ArrowUp');
      out.push(['方向键后仍开', document.getElementById('paletteWrap').hidden===false]);
      key('Escape'); out.push(['Esc 关', document.getElementById('paletteWrap').hidden===true]);
      open(); type('数学'); key('Enter'); await new Promise(function(r){setTimeout(r,350)});
      out.push(['Enter 命中后关闭', document.getElementById('paletteWrap').hidden===true]);
      open(); document.getElementById('paletteMask').click();
      out.push(['蒙层关', document.getElementById('paletteWrap').hidden===true]);
      CTB.shell.route('dash');
      return JSON.stringify(out);
    })()`);
    console.log('  命令面板交互 =', typ);
    A('★ 命令面板：输入 / 方向键 / Enter / Esc / 蒙层 全路径无异常', c.runtime.length === mk2, c.runtime.slice(mk2).join(' | ') || '0 条');
  }
  await c.evalJs(`window.__SWCLEAN()`);

  /* 4d 待办：真源 0 条未办结 ⇒ 内存注入合成条目（零写盘）走通列表/红块/灯箱/办结 */
  const pendOpen = await c.evalJs(`CTB.model.pendingOpen().length`);
  console.log(`\n  — 待办工作台（真源未办结 ${pendOpen} 条）—`);
  if (pendOpen === 0) {
    console.log('  按口径**不造真数据**；改为**内存注入** 3 条合成条目把代码路径走通（零写盘，跑完还原内存）。');
    const inj = await c.evalJs(`(function(){
      window.__SWSAVE_PEND = ((CTB.model.state.pending && CTB.model.state.pending.items) || []).slice();
      var x = CTB.model.cards.filter(function(c){return c.card.img;})[0];
      var real = x ? CTB.util.decPath(x.card.img) : '';
      var st = CTB.model.state;
      if(!st.pending) st.pending = { items: [] };
      st.pending.items = st.pending.items.concat([
        {id:'TSW001',status:'未确认',student:(CTB.__SWKID||CTB.model.state.data[0].name),subject:'数学',cardId:(x?x.card.id:''),kind:'错因口述',askWho:'孩子',question:'SWEEP 合成条目 A（内存注入，不落盘）：这题当时怎么想的？',detail:'合成 detail A',raisedAt:'2026-09-01',qRef:'第1题',source:'SWEEP',evidence:real,evidenceOk:true,box:[0.10,0.10,0.30,0.20],evidenceNote:'合成'},
        {id:'TSW002',status:'未确认',student:(CTB.__SWKID||CTB.model.state.data[0].name),subject:'数学',cardId:'',kind:'卷面辨认',askWho:'原卷',question:'SWEEP 合成条目 B：证据图路径不存在 ⇒ 走 onerror 红块路径',detail:'',raisedAt:'2026-10-05',qRef:'',source:'SWEEP',evidence:'__sweep_missing_probe__.jpg',evidenceOk:true,box:null},
        {id:'TSW003',status:'未确认',student:((CTB.model.state.data[1]&&CTB.model.state.data[1].name)||'学生B'),subject:'物理',cardId:'',kind:'系统维护',askWho:'系统',question:'SWEEP 合成条目 C：evidenceOk=false ⇒ 走 evMissHtml 红块路径',detail:'',raisedAt:'2026-10-10',qRef:'',source:'SWEEP',evidence:'不存在/原卷截图.jpg',evidenceOk:false,box:null}
      ]);
      CTB.shell.route('pending');
      return st.pending.items.length;
    })()`);
    console.log('  （注入后 pending.items =', inj, '条；合成为真源副本 + 3 条内存条目）');
    await sleep(400);
    await sweep('pending:injected', '#view', 'pending', 'pending');
    /* 灯箱（先开灯箱再跑动作链，否则会被办结掉） */
    await c.evalJs(PRE_PEND_LB);
    const lbP = await c.evalJs(`document.getElementById('lightbox').hidden===false ? JSON.stringify(CTB.shell.lbState()) : ''`);
    if (lbP) { console.log('  （待办灯箱 ' + lbP + '）'); await sweep('pending:lightbox', '#lightbox', 'pending', null, { keep: true, pre: PRE_PEND_LB }); }
    else S('待办灯箱', '合成条目里没有可用的证据图 ⇒ 画廊为空，未进灯箱');
    await c.evalJs(`window.__SWCLEAN()`);
    /* 列表内动作链：复制 → 办结 → 作废 → 去关联卡 */
    const act = await c.evalJs(`(async function(){
      var out=[];
      function fill(id){ var ta=document.querySelector('[data-ans="'+id+'"]'); if(ta){ ta.value='SWEEP 合成结论'; ta.dispatchEvent(new Event('input',{bubbles:true})); return true;} return false; }
      CTB.shell.route('pending'); await new Promise(function(r){setTimeout(r,250)});
      out.push(['fill TSW001', fill('TSW001')]);
      var cp=document.querySelector('[data-copy="TSW001"]'); if(cp){cp.click(); await new Promise(function(r){setTimeout(r,200)});}
      out.push(['本地草稿存在', !!CTB.views.pending.localGet()['TSW001']]);
      var ck=document.querySelector('[data-card]'); if(ck){ck.click(); await new Promise(function(r){setTimeout(r,300)});}
      out.push(['去关联卡后 route', CTB.shell.currentRoute()]);
      CTB.shell.route('pending'); await new Promise(function(r){setTimeout(r,250)});
      fill('TSW001'); var sv=document.querySelector('[data-solve="TSW001"]'); if(sv){sv.click(); await new Promise(function(r){setTimeout(r,600)});}
      out.push(['办结后仍在未办结', CTB.model.pendingOpen().filter(function(i){return i.id==='TSW001';}).length]);
      fill('TSW002'); var vd=document.querySelector('[data-void="TSW002"]'); if(vd){vd.click(); await new Promise(function(r){setTimeout(r,600)});}
      out.push(['作废后仍在未办结', CTB.model.pendingOpen().filter(function(i){return i.id==='TSW002';}).length]);
      return JSON.stringify(out);
    })()`);
    console.log('  待办动作链 =', act);
    /* 加待办抽屉 */
    await c.evalJs(PRE_PEND_ADD);
   	if (await c.evalJs(`!!document.getElementById('paOk')`)) {
      await sweep('pending:addDialog', '#drawer', 'pending', null, { keep: true, pre: PRE_PEND_ADD });
      const mk = c.runtime.length;
      const okAdd = await c.evalJs(`(async function(){
        function set(id,v){var e=document.getElementById(id);if(e){e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}}
        set('paSubj','数学'); set('paCard','M0001'); set('paQ','SWEEP 合成问题'); set('paD','SWEEP 合成证据');
        set('paQref','第12题'); set('paSrc','SWEEP 来源'); set('paBox','0.1,0.1,0.2,0.2'); set('paEv','九年级/不存在/证据.jpg');
        var ok=document.getElementById('paOk'); if(!ok) return 'no-ok';
        ok.click(); await new Promise(function(r){setTimeout(r,700)});
        return 'clicked';
      })()`);
      await sleep(400);
      console.log('  记入台账（打桩）=', okAdd, '| 打桩记录 =', await c.evalJs(`JSON.stringify(window.__SWSTUB.calls.filter(function(x){return x.indexOf('pendingAdd')===0}))`));
      A('★ 记一条新待办（pendingAdd 打桩）全字段提交无异常', c.runtime.length === mk, c.runtime.slice(mk).join(' | ') || '0 条');
    } else S('加待办抽屉', '#paOk 未出现');
    await c.evalJs(`window.__SWCLEAN()`);
    await c.evalJs(`(function(){ CTB.model.state.pending.items = window.__SWSAVE_PEND || []; CTB.shell.route('pending'); return 1 })()`);
    await sleep(300);
  } else {
    console.log('  真源未办结 ' + pendOpen + ' 条 ⇒ 直接在真数据上跑（办结/作废走打桩，零写盘）');
    await sweep('pending:real', '#view', 'pending', 'pending');
    await c.evalJs(`(async function(){var z=document.querySelector('#view [data-zoom]');if(z)z.click();await new Promise(function(r){setTimeout(r,400)});return 1})()`);
    if (await c.evalJs(`document.getElementById('lightbox').hidden===false`)) await sweep('pending:lightbox', '#lightbox', 'pending', null, { keep: true, pre: PRE_PEND_LB });
    await c.evalJs(`window.__SWCLEAN()`);
  }

  /* 4e 导出办结包（下载 + 落库全打桩） */
  const mkExp = c.runtime.length;
  await c.evalJs(`(async function(){
    CTB.views.pending.localSet('TSW001',{action:'答',answer:'SWEEP 导出用'});
    CTB.shell.route('pending'); await new Promise(function(r){setTimeout(r,250)});
    var b=document.getElementById('pdExport'); if(b) b.click();
    await new Promise(function(r){setTimeout(r,700)});
    return 1;
  })()`);
  console.log('  导出办结包 =', await c.evalJs(`document.getElementById('pdExport')?'btn-exists':'no-btn'`), '| 打桩记录 =', await c.evalJs(`JSON.stringify(window.__SWSTUB.calls.slice(-6))`));
  A('★ 导出办结包全路径无异常（下载/剪贴板/落库均打桩）', c.runtime.length === mkExp, c.runtime.slice(mkExp).join(' | ') || '0 条');
  await c.evalJs(`window.__SWCLEAN()`);

  /* 4f 复习流三屏 */
  console.log('\n  — 复习流深路径（配置屏 → 单卡屏 → 结算屏）—');
  const rvStart = await c.evalJs(`(function(){
    window.__SWCLEAN();
    /* 题源/学科/上限都是**渲染时读 LS** 的，前面 view:review 的 sweep 会把它们点成任意值（run1 实测 rvSj 被点成「数学」）。
       这里先写回中性值再进配置屏，保证「第 N 个元素」从同一块屏出发。 */
    try{ localStorage.setItem('ctb2.rvSrc',JSON.stringify('due')); localStorage.setItem('ctb2.rvSj',JSON.stringify('全部')); localStorage.setItem('ctb2.rvCap',JSON.stringify(15)); }catch(e){}
    CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name);
    CTB.model.session=null; CTB.shell.route('review');
    /* 不点 #rvSrc（见 prepView 注释） */
    var j=[].slice.call(document.querySelectorAll('#view #rvSj .chip')).filter(function(e){return (e.textContent||'').trim()==='全部'})[0];
    if(j) j.click();
    var b=document.getElementById('rvStart');
    if(!b) return 'no-start|' + JSON.stringify({stu:CTB.model.student(),canGroup:CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).length,rvSrc:localStorage.getItem('ctb2.rvSrc'),rvSj:localStorage.getItem('ctb2.rvSj'),rvCap:localStorage.getItem('ctb2.rvCap'),html:document.getElementById('view').textContent.slice(0,240)});
    b.click(); return CTB.model.session ? ('session ' + CTB.model.session.queue.length + ' 题') : 'no-session';
  })()`);
  console.log('  （' + rvStart + '）');
  if (/^session/.test(rvStart)) {
    await sweep('review:card', '#view', 'review', null, { keep: true, pre: PRE_RV_CARD });
    const mk = c.runtime.length;
    const flow = await c.evalJs(`(async function(){
      var out=[];
      CTB.model.session=null; CTB.shell.route('review'); await new Promise(function(r){setTimeout(r,200)});
      var s=document.getElementById('rvStart'); if(s) s.click(); await new Promise(function(r){setTimeout(r,250)});
      out.push(['card屏', !!document.getElementById('rvReveal')]);
      var rv=document.getElementById('rvReveal'); if(rv) rv.click(); await new Promise(function(r){setTimeout(r,250)});
      var nb=document.getElementById('rvNote'); out.push(['reveal后笔记框', !!nb]);
      if(nb){ nb.value='SWEEP 转折点'; nb.dispatchEvent(new Event('input',{bubbles:true})); }
      var g=document.querySelector('[data-grade="对"]'); if(g) g.click(); await new Promise(function(r){setTimeout(r,250)});
      out.push(['判分后 idx', CTB.model.session?CTB.model.session.idx:-1]);
      var sk=document.getElementById('rvSkip'); if(sk) sk.click(); await new Promise(function(r){setTimeout(r,200)});
      var un=document.getElementById('rvUndo'); if(un) un.click(); await new Promise(function(r){setTimeout(r,200)});
      out.push(['跳过/撤销后 idx', CTB.model.session?CTB.model.session.idx:-1]);
      out.push(['skipped数', CTB.model.sessionSkippedCount()]);
      var guard=0;
      while(CTB.model.session && !CTB.model.sessionDone() && guard++<90){
        var rv2=document.getElementById('rvReveal'); if(rv2) rv2.click();
        await new Promise(function(r){setTimeout(r,30)});
        var g2=document.querySelector('[data-grade="错"]'); if(g2) g2.click();
        await new Promise(function(r){setTimeout(r,45)});
      }
      await new Promise(function(r){setTimeout(r,300)});
      out.push(['done', CTB.model.sessionDone()]);
      out.push(['结算屏 rvCommit', !!document.getElementById('rvCommit')]);
      out.push(['结算屏 rvRedoSkipped', !!document.getElementById('rvRedoSkipped')]);
      return JSON.stringify(out);
    })()`);
    console.log('  单卡屏动作链 =', flow, '| 新消息 ' + (c.runtime.length - mk));
    A('★ 单卡屏：翻答案 / 写笔记 / 判分 / 跳过 / 撤销 / 判到结算 全路径无异常', c.runtime.length === mk, c.runtime.slice(mk).join(' | ') || '0 条');
    await sweep('review:summary', '#view', 'review', null, { keep: true, pre: PRE_RV_SUM });
    const mk2 = c.runtime.length;
    const cm = await c.evalJs(`(async function(){
      var out=[];
      var b=document.getElementById('rvCommit');
      if(b){ b.click(); await new Promise(function(r){setTimeout(r,1200)}); out.push(['落库后 session 已清', CTB.model.session===null]); }
      else out.push(['无 rvCommit（本场 0 判定）', true]);
      return JSON.stringify(out)+'|stub='+JSON.stringify(window.__SWSTUB.calls.filter(function(x){return x.indexOf('mark')===0}));
    })()`);
    console.log('  结算屏落库（打桩）=', cm);
    A('★ 结算屏「落库」全链路（组卷→批改→后台重建）无异常，且 mark 走的是打桩', c.runtime.length === mk2, c.runtime.slice(mk2).join(' | ') || '0 条');
    await c.evalJs(`(function(){ CTB.model.session=null; CTB.shell.route('review'); return 1 })()`);
  } else S('复习流单卡/结算屏', '本范围可练题 0（' + rvStart + '）⇒ 无法进入做题屏');
  await c.evalJs(`window.__SWCLEAN()`);

  /* 4g 组卷四屏：配卷（有篮） → 预览 → 台账/回录 */
  console.log('\n  — 组卷工作台深路径（配卷 → 预览 → 台账/回录）—');
  await c.evalJs(`(async function(){window.__SWCLEAN();CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name);CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,12).map(function(x){return x.kid+'|'+x.card.id}));CTB.shell.route('paper',{reset:true});await new Promise(function(r){setTimeout(r,250)});return 1})()`);
  console.log('  （配卷屏 = ' + await c.evalJs(`JSON.stringify({basket:CTB.model.basket().length,prevDisabled:!!(document.getElementById('pbPrev2')||{disabled:1}).disabled})`) + '）');
  await sweep('paper:compose', '#view', 'paper', null, { keep: true, pre: PRE_PAPER_COMPOSE });
  const pv = await c.evalJs(`(function(){
    window.__SWCLEAN(); CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name); CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,12).map(function(x){return x.kid+'|'+x.card.id})); CTB.shell.route('paper',{reset:true});
    var b=document.getElementById('pbPrev2')||document.getElementById('ppPrev');
    if(!b) return 'no-prev';
    if(b.disabled) return 'prev-disabled';
    b.click(); return document.getElementById('pvPrint')?'preview':'not-preview';
  })()`);
  console.log('  （预览屏 ' + pv + '）');
  if (pv === 'preview') {
    await sweep('paper:preview', '#view', 'paper', null, { keep: true, pre: PRE_PAPER_PREVIEW });
    const mk = c.runtime.length;
    const cm = await c.evalJs(`(async function(){
      CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name); CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,12).map(function(x){return x.kid+'|'+x.card.id})); CTB.shell.route('paper',{reset:true}); await new Promise(function(r){setTimeout(r,200)});
      var b=document.getElementById('pbPrev2'); if(b&&!b.disabled) b.click();
      await new Promise(function(r){setTimeout(r,250)});
      var pc=document.getElementById('pvCommit'); if(!pc) return 'no-commit';
      pc.click(); await new Promise(function(r){setTimeout(r,1200)});
      return 'clicked|stub='+JSON.stringify(window.__SWSTUB.calls.filter(function(x){return x.indexOf('mark')===0}));
    })()`);
    console.log('  组卷入账（打桩）=', cm);
    A('★ 组卷「入账」全链路无异常（mark 打桩，未写台账）', c.runtime.length === mk, c.runtime.slice(mk).join(' | ') || '0 条');
  } else S('组卷预览屏', '篮子里没有可组卷的题（' + pv + '）⇒ 进不去预览');
  const lg = await c.evalJs(`(async function(){
    CTB.shell.route('paper',{reset:true}); await new Promise(function(r){setTimeout(r,200)});
    var b=document.getElementById('pbLedger2'); if(!b) return 'no-btn';
    b.click(); await new Promise(function(r){setTimeout(r,900)});
    return document.getElementById('lgBack')?'ledger':'no-ledger';
  })()`);
  console.log('  （台账屏 ' + lg + '）');
  if (lg === 'ledger') {
    await sweep('paper:ledger', '#view', 'paper', null, { keep: true, pre: PRE_PAPER_LEDGER });
    await c.evalJs(PRE_PAPER_GRADE);
    if (await c.evalJs(`!!document.getElementById('lgSubmit')`)) {
      await sweep('paper:gradeDialog', '#drawer', 'paper', null, { keep: true, pre: PRE_PAPER_GRADE });
      const mk = c.runtime.length;
      const sub = await c.evalJs(`(async function(){
        var seg=document.querySelector('.seg[data-res]');
        if(seg){ var b=seg.querySelector('button'); if(b) b.click(); }
        var nt=document.getElementById('lgNote'); if(nt){nt.value='SWEEP 备注';}
        var sb=document.getElementById('lgSubmit'); if(!sb) return 'no-submit';
        sb.click(); await new Promise(function(r){setTimeout(r,1000)});
        return 'submitted|stub='+JSON.stringify(window.__SWSTUB.calls.filter(function(x){return x.indexOf('mark')===0||x.indexOf('regenBackground')===0}));
      })()`);
      console.log('  回录提交（打桩）=', sub);
      A('★ 回录批改提交无异常（mark 打桩，未写台账）', c.runtime.length === mk, c.runtime.slice(mk).join(' | ') || '0 条');
    } else S('回录抽屉', '台账里没有待批改批次 ⇒ 无 [data-grade] 可点（真源 batches 为 0，如实记 SKIP）');
  } else S('组卷台账屏', '台账入口打不开（' + lg + '）');
  await c.evalJs(`window.__SWCLEAN()`);

  /* 4g-2 ★ 确定性复现：ledgerView 的「await 期间被重绘」竞态
     复现步骤（不需要运气，同一个 JS 任务内完成）：
       ① 进入组卷工作台 → ② 点「📒 台账 / 回录」（ledgerView 起手，挂在 await H.readFile 上）
       ③ 同一任务里立刻 CTB.shell.route('paper',{reset:true}) 重绘（等价于用户等台账时切学生 / 按 r·b 快捷键 /
          autoReload 因窗口重新获得焦点而触发）→ ④ readFile 回来时 #lgBox 已被换掉 ⇒ 写 null ⇒ 未捕获 rejection。
     为什么 S.render 的 try/catch 接不住：异常发生在 await **之后**，已经是 unhandled promise rejection。 */
  {
    const mkLed = c.runtime.length;
    const rr = await c.evalJs(`(async function(){
      window.__SWCLEAN(); CTB.model.student(CTB.__SWKID||CTB.model.state.data[0].name);
      try{ localStorage.setItem('ctb2.rvSj',JSON.stringify('全部')); }catch(e){}
      CTB.shell.route('paper',{reset:true});
      await new Promise(function(r){setTimeout(r,220)});
      var b=document.getElementById('pbLedger2');
      if(!b) return JSON.stringify({skip:'no-ledger-btn'});
      b.click();                                   /* ledgerView 开始 await */
      CTB.shell.route('paper',{reset:true});        /* 同一任务内立刻重绘 */
      await new Promise(function(r){setTimeout(r,900)});
      return JSON.stringify({ok:true,lgBox:!!document.getElementById('lgBox')});
    })()`);
    const msgs = c.runtime.slice(mkLed).map(String);
    const ledgerMsg = msgs.filter(m => /ledgerView|paper\.js/.test(m));
    console.log('  台账竞态复现 =', rr, '| 新 Runtime 消息 ' + msgs.length + ' 条');
    ledgerMsg.forEach(m => console.log('      ' + m.slice(0, 260)));
    if (ledgerMsg.length) {
      findings.push({ scope: 'paper:ledger-race', label: 'ledgerView 在 await 期间被重绘 ⇒ 写已卸载的 #lgBox', status: 'repro', err: '', msgs: ledgerMsg.slice(0, 2), len: 0 });
      B('paper:ledger-race').problems++;
    }
    A('★ ledgerView 在 await 期间被重绘时不得写已卸载的 #lgBox（确定性复现，见 docs §3 问题#1）',
      ledgerMsg.length === 0, ledgerMsg.length ? ledgerMsg[0].slice(0, 240) : '未复现');
  }

  /* 4h 单题打印版预览 */
  await c.evalJs(PRE_SINGLE_PREVIEW);
  if (await c.evalJs(`!!document.getElementById('spPrint')`)) {
    await sweep('bank:singlePreview', '#drawer', 'bank', null, { keep: true, pre: PRE_SINGLE_PREVIEW });
    const mk = c.runtime.length;
    const pr = await c.evalJs(`(async function(){ var b=document.getElementById('spPrint'); if(b){b.click(); await new Promise(function(r){setTimeout(r,500)});} return 'prints='+window.__SWSTUB.prints; })()`);
    console.log('  单题打印（打桩）=', pr);
    A('★ 单题打印版预览 + 打印无异常（window.print 打桩）', c.runtime.length === mk, c.runtime.slice(mk).join(' | ') || '0 条');
  } else S('单题打印版预览', '题库当前 0 行 ⇒ 没有 [data-print] 可点');
  await c.evalJs(`window.__SWCLEAN()`);

  /* 4i 帮助抽屉 */
  await c.evalJs(PRE_HELP); await sleep(300);
  await sweep('shell:help', '#drawer', 'dash', null, { keep: true, pre: PRE_HELP });
  await c.evalJs(`window.__SWCLEAN()`);

  /* ---- 5 阴性自证 ---- */
  console.log('\n════════ 5 阴性自证（把已知会崩的输入喂进同一判据，必须全红）════════');
  const neg = JSON.parse(await c.evalJs(`(async function(){
    var out=[];
    var orig = CTB.views.stats.render;
    CTB.views.stats.render = function(){ throw new Error('SWEEP-NEG-PROOF-视图抛错'); };
    CTB.shell.route('stats'); await new Promise(function(r){setTimeout(r,250)});
    out.push(['视图抛错', JSON.parse(window.__SWPROBE()).err]);
    CTB.views.stats.render = function(){ console.error(new Error('SWEEP-NEG-PROOF-吞掉的错')); document.getElementById('view').innerHTML='<div>ok</div>'; };
    CTB.shell.route('stats'); await new Promise(function(r){setTimeout(r,250)});
    out.push(['只 console.error', JSON.parse(window.__SWPROBE()).err]);
    CTB.views.stats.render = orig;
    CTB.shell.route('dash');
    return JSON.stringify(out);
  })()`));
  console.log('  阴性结果 =', JSON.stringify(neg));
  A('★ 阴性自证①：视图抛错能被「视图渲染出错」文本判据抓到', /视图渲染出错/.test(neg[0][1]), neg[0][1]);
  A('★ 阴性自证②：视图文本干净、只有 console.error 时判据仍能红 —— 证明第③条判据不是空真',
    neg[1][1] === '' && c.runtime.some(m => /SWEEP-NEG-PROOF-吞掉的错/.test(String(m))),
    `视图文本="${neg[1][1]}" console 捕获 ${c.runtime.filter(m => /SWEEP-NEG-PROOF/.test(String(m))).length} 条`);

  /* ---- 6 打桩计数（reload 前读走） ---- */
  const stubCalls = JSON.parse(await c.evalJs(`JSON.stringify(window.__SWSTUB||{n:0,calls:[],dl:0,confirms:0,prints:0})`));

  /* ---- 7 还原 → 截图 → 再还原并断言 ---- */
  console.log('\n════════ 7 还原后端状态 → 逐页真壳截图 → 断言还原 ════════');
  const restoreLS = `(function(){
    var want=${JSON.stringify(snapObj)};
    var now=[]; for(var i=0;i<localStorage.length;i++) now.push(localStorage.key(i));
    now.forEach(function(k){ if(!(k in want)) localStorage.removeItem(k); });
    Object.keys(want).forEach(function(k){ localStorage.setItem(k, want[k]); });
    return 1;
  })()`;
  await c.evalJs(restoreLS);
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(4000);
  /* ⚠ 每次 reload 都必须重装 HELPERS：reload 清掉页面全局，漏装 ⇒
     后面 `window.__SWPROBE is not a function`，整个截图段崩（run1 实测 exit 1）。 */
  await c.evalJs(HELPERS);

  const SHOTS = [];
  for (const theme of ['light', 'dark']) {
    await c.evalJs(`(function(){ CTB.shell.applyTheme(${JSON.stringify(theme)}); return 1 })()`);
    await sleep(350);
    for (const v of VIEWS) {
      if (v.id === 'paper') await c.evalJs(`CTB.shell.route('paper',{reset:true})`);
      else await c.evalJs(`CTB.shell.route(${JSON.stringify(v.id)})`);
      await sleep(750);
      const f = `sweep-${v.id}-${theme}.png`;
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_SHOTS, f), Buffer.from(r.data, 'base64'));
      const p = JSON.parse(await c.evalJs(`window.__SWPROBE()`));
      SHOTS.push(f);
      console.log(`  ${f}  (#view innerHTML=${p.len}${p.err ? '  ⚠ ' + p.err : ''})`);
      if (p.err) { B('shot:' + v.id).problems++; findings.push({ scope: 'shot:' + v.id, label: '截图时页面报错', status: 'shot', err: p.err, msgs: [], len: p.len }); }
    }
  }
  A('★ 12 张截图全部生成且非空（>20KB）', SHOTS.length === 12 && SHOTS.every(f => fs.statSync(path.join(OUT_SHOTS, f)).size > 20000),
    SHOTS.map(f => f + ':' + fs.statSync(path.join(OUT_SHOTS, f)).size).join(' '));

  await c.evalJs(restoreLS);
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(4000);
  await c.evalJs(HELPERS);
  const restored = await c.evalJs(`(function(){var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k);}return JSON.stringify(o)===JSON.stringify(JSON.parse(${JSON.stringify(LS_SNAP)}));})()`);
  A('★ 跑完后 localStorage 与跑前快照逐字节一致（不给下一个测试留脏状态）', restored === true, restored);

  const AFTER = truthFingerprint();
  const diff = TRUTH.filter(k => BEFORE[k] !== AFTER[k]);
  A('★ 8 个真源文件 SHA256 全程未变（比 git status 更强的证据）', diff.length === 0,
    diff.length ? diff.map(k => `${k}: ${BEFORE[k]}→${AFTER[k]}`).join('; ') : TRUTH.map(k => k + '=' + BEFORE[k]).join(' '));
  A('★ `_组卷台账.json` 的 batches.length 与跑前相同', BEFORE['__batches.length'] === AFTER['__batches.length'],
    `${BEFORE['__batches.length']} → ${AFTER['__batches.length']}`);

  console.log('  打桩计数 n=' + (stubCalls.n || 0) + ' | 下载拦截=' + (stubCalls.dl || 0) + ' | confirm=' + (stubCalls.confirms || 0) + ' | print=' + (stubCalls.prints || 0));
  console.log('  打桩明细 = ' + JSON.stringify((stubCalls.calls || []).slice(0, 40)));

  /* ---- 8 汇总 ---- */
  console.log('\n════════ 8 汇总 ════════');
  console.log('范围'.padEnd(24) + '总计  已点  禁用  不可见  已消失  问题');
  for (const k of Object.keys(stats)) {
    const s = stats[k];
    console.log(String(k).padEnd(24) + String(s.total).padStart(4) + String(s.clicked).padStart(6) + String(s.skipDis).padStart(6) + String(s.skipInv).padStart(8) + String(s.gone).padStart(8) + String(s.problems).padStart(6));
  }
  /* ★ 未归属 Runtime 消息必须为 0：阴性自证那两条是**故意造出来**的，台账竞态那条已由上一行断言单独认领。
     把这句放在最后，是为了堵住「异步异常落在两次采样窗口之间」的漏网（run2 就是这样漏掉 ledgerView 那条的）。 */
  const UNACCOUNTED = c.runtime.map(String).filter(m => !/SWEEP-NEG-PROOF/.test(m) && !/ledgerView|views\/paper\.js/.test(m));
  A('★ 除阴性自证与已认领的台账竞态外，全程无任何未归属 Runtime 异常/console', UNACCOUNTED.length === 0,
    UNACCOUNTED.length ? UNACCOUNTED.slice(0, 3).map(m => m.slice(0, 200)).join(' || ') : '0 条');

  console.log(`\n合计：断言 ${asserts}｜点击 ${clicks}｜问题 ${findings.length}｜跳过 ${skips}｜Runtime 异常/console = ${c.runtime.length}`);
  if (c.runtime.length) { console.log('\n---- Runtime 异常/console 全量（共 ' + c.runtime.length + ' 条，判据只看这个）----'); c.runtime.forEach((m, i) => console.log('  R' + (i + 1) + ' ' + String(m).slice(0, 300))); }
  if (c.log.length) { console.log('\n---- Log 域（共 ' + c.log.length + ' 条，仅记录不判红）----'); c.log.slice(0, 12).forEach((m, i) => console.log('  L' + (i + 1) + ' ' + String(m).slice(0, 160))); }
  if (findings.length) {
    console.log('\n---- 问题清单 ----');
    findings.forEach((f, i) => {
      console.log(`#${i + 1} [${f.scope}] ${f.label}`);
      if (f.err) console.log('    视图文本: ' + f.err);
      f.msgs.forEach(m => console.log('    console : ' + String(m).slice(0, 240)));
    });
  } else console.log('\n---- 未发现问题（0 条崩路被走出）----');
  c.close();
  SWEEP_DONE = true;   // 正常跑完：第 7 段已经 reload 复位过，兜底不必再动
  console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${asserts} 点击=${clicks} 问题=${findings.length} 跳过=${skips}`);
  process.exit(fails ? 1 : 0);
})().catch(async (e) => {
  /* ★ 2026-10-23：崩溃路径也必须把页面打桩清掉（见上文"崩溃兜底"）。
     没有这一步，一次 CDP 超时就会让紧随其后的 e2e-writepath 读到假结果。 */
  console.log('EXC ' + (e && e.stack || e));
  try {
    const ts = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const pg = ts.find((t) => E.isAppUrl(dec(t.url)) && t.type === 'page');
    if (pg) {
      const c2 = await Cdp.connect(pg.webSocketDebuggerUrl);
      await c2.send('Page.enable');
      await c2.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 2500));
      c2.close();
      console.log('[兜底] 已重载页面清掉打桩，避免污染后续测试');
    }
  } catch (e2) { console.log('[兜底] 清理失败：' + (e2 && e2.message)); }
  process.exit(1);
});
