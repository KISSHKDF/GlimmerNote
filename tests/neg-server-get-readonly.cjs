#!/usr/bin/env node
/**
 * BUG-16 断言（2026-10-11）：`GET /api/state` 必须**只读**——连续两次 GET，第二次不得改写 `_状态.json`。
 *
 * 审计：旧 `_服务端.mjs:156` 在 GET 里无条件 `serialized(() => refreshPendingSection())`
 *   → spawn node 跑 `_状态刷新.mjs pending` → `:29` 整体重写 1.35 MB 的 `_状态.json`。
 *   改前实测（用户正在跑的那个进程，我只读探测）：
 *     GET #1 后 `_状态.json` mtime 09:47:28.105 → GET #2 后 09:47:28.793（**第二次 GET 又写了一遍**）。
 *
 * 断言：
 *   ① 单元：`node _状态刷新.mjs pending-if-stale` 连跑两次，第二次必须"台账未变 → 跳过刷新与写盘"
 *      （stderr 有跳过标记 + 文件哈希与 mtime 都不动）——这是"没变就不 spawn `_待确认.mjs`、不写盘"的直接证据；
 *   ② 端到端：另起一个**独立端口**的服务端实例（不碰用户那个 7187），连发 3 次 `GET /api/state`，
 *      第 2/3 次的 `_状态.json` 哈希与 mtime 必须与第 1 次之后完全一致；
 *   ③ 反向（"变了才刷"没被误伤）：把 `_状态.json` 里的 `_pendingSrc` 指纹删掉（模拟"生成器刚重写过状态包"）
 *      → 下一次 GET 必须**确实**刷新（文件被改写、指纹被补回）→ 再下一次 GET 又回到安静。
 *   ④ 语义保持：`?section=pending` 与不带参的取数都必须 200 且带最新 pending 分区。
 *
 * 只改 `_状态.json`（生成物 + 逐字节可还原由 `_状态刷新.mjs` 自己重建）；**不碰任何真源**。
 * 退出码 0=全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, startServer, waitHealth, req, sleep, sha16, statOf, writeAtomic, counter } = require('./neg-server-lib.cjs');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
const { A, end } = counter();
const STATE = E.lib('_状态.json');
const REFRESH = E.tool('_状态刷新.mjs');
const PORT = 7191;

/* 外部写入者（用户那个 7187 老进程、别的会话）随时可能碰 _状态.json。
   测量前先等到文件"静止"（两次读一致），否则断言会偶发假红。 */
async function stable() {
  for (let i = 0; i < 12; i++) {
    const a = sha16(STATE) + '@' + statOf(STATE).mtimeMs;
    await sleep(220);
    const b = sha16(STATE) + '@' + statOf(STATE).mtimeMs;
    if (a === b) return b;
  }
  return sha16(STATE) + '@' + statOf(STATE).mtimeMs;
}

