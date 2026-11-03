#!/usr/bin/env node
/**
 * 拾光小册 · 批次 3 阴性对照：公开仓贡献通道（Issue 表单 / PR 模板 / labels 四档结论 / CONTRIBUTING 节）
 * （2026-11-03 建，T3）
 *
 * 守什么：批次 3 公开仓那一侧的口径，在**四处**必须一致，而且**只写一边就必须红**：
 *   · `.github\ISSUE_TEMPLATE\experience.yml` —— 收集字段集合 == 契约 §3.1 七项（逐项对拍）；
 *   · `.github\pull_request_template.md` —— 既有标题一行不丢；新增的「经验贡献」段真的是**可选**段；
 *   · `.github\labels.yml` —— 四档状态**不是**标签（上限 10 已用满），结论与前提都登记在案；
 *   · `CONTRIBUTING.md §八` —— 复核六项 + 启停对照口径 + 「维护者不采信未附反例的贡献」。
 *
 * 为什么必须机检（而不是靠人读一遍）：
 *   ① 表单的立身之本是"**从零组装**"：表单里没有的字段，就是这次不收的字段。少一项、或多一个
 *      "补充信息"自由框，都是一条绕过白名单的通道 —— 而"少了哪一项"肉眼很难发现；
 *   ② 四档被**刻意**做成标题前缀而不是标签，这个结论带**前提**（标签上限 10 且已用满）。
 *      前提一变结论就该重评，靠记忆守不住 ⇒ 这里把前提也写成断言；
 *   ③ 本仓已有真实事故：同一条口径在两地各写一份，改了一边另一边就漂移（"一份事实一个家"）。
 *
 * 零依赖（本仓铁律）：不引 js-yaml，自带一个**最小 YAML 解析器**（只认 GitHub 表单 / labels 用到的
 * 那一小撮语法：缩进映射 / 缩进序列 / 块标量 `|` / 行内流式数组 / 引号标量）。它 **fail-closed**：
 * 遇到不认识的形态抛错，而不是"看不懂就当没有" —— 静默放过正是本仓最忌的。
 * 解析器自己另有两条自证：制表符缩进与缩进错位必须抛错；块标量里的 `###` 与全角冒号不许被当结构。
 *
 * 夹具纪律：**不建任何临时目录、不读写用户库、不需要 exe、不联网**。阴性对照全部是"把真文件的文本
 * 在**内存里**改坏，再把同一批判据函数喂给它" ⇒ 无需在 `tests\_测试环境.cjs` 的 TMP_PREFIXES 登记前缀，
 * 也不会因为半路被杀而在 %TEMP% 留残渣。
 *
 * 用法：node tests\neg-contrib-templates.cjs
 * 登记：由 Lead 统一登记进 `tests\run.mjs`（本用例自己**不碰** run.mjs —— 那是一份事实一个家）。
 * 退出码：0=PASS（含全部阴性对照）/ 1=FAIL
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FILE = {
  form: path.join(REPO, '.github', 'ISSUE_TEMPLATE', 'experience.yml'),
  pr: path.join(REPO, '.github', 'pull_request_template.md'),
  labels: path.join(REPO, '.github', 'labels.yml'),
  contrib: path.join(REPO, 'CONTRIBUTING.md'),
};

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}
const cut = (s, n) => String(s || '').slice(0, n || 160);

/* ══════════════════════════════════════════════════════════════════════════
   最小 YAML 解析器（零依赖）
   认：`key: value` / `key:` + 更深缩进的子块 / `- 标量` / `- key: value` 起头的映射项 /
       块标量 `|`（保留相对缩进，clip 掉尾部空行）/ 行内流式数组 `[a, b]` / 单双引号标量。
   不认（遇到就抛错）：锚点与别名、多文档、`>` 折叠、流式映射、显式标签（!!）、制表符缩进。
   ⚠ 键必须是 `[A-Za-z_][A-Za-z0-9_-]*` 这种纯词：这样一来中文行里的全角冒号、
     以及块标量里的 `###`、反引号、`http://` 都不会被误当结构 —— 宽松解析会"看不懂也当看懂"。
   ══════════════════════════════════════════════════════════════════════════ */
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;
const BLOCK_RE = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*\|[-+]?[ \t]*$/;

