#!/usr/bin/env node
/**
 * 变式题 Phase 1 检索工具（`_变式.mjs`）的验收用例（2026-11-09 建）
 *
 * 权威规格：v1 冻结树 docs\调研-变式题工作流-20261011.md §9 Phase 1。
 * 本用例守五条（全部在 %TEMP% 自建迷你库上**真跑** `_变式.mjs`，绝不碰真库）：
 *   ① **确定性**：`检索 --for <卡> --json` 两次独立进程调用**逐字节相同**（Phase 1 验收断言①）。
 *   ② **七条门禁逐条生效**：种子库为每条门禁各埋一张"只违反它"的卡 ⇒ 排除计数逐条对上，
 *      且候选名单里绝无被排除卡。
 *   ③ **单门禁隔离**（阴性对照的等价形）：源卡的唯一同考点兄弟只违反一条门禁 ⇒
 *      候选必须为 0 且该门禁计数 = 1（证明是这条门禁独立决定的，不是凑巧）。
 *   ④ **跨学生歧义硬失败**：同编号命中两张卡 ⇒ exit 2 要求 --student（BUG-05 同源教训，
 *      绝不静默取第一张）。
 *   ⑤ **两种索引形状 + fixture 形状库兼容**：学科级 items[] 与学生级 subjects{} 都能枚举；
 *      对 fixtures\库-形状 跑 检索/资格 不炸（旧错因码 S01/W01 也必须兼容——本工具不校验枚举）。
 * 另：`--selftest`（纯函数自证）必须 exit 0。
 *
 * 用法：node tests\verify-variant-retrieval.cjs
 * 退出码：0=全绿；1=有断言失败
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_变式.mjs');
const FIXTURE_LIB = path.join(ROOT, 'fixtures', '库-形状');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-variant-'));
const LIB = path.join(TMP, 'lib');

function runTool(args, lib) {
  const r = spawnSync(process.execPath, [ENGINE, ...args, '--data', lib], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: lib }),
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '')); } catch { }
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json };
}

/* ---------- 迷你库 ----------
 * 学生甲·数学（学科级 items 形态）：V0001 源卡 + 每条门禁一张"只违反它"的卡 + 2 张合规候选
 * 学生甲·物理（学科级）：V0008 跨学科
 * 学生乙（学生级 subjects 形态）：V0009 跨学生；V0013 与学生甲重号（歧义用）
 * 学生甲·英语（学科级）：E0001（语数英普查计数用）
 */
function card(o) {
  return Object.assign({
    id: 'V0000', dir: 'V0000-卡', source: '合成样例', sourceDate: '2026-11-01', type: '解答题',
    question: '已知 a=1，求 a+2。', answer: '3', studentAnswer: '4',
    kpoints: ['考A'], causeLayer: '知识', causeCode: 'K1', causeDesc: '合成', causeConfirmed: true,
    difficulty: '中', errorCount: 1, status: '在册', hasImage: false, hasVariants: false,
    reviews: [], reviewStatus: '未复习', reviewCount: 0, passStreak: 0,
    blindStatus: '已通过', blindSolveAt: '2026-11-01T00:00:00+08:00', blindSolver: '合成样例',
    blindNote: '', blindFingerprint: '0000000000000000',
    answerSource: '独立判卷', answerSourceNote: '合成样例',
  }, o);
}
function writeIndex(p, j) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(j, null, 1) + '\n', 'utf8');
}
const mathCards = [
  card({ id: 'V0001', dir: 'V0001-源卡', kpoints: ['考A', '考B'], difficulty: '易', question: '已知 a=1，求 a+2。' }),
  card({ id: 'V0002', dir: 'V0002-合规甲', kpoints: ['考A'] }),                                            // 候选①（+1 档允许）
  card({ id: 'V0010', dir: 'V0010-合规乙', kpoints: ['考A'] }),                                            // 候选②（图形卡，目录里有 svg）
  card({ id: 'V0003', dir: 'V0003-难两档', kpoints: ['考A'], difficulty: '难' }),                          // g3
  card({ id: 'V0004', dir: 'V0004-盲解未过', kpoints: ['考A'], blindStatus: '不一致' }),                   // g2
  card({ id: 'V0005', dir: 'V0005-错因未确认', kpoints: ['考A'], causeConfirmed: false }),                 // g5
  card({ id: 'V0006', dir: 'V0006-抄写笔误', kpoints: ['考A'], causeCode: 'S4', causeLayer: '习惯' }),     // g6
  card({ id: 'V0007', dir: 'V0007-已归档', kpoints: ['考A'], status: '已归档', question: '已知 x，(一)求 y。' }), // arch＋多问计数
  card({ id: 'V0013', dir: 'V0013-重号甲', kpoints: ['考D'] }),                                            // 跨学生重号（学生甲侧）
  card({ id: 'V0011', dir: 'V0011-孤立源', kpoints: ['考C'] }),                                            // 隔离用源卡B
  card({ id: 'V0012', dir: 'V0012-孤科兄弟', kpoints: ['考C'], blindStatus: '不一致' }),                   // V0011 的唯一兄弟，只违反 g2
];
const physCards = [card({ id: 'V0008', dir: 'V0008-跨学科', kpoints: ['考A'], subject: '物理', causeLayer: '知识' })];
const ethStuCards = [card({ id: 'V0009', dir: 'V0009-跨学生', kpoints: ['考A'] })];
const ethStuDup = [card({ id: 'V0013', dir: 'V0013-重号乙', kpoints: ['考E'] })];
const engCards = [card({ id: 'E0001', dir: 'E0001-英语卡', kpoints: ['考E'], causeCode: 'K5' })];

