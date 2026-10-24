#!/usr/bin/env node
/**
 * P20261015-01 组卷三缺陷回归（2026-10-16）——「你想玩死我吗」三连的永久护栏。
 *
 * 背景（用户原话级事故）：
 *   ① 孩子的卷面、家长的答案册、系统的回录清单**三种排序并存**（交错组卷与界面洗牌各自为政）；
 *   ② C0008「水分子是由______构成的」印出来空位整段隐形（v2 CSS 从未定义 .blank，题干.html 用
 *      <span class="blank" style="width:16em">，全库 42 张卡受影响）；
 *   ③ C0002 填空题「题干里一个小坑 + 底下又来一个大空框」双答题区，且小坑（6 个下划线字符）
 *      窄到字都写不下。
 *
 * 断言：
 *   A. 顺序单一真源：_标记复习.mjs 组卷**默认不重排**（items ≡ 输入 ids 序），--interleave 才排；
 *      台账 items 必须逐位等于输入顺序（含 2 题/15 题两种规模）。
 *   B. 空位渲染：stemHtmlSafe 把 ASCII/全角下划线转成 .blank 且带 min-width:7em；手写 blank span
 *      保留原宽度；SVG 内部不做转换；标签/文字不受影响。
 *   C. 答题区分流：paperHtml 对「题干有坑」的填空不输出 90px anszone；无坑填空保留；选择/判断恒 0；
 *      解答类不因有坑误判。
 *   D. v2 CSS 必须定义 .blank（防再漂移：v1 有而 v2 没有正是本次事故的根因之一）。
 *   E. 壳侧通道：interleave="0" 会被翻译成 --no-interleave（源码级断言，与 neg-shell-args.cjs 同法）。
 *
 * 退出码 0=全绿。除 F 段真跑组卷+撤批（短暂写台账并完全复原）外全部只读。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs）
   ★ 2026-10-23：A 段要真跑 组卷→撤批，改为跑**临时库副本**（原先直接改真库再还原）。
   副本带 题干.html（含 mtime），否则盲解指纹判失效、组卷被门禁拦下。 */
const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
const LIB = E.makeTempLib(null, { copyCardFiles: true });
const lib = (...p) => path.join(LIB, ...p);
const TOOL_ENV = Object.assign({}, process.env, { CTB_DATA: LIB });
let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

/* ---------- 装载真实 v2 代码（与 neg-v2-smoke.cjs 同法） ---------- */
function loadV2() {
  const ctx = { console };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'host.js', 'model.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8'), ctx, { filename: f });
  }
  ctx.CTB.views = {};                                   // views 由 app.js 建容器，纯函数装载时补桩
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8'), ctx, { filename: 'views/paper.js' });
  return ctx.CTB;
}
const CTB = loadV2();
const U = CTB.util, M = CTB.model, H = CTB.host;
const views = CTB.views.paper;

/* ---------- A. 工具侧：默认不重排（真跑 组卷→查台账→撤批） ---------- */
let paper = null;
try {
  /* ★ 2026-10-24 B-09：原先写死 15 个真实化学卡号与真实学生名；改为动态挑「两道门禁都能过」
     的化学卡（最多 15 张，不足 2 张响亮报错）。A2 断言与规模无关（逐位比对输入顺序）。 */
  const elig = [];
  for (const f of E.findIndexes(LIB)) {
    const j = JSON.parse(fs.readFileSync(lib(f), 'utf8'));
    const push = (it, sn) => { if (sn !== '化学') return; if (!/^独立判卷|^老师定案|^官方答案/.test(it.answerSource || '')) return; if (!['已通过', '已修正'].includes(it.blindStatus || '')) return; elig.push({ stu: j.student, id: it.id }); };
    if (j.subjects) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) push(it, sn);
    if (Array.isArray(j.items)) for (const it of j.items) push(it, j.subject);
  }
  const chem = elig.slice(0, 15);
  if (chem.length < 2) throw new Error('临时库里可组卷的化学卡不足 2 张（eligible=' + elig.length + '）');
  const CHEM_STU = chem[0].stu;
  const ids = chem.map(x => x.id).join(',');
  const out = execFileSync(process.execPath, [E.tool('_标记复习.mjs'), '组卷',
    '--student', CHEM_STU, '--subject', '化学', '--ids', ids,
    '--title', '单序回归自检卷', '--note', '顺序单一真源回归，测毕撤批'], { encoding: 'utf8', env: TOOL_ENV });
  paper = (out.match(/P\d{8}-\d{2}/) || [null])[0];
  A('A1 组卷成功', !!paper, paper);
  if (paper) {
    const led = JSON.parse(fs.readFileSync(lib('_组卷台账.json'), 'utf8'));
    const b = led.batches.find(x => x.paperId === paper);
    A('A2 台账 items 逐位等于输入顺序（默认不重排）', JSON.stringify(b.items) === JSON.stringify(ids.split(',')),
      b.items.join(','));
    A('A3 输出不再含「交错组卷」日志', out.indexOf('交错组卷') < 0, out.split('\n').slice(0, 2).join(' | '));
  }
} catch (e) {
  A('A1 组卷成功', false, String(e.message).slice(0, 120));
} finally {
  if (paper) {
    execFileSync(process.execPath, [E.tool('_标记复习.mjs'), '撤批', '--paper', paper], { encoding: 'utf8', env: TOOL_ENV });
    const led2 = JSON.parse(fs.readFileSync(lib('_组卷台账.json'), 'utf8'));
    A('A4 撤批复原', !led2.batches.some(x => x.paperId === paper));
    const idx2 = JSON.parse(fs.readFileSync(lib('九年级', '_索引.json'), 'utf8'));
    const dirty = [];
    for (const v of Object.values(idx2.subjects || {})) for (const it of (v.items || [])) if ((it.reviews || []).some(r => r.paper === paper)) dirty.push(it.id);
    A('A5 索引无残留流水', dirty.length === 0, dirty.join(','));
  }
}

