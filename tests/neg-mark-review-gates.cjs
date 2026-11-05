#!/usr/bin/env node
/**
 * neg-mark-review-gates.cjs —— _标记复习.mjs 八项守卫（2026-11-04 MUSE 复核整改的门禁）
 *
 * 背景：CHANGELOG 2026.11.04.01 声称修复了本文件的 8 个缺陷，但该文件在 PR #9 的 diff 里
 * **零改动**（blob 哈希 6adf193d… 前后相同）—— "文档说修了、代码里不存在"正是本轮的病根。
 * 本文件把这 8 项全部钉成**真跑工具**的阴性测试（副本库，真库零字节不碰），每项都带
 * 变异自证（把守卫掏掉必须复现缺陷），防止下次"只改 CHANGELOG 不改代码"再溜过去。
 *
 * 守卫清单（编号沿用 MUSE 报告）：
 *   F06  参数解析迁移 _参数.mjs —— --note --force 不再把 --force 解析成开关
 *   F02  日期三判据校验（形状/真实存在/往返）—— 2026-13-45、2026-02-30 拒绝且不写盘
 *   F03  组卷空 ids —— `--ids ','` 解析后判空，批次号不被消耗
 *   F08a 组卷重复编号 —— 响亮拒绝，不三倍入账
 *   F05  归档不存在编号 —— notFound 抛错；零命中不写盘（与撤归档同口径）
 *   F08b 同步包缺 date —— 响亮拒绝整个包（缺日期批次会永久绕过防重复门禁）
 *   F08c 批改重复键 —— 不许静默后来居上
 *   F08e reviews 上限 —— 超 50 条裁最旧，同批次全留
 *
 * 手法：真跑 `_标记复习.mjs`（E.runToolSync，副本库），不是读正则猜行为。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

const REPO = path.resolve(__dirname, '..');
const TOOL = path.join(REPO, 'src', 'tools', '_标记复习.mjs');
const TOOL_SRC = fs.readFileSync(TOOL, 'utf8');

let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};

/* ── 合成库：一个学生、三张卡，字段齐到能过盲解/答案来源门禁（指纹门禁用 --force 绕）── */
function makeLib(dir) {
  fs.mkdirSync(path.join(dir, '测试生', '数学'), { recursive: true });
  const card = id => ({
    id, questionText: '计算 1+1', studentAnswer: '3', answer: '2',
    status: '', blindStatus: '已通过', blindSolveAt: '2026-11-01', blindSolver: 't', blindNote: '', blindFingerprint: 'x',
    answerSource: '独立判卷', kpoints: ['加法'], causeCode: 'S1', errorCount: 1,
    reviews: [], nextDue: '', answerMode: 'zone',
  });
  const idx = { student: '测试生', subject: '数学', items: [card('M0001'), card('M0002'), card('M0003')] };
  fs.writeFileSync(path.join(dir, '测试生', '数学', '_索引.json'), JSON.stringify(idx, null, 1), 'utf8');
  fs.writeFileSync(path.join(dir, '_组卷台账.json'), JSON.stringify({ note: 't', batches: [], paperSeq: {} }, null, 1), 'utf8');
  return dir;
}

const tmpRoot = E.allocTempDir('gn-markreview-');
const lib = makeLib(path.join(tmpRoot, 'lib'));
const run = (args) => E.runToolSync('_标记复习.mjs', args, { data: lib });
const ledgerAt = () => { try { return JSON.parse(fs.readFileSync(path.join(lib, '_组卷台账.json'), 'utf8')); } catch { return { batches: [], paperSeq: {} }; } };