(async () => {
  let srv = null;
  try {
    console.log('══ ① 单元：pending-if-stale 第二次必须跳过（不 spawn 门禁、不写盘） ══');
    {
      execFileSync(process.execPath, [REFRESH, 'pending-if-stale'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64e6 });
      const snap0 = await stable();
      /* 用 spawnSync 而不是 execFileSync：**成功**时也要拿到 stderr（execFileSync 只在抛错时给 stderr） */
      const r2 = spawnSync(process.execPath, [REFRESH, 'pending-if-stale'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64e6 });
      const r2err = String(r2.stderr || ''), r2out = String(r2.stdout || '');
      const snap1 = sha16(STATE) + '@' + statOf(STATE).mtimeMs;
      A('第二次 pending-if-stale 打印"台账未变/跳过"', /台账未变/.test(r2err), r2err.trim().slice(0, 80));
      A('第二次 pending-if-stale 未改写 _状态.json（哈希+mtime 不变）', snap0 === snap1, snap0 + ' → ' + snap1);
      let ok = false, n = 0;
      try { const j = JSON.parse(r2out); ok = !!j.pending; n = j.data.length; } catch (e) { }
      A('跳过时 stdout 仍是完整状态包（调用方拿到的还是最新 pending）', ok, 'students=' + n);
    }

    console.log('\n══ ② 端到端：独立实例连发 3 次 GET /api/state ══');
    srv = startServer(PORT);
    if (!await waitHealth(PORT)) { A('独立服务端实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；stderr=' + srv.err.slice(0, 200)); process.exit(end('BUG-16 GET 只读')); }
    A('独立服务端实例启动（127.0.0.1:' + PORT + '）', true);

    const g1 = await req(PORT, '/api/state');
    A('GET#1 → 200 且带 pending 分区', g1.status === 200 && !!(g1.json && g1.json.pending), 'status=' + g1.status + ' pending.open=' + (g1.json && g1.json.pending && g1.json.pending.open));
    A('状态包里已记录 pending 来源指纹 _pendingSrc', !!(g1.json && g1.json._pendingSrc && g1.json._pendingSrc.hash), JSON.stringify(g1.json && g1.json._pendingSrc));
    const snapA = await stable();

    await sleep(150);
    const g2 = await req(PORT, '/api/state');
    const snapB = sha16(STATE) + '@' + statOf(STATE).mtimeMs;
    A('GET#2 → 200', g2.status === 200, 'status=' + g2.status);
    A('GET#2 未改写 _状态.json（哈希与 mtime 均不变）', snapA === snapB, snapA + ' → ' + snapB);

    await sleep(150);
    const g3 = await req(PORT, '/api/state');
    const snapC = sha16(STATE) + '@' + statOf(STATE).mtimeMs;
    A('GET#3 仍未改写 _状态.json', snapB === snapC, snapB + ' → ' + snapC);
    A('三次 GET 的 pending 分区逐字节一致（读接口只读、语义不变）', JSON.stringify(g1.json.pending) === JSON.stringify(g3.json.pending),
      'items=' + (g1.json.pending.items || []).length + ' open=' + g1.json.pending.open);

    console.log('\n══ ③ 反向：指纹缺失（= 生成器刚重写过状态包）时必须真的刷新 ══');
    {
      const st = JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, ''));
      delete st._pendingSrc;
      writeAtomic(STATE, JSON.stringify(st));
      const before = await stable();
      const g4 = await req(PORT, '/api/state');
      const after = sha16(STATE) + '@' + statOf(STATE).mtimeMs;
      A('GET#4 → 200', g4.status === 200, 'status=' + g4.status);
      A('指纹缺失时 GET 确实刷新并写盘（"变了才刷"没被误伤）', before !== after, before + ' → ' + after);
      A('刷新后 _pendingSrc 被补回', !!(g4.json && g4.json._pendingSrc && g4.json._pendingSrc.hash), JSON.stringify(g4.json && g4.json._pendingSrc));
      const snapD = await stable();
      const g5 = await req(PORT, '/api/state');
      A('指纹补回后下一次 GET 又回到安静（不写盘）', snapD === sha16(STATE) + '@' + statOf(STATE).mtimeMs, 'hash+mtime 稳定');
    }

    console.log('\n══ ④ 语义：?section=pending 仍拿到最新 pending ══');
    {
      const snapE = await stable();
      const r = await req(PORT, '/api/state?section=pending');
      A('GET /api/state?section=pending → 200 且带 pending', r.status === 200 && !!(r.json && r.json.pending), 'status=' + r.status);
      A('?section=pending 也不写盘（台账未变）', snapE === sha16(STATE) + '@' + statOf(STATE).mtimeMs);
    }
  } finally {
    if (srv) await srv.stop();
  }

  /* 还原：删掉指纹后测试自己补回过；这里确保 _状态.json 依旧是合法状态包 */
  A('收尾：_状态.json 仍是合法 JSON 且含 pending', (() => { try { const j = JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, '')); return !!j.pending && !!j.data; } catch (e) { return false; } })());

  process.exit(end('BUG-16 GET /api/state 只读'));
})();
