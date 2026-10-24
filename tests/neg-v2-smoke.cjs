/* v2 纯函数冒烟：在 Node 里装载**真实的** v2/js（util→host→model），对派生函数喂边界数据。
   用途：CDP 9223 不可用时替代真壳 e2e 的「纯函数级」回归。
   用法：node tests/neg-v2-smoke.cjs

   ★ 2026-10-12 关键修复：本文件原先只 `console.log('[FAIL] …')`，**从不 process.exit** ——
     也就是说它红了门禁也不会红（"断言不传递"，看起来在测、实质是打印）。
     现在所有断言统一走 `T()`，按计数决定退出码；已挂进 tests\run.mjs 的 unitTests 链。
     这也是"纯函数级回归"从 0 变成 13 条断言的关键一步。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

/* 断言器：打印 + 计数（退出码由末尾统一决定） */
let _pass = 0, _fail = 0;
const T = (name, cond, detail) => {
  if (cond) { _pass++; console.log('  [OK]  ' + name); }
  else { _fail++; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')); }
};
/* 收尾：打印汇总并决定退出码 */
function finish() {
  console.log('\nRESULT=' + (_fail === 0 ? 'PASS' : 'FAIL') + ' 断言=' + (_pass + _fail) + (_fail ? ' 失败=' + _fail : ''));
  process.exit(_fail === 0 ? 0 : 1);
}

function loadV2() {
  const ctx = { console };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['util.js', 'host.js', 'model.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8'), ctx, { filename: f });
  }
  return ctx.CTB;
}

const CTB = loadV2();
const U = CTB.util, M = CTB.model, H = CTB.host;

/* ---- F-57：相对 src 必须解析到卡片目录 ---- */
const card = {
  id: 'P0017', question: '滑轮组机械效率',
  md: '%E4%B9%9D%E5%B9%B4%E7%BA%A7/%E7%89%A9%E7%90%86/P0017-%E9%94%99%E8%AF%AF%E6%95%B0%E6%8D%AE%E7%AD%94%E6%88%90%E5%AE%9E%E9%AA%8C%E5%BA%8F%E5%8F%B7/%E9%94%99%E9%A2%98%E8%AE%B0%E5%BD%95.md',
  stemHtml: '<div class="stem"><p>如图</p><div class="stem-figure"><img src="题图.jpg" alt="题图" style="max-width:820px" onerror="alert(1)"></div>' +
    '<script>window.__x=1</script><svg viewBox="0 0 10 10"><path d="M0 0 L1 1" fill="none" stroke="#333"/></svg></div>',
};
const dir = M.cardDirOf(card);
const html = M.stemHtmlSafe(card);
console.log('[F-57] cardDirOf = ' + dir);
console.log('[F-57] 渲染结果:\n' + html);
const checks = [
  ['相对 src 已解析到卡片目录', html.indexOf('P0017-%E9%94%99%E8%AF%AF%E6%95%B0%E6%8D%AE%E7%AD%94%E6%88%90%E5%AE%9E%E9%AA%8C%E5%BA%8F%E5%8F%B7/%E9%A2%98%E5%9B%BE.jpg') >= 0],
  ['不再有裸的 src="题图.jpg"', html.indexOf('src="题图.jpg"') < 0],
  ['on* 事件属性被剔除', !/\son[a-z]+\s*=/i.test(html)],
  ['script 连内容一起剔除', html.indexOf('__x') < 0 && html.indexOf('<script') < 0],
  ['style 布局保留', html.indexOf('max-width:820px') >= 0],
  ['svg/path 保留', html.indexOf('<svg') >= 0 && html.indexOf('<path') >= 0],
  ['viewBox 大小写归一为 HTML 解析器可修正形态', html.indexOf('viewbox="0 0 10 10"') >= 0],
];
for (const [n, ok] of checks) T(n, ok);

