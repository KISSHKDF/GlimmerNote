/* v2 修复后的「真页面」冒烟（headless Edge + 已在本机跑的服务端 7187，不新起服务、不写任何真源）
   与 tests/e2e-ui.mjs 的区别：那条走桌面壳通道（CDP 9223，当前环境没有壳）；这条走服务端通道，
   能真实验证「14 个 js 全部装载 → boot 不抛 → 新增纯函数/渲染点可用」。
   用法：node tests/neg-v2-pagesmoke.cjs */
const { spawn } = require('child_process');
const E = require('./_测试环境.cjs');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
/* ★ 2026-10-23：自带服务端（原来要求本机 7187 有服务端在跑，可能是用户冻结区的老服务端） */
let __srv = null;
let URL = process.env.CTB_SRV ? process.env.CTB_SRV + '/index.html' : '';
const ROOT = path.resolve(__dirname, '..');
/* ★ 2026-10-12：单次 CDP 调用超时（基础设施缺陷修复）。
   原 send() 挂上 pending 就永远不超时，而 evalJs 用 awaitPromise:true ——
   页面里只要有一个卡住的 Promise，整条门禁就无限期挂住（实测卡过 20~40 分钟，只能人工 kill）。
   门禁必须永远能自己跑完。覆盖：CTB_CDP_TIMEOUT（毫秒，默认 20000）。 */
