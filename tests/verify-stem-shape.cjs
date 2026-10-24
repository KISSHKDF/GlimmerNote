const path = require('path');
const E = require('./_测试环境.cjs');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

/* ★ 2026-10-24 B-09：原先抽查写死一张真实卡（真实学生目录名）+ 两个真实索引路径；
   现在全部动态发现：抽查「第一张带 题干.html 的卡」，普查走 findIndexes 全量。 */

/* 1 · 抽查一张卡的 题干.html（是否受损 / 是否整篇文档 / BOM） */
function walkCards(cb) {
  for (const f of E.findIndexes()) {
    const j = JSON.parse(fs.readFileSync(E.lib(f), 'utf8'));
    const rel = path.dirname(f);
    if (j.subjects) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) cb(j.student, it, rel + '/' + sn + '/' + it.dir);
    if (Array.isArray(j.items)) for (const it of j.items) cb(j.student, it, rel + '/' + it.dir);
  }
}
const firstCard = (() => {
  let hit = null;
  walkCards((stu, it, dir) => { if (hit) return; const hp = E.lib(dir, '题干.html'); if (fs.existsSync(hp)) hit = { stu, id: it.id, hp }; });
  return hit;
})();
if (!firstCard) console.log('（库里没有带 题干.html 的卡，抽查跳过）');
else {
  const t = fs.readFileSync(firstCard.hp, 'utf8');
  const st = fs.statSync(firstCard.hp);
  console.log(`=== ${firstCard.stu}|${firstCard.id} 题干.html ===`);
  console.log('mtime =', st.mtime.toLocaleString('sv'), '｜size =', st.size, '｜BOM =', t.charCodeAt(0) === 0xFEFF);
  console.log('片段形状(含 class="stem") =', /class="stem"/.test(t), '｜整篇文档(含 <html) =', /<html/i.test(t));
  console.log('前 120 字 =', JSON.stringify(t.slice(0, 120)));
}

/* 2 · 全库 题干.html 形状普查（确认 house style 与是否混入整篇文档） */
const rows = [];
walkCards((stu, it, dir) => rows.push({ stu, dir, id: it.id }));
let frag = 0, doc = 0, bom = 0, missing = 0; const odd = [];
for (const r of rows) {
  const hp = E.lib(r.dir, '题干.html');
  if (!fs.existsSync(hp)) { missing++; continue; }
  const t = fs.readFileSync(hp, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) bom++;
  if (/<html/i.test(t) || /<body/i.test(t)) { doc++; odd.push(r.stu + '|' + r.id); }
  else frag++;
}
console.log('\n=== 全库 题干.html 形状普查 ===');
console.log(`共 ${rows.length} 张：片段 ${frag}｜整篇文档 ${doc}｜带 BOM ${bom}｜缺失 ${missing}`);
if (odd.length) console.log('整篇文档的（应为 0）:', odd.join(', '));

/* 3 · 指纹抽查 */
const j = JSON.parse(execFileSync(process.execPath, [E.tool('_盲解复核.mjs'), '门禁', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { CTB_DATA: E.LIB }) }).trim());
const cnt = {}; Object.values(j.cards).forEach(x => cnt[x] = (cnt[x] || 0) + 1);
console.log('\n=== 门禁 ===');
console.log('cards =', JSON.stringify(cnt), '｜problems =', j.problems.length, '｜fpV1 =', j.meta && j.meta.fpV1, '｜mtimeSuspect =', j.meta && j.meta.mtimeSuspect);
if (firstCard) console.log(`${firstCard.stu}|${firstCard.id} =`, j.cards[firstCard.stu + '|' + firstCard.id]);
