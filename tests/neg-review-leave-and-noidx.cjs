#!/usr/bin/env node
/**
 * neg-review-leave-and-noidx.cjs —— 复习流两处"静默丢数据 / 一点就崩"的护栏
 * （2026-10-31 建，外部 codex 审查 D02 + D04 的护栏）
 *
 * D02 未落库判分被"再来一场"清空：
 *   结算屏上「丢弃不写」有确认框，而「再来一场」/「重选范围」/「只练这几题」三个入口
 *   直接 `M.session = null` ⇒ 判分（含"已建批、待补批改"的 committed）当场消失且不可恢复。
 *   实测修前：sessionPendingCount 1 → 点 rvMore → 0，全程无确认。
 *   判据：有未写回台账的判定时，点这些入口**不得**清空 session（除非确认返回 true）。
 *
 * D04 没有原卷截图的合法题卡打不开复习界面：
 *   模板 `c.img ? '<button id="rvImg">' : ''`，绑定却无条件 `U.$id('rvImg').onclick` ⇒
 *   TypeError ⇒ S.render 的 try/catch 把整屏换成"视图渲染出错"，且异常发生在判分按钮绑定之前。
 *   判据：`img:null` 的卡能渲染完、且判分按钮绑得上。
 *
 * ⚠ 本用例是**纯内存 DOM 桩**（不起浏览器/服务端）：只验"函数有没有抛、按钮有没有绑上"，
 *   不验像素。按钮"渲染出来没有"按模板字符串判（`id="rvImg"` 是否出现在 innerHTML 里），
 *   不能用 `U.$id` 是否返回节点判 —— $id 是按需创建的，永远返回节点（第一版踩到）。
 * ⚠ leaveSession 是 async：不 await 就点完读计数会读到旧值（第一版踩到），故整体包在 async IIFE 里。
 *
 * 用法：node tests\neg-review-leave-and-noidx.cjs
 * 退出码：0=PASS / 1=FAIL
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + String(detail).slice(0, 200) : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + String(detail).slice(0, 200) : '')); }
}
const read = f => fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8');

function makeEnv(overrides) {
  const ov = overrides || {};
  const CTB = {};
  const nodes = {};
  let gradeBound = 0;
  const ctx = {
    CTB, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  ctx.addEventListener = () => { };
  ctx.removeEventListener = () => { };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.CTB = CTB;
  ctx.document = {
    addEventListener() { }, removeEventListener() { },
    documentElement: {}, body: {},
    createElement: () => ({ style: {}, addEventListener() { }, appendChild() { } }),
  };
  vm.createContext(ctx);
  const load = (f, src) => vm.runInContext(src || ov[f] || read(f), ctx, { filename: f });
  for (const f of ['util.js', 'host.js', 'model.js', 'shell.js']) load(f);
  CTB.views = CTB.views || {};
  load('views/review.js');

  const { util: U, host: H, model: M, shell: S } = CTB;
  U.$id = id => (nodes[id] = nodes[id] || { id, onclick: null, dataset: {}, style: {}, value: '', addEventListener() { } });
  const el = {
    _html: '',
    set innerHTML(h) {
      this._html = String(h);
      for (const k of Object.keys(nodes)) delete nodes[k];
      for (const m of this._html.matchAll(/\bid="([^"]+)"/g)) nodes[m[1]] = { id: m[1], onclick: null, dataset: {}, style: {}, value: '', addEventListener() { } };
    },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) {
      if (sel === '[data-grade]') return [{ dataset: { grade: '对' }, set onclick(v) { gradeBound++; } }];
      if (sel === '#rvRedoSkipped') return nodes.rvRedoSkipped ? [nodes.rvRedoSkipped] : [];
      return [];
    },
    querySelector: () => null,
  };
  /* S.render 必须真的重绘：视图内部的"翻开/换屏"都靠它（第一版设成空函数 ⇒
     点「翻开」永远看不到判分按钮，判据假红）。加 re-entrancy 旗防递归。 */
  let rendering = false;
  S.render = () => {
    if (rendering) return;
    rendering = true;
    try { CTB.views.review.render(el); } catch (e) { rendering = false; throw e; }
    rendering = false;
  };
  S.toast = () => { };
  let confirmAnswer = true, confirmCalls = 0;
  S.confirm = async () => { confirmCalls++; return confirmAnswer; };
  H.mode = 'shell';
  return {
    CTB, U, H, M, S, el, nodes,
    rendered: id => new RegExp('\\bid="' + id + '"').test(el.innerHTML || ''),
    grades: () => gradeBound,
    setConfirm: v => { confirmAnswer = v; }, confirmCount: () => confirmCalls,
  };
}

function stateWith(img, id) {
  return {
    data: [{ name: '测试生', subjects: [{ name: '数学', items: [{
      id, status: '在册', question: '1+1', stemHtml: '<p>1+1</p>', img,
      reviewStatus: '未复习', reviewCount: 0, passStreak: 0,
    }] }] }],
    admit: {}, blindFresh: {}, figState: {},
  };
}
/** 把本场推到结算屏（idx 越过队尾） */
function toDone(env) {
  const s = env.M.session;
  s.idx = s.queue.length;
  env.CTB.views.review.render(env.el);
}
/** 点一个可能是 async 的 onclick 并等它落地 */
async function clickAsync(node) {
  if (!node) throw new Error('按钮不存在（模板没渲染出来）');
  const r = node.onclick();
  if (r && typeof r.then === 'function') await r;
  await new Promise(r2 => setImmediate(r2));
}

