#!/usr/bin/env node
/**
 * S02 + S05 + S06 + B01 断言（2026-10-30 外部安全审计四条，服务端侧）。
 *
 * 四条缺陷的**改前实测**（都在 work\glimmer-audit-fix\_probe\repro-all.cjs 里用独立端口 + 临时库复现过）：
 *   【S02】`Origin: null` 被当可信来源 ⇒ `GET /api/state` 200 + `ACAO: null`、`GET /<库内文件>` 200
 *          读走原文、`POST /api/pending` 400（**已穿过来源门禁**，只被载荷校验拦）。`null` 是
 *          **所有不透明源**的共同字符串（攻击者页面的 `<iframe sandbox>` 发的就是它），与 file:// 不可区分。
 *   【S05】不校验 Host ⇒ `Host: attacker.example:PORT` 且不带 Origin 的请求一路 200。这是 DNS rebinding
 *          的服务端必要条件：攻击者域名解析到 127.0.0.1 后，浏览器发的就是"同源"请求，Origin 门禁失效。
 *   【S06】`POST /api/state` 既不校验 Content-Type 也不看来源 ⇒ 任何本机网页都能反复触发整库重建
 *          （生成器分钟级、重写 1.35 MB 状态包）。
 *   【B01】`GET /api/state` 里刷新 `_状态.json` 的异常被**空 catch** 吞掉 ⇒ 磁盘 JSON 写坏后仍 200
 *          返回**旧内存快照**，响应里没有任何标记（改前实测 generatedAt 与改坏前一模一样）。
 *
 * 本次修复的两半（缺一半都等于没修）：
 *   服务端 `src\tools\_服务端.mjs`：Host 白名单 → Origin 白名单（不含 null）→ 浏览器 /api/* 验 token
 *     → 写路径只收 JSON + 同源限流 → 状态包读失败显式降级。
 *   前端  `src\app\js\host.js`：token 从注入的 index.html 读、`apiFetch` 唯一出口集中带 `X-CTB-Token`、
 *     没有 token 就不进 server 模式（file:// 直开落到 offline，而不是"health 通、/api 全 403"的半死态）。
 *
 * 本用例的自证约定（缺一层就等于"我以为测到了"）：
 *   ① 装置自证：token **确实**只从注入的 index.html 拿得到（注入点、no-store、静态文件不注入）；
 *   ② 正面：伪造 Host / null 源 / 无 token / 非 JSON 全部被挡，**合法对照**照旧 200（不过度拦截）；
 *   ③ 阴性自证：把 Host 校验、token 门禁分别掏掉之后，同一个请求**必须**恢复成 200（证明断言有牙齿）；
 *   ④ 源码形状：这几道门禁的**语句**必须在场（去注释再判，注释里抄旧写法不算数）。
 * 全程自建临时程序目录 + 临时库 + **动态空闲端口**，与真库、与用户正在跑的 7187 实例零接触。
 * 退出码 0=全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { req, sleep, counter, stripComments } = require('./neg-server-lib.cjs');

const E = require('./_测试环境.cjs');
const { A, end } = counter();

/* ---------- 临时骨架：程序目录（app + tools 两段，与开发区同形） + 临时库 ---------- */
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-s05-'));
const PROG = path.join(T, 'prog');
const APPDIR = path.join(PROG, 'app');
const TOOLDIR = path.join(PROG, 'tools');
const LIB = path.join(T, 'lib');
fs.mkdirSync(APPDIR, { recursive: true });
fs.mkdirSync(TOOLDIR, { recursive: true });
fs.mkdirSync(LIB, { recursive: true });

/* 界面根 = 程序根那份 index.html（**必须**有 `</head>`：注入点的断言要靠它）。
   另外放一个静态 js，用来证"token 只注入根 index.html，不撒给其它静态文件"。 */
fs.writeFileSync(path.join(APPDIR, 'index.html'),
  '<!doctype html>\n<html lang="zh-CN"><head>\n<meta charset="utf-8">\n<title>探针页</title>\n</head>\n' +
  '<body><script src="js/host.js"></script></body></html>\n', 'utf8');
fs.mkdirSync(path.join(APPDIR, 'js'), { recursive: true });
fs.writeFileSync(path.join(APPDIR, 'js', 'host.js'), '/* 探针：内容里绝不能出现 token */\n', 'utf8');

