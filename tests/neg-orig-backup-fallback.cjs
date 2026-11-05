#!/usr/bin/env node
/**
 * 原图寻址的**影像备份兜底层**（2026-11-05 建）
 *
 * 缺陷原形（真库实测踩到的）：
 *   用户按「凡是确认重复的就删掉」清理收件箱里的重复照片。
 *   那些照片**不是多余文件** —— 它们是 52 张卡（M0142–M0167）的**溯源依据**
 *   （台账的 page/import 全指向它们）。删掉之后：
 *     · 台账报「导入原件失效」52 条 ⇒ 溯源断链；
 *     · 原来的两条找回路径都兜不住：
 *         ① 保全库 `_原图\`（内容寻址、跨盘）—— 这批照片**没进过**（0/14）；
 *         ② 影像备份 `_影像备份\原件\<同路径>`（同盘、按目录结构平铺）—— **明明有**，
 *            但 `_原图寻址.mjs` 的 explain() **根本不查它**。
 *   一次完全正当的清理，就把 52 张卡的溯源打断了。
 *
 * 本用例守三条：
 *   ① 保全库查不到 ⇒ 必须去影像备份按**同路径**找（并核对字节数）；
 *   ② 字节数不符 ⇒ **不给**这条路径（宁可说"断了"，也不给一个内容不符的文件）；
 *   ③ 阴性自证：摘掉兜底层 ⇒ 断言① 必须当场变红。
 *
 * 用法：node tests\neg-orig-backup-fallback.cjs
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
const ENGINE = path.join(ROOT, 'src', 'tools', '_原图寻址.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-backupfb-'));
const LIB = path.join(TMP, 'lib');
const REL = '_收件箱/批次甲/p01.png';

function makeLib() {
  /* 收件箱里的一张照片 */
  const inbox = path.join(LIB, '_收件箱', '批次甲');
  fs.mkdirSync(inbox, { recursive: true });
  const img = pngGray(200, 160, (x, y) => (x * 7 + y * 13) % 251);
  fs.writeFileSync(path.join(inbox, 'p01.png'), img);

  /* 影像备份里有**同路径**副本（逐字节相同）—— 保全库里则**没有** */
  const bk = path.join(LIB, '_影像备份', '原件', '_收件箱', '批次甲');
  fs.mkdirSync(bk, { recursive: true });
  fs.copyFileSync(path.join(inbox, 'p01.png'), path.join(bk, 'p01.png'));

  /* 台账：登记这个路径 → 它的 sha（内容寻址反查表靠 sources 字段） */
  const sha = crypto.createHash('sha256').update(img).digest('hex').toUpperCase();
  fs.writeFileSync(path.join(LIB, '_原图台账.json'), JSON.stringify({
    version: 1, note: 'test',
    objects: { [sha]: { bytes: img.length, ext: 'png', addedAt: '2026-01-01T00:00:00Z', sources: [REL], names: ['p01.png'] } },
  }, null, 1) + '\n', 'utf8');

  return { img, sha };
}

/** 跑一次 explainPath 并取回 JSON。
 *  ⚠ 用**脚本文件**而不是 `node -e`：`-e` 跑 ESM 时相对 import 的解析基准不是仓库根，
 *  会在 load 阶段就失败（实测 exit=1 + esm/load 报错）——看起来像"引擎坏了"，其实是调用方式不对。 */
function runExplain(lib, engine) {
  const probe = path.join(path.dirname(lib), 'probe.mjs');
  /* ⚠ Windows 上 ESM 的 `import()` 只接受 **file:// URL**（绝对路径 'D:\\…' 会报
     ERR_UNSUPPORTED_ESM_URL_SCHEME：Received protocol 'd:'）。所以这里要转 URL。 */
  const engineUrl = 'file:///' + String(engine || ENGINE).replace(/\\/g, '/').replace(/^\/+/, '');
  fs.writeFileSync(probe, [
    'process.env.CTB_DATA = ' + JSON.stringify(lib) + ';',
    'const m = await import(' + JSON.stringify(engineUrl) + ');',
    "const ex = m.explainPath('_收件箱/批次甲/p01.png', { expectBytes: null });",
    'console.log(JSON.stringify(ex));',
  ].join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [probe], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { }
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json };
}

