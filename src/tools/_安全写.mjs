#!/usr/bin/env node
/**
 * 错题本 · 安全读写底座（2026-10-10 建）
 *
 * 为什么存在（根因，见 docs\BUG审计-工具链-20261010.md BUG-01/BUG-02）：
 *   ① 全库 JSON 真源的写入都是 `fs.writeFileSync(path, …)` —— 语义是 `open(path,'w')`，
 *      **先把文件截断成 0 字节再写**。写一半被 taskkill / 断电 / 磁盘满 / 句柄占用，
 *      留下的就是半截 JSON。而这些文件（_索引.json / _待确认.json / _盲解双路.json /
 *      _配图台账.json / _笔形台账.json / _组卷台账.json）装的是"原卷照片 + 人工判读"，
 *      **不可再生**。
 *   ② 各工具的 load() 用「形状不对就当我以为是空的」兜底（`if (!Array.isArray(j.items)) j.items = []`），
 *      紧接着同一次调用就 save() 写回 ⇒ 真源被**静默清空**，工具还打印"已加/已答/已登记"的成功信息。
 *      触发通道在本仓有记载：拿 PowerShell 对 JSON 做一次 ConvertFrom/To-Json 往返，
 *      数组就变 `{value:[…]}`（`_生成首页.ps1` 自己注释里写着这个坑）。
 *
 * 本模块把这两件事变成默认行为：
 *   readJsonStrict(file, {shape})  —— 解析失败 / 形状不符 → **抛错并指出恢复途径**，绝不"当作空库"
 *   writeJsonAtomic(file, obj)     —— 同目录临时文件 + fsync + rename 覆盖（同分区 rename 原子替换），
 *                                     Windows 上被占用时重试；失败则原文件**原样不动**
 *   backupJson(file, {keep})       —— 写前把旧文件复制进 `_备份-真源\`（按文件名留最近 keep 份）
 *
 * 用法（各工具）：
 *   import { readJsonStrict, writeJsonAtomic, backupJson } from './_安全写.mjs';
 *   const db = readJsonStrict(DB, { shape: j => Array.isArray(j.items), what: 'items 数组' });
 *   writeJsonAtomic(DB, db, { backup: true });
 *
 * 自检：node tests\safe-write.test.mjs（含"目标文件绝不半截"的阴性对照）
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';   // ★ H1 整改：ESM 里没有 require（静默 catch 成 t=0 会让判据退回旧口径），必须在模块顶 import

const BAKDIR_NAME = '_备份-真源';
const DEFAULT_KEEP = 8;

/** 去掉 BOM 后解析 JSON；失败即抛错（绝不返回空对象冒充成功） */
export function readJsonStrict(file, { shape, what, label } = {}) {
  const name = label || path.basename(file);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`[安全读] 读不到 ${name}：${e.message}`); }
  let j;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (e) {
    throw new Error(`[安全读] ${name} 不是合法 JSON（${e.message}）。` +
      ` 已拒绝继续——把它当成空库再写回会把整份真源清空。` +
      ` 恢复途径：从 ${BAKDIR_NAME}\\ 或 git 历史取上一版，人工核对后再重跑。`);
  }
  if (typeof shape === 'function' && !shape(j)) {
    throw new Error(`[安全读] ${name} 结构异常：期望 ${what || '约定形状'}，实际 ${describe(j)}。` +
      ` 已拒绝继续（避免把整份真源写成空表）。` +
      ` 若确实是从 PowerShell 的 ConvertFrom/To-Json 往返过，数组会变成 {value:[…]}——手工改回数组即可。`);
  }
  return j;
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `数组[${v.length}]`;
  if (typeof v === 'object') return `对象{${Object.keys(v).slice(0, 6).join(',')}}`;
  return typeof v;
}