function unquote(v) {
  v = v.trim();
  const q = v[0];
  if (v.length >= 2 && (q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1);
  return v;
}
function parseFlowSeq(v) {
  const inner = v.slice(1, -1).trim();
  if (inner === '') return [];
  const parts = [];
  let cur = '', q = null;
  for (const c of inner) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ',') { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter((x) => x !== '');
}
function scalar(v) {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) return parseFlowSeq(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return unquote(v);
}
function tokenize(src) {
  const lines = src.replace(/^\uFEFF/, '').split(/\r?\n/);
  const toks = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) { i++; continue; }
    const indent = raw.length - raw.trimStart().length;
    if (raw.slice(0, indent).includes('\t')) throw new Error(`第 ${i + 1} 行：YAML 不许用制表符缩进`);
    const content = raw.trim();
    const bm = BLOCK_RE.exec(content);
    if (bm) {                                  /* 块标量：后面的行是**内容**，不是结构 */
      const key = bm[1];
      const buf = [];
      let base = null;
      const no = i + 1;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (/^\s*$/.test(l)) { buf.push(''); i++; continue; }
        const ind2 = l.length - l.trimStart().length;
        if (ind2 <= indent) break;
        if (base === null) base = ind2;
        buf.push(l.slice(Math.min(base, ind2)));
        i++;
      }
      while (buf.length && buf[buf.length - 1] === '') buf.pop();
      toks.push({ indent, text: content, no, key, val: undefined, block: buf.join('\n') });
      continue;
    }
    if (content === '-' || content.startsWith('- ')) {   /* 序列项：归一化成"虚拟 +2 缩进" */
      toks.push({ indent, text: '-', no: i + 1, marker: true });
      const rest = content.slice(1).trim();
      if (rest !== '') {
        const km = KEY_RE.exec(rest);
        if (!km) throw new Error(`第 ${i + 1} 行：序列项不是 key: 形态（本解析器只认映射项）—— ${JSON.stringify(rest)}`);
        toks.push({ indent: indent + 2, text: rest, no: i + 1, key: km[1], val: km[2] === undefined ? '' : km[2] });
      }
      i++;
      continue;
    }
    const km = KEY_RE.exec(content);
    if (!km) throw new Error(`第 ${i + 1} 行：既不是 key: 也不是 - 项（本解析器不认这种形态）—— ${JSON.stringify(content)}`);
    toks.push({ indent, text: content, no: i + 1, key: km[1], val: km[2] === undefined ? '' : km[2] });
    i++;
  }
  return toks;
}
function parseYaml(src) {
  const toks = tokenize(src);
  if (!toks.length) throw new Error('文件里没有任何可解析的键值行');
  let pos = 0;
  const peek = () => toks[pos];
  function parseBlock(indent) {
    return (peek().text === '-' && peek().indent === indent) ? parseSeq(indent) : parseMap(indent);
  }
  function parseSeq(indent) {
    const out = [];
    while (peek() && peek().indent === indent && peek().text === '-') {
      pos++;
      const nxt = peek();
      if (nxt && nxt.indent > indent) out.push(parseBlock(nxt.indent));
      else out.push(null);
    }
    return out;
  }
  function parseMap(indent) {
    const out = {};
    while (peek() && peek().indent === indent && peek().text !== '-') {
      const t = peek();
      if (t.block !== undefined) { out[t.key] = t.block; pos++; continue; }
      pos++;
      if (t.val !== '' && t.val !== undefined) { out[t.key] = scalar(t.val); continue; }
      const nxt = peek();
      out[t.key] = (nxt && nxt.indent > indent) ? parseBlock(nxt.indent) : null;
    }
    return out;
  }
  const doc = parseBlock(toks[0].indent);
  if (pos !== toks.length) {
    throw new Error(`第 ${toks[pos].no} 行：缩进/结构与上下文对不上（解析在 ${pos}/${toks.length} 个记号处停下）`);
  }
  return doc;
}

/* ══════════════════════════════════════════════════════════════════════════
   判据常量（真源：`批次3-接口契约-20261103.md` §3.1 = 表单收哪七项；§1.2 = 草稿字段白名单）
   为什么把这些词表写在这里：它们是**契约的锁**，不是文档的副本 —— 用例红了正是"要回来对一遍契约"。
   ══════════════════════════════════════════════════════════════════════════ */
const FORM_FIELDS = ['方法正文', '适用条件', '合成案例', '预期行为', '反例', '作者', '版本'];
const DRAFT_WHITELIST = ['方法正文', '步骤', '适用条件', '反例', '预期行为', '合成案例',
  '配方id', '配方版本', '配方指纹', '作者', '许可', '包id', '卡id', '包版本', '生成时间', '工具版本'];
/* §3.1「表单收哪七项」→ §1.2「草稿白名单里的字段」的映射。
   ⚠ 这不是多余的转述：§3.1 的「版本」在 §1.2 里**没有**同名字段，它只能落到 §1.2 的三个版本字段上
   （工具版本 = `VERSION.json` 的 version；包版本 / 配方版本 = 选卡串里的 `@版本`）。
   把这条聚合关系写死在这里，好处是"少收/多收/改名"都会红，而且 §1.2 哪天改了字段名，
   本表会跟着红（刻意的摩擦：白名单是契约，不是随手能改的清单）。
   其余 §1.2 字段（配方id/配方指纹/许可/包id/卡id/生成时间）由草稿工具在**导出时自动填**，
   不由表单收 —— 表单收不到机器侧才不会因为手抄而失真。 */
const FORM_TO_DRAFT = {
  方法正文: ['方法正文', '步骤'],
  适用条件: ['适用条件'],
  合成案例: ['合成案例'],
  预期行为: ['预期行为'],
  反例: ['反例'],
  作者: ['作者'],
  版本: ['工具版本', '包版本', '配方版本'],
};
const TIERS = ['经验:试用中', '经验:可用', '经验:有争议', '经验:已并入'];
const PRIVACY_ITEMS = ['原图', '真实姓名', '学校', '班级', '哈希', '本机路径', '聊天原文', '手写批注'];
const CONCLUSION = '不能承载';
const REVIEW_ITEMS = ['复现条件', '启停对照', '反例', '适用范围', '作者', '版本'];
const REVIEW_EXAMPLE = '+4250 B / 102→104 ms';
const NO_COUNTEREXAMPLE = '维护者不采信未附反例的贡献';
const PR_HEADINGS = ['# 拉取请求（PR）', '## 这个 PR 做了什么', '## 关联',
  '## 自检清单（逐项打勾，**不打勾不要提 PR**）', '## 破坏性变更', '## 回退方式'];
