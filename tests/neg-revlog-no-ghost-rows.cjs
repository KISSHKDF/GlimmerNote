#!/usr/bin/env node
/**
 * 阴性用例（2026-11-23，审计 D-07 · P1）：批改**失败回滚**后，revlog 不得留下"没发生的批改"。
 *
 * 缺陷（修前）：actGrading 的判分循环里当场 appendFileSync 写 revlog；
 *   同一动作后续步骤失败（throw / process.exit(2)）⇒ process.on('exit') 把台账与索引**整体回滚**，
 *   但 append 无法回滚 ⇒ revlog 记下了没发生的批改（假账）。
 *   对账口径（neg-revlog-appendonly ④）在真源回滚后就会对不上：revlog 多出 normal 行。
 *
 * 本用例：临时库组卷 ⇒ 构造"批改串第二个结果**非法**"的半途失败（actGrading 循环中
 *   throw『编号不在库中』）⇒ 断言：
 *     ① 批改命令非零退出；
 *     ② 台账/索引回滚（批次仍是待批改、reviews 未变）；
 *     ③ ★ revlog **零新增行**（修正后 revlog 在事务 commit 之后才落盘）。
 *   阴性自证：把 flushRevlog() 挪回 commitTx() 之前（旧时序）⇒ 失败批改必须留下脏行。
 *
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = path.resolve(__dirname, '..');
const MARK_SRC = fs.readFileSync(path.join(REPO, 'src', 'tools', '_标记复习.mjs'), 'utf8');
let fails = 0, asserts = 0;
const A = (n, ok, d) => { asserts++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 240) : ''}`); if (!ok) fails++; };

/* 变异体：flush 挪回 commitTx 之前（复刻旧时序：失败也留行） */
const OLD_FLUSH = "/* ★ 2026-11-23（审计 D-07）：revlog 在事务提交**之后**落盘 —— 回滚路径不会再留下\n   \"没发生的批改\"的日志行（修前 append 不可回滚，失败也留行 ⇒ 假账）。 */\nflushRevlog();";
if (!MARK_SRC.includes(OLD_FLUSH)) {
  console.error('[前置失败] 找不到 flushRevlog() 的当前调用锚点——源码已变，请同步本用例锚点');
  process.exit(2);
}
/* 变异体：revlogAppend 退回**旧时序**——攒行改成当场落盘（复刻修前行为：
   判分循环里 appendFileSync，失败回滚也留行）。锚点是队列化的函数体。 */
const APPEND_ANCHOR = `function revlogAppend(entry) {
  PENDING_REVLOG.push(entry);
  return null;
}`;
if (!MARK_SRC.includes(APPEND_ANCHOR)) {
  console.error('[前置失败] 找不到 revlogAppend 的当前函数体——源码已变，请同步本用例锚点');
  process.exit(2);
}
const MUTATED_SRC = MARK_SRC.replace(APPEND_ANCHOR, `function revlogAppend(entry) {
  const dir = REVLOG_DIR(); fs.mkdirSync(dir, { recursive: true });
  const month = String(entry.ts).slice(0, 10).replace(/-/g, '').slice(0, 6);
  const file = path.join(dir, 'revlog-' + month + '.jsonl');
  fs.appendFileSync(file, JSON.stringify(entry) + '\\n', 'utf8');
  return file;
}`);
const mutDir = E.allocTempDir('gn-revlog-undo-mut-');
fs.mkdirSync(mutDir, { recursive: true });
{
  const deps = new Set(['_标记复习.mjs']);
  const q = ['_标记复习.mjs'];
  while (q.length) {
    const f = q.shift();
    const body = f === '_标记复习.mjs' ? MUTATED_SRC : fs.readFileSync(path.join(REPO, 'src', 'tools', f), 'utf8');
    for (const m of body.matchAll(/from\s+'\.\/([^']+\.mjs)'/g)) if (!deps.has(m[1])) { deps.add(m[1]); q.push(m[1]); }
  }
  for (const f of deps) fs.copyFileSync(path.join(REPO, 'src', 'tools', f), path.join(mutDir, f));
  fs.writeFileSync(path.join(mutDir, '_标记复习.mjs'), MUTATED_SRC, 'utf8');
}
const mutMark = path.join(mutDir, '_标记复习.mjs');

