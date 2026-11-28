#!/usr/bin/env node
/**
 * 拾光小册 · **撤卡工具**（2026-11-28 立）
 *
 * 为什么要有这个工具（此前**撤卡全是手工操作** —— M0071 是一次手工搬目录 + 手改三个 JSON）：
 *   手工撤卡容易漏三件事，漏了就留下**孤儿**：
 *     ① 索引删了、台账没删 ⇒ 台账里有、索引里没有（组卷/门禁口径打架）；
 *     ② 目录搬了、索引没删 ⇒ 题库页还指着一条空目录（点进去白屏）；
 *     ③ 复原指引没写 ⇒ 撤错了没法还原（**撤卡不是删卡**，本仓铁律「错题永不删行」）。
 *
 * 本仓铁律：**只有"撤"没有"删"** ——
 *   ① 卡目录**整目录搬进** `_撤卡留档\<卡号>-<描述>-<YYYY-MM-DD>-<原因>\`（四件套全留）；
 *   ② 写 `_撤销记录.json`（卡号/原目录/日期/原因/依据/结论/教训）；
 *   ③ 写 `_本批说明.md`（四步复原流程）；
 *   ④ 从学生 `_索引.json` 移除该条目；
 *   ⑤ 从 `_原卷台账.json` / `_配图台账.json` / `_盲解双路.json` 清登记；
 *   ⑥ **保留**：`_录题\t-*.json`（录题历史）、`_盲解\` 清稿（盲解留痕，只增不删）。
 *   ⑦ `_状态.json` 是**派生件** —— 重跑 `生成状态.mjs` 自动重建。
 *
 * 用法（node _撤卡.mjs <动作>）：
 *   撤卡 --card <学生>|<卡号> --reason "<原因>" [--evidence "<依据>"] [--lesson "<教训>"]
 *        [--dry-run]
 *        --reason 必填（写进撤销记录，也是留档目录名的一部分）
 *        --dry-run 只打印将要做的动作，不写盘
 *
 * ⚠ **不真删**：任何情况下都只"搬进留档"，不 rm。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { libraryRoot } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic, acquireLibLock } from './_安全写.mjs';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';

const ROOT = libraryRoot();
const __releaseLibLock = acquireLibLock(ROOT, { label: '_撤卡' });
process.on('exit', __releaseLibLock);

const argv = process.argv.slice(2);
const { action, opt } = parseArgs(argv, {
  valueFlags: [...COMMON_VALUE_FLAGS, 'card', 'reason', 'evidence', 'lesson', 'conclusion'],
  boolFlags: ['json', 'help', 'h', 'dry-run', '补做', 'patch'],
});
const fail = m => { console.error('✖ ' + m); process.exit(2); };

const HELP = `用法：node _撤卡.mjs 撤卡 --card <学生>|<卡号> --reason "<原因>" [--evidence "<依据>"] [--lesson "<教训>"] [--dry-run]
  本工具**不删卡**，只把卡整目录搬进 _撤卡留档\ 并清理索引/台账登记。
`;
if (opt.help || opt.h) { console.log(HELP); process.exit(0); }
if (action !== '撤卡') { console.log(HELP); fail('未知动作：' + (action ?? 'undefined')); }
if (!opt.card) fail('必须给 --card <学生>|<卡号>');
if (!opt.reason) fail('必须给 --reason "<原因>"（它会写进撤销记录与留档目录名）');

const today = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

/* ---------- 定位卡 ---------- */
const idxFiles = [];
for (const student of fs.readdirSync(ROOT)) {
  const sp = path.join(ROOT, student, '_索引.json');
  if (fs.existsSync(sp)) idxFiles.push(sp);
}
let hit = null;
for (const f of idxFiles) {
  let j;
  try { j = readJsonStrict(f, { label: path.basename(f) }); } catch { continue; }
  const itemsOf = (items, subject) => (items || []).map(it => ({ it, subject }));
  let list = [];
  if (Array.isArray(j.items)) list = list.concat(itemsOf(j.items, j.subject || ''));
  if (j.subjects) for (const [name, v] of Object.entries(j.subjects)) list = list.concat(itemsOf(v.items, name));
  for (const { it, subject } of list) {
    const key = j.student + '|' + it.id;
    if (key === opt.card || it.id === opt.card) { hit = { key: j.student + '|' + it.id, student: j.student, subject, item: it, idxFile: f, idx: j }; break; }
  }
  if (hit) break;
}
if (!hit) fail('找不到卡：' + opt.card);

