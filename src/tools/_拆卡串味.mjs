#!/usr/bin/env node
/**
 * 拾光小册 · 「一道大题拆成多张卡 ⇒ 各自的题干不许带别人的答题空位」 —— **唯一实现**
 *
 * 为什么要有这个模块（2026-11-27 用户报障的根因）：
 *   用户原话：「某学生，M0067，在题干上特别写明：只收录第1小问，但实际上，
 *              你把第二小问也当成题目出给孩子了」
 *
 * 实测根因（与 2026-11-26 的 M0063 报障**是同一族、方向相反**）：
 *   · M0063 的毛病：题干抄了**整道大题**（两问都在）⇒ 但答案只答了错的那一问
 *     ⇒ 答案册缺答案（家长判不了另一问）。
 *   · M0067 的毛病：**同一道大题已经被拆成了两张卡**（M0067=①、M0068=②），
 *     可 M0067 的题干**还留着第②小问的文字和它的横线空位**
 *     ⇒ 卷面上那道②变成了一道**也要做**的题 ⇒ 孩子重做时多做了一题，
 *       而答案册里 M0067 只有①的答案、M0068 只有②的答案 ⇒ 两张卡各印一段，
 *       拼起来才对得上；单看 M0067 就是"多了一问却只有一答"。
 *   · 根源都一样：**「只收错的那一问」这条口径只写在配方里，没有机器判据**。
 *     配方说「带上大题条件」⇒ 人就把**整条题干**连着**别的问的空位**一起抄了。
 *
 * ── 判据（只认客观事实，不做语义推断） ────────────────────────────────
 *
 * **① 先分清"同一道大题被拆成几张卡"**：
 *   同一 `source` 前缀 + 末尾的小问编号（`第5题①` / `第5题②` / `解答20(2)`）⇒ 同一道题。
 *   判据取自卡自己的 `source`（唯一真源在索引里）。
 *
 * **② 什么算"串味"**：
 *   一张卡的题干里，**别的卡的小问编号后面跟着答题空位** ⇒ 那一问会被印成"也要做"。
 *   ⚠ 只认**答题空位**（`<span class="blank">` / ASCII 下划线 / 全角下划线）——
 *     光有别的编号的**文字**是**对的**（那是"大题条件"，配方明确要求带上；
 *     某张语文卡的表格里写「③（另卡）」也只是**引用**，不是"还要做一题"）。
 *   ⚠ 表格里的编号引用**不算**（见 ③）—— 否则会把引用当串味，误报一批卡。
 *
 * **③ 表格内的编号不算**：题干里 `<table>` 里的编号是表格**行/列标签**或**引用**
 *   （某张语文卡实测：单元格文本「③（另卡）」只是说明那一格在另一张卡上）。
 *
 * **④ 豁免**：
 *   · 题干里**本来就有多个空位、且都属于这一张卡自己的小问** ⇒ 不是串味
 *     （例：P0017 表格填空 7 个空、C0025 选物质 3 个空 —— 都是一道题的多个空）。
 *   · 卡**没有**标小问编号（多问整题）⇒ 一张卡就是整道题，不存在串味。
 *
 * 本模块**只做解析与判定**，不写盘、不改数据。写盘走 `_录题入库.mjs` / `_作答门禁.mjs`。
 */
import fs from 'fs';
import path from 'path';

/* ── 小问编号：①②… 与 (1)(2)… ── */
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

/** 从一个 source 尾巴上取小问编号（`…第5题①` → ①；`…解答20(2)` → (2)）；取不到返回 null */
export function sourceTag(source) {
  const s = String(source || '').trim();
  let m = s.match(/([①②③④⑤⑥⑦⑧⑨⑩])\s*$/);
  if (m) return m[1];
  m = s.match(/\(\s*([1-9])\s*\)\s*$/);
  if (m) return '(' + m[1] + ')';
  return null;
}

