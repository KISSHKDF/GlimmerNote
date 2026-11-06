#!/usr/bin/env node
/* 拾光小册 · 回话分情况判据 · 回归测试（2026-11-05）
 *
 * 锁死「用户的回复会分成几种情况、每种后续怎么处理」这套判据，防止它悄悄漂移。
 *
 * 判据本身是**规则**（正则），所以测试要同时证明三件事：
 *   ① 每类都能被认出来（正例）；
 *   ② 不该被认成这类的**不被**认出来（负例 —— 否则判据形同虚设）；
 *   ③ 分类结果推出的判定/处置落在**合法枚举**内，且不越权
 *      （不许夜间自己撤卡/建卡 —— 那两条路必须留给人）。
 *
 * 用法：node tests\neg-pending-reply-cases.cjs
 *      判据脚本不在默认位置时：set CTB_OPS_DIR=<它所在目录> 再跑。
 *
 * 依赖说明（2026-11-06 收口时补）：
 *   被判的 `回话分情况.mjs` 住在**仓外**（agent 侧工作目录的 dsh-ops\），它按本仓
 *   `_待确认.json` 的 kind/answer 分类，属"用户数据怎么判"的口径，不是程序资产，
 *   因此不进本仓、也不随包发布。本用例只锁它的判据形状，缺它时**可见地 SKIP**。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
/* 仓外判据脚本的定位（公开仓不许出现本机绝对路径：repo-hygiene 的禁词表会拦）：
 *   ① 环境变量 CTB_OPS_DIR 显式指定；
 *   ② 兜底 <仓库上一级>\work\dsh-ops —— 与 scripts\_运行区.ps1 同一套规矩：
 *      "相对仓库推导 + 机器差异只放环境变量"。 */
const OPS = String(process.env.CTB_OPS_DIR || '').trim() || path.join(path.dirname(REPO), 'work', 'dsh-ops');
const SCRIPT = path.join(OPS, '回话分情况.mjs');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]  ' + name); }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + (extra ? '　→ ' + extra : '')); }
}
function die(msg) { console.error(msg); process.exit(2); }

if (!fs.existsSync(SCRIPT)) {
  /* 可见 SKIP，不是静默放行：打印原因 + 怎么才能真跑。
     本用例只挂 quick/full（不在 fixture/CI 白名单），所以 CI 不受影响。 */
  console.log('SKIP  仓外判据脚本不在本机：' + SCRIPT);
  console.log('      它是 agent 侧资产（随 待办 生态走，不进本仓）。要真跑：set CTB_OPS_DIR=<它所在目录>');
  console.log('\nRESULT=SKIP 断言=0 通过=0 失败=0');
  process.exit(0);
}

/* 用 classify() 直接测：临时写一个小 .mjs 去 import 它。
   ⚠ 踩过的坑：路径要用 JSON.stringify 出来的**字面量**嵌进模板串，
   不能写 'file:///' + ${...}（那是 Node 侧的表达式拼接，落在模板字符串里不会求值，
     生成的文件里就是字面的 '+' ⇒ SyntaxError）。 */
