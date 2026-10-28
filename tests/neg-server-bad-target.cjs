#!/usr/bin/env node
/**
 * H-08-A 断言（2026-10-29 R2）：**畸形 request-target 不得把服务端打挂**。
 *
 * 审计：`_服务端.mjs` 的 `const u = new URL(req.url, 'http://127.0.0.1');`（连同 Origin / OPTIONS
 *   两段）都在 `try` **之外**，而 handler 是 `async` ⇒ 抛出的 `ERR_INVALID_URL` 变成
 *   **unhandled rejection** ⇒ Node 默认**终止整个进程**。审计逐字实测：8 种 target（`//[`、`//%5B`、
 *   `//]`、`//[a`、`http://[`、`//[]`、`//\`、`//:80`）**每一个**都是 `sock="<<err ECONNRESET>>"
 *   serverAliveAfter=false exited=1`，之后 `/health` = ECONNREFUSED ⇒ 一个坏请求 = 整站下线。
 *
 * ⚠ 本用例的**唯一正确姿势是原始 socket**（`net.connect` + 手写请求行）：
 *   `fetch` / `http.request` 会在**客户端的 URL 解析阶段**就替你挡掉这种 target，
 *   你永远测不到服务端这一层 —— 这正是这个 bug 长期没被发现的原因。见 ① 装置自证。
 *
 * 断言分五层（缺一层就等于"我以为测到了"）：
 *   ① 装置自证：本用例发出的请求行**逐字**就是 `GET //[ HTTP/1.1`（证明没被客户端归一化）；
 *   ② 修复后：8 个畸形 target 逐个 → **400 + 进程存活**；全部发完 `/health` 仍是 200；
 *   ③ 对照：URL 解析器接受的形态（`//*`、`//"`）与 Node 解析器自己就拒的形态（`//a b`、`/%`）
 *      行为不变，且都不得打挂进程；
 *   ④ 源码形状：改前那句 handler 顶层 `const u = new URL(req.url, …)` 已不存在，
 *      `process.on('unhandledRejection')` 第二道网在场；
 *   ⑤ **阴性自证**：把修复掏掉（URL 解析挪回 try 之外 + 拆掉第二道网）之后，
 *      同一个 target **必须**让进程退出 —— 否则本用例没有牙齿；
 *   ⑥ 同批次另三条服务端加固（H-08-C/D/E）一并变成门禁：
 *      · 超长 body → **413**（且 limit 按**字节**计：80 万个汉字 = 2.4 MB 必须被拒，
 *        改前的 `b.length > 2e6` 只看 UTF-16 码元数，80 万 < 200 万 ⇒ 它**根本不触发**）；
 *      · 写路径（`POST /api/pending`、`POST /api/state` 及其 OPTIONS 预检）不回显 `ACAO: null`，
 *        而 `GET /api/state` 的 file:// 取数路径**保持**回显（不能把能用的读路径一起废掉）；
 *      · 降级必须显式：台账 stat 不到 / 生成器成功但状态包读不出，都要带 `degraded` 标记。
 *
 * 全程自建**临时库** + 独立端口（7194/7195/7201），与真库、与用户正在跑的 7187 实例零接触。
 * 退出码 0=全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, SERVER, req, sleep, counter } = require('./neg-server-lib.cjs');

const E = require('./_测试环境.cjs');
const { A, end } = counter();
const PORT = 7194;
const PORT_MUT = 7195;

/* 审计逐字给出的 8 个"把进程打挂"的 target（顺序照抄） */
const BAD_TARGETS = ['//[', '//%5B', '//]', '//[a', 'http://[', '//[]', '//\\', '//:80'];
/* 阳性对照：WHATWG URL 解析器**接受**它们（改前就 200）—— 本条只要求"别把进程打挂" */
const OK_TARGETS = ['//*', '//"'];
/* Node HTTP parser 自己就拒的形态（改前也是 400）：属解析器层，不是本漏洞 */
const PARSER_REJECT = ['//a b', '/%', '/a%2'];

const tmpLib = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-h08a-lib-'));

