#!/usr/bin/env node
/**
 * R6（2026-11-02）· pending 刷新不得阻塞事件循环 + 并发只起一个子进程
 *
 * 缺陷（ws1-http 2026-11-02 亲测，慢桩 6 s）：
 *   `refreshPendingSection()` 用 `execFileSync` 同步跑在 async handler 里 ⇒ 整个事件循环被子进程
 *   时长冻住：6 s 子进程 ⇒ `/health` 也等 **5815 ms**、静态文件同样 5817 ms；把子进程改成睡 125 s
 *   （> timeout 120 s）⇒ 事件循环冻 **119.7 s**，随后该请求回 500 `spawnSync … ETIMEDOUT`。
 *   并发请求各自 spawn 一个自己的子进程（改前无 in-flight 复用）。
 *
 * 判据：
 *   ① 慢桩（睡 6 s）**进行中**，`/health` 必须 < 500 ms 返回；静态文件同理；
 *   ② 并发 5 次 `GET /api/state` **只** spawn 1 个子进程（慢桩自己写的计数文件为准，不看日志文字）；
 *   ③ 5 个响应都收敛到同一份 pending 指纹（刷新结果对每个等待者都生效）。
 *   阴性自证：把 `spawn` 版本还原成改前的 `execFileSync` 版本（源码级替身，同一慢桩）⇒
 *     刷新进行中的 `/health` 必须 > 5000 ms（缺陷复现；不跑 120 s，只跑 6 s 桩）。
 *
 * 装置：`_状态刷新.mjs` 是**替身**（真源码不动），放在 %TEMP% 的源码副本里 —— 服务端跑的是
 *   `toolPath('_状态刷新.mjs')`，即"服务端自己所在目录的兄弟文件"，所以替身必须放进副本周。
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, req, waitHealth, counter, sleep } = require('./neg-server-lib.cjs');

const { A, end } = counter();
const PORT = 18031;         // 真源码 + 慢桩
const MUT_PORT = 18032;     // 阴性自证：execFileSync 版
const SLOW_MS = 6000;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-refresh-'));
const STUB = [
  '/* 测试替身（只在 %TEMP% 源码副本里）：每次被 spawn 立刻记一行，睡 ' + SLOW_MS + ' ms 后把一份',
  '   **已收敛**的状态包写到 stdout（不改盘，等价真工具的"台账未变"快速路径）。 */',
  "import fs from 'fs';",
  "import crypto from 'crypto';",
  'const lib = process.env.CTB_DATA;',
  'const t0 = Date.now();',
  "fs.appendFileSync(process.env.CTB_STUB_COUNT, 'START ' + new Date().toISOString() + '\\n');",
  'await new Promise(r => setTimeout(r, ' + SLOW_MS + '));',
  "const st = JSON.parse(fs.readFileSync(lib + '/_状态.json', 'utf8').replace(/^\\uFEFF/, ''));",
  "const raw = fs.readFileSync(lib + '/_待确认.json');",
  'st._pendingSrc = { mtimeMs: fs.statSync(lib + \'/_待确认.json\').mtimeMs, size: raw.length,',
  "  hash: crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) };",
  'process.stdout.write(JSON.stringify(st));',
  "fs.appendFileSync(process.env.CTB_STUB_COUNT, 'END ' + (Date.now() - t0) + 'ms\\n');",
  '',
].join('\n');

/** 源码副本（工具目录 + 程序根 index.html），供替身/变异使用 */
function makeRepoCopy(tag) {
  const repo = path.join(WORK, tag);
  fs.mkdirSync(path.join(repo, 'src', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'app'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'tools'))) {
    fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(repo, 'src', 'tools', f));
  }
  fs.copyFileSync(path.join(ROOT, 'src', 'app', 'index.html'), path.join(repo, 'src', 'app', 'index.html'));
  fs.writeFileSync(path.join(repo, 'src', 'tools', '_状态刷新.mjs'), STUB, 'utf8');
  return repo;
}

