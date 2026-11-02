#!/usr/bin/env node
/**
 * R1（2026-11-02）· 库内文档 CSP 必须真的拦住"外站子资源"
 *
 * 缺陷（ws1-http 2026-11-02 亲测，五臂实验 + 本机计数器）：
 *   改前库内文档的 CSP 只有 `sandbox; frame-ancestors 'none'` —— `sandbox` 只禁脚本**执行**、
 *   不禁子资源**取用**：A 臂 8 条真实出站（`<link>` 样式表、favicon、外链 `<script src>`、
 *   `<img>`、`<object>`、CSS `@import`、`<iframe>`…）全部打到计数器（8/8 无 Referer 也照样到达）。
 *   即"打开一个含远程图片的库内 HTML"就把 IP/时间/UA 交给了写它的人。
 *
 * 判据（`_服务端.mjs` 的 `LIB_CSP`，唯一实现）：
 *   `sandbox; default-src 'none'; img-src http://127.0.0.1:PORT http://localhost:PORT data:;
 *    style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
 *   本用例用**真浏览器**（headless Edge + CDP）逐条验：
 *     ① 库内 HTML（含远程 img/link/@import/script/iframe/object）打开后，**外站计数器命中数 = 0**；
 *     ② **正对照**：本地图片必须真的加载成功（`naturalWidth > 0`）—— 否则"0 条出站"可能只是页面没跑；
 *     ③ 内联脚本没执行（sandbox 无 allow-scripts）；
 *     ④ 响应头里的 CSP 逐字等于上面那条（含 `default-src 'none'`）；
 *     ⑤ 阴性自证：把 CSP 还原成旧值（只有 `sandbox`）⇒ 同一页面必须复现出站（记录命中条数）。
 *
 * ⚠ 只起 **headless** Edge（`--headless=new` + 独立 user-data-dir + 独立调试口），
 *   绝不用可见窗口；收尾按 user-data-dir 核对残余进程为 0。
 * 退出码 0 = 全绿；Edge 起不来 ⇒ FAIL（不静默 SKIP —— 静默跳过等于把这条判据废掉）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { ROOT, req, waitHealth, counter, sleep } = require('./neg-server-lib.cjs');

const { A, end } = counter();
const PORT = 18011;          // 被测服务端（真源码）
const MUT_PORT = 18014;      // 阴性自证（CSP 还原成旧值）
const CNT_PORT = 18012;      // "外站"计数器
const DBG_PORT = 18013;      // headless Edge 的 CDP 口
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-csp-'));
const LIB = path.join(OUT, 'lib');
const PROFILE = path.join(OUT, 'edge-profile');

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
    '<script>window.__inlineRan = true; document.getElementById("inline-marker").textContent = "INLINE-RAN";</script>',
    '</head><body>',
    '<img id="remoteimg" src="' + c + 'remote-img.png" width="16" height="16">',
    '<img id="localpix" src="/local-pixel.png" width="16" height="16">',
    '<iframe src="' + c + 'frame.html" width="40" height="40"></iframe>',
    '<object data="' + c + 'object.html" width="40" height="40"></object>',
    '<div id="inline-marker">no</div>',
    '</body></html>',
  ].join('\n');
}

/* ── "外站"计数器：记录每条到达的请求（URL/Referer），并回一个合法 PNG ── */
const hits = [];
const counterSrv = http.createServer((rq, rs) => {
  hits.push({ url: rq.url, referer: rq.headers.referer || '', ua: String(rq.headers['user-agent'] || '').slice(0, 40) });
  if (/\.css$/.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'text/css' }); return rs.end('body{color:red}'); }
  if (/\.js$/.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'text/javascript' }); return rs.end('window.__counterJsRan=1;'); }
  if (/\.html?$/.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'text/html' }); return rs.end('<p>counter</p>'); }
  rs.writeHead(200, { 'Content-Type': 'image/png' });
  return rs.end(require('../scripts/png-cjs.cjs').pngGray(2, 2, () => 0));
});
const hitsOf = arm => hits.filter(h => h.url.startsWith('/' + arm + '/')).length;
const pathsOf = arm => hits.filter(h => h.url.startsWith('/' + arm + '/')).map(h => h.url.slice(3));

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

