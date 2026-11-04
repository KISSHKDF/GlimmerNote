#!/usr/bin/env node
/**
 * R7（2026-11-02）· 静态响应：流式下发 + 单文件上限 + Range
 *
 * 缺陷（ws1-http 2026-11-02 亲测）：
 *   ① `_服务端.mjs::serveStatic` 用 `fs.readFile` 把整份文件读进内存再 `res.end(buf)`：
 *      256 MiB 文件 ⇒ 服务端工作集 **+256.3 MB**（一比一），请求结束后停在 324.3 MB 不归还；
 *   ② **没有任何大小上限**（"能读就整份读"）；
 *   ③ **没有 Range 支持**：`Range: bytes=0-1023` 也回整份 268435456 字节、无 `Content-Range`。
 *
 * 判据（本用例逐条断言）：
 *   · > 64 MiB ⇒ **413** + 明确文案（含上限与文件实际大小），且**不读该文件**；
 *   · 无 `Range` ⇒ 200 + `Content-Length` 等于文件大小（改前是 chunked、无 Content-Length）；
 *   · `Range: bytes=0-99` ⇒ 206 + `Content-Range: bytes 0-99/<size>` + 正好 100 字节；
 *   · `bytes=<size>-`（起点越界）⇒ 416 + `Content-Range: bytes * /<size>`；
 *   · 非法 spec / 合法多段（本轮只支持单段）⇒ **忽略该头回 200 全量**（RFC 7233 口径，2026-11-02 lead 裁决）；
 *   · 全程服务端进程 RSS 增幅 < 32 MiB（改前 256 MiB 文件一比一放大 ⇒ 这条会红）。
 *
 * 库是自建临时库（%TEMP%），两个文件：`big.jpg` = 64 MiB + 1 字节、`mid.jpg` = 100 KiB。
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { ROOT, req, waitHealth, counter } = require('./neg-server-lib.cjs');

const { A, end } = counter();
const PORT = 18041;
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-stream-lib-'));
const BIG = 64 * 1024 * 1024 + 1;          // 64 MiB + 1：刚好越过上限
const MID = 100 * 1024;                    // 100 KiB
const MiB = 1024 * 1024;

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

/** 服务端进程的两项内存口径（字节）。用 OS 计数器，不用"服务端自己报"（那可以撒谎）。 */
function memOf(pid) {
  const txt = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$p=Get-Process -Id ' + pid + '; "$($p.WorkingSet64) $($p.PeakWorkingSet64)"'], { encoding: 'utf8' });
  const m = String(txt).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(m[0]) || !Number.isFinite(m[1])) throw new Error('拿不到进程内存：' + JSON.stringify(txt));
  return { ws: m[0], peak: m[1] };
}