const PR_OPTIONAL_RE = /^##\s*经验贡献（可选[^\n]*$/m;
const DRIVE_RE = /(?<![A-Za-z0-9_])[A-Z]:\\(?![\\/])|(?<![A-Za-z0-9_])[A-Z]:\/(?!\/)/;
const HEX64_RE = /[0-9a-fA-F]{64}/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 取一个二级标题到下一个二级标题（或 EOF）之间的正文 */
function sectionOf(md, heading) {
  const i = md.indexOf('\n' + heading);
  if (i < 0) return '';
  const rest = md.slice(i + heading.length + 1);
  const j = rest.search(/\n## /);
  return j < 0 ? rest : rest.slice(0, j);
}

/** 表单里的白名单声明（约定：`# 白名单字段：X` 必须紧跟在 `id:` 的下一行） */
function whitelistDecls(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const m = /^\s*#\s*白名单字段\s*[：:]\s*(\S+)\s*$/.exec(lines[i]);
    if (!m) continue;
    const pm = /^\s*id:\s*([A-Za-z0-9_-]+)\s*$/.exec(lines[i - 1] || '');
    out.push({ name: m[1], line: i + 1, id: pm ? pm[1] : null, prevOk: !!pm });
  }
  return out;
}

/** §3.1 的声明 → §1.2 白名单字段：每个声明都必须有出处，且出处全在 §1.2 名单里（不许越界） */
function checkMapping(declNames) {
  const errs = [];
  for (const n of declNames) {
    const targets = FORM_TO_DRAFT[n];
    if (!targets) { errs.push(`声明的字段「${n}」在 §3.1→§1.2 映射表里没有出处（白名单外的字段不许收）`); continue; }
    const bad = targets.filter((t) => !DRAFT_WHITELIST.includes(t));
    if (bad.length) errs.push(`「${n}」映射到不在 §1.2 白名单里的字段：${bad.join('、')}`);
  }
  return errs;
}

/** experience.yml 的全部判据；labelNames = labels.yml 里已存在的标签名 */
function checkForm(text, labelNames) {
  const errs = [];
  let doc;
  try { doc = parseYaml(text); } catch (e) { return { doc: null, errs: ['YAML 语法：' + e.message] }; }
  const res = { doc, errs, fields: [], marks: [], decls: [] };
  for (const k of ['name', 'description', 'title', 'labels', 'body']) {
    if (doc[k] === undefined || doc[k] === null) errs.push(`顶层缺 ${k}`);
  }
  if (!Array.isArray(doc.body)) { errs.push('body 不是序列'); return res; }
  if (typeof doc.title !== 'string' || !doc.title.includes('[' + TIERS[0] + ']')) {
    errs.push(`title 默认值必须落在第一档 [${TIERS[0]}]（现状：${JSON.stringify(doc.title)}）`);
  }
  if (!Array.isArray(doc.labels) || doc.labels.length === 0) errs.push('labels 必须是非空数组');
  else for (const l of doc.labels) if (!labelNames.has(l)) errs.push(`labels 引用了 labels.yml 里不存在的标签：${l}`);

  res.fields = doc.body.filter((x) => x && typeof x === 'object' && x.type && x.type !== 'markdown');
  res.marks = doc.body.filter((x) => x && typeof x === 'object' && x.type === 'markdown');
  for (const x of doc.body) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) { errs.push('body 里有不是映射的项'); continue; }
    if (!['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'].includes(x.type)) {
      errs.push(`body 项的 type 不是 GitHub 表单认的取值：${JSON.stringify(x.type)}（只认 markdown/input/textarea/dropdown/checkboxes）`);
    }
  }
  const seen = new Set();
  for (const f of res.fields) {
    const attrs = f.attributes || {};
    if (!f.id || !/^[a-z][a-z0-9_]*$/.test(f.id)) errs.push(`字段 id 不合规：${JSON.stringify(f.id)}`);
    else if (seen.has(f.id)) errs.push(`字段 id 重复：${f.id}`);
    else seen.add(f.id);
    if (!attrs.label) errs.push(`字段 ${f.id} 缺 attributes.label`);
    if (!f.validations || f.validations.required !== true) errs.push(`字段 ${f.id} 不是必填（白名单七项必须逐项收全）`);
    const blob = [attrs.label, attrs.description, attrs.placeholder].filter((x) => typeof x === 'string').join('\n');
    if (DRIVE_RE.test(blob)) errs.push(`字段 ${f.id} 的描述里出现盘符路径形态（本机路径不在白名单里）`);
    if (HEX64_RE.test(blob)) errs.push(`字段 ${f.id} 的描述里出现 64 位十六进制（sha256 形态不在白名单里）`);
    for (const bad of ['_原图', '_收件箱', '_录题', '_待确认', '_备份-真源']) {
      if (blob.includes(bad)) errs.push(`字段 ${f.id} 提到库内路径 ${bad}（不在白名单里）`);
    }
  }
  for (const m of res.marks) {
    if (!m.attributes || typeof m.attributes.value !== 'string' || !m.attributes.value.trim()) {
      errs.push('markdown 块缺 attributes.value');
    }
  }
  res.decls = whitelistDecls(text);
  for (const d of res.decls) {
    if (!d.prevOk) errs.push(`第 ${d.line} 行：\`# 白名单字段：\` 没紧跟在 \`id:\` 行之后（约定见文件头注释）`);
  }
  const names = res.decls.map((d) => d.name);
  const missing = FORM_FIELDS.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !FORM_FIELDS.includes(n));
  if (missing.length) errs.push('契约 §3.1 的白名单字段缺声明：' + missing.join('、'));
  if (extra.length) errs.push('声明了不在契约 §3.1 里的字段：' + extra.join('、'));
  if (new Set(names).size !== names.length) errs.push('白名单声明有重复：' + names.join('、'));
  for (const e of checkMapping(names)) errs.push(e);
  for (const d of res.decls) {
    const f = res.fields.find((x) => x.id === d.id);
    if (!f) { errs.push(`声明了「${d.name}」，但没有找到 id: ${d.id} 的字段（注释不许凑数）`); continue; }
    const label = String((f.attributes || {}).label || '');
    if (!label.includes(d.name)) errs.push(`字段 ${d.id} 的 label「${label}」里没有出现它声明的白名单字段名「${d.name}」`);
  }
  for (const f of res.fields) {
    if (!res.decls.some((d) => d.id === f.id)) errs.push(`字段 ${f.id} 没有 \`# 白名单字段：\` 声明（不许收白名单外的字段）`);
  }
  if (res.fields.length !== FORM_FIELDS.length) {
    errs.push(`收集字段 ${res.fields.length} 个 ≠ 契约 §3.1 的 ${FORM_FIELDS.length} 项`);
  }
  return res;
}

