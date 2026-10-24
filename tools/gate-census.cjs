/* tools\gate-census.cjs —— 门禁普查**报表**（2026-10-24 从 tests\ 移出）
 * 它不是测试：没有断言、没有 pass/fail，只打印统计。放在 tests\ 里会被
 * 「游离测试」判据当成失修的门禁项红掉（见 DEFECT-REGISTRY D-049/D-050）。
 * 用法：node tools\gate-census.cjs
 */
const fs = require('fs');
const path = require('path');
/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('../tests/_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
const files = E.findIndexes().map(f => E.lib(f));   /* ★ 2026-10-24 B-09：动态发现（原写死真实库两个索引路径） */
const SRC_OK = ['独立判卷+红笔一致', '独立判卷修正'];
/* ⚠ 2026-10-15 对齐唯一实现（L-259 精神：判据只许一处）：答案来源门禁自 v2.6 起是
   `_标记复习.mjs 组卷/准入` 里的**语义前缀**判据（独立判卷/老师定案/官方答案 前缀放行；
   上面的 SRC_OK 精确串只是历史分布展示参考，不再做判定）。本普查只读索引，不许出现第二判据。 */
const SRC_PREFIX_OK = ['独立判卷', '老师定案', '官方答案'];
const SRC_EXACT_OK = ['红笔订正+官方答案页核对'];
const srcOk = s => { const t = String(s || '').trim(); return !!t && (SRC_PREFIX_OK.some(p => t.startsWith(p)) || SRC_EXACT_OK.includes(t)); };
const all = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Array.isArray(j.items)) for (const it of j.items) all.push({ k: j.student + '|' + it.id, stu: j.student, it });
  if (j.subjects) for (const v of Object.values(j.subjects)) for (const it of (v.items || [])) all.push({ k: j.student + '|' + it.id, stu: j.student, it });
}
const byStu = {};
for (const x of all) {
  const s = (byStu[x.stu] = byStu[x.stu] || { n: 0, blindOk: 0, srcOk: 0, bothOk: 0, srcMissing: 0, srcVals: {} });
  s.n++;
  const b = ['已通过', '已修正'].includes(x.it.blindStatus);
  const a = srcOk(x.it.answerSource);
  if (b) s.blindOk++;
  if (a) s.srcOk++;
  if (b && a) s.bothOk++;
  if (x.it.answerSource === undefined) s.srcMissing++;
  const v = x.it.answerSource || '(缺)';
  s.srcVals[v] = (s.srcVals[v] || 0) + 1;
}
for (const [k, v] of Object.entries(byStu)) {
  console.log(`${k}: 卡 ${v.n} ｜ 盲解过 ${v.blindOk} ｜ 答案来源过 ${v.srcOk} ｜ **两道门禁都过 ${v.bothOk}** ｜ answerSource 缺字段 ${v.srcMissing}`);
  console.log('   answerSource 分布:', JSON.stringify(v.srcVals));
}
const leech = all.filter(x => (x.it.errorCount | 0) >= 4).map(x => `${x.k}(${x.it.errorCount})`);
console.log(`\n错误次数 ≥4 的「反复错」卡：${leech.length} 张 ${leech.slice(0, 12).join(' ')}`);
