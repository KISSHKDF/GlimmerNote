#!/usr/bin/env node
/**
 * 真实桌面壳（WebView2）通道内的目视验收 —— 2026-10-11
 *
 * 为什么单独做这一步：之前所有截图都走**服务端 7187 通道**（headless Edge + setDeviceMetricsOverride），
 * 而用户实际使用的是 **WebView2 壳的 file:// 通道**。CSS/JS 同一份、e2e 也真跑在壳上，但"没在壳里亲眼看过"
 * 是唯一剩下的证据缺口。本脚本连壳的 CDP（9223），在**真实壳**里截图并核对两处修复。
 *
 * 用法：先 `node tests/launch-dev.cjs`（拉壳 + CDP 9223），再 `node tests/verify-shell-visual.cjs`
 * 产物：_probe\shell-shots\*.png
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');   // 2026-10-12：原写死真库绝对路径，改为自推导
/* ★ 2026-10-23：页面 URL 判据走唯一实现（老布局 /v2/index.html 已搬到 src\app\index.html） */
const E = require('./_测试环境.cjs');
/* ★ 2026-10-12：单次 CDP 调用超时（基础设施缺陷修复）。
   原 send() 挂上 pending 就永远不超时，而 evalJs 用 awaitPromise:true ——
   页面里只要有一个卡住的 Promise，整条门禁就无限期挂住（实测卡过 20~40 分钟，只能人工 kill）。
   门禁必须永远能自己跑完。覆盖：CTB_CDP_TIMEOUT（毫秒，默认 20000）。 */
