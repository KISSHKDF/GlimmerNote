#!/usr/bin/env node
/**
 * 拾光小册 · **不可判定主观题**门禁（2026-11-28 立）
 *
 * 起因（用户 2026-11-27 原话）：
 *   「某学生，Y0021，这一类的题目，出成这样的错题，孩子是无法做的，你是怎么通过盲解的？
 *     这类题目，建议不要收录进题库了」
 *
 * 为什么需要一道门禁（而不是只在 Y0021 上做一次人工处理）：
 *   ① **盲解对开放题失效** —— 盲解子代理独立写出一段"像样"的答案，与录入答案语义相近
 *      ⇒ 判"一致" ⇒ 卡入库。盲解验的是"能否写出答案"，不是"孩子的答案错在哪"。
 *      ⇒ 开放题会**大批量**通过现有全部门禁（题干门禁/作答门禁/配图门禁/盲解复核）。
 *   ② **证据图可以失配而不被发现** —— Y0021 的 `原卷截图.jpg` 裁图框高度只有原图的 7.5%，
 *      切到的只有红笔标准答案那一行：题干与孩子的黑笔答案**都不在图里**，
 *      而卡面写着「孩子的错解（黑笔，原样保留在原卷截图.jpg）」⇒ 空头支票。
 *      （题干门禁查的是**题干.html**，查不到**证据图**与卡面是否对得上。）
 *   ⇒ 现有门禁**没有一维**在看"这道题孩子到底能不能判错"。本门禁补这一维。
 *
 * 判据（**三条件同时成立**才阻断，缺一条都放行 —— 宁可漏放，不可误伤）：
 *   ① 题干命中开放性题型标记词（启示 / 谈一谈 / 谈谈你的看法 / 结合内容…）；
 *   ② 卡面**没有**任何客观判定依据（老师给分 / 红笔圈改 / 明确采分点 / 评分细则）；
 *   ③ 「错在哪一步」落在**笼统主观**表述上（"答得浅""泛泛""漏采分点"而无采分点清单）。
 *   判据的**唯一真源**在 `_主观题.mjs`（零副作用共享模块）—— 本工具与 `_录题入库.mjs` 共用同一份。
 *
 * 用法（node _主观题门禁.mjs <动作>）：
 *   扫描 [--json]        只读：列出命中/疑似清单（含证据），不判红
 *   门禁 [--json]        命中阻断项 ⇒ 退出码 1；人类模式与 --json 同一次判定、同一退出码
 *
 * ⚠ 本工具**不写盘**：撤卡是**独立动作**（走 `_撤卡留档` 口径），不在本工具里做。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { libraryRoot } from './_库根.mjs';
import { readJsonStrict } from './_安全写.mjs';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';
import { indexFiles } from './_题库发现.mjs';
import { judgeOpenSubjective, hasOpenTypeWord, hasObjectiveGround, OPEN_TYPE_WORDS } from './_主观题.mjs';

const ROOT = libraryRoot();

const argv = process.argv.slice(2);
const { action, opt } = parseArgs(argv, {
  valueFlags: [...COMMON_VALUE_FLAGS],
  boolFlags: ['json', 'help', 'h'],
});
const fail = m => { console.error('✖ ' + m); process.exit(2); };

/* ---------- 题库发现（与 _题干门禁.mjs / _配图门禁.mjs 同规则） ---------- */
function itemsOfJson(j, base) {
  const out = [];
  if (Array.isArray(j.items)) for (const it of j.items) out.push({ item: it, subject: j.subject || '', student: j.student, dirAbs: path.join(base, it.dir) });
  if (j.subjects) for (const [name, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) out.push({ item: it, subject: name, student: j.student, dirAbs: path.join(base, name, it.dir) });
  return out;
}
function allCards() {
  const out = [];
  for (const f of indexFiles(ROOT)) {
    let j;
    try { j = readJsonStrict(f, { label: path.basename(f) }); } catch { continue; }
    for (const x of itemsOfJson(j, path.dirname(f))) out.push({ ...x, key: x.student + '|' + x.item.id });
  }
  return out;
}

/** 读卡面全文（`错题记录.md`）——「错在哪一步」段落在这里，索引里没有。 */
function recordTextOf(dirAbs) {
  const p = path.join(dirAbs, '错题记录.md');
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** 卡面段落切分（`## 标题` 二级标题）。 */
function sectionOf(text, title) {
  const re = new RegExp('##\\s*' + title + '\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)');
  const m = re.exec(text || '');
  return m ? m[1].trim() : '';
}

const HELP = `用法：node _主观题门禁.mjs <动作>
  扫描 [--json]   只读清单（不判红）
  门禁 [--json]   命中阻断项 ⇒ 退出码 1
`;

if (opt.help || opt.h || action === 'help') { console.log(HELP); process.exit(0); }
if (!action || !['扫描', '门禁'].includes(action)) {
  console.log(HELP);
  fail('未知动作：' + (action ?? 'undefined'));
}

/* ---------- 收集 ---------- */
const cards = allCards();
const hits = [];      // 阻断项
const nearMiss = [];  // 命中①但有客观依据 / 或③不成立 —— 只报告

for (const x of cards) {
  const it = x.item;
  const question = String(it.question || '');
  if (!hasOpenTypeWord(question)) continue;

  const rec = recordTextOf(x.dirAbs);
  const card = {
    question,
    answer: it.answer || '',
    studentAnswer: it.studentAnswer || '',
    causeNote: it.causeDesc || it.causeNote || '',
    answerSourceNote: it.answerSourceNote || '',
    teacherAnswer: it.teacherAnswer || '',
    notes: it.answerNote || '',
    recordText: rec,
  };
  const verdict = judgeOpenSubjective(card);
  const row = {
    key: x.key, student: x.student, subject: x.subject, id: it.id,
    dir: it.dir, dirAbs: x.dirAbs,
    question: question.slice(0, 90),
    evidence: verdict.evidence,
    causeText: (sectionOf(rec, '错在哪一步') || card.causeNote).slice(0, 200),
  };
  if (verdict.blocked) {
    hits.push({ ...row, code: verdict.code, msg: verdict.msg });
  } else {
    const ground = hasObjectiveGround(card);
    nearMiss.push({ ...row, reason: ground.ok ? ('有客观依据 ⇒ 可判定：' + ground.why) : '「错在哪一步」具体 ⇒ 可判定' });
  }
}

const ok = hits.length === 0;

/* ---------- 输出 ---------- */
if (opt.json) {
  console.log(JSON.stringify({
    ok, action,
    blocked: hits.length, checked: cards.length,
    problems: hits.map(h => ({ key: h.key, code: h.code, msg: h.msg, evidence: h.evidence, dir: h.dir })),
    reported: nearMiss.map(h => ({ key: h.key, reason: h.reason, question: h.question })),
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\n═══ 拾光小册 · 不可判定主观题门禁 ═══');
console.log('扫描 ' + cards.length + ' 张卡；命中开放性题型标记词 ' + (hits.length + nearMiss.length) + ' 张');

if (hits.length) {
  console.log('\n✖ 阻断 ' + hits.length + ' 张 —— 这类题**没有唯一标准答案**，孩子无法判定自己对错，不得收录：');
  for (const h of hits) {
    console.log('\n  ' + h.key + '  （' + (h.subject || '?') + '）  ' + h.dir);
    console.log('    题干：' + h.question);
    console.log('    「错在哪一步」：' + (h.causeText || '（空）'));
    for (const e of h.evidence) console.log('    · ' + e);
  }
  console.log('\n  怎么办：① 改录本题里有**唯一解/明确采分点/老师给分**的子问；');
  console.log('         ② 本题整体不入库（走「撤卡留档」口径：不删行、只撤档）；');
  console.log('         ③ 若确实要用这题，必须在卡面写明**可机械判定的采分点清单**（否则孩子无法自我检查）。');
}

if (nearMiss.length) {
  console.log('\nⓘ 只报告（不阻断）' + nearMiss.length + ' 张 —— 命中题型词但**有客观依据 / 判错点具体**，仍可收录：');
  for (const h of nearMiss) console.log('  ' + h.key + '  ' + h.reason);
}

console.log('\n' + (ok ? '✔ 门禁通过：没有「不可判定主观题」。' : '✖ 门禁未过：' + hits.length + ' 张不可判定主观题。'));
process.exit(ok ? 0 : 1);