/** source 去掉末尾小问编号后的"同一道大题"标识 */
export function sourceBase(source) {
  return String(source || '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]\s*$/, '')
    .replace(/\(\s*\d\s*\)\s*$/, '')
    .replace(/第\s*\d+\s*题\s*$/, '')
    .trim();
}

/** 题干里的小问编号（按出现顺序，去重） */
export function marksIn(html) {
  const out = [];
  const re = /[①②③④⑤⑥⑦⑧⑨⑩]|\(\s*\d\s*\)/g;
  const t = String(html || '');
  let m;
  while ((m = re.exec(t)) !== null) {
    const tag = m[0].startsWith('(') ? '(' + m[0].replace(/[()\s]/g, '') + ')' : m[0];
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 题干里的答题空位个数（与 `_空位.mjs` 的口径一致：blank span / ASCII 下划线 / 全角下划线） */
export function blankCount(html) {
  const t = String(html || '');
  const spans = (t.match(/class="[^"]*\bblank\b/g) || []).length;
  const ascii = (t.match(/_{2,}/g) || []).length;
  const full = (t.match(/＿{2,}/g) || []).length;
  return spans + ascii + full;
}

/** 把题干 HTML 里的 `<table>…</table>` 挖掉（表格内的编号引用不算串味） */
export function outsideTables(html) {
  return String(html || '').replace(/<table[\s\S]*?<\/table>/gi, ' ');
}

/**
 * 一张卡的题干里，**别的卡的小问编号**后面是否跟着答题空位。
 * @param {string} html 题干 HTML
 * @param {string[]} otherTags 同组其它卡的小问编号
 * @returns {string[]} 串味的编号（去重）
 */
export function leakedMarks(html, otherTags) {
  if (!Array.isArray(otherTags) || !otherTags.length) return [];
  const outside = outsideTables(html);
  const out = [];
  const re = /([①②③④⑤⑥⑦⑧⑨⑩]|\(\s*\d\s*\))([\s\S]{0,200}?)(?:<span class="[^"]*\bblank\b|_{2,}|＿{2,})/g;
  let m;
  while ((m = re.exec(outside)) !== null) {
    const tag = m[1].startsWith('(') ? '(' + m[1].replace(/[()\s]/g, '') + ')' : m[1];
    if (otherTags.includes(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * 全库判据：把卡按"同一道大题"分组，逐组查串味。
 * @param {Array} cards [{id, source, stemHtml}]
 * @returns {{key:string, id:string, leaked:string[], own:string, blanks:number}[]}
 */
export function splitContamination(cards) {
  const groups = new Map();
  for (const c of cards || []) {
    const tag = sourceTag(c.source);
    if (!tag) continue;                       // 没标小问 ⇒ 多问整题，不存在串味
    const base = sourceBase(c.source);
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push({ ...c, tag });
  }
  const bad = [];
  for (const [base, list] of groups) {
    if (list.length < 2) continue;             // 只有一张 ⇒ 没有"别的卡"可串
    for (const c of list) {
      const others = list.filter(o => o.id !== c.id).map(o => o.tag);
      const leaked = leakedMarks(c.stemHtml, others);
      if (leaked.length) {
        bad.push({
          key: base, id: c.id, own: c.tag, leaked,
          blanks: blankCount(c.stemHtml),
        });
      }
    }
  }
  return bad;
}

/** 读一个库里所有卡的（id, source, stemHtml）；stemHtml 缺失时回落 question */
export function readCardsOfLibrary(libRoot) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const idx = path.join(abs, '_索引.json');
      if (fs.existsSync(idx)) {
        let j; try { j = JSON.parse(fs.readFileSync(idx, 'utf8').replace(/^\uFEFF/, '')); } catch { j = null; }
        if (j) {
          const multi = j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects);
          const rows = [];
          if (multi) for (const [sn, s] of Object.entries(j.subjects)) for (const it of (s.items || [])) rows.push([it, sn]);
          else for (const it of (j.items || [])) rows.push([it, j.subject || '']);
          for (const [it, sn] of rows) {
            const dir = it.dir || it.id;
            const hp = path.join(abs, sn, dir, '题干.html');
            let stemHtml = '';
            try { stemHtml = fs.readFileSync(hp, 'utf8'); } catch { }
            out.push({ id: it.id, source: it.source, stemHtml, question: it.question });
          }
        }
      }
      walk(abs, depth + 1);
    }
  };
  walk(libRoot, 0);
  return out;
}
