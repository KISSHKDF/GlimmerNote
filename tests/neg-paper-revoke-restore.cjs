#!/usr/bin/env node
/**
 * 阴性对照：撤销试卷（2026-10-24 用户要求）
 *
 * 用户原话：「应该设置一个用户任何时候、任何阶段都可以撤销某张试卷的权限，
 *   当撤销了某张试卷，该试卷上的题目应该恢复成未组卷状态」。
 *
 * 界面入口（台账「↩ 撤销试卷」→ H.mark('撤批')）的护栏在 neg-paper-count-and-ledger-filter.mjs ⑨。
 * 本文件守**工具侧**两件事（真跑 _标记复习.mjs，跑在 makeTempLib 副本上，真库一个字节不碰）：
 *   ① 撤批＝**整卷退回**：批次行移除 + 该卷判分记录全部回滚，复习态逐字段回到组卷前
 *      ——「恢复未组卷」不是一句文案，是可验证的文件状态（未批改/已批改两种阶段都验）；
 *   ② 撤批删行后批次号**不复用**：ledger.paperSeq 水印记住"当天用到几号"（行删了号不还），
 *      被撤的号绝不能再被新卷领走。BUG-06 当年靠"取最大号+1"挡住低号被删的情形，
 *      但撤销成为正式功能后，被删的恰恰常是**当天最大号**——只有水印能保证只增不复用。
 *      ②的必要性用"掏掉水印的变异源码"自证（改前必红，见 ④）。
 */
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const paperIdOf = s => { const m = /P\d{8}-\d{2}/.exec(String(s || '')); return m ? m[0] : ''; };
const noOf = pid => { const m = /-(\d{2})$/.exec(String(pid || '')); return m ? Number(m[1]) : 0; };

const TOOL = path.join(__dirname, '..', 'src', 'tools', '_标记复习.mjs');
const TOOL_SRC = fs.readFileSync(TOOL, 'utf8');

/* ---------- 素材（只读真库，绝不写） ---------- */
const realLedger = JSON.parse(fs.readFileSync(path.join(E.LIB, '_组卷台账.json'), 'utf8'));
const seed = (realLedger.batches || []).slice().sort((a, b) => (b.items || []).length - (a.items || []).length)[0];
if (!seed) { console.log('✖ 真台账里没有批次，无法取素材'); process.exit(1); }

/* 组卷/批改统一用远期日期：与真台账既有批次隔开（编号从 01 起算、防重复窗口自动越过旧批次） */
const F = '2099-01-01';
const SEQ = 'P' + F.replace(/-/g, '');
const wmOf = t => { const led = ledgerAt(t); return num((led.paperSeq || {})[SEQ]); };

