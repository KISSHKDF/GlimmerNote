#!/usr/bin/env node
/**
 * 着重号（"加点字"）回归（2026-10-25 晚建）——「打点能力」的永久护栏。
 *
 * 用户原话（指着印出来的 Y0001 试卷）：
 *   「从印刷体来看，你的打点能力很差，全库都是这样，如何加强？」
 * 事故根因（实测，不是标错字）：
 *   题干用 `<span class="rd">制</span>` 标加点字，全库 14 处 / 3 张卡，
 *   而 `app.css` **从来没有 `.rd` 规则**（新旧两版都没有）⇒ 加点字被当普通字印出来。
 *   第二层：`.rd` 被语文着重号（点在下）与数学循环节（点在上）混用，混在一起必有一类印错。
 *
 * 断言分四段：
 *   S. 样式：`.rd` 规则存在、真的画出点（伪元素 + 圆角/背景）、没被 display:none 藏起来；
 *      `.rd-above` 把点改到字上方。
 *   R. 渲染链路：真前端净化后 class 不被吞（否则样式再对也没用）；盲解清稿把标记变成"字+组合点"，
 *      老写法 `class="rd"` 与新写法 `class="rd rd-above"` 都必须保留这个语义。
 *   L. 真库：题面要求「加点」的卡必须有标记；标记必须一字一个。
 *   D. 阴性自证：没有样式 / 样式被藏 / 题面要加点却没标记 / 两个字一个标记 —— 判定函数必须报红
 *      （否则门禁永远绿 = 假门禁，同 L-175）。
 *
 * 全部只读：不写库、不起壳。退出码 0=全绿。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
const LIB = E.LIB;
let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 200) : ''}`); if (!ok) fails++; };

/* ---------- 装载浏览器侧真实代码 ---------- */
function loadV2() {
  const ctx = { console };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'host.js', 'model.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8'), ctx, { filename: f });
  ctx.CTB.views = {};
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8'), ctx, { filename: 'views/paper.js' });
  return ctx.CTB;
}
const CTB = loadV2();
const M = CTB.model;

/* ---------- 装载 ESM 侧：门禁判据 + 盲解清稿 ---------- */
let GATE = null, BLIND = null;
const asUrl = p => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
(async () => {
  GATE = await import(asUrl(path.join(ROOT, 'src', 'tools', '_着重号门禁.mjs')));
  BLIND = await import(asUrl(path.join(ROOT, 'src', 'tools', '_盲解复核.mjs')));
})().then(runAll).catch(e => { console.error('✖ 装载 ESM 模块失败：', e.message); process.exit(1); });