/** 隐私红线：必须有一块 markdown，同时含"禁止/不许"与全部禁贴项，且排在最前面两块之内 */
function checkPrivacy(doc) {
  const errs = [];
  if (!doc || !Array.isArray(doc.body)) return ['body 读不出来，隐私红线无从判起'];
  const at = doc.body.findIndex((m) => m && m.type === 'markdown' && m.attributes &&
    typeof m.attributes.value === 'string' &&
    /禁止|不许/.test(m.attributes.value) && PRIVACY_ITEMS.every((t) => m.attributes.value.includes(t)));
  if (at < 0) errs.push('找不到"隐私红线"那一块 markdown（要含"禁止/不许" + 全部禁贴项：' + PRIVACY_ITEMS.join('、') + '）');
  else if (at > 1) errs.push(`隐私红线块排在第 ${at + 1} 块（必须在最前两块之内才显眼）`);
  return errs;
}
function privacyErrs(text) {
  let doc;
  try { doc = parseYaml(text); } catch (e) { return ['YAML 语法：' + e.message]; }
  return checkPrivacy(doc);
}
/** 纯文本版的隐私红线判据（PR 模板不是 YAML，按整段判） */
function checkPrivacyText(text) {
  const errs = PRIVACY_ITEMS.filter((t) => !text.includes(t)).map((t) => '缺禁贴项：' + t);
  if (!/禁止|不许/.test(text)) errs.push('缺"禁止/不许"这种显式措辞');
  return errs;
}

/** PR 模板：既有段一行不丢 + 可选段真的是可选（不打勾、不稀释自检清单） */
function checkPrTemplate(md) {
  const errs = [];
  const lines = md.split(/\r?\n/);
  for (const h of PR_HEADINGS) if (!lines.includes(h)) errs.push('既有标题行丢了：' + h);
  for (const l of ['- [ ] 本 PR **含**破坏性变更（数据格式变化 / 行为不兼容）', '- [ ] 本 PR **不含**破坏性变更']) {
    if (!md.includes(l)) errs.push('破坏性变更的勾选行丢了/被改了：' + l);
  }
  const self = sectionOf(md, PR_HEADINGS[3]);
  const checks = (self.match(/^- \[ \]/gm) || []).length;
  if (checks < 10) errs.push(`自检清单只剩 ${checks} 条勾选（原本 ≥10，不许被可选段稀释）`);
  const m = PR_OPTIONAL_RE.exec(md);
  if (!m) { errs.push('缺「经验贡献（可选…）」段——标题里必须写明"可选"'); return errs; }
  const optBody = md.slice(m.index + m[0].length).split(/\n## /)[0];
  if (/\[ \]/.test(optBody)) errs.push('可选段里出现 `[ ]` 勾选（会把可选段读成必填段）');
  for (const t of ['反例', '启停对照']) if (!optBody.includes(t)) errs.push(`可选段缺「${t}」`);
  if (!optBody.includes('CONTRIBUTING.md')) errs.push('可选段没给 CONTRIBUTING.md 的指针');
  for (const e of checkPrivacyText(optBody)) errs.push('可选段' + e);
  return errs;
}

/** labels.yml：能解析、有名/色/描述、条目数与自述上限对得上、四档没被做成标签、结论在案 */
function checkLabels(text) {
  const errs = [];
  let doc;
  try { doc = parseYaml(text); } catch (e) { return { errs: ['YAML 语法：' + e.message], names: new Set(), cap: null, count: 0 }; }
  if (!Array.isArray(doc)) return { errs: ['顶层不是序列'], names: new Set(), cap: null, count: 0 };
  const names = new Set();
  doc.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errs.push(`第 ${i + 1} 项不是映射`); return; }
    if (!e.name || typeof e.name !== 'string') errs.push(`第 ${i + 1} 项缺 name`);
    else if (names.has(e.name)) errs.push(`标签名重复：${e.name}`);
    else names.add(e.name);
    if (!/^[0-9a-fA-F]{6}$/.test(String(e.color || ''))) errs.push(`标签 ${e.name} 的 color 不是 6 位十六进制`);
    if (!e.description) errs.push(`标签 ${e.name} 缺 description`);
  });
  const capM = /上限\s*(\d+)\s*个/.exec(text);
  const cap = capM ? Number(capM[1]) : null;
  if (cap === null) {
    errs.push('读不到自述上限（"上限 N 个"）—— 标签上限的唯一真源就在本文件里');
  } else {
    if (doc.length > cap) errs.push(`标签 ${doc.length} 个 > 自述上限 ${cap} 个`);
    if (cap !== 10) errs.push(`自述上限变成 ${cap}（四档结论是在上限 10 下做出的：改了就要重评并同步 CONTRIBUTING §八）`);
    if (doc.length + TIERS.length <= cap) errs.push(`标签还有空位（${doc.length} + ${TIERS.length} ≤ ${cap}）⇒ "承载不了"的前提不成立，四档结论必须重评`);
  }
  for (const t of TIERS) {
    if (new RegExp('^\\s*-\\s*name:\\s*' + escapeRe(t) + '\\s*$', 'm').test(text)) errs.push(`四档被真的做成了标签：- name: ${t}`);
    if (!text.includes(t)) errs.push(`labels.yml 里没登记四档之一：${t}`);
  }
  if (!text.includes(CONCLUSION)) errs.push(`labels.yml 没写结论「${CONCLUSION}」`);
  return { errs, names, cap, count: doc.length };
}

