#!/usr/bin/env node
/**
 * 拾光小册 · 题干可读性门禁（v1，2026-11-07 建）
 *
 * 起源（用户原话，指着 E0017 的单题预览）：
 *   「你转换出来的题干莫名其妙，谁能看得懂？这样的题干也能通过双盲解答？也能进库？」
 *
 * 实测根因**两件事叠加**（E0017 = 某七年级英语卡·读音判断2处合卡）：
 *
 *   ① **转义层套了两次** ⇒ 题面印出字面的 "<u>a</u>" 垃圾。
 *      AI 回传的 `questionText` 里已含真标签（`<u>a</u>` = "画线部分"），
 *      入库器 `escapeHtml()` 又转一遍 ⇒ 落盘成 `&lt;u&gt;a&lt;/u&gt;`。
 *      铁证：同一张卡的**索引 `question` 字段里是真标签**、题干.html 里是实体化标签
 *      —— 同一处标记两种编码 ⇒ 不是录入笔误，是转义层被套了两次。
 *
 *   ② **大题指令没带进来** ⇒ 题干不自足。
 *      E0017 是"一、判断每组单词画线部分发音是否相同（相同的写 S，不同的写 D）"
 *      里的第 3、5 小题，只抄了小题 ⇒ 题号成了孤儿号（3、5），读者不知道要做什么。
 *      索引 `source` 里**写着**大题出处，但索引 `question` 只做兜底、**印不出来**
 *      （渲染事实见 `src\app\js\views\paper.js:490`）。
 *
 * 为什么现有门禁抓不到（**门禁盲区的具体形状**）：
 *   · `_作答门禁.mjs` 查**空位/答案**对账 —— E0017 没有空位，它管不着；
 *   · `_着重号门禁.mjs` 查 `.rd` 标记的**样式** —— E0017 用的是 `<u>` 不是 `.rd`；
 *   · `_配图门禁.mjs` 查**图资产** —— E0017 无图，它管不着；
 *   · `_盲解复核.mjs` 查**两路结论是否一致** —— 它的指纹恰恰**算在乱码题面上**
 *     （实测 fp=c397862e942c = 乱码文本的 v2 指纹）⇒ 乱码不但没被拦，
 *     反而成了"已通过"的凭据。
 *   ⇒ **没有任何一道门禁看"题面本身能不能读懂"**。本工具补的就是这一维。
 *
 * 判据（缺一条就红）：
 *   ① **实体化标签**：`&lt;u&gt;` / `&lt;/u&gt;` / `&lt;span …&gt;`（含双重转义 `&amp;lt;`）
 *      —— 浏览器解码后会把 "<u>a</u>" 当**字面文本**印出来。
 *      ⚠ 只认「实体化的**标签**」：数学不等号 `&lt;` / `&gt;`（后面跟数字/中文/空格）**不算**
 *      （全库 52 处都是合法不等号 —— 判据若宽到"见到 &lt; 就红"，会误报 20 张卡）。
 *   ② **正文印出字面标签**：解码后正文里出现小写合法标签（`<u> </u>` 之类）
 *      —— 说明标记已经坏成了文本。
 *   ③ **标记不配对**：`<u>` / `<span class="rd">` 等开闭数不等（或栈式良构性错乱）
 *      —— 净化器剥标签后内容会被吞掉，读者少看到一块。
 *   ④ **题干不自足**：题干里有**孤儿题号**（最小号 > 1）**且**纯文本里找不到任何
 *      大题指令（大题标题行 `一、`/`二、`…、或 `【…】` 自述块、或含指令词）
 *      ⇒ 读者不知道要做什么。⚠ 必须**两个条件同时成立**才算：
 *      填空题本身自带语境（「蜡烛燃烧是（填"放热"或"吸热"）反应。」）是**自足**的，
 *      按"没有指令词"判会把 359 张卡全误报（实测）。
 *
 * 用法（node _题干门禁.mjs <动作>）：
 *   扫描 [--json]   只读：逐卡列出标记使用与问题
 *   门禁 [--json]   判定：不合判据即退出码 1（人类模式与 --json 同码同判）
 *
 * ⚠ 与 `_作答门禁.mjs`（空位/答案）、`_着重号门禁.mjs`（加点样式）、`_配图门禁.mjs`（图资产）
 *   分工：那三个管"答案/样式/图"，本工具管"**题面本身能不能读懂**"。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { libraryRoot } from './_库根.mjs';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';

const ROOT = libraryRoot();
const STEM = '题干.html';

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const { action, opt } = parseArgs(argv, {
  valueFlags: [...COMMON_VALUE_FLAGS],
  boolFlags: ['json', 'help', 'h'],
});

/* ---------- 题库发现（与 _盲解复核.mjs / _配图门禁.mjs 同规则） ---------- */
function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) { if (e.name === '_索引.json') acc.push(path.join(dir, e.name)); continue; }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    if (/(作业|假期)/.test(e.name)) continue;
    indexFiles(path.join(dir, e.name), acc);
  }
  return acc;
}
function itemsOfJson(j, base) {
  const out = [];
  if (Array.isArray(j.items)) for (const it of j.items) out.push({ item: it, subject: j.subject || '', student: j.student, dirAbs: path.join(base, it.dir || it.id) });
  if (j.subjects) for (const [name, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) out.push({ item: it, subject: name, student: j.student, dirAbs: path.join(base, name, it.dir || it.id) });
  return out;
}
export function allCards(root = ROOT) {
  const out = [];
  for (const f of indexFiles(root)) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    for (const x of itemsOfJson(j, path.dirname(f))) out.push({ ...x, key: x.student + '|' + x.item.id });
  }
  return out;
}

