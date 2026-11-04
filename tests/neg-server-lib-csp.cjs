#!/usr/bin/env node
/**
 * R1（2026-11-02 立）· 2026-11-03 改造到「类型准入」新契约 · 库内文档 CSP 必须真的拦住"外站子资源"
 *
 * ── 历史缺陷记录（**不许删**：这是本用例存在的理由，ws1-http 2026-11-02 亲测）──
 *   改前库内文档的 CSP 只有 `sandbox; frame-ancestors 'none'` —— `sandbox` 只禁脚本**执行**、
 *   不禁子资源**取用**：A 臂实测 **8 条真实出站**（`<link>` 样式表、favicon、外链 `<script src>`、
 *   `<img>`、`<object>`、CSS `@import`、`<iframe>`、CSS 背景图；8/8 **无 Referer 也照样到达**计数器）。
 *   即"打开一个含远程图片的库内 HTML"就把 IP/时间/UA 交给了写它的人。
 *   修法（唯一实现 `src\tools\_服务端.mjs::LIB_CSP`）：补 `default-src 'none'`，再按需开三个口子
 *   （`img-src` 显式列 127.0.0.1:PORT / localhost:PORT / data:；`style-src 'unsafe-inline'`；
 *   `script-src` 不列 ⇒ 继承 `none`，外链脚本连**请求**都不发）。
 *
 * ── 2026-11-03：为什么要改造（R8 整改③「静态暴露」给静态路由叠了**类型准入**）──
 *   `staticAllowed` 现在的准入表：图片按扩展名（jpg/jpeg/png/webp/gif/bmp/tif/tiff）+ 文本只留两个
 *   有静态消费者的（`错题记录.md` 任意深度 / `_组卷台账.json`）。副作用：**库内 .html / .svg 一律 403**。
 *   本用例原做法是"真浏览器打开库内 `probe-fixed.html`，断言外站命中=0 + 本地图片真加载"——
 *   探针本身已被 403，首步就红（2026-11-03 08:54 实测整轮 quick `RESULT=FAIL(17)`，批次 1 唯一红项）。
 *   改造原则：**契约变了判据要跟着变，但不许比原来弱**。四条腿：
 *     ① 判据真值（①）：LIB_CSP/APP_CSP 由本用例**从源码字面量求值**得到（不是抄一份），
 *        所以源码改了这里必跟着动；并钉住"两份不是同一个值"。
 *     ② 类型准入（②）：库内 .html / .svg → 403，且 403 响应体**一个探针字节都不能含**（随机 nonce 比对）。
 *     ③ 仍可下发的库内文件（③）+ 程序根正对照（④）：前者 200 且 CSP **逐字 = LIB_CSP**、**逐字 ≠ APP_CSP**；
 *        后者 200 且 CSP **逐字 = APP_CSP**、**逐字 ≠ LIB_CSP**（防"两边一起退化成一个值"）。
 *     ④ 真浏览器臂保留（⑥，本用例原有的价值，不许退化成纯 HTTP 断言）：库内 .html 现在 403 ⇒
 *        浏览器臂改用**源码级替身**把类型准入摘掉（`staticAllowed` 直接 `return true`，其余一字不动），
 *        于是库内 .html 真被下发，才能回答"旧攻击路径在真浏览器里还活着吗"：
 *          · A 臂（真源码）：/题干.html → 403，外站命中 0（CDP 同时确认响应码就是 403）；
 *          · B 臂（替身：摘类型准入，CSP 仍是 LIB_CSP）：探针文档真打开、**本地图片真加载**（正对照）、
 *            外站命中 **0**、远程子资源被 CSP 拦（loadingFailed 带 csp）、内联脚本没执行；
 *          · C 臂（替身：摘类型准入 + CSP 退回旧值）：同一份文档外站命中 **> 0**（缺陷复现）。
 *            C 臂是 A/B 臂"0 命中"的可信度来源 —— 它证明装置真的看得见出站。
 *
 * ── 阴性自证（必须有牙齿）──
 *   正式跑（⑤）：源码级替身 M1（三元判据→一律 APP_CSP）/M2（LIB_CSP 改回旧值）/M3（LIB_CSP 声明删除）
 *   必须让 ③ 变红，M4（程序页判据→一律 LIB_CSP）必须让 ④ 变红；④ 由本用例现场断言。
 *   `node tests\neg-server-lib-csp.cjs --negproof`：把 ③/④ 的**同一份判据函数**直接打到这些替身上，
 *   打印原始红条（该模式下"红 = 通过"，退出码 0；判据居然是绿的才退出 1）。门禁只跑无参形态。
 *   ⚠ "外站命中 = 0"这类断言只有在**计数器自检通过**（一次真请求真的被记账）时才可信，见 ⓪。
 *
 * ⚠ 只起 **headless** Edge（`--headless=new` + 独立 user-data-dir + 独立调试口），绝不用可见窗口；
 *   收尾按 user-data-dir 核对残余进程 = 0，并且**先自检该核对装置真的查得到存活的 Edge**（否则"0 残余"是空话）。
 * 退出码 0 = 全绿；Edge 起不来 ⇒ FAIL（不静默 SKIP —— 静默跳过等于把这条判据废掉）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ROOT, req, waitHealth, counter, sleep } = require('./neg-server-lib.cjs');

const { A, end } = counter();
const PORT = 18011;               // A 臂 / HTTP 判据：被测服务端（真源码）
const CNT_PORT = 18012;           // "外站"计数器
const DBG_PORT = 18013;           // headless Edge 的 CDP 口
const MUT_APPCSP_PORT = 18014;    // 阴性自证 M1：三元判据 → 一律 APP_CSP（任务书点名的替身）
const MUT_OLDCSP_PORT = 18015;    // 阴性自证 M2：LIB_CSP 字面量改回旧值
const MUT_NOLIBCSP_PORT = 18016;  // 阴性自证 M3：LIB_CSP 声明整体删除
const MUT_LIBCSP_PORT = 18017;    // 阴性自证 M4：程序页判据 → 一律 LIB_CSP（验 ④ 有牙齿）
const MUT_TYPE_PORT = 18018;      // B 臂：摘掉类型准入（CSP 仍是 LIB_CSP）
const MUT_OLDBOTH_PORT = 18019;   // C 臂：摘掉类型准入 + CSP 退回旧值
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-libcsp-'));
const LIB = path.join(OUT, 'lib');                 // 自建临时库：绝不碰用户真库
const PROFILE = path.join(OUT, 'edge-profile');
const REPOS = path.join(OUT, 'repos');
const BASE_REPO = path.join(REPOS, '_base');
const SRC_PATH = path.join(ROOT, 'src', 'tools', '_服务端.mjs');
const NONCE = crypto.randomBytes(8).toString('hex');   // 探针文件的唯一标记：泄漏检查按它判
const OLD_CSP_DECL = "const LIB_CSP = \"sandbox; frame-ancestors 'none'\";";
const TERNARY = 'const csp = o.sandbox ? LIB_CSP : APP_CSP;';
const STATIC_FN = 'function staticAllowed(relPath) {';
const TYPE_OFF = STATIC_FN + ' return true; /* 阴性自证：只摘掉类型准入，其余一字不动 */';
const PNG = require('../scripts/png-cjs.cjs');

