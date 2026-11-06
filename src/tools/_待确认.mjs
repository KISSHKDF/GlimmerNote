#!/usr/bin/env node
/**
 * 错题本·待确认台账（v2.2）—— 「需要人回答」的悬空问题唯一落点
 *
 * 解决什么：错题卡里散落着大量「待口述确认」「归属存疑」「疑似漏判」「卷面看不清」，
 * 分散在 41 个 错题记录.md + 2 个 _索引.json 里，每次要翻十几张卡才找得齐 → 全并到一处。
 *
 * 设计原则（与 _标记复习.mjs / _盲解复核.mjs 一致）：
 *   1) 单一真源：_待确认.json（本工具唯一写入）；_待确认清单.md 只是渲染页，勿手改；
 *   2) 机器门禁：`门禁` 有未确认项即退出码 1，可挂在组卷/交付前自检；
 *   3) 只增不删：条目只改 status（未确认→已确认/已作废），永不删行，答案永久留痕。
 *
 * 用法（node _待确认.mjs <动作> [参数]）：
 *   清单  [--refresh]                        从 _待确认.json 生成 _待确认清单.md
 *   加    --student 学生A --subject 化学 --card C0003 --kind 笔迹归属 --ask 孩子
 *         --q "问题一句话" [--detail "证据/影响"] [--source "来源"] [--date 2026-10-06]
 *         [--qref "第12(2)题 · 「P 在 C 左侧」分支"] [--box "x,y,w,h"]
 *   定位  --id T004 [--qref "第18(4)题"] [--box "x,y,w,h"]   回原卷定位：这条问的是哪一题 + 证据图上的高亮框（源图像素）
 *   定位  --id T004 --origpage "<小名>/原卷/<批次>/整页.jpg" --origbox "x,y,w,h"   无卡待办的原图链路：登记这道题所在的**整页** + 0~1 归一化红框（两者必须成对给）
 *   定位  --auto [--force] [--dry]             批量补题号：缺 qRef 的按 cardId 机械推导（--force 连已登记的重算，--dry 只预览）
 *   定位                                     不带参数 = 打印定位覆盖率（缺题号 / 有题号缺框 / 缺证据图）
 *   答    --id T003 --answer "孩子答：..." [--note "补充"]
 *   作废  --id T003 --answer "为什么作废"
 *   撤回  --id T003                          误答回滚：status 回「未确认」、清空 answer（答案原文留在 stdout）
 *   删    --id T025                          仅限「未确认且无答案」的误加条目（有答案的一律走 作废）
 *   改问题 --id T056 --q "完整问题文本" [--note "为什么改"]   订正/补全问题文本；新旧字数与理由留痕在 questionFix
 *   改详情 --id T082 --detail "改写后的说明全文" [--note "为什么改"]   把 detail 里的内部黑话换成人话；留痕在 detailFix
 *   纠因  --id T003 --why "为什么纠正（家长/用户原话）" [--scope 卡|配方|流程] [--target <包/卡标识>]
 *                                            追加式记录「纠正原因」→ 该条目 corrections[]（只追加、旧字段一字不动）；
 *                                            同一条 why 重复提交幂等（不重复追加、不写盘）；条目不存在 / --why 空 ⇒ 退出码 2
 *   候选  --id T003 --kind 卡|配方|流程 --target <卡号/配方id/流程名> --payload "<正文>" | --payload-file <文件> [--date]
 *                                            建/复用一条「修订草案」→ 该条目 candidates[]（只追加）；
 *                                            稳定 ID = c-<sha256(kind|target|payloadDigest) 前12位>；
 *                                            同 kind+target+正文重复提交 ⇒ 复用原 candId（不新增、不写盘）
 *   修订  --id T003 [--json]                  列出该条目的候选与修订链（**只读**，一个字节都不写）
 *   采用  --id T003 --candidate <candId> [--dry] [--json]
 *                                            **正式写入入口**：持锁 + 事务落盘 → `<库根>\_修订\<kind>\<目标>\<candId>.md`
 *                                            + 该条目 revisions[]（append-only，旧字段一字不动）；
 *                                            同一 candId 重复采用幂等（不重复写、不重复追加）；--dry 一个字节都不写
 *   作废候选 --id T003 --candidate <candId>  把候选标「已作废」（不改其它字段）；已采用/已作废 ⇒ 退出码 3
 *   状态  [--student 学生A] [--ask 孩子]
 *   门禁                                     有未确认 → 退出码 1（--json 输出机器可读）
 *   证据 [--all-archived]                    有未确认项缺证据图 / 图路径失效 → 退出码 1（--json 输出机器可读）
 *                                            --all-archived：连"已办结项的证据链已断"也一并阻断（默认只报告）
 *   措辞                                     给人看的文本含内部黑话（答案键/录入/判卷/图形层…）→ 未确认项命中即退出码 1（--json 机器可读）
 *   问法                                     未确认项的 question 不合「三段式」（见下）→ 退出码 1（--json 机器可读）
 *        待办问法三段式（2026-10-19 用户质询「这道题里没有你要问的那几个词啊」后立的规矩）：
 *        ① 位置说人话：第几页 + 卷面上印着的栏目名 + 第几题/第几空（不许【E0011】【p3漏判】页-14- 词语一.3 这类内部速记）；
 *        ② 引用卷面原文：孩子写上去的字用「」框出来——印刷题面里往往没有这些字，不框出来家长对着卷子找不到；
 *        ③ 末句能照着念：带问号，写成"你为什么…？""是没想起A，还是觉得B多余？"，不许"…的产出逻辑/选择依据/思路/过程"这类名词化收尾。
 *        错题卡号、原卷坐标、判错口径这些**给我自己看的**一律写进 detail，不占问句。
 *        写入路径（加/改问题）默认拒绝不合式的问法，确需保留加 --force。
 *   去黑话  [--id Txxx] [--dry|--apply]       按 JARGON 表把 question/detail/qRef 的黑话换成人话，留痕同 改问题
 *                                            （写入路径 加/改问题/改详情 已默认拒绝黑话，确需原文加 --force）
 *   同步  --file <ctb-pending-*.json>        落库首页「待办工作台」导出的结论包（幂等）
 *
 * ⚠️ 证据图是待办的**必有字段**（2026-10-07 用户质询「原来待办都是带图的，现在怎么没图了？」）：
 *    加条目时没给 --evidence，待办在首页就是一块空白——看的人不知道这条在问什么。
 *    故 env: 本工具所有入口都会把「缺图」喊出来，首页也会渲染成显式红块，绝不静默空白。
 *
 * ⚠️ 题号（qRef）与证据图同级，同为**必有字段**（2026-10-08 用户质询「为什么所有待办都挂红条」）：
 *    60 页批次用脚本批量 加 了 22 条、一条 --qref 都没传，首页 22/22 全红条——缺图当年加了护栏，
 *    缺题号却静默通过，属同类漏洞第二次踩。现在：`加` 没给 --qref 就先按 cardId 自动推导（并明写出来），
 *    推不出才喊话；历史欠账用 `定位 --auto` 一次补齐；`门禁 --json` 同时输出 noQref/noBox 供自检消费。
 *
 * kind ∈ 笔迹归属 / 错因口述 / 老师漏判 / 卷面辨认 / 口径确认 / 系统维护 / 其他 / 经验线索
 *        ⚠「经验线索」= 家长/用户对某道题或某条方法的**纠正理由**（`纠因` 记 corrections[]，或 加 --kind 经验线索）。
 *          它与 `src\app\js\model.js` 的 `M.KINDS` 是**同一事实的两份拷贝**，改一处必须改两处
 *          （一致性由 `tests\neg-reason-entry.cjs` 的「两份逐字相等」断言钉住：只改一份即红）。
 * askWho ∈ 孩子 / 老师 / 原卷 / 系统
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
/* APP_ROOT：配方现值（`<AppRoot>\recipes\<id>\prompt.md`）要用它，与 `_配方.mjs::recipesRoot()` 同一个根口径
   （那里也是 `path.join(APP_ROOT, 'recipes')`，唯一来源都是本模块导出的 APP_ROOT）。 */
import { libraryRoot, toolPath, APP_ROOT } from './_库根.mjs';
/* withLibWrite = 持锁 + 多文件事务的一次性包装（要么全成、要么全退）。`采用` 用它，
   见 _安全写.mjs 顶部 D01/D02 两段。 */
import { readJsonStrict, writeJsonAtomic, writeTextAtomic, acquireLibLock, withLibWrite } from './_安全写.mjs';
/* ★ 2026-11-03（批次 2 / P2-2「统一坐标系」）：像素框 ↔ 归一化框的换算**只有这一份实现**
   （`src\tools\_区域坐标.mjs`，契约见 `docs\区域契约.md`）。本工具是**读取侧**：
   磁盘上的像素 `box` 一个字不改，只在输出里附加 `boxNorm/imgW/imgH`。
   ⚠ 该模块必须保持**零导入期副作用**（不求值库根、不抢锁）——见它自己的头注。 */
import { normEvidenceBox, evidenceAbs } from './_区域坐标.mjs';
/* ★ 2026-11-04（M1·实测）：参数解析改走**唯一实现** `_参数.mjs`。 */
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 现在是**用户库根**，不再是"本脚本所在目录"。
   兄弟工具一律用 toolPath(...)，见 _库根.mjs。 */
const ROOT = libraryRoot();
/* ★ 2026-10-30（外部审计 D02）：跨进程写锁（壳 / HTTP 服务端 / 命令行三条通道共用同一把，见 _安全写.mjs）。
   本工具是「读出来 → 改内存 → 写回去」的模式：没有这把锁时，另一个通道可以在两者之间插进来，
   两边各写一份原子文件，**后完成的那个把前一个的修改整段丢掉**（审计复现的现场）。
   锁从进程启动持有到退出（工具都是短命进程，登记式持锁最省事也最少漏）。 */
const __releaseLibLock = acquireLibLock(ROOT, { label: '_待确认' });
process.on('exit', __releaseLibLock);
const DB = path.join(ROOT, '_待确认.json');
const MD = path.join(ROOT, '_待确认清单.md');

/* ⚠ 与 `src\app\js\model.js` 的 `M.KINDS` 逐字相同（两份拷贝，一致性由 tests\neg-reason-entry.cjs 钉住）。 */
const KINDS = ['笔迹归属', '错因口述', '老师漏判', '卷面辨认', '口径确认', '系统维护', '其他', '经验线索'];

/* ---------- 措辞门禁（2026-10-10）：给用户看的文本禁用 agent 内部黑话 ----------
 * 起因：用户质询「错题库待办，好多措辞说『答案键』，这是什么意思啊，我理解不过来」。
 * 「答案键」＝answer key 直译＝标准答案，纯属我自己造的词；同批漏到界面的还有
 * 录入/判卷/图形层/双路/掩膜/清稿/Lead/盲解…（86 条里 30 条命中）。
 * 光靠"下次注意"必然复发（同 L-331 族：没有牙齿的纪律等于没有），所以：
 *   ① 写入路径（加 / 改问题 / 改详情）命中硬黑话 → 当场拒绝，除非显式 --force；
 *   ② `措辞` 动作＝机器门禁：未确认条目有黑话 → 退出码 1（已办结的历史条目只列不拦）；
 *   ③ `去黑话` 动作＝按本表批量改写历史欠账，仍走同一留痕（questionFix / detailFix）。
 * 只作用于 question / detail（给人看的两句话）；verdictNote / dispositionNote 是给我自己看的，不在射程内。 */
const JARGON = {
  '答案键': '标准答案',
  '独立判卷': '不看答案独立做一遍',
  '判卷者': '独立做题的人',
  '判卷': '批改',
  '录入答案': '我们原先记在卡上的答案',
  '录入': '原先记在卡上',
  '图形层独立读图': '独立看图',
  '图形层': '看图',
  '双路': '两遍独立重做',
  '掩膜': '遮住答案的副本',
  '清稿': '去掉答案的题面',
  '组卷池': '练习卷',
  '组卷': '排进练习卷',
  '消歧': '把歧义说清',
  '子代理': '另一个独立做事的人',
  '盲解': '不看答案独立做一遍',
  '像素级判读': '放大原卷逐点看',
  '像素级': '放大逐点',
  '像素': '放大原卷',
  '题干指纹': '题干校验码',
  '指纹': '校验码',
  '准入': '允许进练习卷',
  '挂账': '登记待办',
  'Lead': '我',
};
const JARGON_TERMS = Object.keys(JARGON).sort((a, b) => b.length - a.length);   // 长的先替换，防截断
const jargonHits = text => JARGON_TERMS.filter(t => String(text || '').includes(t));
const deJargon = text => {
  let s = String(text || '');
  for (const t of JARGON_TERMS) if (s.includes(t)) s = s.split(t).join(JARGON[t]);
  return s;
};
function guardJargon(where, text, force) {
  const hit = jargonHits(text);
  if (!hit.length) return;
  if (force) { console.error(`⚠ ${where} 含内部黑话「${hit.join('、')}」，已按 --force 放行（建议改成：${hit.map(t => JARGON[t]).join('、')}）`); return; }
  console.error(`❌ ${where} 含内部黑话：「${hit.join('、')}」——这是给你看的文本，不是我的内部记录。`);
  for (const t of hit) console.error(`   ${t} → ${JARGON[t]}`);
  console.error('   改成人话重试；确需保留原文（如引用原话）加 --force。');
  process.exit(2);
}
/* ---------- 问法门禁（2026-10-19）：待办必须「位置 + 卷面原文 + 能照着念的问句」三段式 ----------
 * 起因：用户质询 T110「书页12三块词组：himself、this、all of the 三处的产出逻辑」——
 * 那三个词是**孩子手写上去的答案**、不在印刷题面里，家长对着卷子根本找不到，等于没发问。
 * 与 2026-10-10 的「措辞门禁」不是一回事：那次禁的是我自己的工具黑话（答案键/盲解…），
 * 词表能拦住；这次是"把问题写成了给自己看的速记"，词表拦不住，所以改查**形状**。
 * 只查 question（要念出口的那句）；detail 允许留卡号与坐标，那本来就是给我自己看的。 */
