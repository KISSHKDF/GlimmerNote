#!/usr/bin/env node
/**
 * 批次 1 收尾「页面接线」端到端（2026-11-03）：真桌面壳 + 真录题页 + 临时库。
 *
 * 为什么必须有它：neg-task-page-wiring.cjs 是源码级+CLI 级，页面 → 壳 → 工具这条链的
 * **最后一厘米**（C# 桥真的能把 task/text/taskId 送进 _录题任务.mjs、页面真的把三层结论
 * 渲染出来、确认按钮真的写到 confirmedAt）只有真壳能证。它同时回答 R8 整改①最大的
 * 实证问题：index.html 有了 meta CSP 之后，WebView2 的 AddScriptToExecuteOnDocumentCreated
 * 注入的 window.ctbHost **还活着吗**（活着 = 桥通 = 页面能拿到状态 = 断言 a 过）。
 *
 * 库是 %TEMP% 合成库（空库兜底 → 空状态包，秒起），全程不碰真库/运行区。
 * 前置：src\app\拾光小册.exe 已编译（launch-dev/build.ps1 产物）；缺 = 显式 SKIP，不静默。
 *
 * ★ 2026-11-03（B-1 修复；B-1 = 独立复核实测"新 CSP 打死程序页两个内联事件处理器"）：
 *   本用例此前**看不见 CSP 违规** —— 它只订阅 `Runtime.exceptionThrown`，而 CSP 违规走
 *   `Log.entryAdded`（source=security），**不是异常**。于是重载按钮（shell.js）与证据图兜底
 *   （pending.js）被自家 CSP 打死时，「⑦ 全程无未捕获异常」照样全绿。现在补三样，都有牙齿：
 *     ① `Log.enable` + **零 security 违规**断言（白名单只放 frame-ancestors meta 的规范提示，
 *        理由写在断言旁）+ 一条"确实收到了 Log 事件"的反向断言（防"没订阅"被当成"零违规"）；
 *     ② **渲染后 DOM 里不得有任何内联事件属性（on*）** —— B-1 那一类回归的通杀判据；
 *     ③ **阴性自证**：现场注入一个内联处理器 ⇒ 违规计数必须 +1 且它不得执行。
 *   另加 F-40 的验收点：强制渲染出错分支 ⇒「⟳ 重载界面」按钮**不得带内联 onclick**、点它必须真 reload。
 *
 * ★ 同日另修两处盲区（复核报告 D-6.2 / D-6.3）：
 *   · 改前 `killShell()` 按镜像名 `taskkill /F /IM 拾光小册.exe` —— 会杀掉**用户正开着的程序**
 *     与**并发用例的壳**（Lead 跑 quick 时本用例根本不能跑）。现在**只杀自己 spawn 的那个 pid**，
 *     收尾另做"本用例 pid 已退出"的自证；起壳前有 CDP 端口占用的只读体检（只报告，绝不杀别人的）。
 *   · 改前缺 exe 时静默 `exit 0`（exe 被 .gitignore 忽略 ⇒ 干净克隆上这条用例零执行、整轮仍绿）。
 *     现在打印 `RESULT=SKIP(<原因>)`（本仓 SKIP 口径见 neg-e2e-frozen-lib.cjs:79-80：
 *     SKIP 不是 FAIL ⇒ 仍 exit 0，但**必须可见**、可 grep）。
 *
 * 退出码 0 = 全绿（含 SKIP）；2 = 壳起不来（基础设施缺失）。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const E = require('./_测试环境.cjs');

const PORT = 9343;                     // 与 quick 的 9223（launch-dev）错开
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'src', 'app', '拾光小册.exe');
const EDGE_CSP = "default-src 'none'; script-src 'self' file:; style-src 'self' file: 'unsafe-inline'; " +
  "img-src 'self' file: data:; connect-src 'self' file:; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";   // 与 _服务端.mjs APP_CSP / index.html meta 逐字相同

let fails = 0, total = 0;
const A = (n, ok, d) => { total++; fails += ok ? 0 : 1; console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + n + (d !== undefined ? '  → ' + String(d).slice(0, 220) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 只杀自己启动的壳（2026-11-03 B-1 修复配套；复核报告 D-6.2）────────────────
   改前是 `taskkill /F /IM 拾光小册.exe` —— 按**镜像名**杀，会把用户正开着的程序和并发用例
   （smoke-shell / neg-v2-pagesmoke / e2e-ui）的壳一起杀掉。现在只认自己 spawn 出来的 pid。
   `shellPid` 是本用例唯一的杀进程目标；收尾用 ownShellAlive() 自证"它真的没了"。
   为什么用 tasklist 而不是 fetch(CDP)：壳进程可能已死但端口还没释放，看进程才是真判据。
   编码注意：tasklist 输出走 OEM 代码页，中文可能乱码 ⇒ 只按 **ASCII 的 pid 数字** 判存在性。 */
