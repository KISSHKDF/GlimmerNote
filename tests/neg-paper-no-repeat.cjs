#!/usr/bin/env node
/**
 * 阴性对照：防重复组卷（2026-10-24 用户报障）
 *
 * 用户原话：「我给学生A出了两次试卷，发现第一次试卷与第二次试卷题目是一样的。系统没有主动让我避开
 *   已经出过并做过的错题。」——实测 P20261021-01 与 P20261024-01 两批 **交集 30/30**。
 *
 * 为什么这不是"多练一遍"：同一套题隔 3 天重印，孩子是照答案默写，第 2 次的「对」不反映掌握，
 *   会直接污染 passStreak / nextDue / 已掌握判定（错题本的全部下游推断）。
 *
 * 两条防线，本文件各守一条：
 *   ① **工具侧硬门禁**（唯一入口，任何界面/命令行都逃不掉）：_标记复习.mjs 组卷 默认 --no-repeat-days 7
 *      ⇒ 近 7 天印过的题直接 exit 2；--force 才放行（且打警告）；--no-repeat-days 0 可关闭。
 *   ② **界面侧自愈**：入账成功后必须把本卷题从「选题篮」里摘掉（原来不清空 ⇒ 篮子持久化在
 *      localStorage，下次进配卷屏还是那批题，一点预览+入账就再印一遍，这是重复印卷的第二层根因）。
 *
 * 手法：真跑工具（不是读正则猜行为），跑在 makeTempLib 的**副本**上，真库一个字节不碰。
 * 每条判据都"改前必红"：把门禁删掉/把抓篮子的判断去掉，对应断言立刻为假（见 ⑦ 变异自证）。
 */
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};

/* 只读真库取素材（绝不写）：拿一个真实批次的题号与日期 */
const realLedger = JSON.parse(fs.readFileSync(path.join(E.LIB, '_组卷台账.json'), 'utf8'));
const batches = realLedger.batches || [];
const seed = batches.slice().sort((a, b) => (b.items || []).length - (a.items || []).length)[0];
if (!seed) { console.log('✖ 真台账里没有批次，无法取素材'); process.exit(1); }
/* 工具侧默认窗口（days）；改工具默认值必须同步改这里（断言会红，正是我们要的） */
const REPEAT_WINDOW_DAYS = 7;
const TOOL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_标记复习.mjs'), 'utf8');
if (!new RegExp("num\\(opt\\['no-repeat-days'\\]\\) \\|\\| " + REPEAT_WINDOW_DAYS).test(TOOL_SRC)) {
  console.log('✖ 工具侧默认防重复窗口改了（不是 ' + REPEAT_WINDOW_DAYS + ' 天）⇒ 本测试的判据要同步改，先看 _标记复习.mjs');
  process.exit(1);
}

/* 副本库：必须带卡片文件（题干.html/错题记录.md），否则"盲解指纹新鲜度"门禁会先一步拦住，
   就测不到防重复门禁了 —— 这是踩过的坑。 */
const tmp = E.makeTempLib(null, { copyCardFiles: true });
const run = (args) => E.runToolSync('_标记复习.mjs', args, { data: tmp });
const ledgerAt = () => JSON.parse(fs.readFileSync(path.join(tmp, '_组卷台账.json'), 'utf8'));

console.log('═══ ① 前置：副本库本身能组卷（否则后面"被拦"可能只是别的门禁在拦）═══');
{
  /* ⚠ 必须显式关掉本门禁来验证"这条路本来是通的"：副本库抄的是真台账，
     真台账里这批题**就是**最近印过的 ⇒ 默认参数下必然被本门禁拦，那就证不出"别处没问题"。 */
  const r0 = run(['组卷', '--student', seed.student, '--subject', seed.subject, '--ids', seed.items.join(','), '--date', seed.date, '--no-repeat-days', '0']);
  A('前置：同一批题在**本门禁关闭**时能入账（判据不是恒假）',
    r0.code === 0, 'exit=' + r0.code + ' ' + String(r0.err || '').slice(0, 160));
  A('前置：确实建出了新批次（盲解/答案来源/指纹三道老门禁都放行，说明拦我们的只有新门禁）',
    /已入账 P\d{8}-\d{2}/.test(r0.out || ''), String(r0.out || '').split('\n')[0].slice(0, 60));
}

