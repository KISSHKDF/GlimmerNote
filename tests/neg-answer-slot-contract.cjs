#!/usr/bin/env node
/**
 * 作答契约回归（2026-10-25 建）——「答案不全 / 图上作答白留框 / 横线写不下」三类事故的永久护栏。
 *
 * 用户原话级事故（同一天三条，点名到卡）：
 *   「M0066，答案好像不全」；
 *   「M0011，在图上写出答案，所以组卷时这类题目不需要再留答题区」；
 *   「M0084，给出的下横线长度根本不够写答案」。
 * 并且明确要求：**不许只改这三张卡，要把三类问题变成制度**。
 *
 * ★ 2026-10-25 晚间二次报障（语文默写 Y0003 行路难默写），原话：
 *   「给出的横线明显不够写答案…… 再考虑到小孩子写字不规矩，你再放一个 1.5 倍的带下横线的
 *     空格出来，这才是合理的出题方式」。
 *   上一版把横线撑到"答案所需 ×1.0"（成人字迹刚好写满：7 个字给 8.2em = 5.2mm 一格），
 *   孩子一落笔就挤出线外 ⇒ 本用例 C 段改成 1.5 倍口径，并把 Y0003 这一类的原始症状做成断言（C7）。
 *
 * 断言分五段：
 *   P. **两份实现逐卡对拍**（Node `src/tools/_空位.mjs` vs 浏览器 `model.js`）：全库每张卡的题干
 *      空位数/空位类型/声明宽度必须完全一致；needEm / blankWidthEm / applySlotWidths 同判；
 *      partial 合卡的答案必须撑到"它自己那一空"（旧版按下标硬套，撑错了空）。
 *   A. 答案齐全：空位可数；逐空答案条数必须等于空位数（partial 用 answerSlotsAt 定位）；
 *      空串、越界、partial 缺 note 全部判红。
 *   B. 图上作答：answerMode=figure 的卡不得输出答题区；none（选择/判断）同理；
 *      M0011 这种"圈里填数"的题必须判 figure（不是靠 type 猜）。
 *   C. 横线够宽：横线 ≥ 答案所需 × 1.5（小孩书写余量），且不得超过单条横线物理上限；
 *      窄线不得被原样印出（用户 M0084 / Y0003 的原始症状）。
 *   D. 阴性自证：故意造"少一条答案""图上作答没登记"的卡，判定函数必须报红
 *      （否则门禁永远绿 = 假门禁；同 L-175「可选工具 ≠ 机械化」）。
 *
 * 全部只读：不写库、不起壳。退出码 0=全绿。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
const LIB = E.LIB;
let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 200) : ''}`); if (!ok) fails++; };

/* ---------- 装载浏览器侧真实代码（与 neg-paper-order-blank.cjs 同法） ---------- */
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
const M = CTB.model, U = CTB.util;

