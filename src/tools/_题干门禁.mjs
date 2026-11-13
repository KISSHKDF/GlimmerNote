#!/usr/bin/env node
/**
 * 拾光小册 · 题干可读性门禁（v1，2026-11-07 建；2026-11-08 增 ⑤ 语篇残篇 / ⑥ 长段未分段 / ⑦ 该画线却没画线 / ⑧ 语音类题无画线）
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
 *   ⑤ **语篇残篇**（2026-11-08 新增，A 级阻断；E0058/E0059 事故）：
 *      跨页语篇（p31→p32）**只抄了后半页** ⇒ 读者读不到标题与主题句，两段还被拍平成一个 `<p>`。
 *      前四条都管不着（没有实体化标签、标记配对、题号也不孤儿），所以漏过去了。
 *      ⑤a 题干含**残篇自述占位**（`本页为后半` / `前半在` 这类）——抄题的人自己写明了这是半篇；
 *      ⑤b 某个 `<p>` **以省略号开头且该段纯文本 ≥100 字符** —— 长文从半句开始 = 截断。
 *      ⚠ ⑤b 的**长度门槛是判据的一部分**：E0050（学生A）的
 *        `<p>…like Chinese, Maths, English and (4) ______.</p>` 是**合法的引用标记**
 *        （段首省略号，实测 plainOf 口径 45 字符）——判据宽到"见到段首省略号就红"就误报它。
 *   ⑥ **长段未分段**（B 级只报告）：最长段落纯文本 ≥400 字符 ⇒ 列出（原文多段被拍平成一段，
 *      读者看不出段落边界），供人工回原卷核对分段；**不阻断**（存量形态，且要靠人核原文）。
 *   ⑦ **该画线却没有画线标记**（2026-11-08 新增，A 级阻断。用户报障原话：
 *      「单词画线的字母，你在印刷版中没有体现出哪个字母画线了，这样的错误还不少」）：
 *      题干纯文本里出现 `画线` / `划线`，但**整份题干一个 `<u>` 都没有**。
 *      为什么是 A 级而不是只报告：这类题（判断读音异同 / 按画线部分归类 / 对画线部分提问 /
 *      替换或翻译画线部分）**不标出画线就没法作答** —— 印出去等于一道做不了的题（与 E0017 同级）。
 *      ⚠ 防误报：`<u>` 出现在**任意位置**即算已标（不必与"画线"二字同段）；
 *        实体化形态 `&lt;u&gt;` **不算**（那属判据①，别重复计 —— 两者修法不同：①改编码、⑦补标记）。
 *   ⑧ **语音类题没有任何画线标记**（2026-11-08 新增，B 级只报告）：
 *      题干 / 索引 question / 来源 / 类型命中 `语音|读音|发音|音标|重音|Pronunciation`，
 *      **且**同时出现对照/标注语境（`画线|相同|不同|归类|替换|对比|分组|标出|圈出|标注|一项`）
 *      却无 `<u>` ⇒ 列出待核清单，人工回原卷核对。
 *      ⚠ 为什么必须"共现对照语境"：固定大题指令「根据句意、中文释义、首字母和**音标**提示，
 *        写出句中所缺单词」里的"音标"与画线无关 —— 不收窄就会把一整批词汇题当假阳性长期挂着
 *        （真库实测 5 张，另一路 teammate 回原卷逐张核对确认全是误报，见 PHONETIC_CONTEXT 注释）。
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
/* 2026-11-12（审计 F05）：本函数已收敛到 `_题库发现.mjs`（零副作用共享模块）。
   原先 8 个工具各抄一份，实测 3 种实现（本文件那份与 SB 口径不同）⇒ 改一处漏一处且各自测试全绿。 */
