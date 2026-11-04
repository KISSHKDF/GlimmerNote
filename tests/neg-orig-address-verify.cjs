#!/usr/bin/env node
/**
 * 原图寻址 · 核字节 + 歧义（P1-2 / 施工方案 §3 P1-2，2026-11-03）
 *
 * 为什么必须有它：`_原图寻址.mjs` 是"清空收件箱也不会让任何一张卡断链"的唯一实现，
 * 而它有两个**静默**缺陷（真库实测有 460 条常量级兜底依赖它）：
 *   ① 原路径还在时只看 `statSync` 成功就判 `direct`：**`expectBytes` 与真实大小不符也照样
 *      "直接可用"**（旧代码那里是个空 if + 注释）⇒ 台账路径被复用成另一个文件时，
 *      调用方拿到的是**字节不符**的路径，而它看起来完全正常；
 *   ② 一个来源路径登记了**两个不同 sha** 时，反查表 `if (!rev.has(k)) rev.set(k, sha)`
 *      ＝**静默取第一个** ⇒ "按内容找回"变成"按运气找回"，猜错就是把另一份字节当成这张卡的整页。
 * 本用例守住"这两处不许再静默"，同时守住两条**必须保留**的既有语义：
 *   · **零 IO 常态**：`expectBytes` 为 null（热路径）或大小相符时，只 stat、**不读一个字节**；
 *   · 原兜底不可退化：路径失效 + 台账有唯一 sha + 对象在盘 ⇒ 仍要 `via='store'`。
 *
 * 阴性对照（有牙齿）：把 ① 掏掉 ⇒ 1c/1d/1e 变红；把 ② 掏掉 ⇒ 2b/2c/2d/2f/2g 变红。
 *   （实测红/绿两跑留档在会话工作区的 `work\glimmer-dsh-plan-20261102\原图寻址核字节-20261103.md`； 仓库内不写本机绝对路径）
 *
 * 夹具全部自建在 %TEMP%（E.allocTempDir 登记，退出即删）；**不读不写真库**。
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'src', 'tools', '_原图寻址.mjs');
/* 模块会把台账读进内存**缓存一次** ⇒ 所有台账条目必须在第一次解析前就写好；
   之后只允许"删/改磁盘上的文件"（每次 stat 都是实时的），不许再追加台账条目。 */

let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) fails++; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();

