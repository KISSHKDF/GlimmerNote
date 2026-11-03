#!/usr/bin/env node
/**
 * 错题本 · 状态包刷新器（v3，2026-10-07）
 *
 * 背景：v3 起首页改为「运行时取数」——桌面壳与网络服务不再依赖「重跑生成器重建整个 HTML」，
 *       而是读取/刷新 _状态.json（生成器的孪生产物：同一批数据，机器消费）。
 * 本工具 = _状态.json 的分区刷新器：哪个数据源变了就刷哪个分区，避免整跑 PowerShell 生成器。
 *
 * 用法：node _状态刷新.mjs [pending|pending-if-stale|all]     # 缺省 pending
 *   pending         : 重跑 _待确认.mjs 门禁 --json，替换 .pending 分区并写盘（办结/新增待办后调用，毫秒级）
 *   pending-if-stale: 同上，但先比对 `_待确认.json` 的内容哈希——没变就**不 spawn、不写盘**（BUG-16 修；
 *                     服务端 GET 走这一支，杜绝"读接口每次写 1.35MB"）
 *   all     : 重跑 _生成首页.ps1（全量，秒级；数据/组卷台账变化时由服务端直接调生成器，不走这里）
 *
 * stdout = 刷新后的完整 _状态.json（严格 JSON，服务端/桌面壳直接当响应体回给页面）。
 * 单一实现原则：各分区数据仍由对应工具（门禁 --json 等）产出，这里只做拼装，不复制业务逻辑。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { libraryRoot, toolPath } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic, acquireLibLock } from './_安全写.mjs';
import { resolver, encRel } from './_原图寻址.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 现在是**用户库根**，不再是"本脚本所在目录"。
   兄弟工具一律用 toolPath(...)，见 _库根.mjs。 */
const ROOT = libraryRoot();
/* ★ 2026-10-30（外部审计 D02）：跨进程写锁（壳 / HTTP 服务端 / 命令行三条通道共用同一把，见 _安全写.mjs）。
   本工具是「读出来 → 改内存 → 写回去」的模式：没有这把锁时，另一个通道可以在两者之间插进来，
   两边各写一份原子文件，**后完成的那个把前一个的修改整段丢掉**（审计复现的现场）。
   锁从进程启动持有到退出（工具都是短命进程，登记式持锁最省事也最少漏）。 */
const __releaseLibLock = acquireLibLock(ROOT, { label: '_状态刷新' });
process.on('exit', __releaseLibLock);
const STATE = path.join(ROOT, '_状态.json');
const PENDING = path.join(ROOT, '_待确认.json');
const section = process.argv[2] || 'pending';

function readState() {
  /* BUG-15（2026-10-11）：这里原先用裸 `JSON.parse(fs.readFileSync(STATE,'utf8'))`——
     JSON.parse 不容忍 BOM（实测 `JSON.parse("\uFEFF{}")` 抛 "Unexpected token"）。
     `_状态.json` 一旦被带 BOM 的通道改写一次（典型：PowerShell `Set-Content -Encoding UTF8`，
     见教训 L-146），本文件就在**每一次 `GET /api/state`** 抛错 → 服务端 500 → 页面取数整体不可用。
     改用 `_安全写.mjs` 的 `readJsonStrict`（剥 BOM + 失败即抛带恢复途径的错误），与其余 5 个工具统一。 */
  return readJsonStrict(STATE, { label: '_状态.json' });
}
function writeState(s) {
  s.generatedAt = new Date().toISOString();
  /* 原子写：_状态.json 有 1.3MB，且 `GET /api/state` 每次都刷新它；
     旧写法直接覆盖，刷新途中被 taskkill 就留半截 JSON → 壳/前端白屏（BUG-01）。 */
  writeJsonAtomic(STATE, s, { backup: false });
}

/* ---------- BUG-16：pending 分区的新鲜度指纹（按需刷新，不再"每次 GET 都写盘"） ----------
   判据 = 内容哈希（sha1 前 16 位）+ mtimeMs + size，写进 `_状态.json._pendingSrc`。
   为什么用哈希而不是只比 mtime：mtime 可被"同一毫秒内的重写""touch 改时间不改内容"骗过
   （本仓已有教训 L-332 同族：只比时间戳的判据会在原地重写时失效）；哈希是内容级判据。
   `_pendingSrc` 是**附加字段**，前端不消费（v2/v1 只读 data/papers/pending/blindFresh/figState/
   dataHealth/admit）；生成器重写 `_状态.json` 时会把它丢掉 → 下次判定视为"无记录 = 过期"，
   多刷新一次（不是每次），宁可多刷一次也不漏。 */
function pendingFingerprint() {
  const st = fs.statSync(PENDING);
  const raw = fs.readFileSync(PENDING);
  return { mtimeMs: st.mtimeMs, size: st.size, hash: crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) };
}
function pendingIsFresh(s, fp) {
  const rec = s && s._pendingSrc;
  if (!rec) return false;                                   // 无记录（含生成器刚重写过状态包）→ 保守刷新一次
  if (rec.hash && rec.hash === fp.hash) return true;         // 内容级判据
  return rec.mtimeMs === fp.mtimeMs && rec.size === fp.size;  // 老记录无 hash：退化为 stat 判据
}
function refreshPending() {
  /* 门禁语义：有未确认项 → 退出码 1（但 stdout 仍是完好 JSON）。0/1 都要当成功解析。 */
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [toolPath('_待确认.mjs'), '门禁', '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    stdout = String((e.stdout || '') );
    if (!stdout.trim()) throw e;
  }
  return extractJson(stdout);
}
/* 门禁 --json 的 stdout 应为纯 JSON；容错：截取首个 { 到最后一个 } */
function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('输出不含 JSON：' + text.slice(0, 200));
  return JSON.parse(text.slice(a, b + 1));
}

