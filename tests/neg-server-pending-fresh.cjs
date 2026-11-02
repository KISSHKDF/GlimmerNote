#!/usr/bin/env node
/**
 * R8（2026-11-02）· pending 新鲜度判据统一到内容哈希
 *
 * 缺陷（ws1-http 2026-11-02 亲测，独立实例 + 合成库）：
 *   服务端 `pendingFreshness()` 只比 **stat**（`rec.mtimeMs === st.mtimeMs && rec.size === st.size`），
 *   而刷新器 `_状态刷新.mjs::pendingIsFresh()` 是**内容哈希优先**、命中即"台账未变 ⇒ 不写盘"，
 *   于是 `_状态.json._pendingSrc.mtimeMs` 永远停在旧值 —— 两套判据**互相抵消**：
 *   "内容没变但 mtime 变过"（touch / 以相同字节重存 / 从副本还原）时，
 *   每次 `GET /api/state`（页面启动/刷新的最高频路由）都会同步 spawn 一个子进程
 *   （实测 81/74/79 ms vs 内容真变后的 1 ms；`_状态.json` 三次都没变）。
 *
 * 判据（`_服务端.mjs::pendingFreshness`，与 `_状态刷新.mjs::pendingFingerprint` 同算法同截断）：
 *   `rec.hash` 存在 ⇒ 比 `_待确认.json` 的 sha1 前 16 位（相等 = fresh）；
 *   mtime+size 与记录全等 ⇒ 快速路径（不读盘）；无 `rec.hash` ⇒ stale。
 *
 * 断言：
 *   ① touch（只改 mtime、内容一字不动）后连续 3 次 `GET /api/state`：**不 spawn**（替身计数文件 0 行）、
 *      服务端 stderr 无 `[pending]` 子进程输出、每次 < 200 ms、`_状态.json` 不被写；
 *   ② 真改 `_待确认.json` 内容 ⇒ **必须**刷新：spawn 计数 +1，响应与磁盘的 `_pendingSrc.hash` 都更新；
 *   ③ 阴性自证：把 `pendingFreshness` 还原成旧 stat 判据（源码级替身，同一装置）⇒ touch 后 3 次 GET
 *      每次都会 spawn（计数 3 行 + stderr 出现 `[pending] 台账未变…`）——证明 ① 的"0 行"有牙齿。
 *
 * 装置：`_状态刷新.mjs` 换成**计数包装**（先记一行，再原样转发给真工具）—— 真工具照跑，
 *   这样"到底有没有 spawn"是精确计数，不靠解析日志文字。库是 %TEMP% 临时库。
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ROOT, req, waitHealth, counter } = require('./neg-server-lib.cjs');

const { A, end } = counter();
const PORT = 18051;          // 真源码
const MUT_PORT = 18052;      // 阴性自证（旧 stat 判据）
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pfresh-'));
const sha16 = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 计数包装：先记账，再原样转发给**真** `_状态刷新.mjs`（stdout/stderr/argv 全部透传） */
const WRAPPER = [
  '/* 测试替身（只在 %TEMP% 源码副本里）：记一次 spawn，再把请求原样交给真工具。',
  '   真工具照跑 ⇒ 本用例测的是服务端行为，不是替身行为。 */',
  "import fs from 'fs';",
  "import { pathToFileURL } from 'url';",
  "fs.appendFileSync(process.env.CTB_STUB_COUNT, 'SPAWN ' + new Date().toISOString() + '\\n');",
  'await import(pathToFileURL(process.env.CTB_REAL_REFRESH).href);',
  '',
].join('\n');

function makeRepoCopy(tag) {
  const repo = path.join(WORK, tag);
  fs.mkdirSync(path.join(repo, 'src', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'app'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'tools'))) {
    fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(repo, 'src', 'tools', f));
  }
  fs.copyFileSync(path.join(ROOT, 'src', 'app', 'index.html'), path.join(repo, 'src', 'app', 'index.html'));
  fs.writeFileSync(path.join(repo, 'src', 'tools', '_状态刷新.mjs'), WRAPPER, 'utf8');
  return repo;
}

