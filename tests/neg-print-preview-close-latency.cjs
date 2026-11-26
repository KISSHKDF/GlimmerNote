#!/usr/bin/env node
/**
 * 拾光小册 · 「打印预览开着时点『关闭』没反应」回归（2026-11-27 建）
 *
 * 用户报障（配截图）：
 *   「点击『关闭』时，反应特别慢」
 *
 * 实测复盘（壳日志 + CDP/OS 双路取证，过程见 CHANGELOG 2026.11.27.02）：
 *
 *   ① 壳日志 16:29:50 出现 `print: ShowPrintUI(Browser)` ⇒ 用户点了「🖨 打印这一题」，
 *      壳弹了**浏览器式打印预览**。
 *   ② OS 级截图证实：**那个预览是盖在主窗口内容区里的整屏原生层**
 *      （可见窗口枚举只有主窗「拾光小册」⇒ **它不是独立 Win32 窗口**）。
 *   ③ 预览开着期间，**主页面一个鼠标事件都收不到**
 *      （CDP Input 派发 0 命中；连临时插进页面的探针按钮也收不到 click）⇒
 *      用户回到主界面点「关闭」，**那一下根本没送到页面** ⇒ 抽屉纹丝不动
 *      ⇒ 表现为「点了没反应 / 特别慢」。
 *   ④ 预览关掉后，点击**立刻**恢复（CDP 实测：click 到达、抽屉秒关）。
 *
 * ⇒ 修法（全部落在页面侧，因为壳侧**给不出**"预览已关闭"的信号：
 *      WebView2 SDK 1.0.2903.40 只有 ShowPrintUI/PrintAsync/PrintToPdf*，无对话框事件；
 *      预览又不是独立窗口 ⇒ 窗口标题判据同样不成立）：
 *      · 打印遮罩**不再拦点击**（背景 pointer-events:none，只有说明卡片可点）
 *        ⇒ 它不会变成"点了没反应"的**第二道墙**；
 *      · 页面装「输入回来了吗」探针（捕获阶段的一次性 click 监听）：
 *        页面一旦收到任何 click ⇒ 预览已关 ⇒ 立刻撤遮罩；
 *      · focus 事件保留为兜底，延迟 600ms → 150ms。
 *
 * 本用例守（不依赖原生预览弹窗，用**可机械判定的等价条件**）：
 *   S/L. 静态判据：CSS 的 pointer-events 布局、探针接线、focus 兜底；
 *   U.   动态判据：遮罩开着时，页面**下面的**按钮**第一下就能点到**（旧实现会被遮罩吃掉 ⇒ 必红）；
 *   N.   阴性自证：把「背景 pointer-events:none」改回 auto ⇒ U 必须变红
 *        （证明这条判据真的会红，不是恒真）。
 *
 * ⚠ CDP 用法上的两个坑（都实测踩过，注释里写清楚，免得下一个人再踩）：
 *   ① 目标必须挑**主文档**：打印预览（edge://print）也是 page 型 target，
 *      它的 document 不是主文档 ⇒ 在那儿跑判据会报莫名其妙的错。
 *   ② **不要用 async IIFE + awaitPromise**：页面 hash 变化会换执行上下文，
 *      带 await 的表达式可能落进**已销毁的上下文** ⇒ 报
 *      "document.getElementById is not a function"（而同一页上同步表达式完全正常）。
 *      ⇒ 本文件的判据一律**同步**；需要等的地方在 Node 侧 sleep 后再发下一次 evaluate。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'src', 'app');
const shellJs = fs.readFileSync(path.join(APP, 'js', 'shell.js'), 'utf8');
const appCss = fs.readFileSync(path.join(APP, 'css', 'app.css'), 'utf8');

let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ───────────────── CDP 客户端（长连接 + 自检主页面） ───────────────── */
let CDP = null;
function cdpTargets() {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9223, path: '/json/list' }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
async function cdpConnect() {
  if (CDP) return CDP;
  const ts = await cdpTargets();
  const t = ts.find(x => x.type === 'page'
    && /index\.html(#|$)/.test(x.url || '')
    && !/edge:\/\/print|chrome-untrusted/.test(x.url || ''));
  if (!t) throw new Error('没有可调试的主页面目标（现有：' +
    ts.map(x => x.type + ' ' + (x.url || '').slice(0, 40)).join(' | ') + '）');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const q = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && q.has(m.id)) { const p = q.get(m.id); q.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (m, pa) => new Promise((res, rej) => { const i = ++id; q.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: pa })); });
  await send('Runtime.enable');
  CDP = { ws, send };
  /* ⚠ 自检：连上的确实是主页面（打印预览也是 page 型 target） */
  const here = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  const href = String(here.result && here.result.value || '');
  if (!/index\.html(#|$)/.test(href)) {
    try { ws.close(); } catch { }
    CDP = null;
    throw new Error('连上的不是主页面（href=' + href + '）');
  }
  return CDP;
}
/** 同步求值（**不要**加 awaitPromise：hash 变化会换上下文，带 await 会落进已销毁的上下文） */
async function ev(expr, timeoutMs = 15000) {
  const c = await cdpConnect();
  const r = await Promise.race([
    c.send('Runtime.evaluate', { expression: expr, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时 ' + timeoutMs + 'ms')), timeoutMs)),
  ]);
  if (r.exceptionDetails) {
    let ctx = '';
    try {
      const probe = await c.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      ctx = ' | href=' + (probe.result && probe.result.value);
    } catch { }
    throw new Error('页面内异常：' + JSON.stringify(r.exceptionDetails).slice(0, 260) + ctx);
  }
  return r.result && r.result.value;
}
/** 等应用就绪：① CTB.shell.printLock 在 **且** ② 启动遮罩 #boot 已退场。
   ⚠ ② 不能少（实测踩过）：#boot 是 z-index:999 的全屏启动遮罩，boot() 完成才 remove；
     只判 ① 时它可能还盖着 ⇒ elementFromPoint 命中的是 boot ⇒ 判据假红。 */
async function waitPageReady(maxMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const s = await ev("JSON.stringify({ctb:typeof CTB, fn:typeof (window.CTB&&CTB.shell&&CTB.shell.printLock), boot:!!document.getElementById('boot')})");
      const j = JSON.parse(s);
      if (j.ctb === 'object' && j.fn === 'function' && j.boot === false) return true;
    } catch { }
    await sleep(500);
  }
  throw new Error('页面没就绪（' + maxMs + 'ms 内没等到「CTB 就位 且 启动遮罩退场」）');
}

