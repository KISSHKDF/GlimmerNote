#!/usr/bin/env node
/**
 * neg-answer-mask.cjs —— 答案遮罩（2026-11-12 立，批次 4；借 obsidian-mistake-notebook 的四种思路）
 *
 * 事故形态（改前）：翻开答案就是**一览无余**——长答案把整屏撑满（翻页时反而看不到题），
 * 也没有"把答案收回去再想一遍"的通道；而"翻开后扫一眼就算会了"是复习里最常见的自欺。
 *
 * 本用例守五件事（零依赖：只读本仓源码）：
 *   ① 长答案（>400 字）默认**折叠**，可展开/收起；
 *   ② 遮罩风格「模糊」：答案先糊着、**点一下才清晰**（用 CSS `filter`，不是把文字换成占位符——
 *      文字仍在 DOM 里，复制/朗读/查找都不受影响）；
 *   ③ **「重新遮住」**能把答案收回去、退回题面（与 U 的"撤销上一题"是两件事）；
 *   ④ 两个开关**换卡/判分时必须重置**（否则下一题的答案一上来就是"已看清"状态）；
 *   ⑤ 新控件绑定**一律判空**（本文件吃过"无条件取 .onclick"的亏）。
 * 另含阴性自证：把"重新遮住"掏成不生效 ⇒ ③ 必须红。
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

const rev = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'views', 'review.js'), 'utf8');
const shell = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'js', 'shell.js'), 'utf8');
const css = fs.readFileSync(path.join(E.REPO, 'src', 'app', 'css', 'app.css'), 'utf8');

console.log('测试环境：' + E.describe());

console.log('\n══ ① 长答案折叠（>400 字）══');
A('★ 有阈值常量 LONG_ANS = 400', /const LONG_ANS = 400;/.test(rev), '');
A('★ 只在"长且未展开"时截断（不展开也能看到开头，不会一片空白）',
  /const shown = \(long && !longOpen\) \? ans\.slice\(0, LONG_ANS\) \+ '…' : ans;/.test(rev), '');
A('★ 折叠时给「展开完整答案（共 N 字）」按钮，展开后可变「收起答案」',
  /id="rvLong"/.test(rev) && /展开完整答案（共 ' \+ ans\.length \+ ' 字）/.test(rev) && /收起答案/.test(rev), '');
A('切换折叠会重渲染', /const bLong = U\.\$id\('rvLong'\); if \(bLong\) bLong\.onclick = \(\) => \{ longOpen = !longOpen; S\.render\(\); \};/.test(rev), '');

console.log('\n══ ② 模糊遮罩 ══');
A('★ 只有「模糊」风格且还没点开时才遮（默认直显不改观感）',
  /const masked = S\.maskStyle\(\) === 'blur' && !maskOpen;/.test(rev), '');
A('★ CSS 用 filter:blur（**不替换文字**——文字仍在 DOM 里，复制/朗读/查找不受影响）',
  /\.ans-wrap\.masked\s*\{[^}]*filter:\s*blur\(/.test(css), '');
A('★ 遮罩块可点击（点一下=明确的"我要看了"）', /id="rvUnmask"/.test(rev) && /bUnmask\.onclick/.test(rev), '');
A('遮罩时有提示文案（否则用户以为界坏了）', /答案已遮罩/.test(rev), '');
A('遮罩**不参与**答案截断（截断只由折叠决定 —— 两件事不许串味）',
  !/ans\.slice\([^)]*\)[^;]*masked/.test(rev), '');
A('偏好存 localStorage、默认 full', /S\.maskStyle = \(\) => \(U\.lsGet\('gn\.maskStyle', 'full'\)/.test(shell), '');
A('有风格切换按钮', /id="rvMask"/.test(rev) && /S\.toggleMaskStyle/.test(shell), '');

console.log('\n══ ③ 「重新遮住」══');
A('★ 按钮存在', /id="rvRemask"/.test(rev), '');
A('★ 点了之后**退回题面**（reveal = false），并把两个开关一起复位',
  /bRemask\.onclick = \(\) => \{ reveal = false; maskOpen = false; longOpen = false; S\.render\(\); \}/.test(rev), '');
A('快捷键 B（写在按钮 label 上，用户看得见）', /重新遮住 \(B\)/.test(rev) && /e\.key\.toLowerCase\(\) === 'b' && reveal/.test(rev), '');
A('快捷键 M（模糊风格下看清）', /e\.key\.toLowerCase\(\) === 'm' && reveal && S\.maskStyle\(\) === 'blur'/.test(rev), '');

console.log('\n══ ④ 换卡/判分必须重置 ══');
{
  const resets = (rev.match(/longOpen = false; maskOpen = false/g) || []).length;
  A('★ 至少两处重置（判分后 + 换卡时）', resets >= 2, resets + ' 处');
  A('判分后的重置点带着 reveal/noteVal（同一处逻辑）', /reveal = false; noteVal = ''; longOpen = false; maskOpen = false;/.test(rev), '');
  A('换卡时的重置点在 `key !== lastKey` 分支里', /if \(key !== lastKey\) \{ reveal = false; lastKey = key; longOpen = false; maskOpen = false; \}/.test(rev), '');
}

console.log('\n══ ⑤ 新控件绑定一律判空 ══');
A('rvLong / rvUnmask / rvRemask 三个新控件都判空', /if \(bLong\)/.test(rev) && /if \(bUnmask\)/.test(rev) && /if \(bRemask\)/.test(rev), '');
A('rvMask 按钮也判空', /const maskBtn = U\.\$id\('rvMask'\); if \(maskBtn\)/.test(rev), '');

console.log('\n══ ⑥ 阴性自证：掏掉"重新遮住"的生效 ⇒ ③ 必须红 ══');
{
  const broken = rev.replace(/bRemask\.onclick = \(\) => \{ reveal = false; maskOpen = false; longOpen = false; S\.render\(\); \}/,
    'bRemask.onclick = () => { S.render(); };');
  A('变异点命中', broken !== rev, '');
  A('★ 掏掉后确实能被 ③ 的判据抓到',
    !/bRemask\.onclick = \(\) => \{ reveal = false; maskOpen = false; longOpen = false; S\.render\(\); \}/.test(broken), '');
}

console.log(`\n[neg-answer-mask] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
