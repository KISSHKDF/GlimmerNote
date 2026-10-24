const path = require('path');
const E = require('./_测试环境.cjs');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const { execFileSync } = require('child_process');

/* ★ 2026-10-24 B-09：本脚本原是"某次补题干批次（13 张真实卡）"的一次性核对，卡号写死。
   现在改成**常设普查**：凡「题干.html 与 错题记录.md 并存」的卡全部比对（判据不变：
   新建题干经 stemToText 规范化后应与 md 原题段一致，且盲解指纹仍判「有效」）。 */

function stemToText(h) {
  let s = h.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
  return s.replace(/[ \t]+/g, ' ').split('\n').map(x => x.trim()).filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').trim();
}
function mdOrigin(p) {
  if (!fs.existsSync(p)) return '';
  const L = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const i = L.findIndex(l => /^\*\*原题\*\*/.test(l.trim()));
  if (i < 0) return '';
  const out = [L[i].trim().replace(/^\*\*原题\*\*[：:]\s*/, '')];
  for (let k = i + 1; k < L.length; k++) { const l = L[k].trim(); if (l === '' || /^#/.test(l) || /^\*\*/.test(l)) break; out.push(l); }
  return out.join(' ').trim();
}

/* 动态收集「两种来源并存」的卡 */
const cards = [];
for (const f of E.findIndexes()) {
  const j = JSON.parse(fs.readFileSync(E.lib(f), 'utf8'));
  const rel = path.dirname(f);
  const push = (it, sub) => cards.push({ stu: j.student, id: it.id, dir: rel + (sub ? '/' + sub : '') + '/' + it.dir });
  if (j.subjects) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) push(it, sn);
  if (Array.isArray(j.items)) for (const it of j.items) push(it, '');
}
const BOTH = cards.filter(c => fs.existsSync(E.lib(c.dir, '题干.html')) && fs.existsSync(E.lib(c.dir, '错题记录.md')));
console.log(`=== 题干.html ↔ 错题记录.md 并存的卡 ${BOTH.length} 张：逐张比对 ===`);
let same = 0, different = [];
for (const c of BOTH) {
  const a = stemToText(fs.readFileSync(E.lib(c.dir, '题干.html'), 'utf8'));
  const b = mdOrigin(E.lib(c.dir, '错题记录.md'));
  const eq = a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  if (eq) same++; else different.push(c.stu + '|' + c.id);
}
console.log(`→ ${BOTH.length} 张里一致 ${same} / 不一致 ${different.length} ${different.slice(0, 10).join(',')}${different.length > 10 ? ' …' : ''}`);

console.log('\n=== 指纹硬条件（这才是验收判据）===');
const j = JSON.parse(execFileSync(process.execPath, [E.tool('_盲解复核.mjs'), '门禁', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { CTB_DATA: E.LIB }) }).trim());
const cnt = {}; Object.values(j.cards).forEach(x => cnt[x] = (cnt[x] || 0) + 1);
const notOk = BOTH.filter(c => j.cards[c.stu + '|' + c.id] !== '有效');
console.log('cards 分布 =', JSON.stringify(cnt), '｜problems =', j.problems.length, '｜meta.fpV1 =', j.meta && j.meta.fpV1);
console.log('并存卡里非「有效」=', notOk.length, notOk.map(c => c.stu + '|' + c.id).slice(0, 10).join(',') || '（0 ✔）');
console.log('\n判据说明：题干来源优先级是 题干.html > md原题段。盲解当时用的是 md原题段；');
console.log('补出 题干.html 后指纹**未变**，即证明「新建 HTML 经 stemToText 规范化后 == 当年盲解所据文本」——');
console.log('这也是为什么不能只看"文件补上了"，必须看指纹。');
