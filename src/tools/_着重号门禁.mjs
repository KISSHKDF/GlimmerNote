#!/usr/bin/env node
/**
 * 拾光小册 · 着重号（"加点字"）门禁（v1，2026-10-25 晚建）
 *
 * 起源（用户原话，指着印出来的 Y0001 试卷）：
 *   「从印刷体来看，你的打点能力很差，全库都是这样，如何加强？」
 * 实测根因**不是标错了字**，而是标记**没有外观**：
 *   题干里用 `<span class="rd">制</span>` 标加点字（全库 14 处 / 3 张卡），
 *   而 `app.css` 里从来没有 `.rd` 规则（新旧两版都没有）⇒ 加点字被当普通字印出来，
 *   Y0001「下列句中加点字词古今义相同的一项是」四个选项一个字都没有点。
 *   还有一层：`.rd` 被两套语义混用 —— 语文着重号（点在下）与数学循环节（点在上），
 *   混在一处就必然有一类印错。
 *
 * 判据（缺一条就红）：
 *   ① 题面（题干纯文本 + 索引 question）出现「加点/着重号」⇒ 题干里必须有 `.rd` 标记；
 *   ② 每个 `.rd` 必须**恰好一个汉字/字符**（点多落在一组字中间＝等于没标）；
 *   ③ `.rd` 不得写进 `<svg>`（图里加点靠图形，不靠 HTML span）；
 *   ④ `app.css` 里必须存在 `.rd` 的可见样式（本次事故的判据：规则被删=纸面立刻回到"没点"）；
 *   ⑤ 用了 `.rd` 但题面不提加点的，提示应改用 `.rd-above`（循环节）—— 只提示不阻断。
 *
 * 用法（node _着重号门禁.mjs <动作>）：
 *   扫描 [--json]   只读：逐卡列出标记使用与问题
 *   门禁 [--json]   判定：不合判据即退出码 1（人类模式与 --json 同码同判）
 *
 * ⚠ 与 `_作答门禁.mjs`（空位/答案）分工：那个管"空"和"答案"，这个管"标记能不能被看见"。
 */
import fs from 'fs';
import path from 'path';
import { libraryRoot } from './_库根.mjs';

const ROOT = libraryRoot();
const STEM = '题干.html';
const CSS_FILES = ['css/app.css'];          // 相对 WEB_APP：界面样式唯一真源

const argv = process.argv.slice(2);
const action = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith('--')) continue;
  const k = t.slice(2);
  if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i]; else opt[k] = true;
}

/* ---------- 题库发现（与其余门禁同规则） ---------- */
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
  for (const f of indexFiles(ROOT)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const base = path.dirname(f);
    const push = (it, subject, dirAbs) => out.push({ item: it, subject, dirAbs, key: (j.student || '?') + '|' + it.id });
    if (Array.isArray(j.items)) for (const it of j.items) push(it, j.subject || '', path.join(base, it.dir || it.id));
    if (j.subjects) for (const [n, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) push(it, n, path.join(base, n, it.dir || it.id));
  }
  return out;
}

/* ---------- 纯函数（导出给回归用例与其它工具复用） ---------- */
export const DOT_WORDS = /加点|着重号|加点字|加点词/;

