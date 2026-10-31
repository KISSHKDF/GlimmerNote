#!/usr/bin/env node
/**
 * 拾光小册 · 状态生成器（_状态.json 的唯一生产者）
 *
 * 原先是 PowerShell 那 1880 行 `_生成首页.ps1` 的一部分；本工具只做界面真正需要的那件事：
 *   「把库里的 _索引.json + 各门禁工具的判定 + 待办台账，拼成一份 _状态.json」
 * 不做：首页 HTML 渲染、组卷、复习落库（那些各有人做）。
 *
 * 单一实现原则（本仓铁律）：门禁判定**绝不在这里重写**，一律调现有工具的 --json 机器通道：
 *   · 盲解指纹新鲜度 ← `_盲解复核.mjs 门禁 --json` 的 .cards
 *   · 组卷准入       ← `_标记复习.mjs 准入 --json` 的 .admit
 *   · 配图状态       ← `_配图门禁.mjs 清单 --json`（扁平字典）
 *   · 待办台账       ← `_待确认.mjs 门禁 --json`
 * 任何一个通道失败都**响亮失败**，绝不静默产出"看起来一切正常"的空状态包
 * （这正是 2026-10-10 那次「门禁看着在、实际永远放行」的同族事故）。
 *
 * 用法：
 *   node 生成状态.mjs                  # 写 <库根>\_状态.json
 *   node 生成状态.mjs --data <库目录>   # 指定库
 *   node 生成状态.mjs --out -          # 输出到 stdout，不写盘
 *   node 生成状态.mjs --quiet          # 只报错，不报进度
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { libraryRoot, toolPath } from './_库根.mjs';
import { writeJsonAtomic, acquireLibLock } from './_安全写.mjs';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const valOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const QUIET = has('--quiet');
const OUT = valOf('--out', null);
const log = (...a) => { if (!QUIET) console.error(...a); };

/* --data 走环境变量同一条路：_库根.mjs 已经实现了优先级，不另开一套 */
const explicitData = valOf('--data', null);
if (explicitData) process.env.CTB_DATA = path.resolve(explicitData);

const ROOT = libraryRoot();
const STATE_FILE = path.join(ROOT, '_状态.json');
log('[生成状态] 库根=' + ROOT);

/* ══════════════ 1) 找一个学生一册 / 一学生一学科一册的索引 ══════════════ */

const SKIP_DIR = new Set(['.git', 'backups', '备份', '回收站', '收件箱', '出件箱', '_probe',
  'node_modules', 'students', '数据']);

/** 从某个起点递归找 _索引.json，最多 2 层（库根\学生、库根\学生\学科） */
function findIndexes(base, depth) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIR.has(e.name) || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const dir = path.join(base, e.name);
    const idx = path.join(dir, '_索引.json');
    if (fs.existsSync(idx)) out.push(idx);
    if (depth > 1) out.push(...findIndexes(dir, depth - 1));
  }
  return out;
}

const indexFiles = findIndexes(ROOT, 2).sort();
if (!indexFiles.length) {
  log('[生成状态] 库里没有 _索引.json');
}

/* ══════════════ 1.5) 取库写锁（★ 2026-10-31 codex A03，已实测复现）══════════════
 * 缺陷：生成器**从不取锁**。它与 CLI 写入并发时会出现"跨事务拼接的快照"：
 *   ① 生成器读旧 `_索引.json`（reviewCount=0）；
 *   ② CLI 拿到锁，完成批改事务（索引 reviewCount=1、台账 status=已批改）；
 *   ③ 生成器继续读台账（已是"已批改"）并写出 `_状态.json`
 *   ⇒ 同一份状态包里"试卷已批改"与"卡片还没复习"并存（实测：snapshotReview=0 + paperStatus=graded）。
 * 影响：`_状态.json` 虽是派生缓存，却是**界面唯一读的东西** —— 用户会看到自相矛盾的报表，
 *   而且下次重建前一直是错的（不是"慢一拍"，是"两份真源各取一半"）。
 * 修法：在**第一次读真源之前**取库写锁，持有到进程退出（含异常/提前 exit 路径）。
 *   子进程（四个门禁通道）靠 `_安全写.mjs` 的 token 继承机制直接放行，不会自死锁。
 *   注意：`--out -`（只输出到 stdout）是纯读，不取锁，避免阻塞只读调用。
 *   ⚠ 释放必须挂 `exit` 钩子：本文件有多处 `process.exit()`，`finally` 对它是无效的。
 * 判据：tests\neg-state-gen-mixed-snapshot.cjs（阴性自证：把锁摘掉必红）。 */
