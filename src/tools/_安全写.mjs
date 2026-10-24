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

/** 目录里有无「看起来像这次写坏的」残留临时文件（供自检/体检用） */
export function findStaleTemps(dir) {
  try { return fs.readdirSync(dir).filter(n => /\.tmp-\d+-\d+$/.test(n)); }
  catch { return []; }
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
 * 原子写 JSON：同目录临时文件 → fsync → rename 覆盖。
 * 任何一步失败都**不碰目标文件**（这正是它比 writeFileSync 安全的地方）。
 */
export function writeJsonAtomic(file, obj, { backup = false, keep = DEFAULT_KEEP, newline = true, indent = 2 } = {}) {
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
