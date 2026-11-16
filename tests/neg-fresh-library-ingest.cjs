#!/usr/bin/env node
/**
 * 全新库「第一张卡」端到端（2026-11-16 建）—— 别人拿这个程序来用，到底能不能录进第一道错题。
 *
 * 事故锚点（2026-11-16 真机复现，用户问「如果别人来用，可以录入错题吧？」时扫出来的）：
 *   ① `_建学生.mjs` 建出的索引是 `subjects: {}`（它自己注释写着"录哪门课的题，那门课就自动出现"），
 *      但**全仓没有任何代码创建这个节点**。于是新用户建完学生、录第一张卡，
 *      `_录题入库.mjs findTarget` 返回「索引里没有学科「数学」这一节（现有：）」⇒ exit 2、零写盘。
 *      老库碰不到（学科节是历史一次性脚本建的），`neg-ingest-land.cjs` 的夹具又是手写的学科级索引
 *      ⇒ 这条**唯一的新用户路径**从来没有用例守过。
 *   ② 同一个仓库里，`_盲解复核.mjs 清稿` 给第 1 路补了 `-第1路` 后缀、`--ids` 再叠 `-重盲解-<摘要>`，
 *      而 `_数据区门禁.mjs`（N13）只认 `[-第2路|-重盲解]` ⇒ 入库器**每落一张卡就制造一处库级违规**
 *      （G11 当场判红，真机复现 3 处）。两个组件各改各的，谁都没有端到端用例。
 *
 * 本用例守的是「删掉任一处修复都会红」：
 *   A 新建学生 ⇒ 索引 subject 节为空（事实基线，不是断言目标）
 *   B 真跑 `_录题入库.mjs 入库` ⇒ **exit 0**，学科节点 + 学科目录 + 卡目录四件套 + 索引条目一起就位
 *   C 入库产物过 `_数据区门禁.mjs` ⇒ **exit 0**（学科闭环 N4 + 盲解清稿命名 N13 都合规）
 *   D 第 2 路清稿（`--lane 2 --ids`）也生成之后，门禁仍然全绿（组合后缀没被放开成筛子）
 *   E 阴性自证：把"自动建学科节"那一段摘掉 ⇒ 变异体必须 exit 2 且点名"没有学科"
 *
 * 零真库依赖：全部夹具自建在 `%TEMP%`（`E.allocTempDir` 登记，进程退出统一删）。
 * 用法：node tests\neg-fresh-library-ingest.cjs     （退出码 0=全绿）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
const A = (n, ok, d) => {
  total++;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 260) : ''}`);
  if (!ok) fails++;
};
const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_录题入库.mjs');

/* 一张**真 JPEG**（最小合法 SOF0 头 + EOI）：裁图走 System.Drawing，读不出尺寸就裁不了。 */
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCABkAGQBAREA/8QAHwAAAQUBAQEBAQ' +
  'AAAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
  'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
  'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z', 'base64');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** 全新库：只有收件箱里的那张照片（模拟"刚解压、刚建完学生"的那一刻） */
function makeFreshLib() {
  const lib = E.allocTempDir('gn-fresh-ingest-');
  /* 批次目录名按 N13 来（`<YYYY-MM-DD>-<小名>-<学科>`），否则 G11 会因为夹具自己的名字判红 ——
     本用例要考的是入库产物，不是收件箱命名。 */
  fs.mkdirSync(path.join(lib, '_收件箱', '2026-11-16-小明-数学'), { recursive: true });
  fs.writeFileSync(path.join(lib, '_收件箱', '2026-11-16-小明-数学', 'p001.jpg'), JPG);
  return lib;
}

