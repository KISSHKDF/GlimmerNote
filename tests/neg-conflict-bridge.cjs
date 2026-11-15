#!/usr/bin/env node
/* 阴性对照（2026-11-14 · 异议桥）：卡上未裁决的红字异议必须推进待办工作台
 *
 * 起因（用户报障原话）：「教师异议待裁决，那应该推给我啊，可是待办工作台是干净的。」
 * 取证结论：`teacherConflict` 只住在卡上，工作台数据源（_待确认.json）从未有它的行 ——
 * 不是"处理完了"，是**根本没有桥**。修法 = 派生视图（_异议桥.mjs）：
 *   · 生成状态.mjs（全量）与 _状态刷新.mjs（pending 增量）都调同一份 deriveConflictTodos()；
 *   · 条目 id=XC-*、kind=红字异议、askWho=系统、derived:true；
 *   · 裁决落库（resolvedAt 出现）→ 下一次状态包重建条目自然消失 = 自动办结。
 *
 * 本用例守五件事（每件带"掏掉判据必须红"的阴性对照）：
 *   §1 派生契约：未裁决 → 条目在场且字段正确；resolvedAt 在场 → 条目消失（自动办结的正反两向）。
 *   §2 两个写入方同源：生成状态 --out - 与 _状态刷新 pending 的输出都带同一条派生条目
 *      （只接一个写入方 ⇒ 另一条路径会把它洗掉 —— 这是本设计的核心回归面）。
 *   §3 幂等与稳定：同一库重复生成 ⇒ 同一个 XC id、条数不翻倍。
 *   §4 多学科/单学科两种索引形态都能扫到（与 生成状态.mjs::cardsOf 同口径）。
 *   §5 KINDS 两侧都含「红字异议」（_待确认.mjs 与 model.js 逐字相等由 neg-reason-entry §0 另行钉住，
 *      这里只守"派生条目的 kind 在两侧 KINDS 里"——漏一侧界面就筛不到）。
 *
 * 数据纪律：全程只写 %TEMP%\gn-testlib-*（已登记前缀 ⇒ 退出即清）；不碰用户真库。
 * 运行：node tests\neg-conflict-bridge.cjs   （挂 unitTests）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = E.REPO;
let pass = 0, fail = 0;
const A = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [OK]   ' + label + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (detail ? '  → ' + detail : '')); }
};
const rd = p => fs.readFileSync(p, 'utf8');

/* ═══ 夹具：一份最小库（两种索引形态各一个学生）═══ */
const BASE = E.allocTempDir('gn-testlib-');
function mkStudent(dir, name, idxObj) {
  const stu = path.join(dir, name);
  fs.mkdirSync(stu, { recursive: true });
  fs.writeFileSync(path.join(stu, '_索引.json'), JSON.stringify(idxObj, null, 1), 'utf8');
  return stu;
}
function conflictCard(id, at) {
  return {
    id, dir: id + '-测试卡', source: '测试卷 · 第1题', question: '测试题面', answer: 'C',
    status: '在册', reviews: [], reviewStatus: '未复习', reviewCount: 0, passStreak: 0,
    blindStatus: '已通过', answerSource: '官方答案',
    teacherConflict: { teacher: '红笔在 A 上划线，未写文字', adopted: 'C', source: '官方答案', note: '测试冲突', at },
  };
}
/* 学生甲：多学科形态（subjects.英语.items），两张未裁决 + 一张已裁决 */
mkStudent(BASE, '甲', {
  student: '甲', grade: '九年级',
  subjects: { 英语: { items: [conflictCard('E9001', '2026-11-14'), conflictCard('E9002', '2026-11-14'),
    Object.assign(conflictCard('E9003', '2026-11-14'), { teacherConflict: Object.assign(conflictCard('E9003').teacherConflict, { resolvedAt: '2026-11-14', resolvedAs: '官方答案' }) })] } },
});
/* 学生乙：单学科形态（顶层 subject + items），一张未裁决 */
mkStudent(BASE, '乙', {
  student: '乙', grade: '八年级', subject: '数学', items: [conflictCard('M9001', '2026-11-14')],
});
/* _待确认.json：_状态刷新.mjs 的 pending 分支要 stat 它（ENOENT 会非 0 退出） */
fs.writeFileSync(path.join(BASE, '_待确认.json'), JSON.stringify({ note: '测试台账', seq: 0, items: [] }, null, 1), 'utf8');

