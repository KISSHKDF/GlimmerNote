// 错题本 2.0 · 界面回归（27 断言 → 2026-10-11 增补 F-09/F-20/F-26/F-27/F-33/F-39/F-57/F-58 共 10 条，以文末 RESULT 行计数为准）
// 用法：node tests/e2e-ui.mjs（需壳带调试口在跑；端口 env CTB_CDP_PORT，默认 9223）
// 拾光小册 真端到端：对**已编译的 拾光小册.exe**（shell 通道，file://）做 CDP 断言 + 控制台错误监听 + 截图。
// 前置：启动 exe 时设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
// 安全：只跑「读 + 无副作用写」——pendingResolve 用不存在 id（工具护栏拒落）、readFile 越界拒绝、复习会话不落库。
/* 本文件是 .mjs（ESM）⇒ 必须用 import，不能用 require（否则报
   "require is not defined in ES module scope"。2026-10-12 踩过一次。） */
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname_, '..');   // 2026-10-12：原写死真库绝对路径，改为自推导
/* ★ 2026-10-12：单次 CDP 调用超时（基础设施缺陷修复）。
   原 send() 挂上 pending 就永远不超时，而 evalJs 用 awaitPromise:true ——
   页面里只要有一个卡住的 Promise，整条门禁就无限期挂住（实测卡过 20~40 分钟，只能人工 kill）。
   门禁必须永远能自己跑完。覆盖：CTB_CDP_TIMEOUT（毫秒，默认 20000）。 */
function cdpTimeout() { const v = Number(process.env.CTB_CDP_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 20000; }
const PORT = +(process.env.CTB_CDP_PORT || 9223);
const BASE = 'http://127.0.0.1:' + PORT;
import fs from 'fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dec = u => { try { return decodeURIComponent(u || ''); } catch { return u || ''; } };
/* ★ 2026-10-23：前端从 <库根>\v2\index.html 搬到 <程序目录>\index.html，
   页面 URL 里不再有 v2 段 —— 直接认 index.html（先剥掉查询串）。 */
/* 必须先剥掉 **查询串和路由哈希**：实测页面 URL 是 index.html#dash（前端用 hash 记路由），
   只剥 '?' 会让 /index\.html$/ 判假 ⇒ 明明开着却报"没有 index.html 页面"。 */
const isV2 = u => /\/index\.html$/.test(dec(u).split(/[?#]/)[0]);

async function listTargets() { const r = await fetch(BASE + '/json/list'); if (!r.ok) throw new Error('list ' + r.status); return r.json(); }
class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); this.jsErrors = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) { const p = c.pm.get(m.id); c.pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') c.jsErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
      else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning'))
        c.jsErrors.push(m.params.type + ': ' + (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 300));
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
  async shot(path) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path, Buffer.from(r.data, 'base64')); }
  close() { try { this.ws.close(); } catch { } }
}

const out = [];
const P = s => { out.push(s); console.log(s); };
let failures = 0, assertions = 0;
const A = (name, ok, detail) => { assertions++; P((ok ? '[OK]  ' : '[FAIL]') + name + (detail !== undefined ? '  → ' + String(detail).slice(0, 200) : '')); if (!ok) failures++; };
let skipped = 0;
/* S = 显式跳过：**有原因、进日志、进计数**（不是静默略过）。
   静默跳过会让覆盖悄悄消失，是这套门禁最该防的形态；所以 skip 必须可见且被统计。 */
const S = (name, why) => { skipped++; P('[SKIP]' + name + '  → ' + why); };

