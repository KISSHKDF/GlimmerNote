#!/usr/bin/env node
/**
 * 拾光小册 · 多问整题的小问编号解析 —— **唯一实现**（Node 侧）
 *
 * 为什么要有这个模块（2026-11-26 用户报障的根因）：
 *   用户原话：「拾光小册，某学生，m0063，问了两个问题，但是给家长用的答案只是回答了第二问，
 *              为什么不把第一问的答案也加上？」
 *
 * 实测根因（不是渲染 bug，是**录题口径**的缺口）：
 *   · 录题配方写着「**只收错的那一问**」—— 这条规则本身是对的：第 12 题只有 (2) 错、
 *     (1) 全对 ⇒ 收 (2) 一条（收 (1) 就是假错题）。
 *   · 但配方只规定了「**收哪一问**」，没规定「**答案要答哪一问**」——
 *     `answer` 字段于是只登记了错的那一问的答案。
 *   · 印刷版题干里 (1)(2) **两问都在**（题干是整题，卷面会让孩子做两问），
 *     而答案册只印了 (2) 的答案 ⇒ **家长拿到答案册，判不了 (1)**。
 *   · M0063 实测（用仓库自己的渲染代码复现）：题干 `(1)求…月平均增长率；(2)…降价多少元`，
 *     答案册印出来只有「答案：降价8元」。
 *
 * ── 判据（只认客观事实，不做语义推断） ────────────────────────────────
 *
 * **① 引用 vs 问题**（先判引用，再谈问题）：
 *   `由第(1)问求得` `利用(2)中的等式` ⇒ 这一问只是**被引用**，不是问题 ⇒ 排除。
 *   ⚠ 引用**优先**于「问题」判据：「由第(1)问求得」里有「问」字，不先判引用就会把 (1) 误当一问。
 *
 * **② 顶层小问**：剩下的括号编号 `(1)(2)(3)`，且**从 1 起连续**。
 *   只印了 `(2)` 的卡（M0128：题干是「7．(2) 求…（由第(1)问求得）」）**不算多问**——
 *   卷面只让孩子做 (2)，(1) 的取值已在题干里给出。
 *
 * **③ 是不是「被问」**（卷面确实让孩子做）：
 *   任一成立即算：
 *   a. 那一段里有**空位**（`<span class="blank">` / ASCII 下划线 / 全角下划线）⇒ 填空必问；
 *   b. 那一段里有**作答动词**（求/证明/判断/计算/多少/写出/填写/说明/如何…）。
 *   ⚠ 为什么不用"整段有问号"之类：判错的代价不对称 —— 误判会把好好的卡判红、逼人改卡；
 *     漏判只是漏查一张卡。所以只认上面两条硬证据。
 *
 * **④ 那一问的答案从哪来**（本模块的核心 —— 对应答案册上的两条答案通道）：
 *   答案册每张卡印两条答案：**主答案**（`answer`，一段话）与**逐空**（`answerSlots`，按空列出）。
 *   · 某一问**段内有空位** ⇒ 它的答案走**逐空**通道（父卷按空号对得上）⇒ 覆盖，不报。
 *   · 某一问**段内没有空位**（解答题：答案写在答题区里）⇒ 它的答案只能走**主答案**通道
 *     ⇒ 主答案必须**按小问标注**（`(1)…；(2)…`），家长才知道哪句答的是哪一问。
 *   ⇒ 缺口 = 「有这一问，但主答案里没有它的标注」。
 *     这正是 M0063 的形态：(1)(2) 都没有空位（解答题），主答案只有「降价8元」⇒ 家长判不了 (1)。
 *
 * **⑤ 答案覆盖**：答案文本里出现**同编号的括号标记** ⇒ 这一问有标注的答案。
 *   判据是「标注」而不是「这段文字答的是哪一问」——后者要做语义推断，不可靠。
 *   ⇒ 补标注时**顺手就把那一问的答案也写了**，正是用户要的那件事：
 *     答案册印成「(1) 月平均增长率25%；(2) 降价8元」，家长一眼对得上卷面。
 *
 * 豁免（各有明确理由，缺一条就会误报一批卡）：
 *   ① 合卡（`answerScope=partial`）：契约上就只考部分空 ⇒ 逐空答案由
 *      `answerSlots`/`answerSlotsAt` 表达，不是这里管的事；
 *   ② 选择/判断题（`answerMode=none`）：`(1)(2)(3)(4)` 是四个待判断的**说法**，
 *      答案是 `A/B/C/D` 一个 ⇒ 不算多问；
 *   ③ 顶层小问 < 2：本来就不是多问整题。
 *
 * 本模块**只做解析与判定**，不写盘、不改数据。写盘走 `_作答门禁.mjs`。
 */
