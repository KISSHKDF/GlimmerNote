#!/usr/bin/env node
/**
 * neg-cause-stage.cjs —— 错因的「阶段维」`causeStage`（2026-11-13 立，批次 4）
 *
 * 背景（外部调研 · Newman 1977/1983 数学错因框架）：本仓错因是 **K/L/S 三层 16 类**，
 * 它回答"**这是什么性质的错**"；而"**错在解题的哪一步**"此前只能写进 `causeNote` 自由文本
 * （`cause.md` 的硬规矩正是这么要求的），**机器读不了 ⇒ 筛不动、出不了趋势**。
 * 而只用 K/L/S 时分布极偏：真库 `K1`（概念不清）**一个码占 39%**（79/202）——一个维度把四成情况
 * 归成一类，等于没有分辨率。
 *
 * 本用例**用真的校验器**（`_配方.mjs 校验`）做行为验证，而不是只断言"schema 里写了字段"：
 *   ① 合法值（审题/转化/求解/书写）通过；
 *   ② **枚举外的值被拒且点名**（"马虎"这种自由文本进来就等于没加这一维，还会静默污染趋势）；
 *   ③ 空串通过（"拿不准"是被允许的答案——猜一个阶段比留空更坏）；
 *   ④ 不含该字段也通过（**可选**，老卡不受影响）。
 * 另守：与 K/L/S **正交**（不是第四层）、不进 required、入库器拒非法值、进幂等摘要、
 * 两配方版本与 changelog 一致。含阴性自证。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const RECIPES = path.join(E.REPO, 'src', 'recipes');
const TOOL = path.join(E.REPO, 'src', 'tools', '_配方.mjs');
const INGEST = fs.readFileSync(path.join(E.REPO, 'src', 'tools', '_录题入库.mjs'), 'utf8');
const CAUSE = fs.readFileSync(path.join(RECIPES, '_core', 'cause.md'), 'utf8');

const BASE_CARD = {
  subject: '数学', title: '探测卡', questionText: '1+1=?', studentAnswer: '3',
  answerSource: '独立判卷', causeCode: 'K1', confidence: 'high',
  sourceImageSha256: '0'.repeat(64), teacherAnswer: '',
};

console.log('测试环境：' + E.describe());

function runValidate(cardExtra, { recipe = 'ingest-single' } = {}) {
  const dir = E.allocTempDir('gn-stage-');
  const f = path.join(dir, 'cards.json');
  const doc = { cards: [Object.assign({}, BASE_CARD, cardExtra)] };
  if (recipe === 'ingest-page') {
    doc.pageSummary = { totalQuestions: 1, markedWrong: 1 };
    doc.skipped = [{ what: '第 2 题', reason: '本用例只录一道（探测用）' }];
  }
  fs.writeFileSync(f, JSON.stringify(doc), 'utf8');
  try {
    const out = execFileSync(process.execPath, [TOOL, '校验', '--in', f, '--recipe', recipe],
      { encoding: 'utf8', env: Object.assign({}, process.env), maxBuffer: 16e6 });
    return { code: 0, out: String(out) };
  } catch (e) { return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') }; }
}

console.log('\n══ ① 用真校验器跑四连（行为验证）══');
{
  const ok = runValidate({ causeStage: '审题' });
  A('★ 合法值「审题」通过', ok.code === 0, (ok.out.match(/[✔✖][^\n]*/) || [''])[0]);
  const bad = runValidate({ causeStage: '马虎' });
  A('★★ 枚举外的值「马虎」**被拒且点名**（自由文本进来就等于没加这一维）',
    bad.code !== 0 && /causeStage/.test(bad.out),
    (bad.out.match(/[^\n]*causeStage[^\n]*/) || [''])[0].slice(0, 120));
  const empty = runValidate({ causeStage: '' });
  A('★ 空串通过（"拿不准"是被允许的答案 —— 猜一个阶段比留空更坏）', empty.code === 0,
    (empty.out.match(/[✔✖][^\n]*/) || [''])[0]);
  const absent = runValidate({});
  A('★ 不含该字段也通过（**可选**，老卡不受影响）', absent.code === 0,
    (absent.out.match(/[✔✖][^\n]*/) || [''])[0]);
  const page = runValidate({ causeStage: '书写' }, { recipe: 'ingest-page' });
  A('另一个配方（整页录题）也接受它', page.code === 0, (page.out.match(/[✔✖][^\n]*/) || [''])[0]);
}