/* ---------- 副本库工具 ---------- */
const tmps = [];
const mkTmp = () => { const t = E.makeTempLib(null, { copyCardFiles: true }); tmps.push(t); return t; };
const run = (t, args) => E.runToolSync('_标记复习.mjs', args, { data: t });
const ledgerAt = t => JSON.parse(fs.readFileSync(path.join(t, '_组卷台账.json'), 'utf8'));
function idxAbsOf(t, student) {
  for (const rel of E.findIndexes(t)) {
    const p = path.join(t, rel);
    try { if (JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')).student === student) return p; } catch { }
  }
  return null;
}
function itemsOf(j) {
  const out = [];
  if (Array.isArray(j.items)) for (const it of j.items) out.push(it);
  if (j.subjects) for (const v of Object.values(j.subjects)) for (const it of (v.items || [])) out.push(it);
  return out;
}
const idxAt = t => JSON.parse(fs.readFileSync(idxAbsOf(t, CUR.student), 'utf8').replace(/^\uFEFF/, ''));
const cardAt = (idx, id) => itemsOf(idx).find(x => x.id === id) || null;

/* 组卷前后必须逐字段相等的复习态（=new reviews/errorCount + 三个由 reviews 派生的字段 + nextDue） */
const DERIVED = ['reviews', 'errorCount', 'nextDue', 'reviewStatus', 'passStreak', 'lastReviewedAt', 'masteredAt'];
const snapCard = (idx, id) => { const it = cardAt(idx, id); if (!it) return null; const o = {}; for (const f of DERIVED) o[f] = it[f] === undefined ? null : it[f]; return o; };
const snapEq = (a, b) => !!a && !!b && DERIVED.every(f => JSON.stringify(a[f]) === JSON.stringify(b[f]));
const snapDiff = (a, b) => DERIVED.filter(f => JSON.stringify((a || {})[f]) !== JSON.stringify((b || {})[f])).join(',');
const eqj = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* 当前用哪个孩子（严格回滚断言需要 ≥3 张「非已掌握」的卡，运行时挑，不写死卡号）。
   全程跑在 makeTempLib 副本上，与真实待批改批次无关；「恢复未组卷」的逐字段等式
   在卡挂不挂在别的待批改批次里都成立（pendingMap 组卷前=组卷后=撤批后）。 */
let CUR = null;
function pickStudent(root) {
  const counts = {};
  for (const rel of E.findIndexes(root)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, ''));
      for (const it of itemsOf(j)) {
        if (!it || !it.id) continue;
        if ((seed.items || []).includes(it.id) &&
          it.reviewStatus !== '已掌握' && num(it.errorCount) >= 1) {
          counts[j.student] = (counts[j.student] || 0) + 1;
        }
      }
    } catch { }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? { student: best[0], n: best[1] } : null;
}
const idsOfStudent = (t, student, n) => {
  const j = JSON.parse(fs.readFileSync(idxAbsOf(t, student), 'utf8').replace(/^\uFEFF/, ''));
  return itemsOf(j).filter(it => (seed.items || []).includes(it.id) &&
    it.reviewStatus !== '已掌握' && num(it.errorCount) >= 1).slice(0, n).map(it => it.id);
};

let IDS = null, ID_PRE = null, tmp1 = null;

console.log('═══ ① 前置：素材与环境 ═══');
{
  tmp1 = mkTmp();
  CUR = pickStudent(tmp1);
  A('前置：找到"有 ≥3 张可试验卡"的孩子（非已掌握、errorCount≥1，全程跑在副本上与真实在途批次无关）',
    !!CUR && CUR.n >= 3, CUR ? CUR.student + '：' + CUR.n + ' 张候选' : '无候选');
  if (!CUR || CUR.n < 3) { console.log('✖ 素材不足，后续断言无意义'); process.exit(1); }
  IDS = idsOfStudent(tmp1, CUR.student, 3);
  A('前置：实验卡运行时选定（不写死卡号）', IDS.length === 3, IDS.join(','));
}