/* ── 库内被测 HTML：一条远程子资源都不能少（都是 ws1 实测真到达计数器的那些形态）── */
function probeHtml(arm) {
  const c = 'http://127.0.0.1:' + CNT_PORT + '/' + arm + '/';
  return [
    '<!doctype html>',
    '<html lang="zh"><head><meta charset="utf-8">',
    '<title>PROBE-' + arm + '</title>',
    '<link rel="stylesheet" href="' + c + 'link-style.css">',
    '<link rel="icon" href="' + c + 'favicon.ico">',
    '<style>@import url("' + c + 'import.css"); body{background:#fff}</style>',
    '<script src="' + c + 'ext-script.js"></script>',
    '<script>window.__probeInlineRan = true; document.getElementById("probe-marker").textContent = "INLINE-RAN";</script>',
    '</head><body>',
    'PROBE-BODY-MARKER-' + NONCE,
    '<img id="remoteimg" src="' + c + 'remote-img.png" width="16" height="16">',
    '<img id="localpix" src="/local-pixel.png" width="16" height="16">',
    '<iframe src="' + c + 'frame.html" width="40" height="40"></iframe>',
    '<object data="' + c + 'object.html" width="40" height="40"></object>',
    '<div id="probe-marker">no</div>',
    '</body></html>',
  ].join('\n');
}

/* ── "外站"计数器：记录每条到达的请求（URL/Referer/UA），并回合法子资源 ── */
const hits = [];
const counterSrv = http.createServer((rq, rs) => {
  hits.push({ url: rq.url, referer: rq.headers.referer || '', ua: String(rq.headers['user-agent'] || '').slice(0, 40) });
  if (/\.css$/.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'text/css' }); return rs.end('body{color:red}'); }
  if (/\.js$/.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'text/javascript' }); return rs.end('window.__counterJsRan=1;'); }
  if (/\.html?$/.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'text/html' }); return rs.end('<p>counter</p>'); }
  rs.writeHead(200, { 'Content-Type': 'image/png' });
  return rs.end(PNG.pngGray(2, 2, () => 0));
});
const hitsOf = arm => hits.filter(h => h.url.startsWith('/' + arm + '/')).length;
const pathsOf = arm => hits.filter(h => h.url.startsWith('/' + arm + '/')).map(h => h.url.slice(arm.length + 2));

function startServerAt(serverJs, port, lib) {
  const proc = spawn(process.execPath, [serverJs], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: lib }),
  });
  const s = { proc, out: '', err: '', port };
  proc.stdout.on('data', d => { s.out += d; });
  proc.stderr.on('data', d => { s.err += d; });
  s.stop = () => new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; setTimeout(res, 120); } };
    proc.once('exit', fin);
    try { proc.kill(); } catch (e) { }
    setTimeout(fin, 1500);
  });
  return s;
}

/* ── 源码级替身工厂：复制整棵 src\tools + src\app\index.html，只按 edits 改字面量 ── */
function makeBaseRepo() {
  fs.mkdirSync(path.join(BASE_REPO, 'src', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(BASE_REPO, 'src', 'app'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'tools'))) {
    fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(BASE_REPO, 'src', 'tools', f));
  }
  fs.copyFileSync(path.join(ROOT, 'src', 'app', 'index.html'), path.join(BASE_REPO, 'src', 'app', 'index.html'));
}
function makeRepo(label, edits) {
  const repo = path.join(REPOS, 'repo-' + label.replace(/[^A-Za-z0-9_-]/g, '_'));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.cpSync(BASE_REPO, repo, { recursive: true });
  const p = path.join(repo, 'src', 'tools', '_服务端.mjs');
  let src = fs.readFileSync(p, 'utf8');
  for (const [from, to] of edits) {
    if (!src.includes(from)) throw new Error('阴性自证无效：替身 ' + label + ' 在源码里找不到改写目标 ' + JSON.stringify(String(from).slice(0, 90)));
    src = src.split(from).join(to);
  }
  fs.writeFileSync(p, src, 'utf8');
  return p;
}

