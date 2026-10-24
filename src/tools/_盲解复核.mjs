#!/usr/bin/env node
/**
 * 错题本·盲解准入工具（v1.8）—— 「所有错题必须盲解一次」的唯一执行入口
 *
 * 原则（2026-10-06 用户拍板）：
 *   每道错题在进组卷池之前，必须由一个**不带录入上下文**的解题者只看题干独立做一遍，
 *   结果与索引 answer 逐字对照：一致 → 已通过（可组卷）；不一致 → 回原卷核实，
 *   是转录错误就修题干、是录入答案错就修答案，修完必须**重新盲解**才算数。
 *
 * 为什么必须盲解：录入者自证有盲区——解题视角与转录视角不同。
 *   实证：国庆假期作业2 首轮盲解揪出清稿 Q3 选项第三项误转录（原卷印 (+5)，转录看串行），
 *         而 22 题判定本身全部一致；学生B数学三卡首轮 16 小题全一致但抓出 M0002 空线错位。
 *
 * 状态词（写进 _索引.json 的 blindStatus，勿手写别的词）：
 *   未盲解   —— 入库后还没独立重做过（默认值，禁止组卷）
 *   待双路   —— 只跑完一路（v2.5 全量双路：另一路没跑，禁止组卷）
 *   已通过   —— **两路**独立解题结果都与录入 answer 一致（可组卷）
 *   不一致   —— 任一路与录入不符，待回原卷核实（禁止组卷）
 *   已修正   —— 曾不一致，核实后改了题干/答案，并**两路都重新盲解通过**（可组卷）
 *
 * v2.5（2026-10-09 用户拍板「全量双路」）：
 *   入库题必须由**两个互不通气的独立解题者**各做一遍（图形题每路仍是"文字层＋图形层"两层），
 *   两路一致才准入。起因：v1.9 全量复核实测 8 处"不一致"里有 3 处（学生B M0001/M0004/M0006）
 *   是**解题者自己算错**——单路盲解分不清"题错"还是"人错"。
 *   明细落独立真源 `_盲解双路.json`（键 = 学生|编号，lane1/lane2 各存 verdict/at/solver/note），
 *   本文件是**唯一写入入口**；_索引.json 的 blindStatus 存**合成后**的准入态，消费方（组卷门禁、
 *   首页徽章）零改动即可正确拦截「待双路」。
 *
 * 用法（node _盲解复核.mjs <动作> [参数]）：
 *   清稿   [--student 学生B] [--subject 数学] [--all] [--ids M0001,M0002]
 *          → 生成无答案清稿 <库根>\_盲解\<学生>-<学科>-盲解清稿.md
 *          默认只列"两路都还没过"的题；--all 列全部；--ids 点名。
 *   录入   --student 学生B --id M0001 --verdict 一致 [--lane 1|2] [--solver "子代理(无上下文)"] [--date] [--note]
 *   批量   --student 学生B --results "M0001=一致,M0002=不一致" [--lane 1|2] [--solver] [--date] [--note]
 *   双路   [--student 学生B] [--subject 数学] → 打印每卡两路明细与合成态（人读）
 *   迁移双路 [--dry]      → 把 v1.9 的单路结论搬进双路台账的 lane1（一次性；搬完这些卡变「待双路」）
 *   状态   [--student 学生B]        → 盲解覆盖率与逐题状态
 *   门禁   [--student 学生B]        → 有未通过（含待双路）的在册题则退出码 1（可接 CI/组卷前自检）
 *                                    空集（筛选 0 条）也判失败，除非显式 --allow-empty
 *                                    `--json` 与人类模式同一次判定、同一退出码，输出
 *                                    { ok, problems:[id[原因]], cards:{"学生|编号":新鲜度} }
 *   任意动作加 --refresh 会顺带重跑 _生成首页.ps1
 *
 * ⚠ 2026-10-09 修：`门禁 --json` 原先在判定之前 break，人类模式 exit 1 而机器通道 exit 0——
 *   消费方（_标记复习.mjs 的组卷口、_生成首页.ps1 的准入徽章）看到的是永远绿灯。见 §门禁五律。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { libraryRoot, toolPath } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic } from './_安全写.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 现在是**用户库根**，不再是"本脚本所在目录"。
   兄弟工具一律用 toolPath(...)，见 _库根.mjs。 */
const ROOT = libraryRoot();
const OUTDIR = path.join(ROOT, '_盲解');
const LANEDB = path.join(ROOT, '_盲解双路.json');
const VERDICTS = { '一致': '已通过', '通过': '已通过', '不一致': '不一致', '修正': '已修正', '已修正': '已修正', '待复核': '不一致' };
const VERIFIED = ['已通过', '已修正'];

/* ---------- v2.5 双路台账（唯一真源；本文件是唯一写入入口） ----------
   ⚠ 2026-10-10（BUG-01/02）：旧写法 `if (!j.lanes || typeof j.lanes !== 'object') j.lanes = {}`
   + `fs.writeFileSync` ⇒ 形状异常时把 205 条双路盲解结论当空台账，随后 saveLanes 直接把真源清空；
   写入还是「先截断再写」，写一半被杀就留半截 JSON。统一走 _安全写.mjs。 */
