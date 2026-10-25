#!/usr/bin/env node
/**
 * 拾光小册 · 题干空位（作答槽）解析 —— **唯一实现**（Node 侧）
 *
 * 为什么要有这个模块（2026-10-25 用户报障三连的公共根因）：
 *   用户原话：「M0066 答案好像不全」「M0011 在图上写出答案，所以组卷时这类题不需要再留答题区」
 *           「M0084 给出的下横线长度根本不够写答案」。
 *   三件事表面无关，深层是同一个缺口：**题干里的"空"从来没有被当成数据**。
 *   渲染器只是把下划线画出来，没有任何地方知道"这道题有几个空、每个空的答案该多长"，
 *   于是：答案册只抄了错的那些空（答案不全）；图里作答的题照样印一个空答题框（白留）；
 *   6em 的横线配上 12 个字的答案（写不下）。
 *
 * 本模块把"空"变成可计算的事实：
 *   slotsOf(html)      逐空列出（顺序＝印在纸上的顺序），含每空声明宽度
 *   needEm(answer)     这个答案写下来要几 em（"成人字迹正好"的宽度）
 *   blankWidthEm()     横线至少要几 em ＝ needEm × 1.5（小孩写字不规矩的余量，用户 2026-10-25 定）
 *   applySlotWidths()  按答案长度把每个空撑到够宽（渲染器的唯一实现，Node 侧对拍用）
 *   alignedAnswers()   partial 合卡：把"第几空→答案"摊平成与空位等长的数组
 *   fitSlots()         「这题的空够不够写」的判定（门禁与渲染共用同一口径）
 *
 * ⚠ 浏览器侧对应实现是 `src/app/js/model.js` 的 `M.slotsOf / M.needEm / M.applySlotWidths`
 *   （前端不能用 ESM import，只能并列一份）。**两份必须逐字同判**——
 *   `tests/neg-answer-slot-contract.cjs` 的 P 段把全库题干同时喂给两份实现逐卡对拍，
 *   任一处分叉立即红灯。这就是"唯一实现"在本仓的落地方式（同 stemHtmlSafe 的既有做法）。
 */

/* 空位的三种书写形态（与 model.js 完全同口径）：
   ① <span class="blank" …>（题干.html 手写，可带 style="width:6em"）
   ② ASCII 下划线串 ______（≥2 个）
   ③ 全角下划线串 ＿＿（≥2 个）
   注意：<svg>…</svg> 内部一律不算空（图里下笔由"图上作答"那条规则管）。 */
const SVG_RE = /<svg[\s\S]*?<\/svg>/gi;
/* 空位 span 的识别：class 里**含独立 token `blank`** 才算。
   ⚠ 2026-10-25 实测踩到：早一版写 `<span class="blank"[^>]*>`，结果把**空位内部的编号标签**
   `<span class="blank-no">3</span>` 也当成一个空位（`blank-no` 的 `\bblank\b` 也成立），
   于是 8 空的完形渲染后又被数成 16 空、答案逐空对不上号。现在按 token 判。 */
const BLANK_SPAN_RE = /<\s*span\b([^>]*)>/gi;
const hasBlankClass = attrs => {
  const m = /class\s*=\s*"([^"]*)"/i.exec(String(attrs || ''));
  if (!m) return false;
  return m[1].split(/\s+/).indexOf('blank') >= 0;
};
const NUMBERED_UNDERSCORE_RE = /(?:_{2,}|＿{2,})\s*[0-9０-９]{1,3}\s*(?:_{2,}|＿{2,})/g;
const UNDERSCORE_RE = /_{2,}|＿{2,}/g;

/** 把 SVG 段替换成等长空白（保持后续索引可用），用于"只认图外空位"的扫描 */
function maskSvg(html) {
  return String(html || '').replace(SVG_RE, s => ' '.repeat(s.length));
}

/** 取 style 里声明的宽度（em；px 按 16px=1em 折算） */
function widthOf(tag) {
  const m = /style\s*=\s*"[^"]*?\bwidth\s*:\s*([\d.]+)\s*(em|px|mm|%)?/i.exec(tag || '');
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = (m[2] || 'em').toLowerCase();
  if (!isFinite(v)) return null;
  if (u === 'px') return round(v / 16);
  if (u === 'mm') return round(v / 4);          // 1em ≈ 4mm（10pt 正文的常用近似）
  if (u === '%') return null;                    // 百分比宽度不可判，按未声明处理
  return round(v);
}
const round = v => Math.round(v * 100) / 100;