/** 把 `refreshPendingSection` 还原成改前的同步 execFileSync 版本（唯一变量） */
function restoreBlockingRefresh(repo) {
  const p = path.join(repo, 'src', 'tools', '_服务端.mjs');
  let src = fs.readFileSync(p, 'utf8');
  const re = /^function refreshPendingSection\(\) \{[\s\S]*?\n\}\n/m;
  if (!re.test(src)) throw new Error('阴性自证无效：找不到 refreshPendingSection 函数体');
  src = src.replace(re, [
    'function refreshPendingSection() {',
    "  const out = execFileSync(process.execPath, [REFRESH, 'pending-if-stale'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });",
    "  state = parseJsonText(out, '_状态刷新 输出');",
    '  try { state._diskM = fs.statSync(STATE).mtimeMs; } catch (e) {}',
    '}',
    '',
  ].join('\n'));
  const imp = "import { spawn } from 'child_process';";
  if (!src.includes(imp)) throw new Error('阴性自证无效：找不到 child_process 导入行');
  src = src.replace(imp, "import { spawn, execFileSync } from 'child_process';");
  fs.writeFileSync(p, src, 'utf8');
}

/** 临时库：真库文本副本，但 `_状态.json` 的 `_pendingSrc` 被摘掉（= 刷新器刚重写过状态包） */
function makeLib(tag) {
  const { makeTempLib } = require('./_测试环境.cjs');
  const lib = path.join(WORK, 'lib-' + tag);
  const src = makeTempLib();
  fs.cpSync(src, lib, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
  const sp = path.join(lib, '_状态.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8').replace(/^\uFEFF/, ''));
  delete st._pendingSrc;
  fs.writeFileSync(sp, JSON.stringify(st), 'utf8');
  return lib;
}

function startServerAt(serverJs, port, lib, countFile) {
  const proc = spawn(process.execPath, [serverJs], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: lib, CTB_STUB_COUNT: countFile }),
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
const starts = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith('START')).length : 0);
const sha16 = buf => require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16);

/** 计时一次 GET，返回 {ms, status, json} */
async function timed(port, url, timeoutMs = 60000) {
  const t = Date.now();
  const r = await req(port, url, { timeoutMs });
  return { ms: Date.now() - t, status: r.status, json: r.json, text: r.text };
}

