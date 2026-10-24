#!/usr/bin/env node
/**
 * 错题本·复习台账工具（v1.7）—— 复习状态唯一写入入口
 *
 * 闭环：组卷入账 →(打印给孩子)→ 纸质重做 →(拍照回传)→ 批改回录 → 状态自动流转 → 连对2次已掌握 → 归档出池
 * 铁律（专业错题系统通行做法）：
 *   1) 错题只改状态、永不删行（主表 _索引.json + 明细 reviews[]，批次另存 _组卷台账.json）；
 *   2) 单次做对不算掌握（防蒙对）——连对 2 次才「已掌握」；
 *   3) 重做再错 → 错误次数 +1、连对清零、建议复习日回到最短档 1 天；
 *   4) nextDue 仅为「建议复习日」（1→3→7→15→30→60→90），不排期、不推送（a2 精神不变）。
 *   5) 【盲解准入·v1.8 铁律】所有错题必须先盲解一次、结果与录入 answer 一致（blindStatus
 *      已通过/已修正）才准进组卷池——录入者自证有盲区，解题视角才能抓出转录错误。
 *      工具：_盲解复核.mjs（清稿/录入/批量/状态/门禁）；本文件负责在组卷口做硬门禁。
 *
 * 用法（node _标记复习.mjs <动作> [参数]）：
 *   组卷  --student 学生B --ids M0001,M0006 [--subject 数学] [--date 2026-10-06] [--title 卷名] [--note 备注]
 *        [--interleave] [--leech-at N]
 *        （v2.7：**默认只记账、不重排**——印刷顺序的唯一权威是调用方给出的 ids 顺序，
 *          台账 items 必须与印出来的卷面逐题一致：孩子按卷面做、家长按答案册批、回录按台账显示，
 *          三处顺序一旦各说各话，批改结果就会贴到别的题上（2026-10-15 P20261015-01 实测事故）。
 *          要工具代为交错排卷（Rohrer 2020，相邻两题不同族考点，d=0.83）须显式加 --interleave，
 *          仅限「ids 顺序尚未印成卷」的纯 CLI 场景；v2 桌面版从 v2.7 起界面洗牌后必须传此开关关闭。）；
 *          错误次数 ≥ --leech-at（默认 4）的题会额外提示「拆卡/补前置知识卡/标记题目问题」三选一）
 *   批改  --paper P20261006-01 --results "M0001=对,M0006=错,M0011=半对" [--date 2026-10-08] [--note 备注]
 *   撤批  --paper P20261006-01
 *         （撤销整卷：批次从台账移除，卷上题目恢复**未组卷**——未批改的直接回池；
 *          已批改的把该卷判分流水一并回滚、错误次数回退、连对/建议复习日按剩余记录重算。
 *          批次号只增不复用：撤掉的号由 ledger.paperSeq 水印记住，新卷不会拿到同一个号）
 *   归档  --student 学生B --ids M0004 [--force] [--reason 归档原因] [--at 归档日期]
 *         （--reason 默认「已掌握沉淀」；对**已归档**条目再跑一次 = 就地补注日期/原因，不重判连对）
 *   撤归档 --student 学生A --ids Y0006 [--to 已掌握|未复习|...] [--note 理由] [--dry]
 *         （归档不是单向门：撤回归档按复习记录回到自然状态，留痕写 unarchiveAt/unarchiveNote，不污染 reviews/连对）
 *   迁移  （幂等：给老索引补齐 v1.7 复习字段并重排 JSON）⚠️ 会重写索引
 *   状态  [--student 学生B]                              （只读：不写任何文件）
 *   准入  [--student 学生B]                              （只读：哪张卡进不了组卷池、卡在哪道门禁）
 *   同步  --file %USERPROFILE%\Downloads\ctb-sync-20261006.json   （合并首页导出的待同步包）
 *   任意动作加 --refresh 生成后自动重跑 _生成首页.ps1
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { libraryRoot, toolPath } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic } from './_安全写.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 现在是**用户库根**，不再是"本脚本所在目录"。
   兄弟工具一律用 toolPath(...)，见 _库根.mjs。 */
const ROOT = libraryRoot();
const LEDGER = path.join(ROOT, '_组卷台账.json');
const LADDER = [1, 3, 7, 15, 30, 60, 90];
const OK_RES = ['对', '半对', '错'];

const argv = process.argv.slice(2);
const action = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith('--')) continue;
  const k = t.slice(2);
  if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { opt[k] = argv[++i]; }
  else { opt[k] = true; }
}
const dstr = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;  // 本地日期，勿用 toISOString（UTC+8 会倒退一天）
const today = () => dstr(new Date());
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return dstr(x); };
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

/* ⚠ 2026-10-10（BUG-01/02）：这两处原先直接 fs.writeFileSync / JSON.parse。
   写：`open(path,'w')` 会先把文件截断成 0 字节，写一半被杀就留半截 JSON——
      而 _索引.json 是题库唯一真源（202 张卡的题面/答案/错因/复习流水都在里面，不可再生）。
   读：解析失败会抛（响亮，尚可），但形状"合法却不对"时上层会当我以为是空的。
   统一改走 _安全写.mjs：原子替换 + 写前备份；形状守卫一律响亮拒绝。 */
function readJson(p) { return readJsonStrict(p, { label: path.basename(p) }); }
function writeJson(p, o) { writeJsonAtomic(p, o, { backup: true }); }
/* 索引有两种合法形态：学科级 j.items[] 或学生级 j.subjects{学科:{items[]}}。
   形状守卫必须挡住"合法 JSON 但两种都不是"的情况——例如被 PowerShell ConvertFrom/To-Json
   往返成 {items:{value:[…]}}：那种情况下 itemsOf() 会一条都取不到，202 张卡**还在文件里但谁都看不见**，
   而 refreshAll 还会照样重写该文件、并把这种"看不见"固化下去。 */
const IDX_SHAPE = j => Array.isArray(j.items) || (!!j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects));
function readIndex(p) { return readJsonStrict(p, { shape: IDX_SHAPE, what: 'items 数组或 subjects 对象', label: path.basename(p) }); }

