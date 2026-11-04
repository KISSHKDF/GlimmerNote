#!/usr/bin/env node
/**
 * R8 整改①（2026-11-03）· 程序页 CSP 后备的机读对拍 + 真服务端行为断言
 *
 * 缺陷（R8-安全三面复核.md §一缺口5）：程序页纵深只有一层 —— APP_CSP 只有 frame-ancestors、
 * index.html 无 meta CSP、壳模式（file://）连响应头都没有 ⇒ 程序页防"库内容执行脚本"完全
 * 押在 M.stemHtmlSafe 一个函数上（历史已两次被绕过：S01 出口直通、S04 CSS 转义），
 * 而页面里有 window.ctbHost（壳桥）。
 *
 * 修法：响应头（服务端模式）+ 页面 meta（两种模式都生效）**两份同内容** CSP，
 * 内容为最小可用集（default-src 'none' + 逐类开口，判据逐条见 _服务端.mjs 的 APP_CSP 注释）。
 *
 * 本用例守四条：
 *   ① 头与 meta **逐字相等**（改一处忘另一处 = 立即红；这是两份真相源的机读对拍）；
 *   ② 内容下限：default-src 'none' / script-src 无 unsafe-inline / frame-ancestors 在场 ——
 *     防"为了省事把 script-src 放宽成 unsafe-inline"式的倒退；
 *   ③ 行为：真起一个服务端实例，GET /index.html 的 CSP 响应头逐字等于 APP_CSP、
 *     且页面正文里 meta 在 </head> 之前（先于任何脚本装载）；
 *   ④ 阴性自证：源码级替身把 APP_CSP 掏回旧值 `frame-ancestors 'none'` ⇒ ③ 必须红（判据有牙齿）。
 *
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, req, waitHealth } = require('./neg-server-lib.cjs');

let pass = 0, fail = 0;
const A = (n, ok, d) => { pass++; if (!ok) fail++; console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + n + (d !== undefined ? '  → ' + String(d).slice(0, 200) : '')); };

/* ── 抽 APP_CSP（唯一实现：_服务端.mjs 的常量；用括号配对拼出真实串） ──
   ⚠ 不能用 [^;]+ 抓到第一个分号 —— CSP 串**内部**就有分号。按"若干个双引号串用 + 连接"抓。 */
const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_服务端.mjs'), 'utf8');
const mDecl = /const APP_CSP = ((?:"[^"]*"\s*\+\s*)*"[^"]*")\s*;/.exec(srvSrc);
A('从 _服务端.mjs 抽到 APP_CSP 声明', !!mDecl);
let APP_CSP = '';
try { APP_CSP = eval(mDecl[1]); } catch (e) { A('APP_CSP 表达式可求值', false, e.message); }
A('APP_CSP 非空', APP_CSP.length > 40, APP_CSP.slice(0, 80));

/* ── 抽 index.html 的 meta CSP ── */
const idxSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'index.html'), 'utf8');
const mMeta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/.exec(idxSrc);
A('index.html 有 CSP meta', !!mMeta);
const META = mMeta ? mMeta[1] : '';

console.log('\n══ ① 头与 meta 逐字相等（两份真相源的对拍）══');
A('meta content === APP_CSP（逐字）', META === APP_CSP,
  '头=' + JSON.stringify(APP_CSP.slice(0, 90)) + ' meta=' + JSON.stringify(META.slice(0, 90)));

console.log('\n══ ② 内容下限（防倒退）══');
A("default-src 'none' 在场（fail-closed 写法）", APP_CSP.includes("default-src 'none'"));
A("script-src 存在且不含 unsafe-inline（程序页没有内联脚本；放宽即倒退）",
  /script-src [^;]+/.test(APP_CSP) && !/script-src[^;]*unsafe-inline/.test(APP_CSP), APP_CSP);
A("object-src 'none' / base-uri 'none' / form-action 'none' 在场",
  APP_CSP.includes("object-src 'none'") && APP_CSP.includes("base-uri 'none'") && APP_CSP.includes("form-action 'none'"));