const ASK_SHAPE_BAD = [
  { re: /【\s*[EPCMYT]\d{3,}/, why: '开头拿错题卡号当定位（如【E0011】）——改成「第X页＋栏目名＋第几题」，卡号写进 detail' },
  { re: /【\s*[Pp]\s*\d+/, why: '「【p3漏判】」这类内部页码速记——改成「第3页」' },
  { re: /页-\d+-/, why: '「页-14-」是台账内部页码写法——改成「第14页」' },
  { re: /(?:词语|词|基|基础知识巩固)[一二三四五六七八九十]+\.\d/, why: '「词语一.3／基三.3」是卡内速记——写「第一大题第3小题」' },
  { re: /(^|[\s，。；、(（【])(?:[一二三四五六七八九十]{1,3})\.\d/, why: '「一.2／二.5」这类裸定位——写「第一大题第2小题」' },
  { re: /的(?:产出)?(?:逻辑|依据|思路|过程|情况|成因|判定|取舍|形成)\s*$/, why: '名词化收尾孩子听不懂——改成能照着念的问句' },
  { re: /是怎么形成的\s*$/, why: '"是怎么形成的"是写给我自己看的——直接问孩子当时怎么想' },
];
function shapeHits(it) {
  const q = String(it.question || '');
  const bad = [];
  for (const { re, why } of ASK_SHAPE_BAD) if (re.test(q)) bad.push(why);
  const asksPerson = it.askWho === '孩子' || it.askWho === '老师' || it.askWho === '原卷';
  if (!asksPerson) return bad;                       // 系统维护类不用念给谁听，只查速记
  if (!/[?？]/.test(q)) bad.push('没有问号——待办得是一句能问出口的话');
  if (it.askWho === '孩子' && !/[「“『]/.test(q)) bad.push('问孩子的要用「」把卷面上写的原文框出来，家长和孩子才对得上号');
  return bad;
}
function guardAskShape(where, it, force) {
  const bad = shapeHits(it);
  if (!bad.length) return;
  if (force) { console.error(`⚠ ${where} 问法不合式（${bad.length} 处），已按 --force 放行`); for (const b of bad) console.error('   · ' + b); return; }
  console.error(`❌ ${where} 的问法不合「三段式」（${bad.length} 处）——这条要给人照着念，不是我的速记：`);
  for (const b of bad) console.error('   · ' + b);
  console.error('   规范见本文件顶部「待办问法三段式」与 问法 动作；确需保留原文加 --force。');
  process.exit(2);
}

const ASK = ['孩子', '老师', '原卷', '系统'];
const ASK_ORDER = ['孩子', '老师', '原卷', '系统'];
const ASK_HINT = {
  孩子: '孩子本人能答（错因是「没想到」还是「懒得写」、笔迹是不是自己划的）',
  老师: '只能跟老师核对（漏判、扣分口径）',
  原卷: '拿原卷放大看就能定（卷面被覆盖/照片不清）',
  系统: '不是问人，是待我改的数据/工具问题',
};

const argv = process.argv.slice(2);
/* ★ 2026-11-04（M1·实测）：参数解析改走**唯一实现** `_参数.mjs`。
   原先这里是"下一个参数像不像 flag 决定它是不是值"的自抄解析器 ⇒
   `--payload --dry` 会把 `--dry` 解析成 **dry 开关** ⇒ 门禁开关被凭空打开/关掉。
   现在：已知带值 flag **无条件消费下一个参数**（哪怕它长得像 flag）。 */
const { action: _action, opt } = parseArgs(argv, {
  valueFlags: [
    ...COMMON_VALUE_FLAGS,
    // 本工具专属的带值 flag（**布尔开关不要列进来**）：
    //   auto/apply/dry/force/json/all-archived/allArchived 是开关 ——
    //   列进来会把后面的 flag 吃掉（`定位 --auto --dry` ⇒ --dry 被吞 ⇒ 只预览变成真写盘）。
  ],
  /* ★ 2026-11-05（PR #13 复审 ①）：写盘工具一律严格模式 —— 拼错的开关（如 --dryy）当场报错，绝不静默丢弃后真写盘。
     清单 = 本文件用到的布尔开关（机扫 opt.x / val('x') 后人工核对），新增开关必须同步加进来，否则会被拒。 */
  boolFlags: ['all-archived', 'allArchived', 'apply', 'auto', 'dry', 'force', 'json', 'help', 'h'],
});
/* 缺省动作 = 状态（与改前 `argv[0] || '状态'` 同口径）。 */
const action = _action || '状态';
const dstr = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const today = () => dstr(new Date());

/* 编号水位线（BUG-11）：`删` 会真的删行（只限未确认且无答案），若按 items 的 max+1 取号，
   删掉最大号后下一条会**撞回同一个编号**——台账引用（处置留痕、清单勾选）就对不上了。
   所以水位线存进文件（seq），且只增不减。 */
function maxIdOf(items) {
  let mx = 0;
  for (const it of (items || [])) { const m = /^T(\d+)$/.exec(it.id || ''); if (m) mx = Math.max(mx, Number(m[1])); }
  return mx;
}
function load() {
  if (!fs.existsSync(DB)) return { note: '待确认台账', items: [], seq: 0 };
  /* ⚠ 形状守卫必须是「响亮拒绝」而不是「当我以为是空的」：
     旧写法 `if (!Array.isArray(j.items)) j.items = [];` 碰上结构异常的真源（例如被
     PowerShell 的 ConvertFrom/To-Json 往返成 {value:[…]}）会把它当空表，随后任一次
     写操作就把 86 条人工判读留痕整份清空，还打印"已加/已答"的成功信息（BUG-02）。 */
  const j = readJsonStrict(DB, { shape: x => Array.isArray(x.items), what: 'items 数组', label: '_待确认.json' });
  j.seq = Math.max(Number(j.seq) || 0, maxIdOf(j.items));
  return j;
}
function save(o) { writeJsonAtomic(DB, o, { backup: true }); }
function nextId(doc) {
  const seq = Math.max(Number(doc.seq) || 0, maxIdOf(doc.items));
  doc.seq = seq + 1;
  return 'T' + String(doc.seq).padStart(3, '0');
}
const esc = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const open = it => it.status === '未确认';
const fmt = it => `${it.student}${it.subject && it.subject !== '（系统）' ? '/' + it.subject : ''} ${it.cardId}`;

/* ---------- 按编号取条目（2026-10-21 修：重号时不许取到已办结的那条） ----------
 * 事故（用户报障「待办办完之后还会弹出来，不能消失」）：2026-10-20 的拆条脚本
 *   `_probe/split-fix.mjs` 直接改 JSON、**复用了旧编号**，于是 T191/T192 在台账里各出现两次
 *   （旧条目「已作废」在前、拆出的新条目「未确认」在后）。
 *   而这里所有动作原本都写 `j.items.find(x => x.id === opt.id)` —— find 取**第一条**，
 *   取到的正是已作废的旧条目 ⇒ 「答」只把已作废那条再标一次，新条目永远停在未确认；
 *   「同步」更糟：报「已是『已作废』，跳过」并以退出码 0 收场，前端当成功，用户看到
 *   「已落库」但待办原地不动。这就是「办完不消失」的真因。
 * 现在：唯一取数入口。重号时**优先未确认那条**（那才是用户点着办结的那条）；
 *   两条都同态时取 raisedAt 较晚的（拆条产物的惯例）。重号本身由 `门禁` 的 `dupId` 点名阻断。
 * ⚠ 纪律：本文件内**禁止**再直接写 `items.find(x => x.id === ...)` —— 一律走 findById。 */
function findById(doc, id) {
  const all = (doc.items || []).filter(x => x.id === id);
  if (!all.length) return null;
  if (all.length === 1) return all[0];
  const live = all.filter(open);
  if (live.length) return live.sort((a, b) => String(b.raisedAt).localeCompare(String(a.raisedAt)))[0];
  return all.sort((a, b) => String(b.raisedAt).localeCompare(String(a.raisedAt)))[0];
}
/* 重号清单：同一编号出现 >1 次的那些编号（门禁点名 + 前端可据此显式报错） */
function dupIdsOf(doc) {
  const n = new Map();
  for (const it of (doc.items || [])) n.set(it.id, (n.get(it.id) || 0) + 1);
  return [...n.entries()].filter(([, c]) => c > 1).map(([id, c]) => ({ id, count: c }));
}

/* v2.1 题目定位：qRef = 人话题号（这条在问哪一题），box = 证据图上的高亮框（源图像素 x,y,w,h）。
   没有 box 也能用（只显示题号），有 box 则首页点开灯箱会自动放大并对准这一题。 */
function parseBox(v) {
  if (v == null || v === '' || v === true) return null;
  const p = String(v).split(/[,，\s]+/).filter(x => x !== '').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n))) return null;
  const [x, y, w, h] = p.map(n => Math.round(n));
  if (w <= 0 || h <= 0) return null;
  return [Math.max(0, x), Math.max(0, y), w, h];
}
const boxStr = b => (Array.isArray(b) && b.length === 4 ? b.join(',') : '');

/* v2.6（2026-10-16）待办级「原图（整页）」定位：origPage=这道题所在的原始整页（相对路径），
   origBox=整页上的归一化红框（0~1，台账口径，与 _原卷台账.json 的 box 同一坐标系）。
   起因：T097~T105 九条物理待办 cardId 为空（错题卡还没建，待办本身就是"先补录题干再建卡"），
   而 pending.js 灯箱此前只按 student|cardId 反查题卡接 M.origOf —— 无卡的待办永远回落成
   orig=证据裁图，⇄/🗂 开到的还是裁图（用户实测"裁图显示是横的，点原图发现还是这张图"）。
   修法：无卡待办也能在台账上直接登记整页，pending.js 按卡反查不通时回落到本字段。
   同日教训：这批物理原卷照片本身存成横的（内容横排、文件无 EXIF 方向标记），界面怎么改都是横的；
   原图资产必须以"正立可读"入库，回填定位必须转正后重算（_原卷台账.mjs 门禁已加"内容倒置"检查）。 */
function parseNormBox(v) {
  if (v == null || v === '' || v === true) return null;
  const p = String(v).split(/[,，\s]+/).filter(x => x !== '').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n))) return null;
  const [x, y, w, h] = p;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || w > 1 || h > 1) return null;
  return p.map(n => Math.round(n * 1e5) / 1e5);
}
const normBoxStr = b => (Array.isArray(b) && b.length === 4 ? b.join(',') : '');

/* v2.2 题号自动推导：cardId 形如「p42-10」「p42-12 · 选择」「p03-问题解决 · 8」，
   本身就带「页码 + 人话题号」，所以缺 qRef 时能机械还原成人话「第 10 题（p42）」。
   2026-10-08 起因：60 页批次用脚本批量 加 了 22 条、一条 --qref 都没传，首页 22/22 全红条。
   推导不出来的（如「（未入卡）」、纯汉字无题号）返回空串，交给人工，绝不瞎编题号。 */
function deriveQRef(cardId) {
  const m = /^(p\d+)-(.+)$/.exec(String(cardId == null ? '' : cardId).trim());
  if (!m) return '';
  const page = m[1];
  const seg = m[2].trim().split(/\s*·\s*/).map(x => x.trim()).filter(Boolean);
  const numPart = seg.find(x => /^\d+$/.test(x));
  if (numPart) {
    const label = seg.filter(x => x !== numPart).join('·');
    return label ? `第 ${numPart} 题（${page} · ${label}）` : `第 ${numPart} 题（${page}）`;
  }
  return '';   // 无数字题号（纯板块名）→ 不猜
}

/* 证据图路径一律存「正斜杠相对路径」。
   2026-10-07 实测：Windows 反斜杠写进来后，首页 pendLink() 按 '/' 切段做 URL 编码会整条当一个段，
   生成带 %5C 的 src → 浏览器 file:// 下 LOADFAIL（T047/T048 就是这么瞎的）。
   故写入与输出都做归一，堵在工具层，不指望调用方记得用哪个斜杠。 */
const normEv = v => String(v == null ? '' : v).trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
const sameFile = (a, b) => normEv(a) === normEv(b);

/* v2.5（2026-10-10）证据图路径护栏 —— 起因：T086 的证据图被写成通配符
   「九年级/物理/P0034-＊/原卷截图.jpg」（星号通配的卡目录）。文件永远不存在，桌面壳里只剩一张
   加载失败的破图，用户看到的就是「这个待办有问题，没有图形链接」。当时 normEv 只归一斜杠、
   不校验字符与存在性，而 `证据` 门禁又没挂进任何自检 → 静默漏到界面上
   （同类漏洞第三次：缺图 → 缺题号 → 图路径失效）。
   两条铁律：① 通配符不是路径，一律拒收（exists 检查对它必错）；
            ② 写入时当场查文件在不在，不在就喊出来，不指望调用方后手去跑门禁。 */
const GLOB_CH = /[*?\[\]]/;
/* 证据图相对路径 → 绝对路径。**唯一实现**在 `_区域坐标.mjs::evidenceAbs`（与服务端同一份），
   本行只是把库根绑上去：`证据`/`对位` 两条门禁、以及下面的 boxNorm 换算走的都是它。 */
const evAbs = ev => evidenceAbs(ev, ROOT);
const evOk = ev => { const s = normEv(ev); return !!s && !GLOB_CH.test(s) && fs.existsSync(evAbs(s)); };

/* ===== P2-2（2026-11-03）像素 box 的**读取侧**归一化：只加字段，不改数据 =====
   背景：`_待确认.json` 的 `box` 是源图像素，而 `_原卷台账.json` 是归一化 0~1 —— 两套并存、
   没有契约（实测代价：T187~T192 把 0~1 当像素用，灯箱红框缩成 1 像素点）。
   处置：**磁盘旧值一个字不改**（不迁移），读取时用 `_区域坐标.mjs` 量出显示宽高并附
   `boxNorm`(0~1) + `imgW` + `imgH`；量不出尺寸时只附 `boxNormWhy`（**具体原因**），
   **绝不写 0**（教训 L-530：缺失字段不许当值）。没有像素 box 的条目一个字段都不加（旧形状原样）。 */
function boxNormFields(it) {
  if (!it || !Array.isArray(it.box) || it.box.length !== 4) return null;
  const r = normEvidenceBox({ boxPx: it.box, imgAbs: it.evidence ? evAbs(it.evidence) : null });
  return r.ok
    ? { boxNorm: r.boxNorm, imgW: r.imgW, imgH: r.imgH }
    : { boxNormWhy: r.why };
}

/* ===== 待办条目 → 状态包输出形状（单一实现，2026-11-05）=====
   起因：用户报障「照你这样说，你设置这个待办有什么用？……问了问题也认真回答了，
   可是根本没人看，没人懂」。取证发现**已办结条目根本不在状态包的 `items` 里**
   （`门禁 --json` 只输出未确认条目）⇒ 前端「显示已办结」勾选框读同一个数组，勾上也是空的。
   用户的回话落了库，界面上却像从来没发生过 —— 这就是"没人看、没人懂"的直接成因。
   现在：未办结与已办结**共用这一个序列化函数**（形状一致，只是字段多寡不同），
   避免两处各写一份导致再次漂移（教训 L-306：同一判据只住一个家）。 */
function pendingItemOut(it) {
  return {
    id: it.id, student: it.student, subject: it.subject, cardId: it.cardId,
    kind: it.kind, askWho: it.askWho, question: it.question,
    detail: it.detail, source: it.source, raisedAt: it.raisedAt,
    status: it.status || '未确认',
    evidence: normEv(it.evidence || ''),
    /* false = 图上不了：缺图 / 通配符 / 文件不在。前端据此渲染显式红块并禁用「打开原图」。 */
    evidenceOk: evOk(it.evidence),
    qRef: it.qRef || '', box: Array.isArray(it.box) ? it.box : null,
    /* ★ 2026-11-03（批次 2 / P2-2）：读取侧附加的归一化坐标（唯一实现 `_区域坐标.mjs`）。
       有像素 box ⇒ `boxNorm/imgW/imgH`；量不出图 ⇒ 只 `boxNormWhy`（**不给 0**）；
       没有 box ⇒ 一个字段都不加（旧形状原样，前端旧路径不受影响）。磁盘旧值一字未改。 */
    ...(boxNormFields(it) || {}),
    /* v2.6：待办级整页定位（无卡待办的原图链路）。origPage 传**原始相对路径**（未编码），
       前端 H.asset 对未编码路径整段 encodeURI，与 evidence 同一通道；有卡条目此字段为空、照旧走 M.origOf。 */
    origPage: normEv(it.origPage || ''), origBox: Array.isArray(it.origBox) ? it.origBox : null,
    evidenceFix: it.evidenceFix || '', evidenceNote: it.evidenceNote || '',
    boxFix: it.boxFix || '', origFix: it.origFix || '',
  };
}

/* ===== v2.7（2026-10-19）证据图与待办「对位」基础设施 =====
   起因：用户质询「错题库中的待办，你提出的问题，与你给出的切图，完全不对应」。
   实测 39 条未确认里 25 条的题面页码与卡片页码不同 —— 证据图挂的是**错题卡自己的裁图**，
   而待办问的那道题根本不在那张卡上（卡问 A 题，待办问 B 题），点开图看到的是另一道题。
   三道静默失效：① 证据图≠所问之题（本族）；② box 字段被写成 0~1 归一化值却按像素用（T187~T192 实证，
   红框缩成左上角 1 像素点）；③ 页码三处口径不一（文件名 / 台账 source / 待办 qRef），无人比对。
   修法：页码只认 `_页码映射.json`（单一真源，2026-10-19 逐页核页脚建立），
   对位检查做成 `对位` 机器门禁，写入路径同样拦。 */
function imgSize(abs) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };   // PNG
    if (buf[0] === 0xFF && buf[1] === 0xD8) {                                                              // JPEG
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const mk = buf[i + 1];
        if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* 读不到就当未知，由调用方按未知处理 */ }
  return null;
}
let PAGE_MAP = null;
function pageMapDoc() {
  if (PAGE_MAP !== null) return PAGE_MAP;
  const f = path.join(ROOT, '_页码映射.json');
  PAGE_MAP = fs.existsSync(f) ? (readJsonStrict(f) || {}) : {};
  return PAGE_MAP;
}
/* 扫描件 → 印刷页码。查不到返回 null（未知，不瞎猜）。 */
function printedPageOfScan(rel) {
  const s = normEv(rel);
  if (!s) return null;
  const m = pageMapDoc();
  for (const g of ['en', 'chem']) {
    const t = m[g] || {};
    if (t[s] != null) return Number(t[s]);
  }
  return null;
}
/* 待办「问的是第几页」：qRef 优先（人话题号），其次 question 里的【...第N页】。 */
function claimPageOf(it) {
  for (const src of [it.qRef, it.question]) {
    const m = String(src || '').match(/第\s*(\d+)\s*页/);
    if (m) return Number(m[1]);
  }
  return null;
}
/* ===== v2.8（2026-10-20）待办「问几处」vs 证据图「覆盖几处」 =====
   起因：2026-10-20 逐条重裁时实测——T164 问句列了 5 处（单选2、单选3、词一6、基一3、基一4），
   裁图只覆盖了其中 2 处（单二2、单二3），页码对得上、图也不算废，但**漏了一半内容**。
   ⇒ 光比页码不够，还要比「问几处 / 覆盖几处」。
   判据：问句里枚举的小题数（①②③…、第X小题/题/空）> 1 时，
   证据图必须在裁图台账里登记覆盖处数 >= 问句处数，否则报「覆盖不全」。 */
