#!/usr/bin/env node
/**
 * 交错组卷自检（2026-10-10 建，2026-10-16 改）：
 *   真跑一次 组卷（选 6 张可组卷卡）→ 断言台账 items 顺序满足「相邻不同同族考点」→ 撤批还原。
 * 依据见 _标记复习.mjs 组卷 段落注释（Rohrer 2020 预注册 RCT）。
 * ⚠ 2026-10-16（P20261015-01 事故）：交错从**默认开**改为**显式 --interleave**——
 *   印刷顺序的唯一权威是调用方 ids 顺序（界面洗过牌的卷面必须原样入账，否则卷面/答案册/台账
 *   三序并存，批改对不上题）。本测试改传 --interleave，只验证「显式开启时算法仍然成立」；
 *   「默认不重排」由 neg-paper-order-blank.cjs A 段守护。
 * 该脚本会短暂写 _组卷台账.json 与 _索引.json，结束时必须完全复原（撤批 + 断言）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs）
   ★ 2026-10-23：全程跑**临时库副本**（本用例要真跑 组卷→撤批，原先直接改真库再还原）。
   副本必须带 题干.html（含 mtime），否则盲解指纹判「题干在盲解后改过」，组卷被门禁拦下。 */
const E = require('./_测试环境.cjs');
const LIB = E.makeTempLib(null, { copyCardFiles: true });
const lib = (...p) => path.join(LIB, ...p);
/* 工具从 src\tools\ 取（E.tool），并显式传 CTB_DATA=LIB ——
   否则工具自己算库根会算成 <仓库>\src\，读写都落到程序目录里去。 */
const run = (script, args) => execFileSync(process.execPath, [E.tool(script), ...args],
  { encoding: 'utf8', maxBuffer: 64e6, env: Object.assign({}, process.env, { CTB_DATA: LIB }) });
let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

const SRC_PREFIX_OK = ['独立判卷', '老师定案', '官方答案'];
const SRC_EXACT_OK = ['红笔订正+官方答案页核对'];
const okSrc = it => { const s = String((it && it.answerSource) || '').trim(); return !!s && (SRC_PREFIX_OK.some(p => s.startsWith(p)) || SRC_EXACT_OK.includes(s)); };
const okBlind = it => ['已通过', '已修正'].includes(it.blindStatus || '');

/* 跨全部已发现的索引挑「两道门禁都能过」的卡，并尽量凑出多种同族考点以便观察交错
   ★ 2026-10-24 B-09：索引路径不再写死真实库结构，走 findIndexes 动态发现 */
const idxPaths = E.findIndexes(LIB).map(f => lib(f));
const pool = [];
for (const p of idxPaths) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  /* ⚠ 卡号跨学生会撞号（学生A M0032 与 学生B M0032 并存，教训 L-334/L-339）——
     所以键必须带学生，不能只用 id。 */
  const push = (it, subject) => pool.push({ stu: j.student, key: j.student + '|' + it.id, id: it.id, subject, code: it.causeCode || it.causeLayer || '', kps: Array.isArray(it.kpoints) ? it.kpoints : [], src: it.answerSource || '', ok: okSrc(it) && okBlind(it) });
  if (Array.isArray(j.items)) for (const it of j.items) push(it, j.subject);
  if (j.subjects) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) push(it, sn);
}
/* ★ B-09：学生名动态取——选「数学·独立判卷」可组卷卡最多的学生 */
const byStu = {};
for (const x of pool) if (x.ok && x.subject === '数学' && x.src.startsWith('独立判卷')) (byStu[x.stu] = byStu[x.stu] || []).push(x);
const STU = Object.keys(byStu).sort((a, b) => byStu[b].length - byStu[a].length)[0];
const picks0 = pool.filter(x => x.ok && x.stu === STU && x.subject === '数学' && x.src.startsWith('独立判卷')).slice(0, 8);
/* ⚠ 关键：把输入**按同族考点聚类**（同一 code 的挨在一起），否则输入本来就交错，
   "没报错"根本不能证明重排发生过——那是个假阳性测试。 */
const picks = picks0.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
const codeOf = id => (picks.find(x => x.id === id) || {}).code || '';
const kpointsOf = id => (picks.find(x => x.id === id) || {}).kps || [];
/* ★ 2026-10-25 修（遗留红，交接项「test run.mjs full」）：B-09 重构把变量 cand→picks 改了一半，
   本文件第 68 行起还引用旧名 cand ⇒ full 门禁一进本用例就 ReferenceError 崩掉。
   cand = 聚类后的 ids 列表（组卷 --ids 的入参），下游代码全部不动。 */