/** 把 `pendingFreshness` 还原成改前的 stat 版本（唯一变量：判据） */
function restoreStatJudgement(repo) {
  const p = path.join(repo, 'src', 'tools', '_服务端.mjs');
  let src = fs.readFileSync(p, 'utf8');
  const re = /^function pendingFreshness\(\) \{[\s\S]*?\n\}\n/m;
  if (!re.test(src)) throw new Error('阴性自证无效：找不到 pendingFreshness 函数体');
  src = src.replace(re, [
    'function pendingFreshness() {',
    '  let st;',
    '  try { st = fs.statSync(PENDING); }',
    "  catch (e) { return { status: 'unreadable', error: String((e && e.message) || e) }; }",
    '  const rec = state && state._pendingSrc;',
    "  if (rec && rec.mtimeMs === st.mtimeMs && rec.size === st.size) return { status: 'fresh' };",
    "  return { status: 'stale' };",
    '}',
    '',
  ].join('\n'));
  if (src.includes('pendingHash(raw) === rec.hash')) throw new Error('阴性自证无效：hash 分支没被摘掉');
  fs.writeFileSync(p, src, 'utf8');
}

/** 临时库：真库文本副本 + 受控的 `_待确认.json`（内容 C1）与 `_状态.json`（`_pendingSrc` = C1 的指纹） */
function makeLib(tag, content) {
  const { makeTempLib } = require('./_测试环境.cjs');
  const lib = path.join(WORK, 'lib-' + tag);
  const src = makeTempLib();
  fs.cpSync(src, lib, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
  const pend = path.join(lib, '_待确认.json');
  fs.writeFileSync(pend, content, 'utf8');
  const st = fs.statSync(pend);
  const raw = fs.readFileSync(pend);
  const fp = { mtimeMs: st.mtimeMs, size: st.size, hash: sha16(raw) };
  /* data:[] ⇒ 刷新器的 healOrigPaths 无事可做（healed=0），"台账未变"时它真的不写盘 ——
     这正是 ws1-http 复现永久循环的那个状态（若有卡要自愈，它会写盘、反而掩盖缺陷）。 */
  fs.writeFileSync(path.join(lib, '_状态.json'),
    JSON.stringify({ version: 3, generatedAt: '2026-11-02T00:00:00.000Z', data: [], pending: {}, _pendingSrc: fp }), 'utf8');
  return { lib, pend, fp };
}

/** touch：内容一字不动、只把 mtime 推后 7 秒（等价 touch / 同字节重存 / 从副本还原） */
function touch(pend, fp, ms) {
  fs.utimesSync(pend, new Date(), new Date(fp.mtimeMs + ms));
  const st = fs.statSync(pend);
  return { mtimeMs: st.mtimeMs, size: st.size, hash: sha16(fs.readFileSync(pend)) };
}

function startServerAt(serverJs, port, lib, countFile) {
  const proc = spawn(process.execPath, [serverJs], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      CTB_PORT: String(port), CTB_DATA: lib, CTB_STUB_COUNT: countFile,
      CTB_REAL_REFRESH: path.join(ROOT, 'src', 'tools', '_状态刷新.mjs'),
    }),
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
const spawns = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith('SPAWN')).length : 0);
async function timed(port, url, timeoutMs = 60000) {
  const t = Date.now();
  const r = await req(port, url, { timeoutMs });
  return { ms: Date.now() - t, status: r.status, json: r.json, text: r.text };
}

const C1 = JSON.stringify({ exportedAt: '2026-11-02T00:00:00.000Z', items: [{ id: 'T001', note: 'C1' }] }, null, 1);
const C2 = JSON.stringify({ exportedAt: '2026-11-02T00:00:00.000Z', items: [{ id: 'T001', note: 'C2-已改' }] }, null, 1);