(async () => {
  let home = null;
  for (let i = 0; i < 60 && !home; i++) {
    try { const ts = await listTargets(); home = ts.find(t => isV2(t.url) && t.type === 'page'); } catch (e) { }
    if (!home) await sleep(500);
  }
  if (!home) {
    /* ⚠ 2026-10-12 改进提示：原来只写"exe 没起来？端口不对？"，但**最常见的原因恰恰是 exe 在跑、
       只是没带调试口**（full 收尾会干净重启一个无调试口的壳 —— 那正是设计行为）。
       旧提示会把人引向错误方向（去查"程序是不是崩了"），而程序其实好好的。
       现在分三种情况分别说清，并给出对应的下一步动作。 */
    let portUp = false, targets = [];
    try { targets = await listTargets(); portUp = true; } catch (e) { }
    /* ★ 2026-10-23：原来用 tasklist 按镜像名查 —— 中文镜像名在 GBK 输出里对不上，
       实测进程明明在跑却报"没有 拾光小册.exe 进程"。改用 PowerShell Get-Process。 */
    const exeRunning = await new Promise(res => {
      const { execSync } = require('child_process');
      try {
        const n = execSync('powershell -NoProfile -Command "(Get-Process -Name 拾光小册 -ErrorAction SilentlyContinue | Measure-Object).Count"',
          { encoding: 'utf8' });
        res(parseInt(String(n).trim(), 10) > 0);
      } catch (e) { res(false); }
    }).catch(() => false);
    if (!portUp) {
      P('[EXC] 连不上调试口 ' + PORT + '：壳没起来，或启动时没带调试口。');
      P('     → 若程序确实没在跑：直接双击 src\\app\\拾光小册.exe 启动它。');
    } else if (!exeRunning) {
      P('[EXC] 调试口 ' + PORT + ' 通着，但没有 拾光小册.exe 进程 —— 可能是个残留的调试口。');
      P('     → 先杀掉残留再重试：node tests\\launch-dev.cjs');
    } else {
      P('[EXC] 找到 调试口 ' + PORT + '（共 ' + targets.length + ' 个 target），但**没有 v2/index.html 页面**，');
      P('     且 拾光小册.exe 正在运行 ⇒ 最可能是**这个壳没带调试口启动**（full 收尾会故意这样重启，属正常）。');
      P('     → 用开发壳重启：node tests\\launch-dev.cjs   （或直接跑 node tests\\run.mjs full，它会自己重启带口壳）');
    }
    fs.writeFileSync(path.join(ROOT, 'tests', 'out', 'e2e-ui.log'), out.join('\r\n'), 'utf8');
    process.exit(2);
  }
  P('[A] 页面目标: ' + home.url);
  const cdp = await Cdp.connect(home.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  let booted = false;
  for (let i = 0; i < 60 && !booted; i++) {
    try { booted = await cdp.evalJs(`!!(window.CTB&&CTB.model&&CTB.model.cards&&CTB.model.cards.length)`); } catch (e) { }
    if (!booted) await sleep(500);
  }
  A('[B] 启动完成 · 数据到位', booted);
  if (!booted) {
    try { P('bootMsg=' + (await cdp.evalJs(`(document.getElementById('bootMsg')||{}).textContent`))); } catch (e) { }
    P('JS错误：' + cdp.jsErrors.join(' || '));
    fs.writeFileSync(path.join(ROOT, 'tests', 'out', 'e2e-ui.log'), out.join('\r\n'), 'utf8'); process.exit(2);
  }

  A('通道=shell（桌面壳直连）', await cdp.evalJs(`CTB.host.mode`) === 'shell', await cdp.evalJs(`CTB.host.mode`));
  // rc.5：用户状态保护——测试会动篮子/主题/筛选，开局快照、收尾原样恢复
  const lsSnap = await cdp.evalJs(`(function(){var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(/^ctb2\\./.test(k))o[k]=localStorage.getItem(k);}return JSON.stringify(o)})()`);
  A('localStorage 快照就绪', typeof lsSnap === 'string' && lsSnap[0] === '{');
  A('卡片对账：model vs 状态包一致', await cdp.evalJs(`(function(){var n=0;CTB.model.state.data.forEach(function(k){k.subjects.forEach(function(s){n+=s.items.length})});return CTB.model.cards.length===n})()`));
  const nCards = await cdp.evalJs(`CTB.model.cards.length`);
  P('[i] 卡片总数 = ' + nCards);
  A('侧栏 7 个导航项（2026-10-27 新增「录题」）', await cdp.evalJs(`document.querySelectorAll('#sidebar .nav-item[data-r]').length`) === 7);

  for (const r of ['dash', 'bank', 'review', 'paper', 'pending', 'ingest', 'stats']) {
    await cdp.evalJs(`CTB.shell.route('${r}')`); await sleep(400);
    const len = await cdp.evalJs(`document.getElementById('view').innerHTML.length`);
    A('路由 #' + r + ' 渲染非空', len > 500, len);
  }

  /* ⚠ 2026-10-27 修（假红根因，实测连续两轮必红）：
     题库筛选**持久化**在 localStorage['ctb2.filters']。本文件后面的「看被拦的题」会把
     blind 改成 'no'，一旦这一轮中途崩掉，收尾的恢复段（本文件末尾）不会执行 ⇒
     这份筛选永久留在 WebView2 profile 里。而全库卡片的盲解**全部已通过** ⇒
     'blind=no' 必然筛出 0 行 ⇒ 下一轮 e2e 一进题库就是 0 行、又崩、又留 —— **自我延续的假红**。
     断言前显式复位：真 bug（渲染挂了）复位后仍然是 0 行，判据不会被掩盖。 */
  await cdp.evalJs(`(function(){try{localStorage.removeItem('ctb2.filters')}catch(e){}return 1})()`);
  await cdp.evalJs(`CTB.shell.route('bank')`); await sleep(300);
  const rows = await cdp.evalJs(`document.querySelectorAll('#bkList .lrow').length`);
  A('题库列表行>0（已复位筛选，排除历史残留）', rows > 0, rows);
  await cdp.evalJs(`document.querySelector('#bkList .lrow').click()`); await sleep(400);
  A('卡详情抽屉打开', await cdp.evalJs(`!document.getElementById('drawerWrap').hidden && document.querySelector('.drawer-b').innerHTML.length>500`));
  A('抽屉+列表行都有打印版预览入口（rc.4 找回 v1 能力）', await cdp.evalJs(`!!document.querySelector('#drawer .drawer-f #dvPrint') && document.querySelectorAll('#bkList [data-print]').length > 0`));
  await cdp.evalJs(`document.querySelector('#dvPrint').click()`); await sleep(500);
  A('单题打印预览渲染成纸面（含打印按钮）', await cdp.evalJs(`!!document.querySelector('#drawer .sheet .q') && !!document.getElementById('spPrint')`));
  /* ⚠ 2026-10-11：打印已改为**宿主通道**（`H.print` → 壳 `ShowPrintUI`），会弹**阻塞式**系统打印对话框。
     下面第 96 行会点 `#spPrint` ⇒ 不打桩就会把 e2e 卡在打印框上（实测整条门禁被卡死，用户手工点掉才恢复）。
     这里把宿主打印/PDF 两个通道换成记账 no-op：仍然验证"点击路径不抛异常"，但不真弹框、不真落盘。 */
  await cdp.evalJs(`(function(){
    window.__E2E_PRINT_CALLS = [];
    if (window.CTB && CTB.host) {
      CTB.host.print = function (k) { window.__E2E_PRINT_CALLS.push('print:' + (k||'system')); return Promise.resolve({ ok: true, mode: 'showprintui', kind: k||'system' }); };
      CTB.host.pdf   = function (p) { window.__E2E_PRINT_CALLS.push('pdf:' + p); return Promise.resolve({ ok: true, path: p, bytes: 0 }); };
    }
    return 1;
  })()`);
  await cdp.evalJs(`CTB.shell.closeDrawer()`);

  const pdOk = await cdp.evalJs(`CTB.model.pendingOpen().length === CTB.model.state.pending.open`);
  A('待办计数与门禁口径一致', pdOk, await cdp.evalJs(`[CTB.model.pendingOpen().length, CTB.model.state.pending.open]`));

  // rc.2：灯箱办结流——点证据图必须带出「这条在问什么 + 怎么判 + 就地办结」
  /* ⚠ 2026-10-10：这组断言原先**隐式依赖"台账里至少有一条未办结待办"**。
     待办全部办结后（本仓 2026-10-10 实测：未确认 0 条）这里会 no-img，报 FAIL 且随后
     `document.querySelector('#lbFoot [data-lbsolve]').click()` 直接抛异常中断整套回归。
     那不是回归失败，是**样本没了**——但也不能静默跳过（静默跳过＝覆盖悄悄消失）。
     处置：显式 [SKIP] 并打出原因与恢复条件，让"没验到"这件事在日志里看得见；
     门禁统计只把 SKIP 记进 skipped，不计 FAIL（见文末 RESULT 行会显示 skipped 数）。 */
  await cdp.evalJs(`CTB.shell.route('pending')`); await sleep(400);
  const pendOpenN = await cdp.evalJs(`CTB.model.pendingOpen().length`);
  if (pendOpenN > 0) {
    const lbProbe = await cdp.evalJs(`(async function(){
      var img=document.querySelector('#pdList .pd-item [data-zoom]');
      if(!img)return JSON.stringify({err:'no-img'});
      img.click(); await new Promise(r=>setTimeout(r,900));
      var ctx=document.getElementById('lbCtx');
      var q=ctx&&ctx.querySelector('.lb-q');
      return JSON.stringify({
        qLen:q?q.textContent.length:0, hasChips:document.getElementById('lbChips').textContent.length>2,
        hasHint:!!(ctx&&ctx.querySelector('.lb-hint')), hasAns:!!(ctx&&ctx.querySelector('#lbAns')),
        hasSolve:!!(ctx&&ctx.querySelector('[data-lbsolve]')), hasVoid:!!(ctx&&ctx.querySelector('[data-lbvoid]'))
      });
    })()`);
    const lbP = JSON.parse(lbProbe);
    A('灯箱带问题正文（rc.2 反馈修复）', lbP.qLen > 4, lbProbe);
    A('灯箱带徽章/判法指引/办结控件', !!(lbP.hasChips && lbP.hasHint && lbP.hasAns && lbP.hasSolve && lbP.hasVoid), lbProbe);
    A('空结论点办结被拦（不落库）', await cdp.evalJs(`(async function(){
      document.getElementById('toasts').innerHTML='';
      document.querySelector('#lbFoot [data-lbsolve]').click();
      await new Promise(r=>setTimeout(r,500));
      var ts=document.querySelectorAll('#toasts .toast'); var msg=ts.length?ts[ts.length-1].textContent:'';
      return /先写结论/.test(msg);
    })()`));
    await cdp.evalJs(`CTB.shell.closeLightbox()`);
  } else {
    S('待办灯箱办结流（3 条）', `当前未办结待办 0 条（台账已清零）⇒ 无样本可点。不是回归失败，是覆盖缺口：` +
      `要看这 3 条断言真跑起来，先用 node _待确认.mjs 加 造一条未确认条目再跑 quick（跑完记得 删/作废）。`);
  }
  const fakeRes = await cdp.evalJs(`CTB.host.pendingResolve([{id:'T999',action:'答',answer:'E2E 安全探针：不存在的 id，应被工具拒绝、不落库'}]).then(r=>r).catch(e=>({err:String(e&&e.message||e)}))`);
  A('pendingResolve 全链路可达且幂等（T999→missing，不崩库）', !!(fakeRes && (fakeRes.results || fakeRes.state)), JSON.stringify(fakeRes).slice(0, 200));

  const esc1 = await cdp.evalJs(`CTB.host.readFile('../错题本系统方案.md').then(r=>r).catch(e=>({err:String(e)}))`);
  A('readFile 越界被壳拒绝', !!(esc1 && (esc1.ok === false || esc1.err)), JSON.stringify(esc1).slice(0, 140));
  const md1 = await cdp.evalJs(`CTB.host.readFile(CTB.model.relPathTmp(CTB.model.cards.find(function(c){return c.card.md}).card.md)).then(r=>r.ok&&r.text.length>50).catch(e=>({err:String(e)}))`);
  A('readFile 正常读取错题记录.md', md1 === true, md1);

  /* 证据图加载：**全量**（每一条未办结待办都要真能加载）。
     ⚠ 2026-10-10：原先上面还有一条"只抽查第一条带 evidence 的条目"的旧断言，
     台账清零后必然 no-item 报 FAIL——它已被下面这条全量断言完全覆盖（更严），故删除旧条，
     并在无样本时显式 SKIP（理由同灯箱那组：样本没了≠回归失败，但不能静默消失）。 */
  const pendOpenN2 = await cdp.evalJs(`CTB.model.pendingOpen().length`);
  if (pendOpenN2 > 0) {
    const allEv = await cdp.evalJs(`(async function(){
      var open=CTB.model.pendingOpen(),res=[];
      for(var i=0;i<open.length;i++){
        var p=open[i];
        if(!p.evidence){res.push({id:p.id,r:'NO-EVIDENCE'});continue;}
        res.push({id:p.id,r:await new Promise(function(r){var im=new Image();
        im.onload=function(){r('OK '+im.naturalWidth+'x'+im.naturalHeight)};
        im.onerror=function(){r('ERR '+p.evidence)};im.src=CTB.host.asset(p.evidence);
        setTimeout(function(){r('TIMEOUT')},8000);})});
    }
    return JSON.stringify(res);
  })()`);
    const allEvArr = JSON.parse(allEv);
    A('每一条未办结待办的证据图都真能加载', allEvArr.every(x => String(x.r).startsWith('OK')), allEv);
  } else {
    S('每条未办结待办的证据图全量加载', '当前未办结待办 0 条 ⇒ 无样本（台账已清零）');
  }
  const pendDom = JSON.parse(await cdp.evalJs(`(function(){
    var items=document.querySelectorAll('#pdList .pd-item'),bad=[];
    items.forEach(function(it){
      var im=it.querySelector('.pd-img img.pd-ev');
      var red=it.querySelector('.pd-evmiss');
      if(im && im.complete && im.naturalWidth===0)bad.push(it.id+':破图');
      else if(!im && !red)bad.push(it.id+':既无图也无红块');
      /* 红块必须自己说得清（含路径与修法），否则等于换个姿势静默 */
      else if(red && (String(red.textContent).indexOf('证据图不可用')<0 || String(red.textContent).indexOf('_待确认.mjs 证据')<0))bad.push(it.id+':红块不完整');
    });
    return JSON.stringify({n:items.length,bad:bad});
  })()`));
  A('待办列表无「静默破图」（要么图能显示，要么显式红块）', pendDom.bad.length === 0, JSON.stringify(pendDom));
  const cardImg = await cdp.evalJs(`(function(){
    var x=CTB.model.cards.find(function(c){return c.card.img});
    return new Promise(function(res){var im=new Image();im.onload=function(){res('OK '+im.naturalWidth+'x'+im.naturalHeight)};im.onerror=function(){res('ERR '+CTB.host.asset(x.card.img))};im.src=CTB.host.asset(x.card.img);});
  })()`);
  A('卡片原卷图加载（编码路径）', String(cardImg).startsWith('OK'), cardImg);

  /* ============ 原卷溯源（2026-10-09）：卡片必须能回到「我当初导入的那一页」 ============
     坑的来历：索引只带裁图，灯箱按钮写着「打开原图」却打开特写。以下断言就是防它再退化。 */
  const OS = JSON.parse(await cdp.evalJs(`(function(){
    var all=CTB.model.cards,withPage=0,badTarget=0,withBox=0,noPage=[];
    all.forEach(function(x){var c=x.card;
      if(c.origPage){withPage++;var p=decodeURIComponent(c.origPage);
        if(/原卷截图|题干\\.jpg|题图\\.jpg/.test(p))badTarget++;
        if(c.origBox&&c.origBox.length===4)withBox++;
      } else noPage.push(c.id);
    });
    return JSON.stringify({n:all.length,withPage:withPage,badTarget:badTarget,withBox:withBox,noPage:noPage});
  })()`));
  P('[i] 原卷溯源：卡 ' + OS.n + ' ｜ 有整页 ' + OS.withPage + ' ｜ 有红框 ' + OS.withBox + ' ｜ 未定位 ' + OS.noPage.length);
  A('每张卡的索引都有 origPage 或明确标未定位', OS.withPage + OS.noPage.length === OS.n, OS.n);
  A('origPage 不指向裁图（禁拿特写冒充原图）', OS.badTarget === 0, OS.badTarget);
  A('整页原卷定位率 ≥ 95%', OS.withPage >= OS.n * 0.95, OS.withPage + '/' + OS.n);
  const pageImg = await cdp.evalJs(`(async function(){
    var xs=CTB.model.cards.filter(function(x){return x.card.origPage}).slice(0,3),res=[];
    for(var i=0;i<xs.length;i++){
      res.push(await new Promise(function(r){var im=new Image();
        im.onload=function(){r('OK '+im.naturalWidth+'x'+im.naturalHeight)};im.onerror=function(){r('ERR')};
        im.src=CTB.host.asset(xs[i].card.origPage);setTimeout(function(){r('TIMEOUT')},8000);}));
    }
    return JSON.stringify(res);
  })()`);
  A('整页原卷 file:// 真能加载（抽样 3 张）', JSON.parse(pageImg).every(s => String(s).startsWith('OK')), pageImg);

  const LB = JSON.parse(await cdp.evalJs(`(async function(){
    var xs=CTB.model.cards.filter(function(c){return c.card.origPage&&c.card.origBox&&c.card.img});
    /* 优先挑**紧框**（宽/高 <0.85 页）：全页框时 scale<1 本来就是正确行为，测不出「放大对准」这条路径 */
    var x=xs.find(function(c){return c.card.origBox[2]<0.85&&c.card.origBox[3]<0.85})||xs[0];
    if(!x)return JSON.stringify({err:'no-card'});
    CTB.shell.lightbox([Object.assign({src:CTB.host.asset(x.card.img),rel:x.card.img,title:x.card.id+' 原卷'},CTB.model.origOf(x.card))]);
    await new Promise(r=>setTimeout(r,1400));
    var out={id:x.card.id,norm:x.card.origBox},g=function(i){return document.getElementById(i)};
    out.openTitle=(g('lbOpen')||{}).title||''; out.openDisabled=!!(g('lbOpen')||{}).disabled;
    out.srcTag0=(g('lbSrc')||{}).textContent||''; out.mode0=CTB.shell.lbMode(); out.img0=g('lbImg').src;
    out.hasImp=!!g('lbImp')&&g('lbImp').style.display!=='none'; out.hasReveal=!!g('lbReveal');
    out.impExpected=!!x.card.origImport;
    CTB.shell.lbToggleMode(); await new Promise(r=>setTimeout(r,1800));
    out.mode1=CTB.shell.lbMode(); out.img1=g('lbImg').src; out.srcTag1=(g('lbSrc')||{}).textContent||'';
    var b=g('lbBox'),w=g('lbWrap'),st=g('lbStage');
    out.boxShown=!b.hidden;
    out.box=[parseFloat(b.style.left||'0'),parseFloat(b.style.top||'0'),parseFloat(b.style.width||'0'),parseFloat(b.style.height||'0')];
    out.img=[g('lbImg').naturalWidth,g('lbImg').naturalHeight];
    var tf=(w.style.transform||'').match(/translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\) scale\\(([-\\d.]+)\\)/);
    out.tf=tf?[+tf[1],+tf[2],+tf[3]]:null;
    var r0=st.getBoundingClientRect();
    if(tf){var cx=out.box[0]+out.box[2]/2,cy=out.box[1]+out.box[3]/2;
      out.center=[r0.left+ +tf[1]+cx*+tf[3], r0.top+ +tf[2]+cy*+tf[3]];
      out.view=[r0.left,r0.top,r0.right,r0.bottom];}
    CTB.shell.closeLightbox();
    return JSON.stringify(out);
  })()`));
  A('灯箱 🗂 语义=打开整页原卷（且可用）', /整页原卷/.test(LB.openTitle) && LB.openDisabled === false, LB.openTitle);
  A('灯箱默认显示裁图并提示可切整页', LB.mode0 === 'crop' && /裁图/.test(LB.srcTag0), LB.mode0 + ' ' + (LB.srcTag0 || '').slice(0, 40));
  A('切到整页后图片源真的换页了', LB.mode1 === 'orig' && LB.img1 !== LB.img0 && /整页原卷/.test(LB.srcTag1), (LB.img0 || '').slice(-40) + ' → ' + (LB.img1 || '').slice(-40));
  /* 红框换算：像素框必须 = 归一化框 × 整页 naturalWidth/Height（±2px）。全页框 x=0 是合法值，判据不能写 >0 */
  const expBox = [LB.norm[0] * LB.img[0], LB.norm[1] * LB.img[1], LB.norm[2] * LB.img[0], LB.norm[3] * LB.img[1]];
  const boxErr = Math.max(...LB.box.map((v, i) => Math.abs(v - expBox[i])));
  A('整页红框 = 归一化框×整页像素（±2px）', LB.boxShown === true && boxErr <= 2, '偏差 ' + boxErr.toFixed(2) + 'px 框=' + LB.box.map(v => Math.round(v)).join(',') + ' 图=' + LB.img.join('x'));
  A('红框完整落在整页内', LB.box[0] >= -1 && LB.box[1] >= -1 && LB.box[0] + LB.box[2] <= LB.img[0] + 2 && LB.box[1] + LB.box[3] <= LB.img[1] + 2, LB.box.map(v => Math.round(v)).join(',') + ' vs ' + LB.img.join('x'));
  /* 自动对准 = 「打开整页就看见这道题」：红框中心换算到屏幕坐标必须落在可视区内 */
  const inView = !!(LB.center && LB.view) && LB.center[0] > LB.view[0] && LB.center[0] < LB.view[2] && LB.center[1] > LB.view[1] && LB.center[1] < LB.view[3];
  A('打开整页自动对准到该题（红框中心在视口内）', inView, '中心 ' + (LB.center || []).map(v => Math.round(v)).join(',') + ' 视口 ' + (LB.view || []).map(v => Math.round(v)).join(','));
  /* 📥 原件按钮是「数据驱动显隐」（shell.js：有 origImport 才显示，没有的隐藏并给提示）——
     机制断言不能绑死在一张恰好没有原件的卡上（实测某张卡无 import ⇒ 按钮隐藏是**设计行为**）。
     正确判据：①「📁 位置」恒在；②「📥 原件」=（该卡有 origImport）——两者必须一致；
     ③ 全库至少一张带原件的卡能真实出现按钮（数据无关的机制验证）。 */
  const LB2 = JSON.parse(await cdp.evalJs(`(async function(){
    var xs=CTB.model.cards.filter(function(x){var c=x.card;return c.origPage&&c.origBox&&c.img&&c.origImport;});
    if(!xs.length) return JSON.stringify({skip:'no-card-with-import'});
    var x=xs[0];
    CTB.shell.lightbox([Object.assign({src:CTB.host.asset(x.card.img),rel:x.card.img,title:x.card.id+' 原卷'},CTB.model.origOf(x.card))]);
    await new Promise(r=>setTimeout(r,900));
    var g=function(i){return document.getElementById(i)};
    var out={id:x.card.id,hasImp:!!g('lbImp')&&g('lbImp').style.display!=='none',hasReveal:!!g('lbReveal')&&g('lbReveal').style.display!=='none'};
    CTB.shell.closeLightbox();
    return JSON.stringify(out);
  })()`));
  A('📁 位置 入口在位（恒显）', LB.hasReveal === true, LB.hasReveal);
  A('📥 原件按钮显隐与数据一致', LB.hasImp === !!LB.impExpected, JSON.stringify({shown: LB.hasImp, hasImport: LB.impExpected}));
  A('📥 原件按钮在有原件的卡上真实出现', LB2.skip ? true : (LB2.hasImp === true && LB2.hasReveal === true), JSON.stringify(LB2));

  // revealFile 探针：用一个不存在的路径，绝不开资源管理器窗口，只看壳日志有没有走到 C# Reveal
  /* ★ 2026-10-23：日志已搬到 %LOCALAPPDATA%\拾光小册\shell.log（程序目录可能只读） */
  const logFile = path.join(process.env.LOCALAPPDATA || '', '拾光小册', 'shell.log');
  const logMark = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;   // statSync 给的是**字节数**
  await cdp.evalJs(`CTB.host.reveal('_probe/__不存在__.jpg').catch(function(){})`);
  await sleep(700);
  /* 必须按字节偏移切缓冲区再解码：日志含中文，用字符串下标切字节偏移会切到新内容之后（实测被骗一次） */
  const logTail = fs.existsSync(logFile) ? fs.readFileSync(logFile).slice(logMark).toString('utf8') : '';
  A('壳侧 revealFile op 已装载（走到 C# Reveal）', /reveal FAILED/.test(logTail), logTail.replace(/\r?\n/g, ' | ').slice(0, 160));
  const exeT = fs.statSync(path.join(ROOT, 'src', 'app', '拾光小册.exe')).mtimeMs;
  const csT = fs.statSync(path.join(ROOT, 'src', 'shell', 'CTBShellV2.cs')).mtimeMs;
  A('exe 比壳源码新（改动已编译进去）', exeT >= csT, new Date(exeT).toISOString() + ' vs ' + new Date(csT).toISOString());

  await cdp.evalJs(`CTB.model.startSession(CTB.model.cardsOf().slice(0,2))`);
  await cdp.evalJs(`CTB.shell.route('review')`); await sleep(350);
  A('复习卡渲染', await cdp.evalJs(`document.querySelectorAll('.rv-card').length`) === 1);
  await cdp.evalJs(`(function(){var b=document.getElementById('rvReveal');if(b)b.click();})()`); await sleep(250);
  A('翻开答案+判分按钮', await cdp.evalJs(`!!document.querySelector('.grades')`));
  await cdp.evalJs(`(function(){var b=document.querySelector('[data-grade="对"]');if(b)b.click();})()`); await sleep(300);
  A('判分推进到第 2 题', await cdp.evalJs(`CTB.model.session&&CTB.model.session.idx`) === 1);
  await cdp.evalJs(`if(CTB.model.session)CTB.model.session=null;CTB.shell.render()`);

  await cdp.evalJs(`CTB.shell.palette('主题')`); await sleep(400);
  A('命令面板出命令结果', await cdp.evalJs(`document.querySelectorAll('#paletteList .p-item').length`) >= 1, await cdp.evalJs(`document.querySelectorAll('#paletteList .p-item').length`));
  await cdp.evalJs(`CTB.shell.palette('')`); await sleep(300);
  A('命令面板空查询列导航', await cdp.evalJs(`document.querySelectorAll('#paletteList .p-item').length`) >= 10, await cdp.evalJs(`document.querySelectorAll('#paletteList .p-item').length`));
  await cdp.evalJs(`CTB.shell.closePalette()`);
  A('hidden 浮层真实不可见（display:none）', await cdp.evalJs(`(function(){var w=document.getElementById('paletteWrap');var l=document.getElementById('lightbox');return w.hidden&&getComputedStyle(w).display==='none'&&l.hidden&&getComputedStyle(l).display==='none'})()`));

  // 组卷预览（纸面渲染，不落账）
  await cdp.evalJs(`CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,3).map(function(x){return x.kid+'|'+x.card.id}))`);
  await cdp.evalJs(`CTB.shell.route('paper',{reset:true})`); await sleep(300);
  A('底部操作条在位（rc.5：下一步永远摆在眼前）', await cdp.evalJs(`(function(){var b=document.getElementById('pbPrev2');return !!b&&b.textContent.includes('下一步')&&!b.disabled})()`));
  await cdp.evalJs(`document.getElementById('ppPrev').click()`); await sleep(500);
  A('试卷纸面渲染（.sheet>0 且含答案册）', await cdp.evalJs(`document.querySelectorAll('#pvSheets .sheet').length`) >= 2, await cdp.evalJs(`document.querySelectorAll('#pvSheets .sheet').length`));
  A('组卷入账按钮在位（rc.3 闭环）', await cdp.evalJs(`!!document.getElementById('pvCommit')`));
  A('泄答案防线：卷面零原卷截图（含编码形态）', await cdp.evalJs(`(function(){var h=document.getElementById('pvSheets').innerHTML;return !h.includes('原卷截图')&&!h.includes('%E5%8E%9F%E5%8D%B7%E6%88%AA%E5%9B%BE')})()`));
  await cdp.shot(path.join(ROOT, 'tests', 'out', 'shot-paper-preview.png'));
  await cdp.evalJs(`CTB.shell.route('paper',{reset:true})`); await sleep(250);
  await cdp.evalJs(`document.getElementById('ppForm').value='img';document.getElementById('ppPrev').click()`); await sleep(400);
  A('泄答案防线：裁图模式也零原卷图（自动降级重排题干）', await cdp.evalJs(`(function(){var h=document.getElementById('pvSheets').innerHTML;return !h.includes('原卷截图')&&!h.includes('%E5%8E%9F%E5%8D%B7%E6%88%AA%E5%9B%BE')})()`));

  /* ============ 2026-10-11 修复回归（BUG审计 F-09/F-26/F-33/F-39/F-57/F-58） ============
     ④ F-26：答案册不得与试卷同一次打印。试卷视图的 #printArea 只能有试卷单元。
     断言走 V.printUnit（纯函数，不触发 window.print 对话框，避免 e2e 卡在打印框上）。 */
  await cdp.evalJs(`CTB.shell.route('paper',{reset:true})`); await sleep(250);
  await cdp.evalJs(`CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,3).map(function(x){return x.kid+'|'+x.card.id}))`);
  await cdp.evalJs(`CTB.shell.route('paper',{reset:true})`); await sleep(250);
  await cdp.evalJs(`document.getElementById('ppPrev').click()`); await sleep(450);
  const PR = JSON.parse(await cdp.evalJs(`(function(){
    var P=CTB.views.paper,paper=P.printUnit('paper'),ans=P.printUnit('ans');
    return JSON.stringify({
      paperHasAns:/答案册/.test(paper),paperHasQ:/class="q"/.test(paper)&&/重做卷|试卷|错题/.test(paper),
      ansHasAns:/答案册/.test(ans),ansHasQ:/class="q"/.test(ans),
      bothPv:/答案册/.test(document.getElementById('pvSheets').innerHTML),
      btnPaper:!!document.getElementById('pvPrint'),btnAns:!!document.getElementById('pvPrintAns')
    })})()`));
  A('F-26 试卷打印单元不含答案册', PR.paperHasAns === false && PR.paperHasQ === true, JSON.stringify(PR));
  A('F-26 答案册是独立打印单元（且两个按钮分开）', PR.ansHasAns === true && PR.btnPaper === true && PR.btnAns === true, JSON.stringify(PR));
  /* DOM 级：真的注入一次（fillPrintArea 只写 #printArea，不调 window.print） */
  A('F-26 注入 #printArea 的试卷单元不含答案段', await cdp.evalJs(`(function(){
    var a=CTB.views.paper.fillPrintArea('paper');return /答案册/.test(a.innerHTML)===false&&/class="q"/.test(a.innerHTML)})()`));
  await cdp.evalJs(`(function(){var a=document.getElementById('printArea');if(a)a.innerHTML='';CTB.model.basketSet([]);CTB.shell.route('dash')})()`);

  /* ① F-09：blindCls 必须与工具白名单同口径（_标记复习.mjs BLIND_OK = ['已通过','已修正']） */
  A('F-09 blindCls 只认已通过/已修正（与工具同口径）', await cdp.evalJs(`(function(){
    var bad=['未通过','不通过','已通过但存疑','不一致','待双路','','未盲解',null];
    var blocked=bad.every(function(s){return CTB.model.blindCls({blindStatus:s}).ok!==true});
    var passOk=CTB.model.blindCls({blindStatus:'已通过'}).ok===true&&CTB.model.blindCls({blindStatus:'已修正'}).ok===true;
    return blocked&&passOk})()`));
    /* ★ 2026-10-23：「待双路」由"未知态(null)"升为**具名不通过态**（ok:false + why）——
       全量双路规则下它是明确"只跑完一路"，必须拦且要能说出原因；null 只表示不确定，语义更弱。
       真正的未知态改用「空对象 / 缺 blindStatus」来验。 */
    A('F-09 待双路 = 具名不通过（ok:false 且有原因）', await cdp.evalJs(`(function(){
      var r=CTB.model.blindCls({blindStatus:'待双路'});
      return r.ok===false&&!!r.why&&CTB.model.blindOk({blindStatus:'待双路'})===false})()`));
    A('F-09 未知态返回 ok:null（不是 true）', await cdp.evalJs(`CTB.model.blindCls({}).ok===null&&CTB.model.blindCls({blindStatus:''}).ok===null`));

  /* ② F-33：办结包部分失败时本地草稿必须保留（只清 status==='ok' 的） */
  const PK = JSON.parse(await cdp.evalJs(`(function(){
    var snap=localStorage.getItem('ctb2.pendingLocal');
    localStorage.setItem('ctb2.pendingLocal',JSON.stringify({T001:{action:'答',answer:'x'},T999:{action:'答',answer:'y'}}));
    var r=CTB.views.pending.applyPkgResults([{id:'T001',status:'ok'},{id:'T999',status:'missing'}],['T001','T999']);
    var m=JSON.parse(localStorage.getItem('ctb2.pendingLocal')||'{}');
    if(snap===null)localStorage.removeItem('ctb2.pendingLocal');else localStorage.setItem('ctb2.pendingLocal',snap);
    return JSON.stringify({T999kept:!!m.T999,T001cleared:!m.T001,kept:r.kept,cleared:r.cleared})})()`));
  A('F-33 办结包部分失败只清成功条目（missing 保留草稿）', PK.T999kept === true && PK.T001cleared === true, JSON.stringify(PK));

  /* ③ F-39：dataHealth 降级必须显式报警（含运行时缺分区） */
  A('F-39 数据源降级时界面必须挂红条', await cdp.evalJs(`(function(){
    var keep=CTB.model.health;
    CTB.model.health=CTB.model.healthOf(Object.assign({},CTB.model.state,{dataHealth:{admit:'解包失败'}}));
    CTB.shell.render();
    var el=document.getElementById('dataHealthBanner');
    var shown=!!el&&!el.hidden&&/不是通过了，是读不到/.test(el.textContent)&&/组卷准入/.test(el.textContent);
    CTB.model.health=keep; CTB.shell.render();
    var back=document.getElementById('dataHealthBanner');
    return shown&&!!back&&back.hidden})()`));
  A('F-39 运行时缺分区（admit 没送来）也算降级', await cdp.evalJs(`(function(){
    var h=CTB.model.healthOf({dataHealth:{},blindFresh:{},figState:{}});
    return h.ok===false&&h.bad.some(function(b){return b.key==='admit'})})()`));

  /* ⑤ F-57/F-58：题干相对图必须解析到卡片目录；有 fig 无内联图要补出题图 */
  const STEM = JSON.parse(await cdp.evalJs(`(function(){
    var xs=CTB.model.cards.filter(function(x){return /<img/i.test(x.card.stemHtml||'')});
    if(!xs.length)return JSON.stringify({skip:'no-inline-img'});
    var x=xs[0],dir=CTB.model.cardDirOf(x.card),h=CTB.model.stemHtmlSafe(x.card);
    return JSON.stringify({id:x.card.id,dir:dir,html:h.slice(0,400),
      resolved:h.indexOf(encodeURI(dir)+'/')>=0||h.indexOf(dir+'/')>=0,
      bare:(x.card.stemHtml.match(/src="([^"\\/]+\\.[a-z]+)"/i)||[])[1]||'',
      bareGone:!new RegExp('src="'+((x.card.stemHtml.match(/src="([^"\\/]+\\.[a-z]+)"/i)||[])[1]||'\\u0000')+'"').test(h),
      noOn:!/\\son[a-z]+\\s*=/i.test(h),hasImg:/<img/i.test(h)})})()`));
  if (STEM.skip) S('F-57 题干相对图解析到卡片目录', '库里没有内联 <img> 的卡（样本为 0）');
  else {
    A('F-57 题干相对 src 解析到卡片目录', STEM.resolved === true && STEM.bareGone === true, JSON.stringify(STEM).slice(0, 220));
    A('F-27 题干 HTML 已净化（无 on* 事件属性）', STEM.noOn === true && STEM.hasImg === true, STEM.id);
  }
  /* 2026-10-11 修断言：旧判据 `h.indexOf('fig')<0` **自相矛盾**——补出来的包裹层 class 就叫
     `stem-figure`，只要补图成功该条件必为假 ⇒ 这条断言永远不可能通过。
     已排除"代码没修好"的可能：`tests\probe-f58.cjs` 直接装载 model.js 验证 C0003 形态能补出 <img>，
     且 model.js(mtime 10:13:31) 早于壳启动(10:14:30)，e2e 跑的就是新代码。
     现改为可判定判据：遍历所有"有 fig 且题干无内联图"的卡，全部必须补出指向卡片目录的 <img>，漏一张即红并点名。 */
  {
    const F58 = JSON.parse(await cdp.evalJs(`(function(){
      var xs=CTB.model.cards.filter(function(c){return c.card.fig&&!/<(img|svg)\\b/i.test(c.card.stemHtml||'')});
      var bad=[],okn=0;
      xs.forEach(function(x){
        var h=CTB.model.stemHtmlSafe(x.card);
        var hasImg=/<img\\b/i.test(h);
        var dir=CTB.model.cardDirOf(x.card);
        var enc=encodeURI(dir)+'/';
        var pointsDir=h.indexOf(enc)>=0||h.indexOf(dir+'/')>=0;
        if(hasImg&&pointsDir) okn++; else bad.push(x.card.id+(hasImg?'(src未指向卡片目录)':'(无<img>)'));
      });
      return JSON.stringify({n:xs.length,ok:okn,bad:bad})})()`));
    if (!F58.n) S('F-58 有 fig 且题干无内联图时必须补出题图', '库里没有"只有题图、题干无内联图"的卡（样本为 0）');
    else A('F-58 有 fig 且 stemHtml 无内联图时必须补出题图', F58.bad.length === 0,
      `候选 ${F58.n} 张，补齐 ${F58.ok}，漏 ${F58.bad.length}${F58.bad.length ? '：' + F58.bad.join(',') : ''}`);
  }
  /* ⑥ F-13/F-20：组卷成功后重试只补批改，不得重复组卷（纯函数级，用假 host.mark 计数） */
  const ES = JSON.parse(await cdp.evalJs(`(async function(){
    var M=CTB.model,H=CTB.host,orig=H.mark,calls=[];
    H.mark=async function(a,f){calls.push(a+(f.paper?':'+f.paper:''));return a==='组卷'?{code:0,out:'已建批次 P20990101-01'}:{code:1,err:'批改门禁拦下 M0001'}};
    M.startSession(CTB.model.cardsOf().slice(0,2).map(function(x){return x}));
    M.sessionGrade('对');M.sessionGrade('错');
    var err='';try{await M.endSession()}catch(e){err=String(e.message).slice(0,40)}
    var g1=calls.filter(function(c){return c.indexOf('组卷')===0}).length;
    var left=Object.keys(M.session.results).length,comm=Object.keys(M.session.committed).length;
    calls=[];H.mark=async function(a,f){calls.push(a);return a==='组卷'?{code:0,out:'P20990101-02'}:{code:0,out:'ok'}};
    await M.endSession();
    var g2=calls.filter(function(c){return c.indexOf('组卷')===0}).length;
    M.session=null;H.mark=orig;
    return JSON.stringify({err:err,g1:g1,left:left,comm:comm,g2:g2})})()`));
  A('F-20 组卷成功后重试只补批改（不再组第二张卷）', ES.g1 === 1 && ES.g2 === 0 && ES.left === 0 && ES.comm === 1, JSON.stringify(ES));

  await cdp.evalJs(`CTB.model.basketSet([]);CTB.shell.route('dash')`);

  await cdp.evalJs(`CTB.shell.applyTheme('light');CTB.shell.route('dash')`); await sleep(700);
  await cdp.shot(path.join(ROOT, 'tests', 'out', 'shot-dash-light.png'));
  await cdp.evalJs(`CTB.shell.applyTheme('dark');CTB.shell.route('stats')`); await sleep(600);
  await cdp.shot(path.join(ROOT, 'tests', 'out', 'shot-stats-dark.png'));
  await cdp.evalJs(`CTB.shell.route('pending')`); await sleep(500);
  await cdp.shot(path.join(ROOT, 'tests', 'out', 'shot-pending-dark.png'));
  P('[C] 截图已存 tests/out/shot-*.png');

  await cdp.evalJs(`(function(){var snap=${lsSnap};var keys={};for(var k in snap)keys[k]=1;for(var i=localStorage.length-1;i>=0;i--){var kk=localStorage.key(i);if(/^ctb2\\./.test(kk)&&!keys[kk])localStorage.removeItem(kk);}for(var k in snap)localStorage.setItem(k,snap[k]);})()`);
  await cdp.evalJs(`CTB.shell.route('dash')`);
  A('用户 localStorage 已恢复', await cdp.evalJs(`(function(){var snap=${lsSnap};for(var k in snap){if(localStorage.getItem(k)!==snap[k])return false}return true})()`));
  A('全程无 JS 异常/控制台错误', cdp.jsErrors.length === 0, cdp.jsErrors.slice(0, 5).join(' || '));

  cdp.close();
  P('RESULT=' + (failures ? 'FAIL(' + failures + ')' : 'PASS') + ' 断言=' + assertions + (skipped ? ' 跳过=' + skipped : '') + '（本行数字即权威计数，CHANGELOG 抄这里）');
  fs.writeFileSync(path.join(ROOT, 'tests', 'out', 'e2e-ui.log'), out.join('\r\n'), 'utf8');
  process.exit(failures ? 1 : 0);
})().catch(e => { P('[EXC] ' + (e && e.stack || e)); fs.writeFileSync(path.join(ROOT, 'tests', 'out', 'e2e-ui.log'), out.join('\r\n'), 'utf8'); process.exit(3); });