for (const f of ['_服务端.mjs', '_库根.mjs', '_安全写.mjs']) fs.copyFileSync(E.tool(f), path.join(TOOLDIR, f));
const SERVER = path.join(TOOLDIR, '_服务端.mjs');
/* 假生成器：真生成器跑一次是分钟级、且会去读真题库。本用例要验的是"写路径的门禁与限流"，
   不是生成器本身，所以用一个"秒回、只写一份合法状态包"的替身（与 neg-server-bad-target.cjs ⑥ 同套路）。 */
fs.writeFileSync(path.join(TOOLDIR, '生成状态.mjs'), [
  "import fs from 'fs';",
  "import path from 'path';",
  "const lib = process.env.CTB_DATA;",
  "const pend = path.join(lib, '_待确认.json');",
  "const st = fs.statSync(pend);",
  "fs.writeFileSync(path.join(lib, '_状态.json'), JSON.stringify({",
  "  generatedAt: new Date().toISOString(), data: [{ name: '探针学生', subjects: [] }],",
  "  pending: { items: [], open: 0 }, dataHealth: {},",
  "  _pendingSrc: { mtimeMs: st.mtimeMs, size: st.size, hash: 'probe' },",
  "}));",
  "console.log('fake-gen ok');",
].join('\n'), 'utf8');

const SECRET_TEXT = 'PROBE-SECRET-题库文件\n';
const STATE_FILE = path.join(LIB, '_状态.json');
const PENDING_FILE = path.join(LIB, '_待确认.json');

/* 状态包必须带与 `_待确认.json` 一致的 `_pendingSrc` 指纹，否则 GET /api/state 会判"台账过期"
   而去 spawn `_状态刷新.mjs`（临时程序目录里没有它）→ 500。这是装置细节，与缺陷无关。 */
function writeLib(genTag) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify({ items: [] }), 'utf8');
  const st = fs.statSync(PENDING_FILE);
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    generatedAt: genTag || new Date().toISOString(),
    data: [{ name: '探针学生', subjects: [] }],
    pending: { items: [], open: 0 }, dataHealth: {},
    _pendingSrc: { mtimeMs: st.mtimeMs, size: st.size, hash: 'probe' },
  }), 'utf8');
  fs.writeFileSync(path.join(LIB, '机密.txt'), SECRET_TEXT, 'utf8');
}
writeLib('2026-01-01T00:00:00.000Z');

/* ---------- 装置：动态空闲端口（不抢 719x，也不抢用户 7187） ---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startAt(port, serverPath) {
  const proc = spawn(process.execPath, [serverPath], {
    cwd: PROG, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: LIB }),
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
async function waitHealth(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await req(port, '/health', { timeoutMs: 1500 }); if (r.status === 200) return true; } catch (e) { }
    await sleep(200);
  }
  return false;
}
/** 原始 socket：HTTP/1.0 且**完全不带 Host**（这样才测得到"Host 缺失"这一支） */
function rawNoHost(port, target) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let raw = '';
    const fin = () => { try { s.destroy(); } catch (e) { } resolve(raw); };
    s.setTimeout(4000, fin);
    s.on('connect', () => s.write('GET ' + target + ' HTTP/1.0\r\n\r\n'));
    s.on('data', d => { raw += d.toString('utf8'); });
    s.on('error', fin); s.on('end', fin); s.on('close', fin);
  });
}
const statusOf = raw => { const m = /^HTTP\/1\.[01] (\d{3})/.exec(String(raw || '')); return m ? Number(m[1]) : null; };
const oneLine = s => String(s || '').replace(/\s+/g, ' ').slice(0, 120);
/* 服务端日志行里带 `✖`（拒绝标记），直接嵌进断言详情会在屏幕上冒充一条失败断言
   （counter 的计数是对的，但**看**日志的人会误读）。所以往详情里贴日志时统一换掉这个字符。 */
const oneLog = s => oneLine(s).split('\u2716').join('[x]');
const JSONH = { 'Content-Type': 'application/json' };
const BROWSER = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
const tokOf = html => { const m = /window\.__ctbToken\s*=\s*"([0-9a-f]{16,128})"/.exec(String(html || '')); return m ? m[1] : ''; };