/** 源码级替身：只把库内文档的 CSP 还原成改前的旧值 `sandbox; frame-ancestors 'none'` */
function makeOldCspRepo() {
  const repo = path.join(OUT, 'repo-old');
  fs.mkdirSync(path.join(repo, 'src', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'app'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'tools'))) {
    fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(repo, 'src', 'tools', f));
  }
  fs.copyFileSync(path.join(ROOT, 'src', 'app', 'index.html'), path.join(repo, 'src', 'app', 'index.html'));
  const p = path.join(repo, 'src', 'tools', '_服务端.mjs');
  const src = fs.readFileSync(p, 'utf8');
  const from = 'const csp = o.sandbox ? LIB_CSP : APP_CSP;';
  if (!src.includes(from)) throw new Error('阴性自证无效：源码里找不到 CSP 判据 ' + JSON.stringify(from));
  fs.writeFileSync(p, src.split(from).join('const csp = o.sandbox ? "sandbox; frame-ancestors \'none\'" : APP_CSP;'), 'utf8');
  return path.join(repo, 'src', 'tools', '_服务端.mjs');
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

/** 收尾：按 user-data-dir 核对/清理残余 msedge（返回残余条数） */
function edgeLeftovers() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + PROFILE.replace(/\\/g, '\\\\') + "*' } | Select-Object -ExpandProperty ProcessId"],
      { encoding: 'utf8' });
    const pids = String(out).split(/\s+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    for (const pid of pids) { try { execFileSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore' }); } catch (e) { } }
    return pids.length;
  } catch (e) { return -1; }
}

(async () => {
  let code = 1;
  let edge = null, cdp = null;
  fs.mkdirSync(LIB, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(LIB, 'probe-fixed.html'), probeHtml('F'), 'utf8');
  fs.writeFileSync(path.join(LIB, 'probe-old.html'), probeHtml('B'), 'utf8');
  fs.writeFileSync(path.join(LIB, 'local-pixel.png'), require('../scripts/png-cjs.cjs').pngGray(8, 8, () => 128));

  await new Promise(r => counterSrv.listen(CNT_PORT, '127.0.0.1', r));
  A('"外站"计数器就绪（127.0.0.1:' + CNT_PORT + '）', true);
  const srv = startServerAt(path.join(ROOT, 'src', 'tools', '_服务端.mjs'), PORT, LIB);
  const mutJs = makeOldCspRepo();
  const mut = startServerAt(mutJs, MUT_PORT, LIB);
  try {
    if (!await waitHealth(PORT) || !await waitHealth(MUT_PORT)) {
      A('被测实例 + 替身实例启动', false, 'health 超时；err=' + srv.err.slice(0, 200) + mut.err.slice(0, 200));
      process.exit(end('R1 库内文档 CSP'));
    }
    A('被测实例启动（127.0.0.1:' + PORT + '，库=临时库）', true);
    A('替身实例启动（127.0.0.1:' + MUT_PORT + '，CSP 已还原成旧值）', true);

    console.log('\n══ ① 响应头：库内文档 CSP 逐字等于判据（含 default-src \'none\'）══');
    const want = "sandbox; default-src 'none'; img-src http://127.0.0.1:" + PORT + " http://localhost:" + PORT +
      " data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    const rFixed = await req(PORT, '/probe-fixed.html');
    A('GET /probe-fixed.html → 200', rFixed.status === 200, 'status=' + rFixed.status);
    A("CSP 逐字等于判据", rFixed.headers['content-security-policy'] === want, rFixed.headers['content-security-policy']);
    A("含 default-src 'none'", /default-src 'none'/.test(String(rFixed.headers['content-security-policy'])), '');
    A("含 sandbox（脚本不执行）", /^sandbox;/.test(String(rFixed.headers['content-security-policy'])), '');
    A("含 img-src 的 127.0.0.1/localhost + data:", /img-src http:\/\/127\.0\.0\.1:\d+ http:\/\/localhost:\d+ data:/.test(String(rFixed.headers['content-security-policy'])), '');
    const rOld = await req(MUT_PORT, '/probe-old.html');
    A('替身：CSP = 旧值 `sandbox; frame-ancestors \'none\'`（阴性对照的唯一变量）',
      rOld.headers['content-security-policy'] === "sandbox; frame-ancestors 'none'", rOld.headers['content-security-policy']);
    A('替身与本尊的库内文档只差 arm 标签（同一份 HTML，唯一变量是 CSP）',
      rFixed.text === rOld.text.split('/B/').join('/F/').split('PROBE-B').join('PROBE-F'),
      'len=' + rFixed.text.length + '/' + rOld.text.length);

    console.log('\n══ ② 起 headless Edge（--headless=new + 独立 user-data-dir）══');
    const cands = edgeCandidates();
    A('找到本机 msedge.exe（headless 用；绝不改可见窗口）', cands.length > 0, cands[0] || '候选全不存在：' + JSON.stringify([process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]));
    if (!cands.length) {
      console.log('  ✖ headless Edge 起不来 ⇒ 按纪律**停下来报 lead**，不改用可见窗口。');
      process.exit(end('R1 库内文档 CSP（Edge 缺失）'));
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
      process.exit(end('R1 库内文档 CSP（CDP 未就绪）'));
    }
    cdp = await cdpConnect(ver.webSocketDebuggerUrl);

    /** 打开一个 URL，等 4s，读回文档状态与网络事件 */
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
            'inlineRan: String(window.__inlineRan),' +
            'inlineMarker: (document.getElementById("inline-marker")||{}).textContent || null,' +
            'localNaturalWidth: (document.getElementById("localpix")||{}).naturalWidth || 0,' +
            'localComplete: (document.getElementById("localpix")||{}).complete === true,' +
            'remoteNaturalWidth: (document.getElementById("remoteimg")||{}).naturalWidth || 0,' +
            'resources: performance.getEntriesByType("resource").map(function(e){return e.name;})' +
            '})', returnByValue: true,
        }, sid);
        dom = JSON.parse(r.result.value);
      } catch (e) { dom = { err: String(e && e.message) }; }
      const reqs = cdp.events.filter(e => e.method === 'Network.requestWillBeSent')
        .map(e => e.params.request.url).filter(u => !u.startsWith('data:') && u !== url);
      const failed = cdp.events.filter(e => e.method === 'Network.loadingFailed')
        .map(e => (e.params.blockedReason || '') + ':' + e.params.type + ':' + e.params.errorText);
      const logs = cdp.events.filter(e => e.method === 'Log.entryAdded').map(e => e.params.entry.text);
      await cdp.send('Target.closeTarget', { targetId: t.targetId });
      return { dom, reqs, failed, logs };
    }

    console.log('\n══ ③ 本尊（新 CSP）：外站命中必须 0，且本地图片必须真加载（正对照）══');
    const fixed = await arm('http://127.0.0.1:' + PORT + '/probe-fixed.html');
    A('页面真的打开了（标题/probe 文档已解析）', fixed.dom && fixed.dom.title === 'PROBE-F', JSON.stringify(fixed.dom && fixed.dom.title));
    A('文档确实是不透明源（sandbox 生效：window.origin=null）', fixed.dom && fixed.dom.windowOrigin === 'null', String(fixed.dom && fixed.dom.windowOrigin));
    A('★ 本地图片真的加载成功（naturalWidth > 0，正对照）', fixed.dom && fixed.dom.localNaturalWidth > 0,
      'naturalWidth=' + (fixed.dom && fixed.dom.localNaturalWidth) + ' complete=' + (fixed.dom && fixed.dom.localComplete));
    A('★ 本地图片确实是被本服务端下发的（resource timing 里有 /local-pixel.png）',
      !!(fixed.dom && fixed.dom.resources.some(u => u.includes('/local-pixel.png'))), JSON.stringify(fixed.dom && fixed.dom.resources));
    A('★ 内联脚本没执行（sandbox 无 allow-scripts）', fixed.dom && fixed.dom.inlineRan === 'undefined', String(fixed.dom && fixed.dom.inlineRan));
    A('★ 内联脚本没改到 DOM（marker 仍是 no）', fixed.dom && fixed.dom.inlineMarker === 'no', String(fixed.dom && fixed.dom.inlineMarker));
    A('★ 外站计数器命中数 = 0（改前 A 臂 8 条）', hitsOf('F') === 0, '命中 ' + hitsOf('F') + ' 条：' + pathsOf('F').join(' 、'));
    A('CDP 也确认这些远程子资源被 CSP 拦掉（loadingFailed 有 csp）',
      fixed.failed.some(f => f.includes('csp')) || fixed.reqs.length === 0, JSON.stringify(fixed.failed).slice(0, 160));

    console.log('\n══ ④ 阴性自证：CSP 还原成旧值（只有 sandbox）⇒ 同一页面必须复现出站 ══');
    const old = await arm('http://127.0.0.1:' + MUT_PORT + '/probe-old.html');
    A('替身页面也真的打开了（标题 PROBE-B）', old.dom && old.dom.title === 'PROBE-B', JSON.stringify(old.dom && old.dom.title));
    A('替身：本地图片同样加载成功（说明差别只在 CSP，不在装置）', old.dom && old.dom.localNaturalWidth > 0, 'naturalWidth=' + (old.dom && old.dom.localNaturalWidth));
    A('★ 缺陷复现：旧值下外站命中数 > 0（记录条数）', hitsOf('B') > 0, '命中 ' + hitsOf('B') + ' 条：' + pathsOf('B').join(' 、'));
    A('★ 缺陷复现的形态与 ws1 A 臂一致（至少含 img/link/@import/script 四类）',
      ['remote-img.png', 'link-style.css', 'import.css', 'ext-script.js'].every(x => pathsOf('B').some(p => p.endsWith(x))),
      pathsOf('B').join(' '));
    A('★ 对照：同一页面在本尊下 0 条（唯一差别是 CSP）', hitsOf('F') === 0 && hitsOf('B') > 0,
      'F=' + hitsOf('F') + ' B=' + hitsOf('B'));
    console.log('  [证据] 旧值下到达计数器的 URL（逐条）：');
    for (const h of hits.filter(x => x.url.startsWith('/B/'))) console.log('    ' + h.url + '   Referer=' + (h.referer || '<无>'));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { }
    try { if (edge) edge.kill(); } catch (e) { }
    await sleep(500);
    const left = edgeLeftovers();
    console.log('\n══ ⑤ 收尾：端口释放 + 无残留 headless Edge ══');
    A('自己的 msedge（按 user-data-dir 核对）已全部退出', left === 0, '残余=' + left + '（已尽力 taskkill /T）');
    await srv.stop();
    await mut.stop();
    await new Promise(r => counterSrv.close(r));
    A('计数器/服务端端口已释放', true, '');
    fs.rmSync(OUT, { recursive: true, force: true });
    code = end('R1 库内文档 CSP（真浏览器 + 本机计数器）');
  }
  process.exit(code);
})().catch(e => {
  console.error('FATAL ' + (e && e.stack || e));
  try { edgeLeftovers(); } catch (x) { }
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (x) { }
  process.exit(1);
});
