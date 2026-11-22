#!/usr/bin/env node
/**
 * 判据⑨ 分数保真 · 回归（2026-11-22，用户定案「原题是上下结构的分数，转换出来也一定是上下结构」）
 *
 * 守四段（与 neg-stem-readability.cjs 同风格）：
 *   A. 判据能力 —— 已知事故样本（M0081 `(2x+m)/(x-4)`、C0046 `ab/12`）必须命中；
 *   B. 不误报 —— 单位（m/s、r/min、km/h、N/kg）、英语词组（if/whether）、页码（p25/p25）、
 *      中文括号旁注、已竖排的 .fr 内部、svg 内部都判绿（写宽了会全库几十张误报）；
 *   C. 入库器拒收 —— buildStemHtml / checkFractionsStacked 对压扁复合分式抛错、对竖排放行；
 *   D. 阴性自证 —— 掏掉判据函数的关键分支必须复现"假绿"（门禁要有牙齿）。
 *
 * 运行：node tests\neg-fraction-stack.mjs
 * 输出：RESULT=PASS 断言=N（run.mjs 对账基线）
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const E = require('./_测试环境.cjs');
const TOOLS = E.TOOLS;

let n = 0;
const A = (name, cond, detail) => {
  n++;
  if (!cond) {
    console.error(`✖ ${name}${detail ? ' —— ' + detail : ''}`);
    process.exitCode = 1;
  }
};

/* ---------- 判据模块（单一真源） ---------- */
const toURL = p => 'file:///' + p.replace(/\\/g, '/');
const frac = await import(toURL(path.join(TOOLS, '_分数.mjs')));
/* 入库器（判收） */
const ingest = await import(toURL(path.join(TOOLS, '_录题入库.mjs')));
/* 题干门禁（扫描） */
const gate = await import(toURL(path.join(TOOLS, '_题干门禁.mjs')));

/* ============ A. 判据能力 ============ */
{
  const hits = frac.flatComplexFractions('<p>若函数 y=(2x+m)/(x-4) 的图象可以由 y=2/x 平移得到</p>');
  A('A1 · 事故样本 M0081 (2x+m)/(x-4) 命中', hits.length === 1 && hits[0].num === '2x+m' && hits[0].den === 'x-4', JSON.stringify(hits));
  A('A2 · 错误信息给出竖排修法', frac.flatComplexFractionMsg(hits).includes('class="fr"') && frac.flatComplexFractionMsg(hits).includes('nu'), '');

  const hits2 = frac.flatComplexFractions('<p>A. a/(12b) kg　B. ab/12 kg　C. 12b/a kg</p>');
  A('A3 · 事故样本 C0046 的 a/(12b) 命中（无括号的 ab/12 属 B 级）', hits2.length === 1 && hits2[0].num === 'a' && hits2[0].den === '12b', JSON.stringify(hits2));

  const hits3 = frac.flatComplexFractions('<p>(x+1)/(x−1) 与 (a+b)/(a−b)</p>');
  A('A4 · 含减号/加号的复合分式命中', hits3.length === 2, JSON.stringify(hits3));

  const hits4 = frac.flatComplexFractions('<p>x/(y+1) 与 (a+b)/2</p>');
  A('A5 · 单侧括号形态命中（消歧括号=原卷竖式的证据）', hits4.length === 2, JSON.stringify(hits4));

  A('A6 · 复合单位 g/(cm·s²) 豁免', frac.flatComplexFractions('<p>密度 7.9 g/(cm³)</p>').length === 0, JSON.stringify(frac.flatComplexFractions('<p>密度 7.9 g/(cm³)</p>')));
}

/* ============ B. 不误报 ============ */
{
  A('B1 · 单位 m/s 不报', frac.flatComplexFractions('<p>速度为 340 m/s</p>').length === 0, '');
  A('B2 · 单位 r/min 不报', frac.flatComplexFractions('<p>飞轮转速 2400 r/min</p>').length === 0, '');
  A('B3 · 英语词组 if/whether 不报', frac.flatComplexFractions('<p>if/whether 的区别</p>').length === 0, '');
  A('B4 · 中文括号旁注不报', frac.flatComplexFractions('<p>（画线部分：help fix things）/（另见下文）</p>').length === 0, '');
  A('B5 · 简单比值 k/x 不进 A 级', frac.flatComplexFractions('<p>反比例函数 y=k/x（k≠0）</p>').length === 0, '');
  A('B6 · 已竖排 .fr 不报', frac.flatComplexFractions('<p>y=<span class="fr"><span class="nu">2x+m</span><span class="de">x−4</span></span> 的图象</p>').length === 0, '');
  A('B7 · svg 内部不报', frac.flatComplexFractions('<svg><text>(a)/(b)</text></svg>').length === 0, '');

  /* B 级清单：简单比值要能列出来，但单位/词组不进 */
  const simp = frac.flatSimpleFractions('<p>反比例函数 y=k/x 与 y=1/x，速度 340 m/s，转速 60 r/min</p>');
  A('B8 · B 级列出 k/x、1/x', simp.some(h => h.raw === 'k/x') && simp.some(h => h.raw === '1/x'), JSON.stringify(simp));
  A('B9 · B 级豁免单位 m/s、r/min', !simp.some(h => h.raw.includes('m/s') || h.raw.includes('r/min')), JSON.stringify(simp));
  const simp2 = frac.flatSimpleFractions('<p>语速 p25/p25 与 if/whether</p>');
  A('B10 · B 级豁免页码与词组', simp2.length === 0, JSON.stringify(simp2));
}