/* ---------- 纯函数（导出给回归用例复用） ---------- */

/** 解码 HTML 实体（顺序要紧：先 &amp; 最后解，否则 &amp;lt; 会被解成 &lt;） */
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&frasl;/g, '/')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 题干纯文本（去标签去 svg，实体解码） */
export function plainOf(html) {
  let s = String(html || '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 判据①：**实体化的标签**（转义层套了两次的证据）。
 * 只认「实体后面跟的是标签名」：`&lt;u&gt;` / `&lt;/u&gt;` / `&lt;span …&gt;`。
 * 数学不等号 `&lt;`（后面跟数字/空格/中文）**不算**。
 * 双重转义 `&amp;lt;u&amp;gt;` 也算（解码两层仍是实体，印出来还是垃圾）。
 */
export function entityTagHits(html) {
  const s = String(html || '');
  const out = [];
  /* 双重转义：&amp;lt; … &amp;gt; */
  for (const m of s.matchAll(/&(?:amp;)*lt;\/?[a-zA-Z][a-zA-Z0-9]*(\s[^&]*?)?\/?&(?:amp;)*gt;/g)) {
    out.push({ raw: m[0], tag: m[0].replace(/&(?:amp;)*lt;\/?/, '').replace(/&(?:amp;)*gt;/, '').trim() });
  }
  return out;
}

/**
 * 判据②：**实体解码后会变成标签的文本** —— 题干正文里印出了字面的 "<u>"、"</u>"。
 *
 * ⚠ 这里极易写错（第一版把判据写成了"解码后正文里有任何标签"，结果**全库 590 张全红**）：
 *   卡片**本来就合法**用 `<i>` `<sub>` `<span class="fr">` `<svg>` 这些内联标记
 *   （数学斜体、上下标、分数、图形）——它们在**源码里就是真标签**，是题面的一部分。
 *   真正要抓的是：**源码里没有这个标签，只是实体解码后才变成标签**。
 *
 *   正确做法：把源码里的**真标签**先"挖掉"（连同它们包裹的内容一并留空），
 *             再解码实体 ⇒ 剩下的才是"印在纸上的字面标签"。
 *   这与判据①是同一条证据链的两端：①抓"实体化的标签"，②抓"解码后才成标签的文本"。
 */
export function literalTagHits(html) {
  const src = String(html || '');
  /* ① 先把**真标签**（含其内容）挖掉：只留纯文本骨架 */
  const skeleton = src
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')          // 图形整块去掉
    .replace(/<[^<>]*>/g, ' ');                     // 其余真标签去掉（只留标签之间的文本）
  /* ② 解码实体 ⇒ 本该是"文本里的标签"的东西会显形 */
  const decoded = decodeEntities(skeleton);
  const out = [];
  /* ⚠ 判据必须**逐行**、且标签内不得有中文/换行：
     否则数学不等号会误判 —— 实测 `A.两物体的重GA&lt;GB` / `B.有用功W₁&lt;W₂`：
     解码后跨行的 `&lt;GB…W₁&gt;` 会被当成一个标签（某物理卡 P0131 误报）。
     真标签长这样：`<u>` `</u>` `<span class="rd">` —— 名字是 ASCII、**紧邻** >、不跨行。 */
  for (const line of decoded.split(/\n+/)) {
    for (const m of line.matchAll(/<\/?[a-zA-Z][^\u4e00-\u9fff<>\n]*>/g)) {
      out.push({ raw: m[0], tag: (m[0].match(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/) || ['', '?'])[1] });
    }
  }
  return out;
}

/** 判据③：**标记不配对** —— 开闭数不等，或栈式良构性错乱。 */
export function unbalancedTags(html) {
  const s = String(html || '');
  /* 先去掉注释（注释里的标签不参与渲染） */
  const body = s.replace(/<!--[\s\S]*?-->/g, '');
  const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input']);
  const stack = [];
  const problems = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^<>]*?(\/?)>/g)) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosed = m[3] === '/';
    if (VOID.has(name) || selfClosed) continue;
    if (!closing) { stack.push({ name, at: m.index }); continue; }
    const top = stack.pop();
    if (!top) { problems.push(`多出一个 </${name}>`); continue; }
    if (top.name !== name) problems.push(`<${top.name}> 被 </${name}> 提前闭合（嵌套错乱）`);
  }
  for (const left of stack) problems.push(`<${left.name}> 没有闭合`);
  return problems;
}

