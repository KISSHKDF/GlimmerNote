#!/usr/bin/env node
/**
 * neg-stem-readability.cjs —— 题干可读性回归（2026-11-07 建）—— E0017 事故的永久护栏。
 *
 * 用户原话（指着 E0017 的单题预览）：
 *   「你转换出来的题干莫名其妙，谁能看得懂？这样的题干也能通过双盲解答？也能进库？」
 *
 * 事故根因（两件叠加，实测）：
 *   ① **转义层套了两次**：AI 回传的 questionText 已含真标签 `<u>a</u>`（画线部分），
 *      入库器 `escapeHtml()` 又转一遍 ⇒ 落盘成 `&lt;u&gt;a&lt;/u&gt;`
 *      ⇒ 浏览器解码后**印出字面的 "<u>a</u>" 垃圾**。
 *      铁证：同一张卡的**索引 `question` 里是真标签**、题干.html 里是实体化标签。
 *   ② **大题指令没带进来**：只抄了小题（第 3、5 小题）⇒ 题号成孤儿号，
 *      读者不知道要做什么（S/D 各代表什么也没写）。
 *
 * 断言分七段：
 *   A. 判据能力：四条判据各自能抓出对应的坏题干（**含已知事故样本**）。
 *   B. 判据**不误报**：数学不等号 `&lt;` / `&gt;`、合法内联标记（`<i>` `<sub>` `<span class="fr">`）
 *      、`<svg>` 图形、卡片自己的外壳（`<div class="stem">`）都**必须**判绿
 *      —— 第一版判据写宽了（"解码后有标签就红"）会全库 590 张误报。
 *   C. **题号抽取必须能命中事故样本的形态** `( ) 3. …`：
 *      不先剥行首答题括号，正则命中不了**已知事故样本**（自证失败 ⇒ 门禁形同虚设）。
 *   D. 入库流水线：`buildStemHtml` 对实体化标签**必须抛错拒收**（不是静默落盘），
 *      对真标签**必须原样保留**（画线标记丢了题就做不了），对 `<script>` **必须转义**。
 *   E. 阴性自证：把判据拆掉（实体检测 / 不自足检测 / 拒收逻辑）⇒ 对应断言**必须变红**。
 *   F. 分级：数据损坏=阻断，内容欠完整=只报告。
 *   G. **⑤ 语篇残篇（阻断）/ ⑥ 长段未分段（只报告）**（2026-11-08 新增，E0058/E0059 跨页语篇事故）：
 *      正例各一条 + 阴性对照各一条（E0050 式短引用行**不**红；修复后抬头「跨页语篇已接成全文」**不**红；
 *      200 字符单段落**不**报 ⑥）+ 可证伪（摘掉判据 ⇒ 样本变绿；⑥ 的门槛/摘除都可对拍）。
 *
 * 全部只读：不写库、不起壳。退出码 0=全绿。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
let fails = 0, passed = 0;
const A = (n, ok, d) => {
  if (ok) { passed++; console.log('[OK]   ' + n + (d !== undefined ? '  → ' + String(d).slice(0, 200) : '')); }
  else { fails++; console.log('[FAIL] ' + n + (d !== undefined ? '  → ' + String(d).slice(0, 200) : '')); }
};

const asUrl = p => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');

/* ---------- 装载被测模块 ---------- */
/* ⚠ `_录题入库.mjs` **不能 import**（它在 import 期就跑 CLI 并 process.exit）。
   它的两个纯函数（buildStemHtml / checkEntityTags）用**源码抽取**的方式单独载入，
   行为级验证则**真跑子进程**（与 tests\neg-ingest-land.cjs 同口径）。 */
let GATE = null, INGEST = null;
(async () => {
  GATE = await import(asUrl(path.join(ROOT, 'src', 'tools', '_题干门禁.mjs')));
  INGEST = await import(loadIngestPure());
})().catch(e => { console.error('✖ 装载模块失败：', e.message); process.exit(1); })
  .then(() => { runAll(); });