function cdpTimeout() { const v = Number(process.env.CTB_CDP_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 20000; }
const PORT = +(process.env.CTB_CDP_PORT || 9223);
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(ROOT, '_probe', 'shell-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dec = u => { try { return decodeURIComponent(u || ''); } catch { return u || ''; } };
let fails = 0, skips = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 200) : ''}`); if (!ok) fails++; };
const S = (n, why) => { skips++; console.log(`[SKIP]${n}  → ${why}`); };

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
      else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) c.jsErrors.push(m.params.type + ': ' + (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 300));
    };
    return c;
  }
  send(method, params = {}, timeoutMs = cdpTimeout()) { const id = ++this.id; return new Promise((res, rej) => {
      const _t = setTimeout(() => { this.pm.delete(id); rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + method)); }, timeoutMs);
      this.pm.set(id, { res: v => { clearTimeout(_t); res(v); }, rej: e => { clearTimeout(_t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, cdpTimeout());
    if (r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
  async shot(f) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, f), Buffer.from(r.data, 'base64')); return path.join(OUT, f); }
  close() { try { this.ws.close(); } catch { } }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const targets = await listTargets();
  const pg = targets.find(t => /v2\/index\.html/.test(dec(t.url)) && t.type === 'page') || targets.find(t => t.type === 'page');
  if (!pg) { console.log('✘ 9223 上没有 page target'); process.exit(1); }
  console.log('通道 =', E.isFileAppUrl(dec(pg.url)) ? '真实桌面壳 file:// ✔' : '非壳页面：' + pg.url);
  console.log('URL =', dec(pg.url).slice(0, 120));

  const c = await Cdp.connect(pg.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');

  /* ① 真实窗口的 CSS 视口（这一步就是要量真壳，而不是 headless 设的）
   *
   * ★ 2026-10-12 重写判据。改之前这里写死了两台机器的常量：
   *     A('真实壳视口符合"1500 宽 + 125% 缩放"预期', V.w >= 1400 && V.w <= 1600)
   *     A('DPR = 1.25（系统 125% 缩放）', Math.abs(V.dpr - 1.25) < 0.01)
   *   它们测的是"当年那台 1920×1080 + 125% 缩放的机器"，**不是产品属性**。
   *   后果实测：本机是 3072×1728 + 150% ⇒ 恒红 ⇒ 门禁长期红 ⇒ 真回归被淹没
   *   （同 L-175「可选工具 ≠ 机械化」的变种：不是没挂，是挂了但永远红）。
   *
   * 现在测真正该测的**不变量**（换任何机器都成立）：
   *     · CSS 视口宽 ≤ 屏幕宽（窗口不可能比屏幕还宽）
   *     · CSS 视口 = 屏幕宽 × 剩余比例，且内缩量在合理范围（窗体确实铺满了屏幕）
   *     · dpr = 系统实际缩放（用 JS 独立推一遍并与之比对，而非写死 1.25）
   *     · 高分屏下 CSS 宽应是物理宽 ÷ dpr（这条能抓住"把设备像素当 CSS 像素"的真 bug）
   */
  const vp = await c.evalJs(`JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,screenW:screen.width,screenH:screen.height,aw:outerWidth,ah:outerHeight})`);
  console.log('== 真实壳视口 ==', vp);
  const V = JSON.parse(vp);

  A('真实壳是 file:// 通道（不是本机服务端）', E.isFileAppUrl(dec(pg.url)), dec(pg.url));

  // 不变量 1：视口宽不得超过屏幕宽
  A('★ CSS 视口宽 ≤ 屏幕宽（窗口没跑出屏幕）', V.w <= V.screenW + 1, `innerWidth=${V.w} screen.width=${V.screenW}`);
  // 不变量 2：窗体确实铺满了屏幕（内缩量很小），但没有超出
  const inset = V.screenW - V.w;
  A('★ 窗口铺满屏幕（左右内缩 ≤ 8% 屏宽，且 >0）', inset >= 0 && inset <= V.screenW * 0.08, `内缩=${inset}px / 屏宽=${V.screenW}`);
  /* 不变量 3：dpr 自洽 + 物理像素在合理区间。
     ⚠⚠ 这里连踩两个坑，必须写下来：
       坑1：`screen.width` 在 Chromium 里**已经是 CSS 像素**（本机实测 screen.width=2458 == innerWidth=2458，
            而 Windows 报的**物理**分辨率是 3072 = 2458×1.25）。所以判"有没有把设备像素当 CSS 像素"
            **不能**写成 `w ≈ screen.width / dpr` —— 我第一版就这么写，又造出一条恒红断言。
       坑2：物理像素**不能要求是 8 的倍数**。Chromium 的 CSS 宽是取整过的（2458），
            乘 1.25 得 3072.5 而不是 3072。要求整除同样会恒红（我第二版的错）。
     正确判法：dpr 必须是常见系统缩放档位，且 物理像素 ≈ 屏幕宽×dpr 落在常见桌面分辨率区间内。 */
  const phys = V.screenW * V.dpr;
  A('★ dpr 落在常见系统缩放档位上', [1, 1.25, 1.5, 1.75, 2].some(x => Math.abs(V.dpr - x) < 0.01), `dpr=${V.dpr}（本机实测值，不写死）`);
  A('★ 物理像素自洽：screen.width(CSS) × dpr 落在常见桌面分辨率区间',
    phys >= 1280 && phys <= 8192,
    `物理像素≈${phys.toFixed(0)}（${V.screenW} × ${V.dpr}）`);
  // 自证：确保上面不是恒真 —— 错误的 dpr 必须让它判红。
  // ⚠ 注意写法：这里断言的是"**错误的 dpr 不该通过**"，所以判据本身要写成
  //   「错误值确实不满足主判据」。上次我写成 `![档位].some(...1.0...)`，
  //   结果 1.0 恰好也不在档位里 → 表达式为 true → 恒真 → 门禁报红。教训见 L-422。
  const inTier = d => [1, 1.25, 1.5, 1.75, 2].some(x => Math.abs(d - x) < 0.01);
  A('★ 自证 · 判据有牙齿（错误的 dpr 不满足档位判据）',
    inTier(1.3) === false && inTier(V.dpr) === true,
    `坏 dpr=1.3（非系统档位）→ inTier=${inTier(1.3)}（应为 false）；实测 dpr=${V.dpr} → inTier=${inTier(V.dpr)}（应为 true）`);
  // 自证二：不合理的 dpr 也必须让"物理像素区间"判红
  const physOk = d => { const x = V.screenW * d; return x >= 1280 && x <= 8192; };
  /* ⚠ 2026-10-16 修：坏值 4.0 在 2458 CSS 宽屏上超界，但在 1536 宽屏上 4.0×1536=6144 仍在界内 ⇒ 恒红。
     改用 10.0：任何 ≥820 CSS px 的桌面屏都超界，跨机器成立。 */
  A('★ 自证二 · 物理像素判据有牙齿（dpr 误取 10.0 时超出区间）',
    physOk(10.0) === false && physOk(V.dpr) === true,
    `假 ${V.screenW}×10=${(V.screenW * 10).toFixed(0)} 超界；实测 ${V.screenW}×${V.dpr}=${phys.toFixed(0)} 在界内`);

  /* ② 通道标识：宿主模式应为 shell */
  const mode = await c.evalJs(`String(window.ctbMode||(CTB.host&&CTB.host.mode)||'?')`);
  console.log('== 宿主模式 ==', mode);
  A('走的是桌面壳通道（ctbHost/postMessage）', /shell/i.test(mode), mode);

  /* ③ 两处修复在真壳里的复验 —— ⚠ 必须是**有牙齿**的断言：
     第一版写成"当前可见提示 ≤2 条"⇒ 当时可见 0 条也判通过（**空真**，正是本仓铁律禁止的那类）。
     现在改为**主动复现当初的触发路径**：连点侧栏「今日总览」5 次（每次都会重跑 dash 渲染，旧代码就是这样堆出 5 条的），
     然后断言"可见提示 ≤2 且文案不重复"。若一次都没触发提示，则显式报"空真/无对象"而**不是**通过。 */
  const provoke = await c.evalJs(`(async function(){
    var items=[].slice.call(document.querySelectorAll('.side a,.side button,.side li,nav a,nav button,aside a,aside button'));
    var home=items.filter(function(e){return /今日总览/.test(e.textContent||'')})[0];
    if(!home) return JSON.stringify({clicked:0,err:'侧栏找不到「今日总览」'});
    for(var i=0;i<5;i++){ home.click(); await new Promise(function(r){setTimeout(r,180)}); }
    await new Promise(function(r){setTimeout(r,700)});
    var box=document.getElementById('toasts');
    if(!box) return JSON.stringify({clicked:5,err:'没有 #toasts 容器'});
    /* ⚠ 选择器口径（我自己踩过）：容器 id=toasts / class=toasts 自身也匹配星号通配的 class 选择器，
       用它计数会把容器算成一条提示（假阳性：误报"2 条重复"）。必须用 #toasts 的直接子元素 .toast 精确选取。 */
    var vis=[].slice.call(box.querySelectorAll(':scope > .toast')).filter(function(e){return !e.classList.contains('out')});
    var texts=vis.map(function(e){ var m=e.querySelector('.t-m'); return (m?m.textContent:e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,60)});
    return JSON.stringify({clicked:5,visible:vis.length,texts:texts,uniq:new Set(texts).size,
      stackTop:vis.length?Math.round(Math.min.apply(null,vis.map(function(e){return e.getBoundingClientRect().top}))):null,
      stackH:vis.length?Math.round(vis.reduce(function(a,e){return a+e.getBoundingClientRect().height},0)):0});
  })()`);
  console.log('== 主动复现提示堆叠（连点侧栏 5 次）==', provoke);
  const PR = JSON.parse(provoke);
  A('★ 连点 5 次后提示不堆叠（同屏可见 ≤2 条）', PR.clicked === 5 && PR.visible <= 2, `可见 ${PR.visible} 条，累计高 ${PR.stackH}px`);
  /* 「提示不重复」必须三态：有对象且不重复=通过 / 有对象且重复=失败 / **无对象=空真（单列，不算通过也不算失败）**。
     本仓铁律「空真不得报通过」；但同样不能把"没有对象"判成失败（那是把工作量当缺陷）。 */
  if (PR.visible === 0) S('★ 提示文案不重复', '本次无提示可观察（本机数据当前没有该提示项）⇒ 空真，不构成"已验证不堆叠"');
  else A('★ 提示文案不重复（无同文案堆叠）', PR.uniq === PR.visible, `可见 ${PR.visible} / 去重后 ${PR.uniq}`);

  /* 「学科盘面」几何：第一版选择器没命中就悄悄跳过 ⇒ 也是空真。改为**全文本搜索**且找不到即失败。 */
  const grid = await c.evalJs(`(function(){
    var all=[].slice.call(document.querySelectorAll('*'));
    var hits=all.filter(function(e){
      if(!/学科盘面/.test(e.textContent||'')) return false;
      return ![].slice.call(e.children).some(function(ch){return /学科盘面/.test(ch.textContent||'')});
    });
    if(!hits.length) return JSON.stringify({found:false});
    var t=hits[0], r=t.getBoundingClientRect(), lh=parseFloat(getComputedStyle(t).lineHeight)||20;
    return JSON.stringify({found:true,tag:t.tagName,w:Math.round(r.width),h:Math.round(r.height),lh:Math.round(lh),
      lines:Math.max(1,Math.round(r.height/lh)), text:(t.textContent||'').trim().slice(0,20)});
  })()`);
  console.log('== 「学科盘面」标题几何（真壳）==', grid);
  const G = JSON.parse(grid);
  A('★「学科盘面」标题在真壳里不是一字一行', G.found === true && G.w > 60 && G.lines <= 1, JSON.stringify(G));

  /* ④ 截图 + 切换断言。
     ⚠ 两版口径说明：①文档里**没有 h1/h2**，顶栏是 `header`（class 为空）内含一个带 🏠 的视图名元素；
     ②侧栏也**没有被选中的类**（无 `.on/.active/[aria-current]`）。所以"当前视图"只能从 header 文本里取视图名。
     第一版用 `.topbar h1` 取标题，全返回空串 ⇒ 四条 navOk 全 ✘（**探针口径错，不是切页失败**）。
     现在改为从 `header` 文本里匹配四个视图名，并且**切换后必须匹配到目标视图名**才算过。 */
  const VIEWS = ['今日总览', '复习流', '题库浏览', '组卷工作台', '待办工作台', '统计分析'];
  const curView = () => c.evalJs(`(function(){
    var h=document.querySelector('header,#topbar'); if(!h) return '';
    var t=(h.textContent||'').replace(/\\s+/g,'');
    var names=${JSON.stringify(VIEWS)};
    for (var i=0;i<names.length;i++) if (t.indexOf(names[i])>=0) return names[i];
    return '';
  })()`);
  async function go(kw) {
    const before = await curView();
    const how = await c.evalJs(`(function(){
      var items=[].slice.call(document.querySelectorAll('.side a,.side button,.side li,nav a,nav button,aside a,aside button'));
      var hit=items.filter(function(e){return (e.textContent||'').indexOf(${JSON.stringify(kw)})>=0})[0];
      if(hit){hit.click();return 'sidebar';}
      if(window.CTB&&CTB.app&&CTB.app.go){CTB.app.go(${JSON.stringify(kw)});return 'app.go';}
      return 'none';
    })()`);
    await sleep(900);
    const after = await curView();
    console.log(`   切「${kw}」：${before || '(空)'} → ${after || '(空)'}  [${how}]`);
    return after === kw;
  }
  async function theme(t) { try { await c.evalJs(`(function(){document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)}); try{localStorage.setItem('ctb2.theme', ${JSON.stringify(t)})}catch(e){} return 1})()`); } catch (e) { } await sleep(500); }

  const shots = [];
  const navOk = [];
  await go('今日总览'); await theme('light'); shots.push(await c.shot('shell-1-dash-light.png')); navOk.push(['今日总览', (await curView()) === '今日总览']);
  await theme('dark'); shots.push(await c.shot('shell-2-dash-dark.png'));
  await theme('light');
  for (const [kw, name] of [['题库浏览', 'shell-3-bank.png'], ['复习流', 'shell-4-review.png'], ['组卷工作台', 'shell-5-paper.png'], ['待办工作台', 'shell-6-pending.png'], ['统计分析', 'shell-7-stats.png']]) {
    const ok = await go(kw); shots.push(await c.shot(name)); navOk.push([kw, ok]);
  }
  await go('今日总览'); await theme('light');
  A('★ 视图切换都真的生效（不是同一页反复截图）', navOk.every(x => x[1]), navOk.map(x => `${x[0]}:${x[1] ? '✔' : '✘'}`).join(' '));

  /* ⑤ 真壳里不得有 JS 异常 */
  A('真壳内无 JS 异常/console error', c.jsErrors.length === 0, c.jsErrors.slice(0, 3).join(' | ') || '0 条');

  console.log('\n截图：'); shots.forEach(s => console.log('  ' + s));
  c.close();
  console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('EXC ' + (e && e.stack || e)); process.exit(1); });