/** 递归找 _索引.json（跳过工作/收件箱目录） */
function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) {
      if (e.name === '_索引.json') acc.push(path.join(dir, e.name));
      continue;
    }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;   // _收件箱/_work-xx 不是题库
    if (/(作业|假期)/.test(e.name)) continue;                          // 原始试卷档案目录
    indexFiles(path.join(dir, e.name), acc);
  }
  return acc;
}

/** 索引 → [{item, subject}]，兼容学生级(subjects)与学科级(items)两种形态 */
function itemsOf(j) {
  const out = [];
  if (Array.isArray(j.items)) for (const it of j.items) out.push({ item: it, subject: j.subject || '' });
  if (j.subjects) for (const [name, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) out.push({ item: it, subject: name });
  return out;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return { note: '组卷/复习批次台账：一批次=一次纸质重做卷；只改状态不删行。', batches: [] };
  /* 旧写法"形状不对就换成空台账"= 静默清空（BUG-02）。组卷台账记的是每次重做卷的批改结果，
     清空后所有在途批次消失 → 复习流水断链。所以形状异常必须响亮拒绝。 */
  return readJsonStrict(LEDGER, { shape: l => Array.isArray(l.batches), what: 'batches 数组', label: '_组卷台账.json' });
}
function pendingMap(ledger) {
  const m = {};
  for (const b of ledger.batches) {
    if (b.status !== '待批改') continue;
    (m[b.student] || (m[b.student] = new Set()));
    for (const id of b.items || []) m[b.student].add(id);
  }
  return m;
}

const revsOf = it => (Array.isArray(it.reviews) ? it.reviews : []).filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));
function passStreak(revs) {
  let p = 0;
  for (let i = revs.length - 1; i >= 0; i--) { if (revs[i].result === '对') p++; else break; }
  return p;
}
function derive(it, pending) {
  const revs = revsOf(it);
  const pass = passStreak(revs);
  const last = revs.length ? revs[revs.length - 1] : null;
  let rs;
  if (it.status === '已归档') rs = '已归档';
  else if (pass >= 2) rs = '已掌握';
  else if (pending && pending.has(it.id)) rs = '复习中·待批改';
  else if (!last) rs = '未复习';
  else if (last.result === '对') rs = '已复习·通过';
  else if (last.result === '半对') rs = '已复习·半对';
  else rs = '已复习·再错';
  return { rs, count: revs.length, pass, lastDate: last ? last.date : '', lastResult: last ? last.result : '' };
}
/** 把派生字段写回每个 item（幂等） */
function syncIndex(obj, pend) {
  const rows = [];
  const pending = pend[obj.student] || new Set();
  for (const { item, subject } of itemsOf(obj)) {
    if (!Array.isArray(item.reviews)) item.reviews = [];
    const d = derive(item, pending);
    item.reviewStatus = d.rs;
    item.reviewCount = d.count;
    item.passStreak = d.pass;
    item.lastReviewedAt = d.lastDate;
    if (item.nextDue === undefined) item.nextDue = '';
    if (item.errorCount === undefined) item.errorCount = 1;
    if (item.blindStatus === undefined || item.blindStatus === '') item.blindStatus = '未盲解';
    if (item.blindSolveAt === undefined) item.blindSolveAt = '';
    if (item.blindSolver === undefined) item.blindSolver = '';
    if (item.blindNote === undefined) item.blindNote = '';
    if (item.blindFingerprint === undefined) item.blindFingerprint = '';
    if (d.rs === '已掌握') { if (!item.masteredAt) item.masteredAt = today(); } else item.masteredAt = null;
    rows.push({ id: item.id, subject, status: d.rs, pass: d.pass, nextDue: item.nextDue, errors: item.errorCount });
  }
  return rows;
}
/**
 * 重算派生状态。
 * ⚠️ write=true 会**重写**每个 _索引.json（重排 JSON + 刷 updatedAt）——只有「迁移」「批改」「归档」「组卷」
 * 这类确实改状态的动作用；「状态」是只读查询，必须传 false（2026-10-06 修：原先两者共用会写库的分支，
 * 一条看似只读的 `状态` 命令会把全部索引重写一遍，多会话并行时可能覆盖别人的在途修改）。
 */
function refreshAll(ledger, write = true) {
  const pend = pendingMap(ledger);
  const res = [];
  for (const f of indexFiles(ROOT)) {
    const j = readIndex(f);
    const rows = syncIndex(j, pend);
    if (write) { j.updatedAt = today(); writeJson(f, j); }
    res.push({ student: j.student, file: f, rows });
  }
  return res;
}
/* ⚠ 2026-10-25（英语卷入账实测）：学生可以按学科拆多个索引文件——
   （七年级-某学生\数学\_索引.json 与 七年级-某学生\英语\_索引.json 都写着同一个 student）。
   旧实现「取扫描到的第一个同名学生索引」永远命中字母序靠前的数学那份，于是一张英语卷
   必炸「库中不存在编号 E00xx」；前端 toast 又只留 stderr 尾部 400 字，用户看到的是一段
   没头没尾的裸堆栈（连"不存在编号"都没显示）。现在：同名学生的全部索引参与评分，
   按 ① --subject 命中（+100，兼容学生级 j.subjects[学科] 单文件形态）＋ ② 对 --ids 的覆盖数
   择优。只有一个索引或没给 prefer 时行为与旧版逐字节一致（单索引库零变化）。 */