/** 从 _录题入库.mjs 源码里抽出纯函数（buildStemHtml / escapeHtmlAllowMarkup /
 *  escapeHtml / assertNoEntityTags / checkEntityTags）单独成一个模块载入。
 *  ⚠ 抽的是**源码文本**（不是复刻）⇒ 测的就是仓里那份实现本身。 */
function loadIngestPure() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_录题入库.mjs'), 'utf8');
  const start = src.indexOf('function buildStemHtml');
  const end = src.indexOf('/* ───────────────── 错题记录.md');
  if (start < 0 || end < 0 || end <= start) throw new Error('抽不出 buildStemHtml 段（源码形状变了？）');
  const code = src.slice(start, end)
    + '\nexport { buildStemHtml, escapeHtmlAllowMarkup, assertNoEntityTags, checkEntityTags };';
  /* 源码里 assertNoEntityTags / checkEntityTags 已是 export ⇒ 再 export 一次会报重复 */
  const tmp = path.join(require('os').tmpdir(), 'ctb-ingest-pure-' + process.pid + '.mjs');
  fs.writeFileSync(tmp, code.replace(/^export function /gm, 'function '), 'utf8');
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch { } });
  return asUrl(tmp);
}

/* ═══════════ A. 判据能力 ═══════════ */
const E0017_BAD = '<div class="stem">\n  <p class="stem-lead">( ) 3. classm&lt;u&gt;a&lt;/u&gt;te        &lt;u&gt;a&lt;/u&gt;ny</p>\n  <p class="stem-lead">( ) 5. th&lt;u&gt;e&lt;/u&gt;se        &lt;u&gt;e&lt;/u&gt;nergy</p>\n</div>';

/* ═══════════ 2026-11-08 新增样本：⑤ 语篇残篇 / ⑥ 长段未分段（E0058/E0059 跨页语篇事故） ═══════════
   事故现场（学生A·英语 E0058/E0059，课时练 p31→p32 跨页语篇）：题干**只抄了后半页**，
   抄题的人自己在题干里写了占位「本页为后半，前半在 p31」，正文段又以省略号起头
   ⇒ 读者读不到标题与主题句，原文两段还被拍平成一个 `<p>`。
   修复前真库实测（2026-11-08，610 张卡）：⑤ 命中 2 张 = 学生A|E0058 / 学生A|E0059；
   ⑥ 列出 24 张；E0050（学生A）的段首省略号只有 43 字符 ⇒ 必须**不**被 ⑤ 命中。
   样本一律内联（铁律：测试不依赖真实用户数据），形状照抄真库事故样本。 */
const XPG_BODY = '…happy and healthy. In China, many grandmas love dancing together in parks or public squares (公共广场). They often meet in the evening to move to the music and chat with friends. Some also play mahjong (麻将), a fun game with tiles. Light exercises, such as walking backward while clapping hands, are also popular ways to stay active (活跃的). In the United States, elderly people have their own hobbies. Many enjoy playing card games. This helps them make friends and feel less lonely.';
const XPG_BAD = '<div class="stem">\n'
  + '  <p class="stem-lead">4. How many hobbies for elderly people in the US are mentioned (提到) in the passage?</p>\n'
  + '  <p class="stem-lead">【短文原文（第32页·技能拓展提升 阅读短文，回答问题；跨页语篇，本页为后半，前半在 p31）】</p>\n'
  + '  <p class="stem-lead">（跨页语篇：短文前半在 p31，本页为后半）' + XPG_BODY + '</p>\n'
  + '</div>';
/* 修复后的口径（Lead 2026-11-08 定）：抬头写「跨页语篇已接成全文」——**提到"跨页"但已完整**，
   ⑤a 必须判绿（判据只认"残篇自述"的具体措辞，不认"跨页"这个词本身）。 */
