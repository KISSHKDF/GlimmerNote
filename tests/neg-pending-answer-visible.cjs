/* 拾光小册 · 待办「回话可见 + 欠账可执行」回归（2026-11-05）
 *
 * 用户报障（原话）：「照你这样说，你设置这个待办有什么用？问了我问题，我也认真回答了，
 * 可是根本没人看，没人懂。」
 *
 * 取证到的三个真缺陷（本测试逐条锁死，防退化）：
 *
 *   D-1 ★ 已办结条目**不在状态包 items 里** ⇒ 前端「显示已办结」勾选框读同一个数组，
 *        勾上也是空的。用户的回话落了库，界面上却像从来没发生过 —— 这就是"没人看"。
 *        修：`门禁 --json` 额外输出 `doneItems`（含 answer/verdict/disposition/closed）。
 *
 *   D-2 ★ 前端没有"你的回话 + 它有没有被执行"的展示 ⇒ 回答与执行之间没有可见的连接。
 *        修：`doneBlock()` 渲染回答原文、判定、处置；欠账时显式喊"这条还没被执行"。
 *
 *   D-3 ★ 欠账横幅与顶栏计数缺失 ⇒ 用户从界面看不出"回了但没人做"。
 *        修：`owesBanner()` + `V.sub()` 报欠账数。
 *
 * 判据是**负向对照**为主：把 doneItems 从状态包里抽掉、把 closed 字段抹掉，
 * 断言必须会红（否则判据恒真，等于没测）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = E.REPO;
const TOOLS = E.TOOLS;
const LIB = E.LIB;
const PENDING_JS = path.join(REPO, 'src', 'app', 'js', 'views', 'pending.js');
const MODEL_JS = path.join(REPO, 'src', 'app', 'js', 'model.js');
const TOOL_MJS = path.join(TOOLS, '_待确认.mjs');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]  ' + name); }
  else { fail++; failures.push(name + (extra ? '　→ ' + extra : '')); console.log('  [FAIL] ' + name + (extra ? '　→ ' + extra : '')); }
}

/* ---------- 0. 前置：工具能跑起来 ---------- */
const gate = spawnSync(process.execPath, [path.join(TOOLS, '_待确认.mjs'), '门禁', '--json'], {
  cwd: REPO, encoding: 'utf8', env: { ...process.env, CTB_DATA: LIB },
});
let gj = null;
try { gj = JSON.parse((gate.stdout || '').replace(/^\uFEFF/, '')); } catch (e) { }
ok('门禁 --json 可解析', !!gj, gate.stdout ? gate.stdout.slice(0, 120) : 'no stdout');