/** 四档名字组必须**两边都在**（只写一边 ⇒ 红）；两边都要写同一个结论词 */
function checkTiers(labelsText, contribText) {
  const errs = [];
  for (const t of TIERS) {
    if (!labelsText.includes(t)) errs.push(`labels.yml 缺四档之一：${t}`);
    if (!contribText.includes(t)) errs.push(`CONTRIBUTING.md 缺四档之一：${t}（只写一边＝两边口径不一致）`);
  }
  for (const [n, t] of [['labels.yml', labelsText], ['CONTRIBUTING.md', contribText]]) {
    if (!t.includes(CONCLUSION)) errs.push(`${n} 没写结论「${CONCLUSION}」`);
  }
  return errs;
}

/** CONTRIBUTING §八：复核六项 / 启停对照示例 / 反例那一句 / 四档与公开仓入口的指针 */
function checkContrib(text) {
  const errs = [];
  const m = /^##\s*八、经验贡献与复核[^\n]*$/m.exec(text);
  if (!m) { errs.push('CONTRIBUTING.md 缺 `## 八、经验贡献与复核` 节'); return errs; }
  const sec = sectionOf(text, m[0]);
  for (const t of REVIEW_ITEMS) if (!sec.includes(t)) errs.push(`§八 缺复核项「${t}」`);
  if (!sec.includes(NO_COUNTEREXAMPLE)) errs.push(`§八 缺逐字判据「${NO_COUNTEREXAMPLE}」`);
  if (!sec.includes(REVIEW_EXAMPLE)) errs.push(`§八 缺启停对照的示例格式「${REVIEW_EXAMPLE}」`);
  if (!sec.includes('labels.yml')) errs.push('§八 没指向 labels.yml（四档结论的两个家要对上）');
  for (const p of ['experience.yml', 'pull_request_template.md']) {
    if (!sec.includes(p)) errs.push(`§八 没指向公开仓入口 ${p}`);
  }
  return errs;
}

/* ══════════════════════════════════════════════════════════════════════════ */
console.log('═══ 0 · 四个文件可读 ═══');
const text = {};
for (const [k, p] of Object.entries(FILE)) {
  let t = null;
  try { t = fs.readFileSync(p, 'utf8'); } catch (e) { }
  text[k] = t;
  A(`读得到 ${path.relative(REPO, p).split(path.sep).join('/')}`, typeof t === 'string' && t.trim().length > 0,
    t === null ? '读不出' : t.length + ' 字符');
}
if (Object.values(text).some((t) => typeof t !== 'string')) {
  console.log('\nRESULT=FAIL(' + worst + ') 断言=' + (passed + worst) + '（文件不全，后续判据无从谈起）');
  process.exit(1);
}

console.log('\n═══ 1 · experience.yml：YAML 可解析 + 字段白名单逐项对拍 ═══');
const L = checkLabels(text.labels);
const F = checkForm(text.form, L.names);
A('experience.yml 能被本解析器解析（YAML 子集，见文件头）', F.doc !== null,
  F.doc === null ? F.errs.join(' ｜ ') : '顶层键 ' + Object.keys(F.doc).join('/'));
