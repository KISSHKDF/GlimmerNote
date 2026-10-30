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
 * ★ 2026-10-30 S02/S05/S06/B01 加强（外部安全审计 4 条，每一条都先在 work\glimmer-audit-fix\_probe
 *   用独立端口 + 临时库复现过，改前行为见各行"改前实测"）：
 *   ① S02 **取消对 `Origin: null` 的信任**。`null` 不是"file:// 专用"标记，而是**所有不透明源**
 *      （攻击者页面里的 `<iframe sandbox>`）共同的字符串，HTTP 层不可区分。改前实测：
 *      `GET /api/state` 与 `GET /<库内文件>` 都 200 且回 `ACAO: null`，`POST /api/pending` 能穿过
 *      来源门禁（400 而不是 403）。现在只认"无 Origin（同源/非浏览器）"与同端口白名单，
 *      另加**每次启动的随机 token**做纵深（见 §Token 段）。取舍：file:// 直开的页面不再连服务端
 *      —— 那条路本来是桌面壳 postMessage 的活；server 模式只服务自己的同源页面。
 *   ② S05 **入口校验 Host/authority**（DNS rebinding 的服务端必要条件）。改前只看 Origin：
 *      `Host: attacker.example:PORT` 且不带 Origin 的请求一路 200（审计用原始 socket 复现）。
 *      现在只接受 127.0.0.1 / localhost（可带 `:PORT`，写了就必须等于本实例端口），其余 403 + 日志。
 *   ③ S06 **有副作用的路径统一门禁**：`POST /api/state` 改前既不校验 Content-Type 也不看来源，
 *      任何本机网页都能反复触发整库重建（分钟级、重写 1.35 MB 状态包）。现在与 `/api/pending`
 *      同口径只收 `application/json`，并且同一来源 1 秒内重复触发 → 429（已有重建在跑也 429）。
 *   ④ B01 **磁盘状态包读不出来时必须显式降级**：改前 `GET /api/state` 里刷新 `_状态.json` 的
 *      `statSync`/`readStateFile` 异常被空 `catch (e) {}` 吞掉，磁盘 JSON 写坏时继续 `200` 返回
 *      **旧内存快照**（改前实测：generatedAt 与改坏之前完全一样，响应里没有任何标记）。
 *      现在带 `degraded:'state-unreadable'` + `stateStale:true` + 原因，前端状态条能看到。
 *
 * 替换关系：本文件取代 _办结监听.mjs（计划任务 CTB-PendingSync 已改指本文件）。
 */
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
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

/* ★ 2026-10-30 S02：**给哪一份 index.html 注入 token** 的唯一判据（下面 serveStatic 与注入函数共用）。
    为什么两个形态都要算：开发区 APP = `<仓库>\src\app`，如果这一级本身是 junction/软链
    （本机就有把 app 目录做成链接的布局），realpath 之后的真实路径与 APP 拼出来的字符串不同，
    只比其中一个会**漏注入** —— 漏注入的症状是"页面能打开但所有 /api/* 都是 403"，
    而日志里只看到一串 forbidden token，很难归因。所以两条都判。 */
const ROOT_INDEX = path.normalize(path.join(APP, 'index.html')).toLowerCase();
const ROOT_INDEX_REAL = path.normalize(path.join(realOr(APP), 'index.html')).toLowerCase();
const isRootIndex = abs => {
  const a = path.normalize(String(abs)).toLowerCase();
  return a === ROOT_INDEX || a === ROOT_INDEX_REAL;
};

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
        v2 `host.js pendingResolve` 都带这个头），`fetch` 默认的 `text/plain` 与表单式跨源简单请求一律 415。
   ★ 2026-10-30 S02：上面 ② 里"与 file:// 客户端的 `null`"这一条**已作废**，见紧邻的说明。 */
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT]);
/* ★ 2026-10-30 S02：**取消对 `Origin: null` 的信任**（改前这里有一行 `if (origin === 'null') return 'null';`）。
   为什么必须取消：`null` 不是"file:// 专用"标记，它是**所有不透明源**共同的字符串 —— 攻击者页面里
   一个 `<iframe sandbox>` 发出来的请求，`Origin` 也正是 `null`，两者在 HTTP 层不可区分。
   改前实测（独立实例 + 临时库）：`GET /api/state` → 200 且 `ACAO: null`；`GET /<库内文件>` → 200
   并读出文件原文；`POST /api/pending` → 400（**已经穿过来源门禁**，只是被载荷校验拦住）。
   现在只认两种来源：① 无 Origin（同源请求 / curl 这类非浏览器客户端；浏览器对同源 GET 也不发 Origin）；
   ② ALLOWED_ORIGINS 里的同端口 http 来源。其余（含 `null`）一律 403，且**不回显任何 ACAO**。
   **取舍（确认可接受）**：file:// 直开的页面不能再连服务端 —— 它读数据必须靠 `ACAO: null`。
   三形态里 file:// 走的是**桌面壳 postMessage** 通道；server 模式只服务 `http://127.0.0.1:PORT/`
   这个同源页面。host.js 对应改成"没有服务端注入的 token 就根本不进 server 模式"（见该文件 §来源门禁）。 */