function loadLanes() {
  if (!fs.existsSync(LANEDB)) return { note: '盲解双路台账：键=学生|编号；lane1/lane2 各存 {verdict,at,solver,note,fixed}', lanes: {} };
  return readJsonStrict(LANEDB, { shape: j => !!j.lanes && typeof j.lanes === 'object' && !Array.isArray(j.lanes), what: 'lanes 对象', label: '_盲解双路.json' });
}
function saveLanes(o) { writeJsonAtomic(LANEDB, o, { backup: true }); }
/** 由两路明细合成准入态（blindStatus 的唯一来源）
 *  overruled：Lead 回原卷/复核后判定"该路结论是解题者自己错，卡本身没问题"——留痕但不算冲突。 */
function composeStatus(l) {
  const one = l && l.lane1, two = l && l.lane2;
  // pass：该路通过；或该路判「不一致」但经 Lead 裁定为**解题者自误**（overruled）→ 留痕但不算冲突
  const pass = x => x && (x.verdict === '已通过' || x.verdict === '已修正' || (x.verdict === '不一致' && x.overruled));
  const bad = x => x && x.verdict === '不一致' && !x.overruled;
  if (!one && !two) return '未盲解';
  if (bad(one) || bad(two)) return '不一致';
  if (!one || !two) return '待双路';
  if (pass(one) && pass(two)) return (one.verdict === '已修正' || two.verdict === '已修正' || one.fixed || two.fixed) ? '已修正' : '已通过';
  return '待双路';
}
/** 题干指纹 v1（只含纯文本）：**保留**用于比对老卡的历史指纹，不要改它的算法。
 *  v2（含图形）实现见下方 `fingerprint()`——那才是新记录使用的。 */
const fingerprintV1Legacy = text => crypto.createHash('sha256').update(String(text).replace(/\s+/g, ' ').trim(), 'utf8').digest('hex').slice(0, 12);
const blindVerified = it => VERIFIED.includes(it.blindStatus) && !!it.blindFingerprint;

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
const dstr = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const today = () => dstr(new Date());

function readJson(p) { return readJsonStrict(p, { label: path.basename(p) }); }
function writeJson(p, o) { writeJsonAtomic(p, o, { backup: true }); }
/* 索引形状守卫：两种合法形态（学科级 items[] / 学生级 subjects{}）之外一律拒绝，
   免得"卡片还在文件里但谁都看不见"却被照样重写（同 _标记复习.mjs 的理由）。 */
const IDX_SHAPE = j => Array.isArray(j.items) || (!!j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects));
const readIndexFile = p => readJsonStrict(p, { shape: IDX_SHAPE, what: 'items 数组或 subjects 对象', label: path.basename(p) });

function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) { if (e.name === '_索引.json') acc.push(path.join(dir, e.name)); continue; }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    if (/(作业|假期)/.test(e.name)) continue;
    indexFiles(path.join(dir, e.name), acc);
  }
  return acc;
}
/** 索引（已解析对象）→ [{item, subject, student, dirAbs}]，兼容学科级(items)与学生级(subjects)两种形态。
 *  注意：必须传已解析对象，传入文件路径会返回副本、改动不落盘（曾因此静默丢写）。 */
function itemsOfJson(j, base) {
  const out = [];
  if (Array.isArray(j.items)) {
    for (const it of j.items) out.push({ item: it, subject: j.subject || '', student: j.student, dirAbs: path.join(base, it.dir) });
  }
  if (j.subjects) {
    for (const [name, v] of Object.entries(j.subjects)) {
      for (const it of (v.items || [])) out.push({ item: it, subject: name, student: j.student, dirAbs: path.join(base, name, it.dir) });
    }
  }
  return out;
}
function itemsOf(file) { return itemsOfJson(readJson(file), path.dirname(file)); }
function allItems() { const a = []; for (const f of indexFiles(ROOT)) { const list = itemsOf(f); for (const x of list) a.push({ ...x, file: f }); } return a; }

/** 该卡是否图形题：题干.html 含 svg/img，或存在题图.jpg —— 决定"图形层"是否必需。
 *  v2.5 起因：本轮全量双路里，图形层分片两次卡死（fig-07/09 等），而门禁只认"有没有结论"、
 *  不认"图形层有没有跑到"，于是 7 题被核成"无法判定"却无人报警，白跑一轮。 */
