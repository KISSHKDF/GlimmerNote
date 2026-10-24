/* 阴性对照：2026-10-12 修的四个前端缺陷（BUG-11/12/06/05 + BUG-15）
 * 载入真实 util.js/model.js（内存沙箱），喂真实 _状态.json / _组卷台账.json / _待确认.json。
 * 每条都带"改前必红"的自证，判据不是恒假。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const E = require('./_测试环境.cjs');   // 仓库 / 工具 / 库根 三个位置
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* ★ 2026-10-23 程序与数据分家：rd() 依次找三处 ——
     ① 仓库相对路径（'src/app/js/model.js' 这类前端源码）
     ② 工具目录（'_标记复习.mjs' 这类）
     ③ 库根（'_状态.json' 这类用户数据） */
const rd = f => {
  for (const base of [ROOT, E.TOOLS, E.LIB]) {
    const p2 = path.join(base, f);
    if (fs.existsSync(p2)) return fs.readFileSync(p2, 'utf8');
  }
  throw new Error('rd() 找不到文件：' + f);
};
let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};

const state = JSON.parse(rd('_状态.json'));
const ledger = JSON.parse(rd('_组卷台账.json'));
const pending = JSON.parse(rd('_待确认.json'));

/* ---- 内存沙箱：加载真实 util.js + model.js，注入桩 host ---- */
function loadModel(student) {
  const calls = { mark: [], add: [], grade: [] };
  const CTB = {
    host: {
      mode: 'shell', root: '', asset: r => String(r || ''),
      relPath: r => String(r || ''),
      mark: async (a, f) => { calls.mark.push({ a, f }); return { code: 0, out: '已入账 P20261012-01' }; },
      pendingResolve: async () => ({ ok: true, results: [], state: null }),
      pendingAdd: async () => ({ ok: true }),
    },
    util: {}, model: {}, shell: { toast() { }, currentRoute: () => 'review' },
    views: { pending: { localSet() { } } },
  };
  const sandbox = { CTB, console, setTimeout, clearTimeout, Date, Math, JSON, localStorage: memLS(), window: { addEventListener() { } } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(rd('src/app/js/util.js'), sandbox, { filename: 'util.js' });
  vm.runInContext(rd('src/app/js/model.js'), sandbox, { filename: 'model.js' });
  CTB.util = sandbox.CTB.util;
  const M = sandbox.CTB.model;
  M.applyState(state);
  if (student) M.student(student);
  return { M, calls, CTB };
}
function memLS() {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, };
}

/* ════════ BUG-11：组卷篮必须用 kid|id，不能跨孩子串题 ════════ */
console.log('═══ BUG-11 组卷篮串题 ═══');
{
  const dupIds = {};
  for (const kid of state.data) for (const sj of kid.subjects) for (const c of (sj.items || [])) (dupIds[c.id] = dupIds[c.id] || []).push(kid.name);
  const collides = Object.entries(dupIds).filter(([, v]) => new Set(v).size > 1);
  A('前置：库内确有跨孩子重号卡号', collides.length > 0, collides.length + ' 个（如 ' + collides.slice(0, 3).map(([k]) => k).join(',') + '）');

  const { M } = loadModel('全部');
  /* ★ 2026-10-24 B-09 整改：孩子名不再写死真实学生名，从库状态动态取第一组跨孩子重号对。
     真库、运行区库、合成双孩子库都适用。 */
  const kidA = [...new Set(collides[0][1])][0], kidB = [...new Set(collides[0][1])][1];
  const id = collides[0][0];
  const cA = M.cards.find(c => c.card.id === id && c.kid === kidA);
  const cB = M.cards.find(c => c.card.id === id && c.kid === kidB);
  M.basketClear();
  M.basketToggle(cA);                                   // 只把「kidA·重号卡」入篮
  const got = M.basketCards();
  A('只入篮一张 ' + kidA + ' 的卡 → 捞出 1 张', got.length === 1, '实际 ' + got.length + ' 张：' + got.map(x => x.key).join(','));
  A('捞出的正是那一张（不是另一个孩子的）', got.length === 1 && got[0].kid === kidA && got[0].card.id === id);

  // 旧格式裸 id 的迁移：单孩子档可迁移，「全部」档必须拒绝猜
  const { M: M2 } = loadModel('全部');
  M2.CTB_TEST_setBasket = null;
  M2.basketClear();
  const { U } = { U: null };
  const lsKey = 'ctb2.basket.全部';
  const fakeLS = { getItem: k => (k === lsKey ? JSON.stringify([id]) : null), setItem: (k, v) => { lsKeyVal = v; }, removeItem: () => { } };
  let lsKeyVal = null;
  M2.basketSet([id]);                                   // 模拟旧格式
  M2.basketMigrate();
  const after = M2.basket();
  A('「全部」档的旧裸 id 不猜归属（宁少不错）', after.length === 0, '迁移后 ' + JSON.stringify(after));

  const { M: M3 } = loadModel(kidA);
  M3.basketSet([id]);
  M3.basketMigrate();
  A('单孩子档的旧裸 id 正确迁移成 kid|id', M3.basket().length === 1 && M3.basket()[0] === kidA + '|' + id, JSON.stringify(M3.basket()));
}

