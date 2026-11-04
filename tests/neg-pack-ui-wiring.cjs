#!/usr/bin/env node
/**
 * 批次 2 · W3「界面接入」（2026-11-03）· 选卡 / 经验包入口 / 灯箱统一坐标
 *
 * 为什么必须有它：批次 2 的引擎侧（`_经验包.mjs` / `_配方.mjs --card`）再全，也只有"页面把
 * `cards`/`cardConflict` 真送进壳、把停用包真拦住、把失败原因真上屏"才到达用户。任何一环少接线，
 * 用户看到的就是"我明明选了两张卡，AI 却像没看见"——而 CLI 测试全绿（防线烂在最后一厘米，
 * 同 L-441/L-716「声明与消费者必须机读对齐」家族）。
 *
 * 本用例五段（源码级 + 行为级混合，**每条判据都配"掏掉它必须变红"的阴性对照**）：
 *   A 源码级·登记：index.html 真登记 packs.js；ROUTES 真有「经验包」入口且在「录题」之后；
 *     `清单` 的解析只有一份实现（views/packs.js），录题页不另写一份。
 *   B 行为级·录题页选卡：把 ingest.js 的选卡函数**切出来真驱动**——
 *     ① 选卡串按契约形状送出（`<packId>/<cardId>@<version>`，逗号分隔）+ 冲突策略随行；
 *     ② 没选卡时一个字段都不多发（"无 --card 时任务单逐字节不变"的页面侧前提）；
 *     ③ 停用包填了卡 ID ⇒ **不生成、不发组装**，且把"已停用/怎么恢复"上屏；
 *     ④ 卡 ID / 版本不成形 ⇒ 拒绝并点名；⑤ 引用了清单里没有的包 ⇒ 点名；
 *     ⑥ 清单读不到 ⇒ 生成照做但结果必须写明"清单没读到"（不许静默当成没选卡）；
 *     ⑦ 工具因冲突拒收 ⇒ 工具原文 + "改哪个下拉"上屏；⑧ `first` 策略的让位行必须转出来。
 *   C 行为级·经验包页：真跑 views/packs.js（注入 CTB 桩）——
 *     读不到 ⇒ 显示原因而**不是**"没有安装任何经验包"；packs:[] ⇒ 空态；
 *     没有 packs 字段 ⇒ 明说不能当成没装包；来源绝对路径脱敏（隐私红线）。
 *   D 行为级·灯箱两条坐标路等价：切出 shell.js 的 `normToPx`/`boxNormPx`/`lbFocusPx` 真跑——
 *     旧 `box` 像素路 与 `boxNorm×imgW,imgH` 路**逐值相等**；缺字段回落不报错；整页 `origBox` 路不动。
 *   E 阴性对照（变异自证，全部当场执行）：掏掉停用判断 / 掏掉失败分支 / 掏掉归一化换算 ⇒
 *     B③ / C / D 的判据必须分别变红。恒真断言比没有断言更坏（它占着"有防线"的位置）。
 *
 * 端到端（真 exe + CDP 驱动页面点选卡）不在本用例：那属于发版前的壳侧验收。
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 240) : ''}`); if (!ok) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const INGEST = rd('src/app/js/views/ingest.js');
const PACKS = rd('src/app/js/views/packs.js');
const SHELL = rd('src/app/js/shell.js');
const HOST = rd('src/app/js/host.js');
const HTML = rd('src/app/index.html');

/* 按锚点切片：切不出来就**显式判红**，绝不静默跳过（切不动说明结构被改名/重排，判据自己就失效了）。 */
function sliceIn(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error('找不到起始锚点：' + from);
  const b = to ? src.indexOf(to, a + from.length) : src.length;
  if (to && b < 0) throw new Error('找不到结束锚点：' + to);
  return src.slice(a, b);
}

/* ═════════ A · 源码级：登记与唯一实现 ═════════ */
console.log('═══ A · 登记：脚本 / 侧栏入口 / 清单解析只有一份 ═══');
A('index.html 登记了 js/views/packs.js（与既有 script 同风格）',
  /<script src="js\/views\/packs\.js"><\/script>/.test(HTML));
const routesBlock = sliceIn(SHELL, 'const ROUTES = [', '];');
A('ROUTES 里有「经验包」入口（id=packs）', /id: 'packs'/.test(routesBlock));
A('「经验包」排在「录题」之后（用户先认识包、再选卡）',
  routesBlock.indexOf("id: 'ingest'") >= 0 && routesBlock.indexOf("id: 'ingest'") < routesBlock.indexOf("id: 'packs'"));