const SCRIPT_URL = 'file:///' + SCRIPT.replace(/\\/g, '/');
const probe = path.join(require('os').tmpdir(), 'ctb-classify-probe-' + process.pid + '.mjs');
fs.writeFileSync(probe, `
import { classify, CASES } from ${JSON.stringify(SCRIPT_URL)};
const cases = ${JSON.stringify([
  // ── 正例：每类至少一条 ──
  { expect: 'A', id: 'A1', kind: '未批空白', answer: '这道题的题号上打了一个斜杠，代表着这道题不用做' },
  { expect: 'A', id: 'A2', kind: '口径确认', answer: '这题不要入卡，不补录了' },
  { expect: 'B', id: 'B1', kind: '口径确认', answer: '孩子答的是对的，这题不需要进错题库' },
  { expect: 'C', id: 'C1', kind: '疑似判错待认', answer: '正确答案应该为D，孩子答的是A' },
  { expect: 'C', id: 'C2', kind: '笔迹归属', answer: '我自己改的，没注意，又改错了' },
  { expect: 'D', id: 'D1', kind: '老师漏判', answer: '漏判' },
  { expect: 'E', id: 'E1', kind: '笔迹归属', answer: '孩子后来自己订正的' },
  { expect: 'F', id: 'F1', kind: '卷面辨认', answer: '与X1重复' },
  { expect: 'G', id: 'G1', kind: '错因口述', answer: '不知道"谁当中点"要分三类' },
  { expect: 'H', id: 'H1', kind: '错因口述', answer: '想到了懒得写' },
  { expect: 'H', id: 'H2', kind: '错因口述', answer: '考虑欠全面，忘了减了' },
  { expect: 'I', id: 'I1', kind: '卷面辨认', answer: '原卷3×放大定案：第二空黑笔原文是「1」，红笔「或2」为老师补写' },
  // ── 负例：容易被误判的 ──
  { expect: 'A', id: 'NA1', kind: '错因口述', answer: '不用做' },
  { expect: 'H', id: 'NH1', kind: '错因口述', answer: '随手写的' },
  { expect: 'G', id: 'NG1', kind: '错因口述', answer: '不知道usually后面要跟原型' },
])};
const out = [];
for (const c of cases) {
  const r = classify({ id: c.id, kind: c.kind, answer: c.answer });
  out.push({ id: c.id, expect: c.expect, got: r.case ? r.case.id : null, name: r.case ? r.case.name : null, matchedBy: r.matchedBy, verdict: r.case ? r.case.verdict : null, disposition: r.case ? r.case.disposition : null, auto: r.case ? r.case.auto : null, needHuman: r.case ? r.case.needHuman : null });
}
console.log(JSON.stringify({ out, caseCount: CASES.length }));
`, 'utf8');

let raw;
try {
  raw = execFileSync(process.execPath, [probe], { encoding: 'utf8', timeout: 60000 });
} catch (e) {
  try { fs.unlinkSync(probe); } catch { }
  die('判据脚本执行失败：' + String(e.stdout || '').slice(0, 300) + ' / ' + String(e.stderr || '').slice(0, 300));
}
try { fs.unlinkSync(probe); } catch { }

const res = JSON.parse(raw);
console.log('判据脚本：' + SCRIPT + '（情况数=' + res.caseCount + '）\n');

/* ---------- ① 正例：每类都能认出来 ---------- */
console.log('── ① 正例：分类认得对 ──');
for (const r of res.out) {
  const neg = r.id.startsWith('N');
  if (neg) continue;
  ok(r.id + '（' + r.name + '）判为 ' + r.expect, r.got === r.expect, '实得 ' + r.got + '（' + r.matchedBy + '）');
}

/* ---------- ② 负例：不该被误判 ---------- */
console.log('\n── ② 负例：容易被误判的没被误判 ──');
for (const r of res.out) {
  if (!r.id.startsWith('N')) continue;
  ok(r.id + ' 判为 ' + r.expect, r.got === r.expect, '实得 ' + r.got + '（' + r.matchedBy + '）');
}

/* ---------- ③ 推出的判定/处置都在合法枚举内 ---------- */
console.log('\n── ③ 推出的判定/处置合法 ──');
const VS = ['错', '对', '部分对', '无法判定', '不适用', '（不判）', '按卷面事实'];
const AS = ['无需处置', '已补建卡', '已撤卡', '已核销', '待人工', '无需处置（在册则撤卡）', '无需处置（不建卡）', '按在册与否分流', '已核销（并标「需拆条/需修正」）'];
for (const r of res.out) {
  if (!r.verdict) continue;
  ok(r.id + ' 判定在合法枚举内', VS.includes(r.verdict), r.verdict);
  ok(r.id + ' 处置在合法枚举内', AS.includes(r.disposition), r.disposition);
}