A("frame-ancestors 'none' 保留", APP_CSP.includes("frame-ancestors 'none'"));
A('meta 位于 </head> 之前（先于任何脚本装载）',
  idxSrc.indexOf('Content-Security-Policy') < idxSrc.search(/<\/head\s*>/i));

console.log('\n══ ③ 行为：真服务端的 /index.html 响应头逐字等于 APP_CSP ══');
const PORT = 18041;
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-csp-lib-'));
const MUT_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-csp-mut-'));
function startServerAt(serverJs, port) {
  const proc = spawn(process.execPath, [serverJs], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: LIB }),
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
/* 源码级替身：把 APP_CSP 掏回 R8 整改前的旧值（阴性自证的唯一变量） */
function makeOldCspRepo() {
  const repo = path.join(MUT_REPO, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'app'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'tools'))) {
    fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(repo, 'src', 'tools', f));
  }
  fs.copyFileSync(path.join(ROOT, 'src', 'app', 'index.html'), path.join(repo, 'src', 'app', 'index.html'));
  const p = path.join(repo, 'src', 'tools', '_服务端.mjs');
  const src = fs.readFileSync(p, 'utf8');
  const at = src.indexOf('const APP_CSP = ');
  if (at < 0) throw new Error('替身无效：找不到 APP_CSP 声明');
  /* 语句以 `";` 结束（CSP 串内部有分号，不能找第一个分号） */
  const end = src.indexOf('";', at);
  if (end < 0) throw new Error('替身无效：找不到 APP_CSP 声明结束');
  fs.writeFileSync(p, src.slice(0, at) + "const APP_CSP = \"frame-ancestors 'none'\"" + src.slice(end + 1), 'utf8');
  return path.join(repo, 'src', 'tools', '_服务端.mjs');
}
(async () => {
  const srv = startServerAt(path.join(ROOT, 'src', 'tools', '_服务端.mjs'), PORT);
  let code = 1;
  try {
    if (!await waitHealth(PORT)) {
      A('被测实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；stderr=' + srv.err.slice(0, 300));
      process.exit(1);
    }
    const r = await req(PORT, '/index.html');
    A('GET /index.html → 200', r.status === 200, 'status=' + r.status);
    A('CSP 响应头逐字等于 APP_CSP', String(r.headers['content-security-policy']) === APP_CSP,
      String(r.headers['content-security-policy']).slice(0, 120));
    A('页面正文里的 meta 与响应头同串',
      String(r.text).includes('content="' + META + '"') || (META && String(r.text).indexOf(META) >= 0));

    console.log('\n══ ④ 阴性自证：掏回旧值 ⇒ 行为断言必须红 ══');
    const mutJs = makeOldCspRepo();
    const mut = startServerAt(mutJs, PORT + 1);
    try {
      if (!await waitHealth(PORT + 1)) {
        A('替身实例启动', false, 'health 超时');
      } else {
        const old = await req(PORT + 1, '/index.html');
        A('替身：CSP 头 = 旧值 frame-ancestors \'none\'（对照的唯一变量）',
          String(old.headers['content-security-policy']) === "frame-ancestors 'none'",
          String(old.headers['content-security-policy']));
        A('真源码下同一请求是完整 APP_CSP（证明差别只来自判据）',
          String((await req(PORT, '/index.html')).headers['content-security-policy']) === APP_CSP);
      }
    } finally { await mut.stop(); }
    code = fail ? 1 : 0;
  } finally {
    await srv.stop();
    try { fs.rmSync(LIB, { recursive: true, force: true }); } catch (e) { }
    try { fs.rmSync(MUT_REPO, { recursive: true, force: true }); } catch (e) { }
  }
  console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + pass);
  process.exit(code);
})().catch(e => {
  console.error('FATAL ' + (e && e.stack || e));
  try { fs.rmSync(LIB, { recursive: true, force: true }); } catch (x) { }
  try { fs.rmSync(MUT_REPO, { recursive: true, force: true }); } catch (x) { }
  process.exit(1);
});
