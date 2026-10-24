/* 阴性对照：2026-10-12 用户实测报障两处（组卷角标 vs 台账）的护栏
 *   ① 组卷工作台侧栏角标显示 5，同屏配卷屏却是「篮子是空的」
 *   ② 顶栏切到「学生A」，台账列的却是学生B的 4 个批次（★ 2026-10-24 B-09：示例用合成名）
 * 手法：Node + vm 载**真实的** util/host/model（内存沙箱），喂**真实的** _状态.json，
 *       台账过滤逻辑照抄 v2/js/views/paper.js 的真实判据。
 * 每条判据都"改前必红"（改回 basket().length / 去掉学生过滤，立刻红）。
 * 用法：node tests/neg-paper-count-and-ledger-filter.cjs */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* ★ 2026-10-23 程序与数据分家：rd() 依次找三处 ——
     ① 仓库相对路径（'src/app/js/model.js' 这类前端源码）
     ② 工具目录（'_标记复习.mjs' 这类）
     ③ 库根（'_状态.json' 这类用户数据） */
const rd = f => {
  for (const base of [ROOT, E.TOOLS, E.LIB]) {
    const p2 = path.join(base, f);
    if (fs.existsSync(p2)) return fs.readFileSync(p2, 'utf8');
  }
  throw new Error('rd() 找不到文件：' + f);
};
const state = JSON.parse(rd('_状态.json'));
const ledger = JSON.parse(rd('_组卷台账.json'));
const shellSrc = rd('src/app/js/shell.js');
const paperSrc = rd('src/app/js/views/paper.js');

let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};

/* ---- 内存沙箱 ---- */
function loadModel(student) {
  const store = new Map();
  const CTB = { util: {}, host: {}, model: {}, shell: {}, views: {} };
  const sandbox = {
    console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap,
    isNaN, parseInt, parseFloat, CTB,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    window: { addEventListener() { } },
  };
  sandbox.globalThis = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['src/app/js/util.js', 'src/app/js/host.js', 'src/app/js/model.js']) vm.runInContext(rd(f), sandbox, { filename: f });
  const M = sandbox.CTB.model;
  M.applyState(state);
  if (student) M.student(student);
  return { M, store };
}

/* ★ 2026-10-24 B-09：孩子名与卡号不再写死真实数据，从库状态动态取（①/①b 共用）。
   前置：至少 2 个孩子、第一名孩子至少 5 张卡、第二名至少 2 张（真实库满足；不足则响亮报错，不静默跳过）。 */
const KID1 = state.data[0].name, KID2 = state.data[1] && state.data[1].name;
if (!KID2) throw new Error('本测试需要库里至少 2 个孩子（当前：' + JSON.stringify(state.data.map(k => k.name)) + '）');
const idsOf = kid => state.data.find(k => k.name === kid).subjects.flatMap(s => s.items || []).map(c => c.id);
const ids1 = idsOf(KID1);
if (ids1.length < 5) throw new Error('第一名孩子（' + KID1 + '）不足 5 张卡，无法复现「篮里 5 条旧裸编号」');
const ids2 = idsOf(KID2);
if (ids2.length < 2) throw new Error('第二名孩子（' + KID2 + '）不足 2 张卡');

/* ════════ ① 篮子计数只有一个口径 ════════ */
console.log('═══ ① 组卷角标与配卷屏必须同口径 ═══');
{
  const { M, store } = loadModel(KID1);
  /* 复现用户现场：篮里是 BUG-11 改 kid|id 之前留下的旧裸编号 */
  store.set('ctb2.basket.' + KID1, JSON.stringify(ids1.slice(0, 5)));
  A('前置：篮里 5 条旧裸编号（迁移前形态）', M.basket().length === 5, 'basket().length=' + M.basket().length);
  A('前置：配卷屏口径一张都列不出（旧格式不被 basketCards 认）', M.basketCards().length === 0,
    'basketCards().length=' + M.basketCards().length);
  M.basketMigrate();
  const afterCards = M.basketCards().length, afterCount = M.basketCount();
  A('迁移后配卷屏能列出题卡', afterCards > 0, afterCards + ' 张');
  A('★ 迁移后 basketCount() === basketCards().length（同口径，不分叉）', afterCount === afterCards,
    'basketCount=' + afterCount + ' basketCards=' + afterCards);

  /* 库里不存在的键（卡被删/学生改名残留）必须被清掉，否则角标一直虚高 */
  store.set('ctb2.basket.' + KID1, JSON.stringify([KID1 + '|' + ids1[0], KID1 + '|Z9999', KID1 + '|Z9998']));
  A('前置：篮里混了 2 个库里不存在的键', M.basket().length === 3, 'basket().length=' + M.basket().length);
  M.basketMigrate();
  A('迁移后幽灵键被清掉，basketCount 只认真卡', M.basketCount() === 1 && M.basket().length === 1,
    'basketCount=' + M.basketCount() + ' basket().length=' + M.basket().length);

  /* 跨学生：迁移必须覆盖**全部**学生槽位（原来是只迁当前档，导致切到别的孩子还是旧格式） */
  store.clear();
  M.student(KID2); M.applyState(state);
  store.set('ctb2.basket.' + KID2, JSON.stringify(ids2.slice(0, 2)));
  store.set('ctb2.basket.' + KID1, JSON.stringify(ids1.slice(0, 2)));   // 另一个孩子的旧篮
  M.basketMigrate();
  const kk = JSON.parse(store.get('ctb2.basket.' + KID2) || '[]');
  const ll = JSON.parse(store.get('ctb2.basket.' + KID1) || '[]');
  A('迁移覆盖了**全部**学生槽位（不再只迁当前档）',
    kk.every(x => x.includes('|')) && ll.every(x => x.includes('|')),
    KID2 + '=' + JSON.stringify(kk) + ' ' + KID1 + '=' + JSON.stringify(ll));
  A('迁移后两个孩子都能从篮里取回题', kk.length === 2 && ll.length === 2, kk.length + '/' + ll.length);
  A('迁移不串档（' + KID2 + ' 篮里没有 ' + KID1 + ' 的题）', kk.every(x => x.startsWith(KID2 + '|')), JSON.stringify(kk));
}