import { slotsOf } from './_空位.mjs';

/* 中文数字 → 序号（只到「十二」，够题干用了；再大就当数字处理） */
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

function numOf(raw) {
  if (/^[0-9]+$/.test(raw)) { const v = Number(raw); return v >= 1 && v <= 20 ? v : null; }
  const i = CN.indexOf(raw);
  return i >= 0 ? i + 1 : null;
}

/** 题干 HTML → 纯文本（与 `_作答门禁.mjs` 的 plainText 同口径：图里的内容不算题干） */
export function plainOf(html) {
  return String(html || '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 这一段里有没有空位（填空 ⇒ 这一问一定被问）。空位解析复用 `_空位.mjs`（唯一实现）。 */
export function hasBlankIn(segHtml) {
  return slotsOf(segHtml).length > 0;
}

/**
 * 作答动词（这一问被问的证据）。
 * ⚠ 只收**多字短语**与几个万无一失的单字：
 *   「出」「取」「列」「作」这类单字会误伤（M0027 的「(1) 共卖**出** 55 台」是**已知条件**，
 *   不是问题；M0013 的「函**数解析式**」也不是）⇒ 一律不用。
 */
const ASK_RE = /求证|证明|判断|计算|求出|求值|多少|写出|填写|填空|选填|选择|说明|比较|化简|回答|指出|分析|描述|观察|依据|如何|取值范围|解方程|求解|画出|作图|解析式|求\s*[a-zA-Z]|求\s*当|求\s*该|求\s*此/;
/** 万无一失的单字：求（"需求/要求"另有排除） */
const ASK_CHAR_RE = /求/;
const ASK_CHAR_EXCLUDE_RE = /需求|要求|请求|要求证/;

/** 引用型前缀：标记**前面**是这些 ⇒ 这一问只是被引用 */
const DEP_PREFIX_RE = /(?:利用|由|据|根据|取|用|按照|按|见|参见|依|参照|其中|如|照)\s*第?\s*$/;
/** 引用型后缀：标记**后面**是这些 ⇒ 这一问只是被引用 */
const DEP_AFTER_RE = /^\s*(中的|中|问所|问求|问的|所|的)/;

/** 括号编号标记：`(1)` `（1）` `（一）` */
const BRACKET_RE = /[（(]\s*([0-9]{1,2}|[一二三四五六七八九十]+)\s*[)）]/g;

/**
 * 顶层小问：印刷版题干里**被问**的括号编号（从 1 起连续）。
 * @param {string} html 题干 HTML
 * @returns {{n:number, segHtml:string, segText:string, blanks:number}[]}
 */
export function topQuestions(html) {
  const t = String(html || '');
  const hits = [];
  let m;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(t))) {
    const n = numOf(m[1]);
    if (n == null) continue;
    hits.push({ n, idx: m.index, len: m[0].length });
  }
  if (!hits.length) return [];

  /* 逐个标记切段 + 判「引用 / 问题」 */
  const segs = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const next = hits[i + 1] ? hits[i + 1].idx : t.length;
    const segHtml = t.slice(h.idx + h.len, next);
    const before = t.slice(Math.max(0, h.idx - 16), h.idx);
    segs.push({ n: h.n, segHtml, segText: plainOf(segHtml), before, blanks: slotsOf(segHtml).length });
  }
  /* ① 先剔除「被引用」的 */
  const notRef = segs.filter(s => {
    const after = s.segText.replace(/^[，,、；;：:\s]+/, '');
    if (DEP_AFTER_RE.test(after) && !ASK_RE.test(after.slice(0, 14))) return false;
    if (DEP_PREFIX_RE.test(s.before) && !ASK_RE.test(after.slice(0, 14))) return false;
    return true;
  });
  /* ② 判「被问」：有空位 或 有作答动词 */
  const asked = notRef.filter(s => {
    if (s.blanks > 0) return true;
    const txt = s.segText;
    if (ASK_RE.test(txt)) return true;
    if (ASK_CHAR_RE.test(txt) && !ASK_CHAR_EXCLUDE_RE.test(txt)) return true;
    return false;
  });
  if (asked.length < 2) return [];

  /* ③ 编号从 1 起连续才算顶层 */
  const set = new Set(asked.map(s => s.n));
  let max = 0;
  while (set.has(max + 1)) max++;
  if (max < 2) return [];

  const seen = new Set();
  const out = [];
  for (const s of asked.filter(x => x.n <= max).sort((a, b) => a.n - b.n)) {
    if (seen.has(s.n)) continue;
    seen.add(s.n);
    out.push({ n: s.n, segHtml: s.segHtml, segText: s.segText, blanks: s.blanks });
  }
  return out;
}

