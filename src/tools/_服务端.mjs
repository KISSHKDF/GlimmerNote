#!/usr/bin/env node
/**
 * 错题本 · 本机服务端（v3，2026-10-07）
 *
 * 双形态架构中的「网络通道」，同时是桌面壳的后端备胎：
 *   - 浏览器：http://127.0.0.1:7187/ 直接打开首页（运行时取数，不再是静态内嵌）
 *   - 桌面壳：WebView2 优先走 postMessage 直连；服务端不在时桌面壳自己兜底（见壳源码）
 *
 * 接口：
 *   GET  /                → 首页.html（静态）
 *   GET  /api/state       → _状态.json 原文（页面启动/刷新数据用；?section=pending 只刷 pending 分区）
 *   POST /api/state       → 触发全量重建（重跑生成器），返回新状态包
 *   POST /api/pending     → {resolves:[{id,action,answer}]} 办结落库（幂等）+ 刷 pending 分区，返回新状态包
 *   GET  /health          → 存活探针
 *   GET  /*               → 题库根目录静态文件（证据图、题干等相对 URI）
 *
 * 安全：只绑 127.0.0.1；CORS 只回显白名单来源（绝不发 `*`）；`X-Frame-Options: DENY` +
 *       CSP `frame-ancestors 'none'` 防被嵌 iframe；POST 只收 `application/json`（BUG-17 受限加固，
 *       残余风险与"为什么不直接上 token"见 docs\修复说明-服务端-20261011.md §4）；
 *       无独立写盘（全委托既有工具）；写操作（pending/rebuild）串行化防多会话并发互踩。
 *       `GET /api/state` **只读**：pending 分区按 `_待确认.json` 的 mtime/size 判断，没变就不 spawn、不写盘（BUG-16）。
 *
 * 替换关系：本文件取代 _办结监听.mjs（计划任务 CTB-PendingSync 已改指本文件）。
 */
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { libraryRoot, toolPath, TOOL_DIR, APP_ROOT, WEB_ROOT } from './_库根.mjs';
import { readJsonStrict } from './_安全写.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 现在是**用户库根**，不再是"本脚本所在目录"。
   兄弟工具一律用 toolPath(...)，见 _库根.mjs。 */
const ROOT = libraryRoot();
/* 端口默认 7187（计划任务与页面都指这里）。`CTB_PORT` 只为回归用例起**独立实例**用：
   本文件不负责重启用户正在跑的服务端，断言必须能另起一个进程、另用一个端口。 */
const PORT = Number(process.env.CTB_PORT) || 7187;
const TOOL = toolPath('_待确认.mjs');
const REFRESH = toolPath('_状态刷新.mjs');
const GEN_MJS = toolPath('生成状态.mjs');
const GEN_PS1 = toolPath('_生成首页.ps1');
/* ★ 2026-10-23：程序文件在 AppRoot，用户数据在库根 —— 静态服务要两头都认。 */
/* 界面根 = 真有 index.html 的那个目录（包内 = AppRoot；开发区 = AppRoot\app） */
const APP = WEB_ROOT;
const STATE = path.join(ROOT, '_状态.json');
const PENDING = path.join(ROOT, '_待确认.json');

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif',
  '.webp':'image/webp', '.pdf':'application/pdf', '.md':'text/markdown; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };

/* BUG-15（2026-10-11）：裸 `JSON.parse(fs.readFileSync(p,'utf8'))` **不剥 BOM**——
   `_状态.json` 一旦被带 BOM 的通道改写一次，这里三处读取全部抛错，而两处 catch 是静默的
   （表现为 `{error:'no state'}`，看不出是 BOM）。统一走 `_安全写.mjs` 的 readJsonStrict（剥 BOM）。
   注：本文件对 `_状态.json` 是**只读**（写盘一律委托 `_状态刷新.mjs`/生成器）。 */
