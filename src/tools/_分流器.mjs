/* 拾光小册 · 分流器（一次交一堆混科照片 → 按学科分好组，各走现有录题链路）
 *
 * 它解决什么（2026-11-05 用户场景）：
 *   「我把某个学生的很多题目照片一起给你，但没有分课，语文数学等各种学科混在一起，
 *     你能分门别类的挑出错题，改进拾光小册吗？」
 *
 *   现有链路是**严格一图一科**的：
 *     · `_配方.mjs 组装 --recipe ingest-page --subject 数学 --image X` 一图一科一任务单
 *     · `_录题任务.mjs` 的任务记录里 `image.sha256` / `subject` 都是**单值**
 *     · `_录题入库.mjs` 有一道硬检查：卡的 `subject` 必须等于本次入库学科，否则拒收
 *   所以一坨混科照片**不能**直接进库。本工具是那层**分流**：
 *     ① 照片级判重（路径 / 内容指纹 / 批次级 —— 复用现有台账口径）
 *     ② 判科（读图 → 判学科 + 顺带抽题面指纹）
 *     ③ 题面级跨任务去重（用户裁定 A：带）
 *     ④ 按学科分组，逐组产出「可直接粘给 AI 的任务单」
 *
 * 它**不做什么**（边界很重要）：
 *   · 不自己解题、不判错 —— 那是 AI 按配方正文做的事，本工具只负责把活分好
 *   · 不改任何核心机制 —— 组装/校验/入库/门禁全部是**调用现有工具**，不重写
 *   · 不替人确认 —— 三层校验的第三层是人工确认，程序不代劳
 *
 * 隐私红线（与全仓一致）：
 *   · 卷面页眉有**真名学号**（实测：物理卷页眉「班级 九(2)班 学号42 姓名 …」）
 *     ⇒ 本工具的输出**不回显**任何卷面文字（姓名/学号/班级/学校），只回显判定结果
 *   · 路径只给**批次名 + 文件名**，不给盘符绝对路径
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { libraryRoot, toolPath } from './_库根.mjs';
import { readJsonStrict } from './_安全写.mjs';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';

/* ══════════════ 参数 ══════════════ */
const { action: _cmd, opt, positional } = parseArgs(process.argv.slice(2), {
  valueFlags: [...COMMON_VALUE_FLAGS, 'out', 'in', 'batch', 'student', 'recipe', 'data'],
  boolFlags: ['dry', 'json', 'help', 'h'],
});
const cmd = _cmd || '';
const val = (k, d = '') => { const v = opt[k]; return (v === undefined || v === true) ? d : v; };
const JSON_OUT = !!opt.json;
const DRY = !!opt.dry;

/* `--data` 必须在任何 libraryRoot() 之前落 env（与全仓同口径）。 */
const explicitData = val('data', '');
if (explicitData) process.env.CTB_DATA = path.resolve(explicitData);
let _root = null;
const ROOT = () => (_root || (_root = libraryRoot()));

const SUBJECTS = ['数学', '语文', '英语', '物理', '化学', '生物', '历史', '地理', '政治'];
const IMG_RE = /\.(jpe?g|png|webp|bmp|tiff?)$/i;

/* ══════════════ 小工具 ══════════════ */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const nowLocal = () => new Date().toISOString();
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** 归一化题干，用于题面级去重（去空白、去全半角差异、去常见噪声标点） */
function normStem(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。；：、？！""''（）()《》〈〉【】\[\]{}．.,;:?!~"'`·]/g, '')
    .toLowerCase();
}
/** 题面指纹：归一化后取 sha256 前 16 位 */
const stemFp = s => sha256(normStem(s)).slice(0, 16);

/* ══════════════ 照片级判重 ══════════════ */

/**
 * 读原卷台账，算出「已处理照片」的判据集合。
 * 口径与 `_配方.mjs` 的 inboxArchivedSet 同族（路径 / 指纹 / 批次级）。
 * ⚠ 只读不改。
 */
