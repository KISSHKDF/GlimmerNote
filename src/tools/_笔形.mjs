#!/usr/bin/env node
/**
 * 错题本·笔形库（v1，2026-10-09）—— 「认字」这件事的唯一落点
 *
 * 起因（用户 2026-10-09 原话）：「你看多了这两个小孩的笔迹之后，对他们的字迹判断能力会不断提升吗？」
 * 答案：模型每次会话从零开始，看一万张也不会自己长记性；能留下的只有硬盘上的字。
 * 所以把「判字能力」实体化成这个库——**它在，能力就在；它不在，每次都从零重踩**。
 *
 * 库里存两类东西（同一份 JSON，items 数组）：
 *   类型 字形 —— 某个孩子的某个字符长什么样：feature（可判别的特征）+ counter（反例）+ conf（置信度）
 *               + sample（样本图，库**自带副本**，不引用 _work-* 临时区，否则工作区一清理库就瞎了）
 *   类型 标定 —— 某种素材/某种笔的取色阈值（例：扫描版红笔 R−G≈17~21、纸底≈13，须 diff≥17 且 lum<172）
 *
 * 设计原则（与 _待确认.mjs / _配图门禁.mjs 一致）：
 *   1) 单一真源：_笔形台账.json；_笔形\<学生>.md 是渲染页，**勿手改**；
 *   2) 唯一写入入口：本工具；批量回填也必须调本工具（`加`），不许手改 JSON；
 *   3) 反例必须留：只记"支持我判断的样本"会让系统性误判越滚越大（把 D 读成 A 就是这样来的）；
 *   4) 每条带来源（页/日期/放大倍数/出处卡），可回溯、可回滚；
 *   5) 全本地，不出机器（用户隐私红线）。
 *
 * 用法（node _笔形.mjs <动作>）：
 *   加   --student 学生B --type 字形 --char 4 --feature "上端开口的4…" [--counter "…"] [--conf 高]
 *        [--sample <源图路径>] [--zoom 7x] [--page p15] [--source "M0039 二次复核"] [--date]
 *   标定 --student 学生A --material 照片版 --ink 红笔 --metric "R−G" --range "29~40" [--note "…"]
 *   查   --student 学生B [--char 4] [--type 字形] [--json]        按学生/字符检索（判字前先查这里）
 *   提示 --student 学生A [--char A]                              输出可注入提示词/任务书的紧凑先验块
 *   状态                                                        两生各有多少条、多少带样本
 *   清单                                                        渲染 _笔形\<学生>.md 与 _笔形\README.md
 *   门禁 [--json]                                               字段/id/样本路径自检；样本路径失效→退出码 1
 */
import fs from 'fs';
import path from 'path';
import { readJsonStrict, writeJsonAtomic } from './_安全写.mjs';
import { libraryRoot } from './_库根.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 是**库根**（数据），不是工具目录。
   原先是 `path.dirname(fileURLToPath(import.meta.url))`，工具搬进 <AppRoot>\tools\ 之后
   那样算出来是程序目录 ⇒ _笔形台账.json / _笔形\ 全落到程序目录里去。统一走 _库根.mjs。 */
const ROOT = libraryRoot();
const DB = path.join(ROOT, '_笔形台账.json');
const DIR = path.join(ROOT, '_笔形');
const TYPES = ['字形', '标定'];
const CONFS = ['高', '中', '低'];

const argv = process.argv.slice(2);
const action = argv[0] || '状态';
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith('--')) continue;
  const k = t.slice(2);
  if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
  else opt[k] = true;
}
const dstr = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const today = () => dstr(new Date());
const readJson = p => readJsonStrict(p, { label: path.basename(p) });
const writeJson = (p, o) => writeJsonAtomic(p, o, { backup: true });
const posix = p => String(p).replace(/\\/g, '/');
const esc = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const safeName = s => String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').trim() || '_';

function load() {
  if (!fs.existsSync(DB)) return { note: '错题本·笔形库（唯一真源）', items: [], seq: 0 };
  /* 形状异常必须响亮拒绝（BUG-02）：笔形库是"认字判读"的结论沉淀，被当空表 + 写回 = 全丢。
     编号水位线（BUG-11）：删号后不复用，否则历史留痕的 B0007 会指向另一条样本。 */
  const j = readJsonStrict(DB, { shape: x => Array.isArray(x.items), what: 'items 数组', label: '_笔形台账.json' });
  j.seq = Math.max(Number(j.seq) || 0, maxIdOf(j.items));
  return j;
}
function maxIdOf(items) {
  let mx = 0;
  for (const it of (items || [])) { const m = /^B(\d+)$/.exec(it.id || ''); if (m) mx = Math.max(mx, Number(m[1])); }
  return mx;
}
function save(o) { writeJsonAtomic(DB, o, { backup: true }); }
function nextId(doc) {
  const seq = Math.max(Number(doc.seq) || 0, maxIdOf(doc.items));
  doc.seq = seq + 1;
  return 'B' + String(doc.seq).padStart(4, '0');
}
/** 相对题库根的正斜杠路径 → 绝对路径 */
function absOf(rel) { return path.isAbsolute(rel) ? rel : path.join(ROOT, rel); }