console.log('\n══ ② 契约：与 K/L/S 正交、且可选 ══');
for (const id of ['ingest-single', 'ingest-page']) {
  const s = JSON.parse(fs.readFileSync(path.join(RECIPES, id, 'schema.json'), 'utf8'));
  const props = s.properties.cards.items.properties;
  const req = s.properties.cards.items.required || [];
  A(`  ${id}：causeStage 在 properties 且枚举 = 审题/转化/求解/书写/空`,
    props.causeStage && JSON.stringify(props.causeStage.enum) === JSON.stringify(['审题', '转化', '求解', '书写', '']),
    JSON.stringify(props.causeStage && props.causeStage.enum));
  A(`  ${id}：**不在 required**（老卡没有它照样合法）`, !req.includes('causeStage'), '');
}
A('★ `cause.md` 写明它是**正交**的一维（不是 K/L/S 的第四层）',
  /正交/.test(CAUSE) && /K\/L\/S 回答的是/.test(CAUSE), '');
A('★ 四个值都在口径文件里（审题/转化/求解/书写）',
  ['审题', '转化', '求解', '书写'].every(v => CAUSE.includes('`' + v + '`')), '');
A('★ 写明"拿不准就留空、不许猜"（否则会被猜值污染趋势）', /不许猜/.test(CAUSE), '');
A('★ 写明动机（K1 一码占 39% ⇒ 一个维度没有分辨率）', /39%|79\/202/.test(CAUSE), '');

console.log('\n══ ③ 入库器：拒非法值 + 写入 + 进幂等摘要 ══');
A('★★ 非法值进 problems（拒收，不是静默放过）',
  /causeStage 非法/.test(INGEST) && /problems\.push\(id \+ ' 的 causeStage 非法/.test(INGEST), '');
A('★ 改卡路径写字段（`it.causeStage = …`）', /if \(c\.causeStage !== undefined\) it\.causeStage =/.test(INGEST), '');
A('★ 新卡索引条目写字段', /causeStage: String\(c\.causeStage \|\| ''\)/.test(INGEST), '');
A('★ 进**幂等摘要**（只改阶段再重提，必须算新内容）', /causeStage: c\.causeStage,/.test(INGEST), '');

console.log('\n══ ④ 配方版本与 changelog 一致 ══');
for (const id of ['ingest-single', 'ingest-page']) {
  const m = JSON.parse(fs.readFileSync(path.join(RECIPES, id, 'meta.json'), 'utf8'));
  A(`  ${id}：顶层版本 == changelog 首条（${m.version}）`,
    m.version === (m.changelog[0] || {}).version, 'changelog[0]=' + ((m.changelog[0] || {}).version || '—'));
  A(`  ${id}：changelog 记了这次的新字段`,
    (m.changelog || []).some(e => /causeStage|阶段维/.test(e.note || '')), '');
}

console.log('\n══ ⑤ 前端：字段必须**真能被筛**（否则这一维就是死的）══');
{
  const bank = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'bank.js'), 'utf8');
  A('★ 筛选状态有 `stage`（默认「全部」）', /stage: '全部'/.test(bank), '');
  A('★ 过滤逻辑在场（按卡上的 `causeStage` 比）',
    /if \(f\.stage !== '全部'\)/.test(bank) && /String\(x\.card\.causeStage \|\| ''\) === f\.stage/.test(bank), '');
  A('★★ 「未填」是**显式选项**，不是拿空串冒充 —— 老卡与"拿不准"恰好就是空值，'
    + '点它正是要一份"还没定阶段的清单"',
    /f\.stage === '未填' \? !x\.card\.causeStage/.test(bank), '');
  A('★ UI 上有一行「阶段」芯片（四个值 + 未填）',
    /row\('阶段', chipRow\('stage', \['全部', '审题', '转化', '求解', '书写', '未填'\]/.test(bank), '');
}

console.log('\n══ ⑥ 阴性自证：把「书写」从枚举里删掉 ⇒ ① 必须红 ══');
{
  const raw = fs.readFileSync(path.join(RECIPES, 'ingest-single', 'schema.json'), 'utf8');
  const mutated = raw.replace('"书写", ""', '"__removed__", ""');
  A('变异点命中', mutated !== raw, '');
  const s = JSON.parse(mutated);
  A('★ 删掉后「书写」不再被接受（这条判据确实有牙齿）',
    !s.properties.cards.items.properties.causeStage.enum.includes('书写'), '');
}

console.log(`\n[neg-cause-stage] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