/* ---------- 原始 socket 请求（**故意不**用 fetch/http.request） ---------- */
function rawRequest(port, target, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let raw = '', err = null, settled = false;
    const fin = () => { if (settled) return; settled = true; try { s.destroy(); } catch (e) { } resolve({ raw, err }); };
    s.setTimeout(timeoutMs, () => { err = err || 'TIMEOUT'; fin(); });
    s.on('connect', () => s.write('GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
    s.on('data', d => { raw += d.toString('utf8'); });
    s.on('error', e => { err = String(e.code || e.message); fin(); });
    s.on('end', fin);
    s.on('close', () => { if (!settled) fin(); });
  });
}
const statusOf = raw => { const m = /^HTTP\/1\.[01] (\d{3})/.exec(String(raw || '')); return m ? Number(m[1]) : null; };
const oneLine = s => String(s || '').replace(/\s+/g, ' ').slice(0, 90);

/* ---------- 起一个"指定库、指定端口"的实例（neg-server-lib 的 startServer 写死了 E.LIB，
   而本用例要求与真库零接触，所以在用例内自建一个同形装置） ---------- */
function startAt(port, lib, serverPath, extraEnv) {
  const env = Object.assign({}, process.env, { CTB_DATA: lib }, extraEnv || {});
  if (port != null) env.CTB_PORT = String(port);   // port=null ⇒ 不设 CTB_PORT，逼服务端去读端口真源
  const proc = spawn(process.execPath, [serverPath], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const s = { proc, out: '', err: '', port, exited: undefined };
  proc.stdout.on('data', d => { s.out += d; });
  proc.stderr.on('data', d => { s.err += d; });
  proc.on('exit', c => { if (s.exited === undefined) s.exited = c; });
  s.alive = () => s.exited === undefined;
  s.stop = () => new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; setTimeout(res, 120); } };
    proc.once('exit', fin);
    try { proc.kill(); } catch (e) { }
    setTimeout(fin, 2000);
  });
  return s;
}
async function alive(port) {
  const r = await rawRequest(port, '/health', 1500).catch(() => ({ raw: '', err: 'x' }));
  return statusOf(r.raw) === 200;
}
async function waitAlive(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await alive(port)) return true; await sleep(250); }
  return false;
}
/** 等实例打印监听行，返回它**实际**监听的端口（不预设，直接读 stdout） */
async function waitListen(s, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(s.out);
    if (m) return Number(m[1]);
    if (!s.alive()) return null;
    await sleep(150);
  }
  return null;
}