function readStateFile() { return readJsonStrict(STATE, { label: '_状态.json' }); }
function parseJsonText(text, what) {
  try { return JSON.parse(String(text).replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error((what || 'JSON') + ' 解析失败：' + e.message); }
}

let state = null;
try { state = readStateFile(); } catch (e) { state = null; }

/* ---------- 静态文件包含性判据（BUG-18） ----------
   旧写法 `abs.startsWith(ROOT)` 的 ROOT 无结尾分隔符 ⇒ `D:\…\错题本-备份` 这类**同前缀兄弟目录**
   能通过判据（实测：`/..%2f错题本-ntest%2fsecret.txt` 返回 404 而不是 403，说明判据已放行到 fs.readFile）。
   现在：`path.normalize(path.join(...))` 做归一化（与 .NET `Path.Combine` + `Path.GetFullPath` 同族），
   再按 **`ROOT + path.sep`** 前缀比较（盘符/大小写不敏感，与 Windows 文件系统一致），并允许恰好等于 ROOT。
   ⚠ 刻意不用 `path.resolve(ROOT, rel)`：Windows 上 `resolve('D:\…\错题本', '/首页.html')` = `D:\首页.html`，
   会把**正常**请求判成越界（实测），等于把整站静态文件打掉。 */
const ROOT_BASE = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
function insideRoot(abs) {
  const a = path.normalize(String(abs)).toLowerCase();
  return a === path.normalize(ROOT).toLowerCase() || a.startsWith(ROOT_BASE.toLowerCase());
}
/* ★ 2026-10-23：程序目录的包含性判据（与库根**各判各的**，互不放行）。
   静态服务先查程序目录（index.html / css / js），再查库根（原卷截图 / 题干.html 等用户数据）。 */
const APP_BASE = APP.endsWith(path.sep) ? APP : APP + path.sep;
function insideApp(abs) {
  const a = path.normalize(String(abs)).toLowerCase();
  return a === path.normalize(APP).toLowerCase() || a.startsWith(APP_BASE.toLowerCase());
}

/* ---------- 写操作串行化 ---------- */
let chain = Promise.resolve();
function serialized(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

function runTool(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let out = '', err = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch (e) {} resolve({ code: 124, out, err: err + '\n[timeout]' }); } }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out, err: String(e) }); } });
    p.on('close', code => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}
function runGen(timeoutMs = 180000) {
  return new Promise((resolve) => {
    /* ★ 2026-10-23：优先跑 Node 生成器（生成状态.mjs）；没有才退回 PowerShell 版。
       cwd 用库根，并显式传 CTB_DATA —— 生成器据此确定"读哪个库、写哪个状态包"。 */
    const useNode = fs.existsSync(GEN_MJS);
    const p = useNode
      ? spawn(process.execPath, [GEN_MJS], { cwd: ROOT, windowsHide: true, env: Object.assign({}, process.env, { CTB_DATA: ROOT }) })
      : spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GEN_PS1], { cwd: ROOT, windowsHide: true });
    let out = '', err = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch (e) {} resolve({ code: 124, out, err: err + '\n[timeout]' }); } }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out, err: String(e) }); } });
    p.on('close', code => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}

/* ---------- BUG-16：pending 分区按需刷新 ----------
   `GET /api/state` 的语义是"读状态"，但旧代码每次都 spawn `_状态刷新.mjs pending`，
   把 1.35 MB 的 `_状态.json` **整体重写一遍**（连页面刷新都在放大 BUG-01 的中断窗口）。
   现在：先比 `_待确认.json` 的 mtime/size 与状态包里记录的 `_pendingSrc`（`_状态刷新.mjs` 落的指纹），
   没变就不 spawn、不写盘；变了才刷（`pending-if-stale` 子支再用内容哈希复核一次，杜绝"只改了 mtime"的假刷新）。 */
