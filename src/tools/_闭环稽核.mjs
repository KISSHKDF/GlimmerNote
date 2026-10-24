#!/usr/bin/env node
/**
 * 错题本 · 待办闭环稽核器（v1，2026-10-09）
 *
 * 五段闭环的**第四段**：应做动作 = f(verdict, 该题在册与否)，全部机器算，不许人肉记。
 * 规范见《错题本系统方案.md》§四之十一；起因见教训 L-332。
 *
 *   错/部分对 + 不在册  → 应「补建卡」
 *   对        + 在册    → 应「撤卡」
 *   对/错     + 状态已对 → 「无需处置」
 *   无法判定             → 「待人工」（不得静默结案）
 *
 * 「在册与否」的判定要点：台账 cardId 用**扫描页**（p42），索引 source 用**印刷页**（第030页），
 * 两者是不同键空间 —— 必须经 `_work-*​/转录/pNN.md` 页头映射后再按「页+题号」比对（L-331 同族）。
 *
 * 用法：node _闭环稽核.mjs [--json] [--all]
 *   默认只看「已确认」条目；--all 连未确认的一起列（未确认显示"等结论"）。
 *   退出码：有 RED（应做动作与已登记处置不符）或 未判定/未处置 → 1；全闭环 → 0。
 */
import fs from 'fs';
import path from 'path';
import { readJsonStrict } from './_安全写.mjs';
import { libraryRoot } from './_库根.mjs';

/* BUG-15（2026-10-11）：本文件原先把 5 处 JSON 读取写成裸 `JSON.parse(fs.readFileSync(p,'utf8'))`，
   JSON.parse 不容忍 BOM ⇒ 真源被任何带 BOM 的通道（PowerShell `Set-Content -Encoding UTF8` 等）
   改写过一次，稽核器就会**响亮地**报错退出（这点比另外三处静默失败好，但仍然是假 RED）。
   统一走 `_安全写.mjs` 的 `readJsonStrict`：剥 BOM + 解析失败给出恢复途径，与其余工具同源。 */
const readJson = f => readJsonStrict(f);

/* ★ 2026-10-23 程序与数据分家：ROOT 是**库根**（数据），不是工具目录。
   原先是 `path.dirname(fileURLToPath(import.meta.url))`，工具搬进 <AppRoot>\tools\ 之后
   那样算出来是程序目录 ⇒ 索引 / _撤卡留档 / _待确认.json 全读不到，稽核会对着空库报绿。 */
const ROOT = libraryRoot();
const JSON_OUT = process.argv.includes('--json');
const SHOW_ALL = process.argv.includes('--all');