/** 逐空解析（顺序＝卷面顺序）。返回 [{i, kind, width, start, end}] */
export function slotsOf(html) {
  const src = maskSvg(html);
  const hits = [];
  let m;
  BLANK_SPAN_RE.lastIndex = 0;
  while ((m = BLANK_SPAN_RE.exec(src))) {
    if (!hasBlankClass(m[1])) continue;
    hits.push({ i: m.index, len: m[0].length, kind: 'span', width: widthOf(m[0]) });
  }
  /* ① 先吃「编号横线」____3____（一个空），并记住它覆盖的区间，避免随后被拆成两段 */
  const numbered = [];
  NUMBERED_UNDERSCORE_RE.lastIndex = 0;
  while ((m = NUMBERED_UNDERSCORE_RE.exec(src))) {
    numbered.push([m.index, m.index + m[0].length]);
    hits.push({ i: m.index, len: m[0].length, kind: 'raw', width: null, numbered: true });
  }
  const inNumbered = i => numbered.some(([a, b]) => i >= a && i < b);
  UNDERSCORE_RE.lastIndex = 0;
  while ((m = UNDERSCORE_RE.exec(src))) {
    /* 若这段下划线落在某个 blank span 的**标签文本**里（正常不会，标签内不含下划线），忽略之。
       这里只防"span 内部又写了下划线"这种脏数据，避免重复计空。 */
    if (hits.some(h => m.index >= h.i && m.index < h.i + h.len && h.kind === 'span')) continue;
    if (inNumbered(m.index)) continue;                    // 已被「编号横线」吃掉
    hits.push({ i: m.index, len: m[0].length, kind: 'raw', width: null });
  }
  hits.sort((a, b) => a.i - b.i);
  return hits.map((h, i) => ({ i, kind: h.kind, width: h.width, start: h.i, end: h.i + h.len, numbered: !!h.numbered }));
}

/** 空位个数（最常用） */
export const slotCount = html => slotsOf(html).length;

/* ---------- 答案宽度估算（"这条横线够不够写这个答案"） ----------
   口径：中文/全角 1em，ASCII 字母数字 0.58em（正文等宽偏宽的保守值），空格 0.35em，
   非空白 ASCII 标点 0.45em；末尾再留 1.2em 余量（避免答案顶到下一句）。
   宁可偏宽也不能偏窄 —— 偏窄正是用户 M0084 / Y0003 两次投诉。 */
const FULLWIDTH_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\u2200-\u22ff\u2190-\u21ff\u00b1\u00d7\u00f7\u2212\u2260]/;

export function needEm(answer) {
  const s = String(answer == null ? '' : answer);
  if (!s) return 0;
  let w = 0;
  for (const ch of s) {
    if (FULLWIDTH_RE.test(ch)) w += 1;
    else if (ch === ' ') w += 0.35;
    else if (/[A-Za-z0-9]/.test(ch)) w += 0.58;
    else if (/[\u0300-\u036f]/.test(ch)) w += 0;        // 组合附加符不占位
    else w += 0.45;
  }
  return round(Math.min(40, Math.max(0, w + 1.2)));
}

/* ---------- 小孩写字不规矩：横线 = 答案所需 × 1.5（2026-10-25 用户二次报障定档） ----------
   用户原话（语文默写 Y0003 行路难默写）：「给出的横线明显不够写答案…… 再考虑到小孩子写字
   不规矩，你再放一个 1.5 倍的带下横线的空格出来，这才是合理的出题方式」。
   上一版把横线撑到 needEm 就收工 —— 7 个字给 8.2em，正是"成人字迹刚好写满"，孩子一落笔就
   挤出线外（Y0003 实测：8.2em / 7 字 = 5.2mm 一格）。现在横线至少 = needEm × 1.5
   （7 字 8.2em → 12.3em ≈ 54mm ≈ 7.7mm 一字），并设物理上限 BLANK_MAX_WIDTH_EM
   （30em ≈ 132mm；A4 可用宽 178mm，再宽就只能换行或溢出纸面）。 */