function corsOrigin(origin) {
  if (!origin) return null;                            // 同源 / 非浏览器客户端：不需要 ACAO
  if (ALLOWED_ORIGINS.has(origin)) return origin;       // 回显具体来源（不用 '*'，也就不会带上 cookie 语义）
  return null;                                          // 含 'null'（不透明源）与一切外部来源
}
/** 来源是否可信（入口门禁用；与 corsOrigin 同一份白名单，避免"发头一套、判据另一套"） */
function originTrusted(origin) { return !origin || ALLOWED_ORIGINS.has(origin); }

/* ---------- 请求身份门禁：Host / token（2026-10-30 S05 + S02 纵深） ---------- */
/* ★ S05：**入口先校验 Host/authority**。改前整个 handler 只看 Origin：`Host: attacker.example:PORT`
   且不带 Origin 的请求一路 200（审计用原始 socket 复现：`GET /api/state` 200、`GET /<库内文件>` 200
   并吐出内容）。这正是 DNS rebinding 的服务端必要条件 —— 攻击者域名解析到 127.0.0.1 之后，
   浏览器发出的就是"同源"请求，Origin 门禁形同虚设，唯一还能看出异常的就是 Host。
   现在只接受"确实绑在这个端口上的本机名"：
     · 主机名 127.0.0.1 / localhost；
     · 端口可省（HTTP/1.1 的 Host 允许省端口，本仓 neg-server-* 的原始 socket 就是 `Host: 127.0.0.1`），
       写了就必须**等于本实例实际监听的 PORT** —— 写别的端口同样不是我们。
   ⚠ 刻意不做任何模糊匹配（不认 `127.0.0.1.evil.com`、不认 `localhost.`、不认 IPv6 形态）：
   rebinding 靠的就是"域名看起来像本机"，放宽一条就等于门没关。IPv6 形态显式拒绝并记日志 ——
   本服务只绑 127.0.0.1，那种请求本来也到不了，写死"不猜"比写一套半吊子解析安全。 */
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);
function hostVerdict(rawHost) {
  const h = String(rawHost == null ? '' : rawHost).trim().toLowerCase();
  if (!h) return { ok: false, why: 'Host 头缺失（HTTP/1.1 必需）' };
  const i = h.lastIndexOf(':');
  const hostname = i < 0 ? h : h.slice(0, i);
  const portStr = i < 0 ? '' : h.slice(i + 1);
  if (!ALLOWED_HOSTNAMES.has(hostname)) return { ok: false, why: 'Host 主机名不在白名单：' + hostname };
  if (portStr) {
    if (!/^\d{1,5}$/.test(portStr)) return { ok: false, why: 'Host 端口不是十进制整数：' + portStr };
    if (Number(portStr) !== PORT) return { ok: false, why: 'Host 端口不是本实例端口：' + portStr + '（实际 ' + PORT + '）' };
  }
  return { ok: true };
}

/* ★ S02 纵深：**每次启动一枚随机 token**（不是常量、不写盘、不跨进程共享）。
   白名单已经收了，为什么还要加它：`Origin` 是**浏览器替我们填的自述**，本机任何程序都能自己造
   请求行 —— 对"本机另一个进程 / 用户顺手开的调试工具 / 别的程序里内嵌的 WebView"这一类，
   Origin 门禁没有鉴别力。token 的签发只走一条路：
     服务**程序根那份 index.html** 时，把 `window.__ctbToken="…"` 注入到 `</head>` 前；
     页面里的 host.js 再把它带回 `X-CTB-Token` 请求头（唯一出口 apiFetch，见该文件）。
   强制范围**只限带 `Sec-Fetch-*` 的 `/api/*` 请求**（`Sec-Fetch-*` 是浏览器独占的一组头，
   非浏览器客户端造不出来也不必造）：curl、本仓 tests\neg-server-*.cjs 的原始 socket/http.request
   一律不强制 —— 否则所有既有回归装置都要改，而它们本来就不是"本机网页伪造"这条通道。
   ⚠ 残余风险（必须写在明处）：同机任意进程 `GET /index.html` 就能拿到 token。这挡不住
   "同机恶意进程"（那本来就不是 HTTP 层能解决的），它挡的是**本机网页**与 **DNS rebinding**
   这两条真实可用的通道 —— 也就是审计 S02/S05 指的那两条。 */
const TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_HEADER = 'x-ctb-token';
/** 请求是否由浏览器发起（判据：带任一 `Sec-Fetch-*` 头）。 */
function looksLikeBrowser(req) {
  for (const k of Object.keys(req.headers)) if (k.startsWith('sec-fetch-')) return true;
  return false;
}
/** token 是否匹配（定长比较 + timingSafeEqual：不给"按响应时间逐位猜"留便宜） */
function tokenVerdict(req) {
  const got = Buffer.from(String(req.headers[TOKEN_HEADER] || '').trim().toLowerCase(), 'utf8');
  const want = Buffer.from(TOKEN, 'utf8');
  if (got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(got, want); } catch (e) { return false; }
}

/* 拒绝日志：前 20 条 + 之后每 100 条打一次。为什么节流：本机端口被扫描时不能把 stderr 刷成灾
   （stderr 会被 shell 的启动器/计划任务收集），但"记日志"这条要求不能因此变成不记。 */
let rejectCount = 0;
function logReject(what, req, extra) {
  rejectCount++;
  if (rejectCount <= 20 || rejectCount % 100 === 0) {
    console.error('[ctb-server] ✖ 拒绝请求（累计 ' + rejectCount + '）：' + what +
      '  method=' + req.method + ' url=' + String(req.url || '').slice(0, 120) +
      ' host=' + JSON.stringify(req.headers.host || '') +
      ' origin=' + JSON.stringify(req.headers.origin || '') +
      (extra ? '  ' + extra : ''));
  }
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
    /* ★ 2026-10-30 S02：**只**给程序根那份 index.html 注入本轮 token（见 isRootIndex 的说明）。
       注入点选 `</head>` 之前：index.html 里所有 `<script src>` 都在 body 尾部，
       注入语句早于 host.js 执行 ⇒ host.js 读 `window.__ctbToken` 时一定已经就位。
       没有 `</head>`（改造过的极简页面）时退化为插到文档最前面，仍然早于任何脚本。 */
    if (isRootIndex(real)) {
      const html = buf.toString('utf8');
      const snippet = '<script>window.__ctbToken=' + JSON.stringify(TOKEN) + ';</script>';
      const i = html.search(/<\/head\s*>/i);
      const out = i < 0 ? snippet + html : html.slice(0, i) + snippet + html.slice(i);
      addCommonHeaders(res, origin);
      /* token 每轮启动都变：这条响应**绝不能被缓存**，否则重启后页面拿旧 token，症状是
         "页面能打开、所有 /api/* 全 403"（而且看起来像服务端坏了，极难归因）。 */
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(Buffer.from(out, 'utf8'));
    }
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
   ★ 2026-10-30 S02：**这张表与配套的 wOrigin 补丁已删除** —— 不透明源现在在入口就被 403，
   根本走不到这里；留着"按路径不发 ACAO"的补丁只会让人误以为 null 源还有别的门。 */
/* ★ 2026-10-30 S06：重建限流。改前 `POST /api/state` 既不看 Content-Type 也不看来源（null 源直接
   进 doRebuild），任何本机网页都能让服务端反复 spawn 生成器 —— 生成器重跑一次是**分钟级、整库重写**，
   连点几次就把磁盘与 CPU 同时打满，而界面上只是"点了没反应"。
   现在两道：① 同一来源（Origin；无 Origin 归到 'same-origin'）1 秒内重复触发 → 429；
            ② 已有重建在跑时直接 429（不再往 serialized 队列里堆 —— 队列堆积的观感就是"卡死"）。 */
const REBUILD_MIN_MS = 1000;
const rebuildAt = new Map();
let rebuildBusy = false;

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  /* ★ R2 H-08-A：**整段入口**都在 try 里。改前 `new URL(req.url, …)`（连同上面这两段）在 try
     之外，而 async handler 里抛出的异常 = unhandled rejection = Node 默认**终止进程**。 */
  try {
    /* ★ 2026-10-30 S05：Host/authority 先于一切（连 OPTIONS 与静态文件都要过）。
       不通过时**不带上 origin** 回 ACAO —— 被拒的来源没有任何理由再拿到放行头。 */
    const hv = hostVerdict(req.headers.host);
    if (!hv.ok) {
      logReject('host', req, hv.why);
      return sendJson(res, 403, { ok: false, error: 'forbidden host（本服务只接受 127.0.0.1/localhost:' + PORT + '）', why: hv.why }, '');
    }
    /* ★ 2026-10-30 S02：来源门禁（`Origin: null` 与其他一切外部来源都在这里被挡住，读与写一视同仁） */
    if (!originTrusted(origin)) {
      logReject('origin', req);
      return sendJson(res, 403, { ok: false, error: 'forbidden origin（本服务只接受同源与本机白名单来源）' }, '');
    }
    /* ★ R2 H-08-A：URL 解析就是被畸形 request-target 打爆的那一步
       （`new URL('//[','http://127.0.0.1')` 抛 ERR_INVALID_URL；而浏览器侧
        `new URL('http://127.0.0.1:7187//[')` 是**合法**的、pathname 正是 `//[`，所以本机网页构造得出来）。 */
    let u;
    try { u = new URL(String(req.url == null ? '' : req.url), 'http://127.0.0.1'); }
    catch (e) {
      return sendJson(res, 400, { ok: false, error: 'bad request target', target: String(req.url || '').slice(0, 120) }, origin);
    }
    /* ★ 2026-10-30 S02 纵深：token 门禁只落在 `/api/*` 上，且**只对浏览器发起的请求**强制
       （判据 = 带 `Sec-Fetch-*`）。静态资源不强制：它们本来就在本机，且 `GET /index.html`
       正是 token 的签发口。非浏览器客户端（curl / 原始 socket）不强制，见 TOKEN 段说明。 */
    const isApi = u.pathname === '/api' || u.pathname.startsWith('/api/');
    if (isApi && looksLikeBrowser(req) && !tokenVerdict(req)) {
      logReject('token', req, '浏览器访问 ' + u.pathname + ' 未带有效 X-CTB-Token');
      return sendJson(res, 403, {
        ok: false,
        error: 'forbidden：浏览器访问 /api/* 必须带 X-CTB-Token（token 由服务端注入程序根 index.html）',
      }, origin);
    }
    if (req.method === 'OPTIONS') {
      addCommonHeaders(res, origin);
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        /* X-CTB-Token 必须列进允许头：跨源（真机上不会发生，但白名单来源仍可能带它）预检要过 */
        'Access-Control-Allow-Headers': 'Content-Type, X-CTB-Token',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (req.method === 'GET' && u.pathname === '/health') return sendJson(res, 200, { ok: true, port: PORT, version: 3, hasState: !!state, generatedAt: state && state.generatedAt }, origin);
    if (req.method === 'GET' && u.pathname === '/api/state') {
      /* BUG-16 修：GET **只读**。
         ① 磁盘 `_状态.json` 比内存快照新（别的会话重跑了生成器）→ 纯读换内存，不写盘；
         ② pending 分区：只有 `_待确认.json` 的 mtime/size 变过才 spawn `_状态刷新.mjs pending-if-stale`
            （子支再用内容哈希复核），没变则连 node 进程都不起、更不重写 1.35 MB 状态包。
         `?section=pending` 的调用方语义不变：台账变过就一定刷，拿到的是最新 pending。
         ★ 2026-10-30 B01：改前这里的 `try {…} catch (e) {}` 是**空 catch** —— 磁盘 `_状态.json`
         被写坏（半截 JSON）、被删、被权限挡住时，异常被吞，紧接着仍 `200` 返回**旧的**内存快照，
         响应里没有任何标记（实测：generatedAt 与改坏之前一模一样）。"失败必须说失败"在这一次
         被彻底违反，而且症状最恶劣：用户看到的是"一切正常"，看到的数据可能早于磁盘上的最新改动。
         现在把失败**显式**带进响应体（`degraded` / `stateStale` / `stateUnreadable` / `degradedDetail`），
         并且**不更新** `_diskM` —— 下一次 GET 会重试，不会因为一次读失败就永久降级。 */
      let stateFail = null;
      try {
        const diskM = fs.statSync(STATE).mtimeMs;
        if (diskM > (state?._diskM || 0)) {
          try { state = readStateFile(); state._diskM = diskM; }
          catch (e) {
            stateFail = {
              code: 'state-unreadable',
              detail: '磁盘 _状态.json 比内存快照新（mtime=' + diskM + '），但读不出来：' +
                String((e && e.message) || e) + ' —— 本次返回的是**上一份**内存快照，可能已过期',
            };
          }
        }
      } catch (e) {
        /* stat 就失败：文件没了 / 权限变了。内存里还有快照时同样必须说"这是旧的"。 */
        if (state) {
          stateFail = {
            code: 'state-unreadable',
            detail: '读不到磁盘 _状态.json（' + STATE + '）：' + String((e && e.message) || e) +
              ' —— 本次返回的是**上一份**内存快照，可能已过期',
          };
        }
      }
      /* ★ R2 H-08-D：刷新决策与"降级标记"**一起**算 —— 台账 stat 不到时不再静默返回旧 pending。 */
      const fr = pendingFreshness();
      if (fr.status === 'stale') {
        await serialized(async () => { if (pendingNeedsRefresh()) refreshPendingSection(); });
      }
      const body = Object.assign({}, state || { error: 'no state' });
      if (stateFail) {
        body.degraded = stateFail.code;
        body.stateStale = true;
        body.stateUnreadable = true;
        body.degradedDetail = stateFail.detail;
        console.error('[ctb-server] ⚠ ' + stateFail.detail);
      }
      if (fr.status === 'unreadable') {
        /* 两条降级可能同时发生（状态包坏 + 台账也没了）：**都要说**。`degraded` 只有一个位置，
           所以状态包优先占它（更严重），台账的原因接在 detail 后面，并单列 pendingStale。 */
        const pd = '读不到台账 ' + PENDING + '：' + fr.error + '（本次返回的 pending 分区可能已过期）';
        body.pendingStale = true;
        if (!body.degraded) { body.degraded = 'pending-ledger-unreadable'; body.degradedDetail = pd; }
        else body.degradedDetail = body.degradedDetail + '；' + pd;
        console.error('[ctb-server] ⚠ ' + pd);
      }
      return sendJson(res, 200, body, origin);
    }
    if (req.method === 'POST' && u.pathname === '/api/state') {
      /* ★ 2026-10-30 S06：与 `/api/pending` 同口径只收 JSON 体（改前是**直接** doRebuild）。
         `fetch` 默认的 text/plain、表单、`<img>` 这类"简单请求"跨源伪造没有预检，这一条把它们挡在门外。 */
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype !== 'application/json') {
        return sendJson(res, 415, { ok: false, error: 'unsupported media type（POST /api/state 只收 application/json）' }, origin);
      }
      const key = origin || 'same-origin';
      const now = Date.now();
      const last = rebuildAt.get(key) || 0;
      if (now - last < REBUILD_MIN_MS) {
        return sendJson(res, 429, {
          ok: false, error: '重建过于频繁：同一来源 ' + REBUILD_MIN_MS + 'ms 内只能触发一次',
          retryAfterMs: REBUILD_MIN_MS - (now - last),
        }, origin);
      }
      if (rebuildBusy) {
        return sendJson(res, 429, { ok: false, error: '已有一次全量重建在进行中，等它结束再点' }, origin);
      }
      rebuildAt.set(key, now);
      rebuildBusy = true;
      try {
        const r = await doRebuild();
        return sendJson(res, r.ok ? 200 : 500, r.ok ? r.state : r, origin);
      } finally { rebuildBusy = false; }
    }
    if (req.method === 'POST' && u.pathname === '/api/pending') {
      /* 最小可行鉴别（BUG-17）：只收 JSON 体。表单/`<img>` 之类的"简单请求"跨源伪造没有预检，
         这条能挡住；`fetch` 默认的 text/plain 也挡住。现有客户端两个都带 application/json，不受影响。 */
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype !== 'application/json') {
        return sendJson(res, 415, { ok: false, error: 'unsupported media type（POST /api/pending 只收 application/json）' }, origin);
      }
      let body;
      try { body = parseJsonText(await readBody(req), '请求体'); }
      catch (e) {
        /* ★ R2 H-08-E：超限单独给 413（改前客户端只看到 ECONNRESET，读不到任何原因） */
        if (e && e.code === 'ETOOLARGE') {
          return sendJson(res, 413, { ok: false, error: String(e.message), limit: e.limit, got: e.got == null ? null : e.got }, origin);
        }
        return sendJson(res, 400, { ok: false, error: 'bad json' }, origin);
      }
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
  /* token 全文不打印（会被启动器/计划任务收集进日志）：只报前 6 位以便按"同一轮"对账。
     页面拿 token 的正规路径是服务端注入的 index.html，不是读这行日志。 */
  console.log('[ctb-server] 门禁：Host 只认 127.0.0.1/localhost:' + PORT + '；Origin 只认同源与本机白名单；' +
    '浏览器访问 /api/* 需 X-CTB-Token（token 前 6 位 ' + TOKEN.slice(0, 6) + '…，每轮启动随机）');
});
