#!/usr/bin/env node
/**
 * neg-grader-by.cjs —— 「谁判的」记进复习流水（2026-11-13 立，批次 3 · UX-10 独立项）
 *
 * 为什么要有这一维：**孩子模式下自评**时，界面若暗示"判对就能少做"，就会诱导
 * **挑好判的判对**（与 UX-11"孩子模式不显示下次间隔"同源）。记下"谁判的"之后，
 * 家长一眼能看出哪些记录是自评、自评的正确率是否异常偏高 —— 这是**数据自证**，
 * 不是"我觉得你在放水"（判据摆在桌上，比互相猜好谈得多）。
 *
 * 本用例**真跑工具**（临时库上的 组卷→批改），守：
 *   ① `--by 孩子` ⇒ 流水里 `by === '孩子'`；`--by 家长` 同理；
 *   ② 同一批次重复回录 ⇒ 按最后一次修正（**不双计**），`by` 也跟着改；
 *   ③ 非法值（如 `老师`）**拒收**（自由文本进来这一维就统计不了）；
 *   ④ 省略 ⇒ `by === ''`（未记，不是编造一个）。
 * 另守链路三处：壳透明转发 `--by`、前端按孩子模式派生、复习流水里显示"谁判"。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

const LIB = E.makeTempLib(null, { copyCardFiles: true });
const lib = (...p) => path.join(LIB, ...p);
const run = (a) => execFileSync(process.execPath, [E.tool('_标记复习.mjs'), ...a],
  { encoding: 'utf8', maxBuffer: 64e6, env: Object.assign({}, process.env, { CTB_DATA: LIB }) });
/** 跑一条**可能失败**的命令，不抛异常（用于断言"必须拒收"） */
function runSoft(a) {
  try {
    const out = execFileSync(process.execPath, [E.tool('_标记复习.mjs'), ...a],
      { encoding: 'utf8', maxBuffer: 64e6, env: Object.assign({}, process.env, { CTB_DATA: LIB }), stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: String(out) };
  } catch (e) { return { code: e.status == null ? 1 : e.status, out: String((e.stdout || '') + (e.stderr || '')) }; }
}

console.log('测试环境：' + E.describe());

/* ---------- 找两张可组卷的卡 ---------- */
const idxFiles = E.findIndexes(LIB);
const mathIdx = idxFiles.map(f => ({ f, j: JSON.parse(fs.readFileSync(lib(f), 'utf8')) }))
  .find(x => x.j.subjects && x.j.subjects['数学'] && (x.j.subjects['数学'].items || []).length >= 2);
if (!mathIdx) { console.log('临时库里找不到含 ≥2 张数学卡的索引 —— 无法对照'); process.exit(1); }
const STU = mathIdx.j.student;
const IDX_REL = mathIdx.f;
const pool = [];
for (const [sn, v] of Object.entries(mathIdx.j.subjects)) for (const it of (v.items || [])) pool.push({ sn, id: it.id, src: it.answerSource || '', blind: it.blindStatus });
const okCards = pool.filter(x => ['已通过', '已修正'].includes(x.blind) && /^独立判卷|^老师定案|^官方答案/.test(x.src) && x.sn === '数学').slice(0, 2);
A('找到用于对照的可组卷卡', okCards.length === 2, okCards.map(x => x.id).join(','));

const readIdx = () => JSON.parse(fs.readFileSync(lib(IDX_REL), 'utf8'));
const reviewOf = (id, paper) => {
  const j = readIdx();
  for (const v of Object.values(j.subjects || {})) {
    for (const it of (v.items || [])) if (String(it.id) === id) return (it.reviews || []).filter(r => r.paper === paper)[0];
  }
  return null;
};

/* ---------- 组一张卷 ---------- */
const paper = (() => {
  const out = run(['组卷', '--student', STU, '--subject', '数学', '--ids', okCards.map(x => x.id).join(','), '--title', '谁判的对照']);
  const m = String(out).match(/P\d{8}-\d+/);
  return m ? m[0] : null;
})();
A('组卷成功（拿到批次号）', !!paper, paper || '组卷输出里没有批次号');

if (!paper) { console.log(`\n[neg-grader-by] 失败=${fails + 1}`); process.exit(1); }
const C1 = okCards[0].id, C2 = okCards[1].id;

console.log('\n══ ① --by 落进复习流水 ══');
run(['批改', '--paper', paper, '--results', `${C1}=对,${C2}=错`, '--date', '2026-11-13', '--by', '孩子']);
{
  const r = reviewOf(C1, paper);
  A('★ 批改 --by 孩子 ⇒ 流水里 by === "孩子"', r && r.by === '孩子', r ? JSON.stringify(r) : '找不到该条流水');
  A('两条记录都带上了', (() => { const b = reviewOf(C2, paper); return b && b.by === '孩子'; })(), '');
}

console.log('\n══ ② 同一批次重复回录 ⇒ 按最后一次修正（不双计），by 跟着改 ══');
run(['批改', '--paper', paper, '--results', `${C1}=半对,${C2}=错`, '--date', '2026-11-13', '--by', '家长']);
{
  const r = reviewOf(C1, paper);
  const cnt = (() => {
    const j = readIdx();
    for (const v of Object.values(j.subjects || {})) for (const it of (v.items || [])) {
      if (String(it.id) === C1) return (it.reviews || []).filter(x => x.paper === paper).length;
    }
    return -1;
  })();
  A('★ 该批次仍只有一条流水（不双计）', cnt === 1, '条数=' + cnt);
  A('★ by 改为最后一次的「家长」', r && r.by === '家长', r ? r.by : '找不到');
  A('结果也按最后一次修正（半对）', r && r.result === '半对', r ? r.result : '');
}

console.log('\n══ ③ 非法值拒收（自由文本进来这一维就统计不了）══');
{
  const bad = runSoft(['批改', '--paper', paper, '--results', `${C1}=对`, '--date', '2026-11-13', '--by', '老师']);
  A('★ --by 老师 ⇒ 非 0 退出', bad.code !== 0, 'code=' + bad.code);
  A('★ 错误信息点名 --by 与允许值', /--by/.test(bad.out) && /家长/.test(bad.out) && /孩子/.test(bad.out),
    (bad.out.match(/[^\n]*--by[^\n]*/) || [''])[0].slice(0, 120));
  const r = reviewOf(C1, paper);
  A('★ 拒收时**没有**写坏已有记录（by 仍是上一次的「家长」）', r && r.by === '家长', r ? r.by : '');
}

console.log('\n══ ④ 省略 ⇒ 空串（未记，不是编造一个）══');
run(['批改', '--paper', paper, '--results', `${C1}=对`, '--date', '2026-11-13']);
{
  const r = reviewOf(C1, paper);
  A('★ 不给 --by ⇒ by === ""', r && r.by === '', r ? JSON.stringify(r.by) : '找不到');
}

console.log('\n══ ⑤ 链路三处：壳转发 / 前端派生 / 流水显示 ══');
{
  const cs = fs.readFileSync(path.join(E.REPO, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
  const model = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'model.js'), 'utf8');
  const review = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'review.js'), 'utf8');
  const tool = fs.readFileSync(E.tool('_标记复习.mjs'), 'utf8');
  A('★ 壳透明转发 --by（白名单在工具侧校验）', /AddFlag\(args, payload, "by", "--by"\)/.test(cs), '');
  /* ★ 2026-11-13 修（本用例是我自己写的，判据写脆了）：原先要求**字面串**
     `CTB.shell.kidMode() ? '孩子' : '家长'`。而实现后来为了**防御**改成了
       `(CTB && CTB.shell && typeof CTB.shell.kidMode === 'function' && CTB.shell.kidMode()) ? '孩子' : '家长'`
     —— 那个前置判断是必要的：Node 侧直接 require `model.js` 时 `CTB.shell` 可能是 undefined
     （`neg-v2-smoke.cjs` 实测 `TypeError: Cannot read properties of undefined (reading 'kidMode')`）。
     ⇒ 字面串不再出现，这条断言**假红**（而它守的口径其实没坏）。
     改成匹配**语义**：同一个三元里出现 `kidMode()` 与 `'孩子' / '家长'` 两支。
     既守住"孩子 ⇒ 自评、否则家长"，又不把实现钉死成某一种写法。 */
  A('★ 前端按孩子模式派生（孩子 ⇒ 自评，否则家长）',
    /kidMode\(\)\s*\)?\s*\?\s*'孩子'\s*:\s*'家长'/.test(model),
    (model.match(/[^\n]*kidMode\(\)[^\n]*/) || ['(源码里没有 kidMode 调用)'])[0].trim().slice(0, 140));
  A('★ 复习流水里显示「谁判」', /r\.by \? '<span class="muted rv-by"/.test(review) || /\.by \? .*rv-by/.test(review), '');
  A('★ 工具侧白名单含四值（家长/孩子/AI辅助/空）',
    /GRADERS = \['家长', '孩子', 'AI辅助', ''\]/.test(tool), '');
  A('★ 校验发生在写盘之前（byOf 在 merged 构造时调用，writeJson 在其后）',
    tool.indexOf('by: byOf(by)') < tool.indexOf('writeJson(LEDGER, ledger)'), '');
}

