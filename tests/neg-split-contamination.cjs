#!/usr/bin/env node
/**
 * 拾光小册 · 「拆卡串味」回归（2026-11-27 建）
 *
 * 用户报障（点卡到编号）：
 *   「M0067，在题干上特别写明：只收录第1小问，但实际上，你把第二小问也当成题目出给孩子了」
 *
 * 实测根因（与 2026-11-26 的 M0063 报障**同族、方向相反**）：
 *   · M0063：题干抄了**整道大题**（两问都在）⇒ 但答案只答了错的那一问
 *     ⇒ 答案册缺答案（家长判不了另一问）。
 *   · M0067：**同一道大题已经被拆成两张卡**（M0067=①、M0068=②），
 *     可 M0067 的题干**还留着第②小问的文字和它的横线空位**
 *     ⇒ 卷面上那道②变成了一道**也要做**的题，而答案册里 M0067 只有①的答案
 *     ⇒ 孩子重做时多做了一题，家长判不了那一问。
 *   · 根源一样：**「只收错的那一问」只写在配方里，没有机器判据**。
 *
 * 本用例守：
 *   M. 判据本体（单元）：串味/不串味/表格引用不算/纯文字条件不算 四档；
 *   L. 接线：作答门禁真的 import 了判据、真的当 problems；
 *   R. 真库：M0067 整改后不再被报，且**全库 0 张**串味；
 *   N. 阴性自证：把 M0067 的题干改回原样 ⇒ 判据必须报出来（证明它真的会红）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) fails++; };

let S = null;
(async () => {
  /* ⚠ 路径按 __dirname 推，不写死盘符（公开仓不许出现本机路径） */
  const modUrl = 'file:///' + path.join(ROOT, 'src', 'tools', '_拆卡串味.mjs').replace(/\\/g, '/');
  S = await import(modUrl);
})().then(runAll).catch(e => { console.error('✖ 装载失败：', e.message); process.exit(1); });

