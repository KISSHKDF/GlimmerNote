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
 * ★ 2026-10-29 R2 安全整改（审计 H-08，两条都是审计员用**原始 socket** 独立复现的，
 *   逐字证据见 work\std-check\R2-20261029\reports\R2-C-sec.md §H-08）：
 *   ① 请求入口整体进 try/catch：改前 `new URL(req.url, …)`（连同 Origin / OPTIONS 两段）在 try
 *      **之外** ⇒ `GET //[` 这类畸形 request-target 抛 ERR_INVALID_URL，在 async handler 里就是一次
 *      **unhandled rejection** ⇒ **整个服务进程 exit=1**（审计实测 8 种 target 全部打挂；浏览器侧
 *      `new URL("http://127.0.0.1:7187//[")` 是**合法**的，pathname 正是 `//[`，所以本机网页能构造）。
 *      现在畸形 target 回 400；另加 `process.on('unhandledRejection')` 作第二道网（只记日志，不掩盖）。
 *   ② 静态文件在读盘**前**解析重解析点：改前判据是纯字符串前缀比较（`path.normalize` **不解析**
 *      NTFS junction / symlink），而 `fs.readFile` **会跟随**它 ⇒ 库内 `link → C:\Windows` 时
 *      `GET /link/win.ini` 返回 200 读出库外文件。现在对 `fs.realpathSync(abs)` 的结果**重跑**同一套判据。
 *   ③ 写操作（`POST /api/pending`、`POST /api/state`，含它们的 OPTIONS 预检）不再回显
 *      `Access-Control-Allow-Origin: null`：改前不透明源（`<iframe sandbox>` 的 Origin 就是 `null`）
 *      能穿过来源门禁 + 宽松预检 + "只收 JSON"三道，直达 doResolve 落库。读路径不变（file:// 取数仍可用）。
 *      **取舍**：file:// 页面在 server 模式下的**写**路径会被浏览器 CORS 拦下（它要 ACAO=null）；
 *      桌面壳走 postMessage 直连、`http://127.0.0.1:PORT` 同源页面都不受影响。彻底解法是给写路径加
 *      一次性 token 握手（本轮不做，属后续工作）。
 *   ④ 失败必须说失败（两处原静默降级）：`doRebuild` 在"生成器成功但新状态包读不出"时不再吞异常回
 *      `ok:true`；`GET /api/state` 在读不到 `_待确认.json` 时不再静默返回过期 pending，改带
 *      `degraded` / `pendingStale` 标记。
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
/* 端口真源（2026-10-29 R2 SC-09）：程序根 `端口.json` 的 `default` —— 与 C# 壳的
   `CTBShellV2.cs::ResolveSrvPort`（读 `AppRoot\端口.json`）**同源**；前端由壳注入
   `window.__ctbPortDefault` + hello 回执拿到同一个值。`CTB_PORT` 环境变量**优先**，
   它只为回归用例起独立实例用（`tests\_测试环境.cjs`），日常不要设。
   ⚠ "程序根"在两种布局下**不是同一个 JS 常量**，所以按候选序找：
     · 发布包：`<AppRoot>\index.html` + `<AppRoot>\tools\*.mjs` ⇒ APP_ROOT = WEB_ROOT = AppRoot；
     · 开发区：`<仓库>\src\app\index.html` + `<仓库>\src\tools\*.mjs` ⇒ WEB_ROOT = `src\app`
       （**这才等于 C# 的 AppRoot** —— 壳 exe 就在 `src\app\` 下），而 APP_ROOT = `src`。
   所以主候选是 WEB_ROOT、APP_ROOT 兜底。（照抄成 `path.join(APP_ROOT, …)` 会让开发区
   去 `src\端口.json` 找一个不存在的文件 —— 我实测过，那会让服务端起不来。）
   读不到 ⇒ **exit 2**，绝不静默回退 7187："各处各写一份默认值"正是 SC-09 这条缺陷的根因。 */
const PORT_FILE_CANDS = [path.join(WEB_ROOT, '端口.json'), path.join(APP_ROOT, '端口.json')]
  .filter((p, i, a) => a.indexOf(p) === i);
