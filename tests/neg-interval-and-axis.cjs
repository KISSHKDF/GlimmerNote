#!/usr/bin/env node
/**
 * 2026-10-11 两处修复的阴性对照：
 *  ① intervalOf 方向：错(1) < 半对(3) < 对(7)，且连对越多越久 —— 修前是"对(1) < 半对(3)"（反的）
 *  ② 交错轴：相邻两题**考点无交集**才算成立 —— 修前按错因码交错，实测大批相邻题仍共享考点
 *
 * ★ 2026-10-23：全程跑在**临时库副本**上（makeTempLib + copyCardFiles）。
 *   本用例要真跑 组卷→批改→撤批，原先是直接改真库再撤批还原；现在连真库的一行都不碰。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
/* 副本要带 题干.html（含 mtime）——否则盲解指纹判「题干在盲解后改过」，组卷会被门禁拦下 */
const LIB = E.makeTempLib(null, { copyCardFiles: true });
const lib = (...p) => path.join(LIB, ...p);
let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };
/* ★ 2026-10-23：显式传 CTB_DATA —— 工具住在 <仓库>\src\tools\，它自己算库根会算成 src\，
   只有靠环境变量才能跟本测试看同一份库（与 run.mjs / gates-contract 同法）。 */
const run = (a) => execFileSync(process.execPath, [E.tool('_标记复习.mjs'), ...a],
  { encoding: 'utf8', maxBuffer: 64e6, env: Object.assign({}, process.env, { CTB_DATA: LIB }) });

/* ---------- ① 间隔方向 ---------- */
const src = fs.readFileSync(E.tool('_标记复习.mjs'), 'utf8');
const m = src.match(/function intervalOf\(res, pass\) \{[\s\S]*?\n\}/);
A('intervalOf 已含新实现（LADDER_OK）', !!m && /LADDER_OK/.test(m[0]));
/* 直接跑工具的自检口径：用一条真组卷→批改，看 nextDue 差
   ★ 2026-10-24 B-09：索引路径与学生名动态发现（原写死真实库的 九年级\ 与真实学生名） */
const idxFiles = E.findIndexes(LIB);
const mathIdx = idxFiles.map(f => ({ f, j: JSON.parse(fs.readFileSync(lib(f), 'utf8')) }))
  .find(x => x.j.subjects && x.j.subjects['数学'] && (x.j.subjects['数学'].items || []).length >= 2);
if (!mathIdx) throw new Error('临时库里找不到含 ≥2 张数学卡的索引（findIndexes=' + idxFiles.join(', ') + '）');
const STU = mathIdx.j.student;
const idx = mathIdx.j;
const pool = [];
for (const [sn, v] of Object.entries(idx.subjects)) for (const it of (v.items || [])) pool.push({ sn, id: it.id, src: it.answerSource || '', blind: it.blindStatus });
const okCards = pool.filter(x => ['已通过', '已修正'].includes(x.blind) && /^独立判卷|^老师定案|^官方答案/.test(x.src) && x.sn === '数学').slice(0, 2);
A('找到用于对照的可组卷卡', okCards.length === 2, okCards.map(x => x.id).join(','));
let paper = null;
try {
  const out = run(['组卷', '--student', STU, '--subject', '数学', '--ids', okCards.map(x => x.id).join(','), '--title', '间隔方向对照', '--note', '自检']);
  paper = (out.match(/P\d{8}-\d{2}/) || [null])[0];
  A('组卷成功', !!paper, paper);
  /* 一张判「对」，一张判「半对」，比较 nextDue 距离 */
  const date = '2026-10-11';
  run(['批改', '--paper', paper, '--results', `${okCards[0].id}=对,${okCards[1].id}=半对`, '--date', date]);
  const idx2 = JSON.parse(fs.readFileSync(lib(mathIdx.f), 'utf8'));
  const find = id => { for (const v of Object.values(idx2.subjects)) for (const it of (v.items || [])) if (it.id === id) return it; };
  const a = find(okCards[0].id), b = find(okCards[1].id);
  const days = s => Math.round((new Date(s + 'T00:00:00') - new Date(date + 'T00:00:00')) / 86400000);
  console.log(`   ${a.id} 判「对」 → nextDue ${a.nextDue}（+${days(a.nextDue)} 天）`);
  console.log(`   ${b.id} 判「半对」 → nextDue ${b.nextDue}（+${days(b.nextDue)} 天）`);
  A('★ 对的天数 ≥ 半对的天数（方向已修正；修前是 1 < 3）', days(a.nextDue) >= days(b.nextDue), `${days(a.nextDue)} vs ${days(b.nextDue)}`);
} finally {
  if (paper) { run(['撤批', '--paper', paper]); console.log('   已撤批', paper); }
}

/* ---------- ② 交错轴 ---------- */
console.log('\n--- 交错轴：复刻新算法跑全库，统计"相邻考点无交集"达成率 ---');
const cards = [];
for (const f of E.findIndexes(LIB)) {   /* ★ B-09：索引与学生名动态发现 */
  const j = JSON.parse(fs.readFileSync(lib(f), 'utf8'));
  const push = (it, s) => cards.push({ k: j.student + '|' + it.id, s, kp: it.kpoints || [], code: it.causeCode || it.causeLayer || '' });
  if (Array.isArray(j.items)) for (const it of j.items) push(it, j.subject);
  if (j.subjects) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) push(it, sn);
}
const sh = (a, b) => a.length && b.length && a.some(x => b.includes(x));
function run3(list, axis) {           // axis: 'kp' | 'code'
  const rest = list.slice(), out = [rest.shift()];
  while (rest.length) {
    const prev = out[out.length - 1];
    let i;
    if (axis === 'kp') {
      i = rest.findIndex(x => !sh(prev.kp, x.kp));
      if (i < 0) i = rest.findIndex(x => x.code !== prev.code);
    } else i = rest.findIndex(x => x.code !== prev.code);
    if (i < 0) i = 0;
    out.push(rest.splice(i, 1)[0]);
  }
  return out;
}
  /* ★ 2026-10-24 B-09：学生×学科组合动态取（原写死真实学生与其学科），只统计卡数 ≥4 的组合。
     断言从「严格 <」放宽为「≤」：新轴的契约是**不劣于**旧轴（原「<」是挑过的三组真题数据，
     换任意组合会出现平局，如某学科全部同考点——平局不是回归，变差才是）。 */
  const pairs = [...new Set(cards.map(c => c.k.split('|')[0] + '·' + c.s))].map(p => p.split('·'));
  for (const [stu, sj] of pairs) {
  const g = cards.filter(c => c.k.startsWith(stu + '|') && c.s === sj);
  if (g.length < 4) continue;
  const st = { sameCause: 0, shareKp: 0 };
  const newO = run3(g, 'kp'), oldO = run3(g, 'code');
  for (const [name, o] of [['旧(错因码轴)', oldO], ['新(考点轴)', newO]]) {
    let sk = 0;
    for (let i = 1; i < o.length; i++) if (sh(o[i - 1].kp, o[i].kp)) sk++;
    console.log(`   ${stu}/${sj} ${name}: 相邻考点有交集 ${sk}/${o.length - 1}`);
    if (name.startsWith('新')) st.shareKp = sk;
    else st.sameCause = sk;
  }
  A(`${stu}/${sj} 新轴不劣于旧轴（相邻考点交集不增多）`, st.shareKp <= st.sameCause, `${st.shareKp} ≤ ${st.sameCause}`);
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
process.exit(fails ? 1 : 0);