function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) { if (e.name === '_索引.json') acc.push(path.join(dir, e.name)); continue; }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    if (/(作业|假期)/.test(e.name)) continue;
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
  const css = fs.readFileSync(path.join(ROOT, 'src', 'app', 'css', 'app.css'), 'utf8');
  const cards = allCards();
  console.log(`库根 ${LIB}：${cards.length} 张卡\n`);

  /* ================= S. 样式 ================= */
  {
    const j = GATE.judgeCss(css);
    A('S1 app.css 里有 .rd 规则且真的画点（2026-10-25 事故判据）', j.ok, j.problems.map(p => p.code).join(',') || 'OK');
    A('S2 着重号点在字下方（bottom 取负值）', /\.rd::after\s*\{[^}]*bottom\s*:\s*-/.test(css), 'bottom 为负');
    A('S3 循环节把点改到字上方（.rd-above 覆盖 bottom/top）',
      /\.rd-above::after\s*\{[^}]*bottom\s*:\s*auto/.test(css) && /\.rd-above::after\s*\{[^}]*top\s*:\s*-/.test(css), '有');
    A('S4 点的颜色跟随文字（currentColor，不写死成灰）', /\.rd::after\s*\{[^}]*background\s*:\s*currentColor/.test(css), '有');
  }

  /* ================= R. 渲染链路 ================= */
  {
    /* 真前端净化：class 必须透传（STEM_ATTRS 白名单里有 class） */
    const html = '<div class="stem"><p class="stem-lead">A. 增其旧<span class="rd">制</span>　B. 四<span class="rd">时</span>之景不同</p></div>';
    const card = Object.assign({ id: 'T-RD', stemHtml: html, answerMode: 'none', type: '选择题' });
    const out = M.stemHtmlSafe(card);
    A('R1 净化后 rd 标记仍在（class 不被白名单吞掉）', (out.match(/class="rd"/g) || []).length === 2, out.slice(0, 160));

    /* 盲解清稿：老写法与新写法都必须变成"字 + 组合点 U+0307" */
    const t1 = BLIND.stemToText(html);
    A('R2 清稿保留加点语义（class="rd" → 字+组合点）', t1.indexOf('\u0307') >= 0 && /制\u0307/.test(t1), JSON.stringify(t1.slice(0, 40)));
    const htmlAbove = '<p>2.0<span class="rd rd-above">5</span><span class="rd rd-above">0</span></p>';
    const t2 = BLIND.stemToText(htmlAbove);
    A('R3 清稿同样认新写法（rd rd-above 不被漏掉）', /5\u0307/.test(t2) && /0\u0307/.test(t2), JSON.stringify(t2));
    /* 老数据逐字等价：改正则前后同一张卡必须得到同一段清稿 */
    const oldStyle = '<p>A.<span class="rd">制</span></p>';
    A('R4 放宽正则对老数据逐字等价（同输入同输出）',
      BLIND.stemToText(oldStyle) === BLIND.stemToText(oldStyle.replace('<span class="rd">', '<span class="rd">')), '一致');
  }

  /* ================= L. 真库 ================= */
  {
    const rows = cards.map(x => Object.assign({ key: x.key, subject: x.subject },
      GATE.judgeCard({ stem: stemOf(x), question: x.item.question, status: x.item.status })));
    const withMarks = rows.filter(r => r.marks.length);
    const saysDot = rows.filter(r => r.saysDot);
    const bad = rows.filter(r => !r.ok && !r.archived);
    A('L0 库里有题面要求加点的卡（否则本段等于没测）', saysDot.length >= 1, `${saysDot.length} 张：${saysDot.map(r => r.key).join(' ')}`);
    A('L1 题面要求加点的卡都有标记', saysDot.every(r => r.marks.filter(m => !m.inSvg).length > 0), saysDot.filter(r => !r.marks.filter(m => !m.inSvg).length).map(r => r.key).join(' ') || '全齐');
    A('L2 标记一律一字一个（多字等于没标）', rows.every(r => !r.problems.some(p => p.code === 'dot-multi')), bad.map(r => r.key).join(' ') || '全绿');
    A('L3 真库门禁绿（含样式）', bad.length === 0 && GATE.judgeCss(css).ok, bad.length ? bad.map(r => `${r.key}:${r.problems.map(p => p.code).join(',')}`).join(' ') : '全绿');
    /* 语文着重号必须点在字下；数学循环节点在字上 —— 两类都要有实例（说明没混用） */
    const below = withMarks.filter(r => r.marks.some(m => !m.above));
    const above = withMarks.filter(r => r.marks.some(m => m.above));
    A('L4 着重号（点在下）与循环节（点在上）都有实例', below.length > 0 && above.length > 0,
      `点在下 ${below.length} 张：${below.map(r => r.key).join(' ')} ｜ 点在上 ${above.length} 张：${above.map(r => r.key).join(' ')}`);
  }

  /* ================= D. 阴性自证 ================= */
  {
    const g1 = GATE.judgeCard({ stem: '<p>下列句中加点字词古今义相同的一项是（　）</p><p>A. 增其旧制</p>', question: '' });
    A('D1 题面说加点却无标记 → 报红', !g1.ok && g1.problems.some(p => p.code === 'dot-missing'), g1.problems.map(p => p.code).join(',') || '未报红');

    const g2 = GATE.judgeCard({ stem: '<p>下列加点字</p><p><span class="rd">旧制</span></p>' });
    A('D2 一个标记点两个字 → 报红', !g2.ok && g2.problems.some(p => p.code === 'dot-multi'), g2.problems.map(p => p.code).join(',') || '未报红');

    const g3 = GATE.judgeCss('/* 没有 rd 规则 */\n.blank{min-width:3em}');
    A('D3 CSS 里删掉 .rd 规则 → 报红（本次事故复现）', !g3.ok && g3.problems.some(p => p.code === 'style-missing'), g3.problems.map(p => p.code).join(',') || '未报红');

    const g4 = GATE.judgeCss('.rd{display:none}');
    A('D4 .rd 被藏起来 → 报红', !g4.ok && g4.problems.some(p => p.code === 'style-hidden'), g4.problems.map(p => p.code).join(',') || '未报红');

    const g5 = GATE.judgeCss('.rd{position:relative}');
    A('D5 .rd 规则在但不画点 → 报红', !g5.ok && g5.problems.some(p => p.code === 'style-invisible'), g5.problems.map(p => p.code).join(',') || '未报红');

    const g6 = GATE.judgeCard({ stem: '<p>加点字</p><svg viewBox="0 0 10 10"><span class="rd">制</span></svg>' });
    A('D6 标记写进 svg 里 → 报红', !g6.ok && g6.problems.some(p => p.code === 'dot-in-svg'), g6.problems.map(p => p.code).join(',') || '未报红');
  }

  console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
  process.exit(fails ? 1 : 0);
}