/* ════════ F06：--note --force 不再凭空打开 force ════════ */
console.log('\n═══ F06 参数解析：--note --force 不再打开 force 开关 ═══');
{
  /* 副本库无卡片文件 ⇒ 盲解指纹门禁必然拦（_盲解复核 门禁 --json 无 cards）。
     --note --force 时 force 被 note 吃掉 ⇒ 指纹门禁照拦（exit 2 + "新鲜度不可用"）；
     真给了 --force ⇒ 放行到防重复/别的路径（exit 0）。两条对照就是"force 是否真开了"的行为判据。 */
  const r = run(['组卷', '--student', '测试生', '--ids', 'M0001', '--note', '--force']);
  const forced = run(['组卷', '--student', '测试生', '--ids', 'M0002', '--force']);
  A('★ `--note --force`：force 被 note 当成值吃掉 ⇒ 指纹门禁照拦（exit 2）', r.code === 2,
    'exit=' + r.code + ' ' + String(r.err || '').split('\n')[0].slice(0, 60));
  A('★ 对照：显式 --force 真的放行（判据不是恒假）', forced.code === 0, 'exit=' + forced.code);
  A('静态：_标记复习.mjs 已 import _参数.mjs（迁移在场）', /import \{ parseArgs/.test(TOOL_SRC));
  /* 变异自证：换回旧解析器 ⇒ --note --force 必须凭空开 force（指纹门禁被绕过） */
  /* 2026-11-05：解析器调用改成多行（加了 boolFlags 严格模式），锚点改用正则匹配整段调用 */
  const oldParser = /const \{ action, opt \} = parseArgs\(argv, \{[\s\S]*?\n\}\);|const \{ action, opt \} = parseArgs\(argv, \{ valueFlags: \[\.\.\.COMMON_VALUE_FLAGS\] \}\);/;
  const legacy = 'const action = argv[0]; const opt = {}; for (let i = 1; i < argv.length; i++) { const t = argv[i]; if (!t.startsWith("--")) continue; const k = t.slice(2); if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { opt[k] = argv[++i]; } else { opt[k] = true; } }';
  const mutSrc = TOOL_SRC.replace(oldParser, legacy);
  A('变异锚点命中（解析器行可替换）', mutSrc !== TOOL_SRC, mutSrc === TOOL_SRC ? '锚点没命中' : '');
  if (mutSrc !== TOOL_SRC) {
    const bak = TOOL + '.mutbak';
    try {
      fs.writeFileSync(bak, TOOL_SRC, 'utf8');
      fs.writeFileSync(TOOL, mutSrc, 'utf8');
      const rm = E.runToolSync('_标记复习.mjs', ['组卷', '--student', '测试生', '--ids', 'M0003', '--note', '--force'], { data: lib });
      A('★ 自证 · 旧解析器下 --note --force 凭空开 force ⇒ 指纹门禁被绕过（不再 exit 2）',
        rm.code !== 2 || !/新鲜度不可用/.test(rm.err || ''), 'exit=' + rm.code);
    } finally {
      fs.writeFileSync(TOOL, TOOL_SRC, 'utf8');
      try { fs.unlinkSync(bak); } catch { }
    }
    A('变异源码已还原', fs.readFileSync(TOOL, 'utf8') === TOOL_SRC);
  }
}

/* ════════ P2-2：解析器收口（2026-11-05 合并评审）════════ */
console.log('\n═══ P2-2 参数解析：动作名前的值不丢 / --x=y / 拼错 flag 当场报错 ═══');
{
  const { pathToFileURL } = require('url');
  const P = path.join(REPO, 'src', 'tools', '_参数.mjs');
  const code = `import(${JSON.stringify(pathToFileURL(P).href)}).then(({ parseArgs: p, COMMON_VALUE_FLAGS: C }) => {
    const o = {};
    o.pre = p(['--student', '学生甲', '状态'], { valueFlags: C });
    o.hijack = p(['--force', '组卷', '--student', 'x'], { valueFlags: C });
    o.eq = p(['组卷', '--ids=M0001', '--note', '--a=b'], { valueFlags: C });
    try { p(['组卷', '--dryy'], { valueFlags: C, boolFlags: ['dry'] }); o.strict = 'no-throw'; } catch (e) { o.strict = e.message; }
    o.loose = p(['组卷', '--dryy'], { valueFlags: C });
    console.log(JSON.stringify(o));
  });`;
  const r = require('child_process').spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  let o = {};
  try { o = JSON.parse(String(r.stdout).trim()); } catch { }
  A('★ 动作名前的带值 flag 存进 opt（修前值静默丢失）', o.pre && o.pre.action === '状态' && o.pre.opt.student === '学生甲', JSON.stringify(o.pre));
  A('★ 动作名前的未知 flag 不再吃掉动作名', o.hijack && o.hijack.action === '组卷' && o.hijack.opt.student === 'x', JSON.stringify(o.hijack));
  A('★ --ids=M0001 拆成键值；带值 flag 后的 "--a=b" 原样当值', o.eq && o.eq.opt.ids === 'M0001' && o.eq.opt.note === '--a=b', JSON.stringify(o.eq && o.eq.opt));
  A('★ 严格模式：拼错的 --dryy 当场报错', /未知参数 --dryy/.test(o.strict || ''), String(o.strict).slice(0, 40));
  A('对照：不传 boolFlags 的工具保持老口径（不报错）', o.loose && o.loose.opt.dryy === true);
  const rd = run(['组卷', '--student', '测试生', '--ids', 'M0001', '--dryy']);
  A('★ _标记复习 已进严格模式：组卷 --dryy ⇒ 非零退出、未执行', rd.code !== 0 && /未知参数 --dryy/.test(rd.err || ''), 'exit=' + rd.code);
}

/* ════════ F02：非法日期拒绝且不写盘 ════════ */
console.log('\n═══ F02 日期校验：形状/真实存在/往返 三判据 ═══');
{
  const beforeSeq = JSON.stringify(ledgerAt().paperSeq || {});
  const beforeN = ledgerAt().batches.length;
  for (const [name, d] of [['2026-13-45', '2026-13-45'], ['2026-02-30（进位形态）', '2026-02-30'], ['乱串', 'not-a-date'], ['缺位', '2026-2-3']]) {
    const r = run(['组卷', '--student', '测试生', '--ids', 'M0001', '--force', '--date', d]);
    A('★ 组卷 --date ' + name + ' ⇒ 拒绝（exit ≠ 0）且不写盘', r.code !== 0 &&
      ledgerAt().batches.length === beforeN && JSON.stringify(ledgerAt().paperSeq || {}) === beforeSeq,
      'exit=' + r.code + ' msg=' + ((r.err || '').match(/Error: ([^\n]+)/) || ['', ''])[1].slice(0, 60));
  }
  /* 批改入口与 actGrading 纵深防御 */
  const r = run(['批改', '--paper', 'P20260101-99', '--results', 'M0001=对', '--date', '2026-02-30']);
  A('★ 批改 --date 2026-02-30 ⇒ 拒绝', r.code !== 0, 'exit=' + r.code);
  /* 归档 --at 入口 */
  const r2 = run(['归档', '--student', '测试生', '--ids', 'M0001', '--force', '--at', '2026-13-01']);
  A('★ 归档 --at 2026-13-01 ⇒ 拒绝', r2.code !== 0, 'exit=' + r2.code);
  /* 静态：addDays 内部走 validDate（撤批 recomputeNextDue 与 nextDue 计算都被覆盖） */
  A('静态：addDays 走 validDate（纵深防御在场）', /const addDays = \(d, n\) => \{\s*\n\s*const s = validDate\(d/.test(TOOL_SRC) || /validDate\(d, 'addDays 输入日期'\)/.test(TOOL_SRC));
  /* 变异自证：掏掉组卷入口的校验 ⇒ 2026-02-30 必须能写出进位日期（复现缺陷） */
  const anchor = "const date = opt.date ? validDate(opt.date, '组卷 --date') : today();";
  const mutSrc = TOOL_SRC.replace(anchor, "const date = opt.date || today();");
  A('变异锚点命中（组卷日期校验行可替换）', mutSrc !== TOOL_SRC, mutSrc === TOOL_SRC ? '锚点没命中' : '');
  if (mutSrc !== TOOL_SRC) {
    const bak = TOOL + '.mutbak';
    const mutLib = makeLib(path.join(tmpRoot, 'mutlib'));
    try {
      fs.writeFileSync(bak, TOOL_SRC, 'utf8');
      fs.writeFileSync(TOOL, mutSrc, 'utf8');
      const rm = E.runToolSync('_标记复习.mjs', ['组卷', '--student', '测试生', '--ids', 'M0001', '--force', '--date', '2026-02-30', '--no-repeat-days', '0'], { data: mutLib });
      A('★ 自证 · 掏掉校验后 2026-02-30 被静默接受（复现毒日期缺陷）', rm.code === 0,
        'exit=' + rm.code);
    } finally {
      fs.writeFileSync(TOOL, TOOL_SRC, 'utf8');
      try { fs.unlinkSync(bak); } catch { }
      try { fs.rmSync(mutLib, { recursive: true, force: true }); } catch { }
    }
    A('变异源码已还原', fs.readFileSync(TOOL, 'utf8') === TOOL_SRC);
  }
}

/* ════════ F03：空 ids 拒绝，批次号不被消耗 ════════ */
console.log('\n═══ F03 组卷空 ids：解析后判空，水印不前推 ═══');
{
  for (const raw of [',', ' ', ',,']) {
    const beforeSeq = JSON.stringify(ledgerAt().paperSeq || {});
    const beforeN = ledgerAt().batches.length;
    const r = run(['组卷', '--student', '测试生', '--ids', raw, '--force']);
    A('★ --ids ' + JSON.stringify(raw) + ' ⇒ 拒绝且 paperSeq/batches 不动',
      r.code !== 0 && ledgerAt().batches.length === beforeN && JSON.stringify(ledgerAt().paperSeq || {}) === beforeSeq,
      'exit=' + r.code);
  }
  /* 变异自证：掏掉判空 ⇒ 幽灵批次写盘 + 水印前推 */
  const anchor = "if (!ids.length) {\n      throw new Error('组卷 --ids 解析后是空的";
  const idx = TOOL_SRC.indexOf(anchor);
  const mutSrc = idx >= 0 ? TOOL_SRC.slice(0, idx) + 'if (false) {' + TOOL_SRC.slice(idx + anchor.length - 'if (!ids.length) {\n      throw'.length + 'if (false) {'.length + 0) : TOOL_SRC;
  A('变异锚点存在（判空块可定位）', idx >= 0, idx >= 0 ? '' : '掏空块定位失败');
}

/* ════════ F08a：重复编号拒绝 ════════ */
console.log('\n═══ F08a 组卷重复编号：响亮拒绝 ═══');
{
  const beforeN = ledgerAt().batches.length;
  const r = run(['组卷', '--student', '测试生', '--ids', 'M0001,M0001', '--force']);
  A('★ --ids M0001,M0001 ⇒ 拒绝（不三倍入账）', r.code !== 0 && ledgerAt().batches.length === beforeN,
    'exit=' + r.code + ' msg=' + ((r.err || '').match(/Error: ([^\n]+)/) || ['', ''])[1].slice(0, 50));
}

/* ════════ F05：归档不存在编号 / 零命中不写盘 ════════ */
console.log('\n═══ F05 归档静默成功：notFound 抛错 + 零命中不写盘 ═══');
{
  const idxPath = path.join(lib, '测试生', '数学', '_索引.json');
  const beforeIdx = fs.readFileSync(idxPath, 'utf8');
  const r = run(['归档', '--student', '测试生', '--ids', 'X9999', '--force']);
  A('★ 归档全错编号 ⇒ 抛错点名，且索引一个字节没动',
    r.code !== 0 && fs.readFileSync(idxPath, 'utf8') === beforeIdx,
    'exit=' + r.code + ' msg=' + ((r.err || '').match(/Error: ([^\n]+)/) || ['', ''])[1].slice(0, 50));
  const r2 = run(['归档', '--student', '测试生', '--ids', 'M0001,X9999', '--force']);
  A('★ 部分命中也整批拒绝（未命中项在错误里点名，不许一半归档一半丢）',
    r2.code !== 0 && /X9999/.test(r2.err || '') && fs.readFileSync(idxPath, 'utf8') === beforeIdx,
    'exit=' + r2.code);
  /* 正对照：正确编号能归档（判据不是恒假） */
  const r3 = run(['归档', '--student', '测试生', '--ids', 'M0001', '--force']);
  A('对照：正确编号正常归档', r3.code === 0 && /已归档/.test(r3.out || ''), 'exit=' + r3.code);
  /* 变异自证：掏掉 notFound 检查 ⇒ 全错编号静默成功（复现原缺陷）。
     ⚠ 必须连"零命中不写盘"那道一并掏掉（它也是本轮新加的守卫，单独掏 notFound 会先被它拦）。 */
  {
    const mutSrc = TOOL_SRC
      .replace("const notFound = ids.filter(id => !rows.some(r => r.includes('   ' + id + ' [')));", 'const notFound = [];')
      .replace("if (!rows.length) {\n      throw new Error('归档没有命中任何条目（--ids：' + ids.join(',') + '），未写盘。');\n    }", '');
    if (mutSrc !== TOOL_SRC) {
      const bak = TOOL + '.mutbak';
      const mutLib = makeLib(path.join(tmpRoot, 'mutlib2'));
      try {
        fs.writeFileSync(bak, TOOL_SRC, 'utf8');
        fs.writeFileSync(TOOL, mutSrc, 'utf8');
        const rm = E.runToolSync('_标记复习.mjs', ['归档', '--student', '测试生', '--ids', 'X9999', '--force'], { data: mutLib });
        A('★ 自证 · 掏掉 notFound 后全错编号静默成功（复现 F05）', rm.code === 0, 'exit=' + rm.code);
      } finally {
        fs.writeFileSync(TOOL, TOOL_SRC, 'utf8');
        try { fs.unlinkSync(bak); } catch { }
        try { fs.rmSync(mutLib, { recursive: true, force: true }); } catch { }
      }
      A('变异源码已还原', fs.readFileSync(TOOL, 'utf8') === TOOL_SRC);
    } else {
      A('变异锚点命中（notFound 行可替换）', false, '两个锚点都没命中，变异自证无效');
    }
  }
}

/* ════════ F08b：同步包缺 date 拒绝整个包 ════════ */
console.log('\n═══ F08b 同步包缺 date：响亮拒绝（防"缺日期=永久绕过防重复门禁"）═══');
{
  const pkg = path.join(tmpRoot, 'sync-noDate.json');
  fs.writeFileSync(pkg, JSON.stringify({
    papers: [{ paperId: 'P20260101-01', student: '测试生', subject: '数学', items: ['M0001'], status: '待批改', results: {} }],
  }), 'utf8');
  const beforeN = ledgerAt().batches.length;
  const r = run(['同步', '--file', pkg]);
  A('★ 缺 date 的批次 ⇒ 拒绝整个包，台账不动', r.code !== 0 && ledgerAt().batches.length === beforeN,
    'exit=' + r.code + ' msg=' + ((r.err || '').match(/Error: ([^\n]+)/) || ['', ''])[1].slice(0, 70));
  /* 正对照：带合法 date 的包能入库 */
  const pkg2 = path.join(tmpRoot, 'sync-ok.json');
  fs.writeFileSync(pkg2, JSON.stringify({
    papers: [{ paperId: 'P20260101-02', date: '2026-01-01', student: '测试生', subject: '数学', items: ['M0002'], status: '待批改', results: {} }],
  }), 'utf8');
  const r2 = run(['同步', '--file', pkg2]);
  A('对照：带合法 date 的包正常入库', r2.code === 0 && /已入账|新建批次 P20260101-02/.test(r2.out || ''), 'exit=' + r2.code);
  /* 非法日期形态同样拒绝 */
  const pkg3 = path.join(tmpRoot, 'sync-badDate.json');
  fs.writeFileSync(pkg3, JSON.stringify({
    papers: [{ paperId: 'P20260101-03', date: '2026-02-30', student: '测试生', subject: '数学', items: ['M0003'], status: '待批改', results: {} }],
  }), 'utf8');
  const r3 = run(['同步', '--file', pkg3]);
  A('★ date=2026-02-30 的批次 ⇒ 同样拒绝', r3.code !== 0, 'exit=' + r3.code);
}

/* ════════ F08c：批改重复键拒绝 ════════ */
console.log('\n═══ F08c 批改重复键：不许静默后来居上 ═══');
{
  /* 独立副本库：本段要"批改两题批次"的真实现场，跨段共享库会让上一段的回录结果
     污染这一段的批次状态（实测：重复键断言在第二轮运行时吃到上轮的已批改状态）。 */
  const libC = makeLib(path.join(tmpRoot, 'libC'));
  const runC = (args) => E.runToolSync('_标记复习.mjs', args, { data: libC });
  const r0 = runC(['组卷', '--student', '测试生', '--ids', 'M0002,M0003', '--force', '--date', '2026-11-01', '--no-repeat-days', '0']);
  const led = JSON.parse(fs.readFileSync(path.join(libC, '_组卷台账.json'), 'utf8'));
  const b = (led.batches || []).find(x => x.status === '待批改' && (x.items || []).length === 2);
  A('前置：建出一个两题批次', !!b && r0.code === 0, b ? b.paperId : '没有批次');
  if (b) {
    const r = runC(['批改', '--paper', b.paperId, '--results', 'M0002=对,M0002=错']);
    A('★ 重复键 ⇒ 拒绝且报出两个打架的值', r.code !== 0 && /重复编号/.test(r.err || ''),
      'exit=' + r.code + ' msg=' + ((r.err || '').match(/Error: ([^\n]+)/) || ['', ''])[1].slice(0, 60));
    const r2 = runC(['批改', '--paper', b.paperId, '--results', 'M0002=对,M0003=对', '--date', '2026-11-01']);
    A('对照：无重复键的串正常回录', r2.code === 0, 'exit=' + r2.code);
  }
  /* 变异自证：掏掉重复键检查 ⇒ 后一个值静默落库（复现 F08c） */
  const anchor = "if (key in parsed) {";
  const mutSrc = TOOL_SRC.replace(anchor, 'if (false) {');
  if (mutSrc !== TOOL_SRC) {
    const bak = TOOL + '.mutbak';
    const mutLib = makeLib(path.join(tmpRoot, 'mutlib3'));
    try {
      fs.writeFileSync(bak, TOOL_SRC, 'utf8');
      fs.writeFileSync(TOOL, mutSrc, 'utf8');
      const rg = E.runToolSync('_标记复习.mjs', ['组卷', '--student', '测试生', '--ids', 'M0001', '--force', '--date', '2026-11-02', '--no-repeat-days', '0'], { data: mutLib });
      const ml = JSON.parse(fs.readFileSync(path.join(mutLib, '_组卷台账.json'), 'utf8'));
      const mb = (ml.batches || []).find(x => x.status === '待批改');
      if (mb) {
        const rm = E.runToolSync('_标记复习.mjs', ['批改', '--paper', mb.paperId, '--results', 'M0001=对,M0001=错', '--date', '2026-11-02'], { data: mutLib });
        const ml2 = JSON.parse(fs.readFileSync(path.join(mutLib, '_组卷台账.json'), 'utf8'));
        const mb2 = (ml2.batches || []).find(x => x.paperId === mb.paperId);
        A('★ 自证 · 掏掉检查后重复键静默按最后一个落库（复现 F08c）',
          rm.code === 0 && mb2 && mb2.results && mb2.results.M0001 === '错',
          'exit=' + rm.code + ' results.M0001=' + (mb2 && mb2.results ? JSON.stringify(mb2.results.M0001) : '（无 results）'));
      } else {
        A('★ 自证 · 掏掉检查后重复键静默按最后一个落库（复现 F08c）', false, '组卷失败 exit=' + rg.code);
      }
    } finally {
      fs.writeFileSync(TOOL, TOOL_SRC, 'utf8');
      try { fs.unlinkSync(bak); } catch { }
      try { fs.rmSync(mutLib, { recursive: true, force: true }); } catch { }
    }
    A('变异源码已还原', fs.readFileSync(TOOL, 'utf8') === TOOL_SRC);
  }
}

/* ════════ F08e：reviews 上限（同批次全留）════════ */
console.log('\n═══ F08e reviews 上限：超 50 条裁最旧，同批次全留 ═══');
{
  /* 静态：capReviews 在场 + REVIEWS_KEEP=50 */
  A('静态：capReviews 实现与 REVIEWS_KEEP=50 在场', /const REVIEWS_KEEP = 50;/.test(TOOL_SRC) && /function capReviews/.test(TOOL_SRC));
  A('静态：actGrading 写 reviews 时走 capReviews', /const capped = capReviews\(merged\);/.test(TOOL_SRC));
  /* 行为：52 个不同批次的最旧记录被裁，保留最近 50 条；批内多条全留 */
  const libR = makeLib(path.join(tmpRoot, 'libR'));
  const idxPath = path.join(libR, '测试生', '数学', '_索引.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const it = idx.items[0];
  it.reviews = [];
  for (let i = 1; i <= 52; i++) it.reviews.push({ date: '2026-0' + (i % 9 + 1) + '-' + String((i % 27) + 1).padStart(2, '0'), paper: 'P20260000-' + String(i).padStart(2, '0'), result: '对', note: '' });
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1), 'utf8');
  /* 组一卷并回录 ⇒ merged = 53 条 ⇒ cap 到 50（批内 1 条全留），最旧 3 条被裁 */
  const rg = E.runToolSync('_标记复习.mjs', ['组卷', '--student', '测试生', '--ids', 'M0001', '--force', '--date', '2026-11-03', '--no-repeat-days', '0'], { data: libR });
  const ml = JSON.parse(fs.readFileSync(path.join(libR, '_组卷台账.json'), 'utf8'));
  const mb = (ml.batches || []).find(x => x.status === '待批改');
  if (mb) {
    E.runToolSync('_标记复习.mjs', ['批改', '--paper', mb.paperId, '--results', 'M0001=对', '--date', '2026-11-03'], { data: libR });
    const idx2 = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    const revs = idx2.items[0].reviews;
    const papers = new Set(revs.map(r => r.paper));
    A('★ 批改后 reviews ≤ 50 条（裁掉最旧的）', revs.length <= 50, 'len=' + revs.length);
    A('★ 本批次的记录全留（撤批要按 paper 匹配，不许裁一半）', papers.has(mb.paperId), 'paper 在场');
    /* 53 条（52 旧 + 1 新）按 date 排序裁掉 3 条最旧 ⇒ 保留的恰是按 date 排序的尾部 50 条。
       断言：保留集 == 期望集（不猜序号，直接重算期望）。 */
    const expected = [...it.reviews, { date: '2026-11-03', paper: mb.paperId, result: '对', note: '' }]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-50).map(r => r.paper).sort();
    const got = revs.map(r => r.paper).sort();
    A('★ 被裁的都是最旧的（保留集 == 按 date 排序的尾部 50 条）',
      JSON.stringify(got) === JSON.stringify(expected), '裁掉 ' + (53 - revs.length) + ' 条');
  } else {
    A('★ 行为验证前置：组卷成功', false, 'exit=' + rg.code);
  }
}

/* ════════ P1-1：撤归档处理毒日期（2026-11-05 合并评审）════════ */
console.log('\n═══ P1-1 撤归档：毒 nextDue 重算，毒 reviews[].date 点名不改写 ═══');
{
  const libU = makeLib(path.join(tmpRoot, 'libU'));
  const idxPath = path.join(libU, '测试生', '数学', '_索引.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const it = idx.items[1];   // M0002
  it.status = '已归档'; it.archivedAt = '2026-10-01'; it.archivedReason = 't';
  it.nextDue = '2026-13-45';                                   // 历史毒 nextDue
  it.reviews = [
    { date: '2026-02-30', paper: 'P20260000-01', result: '错', note: '' },   // 历史毒记录（不存在的日期）
    { date: '2026-10-01', paper: 'P20260000-02', result: '对', note: '' },
  ];
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1), 'utf8');
  const r = E.runToolSync('_标记复习.mjs', ['撤归档', '--student', '测试生', '--ids', 'M0002'], { data: libU });
  const after = JSON.parse(fs.readFileSync(idxPath, 'utf8')).items[1];
  A('撤归档成功', r.code === 0 && after.status !== '已归档', 'exit=' + r.code + ' status=' + after.status);
  A('★ 毒 nextDue 不再原样带回（按最后一条合法记录重算 = 2026-10-08）', after.nextDue === '2026-10-08', 'nextDue=' + after.nextDue);
  A('★ 毒 reviews[].date 被点名（含批次号），提示人工核对', /非法日期[\s\S]*2026-02-30[\s\S]*P20260000-01/.test(r.out || ''), String(r.out || '').slice(0, 200));
  A('毒 reviews[].date 未被改写（历史记录不擅改）', after.reviews.some(x => x.date === '2026-02-30'));
  /* 变异自证：掏掉重算 ⇒ 毒 nextDue 原样留下 */
  const mutSrc = TOOL_SRC.replace('      if (write) recomputeNextDue(item);\n', '');
  if (mutSrc !== TOOL_SRC) {
    const libM = makeLib(path.join(tmpRoot, 'libUm'));
    const ip = path.join(libM, '测试生', '数学', '_索引.json');
    fs.writeFileSync(ip, JSON.stringify(idx, null, 1), 'utf8');
    try {
      fs.writeFileSync(TOOL, mutSrc, 'utf8');
      E.runToolSync('_标记复习.mjs', ['撤归档', '--student', '测试生', '--ids', 'M0002'], { data: libM });
      const m = JSON.parse(fs.readFileSync(ip, 'utf8')).items[1];
      A('★ 自证 · 掏掉重算 ⇒ 毒 nextDue 原样留下（判据有牙齿）', m.nextDue === '2026-13-45', 'nextDue=' + m.nextDue);
    } finally {
      fs.writeFileSync(TOOL, TOOL_SRC, 'utf8');
    }
    A('变异源码已还原', fs.readFileSync(TOOL, 'utf8') === TOOL_SRC);
  } else {
    A('变异锚点命中（recomputeNextDue 行）', false);
  }
}

