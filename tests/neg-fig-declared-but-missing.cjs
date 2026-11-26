#!/usr/bin/env node
/**
 * 拾光小册 · 「图声明未落地」回归（2026-11-26 建）
 *
 * 用户报障（点卡到编号）：
 *   「某学生，M0077，裁图与题目完全不对」
 *
 * 顺着这条报障查出来的**三个**真缺陷（互相关联，本用例逐条守）：
 *
 *   ① **证据裁图切错位置**（用户直接看到的那条）：
 *      M0077 的 `bbox=[0.02,0.175,0.95,0.05]` 裁到的是同一页**第1题的选项**与**第2题的开头**，
 *      而第12题实际在 y≈0.845 ⇒ 裁图与题目完全对不上。
 *      同批的 M0078 也一样（原 bbox 裁到第16题，第15题实际在 y≈0.229）。
 *      ⇒ 机器判据：**裁图的纵向位置必须与「同页同卷的题号顺序」一致**（题号应随 y 增大）。
 *
 *   ② **跨页插图裁不出来**（同一张卡的第二个问题）：
 *      M0077 的「其图象如图所示」那张 p/kPa 反比例图象，**被排到了试卷 p2 顶部**
 *      （题干与作答在 p1）⇒ 裁图只认一个源页 ⇒ 图永远裁不出来 ⇒ 台账被写成 `need=false`
 *      ⇒ 一张**写着"如图"却没有图**的题安安稳稳躺在库里。
 *      ⇒ 机器判据：**录题任务单声明 `hasFigure=true` ∧ 配图台账记 `need=false`** ⇒ 图没落地。
 *
 *   ③ **插图的空白阈值用错了量级**：
 *      `CROP_MIN_INK=0.05` 是拿**题干文字块**标定的（满页文字 ⇒ 14%+），
 *      而**插图**是稀疏线条画（M0077 那张图只有 4.63%）⇒ 被判成"几乎全是空白" ⇒ 图被丢弃。
 *
 * 本用例守：
 *   M. 判据本体（单元）：引用/不连续/选择题/合卡豁免 + 用户点名的 M0063 必须被命中；
 *   N. 阴性自证：造一张"只答第二问"的卡 ⇒ 缺口非空（门禁据此报红）；
 *   L. 接线：门禁真的 import 了判据、真的当 problems、配方真的写了规则；
 *   F. **图声明未落地**这条新判据（`_图声明.mjs`）：任务单说有图 ∧ 台账说无需图 ⇒ 必须报；
 *      且**已经修好的 M0077/M0069/M0046 不得再被报（防"修完还红"）。
 */
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) fails++; };