/* ---------- 原图路径自愈（2026-11-01 缺陷修复，真库实测锚点） ----------
   本工具是"读旧包 → 改一处分区 → 写回"，它**不重解析** `origPage`/`origImport`；
   而带兜底寻址的 `生成状态.mjs` 只在**显式重建**时跑（`_服务端.mjs` 的 `doRebuild()`）。
   后果（2026-11-01 真库实测）：只要上一次全量生成发生在兜底寻址那版之前，包里的死路径
   就会被"刷新"着一直活下去 —— `generatedAt` 天天是新的，字段却是旧的（452 张卡全无
   `origResolve`；抽样 3 张整页原卷 2 张破图，而字节其实都在保全库 `_原图\` 里）。
   修法：写回前扫一遍卡片的这两个字段，路径不在盘上就按内容从保全库找回：
   找回 → 换成可达路径 + 写 `via`；找不回 → 写 `'lost'`（可见，绝不静默）。
   路径还在的卡零 IO（`resolver()` 内部直接 stat 返回 `direct`）。 */
function healOrigPaths(s) {
  const cards = [];
  for (const k of s.data || []) for (const sub of k.subjects || []) for (const c of sub.items || []) cards.push(c);
  if (!cards.length) return 0;
  let R = null, n = 0;
  for (const c of cards) {
    for (const pair of [['origPage', 'origResolve'], ['origImport', 'origImportResolve']]) {
      const f = pair[0], rf = pair[1];
      if (!c[f]) continue;
      let rel = c[f];
      try { rel = decodeURIComponent(rel); } catch (e) { /* 不是合法百分号编码就按原样试 */ }
      if (!R) R = resolver();                    // 反查表只建一次（452 张卡共用）
      const r = R.resolve(rel);
      if (r) {
        const want = encRel(r.path);
        /* ★ 只在**路径真的变了**时才写 via：本工具读到的是"状态包里的路径"（可能已经是
           保全库路径），而生成器读到的是"台账里的路径"（收件箱老路径）。若这里对同一个路径
           重算 via，同一个文件会被两个写入方交替标成 direct/store（churn，且语义打架）。
           口径统一为：路径变了才换并记 via；路径没变只在缺 via 时补一个。 */
        if (c[f] !== want) { c[f] = want; c[rf] = r.via; n++; }
        else if (!c[rf]) { c[rf] = r.via; n++; }
      } else {
        /* ★ 2026-11-03（task-15）：找不回 ⇒ 写 `'lost'` **并把路径清成 null**。
           只标 `'lost'` 不清路径时，状态包里留着一个打不开的死路径（旧包还可能是生成器写的
           字符串 `"null"`），而消费侧 `model.js:895` 只看 `c.origPage` 的真假
           ⇒ 界面照样去取那张不存在的图（破图），`'lost'` 这个标记**没有任何消费方看得见**
           —— 注释里那句"可见，绝不静默"原本是落空的。
           清成 null 后消费侧落到"未定位"，与 `生成状态.mjs`（同样写 null + `'lost'`）口径一致，
           取值集合与 `docs\原图保全.md` 的 {direct, store, lost} 对齐。
           台账 `_原卷台账.json` 里那条原始路径**不动**：真源在那儿，随时可查。 */
        let ch = false;
        if (c[rf] !== 'lost') { c[rf] = 'lost'; ch = true; }
        if (c[f]) { c[f] = null; ch = true; }
        if (ch) n++;
      }
    }
  }
  return n;
}

let state = readState();
if (section === 'pending' || section === 'pending-if-stale') {
  const fp = pendingFingerprint();
  const fresh = section === 'pending-if-stale' && pendingIsFresh(state, fp);
  const healed = healOrigPaths(state);
  if (fresh && healed === 0) {
    /* 台账没变**且**原图路径无需自愈 → 不 spawn `_待确认.mjs`、不写盘，直接把现状回给调用方。
       调用方（`_服务端.mjs` GET）因此拿到的是**最新的** pending：既然台账没动，
       `_状态.json` 里的 pending 就是最新（`_pendingSrc` 记录的那一版）。 */
    process.stderr.write('[pending] 台账未变（hash=' + fp.hash + '），且原图路径无需自愈，跳过刷新与写盘\n');
  } else {
    if (!fresh) {
      state.pending = refreshPending();
      state._pendingSrc = fp;
    }
    writeState(state);
    if (healed) process.stderr.write('[pending] 原图路径自愈 ' + healed + ' 处（按内容从保全库找回，台账未改）\n');
  }
} else if (section === 'all') {
  const r = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', toolPath('_生成首页.ps1')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
  state = readState();           // 生成器已重写 _状态.json，重读即可
  process.stderr.write(r.slice(-400));
} else {
  process.stderr.write('未知分区：' + section + '（可用 pending|pending-if-stale|all）\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify(state));
