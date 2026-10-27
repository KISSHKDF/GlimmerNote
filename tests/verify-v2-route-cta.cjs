#!/usr/bin/env node
/**
 * 「页面内按钮」路由回归 —— 2026-10-11
 *
 * 起因（用户实测）：在「今日总览」点「🔁 进入复习流」→ 界面显示
 *   「⚠️ 视图渲染出错 Cannot read properties of undefined (reading '1')」
 * 根因：该按钮走 `S.route('review', {queue:'pick'})`，而 review 视图的 pools 只有 due/all/basket
 *   ⇒ `pools['pick'][1]` 抛 TypeError。**侧栏切页不带参数（走 due）所以一直正常**——
 *   而此前的验收只点了侧栏，**完全没覆盖"页面内 CTA 按钮"这条路径**（这就是漏洞本身）。
 *
 * 本脚本系统性补上：遍历六个视图里的**所有** `[data-a]`/`[data-go]`/`[data-anchor]`/`[data-pend]` 按钮，
 * 逐个点击，每次点击后断言「没有出现视图渲染出错」。
 * 需要真实壳在跑（CDP 9223）；壳不在则显式 SKIP（**不是**静默通过）。
 *
 * 用法：node tests\verify-v2-route-cta.cjs   （先 node tests\launch-dev.cjs）
 */
const PORT = +(process.env.CTB_CDP_PORT || 9223);
const BASE = 'http://127.0.0.1:' + PORT;
/* ★ 2026-10-23：页面 URL 判据走唯一实现（老布局 /v2/index.html 已搬到 src\app\index.html） */
const E = require('./_测试环境.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* ★ 2026-10-12：单次 CDP 调用超时（原 send 挂上 pending 就永不超时 ⇒ 门禁可能挂死）
   覆盖：CTB_CDP_TIMEOUT（毫秒，默认 20000）。 */
function cdpTimeout() { const v = Number(process.env.CTB_CDP_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 20000; }
let fails = 0, asserts = 0, skips = 0;
const A = (n, ok, d) => { asserts++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) fails++; };
const S = (n, why) => { skips++; console.log(`[SKIP]${n}  → ${why}`); };

class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); this.jsErrors = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) { const p = c.pm.get(m.id); c.pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') c.jsErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300)); };
    return c;
  }
  send(m, params = {}, timeoutMs = cdpTimeout()) { const id = ++this.id; return new Promise((res, rej) => {
      const _t = setTimeout(() => { this.pm.delete(id); rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + m)); }, timeoutMs);
      this.pm.set(id, { res: v => { clearTimeout(_t); res(v); }, rej: e => { clearTimeout(_t); rej(e); } }); this.ws.send(JSON.stringify({ id, method: m, params })); }); }
  async evalJs(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, cdpTimeout()); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result && r.result.value; }
}