A('packs.js 定义了 CTB.views.packs', /CTB\.views\.packs\s*=/.test(PACKS));
A('`清单` 的读取与解析只在 views/packs.js（录题页不另写一份解析：两份必然漂移，本仓 L-286）',
  /H\.recipe\('清单'/.test(PACKS) && !/H\.recipe\('清单'/.test(INGEST));
A('录题页通过 CTB.views.packs 复用清单读取（不是自己解析 JSON）',
  /CTB\.views\.packs/.test(INGEST) && !/JSON\.parse\(/.test(sliceIn(INGEST, 'function cardIdOk(id)', 'async function onBoundCheck(')));
A('host.js 的 recipe 只做透传（Object.assign({action}, flags)），不为选卡字段加语义',
  /H\.recipe = async function[\s\S]{0,600}?Object\.assign\(\{ action \}, flags \|\| \{\}\)/.test(HOST) &&
  !/cardConflict|'cards'/.test(HOST.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')));
/* 像素框 `box` 的产出点唯一性：将来别处再开一条像素路、归一化却没人用 ⇒ 这条必须红。 */
const JS_FILES = [];
(function walkJs(d, base) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walkJs(path.join(d, e.name), rel);
    else if (e.name.endsWith('.js')) JS_FILES.push(rel);
  }
})(path.join(ROOT, 'src', 'app', 'js'), 'src/app/js');
const boxProducers = JS_FILES.filter(f => /\bbox:\s*\(p\.box && p\.box\.length === 4\)/.test(rd(f)));
A('A/唯一性：像素框 `box` 全仓只有一处产出，且就是 pending.js 的 gItem',
  boxProducers.length === 1 && boxProducers[0] === 'src/app/js/views/pending.js', JSON.stringify(boxProducers));
A('A/写盘侧不许碰：pending.js 登记表单那条 `box: boxNorm(U.$id(\'paBox\').value)` 逐字还在',
  /box: boxNorm\(U\.\$id\('paBox'\)\.value\)/.test(rd('src/app/js/views/pending.js')));
A('shell.js 的灯箱取框只走 lbFocusPx（不再直接拿 it.box 当 focus）',
  /let focus = lbFocusPx\(it, img, showOrig\);/.test(SHELL) && !/focus = it\.box\b/.test(SHELL));

/* ═════════ B · 行为级：录题页选卡（切出真函数驱动） ═════════ */
console.log('\n═══ B · 录题页选卡：真送出 / 真拦住 / 真上屏 ═══');
/* 切片锚点与 ingest.js 的**有意排布**对应：onGenerate 之后紧跟选卡助手，再之后才是 onBoundCheck
   —— 批次 1 的 tests\neg-task-page-wiring.cjs 按「onGenerate … onBoundCheck」整段切片，
   助手必须落在那个窗口里，否则那条用例会切成悬空引用（本轮真实踩过）。 */
const CARD_SRC = sliceIn(INGEST, 'function cardIdOk(id)', 'async function onBoundCheck(');
const GEN_SRC = sliceIn(INGEST, 'async function onGenerate()', 'function cardIdOk(id)');
const PAGE_SRC = CARD_SRC + GEN_SRC;
const buildPage = (src) => new Function('U', 'H', 'S', 'CTB', 'st', 'inboxFiles', 'copyText', 'revealShot',
  src + '\nreturn { cardIdOk, packVerOk, collectCards, packsPickerHtml, loadPacks, paintPacks, reloadPacks, onGenerate };');

let PAGEFN = null, PAGE_ERR = '';
try { PAGEFN = buildPage(PAGE_SRC); } catch (e) { PAGE_ERR = String((e && e.message) || e); }
A('B0 选卡函数能从 ingest.js 切出来并驱动（切不出来即红，绝不静默跳过）', !!PAGEFN, PAGE_ERR);

const PACK_A = { id: 'family-a/shared-stem', version: '1.0.0', dir: 'family-a/shared-stem/1.0.0', enabled: true, verdict: { ok: true, errors: [] }, title: '共享题干' };
const PACK_B = { id: 'family-b/other', version: '2.1.0', dir: 'family-b/other/2.1.0', enabled: false, verdict: { ok: true, errors: [] }, title: '停用包' };

/* 真跑一遍 views/packs.js，拿到它的 `srcText`（来源脱敏的唯一实现）——录题页的选卡区也用这一份，
   用例里不再手写第二份脱敏逻辑（否则测的是测试自己的实现）。 */
const REAL_PACKS_V = (() => {
  const CTB = {
    util: { esc: (s) => (s == null ? '' : String(s)), $id: () => ({ innerHTML: '', onclick: null }) },
    host: { recipe: async () => ({ ok: true, code: 0, out: '{"packs":[]}', err: '' }) },
    shell: { toast: () => { }, refreshSub: () => { } },
    views: {},
  };
  new Function('CTB', PACKS)(CTB);
  return CTB.views.packs;
})();

function mkPage(over) {
  const o = over || {};
  const els = {};
  const mkEl = () => ({ innerHTML: '', disabled: false, textContent: '', value: '', hidden: false, onclick: null, querySelectorAll: () => [] });
  const calls = { recipe: [], toast: [] };
  const st = Object.assign({
    recipe: 'ingest-page', subject: '数学', conflict: 'deny', batch: '', picked: {}, typed: {},
    packs: { ok: true, packs: o.packs || [], error: null },
    task: '', verdict: null, inbox: null, shot: null, taskId: null,
  }, o.st || {});
  const U = { $id: (id) => (els[id] || (els[id] = mkEl())), esc: (s) => (s == null ? '' : String(s)) };
  const H = {
    recipe: async (action, flags) => {
      calls.recipe.push({ action, flags: JSON.parse(JSON.stringify(flags || {})) });
      return o.reply ? o.reply(action, flags) : { ok: true, code: 0, out: 'TASK-SHEET\n', err: '' };
    },
  };
  const S = { toast: (m) => calls.toast.push(String(m)), refreshSub: () => { } };
  const CTB = { views: { packs: { load: async () => st.packs, srcText: REAL_PACKS_V.srcText } } };
  /* o.src 允许喂变异体源码（阴性对照用），默认就是 ingest.js 里切出来的那两段。 */
  const fns = buildPage(o.src || PAGE_SRC)(U, H, S, CTB, st, () => [], async () => true, () => { });
  return { st, calls, els, fns, html: (id) => ((els[id] || {}).innerHTML || '') };
}

(async () => {
  if (PAGEFN) {
    /* B1 正常路：选卡串 + 冲突策略一起送出 */
    const p1 = mkPage({ packs: [PACK_A, PACK_B], st: { typed: { 'family-a/shared-stem': 'shared-stem, extra' }, conflict: 'deny' } });
    await p1.fns.onGenerate();
    const f1 = (p1.calls.recipe[0] || {}).flags || {};
    A('B1 选卡串按契约形状送出：<packId>/<cardId>@<version>，逗号分隔，多项不丢',
      f1.cards === 'family-a/shared-stem/shared-stem@1.0.0,family-a/shared-stem/extra@1.0.0', JSON.stringify(f1.cards));
    A('B1b 冲突策略随卡一起送（deny 默认）', f1.cardConflict === 'deny' && p1.calls.recipe[0].action === '组装', JSON.stringify(f1));
    /* B1c 选卡区必须显示「来源 / 版本 / 启用状态」（任务单里点明要的三样），
       且来源走 packs.js 的脱敏实现（绝对路径不许上屏）。 */
    const p1c = mkPage({ packs: [PACK_A, { id: 'x/y', version: '3.0.0', dir: 'C:\\packs\\x\\y\\3.0.0', enabled: true, verdict: { ok: true, errors: [] }, title: '绝对路径包' }] });
    await p1c.fns.paintPacks();
    const h1c = p1c.html('igPackBox');
    A('B1c 选卡区显示 来源/版本/启用状态', /来源 /.test(h1c) && /版本 1\.0\.0/.test(h1c) && /启用/.test(h1c));
    A('B1d 绝对路径来源在同一份脱敏实现下不出现在选卡区（不出现盘符）',
      !/C:[\\/]/.test(h1c) && /…\/x\/y\/3\.0\.0/.test(h1c), h1c.slice(0, 200));
    A('B1e 成功抬头把"用了哪几张卡"说出来（用户可核对）', /已选卡 <b>2<\/b> 张/.test(p1.html('igTaskBox')));

    /* B2 没选卡：一个字段都不多发（页面侧"无 --card 时任务单逐字节不变"的前提） */
    const p2 = mkPage({ packs: [PACK_A], st: { typed: {} } });
    await p2.fns.onGenerate();
    const f2 = (p2.calls.recipe[0] || {}).flags || {};
    A('B2 没选卡：flags 里没有 cards / cardConflict（不多发一个字段）',
      !('cards' in f2) && !('cardConflict' in f2), JSON.stringify(f2));

    /* B3 停用包：必须拦住 + 写明原因 + 指出怎么恢复 */
    const p3 = mkPage({ packs: [PACK_A, PACK_B], st: { typed: { 'family-b/other': 'x' } } });
    await p3.fns.onGenerate();
    A('B3 停用包填了卡 ID ⇒ **不生成**（没调组装）', p3.calls.recipe.length === 0, 'recipe=' + p3.calls.recipe.length);
    A('B3b 上屏写明"已停用"与恢复办法（`.停用` 文件），不是一句"失败了"',
      /已停用/.test(p3.html('igTaskBox')) && /\.停用/.test(p3.html('igTaskBox')));

    /* B4 非法卡 ID / 版本不成形：拒绝并点名 */
    const p4 = mkPage({ packs: [PACK_A], st: { typed: { 'family-a/shared-stem': 'a/b' } } });
    await p4.fns.onGenerate();
    A('B4 卡 ID 含 `/` ⇒ 拒绝、不调组装、点名"不合法"',
      p4.calls.recipe.length === 0 && /不合法/.test(p4.html('igTaskBox')));
    const p4b = mkPage({ packs: [{ id: 'p/x', version: 'v1', dir: 'p/x/v1', enabled: true, verdict: { ok: true, errors: [] } }], st: { typed: { 'p/x': 'c' } } });
    await p4b.fns.onGenerate();
    A('B4b 版本不是「数字.数字.数字」⇒ 拒绝、点名（否则壳必拒，用户看到的是 code:2）',
      p4b.calls.recipe.length === 0 && /数字\.数字\.数字/.test(p4b.html('igTaskBox')));

    /* B5 引用了清单里没有的包（卸载/改名）：点名，不当没填过 */
    const p5 = mkPage({ packs: [PACK_A], st: { typed: { 'ghost/pack': 'c' } } });
    await p5.fns.onGenerate();
    A('B5 选卡引用了清单里没有的包 ⇒ 拒绝并点名（不许静默丢掉）',
      p5.calls.recipe.length === 0 && /ghost\/pack/.test(p5.html('igTaskBox')));

    /* B6 清单读不到：生成照做（不拦录题），但结果必须写明"清单没读到" */
    const p6 = mkPage({ st: { typed: {}, packs: { ok: false, packs: [], error: '壳通道挂了' } } });
    await p6.fns.onGenerate();
    A('B6 清单读不到：仍然生成（不拦着用户录题）', p6.calls.recipe.length === 1);
    A('B6b 但结果里必须写明"经验包清单没读到（本次未选卡）"——不许静默当成没选卡',
      /经验包清单没读到/.test(p6.html('igTaskBox')) && /壳通道挂了/.test(p6.html('igTaskBox')));

    /* B7 工具因冲突拒收：判词用**真跑出来的原文**（2026-11-03 实测 `_配方.mjs 组装 --card A --card B
       --card-conflict deny`：exit 2 + 「✖ 选卡冲突：/步骤「整页拆分」被两张卡同时覆盖：A 与 B」） */
    const DENY_MSG = '✖ 选卡冲突：\n  步骤「整页拆分」被两张卡同时覆盖：family-a/shared-stem/shared-stem@1.0.0 与 family-a/shared-stem/shared-stem-2@1.0.0\n' +
      '  处置：--card-conflict=first（保留先给的，让位的卡**整卡**不进提示词并打印一行）\n        或 --card-conflict=all（全部按 --card 顺序拼入）';
    const p7 = mkPage({
      packs: [PACK_A],
      st: { typed: { 'family-a/shared-stem': 'shared-stem, extra' } },
      reply: () => ({ ok: false, code: 2, out: '', err: DENY_MSG }),
    });
    await p7.fns.onGenerate();
    A('B7 工具拒收（选卡冲突）⇒ 工具原文上屏', /同时覆盖/.test(p7.html('igTaskBox')));
    A('B7b 并指路改哪个下拉（先到先得 / 全部拼入）', /选卡冲突策略/.test(p7.html('igTaskBox')) && /先到先得/.test(p7.html('igTaskBox')));

    /* B7c 另一种真实判词：同一张卡填两次（三种策略都拒，实测 exit 2）⇒ 页面侧提前拦住，不发组装 */
    const p7c = mkPage({ packs: [PACK_A], st: { typed: { 'family-a/shared-stem': 'shared-stem, shared-stem' } } });
    await p7c.fns.onGenerate();
    A('B7c 同一张卡填两次 ⇒ 页面侧就拒（不调组装），并说明"与冲突策略无关"',
      p7c.calls.recipe.length === 0 && /两次/.test(p7c.html('igTaskBox')) && /冲突策略无关/.test(p7c.html('igTaskBox')),
      p7c.html('igTaskBox').slice(0, 200));

    /* B8 first 策略：工具打印的"让位"行必须转出来（吞掉 = 用户以为两张卡都生效了） */
    const p8 = mkPage({
      packs: [PACK_A],
      st: { typed: { 'family-a/shared-stem': 'shared-stem, extra' } },
      reply: () => ({ ok: true, code: 0, out: 'TASK-SHEET\n', err: 'x 任务记录：t-20261103-101010-abcdef（<库根>\\_录题\\t-20261103-101010-abcdef.json）\n⚠ 选卡冲突（--card-conflict=first）：步骤「整页拆分」已由 family-a/shared-stem/shared-stem@1.0.0 覆盖 ⇒ 让位（整卡不进提示词）：family-a/shared-stem/extra@1.0.0\n' }),
    });
    await p8.fns.onGenerate();
    A('B8 first 策略的"让位"行必须上屏（工具原文，不吞）', /让位/.test(p8.html('igTaskBox')) && !/任务记录/.test(p8.html('igCardNote')));

    /* ═════════ C · 行为级：经验包页（注入 CTB 桩真跑 views/packs.js） ═════════ */
    console.log('\n═══ C · 经验包页：读不到≠没装 / 空态 / 来源脱敏 ═══');
    const tick = () => new Promise(r => setTimeout(r, 0));
    const mkPacks = (reply) => {
      const els = {};
      const calls = { recipe: [] };
      const CTB = {
        util: { esc: (s) => (s == null ? '' : String(s)), $id: (id) => (els[id] || (els[id] = { innerHTML: '', onclick: null, hidden: false })) },
        host: { recipe: async (action, flags) => { calls.recipe.push({ action, flags: JSON.parse(JSON.stringify(flags || {})) }); return reply(action, flags); } },
        shell: { toast: () => { }, refreshSub: () => { } },
        views: {},
      };
      new Function('CTB', PACKS)(CTB);
      return { V: CTB.views.packs, els, calls, html: (id) => ((els[id] || {}).innerHTML || '') };
    };
    const jout = (obj) => ({ ok: true, code: 0, out: JSON.stringify(obj), err: '' });

    const c1 = mkPacks(() => jout({ recipes: [], packs: [] }));
    await c1.V.load(true); c1.V.render({}); await tick();
    A('C1 packs:[] ⇒ 空态就是契约原文「没有安装任何经验包」', /没有安装任何经验包/.test(c1.html('pkBox')));
    A('C1b 读的就是 recipe 通道的「清单」+ json=1（壳已放行的动作，没有新动作）',
      c1.calls.recipe.length === 1 && c1.calls.recipe[0].action === '清单' && c1.calls.recipe[0].flags.json === '1');

    const c2 = mkPacks(() => ({ ok: false, code: 1, out: '', err: '壳通道挂了' }));
    await c2.V.load(true); c2.V.render({}); await tick();
    A('C2 清单读不到 ⇒ 显示原因', /读不到经验包清单/.test(c2.html('pkBox')) && /壳通道挂了/.test(c2.html('pkBox')));
    A('C2b 且**不许**退化成"没有安装任何经验包"（两件事用户要做的动作不同）',
      !/没有安装任何经验包/.test(c2.html('pkBox')));

    const c3 = mkPacks(() => jout({ recipes: [] }));
    await c3.V.load(true); c3.V.render({}); await tick();
    A('C3 返回里没有 packs 字段 ⇒ 明说"不能当成没装包"',
      /packs 字段/.test(c3.html('pkBox')) && !/没有安装任何经验包/.test(c3.html('pkBox')));

    const c4 = mkPacks(() => jout({ recipes: [], packs: [PACK_A, PACK_B] }));
    await c4.V.load(true); c4.V.render({}); await tick();
    const h4 = c4.html('pkBox');
    A('C4 有包 ⇒ 逐包列出 来源/版本/启用状态/校验结论',
      /family-a\/shared-stem/.test(h4) && /版本 1\.0\.0/.test(h4) && /启用/.test(h4) && /校验结论：通过/.test(h4));
    A('C4b 停用包显示「已停用」并写出恢复办法', /已停用/.test(h4) && /\.停用/.test(h4));
    const ABS_DIR = 'C:\\Users\\<用户名>\\AppData\\Local\\拾光小册\\经验包\\family-a\\shared-stem\\1.0.0';
    A('C4c 来源绝对路径被脱敏（隐私红线：界面截图不带出本机路径）',
      !/C:/.test(c4.V.srcText({ dir: ABS_DIR })) && !/Users/.test(c4.V.srcText({ dir: ABS_DIR })),
      c4.V.srcText({ dir: ABS_DIR }));
    A('C4d 相对来源原样显示（清单给相对路径时不改动）',
      c4.V.srcText({ dir: 'family-a/shared-stem/1.0.0' }) === 'family-a/shared-stem/1.0.0');
    A('C4e 逐包校验结论照实说（what：why 都要在）',
      /缺文件/.test(c4.V.verdictText({ verdict: { ok: false, errors: [{ code: 'E1', what: '缺文件', why: 'cards/x.md 不存在' }] } })) &&
      /cards\/x\.md 不存在/.test(c4.V.verdictText({ verdict: { ok: false, errors: [{ what: '缺文件', why: 'cards/x.md 不存在' }] } })));

    /* ═════════ D · 行为级：灯箱两条坐标路等价 ═════════ */
    console.log('\n═══ D · 灯箱统一坐标：box 像素路 ⇄ boxNorm×imgW,imgH 路 ═══');
    let LBFN = null, LB_ERR = '';
    const LB_SRC = sliceIn(SHELL, 'const normToPx =', 'function loadLb()');
    try { LBFN = new Function(LB_SRC + '\nreturn { normToPx, boxNormPx, lbFocusPx };')(); } catch (e) { LB_ERR = String((e && e.message) || e); }
    A('D0 两个坐标函数能从 shell.js 切出来并驱动', !!LBFN, LB_ERR);
    if (LBFN) {
      const img = { naturalWidth: 800, naturalHeight: 600 };
      const PIX = [80, 60, 240, 120];
      A('D1 旧记录（只有像素 box）⇒ 原路返回', eq(LBFN.lbFocusPx({ box: PIX }, img, false), PIX));
      A('D2 新记录（只有 boxNorm+imgW/imgH）⇒ 换算成**同一组像素**（两条路等价）',
        eq(LBFN.lbFocusPx({ boxNorm: [0.1, 0.1, 0.3, 0.2], imgW: 800, imgH: 600 }, img, false), PIX),
        JSON.stringify(LBFN.lbFocusPx({ boxNorm: [0.1, 0.1, 0.3, 0.2], imgW: 800, imgH: 600 }, img, false)));
      A('D2b 两条路各自独立算（不是"都返回同一个字段"）：一个给 box、一个给 boxNorm，结果逐值相等',
        eq(LBFN.lbFocusPx({ box: PIX }, img, false), LBFN.lbFocusPx({ boxNorm: [0.1, 0.1, 0.3, 0.2], imgW: 800, imgH: 600 }, img, false)));
      A('D3 缺 imgW/imgH（或给了 0）⇒ 回落 box，不报错',
        eq(LBFN.lbFocusPx({ boxNorm: [0.1, 0.1, 0.3, 0.2], box: PIX }, img, false), PIX) &&
        eq(LBFN.lbFocusPx({ boxNorm: [0.1, 0.1, 0.3, 0.2], imgW: 0, imgH: 0, box: PIX }, img, false), PIX));
      A('D4 两条路都没有 ⇒ null（不抛异常、不画错框）', LBFN.lbFocusPx({}, img, false) === null);
      A('D5 整页路（origBox）不受影响：0~1 × 整页实际像素',
        eq(LBFN.lbFocusPx({ origBox: [0.5, 0.5, 0.1, 0.1] }, img, true), [400, 300, 80, 60]));
      A('D5b 整页路优先于裁图路（showOrig=true 时不看 box/boxNorm）',
        eq(LBFN.lbFocusPx({ origBox: [0.5, 0.5, 0.1, 0.1], box: [1, 2, 3, 4] }, img, true), [400, 300, 80, 60]));
      A('D6 形状不对的 box（长度≠4）不许当框用（旧代码会拿它去算 NaN）',
        LBFN.lbFocusPx({ box: [1, 2] }, img, false) === null);
    }

    /* ═════════ F · 行为级：pending.js → 灯箱的最后一厘米 ═════════
       shell 侧两条路再等价，只要 gItem 不把后端的 `boxNorm/imgW/imgH` 透传过去，归一化路就是死代码
       （本仓"声明了没人消费"的老毛病）。所以这里**切出 gItem 真驱动**，并在条目级断言两路等价。 */
    console.log('\n═══ F · pending.js gItem：后端附加字段真的进了灯箱 ═══');
    const PENDING = rd('src/app/js/views/pending.js');
    let GITEM = null, GITEM_ERR = '';
    const GITEM_SRC = sliceIn(PENDING, 'function gItem(p) {', 'function openLbAt(');
    const buildGItem = (src) => new Function('U', 'H', 'M', 'howto', src + '\nreturn gItem;')(
      { esc: (s) => (s == null ? '' : String(s)) },
      { asset: (r) => r },
      { cards: [], origOf: () => null, ASK_IC: {} },
      () => '提示');
    try { GITEM = buildGItem(GITEM_SRC); } catch (e) { GITEM_ERR = String((e && e.message) || e); }
    A('F0 gItem 能从 pending.js 切出来并驱动', !!GITEM, GITEM_ERR);
    if (GITEM) {
      const IMG = { naturalWidth: 800, naturalHeight: 600 };
      const PIX = [80, 60, 240, 120];
      /* 同一块区域的两种记录形状：
         · 旧记录（磁盘旧值不迁移）只有像素 box；
         · 新记录（W4 读取侧附加）只有 boxNorm + imgW/imgH。 */
      const REC_OLD = { id: 'T001', kind: '判错', askWho: '孩子', qRef: '第3题', evidence: '_待确认/ev/T001.jpg', question: '这题为什么错？', box: PIX };
      const REC_NEW = { id: 'T002', kind: '判错', askWho: '孩子', qRef: '第3题', evidence: '_待确认/ev/T002.jpg', question: '这题为什么错？', boxNorm: [0.1, 0.1, 0.3, 0.2], imgW: 800, imgH: 600 };
      const itOld = GITEM(REC_OLD), itNew = GITEM(REC_NEW);
      A('F1 `box` 语义一个字不改（旧记录像素框原样进灯箱）', eq(itOld.box, PIX));
      A('F2 三字段真透传（boxNorm / imgW / imgH）—— 不透传则归一化路永远是死代码',
        eq(itNew.boxNorm, [0.1, 0.1, 0.3, 0.2]) && itNew.imgW === 800 && itNew.imgH === 600,
        JSON.stringify({ boxNorm: itNew.boxNorm, imgW: itNew.imgW, imgH: itNew.imgH }));
      A('F3 字符串数字也认（Number() 容错，后端给 "800" 不算坏）',
        (() => { const it = GITEM(Object.assign({}, REC_NEW, { imgW: '800', imgH: '600' })); return it.imgW === 800 && it.imgH === 600; })());
      A('F4 有 boxNorm 但 imgW/imgH 不可用 ⇒ **上屏提示**按像素框显示（不许静默当 0）',
        (() => { const it = GITEM(Object.assign({}, REC_NEW, { imgW: null, imgH: null })); return it.imgW === 0 && /坐标字段不全/.test(it.chips); })());
      A('F5 旧记录（没有 boxNorm）⇒ 不提示、imgW=0 回落像素框（不误报）',
        itOld.boxNorm === null && itOld.imgW === 0 && !/坐标字段不全/.test(itOld.chips));
      /* W4 形状的第二半：量不出尺寸时给的是 `boxNormWhy`（具体原因），**不写 0**。
         这个原因字段必须有人读——"声明了没人消费"是本仓老毛病（L-441/L-716）。 */
      A('F5b 有框但量不出尺寸（后端给 boxNormWhy）⇒ 徽章说出"按像素显示"且原因挂在 title 上',
        (() => {
          const it = GITEM(Object.assign({}, REC_OLD, { boxNormWhy: '图尺寸读不出：九年级/物理/原卷/整页.jpg' }));
          return it.boxNorm === null && it.imgW === 0 && /按像素显示/.test(it.chips) && /图尺寸读不出/.test(it.chips);
        })());
      A('F5c 本来就没有框的记录 ⇒ 不拿 boxNormWhy 制造噪音',
        !/按像素显示/.test(GITEM({ id: 'T004', evidence: 'e.jpg', boxNormWhy: '没有像素框' }).chips));
      A('F6 条目级两路等价：同区域的新旧两种记录经灯箱取框**逐值相等**（且等于像素框）',
        !!LBFN && eq(LBFN.lbFocusPx(itOld, IMG, false), LBFN.lbFocusPx(itNew, IMG, false)) &&
        eq(LBFN.lbFocusPx(itNew, IMG, false), PIX),
        JSON.stringify({ old: LBFN ? LBFN.lbFocusPx(itOld, IMG, false) : null, new: LBFN ? LBFN.lbFocusPx(itNew, IMG, false) : null }));
    }

    /* ═════════ G · 集成：真跑 `_配方.mjs 清单 --json --packs <包根>` ═════════
       上面 C 段驱动的是我编的包对象；这一段把**工具真吐出来的 JSON** 喂进 pages 层，
       证明我消费的是契约里那个形状（字段名、绝对路径、`.停用` 语义都以实测为准）。 */
    console.log('\n═══ G · 集成：真跑清单，消费真形状 ═══');
    const PACKS_ROOT = path.join(ROOT, 'src', 'packs');
    const PK_TOOL = path.join(ROOT, 'src', 'tools', '_配方.mjs');
    const PK_ENGINE = path.join(ROOT, 'src', 'tools', '_经验包.mjs');
    if (!fs.existsSync(PACKS_ROOT) || !fs.existsSync(PK_ENGINE)) {
      A('G0 集成前提：样本包根与 _经验包.mjs 在场（缺则本段 SKIP，显式打印原因，不静默通过）',
        false, 'SKIP：缺 ' + (fs.existsSync(PACKS_ROOT) ? PK_ENGINE : PACKS_ROOT));
    } else {
      const runList = (root) => {
        const r = spawnSync(process.execPath, [PK_TOOL, '清单', '--json', '--packs', root], { encoding: 'utf8', maxBuffer: 64e6 });
        let j = null; try { j = JSON.parse(String(r.stdout || '')); } catch (e) { /* 下面逐条判 */ }
        return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), j };
      };
      const r1 = runList(PACKS_ROOT);
      A('G1 `清单 --json --packs <样本包根>` exit 0', r1.code === 0, 'exit=' + r1.code + ' ' + r1.err.slice(0, 120));
      A('G2 顶层真有 packs 数组（前端消费的就是这个字段）', !!r1.j && Array.isArray(r1.j.packs),
        r1.j ? Object.keys(r1.j).join(',') : 'JSON 解析失败');
      const p0 = (r1.j && r1.j.packs && r1.j.packs[0]) || null;
      A('G3 每包形状含 id/version/dir/enabled/verdict/title/author/license（契约 §2.2 逐字段）',
        !!p0 && ['id', 'version', 'dir', 'enabled', 'verdict', 'title', 'author', 'license'].every(k => k in p0),
        p0 ? Object.keys(p0).join(',') : 'none');
      const real = mkPacks(() => ({ ok: true, code: 0, out: r1.out, err: '' }));
      await real.V.load(true); real.V.render({}); await tick();
      const hReal = real.html('pkBox');
      A('G4 把**真输出**喂进 packs.js：列出真包的 id/版本/启用/校验结论',
        !!p0 && hReal.indexOf(p0.id) >= 0 && hReal.indexOf('版本 ' + p0.version) >= 0 && /校验结论：通过/.test(hReal),
        hReal.slice(0, 120));
      A('G5 真 dir 是绝对路径 ⇒ 界面上看不到盘符/仓库名（脱敏实测，不是合成样本）',
        !/[A-Za-z]:[\\/]/.test(hReal) && !/GlimmerNotedev/.test(hReal), hReal.slice(0, 160));

      /* 「怎么停」的机制实测：临时包根里放 `.停用` ⇒ 工具报 enabled=false ⇒ 页面显示「已停用」。 */
      const TMPROOT = E.allocTempDir('gn-w3-packs-');
      fs.cpSync(path.join(PACKS_ROOT, 'family-a'), path.join(TMPROOT, 'family-a'), { recursive: true });
      /* ⚠ 版本目录名**从样本里读最高那个**（pack.json 在 `<packId>/<version>/` 里），不许写死：
         写死 `1.0.0` 会在包升版时 `ENOENT` 崩在夹具准备阶段（本轮实测撞上，整轮 quick 因此红）。
         夹具崩掉与断言失败要分得开 —— 所以这里先断言"目录真的存在"，再往里放标记。 */
      const pilotRoot = path.join(PACKS_ROOT, 'family-a', 'shared-stem');
      const pilotVer = fs.readdirSync(pilotRoot)
        .filter((d) => /^\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(pilotRoot, d, 'pack.json')))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
      const pilotDir = path.join(TMPROOT, 'family-a', 'shared-stem', String(pilotVer));
      A('G6 前置：临时包根里的版本目录与 pack.json 的 version 对得上（夹具没配好要看得见）',
        fs.existsSync(pilotDir), pilotDir);
      fs.writeFileSync(path.join(pilotDir, '.停用'), '本用例临时停用\n', 'utf8');
      const r2 = runList(TMPROOT);
      const q0 = (r2.j && r2.j.packs && r2.j.packs[0]) || null;
      A('G6 `.停用` 文件 ⇒ 工具报 enabled=false（README/页面写的"怎么停"就是这个机制）',
        !!q0 && q0.enabled === false, q0 ? JSON.stringify({ enabled: q0.enabled, id: q0.id }) : 'none');
      const off = mkPacks(() => ({ ok: true, code: 0, out: r2.out, err: '' }));
      await off.V.load(true); off.V.render({}); await tick();
      A('G7 界面据此显示「已停用」+ 恢复办法（删掉 `.停用`）',
        /已停用/.test(off.html('pkBox')) && /\.停用/.test(off.html('pkBox')));
    }
    /* ═════════ E · 阴性对照（变异自证，当场执行） ═════════ */
    console.log('\n═══ E · 阴性对照：掏掉防线必须变红 ═══');
    const MUT_CARD = CARD_SRC.replace('if (!p.enabled) {', 'if (false) {');
    A('E0 变异体确实被改动（否则下面的"阴性对照"是假动作）', MUT_CARD !== CARD_SRC);
    const p3m = mkPage({ src: MUT_CARD + GEN_SRC, packs: [PACK_A, PACK_B], st: { typed: { 'family-b/other': 'x' } } });
    await p3m.fns.onGenerate();
    const f3m = (p3m.calls.recipe[0] || {}).flags || {};
    A('E1 阴性对照·B3：把 `if (!p.enabled)` 掏成恒假 ⇒ 停用包的卡照样被发出去（B3 判据确实能红）',
      p3m.calls.recipe.length === 1 && String(f3m.cards || '').indexOf('family-b/other/x@2.1.0') >= 0,
      'recipe=' + p3m.calls.recipe.length + ' cards=' + JSON.stringify(f3m.cards));

    const MUT_PACKS = PACKS.replace('cache = { ok: false, packs: [], error: String((e && e.message) || e) };',
      'cache = { ok: true, packs: [], error: null };');
    A('E2 变异体确实被改动', MUT_PACKS !== PACKS);
    const c2m = (() => {
      const els = {};
      const CTB = {
        util: { esc: (s) => (s == null ? '' : String(s)), $id: (id) => (els[id] || (els[id] = { innerHTML: '', onclick: null })) },
        host: { recipe: async () => ({ ok: false, code: 1, out: '', err: '壳通道挂了' }) },
        shell: { toast: () => { }, refreshSub: () => { } },
        views: {},
      };
      new Function('CTB', MUT_PACKS)(CTB);
      return { V: CTB.views.packs, html: (id) => ((els[id] || {}).innerHTML || '') };
    })();
    await c2m.V.load(true); c2m.V.render({}); await tick();
    A('E3 阴性对照·C2：把失败分支改成"成功且空" ⇒ 界面当场退化成"没有安装任何经验包"（C2 判据确实能红）',
      /没有安装任何经验包/.test(c2m.html('pkBox')) && !/读不到经验包清单/.test(c2m.html('pkBox')));

    if (LBFN) {
      const MUT_LB = LB_SRC.replace('return [b[0] * w, b[1] * h, b[2] * w, b[3] * h];', 'return null;');
      A('E4 变异体确实被改动', MUT_LB !== LB_SRC);
      const mut = new Function(MUT_LB + '\nreturn { lbFocusPx };')();
      A('E5 阴性对照·D2：掏掉归一化换算 ⇒ boxNorm 路失效（D2 判据确实能红）',
        !eq(mut.lbFocusPx({ boxNorm: [0.1, 0.1, 0.3, 0.2], imgW: 800, imgH: 600 }, { naturalWidth: 800, naturalHeight: 600 }, false), [80, 60, 240, 120]));
    }
    /* 阴性对照②（Lead 裁定要求）：掏掉 pending.js 的三字段透传 ⇒ 条目级"两路等价"必须变红。
       只有这样才能证明 F6 不是"缺字段回落"在自我证明 —— 新记录（只有 boxNorm）会拿不到框。 */
    if (GITEM && LBFN) {
      const MUT_GITEM = GITEM_SRC.replace(/^[ \t]*boxNorm: bNorm, imgW: bNormOk \? bwN : 0, imgH: bNormOk \? bhN : 0,[ \t]*\r?\n/m, '');
      A('E6 变异体确实被改动（掏掉了三字段透传那一行）', MUT_GITEM !== GITEM_SRC);
      const mutItem = buildGItem(MUT_GITEM)({ id: 'T003', evidence: '_待确认/ev/T003.jpg', boxNorm: [0.1, 0.1, 0.3, 0.2], imgW: 800, imgH: 600 });
      A('E7 阴性对照·F6：掏掉三字段透传 ⇒ 只有 boxNorm 的新记录在灯箱里**没有框**（F6 判据确实能红）',
        mutItem.boxNorm == null && !(mutItem.imgW > 0) && LBFN.lbFocusPx(mutItem, { naturalWidth: 800, naturalHeight: 600 }, false) === null,
        JSON.stringify({ boxNorm: mutItem.boxNorm, imgW: mutItem.imgW, focus: LBFN.lbFocusPx(mutItem, { naturalWidth: 800, naturalHeight: 600 }, false) }));
    }
  }

  console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + total + ' 失败=' + fails);
  process.exit(fails ? 1 : 0);
})();