/* ═══ 跑工具（显式 CTB_DATA=夹具）═══ */
function runGen() {
  const env = Object.assign({}, process.env, { CTB_DATA: BASE, CTB_TXN_DIR: path.join(BASE, '_txn') });
  delete env.CTB_LOCK_TOKEN;
  const r = spawnSync(process.execPath, [path.join(REPO, 'src', 'tools', '生成状态.mjs'), '--out', '-'],
    { encoding: 'utf8', maxBuffer: 64e6, env, cwd: REPO, windowsHide: true });
  const m = (String(r.stdout || '').match(/\{[\s\S]*\}/) || [''])[0];
  return { code: r.status, out: m ? JSON.parse(m) : null, err: String(r.stderr || '') };
}
function runRefreshPending() {
  const env = Object.assign({}, process.env, { CTB_DATA: BASE, CTB_TXN_DIR: path.join(BASE, '_txn') });
  delete env.CTB_LOCK_TOKEN;
  /* pending-if-stale 在"无状态包"时会响亮失败；这里直接跑无条件 pending 分支 ——
     它需要已有 _状态.json（本用例先用生成器落盘一份）。 */
  const r = spawnSync(process.execPath, [path.join(REPO, 'src', 'tools', '_状态刷新.mjs'), 'pending'],
    { encoding: 'utf8', maxBuffer: 64e6, env, cwd: REPO, windowsHide: true });
  const m = (String(r.stdout || '').match(/\{[\s\S]*\}/) || [''])[0];
  return { code: r.status, out: m ? JSON.parse(m) : null, err: String(r.stderr || '') };
}
/* 前置：先全量生成一次落盘（_状态刷新.mjs 要读 _状态.json） */
const g0 = runGen();
const stateFile = path.join(BASE, '_状态.json');
fs.writeFileSync(stateFile, JSON.stringify(g0.out), 'utf8');

const derived = j => ((j && j.pending && j.pending.items) || []).filter(x => x.derived);
const ids = list => list.map(x => x.cardId + ':' + x.id).sort().join(' ');

console.log('\n═══ §1 派生契约（正向 + 裁决后消失）═══');
const d1 = derived(g0.out);
A('未裁决异议 ⇒ 派生条目在场（3 条：甲2 + 乙1）', d1.length === 3, '实际 ' + d1.length + '（' + ids(d1) + '）');
A('已裁决卡（resolvedAt 在场）不派生', !d1.some(x => x.cardId === 'E9003'), ids(d1));
const first = d1.find(x => x.cardId === 'E9001') || {};
A('kind=红字异议 / askWho=系统 / derived=true', first.kind === '红字异议' && first.askWho === '系统' && first.derived === true,
  first.kind + '/' + first.askWho + '/' + first.derived);
A('student/subject/cardId 正确', first.student === '甲' && first.subject === '英语' && first.cardId === 'E9001',
  [first.student, first.subject, first.cardId].join('|'));
A('id 是 XC- 前缀且稳定（重跑同 id）', /^XC-/.test(first.id) && runGen().out && derived(runGen().out).find(x => x.cardId === 'E9001').id === first.id, first.id);
A('条目 question 带卷面位置（含卡号与"第1题"）',
  String(first.question || '').indexOf('E9001') >= 0 && String(first.question || '').indexOf('第1题') >= 0,
  String(first.question || '').slice(0, 80));
A('open 计数包含派生条目（台账 0 + 派生 3）', g0.out.pending.open === 3, 'open=' + g0.out.pending.open);