function runAll() {
  const { splitContamination, sourceTag, sourceBase, leakedMarks, blankCount } = S;

  console.log('── 判据本体（单元）──');

  /* M1：题干带别问的空位 ⇒ 串味 */
  const M0067_BAD = `<div class="stem">
  <p class="stem-lead">【题目要求】已知反比例函数y=<span class="fr"><span class="nu">−1</span><span class="de">x</span></span>。①当x&lt;−1时，写出y的取值范围<span class="blank" style="min-width:7em"></span>；②当y的值不小于2时，写出x的取值范围<span class="blank" style="min-width:7em"></span>。（卷面为横线填空，本卡只收第①小问）</p>
</div>`;
  const M0068_GOOD = `<div class="stem">
  <p class="stem-lead">【题目要求】已知反比例函数y=<span class="fr"><span class="nu">−1</span><span class="de">x</span></span>。②当y的值不小于2时，写出x的取值范围<span class="blank" style="min-width:7em"></span>。（卷面为横线填空）</p>
</div>`;
  const M0067_GOOD = `<div class="stem">
  <p class="stem-lead">【题目要求】已知反比例函数y=<span class="fr"><span class="nu">−1</span><span class="de">x</span></span>。①当x&lt;−1时，写出y的取值范围<span class="blank" style="min-width:7em"></span>。（卷面为横线填空，本卡只收第①小问）</p>
</div>`;

  const pair = (m67) => ([
    { id: 'M0067', source: '《第二章 反比例函数复习》 · 复习区第5题①', stemHtml: m67 },
    { id: 'M0068', source: '《第二章 反比例函数复习》 · 复习区第5题②', stemHtml: M0068_GOOD },
  ]);

  const bad = splitContamination(pair(M0067_BAD));
  A('M1 题干带别问的空位 ⇒ 报串味（且只报 M0067）',
    bad.length === 1 && bad[0].id === 'M0067' && bad[0].leaked.join('') === '②',
    JSON.stringify(bad));

  const good = splitContamination(pair(M0067_GOOD));
  A('M2 整改后（题干只留自己的那一问）⇒ 不报',
    good.length === 0, JSON.stringify(good));

  /* M3：表格里的编号引用不算（某张语文卡形态） */
  const TABLE = `<div class="stem">
  <p class="stem-lead">《月迹》根据文章内容，将空缺处补充完整：</p>
  <table class="stem-table"><tr><td>夜晚盼月</td><td>期待</td></tr>
  <tr><td>①（另卡）</td><td>高兴→失望</td></tr>
  <tr><td>天空见月</td><td>好奇→③（另卡）</td></tr>
  <tr><td>②<span class="blank" style="min-width:9em"></span></td><td>珍惜</td></tr></table>
</div>`;
  const t3 = splitContamination([
    { id: 'Y0010', source: '《那轮明月下》2026中秋专题练习 · (1)表格填空②', stemHtml: TABLE },
    { id: 'Y0011', source: '《那轮明月下》2026中秋专题练习 · (1)表格填空③', stemHtml: '<div class="stem"><p>x</p></div>' },
    { id: 'Y0012', source: '《那轮明月下》2026中秋专题练习 · (1)表格填空④', stemHtml: '<div class="stem"><p>y</p></div>' },
  ]);
  A('M3 表格里的编号引用（"③（另卡）"）⇒ 不算串味',
    t3.length === 0, JSON.stringify(t3));

  /* M4：只留别问的**文字**（当条件）、不留空位 ⇒ 不算（配方要求带上大题条件） */
  const TEXT_ONLY = `<div class="stem">
  <p class="stem-lead">【题目要求】已知反比例函数y=−1/x。①当x&lt;−1时，写出y的取值范围<span class="blank"></span>；②当y的值不小于2时，写出x的取值范围。</p>
</div>`;
  const t4 = splitContamination(pair(TEXT_ONLY));
  A('M4 只留别问的文字（当条件）、不留空位 ⇒ 不算串味',
    t4.length === 0, JSON.stringify(t4));

  /* M5：没标小问编号的卡（多问整题）⇒ 不参与判定 */
  const t5 = splitContamination([
    { id: 'M0063', source: '《期中复习》 · 第11题(2)', stemHtml: '<div class="stem"><p>(1) a；(2) b</p></div>' },
    { id: 'X0001', source: '某卷 · 第1题', stemHtml: '<div class="stem"><p>(1) a</p></div>' },
  ]);
  A('M5 标了小问编号但同组只有它自己 ⇒ 不报（没有"别人"可串）',
    t5.length === 0, JSON.stringify(t5));

  /* M6：source 的小问编号解析 */
  A('M6 source 尾标解析（①② 与 (2) 都认）',
    sourceTag('某卷 · 第5题①') === '①' && sourceTag('某卷 · 解答20(2)') === '(2)' && sourceTag('某卷 · 第5题') === null,
    [sourceTag('某卷 · 第5题①'), sourceTag('某卷 · 解答20(2)'), sourceTag('某卷 · 第5题')].join(' / '));
  A('M7 同一道大题的前缀一致',
    sourceBase('某卷 · 第5题①') === sourceBase('某卷 · 第5题②'),
    sourceBase('某卷 · 第5题①'));

  console.log('\n── 接线 ──');
  const gateSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_作答门禁.mjs'), 'utf8');
  A('L1 作答门禁 import 了 _拆卡串味.mjs',
    /import\s*\{[^}]*splitContamination[^}]*\}\s*from\s*'\.\/_拆卡串味\.mjs'/.test(gateSrc));
  A('L2 作答门禁把串味当 problems（阻断级）',
    /code:\s*'split-contamination'/.test(gateSrc));

  const recipes = ['ingest-page', 'ingest-single', 'ingest-independent', 'ingest-auto'];
  const missRecipe = recipes.filter(r => {
    const p = path.join(ROOT, 'src', 'recipes', r, 'prompt.md');
    if (!fs.existsSync(p)) return true;
    return !fs.readFileSync(p, 'utf8').includes('split-contamination');
  });
  A('L3 四个录题配方都写了「拆卡不许带别问的空位」这条规则',
    missRecipe.length === 0, missRecipe.length ? '缺：' + missRecipe.join(',') : '全有');

  console.log('\n── 真库 ──');
  const E = require('./_测试环境.cjs');
  const cards = S.readCardsOfLibrary(E.LIB);
  const realBad = splitContamination(cards);
  A('R1 全库 0 张串味（用户点名的 M0067 已整改）',
    realBad.length === 0, realBad.slice(0, 3).map(b => `${b.id}[${b.own}]漏${b.leaked.join('')}`).join(' | '));

  /* R2：用户点名的 M0067 本身 —— 题干里不再有第②小问的空位 */
  const m0067 = cards.find(c => c.id === 'M0067');
  if (m0067) {
    A('R2 M0067 的题干里没有第②小问的空位（只留①那一问）',
      !/②[\s\S]{0,120}(?:<span class="[^"]*\bblank\b|_{2,}|＿{2,})/.test(m0067.stemHtml),
      (m0067.stemHtml || '').replace(/\s+/g, ' ').slice(0, 160));
    A('R3 M0067 的题干里仍有第①小问的空位（这一问还是能做的）',
      /①[\s\S]{0,120}(?:<span class="[^"]*\bblank\b|_{2,}|＿{2,})/.test(m0067.stemHtml));
  } else {
    A('R2 找到用户点名的 M0067', false, '真库里没找到 M0067');
  }

  console.log('\n── 阴性自证：判据必须真的会红 ──');
  /* N1：把 M0067 的题干改回"带②的空位"的原样 ⇒ 必须报出来 */
  const mutated = splitContamination([
    { id: 'M0067', source: '《第二章 反比例函数复习》 · 复习区第5题①', stemHtml: M0067_BAD },
    { id: 'M0068', source: '《第二章 反比例函数复习》 · 复习区第5题②', stemHtml: M0068_GOOD },
  ]);
  A('N1 把 M0067 的题干改回原样 ⇒ 判据报出串味（证明真库那条 0 命中不是因为判据失灵）',
    mutated.length === 1 && mutated[0].id === 'M0067', JSON.stringify(mutated));

  /* N2：变异 leakedMarks 的实现（去掉"只看空位"的限定）⇒ 表格引用会被误报 */
  const leakedAll = (html, otherTags) => {
    const out = [];
    const re = /([①②③④⑤⑥⑦⑧⑨⑩]|\(\s*\d\s*\))/g;
    let m;
    while ((m = re.exec(String(html || ''))) !== null) {
      const tag = m[1].startsWith('(') ? '(' + m[1].replace(/[()\s]/g, '') + ')' : m[1];
      if (otherTags.includes(tag) && !out.includes(tag)) out.push(tag);
    }
    return out;
  };
  const loose = leakedAll(TABLE, ['③', '④']);
  A('N2 「只看空位」这个限定是必需的：去掉它就会把表格里的引用误判成串味',
    loose.length > 0 && leakedMarks(TABLE, ['③', '④']).length === 0,
    '宽松版命中 ' + loose.length + ' / 严版命中 ' + leakedMarks(TABLE, ['③', '④']).length);

  console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${total} 失败=${fails}`);
  process.exit(fails ? 1 : 0);
}