(async () => {
  let code = 1;
  /* ══════════ ① 真源码：touch 不改内容 ⇒ 3 次 GET 一次都不 spawn ══════════ */
  let probe = makeLib('a', C1);
  const touched = touch(probe.pend, probe.fp, 7000);
  A('夹具：touch 后 size 不变、内容 hash 不变、mtime 变了（"改了时间没改内容"这个可达状态）',
    touched.size === probe.fp.size && touched.hash === probe.fp.hash && touched.mtimeMs !== probe.fp.mtimeMs,
    'size=' + touched.size + ' hash=' + touched.hash + ' Δmtime=' + (touched.mtimeMs - probe.fp.mtimeMs).toFixed(0) + 'ms');
  A('夹具：`_状态.json._pendingSrc.hash` 与磁盘内容一致（改前判据只看 stat，会判 stale）',
    probe.fp.hash === touched.hash, probe.fp.hash);

  const repoA = makeRepoCopy('fixed');
  const cntA = path.join(WORK, 'count-a.txt');
  fs.writeFileSync(cntA, '', 'utf8');
  const srvA = startServerAt(path.join(repoA, 'src', 'tools', '_服务端.mjs'), PORT, probe.lib, cntA);
  try {
    if (!await waitHealth(PORT)) {
      A('被测实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；stderr=' + srvA.err.slice(0, 300));
      process.exit(end('R8 pending 新鲜度'));
    }
    A('被测实例启动（127.0.0.1:' + PORT + '，_状态刷新 为计数包装 → 真工具）', true);

    console.log('\n══ ① touch 后连续 3 次 GET /api/state：不得 spawn（改前 81/74/79 ms 每次一个子进程）══');
    const stateM0 = fs.statSync(path.join(probe.lib, '_状态.json')).mtimeMs;
    const rs = [];
    for (let i = 1; i <= 3; i++) {
      const r = await timed(PORT, '/api/state');
      rs.push(r);
      A('第 ' + i + ' 次 GET /api/state → 200 且 < 200ms', r.status === 200 && r.ms < 200,
        'status=' + r.status + ' 用时=' + r.ms + 'ms');
      A('  ↳ 响应里 _pendingSrc.hash 仍是磁盘内容的 hash（走的是内容级判据）',
        r.json && r.json._pendingSrc && r.json._pendingSrc.hash === touched.hash,
        (r.json && r.json._pendingSrc && r.json._pendingSrc.hash) || 'none');
    }
    A('★ 3 次 GET 一次都没 spawn 刷新子进程（计数文件 0 行）', spawns(cntA) === 0, 'SPAWN×' + spawns(cntA));
    A('★ 服务端 stderr 里没有 [pending] 子进程输出', !/\[pending\]/.test(srvA.err), JSON.stringify(srvA.err.slice(0, 160)));
    A('GET 是只读的：3 次之后 `_状态.json` 没被写（mtime 未变）',
      fs.statSync(path.join(probe.lib, '_状态.json')).mtimeMs === stateM0, '');
    A('改前的缺陷形态在本装置上确实可达（同一 touch 让 stat 判据变 stale）',
      touched.mtimeMs !== probe.fp.mtimeMs && touched.size === probe.fp.size, '（③ 用源码级替身复现）');

    console.log('\n══ ② 真改内容 ⇒ 必须刷新，且 hash 更新 ══');
    fs.writeFileSync(probe.pend, C2, 'utf8');
    const wanted = sha16(fs.readFileSync(probe.pend));
    A('夹具：新内容 hash 与旧的不同（前置）', wanted !== touched.hash, touched.hash + ' → ' + wanted);
    const n0 = spawns(cntA);
    const r2 = await timed(PORT, '/api/state');
    A('改内容后 GET /api/state → 200', r2.status === 200, 'status=' + r2.status + ' 用时=' + r2.ms + 'ms');
    A('★ 必须刷新：spawn 计数 +1', spawns(cntA) === n0 + 1, n0 + ' → ' + spawns(cntA));
    A('★ 响应里的 _pendingSrc.hash 已更新为新内容 sha1 前 16 位',
      r2.json && r2.json._pendingSrc && r2.json._pendingSrc.hash === wanted,
      (r2.json && r2.json._pendingSrc && r2.json._pendingSrc.hash) || 'none');
    let diskState = null;
    try { diskState = JSON.parse(fs.readFileSync(path.join(probe.lib, '_状态.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { }
    A('★ 磁盘 `_状态.json._pendingSrc.hash` 也已更新（刷新器真的写了盘）',
      !!(diskState && diskState._pendingSrc && diskState._pendingSrc.hash === wanted),
      diskState && diskState._pendingSrc ? diskState._pendingSrc.hash : 'none');
    A('刷新后 pending 分区被换成了门禁 --json 的结果（真工具跑通）',
      !!(r2.json && r2.json.pending && typeof r2.json.pending === 'object' && 'ok' in r2.json.pending),
      JSON.stringify(r2.json && r2.json.pending).slice(0, 90));
    const r3 = await timed(PORT, '/api/state');
    A('再 GET 一次：已收敛，不再 spawn 且 < 200ms', r3.ms < 200 && spawns(cntA) === n0 + 1, '用时=' + r3.ms + 'ms SPAWN×' + spawns(cntA));
  } finally { await srvA.stop(); }

  /* ══════════ ③ 阴性自证：还原旧 stat 判据 ⇒ touch 后每次 GET 都 spawn ══════════ */
  console.log('\n══ ③ 阴性自证：还原成旧 stat 判据 ⇒ touch 后 3 次 GET 每次都 spawn ══');
  const repoB = makeRepoCopy('stat-only');
  try { restoreStatJudgement(repoB); } catch (e) {
    A('替身构造成功（判据找得到、变异真生效）', false, String(e && e.message));
    process.exit(end('R8 pending 新鲜度'));
  }
  A('替身构造成功：pendingFreshness 已还原成旧 stat 判据（hash 分支被摘掉）',
    fs.readFileSync(path.join(repoB, 'src', 'tools', '_服务端.mjs'), 'utf8').includes('rec.mtimeMs === st.mtimeMs && rec.size === st.size'), '');
  const probeB = makeLib('b', C1);
  const touchedB = touch(probeB.pend, probeB.fp, 7000);
  const cntB = path.join(WORK, 'count-b.txt');
  fs.writeFileSync(cntB, '', 'utf8');
  const srvB = startServerAt(path.join(repoB, 'src', 'tools', '_服务端.mjs'), MUT_PORT, probeB.lib, cntB);
  try {
    if (!await waitHealth(MUT_PORT)) {
      A('替身实例启动（旧 stat 判据）', false, 'health 超时；stderr=' + srvB.err.slice(0, 300));
    } else {
      A('替身实例启动（旧 stat 判据）', true);
      for (let i = 1; i <= 3; i++) {
        const r = await timed(MUT_PORT, '/api/state');
        A('替身第 ' + i + ' 次 GET → 200', r.status === 200, 'status=' + r.status + ' 用时=' + r.ms + 'ms');
      }
      A('★ 缺陷复现：3 次 GET = 3 次 spawn（改前"每次 GET 都起一个子进程"）', spawns(cntB) === 3, 'SPAWN×' + spawns(cntB));
      A('★ 缺陷复现：服务端 stderr 出现子进程的 [pending] 台账未变 行',
        (srvB.err.match(/\[pending\] 台账未变/g) || []).length >= 3,
        '命中 ' + (srvB.err.match(/\[pending\] 台账未变/g) || []).length + ' 行');
      A('★ 真源码 vs 替身的同装置对照：真源码全程 spawn=' + spawns(cntA) + '（仅②真改内容那次），替身 3 次',
        spawns(cntA) === 1 && spawns(cntB) === 3, '真源码 SPAWN×' + spawns(cntA) + ' / 替身 SPAWN×' + spawns(cntB));
      A('替身下 pending 指纹始终停在旧值（刷新器走快速路径、不写盘 ⇒ 永久循环的机理）',
        touchedB.hash === probeB.fp.hash && touchedB.mtimeMs !== probeB.fp.mtimeMs, '');
    }
  } finally {
    await srvB.stop();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  code = end('R8 pending 新鲜度判据统一');
  process.exit(code);
})().catch(e => {
  console.error('FATAL ' + (e && e.stack || e));
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (x) { }
  process.exit(1);
});