if (F.doc) {
  A('收集字段集合 == 契约 §3.1 七项（逐项相等：多一个少一个都红）',
    F.decls.length === FORM_FIELDS.length && FORM_FIELDS.every((n) => F.decls.some((d) => d.name === n)),
    '声明=' + F.decls.map((d) => d.name).join('/'));
  A('声明的每一项都能落回 §1.2 草稿白名单（含「版本」→ 工具版本/包版本/配方版本 的聚合映射）',
    F.decls.length > 0 && checkMapping(F.decls.map((d) => d.name)).length === 0,
    checkMapping(F.decls.map((d) => d.name)).join(' ｜ ') || F.decls.map((d) => d.name).join('/'));
  A('映射表自证：§3.1 七项全覆盖、映射目标全在 §1.2 名单里、且不重复（白名单改名会在这里红）',
    Object.keys(FORM_TO_DRAFT).length === FORM_FIELDS.length &&
    FORM_FIELDS.every((n) => Array.isArray(FORM_TO_DRAFT[n]) && FORM_TO_DRAFT[n].length > 0) &&
    Object.values(FORM_TO_DRAFT).flat().every((t) => DRAFT_WHITELIST.includes(t)) &&
    new Set(Object.values(FORM_TO_DRAFT).flat()).size === Object.values(FORM_TO_DRAFT).flat().length,
    Object.entries(FORM_TO_DRAFT).map(([k, v]) => k + '→' + v.join('+')).join(' '));
  A('「版本」字段真的同时要了工具版本与包版本（聚合不是空话：写 `VERSION.json` 与 `包版本`）',
    (() => {
      const f = F.fields.find((x) => x.id === 'version');
      const blob = [f && f.attributes && f.attributes.label, f && f.attributes && f.attributes.description].join('\n');
      return !!f && blob.includes('VERSION.json') && blob.includes('包版本');
    })(), '');
  A('每个收集字段都必填、id 唯一且带 label',
    F.fields.length === FORM_FIELDS.length &&
    F.fields.every((f) => f.validations && f.validations.required === true && f.id && (f.attributes || {}).label) &&
    new Set(F.fields.map((f) => f.id)).size === F.fields.length,
    F.fields.map((f) => f.id).join('/'));
  A('body 每个项的 type 都是 GitHub 表单认的取值（markdown/input/textarea/dropdown/checkboxes）',
    F.errs.filter((e) => e.includes('type 不是')).length === 0,
    F.errs.filter((e) => e.includes('type 不是')).join(' ｜ ') || '全是认得的类型');
  A('每条白名单声明都紧跟在 id 行之后、且 label 里出现该字段名（注释不许凑数）',
    F.decls.every((d) => d.prevOk) &&
    F.decls.every((d) => { const f = F.fields.find((x) => x.id === d.id); return f && String((f.attributes || {}).label || '').includes(d.name); }),
    F.decls.map((d) => d.id + '=' + d.name).join(' '));
  A('表单只挂 labels.yml 里已存在的标签（本仓标签真源；不新造标签）',
    Array.isArray(F.doc.labels) && F.doc.labels.length > 0 && F.doc.labels.every((l) => L.names.has(l)),
    JSON.stringify(F.doc.labels));
  A('表单默认标题落在第一档 [' + TIERS[0] + '] 上', String(F.doc.title || '').includes('[' + TIERS[0] + ']'),
    JSON.stringify(F.doc.title));
  A('字段描述里没有盘符路径 / 64 位十六进制 / 库内路径（不收白名单外的东西）',
    F.errs.filter((e) => /盘符路径|十六进制|库内路径/.test(e)).length === 0,
    F.errs.filter((e) => /盘符路径|十六进制|库内路径/.test(e)).join(' ｜ ') || '干净');
}
A('experience.yml 全部结构判据通过（聚合）', F.errs.length === 0, cut(F.errs.join(' ｜ '), 300));

console.log('\n═══ 2 · 隐私红线（表单最显眼处那一行）═══');
const pErrs = privacyErrs(text.form);
A('表单里有一块 markdown 同时写明"禁止"与全部禁贴项（原图/真名/学校/班级/哈希/路径/聊天/批注）',
  pErrs.length === 0, cut(pErrs.join(' ｜ '), 240));

console.log('\n═══ 3 · pull_request_template.md：既有段不丢 + 可选段真的是可选 ═══');
const prErrs = checkPrTemplate(text.pr);
A('PR 模板六个既有标题逐字未丢（含自检清单与破坏性变更）',
  prErrs.filter((e) => e.startsWith('既有标题行丢了')).length === 0,
  prErrs.filter((e) => e.startsWith('既有标题行丢了')).join(' ｜ ') || '六个都在');
const prSelf = sectionOf(text.pr, PR_HEADINGS[3]);
A('自检清单没被稀释（勾选仍 ≥10 条，PR 的必填观感未变）', (prSelf.match(/^- \[ \]/gm) || []).length >= 10,
  (prSelf.match(/^- \[ \]/gm) || []).length + ' 条');
A('新增「经验贡献（可选）」段：段内无勾选、含反例与启停对照、指向 CONTRIBUTING.md、含隐私红线',
  PR_OPTIONAL_RE.test(text.pr) && prErrs.filter((e) => e.includes('可选段')).length === 0,
  cut(prErrs.filter((e) => e.includes('可选段')).join(' ｜ '), 200) || '可选段合规');
A('PR 模板全部判据通过（聚合）', prErrs.length === 0, cut(prErrs.join(' ｜ '), 300));

console.log('\n═══ 4 · labels.yml：四档结论（不能承载）+ 前提断言 ═══');
A('labels.yml 能被解析，且每条标签都有 name/color/description',
  L.errs.filter((e) => !e.includes('承载') && !e.includes('上限')).length === 0,
  L.errs.filter((e) => !e.includes('承载') && !e.includes('上限')).join(' ｜ ') || `${L.count} 条标签`);
A('条目数与自述上限：≤ 上限，且上限就是刻意的 10', L.cap === 10 && L.count <= L.cap,
  `条目 ${L.count} / 上限 ${L.cap}`);
A('前提断言：标签没有空位（条目数 + 4 > 上限）—— 四档结论的前提仍然成立；前提一变本行必红',
  L.cap !== null && L.count + TIERS.length > L.cap, `${L.count} + ${TIERS.length} > ${L.cap}`);
A('四档**没有**被做成标签（不存在 `- name: 经验:…` 条目）',
  !TIERS.some((t) => new RegExp('^\\s*-\\s*name:\\s*' + escapeRe(t) + '\\s*$', 'm').test(text.labels)),
  TIERS.join('/'));
A('四档与结论都登记在 labels.yml 里（含指针：正文口径真源在 CONTRIBUTING §八）',
  TIERS.every((t) => text.labels.includes(t)) && text.labels.includes(CONCLUSION),
  '四档 ' + TIERS.length + ' 项 + 结论「' + CONCLUSION + '」');
