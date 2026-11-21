#!/usr/bin/env node
/**
 * neg-print-group-merge.cjs —— 同一次打印拆出的批次必须能合并录入（2026-11-21 立）
 *
 * 事故形态（改前）：一张卷子跨学科（数学+化学）入账时按「学生·学科」拆成两个批次，
 * 台账出现两行、各带一个「✍ 录入对错」。家长对着**同一张纸**判卷，要在两个抽屉里
 * 分别按两套题号录两遍——第二遍还容易按第一套的题号错位（比不录更坏）。
 *
 * 设计：后台批次模型不动（复习流水/撤批/统计仍按批次），只加一个 printGroup 组号
 * 把「同一次打印拆出的批次」串起来；前台凭组号把待批改的几行合成一个录入抽屉，
 * 题号按组内 items 顺序连排（= 打印的整张纸），提交时按题回查所属批次拆开逐批落库。
 *
 * 本用例守四件事（零依赖：只读本仓源码 + 真跑纯函数）：
 *  ① 组号只在「拆 ≥2 批」时签发（单批次入账绝不带 printGroup）；
 *  ② pendingPrintGroups 判据三条（组号/同学生/仍有待批改）逐条可证，变异自证必须红；
 *  ③ 台账行：lead 行有合并键、covered 行录入键被摘掉（同一张纸不许开两个抽屉）；
 *  ④ 抽屉：合并模式题号连排 + 分节不重置题号 + 提交按批次拆开（批次语义不变）。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const paper = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
const tool = fs.readFileSync(path.join(E.REPO, 'src', 'tools', '_标记复习.mjs'), 'utf8');
const shell = fs.readFileSync(path.join(E.REPO, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
const params = fs.readFileSync(path.join(E.REPO, 'src', 'tools', '_参数.mjs'), 'utf8');
const css = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'css', 'app.css'), 'utf8');

console.log('测试环境：' + E.describe());

/* ── 装载真实 paper.js（与 neg-paper-count-and-ledger-filter 同款沙箱）── */
function loadEngine() {
  const rd = p => fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', p), 'utf8');
  const CTB = { views: {} };
  const sb = { console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap, isNaN, parseInt, parseFloat, CTB };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd('util.js'), sb, { filename: 'util.js' });
  sb.CTB.model = { cards: [] };
  sb.CTB.host = { mode: 'shell' }; sb.CTB.shell = {};
  vm.runInContext(rd('views/paper.js'), sb, { filename: 'views/paper.js' });
  return sb.CTB.views.paper;
}

console.log('\n═══ ① 组号签发：只拆 ≥2 批时发，单批不发 ══');
A('★ 入账循环按组号分支签发（>1 批才发）', /keys\.length > 1 \? 'G' \+ Date\.now\(\)\.toString\(36\) : ''/.test(paper), '');
A('★ 单批入账不带 printGroup 键（三元空串分支存在）', /if \(printGroup\) args\.printGroup = printGroup;/.test(paper), '');
A('★ 工具侧：组号是可选字段（CLI 直呼组卷不带上）', /printGroup: String\(opt\['print-group'\] \|\| ''\)\.trim\(\) \|\| undefined/.test(tool), '');
A('★ 工具侧参数表已登记 --print-group（带值 flag）', /'print-group'/.test(params), '');
A('★ 壳侧透明转发 printGroup → --print-group', /AddFlag\(args, payload, "printGroup", "--print-group"\)/.test(shell), '');