/** 写前备份：把旧文件复制到 `_备份-真源\<名>-<时间戳>.json`，同名只留最近 keep 份 */
export function backupJson(file, { keep = DEFAULT_KEEP, dir } = {}) {
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  if (!st.size) return null;                        // 空文件没有备份价值
  const bakDir = dir || path.join(path.dirname(file), BAKDIR_NAME);
  fs.mkdirSync(bakDir, { recursive: true });
  const base = path.basename(file).replace(/\.json$/i, '');
  const d = new Date(), p = n => String(n).padStart(2, '0');
  /* 时间戳必须带毫秒：只到「秒」时，同一秒内的两次写会互相覆盖、静默丢掉中间那份备份
     （本模块自检 tests\safe-write.test.mjs 实测抓到）。仍撞名则加序号，绝不覆盖。 */
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}`;
  let dst = path.join(bakDir, `${base}-${stamp}.json`);
  for (let i = 1; fs.existsSync(dst) && i < 100; i++) dst = path.join(bakDir, `${base}-${stamp}-${i}.json`);
  try { fs.copyFileSync(file, dst); } catch { return null; }
  // 轮转：同名只留最近 keep 份（防备份目录自己涨成灾）
  try {
    const mine = fs.readdirSync(bakDir).filter(n => n.startsWith(base + '-') && n.endsWith('.json')).sort();
    for (const n of mine.slice(0, Math.max(0, mine.length - keep))) { try { fs.unlinkSync(path.join(bakDir, n)); } catch { } }
  } catch { }
  return dst;
}

/**
 * 量出盘上这份 JSON **自己的**格式（缩进 / 有没有收尾换行）。
 * 返回 null = 文件不存在、读不出、或内容为空 ⇒ 调用方该用默认值。
 *
 * 为什么需要它（规范 W6「改盘别改格式」的机械实现）：
 * 缩进是**每一份文件自己定的**——`_原卷台账.json` 与 `_录题任务.json` 刻意用 1 空格，新文件才用 2。
 * 写入器若一律用默认值，"只改了一个字符串"就会变成"整篇重排"：实测一次纯路径改写让
 * `_原卷台账.json` 从 410,280 B 涨到 451,899 B（+41.6 KB），内容上却只动了几个路径。
 */
export function detectJsonFormat(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  if (!raw.trim()) return null;
  const m = /\n([ \t]+)"/.exec(raw);          // 第一个缩进行的顶层字段；紧凑单行文件匹配不到 ⇒ 缩进 0
  let indent = 0;
  if (m) indent = /^\t+$/.test(m[1]) ? '\t'.repeat(m[1].length) : m[1].length;
  return { indent, newline: raw.endsWith('\n') };
}

/**
 * 原子写 JSON：同目录临时文件 → fsync → rename 覆盖。
 * 任何一步失败都**不碰目标文件**（这正是它比 writeFileSync 安全的地方）。
 *
 * `indent` / `newline` **不传**时沿用盘上原格式（W6）；显式传了才按传的来。
 * 文件不存在（新文件）时用历史默认：2 空格 + 收尾换行。
 */
export function writeJsonAtomic(file, obj, { backup = false, keep = DEFAULT_KEEP, newline, indent } = {}) {
  if (indent === undefined || newline === undefined) {
    const cur = detectJsonFormat(file);
    if (cur) {
      if (indent === undefined) indent = cur.indent;
      if (newline === undefined) newline = cur.newline;
    }
  }
  if (indent === undefined) indent = 2;
  if (newline === undefined) newline = true;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(obj, null, indent) + (newline ? '\n' : '');
  const tmp = path.join(dir, `${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, data, 'utf8');
    try { fs.fsyncSync(fd); } catch { }             // 有些文件系统不支持 fsync，不阻断
    fs.closeSync(fd); fd = null;
    if (backup) backupJson(file, { keep });
    renameWithRetry(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { } }
    try { fs.unlinkSync(tmp); } catch { }            // 清掉半截临时文件；目标文件保持原样
    throw new Error(`[安全写] 写 ${path.basename(file)} 失败（原文件未改动）：${e.message}`);
  }
  return file;
}

/** 文本原子写（首页.html 这类大产物同理：绝不半截） */
export function writeTextAtomic(file, text, { encoding = 'utf8' } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, text, encoding);
    try { fs.fsyncSync(fd); } catch { }
    fs.closeSync(fd); fd = null;
    renameWithRetry(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { } }
    try { fs.unlinkSync(tmp); } catch { }
    throw new Error(`[安全写] 写 ${path.basename(file)} 失败（原文件未改动）：${e.message}`);
  }
  return file;
}

/* Windows 上另一个进程正读着目标文件时 rename 可能 EPERM/EBUSY/EACCES —— 短暂重试即可。
   ⚠ 绝不"先删目标再 rename"：那会在两步之间留下「目标不存在」的窗口，且第二步再失败就真丢了。
   宁可失败退出（目标原样），也不破坏"要么旧、要么新"这条不变量。 */
function renameWithRetry(from, to, tries = 8) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      last = e;
      if (!/EPERM|EBUSY|EACCES/.test(String(e.code || e.message))) throw e;
      sleepMs(25 * (i + 1));
    }
  }
  throw last || new Error('rename 失败');
}