writeIndex(path.join(LIB, '学生甲', '数学', '_索引.json'), { student: '学生甲', grade: '九年级', subject: '数学', note: '合成形状数据（verify-variant-retrieval 自建），非真实题库。', items: mathCards });
writeIndex(path.join(LIB, '学生甲', '物理', '_索引.json'), { student: '学生甲', grade: '九年级', subject: '物理', items: physCards });
writeIndex(path.join(LIB, '学生甲', '英语', '_索引.json'), { student: '学生甲', grade: '九年级', subject: '英语', items: engCards });
writeIndex(path.join(LIB, '学生乙', '_索引.json'), { student: '学生乙', grade: '七年级', note: '合成形状数据（verify-variant-retrieval 自建），非真实题库。', subjects: { 数学: { items: ethStuCards.concat(ethStuDup) } } });
/* V0010 是图形卡：目录里放含 <svg> 的题干.html（isFigureCard 判据） */
fs.mkdirSync(path.join(LIB, '学生甲', '数学', 'V0010-合规乙'), { recursive: true });
fs.writeFileSync(path.join(LIB, '学生甲', '数学', 'V0010-合规乙', '题干.html'), '<p>如图</p><svg width="1" height="1"></svg>', 'utf8');

/* ---------- ① selftest ---------- */
{
  const r = runTool(['--selftest'], LIB);
  A('selftest exit 0（纯函数自证 17 断言）', r.code === 0 && /selftest ok/.test(r.out), r.err.trim().split('\n')[0] || r.out.trim().split('\n')[0]);
}

/* ---------- ② 确定性（Phase 1 验收断言①） ---------- */
{
  const r1 = runTool(['检索', '--for', 'V0001', '--json'], LIB);
  const r2 = runTool(['检索', '--for', 'V0001', '--json'], LIB);
  A('检索 --json 两次独立进程逐字节相同', r1.code === 0 && r1.out === r2.out && r1.out.length > 10,
    r1.code !== 0 ? r1.err.trim().split('\n')[0] : (r1.out === r2.out ? '' : '两次输出不同'));
  const j = r1.json || {};
  const ids = (j.candidates || []).map(c => c.id);
  A('候选恰为两张合规卡且排序确定（V0002,V0010）', JSON.stringify(ids) === JSON.stringify(['V0002', 'V0010']), JSON.stringify(ids));
  A('候选共享考点与 via 标记正确',
    (j.candidates || []).every(c => c.via === '库内检索' && JSON.stringify(c.sharedKpoints) === JSON.stringify(['考A'])),
    JSON.stringify((j.candidates || [])[0] || {}));
}