A('labels.yml 全部判据通过（聚合）', L.errs.length === 0, cut(L.errs.join(' ｜ '), 300));

console.log('\n═══ 5 · CONTRIBUTING.md §八：复核六项 + 启停对照口径 ═══');
const cErrs = checkContrib(text.contrib);
A('§八 覆盖复核六项与逐字判据「' + NO_COUNTEREXAMPLE + '」',
  cErrs.filter((e) => /复核项|逐字判据/.test(e)).length === 0,
  cut(cErrs.filter((e) => /复核项|逐字判据/.test(e)).join(' ｜ '), 200) || '六项 + 反例判据都在');
A('§八 给出启停对照的示例格式「' + REVIEW_EXAMPLE + '」（照格式贴数字）',
  !cErrs.some((e) => e.includes('示例格式')), cut(cErrs.filter((e) => e.includes('示例格式')).join(' ｜ '), 160) || '在');
A('§八 指向公开仓两个入口与 labels.yml', cErrs.filter((e) => /没指向/.test(e)).length === 0,
  cut(cErrs.filter((e) => /没指向/.test(e)).join(' ｜ '), 160) || '都在');
A('CONTRIBUTING §八 全部判据通过（聚合）', cErrs.length === 0, cut(cErrs.join(' ｜ '), 300));

console.log('\n═══ 6 · 四档口径两边对拍（只写一边必须红）═══');
const tErrs = checkTiers(text.labels, text.contrib);
A('四档名字组在 labels.yml 与 CONTRIBUTING.md 里同时出现，且两边写同一个结论词',
  tErrs.length === 0, cut(tErrs.join(' ｜ '), 240));

console.log('\n═══ 7 · 解析器自证（判据必须有牙齿）═══');
let goodDoc = null, goodOk = false;
try {
  goodDoc = parseYaml('a: 1\nb:\n  - type: markdown\n    attributes:\n      value: |\n        ### 这是块标量里的标题，不是结构\n        禁止：原图 / 哈希\nc: [x, y]\n');
  goodOk = true;
} catch (e) { }
A('解析器自证 · 接受合法子集（块标量里的 `###`、全角冒号、行内数组都不许被当结构）',
  goodOk && goodDoc && goodDoc.b[0].attributes.value.includes('### 这是块标量里的标题') &&
  Array.isArray(goodDoc.c) && goodDoc.c.join(',') === 'x,y',
  goodOk ? '' : '合法片段被拒了');
let tabErr = null, indentErr = null;
try { parseYaml('a:\n\tb: 1\n'); } catch (e) { tabErr = e.message; }
try { parseYaml('a: 1\n  b: 2\n'); } catch (e) { indentErr = e.message; }
A('解析器自证 · 制表符缩进必须抛错（fail-closed，不静默当没看见）', !!tabErr, cut(tabErr || '没有抛错', 90));
A('解析器自证 · 缩进错位必须抛错（解析器真有牙齿）', !!indentErr, cut(indentErr || '没有抛错', 90));