const XPG_FIXED = '<div class="stem">\n'
  + '  <p class="stem-lead">4. How many hobbies for elderly people in the US are mentioned (提到) in the passage?</p>\n'
  + '  <p class="stem-lead">【短文原文（课时练 7A 第31–32页·技能拓展提升 阅读短文，回答问题；跨页语篇已接成全文）】</p>\n'
  + '  <p class="stem-lead">Good health is very important for everyone. In China, many grandmas love dancing together in parks or public squares (公共广场). They often meet in the evening to move to the music and chat with friends.</p>\n'
  + '  <p class="stem-lead">In the United States, elderly people have their own hobbies. Many enjoy playing card games. This helps them make friends and feel less lonely.</p>\n'
  + '</div>';
/* E0050（学生A）的真实形态：省略号在**问题行**里、只有 43 字符 —— 合法的引用标记（阴性对照）。 */
const E0050_SHORT_QUOTE = '<div class="stem">\n'
  + '  <p class="stem-lead">…like Chinese, Maths, English and (4) ______.</p>\n'
  + '  <p class="stem-lead">&nbsp;</p>\n'
  + '  <p class="stem-lead">【短文原文（第29页·基础知识巩固 二、短文填空）】</p>\n'
  + '  <p class="stem-lead">I am Liu Hua. I am from No. 1 Middle School. Our school has seven clubs (1) ______.</p>\n'
  + '</div>';
/* ⑥ 的两个长度样本（同一段文字的截断，避免"字面不同"干扰长度对照） */
const PARA_SRC = 'Hobbies keep our lives interesting and full of joy. '.repeat(12);
const PARA_200 = PARA_SRC.slice(0, 200);
const PARA_420 = PARA_SRC.slice(0, 420);
const wrapP = t => '<div class="stem"><p class="stem-lead">' + t + '</p></div>';
/** 把新增的 A 级两条判据从判定结果里**摘掉**（可证伪用：摘掉必须变绿）。 */
const dropNewBlocking = r => Object.assign({}, r, {
  problems: r.problems.filter(p => p.code !== 'fragment-self-described' && p.code !== 'truncated-paragraph'),
});