/** 题干纯文本（去标签去 svg，空白压掉）——判"题面有没有要求加点"用 */
export function plainOf(html) {
  return String(html || '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, '');
}

/** 逐卡判定：返回 {ok, marks, problems[], warns[]} */
export function judgeCard({ stem = '', question = '', status = '' } = {}) {
  const html = String(stem || '');
  const svgMasked = html.replace(/<svg[\s\S]*?<\/svg>/gi, m => '\u0000'.repeat(m.length));
  const problems = [];
  const warns = [];

  /* 收集 rd 标记：span 内文本 + 是否在 svg 内 + 是否多字 */
  const marks = [];
  const re = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const cls = /class\s*=\s*"([^"]*)"/i.exec(attrs);
    if (!cls) continue;
    const toks = cls[1].split(/\s+/).filter(Boolean);
    if (toks.indexOf('rd') < 0) continue;
    const inner = m[2].replace(/<[^>]+>/g, '').replace(/\s|&nbsp;/g, '');
    const inSvg = svgMasked[m.index] === '\u0000';
    marks.push({ text: inner, chars: [...inner].length, inSvg, above: toks.indexOf('rd-above') >= 0, at: m.index });
  }

  const plain = plainOf(html);
  const saysDot = DOT_WORDS.test(plain) || DOT_WORDS.test(String(question || ''));
  const visible = marks.filter(x => !x.inSvg);

  /* ① 题面要加点却没有标记 */
  if (saysDot && !visible.length) problems.push({ code: 'dot-missing', msg: '题面要求「加点」但题干里没有 .rd 标记——印出来等于没加点' });
  /* ② 多字标记：点会落在一组字中间 */
  for (const x of visible) {
    if (x.chars !== 1) problems.push({ code: 'dot-multi', msg: `.rd 标记了 ${x.chars} 个字（「${x.text.slice(0, 12)}」）——着重号必须一字一个标记，点多只落在一组中间` });
  }
  /* ③ 图里加点不该用 span */
  for (const x of marks.filter(v => v.inSvg)) {
    problems.push({ code: 'dot-in-svg', msg: `.rd 写在 <svg> 里（「${x.text.slice(0, 8)}」）：图上的点请画在 SVG 图形层，span 在 SVG 内无效` });
  }
  /* ⑤ 有标记但题面不提加点 → 多半是循环节，应改 rd-above（只提示） */
  if (visible.length && !saysDot && visible.every(x => !x.above)) {
    warns.push('用了 .rd 但题面没有「加点」字样——若是数学循环节应改用 class="rd rd-above"（点在字上）');
  }
  /* 语义一致：题面说加点，标记却点了"上方"（rd-above）→ 提示 */
  if (saysDot && visible.length && visible.every(x => x.above)) {
    warns.push('语文着重号应点在字下，这里全部用了 rd-above（点在字上）——确认不是循环节');
  }
  const archived = String(status || '') === '已归档';
  return { ok: problems.length === 0, marks, problems, warns, saysDot, archived };
}

/** 样式判定：CSS 里 `.rd` 必须有可见的着重号外观（本次事故的判据） */
export function judgeCss(cssText) {
  const css = String(cssText || '');
  const problems = [];
  const hasRule = /\.rd(?![-\w])/.test(css);
  if (!hasRule) problems.push({ code: 'style-missing', msg: 'app.css 里没有 .rd 规则——加点字会被当普通字印出来（2026-10-25 Y0001 事故原样）' });
  /* ★ 2026-10-31（codex C05，已实测复现）：判据必须**只看那条 ::after 规则自己的声明体**。
     旧实现是 `规则存在` && `/(border-radius|background)/.test(整份 CSS)`——
     第二个条件搜的是**整份样式表**，只要任意元素有背景/圆角它就恒为真。
     于是 `.rd::after { content: none; }` + 别处随便一条 background 就能通过：
     着重号根本不生成，门禁却是绿的（这正是"判据比写法、不比解析结果"的老毛病）。
     新判据（逐条）：
       ① `.rd…::after` 规则体里必须有**有效 content**（`none`/`normal`/空串 = 不生成伪元素）；
       ② 同一个规则体里必须有**画得出来的形态**：border-radius 或 background（圆点）；
       ③ 尺寸不能塌成 0（width/height 若显式声明则必须 > 0）。
     判据自证：tests\neg-emphasis-mark.cjs 的 Z 段（掏掉任一条都要红）。 */
  const afterRules = [...css.matchAll(/\.rd(?![-\w])[^{}]*::?after\s*\{([^}]*)\}/g)].map(m => m[1]);
  const declOf = (body, prop) => {
    const m = new RegExp('(^|[;{\\s])' + prop + '\\s*:\\s*([^;}]+)', 'i').exec(body);
    return m ? m[2].trim() : null;
  };
  const rulePaints = afterRules.some(body => {
    const content = declOf(body, 'content');
    /* 没有 content 声明 ⇒ 伪元素不生成（浏览器不给 ::after 默认内容） */
    if (content == null) return false;
    /* content: none/normal ⇒ 明确不生成；`content:''`（空串）**是合法且常见写法**
       （本仓生产 CSS 就是 `content:''` + 圆点几何），绝不能当成"空内容看不见"。 */
    if (/^(none|normal|inherit|initial|unset)$/i.test(content)) return false;
    if (!/(border-radius|background)/i.test(body)) return false;  // 有内容但没形状 ⇒ 还是个透明盒子
    for (const p of ['width', 'height']) {
      const v = declOf(body, p);
      if (v != null && /^0*(\.0+)?\s*(em|px|rem|mm|%)?$/i.test(v)) return false;   // 显式塌成 0
    }
    return true;
  });
  if (hasRule && !rulePaints) problems.push({ code: 'style-invisible', msg: '.rd 规则存在但画不出点（::after 规则体里缺有效 content 或 border-radius/background）——纸面上仍然看不见' });
  /* 明确藏起来的一律算事故 */
  const hidden = /\.rd[^{]*\{[^}]*(display\s*:\s*none|visibility\s*:\s*hidden)/.test(css);
  if (hidden) problems.push({ code: 'style-hidden', msg: '.rd 被 display:none / visibility:hidden 藏起来了' });
  return { ok: problems.length === 0, problems };
}