function isFigureCard(dirAbs) {
  const hp = path.join(dirAbs, '题干.html');
  if (fs.existsSync(hp)) {
    const h = fs.readFileSync(hp, 'utf8');
    if (/<svg[\s\S]*?<\/svg>/i.test(h) || /<img\b/i.test(h)) return true;
  }
  return fs.existsSync(path.join(dirAbs, '题图.jpg'));
}
function splitIds(s) { return String(s || '').split(/[,;\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean); }
function findFile(student) {
  for (const f of indexFiles(ROOT)) { const j = readJson(f); if (j.student === student) return f; }
  fail('找不到学生索引：' + student);
}
/* 2026-10-23 修（多学科学生）：`findFile` 只返回**第一个**该学生的索引文件。
   一个学生有多个学科级索引时（实测：学生B = 七年级-学生B\数学 + 七年级-学生B\英语），
   查卡会只查第一个命中的那个（数学），于是英语的 E0001 被判「编号不在学生B库中」。
   改为：把该学生的**全部**索引合并成一张 map，键仍用裸编号（同学科内唯一即可；
   跨学科编号前缀不同：M/C/P/E，天然不撞）。 */
function indexFilesOf(student) {
  const out = [];
  for (const f of indexFiles(ROOT)) { const j = readJson(f); if (j.student === student) out.push(f); }
  if (!out.length) fail('找不到学生索引：' + student);
  return out;
}
function mergedItems(student) {
  const map = {}, info = {}, docs = {}, dup = [];
  for (const f of indexFilesOf(student)) {
    const j = readJson(f);
    docs[f] = j;                       // 保留已解析对象，改动的 item 就是它的引用，回写才有意义
    for (const { item, dirAbs, subject } of itemsOfJson(j, path.dirname(f))) {
      if (map[item.id]) dup.push(item.id);
      map[item.id] = item;
      info[item.id] = { dirAbs, subject, file: f };
    }
  }
  if (dup.length) fail('学生 ' + student + ' 的多个索引里编号重复：' + [...new Set(dup)].join(','));
  return { map, info, docs };
}

/* ---------- 题干 → 纯文本（清稿用；不泄漏答案） ---------- */
export function stemToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<svg[\s\S]*?<\/svg>/g, '\n【此处为图形区域，本清稿不含图；若题设文字不足以定解，请明确指出缺什么信息】\n');
  s = s.replace(/<span class="fr">\s*<span class="nu">([\s\S]*?)<\/span>\s*<span class="de">([\s\S]*?)<\/span>\s*<\/span>/g, '($1)/($2)');
  s = s.replace(/<sup>([\s\S]*?)<\/sup>/g, '^($1)');
  s = s.replace(/<span class="blank"[^>]*>\s*<\/span>/g, '________');
  s = s.replace(/<span class="rd">([\s\S]*?)<\/span>/g, '$1\u0307');
  s = s.replace(/<\/(p|div|tr|table|h[1-6]|article|section)>/g, '\n');
  s = s.replace(/<br\s*\/?>/g, '\n');
  s = s.replace(/<\/t[dh]>/g, ' | ');
  s = s.replace(/<t[dh][^>]*>/g, '');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.split('\n').map(x => x.trim()).filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').trim();
  return s;
}
function stemOf(x) {
  const p = path.join(x.dirAbs, '题干.html');
  if (fs.existsSync(p)) {
    const txt = stemToText(fs.readFileSync(p, 'utf8'));
    if (txt) return { text: txt, src: '题干.html' };
  }
  // 无题干.html 时退回「错题记录.md 的 **原题**：」段（逐字转录，比索引 question 摘要完整）
  const rec = originalFromRecord(x.dirAbs);
  if (rec) return { text: rec, src: '错题记录.md 原题' };
  return { text: String(x.item.question || '').trim(), src: '索引 question' };
}
/** 从错题记录.md 抽「**原题**：」段（只取题干，不含解答/正解） */
function originalFromRecord(dirAbs) {
  const p = path.join(dirAbs, '错题记录.md');
  if (!fs.existsSync(p)) return '';
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const i = lines.findIndex(l => /^\*\*原题\*\*/.test(l.trim()));
  if (i < 0) return '';
  const out = [lines[i].trim().replace(/^\*\*原题\*\*[：:]\s*/, '')];
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k].trim();
    if (l === '' || /^#/.test(l) || /^\*\*/.test(l)) break;
    out.push(l);
  }
  return out.join(' ').trim();
}

/** 台账（真源）→ 索引 blindStatus（派生缓存）的同步；返回 {changed, drift} */
function syncIndexFromLanes(lanes, { dry = false } = {}) {
  let changed = 0, drift = 0;
  for (const f of indexFiles(ROOT)) {
    const j = readJson(f);
    let touched = false;
    for (const { item } of itemsOfJson(j, path.dirname(f))) {
      const key = j.student + '|' + item.id;
      const l = lanes.lanes[key];
      if (!l) continue;
      const want = composeStatus(l);
      if (item.blindStatus !== want) {
        if (VERIFIED.includes(item.blindStatus) || VERIFIED.includes(want)) drift++;
        if (!dry) { item.blindStatus = want; touched = true; }
        changed++;
      }
    }
    if (touched) { j.updatedAt = today(); writeJson(f, j); }
  }
  return { changed, drift };
}

/* ---------- 动作 ---------- */
const fail = msg => { console.error('✖ ' + msg); process.exit(2); };
const targets = () => allItems().filter(x =>
  (!opt.student || x.student === opt.student) &&
  (!opt.subject || x.subject === opt.subject) &&
  (!opt.ids || splitIds(opt.ids).includes(x.item.id)));