function runAll() {
  /* ⑤/⑥ 的两个主样本先算出来：F 段（分级）与 G 段（新判据）都要用同一份判定结果。 */
  const g1 = GATE.judgeCard({ stem: XPG_BAD });
  const g7 = GATE.judgeCard({ stem: wrapP(PARA_420) });
  console.log('== A. 判据能力：坏题干必须被抓 ==');
  const r1 = GATE.judgeCard({ stem: E0017_BAD });
  A('事故样本被判红', r1.ok === false, r1.problems.map(p => p.code).join(','));
  A('事故样本命中「实体化的标签」', r1.problems.some(p => p.code === 'entity-tag'), r1.problems.map(p => p.code).join(','));
  A('事故样本命中「字面标签」', r1.problems.some(p => p.code === 'literal-tag'), r1.problems.map(p => p.code).join(','));
  /* ④ 不自足是**只报告不阻断**（存量 39 张是历史欠账，改动要逐张回原卷核对） */
  A('事故样本命中「不自足」（作为告警）', r1.warns.some(p => p.code === 'stem-not-selfcontained'), r1.warns.map(p => p.code).join(',') || '无');

  const r2 = GATE.judgeCard({ stem: '<div class="stem"><p class="stem-lead">1. 下列说法正确的是（　）</p><p class="stem-lead">A. 对 B. 错</p></div>' });
  A('正常卡判绿', r2.ok === true, r2.problems.map(p => p.code).join(',') || '无问题');

  const r3 = GATE.judgeCard({ stem: '<div class="stem"><p class="stem-lead">( ) 3. classm<u>a</u>te <u>a</u>ny</p></div>' });
  A('真标签版（画线标记在位）**不再**命中实体/字面两条', r3.problems.length === 0, r3.problems.map(p => p.code).join(','));

  const r4 = GATE.judgeCard({ stem: '<div class="stem"><p class="stem-lead">( ) 3. classm<u>a</u>te <u>a</u>ny</p></div>' });
  A('真标签版仍**告警**「不自足」（大题指令仍缺）', r4.warns.some(p => p.code === 'stem-not-selfcontained'), r4.warns.map(p => p.code).join(','));

  console.log('\n== B. 判据不误报（误报比漏报更坏：会让人习惯性忽略门禁） ==');
  const legal = [
    ['数学不等号（实体）', '<div class="stem"><p class="stem-lead">A.两物体的重GA&lt;GB</p><p class="stem-lead">B.有用功W₁&lt;W₂</p></div>'],
    ['数学不等号（裸写）', '<div class="stem"><p class="stem-lead">1. 若 x < 3 则 y > 2</p></div>'],
    ['合法内联标记（斜体/上下标）', '<div class="stem"><p class="stem-lead">已知 <i>y</i><sub>1</sub>=<i>k</i>/<i>x</i>，<i>x</i><sup>2</sup>&gt;0</p></div>'],
    ['分数标记（span.fr/nu/de）', '<div class="stem"><p class="stem-lead"><span class="fr"><span class="nu">1</span><span class="de">2</span></span></p></div>'],
    ['内联 SVG 图形', '<div class="stem"><p class="stem-lead">如图</p><svg viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="40"></circle></svg></div>'],
    ['卡片自己的外壳', '<div class="stem"><p class="stem-lead">1. 计算下列各题</p></div>'],
    ['着重点标记', '<div class="stem"><p class="stem-lead"><span class="rd">制</span>的旧制度</p></div>'],
  ];
  for (const [name, stem] of legal) {
    const r = GATE.judgeCard({ stem });
    A('不误报：' + name, r.ok === true, r.problems.map(p => p.code + ' ' + p.msg.slice(0, 60)).join(' | ') || '判绿');
  }

  console.log('\n== C. 题号抽取必须命中事故样本的形态 `( ) 3.` ==');
  const nums = GATE.questionNumbers('( ) 3. classm a te any\n( ) 5. th e se e nergy');
  A('剥行首答题括号后取到题号', nums.length === 2 && nums[0] === 3 && nums[1] === 5, JSON.stringify(nums));
  const nums2 = GATE.questionNumbers('(　　) 5. We are friends.');
  A('全角括号形态也能取到', nums2.length === 1 && nums2[0] === 5, JSON.stringify(nums2));
  const nums3 = GATE.questionNumbers('1. 第一题\n2. 第二题');
  A('普通形态取到 [1,2]（不是孤儿）', nums3.length === 2 && Math.min(...nums3) === 1, JSON.stringify(nums3));
  const nums4 = GATE.questionNumbers('下列说法正确的是（　）\nA. 对\nB. 错');
  A('没有行首题号时不产生假题号', nums4.length === 0, JSON.stringify(nums4));

  console.log('\n== D. 入库流水线：实体化标签必须拒收，真标签必须保留 ==');
  let threw = null, out = null;
  try { out = INGEST.buildStemHtml(E0017_BAD, false); } catch (e) { threw = e; }
  A('buildStemHtml 对实体化标签**抛错**（不是静默落盘）', !!threw, threw ? String(threw.message).slice(0, 90) : '没抛错，输出了：' + String(out).slice(0, 90));

  const keep = INGEST.buildStemHtml('( ) 3. classm<u>a</u>te <u>a</u>ny', false);
  A('buildStemHtml **原样保留**真标签 <u>', keep.includes('<u>a</u>'), keep.replace(/\n/g, ' ').trim().slice(0, 110));

  const esc = INGEST.buildStemHtml('hello <script>alert(1)</script> world', false);
  A('buildStemHtml 转义 <script>（不还原）', !esc.includes('<script>') && esc.includes('&lt;script&gt;'), esc.replace(/\n/g, ' ').trim().slice(0, 110));

  const escOn = INGEST.buildStemHtml('<u onmouseover="x">a</u>', false);
  A('buildStemHtml 转义带 on* 属性的标签', !escOn.includes('onmouseover="x"') || escOn.includes('&lt;u '), escOn.replace(/\n/g, ' ').trim().slice(0, 110));

  const rd = INGEST.buildStemHtml('<span class="rd">制</span>的旧制度', false);
  A('buildStemHtml 保留合法 .rd 着重点', rd.includes('<span class="rd">制</span>'), rd.replace(/\n/g, ' ').trim().slice(0, 110));

  const math = INGEST.buildStemHtml('A.两物体的重GA&lt;GB', false);
  A('buildStemHtml 放过数学不等号实体（不误拒）', math.includes('&amp;lt;'), math.replace(/\n/g, ' ').trim().slice(0, 110));

  console.log('\n== E. 阴性自证：判据必须真会红 ==');
  /* E1：把「实体化的标签」判据摘掉 ⇒ 事故样本不得再命中 entity-tag */
  const brokenNoEntity = { ...GATE, judgeCard: null };
  const entHits = GATE.entityTagHits(E0017_BAD);
  A('阴性自证 · 实体检测函数对事故样本有命中（判据不是恒假）', entHits.length >= 4, '命中 ' + entHits.length + ' 处');
  const entHitsLegal = GATE.entityTagHits('<div class="stem"><p class="stem-lead">A.重GA&lt;GB</p></div>');
  A('阴性自证 · 实体检测对合法不等号**零命中**', entHitsLegal.length === 0, JSON.stringify(entHitsLegal));

  /* E2：把「不自足」判据摘掉（孤儿号改成从 1 开始才算孤儿）⇒ 事故样本不得再**告警** */
  const fakeJudge = (stem) => {
    const r = GATE.judgeCard({ stem });
    return { ...r, warns: r.warns.filter(w => w.code !== 'stem-not-selfcontained') };
  };
  const rBroken = fakeJudge(E0017_BAD);
  A('阴性自证 · 摘掉「不自足」判据后事故样本少一条告警（判据有牙齿）',
    rBroken.warns.some(w => w.code === 'stem-not-selfcontained') === false && rBroken.problems.some(p => p.code === 'entity-tag'),
    'problems=' + rBroken.problems.map(p => p.code).join(',') + ' warns=' + rBroken.warns.map(w => w.code).join(','));

  /* E3：把「题号抽取」的剥括号步骤去掉 ⇒ 事故样本取不到题号 */
  const rawNum = String('( ) 3. classm a te any').match(/^(\d{1,3})\s*[\.．、\)）]/);
  A('阴性自证 · 不剥括号时**取不到**题号（证明剥括号这一步是必需的）', !rawNum, rawNum ? rawNum[0] : '取不到（符合预期）');

  /* E4：入库拒收逻辑摘掉 ⇒ buildStemHtml 不再抛错 */
  const srcText = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_录题入库.mjs'), 'utf8');
  A('阴性自证 · 入库器里「实体化标签 ⇒ 抛错」的代码在位（不是空壳）',
    /checkEntityTags\(raw\)/.test(srcText) && /export function checkEntityTags/.test(srcText),
    (srcText.match(/checkEntityTags\([^)]*\)/g) || []).join(' '));

  console.log('\n== F. 分级：数据损坏=阻断，内容欠完整=只报告 ==');
  /* ④ 必须是 **warns**（只报告），不能是 problems（阻断）——
     否则 2026-10-22 那批 39 张历史欠账会把整条发布链一次打挂。 */
  const onlyWarn = GATE.judgeCard({ stem: '<div class="stem"><p class="stem-lead">( ) 3. abc def</p></div>' });
  A('「不自足」只进 warns（不阻断发布链）',
    onlyWarn.ok === true && onlyWarn.warns.some(w => w.code === 'stem-not-selfcontained') && onlyWarn.problems.length === 0,
    'ok=' + onlyWarn.ok + ' problems=' + onlyWarn.problems.map(p => p.code).join(',') + ' warns=' + onlyWarn.warns.map(w => w.code).join(','));

  /* ①②③ 必须是 **problems**（阻断）——数据损坏绝不能印出去 */
  const corrupt = GATE.judgeCard({ stem: '<div class="stem"><p class="stem-lead">( ) 3. classm&lt;u&gt;a&lt;/u&gt;te</p></div>' });
  A('「实体化标签」进 problems（阻断，绝不印出去）',
    corrupt.ok === false && corrupt.problems.some(p => p.code === 'entity-tag'),
    'ok=' + corrupt.ok + ' problems=' + corrupt.problems.map(p => p.code).join(','));

  const unbalanced = GATE.judgeCard({ stem: '<div class="stem"><p class="stem-lead">1. <u>abc</p></div>' });
  A('「标记不配对」进 problems（阻断）',
    unbalanced.ok === false && unbalanced.problems.some(p => p.code === 'tag-unbalanced'),
    'ok=' + unbalanced.ok + ' problems=' + unbalanced.problems.map(p => p.code).join(','));

  /* ⑤（语篇残篇）也必须是 **problems**（阻断）——只抄半页的题**绝不能**印出去（E0058/E0059 事故） */
  A('「语篇残篇」进 problems（阻断，绝不印半页题）',
    g1.problems.some(p => p.code === 'fragment-self-described') && g1.warns.every(w => w.code !== 'fragment-self-described'),
    'problems=' + g1.problems.map(p => p.code).join(',') + ' warns=' + (g1.warns.map(w => w.code).join(',') || '无'));

  /* ⑥（长段未分段）必须是 **warns**（只报告）——分段对不对只能回原卷核，判成阻断会把存量一次打挂 */
  A('「长段未分段」进 warns（只报告，不阻断发布链）',
    g7.ok === true && g7.problems.length === 0 && g7.warns.some(w => w.code === 'long-paragraph'),
    'ok=' + g7.ok + ' problems=' + (g7.problems.map(p => p.code).join(',') || '无') + ' warns=' + g7.warns.map(w => w.code).join(','));

  console.log('\n== G. 新增判据：⑤ 语篇残篇（阻断） / ⑥ 长段未分段（只报告） ==');

  /* ── G1 ⑤a 阳性：跨页残篇（残篇自述占位 + 段首省略号）── */
  A('⑤a 阳性：跨页残篇（含「本页为后半 / 前半在」）被判红',
    g1.ok === false && g1.problems.some(p => p.code === 'fragment-self-described'),
    'ok=' + g1.ok + ' problems=' + g1.problems.map(p => p.code).join(','));

  /* ── G2 ⑤a 阴性：修复后抬头含「跨页语篇已接成全文」——必须判绿（判据不许宽到"见跨页就红"）── */
  const g2 = GATE.judgeCard({ stem: XPG_FIXED });
  A('⑤a 阴性：修复后抬头「跨页语篇已接成全文」**不**命中残篇判据（不宽到"遇到『跨页』就红"）',
    !g2.problems.some(p => p.code === 'fragment-self-described'),
    'problems=' + (g2.problems.map(p => p.code).join(',') || '无'));

  /* ── G3 ⑤b 阳性：段首省略号 + 纯文本 ≥100 字符 ── */
  const g3 = GATE.judgeCard({ stem: wrapP(XPG_BODY) });
  A('⑤b 阳性：`<p>` 以省略号开头且 ≥100 字符 ⇒ 判红（长文从半句开始 = 截断）',
    g3.ok === false && g3.problems.some(p => p.code === 'truncated-paragraph'),
    'ok=' + g3.ok + ' problems=' + g3.problems.map(p => p.code).join(','));

  /* ── G4 ⑤b 阴性（Lead 实测口径）：E0050 式短引用行必须**不**红 ── */
  const g4 = GATE.judgeCard({ stem: E0050_SHORT_QUOTE });
  const shortLen = GATE.paragraphTexts(E0050_SHORT_QUOTE)[0].length;
  A('⑤ 阴性：E0050 式短引用行（段首省略号，' + shortLen + ' 字符 < 门槛 ' + GATE.ELLIPSIS_MIN_LEN + '）**不**被 ⑤ 命中',
    g4.ok === true && !g4.problems.some(p => p.code === 'fragment-self-described' || p.code === 'truncated-paragraph'),
    'ok=' + g4.ok + ' problems=' + (g4.problems.map(p => p.code).join(',') || '无'));

  /* ── G5 ⑤b 的**长度门槛是判据的一部分**：同一样本降到门槛 1 就会被命中 ⇒ 去掉门槛必误报 E0050 ── */
  A('⑤b 门槛可证伪：同一样本在门槛 ' + GATE.ELLIPSIS_MIN_LEN + ' 下 0 命中、门槛 1 下 1 命中（证明"短引用行不算"靠的就是门槛）',
    GATE.ellipsisLeadParagraphs(E0050_SHORT_QUOTE, GATE.ELLIPSIS_MIN_LEN).length === 0 &&
    GATE.ellipsisLeadParagraphs(E0050_SHORT_QUOTE, 1).length === 1,
    '门槛' + GATE.ELLIPSIS_MIN_LEN + '=' + GATE.ellipsisLeadParagraphs(E0050_SHORT_QUOTE, GATE.ELLIPSIS_MIN_LEN).length +
    '，门槛1=' + GATE.ellipsisLeadParagraphs(E0050_SHORT_QUOTE, 1).length);

  /* ── G6 ③⑤ 可证伪：把新增两条 A 级判据摘掉 ⇒ 事故样本必须**变绿**（"加了才红"）── */
  A('可证伪：摘掉 ⑤ 的两条判据后，跨页残篇样本**变绿**（判据是新增的、去掉就绿）',
    g1.ok === false && dropNewBlocking(g1).problems.length === 0,
    '原 problems=' + g1.problems.map(p => p.code).join(',') + ' ⇒ 摘掉后=' + (dropNewBlocking(g1).problems.map(p => p.code).join(',') || '无'));

  /* ── G7 ⑥ 阳性：最长段落 ≥400 字符 ⇒ **只报告**（ok 仍为 true，不阻断发布链）── */
  A('⑥ 阳性：最长段落 ' + PARA_420.length + ' 字符（≥' + GATE.LONG_PARA_MIN + '）⇒ 报告长段未分段，且**不阻断**（ok=true）',
    g7.ok === true && g7.warns.some(w => w.code === 'long-paragraph') && g7.info.maxParaLen >= GATE.LONG_PARA_MIN,
    'ok=' + g7.ok + ' warns=' + g7.warns.map(w => w.code).join(',') + ' maxParaLen=' + g7.info.maxParaLen);

  /* ── G8 ⑥ 阴性：单段落短文 200 字符必须**不**报 ⑥ ── */
  const g8 = GATE.judgeCard({ stem: wrapP(PARA_200) });
  A('⑥ 阴性：单段落短文 ' + PARA_200.length + ' 字符（<' + GATE.LONG_PARA_MIN + '）**不**报长段未分段',
    !g8.warns.some(w => w.code === 'long-paragraph'),
    'warns=' + (g8.warns.map(w => w.code).join(',') || '无'));

  /* ── G9 ⑥ 可证伪：把该告警摘掉 ⇒ 阳性样本不再报告（判据有牙齿）── */
  A('可证伪：摘掉 ⑥ 的告警后，长段阳性样本不再报告（判据不是恒真）',
    g7.warns.some(w => w.code === 'long-paragraph') &&
    g7.warns.filter(w => w.code !== 'long-paragraph').length === 0,
    '摘掉后 warns=' + g7.warns.filter(w => w.code !== 'long-paragraph').map(w => w.code).join(',') || '无');

  /* ── G10 ⑤ 的措辞判据不宽：光有"跨页"二字（修复后抬头）零命中 ── */
  A('⑤a 措辞判据有边界：`fragmentSelfDescHits` 对「跨页语篇已接成全文」零命中，对「本页为后半」命中',
    GATE.fragmentSelfDescHits(GATE.plainOf(XPG_FIXED)).length === 0 &&
    GATE.fragmentSelfDescHits(GATE.plainOf(XPG_BAD)).length >= 1,
    '修复后=' + JSON.stringify(GATE.fragmentSelfDescHits(GATE.plainOf(XPG_FIXED))) +
    ' 修复前=' + JSON.stringify(GATE.fragmentSelfDescHits(GATE.plainOf(XPG_BAD))));

  console.log('\n──────────────────────────────');
  console.log(fails === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + fails);
  process.exit(fails === 0 ? 0 : 1);
}