function itemsOfJson(j, base) {
  const out = [];
  if (Array.isArray(j.items)) for (const it of j.items) out.push({ item: it, subject: j.subject || '', student: j.student, dirAbs: path.join(base, it.dir || it.id) });
  if (j.subjects) for (const [name, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) out.push({ item: it, subject: name, student: j.student, dirAbs: path.join(base, name, it.dir || it.id) });
  return out;
}
/* ★ 2026-11-12 修（静默假绿，全仓最忌讳的一类）：
   改前 `allCards` 里是 `try { … } catch { continue; }` —— 索引读不出时收集到的卡为 0，
   `judgeLibrary` 于是 `rows=[]`、`blocked=[]` ⇒ **ok: true**，`_体检.mjs` 还会打印
   「题干门禁（可读性）✔ 扫描 0 张，阻断 0」——**一份全绿但什么都没查的报告**。
   兄弟门禁 `_作答门禁.mjs` 用的是会响亮抛错的 `readJsonStrict`，两处口径不一致；
   而 CHANGELOG 早就为同类事故定过规矩：**一份都没扫到不得当作通过**。
   现在：读失败逐条记进本数组（不吞），并让 judgeLibrary 判红。 */
export const indexErrors = [];
export function allCards(root = ROOT) {
  const out = [];
  indexErrors.length = 0;
  for (const f of indexFiles(root)) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { indexErrors.push({ file: f, error: String((e && e.message) || e) }); continue; }
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

/* ---------- 段落抽取（判据⑤⑥用） ---------- */

/** 逐个 `<p>` 的**纯文本**。⑤b 只认 `<p>`（判据写的就是"某个 `<p>`"）。 */
export function paragraphTexts(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) out.push(plainOf(m[1]));
  return out;
}

/** 段落清单：有 `<p>` 就用 `<p>`；**一个 `<p>` 都没有**时把整段题干当"一个段落"
 *  —— 那种形态下"段落结构"本来就不存在，正是判据⑥要看的东西。 */
export function allParagraphTexts(html) {
  const ps = paragraphTexts(html);
  if (ps.length) return ps;
  const whole = plainOf(html);
  return whole ? [whole] : [];
}

/** 判据⑤a：**残篇自述占位** —— 抄题的人自己在题干里写明了"这只是半篇"。
 *  ⚠ 只认这些**具体措辞**，绝不宽到"出现『跨页』就红"：
 *    把跨页语篇**接成全文**之后的抬头是
 *    `【短文原文（课时练 7A 第31–32页·技能拓展提升 阅读短文，回答问题；跨页语篇已接成全文）】`
 *    —— 它提到"跨页"却是**完整**的，必须判绿（回归里有这条阴性对照）。 */
const FRAGMENT_SELF_DESC = /本页为后半|后半在本页|本页为前半|前半在|前半部分在|后半部分在|上页续|续上页|接下页|未完待续/;

/** ⑤a 的命中（返回命中的措辞，无命中返回 []） */
export function fragmentSelfDescHits(plain) {
  const m = String(plain || '').match(FRAGMENT_SELF_DESC);
  return m ? [m[0]] : [];
}

/** ⑤b 的长度门槛：**这一条是判据的一部分**，不是可调装饰。
 *  E0050（学生A）的 `<p>…like Chinese, Maths, English and (4) ______.</p>` 是合法的引用标记
 *  （段首省略号，实测 plainOf 口径 45 字符）——门槛去掉就误报它。 */
export const ELLIPSIS_MIN_LEN = 100;
/** ⑥ 的长度门槛：最长段落 ≥400 字符 ⇒ 列出（只报告）。 */
export const LONG_PARA_MIN = 400;

/** 省略号开头的形态（`…` / `...` / `。。。` 都算，实务里只用 `…`） */
const ELLIPSIS_LEAD = /^(?:…+|\.{3,}|。{3,}|．{3,})/;

/** 判据⑤b：**段落以省略号开头且足够长** —— 长文从半句开始 = 被截断。
 *  `minLen` 默认取门槛常量；回归用它证伪（把门槛降到 1 ⇒ 短引用行也会被命中）。 */
export function ellipsisLeadParagraphs(html, minLen = ELLIPSIS_MIN_LEN) {
  const out = [];
  for (const t of paragraphTexts(html)) {
    if (t.length < minLen) continue;
    const m = t.match(ELLIPSIS_LEAD);
    if (m) out.push({ len: t.length, mark: m[0], text: t });
  }
  return out;
}

/* ---------- 判据⑦⑧：该画线却没画线（2026-11-08 新增） ----------
   ★ 2026-11-12（审计 F03）：判据已搬到**零副作用共享模块** `_划线.mjs`（`_录题入库.mjs` 也从它 import）。
   为什么不能留在这里让入库器直接 import 本文件：本文件是 CLI，顶层会解析 `process.argv` ——
   被别的工具 import 时会拿调用方的命令行去解析并报「未知参数」（实测踩到）。
   本文件保留 re-export，是为了不破坏既有的 `GATE.*` 引用契约。 */
export {
  UNDERLINE_WORD, UNDERLINE_OBJECT, DRAW_WIRE_PHRASE,
  mentionsUnderlineSense, hasUnderlineMark, hasUnderlineMarkEntity,
} from './_划线.mjs';
import { mentionsUnderlineSense, hasUnderlineMark } from './_划线.mjs';
import { indexFiles } from './_题库发现.mjs';

/** 题干里有没有画线标记（**含实体化 / 双重转义形态** `&lt;u&gt;`）。
 *  判据⑦⑧用它判"是否已标"：实体化形态属判据①（转义层套了两次），
 *  **不在这里重复计** —— 否则同一处问题会同时报 ① 和 ⑦，读者会以为坏了两处（修法也不同：
 *  ① 是改编码、⑦ 是补标记）。 */
export function hasUnderlineMarkAny(html) {
  const s = String(html || '');
  if (hasUnderlineMark(s)) return true;
  return entityTagHits(s).some(e => /^\/?u$/i.test(String(e.tag || '')));
}

/** 判据⑧的语音类关键词（题干 / 索引 question / 来源 / 类型 命中即可）。 */
export const PHONETIC_WORD = /语音|读音|发音|音标|重音|pronunciation/i;

/** 判据⑧的**对照/标注语境**词：语音类关键词必须与它**共现**，才算"题面靠标记承载信息"的语音题。
 *
 *  ★ 2026-11-08 收窄（另一路 teammate 回原卷逐张核对后定的口径）：
 *    旧口径"命中语音类关键词却无 `<u>` 就报"把 5 张**假阳性**长期挂在待核清单上
 *    （真库实测：学生A·英语 E0026 / E0031 / E0041 / E0064，学生B·英语 E0062）。
 *    它们的"音标"二字来自**固定大题指令**「根据句意、中文释义、首字母和**音标**提示，
 *    写出句中所缺单词」——这是该大题的通用提示行，与"哪个字母画了线"无关；
 *    原卷上那些字母是**首字母提示**（`She is so f______`）或括号里的**音标**
 *    （`Please ______ (/rɪ'mɑnd/)`），**下方都没有下划线**。B 级清单是给人当工单用的，
 *    长期挂着假阳性等于没有清单 ⇒ 收窄。
 *
 *    判据形状：`语音类关键词` **且** `对照/标注语境` **且** 无 `<u>`。
 *    为什么"对照/标注语境"能分开：只有出现「画线 / 相同 / 不同 / 归类 / 替换 / 对比 / 分组 /
 *    标出 / 圈出 / 标注 / 一项」这类语义，题面才是**靠标记承载信息**（读者看不出标记就做不了）；
 *    只说"音标提示 / 听录音"的题，标记与否不影响作答。
 *
 *  ⚠ 诚实标注边界（本仓惯例：宁可漏判也不误报）——这条收窄**放弃了**这一类真阳性：
 *    语音题但指令里**一个对照/标注词都没有**（例如只写「说明每组单词的异同」「朗读并比较」
 *    这类少见措辞）。这类卡不会被 ⑧ 报出来，要靠人抽查；换来的是一份**能当工单用**的清单。
 *    （同类卡若同时写了"画线"二字，仍会被 A 级 ⑦ 拦下 —— ⑦ 不受本条收窄影响。） */
export const PHONETIC_CONTEXT = /画线|划线|相同|不同|归类|替换|对比|分组|标出|圈出|标注|一项/;

/** 逐卡判定：返回 {ok, problems[], warns[], info} */
export function judgeCard({ stem = '', question = '', source = '', type = '' } = {}) {
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

  /* ⑤ 语篇残篇（A 级：**阻断**）—— E0058/E0059 事故：跨页语篇（p31→p32）只抄了后半页。
     前四条都管不着：没有实体化标签、标记配对、题号也不是孤儿号 ⇒ 漏过去了一整类。
     铁证是**抄题的人自己写的占位**（「本页为后半，前半在 p31」）与"长文从半句开始"。 */
  const plain = plainOf(html);
  const frag = fragmentSelfDescHits(plain);
  if (frag.length) {
    problems.push({ code: 'fragment-self-described', msg: `题干里有**残篇自述占位**（"${frag[0]}"）——抄题的人自己写明了这只是半篇（跨页语篇只抄了后半页），读者读不到标题与主题句（E0058/E0059 事故）` });
  }
  const trunc = ellipsisLeadParagraphs(html, ELLIPSIS_MIN_LEN);
  if (trunc.length) {
    problems.push({ code: 'truncated-paragraph', msg: `有 ${trunc.length} 个段落**以省略号开头**且纯文本 ≥${ELLIPSIS_MIN_LEN} 字符（最长 ${Math.max(...trunc.map(t => t.len))} 字符）——长文从半句开始 = 被截断（合法的短引用行不受此判据约束，见 ELLIPSIS_MIN_LEN 注释）` });
  }

  /* ④ 题干不自足：孤儿题号 **且** 没有大题指令（两个条件同时成立才算） */
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

  /* ⑥ 长段未分段（B 级：**只报告**）—— 原文多段被拍平成一个 `<p>`，读者看不出段落边界。
     为什么只报告：分段对不对**只能回原卷核**（有的题原文本来就只有一个长段），
     机器判不了"该不该分段"；判成阻断会把存量一次打挂（与 ④ 同一条分级理由）。 */
  const paras = allParagraphTexts(html);
  const maxParaLen = paras.length ? Math.max(...paras.map(t => t.length)) : 0;
  if (maxParaLen >= LONG_PARA_MIN) {
    warns.push({ code: 'long-paragraph', msg: `最长段落纯文本 ${maxParaLen} 字符（≥${LONG_PARA_MIN}，共 ${paras.length} 段）——原文可能有多段被拍平成一个 <p>，读者看不出段落边界；请回原卷核对分段（只报告，不阻断）` });
  }

  /* ⑦ 该画线却没有画线标记（A 级：**阻断**）—— 用户报障「单词画线的字母，你在印刷版中
     没有体现出哪个字母画线了，这样的错误还不少」。提到"画线"却一个 `<u>` 都没有的题干，
     读者不知道哪个字母/哪个短语被画了线 ⇒ 判断读音异同、按画线归类、对画线部分提问、
     替换或翻译画线部分这些题**根本没法作答** ⇒ 印出去就是废题（与 ①②③⑤ 同为数据损坏级）。 */
  const hasU = hasUnderlineMarkAny(html);
  const mentionsUnderline = mentionsUnderlineSense(plain);
  if (mentionsUnderline && !hasU) {
    problems.push({ code: 'underline-missing', msg: '题干提到了**画线**（"画线 / 划线"），却一个 `<u>` 标记都没有——读者看不出哪个字母/哪个短语被画了线，这类题（判读音异同 / 按画线归类 / 对画线部分提问 / 替换或翻译画线部分）**不标画线就没法作答**。把被画线的字母或短语原样括起来：`classm<u>a</u>te`、`6. y<u>e</u>s  h<u>e</u>lp`、`The woman is <u>80 years old</u>.`' });
  }

  /* ⑧ 语音类题没有任何画线标记（B 级：**只报告**）—— 题干 / 索引 question / 来源 / 类型同时命中
     语音类关键词与"对照/标注语境"却无 `<u>` ⇒ 列出待核清单。为什么只报告：这类里可能只是题干
     引用了原题的词、画线在别处（语境另有出处），机器判不了，只能人工回原卷核对（与 ④⑥ 同分级）。
     ⚠ 2026-11-08 收窄：必须**共现对照/标注语境**，否则固定指令里的"音标提示"会把一批假阳性
       长期挂在清单上（见 PHONETIC_CONTEXT 注释：真库实测 5 张假阳性，全部来自那条固定指令）。 */
  const phonFields = [plain, plainOf(question), plainOf(source), String(type || '')].join(' ');
  const phonetic = PHONETIC_WORD.test(phonFields);
  const phoneticContext = PHONETIC_CONTEXT.test(phonFields);
  if (phonetic && phoneticContext && !hasU) {
    warns.push({ code: 'phonetic-no-underline', msg: '这是**语音类题**（命中 语音/读音/发音/音标/重音/Pronunciation，且题面出现 相同/不同/归类/替换/画线 这类对照语境），题干却没有 `<u>` 画线标记——请回原卷核对：若原题画了线，把被画线的字母/短语用 `<u>` 括出来（只报告，不阻断）' });
  }

  return {
    ok: problems.length === 0,
    problems, warns,
    info: {
      nums: [...new Set(nums)], orphan, instructed, plainLen: plain.length,
      paras: paras.length, maxParaLen,
      fragment: frag.length > 0, truncated: trunc.length > 0, longPara: maxParaLen >= LONG_PARA_MIN,
      underline: hasU, underlineWord: mentionsUnderline, phonetic, phoneticContext,
    },
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
  const indexFileCount = indexFiles(root).length;
  /* ★ 2026-11-12：读失败与"空真"都要能让 ok 变 false（见 allCards 上方注释）。
     空真判据取"有索引文件却一张卡都没读出来"——它比"读失败条数 > 0"更宽：
     索引能解析、但结构里根本没有 items/subjects 时同样属于"什么都没查到"。 */
  const idxErrs = indexErrors.slice();
  const emptyButHasIndex = indexFileCount > 0 && cards.length === 0;
  const rows = cards.map(x => {
    const p = path.join(x.dirAbs, STEM);
    const stem = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') : '';
    const r = judgeCard({ stem, question: x.item.question, source: x.item.source, type: x.item.type });
    return Object.assign({ key: x.key, id: x.item.id, subject: x.subject, status: x.item.status }, r);
  });
  /* 已归档的卡只记录不阻断（与 _着重号门禁.mjs 同口径） */
  const blocked = rows.filter(r => !r.ok && String(r.status || '') !== '已归档');
  /* 「不自足」是**内容欠完整**（不是数据损坏）⇒ 只报告不阻断；
     存量清单登记在库根 `_整改台账.md`，整改要逐张回原卷核对。 */
  const warned = rows.filter(r => r.ok && r.warns.length);
  /* ⑥ 长段未分段：**只报告**的存量清单（不依赖 ok —— 被 ⑤ 阻断的卡也要列出来供人核对）。 */
  const longParagraphs = rows.filter(r => r.info.longPara)
    .map(r => ({ key: r.key, maxParaLen: r.info.maxParaLen, paras: r.info.paras, blocked: !r.ok }))
    .sort((a, b) => b.maxParaLen - a.maxParaLen);
  /* ⑧ 语音类题无画线标记：**只报告**的待核清单（不依赖 ok —— 被 ⑦ 阻断的卡也要列出来）。
     ⚠ 条件是"关键词 **且** 对照/标注语境"（收窄见 PHONETIC_CONTEXT 注释）。 */
  const phoneticNoUnderline = rows.filter(r => r.info.phonetic && r.info.phoneticContext && !r.info.underline)
    .map(r => ({ key: r.key, id: r.id, subject: r.subject, blocked: !r.ok }));
  return {
    ok: blocked.length === 0 && !emptyButHasIndex && idxErrs.length === 0,
    rows, blocked, warned, longParagraphs, phoneticNoUnderline,
    indexErrors: idxErrs,
    stats: {
      total: rows.length,
      indexFiles: indexFileCount,
      indexErrors: idxErrs.length,
      block: blocked.length,
      archivedSkipped: rows.filter(r => !r.ok && String(r.status || '') === '已归档').length,
      warn: warned.length,
      /* 新判据的命中数（实测口径，便于"修完应归零"这类核对） */
      fragment: rows.filter(r => r.problems.some(p => p.code === 'fragment-self-described')).length,
      truncated: rows.filter(r => r.problems.some(p => p.code === 'truncated-paragraph')).length,
      longPara: longParagraphs.length,
      underlineMissing: rows.filter(r => r.problems.some(p => p.code === 'underline-missing')).length,
      phoneticNoUnderline: phoneticNoUnderline.length,
    },
  };
}

if (IS_ENTRY) switch (action) {
  case '扫描':
  case '门禁': {
    const lib = judgeLibrary();
    const { rows, blocked, warned, longParagraphs, phoneticNoUnderline } = lib;
    const json = {
      ok: lib.ok,
      action,
      stats: lib.stats,
      problems: [
        /* ★ 2026-11-12：这两条必须在最前 —— 它们是"判据本身没跑起来"，比任何单卡问题都严重。 */
        ...(lib.stats.indexErrors ? [`索引读失败 ${lib.stats.indexErrors} 份（不得当作通过）：` +
          lib.indexErrors.map(e => e.file + '（' + e.error + '）').join('、')] : []),
        ...(lib.stats.indexFiles > 0 && lib.stats.total === 0
          ? [`库里有 ${lib.stats.indexFiles} 份索引，却一张卡都没读出来 ⇒ 空真，不得当作通过`] : []),
        ...blocked.map(r => `${r.key}[${r.problems.map(p => p.msg).join('；')}]`),
      ],
      warns: warned.map(r => `${r.key}[${r.warns.map(w => w.msg).join('；')}]`),
      cards: Object.fromEntries(rows.map(r => [r.key, {
        ok: r.ok, nums: r.info.nums, orphan: r.info.orphan, instructed: r.info.instructed,
        fragment: r.info.fragment, truncated: r.info.truncated, maxParaLen: r.info.maxParaLen,
        underline: r.info.underline, underlineWord: r.info.underlineWord, phonetic: r.info.phonetic,
        phoneticContext: r.info.phoneticContext,
      }])),
      /* ⑥ 的清单单独成键（B 级只报告；含被 ⑤ 阻断的卡），供人回原卷核对分段 */
      longParagraphs,
      /* ⑧ 的清单单独成键（B 级只报告；含被 ⑦ 阻断的卡），供人回原卷核对画线 */
      phoneticNoUnderline,
    };
    if (opt.json) {
      console.log(JSON.stringify(json));
      if (!json.ok) process.exitCode = 1;
      break;
    }
    if (action === '扫描') {
      console.log(`题干可读性：${rows.length} 张卡 —— 数据损坏 ${rows.filter(r => !r.ok).length} 张（阻断 ${blocked.length}，其中⑦该画线却没画线 ${lib.stats.underlineMissing} 张），内容欠完整 ${warned.length} 张（只报告）`);
      for (const r of rows) {
        if (r.ok && !r.warns.length) continue;
        console.log(`${r.key.padEnd(14)} ${String(r.subject).padEnd(3)} ${r.ok ? 'ⓘ' : '⛔'} 题号[${r.info.nums.slice(0, 6).join(',')}] 孤儿号=${r.info.orphan ? '是' : '否'} 带指令=${r.info.instructed ? '是' : '否'} 最长段=${r.info.maxParaLen} 画线标记=${r.info.underline ? '有' : '无'}`);
        for (const p of r.problems) console.log('   ↳ ' + p.msg);
        for (const w of r.warns) console.log('   ⓘ ' + w.msg);
      }
      if (longParagraphs.length) {
        console.log(`\n⑥ 长段未分段（B 级只报告）：${longParagraphs.length} 张 —— 最长段落纯文本 ≥${LONG_PARA_MIN} 字符，回原卷核对段落边界`);
        for (const r of longParagraphs) console.log(`   ${r.key.padEnd(14)} 最长段 ${r.maxParaLen} 字符（共 ${r.paras} 段）${r.blocked ? '（另有 A 级问题，已阻断）' : ''}`);
      }
      if (phoneticNoUnderline.length) {
        console.log(`\n⑧ 语音类题没有画线标记（B 级只报告）：${phoneticNoUnderline.length} 张 —— 题干/来源/类型命中语音类关键词却无 <u>，回原卷核对画线在哪`);
        for (const r of phoneticNoUnderline) console.log(`   ${r.key.padEnd(14)} ${String(r.subject).padEnd(3)}${r.blocked ? '（另有 A 级问题，已阻断）' : ''}`);
      }
      break;
    }
    /* 门禁 */
    if (json.ok) {
      console.log(`题干门禁通过：${rows.length} 张卡没有数据损坏（实体化标签 / 字面标签 / 标记不配对 / 语篇残篇 / 该画线却没画线）。`);
      if (warned.length) {
        console.log(`   ⚠ 另有 ${warned.length} 张卡**内容欠完整**（题号是孤儿号却没带大题指令）——只报告不阻断。`);
        console.log('     这些是 2026-10-22 那批的历史欠账，登记在库根 `_整改台账.md`；整改要逐张回原卷核对，别批量改。');
        console.log('     看清单：node _题干门禁.mjs 扫描');
      }
      if (longParagraphs.length) {
        console.log(`   ⚠ 另有 ${longParagraphs.length} 张卡**长段未分段**（最长段落 ≥${LONG_PARA_MIN} 字符）——只报告不阻断，回原卷核对分段。`);
        console.log('     看清单：node _题干门禁.mjs 扫描（⑥ 段）');
      }
      if (phoneticNoUnderline.length) {
        console.log(`   ⚠ 另有 ${phoneticNoUnderline.length} 张卡是**语音类题却没有画线标记**——只报告不阻断，回原卷核对画线。`);
        console.log('     看清单：node _题干门禁.mjs 扫描（⑧ 段）');
      }
    } else {
      console.log(`⛔ 题干门禁未通过：${blocked.length} 张卡有数据损坏（语篇残篇、该画线却没画线均计入阻断）——`);
      for (const p of json.problems) console.log('   ' + p);
      process.exitCode = 1;
    }
    break;
  }
  default:
    console.log('未知动作：' + action + '\n可用：扫描 / 门禁（均可加 --json）');
    process.exitCode = 2;
}