export const CHILD_FACTOR = 1.5;
export const BLANK_MAX_WIDTH_EM = 30;

/** 这条横线至少要几 em（含 1.5 倍书写余量；空答案返回 0） */
export function blankWidthEm(answer) {
  const need = needEm(answer);
  if (!need) return 0;
  return round(Math.min(BLANK_MAX_WIDTH_EM, need * CHILD_FACTOR));
}

/* 判"这个空的答案是不是长到不该塞进横线"：
   need（答案本身的排版宽度）> BLANK_MAX_EM ⇒ 该改 zone（横线再怎么撑都是把一句话硬塞进一行）；
   否则只要"声明宽度 < blankWidthEm（1.5 倍）"就算偏窄 —— 渲染器会自动撑宽，`修宽` 补数据基线。 */
export const BLANK_MAX_EM = 18;

/** 单空判定：{ok, need, want, width, why} */
export function judgeSlot(answer, width, fallbackEm) {
  const need = needEm(answer);
  const want = blankWidthEm(answer);
  const have = width == null ? (fallbackEm || 0) : width;
  if (need > BLANK_MAX_EM) return { ok: false, code: 'too-long', need, want, width: have, why: `答案需 ${need}em > 横线上限 ${BLANK_MAX_EM}em，应改为另留答题区` };
  if (have && want > have) return { ok: false, code: 'too-narrow', need, want, width: have, why: `横线 ${have}em < 需 ${want}em（答案 ${need}em × ${CHILD_FACTOR}）` };
  return { ok: true, code: 'ok', need, want, width: have, why: '' };
}

/**
 * 把逐空答案铺成"与空位等长"的数组（partial 用 answerSlotsAt 定位）。
 * ★ 2026-10-25 实测踩到：`answerScope=partial` 的合卡里，答案[0] 是**第 5 空**的答案，
 *   而 applySlotWidths 按数组下标往第 1 空上套 ⇒ 该宽的第 5 空没撑、不该宽的第 1 空被撑开
 *   （用户看到的还是"这条横线不够写"）。所以先按 answerSlotsAt 摊平，再交给渲染/写回。
 * 未登记答案的空位为 undefined（applySlotWidths 见到 undefined 保持原宽，绝不瞎撑）。
 */
export function alignedAnswers(answers, at, slotCount) {
  const list = Array.isArray(answers) ? answers : [];
  const n = Math.max(0, Number(slotCount) || 0);
  const nums = Array.isArray(at) ? at.map(Number) : null;
  if (!nums || !nums.length) return list.slice(0, n);
  const out = new Array(n);
  list.forEach((a, k) => {
    const pos = (nums[k] || 0) - 1;
    if (pos >= 0 && pos < n) out[pos] = a;
  });
  return out;
}

/**
 * 按答案把每个空撑到够宽（渲染唯一实现）。
 * @param {string} html   已净化的题干 HTML（可含 SVG）
 * @param {string[]} answers 逐空答案（顺序＝卷面顺序；缺项按 undefined 当作未知，保持原宽）
 * @param {object} [opts] { fallbackEm = 7, minEm = 4 }
 * @returns {string}
 */
export function applySlotWidths(html, answers, opts) {
  const o = Object.assign({ fallbackEm: 7, minEm: 4, onlySpan: false }, opts || {});
  const list = Array.isArray(answers) ? answers : [];
  const slots = slotsOf(html);
  if (!slots.length) return html;
  /* 从后往前替换，索引不失效 */
  let out = String(html);
  for (let k = slots.length - 1; k >= 0; k--) {
    const s = slots[k];
    /* onlySpan：只改已经写成 `<span class="blank">` 的空位。
       ⚠ 为什么要有这个开关：题干里的裸下划线串 `______` 是**正文的一部分**，
       把它换成 span 会改变"纯净文本"，而盲解指纹是对纯净文本+图形取的哈希 ⇒
       一改就整库盲解结论失效、组卷被门禁拦下。渲染器（model.js）在内存里换成 span 没问题，
       但**写回文件**只能动标签属性，绝不能动正文。 */
    if (o.onlySpan && s.kind !== 'span') continue;
    const raw = String(rawOf(out, s) || '');
    const ans = list[k];
    let width;
    if (ans == null || String(ans) === '') width = s.width == null ? o.fallbackEm : s.width;
    /* ★ 2026-10-25：宽度不再取 needEm，而取 blankWidthEm —— 答案所需 × 1.5 的小孩书写余量。
       见文件头 CHILD_FACTOR 段（用户 Y0003 原话「再放一个 1.5 倍的带下横线的空格出来」）。 */
    else width = round(Math.max(o.minEm, s.width == null ? 0 : s.width, blankWidthEm(ans)));
    out = out.slice(0, s.start) + rewrite(raw, s.kind, width, o) + out.slice(s.end);
  }
  return out;
}