const cand = picks.map(x => x.id);
/* ★ 2026-10-24 B-09：同族判据统一为「考点相交且错因码相同」（与下方断言同口径）。
   实测（2026-10-24，两个孩子各 8 卡的两组样本）：算法保证的是**不劣于聚类输入**，
   不保证严格归零（一组 1→1：同族卡过多时按鸽笼无法避免）——所以主断言是 ≤，
   归零只作信息打印。原断言「恒为 0」是被当时那份真题数据调出来的，换一组卡就红。 */
const sameAdjOf = list => {
  let n = 0;
  for (let i = 1; i < list.length; i++) {
    const A2 = kpointsOf(list[i - 1]), B2 = kpointsOf(list[i]);
    if (A2.length && B2.length && A2.some(x => B2.includes(x)) && codeOf(list[i]) === codeOf(list[i - 1])) n++;
  }
  return n;
};
console.log(`候选（${STU}/数学，已过两道门禁；输入故意按同族聚类）：`, cand.map(id => `${id}(${codeOf(id)})`).join(' '));
const inputSame = sameAdjOf(cand);
console.log('输入里「相邻同族（考点相交且同码）」的对数：', inputSame, '（0 则本测试无意义）');

let paper = null;
try {
  if (cand.length < 3) throw new Error('可组卷的数学卡不足 3 张，无法验证交错');
  /* ⚠ 2026-10-31：加 `--no-repeat-days 0`。本用例验的是**交错轴**（相邻考点无交集），
     与防重复组卷无关；而候选卡里 M0006/M0007/M0008 在 P20261025-03 印过，
     7 天窗口内跑必被拦 ⇒ exit 2 ⇒ full 红。已在改动前的 commit 6382ce0 上 A/B 复现过
     同一签名（旧代码同样红），属"用例把日历当隐式前条件"的既有缺陷，不是回归。 */
  const out = run('_标记复习.mjs', ['组卷', '--student', STU, '--subject', '数学', '--ids', cand.join(','), '--interleave', '--title', '交错自检卷', '--note', '交错组卷自检，测毕撤批', '--no-repeat-days', '0']);
  console.log(out.trim().split('\n').slice(0, 4).join('\n'));
  paper = (out.match(/P\d{8}-\d{2}/) || [null])[0];
  A('组卷成功并解析到批次号', !!paper, paper);
  if (!paper) throw new Error('无批次号');

  const led = JSON.parse(fs.readFileSync(lib('_组卷台账.json'), 'utf8'));
  const batch = led.batches.find(b => b.paperId === paper);
  A('批次已入账', !!batch);
  const order = batch.items;
  console.log('台账 items 顺序：', order.join(','));
  A('题数不变（只重排不增删）', order.length === cand.length && new Set(order).size === order.length, `${order.length} vs ${cand.length}`);
  A('输入确实"聚类过"（否证假阳性）', inputSame > 0 || new Set(cand.map(codeOf)).length <= 1, `输入相邻同族 ${inputSame} 处`);
  A('重排确实发生（显式 --interleave 生效）', order.join(',') !== cand.join(','), `输入 ${cand.join(',')}`);
  const outSame = sameAdjOf(order);
  const codes = [...new Set(cand.map(codeOf))];
  if (outSame === 0) console.log('（本组样本交错后相邻同族归零）');
  else console.log(`（本组样本交错后仍有 ${outSame} 对同族相邻——候选卡同族考点 ${codes.length} 种，鸽笼限制下算法保证不劣化即可）`);
  A('★ 交错不劣于聚类输入（相邻同族对不增多）', outSame <= inputSame, `输出 ${outSame} ≤ 输入 ${inputSame}`);
} finally {
  if (paper) {
    const back = run('_标记复习.mjs', ['撤批', '--paper', paper]);
    console.log(back.trim().split('\n')[0]);
    const led2 = JSON.parse(fs.readFileSync(lib('_组卷台账.json'), 'utf8'));
    A('撤批后批次已清除', !led2.batches.some(b => b.paperId === paper));
    /* ★ B-09：检查所有已发现的索引（原先只查写死的那一个） */
    const dirty = [];
    for (const f of E.findIndexes(LIB)) {
      const idx2 = JSON.parse(fs.readFileSync(lib(f), 'utf8'));
      for (const v of Object.values(idx2.subjects || {})) for (const it of (v.items || [])) if ((it.reviews || []).some(r => r.paper === paper)) dirty.push(it.id);
      if (Array.isArray(idx2.items)) for (const it of idx2.items) if ((it.reviews || []).some(r => r.paper === paper)) dirty.push(it.id);
    }
    A('撤批后索引无该批次复习流水', dirty.length === 0, dirty.join(','));
  }
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
process.exit(fails ? 1 : 0);
