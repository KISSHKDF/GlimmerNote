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
/* ★ 2026-10-25：F-60 要拿**真实状态包**跑真 model.js，所以借测试环境底座取库根
   （默认真库只读；CTB_TEST_LIB 可覆盖；找不到库会响亮失败，绝不静默指向空目录）。 */
const E = require('./_测试环境.cjs');

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

/* ---- F-60（2026-10-25，用户三次报障）：canGroup 吃"包装对象"必须与吃裸卡同判 ----
   现场：题库浏览「用筛选结果开复习会」传的是 filtered() 的包装对象 {key,kid,subject,card}，
   而 canGroup 判据读 c.status ⇒ 包装对象上恒 undefined ⇒ inBook 恒 false ⇒ **全库 419 题
   一律被判"没过准入"**；界面把这条类型错误说成"盲解未过/答案来源没核实"，用户核对了三轮数据。
   修法：M.cardOf() 统一收卡 + 形状错就抛（不再静默 false）+ 两个调用点显式传 .card。
   断言用**真实状态包**跑真 model.js：旧代码在这里必然全 false。 */
{
  const stPath = path.join(E.LIB, '_状态.json');
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stPath, 'utf8').replace(/^\uFEFF/, '')); } catch { }
  if (!st || !Array.isArray(st.data)) {
    T('[F-60] 前置：能读到真实状态包（判据不是空真）', false, '读不到 ' + stPath);
  } else {
    M.applyState(st);
    const wrappers = M.cardsOf();
    const cards = wrappers.map(x => x.card);
    const wOk = wrappers.filter(x => M.canGroup(x)).length;          // 包装对象（旧调用点的形状）
    const cOk = cards.filter(c => M.canGroup(c)).length;             // 裸卡（正确形状）
    const expect = cards.filter(c => M.inBook(c) && !M.mastered(c) &&
      ((M.admitOf(c) || {}).ok === true || (!M.admitOf(c) && M.blindOk(c)))).length;
    T('[F-60] ★ 传包装对象与传裸卡判定一致（旧代码：包装对象恒 0）',
      wOk === cOk && cOk === expect,
      '包装=' + wOk + ' 裸卡=' + cOk + ' 期望=' + expect + ' 共' + cards.length);
    T('[F-60] ★ 真实库里确实有可通过准入的题（否则"一致"是 0==0 的空真）', cOk > 0,
      '可通过=' + cOk);
    /* cardOf 是唯一收卡实现：两种形状都必须解出同一个对象 */
    T('[F-60] cardOf 解包装对象 = 解裸卡（同一对象引用）',
      M.cardOf(wrappers[0]) === wrappers[0].card && M.cardOf(cards[0]) === cards[0]);
    /* ★ 不变量（2026-10-25 硬化）：**所有**吃裸卡的判据都必须对两种形状同判。
       只修 canGroup 是不够的 —— 形状审计矩阵实测：blindCls/blindOk/blindFreshOf/admitOf/
       inBook/dueInfo/cardDirOf/stemHtmlSafe/origOf 都会在收到包装对象时**静默降级**
       （blindCls→ok:null、dueInfo 把"今日到期"说成"未复习"、cardDirOf→''、stemHtmlSafe→''），
       每一条都能单独造出"界面说没题/没图/没题面"的假象。这里逐条锁死。 */
    const SHAPE_FNS = ['canGroup', 'blindCls', 'blindOk', 'blindFreshOf', 'admitOf', 'admitWhy',
      'mastered', 'inBook', 'dueInfo', 'cardDirOf', 'stemHtmlSafe', 'origOf'];
    const shapeBad = [];
    for (const fn of SHAPE_FNS) {
      if (typeof M[fn] !== 'function') { shapeBad.push(fn + '(不存在)'); continue; }
      for (const x of wrappers) {
        let a, b, ea = null, eb = null;
        try { a = JSON.stringify(M[fn](x.card)); } catch (e) { ea = e.message.slice(0, 30); }
        try { b = JSON.stringify(M[fn](x)); } catch (e) { eb = e.message.slice(0, 30); }
        if (ea || eb || a !== b) { shapeBad.push(fn + '@' + x.card.id + (ea ? '卡抛:' + ea : '') + (eb ? '包抛:' + eb : '') + ' 卡=' + String(a).slice(0, 24) + ' 包=' + String(b).slice(0, 24)); break; }
      }
    }
    T('[F-60] ★ 全部 ' + SHAPE_FNS.length + ' 个判据：传包装对象 === 传裸卡（逐卡逐函数，' +
      cards.length + ' 卡）', shapeBad.length === 0, shapeBad.slice(0, 4).join(' | '));
    /* 错误形状必须响亮失败，绝不静默 false */
    let threw = false;
    try { M.canGroup({ nothing: 1 }); } catch { threw = true; }
    T('[F-60] 形状错必须抛错（静默 false 正是本 bug 活了这么久的根因）', threw);
  }
}