/* ---------- 1. 扫描页 → 印刷页 映射（扫所有 _work-* 的 转录/pNN.md 页头） ---------- */
const pageMap = {};   // '学生A|物理|p42' -> 30
for (const d of fs.readdirSync(ROOT)) {
  if (!/^_work-/.test(d)) continue;
  const tdir = path.join(ROOT, d, '转录');
  if (!fs.existsSync(tdir)) continue;
  for (const f of fs.readdirSync(tdir).filter(x => /^p\d+\.md$/.test(x))) {
    const t = fs.readFileSync(path.join(tdir, f), 'utf8');
    const m = t.match(/^#\s*(p\d+)\s*·\s*第(\d+)页/);
    if (m) pageMap[m[1]] = Number(m[2]);
  }
}

/* ---------- 2. 在册卡（**两套索引**） + 已撤卡留档 ---------- */
/* 2026-10-09 实证：库里是**两套并列真源** —— `九年级/_索引.json`（student=学生A，学科数学/物理/化学/英语/语文）
   与 `七年级-学生B/数学/_索引.json`（student=学生B，subject=数学）。两边的卡号都从 M0001 起编，
   **卡号同名但不同题**（例：学生A M0026=新函数性质漏答；学生B M0026=数轴距离漏负号）。
   只读一套会把「学生B M0026 已建卡」误判成「没建」——本工具初版就踩了（T010 假 RED）。
   故必须按 (student, 卡号) 配对；索引顶层 `student` 字段就是配对键。 */
const INDEXES = [
  { file: path.join(ROOT, '九年级', '_索引.json'), base: path.join(ROOT, '九年级') },
  { file: path.join(ROOT, '七年级-学生B', '数学', '_索引.json'), base: path.join(ROOT, '七年级-学生B', '数学') },
];
const allCards = [];
for (const spec of INDEXES) {
  if (!fs.existsSync(spec.file)) continue;
  const ix = readJson(spec.file);
  const stu = ix.student || '';
  const subj = ix.subject || '';
  const groups = ix.subjects ? Object.keys(ix.subjects).map(k => [k, ix.subjects[k].items || []]) : [[subj, ix.items || []]];
  for (const [s, items] of groups) {
    for (const c of items) allCards.push({ ...c, _subj: s || subj, _stu: stu, _base: spec.base });
  }
}
const byKey = new Map(allCards.map(c => [c._stu + '|' + c.id, c]));
const byId = new Map(allCards.map(c => [c.id, c]));      // 兼容：单键查找（可能重名，取后到者）
const printedPage = s => { const m = String(s || '').match(/第(\d+)页/); return m ? Number(m[1]) : null; };
const qnoOf = s => { const m = String(s || '').match(/第(\d+)题/); return m ? m[1] : null; };

/* 卡的**权威扫描页**来自卡片目录的 `_task.json`（page 字段，形如 p41）。
   为什么不能用 `source` 推：实测 source 的页码口径**不统一**——60 页批次的卡记的是**扫描页**
   （P0046 source=第41页，扫描 p41，实际印刷第29页），而 P0057 记的是**印刷页**（第042页，扫描 p54）。
   用 source 猜会同时匹配到 P0036（印刷第29页第2题）与 P0046（扫描 p41 第2题），题号还都是 2 —— 直接错配。
   `_task.json.page` 无歧义，故以它为准；缺 _task.json 的卡退回 source 双口径匹配。 */
const cardScan = new Map();     // '学生|卡号' -> { scan, qno }
for (const c of allCards) {
  /* 卡片目录的真实位置是 <索引基目录>/<学科>/<dir>（如 九年级/物理/P0046-…），
     不是 <索引基目录>/<dir>。漏掉学科这一层 → _task.json 找不到 → 退回用 source 猜页码 →
     把 P0057（扫描 p54）猜成 p42，于是 T059（p42-13）被错配到它、判成「应撤卡」。
     故两个位置都试，找不到才退回 source（退回口径见下）。 */
  const cands = [
    path.join(c._base, c._subj, c.dir, '_task.json'),
    path.join(c._base, c.dir, '_task.json'),
  ];
  let scan = null, qno = null;
  for (const tp of cands) {
    if (!fs.existsSync(tp)) continue;
    try {
      const t = readJson(tp);
      scan = t.page || null;
      qno = String(t.no || '').match(/^\d+/)?.[0] || null;
    } catch (e) {}
    if (scan) break;
  }
  if (!scan) { const m = String(c.source || '').match(/第(\d+)页/); if (m) scan = 'p' + Number(m[1]); }
  if (!qno) qno = qnoOf(c.source);
  cardScan.set(c._stu + '|' + c.id, { scan, qno, printed: printedPage(c.source) });
}

/* 撤卡留档：两套键都要能命中（2026-10-10 修）
 * 起因：按「待办回话为准」撤了 P0021/P0022/P0034 三张伪错题卡后，稽核器反而报 RED——
 *   ① 旧代码把留档卡存成**裸卡号**键（retracted.set(id,…)），查的时候却用 `学生|卡号`
 *      （retracted.get(key(id))），两套键空间永不相交 → wasRetracted 恒为 false（L-331 同族）；
 *   ② 就算查到了也没用：卡已不在册 → hasCard=false → required('对',false) 返回「无需处置」，
 *      而下面那条 `req === '撤卡' && wasRetracted` 的 GREEN 分支要求 req 是「撤卡」，根本进不去。
 * 现在：撤销记录.json（含 student/id）优先存 `学生|id`；老记录（只有 card.json、无学生字段）
 *   退化成裸卡号键并在查询时兜底命中。 */
const retracted = new Map();
const putRetired = (key, val) => { if (key) retracted.set(key, val); };
const retDir = path.join(ROOT, '_撤卡留档');
if (fs.existsSync(retDir)) {
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/撤销记录\.json$/.test(e.name)) {
        try {
          const c = readJson(fp);
          const idm = String(c.id || '').match(/([MPCYE]\d{4})/) || String(path.dirname(fp)).match(/([MPCYE]\d{4})/);
          const id = idm && idm[1];
          if (!id) continue;
          const stu = String(c.student || (c.entry && c.entry.student) || '');
          putRetired(stu ? `${stu}|${id}` : id, { ...c, _retractedFrom: fp });
        } catch (e) {}
      } else if (/^card\.json$/i.test(e.name)) {
        try {
          const c = readJson(fp);
          const idm = String(c.id || '').match(/([MPCYE]\d{4})/);
          const dirId = String(path.dirname(fp)).match(/([MPCYE]\d{4})/);
          const id = (idm && idm[1]) || (dirId && dirId[1]);
          // 老留档没有学生字段：只补空，不覆盖撤销记录.json 的精确键
          if (id && !retracted.has(id)) retracted.set(id, { ...c, _retractedFrom: fp });
        } catch (e) {}
      }
    }
  };
  walk(retDir);
}
const findRetired = (stu, id) => retracted.get(`${stu}|${id}`) || retracted.get(id) || null;

