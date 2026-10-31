#!/usr/bin/env node
/**
 * 拾光小册 · E01 阴性对照：`full` 门禁不得把写路径用例跑在用户真库上（2026-10-31 建）
 *
 * 事故（外部复核已证实，本用例逐条守住它的每个环节）：
 *   `tests\_测试环境.cjs` 的 `E.LIB` 在开发机上 = 用户真库（`isFrozen()` = true）
 *   → `tests\launch-dev.cjs:85` 把 `CTB_DATA: E.LIB` 传给桌面壳 → 壳的子进程继承环境
 *   → `tests\e2e-writepath.cjs:119/157/174` 通过 CDP 真跑 组卷/批改/撤批
 *   → `src\tools\_安全写.mjs` 的 `backupJson` 轮转 keep=8 删最旧
 *   → 而 `tests\run.mjs` 把 `_备份-真源\` 的删除记成 `derived`（允许，不判红）。
 *   实测后果：真库三个目录各被删 8 份**已跟踪备份**（共 24 份），新增 24 份新时间戳。
 *   额外事实：全仓 `assertWritableLib(` 的**真实调用点 = 0**（只有定义与注释）——
 *   这道"真库拒写守卫"是死代码。
 *
 * 本用例守四条（任何一条被掏掉都必须红）：
 *   ① 冻结区上跑 `e2e-writepath.cjs` 必须**打印 `RESULT=SKIP` 并 exit 0**，
 *      且**不许**走到 CDP/写盘那一段（子进程实跑，不依赖壳在不在）；
 *   ② 阴性自证：把准入闸掏掉（还原成修复前的"直接连 CDP"）后，同一个环境里
 *      **不再**打印 SKIP 而是进入写路径 —— 证明 ① 的绿是那道闸给的，不是碰巧；
 *   ③ `assertWritableLib` 必须有**真实调用点**（不是死代码），且它的判据与 SKIP 判据同一份；
 *   ④ `_备份-真源\` 的派生放行必须是**有条件的**：冻结库上不放行（否则真库备份被吃也全绿）。
 *
 * 为什么不真起壳来验：起壳会真写库（正是本缺陷），而本用例要证明的恰恰是"不写"。
 *   判据放在**写盘之前**，所以子进程级验证就等价于端到端验证，且不污染任何库。
 *
 * 用法：node tests\neg-e2e-frozen-lib.cjs
 * 退出码：0=PASS（含阴性自证）/ 1=FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const E = require('./_测试环境.cjs');
const REPO = E.REPO;

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

console.log('测试环境：' + E.describe());

/* ══════════ ① 造一个"形如冻结区"的库（路径里带 GlimmerNote\数据 即命中 isFrozen）══════════
   为什么不直接用真库：本用例要能在一台**没有**真库的机器上跑，而且绝不能真写它。
   `isFrozen` 的判据是**路径形状**（_测试环境.cjs 的 FROZEN 正则），所以临时目录里造一个
   同形状的路径就能精确复现现场判据 —— 且它物理上在 %TEMP%，写坏了也无所谓。 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-frozen-'));
const fakeLib = path.join(base, 'GlimmerNote', '数据');
fs.mkdirSync(fakeLib, { recursive: true });
fs.writeFileSync(path.join(fakeLib, '_索引.json'), JSON.stringify({ student: '合成', items: [] }), 'utf8');
fs.writeFileSync(path.join(fakeLib, '_状态.json'), JSON.stringify({ generatedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');

console.log('\n══ ① 判据本体：冻结区 == 写盘禁区 ══');
A('临时构造的路径被 isFrozen() 判为冻结区', E.isFrozen(fakeLib) === true, fakeLib);
A('写盘守卫拒绝冻结区（writeGuard.ok=false）', E.writeGuard(fakeLib).ok === false, E.writeGuard(fakeLib).reason);
A('写盘守卫放行普通临时目录（避免"一律拒绝"式的假绿）',
  E.writeGuard(path.join(base, '副本')).ok === true, path.join(base, '副本'));
A('assertWritableLib 的判据与写盘守卫同一份（冻结区必须抛错）', (() => {
  const saved = process.env.CTB_DATA;
  process.env.CTB_DATA = fakeLib;
  let threw = false;
  try { E.assertWritableLib('自证'); } catch { threw = true; }
  if (saved === undefined) delete process.env.CTB_DATA; else process.env.CTB_DATA = saved;
  return threw;
})(), '冻结区没有抛错 = 守卫失效');

/* ══════════ ② 子进程实跑 e2e-writepath（冻结区上必须 SKIP，且不碰 CDP）══════════ */
console.log('\n══ ② 冻结区上跑写路径用例：必须 RESULT=SKIP 且不进 CDP 段 ══');
function runE2E(scriptPath, lib) {
  const env = Object.assign({}, process.env, { CTB_TEST_LIB: lib, CTB_CDP_TIMEOUT: '1500' });
  delete env.CTB_DATA;                       // 让 _测试环境 按 CTB_TEST_LIB 重新解析
  return spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env, cwd: REPO, timeout: 120000 });
}
const realE2E = path.join(REPO, 'tests', 'e2e-writepath.cjs');
const r1 = runE2E(realE2E, fakeLib);
const out1 = String(r1.stdout || ''), err1 = String(r1.stderr || '');
A('冻结区上 e2e-writepath 退出码 = 0（是 SKIP，不是 FAIL）', r1.status === 0, 'status=' + r1.status);
A('★ 打印了 RESULT=SKIP（不是静默通过、也不是 PASS）', /RESULT=SKIP\(/.test(out1),
  (out1.split(/\r?\n/).find(l => l.startsWith('RESULT=')) || '(没有 RESULT 行)').slice(0, 200));
A('SKIP 理由写清了"冻结区/真库"与"请用 CTB_TEST_LIB 指副本"',
  /冻结区|真库/.test(out1) && /CTB_TEST_LIB/.test(out1),
  (out1.match(/RESULT=SKIP\(([\s\S]{0,180})/) || [])[1] || '');
A('★ 完全没有进入写盘段（没有 [2] 组卷 / 没有 NO TARGET）',
  !/\[2\] 组卷/.test(out1) && !/NO TARGET/.test(out1) && !/NO TARGET/.test(err1),
  '组卷段出现 = 闸没拦住');

/* ══════════ ③ 阴性自证：把准入闸掏掉，同一环境必须"不再 SKIP 而是进写路径" ══════════ */
console.log('\n══ ③ 阴性自证：掏掉准入闸必须让本用例变红 ══');
const srcE2E = fs.readFileSync(realE2E, 'utf8');
const gStart = srcE2E.indexOf('const gate = E.guardWriteTest(');
const gEndMark = 'process.exit(0);\n  }';
const gEndRel = gStart < 0 ? -1 : srcE2E.indexOf(gEndMark, gStart);
let mutated = null;
if (gStart >= 0 && gEndRel >= 0) {
  mutated = srcE2E.slice(0, gStart) + '/* [阴性自证] 准入闸已掏掉（还原成修复前的行为） */\n' +
    srcE2E.slice(gEndRel + gEndMark.length);
  /* 只把 CDP 目标换成必然连不上的端口：本段要证明的是"越过闸后进入 CDP 写路径"，
     不能因为本机恰好有个壳在跑就真的写进用户库（那正是本案要防的事故）。 */
  mutated = mutated.replace("'http://127.0.0.1:9223/json/list'", "'http://127.0.0.1:9/json/list'");
  /* 副本在 %TEMP%，相对 require 会失效 ⇒ 换成绝对路径 */
  mutated = mutated.replace("require('./_测试环境.cjs')", 'require(' + JSON.stringify(path.join(REPO, 'tests', '_测试环境.cjs')) + ')');
}
A('掏掉点存在且确实改动过源码（自证装置可用）',
  !!mutated && !mutated.includes('guardWriteTest('), mutated ? '已构造无闸版本' : '定位失败，自证无效');
if (mutated) {
  const mutPath = path.join(base, 'e2e-writepath-no-guard.cjs');
  fs.writeFileSync(mutPath, mutated, 'utf8');
  const r2 = runE2E(mutPath, fakeLib);
  const out2 = String(r2.stdout || '') + String(r2.stderr || '');
  A('★ 掏掉闸后不再打印 RESULT=SKIP（= 主判据会红）', !/RESULT=SKIP/.test(out2),
    (out2.split(/\r?\n/).filter(Boolean)[0] || '').slice(0, 160));
  A('★ 掏掉闸后它确实进入了 CDP 写路径（fetch 失败 ⇒ 非 0 退出）', r2.status !== 0,
    'status=' + r2.status);
}

/* ══════════ ④ 静态判据：闸的位置、真调用点、备份放行条件 ══════════ */
console.log('\n══ ④ 静态判据：闸在 CDP 之前 / assertWritableLib 不再是死代码 / 备份放行有条件 ══');
const gatePos = srcE2E.indexOf('E.guardWriteTest(');
const cdpPos = srcE2E.indexOf("fetch('http://127.0.0.1:9223/json/list')");
const writePos = srcE2E.indexOf("CTB.host.mark('组卷'");
A('准入闸在 CDP 连接**之前**（否则已经连上壳才判，闸就没意义）', gatePos >= 0 && gatePos < cdpPos,
  'gate@' + gatePos + ' / cdp@' + cdpPos);
A('准入闸在写盘调用**之前**', gatePos >= 0 && gatePos < writePos, 'gate@' + gatePos + ' / 写@' + writePos);
A('e2e 里 assertWritableLib 有真实调用点（且就在组卷之前）',
  /E\.assertWritableLib\(/.test(srcE2E) && srcE2E.indexOf('E.assertWritableLib(') < writePos,
  '位置 ' + srcE2E.indexOf('E.assertWritableLib('));

/* 全仓真实调用点 > 0：排除"定义"那一行本身，也排除只出现在注释里的提及
   （改前 neg-server-bom.cjs 里就有一句注释提到它 —— 那种"提及"不算调用点，不能拿来充数）。 */
function countCallSites() {
  const hits = [];
  for (const d of ['tests', 'scripts', 'src']) {
    const root = path.join(REPO, d);
    if (!fs.existsSync(root)) continue;
    (function walk(p) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (!/\.(cjs|mjs|js)$/.test(e.name)) continue;
        /* 先剥注释再判：`/* … *\/`（可跨行）+ 行尾 `//` */
        const code = fs.readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/assertWritableLib\s*\(/.test(code) && !/function assertWritableLib/.test(code)) {
          hits.push(path.relative(REPO, f).replace(/\\/g, '/'));
        }
      }
    })(root);
  }
  return hits;
}
const sites = countCallSites();
A('★ assertWritableLib 有真实调用点（全仓 >0，且不是注释里的提及）', sites.length > 0, sites.join(' '));
A('该调用点就在写路径用例里（e2e-writepath.cjs）', sites.includes('tests/e2e-writepath.cjs'), sites.join(' '));

A('备份轮转放行是**有条件**的：冻结库上不放行',
  E.backupRotationAllowed(true) === false, 'backupRotationAllowed(true)=' + E.backupRotationAllowed(true));
A('备份轮转放行在副本库上仍然允许（否则会把正常写路径判红）',
  E.backupRotationAllowed(false) === true, 'backupRotationAllowed(false)=' + E.backupRotationAllowed(false));
const runSrc = fs.readFileSync(path.join(REPO, 'tests', 'run.mjs'), 'utf8');
A('run.mjs 真的用了这个判据（而不是自己再放行一次）',
  /E\.backupRotationAllowed\(/.test(runSrc), 'run.mjs 里找不到 E.backupRotationAllowed(');
A('run.mjs 里不再有"无条件把 _备份-真源 当派生"的旧写法',
  !/const isDerivedPath = rel => DERIVED_CACHE\.has\(rel\) \|\| isBackupPath\(rel\);/.test(runSrc),
  '仍是无条件放行 = E01-d 没修');
A('run.mjs 在 frozen 时会显式说明"本条不该出现"（可观察性，不是静默）',
  /本条本不该出现/.test(runSrc), '缺少冻结库上的告警文案');

/* 阴性自证（判据层面）：把判据换成"永远放行"，④ 里那条断言就会红 */
const oldAllow = () => true;
A('阴性自证 · 旧的"永远放行"判据会让上面那条断言变红',
  (oldAllow(true) === false) === false, '永远放行 = 冻结库备份被吃也全绿，正是本缺陷');

console.log('\n──────────────────────────────');
try { fs.rmSync(base, { recursive: true, force: true }); } catch { }
console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
process.exit(worst === 0 ? 0 : 1);