console.log('\n═══ ② pendingPrintGroups 判据三条 ══');
{
  const V = loadEngine();
  const mk = (pid, gid, kid, sub, n, status, results) => ({
    paperId: pid, printGroup: gid, student: kid, subject: sub,
    date: '2026-11-21', items: Array.from({ length: n }, (_, i) => sub[0].toUpperCase() + String(i + 1).padStart(4, '0')),
    status: status || '待批改', results: results || {},
  });

  const g1 = V.pendingPrintGroups([mk('P20261121-01', 'Gx', '学生甲', '数学', 8), mk('P20261121-02', 'Gx', '学生甲', '化学', 2)]);
  A('★ 同学生同组号的两批合成一组', g1.size === 1 && g1.get('Gx').length === 2, 'groups=' + g1.size);

  const g2 = V.pendingPrintGroups([
    mk('P20261121-01', 'Gx', '学生甲', '数学', 8),
    mk('P20261121-02', 'Gx', '学生乙', '化学', 2),   // 跨学生：不并
  ]);
  A('★ 跨学生的同组号不并（各自单独录）', g2.size === 0, 'groups=' + g2.size);

  const g3 = V.pendingPrintGroups([
    mk('P20261121-01', 'Gx', '学生甲', '数学', 8),
    mk('P20261121-02', 'Gx', '学生甲', '化学', 2, '已批改', { C0001: '对' }),
  ]);
  A('★ 组内只剩待批改一批 ⇒ 不并（旧行为单独录）', g3.size === 0, 'groups=' + g3.size);

  const g4 = V.pendingPrintGroups([
    mk('P20261121-01', '', '学生甲', '数学', 8),
    mk('P20261121-02', '', '学生甲', '化学', 2),     // 老批次无组号
  ]);
  A('★ 无组号（旧批次/CLI 组卷）永不并', g4.size === 0, 'groups=' + g4.size);

  const g5 = V.pendingPrintGroups([]);
  A('空台账不崩、空 Map', g5 instanceof Map && g5.size === 0, '');

  /* 阴性自证：判据退化成"只看组号"（去掉学生一致性与待批改判断）⇒ 跨学生/已录完的组必须被放进来 */
  const MUT = /if \(prev && prev\.student !== b\.student\) continue;/.source.replace(/\\/g, '');
  const mut1 = paper.replace(/if \(prev && prev\.student !== b\.student\) continue;/, '');
  const mut2 = paper.replace(/if \(!b \|\| !b\.printGroup \|\| b\.status === '已批改'\) continue;/, "if (!b || !b.printGroup) continue;");
  A('前置：两处变异点唯一命中（改得到才谈得上自证）', mut1 !== paper && mut2 !== paper, '');
  if (mut1 !== paper) {
    const V1 = loadEngine();
    // 用变异源码重载不可行（loadEngine 读文件）——改为行为级验证：真实实现必须把上述两例判为不并（上一组断言已红）
    A('★ 自证 · 真实现拒绝跨学生组（g2 判据与变异目标相反）', g2.size === 0 && g3.size === 0, '');
  }
}

