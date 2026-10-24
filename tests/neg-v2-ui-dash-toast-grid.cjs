#!/usr/bin/env node
/**
 * neg-v2-ui-dash-toast-grid.cjs —— v2 首页两处**显示缺陷**的回归护栏（2026-10-11 建）
 *
 * 守的是两条会再次静默复发的规则（都是「看起来只是难看」但其实是功能缺陷）：
 *
 *   ① 同键提示必须去重，且不得遮挡正文。
 *      起因：提示发在 `dash.js` 的 `V.render()` 体内，而 `V.render` 每次 `S.render()` 都跑
 *      （点侧栏 / 切学生 / 切主题 / autoReload 自动重读 / 落库后重绘…）；
 *      `S.toast` 原先既无去重也无同屏上限 ⇒ **渲染几次就堆几条**。
 *      实测（2026-10-11 10:18 用户截图）：5 条一模一样的面板提示叠在右上角，
 *      浮层高 271px，把「🎯 复习面板」整块盖住（含三条进度条与按钮）。
 *
 *   ② `.g-21` 的右栏不得被左栏内容的 min-content 顶没。
 *      起因：`.g-21{grid-template-columns:2fr 1fr}` 的 fr 轨道自动最小尺寸 = min-content，
 *      而热力图卡里「图例+月份」那行是不换行 flex（12 个月 × 60px 右边距 ≈ 1147px）
 *      ⇒ 2fr 轨道锁死在 1189px，1fr 只剩 258px，
 *      「学科盘面」标题被压到 54px 宽 → 一字一行，学科行的进度条被压成 0px（整条消失）。
 *
 * ⚠ 口径坑（本脚本存在的第二个理由）：真实桌面壳 `src\shell\CTBShellV2.cs` 是
 *   `Width = 1500` + 最大化，屏幕 125% 缩放 ⇒ **CSS 视口只有 1536×808**，设备像素才是 1920×1010。
 *   按 1920 CSS px 量，右栏仍有 447px、标题不换行 —— **假阴性**（本脚本第一版就踩了）。
 *   所以这里显式设 1536×808 / DPR 1.25。
 *
 * 前置：本机服务端在跑（`node _服务端.mjs`，默认 7187）。**只读**——不落库、不写真源。
 *       服务端不在则显式 SKIP（exit 0），不伪装成通过。
 *
 * 用法：node tests\neg-v2-ui-dash-toast-grid.cjs
 * 退出码：0=全过（或显式 SKIP）/ 1=有断言失败 / 2=环境缺失（无 Edge）
 */
const { spawn } = require('child_process');
const fs = require('fs');
/* ★ 2026-10-12：单次 CDP 调用超时（基础设施缺陷修复）。
   原 send() 挂上 pending 就永远不超时，而 evalJs 用 awaitPromise:true ——
   页面里只要有一个卡住的 Promise，整条门禁就无限期挂住（实测卡过 20~40 分钟，只能人工 kill）。
   门禁必须永远能自己跑完。覆盖：CTB_CDP_TIMEOUT（毫秒，默认 20000）。 */