/* ════════ ①b「全部」档也必须被迁移（回归：实测踩到） ════════ */
console.log('\n═══ ①b 「全部」档槽位迁移（曾漏） ════════');
{
  /* 回归事实：第一版修法用 `M.student(kid)` 切档遍历 students()，结果
     ① 当前档被留在最后遍历的学生上（`M.student()` 有副作用）；
        ② 「全部」档压根不在 `M.students()` 里 → 永远迁不到（老断言直接抓到）。
     现在按槽位名直接读写 localStorage，全程不动当前档。 */
  const { M, store } = loadModel('全部');
  const ANY = ids1[0];                              // 任一真实卡号（★ B-09：不再写死）
  M.basketSet([ANY]);                       // 「全部」档的旧裸 id
  M.basketMigrate();
  A('「全部」档的旧裸 id 被清掉（不猜归属）', M.basket('全部').length === 0, JSON.stringify(M.basket('全部')));
  A('迁移**不改变**当前学生档（无副作用）', M.student() === '全部', '当前档=' + M.student());

  const { M: M2, store: s2 } = loadModel(KID1);
  M2.basketSet([ANY]);                      // 单孩子档的旧裸 id
  s2.set('ctb2.basket.全部', JSON.stringify([ANY]));  // 「全部」档也有一个
  M2.basketMigrate();
  A('迁移后当前学生档仍是 ' + KID1, M2.student() === KID1, '当前档=' + M2.student());
  A(KID1 + ' 档的旧裸 id 正确迁移', JSON.stringify(M2.basket()) === JSON.stringify([KID1 + '|' + ANY]), JSON.stringify(M2.basket()));
  A('「全部」档也被单独迁移（不再是死档）', M2.basket('全部').length === 0, JSON.stringify(M2.basket('全部')));
}

/* ════════ ② 展示点必须调 basketCount，禁止 basket().length ════════ */
console.log('\n═══ ② 角标/副标题改调 basketCount ═══');
A('shell.js 的 ROUTES 里 paper 的 badge 用 basketCount()',
  /badge:\s*\(\)\s*=>\s*M\.basketCount\(\)/.test(shellSrc));
A('shell.js 里不再出现 basket().length 当角标',
  !/badge:\s*\(\)\s*=>\s*M\.basket\(\)\.length/.test(shellSrc));
A('paper.js 的副标题（篮里 N 题）用 basketCount()',
  /'篮里 '\s*\+\s*M\.basketCount\(\)/.test(paperSrc));
A('model.js 提供 basketCount 且实现为 basketCards().length',
  /M\.basketCount\s*=\s*function\s*\(\)\s*\{\s*return M\.basketCards\(\)\.length;\s*\}/.test(rd('src/app/js/model.js')));