(async () => {
  fs.writeFileSync(path.join(LIB, 'mid.jpg'), Buffer.alloc(MID, 0x41));      // 'A'×100KiB（ASCII ⇒ 字节数=字符数）
  fs.writeFileSync(path.join(LIB, 'big.jpg'), Buffer.alloc(BIG, 0x42));      // 'B'×(64MiB+1)
  A('夹具：big.jpg = 64 MiB + 1 字节', fs.statSync(path.join(LIB, 'big.jpg')).size === BIG, String(BIG));
  A('夹具：mid.jpg = 100 KiB', fs.statSync(path.join(LIB, 'mid.jpg')).size === MID, String(MID));

  const srv = startServerAt(path.join(ROOT, 'src', 'tools', '_服务端.mjs'), PORT, LIB);
  let code = 1;
  try {
    if (!await waitHealth(PORT)) {
      A('被测实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；stderr=' + srv.err.slice(0, 300));
      process.exit(end('R7 静态流式/上限/Range'));
    }
    A('被测实例启动（127.0.0.1:' + PORT + '，库=临时库）', true);
    const before = memOf(srv.proc.pid);
    console.log('  RSS BEFORE  WorkingSet=' + (before.ws / MiB).toFixed(1) + ' MiB  Peak=' + (before.peak / MiB).toFixed(1) + ' MiB');

    console.log('\n══ ① 上限：> 64 MiB 必须 413（明确文案），且不得把文件读进内存 ══');
    {
      const r = await req(PORT, '/big.jpg', { timeoutMs: 60000 });
      A('GET /big.jpg（64 MiB + 1 字节）→ 413', r.status === 413, 'status=' + r.status + ' body=' + r.text.slice(0, 120));
      A('  ↳ 文案含上限 67108864 字节（64 MiB）', r.text.includes(String(64 * 1024 * 1024)), r.text.slice(0, 160));
      A('  ↳ 文案含该文件实际大小 ' + BIG, r.text.includes(String(BIG)), r.text.slice(0, 160));
      A('  ↳ 响应体里没有文件内容（没有 ' + BIG + ' 字节的 B）', r.text.length < 1000 && !/^B+$/.test(r.text), 'len=' + r.text.length);
      A('  ↳ 413 带 json.ok=false', r.json && r.json.ok === false, JSON.stringify(r.json && r.json.limit));
    }

    console.log('\n══ ② 无 Range：200 + Content-Length（改前是 chunked、无 Content-Length）══');
    {
      const r = await req(PORT, '/mid.jpg', { timeoutMs: 60000 });
      A('GET /mid.jpg → 200', r.status === 200, 'status=' + r.status);
      A('  ↳ Content-Length = ' + MID, Number(r.headers['content-length']) === MID, 'CL=' + r.headers['content-length']);
      A('  ↳ Accept-Ranges: bytes（已声明支持分段）', r.headers['accept-ranges'] === 'bytes', 'AR=' + r.headers['accept-ranges']);
      A('  ↳ 正文长度 = ' + MID, r.text.length === MID, 'len=' + r.text.length);
      A('  ↳ 无 Content-Range（200 时不应有）', r.headers['content-range'] === undefined, String(r.headers['content-range']));
      A('  ↳ 库内响应的 CSP 仍带 default-src（R1 未因流式改造失效）', /default-src 'none'/.test(String(r.headers['content-security-policy'])), String(r.headers['content-security-policy']).slice(0, 60));
    }

    console.log('\n══ ③ Range：可满足 → 206 + Content-Range + 准确切片 ══');
    {
      const cases = [
        ['bytes=0-99', 0, 99, '首 100 字节（R2 判据里点名的那一条）'],
        ['bytes=102300-102399', MID - 100, MID - 1, '尾 100 字节'],
        ['bytes=102399-', MID - 1, MID - 1, '最后 1 字节（末尾开口式）'],
        ['bytes=-100', MID - 100, MID - 1, '后缀式 bytes=-100'],
      ];
      for (const [h, s, e, why] of cases) {
        const r = await req(PORT, '/mid.jpg', { headers: { Range: h }, timeoutMs: 60000 });
        const want = 'bytes ' + s + '-' + e + '/' + MID;
        A('Range: ' + h + ' → 206（' + why + '）', r.status === 206, 'status=' + r.status);
        A('  ↳ Content-Range = ' + want, r.headers['content-range'] === want, 'CR=' + r.headers['content-range']);
        A('  ↳ 切片字节数 = ' + (e - s + 1), r.text.length === (e - s + 1), 'len=' + r.text.length);
      }
      /* 逐字节核对首段真的是文件开头那 100 字节 */
      const head = fs.readFileSync(path.join(LIB, 'mid.jpg')).subarray(0, 100).toString('utf8');
      const r0 = await req(PORT, '/mid.jpg', { headers: { Range: 'bytes=0-99' }, timeoutMs: 60000 });
      A('  ↳ bytes=0-99 的切片与磁盘前 100 字节逐字节相同', r0.text === head, '');
    }

    console.log('\n══ ④ Range 不可满足 → 416；非法/多段 → 忽略该头回 200 全量（RFC 7233 口径）══');
    {
      /* 416 只给"合法单段但一条都不可满足"（起点越界、后缀为 0、空文件）。 */
      const unsat = [['bytes=99999999-', '起点越过文件尾'], ['bytes=-0', '后缀长度 0'], ['bytes=102400-', '起点 = 文件尾']];
      for (const [h, why] of unsat) {
        const r = await req(PORT, '/mid.jpg', { headers: { Range: h }, timeoutMs: 60000 });
        A('Range: ' + h + ' → 416（' + why + '）', r.status === 416, 'status=' + r.status + ' CR=' + r.headers['content-range']);
        A('  ↳ Content-Range = bytes * /' + MID, r.headers['content-range'] === 'bytes */' + MID, 'CR=' + r.headers['content-range']);
      }
      /* 非法 spec 与合法多段**都不是"不可满足"**：必须忽略该头、回整份（改前也是整份，但改前连
         `Content-Range`/`Accept-Ranges` 都没有；这里同时断言"忽略"是**显式**的：无 Content-Range）。 */
      const ignored = [
        ['bytes=abc', '语法坏'],
        ['bytes=0-1,5-6', '合法多段（本轮只支持单段）'],
        ['bytes=51200-100', '非法 spec：末位 < 首位'],
        ['items=0-1', '单位不是 bytes'],
        ['bytes=-', '空区间'],
      ];
      for (const [h, why] of ignored) {
        const r = await req(PORT, '/mid.jpg', { headers: { Range: h }, timeoutMs: 60000 });
        A('Range: ' + h + ' → 200 全量（忽略该头：' + why + '）', r.status === 200, 'status=' + r.status + ' CR=' + r.headers['content-range']);
        A('  ↳ 不带 Content-Range（证明是"忽略"而不是"误当 206"）', r.headers['content-range'] === undefined, String(r.headers['content-range']));
        A('  ↳ 整份正文 ' + MID + ' 字节 + Content-Length 一致',
          r.text.length === MID && Number(r.headers['content-length']) === MID,
          'len=' + r.text.length + ' CL=' + r.headers['content-length']);
      }
    }

    console.log('\n══ ⑤ 内存：全程 RSS 增幅 < 32 MiB（改前 256 MiB 文件一比一放大）══');
    {
      const after = memOf(srv.proc.pid);
      const dws = after.ws - before.ws, dpeak = after.peak - before.peak;
      console.log('  RSS AFTER   WorkingSet=' + (after.ws / MiB).toFixed(1) + ' MiB  Peak=' + (after.peak / MiB).toFixed(1) + ' MiB');
      A('WorkingSet64 增幅 < 32 MiB', dws < 32 * MiB, '+' + (dws / MiB).toFixed(1) + ' MiB');
      A('PeakWorkingSet64 增幅 < 32 MiB（峰值口径，抓"曾经整份读入"）', dpeak < 32 * MiB, '+' + (dpeak / MiB).toFixed(1) + ' MiB');
      A('对照：本用例真的请求过 64 MiB 的文件（否则内存断言无意义）', fs.statSync(path.join(LIB, 'big.jpg')).size === BIG, '');
    }

    console.log('\n══ ⑥ 阴性自证：把上限判据掏成"旧行为（无上限）"⇒ 同一请求不再 413 ══');
    {
      /* 只改一处：`st.size > MAX_STATIC_BYTES` → `false`（等价于改前"没有上限"）。
         不真的跑 256 MiB 整份读入（那会把测试机的内存打满），只证明"413 是判据给的"。 */
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-stream-mut-'));
      fs.mkdirSync(path.join(dir, 'src', 'tools'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src', 'app'), { recursive: true });
      for (const f of fs.readdirSync(path.join(ROOT, 'src', 'tools'))) {
        fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(dir, 'src', 'tools', f));
      }
      fs.copyFileSync(path.join(ROOT, 'src', 'app', 'index.html'), path.join(dir, 'src', 'app', 'index.html'));
      const p = path.join(dir, 'src', 'tools', '_服务端.mjs');
      const src = fs.readFileSync(p, 'utf8');
      const from = 'if (st.size > MAX_STATIC_BYTES) {';
      if (!src.includes(from)) throw new Error('阴性自证无效：源码里找不到上限判据 ' + JSON.stringify(from));
      fs.writeFileSync(p, src.split(from).join('if (false) {'), 'utf8');
      const mut = startServerAt(p, PORT + 1, LIB);
      try {
        if (!await waitHealth(PORT + 1)) {
          A('替身实例启动（无上限）', false, 'health 超时；stderr=' + mut.err.slice(0, 200));
        } else {
          A('替身实例启动（仅掏掉上限判据）', true);
          const r = await req(PORT + 1, '/big.jpg', { headers: { Range: 'bytes=0-9' }, timeoutMs: 120000 });
          A('替身：同一文件回 206 而不是 413（证明 413 有牙齿）', r.status === 206, 'status=' + r.status + ' CR=' + r.headers['content-range']);
          A('替身：正文 10 字节', r.text.length === 10, 'len=' + r.text.length);
          A('对照：真源码同一请求回 413', (await req(PORT, '/big.jpg', { headers: { Range: 'bytes=0-9' }, timeoutMs: 60000 })).status === 413, '');
        }
      } finally {
        await mut.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    code = end('R7 静态流式 + 64 MiB 上限 + Range');
  } finally {
    await srv.stop();
    fs.rmSync(LIB, { recursive: true, force: true });
  }
  process.exit(code);
})().catch(e => {
  console.error('FATAL ' + (e && e.stack || e));
  try { fs.rmSync(LIB, { recursive: true, force: true }); } catch (x) { }
  process.exit(1);
});