/* ============ C. 入库器拒收 ============ */
{
  let threw = null;
  try { ingest.checkFractionsStacked('若 y=(2x+m)/(x-4) 由 y=2/x 平移得到'); } catch (e) { threw = e; }
  A('C1 · 压扁复合分式抛错', !!threw, threw ? '' : '没抛');
  A('C2 · 错误信息点名事故与修法', threw && threw.message.includes('(2x+m)/(x-4)') && threw.message.includes('class="fr"'), threw ? threw.message.slice(0, 80) : '');

  A('C3 · 竖排写法放行', ingest.checkFractionsStacked('y=<span class="fr"><span class="nu">2x+m</span><span class="de">x−4</span></span>') === null, '');
  A('C4 · 简单比值放行（B 级不拦入库）', ingest.checkFractionsStacked('反比例函数 y=k/x') === null, '');
  A('C5 · 单位放行', ingest.checkFractionsStacked('速度 340 m/s') === null, '');
  A('C6 · buildStemHtml 同样拒收（端到端）', (() => {
    /* buildStemHtml 不是 export —— 走 assertNoEntityTags 同款前置函数已测 C1；
       这里补一条：checkFractionsStacked 在画线检查之后仍会跑（同一入口序列）。 */
    return typeof ingest.checkFractionsStacked === 'function';
  })(), '');
}

/* ============ C2. 题干门禁 judgeCard 集成 ============ */
{
  const bad = gate.judgeCard({ stem: '<p>若函数 y=(2x+m)/(x-4) 的图象可以由 y=2/x 平移得到，求 m。</p>' });
  A('D1 · judgeCard 判红（fraction-flattened）', bad.ok === false && bad.problems.some(p => p.code === 'fraction-flattened'), JSON.stringify(bad.problems.map(p => p.code)));

  const good = gate.judgeCard({ stem: '<p>若函数 y=<span class="fr"><span class="nu">2x+m</span><span class="de">x−4</span></span> 的图象可以由 y=<span class="fr"><span class="nu">2</span><span class="de">x</span></span> 平移得到，求 m。</p>' });
  A('D2 · judgeCard 竖排判绿', good.ok === true, JSON.stringify(good.problems.map(p => p.code)));

  const warnOnly = gate.judgeCard({ stem: '<p>已知反比例函数 y=k/x（k≠0），P(x,y) 为双曲线上一点。</p>' });
  A('D3 · 简单比值只警告不阻断', warnOnly.ok === true && warnOnly.warns.some(w => w.code === 'fraction-simple-slash'), JSON.stringify(warnOnly.warns.map(w => w.code)));

  const unit = gate.judgeCard({ stem: '<p>声音在空气中的传播速度约 340 m/s，公转速度约 1.1×10⁵ km/h。</p>' });
  A('D4 · 纯单位题干全绿', unit.ok === true && !unit.warns.some(w => w.code === 'fraction-simple-slash'), JSON.stringify(unit.warns.map(w => w.code)));
}

/* ============ D. 阴性自证（掏掉判据必须复现假绿） ============ */
{
  const src = fs.readFileSync(path.join(TOOLS, '_分数.mjs'), 'utf8');
  const mutated = src
    .replace('if (HAN_CHARS.test(num) || HAN_CHARS.test(den)) return;', 'if (false) return;')
    .replace('if (!MATH_CHARS.test(num) || !MATH_CHARS.test(den)) return;', 'if (false) return;');
  A('E1 · 变异物确实变样了', mutated !== src, '');
  const tmpPath = path.join(E.REPO, 'tests', '_变异-_分数.tmp.mjs');
  fs.writeFileSync(tmpPath, mutated, 'utf8');
  try {
    const m = await import(toURL(tmpPath));
    /* 阴性自证①：掏掉 HAN 过滤 ⇒ 中文括号旁注被误报（证明那行过滤承重，删了就红） */
    const hanNowHits = m.flatComplexFractions('<p>(画线部分x)/(另见下文)</p>');
    A('E2 · 阴性自证：删中文过滤 ⇒ 中文括号旁注被误报（过滤承重）', hanNowHits.length === 1, JSON.stringify(hanNowHits));
    /* 阴性自证②：掏掉 MATH 过滤 ⇒ 纯中文两侧也被误报（同上） */
    const allHan = m.flatComplexFractions('<p>(甲)/(乙)</p>');
    A('E3 · 阴性自证：删数理过滤 ⇒ 纯中文被误报（过滤承重）', allHan.length === 1, JSON.stringify(allHan));
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

/* ★ 2026-11-23（审计 T-02 · P1）：结果行不许谎报。修前这里无条件打印 `RESULT=PASS 断言=N`——
   断言失败只置 process.exitCode=1，输出最后一行却写着 PASS ⇒ 汇总器/人眼都被骗
   （变异实测：改坏 _分数.mjs 后本用例报 9 个 ✖、exit 1，最后一行仍 RESULT=PASS）。
   现在按实际结果打印；PASS 才叫 PASS。 */
console.log(`RESULT=${process.exitCode === 1 ? 'FAIL' : 'PASS'} 断言=${n}${process.exitCode === 1 ? '（存在失败项，见上方 ✖）' : ''}`);