/** 题干指纹（**v2：含图形**）。
 *  ⚠ BUG-08（2026-10-11 修）：v1 指纹只对 `stemToText()` 的**纯文本**取哈希，而 `stemToText` 把
 *  `<svg>…</svg>` / `<img>` 整段剥掉了 ⇒ **只改图形、不改文字**的题干改动**不会**让盲解结论失效。
 *  物理/化学/数学大量卡是"文字 + 内联 SVG 配图"，图形本身往往就是条件（力臂画在哪、图线走向…），
 *  这是盲解准入铁律的真实漏洞。
 *  v2 把「图形签名」并入指纹：抽取题干 HTML 里的所有 `<svg>`/`<img>` 片段，规范化空白后哈希。
 *  **向后兼容**：老卡只有 v1 指纹（没有 `blindFingerprintVer`），仍按 v1 算法比对，不会被集体判失效；
 *  新落的盲解结论写 `blindFingerprintVer=2`，从此享受图形级保护。
 *  `--upgrade-fp` 可把老卡的指纹显式升级到 v2（**记录升级时刻**，并标记"基线时刻不可考"）。 */
function figureSignature(x) {
  const p = path.join(x.dirAbs, '题干.html');
  if (!fs.existsSync(p)) return '';
  const h = fs.readFileSync(p, 'utf8');
  const parts = [];
  for (const m of h.matchAll(/<svg[\s\S]*?<\/svg>/gi)) parts.push(m[0]);
  for (const m of h.matchAll(/<img\b[^>]*>/gi)) parts.push(m[0]);
  return parts.map(s => s.replace(/\s+/g, ' ').trim()).join('\n');
}
const fingerprintV1 = fingerprintV1Legacy;   // 兼容别名：老卡比对用
const fingerprint = (text, fig = '') => fingerprintV1(String(text) + '\u0000' + String(fig));
/** 该卡当前应有的指纹（按其记录的指纹版本算，保证同版本可比） */
function currentFingerprint(x) {
  const st = stemOf(x);
  return Number(x.item.blindFingerprintVer) >= 2 ? fingerprint(st.text, figureSignature(x)) : fingerprintV1(st.text);
}
/** 题干文件是否在盲解之后被改过（按 mtime 的**日期**比，粗但独立于指纹）。
 *  为什么要它：v1 指纹只覆盖纯文本（见 BUG-08），对老卡而言"只改图形"不会被指纹发现；
 *  而 mtime 是**另一条独立证据**——题干文件在盲解之后被动过，就值得人看一眼。
 *  注意：mtime 变化也可能是"内容没变的重写"（格式化、还原备份），所以这里**只告警不阻断**。 */
