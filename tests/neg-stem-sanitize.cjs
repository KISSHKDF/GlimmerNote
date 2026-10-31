#!/usr/bin/env node
/* 阴性用例（安全审计 S01 / S04）：题干净化的**出口**必须 fail-closed，CSS/SVG 的 URL 型值必须被拦。
 *
 * 为什么要有这个文件
 * ─────────────────────────────────────────────────────────────────────────────
 * `题干.html` 由用户自己的 AI 生成，是**不可信输入**；`M.stemHtmlSafe` 是三处渲染点
 * （卷面 paper.qHtml / 抽屉 review.card / 题库 bank.openCard）共用的唯一净化实现。
 * 2026-10-30 审计实测出两条真缺陷，都是"判据对着**写法**比，而浏览器执行的是**解析结果**"：
 *
 *   ① S01 出口直通：白名单循环结束后 `out += s.slice(last)` 把**没被正则匹配到的原文**
 *      原样拼回。而那个正则只认**完整标签**（结尾必须有一个 `>`），浏览器的 HTML 解析器不是
 *      —— 末尾那截 `<img src=x onerror=…` 会被它当成"标签还没写完"，模板随后追加的 `</div>`
 *      正好补上缺失的 `>` ⇒ 残缺片段凭空变成**带事件属性的活标签**。
 *      实测三变体（末尾无 `>` / 引号未闭合 / 末尾裸 `<`）修复前全部原样返回。
 *   ② S04 值判据：style 只在**原文**里找字面 `url(`，而 CSS 允许反斜杠转义（`u\72l(`、
 *      `\75rl(` 解析后都是 url()）；SVG 的 fill/stroke/marker-* 更是**整条属性原值直通**，
 *      `fill="url(https://…)"` 一渲染就向外部发请求（离线工具的出网口被数据打开）。
 *
 * 本文件怎么避免"看起来在测、实质是打印"（同 neg-v2-smoke 的教训）
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 断言全部走 `A()`，按计数决定退出码；
 *   · 判据**不复用** M.cssUnescape / M.styleSafe / M.paintSafe —— 用被测实现自己证明自己
 *     是空话。本文件自带一份独立的 HTML/CSS 还原 + 活标签扫描（≈ 浏览器解析器的同义复现）；
 *   · 先跑"检测器有牙齿"的前置断言（造一个真缺陷，检测器必须叫出来），否则后面的"全绿"
 *     可能只是判据瞎了；
 *   · 再跑**阴性自证**：把修复从源码里掏掉（改回旧写法），同一批输入必须全数变红 ——
 *     这条证明"改坏了本用例会红"。锚点字符串找不到时**响亮失败**（不静默跳过），
 *     免得源码改个写法之后自证退化成空转。
 *
 * 不读任何题库数据（纯函数级，不需要 CTB_TEST_LIB）。用法：node tests/neg-stem-sanitize.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

let pass = 0, fail = 0;
const A = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [OK]  ' + label); return; }
  fail++;
  console.log('  [FAIL] ' + label + (detail ? '\n         → ' + String(detail).slice(0, 400) : ''));
};

/* ══════════════════════════════════════════════════════════════════════════
   一、装载**真实的** util/host/model（前端源码零依赖，可直接在 vm 里跑）
   modelSrc 可注入变异版本 —— 阴性自证要把修复"掏掉"再跑一遍同一批输入。
   ══════════════════════════════════════════════════════════════════════════ */
const frontSrc = f => fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8');