(async () => {
  let pg = null;
  try {
    const list = await (await fetch(BASE + '/json/list')).json();
    pg = list.find(t => E.isAppUrl(t.url) && t.type === 'page') || list.find(t => t.type === 'page');
  } catch (e) { }
  if (!pg) { S('页面内 CTA 路由回归', `CDP ${PORT} 上没有页面（壳没跑）。先 node tests\\launch-dev.cjs 再跑本脚本。`); console.log(`\nRESULT=SKIP 断言=0 跳过=${skips}`); process.exit(0); }

  const c = await Cdp.connect(pg.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  /* ⚠ 必须先强制重载：壳是启动时把 js 读进内存的，改了盘上的 js 但没重载 ⇒ 测的是旧代码
     （我自己踩过：改完 review.js 重放用户路径仍报旧的栈 `58:39`）。ignoreCache 确保不吃缓存。 */
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(3800);
  console.log('通道 =', E.isFileAppUrl(pg.url) ? '真实壳 file://' : pg.url, '（已强制重载，跑的是盘上最新 js）');
  A('重载后外壳本身无渲染错（侧栏/顶栏没被错误分支接管）',
    (await c.evalJs(`(function(){var s=document.getElementById('sidebar');var t=document.getElementById('topbar');return !/渲染出错|界面出错/.test((s?s.textContent:'')+(t?t.textContent:''))})()`)) === true,
    (await c.evalJs(`(function(){var s=document.getElementById('sidebar');return (s?s.textContent:'').replace(/\\s+/g,' ').trim().slice(0,60)})()`)));

  const VIEWS = ['dash', 'bank', 'review', 'paper', 'pending', 'ingest', 'stats'];
  const errText = `(function(){var v=document.getElementById('view');var t=(v?v.textContent:'');return /视图渲染出错|Cannot read propert|is not a function|undefined is not/.test(t)?t.replace(/\\s+/g,' ').slice(0,160):''})()`;

  /* ⚠ 本脚本会点击**会写 localStorage 的按钮**（如 bank 的「按盲解未过筛出来看原因」→
     `S.route('bank',{blind:'no'})` → bank.onParam 里 `save()` 把筛选落进 localStorage 的 `ctb2.filters`）。
     若不还原就会**污染壳的持久 profile**：实测把 `blind:"no"` 存进去后，题库永久显示「共 0 题（筛掉 80）」，
     并让下一次 `run.mjs full` 里先跑的 `e2e-ui.mjs` 报「题库列表行>0 → 0」而红（而且因为污染是**持久**的，
     单纯"跑完还原"救不了——上次快照时它已经是脏的）。
     所以这里做三件事：① 快照；② **跑前先把筛选复位到中性值**（保证本脚本自身从干净态出发）；
     ③ 跑完还原快照。 */
  const LS_SNAP = await c.evalJs(`(function(){ var o={}; for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k);} return JSON.stringify(o); })()`);
  await c.evalJs(`(function(){
    try {
      var f = JSON.parse(localStorage.getItem('ctb2.filters') || '{}');
      f.q=''; f.subject='全部'; f.diff='全部'; f.layer='全部'; f.state='全部'; f.blind='全部'; f.code=''; f.hasImg=false;
      localStorage.setItem('ctb2.filters', JSON.stringify(f));
    } catch (e) {}
    return 1;
  })()`);
  console.log('（已快照 localStorage ' + Object.keys(JSON.parse(LS_SNAP)).length + ' 键；跑前已把题库筛选复位到中性，跑完还原）');

  for (const view of VIEWS) {
    /* 用侧栏进入视图（它的正确性已由 verify-shell-visual 覆盖） */
    await c.evalJs(`(function(){var b=[].slice.call(document.querySelectorAll('.nav-item[data-r]')).filter(function(e){return e.dataset.r===${JSON.stringify(view)}})[0]; if(b)b.click(); return 1})()`);
    await sleep(700);
    const base = await c.evalJs(errText);
    A(`进入 ${view} 视图本身不报错`, base === '', base || '(无错)');

    /* 枚举该视图里的所有路由型按钮 */
    const btns = JSON.parse(await c.evalJs(`(function(){
      var sel='[data-a],[data-go],[data-anchor],[data-pend]';
      return JSON.stringify([].slice.call(document.querySelectorAll(sel)).map(function(e,i){
        return {i:i, tag:e.tagName, key:(e.dataset.a||e.dataset.go||e.dataset.anchor||('pd-'+e.dataset.pend)), text:(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,18)};
      }));
    })()`));
    if (!btns.length) { console.log(`   （${view} 无路由型按钮）`); continue; }
    for (const b of btns) {
      /* 每个按钮都从本视图出发点一次（点完回本视图） */
      await c.evalJs(`(function(){var b=[].slice.call(document.querySelectorAll('.nav-item[data-r]')).filter(function(e){return e.dataset.r===${JSON.stringify(view)}})[0]; if(b)b.click(); return 1})()`);
      await sleep(350);
      const clicked = await c.evalJs(`(function(){
        var sel='[data-a],[data-go],[data-anchor],[data-pend]';
        var list=[].slice.call(document.querySelectorAll(sel));
        var e=list.find(function(x){return (x.dataset.a||x.dataset.go||x.dataset.anchor||('pd-'+x.dataset.pend))===${JSON.stringify(b.key)}});
        if(!e) return 'gone'; e.click(); return 'clicked';
      })()`);
      await sleep(800);
      const err = await c.evalJs(errText);
      A(`★ 在 ${view} 点「${b.text}」(${b.key}) 后不报渲染错`, err === '', err || `${clicked}，无错`);
      /* 若跳走了，回本视图继续下一个按钮 */
      await c.evalJs(`(function(){var b=[].slice.call(document.querySelectorAll('.nav-item[data-r]')).filter(function(e){return e.dataset.r===${JSON.stringify(view)}})[0]; if(b)b.click(); return 1})()`);
      await sleep(300);
    }
  }

  A('全程无未捕获 JS 异常', c.jsErrors.length === 0, c.jsErrors.slice(0, 3).join(' | ') || '0 条');

  /* 还原 localStorage，并把 view 回总览——不给下一个测试留脏状态 */
  await c.evalJs(`(function(){
    var want=JSON.parse(${JSON.stringify(LS_SNAP)});
    var now=[]; for(var i=0;i<localStorage.length;i++) now.push(localStorage.key(i));
    now.forEach(function(k){ if(!(k in want)) localStorage.removeItem(k); });
    Object.keys(want).forEach(function(k){ localStorage.setItem(k, want[k]); });
    return 1;
  })()`);
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(2500);
  const restored = await c.evalJs(`(function(){ var o={}; for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k);} return JSON.stringify(o)===JSON.stringify(JSON.parse(${JSON.stringify(LS_SNAP)})); })()`);
  A('★ 跑完后 localStorage 已还原（不给下一个测试留脏状态）', restored === true, restored);
  c.ws.close();
  console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${asserts} 跳过=${skips}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('EXC ' + (e && e.stack || e)); process.exit(1); });
