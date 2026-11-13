#!/usr/bin/env node
/**
 * neg-source-edition-field.cjs —— 教辅版本字段 `srcBook` / `srcEdition`（2026-11-13 立，批次 4）
 *
 * 为什么要有这两个字段：同名教辅的**地区专版 / 印次**不同时，同一道题的答案可能不同
 * （"3×8 还是 8×3"那类争议，根子常在版本）。它是"答案对不上"时的**第一顺位排查字段**。
 *
 * 本用例**用真的校验器**（`_配方.mjs 校验`）做行为验证，而不是只断言"schema 里写了字段"：
 *   ① 不含新字段的卡**照样通过**（可选字段，老卡不受影响 —— 否则整库一夜变红）；
 *   ② 含合法 `srcBook` / `srcEdition` 的卡**通过**（新字段被接受）；
 *   ③ `srcBook` 类型写错（数字）**被拒且点名该字段**（证明它真被校验，不是写给人看的注释）。
 * 另守：不在 `required` 里 / 入库器三条路径（新卡、改卡、**幂等摘要**）都写 /
 * 配方版本与 changelog 首条一致 / 提示词有第 20 条 / 数据区规范登记了写入归属。
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
const INGEST = path.join(E.REPO, 'src', 'tools', '_录题入库.mjs');
const read = p => fs.readFileSync(path.join(E.REPO, p), 'utf8');

const BASE_CARD = {
  subject: '数学', title: '探测卡', questionText: '1+1=?', studentAnswer: '3',
  answerSource: '独立判卷', causeCode: 'K1', confidence: 'high',
  sourceImageSha256: '0'.repeat(64), teacherAnswer: '',
};

console.log('测试环境：' + E.describe());

function runValidate(cardExtra, { recipe = 'ingest-single' } = {}) {
  const dir = E.allocTempDir('gn-srcbook-');
  const f = path.join(dir, 'cards.json');
  const doc = { cards: [Object.assign({}, BASE_CARD, cardExtra)] };
  /* ⚠ `ingest-page`（整页录题）的 **root 级**必填与 single 不同：它要交代"这页一共几道题、
     标错几道、跳过了哪些"（`pageSummary` + `skipped`，后者 minItems:1）。
     首版漏了这个 ⇒ 那条断言红在"样本本身不合法"，与被测字段无关（典型的假红）。 */
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

console.log('\n══ ① 用真校验器跑三条（行为验证）══');
{
  const r1 = runValidate({});
  A('★ 不含新字段的卡**照样通过**（可选字段，老卡不受影响）', r1.code === 0,
    (r1.out.match(/[✔✖][^\n]*/) || [''])[0]);
  const r2 = runValidate({ srcBook: '人教版数学八年级上', srcEdition: '2025 秋 · 第 3 次印刷' });
  A('★ 含合法 srcBook / srcEdition 的卡**通过**（新字段被接受）', r2.code === 0,
    (r2.out.match(/[✔✖][^\n]*/) || [''])[0]);
  const r3 = runValidate({ srcBook: 123 });
  A('★★ srcBook 类型写错 ⇒ **被拒且点名该字段**（证明它真被校验）',
    r3.code !== 0 && /srcBook/.test(r3.out),
    (r3.out.match(/[^\n]*srcBook[^\n]*/) || [''])[0].slice(0, 110));
  const r4 = runValidate({ srcBook: '人教版数学八年级上' }, { recipe: 'ingest-page' });
  A('★ 另一个配方（整页录题）也接受该字段', r4.code === 0, (r4.out.match(/[✔✖][^\n]*/) || [''])[0]);
}

console.log('\n══ ② schema：声明了、且不在 required ══');
for (const id of ['ingest-single', 'ingest-page']) {
  const s = JSON.parse(fs.readFileSync(path.join(RECIPES, id, 'schema.json'), 'utf8'));
  const props = s.properties.cards.items.properties;
  const req = s.properties.cards.items.required || [];
  A(`  ${id}：srcBook / srcEdition 都在 properties 里`,
    !!props.srcBook && !!props.srcEdition, '');
  A(`  ${id}：**不在 required**（否则整库一夜变红）`,
    !req.includes('srcBook') && !req.includes('srcEdition'), 'required=' + req.length + ' 项');
}

console.log('\n══ ③ 入库器：三条路径都要写 ══');
{
  const src = fs.readFileSync(INGEST, 'utf8');
  A('★ 新卡路径写字段（索引条目构造里）',
    /srcBook: String\(c\.srcBook \|\| ''\)\.slice\(0, 120\)/.test(src), '');
  A('★ 改卡路径写字段（`it.srcBook = …`）', /if \(c\.srcBook !== undefined\) it\.srcBook =/.test(src), '');
  A('★★ 进**幂等摘要**（只改教辅版本再重提，必须被当成新内容，不许被幂等跳过）',
    /srcBook: c\.srcBook, srcEdition: c\.srcEdition,/.test(src), '');
  A('两个字段都做了长度截断（120）', (src.match(/slice\(0, 120\)/g) || []).length >= 2,
    (src.match(/slice\(0, 120\)/g) || []).length + ' 处');
}

console.log('\n══ ④ 配方版本与 changelog 一致（升版必须留痕）══');
for (const id of ['ingest-single', 'ingest-page']) {
  const m = JSON.parse(fs.readFileSync(path.join(RECIPES, id, 'meta.json'), 'utf8'));
  A(`  ${id}：顶层版本 == changelog 首条版本（${m.version}）`,
    m.version === (m.changelog[0] || {}).version, 'changelog[0]=' + ((m.changelog[0] || {}).version || '—'));
  A(`  ${id}：changelog 有一条记了这次的新字段`,
    (m.changelog || []).some(e => /srcBook|教辅名/.test(e.note || '')), '');
}

console.log('\n══ ⑤ 说法要落到人看得见的地方 ══');
A('base.md 有「教辅版本」条目（提示 AI 看得到就填、看不清留空、不许猜）',
  /教辅版本（`srcBook`/.test(read('src/recipes/_core/base.md')) && /不许猜/.test(read('src/recipes/_core/base.md')), '');
A('数据区规范登记了写入归属与"可选"（F3·补）',
  /F3·补/.test(read('docs/数据区规范.md')) && /第一顺位排查字段/.test(read('docs/数据区规范.md')), '');

console.log('\n══ ⑥ 阴性自证：schema 里删掉 srcBook ⇒ ② 的结构断言必须红 ══');
{
  const raw = read('src/recipes/ingest-single/schema.json');
  const mutated = raw.replace(/"srcBook":/, '"srcBookREMOVED":');
  A('变异点命中', mutated !== raw, '');
  const s = JSON.parse(mutated);
  A('★ 删掉后 properties 里就没有 srcBook 了（这条判据确实有牙齿）',
    !s.properties.cards.items.properties.srcBook, '');
}

console.log(`\n[neg-source-edition-field] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