function main() {
  console.log('临时库：' + LIB + '\n引擎：' + path.relative(ROOT, ENGINE) + '\n');
  const { img } = makeLib();
  const srcFile = path.join(LIB, '_收件箱', '批次甲', 'p01.png');
  const bkFile = path.join(LIB, '_影像备份', '原件', '_收件箱', '批次甲', 'p01.png');

  console.log('\n══ ① 原路径不在盘 + 保全库没有 ⇒ 必须从影像备份的同路径副本找回 ══');
  {
    /* 先把收件箱里的原文件删掉（模拟"用户清理了收件箱"） */
    fs.unlinkSync(srcFile);
    const r = runExplain(LIB);
    A('① 前置：引擎真跑', r.code === 0 && !!r.json, 'exit=' + r.code + ' ' + r.err.split('\n')[0].slice(0, 100));
    A('★★ ① 找回成功（status=backup，路径指向影像备份）',
      !!(r.json && r.json.status === 'backup' && /_影像备份\/原件\//.test(String(r.json.path || ''))),
      JSON.stringify(r.json));
    A('★ ① 找回的路径在盘上且字节数相符',
      !!(r.json && r.json.path && fs.existsSync(path.join(LIB, r.json.path)) &&
        fs.statSync(path.join(LIB, r.json.path)).size === img.length),
      (r.json && r.json.path) || '');
  }

  console.log('\n══ ② 备份里的副本字节数不符 ⇒ 不许给这条路径 ══');
  {
    /* 把备份里的副本改小（内容变了）⇒ 字节数对不上 */
    fs.writeFileSync(bkFile, Buffer.alloc(10));
    const r = runExplain(LIB);
    A('★★ ② 字节数不符 ⇒ 不返回 backup 路径',
      !(r.json && r.json.status === 'backup'),
      'status=' + (r.json && r.json.status) + ' reason=' + String((r.json && r.json.reason) || '').slice(0, 100));
  }

  console.log('\n══ ③ 阴性自证：摘掉影像备份兜底层 ⇒ 断言① 必须当场变红 ══');
  {
    const ORIG = fs.readFileSync(ENGINE, 'utf8');
    const ANCHOR = 'function lookupBackup(rel, sha) {';
    const hits = ORIG.split(ANCHOR).length - 1;
    A('③ 前置：兜底层锚点存在且唯一', hits === 1, '出现 ' + hits + ' 次');
    /* 把 lookupBackup 改成永远返回 null —— 相当于"没有这一层" */
    const mut = ORIG.replace(
      /function lookupBackup\(rel, sha\) \{[\s\S]*?\n\}/,
      'function lookupBackup(rel, sha) {\n  return null;   // 变异：摘掉影像备份兜底层\n}'
    );
    A('③ 前置：变异真的发生了（不是空操作）', mut !== ORIG && mut.includes('变异：摘掉影像备份兜底层'));
    A('③ 前置：变异只动一处，行数变化小', Math.abs(mut.split('\n').length - ORIG.split('\n').length) < 60,
      ORIG.split('\n').length + ' 行 → ' + mut.split('\n').length + ' 行');

    /* 恢复备份副本的正常内容 */
    fs.writeFileSync(bkFile, img);

    /* 变异体要能独立跑：复制它与依赖 */
    const deps = new Set();
    const queue = ['_原图寻址.mjs'];
    while (queue.length) {
      const f = queue.shift();
      if (deps.has(f)) continue;
      const src = path.join(ROOT, 'src', 'tools', f);
      if (!fs.existsSync(src)) continue;
      deps.add(f);
      const body = f === '_原图寻址.mjs' ? mut : fs.readFileSync(src, 'utf8');
      for (const m of body.matchAll(/from\s+'\.\/([^']+\.mjs)'/g)) if (!deps.has(m[1])) queue.push(m[1]);
    }
    const mutDir = path.join(TMP, 'mut');
    fs.mkdirSync(mutDir, { recursive: true });
    for (const f of deps) fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(mutDir, f));
    const mutEngine = path.join(mutDir, '_原图寻址.mjs');
    fs.writeFileSync(mutEngine, mut, 'utf8');
    const chk = spawnSync(process.execPath, ['--check', mutEngine], { encoding: 'utf8' });
    A('③ 前置：变异体语法自检通过（node --check）', chk.status === 0,
      String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));

    const r2 = runExplain(LIB, mutEngine);
    A('★★ ③ 阴性自证：旧逻辑下**不再**从影像备份找回（即断言★① 会当场变红）',
      !(r2.json && r2.json.status === 'backup'),
      'status=' + (r2.json && r2.json.status) + ' reason=' + String((r2.json && r2.json.reason) || '').slice(0, 90));
    A('③ 仓库里的真源码未被改动（变异只在临时副本上做）', fs.readFileSync(ENGINE, 'utf8') === ORIG);
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