/** 题号抽取（**先剥行首答题括号**再取号）。
 *  ⚠ 事故样本的形态是 `( ) 3. classm…` —— 括号与数字之间隔着 `)`，
 *    不先剥括号则这条正则**命中不了已知事故样本**（自证失败）。 */
export function questionNumbers(plain) {
  const out = [];
  for (const line of String(plain || '').split(/\n+/)) {
    const l = line.trim();
    if (!l) continue;
    /* 剥掉行首的答题括号：( ) / （　） / (　) */
    const stripped = l.replace(/^[（(][\s　]*[）)]\s*/, '').replace(/^[（(][^）)]{0,6}[）)]\s*/, '');
    const m = /^(\d{1,3})\s*[\.．、\)）]/.exec(stripped);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** 大题指令线索：大题标题行（`一、`…）/ `【…】` 自述块 / 常见指令词。 */
const BIG_HEAD = /^[（(]?[一二三四五六七八九十]{1,3}[）)、.．]/;
const SELF_DESC = /[【\[][^】\]]{2,}[】\]]/;
const CUE_WORDS = /判断|选出|填空|填入|回答|根据|下列|选择|阅读|翻译|改正|完成|画线|读音|发音|意思|作用|短文|完形|任务|至少|最多|请|量出|计算|求|证明|解出|写出|列举|说明|解释|比较|谓语|时态|词形|词义|句型|标出|圈出|按要求|要求|形式|用.{0,8}的.{0,6}形式/;

/** 题干里有没有大题指令（逐行看：标题行 / 【…】块 / 含指令词的行） */
export function hasInstruction(plain) {
  for (const line of String(plain || '').split(/\n+/)) {
    const l = line.trim();
    if (!l) continue;
    if (BIG_HEAD.test(l)) return true;
    if (SELF_DESC.test(l)) return true;
    if (CUE_WORDS.test(l)) return true;
  }
  return false;
}

/** 逐卡判定：返回 {ok, problems[], warns[], info} */
export function judgeCard({ stem = '', question = '', type = '' } = {}) {
  const html = String(stem || '');
  const problems = [];
  const warns = [];

  /* ① 实体化标签 */
  const ent = entityTagHits(html);
  if (ent.length) {
    const kinds = [...new Set(ent.map(e => e.tag))].slice(0, 4).join(' / ');
    problems.push({ code: 'entity-tag', msg: `题干里有**实体化的标签**（${kinds}）——转义层被套了两次，浏览器解码后会把 "<u>a</u>" 当**字面文本**印在题面上（E0017 事故）` });
  }

  /* ② 正文印出字面标签 */
  const lit = literalTagHits(html);
  if (lit.length) {
    problems.push({ code: 'literal-tag', msg: `解码后正文里印出了字面标签（${[...new Set(lit.map(x => x.raw))].slice(0, 3).join(' ')}）——标记已经坏成了文本，读者看到的是垃圾` });
  }

  /* ③ 标记不配对 */
  const unb = unbalancedTags(html);
  if (unb.length) {
    problems.push({ code: 'tag-unbalanced', msg: `标记不配对：${unb.slice(0, 3).join('；')}` });
  }

  /* ④ 题干不自足：孤儿题号 **且** 没有大题指令（两个条件同时成立才算） */
  const plain = plainOf(html);
  const nums = questionNumbers(plain);
  const orphan = nums.length > 0 && Math.min(...nums) > 1;
  const instructed = hasInstruction(plain);
  if (orphan && !instructed) {
    /* ⚠ 这一条**只报告、不阻断**（与 ①②③ 分级）：
       ① ② ③ 是**数据损坏**（标记坏成了文本）——新卡出现就必须挡住；
       ④ 是**内容欠完整**（少抄了大题指令）——存量 39 张是 2026-10-22 那批的历史欠账，
          一次改完要逐张回原卷核对，不该在这次修复里顺手批量改（改错了比不改更坏）。
          存量清单登记在库根 `_整改台账.md`（人读的整改欠账登记，只登记不执行）。
          ⇒ 门禁**报出来**（让人看得见），但不让存量把整条发布链一次打挂。 */
    warns.push({ code: 'stem-not-selfcontained', msg: `题干不自足：题号是孤儿号（${[...new Set(nums)].slice(0, 6).join('、')}，最小 ${Math.min(...nums)} > 1）却没带大题指令——读者不知道要做什么。存量已登记在 _整改台账.md（整改要逐张回原卷核对）` });
  }

  return {
    ok: problems.length === 0,
    problems, warns,
    info: { nums: [...new Set(nums)], orphan, instructed, plainLen: plain.length },
  };
}