function resolvePort() {
  const env = String(process.env.CTB_PORT == null ? '' : process.env.CTB_PORT).trim();
  if (env) {
    if (!/^[0-9]{1,5}$/.test(env) || Number(env) < 1 || Number(env) > 65535) {
      console.error('[ctb-server] ✖ CTB_PORT 不是合法端口号：' + JSON.stringify(env) + '（期望 1~65535 的十进制整数）');
      process.exit(2);
    }
    return Number(env);
  }
  const tried = [];
  for (const p of PORT_FILE_CANDS) {
    if (!fs.existsSync(p)) { tried.push(p + ' —— 不存在'); continue; }
    let j;
    try { j = readJsonStrict(p, { label: '端口.json' }); }
    catch (e) { tried.push(p + ' —— 读不出：' + e.message); continue; }
    const n = Number(j && j.default);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      tried.push(p + ' —— default 不是 1~65535 的整数：' + JSON.stringify(j && j.default));
      continue;
    }
    return n;
  }
  console.error('[ctb-server] ✖ 端口真源读不到，**拒绝启动**（不猜默认端口）：\n  ' + tried.join('\n  ') +
    '\n  修法：在程序根放一份 端口.json（形状见 src\\app\\端口.json），或用 CTB_PORT 显式指定。');
  process.exit(2);
}
/* 端口默认 7187 由 `端口.json` 提供（不再写死在这里）。`CTB_PORT` 只为回归用例起**独立实例**用：
   本文件不负责重启用户正在跑的服务端，断言必须能另起一个进程、另用一个端口。 */
const PORT = resolvePort();
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
/* 一个根 = 一个判据工厂：`path.normalize` 归一化 + **带尾分隔符**的前缀比较
   （盘符/大小写不敏感，与 Windows 文件系统一致），并允许恰好等于根本身。 */
function makeInside(base) {
  const b = path.normalize(String(base)).toLowerCase();
  const bs = b.endsWith(path.sep) ? b : b + path.sep;
  return abs => { const a = path.normalize(String(abs)).toLowerCase(); return a === b || a.startsWith(bs); };
}
const insideRoot = makeInside(ROOT);
/* ★ 2026-10-23：程序目录的包含性判据（与库根**各判各的**，互不放行）。
   静态服务先查程序目录（index.html / css / js），再查库根（原卷截图 / 题干.html 等用户数据）。 */
const insideApp = makeInside(APP);
/* ★ R2 H-08-B（2026-10-29）：上面两条判据**都是纯字符串**比较，而 `path.normalize` **不解析**
   NTFS 重解析点（junction / symlink），`fs.readFile` 却**会跟随**它 ⇒ "路径字符串在库内"与
   "实际读到的文件在库外"可以同时成立（审计实测：库内 `mklink /J link C:\Windows` 后
   `GET /link/win.ini` 返回 200 并读出库外内容）。
   现在多一道：读盘前 `fs.realpathSync(abs)`，再对**解析后的真实路径**重跑同一套判据。
   ⚠ 两个坑必须一起处理，否则会修出更坏的 bug：
     ① realpath 对**不存在**的路径会抛 ⇒ 调用方先 try，抛了按 404 处理（与旧行为一致，
        "缺文件"与"越界"不能混为一谈）；
     ② realpath 会把**根自己**也解析掉 —— 迁移期库根很可能就是个 junction（`<AppRoot>\..\数据`
        就常是），只比 `insideRoot(real)` 会把**所有正常请求**判成越界、整站静态文件全 403。
        所以真值判据是：落在 {ROOT, APP, realpath(ROOT), realpath(APP)} **任一根**之内。
        （这一条是审计给的最小修法里没有的，本机布局必须补。） */
const realOr = p => { try { return fs.realpathSync(p); } catch (e) { return p; } };
const insideRealRoot = makeInside(realOr(ROOT));
const insideRealApp = makeInside(realOr(APP));

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
/* ★ R2 H-08-D（2026-10-29）：改前 `pendingStat()` 返回 null（台账 stat 不到）时让
   `pendingNeedsRefresh()` 直接 `return false` ⇒ 响应是 **200 + 旧的 pending 分区**，
   调用方完全看不出这是降级（"失败必须说失败"被违反）。现在把三态显式化，
   `unreadable` 一路带到响应体（`GET /api/state` 的 `degraded` / `pendingStale` 标记）。 */
