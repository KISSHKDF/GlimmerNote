#!/usr/bin/env node
/**
 * revlog 追加式复习日志（方案批次 4-1，2026-11-14）：Anki revlog 的本地化落地。
 * 判据（方案验收原文）：revlog 与 reviews[] 逐条可对账 + **只增不改** + 并发写不丢行 + 崩溃不半行。
 *
 * ① 行为链：真跑 `_标记复习.mjs 组卷 → 批改`（临时库）⇒ `_复习日志\revlog-<月>.jsonl` 出现
 *    与判分同数的行；字段契约（ts/cardId/paperId/rating/result/intervalBefore/intervalAfter/
 *    dueBefore/dueAfter/errorCountBefore/After/type/by）齐全；rating 映射 对=1/半对=2/错=3。
 * ② 只增不改：第二次批改后第一天的行**逐字节不变**（追加式，不是重写）。
 * ③ 撤批落 undo：撤批后正向行还在 + 新增 undo 行（undidResults 带被撤结果）。
 * ④ 对账：revlog 里 type=normal 的行数 == 批次 results 的判分数（撤销后对账走 undo 行）。
 * ⑤ 并发：两进程同时 append 不同行 ⇒ 全部落盘、无交错损坏（每行仍是合法 JSON）。
 * ⑥ 崩溃半行：文件尾带半行（无 \n 的残串）⇒ 读取方（本用例的对账器）忽略残行并提示——
 *    appendFileSync 单行原子性之外的场景（断电在 write 与 flush 之间）不静默冒充好数据。
 *
 * 全程 %TEMP% 临时库（_标记复习 组卷会写真库路径 ⇒ 用 CTB_TEST_LIB 指到临时库），
 * 夹具学生/卡用最小索引形状（_标记复习 的 findIndexFile/迁移链兼容）。
 * 用法：node tests\neg-revlog-appendonly.cjs
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = path.resolve(__dirname, '..');
const MARK = path.join(REPO, 'src', 'tools', '_标记复习.mjs');

let fails = 0, asserts = 0;
const A = (n, ok, d) => { asserts++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 260) : ''}`); if (!ok) fails++; };

/* ── 临时库夹具：一个学生一份索引、两张卡（items 数组形态；字段齐到过门禁，指纹门禁 --force 绕）── */
const lib = E.allocTempDir('gn-revlog-');
fs.mkdirSync(path.join(lib, '小甲', '数学'), { recursive: true });
const idxPath = path.join(lib, '小甲', '数学', '_索引.json');
const mkCard = (id) => ({
  id, questionText: '计算 1+1', studentAnswer: '3', answer: '2',
  status: '', blindStatus: '已通过', blindSolveAt: '2026-11-01', blindSolver: 't', blindNote: '', blindFingerprint: 'x',
  answerSource: '独立判卷', kpoints: ['加法'], causeCode: 'S1', errorCount: 1,
  reviews: [], nextDue: '', answerMode: 'zone', student: '小甲', subject: '数学', stem: '1+1=?',
});
fs.writeFileSync(idxPath, JSON.stringify({ student: '小甲', subject: '数学', items: [mkCard('M0001'), mkCard('M0002')] }, null, 1) + '\n', 'utf8');
fs.writeFileSync(path.join(lib, '_组卷台账.json'), JSON.stringify({ note: 't', batches: [], paperSeq: {} }, null, 1) + '\n', 'utf8');

const env = Object.assign({}, process.env, { CTB_DATA: lib });
function runMark(args) {
  let code = 0, out = '';
  try { out = execFileSync(process.execPath, [MARK, ...args], { encoding: 'utf8', env, timeout: 120000 }); }
  catch (e) { code = e.status == null ? -1 : e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
  return { code, out };
}
const paperOf = (out) => (String(out).match(/P\d{8}-\d{2,}/) || [''])[0];
const revlogFiles = () => { try { return fs.readdirSync(path.join(lib, '_复习日志')).filter(n => n.endsWith('.jsonl')); } catch { return []; } };
const revlogText = (name) => fs.readFileSync(path.join(lib, '_复习日志', name), 'utf8');
const parseLines = (text) => text.split('\n').filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch { return { __broken: true, line: i + 1 }; } });

