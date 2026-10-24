#!/usr/bin/env node
/**
 * neg-v2-ui-review-bank.cjs —— 复习流(review.js) / 题库浏览(bank.js) 的回归护栏（2026-10-11 建）
 *
 * 守的是这两页上**会静默复发**的规则。每一条都对应一次改前实测（数字见 docs\界面优化-v2-复习流题库-20261011.md）：
 *
 *   F-RB-1 判分预告的天数必须与工具同口径。视图曾自带 M.LADDER=[1,3,7…] 现算，
 *          答对显示「下次≈1天」而工具（_标记复习.mjs intervalOf）写 7 天 —— 差 6 天。
 *   F-RB-2 同一场落库只许组一张卷。双击「落库」曾并发跑两遍 endSession：同批题组两张卷（实测 2 次）。
 *   F-RB-9 判分按钮必须认卡。连点两下「对」曾沿用到下一题：用户没翻答案就被记了「对」（实测 idx 0→2）。
 *   F-RB-4 转折点笔记不许被重绘吞掉（实测 domBefore="我在这里拐错了" → domAfter=""）。
 *   F-RB-5 空格=翻答案，焦点在按钮上也不许顺带点掉那个按钮（实测一次空格 = 翻答案 + 跳题）。
 *   F-RB-6 Esc 必须能退出（实测改前完全无反应）。
 *   F-RB-7 筛选片与题行必须能 Tab 到（实测 25/25 chip、202/202 行不可达）。
 *   F-RB-8 跳过的题必须在结算屏说清（实测 4 题判 1 跳 3，屏上只写「1 题已判」）。
 *   F-RB-3 空态必须分清「筛选挡掉的 0」与「本来就没有的 0」（实测两场景文案逐字相同）。
 *   F-RB-11 搜索后计数条必须跟列表一致（实测同屏「共 23 题」+「202 题全挡掉了」互相矛盾）。
 *   F-26  打印承重墙：试卷单元不含答案册、答案册单元含。
 *
 * ⚠ 视口口径：真实桌面壳 src\shell\CTBShellV2.cs 是 Width=1500 + 最大化 + 125% 缩放
 *   ⇒ **CSS 视口 1536×808**（1920×1010 是设备像素）。按 1920 量会得到假阴性。
 *
 * 前置：本机服务端在跑（node _服务端.mjs，默认 7187）。**只读**：不落库、不改真源。
 *   ⚠ 落库路径一律 mock CTB.host.mark **并同时 stub S.regenBackground/H.regen**——
 *     否则 commit 成功路径会 POST /api/state 真重跑生成器（重写 _状态.json/首页.html）。
 *   服务端不在则显式 SKIP（exit 0），不伪装成通过。
 *
 * 用法：node tests\neg-v2-ui-review-bank.cjs
 * 退出码：0=全过（或显式 SKIP）/ 1=有断言失败 / 2=环境缺失（无 Edge）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const E = require('./_测试环境.cjs');   // 测试自带服务端
const ROOT = path.resolve(__dirname, '..');
/* ★ 2026-10-12：单次 CDP 调用超时（基础设施缺陷修复）。
   原 send() 挂上 pending 就永远不超时，而 evalJs 用 awaitPromise:true ——
   页面里只要有一个卡住的 Promise，整条门禁就无限期挂住（实测卡过 20~40 分钟，只能人工 kill）。
   门禁必须永远能自己跑完。覆盖：CTB_CDP_TIMEOUT（毫秒，默认 20000）。 */