function pendingFreshness() {
  let st;
  try { st = fs.statSync(PENDING); }
  catch (e) { return { status: 'unreadable', error: String((e && e.message) || e) }; }
  const rec = state && state._pendingSrc;
  if (rec && rec.mtimeMs === st.mtimeMs && rec.size === st.size) return { status: 'fresh' };
  return { status: 'stale' };   // 无记录（生成器刚重写过状态包）一律算过期：宁可多刷一次，绝不漏
}
function pendingNeedsRefresh() { return pendingFreshness().status === 'stale'; }
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
    /* ★ R2 H-08-D（2026-10-29）：改前这里是 `try { state = readStateFile(); } catch (e) {}`
       —— 生成器**明明跑成功了**，但新的状态包读不出（半截 JSON / BOM 之外的损坏 / 权限）时
       异常被静默吞掉，然后 `return { ok:true, state }` 把**旧的内存快照**当成功结果交出去：
       前端收到 ok:true + 一份**过期**状态包，界面上看不出任何异常（"失败必须说失败"被违反）。
       现在读不出就是失败，并明确区分"磁盘已重建好"与"服务端读不出来"。 */
    let fresh;
    try { fresh = readStateFile(); }
    catch (e) {
      return {
        ok: false, degraded: 'state-unreadable',
        error: '生成器已重跑成功，但新的状态包读不出来：' + String((e && e.message) || e),
        toolOut: String(r.out || '').slice(-800), toolErr: String(r.err || '').slice(-400),
      };
    }
    state = fresh;
    /* 重建后内存快照就是磁盘那份 ⇒ 顺手记下 mtime，免得紧接着的 GET 又白读一次（BUG-16 同一口径） */
    try { state._diskM = fs.statSync(STATE).mtimeMs; } catch (e) {}
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
  /* ★ R2 H-08-B：读盘**之前**解析重解析点，并对解析后的真实路径重跑包含性判据。
     顺序很关键：realpath 必须早于 readFile —— `fs.readFile` 会跟着 junction/symlink 走，
     而 `path.normalize` 不会，两者之间的落差就是漏洞本身。 */
  let real;
  try { real = fs.realpathSync(abs); }
  catch (e) {
    /* realpath 对不存在的路径抛 ENOENT；语义与旧代码的 readFile→404 一致（"缺文件"≠"越界"） */
    return sendJson(res, 404, { ok: false, error: 'not found: ' + rel }, origin);
  }
  if (!insideApp(real) && !insideRoot(real) && !insideRealApp(real) && !insideRealRoot(real)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden (link outside root)' }, origin);
  }
  fs.readFile(real, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'not found: ' + rel }, origin);
    send(res, 200, buf, MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', origin);
  });
}

/* ★ R2 H-08-E（2026-10-29）：改前 `readBody` 超限一律 `req.destroy()` ⇒ 客户端看到的是
   **ECONNRESET**（审计逐字：`3MB body -> ERR read ECONNRESET`），而不是一个能读的 413；
   而且没有 `Content-Length` 预检 —— 必须先把 body 缓冲到 200 万才发现，而那个 200 万是
   字符串 `.length`（**UTF-16 码元数**），中文下与真实字节数不等（2 万汉字 ≈ 6 万字节却只算 2 万）。
   现在：① 先看 `Content-Length`，明知超限**立刻**回 413（不吃 body）；
        ② 边收边按 **Buffer.length（字节）** 计；
        ③ 超限时不再 destroy —— 把错误交给调用方，由它回 413（响应先落盘，客户端就不会只看到断连）。 */
