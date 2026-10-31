#!/usr/bin/env node
/**
 * 收件箱「转置件」判据必须有内容证据（C02 · P2）阴性对照（2026-10-31 建）
 *
 * 缺陷原形（`src\tools\_配方.mjs` 的 inboxTransposedSet）：
 *   把"收件箱某件的尺寸与某个**已处理**件互为转置（w×h ↔ h×w）+ 体积同量级（0.5~2.0）"
 *   直接当成"同一张照片的两种姿态 ⇒ 已处理"，于是：
 *     台账引用过 1200×1600 的 A；收件箱放一张**内容无关**、恰好 1600×1200、体积比 1.000 的 B
 *     ⇒ B 从**待处理清单**里消失（消费者 `arch.transposed.has(...)` 直接进 archHere）。
 *   尺寸改成 1600×1201 或体积比 0.002 就不消失 —— 说明判据当时只看了尺寸与体积。
 *   性质是"贴错标签"而不是"文件被吞"（界面有「显示已归档的 N 张」可展开、文件没搬没删），
 *   但方向错了：本仓纪律是"宁可多列，不可误藏"。
 *
 * 本用例守两条（在临时库上**真跑** `_配方.mjs 收件箱 --json`，绝不碰真库）：
 *   ① 无关照片（尺寸恰好互为转置、体积同量级、**字节不同**）⇒ 必须**仍在待处理清单**里；
 *   ② 正向对照（防"改成一律不隐藏"）：与已处理件**同一份字节**的副本 ⇒ 必须被判已处理。
 *      这一条不是凑数：同一份字节 ⇒ 尺寸必然相同 ⇒ 与"尺寸互为转置"物理互斥，
 *      **它正是"转置 + 内容证据"唯一可能的交集形态**，也是判据④之外不可删的兜底。
 *   ③ 阴性自证：把"必须有内容证据"这条摘掉（= 退回旧行为）⇒ 断言①必须当场变红。
 *
 * 用法：node tests\neg-inbox-transposed-evidence.cjs
 * 退出码：0=全绿；1=有断言失败
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pngGray } = require('../scripts/png-cjs.cjs');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_配方.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-transposed-'));
const LIB = path.join(TMP, 'lib');
const INBOX = path.join(LIB, '_收件箱');
const LIBPAGES = path.join(LIB, '原卷库');

/** 跑真引擎；库根同时走 --data 与 CTB_DATA（两条通道同口径，任一失效都看得见） */
function runInbox(toolPath, lib) {
  const r = spawnSync(process.execPath, [toolPath, '收件箱', '--json', '--data', lib], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: lib }),
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '')); } catch { }
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json };
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
/** PNG 尺寸（IHDR：宽在偏移 16、高在偏移 20）——用来证明素材真的构成"互为转置" */
function pngDims(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

function makeLib() {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(LIBPAGES, { recursive: true });
  /* A：已处理件（台账引用）。300×400，噪声图案 ⇒ PNG 体积落在"同量级"区间 */
  const a = pngGray(300, 400, (x, y) => (x * 3 + y * 7) % 251);
  fs.writeFileSync(path.join(LIBPAGES, 'A-已处理.png'), a);
  /* B：收件箱里的**无关**照片。尺寸恰好是 A 的转置（400×300），图案不同 ⇒ 字节不同 */
  const b = pngGray(400, 300, (x, y) => (x * 5 + y * 11) % 253);
  fs.writeFileSync(path.join(INBOX, 'B-无关照片.png'), b);
  /* C：正向对照。与 A **同一份字节**的副本（"同一张照片的两次拷贝"） */
  fs.writeFileSync(path.join(INBOX, 'C-同一份字节.png'), Buffer.from(a));
  /* 台账：只引用库内那两个"已处理"件 */
  fs.writeFileSync(path.join(LIB, '_原卷台账.json'), JSON.stringify({
    version: 1,
    cards: { '学生甲|K1': { page: '原卷库/A-已处理.png' } },
  }, null, 1) + '\n', 'utf8');
  return { a, b };
}

function main() {
  console.log('临时库：' + LIB + '\n引擎：' + path.relative(ROOT, ENGINE) + '\n');
  const { a, b } = makeLib();
  const dmA = pngDims(a), dmB = pngDims(b);

  console.log('══ ① 素材自证：这才配叫"尺寸互为转置 + 体积同量级 + 内容不同" ══');
  A('① A 是 300×400（已处理件）', dmA.w === 300 && dmA.h === 400, dmA.w + '×' + dmA.h);
  A('① B 是 400×300（与 A 互为转置）', dmB.w === 400 && dmB.h === 300, dmB.w + '×' + dmB.h);
  A('★ ① A 与 B **字节不同**（是两张无关照片，不是同一张的拷贝）', sha256(a) !== sha256(b),
    sha256(a).slice(0, 12) + ' vs ' + sha256(b).slice(0, 12));
  const ratio = a.length / b.length;
  A('★ ① 体积同量级（比值 0.5~2.0 ⇒ 旧判据的三个条件全部满足）', ratio >= 0.5 && ratio <= 2.0,
    'A=' + a.length + 'B, B=' + b.length + 'B, 比值=' + ratio.toFixed(3));

  /* ── 主判据 ── */
  console.log('\n══ ② 真跑：无关照片必须留在待处理清单 ══');
  const real = runInbox(ENGINE, LIB);
  A('② 前置：引擎真跑成功', real.code === 0 && !!real.json, 'exit=' + real.code + ' ' + String(real.err).split('\n')[0].slice(0, 90));
  const J = real.json || { batches: [], archived: [], total: -1 };
  const pending = [];
  for (const bt of (J.batches || [])) for (const f of (bt.files || [])) pending.push(f.name);
  const archived = (J.archived || []).map(f => f.name);
  A('★★ ② 尺寸互为转置但**内容不同** ⇒ 仍在待处理清单（旧缺陷：它会被贴上"已处理"）',
    pending.includes('B-无关照片.png'), '待办=' + JSON.stringify(pending));
  A('★ ② 也**不许**出现在已归档清单里', !archived.includes('B-无关照片.png'), '已归档=' + JSON.stringify(archived));
  A('★ ② 正向对照：与已处理件**同一份字节**的副本 ⇒ 判已处理（防"一律不隐藏"）',
    archived.includes('C-同一份字节.png') && !pending.includes('C-同一份字节.png'),
    '待办=' + JSON.stringify(pending) + ' 已归档=' + JSON.stringify(archived));
  A('② total 与待处理清单条数一致（角标口径不漂）', J.total === pending.length,
    'total=' + J.total + ' 待办=' + pending.length);

  /* ── 阴性自证 ── */
  console.log('\n══ ③ 阴性自证：摘掉"必须有内容证据"（= 退回"尺寸+体积即判已处理"）══');
  {
    const ORIG = fs.readFileSync(ENGINE, 'utf8');
    const ANCHOR = 'if (!transposedContentEvidence(shaOf(abs), c.abs, shaOf)) continue;';
    const hits = ORIG.split(ANCHOR).length - 1;
    A('③ 前置：阴性自证锚点存在且唯一', hits === 1, '出现 ' + hits + ' 次');
    const mutSrc = ORIG.replace(ANCHOR, 'if (false) continue;   // 变异：摘掉内容证据');
    A('③ 前置：变异真的发生了（不是空操作）', mutSrc !== ORIG && mutSrc.includes('变异：摘掉内容证据'));
    A('③ 前置：变异只动一行，行数不变（防"锚点打偏、整段被吃"）',
      mutSrc.split('\n').length === ORIG.split('\n').length,
      ORIG.split('\n').length + ' 行 → ' + mutSrc.split('\n').length + ' 行');

    const mutDir = path.join(TMP, 'mut');
    fs.mkdirSync(mutDir, { recursive: true });
    for (const f of ['_配方.mjs', '_库根.mjs']) fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(mutDir, f));
    const mutEngine = path.join(mutDir, '_配方.mjs');
    fs.writeFileSync(mutEngine, mutSrc, 'utf8');           // UTF-8 无 BOM + LF（源文件就是 LF）
    const chk = spawnSync(process.execPath, ['--check', mutEngine], { encoding: 'utf8' });
    A('③ 前置：变异体语法自检通过（node --check）', chk.status === 0,
      String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));

    const mut = runInbox(mutEngine, LIB);
    A('③ 变异体真跑成功', mut.code === 0 && !!mut.json, 'exit=' + mut.code);
    const archM = ((mut.json || {}).archived || []).map(f => f.name);
    const pendM = [];
    for (const bt of ((mut.json || {}).batches || [])) for (const f of (bt.files || [])) pendM.push(f.name);
    A('★★ 阴性自证：旧逻辑下无关照片**被归档**（即断言★★② 会当场变红）',
      archM.includes('B-无关照片.png'), '已归档=' + JSON.stringify(archM) + ' 待办=' + JSON.stringify(pendM));

    /* 不留半截改造：仓库里的真源码一个字节都没动过 */
    A('③ 仓库里的真源码未被改动（变异只在临时副本上做）', fs.readFileSync(ENGINE, 'utf8') === ORIG);
    try { fs.rmSync(mutDir, { recursive: true, force: true }); } catch { }
  }

  console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}`);
}

try {
  main();
} catch (e) {
  fail++;
  console.log('[FAIL] 用例自身抛错：' + (e && e.stack || e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
}
process.exit(fail ? 1 : 0);