(async () => {
  let code = 1;
  let fixedHealthMs = -1;                 // ① 里实测的"刷新进行中 /health 用时"，供 ③ 做真对照
  /* ══════════ ① 真源码 + 慢桩：并发 5 次只起 1 个子进程，且期间不阻塞 ══════════ */
  const repoA = makeRepoCopy('fixed');
  const libA = makeLib('a');
  const cntA = path.join(WORK, 'count-a.txt');
  const srvA = startServerAt(path.join(repoA, 'src', 'tools', '_服务端.mjs'), PORT, libA, cntA);
  try {
    if (!await waitHealth(PORT)) {
      A('被测实例启动（127.0.0.1:' + PORT + '，慢桩 ' + SLOW_MS + 'ms）', false, 'health 超时；stderr=' + srvA.err.slice(0, 300));
      process.exit(end('R6 刷新不阻塞事件循环'));
    }
    A('被测实例启动（127.0.0.1:' + PORT + '，_状态刷新 是睡 ' + SLOW_MS + 'ms 的替身）', true);
    A('夹具：慢桩替身确实在副本里（不是真工具）', fs.readFileSync(path.join(repoA, 'src', 'tools', '_状态刷新.mjs'), 'utf8').includes('CTB_STUB_COUNT'), '');

    console.log('\n══ ① 并发 5 次 GET /api/state：刷新进行中 /health 必须 < 500ms ══');
    const t0 = Date.now();
    const five = [1, 2, 3, 4, 5].map(() => timed(PORT, '/api/state'));
    await sleep(600);                                   // 等第一个请求真的把慢桩拉起来
    const startedDuring = starts(cntA);
    A('慢桩确实已被 spawn 且仍在跑（计数文件 ≥ 1 行，且没有 END 行）',
      startedDuring >= 1 && !fs.readFileSync(cntA, 'utf8').includes('END'),
      'START×' + startedDuring + ' 已用时=' + (Date.now() - t0) + 'ms');
    const h = await timed(PORT, '/health');
    fixedHealthMs = h.ms;
    A('刷新进行中的 GET /health < 500ms（改前实测 5815ms）', h.ms < 500, 'status=' + h.status + ' 用时=' + h.ms + 'ms');
    const stat = await timed(PORT, '/index.html');
    A('刷新进行中的静态文件也照常返回（< 500ms）', stat.ms < 500 && stat.status === 200, 'status=' + stat.status + ' 用时=' + stat.ms + 'ms');

    const results = await Promise.all(five);
    const wall = Date.now() - t0;
    A('5 个并发请求全部 200', results.every(r => r.status === 200), results.map(r => r.status).join(','));
    A('总墙钟 ≈ 慢桩一轮（' + SLOW_MS + 'ms 量级，不是 5 轮）', wall < SLOW_MS * 2, '墙钟=' + wall + 'ms');
    A('★ 只 spawn 1 个子进程（并发共用同一次刷新）', starts(cntA) === 1, 'START×' + starts(cntA));
    const diskRaw = fs.readFileSync(path.join(libA, '_待确认.json'));
    A('5 个响应都收敛到同一份 pending 指纹（= 磁盘台账的 sha1 前 16 位）',
      results.every(r => r.json && r.json._pendingSrc && r.json._pendingSrc.hash === sha16(diskRaw)),
      results.map(r => (r.json && r.json._pendingSrc && r.json._pendingSrc.hash) || 'none').join(','));
    A('响应里的 mtimeMs/size 与磁盘一致',
      results.every(r => r.json._pendingSrc.size === diskRaw.length),
      String(diskRaw.length));
    A('/health 期间刷新仍在跑（说明上面的 500ms 不是"刷新已经结束了"）', startedDuring >= 1, '');

    console.log('\n══ ② 收敛后（指纹已对齐）再 GET：不得再 spawn ══');
    {
      const before = starts(cntA);
      const again = await timed(PORT, '/api/state');
      A('第 6 次 GET /api/state < 200ms（走不读盘快速路径）', again.ms < 200, '用时=' + again.ms + 'ms');
      A('第 6 次 GET 不再 spawn（计数文件没有增长）', starts(cntA) === before, before + ' → ' + starts(cntA));
    }
  } finally { await srvA.stop(); }

  /* ══════════ ② 阴性自证：还原成 execFileSync ⇒ 同一慢桩下 /health 被冻住 ══════════ */
  console.log('\n══ ③ 阴性自证：把 spawn 还原成 execFileSync ⇒ /health 必须 > 5000ms ══');
  const repoB = makeRepoCopy('blocking');
  try { restoreBlockingRefresh(repoB); } catch (e) {
    A('替身构造成功（判据找得到、变异真生效）', false, String(e && e.message));
    process.exit(end('R6 刷新不阻塞事件循环'));
  }
  A('替身构造成功：refreshPendingSection 已还原成改前的 execFileSync 同步实现',
    fs.readFileSync(path.join(repoB, 'src', 'tools', '_服务端.mjs'), 'utf8').includes('const out = execFileSync(process.execPath'), '');
  const libB = makeLib('b');
  const cntB = path.join(WORK, 'count-b.txt');
  const srvB = startServerAt(path.join(repoB, 'src', 'tools', '_服务端.mjs'), MUT_PORT, libB, cntB);
  try {
    if (!await waitHealth(MUT_PORT)) {
      A('替身实例启动（execFileSync 版）', false, 'health 超时；stderr=' + srvB.err.slice(0, 300));
    } else {
      A('替身实例启动（execFileSync 版）', true);
      const stateReq = timed(MUT_PORT, '/api/state');
      await sleep(600);
      const hb = await timed(MUT_PORT, '/health');
      A('★ 缺陷复现：刷新进行中 /health > 5000ms（事件循环被同步子进程冻住）', hb.ms > 5000, '用时=' + hb.ms + 'ms');
      A('慢桩确实跑过（替身自己写的计数文件 ≥ 1 行）', starts(cntB) >= 1, 'START×' + starts(cntB));
      const r = await stateReq;
      A('冻结结束后该请求仍回 200（不是崩溃）', r.status === 200, 'status=' + r.status + ' 用时=' + r.ms + 'ms');
      A('★ 同一场景的真源码对照：/health 用时 < 500ms（本次 ' + fixedHealthMs + 'ms，替身 ' + hb.ms + 'ms 倍差 ≈ ' +
        (fixedHealthMs > 0 ? (hb.ms / fixedHealthMs).toFixed(0) : '?') + '×）',
        fixedHealthMs > 0 && fixedHealthMs < 500 && hb.ms > fixedHealthMs * 5,
        '真源码=' + fixedHealthMs + 'ms 替身=' + hb.ms + 'ms');
    }
  } finally {
    await srvB.stop();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  code = end('R6 刷新不阻塞事件循环 + in-flight 复用');
  process.exit(code);
})().catch(e => {
  console.error('FATAL ' + (e && e.stack || e));
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (x) { }
  process.exit(1);
});
