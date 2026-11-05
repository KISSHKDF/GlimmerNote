#!/usr/bin/env node
/**
 * 分流器（`_分流器.mjs`）判重与分科的阴性对照（2026-11-05 建）
 *
 * 背景（用户场景）：「我把很多题目照片一起给你，但没有分课，语文数学各种学科混在一起，
 *   你能分门别类的挑出错题吗？」以及「一张照片我已经请你入过库了，后来忘了再录一次，
 *   你能分辨出来吗？」
 *
 * 本用例守四条（全部在临时库上**真跑** `_分流器.mjs`，绝不碰真库）：
 *   ① **照片级判重**：台账已引用的照片（路径命中 / 内容指纹命中 / 批次级命中）
 *      ⇒ 必须被判为重复、**不进待判科清单**。
 *   ② **正向对照**（防"一律判重"）：**未**被台账引用的照片 ⇒ 必须仍在待判科清单里。
 *   ③ **题面级跨任务去重**：库里已有卡的题面指纹 ⇒ AI 回传的同一题面 ⇒ 必须报"疑似重复"。
 *   ④ **阴性自证**：把判重锚点摘掉（= 退回"不判重"）⇒ 断言① 必须当场变红。
 *
 * 用法：node tests\neg-triage-dedupe.cjs
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
const ENGINE = path.join(ROOT, 'src', 'tools', '_分流器.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-triage-'));
const LIB = path.join(TMP, 'lib');
const INBOX = path.join(LIB, '_收件箱');

function runTool(args, lib) {
  const r = spawnSync(process.execPath, [ENGINE, ...args, '--data', lib], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: lib }),
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '')); } catch { }
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json };
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function makeLib() {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(path.join(INBOX, '批次甲'), { recursive: true });
  fs.mkdirSync(path.join(INBOX, '批次乙'), { recursive: true });
  const libPages = path.join(LIB, '原卷库');
  fs.mkdirSync(libPages, { recursive: true });

  /* 已处理件 A：台账引用它（路径命中） */
  const a = pngGray(120, 160, (x, y) => (x * 3 + y * 7) % 251);
  fs.writeFileSync(path.join(libPages, 'A-已处理.png'), a);
  /* 收件箱里放 A 的**同一份字节**副本 ⇒ 内容指纹命中 */
  fs.writeFileSync(path.join(INBOX, '批次甲', 'A-副本.png'), Buffer.from(a));
  /* 收件箱里放 B：台账没引用过 ⇒ 必须留在待判科清单 */
  const b = pngGray(130, 170, (x, y) => (x * 5 + y * 11) % 253);
  fs.writeFileSync(path.join(INBOX, '批次甲', 'B-新照片.png'), b);
  /* 收件箱里放 C：属于「批次乙」，台账里另有该批次的一条记录 ⇒ 批次级命中 */
  const c = pngGray(140, 180, (x, y) => (x * 7 + y * 13) % 241);
  fs.writeFileSync(path.join(INBOX, '批次乙', 'C-同批次.png'), c);

  /* 台账：A 被路径引用；批次乙已建过卡 */
  fs.writeFileSync(path.join(LIB, '_原卷台账.json'), JSON.stringify({
    version: 1,
    cards: {
      '学生甲|M0001': { page: '原卷库/A-已处理.png' },
      '学生甲|M0002': { page: '_收件箱/批次乙/别的图.png', source: '2026-01-01 某批次' },
    },
  }, null, 1) + '\n', 'utf8');

  /* 题库：一门课，已有 1 张卡（题面 "1+1=?"，source 带《书名》以便测卷头标题同源） */
  fs.mkdirSync(path.join(LIB, '九年级', '数学'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '九年级', '数学', '_索引.json'), JSON.stringify({
    student: '学生甲', grade: '九年级', subject: '数学',
    items: [{ id: 'M0001', dir: 'M0001-加法', question: '1+1=?', answer: '2', status: '在册', source: '数学《合成练习册卷》· 第1页 · 第1题' }],
  }, null, 1) + '\n', 'utf8');

  return { a, b, c };
}