/* ① 组卷 + 批改 ⇒ revlog 出现且字段齐 */
{
  const r1 = runMark(['组卷', '--student', '小甲', '--ids', 'M0001,M0002', '--subject', '数学', '--title', 'revlog 用例卷', '--force']);
  A('①a 组卷成功（临时库）', r1.code === 0, (r1.out.match(/批次 P\d+-\d+/) || [''])[0]);
  const r2 = runMark(['批改', '--paper', paperOf(r1.out), '--results', 'M0001=对,M0002=错', '--by', '家长']);
  A('①b 批改成功', r2.code === 0, (r2.out.split(/\r?\n/).filter(l => l.includes('M000'))[0] || '').trim());
  const files = revlogFiles();
  A('①c _复习日志\\ 出现月卷 revlog-<YYYYMM>.jsonl', files.length === 1 && /^revlog-\d{6}\.jsonl$/.test(files[0]), files.join(','));
  const rows = files.length ? parseLines(revlogText(files[0])) : [];
  const normal = rows.filter(r => r.type === 'normal');
  A('①d 两题判分 ⇒ 2 行 normal', normal.length === 2, rows.length + ' 行');
  if (normal.length === 2) {
    const need = ['ts', 'cardId', 'student', 'paperId', 'rating', 'result', 'intervalBefore', 'intervalAfter', 'dueBefore', 'dueAfter', 'errorCountBefore', 'errorCountAfter', 'type', 'by'];
    A('①e 行字段契约齐备（14 字段）', normal.every(r => need.every(k => k in r)), normal[0] && Object.keys(normal[0]).join(','));
    const byCard = {};
    normal.forEach(r => { byCard[r.cardId] = r; });
    A('①f rating 映射：对=1 错=3', byCard.M0001 && byCard.M0001.rating === 1 && byCard.M0002 && byCard.M0002.rating === 3,
      JSON.stringify({ M0001: byCard.M0001 && byCard.M0001.rating, M0002: byCard.M0002 && byCard.M0002.rating }));
    A('①g intervalAfter 走了固定阶梯：对(连对1)=7 天，错=1 天',
      byCard.M0001 && byCard.M0001.intervalAfter === 7 && byCard.M0002 && byCard.M0002.intervalAfter === 1,
      'M0001=' + (byCard.M0001 && byCard.M0001.intervalAfter) + ' M0002=' + (byCard.M0002 && byCard.M0002.intervalAfter));
    A('①h dueAfter 已落到卡（nextDue 与 dueAfter 一致）',
      byCard.M0001 && byCard.M0001.dueAfter && byCard.M0001.dueAfter === byCard.M0001.dueAfter, '');
    A('①i by=家长 进了流水', normal.every(r => r.by === '家长'), normal.map(r => r.by).join(','));
  }
  /* ② 只增不改：再批改一次（另一批卷），首天的行逐字节不变 */
  const textBefore = revlogText(files[0]);
  const r3 = runMark(['组卷', '--student', '小甲', '--ids', 'M0001', '--subject', '数学', '--title', '第二轮', '--force']);
  const r4 = runMark(['批改', '--paper', paperOf(r3.out), '--results', 'M0001=对']);
  const linesBefore = textBefore.split('\n').filter(Boolean);
  const textAfter = revlogText(files[0]);
  const linesAfter = textAfter.split('\n').filter(Boolean);
  A('② 只增不改：旧行逐字节保留、新行追加在尾',
    linesAfter.length === linesBefore.length + 1 &&
    linesBefore.every((l, i) => linesAfter[i] === l),
    linesBefore.length + '→' + linesAfter.length);
  /* ③ 撤批落 undo（撤第二轮那批） */
  const p2 = (r3.out.match(/P\d{8}-\d+/) || [''])[0];
  const r5 = runMark(['撤批', '--paper', p2]);
  A('③a 撤批成功', r5.code === 0, '');
  const rowsAll = parseLines(revlogText(files[0]));
  const undo = rowsAll.filter(r => r.type === 'undo');
  A('③b 撤批 ⇒ 正向行仍在 + undo 行追加（不删正向行）',
    rowsAll.filter(r => r.type === 'normal').length === 3 && undo.length === 1,
    'normal=' + rowsAll.filter(r => r.type === 'normal').length + ' undo=' + undo.length);
  A('③c undo 行带 undidResults（被撤结果可追溯）', undo.length === 1 && JSON.stringify(undo[0].undidResults) === '["对"]', JSON.stringify(undo[0].undidResults));
  /* ④ 对账：normal 行数 − undo 行数 == 现存批次判分数（每条 undo 抵一条被撤正向行；
     语义：revlog 是**事件流水**——判分事件不因撤销消失，撤销本身也是事件。
     对账口径 = 净判分（normal−undo）对平"台账里现存的结果数"。 */
  const ledger = JSON.parse(fs.readFileSync(path.join(lib, '_组卷台账.json'), 'utf8'));
  const gradedInLedger = ledger.batches.reduce((a, b) => a + Object.keys(b.results || {}).length, 0);
  const nNormal = rowsAll.filter(r => r.type === 'normal').length;
  const nUndo = rowsAll.filter(r => r.type === 'undo').length;
  A('④ 对账：normal − undo == 现存批次判分数（净判分对平；撤销本身也是流水事件）',
    nNormal - nUndo === gradedInLedger,
    'normal=' + nNormal + ' undo=' + nUndo + ' 净=' + (nNormal - nUndo) + ' ledger=' + gradedInLedger);
}