function pendingStat() {
  try { const st = fs.statSync(PENDING); return { mtimeMs: st.mtimeMs, size: st.size }; }
  catch (e) { return null; }
}
function pendingNeedsRefresh() {
  const cur = pendingStat();
  if (!cur) return false;                        // 台账读不到（异常）→ 不去折腾状态包
  const rec = state && state._pendingSrc;
  if (rec && rec.mtimeMs === cur.mtimeMs && rec.size === cur.size) return false;
  return true;                                   // 无记录（生成器刚重写过状态包）一律算过期：宁可多刷一次，绝不漏
}
function refreshPendingSection() {
  // `pending-if-stale`：重跑门禁 --json，替换 _状态.json 的 pending 分区，stdout=新状态包（未变则原样回）
  const out = execFileSync(process.execPath, [REFRESH, 'pending-if-stale'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  state = parseJsonText(out, '_状态刷新 输出');
  try { state._diskM = fs.statSync(STATE).mtimeMs; } catch (e) {}
}

async function doResolve(list) {
  return serialized(async () => {
    const tmp = path.join(os.tmpdir(), 'ctb-pending-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ exportedAt: new Date().toISOString(), tool: 'ctb-homepage-pending', resolves: list }), 'utf8');
    try {
      const r = await runTool([TOOL, '同步', '--file', tmp]);
      if (r.code !== 0) return { ok: false, toolOut: String(r.out || '').slice(-1200), toolErr: String(r.err || '').slice(-400) };
      refreshPendingSection();
      const results = [];
      for (const line of String(r.out || '').split(/\r?\n/)) {
        const m = line.match(/[✔↔✖]\s*(T\d+)/);
        if (m) results.push({ id: m[1], status: line.includes('↔') ? 'skipped' : (line.includes('✖') ? 'missing' : 'ok'), line: line.trim() });
      }
      return { ok: true, results, state };
    } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  });
}

async function doRebuild() {
  return serialized(async () => {
    const r = await runGen();
    if (r.code !== 0) return { ok: false, toolOut: String(r.out || '').slice(-800), toolErr: String(r.err || '').slice(-400) };
    try { state = readStateFile(); } catch (e) {}
    return { ok: true, state };
  });
}

/* ---------- 响应头：安全加固 + CORS 白名单（BUG-17） ----------
   改前：**所有**响应都发 `Access-Control-Allow-Origin: *`，且 `Origin: null` 直接放行 ⇒
   本机任意网页（或它内嵌的 `<iframe sandbox>`，其源是不透明源，发出的 `Origin` 也是 `null`）
   都能读走状态包、并 `POST /api/pending` 往人工判读真源里写内容（改前实测：`Origin: null` 的 POST = HTTP 200）。
   现在（**不引入 token**，理由与残余风险见修复说明 §4）：
     ① 发 `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`：本服务自己的页面不得被任何页面嵌 iframe；
     ② CORS 只回显白名单来源（`http://127.0.0.1:PORT` / `http://localhost:PORT`）与 file:// 客户端的 `null`，
        **绝不再发通配 `*`**；无 Origin 的同源/非浏览器客户端不需要 ACAO；
     ③ POST `/api/pending` 只收 `Content-Type: application/json`（实测现有两个客户端 v1 首页 `syncPend`、
        v2 `host.js pendingResolve` 都带这个头），`fetch` 默认的 `text/plain` 与表单式跨源简单请求一律 415。 */
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT]);
function corsOrigin(origin) {
  if (!origin) return null;                            // 同源 / 非浏览器客户端：不需要 ACAO
  if (ALLOWED_ORIGINS.has(origin)) return origin;       // 回显具体来源（不用 '*'，也就不会带上 cookie 语义）
  if (origin === 'null') return 'null';                 // file:// 客户端；⚠ 与 sandboxed iframe 的不透明源不可区分 → 残余风险
  return null;
}
function addCommonHeaders(res, origin) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const ao = corsOrigin(origin);
  if (ao) { res.setHeader('Access-Control-Allow-Origin', ao); res.setHeader('Vary', 'Origin'); }
}
function send(res, code, body, type, origin) {
  addCommonHeaders(res, origin);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}
function sendJson(res, code, obj, origin) { send(res, code, JSON.stringify(obj), undefined, origin); }