/* ---------------- 加：字形样本 ---------------- */
function cmdAdd() {
  const student = String(opt.student || '').trim();
  const type = String(opt.type || (opt.metric ? '标定' : '字形')).trim();
  if (!student) { console.error('缺参数：--student 必填'); process.exit(2); }
  if (!TYPES.includes(type)) { console.error('--type 必须是：' + TYPES.join(' / ')); process.exit(2); }
  if (opt.conf && !CONFS.includes(opt.conf)) { console.error('--conf 必须是：' + CONFS.join(' / ')); process.exit(2); }

  const j = load();
  const it = {
    id: nextId(j),
    type,
    student,
    date: opt.date || today(),
    source: opt.source || '',
    page: opt.page || '',
    note: opt.note || '',
  };

  if (type === '字形') {
    if (!opt.char) { console.error('字形条目缺参数：--char 必填（要记的是哪个字符）'); process.exit(2); }
    if (!opt.feature) { console.error('字形条目缺参数：--feature 必填（可判别的特征，不是形容词）'); process.exit(2); }
    it.char = String(opt.char);
    it.feature = String(opt.feature);
    it.counter = String(opt.counter || '');
    it.conf = String(opt.conf || '中');
    it.zoom = String(opt.zoom || '');
  } else {
    if (!opt.material || !opt.metric || !opt.range) {
      console.error('标定条目缺参数：--material（照片版/扫描版）--metric（如 R−G）--range（如 29~40）必填');
      process.exit(2);
    }
    it.material = String(opt.material);
    it.ink = String(opt.ink || '');
    it.metric = String(opt.metric);
    it.range = String(opt.range);
  }

  // 样本图：**复制进库**（自持，不引用 _work-* 临时区）
  it.sample = '';
  it.origin = '';
  if (opt.sample && opt.sample !== true) {
    const src = absOf(opt.sample);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      console.error(`✖ 样本图不存在：${src}\n  （样本必须真实存在——库里的图才是判字依据，不能记一条指向空气的路径）`);
      process.exit(2);
    }
    const sub = type === '字形' ? safeName(it.char) : safeName(it.material + (it.ink ? '-' + it.ink : ''));
    const dstDir = path.join(DIR, safeName(student), sub);
    fs.mkdirSync(dstDir, { recursive: true });
    const ext = (path.extname(src) || '.jpg').toLowerCase();
    const base = `${it.date}-${it.id.slice(1)}`;
    let dst = path.join(dstDir, base + ext);
    let n = 1;
    while (fs.existsSync(dst)) dst = path.join(dstDir, base + '-' + (++n) + ext);
    fs.copyFileSync(src, dst);
    it.sample = posix(path.relative(ROOT, dst));
    it.origin = posix(opt.sample);
  }

  j.items.push(it);
  save(j);
  console.log(`已加 ${it.id}：[${it.type}] ${student}${it.char ? ' ' + it.char : ' ' + (it.material + '/' + it.ink)} — ${it.feature || it.metric + ' ' + it.range}`);
  if (it.sample) console.log(`   🖼 样本入库：${it.sample}（源：${it.origin}）`);
  else console.error(`   ⚠ 本条没有样本图（--sample 未给）——判定能力就少一块拼图；能给图就别省。`);
  if (it.type === '字形' && !it.counter) {
    console.error(`   ⚠ 没记反例（--counter）。只记支持的样本会让误判越滚越大：请补一条「哪个实例不符合本特征」。`);
  }
  render();
}