/** 同步小睡（不引 async、不忙等烧 CPU） */
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = Date.now() + ms; while (Date.now() < t) { /* 退化为忙等 */ } }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2026-10-30 新增（外部安全审计 D01 / D02）：
 *   ① acquireLibLock —— **跨进程**写锁（壳 / HTTP 服务端 / 命令行三条通道共用同一把锁）
 *   ② openTransaction —— **多文件业务事务**（要么全成、要么全退，中途崩溃下次启动自动回滚）
 *
 * 为什么必须补这两样（审计原文的缺陷，均已在源码里确认）：
 *   D02：壳自己有 Global mutex（CTBShellV2.cs:316），HTTP 服务端只有**进程内** Promise 队列
 *        （_服务端.mjs 的 serialized），命令行工具连进程内锁都没有。三者都能"读同一份旧数据 →
 *        各自修改 → 各自原子覆盖" ⇒ **后完成的那个把前一个的修改整段丢掉**。原子写只保证
 *        "文件不半截"，完全不保证"两次修改都在"。用户看到的是一次操作神秘消失。
 *   D01：`_标记复习.mjs` 的批改先写 `_组卷台账.json`、再写学生 `_索引.json`（actGrading:276/279）。
 *        第二次写失败/进程被杀/断电 ⇒ 台账说"已批改"，索引里的 reviews/nextDue 却没动。
 *        单文件原子写救不了这一步 —— 需要**跨文件**的提交语义。
 *
 * 设计取舍（都是踩过坑才这么定的，别随手改）：
 *   · 锁文件与事务留档放在**本机用户数据目录**（%LOCALAPPDATA%\GlimmerNote\write-state，
 *     2026-11-04 H2 整改：原先放系统临时目录，被系统清理时留档丢失 ⇒ 只剩"没有自动回滚"。
 *     %LOCALAPPDATA% 不进 `数据\`（红线不破）、不被磁盘清理误删；仍可用 CTB_TXN_DIR 覆盖
 *     （测试与排障用）。老布局（%TEMP%\glimmernote-write-state\<key>）在**取到锁之后**处理一次：
 *     旧日志的持有进程已死才回滚，回滚成功才删**本库自己的**旧目录；旧父目录只在空了时 rmdir。
 *   · 锁用 `openSync(..., 'wx')` 独占创建 + 里面写持有者 pid/token/时间：**不猜**"文件在就是被锁着"，
 *     而是判持有进程是否还活着（pid 复用由**进程启动时间**比对兜底，2026-11-04 H1 整改：
 *     修前只判 pid 存活，PID 被无关新进程复用时僵尸锁被当成活锁，等满 120 秒超时）。
 *     ⚠ 没有心跳机制：判据只有"PID 存活 + 启动时间一致"两条，见 lockHolderAlive()。
 *   · 子进程**继承**锁：持有者把 token 写进自己的 process.env，Node 的 spawn/execFileSync 与
 *     PowerShell 都会把环境变量传给孙进程 ⇒ 子工具看到 token 与锁文件一致就直接放行。
 *     没有这一条，`_状态刷新.mjs`（持锁）spawn `_待确认.mjs`（要锁）当场自死锁。
 * ══════════════════════════════════════════════════════════════════════════ */
const LOCK_FILE = 'lock';
const JOURNAL_FILE = 'journal.json';
const TXN_ENV = 'CTB_LOCK_TOKEN';

/** 本机用户数据目录里的"这个库专属"工作区（同一个库在不同机器/不同盘符下互不干扰） */
function stateDirOf(root) {
  const custom = String(process.env.CTB_TXN_DIR || '').trim();
  const key = crypto.createHash('sha1').update(String(root).toLowerCase()).digest('hex').slice(0, 16);
  /* ★ 2026-11-05（合并评审 P2-7）：目录名统一成 %LOCALAPPDATA%\拾光小册\（与 shell.log、wv2-profile、proc 同一个家）。
     2026.11.05.01 用过的 %LOCALAPPDATA%\GlimmerNote\write-state 作为第二个旧布局，由 migrateLegacyState() 一并迁走。
     ★ 2026-11-04（H2 整改）：从 os.tmpdir() 迁到 %LOCALAPPDATA%\<应用目录>\write-state。
     为什么：临时目录被系统/清理工具定期清空 ⇒ 事务留档丢了就只剩"没有自动回滚"；
     写锁目录没了倒不致命（锁是瞬时状态），但留档是**恢复材料**，必须住得比 %TEMP% 稳。
     %LOCALAPPDATA% 不在用户库（红线 2 不破：任何脚本都不得写 `数据\`）。
     ★ 2026-11-05（复核 P0-1/P0-2/P2-5）：这里**只算路径、不做迁移**。修前迁移写在本函数里，
     于是连只读探针 lockPathOf() 都会在**没持锁**时回滚事务，且迁移完 rmSync 整个旧父目录，
     把**别的库**还没迁的 journal 一起删掉。迁移现在只在 onAcquired()（已持锁）里做，见 migrateLegacyState()。 */
  const base = custom
    ? path.resolve(custom)
    : path.join(process.env.LOCALAPPDATA || os.tmpdir(), '拾光小册', 'write-state');
  const dir = path.join(base, key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 供测试与排障用：这个库的锁文件 / 事务日志**具体落在哪**（不猜路径，唯一实现） */
export function lockPathOf(root) { return path.join(stateDirOf(root), LOCK_FILE); }
export function journalPathOf(root) { return path.join(stateDirOf(root), JOURNAL_FILE); }
/* ★ 2026-11-04（H1）：测试用的启动时间通道（不进业务面：锁判据内部走同一个函数）。
   named export 供 neg-lock-reclaim-race 断言"通道没静默失效"（否则 startedAt 恒 0、
   PID 复用判据永远走退回分支 = 判据形同虚设却全绿）。 */
export const __test_procStartTime = procStartTime;
export const __test_migrateLegacyState = migrateLegacyState;
export const __test_procStartCache = { has: (pid) => procStartCache.has(pid) };
export const __test_lockHolderAlive = (cur) => lockHolderAlive(cur);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }     // EPERM = 进程在，只是不归我管 ⇒ 算活着
}

/* ★ 2026-11-04（外部复核实测 H1）：PID 复用判死。
   修前锁的回收判据只有 `pidAlive(pid)` —— OS 的 PID 会**复用**：旧持有者被 taskkill 后，
   同一个 PID 落到无关新进程头上 ⇒ 僵尸锁被当成活锁，等待直至 120 秒超时抛错。
   修法：锁文件里记持有者的**进程启动时间**（startedAt，ms epoch）。PID 活着且启动时间一致 ⇒ 真活着；
   PID 活着但启动时间不一致 ⇒ 是复用者，按僵尸锁处置。**没有心跳**（2026-11-05 复核 P1-4：
   修前注释描述了"心跳刷新 + HEARTBEAT_STALE_MS"，代码里从来没有，已删）。

   启动时间来源（两侧必须同源，比较才有意义）：
     · Windows：PowerShell `(Get-Process -Id N).StartTime.ToFileTime()` —— 内核在进程创建时记下的
       FILETIME，事后校时不改变它；代价是**每个取锁的进程**多一次 PowerShell 冷启动（实测量级
       数百毫秒，杀软扫描时更久）。这是正确性换来的，不是"零开销"。
     · Linux：/proc/<pid>/stat 第 22 字段（开机后的 jiffies）+ /proc/stat 的 btime。2026-11-05 补上，
       修前 Linux 恒返回 0 ⇒ H1 判据在 Linux 上从未被测试真正执行过（复核 P2-4）。
     · 其他平台 / 查不到 ⇒ 0（调用方退回旧判据，**绝不**拿当前时刻冒充，见 P1-3）。

   缓存（2026-11-05 复核 P1-2）：修前以 PID 为键永不失效 ⇒ 等锁期间持有者死掉、PID 被复用，
   查到的还是缓存里的旧启动时间 ⇒ 复用者被当成原持有者。现在：本进程的启动时间永久缓存；
   别的 PID 缓存 PROC_START_TTL_MS，且一旦观察到该 PID 死亡立即作废。 */
const PROC_START_TTL_MS = 2000;
const procStartCache = new Map();   // pid -> { t, at }
function readProcStartTime(pid) {
  if (process.platform === 'win32') {
    try {
      /* ⚠ 用 ToFileTime()（FILETIME，100ns 单位）—— 实测 UtcTicks 在管道环境下输出空/转型得 0。 */
      /* ⚠ 2026-11-05（CI 偶发红两次后定位）：单次超从 5000ms 降到 **2500ms**。
       *   背景：PowerShell 冷启动在慢机器/杀软扫描时可能好几秒；原 5 秒超时会让
       *   **每一次判活**都阻塞那么久（等锁轮询里反复付这个代价）⇒ "立刻清掉僵尸锁"
       *   变成"等好几秒才清"，CI 实测 5062ms。
       *   实测本机冷启动约 220ms，2.5 秒留足余量；查不到就返回 0，
       *   调用方退回**旧判据**（保守：宁可等，也不误删别人的锁）⇒ 降超时不会引入误删。 */
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        '(Get-Process -Id ' + pid + ' -ErrorAction Stop).StartTime.ToFileTime()'], { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] });
      const ft = Number(String(out).trim());
      return Number.isFinite(ft) && ft > 0 ? Math.floor(ft / 10000) - 11644473600000 : 0;
    } catch { return 0; }
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');   // comm 可能含空格/括号，从最后一个 ')' 之后切
      const jiffies = Number(rest[19]);                                // 字段 22 = rest[22-3]
      const btime = Number((/^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8')) || [])[1]);
      if (!Number.isFinite(jiffies) || !Number.isFinite(btime)) return 0;
      return btime * 1000 + Math.round(jiffies * 10);                 // USER_HZ=100（Linux ABI 固定值）
    } catch { return 0; }
  }
  return 0;
}
function procStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  const hit = procStartCache.get(pid);
  if (hit && (pid === process.pid || Date.now() - hit.at < PROC_START_TTL_MS)) return hit.t;
  const t = readProcStartTime(pid);
  /* 查不到（0）不缓存：下一轮再试，避免一次超时把"未知"钉死 */
  if (t) procStartCache.set(pid, { t, at: Date.now() });
  return t;
}
function forgetProcStart(pid) { if (pid !== process.pid) procStartCache.delete(pid); }
/** 锁持有者是否可信存活：PID 活着 **且**（拿不到启动时间 或 启动时间与锁记录一致）。
 *  PID 死 / PID 活但启动时间不同（复用者）⇒ false。 */
function lockHolderAlive(cur) {
  if (!cur || !Number.isInteger(cur.pid) || cur.pid <= 0) return false;
  if (!pidAlive(cur.pid)) { forgetProcStart(cur.pid); return false; }
  const startedAt = Number(cur.startedAt) || 0;
  if (!startedAt) return true;              // 老版本锁文件没有 startedAt：退回旧判据（不因升级卡死用户）
  const real = procStartTime(cur.pid);
  if (!real) return true;                   // 查不到启动时间（权限/平台差异）：退回旧判据
  return Math.abs(real - startedAt) < 3000; // 3 秒容差（时钟精度）；不同 ⇒ PID 已被复用
}

function readLockFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 当前进程是否已持锁（子进程通过继承的 token 判定） */
function inheritedToken() {
  const t = String(process.env[TXN_ENV] || '').trim();
  return t || '';
}

/**
 * 取得本库的跨进程写锁。**同步阻塞**等待（调用方全是同步工具，没有 async 可等）。
 * @returns {function} 释放函数（可重复调用）
 */
export function acquireLibLock(root, { label = '', timeoutMs = 120000, pollMs = 40 } = {}) {
  const dir = stateDirOf(root);
  const lockPath = path.join(dir, LOCK_FILE);
  const inherited = inheritedToken();

  // ① 子进程继承：token 与锁文件一致且持有者 PID 存活 ⇒ 放行（不自锁）。
  // ★ 2026-11-13（P0-C①，审计终稿 §三）：这里**只验 token + pidAlive**，不查启动时间——
  //    24 位随机 token 只沿进程树继承（env 注入），PID 复用者不可能持有它；
  //    之前走 lockHolderAlive 会付一次 PowerShell 冷启动（~0.9s，杀软/高负载时 1.5s+），
  //    且 800ms 级判据在负载下翻转假红（5 次复测 876-907ms）。
  //    外层普通取锁路径（②以下）仍走 lockHolderAlive——那条路没有 token 可验，必须防 PID 复用。
  if (inherited) {
    const cur = readLockFile(lockPath);
    if (cur && cur.token === inherited && pidAlive(cur.pid)) return function () { };
  }

  const myToken = crypto.randomBytes(12).toString('hex');
  /* ★ 2026-11-05（复核 P1-3）：查不到就写 0，**绝不**用 Date.now() 兜底。
     修前：自己这侧 PowerShell 超时 ⇒ 记下的是"取锁时刻"；别的进程查到的是真实启动时间，
     差 >3 秒 ⇒ 把活着的持有者判成复用者 ⇒ 删锁、双写。0 会让检查方走"没有 startedAt"的旧判据。 */
  const myStartedAt = procStartTime(process.pid);
  const body = JSON.stringify({ pid: process.pid, token: myToken, label: label || path.basename(String(root)), at: Date.now(), startedAt: myStartedAt });
  const deadline = Date.now() + timeoutMs;
  let waitedMsg = false;
  /* ⚠ 2026-10-30 实测抓到的**抢锁竞态**（并发回归第一次就复现：6 个进程说"全成功"，台账只多了 4 条）：
     `openSync(path,'wx')` 与 `writeFileSync(fd, body)` 之间有极短的一瞬，锁文件**存在但内容是空的**。
     此时另一个进程进来读到的是空文件 ⇒ 解析失败 ⇒ 上一版代码把它当"半截锁文件"直接 unlink 抢走
     ⇒ 两个进程同时认为自己在持锁 ⇒ 谁后写谁覆盖，前面那个的修改整段丢（正是这把锁要防的事）。
     修法：空/读不出的锁文件**不许立刻抢**，先按"正在创建中"处理（等固定时间）；
     只有它持续读不出且超过 LOCK_UNREADABLE_GRACE_MS 才判定为真·半截文件并清理。
     判据必须能自证：并发用例里 6 个进程全成功且批次条数 == 6（少一条就是又丢更新了）。 */
  const LOCK_UNREADABLE_GRACE_MS = 2000;
  const GC_STALE_MS = 10000;          // 回收互斥（<lock>.gc）自身被崩溃留下时的兜底时限
  let unreadableSince = 0;

  /** 取到锁之后的统一收尾：把 token 交给子孙进程 + 回滚上次未完成事务 + 返回 release */
  function onAcquired() {
    process.env[TXN_ENV] = myToken;
    const migrated = migrateLegacyState(root);
    if (migrated) console.error('[写锁] ' + migrated);
    const healed = recoverTransactions(root);
    if (healed) console.error('[写锁] ⚠ ' + healed);
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      try {
        const cur = readLockFile(lockPath);
        if (cur && cur.token === myToken) fs.unlinkSync(lockPath);
      } catch { }
      try { delete process.env[TXN_ENV]; } catch { }
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 僵尸锁回收必须**互斥**（2026-10-31 codex 外部审查 A01/B02，已实测复现）
   *
   * 缺陷（真实复现：25 轮 × 3 并发进程，8 次在临界区内发现锁属于别人）：
   *   原实现是 `const cur = readLockFile(lockPath); if (cur && !pidAlive(cur.pid)) unlinkSync(lockPath)`——
   *   **读与删之间没有任何互斥**。两次读之间完全可能发生：
   *     A 读到僵尸锁（判死）→ 暂停；B 清掉僵尸锁并建了自己的新锁、进入写区；
   *     A 恢复 → unlinkSync(lockPath) 删的是 **B 的活锁** → A 也建锁成功进入写区。
   *   两个进程同时"持锁"，后写覆盖前者 —— 正是这把锁要防的静默丢更新。
   *   这个窗口比"空锁文件"那条更窄但同样可命中，且后果一样（丢写）。
   *
   * 修法：回收动作放进一把**独立的回收互斥**（`<lock>.gc`，同样 'wx' 独占创建）里，
   *   并且在互斥内**重读一次**判死；只有重读仍判死才删，删完**立刻**在互斥内建自己的锁。
   *   空窗分析：删除→创建都在 gc 内，且任何删除方都先拿 gc ⇒ 不存在"删掉别人刚建的锁"。
   *   gc 自身被崩溃留下时按 mtime 超过 GC_STALE_MS 兜底清理（它只被持有几毫秒）。
   * 判据：tests\neg-concurrent-write-lock.cjs 的 6 进程用例 + 本轮新增的
   *   `neg-lock-reclaim-race.cjs`（造僵尸锁 + 多进程抢，断言无人在临界区内看到别人的 token）。
   * ══════════════════════════════════════════════════════════════════════════ */
  function reclaimUnderMutex(mode) {
    const gc = lockPath + '.gc';
    try {
      const fd = fs.openSync(gc, 'wx');
      fs.writeFileSync(fd, String(process.pid), 'utf8');
      fs.closeSync(fd);
    } catch (e) {
      /* 别人正在回收：若是崩溃残留（超时），清掉后由下一轮重试；否则让出 */
      try {
        const st = fs.statSync(gc);
        if (Date.now() - st.mtimeMs > GC_STALE_MS) fs.unlinkSync(gc);
      } catch { }
      return false;
    }
    try {
      const again = readLockFile(lockPath);                 // ← 互斥内重读（这就是修法）
      /* ★ 2026-11-04（H1）：判活从 pidAlive 换成 lockHolderAlive ——
         PID 被无关进程复用时（活着但启动时间对不上）同样按僵尸锁回收。 */
      if (again && lockHolderAlive(again)) return false;    // 持有者可信存活：绝不删
      if (again) console.error('[写锁] 清理僵尸锁（持有进程 ' + again.pid +
        (pidAlive(again.pid) ? ' 已不存在或 PID 已被复用' : ' 已不存在') + '，label=' + (again.label || '') + '）');
      /* mode='unreadable' 且现在能读出内容 ⇒ 说明它已不是半截件，本轮放弃删除 */
      if (mode === 'unreadable' && again) return false;
      try { fs.unlinkSync(lockPath); } catch { }
      try {
        const fd2 = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd2, body, 'utf8');
        fs.closeSync(fd2);
        return true;                                        // 已在互斥内持锁
      } catch { return false; }
    } finally {
      try { fs.unlinkSync(gc); } catch { }
    }
  }

  for (; ;) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');            // 原子独占创建
      fs.writeFileSync(fd, body, 'utf8');
      fs.closeSync(fd);
      fd = null;
      return onAcquired();
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { } }
      if (e && e.code !== 'EEXIST') throw new Error('[写锁] 无法创建锁文件 ' + lockPath + '：' + e.message);
      const cur = readLockFile(lockPath);
      /* ★ 2026-11-04（H1）：外层等待循环同样换 lockHolderAlive（PID 复用 = 僵尸锁）。 */
      if (cur && !lockHolderAlive(cur)) {
        if (reclaimUnderMutex('dead')) return onAcquired();
      } else if (!cur) {
        /* 空/半截：多半是另一个进程刚 'wx' 成功、还没来得及写内容。**绝不立刻抢**。 */
        if (!unreadableSince) unreadableSince = Date.now();
        else if (Date.now() - unreadableSince > LOCK_UNREADABLE_GRACE_MS) {
          if (reclaimUnderMutex('unreadable')) { unreadableSince = 0; return onAcquired(); }
          console.error('[写锁] 锁文件持续 ' + LOCK_UNREADABLE_GRACE_MS + 'ms 读不出内容，判定为残留并清理（' + lockPath + '）');
          unreadableSince = 0;
        }
      } else {
        unreadableSince = 0;
      }
      if (Date.now() > deadline) {
        throw new Error('[写锁] 等锁超时 ' + Math.round(timeoutMs / 1000) + 's：另一个进程正在写这个库（pid=' +
          (cur && cur.pid) + ' label=' + (cur && cur.label) + '）。等它结束再试，或确认它已卡死后删除 ' + lockPath);
      }
      if (!waitedMsg) {
        waitedMsg = true;
        console.error('[写锁] 等待另一个进程释放（pid=' + (cur && cur.pid) + ' label=' + (cur && cur.label) + '）…');
      }
      sleepMs(pollMs);
    }
  }
}

/* ---------- 多文件业务事务 ----------
   语义：openTransaction() 之后每一次写都会**先把原文件留档**（不存在则记 null）。
   commit() 只删日志 —— 留档留着直到下次 commit 前被清理。
   rollback()（或下次启动检测到遗留日志）把每个目标恢复成留档内容，原本不存在的文件删掉。
   因此"要么全成、要么全退"，不再有"台账说批改了、索引没动"这种半截状态。 */
export function openTransaction(root, { label = '' } = {}) {
  const dir = stateDirOf(root);
  const journalPath = path.join(dir, JOURNAL_FILE);
  const txId = Date.now().toString(36) + '-' + process.pid;
  const snapDir = path.join(dir, 'txn-' + txId);
  const journal = { txId, label: label || '', pid: process.pid, startedAt: new Date().toISOString(), dir: snapDir, entries: [] };
  fs.mkdirSync(snapDir, { recursive: true });
  writeJournal(journalPath, journal);
  let n = 0;
  let done = false;

  function snapshot(file) {
    if (done) throw new Error('[事务] 已结束的事务不能再写');
    if (journal.entries.some(e => e.file && e.file.toLowerCase() === String(file).toLowerCase())) return;
    const abs = path.resolve(String(file));
    let snap = null;
    if (fs.existsSync(abs)) {
      snap = path.join(snapDir, String(++n).padStart(4, '0') + '-' + path.basename(abs).replace(/[^\w.\u4e00-\u9fa5-]/g, '_'));
      fs.copyFileSync(abs, snap);
    }
    journal.entries.push({ file: abs, snap });
    writeJournal(journalPath, journal);
  }

  /* ★ 2026-11-05（复核 P0-3）：登记"本事务新建的目录"。回滚时文件先删，目录随后**仅在为空时** rmdir，
     这样入库这类"建卡目录 + 写若干文件"的操作回滚后不会留下空卡目录；目录里若有别人放进去的东西则原样保留。
     只登记**调用前不存在**的目录（存在的目录不属于本事务）。 */
  function trackDir(dir) {
    if (done) throw new Error('[事务] 已结束的事务不能再写');
    const abs = path.resolve(String(dir));
    if (fs.existsSync(abs)) return;
    journal.entries.push({ dir: abs });
    writeJournal(journalPath, journal);
  }

  return {
    id: txId,
    snapshot,
    trackDir,
    mkdir(dir) { trackDir(dir); fs.mkdirSync(dir, { recursive: true }); return dir; },
    writeJson(file, obj, opts) { snapshot(file); return writeJsonAtomic(file, obj, opts); },
    writeText(file, text, opts) { snapshot(file); return writeTextAtomic(file, text, opts); },
    commit() {
      if (done) return;
      done = true;
      try { fs.unlinkSync(journalPath); } catch { }
      try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { }
    },
    rollback() {
      if (done) return null;
      done = true;
      const r = rollbackJournal(journal);
      /* ★ 2026-10-31（codex B01，实测复现）：**回滚自身失败时绝不能删日志与留档**。
         原实现无条件 unlink 日志 + rm 留档，于是"A 恢复成功、B 恢复失败（占用/权限/磁盘）"
         这一现场变成：A 已是旧值、B 仍是新值，而能支撑下次重试的材料被自己删光了 ——
         半更新既没被修好、也失去了自动恢复的依据（下次启动那条路只剩"没有日志"）。
         判据：`failed.length` 非空 ⇒ 保留 journal 与 snapDir，返回给调用方去大声报错；
         下一次取锁时 recoverTransactions() 会自动再试一次（真解决了就清掉）。 */
      if (r.failed.length) {
        console.error('[事务] ⚠ 回滚未完成（' + r.failed.length + ' 个文件恢复失败），已**保留**事务日志与留档以便下次重试：' + r.failed.join('；'));
        return r;
      }
      try { fs.unlinkSync(journalPath); } catch { }
      try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { }
      return r;
    },
  };
}

function writeJournal(journalPath, journal) {
  // 日志本身也必须原子：半截日志比没有日志更危险（回滚时读不出 → 只能放弃回滚）
  const tmp = journalPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 1), 'utf8');
  renameWithRetry(tmp, journalPath);
}

function rollbackJournal(j) {
  let restored = 0, removed = 0, failed = [];
  for (const e of (j.entries || []).slice().reverse()) {
    try {
      /* ★ 2026-10-31（codex B01）：恢复也必须**原子替换**。
         原实现 `copyFileSync(snap, file)` 直接覆盖目标：恢复跑到一半被打断（断电/taskkill/占用）
         会留下**半截真源** —— 那比"恢复失败"更糟（失败至少还能再试一次）。
         与 writeJsonAtomic 同口径：同目录临时文件 → rename 覆盖，失败则目标原样。 */
      if (e.dir) { try { fs.rmdirSync(e.dir); removed++; } catch (de) { if (de.code !== 'ENOENT' && de.code !== 'ENOTEMPTY' && de.code !== 'EEXIST') throw de; } continue; }
      if (e.snap) { restoreFileAtomic(e.snap, e.file); restored++; }
      else if (fs.existsSync(e.file)) { fs.unlinkSync(e.file); removed++; }
    } catch (err) { failed.push(e.file + '：' + err.message); }
  }
  return { txId: j.txId, label: j.label, restored, removed, failed };
}

/** 用留档覆盖目标（原子：同目录临时件 + rename；绝不"先删目标再拷"） */
function restoreFileAtomic(snapshotPath, targetPath) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, path.basename(targetPath) + '.restore-' + process.pid + '-' + Date.now());
  try {
    fs.copyFileSync(snapshotPath, tmp);
    renameWithRetry(tmp, targetPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { }
    throw e;
  }
}

/** 启动时（拿到锁之后）检查有没有上次没做完的事务：有就回滚并**大声报告** */
export function recoverTransactions(root) {
  const dir = stateDirOf(root);
  return recoverTransactionsIn(dir, root);
}

/** recoverTransactions 的目录参数版（H2 迁移用：老 %TEMP% 目录里的遗留事务也要先回滚再搬家）。 */
function recoverTransactionsIn(dir, root) {
  const journalPath = path.join(dir, JOURNAL_FILE);
  if (!fs.existsSync(journalPath)) return '';
  const j = readLockJsonSafe(journalPath);
  if (!j) {
    try { fs.unlinkSync(journalPath); } catch { }
    return '发现一个读不出来的事务日志，已丢弃（无法自动回滚，请人工核对该库最近的真源改动）';
  }
  if (Number(j.pid) === process.pid) return '';       // 同一进程内的上一次事务（理论上不会留）
  const r = rollbackJournal(j);
  /* ★ 2026-10-31（codex B01）：回滚有失败项时**不删日志/留档**，并明确要求人工介入。
     原实现无论成败都 unlink+rm ⇒ 失败现场连"下次再试"的机会都没有。 */
  if (r.failed.length) {
    return '发现上次未完成的写事务（' + (j.label || '未标注') + ' · ' + j.startedAt + '），回滚**未完成**：' +
      '已恢复 ' + r.restored + ' 个文件、删除 ' + r.removed + ' 个新建文件，但 ' + r.failed.length + ' 个失败：' + r.failed.join('；') +
      '。事务日志与留档已保留（下次取锁会重试）——请先关掉占用这些文件的程序，再重跑一次。';
  }
  try { fs.unlinkSync(journalPath); } catch { }
  try { fs.rmSync(j.dir, { recursive: true, force: true }); } catch { }
  return '发现上次未完成的写事务（' + (j.label || '未标注') + ' · ' + j.startedAt + '），已回滚：' +
    '恢复 ' + r.restored + ' 个文件、删除 ' + r.removed + ' 个新建文件' +
    '。这是"要么全成要么全退"在起作用：那次操作没有生效，请重做一次。';
}

/* ★ 2026-11-05（复核 P0-1 / P0-2 / P2-5）：旧布局迁移，**只在已持新锁时**由 onAcquired() 调用。
   修前的三个缺陷与对应修法：
     ① 迁移写在 stateDirOf() 里 ⇒ 没持锁就回滚，连只读探针 lockPathOf() 都会触发；两个进程能同时
        回滚同一份旧日志。→ 只在持锁后调用；新锁对同一个库是互斥的，同库迁移天然串行。
     ② 迁移完 rmSync 整个 %TEMP%\glimmernote-write-state ⇒ **别的库**还没迁的 journal 一起被删。
        → 只动本库自己的 <key> 目录；父目录只在空了时 rmdirSync（非递归，非空就失败、什么也不删）。
     ③ 旧日志的持有进程可能是**还在跑的旧版本工具**（它持的是旧位置的锁，新锁挡不住它）。
        → 旧日志 pid 还活着 ⇒ 本轮不碰，下次取锁再试。
   CTB_TXN_DIR 覆盖时同样检查旧位置（修前 `if (!custom)` 跳过 ⇒ 旧事务永远孤儿）。 */
function legacyStateBases() {
  const bases = [path.join(process.env.CTB_LEGACY_TXN_BASE || os.tmpdir(), 'glimmernote-write-state')];   // ≤ 2026.11.04.xx
  const lad = String(process.env.LOCALAPPDATA || '').trim();
  if (lad) bases.push(path.join(lad, 'GlimmerNote', 'write-state'));  // 2026.11.05.01
  return bases;
}
function migrateLegacyState(root) {
  const key = crypto.createHash('sha1').update(String(root).toLowerCase()).digest('hex').slice(0, 16);
  const here = path.resolve(stateDirOf(root));
  const msgs = [];
  for (const legacyBase of legacyStateBases()) {
    const legacyDir = path.join(legacyBase, key);
    if (path.resolve(legacyDir) === here) continue;
    if (!fs.existsSync(legacyDir)) { if (fs.existsSync(legacyBase)) removeEmptyLegacyParents(legacyBase); continue; }
    const m = migrateOneLegacyDir(root, legacyBase, legacyDir);
    if (m) msgs.push(m);
  }
  return msgs.join('；');
}
/** 父目录只在空了时删（非递归 rmdir，非空就失败、什么也不删 —— 别的库还没迁的正是要留着的） */
function removeEmptyLegacyParents(legacyBase) {
  for (let d = legacyBase, i = 0; i < 2; i++, d = path.dirname(d)) {
    if (i === 1 && path.basename(d) !== 'GlimmerNote') break;   // 只多删一层 GlimmerNote\，绝不往上
    try { fs.rmdirSync(d); } catch { break; }
  }
}
function migrateOneLegacyDir(root, legacyBase, legacyDir) {
  let msg = '';
  const legacyJournal = path.join(legacyDir, JOURNAL_FILE);
  if (fs.existsSync(legacyJournal)) {
    const j = readLockJsonSafe(legacyJournal);
    if (j && Number(j.pid) !== process.pid && pidAlive(Number(j.pid))) {
      return '旧位置(' + legacyBase + ')有一份事务日志，其进程 ' + j.pid + ' 仍在运行（可能是旧版本工具），本轮不迁移，下次取锁再试';
    }
    msg = recoverTransactionsIn(legacyDir, root);
    if (fs.existsSync(legacyJournal)) {
      /* 回滚失败（日志被刻意保留）：旧目录原样留着，下次再试；绝不删恢复材料 */
      return '旧位置(' + legacyBase + ')的未完成事务回滚未完成，旧目录保留：' + msg;
    }
  }
  const legacyLock = readLockFile(path.join(legacyDir, LOCK_FILE));
  if (legacyLock && pidAlive(Number(legacyLock.pid))) {
    return (msg ? msg + '；' : '') + '旧位置(' + legacyBase + ')的锁仍被进程 ' + legacyLock.pid + ' 持有，旧目录暂不删除';
  }
  try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { }
  removeEmptyLegacyParents(legacyBase);
  return msg ? '旧位置(' + legacyBase + ')发现未完成事务：' + msg : '';
}

function readLockJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 一步到位的"持锁 + 事务"包装（工具入口常用）：
 *   const done = withLibWrite(ROOT, '_标记复习 批改', (tx, release) => { ... return '成功信息'; });
 */
export function withLibWrite(root, label, fn, { timeoutMs } = {}) {
  const release = acquireLibLock(root, { label, timeoutMs });
  const tx = openTransaction(root, { label });
  try {
    const out = fn(tx, release);
    tx.commit();
    return out;
  } catch (e) {
    const r = tx.rollback();
    if (r && (r.restored || r.removed)) {
      console.error('[事务] 写失败，已整体回滚（恢复 ' + r.restored + '、删除 ' + r.removed + '）：' + (e && e.message));
    }
    throw e;
  } finally {
    release();
  }
}