/* ---------- 3. 台账 ---------- */
const ledger = readJson(path.join(ROOT, '_待确认.json'));
const items = ledger.items || [];
const open = it => it.status === '未确认';

/* ---------- 4. 题身份 → 在册卡 ---------- */
const CARD_RE = /^([MPCYE]\d{4})/;
function resolve(it) {
  const cid = String(it.cardId || '').trim();
  const key = id => (it.student || '') + '|' + id;
  // (a) cardId 直接是卡号 → 必须按 (学生, 卡号) 配对（两套索引卡号重名）
  const m1 = CARD_RE.exec(cid);
  if (m1) {
    const hit = byKey.get(key(m1[1]));
    return { kind: 'byId', cards: hit ? [hit] : [], retracted: findRetired(it.student || '', m1[1]) };
  }
  // (b) 「（未入卡）」等
  if (!/^p\d+-/.test(cid)) return { kind: 'noRef', cards: [], retracted: null };
  // (c) pNN-<题号>：台账的 pNN 是**扫描页**，故按「扫描页 + 题号」在卡片的 _task.json 口径上比对
  const pm = /^(p\d+)-(.+)$/.exec(cid);
  const scan = pm[1];
  const seg = pm[2].split(/\s*·\s*/).map(x => x.trim());
  const qno = seg.find(x => /^\d+$/.test(x));
  const printed = pageMap[scan] ?? null;
  if (!qno) return { kind: 'unmapped', cards: [], retracted: null, scan, qno: null, printed };
  const cards = allCards.filter(c => {
    if (c._subj !== it.subject) return false;
    if (it.student && c._stu && c._stu !== it.student) return false;
    const cs = cardScan.get(c._stu + '|' + c.id);
    return cs && cs.scan === scan && cs.qno === qno;
  });
  return { kind: 'byPage', cards, retracted: null, scan, qno, printed };
}

/* ---------- 5. 应做动作 f(verdict, 在册与否) ---------- */
function required(verdict, hasCard) {
  if (verdict === '无法判定') return '待人工';
  // 非题目类（系统维护/纯笔迹归属追责）：判的对象不存在，但**动作可能仍存在**
  // （例：T024 要求重裁 4 张低饱和截图，实测至今没做）。故不给"自动无需处置"，
  // 而是要求显式核销——必须有人写下「做了什么」才算闭环。
  if (verdict === '不适用') return '已核销';
  if (verdict === '错' || verdict === '部分对') return hasCard ? '无需处置' : '补建卡';
  if (verdict === '对') return hasCard ? '撤卡' : '无需处置';
  return '待人工';
}
function closed(requiredAction, disp) {
  if (!disp) return false;
  if (requiredAction === '补建卡') return disp === '已补建卡';
  if (requiredAction === '撤卡') return disp === '已撤卡' || disp === '已核销';
  if (requiredAction === '无需处置') return disp === '无需处置' || disp === '已核销';
  if (requiredAction === '已核销') return disp === '已核销';
  if (requiredAction === '待人工') return disp === '待人工' || disp === '已核销';
  return false;
}

