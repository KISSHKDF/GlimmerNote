import fs from 'fs';
import path from 'path';
import { readJsonStrict } from './_安全写.mjs';
import { libraryRoot } from './_库根.mjs';
/* 复习队列文本镜像刷新器：从 _索引.json + _词表.md 生成 _复习队列.md
   用法：node _生成队列.mjs   （真源永远是索引；本镜像只为纯文本可读/可 diff） */
/* ★ 2026-10-23 程序与数据分家：ROOT 是**库根**（数据），不是工具目录。
   原先是 `path.dirname(fileURLToPath(import.meta.url))`，即"工具在哪儿库就在哪儿"——
   工具搬进 <AppRoot>\tools\ 之后，那样算出来的是程序目录，_词表.md / _索引.json 全都读不到。
   统一走 _库根.mjs（CTB_DATA > <AppRoot>\..\数据 > <AppRoot>\数据 > AppRoot），与 C# 壳同口径。 */
const ROOT = libraryRoot();
/* ★ 2026-10-24 B-09 整改：FILES 原先写死两个真实库索引路径；改为动态发现——
   与 _原卷台账.mjs loadCards 同口径：扫库根下（跳过 _ / . 开头）一层与两层目录里的
   `_索引.json`（年级级 + 学科级索引都认）。真实库、运行区库、fixtures 合成库都适用。 */
const FILES = [];
(function walk(d, depth) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const full = path.join(d, e.name);
    if (fs.existsSync(path.join(full, '_索引.json'))) FILES.push(path.relative(ROOT, full).replace(/\\/g, '/') + '/_索引.json');
    if (depth > 0) walk(full, depth - 1);
  }
})(ROOT, 1);
FILES.sort();
if (!FILES.length) {
  console.error('[生成队列] 库根下没有发现任何 _索引.json：' + ROOT);
  process.exit(1);
}

/* 从规范词表取错因名称（K1 概念不清 / S5 答题不规范…），避免自由文本截断 */
const causeName = {};
for (const m of fs.readFileSync(path.join(ROOT, '_词表.md'), 'utf8').matchAll(/^\|\s*([KLS]\d)\s*\|\s*([^|]+?)\s*\|/gm)) causeName[m[1]] = m[2];

const rows = [];
for (const f of FILES) {
  /* BUG-15（2026-10-11）：原先是裸 `JSON.parse(fs.readFileSync(ROOT+f,'utf8'))`，
     真源被带 BOM 的通道改写过一次就在这里抛错（队列镜像刷不出来）。统一走 readJsonStrict（剥 BOM）。 */
  const j = readJsonStrict(path.join(ROOT, f));
  const its = j.items || [].concat(...Object.values(j.subjects || {}).map(s => s.items || []));
  const subjOf = it => j.subject || Object.entries(j.subjects || {}).find(([, v]) => (v.items || []).includes(it))[0];
  rows.push({ student: j.student, grade: j.grade, its, subjOf });
}
const tbl = (its, subjOf) => ['| 编号 | 学科 | 考点 | 错因 | 错误 | 复习状态 | 重做 | 连对 | 上次复习 | 建议复习 | 来源 | 首录 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...its.map(it => '| ' + [it.id, subjOf(it), (it.kpoints || []).join('、'),
    it.causeCode + ' ' + (causeName[it.causeCode] || it.causeLayer + '类') + (it.causeConfirmed ? '' : '（待口述确认）'),
    it.errorCount, it.reviewStatus || '未复习', it.reviewCount || 0, it.passStreak || 0,
    it.lastReviewedAt || '—', it.nextDue || '—', it.source, it.sourceDate].join(' | ') + ' |')].join('\n');

let out = `# 复习队列（a2 模式：不排期，攒量自抽 + v1.7 复习状态留痕）

> 本文件是 **文本镜像**，由 \`node _生成队列.mjs\` 刷新；唯一真源是各 \`_索引.json\` + \`_组卷台账.json\`，仪表盘是 \`首页.html\`。
> 闭环规则：错题只改状态、不删行。**组卷入账 → 复习中·待批改 →（回录 对/半对/错）→ 连对 2 次自动「已掌握」退出组卷池 →（确认）「已归档」**。
> 写入入口：\`node _标记复习.mjs 组卷|批改|撤批|归档|同步|状态\`（单次做对不算掌握，防蒙对）。
> 组卷默认从「未复习 / 已复习·再错 / 已复习·半对」优先抽；「已掌握 / 已归档」不进默认池（首页可手动勾选）。
> **📋 悬空问题不在这里**——「待口述确认 / 归属存疑 / 疑似漏判 / 卷面看不清」全部集中到 \`_待确认清单.md\`（真源 \`_待确认.json\`，工具 \`node _待确认.mjs\`）。本表的「（待口述确认）」只是索引字段回显，**别在表里翻**。

`;
for (const r of rows) {
  const g = {};
  r.its.forEach(it => { const k = it.reviewStatus || '未复习'; g[k] = (g[k] || 0) + 1; });
  out += `## ${r.grade}-${r.student}（共 ${r.its.length} 题：` + Object.entries(g).map(([k, v]) => `${k} ${v}`).join('、') + '）\n\n';
  out += (r.its.length ? tbl(r.its, r.subjOf) : '（空库，尚未录入）') + '\n\n';
}
fs.writeFileSync(path.join(ROOT, '_复习队列.md'), out.replace(/\n+$/, '\n'), 'utf8');
console.log('_复习队列.md 已刷新：' + out.length + ' 字符');
rows.forEach(r => console.log('  ' + r.student + ' ' + r.its.length + ' 题'));