function runTool(name, args, lib) {
  const r = spawnSync(process.execPath, [E.tool(name), ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: lib }),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function readIdx(lib) {
  const p = path.join(lib, '小明', '_索引.json');
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

/** 造一条"已确认"的任务记录 + 一份合法回传 JSON（放在库外，避免污染 G6 顶层闭集） */
function stageTask(lib) {
  const imgRel = '_收件箱/2026-11-16-小明-数学/p001.jpg';
  const sha = sha256(fs.readFileSync(path.join(lib, imgRel)));
  const taskId = 't-20261116-120000-abcdef';
  fs.mkdirSync(path.join(lib, '_录题'), { recursive: true });
  fs.writeFileSync(path.join(lib, '_录题', taskId + '.json'), JSON.stringify({
    schema: 'glimmernote.ingest-task/v1', taskId, createdAt: '2026-11-16T12:00:00+08:00',
    recipe: { id: 'ingest-page', version: '2.1.0', fingerprint: 'deadbeef' },
    cards: [], image: { sha256: sha, rel: imgRel }, subject: '数学',
    contractDigest: 'cafe1234', taskDigest: 'aaaa', taskText: '（测试）',
    confirmedAt: '2026-11-16T12:01:00+08:00',
  }, null, 1), 'utf8');

  const card = {
    subject: '数学', title: '新库第一张卡', source: '第一章 第3题', sourceDate: '2026-11-16',
    questionText: '1+1=____', studentAnswer: '3', answer: '2',
    answerSource: '独立判卷', answerSourceNote: '独立验算', teacherAnswer: '',
    causeCode: 'L1', causeNote: '计算错误', kpoints: ['有理数'], difficulty: '易',
    hasFigure: false, confidence: 'high', sourceImageSha256: sha, notes: '',
    bbox: [0.02, 0.29, 0.96, 0.08], answerMode: 'blank', answerSlots: ['2'],
  };
  const cardsFile = path.join(E.allocTempDir('gn-fresh-cards-'), 'cards.json');
  fs.writeFileSync(cardsFile, JSON.stringify({
    envelope: { schema: 'glimmernote.ingest-result/v1', taskId, imageSha256: sha },
    result: { pageSummary: { totalQuestions: 1, markedWrong: 1, unmarked: 0 }, cards: [card], skipped: [] },
  }, null, 1), 'utf8');
  return { taskId, cardsFile, sha };
}

function main() {
  console.log('仓库：' + ROOT + '\n');

  /* ═════════ A · 新建学生：索引里没有学科节（事实基线） ═════════ */
  console.log('\n═══ A · 空库新建学生 ═══');
  const LIB = makeFreshLib();
  const st = runTool('_建学生.mjs', ['--name', '小明', '--grade', '七年级', '--json'], LIB);
  A('A1 新建学生成功', st.code === 0, 'exit=' + st.code + ' ' + (st.out + st.err).slice(0, 160));
  const idx0 = readIdx(LIB);
  A('A2 新学生的 subjects 是空对象（学科"按需长出来"）',
    idx0.subjects && typeof idx0.subjects === 'object' && Object.keys(idx0.subjects).length === 0,
    JSON.stringify(idx0.subjects));

  /* ═════════ B · 第一张卡：必须能进库 ═════════ */
  console.log('\n═══ B · 真跑入库（新学生第一张卡）═══');
  const { taskId, cardsFile } = stageTask(LIB);
  const r1 = runTool('_录题入库.mjs', ['入库', taskId, '--file', cardsFile, '--student', '小明', '--subject', '数学'], LIB);
  A('B1 ★ 全新库第一张卡入库 ⇒ exit 0（修前：exit 2「索引里没有学科」）',
    r1.code === 0, 'exit=' + r1.code + ' ' + (r1.out + r1.err).slice(0, 220));
  const idx1 = readIdx(LIB);
  A('B2 学科节点按需长出来了', !!(idx1.subjects && idx1.subjects['数学']), Object.keys(idx1.subjects || {}).join(','));
  A('B3 索引里真的多了一张卡（M0001）',
    (idx1.subjects['数学'].items || []).length === 1 && idx1.subjects['数学'].items[0].id === 'M0001',
    JSON.stringify((idx1.subjects['数学'].items || []).map(i => i.id)));
  const cardDir = path.join(LIB, '小明', '数学', 'M0001-新库第一张卡');
  for (const f of ['题干.html', '错题记录.md']) A('B4 卡目录里有 ' + f, fs.existsSync(path.join(cardDir, f)));
  A('B5 学科目录真的在（N4：有册必有卡）', fs.existsSync(path.join(LIB, '小明', '数学')));

  /* ═════════ C · 产物必须过数据区宪法门禁 ═════════ */
  console.log('\n═══ C · 入库产物过 `_数据区门禁.mjs` ═══');
  const g1 = runTool('_数据区门禁.mjs', [], LIB);
  A('C1 ★ 全新库入库后数据区门禁 exit 0（修前：G11 盲解清稿命名违规）',
    g1.code === 0, 'exit=' + g1.code + ' ' + (g1.out + g1.err).replace(/\s+/g, ' ').slice(0, 260));
  A('C2 门禁输出里没有"有卡无册 / 有册无卡"（学科闭环 N4）',
    !/有卡无册|有册无卡/.test(g1.out), '');
  const blindDir = path.join(LIB, '_盲解');
  const blindNames = fs.existsSync(blindDir) ? fs.readdirSync(blindDir) : [];
  A('C3 入库当场备好了盲解清稿', blindNames.some(n => /盲解清稿/.test(n)), blindNames.join('、'));
  A('C4 ★ 清稿名里**不许**出现 `-第1路`（N13 只认 `[-第2路][-重盲解][-<8位摘要>]`）',
    blindNames.every(n => !/-第1路/.test(n)), blindNames.join('、'));

  /* ═════════ D · 第 2 路清稿也必须是合规名 ═════════ */
  console.log('\n═══ D · `清稿 --lane 2 --ids` 的组合后缀 ═══');
  const d = runTool('_盲解复核.mjs', ['清稿', '--student', '小明', '--lane', '2', '--ids', 'M0001'], LIB);
  A('D1 第 2 路清稿生成成功', d.code === 0, 'exit=' + d.code + ' ' + (d.out + d.err).slice(0, 200));
  const after = fs.existsSync(blindDir) ? fs.readdirSync(blindDir) : [];
  A('D2 第 2 路清稿真的落盘', after.some(n => /-第2路/.test(n)), after.join('、'));
  const g2 = runTool('_数据区门禁.mjs', [], LIB);
  A('D3 ★ 两路清稿都在时门禁仍 exit 0（组合后缀没被放开成筛子）',
    g2.code === 0, 'exit=' + g2.code + ' ' + (g2.out + g2.err).replace(/\s+/g, ' ').slice(0, 260));

  /* ═════════ E · 阴性自证：摘掉自动建学科节 ⇒ 必须回到 exit 2 ═════════ */
  console.log('\n═══ E · 阴性自证（变异体必须复现原缺陷）═══');
  {
    const src = fs.readFileSync(ENGINE, 'utf8');
    const anchor = '    if (!v) v = j.subjects[subject] = { items: [] };\n';
    /* 变异体 = 把这一行换回**修前那句早退**（只删一行会变成 subjNode undefined ⇒ TypeError，
       那不是修前的真实行为，也就证明不了"B1 是靠这条判据才绿的"）。 */
    const legacy = "    if (!v) return { why: '学生 ' + student + ' 的索引里没有学科「' + subject + '」这一节（现有：' + Object.keys(j.subjects).join('、') + '）' };\n";
    A('E1 判据锚点在源码里（不是空壳）', src.includes(anchor), '');
    const mutDir = E.allocTempDir('gn-fresh-mut-');
    E.copyToolDeps(['_录题入库.mjs'], mutDir);
    fs.writeFileSync(path.join(mutDir, '_录题入库.mjs'), src.replace(anchor, legacy), 'utf8');

    const LIB2 = makeFreshLib();
    runTool('_建学生.mjs', ['--name', '小明', '--grade', '七年级', '--json'], LIB2);
    const t2 = stageTask(LIB2);
    const r = spawnSync(process.execPath, [path.join(mutDir, '_录题入库.mjs'), '入库', t2.taskId,
      '--file', t2.cardsFile, '--student', '小明', '--subject', '数学'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { CTB_DATA: LIB2 }),
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    A('E2 ★ 变异体（不自动建学科节）⇒ exit 2 且点名"没有学科"（证明 B1 抓得住）',
      r.status === 2 && /没有学科/.test(out), 'exit=' + r.status + ' ' + out.replace(/\s+/g, ' ').slice(0, 200));
    A('E3 变异体零写盘（卡一张都没进）',
      !fs.existsSync(path.join(LIB2, '小明', '数学', 'M0001-新库第一张卡')), '');
  }

  console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${total}${fails ? '  失败=' + fails : ''}`);
  process.exit(fails ? 1 : 0);
}

main();