const cardDirAbs = path.join(path.dirname(hit.idxFile), hit.subject, hit.item.dir);
const cardDirExists = fs.existsSync(cardDirAbs);
/* ★ 2026-11-28（补做模式）：**半撤卡** —— 目录已搬进留档，但索引/台账没清干净。
   实测：2026-11-27 那次撤 M0071 时，目录搬了、盲解台账清了、配图台账清了，
   **唯独该学生 `_索引.json` 的条目没删** ⇒
     · 配图门禁一直报「该学生|M0071[提到图/表但未登记]」（真库里那道门禁**真红**）；
     · 题库页会指向一条**已不存在的目录**（点进去白屏）。
   ⇒ 撤卡是**多步原子动作**，手工做极易漏一步 ⇒ 本工具提供 `--补做`：
     目录不在（已搬走）⇒ **只补齐**索引与台账登记，不重复搬目录、不重复写留档记录。 */
const PATCH = opt['补做'] || opt.patch;
if (!cardDirExists && !PATCH) {
  fail('卡目录不存在（可能已撤过）：' + cardDirAbs +
    '\n  若确属"半撤卡"（目录已搬走、索引/台账没清），加 --补做 只补齐登记。');
}
if (cardDirExists && PATCH) {
  fail('--补做 用于"目录已不在"的半撤卡；但本次卡目录还在 ⇒ 走正常撤卡流程（不带 --补做）。');
}

/* ---------- 留档目录名 ---------- */
/* 口径：`<卡号>-<描述>-<YYYY-MM-DD>-<原因>`（`_数据区门禁.mjs` 会校验这个形状）。 */
const safe = s => String(s).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const desc = safe(hit.item.dir.replace(/^[A-Z]\d+-/, ''));
const reasonSlug = safe(opt.reason).slice(0, 40);
const archiveName = hit.item.id + '-' + desc + '-' + today() + '-' + reasonSlug;
const archiveAbs = path.join(ROOT, '_撤卡留档', archiveName);

/* ---------- 台账登记 ---------- */
const LEDGERS = [
  { file: '_原卷台账.json', keyPath: 'cards' },
  { file: '_配图台账.json', keyPath: 'cards' },
  { file: '_盲解双路.json', keyPath: 'lanes' },
];
const ledgerHits = [];
for (const L of LEDGERS) {
  const p = path.join(ROOT, L.file);
  if (!fs.existsSync(p)) continue;
  let j;
  try { j = readJsonStrict(p, { label: L.file }); } catch { continue; }
  const bucket = j[L.keyPath];
  if (bucket && typeof bucket === 'object' && Object.prototype.hasOwnProperty.call(bucket, hit.key)) {
    ledgerHits.push({ file: L.file, keyPath: L.keyPath, key: hit.key });
  }
}

const plan = [
  ...(PATCH ? [] : [
    '卡目录搬进留档：' + path.relative(ROOT, cardDirAbs) + '  ⇒  ' + path.relative(ROOT, archiveAbs),
    '写撤销记录：' + path.relative(ROOT, path.join(archiveAbs, '_撤销记录.json')),
    '写复原指引：' + path.relative(ROOT, path.join(archiveAbs, '_本批说明.md')),
  ]),
  '从索引移除：' + path.relative(ROOT, hit.idxFile) + ' 的 ' + (hit.subject || '?') + ' 条目（' + hit.item.id + '）',
  ...ledgerHits.map(l => '台账清登记：' + l.file + ' 里的 ' + l.key),
  '保留（只增不删）：_录题\\t-*.json（录题历史）、_盲解\\ 清稿（盲解留痕）',
  '重跑 生成状态.mjs 重建 _状态.json（派生件）',
  ...(PATCH ? ['（补做模式：目录已在留档，不重复搬、不重写留档记录）'] : []),
];