let releaseLibLock = null;
if (OUT !== '-') {
  releaseLibLock = acquireLibLock(ROOT, { label: '生成状态' });
  process.on('exit', () => { try { if (releaseLibLock) releaseLibLock(); } catch (e) { } });
}

/* ══════════════ 2) 索引 → data[]（一个学生一项，一个学科一项） ══════════════ */

function readJson(p) {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);        // 剥 BOM：带 BOM 的 JSON.parse 必抛
  return JSON.parse(t);
}

/** 卡片目录相对库根的路径 → 界面用的百分号编码资产路径 */
const enc = (rel) => rel.split(path.sep).join('/').split('/').map(encodeURIComponent).join('/');

/* ══════════════ 原卷溯源台账（_原卷台账.json）══════════════
 * ★ 2026-10-23 补：**换生成器时漏掉的一整块**。
 *   老 PowerShell 生成器（_生成首页.ps1）会把 `_原卷台账.json` 的每条记录并进对应卡的
 *   origPage / origBox / origImport / origBy 四个字段，界面的「🗂 整页原卷 / 红框对准 / 📥 原件」
 *   全靠它们。本生成器初版把这四个字段**硬写成 null** ⇒ 用 Node 生成器重建状态包后，
 *   整库 409 张「有整页原卷」的卡全部变成「未定位」（实测 e2e-ui：整页原卷定位率 0/419、灯箱全废）。
 *   冻结区当时没暴露，是因为它盘上那份 _状态.json 还是老生成器的产物（_genBy=undefined），
 *   测试读到的是旧文件而不是新生成器的输出 —— 换库重建状态包才把问题照出来。
 *   现在按台账把四个字段并回去；台账缺失/解析失败要显式记进 dataHealth，不许静默当"没有原卷"。 */
let ORIG = {};
try {
  const p = path.join(ROOT, '_原卷台账.json');
  if (fs.existsSync(p)) {
    const L = readJson(p);
    ORIG = (L && L.cards && typeof L.cards === 'object') ? L.cards : {};
  }
} catch (e) {
  ORIG = null;   // 交给 dataHealth 报红
}

function cardsOf(idx, idxDir, subjectName) {
  /* 两种索引形态：
     ① 多学科：{student, grade, subjects:{ 数学:{items:[]}, … }}   文件在  库\九年级\_索引.json
     ② 单学科：{student, grade, subject:'数学', items:[] }         文件在  库\七年级-学生B\数学\_索引.json
     卡目录位置：① 库\九年级\<学科>\<dir>\   ② 库\七年级-学生B\数学\<dir>\ */
  const multi = idx.subjects && typeof idx.subjects === 'object' && !Array.isArray(idx.subjects);
  const subj = subjectName || idx.subject;
  const items = multi ? ((idx.subjects[subj] || {}).items || []) : (idx.items || []);
  const baseRel = multi ? path.relative(ROOT, path.join(idxDir, subj))
    : path.relative(ROOT, idxDir);
  const stu = idx.student || '';

  return items.map((c) => {
    const cardDirRel = path.join(baseRel, c.dir || c.id || '');
    /* 派生字段：老生成器算的，界面直接用。
       img = 原卷截图（照片即题面就是靠它）；stem/stemHtml/fig 是加工过的题干，本卡还没有。 */
    const imgAbs = path.join(ROOT, cardDirRel, '原卷截图.jpg');
    const mdAbs = path.join(ROOT, cardDirRel, '错题记录.md');
    const stemAbs = path.join(ROOT, cardDirRel, '题干.jpg');
    const stemHtmlAbs = path.join(ROOT, cardDirRel, '题干.html');
    const figAbs = path.join(ROOT, cardDirRel, '配图.svg');

    const o = Object.assign({}, c);
    delete o.dir;
    o.id = c.id;
    o.img = fs.existsSync(imgAbs) ? enc(path.join(cardDirRel, '原卷截图.jpg')) : null;
    o.md = fs.existsSync(mdAbs) ? enc(path.join(cardDirRel, '错题记录.md')) : null;
    o.stem = fs.existsSync(stemAbs) ? enc(path.join(cardDirRel, '题干.jpg')) : null;
    o.stemHtml = fs.existsSync(stemHtmlAbs) ? fs.readFileSync(stemHtmlAbs, 'utf8').replace(/^\uFEFF/, '') : '';
    o.fig = fs.existsSync(figAbs) ? enc(path.join(cardDirRel, '配图.svg')) : null;
    /* 原卷溯源四字段：**从 _原卷台账.json 并回来**（不是 null）。
       台账键是「学生|卡号」；page=整页原卷、box=归一化红框、import=原件、by=定位方式。
       ⚠ 路径口径与老生成器一致：**百分号编码**（前端拿 decodeURIComponent 还原后再取图；
         写成原文也能显示，但会与历史状态包/断言口径不一致，实测会假红）。 */
    const og = (ORIG && ORIG[stu + '|' + c.id]) || null;
    o.pdf = null;
    o.origPage = og && og.page ? enc(String(og.page)) : null;
    o.origBox = og && og.box ? og.box : null;
    o.origImport = og && og.import ? enc(String(og.import)) : null;
    o.origBy = og && og.by ? og.by : null;
    /* 复习/盲解字段给默认值：老索引里可能整体缺这些键，界面读到 undefined 会显示怪东西 */
    o.reviews = Array.isArray(c.reviews) ? c.reviews : [];
    o.reviewStatus = c.reviewStatus || '未复习';
    o.reviewCount = c.reviewCount || 0;
    o.passStreak = c.passStreak || 0;
    o.lastReviewedAt = c.lastReviewedAt || '';
    o.nextDue = c.nextDue || '';
    o.masteredAt = c.masteredAt === undefined ? null : c.masteredAt;
    o.status = c.status || '在册';
    o.blindStatus = c.blindStatus || '未盲解';
    return o;
  });
}