/* ---------- CLI ---------- */
const cssPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'app', CSS_FILES[0]);
const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';

switch (action) {
  case '扫描':
  case '门禁': {
    const cards = allCards();
    const rows = cards.map(x => {
      const p = path.join(x.dirAbs, STEM);
      const stem = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') : '';
      const r = judgeCard({ stem, question: x.item.question, status: x.item.status });
      return Object.assign({ key: x.key, id: x.item.id, subject: x.subject }, r);
    });
    const style = judgeCss(css);
    const blocked = rows.filter(r => !r.ok && !r.archived);
    const archivedBad = rows.filter(r => !r.ok && r.archived);
    const withMarks = rows.filter(r => r.marks.length);
    const json = {
      ok: blocked.length === 0 && style.ok,
      action,
      style: { ok: style.ok, problems: style.problems },
      stats: { total: rows.length, withMarks: withMarks.length, block: blocked.length, archivedSkipped: archivedBad.length },
      problems: [
        ...style.problems.map(p => `[全局样式] ${p.msg}`),
        ...blocked.map(r => `${r.key}[${r.problems.map(p => p.msg).join('；')}]`),
      ],
      cards: Object.fromEntries(rows.filter(r => r.marks.length || r.saysDot).map(r => [r.key, {
        marks: r.marks.length, above: r.marks.filter(m => m.above).length, saysDot: r.saysDot, ok: r.ok,
      }])),
    };

    if (opt.json) {
      console.log(JSON.stringify(json));
      if (!json.ok) process.exitCode = 1;
      break;
    }
    if (action === '扫描') {
      console.log(`着重号：${rows.length} 张卡，用了标记的 ${withMarks.length} 张，题面要求加点的 ${rows.filter(r => r.saysDot).length} 张`);
      if (!style.ok) for (const p of style.problems) console.log('⛔ [样式] ' + p.msg);
      for (const r of rows) {
        if (r.ok && !r.warns.length && !r.marks.length) continue;
        const n = r.marks.filter(m => !m.inSvg).length;
        console.log(`${r.key.padEnd(14)} ${String(r.subject).padEnd(3)} ${r.ok ? '✓' : '⛔'} 标记 ${n} 处${r.marks.some(m => m.above) ? '（含点在上 ' + r.marks.filter(m => m.above).length + '）' : ''}`);
        for (const p of r.problems) console.log('   ↳ ' + p.msg);
        for (const w of r.warns) console.log('   ⓘ ' + w);
      }
      console.log(`\n合计：阻断 ${blocked.length}，归档不阻断 ${archivedBad.length}`);
      break;
    }
    /* 门禁 */
    if (json.ok) {
      console.log(`着重号门禁通过：${withMarks.length} 张卡的加点标记都有可见样式（.rd 规则在位，且每个标记只点一个字）。`);
    } else {
      console.log(`⛔ 着重号门禁未通过：`);
      for (const p of json.problems) console.log('   ' + p);
      process.exitCode = 1;
    }
    break;
  }
  default:
    console.log('未知动作：' + action + '\n可用：扫描 / 门禁（均可加 --json）');
    process.exitCode = 2;
}