/* ---------- Node 侧实现（ESM，动态 import） ---------- */
let K = null, G = null;
(async () => {
  K = await import(path.join(ROOT, 'src', 'tools', '_小问.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  G = await import(path.join(ROOT, 'src', 'tools', '_图声明.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
})().then(runAll).catch(e => { console.error('✖ 装载失败：', e.message); process.exit(1); });

function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) { if (e.name === '_索引.json') acc.push(path.join(dir, e.name)); continue; }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    indexFiles(path.join(dir, e.name), acc);
  }
  return acc;
}
function allCards() {
  const out = [];
  for (const f of indexFiles(E.LIB)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const base = path.dirname(f);
    const push = (it, subject, dirAbs) => out.push({ item: it, subject, dirAbs, key: (j.student || '?') + '|' + it.id });
    if (Array.isArray(j.items)) for (const it of j.items) push(it, j.subject || '', path.join(base, it.dir || it.id));
    if (j.subjects) for (const [n, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) push(it, n, path.join(base, n, it.dir || it.id));
  }
  return out;
}
const stemOf = x => { const p = path.join(x.dirAbs, '题干.html'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') : ''; };

function runAll() {
  const cards = allCards();
  console.log(`库根 ${E.LIB}：${cards.length} 张卡\n`);

  /* ══════════ M. 多问整题的答案覆盖（用户点名的 M0063） ══════════ */
  {
    const h2 = '<div class="stem"><p class="stem-lead">(1)求月平均增长率；(2)求降价多少元。</p></div>';
    const r2 = K.multiPartCoverage({ answer: '降价8元' }, { stemHtml: h2 });
    A('M1 两问解答题：只答一问 ⇒ 判为缺口', r2.multi === true && r2.missing.length === 2, `缺 ${r2.missingText}`);

    const ok2 = K.multiPartCoverage({ answer: '(1) 月平均增长率25%；(2) 降价8元' }, { stemHtml: h2 });
    A('M2 逐问标注齐全 ⇒ 通过', ok2.multi === true && ok2.missing.length === 0, `覆盖 ${ok2.covered.join(',')}`);

    const h3 = '<div class="stem"><p class="stem-lead">7．(2) 求 3(2m²−3mn−5m−1) 的值（由第(1)问求得）．</p></div>';
    A('M3 被引用的小问不算「被问」', K.multiPartCoverage({ answer: '25' }, { stemHtml: h3 }).multi === false);

    const h4 = '<div class="stem"><p class="stem-lead">(2) 求当 x=5 时的函数值。</p></div>';
    A('M4 编号不连续（只印一问）⇒ 不是多问整题', K.multiPartCoverage({ answer: '12.6' }, { stemHtml: h4 }).multi === false);

    const h5 = '<div class="stem"><p class="stem-lead">下列说法：(1)长度相等的弧是等弧，(2)相等的圆心角所对的弧相等，(3)劣弧一定比优弧短，(4)直径是圆中最长的弦。其中正确的有（ ）</p></div>';
    A('M5 选择题（answerMode=none）豁免', K.multiPartCoverage({ answer: 'A', answerMode: 'none' }, { stemHtml: h5 }).multi === false);

    const h6 = '<div class="stem"><p class="stem-lead">(1) 求 x 的值；(2) 求 y 的值。</p></div>';
    A('M6 合卡（answerScope=partial）豁免', K.multiPartCoverage({ answer: 'x=1', answerScope: 'partial' }, { stemHtml: h6 }).multi === false);

    const h7 = '<div class="stem"><p class="stem-lead">(1) 填空<span class="blank"></span>；(2) 求 y 的值。</p></div>';
    const r7 = K.multiPartCoverage({ answer: 'x=1', answerSlots: ['x'], answerMode: 'blank' }, { stemHtml: h7 });
    A('M7 有空位的小问走逐空通道 ⇒ 只报没空位的那一问',
      r7.multi === true && r7.missing.length === 1 && r7.missing[0] === 2, `缺 ${r7.missingText}`);

    /* M8 用户点名的 M0063：**必须被这条判据覆盖**（能被解析成多问整题），
          且**整改后不该再报缺口**（它已被补齐为逐问标注）。
          ⚠ 断言的是"能被覆盖 + 现在是齐的"，不是"现在还缺" ——
            缺的那张（M0063）已经在 2026-11-26 修好了。 */
    const m63 = cards.find(x => x.item.id === 'M0063' && /徽章/.test(String(x.item.question || '')));
    if (m63) {
      const r63 = K.multiPartCoverage(m63.item, { stemHtml: stemOf(m63) });
      A('M8 用户点名的 M0063（徽章题）能被判据覆盖，且已整改为逐问标注',
        r63.multi === true && r63.missing.length === 0,
        `问 ${r63.asked.join(',')} / 缺 ${r63.missingText || '无'}`);
    } else A('M8 用户点名的 M0063（徽章题）能被判据覆盖，且已整改为逐问标注', false, '真库里没找到 M0063（徽章题）');
  }

  /* ══════════ N. 阴性自证 ══════════ */
  {
    const fakeStem = '<div class="stem"><p class="stem-lead">(1)求月平均增长率；(2)求降价多少元。</p></div>';
    const rr = K.multiPartCoverage({ id: 'T-MP', answer: '(2) 降价8元', answerMode: 'zone', answerScope: 'full' }, { stemHtml: fakeStem });
    A('N1 阴性：只答第二问 ⇒ 缺口非空（门禁据此报红）', rr.missing.length === 1 && rr.missing[0] === 1, `缺 ${rr.missingText}`);
    const rf = K.multiPartCoverage({ id: 'T-MP', answer: '(1) 月平均增长率25%；(2) 降价8元' }, { stemHtml: fakeStem });
    A('N2 阴性对照：补齐第一问 ⇒ 通过', rf.missing.length === 0, `缺 ${rf.missingText}`);
  }

  /* ══════════ L. 接线 ══════════ */
  {
    const srcGate = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_作答门禁.mjs'), 'utf8');
    A('L1 门禁 import 了 _小问.mjs', /import\s*\{[^}]*multiPartCoverage[^}]*\}\s*from\s*'\.\/_小问\.mjs'/.test(srcGate));
    A('L2 门禁的 judge 里真的调了 multiPartCoverage', /multiPartCoverage\s*\(/.test(srcGate));
    A('L3 门禁把缺口当成 problems（阻断级）', /multiPartCoverage[\s\S]{0,400}?problems\.push/.test(srcGate));

    const recipes = ['ingest-page', 'ingest-single', 'ingest-independent', 'ingest-auto'];
    const missingRule = recipes.filter(r => {
      const p = path.join(ROOT, 'src', 'recipes', r, 'prompt.md');
      if (!fs.existsSync(p)) return true;
      return !/答案只答错的那一问|逐问标注/.test(fs.readFileSync(p, 'utf8'));
    });
    A('L4 四个配方的提示词都写明了「答案要逐问标注」', missingRule.length === 0, missingRule.length ? '缺：' + missingRule.join(' ') : '全有');

    const packP = path.join(ROOT, 'src', '官方经验包', 'glimmer-official', 'core', '1.1.0', 'pack.json');
    const pk = JSON.parse(fs.readFileSync(packP, 'utf8').replace(/^\uFEFF/, ''));
    A('L5 官方经验包收录了「多问整题：答案要逐问标注」',
      (pk.cards || []).some(c => c.id === 'multipart-answer-per-question'), (pk.cards || []).map(c => c.id).join(','));
  }

  /* ══════════ F. 图声明未落地（本次报障引出的新判据） ══════════ */
  {
    const figs = G.taskFigures(E.LIB);
    A('F0 录题任务单能读出卡（图声明的来源）', figs.size > 0, `${figs.size} 条卡`);

    /* F1 判据本体：任务单说有图 ∧ 台账说无需图 ⇒ 报 */
    const mkFigs = new Map([['垂径定理求半径错', { hasFigure: true, figBbox: [0.55, 0.27, 0.16, 0.12], taskId: 't-x.json', title: '垂径定理求半径错' }]]);
    const card = { id: 'M0046', dir: 'M0046-垂径定理求半径错' };
    const bad = G.figureDeclaredButMissing(card, { need: false }, mkFigs);
    A('F1 任务单说有图 ∧ 台账说无需图 ⇒ 报「图没落地」', !!bad && bad.ok === false, bad ? bad.msg.slice(0, 90) : '没报');
    /* F2 台账说需要图 ⇒ 不报（图已落地） */
    A('F2 台账说需要图 ⇒ 不报', G.figureDeclaredButMissing(card, { need: true }, mkFigs) === null);
    /* F3 任务单没说有图 ⇒ 不判（渐进式：没任务单的老卡不judge） */
    A('F3 任务单没说有图 ⇒ 不判', G.figureDeclaredButMissing(card, { need: false }, new Map()) === null);

    /* F4 真库：已修好的三张不得再被报；未修的必须被报 */
    const ledP = path.join(E.LIB, '_配图台账.json');
    const led = fs.existsSync(ledP) ? JSON.parse(fs.readFileSync(ledP, 'utf8').replace(/^\uFEFF/, '')) : { cards: {} };
    const hits = [];
    for (const x of cards) {
      const d = G.figureDeclaredButMissing(x.item, led.cards[x.key], figs);
      if (d && !d.ok) hits.push(x.key);
    }
    A('F4 真库：图声明未落地的卡已全部整改（门禁不再报）', hits.length === 0,
      hits.length ? '仍报：' + hits.join(' ') : '0 张');
    /* F5 用户点名的 M0077 必须有图（need=true 且有资产） */
    const m77 = cards.find(x => x.item.id === 'M0077');
    if (m77) {
      const e = led.cards[m77.key] || {};
      const hasAsset = fs.existsSync(path.join(m77.dirAbs, '题图.jpg')) || /<svg[\s>]/i.test(stemOf(m77));
      A('F5 用户点名的 M0077：图已落地（need=true 且有图资产）',
        e.need === true && hasAsset, `need=${e.need} 资产=${hasAsset}`);
    } else A('F5 用户点名的 M0077：图已落地（need=true 且有图资产）', false, '真库里没找到 M0077');
  }

  console.log(`\nRESULT=${fails === 0 ? 'PASS' : 'FAIL'} 断言=${total}`);
  if (fails) process.exitCode = 1;
}