function cdpTimeout() { const v = Number(process.env.CTB_CDP_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 20000; }
const PORT = Number(process.env.CTB_PROBE_PORT || 9335);
/* ★ 2026-10-23：不再依赖"本机 7187 有个服务端在跑"（那可能是用户冻结区的老服务端，
   提供的是老前端，连上去必然对不上）。现在测试自己起一个独立实例，跑完自己关掉。
   显式给 CTB_SRV 时才尊重外部服务端。 */
let SRV = process.env.CTB_SRV || '';
let __srv = null;
let URL_ = '';   // 服务端起来后再定（SRV 是惰性解析的）
const CSS_W = 1536, CSS_H = 808, DPR = 1;      // 见上方「视口口径」
const sleep = ms => new Promise(r => setTimeout(r, ms));

const EDGES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGES.find(p => fs.existsSync(p));

let fails = 0, asserts = 0, skips = 0;
const P = s => console.log(s);
const A = (name, ok, detail) => {
  asserts++;
  P((ok ? '[OK]  ' : '[FAIL]') + name + (detail !== undefined ? '  → ' + String(detail).slice(0, 240) : ''));
  if (!ok) fails++;
};
const SKIP = (name, why) => { skips++; P('[SKIP] ' + name + '  → ' + why); };

/* ★ 2026-10-23：read() 要同时认两处 —— 前端在 src\app\，工具在 src\tools\。
   先按仓库相对路径找（如 'src/app/js/model.js'），找不到再按工具目录找（如 '_标记复习.mjs'）。 */
const read = p => {
  const a1 = path.join(ROOT, p);
  if (fs.existsSync(a1)) return fs.readFileSync(a1, 'utf8');
  return fs.readFileSync(path.join(E.TOOLS, p), 'utf8');
};

/* ============================================================
   一、静态断言（不需要浏览器）：跨文件口径 + 结构护栏
   ============================================================ */
function staticChecks() {
  const mjs = read('_标记复习.mjs');
  const model = read('src/app/js/model.js');
  const review = read('src/app/js/views/review.js');
  const bank = read('src/app/js/views/bank.js');

  /* 从**工具**解出唯一真值表 */
  const tm = /const LADDER_OK\s*=\s*\[([^\]]+)\]/.exec(mjs);
  const toolLadder = tm ? tm[1].split(',').map(x => parseInt(x.trim(), 10)) : null;
  A('工具侧 LADDER_OK 可解析（_标记复习.mjs:192）', Array.isArray(toolLadder) && toolLadder.length > 0, JSON.stringify(toolLadder));

  const vm = /M\.INTERVAL_LADDER_OK\s*=\s*\[([^\]]+)\]/.exec(model);
  const v2Ladder = vm ? vm[1].split(',').map(x => parseInt(x.trim(), 10)) : null;
  A('F-RB-1 v2 间隔表与工具逐值相等（判据同口径）',
    !!toolLadder && !!v2Ladder && toolLadder.length === v2Ladder.length && toolLadder.every((v, i) => v === v2Ladder[i]),
    'tool=' + JSON.stringify(toolLadder) + ' v2=' + JSON.stringify(v2Ladder));

  A('F-RB-1 视图不得再拿 M.LADDER 当判据（历史/文案表）',
    !/M\.LADDER\s*\[/.test(review) && !/M\.LADDER\s*\[/.test(bank),
    'review/bank 里出现 M.LADDER[');

  A('F-RB-1 视图的预告值走 model 的唯一实现',
    /M\.previewIntervalOf\s*\(/.test(review) && /M\.intervalOf\s*=\s*function/.test(model));

  /* F-RB-3 空态两态必须都在（删掉任一分支即红） */
  A('F-RB-3 题库空态含「筛选挡掉的 0」分支', /全挡掉了|放宽任意一条/.test(bank));
  A('F-RB-3 题库空态含「本来就没有的 0」分支', /这个范围还没有错题卡/.test(bank));
  A('F-RB-3 两态文案不同（不许同一句话应付两种零结果）',
    (m => !!m && m[0] !== m[1])([/全挡掉了[^']*/.exec(bank) ? /全挡掉了[^']*/.exec(bank)[0] : '', /这个范围还没有错题卡[^']*/.exec(bank) ? /这个范围还没有错题卡[^']*/.exec(bank)[0] : '']));

  /* F-RB-2 落库重入闸 */
  A('F-RB-2 落库入口有重入闸（commitBusy 直接 return）', /if\s*\(commitBusy\)\s*return/.test(review));
  A('F-RB-2 落库按钮点击后立刻置灰', /cb\.disabled\s*=\s*true/.test(review));

  /* F-RB-9 判分必须认卡 */
  A('F-RB-9 判分函数收「渲染时那张卡的 key」并核对', /function grade\(res,\s*expectKey\)/.test(review) && /x\.key\s*!==\s*expectKey/.test(review));
  A('F-RB-9 未翻开答案不许判分', /if\s*\(!reveal\)\s*return/.test(review));

  /* F-RB-4 笔记按卡保存 */
  A('F-RB-4 笔记按卡号保存（noteByKey）', /noteByKey\[x\.key\]/.test(review) && /noteByKey\[x\.key\]\s*\|\|\s*''/.test(review));

  /* F-RB-5 / F-RB-6 键盘 */
  A('F-RB-5 空格在 keyup 上也被吞（防 button 激活）',
    /addEventListener\('keyup'/.test(review) && /spaceHandled/.test(review) && /e\.preventDefault\(\)/.test(review));
  A('F-RB-6 Esc 接进退出路径', /e\.key\s*===\s*'Escape'/.test(review) && /rvAbort/.test(review));
  A('键盘长按不连发（e.repeat 闸）', /e\.repeat/.test(review));

  /* F-RB-7 键盘可达 */
  A('F-RB-7 题库行可 Tab（role=button + tabindex）', /role="button" tabindex="0"/.test(bank));
  A('F-RB-7 题库筛选片可 Tab', /chip[^>]*role="button" tabindex="0"|role="button" tabindex="0"[^>]*chip/.test(bank) || /chip-dot/.test(bank));
  A('F-RB-7 复习流学科片可 Tab', /role="button" tabindex="0"/.test(review));

  /* F-RB-8 结算屏呈现跳过 */
  A('F-RB-8 结算屏呈现跳过题数', /题跳过未判|跳过未判/.test(review) && /M\.sessionSkippedCount/.test(review));

  /* F-RB-10 剔除被拦题必须同时剪 committed.list */
  A('F-RB-10 剔除走 model 的 sessionDrop（剪 results 也剪 committed.list）',
    /M\.sessionDrop\s*\(/.test(review) && /M\.sessionDrop\s*=\s*function/.test(model) && /c\.list\s*=\s*keep/.test(model));

  /* 判据只读：视图不得自己判「通过/不通过」 */
  A('判据只读 · 视图不重算盲解白名单（无 === 已通过/已修正 判定）',
    !/===\s*'已通过'|===\s*'已修正'|BLIND_OK/.test(review) && !/===\s*'已通过'|===\s*'已修正'|BLIND_OK/.test(bank));

  /* F-RB-11 计数条单一来源 */
  A('F-RB-11 计数条由 renderList 统一刷新（与列表同源）',
    /function countHtml/.test(bank) && /cEl\.innerHTML\s*=\s*countHtml\(list\.length\)/.test(bank));
}

/* ============================================================
   二、浏览器断言
   ============================================================ */
class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); this.errs = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) { const p = c.pm.get(m.id); c.pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') c.errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 220));
    };
    return c;
  }
  send(method, params = {}, timeoutMs = cdpTimeout()) { const id = ++this.id; return new Promise((res, rej) => {
      const _t = setTimeout(() => { this.pm.delete(id); rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + method)); }, timeoutMs);
      this.pm.set(id, { res: v => { clearTimeout(_t); res(v); }, rej: e => { clearTimeout(_t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { try { this.ws.close(); } catch { } }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, cdpTimeout());
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
}

async function reachable(u) { try { const r = await fetch(u, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; } }

(async () => {
  if (!SRV) { __srv = await E.startServer(); SRV = __srv.base; P('[服务端] 测试专用实例 ' + SRV); }
  URL_ = SRV + '/index.html?ctbPort=' + (SRV.match(/:\d+/) || [''])[0].slice(1);   // 前端探测端口靠它
  staticChecks();

  if (!EDGE) { P('[EXC] 找不到 msedge.exe，无法跑界面断言'); P('RESULT=FAIL 断言=' + asserts); process.exit(2); }
  if (!(await reachable(SRV + '/health'))) {
    SKIP('全组界面断言（F-RB-2/3/4/5/6/7/8/9/11 + 打印承重墙）',
      '本机服务端 ' + SRV + ' 不在跑 ⇒ 拿不到数据。先跑 `node _服务端.mjs`。');
    P('RESULT=SKIP 断言=' + asserts + ' 跳过=' + skips);
    process.exit(fails ? 1 : 0);
  }

  const profile = path.join(os.tmpdir(), 'ctb-neg-rb-' + process.pid);
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--window-size=1536,808', 'about:blank'], { stdio: 'ignore' });
  let home = null;
  for (let i = 0; i < 60 && !home; i++) {
    try { const ts = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); home = ts.find(t => t.type === 'page'); } catch { }
    if (!home) await sleep(400);
  }
  if (!home) { try { proc.kill(); } catch { } P('[EXC] Edge 调试口未就绪'); process.exit(2); }

  const cdp = await Cdp.connect(home.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: CSS_W, height: CSS_H, deviceScaleFactor: DPR, mobile: false });
  /* 固定口径：范围=全部、浅色主题、初次帮助抽屉已看过；清掉筛选/题源记忆 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('ctb2.seen','1');localStorage.setItem('ctb2.student','\"全部\"');" +
      "localStorage.setItem('ctb2.theme','\"light\"');localStorage.removeItem('ctb2.side');" +
      "localStorage.removeItem('ctb2.filters');localStorage.removeItem('ctb2.rvSrc');localStorage.removeItem('ctb2.rvSj');}catch(e){}"
  });
  await cdp.send('Page.navigate', { url: URL_ });
  let booted = false;
  for (let i = 0; i < 80 && !booted; i++) {
    try { booted = await cdp.evalJs('!!(window.CTB&&CTB.model&&CTB.model.cards&&CTB.model.cards.length)'); } catch { }
    if (!booted) await sleep(500);
  }
  A('启动完成 · 数据到位', booted, await cdp.evalJs("(document.getElementById('bootMsg')||{}).textContent"));
  if (!booted) { cdp.close(); try { proc.kill(); } catch { } P('RESULT=FAIL 断言=' + asserts); process.exit(1); }
  A('视口 = 1536×808（真实壳 CSS 口径，非设备像素 1920×1010）',
    (await cdp.evalJs('innerWidth+"/"+innerHeight')) === '1536/808', await cdp.evalJs('innerWidth+"x"+innerHeight'));

  /* ---- F-RB-1 判分预告天数 = 工具口径（浏览器实测渲染出来的字） ---- */
  const toolLadder = (() => { const m = /const LADDER_OK\s*=\s*\[([^\]]+)\]/.exec(read('_标记复习.mjs')); return m[1].split(',').map(x => parseInt(x.trim(), 10)); })();
  const iv = JSON.parse(await cdp.evalJs(`(function(){
    var xs=CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)&&(x.card.passStreak||0)===0});
    if(!xs.length) return JSON.stringify({skip:'no-passStreak-0-card'});
    CTB.model.session=null; CTB.shell.route('review');
    CTB.model.startSession([xs[0]]); CTB.shell.route('review');
    var rv=document.getElementById('rvReveal'); if(rv) rv.click();
    var b=document.querySelector('[data-grade="对"]');
    var mm=b?/(\\d+)\\s*天/.exec(b.textContent):null;
    var out={id:xs[0].card.id, passStreak:xs[0].card.passStreak||0, label:b?b.textContent.trim():'',
      shownDay:mm?+mm[1]:-1, expectDay:${toolLadder[0]}};
    CTB.model.session=null; CTB.shell.route('review');
    return JSON.stringify(out)})()`));
  if (iv.skip) SKIP('F-RB-1 答对预告天数 = 工具口径', '库里没有 passStreak=0 且可练的卡（样本 0）');
  else A('F-RB-1 答对预告天数 = 工具 intervalOf（' + toolLadder[0] + ' 天，改前误写 1 天）',
    iv.shownDay === iv.expectDay, JSON.stringify(iv));

  /* ---- F-RB-9 连点两下判分只判 1 题 ---- */
  const dbl = JSON.parse(await cdp.evalJs(`(function(){
    CTB.model.session=null; CTB.shell.route('review');
    var xs=CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)});
    if(xs.length<2) return JSON.stringify({skip:'need-2-cards'});
    CTB.model.startSession([xs[0],xs[1],xs[2]]); CTB.shell.route('review');
    document.getElementById('rvReveal').click();
    var g=document.querySelector('[data-grade="对"]');
    g.click(); g.click();
    var s=CTB.model.session;
    var out={idx:s.idx, results:Object.keys(s.results).length, vals:Object.values(s.results).map(function(r){return r.res})};
    CTB.model.session=null; CTB.shell.route('review');
    return JSON.stringify(out)})()`));
  if (dbl.skip) SKIP('F-RB-9 连点判分只判 1 题', dbl.skip);
  else A('F-RB-9 连点两下「对」只判 1 题（改前会连判下一题）',
    dbl.idx === 1 && dbl.results === 1, JSON.stringify(dbl));

  /* ---- F-RB-4 笔记重绘存活 ---- */
  const note = JSON.parse(await cdp.evalJs(`(function(){
    CTB.model.session=null; CTB.shell.route('review');
    var xs=CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)});
    CTB.model.startSession([xs[0],xs[1]]); CTB.shell.route('review');
    document.getElementById('rvReveal').click();
    var nb=document.getElementById('rvNote');
    nb.value='我在这里拐错了'; nb.dispatchEvent(new Event('input',{bubbles:true}));
    CTB.shell.render();
    var nb2=document.getElementById('rvNote'); var kept=nb2?nb2.value:'';
    /* 再判分，笔记必须随判定进 results（复习流水的一部分） */
    document.querySelector('[data-grade="半对"]').click();
    var r=Object.values(CTB.model.session.results)[0];
    var out={afterRender:kept, noteInResult:(r&&r.note)||''};
    CTB.model.session=null; CTB.shell.route('review');
    return JSON.stringify(out)})()`));
  A('F-RB-4 转折点笔记经重绘仍在（改前被吞成空）', note.afterRender === '我在这里拐错了', JSON.stringify(note));
  A('F-RB-4 转折点笔记随判分记入本场判定', note.noteInResult === '我在这里拐错了', JSON.stringify(note));

  /* ---- F-RB-5 空格在按钮上只翻答案 ---- */
  const sp = JSON.parse(await cdp.evalJs(`(function(){
    CTB.model.session=null; CTB.shell.route('review');
    var xs=CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)});
    CTB.model.startSession([xs[0],xs[1]]); CTB.shell.route('review');
    var skip=document.getElementById('rvSkip'); skip.focus();
    var kd=new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}); skip.dispatchEvent(kd);
    var ku=new KeyboardEvent('keyup',{key:' ',bubbles:true,cancelable:true});
    (document.activeElement||document.body).dispatchEvent(ku);
    if(!ku.defaultPrevented) skip.click();          /* 未被吞掉时浏览器会派 click */
    var out={reveal:!!document.querySelector('.reveal'), idx:CTB.model.session.idx,
      kdPrevented:kd.defaultPrevented, kuPrevented:ku.defaultPrevented};
    CTB.model.session=null; CTB.shell.route('review');
    return JSON.stringify(out)})()`));
  A('F-RB-5 焦点在「跳过」上按空格：翻到答案（keydown 被吞）', sp.reveal === true && sp.kdPrevented === true, JSON.stringify(sp));
  A('F-RB-5 同一次空格不得顺带把「跳过」点掉（keyup 也被吞）', sp.kuPrevented === true && sp.idx === 0, JSON.stringify(sp));

  /* ---- F-RB-6 Esc 两个分支 ---- */
  const esc = JSON.parse(await cdp.evalJs(`(function(){
    var orig=window.confirm, M2=CTB.model;
    M2.session=null; CTB.shell.route('review');
    var xs=M2.cardsOf().filter(function(x){return M2.canGroup(x.card)});
    M2.startSession([xs[0],xs[1]]); CTB.shell.route('review');
    window.confirm=function(){return false};
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    var cancel={session:!!M2.session};
    window.confirm=function(){return true};
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    var okd={session:!!M2.session, backToSetup:!!document.getElementById('rvStart')};
    window.confirm=orig; M2.session=null; CTB.shell.route('review');
    return JSON.stringify({cancel:cancel, confirm:okd})})()`));
  A('F-RB-6 Esc 会被接住（取消则保留本场）', esc.cancel.session === true, JSON.stringify(esc));
  A('F-RB-6 Esc 确认后退出本场并回配置屏（改前无反应）',
    esc.confirm.session === false && esc.confirm.backToSetup === true, JSON.stringify(esc));

  /* ---- F-RB-8 结算屏说清跳过 ---- */
  const sum = JSON.parse(await cdp.evalJs(`(function(){
    CTB.model.session=null; CTB.shell.route('review');
    var xs=CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)});
    CTB.model.startSession([xs[0],xs[1],xs[2],xs[3]]); CTB.shell.route('review');
    document.getElementById('rvReveal').click();
    document.querySelector('[data-grade="对"]').click();
    document.getElementById('rvSkip').click();
    document.getElementById('rvSkip').click();
    document.getElementById('rvSkip').click();
    var t=document.getElementById('view').textContent.replace(/\\s+/g,' ');
    var out={done:CTB.model.sessionDone(), results:Object.keys(CTB.model.session.results).length,
      saysSkipped:/跳过未判|跳过/.test(t), redoBtn:!!document.getElementById('rvRedoSkipped'), text:t.slice(0,120)};
    CTB.model.session=null; CTB.shell.route('review');
    return JSON.stringify(out)})()`));
  A('F-RB-8 结算屏明确写出跳过题数（改前完全不可见）', sum.saysSkipped === true, JSON.stringify(sum));
  A('F-RB-8 结算屏给「只练跳过的」下一步', sum.redoBtn === true, JSON.stringify(sum));

  /* ---- F-RB-2 双击落库只组一张卷（mock mark + stub regen） ---- */
  const dc = JSON.parse(await cdp.evalJs(`(async function(){
    var M2=CTB.model,H=CTB.host,orig=H.mark,origMode=H.mode,calls=[];
    var oBG=CTB.shell.regenBackground,oRG=H.regen,regenN=0;
    CTB.shell.regenBackground=function(){regenN++}; H.regen=async function(){regenN++};
    H.mode='shell';
    H.mark=async function(a,f){calls.push(a+(f.ids?':'+f.ids:''));
      return a==='组卷'?{code:0,out:'已建批次 P20990101-01'}:{code:0,out:'ok'}};
    M2.session=null; CTB.shell.route('review');
    var xs=M2.cardsOf().filter(function(x){return M2.canGroup(x.card)});
    M2.startSession([xs[0],xs[1]]); M2.sessionGrade('错'); M2.sessionGrade('对');
    CTB.shell.route('review'); await new Promise(function(r){setTimeout(r,300)});
    var btn=document.getElementById('rvCommit');
    if(!btn){H.mark=orig;H.mode=origMode;CTB.shell.regenBackground=oBG;H.regen=oRG;return JSON.stringify({skip:'no-commit-button'})}
    btn.click(); btn.click();
    await new Promise(function(r){setTimeout(r,1600)});
    var g=calls.filter(function(c){return c.indexOf('组卷')===0});
    var out={groups:g.length, details:g, grades:calls.filter(function(c){return c.indexOf('批改')===0}).length, regenN:regenN};
    H.mark=orig; H.mode=origMode; CTB.shell.regenBackground=oBG; H.regen=oRG;
    M2.session=null; CTB.shell.route('dash');
    return JSON.stringify(out)})()`));
  if (dc.skip) SKIP('F-RB-2 双击落库只组一张卷', dc.skip);
  else {
    A('F-RB-2 双击「落库」只组一张卷（改前实测组 2 张、批改 2 次）',
      dc.groups === 1 && dc.grades === 1, JSON.stringify(dc));
    A('F-RB-2 探针护栏：mock 路径下不得真触发后台重建', dc.regenN <= 1, 'regenN=' + dc.regenN);
  }

  /* ---- F-RB-3 空态两态必须不同 ---- */
  const e1 = JSON.parse(await cdp.evalJs(`(async function(){
    CTB.shell.route('bank'); await new Promise(function(r){setTimeout(r,400)});
    var i=document.getElementById('bkQ'); i.value='zzz绝不可能匹配的串zzz';
    i.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(function(r){setTimeout(r,420)});
    var e=document.querySelector('#view .empty');
    return JSON.stringify({text:e?e.textContent.replace(/\\s+/g,' ').trim():'', hasSub:!!(e&&e.querySelector('.e-sub')),
      hasAct:!!(e&&e.querySelector('.e-act')), mentionsTotal:/\\d+/.test(e?e.textContent:'')})})()`));
  const e2 = JSON.parse(await cdp.evalJs(`(function(){
    var keep=CTB.model.cards; CTB.model.cards=[];
    CTB.views.bank.render(document.getElementById('view'));
    var e=document.querySelector('#view .empty');
    var out={text:e?e.textContent.replace(/\\s+/g,' ').trim():'', hasSub:!!(e&&e.querySelector('.e-sub')),
      hasAct:!!(e&&e.querySelector('.e-act'))};
    CTB.model.cards=keep; CTB.shell.route('bank');
    return JSON.stringify(out)})()`));
  A('F-RB-3 筛选到 0 条说清「是筛选挡掉的」并给出放宽入口',
    /全挡掉了|放宽/.test(e1.text) && e1.hasSub === true && e1.hasAct === true, JSON.stringify(e1).slice(0, 200));
  A('F-RB-3 真的没有数据时说「本来就没有」（不许复用筛选那句）',
    /还没有错题卡|本来就没有/.test(e2.text) && !/全挡掉了/.test(e2.text) && e2.hasAct === true, JSON.stringify(e2).slice(0, 200));
  A('F-RB-3 两种零结果文案必须不同（改前逐字符相同）', e1.text !== e2.text,
    'filtered="' + e1.text.slice(0, 40) + '" vs empty="' + e2.text.slice(0, 40) + '"');

  /* ---- F-RB-11 计数条与列表一致 ---- */
  const cs = JSON.parse(await cdp.evalJs(`(async function(){
    CTB.shell.route('bank'); await new Promise(function(r){setTimeout(r,400)});
    var i=document.getElementById('bkQ');
    i.value='绝对'; i.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(function(r){setTimeout(r,420)});
    var el=document.getElementById('bkCount'); var b=el?el.querySelector('b'):null;
    var shown=b?parseInt(b.textContent,10):-1;
    var rows=document.querySelectorAll('#bkList .lrow').length;
    i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(function(r){setTimeout(r,420)});
    return JSON.stringify({rows:rows, shown:shown, agree:shown===rows})})()`));
  A('F-RB-11 搜索后计数条与列表条数一致（改前同屏自相矛盾）', cs.agree === true, JSON.stringify(cs));

  /* ---- F-RB-7 键盘可达 + Enter 真能打开 ---- */
  const kb = JSON.parse(await cdp.evalJs(`(function(){
    var chips=document.querySelectorAll('#view .chip[data-k]');
    var rows=document.querySelectorAll('#bkList .lrow');
    var focusable=function(l){var n=0;for(var i=0;i<l.length;i++){if(l[i].tabIndex>=0)n++}return n};
    var r0=rows[0];
    r0.focus();
    var focused=document.activeElement===r0;
    r0.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    var opened=!document.getElementById('drawerWrap').hidden;
    CTB.shell.closeDrawer();
    return JSON.stringify({chipTotal:chips.length, chipFocusable:focusable(chips),
      rowTotal:rows.length, rowFocusable:focusable(rows), focused:focused, enterOpens:opened})})()`));
  A('F-RB-7 全部筛选片可 Tab（改前 25/25 不可达）',
    kb.chipTotal > 0 && kb.chipFocusable === kb.chipTotal, JSON.stringify(kb));
  A('F-RB-7 全部题行可 Tab（改前 202/202 不可达）',
    kb.rowTotal > 0 && kb.rowFocusable === kb.rowTotal, JSON.stringify(kb));
  A('F-RB-7 行可聚焦且回车真能打开详情抽屉', kb.focused === true && kb.enterOpens === true, JSON.stringify(kb));

  /* ---- 做题界面可读性：题干字号 ≥14px、无横向溢出 ---- */
  const typ = JSON.parse(await cdp.evalJs(`(function(){
    CTB.model.session=null; CTB.shell.route('review');
    var xs=CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)});
    CTB.model.startSession([xs[0]]); CTB.shell.route('review');
    var h=document.querySelector('.stembox');
    var fs=parseFloat(getComputedStyle(h).fontSize);
    var out={fontPx:fs, overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
    CTB.model.session=null; CTB.shell.route('review');
    return JSON.stringify(out)})()`));
  A('做题界面题干字号 ≥14px（1536 视口下可读）', typ.fontPx >= 14, JSON.stringify(typ));
  A('无横向溢出（1536 视口）', typ.overflow <= 0, JSON.stringify(typ));

  /* ---- 0 值降权：本场还没判任何题时，三个计数徽章必须都不是语义彩底 ---- */
  const z = JSON.parse(await cdp.evalJs(`(function(){
    CTB.model.session=null; CTB.shell.route('review');
    var xs=CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)});
    CTB.model.startSession([xs[0]]); CTB.shell.route('review');
    var tags=[].slice.call(document.querySelectorAll('#view .row.small .tag'));
    var cls=tags.map(function(t){return t.className});
    var out={n:tags.length, cls:cls, allGray:tags.length>=3&&tags.slice(0,3).every(function(t){return /gray/.test(t.className)})};
    CTB.model.session=null; CTB.shell.route('review');
    return JSON.stringify(out)})()`));
  A('0 值降权：未判任何题时「对/半对/错」三个 0 不上语义彩底', z.allGray === true, JSON.stringify(z));

  /* ---- 打印承重墙（F-26）：必须先真出预览，否则两个单元都是空的（假红） ---- */
  const pr = JSON.parse(await cdp.evalJs(`(async function(){
    CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,3).map(function(x){return x.kid+'|'+x.card.id}));
    CTB.shell.route('paper',{reset:true});
    await new Promise(function(r){setTimeout(r,300)});
    var pb=document.getElementById('ppPrev'); if(pb) pb.click();
    await new Promise(function(r){setTimeout(r,1400)});
    var P=CTB.views.paper, p=P.printUnit('paper'), a=P.printUnit('ans');
    var out={pHasAns:/答案册/.test(p), pLen:p.length, aHasAns:/答案册/.test(a), aLen:a.length};
    CTB.model.basketSet([]); CTB.shell.route('dash');
    return JSON.stringify(out)})()`));
  A('打印承重墙 · 试卷单元非空且不含答案册', pr.pHasAns === false && pr.pLen > 200, JSON.stringify(pr));
  A('打印承重墙 · 答案册是独立单元且含答案', pr.aHasAns === true, JSON.stringify(pr));

  /* ============================================================
     二·b 阴性自证：把**改前实测值**喂进本脚本用的同一条判据，必须全红
     （答不出「什么输入下这行会红」的断言没有牙齿）
     ============================================================ */
  const jInterval = (shown, ladder) => shown === ladder[0];                       // F-RB-1
  const jDbl = (idx, results) => idx === 1 && results === 1;                      // F-RB-9
  const jNote = kept => kept === '我在这里拐错了';                                  // F-RB-4
  const jSpace = (reveal, kuPrev, idx) => reveal === true && kuPrev === true && idx === 0;   // F-RB-5
  const jEsc = (cancelKeeps, okExits) => cancelKeeps === true && okExits === true;  // F-RB-6
  const jSkip = says => says === true;                                            // F-RB-8
  const jCommit = (groups, grades) => groups === 1 && grades === 1;                // F-RB-2
  const jTwoZero = (a, b) => /全挡掉了|放宽/.test(a) && /还没有错题卡|本来就没有/.test(b) && a !== b;  // F-RB-3
  const jCount = agree => agree === true;                                          // F-RB-11
  const jKbd = (cf, ct, rf, rt) => ct > 0 && cf === ct && rt > 0 && rf === rt;      // F-RB-7

  const beforeAll = [
    ['F-RB-1 答对天数(改前显示1/工具7)', jInterval(1, toolLadder)],
    ['F-RB-9 连点判分(改前 idx=2,results=2)', jDbl(2, 2)],
    ['F-RB-4 笔记(改前 domAfter="")', jNote('')],
    ['F-RB-5 空格(改前 kuPrevented=false, idx=1)', jSpace(true, false, 1)],
    ['F-RB-6 Esc(改前无反应: 取消不保留/确认不退出)', jEsc(false, false)],
    ['F-RB-8 跳过(改前 skippedShown=false)', jSkip(false)],
    ['F-RB-2 落库(改前 组卷2/批改2)', jCommit(2, 2)],
    ['F-RB-3 空态(改前两场景文案逐字相同)', jTwoZero('没有符合条件的题换个筛选或清空搜索', '没有符合条件的题换个筛选或清空搜索')],
    ['F-RB-11 计数(改前 计数23/列表0 不一致)', jCount(false)],
    ['F-RB-7 键盘(改前 chip0/25、行0/202)', jKbd(0, 25, 0, 202)],
  ];
  const beforeVerdicts = beforeAll.map(([n, v]) => n + '=' + (v ? '红✗未拦住' : '红✓'));
  A('阴性自证 · 改前实测值必须让全部 ' + beforeAll.length + ' 条判据判红（判据有牙齿）',
    beforeAll.every(([, v]) => v === false), beforeVerdicts.join(' | '));
  const afterAll = [
    jInterval(toolLadder[0], toolLadder), jDbl(1, 1), jNote('我在这里拐错了'),
    jSpace(true, true, 0), jEsc(true, true), jSkip(true), jCommit(1, 1),
    jTwoZero('筛选把 202 题全挡掉了，放宽任意一条', '这个范围还没有错题卡，本来就没有'),
    jCount(true), jKbd(25, 25, 202, 202),
  ];
  A('阴性自证 · 改后实测值必须全绿（判据不是恒假）', afterAll.every(v => v === true), JSON.stringify(afterAll));

  A('全程无 JS 异常', cdp.errs.length === 0, cdp.errs.slice(0, 3).join(' | '));

  cdp.close(); try { proc.kill(); } catch { }
  await sleep(300);
  P('RESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + asserts + (skips ? ' 跳过=' + skips : ''));
  process.exit(fails ? 1 : 0);
})().then(async () => { if (__srv) await __srv.stop(); }).catch(async e => { if (__srv) await __srv.stop(); P('[EXC] ' + (e && e.stack || e)); P('RESULT=FAIL'); process.exit(1); });