function cdpTimeout() { const v = Number(process.env.CTB_CDP_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 20000; }
const OUT = path.join(ROOT, 'tests', 'out', 'neg-v2-pagesmoke.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const P = s => { log.push(s); console.log(s); };

async function listTargets() { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); if (!r.ok) throw new Error('list ' + r.status); return r.json(); }
class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); this.errs = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) { const p = c.pm.get(m.id); c.pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') c.errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 260));
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') c.errs.push('console.error: ' + (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 260));
    };
    return c;
  }
  send(method, params = {}, timeoutMs = cdpTimeout()) { const id = ++this.id; return new Promise((res, rej) => {
      const _t = setTimeout(() => { this.pm.delete(id); rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + method)); }, timeoutMs);
      this.pm.set(id, { res: v => { clearTimeout(_t); res(v); }, rej: e => { clearTimeout(_t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, cdpTimeout());
    if (r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch { } }
}

let fails = 0;
const A = (name, ok, detail) => { P((ok ? '[OK]  ' : '[FAIL]') + name + (detail !== undefined ? '  → ' + String(detail).slice(0, 240) : '')); if (!ok) fails++; };

(async () => {
  if (!URL) {
    __srv = await E.startServer();
    URL = __srv.base + '/index.html?ctbPort=' + __srv.port;
    A('测试服务端就绪（自带实例）', true, URL);
  }
  const profile = path.join(path.join(ROOT, '_probe'), 'v2fix-profile-' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, URL], { stdio: 'ignore', detached: false });
  let home = null;
  for (let i = 0; i < 40 && !home; i++) {
    try { const ts = await listTargets(); home = ts.find(t => /index\.html/.test(t.url) && t.type === 'page'); } catch (e) { }
    if (!home) await sleep(500);
  }
  if (!home) { P('[EXC] headless Edge 没起来（端口 ' + PORT + '）'); fs.writeFileSync(OUT, log.join('\r\n'), 'utf8'); child.kill(); process.exit(2); }
  P('[A] 页面目标: ' + home.url);
  const cdp = await Cdp.connect(home.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  let booted = false;
  for (let i = 0; i < 60 && !booted; i++) {
    try { booted = await cdp.evalJs(`!!(window.CTB&&CTB.model&&CTB.model.cards&&CTB.model.cards.length)`); } catch (e) { }
    if (!booted) await sleep(500);
  }
  A('服务端通道 boot 成功且拿到卡片', booted, await cdp.evalJs(`CTB.model.cards.length`));
  A('通道=server（浏览器直连测试服务端）', await cdp.evalJs(`CTB.host.mode`) === 'server', await cdp.evalJs(`CTB.host.mode`));
  P('[i] 卡片数 = ' + await cdp.evalJs(`CTB.model.cards.length`));

  for (const r of ['dash', 'bank', 'review', 'paper', 'pending', 'stats']) {
    await cdp.evalJs(`CTB.shell.route('${r}')`); await sleep(450);
    const n = await cdp.evalJs(`document.getElementById('view').innerHTML.length`);
    const err = await cdp.evalJs(`/视图渲染出错/.test(document.getElementById('view').innerHTML)`);
    A('路由 #' + r + ' 渲染非空且无渲染错', n > 500 && !err, n);
  }
  /* F-39：健康红条容器存在且当前（dataHealth 全 ok）为隐藏 */
  A('F-39 红条容器存在，健康时隐藏', await cdp.evalJs(`(function(){var el=document.getElementById('dataHealthBanner');return !!el&&el.hidden&&el.getAttribute('data-health-bad')==='1'})()`));
  A('F-39 注入降级后红条显形且说清哪道门禁', await cdp.evalJs(`(function(){
    var keep=CTB.model.health;
    CTB.model.health=CTB.model.healthOf(Object.assign({},CTB.model.state,{dataHealth:{admit:'解包失败'}}));
    CTB.shell.render();
    var el=document.getElementById('dataHealthBanner');
    var shown=!el.hidden&&/不是通过了，是读不到/.test(el.textContent)&&/组卷准入/.test(el.textContent);
    CTB.model.health=keep;CTB.shell.render();return shown&&document.getElementById('dataHealthBanner').hidden})()`));
  /* F-09 */
  A('F-09 blindCls 同工具白名单', await cdp.evalJs(`(function(){
    /* ★ 2026-10-23：『待双路』从"未知态(null)"升为**具名不通过态**（ok:false + why）。 全量双路规则下它不是状态不明，而是明确"只跑完一路"⇒ 必须拦且要说得出原因。 */
    var bad=['未通过','不通过','已通过但存疑','不一致','','未盲解',null];
    var pending=CTB.model.blindCls({blindStatus:'待双路'});
    return bad.every(function(s){return CTB.model.blindCls({blindStatus:s}).ok!==true})&&CTB.model.blindCls({blindStatus:'已通过'}).ok===true&&pending.ok===false&&!!pending.why&&CTB.model.blindOk({blindStatus:'待双路'})===false})()`));
  /* F-26：试卷/答案册分单元 */
  await cdp.evalJs(`CTB.shell.route('paper',{reset:true})`); await sleep(300);
  await cdp.evalJs(`CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,3).map(function(x){return x.kid+'|'+x.card.id}))`);
  await cdp.evalJs(`CTB.shell.route('paper',{reset:true})`); await sleep(300);
  const prevOk = await cdp.evalJs(`(function(){var b=document.getElementById('ppPrev');if(!b)return 'no-btn';b.click();return 'clicked'})()`);
  await sleep(500);
  A('F-26 试卷打印单元不含答案册', prevOk === 'clicked' && await cdp.evalJs(`(function(){
    var P=CTB.views.paper,p=P.printUnit('paper'),a=P.printUnit('ans');
    return !/答案册/.test(p)&&/class="q"/.test(p)&&/答案册/.test(a)&&!!document.getElementById('pvPrint')&&!!document.getElementById('pvPrintAns')})()`), prevOk);
  A('F-26 注入 #printArea 的只有试卷', await cdp.evalJs(`(function(){var a=CTB.views.paper.fillPrintArea('paper');return !/答案册/.test(a.innerHTML)})()`));
  await cdp.evalJs(`document.getElementById('printArea').innerHTML='';CTB.model.basketSet([])`);
  /* F-33 */
  A('F-33 部分失败只清成功条目', await cdp.evalJs(`(function(){
    var snap=localStorage.getItem('ctb2.pendingLocal');
    localStorage.setItem('ctb2.pendingLocal',JSON.stringify({T001:{action:'答',answer:'x'},T999:{action:'答',answer:'y'}}));
    var r=CTB.views.pending.applyPkgResults([{id:'T001',status:'ok'},{id:'T999',status:'missing'}],['T001','T999']);
    var m=JSON.parse(localStorage.getItem('ctb2.pendingLocal')||'{}');
    if(snap===null)localStorage.removeItem('ctb2.pendingLocal');else localStorage.setItem('ctb2.pendingLocal',snap);
    return !!m.T999&&!m.T001&&r.cleared.length===1&&r.kept[0].status==='missing'})()`));
  /* F-57：真实卡片上的相对题图必须能加载（11 张卡的样本） */
  const IMG = JSON.parse(await cdp.evalJs(`(async function(){
    var xs=CTB.model.cards.filter(function(x){return /<img/i.test(x.card.stemHtml||'')});
    if(!xs.length)return JSON.stringify({n:0});
    var res=[],tried=0;
    for(var i=0;i<xs.length&&tried<6;i++){
      var x=xs[i],h=CTB.model.stemHtmlSafe(x.card),m=h.match(/<img[^>]*src="([^"]+)"/i);
      if(!m)continue;tried++;
      var probe=await new Promise(function(r){var im=new Image();im.onload=function(){r('OK '+im.naturalWidth+'x'+im.naturalHeight)};im.onerror=function(){r('ERR')};im.src=m[1];setTimeout(function(){r('TIMEOUT')},8000)});
      res.push({id:x.card.id,src:m[1].slice(-40),r:probe});
    }
    return JSON.stringify({n:xs.length,res:res})})()`));
  if (!IMG.n) P('[SKIP] F-57 没有内联 <img> 的卡');
  else {
    P('[i] F-57 内联图卡数=' + IMG.n + ' 抽样=' + JSON.stringify(IMG.res));
    A('F-57 题干内的相对题图真能加载（抽样）', IMG.res.length > 0 && IMG.res.every(x => String(x.r).startsWith('OK')), JSON.stringify(IMG.res));
  }
  A('F-58 有 fig 无内联图 → 补出题图（真实卡 C0003）', await cdp.evalJs(`(function(){
    var x=CTB.model.cards.filter(function(c){return c.card.fig&&!/<img|<svg/i.test(c.card.stemHtml||'')})[0];
    if(!x)return 'SKIP-no-sample';
    return /<img/i.test(CTB.model.stemHtmlSafe(x.card))&&/题图|%E9%A2%98%E5%9B%BE/.test(CTB.model.stemHtmlSafe(x.card))})()`));
  /* 全页无 JS 异常 */
  A('全程无 JS 异常/console.error', cdp.errs.length === 0, cdp.errs.slice(0, 4).join(' || '));

  cdp.close();
  child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  P('RESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS'));
  fs.writeFileSync(OUT, log.join('\r\n'), 'utf8');
  process.exit(fails ? 1 : 0);
})().then(async () => { if (__srv) await __srv.stop(); }).catch(async e => { if (__srv) await __srv.stop(); P('[EXC] ' + (e && e.stack || e)); try { fs.writeFileSync(OUT, log.join('\r\n'), 'utf8'); } catch (_) { } process.exit(3); });