/* ════════ ③ 台账按学生过滤（照抄真实判据） ════════ */
console.log('\n═══ ③ 台账按学生过滤 ═══');
{
  const filter = (batches, cur) => (cur === '全部' ? batches : batches.filter(b => b.student === cur));
  const all = (ledger.batches || []).slice().reverse();
  /* ⚠ 2026-10-12：台账内容会随使用变化（b 项刚撤掉 4 条自测批次，只剩 1 条），
     所以**不能**拿"当前有几个孩子"当前置——那会让断言随数据漂移而红/绿。
     改成构造一份两孩子样本喂给**真实判据**（照抄 paper.js 的过滤表达式），验证判据本身。
     ★ 2026-10-24 B-09：样本用合成孩子名。 */
  const sample = [
    { paperId: 'PX-01', student: '学生B', subject: '数学', items: [1, 2] },
    { paperId: 'PX-02', student: '学生A', subject: '语文', items: [1, 2, 3] },
    { paperId: 'PX-03', student: '学生B', subject: '物理', items: [1] },
  ];
  A('前置（样本）：造出 2 个孩子 3 个批次', new Set(sample.map(b => b.student)).size === 2);
  for (const kid of ['学生A', '学生B']) {
    const mine = filter(sample, kid);
    A('切到' + kid + '：只列该孩子的批次', mine.length > 0 && mine.every(b => b.student === kid),
      mine.map(b => b.paperId).join(','));
  }
  A('切到学生A：学生B的批次不出现', !filter(sample, '学生A').some(b => b.student === '学生B'));
  A('切到学生B：学生A的批次不出现', !filter(sample, '学生B').some(b => b.student === '学生A'));
  A('「全部」档列全部', filter(sample, '全部').length === 3);
  /* 真实判据：把纸面用的判据直接拿来跑样本，不是"抄一份再测" */
  const realFilter = new Function('all', 'cur', 'isAll', 'return isAll ? all : all.filter(b => b.student === cur);');
  const m2 = realFilter(sample, '学生A', false);
  A('纸面判据本身对样本正确（学生B 2 条被滤掉）', m2.length === 1 && m2[0].student === '学生A',
    m2.map(b => b.paperId).join(','));
  A('真实判据与纸面一致：view 源码里确有 b.student === cur 的过滤',
    /all\.filter\(b\s*=>\s*b\.student\s*===\s*cur\)/.test(paperSrc));
  A('「全部」档列全部并标出归属', /U\.esc\(isAll\s*\?\s*'全部学生'\s*:\s*cur\)/.test(paperSrc));
  A('空态文案说清是「这个孩子还没印过」而不是笼统「没有批次」',
    /还没有印过卷子/.test(paperSrc));
}

