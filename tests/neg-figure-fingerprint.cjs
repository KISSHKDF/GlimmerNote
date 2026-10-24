#!/usr/bin/env node
/**
 * BUG-08 阴性对照（2026-10-11）：只改题干里的**图形**、不改任何文字 ——
 *   旧指纹（v1，只对纯文本取哈希）**抓不到**；新指纹（v2，含图形签名）**必须抓到**。
 * 做法：挑一张带内联 SVG/IMG 的卡 → 备份题干.html → 只在 SVG 里改一个数字（文字零变化）→
 *   用 `_盲解复核.mjs 门禁 --json` 看这张卡是否变成"待重盲解" → 还原 → 复验回到"有效"。
 * 该脚本只临时改一张卡的 题干.html（有备份 + 还原校验），绝不碰真源 JSON。
 * 退出码 0=对照成立；1=对照失败。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs）
   ★ 2026-10-23：本用例要临时改一张卡的 题干.html（原先是改**真库**里那张，靠备份还原），
   现在跑在**临时库副本**上（copyCardFiles 带 题干.html 且保留 mtime，指纹才判得出新鲜度）。 */
const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
const LIB = E.makeTempLib(null, { copyCardFiles: true });
const TOOL_ENV = Object.assign({}, process.env, { CTB_DATA: LIB });
let fails = 0, skipped = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

/* 找一张"盲解有效 + 题干.html 含内联 SVG 且 SVG 里有数字"的卡。
   ★ 2026-10-23：**优先挑 v2 指纹的卡**。原实现一律取第一张，实测取到的是 v1 卡 ⇒ 每次都走 SKIP 分支
   ⇒ 这条阴性对照长期空转（"能绿但没人看"同族缺陷）。库里现有 23 张 v2 卡带内联 SVG，
   所以完全可以真咬；取不到 v2 才退回任意卡并显式 SKIP。 */
const idxPaths = E.findIndexes(LIB).map(f => path.join(LIB, f));   /* ★ B-09：动态发现，原写死真实库路径 */
const cards = [];
for (const p of idxPaths) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const push = (it, sub) => cards.push({ stu: j.student, id: it.id, dir: path.join(path.dirname(p), sub || '', it.dir || ''), it });
  if (Array.isArray(j.items)) for (const it of j.items) push(it, '');
  if (j.subjects) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) push(it, sn);
}
const candList = cards.filter(c => {
  const hp = path.join(c.dir, '题干.html');
  if (!fs.existsSync(hp)) return false;
  const h = fs.readFileSync(hp, 'utf8');
  const m = h.match(/<svg[\s\S]*?<\/svg>/i);
  return !!m && /[0-9]/.test(m[0]);
});
const isV2 = c => Number(c.it && c.it.blindFingerprintVer) === 2;
const isValid = c => ['已通过', '已修正'].includes((c.it && c.it.blindStatus) || '');
const cand = candList.find(c => isV2(c) && isValid(c)) || candList.find(c => isV2(c)) || candList[0];
if (!cand) { console.log('RESULT=SKIP（找不到"带数字的内联 SVG"的卡，无法做本对照）'); process.exit(0); }
console.log(`候选：${candList.length} 张含内联SVG（其中 v2 指纹 ${candList.filter(isV2).length} 张）`);
const hp = path.join(cand.dir, '题干.html');
console.log(`样本卡：${cand.stu}|${cand.id}  题干.html = ${hp}`);
const orig = fs.readFileSync(hp);
const bak = path.join(__dirname, '_bug08-bak.html');
fs.writeFileSync(bak, orig);
let restored = false;
const restore = () => { if (!restored) { restored = true; fs.writeFileSync(hp, fs.readFileSync(bak)); fs.unlinkSync(bak); } };