console.log('\n═══ ② 工具侧硬门禁：近 7 天印过的题必须 exit 2 ═══');
{
  const before = ledgerAt().batches.length;
  const r = run(['组卷', '--student', seed.student, '--subject', seed.subject, '--ids', seed.items.join(','), '--date', seed.date]);
  A('★ 同一批题当天再组 → 被拦（exit 2）', r.code === 2, 'exit=' + r.code);
  A('★ 拦截理由说得清（「防重复组卷拦截」+ 题数/天数）',
    /防重复组卷拦截/.test(r.err || '') && /最近 7 天/.test(r.err || ''),
    String(r.err || '').split('\n')[0].slice(0, 110));
  A('★ 拦截时指名道姓列出题号与当初的批次（否则用户不知道该等哪几题）',
    seed.items.slice(0, 3).every(id => (r.err || '').includes(id)) && /P\d{8}-\d{2}/.test(r.err || ''));
  A('★ 被拦时**没有**写台账（不能"拦了但已经落了一半"）', ledgerAt().batches.length === before,
    before + ' → ' + ledgerAt().batches.length);
  A('拦截信息给了可执行出路（等复习日到期 / 换题 / 走「看这张卷」重印）',
    /看这张卷/.test(r.err || '') && /到期/.test(r.err || ''));
}

console.log('\n═══ ③ --force 显式绕过：放行但必须留告警 ═══');
{
  const r = run(['组卷', '--student', seed.student, '--subject', seed.subject, '--ids', seed.items.join(','), '--date', seed.date, '--force']);
  A('--force 时放行（交给用户拍板，不搞一刀切）', r.code === 0, 'exit=' + r.code);
  A('★ 放行时打印「--force 绕过防重复组卷门禁」告警（不留痕就等于没有门禁）',
    /--force 绕过防重复组卷门禁/.test(r.out || ''), String(r.out || '').split('\n')[0].slice(0, 80));
}

console.log('\n═══ ④ --no-repeat-days 0：门禁可关（老用户/特殊场景的退路）═══');
{
  const r = run(['组卷', '--student', seed.student, '--subject', seed.subject, '--ids', seed.items.join(','), '--date', seed.date, '--no-repeat-days', '0']);
  A('关掉门禁后能入账', r.code === 0, 'exit=' + r.code);
  A('关掉时不再打绕过告警（没开就没绕）', !/绕过防重复组卷门禁/.test(r.out || ''));
}

console.log('\n═══ ⑤ 时间窗语义：不是"印过就永远不许印"，而是 N 天冷却 ═══');
{
  /* 换个**更晚的组卷日**（+30 天）再组同一批题：窗口 since = 组卷日−7 会越过所有旧批次日期 ⇒ 应放行。
     ⚠ 不能靠"把台账批次日期往前推"来构造：批次号是按日期生成的，改了日期会撞号（工具硬断言 '批次号撞号'），
       第一次写这个测试就这么栽的（exit 1）。 */
  const later = (() => { const x = new Date(seed.date + 'T00:00:00'); x.setDate(x.getDate() + 30); return x.toISOString().slice(0, 10); })();
  const r = run(['组卷', '--student', seed.student, '--subject', seed.subject, '--ids', seed.items.join(','), '--date', later]);
  A('★ 冷却期过了（组卷日晚于全部旧批次 ' + REPEAT_WINDOW_DAYS + ' 天以上）→ 同一批题重新可组（判据不是「永远禁止」）',
    r.code === 0, 'exit=' + r.code + ' ' + String(r.err || '').split('\n')[0].slice(0, 100));
}