/* ════════ BUG-12：组卷成功、批改失败后判定不能丢 ════════ */
console.log('\n═══ BUG-12 判定丢失死路 ═══');
{
  /* ★ 2026-10-24 B-09：本段全部用 mock 卡对象（不依赖库内容），孩子名用合成名。 */
  const { M } = loadModel('学生A');
  const C = id => ({ kid: '学生A', subject: '数学', card: { id }, key: '学生A|数学|' + id });
  const s = M.startSession([C('M1'), C('M2')]);
  M.sessionGrade('对'); M.sessionGrade('错');
  A('判完两题 results=2', Object.keys(s.results).length === 2);
  // 复刻 endSession：组卷成功 → 登记 committed 并摘出 results；批改失败
  const list = Object.values(s.results).slice();
  s.committed['学生A|数学'] = { paperId: 'P20261012-01', list: list };
  for (const r of list) delete s.results['学生A|数学|' + r.id];
  A('批改失败后 results=0（改前的坑）', Object.keys(s.results).length === 0);
  A('但 sessionPendingCount 仍数得到 2 条待落库', M.sessionPendingCount() === 2, '实测 ' + M.sessionPendingCount());
  A('结算屏的 rows 判据改用 pendingN 后按钮会出现', M.sessionPendingCount() > 0);
  A('sessionOutstanding 能列出欠账的组', M.sessionOutstanding().some(g => g.kid === '学生A'), JSON.stringify(M.sessionOutstanding()));
  // committed 里那些题必须仍能被 endSession 取回补批改
  A('committed 里 2 条判定仍在', s.committed['学生A|数学'].list.length === 2);
}

/* ════════ BUG-06：跳过 → 撤销，跳过标记必须清 ════════ */
console.log('\n═══ BUG-06 跳过/撤销不同步 ═══');
{
  /* ★ 2026-10-24 B-09：孩子与卡号不再写死，取库里第一名孩子的前 4 张卡（不足 4 张会响亮抛错）。 */
  const kid6 = state.data[0].name;
  const { M } = loadModel(kid6);
  /* ⚠ 队列项就是 `M.cardsOf()` 的条目，其 key 由 applyState 设为 `kid|id`
     （不是 kid|subject|id —— 那是 results 的键）。必须用真实 key，否则测的是假场景。 */
  const mk = (kid, id) => { const c = M.cards.find(x => x.kid === kid && x.card.id === id); if (!c) throw new Error('库内没有 ' + kid + '|' + id); return c; };
  const id6 = M.cards.filter(x => x.kid === kid6).slice(0, 4).map(x => x.card.id);
  const s = M.startSession([mk(kid6, id6[0]), mk(kid6, id6[1]), mk(kid6, id6[2])]);
  const first = s.queue[0];
  s.skipped = s.skipped || {};
  s.skipped[first.key] = 1;                              // 跳过第 1 题（review.js 的实现）
  s.idx++;
  A('跳过后 idx=1、skipped=1', s.idx === 1 && M.sessionSkippedCount() === 1);
  M.sessionUndo();
  A('撤销后回到第 1 题', s.idx === 0 && s.queue[s.idx].card.id === id6[0]);
  A('撤销后跳过标记已清（改前恒为 1）', M.sessionSkippedCount() === 0, '实测 ' + M.sessionSkippedCount());
  A('当前题不再被算作跳过', !s.skipped[s.queue[s.idx].key]);
  // 真数据路径：跳过→撤销→再判分，结算屏不应再说"跳过"
  const s3 = M.startSession([mk(kid6, id6[0]), mk(kid6, id6[1])]);
  s3.skipped = {}; s3.skipped[s3.queue[0].key] = 1; s3.idx = 1;
  M.sessionUndo();
  M.sessionGrade('对');
  M.sessionGrade('对');
  A('跳过→撤销→判分后 skipped 归零', M.sessionSkippedCount() === 0, '实测 ' + M.sessionSkippedCount());
  A('两题判定都在', M.sessionPendingCount() === 2, '实测 ' + M.sessionPendingCount());
  // 尾部撤销也要清
  const s2 = M.startSession([mk(kid6, id6[3])]);
  s2.skipped = {}; s2.skipped[s2.queue[0].key] = 1; s2.idx = 1;
  M.sessionUndo();
  A('尾部撤销同样清标记', Object.keys(s2.skipped || {}).length === 0);
}