function findIndexFile(student, prefer) {
  const all = [];
  for (const f of indexFiles(ROOT)) { const j = readIndex(f); if (j.student === student) all.push({ file: f, json: j }); }
  if (!all.length) throw new Error('找不到学生索引：' + student);
  if (all.length === 1 || !prefer) return all[0];
  const want = Array.isArray(prefer.ids) ? prefer.ids : [];
  let best = all[0], bestScore = -1;
  for (const x of all) {
    let s = 0;
    if (prefer.subject && (x.json.subject === prefer.subject ||
      (x.json.subjects && x.json.subjects[prefer.subject]))) s += 100;
    if (want.length) {
      const have = new Set(itemsOf(x.json).map(o => o.item.id));
      s += want.reduce((a, id) => a + (have.has(id) ? 1 : 0), 0);
    }
    if (s > bestScore) { bestScore = s; best = x; }
  }
  return best;
}
function splitIds(s) { return String(s || '').split(/[,;\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean); }

/* ---------------- 动作 ---------------- */

/**
 * 间隔与建议复习日（**唯一实现**，供 actGrading 与 撤批 共用）。
 * 原先这段逻辑只写在 actGrading 里，于是 撤批 无从重算 → 见 BUG-20。
 */
function intervalOf(res, pass) {
  /* ⚠ 2026-10-11 修（实测抓到的方向缺陷）：旧实现是
       res === '错' ? 1 : res === '半对' ? 3 : LADDER[pass - 1]
     而 LADDER = [1,3,7,15,30,60,90] ⇒ **答对(pass=1) 只给 1 天，比"半对"的 3 天还短** ——
     答对反而更早被要求重做。方向反了。
     现在：错 1 天 ＜ 半对 3 天 ＜ 对 7 天（连对次数越多越久）。
     说明：连对 2 次即判「已掌握」退出组卷池（见 derive/passStreak），
     所以 LADDER_OK 后几档在正常流程里到不了 —— 那是**出池设计的边界**，不是死代码。
     LADDER 常量保留给文案/历史引用，判定统一走本函数。 */
  if (res === '错') return 1;
  if (res === '半对') return 3;
  const LADDER_OK = [7, 15, 30, 60, 90];
  return LADDER_OK[Math.min(Math.max(pass, 1), LADDER_OK.length) - 1];
}
/** 按"剩余复习记录"重算某卡的 nextDue（没有记录则清空）。撤批后必须调用，否则留着被撤批次的旧日期。 */
function recomputeNextDue(it) {
  const revs = revsOf(it);
  if (!revs.length) { it.nextDue = ''; return ''; }
  const last = revs[revs.length - 1];
  const pass = passStreak(revs);
  it.nextDue = addDays(last.date, intervalOf(last.result, pass));
  return it.nextDue;
}

function actGrading(paperId, resultsStr, date, note) {
  const ledger = loadLedger();
  const b = ledger.batches.find(x => x.paperId === paperId);
  if (!b) throw new Error('台账中找不到批次 ' + paperId);
  const { file, json } = findIndexFile(b.student);
  const known = {};
  for (const { item } of itemsOf(json)) known[item.id] = item;
  const parsed = {};
  for (const pair of String(resultsStr).replace(/＝/g, '=').split(/[,;]/)) {
    if (!pair.trim()) continue;
    const i = pair.indexOf('=');
    if (i < 0) throw new Error('结果格式应为 编号=对|半对|错，收到：' + pair);
    parsed[pair.slice(0, i).trim().toUpperCase()] = pair.slice(i + 1).trim();
  }
  const log = [];
  for (const id of b.items) {
    if (!(id in parsed)) continue;
    const res = parsed[id];
    if (!OK_RES.includes(res)) throw new Error('非法结果：' + id + '=' + res + '（只能 对/半对/错）');
    const it = known[id];
    if (!it) throw new Error('编号 ' + id + ' 不在 ' + b.student + ' 库中');
    const prevList = revsOf(it);
    const prev = prevList.find(r => r.paper === paperId);           // 同一批次重复回录时按最后一次结果修正，不双计
    const before = prev ? prev.result : null;
    it.reviews = prevList.filter(r => r.paper !== paperId).concat([{ date, paper: paperId, result: res, note: note || '' }]);
    if (res === '错' && before !== '错') it.errorCount = num(it.errorCount) + 1;
    if (res !== '错' && before === '错') it.errorCount = Math.max(1, num(it.errorCount) - 1);
    const pass = passStreak(revsOf(it));
    it.nextDue = addDays(date, intervalOf(res, pass));
    b.results = b.results || {};
    b.results[id] = res;
    log.push({ id, res, pass, nextDue: it.nextDue, status: '' });
  }
  b.results = b.results || {};
  const filled = b.items.filter(id => b.results[id]);
  if (b.items.length && filled.length >= b.items.length) { b.status = '已批改'; b.gradedAt = date; }
  if (String(b.source || '').startsWith('首页')) b.source = '首页(已入库)';
  if (note) b.note = note;
  writeJson(LEDGER, ledger);
  const rows = syncIndex(json, pendingMap(ledger));
  json.updatedAt = today();
  writeJson(file, json);
  const st = {}; rows.forEach(r => st[r.id] = r.status);
  log.forEach(l => l.status = st[l.id]);
  return { batch: b, log };
}

/**
 * 撤归档后的自然状态：按复习记录推导，不看 status 字段本身。
 * 复用 derive（唯一实现）——临时摘掉 status 再问它，避免把 derive 的分支再抄一遍（L-259）。
 */
function naturalStatus(it) {
  const saved = it.status;
  it.status = '';
  try { return derive(it, new Set()).rs; } finally { it.status = saved; }
}

/**
 * 撤归档（v2.2）：把「已归档」退回正常状态。归档原本是个单向门——
 * 2026-10-08 用户问「为什么有一条已归档、也没有取消归档的按钮」，
 * 网页按设计只读，CLI 又只有 归档 没有反向动作，等于一旦归档只能手改索引（禁止绕过工具写盘）。
 * 默认回到全库通用值「在册」（status 只有 '已归档' 被 derive/首页/门禁特判，其余一律视为在册）；
 * --to 可显式指定别的值，--dry 只预览**绝不写盘**。
 * 留痕走独立字段（unarchiveAt/unarchiveNote），**不写 reviews**：reviews 会喂 passStreak/errorCount，
 * 记一条假复习等于污染孩子的连对计数。
 * @param {boolean} [write=false] false = 不落盘（--dry / 预览）
 * @returns {{rows: string[], skipped: string[]}}
 */
function actUnarchive(student, ids, to, note, write = false) {
  const { file, json } = findIndexFile(student);
  const ALLOW_TO = ['在册', '已掌握', '未复习', '复习中·待批改', '已复习·通过', '已复习·半对', '已复习·再错'];
  if (to && !ALLOW_TO.includes(to)) throw new Error('--to 只能是：' + ALLOW_TO.join(' / '));
  const rows = [], skipped = [];
  let touched = 0;
  for (const { item, subject } of itemsOf(json)) {
    if (!ids.includes(item.id)) continue;
    if (item.status !== '已归档') { skipped.push(item.id + ' 当前是「' + (item.status || '（未归档）') + '」，本来没归档，未动'); continue; }
    const back = to || '在册';
    if (write) {
      item.status = back;
      item.archivedAt = '';
      item.archivedReason = '';
      item.unarchiveAt = today();
      item.unarchiveNote = note || '';
    }
    rows.push(item.id + ' [' + subject + '] 已归档 → ' + back + '（复习记录推导显示为「' + naturalStatus(item) + '」）');
    touched++;
  }
  const notFound = ids.filter(id => !rows.some(r => r.startsWith(id + ' ')) && !skipped.some(r => r.startsWith(id + ' ')));
  if (notFound.length) throw new Error(json.student + ' 库中不存在编号 ' + notFound.join(','));
  if (touched && write) { json.updatedAt = today(); writeJson(file, json); }
  return { rows, skipped, touched };
}

switch (action) {

  case '准入': {
    /* 只读：把「哪张卡进不了组卷池、卡在哪一道门禁」一次列清楚。
       为什么需要：组卷失败时只报被点名的题，用户看不到全局（实测学生B 80 张里 50 张被答案来源门禁拦，
       而拦的原因一半是"字段没写"，不是"真没做复核"）。
       三态：可组卷 / 缺第二来源 / 盲解未过。
       `--json` 输出 { "学生|编号": {ok,why} } —— **本文件是准入判定的唯一实现**，
       `_生成首页.ps1` 把它注入 _状态.json.admit，v2 界面据此决定"这张卡能不能进篮子"，
       从而杜绝"界面上选得动、工具一提交就拒"的口径漂移（2026-10-10 实测踩到）。 */
    const SRC_PREFIX_OK = ['独立判卷', '老师定案', '官方答案'];
    const SRC_EXACT_OK = ['红笔订正+官方答案页核对'];
    const okSrc = it => {
      const s = String((it && it.answerSource) || '').trim();
      return !!s && (SRC_PREFIX_OK.some(p => s.startsWith(p)) || SRC_EXACT_OK.includes(s));
    };
    const admit = {};
    let totalAll = 0, canAll = 0;
    for (const f of indexFiles(ROOT)) {
      const j = readJson(f);
      if (opt.student && j.student !== opt.student) continue;
      let can = 0; const noSrc = [], noBlind = [];
      for (const { item } of itemsOf(j)) {
        const b = ['已通过', '已修正'].includes(item.blindStatus || '');
        const a = okSrc(item);
        const key = j.student + '|' + item.id;
        const why = (b && a) ? '' : (!b ? ('盲解未过：' + (item.blindStatus || '未盲解')) : ('缺第二来源：' + (item.answerSource || 'answerSource 字段为空')));
        admit[key] = { ok: b && a, why };
        if (b && a) can++; else if (!a) noSrc.push(item.id + '[' + (item.answerSource || '（缺字段）') + ']'); else noBlind.push(item.id + '[' + (item.blindStatus || '未盲解') + ']');
      }
      const total = can + noSrc.length + noBlind.length;
      totalAll += total; canAll += can;
      if (opt.json) continue;
      console.log(`── ${j.student}：可组卷 ${can}/${total}` + (total ? ` = ${Math.round(100 * can / total)}%` : ''));
      if (noBlind.length) console.log(`   ✖ 盲解未过（${noBlind.length}）：${noBlind.slice(0, 12).join(' ')}${noBlind.length > 12 ? ' …' : ''}`);
      if (noSrc.length) console.log(`   ✖ 缺第二来源（${noSrc.length}）：${noSrc.slice(0, 12).join(' ')}${noSrc.length > 12 ? ' …' : ''}`);
    }
    if (opt.json) { console.log(JSON.stringify({ ok: true, can: canAll, total: totalAll, admit })); break; }
    console.log('\n口径：可组卷＝盲解已通过 且 answerSource 有非红笔第二来源（独立判卷/老师定案/官方答案/官方答案页）；');
    console.log('      「（缺字段）」是数据欠账——按铁律不放行，补法见《方案》四之九。');
    break;
  }

  case '迁移':
  case '状态': {
    const res = refreshAll(loadLedger(), action === '迁移');   // 状态=只读查询，不写索引
    for (const r of res) {
      if (opt.student && r.student !== opt.student) continue;
      console.log('── ' + r.student + '（' + r.rows.length + ' 题）');
      const g = {};
      r.rows.forEach(x => (g[x.status] = (g[x.status] || 0) + 1));
      if (action === '迁移') {
        Object.keys(g).forEach(k => console.log('   ' + k.padEnd(14) + ' ' + g[k] + ' 题'));
      } else {
        r.rows.forEach(x => console.log('   ' + x.id + ' [' + x.subject + '] ' + x.status + (x.nextDue ? ' · 建议复习 ' + x.nextDue : '')));
      }
    }
    console.log(action === '迁移' ? '迁移完成：reviewStatus / reviewCount / passStreak / lastReviewedAt / nextDue / masteredAt 已补齐' : '');
    break;
  }

  case '组卷': {
    if (!opt.student || !opt.ids) throw new Error('组卷需要 --student 与 --ids');
    const ids = splitIds(opt.ids);
    const { file, json } = findIndexFile(opt.student, { subject: opt.subject, ids });
    const known = {}, byId = {};
    for (const { item, subject } of itemsOf(json)) { known[item.id] = subject; byId[item.id] = item; }
    /* 报错带上最终选中的索引文件：多索引库里一眼看出"它到底在哪个库里找编号" */
    ids.forEach(id => { if (!(id in known)) throw new Error(json.student + ' 库中不存在编号 ' + id + '（在索引 ' + file + ' 里找不到）'); });
    // ── 盲解准入门禁（v1.8 铁律）：未盲解/不一致的题不得进组卷池，除非 --force ──
    const BLIND_OK = ['已通过', '已修正'];
    const blocked = ids.filter(id => !BLIND_OK.includes(byId[id].blindStatus || '未盲解'));
    if (blocked.length && !opt.force) {
      console.error('✖ 盲解门禁拦截：' + blocked.map(id => id + '[' + (byId[id].blindStatus || '未盲解') + ']').join(' '));
      console.error('   → 先跑 `node _盲解复核.mjs 清稿` 派无上下文解题者盲解，再用 `录入/批量` 落结论；确需绕过加 --force（不推荐）。');
      process.exit(2);
    }
    if (blocked.length) console.log('⚠ --force 绕过盲解门禁：' + blocked.join(','));
    // ── 答案双源准入（v2.1）：answerSource=仅红笔 的题不得进组卷池 —— 红笔可能是孩子自批/同学互批，
    //    未经过「独立判卷复核」的判定没有第二来源。独立判卷结论见错题本系统方案.md 四之九。
    /* ⚠ 2026-10-10 修（实测抓到）：旧判据是**精确字符串白名单** `['独立判卷+红笔一致','独立判卷修正']`，
       但 answerSource 是自由文本，库里真实取值有十几种合法写法
       （「独立判卷（⚠️卷面无红笔记号，漏判）」「独立判卷（半对）」「独立判卷」「老师定案（待办台账 T084 回话）」
         「红笔订正+官方答案页核对」「官方答案比对（…）+ 整页照片逐图复核」…），
       于是**明明做过独立判卷的卡也被拦**：普查实测 202 张里只有 87 张能过两道门禁，
       多出来的拦截不是因为"没有第二来源"，而是因为**措辞没对上白名单**。
       这比漏拦更坏：它把"改字符串"变成过门禁的捷径（正是门禁最该防的）。
       新判据按**语义**判：必须有非红笔的第二来源。
         · 前缀命中「独立判卷 / 老师定案 / 官方答案」→ 过（后缀写清依据、留痕更细，不扣分）
         · 精确「红笔订正+官方答案页核对」→ 过（红笔 + 官方答案页双源）
         · 其余（含「仅红笔」与空值）→ 拦
       空值仍拦：字段缺失＝没人记录第二来源＝按铁律不放行（这是**数据欠账**，不是措辞问题）。 */
    const SRC_PREFIX_OK = ['独立判卷', '老师定案', '官方答案'];
    const SRC_EXACT_OK = ['红笔订正+官方答案页核对'];
    const answerSourceOk = it => {
      const s = String((it && it.answerSource) || '').trim();
      if (!s) return false;
      return SRC_PREFIX_OK.some(p => s.startsWith(p)) || SRC_EXACT_OK.includes(s);
    };
    const noSrc = ids.filter(id => !answerSourceOk(byId[id]));
    if (noSrc.length && !opt.force) {
      console.error('✖ 答案来源门禁拦截（answerSource 无独立判卷/官方答案等第二来源）：' + noSrc.map(id => `${id}[${(byId[id].answerSource || '（缺字段）')}]`).join(' '));
      console.error('   → 按《错题本系统方案》四之九做「全卷独立判卷复核」：转录无记号判卷清稿 → 无上下文子代理独立判卷 → 与红笔对照落 answerSource。');
      console.error('     查看全局：node _标记复习.mjs 准入 --student ' + json.student);
      process.exit(2);
    }
    if (noSrc.length) console.log('⚠ --force 绕过答案来源门禁：' + noSrc.join(','));
    // ── 盲解指纹新鲜度（v1.8+）：题干在盲解之后被改过 → 结论失效，须重新盲解 ──
    // 新鲜度统一由 _盲解复核.mjs 计算（单一实现，避免两处逻辑漂移）。
    if (!opt.force) {
      /* ⚠ 2026-10-10 修（本会话实测）：这里原先两个错叠在一起，导致这道门禁**从来没生效过**——
         ① 只在 `r.status === 0` 时解析 stdout：而"题干改过没重盲解"的题会让门禁 exit 1，
            于是恰好最该拦的场景下新鲜度表拿不到 → 静默放行；
         ② 取键取错层：门禁 --json 的信封是 {ok,action,checked,liveCount,okCount,problems,cards}，
            卡片字典在 `.cards` 里，旧写法直接查信封顶层 ⇒ 永远 undefined ⇒ 永远不 stale。 */
      let fresh = null;
      try {
        const r = spawnSync(process.execPath, [toolPath('_盲解复核.mjs'), '门禁', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (r.stdout) {
          const env = JSON.parse(String(r.stdout).trim());
          fresh = (env && env.cards && typeof env.cards === 'object') ? env.cards : env;
        }
      } catch { fresh = null; }
      if (!fresh || typeof fresh !== 'object' || !Object.keys(fresh).length) {
        console.error('✖ 盲解指纹新鲜度不可用（_盲解复核.mjs 门禁 --json 没给出 cards 字典）。');
        console.error('  这道门禁负责拦「题干被改过却没重盲解」的题；取不到就不放行（静默降级正是 2026-10-10 修掉的 bug）。');
        console.error('  → 先 `node _盲解复核.mjs 门禁` 看真实原因；确需绕过加 --force（不推荐）。');
        process.exit(2);
      }
      {
        const stale = ids.filter(id => { const v = fresh[json.student + '|' + id]; return v !== undefined && v !== '有效'; });
        if (stale.length) {
          console.error('✖ 盲解结论已失效（题干在盲解之后被改动）：' + stale.map(id => id + '[' + fresh[json.student + '|' + id] + ']').join(' '));
          console.error('   → 重新跑 `node _盲解复核.mjs 清稿 --ids ' + stale.join(',') + '` 盲解一次，再 `录入` 落结论。');
          process.exit(2);
        }
      }
    }
    const subject = opt.subject || known[ids[0]];
    const date = opt.date || today();
    /* ── 交错组卷（v2.6 引入，v2.7 改为**显式选择**，2026-10-15）：相邻两题不同「同族考点」──
        依据：Rohrer et al. 2020 预注册整群 RCT（54 个七年级班，1 个月后无预告测验）
        交错组 61% vs 分块组 38%，d=0.83，WWC 最高证据等级（ERIC EJ1237752）。
        v2.6 时它默认开启，与 v2 界面「学科内按难度打乱」各排各的 ⇒
        卷面、答案册、台账三种顺序并存（P20261015-01 实测事故：家长批改对不上题）。
        现在：印刷顺序的唯一权威 = 调用方 ids 顺序；只有显式 --interleave（且顺序尚未印成卷）才重排。
        实现：贪心重排 —— 每次从剩余里挑第一个与上一题 primaryCode 不同的；挑不到就取原序第一个。 */
    /* ⚠ 2026-10-11 修（轴用错了）：旧实现按 **causeCode（错因码）** 交错，而本段注释与所引实证
       （Rohrer 2020：相邻两题不应要求同一**策略/考点**）说的都是**考点**。
       实测（复刻旧算法跑全库）：交错后相邻两题 **kpoints 仍有交集**的比例——
       学生A数学 17/30、学生A物理 24/70、学生B数学 39/79 ⇒ "相邻不同考点"这条性质根本没被保证
       （且 K1 一个错因码占全库 79/202，按错因码交错本来也分不开）。
       现在优先级：① 找第一个**与上一题考点无交集**的；② 退而求其次找错因码不同的；
       ③ 都不行（剩余全同族）才取原序第一个。 */
    const kpOf = id => { const it = byId[id] || {}; return Array.isArray(it.kpoints) ? it.kpoints : []; };
    const sharesKp = (a, b) => { const A = kpOf(a), B = kpOf(b); return A.length > 0 && B.length > 0 && A.some(x => B.includes(x)); };
    const primaryCodeOf = id => { const it = byId[id] || {}; return it.causeCode || it.causeLayer || ''; };
    let ordered = ids.slice();
    if (opt.interleave && !opt['no-interleave'] && ordered.length > 2) {
      const rest = ordered.slice();
      const out = [rest.shift()];
      while (rest.length) {
        const prev = out[out.length - 1];
        let i = rest.findIndex(id => !sharesKp(prev, id));                               // ① 考点不相交
        if (i < 0) i = rest.findIndex(id => primaryCodeOf(id) !== primaryCodeOf(prev));  // ② 错因码不同
        if (i < 0) i = 0;                                                                // ③ 只能同族
        out.push(rest.splice(i, 1)[0]);
      }
      const changed = out.filter((id, i) => id !== ordered[i]).length;
      ordered = out;
      if (changed) console.log(`交错组卷：为避开「相邻同族考点」重排 ${changed} 题（--interleave 显式开启；不加则按调用方顺序记账）`);
    }
    const ledger = loadLedger();
    /* ── 防重复组卷门禁（2026-10-24 用户报障）──
       用户原话：「我给学生A出了两次试卷，发现第一次试卷与第二次试卷题目是一样的。系统没有主动让我避开已经出过并做过的错题。」
       实测：P20261021-01 与 P20261024-01 两批 **交集 30/30**（同一套题按不同顺序印了两遍）。
       根因有两层：① 界面「选题篮」是 localStorage 持久化的，入账后从不清空 ⇒ 再进组卷工作台还是那 30 题，
       一点预览+入账就又印一遍；② 本工具的组卷口只有「盲解/答案来源/指纹」三道门禁，
       **完全没有"这题最近印过没有"的概念**。两个原因叠加，重复印卷必然发生。
       为什么这是缺陷而不是"多练一遍"：同一套题隔 3 天再印，孩子是照答案默写，
       第 2 次的「对」不反映掌握程度 —— 会直接污染 passStreak / nextDue / 已掌握判定（错题本的全部下游推断）。
       判据：同一学生、同一题，在最近 N 天（默认 7）内已出现在任何非作废批次里 ⇒ 拦。
       丢纸重印**不走这条路**（走台账「👁 看这张卷」直接重印当初那张），所以不需要绕过；
       确需重排同题（如换了题组策略）再显式 --force，并留下审计痕迹。 */
    const REPEAT_DAYS = (String(opt['no-repeat-days']) === '0') ? 0 : (num(opt['no-repeat-days']) || 7);
    if (REPEAT_DAYS > 0) {
      const since = addDays(date, -REPEAT_DAYS);
      const recent = {};        // id → 最近一次印它的批次（同题多批取日期最新那条）
      for (const b of ledger.batches) {
        if (b.student !== json.student) continue;
        if (b.status === '已作废') continue;
        if (!b.date || String(b.date) < since) continue;
        for (const id of (b.items || [])) {
          if (!recent[id] || String(b.date) >= String(recent[id].date)) {
            recent[id] = { paperId: b.paperId, date: b.date, status: b.status };
          }
        }
      }
      const rep = ids.filter(id => recent[id]);
      if (rep.length && !opt.force) {
        console.error('✖ 防重复组卷拦截：' + rep.length + '/' + ids.length + ' 题在最近 ' + REPEAT_DAYS + ' 天内已经印过卷（自 ' + since + ' 起）');
        console.error('   ' + rep.map(id => id + '[' + recent[id].paperId + ' ' + recent[id].date + ' ' + recent[id].status + ']').join(' '));
        console.error('   为什么拦：同一套题短期内重印 = 孩子照答案默写，第 2 次的「对」不反映掌握，会污染连对/建议复习日/已掌握判定。');
        console.error('   怎么办：① 等这些题的「建议复习日」到期再组（台账/首页有日期）；② 换印过的以外的题；');
        console.error('            ③ 纸卷丢了要原样重印 → 去台账点「👁 看这张卷」，那里直接重印当初那张，不新建批次。');
        console.error('   确需把同一批题再印一遍（如换题组策略）加 --force；想关掉本门禁加 --no-repeat-days 0。');
        process.exit(2);
      }
      if (rep.length) console.log('⚠ --force 绕过防重复组卷门禁（' + rep.length + ' 题近 ' + REPEAT_DAYS + ' 天印过）：' + rep.slice(0, 20).join(','));
    }
    /* ⚠ BUG-06（2026-10-11 修）：批次号原先按「当天已有批次**条数** + 1」生成。
       一旦某天有 2 个批次、其中**低号那个被撤批删掉**，条数回到 1 ⇒ 新批次又拿到 P…-02，
       与**已存在**的 P…-02 **撞号**。而 `批改` 用 `find(x => x.paperId === paperId)` 取第一个命中
       ⇒ 批改结果落到旧批次/旧卡上，复习记录错位，可能出现"没做却连对 2 次 → 伪已掌握"。
       改为取"当天已用过的最大序号 + 1"（只增不复用），并对撞号做硬断言。
       ⚠ 2026-10-24 再补一层水印（撤销试卷成为正式界面功能）：撤销允许**任何阶段**撤，
       「被撤批删掉」从此是日常操作，而撤批恰恰最常删**当天最大号**（撤的是最新那张卷）⇒
       行数/最大号双双回落，下一个批次又拿到与被撤销批次相同的号——纸卷上虽没印批次号，
       但回录、审计线索（_待确认 引用台账 id）、备份对账全都对不上。
       现在"当天已用过的最大序号"另记一份进台账级水印 ledger.paperSeq['P<日期>']，
       撤批删行**不回退**水印 ⇒ 批次号只增不复用（老台账没有 paperSeq 也能无缝起步）。 */
    const seqKey = 'P' + date.replace(/-/g, '');
    ledger.paperSeq = ledger.paperSeq || {};
    const used = ledger.batches
      .filter(b => b.date === date)
      .map(b => { const m = /-(\d+)$/.exec(b.paperId || ''); return m ? Number(m[1]) : 0; });
    const nextNo = Math.max(used.length ? Math.max(...used) : 0, num(ledger.paperSeq[seqKey])) + 1;
    const paperId = 'P' + date.replace(/-/g, '') + '-' + String(nextNo).padStart(2, '0');
    if (ledger.batches.some(b => b.paperId === paperId)) throw new Error('批次号撞号（内部错误，拒绝写入）：' + paperId);
    ledger.paperSeq[seqKey] = Math.max(num(ledger.paperSeq[seqKey]), nextNo);   // 撤批不回退：只增不复用
    const pend = pendingMap(ledger);
    const dup = ids.filter(id => pend[json.student] && pend[json.student].has(id));
    const batch = {
      paperId, date, student: json.student, subject,
      title: opt.title || (date + '-' + json.student + '-' + subject + '-错题重做卷'),
      items: ordered, status: '待批改', results: {}, gradedAt: null,
      source: opt.source || 'agent', note: opt.note || ''
    };
    ledger.batches.push(batch);
    writeJson(LEDGER, ledger);
    const rows = syncIndex(json, pendingMap(ledger));
    json.updatedAt = today();
    writeJson(file, json);
    console.log('已入账 ' + paperId + '（' + json.student + ' · ' + subject + ' · ' + ordered.length + ' 题 · 待批改）');
    rows.filter(r => ids.includes(r.id)).forEach(r => console.log('   ' + r.id + ' → ' + r.status));
    if (dup.length) console.log('   提示：' + dup.join(',') + ' 已在其它待批改批次中（可正常叠加）');
    /* ── leech 提醒（v2.6，2026-10-10）──
       依据：Anki 官方 Leeches 文档 —— 同一张卡错到阈值（默认 8）时，"最有效的处置是改变信息的呈现方式"，
       而不是继续重刷。现场已有「错误次数」计数与拆卡实证（22 题 → M0012/M0013），但缺"达阈值触发动作"这一步。
       这里只**提醒**不阻断（改学习行为应由人来决定），把三个规定动作摆出来。 */
    const LEECH_AT = num(opt['leech-at']) || 4;
    const leeches = ordered.filter(id => num(byId[id].errorCount) >= LEECH_AT);
    if (leeches.length) {
      console.log('');
      console.log(`⚠ 「反复错」提醒（错误次数 ≥ ${LEECH_AT}）：` + leeches.map(id => `${id}(${num(byId[id].errorCount)}次)`).join('、'));
      console.log('   重刷第 N 遍通常无效（Anki Leeches：最有效的处置是改变信息呈现方式）。三选一：');
      console.log('     ① 拆卡：把这一题拆成 2~3 个小卡片（按步骤/子问题），已实证有效路径；');
      console.log('     ② 补前置知识卡：查 _索引.json 的 kpoints，把缺的上游知识点单独建卡；');
      console.log('     ③ 标记题目表述问题：题干有歧义/缺条件 → 记进 _待确认.mjs 台账并回原卷核对。');
    }
    break;
  }

  case '批改': {
    if (!opt.paper || !opt.results) throw new Error('批改需要 --paper 与 --results="M0001=对,M0002=错"');
    const r = actGrading(opt.paper, opt.results, opt.date || today(), opt.note);
    console.log('已回录 ' + r.batch.paperId + '（批次状态：' + r.batch.status + '）');
    r.log.forEach(l => console.log('   ' + l.id + ' 结果=' + l.res + ' → ' + l.status + ' · 连对 ' + l.pass + ' 次 · 建议复习 ' + l.nextDue));
    if (r.batch.status === '已掌握' || r.log.some(l => l.status === '已掌握')) console.log('   ★ 有题连对 2 次 → 已掌握，默认退出组卷池；可说“归档 Mxxxx”永久沉淀');
    break;
  }

  case '撤批': {
    if (!opt.paper) throw new Error('撤批需要 --paper');
    const ledger = loadLedger();
    const b = ledger.batches.find(x => x.paperId === opt.paper);
    if (!b) throw new Error('台账中找不到批次 ' + opt.paper);
    const gradedN = Object.keys(b.results || {}).length;          // 已录过结果的题数（未批改=0）
    const { file, json } = findIndexFile(b.student);
    for (const { item } of itemsOf(json)) {
      if (!Array.isArray(item.reviews)) continue;
      const drop = revsOf(item).filter(r => r.paper === opt.paper);
      item.reviews = revsOf(item).filter(r => r.paper !== opt.paper);
      const lostErr = drop.filter(r => r.result === '错').length;
      if (lostErr && num(item.errorCount) >= 1) item.errorCount = Math.max(1, num(item.errorCount) - lostErr);
      /* BUG-20（2026-10-11 修）：原先只在"复习记录被清空"时才清 nextDue，
         若该题还有**别的**批次的复习记录，nextDue 会留着被撤批次当时算出的日期
         ⇒ 「建议复习日」与真实复习历史脱节，首页「只看到期」筛选会偏。
         现在一律按剩余记录重算（唯一实现 recomputeNextDue）。 */
      recomputeNextDue(item);
    }
    ledger.batches = ledger.batches.filter(x => x.paperId !== opt.paper);
    writeJson(LEDGER, ledger);
    const rows = syncIndex(json, pendingMap(ledger));
    json.updatedAt = today();
    writeJson(file, json);
    /* 2026-10-24（用户要求「任何时候、任何阶段都可以撤销；撤销后题目恢复成未组卷状态」）：
       撤批语义升级为「整卷退回」。批次号水印只增不复用（见 组卷 案头 paperSeq 注释），
       所以这里删行是安全的——同一个号不会再被领走。 */
    console.log('已撤销批次 ' + opt.paper + '（' + (b.student || '') + ' · ' + (b.subject || '') + ' · ' + (b.items || []).length + ' 题）');
    console.log(gradedN
      ? '   已判 ' + gradedN + ' 题的结果一并撤销：判分流水、错误次数、连对、建议复习日已按剩余记录重算'
      : '   该卷尚未批改，无判分流水需要回滚');
    console.log('   卷上题目已恢复为**未组卷**：立即可重新组卷，防重复门禁也不再把它算作「最近印过」');
    console.log('   错题卡本体未动（题干/答案/错因/原卷图原样保留）');
    rows.filter(r => (b.items || []).includes(r.id)).forEach(r => console.log('   ' + r.id + ' → ' + r.status));
    break;
  }

  case '归档': {
    if (!opt.student || !opt.ids) throw new Error('归档需要 --student 与 --ids');
    const { file, json } = findIndexFile(opt.student);
    const ids = splitIds(opt.ids);
    const rows = [];
    for (const { item, subject } of itemsOf(json)) {
      if (!ids.includes(item.id)) continue;
      // 已归档的条目允许「就地补注」：只更新归档日期/原因，不再判连对（否则给历史归档补原因会被门禁挡）。
      if (item.status === '已归档') {
        const chg = [];
        if (opt.reason) { item.archivedReason = opt.reason; chg.push('原因=' + opt.reason); }
        if (opt.at) { item.archivedAt = opt.at; chg.push('日期=' + opt.at); }
        rows.push('   ' + item.id + ' [' + subject + '] 已是已归档' + (chg.length ? ' → 补注 ' + chg.join('，') : '（无变化）'));
        continue;
      }
      if (derive(item, new Set()).pass < 2 && !opt.force) throw new Error(item.id + ' 尚未连对 2 次（已掌握），归档需加 --force（或 --reason 说明为何提前沉淀）');
      item.status = '已归档';
      item.archivedAt = opt.at || today();
      item.archivedReason = opt.reason || '已掌握沉淀';
      // 重新归档 = 撤归档标记作废，否则卡上会同时挂着「已归档」和一条过期的 unarchiveAt 留痕
      item.unarchiveAt = '';
      item.unarchiveNote = '';
      rows.push('   ' + item.id + ' [' + subject + '] → 已归档（' + item.archivedAt + '·' + item.archivedReason + '）');
    }
    console.log(rows.join('\n'));
    writeJson(file, json);
    refreshAll(loadLedger());
    break;
  }

  case '撤归档': {
    if (!opt.student || !opt.ids) throw new Error('撤归档需要 --student 与 --ids');
    const r = actUnarchive(opt.student, splitIds(opt.ids), opt.to, opt.note, !opt.dry);
    console.log(`已撤归档 ${r.rows.length} 题（${opt.student}）${opt.dry ? '（--dry 未写盘）' : ''}`);
    r.rows.forEach(x => console.log('   ' + x));
    r.skipped.forEach(x => console.log('   ↔ ' + x));
    if (!opt.dry) refreshAll(loadLedger());
    break;
  }

  case '同步': {
    if (!opt.file) throw new Error('同步需要 --file 指向首页导出的 ctb-sync-*.json');
    if (!fs.existsSync(opt.file)) throw new Error('文件不存在：' + opt.file);
    const pkg = readJson(opt.file);
    // v2.2：首页可以标记「撤归档」，动作随同步包回来落库（网页只标记、写盘走本工具）。
    for (const ua of (Array.isArray(pkg.unarchive) ? pkg.unarchive : [])) {
      if (!ua || !ua.student || !Array.isArray(ua.ids) || !ua.ids.length) continue;
      const r = actUnarchive(ua.student, splitIds(ua.ids.join(',')), ua.to, ua.note || '首页撤归档（同步包落库）', true);
      console.log(`撤归档（${ua.student}）：${r.rows.join(' ; ') || '无变化'}`);
      r.skipped.forEach(x => console.log('   ↔ ' + x));
    }
    const ledger = loadLedger();
    const byId = {};
    for (const b of ledger.batches) byId[b.paperId] = b;
    const added = [], merged = [];
    for (const nb of (pkg.papers || [])) {
      const results = {};
      if (nb.results) for (const [k, v] of Object.entries(nb.results)) if (v) results[k.toUpperCase()] = v;
      const ex = byId[nb.paperId];
      if (ex) {                                                          // 已存在：只增量并入新结果（首页批改标记回传）
        ex.results = ex.results || {};
        let ch = 0;
        for (const [k, v] of Object.entries(results)) { if (ex.results[k] !== v) { ex.results[k] = v; ch++; } }
        if (ch) merged.push(nb.paperId);
        continue;
      }
      ledger.batches.push({
        paperId: nb.paperId, date: nb.date, student: nb.student, subject: nb.subject || '',
        title: nb.title || '', items: (nb.items || []).map(s => s.toUpperCase()), status: nb.status || '待批改',
        results, gradedAt: nb.gradedAt || null, source: '首页(待同步)', note: nb.note || ''
      });
      byId[nb.paperId] = ledger.batches[ledger.batches.length - 1];
      added.push(nb.paperId);
    }
    writeJson(LEDGER, ledger);
    const todo = [...new Set([...added, ...merged])];
    for (const pid of todo) {
      const b = byId[pid];
      const pairs = Object.entries(b.results || {}).map(([k, v]) => k + '=' + v).join(',');
      if (!pairs) continue;
      const r = actGrading(pid, pairs, b.gradedAt || b.date, '同步包回录');
      console.log('批次 ' + pid + ' 已回录（' + r.batch.status + '）');
      r.log.forEach(l => console.log('   ' + l.id + ' ' + l.res + ' → ' + l.status + ' · 建议复习 ' + l.nextDue));
    }
    const res = refreshAll(loadLedger());
    console.log('同步完成：新建批次 ' + (added.length ? added.join(', ') : '无') + (merged.length ? '；增量回录 ' + merged.join(', ') : ''));
    res.forEach(r => { const g = {}; r.rows.forEach(x => g[x.status] = (g[x.status] || 0) + 1); console.log('   ' + r.student + '：' + JSON.stringify(g)); });
    break;
  }

  default:
    console.log('未知动作：' + action + '\n可用：组卷 / 批改 / 撤批 / 归档 / 撤归档 / 迁移 / 同步 / 状态');
    process.exitCode = 2;
}

if (opt.refresh) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', toolPath('_生成首页.ps1')], { stdio: 'ignore' });
  console.log(r.status === 0 ? '首页已刷新' : '首页刷新失败，请手动重跑 _生成首页.ps1');
}
