#!/usr/bin/env node
/**
 * neg-answer-source-convergence.cjs —— `answerSource` 取值契约必须是**单一真源**（2026-11-12 立，审计 F04）
 *
 * 事故形态：同一份取值契约原先散在 **3 处代码 + 2 份配方 schema** 里，而且**语义不一致**：
 *   · `_标记复习.mjs`  前缀集 `['独立判卷','官方答案']` + 精确集 `['红笔订正+官方答案页核对']`
 *   · `_盲解复核.mjs`  **又一份**前缀集 `AS_PREFIX_OK`（它的注释自己写着"两处各抄一份必然漂移 —— L-530 族"）
 *   · `_录题入库.mjs`  **精确集**（`['独立判卷','官方答案','红笔订正+官方答案页核对','未能确认']`）
 * 后果（实测形态）：`_盲解复核.mjs` 自己写入的值是 `独立判卷（双路盲解×2 一致）`（带括号限定）
 *   ⇒ 前缀式放行、**精确集判"取值不在契约内"** ⇒ `_录题入库.mjs 改卡` 对这类卡直接失败。
 *
 * 本用例守四件事（零依赖：只读本仓源码 + 自建 %TEMP% 副本）：
 *   ① 三个消费方都从 `_来源.mjs` import，且都不再有本地常量/本地判据实现；
 *   ② 共享模块零副作用（不解析 argv、不读库根）——它被多个 CLI import（L-729）；
 *   ③ 行为：带括号限定的值是**在册**的（修前入库器判非法）；`老师定案` 及其限定形态**不在册**；
 *      `isAcceptableSource` 对「老师定案」只在 `independentProof=true` 时放行；
 *   ④ 阴性自证：把 `baseSourceOf` 的"剥后缀"掏成恒等 ⇒ 带限定值必须变回"不在册"。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const CONSUMERS = ['_录题入库.mjs', '_标记复习.mjs', '_盲解复核.mjs'];
const SRC = path.join(E.TOOLS, '_来源.mjs');

console.log('测试环境：' + E.describe());

console.log('\n══ ① 三个消费方都已收敛 ══');
for (const f of CONSUMERS) {
  const s = fs.readFileSync(path.join(E.TOOLS, f), 'utf8');
  const imports = /from\s*'\.\/_来源\.mjs'/.test(s);
  const local = /const\s+(?:AS|SRC)_(?:PREFIX|EXACT)_OK\s*=/.test(s);
  A(f, imports && !local, 'import=' + imports + ' 本地常量=' + local);
}
{
  const s = fs.readFileSync(path.join(E.TOOLS, '_录题入库.mjs'), 'utf8');
  A('★ `_录题入库.mjs` 里不再有那份**精确集**字面量（修前它对带限定值判非法）',
    !/\['独立判卷',\s*'官方答案',\s*'红笔订正\+官方答案页核对',\s*'未能确认'\]/.test(s), '');
}

console.log('\n══ ② 共享模块零副作用 ══');
const gsrc = fs.readFileSync(SRC, 'utf8');
A('零副作用（剥注释后判：不解析 argv、不读库根）', (() => {
  const c = gsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return !/process\.argv/.test(c) && !/libraryRoot\s*\(/.test(c);
})(), '');

console.log('\n══ ③ 行为 ══');
(async () => {
  const M = await import(pathToFileURL(SRC).href);
  A('★ 带括号限定的「独立判卷（双路盲解×2 一致）」**在册**（修前入库器判非法）',
    M.isInContract('独立判卷（双路盲解×2 一致）') === true, '');
  A('★ `老师定案` 与其限定形态**都不在册**（2026-11-07 已废除）',
    !M.isInContract('老师定案') && !M.isInContract('老师定案（笔迹像）'), '');
  A('乱写的值不在册', !M.isInContract('随便写的') && !M.isInContract(''), '');
  A('★ 合格性：独立/双源合格，`未能确认` 不合格（它不是"合格来源"，只是诚实记录）',
    M.isAcceptableSource('独立判卷') && M.isAcceptableSource('红笔订正+官方答案页核对') && !M.isAcceptableSource('未能确认'), '');
  A('★ 「老师定案」只在 independentProof=true 时放行（放行理由是"答案另有独立出处"）',
    M.isAcceptableSource('老师定案') === false && M.isAcceptableSource('老师定案', { independentProof: true }) === true, '');
  A('baseSourceOf 只剥末尾括号限定', M.baseSourceOf('独立判卷（双路盲解×2＋第三路独立复核一致）') === '独立判卷', M.baseSourceOf('独立判卷（双路盲解×2＋第三路独立复核一致）'));

  console.log('\n══ ④ 阴性自证：掏掉"剥后缀"⇒ 带限定值必须变回不在册 ══');
  {
    const mutated = gsrc.replace(
      "return String(v == null ? '' : v).trim().replace(/[（(][^）)]*[）)]\\s*$/, '').trim();",
      "return String(v == null ? '' : v).trim();");
    A('变异点命中（判据没被改名）', mutated !== gsrc, '');
    const tmp = path.join(E.allocTempDir('gn-src-mut-'), '_来源.mjs');
    fs.writeFileSync(tmp, mutated, 'utf8');
    const M2 = await import(pathToFileURL(tmp).href);
    A('★ 掏掉后 `独立判卷（…）` 变回"不在册"（这条判据确实有牙齿）',
      M2.isInContract('独立判卷（双路盲解×2 一致）') === false, '');
  }

  console.log(`\n[neg-answer-source-convergence] 断言=${passed} 失败=${worst}`);
  process.exit(worst ? 1 : 0);
})().catch(e => { console.error('用例自身异常：' + (e && e.stack || e)); process.exit(1); });