/* ---------- CLI ---------- */
/* ⚠ 只有**被直接当命令跑**时才执行 CLI；被 `import` 时（回归用例要 import 判据函数）
   绝不能跑 CLI —— 否则 import 一下就把清稿/门禁跑起来了（副作用）。
   判据：process.argv[1] 指向本文件。 */
const IS_ENTRY = (() => {
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return !!entry && path.resolve(self) === entry;
  } catch { return false; }
})();

/** 全库判定（供 CLI 与其它工具复用）：返回 {ok, stats, problems, rows} */
export function judgeLibrary(root = ROOT) {
  const cards = allCards(root);
  const rows = cards.map(x => {
    const p = path.join(x.dirAbs, STEM);
    const stem = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') : '';
    const r = judgeCard({ stem, question: x.item.question, type: x.item.type });
    return Object.assign({ key: x.key, id: x.item.id, subject: x.subject, status: x.item.status }, r);
  });
  /* 已归档的卡只记录不阻断（与 _着重号门禁.mjs 同口径） */
  const blocked = rows.filter(r => !r.ok && String(r.status || '') !== '已归档');
  /* 「不自足」是**内容欠完整**（不是数据损坏）⇒ 只报告不阻断；
     存量清单登记在库根 `_整改台账.md`，整改要逐张回原卷核对。 */
  const warned = rows.filter(r => r.ok && r.warns.length);
  return {
    ok: blocked.length === 0,
    rows, blocked, warned,
    stats: {
      total: rows.length,
      block: blocked.length,
      archivedSkipped: rows.filter(r => !r.ok && String(r.status || '') === '已归档').length,
      warn: warned.length,
    },
  };
}

if (IS_ENTRY) switch (action) {
  case '扫描':
  case '门禁': {
    const lib = judgeLibrary();
    const { rows, blocked, warned } = lib;
    const json = {
      ok: lib.ok,
      action,
      stats: lib.stats,
      problems: blocked.map(r => `${r.key}[${r.problems.map(p => p.msg).join('；')}]`),
      warns: warned.map(r => `${r.key}[${r.warns.map(w => w.msg).join('；')}]`),
      cards: Object.fromEntries(rows.map(r => [r.key, { ok: r.ok, nums: r.info.nums, orphan: r.info.orphan, instructed: r.info.instructed }])),
    };
    if (opt.json) {
      console.log(JSON.stringify(json));
      if (!json.ok) process.exitCode = 1;
      break;
    }
    if (action === '扫描') {
      console.log(`题干可读性：${rows.length} 张卡 —— 数据损坏 ${rows.filter(r => !r.ok).length} 张（阻断 ${blocked.length}），内容欠完整 ${warned.length} 张（只报告）`);
      for (const r of rows) {
        if (r.ok && !r.warns.length) continue;
        console.log(`${r.key.padEnd(14)} ${String(r.subject).padEnd(3)} ${r.ok ? 'ⓘ' : '⛔'} 题号[${r.info.nums.slice(0, 6).join(',')}] 孤儿号=${r.info.orphan ? '是' : '否'} 带指令=${r.info.instructed ? '是' : '否'}`);
        for (const p of r.problems) console.log('   ↳ ' + p.msg);
        for (const w of r.warns) console.log('   ⓘ ' + w.msg);
      }
      break;
    }
    /* 门禁 */
    if (json.ok) {
      console.log(`题干门禁通过：${rows.length} 张卡没有数据损坏（实体化标签 / 字面标签 / 标记不配对）。`);
      if (warned.length) {
        console.log(`   ⚠ 另有 ${warned.length} 张卡**内容欠完整**（题号是孤儿号却没带大题指令）——只报告不阻断。`);
        console.log('     这些是 2026-10-22 那批的历史欠账，登记在库根 `_整改台账.md`；整改要逐张回原卷核对，别批量改。');
        console.log('     看清单：node _题干门禁.mjs 扫描');
      }
    } else {
      console.log(`⛔ 题干门禁未通过：${blocked.length} 张卡有数据损坏 ——`);
      for (const p of json.problems) console.log('   ' + p);
      process.exitCode = 1;
    }
    break;
  }
  default:
    console.log('未知动作：' + action + '\n可用：扫描 / 门禁（均可加 --json）');
    process.exitCode = 2;
}