/* ══════════════════════════════════════════════════════════════════════════
   阴性对照：把**真文件**的文本在内存里改坏，再喂给上面同一批判据函数。
   每条都先断言"改动锚点真的存在"—— 否则对照会空转通过，那正是本仓最忌的假绿。
   （除下面这些之外，真文件一个字节都不动。）
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n═══ 8 · 阴性对照（真跑：改坏 ⇒ 必须红）═══');
const mut = (t, from, to) => (t.includes(from) ? t.split(from).join(to) : null);
const stripTiers = (t) => {
  let out = t;
  for (const x of TIERS) { if (!out.includes(x)) return null; out = out.split(x).join('【四档名已删除】'); }
  return out;
};
const dropFormField = (t, id) => {
  const re = new RegExp('\\n  - type: [a-z]+\\n    id: ' + id + '\\n[\\s\\S]*?(?=\\n  - type: )');
  return re.test(t) ? t.replace(re, '') : null;
};
const dropFormMarkdown = (t) => {
  const re = /\n  - type: markdown\n[\s\S]*?(?=\n  - type: )/;
  return re.test(t) ? t.replace(re, '') : null;
};

/* ① 四档只留在 labels.yml，CONTRIBUTING 不提 */
{
  const bad = stripTiers(text.contrib);
  A('对照① 前置：CONTRIBUTING.md 里确实写着四档（否则这条对照是空转）', bad !== null, '');
  if (bad) {
    const e = checkTiers(text.labels, bad);
    A('对照① 四档只写在 labels.yml、CONTRIBUTING 不提 ⇒ 一致性判据必须红', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}
/* ② 反向：四档只留在 CONTRIBUTING，labels.yml 不提 */
{
  const bad = stripTiers(text.labels);
  A('对照② 前置：labels.yml 里确实写着四档', bad !== null, '');
  if (bad) {
    const e = checkTiers(bad, text.contrib);
    A('对照② 四档只写在 CONTRIBUTING、labels.yml 不提 ⇒ 一致性判据必须红', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}
/* ③ 表单少一个白名单字段（反例） */
{
  const bad = dropFormField(text.form, 'counterexample');
  A('对照③ 前置：表单里确实有 counterexample（反例）字段', bad !== null, '');
  if (bad) {
    const e = checkForm(bad, L.names).errs;
    A('对照③ 删掉「反例」字段 ⇒ 白名单逐项对拍必须红', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}
/* ④ 表单多收一个白名单外的字段（补充信息自由框） */
{
  const extra = '  - type: textarea\n    id: extra\n    # 白名单字段：补充信息\n    attributes:\n      label: 补充信息\n      description: 随便写点别的\n    validations:\n      required: true\n\n';
  const bad = mut(text.form, '  - type: markdown\n', extra + '  - type: markdown\n');
  A('对照④ 前置：能插入一个额外字段', bad !== null, '');
  if (bad) {
    const e = checkForm(bad, L.names).errs;
    A('对照④ 多收一个不在白名单里的字段（哪怕声明注释齐全）⇒ 必须红', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}
/* ⑤ 白名单声明被改名（注释凑数） */
{
  const bad = mut(text.form, '# 白名单字段：反例', '# 白名单字段：错因');
  A('对照⑤ 前置：能找到「# 白名单字段：反例」', bad !== null, '');
  if (bad) {
    const e = checkForm(bad, L.names).errs;
    A('对照⑤ 把「反例」的声明改成不在 §1.2 白名单里的「错因」⇒ 必须红', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}
/* ⑥ 隐私红线被整块删掉 / 少一项 */
{
  const noBlock = dropFormMarkdown(text.form);
  A('对照⑥ 前置：表单里确实有一块 markdown（隐私红线）', noBlock !== null, '');
  if (noBlock) A('对照⑥a 隐私红线整块被删 ⇒ 必须红', privacyErrs(noBlock).length > 0, cut(privacyErrs(noBlock).join(' ｜ '), 130));
  const less = mut(text.form, '手写批注', '（略）');
  A('对照⑥ 前置：表单里写着「手写批注」', less !== null, '');
  if (less) A('对照⑥b 隐私红线少一项（手写批注）⇒ 必须红', privacyErrs(less).length > 0, cut(privacyErrs(less).join(' ｜ '), 130));
}
/* ⑦ 四档真的被做成标签（模拟"能承载"那一支） */
{
  const bad = mut(text.labels, '- name: bug',
    '- name: 经验:试用中\n  color: 0e8a16\n  description: 状态：试用中\n\n- name: bug');
  A('对照⑦ 前置：能往 labels.yml 里插一条标签', bad !== null, '');
  if (bad) {
    const e = checkLabels(bad).errs;
    A('对照⑦ 真把四档做成标签 ⇒ 必须红（超上限 + 不该出现在这里）', e.length > 0, cut(e.join(' ｜ '), 160));
  }
}
/* ⑧ 把自述上限抬高（前提变了 ⇒ 结论必须重评） */
{
  const bad = mut(text.labels, '上限 10 个', '上限 14 个');
  A('对照⑧ 前置：labels.yml 里写着「上限 10 个」', bad !== null, '');
  if (bad) {
    const e = checkLabels(bad).errs;
    A('对照⑧ 上限抬到 14（四档有空位了）⇒ 前提断言必须红（结论要重评）', e.length > 0, cut(e.join(' ｜ '), 160));
  }
}
/* ⑨ PR 模板既有标题被删 */
{
  const bad = mut(text.pr, '## 破坏性变更', '## 兼容性');
  A('对照⑨ 前置：PR 模板里有「## 破坏性变更」', bad !== null, '');
  if (bad) {
    const e = checkPrTemplate(bad);
    A('对照⑨ 删掉既有标题「## 破坏性变更」⇒ 必须红', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}
/* ⑩ 可选段里塞勾选（把可选段读成必填段） */
{
  const bad = mut(text.pr, '- 复现条件：', '- [ ] 复现条件：');
  A('对照⑩ 前置：可选段里有「- 复现条件：」', bad !== null, '');
  if (bad) {
    const e = checkPrTemplate(bad);
    A('对照⑩ 可选段里塞一个 `[ ]` ⇒ 必须红（可选段不许有必填观感）', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}
/* ⑪ PR 模板的隐私红线少一项 */
{
  const bad = mut(text.pr, '手写批注', '（略）');
  A('对照⑪ 前置：PR 模板里写着「手写批注」', bad !== null, '');
  if (bad) {
    const e = checkPrTemplate(bad);
    A('对照⑪ PR 模板的隐私红线少一项 ⇒ 必须红', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}
/* ⑫ §八 只剩"要写数字"、示例格式被删 */
{
  const bad = mut(text.contrib, REVIEW_EXAMPLE, '（数字略）');
  A('对照⑫ 前置：§八 里写着示例格式「' + REVIEW_EXAMPLE + '」', bad !== null, '');
  if (bad) {
    const e = checkContrib(bad);
    A('对照⑫ 启停对照的示例格式被删 ⇒ 必须红', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}

/* ⑬ 表单里出现 GitHub 不认的 type（拼错一个字，整个表单就加载不出来） */
{
  const bad = mut(text.form, '  - type: textarea\n', '  - type: textare\n');
  A('对照⑬ 前置：表单里有 `- type: textarea`', bad !== null, '');
  if (bad) {
    const e = checkForm(bad, L.names).errs;
    A('对照⑬ 把 textarea 拼错成 textare ⇒ 必须红（否则表单在 GitHub 上根本加载不出来）', e.length > 0, cut(e.join(' ｜ '), 150));
  }
}

console.log('\n（全程只读真文件 + 内存改坏；不建临时目录、不读写用户库、不联网）');
console.log('RESULT=' + (worst ? 'FAIL(' + worst + ')' : 'PASS') + ' 断言=' + (passed + worst));
process.exit(worst ? 1 : 0);