let shellPid = null;
function killOwnShell() {
  if (!shellPid) return;
  spawnSync('taskkill', ['/F', '/T', '/PID', String(shellPid)], { encoding: 'buffer' });
}
function ownShellAlive() {
  if (!shellPid) return false;
  const r = spawnSync('tasklist', ['/FI', 'PID eq ' + shellPid, '/NH', '/FO', 'CSV'], { encoding: 'buffer' });
  const txt = Buffer.isBuffer(r.stdout) ? r.stdout.toString('latin1') : String(r.stdout || '');
  return txt.includes('"' + shellPid + '"');
}
/* 起壳前的只读体检：CDP 端口已被占 = 有别的壳/开发实例在跑。**只报告，不杀**（那可能是用户的程序）。 */
async function preflight() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
    if (r.ok) console.log('  ⚠ CDP 端口 ' + PORT + ' 上已经有实例在应答：本用例**不会**杀它（可能是用户正开着的程序），' +
      '若随后失败请先手动关掉它再跑。');
  } catch (e) { /* 没人应答 = 正常 */ }
}
async function waitPort(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); if (r.ok) return true; } catch (e) { }
    await sleep(400);
  }
  return false;
}

/* 单次 CDP 调用带超时（基础设施纪律，同 neg-v2-pagesmoke） */
const CDP_TIMEOUT = Number(process.env.CTB_CDP_TIMEOUT) > 0 ? Number(process.env.CTB_CDP_TIMEOUT) : 20000;
class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); this.errs = []; this.logs = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) { const p = c.pm.get(m.id); c.pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') c.errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 220));
      /* ★ 2026-11-03 B-1：CSP 违规**不是异常**，走 Log.entryAdded（source=security）。不收这里 = 看不见。 */
      else if (m.method === 'Log.entryAdded') {
        const e = m.params && m.params.entry ? m.params.entry : {};
        c.logs.push({ source: String(e.source || ''), text: String(e.text || '') });
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pm.delete(id); rej(new Error('CDP 超时 ' + CDP_TIMEOUT + 'ms：' + method)); }, CDP_TIMEOUT);
      this.pm.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { } }
}

/* ══ 「零 CSP 违规」判据（B-1 补网）════════════════════════════════════════
   白名单**只放规范类提示**：以 <meta> 形态下发 frame-ancestors 时，浏览器按规范必然打这一条
   （"该指令经 meta 下发时被忽略"）。它不是违规，也无法消除 —— 除非把 frame-ancestors 从 meta 里删掉，
   而那等于放弃壳模式（file://）的防框声明，且服务端头里那份还在，两份同内容是本批的设计。
   判据写在断言旁边就是为了让"什么时候能往白名单里加一条"当场可见：
   **只有规范类提示能加；任何 `violates the following Content Security Policy directive` 一律算违规。** */
const CSP_WHITELIST = [
  /The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element\./,
];
const secViolations = (c) => c.logs.filter(l => l.source === 'security').filter(l => !CSP_WHITELIST.some(re => re.test(l.text)));

/* 轮询一个页面侧取值直到满足（工具调用是秒级异步，拍等会抖） */
async function waitFor(cdp, expr, ok, tries, gap) {
  for (let i = 0; i < (tries || 20); i++) {
    let v; try { v = await cdp.evalJs(expr); } catch (e) { v = undefined; }
    if (ok(v)) return v;
    await sleep(gap || 500);
  }
  return undefined;
}