/* ---- F-61：静态扫描 —— 禁止把包装对象直接喂给只吃裸卡的判据 ----
   运行时断言只能证明"当前形参没错"，但下一个新调用点还会重犯（本库已犯 2 次）。
   这里把"哪些函数只吃裸卡"变成机检约束：`.filter(M.canGroup)` / `filter(M.blindCls)` 之类
   直接传函数引用（= 把整个条目原样传入）一律判红。 */
{
  const viewsDir = path.join(ROOT, 'src', 'app', 'js');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p);
    }
  })(viewsDir);
  /* 只吃裸卡的判据（model.js 里以 c=>c.status 之类直接读卡字段的那些） */
  const CARD_ONLY = ['canGroup', 'blindCls', 'blindOk', 'admitOf', 'admitWhy', 'dueInfo', 'mastered', 'inBook'];
  const offenders = [];
  /* 只扫**真代码**：先剥块注释与行注释。
     为什么必须剥：修好后我在注释里写明了旧写法 `.filter(M.canGroup)`,若连注释一起扫，
     判据会把"记录事故的说明文字"当成事故本身 ⇒ 假阳 ⇒ 下次真红也没人信（L-175 同类）。 */
  const stripComments = s => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\/])\/\/[^\n]*/g, '$1');
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const fn of CARD_ONLY) {
      /* 形态1：.filter(M.fn) / .some(M.fn) —— 把条目原样当裸卡传 */
      const re = new RegExp('\\.(filter|some|every|find|map)\\s*\\(\\s*M\\.' + fn + '\\s*\\)', 'g');
      let m;
      while ((m = re.exec(src))) offenders.push(path.basename(f) + ': ' + m[0]);
    }
  }
  T('[F-61] ★ 全仓不得出现 `.filter(M.canGroup)` 这类"整条目当裸卡"的写法',
    offenders.length === 0, offenders.join(' | '));
  /* 形态2：`M.cardOf(` 必须是 model.js 里**唯一**的拆包实现。
     否则下一个判据又会各写一份 `x.card || x` 的猜测逻辑（漂移起点）。 */
  const modelSrc = stripComments(fs.readFileSync(path.join(viewsDir, 'model.js'), 'utf8'));
  const cardOfDefs = (modelSrc.match(/M\.cardOf\s*=\s*function/g) || []).length;
  T('[F-61] ★ 拆包实现只有一处（M.cardOf 定义恰好 1 次）', cardOfDefs === 1, '实测 ' + cardOfDefs + ' 次');
  T('[F-61] ★ 所有吃裸卡的判据都过 cardOf（抽查 canGroup/blindCls/admitOf/inBook/dueInfo）',
    ['canGroup', 'blindCls', 'admitOf', 'inBook', 'dueInfo'].every(fn => {
      const i = modelSrc.indexOf('M.' + fn + ' = ');
      if (i < 0) return false;
      const seg = modelSrc.slice(i, i + 700);
      return /M\.cardOf\(/.test(seg);
    }));
  /* 阴性自证：把旧写法造出来，上面的判据必须能抓到 */
  const probe = 'x.filter(M.canGroup)';
  T('[F-61] 自证 · 旧写法会被抓到（判据不是恒真）',
    new RegExp('\\.(filter|some|every|find|map)\\s*\\(\\s*M\\.canGroup\\s*\\)').test(probe));
}

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