function stemMtimeAfterBlind(x) {
  const p = path.join(x.dirAbs, '题干.html');
  if (!fs.existsSync(p)) return false;
  const at = String(x.item.blindSolveAt || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return false;
  const d = new Date(fs.statSync(p).mtime);
  const mday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return mday > at;
}

/** 盲解结论是否仍然有效：状态已通过/已修正，且题干指纹与盲解当时一致（题干或**图形**被改过即失效） */
function freshState(x) {
  const it = x.item;
  if (!VERIFIED.includes(it.blindStatus)) return it.blindStatus || '未盲解';
  if (!it.blindFingerprint) return '待重盲解';                 // 旧记录无指纹（v1.8 补跑前）
  return it.blindFingerprint === currentFingerprint(x) ? '有效' : '待重盲解';
}

switch (action) {

  case '清稿': {
    const groups = new Map();
    for (const x of targets()) {
      if (!opt.all && !opt.ids && freshState(x) === '有效') continue;   // 默认跳过"两路都过且题干未变"的；--ids 是点名重盲解，不跳
      const k = x.student + '|' + x.subject;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    if (!groups.size) { console.log('没有需要盲解的题（两路都已通过）'); break; }
    fs.mkdirSync(OUTDIR, { recursive: true });
    const laneTag = String(opt.lane || '1') === '2' ? '第2路' : '第1路';
    for (const [k, list] of groups) {
      const [student, subject] = k.split('|');
      list.sort((a, b) => String(a.item.id).localeCompare(String(b.item.id)));
      const lines = [];
      lines.push(`# ${student} · ${subject} · 盲解清稿（${laneTag}·独立重做用）`);
      lines.push('');
      lines.push('> 本清稿**只含题干，不含任何答案、孩子答案与错因**。请独立完成全部题目。');
      lines.push('> 输出要求：逐题给出你的最终答案（选择题给选项字母），并标出任何"印刷不清/数字矛盾/条件不足/图形缺失"的疑点。');
      lines.push(`> 生成时间：${today()} ｜ 题数：${list.length}`);
      lines.push('');
      lines.push('---');
      for (const x of list) {
        const st = stemOf(x);
        lines.push('');
        lines.push(`## ${x.item.id}　（来源：${x.item.source || '—'}）`);
        lines.push('');
        lines.push(st.text || '（题干为空）');
        lines.push('');
        lines.push(`【作答】`);
        lines.push('');
      }
      // --ids 是"定点重盲解"，写到单独文件，避免把整册清稿覆盖成子集；--lane 2 也单独落文件
      const suffix = opt.ids ? '-重盲解' : (String(opt.lane || '1') === '2' ? '-第2路' : '');
      const out = path.join(OUTDIR, `${student}-${subject}-盲解清稿${suffix}.md`);
      fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
      console.log(`已生成清稿（${list.length} 题 · ${laneTag}）：${out}`);
    }
    break;
  }

  case '录入':
  case '批量': {
    if (!opt.student) fail('录入需要 --student');
    const pairs = action === '录入'
      ? [[String(opt.id || '').toUpperCase(), opt.verdict || (opt.consistent ? '一致' : '不一致')]]
      : String(opt.results || '').replace(/＝/g, '=').split(/[,;]/).filter(s => s.trim()).map(p => {
        const i = p.indexOf('='); if (i < 0) fail('格式应为 编号=一致|不一致|修正，收到：' + p);
        return [p.slice(0, i).trim().toUpperCase(), p.slice(i + 1).trim()];
      });
    /* 2026-10-23：改用 mergedItems —— 一个学生可能有多个学科级索引（学生B=数学+英语），
       原实现只读第一个命中的索引，导致英语卡被判「不在库中」。 */
    const { map, info, docs } = mergedItems(opt.student);
    const date = opt.date || today();
    const solver = opt.solver || '子代理(无上下文)';
    const lane = String(opt.lane || '1') === '2' ? 'lane2' : 'lane1';
    const lanes = loadLanes();
    const log = [];
    for (const [id, v] of pairs) {
      const it = map[id];
      if (!it) fail('编号 ' + id + ' 不在 ' + opt.student + ' 库中');
      const st = VERDICTS[v];
      if (!st) fail('非法盲解结论：' + id + '=' + v + '（只能 一致/不一致/修正）');
      const key = opt.student + '|' + id;
      /* v2 指纹（含图形）：新落的结论一律记 fpVer=2，从此"只改图形不改文字"也会让结论失效（BUG-08） */
      const fp = fingerprint(stemOf({ dirAbs: info[id].dirAbs, item: it }).text, figureSignature({ dirAbs: info[id].dirAbs }));
      const rec = lanes.lanes[key] || (lanes.lanes[key] = {});
      rec[lane] = { verdict: st, at: date, solver, note: opt.note || '', fp, fpVer: 2, fixed: st === '已修正' || (rec[lane] && rec[lane].fixed) || false };
      if (opt.layer) rec[lane].layer = String(opt.layer);            // text | fig —— 图形题必须登记图形层
      if (opt.overruled) { rec[lane].overruled = true; rec[lane].overruledNote = String(opt.note || ''); }
      const composed = composeStatus(rec);
      it.blindStatus = composed;
      it.blindSolveAt = date;
      it.blindSolver = solver;
      it.blindNote = `[${lane === 'lane1' ? '第1路' : '第2路'}] ` + (opt.note || (st === '已通过' ? '独立解题与录入答案一致' : st === '不一致' ? '与录入不符，待回原卷核实' : '曾不一致，核实后重盲解通过'))
        + (composed === '待双路' ? ' ｜ 另一路未跑，禁止组卷' : '');
      it.blindFingerprint = fp;
      it.blindFingerprintVer = 2;
      log.push(`   ${id} ${lane} → ${st} ｜ 合成=${composed}  fp=${fp}`);
    }
    /* 2026-10-23：多索引下"哪些文件要回写"不再唯一 —— 只回写本次实际改到的卡所属文件，
       且必须写回**已解析的那个对象**（docs[f]），否则改动落在副本上、静默丢写。 */
    const touchedFiles = new Set();
    for (const [id] of pairs) if (info[id]) touchedFiles.add(info[id].file);
    for (const f of touchedFiles) {
      const jj = docs[f];
      if (!jj) continue;
      jj.updatedAt = today();
      writeJson(f, jj);
    }
    saveLanes(lanes);
    console.log(`已录入盲解结论 ${pairs.length} 条（${opt.student} · ${lane} · ${date}）`);
    console.log(log.join('\n'));
    break;
  }

  case '双路': {
    const lanes = loadLanes();
    const rows = targets();
    let both = 0, one = 0, none = 0;
    const figMissing = [];
    for (const x of rows) {
      const key = x.student + '|' + x.item.id;
      const l = lanes.lanes[key] || {};
      const composed = composeStatus(l);
      const tag = l.lane1 && l.lane2 ? '双路' : (l.lane1 || l.lane2) ? '单路' : '无路';
      if (tag === '双路') both++; else if (tag === '单路') one++; else none++;
      // 图形题必须登记"图形层"记录（layer='fig'）：历史批次未登记层别，故只提示不拦
      const figCard = isFigureCard(x.dirAbs);
      const hasFigLayer = ['lane1', 'lane2'].some(ln => l[ln] && l[ln].layer === 'fig');
      if (figCard && !hasFigLayer) figMissing.push(key);
      if (opt.json) continue;
      console.log(`${x.item.id}  [${tag}] 合成=${composed}${figCard ? (hasFigLayer ? ' · 图形层✓' : ' · ⚠图形层未登记') : ''}`);
      for (const ln of ['lane1', 'lane2']) if (l[ln]) console.log(`     ${ln === 'lane1' ? '第1路' : '第2路'}: ${l[ln].verdict} · ${l[ln].at} · ${l[ln].solver}${l[ln].layer ? ' · ' + l[ln].layer : ''}${l[ln].note ? ' · ' + String(l[ln].note).slice(0, 90) : ''}`);
    }
    if (opt.json) console.log(JSON.stringify({ ok: one === 0 && none === 0, checked: rows.length, both, one, none, figMissing, lanes: lanes.lanes }, null, 1));
    else {
      console.log(`\n合计 ${rows.length} 题：双路 ${both} ｜ 单路 ${one} ｜ 无路 ${none}`);
      if (figMissing.length) console.log(`⚠ 图形题未登记"图形层"记录：${figMissing.length} 张（历史批次；新批次落库请加 --layer fig，否则 门禁 无法证明图形层真的跑过）`);
    }
    break;
  }

  case '迁移双路': {
    /* 一次性：把 v1.9 的单路结论（blindStatus/blindSolveAt/blindSolver/blindNote）搬进台账 lane1。
       搬完这些卡的合成态会变「待双路」——这是设计意图：新规则下它们确实只跑了一路。 */
    const lanes = loadLanes();
    let n = 0, skipped = 0;
    for (const f of indexFiles(ROOT)) {
      const j = readJson(f);
      for (const { item } of itemsOfJson(j, path.dirname(f))) {
        if (!VERIFIED.includes(item.blindStatus)) continue;
        const key = j.student + '|' + item.id;
        if (lanes.lanes[key] && lanes.lanes[key].lane1) { skipped++; continue; }
        lanes.lanes[key] = {
          lane1: { verdict: item.blindStatus, at: item.blindSolveAt || '', solver: item.blindSolver || '（v1.9 单路，来源未记）', note: item.blindNote || '', fp: item.blindFingerprint || '', fixed: item.blindStatus === '已修正' },
        };
        n++;
      }
    }
    if (opt.dry) { console.log(`[dry] 将迁移 ${n} 条（已存在 ${skipped} 条）`); break; }
    saveLanes(lanes);
    const sync = syncIndexFromLanes(lanes);
    console.log(`已迁移 ${n} 条单路结论进 lane1（跳过 ${skipped} 条已存在）→ 索引态同步 ${sync.changed} 条，现为「待双路」`);
    console.log('下一步：跑第 2 路（清稿 --lane 2 → 独立解题 → 批量 --lane 2），两路一致才恢复「已通过」');
    break;
  }

  case '同步双路': {
    const lanes = loadLanes();
    const r = syncIndexFromLanes(lanes, { dry: !!opt.dry });
    console.log(`${opt.dry ? '[dry] ' : ''}台账→索引同步：${r.changed} 条需要改（其中涉及"已通过↔其它"的漂移 ${r.drift} 条）`);
    break;
  }

  case '指纹': {
    /* 给"已通过/已修正但没有指纹"的老记录补指纹（v1.8 补跑期录入的条目）。
       ⚠ BUG-09（2026-10-11）：本动作的语义是"**以当前题干为准**登记指纹"——如果题干其实在盲解之后
       被改过，这一步会把"已失效的旧结论"洗成"有效"，**而且不留任何痕迹**。它无法自证，只能：
         ① 默认**拒绝执行**（要 `--force` 显式承认"我确认这些卡自盲解后没改过题干"）；
         ② 落库时写 `blindFpAssumed=true` + `blindFpAssumedAt`，让"这条有效性是假设来的"永久可见；
         ③ `门禁 --json` 与 `_体检.mjs` 把"假设指纹"单独计数并提示。
       宁可多一个 `--force`，也不要把"无法证实的有效"混进"已验证"。 */
    const all = [];
    for (const f of indexFiles(ROOT)) {
      const j = readJson(f);
      for (const { item, dirAbs } of itemsOfJson(j, path.dirname(f))) all.push({ item, dirAbs });
    }
    /* --upgrade：把 v1（只含文字）指纹升级到 v2（含图形）。语义同"补指纹"——图形在盲解当时
       有没有变过同样无法自证，所以一并要 --force 且打 blindFpAssumed 标记。 */
    const need = opt.upgrade
      ? all.filter(x => VERIFIED.includes(x.item.blindStatus) && x.item.blindFingerprint && Number(x.item.blindFingerprintVer || 1) < 2)
      : all.filter(x => VERIFIED.includes(x.item.blindStatus) && !x.item.blindFingerprint);
    if (!need.length) { console.log(opt.upgrade ? '没有需要升级到 v2 的指纹' : '没有需要补指纹的条目'); break; }
    console.log(`待补指纹 ${need.length} 条：` + need.map(x => x.item.id).join(' '));
    if (!opt.force) {
      console.error('✖ 补指纹会**以当前题干为准**登记——若题干自盲解后被改过，这一步等于把失效结论洗成有效。');
      console.error('  本动作无法自证"题干没改过"。两条正确路径：');
      console.error('   ① 重新盲解（推荐）：node _盲解复核.mjs 清稿 --ids ' + need.slice(0, 4).map(x => x.item.id).join(',') + ' → 录入');
      console.error('   ② 确认这些卡自盲解后没动过题干，再跑：node _盲解复核.mjs 指纹 --force（会打上"假设"标记，门禁单独计数）');
      process.exit(2);
    }
    let n = 0;
    for (const f of indexFiles(ROOT)) {
      const j = readJson(f);
      const base = path.dirname(f);
      let touched = false;
      for (const { item, dirAbs } of itemsOfJson(j, base)) {
        if (!VERIFIED.includes(item.blindStatus)) continue;
        const isUpgrade = !!item.blindFingerprint && Number(item.blindFingerprintVer || 1) < 2;
        if (opt.upgrade ? !isUpgrade : !!item.blindFingerprint) continue;
        const fp = fingerprint(stemOf({ dirAbs, item }).text, figureSignature({ dirAbs }));
        item.blindFingerprint = fp;
        item.blindFingerprintVer = 2;
        item.blindFpAssumed = true;                 // ← 关键留痕：这条有效性是"假设题干/图形未改"得来的
        item.blindFpAssumedAt = today();
        n++; touched = true;
        console.log(`   ${item.id} fp=${fp}（${isUpgrade ? 'v1→v2 升级' : '补录'}，假设标记已写入）`);
      }
      if (touched) { j.updatedAt = today(); writeJson(f, j); }
    }
    console.log(n ? `已补 ${n} 条盲解指纹（全部带 blindFpAssumed=true；_体检.mjs 会单独列计数）` : '没有需要补指纹的条目');
    break;
  }

  case '状态':
  case '门禁': {
    /* 门禁五律（2026-10-09 定版）—— 起因：`门禁 --json` 曾在判定之前 break，
       于是人类模式 exit 1、机器通道 exit 0，唯一被其它工具消费的通道永远绿灯。 */
    const rows = targets();
    const problems = [];
    const cards = {};
    /* 台账（真源）与索引缓存的一致性：不一致就是"有人绕开工具手改了索引"，必须点名 */
    const lanesDB = loadLanes();
    for (const x of rows) {
      const l = lanesDB.lanes[x.student + '|' + x.item.id];
      if (!l) continue;
      const want = composeStatus(l);
      if ((x.item.blindStatus || '未盲解') !== want) problems.push(`${x.student}|${x.item.id}[台账=${want} 索引=${x.item.blindStatus || '未盲解'}]`);
    }
    for (const x of rows) cards[x.student + '|' + x.item.id] = freshState(x);
    /* ⚠ 计数**不能塞进 `cards`**：那本字典的契约是「键=学生|编号、值=新鲜度字符串」，
       且它会被 `_生成首页.ps1` 直接注入 `BLINDFRESH` 给前端按卡查表。
       塞进去会让键集合多出 `__fpV1` 之类（**契约门禁当场抓到，2026-10-11**），也污染下发给前端的字典。
       故统一放信封的独立字段 `meta`。 */
    const meta = {};
    /* 「假设指纹」单独计数（BUG-09）：这些卡的有效性建立在"我确认题干没改过"之上，不是可验证的事实。
       不能和"已验证"混在一起报平安，否则补指纹就成了洗白通道。 */
    const assumed = rows.filter(x => x.item.blindFpAssumed);
    if (assumed.length) {
      meta.assumedFp = assumed.length;
      if (!opt.json) console.log(`   ⚠ 其中 ${assumed.length} 张是"假设指纹"（blindFpAssumed，题干/图形是否改过未经验证）：` + assumed.slice(0, 10).map(x => x.item.id).join(' ') + (assumed.length > 10 ? ' …' : ''));
    }
    /* 指纹版本（BUG-08 可见性）：v1 指纹**不覆盖图形** ⇒ 这些卡"只改图形"不会被发现。
       不阻断（否则全库老卡立刻不能组卷），但必须让人知道"哪一批卡的保护是弱一档的"。 */
    const v1fp = rows.filter(x => VERIFIED.includes(x.item.blindStatus) && Number(x.item.blindFingerprintVer || 1) < 2);
    if (v1fp.length) {
      meta.fpV1 = v1fp.length;
      meta.fpV1Ids = v1fp.slice(0, 20).map(x => x.item.id);
      if (!opt.json) console.log(`   ⚠ 其中 ${v1fp.length} 张仍是 v1 指纹（只覆盖文字，**不覆盖图形**）：` + v1fp.slice(0, 8).map(x => x.item.id).join(' ') + (v1fp.length > 8 ? ' …' : '') + `  ← 升级：node _盲解复核.mjs 指纹 --upgrade --force（打"假设"标记），或重盲解`);
    }
    /* 独立证据：题干文件在盲解之后被动过（mtime），但指纹说"有效" ⇒ 两者矛盾，值得人看一眼。
       对 v1 指纹的卡这条尤其重要——它正是"只改图形"唯一能留下的痕迹。 */
    const mtimeSuspect = rows.filter(x => VERIFIED.includes(x.item.blindStatus) && freshState(x) === '有效' && stemMtimeAfterBlind(x));
    if (mtimeSuspect.length) {
      meta.mtimeSuspect = mtimeSuspect.length;
      meta.mtimeSuspectIds = mtimeSuspect.slice(0, 20).map(x => x.item.id);
      if (!opt.json) console.log(`   ⚠ ${mtimeSuspect.length} 张题干文件在盲解**之后**被改动过（mtime 证据），而指纹仍判"有效"：` + mtimeSuspect.slice(0, 8).map(x => x.item.id).join(' ') + '  ← 若改的是图形（v1 指纹看不见）应重盲解');
    }

    /* 图形题必须有"图形层"记录（v2.5）：只在 双路 动作里点名，因为历史批次未登记层别。
       判据：台账里任一路带 layer='fig'；没有则提示需补图形层。 */
    if (action === '双路') {
      const missFig = rows.filter(x => isFigureCard(x.dirAbs) &&
        !['lane1', 'lane2'].some(ln => { const r = lanesDB.lanes[x.student + '|' + x.item.id]; return r && r[ln] && r[ln].layer === 'fig'; }));
      if (missFig.length) {
        if (opt.json) missFig.forEach(x => problems.push(`${x.student}|${x.item.id}[图形题缺图形层记录]`));
        else console.log(`\n⚠ 图形题缺"图形层"记录（历史批次未登记层别，新批次请用 --layer fig）：${missFig.length} 张`);
      }
    }

    // L3 空集即失败：筛选命中 0 条 ≠「全部通过」（学生/学科写错曾经等于免检）
    const allowEmpty = opt['allow-empty'] || opt.allowEmpty;
    if (!rows.length) {
      if (action === '门禁' && !allowEmpty) problems.push('筛选命中 0 条：--student/--subject/--ids 是否写错？（空集不算通过；确实要放行加 --allow-empty）');
      else console.log('（无匹配题目）');
    }

    const byGroup = new Map();
    for (const x of rows) {
      const k = `${x.student} · ${x.subject}`;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(x);
    }
    let bad = 0, liveAll = 0;
    for (const [k, list] of byGroup) {
      const cnt = { '已通过': 0, '已修正': 0, '不一致': 0, '未盲解': 0, '待双路': 0 };
      list.forEach(x => { const s = x.item.blindStatus || '未盲解'; cnt[s] = (cnt[s] || 0) + 1; });
      const live = list.filter(x => x.item.status !== '已归档');
      const stale = live.filter(x => freshState(x) === '待重盲解');
      const ok = live.filter(x => freshState(x) === '有效').length;
      bad += live.length - ok; liveAll += live.length;
      if (!opt.json) {
        console.log(`── ${k}（在册 ${live.length} 题 · 盲解有效 ${ok}/${live.length}${live.length ? ' = ' + Math.round(100 * ok / live.length) + '%' : ''}）`);
        console.log(`   已通过 ${cnt['已通过']} ｜ 已修正 ${cnt['已修正']} ｜ 待双路 ${cnt['待双路']} ｜ 不一致 ${cnt['不一致']} ｜ 未盲解 ${cnt['未盲解']}${stale.length ? ' ｜ ⚠ 待重盲解(题干已改) ' + stale.length : ''}`);
      }
      if (action === '门禁') {
        const miss = live.filter(x => freshState(x) !== '有效');
        if (miss.length) {
          // 逐题写进 problems：机器通道要能指名道姓，人类模式同一份数据换成人话
          miss.forEach(x => problems.push(`${x.student}|${x.item.id}[${freshState(x)}]`));
          if (!opt.json) console.log('   ⛔ 未通过盲解：' + miss.map(x => `${x.item.id}[${freshState(x)}]`).join(' '));
        }
      } else if (!opt.json) {
        list.sort((a, b) => String(a.item.id).localeCompare(String(b.item.id)));
        list.forEach(x => console.log(`   ${x.item.id} ${(x.item.blindStatus || '未盲解').padEnd(4)} ${freshState(x).padEnd(5)} ${x.item.blindSolveAt || ''} ${x.item.blindNote || ''}`));
      }
    }
    // L1+L2 单一判定、同码同判：judge 只算一次，人类模式与 --json 用同一份 problems、同一个退出码
    if (opt.json) {
      console.log(JSON.stringify({
        ok: problems.length === 0, action, checked: rows.length,
        meta,
        liveCount: liveAll, okCount: liveAll - bad, problems, cards,
      }));
    } else if (action === '门禁') {
      if (problems.length) console.log(`\n门禁未通过：${bad > 0 ? bad + ' 题尚未通过盲解' : problems.length + ' 项问题'}，不得进组卷池。`);
      else console.log('\n门禁通过：在册错题全部通过盲解。');
    }
    if (problems.length) process.exitCode = 1;
    break;
  }

  default:
    console.log('未知动作：' + action + '\n可用：清稿 / 录入 / 批量 / 双路 / 迁移双路 / 状态 / 门禁 / 指纹');    process.exitCode = 2;
}

if (opt.refresh) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', toolPath('_生成首页.ps1')], { stdio: 'ignore' });
  console.log(r.status === 0 ? '首页已刷新' : '首页刷新失败，请手动重跑 _生成首页.ps1');
}