/* ---------------- 查 / 提示 ---------------- */
function match(it) {
  if (opt.student && it.student !== String(opt.student)) return false;
  if (opt.char && String(it.char || '') !== String(opt.char)) return false;
  if (opt.type && it.type !== String(opt.type)) return false;
  return true;
}
function cmdQuery() {
  const j = load();
  const hit = j.items.filter(match);
  if (opt.json) { console.log(JSON.stringify({ ok: true, n: hit.length, items: hit }, null, 2)); return; }
  if (!hit.length) { console.log('（库里还没有匹配条目）'); return; }
  for (const it of hit) {
    if (it.type === '字形') {
      console.log(`${it.id} ${it.student} 「${it.char}」[${it.conf}] ${it.feature}`);
      if (it.counter) console.log(`     反例：${it.counter}`);
      console.log(`     样本：${it.sample || '（无图）'}${it.zoom ? '  放大 ' + it.zoom : ''}${it.page ? '  ' + it.page : ''}${it.source ? '  ← ' + it.source : ''}`);
    } else {
      console.log(`${it.id} ${it.student} ${it.material}${it.ink ? '/' + it.ink : ''} ${it.metric}=${it.range}${it.note ? '  ' + it.note : ''}`);
      console.log(`     样本：${it.sample || '（无图）'}${it.source ? '  ← ' + it.source : ''}`);
    }
  }
}
/** 提示：输出可直接贴进任务书/提示词的紧凑先验块（这是"能力"真正被使用的地方） */
function cmdPrompt() {
  const j = load();
  const hit = j.items.filter(match);
  if (!hit.length) { console.log('（无先验可用）'); return; }
  const students = [...new Set(hit.map(x => x.student))];
  console.log('【已知笔形先验】（来自 _笔形台账.json，判字前先读、判完回填）');
  for (const s of students) {
    console.log(`■ ${s}`);
    const calib = hit.filter(x => x.student === s && x.type === '标定');
    for (const c of calib) console.log(`  标定 ${c.material}${c.ink ? '/' + c.ink : ''}：${c.metric}=${c.range}`);
    const glyphs = hit.filter(x => x.student === s && x.type === '字形');
    for (const g of glyphs) console.log(`  「${g.char}」[${g.conf}] ${g.feature}${g.counter ? `（反例：${g.counter}）` : ''}`);
  }
  console.log('注：先验只用于「缩小候选」，不得单独据此定案；与先验冲突时必须看原图并回填反例。');
}

/* ---------------- 渲染 ---------------- */
function render() {
  const j = load();
  fs.mkdirSync(DIR, { recursive: true });
  const students = [...new Set(j.items.map(x => x.student))];
  for (const s of students) {
    const rows = j.items.filter(x => x.student === s);
    const L = [];
    L.push(`# 笔形库 · ${s}`);
    L.push('');
    L.push(`> **真源**：\`_笔形台账.json\`；本页由 \`node _笔形.mjs 清单\` 渲染，**勿手改**。`);
    L.push(`> **怎么用**：判字前 \`node _笔形.mjs 提示 --student ${s}\` 把先验读出来；定案后 \`加\` 回填样本。`);
    L.push(`> **规矩**：先验只缩小候选，不得单独定案；与先验冲突必须回原图并回填**反例**。`);
    L.push('');
    L.push(`共 ${rows.length} 条（字形 ${rows.filter(x => x.type === '字形').length} ｜ 标定 ${rows.filter(x => x.type === '标定').length}）；带样本 ${rows.filter(x => x.sample).length} 条`);
    L.push('');
    const g = rows.filter(x => x.type === '字形');
    if (g.length) {
      L.push('## 字形特征');
      L.push('');
      L.push('| 编号 | 字符 | 置信 | 特征 | 反例 | 样本 | 放大 | 出处 |');
      L.push('|---|---|---|---|---|---|---|---|');
      for (const it of g) L.push(`| ${it.id} | \`${esc(it.char)}\` | ${esc(it.conf)} | ${esc(it.feature)} | ${esc(it.counter) || '—'} | ${it.sample ? '🖼 ' + esc(it.sample) : '⚠️ 缺图'} | ${esc(it.zoom) || '—'} | ${esc(it.source)}${it.page ? ' · ' + esc(it.page) : ''} |`);
      L.push('');
    }
    const c = rows.filter(x => x.type === '标定');
    if (c.length) {
      L.push('## 分版取色标定');
      L.push('');
      L.push('| 编号 | 素材 | 笔 | 指标 | 区间 | 样本 | 备注 |');
      L.push('|---|---|---|---|---|---|---|');
      for (const it of c) L.push(`| ${it.id} | ${esc(it.material)} | ${esc(it.ink) || '—'} | ${esc(it.metric)} | ${esc(it.range)} | ${it.sample ? '🖼 ' + esc(it.sample) : '—'} | ${esc(it.note)} |`);
      L.push('');
    }
    fs.writeFileSync(path.join(DIR, safeName(s) + '.md'), L.join('\n').replace(/\n+$/, '\n'), 'utf8');
  }
  const R = [];
  R.push('# 笔形库 · 总览');
  R.push('');
  R.push('> 真源 `_笔形台账.json`（唯一写入入口 `_笔形.mjs`）；样本图在 `_笔形/<学生>/<字符>/`。');
  R.push('> **样本自持**：入库时从 `_work-*` 临时区**复制**进来，临时区清理不影响本库。');
  R.push('> 影像按仓库治理规则不入 git（`*.jpg`），走拷贝备份。');
  R.push('');
  R.push('| 学生 | 条目 | 字形 | 标定 | 带样本 | 渲染页 |');
  R.push('|---|---|---|---|---|---|');
  for (const s of students) {
    const rows = j.items.filter(x => x.student === s);
    R.push(`| ${esc(s)} | ${rows.length} | ${rows.filter(x => x.type === '字形').length} | ${rows.filter(x => x.type === '标定').length} | ${rows.filter(x => x.sample).length} | [${esc(s)}.md](${encodeURIComponent(safeName(s))}.md) |`);
  }
  R.push('');
  fs.writeFileSync(path.join(DIR, 'README.md'), R.join('\n'), 'utf8');
  return j;
}