/* 夹具库：学生小甲，索引里有 M0001、M0002（批改串第二个结果故意非法，制造半途失败） */
const mkLib = () => {
  const lib = E.allocTempDir('gn-revlog-undo-');
  fs.mkdirSync(path.join(lib, '小甲', '数学'), { recursive: true });
  const mkCard = (id) => ({
    id, questionText: '计算 1+1', studentAnswer: '3', answer: '2',
    status: '', blindStatus: '已通过', blindSolveAt: '2026-11-01', blindSolver: 't', blindNote: '', blindFingerprint: 'x',
    answerSource: '独立判卷', kpoints: ['加法'], causeCode: 'S1', errorCount: 1,
    reviews: [], nextDue: '', answerMode: 'zone', student: '小甲', subject: '数学', stem: '1+1=?',
  });
  fs.writeFileSync(path.join(lib, '小甲', '数学', '_索引.json'),
    JSON.stringify({ student: '小甲', subject: '数学', items: [mkCard('M0001'), mkCard('M0002')] }, null, 1) + '\n', 'utf8');
  fs.writeFileSync(path.join(lib, '_组卷台账.json'), JSON.stringify({ note: 't', batches: [], paperSeq: {} }, null, 1) + '\n', 'utf8');
  return lib;
};
const revlogLines = (lib) => {
  try {
    const dir = path.join(lib, '_复习日志');
    const f = fs.readdirSync(dir).find(n => n.endsWith('.jsonl'));
    return f ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean) : [];
  } catch { return []; }
};
const paperOf = (out) => (String(out).match(/P\d{8}-\d{2,}/) || [''])[0];
const runMark = (lib, tool, args) => {
  const r = spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8', maxBuffer: 64e6, timeout: 120000,
    env: Object.assign({}, process.env, { CTB_DATA: lib }),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
};

/* ══ A · 修正后：失败批改不留脏行 ══ */
console.log('══ A · 批改半途失败（M0002 结果非法）⇒ 回滚 + revlog 零新增 ══');
{
  const lib = mkLib();
  const r1 = runMark(lib, path.join(REPO, 'src', 'tools', '_标记复习.mjs'),
    ['组卷', '--student', '小甲', '--ids', 'M0001,M0002', '--subject', '数学', '--title', '回滚用例卷', '--force']);
  A('A1 组卷成功', r1.code === 0, '');
  const paper = paperOf(r1.out);
  A('A2 解析到批次号', !!paper, paper);

  const ledgerBefore = JSON.parse(fs.readFileSync(path.join(lib, '_组卷台账.json'), 'utf8'));
  const idxBefore = fs.readFileSync(path.join(lib, '小甲', '数学', '_索引.json'), 'utf8');
  const revlogBefore = revlogLines(lib).length;

  /* M0001=对 先落盘，轮到 M0002 时 throw（非法结果）⇒ 事务回滚、revlog 攒的行必须被丢弃 */
  const r2 = runMark(lib, path.join(REPO, 'src', 'tools', '_标记复习.mjs'),
    ['批改', '--paper', paper, '--results', 'M0001=对,M0002=半错']);
  A('A3 批改非零退出（M0002 结果非法）', r2.code !== 0, 'exit=' + r2.code);
  const ledgerAfter = JSON.parse(fs.readFileSync(path.join(lib, '_组卷台账.json'), 'utf8'));
  const bAfter = ledgerAfter.batches.find(x => x.paperId === paper);
  A('A4 台账回滚：批次仍待批改、results 里没有 M0001',
    bAfter && bAfter.status === '待批改' && !(bAfter.results || {}).M0001,
    'status=' + (bAfter && bAfter.status) + ' results=' + JSON.stringify(bAfter && bAfter.results));
  A('A5 索引回滚：M0001 的 reviews 未变', fs.readFileSync(path.join(lib, '小甲', '数学', '_索引.json'), 'utf8') === idxBefore, '');
  A('★★ A6 revlog 零新增（没发生的批改不进日志）', revlogLines(lib).length === revlogBefore,
    '行数 ' + revlogBefore + '→' + revlogLines(lib).length);
}

/* ══ B · 阴性自证：旧时序（flush 在 commit 前）⇒ 失败批改留脏行 ══ */
console.log('\n══ B · 阴性自证：旧时序变异体必须留下脏行 ══');
{
  const lib = mkLib();
  const r1 = runMark(lib, mutMark, ['组卷', '--student', '小甲', '--ids', 'M0001,M0002', '--subject', '数学', '--title', '变异卷', '--force']);
  A('B1 变异体组卷成功', r1.code === 0, 'exit=' + r1.code);
  const paper = paperOf(r1.out);
  const revlogBefore = revlogLines(lib).length;
  const r2 = runMark(lib, mutMark, ['批改', '--paper', paper, '--results', 'M0001=对,M0002=半错']);
  A('B2 变异体批改同样非零退出', r2.code !== 0, 'exit=' + r2.code);
  const after = revlogLines(lib);
  A('★★ B3 变异体（旧时序）留下脏行 ⇒ 判据有牙齿', after.length > revlogBefore,
    '行数 ' + revlogBefore + '→' + after.length);
}

console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${asserts} 失败=${fails}`);
process.exit(fails ? 1 : 0);