(async () => {
  const PORT = await freePort();
  let PORT2 = await freePort();
  if (PORT2 === PORT) PORT2 = await freePort();
  const OTHER = PORT === 65535 ? PORT - 1 : PORT + 1;      // 只用于"Host 端口不对"
  let srv = null, srv2 = null, srvMut = null;
  let code = 1;
  const stopAll = async () => { for (const s of [srvMut, srv2, srv]) if (s) { try { await s.stop(); } catch (e) { } } };

  try {
    /* ══ ① 装置自证 + token 的签发路径 ══ */
    console.log('══ ① 装置自证：token 只从服务端注入的根 index.html 拿得到 ══');
    srv = startAt(PORT, SERVER);
    if (!await waitHealth(PORT)) {
      A('独立实例启动（临时程序目录 + 临时库，127.0.0.1:' + PORT + '）', false,
        'health 超时；stderr=' + oneLog(srv.err.slice(0, 300)));
      console.log(end('S02/S05/S06/B01 服务端加固'));
      process.exit(1);
    }
    A('独立实例启动（临时程序目录 + 临时库，127.0.0.1:' + PORT + '）', true);

    const home = await req(PORT, '/index.html');
    const TOKEN = tokOf(home.text);
    A('GET /index.html → 200 且响应里带 window.__ctbToken（服务端注入）',
      home.status === 200 && !!TOKEN, 'status=' + home.status + ' token长度=' + TOKEN.length);
    A('token 长度足够（≥32 位十六进制，24 字节随机）', /^[0-9a-f]{32,}$/.test(TOKEN), TOKEN.slice(0, 8) + '…');
    A('启动日志只报 token 前 6 位、**不含全文**（日志会被启动器/计划任务收集）',
      /token 前 6 位/.test(srv.out) && srv.out.indexOf(TOKEN) < 0,
      oneLog(Array.from(srv.out.split('\n')).filter(l => /门禁/.test(l)).join(' ')));
    const idxScript = home.text.indexOf('window.__ctbToken');
    const idxHeadEnd = home.text.search(/<\/head\s*>/i);
    A('注入点在 </head> 之前（早于任何 <script src> 执行，host.js 读得到）',
      idxScript >= 0 && idxHeadEnd >= 0 && idxScript < idxHeadEnd, 'token@' + idxScript + ' </head>@' + idxHeadEnd);
    A('该响应带 Cache-Control: no-store（token 每轮启动都变，缓存住就会拿旧 token 全 403）',
      /no-store/i.test(String(home.headers['cache-control'] || '')), String(home.headers['cache-control']));
    A('GET /（根路径）同样拿到注入后的首页', tokOf((await req(PORT, '/')).text) === TOKEN);
    const staticJs = await req(PORT, '/js/host.js');
    A('静态 js 里**没有** token（注入只对根 index.html，不撒给被静态服务的文件）',
      staticJs.status === 200 && !/__ctbToken/.test(staticJs.text) && staticJs.text.indexOf(TOKEN) < 0,
      'status=' + staticJs.status);
    /* 两次启动 token 必须不同（"每轮启动随机"是它的价值所在：跨会话重放无效） */
    srv2 = startAt(PORT2, SERVER);
    const up2 = await waitHealth(PORT2);
    const TOKEN2 = up2 ? tokOf((await req(PORT2, '/index.html')).text) : '';
    A('第二个实例起来（127.0.0.1:' + PORT2 + '）', up2, 'stderr=' + oneLog(srv2.err.slice(0, 200)));
    A('两次启动的 token **不同**（不是写死的常量，跨进程重放无效）',
      !!TOKEN2 && TOKEN2 !== TOKEN, '第一次 ' + TOKEN.slice(0, 8) + '… 第二次 ' + (TOKEN2 || '(无)').slice(0, 8) + '…');
    await srv2.stop(); srv2 = null;

    const LIBFILE = '/机密.txt';
    const ALLOWED = 'http://127.0.0.1:' + PORT;

    /* ══ ② S05：Host/authority 必须校验 ══ */
    console.log('\n══ ② S05：伪造 Host（DNS rebinding 的必要条件）→ 403 ══');
    {
      const r1 = await req(PORT, '/api/state', { headers: { Host: 'attacker.example:' + PORT } });
      A('GET /api/state + Host: attacker.example:' + PORT + ' → **403**（改前 200）',
        r1.status === 403, 'status=' + r1.status);
      A('403 体里点明是 Host 不合法（可归因，不是笼统 forbidden）',
        /forbidden host/i.test(r1.text) && /attacker\.example/.test(r1.text), r1.text.slice(0, 140));
      const r2 = await req(PORT, LIBFILE, { headers: { Host: 'evil.test' } });
      A('GET ' + LIBFILE + '（库内文件）+ Host: evil.test → **403**，且响应里没有文件内容（机密性）',
        r2.status === 403 && r2.text.indexOf('PROBE-SECRET') < 0,
        'status=' + r2.status + ' body=' + oneLine(r2.text));
      const r3 = await req(PORT, '/api/state', { method: 'POST', headers: Object.assign({ Host: 'evil.test' }, JSONH), body: '{}' });
      A('POST /api/state + Host: evil.test → **403**（写路径同样过 Host 门禁）', r3.status === 403, 'status=' + r3.status);
      const r4 = await req(PORT, '/api/state', { headers: { Host: '127.0.0.1:' + OTHER } });
      A('Host 写**别的端口**（127.0.0.1:' + OTHER + '）→ 403（不是"主机名对就放行"）', r4.status === 403, 'status=' + r4.status);
      const r5 = await req(PORT, '/api/state', { headers: { Host: '127.0.0.1.evil.com:' + PORT } });
      A('前缀伪装（127.0.0.1.evil.com）→ 403（不做 startsWith 式模糊匹配）', r5.status === 403, 'status=' + r5.status);
      const raw = await rawNoHost(PORT, '/api/state');
      A('HTTP/1.0 且**完全不带 Host** → 403（缺 Host 不是"没来源"，是"来源不明"）',
        statusOf(raw) === 403, 'status=' + statusOf(raw));
      const ok1 = await req(PORT, '/api/state', { headers: { Host: '127.0.0.1:' + PORT } });
      A('对照：Host 127.0.0.1:' + PORT + ' → 200（不过度拦截）', ok1.status === 200, 'status=' + ok1.status);
      const ok2 = await req(PORT, '/api/state', { headers: { Host: 'localhost:' + PORT } });
      A('对照：Host localhost:' + PORT + ' → 200（本机另一种合法写法）', ok2.status === 200, 'status=' + ok2.status);
      const ok3 = await req(PORT, '/health', { headers: { Host: '127.0.0.1' } });
      A('对照：Host 省略端口（HTTP/1.1 允许）→ 200', ok3.status === 200, 'status=' + ok3.status);
      A('拒绝日志里记下了伪造 Host（在 stderr，可事后取证）',
        /拒绝请求/.test(srv.err) && /attacker\.example|evil\.test/.test(srv.err), oneLog(srv.err.split('\n')[0]));
    }

    /* ══ ③ S02：Origin: null 读与写都 403 ══ */
    console.log('\n══ ③ S02：Origin: null（不透明源）→ 403，读与写都断言 ══');
    {
      const g = await req(PORT, '/api/state', { headers: { Origin: 'null' } });
      A('GET /api/state + Origin: null → **403**（改前 200 + ACAO: null）', g.status === 403, 'status=' + g.status);
      A('   └ 且不回显任何 Access-Control-Allow-Origin', g.headers['access-control-allow-origin'] === undefined,
        String(g.headers['access-control-allow-origin']));
      const f = await req(PORT, LIBFILE, { headers: { Origin: 'null' } });
      A('GET 库内文件 + Origin: null → **403**，读不到内容（<iframe sandbox> 也拿不到）',
        f.status === 403 && f.text.indexOf('PROBE-SECRET') < 0, 'status=' + f.status);
      const p = await req(PORT, '/api/pending', { method: 'POST', headers: Object.assign({ Origin: 'null' }, JSONH), body: JSON.stringify({ resolves: [] }) });
      A('POST /api/pending + Origin: null + json → **403**（改前 400 = 已穿过来源门禁）', p.status === 403, 'status=' + p.status);
      const s = await req(PORT, '/api/state', { method: 'POST', headers: Object.assign({ Origin: 'null' }, JSONH), body: '{}' });
      A('POST /api/state + Origin: null + json → **403**（改前直接进 doRebuild 触发整库重建）', s.status === 403, 'status=' + s.status);
      const o = await req(PORT, '/api/pending', {
        method: 'OPTIONS',
        headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      });
      A('OPTIONS 预检 + Origin: null → **403**（预检放行等于给跨源写开绿灯）', o.status === 403, 'status=' + o.status);
      /* 合法对照：server 模式真实客户端的来源（服务端自己发的同源页面） */
      const al = await req(PORT, '/api/state', { headers: { Origin: ALLOWED } });
      A('对照：白名单同源来源（' + ALLOWED + '）→ 200 且被原样回显 ACAO',
        al.status === 200 && al.headers['access-control-allow-origin'] === ALLOWED,
        'status=' + al.status + ' ACAO=' + String(al.headers['access-control-allow-origin']));
      const pre = await req(PORT, '/api/pending', {
        method: 'OPTIONS',
        headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-ctb-token' },
      });
      A('对照：白名单来源的预检 → 204 且允许头里含 X-CTB-Token（否则跨源客户端带不上 token）',
        pre.status === 204 && /x-ctb-token/i.test(String(pre.headers['access-control-allow-headers'] || '')),
        'status=' + pre.status + ' allow-headers=' + String(pre.headers['access-control-allow-headers']));
    }

    /* ══ ④ token 门禁：浏览器发的 /api/* 必须带 X-CTB-Token ══ */
    console.log('\n══ ④ token：浏览器（带 Sec-Fetch-*）访问 /api/* 必须带 X-CTB-Token ══');
    {
      const n1 = await req(PORT, '/api/state', { headers: Object.assign({}, BROWSER) });
      A('GET /api/state + Sec-Fetch-Site 但**无** token → 403（改前 200：本机网页拿不到 Origin 也能读）',
        n1.status === 403, 'status=' + n1.status + ' body=' + oneLine(n1.text));
      const n2 = await req(PORT, '/api/pending', { method: 'POST', headers: Object.assign({}, BROWSER, JSONH), body: JSON.stringify({ resolves: [] }) });
      A('POST /api/pending + Sec-Fetch-Site 但无 token → 403（写路径同口径）', n2.status === 403, 'status=' + n2.status);
      const bad = await req(PORT, '/api/state', { headers: Object.assign({ 'X-CTB-Token': 'deadbeef'.repeat(6) }, BROWSER) });
      A('带**错误** token → 403（不是"有头就放行"）', bad.status === 403, 'status=' + bad.status);
      const shortTok = await req(PORT, '/api/state', { headers: Object.assign({ 'X-CTB-Token': TOKEN.slice(0, 8) }, BROWSER) });
      A('带**截断**的 token → 403（定长比较，不做前缀匹配）', shortTok.status === 403, 'status=' + shortTok.status);
      const ok = await req(PORT, '/api/state', { headers: Object.assign({ 'X-CTB-Token': TOKEN }, BROWSER) });
      A('带**正确** token → 200（且拿到的是完整状态包）', ok.status === 200 && !!(ok.json && ok.json.data), 'status=' + ok.status);
      const okWs = await req(PORT, '/api/pending', { method: 'POST', headers: Object.assign({ 'X-CTB-Token': '  ' + TOKEN + '  ' }, BROWSER, JSONH), body: JSON.stringify({ resolves: [] }) });
      A('token 前后带空白也认（trim 后比较）；写路径同样穿过 token 门禁 → 400 载荷校验',
        okWs.status === 400 && /resolves empty/.test(okWs.text), 'status=' + okWs.status + ' body=' + oneLine(okWs.text));
      /* 非浏览器客户端（不带 Sec-Fetch-*）：**不强制** token —— 这是"别把既有回归装置全打红"的边界，
         也是 curl / 计划任务这类本机脚本的真实形态。它们不是"本机网页伪造"那条通道。 */
      const cli = await req(PORT, '/api/state');
      A('非浏览器客户端（无 Sec-Fetch-*）无 token → 200（curl / 本仓 neg-server-* 装置不受影响）',
        cli.status === 200, 'status=' + cli.status);
      A('静态资源不需要 token（图片/题干/css 照旧）',
        (await req(PORT, LIBFILE)).status === 200 && (await req(PORT, '/js/host.js')).status === 200);
      A('/health 不需要 token（存活探针：部署脚本与测试环境都直连它）',
        (await req(PORT, '/health', { headers: Object.assign({}, BROWSER) })).status === 200);
      A('拒绝日志里记下了 token 被拒的请求（可事后取证）',
        /未带有效 X-CTB-Token/.test(srv.err), oneLog(srv.err.split('\n').filter(l => /X-CTB-Token/.test(l)).join(' ')));
    }

    /* ══ ⑤ S06：POST /api/state 的写门禁 + 限流 ══ */
    console.log('\n══ ⑤ S06：POST /api/state 只收 JSON + 同源限流（429）══');
    {
      const t1 = await req(PORT, '/api/state', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
      A('POST /api/state + text/plain → **415**（改前 200 并真的重跑生成器）', t1.status === 415, 'status=' + t1.status);
      const t2 = await req(PORT, '/api/state', { method: 'POST' });
      A('POST /api/state 不带 Content-Type → 415', t2.status === 415, 'status=' + t2.status);
      const t3 = await req(PORT, '/api/state', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: 'x' });
      A('POST /api/state + multipart（表单式跨源简单请求的形态）→ 415', t3.status === 415, 'status=' + t3.status);
      /* 限流两条**并发**发出，而不是"顺序发两次再赌 1 秒窗口"：
         顺序写法在慢机器上会偶发假红 —— 第一次要真的跑完生成器，耗时若超过 1 秒，第二次就合法了。
         并发写法是确定性的：handler 在第一个 await 之前就同步记下 `rebuildAt`，第二个请求必然落在窗口内
         （也可能撞上 rebuildBusy），两条都是 429。要证的语义正是"同一来源 1 秒内第二次重建会被拒"。 */
      const [a, b] = await Promise.all([
        req(PORT, '/api/state', { method: 'POST', headers: JSONH, body: '{}' }),
        req(PORT, '/api/state', { method: 'POST', headers: JSONH, body: '{}' }),
      ]);
      const sts = [a.status, b.status].slice().sort();
      A('POST /api/state + application/json → 恰好一次 200（合法客户端不被误伤；假生成器秒回）',
        sts[0] === 200 && sts[1] === 429, '两次 status=' + sts.join(' / '));
      A('同一来源 1 秒内**第二次** POST /api/state → **429**（改前两次都是 200，能把生成器连点成灾）',
        sts[1] === 429, '两次 status=' + sts.join(' / '));
      const rej = a.status === 429 ? a : b;
      A('429 体里给出 retryAfterMs（客户端知道该等多久）',
        !!(rej.json && typeof rej.json.retryAfterMs === 'number' && rej.json.retryAfterMs > 0), JSON.stringify(rej.json || {}).slice(0, 120));
      await sleep(1200);   // 让限流窗口过去：下一条要验的是"合法浏览器请求能过"，不是限流
      const browse = await req(PORT, '/api/state', { method: 'POST', headers: Object.assign({ 'X-CTB-Token': TOKEN }, BROWSER, JSONH), body: '{}' });
      A('限流窗口过去后，浏览器（带正确 token + Sec-Fetch-*）的 POST → 200（合法客户端不被误伤）',
        browse.status === 200, 'status=' + browse.status + ' body=' + oneLine(browse.text));
    }

    /* ══ ⑥ B01：磁盘状态包读不出来时必须显式降级 ══ */
    console.log('\n══ ⑥ B01：_状态.json 读不出来时 GET 必须带 degraded（不再静默返回旧快照）══');
    {
      const g0 = await req(PORT, '/api/state');
      const gen0 = g0.json && g0.json.generatedAt;
      A('基线：状态包正常 → 200 且**没有** degraded 标记',
        g0.status === 200 && !g0.json.degraded, 'degraded=' + (g0.json && g0.json.degraded));

      /* 写坏磁盘状态包（半截 JSON），并把 mtime 推到"比内存快照新" ⇒ 服务端一定会尝试重读 */
      fs.writeFileSync(STATE_FILE, '{{{ 半截 JSON 坏掉了', 'utf8');
      const now = new Date();
      fs.utimesSync(STATE_FILE, now, new Date(now.getTime() + 5000));
      const g1 = await req(PORT, '/api/state');
      A('磁盘 _状态.json 写坏后 GET → 200 但**必须**带 degraded:"state-unreadable"（改前：200 + 无任何标记）',
        g1.status === 200 && g1.json && g1.json.degraded === 'state-unreadable',
        'status=' + g1.status + ' degraded=' + (g1.json && g1.json.degraded));
      A('   └ 同时带 stateStale:true（"你看到的这份是旧的"）',
        !!(g1.json && g1.json.stateStale === true), 'stateStale=' + (g1.json && g1.json.stateStale));
      A('   └ degradedDetail 含真实原因（"不是合法 JSON"），不是笼统失败',
        /不是合法 JSON/.test(String((g1.json || {}).degradedDetail || '')), oneLine((g1.json || {}).degradedDetail));
      A('   └ 返回的仍是旧快照（generatedAt 未变）—— 正因为如此**才必须**标记',
        (g1.json || {}).generatedAt === gen0, 'generatedAt=' + (g1.json || {}).generatedAt + ' 旧值=' + gen0);
      A('降级也写进了 stderr（服务端日志可事后归因）',
        /读不出来/.test(srv.err), oneLog(srv.err.split('\n').filter(l => /读不出来/.test(l)).join(' ')));

      /* 修好磁盘 → 下一次 GET 必须自己恢复（失败不得永久降级） */
      writeLib('2026-02-02T00:00:00.000Z');
      const g2 = await req(PORT, '/api/state');
      A('磁盘修好之后 GET → 不再带 degraded（一次读失败不永久降级）',
        g2.status === 200 && !g2.json.degraded, 'degraded=' + (g2.json && g2.json.degraded));
      A('   └ 且读到了**新的**状态包（generatedAt 变了）',
        (g2.json || {}).generatedAt === '2026-02-02T00:00:00.000Z', (g2.json || {}).generatedAt);

      /* 文件被删：内存里还有快照 —— 同样是"旧数据"，同样必须标记 */
      fs.unlinkSync(STATE_FILE);
      const g3 = await req(PORT, '/api/state');
      A('_状态.json 被删掉后 GET → 200 但带 degraded:"state-unreadable"（改前同样是静默 200）',
        g3.status === 200 && g3.json && g3.json.degraded === 'state-unreadable',
        'status=' + g3.status + ' degraded=' + (g3.json && g3.json.degraded));
      writeLib('2026-03-03T00:00:00.000Z');
      A('还原后 GET 又恢复干净（收尾）', !(await req(PORT, '/api/state')).json.degraded);
    }

    /* ══ ⑦ 源码形状（防"改回去"）：三道门禁的语句必须在场 ══ */
    console.log('\n══ ⑦ 源码形状：Host / Origin(null) / token 三道门禁不得被删 ══');
    {
      const src = fs.readFileSync(SERVER, 'utf8');
      const codeText = stripComments(src);
      A('源码（去注释）里有 hostVerdict 判据与调用',
        /function hostVerdict\(/.test(codeText) && /hostVerdict\(req\.headers\.host\)/.test(codeText));
      A("源码（去注释）里不再有 `origin === 'null'` 的放行分支（S02）",
        !/===\s*'null'/.test(codeText) && !/===\s*"null"/.test(codeText));
      A('源码（去注释）里有 originTrusted 入口门禁', /if \(!originTrusted\(origin\)\)/.test(codeText));
      A('源码（去注释）里 /api/* 上有 token 门禁（且只对浏览器强制）',
        /isApi && looksLikeBrowser\(req\) && !tokenVerdict\(req\)/.test(codeText));
      A('源码（去注释）里 POST /api/state 有 application/json 门禁与 429 限流',
        /ctype !== 'application\/json'/.test(codeText) && /REBUILD_MIN_MS/.test(codeText) && /429/.test(codeText));
      A('源码（去注释）里 GET /api/state 的空 catch 已被替换成显式降级',
        /stateFail/.test(codeText) && /degraded = stateFail\.code/.test(codeText));
      /* 前端那一半：token 必须只有一个出口（禁止各处各写一份 header） */
      const hsrc = stripComments(fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'host.js'), 'utf8'));
      const apiN = (hsrc.match(/apiFetch\(/g) || []).length;
      A('host.js（去注释）里有 X-CTB-Token 且由 apiFetch 统一加', /X-CTB-Token/.test(hsrc) && /function apiFetch\(/.test(hsrc));
      A('host.js（去注释）里四处业务请求都改走 apiFetch（加上定义共 5 处）', apiN === 5, '命中 ' + apiN + ' 处');
      A("host.js（去注释）里不再有 `fetch(H.root + 'api/` 这种绕过 token 的写法",
        !/fetch\(H\.root \+ 'api\//.test(hsrc));
      A('host.js（去注释）里没有 token 就不进 server 模式（否则落进"health 通、/api 全 403"的半死态）',
        /if \(!H\.token\) return false;/.test(hsrc));
    }

    /* ══ ⑧ 阴性自证：掏掉门禁后同一个请求必须恢复 200（否则本用例没有牙齿） ══ */
    console.log('\n══ ⑧ 阴性自证：分别掏掉 Host 校验 / token 门禁，旧行为必须复现 ══');
    {
      const src = fs.readFileSync(SERVER, 'utf8');
      const origLines = src.split('\n').length;
      const mutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-s05-mut-'));
      for (const f of ['_库根.mjs', '_安全写.mjs']) fs.copyFileSync(E.tool(f), path.join(mutDir, f));
      /* 变异实例用**同一套**程序根与库（只换 _服务端.mjs 的路径）：这样"变 200"只能归因于掏掉了门禁，
         而不是"另一个空程序目录 / 另一个库"造成的假象。 */
      const cases = [
        ['Host 校验', /^    if \(!hv\.ok\) \{$/m, '    if (false) {   // 变异：掏掉 Host 校验',
          async (p) => (await req(p, '/api/state', { headers: { Host: 'attacker.example:' + p } })).status],
        ['token 门禁', /^    if \(isApi && looksLikeBrowser\(req\) && !tokenVerdict\(req\)\) \{$/m, '    if (false) {   // 变异：掏掉 token 门禁',
          async (p) => (await req(p, '/api/state', { headers: Object.assign({}, BROWSER) })).status],
      ];
      for (const [name, anchor, repl, probe] of cases) {
        const mut = src.replace(anchor, repl);
        A('变异锚点命中（' + name + '，行首锚定）', mut !== src);
        A(name + ' 变异只增删了个位数行（防"锚点打偏、整段代码被吃"）',
          Math.abs(mut.split('\n').length - origLines) <= 2, origLines + ' 行 → ' + mut.split('\n').length + ' 行');
        const mutServer = path.join(mutDir, '_服务端.mjs');
        fs.writeFileSync(mutServer, mut, 'utf8');
        const chk = spawnSync(process.execPath, ['--check', mutServer], { encoding: 'utf8' });
        A(name + ' 变异源码语法自检通过（node --check）', chk.status === 0,
          String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));
        const mp = await freePort();
        srvMut = startAt(mp, mutServer);
        const up = await waitHealth(mp);
        A(name + ' 变异实例能起来', up, 'stderr=' + oneLog(srvMut.err.slice(0, 200)));
        if (up) {
          const st = await probe(mp);
          A('掏掉 ' + name + ' 之后，同一个请求 → **200**（改前行为复现，证明本断言有牙齿）',
            st === 200, 'status=' + st);
        }
        await srvMut.stop(); srvMut = null;
      }
      try { fs.rmSync(mutDir, { recursive: true, force: true }); } catch (e) { }
      A('变异目录已清理', !fs.existsSync(mutDir));
    }

    /* 收尾：临时目录必须清干净。⚠ 必须放在 end() **之前** —— end() 一打印 RESULT，
       后面的断言就不再计数（neg-server-junction.cjs 的注释里记过这个坑）。 */
    await stopAll();
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { }
    A('临时目录已清理（真库与 7187 上的用户实例全程零接触）', !fs.existsSync(T));

    code = end('S02/S05/S06/B01 服务端来源/宿主/写路径/状态缓存加固');
  } finally {
    /* 异常路径的兜底：只清理，不产生断言 */
    await stopAll();
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(code);
})();