if (!gj) {
  console.log('\nRESULT=FAIL 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
  process.exit(1);
}

/* ---------- D-1：已办结条目必须在状态包里，且带 answer/closed ---------- */
console.log('\n── D-1 已办结条目可见（doneItems）──');
ok('状态包含 doneItems 字段', Array.isArray(gj.doneItems));
const done = Array.isArray(gj.doneItems) ? gj.doneItems : [];
ok('doneItems 非空（真库有已办结条目）', done.length > 0, 'doneItems=' + done.length);
ok('doneItems 数量 = 已办结条目数（doneTotal）', done.length === gj.doneTotal,
  'doneItems=' + done.length + ' doneTotal=' + gj.doneTotal);

const sample = done[0];
ok('已办结条目带 status', !!(sample && sample.status), sample && sample.status);
ok('已办结条目带 answer（你的原话）', !!(sample && typeof sample.answer === 'string'));
ok('已办结条目带 closed 布尔（有没有被执行）', !!(sample && typeof sample.closed === 'boolean'));
ok('已办结条目带 verdict/disposition 字段', !!(sample && 'verdict' in sample && 'disposition' in sample));

/* 已作废是终局，不需要判定/处置（与 _闭环稽核.mjs:214 同口径）——不该混进欠账 */
const voided = done.filter(p => p.status === '已作废');
ok('已作废条目 closed 可为 false 但不进欠账口径', voided.every(p => typeof p.closed === 'boolean'));

/* 负向对照：把 doneItems 抽掉，前端就再也看不到已办结条目 ⇒ 判据不是恒真 */
const withoutDone = Object.assign({}, gj);
delete withoutDone.doneItems;
ok('【负向】抽掉 doneItems 后前端拿不到已办结条目',
  !withoutDone.doneItems && done.length > 0);

/* ---------- D-2：前端要显示「你的回话 + 有没有被执行」 ---------- */
console.log('\n── D-2 前端展示回话与执行状态 ──');
const pjs = fs.readFileSync(PENDING_JS, 'utf8');
ok('前端读 doneItems（经 M.pendingDone）', /pendingDone/.test(pjs));
ok('前端渲染「你的回答」', /你的回答/.test(pjs));
ok('前端渲染判定与处置', /已按你的口径执行/.test(pjs));
ok('欠账时显式喊「还没被执行」', /这条还没被执行/.test(pjs));
ok('已办结条目走 doneBlock 而不是旧的「结论：」', /doneBlock\(p,\s*owes\)/.test(pjs));

/* 负向对照：把「你的回答」这段抽掉，断言必须会红 */
const pjsStripped = pjs.replace(/你的回答/g, 'XX');
ok('【负向】抽掉「你的回答」后判据会红', !/你的回答/.test(pjsStripped) && /你的回答/.test(pjs));

/* ---------- D-3：欠账横幅 + 顶栏计数 ---------- */
console.log('\n── D-3 欠账可见（横幅 + 顶栏）──');
ok('前端有欠账横幅 owesBanner', /owesBanner/.test(pjs));
ok('横幅文案点明「结论落了库 ≠ 回话生效」', /结论落了库 ≠ 回话生效/.test(pjs));
ok('顶栏 sub 报欠账数', /欠账/.test(pjs));
ok('欠账横幅有对应样式 owes-banner', /owes-banner/.test(fs.readFileSync(path.join(REPO, 'src', 'app', 'css', 'app.css'), 'utf8')));

/* ---------- 模型层：pendingAll / pendingDone ---------- */
console.log('\n── 模型层接口 ──');
const mjs = fs.readFileSync(MODEL_JS, 'utf8');
ok('M.pendingDone 存在', /M\.pendingDone\s*=/.test(mjs));
ok('M.pendingAll 存在', /M\.pendingAll\s*=/.test(mjs));
ok('pendingDone 取状态包 doneItems', /pending\.doneItems/.test(mjs));

/* ---------- 工具层：单一实现（pendingItemOut） ---------- */
console.log('\n── 工具层单一实现 ──');
const tmjs = fs.readFileSync(TOOL_MJS, 'utf8');
ok('pendingItemOut 是唯一的条目序列化实现', /function pendingItemOut\(/.test(tmjs));
const defCount = (tmjs.match(/function pendingItemOut\(/g) || []).length;
ok('pendingItemOut 只定义一次（防两份实现漂移）', defCount === 1, '定义次数=' + defCount);
ok('items 走 pendingItemOut', /items:\s*pend\.map\(it => pendingItemOut\(it\)\)/.test(tmjs));
ok('doneItems 走 pendingItemOut', /doneItems:\s*doneAll\.map\(it =>/.test(tmjs) && /pendingItemOut\(it\)/.test(tmjs));

/* ---------- 欠账判据与门禁同口径 ---------- */
console.log('\n── 欠账判据一致性 ──');
/* 门禁的 noVerdict/noDisposition 与 doneItems 的 closed 必须一致：
   noVerdict 里不该有 closed=true 的（判定齐了就不该再报未判定） */
const noVerdict = gj.noVerdict || [];
const noDisp = gj.noDisposition || [];
const noVerdictSet = new Set(noVerdict);
const noDispSet = new Set(noDisp);
const badClosed = done.filter(p => p.closed === true && (noVerdictSet.has(p.id) || noDispSet.has(p.id)));
ok('closed=true 的条目不在门禁的未判定/未处置名单里', badClosed.length === 0,
  badClosed.map(p => p.id).join(','));
/* 反向：closed=false 的已确认条目，必须同时出现在未判定或未处置名单里 */
const badOpen = done.filter(p => p.status === '已确认' && p.closed === false &&
  !(noVerdictSet.has(p.id) || noDispSet.has(p.id)));
ok('closed=false 的已确认条目必然被门禁点名', badOpen.length === 0,
  badOpen.map(p => p.id).join(','));

/* ---------- 汇总 ---------- */
console.log('\n失败项：');
if (!failures.length) console.log('  （无）');
else failures.forEach(f => console.log('  ✗ ' + f));
console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