function serveStatic(req, res, urlPath, origin) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad path' }, origin); }
  /* NUL 与 `:`（NTFS 文件名里不可能出现，出现只可能是构造）一律拒掉，别把怪路径喂给 fs */
  if (rel.includes('\0') || rel.includes(':')) return sendJson(res, 400, { ok: false, error: 'bad path' }, origin);
  if (rel === '/' || rel === '') rel = '/index.html';
  /* BUG-18 修：`path.normalize(path.join(...))` + 带尾分隔符的前缀比较。
     裸 `startsWith(ROOT)` 会让 `…\错题本-备份\secret.txt` 这类同前缀兄弟目录通过判据。
     ★ 2026-10-23 程序与数据分家：先认**程序目录**（index.html / css / js 在 AppRoot），
       再认**库根**（原卷截图、题干.html 等用户数据）。两边各自做包含性校验，互不放行。 */
  const absApp = path.normalize(path.join(APP, rel));
  const absLib = path.normalize(path.join(ROOT, rel));
  let abs = null;
  if (insideApp(absApp) && fs.existsSync(absApp)) abs = absApp;
  else if (insideRoot(absLib)) abs = absLib;
  else return sendJson(res, 403, { ok: false, error: 'forbidden' }, origin);
  fs.readFile(abs, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'not found: ' + rel }, origin);
    send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', origin);
  });
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > limit) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (origin && corsOrigin(origin) === null) {
    return sendJson(res, 403, { ok: false, error: 'forbidden origin' }, origin);
  }
  if (req.method === 'OPTIONS') {
    addCommonHeaders(res, origin);
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
    return res.end();
  }
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && u.pathname === '/health') return sendJson(res, 200, { ok: true, port: PORT, version: 3, hasState: !!state, generatedAt: state && state.generatedAt }, origin);
    if (req.method === 'GET' && u.pathname === '/api/state') {
      /* BUG-16 修：GET **只读**。
         ① 磁盘 `_状态.json` 比内存快照新（别的会话重跑了生成器）→ 纯读换内存，不写盘；
         ② pending 分区：只有 `_待确认.json` 的 mtime/size 变过才 spawn `_状态刷新.mjs pending-if-stale`
            （子支再用内容哈希复核），没变则连 node 进程都不起、更不重写 1.35 MB 状态包。
         `?section=pending` 的调用方语义不变：台账变过就一定刷，拿到的是最新 pending。 */
      try {
        const diskM = fs.statSync(STATE).mtimeMs;
        if (diskM > (state?._diskM || 0)) {
          state = readStateFile();
          state._diskM = diskM;
        }
      } catch (e) {}
      if (pendingNeedsRefresh()) {
        await serialized(async () => { if (pendingNeedsRefresh()) refreshPendingSection(); });
      }
      return sendJson(res, 200, state || { error: 'no state' }, origin);
    }
    if (req.method === 'POST' && u.pathname === '/api/state') {
      const r = await doRebuild();
      return sendJson(res, r.ok ? 200 : 500, r.ok ? r.state : r, origin);
    }
    if (req.method === 'POST' && u.pathname === '/api/pending') {
      /* 最小可行鉴别（BUG-17）：只收 JSON 体。表单/`<img>` 之类的"简单请求"跨源伪造没有预检，
         这条能挡住；`fetch` 默认的 text/plain 也挡住。现有客户端两个都带 application/json，不受影响。 */
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype !== 'application/json') {
        return sendJson(res, 415, { ok: false, error: 'unsupported media type（POST /api/pending 只收 application/json）' }, origin);
      }
      let body;
      try { body = parseJsonText(await readBody(req), '请求体'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }, origin); }
      const list = (Array.isArray(body && body.resolves) ? body.resolves : []).filter(r => r && r.id && (r.action === '答' || r.action === '作废'));
      if (!list.length) return sendJson(res, 400, { ok: false, error: 'resolves empty or malformed' }, origin);
      const r = await doResolve(list);
      return sendJson(res, r.ok ? 200 : 500, r, origin);
    }
    if (req.method === 'GET') return serveStatic(req, res, u.pathname, origin);
    return sendJson(res, 404, { ok: false, error: 'not found' }, origin);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e && e.message || e) }, origin);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[ctb-server] http://127.0.0.1:' + PORT + '  root=' + ROOT + '  state=' + (state ? state.generatedAt : 'MISSING(will rebuild on first /api/state)'));
});