const byStudent = new Map();
for (const f of indexFiles) {
  const idx = readJson(f);
  const idxDir = path.dirname(f);
  const student = idx.student || path.basename(idxDir);
  const multi = idx.subjects && typeof idx.subjects === 'object' && !Array.isArray(idx.subjects);
  const subjNames = multi ? Object.keys(idx.subjects) : [idx.subject || path.basename(idxDir)];

  if (!byStudent.has(student)) {
    byStudent.set(student, { name: student, grade: idx.grade || '', subjects: [] });
  }
  const bucket = byStudent.get(student);
  if (!bucket.grade && idx.grade) bucket.grade = idx.grade;

  for (const sn of subjNames) {
    const items = cardsOf(idx, idxDir, multi ? sn : null);
    if (!items.length) continue;
    /* 同名学科若已被另一个索引文件填过（多册分开存），追加而不是覆盖 */
    const exist = bucket.subjects.find((s) => s.name === sn);
    const dirRel = multi ? path.relative(ROOT, idxDir) : path.relative(ROOT, idxDir);
    if (exist) exist.items = exist.items.concat(items);
    else bucket.subjects.push({ name: sn, dir: dirRel, items: items });
  }
}

const data = Array.from(byStudent.values());
const totalCards = data.reduce((n, s) => n + s.subjects.reduce((m, x) => m + x.items.length, 0), 0);
log('[生成状态] 学生 ' + data.length + ' 个，学科 ' + data.reduce((n, s) => n + s.subjects.length, 0) + ' 个，卡 ' + totalCards + ' 张');

/* ══════════════ 3) 四个门禁通道（失败就响亮失败） ══════════════ */

function runChannel(tool, args, label) {
  const abs = toolPath(tool);
  if (!fs.existsSync(abs)) throw new Error('缺少工具 ' + tool + '（' + label + ' 取不到判据）');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [abs, ...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: Object.assign({}, process.env, { CTB_DATA: ROOT }) });
  } catch (e) {
    /* 门禁语义：退出码 1 = 有未通过项，但 stdout 仍是完好 JSON —— 必须当成功解析 */
    stdout = String(e.stdout || '');
    if (!stdout.trim()) {
      throw new Error(label + ' 通道失败（' + tool + ' ' + args.join(' ') + '）：' + String(e.message || e).slice(0, 300));
    }
  }
  const a = stdout.indexOf('{'), b = stdout.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error(label + ' 通道输出不含 JSON：' + stdout.slice(0, 200));
  return JSON.parse(stdout.slice(a, b + 1));
}

const blind = runChannel('_盲解复核.mjs', ['门禁', '--json'], '盲解指纹');
const pend = runChannel('_待确认.mjs', ['门禁', '--json'], '待办台账');
const fig = runChannel('_配图门禁.mjs', ['清单', '--json'], '配图状态');
const admit = runChannel('_标记复习.mjs', ['准入', '--json'], '组卷准入');

