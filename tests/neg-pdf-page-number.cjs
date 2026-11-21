#!/usr/bin/env node
/**
 * neg-pdf-page-number.cjs —— 打印页数编号门禁（2026-11-21，用户要求「孩子试卷与家长答案，都有页数编号」）
 *
 * 背景：多页卷的 PDF/纸面此前没有任何页码 —— 壳的 pdf op 传 PrintToPdfAsync(abs, null)
 * （默认设置 = 无页眉页脚），散页后无法复原顺序，答案册与试卷也页页对不上。
 *
 * 为什么页码只能走壳侧打印页眉页脚：Chromium 打印管线的 CSS @page 边框盒计数器
 * （@bottom-center{content:counter(page)} 等）在 WebView2 的打印实现里不受支持 ——
 * 卷面 HTML 里数不出"这是第几页"。引擎自带页脚「第 x 页，共 y 页」由打印引擎逐页计、
 * 天然准确（zh-CN 系统即中文），是唯一可靠的路。
 *
 * 本用例守四段（全部源码级断言 + 阴性自证，零库依赖）：
 *   ① 壳 CTBShellV2.cs：页眉页脚真启用 / 页眉=前端透传卷名 / 页脚本地路径被清（隐私）/
 *      设置构造失败退回 null（= 原行为，不阻断出 PDF）；
 *   ② host.js：H.pdf 第二参 title 进桥载荷；
 *   ③ paper.js / stats.js：试卷·答案册·家长报告三个消费点各带自己的名头；
 *   ④ 阴性自证：把任一环掏掉（壳改回 null / 前端掏掉 title）⇒ 判据必须当场变红。
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

const P_CS   = path.join(E.REPO, 'src', 'shell', 'CTBShellV2.cs');
const P_HOST = path.join(E.REPO, 'src', 'app', 'js', 'host.js');
const P_PAPER = path.join(E.REPO, 'src', 'app', 'js', 'views', 'paper.js');
const P_STATS = path.join(E.REPO, 'src', 'app', 'js', 'views', 'stats.js');

/** 判据本体（纯函数）：四份真源码 → 是否合格。阴性自证直接喂变异源码复用同一份判据。 */
function judge(cs, hostJs, paperJs, statsJs) {
  const r = [];
  const push = (name, ok) => r.push({ name, ok });
  /* ① 壳：页码主链路 */
  push('壳 pdf op 不再传 null（PrintToPdfAsync(abs, psPdf)）', /PrintToPdfAsync\(abs,\s*psPdf\)/.test(cs));
  push('壳显式启用页眉页脚（ShouldPrintHeaderAndFooter = true）', /psPdf\.ShouldPrintHeaderAndFooter\s*=\s*true/.test(cs));
  push('页眉 = 前端透传卷名（HeaderTitle ← ExtractStringTop(raw, "title")）',
    /ExtractStringTop\(raw,\s*"title"\)/.test(cs) && /psPdf\.HeaderTitle\s*=/.test(cs));
  push('页眉空卷名兜底（不传也印得出可辨认的名头）', /string\.IsNullOrEmpty\(docTitle\)\s*\?\s*"拾光小册"/.test(cs));
  push('页脚本地路径被清（FooterUri 覆盖，隐私红线）', /psPdf\.FooterUri\s*=\s*" "/.test(cs));
  push('设置构造失败退回 null（不阻断出 PDF，退回原行为）', /catch\s*\(Exception exPs\)[\s\S]*?psPdf\s*=\s*null/.test(cs));
  /* ★ 2026-11-21.02 实机日志抓到的真坑：设置构造放在分派线程（Task.Run）时，env 的 RCW
     跨线程 QI ICoreWebView2Environment6 抛 InvalidCastException ⇒ 每次静默退回 null、页码
     不出现。设置构造必须在 UI 线程（与 PrintToPdfAsync 同在 BeginInvoke 块内），且用
     wv.CoreWebView2.Environment（控件就绪的真实环境对象）而不是外层 env 变量。 */
  const beg = cs.indexOf('BeginInvoke((Action)(async () =>', cs.indexOf('op == "pdf"'));
  const mk = cs.indexOf('CreatePrintSettings()', beg < 0 ? 0 : beg);
  /* pdf op 段（到 printDirect 为止）：设置构造必须走控件环境对象；printDirect 段的
     env.CreatePrintSettings() 在它自己的 BeginInvoke（UI 线程）内、与本门禁无关，不动。 */
  const pdfOp = cs.slice(cs.indexOf('op == "pdf"'), cs.indexOf('else if (op == "printDirect")'));
  push('设置构造走 wv.CoreWebView2.Environment（pdf op 内不用外层 env 变量）',
    /wv\.CoreWebView2\.Environment\.CreatePrintSettings\(\)/.test(pdfOp) && !/env\.CreatePrintSettings\(\)/.test(pdfOp));
  push('设置构造在 UI 线程 BeginInvoke 块内（跨线程 QI 会炸，实机日志实证）', beg >= 0 && mk > beg, '');
  push('printDirect 段不受影响（env.CreatePrintSettings 仍在它自己的 UI 线程块内）', /var ps = env\.CreatePrintSettings\(\);/.test(cs), '');
  /* ② host.js：title 进桥载荷 */
  push('H.pdf 第二参 title 进桥载荷', /bridge\('pdf',\s*\{\s*path:\s*relPath,\s*title:\s*title \|\| ''\s*\}/.test(hostJs));
  /* ③ 三个消费点各带名头（试卷/答案册共用一个三元表达式 + 同一条卷名尾巴，判据看两个名头与尾巴都在） */
  push('试卷 PDF 页眉=错题重做卷·卷名', /'错题重做卷 · '/.test(paperJs) && /\(sheet\.title \|\| ''\)/.test(paperJs));
  push('答案册 PDF 页眉=答案册·卷名', /'答案册（家长批改用）· '/.test(paperJs) && /\(sheet\.title \|\| ''\)/.test(paperJs));
  push('家长报告 PDF 页眉=学生·报告名', /·家长报告\s*'\s*\+\s*U\.today\(\)/.test(statsJs));
  return r;
}

console.log('测试环境：' + E.describe());
const cs = fs.readFileSync(P_CS, 'utf8');
const hostJs = fs.readFileSync(P_HOST, 'utf8');
const paperJs = fs.readFileSync(P_PAPER, 'utf8');
const statsJs = fs.readFileSync(P_STATS, 'utf8');

console.log('\n══ ①②③ 真源码判据 ══');
for (const { name, ok } of judge(cs, hostJs, paperJs, statsJs)) A(name, ok);

console.log('\n══ ④ 阴性自证：掏掉任何一环 ⇒ 判据必须红 ══');
{
  /* 变异 1：壳改回 PrintToPdfAsync(abs, null)（= 旧行为，无页码） */
  const m1 = cs.replace(/bool okPdf = await wv\.CoreWebView2\.PrintToPdfAsync\(abs, psPdf\);/,
    'bool okPdf = await wv.CoreWebView2.PrintToPdfAsync(abs, null);');
  A('变异点命中（壳改回 null）', m1 !== cs, '');
  const j1 = judge(m1, hostJs, paperJs, statsJs);
  A('★ 壳退回 null ⇒ 「不再传 null」判据红（这条判据确实有牙齿）', j1[0].ok === false, j1.filter(x => !x.ok).length + ' 条红');
  /* 变异 2：壳不启用页眉页脚（页码没了但 PDF 还能出） */
  const m2 = cs.replace(/psPdf\.ShouldPrintHeaderAndFooter\s*=\s*true;/, '/* mutated */;');
  A('变异点命中（页眉页脚开关被掏）', m2 !== cs, '');
  const j2 = judge(m2, hostJs, paperJs, statsJs);
  A('★ 掏掉页眉页脚开关 ⇒ 「显式启用」判据红', j2[1].ok === false, '');
  A('★ 掏掉开关不牵连 UI 线程判据（两判据独立）', j2[4].ok === true && j2[5].ok === true, '');
  /* 变异 3：壳不接收 title（页眉统一印应用名，卷与册无法区分） */
  const m3 = cs.replace(/string docTitle = ExtractStringTop\(raw, "title"\);/, '');
  A('变异点命中（壳不接收 title）', m3 !== cs, '');
  A('★ 掏掉 title 接收 ⇒ 页眉判据红', judge(m3, hostJs, paperJs, statsJs)[2].ok === false, '');
  /* 变异 4：前端不透传卷名（整条 H.pdf(name, …) 退回 H.pdf(name) ⇒ 两个名头与尾巴一起消失） */
  const m4 = paperJs.replace(/const r = await H\.pdf\(name, \(kind === 'ans' \? '答案册（家长批改用）· ' : '错题重做卷 · '\) \+ \(sheet\.title \|\| ''\)\);/,
    'const r = await H.pdf(name);');
  A('变异点命中（前端掏掉 title）', m4 !== paperJs, '');
  const j4 = judge(cs, hostJs, m4, statsJs);
  /* judge 返回序：10=试卷页眉 11=答案册页眉 12=家长报告页眉 */
  A('★ 前端掏掉 title ⇒ 试卷页眉判据红', j4[10].ok === false, '');
  A('★ 同一变异同时红两条（试卷+答案册共链；家长报告走 stats 不受牵连）',
    j4[11].ok === false && j4[12].ok === true, '');
}

console.log(`\n[neg-pdf-page-number] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