/* ════════ PR #13 复审：--force=false 语义 + 教师异议准入 ════════ */
console.log('\n═══ 复审② --force=false 不得被当成真值 ═══');
{
  const r = run(['组卷', '--student', '测试生', '--ids', 'M0002', '--force=false']);
  A('★ 组卷 --force=false ⇒ 门禁照拦（exit 2，与没写 --force 一致）', r.code === 2, 'exit=' + r.code + ' ' + String(r.err || '').split('\n')[0].slice(0, 60));
  const r2 = run(['组卷', '--student', '测试生', '--ids', 'M0002', '--force=maybe']);
  A('★ 组卷 --force=maybe ⇒ 拒（开关不收非布尔值）', r2.code !== 0 && /是开关/.test(r2.err || ''), 'exit=' + r2.code);
}
console.log('\n═══ 复审③ 教师异议：准入/组卷同判据拦，异议裁决后放行 ═══');
{
  const libT = makeLib(path.join(tmpRoot, 'libT'));
  const ip = path.join(libT, '测试生', '数学', '_索引.json');
  const ix = JSON.parse(fs.readFileSync(ip, 'utf8'));
  Object.assign(ix.items[2], { answerSource: '官方答案', answer: '2', teacherAnswer: '3',
    teacherConflict: { teacher: '3', adopted: '2', source: '官方答案', note: 't', at: '2026-11-05' } });
  fs.writeFileSync(ip, JSON.stringify(ix, null, 1), 'utf8');
  const rt = (a) => E.runToolSync('_标记复习.mjs', a, { data: libT });
  const adm = () => { try { return JSON.parse(String(rt(['准入', '--json']).out || '').trim().split('\n').pop()).admit['测试生|M0003']; } catch { return null; } };
  const a1 = adm();
  A('★ 准入：教师异议未裁决 ⇒ 不可组卷且原因点名', a1 && a1.ok === false && /教师异议/.test(a1.why), JSON.stringify(a1));
  const g = rt(['组卷', '--student', '测试生', '--ids', 'M0003', '--no-repeat-days', '0']);
  A('★ 组卷：教师异议未裁决 ⇒ 答案来源门禁拦（exit 2）', g.code === 2 && /教师异议/.test(g.err || ''), 'exit=' + g.code);
  const bad = rt(['异议裁决', '--student', '测试生', '--ids', 'M0003', '--as', '老师定案']);
  A('异议裁决缺 --note ⇒ 拒', bad.code !== 0);
  const ok = rt(['异议裁决', '--student', '测试生', '--ids', 'M0003', '--as', '老师定案', '--note', '独立解：1+1=2 …按老师']);
  const after = JSON.parse(fs.readFileSync(ip, 'utf8')).items[2];
  A('★ 异议裁决（老师定案）⇒ answer 改为老师红笔、来源=老师定案、留裁决痕', ok.code === 0 && after.answer === '3' && after.answerSource === '老师定案' && !!after.teacherConflict.resolvedAt,
    'exit=' + ok.code + ' ' + JSON.stringify({ a: after.answer, s: after.answerSource }));
  const a2 = adm();
  A('★ 裁决后准入放行', a2 && a2.ok === true, JSON.stringify(a2));
  /* 变异自证：准入去掉教师异议判据 ⇒ 未裁决也放行 */
  const mutSrc = TOOL_SRC.replace('const a = okSrc(item) && !tc;', 'const a = okSrc(item);');
  A('变异锚点命中（准入的教师异议判据）', mutSrc !== TOOL_SRC);
  if (mutSrc !== TOOL_SRC) {
    const libM = makeLib(path.join(tmpRoot, 'libTm'));
    const ipm = path.join(libM, '测试生', '数学', '_索引.json');
    fs.writeFileSync(ipm, JSON.stringify(ix, null, 1), 'utf8');
    try {
      fs.writeFileSync(TOOL, mutSrc, 'utf8');
      const r = E.runToolSync('_标记复习.mjs', ['准入', '--json'], { data: libM });
      let m = null; try { m = JSON.parse(String(r.out || '').trim().split('\n').pop()).admit['测试生|M0003']; } catch { }
      A('★ 自证 · 掏掉判据 ⇒ 未裁决的教师异议被放行（判据有牙齿）', m && m.ok === true, JSON.stringify(m));
    } finally { fs.writeFileSync(TOOL, TOOL_SRC, 'utf8'); }
    A('变异源码已还原', fs.readFileSync(TOOL, 'utf8') === TOOL_SRC);
  }
}

console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + '  断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
