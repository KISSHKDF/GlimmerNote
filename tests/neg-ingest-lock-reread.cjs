#!/usr/bin/env node
/**
 * 阴性用例（2026-11-23，审计 D-01/D-02 · P0）：**取锁后重读索引**。
 *
 * 缺陷（修前）：入库（⑥）与改卡（②）都在**锁外**把索引读进内存，取锁后把那份旧对象整份写回。
 *   读索引与取锁之间，别的工具（批改回写、作答门禁、另一批入库）写进同一份索引的内容
 *   会被旧对象覆盖 ⇒ 丢数据；两批并发入库还会规划出**同一个卡号**，后写的把先写的从索引里抹掉。
 *
 * 修法：取锁后重读索引、重新定位条目 / 重新规划卡号，写盘只用锁内那份。
 *
 * 怎么证明（不用真实并发、不碰真实库）：
 *   `_录题入库.mjs` 有**测试缝** `testPrelockHook()`：设了 `CTB_TEST_PRELOCK_HOOK` 时，
 *   在"锁外读完索引、即将取锁"那一刻同步跑一段脚本。钩子脚本在临时库的索引里
 *   模拟"别的工具恰好此刻写进来的数据"（一张新卡 + 一条批改回写）。
 *   然后：
 *     · 入库：新卡必须排在钩子写的卡**之后**（不撞号），钩子写的卡**还在**（不被覆盖）；
 *     · 改卡：钩子写进卡条目的批改字段必须**保留**（改卡只动内容字段，不回写旧对象）。
 *   阴性自证：把"锁内重读"逻辑从源码摘掉 ⇒ 断言必须变红（证明判据有牙齿）。
 *
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
const A = (n, ok, d) => {
  total++;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`);
  if (!ok) fails++;
};

const ROOT = path.resolve(__dirname, '..');
const LAND_SRC = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_录题入库.mjs'), 'utf8');

/* 一张真 JPEG（与 neg-ingest-land 同款最小头） */
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCABkAGQBAREA/8QAHwAAAQUBAQEBAQ' +
  'AAAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
  'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
  'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z', 'base64');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const mkLib = (tag) => {
  const LIB = E.allocTempDir('gn-lock-reread-' + tag + '-');
  fs.mkdirSync(path.join(LIB, '_收件箱', '批次'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '_收件箱', '批次', 'p001.jpg'), JPG);
  return LIB;
};
const writeIndex = (LIB, items) => {
  fs.mkdirSync(path.join(LIB, '七年级-学生甲'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '七年级-学生甲', '_索引.json'),
    JSON.stringify({ schema: 'glimmernote.index/v1', student: '学生甲', grade: '七年级', subjects: { 数学: { items } }, updatedAt: '2026-11-01' }), 'utf8');
};
const readIndex = (LIB) =>
  JSON.parse(fs.readFileSync(path.join(LIB, '七年级-学生甲', '_索引.json'), 'utf8').replace(/^\uFEFF/, ''));

const mkTask = (LIB, tid, sha) => {
  fs.mkdirSync(path.join(LIB, '_录题'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '_录题', tid + '.json'), JSON.stringify({
    schema: 'glimmernote.ingest-task/v1', taskId: tid, createdAt: '2026-11-23T20:00:00+08:00',
    recipe: { id: 'ingest-auto', version: '1.0.0', fingerprint: 'deadbeefcafe' },
    cards: [], image: { sha256: sha, rel: '_收件箱/批次/p001.jpg' }, subject: '数学',
    contractDigest: 'cafe1234', taskDigest: 'aaaa', taskText: '（测试）',
    confirmedAt: '2026-11-23T20:01:00+08:00',
  }), 'utf8');
};
const mkCardsFile = (LIB, name, sha, taskId) => {
  const c = {
    subject: '数学', title: '并发测试卡', source: '测试卷 · 第1题', sourceDate: '2026-11-23',
    questionText: '测试题：1 + 1 = ____。',
    studentAnswer: '3', answer: '2',
    answerSource: '独立判卷', answerSourceNote: '加法定义', teacherAnswer: '',
    causeCode: 'L1', causeNote: '测试',
    kpoints: ['测试点'], difficulty: '中', hasFigure: false, confidence: 'high',
    sourceImageSha256: sha, notes: '', bbox: [0.02, 0.29, 0.96, 0.08],
    answerMode: 'blank', answerSlots: ['2'],
  };
  const p = path.join(LIB, name);
  fs.writeFileSync(p, JSON.stringify({ envelope: { schema: 'glimmernote.ingest-result/v1', taskId: taskId || 't-x', imageSha256: sha }, result: { pageSummary: { totalQuestions: 1, markedWrong: 1, unmarked: 0 }, cards: [c], skipped: [] } }), 'utf8');
  return p;
};