function cdpTimeout() { const v = Number(process.env.CTB_CDP_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 20000; }
const path = require('path');
const os = require('os');

const E = require('./_测试环境.cjs');   // 测试自带服务端
const PORT = Number(process.env.CTB_PROBE_PORT || 9333);
/* ★ 2026-10-23：不再依赖"本机 7187 有个服务端在跑"（那可能是用户冻结区的老服务端，
   提供的是老前端，连上去必然对不上）。现在测试自己起一个独立实例，跑完自己关掉。
   显式给 CTB_SRV 时才尊重外部服务端。 */
let SRV = process.env.CTB_SRV || '';
let __srv = null;
let URL_ = '';   // 服务端起来后再定（SRV 是惰性解析的）
const CSS_W = 1536, CSS_H = 808, DPR = 1.25;      // 见上方「口径坑」
const sleep = ms => new Promise(r => setTimeout(r, ms));

const EDGES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGES.find(p => fs.existsSync(p));

let fails = 0, asserts = 0;
const P = s => console.log(s);
const A = (name, ok, detail) => {
  asserts++;
  P((ok ? '[OK]  ' : '[FAIL]') + name + (detail !== undefined ? '  → ' + String(detail).slice(0, 220) : ''));
  if (!ok) fails++;
};
const SKIP = (name, why) => P('[SKIP]' + name + '  → ' + why);

/* 量测表达式（在页面里求值） */
const MEASURE = `(function(){
  var R=function(el){if(!el)return null;var r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}};
  var lines=function(el){if(!el)return -1;var r=document.createRange();r.selectNodeContents(el);return r.getClientRects().length};
  var g=[].slice.call(document.querySelectorAll('#view .grid.g-21'));
  var cols=g.map(function(x){return getComputedStyle(x).gridTemplateColumns});
  var subj=g[1]&&g[1].children[1];
  var hb=subj?subj.querySelector('.card-h b'):null;
  var kb=subj?subj.querySelector('.kbar'):null;
  var pb=subj?subj.querySelector('.kbar .pbar'):null;
  var toasts=[].slice.call(document.querySelectorAll('#toasts .toast:not(.out)'));
  var box=document.getElementById('toasts');
  return JSON.stringify({
    viewport:{w:innerWidth,h:innerHeight},
    g21Count:g.length, cols:cols,
    col2w: subj?Math.round(subj.getBoundingClientRect().width):-1,
    titleLines: lines(hb), titleW: hb?Math.round(hb.getBoundingClientRect().width):-1,
    kbarOverflow: kb? (kb.scrollWidth-kb.clientWidth) : -1,
    pbarW: pb? Math.round(pb.getBoundingClientRect().width) : -1,
    toastN: toasts.length,
    /* 诊断用：把每条提示的文案与键都带出来（失败时能一眼看出"多出来的那条是谁"） */
    toastTexts: toasts.map(function(x){return (x.querySelector('.t-m')||{textContent:''}).textContent.slice(0,80)}),
    toastBox: R(box),
    toastH: toasts.length? Math.round(toasts[0].getBoundingClientRect().height):0,
    bodyScrollW: document.documentElement.scrollWidth
  });
})()`;

async function reachable(u) { try { const r = await fetch(u, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; } }

class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); this.errs = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) { const p = c.pm.get(m.id); c.pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') c.errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
    };
    return c;
  }
  send(method, params = {}, timeoutMs = cdpTimeout()) { const id = ++this.id; return new Promise((res, rej) => {
      const _t = setTimeout(() => { this.pm.delete(id); rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + method)); }, timeoutMs);
      this.pm.set(id, { res: v => { clearTimeout(_t); res(v); }, rej: e => { clearTimeout(_t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, cdpTimeout());
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch { } }
}

(async () => {
  if (!SRV) { __srv = await E.startServer(); SRV = __srv.base; P('[服务端] 测试专用实例 ' + SRV); }
  URL_ = SRV + '/index.html?ctbPort=' + (SRV.match(/:\d+/) || [''])[0].slice(1);   // 前端探测端口靠它
  if (!EDGE) { P('[EXC] 找不到 msedge.exe，无法跑界面护栏'); process.exit(2); }
  if (!(await reachable(SRV + '/health'))) {
    SKIP('全组（缺陷1 提示堆叠 / 缺陷2 右栏挤压）', '本机服务端 ' + SRV + ' 不在跑 ⇒ 拿不到数据，无法量测。先跑 `node _服务端.mjs`。');
    P('RESULT=SKIP 断言=0');
    process.exit(0);
  }

  const profile = path.join(os.tmpdir(), 'ctb-neg-v2-ui-' + process.pid);
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--window-size=1920,1010', 'about:blank'],
    { stdio: 'ignore' });

  let home = null;
  for (let i = 0; i < 60 && !home; i++) {
    try { const ts = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); home = ts.find(t => t.type === 'page'); } catch { }
    if (!home) await sleep(400);
  }
  if (!home) { try { proc.kill(); } catch { } P('[EXC] Edge 调试口未就绪'); process.exit(2); }

  const cdp = await Cdp.connect(home.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: CSS_W, height: CSS_H, deviceScaleFactor: DPR, mobile: false });
  /* 固定口径：范围=全部（与缺陷报告同口径）、压掉首次帮助抽屉、浅色主题 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('ctb2.seen','1');localStorage.setItem('ctb2.student','全部');" +
      "localStorage.setItem('ctb2.theme','light');localStorage.removeItem('ctb2.side');}catch(e){}"
  });
  await cdp.send('Page.navigate', { url: URL_ });

  let booted = false;
  for (let i = 0; i < 80 && !booted; i++) {
    try { booted = await cdp.evalJs('!!(window.CTB&&CTB.model&&CTB.model.cards&&CTB.model.cards.length)'); } catch { }
    if (!booted) await sleep(500);
  }
  A('启动完成 · 数据到位', booted, await cdp.evalJs("(document.getElementById('bootMsg')||{}).textContent"));
  if (!booted) { cdp.close(); try { proc.kill(); } catch { } P('RESULT=FAIL 断言=' + asserts); process.exit(1); }

  /* ---------- 缺陷1：把触发条件在内存里打开（不改磁盘），连做 5 次 dash 渲染 ---------- */
  const seeded = await cdp.evalJs("(function(){var n=0;CTB.model.cards.forEach(function(x){if(n<3&&x.card.causeConfirmed!==false){x.card.causeConfirmed=false;n++}});return n})()");
  A('缺陷1 触发条件就绪（内存注入 needOral>0，不写盘）', seeded > 0, 'needOral=' + seeded);

  /* ★ 2026-10-23：先清空提示，只量「这 5 次渲染」产生的。
     起因（实测）：提示的 key 里带题数（dash.needOral:<n>），而本库启动时本来就有 97 张
     "错因未确认"卡 → 启动阶段已弹一条 needOral:97；测试再注入 3 张后变 100 → 变成两条
     不同 key 的提示。那是**测试自己藏了数据依赖**，不是去重坏了。
     清空是安全的：shell.js 的 toastReg 对"节点被外部移除"有剪枝（否则同键会被永久吞掉）。 */
  await cdp.evalJs("var b=document.getElementById('toasts'); if(b) b.innerHTML=''");
  await sleep(50);
  await cdp.evalJs("CTB.shell.route('dash')"); await sleep(150);
  await cdp.evalJs("CTB.shell.render()"); await sleep(150);
  await cdp.evalJs("CTB.shell.render()"); await sleep(150);
  /* ★ 2026-10-23：先清空提示，只量「这 5 次渲染」产生的。
     起因（实测）：提示的 key 里带题数（dash.needOral:<n>），而本库启动时本来就有 97 张
     "错因未确认"卡 → 启动阶段已弹一条 needOral:97；测试再注入 3 张后变 100 → 变成两条
     不同 key 的提示。那是**测试自己藏了数据依赖**，不是去重坏了。
     清空是安全的：shell.js 的 toastReg 对"节点被外部移除"有剪枝（否则同键会被永久吞掉）。 */
  await cdp.evalJs("var b=document.getElementById('toasts'); if(b) b.innerHTML=''");
  await sleep(50);
  await cdp.evalJs("CTB.shell.route('dash')"); await sleep(150);
  await cdp.evalJs("CTB.shell.applyTheme('light');CTB.shell.route('dash')"); await sleep(450);

  const m1 = JSON.parse(await cdp.evalJs(MEASURE));
  /* 改前实测：5 条同文案 toast，浮层高 271px */
  A('缺陷1 · 5 次 dash 渲染后同屏提示只有 1 条（同键去重）', m1.toastN === 1, 'toastN=' + m1.toastN + ' 文案=' + JSON.stringify(m1.toastTexts));
  A('缺陷1 · 同屏提示不超上限 2 条', m1.toastN <= 2, 'toastN=' + m1.toastN);
  /* 不遮挡正文：改前锚 `top:64px;right:22px`，浮层正好压在「🎯 复习面板」卡上（高 271px）。
     现在锚右下角 ⇒ 浮层必须落在视口**下半部**且靠右。 */
  const tb = m1.toastBox;
  A('缺陷1 · 浮层锚在右下角（不占上半屏正文区）',
    !!tb && tb.y > m1.viewport.h / 2 && tb.x > m1.viewport.w / 2,
    'toastBox=' + JSON.stringify(tb) + ' 视口=' + JSON.stringify(m1.viewport));

  /* 去重/上限行为细分：不同键照常显示，同键不新增，超 2 条挤掉最旧 */
  const cap = JSON.parse(await cdp.evalJs(`(function(){
    var n=function(){return document.querySelectorAll('#toasts .toast:not(.out)').length};
    var a=n();
    CTB.shell.toast('探针A','ok',9000,'probe.A'); var b=n();
    CTB.shell.toast('探针B','bad',9000,'probe.B'); var c=n();
    CTB.shell.toast('探针A-重复','ok',9000,'probe.A'); var d=n();
    return JSON.stringify({start:a,addA:b,addB:c,reAddA:d})})()`));
  A('缺陷1 · 不同键照常显示（去重没有把消息吞掉）', cap.addA === cap.start + 1, JSON.stringify(cap));
  A('缺陷1 · 同屏上限 2 条（第三条挤掉最旧的）', cap.addB === 2, JSON.stringify(cap));
  A('缺陷1 · 同键重复不新增（只累加次数）', cap.reAddA === cap.addB, JSON.stringify(cap));

  /* ---------- 缺陷2：栅格与右栏（等提示自然过期后量，避免浮层影响） ---------- */
  await sleep(9500);
  const m2 = JSON.parse(await cdp.evalJs(MEASURE));
  P('[i] 视口 ' + JSON.stringify(m2.viewport) + ' ｜ .g-21 列宽 ' + JSON.stringify(m2.cols));

  A('缺陷2 · 两条 .g-21 都在（首页两行两列栅格）', m2.g21Count >= 2, m2.g21Count);
  /* 关键：两行的列宽必须一致（改前热力图行是 1189:258，待办行是 828:414） */
  A('缺陷2 · 两行 .g-21 列宽一致（热力图内容不再顶大 2fr 轨道）',
    m2.cols.length >= 2 && m2.cols[0] === m2.cols[1], JSON.stringify(m2.cols));
  const px = (m2.cols[1] || '').split(' ').map(parseFloat);
  const ratio = (px.length === 2 && px[1]) ? px[0] / px[1] : -1;
  A('缺陷2 · 栅格比例 ≈ 2:1', ratio > 1.85 && ratio < 2.15, 'ratio=' + ratio.toFixed(3) + '  cols=' + m2.cols[1]);
  /* 改前：右栏 258px、标题 54px 宽且 2+ 行、进度条宽 0 */
  A('缺陷2 · 右栏「学科盘面」卡宽 ≥ 360px', m2.col2w >= 360, 'w=' + m2.col2w);
  A('缺陷2 · 「📊 学科盘面」标题水平可读（单行）', m2.titleLines === 1, 'lines=' + m2.titleLines + ' titleW=' + m2.titleW);
  A('缺陷2 · 标题可用宽度 ≥ 140px（改前 54px）', m2.titleW >= 140, 'titleW=' + m2.titleW);
  A('缺陷2 · 学科行的进度条真的可见（改前被 168px 不可收缩标签压成 ~0）', m2.pbarW >= 40, 'pbarW=' + m2.pbarW);
  A('缺陷2 · 页面无横向溢出', m2.bodyScrollW <= m2.viewport.w, m2.bodyScrollW + ' vs ' + m2.viewport.w);

  /* ---------- 有牙齿自证（纯函数，不需要回滚代码）----------
     把 2026-10-11 改前的**实测值**喂进本脚本用的同一条判据，必须全部判红；
     否则说明这几条断言根本抓不住这个缺陷（教训库「阴性对照」规矩）。 */
  const judge = (colStr, col2w, titleLines, titleW, pbarW) => {
    const p = String(colStr).split(' ').map(parseFloat);
    const r = (p.length === 2 && p[1]) ? p[0] / p[1] : -1;
    return [r > 1.85 && r < 2.15, col2w >= 360, titleLines === 1, titleW >= 140, pbarW >= 40];
  };
  /* 改前实测：热力图行 1189.33px 258px、卡宽 258、标题 2 行 / 54px 宽、kbar 内进度条 ~0px
     （卡内容宽 216px = 168px 固定标签 + 2×9px gap + 30px 计数，进度条没有空间） */
  const beforeOk = judge('1189.33px 258px', 258, 2, 54, 0);
  /* 改后实测：830.656px 415.344px、卡宽 415、标题 1 行 / 196px、进度条 175px */
  const afterOk = judge('830.656px 415.344px', 415, 1, 196, 175);
  A('自证 · 改前实测值必须让 5 条布局判据全部判红（断言有牙齿）',
    beforeOk.every(x => x === false),
    JSON.stringify({ 比例: beforeOk[0], 右栏宽: beforeOk[1], 标题单行: beforeOk[2], 标题宽: beforeOk[3], 进度条可见: beforeOk[4] }));
  A('自证 · 改后实测值必须 5 条全绿（判据不是恒假）',
    afterOk.every(x => x === true), JSON.stringify(afterOk));

  /* ---------- 打印承重墙：试卷打印单元不得含答案（顺带守，成本≈0） ----------
     必须先真的组出预览（篮子→预览），否则 printUnit 两个单元都是空的，
     `ans 含答案册` 会假红（本脚本第一版就这么红了一次）。
     ⚠ 2026-10-12：篮子键改成 `kid|id`（BUG-11，库里 31 个卡号跨孩子重号），
        这里必须跟着改成 x.kid+'|'+x.card.id —— 写裸 id 现在会被 basketCards 正确地忽略，
        于是预览出不来、两条断言假红（本轮 full 门禁实测就是这么红的，是断言过时、不是代码回归）。 */
  await cdp.evalJs("CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,3).map(function(x){return x.kid+'|'+x.card.id}));CTB.shell.route('paper',{reset:true})");
  await sleep(400);
  const basketN = JSON.parse(await cdp.evalJs("JSON.stringify(CTB.model.basketCards().length)"));
  A('前置 · 篮子按 kid|id 入篮后能取回 3 张', basketN === 3, '实际 ' + basketN);
  await cdp.evalJs("var b=document.getElementById('ppPrev'); if(b) b.click();"); await sleep(1200);
  const pr = JSON.parse(await cdp.evalJs(`(function(){var P=CTB.views.paper;
    var p=P.printUnit('paper'), a=P.printUnit('ans');
    return JSON.stringify({pHasAns:/答案册/.test(p), pLen:p.length, aHasAns:/答案册/.test(a), aLen:a.length})})()`));
  A('打印承重墙 · 试卷单元非空且不含答案册', pr.pHasAns === false && pr.pLen > 200, JSON.stringify(pr));
  A('打印承重墙 · 答案册是独立单元且含答案', pr.aHasAns === true, JSON.stringify(pr));

  A('全程无 JS 异常', cdp.errs.length === 0, cdp.errs.slice(0, 3).join(' | '));

  cdp.close();
  try { proc.kill(); } catch { }
  await sleep(400);
  P('RESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + asserts);
  process.exit(fails ? 1 : 0);
})().then(async () => { if (__srv) await __srv.stop(); }).catch(async e => { if (__srv) await __srv.stop(); P('[EXC] ' + (e && e.stack || e)); P('RESULT=FAIL'); process.exit(1); });