function loadV2(modelSrc) {
  const store = new Map();
  const sandbox = {
    console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap,
    isNaN, parseInt, parseFloat,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    window: { addEventListener() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['util.js', 'host.js']) vm.runInContext(frontSrc(f), sandbox, { filename: f });
  vm.runInContext(modelSrc, sandbox, { filename: 'model.js' });
  sandbox.CTB.model.applyState({ data: [] });
  /* 资产前缀用**不含盘符**的假 file:// 基址：用例不碰本机任何真实路径 */
  sandbox.CTB.host.mode = 'shell';
  sandbox.CTB.host.dataRootUrl = 'file:///LIB/';
  return sandbox.CTB;
}

const MODEL_SRC = frontSrc('model.js');
const CTB = loadV2(MODEL_SRC);
const M = CTB.model;

/* ══════════════════════════════════════════════════════════════════════════
   二、独立判据（**刻意不复用** M.* 的同类函数）
   ══════════════════════════════════════════════════════════════════════════ */
/* 属性值是 U.esc 过的，比较前先还原实体 */
function htmlUnesc(s) {
  return String(s == null ? '' : s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
/* CSS 反斜杠转义还原（十六进制最多 6 位 + 可吃掉一个空白；其余 `\c` 取 c） */
function cssUnesc(s) {
  return String(s == null ? '' : s)
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (m, hex) => {
      const cp = parseInt(hex, 16);
      return (cp > 0 && cp <= 0x10ffff) ? String.fromCodePoint(cp) : '';
    })
    .replace(/\\([\s\S])/g, '$1');
}
/* URL 型 = 一律算危险（含 ie 时代的 expression / behavior） */
const DANGER = /url\s*\(|image-set\s*\(|@import|expression\s*\(|-moz-binding|\bbehaviou?r\s*:|javascript\s*:|vbscript\s*:/i;
const PAINTS = ['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask', 'filter'];

/* 按 HTML 解析器的形态扫"活标签"：属性串允许把 `<` 当普通字符吃掉，
   并且**允许标签延伸到字符串末尾之后**（模板补的 `</div>` 会替它补上 `>`）。 */
function liveTags(html) {
  const out = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(html))) out.push({ name: m[1].toLowerCase(), attrs: m[2], raw: m[0] });
  return out;
}
function attrOf(tagRaw, name) {
  const m = new RegExp('(?:^|[\\s"])' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(tagRaw);
  return m ? htmlUnesc(m[1]) : null;
}
/* SVG 呈现属性的合法取值：none / 颜色 / 本地 #id 引用 */
function paintOk(v) {
  if (!v) return true;
  if (/^(?:none|currentcolor|transparent|inherit|initial|unset)$/i.test(v)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return true;
  if (/^(?:rgba?|hsla?)\s*\([^()]*\)$/i.test(v)) return true;
  if (/^[a-z]+$/i.test(v)) return true;
  /* 唯一允许的 url()：本地 #id 引用（`#` 后不限字符集 —— 题干里 id 可能是中文） */
  if (/^url\s*\(\s*(['"]?)#[^()'"\s]+['"]?\s*\)/i.test(v)) return true;
  return false;
}
/* 把一段"浏览器真会执行的东西"全部列出来；空数组 = 这段 HTML 没有活的可执行面。
   wrapper 模拟真实调用点：净化输出永远被拼进一个容器里（容器负责补那半个 `>`）。 */
const wrap = stem => '<div class="q-stem">' + stem + '</div>';
function scan(html) {
  const bad = [];
  for (const t of liveTags(html)) {
    if (/(?:^|[\s"'/=])on[a-z]+\s*=/i.test(t.attrs)) bad.push('事件属性 <' + t.name + '>' + t.attrs.slice(0, 70));
    const st = attrOf(t.raw, 'style');
    if (st != null) {
      const v = cssUnesc(st).replace(/\/\*[\s\S]*?\*\//g, '');
      if (DANGER.test(v)) bad.push('危险 style <' + t.name + '> = ' + v.slice(0, 90));
    }
    for (const p of PAINTS) {
      const raw = attrOf(t.raw, p);
      if (raw == null) continue;
      const v = cssUnesc(raw).trim();
      if (!paintOk(v)) bad.push('远程/危险 ' + p + ' <' + t.name + '> = ' + v.slice(0, 90));
    }
  }
  return bad;
}
/* 净化某张合成卡（卡目录取一个**不含盘符**的假相对路径，避免任何本机路径） */
const CARD_DIR = '九年级/数学/T0000-用例/错题记录.md';
const safe = stemHtml => M.stemHtmlSafe({ id: 'T0000', md: CARD_DIR, stemHtml: stemHtml });
const show = s => (VERBOSE ? '\n         输出 = ' + JSON.stringify(s) : '\n         输出 = ' + JSON.stringify(String(s).slice(0, 300)));

/* ══════════════════════════════════════════════════════════════════════════
   三、判据自证（先证明"检测器不瞎"，否则后面的全绿都是空真）
   ══════════════════════════════════════════════════════════════════════════ */
console.log('═══ 0. 判据自证：检测器必须能叫出真缺陷 ═══');
A('检测器能认出事件属性（否则 S01 段的"无 on*"恒真）',
  scan(wrap('<img src=x onerror=alert(1)>')).length > 0, '造串未被抓到');
A('检测器能认出 CSS 转义后的 url(（否则 S04 段恒真）',
  scan(wrap('<div style="background:u\\72l(https://evil.invalid/a.png)">x</div>')).length > 0, '造串未被抓到');
A('检测器能认出 SVG fill=url(远程)',
  scan(wrap('<svg><rect width="10" height="10" fill="url(https://evil.invalid/p.svg)"/></svg>')).length > 0, '造串未被抓到');
A('检测器不误伤正常标签（白名单里的 style/SVG 必须判干净）',
  scan(wrap('<div style="width:6em;display:flex"><svg><path d="M0 0 L1 1" fill="#f00" marker-end="url(#m)"/></svg></div>')).length === 0,
  scan(wrap('<div style="width:6em;display:flex"><svg><path d="M0 0 L1 1" fill="#f00" marker-end="url(#m)"/></svg></div>')).join(' '));

/* ══════════════════════════════════════════════════════════════════════════
   四、S01：尾部残缺标签不得原样直通
   每条第三个元素 = 「修复前是否真的产生**事件属性**」。为什么不是每条都 true：
   引号未闭合那条（`<img src="x onerror=…`）在浏览器里会把后续标记整截吞进未闭合的
   src 值，直到别处出现下一个 `"` 才结束 —— 它泄露的是**原始标记**（页面结构被撑坏），
   但这一次不一定活出 onerror。判据必须照实写，否则"期望值"就成了我编的。
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n═══ 1. S01 净化出口 fail-closed ═══');
const S01 = [
  ['末尾无 `>`', '<img src=x onerror=document.body.dataset.injected=1 ', true],
  ['引号未闭合', '<img src="x onerror=alert(1)', false],
  ['末尾裸 `<`', '<img src=x onerror=alert(1)<', true],
  ['合法前缀 + 残缺尾部', '<p>正常题干</p><img src=x onerror=alert(1)', true],
  ['合法前缀 + 残缺 svg', '<p>正常</p><svg onload=alert(1)', true],
];
const s01Out = [];
for (const [label, input] of S01) {
  const out = safe(input);
  s01Out.push(out);
  const harm = scan(wrap(out));
  A('S01 ' + label + '：渲染后没有活的事件属性', harm.filter(x => /事件属性/.test(x)).length === 0, harm.join(' ｜ ') + show(out));
  /* 裸标签：输出自身不得出现"能被解析成标签"的 <img / <svg */
  A('S01 ' + label + '：不产生裸标签（<img / <svg 只剩转义文本）',
    !/<(?:img|svg)\b/i.test(out), show(out));
  A('S01 ' + label + '：所有活标签都在白名单内',
    liveTags(wrap(out)).every(t => M.STEM_TAGS.indexOf(t.name) >= 0),
    liveTags(wrap(out)).map(t => t.name).join(',') + show(out));
}
A('S01 残缺片段以**转义文本**保留（fail-closed 转义，而不是静默丢弃原文）',
  /&lt;img/i.test(s01Out[0]) && /&lt;svg/i.test(s01Out[4]), JSON.stringify([s01Out[0], s01Out[4]]));
A('S01 合法前缀不受影响（正常段落仍原样渲染）',
  s01Out[3].indexOf('<p>正常题干</p>') === 0, show(s01Out[3]));
A('S01 末尾正文里的实体引用不被二次转义（`&`/`>` 保留，口径与中段一致）',
  safe('<p>a</p>&nbsp;>') === '<p>a</p>&nbsp;>', JSON.stringify(safe('<p>a</p>&nbsp;>')));
/* 已知边界（写进断言是为了别让人误以为"末尾修好了就等于整类都修好了"）：
   同一截残缺片段放在**中段**时，浏览器会把后面的标记吞进未闭合的引号值里，
   不会活出事件属性 —— 可执行面只在末尾（根因与不修中段的理由见 model.js 的 S01 注释段）。
   这条只钉"不产生事件属性"；中段残留导致的**内容缺失**是修复前就有的另一件事。 */
{
  const midHtml = safe('<img src="x onerror=document.body.dataset.injected=1 <p>正常</p>');
  A('已知边界 · 中段残缺片段不会活出事件属性（可执行面只在末尾，故本次只改末尾）',
    scan(wrap(midHtml)).filter(x => /事件属性/.test(x)).length === 0, show(midHtml));
}

/* ══════════════════════════════════════════════════════════════════════════
   五、S04：style / SVG 呈现属性里的 URL 型值必须被拦
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n═══ 2. S04 CSS/SVG URL 型值 ═══');
/* 每条第三个元素 = 「修复前是否漏过」。哪些旧判据本来就能拦（值里含**字面** url( 的那些），
   必须照实标 false —— 否则阴性自证会把"旧代码早就拦住了"错算成"漏过"，期望值就成了编的。 */
const S04 = [
  ['CSS 十六进制转义 u\\72l(', '<div style="background:u\\72l(https://evil.invalid/a.png)">甲</div>', true],
  ['CSS 转义 u\\72 l(（空白终止）', '<div style="background:u\\72 l(https://evil.invalid/b.png)">甲</div>', true],
  ['CSS 转义 \\75rl(', '<div style="background:\\75rl(https://evil.invalid/c.png)">甲</div>', true],
  ['CSS 注释劈开 u/**/rl(', '<div style="background:u/**/rl(https://evil.invalid/d.png)">甲</div>', true],
  ['SVG fill=url(远程)', '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="url(https://evil.invalid/p.svg)"/></svg>', true],
  ['SVG stroke 转义 url', '<svg><path d="M0 0 L1 1" stroke="\\75rl(https://evil.invalid/s.svg)"/></svg>', true],
  ['style image-set(远程串，不带 url()', '<div style="background:image-set(\'https://evil.invalid/i.png\' 1x)">甲</div>', true],
  ['style -webkit-image-set(远程串)', '<div style="background:-webkit-image-set(\'https://evil.invalid/j.png\' 1x)">甲</div>', true],
  ['SVG marker-start=url(远程)', '<svg><path d="M0 0 L1 1" marker-start="url(https://evil.invalid/m.svg)"/></svg>', true],
  ['SVG fill=javascript:', '<svg><rect width="10" height="10" fill="javascript:alert(1)"/></svg>', true],
  ['style 转义 expression(', '<div style="width:\\65 xpression(alert(1))">甲</div>', true],
  ['style @import 远程串（不带 url()）', '<div style="@import \'https://evil.invalid/x.css\'">甲</div>', true],
  /* 对照组：值里含**字面** url(，旧判据本来就能拦 —— 标 false，用来钉住"新旧都不许漏" */
  ['style image-set(url(...))（旧判据本可拦）', '<div style="background-image:image-set(url(https://evil.invalid/k.png) 1x)">甲</div>', false],
  ['style @import url(...)（旧判据本可拦）', '<div style="@import url(https://evil.invalid/y.css)">甲</div>', false],
];
for (const [label, input] of S04) {
  const out = safe(input);
  const harm = scan(wrap(out));
  A('S04 ' + label + '：渲染后没有远程/危险值', harm.length === 0, harm.join(' ｜ ') + show(out));
  /* 拦的是 URL 型值，不是整段题干：文字与图形本体必须还在 */
  A('S04 ' + label + '：正文与标签结构保留（只摘危险属性）',
    /甲|d="M0 0 L1 1"|width="10"/.test(out), show(out));
}
A('S04 本地引用 url(#id) 必须保留（pattern/marker 的合法用法，不许一刀切）',
  /marker-end="url\(#m\)"/.test(safe('<svg><path d="M0 0 L1 1" marker-end="url(#m)"/></svg>'))
  && /fill="url\(#p1\)"/.test(safe('<svg><rect width="10" height="10" fill="url(#p1)"/></svg>')),
  JSON.stringify(safe('<svg><path d="M0 0 L1 1" marker-end="url(#m)"/></svg>')));
/* 中文 id / 带 fallback 的本地引用也必须保留：存量题干里这两写法都可能出现，
   把安全修复做成"纹理填充整块变黑"就是版面回归（用户看得见）。 */
A('S04 本地引用不限 ASCII（url(#图案) 这类中文 id 必须保留）',
  /fill="url\(#图案\)"/.test(safe('<svg><rect width="10" height="10" fill="url(#图案)"/></svg>')),
  JSON.stringify(safe('<svg><rect width="10" height="10" fill="url(#图案)"/></svg>')));
A('S04 本地引用带 fallback 颜色必须保留（url(#p1) none）',
  /fill="url\(#p1\) none"/.test(safe('<svg><rect width="10" height="10" fill="url(#p1) none"/></svg>')),
  JSON.stringify(safe('<svg><rect width="10" height="10" fill="url(#p1) none"/></svg>')));
A('S04 字面 url( 也照拒（URL 型一律拒，不看它是怎么写的）',
  !/style=/.test(safe('<div style="background:url(#local)">甲</div>')),
  JSON.stringify(safe('<div style="background:url(#local)">甲</div>')));

/* ══════════════════════════════════════════════════════════════════════════
   六、承重对照组：修复不得收窄既有能力（本仓历史缺陷对应的形状，逐条都在真库出现过）
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n═══ 3. 对照组：既有能力一条都不许丢 ═══');
const keepStyle = safe('<div style="width:6em;display:flex">甲</div>');
A('分数/表格布局的 style 原样保留（width:6em;display:flex）',
  keepStyle === '<div style="width:6em;display:flex">甲</div>', JSON.stringify(keepStyle));
A('max-width 保留（题图不许撑破卷面，neg-stem-img-fit 的承重墙）',
  /style="max-width:820px"/.test(safe('<img src="题图.jpg" style="max-width:820px">')));
A('表格结构与单元格 style 保留',
  safe('<table style="width:60mm"><tr><td colspan="2" style="text-align:center">甲</td></tr></table>')
    === '<table style="width:60mm"><tr><td colspan="2" style="text-align:center">甲</td></tr></table>',
  JSON.stringify(safe('<table style="width:60mm"><tr><td colspan="2" style="text-align:center">甲</td></tr></table>')));
const keepSvg = safe('<svg viewBox="0 0 10 10"><path d="M0 0 L1 1" fill="#f00" stroke="#333" stroke-width="2"/><circle cx="5" cy="5" r="2" fill="none"/></svg>');
A('SVG 的 d/points/几何属性保留', /d="M0 0 L1 1"/.test(keepSvg) && /<circle cx="5" cy="5" r="2"/.test(keepSvg), JSON.stringify(keepSvg));
A('SVG 的颜色值保留（#f00 / #333 / none）',
  /fill="#f00"/.test(keepSvg) && /stroke="#333"/.test(keepSvg) && /fill="none"/.test(keepSvg), JSON.stringify(keepSvg));
A('命名颜色 / rgb() 颜色值保留',
  /fill="red"/.test(safe('<svg><rect fill="red"/></svg>')) && /stroke="rgb\(0, 0, 0\)"/.test(safe('<svg><rect stroke="rgb(0, 0, 0)"/></svg>')));
/* F-57：相对引用必须仍解析到**卡片目录**（asset 会对整段做 encodeURI，比较前先还原） */
const relImg = safe('<img src="题图.jpg">');
A('F-57 相对图重写仍生效（解析到卡片目录 → file:///LIB/九年级/数学/T0000-用例/题图.jpg）',
  /src="file:\/\/\/LIB\/九年级\/数学\/T0000-用例\/题图\.jpg"/.test(decodeURIComponent(relImg)), JSON.stringify(relImg));
/* F-58：fig 兜底 */
const figOut = M.stemHtmlSafe({ id: 'T0000', md: CARD_DIR, fig: '九年级/数学/T0000-用例/题图.jpg', stemHtml: '<p>制氧装置</p>' });
A('F-58 fig 兜底仍生效（无内联图时补出题图）', /stem-figure/.test(figOut) && /<img /.test(figOut), JSON.stringify(figOut));
A('F-58 已有内联图时不重复补', (M.stemHtmlSafe({ id: 'T0000', md: CARD_DIR, fig: '九年级/数学/T0000-用例/题图.jpg', stemHtml: '<img src="题图.jpg">' }).match(/<img/g) || []).length === 1);
/* 空位（2026-10-25 两条用户报障的护栏） */
A('空位转换仍生效（______ → .blank，min-width:7em）',
  /<span class="blank" style="min-width:7em"><\/span>/.test(safe('<p>由______构成</p>')), JSON.stringify(safe('<p>由______构成</p>')));
A('svg 内部的下划线不被当空位（旧口径保持）',
  !/blank/.test(safe('<svg><text x="0" y="10">A____B</text></svg>')));
A('逐空答案撑宽仍生效（answerSlots → min-width 变宽）',
  /min-width:1[0-9.]+em/.test(M.stemHtmlSafe({ id: 'T0000', md: CARD_DIR, stemHtml: '<p><span class="blank" style="width:6em"></span></p>', answerSlots: ['忽复乘舟梦日边'] })));
A('非白名单标签仍丢标签留正文', safe('<p>甲</p><font color="red">乙</font>') === '<p>甲</p>乙', JSON.stringify(safe('<p>甲</p><font color="red">乙</font>')));

/* ══════════════════════════════════════════════════════════════════════════
   七、阴性自证：把修复从源码里掏掉，同一批输入必须全数变红
   （锚点找不到 ⇒ 响亮失败。静默跳过等于让自证退化成空转 —— neg-v2-smoke 的老教训。）
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n═══ 4. 阴性自证：掏掉修复必须复现缺陷 ═══');
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) throw new Error('变异锚点不存在（源码改写法了，请同步本文件的锚点）: ' + from.slice(0, 80));
  return src.split(from).join(to);
}
/* 旧判据原文（修复前 model.js filterAttrs 里那一行），String.raw 保留反斜杠 */
const OLD_STYLE_CHECK = String.raw`if (/url\s*\(|expression\s*\(|javascript:|behavio[u]?r\s*:|-moz-binding/i.test(v)) continue;`;
let old = null, oldErr = '';
try {
  let src = MODEL_SRC;
  /* ① 出口改回"尾部原文直通" */
  src = mutate(src, 'out += M.escapeStemTail(s.slice(last));', 'out += (s.slice(last));');
  /* ② style 判据改回旧的字面 url( 正则 */
  src = mutate(src, 'if (!M.styleSafe(v)) continue;', OLD_STYLE_CHECK);
  /* ③ SVG 呈现属性不做 URL 检查（旧行为：整条原值直通） */
  src = mutate(src, 'if (!M.paintSafe(v)) continue;', ';');
  old = loadV2(src);
} catch (e) {
  oldErr = e.message;
}
A('阴性自证前置：变异版能装载（锚点都在）', !!old, oldErr);
if (old) {
  const oldSafe = stemHtml => old.model.stemHtmlSafe({ id: 'T0000', md: CARD_DIR, stemHtml: stemHtml });
  /* ① 出口：旧代码把**原始标记**整截直通（`<img`/`<svg` 真的进了 HTML 通道） */
  const rawLeak = S01.filter(([, input]) => /<(?:img|svg)\b/i.test(oldSafe(input))).map(([l]) => l);
  A('阴性自证 · 掏掉出口转义后，S01 五个变体**全部**把原始标记直通（旧代码 = 残缺片段进了 HTML）',
    rawLeak.length === S01.length, '只漏 ' + rawLeak.length + '/' + S01.length + '：' + rawLeak.join('、'));
  /* ② 出口：该活出事件属性的那些变体，旧代码里**都**活了 */
  const evExpect = S01.filter(([, , ev]) => ev).map(([l]) => l);
  const evLeak = evExpect.filter(l => scan(wrap(oldSafe(S01.find(x => x[0] === l)[1]))).some(x => /事件属性/.test(x)));
  A('阴性自证 · 该产生事件属性的 ' + evExpect.length + ' 个变体在旧代码里**全部**产生（on* 真的会执行）',
    evLeak.length === evExpect.length, '只复现 ' + evLeak.length + '/' + evExpect.length + '：' + evLeak.join('、'));
  /* ③ 期望值不是编的：标 false 的那条，旧代码确实**不**产生事件属性 */
  const evQuiet = S01.filter(([, , ev]) => !ev).every(([, input]) => !scan(wrap(oldSafe(input))).some(x => /事件属性/.test(x)));
  A('阴性自证 · 「引号未闭合」那条只泄露原始标记、不产生事件属性（期望值与实测一致，不是编的）', evQuiet,
    S01.filter(x => !x[2]).map(([, input]) => JSON.stringify(oldSafe(input))).join(' '));
  /* ④ S04：漏过集合必须与"修复前漏过"的清单**逐一相等** */
  const leaked = S04.filter(([, input]) => scan(wrap(oldSafe(input))).length > 0).map(([l]) => l);
  const expectLeak = S04.filter(([, , isNew]) => isNew).map(([l]) => l);
  A('阴性自证 · 换回旧判据后，「修复前漏过」的 ' + expectLeak.length + ' 条 S04 变体**全数**漏过',
    leaked.length === expectLeak.length && expectLeak.every(l => leaked.indexOf(l) >= 0),
    '实测漏过 ' + leaked.length + ' 条：' + leaked.join('、'));
  A('阴性自证 · 旧判据本来就能拦下的 ' + (S04.length - expectLeak.length) + ' 条现在也仍被拦（值里含字面 url( ⇒ 新旧都不许漏）',
    S04.filter(([, , isNew]) => !isNew).every(([, input]) => scan(wrap(oldSafe(input))).length === 0),
    S04.filter(([, , isNew]) => !isNew).map(([, input]) => JSON.stringify(oldSafe(input))).join(' '));
  /* ⑤ 反向：变异版对**对照组**必须仍然正确 —— 否则说明阳性断言根本不是"修复带来的" */
  A('阴性自证 · 变异版对正常 style/svg 仍然正确（说明红的是缺陷输入，不是整段失能）',
    oldSafe('<div style="width:6em;display:flex">甲</div>') === '<div style="width:6em;display:flex">甲</div>'
    && /fill="#f00"/.test(oldSafe('<svg><path d="M0 0 L1 1" fill="#f00"/></svg>')));
}

console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + ' 断言=' + (pass + fail) + (fail ? ' 失败=' + fail : ''));
process.exit(fail === 0 ? 0 : 1);