function claimSpotCount(it) {
  /* 只数 question 里的枚举。detail 是给办事人看的补充说明，里面常有「如①…」「第4小题」等
     举例性文字，混进来会重复计数（2026-10-20 实测 T177 因 detail 里的①被算成 3 处）。 */
  const q = String(it.question || '');
  const circled = (q.match(/[①②③④⑤⑥⑦⑧⑨]/g) || []).length;
  const paren = (q.match(/[（(]\s*\d\s*[）)]/g) || []).length;
  const nth = (q.match(/第\s*\d+\s*(?:小题|题|空|处)/g) || []).length;
  return Math.max(circled, paren, nth);
}
/* 裁图台账：裁图人登记的「这张图来自哪张整页 / 覆盖几处」 */
function cropLogDoc() {
  const f = path.join(ROOT, '_工具', '_裁图台账.json');
  if (!fs.existsSync(f)) return {};
  return readJsonStrict(f) || {};
}
function cropCoverage(it) {
  const log = cropLogDoc();
  const e = log[it.id];
  if (!e) return null;
  const n = Number(e.spots || e.cover || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}
/* 证据图是什么类型：整页扫描 / 待办单题裁图 / 卡目录裁图。 */
function evidenceKind(rel) {
  const s = normEv(rel);
  if (!s) return 'none';
  if (printedPageOfScan(s) !== null) return 'pagescan';
  if (/\/待办证据\//.test(s)) return 'crop';
  if (/原卷截图/.test(s)) return 'cardstrip';
  return 'other';
}
const looksNormalized = b => Array.isArray(b) && b.length === 4 && b.every(n => Number.isFinite(n) && n >= 0 && n <= 1);
function boxProblem(b, size) {
  if (b == null) return null;
  if (!Array.isArray(b) || b.length !== 4 || b.some(n => !Number.isFinite(n))) return '红框不是 4 个数字';
  if (looksNormalized(b)) return '红框是 0~1 归一化值，却被按像素使用（灯箱里会缩成左上角一个点）';
  if (b[2] <= 0 || b[3] <= 0) return '红框宽或高 ≤ 0';
  if (size && (b[0] + b[2] > size.w + 2 || b[1] + b[3] > size.h + 2)) {
    return `红框超出图片范围（图 ${size.w}x${size.h}，框 ${b.join(',')}）`;
  }
  return null;
}
/* ===== v2.7（2026-10-19）证据图「对位」审计 =====
   起因（用户原话）：「错题库中的待办，你提出的问题，与你给出的切图，完全不对应，请全面梳理一下」。
   实测 39 条未确认：25 条「待办问的题」与「错题卡是哪道题」根本不在同一页，
   而证据图挂的正是错题卡自己的裁图 ⇒ 点开图看到的是另一道题。另 6 条把 0~1 归一化红框
   写进了像素字段，灯箱红框缩成左上角 1 像素点。
   三处口径互不校验（文件名页码 / 台账 source 页码 / 待办 qRef 页码）是病根，
   故本审计用 `_页码映射.json` 作单一真源逐条比对，并把 box 语义（像素 vs 归一化）也查出来。
   单一实现：`对位` 动作与 `门禁 --json` 都走这里，禁止两处各写一份。 */
function alignAudit(j) {
  const pend = j.items.filter(open);
  const rows = [];
  for (const it of pend) {
    const claim = claimPageOf(it);
    const kind = evidenceKind(it.evidence);
    const evPage = printedPageOfScan(it.evidence);
    const origPage = it.origPage ? printedPageOfScan(it.origPage) : null;
    const evAbsPath = it.evidence ? evAbs(it.evidence) : null;
    const size = evAbsPath && fs.existsSync(evAbsPath) ? imgSize(evAbsPath) : null;
    const boxBad = boxProblem(it.box, size);
    const origBoxBad = it.origBox != null && !looksNormalized(it.origBox) ? '整页红框 origBox 应是 0~1 归一化值' : null;
    const problems = [];
    if (!it.evidence) problems.push('缺证据图');
    else if (!evOk(it.evidence)) problems.push('证据图文件不在');
    if (boxBad) problems.push(boxBad);
    if (origBoxBad) problems.push(origBoxBad);
    /* 系统维护类（问的是"工具/流程缺陷"，不是某道题）没有页码是正常的，
       不能因为"问句里没写第N页"就报对位错——那会把真问题淹没在噪声里。 */
    const noPageExpected = it.askWho === '系统' || it.kind === '系统维护';
    if (claim === null && !noPageExpected) problems.push('问句里没有「第N页」，无法对位');
    /* 对位主判据：证据图（或它的整页溯源 origPage）必须落在问句说的那一页 */
    let evPrinted = evPage;
    if (kind === 'crop') evPrinted = origPage;                     // 单题裁图：看它的整页溯源
    if (kind === 'cardstrip') evPrinted = origPage;                // 卡裁图：同样看整页溯源
    if (claim !== null && kind !== 'none') {
      if (evPrinted === null) {
        problems.push(kind === 'crop' || kind === 'cardstrip'
          ? '缺 origPage（整页溯源），无法证明这张图就是第' + claim + '页那道题'
          : '证据图不是已登记的整页扫描件，无法对位');
      } else if (evPrinted !== claim) {
        problems.push('对位错：待办问第' + claim + '页，图却是第' + evPrinted + '页的');
      }
    }
    /* v2.8 覆盖完备性：问 N 处，图必须覆盖 N 处（页码对但漏了一半也算错） */
    const wantSpots = claimSpotCount(it);
    const gotSpots = cropCoverage(it);
    if (wantSpots > 1) {
      if (gotSpots === null) {
        problems.push(`问句列了 ${wantSpots} 处，但裁图台账没登记覆盖处数，无法证明没漏`);
      } else if (gotSpots < wantSpots) {
        problems.push(`覆盖不全：问句列了 ${wantSpots} 处，证据图只覆盖 ${gotSpots} 处`);
      }
    }
    rows.push({ id: it.id, who: it.askWho, kind: it.kind, card: it.cardId, claim, evKind: kind, evPrinted, evidence: it.evidence, boxBad, problems });
  }
  return { open: pend.length, rows, bad: rows.filter(r => r.problems.length) };
}
function guardEvidence(ev, where) {
  const s = normEv(ev);
  if (!s) return s;
  const bad = GLOB_CH.exec(s);
  if (bad) {
    console.error(`✖ 证据图路径含通配符「${bad[0]}」，这不是一个真实路径：${s}`);
    console.error('  通配符永远加载失败（用户看到破图 + 点不动的「打开原图」）。请给卡目录全名，例如：');
    console.error('  node _待确认.mjs 定位 --id Txxx --evidence "<小名>/物理/P0034-力臂漏作垂线段/原卷截图.jpg"');
    process.exit(2);
  }
  if (!fs.existsSync(evAbs(s))) {
    console.error(`✖ ${where}：证据图文件不存在 → ${s}`);
    console.error(`   （查的是 ${evAbs(s)}；待办指向不存在的文件＝界面上一个破图）`);
    console.error(`   查真实卡目录：dir "${path.join(ROOT, '<小名>', '<学科>', '<卡号>-*')}"`);
    if (where === '定位') process.exit(2);   // 定位 = 修图路径，必须指到真实文件
  }
  return s;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 候选修订 + 修订链（2026-11-03 · 批次 4 §1「审核与正式入库」）
 *
 * 是什么：`_待确认.json` 的条目上多两个**只增不改**的数组 ——
 *   · `candidates[]`：人对某张卡 / 某个配方 / 某条流程的**修订草案**（还没进库）
 *   · `revisions[]` ：**正式写入**的留痕（append-only，只由 `采用` 写）
 *
 * 为什么这么设计（都是踩过坑才这么定的，别随手改）：
 *   ① 「草案」与「正式写入」必须分开：草案可以随口提、随手改；一旦进库就是用户数据，
 *      要能被算法追认为"谁在什么时候把哪段正文写进了哪个路径"。两者挤在一个字段里
 *      就没法回答"这条到底生效了没有"。
 *   ② 稳定 ID 由**内容**决定（`c-<sha256(kind|target|payloadDigest) 前12位>`）：
 *      双击/重试/换入口（页面 vs 命令行）提交同一份草案 ⇒ 同一条候选，
 *      不靠"调用方记得先去查重"。这正是批次 4「幂等入库」的判据（不按时间、不按序号）。
 *   ③ **不直接改写卡正文 / 配方 / 流程文件**：那一步不可逆，而卡正文常是家长自己写的。
 *      本批的验收重点是"幂等 + 可追溯 + 故障后状态一致"，落点是**新增**的修订对象
 *      `<库根>\_修订\<kind>\<目标>\<candId>.md`（只增不改）。"把修订记录应用回卡正文"
 *      留作后续单独设计（批次 4 报告会写进未结案）。
 *   ④ 形状读不懂一律**响亮拒绝**（exit 2）且台账一字不动 —— BUG-02 那一族：
 *      "读不懂就当空表、随后覆盖"会永久丢掉人工修订链，不可再生。
 * ══════════════════════════════════════════════════════════════════════════ */
const CAND_KINDS = ['卡', '配方', '流程'];
const CAND_ID_RE = /^c-[0-9a-f]{12}$/;
const REV_DIR = '_修订';
const sha256hex = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
/* 正文与摘要一律先做**行尾归一**（CRLF→LF、剥 BOM）再算 sha256：
   同一份正文从页面（\n）与从 Windows 文件（\r\n）进来必须得到同一个 candId，
   否则"双击/换入口不重复"这条就成了看运气（本仓 L-529 族）。 */
const lfText = s => String(s == null ? '' : s).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
function candIdOf(kind, target, payloadDigest) {
  return 'c-' + sha256hex(kind + '|' + target + '|' + payloadDigest).slice(0, 12);
}
/* 落点目录名：目标标识里的人话字符留着，路径分隔符/保留字符换成 `_`（防 `..` 逃逸与非法名） */
const slugOf = t => String(t == null ? '' : t).trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+$/, '_').slice(0, 80) || '_';
function nowIsoLocal() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${dstr(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}
/* 两个正文入口，**互斥**（2026-11-03 Lead 契约小修订）：不许"看着像路径就当文件读"——
   正文本身就可能长得像路径。都不给、都给、或给空 ⇒ exit 2 且原因具体。 */
function payloadOf(opt) {
  const hasStr = opt.payload !== undefined;
  const hasFile = opt['payload-file'] !== undefined;
  if (hasStr && hasFile) { console.error('✖ --payload 与 --payload-file 互斥：正文要么直接给（--payload），要么从文件读（--payload-file）'); process.exit(2); }
  if (!hasStr && !hasFile) { console.error('缺参数：--payload "<正文>" 或 --payload-file <文件> 必填（候选修订正文）'); process.exit(2); }
  let s;
  if (hasFile) {
    if (opt['payload-file'] === true || !String(opt['payload-file']).trim()) { console.error('✖ --payload-file 后面要给文件路径'); process.exit(2); }
    const f = String(opt['payload-file']);
    let st = null; try { st = fs.statSync(f); } catch { st = null; }
    if (!st || !st.isFile()) { console.error(`✖ --payload-file 指向的不是一个文件：${f}（不存在 / 是目录）`); process.exit(2); }
    s = fs.readFileSync(f, 'utf8');
  } else {
    if (opt.payload === true) { console.error('✖ --payload 后面要给正文；若正文确实为空，本工具拒收（空草案没有任何意义）'); process.exit(2); }
    s = String(opt.payload);
  }
  if (!lfText(s).trim()) { console.error('✖ 候选正文是空的（只有空白字符）——修订草案必须有内容'); process.exit(2); }
  return s;
}
/* 形状守卫：`candidates`/`revisions` 读不懂 ⇒ exit 2 且**台账一字不动**（调用方保证不写盘） */
function guardCandShapes(it) {
  for (const [f, what] of [['candidates', '候选'], ['revisions', '修订链']]) {
    const v = it[f];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      console.error(`✖ ${it.id} 的 ${f} 不是数组（实际 ${v === null ? 'null' : typeof v}）——拒绝继续。`);
      console.error(`   它可能是被 PowerShell 的 ConvertFrom/To-Json 往返成了 {value:[…]}，先手工改回数组；`);
      console.error(`   本工具绝不把读不懂的${what}「当成空表」再覆盖（那会永久丢掉已采纳的人工修订链）。`);
      process.exit(2);
    }
  }
}
const candsOf = it => (Array.isArray(it.candidates) ? it.candidates : []);
const revsOf = it => (Array.isArray(it.revisions) ? it.revisions : []);
/* 候选记录形状（写的一刻就定型；读侧只信这个形状） */
const candSummaryOf = payload => {
  const line = lfText(payload).split('\n').map(x => x.trim()).find(x => x) || '';
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
};
/* ---------- 现值：用户要对照的是「现在库里的东西长什么样」 ----------
 * （2026-11-03 Lead 裁定：不许把"现值"定义成"最近一条已采用修订的正文"——那对用户没用，
 *   也让"采用前 vs 采用后"的对照失去意义。）
 * presence 二值：'read' 有值 / 'missing' 定位不到（**必须带 why**，绝不静默给空串 —— L-530）。 */
function locateCardDir(cardId) {
  const hits = [];
  const push = p => { const k = path.resolve(p).toLowerCase(); if (!hits.some(h => h.key === k)) hits.push({ key: k, abs: p }); };
  let lv1 = [];
  try { lv1 = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && !/^[_.]/.test(e.name)).map(e => e.name); } catch { return { hits: [] }; }
  const idxItems = dir => {
    const idx = path.join(dir, '_索引.json');
    if (!fs.existsSync(idx)) return [];
    try { return (readJsonStrict(idx).items || []); } catch { return []; }
  };
  for (const g of lv1) {
    const gAbs = path.join(ROOT, g);
    let lv2 = [];
    try { lv2 = fs.readdirSync(gAbs, { withFileTypes: true }).filter(e => e.isDirectory() && !/^[_.]/.test(e.name)).map(e => e.name); } catch { }
    for (const dirAbs of [gAbs, ...lv2.map(s => path.join(gAbs, s))]) {
      /* ① 索引是**精确**判据：items[].id + items[].dir */
      for (const it of idxItems(dirAbs)) if (it && it.id === cardId && it.dir) push(path.join(dirAbs, String(it.dir)));
      /* ② 目录名兜底（索引缺项 / 手建的卡目录）：<卡号>-<slug> 或 <卡号> */
      let ents = [];
      try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { }
      for (const e of ents) if (e.isDirectory() && (e.name === cardId || e.name.startsWith(cardId + '-'))) push(path.join(dirAbs, e.name));
    }
  }
  return { hits };
}
function currentOf(kind, target) {
  if (kind === '卡') {
    const { hits } = locateCardDir(target);
    if (!hits.length) {
      return { presence: 'missing', value: null, why: `定位不到卡目录：库根下没有 id=${target} 的卡（查过各年级/学科的 _索引.json 与 <卡号>-* 目录名）`, from: '' };
    }
    if (hits.length > 1) {
      return { presence: 'missing', value: null, why: `卡号 ${target} 在库里命中 ${hits.length} 个目录（${hits.map(h => path.relative(ROOT, h.abs).replace(/\\/g, '/')).join(' ｜ ')}），不敢替你挑一个`, from: '' };
    }
    const relDir = path.relative(ROOT, hits[0].abs).replace(/\\/g, '/');
    const f = path.join(hits[0].abs, '错题记录.md');
    if (!fs.existsSync(f)) return { presence: 'missing', value: null, why: `卡目录 ${relDir} 里没有 错题记录.md —— 没有可对照的现值`, from: relDir };
    return { presence: 'read', value: fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''), why: '', from: relDir + '/错题记录.md' };
  }
  if (kind === '配方') {
    /* 与 `_配方.mjs::recipesRoot()` 同一个根（都取 `_库根.mjs` 的 APP_ROOT）；这里**只读**，
       读不到就报原因，不像那边抛错（现值缺失不该让整条命令崩）。 */
    const root = path.join(APP_ROOT, 'recipes');
    if (!fs.existsSync(root)) return { presence: 'missing', value: null, why: `程序目录里没有 recipes 目录（${root}）——配方随程序包发布，查不到就问不了现值`, from: '' };
    const dir = path.join(root, String(target));
    if (!fs.existsSync(dir)) return { presence: 'missing', value: null, why: `配方 ${target} 不在程序包里（${path.relative(APP_ROOT, dir).replace(/\\/g, '/')}）`, from: '' };
    const f = path.join(dir, 'prompt.md');
    if (!fs.existsSync(f)) return { presence: 'missing', value: null, why: `配方 ${target} 里没有 prompt.md`, from: `recipes/${target}` };
    return { presence: 'read', value: fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''), why: '', from: `recipes/${target}/prompt.md` };
  }
  return { presence: 'missing', value: null, why: '流程类目标没有机器可读的现值（人工按修订记录执行）', from: '' };
}
/* ---------- 修订包（可选的结构化正文）与三类错误 ----------
 * 正文是 JSON 对象时，`采用` 先校验**坐标**与**页引用**（越界坐标 / 缺页各自给具体数值）；
 * 正文是纯文本（补丁 / 整段替换）时没有机器可读的坐标与页，跳过校验并**明说**（不许静默通过）。
 * 形状真源见 docs\录题任务契约.md「候选与修订链」。 */