/* 三个分区必须是"扁平字典"，不能把信封原样灌进去
   （2026-10-10 修过一次的同族 bug：灌信封 ⇒ 前端查不到任何卡 ⇒ 门禁整体放行） */
const blindFresh = (blind && blind.cards && typeof blind.cards === 'object') ? blind.cards : {};
const figState = (fig && typeof fig === 'object' && !('ok' in fig && 'checked' in fig)) ? fig : {};
const admitMap = (admit && admit.admit && typeof admit.admit === 'object') ? admit.admit : {};

/* 解包失败要显式报红，不能按空表静默跑（v2 的 dataHealth 就是为这个存在的） */
const dataHealth = {
  blindFresh: (blind && typeof blind.cards === 'object') ? 'ok' : '盲解门禁输出缺 .cards',
  figState: 'ok',
  admit: (admit && typeof admit.admit === 'object') ? 'ok' : '准入输出缺 .admit',
  pending: (pend && Array.isArray(pend.items)) ? 'ok' : '待办门禁输出缺 .items',
};
/* 原卷溯源台账：读不到就显式降级（否则界面会显示"全部未定位"，看着像数据丢了）
 *
 * ⚠ 2026-10-27 修（用户拿发布包在干净电脑上首次启动，第一眼就是一条红条）：
 *   判据原先是"台账没内容就报降级"，于是**全新空库必然报红** —— 刚解压、还没录过一道题，
 *   当然没有 _原卷台账.json。用户看到的是「数据源读取降级 / 门禁处于放行态」，
 *   以为是数据坏了，实际是**还没开始用**。
 *   降级的定义是「本该有、却读不到」，所以门槛必须挂在**有没有卡**上：
 *     · 库里有卡 + 台账缺失 ⇒ 真降级（溯源链断了，界面会显示全部未定位）
 *     · 库里有卡 + 台账解析失败 ⇒ 真降级（文件坏了）
 *     · 库里没卡 ⇒ 正常（new install），不报
 *   解析失败这一条不看卡数：文件存在却解析不了，任何时候都是问题。 */
const totalCardsNow = data.reduce((n, s) => n + s.subjects.reduce((m, x) => m + x.items.length, 0), 0);
if (ORIG === null) dataHealth.origPage = '_原卷台账.json 解析失败';
else if (!Object.keys(ORIG).length && totalCardsNow > 0) dataHealth.origPage = '缺 _原卷台账.json（原卷溯源不可用）';

/* ══════════════ 4) 组卷台账 → papers[] ══════════════ */

let papers = [];
const ledgerFile = path.join(ROOT, '_组卷台账.json');
if (fs.existsSync(ledgerFile)) {
  try {
    const L = readJson(ledgerFile);
    const arr = Array.isArray(L) ? L : (L.papers || L.batches || []);
    papers = arr.map((b) => ({
      paperId: b.paperId || b.id, date: b.date, student: b.student, subject: b.subject,
      title: b.title, items: b.items || [], status: b.status, results: b.results || [],
      gradedAt: b.gradedAt || null, source: b.source || null, note: b.note || null,
    }));
  } catch (e) {
    dataHealth.papers = '组卷台账解析失败：' + String(e.message).slice(0, 120);
  }
}

/* ══════════════ 5) 组装并写盘 ══════════════ */

const state = {
  version: 3,
  generatedAt: new Date().toISOString(),
  data: data,
  papers: papers,
  blindFresh: blindFresh,
  pending: pend,
  figState: figState,
  dataHealth: dataHealth,
  admit: admitMap,
  _pendingSrc: {},
  _genBy: '生成状态.mjs',
};

const json = JSON.stringify(state);

if (OUT === '-') {
  process.stdout.write(json);
  process.exit(0);
}

writeJsonAtomic(STATE_FILE, state, { backup: false });
const kb = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);
log('[生成状态] 已写 ' + STATE_FILE + '（' + kb + ' KB）');
log('[生成状态] 卡 ' + totalCards + ' 张；准入可组卷 ' + (admit.can || 0) + '/' + (admit.total || 0) +
  '；待办未确认 ' + (pend.open || 0));
if (Object.values(dataHealth).some((v) => v !== 'ok')) {
  process.stderr.write('[生成状态] ⚠ 数据源降级：' + JSON.stringify(dataHealth) + '\n');
}