console.log('\n══ ⑥ 阴性自证：把写入掏掉 ⇒ ① 必须红 ══');
{
  const tool = fs.readFileSync(E.tool('_标记复习.mjs'), 'utf8');
  /* ★ 2026-11-14（批次 4-1 revlog）：actGrading 判分行现在还有 revlog 的 by 落行（revlogAppend
     里 `by: byOf(by)`），所以变异后源码里仍可能有一处匹配 —— 断言改为**变异点所在的那一行**
     不再含 byOf（流水写入点被掏掉），而不是全文无匹配。 */
  const broken = tool.replace('note: note || \'\', by: byOf(by) }', 'note: note || \'\' }');
  A('变异点命中', broken !== tool, '');
  const mutatedLine = broken.split('\n').find(l => l.includes('note: note') && l.includes('paper: paperId'));
  A('★ 掏掉后判分流水行里没有 by（这条判据确实有牙齿）',
    mutatedLine ? !/by: byOf\(by\)/.test(mutatedLine) : !/concat\(\[\{ date: day, paper: paperId, result: res, note: note \|\| '' \}\]\)/.test(broken),
    mutatedLine ? mutatedLine.trim().slice(0, 80) : '判分行整体替换形态');
}

/* ⚠ 必须报 `断言=N`：`tests\run.mjs` 的断言数对账把"没报断言数的用例"计入**未申报** ⇒ 直接判红
   （2026-11-12 审计 T-01 加的判据；本用例首版就踩了这个坑）。格式与其它用例一致。 */
console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}  断言=${total}  通过=${total - fails}  失败=${fails}`);
process.exit(fails ? 1 : 0);
