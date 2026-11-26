#!/usr/bin/env node
/**
 * 多问整题的答案覆盖回归（2026-11-26 建）—— 「答案册只答了错的那一问」的永久护栏。
 *
 * 用户原话（点卡到具体编号）：
 *   「拾光小册，某学生，m0063，问了两个问题，但是给家长用的答案只是回答了第二问，
 *     为什么不把第一问的答案也加上？」
 *
 * 实测根因（不是渲染 bug，是**录题口径**的缺口）：
 *   录题配方只规定「**收哪一问**」（只收错的那一问），没规定「**答案要答哪一问**」
 *   ⇒ `answer` 只登记了错的那一问的答案；
 *   而印刷版题干里 (1)(2) 两问都在（卷面让孩子做两问）⇒ 家长拿答案册**判不了另一问**。
 *   M0063 实测（用本仓自己的渲染代码复现）：题干 `(1)求…月平均增长率；(2)…降价多少元`，
 *   答案册印出来只有「答案：降价8元」。
 *
 * 断言分四段：
 *   M. 判据本身（单元）：被问/被引用/选择/合卡/只印一问 —— 逐条钉死边界；
 *   N. **阴性自证**：故意造一张"只答第二问"的卡，判定必须报红
 *      （否则门禁永远绿 = 假门禁；同 L-175「可选工具 ≠ 机械化」）；
 *   L. 接线：门禁 `judge` 里必须真的调这个判据（源码级断言，防"判据写了但没接"）；
 *   R. 渲染：答案册里必须能看见逐问标注（用真渲染代码跑，验证纸面效果）。
 *
 * 全部只读：不写库、不起壳。退出码 0=全绿。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
const LIB = E.LIB;
let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) fails++; };

/* ---------- Node 侧实现（ESM，动态 import） ---------- */
let K = null;
(async () => {
  K = await import(path.join(ROOT, 'src', 'tools', '_小问.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
})().then(runAll).catch(e => { console.error('✖ 装载 _小问.mjs 失败：', e.message); process.exit(1); });

/* ---------- 装载浏览器侧真实代码（与 neg-answer-slot-contract.cjs 同法） ---------- */
function loadV2() {
  const ctx = { console };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'host.js', 'model.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8'), ctx, { filename: f });
  }
  ctx.CTB.views = {};
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8'), ctx, { filename: 'views/paper.js' });
  return ctx.CTB;
}
const CTB = loadV2();
const U = CTB.util, M = CTB.model;

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
  for (const f of indexFiles(LIB)) {
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
  console.log(`库根 ${LIB}：${cards.length} 张卡\n`);

  /* ================= M. 判据本身（单元） ================= */
  {
    /* M1 两问都被问（都是解答题，段内无空位）⇒ 缺标注就是缺口 */
    const h2 = '<div class="stem"><p class="stem-lead">(1)求月平均增长率；(2)求降价多少元。</p></div>';
    const r2 = K.multiPartCoverage({ answer: '降价8元' }, { stemHtml: h2 });
    A('M1 两问解答题：只答一问 ⇒ 判为缺口', r2.multi === true && r2.missing.length === 2, `缺 ${r2.missingText}`);

    /* M2 逐问标注齐全 ⇒ 通过 */
    const ok2 = K.multiPartCoverage({ answer: '(1) 月平均增长率25%；(2) 降价8元' }, { stemHtml: h2 });
    A('M2 逐问标注齐全 ⇒ 通过', ok2.multi === true && ok2.missing.length === 0, `覆盖 ${ok2.covered.join(',')}`);

    /* M3 「被引用」的小问不算被问（由第(1)问求得 ⇒ (1) 只是依赖） */
    const h3 = '<div class="stem"><p class="stem-lead">7．(2) 求 3(2m²−3mn−5m−1) 的值（由第(1)问求得）．</p></div>';
    const r3 = K.multiPartCoverage({ answer: '25' }, { stemHtml: h3 });
    A('M3 被引用的小问不算「被问」', r3.multi === false, r3.reason);

    /* M4 只印了 (2)、编号不连续 ⇒ 不是多问整题 */
    const h4 = '<div class="stem"><p class="stem-lead">(2) 求当 x=5 时的函数值。</p></div>';
    const r4 = K.multiPartCoverage({ answer: '12.6' }, { stemHtml: h4 });
    A('M4 编号不连续（只印一问）⇒ 不是多问整题', r4.multi === false, r4.reason);

    /* M5 选择题豁免：(1)(2)(3)(4) 是待判断的说法，答案是 A */
    const h5 = '<div class="stem"><p class="stem-lead">下列说法：(1)长度相等的弧是等弧，(2)相等的圆心角所对的弧相等，(3)劣弧一定比优弧短，(4)直径是圆中最长的弦。其中正确的有（ ）</p></div>';
    const r5 = K.multiPartCoverage({ answer: 'A', answerMode: 'none' }, { stemHtml: h5 });
    A('M5 选择题（answerMode=none）豁免', r5.multi === false, r5.reason);

    /* M6 合卡豁免（answerScope=partial） */
    const h6 = '<div class="stem"><p class="stem-lead">(1) 求 x 的值；(2) 求 y 的值。</p></div>';
    const r6 = K.multiPartCoverage({ answer: 'x=1', answerScope: 'partial' }, { stemHtml: h6 });
    A('M6 合卡（answerScope=partial）豁免', r6.multi === false, r6.reason);

    /* M7 有空位的小问走逐空通道 ⇒ 不要求主答案标注（只有没空位的那一问被要求） */
    const h7 = '<div class="stem"><p class="stem-lead">(1) 填空<span class="blank"></span>；(2) 求 y 的值。</p></div>';
    const r7 = K.multiPartCoverage({ answer: 'x=1', answerSlots: ['x'], answerMode: 'blank' }, { stemHtml: h7 });
    A('M7 有空位的小问走逐空通道 ⇒ 只报没空位的那一问',
      r7.multi === true && r7.missing.length === 1 && r7.missing[0] === 2,
      `问 ${r7.asked.join(',')} / 缺 ${r7.missingText}`);

    /* M8 用户点名的 M0063：必须被这条判据**覆盖**（能被解析成多问整题），
       且整改后**不再报缺口**（它已于 2026-11-26 补齐为逐问标注）。
       ⚠ 断言的是"能被覆盖 + 现在是齐的"，不是"现在还缺"。 */
    const m63 = cards.find(x => x.item.id === 'M0063' && x.item.question && /徽章/.test(String(x.item.question)));
    if (m63) {
      const r = K.multiPartCoverage(m63.item, { stemHtml: stemOf(m63) });
      A('M8 用户点名的 M0063（徽章题）能被覆盖，且已整改为逐问标注',
        r.multi === true && r.missing.length === 0,
        `问 ${r.asked.join(',')} / 缺 ${r.missingText || '无'}`);
    } else {
      A('M8 用户点名的 M0063（徽章题）能被覆盖，且已整改为逐问标注', false, '真库里没找到 M0063（徽章题）');
    }

    /* M9 真库回归：多问整题卡的**主答案必须逐问标注**（整改后 0 缺口） */
    const flagged = [];
    for (const x of cards) {
      const stem = stemOf(x);
      if (!stem) continue;
      const r = K.multiPartCoverage(x.item, { stemHtml: stem });
      if (r.multi && r.missing.length) flagged.push({ x, r });
    }
    A('M9 真库：多问整题的主答案已全部逐问标注（0 缺口）', flagged.length === 0,
      `${flagged.length} 张命中：${flagged.map(f => f.x.key).join(' ')}`);
  }

  /* ================= N. 阴性自证（门禁必须真的会红） ================= */
  {
    /* N1：造一张「只答第二问」的卡，接线后的 judge 必须报红。
       ⚠ 做法：把 `_作答门禁.mjs` 的 judge 抽出来跑？它依赖太多私有函数 ⇒ 改用**行为等价**的路径：
         直接跑真门禁的判定入口（`门禁 --json`）不方便塞假卡 ⇒ 这里退一步：
         用同一判据 + 同一调用形状验证「缺口 ⇒ problems 非空」。 */
    const fakeStem = '<div class="stem"><p class="stem-lead">(1)求月平均增长率；(2)求降价多少元。</p></div>';
    const fakeCard = { id: 'T-MP', answer: '(2) 降价8元', answerMode: 'zone', answerScope: 'full' };
    const rr = K.multiPartCoverage(fakeCard, { stemHtml: fakeStem });
    A('N1 阴性：只答第二问 ⇒ 缺口非空（门禁据此报红）', rr.missing.length === 1 && rr.missing[0] === 1, `缺 ${rr.missingText}`);
    /* N2 补上第一问后 ⇒ 缺口清空（修完就绿，证明这条判据可被"改数据"满足，不是死红） */
    const fixed = { ...fakeCard, answer: '(1) 月平均增长率25%；(2) 降价8元' };
    const rf = K.multiPartCoverage(fixed, { stemHtml: fakeStem });
    A('N2 阴性对照：补齐第一问 ⇒ 通过', rf.missing.length === 0, `缺 ${rf.missingText}`);
  }

  /* ================= L. 接线（判据必须真的接进门禁） ================= */
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_作答门禁.mjs'), 'utf8');
    A('L1 门禁 import 了 _小问.mjs', /import\s*\{[^}]*multiPartCoverage[^}]*\}\s*from\s*'\.\/_小问\.mjs'/.test(src));
    A('L2 门禁的 judge 里真的调了 multiPartCoverage', /multiPartCoverage\s*\(/.test(src));
    A('L3 门禁把缺口当成 problems（阻断级）', /multiPartCoverage[\s\S]{0,400}?problems\.push/.test(src));
    /* L4 配方规则必须写明「只收错的那一问 ≠ 答案只答那一问」 */
    const recipes = ['ingest-page', 'ingest-single', 'ingest-independent', 'ingest-auto'];
    const missingRule = recipes.filter(r => {
      const p = path.join(ROOT, 'src', 'recipes', r, 'prompt.md');
      if (!fs.existsSync(p)) return true;
      const t = fs.readFileSync(p, 'utf8');
      return !/答案只答错的那一问|逐问标注/.test(t);
    });
    A('L4 四个配方的提示词都写明了「答案要逐问标注」', missingRule.length === 0,
      missingRule.length ? '缺：' + missingRule.join(' ') : '全有');
    /* L5 官方经验包要有这条卡 */
    const packP = path.join(ROOT, 'src', '官方经验包', 'glimmer-official', 'core', '1.1.0', 'pack.json');
    const pk = JSON.parse(fs.readFileSync(packP, 'utf8').replace(/^\uFEFF/, ''));
    A('L5 官方经验包收录了「多问整题：答案要逐问标注」',
      (pk.cards || []).some(c => c.id === 'multipart-answer-per-question'),
      (pk.cards || []).map(c => c.id).join(','));
  }

  /* ================= R. 渲染（纸面效果：用真渲染代码跑） ================= */
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
    const m = src.match(/function ansHtml\(title, refs\) \{[\s\S]*?\n  \}/);
    const mT = src.match(/function traceLines\(c\) \{[\s\S]*?\n  \}/);
    A('R0 ansHtml 可抽取', !!m && !!mT);
    if (m && mT) {
      const traceLines = new Function('U', 'return (' + mT[0].replace(/^function traceLines/, 'function') + ')')(U);
      const ansHtml = new Function('U', 'M', 'H', 'shHead', 'traceLines', 'return (' + m[0].replace(/^function ansHtml/, 'function') + ')')(
        U, M, CTB.host, (t) => '<div class="sh-h"></div>', traceLines);
      const card = { id: 'M0063', answer: '(1) 月平均增长率25%；(2) 降价8元', answerMode: 'zone' };
      const html = ansHtml('卷', [{ kid: '学生甲', card }]);
      const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      A('R1 答案册印出逐问标注（家长看得见哪句答哪一问）',
        plain.includes('(1)') && plain.includes('(2)') && plain.includes('月平均增长率25%') && plain.includes('降价8元'),
        plain.slice(0, 200));
    }
  }

  console.log(`\nRESULT=${fails === 0 ? 'PASS' : 'FAIL'} 断言=${total}`);
  if (fails) process.exitCode = 1;
}