if (opt['dry-run']) {
  console.log('\n═══ 撤卡预案（--dry-run，未写盘）═══');
  console.log('卡：' + hit.key + '（' + (hit.subject || '?') + '）');
  for (const p of plan) console.log('  · ' + p);
  process.exit(0);
}

/* ---------- 执行 ---------- */
if (!PATCH) {
  /* ① 搬目录（先建留档根） */
  fs.mkdirSync(path.join(ROOT, '_撤卡留档'), { recursive: true });
  if (fs.existsSync(archiveAbs)) fail('留档目录已存在（可能已撤过）：' + archiveAbs);
  fs.renameSync(cardDirAbs, archiveAbs);
}

/* ② 撤销记录 + 复原指引 */
const record = {
  cardId: hit.item.id,
  cardDir: hit.item.dir,
  student: hit.student,
  subject: hit.subject || '',
  withdrawnAt: today(),
  reason: String(opt.reason),
  correctionEvidence: String(opt.evidence || opt.reason),
  conclusion: String(opt.conclusion || '按用户指令从题库移除并撤卡留档；留档目录内保留卡面四件套与撤销记录，可随时复原。'),
  lesson: String(opt.lesson || ''),
};
if (!PATCH) writeJsonAtomic(path.join(archiveAbs, '_撤销记录.json'), record, { backup: true });

const restoreMd = `# 撤卡留档 · ${archiveName}

- 卡号：${hit.item.id}（${hit.student}/${hit.subject || '?'}）
- 原卡目录：${hit.student}/${hit.subject || '?'}/${hit.item.dir}
- 撤卡日期：${today()}
- 原因：${String(opt.reason)}

## 怎么复原

1. 把 \`${hit.item.dir}\` 整个目录搬回 \`${(ROOT + '/' + hit.student + '/' + (hit.subject || '')).replace(/\\/g, '/')}/\`；
2. 把卡条目**原样**写回 \`${hit.student}\\_索引.json\` 的 \`subjects.${hit.subject || '?'}.items\`（本记录的 \`card\` 字段即原条目，见 \`_索引.json\` 的历史备份）；
3. 台账登记：${ledgerHits.length ? ledgerHits.map(l => '`' + l.file + '`').join(' / ') : '（无）'} 里补回 \`${hit.key}\`；
4. 跑 \`node src\\tools\\生成状态.mjs\` 重建状态包。

⚠ 复原前先确认卡号没被别的卡占用（同一学科内卡号唯一）。
`;
if (!PATCH) fs.writeFileSync(path.join(archiveAbs, '_本批说明.md'), restoreMd, 'utf8');

/* ③ 从索引移除 */
{
  const j = hit.idx;
  const bucket = j.subjects ? j.subjects[hit.subject] : { items: j.items };
  const before = bucket.items.length;
  bucket.items = bucket.items.filter(x => x.id !== hit.item.id);
  writeJsonAtomic(hit.idxFile, j, { backup: true });
  console.log('  · 索引移除：' + hit.subject + ' ' + before + ' → ' + bucket.items.length + ' 条');
}

/* ④ 台账清登记 */
for (const l of ledgerHits) {
  const p = path.join(ROOT, l.file);
  const j = readJsonStrict(p, { label: l.file });
  delete j[l.keyPath][l.key];
  writeJsonAtomic(p, j, { backup: true });
  console.log('  · 台账清登记：' + l.file + ' 删掉 ' + l.key);
}

console.log('\n✔ 撤卡完成：' + hit.key + '  ⇒  ' + path.relative(ROOT, archiveAbs));
console.log('  下一步：跑 `node src\\tools\\生成状态.mjs` 重建 _状态.json（派生件）。');