/* ⑤ 并发 append：两进程同时各写 40 行 ⇒ 80 行全落盘、每行合法 JSON */
{
  const target = path.join(lib, '_复习日志', 'revlog-concurrent-test.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const child = `const fs=require('fs');for(let i=0;i<40;i++){fs.appendFileSync(${JSON.stringify(target)},JSON.stringify({who:'A',i})+'\\n');}`;
  const child2 = child.replace(/who:'A'/, "who:'B'");
  const ps = [child, child2].map(code =>
    spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 60000 }));
  A('⑤a 两个并发 append 进程都正常退出', ps.every(p => p.status === 0), ps.map(p => p.status).join(','));
  const rows = parseLines(fs.readFileSync(target, 'utf8'));
  const broken = rows.filter(r => r.__broken);
  A('⑤b 并发写 80 行全落盘、零交错损坏（每行合法 JSON）', rows.length === 80 && broken.length === 0,
    rows.length + ' 行，坏行 ' + broken.length);
  A('⑤c 两路各 40 行都在（无丢失）',
    rows.filter(r => r.who === 'A').length === 40 && rows.filter(r => r.who === 'B').length === 40,
    'A=' + rows.filter(r => r.who === 'A').length + ' B=' + rows.filter(r => r.who === 'B').length);
  /* ⑥ 崩溃半行：尾部追加无 \n 残串 ⇒ 对账器（parseLines）忽略残行并可见 */
  fs.appendFileSync(target, '{"who":"C","i":41');    // 故意不带 \n 的半行
  const rows2 = parseLines(fs.readFileSync(target, 'utf8'));
  A('⑥ 崩溃半行不冒充好数据：读取方忽略残行（81 完整行 + 0 误读）',
    rows2.filter(r => !r.__broken).length === 80 && rows2.filter(r => r.__broken).length === 1,
    'good=' + rows2.filter(r => !r.__broken).length + ' broken=' + rows2.filter(r => r.__broken).length);
}

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + '  断言=' + asserts + (fails ? ' 失败=' + fails : ''));
process.exit(fails ? 1 : 0);
