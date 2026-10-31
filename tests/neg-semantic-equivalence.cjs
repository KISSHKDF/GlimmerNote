#!/usr/bin/env node
/**
 * 拾光小册 · E02 阴性对照：「语义等价」判据必须真的抓得住数据损坏（2026-10-31 建）
 *
 * 事故（外部复核已证实）：
 *   `tests\run.mjs` 用来"允许写路径测试改动真源"的等价判据太宽 —— 它只取**几个字段**：
 *     · 台账 `paperLedgerSemantic`：paperId / status / items（**还先 sort 了**）/ results
 *     · 索引 `indexSemantic`：reviewStatus / reviewCount / nextDue / errorCount / passStreak /
 *       reviews.length —— 光看长度，不看内容
 *   实测 22 项扰动里 **11 项真损坏被判等价**，含：删某卡的 `answerSlots`、改 `reviews[].result`、
 *   改批次 `student/subject/date`、换题目顺序。
 *   为什么这很严重：这条判据是"真库零写入"红线唯一的放宽口。它一宽，"业务内容确实没变"这句话
 *   就成了空话 —— 任何写路径缺陷都能被它洗成绿。
 *
 * 修法（E02）：**递归键规范化后全量比对**（对象键排序、数组保序），显式例外只有两处，
 *   且都是"摘掉后单独做单调性检查"而不是"忽略"：
 *     ① `_组卷台账.json` 的 `paperSeq` —— 水印设计上只增不复用（撤批也不回退）；
 *     ② `_索引.json` 的 `updatedAt` —— 派生时间戳，批改/撤批必刷成今天；只允许**变新**。
 *   其余一切业务字段逐键比对。
 *
 * 本用例的牙齿（三条缺一不可）：
 *   ① 逐项构造"只改一个业务字段"的变体，**每一种都必须判不等价**（要求里点名的 8 项一个不落）；
 *   ② 正向用例必须仍然判等价（键序打乱 / paperSeq 增大 / updatedAt 变新），否则修法变成"恒红"；
 *   ③ 把**旧判据原样搬进来**做对照：那些扰动旧判据必须判"等价" ——
 *      既证明本用例确实复现了原缺陷，也证明"改窄判据"才是修复本体。
 *
 * 用法：node tests\neg-semantic-equivalence.cjs
 * 退出码：0=PASS（含阴性自证）/ 1=FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const E = require('./_测试环境.cjs');
const LEDGER = '_组卷台账.json';
const INDEX = '九年级/_索引.json';

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

console.log('测试环境：' + E.describe());
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-sem-'));

/** 写两份文件后跑判据：before = 原始，after = 扰动后 */
function eqAfter(rel, mutate) {
  const before = JSON.stringify(BASE[rel], null, 1);
  const doc = JSON.parse(before);
  mutate(doc);
  const a = path.join(base, 'before-' + Math.random().toString(36).slice(2) + '.json');
  const b = path.join(base, 'after-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(a, before, 'utf8');
  fs.writeFileSync(b, JSON.stringify(doc, null, 1), 'utf8');
  return E.semanticallyEqual(rel, a, b);
}

/* ══════════ 夹具：形状按真库实测（台账 batches[] / 索引 subjects→学科→items[]）══════════ */
const BASE = {
  [LEDGER]: {
    note: '组卷/复习批次台账',
    schema: { paperId: 'P{yyyyMMdd}-{序号}', status: '待批改 | 已批改 | 已作废' },
    batches: [
      {
        paperId: 'P20261031-07', date: '2026-10-31', student: '合成甲', subject: '数学',
        title: '数学 · 回归卷', items: ['M0001', 'M0002', 'M0003'], status: '已批改',
        results: { M0001: '对', M0002: '半对', M0003: '错' },
        gradedAt: '2026-10-31', source: 'e2e', note: '测毕撤批',
      },
      {
        paperId: 'P20261030-03', date: '2026-10-30', student: '合成乙', subject: '英语',
        title: '英语 · 词汇卷', items: ['E0001', 'E0002'], status: '待批改',
        results: {}, gradedAt: '', source: '界面', note: '',
      },
    ],
    paperSeq: { P20261030: 3, P20261031: 7 },
  },
  [INDEX]: {
    student: '合成甲', grade: '九年级', note: '', updatedAt: '2026-10-31',
    subjects: {
      数学: {
        items: [
          {
            id: 'M0001', dir: 'M0001-一元二次', answerMode: 'lines', answerSlots: ['x=1', 'x=2'],
            answerSource: '独立判卷+红笔一致', kpoints: ['一元二次', '判别式'],
            reviewStatus: '已复习·通过', reviewCount: 1, passStreak: 1, errorCount: 1,
            nextDue: '2026-11-07', blindStatus: '已通过',
            reviews: [{ date: '2026-10-31', result: '对', paper: 'P20261031-07' }],
          },
          {
            id: 'M0002', dir: 'M0002-判别式', answerMode: 'blank', answerSlots: ['Δ=4'],
            answerSource: '独立判卷修正', kpoints: ['判别式'],
            reviewStatus: '已复习·半对', reviewCount: 1, passStreak: 0, errorCount: 1,
            nextDue: '2026-11-03', blindStatus: '已通过',
            reviews: [{ date: '2026-10-31', result: '半对', paper: 'P20261031-07' }],
          },
        ],
      },
    },
  },
};

/* ══════════ ① 逐项扰动：只改一个业务字段 ⇒ 必须判**不等价** ══════════
 * 注释里标 ★ 的是要求里点名必须覆盖的那几项。 */
console.log('\n══ ① 单字段业务扰动：每一种都必须判不等价（旧判据会放行的都在这里）══');
const LEDGER_CASES = [
  ['★ 删批次的 date', d => { delete d.batches[0].date; }],
  ['★ 改批次的 student', d => { d.batches[0].student = '合成丙'; }],
  ['★ 改批次的 subject', d => { d.batches[0].subject = '物理'; }],
  ['★ 换题目顺序（items 顺序是印刷顺序，不能 sort 掉）', d => { d.batches[0].items = ['M0003', 'M0001', 'M0002']; }],
  ['★ 改批次 status', d => { d.batches[0].status = '待批改'; }],
  ['★ 改 results 里某题的值', d => { d.batches[0].results.M0002 = '对'; }],
  ['删 results 里某一题', d => { delete d.batches[0].results.M0003; }],
  ['改 batch.title（卷面标题，印在纸上）', d => { d.batches[0].title = '数学 · 另一张卷'; }],
  ['改 batch.note', d => { d.batches[0].note = ''; }],
  ['改 batch.source', d => { d.batches[0].source = '工具'; }],
  ['删一整个批次', d => { d.batches.pop(); }],
  ['加一个批次', d => { d.batches.push({ paperId: 'P20261031-08', items: [], results: {}, status: '待批改' }); }],
  ['改 schema 说明文本（契约文档也是文件内容）', d => { d.schema.status = '待批改 | 已批改'; }],
];
for (const [what, mut] of LEDGER_CASES) A('台账 · ' + what + ' ⇒ 不等价', eqAfter(LEDGER, mut) === false);

const INDEX_CASES = [
  ['★ 删某卡的 answerSlots', d => { delete d.subjects.数学.items[0].answerSlots; }],
  ['★ 改 answerSlots 里某个空位的答案', d => { d.subjects.数学.items[0].answerSlots = ['x=1', 'x=9']; }],
  ['★ 改 reviews[].result（只改长度看不出这个）', d => { d.subjects.数学.items[0].reviews[0].result = '错'; }],
  ['★ 改 reviewStatus', d => { d.subjects.数学.items[0].reviewStatus = '已复习·再错'; }],
  ['★ 改顶层 student', d => { d.student = '合成乙'; }],
  ['★ 换 items 顺序（换题序）', d => { d.subjects.数学.items.reverse(); }],
  ['删一张卡', d => { d.subjects.数学.items.pop(); }],
  ['改 answerMode（作答方式影响卷面留白）', d => { d.subjects.数学.items[1].answerMode = 'lines'; }],
  ['改 answerSource（答案第二来源）', d => { d.subjects.数学.items[0].answerSource = '仅红笔'; }],
  ['改 kpoints 数组顺序', d => { d.subjects.数学.items[0].kpoints = ['判别式', '一元二次']; }],
  ['改 blindStatus', d => { d.subjects.数学.items[0].blindStatus = '未盲解'; }],
  ['改 reviewCount', d => { d.subjects.数学.items[0].reviewCount = 2; }],
  ['改 nextDue', d => { d.subjects.数学.items[0].nextDue = '2026-12-01'; }],
  ['改 errorCount', d => { d.subjects.数学.items[0].errorCount = 2; }],
  ['reviews 元素多一个字段（同长度不同内容）', d => { d.subjects.数学.items[0].reviews[0].paper = 'P20261030-03'; }],
  ['改 grade', d => { d.grade = '八年级'; }],
];
for (const [what, mut] of INDEX_CASES) A('索引 · ' + what + ' ⇒ 不等价', eqAfter(INDEX, mut) === false);

/* 业务字段之外：非白名单文件一律不参与语义放行（fail-closed） */
console.log('\n══ ② 非白名单文件：不允许任何"语义等价"放行 ══');
const otherFile = path.join(base, 'other.json');
fs.writeFileSync(otherFile, JSON.stringify({ a: 1 }), 'utf8');
A('未登记的文件类型（_待确认.json 等）⇒ 一律不等价（fail-closed）',
  E.semanticallyEqual('_待确认.json', otherFile, otherFile) === false);
A('读不懂的 JSON（花括号没闭合）⇒ 不等价，不许抛错',
  (() => {
    const bad = path.join(base, 'bad.json');
    fs.writeFileSync(bad, '{"files":', 'utf8');
    return E.semanticallyEqual(LEDGER, bad, otherFile) === false;
  })());

/* ══════════ ③ 正向用例：设计内的变化必须仍然判等价 ══════════ */
console.log('\n══ ③ 正向：设计内的变化（键序 / paperSeq / updatedAt）必须仍判等价 ══════════');
/** 用"重新序列化但内容等价"的方式造正向样本：键序打乱 + 值不变 */
function eqWith(rel, mut) {
  const before = JSON.parse(JSON.stringify(BASE[rel]));
  const after = JSON.parse(JSON.stringify(BASE[rel]));
  mut(after);
  const a = path.join(base, 'p-a-' + Math.random().toString(36).slice(2) + '.json');
  const b = path.join(base, 'p-b-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(a, JSON.stringify(before), 'utf8');
  fs.writeFileSync(b, JSON.stringify(after), 'utf8');
  return E.semanticallyEqual(rel, a, b);
}
A('台账 · paperSeq 增大（水印只增不复用）⇒ 等价',
  eqWith(LEDGER, d => { d.paperSeq.P20261031 = 8; }) === true);
A('台账 · 新增一个 paperSeq 日期键 ⇒ 等价',
  eqWith(LEDGER, d => { d.paperSeq.P20261101 = 1; }) === true);
A('★ 台账 · paperSeq **变小**（水印回退）⇒ 不等价（这是"只增不减"的另一半）',
  eqWith(LEDGER, d => { d.paperSeq.P20261031 = 6; }) === false);
A('★ 台账 · paperSeq 某个已用过的键被删掉 ⇒ 不等价（等价于回退到 0）',
  eqWith(LEDGER, d => { delete d.paperSeq.P20261031; }) === false);
A('索引 · updatedAt 前进（批改/撤批必刷今天）⇒ 等价',
  eqWith(INDEX, d => { d.updatedAt = '2026-11-01'; }) === true);
A('★ 索引 · updatedAt 回退 ⇒ 不等价（时间戳只进不退）',
  eqWith(INDEX, d => { d.updatedAt = '2026-10-01'; }) === false);
A('对象键序打乱（同一份内容换序列化顺序）⇒ 等价',
  (() => {
    const a = path.join(base, 'k-a.json'), b = path.join(base, 'k-b.json');
    const doc = BASE[INDEX];
    fs.writeFileSync(a, JSON.stringify(doc), 'utf8');
    /* 手写一个键序完全反过来的等价 JSON */
    const rev = {};
    for (const k of Object.keys(doc).reverse()) rev[k] = doc[k];
    fs.writeFileSync(b, JSON.stringify(rev), 'utf8');
    return E.semanticallyEqual(INDEX, a, b) === true;
  })());
A('数组保序：把 items 换成同样元素但顺序不同 ⇒ 不等价（数组语义是有序的，不能像对象那样排序）',
  eqWith(INDEX, d => { d.subjects.数学.items = [d.subjects.数学.items[1], d.subjects.数学.items[0]]; }) === false);
A('canonValue 只规范化不丢信息（同一份文档两次规范化结果相同）',
  JSON.stringify(E.canonValue(BASE[INDEX])) === JSON.stringify(E.canonValue(JSON.parse(JSON.stringify(BASE[INDEX])))));

/* ══════════ ④ 阴性自证：把**旧判据**原样搬进来，同样的扰动必须被判"等价" ══════════
 * 这一段是本用例的根：它证明 ① 里那些红不是"随便什么都在红"，而是**旧的宽判据真的会放行**。 */
console.log('\n══ ④ 阴性自证：旧判据（挑几个字段 / items 还先 sort）在这些扰动上必须判等价 ══');
function oldPaperLedgerSemantic(doc) {
  const B = (doc && doc.batches) || [];
  return B.map(b => ({
    paperId: b.paperId || '',
    status: b.status || '',
    items: (b.items || []).slice().sort(),                  // ← 旧判据把题序 sort 掉了
    results: Object.keys(b.results || {}).sort().map(k => k + '=' + JSON.stringify(b.results[k])),
  })).sort((a, b) => a.paperId.localeCompare(b.paperId));
}
function oldIndexSemantic(doc) {
  const out = [];
  const pick = c => {
    if (!c || typeof c !== 'object') return;
    const id = c.id || c.cardId || c.card_id || '';
    if (!id) return;
    out.push(id + '|' + JSON.stringify([
      c.reviewStatus ?? c.status ?? '', c.reviewCount ?? c.rc ?? '',
      c.nextDue ?? c.next_due ?? '', c.errorCount ?? c.ec ?? '',
      c.passStreak ?? c.ps ?? '',
      Array.isArray(c.reviews) ? c.reviews.length : (c.reviews ?? 0),   // ← 只看长度
    ]));
  };
  const subs = doc && doc.subjects;
  if (subs && typeof subs === 'object') {
    for (const s of Object.values(subs)) { if (s && Array.isArray(s.items)) s.items.forEach(pick); }
    return out.sort();
  }
  if (Array.isArray(doc && doc.items)) { doc.items.forEach(pick); return out.sort(); }
  return out.sort();
}
function oldEqual(rel, mutate) {
  const before = JSON.parse(JSON.stringify(BASE[rel]));
  const after = JSON.parse(JSON.stringify(BASE[rel]));
  mutate(after);
  if (rel === LEDGER) return JSON.stringify(oldPaperLedgerSemantic(before)) === JSON.stringify(oldPaperLedgerSemantic(after));
  return JSON.stringify(oldIndexSemantic(before)) === JSON.stringify(oldIndexSemantic(after));
}
A('自证 · 旧判据对「换题序」判等价（这正是实测漏掉的 11 项之一）',
  oldEqual(LEDGER, d => { d.batches[0].items = ['M0003', 'M0001', 'M0002']; }) === true);
A('自证 · 旧判据对「改批次 student」判等价',
  oldEqual(LEDGER, d => { d.batches[0].student = '合成丙'; }) === true);
A('自证 · 旧判据对「改批次 subject」判等价',
  oldEqual(LEDGER, d => { d.batches[0].subject = '物理'; }) === true);
A('自证 · 旧判据对「删批次 date」判等价',
  oldEqual(LEDGER, d => { delete d.batches[0].date; }) === true);
A('自证 · 旧判据对「删 answerSlots」判等价',
  oldEqual(INDEX, d => { delete d.subjects.数学.items[0].answerSlots; }) === true);
A('自证 · 旧判据对「改 reviews[].result」判等价（只看 reviews 长度）',
  oldEqual(INDEX, d => { d.subjects.数学.items[0].reviews[0].result = '错'; }) === true);
A('自证 · 旧判据对「换 items 顺序」判等价',
  oldEqual(INDEX, d => { d.subjects.数学.items.reverse(); }) === true);
A('自证 · 旧判据对「改 answerMode」判等价',
  oldEqual(INDEX, d => { d.subjects.数学.items[1].answerMode = 'lines'; }) === true);
A('自证 · 旧判据对「改 errorCount → 只改 reviews 内容」仍判等价（长度没变）',
  oldEqual(INDEX, d => { d.subjects.数学.items[0].reviews[0].date = '2026-10-01'; }) === true);
/* 反向对照：新判据在**同样这些**扰动上必须是 false —— 这才是"改窄"的直接证据 */
A('对照 · 同样这些扰动，新判据全部判不等价（改窄生效）',
  [eqAfter(LEDGER, d => { d.batches[0].items = ['M0003', 'M0001', 'M0002']; }),
   eqAfter(LEDGER, d => { d.batches[0].student = '合成丙'; }),
   eqAfter(LEDGER, d => { delete d.batches[0].date; }),
   eqAfter(INDEX, d => { delete d.subjects.数学.items[0].answerSlots; }),
   eqAfter(INDEX, d => { d.subjects.数学.items[0].reviews[0].result = '错'; }),
   eqAfter(INDEX, d => { d.subjects.数学.items.reverse(); })].every(x => x === false),
  '仍有扰动被判等价');

/* ══════════ ⑤ run.mjs 必须用这份判据，且旧实现已删除 ══════════ */
console.log('\n══ ⑤ run.mjs 接线与旧实现清理 ══');
const runSrc = fs.readFileSync(path.join(E.REPO, 'tests', 'run.mjs'), 'utf8');
A('run.mjs 调用统一判据 E.semanticallyEqual', /E\.semanticallyEqual\(/.test(runSrc), '');
A('run.mjs 里已删掉旧的 paperLedgerSemantic（不再有两套等价定义）',
  !/function paperLedgerSemantic/.test(runSrc), '');
A('run.mjs 里已删掉旧的 indexSemantic', !/function indexSemantic/.test(runSrc), '');
A('判据本体在 _测试环境.cjs（可被用例直接调用），而不是埋在 run.mjs 里',
  /function semanticallyEqual/.test(fs.readFileSync(path.join(E.REPO, 'tests', '_测试环境.cjs'), 'utf8')), '');

console.log('\n──────────────────────────────');
try { fs.rmSync(base, { recursive: true, force: true }); } catch { }
console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
process.exit(worst === 0 ? 0 : 1);