/* ---------- ④ 不越权：撤卡/建卡必须留给人 ---------- */
console.log('\n── ④ 自动化边界：撤卡/建卡不自动 ──');
/* B 类（判对）在册时必须撤卡 ⇒ 必须留给人 */
const b = res.out.find(r => r.id === 'B1');
ok('B 类（判对）标了必须留给人', !!(b && b.needHuman && /撤卡/.test(b.needHuman)), b && b.needHuman);
ok('B 类不在册时处置是「无需处置」', !!(b && /无需处置/.test(b.disposition)), b && b.disposition);
/* C 类（判错）不在册时需补建卡 ⇒ 建卡必须留给人 */
const c = res.out.find(r => r.id === 'C1');
ok('C 类（判错）标了建卡必须留给人', !!(c && c.needHuman && /建卡/.test(c.needHuman)), c && c.needHuman);
ok('C 类处置不是「已补建卡」（夜间不许自己建）', !!(c && c.disposition !== '已补建卡'), c && c.disposition);
/* G 类（用户自己也不知道）必须不可自动 */
const g = res.out.find(r => r.id === 'G1');
ok('G 类判为「无法判定」', !!(g && g.verdict === '无法判定'), g && g.verdict);
ok('G 类处置为「待人工」', !!(g && g.disposition === '待人工'), g && g.disposition);
ok('G 类标了不可自动', !!(g && /不可自动/.test(g.auto)), g && g.auto);
/* F 类（纠错）必须留人 */
const f = res.out.find(r => r.id === 'F1');
ok('F 类（纠错）标了必须留给人', !!(f && f.needHuman), f && f.needHuman);

/* ---------- ⑤ 覆盖度：真台账上覆盖率不能塌 ---------- */
console.log('\n── ⑤ 真台账覆盖度 ──');
/* 库根：与 `tests\_测试环境.cjs` 同一口径（CTB_TEST_LIB → 运行区 → 旧冻结区 → 合成库），
   拿不到库根时只跳过"覆盖度"这一段，前面的判据断言照跑。 */
let LEDGER = String(process.env.CTB_DATA || process.env.CTB_TEST_LIB || '').trim();
if (!LEDGER) { try { LEDGER = require('./_测试环境.cjs').LIB; } catch { LEDGER = ''; } }
const ledgerFile = LEDGER ? path.join(LEDGER, '_待确认.json') : '';
if (ledgerFile && fs.existsSync(ledgerFile)) {
  const doc = JSON.parse(fs.readFileSync(ledgerFile, 'utf8').replace(/^\uFEFF/, ''));
  const answered = (doc.items || []).filter(it => it.status === '已确认' && (it.answer || '').trim());
  let covered = 0;
  try {
    const probe2 = path.join(require('os').tmpdir(), 'ctb-cls2-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.mjs');
    fs.writeFileSync(probe2, `
import { classify } from ${JSON.stringify(SCRIPT_URL)};
import fs from 'fs';
const doc = JSON.parse(fs.readFileSync(${JSON.stringify(ledgerFile)}, 'utf8').replace(/^\\uFEFF/,''));
const answered = (doc.items||[]).filter(it => it.status==='已确认' && (it.answer||'').trim());
let cov=0; const un=[];
for (const it of answered){ const r=classify(it); if(r.case) cov++; else un.push(it.id+':'+it.kind); }
console.log(JSON.stringify({total:answered.length, covered:cov, unclassified:un.length, samples:un.slice(0,5)}));
`, 'utf8');
    try {
      const r2 = JSON.parse(execFileSync(process.execPath, [probe2], { encoding: 'utf8', timeout: 60000 }));
      const pct = r2.total ? (r2.covered * 100 / r2.total) : 100;
      console.log('   真台账已回话 ' + r2.total + ' 条，判据覆盖 ' + r2.covered + ' 条（' + pct.toFixed(0) + '%），未归类 ' + r2.unclassified + ' 条');
      ok('判据覆盖率 ≥ 85%（低于此说明判据失效或台账变种了）', pct >= 85, pct.toFixed(0) + '%');
      ok('未归类的量可控（≤20%，这些靠 AI 读全上下文判）', r2.unclassified <= Math.max(3, r2.total * 0.2), r2.unclassified + ' 条');
    } finally { try { fs.unlinkSync(probe2); } catch { } }
  } catch (e) {
    console.log('   （覆盖度检查执行失败：' + String(e.message).slice(0, 120) + '）');
    ok('覆盖度检查能跑起来', false, String(e.message).slice(0, 120));
  }
} else {
  console.log('   （真台账不在：库根=' + (LEDGER || '(未解析到)') + '，跳过覆盖度检查；前四段判据断言已照跑）');
}

console.log('\n失败项：');
if (!failures.length) console.log('  （无）');
else failures.forEach(f => console.log('  ✗ ' + f));
console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
