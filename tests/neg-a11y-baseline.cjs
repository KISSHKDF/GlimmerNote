#!/usr/bin/env node
/**
 * neg-a11y-baseline.cjs —— 前端可访问性的**三条底线**（2026-11-12 立，批次 3）
 *
 * 改前实测：`app.css` 58 处 `font-size:Npx`、`tokens.css` 的六档字号阶梯全是 px、
 * `aria-live` **0 处**、`prefers-reduced-motion` **0 处**。
 *
 * 本用例守三件事（零依赖：只读本仓源码）：
 *   ① **字号用 rem**（相对根字号）—— px 写死的字号是"用户改不动"的字号；
 *   ② 换算**视觉不变**：每个 rem 值 ×16 必须等于改前的整数 px（小数位 ≤ 1），且落在合理区间。
 *      这条是"改了单位但没改观感"的机械证明 —— 只断言"是 rem"会漏掉"分母算错"这类错。
 *   ③ **减少动效**开关被尊重（`prefers-reduced-motion`）+ **动态状态**可被屏幕阅读器播报（`aria-live`）。
 * 另含阴性自证：把一处 rem 改回 px ⇒ ① 必须当场变红。
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

const CSS = ['app.css', 'tokens.css'].map(f => path.join(E.REPO, 'src', 'app', 'css', f));
const HTML = path.join(E.REPO, 'src', 'app', 'index.html');
const cssText = CSS.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const htmlText = fs.readFileSync(HTML, 'utf8');

console.log('测试环境：' + E.describe());

console.log('\n══ ① 字号一律用 rem ══');
{
  const px = [
    ...(cssText.match(/font-size:\s*[\d.]+px/g) || []),
    ...(cssText.match(/\bfont:\s*[\d.]+px/g) || []),
    ...(cssText.match(/--fs-[a-z]+:\s*[\d.]+px/g) || []),
  ];
  A('★ CSS 里没有 px 写的字号（font-size / font 简写 / --fs-* 变量三种形态）',
    px.length === 0, px.length ? px.slice(0, 5).join(' | ') : '0 处');
}

console.log('\n══ ② 换算视觉不变（rem×16 = 改前的整数 px）══');
{
  const rems = [...cssText.matchAll(/font-size:\s*([\d.]+)rem/g)].map(m => Number(m[1]))
    .concat([...cssText.matchAll(/\bfont:\s*([\d.]+)rem/g)].map(m => Number(m[1])))
    .concat([...cssText.matchAll(/--fs-[a-z]+:\s*([\d.]+)rem/g)].map(m => Number(m[1])));
  A('抽到 rem 字号若干（判据没抽空）', rems.length >= 40, rems.length + ' 处');
  /* ⚠ 判据不能写成"×16 必须是 0.5 的整数倍"——原值里本来就有 **11.8px / 12.8px** 这类一位小数
     （tokens.css 注释里那句"12/12.3/12.5/12.8/13.5 五种小字"就是它们）。放宽到"×16 后最多一位小数"，
     仍然抓得住分母算错：少除 16 会得到 118px 这种离谱值（下一条范围断言也会拦）。 */
  const bad = rems.filter(v => Math.abs(v * 16 * 10 - Math.round(v * 16 * 10)) > 1e-6);
  A('★ 每个 rem×16 最多一位小数（= 改前 px 原样，说明分母没算错）',
    bad.length === 0, bad.length ? bad.slice(0, 5).map(v => v + 'rem=' + v * 16 + 'px').join(' | ') : '');
  const odd = rems.filter(v => v < 0.5 || v > 4);
  A('★ 没有离谱值（0.5rem ≤ v ≤ 4rem）—— 抓"少除了 16"这类错', odd.length === 0, odd.slice(0, 5).join(' | '));
  A('视觉不变锚点：body 正文字号 = 0.9375rem（= 改前的 15px）', /font:0\.9375rem\/1\.7/.test(cssText), '');
  A('视觉不变锚点：六档阶梯 = 1.75/1.25/1/0.875/0.8125/0.75rem（= 28/20/16/14/13/12px）',
    /--fs-xxl:1\.75rem; --fs-xl:1\.25rem; --fs-lg:1rem; --fs-md:0\.875rem; --fs-sm:0\.8125rem; --fs-xs:0\.75rem;/.test(cssText), '');
}

console.log('\n══ ③ 减少动效 + 动态状态可播报 ══');
{
  A('★ 有 `prefers-reduced-motion: reduce` 媒体查询', /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(cssText), '');
  const blk = (cssText.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  A('★ 里面同时压了 animation 与 transition（只压一个等于没压）',
    /animation-duration/.test(blk) && /transition-duration/.test(blk), '');
  A('★ 用 0.01ms 而不是 none（保留 animationend/transitionend 时序，避免收尾逻辑失效）',
    /0\.01ms/.test(blk) && !/animation:\s*none/.test(blk), '');
  A('★ `#toasts` 有 role=status + aria-live=polite（提示语默认不会被播报）',
    /id="toasts"[^>]*role="status"[^>]*aria-live="polite"/.test(htmlText), '');
  A('★ `#bootMsg` 有 aria-live（启动状态是会变的文本）',
    /id="bootMsg"[^>]*aria-live="polite"/.test(htmlText), '');
  A('装饰性元素对屏幕阅读器隐藏（boot 的字标与进度条不念出来）',
    /class="boot-logo"[^>]*aria-hidden="true"/.test(htmlText) && /class="boot-bar"[^>]*aria-hidden="true"/.test(htmlText), '');
}

console.log('\n══ ④ 阴性自证：rem 改回 px ⇒ ① 必须红 ══');
{
  const mutated = cssText.replace('--fs-md:0.875rem', '--fs-md:14px');
  A('变异点命中', mutated !== cssText, '');
  const px = (mutated.match(/--fs-[a-z]+:\s*[\d.]+px/g) || []);
  A('★ 掏出一处后确实能被 ① 的判据抓到', px.length === 1, px.join(' | '));
}

console.log(`\n[neg-a11y-baseline] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