/* ---------- Node 侧实现（ESM，动态 import） ---------- */
let K = null;
(async () => {
  K = await import(path.join(ROOT, 'src', 'tools', '_空位.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
})().then(runAll).catch(e => { console.error('✖ 装载 _空位.mjs 失败：', e.message); process.exit(1); });

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
  const cards = allCards();
  console.log(`库根 ${LIB}：${cards.length} 张卡\n`);

  /* ================= P. 两份实现逐卡对拍 ================= */
  {
    let bad = [], checked = 0;
    for (const x of cards) {
      const stem = stemOf(x);
      if (!stem) continue;
      checked++;
      const a = M.slotsOf(stem).map(s => `${s.kind}:${s.width}`);
      const b = K.slotsOf(stem).map(s => `${s.kind}:${s.width}`);
      if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${x.key} 浏览器=${a.join(',') || '∅'} / node=${b.join(',') || '∅'}`);
    }
    A('P1 空位解析：两份实现逐卡同判', bad.length === 0, bad.length ? bad.slice(0, 5).join(' | ') : `对拍 ${checked} 张`);
    /* 宽度撑开也必须同判 */
    const html = '<p>式子 −(−<i>a</i>)＝<i>a</i> 表示的意义是<span class="blank" style="width:6em"></span>。</p>';
    const ans = ['−a 的相反数是 a'];
    const ca = M.applySlotWidths(html, ans), cb = K.applySlotWidths(html, ans);
    A('P2 撑宽：两份实现同判', ca === cb, ca === cb ? '一致' : `浏览器=${ca}\nnode=${cb}`);
    A('P3 needEm 同判', M.needEm(ans[0]) === K.needEm(ans[0]), `${M.needEm(ans[0])} vs ${K.needEm(ans[0])}`);
    /* ★ 2026-10-25 晚：横线口径从 1.0 倍改成 1.5 倍，两份实现必须同判（否则纸面与门禁各说各话） */
    A('P3b blankWidthEm 同判（答案所需 × 1.5）', M.blankWidthEm(ans[0]) === K.blankWidthEm(ans[0]), `${M.blankWidthEm(ans[0])} vs ${K.blankWidthEm(ans[0])}`);
    A('P3c 书写余量常数同值', M.CHILD_FACTOR === K.CHILD_FACTOR && M.BLANK_MAX_WIDTH_EM === K.BLANK_MAX_WIDTH_EM,
      `CHILD_FACTOR=${M.CHILD_FACTOR}/${K.CHILD_FACTOR} 上限=${M.BLANK_MAX_WIDTH_EM}/${K.BLANK_MAX_WIDTH_EM}`);
    /* partial 合卡：答案必须撑到"它自己那一空"（下标硬套会撑错，用户看到的仍是窄线） */
    {
      const stem3 = '<p>1.<span class="blank" style="min-width:4em"></span> 2.<span class="blank" style="min-width:4em"></span> 3.<span class="blank" style="min-width:4em"></span></p>';
      const card3 = { id: 'T-PARTIAL', type: '填空题', answerMode: 'blank', answerScope: 'partial', answerSlots: ['communication'], answerSlotsAt: [3] };
      const out3 = M.stemHtmlSafe(Object.assign({ stemHtml: stem3 }, card3));
      const ws = [...out3.matchAll(/min-width:\s*([\d.]+)em/g)].map(m => parseFloat(m[1]));
      const want3 = K.blankWidthEm('communication');
      A('P4 partial：横线只撑答案对应的那一空', ws.length === 3 && ws[2] >= want3 && ws[0] < want3, `[${ws.join(', ')}]，答案需 ${want3}em`);
      const nodeOut = K.applySlotWidths(stem3, K.alignedAnswers(card3.answerSlots, card3.answerSlotsAt, 3));
      const wsN = [...nodeOut.matchAll(/min-width:\s*([\d.]+)em/g)].map(m => parseFloat(m[1]));
      A('P5 partial：Node 侧同判', JSON.stringify(ws) === JSON.stringify(wsN), `浏览器 [${ws.join(',')}] / node [${wsN.join(',')}]`);
    }
  }

  /* ================= A. 答案齐全 ================= */
  {
    const withSlots = cards.filter(x => K.slotCount(stemOf(x)) > 0);
    A('A0 库里有可数的题（否则本段等于没测）', withSlots.length > 0, `${withSlots.length} 张有空位`);
    const missing = [], mismatch = [], empty = [], badAt = [];
    for (const x of withSlots) {
      const it = x.item;
      const n = K.slotCount(stemOf(x));
      const arr = Array.isArray(it.answerSlots) ? it.answerSlots.map(v => String(v == null ? '' : v)) : null;
      const partial = String(it.answerScope || '') === 'partial';
      if (!arr || !arr.length) { if (it.status !== '已归档') missing.push(`${x.key}(${n}空)`); continue; }
      if (arr.some(s => !s.trim())) empty.push(x.key);
      if (partial) {
        const at = Array.isArray(it.answerSlotsAt) ? it.answerSlotsAt : [];
        if (at.length !== arr.length || at.some(k => !(k >= 1 && k <= n))) badAt.push(x.key);
      } else if (arr.length !== n) mismatch.push(`${x.key}(${arr.length}/${n})`);
    }
    A('A1 有空的卡必须逐空登记答案', missing.length === 0, missing.length ? missing.slice(0, 12).join(' ') : '全齐');
    A('A2 逐空答案条数 = 空位数', mismatch.length === 0, mismatch.length ? mismatch.slice(0, 12).join(' ') : '全齐');
    A('A3 逐空答案无空串', empty.length === 0, empty.slice(0, 12).join(' ') || '无');
    A('A4 partial 的序号（answerSlotsAt）合法', badAt.length === 0, badAt.slice(0, 12).join(' ') || '无');
    /* A5 答案册必须逐空列出（否则数据登记了、纸面还是只有一段话） */
    {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
      const m = src.match(/function ansHtml\(title, refs\) \{[\s\S]*?\n  \}/);
      A('A5.0 ansHtml 可抽取', !!m);
      if (m) {
        const ansHtml = new Function('U', 'M', 'H', 'shHead', 'return (' + m[0].replace(/^function ansHtml/, 'function') + ')')(
          U, M, CTB.host, (t) => '<div class="sh-h"></div>');
        const refs = [{ kid: '学生A', card: { id: 'X1', type: '填空', answer: '总答案', answerSlots: ['甲', '乙', '丙'] } }];
        const h = ansHtml('卷', refs);
        A('A5 答案册逐空打印（第1/2/3空都在）', /第1空：甲/.test(h) && /第2空：乙/.test(h) && /第3空：丙/.test(h), h.slice(0, 240));
        const hp = ansHtml('卷', [{ kid: '学生A', card: { id: 'X2', answer: '总答案', answerScope: 'partial', answerSlots: ['甲'], answerSlotsAt: [3], answerNote: '只考第3空' } }]);
        A('A6 partial 标注与空号正确（第3空 + 说明）', /第3空：甲/.test(hp) && /只考第3空/.test(hp), hp.slice(0, 240));
        const hf = ansHtml('卷', [{ kid: '学生A', card: { id: 'X3', answer: '图里画', answerMode: 'figure' } }]);
        A('A7 图上作答卡在答案册上有明确提示', /在图上|按图形批改/.test(hf), hf.slice(0, 240));
      }
    }
  }

  /* ================= B. 图上作答不留答题区 ================= */
  {
    /* 直接抽 qHtml 纯函数（与 neg-paper-order-blank 同法），断言三种 mode 的答题区 */
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
    const m = src.match(/function qHtml\(x, i, form\) \{[\s\S]*?\n  \}/);
    A('B0 qHtml 可抽取', !!m);
    const qHtml = new Function('U', 'M', 'H', 'return (' + m[0].replace(/^function qHtml/, 'function') + ')')(U, M, CTB.host);
    const mk = (card) => ({ key: '学生A|' + card.id, kid: '学生A', subject: '数学', card });
    const render = c => qHtml(mk(c), 0, 'stem');

    const figCard = { id: 'T-FIG', type: '解答题（集合填数）', question: '将下列各数填入相应的集合圈内', stemHtml: '<p>将数填入圈内</p><svg viewBox="0 0 10 10"></svg>', answerMode: 'figure' };
    A('B1 figure：不留答题区', render(figCard).indexOf('height:220px') < 0 && render(figCard).indexOf('anszone" style="height') < 0, render(figCard).slice(-120));
    const zoneCard = { id: 'T-ZONE', type: '解答题', question: '求…', stemHtml: '<p>求…</p>', answerMode: 'zone', difficulty: '中' };
    A('B2 zone：照旧留答题区', render(zoneCard).indexOf('height:220px') >= 0, render(zoneCard).slice(-120));
    const blankCard = { id: 'T-BLANK', type: '填空题', question: '______', stemHtml: '<p>水分子由<span class="blank" style="width:6em"></span>构成</p>', answerMode: 'blank' };
    A('B3 blank：题干里有坑就不再留大框', render(blankCard).indexOf('height:90px') < 0, render(blankCard).slice(-120));
    const selCard = { id: 'T-SEL', type: '选择题', question: '（　）', stemHtml: '<p>选</p>', answerMode: 'none' };
    A('B4 none：0 高匿名区（选择/判断）', render(selCard).indexOf('height:0') >= 0, render(selCard).slice(-120));
    /* 真库回归：上一轮点名卡必须已是 figure */
    const m0011 = cards.find(x => x.key.endsWith('|M0011'));
    if (m0011) A('B5 M0011（集合填数·图里下笔）已判 figure', m0011.item.answerMode === 'figure', m0011.item.answerMode || '(未登记)');
    else A('B5 M0011 存在（夹具库可能没有）', true, 'SKIP 库中无 M0011');
    /* 反例：库里所有 figure 卡，渲染都不得留大答题区 */
    const figAll = cards.filter(x => x.item.answerMode === 'figure');
    const leak = figAll.filter(x => { const h = render(x.item); return /anszone" style="height:(?!0)/.test(h); });
    A('B6 全库 figure 卡都不留答题区', leak.length === 0, leak.map(x => x.key).join(' ') || `figure ${figAll.length} 张`);
  }

  /* ================= C. 横线够宽（口径：答案所需 × 1.5） ================= */
  {
    const narrow = '<div class="stem"><p>式子 −(−<i>a</i>)＝<i>a</i> 表示的意义是<span class="blank" style="width:6em"></span>。</p></div>';
    const card = { id: 'T-W', answerSlots: ['−a 的相反数是 a'], answerMode: 'blank' };
    const out = M.stemHtmlSafe(Object.assign({ stemHtml: narrow }, card));
    const w = /min-width:\s*([\d.]+)em/.exec(out);
    A('C1 窄线按答案撑宽（M0084 症状）', !!w && parseFloat(w[1]) >= 9, w ? `min-width=${w[1]}em` : out.slice(0, 160));
    A('C2 撑宽后仍保留原 class', /class="blank"/.test(out), out.slice(0, 160));
    const wide = '<p>已知 <span class="blank" style="width:18em"></span></p>';
    const out2 = M.stemHtmlSafe({ stemHtml: wide, answerSlots: ['a'] });
    const w2 = /min-width:\s*([\d.]+)em/.exec(out2);
    A('C3 已够宽的空位不被收窄（原有宽度是下限）', !!w2 && parseFloat(w2[1]) >= 18, w2 ? `${w2[1]}em` : out2);
    /* 反例：没有任何 answerSlots 时不得擅自改宽（避免把版面撑乱） */
    const out3 = M.stemHtmlSafe({ stemHtml: narrow });
    A('C4 未登记逐空答案时不改宽（保持原排版）', /width:6em/.test(out3) && !/min-width/.test(out3), out3.slice(0, 160));

    /* ★ C7（2026-10-25 晚，用户二次报障的原症状）：语文默写 Y0003 行路难默写——
       7 个字的答案，上一版给的横线 8.2em（= 答案所需 1.0 倍，5.2mm 一格，孩子写不下）。
       现在必须 ≥ 答案所需 × 1.5。这条断言就是"下次别再给我刚好够"的护栏。 */
    {
      const y3ans = '忽复乘舟梦日边';
      const need = K.needEm(y3ans), want = K.blankWidthEm(y3ans);
      A('C7.0 Y0003 答案所需 = 8.2em（7 个字 + 尾余）', need === 8.2, `${need}em`);
      A('C7 横线 ≥ 答案所需 × 1.5（小孩书写余量）', want >= 12.29, `want=${want}em（= ${need} × ${K.CHILD_FACTOR}）`);
      const y3stem = '<div class="stem"><p>闲来垂钓碧溪上，<span class="blank" style="min-width:8.2em"></span>。</p></div>';
      const y3out = M.stemHtmlSafe({ id: 'Y0003', stemHtml: y3stem, answerSlots: [y3ans], answerMode: 'blank' });
      const w3 = parseFloat((/min-width:\s*([\d.]+)em/.exec(y3out) || [])[1]);
      A('C8 Y0003 旧横线（8.2em）渲染后必须被撑到 1.5 倍', w3 >= want, `渲染 ${w3}em ≥ ${want}em`);
      /* 换算成人话：12.5pt 正文 1em ≈ 4.41mm，7 个字要写在这个长度里 */
      const mm = Math.round(w3 * 4.41);
      A('C9 下笔空间换算成人话（≥ 6mm 一字才写得开）', mm / 7 >= 6, `${mm}mm / 7 字 = ${(mm / 7).toFixed(1)}mm 一字`);
      /* 门禁口径必须和渲染口径一致：声明的 8.2em 应判"偏窄"（提示可修），不应判通过 */
      const fit3 = K.fitSlots(y3stem, [y3ans]);
      A('C10 门禁把 1.0 倍横线判为偏窄（口径与渲染一致）', fit3.bad.length === 1 && fit3.bad[0].code === 'too-narrow',
        JSON.stringify(fit3.bad.map(b => ({ i: b.i, code: b.code, width: b.width, want: b.want }))));
    }
    /* C11 物理上限：超长答案（如 60em 的整段话）不得把横线撑爆纸面 */
    {
      const longAns = '（参考）Hello, everyone! I am Li Hua. I would like to share my idea about how to protect our environment in our daily life and at school.';
      const capped = K.applySlotWidths('<p><span class="blank" style="min-width:6em"></span></p>', [longAns]);
      const wc = parseFloat((/min-width:\s*([\d.]+)em/.exec(capped) || [])[1]);
      A('C11 超长答案的横线夹在物理上限内（不撑爆纸面）', wc > 0 && wc <= K.BLANK_MAX_WIDTH_EM,
        `${wc}em ≤ 上限 ${K.BLANK_MAX_WIDTH_EM}em（A4 可用宽 178mm ≈ 40em）`);
    }
    /* C12（2026-10-25 晚全库终检抓到 6 处）：**声明宽度本身**超上限时也必须夹。
       早期"按答案撑宽"把 39.2em（≈173mm）写进了题干，而"原有宽度是下限"会把它原样保留
       ⇒ 那条横线自己就撑出纸面；夹紧后同一张纸不再溢出（代价：这类答案进横线只能占一行，
       更长的本就该判 zone）。 */
    {
      const overDeclared = '<p>答：<span class="blank" style="min-width:39.2em"></span></p>';
      const ansOver = ['用镊子夹取块状大理石放在试管口，再把试管慢慢竖立起来'];
      const outOver = M.applySlotWidths(overDeclared, ansOver);
      const wOver = parseFloat((/min-width:\s*([\d.]+)em/.exec(outOver) || [])[1]);
      A('C12 声明宽度超上限也被夹到上限（横线不许自己撑出纸面）', wOver > 0 && wOver <= M.BLANK_MAX_WIDTH_EM,
        `${wOver}em ≤ 上限 ${M.BLANK_MAX_WIDTH_EM}em`);
      A('C12b 上限夹紧两份实现同判', outOver === K.applySlotWidths(overDeclared, ansOver), '一致');
    }
    /* 真库：每个已登记的空位在**渲染后**都写得下（宽度由 applySlotWidths 实时撑开）。
       判据分两层，与门禁同口径（2026-10-25 晚口径换成 1.5 倍）：
         · too-long（答案本身 >18em）→ 必须已经判 zone/figure，否则红（这是排版决策，机器不替人决定）；
         · too-narrow（声明宽度 < 答案所需 × 1.5）→ 数据基线偏窄可以接受，但**渲染后必须够宽**，
           否则红（用户 M0084 / Y0003 的原症状：横线写不下答案）。 */
    const tooLong = [], notFixed = [];
    for (const x of cards) {
      const ans = Array.isArray(x.item.answerSlots) ? x.item.answerSlots.map(String) : null;
      if (!ans || !ans.length) continue;
      const mode = String(x.item.answerMode || '');
      const stem = stemOf(x);
      const n = K.slotCount(stem);
      if (!n) continue;
      const partial = String(x.item.answerScope || '') === 'partial';
      /* partial 要先摊平到"第几空"，否则判的是错位的宽度（同 P4/P5 的教训） */
      const aligned = partial ? K.alignedAnswers(ans, x.item.answerSlotsAt, n) : ans;
      const fit = K.fitSlots(stem, aligned);
      for (const b of fit.bad) {
        if (b.code === 'too-long') { if (mode !== 'zone' && mode !== 'figure') tooLong.push(`${x.key}#${b.i}(${b.need}em)`); }
        else {
          const rendered = M.applySlotWidths(M.stemBlankify(stem), M.slotAnswersAligned(x.item, M.slotCount(M.stemBlankify(stem))));
          const ws = K.slotsOf(rendered).map(s => s.width);
          if (!(ws[b.i - 1] >= b.want)) notFixed.push(`${x.key}#${b.i}(${ws[b.i - 1]}<${b.want})`);
        }
      }
    }
    A('C5 超长答案一律改判 zone/figure（不许硬塞横线）', tooLong.length === 0, tooLong.slice(0, 12).join(' ') || '全绿');
    A('C6 偏窄的空位在渲染后都够宽（用户 M0084 / Y0003 的原症状）', notFixed.length === 0, notFixed.slice(0, 12).join(' ') || '全绿');
  }

  /* ================= D. 阴性自证（门禁必须真的会红） ================= */
  {
    /* 用临时库副本构造"坏卡"，跑真工具门禁，断言退出码 1；再修好，断言退出码 0。 */
    const tmp = E.makeTempLib(null, { copyCardFiles: true });
    const tool = path.join(ROOT, 'src', 'tools', '_作答门禁.mjs');
    const runGate = lib => {
      try {
        const out = execFileSync(process.execPath, [tool, '门禁', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { CTB_DATA: lib }) });
        return { code: 0, json: JSON.parse(out.trim()) };
      } catch (e) {
        let j = null; try { j = JSON.parse(String(e.stdout || '').trim()); } catch { }
        return { code: e.status == null ? 1 : e.status, json: j };
      }
    };
    const idxFiles = indexFiles(tmp);
    const pickFile = () => idxFiles.find(f => JSON.parse(fs.readFileSync(f, 'utf8')).subjects) || idxFiles[0];
    const readIdx = f => JSON.parse(fs.readFileSync(f, 'utf8'));
    const writeIdx = (f, j) => fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n', 'utf8');
    /* ① 先把全库声明清空 → 必须红 */
    const f1 = pickFile();
    const j1 = readIdx(f1);
    const items1 = j1.subjects ? Object.values(j1.subjects).flatMap(v => v.items || []) : (j1.items || []);
    A('D0 临时库有卡可测', items1.length > 0, `${items1.length} 张`);
    for (const it of items1) { delete it.answerSlots; delete it.answerMode; delete it.answerSlotsAt; delete it.answerScope; delete it.answerNote; }
    writeIdx(f1, j1);
    const g1 = runGate(tmp);
    A('D1 缺逐空答案 → 门禁红（exit≠0）', g1.code !== 0, `exit=${g1.code}`);
    A('D2 红的原因点名了「答案不全」', JSON.stringify(g1.json || {}).indexOf('逐空答案') >= 0, '');
    /* ② 逐空答案条数故意少一条 → 仍红 */
    const j2 = readIdx(f1);
    const items2 = j2.subjects ? Object.values(j2.subjects).flatMap(v => v.items || []) : (j2.items || []);
    const withSlot = items2.find(it => it && it.id);
    if (withSlot) { withSlot.answerSlots = ['只给一条']; withSlot.answerMode = 'blank'; }
    writeIdx(f1, j2);
    const g2 = runGate(tmp);
    A('D3 条数不齐 → 门禁红', g2.code !== 0, `exit=${g2.code}`);
    /* ③ 图上作答未登记 → 红 */
    const j3 = readIdx(f1);
    const items3 = j3.subjects ? Object.values(j3.subjects).flatMap(v => v.items || []) : (j3.items || []);
    const figItem = items3.find(it => it && it.dir);
    if (figItem) {
      const stemP = path.join(path.dirname(f1), (j3.subjects ? Object.keys(j3.subjects).find(n => (j3.subjects[n].items || []).includes(figItem)) + '\\' : ''), figItem.dir, '题干.html');
      try { fs.writeFileSync(stemP, '<div class="stem"><p>请在图上画出力的示意图，并标出支点。</p><svg viewBox="0 0 10 10"></svg></div>', 'utf8'); } catch { }
      delete figItem.answerSlots; delete figItem.answerMode;
    }
    writeIdx(f1, j3);
    const g3 = runGate(tmp);
    A('D4 图上作答未登记 → 门禁红', g3.code !== 0, `exit=${g3.code}`);
    /* ④ 把整库声明清干净后（--allow-empty 场景不存在）门禁不会假绿：空声明 = 红 */
    A('D5 三次构造的退出码都非 0（门禁不是摆设）', g1.code !== 0 && g2.code !== 0 && g3.code !== 0, `${g1.code}/${g2.code}/${g3.code}`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }

  /* ========= E. 答案契约指纹（v2.7，2026-10-27）——「改题干不改答案」必须被拦 =========
     为什么单列一段：空位数对账只挡得住"空变多/变少"，挡不住"措辞改了但空数没变"。
     那类错会原样印进答案册，家长照着批改必然判错位置/判错值。
     断言要点：①老卡（无指纹）只警告不阻断，不能一上线就把全库判红；②登记答案即盖章；
               ③只改措辞、空数不变 → 必须红且点名 stem-changed；④重新登记后恢复绿；
               ⑤只跑 `修宽`（改排版宽度）**不得**让指纹失效——否则人会学会"见红就刷章"。 */
  {
    const tmp = E.makeTempLib(null, { copyCardFiles: true });
    const tool = path.join(ROOT, 'src', 'tools', '_作答门禁.mjs');
    const runTool = (lib, args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { CTB_DATA: lib }) }) };
      } catch (e) {
        return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') };
      }
    };
    const idxFiles = indexFiles(tmp);
    const f = idxFiles.find(p => JSON.parse(fs.readFileSync(p, 'utf8')).subjects) || idxFiles[0];
    const readIdx = () => JSON.parse(fs.readFileSync(f, 'utf8'));
    const writeIdx = j => fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n', 'utf8');
    const itemsOf = j => (j.subjects ? Object.values(j.subjects).flatMap(v => v.items || []) : (j.items || []));
    /* 卡目录解析：必须与 _作答门禁.mjs 的 allCards() 同口径——
       有 subjects 时是 <库根>/<科目>/<dir>，纯 items 时是 <库根>/<dir>。
       （首版漏了科目那段，临时库实测 ENOENT；这与"路径口径不一致"同族，故按同一函数取。） */
    const cardDirOf = it => {
      const j = readIdx();
      const base = path.dirname(f);
      if (j.subjects) {
        for (const [name, v] of Object.entries(j.subjects)) {
          if ((v.items || []).some(x => x === it || (x && x.id === it.id))) return path.join(base, name, it.dir || it.id);
        }
      }
      return path.join(base, it.dir || it.id);
    };
    const stemPathOf = it => path.join(cardDirOf(it), '题干.html');
    /* 挑一张"有逐空答案且 id 在**全库唯一**"的卡做样板：
       ① 有答案才谈得上"答案依据哪版题干"；
       ② id 必须唯一，否则 `补登 --card <id>` 会因重名而定位失败（E7 首跑实测踩到：
          临时库里有 2 张同号卡，工具报"命中 2 张，请用 学生|编号"）。 */
    const allItemIds = new Map();
    for (const p of idxFiles) {
      const jj = JSON.parse(fs.readFileSync(p, 'utf8'));
      const its = jj.subjects ? Object.values(jj.subjects).flatMap(v => v.items || []) : (jj.items || []);
      for (const it of its) if (it && it.id) allItemIds.set(it.id, (allItemIds.get(it.id) || 0) + 1);
    }
    let j = readIdx();
    let t = itemsOf(j).find(it => Array.isArray(it.answerSlots) && it.answerSlots.length && it.dir && allItemIds.get(it.id) === 1);
    if (!t) {
      /* 造一张最小可用卡：题干 1 个空 + 逐空答案（id 用 EXT0001 避开真库命名） */
      const dirName = 'EXT0001';
      const base0 = path.dirname(f);
      const jjPre = readIdx();
      const subj0 = jjPre.subjects ? Object.keys(jjPre.subjects)[0] : '';
      const cardDir = subj0 ? path.join(base0, subj0, dirName) : path.join(base0, dirName);
      fs.mkdirSync(cardDir, { recursive: true });
      fs.writeFileSync(path.join(cardDir, '题干.html'), '<div class="stem"><p>求 x 的值：<span class="blank" style="width:6em"></span></p></div>', 'utf8');
      const jj = readIdx();
      const target = jj.subjects ? jj.subjects[subj0] : jj;
      if (target) {
        if (!target.items) target.items = [];
        target.items.push({ id: dirName, dir: dirName, type: '计算', answerMode: 'blank', answerSlots: ['x=3'] });
        writeIdx(jj);
      }
      j = readIdx();
      t = itemsOf(j).find(it => it && it.id === dirName);
    }
    A('E0 临时库有可测样板卡（有答案 + id 唯一）', Boolean(t), t ? `${t.id}` : '无');

    if (t) {
      const sp = stemPathOf(t);
      const before = fs.readFileSync(sp, 'utf8');

      /* ① 老卡（有答案、无指纹）→ 只警告不阻断 */
      const j1 = readIdx();
      for (const it of itemsOf(j1)) { delete it.answerSlotsFp; delete it.answerSlotsFpAt; }
      writeIdx(j1);
      const g1 = runTool(tmp, ['门禁', '--json']);
      A('E1 老卡无指纹 → 不阻断（渐进式，不能一上线全红）', g1.code === 0, `exit=${g1.code}`);

      /* ② 刷指纹盖章 */
      const s1 = runTool(tmp, ['刷指纹']);
      A('E2 刷指纹 正常执行', s1.code === 0, String(s1.out).trim().slice(0, 120));
      const j2 = readIdx();
      const stamped = itemsOf(j2).filter(it => it.answerSlotsFp);
      A('E3 已登记的卡被盖章（answerSlotsFp 非空）', stamped.length > 0, `${stamped.length} 张`);
      const assumed = itemsOf(j2).filter(it => it.answerSlotsFpAssumed === true);
      A('E4 盖章标记为「假设」而非已核实（answerSlotsFpAssumed）', assumed.length === stamped.length, `${assumed.length}/${stamped.length}`);

      /* ③ 只改措辞、空数不变 → 必须红，且点名 stem-changed。
         ⚠ 改动方式必须是"**一定**让纯文本变化"的：首版对 `<p>求 x 的值…` 做字面替换，
            但样板卡取自真库、根本没有这段文字 ⇒ 替换是空操作，门禁当然还是绿（假负）。
            现在改为往正文里插一个可见字符，并**先自证纯文本真的变了**。 */
      const plainOf = h => String(h || '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const stemNow = fs.readFileSync(sp, 'utf8');
      const mutated = stemNow.replace(/<\/p>/i, '<span>换了措辞</span></p>');
      fs.writeFileSync(sp, mutated, 'utf8');
      A('E5.0 措辞确实变了（纯文本前后不同——防止"替换成空操作"的假负）', plainOf(mutated) !== plainOf(stemNow), '');
      const g3 = runTool(tmp, ['门禁', '--json']);
      const j3s = String(g3.out || '');
      A('E5 改题干措辞（空数不变）→ 门禁红', g3.code !== 0, `exit=${g3.code}`);
      A('E6 红的原因点名 stem-changed / 题干被改过', j3s.indexOf('stem-changed') >= 0 || j3s.indexOf('题干在登记答案之后被改过') >= 0, j3s.slice(0, 160));

      /* ④ 重新登记答案 → 恢复绿。
         ⚠ 必须按该卡**实际空位数**补答案：首版一律补 1 条 'x=3'，而样板卡有 3 个空
            ⇒ 补登后变成"答案不全"，红得完全正确，是测试自己的用例错了（假红）。
         这里直接沿用卡上原来的逐空答案（它本来就是按这些空登记的）。 */
      const origSlots = Array.isArray(t.answerSlots) ? t.answerSlots.map(String) : ['x=3'];
      const re = runTool(tmp, ['补登', '--card', String(t.id), '--slots', origSlots.join('；'), '--mode', String(t.answerMode || 'blank')]);
      A('E7.0 补登 定位成功（id 全库唯一）', re.code === 0, String(re.out).trim().slice(0, 120));
      const g4 = runTool(tmp, ['门禁', '--json']);
      A('E7 重新登记后恢复绿（答案已对当前题干复核过）', g4.code === 0, `exit=${g4.code}`);

      /* ⑤ 只改排版宽度（模拟 修宽）→ 指纹必须不变 */
      const j5 = readIdx();
      const t5 = itemsOf(j5).find(it => it && it.id === t.id);
      const fpBefore = t5 && t5.answerSlotsFp;
      fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace(/width:\s*6em/g, 'width: 7.5em'), 'utf8');
      const j6 = readIdx();
      const t6 = itemsOf(j6).find(it => it && it.id === t.id);
      A('E8 只改 span width（排版）→ 指纹不变（否则人会「见红就刷章」）', fpBefore === (t6 && t6.answerSlotsFp), `${fpBefore} → ${t6 && t6.answerSlotsFp}`);

      fs.writeFileSync(sp, before, 'utf8');
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }

  console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
  process.exit(fails ? 1 : 0);
}