(async () => {
  let srv = null, srvMut = null, srvGen = null;
  let code = 1;
  try {
    /* ══ ① 装置自证：rawRequest 发的就是**逐字那一串**；fetch/http.request 的真行为用实测说话 ══ */
    console.log('══ ① 装置自证：原始 socket 逐字发送（并实测 fetch / http.request 的真行为） ══');
    {
      let got = null;
      const echo = net.createServer(sock => {
        let buf = '';
        sock.on('data', d => { buf += d.toString('utf8'); if (buf.includes('\r\n\r\n')) { got = buf.split('\r\n')[0]; sock.destroy(); } });
      });
      await new Promise(res => echo.listen(0, '127.0.0.1', res));
      const echoPort = echo.address().port;
      const viaEcho = async (fn) => { got = null; try { await fn(); } catch (e) { } await sleep(150); return got; };

      const wire = await viaEcho(() => rawRequest(echoPort, '//['));
      A('原始 socket 发出的请求行逐字是 "GET //[ HTTP/1.1"', wire === 'GET //[ HTTP/1.1', JSON.stringify(wire));

      /* 为什么必须用原始 socket —— 下面三条都是**实测**，不是"我以为 fetch 会被拦"：
         · fetch 对 `http://[` **一个字节都发不出去**（WHATWG URL 先抛 ERR_INVALID_URL）；
         · fetch 对 `//\` 会把 target **悄悄改写成** `///`（用它等于在测另一个请求）；
         · `http.request({path})` 其实**能**逐字发；真正的问题是本仓 tests\neg-server-lib.cjs 的
           `req()` 会先 `encodeURI`，把 `//[` 改写成 `//%5B` —— 断言的字节串就不是审计那一串了。
         ⇒ 要断言"审计那 8 个 target 逐字复现"，只有原始 socket 这一条路。 */
      const fAbs = await viaEcho(() => fetch('http://127.0.0.1:' + echoPort + 'http://[', { signal: AbortSignal.timeout(800) }));
      A('实测：fetch 对 "http://[" 发不出任何请求行（客户端 URL 解析就抛）', fAbs === null, JSON.stringify(fAbs));
      const fSlash = await viaEcho(() => fetch('http://127.0.0.1:' + echoPort + '//\\', { signal: AbortSignal.timeout(800) }));
      A('实测：fetch 对 "//\\" 把 target 改写成 "GET /// HTTP/1.1"（故 fetch 覆盖不了这 8 个的全集）',
        fSlash === 'GET /// HTTP/1.1', JSON.stringify(fSlash));
      const hReq = await viaEcho(() => new Promise((res, rej) => {
        const q = http.request({ host: '127.0.0.1', port: echoPort, path: '//[', method: 'GET', headers: { Connection: 'close' } }, r => { r.resume(); r.on('end', res); });
        q.on('error', rej); q.end(); setTimeout(res, 800);
      }));
      A('实测：http.request({path}) 能逐字发出（"必须原始 socket"的理由是逐字保真 + 可表达性，不是它一定被拦）',
        hReq === 'GET //[ HTTP/1.1', JSON.stringify(hReq));
      const hEnc = await viaEcho(() => req(echoPort, '//[', { rawPath: false, timeoutMs: 1500 }));
      A('实测：本仓 req() 不带 rawPath 时把 "//[" 编码成 "//%5B"（仍会崩，但不是审计那一串字节）',
        /^GET \/\/%5B /.test(String(hEnc)), JSON.stringify(hEnc));

      await new Promise(res => echo.close(res));
    }

    /* ══ ② 修复后：8 个畸形 target 必须 400，且进程不死 ══ */
    console.log('\n══ ② 修复后端到端：8 个畸形 target 逐个原始 socket 发 ══');
    srv = startAt(PORT, tmpLib, SERVER);
    if (!await waitAlive(PORT)) {
      A('独立实例启动（临时库，127.0.0.1:' + PORT + '）', false, ('stderr=' + srv.err).slice(0, 300));
      console.log(end('H-08-A 畸形 request-target'));
      process.exit(1);
    }
    A('独立实例启动（临时库 ' + tmpLib + '，不与真库接触）', true);
    for (const t of BAD_TARGETS) {
      const r = await rawRequest(PORT, t);
      const st = statusOf(r.raw);
      A('GET ' + JSON.stringify(t) + ' → 400 且不是断连',
        st === 400, 'status=' + st + ' sockErr=' + (r.err || 'none') + ' body=' + oneLine(String(r.raw).split('\r\n\r\n')[1]));
      A('  └ 发完 ' + JSON.stringify(t) + ' 之后进程仍存活', srv.alive(), 'exited=' + srv.exited);
    }
    A('8 个都发完之后 /health 仍 200（整站没下线）', await alive(PORT),
      'exited=' + srv.exited + ' stderr=' + oneLine(srv.err.slice(0, 200)));
    A('400 体里带 "bad request target"（调用方看得到原因，不是裸 500）',
      /bad request target/.test(String((await rawRequest(PORT, '//[')).raw)), '');

    /* ══ ③ 对照：接受形态与解析器拒绝形态都不许打挂进程 ══ */
    console.log('\n══ ③ 对照：解析器接受 / 解析器拒绝的形态 ══');
    for (const t of OK_TARGETS) {
      const r = await rawRequest(PORT, t);
      A('GET ' + JSON.stringify(t) + ' → 不发 400（改前就是 200，属解析器接受的形态）',
        statusOf(r.raw) !== 400, 'status=' + statusOf(r.raw));
      A('  └ 进程仍存活', srv.alive(), 'exited=' + srv.exited);
    }
    for (const t of PARSER_REJECT) {
      const r = await rawRequest(PORT, t);
      A('GET ' + JSON.stringify(t) + ' → 400（Node 解析器层拒绝，非本漏洞）',
        statusOf(r.raw) === 400, 'status=' + statusOf(r.raw));
      A('  └ 进程仍存活', srv.alive(), 'exited=' + srv.exited);
    }

    /* ══ ④ 源码形状：改前那句在 try 之外的 URL 解析不得复活 ══ */
    console.log('\n══ ④ 源码形状（防"改回去"） ══');
    {
      const src = fs.readFileSync(SERVER, 'utf8');
      A('handler 顶层不再有 `const u = new URL(req.url, ...)`（改前形态）',
        !/^\s*const u = new URL\(req\.url/m.test(src));
      A('第二道网 process.on(\'unhandledRejection\') 在场', /process\.on\('unhandledRejection'/.test(src));
      A('URL 解析在 try 内（catch 回 400 bad request target）', /catch \(e\) \{\s*\n\s*return sendJson\(res, 400, \{ ok: false, error: 'bad request target'/.test(src));
    }

    /* ══ ⑤ 阴性自证：掏掉修复 → 同一个 target 必须把进程打挂 ══ */
    console.log('\n══ ⑤ 阴性自证：把修复掏掉后必须复现"进程 exit" ══');
    {
      const src = fs.readFileSync(SERVER, 'utf8');
      const origLines = src.split('\n').length;
      /* ⚠ 锚点必须**行首锚定**：本文件的修复说明注释里也写了 `process.on('unhandledRejection')` 这句话，
         用不锚定的正则会把**注释里那一句**当成真语句，再 `[\s\S]*?` 到第一个 `\n});\n`
         ⇒ 中间 280 多行被整段吃掉（第一版就是这么翻车的：变异实例报 `http is not defined`）。
         下面两条守卫（行数差 ≤ 3、变异源码 node --check）就是为这一类"锚点打偏"准备的。 */
      const mutA = src.replace(/^  const origin = req\.headers\.origin \|\| '';$/m,
        "  const origin = req.headers.origin || '';\n  const _vulnU = new URL(String(req.url == null ? '' : req.url), 'http://127.0.0.1');  // 变异：URL 解析挪回 try 之外");
      const mutB = mutA.replace(/^process\.on\('unhandledRejection', \(e\) => \{[\s\S]*?\n\}\);\n/m, '/* 变异：掏掉第二道网 */\n');
      A('变异锚点①命中（origin 行，行首锚定）', mutA !== src);
      A('变异锚点②命中（unhandledRejection 语句，行首锚定）', mutB !== mutA);
      const mutLines = mutB.split('\n').length;
      A('变异只增删了个位数行（行数差 ≤ 3）—— 防"锚点打偏、整段代码被吃"',
        Math.abs(mutLines - origLines) <= 3, origLines + ' 行 → ' + mutLines + ' 行');

      const mutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-h08a-mut-'));
      for (const f of ['_库根.mjs', '_安全写.mjs']) fs.copyFileSync(E.tool(f), path.join(mutDir, f));
      const mutServer = path.join(mutDir, '_服务端.mjs');
      fs.writeFileSync(mutServer, mutB);
      const chk = spawnSync(process.execPath, ['--check', mutServer], { encoding: 'utf8' });
      A('变异源码语法自检通过（node --check；--check 抓不到未定义变量，故另有行数守卫）',
        chk.status === 0, String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));
      /* 形态确认（同样行首锚定：注释里提到那句话不算"语句在场"） */
      A('变异源码确实是改前形态：try 之前就有 new URL，且第二道网**语句**已不在',
        /^\s*const _vulnU = new URL/m.test(mutB) && !/^process\.on\('unhandledRejection', \(e\) => \{/m.test(mutB));

      srvMut = startAt(PORT_MUT, tmpLib, mutServer);
      const up = await waitAlive(PORT_MUT);
      A('变异实例能正常起来（说明后面挂掉是 target 造成的，不是它自己的毛病）', up,
        'stderr=' + oneLine(srvMut.err.slice(0, 200)));
      if (up) {
        const r = await rawRequest(PORT_MUT, '//[');
        /* 崩溃是异步的：ECONNRESET 可能先到、也可能先看到连接被关 */
        for (let i = 0; i < 20 && srvMut.alive(); i++) await sleep(150);
        A('掏掉修复后：GET "//[" 让进程退出（改前实测 exit=1）',
          !srvMut.alive(), 'exited=' + srvMut.exited + ' sockErr=' + (r.err || 'none') + ' bytes=' + r.raw.length);
        A('掏掉修复后：/health 不再可达（整站下线 —— 这正是审计现象）', !await alive(PORT_MUT), '');
        A('掏掉修复后：stderr 里有 ERR_INVALID_URL / Invalid URL（崩溃栈可归因）',
          /ERR_INVALID_URL|Invalid URL/.test(srvMut.err), oneLine(srvMut.err.slice(0, 300)));
      }
      await srvMut.stop();
      try { fs.rmSync(mutDir, { recursive: true, force: true }); } catch (e) { }
      A('变异目录已清理', !fs.existsSync(mutDir));
    }

    /* ══ ⑥ 同批次另三条加固：413 / 写路径 CORS / 降级标记 ══ */
    console.log('\n══ ⑥ H-08-C/D/E：413、写路径不回显 ACAO null、降级标记 ══');
    {
      const JSONH = { 'Content-Type': 'application/json' };
      const big = '汉'.repeat(800000);                       // 800000 码元 / 2 400 000 字节
      A('前置：构造体的字节数 > 2 MiB 而**码元数** < 2e6（改前的 `b.length > 2e6` 对它不触发）',
        Buffer.byteLength(big, 'utf8') > 2 * 1024 * 1024 && big.length < 2e6,
        '码元=' + big.length + ' 字节=' + Buffer.byteLength(big, 'utf8'));
      const r413 = await req(PORT, '/api/pending', { method: 'POST', headers: JSONH, body: JSON.stringify({ resolves: [{ id: 'T1', action: '答', answer: big }] }), timeoutMs: 30000 });
      A('POST 超限体 → **413**（不是 ECONNRESET，也不是被当成"没超限"）', r413.status === 413,
        'status=' + r413.status + ' body=' + r413.text.slice(0, 120));
      A('413 体里给出上限与实际字节数（可归因）', /payload too large/.test(r413.text) && /limit/.test(r413.text), r413.text.slice(0, 140));
      A('服务端仍存活（413 之后没把自己弄死）', await alive(PORT));
      /* Content-Length 预检：声明 3 MB、实际只发一点点，也必须立刻 413（不必等 body 到齐） */
      const rPre = await new Promise((resolve) => {
        const net2 = require('net');
        const s = net2.connect(PORT, '127.0.0.1', () => s.write('POST /api/pending HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 3145728\r\nConnection: close\r\n\r\n{}'));
        let raw = '';
        s.on('data', d => { raw += d.toString('utf8'); });
        s.on('close', () => resolve({ raw }));
        s.on('error', () => resolve({ raw }));
        setTimeout(() => { try { s.destroy(); } catch (e) { } resolve({ raw }); }, 4000);
      });
      A('Content-Length 预检：声明 3 MB 而只发 `{}` → 立刻 413（没等 body 到齐、没断连）',
        statusOf(rPre.raw) === 413, 'status=' + statusOf(rPre.raw) + ' sockErr=' + (rPre.err || 'none'));

      /* 写路径不回显 ACAO: null；读路径保持回显（file:// 取数仍可用） */
      const wPost = await req(PORT, '/api/pending', { method: 'POST', headers: Object.assign({ Origin: 'null' }, JSONH), body: JSON.stringify({ resolves: [] }) });
      A('POST /api/pending + Origin: null → 不回显 Access-Control-Allow-Origin',
        wPost.headers['access-control-allow-origin'] === undefined, 'ACAO=' + String(wPost.headers['access-control-allow-origin']) + ' status=' + wPost.status);
      const wPre = await req(PORT, '/api/pending', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
      A('OPTIONS 预检 /api/pending + Origin: null → 204 但**也不回显** ACAO（预检不收口等于没挡）',
        wPre.status === 204 && wPre.headers['access-control-allow-origin'] === undefined,
        'status=' + wPre.status + ' ACAO=' + String(wPre.headers['access-control-allow-origin']));
      const wState = await req(PORT, '/api/state', { method: 'POST', headers: { Origin: 'null' } });
      A('POST /api/state + Origin: null → 不回显 ACAO',
        wState.headers['access-control-allow-origin'] === undefined, 'ACAO=' + String(wState.headers['access-control-allow-origin']) + ' status=' + wState.status);
      const rGet = await req(PORT, '/api/state', { headers: { Origin: 'null' } });
      A('GET /api/state + Origin: null → **仍然**回显 ACAO: null（file:// 取数路径不能被一起废掉）',
        rGet.headers['access-control-allow-origin'] === 'null', 'status=' + rGet.status + ' ACAO=' + String(rGet.headers['access-control-allow-origin']));
      const okOrigin = 'http://127.0.0.1:' + PORT;
      const wOk = await req(PORT, '/api/pending', { method: 'POST', headers: Object.assign({ Origin: okOrigin }, JSONH), body: JSON.stringify({ resolves: [] }) });
      A('POST + 白名单来源 → 照旧原样回显该来源（正常客户端不受影响）',
        wOk.headers['access-control-allow-origin'] === okOrigin, 'ACAO=' + String(wOk.headers['access-control-allow-origin']));

      /* 降级①：台账 stat 不到 → 200 但必须带 degraded/pendingStale（本实例的临时库就没有 _待确认.json） */
      const st = await req(PORT, '/api/state');
      A('台账读不到时 GET /api/state → 200 + degraded:"pending-ledger-unreadable" + pendingStale:true（不再静默返回旧 pending）',
        st.status === 200 && st.json && st.json.degraded === 'pending-ledger-unreadable' && st.json.pendingStale === true,
        'status=' + st.status + ' degraded=' + (st.json && st.json.degraded) + ' pendingStale=' + (st.json && st.json.pendingStale));

      /* 降级②：生成器成功但状态包读不出 → ok:false + degraded:"state-unreadable"（改前是 ok:true + 旧快照） */
      const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-h08a-gen-'));
      const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-h08a-genlib-'));
      for (const f of ['_库根.mjs', '_安全写.mjs']) fs.copyFileSync(E.tool(f), path.join(appDir, f));
      fs.copyFileSync(SERVER, path.join(appDir, '_服务端.mjs'));
      /* 假生成器：**成功退出**，但写一个读不出来的状态包（半截 JSON） */
      fs.writeFileSync(path.join(appDir, '生成状态.mjs'),
        "import fs from 'fs';\nimport path from 'path';\nfs.writeFileSync(path.join(process.env.CTB_DATA, '_状态.json'), '{{{ 半截 JSON');\nconsole.log('fake-gen ok');\n");
      srvGen = startAt(7201, libDir, path.join(appDir, '_服务端.mjs'));
      const genUp = await waitAlive(7201);
      A('降级用例实例启动（带"假生成器"的独立程序目录）', genUp, 'stderr=' + oneLine(srvGen.err.slice(0, 200)));
      if (genUp) {
        const rb = await req(7201, '/api/state', { method: 'POST', timeoutMs: 60000 });
        A('生成器 exit=0 但状态包读不出 → **500 + ok:false + degraded:"state-unreadable"**（改前：200 + ok:true + 旧快照）',
          rb.status === 500 && rb.json && rb.json.ok === false && rb.json.degraded === 'state-unreadable',
          'status=' + rb.status + ' ok=' + (rb.json && rb.json.ok) + ' degraded=' + (rb.json && rb.json.degraded) + ' err=' + String(rb.json && rb.json.error).slice(0, 80));
        A('降级响应里点明"生成器已重跑成功、是服务端读不出来"（可归因，不是笼统失败）',
          /生成器已重跑成功/.test(String((rb.json || {}).error)), String((rb.json || {}).error).slice(0, 90));
      }
      await srvGen.stop();
      try { fs.rmSync(appDir, { recursive: true, force: true }); fs.rmSync(libDir, { recursive: true, force: true }); } catch (e) { }
      A('降级用例的临时目录已清理', !fs.existsSync(appDir) && !fs.existsSync(libDir));
    }

    /* ══ ⑦ SC-09 端口真源：程序根 `端口.json`（与 C# 壳 ResolveSrvPort 同源），不猜默认值 ══ */
    console.log('\n══ ⑦ SC-09 端口真源（端口.json；读不到就 exit 2，绝不回退 7187） ══');
    {
      /* 造一棵"开发区同形"的树：<T>\app\index.html（= WEB_ROOT）+ <T>\tools\*.mjs（= TOOL_DIR）。
         为什么用临时树而不是改真 src\app\端口.json：真值文件不属于本用例的作用域，
         而且"改一次真文件再改回来"会给并发跑门禁的其它会话制造假失败。 */
      const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-h08a-port-'));
      fs.mkdirSync(path.join(T, 'app'), { recursive: true });
      fs.mkdirSync(path.join(T, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(T, 'app', 'index.html'), '<!doctype html><title>t</title>');
      for (const f of ['_服务端.mjs', '_库根.mjs', '_安全写.mjs']) fs.copyFileSync(E.tool(f), path.join(T, 'tools', f));
      const srvT = path.join(T, 'tools', '_服务端.mjs');
      const pf = path.join(T, 'app', '端口.json');

      const srcSrv = fs.readFileSync(SERVER, 'utf8');
      A('源码形状：不再写死 `Number(process.env.CTB_PORT) || 7187` 这种兜底',
        !/process\.env\.CTB_PORT\)\s*\|\|\s*7187/.test(srcSrv));
      A('真开发区树里 WEB_ROOT 就是 端口.json 所在目录（= C# 壳的 AppRoot，不是 _库根 的 APP_ROOT）',
        fs.existsSync(path.join(E.REPO, 'src', 'app', '端口.json')), path.join(E.REPO, 'src', 'app', '端口.json'));

      fs.writeFileSync(pf, JSON.stringify({ why: 'neg 用例', default: 7302 }));
      let s7 = startAt(null, tmpLib, srvT);
      A('端口.json default=7302 → 实际监听 7302（没设 CTB_PORT）', (await waitListen(s7)) === 7302, 'out=' + oneLine(s7.out));
      await s7.stop();

      fs.writeFileSync(pf, JSON.stringify({ why: 'neg 用例', default: 7303 }));
      s7 = startAt(null, tmpLib, srvT);
      A('把 default 改成 7303 → 实际监听 7303（端口真源真的被读，不是常量）', (await waitListen(s7)) === 7303, 'out=' + oneLine(s7.out));
      await s7.stop();

      fs.rmSync(pf);
      s7 = startAt(null, tmpLib, srvT);
      await sleep(1500);
      A('端口.json 缺失 → 进程 **exit 2**（审计要求的"不静默回退 7187"）', s7.exited === 2, 'exited=' + s7.exited + ' stdout=' + oneLine(s7.out));
      A('报错点明"端口真源读不到 + 拒绝启动 + 试过哪些路径"（可归因）',
        /端口真源读不到/.test(s7.err) && /拒绝启动/.test(s7.err), oneLine(s7.err.slice(0, 200)));
      A('stdout 里没有出现 7187 的监听行（没把默认值当兜底）', !/127\.0\.0\.1:7187/.test(s7.out), oneLine(s7.out));
      await s7.stop();

      fs.writeFileSync(pf, JSON.stringify({ default: 99999 }));
      s7 = startAt(null, tmpLib, srvT);
      await sleep(1200);
      A('default 超范围（99999）→ exit 2（不拿非法端口去 listen）', s7.exited === 2, 'exited=' + s7.exited);
      await s7.stop();

      s7 = startAt(null, tmpLib, srvT, { CTB_PORT: 'abc' });
      await sleep(1200);
      A('CTB_PORT 非法（abc）→ exit 2', s7.exited === 2, 'exited=' + s7.exited + ' err=' + oneLine(s7.err.slice(0, 120)));
      await s7.stop();

      fs.writeFileSync(pf, JSON.stringify({ default: 7302 }));
      s7 = startAt(null, tmpLib, srvT, { CTB_PORT: '7311' });
      A('CTB_PORT 合法 → 优先于 端口.json（回归用例的独立端口机制没被这次收敛破坏）',
        (await waitListen(s7)) === 7311, 'out=' + oneLine(s7.out));
      await s7.stop();

      try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { }
      A('⑦ 的临时树已清理', !fs.existsSync(T));
    }

    code = end('H-08-A/C/D/E + SC-09 服务端入口加固');
  } finally {
    if (srvGen) await srvGen.stop();
    if (srvMut) await srvMut.stop();
    if (srv) await srv.stop();
    try { fs.rmSync(tmpLib, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(code);
})();
