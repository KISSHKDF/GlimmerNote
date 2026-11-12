#!/usr/bin/env node
/**
 * neg-print-source-id.cjs —— 「做完卷能回到原题」这条链必须一直是通的（2026-11-13 立，批次 4）
 *
 * 外部调研建议"题目稳定 ID + 打印件标注来源 ID（做完卷能回到原题）"。
 * **逐条核对本仓后：这条链已经完整**——
 *   ① 卷面题头印卡号：`1．（M0042）解答题`
 *   ② 答案册题头也印：`1．M0042 解答题`
 *   ③ 题库搜索**已经**匹配卡号（占位符也写着"搜题干 / **编号** / 知识点 / 来源"）
 *   ④ 卷头有学生/出题道数/日期/得分线；题库还有"按编号排序"
 * ⇒ 所以本用例**不是**在做新功能，而是把这条链**钉住**：三个环节用的必须是**同一个字段 `id`**。
 *    改搜索字段（比如改成只搜题干）会让"纸质卷上的号回到原题"这条链静默断掉，而界面上看不出来。
 *
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const paper = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
const bank = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'bank.js'), 'utf8');

console.log('测试环境：' + E.describe());

console.log('\n══ ① 印在纸上的那一环 ══');
A('★ 卷面题头印卡号（`1．（M0042）解答题`）',
  /'<div class="q"><div class="q-hd">' \+ \(i \+ 1\) \+ '．（' \+ U\.esc\(c\.id\) \+ '）'/.test(paper), '');
A('★ 答案册题头也印卡号（`1．M0042 解答题`）—— 家长批改时按号对',
  /'<div class="q"><div class="q-hd">' \+ \(i \+ 1\) \+ '．' \+ U\.esc\(c\.id\)/.test(paper), '');
A('卷头交代了"这是谁的、几道题、哪天印的"',
  /sh-meta/.test(paper) && /出题 ' \+ refs\.length/.test(paper) && /日期：/.test(paper), '');

console.log('\n══ ② 搜回原题的那一环 ══');
A('★ 题库搜索的字段里**有** `x.card.id`（把纸上的号敲进去就能找到它）',
  /\[x\.card\.id, x\.card\.question, x\.card\.type, x\.card\.source/.test(bank), '');
A('★ 搜索框占位符写明"编号"可搜（否则用户不知道能敲号）',
  /placeholder="搜题干 \/ 编号 \//.test(bank), '');
A('有"按编号排序"（同一份卷上的题能按号排齐）', /id: \(a, b\) => a\.card\.id\.localeCompare/.test(bank), '');

console.log('\n══ ③ 三处口径必须是同一个字段 ══');
{
  /* 印的是 c.id、搜的是 x.card.id —— 卡片对象里两者是同一个字段（渲染层包装 vs 裸卡）。
     这条断言防的是"有人把搜索改成搜 title/type，觉得反正都是文字"。 */
  const printed = (paper.match(/U\.esc\(c\.id\)/g) || []).length;
  A('★ 打印侧引用 `c.id` 至少两处（卷面 + 答案册）', printed >= 2, printed + ' 处');
  A('★ 搜索侧引用 `x.card.id`（同一个字段，不是别的近似字段）',
    /\[x\.card\.id,/.test(bank), '');
  A('没有把"卷面题号"当成唯一标识（题号是卷内序号，换一张卷就变）',
    !/q-hd[^\n]{0,60}U\.esc\(i \+ 1\)[^\n]{0,20}search/.test(paper), '');
}

console.log('\n══ ④ 阴性自证：把搜索里的 `x.card.id` 拿掉 ⇒ ② 必须红 ══');
{
  const broken = bank.replace(
    '[x.card.id, x.card.question, x.card.type, x.card.source,',
    '[x.card.question, x.card.type, x.card.source,');
  A('变异点命中', broken !== bank, '');
  A('★ 拿掉后确实能被 ② 的判据抓到（这条断言有牙齿）',
    !/\[x\.card\.id, x\.card\.question/.test(broken), '');
}

console.log(`\n[neg-print-source-id] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