function main() {
  console.log('临时库：' + LIB + '\n引擎：' + path.relative(ROOT, ENGINE) + '\n');
  const { a, b, c } = makeLib();

  console.log('══ ① 真跑分流器「计划」：判重必须生效 ══');
  const real = runTool(['计划', '--json'], LIB);
  A('① 前置：引擎真跑成功', real.code === 0 && !!real.json, 'exit=' + real.code + ' ' + String(real.err).split('\n')[0].slice(0, 90));
  const J = real.json || { pending: [], skipped: [] };
  const pendingNames = (J.pending || []).map(x => x.name);
  const skippedNames = (J.skipped || []).map(x => x.name);
  const skippedWhy = (J.skipped || []).map(x => x.reason);

  A('★★ ① 台账引用的照片的**同一份字节**副本 ⇒ 被判重复（内容指纹命中）',
    skippedNames.includes('A-副本.png') && !pendingNames.includes('A-副本.png'),
    '待判=' + JSON.stringify(pendingNames) + ' 判重=' + JSON.stringify(skippedNames));
  A('★ ① 重复的理由要说清是哪条判据（内容指纹）',
    skippedWhy.some(w => /内容指纹/.test(w)), '理由=' + JSON.stringify(skippedWhy));
  A('★ ① 同批次的另一张 ⇒ 批次级判据命中（该批次已建过卡）',
    skippedNames.includes('C-同批次.png'), '判重=' + JSON.stringify(skippedNames));
  A('★ ② 正向对照：台账没引用过的照片 ⇒ 仍留在待判科清单（防"一律判重"）',
    pendingNames.includes('B-新照片.png') && !skippedNames.includes('B-新照片.png'),
    '待判=' + JSON.stringify(pendingNames));

  console.log('\n══ ③ 题面级跨任务去重：同一题面必须报"疑似重复" ══');
  /* 造一份 AI 判科结果：B 那张的 stems 里带库内已有卡的题面 "1+1=?" */
  const judge = {
    schema: 'glimmernote.triage-judge/v1',
    items: (J.pending || []).map((x, i) => ({
      idx: i, subject: '数学', confident: true, reason: '测试',
      stems: x.name === 'B-新照片.png' ? ['1+1=?'] : [],
    })),
  };
  const judgeFile = path.join(TMP, 'judge.json');
  fs.writeFileSync(judgeFile, JSON.stringify(judge, null, 1), 'utf8');
  const gr = runTool(['分组', '--in', judgeFile, '--dry', '--json'], LIB);
  A('③ 前置：分组真跑成功', gr.code === 0 && !!gr.json, 'exit=' + gr.code + ' ' + String(gr.err).split('\n')[0].slice(0, 90));
  const G = gr.json || { composed: [], duplicates: [], bySubject: {} };
  A('★★ ③ 题面与库内已有卡相同 ⇒ 报"疑似重复"、**不进组**',
    (G.duplicates || []).some(d => d.name === 'B-新照片.png') &&
    !(G.composed || []).some(c => c.name === 'B-新照片.png'),
    '重复=' + JSON.stringify((G.duplicates || []).map(d => d.name)) +
    ' 已组=' + JSON.stringify((G.composed || []).map(c => c.name)));

  console.log('\n══ ③·b 归一化口径：空白/全半角差异不该被当成"不同的题" ══');
  const judge2 = {
    schema: 'glimmernote.triage-judge/v1',
    items: (J.pending || []).map((x, i) => ({
      idx: i, subject: '数学', confident: true, reason: '测试',
      stems: x.name === 'B-新照片.png' ? ['1 + 1 = ?'] : [],
    })),
  };
  const judge2File = path.join(TMP, 'judge2.json');
  fs.writeFileSync(judge2File, JSON.stringify(judge2, null, 1), 'utf8');
  const gr2 = runTool(['分组', '--in', judge2File, '--dry', '--json'], LIB);
  const G2 = gr2.json || { composed: [], duplicates: [] };
  A('★ ③·b 题面加空格后仍判重复（归一化生效）',
    (G2.duplicates || []).some(d => d.name === 'B-新照片.png'),
    '重复=' + JSON.stringify((G2.duplicates || []).map(d => d.name)));

  console.log('\n══ ③·c 同源材料检测：卷头标题命中库内书名 ⇒ 必须报出来 ══');
  {
    /* 造一份带 headerTitle 的判科结果：headerTitle 与库内卡的 source 里的《书名》同串 */
    const judge3 = {
      schema: 'glimmernote.triage-judge/v1',
      items: (J.pending || []).map((x, i) => ({
        idx: i, subject: '数学', confident: true, reason: '测试',
        headerTitle: '合成练习册卷', stems: [],
      })),
    };
    const j3f = path.join(TMP, 'judge3.json');
    fs.writeFileSync(j3f, JSON.stringify(judge3, null, 1), 'utf8');
    const g3 = runTool(['分组', '--in', j3f, '--dry', '--json'], LIB);
    A('③·c 前置：分组真跑成功', g3.code === 0 && !!g3.json, 'exit=' + g3.code);
    const G3 = g3.json || { sameSource: [] };
    A('★ ③·c 卷头标题命中库内书名 ⇒ 报出"同源材料"',
      (G3.sameSource || []).length > 0,
      'sameSource=' + JSON.stringify((G3.sameSource || []).map(x => x.libraryMaterial)));

    /* 阴性自证：摘掉互含判据 ⇒ 断言必须当场变红 */
    const ORIG2 = fs.readFileSync(ENGINE, 'utf8');
    const ANCHOR2 = 'if (kk.includes(hdr) || hdr.includes(kk)) {';
    const hits2 = ORIG2.split(ANCHOR2).length - 1;
    A('③·c 前置：阴性自证锚点存在且唯一', hits2 === 1, '出现 ' + hits2 + ' 次');
    const mutSrc2 = ORIG2.replace(ANCHOR2, 'if (false) {   // 变异：摘掉卷头标题互含判据');
    A('③·c 前置：变异真的发生了（不是空操作）', mutSrc2 !== ORIG2 && mutSrc2.includes('变异：摘掉卷头标题互含判据'));
    A('③·c 前置：变异只动一行，行数不变', mutSrc2.split('\n').length === ORIG2.split('\n').length,
      ORIG2.split('\n').length + ' 行 → ' + mutSrc2.split('\n').length + ' 行');

    const deps2 = new Set();
    const queue2 = ['_分流器.mjs'];
    while (queue2.length) {
      const f = queue2.shift();
      if (deps2.has(f)) continue;
      const src = path.join(ROOT, 'src', 'tools', f);
      if (!fs.existsSync(src)) continue;
      deps2.add(f);
      const body = f === '_分流器.mjs' ? mutSrc2 : fs.readFileSync(src, 'utf8');
      for (const m of body.matchAll(/from\s+'\.\/([^']+\.mjs)'/g)) if (!deps2.has(m[1])) queue2.push(m[1]);
    }
    const mutDir2 = path.join(TMP, 'mut2');
    fs.mkdirSync(mutDir2, { recursive: true });
    for (const f of deps2) fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(mutDir2, f));
    const mutEngine2 = path.join(mutDir2, '_分流器.mjs');
    fs.writeFileSync(mutEngine2, mutSrc2, 'utf8');
    const chk2 = spawnSync(process.execPath, ['--check', mutEngine2], { encoding: 'utf8' });
    A('③·c 前置：变异体语法自检通过（node --check）', chk2.status === 0,
      String(chk2.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));

    const r2 = spawnSync(process.execPath, [mutEngine2, '分组', '--in', j3f, '--dry', '--json', '--data', LIB], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { CTB_DATA: LIB }),
    });
    let mj2 = null; try { mj2 = JSON.parse(String(r2.stdout || '')); } catch { }
    A('③·c 变异体真跑成功', r2.status === 0 && !!mj2, 'exit=' + r2.status);
    A('★★ ③·c 阴性自证：旧逻辑下**不再**报同源（即断言★③·c 会当场变红）',
      ((mj2 || {}).sameSource || []).length === 0,
      'sameSource=' + JSON.stringify(((mj2 || {}).sameSource || []).map(x => x.libraryMaterial)));
    A('③·c 仓库里的真源码未被改动（变异只在临时副本上做）', fs.readFileSync(ENGINE, 'utf8') === ORIG2);
    try { fs.rmSync(mutDir2, { recursive: true, force: true }); } catch { }
  }

  console.log('\n══ ④ 阴性自证：摘掉判重锚点（= 退回"不判重"）══');
  {
    const ORIG = fs.readFileSync(ENGINE, 'utf8');
    /* 锚点：批次级判据那一行。摘掉它 ⇒ 批次乙的 C 应当**不再**被判重。 */
    const ANCHOR = "else if (ledger.doneBatches.has(b.batch)) dupReason = '该批次已建过卡（批次级判据）';";
    const hits = ORIG.split(ANCHOR).length - 1;
    A('④ 前置：阴性自证锚点存在且唯一', hits === 1, '出现 ' + hits + ' 次');
    const mutSrc = ORIG.replace(ANCHOR, '/* 变异：摘掉批次级判据 */');
    A('④ 前置：变异真的发生了（不是空操作）', mutSrc !== ORIG && mutSrc.includes('变异：摘掉批次级判据'));
    A('④ 前置：变异只动一行，行数不变（防"锚点打偏、整段被吃"）',
      mutSrc.split('\n').length === ORIG.split('\n').length,
      ORIG.split('\n').length + ' 行 → ' + mutSrc.split('\n').length + ' 行');

    /* 复制依赖，变异体才能独立跑起来（从源码解析 import 清单） */
    const deps = new Set();
    const queue = ['_分流器.mjs'];
    while (queue.length) {
      const f = queue.shift();
      if (deps.has(f)) continue;
      const src = path.join(ROOT, 'src', 'tools', f);
      if (!fs.existsSync(src)) continue;
      deps.add(f);
      const body = f === '_分流器.mjs' ? ORIG : fs.readFileSync(src, 'utf8');
      for (const m of body.matchAll(/from\s+'\.\/([^']+\.mjs)'/g)) if (!deps.has(m[1])) queue.push(m[1]);
    }
    const mutDir = path.join(TMP, 'mut');
    fs.mkdirSync(mutDir, { recursive: true });
    for (const f of deps) fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(mutDir, f));
    const mutEngine = path.join(mutDir, '_分流器.mjs');
    fs.writeFileSync(mutEngine, mutSrc, 'utf8');
    const chk = spawnSync(process.execPath, ['--check', mutEngine], { encoding: 'utf8' });
    A('④ 前置：变异体语法自检通过（node --check）', chk.status === 0,
      String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));

    const r = spawnSync(process.execPath, [mutEngine, '计划', '--json', '--data', LIB], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { CTB_DATA: LIB }),
    });
    let mj = null; try { mj = JSON.parse(String(r.stdout || '')); } catch { }
    A('④ 变异体真跑成功', r.status === 0 && !!mj, 'exit=' + r.status);
    const mSkip = ((mj || {}).skipped || []).map(x => x.name);
    const mPend = ((mj || {}).pending || []).map(x => x.name);
    A('★★ 阴性自证：旧逻辑下同批次的 C **不再**被判重（即断言① 会当场变红）',
      !mSkip.includes('C-同批次.png') && mPend.includes('C-同批次.png'),
      '判重=' + JSON.stringify(mSkip) + ' 待判=' + JSON.stringify(mPend));

    /* 不留半截改造：仓库里的真源码一个字节都没动过 */
    A('④ 仓库里的真源码未被改动（变异只在临时副本上做）', fs.readFileSync(ENGINE, 'utf8') === ORIG);
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