(async () => {
  const LIB = E.allocTempDir('gn-addr-verify-');
  A('夹具库在 %TEMP% 下（不碰真库 数据\\）', path.resolve(LIB).startsWith(path.resolve(os.tmpdir())), LIB);

  /* ══════════ 夹具：一个自建小库（台账 + 保全库 + 收件箱） ══════════ */
  const rel2abs = (rel) => path.join(LIB, rel.split('/').join(path.sep));
  const mk = (rel, buf) => { const p = rel2abs(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
  const storeName = (sha) => '_原图/' + sha.slice(0, 2).toLowerCase() + '/' + sha.toLowerCase() + '.bin';

  const CONTENT = {
    normal: Buffer.alloc(1000, 0x11),     // 正常件（大小相符、内容相符）
    reused: Buffer.alloc(1000, 0x99),     // 与 normal **同尺寸**、内容不同（模拟"路径被复用"）
    srcB: Buffer.alloc(2000, 0x33),       // 变小了.jpg 当初登记的内容（2000 字节）
    srcC: Buffer.alloc(700, 0x55),        // 歧义路径的 sha #1
    srcD: Buffer.alloc(800, 0x66),        // 歧义路径的 sha #2
    unique: Buffer.alloc(300, 0x77),      // "路径死了但台账有唯一 sha"那份
  };
  const SHA = {
    normal: sha256(CONTENT.normal),
    reused: sha256(CONTENT.reused),
    srcB: sha256(CONTENT.srcB),
    srcC: sha256(CONTENT.srcC),
    srcD: sha256(CONTENT.srcD),
    unique: sha256(CONTENT.unique),
    gone: sha256(Buffer.from('台账里有、保全库里没有的那份')),
    dupSecond: sha256(Buffer.from('dup2 的第二个 sha：保全库里没有它的对象')),
  };

  /* 收件箱里"现在的样子"（台账登记的是当初的样子） */
  mk('_收件箱/x/正常.jpg', CONTENT.normal);
  mk('_收件箱/x/同尺寸不同内容.jpg', CONTENT.reused);
  mk('_收件箱/x/变小了.jpg', Buffer.alloc(999, 0x22));   // 台账 2000 字节，盘上 999
  mk('_收件箱/x/找不回.jpg', Buffer.alloc(5, 0x44));     // 台账 5000 字节，盘上 5，且保全库无对象
  /* _收件箱/x/dup.jpg、dup2.jpg、唯一sha但路径死了.jpg **都不在盘**（走反查表那条路） */
  /* 保全库对象：SHA.gone / SHA.dupSecond 故意不落盘 */
  for (const k of ['normal', 'reused', 'srcB', 'srcC', 'srcD', 'unique']) mk(storeName(SHA[k]), CONTENT[k]);

  const objects = {};
  /* ⚠ 追加而不是覆盖：同一个 sha 后面还会挂上别的来源路径（dup2 那一条）。
     覆盖会让 dup.jpg 只剩一个 sha，歧义夹具就静默消失了（本用例首轮就这么假红过）。 */
  const addObj = (sha, sources, bytes) => {
    if (!objects[sha]) objects[sha] = { sha256: sha, bytes, ext: 'bin', sources: [] };
    for (const s of sources) if (!objects[sha].sources.includes(s)) objects[sha].sources.push(s);
  };
  addObj(SHA.normal, ['_收件箱/x/正常.jpg'], CONTENT.normal.length);
  addObj(SHA.reused, ['_收件箱/x/同尺寸不同内容.jpg'], CONTENT.reused.length);
  addObj(SHA.srcB, ['_收件箱/x/变小了.jpg'], CONTENT.srcB.length);
  addObj(SHA.gone, ['_收件箱/x/找不回.jpg'], 5000);
  addObj(SHA.unique, ['_收件箱/x/唯一sha但路径死了.jpg'], CONTENT.unique.length);
  addObj(SHA.srcC, ['_收件箱/x/dup.jpg'], CONTENT.srcC.length);            // 同路径两 sha（1/2）
  addObj(SHA.srcD, ['_收件箱/x/dup.jpg'], CONTENT.srcD.length);            // 同路径两 sha（2/2）
  addObj(SHA.srcC, ['_收件箱/x/dup2.jpg'], CONTENT.srcC.length);           // dup2：一个在盘、一个不在盘
  addObj(SHA.dupSecond, ['_收件箱/x/dup2.jpg'], 123);
  mk('_原图台账.json', Buffer.from(JSON.stringify({ version: 1, objects }, null, 1), 'utf8'));

  /* ★ CTB_DATA 必须在 import 之前落好：`_原图寻址.mjs` 顶层就 `libraryRoot()` 一次并缓存 */
  process.env.CTB_DATA = LIB;
  const M = await import(pathToFileURL(TOOL).href);
  A('模块可加载且 exports 齐全（resolveByPath/explainPath/shaOfPath/pathShas/resolver）',
    ['resolveByPath', 'explainPath', 'shaOfPath', 'pathShas', 'resolver'].every(k => typeof M[k] === 'function'),
    Object.keys(M).sort().join(','));

  /* 哈希计数器：`sha256File` 是模块里唯一的字节读取路径（走 crypto.createHash）。
     ⚠ 这条自证本身要有牙齿：1c 要求 hashed≥1（证明计数器真的活着），
        否则 1a/1b/1f 的 hashed===0 就是恒真。 */
  let hashed = 0;
  const realCreateHash = crypto.createHash;
  crypto.createHash = function (...a) { hashed++; return realCreateHash.apply(this, a); };

  /* ══════════ 1 · 核字节（fix ①） ══════════ */
  console.log('\n═══ 1 · 原路径在盘时**必须**核 expectBytes ═══');
  hashed = 0;
  const rNormal = M.resolveByPath('_收件箱/x/正常.jpg', { expectBytes: CONTENT.normal.length });
  A('1a 大小相符 ⇒ direct（常态不变）',
    !!rNormal && rNormal.via === 'direct' && rNormal.path === '_收件箱/x/正常.jpg', JSON.stringify(rNormal));
  A('1a 且**不读字节**（哈希调用=0；这是 452 张卡热路径的性能语义）', hashed === 0, 'hashed=' + hashed);

  hashed = 0;
  const rNoExpect = M.resolveByPath('_收件箱/x/正常.jpg');
  A('1b 不给 expectBytes ⇒ 零 IO 常态：仍 direct 且一次哈希都没发生',
    !!rNoExpect && rNoExpect.via === 'direct' && hashed === 0, JSON.stringify(rNoExpect) + ' hashed=' + hashed);

  hashed = 0;
  const rB = M.resolveByPath('_收件箱/x/变小了.jpg', { expectBytes: CONTENT.srcB.length });
  A('1c 大小不符（盘上 999 ≠ 台账 2000）+ 保全库有该 sha ⇒ **不再 direct**，按内容找回（via=store）',
    !!rB && rB.via === 'store' && rB.sha === SHA.srcB && /^_原图\//.test(String(rB.path)), JSON.stringify(rB));
  A('1c 且确实做了内容核对（走了保全库分支 ⇒ 哈希调用 ≥1，证明计数器活着）', hashed >= 1, 'hashed=' + hashed);

  const rGone = M.resolveByPath('_收件箱/x/找不回.jpg', { expectBytes: 5000 });
  A('1d 大小不符 + 保全库也没有 ⇒ null（绝不给一个字节不符的路径）', rGone === null, JSON.stringify(rGone));
  const exGone = M.explainPath('_收件箱/x/找不回.jpg', { expectBytes: 5000 });
  A('1e 且原因可归因：status=size-mismatch，reason 同点点名实测字节数与期望字节数',
    exGone.status === 'size-mismatch' && /字节数 5 ≠ 期望 5000/.test(String(exGone.reason)) && /真的断了/.test(String(exGone.reason)),
    exGone.status + ' | ' + String(exGone.reason).split('；')[0]);

  /* 回归·关键一条：**同尺寸不同内容** 仍必须是 direct ——
     若实现改成"连字节一起核对"，这里会变成 via=store（或 null）⇒ 红。
     它也顺带证明"expectBytes 只是大小筛，不做内容判"（性能口径被如实保留）。 */
  hashed = 0;
  const rReused = M.resolveByPath('_收件箱/x/同尺寸不同内容.jpg', { expectBytes: CONTENT.reused.length });
  A('1f 回归·同尺寸不同内容 ⇒ 仍 direct 且零哈希（快路径不读字节）',
    !!rReused && rReused.via === 'direct' && hashed === 0, JSON.stringify(rReused) + ' hashed=' + hashed);

  /* ══════════ 2 · 一路径两 sha（fix ②） ══════════ */
  console.log('\n═══ 2 · 一个路径对应两个 sha ⇒ 必须**歧义**，不许静默取第一个 ═══');
  const shasDup = M.pathShas('_收件箱/x/dup.jpg');
  A('2a pathShas 如实给出 2 个 sha（去重、排序）',
    shasDup.length === 2 && shasDup.includes(SHA.srcC) && shasDup.includes(SHA.srcD) && shasDup[0] < shasDup[1],
    shasDup.map(s => s.slice(0, 10)).join(','));
  A('2b shaOfPath 对歧义路径返回 null（旧实现返回第一个）', M.shaOfPath('_收件箱/x/dup.jpg') === null);

  /* 捕获 stderr：歧义必须**可见**，而且同一路径只喊一次（452 张卡的循环里不许刷屏） */
  const captured = [];
  const realWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { captured.push(String(chunk)); return realWrite.call(process.stderr, chunk, ...rest); };
  let rDup1 = null, rDup2 = null;
  try {
    rDup1 = M.resolveByPath('_收件箱/x/dup.jpg');
    rDup2 = M.resolveByPath('_收件箱/x/dup.jpg');
  } finally { process.stderr.write = realWrite; }
  A('2c 歧义 ⇒ resolveByPath 返回 null（fail-closed，不猜）', rDup1 === null && rDup2 === null, JSON.stringify(rDup1));
  const warnLines = captured.filter(s => /原图寻址/.test(s));
  A('2e 歧义**可见**：stderr 有一条点名"拒绝猜"的告警，且同一路径只喊一次（去重）',
    warnLines.length === 1 && /拒绝猜/.test(warnLines[0]) && /2 个不同 sha/.test(warnLines[0]),
    'warn行数=' + warnLines.length + ' | ' + String(warnLines[0] || '').trim().slice(0, 120));
  const exDup = M.explainPath('_收件箱/x/dup.jpg');
  A('2d explainPath 给结构化歧义结论（status=ambiguous + 两个 sha 都在 + reason 点明拒绝猜）',
    exDup.status === 'ambiguous' && Array.isArray(exDup.shas) && exDup.shas.length === 2 && /拒绝猜/.test(String(exDup.reason)),
    exDup.status + ' shas=' + (exDup.shas || []).length);

  /* 2f：一个 sha 的对象在盘、另一个不在 ⇒ **仍然**歧义（不许"挑还活着的那个"顶上） */
  A('2f 只有一个 sha 的对象在盘时**仍然**判歧义（不挑"还活着的"那个）',
    M.pathShas('_收件箱/x/dup2.jpg').length === 2 && M.resolveByPath('_收件箱/x/dup2.jpg') === null &&
    M.explainPath('_收件箱/x/dup2.jpg').status === 'ambiguous');

  /* 2g：批量版 resolver() 与单条版**同一判据**（原件里这里是第二套实现，口径会漂移） */
  const R = M.resolver();
  A('2g resolver().resolve 对歧义路径同样 null，explain 同为 ambiguous，shasOf=2，shaOfPath=null',
    R.resolve('_收件箱/x/dup.jpg') === null && R.explain('_收件箱/x/dup.jpg').status === 'ambiguous' &&
    R.shasOf('_收件箱/x/dup.jpg').length === 2 && R.shaOfPath('_收件箱/x/dup.jpg') === null);

  A('2h 非歧义路径 shaOfPath 仍返回那个 sha（没被改成恒 null）',
    M.shaOfPath('_收件箱/x/正常.jpg') === SHA.normal);

  /* ══════════ 3 · 既有兜底语义不许退化 ══════════ */
  console.log('\n═══ 3 · 既有语义（原兜底 / 无线索 / 空输入 / 批量版口径） ═══');
  const rStore = M.resolveByPath('_收件箱/x/唯一sha但路径死了.jpg');
  A('3a 原路径不在盘 + 台账有唯一 sha + 对象在盘 ⇒ 仍要 via=store（原兜底语义没退化）',
    !!rStore && rStore.via === 'store' && rStore.sha === SHA.unique && /^_原图\//.test(String(rStore.path)),
    JSON.stringify(rStore));
  A('3b 原路径不在盘 + 台账里没有任何线索 ⇒ null，且原因是 no-sha（可归因）',
    M.resolveByPath('_收件箱/x/查无此路径.jpg') === null && M.explainPath('_收件箱/x/查无此路径.jpg').status === 'no-sha');
  A('3c 空路径 ⇒ null（不抛）', M.resolveByPath('') === null && M.resolveByPath(null) === null);
  A('3d 批量版与单条版口径一致：大小不符的同一件都走 store；大小相符的同一件都 direct',
    R.resolve('_收件箱/x/变小了.jpg', CONTENT.srcB.length) && R.resolve('_收件箱/x/变小了.jpg', CONTENT.srcB.length).via === 'store' &&
    R.resolve('_收件箱/x/正常.jpg', CONTENT.normal.length) && R.resolve('_收件箱/x/正常.jpg', CONTENT.normal.length).via === 'direct');

  crypto.createHash = realCreateHash;
  console.log('');
  console.log('RESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + total + ' 失败=' + fails);
  /* E.allocTempDir 已登记（进程退出统一删）；这里再显式删一次，被杀时也不留 */
  try { fs.rmSync(LIB, { recursive: true, force: true }); } catch (e) { }
  process.exit(fails ? 1 : 0);
})();