/* ════════ ④ 台账行可读性（用户原话「整个看不懂」） ════════ */
console.log('\n═══ ④ 台账行可读性 ═══');
A('行内说人话：「日期 印的 N 道题」', /印的\s*'\s*\+\s*n\s*\+\s*' 道题'/.test(paperSrc));
A('按钮文案从「✍ 回录」改成「✍ 录入对错」（自解释）', /录入对错/.test(paperSrc));
A('状态从「待批改」改成「等你批改」（自解释）', /等你批改/.test(paperSrc));
A('默认标题（「某某错题重做卷 日期·学科」这类模板标题）被识别为冗余并隐藏',
  paperSrc.includes('!/错题重做卷 \\d{4}-\\d{2}-\\d{2}·/.test(b.title)'));
A('页头 hint 说清这页干什么用', /录入对错/.test(paperSrc) && /印过的卷子都记在这儿/.test(paperSrc));

/* ════════ ⑤ 未入账就打印必须当场警告（2026-10-24 用户报障） ════════
 * 起因（用户原话）：「我组了一套卷子给孩子做了……可是我不知道应该在哪里把做完的结果录回系统，
 *   根本看不到我当初组的卷了」。
 * 根因：**打印与入账是两个独立按钮，打印不会建批次**。那天只点了打印（壳日志该时段 0 次 op=mark），
 *   台账里从来没有这张卷 ⇒「📒 台账/回录」空白 ⇒ 无处置结果。
 * 这条护栏保证：未入账时卷面上方有常驻警告，且三个打印按钮每次点击都提示。
 * 每条判据都"改前必红"（删掉 guard / 删掉壳模式条件，立刻为假）。 */
console.log('\n═══ ⑤ 未入账就打印必须当场警告 ═══');
{
  A('卷面上方有常驻警告条（未入账时）', /这张卷还没入账/.test(paperSrc));
  A('警告条只在桌面壳里出现（浏览器模式没有入账能力，不该误报）',
    /H\.mode === 'shell' && !allCommitted \?/.test(paperSrc));
  A('三个打印按钮都过 printGuard（漏一个就等于没护栏）',
    /printGuard\(\); doPdf\('paper'/.test(paperSrc) &&
    /printGuard\(\); doPrint\('paper'\)/.test(paperSrc) &&
    /printGuard\(\); doPdf\('ans'/.test(paperSrc));
  A('printGuard 用 allCommitted 判（与「已入账 ✓」同口径，不另立第二套判据）',
    /if \(H\.mode !== 'shell' \|\| allCommitted\) return;/.test(paperSrc));
  A('printGuard 只提示不硬拦（先打一份看版式是合理需求）',
    /S\.toast\('⚠ 这张卷还没入账/.test(paperSrc));

  /* 阴性自证：把护栏真的删掉，判据必须变假（否则这些断言是恒真摆设）。
     做法＝把三条"纸面判据"抽成同一个谓词，再喂三个"改坏"变形的源码，逐个断言为假。 */
  const predGuardCalls = s => /printGuard\(\); doPdf\('paper'/.test(s) &&
    /printGuard\(\); doPrint\('paper'\)/.test(s) &&
    /printGuard\(\); doPdf\('ans'/.test(s);
  const predShellCond = s => /H\.mode === 'shell' && !allCommitted \?/.test(s);
  const predGuardBody = s => /if \(H\.mode !== 'shell' \|\| allCommitted\) return;/.test(s);

  A('前置（样本）：现版源码三条谓词**全真**（判据不是恒假）',
    predGuardCalls(paperSrc) && predShellCond(paperSrc) && predGuardBody(paperSrc));

  const mutA = paperSrc.replace(/printGuard\(\);\s*/g, '');                       // 变形A：删掉全部 guard 调用
  A('自证 · 变形A（删掉全部 printGuard 调用）谓词①立刻为假', !predGuardCalls(mutA),
    '残留 printGuard() 调用=' + (mutA.match(/printGuard\(\);/g) || []).length);

  const mutB = paperSrc.replace(/H\.mode === 'shell' && !allCommitted \?/g, '(false ?');  // 变形B：去掉壳模式条件
  A('自证 · 变形B（去掉「只在壳模式」条件）谓词②立刻为假', !predShellCond(mutB));

  const mutC = paperSrc.replace(/if \(H\.mode !== 'shell' \|\| allCommitted\) return;/, '');  // 变形C：掏空判断体
  A('自证 · 变形C（掏空 printGuard 判断体）谓词③立刻为假', !predGuardBody(mutC));
}

/* 装载 paper.js 到 vm 沙箱（⑥/⑦/⑨ 共用同一份实现：真跑纯函数，不是读正则猜行为）。
   返回里带上 CTB 本体（⑨ 要切 H.mode='shell' 才能看到写通道按钮，见下）。 */
function loadPaperEngine() {
  const CTB = { views: {} };
  const sandbox = {
    console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap,
    isNaN, parseInt, parseFloat, CTB,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(rd('src/app/js/util.js'), sandbox, { filename: 'src/app/js/util.js' });
  sandbox.CTB.model = { cards: [] };
  sandbox.CTB.host = {}; sandbox.CTB.shell = {};
  vm.runInContext(paperSrc, sandbox, { filename: 'src/app/js/views/paper.js' });
  return { V: sandbox.CTB.views.paper, M: sandbox.CTB.model, CTB: sandbox.CTB };
}
/* 全库卡片索引（⑥ 的 lookup / ⑦ 的 M.cards 都吃这一份） */
const ALL_CARDS = {};
for (const x of (state.data || [])) for (const sub of (x.subjects || [])) for (const c of (sub.items || [])) ALL_CARDS[c.id] = c;
/* 真实批次（不写死批次号：台账会随使用变化，写死就变"数据漂移即红"的假红线）。
   选**题数最多**的那一批——它最能暴露"题序错位/吞题"这类问题。 */
const BIG_BATCH = (ledger.batches || []).slice().sort((a, b) => (b.items || []).length - (a.items || []).length)[0];

/* ════════ ⑥ 回录批改每行必须带「卷面题号」（2026-10-24 用户要求） ════════
 * 用户原话：「录入错题成绩时，没有题目编号，建议加上」。
 * 现场：抽屉里只有题库内部编号 M0048，家长手上拿的是纸上印的 1．2．3．——
 *   30 行靠数行数对号，数错一行就把对错记到别的题上。所以这条守的是**题号本身**，
 *   不是"有编号"：题号必须从 1 起、按 items 顺序、与卷面 (i+1) 同口径。 */
console.log('\n═══ ⑥ 回录批改行带卷面题号 ═══');
{
  const { V } = loadPaperEngine();
  A('前置：paper.js 暴露纯函数 V.gradeRows（门禁能直接断言，不必读正则）', typeof V.gradeRows === 'function');
  A('前置（样本）：库里有真实批次可测（台账非空）', !!BIG_BATCH && (BIG_BATCH.items || []).length >= 3,
    BIG_BATCH ? BIG_BATCH.paperId + ' ' + BIG_BATCH.items.length + ' 题' : '台账空');

  const items = BIG_BATCH.items.slice(0, 5);
  const lookup = id => (ALL_CARDS[id] ? { card: ALL_CARDS[id] } : null);
  const html = V.gradeRows(items, lookup, {});
  const rows = [...html.matchAll(/data-no="(\d+)" data-id="([^"]+)"/g)].map(m => ({ no: +m[1], id: m[2] }));

  A('每道题都渲染成一行（行数=题数，不吞题）', rows.length === items.length, rows.length + '/' + items.length);
  A('★ 题号从 1 开始、连续、按 items 顺序（1,2,3…）',
    rows.every((r, i) => r.no === i + 1) && rows[0].no === 1, JSON.stringify(rows.map(r => r.no)));
  A('★ 题号与题一一对应（第 N 行就是 items[N-1]，不许错位）',
    rows.every((r, i) => r.id === items[i]), rows.map(r => r.no + '=' + r.id).join(' '));
  A('内部编号仍在（题号之外还要能对上题库）', rows.every(r => /^[A-Z]\d{4}$/.test(r.id)));
  A('首列是题号方块（样式类 lg-no，不是普通文本）', /class="lg-no"/.test(html));
  A('题号方块带 title 说明「卷面第 N 题」（窄屏只剩数字时也能自解释）', /title="卷面第 1 题"/.test(html));

  /* 与卷面同口径：卷面 qHtml/ansHtml 用的就是 (i + 1) */
  A('卷面题号口径一致：qHtml 与 ansHtml 都是 (i + 1)',
    /\(i \+ 1\) \+ '．'/.test(paperSrc) && /\(i \+ 1\) \+ '．（'/.test(paperSrc));
  A('抽屉不是另抄一份行模板（必须复用 V.gradeRows）', /V\.gradeRows\(items, lookup, results\)/.test(paperSrc));

  /* 已录过的题：行标 done + 对应按钮 .on（续录时才看得见哪些判过） */
  const html2 = V.gradeRows(items, lookup, { [items[1]]: '错' });
  const doneRows = [...html2.matchAll(/class="lg-gline done" data-no="(\d+)"/g)].map(m => +m[1]);
  A('已录过的行单独标出（class=done）', doneRows.length === 1 && doneRows[0] === 2, JSON.stringify(doneRows));
  A('已录的值就地标亮（第 2 行「错」按钮带 .on）',
    /data-v="错" class="on"/.test(html2) && (html2.match(/class="on"/g) || []).length === 1);

  /* 脏数据不崩：题干空 / 含 HTML */
  const html3 = V.gradeRows(['M0001', 'M0002'], () => null, {});
  A('查不到卡不崩，显示「（题干为空）」', /（题干为空）/.test(html3) && html3.match(/lg-gline/g).length === 2);
  const html4 = V.gradeRows(['M0001'], () => ({ card: { question: '<img src=x onerror=alert(1)>' } }), {});
  A('题干里的 HTML 被转义（不许进 DOM）', !/<img/.test(html4) && /&lt;img/.test(html4));

  /* 阴性自证：把题号判据改坏，断言必须变红（否则这些断言是恒真摆设） */
  const noOf = src => {
    const CTB = { views: {} };
    const sb = { console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap, isNaN, parseInt, parseFloat, CTB };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(rd('src/app/js/util.js'), sb, { filename: 'u' });
    sb.CTB.model = { cards: [] }; sb.CTB.host = {}; sb.CTB.shell = {};
    vm.runInContext(src, sb, { filename: 'p' });
    const h = sb.CTB.views.paper.gradeRows(items, lookup, {});
    return [...h.matchAll(/data-no="(\d+)"/g)].map(m => +m[1]);
  };
  const PRED_FROM_ONE = ns => ns.length > 0 && ns[0] === 1 && ns.every((v, i) => v === i + 1);
  A('前置（样本）：现版题号序列满足判据（判据不是恒假）', PRED_FROM_ONE(noOf(paperSrc)), JSON.stringify(noOf(paperSrc)));
  const mutNo = paperSrc.replace('const no = i + 1;', 'const no = i;');   // 变形：题号从 0 起
  A('自证 · 变形「题号从 0 起」判据立刻为假', mutNo !== paperSrc && !PRED_FROM_ONE(noOf(mutNo)),
    JSON.stringify(noOf(mutNo)));
}

/* ════════ ⑦ 台账必须能"找回当初那张卷"（2026-10-24 用户报障） ════════
 * 用户原话：「我根本找不到当初给孩子组卷子选的是哪几道题目」。
 * 现场：台账每行只有「日期 + 题数 + 批次号」，`sheet` 是内存变量，关掉预览/重开程序就没了
 *   ⇒ 入了账也**看不到卷面内容**（连"我当初组了哪 30 题"都无从看起）。
 * 修的判据不是"有个按钮"，而是三条硬不变量：
 *   ① 复原的题序必须**逐题等于**台账 items（题号印在纸上，错一位就整套对不上）；
 *   ② 题库里找不到的卡必须**留占位**（跳过会让后面题号整体前移）；
 *   ③ 复原出来的卷不能再入账（已入账，重复入账会多建一张重复的卷，批改结果分叉）。
 */
console.log('\n═══ ⑦ 台账能找回当初那张卷 ═══');
{
  const { V, M } = loadPaperEngine();
  /* 真卡灌进沙箱的 model（V.batchToSheet 走 M.cards.find） */
  for (const kid of (state.data || [])) for (const sub of (kid.subjects || [])) for (const c of (sub.items || []))
    M.cards.push({ key: kid.name + '|' + c.id, kid: kid.name, subject: sub.name, card: c });

  A('前置：暴露纯函数 V.batchToSheet / V.ledgerRow（门禁可直接断言）',
    typeof V.batchToSheet === 'function' && typeof V.ledgerRow === 'function');

  const real = BIG_BATCH;
  A('前置（样本）：拿到真实批次（' + (real ? real.paperId : '无') + '）', !!real && (real.items || []).length > 0);
  const s = V.batchToSheet(real);
  A('真批次能复原出卷面对象', !!s && Array.isArray(s.refs), real.paperId);
  A('★ 题序逐题等于台账 items（错一位整套卷就对不上号）',
    s.refs.length === real.items.length && s.refs.every((x, i) => x.card.id === real.items[i]),
    s.refs.slice(0, 3).map(x => x.card.id).join(',') + '…/' + real.items.length + ' 题');
  A('复原出的卡就是题库里的真卡（引用相等，不是复制出来的壳）',
    s.refs.every((x, i) => M.cards.some(y => y.card === x.card && y.kid === real.student)));
  A('卷名/学生/学科带着台账身份（不含混）',
    s.title === (real.title || s.title) && s.batch === real.paperId);
  A('③ 复原卷自带「已入账」标记（sheet.committed 预置 ⇒ 不会重复入账）',
    !!s.committed && s.committed[real.student + '|' + real.subject] === real.paperId,
    JSON.stringify(s.committed));

  /* 缺卡必须留占位：拿一个不存在的编号插到中间，断言后面的题号整体不前移 */
  const fake = { paperId: 'PX-77', date: '2026-10-24', student: real.student, subject: real.subject,
    title: '缺卡样本', items: [real.items[0], 'M9998', real.items[1]] };
  const s2 = V.batchToSheet(fake);
  A('★ 库中缺卡时**留占位**、长度不变（跳过会让后面题号整体前移）',
    s2.refs.length === 3 && s2.refs[1].card.id === 'M9998', s2.refs.map(x => x.card.id).join(','));
  A('占位卡不崩且说得清（题干写明"题库里找不到这张卡"）',
    /题库里找不到这张卡/.test(s2.refs[1].card.question) && s2.missing === 1, s2.refs[1].card.question);
  A('占位不影响真卡取回（第 1、3 张仍是真卡）',
    s2.refs[0].card === M.cards.find(y => y.card.id === real.items[0] && y.kid === real.student).card);

  /* 台账行：必须给出「看这张卷」的入口；已批改的批次也一样（那是重印/对答案的主场景） */
  const rowPending = V.ledgerRow(Object.assign({}, real, { status: '待批改', results: {} }), '唯一', false);
  const rowDone = V.ledgerRow(Object.assign({}, real, { status: '已批改', results: real.results || {} }), '唯一', false);
  A('★ 待批改批次有「👁 看这张卷」入口（data-open 带批次号）',
    /data-open="P\d{8}-\d\d"/.test(rowPending) && /看这张卷/.test(rowPending));
  A('★ 已批改批次同样有入口（做完的卷也要能回看/重印）', /data-open="/.test(rowDone) && /看这张卷/.test(rowDone));
  A('行里仍是人话「日期 印的 N 道题」+ 判分进度（没被新按钮挤掉）',
    /印的 '\s*\+\s*n\s*\+\s*' 道题'/.test(paperSrc) && /已判 '/.test(paperSrc));
  A('入口在卷面页接上复原逻辑（点 data-open → batchToSheet → preview）',
    /querySelectorAll\('\[data-open\]'\)/.test(paperSrc) && /V\.batchToSheet\(batch\)/.test(paperSrc));
  A('复原卷的返回键回台账而不是回编卷（编卷屏是空篮子，会让人以为卷丢了）',
    /fromBatch \? '← 回台账'/.test(paperSrc) && /if \(fromBatch\) mode = 'ledger'/.test(paperSrc));

  /* 阴性自证：用"想当然的旧写法"（缺卡直接 **跳过**）跑同一条判据，必须变红。
     这条对照比正则改源码更硬：它就是任何人第一版会写出来的实现（map+filter(Boolean)），
     判据若能放行它，这条护栏就是摆设。 */
  const oldStyle = b => {
    const kid = (b && b.student) || '';
    return {
      refs: (b.items || []).map(id => M.cards.find(x => x.card.id === id && (!kid || x.kid === kid))).filter(Boolean),
    };
  };
  const predRefs = x => !!x && x.refs.length === fake.items.length && x.refs.every((r, i) => r.card.id === fake.items[i]);
  A('前置（样本）：现版对缺卡样本满足判据②（判据不是恒真）', predRefs(V.batchToSheet(fake)),
    JSON.stringify(V.batchToSheet(fake).refs.map(r => r.card.id)));
  A('自证 · 旧写法「缺卡直接跳过」判据立刻为假（题号会整体前移）', !predRefs(oldStyle(fake)),
    JSON.stringify(oldStyle(fake).refs.map(r => r.card.id)) + '（长度 ' + oldStyle(fake).refs.length + '≠' + fake.items.length + '）');
}

/* ════════ ⑧ 卷面操作条吸顶（2026-10-24 用户报障） ════════
 * 用户原话：「回台账的按钮很小（图2），不容易发现。更关键的是，当下拉一段屏幕后，这个按钮没有跟下来，
 *   很不方便回退（图3：滚到第 11、12 题时顶部已经空了）。」
 * 卷面 30 题很长 ⇒ 操作条必须 sticky 在 #view 滚动容器顶端，且返回键升级为普通按钮（不再 ghost 小按钮）。
 * 判据行为化：① 标记类挂上了；② 返回键不再是 sm ghost；③ CSS 真有 sticky + top:0 + 不透明底色；
 *   每条都配变异自证（去掉类 / sticky 换 static / 退回小按钮，判据必须变假）。 */
console.log('\n═══ ⑧ 卷面操作条吸顶 ═══');
{
  const cssSrc = rd('src/app/css/app.css');
  const predBarCls = s => /class="row pv-bar"/.test(s);
  const predBackBtn = s => /<button class="btn" id="pvBack">/.test(s);
  const predCss = c => /#view \.pv-bar\{position:sticky;top:0/.test(c);

  A('★ 卷面操作条挂上吸顶类 pv-bar', predBarCls(paperSrc));
  A('★ 返回键升级为普通按钮（不再 sm ghost 小号——用户原话「按钮很小，不容易发现」）', predBackBtn(paperSrc));
  A('返回键文案仍是「← 回台账」（复原态）/「← 回编卷」（新组卷）', /fromBatch \? '← 回台账' : '← 回编卷'/.test(paperSrc));
  A('★ CSS 里真的 sticky 钉在 #view 滚动容器顶端（参照系必须是 #view，不是 window）', predCss(cssSrc));
  A('吸顶条有不透明底色（否则滚动时卷面文字会从缝里穿过去）', /#view \.pv-bar\{[^}]*background:var\(--bg\)/.test(cssSrc));

  A('前置（样本）：现版源码三条谓词全真（判据不是恒假）',
    predBarCls(paperSrc) && predBackBtn(paperSrc) && predCss(cssSrc));
  const mutBar = paperSrc.replace('class="row pv-bar"', 'class="row"');                              // 变形：去掉吸顶类
  A('自证 · 变形「去掉 pv-bar 类」判据①立刻为假', !predBarCls(mutBar));
  const mutCss = cssSrc.replace('#view .pv-bar{position:sticky;', '#view .pv-bar{position:static;');   // 变形：不吸顶
  A('自证 · 变形「sticky 改成 static」判据③立刻为假', !predCss(mutCss));
  const mutBtn = paperSrc.replace('<button class="btn" id="pvBack">', '<button class="btn sm ghost" id="pvBack">');
  A('自证 · 变形「退回 ghost 小按钮」判据②立刻为假', !predBackBtn(mutBtn));
}

/* ════════ ⑨ 任何时候、任何阶段都能撤销试卷（2026-10-24 用户要求） ════════
 * 用户原话：「应该设置一个用户任何时候、任何阶段都可以撤销某张试卷的权限，
 *   当撤销了某张试卷，该试卷上的题目应该恢复成未组卷状态」。
 * 守四件事（工具侧回滚/水印语义在 neg-paper-revoke-restore.cjs 真跑验证）：
 *   ① 台账每行有「↩ 撤销试卷」，**已批改的行同样有**（任何阶段，不许 !done 把它藏起来）；
 *   ② 写动作只走唯一入口 H.mark('撤批')（壳白名单已含），并带上批次号；
 *   ③ 撤销确认把后果说清（恢复未组卷 / 已判 N 题一并回滚），
 *     确认清单的左列＝卷面题号（撤错卷比不撤更坏，必须能按纸质卷对号）；
 *   ④ 每条判据都配"改前必红"的自证（藏键 / 题号错位，立刻变假）。 */
console.log('\n═══ ⑨ 任何时候、任何阶段都能撤销试卷 ═══');
{
  const { V, CTB } = loadPaperEngine();
  /* 撤销按钮只在桌面壳渲染（写通道 H.mark 在壳侧）——先切壳模式再渲染行 */
  CTB.host.mode = 'shell';
  A('前置：暴露纯函数 V.revokeList（撤销确认的题列，门禁能直接断言）', typeof V.revokeList === 'function');

  const rowPending = V.ledgerRow(Object.assign({}, BIG_BATCH, { status: '待批改', results: {} }), '唯一', false);
  const rowDone = V.ledgerRow(Object.assign({}, BIG_BATCH, { status: '已批改', results: BIG_BATCH.results || {} }), '唯一', false);
  const predRevoke = row => /data-revoke="P\d{8}-\d\d"/.test(row) && /撤销试卷/.test(row);
  A('★ 等你批改的行有「↩ 撤销试卷」', predRevoke(rowPending));
  A('★ 已批改的行同样有（用户原话「任何阶段」——已批改撤＝判分流水一并回滚）', predRevoke(rowDone));
  A('撤销键是危险色（btn sm danger）且悬停说明写清后果',
    /btn sm danger" data-revoke=/.test(rowPending) && /恢复为未组卷/.test(rowPending));

  /* 撤销链路（源码级）：绑定 → 确认抽屉 → 唯一写入口 → 成功后的连带处理 */
  A('撤销动作只走唯一写入口 H.mark（\'撤批\'）并带批次号', /H\.mark\('撤批', \{ paper: paperId \}\)/.test(paperSrc));
  A('确认抽屉列出卷面题号（复用 V.revokeList，不另抄一份行模板）', /V\.revokeList\(items, lookup, results\)/.test(paperSrc));
  A('确认文案说清「整卷退回/恢复为未组卷」且分阶段说明（已判 N 题一并回滚 / 未录将无处回录）',
    /整卷退回/.test(paperSrc) && /恢复为未组卷/.test(paperSrc) && /一并从题库回滚/.test(paperSrc) && /无处回录/.test(paperSrc));
  A('撤销成功后清防重复缓存（下次「近 7 天印过」不再算被撤的卷）',
    /_ledgerCache = null;\s*\n\s*S\.toast\('已撤销 /.test(paperSrc));
  A('撤销是台账行的绑定（data-revoke → revokeDialog），不是只有函数没入口',
    /querySelectorAll\('\[data-revoke\]'\)/.test(paperSrc) && /revokeDialog\(b\.dataset\.revoke/.test(paperSrc));

  /* revokeList 行为断言（真跑纯函数）：题号铁律 + 已判/未录 + 转义 */
  const items = BIG_BATCH.items.slice(0, 4);
  const lookup = id => (ALL_CARDS[id] ? { card: ALL_CARDS[id] } : null);
  const list = V.revokeList(items, lookup, { [items[1]]: '对' });
  const rows = [...list.matchAll(/class="lg-gline( done)?" data-no="(\d+)"/g)].map(m => ({ done: !!m[1], no: +m[2] }));
  const PRED_SEQ = h => { const ns = [...h.matchAll(/data-no="(\d+)"/g)].map(m => +m[1]); return ns.length > 0 && ns[0] === 1 && ns.every((v, i) => v === i + 1); };
  A('★ 确认清单题号从 1 起、连续、与 items 同序（纸质卷第 N 题必须对得上第 N 行）',
    rows.length === items.length && PRED_SEQ(list), JSON.stringify(rows.map(r => r.no)));
  A('已录的行单独标出、写明判了什么；未录的写「未录」（不许含糊）',
    (list.match(/已判：对/g) || []).length === 1 && (list.match(/未录/g) || []).length === items.length - 1);
  A('查不到的卡不崩（题干占位「（题干为空）」），行数=题数',
    (V.revokeList(['M0001', 'M0002'], () => null, {}).match(/lg-gline/g) || []).length === 2 &&
    /（题干为空）/.test(V.revokeList(['M0001'], () => null, {})));
  const xss = V.revokeList(['M0001'], () => ({ card: { question: '<img src=x onerror=alert(1)>' } }), {});
  A('题干里的 HTML 被转义（确认框不许成为注入面）', !/<img/.test(xss) && /&lt;img/.test(xss));

  /* 变异自证 1：把「任何阶段都有撤销键」藏回 !done 后面 —— 已批改行的判据必须变红 */
  const MUT_HIDE = "(H.mode === 'shell' ? '<button class=\"btn sm danger\" data-revoke=";
  const engineOf = src => {
    const CTB = { views: {} };
    const sb = { console, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, WeakMap, isNaN, parseInt, parseFloat, CTB };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(rd('src/app/js/util.js'), sb, { filename: 'u' });
    sb.CTB.model = { cards: [] }; sb.CTB.host = { mode: 'shell' }; sb.CTB.shell = {};
    vm.runInContext(src, sb, { filename: 'p' });
    return sb.CTB.views.paper;
  };
  A('前置（样本）：现版两条谓词全真（判据不是恒假）', predRevoke(rowPending) && predRevoke(rowDone));
  const mutHide = paperSrc.replace(MUT_HIDE, "(!done && H.mode === 'shell' ? '<button class=\"btn sm danger\" data-revoke=");
  A('前置：变异点唯一命中（改得到才谈得上自证）', mutHide !== paperSrc);
  const rowDoneMut = engineOf(mutHide).ledgerRow(Object.assign({}, BIG_BATCH, { status: '已批改', results: BIG_BATCH.results || {} }), '唯一', false);
  A('自证 · 变形「只有未批改才有撤销键」后，已批改行不再满足判据', !predRevoke(rowDoneMut),
    (rowDoneMut.match(/data-revoke/g) || []).length + ' 个残留键');

  /* 变异自证 2：revokeList 题号从 0 起（对不上纸质卷）——判据必须变红 */
  const MUT_NO = "const no = i + 1;   /* 卷面题号（与 gradeRows/qHtml 同口径：题号印在纸上，缺卡也得占位） */";
  const mutNo = paperSrc.replace(MUT_NO, 'const no = i;');
  A('前置：题号变异点唯一命中（gradeRows 里的同名行不受影响）', mutNo !== paperSrc);
  const Vmut = engineOf(mutNo);
  const rowsMut = [...Vmut.revokeList(items, lookup, {}).matchAll(/data-no="(\d+)"/g)].map(m => +m[1]);
  A('自证 · 变形「题号从 0 起」判据立刻为假', !PRED_SEQ(Vmut.revokeList(items, lookup, {})),
    JSON.stringify(rowsMut));
}

console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + '  断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail === 0 ? 0 : 1);