/* ---- F-58：fig 兜底 ---- */
const c2 = { id: 'C0003', fig: '%E4%B9%9D%E5%B9%B4%E7%BA%A7/%E5%8C%96%E5%AD%A6/C0003-%E5%88%B6%E6%B0%A7%E8%A3%85%E7%BD%AE%E9%80%89%E9%94%99/%E9%A2%98%E5%9B%BE.jpg', stemHtml: '<p>制氧装置</p>', question: 'x' };
const h2 = M.stemHtmlSafe(c2);
console.log('[F-58] fig 兜底片段 = ' + h2.slice(-160));
T('[F-58] 有 fig 无内联图 → 补出题图', h2.indexOf('C0003') >= 0 && h2.indexOf('<img') >= 0, h2.slice(-80));
const c3 = { id: 'X', fig: 'a/题图.jpg', stemHtml: '<img src="题图.jpg">', md: 'a/错题记录.md' };
const h3 = M.stemHtmlSafe(c3);
T('[F-58] 已有内联图 → 不重复补', (h3.match(/<img/g) || []).length === 1, h3.slice(-80));

/* ---- F-39 ---- */
console.log('[F-39] healthOf(缺 admit 分区).bad = ' + JSON.stringify(M.healthOf({ dataHealth: { blindFresh: 'ok' }, blindFresh: {}, figState: {} }).bad));
T('[F-39] 运行时缺分区算降级', M.healthOf({ dataHealth: {}, blindFresh: {}, figState: {} }).ok === false);

/* ---- F-09 ---- */
const bad = ['未通过', '不通过', '已通过但存疑', '不一致', '待双路', '', null, '未盲解'];
const allBlocked = bad.every(s => M.blindCls({ blindStatus: s }).ok !== true);
const okTwo = M.blindCls({ blindStatus: '已通过' }).ok === true && M.blindCls({ blindStatus: '已修正' }).ok === true;
T('[F-09] 只认 已通过/已修正，未知态 null', allBlocked && okTwo && M.blindCls({}).ok === null,
  '未知态实际=' + JSON.stringify(M.blindCls({}).ok));
console.log('  [F-09] 未知态返回值 = ' + JSON.stringify(M.blindCls({}).ok) + '（须为 null）');

/* ---- F-11 ---- */
const d = [null, '', '2026/10/11', '2026-13-45', 20261011, {}];
let noNaN = true;
for (const v of d) { const r = M.dueInfo({ nextDue: v }); if (r.overdue !== null && !Number.isFinite(r.overdue)) noNaN = false; }
T('[F-11] dueInfo 对非法日期不产 NaN 不抛', noNaN);

/* ---- F-33 ---- */
const oc = M.pkgOutcome([{ id: 'T001', status: 'ok' }, { id: 'T002', status: 'missing' }, { id: 'T003', status: 'skipped' }], ['T001', 'T002', 'T003', 'T004']);
const keepIds = oc.keep.map(x => x.id).join(',');
T('[F-33] 只清 ok 条目，其余保留', oc.del.join(',') === 'T001' && keepIds === 'T002,T003,T004', JSON.stringify(oc));

/* ---- F-20：批改失败重试不得重复组卷（假 host.mark 计数） ---- */
(async () => {
  let calls = [];
  CTB.host.mark = async (action, flags) => {
    calls.push(action + ':' + (flags.paper || flags.ids));
    if (action === '组卷') return { code: 0, out: '已建批次 P20261011-01' };
    return { code: 1, err: '批改门禁拦下 P0017' };            // 第一次批改失败
  };
  const mk = id => ({ key: '学生A|数学|' + id, kid: '学生A', subject: '数学', card: { id: id } });
  M.startSession([mk('M0001'), mk('M0002')]);
  M.sessionGrade('对'); M.sessionGrade('错');
  let err1 = '';
  try { await M.endSession(); } catch (e) { err1 = e.message.slice(0, 60); }
  const after1 = calls.filter(x => x.startsWith('组卷')).length;
  const resultsAfter = Object.keys(M.session.results).length;
  const committed = Object.keys(M.session.committed).length;
  calls = [];
  CTB.host.mark = async (action, flags) => { calls.push(action + ':' + (flags.paper || '')); return action === '组卷' ? { code: 0, out: 'P20261011-02' } : { code: 0, out: 'ok' }; };
  const done = await M.endSession();
  const again = calls.filter(x => x.startsWith('组卷')).length;
  console.log('  [F-20] ' + JSON.stringify({ err1, after1, resultsAfter, committed, again }));
  T('[F-20] 组卷成功后摘出判定，重试只补批改',
    after1 === 1 && resultsAfter === 0 && committed === 1 && again === 0,
    `after1=${after1} results残留=${resultsAfter} committed=${committed} 重试组卷=${again}`);
  finish();          // ★ 汇总并决定退出码（原先完全没有这一步 ⇒ 红了也不红）
})();