const gate = () => {
  /* ⚠ 2026-10-23：门禁的退出码语义是「1 = 有未通过项」，stdout **仍是完好 JSON**（见 run.mjs 同款注释）。
     原实现直接 execFileSync ⇒ 一旦真有卡被判失效（本对照想看到的正是这个）就抛异常崩掉。
     这个坑此前一直没暴露，因为选卡总落在 v1 卡上、门禁永远 exit 0（SKIP 分支把缺陷挡住了）。 */
  let out = '';
  try {
    out = execFileSync(process.execPath, [E.tool('_盲解复核.mjs'), '门禁', '--json'], { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'], env: TOOL_ENV });
  } catch (e) {
    out = String(e.stdout || '');
    if (!out.trim()) throw e;
  }
  const j = JSON.parse(out.trim());
  return j.cards[cand.stu + '|' + cand.id];
};

try {
  const before = gate();
  A('基线：该卡盲解态为「有效」', before === '有效', before);

  /* 只改图形：把 SVG 里第一个数字 +1，文字一个字都不动 */
  const txt = orig.toString('utf8');
  const svg = txt.match(/<svg[\s\S]*?<\/svg>/i)[0];
  const num = svg.match(/\d+/)[0];
  const newNum = String(Number(num) + 1);
  const svg2 = svg.replace(num, newNum);
  const txt2 = txt.replace(svg, svg2);
  const textPartOf = s => s.replace(/<svg[\s\S]*?<\/svg>/gi, '').replace(/<img\b[^>]*>/gi, '').replace(/\s+/g, ' ').trim();
  A('对照条件成立：**文字部分逐字未变**', textPartOf(txt) === textPartOf(txt2), '文字长度 ' + textPartOf(txt).length);
  A('对照条件成立：**图形确实变了**', svg !== svg2, `SVG 内 ${num} → ${newNum}`);
  fs.writeFileSync(hp, txt2, 'utf8');

  const after = gate();
  /* ★ 2026-10-12 按"这张卡的指纹版本"分别判读（此前一律按 v2 判 ⇒ 对存量 v1 卡必然红）。
     实测现状：202 张卡里 **201 张仍是 v1 指纹**（只覆盖文字、不覆盖图形）。
     对 v1 卡，"只改图形"本来就查不出来 —— 这是**存量现状**，不是机制坏了；
     把它报成 FAIL 会让人以为图形指纹失效，反而掩盖真正该做的事（升级存量卡）。
     正确判读：
       · v2 卡 → 必须变「待重盲解」，否则机制真的坏了（判红）
       · v1 卡 → 显式 SKIP 并打印存量缺口，绝不静默放过 */
  /* ★ 2026-10-23：指纹版本直接读卡片自己的 blindFingerprintVer（选卡时已用它优先挑 v2），
     不再额外跑一次门禁去猜 —— 少一次子进程，也避免"门禁 exit 1 被 catch 成 null"的歧义。 */
  const fpVer = Number(cand.it && cand.it.blindFingerprintVer) === 2 ? 2 : 1;

  if (fpVer === 1) {
    skipped++;
    console.log(`  [SKIP] ★ 图形指纹失效对照 —— 样本卡 ${cand.stu}|${cand.id} 仍是 **v1 指纹**（只覆盖文字）。`);
    console.log(`         v1 指纹对"只改图形"本就查不出来，这是**存量现状**而非机制失效。`);
    console.log(`         存量 v1 卡：201 / 202。升级：node _盲解复核.mjs 指纹 --upgrade --force（打"假设"标记）`);
    console.log(`         ⚠ 该 --upgrade 会"以当前题干为准"登记指纹 —— 若某卡题干其实在盲解后被改过，等于把失效结论洗成有效，升级前须人工核对。`);
    console.log(`         → 见 docs\\整改交付报告-20261012.md「遗留项」第 1 条。`);
  } else {
    A('★ 只改图形 → 盲解结论必须失效（待重盲解）', after === '待重盲解', `实际=${after}（v2 指纹应抓到图形变化）`);
  }
} finally {
  console.log('--- 还原 ---');
  restore();
}
const back = gate();
A('还原后回到「有效」', back === '有效', back);
A('题干.html 字节级还原', fs.readFileSync(hp).equals(orig), `${orig.length} B`);

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=` + (3 + fails) + (skipped ? ` 跳过=${skipped}` : ''));
process.exit(fails ? 1 : 0);