/** 题干里**被问**的顶层小问编号 */
export function askedOf(html) {
  return topQuestions(html).map(q => q.n);
}

/** 答案文本里**标注**了哪些括号编号 */
export function coveredOf(answer) {
  const out = new Set();
  const t = String(answer || '');
  let m;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(t))) {
    const n = numOf(m[1]);
    if (n != null) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 判定一张卡「多问整题的答案有没有逐问覆盖」。
 *
 * @param {object} card   索引里的卡片条目
 * @param {object} [opts]
 * @param {string} [opts.stemHtml]  **印刷版**题干 HTML（题干.html）
 * @returns {{multi:boolean, asked:number[], covered:number[], missing:number[], missingText:string, reason:string}}
 */
export function multiPartCoverage(card, opts = {}) {
  const c = card || {};
  const scope = String(c.answerScope == null ? 'full' : c.answerScope);
  const mode = String(c.answerMode || '');
  const html = opts.stemHtml != null ? opts.stemHtml : '';
  const qs = html ? topQuestions(html) : [];
  const covered = coveredOf(c.answer);
  const none = { multi: false, asked: qs.map(q => q.n), covered, missing: [], missingText: '', reason: '' };

  if (scope === 'partial') {
    return { ...none, reason: '合卡（answerScope=partial）——逐空答案由 answerSlots/answerSlotsAt 表达' };
  }
  if (mode === 'none') {
    return { ...none, reason: 'answerMode=none（选择/判断题）——(1)(2) 是待判断的说法，不逐问作答' };
  }
  if (!html) {
    return { ...none, reason: '没有印刷版题干（题干.html 缺失）——无法判多问整题' };
  }
  if (qs.length < 2) {
    return { ...none, reason: '不是多问整题（被问的顶层小问 < 2）' };
  }

  /* 只有「段内没有空位」的小问才依赖主答案通道 ⇒ 只有它们必须在主答案里被标注。
     有空位的小问走逐空通道（答案册按空号印，家长对得上空）⇒ 不报。 */
  const needLabel = qs.filter(q => q.blanks === 0).map(q => q.n);
  const missing = needLabel.filter(n => !covered.includes(n));
  return {
    multi: true,
    asked: qs.map(q => q.n),
    covered,
    missing,
    missingText: missing.length ? `第 ${missing.join('、')} 问` : '',
    reason: missing.length
      ? `印刷题干有 ${qs.length} 个要孩子做的小问（${qs.map(q => q.n).join('、')}），`
        + `其中第 ${missing.join('、')} 问**没有空位**（答案是写在答题区里的），`
        + '而主答案里没有这些小问的标注 —— 家长拿答案册批改时，卷面上这些小问没有答案可对。'
        + '请把主答案改成逐问标注（(1)…；(2)…），缺的那一问**也要把答案写上**（不是只补编号）。'
      : '',
  };
}