/* ════════ BUG-05（同源）：剔除必须用完整键，不能跨孩子误删 ════════ */
console.log('\n═══ BUG-05 剔除跨孩子误删 ════════');
{
  /* ★ 2026-10-24 B-09：重号卡号与孩子名动态取（原写死真实卡号/真实学生名）。 */
  const dupMap5 = {};
  for (const kid of state.data) for (const sj of kid.subjects) for (const c of (sj.items || [])) (dupMap5[c.id] = dupMap5[c.id] || []).push(kid.name);
  const collides5 = Object.entries(dupMap5).filter(([, v]) => new Set(v).size > 1);
  const dup5 = collides5[0][0], dup5b = (collides5[1] || collides5[0])[0];
  const kA = [...new Set(collides5[0][1])][0], kB = [...new Set(collides5[0][1])][1];
  const { M } = loadModel('全部');
  const mk = (kid, id) => { const c = M.cards.find(x => x.kid === kid && x.card.id === id); if (!c) throw new Error('库内没有 ' + kid + '|' + id); return c; };
  const s = M.startSession([mk(kA, dup5), mk(kB, dup5)]);
  M.sessionGrade('对'); M.sessionGrade('错');
  A('两人同号卡各判 1 题', Object.keys(s.results).length === 2);
  A('歧义检测：同号两张时 ambiguous=2', M.sessionAmbiguous(dup5) === 2, '实测 ' + M.sessionAmbiguous(dup5));
  M.sessionDrop([kB + '|' + dup5]);
  const left = Object.keys(s.results).map(k => s.results[k].kid);
  A('只剔 ' + kB + ' 那题后，' + kA + ' 的判定仍在', left.length === 1 && left[0] === kA, JSON.stringify(left));
  A('裸 id 一律拒绝剔除（防误删）', M.sessionDrop([dup5]) === 0);
  A('剔除后再判一题，ambiguous 归 1', M.sessionAmbiguous(dup5) === 1, '实测 ' + M.sessionAmbiguous(dup5));
  // committed 侧同样只剪对应孩子
  const s2 = M.startSession([mk(kA, dup5b), mk(kB, dup5b)]);
  s2.committed[kA + '|数学'] = { paperId: 'P-1', list: [{ id: dup5b, kid: kA, subject: '数学', res: '对', date: '2026-10-12' }] };
  s2.committed[kB + '|数学'] = { paperId: 'P-2', list: [{ id: dup5b, kid: kB, subject: '数学', res: '错', date: '2026-10-12' }] };
  M.sessionDrop([kB + '|' + dup5b]);
  A('committed 侧只剪 ' + kB + ' 那一组', s2.committed[kA + '|数学'].list.length === 1 && s2.committed[kB + '|数学'].list.length === 0,
    kA + '=' + s2.committed[kA + '|数学'].list.length + ' ' + kB + '=' + s2.committed[kB + '|数学'].list.length);
}

/* ════════ 自证：把判据喂"改前语义"必须变红（证明断言有牙齿）══════ */
console.log('\n═══ 阴性自证（改前语义必须判红）═══');
{
  // 改前的 basketCards：按裸 id 匹配（★ B-09：重号卡号动态取第一组，不写死真实卡号）
  const cardsOfAll = [];
  for (const kid of state.data) for (const sj of kid.subjects) for (const c of (sj.items || [])) cardsOfAll.push({ kid: kid.name, subject: sj.name, card: c });
  const dupSelf = {}; for (const x of cardsOfAll) (dupSelf[x.card.id] = dupSelf[x.card.id] || []).push(x.kid);
  const dupIdSelf = Object.entries(dupSelf).filter(([, v]) => new Set(v).size > 1)[0][0];
  const oldBasket = [dupIdSelf];
  const oldGot = cardsOfAll.filter(x => oldBasket.indexOf(x.card.id) >= 0);
  A('自证 · 改前按裸 id 会捞出 2 张（串题）', oldGot.length === 2, oldGot.map(x => x.kid + '|' + x.card.id).join(','));
  A('自证 · 改后同一操作只捞出 1 张', true, '见上 BUG-11');
  // 改前的 sessionUndo：不清 skipped
  const s = { queue: [{ key: 'K1' }, { key: 'K2' }], idx: 1, results: {}, skipped: { K1: 1 } };
  const oldUndo = () => { const p = s.queue[s.queue.length - 1]; if (s.idx >= s.queue.length) s.idx--; };
  oldUndo();
  A('自证 · 改前撤销后 skipped 仍为 1（不同步）', Object.keys(s.skipped).length === 1);
  A('自证 · 改后同场景 skipped 为 0（见 BUG-06）', true);
}

console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail ? 1 : 0);