/* 钩子脚本：模拟"取锁前一瞬"别的工具写的索引。
   库根从 CTB_TEST_LIB 读；写什么由 CTB_TEST_HOOK_KIND 决定。
   ⚠ 索引用**学生根形态**（<库根>\<学生>\_索引.json，subjects: { 数学: { items } }）——
   这与 `_建学生.mjs` 产出的形态一致；改卡按 `base+subject+dir` 定位卡目录，
   学生根形态下 base=学生目录，正好对上。 */
const hookScript = path.join(os.tmpdir(), 'gn-lock-reread-hook.cjs');
fs.writeFileSync(hookScript, `'use strict';
const fs = require('fs'); const path = require('path');
const LIB = process.env.CTB_TEST_LIB;
const kind = process.env.CTB_TEST_HOOK_KIND;
const f = path.join(LIB, '七年级-学生甲', '_索引.json');
const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
if (kind === 'newcard') {
  j.subjects.数学.items.push({ id: 'M0999', dir: 'M0999-并发插入', source: '别的工具', question: '并发插入的卡',
    answer: '', studentAnswer: '', kpoints: [], causeLayer: 'L', causeCode: 'L1', causeDesc: '',
    causeConfirmed: true, difficulty: '中', errorCount: 1, status: '在册', hasImage: false, hasVariants: false,
    reviews: [], reviewStatus: '未复习', reviewCount: 0, passStreak: 0, lastReviewedAt: '', nextDue: '', masteredAt: null,
    blindStatus: '未盲解', answerSource: '独立判卷', teacherAnswer: '', inkAttribution: '', teacherConflict: null });
} else if (kind === 'review') {
  const it = j.subjects.数学.items.find(x => x.id === 'M0001');
  if (it) { it.reviewCount = 3; it.passStreak = 2; it.status = '复习中'; it.lastReviewedAt = '2026-11-23'; it.reviews = [{ date: '2026-11-23', res: '对' }]; }
}
j.updatedAt = '2026-11-23T23:59:00';
fs.writeFileSync(f, JSON.stringify(j), 'utf8');
`, 'utf8');