/* ---------- 6. 逐条稽核 ---------- */
const rows = [];
for (const it of items) {
  if (!SHOW_ALL && open(it)) continue;
  // 已作废 = 终局（问题本身被撤回），不要求判定与后续动作；但保留在册可见（--all 时列出）
  if (it.status === '已作废') {
    rows.push({ id: it.id, student: it.student, subject: it.subject, cardId: it.cardId, kind: it.kind,
      verdict: it.verdict || '', inLedger: false, retracted: false, cards: [], resolveKind: 'void',
      scan: null, printed: null, qno: null, required: '—', disposition: it.disposition || '',
      state: 'VOID', why: '已作废（终局，无需判定与后续动作）' });
    continue;
  }
  const r = resolve(it);
  const inLedger = r.cards.length > 0;
  const wasRetracted = !!r.retracted;
  // 撤卡留档里的卡：视为「曾经在册、现已撤」→ 对 verdict=对 是已完成状态
  const hasCard = inLedger;
  const v = it.verdict || '';
  const req = open(it) ? '等结论' : required(v, hasCard);
  let state, why;
  if (open(it)) { state = 'OPEN'; why = '待确认（等结论）'; }
  else if (!v) { state = 'RED'; why = '结论已落库但**没做判定**（五段闭环第 3 段缺）'; }
  else if (it.disposition === '待人工') {
    // 待人工 = 动作已认定、但需外部条件（重拍照 / 看纸质原卷）。既不是"忘了做"也不是"做完了"——
    // 单独成一类：可见但不计 RED（RED 只留给"该做却没做"）。
    state = 'BLOCKED'; why = `应做「${req}」但挂待人工（需外部条件）`;
  }
  else if (v === '对' && wasRetracted && !inLedger) {
    /* 判定「对」且卡确实已撤进留档 = 动作已完成（旧代码因 req 已变「无需处置」而永远进不到这条） */
    const from = r.retracted && r.retracted._retractedFrom ? path.basename(path.dirname(r.retracted._retractedFrom)) : '_撤卡留档';
    if (it.disposition === '已撤卡' || it.disposition === '已核销') {
      state = 'GREEN'; why = `判定「对」，该题曾建卡、现已撤入留档（${from}），无需再撤`;
    } else {
      state = 'RED'; why = `判定「对」、卡已撤入留档（${from}），但处置没登记成「已撤卡」（实际「${it.disposition || '（空）'}」）`;
    }
  }
  else if (closed(req, it.disposition)) { state = 'GREEN'; why = `判定「${v}」→ 应做「${req}」，已登记「${it.disposition}」`; }
  else { state = 'RED'; why = `判定「${v}」→ 应做「${req}」，实际登记「${it.disposition || '（空）'}」`; }
  rows.push({
    id: it.id, student: it.student, subject: it.subject, cardId: it.cardId, kind: it.kind,
    verdict: v, inLedger, retracted: wasRetracted, cards: r.cards.map(c => c.id),
    resolveKind: r.kind, scan: r.scan || null, printed: r.printed ?? null, qno: r.qno || null,
    required: req, disposition: it.disposition || '', state, why,
  });
}

/* ---------- 7. 输出 ---------- */
const by = s => rows.filter(r => r.state === s);
if (JSON_OUT) { console.log(JSON.stringify({ rows, summary: { total: rows.length, green: by('GREEN').length, red: by('RED').length, blocked: by('BLOCKED').length, open: by('OPEN').length, void: by('VOID').length } }, null, 1)); process.exit(by('RED').length ? 1 : 0); }

const g = by('GREEN'), rd = by('RED'), op = by('OPEN'), vd = by('VOID'), bl = by('BLOCKED');
console.log(`待办闭环稽核：${rows.length} 条  ｜  闭环 ${g.length} / 未闭环 ${rd.length} / 待外部 ${bl.length} / 待结论 ${op.length} / 已作废 ${vd.length}\n`);
if (bl.length) { console.log(`── 待外部条件（${bl.length}）`); for (const r of bl) console.log(`  ${r.id}  ${r.student}/${r.subject} ${r.cardId}  ${r.why}`); console.log(''); }
if (rd.length) {
  console.log(`── 未闭环（${rd.length}）`);
  for (const r of rd) console.log(`  ${r.id}  ${r.student}/${r.subject} ${r.cardId}  ${r.why}${r.cards.length ? '  在册:' + r.cards.join('/') : ''}`);
  console.log('');
}
if (op.length) { console.log(`── 待结论（${op.length}）：${op.map(r => r.id).join(', ')}\n`); }
if (g.length) {
  console.log(`── 已闭环（${g.length}）`);
  for (const r of g) console.log(`  ${r.id}  ${r.cardId}  ${r.why}`);
}
process.exit(rd.length ? 1 : 0);