const MAX_BODY = 2 * 1024 * 1024;   // 2 MiB，按**字节**
function tooLargeError(limit, got) {
  const e = new Error('payload too large（上限 ' + limit + ' 字节' + (got == null ? '' : '，实际 ' + got + ' 字节') + '）');
  e.code = 'ETOOLARGE'; e.limit = limit; e.got = got;
  return e;
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length']);
    if (Number.isFinite(cl) && cl > limit) { reject(tooLargeError(limit, cl)); return; }
    const chunks = [];
    let n = 0;
    req.on('data', d => {
      n += d.length;                                   // Buffer.length = 字节
      if (n > limit) { try { req.pause(); } catch (e) {} reject(tooLargeError(limit, n)); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ★ R2 H-08-A（2026-10-29）：畸形 request-target 的**第二道网**。
   第一道网是下面 handler 里把整段入口放进 try（畸形 target 回 400，进程不受影响）；
   这一道只保证"将来某个未知的 rejection 不会把用户正在用的服务整体打挂"，并**大声记日志**。
   为什么必须有它：审计实测改前 `GET //[`（原始 socket）让进程 `exited=1` —— 一个坏请求 = 整站下线。 */
process.on('unhandledRejection', (e) => {
  console.error('[ctb-server] ⚠ unhandledRejection（第二道网接住，服务继续；但这条必须查）:',
    (e && (e.stack || e.message)) || e);
});

/* ★ R2 H-08-C：写路径集合。这些路径上的**非 GET** 操作（含 OPTIONS 预检）不再回显
   `Access-Control-Allow-Origin: null` —— 否则不透明源（`<iframe sandbox>` 的 Origin 就是 null）
   能在预检阶段拿到放行，然后带着 `application/json` 穿过来源门禁直达 doResolve 落库。
   按"路径 + 方法"分而不是只按路径：`GET /api/state`（file:// 客户端取数）必须保持原样。 */
const WRITE_PATHS = new Set(['/api/pending', '/api/state']);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  /* ★ R2 H-08-A：**整段入口**都在 try 里。改前 `new URL(req.url, …)`（连同上面这两段）在 try
     之外，而 async handler 里抛出的异常 = unhandled rejection = Node 默认**终止进程**。 */
  try {
    if (origin && corsOrigin(origin) === null) {
      return sendJson(res, 403, { ok: false, error: 'forbidden origin' }, origin);
    }
    /* ★ R2 H-08-A：URL 解析就是被畸形 request-target 打爆的那一步
       （`new URL('//[','http://127.0.0.1')` 抛 ERR_INVALID_URL；而浏览器侧
        `new URL('http://127.0.0.1:7187//[')` 是**合法**的、pathname 正是 `//[`，所以本机网页构造得出来）。 */
    let u;
    try { u = new URL(String(req.url == null ? '' : req.url), 'http://127.0.0.1'); }
    catch (e) {
      return sendJson(res, 400, { ok: false, error: 'bad request target', target: String(req.url || '').slice(0, 120) }, origin);
    }
    const isWriteOp = WRITE_PATHS.has(u.pathname) && req.method !== 'GET';
    const wOrigin = (origin === 'null' && isWriteOp) ? '' : origin;   // '' → corsOrigin 返回 null → 不发 ACAO
    if (req.method === 'OPTIONS') {
      addCommonHeaders(res, wOrigin);
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
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
      /* ★ R2 H-08-D：刷新决策与"降级标记"**一起**算 —— 台账 stat 不到时不再静默返回旧 pending。 */
      const fr = pendingFreshness();
      if (fr.status === 'stale') {
        await serialized(async () => { if (pendingNeedsRefresh()) refreshPendingSection(); });
      }
      const body = Object.assign({}, state || { error: 'no state' });
      if (fr.status === 'unreadable') {
        body.degraded = 'pending-ledger-unreadable';
        body.pendingStale = true;
        body.degradedDetail = '读不到台账 ' + PENDING + '：' + fr.error + '（本次返回的 pending 分区可能已过期）';
        console.error('[ctb-server] ⚠ ' + body.degradedDetail);
      }
      return sendJson(res, 200, body, origin);
    }
    if (req.method === 'POST' && u.pathname === '/api/state') {
      const r = await doRebuild();
      return sendJson(res, r.ok ? 200 : 500, r.ok ? r.state : r, wOrigin);
    }
    if (req.method === 'POST' && u.pathname === '/api/pending') {
      /* 最小可行鉴别（BUG-17）：只收 JSON 体。表单/`<img>` 之类的"简单请求"跨源伪造没有预检，
         这条能挡住；`fetch` 默认的 text/plain 也挡住。现有客户端两个都带 application/json，不受影响。 */
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype !== 'application/json') {
        return sendJson(res, 415, { ok: false, error: 'unsupported media type（POST /api/pending 只收 application/json）' }, wOrigin);
      }
      let body;
      try { body = parseJsonText(await readBody(req), '请求体'); }
      catch (e) {
        /* ★ R2 H-08-E：超限单独给 413（改前客户端只看到 ECONNRESET，读不到任何原因） */
        if (e && e.code === 'ETOOLARGE') {
          return sendJson(res, 413, { ok: false, error: String(e.message), limit: e.limit, got: e.got == null ? null : e.got }, wOrigin);
        }
        return sendJson(res, 400, { ok: false, error: 'bad json' }, wOrigin);
      }
      const list = (Array.isArray(body && body.resolves) ? body.resolves : []).filter(r => r && r.id && (r.action === '答' || r.action === '作废'));
      if (!list.length) return sendJson(res, 400, { ok: false, error: 'resolves empty or malformed' }, wOrigin);
      const r = await doResolve(list);
      return sendJson(res, r.ok ? 200 : 500, r, wOrigin);
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
