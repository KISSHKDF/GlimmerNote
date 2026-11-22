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

console.log('\n═══ ② pendingPrintGroups（★ 2026-11-22 已被 printGroups 取代，本节只证迁移）═══');
{
  const V = loadEngine();
  const mk = (pid, gid, kid, sub, n, status, results) => ({
    paperId: pid, printGroup: gid, student: kid, subject: sub,
    date: '2026-11-21', items: Array.from({ length: n }, (_, i) => sub[0].toUpperCase() + String(i + 1).padStart(4, '0')),
    status: status || '待批改', results: results || {},
  });

  A('★ 旧 pendingPrintGroups 已移除（防止双轨并存、口径漂移）', typeof V.pendingPrintGroups !== 'function', '');

  /* 组号签发/分桶语义迁移到 V.printGroups（②b 节全量覆盖），这里只留跨学生判据的行为级锚点 */
  const g2 = V.printGroups([
    mk('P20261121-01', 'Gx', '学生甲', '数学', 8),
    mk('P20261121-02', 'Gx', '学生乙', '化学', 2),   // 跨学生：不并
  ]);
  A('★ 跨学生的同组号不并（判据迁移后语义不变）', g2.size === 0, 'groups=' + g2.size);
}

console.log('\n═══ ②b printGroups（2026-11-22 显示层合并判据）═══');
{
  const V = loadEngine();
  const mk = (pid, gid, kid, sub, n, status, results) => ({
    paperId: pid, printGroup: gid, student: kid, subject: sub,
    date: '2026-11-22', items: Array.from({ length: n }, (_, i) => sub[0].toUpperCase() + String(i + 1).padStart(4, '0')),
    status: status || '待批改', results: results || {},
  });

  /* 显示口径：**含已批改**——一张卷不论录没录完都是一行（用户 2026-11-22 定案） */
  const pg1 = V.printGroups([mk('P1', 'Gx', '学生甲', '数学', 8, '已批改', { M0001: '对' }), mk('P2', 'Gx', '学生甲', '化学', 2)]);
  A('★ 组内含已批改批次仍成组（显示口径不再看待批改）', pg1.size === 1 && pg1.get('Gx').length === 2, 'groups=' + pg1.size);

  const pg2 = V.printGroups([mk('P1', 'Gx', '学生甲', '数学', 8), mk('P2', 'Gx', '学生乙', '化学', 2)]);
  A('★ 跨学生不并（题库/判分/撤批按学生隔离）', pg2.size === 0, '');

  /* 变异自证：旧判据「status === '已批改' 则跳过」若被掏掉后行为不变——用"已批改组"直接可证 */
  A('★ 组号签发行为不变（同学生同组号两批成组）', pg1.size === 1, '');
}

console.log('\n═══ ②c ledgerUnits / groupToSheet（一行 = 一张卷）═══');
{
  const V = loadEngine();
  const mk = (pid, gid, kid, sub, n, status, results, title) => ({
    paperId: pid, printGroup: gid, student: kid, subject: sub,
    date: '2026-11-22', items: Array.from({ length: n }, (_, i) => sub[0].toUpperCase() + String(i + 1).padStart(4, '0')),
    status: status || '待批改', results: results || {}, title: title || ('重做卷 2026-11-22·' + sub),
  });
  const g = [mk('P1', 'Gx', '学生甲', '数学', 8, '待批改', { M0001: '对' }), mk('P2', 'Gx', '学生甲', '化学', 2, '待批改')];
  const grpMap = new Map([['Gx', g]]);
  const units = V.ledgerUnits([g[1], g[0]].slice().reverse(), grpMap);   // 倒序显示（台账显示=倒序）

  A('★ 组只出一行（covered 批次整行藏掉）', units.length === 1 && !!units[0].batches, 'units=' + units.length);
  A('★ 组单元带聚合信息（总题数=各批之和、学科去重拼接）',
    units[0].total === 10 && units[0].subjects === '数学+化学' && units[0].n === 2, units[0].subjects);
  const solo = V.ledgerUnits([mk('P9', '', '学生甲', '物理', 3)], grpMap);
  A('★ 无组号批次保持单批单元（旧行为）', solo.length === 1 && !!solo[0].b && !solo[0].batches, '');
  A('★ 空 grpMap 不崩、全部单批', V.ledgerUnits(g, new Map()).length === 2, '');

  const sheet = V.groupToSheet(g);
  A('★ 整卷复原题号连排（8+2=10，与打印的整张纸一致；数学段在前=打印顺序）',
    sheet.refs.length === 10 && sheet.refs[0].card.id === '数0001' && sheet.refs[7].card.id === '数0008' && sheet.refs[8].card.id === '化0001',
    sheet.refs.length + ' 题');
  A('★ 整卷复原标题取公共前缀（去「·学科」尾巴）', sheet.title === '重做卷 2026-11-22', sheet.title);
  A('★ 整卷 committed 逐键登记（预览不可能对它再次入账）',
    sheet.committed['学生甲|数学'] === 'P1' && sheet.committed['学生甲|化学'] === 'P2', JSON.stringify(sheet.committed));
  A('★ 整卷 results 合并（进度跨批聚合）', (sheet.results && Object.keys(sheet.results).length === 1), '');
  A('★ batchIds 带整组批次号（撤批展开用）', JSON.stringify(sheet.batchIds) === JSON.stringify(['P1', 'P2']), '');
  const empty = V.groupToSheet([]);
  A('★ 空组返回 null（不造空壳）', empty === null, '');
}

