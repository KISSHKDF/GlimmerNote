/* 拾光小册 · 服务端模式「冷库首开」判据（2026-11-04 真机发现后补）
 *
 * 起因（实测）：把一个**还没有 `_状态.json`** 的库交给 `_服务端.mjs`，`GET /api/state` 返回 **500**，
 *   页面白屏。链路是：GET → `pendingFreshness()` 判 stale → spawn `_状态刷新.mjs pending-if-stale`
 *   → 它第一步就读 `_状态.json` → 文件不存在 ⇒ 非 0 退出 ⇒ await 抛错 ⇒ 整个 GET 500。
 *   而服务端启动横幅本来就打印 `state=MISSING(will rebuild on first /api/state)` ——
 *   **承诺了要重建，却把 500 甩给页面**。
 *
 * 判据：
 *   ① 冷库（无 `_状态.json`）GET /api/state ⇒ **200**，响应里有 `generatedAt`，且**状态包被自建**
 *   ② 响应**不带** `degraded`（重建成功就不该挂降级标记 —— 挂了说明走的是"重建也失败"那条路）
 *   ③ 阴性对照：重建**故意失败**时（把库根做成"生成器跑不动"的样子）⇒ 不是 500，而是 200 +
 *      `degraded=state-missing-rebuild-failed`（"失败必须说失败"，但页面还能拿到可读的说明）
 *   ④ `/health` 的 `hasState` 语义不变（探针仍能回答"现在有没有状态包"）
 *
 * 只写 %TEMP% 夹具；真库零写入。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const E = require('./_测试环境.cjs');
const ROOT = E.REPO;
/* 请求一律走仓库既有的**裸 http** 客户端（`neg-server-lib.cjs` 的 `req`）。
   为什么不用 `fetch`：Node 的 fetch 会带上 `Sec-Fetch-*` 之类的浏览器头，服务端据此判定"这是浏览器来的"
   ⇒ 要求 `X-CTB-Token` ⇒ **403**（我第一版就是这么假红的，七条断言全红）。
   本用例验的是"冷库首开"，与浏览器 token 门无关；服务端对非浏览器客户端明确不强制 token。 */
const { req } = require('./neg-server-lib.cjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? '  → ' + detail : ''));
  ok ? pass++ : fail++;
};
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** 造一个冷库（没有 _状态.json）。broken=true 时让它"生成器跑不动"（索引不是合法 JSON）。 */
function makeColdLib(broken) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cold-'));
  fs.mkdirSync(path.join(lib, '学生A', '物理', 'P1-卡'), { recursive: true });
  fs.writeFileSync(path.join(lib, '学生A', '物理', 'P1-卡', '错题记录.md'), '# x\n', 'utf8');
  fs.writeFileSync(path.join(lib, '学生A', '物理', '_索引.json'),
    broken ? '{ 这不是合法 JSON' : JSON.stringify({ student: '学生A', grade: '九年级', items: [{ id: 'P1', dir: 'P1-卡', status: '在册' }] }), 'utf8');
  fs.writeFileSync(path.join(lib, '_原卷台账.json'), JSON.stringify({ version: 1, cards: {} }), 'utf8');
  fs.writeFileSync(path.join(lib, '_待确认.json'), JSON.stringify({ note: '夹具', seq: 0, items: [] }), 'utf8');
  return lib;
}

async function withServer(lib, fn) {
  const port = await freePort();
  const proc = spawn(process.execPath, [E.tool('_服务端.mjs')], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: lib }),
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const stop = () => { try { proc.kill(); } catch { } };
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 30000) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) }); if (r.ok) { up = true; break; } } catch { }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) { stop(); return { error: '服务端 30s 没起来：' + log.slice(-300) }; }
  const base = 'http://127.0.0.1:' + port;
  try {
    const health0 = (await req(port, '/health', { timeoutMs: 5000 })).json;
    const res = await req(port, '/api/state', { timeoutMs: 180000 });
    const health1 = (await req(port, '/health', { timeoutMs: 5000 })).json;
    return { status: res.status, json: res.json, text: res.text, health0, health1, log };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally { stop(); }
}

(async () => {
  console.log('═══ ① 冷库首开：GET /api/state 必须 200 且自建状态包 ═══');
  {
    const lib = makeColdLib(false);
    A('①前置：库里确实没有 `_状态.json`', !fs.existsSync(path.join(lib, '_状态.json')));
    const r = await withServer(lib, null);
    if (r.error) { console.log('RESULT=SKIP(服务端起不来：' + r.error + ')'); process.exit(0); }
    A('①a ★冷库 GET /api/state ⇒ 200（改前是 500 + 白屏）', r.status === 200, 'status=' + r.status);
    A('①b 响应里有 generatedAt（是一份真状态包，不是 {error:"no state"}）',
      !!(r.json && r.json.generatedAt), JSON.stringify(Object.keys(r.json || {}).slice(0, 8)));
    A('①c ★状态包被**自建**出来了（磁盘上出现了 `_状态.json`）', fs.existsSync(path.join(lib, '_状态.json')));
    A('①d 没有降级标记（重建成功就不该挂 degraded）', !(r.json && r.json.degraded), String(r.json && r.json.degraded));
    A('①e `/health` 的 hasState 语义：开前 false → 开后 true',
      r.health0 && r.health0.hasState === false && r.health1 && r.health1.hasState === true,
      JSON.stringify({ before: r.health0 && r.health0.hasState, after: r.health1 && r.health1.hasState }));
    fs.rmSync(lib, { recursive: true, force: true });
  }

  console.log('\n═══ ② 阴性对照：重建也失败时，仍不 500，而是显式降级 ═══');
  {
    const lib = makeColdLib(true);   // 索引不是合法 JSON ⇒ 生成器会失败
    const r = await withServer(lib, null);
    if (r.error) { console.log('RESULT=SKIP(服务端起不来：' + r.error + ')'); process.exit(0); }
    A('②a ★重建失败 ⇒ 仍是 200（不把 500 甩给页面）', r.status === 200, 'status=' + r.status);
    A('②b ★但必须**说失败**：degraded=state-missing-rebuild-failed',
      !!(r.json && r.json.degraded === 'state-missing-rebuild-failed'),
      String(r.json && (r.json.degraded + ' / ' + String(r.json.degradedDetail || '').slice(0, 120))));
    A('②c 详情里有原因（不是一句"失败"）',
      !!(r.json && typeof r.json.degradedDetail === 'string' && r.json.degradedDetail.length > 10),
      String(r.json && r.json.degradedDetail || '').slice(0, 160));
    fs.rmSync(lib, { recursive: true, force: true });
  }

  console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
  process.exit(fail ? 1 : 0);
})();
