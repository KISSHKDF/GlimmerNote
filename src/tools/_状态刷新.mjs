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
import { readJsonStrict, writeJsonAtomic } from './_安全写.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 现在是**用户库根**，不再是"本脚本所在目录"。
   兄弟工具一律用 toolPath(...)，见 _库根.mjs。 */
const ROOT = libraryRoot();
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

let state = readState();
if (section === 'pending' || section === 'pending-if-stale') {
  const fp = pendingFingerprint();
  if (section === 'pending-if-stale' && pendingIsFresh(state, fp)) {
    /* 台账没变 → 不 spawn `_待确认.mjs`、不写盘，直接把现状回给调用方。
       调用方（`_服务端.mjs` GET）因此拿到的是**最新的** pending：既然台账没动，
       `_状态.json` 里的 pending 就是最新（`_pendingSrc` 记录的那一版）。 */
    process.stderr.write('[pending] 台账未变（hash=' + fp.hash + '），跳过刷新与写盘\n');
  } else {
    state.pending = refreshPending();
    state._pendingSrc = fp;
    writeState(state);
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