function tryPack(payload) {
  const t = lfText(payload).trim();
  if (!t.startsWith('{')) return { isJson: false };
  try {
    const o = JSON.parse(t);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { isJson: false };
    return { isJson: true, obj: o };
  } catch { return { isJson: false, broken: true }; }
}
function packProblems(o) {
  const bad = [];
  const normBoxOk = (b, label) => {
    const [x, y, w, h] = b;
    if (w <= 0 || h <= 0) { bad.push(`越界坐标：${label} 的宽或高 ≤ 0（${b.join(',')}）——0~1 归一化框的宽高必须 > 0`); return; }
    if (x < 0 || y < 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) {
      bad.push(`越界坐标：${label} 超出 0~1（x=${x} y=${y} x+w=${Number((x + w).toFixed(6))} y+h=${Number((y + h).toFixed(6))}）`);
    }
  };
  if (o.regions !== undefined) {
    if (!Array.isArray(o.regions)) bad.push('越界坐标：regions 不是数组');
    else o.regions.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) { bad.push(`越界坐标：regions[${i}] 不是对象`); return; }
      const b = [r.x, r.y, r.w, r.h];
      if (!b.every(n => Number.isFinite(n))) { bad.push(`越界坐标：regions[${i}] 的 x/y/w/h 不是 4 个数字（${JSON.stringify(b)}）`); return; }
      normBoxOk(b, `regions[${i}]${r.role ? '（' + r.role + '）' : ''}`);
    });
  }
  if (o.origBox !== undefined) {
    if (!Array.isArray(o.origBox) || o.origBox.length !== 4 || !o.origBox.every(n => Number.isFinite(n))) bad.push(`越界坐标：origBox 不是 4 个数字（${JSON.stringify(o.origBox)}）`);
    else normBoxOk(o.origBox, 'origBox');
  }
  if (o.box !== undefined) {
    if (!Array.isArray(o.box) || o.box.length !== 4 || !o.box.every(n => Number.isFinite(n))) bad.push(`越界坐标：box 不是 4 个数字（${JSON.stringify(o.box)}）`);
    else {
      const [x, y, w, h] = o.box, W = Number(o.imgW), H = Number(o.imgH);
      if (!(W > 0) || !(H > 0)) bad.push(`越界坐标：像素 box 必须同时给 imgW/imgH（收到 imgW=${JSON.stringify(o.imgW)} imgH=${JSON.stringify(o.imgH)}）——没有图尺寸就判不了越界，本工具不猜`);
      else if (w <= 0 || h <= 0) bad.push(`越界坐标：box 的宽或高 ≤ 0（${o.box.join(',')}）`);
      else if (x < 0 || y < 0 || x + w > W || y + h > H) bad.push(`越界坐标：像素框 ${o.box.join(',')} 超出图 ${W}x${H}（右边界 ${x + w}、下边界 ${y + h}）`);
    }
  }
  if (o.page !== undefined) {
    const n = Number(o.page);
    if (!Number.isInteger(n) || n < 1) bad.push(`缺页：page 不是正整数（收到 ${JSON.stringify(o.page)}）`);
  }
  if (o.origPage !== undefined) {
    const rel = normEv(o.origPage);
    if (!rel || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) {
      bad.push(`缺页：origPage 必须是库内相对路径（收到 ${JSON.stringify(o.origPage)}）`);
    } else if (!fs.existsSync(path.join(ROOT, '_页码映射.json'))) {
      bad.push('缺页：库根没有 _页码映射.json（扫描件→印刷页码的单一真源），无法核对 origPage 是哪一页');
    } else if (!fs.existsSync(path.join(ROOT, ...rel.split('/')))) {
      bad.push(`缺页：origPage 指向的文件不在库里 → ${rel}`);
    } else {
      const printed = printedPageOfScan(rel);
      if (printed === null) bad.push(`缺页：${rel} 在 _页码映射.json 里没有登记（无法证明它是第几页）`);
      else if (o.page !== undefined && Number(o.page) !== printed) bad.push(`缺页：origPage 是第 ${printed} 页，但正文里写的 page=${o.page} —— 页号对不上`);
    }
  }
  if (o.pageSha !== undefined) {
    const s = String(o.pageSha).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(s)) bad.push(`缺页：pageSha 不是 64 位小写 hex（收到 ${JSON.stringify(o.pageSha)}）`);
    else {
      const d = path.join(ROOT, '_原图', s.slice(0, 2));
      let hit = false;
      try { hit = fs.existsSync(d) && fs.readdirSync(d).some(n => n.toLowerCase().startsWith(s + '.')); } catch { hit = false; }
      if (!hit) bad.push(`缺页：原图对象 ${s.slice(0, 12)}… 不在 _原图\\${s.slice(0, 2)}\\ 下`);
    }
  }
  return [...new Set(bad)];
}
/* 修订对象正文：**只是候选的纯函数**（不含采纳时刻）——这样"落点已存在且内容一致"才能
   当成幂等跳过（半截失败后重跑不会因为时间戳不同而被判成"人工改过"）。
   采纳时刻住在 `_待确认.json` 的 revisions[] 里。 */
function revisionFileBody(it, cand) {
  const head = [
    `# 人工修订 ${cand.candId}`,
    '',
    `- 待办：${it.id}`,
    `- 类型：${cand.kind}`,
    `- 目标：${cand.target}`,
    `- 提出日：${cand.at || ''}`,
    `- 正文摘要（sha256，按 LF 归一）：${cand.payloadDigest}`,
    `- 写入方式：\`node _待确认.mjs 采用 --id ${it.id} --candidate ${cand.candId}\``,
    '- 本文本由工具写入，**只增不改**；采纳时点与写入清单见 `_待确认.json` 的 `revisions[]`。',
    '',
    '---',
    '',
  ].join('\n');
  return head + lfText(cand.payload).replace(/\n+$/, '') + '\n';
}
const revisionRelOf = (kind, target, candId) => [REV_DIR, slugOf(kind), slugOf(target), candId + '.md'].join('/');

/* ---------------- 渲染清单 ---------------- */
function render() {
  const j = load();
  const items = j.items;
  const pend = items.filter(open);
  const done = items.filter(it => !open(it));
  const cnt = k => pend.filter(it => it.askWho === k).length;
  const L = [];

  L.push('# 错题本 · 待确认清单');
  L.push('');
  L.push('> **真源**：`_待确认.json`；本页由 `node _待确认.mjs 清单` 渲染，**勿手改本页**（改了下次刷新就没了）。');
  L.push('> **用途**：把所有「需要孩子/老师回答、或需要回原卷看」的悬空问题集中一处，不用再翻十几张卡。');
  L.push('> **加一条**：`node _待确认.mjs 加 --student 学生A --subject 化学 --card C0003 --kind 笔迹归属 --ask 孩子 --q "问题" [--detail "证据"]`');
  L.push('> **答一条**：`node _待确认.mjs 答 --id T003 --answer "孩子答：..."`');
  L.push('> **自检**：`node _待确认.mjs 门禁`（有未确认项 → 退出码 1）｜ `措辞`（给人看的文本含内部黑话 → 退出码 1）');
  L.push('> **规矩**：每录完一份卷/每张卡，凡拿不准、看不清、疑似漏判的，**当场**加进台账；不许只在脑子里记。');
  L.push('> **人话对照**（问题与说明两列已按此改写；「结论／判定／处置」三列是当时的原话与留痕，不改写，遇到生僻词按此表读）：');
  L.push('> 　**标准答案**＝这份卷子印的正确答案（旧写作"答案键"）｜ **原先记在卡上的答案**＝我早先录进去的答案（旧写作"录入答案"）');
  L.push('> 　**不看答案独立做一遍**＝旧写作"盲解"｜ **两遍独立重做**＝旧写作"双路"｜ **独立看图**＝旧写作"图形层"｜ **放大原卷逐点看**＝旧写作"像素级判读"');
  L.push('> 　**批改**＝旧写作"判卷"｜ **排进练习卷**＝旧写作"组卷"｜ **去掉答案的题面**＝旧写作"清稿"｜ **遮住答案的副本**＝旧写作"掩膜"｜ **我**＝旧写作"Lead"（就是我本人）');
  L.push('');
  L.push(`## 待确认（共 ${pend.length} 条：问孩子 ${cnt('孩子')} ｜ 问老师 ${cnt('老师')} ｜ 回原卷 ${cnt('原卷')} ｜ 系统待办 ${cnt('系统')}）`);
  L.push('');
  L.push(`_更新于 ${today()}_`);
  L.push('');

  for (const who of ASK_ORDER) {
    const g = pend.filter(it => it.askWho === who);
    if (!g.length) continue;
    L.push(`### 问${who === '系统' ? '系统（待我改）' : who}（${g.length} 条）`);
    L.push('');
    L.push(`> ${ASK_HINT[who] || ''}`);
    L.push('');
    L.push('| ☐ | 编号 | 学生/学科 | 卡号 | 类型 | **问的是哪一题** | 证据图 | 要确认的问题 | 证据 / 影响 | 来源 | 提出 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const it of g) {
      const evCell = it.evidence ? '🖼 ' + esc(it.evidence) : '⚠️ **缺图**';
      L.push(`| ☐ | **${it.id}** | ${esc(it.student)}${it.subject && it.subject !== '（系统）' ? '/' + esc(it.subject) : ''} | ${esc(it.cardId)} | ${esc(it.kind)} | ${it.qRef ? '📍' + esc(it.qRef) : '⚠️ 未登记'} | ${evCell} | ${esc(it.question)} | ${esc(it.detail)} | ${esc(it.source)} | ${esc(it.raisedAt)} |`);
    }
    L.push('');
  }
  if (!pend.length) { L.push('（当前没有待确认项 ✅）'); L.push(''); }

  if (done.length) {
    L.push(`## 已确认 / 已作废（${done.length} 条，留痕备查）`);
    L.push('');
    L.push('| 编号 | 学生/学科 | 卡号 | 类型 | 问题 | 结论 | 处理日 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const it of done) {
      L.push(`| ${it.id} | ${esc(it.student)}${it.subject && it.subject !== '（系统）' ? '/' + esc(it.subject) : ''} | ${esc(it.cardId)} | ${esc(it.kind)} | ${esc(it.question)} | ${esc(it.answer)}${it.status === '已作废' ? ' _(已作废)_' : ''} | ${esc(it.resolvedAt)} |`);
    }
    L.push('');
  }

  const byKind = {};
  for (const it of pend) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  L.push('---');
  L.push('');
  L.push('### 待确认项的分布（未确认）');
  L.push('');
  for (const k of KINDS) if (byKind[k]) L.push(`- ${k}：${byKind[k]} 条`);
  L.push('');
  L.push('### 怎么处置（按类型）');
  L.push('');
  L.push('| 类型 | 谁答 | 拿到答案后做什么 |');
  L.push('|---|---|---|');
  L.push('| 笔迹归属 | 孩子 | 改该卡 `studentAnswer` 的措辞（去掉「归属存疑」），必要时重判这题是否算错 |');
  L.push('| 错因口述 | 孩子 | 改 `causeDesc` 并置 `causeConfirmed=true`；错因层(K/L/S)可能跟着改 |');
  L.push('| 老师漏判 | 老师 | 记进该卡 `错题记录.md` 的「老师批改」段；分数口径同步到方案文档账目 |');
  L.push('| 卷面辨认 | 原卷 | 放大原卷定稿后补/改该卡；该入卡的补入卡。**判字前先查笔形库**：`node _笔形.mjs 提示 --student <学生>`；定案后回填 `_笔形.mjs 加`（含反例） |');
  L.push('| 口径确认 | 老师 | 只改 `answer` 的注与判罚说明，不改变孩子是否算错 |');
  L.push('| 系统维护 | 我 | 直接改索引字段 / 重裁图；改完 `node _生成队列.mjs` + `_生成首页.ps1` |');
  L.push('');

  writeTextAtomic(MD, L.join('\n').replace(/\n+$/, '\n'));
  console.log(`_待确认清单.md 已刷新：${L.join('\n').length} 字符 ｜ 待确认 ${pend.length} 条（孩子 ${cnt('孩子')} / 老师 ${cnt('老师')} / 原卷 ${cnt('原卷')} / 系统 ${cnt('系统')}）`);
}