(async () => {
  /* ══════════ D04 ══════════ */
  console.log('== D04 没有 原卷截图.jpg 的合法题卡（img:null）==');
  {
    const env = makeEnv();
    env.M.applyState(stateWith(null, 'M0001'));
    env.M.startSession([env.M.cards[0]]);
    let err = null;
    try { env.CTB.views.review.render(env.el); } catch (e) { err = e; }
    A('★ 渲染不抛异常（修前：Cannot set properties of null → 整屏"视图渲染出错"）', !err,
      err ? err.message : '无异常');
    A('★ 紧随其后绑定的「翻答案」按钮绑上了（修前 rvImg 抛错会把它一起跳过）',
      !!(env.nodes.rvReveal && env.nodes.rvReveal.onclick), 'rvReveal 绑定=' + !!(env.nodes.rvReveal && env.nodes.rvReveal.onclick));
    /* 走一遍"我答完了 → 翻开"：判分按钮必须真的能绑上（这才是用户能不能判分） */
    if (env.nodes.rvReveal && env.nodes.rvReveal.onclick) {
      env.nodes.rvReveal.onclick();
      A('翻开后判分按钮绑上了（data-grade 有绑定）', env.grades() > 0, 'data-grade 绑定 ' + env.grades() + ' 个');
    } else A('翻开后判分按钮绑上了（data-grade 有绑定）', false, 'rvReveal 未绑定，无法翻开');
    A('页面不是"视图渲染出错"', !/视图渲染出错/.test(env.el.innerHTML || ''), (env.el.innerHTML || '').slice(0, 30));
    A('没有原卷截图时模板不渲染 rvImg 按钮', !env.rendered('rvImg'), 'rvImg 渲染=' + env.rendered('rvImg'));
  }
  {
    const env = makeEnv();
    env.M.applyState(stateWith('九年级/数学/M0001-某题/原卷截图.jpg', 'M0001'));
    env.M.startSession([env.M.cards[0]]);
    let err = null;
    try { env.CTB.views.review.render(env.el); } catch (e) { err = e; }
    A('有原卷截图时 rvImg 照常渲染且绑上 onclick',
      !err && env.rendered('rvImg') && !!(env.nodes.rvImg && env.nodes.rvImg.onclick),
      err ? err.message : ('渲染=' + env.rendered('rvImg') + ' 绑定=' + !!(env.nodes.rvImg && env.nodes.rvImg.onclick)));
  }

  /* ══════════ D02 ══════════ */
  console.log('\n== D02 结算屏"离开本场"入口 ==');
  {
    const env = makeEnv();
    env.M.applyState(stateWith(null, 'M0001'));
    env.M.startSession([env.M.cards[0]]);
    env.M.sessionGrade('对');
    toDone(env);
    A('前置：确实有未写回台账的判定', env.M.sessionPendingCount() > 0, 'pending=' + env.M.sessionPendingCount());
    env.setConfirm(false);                       // 用户在确认框里点"取消"
    const before = env.M.sessionPendingCount();
    await clickAsync(env.nodes.rvMore);
    A('★ 点「再来一场」+ 选取消 ⇒ 判分仍在（修前会被清空）',
      env.M.sessionPendingCount() === before, 'before=' + before + ' after=' + env.M.sessionPendingCount());
    A('★ 而且确实弹了确认（不是悄悄放行）', env.confirmCount() >= 1, 'confirm ' + env.confirmCount() + ' 次');
  }
  {
    const env = makeEnv();
    env.M.applyState(stateWith(null, 'M0001'));
    env.M.startSession([env.M.cards[0]]);
    env.M.sessionGrade('对');
    toDone(env);
    env.setConfirm(true);                        // 用户明确选"仍然丢弃"
    await clickAsync(env.nodes.rvMore);
    A('用户明确选"仍然丢弃" ⇒ 允许清空（不能改成一概不让走）',
      env.M.sessionPendingCount() === 0, 'pending=' + env.M.sessionPendingCount());
  }
  {
    const env = makeEnv();
    env.M.applyState(stateWith(null, 'M0001'));
    env.M.startSession([env.M.cards[0]]);        // 一题没判，直接到结算屏
    toDone(env);
    A('前置：本场无待落库判定', env.M.sessionPendingCount() === 0, 'pending=0');
    const c0 = env.confirmCount();
    await clickAsync(env.nodes.rvMore);
    A('没有待落库判定时不弹确认（不制造无意义打断）', env.confirmCount() === c0, '多弹 ' + (env.confirmCount() - c0) + ' 次');
  }

  /* ══════════ 阴性自证 ══════════ */
  console.log('\n== 阴性自证：摘掉 D02 守卫 ==');
  {
    const src = read('views/review.js');
    const broken = src.replace(
      /    const leaveSession = async \(next\) => \{[\s\S]*?\n    \};\n/,
      "    const leaveSession = async (next) => { M.session = null; if (typeof next === 'function') next(); S.render(); };\n");
    A('阴性自证 · 判据能被"摘掉确认守卫"打红（掏得动）', broken !== src,
      broken === src ? '替换点没匹配到 —— 用例与实现脱钩，必须修用例' : '已构造坏版本');
    if (broken !== src) {
      const env = makeEnv({ 'views/review.js': broken });
      env.M.applyState(stateWith(null, 'M0001'));
      env.M.startSession([env.M.cards[0]]);
      env.M.sessionGrade('对');
      toDone(env);
      const before = env.M.sessionPendingCount();
      env.setConfirm(false);
      await clickAsync(env.nodes.rvMore);
      A('阴性自证 · 坏版本下判分被清空（= 主判据会红）',
        before > 0 && env.M.sessionPendingCount() === 0,
        'before=' + before + ' after=' + env.M.sessionPendingCount());
    }
  }

  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => { console.error('✖ 用例自身异常：' + (e && e.stack || e)); process.exit(1); });