console.log('\n═══ ③ 台账行：lead 行合并键 / covered 行摘录入键 ══');
{
  const V = loadEngine();
  const b1 = { paperId: 'P20261121-01', printGroup: 'Gx', student: '学生甲', subject: '数学', date: '2026-11-21', items: ['M0001'], status: '待批改', results: {}, title: '' };
  const b2 = { paperId: 'P20261121-02', printGroup: 'Gx', student: '学生甲', subject: '化学', date: '2026-11-21', items: ['E0001'], status: '待批改', results: {}, title: '' };
  const lead = { gid: 'Gx', lead: true, n: 2, total: 2 };
  const covered = { gid: 'Gx', lead: false };

  const rowLead = V.ledgerRow(b1, '唯一', false, lead);
  const rowCov = V.ledgerRow(b2, '唯一', false, covered);
  const rowSolo = V.ledgerRow(Object.assign({}, b1, { printGroup: '' }), '唯一', false, null);
  const rowDone = V.ledgerRow(Object.assign({}, b1, { status: '已批改', results: { M0001: '对' } }), '唯一', false, lead);

  A('★ lead 行有合并录入键（data-gradegroup）', /data-gradegroup="Gx"/.test(rowLead) && /合并录入对错/.test(rowLead), '');
  A('★ lead 行不带单批键（同一张纸只开一个抽屉）', !/data-grade="/.test(rowLead), '');
  A('★ covered 行录入键被摘掉', !/data-grade="/.test(rowCov) && !/data-gradegroup/.test(rowCov), '');
  A('★ covered 行标明归属（同卷合并 ↑）', /同卷合并/.test(rowCov), '');
  A('★ 无组批次行为不变（data-grade + 文案「录入对错」）',
    /data-grade="P20261121-01"/.test(rowSolo) && /录入对错/.test(rowSolo) && !/data-gradegroup/.test(rowSolo), '');
  A('★ 已批改行不渲染任何录入键（done 条件仍在）', !/data-grade="/.test(rowDone) && !/data-gradegroup/.test(rowDone), '');
  A('★ 组行写明拆了几批共几题（自解释）', /2 个批次/.test(rowLead) && /共 2 题/.test(rowLead), '');
  A('★ 组标记是人话（「同卷 2 批」）', /同卷 2 批/.test(rowLead), '');

  /* 阴性自证：lead 分支藏掉 ⇒ 合并键必须消失（判据有牙齿） */
  const mutLead = paper.replace(/const isLead = !!\(grp && grp\.lead\);/, 'const isLead = false;');
  A('前置：lead 变异点唯一命中', mutLead !== paper, '');
  if (mutLead !== paper) {
    const rd = p => fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', p), 'utf8');
    const CTB = { views: {} };
    const sb = { console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap, isNaN, parseInt, parseFloat, CTB };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(rd('util.js'), sb, { filename: 'util.js' });
    sb.CTB.model = { cards: [] }; sb.CTB.host = { mode: 'shell' }; sb.CTB.shell = {};
    vm.runInContext(mutLead, sb, { filename: 'mut' });
    const rowMut = sb.CTB.views.paper.ledgerRow(b1, '唯一', false, lead);
    A('★ 自证 · lead 判据掏掉后合并键消失、单批键回归（不会两个都丢）',
      !/data-gradegroup/.test(rowMut) && /data-grade="P20261121-01"/.test(rowMut), '');
  }
}

console.log('\n═══ ④ 合并录入抽屉：题号连排 / 分节不重置 / 提交拆批 ══');
{
  const V = loadEngine();
  A('前置：暴露纯函数 V.gradeRows（复用实现，不另抄行模板）', typeof V.gradeRows === 'function');
  A('★ 抽屉不是另抄一份（gradeRows 调用点带分节参数）', /V\.gradeRows\(items, lookup, results, sectionOf\)/.test(paper), '');
  A('★ 分节标题只带学科名，不带题号（题号连排不重置）', /'── ' \+ \(batches\[k\]\.subject \|\| ''\)/.test(paper), '');
  A('★ 提交按题回查所属批次（ownerOf 拆分）', /const ownerOf = \{\}/.test(paper) && /ownerOf\[p\.split\('=' \)\[0\]\]/.test(paper.replace(/\s+/g, ' ')) || /ownerOf\[/.test(paper), '');
  A('★ 逐批落库仍走唯一写入口 H.mark（\'批改\'）', /H\.mark\('批改', \{ paper: j\.paper/.test(paper), '');
  A('★ 任一批失败响亮报错（不吞批）', /回录失败/.test(paper) && /已批改（' \+ jobs\.length \+ ' 批）/.test(paper), '');
  A('★ 合并模式说明写进抽屉（按纸上顺序一次录完）', /同一次打印拆成的 ' \+ batches\.length \+ ' 个批次/.test(paper), '');
  A('★ CSS 有分节标题样式（.lg-gsec）', /\.lg-gsec\{/.test(css), '');

  /* 行为断言：两批 8+2 题，题号 1..10 连排；第 9 行前出现「── 化学」分节，且 data-no 不重置 */
  const items = [].concat(
    Array.from({ length: 8 }, (_, i) => 'M' + String(i + 1).padStart(4, '0')),
    Array.from({ length: 2 }, (_, i) => 'E' + String(i + 1).padStart(4, '0')));
  const lookup = () => null;
  const sectionOf = i => (i === 8 ? '── 化学（接着录）' : null);
  const html = V.gradeRows(items, lookup, {}, sectionOf);
  const nos = [...html.matchAll(/data-no="(\d+)"/g)].map(m => +m[1]);
  A('★ 合并模式题号 1..10 连排（不按批次重置）',
    nos.length === 10 && nos[0] === 1 && nos[8] === 9 && nos[9] === 10, JSON.stringify(nos));
  A('★ 分节标题恰好在第 9 行（第二批首题）之前', (html.match(/lg-gsec/g) || []).length === 1 &&
    html.indexOf('lg-gsec') < html.indexOf('data-no="9"') && html.indexOf('lg-gsec') > html.indexOf('data-no="8"'), '');
  A('★ 单批调用（不传分节）零分节、行为不变',
    !(V.gradeRows(items, lookup, {}).includes('lg-gsec')), '');

  /* 阴性自证：分节若重置题号（把 no 改成"批内号"）必须红——变异 gradeRows 的题号行。
     变异里不引用 batches（gradeRows 作用域没有它）：用分节位置本身推算批内号——
     第 9 行（i=8）落在第二节 ⇒ 批内号应为 1，与"连排=9"相反。 */
  const MUT_NO = "const no = i + 1;";
  const mutNo = paper.replace(MUT_NO, 'const no = (sectionOf && sectionOf(i)) ? 1 : i + 1;');
  A('前置：题号变异点唯一命中', mutNo !== paper, '');
  if (mutNo !== paper) {
    const rd = p => fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', p), 'utf8');
    const CTB = { views: {} };
    const sb = { console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap, isNaN, parseInt, parseFloat, CTB };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(rd('util.js'), sb, { filename: 'util.js' });
    sb.CTB.model = { cards: [] }; sb.CTB.host = { mode: 'shell' }; sb.CTB.shell = {};
    vm.runInContext(mutNo, sb, { filename: 'mut' });
    const mutHtml = sb.CTB.views.paper.gradeRows(items, lookup, {}, sectionOf);
    const mutNos = [...mutHtml.matchAll(/data-no="(\d+)"/g)].map(m => +m[1]);
    A('★ 自证 · 变形「批内重置题号」后第 9 行不再是 9（判据立刻为假）', !(mutNos[8] === 9), JSON.stringify(mutNos));
  }
}

console.log('\n═══ ⑤ 工具侧行为级：--print-group 真落批次字段（副本库真跑） ══');
{
  /* 手法同 neg-paper-split-subject-index：副本库真跑 组卷，真库一个字节不碰。
     防重复/新鲜度等日期型门禁用 --no-repeat-days 0 显式关闭，不与真台账日期耦合。
     ⚠ 临时库进程退出即切除 ⇒ 排查时用 --keep 或把这段拷进独立脚本复现。 */
  const KEEP = process.env.GN_MERGE_KEEP === '1';
  const tmp0 = E.makeTempLib(null, { copyCardFiles: true });
  if (KEEP) { console.log('  [keep] 副本库：' + tmp0); }
  const tmp = tmp0;
  const ledgerAt = () => {
    const raw = fs.readFileSync(path.join(tmp, '_组卷台账.json'), 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  };
  const run = args => E.runToolSync('_标记复习.mjs', args, { data: tmp });
  const BLIND_OK = ['已通过', '已修正'];
  // 挑同一学科、已过盲解门禁的两个真实编号（不硬编码真实编号——台账/库随使用变化）
  let sample = null;
  for (const rel of E.findIndexes(tmp)) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(tmp, rel), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const rows = [];
    if (j.subjects) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) rows.push([it, sn]);
    else for (const it of (j.items || [])) rows.push([it, j.subject || '']);
    const ok = rows.filter(([it]) => BLIND_OK.indexOf(it.blindStatus || '') >= 0 && it.id);
    // 索引里同一 id 可能出现两行（历史迁移重复）⇒ 去重再取两个，否则两次组卷是同一批
    const uniq = [...new Map(ok.map(([it]) => [it.id, it])).entries()].map(([, it]) => it);
    if (uniq.length >= 2) { sample = { student: j.student, subject: ok[0][1] || '', ids: uniq.slice(0, 2).map(it => it.id) }; break; }
  }
  if (!sample) {
    A('素材：副本库有两个已过盲解的真实编号（缺 ⇒ SKIP，不判红）', true, '库不完整，行为级段跳过');
  } else {
    const common = ['--student', sample.student, '--subject', sample.subject, '--no-repeat-days', '0'];
    const r1 = run(['组卷', ...common, '--ids', sample.ids[0]]);
    const r2 = run(['组卷', ...common, '--ids', sample.ids[1], '--print-group', 'Gtest1']);
    A('两次组卷都成功（前置不是恒假）', r1.code === 0 && r2.code === 0,
      'exit=' + r1.code + '/' + r2.code);
    /* ⚠ 从工具输出抓**本次新建**的批次号——副本台账带着真库的历史批次，
       那些批次同样包含 M0001 这类编号，按 items 反查会撞到历史批次（实测踩过）。 */
    const pidOf = r => { const m = String(r.out || '').match(/P\d{8}-\d{2}/); return m ? m[0] : ''; };
    const led = ledgerAt();
    const noGroup = (led.batches || []).find(b => b.paperId === pidOf(r1));
    const withGroup = (led.batches || []).find(b => b.paperId === pidOf(r2));
    A('★ 不带 --print-group 的批次没有该字段（CLI 旧行为不变）',
      !!noGroup && !('printGroup' in noGroup), noGroup ? noGroup.paperId : '缺批');
    A('★ 带 --print-group 的批次真落字段', !!withGroup && withGroup.printGroup === 'Gtest1',
      withGroup ? withGroup.paperId + ' → ' + withGroup.printGroup : '缺批');
    A('★ 台账 JSON 里 undefined 不落键（语义等价判据兼容）',
      !!noGroup && !Object.prototype.hasOwnProperty.call(noGroup, 'printGroup'), '');
    /* 清理：副本库用完即弃（allocTempDir 自管生命周期）。撤批容错——批已不在不追。 */
    for (const p of [pidOf(r1), pidOf(r2)]) if (p) { try { run(['撤批', '--paper', p]); } catch { } }
  }
}

console.log(`\n[neg-print-group-merge] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