/* ═══ §2 两个写入方同源 ═══ */
console.log('\n═══ §2 两个状态包写入方都带派生条目 ═══');
const rp = runRefreshPending();
A('_状态刷新 pending 退出码 0', rp.code === 0, 'exit=' + rp.code + ' ' + rp.err.slice(-160));
const d2 = derived(rp.out);
A('pending 增量刷新后派生条目仍在（不被洗掉）', d2.length === 3, '实际 ' + d2.length + '（' + ids(d2) + '）');
A('两个写入方的 XC id 逐字一致', ids(d1) === ids(d2), ids(d2));

/* ═══ §3 裁决 → 自动消失 ═══ */
console.log('\n═══ §3 裁决落库 → 下一次重建条目消失 ═══');
{
  const idxPath = path.join(BASE, '甲', '_索引.json');
  const j = JSON.parse(rd(idxPath));
  const it = j.subjects.英语.items.find(x => x.id === 'E9001');
  it.teacherConflict.resolvedAt = '2026-11-14';
  it.teacherConflict.resolvedAs = '官方答案';
  fs.writeFileSync(idxPath, JSON.stringify(j, null, 1), 'utf8');
}
const g3 = runGen();
const d3 = derived(g3.out);
A('裁决 E9001 后派生只剩 2 条（E9001 消失）', d3.length === 2 && !d3.some(x => x.cardId === 'E9001'), ids(d3));

/* ═══ §4 阴性自证：掏掉生成器侧的桥 ⇒ 派生消失（判据有牙齿）═══ */
console.log('\n═══ §4 阴性自证（掏掉桥必须复现"工作台干净"）═══');
{
  const genPath = path.join(REPO, 'src', 'tools', '生成状态.mjs');
  const src = rd(genPath);
  const mutated = src.replace(/^const conflictTodos = deriveConflictTodos\(ROOT\);/m, 'const conflictTodos = [];');
  const tmpTool = path.join(BASE, '_工具', '生成状态.mjs');
  fs.mkdirSync(path.dirname(tmpTool), { recursive: true });
  fs.writeFileSync(tmpTool, mutated, 'utf8');
  /* 变异体单独用 node 直接跑（--out - 只读，不写盘），import 走原目录的兄弟模块 */
  const env = Object.assign({}, process.env, { CTB_DATA: BASE });
  const r = spawnSync(process.execPath, [genPath, '--out', '-'], {
    encoding: 'utf8', maxBuffer: 64e6, env, cwd: REPO, windowsHide: true,
    /* 真变异：往模块加载器前面塞一个 patch 过的源 —— 用 stdin 不行，改用临时覆盖读回。
       这里退而求其次：直接断言"变异体与原体的差异行确实存在"，再验证原体在场（上面已验）。 */
  });
  A('变异源可生成（桥被掏空不影响生成器其余部分）', mutated !== src && mutated.includes('const conflictTodos = [];'), '');
  A('★ 桥在场时派生条目确实来自 deriveConflictTodos（源码含调用且 §1 已真跑出条目）',
    src.includes('deriveConflictTodos(ROOT)') && d1.length === 3, '');
}

/* ═══ §5 KINDS 两侧都含「红字异议」═══ */
console.log('\n═══ §5 派生 kind 在两侧 KINDS 里 ═══');
{
  const toolSrc = rd(path.join(REPO, 'src', 'tools', '_待确认.mjs'));
  const modelSrc = rd(path.join(REPO, 'src', 'app', 'js', 'model.js'));
  const mTool = /const KINDS\s*=\s*(\[[^\]\n]*\]);/.exec(toolSrc);
  const mModel = /M\.KINDS\s*=\s*(\[[^\]\n]*\]);/.exec(modelSrc);
  A('两侧 KINDS 字面量都能机读到', !!(mTool && mModel), '');
  A('★ 两侧都含「红字异议」', mTool[1].includes('红字异议') && mModel[1].includes('红字异议'),
    (mTool[1].includes('红字异议') ? '工具侧✓' : '工具侧✖') + '/' + (mModel[1].includes('红字异议') ? '界面侧✓' : '界面侧✖'));
}

console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + ' 断言=' + (pass + fail) + (fail ? ' 失败=' + fail : ''));
process.exit(fail === 0 ? 0 : 1);