console.log('\n═══ ② 撤批 = 整卷退回（已批改的卷撤销 → 判分流水/错误次数回滚，逐字段回组卷前）═══');
let P1 = '';
{
  ID_PRE = {}; { const idx = idxAt(tmp1); for (const id of IDS) ID_PRE[id] = snapCard(idx, id); }

  const r1 = run(tmp1, ['组卷', '--student', CUR.student, '--subject', seed.subject, '--ids', IDS.join(','), '--date', F]);
  P1 = paperIdOf(r1.out);
  A('远期空日期组卷成功，当天首批拿 -01', r1.code === 0 && P1 === SEQ + '-01',
    'exit=' + r1.code + ' ' + P1 + ' ' + String(r1.err || '').split('\n')[0].slice(0, 90));
  A('台账新批次的 items 与传入 ids 逐题同序（印刷顺序不变量）',
    eqj((ledgerAt(tmp1).batches.find(b => b.paperId === P1) || {}).items, IDS));
  A('组卷生效（前置锚点）：3 题进入「复习中·待批改」',
    (() => { const idx = idxAt(tmp1); return IDS.every(id => (snapCard(idx, id) || {}).reviewStatus === '复习中·待批改'); })());

  const r2 = run(tmp1, ['批改', '--paper', P1, '--results', IDS[0] + '=错,' + IDS[1] + '=对,' + IDS[2] + '=半对', '--date', F]);
  const mid2 = idxAt(tmp1);
  A('批改生效（前置锚点）：3 题都有 paper=' + P1 + ' 的流水、错题 errorCount+1',
    r2.code === 0 &&
    IDS.every(id => ((snapCard(mid2, id) || {}).reviews || []).some(rv => rv.paper === P1)) &&
    num((snapCard(mid2, IDS[0]) || {}).errorCount) === num((ID_PRE[IDS[0]] || {}).errorCount) + 1,
    'exit=' + r2.code + ' ' + String((r2.out || '') + (r2.err || '')).split('\n')[0].slice(0, 80));

  const r3 = run(tmp1, ['撤批', '--paper', P1]);
  const post = idxAt(tmp1), led = ledgerAt(tmp1);
  A('撤批成功且输出说清「恢复为未组卷」', r3.code === 0 && /恢复为\*{0,2}未组卷/.test(r3.out || ''),
    'exit=' + r3.code + ' ' + String((r3.out || '') + (r3.err || '')).split('\n')[0].slice(0, 90));
  A('★ 批次行已从台账移除', !led.batches.some(b => b.paperId === P1),
    '该日期剩 ' + led.batches.filter(b => b.date === F).length + ' 个批次');
  A('★ 3 题逐字段回到组卷前（reviews/errorCount/nextDue/reviewStatus/passStreak/lastReviewedAt/masteredAt）',
    IDS.every(id => snapEq(ID_PRE[id], snapCard(post, id))),
    IDS.map(id => id + (snapEq(ID_PRE[id], snapCard(post, id)) ? '✓' : '（Δ:' + snapDiff(ID_PRE[id], snapCard(post, id)) + '）')).join(' '));
  A('流水里不含被撤批次的任何记录',
    IDS.every(id => !((((snapCard(post, id) || {}).reviews) || []).some(rv => rv.paper === P1))));
  A('★ 完整流水逐条等于组卷前（不是"差不多"，是逐条相等）',
    IDS.every(id => eqj((snapCard(post, id) || {}).reviews, (ID_PRE[id] || {}).reviews)));
  A('★ 水印记住号：行删了、paperSeq.' + SEQ + ' 仍为 1（号不还给后来者）', wmOf(tmp1) === 1,
    'paperSeq=' + JSON.stringify(led.paperSeq || {}));
}

console.log('\n═══ ③ 未批改的卷撤销 → 直接回池；被撤的号不被复用 ═══');
{
  const r4 = run(tmp1, ['组卷', '--student', CUR.student, '--subject', seed.subject, '--ids', IDS.join(','), '--date', F]);
  const P2 = paperIdOf(r4.out);
  A('★ 撤掉的 -01 不被复用：新卷直接拿 -02（旧行数逻辑会再拿 -01）', r4.code === 0 && noOf(P2) === 2,
    'exit=' + r4.code + ' 新批次=' + P2);
  A('未批改卷组卷后 3 题 → 复习中·待批改',
    (() => { const idx = idxAt(tmp1); return IDS.every(id => (snapCard(idx, id) || {}).reviewStatus === '复习中·待批改'); })());

  const r5 = run(tmp1, ['撤批', '--paper', P2]);
  const post = idxAt(tmp1), led = ledgerAt(tmp1);
  A('★ 未批改卷撤批：3 题回到组卷前（回池，无残留流水）',
    r5.code === 0 && IDS.every(id => snapEq(ID_PRE[id], snapCard(post, id))),
    IDS.map(id => id + (snapEq(ID_PRE[id], snapCard(post, id)) ? '✓' : '（Δ:' + snapDiff(ID_PRE[id], snapCard(post, id)) + '）')).join(' '));
  A('撤批不回退水印：paperSeq.' + SEQ + ' 仍为 2', wmOf(tmp1) === 2, 'paperSeq=' + JSON.stringify(led.paperSeq || {}));
}