function rawOf(html, slot) {
  const src = String(html);
  return src.slice(slot.start, slot.end);
}

/** 重写单个空位：span 规范化为 `<span class="blank" …>`；裸下划线串替换成 span；编号横线保留编号。
 *  ⚠ 2026-10-25 实测踩到（5 张语文卡当场变「待重盲解」）：早一版把 style 插在 class **之前**
 *  （`<span style="…" class="blank">`），而**盲解清稿**的 `stemToText()` 是按
 *  `<span class="blank"[^>]*>` 这个**属性顺序**把空位还原成 `________` 的 —— 顺序一变，还原失败
 *  ⇒ 纯净文本变了 ⇒ 盲解指纹失效 ⇒ 组卷被门禁拦下。
 *  所以这里固定输出 **class 在前**，min-width 只写在 style 内（不新增属性、不改顺序）。
 *  ⚠ 另一处实测：`____3____` 这种编号横线如果按普通下划线处理会被换成**两个** span
 *  （渲染后 8 空变成 16 个横线，答案对不上号）。现在整段换成**一个**空位，编号作为标签印在空位里。 */
export const numberedLabel = (raw) => {
  const m = /[0-9０-９]{1,3}/.exec(String(raw || ''));
  return m ? m[0].replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) : '';
};
function rewrite(raw, kind, widthEm, o) {
  const w = `${round(widthEm)}em`;
  if (kind !== 'span') {
    const n = numberedLabel(raw);
    if (n) return `<span class="blank" style="min-width:${w}"><span class="blank-no">${n}</span></span>`;
    return `<span class="blank" style="min-width:${w}"></span>`;
  }
  const m = /^<span\b([^>]*)>/i.exec(String(raw));
  if (!m) return raw;
  let attrs = m[1];
  const cls = /class\s*=\s*"([^"]*)"/i.exec(attrs);
  attrs = attrs.replace(/class\s*=\s*"[^"]*"/i, '');
  const st = /style\s*=\s*"([^"]*)"/i.exec(attrs);
  let styleVal;
  if (st) {
    styleVal = st[1];
    if (/\bmin-width\s*:/i.test(styleVal)) styleVal = styleVal.replace(/\bmin-width\s*:\s*[\d.]+\s*(em|px|mm)?/i, `min-width:${w}`);
    else styleVal = `min-width:${w};` + styleVal;
    attrs = attrs.replace(/style\s*=\s*"[^"]*"/i, '');
  } else styleVal = `min-width:${w}`;
  const rest = attrs.trim();
  const classPart = cls ? ` class="${cls[1]}"` : ' class="blank"';
  return `<span${classPart} style="${styleVal}"${rest ? ' ' + rest : ''}>`;
}

/** 「够不够写」整体判定：逐空对照声明答案（answers 需已按空位摊平，见 alignedAnswers） */
export function fitSlots(html, answers, opts) {
  const o = Object.assign({ fallbackEm: 7 }, opts || {});
  const slots = slotsOf(html);
  const list = Array.isArray(answers) ? answers : [];
  const out = { slots: slots.length, answers: list.length, bad: [] };
  slots.forEach((s, i) => {
    const ans = list[i];
    if (ans == null || String(ans) === '') return;          // 缺答案由"答案齐全"那条规则管
    const j = judgeSlot(ans, s.width, s.width == null ? o.fallbackEm : s.width);
    if (!j.ok) out.bad.push({ i: i + 1, kind: s.kind, width: j.width, need: j.need, want: j.want, code: j.code, answer: String(ans).slice(0, 30) });
  });
  return out;
}