/* ---------------- 状态 / 门禁 ---------------- */
function cmdStatus() {
  const j = load();
  const students = [...new Set(j.items.map(x => x.student))];
  console.log(`笔形库：${j.items.length} 条，学生 ${students.length} 人`);
  for (const s of students) {
    const rows = j.items.filter(x => x.student === s);
    console.log(`  ${s}：字形 ${rows.filter(x => x.type === '字形').length} ｜ 标定 ${rows.filter(x => x.type === '标定').length} ｜ 带样本 ${rows.filter(x => x.sample).length} ｜ 无图 ${rows.filter(x => !x.sample).length}`);
  }
  const chars = [...new Set(j.items.filter(x => x.type === '字形').map(x => x.student + '|' + x.char))];
  console.log(`  已覆盖字符 ${chars.length} 个：${chars.join(' ')}`);
}
function cmdGate() {
  const j = load();
  const problems = [];
  const seen = new Set();
  for (const it of j.items) {
    if (!/^B\d{4}$/.test(it.id || '')) problems.push(`${it.id || '(无id)'}：编号格式不对`);
    if (seen.has(it.id)) problems.push(`${it.id}：编号重复`);
    seen.add(it.id);
    if (!TYPES.includes(it.type)) problems.push(`${it.id}：type 非法（${it.type}）`);
    if (!it.student) problems.push(`${it.id}：缺 student`);
    if (it.type === '字形') {
      if (!it.char) problems.push(`${it.id}：缺 char`);
      if (!it.feature) problems.push(`${it.id}：缺 feature`);
      if (it.conf && !CONFS.includes(it.conf)) problems.push(`${it.id}：conf 非法（${it.conf}）`);
    } else {
      if (!it.material || !it.metric || !it.range) problems.push(`${it.id}：标定条目缺 material/metric/range`);
    }
    if (it.sample) {
      const abs = absOf(it.sample);
      if (!fs.existsSync(abs)) problems.push(`${it.id}：样本图失效 → ${it.sample}`);
    }
  }
  const noSample = j.items.filter(x => !x.sample).map(x => x.id);
  const noCounter = j.items.filter(x => x.type === '字形' && !x.counter).map(x => x.id);
  if (opt.json) {
    console.log(JSON.stringify({ ok: problems.length === 0, total: j.items.length, problems, noSample, noCounter }, null, 2));
  } else {
    console.log(`笔形库门禁：${j.items.length} 条 ｜ 带样本 ${j.items.length - noSample.length} ｜ 无图 ${noSample.length} ｜ 字形缺反例 ${noCounter.length}`);
    if (problems.length) { for (const p of problems) console.error('  ✖ ' + p); }
    if (noSample.length) console.log(`  ⚠ 无样本 ${noSample.length}：${noSample.join(', ')}  ← 有时间补图（知识在、图缺）`);
    if (noCounter.length) console.log(`  ⚠ 字形缺反例 ${noCounter.length}：${noCounter.join(', ')}  ← 反例是防系统性误判的，不是可选项`);
    console.log(problems.length ? '  → 有问题（exit 1）' : '  → 字段与样本自检通过');
  }
  process.exit(problems.length ? 1 : 0);
}

/* ---------------- 分发 ---------------- */
if (action === '加') cmdAdd();
else if (action === '标定') { opt.type = '标定'; cmdAdd(); }
else if (action === '查') cmdQuery();
else if (action === '提示') cmdPrompt();
else if (action === '状态') { cmdStatus(); }
else if (action === '清单') { render(); const j = load(); console.log(`已渲染 _笔形\\README.md 与各学生页：${j.items.length} 条`); }
else if (action === '门禁') cmdGate();
else {
  console.error('未知动作：' + action);
  console.error('可用：加 / 标定 / 查 / 提示 / 状态 / 清单 / 门禁');
  process.exit(2);
}