(async () => {
  if (!fs.existsSync(EXE)) {
    /* ★ 2026-11-03（D-6.3）：改前只有一行 [SKIP] 然后 exit 0 —— 缺 `RESULT=` 行就 grep 不到，
       而 *.exe 被 .gitignore 忽略 ⇒ 干净克隆上这条"最后一厘米"用例零执行、整轮照样绿。
       现在打印显式 RESULT=SKIP(<原因>)。退出码仍是 0：本仓口径 SKIP ≠ FAIL
       （见 neg-e2e-frozen-lib.cjs:79-80「退出码 = 0（是 SKIP，不是 FAIL）」）。 */
    console.log('RESULT=SKIP(src\\app\\拾光小册.exe 不存在：本用例需要已编译的桌面壳，先跑 src\\shell\\build.ps1)');
    console.log('[SKIP] neg-v2-ingest-task-e2e —— 真壳缺失，页面→壳→工具最后一厘米**本轮未验**（不是通过）。');
    process.exit(0);
  }
  const LIB = E.allocTempDir('gn-ingest-e2e-');
  /* ★ 2026-11-03（批次 2「经验包试点」）：临时**经验包根** —— 把仓库里那份试点包按安装布局
     复制进来，再靠 `CTB_PACKS` 让壳起 node 子进程时继承（**不写用户真目录**
     `%LOCALAPPDATA%\拾光小册\经验包`，实机验收不该在用户机器上留副作用）。 */
  const PACKS = E.allocTempDir('gn-ingest-e2e-packs-');
  const PILOT_SRC_ROOT = path.join(ROOT, 'src', 'packs', 'family-a', 'shared-stem');
  /* ⚠ 版本号**从目录里读最高那个**（pack.json 在 `<packId>/<version>/` 里），不写死：
     写死会在包升版时变成假红（1.0.0→1.0.1→1.0.2 已连撞两次）。
     判据仍有牙齿 —— 它比的是"页面选卡后写进任务记录的那个版本"与"包里声明的版本"是否一致。 */
  const PILOT_VER = fs.readdirSync(PILOT_SRC_ROOT)
    .filter((d) => /^\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(PILOT_SRC_ROOT, d, 'pack.json')))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
  const PILOT_SRC = path.join(PILOT_SRC_ROOT, PILOT_VER);
  const PILOT_DST = path.join(PACKS, 'family-a', 'shared-stem', PILOT_VER);
  fs.mkdirSync(path.dirname(PILOT_DST), { recursive: true });
  fs.cpSync(PILOT_SRC, PILOT_DST, { recursive: true });
  const jpg = (last) => Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x05, 0x78, 0x03, 0xE8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9, last]);
  fs.mkdirSync(path.join(LIB, '_收件箱', '批次E2E'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '_收件箱', '批次E2E', 'p001.jpg'), jpg(0x21));
  fs.writeFileSync(path.join(LIB, '_收件箱', '批次E2E', 'p002.jpg'), jpg(0x22));
  const SHA_A = crypto.createHash('sha256').update(jpg(0x21)).digest('hex');

  let cdp = null;
  try {
    await preflight();
    console.log('═══ ① 拉起真壳（临时库 ' + LIB + '，CDP ' + PORT + '）═══');
    const p = spawn(EXE, [], {
      detached: true, stdio: 'ignore',
      env: Object.assign({}, process.env, {
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
        CTB_DEV: '1', CTB_DATA: LIB,
        /* 批次 2：经验包根走环境变量（壳起 node 子进程时继承），默认则是 %LOCALAPPDATA%。 */
        CTB_PACKS: PACKS,
      }),
    });
    shellPid = p.pid;          /* 本用例唯一允许杀的进程（改前是 taskkill /IM 全杀，见文件头） */
    p.unref();
    const up = await waitPort(45000);
    A('壳起来且 CDP 就绪（pid=' + shellPid + '）', up);
    if (!up) { console.log('RESULT=FAIL'); process.exit(2); }
    /* ⚠ `waitPort()` 只看 `/json/list` **应答**（HTTP 200），而壳刚起来时那个列表可能是**空的**
       —— 2026-11-03 实测撞上：`拿到 page target → []`，整轮 quick 因此红（不是产品缺陷，是竞态）。
       这里改成**有界轮询**等 page target 出现（最多 20s），拿到再断言。 */
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page') || null;
      } catch { /* 还没起来，继续等 */ }
      if (!page) await sleep(500);
    }
    A('拿到 page target（有界等待 ≤20s，允许壳先有 CDP 再有页面）', !!page,
      page ? page.url.slice(0, 100) : '20s 内没等到 page（壳起来了但没建页面）');
    if (!page) { console.log('RESULT=FAIL'); process.exit(2); }
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    /* ★ 2026-11-04（外部复核时发现，本用例长期红的**真因**）：**先把 localStorage 清干净再测**。
       为什么必须清：录题页的 `st.recipe` 来自 **localStorage**（`ctb2.ingest`，
       见 `views/ingest.js:22-33`），而 WebView2 的用户数据目录（`%LOCALAPPDATA%\拾光小册\wv2-profile`）
       是**跨运行持久**的 ⇒ 上一次真人用这个程序时选过"单题录入"，
       就会把 `recipe: "ingest-single"` 留在 localStorage 里。
       于是本用例的载荷（**整页多题**形状：pageSummary + 多张 cards + skipped）
       去走 `ingest-single` 的 schema ⇒ **格式层必然判红** ——
       而这与产品对不对**毫无关系**，纯粹是"用户上次选过什么"泄漏进了门禁。
       实测现场：leveldb 里读出 `ctb2.ingest = {"recipe":"ingest-single","subject":"生物","conflict":"first"}`
       ⇒ 本用例恒 FAIL(6)；每跑一次残留值还会变（真人用过）⇒ 症状飘。
       修法：**在页面加载之前**就把 localStorage 清掉 —— 必须在导航前做，
       因为页面脚本一跑就会把当前值写回去（`save()` 在 recipe/subject 变化时写）。
       所以做法是：①先 goto 一个空白页（about:blank 与 file:// 不同源，localStorage 不可用），
       ②改用 **CDP 的 `Storage.clearDataForOrigin`** 清掉本 origin 的 localStorage，
       ③再导航回入口页。
       ⚠ 为什么不用 `localStorage.clear()`：它**读得到但写不进** ——
       file:// 源的 localStorage 在 CDP 注入的上下文里是只读/受限的（实测抛 SecurityError），
       而 `Storage.clearDataForOrigin` 走的是浏览器存储层，能真正清掉。 */
    try {
      await cdp.send('Storage.clearDataForOrigin', {
        origin: 'file://',
        storageTypes: 'local_storage,session_storage',
      });
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await sleep(800);
      await cdp.send('Page.navigate', { url: page.url });
      await sleep(3500);
      const lsAfter = await cdp.evalJs('(function(){try{var s=localStorage.getItem("ctb2.ingest");return s||"(空)"}catch(e){return "ERR:"+e}})()');
      /* ★ 2026-11-05（外部复核实测 N5）：修前是一个**或条件**断言
         `lsAfter === '(空)' || lsAfter.indexOf('ingest-page') >= 0` ——
         若 clearDataForOrigin 因 origin 不匹配**实际没清**、而残留恰好是上次的
         `ingest-page`，这条断言照样绿 ⇒ "没清干净"与"默认值"无法区分（假绿）。
         现在拆成两步、各有独立判据：
           ① 页面**加载前**导航到 about:blank 后清一次再读一次 —— file:// 之外
              localStorage 不可用，此处真正可验证的是"清动作没抛错"（上方 A 已覆盖）；
           ② 页面加载后的值：要么是"(空)"（清干净了，页面还没写回），
              要么**恰等于** ingest.js 的默认值串 `{"recipe":"ingest-page",…}` 的**形状** ——
              且**必须**是"值以 ingest-page 开头 + JSON 里没有上轮真人残留的其他字段"才放行。
              更硬的一刀：直接断言**值里没有 ingest-single**（真人残留的那个值）——
              没清干净时残留的就是它；清干净时它绝不可能自己回来。 */
      const after = String(lsAfter);
      const notDirty = after === '(空)' || (after.indexOf('ingest-page') >= 0 && after.indexOf('ingest-single') < 0);
      A('★ 清掉跨运行残留的 localStorage（残留值里不得再有真人选的 ingest-single）',
        notDirty, '清后=' + after.slice(0, 100));
    } catch (e) {
      A('★ 清掉跨运行残留的 localStorage', false, String(e && e.message || e).slice(0, 140));
    }

    console.log('═══ ② boot：meta CSP 在场时桥必须活着（R8 整改①的实机证据）═══');
    const mode = await waitFor(cdp, 'CTB.host.mode', v => v === 'shell', 30, 500);
    A('通道=shell 且状态拿到（AddScriptToExecuteOnDocumentCreated 未被 meta CSP 杀掉）', mode === 'shell', mode);
    const meta = await cdp.evalJs('(document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')||{}).content||""');
    A('页面里 meta CSP 与 APP_CSP 逐字相同', meta === EDGE_CSP, JSON.stringify(String(meta).slice(0, 80)));
    A('window.ctbHost.postMessage 可调（桥对象在场）',
      await cdp.evalJs('typeof window.ctbHost!=="undefined" && typeof window.ctbHost.postMessage==="function"') === true);

    console.log('═══ ②b B-1 补网：零 CSP 违规 + 渲染后 DOM 不得有内联事件属性 ═══');
    /* 反向断言先来：证明"收集器在工作"。否则"零违规"可能只是"没订阅 Log"（假绿的老形态）。 */
    A('确实收到了 Log 事件（判据不是"没订阅"）', cdp.logs.length > 0, 'logs=' + cdp.logs.length + ' 首条=' + String((cdp.logs[0] || {}).text || '').slice(0, 90));
    const vBoot = secViolations(cdp);
    A('启动期 security 类违规 = 0（白名单只放 frame-ancestors meta 的规范提示，理由见 CSP_WHITELIST 注释）',
      vBoot.length === 0, vBoot.map(v => v.text).join(' | ').slice(0, 220));
    const inlineAttrs = await cdp.evalJs("Array.prototype.slice.call(document.querySelectorAll('*'))" +
      ".filter(function(el){return Array.prototype.slice.call(el.attributes).some(function(a){return /^on/i.test(a.name);});})" +
      ".map(function(el){return el.tagName+'.'+(el.className||'')+':'+Array.prototype.slice.call(el.attributes).filter(function(a){return /^on/i.test(a.name);}).map(function(a){return a.name;}).join(',');}).slice(0,6)");
    A('渲染后的 DOM 里没有任何内联事件属性（on*）—— B-1 那一类回归的通杀判据',
      Array.isArray(inlineAttrs) && inlineAttrs.length === 0, JSON.stringify(inlineAttrs));
    /* .pd-ev 的失败兜底（F-38 防线②）现在是对象式绑定：这里顺带证明"它真的挂上了"（不是只有源码里没属性）。 */
    const pdEvBound = await cdp.evalJs("(function(){var d=document.createElement('div');d.innerHTML='<img class=\"pd-ev\" data-rel=\"x.jpg\" src=\"nope-not-exist.jpg\">';document.body.appendChild(d);var img=d.querySelector('img.pd-ev');img.onerror=function(){window.__pdEvHit=1;};return typeof img.onerror==='function';})()");
    A('证据图兜底可用对象式 onerror 绑定（.pd-ev 不再需要内联属性）', pdEvBound === true, String(pdEvBound));

    console.log('═══ ③ 录题页：勾图 → 生成任务单（--task 透传 → 任务号上屏）═══');
    await cdp.evalJs('CTB.shell.route("ingest")');
    await waitFor(cdp, '!!document.querySelector("#igGen")', Boolean, 20, 300);
    /* 收件箱列表是异步渲染的（loadInbox 起一个 node 子进程），必须等，不能查一次就走 */
    const picked = await waitFor(cdp,
      '(function(){const cb=document.querySelector("#igInboxBox input[data-rel]");return cb ? cb.dataset.rel : (document.querySelector("#igInboxBox")||{}).textContent||"";})()',
      v => typeof v === 'string' && v.indexOf('_收件箱/') === 0, 30, 500);
    A('收件箱列出照片并勾选第一张', typeof picked === 'string' && picked.indexOf('_收件箱/') === 0, JSON.stringify(picked));
    await cdp.evalJs('document.querySelector("#igInboxBox input[data-rel]").click()');
    await cdp.evalJs('document.querySelector("#igGen").click()');
    const taskBox = await waitFor(cdp, '(document.querySelector("#igTaskBox")||{}).textContent||""',
      v => /任务号/.test(String(v)) || /生成失败/.test(String(v)), 30, 500);
    A('任务单生成且任务号上屏（组装 --task 真的透传了）', /任务号/.test(String(taskBox)), String(taskBox || '').slice(0, 120));
    const tid = (/t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}/.exec(String(taskBox)) || [])[0];
    A('任务号形状符合壳侧门禁', /^t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(String(tid)), String(tid));
    const recExists = tid ? fs.existsSync(path.join(LIB, '_录题', String(tid) + '.json')) : false;
    A('任务记录真的落在临时库 _录题\\（用户数据，走 _安全写）', recExists, String(tid));

    /* ═══════ ★ 2026-11-03（批次 2）选卡 → 任务单带卡正文（真 exe + 真页面 + 真工具）═══════
       这一段顶掉的是"门禁全绿≠用户看得见"（L-435）里最要紧的一格：批次 2 的选卡是**新界面**，
       只看源码与行为级用例证明不了"壳里那条 --card 透传真的通到页面上"。链路：
       临时包根(CTB_PACKS) → 页面「清单」→ 选卡 → 组装 --card → 任务单正文 + 任务记录 cards[]。 */
    console.log('═══ ③b 选卡：临时包根 → 页面选卡 → 任务单带卡正文 ═══');
    const packRow = await waitFor(cdp,
      '(function(){var i=document.querySelector("#igPackBox input[data-pack]");return i?i.dataset.pack:((document.querySelector("#igPackBox")||{}).textContent||"");})()',
      v => typeof v === 'string' && (v === 'family-a/shared-stem' || /读不到|无法/.test(v)), 30, 500);
    A('页面读到了临时包根里的试点包（CTB_PACKS 真的继承到 node 子进程）',
      packRow === 'family-a/shared-stem', JSON.stringify(packRow));
    const typedOk = await cdp.evalJs('(function(){var i=document.querySelector("#igPackBox input[data-pack=\\"family-a/shared-stem\\"]");' +
      'if(!i) return false; i.value="shared-stem"; i.oninput(); return i.value === "shared-stem";})()');
    A('选卡区可填卡 ID（oninput 把选择交给页面状态，不是生成时读 DOM）', typedOk === true, String(typedOk));
    await cdp.evalJs('document.querySelector("#igGen").click()');
    const themed = await waitFor(cdp, '(document.querySelector("#igTaskBox")||{}).textContent||""',
      v => /已选卡/.test(String(v)) || /生成失败|选卡有问题/.test(String(v)), 40, 500);
    A('勾了卡的任务单生成成功（选卡没被壳或工具拒掉）',
      /已选卡/.test(String(themed)) && !/生成失败|选卡有问题/.test(String(themed)), String(themed || '').slice(0, 150));
    const pre = await cdp.evalJs('(document.querySelector("#igPre")||{}).textContent||""');
    /* ⚠ 这里**不写死版本号**：写死 `@1.0.0` 会在包里升到 1.0.1 时变成假红（本轮实测撞上）。
       版本号的精确判据在下一条（读任务记录 cards[].version），这里只证明"卡身份串进了任务单"。 */
    A('卡正文真的进了任务单（`### 本次追加的方法（经验包）` + 卡身份串）',
      /本次追加的方法（经验包）/.test(pre) && /family-a\/shared-stem\/shared-stem@[0-9]+\.[0-9]+\.[0-9]+/.test(pre),
      '任务单 ' + String(pre).length + ' 字符');
    const tid2 = (/t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}/.exec(String(themed)) || [])[0];
    A('带卡生成也是一次新任务（任务号上屏）', /^t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(String(tid2)), String(tid2));
    let recCards = null;
    try { recCards = JSON.parse(fs.readFileSync(path.join(LIB, '_录题', String(tid2) + '.json'), 'utf8')).cards; } catch (e) { }
    A('任务记录里 cards[] 记下这次用了哪张卡（packId/cardId/version/sha256）',
      Array.isArray(recCards) && recCards.length === 1 && recCards[0].packId === 'family-a/shared-stem' &&
      recCards[0].cardId === 'shared-stem' && recCards[0].version === PILOT_VER && /^[0-9a-f]{64}$/.test(String(recCards[0].sha256 || '')),
      JSON.stringify(recCards));

    console.log('═══ ③c 停用：放一个 `.停用` → 生成被拒且点名原因（"能停即回退"的实机证据）═══');
    fs.writeFileSync(path.join(PILOT_DST, '.停用'), '实机验收：临时停用（删掉即恢复）\n', 'utf8');
    await cdp.evalJs('document.querySelector("#igPacksReload").click()');
    const disBox = await waitFor(cdp, '(document.querySelector("#igPackBox")||{}).textContent||""',
      v => /已停用/.test(String(v)), 30, 500);
    A('重新读经验包后该包显示「已停用」', /已停用/.test(String(disBox)), String(disBox || '').replace(/\s+/g, ' ').slice(0, 120));
    await cdp.evalJs('document.querySelector("#igGen").click()');
    const blocked = await waitFor(cdp, '(document.querySelector("#igTaskBox")||{}).textContent||""',
      v => /选卡有问题|生成失败/.test(String(v)), 30, 500);
    A('停用后**不生成**任务单，且原因点名 `.停用`（不是静默少卡）',
      /选卡有问题/.test(String(blocked)) && /停用/.test(String(blocked)), String(blocked || '').replace(/\s+/g, ' ').slice(0, 170));
    fs.unlinkSync(path.join(PILOT_DST, '.停用'));
    A('删掉 `.停用` 即恢复（回退动作只有这一步）', !fs.existsSync(path.join(PILOT_DST, '.停用')));

    /* ⚠ 本段（③b/③c）会**再生成两次任务单**，页面句柄因此指向最新那次生成的带卡任务（`tid2`）。
       ④ 是桥级调用（不依赖页面句柄），⑤ 的"粘回"必须用页面**当前**的任务号，故这里给出 `tidUi`。
       ⑥ 的"`_录题` 里只多出 B 一个文件"也要把 `tid2` 排除掉（否则断言假红）。
       这段耦合写在这里，别在别处再引一份。 */
    const tidUi = tid2 || tid;

    console.log('═══ ④ 桥级：三层校验（正例 / 错配 / 任务不存在）═══');
    const mkEnv = (t, sha) => JSON.stringify({
      envelope: { schema: 'glimmernote.ingest-result/v1', taskId: t, imageSha256: sha },
      result: {
        pageSummary: { totalQuestions: 3, markedWrong: 1 },
        cards: [{ subject: '数学', title: '合成题', questionText: '1+1=?', studentAnswer: '3',
          answerSource: '独立判卷', causeCode: 'K1', confidence: 'high', sourceImageSha256: sha }],
        skipped: [{ what: '第2题', reason: '未作答' }],
      },
    });
    /* .catch 包一层：桥失败（ok:false）会 reject，测试要的是"结论"而不是"抛没抛" */
    const okRun = await cdp.evalJs('CTB.host.taskCheck(' + JSON.stringify(tid) + ', ' + JSON.stringify(mkEnv(tid, SHA_A)) + ').then(function(r){return r;}).catch(function(e){return {ok:false, err:String(e && e.message || e)};})');
    A('A 的结果贴回 A ⇒ code 0 且输出含"第三层未完成"',
      okRun && okRun.code === 0 && /第三层未完成/.test(String(okRun.out)), 'code=' + (okRun && okRun.code));
    const crossRun = await cdp.evalJs('CTB.host.taskCheck(' + JSON.stringify(tid) + ', ' + JSON.stringify(mkEnv('t-19990101-000000-aaaaaa', SHA_A)) + ').then(function(r){return r;}).catch(function(e){return {ok:false, err:String(e && e.message || e)};})');
    A('伪造 taskId（贴别的任务）⇒ code 3 且点名"信封 taskId"',
      crossRun && crossRun.code === 3 && /信封 taskId/.test(String(crossRun.out)), 'code=' + (crossRun && crossRun.code));
    /* 任务号形状合法（6 位 hex）但库里没有 ⇒ code 2。注意别用非 hex 字符——
       那会被壳的形状门禁先拦（那是另一条判据，首轮实测就撞上了它）。 */
    const missing = await cdp.evalJs('CTB.host.taskCheck("t-19990101-000000-dead00", "{}").then(function(r){return r;}).catch(function(e){return {ok:false, err:String(e && e.message || e)};})');
    A('任务不存在 ⇒ code 2', missing && missing.code === 2, JSON.stringify(missing).slice(0, 200));

    console.log('═══ ⑤ UI：粘回 → 三层显示 → 人工确认（第三层由人写）═══');
    await cdp.evalJs('document.querySelector("#igIn").value = ' + JSON.stringify(mkEnv(tidUi, SHA_A, null)));
    await cdp.evalJs('document.querySelector("#igCheck").click()');
    const resultBox = await waitFor(cdp, '(document.querySelector("#igResult")||{}).textContent||""',
      v => /绑定校验通过|不匹配|不通过/.test(String(v)), 30, 500);
    A('三层结论上屏：绑定校验通过', /绑定校验通过/.test(String(resultBox)), String(resultBox || '').slice(0, 110));
    A('第三层如实显示"未完成"（不许假装全通）', /第三层未完成/.test(String(resultBox)));
    const hasConfirm = await cdp.evalJs('!!document.querySelector("#igConfirm")');
    A('确认入口在场（且只在未确认时出现）', hasConfirm === true);
    await cdp.evalJs('document.querySelector("#igConfirm").click()');
    const afterConfirm = await waitFor(cdp, '(document.querySelector("#igResult")||{}).textContent||""',
      v => /已人工确认/.test(String(v)) && !/第三层未完成/.test(String(v)), 30, 500);
    A('点确认后第三层变"已人工确认"（confirmedAt 由人写进记录）',
      /已人工确认/.test(String(afterConfirm)) && !/第三层未完成/.test(String(afterConfirm)),
      String(afterConfirm || '').slice(0, 110));
    const recAfter = JSON.parse(fs.readFileSync(path.join(LIB, '_录题', String(tidUi) + '.json'), 'utf8'));
    A('记录里 confirmedAt 真的写入了', !!recAfter.confirmedAt, String(recAfter.confirmedAt));

    console.log('═══ ⑥ UI：把 A 的结果贴成 B 的（错配红显 + 不要入库）═══');
    /* 用 CLI 另造任务 B（同库不同图），页面句柄还在 A 上 —— 粘 B 的信封必须红 */
    const jpgB = jpg(0x22);
    const shaB = crypto.createHash('sha256').update(jpgB).digest('hex');
    spawnSync(process.execPath, [path.join(ROOT, 'src', 'tools', '_配方.mjs'), '组装', '--recipe', 'ingest-page',
      '--subject', '数学', '--task', '--image', '_收件箱/批次E2E/p002.jpg', '--out', path.join(LIB, 'taskB.md'), '--data', LIB],
      { encoding: 'utf8' });
    /* 排除本轮造过的任务记录：`tid`（首次）、`tid2`（带卡那次）。剩下的才是 CLI 侧新造的 B。 */
    const recBDir = fs.readdirSync(path.join(LIB, '_录题')).filter(f => f !== String(tid) + '.json' && f !== String(tid2) + '.json');
    A('B 任务记录已生成（CLI 侧）', recBDir.length === 1, recBDir.join(','));
    const tidB = recBDir[0].replace(/\.json$/, '');
    await cdp.evalJs('document.querySelector("#igIn").value = ' + JSON.stringify(mkEnv(tidB, shaB, null)));
    await cdp.evalJs('document.querySelector("#igCheck").click()');
    const cross = await waitFor(cdp, '(document.querySelector("#igResult")||{}).textContent||""',
      v => /不要入库/.test(String(v)), 30, 500);
    A('跨任务贴错 ⇒ 页面红显"与任务不匹配 / 不要入库"', /不要入库/.test(String(cross)), String(cross || '').slice(0, 110));

    console.log('\n═══ ⑦ 页面无 JS 异常 ═══');
    A('全程无未捕获异常', cdp.errs.length === 0, cdp.errs.slice(0, 3).join(' | '));

    console.log('\n═══ ⑧ F-40 复活按钮：不得带内联 onclick，且点它必须真的 reload ═══');
    /* 强制走 shell.js 的 `catch`（渲染出错分支）：把 model 的一个函数打成抛异常，
       topbar() 在第一个 try 里调用它 ⇒ 复现"界面外壳渲染出错"，走真实代码路径建那个按钮。
       ⚠ 为什么"零 CSP 违规"那一条必须放在**这一步之后**：这个按钮只在渲染出错时才被创建，
       ②b/⑦ 那一刻它还不存在于 DOM 里 ⇒ 那时查违规查不到它。判据必须覆盖"错误分支也渲染完"
       之后的页面，否则 B-1 那一类回归正好从这条缝里溜走（这正是本用例最初漏掉它的原因）。 */
    await cdp.evalJs("window.__e2eAlive = 1; CTB.model.students = function(){ throw new Error('e2e-forced-render-error'); }; CTB.shell.render();");
    const btn = await cdp.evalJs("(function(){var t=Array.prototype.slice.call(document.querySelectorAll('#topbar button'))" +
      ".filter(function(x){return /重载界面/.test(x.textContent||'');})[0];" +
      "return t?{has:true,attr:t.getAttribute('onclick'),isFn:typeof t.onclick==='function'}:{has:false};})()");
    A('渲染出错分支里出现了「⟳ 重载界面」按钮', !!(btn && btn.has), JSON.stringify(btn));
    A('该按钮**没有**内联 onclick 属性（改前是 onclick="location.reload()"）', !!(btn && btn.attr === null), JSON.stringify(btn && btn.attr));
    A('该按钮的对象式 onclick 已挂上函数', !!(btn && btn.isFn) === true, JSON.stringify(btn));
    const inlineAfterErr = await cdp.evalJs("Array.prototype.slice.call(document.querySelectorAll('*'))" +
      ".filter(function(el){return Array.prototype.slice.call(el.attributes).some(function(a){return /^on/i.test(a.name);});}).length");
    A('错误分支渲染后 DOM 内联事件属性仍为 0', inlineAfterErr === 0, 'count=' + inlineAfterErr);
    /* ★ 这一条就是 B-1 的回归网：boot + 驱动 + 交互 + **错误分支渲染** 全过程零 security 违规。
       把 shell.js 的内联 onclick 还原 ⇒ 这一步立刻变红（见复核报告的阴性自跑记录）。 */
    const vAll = secViolations(cdp);
    A('boot+驱动+交互+错误分支全过程 security 违规 = 0（B-1 的回归网）', vAll.length === 0,
      vAll.map(v => v.text).join(' | ').slice(0, 240));
    await cdp.evalJs("Array.prototype.slice.call(document.querySelectorAll('#topbar button'))" +
      ".filter(function(x){return /重载界面/.test(x.textContent||'');}).forEach(function(x){x.click();});");
    /* 判据写成"页面里的哨兵没了"（= 文档被换掉了）。注意别直接把 waitFor 的返回值当字符串比：
       它超时时返回的是 **JS undefined**，`String(undefined)` 也是 'undefined'，会把"没重载"印成
       "typeof=undefined" 这种自相矛盾的详情（本用例首轮阴性自跑就撞上过）。 */
    const reloaded = await waitFor(cdp, 'typeof window.__e2eAlive === "undefined"', v => v === true, 20, 500);
    A('点它之后页面真的重新加载了（哨兵被导航清掉）', reloaded === true,
      'reloaded=' + String(reloaded) + '（undefined = 20 次轮询内没重载）');

    console.log('\n═══ ⑨ 阴性自证：现场注入内联事件处理器 ⇒「零违规」判据必须变红 ═══');
    /* 判据有牙齿的证据：故意注入一个内联 onclick（与 B-1 同族），违规计数必须 +1、且它不得执行。
       放在**最后**：它自己就会造出一条真违规，上面那些"零违规"断言在那之前都已判过。 */
    const before = secViolations(cdp).length;
    await cdp.evalJs("document.body.insertAdjacentHTML('beforeend','<button id=\"negInline\" onclick=\"window.__negInlineHit=1\">neg</button>');" +
      "document.getElementById('negInline').click();");
    await sleep(800);
    const after = secViolations(cdp);
    A('注入内联 onclick 后违规计数 +1（证明"零违规"这条判据有牙齿）', after.length === before + 1, 'before=' + before + ' after=' + after.length);
    A('注入的内联处理器确实没执行（属性式处理器在 CSP 下被拦）',
      await cdp.evalJs('window.__negInlineHit === undefined') === true);
    A('违规原文确实点名 inline event handler（不是别的安全日志凑数）',
      /inline event handler/i.test(after.map(v => v.text).join(' ')), String((after[after.length - 1] || {}).text || '').slice(0, 160));
  } catch (e) {
    A('流程本身没有抛异常', false, (e && e.message || e).slice ? String(e && e.message || e).slice(0, 200) : String(e));
  } finally {
    if (cdp) cdp.close();
    killOwnShell();
    await sleep(1200);
    /* 残余自证（改前是按镜像名杀完就完事，证明不了"自己那个"真的退了） */
    A('本用例自己的壳 pid=' + shellPid + ' 已退出（只杀自己，未按镜像名杀任何进程）', !ownShellAlive(),
      'ownShellAlive=' + ownShellAlive());
    try { fs.rmSync(LIB, { recursive: true, force: true }); } catch (e) { }
  }
  console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + total);
  process.exit(fails ? 1 : 0);
})();