/* ---------- ③ 七条门禁逐条生效 ---------- */
{
  const r = runTool(['检索', '--for', 'V0001', '--json'], LIB);
  const ex = (r.json && r.json.excludedByGate) || {};
  A('g1 同生同学（跨学科V0008＋跨学生V0009/V0013乙＋英语E0001 都被拒）', ex.g1 === 4, JSON.stringify(ex));
  A('kpoints 无交集（V0011/V0013甲；V0012 因盲解先于考点判而落 g2 桶）', ex.kpoints === 2, JSON.stringify(ex));
  A('g2 盲解（V0004＋V0012 都不一致被拒：门禁顺序=规格序，盲解先于考点判）', ex.g2 === 2, JSON.stringify(ex));
  A('g3 难度（V0003 易→难 被拒）', ex.g3 === 1, JSON.stringify(ex));
  A('g5 错因未确认（V0005 被拒）', ex.g5 === 1, JSON.stringify(ex));
  A('g6 候选 S4（V0006 被拒）', ex.g6 === 1, JSON.stringify(ex));
  A('arch 非在册（V0007 被拒）', ex.arch === 1, JSON.stringify(ex));
  A('self 自身排除', ex.self === 1, JSON.stringify(ex));
  A('候选名单绝无被排除卡', (r.json.candidates || []).every(c => !['V0003', 'V0004', 'V0005', 'V0006', 'V0007', 'V0008', 'V0009'].includes(c.id)),
    JSON.stringify((r.json.candidates || []).map(c => c.id)));
}

/* ---------- ④ 单门禁隔离：V0011 的唯一兄弟 V0012 只违反 g2 ---------- */
{
  const r = runTool(['检索', '--for', 'V0011', '--json'], LIB);
  A('隔离：唯一同考点兄弟 V0012 只能被 g2 拒 ⇒ 候选 0（g2 桶 ≥1 且无候选）',
    r.code === 0 && r.json && r.json.count === 0 && (r.json.excludedByGate.g2 || 0) >= 1 && r.json.pool.passed === 0,
    JSON.stringify({ count: r.json && r.json.count, ex: r.json && r.json.excludedByGate, pool: r.json && r.json.pool }));
}

/* ---------- ⑤ 跨学生歧义硬失败（BUG-05 同源） ---------- */
{
  const r = runTool(['检索', '--for', 'V0013'], LIB);
  A('重号编号必须 exit 2 并点名 --student', r.code === 2 && /--student/.test(r.err), r.err.trim().split('\n')[0]);
  const r2 = runTool(['检索', '--for', 'V0013', '--student', '学生乙'], LIB);
  A('显式 --student 后可正常检索', r2.code === 0, r2.err.trim().split('\n')[0]);
}

/* ---------- ⑥ S4 源卡拒绝（口径⑥双侧） ---------- */
{
  const r = runTool(['检索', '--for', 'V0006'], LIB);
  A('源卡 S4 拒绝检索（exit 2 + 指向调研劝退）', r.code === 2 && /S4/.test(r.err), r.err.trim().split('\n')[0]);
}

/* ---------- ⑦ 资格普查计数对上种子 ---------- */
{
  const r = runTool(['资格', '--json'], LIB);
  const j = r.json || {};
  const c = j.classes || {};
  A('普查：图形卡=1（V0010 的 svg 题干）', c.figure === 1, JSON.stringify(c));
  A('普查：语文/英语=1', c.langCNEN === 1, JSON.stringify(c));
  A('普查：S4=1 / 错因未确认=1 / 多问(下限)=1', c.s4 === 1 && c.causeUnconfirmed === 1 && c.multiPart === 1, JSON.stringify(c));
  A('普查：检索覆盖 ≥2（V0001/V0002/V0010 互相构成候选）', (j.coverage || {}).withCandidate >= 2, JSON.stringify(j.coverage));
}

/* ---------- ⑧ fixture 形状库兼容（旧错因码 + 两种索引形态） ---------- */
{
  const r = runTool(['检索', '--for', 'C0102', '--json'], FIXTURE_LIB);
  A('对 fixtures 库-形状 检索不炸（exit 0，无共享考点候选 0）', r.code === 0 && r.json && r.json.count === 0,
    r.code !== 0 ? r.err.trim().split('\n')[0] : 'count=' + r.json.count);
  const c = runTool(['资格'], FIXTURE_LIB);
  A('对 fixtures 库-形状 资格普查不炸（exit 0，图形卡 ≥2）', c.code === 0 && /图形卡 [2-9]/.test(c.out), c.out.trim().split('\n')[1] || '');
}

/* ---------- 清场 ---------- */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

console.log(`\nRESULT=verify-variant-retrieval 通过=${pass} 失败=${fail}`);
process.exit(fail ? 1 : 0);