console.log('\n═══ ⑥ 界面侧自愈：入账后必须把题从选题篮摘掉（重复印卷的第二层根因）═══');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
  A('★ 入账成功分支里有「从篮子摘掉本卷题」的实现',
    /doneKeys/.test(src) && /M\.basket\(\)\.filter\(k => !doneKeys\.has\(k\)\)/.test(src) && /M\.basketSet\(left\)/.test(src));
  A('★ 摘除用的是 kid|id 复合键（不是裸 id——跨孩子会串题，教训 L-339/BUG-11）',
    /x\.kid \+ '\|' \+ x\.card\.id/.test(src));
  A('配卷屏有"近 7 天印过"的可视提示 + 一键剔除', /paintRepeat/.test(src) && /ppDropRep/.test(src));
  A('界面判据与工具侧同口径（都是 7 天、都跳过已作废批次）',
    /const REPEAT_DAYS = 7/.test(src) && /b\.status === '已作废'/.test(src));
  A('入账前把重复题摆到眼前（confirm 告知，不是静默放行）', /防重复|最近 ' \+ REPEAT_DAYS \+ ' 天已经印过卷/.test(src));
  /* 阴性自证：把"摘篮子"的实现删掉，判据必须为假（证明这条断言真能抓住"没清篮子"）。
     ⚠ 必须把**三行一起**删（doneKeys / left / basketSet）：只删第一行会留下 doneKeys.has 的引用，
       判据里 `/doneKeys/` 仍命中 ⇒ 自证恒真，就测不出东西（第一次写这个测试就栽在这儿）。 */
  const mut = src
    .replace(/const doneKeys = new Set\(sheet\.refs\.map\(x => x\.kid \+ '\|' \+ x\.card\.id\)\);\s*/, '')
    .replace(/const left = M\.basket\(\)\.filter\(k => !doneKeys\.has\(k\)\);\s*/, '')
    .replace(/if \(left\.length !== M\.basket\(\)\.length\) M\.basketSet\(left\);\s*/, '');
  const predSelfHeal = s => /doneKeys/.test(s) && /M\.basketSet\(left\)/.test(s);
  A('前置（样本）：现版源码满足判据（判据不是恒假）', predSelfHeal(src));
  A('自证 · 删掉"摘篮子"三行后判据立刻为假', mut !== src && !predSelfHeal(mut),
    '残留=' + (mut.match(/doneKeys|basketSet\(left\)/g) || []).length);
}

console.log('\n═══ ⑦ 变异自证：门禁逻辑本身被掏空时，②的判据必须变红 ═══');
{
  /* 直接对工具源码做变异：把 REPEAT_DAYS 改成 0（等于常关门禁），再用同一批题跑一次副本，
     断言"应当不再被拦" —— 这证明 ② 的拦截确实来自这道门禁，而不是别的门禁顺手拦下的。 */
  const toolPath = path.join(ROOT, 'src', 'tools', '_标记复习.mjs');
  const orig = fs.readFileSync(toolPath, 'utf8');
  const mutSrc = orig.replace(
    "const REPEAT_DAYS = (String(opt['no-repeat-days']) === '0') ? 0 : (num(opt['no-repeat-days']) || 7);",
    "const REPEAT_DAYS = 0;");
  A('前置：变异点存在且唯一（改得到才谈得上自证）', mutSrc !== orig && !/num\(opt\['no-repeat-days'\]\) \|\| 7/.test(mutSrc));

  const tmp2 = E.makeTempLib(null, { copyCardFiles: true });
  fs.copyFileSync(path.join(tmp, '_组卷台账.json'), path.join(tmp2, '_组卷台账.json'));
  /* 先把该生批次重置成"当天印过"的状态（⑤ 把它推到 8 天前了） */
  const led2 = JSON.parse(fs.readFileSync(path.join(tmp2, '_组卷台账.json'), 'utf8'));
  led2.batches = led2.batches.map(b => Object.assign({}, b, { date: seed.date }));
  fs.writeFileSync(path.join(tmp2, '_组卷台账.json'), JSON.stringify(led2, null, 2), 'utf8');

  /* 临时把变异源码落盘 → 跑 → 立刻还原（失败也要还原，见 finally） */
  const bak = path.join(ROOT, 'src', 'tools', '_标记复习.mjs.mutbak');
  try {
    fs.writeFileSync(bak, orig, 'utf8');
    fs.writeFileSync(toolPath, mutSrc, 'utf8');
    const r = E.runToolSync('_标记复习.mjs',
      ['组卷', '--student', seed.student, '--subject', seed.subject, '--ids', seed.items.join(','), '--date', seed.date],
      { data: tmp2 });
    A('★ 自证 · 门禁被掏空（REPEAT_DAYS=0）后同一批题**不再被拦** ⇒ ②的拦截确由本门禁产生',
      r.code !== 2 || !/防重复组卷拦截/.test(r.err || ''),
      'exit=' + r.code + ' ' + String(r.err || '').split('\n')[0].slice(0, 80));
  } finally {
    try { fs.writeFileSync(toolPath, orig, 'utf8'); } catch { }
    try { fs.unlinkSync(bak); } catch { }
    try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
  A('变异源码已还原（不留半截改造）', fs.readFileSync(toolPath, 'utf8') === orig);
}

console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + '  断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail === 0 ? 0 : 1);