console.log('\n═══ ④ 撤掉「当天最大号」再组新卷 → 拿更大的号（水印正路） ═══');
{
  const t2 = mkTmp();
  const idsA = idsOfStudent(t2, CUR.student, 3);
  const idsB = (seed.items || []).filter(id => !idsA.includes(id)).slice(0, 3);
  const rA = run(t2, ['组卷', '--student', CUR.student, '--subject', seed.subject, '--ids', idsA.join(','), '--date', F]);
  const rB = run(t2, ['组卷', '--student', CUR.student, '--subject', seed.subject, '--ids', idsB.join(','), '--date', F]);
  const P_A = paperIdOf(rA.out), P_B = paperIdOf(rB.out);
  const rC = run(t2, ['撤批', '--paper', P_B]);                        // 撤的正是当天最大号
  const rD = run(t2, ['组卷', '--student', CUR.student, '--subject', seed.subject, '--ids', idsB.join(','), '--date', F]);
  const P_D = paperIdOf(rD.out);
  A('前置：同日两批 -01/-02', noOf(P_A) === 1 && noOf(P_B) === 2, P_A + ' ' + P_B);
  A('★ 撤掉最大号 -02 后，新卷拿 -03 而不是复用 -02',
    rC.code === 0 && rD.code === 0 && noOf(P_D) === 3, '新批次=' + P_D);
}

console.log('\n═══ ⑤ 变异自证：掏掉水印后，被撤的号会被复用（证明 ③④ 确由水印拦住） ═══');
{
  /* 变异：把"取号"改回 BUG-06 时代的做法（只看现存行），并把"记水印"那行删掉。
     两个变异必须一起上：只删记水印不换取号公式的话，读旧水印仍会挡住复用（自证不红）。 */
  const MUT_READ = "const nextNo = Math.max(used.length ? Math.max(...used) : 0, num(ledger.paperSeq[seqKey])) + 1;";
  const MUT_WRITE = "    ledger.paperSeq[seqKey] = Math.max(num(ledger.paperSeq[seqKey]), nextNo);   // 撤批不回退：只增不复用\n";
  const mutSrc = TOOL_SRC.replace(MUT_READ, "const nextNo = (used.length ? Math.max(...used) : 0) + 1;").replace(MUT_WRITE, '');
  A('前置：两处变异点都命中', mutSrc !== TOOL_SRC &&
    !mutSrc.includes('num(ledger.paperSeq[seqKey])'), '源码 ' + TOOL_SRC.length + ' → ' + mutSrc.length + ' 字节');

  const t3 = mkTmp();
  const idsA = idsOfStudent(t3, CUR.student, 3);
  const idsB = (seed.items || []).filter(id => !idsA.includes(id)).slice(0, 3);
  const bak = TOOL + '.mutbak';
  try {
    fs.writeFileSync(bak, TOOL_SRC, 'utf8');
    fs.writeFileSync(TOOL, mutSrc, 'utf8');
    run(t3, ['组卷', '--student', CUR.student, '--subject', seed.subject, '--ids', idsA.join(','), '--date', F]);   // -01
    const rB = run(t3, ['组卷', '--student', CUR.student, '--subject', seed.subject, '--ids', idsB.join(','), '--date', F]);  // -02
    const P_Bm = paperIdOf(rB.out);
    run(t3, ['撤批', '--paper', P_Bm]);                                 // 撤掉当天最大号（同上 ④ 的操作序列）
    const rD = run(t3, ['组卷', '--student', CUR.student, '--subject', seed.subject, '--ids', idsB.join(','), '--date', F]);
    const P_Dm = paperIdOf(rD.out);
    A('★ 自证 · 掏掉水印后：撤掉 -02 再组卷**复用 -02**（正是 BUG-06 式重号的水路复现）',
      noOf(P_Bm) === 2 && noOf(P_Dm) === 2, '撤前=' + P_Bm + ' 撤后新卷=' + P_Dm);
  } finally {
    try { fs.writeFileSync(TOOL, TOOL_SRC, 'utf8'); } catch { }
    try { fs.unlinkSync(bak); } catch { }
  }
  A('变异源码已还原（不留半截改造）', fs.readFileSync(TOOL, 'utf8') === TOOL_SRC);
}

/* ---------- 收尾：临时副本全删 ---------- */
for (const t of tmps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch { } }
console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + '  断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail === 0 ? 0 : 1);
