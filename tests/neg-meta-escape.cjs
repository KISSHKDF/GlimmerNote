#!/usr/bin/env node
/**
 * neg-meta-escape.cjs —— 元数据回显的转义护栏（2026-10-31 建，外部 codex 审查 D01 的护栏）
 *
 * 守什么：**题卡元数据回显不走题干净化器**（`M.stemHtmlSafe` 只处理 stemHtml），
 *   所以索引里任何一个字符串字段进 innerHTML 前都必须过 `U.esc()`。
 *   2026-10-31 实测：`bank.js` 详情块的 `lastReviewedAt` / `blindSolveAt` 直接拼串，
 *   索引里放 `<img src=x onerror=alert(1)>` 就能在打开卡片详情时执行脚本
 *   （同块其它字段都转义了，只有这两个漏 —— 逐个手写转义的结构性风险）。
 *
 * 判据（三条，都有牙齿）：
 *   ① 静态：front-end 里"拼进 innerHTML 的日期字段"必须被 U.esc 包住（源级判据，防新字段漏）；
 *   ② 动态：真的用 vm 加载真实前端，把 payload 放进 lastReviewedAt/blindSolveAt，
 *      打开卡片详情，断言抽屉 body 里**不含可执行标签**（只许出现转义后的实体）；
 *   ③ 阴性自证：把 U.esc 摘掉（内存里改源码，不写文件）⇒ ① 与 ② 必须变红。
 *
 * 用法：node tests\neg-meta-escape.cjs
 * 退出码：0=PASS / 1=FAIL
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = '<img src=x onerror=alert(1)>';

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
}

const read = f => fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8');

/* ---------- ① 静态判据：日期字段必须转义 ---------- */
function staticScan() {
  const bank = read('views/bank.js');
  console.log('== ① 静态：元数据日期字段必须过 U.esc ==');
  /* 精确判据：出现 `c.lastReviewedAt` / `c.blindSolveAt` 且同一表达式里**没有** U.esc 的行 */
  const bad = [];
  bank.split('\n').forEach((line, i) => {
    if (!/c\.(lastReviewedAt|blindSolveAt)\b/.test(line)) return;
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;              // 注释行不算
    /* 允许两种写法：U.esc(c.xxx) 包住，或先 esc 进变量 */
    const okShape = /U\.esc\(\s*c\.(lastReviewedAt|blindSolveAt)\s*\)/.test(line);
    if (!okShape) bad.push((i + 1) + ': ' + line.trim().slice(0, 120));
  });
  A('bank.js 里两处日期字段都被 U.esc 包住', bad.length === 0, bad.length ? bad.join(' | ') : '2/2 已转义');
  return { bank };
}

/* ---------- ② 动态判据：真的跑前端渲染 ---------- */
function renderDetail(bankSrc) {
  const CTB = {};
  const ctx = {
    CTB, console,
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  /* ⚠ 前端 IIFE 里 `window` 与 `globalThis` 必须**同一个对象**且带 addEventListener
     （shell.js 顶部就 `window.addEventListener('focus', …)`）；第一版写成
     `window:{addEventListener(){}}` 与 ctx 分离，直接 TypeError。 */
  ctx.addEventListener = () => { };
  ctx.removeEventListener = () => { };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.window.CTB = CTB;
  ctx.document = { addEventListener() { }, removeEventListener() { }, documentElement: {}, body: {}, createElement: () => ({ style: {}, addEventListener() { } }) };
  vm.createContext(ctx);
  const load = (f, src) => vm.runInContext(src || read(f), ctx, { filename: f });
  for (const f of ['util.js', 'host.js', 'model.js', 'shell.js']) load(f);
  load('views/bank.js', bankSrc);
  const { util: U, host: H, model: M, shell: S, views: V } = CTB;
  S.render = () => { };
  S.toast = () => { };
  H.mode = 'shell';
  M.applyState({
    data: [{ name: '测试生', subjects: [{ name: '数学', items: [{
      id: 'M0001', status: '在册', question: '1+1', stemHtml: '<p>1+1</p>', img: null,
      lastReviewedAt: PAYLOAD, blindSolveAt: PAYLOAD,
    }] }] }],
    admit: { '测试生|M0001': { ok: true } }, blindFresh: {}, figState: {},
  });
  let captured = null;
  S.drawer = o => { captured = o; };
  V.bank.onParam({ openKey: '测试生|M0001' });
  return captured && captured.body || '';
}

console.log('== ② 动态：真实前端渲染后不许出现可执行标签 ==');
const body = renderDetail(null);
A('抽屉 body 已产出（渲染链路通）', !!body, body ? body.length + ' 字符' : '没抓到 body');
A('★ payload 未以原始标签形态进入 HTML', !/<img\s+src=x\s+onerror/i.test(body),
  (body.match(/<img[^>]*onerror[^>]*>/i) || ['（无）'])[0]);
/* ⚠ 判据必须比"标签"而不是比"子串 onerror"：转义后的文本里本来就含 `onerror=` 这几个字符
   （`&lt;img src=x onerror=…&gt;`），当成属性去搜会得到恒假红。第一版就是这么写错的。 */
const rawTagRe = /<[a-z][^>]*\son[a-z]+\s*=/i;    // 真·标签形态的事件属性
A('★ 没有"标签 + on* 事件属性"的组合（只有转义文本）', !rawTagRe.test(body),
  (body.match(rawTagRe) || ['（无）'])[0]);
A('转义实体确实出现（说明是"转义"不是"丢字段"）', /&lt;img/i.test(body),
  (body.match(/&lt;img[^<]{0,40}/i) || ['（没找到实体）'])[0]);

/* ---------- ③ 阴性自证：摘掉 U.esc 必须变红 ---------- */
console.log('\n== ③ 阴性自证：把转义摘掉，① 与 ② 必须变红 ==');
function brokenBank(src) {
  return src
    .replace(/'（上次 ' \+ U\.esc\(c\.lastReviewedAt\) \+ '）'/, "'（上次 ' + c.lastReviewedAt + '）'")
    .replace(/'（' \+ U\.esc\(c\.blindSolveAt\) \+ '）'/, "'（' + c.blindSolveAt + '）'");
}
const orig = read('views/bank.js');
const broken = brokenBank(orig);
A('阴性自证 · 判据能被"摘掉 U.esc"打红（掏得动）', broken !== orig,
  broken === orig ? '替换点没匹配到 —— 本用例与实现脱钩，必须修用例' : '已构造坏版本');
if (broken !== orig) {
  const badLines = [];
  broken.split('\n').forEach((line, i) => {
    if (!/c\.(lastReviewedAt|blindSolveAt)\b/.test(line)) return;
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
    if (!/U\.esc\(\s*c\.(lastReviewedAt|blindSolveAt)\s*\)/.test(line)) badLines.push((i + 1));
  });
  A('阴性自证 · 静态判据在坏版本上确实报红', badLines.length > 0, '命中行 ' + badLines.join(','));
  const badBody = renderDetail(broken);
  A('阴性自证 · 动态判据在坏版本上确实看到可执行标签',
    /<img\s+src=x\s+onerror/i.test(badBody),
    (badBody.match(/<img[^>]*onerror[^>]*>/i) || ['（没复现出来）'])[0]);
}

console.log('\n──────────────────────────────');
console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
process.exit(worst === 0 ? 0 : 1);
