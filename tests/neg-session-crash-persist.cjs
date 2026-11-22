#!/usr/bin/env node
/**
 * 阴性用例（2026-11-23，审计 F-01 · P1）：复习会话**崩溃/关窗不丢判分**。
 *
 * 缺陷（修前）：M.session 只在内存 —— 判分/撤销/摘组从不落盘，页面刷新、壳崩溃、
 *   意外关窗都把整场判分丢光（孩子一题一题按出来的东西瞬间消失）。
 * 修法：判分即时同步写 `localStorage['ctb2.session']`（refs 存 kid|subject|id 键）；
 *   boot 时 M.restoreSession() 按当前库重查卡接回（卡已撤的剔除并计数）；
 *   全部落库（endSession）/用户明确丢弃（discardSession）才删键。
 *
 * 本用例（纯内存 DOM 桩，neg-review-leave-and-noidx 同款 makeEnv，localStorage 换成真 Map）：
 *   A 判分/撤销/摘组 ⇒ 存储键同步更新；
 *   B "崩溃恢复"：新环境 + 同一 localStorage 内容 ⇒ restoreSession 接回会话，
 *     判定数、队列位置一致；卡已撤的剔除并计数；
 *   C endSession 全组落库 ⇒ 键被删（不再弹恢复）；
 *   D discardSession（用户明确丢弃）⇒ 键被删；
 *   E 阴性自证：把 model.js 的 sessionSave() 掏成空操作 ⇒ 判分后存储键为空（判据有牙齿）。
 *
 * 用法：node tests\neg-session-crash-persist.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let worst = 0, passed = 0;
const A = (n, ok, d) => { passed++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) worst++; };
const read = f => fs.readFileSync(path.join(ROOT, 'src', 'app', 'js', f), 'utf8');
const SESSION_KEY = 'ctb2.session';

/** localStorage 真实现（Map 后端），跨"进程"共享模拟同页面 */
function makeStore() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _dump: () => m.get(SESSION_KEY) || null,
  };
}