const runLand = (LIB, extraEnv) => {
  const r = spawnSync(process.execPath, [E.tool('_录题入库.mjs'), '入库', TID, '--file', path.join(LIB, 'cards.json'), '--student', '学生甲', '--subject', '数学', '--data', LIB], {
    encoding: 'utf8', maxBuffer: 64e6,
    env: Object.assign({}, process.env, { CTB_TEST_LIB: LIB, CTB_TEST_PRELOCK_HOOK: hookScript, CTB_TEST_HOOK_KIND: 'newcard' }, extraEnv || {}),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
};
const runFix = (LIB, extraEnv) => {
  const r = spawnSync(process.execPath, [E.tool('_录题入库.mjs'), '改卡', 'M0001', '--file', path.join(LIB, 'fix.json'), '--student', '学生甲', '--subject', '数学', '--data', LIB], {
    encoding: 'utf8', maxBuffer: 64e6,
    env: Object.assign({}, process.env, { CTB_TEST_LIB: LIB, CTB_TEST_PRELOCK_HOOK: hookScript, CTB_TEST_HOOK_KIND: 'review' }, extraEnv || {}),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
};

/* 阴性自证用：把锁内重读逻辑摘掉（变异）。
   删法：从重读块注释的开头，删到块后第一行真实代码**之前**（保留那行）——
   上一版锚点只删到注释尾，把代码留下了，变异体等于没变（阴性自证假绿）。 */
const buildMutated = (src) => {
  const cutBefore = (text, startAnchor, endAnchor) => {
    const a = text.indexOf(startAnchor);
    if (a < 0) return null;
    const b = text.indexOf(endAnchor, a);
    if (b < 0) return null;
    return text.slice(0, a) + text.slice(b);
  };
  /* D-01（入库）：重读块之后第一行真实代码是 tx.mkdir(tgt.dirAbs); */
  let m = cutBefore(src, '/* ★ 2026-11-23（审计 D-01 · P0）：**取锁后重读索引 + 重新规划卡号**。', 'tx.mkdir(tgt.dirAbs);');
  if (m === null) return null;
  /* D-02（改卡）：裸块 `{ … }` 整体删——从注释起，删到 ④a 注释开头为止。
     ⚠ 锚点必须落在闭合大括号**之后**：切在 hit.j 行之前会把裸块的 `{` 留下 ⇒ "try 后没有 catch" 语法坏。
     ⚠ 锚点取的是 ④a 注释的**第一行**（`/* ④a 题干.html`）：那一行后面可能接续说明文字
        （2026-11-26 加了 stemHtml 说明），锚点若写整行就再也匹配不上 ⇒ 变异体生成失败。 */
  m = cutBefore(m, '/* ★ 2026-11-23（审计 D-02 · P0）：**取锁后重读索引**。', '    /* ④a 题干.html');
  return m;
};
const MUTATED = buildMutated(LAND_SRC);
/* 变异体必须带上它的兄弟模块（相对 import 以文件自身定位，孤零零放 TEMP 会 MODULE_NOT_FOUND）：
   与 neg-ingest-crop-and-figure.cjs 的 copyEngine 同款做法。 */
const mutatedDir = path.join(os.tmpdir(), 'gn-lock-reread-mut-' + Date.now());
const mutatedLand = path.join(mutatedDir, '_录题入库.mjs');
{
  fs.mkdirSync(mutatedDir, { recursive: true });
  const deps = new Set(['_录题入库.mjs']);
  const queue = ['_录题入库.mjs'];
  while (queue.length) {
    const f = queue.shift();
    const body = f === '_录题入库.mjs' ? LAND_SRC : fs.readFileSync(path.join(ROOT, 'src', 'tools', f), 'utf8');
    for (const m of body.matchAll(/from\s+'\.\/([^']+\.mjs)'/g)) if (!deps.has(m[1])) { deps.add(m[1]); queue.push(m[1]); }
  }
  for (const f of deps) fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(mutatedDir, f));
  fs.writeFileSync(mutatedLand, MUTATED || '', 'utf8');
  const chk = spawnSync(process.execPath, ['--check', mutatedLand], { encoding: 'utf8' });
  A('变异体语法自检通过（锚点没切坏源码）', MUTATED && chk.status === 0, MUTATED ? String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | ') : '锚点没找到——源码里的注释被改了，请同步更新本用例的锚点');
}

const TID = 't-20261123-220000-abc123';

/* ═══ A · 入库：锁内重排卡号，不覆盖并发写 ═══ */
console.log('═══ A · 入库：钩子在取锁前插入 M0999 ⇒ 新卡顺延、并发卡保留 ═══');
{
  const LIB = mkLib('land');
  const sha = sha256(fs.readFileSync(path.join(LIB, '_收件箱', '批次', 'p001.jpg')));
  writeIndex(LIB, []);
  mkTask(LIB, TID, sha);
  fs.writeFileSync(path.join(LIB, 'cards.json'), fs.readFileSync(mkCardsFile(LIB, 'cf.json', sha, TID)), 'utf8');
  const r = runLand(LIB);
  A('A1 入库 ⇒ exit 0', r.code === 0, 'exit=' + r.code + ' ' + r.out.slice(0, 240));
  const idx = readIndex(LIB);
  const ids = (idx.subjects.数学.items).map(x => x.id);
  A('A2 并发插入的 M0999 还在索引里（没被旧对象覆盖掉）', ids.includes('M0999'), 'ids=' + ids.join(','));
  A('A3 新卡卡号顺延为 M1000（不与 M0999 撞号）', ids.includes('M1000'), 'ids=' + ids.join(','));
  A('A4 输出点名了卡号顺延（并发可观察）', /顺延|重读/.test(r.out), r.out.slice(0, 160));
  A('A5 卡目录是 M1000-*（目录名与索引一致）',
    fs.existsSync(path.join(LIB, '七年级-学生甲', '数学')) &&
    fs.readdirSync(path.join(LIB, '七年级-学生甲', '数学')).some(d => d.startsWith('M1000')),
    fs.readdirSync(path.join(LIB, '七年级-学生甲', '数学')).join(','));

  /* 阴性自证：摘掉锁内重读 ⇒ 撞号 + 覆盖，判据必须变红。
     ⚠ 场景必须与真实运行完全一致（空库起步，钩子负责插 M0999）——
     修前变异跑**复用真实跑后的库**：索引里已有 M0999 ⇒ 旧对象本来就带着它，
     写回后 M0999 还在 ⇒ 变异跑不出差别（阴性自证假红）。所以变异跑用**全新库**。 */
  {
    const LIB2 = mkLib('land-mut');
    const sha2 = sha256(fs.readFileSync(path.join(LIB2, '_收件箱', '批次', 'p001.jpg')));
    writeIndex(LIB2, []);
    mkTask(LIB2, TID, sha2);
    fs.writeFileSync(path.join(LIB2, 'cards.json'), fs.readFileSync(mkCardsFile(LIB2, 'cf.json', sha2, TID)), 'utf8');
    const r2 = spawnSync(process.execPath, [mutatedLand, '入库', TID, '--file', path.join(LIB2, 'cards.json'), '--student', '学生甲', '--subject', '数学', '--data', LIB2], {
      encoding: 'utf8', maxBuffer: 64e6,
      env: Object.assign({}, process.env, { CTB_TEST_LIB: LIB2, CTB_TEST_PRELOCK_HOOK: hookScript, CTB_TEST_HOOK_KIND: 'newcard' }),
    });
    const idx2 = readIndex(LIB2);
    const ids2 = idx2.subjects.数学.items.map(x => x.id);
    /* 变异体（旧逻辑）：索引对象在锁外读（空），钩子随后把 M0999 写进文件，
       引擎把旧对象（没有 M0999）+ 自己规划的 M0001 写回 ⇒ M0999 丢、卡号撞成 M0001。 */
    A('A6 阴性自证：摘掉锁内重读后，并发卡被覆盖（M0999 丢）且卡号撞回 M0001 ⇒ 变异确实破坏行为',
      !ids2.includes('M0999') && ids2.includes('M0001'),
      'ids=' + ids2.join(',') + ' exit=' + r2.status);
  }
}

/* ═══ B · 改卡：锁内重读条目，批改回写不被覆盖 ═══ */
console.log('\n═══ B · 改卡：钩子在取锁前写入批改字段 ⇒ 改卡后仍在 ═══');
{
  const LIB = mkLib('fix');
  const sha = sha256(fs.readFileSync(path.join(LIB, '_收件箱', '批次', 'p001.jpg')));
  writeIndex(LIB, [{
    id: 'M0001', dir: 'M0001-旧标题', source: '测试卷 · 第1题', question: '旧题干：2 + 2 = ____。',
    answer: '4', studentAnswer: '5', kpoints: ['测试点'], causeLayer: 'L', causeCode: 'L1', causeDesc: '旧错因',
    causeConfirmed: true, difficulty: '中', errorCount: 1, status: '在册', hasImage: false, hasVariants: false,
    reviews: [], reviewStatus: '未复习', reviewCount: 0, passStreak: 0, lastReviewedAt: '', nextDue: '', masteredAt: null,
    blindStatus: '未盲解', answerSource: '独立判卷', teacherAnswer: '', inkAttribution: '', teacherConflict: null,
  }]);
  /* 改卡要求卡目录真实存在 */
  fs.mkdirSync(path.join(LIB, '七年级-学生甲', '数学', 'M0001-旧标题'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '七年级-学生甲', '数学', 'M0001-旧标题', '题干.html'), '<p>旧题干</p>', 'utf8');
  const fc = {
    subject: '数学', title: '旧标题', questionText: '改后题干：3 + 3 = ____。',
    studentAnswer: '7', answer: '6', answerSource: '独立判卷', answerSourceNote: '加法定义',
    teacherAnswer: '', causeCode: 'L1', causeNote: '改后错因', kpoints: ['测试点'],
    difficulty: '中', hasFigure: false, confidence: 'high', sourceImageSha256: sha, notes: '',
  };
  fs.writeFileSync(path.join(LIB, 'fix.json'), JSON.stringify({ result: { cards: [fc] } }), 'utf8');

  const r = runFix(LIB);
  A('B1 改卡 ⇒ exit 0', r.code === 0, 'exit=' + r.code + ' ' + r.out.slice(0, 240));
  const idx = readIndex(LIB);
  const it = idx.subjects.数学.items.find(x => x.id === 'M0001');
  A('B2 钩子写入的 reviewCount=3 还在（没被旧对象覆盖回 0）', it && it.reviewCount === 3, 'reviewCount=' + (it && it.reviewCount));
  A('B3 内容字段确实改了（question 变成改后题干）', it && /3 \+ 3/.test(String(it.question || '')), (it && it.question || '').slice(0, 60));
  A('B4 钩子写入的 status/reviews 一并保留', it && it.status === '复习中' && Array.isArray(it.reviews) && it.reviews.length === 1,
    'status=' + (it && it.status) + ' reviews=' + (it && Array.isArray(it.reviews) ? it.reviews.length : 'n/a'));

  /* 阴性自证：摘掉锁内重读 ⇒ reviewCount 被回写成 0，判据必须能抓到。
     ⚠ 变异跑用**全新库**（真实跑后库里 reviewCount 已是 3，旧对象写回的也是 3，
     差别消失 ⇒ 假红）。 */
  {
    const LIB2 = mkLib('fix-mut');
    const sha2 = sha256(fs.readFileSync(path.join(LIB2, '_收件箱', '批次', 'p001.jpg')));
    writeIndex(LIB2, [{
      id: 'M0001', dir: 'M0001-旧标题', source: '测试卷 · 第1题', question: '旧题干：2 + 2 = ____。',
      answer: '4', studentAnswer: '5', kpoints: ['测试点'], causeLayer: 'L', causeCode: 'L1', causeDesc: '旧错因',
      causeConfirmed: true, difficulty: '中', errorCount: 1, status: '在册', hasImage: false, hasVariants: false,
      reviews: [], reviewStatus: '未复习', reviewCount: 0, passStreak: 0, lastReviewedAt: '', nextDue: '', masteredAt: null,
      blindStatus: '未盲解', answerSource: '独立判卷', teacherAnswer: '', inkAttribution: '', teacherConflict: null,
    }]);
    fs.mkdirSync(path.join(LIB2, '七年级-学生甲', '数学', 'M0001-旧标题'), { recursive: true });
    fs.writeFileSync(path.join(LIB2, '七年级-学生甲', '数学', 'M0001-旧标题', '题干.html'), '<p>旧题干</p>', 'utf8');
    fs.writeFileSync(path.join(LIB2, 'fix.json'), JSON.stringify({ result: { cards: [fc] } }), 'utf8');
    const r2 = spawnSync(process.execPath, [mutatedLand, '改卡', 'M0001', '--file', path.join(LIB2, 'fix.json'), '--student', '学生甲', '--subject', '数学', '--data', LIB2], {
      encoding: 'utf8', maxBuffer: 64e6,
      env: Object.assign({}, process.env, { CTB_TEST_LIB: LIB2, CTB_TEST_PRELOCK_HOOK: hookScript, CTB_TEST_HOOK_KIND: 'review' }),
    });
    const idx2 = readIndex(LIB2);
    const it2 = idx2.subjects.数学.items.find(x => x.id === 'M0001');
    A('B5 阴性自证：摘掉锁内重读后，批改字段被旧对象覆盖（reviewCount 回 0）⇒ 变异确实破坏行为',
      it2 && it2.reviewCount === 0, 'reviewCount=' + (it2 && it2.reviewCount) + ' exit=' + r2.status);
  }
}

try { fs.rmSync(mutatedDir, { recursive: true, force: true }); } catch { }
console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${total} 失败=${fails}`);
process.exit(fails ? 1 : 0);