/** 抽出源码里 `const NAME = <expr>;` 的 <expr> 原文（按引号感知扫到真分号，别被 CSP 串里的分号截断） */
function declOf(src, name) {
  const key = 'const ' + name + ' = ';
  const i = src.indexOf(key);
  if (i < 0) throw new Error('源码里找不到 ' + name + ' 声明（本用例的真值来源）');
  let j = i + key.length, q = null;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === ';') break;
  }
  if (j >= src.length) throw new Error(name + ' 声明找不到结尾分号');
  return { start: i, end: j + 1, text: src.slice(i, j + 1), expr: src.slice(i + key.length, j) };
}

/* ── CDP（浏览器级 ws + flatten session），照 tests\verify-v2-interactive-sweep.cjs 的成法 ── */
function cdpConnect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const c = { id: 0, pm: new Map(), ws, events: [] };
    ws.onopen = () => res(c);
    ws.onerror = () => rej(new Error('CDP ws 连不上：' + url));
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && c.pm.has(m.id)) {
        const p = c.pm.get(m.id); c.pm.delete(m.id);
        if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result);
        return;
      }
      if (m.method) c.events.push(m);
    };
    c.send = (method, params, sessionId) => new Promise((res2, rej2) => {
      const id = ++c.id;
      c.pm.set(id, { res: res2, rej: rej2 });
      ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
      setTimeout(() => { if (c.pm.has(id)) { c.pm.delete(id); rej2(new Error('CDP 超时：' + method)); } }, 20000);
    });
    c.close = () => { try { ws.close(); } catch (e) { } };
  });
}

async function getJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch (e) { }
    await sleep(500);
  }
  return null;
}