console.log('\n═══ ③ 台账行：一行 = 一张卷（组聚合 / 单批不变）═══');
{
  const V = loadEngine();
  const b1 = { paperId: 'P20261121-01', printGroup: 'Gx', student: '学生甲', subject: '数学', date: '2026-11-21', items: ['M0001', 'M0002'], status: '待批改', results: {}, title: '' };
  const b2 = { paperId: 'P20261121-02', printGroup: 'Gx', student: '学生甲', subject: '化学', date: '2026-11-21', items: ['E0001'], status: '待批改', results: {}, title: '' };
  const grpUnit = { lead: b1, gid: 'Gx', batches: [b1, b2], n: 2, total: 3, subjects: '数学+化学' };
  const soloUnit = { b: b1 };

  const rowGrp = V.ledgerRow(grpUnit, '唯一', false);
  const rowSolo = V.ledgerRow(soloUnit, '唯一', false);
  const rowGrpDone = V.ledgerRow({ lead: b1, gid: 'Gx', batches: [Object.assign({}, b1, { status: '已批改' }), Object.assign({}, b2, { status: '已批改', results: { E0001: '对' } })], n: 2, total: 3, subjects: '数学+化学' }, '唯一', false);

  A('★ 组行有合并录入键（data-gradegroup）', /data-gradegroup="Gx"/.test(rowGrp) && /合并录入对错/.test(rowGrp), '');
  A('★ 组行不带单批键（同一张纸只开一个抽屉）', !/data-grade="/.test(rowGrp), '');
  A('★ 组行题数是聚合值（8+2=3 题？不对——total=3 是单元给的）', /印的 3 道题/.test(rowGrp), 'total=3');
  A('★ 组行学科是去重拼接（数学+化学）', /数学\+化学/.test(rowGrp), '');
  A('★ 组行不再有「同卷 N 批」「同卷合并 ↑」小标签（用户定案：不摊批次给用户）',
    !/同卷 \d+ 批/.test(rowGrp) && !/同卷合并/.test(rowGrp), '');
  A('★ 组内全批改 ⇒ 整卷标已批改且无录入键（progress 聚合）',
    /已批改/.test(rowGrpDone) && !/data-grade="/.test(rowGrpDone) && !/data-gradegroup/.test(rowGrpDone), '');
  A('★ 组行有「👁 看这张卷」与「↩ 撤销试卷」（整卷操作）',
    /data-open="P20261121-01"/.test(rowGrp) && /data-revoke="P20261121-01"/.test(rowGrp), '');
  A('★ 无组批次行为不变（data-grade + 文案「录入对错」）',
    /data-grade="P20261121-01"/.test(rowSolo) && /录入对错/.test(rowSolo) && !/data-gradegroup/.test(rowSolo), '');
  A('★ 单批行学科仍是原学科', /数学/.test(rowSolo) && !/数学\+/.test(rowSolo), '');
  A('★ 组行写明拆了几批共几题（悬停自解释）', /2 个批次/.test(rowGrp) && /共 3 题/.test(rowGrp), '');

  /* 阴性自证：组分支藏掉（batches 视为单批）⇒ 合并键必须消失（判据有牙齿） */
  const mutGrp = paper.replace(/const grp = u\.batches \|\| null;/, 'const grp = null;');
  A('前置：组分支变异点唯一命中', mutGrp !== paper, '');
  if (mutGrp !== paper) {
    const rd = p => fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', p), 'utf8');
    const CTB = { views: {} };
    const sb = { console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap, isNaN, parseInt, parseFloat, CTB };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(rd('util.js'), sb, { filename: 'util.js' });
    sb.CTB.model = { cards: [] }; sb.CTB.host = { mode: 'shell' }; sb.CTB.shell = {};
    vm.runInContext(mutGrp, sb, { filename: 'mut' });
    const rowMut = sb.CTB.views.paper.ledgerRow(grpUnit, '唯一', false);
    A('★ 自证 · 组分支掏掉后合并键消失、单批键回归（不会两个都丢）',
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