function loadLedger() {
  const p = path.join(ROOT(), '_原卷台账.json');
  const empty = { cards: {}, seen: new Set(), paths: new Set(), doneBatches: new Set(), broken: false };
  if (!isFile(p)) return empty;
  let doc;
  try { doc = readJsonStrict(p, { shape: x => x && typeof x === 'object', what: '原卷台账', label: '_原卷台账.json' }); }
  catch { return { ...empty, broken: true }; }
  const cards = (doc && doc.cards && typeof doc.cards === 'object' && !Array.isArray(doc.cards)) ? doc.cards : {};
  const paths = new Set();
  const doneBatches = new Set();
  const seen = new Set();
  for (const key of Object.keys(cards)) {
    const c = cards[key] || {};
    for (const f of ['page', 'import']) {
      const v = c[f];
      if (typeof v !== 'string' || !v.trim()) continue;
      const raw = String(v).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      paths.add(raw.toLowerCase());
      const m = raw.match(/^_收件箱\/([^/]+)\//);
      if (m) doneBatches.add(m[1]);
      const abs = path.resolve(ROOT(), raw);
      if (isFile(abs)) {
        try { seen.add(sha256(fs.readFileSync(abs))); } catch { /* 读不动就不算指纹 */ }
      }
    }
  }
  return { cards, seen, paths, doneBatches };
}

/* ══════════════ 题面级跨任务去重（用户裁定 A：带） ══════════════ */

/**
 * 从库里所有在册卡抽出题面指纹，用于**跨任务**去重。
 * 判据：归一化题干的 sha256 前 16 位（题面**完全一致**才算命中，不是"相似"）。
 * ⚠ 只收"在册"的卡：已归档的卡（复习完沉淀掉）不该挡住新卡。
 * ⚠ 宁可漏判重复，也不可误杀新题 —— 这是本判据的取舍。
 */
function loadStemIndex() {
  const root = ROOT();
  const map = new Map();
  const idxFiles = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) { if (e.name === '_索引.json') idxFiles.push(path.join(dir, e.name)); continue; }
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  for (const f of idxFiles) {
    let j;
    try { j = readJsonStrict(f, { shape: x => Array.isArray(x.items) || (!!x.subjects && typeof x.subjects === 'object'), what: '索引', label: path.basename(f) }); }
    catch { continue; }
    const student = String(j.student || '');
    const push = (it, subject) => {
      if (!it || it.status === '已归档') return;
      const fp = stemFp(it.question || '');
      if (!fp) return;
      if (!map.has(fp)) map.set(fp, []);
      map.get(fp).push({ student, subject, id: it.id });
    };
    if (Array.isArray(j.items)) for (const it of j.items) push(it, j.subject || '');
    if (j.subjects && typeof j.subjects === 'object') {
      for (const [name, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) push(it, name);
    }
  }
  return map;
}

/* ══════════════ 收件箱扫描 ══════════════ */

/** 扫收件箱：按批次目录分组，顶层文件归「（未分批）」 */
function scanInbox() {
  const root = ROOT();
  const inbox = path.join(root, '_收件箱');
  const out = [];
  if (!isDir(inbox)) return out;
  let ents; try { ents = fs.readdirSync(inbox, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const abs = path.join(inbox, e.name);
    if (e.isDirectory()) {
      const files = [];
      let sub; try { sub = fs.readdirSync(abs, { withFileTypes: true }); } catch { sub = []; }
      for (const s of sub) {
        if (s.isDirectory() || !IMG_RE.test(s.name)) continue;
        files.push({ name: s.name, abs: path.join(abs, s.name) });
      }
      if (files.length) out.push({ batch: e.name, dir: abs, files });
    } else if (e.isFile() && IMG_RE.test(e.name)) {
      out.push({ batch: '（未分批）', dir: inbox, files: [{ name: e.name, abs }] });
    }
  }
  return out;
}

/* ══════════════ 组装任务单（调用现有工具，不重写） ══════════════ */

/**
 * 为一张图生成任务单（调 `_配方.mjs 组装`）。
 * @returns {{ok:boolean, taskId?:string, text?:string, why?:string}}
 */
function composeTask({ imageAbs, subject, recipe }) {
  const nodeExe = process.execPath;
  const script = toolPath('_配方.mjs');
  const args = ['组装', '--recipe', recipe, '--subject', subject, '--image', imageAbs, '--task'];
  try {
    const r = execFileSync(nodeExe, [script, ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CTB_DATA: ROOT() },
    });
    /* 任务号在 stderr 的「任务记录：t-…」行里；但 execFileSync 只回 stdout ⇒
     * 任务号其实由 `--task` 落盘在 <库根>\_录题\ 下。stdout 是任务单正文。 */
    return { ok: true, text: r };
  } catch (e) {
    const err = String((e && e.stderr) || (e && e.message) || e);
    return { ok: false, why: err.trim().split('\n').slice(-3).join(' | ') };
  }
}

/* ══════════════ 主流程 ══════════════ */

function buildPlan() {
  const root = ROOT();
  const batches = scanInbox();
  const ledger = loadLedger();
  const pending = [];
  const skipped = [];
  for (const b of batches) {
    for (const f of b.files) {
      const rel = path.relative(root, f.abs).split(path.sep).join('/');
      let sha = '';
      try { sha = sha256(fs.readFileSync(f.abs)); } catch { /* 读不动 */ }
      const relKey = rel.toLowerCase();
      /* 照片级判重：路径 → 内容指纹 → 批次级 */
      let dupReason = '';
      if (ledger.paths.has(relKey)) dupReason = '台账已引用这张照片（路径命中）';
      else if (sha && ledger.seen.has(sha)) dupReason = '台账已引用这张照片（内容指纹命中）';
      else if (ledger.doneBatches.has(b.batch)) dupReason = '该批次已建过卡（批次级判据）';
      if (dupReason) {
        skipped.push({ batch: b.batch, name: f.name, reason: '重复录入·' + dupReason });
        continue;
      }
      pending.push({ batch: b.batch, name: f.name, abs: f.abs, rel, sha256: sha });
    }
  }
  return { root, batches, pending, skipped, ledgerBroken: !!ledger.broken };
}

/* 判科需要读图 —— 本工具读不了图像语义，所以判科这一步由 AI 做。
 * 本工具给出「待判科清单」，AI 逐张判完回传，再由本工具分组 + 去重 + 生成任务单。 */
function cmdJudge() {
  const out = val('out', '');
  const plan = buildPlan();
  const items = plan.pending.map((r, i) => ({
    idx: i,
    batch: r.batch,
    name: r.name,
    rel: r.rel,
    sha256: r.sha256,
  }));
  const doc = {
    schema: 'glimmernote.triage-plan/v1',
    createdAt: nowLocal(),
    instruction: [
      '逐张读图并判学科。判据按可信度：① 卷头/页眉印刷标题（最强）② 路径/文件名里的学科词 ③ 题面内容特征（最弱）。',
      '只有 ① 或 ② 命中才算 confident=true；只靠 ③ ⇒ confident=false。',
      '判不准的**不要猜**：subject 留空、confident=false，reason 写清卡在哪。',
      '同时把图上**已做错**的题干原文摘到 stems[]（没有就留空数组）—— 用它做跨批次重复检测。',
      '**隐私红线**：不要回显卷面上的姓名、学号、班级、学校、完整文件路径。',
    ].join('\n'),
    items,
    skipped: plan.skipped,
  };
  const text = JSON.stringify(doc, null, 2);
  if (out && out !== '-') {
    const abs = path.resolve(out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    console.log('已写待判科清单：' + abs + '（' + items.length + ' 张待判，' + plan.skipped.length + ' 张已判重跳过）');
  } else {
    process.stdout.write(text);
  }
  return 0;
}

/**
 * 分组 + 题面级去重 + 生成任务单。
 * @param {string} judgeFile AI 判好的清单（{items:[{idx,subject,confident,reason,stems[]}]}）
 */
function cmdGroup() {
  const judgeFile = val('in', '');
  if (!judgeFile) { console.error('用法：分组 --in <判科结果.json> [--out <任务单目录>]'); return 2; }
  const abs = path.resolve(judgeFile);
  if (!isFile(abs)) { console.error('判科结果文件不存在：' + abs); return 2; }

  const plan = buildPlan();
  const stemIdx = loadStemIndex();

  let jd;
  try { jd = readJsonStrict(abs, { shape: x => x && Array.isArray(x.items), what: '判科结果', label: path.basename(abs) }); }
  catch (e) { console.error('✖ 判科结果读不动：' + String(e && e.message || e)); return 2; }

  /* ⚠ 按 idx 配对，**不按名字**：AI 可能改了名或改了顺序。
   * idx 是「待判科清单」里那张照片的序号，AI 回传时必须原样带回。 */
  const byIdx = new Map();
  for (const it of jd.items) byIdx.set(Number(it.idx), it);

  const groups = new Map();   // subject → [pending item]
  const uncertain = [];
  const dups = [];

  plan.pending.forEach((r, i) => {
    const it = byIdx.get(i);
    if (!it) {
      uncertain.push({ batch: r.batch, name: r.name, reason: '判科结果里没有这一张（AI 漏了 idx=' + i + '）' });
      return;
    }
    const subj = String(it.subject || '').trim();
    if (!subj) {
      uncertain.push({ batch: r.batch, name: r.name, reason: it.reason || 'AI 判不准（subject 留空）' });
      return;
    }
    if (!SUBJECTS.includes(subj)) {
      uncertain.push({ batch: r.batch, name: r.name, reason: 'AI 给的学科不在契约内：' + subj });
      return;
    }
    if (it.confident !== true) {
      uncertain.push({ batch: r.batch, name: r.name, reason: it.reason || 'AI 判不准（confident≠true）' });
      return;
    }
    /* 题面级跨任务去重：AI 顺带摘的题干原文 vs 库里在册卡的题面指纹 */
    const stems = Array.isArray(it.stems) ? it.stems : [];
    const hits = [];
    for (const s of stems) {
      const fp = stemFp(s);
      const found = stemIdx.get(fp);
      if (found && found.length) hits.push({ existing: found[0] });
    }
    if (hits.length) {
      dups.push({ batch: r.batch, name: r.name, subject: subj, hits });
      return;
    }
    if (!groups.has(subj)) groups.set(subj, []);
    groups.get(subj).push(r);
  });

  /* 生成任务单：每科一组，逐张调现有工具。 */
  const outDir = val('out', '');
  const recipe = val('recipe', 'ingest-page');
  const composed = [];
  const failed = [];
  const usedTaskFiles = new Set();   /* 任务单文件名去重（同名会互相覆盖） */
  for (const [subj, list] of groups) {
    for (const r of list) {
      if (DRY) {
        composed.push({ subject: subj, batch: r.batch, name: r.name, rel: r.rel, taskId: '(dry)' });
        continue;
      }
      const t = composeTask({ imageAbs: r.abs, subject: subj, recipe });
      if (!t.ok) { failed.push({ subject: subj, name: r.name, why: t.why }); continue; }
      const item = { subject: subj, batch: r.batch, name: r.name, rel: r.rel, sha256: r.sha256 };
      if (outDir) {
        const dir = path.resolve(outDir, subj);
        fs.mkdirSync(dir, { recursive: true });
        /* ⚠ 文件名必须**带批次名**：不同批次可能有同名文件（实测：
         *   物理批的「机械能与内能-p8.jpg」与语文批的同名件 ⇒ 只用原名会互相覆盖，
         *   先写的被后写的顶掉 ⇒ 任务单与照片对不上号（而任务单里带 sha256，对不上就录不进去）。
         * 所以名 = 批次名 + 原名；批次名本身可能含路径非法字符，净化一下。 */
        const safeBatch = r.batch.replace(/[\\/:*?"<>|]/g, '_');
        const base = safeBatch + '__' + r.name.replace(IMG_RE, '');
        /* 再防一次：同一学科内同名（同一批次里两个同名文件不可能，但批次名净化后可能撞） */
        let fname = base + '.任务单.md';
        let k = 2;
        while (usedTaskFiles.has(fname)) fname = base + '__' + (k++) + '.任务单.md';
        usedTaskFiles.add(fname);
        const f = path.join(dir, fname);
        fs.writeFileSync(f, t.text, 'utf8');
        item.taskFile = path.join(subj, fname);
      }
      composed.push(item);
    }
  }

  const summary = {
    schema: 'glimmernote.triage-group/v1',
    createdAt: nowLocal(),
    bySubject: Object.fromEntries(Array.from(groups.entries()).map(([k, v]) => [k, v.length])),
    composed,
    uncertain,
    duplicates: dups,
    failed,
    skippedAlready: plan.skipped,
  };
  const text = JSON.stringify(summary, null, 2);
  if (outDir && !DRY) {
    const p = path.join(path.resolve(outDir), '_分流结果.json');
    fs.writeFileSync(p, text, 'utf8');
  }
  if (JSON_OUT) { process.stdout.write(text); return 0; }
  console.log('分流完成：');
  for (const [k, v] of Object.entries(summary.bySubject)) console.log('  ' + k + '：' + v + ' 张');
  console.log('  任务单已生成：' + composed.length + ' 张' + (outDir ? ' → ' + outDir : ''));
  if (uncertain.length) console.log('  ⚠ 判不准（待人工确认）：' + uncertain.length + ' 张');
  if (dups.length) console.log('  ⚠ 疑似重复（题面级跨任务去重）：' + dups.length + ' 张');
  if (failed.length) console.log('  ✖ 组装失败：' + failed.length + ' 张');
  return 0;
}

/* ───────────────── 入口 ───────────────── */
function main() {
  switch (cmd) {
    case '判科': return cmdJudge();
    case '分组': return cmdGroup();
    case '计划': {
      const p = buildPlan();
      if (JSON_OUT) {
        process.stdout.write(JSON.stringify({ ok: true, batches: p.batches.map(b => ({ batch: b.batch, total: b.files.length })), pending: p.pending.map(x => ({ batch: x.batch, name: x.name, rel: x.rel })), skipped: p.skipped }, null, 2));
        return 0;
      }
      console.log('收件箱批次：');
      for (const b of p.batches) console.log('  ' + b.batch + '：' + b.files.length + ' 张');
      console.log('待判科：' + p.pending.length + ' 张');
      if (p.skipped.length) {
        console.log('已判重跳过：' + p.skipped.length + ' 张');
        for (const s of p.skipped) console.log('  · ' + s.batch + '/' + s.name + ' —— ' + s.reason);
      }
      return 0;
    }
    default:
      console.error('用法：');
      console.error('  node src\\tools\\_分流器.mjs 计划 [--json]');
      console.error('  node src\\tools\\_分流器.mjs 判科 --out <文件>');
      console.error('  node src\\tools\\_分流器.mjs 分组 --in <判科结果.json> --out <任务单目录> [--dry]');
      return 2;
  }
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('✖ ' + String(e && e.message || e));
  process.exitCode = 2;
}