const edgeCandidates = () => [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .filter(Boolean)
  .map(b => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  .filter(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });

/** 按 user-data-dir 查存活的 msedge PID（返回 null = 查询装置本身坏了，不许当成"残余 0"） */
function edgePids() {
  const pat = PROFILE.replace(/'/g, "''");
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + pat + "*' } | Select-Object -ExpandProperty ProcessId"],
    { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').split(/\s+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
}

/** 收尾：按 user-data-dir 核对/清理残余 msedge（返回残余条数；-1 = 查不出来） */
async function edgeLeftovers() {
  for (let tries = 0; tries < 4; tries++) {
    const pids = edgePids();
    if (pids === null) return -1;
    if (!pids.length) return 0;
    if (tries === 3) return pids.length;
    for (const pid of pids) { try { spawnSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore', windowsHide: true }); } catch (e) { } }
    await sleep(500);
  }
  return -1;
}

/* ════════ 夹具库 + ③/④ 判据体（唯一实现：正式跑与 --negproof 共用，防"自证"与"正式判据"漂移）════════ */
const NESTED = '九年级/物理/P0001-测试卡';
const FIX_TEXT = {
  '错题记录.md': '# POS-错题记录\n',
  [NESTED + '/错题记录.md']: '# POS-嵌套错题记录\n',
  '_组卷台账.json': '{"papers":[],"POS":"组卷台账"}',
};
const POS = [
  ['_原图/xx.png', 'png', '保全库形态的库内图片（前端 img src 的唯一取图通道）'],
  ['local-pixel.png', 'png', '库根图片（浏览器臂探针文档里的本地正对照图）'],
  ['错题记录.md', 'text', 'bank.js 静态读的错题记录（任意深度同名）'],
  [NESTED + '/错题记录.md', 'text', '嵌套深度同名（类型准入按文件名，不按深度）'],
  ['_组卷台账.json', 'text', 'UI 唯一静态读取的根台账（paper.js readFile）'],
];
function buildLib() {
  const w = (rel, text) => {
    const p = path.join(LIB, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  };
  const wBuf = (rel, buf) => {
    const p = path.join(LIB, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  };
  w('题干.html', probeHtml('LIB'));            // A 臂 / 泄漏检查（真源码下必须 403）
  w('题干-新.html', probeHtml('M'));           // B 臂：替身（摘类型准入 + 新 CSP）
  w('题干-旧.html', probeHtml('B'));           // C 臂：替身（摘类型准入 + 旧 CSP）
  w(NESTED + '/题干.html', probeHtml('LIB'));  // 嵌套目录同款（换目录不放行）
  w('题干.svg', '<svg xmlns="http://www.w3.org/2000/svg"><!-- NEG-SVG-MARKER --><script>1</script></svg>');
  w('_原图/x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><!-- NEG-SVG-MARKER --></svg>');
  w('_原图/notes.md', '# NEG-原图里的普通 md');
  w('readme.md', '# NEG-普通 md（错题记录.md 之外的同扩展名）');
  w('_状态.json', '{"NEG":"状态包"}');
  w('数据表.csv', 'NEG-数据表');
  w('先看这里.txt', 'NEG-先看这里');
  for (const [rel, text] of Object.entries(FIX_TEXT)) w(rel, text);
  wBuf('_原图/xx.png', PNG.pngGray(2, 2, () => 200));
  wBuf('local-pixel.png', PNG.pngGray(8, 8, () => 128));
}

/** ③ 的判据：仍可下发的库内文件必须 200 + CSP 逐字 = LIB_CSP + 逐字 ≠ APP_CSP */
async function judgeAllowedFiles(port, wantLib, wantApp) {
  for (const [rel, kind, why] of POS) {
    const r = await req(port, '/' + rel);
    const csp = String(r.headers['content-security-policy'] || '');
    const size = fs.statSync(path.join(LIB, ...rel.split('/'))).size;
    A('GET /' + rel + ' → 200（' + why + '）', r.status === 200, 'status=' + r.status + ' body=' + r.text.slice(0, 60));
    A('  ↳ CSP 逐字等于源码 LIB_CSP', csp === wantLib, csp);
    A('  ↳ CSP 逐字不等于 APP_CSP（防两边一起退化成同一个值）', csp !== wantApp, csp.slice(0, 80));
    A('  ↳ Cache-Control: no-store（库内响应不留存）', r.headers['cache-control'] === 'no-store', String(r.headers['cache-control']));
    A('  ↳ Content-Length = 文件真实字节数（不是空 200）', Number(r.headers['content-length']) === size,
      'CL=' + r.headers['content-length'] + ' 实际=' + size);
    if (kind === 'text') A('  ↳ 正文与原文件逐字节相同', r.text === FIX_TEXT[rel], 'len=' + r.text.length + '/' + FIX_TEXT[rel].length);
    else A('  ↳ Content-Type = image/png', r.headers['content-type'] === 'image/png', String(r.headers['content-type']));
  }
}

/** ④ 的判据：程序根 index.html 必须 200 + CSP 逐字 = APP_CSP + 逐字 ≠ LIB_CSP */
async function judgeAppRoot(port, wantApp, wantLib) {
  const home = await req(port, '/index.html');
  A('GET /index.html → 200（程序入口照常下发）', home.status === 200, 'status=' + home.status);
  A('  ↳ CSP 逐字等于源码 APP_CSP', String(home.headers['content-security-policy']) === wantApp, String(home.headers['content-security-policy']));
  A('  ↳ CSP 逐字不等于 LIB_CSP（程序页不该拿库内那套 sandbox CSP）',
    String(home.headers['content-security-policy']) !== wantLib, '');
  A('  ↳ 确实是程序根那份 index.html（含本轮 token 注入）',
    /<meta name="__ctbToken" content="[0-9a-f]+">/.test(home.text), '');
}

/* ── --negproof：把 ③/④ 的**同一份判据**打到替身上，打印原始红条（红 = 通过）── */
async function negProof(libCspFor, libDeclText, wantApp) {
  const arms = [
    { label: 'M1:三元判据改成一律 APP_CSP', edits: [[TERNARY, 'const csp = APP_CSP;']], port: MUT_APPCSP_PORT, judge: 'lib', why: '③ 的「CSP 逐字等于 LIB_CSP」必须变红' },
    { label: 'M2:LIB_CSP 改回旧值', edits: [[libDeclText, OLD_CSP_DECL]], port: MUT_OLDCSP_PORT, judge: 'lib', why: '③ 的 CSP 判据必须变红（同 R1 缺陷本体）' },
    { label: 'M3:LIB_CSP 声明整体删除', edits: [[libDeclText, '/* 阴性自证：LIB_CSP 声明整体删除 */']], port: MUT_NOLIBCSP_PORT, judge: 'lib', why: '③ 的 200/CSP 判据必须变红' },
    { label: 'M4:程序页判据改成一律 LIB_CSP', edits: [[TERNARY, 'const csp = LIB_CSP;']], port: MUT_LIBCSP_PORT, judge: 'app', why: '④ 的 CSP 判据必须变红' },
  ];
  try {
    console.log('\n══ 阴性自证（--negproof）：③/④ 的判据原样打到源码级替身上，必须打印红条 ══');
    for (const arm of arms) {
      console.log('\n──────── 替身 ' + arm.label + '（端口 ' + arm.port + '）—— ' + arm.why + ' ────────');
      const m = startServerAt(makeRepo(arm.label.split(':')[0], arm.edits), arm.port, LIB);
      try {
        if (!await waitHealth(arm.port)) { A('替身实例启动：' + arm.label, false, 'health 超时；err=' + m.err.slice(0, 200)); continue; }
        if (arm.judge === 'lib') await judgeAllowedFiles(arm.port, libCspFor(arm.port), wantApp);
        else await judgeAppRoot(arm.port, wantApp, libCspFor(arm.port));
      } finally { await m.stop(); }
    }
  } finally {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  const rc = end('R1 库内文档 CSP（--negproof：替身必须红，红 = 通过）');
  console.log(rc === 1
    ? 'NEGPROOF=PASS：判据在替身上确实变红（上面每条 ✖ 都是被替身打红的）⇒ 判据有牙齿，退出码 0'
    : 'NEGPROOF=FAIL：替身下判据居然是绿的 ⇒ 判据没有牙齿，退出码 1');
  process.exit(rc === 1 ? 0 : 1);
}

(async () => {
  let code = 1;
  let edge = null, cdp = null, srvType = null, srvTypeOld = null;
  fs.mkdirSync(LIB, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  makeBaseRepo();
  buildLib();

  console.log('\n══ ① 判据真值：LIB_CSP / APP_CSP 由源码字面量求值（不是抄一份）══');
  const SRC = fs.readFileSync(SRC_PATH, 'utf8');
  const libDecl = declOf(SRC, 'LIB_CSP');
  const appDecl = declOf(SRC, 'APP_CSP');
  const wantLib = new Function('PORT', 'return ' + libDecl.expr)(PORT);
  const wantApp = new Function('PORT', 'return ' + appDecl.expr)();
  /* LIB_CSP 里含运行时常量 PORT ⇒ 替身跑在别的端口时，它那份 LIB_CSP 的端口段也跟着变 */
  const libCspFor = p => new Function('PORT', 'return ' + libDecl.expr)(p);

  if (process.argv.includes('--negproof')) await negProof(libCspFor, libDecl.text, wantApp);

  A('LIB_CSP 以 `sandbox;` 开头（库内文档一律不透明源）', wantLib.startsWith('sandbox;'), wantLib.slice(0, 40));
  A("LIB_CSP 含 `default-src 'none'`（R1 的核心判据）", wantLib.indexOf("default-src 'none'") >= 0, '');
  A('LIB_CSP 的 img-src 显式列 127.0.0.1:PORT + localhost:PORT + data:',
    wantLib.indexOf('img-src http://127.0.0.1:' + PORT + ' http://localhost:' + PORT + ' data:') >= 0, wantLib);
  A('两份 CSP 不是同一个值（否则"逐字等于/不等于"两条判据自相矛盾）', wantLib !== wantApp,
    'LIB=' + wantLib.slice(0, 50) + ' ｜ APP=' + wantApp.slice(0, 50));
  A('源码仍保留唯一分支点 `' + TERNARY + '`（⑤阴性自证的前提）', SRC.includes(TERNARY), '');
  A('源码仍以 ' + STATIC_FN + ' 为类型准入实现位置（⑥浏览器替身要在此动手）', SRC.includes(STATIC_FN), '');

  await new Promise(r => counterSrv.listen(CNT_PORT, '127.0.0.1', r));

  const srv = startServerAt(SRC_PATH, PORT, LIB);
  try {
    if (!await waitHealth(PORT)) {
      A('被测实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；err=' + srv.err.slice(0, 300));
      process.exit(end('R1 库内文档 CSP（新契约）'));
    }
    A('被测实例启动（127.0.0.1:' + PORT + '，库=自建临时库）', true);

    console.log('\n══ ⓪ 装置自检：计数器真的会记账（否则"命中 0"不可信）══');
    const sc = await req(CNT_PORT, '/selfcheck/hit.png');
    A('"外站"计数器自检：一次真请求必须被记账 1 条', sc.status === 200 && hitsOf('selfcheck') === 1,
      'status=' + sc.status + ' 记账=' + hitsOf('selfcheck'));

    console.log('\n══ ② 库内 .html / .svg 必须 403（R8 类型准入），且一个探针字节都不许泄漏══');
    const rHtml = await req(PORT, '/题干.html');
    A('GET /题干.html → 403（改前是 200 + 整份探针文档）', rHtml.status === 403, 'status=' + rHtml.status + ' body=' + rHtml.text.slice(0, 90));
    A('  ↳ 403 响应体不含探针 nonce（' + NONCE + '）', rHtml.text.indexOf(NONCE) < 0, rHtml.text.slice(0, 90));
    A('  ↳ 403 响应体不含 PROBE- 标题 / body 标记 / 任何探针标签',
      rHtml.text.indexOf('PROBE-') < 0 && rHtml.text.indexOf('<iframe') < 0 && rHtml.text.indexOf('<img') < 0 && rHtml.text.indexOf('<script') < 0,
      rHtml.text.slice(0, 90));
    A('  ↳ 403 是结构化拒绝（json.ok=false），不是拿空的 200/404 冒充', !!(rHtml.json && rHtml.json.ok === false), rHtml.text.slice(0, 110));
    const rNested = await req(PORT, '/' + NESTED + '/题干.html');
    A('GET /' + NESTED + '/题干.html → 403（换目录不放行）', rNested.status === 403, 'status=' + rNested.status);
    const rSvg = await req(PORT, '/题干.svg');
    A('GET /题干.svg → 403（svg 不进图片集：当作文档打开可带脚本）', rSvg.status === 403, 'status=' + rSvg.status);
    A('  ↳ 403 响应体不含 svg 原文标记', rSvg.text.indexOf('NEG-SVG-MARKER') < 0, rSvg.text.slice(0, 80));
    const rSvgInImg = await req(PORT, '/_原图/x.svg');
    A('GET /_原图/x.svg → 403（允许目录 + 非图片扩展名 ⇒ 类型准入仍然拦）', rSvgInImg.status === 403, 'status=' + rSvgInImg.status);
    const rMdImg = await req(PORT, '/_原图/notes.md');
    A('GET /_原图/notes.md → 403（文本按**文件名**准，不按扩展名）', rMdImg.status === 403, 'status=' + rMdImg.status);
    const rReadme = await req(PORT, '/readme.md');
    A('GET /readme.md → 403（"错题记录.md"之外的同扩展名不放行）', rReadme.status === 403, 'status=' + rReadme.status);
    const rLedger = await req(PORT, '/_状态.json');
    A('GET /_状态.json → 403（前缀四道判据没被类型准入放宽）', rLedger.status === 403, 'status=' + rLedger.status);
    const rCsv = await req(PORT, '/数据表.csv');
    const rTxt = await req(PORT, '/先看这里.txt');
    A('GET /数据表.csv 与 /先看这里.txt → 403（R8 实测这两类零消费方）',
      rCsv.status === 403 && rTxt.status === 403, 'csv=' + rCsv.status + ' txt=' + rTxt.status);

    console.log("\n══ ③ 仍可下发的库内文件 → 200，CSP 逐字 = LIB_CSP 且逐字 ≠ APP_CSP ══");
    await judgeAllowedFiles(PORT, wantLib, wantApp);

    console.log('\n══ ④ 正对照：程序根 index.html → 200，CSP 逐字 = APP_CSP ══');
    await judgeAppRoot(PORT, wantApp, wantLib);

    console.log('\n══ ⑤ 阴性自证（HTTP 层）：把判据改坏，③/④ 的断言必须变红 ══');
    async function withMutant(label, edits, port, fn) {
      const js = makeRepo(label, edits);
      const m = startServerAt(js, port, LIB);
      try {
        if (!await waitHealth(port)) {
          A('替身实例启动：' + label, false, 'health 超时；err=' + m.err.slice(0, 300));
          return;
        }
        await fn(port);
      } finally { await m.stop(); }
    }
    /* M1（任务书点名）：三元判据 → 一律 APP_CSP ⇒ ③ 必须变红 */
    await withMutant('M1', [[TERNARY, 'const csp = APP_CSP;']], MUT_APPCSP_PORT, async port => {
      A('替身 M1 启动（唯一改动：' + TERNARY + ' → 一律 APP_CSP）', true);
      const r = await req(port, '/_原图/xx.png');
      const csp = String(r.headers['content-security-policy'] || '');
      A('★ M1：同一路径仍 200（内容通道没变），但 CSP = APP_CSP ⇒ ③ 的 CSP 判据必然变红',
        r.status === 200 && csp === wantApp && csp !== libCspFor(port), 'status=' + r.status + ' csp=' + csp.slice(0, 80));
      A('  ↳ 正文长度仍等于文件字节数（证明唯一变量就是那条 CSP 判据）',
        Number(r.headers['content-length']) === fs.statSync(path.join(LIB, '_原图', 'xx.png')).size, 'CL=' + r.headers['content-length']);
    });
    /* M2：LIB_CSP 字面量被改回 R1 之前的旧值 ⇒ ③ 必须变红（同时复现 R1 缺陷本体） */
    await withMutant('M2', [[libDecl.text, OLD_CSP_DECL]], MUT_OLDCSP_PORT, async port => {
      const r = await req(port, '/_原图/xx.png');
      const csp = String(r.headers['content-security-policy'] || '');
      A("★ M2：LIB_CSP 被改回旧值 `sandbox; frame-ancestors 'none'` ⇒ ③ 的判据必然变红",
        r.status === 200 && csp === "sandbox; frame-ancestors 'none'" && csp !== libCspFor(port), 'status=' + r.status + ' csp=' + csp);
    });
    /* M3：LIB_CSP 声明整体删除 ⇒ 请求路径引用未声明标识符 ⇒ ③ 必须变红 */
    await withMutant('M3', [[libDecl.text, '/* 阴性自证：LIB_CSP 声明整体删除 */']], MUT_NOLIBCSP_PORT, async port => {
      let r;
      try { r = await req(port, '/_原图/xx.png'); }
      catch (e) { r = { status: 0, headers: {}, text: 'REQ-ERR ' + String((e && e.message) || e) }; }
      const csp = String(r.headers['content-security-policy'] || '');
      A('★ M3：LIB_CSP 声明被整体删除 ⇒ ③ 的判据同样变红（拿不到 LIB_CSP 头）',
        !(r.status === 200 && csp === libCspFor(port)), 'status=' + r.status + ' csp=' + (csp || '<无>').slice(0, 60));
    });
    /* M4：程序页判据 → 一律 LIB_CSP ⇒ ④ 必须变红（否则 ④ 是死断言） */
    await withMutant('M4', [[TERNARY, 'const csp = LIB_CSP;']], MUT_LIBCSP_PORT, async port => {
      const r = await req(port, '/index.html');
      const csp = String(r.headers['content-security-policy'] || '');
      A('★ M4：程序页判据被改成一律 LIB_CSP ⇒ ④ 的 CSP 判据必然变红（不是死断言）',
        r.status === 200 && csp === libCspFor(port) && csp !== wantApp, 'status=' + r.status + ' csp=' + csp.slice(0, 80));
    });

    console.log('\n══ ⑥ 真浏览器臂（headless Edge + CDP + 本机计数器）══');
    const cands = edgeCandidates();
    A('找到本机 msedge.exe（headless 用；绝不改可见窗口）', cands.length > 0, cands[0] || '候选全不存在：' + JSON.stringify([process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]));
    if (!cands.length) {
      console.log('  ✖ headless Edge 起不来 ⇒ 按纪律**停下来报 lead**，不改用可见窗口。');
      process.exit(end('R1 库内文档 CSP（新契约，Edge 缺失）'));
    }
    const edgeLog = fs.openSync(path.join(OUT, 'edge.stderr.log'), 'a');
    edge = spawn(cands[0], [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-sync', '--disable-background-networking',
      '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + DBG_PORT,
      '--remote-allow-origins=*', 'about:blank',
    ], { stdio: ['ignore', edgeLog, edgeLog], windowsHide: true });
    const ver = await getJson('http://127.0.0.1:' + DBG_PORT + '/json/version');
    A('Edge DevTools 端点就绪（' + String(ver && ver.Browser) + '）', !!ver, ver ? ver.Browser : '起不来');
    if (!ver) {
      console.log('  ✖ headless Edge 起不来 ⇒ 按纪律**停下来报 lead**，不改用可见窗口。');
      process.exit(end('R1 库内文档 CSP（新契约，CDP 未就绪）'));
    }
    cdp = await cdpConnect(ver.webSocketDebuggerUrl);
    const seenAlive = edgePids();
    A('收尾对账装置自检：Edge 存活时按 user-data-dir 必须查得到它（否则"残余=0"是空话）',
      !!seenAlive && seenAlive.length > 0, seenAlive === null ? '查询失败（powershell/CIM 不可用）' : '查到 ' + seenAlive.length + ' 个');

    /* 浏览器臂的两个替身：只摘掉类型准入（LIB_CSP 仍是新值 / 退回旧值），其余一字不动 */
    srvType = startServerAt(makeRepo('MTYPE', [[STATIC_FN, TYPE_OFF]]), MUT_TYPE_PORT, LIB);
    srvTypeOld = startServerAt(makeRepo('MTYPEOLD', [[STATIC_FN, TYPE_OFF], [libDecl.text, OLD_CSP_DECL]]), MUT_OLDBOTH_PORT, LIB);
    if (!await waitHealth(MUT_TYPE_PORT) || !await waitHealth(MUT_OLDBOTH_PORT)) {
      A('浏览器替身实例启动（摘掉类型准入的两臂）', false,
        'health 超时；err=' + srvType.err.slice(0, 200) + srvTypeOld.err.slice(0, 200));
      throw new Error('浏览器替身起不来，浏览器臂无法执行（不许静默 SKIP）');
    }
    A('浏览器替身实例启动（B 臂 ' + MUT_TYPE_PORT + ' / C 臂 ' + MUT_OLDBOTH_PORT + '，库=同一个临时库）', true);
    {
      const nwR = await req(MUT_TYPE_PORT, '/题干-新.html');
      const odR = await req(MUT_OLDBOTH_PORT, '/题干-旧.html');
      /* arm 标签替换要先把 `PROBE-BODY-MARKER` 摘出来 —— 否则 `PROBE-B`→`PROBE-M` 会把它误伤成 `PROBE-MODY` */
      const expectNw = odR.text.split('/B/').join('/M/')
        .replace(/PROBE-BODY-MARKER/g, '\u0000').replace(/PROBE-B/g, 'PROBE-M').replace(/\u0000/g, 'PROBE-BODY-MARKER');
      A('两个浏览器臂的探针文档只差 arm 标签（同一份 HTML，浏览器臂唯一变量是 CSP）',
        nwR.status === 200 && odR.status === 200 && nwR.text === expectNw,
        'len=' + nwR.text.length + '/' + odR.text.length + ' status=' + nwR.status + '/' + odR.status);
    }

    /** 打开一个 URL，等 4s，读回文档状态、网络事件与响应码 */
    async function arm(url) {
      cdp.events.length = 0;
      const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const at = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const sid = at.sessionId;
      await cdp.send('Network.enable', {}, sid);
      await cdp.send('Page.enable', {}, sid);
      await cdp.send('Runtime.enable', {}, sid);
      await cdp.send('Log.enable', {}, sid);
      try { await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sid); } catch (e) { }
      await cdp.send('Page.navigate', { url }, sid);
      await sleep(4000);
      let dom = null;
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify({' +
            'title: document.title,' +
            'windowOrigin: String(window.origin),' +
            'inlineRan: String(window.__probeInlineRan),' +
            'inlineMarker: (document.getElementById("probe-marker")||{}).textContent || null,' +
            'hasLocalPix: !!document.getElementById("localpix"),' +
            'localNaturalWidth: (document.getElementById("localpix")||{}).naturalWidth || 0,' +
            'localComplete: (document.getElementById("localpix")||{}).complete === true,' +
            'remoteNaturalWidth: (document.getElementById("remoteimg")||{}).naturalWidth || 0,' +
            'bodyHasProbeMarker: document.documentElement.outerHTML.indexOf("PROBE-BODY-MARKER") >= 0,' +
            'resources: performance.getEntriesByType("resource").map(function(e){return e.name;})' +
            '})', returnByValue: true,
        }, sid);
        dom = JSON.parse(r.result.value);
      } catch (e) { dom = { err: String(e && e.message) }; }
      const reqs = cdp.events.filter(e => e.method === 'Network.requestWillBeSent')
        .map(e => e.params.request.url).filter(u => !u.startsWith('data:') && u !== url);
      const responses = cdp.events.filter(e => e.method === 'Network.responseReceived')
        .map(e => ({ url: e.params.response.url, status: e.params.response.status }));
      const failed = cdp.events.filter(e => e.method === 'Network.loadingFailed')
        .map(e => (e.params.blockedReason || '') + ':' + e.params.type + ':' + e.params.errorText);
      const logs = cdp.events.filter(e => e.method === 'Log.entryAdded').map(e => e.params.entry.text);
      await cdp.send('Target.closeTarget', { targetId: t.targetId });
      return { dom, reqs, responses, failed, logs };
    }

    console.log('\n══ ⑥-a A 臂（真源码）：库内 .html 在真浏览器里拿不到探针文档，外站命中 0 ══');
    const f1 = await arm('http://127.0.0.1:' + PORT + '/题干.html');
    A('A 臂：导航真的发生了 —— CDP 看到该 URL 的响应码就是 403',
      f1.responses.some(r => { try { return decodeURIComponent(r.url).indexOf('/题干.html') >= 0 && r.status === 403; } catch (e) { return false; } }),
      JSON.stringify(f1.responses.filter(r => { try { return decodeURIComponent(r.url).indexOf('题干.html') >= 0; } catch (e) { return false; } })).slice(0, 160));
    A('A 臂：浏览器拿到的**不是**探针文档（没有 PROBE- 标题）',
      !!f1.dom && String(f1.dom.title).indexOf('PROBE-') < 0, String(f1.dom && f1.dom.title));
    A('A 臂：页面里没有探针 body 标记', !!f1.dom && f1.dom.bodyHasProbeMarker === false, String(f1.dom && f1.dom.bodyHasProbeMarker));
    A('A 臂：页面里没有探针元素（#localpix 不存在）', !!f1.dom && f1.dom.hasLocalPix === false, '');
    A('★ A 臂：外站计数器命中 = 0（旧攻击路径在真浏览器里确实已死）', hitsOf('LIB') === 0,
      '命中 ' + hitsOf('LIB') + ' 条：' + pathsOf('LIB').join(' 、'));
    A('A 臂：浏览器网络事件里也没有任何计数器请求',
      f1.reqs.filter(u => u.indexOf(':' + CNT_PORT + '/') >= 0).length === 0, JSON.stringify(f1.reqs).slice(0, 160));

    console.log('\n══ ⑥-b B 臂（替身：摘掉类型准入，CSP 仍是 LIB_CSP）：文档下发但取不到任何外站 ══');
    const f2 = await arm('http://127.0.0.1:' + MUT_TYPE_PORT + '/题干-新.html');
    A('B 臂：探针文档真的被下发并解析（标题 PROBE-M）', !!f2.dom && f2.dom.title === 'PROBE-M', JSON.stringify(f2.dom && f2.dom.title));
    A('B 臂：文档确实是不透明源（sandbox 生效：window.origin=null）', !!f2.dom && f2.dom.windowOrigin === 'null', String(f2.dom && f2.dom.windowOrigin));
    A('★ B 臂正对照：本地图片真的加载成功（naturalWidth > 0）⇒ "0 命中"不是因为页面没跑',
      !!f2.dom && f2.dom.localNaturalWidth > 0, 'naturalWidth=' + (f2.dom && f2.dom.localNaturalWidth) + ' complete=' + (f2.dom && f2.dom.localComplete));
    A('★ B 臂：本地图片确实由本服务端下发（resource timing 里有 /local-pixel.png）',
      !!(f2.dom && f2.dom.resources.some(u => u.includes('/local-pixel.png'))), JSON.stringify(f2.dom && f2.dom.resources).slice(0, 160));
    A('★ B 臂：内联脚本没执行（sandbox 无 allow-scripts）', !!f2.dom && f2.dom.inlineRan === 'undefined', String(f2.dom && f2.dom.inlineRan));
    A('★ B 臂：内联脚本没改到 DOM（marker 仍是 no）', !!f2.dom && f2.dom.inlineMarker === 'no', String(f2.dom && f2.dom.inlineMarker));
    A('★ B 臂：外站计数器命中 = 0（库内 .html 即使被下发也取不到外站）', hitsOf('M') === 0,
      '命中 ' + hitsOf('M') + ' 条：' + pathsOf('M').join(' 、'));
    A('B 臂：CDP 确认远程子资源是被 CSP 拦掉的（loadingFailed 带 csp）',
      f2.failed.some(f => f.includes('csp')) || f2.reqs.length === 0, JSON.stringify(f2.failed).slice(0, 160));

    console.log('\n══ ⑥-c C 臂（替身：摘掉类型准入 + CSP 退回旧值）：同一份文档必须复现出站 ══');
    const f3 = await arm('http://127.0.0.1:' + MUT_OLDBOTH_PORT + '/题干-旧.html');
    A('C 臂：探针文档也真的打开了（标题 PROBE-B）', !!f3.dom && f3.dom.title === 'PROBE-B', JSON.stringify(f3.dom && f3.dom.title));
    A('C 臂：本地图片同样加载成功（说明差别只在 CSP，不在装置）', !!f3.dom && f3.dom.localNaturalWidth > 0,
      'naturalWidth=' + (f3.dom && f3.dom.localNaturalWidth));
    A('★ C 臂缺陷复现：旧值下外站命中数 > 0（记录条数）', hitsOf('B') > 0,
      '命中 ' + hitsOf('B') + ' 条：' + pathsOf('B').join(' 、'));
    A('★ C 臂复现形态与 ws1 A 臂一致（至少含 img/link/@import/script 四类）',
      ['remote-img.png', 'link-style.css', 'import.css', 'ext-script.js'].every(x => pathsOf('B').some(p => p.endsWith(x))),
      pathsOf('B').join(' '));
    A('★ 对照：同一份文档 + 同一装置，新 CSP 下 0 条 / 旧 CSP 下 > 0（证明 A/B 臂的 0 有可信度）',
      hitsOf('M') === 0 && hitsOf('B') > 0, 'M=' + hitsOf('M') + ' B=' + hitsOf('B'));
    console.log('  [证据] C 臂（旧 CSP）下到达计数器的 URL（逐条）：');
    for (const h of hits.filter(x => x.url.startsWith('/B/'))) console.log('    ' + h.url + '   Referer=' + (h.referer || '<无>'));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { }
    try { if (edge) edge.kill(); } catch (e) { }
    try { if (srvType) await srvType.stop(); } catch (e) { }
    try { if (srvTypeOld) await srvTypeOld.stop(); } catch (e) { }
    await sleep(500);
    const left = await edgeLeftovers();
    console.log('\n══ ⑦ 收尾：端口释放 + 无残留 headless Edge ══');
    A('自己的 msedge（按 user-data-dir 核对）已全部退出', left === 0, '残余=' + left + '（-1=查询失败；已尽力 taskkill /T）');
    await srv.stop();
    await new Promise(r => counterSrv.close(r));
    A('计数器/服务端端口已释放', true, '');
    fs.rmSync(OUT, { recursive: true, force: true });
    code = end('R1 库内文档 CSP（新契约：类型准入 + 真浏览器 + 本机计数器）');
  }
  process.exit(code);
})().catch(async e => {
  console.error('FATAL ' + (e && e.stack || e));
  try { await edgeLeftovers(); } catch (x) { }
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (x) { }
  process.exit(1);
});