/* ───────────────── 判据 ───────────────── */
async function main() {
  console.log('── 静态判据：CSS 与接线 ──');

  const lockCss = (appCss.match(/\.print-lock\{[^}]*\}/) || [''])[0];
  A('S1 打印遮罩的背景层是 pointer-events:none（不拦点击）',
    /pointer-events\s*:\s*none/.test(lockCss), lockCss.replace(/\s+/g, ' ').slice(0, 150));
  const cardCss = (appCss.match(/\.print-lock-card\{[^}]*\}/) || [''])[0];
  A('S2 说明卡片自己是 pointer-events:auto（点了仍有提示，不静默）',
    /pointer-events\s*:\s*auto/.test(cardCss), cardCss.replace(/\s+/g, ' ').slice(0, 150));
  A('S3 遮罩背景不再有 cursor:pointer（它不参与命中测试了）',
    !/cursor\s*:\s*pointer/.test(lockCss));

  A('L1 页面侧有「输入回来了吗」探针（捕获阶段的一次性 click 监听）',
    /addEventListener\('click',\s*probe,\s*true\)/.test(shellJs));
  A('L2 探针收到 click 后会撤遮罩',
    /disarmPrintInputProbe\(\)[\s\S]{0,80}S\.printLock\(false\)/.test(shellJs));
  A('L3 探针在遮罩撤场时被摘掉（不长期占着捕获阶段）',
    /removeEventListener\('click',\s*printInputProbe,\s*true\)/.test(shellJs));
  /* 探针的**注释里**就写着"不 preventDefault / 不 stopPropagation" ⇒ 按源码文本扫会假红
     ⇒ 先把注释去掉，只看真正的代码。 */
  const probeRaw = (shellJs.match(/const probe = function[\s\S]*?\n {4}\};/) || [''])[0];
  const probeCode = probeRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  A('L4 探针**不干预**用户那一下点击（代码里没有 preventDefault / stopPropagation）',
    probeCode.length > 0 && !/preventDefault/.test(probeCode) && !/stopPropagation/.test(probeCode),
    probeCode.replace(/\s+/g, ' ').slice(0, 140));

  const focusBlock = (shellJs.match(/window\.addEventListener\('focus'[\s\S]{0,700}/) || [''])[0];
  A('L5 focus 兜底仍在（预览是内嵌层时焦点不一定触发，不能只靠它）',
    /addEventListener\('focus'/.test(focusBlock) && /printLock\(false\)/.test(focusBlock));
  const focusDelay = (focusBlock.match(/\},\s*(\d+)\);/) || [null, ''])[1];
  A('L6 focus 兜底的延迟已从 600ms 缩到 150ms（"用户已回到主界面"的体感空档）',
    focusDelay === '150', '延迟=' + focusDelay + 'ms');

  console.log('\n── 动态判据：真浏览器里跑等价场景 ──');
  /* ⚠ 壳的复用：先看有没有**已经就绪**的壳；没有才起新的。
     （实测踩过：launch-dev 会 taskkill 旧壳再起新的，起新壳要几秒才 ready；
       这期间 CDP 目标列表里可能还挂着旧壳的 target ⇒ 连上去发现 boot 遮罩还在
       ⇒ 等 40s 也不 ready ⇒ 假红。） */
  /* ⚠ **不要自己起壳**（除非端口根本不通）：跑门禁时已经起好了一个；
     自己再起会 taskkill 掉它 ⇒ 门禁收尾的 e2e-ui 会红在「启动完成·数据到位」
     （看着像 UI 坏了，其实是壳被换掉还没 boot 完）。 */
  let ready = false, how = '复用跑门禁时已起好的壳';
  try { ready = await waitPageReady(3000); } catch { ready = false; }
  if (!ready) {
    /* 端口不通 ⇒ 单独跑本用例 ⇒ 这时才自己起（此时没有 e2e-ui 要迁就） */
    how = '端口不通，自己起的壳';
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'launch-dev.cjs')], { encoding: 'utf8', timeout: 180000 });
    if (!/副本库|开发壳库根/.test(String(r.stdout || ''))) {
      A('D0 判据要在一个真页面里跑（壳可用）', false, String(r.stdout || r.stderr).slice(0, 200));
      return finish();
    }
    if (CDP) { try { CDP.ws.close(); } catch { } CDP = null; }
    await sleep(3000);
  }
  /* ⚠ 这条**恒定一条**（不按分支计数）—— 断言数必须恒定，否则门禁的"断言数对账"判红。
     分支信息进 detail。 */
  A('D0 判据要在一个真页面里跑（壳可用）', true, how);
  A('D1 页面就绪（应用已挂载、启动遮罩已退场）', await waitPageReady(), '等应用就绪');

  /* U1：真 printLock 装上遮罩后，**下面的**按钮第一下就该点到 */
  const u1 = JSON.parse(await ev(`(function(){
    try {
      CTB.shell.printLock(true);
      var lock=document.getElementById('printLock');
      if(!lock) return JSON.stringify({err:'no-lock'});
      var b=document.createElement('button'); b.id='__probeBtn'; b.textContent='x';
      b.style.cssText='position:fixed;left:24px;bottom:24px;width:140px;height:44px;z-index:1';
      document.body.appendChild(b);
      var rect=b.getBoundingClientRect();
      var top=document.elementFromPoint(Math.round(rect.left+rect.width/2), Math.round(rect.top+rect.height/2));
      var hits=[];
      var h=function(e){ hits.push(e.target && e.target.id); };
      document.addEventListener('click', h, true);
      b.click();
      document.removeEventListener('click', h, true);
      var out={ hitTarget: top?(top.id||top.className||top.tagName):'null', clicked:hits.slice(), lockHidden:lock.hidden };
      b.remove();
      return JSON.stringify(out);
    } catch(e){ return JSON.stringify({err:String(e&&e.message)}); }
  })()`));
  A('U1 遮罩开着时，下面的按钮**第一下**就能点到（遮罩不吃点击）',
    u1.hitTarget === '__probeBtn', JSON.stringify(u1));
  A('U2 那一下点击真的派发到了按钮（不是被遮罩截胡）',
    (u1.clicked || []).includes('__probeBtn'), JSON.stringify(u1));
  A('U3 页面收到 click 后遮罩自动撤（探针自愈）',
    u1.lockHidden === true, JSON.stringify(u1));

  /* U4：遮罩说明卡片仍可点（点了有提示，不静默吞掉） */
  const u4 = JSON.parse(await ev(`(function(){
    CTB.shell.printLock(true);
    var card=document.querySelector('.print-lock-card');
    var cs=card?getComputedStyle(card):null;
    var rect=card?card.getBoundingClientRect():null;
    var top=rect?document.elementFromPoint(Math.round(rect.left+rect.width/2), Math.round(rect.top+rect.height/2)):null;
    var out={ cardPointerEvents: cs?cs.pointerEvents:'n/a',
              hitIsCard: !!(top && top.closest && top.closest('.print-lock-card')),
              hasBtn: !!document.getElementById('printLockClose') };
    CTB.shell.printLock(false);
    return JSON.stringify(out);
  })()`));
  A('U4 遮罩的说明卡片自己仍可点（点了给提示）',
    u4.cardPointerEvents === 'auto' && u4.hitIsCard, JSON.stringify(u4));
  A('U5 卡片里有「知道了，先关预览」的按钮（不是死遮罩）', u4.hasBtn === true, JSON.stringify(u4));

  /* U6：撤遮罩后，遮罩彻底退出渲染 */
  const u6 = JSON.parse(await ev(`(function(){
    CTB.shell.printLock(true);
    CTB.shell.printLock(false);
    var lock=document.getElementById('printLock');
    return JSON.stringify({ hidden: lock.hidden, display: getComputedStyle(lock).display });
  })()`));
  A('U6 撤掉后遮罩 display:none（彻底退出合成与命中）',
    u6.hidden === true && u6.display === 'none', JSON.stringify(u6));

  /* ── 阴性自证：把 pointer-events 改回 auto ⇒ U1 必须变红 ── */
  console.log('\n── 阴性自证：判据必须真的会红 ──');
  const cssPath = path.join(APP, 'css', 'app.css');
  const orig = fs.readFileSync(cssPath, 'utf8');
  try {
    const mutated = orig.replace(/(\.print-lock\{[^}]*?)pointer-events:none/, '$1pointer-events:auto');
    if (mutated === orig) {
      A('N0 变异成功：把 .print-lock 的 pointer-events 改回 auto', false, '替换没生效');
    } else {
      fs.writeFileSync(cssPath, mutated, 'utf8');
      await ev('location.reload()').catch(() => { });
      await sleep(5000);
      await waitPageReady();
      const n1 = JSON.parse(await ev(`(function(){
        try {
          CTB.shell.printLock(true);
          var b=document.createElement('button'); b.id='__probeBtn'; b.textContent='x';
          b.style.cssText='position:fixed;left:24px;bottom:24px;width:140px;height:44px;z-index:1';
          document.body.appendChild(b);
          var rect=b.getBoundingClientRect();
          var top=document.elementFromPoint(Math.round(rect.left+rect.width/2), Math.round(rect.top+rect.height/2));
          b.remove(); CTB.shell.printLock(false);
          return JSON.stringify({ hitTarget: top?(top.id||top.className||top.tagName):'null' });
        } catch(e){ return JSON.stringify({err:String(e&&e.message)}); }
      })()`));
      A('N0 变异成功：把 .print-lock 的 pointer-events 改回 auto', true);
      A('N1 变异后按钮被遮罩挡住（⇒ U1 那条判据真的会因为这个变异而变红）',
        n1.hitTarget !== '__probeBtn', JSON.stringify(n1));
    }
  } finally {
    fs.writeFileSync(cssPath, orig, 'utf8');
    await ev('location.reload()').catch(() => { });
    await sleep(4000);
    try { await waitPageReady(); } catch { }
  }

  const u7 = JSON.parse(await ev(`(function(){
    CTB.shell.printLock(true);
    var b=document.createElement('button'); b.id='__probeBtn'; b.textContent='x';
    b.style.cssText='position:fixed;left:24px;bottom:24px;width:140px;height:44px;z-index:1';
    document.body.appendChild(b);
    var rect=b.getBoundingClientRect();
    var top=document.elementFromPoint(Math.round(rect.left+rect.width/2), Math.round(rect.top+rect.height/2));
    b.remove(); CTB.shell.printLock(false);
    return JSON.stringify({ hitTarget: top?(top.id||top.className||top.tagName):'null' });
  })()`));
  A('U7 还原后按钮又直接可点（工作树没被变异污染）',
    u7.hitTarget === '__probeBtn', JSON.stringify(u7));

  finish();
}

function finish() {
  console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${total} 失败=${fails}`);
  process.exit(fails ? 1 : 0);
}

/* ⚠ 用例跑挂了**必须判红**：不能"静默停在中途还报 PASS"。 */
main().catch(e => {
  console.error('✖ 装载/运行失败：', e && e.message);
  console.error(e && e.stack);
  A('用例跑到最后（没在中途挂掉）', false, String(e && e.message).slice(0, 200));
  finish();
});