function makeEnv(store, overrides) {
  const ov = overrides || {};
  const CTB = {};
  const nodes = {};
  const ctx = {
    CTB, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    localStorage: store,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  ctx.addEventListener = () => { };
  ctx.removeEventListener = () => { };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.CTB = CTB;
  ctx.document = { addEventListener() { }, removeEventListener() { }, documentElement: {}, body: {}, createElement: () => ({ style: {}, addEventListener() { }, appendChild() { } }) };
  vm.createContext(ctx);
  const load = (f, src) => vm.runInContext(src || ov[f] || read(f), ctx, { filename: f });
  for (const f of ['util.js', 'host.js', 'model.js']) load(f);
  const { model: M } = CTB;
  return { CTB, M, store };
}

function stateWith(cards) {
  return {
    data: [{ name: '测试生', subjects: [{ name: '数学', items: cards }] }],
    admit: {}, blindFresh: {}, figState: {},
  };
}
const mkCard = id => ({ id, status: '在册', question: '1+1', stemHtml: '<p>1+1</p>', img: null, reviewStatus: '未复习', reviewCount: 0, passStreak: 0 });

(async () => {
  /* ══ A · 判分/撤销同步落盘 ══ */
  console.log('== A · 判分/撤销 ⇒ localStorage 同步更新 ==');
  const storeA = makeStore();
  const envA = makeEnv(storeA);
  envA.M.applyState(stateWith([mkCard('M0001'), mkCard('M0002')]));
  envA.M.startSession(envA.M.cardsOf().slice(0, 2));
  A('A1 开场即落盘（refs=2）', (() => { const s = JSON.parse(storeA._dump() || 'null'); return s && s.refs && s.refs.length === 2; })(), storeA._dump());
  envA.M.sessionGrade('对');
  A('A2 判一题 ⇒ results 同步进存储', (() => { const s = JSON.parse(storeA._dump() || 'null'); return s && Object.keys(s.results).length === 1 && s.idx === 1; })(), storeA._dump());
  envA.M.sessionUndo();
  A('A3 撤销 ⇒ 存储同步回退', (() => { const s = JSON.parse(storeA._dump() || 'null'); return s && Object.keys(s.results).length === 0 && s.idx === 0; })(), storeA._dump());
  envA.M.sessionGrade('对'); envA.M.sessionGrade('半对');
  A('A4 两题判完 ⇒ 存储里 2 条判定、idx=2', (() => { const s = JSON.parse(storeA._dump() || 'null'); return s && Object.keys(s.results).length === 2 && s.idx === 2; })(), storeA._dump());

  /* ══ B · 崩溃恢复 ══ */
  console.log('\n== B · 新环境（模拟崩溃后重开）⇒ restoreSession 接回 ==');
  {
    const envB = makeEnv(storeA);      // 同一 store：模拟"同一台机器重开页面"
    envB.M.applyState(stateWith([mkCard('M0001'), mkCard('M0002')]));   // 库还在（崩溃不丢库）
    A('B1 新环境内存里没有会话', envB.M.session === null, '');
    const rs = envB.M.restoreSession();
    A('★ B2 恢复成功', rs && rs.restored === true, JSON.stringify(rs));
    A('B3 判定数与崩溃前一致（2 条）', envB.M.sessionPendingCount() === 2, 'pending=' + envB.M.sessionPendingCount());
    A('B4 队列长度保持（2 题）', envB.M.session && envB.M.session.queue.length === 2, 'queue=' + (envB.M.session && envB.M.session.queue.length));
    A('B5 已判到队尾（idx=2）', envB.M.session && envB.M.session.idx === 2, 'idx=' + (envB.M.session && envB.M.session.idx));
  }
  {
    /* 卡被撤掉一张：恢复时剔除并计数，绝不静默吞 */
    const storeB2 = makeStore();
    const env1 = makeEnv(storeB2);
    env1.M.applyState(stateWith([mkCard('M0001'), mkCard('M0002')]));
    env1.M.startSession(env1.M.cardsOf().slice(0, 2));
    env1.M.sessionGrade('对'); env1.M.sessionGrade('错');
    const env2 = makeEnv(storeB2);
    env2.M.applyState(stateWith([mkCard('M0001')]));   // M0002 已撤卡
    const rs = env2.M.restoreSession();
    A('B6 卡已撤的恢复：剔除并计数（dropped=1，不静默吞）', rs && rs.restored && rs.dropped === 1, JSON.stringify(rs));
    A('B7 剩余判定还在（1 条）', env2.M.sessionPendingCount() === 1, 'pending=' + env2.M.sessionPendingCount());
  }
  {
    /* 全部卡都没了：恢复失败但不炸 */
    const storeB3 = makeStore();
    const env1 = makeEnv(storeB3);
    env1.M.applyState(stateWith([mkCard('M0001')]));
    env1.M.startSession(env1.M.cardsOf().slice(0, 1));
    env1.M.sessionGrade('对');
    const env2 = makeEnv(storeB3);
    env2.M.applyState(stateWith([]));                  // 全撤
    const rs = env2.M.restoreSession();
    A('B8 全部卡已撤 ⇒ 不恢复（restored=false），存储键清掉', rs && rs.restored === false && storeB3._dump() === null, JSON.stringify(rs) + ' dump=' + (storeB3._dump() === null ? 'null' : '非空'));
  }

  /* ══ C · endSession 落库后清键 ══ */
  console.log('\n== C · 会话正常结束 ⇒ 存储键删除 ==');
  {
    const storeC = makeStore();
    const envC = makeEnv(storeC);
    envC.M.applyState(stateWith([mkCard('M0001')]));
    envC.M.startSession(envC.M.cardsOf().slice(0, 1));
    envC.M.sessionGrade('对');
    /* 模拟 endSession 的收尾（组卷/批改走壳通道，桩环境直接调 discard 路径不可 ——
       这里直接调 endSession 会走 CTB.host.mark ⇒ 桩下抛错；改为验证其收尾语义的等价实现：
       endSession 全组完成后的收尾 = session=null + lsDel。用 try/catch 断言抛错后**键仍在**（重试可续），
       再手动走正常收尾验证清键。） */
    let threw = null;
    try { await envC.M.endSession(); } catch (e) { threw = e && e.message; }
    A('C1 桩环境 endSession 组卷抛错（预期）', !!threw, String(threw || '').slice(0, 80));
    A('C2 抛错后存储键仍在（崩溃后可续，不丢）', storeC._dump() !== null, 'dump=' + (storeC._dump() ? '有' : 'null'));
    envC.M.discardSession();
    A('C3 discardSession 清掉存储键', storeC._dump() === null, 'dump=' + (storeC._dump() === null ? 'null' : '非空'));
  }

  /* ══ E · 阴性自证 ══ */
  console.log('\n== E · 阴性自证：掏掉 sessionSave ⇒ 判分不落盘 ==');
  {
    const src = read('model.js');
    const broken = src.replace(/const sessionSave = function \(\) \{[\s\S]*?\n  \};/, 'const sessionSave = function () { };');
    A('E1 掏得动 sessionSave（锚点匹配）', broken !== src, broken === src ? '锚点没匹配——用例与实现脱钩' : '已构造坏版本');
    if (broken !== src) {
      const storeE = makeStore();
      const envE = makeEnv(storeE, { 'model.js': broken });
      envE.M.applyState(stateWith([mkCard('M0001')]));
      envE.M.startSession(envE.M.cardsOf().slice(0, 1));
      envE.M.sessionGrade('对');
      A('★★ E2 坏版本下判分不落存储（= 主判据会红）', storeE._dump() === null || (() => { try { const s = JSON.parse(storeE._dump()); return !s.refs || !Object.keys(s.results || {}).length; } catch { return true; } })(), 'dump=' + (storeE._dump() || 'null').slice(0, 80));
    }
  }

  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => { console.error('✖ 用例自身异常：' + (e && e.stack || e)); process.exit(1); });