/* ---------------- 动作分发 ---------------- */
if (action === '清单') {
  render();
} else if (action === '加') {
  const j = load();
  if (!opt.student || !opt.q) { console.error('缺参数：--student 与 --q 必填'); process.exit(2); }
  if (opt.kind && !KINDS.includes(opt.kind)) { console.error('kind 必须是：' + KINDS.join(' / ')); process.exit(2); }
  if (opt.ask && !ASK.includes(opt.ask)) { console.error('ask 必须是：' + ASK.join(' / ')); process.exit(2); }
  guardJargon('加 --q', opt.q, opt.force);
  if (opt.detail) guardJargon('加 --detail', opt.detail, opt.force);
  if (opt.qref) guardJargon('加 --qref', opt.qref, opt.force);
  guardAskShape('加 --q', { question: opt.q, askWho: opt.ask || '孩子' }, opt.force);
  const dup = j.items.find(it => open(it) && it.student === opt.student && it.cardId === (opt.card || '') && it.question === opt.q);
  if (dup) { console.error(`已存在同题待确认项 ${dup.id}，未重复添加`); process.exit(2); }
  const it = {
    id: nextId(j),
    student: opt.student,
    subject: opt.subject || '',
    cardId: opt.card || '（未入卡）',
    source: opt.source || '',
    qRef: opt.qref || '',
    box: parseBox(opt.box),
    kind: opt.kind || '其他',
    askWho: opt.ask || '孩子',
    question: opt.q,
    detail: opt.detail || '',
    raisedAt: opt.date || today(),
    status: '未确认',
    answer: '',
    resolvedAt: '',
    evidence: opt.evidence ? guardEvidence(opt.evidence, '加') : '',
  };
  // v2.2：没传 --qref 就从 cardId 机械推导（cardId 本身就含「页码+题号」），推导结果**明写出来**、不静默。
  // 2026-10-08 教训：批量脚本 加 了 22 条一条 --qref 都没传，首页 22/22 全红条——堵在工具层，不指望调用方记得。
  const autoQ = it.qRef ? '' : deriveQRef(it.cardId);
  if (autoQ) it.qRef = autoQ;
  j.items.push(it);
  save(j);
  console.log(`已加 ${it.id}：[${it.askWho}/${it.kind}] ${it.student} ${it.cardId} — ${it.question}`);
  if (autoQ) console.log(`   📍 题号按卡号自动推导为「${autoQ}」；与卷面不符就覆盖：node _待确认.mjs 定位 --id ${it.id} --qref "第N题"`);
  if (!it.qRef) {
    // 与「缺图」同级处理：不阻断批量录入，但必须把缺题号喊到脸上（首页这条会挂红条）。
    console.error('');
    console.error('⚠️  ⚠️  ⚠️  新条目没登记「问的是哪一题」（qRef）—— 首页这条会挂红条，看的人得自己在整页原卷里找题！');
    console.error('     立刻补：node _待确认.mjs 定位 --id ' + it.id + ' --qref "第N题（pNN）" [--box "x,y,w,h"]');
    console.error('     查全库缺口：node _待确认.mjs 定位');
    console.error('');
  }
  if (!it.evidence) {
    // 2026-10-07：待办没图 = 首页一块空白（用户质询「原来待办都是带图的，现在怎么没图了？」）。
    // 这里不阻断（批量录入脚本可能一次加多条、随后统一补图），但必须把缺图喊到脸上。
    console.error('');
    console.error('⚠️  ⚠️  ⚠️  新条目没有证据图 —— 首页待办工作台这条会是空白，看的人不知道在问什么！');
    console.error('     立刻补：node _待确认.mjs 定位 --id ' + it.id + ' --evidence "<小名>/<学科>/<卡号-描述>/原卷截图.jpg" --box "x,y,w,h"');
    console.error('     查全库缺口：node _待确认.mjs 证据');
    console.error('');
  }
  render();
} else if (action === '定位') {
  // v2.1：给一条待确认项登记「问的是哪一题」（qRef）与证据图上的高亮框（box，源图像素）。
  // 不带 --id 时列出全部未确认项 + 定位覆盖率，用来盯「还有哪几条说不清在问哪题」。
  const j = load();
  if (opt.auto) {
    // v2.2 批量补题号：对缺 qRef 的未确认项，按 cardId 机械推导（--force 连已登记的一起重算）。
    // 只补「推导得出」的；推不出的原样留着并点名，绝不编题号。--dry 只预览不写盘。
    const pend = j.items.filter(open);
    const cand = pend.filter(it => (opt.force ? true : !it.qRef) && deriveQRef(it.cardId));
    const changed = [];
    for (const it of cand) {
      const q = deriveQRef(it.cardId);
      if (it.qRef === q) continue;
      changed.push(`${it.id}  ${it.qRef ? it.qRef + '  →  ' : '（未登记）  →  '}${q}`);
      it.qRef = q;
    }
    const still = j.items.filter(it => open(it) && !it.qRef);
    console.log(`自动推导题号：候选 ${cand.length} 条，实际改写 ${changed.length} 条${opt.dry ? '（--dry 预览，未写盘）' : ''}`);
    changed.forEach(s => console.log('   ' + s));
    if (still.length) {
      console.log(`── 仍需人工登记（${still.length} 条，cardId 里没有可推导的题号）：`);
      for (const it of still) console.log(`   ${it.id}  ${fmt(it)}  cardId=「${it.cardId}」  ${it.question.slice(0, 60)}`);
    }
    if (!opt.dry && changed.length) { save(j); render(); console.log('已写盘，_待确认清单.md 已刷新。'); }
    if (!opt.dry && !changed.length) console.log('（无变化，未写盘）');
    process.exit(still.length && !opt.dry ? 1 : 0);
  }
  if (!opt.id) {
    const pend = j.items.filter(open);
    const miss = pend.filter(it => !it.qRef);
    const nobox = pend.filter(it => it.qRef && !it.box);
    const noev = pend.filter(it => !it.evidence);
    console.log(`定位覆盖：未确认 ${pend.length} 条 ｜ 已登记题号 ${pend.length - miss.length} 条（其中带高亮框 ${pend.length - miss.length - nobox.length} 条）`);
    console.log(`证据图覆盖：未确认 ${pend.length} 条 ｜ 有图 ${pend.length - noev.length} 条 ｜ 缺图 ${noev.length} 条`);
    if (miss.length) console.log(`\n── 缺题号（${miss.length}）：` + miss.map(it => `${it.id}(${it.cardId})`).join(', '));
    if (nobox.length) console.log(`── 有题号缺框（${nobox.length}）：` + nobox.map(it => `${it.id}(${it.cardId})`).join(', '));
    if (noev.length) console.log(`── 缺证据图（${noev.length}）：` + noev.map(it => `${it.id}(${it.cardId})`).join(', ') + '  ← 首页这些条会是空白，必须补 --evidence');
    for (const it of pend) console.log(`   ${it.id}  ${fmt(it)}  ${it.qRef ? '📍' + it.qRef : '⚠ 未登记题号'}${it.box ? '  ▣' + boxStr(it.box) : ''}  [${it.evidence || '无证据图'}]`);
  } else {
    const it = findById(j, opt.id);
    if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
    if (opt.qref === undefined && opt.box === undefined && opt.evidence === undefined && opt.evidnote === undefined && opt.card === undefined
      && opt.origpage === undefined && opt.origbox === undefined) {
      console.error('至少要给 --qref / --box / --evidence / --evidnote / --card / --origpage / --origbox 之一'); process.exit(2);
    }
    const chg = [];
    // v2.4：cardId 是「题身份」的一部分。建账时写「（未入卡）」、后来真建了卡的条目，
    // 必须能改指到真卡，否则 _闭环稽核.mjs 会把它判成「应补建卡而没建」（T010 实证）。
    // 改动留痕 cardIdFix，不静默。
    if (opt.card !== undefined) {
      const oldC = it.cardId || '';
      if (oldC !== opt.card) it.cardIdFix = `${today()} 卡号由「${oldC}」改指「${opt.card}」`;
      it.cardId = opt.card;
      chg.push('cardId=' + opt.card);
    }
    if (opt.qref !== undefined) { it.qRef = opt.qref; chg.push('qRef'); }
    if (opt.box !== undefined) {
      const oldB = boxStr(it.box), newB = boxStr(parseBox(opt.box));
      // v2.5：红框框错地方＝灯箱「放大到这一题」放大到别的区域（T086 实证：登记 [0,0,1200,800]
      // 只框住题干，把题图整个落在框外）。改动留痕 boxFix，不静默。
      /* v2.7（2026-10-19）：box 是**证据图上的源图像素**。历史欠账里 T187~T192 把 0~1 归一化值
         写进了这个字段（`--box "0.06,0.42,0.92,0.18"` 被 parseBox 四舍五入成 0,0,1,0 之类），
         灯箱红框缩成左上角一个点——用户看到的"切图不对应"里有一半是这么来的。
         写入时硬拒，归一化值只能进 --origbox。 */
      if (opt.box !== '' && looksNormalized(parseBox(opt.box))) {
        console.error(`✖ --box「${opt.box}」是 0~1 归一化值，但这个字段要的是**证据图上的像素坐标**。`);
        console.error('   像素坐标示例（图 1600x400，框住中间那块）：--box "40,120,1500,260"');
        console.error('   整页归一化红框请用：--origpage "<整页路径>" --origbox "x,y,w,h"（0~1）');
        process.exit(2);
      }
      if (oldB !== newB) it.boxFix = `${today()} 红框 ${oldB || '（无）'} → ${newB || '（清空）'}`;
      it.box = parseBox(opt.box); chg.push('box=' + (it.box ? boxStr(it.box) : 'null'));
    }
    if (opt.evidence !== undefined) {
      // 回原卷实测「这张证据图根本不含该题」= 错页 → 换图，旧路径留痕便于回滚。
      // 只换斜杠不算换图（sameFile）——否则单纯归一化会被误记成「错页换图」，污染留痕。
      const old = it.evidence || '';
      // v2.5：写入前先过护栏（通配符拒收；文件不存在直接拒收）——坏的图路径根本进不来。
      const neo = opt.evidence ? guardEvidence(opt.evidence, '定位') : '';
      if (old && !sameFile(old, neo)) it.evidenceFix = `${today()} 由「${old}」改指「${neo}」——原图实测不含该题（错页）`;
      it.evidence = neo;
      chg.push('evidence=' + neo);
      if (neo) console.log(`   ✔ 证据图复核：${evAbs(neo)}（${fs.statSync(evAbs(neo)).size} 字节）`);
    }
    if (opt.evidnote !== undefined) { it.evidenceNote = opt.evidnote; chg.push('evidenceNote'); }
    /* v2.6：待办级整页定位（无卡待办的原图链路）。origPage 过与证据图同一套护栏；
       页与框成对（只给其一会算出半吊子数据——页无框=红框丢失，框无页=框没有落点）。
       ⚠ 显式传参但解析失败必须硬拒，不许静默当"没传"（2026-10-16 自测抓出：
       --origbox "abc" 原先被 parseNormBox 吞成 null、流程当没传继续跑）。 */
    if (opt.origpage !== undefined || opt.origbox !== undefined) {
      let nb = null, nbGiven = false;
      if (opt.origbox !== undefined && String(opt.origbox).trim() !== '') {
        nb = parseNormBox(opt.origbox);
        if (!nb) { console.error('✖ --origbox「' + opt.origbox + '」不是合法的归一化框（x,y,w,h，0~1 内、w/h>0）'); process.exit(2); }
        nbGiven = true;
      }
      const oldPg = normEv(it.origPage || ''), oldBx = Array.isArray(it.origBox) ? it.origBox.slice() : null;
      const newPgRaw = opt.origpage !== undefined ? normEv(String(opt.origpage)) : oldPg;
      const newPg = newPgRaw ? guardEvidence(newPgRaw, '定位') : '';
      const newBx = nbGiven ? nb : oldBx;
      if ((newPg && !newBx) || (!newPg && newBx)) {
        console.error('✖ 整页与红框必须成对（现算得：页=' + (newPg || '无') + ' 框=' + (newBx ? newBx.join(',') : '无') + '）');
        console.error('   登记完整一对：node _待确认.mjs 定位 --id ' + it.id + ' --origpage "<小名>/原卷/<批次>/整页.jpg" --origbox "x,y,w,h"');
        console.error('   成对清空：     node _待确认.mjs 定位 --id ' + it.id + ' --origpage "" --origbox ""');
        process.exit(2);
      }
      if (oldPg !== newPg || normBoxStr(oldBx) !== normBoxStr(newBx)) it.origFix = `${today()} 整页定位 ${oldPg || '（无）'}${oldBx ? '@' + normBoxStr(oldBx) : ''} → ${newPg || '（清空）'}${newBx ? '@' + normBoxStr(newBx) : ''}`;
      it.origPage = newPg;
      it.origBox = newBx;
      chg.push('origPage=' + (newPg || 'null') + (newBx ? '@' + normBoxStr(newBx) : ''));
    }
    save(j);
    console.log(`${it.id} 定位已更新（${chg.join(' / ')}）：${it.qRef || '（无题号）'}${it.box ? '  ▣' + boxStr(it.box) : ''}${it.evidence ? '  🖼' + it.evidence : ''}`);
    if (it.evidenceFix) console.log(`   证据图修正留痕：${it.evidenceFix}`);
    if (it.origFix) console.log(`   整页定位留痕：${it.origFix}`);
    if (it.boxFix) console.log(`   红框修正留痕：${it.boxFix}`);
    if (it.evidenceNote) console.log(`   备注：${it.evidenceNote}`);
    render();
  }
} else if (action === '改问题') {
  // 2026-10-09：起因——用户看到 T056 的问题停在「…若按苏科版"探究动滑轮的）」看不懂。
  // 根因是生成器对判卷理由做了 slice(0,110) 硬截断（断句中间、还没标省略号）。
  // question 是给人看的一句话，截断等于没写；但本工具是唯一写入入口，所以补文本也必须从这里走，
  // 不许手改 JSON。旧文本字数与新文本都留痕（questionFix），不静默替换。
  const j = load();
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  if (!opt.q) { console.error('缺参数：--q 必填（补全后的问题全文）'); process.exit(2); }
  guardJargon('改问题 --q', opt.q, opt.force);
  guardAskShape('改问题 --q', { question: opt.q, askWho: it.askWho }, opt.force);
  const old = it.question || '';
  if (old === opt.q) { console.log(`${it.id} 问题文本无变化，未写盘`); process.exit(0); }
  it.question = opt.q;
  it.questionFix = `${today()} 问题文本 ${old.length} → ${opt.q.length} 字${opt.note ? '：' + opt.note : ''}`;
  /* BUG-22（2026-10-11）：旧文本原先只 print 到 stdout，滚过就没了 —— 而"改写给人看的文本"
     本身就该可回溯（用户日后问"原来写的是什么"要有答案）。故把原文一并落库。
     只留最近一次改写前的原文，避免台账膨胀；字段名与被改写字段对应。 */
  it.questionBefore = old;
  save(j);
  console.log(`${it.id} 问题已改写（${old.length} → ${opt.q.length} 字）`);
  console.log(`   留痕：${it.questionFix}`);
  console.log(`   原文已入库 questionBefore（${old.length} 字），不再是"只打印一次"`);
  render();
} else if (action === '改详情') {
  // 2026-10-10：起因——用户质询「好多措辞说『答案键』，这是什么意思啊，我理解不过来」。
  // 与 改问题 同一条纪律：detail 也是给人看的，改写必须走本工具、留痕（detailFix），不许手改 JSON。
  const j = load();
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  if (!opt.detail) { console.error('缺参数：--detail 必填（改写后的说明全文）'); process.exit(2); }
  guardJargon('改详情 --detail', opt.detail, opt.force);
  const old = it.detail || '';
  if (old === opt.detail) { console.log(`${it.id} 详情文本无变化，未写盘`); process.exit(0); }
  it.detail = opt.detail;
  it.detailFix = `${today()} 详情文本 ${old.length} → ${opt.detail.length} 字${opt.note ? '：' + opt.note : ''}`;
  it.detailBefore = old;   // BUG-22：原文入库，别只打印一次
  save(j);
  console.log(`${it.id} 详情已改写（${old.length} → ${opt.detail.length} 字）`);
  console.log(`   留痕：${it.detailFix}`);
  console.log(`   原文已入库 detailBefore（${old.length} 字）`);
  render();
} else if (action === '纠因') {
  /* ★ 2026-11-03（批次 3 §2「家长纠正·记录原因」入口 · 接口契约 §2.1）：
     家长/用户的「为什么纠正」按**原话**记在对应条目上，供 `_经验草稿.mjs 预览 --from-pending`
     按白名单组装成「先看、再决定分享」的公开草稿。三条纪律与 `加`/`改详情` 同族：
       ① append-only：只在条目上追加 `corrections[]`（元素恒为 {at, why, scope, target} 四字段），
          question/detail/status/answer 一个字都不碰 —— 那是「答」「改问题」「改详情」的活。
       ② 幂等：同一条 why 重复提交（家长重复点、脚本重跑）不重复追加、**不写盘**（连备份都不产生）。
       ③ 响亮拒绝：条目不存在 / --why 空 / scope 非法 / corrections 已存在但不是数组 ⇒ 退出码 2。
          最后一条是 BUG-02 那一族（"读不懂就当空的，随后覆盖掉"）：留痕被静默清空不可再生，宁可拒收。 */
  const CORR_SCOPES = ['卡', '配方', '流程'];
  const j = load();
  if (!opt.id) { console.error('缺参数：--id 必填（记在哪条待办上，如 T003）'); process.exit(2); }
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}（纠正原因要挂在已存在的待办上：先「加」一条，再「纠因」）`); process.exit(2); }
  const why = String(opt.why == null ? '' : opt.why).trim();
  if (!why) { console.error('缺参数：--why 必填（把家长/用户的原话写进来，不要空着）'); process.exit(2); }
  const scope = opt.scope === undefined ? '卡' : String(opt.scope);
  if (!CORR_SCOPES.includes(scope)) { console.error('scope 必须是：' + CORR_SCOPES.join(' / ')); process.exit(2); }
  const target = opt.target === undefined ? '' : String(opt.target);
  if (it.corrections !== undefined && !Array.isArray(it.corrections)) {
    console.error(`✖ ${it.id} 的 corrections 不是数组（实际 ${typeof it.corrections}）——拒绝继续。`);
    console.error('   它可能是被 PowerShell 的 ConvertFrom/To-Json 往返成了 {value:[…]}，先手工改回数组；');
    console.error('   本工具绝不把读不懂的留痕「当成空表」再覆盖（那会永久丢掉已记的纠正原因）。');
    process.exit(2);
  }
  const list = Array.isArray(it.corrections) ? it.corrections : (it.corrections = []);
  const dup = list.find(c => c && String(c.why) === why);
  if (dup) {
    console.log(`${it.id} 已记过同一条纠正原因，未重复追加（corrections 仍 ${list.length} 条，未写盘）`);
    console.log(`   在册：at=${dup.at || ''}  scope=${dup.scope || ''}${dup.target ? '  target=' + dup.target : ''}`);
    /* scope/target 与在册那条不同时**明写出来**：调用方以为记了新信息、实际什么都没变，
       正是本仓最忌的「静默降级」。留痕是追加式的，改在册那条只能人工编辑 JSON。 */
    if (String(dup.scope || '') !== scope || String(dup.target || '') !== target) {
      console.log(`   ⚠ 本次 scope/target（${scope}${target ? '/' + target : ''}）与在册那条不同 —— **未收录**；`);
      console.log('     corrections 是追加式留痕（不修改既有元素），要改在册那条请人工编辑 _待确认.json。');
    }
    process.exit(0);
  }
  list.push({ at: opt.date || today(), why, scope, target });
  save(j);
  console.log(`${it.id} 已记一条纠正原因（corrections ${list.length} 条）[${scope}${target ? '/' + target : ''}]：` +
    (why.length > 60 ? why.slice(0, 60) + '…' : why));
  render();
} else if (action === '候选') {
  /* ★ 2026-11-03（批次 4 §1 · 候选修订）：见本文件「候选修订 + 修订链」段的四条设计理由。
     本命令**只**追加条目上的 `candidates[]`，绝不碰 question/detail/status/answer/revisions。 */
  const j = load();
  if (!opt.id) { console.error('缺参数：--id 必填（这条修订草案挂在哪条待办上，如 T003）'); process.exit(2); }
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}（草案要挂在已存在的待办上：先「加」一条，再「候选」）`); process.exit(2); }
  guardCandShapes(it);
  if (!opt.kind) { console.error('缺参数：--kind 必填（' + CAND_KINDS.join(' | ') + '）'); process.exit(2); }
  if (!CAND_KINDS.includes(String(opt.kind))) { console.error('kind 必须是：' + CAND_KINDS.join(' / ') + '（收到「' + opt.kind + '」）'); process.exit(2); }
  const kind = String(opt.kind);
  if (opt.target === undefined || opt.target === true || !String(opt.target).trim()) {
    console.error('缺参数：--target 必填（卡号 / 配方 id / 流程名）——本工具不猜目标');
    process.exit(2);
  }
  const target = String(opt.target).trim();
  if (/[\\/]/.test(target) || target.includes('..') || target.length > 120) {
    console.error(`✖ --target「${target}」不像一个目标标识：不许含路径分隔符 / \`..\`，长度 ≤ 120（落点目录由 kind+target 生成，路径形态的 target 会把文件写到别处）`);
    process.exit(2);
  }
  const payload = payloadOf(opt);
  const payloadDigest = sha256hex(lfText(payload));
  const candId = candIdOf(kind, target, payloadDigest);
  const list = Array.isArray(it.candidates) ? it.candidates : (it.candidates = []);
  const dup = list.find(c => c && c.kind === kind && c.target === target && c.payloadDigest === payloadDigest);
  if (dup) {
    /* 幂等：同 kind+target+正文 ⇒ 复用同一条 candId，**不新增、不写盘**（连备份都不产生）。 */
    const voided = String(dup.status || '') === '已作废';
    console.log(`${it.id} 候选 ${dup.candId} 已存在，复用（${kind}/${target}，正文摘要相同；candidates 仍 ${list.length} 条，未写盘）`);
    console.log(`   在册状态：${dup.status || '（无）'}${dup.at ? '　提出日 ' + dup.at : ''}`);
    if (voided) {
      console.log('   ⚠ 这条候选已是「已作废」：候选号由**内容**决定，重复提交造不出第二条 —— 本次**没有**改任何状态；');
      console.log('     确要重新采纳，需人工把该候选的 status 改回「待采用」（本工具不替人撤销作废决定）。');
    }
    if (opt.json) console.log(JSON.stringify({ ok: true, id: it.id, candId: dup.candId, reused: true, kind, target, status: dup.status || '', at: dup.at || '', payloadDigest, candidates: list.length }));
    process.exit(0);
  }
  const rec = { candId, at: opt.date || today(), kind, target, payload, payloadDigest, status: '待采用', adoptedAt: null };
  list.push(rec);
  /* 这里**不**调 render()：`_待确认清单.md` 是「悬空问题」的渲染页，不显示候选与修订链，
     刷新它只会多写一个库内文件（契约 §1 也没要求）。要看候选请走 `修订`。 */
  save(j);
  console.log(`${it.id} 候选 ${candId} 已登记（${kind}/${target}，正文 ${lfText(payload).length} 字，状态 待采用；candidates ${list.length} 条）`);
  console.log(`   摘要：${candSummaryOf(payload)}`);
  console.log(`   正式写入（会写库）：node _待确认.mjs 采用 --id ${it.id} --candidate ${candId}${opt.json ? '' : ' ｜ 先看不写：加 --dry'}`);
  if (opt.json) console.log(JSON.stringify({ ok: true, id: it.id, candId, reused: false, kind, target, status: '待采用', at: rec.at, payloadDigest, candidates: list.length }));
} else if (action === '修订') {
  /* ★ 2026-11-03（批次 4 §1 · 修订链）：**只读**。界面（`reviewList`）与命令行共用这一份形状。
     现值（current）按 kind 给真源：卡→卡目录的 错题记录.md；配方→<AppRoot>\recipes\<id>\prompt.md；
     流程→没有机器可读现值（如实报 missing + 原因）。presence 二值，**不许**静默给空串（L-530）。 */
  const j = load();
  if (!opt.id) { console.error('缺参数：--id 必填（看哪条待办的候选与修订链，如 T003）'); process.exit(2); }
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  guardCandShapes(it);
  const cands = candsOf(it), revs = revsOf(it);
  const curCache = new Map();
  const curFor = (kind, target) => {
    const k = kind + '|' + target;
    if (!curCache.has(k)) curCache.set(k, currentOf(kind, target));
    return curCache.get(k);
  };
  const rows = cands.map(c => {
    const kind = String((c && c.kind) || ''), target = String((c && c.target) || '');
    const cur = curFor(kind, target);
    const adoptedRev = revs.filter(r => r && r.candId === (c && c.candId)).pop() || null;
    const status = String((c && c.status) || '');
    const reason = status === '已采用'
      ? (`已采用${c.adoptedAt ? '（' + c.adoptedAt + '）' : ''}：` + (adoptedRev && adoptedRev.written ? '写入 ' + adoptedRev.written.join('、') : '见 revisions[]'))
      : status === '已作废' ? '已作废：人明确否决了这条草案（不再可采纳）' : '';
    return {
      candId: String((c && c.candId) || ''), at: String((c && c.at) || ''), kind, target, status,
      adoptedAt: (c && c.adoptedAt != null) ? c.adoptedAt : null,
      payloadDigest: String((c && c.payloadDigest) || ''),
      payloadLen: lfText(c && c.payload).length,
      payload: typeof (c && c.payload) === 'string' ? c.payload : '',
      summary: candSummaryOf(c && c.payload),
      current: cur.value, currentPresence: cur.presence, currentWhy: cur.why, currentFrom: cur.from,
      reason,
    };
  });
  const counts = {
    candidates: rows.length,
    pending: rows.filter(r => r.status === '待采用').length,
    adopted: rows.filter(r => r.status === '已采用').length,
    void: rows.filter(r => r.status === '已作废').length,
    revisions: revs.length,
  };
  /* 目标维度：同一 kind+target 的现值只算一次（界面左侧栏直接用这张表） */
  const targets = [];
  for (const r of rows) {
    if (targets.some(t => t.kind === r.kind && t.target === r.target)) continue;
    const adoptedRev = revs.filter(x => x && x.kind === r.kind && x.target === r.target).pop() || null;
    targets.push({
      kind: r.kind, target: r.target,
      currentPresence: r.currentPresence, currentWhy: r.currentWhy, currentFrom: r.currentFrom, current: r.current,
      adoptedCandId: adoptedRev ? String(adoptedRev.candId || '') : null,
      adoptedAt: adoptedRev ? String(adoptedRev.at || '') : null,
    });
  }
  if (opt.json) {
    console.log(JSON.stringify({ ok: true, id: it.id, candidates: rows, revisions: revs, counts, targets }));
  } else {
    console.log(`${it.id} 候选 ${counts.candidates} 条（待采用 ${counts.pending} ｜ 已采用 ${counts.adopted} ｜ 已作废 ${counts.void}）｜ 修订链 ${counts.revisions} 条`);
    if (!rows.length) console.log('   （还没有候选修订。提一条：node _待确认.mjs 候选 --id ' + it.id + ' --kind 卡 --target <卡号> --payload "<正文>"）');
    for (const r of rows) {
      console.log(`   ${r.status === '已采用' ? '✔' : r.status === '已作废' ? '✖' : '○'} ${r.candId}  [${r.kind}/${r.target}]  ${r.status}  ${r.at}  正文 ${r.payloadLen} 字`);
      console.log(`        ${r.summary}`);
      console.log(`        现值：${r.currentPresence === 'read' ? r.currentFrom + '（' + String(r.current || '').length + ' 字）' : '定位不到 —— ' + r.currentWhy}`);
      if (r.reason) console.log(`        ${r.reason}`);
    }
    if (revs.length) {
      console.log('── 修订链（append-only，谁在什么时候把哪段正文写进了哪些路径）');
      revs.forEach((r, i) => console.log(`   ${i + 1}) ${r.at}  ${r.by || '人'}  ${r.candId}  [${r.kind}/${r.target}]  写入：${(r.written || []).join('、')}${r.note ? '　note：' + r.note : ''}`));
    }
  }
  process.exit(0);
} else if (action === '采用') {
  /* ★ 2026-11-03（批次 4 §1 · 正式写入入口）：唯一的"草案 → 库"通道。
     硬要求（契约 §1.2）：
       · 走 `_安全写.mjs` 的**锁 + 事务**：落点文件与 `_待确认.json` 一次提交，失败**整体回滚**；
       · `--dry` 只报告将写什么，**一个字节都不写**；
       · 越界坐标 / 缺页 / 重复导入 各自给具体原因（见 packProblems 与落点检查）；
       · 成功后**追加** revisions[]、候选标「已采用」；同一 candId 重复采用幂等；
       · 绝不直接写 `answerSlots`/`answerMode`（本命令根本不碰 `_索引.json`；真涉及作答契约的修订
         只能走 `_作答门禁.mjs`，本批的"采用"落点是 `_修订\` 下的新对象，不越界）。 */
  const j = load();
  if (!opt.id) { console.error('缺参数：--id 必填（采纳哪条待办上的候选）'); process.exit(2); }
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  guardCandShapes(it);
  if (!opt.candidate) { console.error('缺参数：--candidate <candId> 必填（候选号，形如 c-0123456789ab）'); process.exit(2); }
  const candId = String(opt.candidate);
  if (!CAND_ID_RE.test(candId)) { console.error(`✖ 候选号形状不对：「${candId}」——应为 c- + 12 位小写 hex`); process.exit(2); }
  const cand = candsOf(it).find(c => c && c.candId === candId);
  if (!cand) {
    console.error(`候选不存在：${it.id} 上没有 ${candId}`);
    console.error(`   提一条：node _待确认.mjs 候选 --id ${it.id} --kind 卡 --target <卡号> --payload "<正文>"`);
    console.error(`   看在册的号码：node _待确认.mjs 修订 --id ${it.id}`);
    process.exit(3);
  }
  const candStatus = String(cand.status || '');
  /* 幂等：同一 candId 重复采用 ⇒ 不重复写入、不重复追加 revision，退出码 0 且明说。 */
  if (candStatus === '已采用') {
    const rev = revsOf(it).filter(r => r && r.candId === candId).pop() || null;
    const written = (rev && Array.isArray(rev.written)) ? rev.written : [];
    console.log(`${it.id} 采用 ${candId}：已采用（幂等）——未重复写入、未重复追加 revision`);
    console.log(`   首次采纳：${cand.adoptedAt || (rev && rev.at) || '（台账里没有采纳时刻）'}　写入：${written.join('、') || '（台账里没有写入清单）'}`);
    if (opt.json) console.log(JSON.stringify({ ok: true, id: it.id, candId, idempotent: true, dry: false, status: '已采用', written, revision: rev, revisions: revsOf(it).length }));
    process.exit(0);
  }
  if (candStatus !== '待采用') {
    console.error(`✖ 候选 ${candId} 状态是「${candStatus || '（空）'}」——只有「待采用」的候选能进库（已作废 = 人明确否决过；`+
      `要重新启用需人工把它改回「待采用」，本工具不替人撤销决定）`);
    process.exit(3);
  }
  const kind = String(cand.kind || ''), target = String(cand.target || '');
  if (!CAND_KINDS.includes(kind)) { console.error(`✖ 候选 ${candId} 记录里的 kind 不合法：「${kind}」——台账被手工改过？拒绝采信（不猜目标类型）`); process.exit(1); }
  if (!target.trim()) { console.error(`✖ 候选 ${candId} 记录里没有 target —— 拒绝采信（没有目标就没有落点）`); process.exit(1); }
  if (typeof cand.payload !== 'string') { console.error(`✖ 候选 ${candId} 记录里的 payload 不是字符串（实际 ${cand.payload === null ? 'null' : typeof cand.payload}）——拒绝采信`); process.exit(1); }
  const payload = cand.payload;
  const payloadDigest = sha256hex(lfText(payload));
  if (cand.payloadDigest !== payloadDigest) {
    console.error(`✖ 候选 ${candId} 的正文与记录里的摘要不符（记录 ${String(cand.payloadDigest || '（无）').slice(0, 16)}… 实算 ${payloadDigest.slice(0, 16)}…）——正文被手工改过，拒绝采信`);
    process.exit(1);
  }
  const relPath = revisionRelOf(kind, target, candId);
  const absPath = path.join(ROOT, ...relPath.split('/'));
  const body = revisionFileBody(it, cand);
  /* 「缺页」的库内一侧：卡/配方的目标在当前库里定位不到 ⇒ **必须喊出来**（给具体原因），
     但**不阻断** —— 草案本来就可以指向一张还没建的卡（那是"先记想法"）。流程类没有机器可读目标，
     缺省就是 missing，不算异常，故不在此列。 */
  const curWarn = currentOf(kind, target);
  if (curWarn.presence === 'missing' && kind !== '流程') {
    console.log(`   ⚠ 现值定位不到（仍按草案写入）：${curWarn.why}`);
  }
  /* 落点已存在 ⇒ 两种情形，**绝不覆盖**（本仓最忌"顺手覆盖"） */
  let skipWrite = false;
  if (fs.existsSync(absPath)) {
    const cur = fs.readFileSync(absPath, 'utf8');
    if (cur === body) {
      skipWrite = true;      // 半截失败后的重跑：正文已一致，只补台账
      console.log(`   ℹ 落点已存在且内容一致：${relPath} —— 跳过写入（幂等），只补台账留痕`);
    } else {
      console.error(`✖ 重复导入：落点已存在且内容不同 → ${relPath}`);
      console.error('   两种可能，本工具都不替你决定：');
      console.error('     ① 这条修订被人手工改过 —— 修订对象是人工留痕，只增不改，不许拿草案覆盖它；');
      console.error('     ② 候选号串号（同一个 candId 指向了不同正文）—— 人工核对台账后再处理。');
      process.exit(1);
    }
  }
  /* 正文是修订包（JSON）时校验坐标与页引用；纯文本则**明说**没有可校验的机器字段（不许静默通过） */
  const at = nowIsoLocal();
  if (opt.dry) console.log(`${it.id} 采用 ${candId}（--dry 预演：**一个字节都不写**）`);
  const pack = tryPack(payload);
  if (pack.isJson) {
    const bad = packProblems(pack.obj);
    if (bad.length) {
      console.error(`✖ 候选 ${candId} 的正文是修订包，但没通过校验（${bad.length} 处）：`);
      for (const b of bad) console.error('   · ' + b);
      console.error('   形状与判据见 docs\\录题任务契约.md「候选与修订链」。台账与库**一字未动**。');
      process.exit(1);
    }
    console.log(`   ✔ 正文是修订包：坐标与页引用校验通过（${['regions', 'origBox', 'box', 'page', 'origPage', 'pageSha'].filter(k => pack.obj[k] !== undefined).join('/') || '（没给坐标或页字段）'}）`);
  } else {
    console.log(`   ℹ 正文是纯文本修订（${pack.broken ? '以 { 开头但不是合法 JSON' : '不是 JSON'}）——没有坐标/页引用可校验，按整段文本写入`);
  }
  const note = pack.isJson && typeof pack.obj.note === 'string' ? pack.obj.note : '';
  const written = [relPath, '_待确认.json'];
  if (opt.dry) {
    console.log(`   将新建修订对象：${relPath}（${Buffer.byteLength(body, 'utf8')} 字节，内容 = 候选正文的纯函数）`);
    console.log(`   将追加 revisions[]：{ at: ${at}, by: 人, candId: ${candId}, kind: ${kind}, target: ${target}, written: [${written.join(', ')}]${note ? ', note: ' + JSON.stringify(note) : ''} }`);
    console.log(`   将把候选状态：待采用 → 已采用`);
    if (opt.json) console.log(JSON.stringify({ ok: true, id: it.id, candId, dry: true, idempotent: false, written, status: '待采用', wouldSetStatus: '已采用', relPath, bytes: Buffer.byteLength(body, 'utf8') }));
    process.exit(0);
  }
  const rev = { at, by: '人', candId, kind, target, written, note };
  try {
    /* 顺序有意为之：**先写台账留痕、后落正文**。这样"正文落盘失败"落在事务的第二个写上 ⇒
       回滚必须把台账恢复成原样（tests\neg-revision-chain.cjs 的"库逐字节不变"就是这个构造）。
       若反过来，失败发生在台账之前，回滚无从验证 —— 那样的用例等于没测事务。 */
    withLibWrite(ROOT, '_待确认 采用 ' + candId, tx => {
      cand.status = '已采用';
      cand.adoptedAt = at;
      it.revisions = revsOf(it);
      it.revisions.push(rev);
      tx.writeJson(DB, j, { backup: true });
      if (!skipWrite) tx.writeText(absPath, body);
    });
  } catch (e) {
    console.error(`✖ 采用失败，事务已整体回滚（` + '_待确认.json 与 ' + relPath + ` 都回到调用前）：${e && e.message}`);
    process.exit(2);
  }
  console.log(`${it.id} 采用 ${candId}（${kind}/${target}）：已写入 ${relPath}`);
  console.log(`   revisions 追加 1 条（共 ${revsOf(it).length} 条），候选状态 → 已采用（${at}）`);
  console.log(`   写入清单：${written.join('、')}${skipWrite ? '（正文文件是复用已有的那份）' : ''}`);
  if (opt.json) console.log(JSON.stringify({ ok: true, id: it.id, candId, idempotent: false, dry: false, status: '已采用', written, revision: rev, revisions: revsOf(it).length, reusedFile: skipWrite, bytes: Buffer.byteLength(body, 'utf8') }));
} else if (action === '作废候选') {
  /* 把一条还没进库的候选标「已作废」：只改 status，不改其它字段、不删行（留痕备查）。 */
  const j = load();
  if (!opt.id) { console.error('缺参数：--id 必填（作废哪条待办上的候选）'); process.exit(2); }
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  guardCandShapes(it);
  if (!opt.candidate) { console.error('缺参数：--candidate <candId> 必填'); process.exit(2); }
  const candId = String(opt.candidate);
  if (!CAND_ID_RE.test(candId)) { console.error(`✖ 候选号形状不对：「${candId}」——应为 c- + 12 位小写 hex`); process.exit(2); }
  const cand = candsOf(it).find(c => c && c.candId === candId);
  if (!cand) { console.error(`候选不存在：${it.id} 上没有 ${candId}`); process.exit(3); }
  if (String(cand.status || '') !== '待采用') {
    console.error(`✖ 候选 ${candId} 状态是「${cand.status || '（空）'}」——只有「待采用」的候选能作废` +
      (String(cand.status || '') === '已采用' ? '（已采用的修订已经进库，撤销它得走 `git revert` + 回退流程，不是这里改状态）' : ''));
    process.exit(3);
  }
  cand.status = '已作废';
  save(j);
  console.log(`${it.id} 候选 ${candId} → 已作废（${cand.kind}/${cand.target}；只改状态，其它字段一字未动）`);
  if (opt.json) console.log(JSON.stringify({ ok: true, id: it.id, candId, status: '已作废', kind: cand.kind, target: cand.target, candidates: candsOf(it).length }));
} else if (action === '答' || action === '作废') {
  const j = load();
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  if (!opt.answer) { console.error('缺参数：--answer 必填（把答案原文记下来）'); process.exit(2); }
  it.status = action === '答' ? '已确认' : '已作废';
  it.answer = opt.note ? `${opt.answer}（${opt.note}）` : opt.answer;
  it.resolvedAt = opt.date || today();
  save(j);
  console.log(`${it.id} → ${it.status}：${it.answer}`);
  render();
} else if (action === '撤回') {
  const j = load();
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  if (open(it)) { console.error(`${it.id} 本来就是未确认，无需撤回`); process.exit(2); }
  const old = it.answer;
  it.status = '未确认';
  it.answer = '';
  it.resolvedAt = '';
  save(j);
  console.log(`${it.id} 已撤回为「未确认」（原结论留档于此）：${old}`);
  render();
} else if (action === '删') {
  const j = load();
  const i = j.items.findIndex(x => x === findById(j, opt.id));
  if (i < 0) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  const it = j.items[i];
  if (!open(it) || it.answer) {
    console.error(`${it.id} 已有结论（status=${it.status}），不许删——改走「作废」保留留痕`);
    process.exit(2);
  }
  j.items.splice(i, 1);
  save(j);
  console.log(`已删 ${it.id}（误加条目）：${it.question}`);
  render();
} else if (action === '同步') {
  // v2.0：消费首页「待办工作台」导出的结论包（ctb-pending-*.json），幂等落库。
  // 包格式：{ exportedAt, tool:'ctb-homepage-pending', resolves:[{id, action:'答'|'作废', answer}] }
  if (!opt.file) { console.error('缺参数：--file <ctb-pending-*.json> 必填'); process.exit(2); }
  if (!fs.existsSync(opt.file)) { console.error(`文件不存在：${opt.file}`); process.exit(2); }
  const pkg = JSON.parse(fs.readFileSync(opt.file, 'utf8').replace(/^\uFEFF/, ''));
  const list = Array.isArray(pkg.resolves) ? pkg.resolves : [];
  if (!list.length) { console.log('包里没有待落库的结论（resolves 为空）'); process.exit(0); }
  const j = load();
  let ok = 0, skip = 0, miss = 0;
  for (const r of list) {
    const it = findById(j, r.id);
    if (!it) { console.error(`  ✖ ${r.id}：台账中不存在`); miss++; continue; }
    if (!open(it)) { console.log(`  ↔ ${r.id}：已是「${it.status}」（${it.answer}），跳过`); skip++; continue; }
    if (r.action === '作废') {
      it.status = '已作废';
      it.answer = r.answer || '（首页作废，未填理由）';
    } else {
      it.status = '已确认';
      it.answer = r.answer || '（首页确认，未填内容）';
    }
    it.resolvedAt = opt.date || today();
    console.log(`  ✔ ${r.id} → ${it.status}：${it.answer}`);
    ok++;
  }
  if (ok) { save(j); render(); }
  console.log(`同步完成：落库 ${ok}，跳过 ${skip}，未找到 ${miss}`);
} else if (action === '对位') {
  const j = load();
  const { open: nOpen, rows, bad } = alignAudit(j);
  if (opt.json) {
    console.log(JSON.stringify({
      open: nOpen,
      ok: nOpen - bad.length,
      bad: bad.length,
      rows: rows.map(r => ({ id: r.id, card: r.card, claim: r.claim, evKind: r.evKind, evPrinted: r.evPrinted, problems: r.problems })),
    }));
  } else {
    if (!fs.existsSync(path.join(ROOT, '_页码映射.json'))) console.log('⚠ 缺 _页码映射.json（扫描件→印刷页码的单一真源），对位结果不可信。');
    console.log(`对位门禁：未确认 ${nOpen} 条 ｜ 对得上 ${nOpen - bad.length} 条 ｜ 对不上 ${bad.length} 条`);
    for (const r of bad) {
      console.log(`   ✖ ${r.id}  ${r.card}  问第${r.claim == null ? '?' : r.claim}页  图=${r.evKind}${r.evPrinted != null ? '(第' + r.evPrinted + '页)' : ''}`);
      for (const p of r.problems) console.log(`       · ${p}`);
    }
    if (!bad.length) console.log('   ✅ 每条待办的证据图都指向它问的那一页。');
    else console.log('   修法：node _待确认.mjs 定位 --id Txxx --evidence "<小名>/<学科>/<卡号-描述>/待办证据/Txxx.jpg" --box "x,y,w,h" --origpage "<小名>/原卷/<批次>/<整页>.jpg" --origbox "x,y,w,h"');
  }
  process.exit(bad.length ? 1 : 0);
} else if (action === '证据') {
  // 2026-10-07：证据图门禁。待办没图 = 首页空白（用户质询「现在怎么没图了？」），
  // 所以把「有没有图、图还在不在」变成可挂自检的机器门禁，而不是靠人记得。
  // v2.5（2026-10-10）：再补两类静默失效——① 路径含通配符（永远加载不到，T086 实证）；
  // ② 文件不在（错页换图后忘了改）。两类都算「图不可用」，与缺图同罪。
  const j = load();
  const pend = j.items.filter(open);
  /* ⚠ 2026-10-11 修：原先只查未确认项 ⇒ 已办结项的证据链**从不校验**。
     实测 4 条已确认待办（T082/T083/T085/T086）在对应卡被撤走后 evidence 永久失效，而门禁报"通过"。
     现在：已办结项也查，默认**只报告不阻断**（历史欠账不该让门禁常年红），
     加 --all-archived 则一并阻断。 */
  const done = j.items.filter(it => it.status === '已确认' || it.status === '已作废');
  const archBroken = [];
  for (const it of done) {
    if (!it.evidence) continue;                       // 老条目本就没有该字段，不算坏
    if (GLOB_CH.test(normEv(it.evidence))) { archBroken.push(it); continue; }
    if (!evOk(it.evidence)) archBroken.push(it);
  }
  const archStrict = !!(opt['all-archived'] || opt.allArchived);
  const missing = pend.filter(it => !it.evidence);
  const wild = pend.filter(it => it.evidence && GLOB_CH.test(normEv(it.evidence)));
  const broken = [];
  for (const it of pend) {
    if (!it.evidence || GLOB_CH.test(normEv(it.evidence))) continue;
    if (!evOk(it.evidence)) broken.push(it);
  }
  const bad = missing.length + wild.length + broken.length + (archStrict ? archBroken.length : 0);
  if (opt.json) {
    console.log(JSON.stringify({
      open: pend.length,
      withEvidence: pend.length - missing.length,
      missing: missing.map(it => it.id),
      wildcard: wild.map(it => ({ id: it.id, evidence: it.evidence })),
      broken: broken.map(it => ({ id: it.id, evidence: it.evidence })),
      archivedChecked: done.length,
      archivedBroken: archBroken.map(it => ({ id: it.id, status: it.status, evidence: it.evidence })),
    }));
  } else if (!bad) {
    console.log(`证据门禁通过：${pend.length}/${pend.length} 条未确认都有可用证据图。`);
    if (archBroken.length) console.log(`   ⚠ 但另有 ${archBroken.length}/${done.length} 条**已办结**项的证据链已断（历史欠账，不阻断；加 --all-archived 可拦）：` + archBroken.map(it => it.id).join(' '));
  } else {
    if (missing.length) {
      console.log(`证据门禁不通过：${missing.length} 条未确认没有证据图 —— 首页这些条是空白。`);
      for (const it of missing) console.log(`   缺图 ${it.id}  ${fmt(it)}  ${it.question}`);
      console.log('   （补：node _待确认.mjs 定位 --id Txxx --evidence "<小名>/<学科>/<卡号-描述>/原卷截图.jpg" --box "x,y,w,h"）');
    }
    if (wild.length) {
      console.log(`证据门禁不通过：${wild.length} 条的证据图路径是通配符 —— 永远加载不到，界面上只剩破图。`);
      for (const it of wild) console.log(`   通配 ${it.id}  → ${it.evidence}`);
      console.log('   （换成真实卡目录全名：node _待确认.mjs 定位 --id Txxx --evidence "<小名>/<学科>/<卡号>-<描述>/原卷截图.jpg"）');
    }
    if (broken.length) {
      console.log(`证据门禁不通过：${broken.length} 条的证据图路径已失效（文件不在）。`);
      for (const it of broken) console.log(`   失效 ${it.id}  → ${it.evidence}`);
    }
    if (archBroken.length) {
      console.log(`${archStrict ? '证据门禁不通过' : '提示'}：${archBroken.length}/${done.length} 条**已办结**项的证据链已断（结案依据不可复查）。`);
      for (const it of archBroken) console.log(`   ${archStrict ? '失效' : '欠账'} ${it.id}[${it.status}]  → ${it.evidence}`);
      console.log('   （若卡已撤：改指撤卡留档，如 node _待确认.mjs 定位 --id Txxx --evidence "_撤卡留档/<批次>/<卡目录>/原卷截图.jpg"）');
    }
  }
  process.exit(bad ? 1 : 0);
} else if (action === '状态') {
  const j = load();
  let its = j.items;
  if (opt.student) its = its.filter(it => it.student === opt.student);
  if (opt.ask) its = its.filter(it => it.askWho === opt.ask);
  const pend = its.filter(open);
  console.log(`待确认台账：${its.length} 条，其中未确认 ${pend.length} 条`);
  for (const who of ASK_ORDER) {
    const g = pend.filter(it => it.askWho === who);
    if (!g.length) continue;
    console.log(`\n── 问${who}（${g.length}）`);
    for (const it of g) console.log(`   ${it.id}  ${fmt(it)}  [${it.kind}]  ${it.question}`);
  }
  const done = its.filter(it => !open(it));
  if (done.length) console.log(`\n（已确认/已作废 ${done.length} 条）`);
} else if (action === '门禁') {
  const j = load();
  const pend = j.items.filter(open);
  const noQref = pend.filter(it => !it.qRef);
  const noBox = pend.filter(it => it.qRef && !Array.isArray(it.box));
  // v2.3 文本截断门禁（2026-10-09）：起因——用户看到 T056 的问题停在「…若按苏科版"探究动滑轮的）」，
  // 读不懂。根因是生成器对判卷理由做 slice(0,110) 硬切。**凡问题文本不是以句末标点（或右括号）收尾的，
  // 一律点名**——这类截断从表面看像"写完了"，只在句尾露馅，靠人肉翻是翻不出来的（同"缺图""缺题号"一个套路）。
  const truncated = pend.filter(it => {
    const t = String(it.question || '').trim();
    if (!t) return false;
    if (!/[。？！）]$/.test(t)) return true;          // 裸停在半句：…判卷依据自身推
    if (!t.endsWith('）')) return false;
    // 末尾括号里是不是"没写完的长段落"（找配对的开括号；短的如「（决定本题判对还是判错）」不算）
    let depth = 0, start = -1;
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i] === '）') depth++;
      else if (t[i] === '（') { depth--; if (depth === 0) { start = i; break; } }
    }
    if (start < 0) return false;
    const inner = t.slice(start + 1, -1);
    return inner.length >= 80 && !/[。？！…]$/.test(inner);   // …若按苏科版"探究动滑轮的）
  });
  /* v2.4 后续动作门禁（2026-10-09）：已确认但没登记「处置」的条目 = 结论落了库、动作没人做。
     这类条目从表面看是"已办结"，最容易被当成干完了（同"缺图""截断"一个套路）。
     同时点名「没做判定」的——那是五段闭环里 agent 该做却没做的一环（教训 L-332）。 */
  const doneAll = j.items.filter(it => !open(it) && it.status === '已确认');
  const noDisp = doneAll.filter(it => !it.disposition);
  const noVerdict = doneAll.filter(it => !it.verdict);
  /* v2.5（2026-10-10）：把「证据图到底能不能显示」也做成机器可读字段。
     起因：T086 的图路径是通配符，界面只能干等 <img> 加载失败——破图 + 点不动的按钮，
     用户看到的就是「这个待办有问题，没有图形链接」。现在前端能拿到 evidenceOk，坏图不等加载、直接显式报错。 */
  const evBad = pend.filter(it => !evOk(it.evidence));
  /* v2.6（2026-10-16）：原图接通率 = 灯箱 ⇄/🗂 能开到**正立整页**的条目占比。
     接通 = 有卡且卡有整页（走 M.origOf）或台账直接登记了 origPage。只统计、不阻断——
     但必须让缺口可见（此前 9 条无卡物理待办就这样无声漏掉，用户点开才发现全是裁图）。
     若登记了 origPage 但文件不在盘，那是坏数据 → 与证据图同罪，进 evOrigBad。 */
  const origOk = it => {
    if (it.origPage) return evOk(it.origPage);
    if (it.cardId && /\w/.test(it.cardId || '')) {
      // 有卡条目：卡是否有整页由台账/索引 JOIN 决定（本工具不重复实现），只按「有卡」粗判
      return 'card';
    }
    return false;
  };
  const origOn = pend.filter(it => origOk(it) === true || origOk(it) === 'card');
  const origOff = pend.filter(it => !it.cardId || !/\w/.test(it.cardId || '')).filter(it => !it.origPage);
  const origBad = pend.filter(it => it.origPage && !evOk(it.origPage));
  /* 门禁五律（2026-10-09 定版 · 2026-10-12 补）：人类模式与 --json **同一个退出码、同一份判定**。
   * ⚠ 2026-10-12 修（审计 BUG-02）：原实现在 `--json` 分支只 console.log 就落到末尾的
   *   `process.exit(pend.length ? 1 : 0)`，而「待确认已清空但闭环未完成」的 `exit(1)`
   *   藏在 else 分支里 ⇒ **--json 永远给绿灯**，而 `_状态刷新.mjs`/`_体检.mjs`/`_生成首页.ps1`
   *   全走这条机器通道。这与本仓在 `_配图门禁.mjs:26-27` 记下并修过的坑是同一个、只换了触发条件。
   *   现在两种模式都落到末尾同一个判定；--json 里也带上 gateFail / problems，机器可直接读。 */
  const blockedByClosure = !!(noVerdict.length || noDisp.length);
  /* v2.7（2026-10-19）：对位缺口也进机器可读出口。**只统计不阻断**——
     它是「图与问题对不对得上」的质量指标，历史欠账不该让门禁常年红；
     但必须让缺口可见（此前 39/39 全对不上却无人知道，用户点开才发现图是另一道题）。 */
  const align = alignAudit(j);
  /* v2.8（2026-10-21）：重号门禁。起因见 findById 的注释——拆条脚本复用旧编号，
     造成 T191/T192 各两条，`find` 取到已作废那条 ⇒ 用户点「确认办结」永远落不了库
     （界面还报成功）。这类故障**表面上完全正常**（有图、有题号、按钮能点、提示是绿的），
     只有"办完还在"这一条线索，靠人肉翻是翻不出来的 —— 必须变成机器门禁。 */
  const dupIds = dupIdsOf(j);
  const gateProblems = [];
  if (pend.length) gateProblems.push('待确认 ' + pend.length + ' 条');
  if (dupIds.length) gateProblems.push('编号重号 ' + dupIds.map(d => d.id + '×' + d.count).join('、') + '（按编号取条目会取错，办结落不了库）');
  if (blockedByClosure) gateProblems.push('闭环未完成：未判定 ' + noVerdict.length + '／未登记后续动作 ' + noDisp.length);
  const gateFail = gateProblems.length > 0;
  if (opt.json) {
    // 供首页生成器消费：带上完整条目，单一实现仍在 _待确认.mjs（PS 侧只读不写）
    console.log(JSON.stringify({
      ok: !gateFail,                 // 机器通道的判定与人类模式同源（门禁五律）
      problems: gateProblems,
      open: pend.length,
      noVerdict: noVerdict.map(it => it.id),
      byAsk: ASK.reduce((a, k) => (a[k] = pend.filter(it => it.askWho === k).length, a), {}),
      // v2.2：定位缺口也进机器可读出口——「有没有说清在问哪一题」必须能被自检看到，
      // 不能只在网页上挂红条（10-08 那 22 条就是这么无声漏掉的）。
      noQref: noQref.map(it => it.id),
      noBox: noBox.map(it => it.id),
      truncated: truncated.map(it => it.id),
      doneTotal: doneAll.length,
      noDisposition: noDisp.map(it => it.id),
      evidenceBad: evBad.map(it => it.id),
      origOn: origOn.map(it => it.id), origOff: origOff.map(it => it.id), origBad: origBad.map(it => it.id),
      /* v2.7 对位：图与「问的是哪道题」对不对得上（只统计不阻断；`对位` 动作是它的可阻断版）。 */
      alignBad: align.bad.map(r => r.id),
      alignProblems: align.bad.reduce((a, r) => (a[r.id] = r.problems, a), {}),
      ids: pend.map(it => it.id),
      /* v2.8：重号清单。前端拿到非空数组时必须在工作台顶部显式报红（别再让"办完还在"无声发生）。 */
      dupId: dupIds.map(d => ({ id: d.id, count: d.count })),
      items: pend.map(it => pendingItemOut(it)),
      /* ★★ 2026-11-05（用户报障「照你这样说，你设置这个待办有什么用？……问了问题也认真回答了，
         可是根本没人看，没人懂」）：**已办结条目此前根本不在 `items` 里** ⇒
         前端那个「显示已办结」勾选框读的是同一个数组，勾上也是空的 ——
         用户的回话落了库，**界面上却像从来没发生过**。这就是"没人看、没人懂"的直接成因。
         现在：已办结条目也进 `items`，带 `status` 供前端分区显示（`M.pendingOpen()` 只取未确认，
         所以未办结工作面不受影响）。**已办结条目一律带 `answer`（你的原话）**，
         且带 `verdict`/`disposition`/`verdictNote`/`dispositionNote` —— 让"你的回话有没有被执行"
         在界面上直接看得见，不必去翻 JSON。 */
      doneItems: doneAll.map(it => ({
        ...pendingItemOut(it),
        answer: it.answer || '',
        verdict: it.verdict || '', verdictNote: it.verdictNote || '', verdictAt: it.verdictAt || '',
        disposition: it.disposition || '', dispositionNote: it.dispositionNote || '', dispositionAt: it.dispositionAt || '',
        resolvedAt: it.resolvedAt || '',
        /* true = 你的回话已被消费（判定+处置都登记了）；false = 回了但没人执行（欠账）。 */
        closed: !!(it.verdict && it.disposition),
      })),
    }));
  } else if (pend.length) {
    console.log(`门禁不通过：还有 ${pend.length} 条待确认`);
    if (dupIds.length) console.log(`  ⚠ 编号重号 ${dupIds.length} 个：${dupIds.map(d => d.id + '×' + d.count).join(', ')}  ← 按编号取条目会取到已办结那条，办结落不了库；修：给拆条产生的新条目重新取号（勿复用旧编号）`);
    for (const who of ASK_ORDER) {
      const g = pend.filter(it => it.askWho === who);
      if (g.length) console.log(`  问${who} ${g.length}：${g.map(it => it.id).join(', ')}`);
    }
    if (noQref.length) console.log(`  ⚠ 未登记题号 ${noQref.length}：${noQref.map(it => it.id).join(', ')}  ← 补：node _待确认.mjs 定位 --auto`);
    if (noBox.length) console.log(`  ○ 有题号缺红框 ${noBox.length}：${noBox.map(it => it.id).join(', ')}（不阻断，但灯箱无法自动对准）`);
    if (truncated.length) console.log(`  ⚠ 问题文本疑似截断 ${truncated.length}：${truncated.map(it => it.id).join(', ')}  ← 补：node _待确认.mjs 改问题 --id Txxx --q "完整文本"`);
    if (evBad.length) console.log(`  ⚠ 证据图不可用 ${evBad.length}：${evBad.map(it => it.id).join(', ')}  ← 补：node _待确认.mjs 定位 --id Txxx --evidence "<小名>/<学科>/<卡号>-<描述>/原卷截图.jpg"`);
    if (origBad.length) console.log(`  ⚠ 整页原图已失效 ${origBad.length}：${origBad.map(it => it.id).join(', ')}  ← 修：node _待确认.mjs 定位 --id Txxx --origpage "<小名>/原卷/<批次>/xxx.jpg" --origbox "x,y,w,h"`);
    if (origOff.length) console.log(`  ○ 原图未接通 ${origOff.length}：${origOff.map(it => it.id).join(', ')}（无卡且未登记整页 → 灯箱 ⇄/🗂 只能开到裁图）  ← 补：node _待确认.mjs 定位 --id Txxx --origpage "<小名>/原卷/<批次>/整页.jpg" --origbox "x,y,w,h"（0~1 归一化框）`);
    if (align.bad.length) console.log(`  ⚠ 图与问题对不上 ${align.bad.length}/${align.open}：${align.bad.map(r => r.id).join(', ')}  ← 详情：node _待确认.mjs 对位`);
    if (noVerdict.length) console.log(`  ⚠ 已办结但未做判定 ${noVerdict.length}/${doneAll.length}：${noVerdict.map(it => it.id).join(', ')}  ← 补：node _待确认.mjs 判定 --id Txxx --verdict "错|对|部分对|无法判定" --note "依据"`);
    if (noDisp.length) console.log(`  ⚠ 已办结但未登记后续动作 ${noDisp.length}/${doneAll.length}：${noDisp.map(it => it.id).join(', ')}  ← 补：node _待确认.mjs 处置 --id Txxx --as "无需处置|已补建卡|已撤卡|已核销|待人工" --note "..."`);
    console.log('（处置：node _待确认.mjs 状态 看全文；答完用 答 --id Txxx --answer "..."）');
  } else {
    if (blockedByClosure) {
      console.log(`门禁不通过：待确认已清空，但闭环未完成 —— 未判定 ${noVerdict.length}/${doneAll.length}、未登记后续动作 ${noDisp.length}/${doneAll.length}。`);
      if (noVerdict.length) console.log(`  ⚠ 未做判定：${noVerdict.map(it => it.id).join(', ')}  ← node _待确认.mjs 判定 --id Txxx --verdict "错|对|部分对|无法判定" --note "依据"`);
      if (noDisp.length) console.log(`  ⚠ 未登记后续动作：${noDisp.map(it => it.id).join(', ')}  ← node _待确认.mjs 处置 --id Txxx --as "..." --note "..."`);
    } else {
      console.log('门禁通过：待确认台账已清空，且所有已办结条目都登记了后续动作。');
    }
  }
  /* ⚠ 唯一出口：人类模式与 --json 都落到这里（门禁五律 L1+L2）。
     原先这里只看 pend.length，漏掉「闭环未完成」，是 BUG-02 的根因。 */
  process.exit(gateFail ? 1 : 0);
} else if (action === '判定') {
  /* v2.4（2026-10-09）：五段闭环的**第三段**。起因见方案 §四之十一 / 教训 L-332。
     用户给的 `answer` 常常是**线索**（「其它选项应该在下一页」），不是对错；判定是 agent 的活：
     必须回原卷/原图（判字先查笔形库）把线索解释成 错/对/部分对/无法判定，并写下依据。
     没有本字段 → 门禁红（「结论落了库、判定没人做」）；有判定后由 _闭环稽核.mjs 算「应做动作」。
     `不适用` 用于**非题目类**条目（系统维护、纯笔迹归属追责等）：它们没有"这道题对错"可言，
     应做动作固定为「无需处置」——不是"没法判"，是"判的对象不存在"。 */
  const VS = ['错', '对', '部分对', '无法判定', '不适用'];
  const j = load();
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  if (open(it)) { console.error(`${it.id} 还没结论（status=${it.status}），先「答」再「判定」`); process.exit(2); }
  if (!VS.includes(opt.verdict)) { console.error('缺参数或取值非法：--verdict ' + VS.join(' | ')); process.exit(2); }
  if (!opt.note) { console.error('缺参数：--note 必填（写清依据：回原卷/放大倍数/笔形库条目）'); process.exit(2); }
  it.verdict = opt.verdict;
  it.verdictNote = opt.note;
  it.verdictAt = opt.date || today();
  save(j);
  console.log(`${it.id} 判定 = ${opt.verdict}（${opt.note.slice(0, 70)}${opt.note.length > 70 ? '…' : ''}）`);
  render();
} else if (action === '处置') {
  /* v2.4（2026-10-09）：起因——用户质询「我作了这样的回答后，你会按照我的回答去寻找上一道题，
     并把那道题补全吗？」。查明：结论落库后**没有任何机器可读的"该做什么"**，"若确认孩子确实错了，
     需补建卡"只写在 detail 文本里；于是"办结"被误当成"办完"，实际后续动作（补建卡/撤卡/核销）
     全靠人记得。本动作把"结论之后干了什么"变成必填字段，门禁据此点名。
     取值：无需处置（结论=孩子对，确认在册库确无该卡）/ 已补建卡 / 已撤卡 / 已核销 / 待人工。 */
  const AS = ['无需处置', '已补建卡', '已撤卡', '已核销', '待人工'];
  const j = load();
  const it = findById(j, opt.id);
  if (!it) { console.error(`找不到 ${opt.id}`); process.exit(2); }
  if (open(it)) { console.error(`${it.id} 还没结论（status=${it.status}），先「答」再「处置」`); process.exit(2); }
  if (!AS.includes(opt.as)) { console.error('缺参数或取值非法：--as ' + AS.join(' | ')); process.exit(2); }
  it.disposition = opt.as;
  it.dispositionAt = opt.date || today();
  it.dispositionNote = opt.note || '';
  save(j);
  console.log(`${it.id} 处置 = ${opt.as}${opt.note ? '：' + opt.note : ''}`);
  render();
} else if (action === '措辞') {
  /* 机器门禁：给人看的文本（question/detail/qRef）里不许出现内部黑话。
   * 未确认条目命中 → 退出码 1（那正是马上要给用户看的）；已办结的历史条目只列报，不拦门，
   * 否则门禁常年红 → 和没有一样。`去黑话` 负责清历史欠账。 */
  const j = load();
  const dirty = [];
  for (const it of j.items) {
    const hit = [...new Set([
      ...jargonHits(it.question), ...jargonHits(it.detail), ...jargonHits(it.qRef),
    ])];
    if (hit.length) dirty.push({ id: it.id, status: it.status, terms: hit, q: it.question });
  }
  const live = dirty.filter(d => d.status === '未确认');
  if (opt.json) { console.log(JSON.stringify({ ok: live.length === 0, terms: JARGON, dirty, live: live.map(d => d.id) }, null, 1)); process.exit(live.length ? 1 : 0); }
  console.log(`措辞门禁：${j.items.length} 条待办里 ${dirty.length} 条含内部黑话（其中未确认 ${live.length} 条）`);
  for (const d of dirty.slice(0, 40)) console.log(`   ${d.id} [${d.status}] ${d.terms.join('、')}  ← ${String(d.q).slice(0, 46)}`);
  if (dirty.length > 40) console.log(`   …另 ${dirty.length - 40} 条，见 --json`);
  if (!dirty.length) console.log('   ✅ 全部是人话');
  else console.log(`   清理：node _待确认.mjs 去黑话 --dry 预览 → 去黑话 --apply 落库（走留痕）`);
  process.exit(live.length ? 1 : 0);
} else if (action === '问法') {
  /* 批量体检 question 是否合「三段式」。已办结的历史条目只列不拦（和 措辞 同口径）。 */
  const j = load();
  const dirty = [];
  for (const it of j.items) {
    const bad = shapeHits(it);
    if (bad.length) dirty.push({ id: it.id, status: it.status, ask: it.askWho, bad, q: it.question });
  }
  const live = dirty.filter(d => d.status === '未确认');
  if (opt.json) { console.log(JSON.stringify({ ok: live.length === 0, dirty, live: live.map(d => d.id) }, null, 1)); process.exit(live.length ? 1 : 0); }
  console.log(`问法门禁：${j.items.length} 条待办里 ${dirty.length} 条不合三段式（其中未确认 ${live.length} 条）`);
  for (const d of dirty.slice(0, 50)) console.log(`   ${d.id} [${d.status}/问${d.ask}] ${d.bad.join('；')}  ← ${String(d.q).slice(0, 40)}`);
  if (dirty.length > 50) console.log(`   …另 ${dirty.length - 50} 条，见 --json`);
  if (!dirty.length) console.log('   ✅ 全部是「位置＋卷面原文＋能照着念的问句」');
  else console.log('   改写走：node _待确认.mjs 改问题 --id Txxx --q "三段式全文" --note "为什么改"（自动留痕 questionBefore）');
  process.exit(live.length ? 1 : 0);
} else if (action === '去黑话') {
  /* 批量把 question/detail/qRef 里的黑话按 JARGON 表换成大白话，仍走同一留痕字段。
   * 只动给人看的三个字段；verdictNote/dispositionNote 是给我自己看的，不碰。 */
  const j = load();
  let n = 0, skipped = 0;
  for (const it of j.items) {
    if (opt.id && it.id !== opt.id) continue;
    let changed = [];
    for (const f of ['question', 'detail', 'qRef']) {
      const old = String(it[f] || '');
      if (!old || !jargonHits(old).length) continue;
      const neu = deJargon(old);
      if (neu === old) continue;
      it[f] = neu;
      const tag = `${today()} ${f === 'question' ? '问题' : f === 'detail' ? '详情' : '题号'}文本 ${old.length} → ${neu.length} 字：去内部黑话（答案键→标准答案 等，见 _待确认.mjs JARGON 表）`;
      if (f === 'question') it.questionFix = tag; else if (f === 'detail') it.detailFix = tag; else it.qRefFix = tag;
      /* BUG-10（2026-10-11）：批量改写原先**原地覆盖、原文不留存**——而这是自动替换（不是人逐条确认），
         一旦替换表有误就把原始表述永久抹掉。现在把改写前的原文落库（每字段只留最近一次）。 */
      if (f === 'question') it.questionBefore = old; else if (f === 'detail') it.detailBefore = old; else it.qRefBefore = old;
      changed.push(f);
    }
    if (!changed.length) { skipped++; continue; }
    n++;
    console.log(`   ${it.id} 改写 ${changed.join('/')}：${String(it.question).slice(0, 46)}`);
  }
  if (opt.dry || !opt.apply) {
    console.log(`\n[dry] 命中 ${n} 条、无变化 ${skipped} 条——加 --apply 才落库`);
    process.exit(0);
  }
  save(j);
  console.log(`\n已去黑话 ${n} 条（留痕在 questionFix/detailFix/qRefFix）`);
  render();
} else {
  console.error('未知动作：' + action);
  console.error('可用：清单 / 加 / 定位 / 答 / 作废 / 撤回 / 删 / 改问题 / 改详情 / 纠因 / 候选 / 修订 / 采用 / 作废候选 / 状态 / 门禁 / 证据 / 措辞 / 去黑话 / 同步 / 判定 / 处置');
  console.error('  纠因 --id Txxx --why "为什么纠正（原话）" [--scope 卡|配方|流程] [--target <包/卡标识>]  ← 追加式留痕，同 why 幂等');
  console.error('  候选 --id Txxx --kind 卡|配方|流程 --target <卡号/配方id/流程名> --payload "<正文>" | --payload-file <文件>  ← 修订草案，同内容复用同一 candId');
  console.error('  修订 --id Txxx [--json]  ← 只读：候选 + 修订链 + 现值（卡→错题记录.md / 配方→recipes/<id>/prompt.md）');
  console.error('  采用 --id Txxx --candidate <candId> [--dry]  ← **正式写入入口**：持锁 + 事务落 _修订\\<kind>\\<目标>\\<candId>.md，并追加 revisions[]');
  console.error('  作废候选 --id Txxx --candidate <candId>  ← 把还没进库的候选标「已作废」（已采用/已作废 ⇒ 退出码 3）');
  console.error('  判定 --id Txxx --verdict "错|对|部分对|无法判定|不适用" --note "依据"  ← 将结论换算成对错，必填');
  console.error('  处置 --id Txxx --as "无需处置|已补建卡|已撤卡|已核销|待人工" [--note "..."]  ← 结论之后的后续动作，必填');
  console.error('  措辞 [--json] / 去黑话 --dry|--apply  ← 给人看的文本禁用内部黑话（答案键→标准答案 等）');
  process.exit(2);
}