/* ---------- B. 空位渲染（stemHtmlSafe） ---------- */
{
  const conv = M.stemHtmlSafe({ id: 'T', stemHtml: '<p>微观上，氯化钠是由______构成的。</p>' });
  A('B1 ASCII 下划线 → .blank 且 min-width:7em', /class="blank" style="min-width:7em"/.test(conv), conv);
  A('B2 转换后不再残留裸下划线串', !/_{2,}/.test(conv), conv);
  const hand = M.stemHtmlSafe({ id: 'T', stemHtml: '<p>水分子是由<span class="blank" style="width:16em"></span>构成的。</p>' });
  A('B3 手写 blank span 保留原宽度', /class="blank" style="width:16em"/.test(hand), hand);
  const svg = M.stemHtmlSafe({ id: 'T', stemHtml: '<svg><text x="0" y="10">A____B</text></svg><p>p____q</p>' });
  A('B4 SVG 内部不转换、普通文本转换', /<text[^>]*>A____B<\/text>/.test(svg) && /class="blank"/.test(svg), svg);
  const fullwidth = M.stemHtmlSafe({ id: 'T', stemHtml: '<p>力F做功＿＿＿焦。</p>' });
  A('B5 全角＿串同样转换', /class="blank"/.test(fullwidth), fullwidth);
  const t2 = M.stemHtmlSafe({ id: 'C0002', stemHtml: '<p>17(2) 微观上，氯化钠是由______（填写具体粒子符号）构成的。</p>' });
  A('B6 C0002 实际题干转换成功', /class="blank" style="min-width:7em"/.test(t2), t2);
}

/* ---------- C. 答题区分流（paperHtml 纯函数） ---------- */
{
  const mk = (id, type, question, stemHtml, difficulty) => ({
    key: '学生A|化学|' + id, kid: '学生A', subject: '化学',
    card: { id, type, question: question || '', stemHtml: stemHtml || '', difficulty: difficulty || '中' },
  });
  // 有坑填空：题干带 ______ —— 不得出现 90px anszone
  const h1 = views.printUnit ? null : null;
  // 直接调内部渲染：printUnit 需要 sheet 状态，这里用 V.printUnit 的底层 paperHtml 不可达，
  // 改用单题预览入口 singlePreview 不可取——用 sheet 状态机：构造 refs 后调 printUnit。
  // paper.js 的 printUnit 依赖模块级 sheet 变量；通过 V.singlePreview 的同源函数链不可直接驱动，
  // 因此用 DOM 无关的最小验证：从 v2 源码抽 qHtml（与 neg-stem-backfill liveFn 同法）。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8');
  const m = src.match(/function qHtml\(x, i, form\) \{[\s\S]*?\n  \}/);
  A('C0 qHtml 可抽取', !!m);
  const qHtml = new Function('U', 'M', 'H', 'return (' + m[0].replace(/^function qHtml/, 'function') + ')')(U, M, H);
  const r1 = qHtml(mk('C0002', '填空（粒子符号）', '微观上，氯化钠是由______（填写具体粒子符号）构成的。'), 0, 'stem');
  A('C1 有坑填空不留 90px 大框', r1.indexOf('height:90px') < 0, r1.slice(-120));
  A('C2 有坑填空的坑被转成 .blank（可下笔宽度）', /class="blank"/.test(r1), '');
  const r2 = qHtml(mk('C0005', '填空（符号表达式）', '写出加热高锰酸钾制氧气的符号表达式并指出基本反应类型。'), 0, 'stem');
  A('C3 无坑填空保留 90px 答题条', r2.indexOf('height:90px') >= 0, r2.slice(-120));
  const r3 = qHtml(mk('C0007', '选择（元素推断）', '某气体在氧气中完全燃烧……（　　）'), 0, 'stem');
  A('C4 选择题仍为 0 高度匿名区', r3.indexOf('anszone note" style="height:0"') >= 0, r3.slice(-120));
  const r4 = qHtml(mk('M0000', '解答（含参方程+几何约束）', '已知关于 x 的______方程…（本题题面偶尔带空）'), 0, 'stem');
  A('C5 解答题不因带空被误判成填空', r4.indexOf('height:220px') >= 0, r4.slice(-120));
}

/* ---------- D. CSS 必须有 .blank ---------- */
{
  const css = fs.readFileSync(path.join(ROOT, 'src', 'app', 'css', 'app.css'), 'utf8');
  A('D1 v2 app.css 定义了 .blank', /\.blank\{[^}]*border-bottom/.test(css));
  A('D2 .blank 有可下笔的 min-width', /\.blank\{[^}]*min-width/.test(css));
}

/* ---------- E. 壳侧 interleave 透传 ---------- */
{
  const cs = fs.readFileSync(path.join(ROOT, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
  A('E1 壳侧白名单含 interleave 透传', cs.indexOf('ExtractString(payload, "interleave")') >= 0);
  A('E2 interleave=0 → --no-interleave', /inter == "0" \|\| inter == "false"\) args\.Add\("--no-interleave"\)/.test(cs));
  A('E3 组卷调用方显式传 interleave:0', fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', 'views', 'paper.js'), 'utf8').indexOf("interleave: '0'") >= 0);
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
process.exit(fails ? 1 : 0);
