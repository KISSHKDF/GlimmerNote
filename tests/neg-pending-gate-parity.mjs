/* 阴性对照 BUG-02：证明 门禁 --json 与人类模式现在**同码同判**
 * 手法：把 _待确认.json 原样备份 → 按场景改写内存副本落盘 → 两种模式各跑一遍比对退出码 →
 *       finally 逐字节还原（绝不留在坏状态）。
 * ⚠ 2026-10-16 修（本次三缺陷排查连带）：旧版三个前提写死在"86 条全闭环"的旧库上——
 *   场景1 注释说"无待确认"却**没构造**该前提（活库 95 条未确认时它必然 exit 1）；
 *   场景2 断言 noVerdict.length===1（活库本就有 5 条已答未判定时变 6）；
 *   收尾断言写死 "86 条、0 未确认"。现全部改为**自构造前提 + 逐字节还原断言**，
 *   测试不再依赖活库状态。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const E = require('./_测试环境.cjs');
import { spawnSync } from 'child_process';

/* ★ 2026-10-23 搬进开发区时的护栏（原为写死的真库绝对路径）：
   本文件会**覆盖 _待确认.json 再逐字节还原**。写死路径意味着在开发区跑门禁
   = 去改冻结区的用户真源；中途被杀就留下坏台账。所以：① ROOT 从自身位置上溯；
   ② 显式拒绝任何指向「错题本」冻结区的路径（宁可红，不可写）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (/(^|[\\/])错题本([\\/]|$)/.test(ROOT)) {
  console.error('✖ 拒绝运行：ROOT 指向冻结区 → ' + ROOT + '（本测试会改写台账真源）');
  process.exit(2);
}
/* ★ 2026-10-23：本文件会**改写台账再逐字节还原**，所以绝不能跑在真库上。
   用 makeTempLib() 复制一份（只含台账与索引，不含影像），跑完删掉临时目录。 */
/* 写盘目标是**临时副本**，不是真库；再兜一道：临时库绝不能落在冻结区。 */
const LIB = E.makeTempLib();
if (E.isFrozen(LIB)) throw new Error('临时库不该在冻结区：' + LIB);
if (E.isFrozen(path.join(LIB, '_待确认.json'))) throw new Error('写盘目标指向冻结区');
const TOOL = E.tool('_待确认.mjs');
const SRC = path.join(LIB, '_待确认.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-pending-'));
const tmpDB = path.join(tmpDir, '_待确认.json');
let pass = 0, fail = 0;
const A = (l, ok, x = '') => { ok ? (pass++, console.log('  [OK]  ' + l + (x ? '  → ' + x : ''))) : (fail++, console.log('  [FAIL] ' + l + (x ? '  → ' + x : ''))); };

/* 用改写后的副本覆盖真实台账 → 跑 → 还原（finally 兜底，绝不留在坏状态） */
const ORIG = fs.readFileSync(SRC);
function withLedger(mutate, fn) {
  try {
    const j = JSON.parse(ORIG.toString('utf8').replace(/^\uFEFF/, ''));
    mutate(j);
    fs.writeFileSync(SRC, JSON.stringify(j, null, 2), 'utf8');
    return fn();
  } finally {
    fs.writeFileSync(SRC, ORIG);          // 逐字节还原
  }
}
const run = args => {
  /* 必须显式传 CTB_DATA=LIB，否则工具会去猜库根 → 读的是真库，改的也是真库 */
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8', maxBuffer: 64e6,
    env: Object.assign({}, process.env, { CTB_DATA: LIB }),
  });
  return { code: r.status, out: r.stdout || '' };
};
/* 构造"全闭环"库：所有条目 作废（pend=0、doneAll=0 ⇒ 门禁唯一绿态） */
const allClosed = j => { for (const it of j.items) it.status = '已作废'; };
/* 构造"闭环整齐"库：已确认条目全部补齐 verdict/disposition */
const allDecided = j => { for (const it of j.items) if (it.status === '已确认') { it.verdict = it.verdict || '对'; it.disposition = it.disposition || '无需处置'; } };

try {
  console.log('═══ BUG-02 门禁 --json 与人类模式退出码必须一致 ═══');

  /* 场景 1：无待确认、且闭环完整 ⇒ 两种模式都应 exit 0 */
  withLedger(allClosed, () => {
    const h = run(['门禁']), j = run(['门禁', '--json']);
    A('场景1 闭环完整：人类 exit 0', h.code === 0, '实测 ' + h.code);
    A('场景1 闭环完整：机器 exit 0', j.code === 0, '实测 ' + j.code);
    A('场景1 两种模式同码', h.code === j.code);
    const env = JSON.parse(j.out.trim());
    A('场景1 机器通道 ok=true', env.ok === true, 'ok=' + env.ok);
  });

  /* 场景 2：待确认已清空、恰好一条「已确认」缺 verdict/disposition ⇒ 两种模式都必须 exit 1 */
  withLedger(j => {
    const t = j.items.find(x => x.status === '已确认');
    if (!t) throw new Error('台账里没有已确认条目，构造不了场景');
    allDecided(j);                                 // 存量已确认条目全部补齐（隔离活库欠账）
    allClosed(j);                                  // 清掉未确认（本场景只看闭环缺口）
    t.status = '已确认';                           // 恢复这一条为已确认（allClosed 会波及它）
    t.verdict = ''; t.disposition = '';            // 制造恰好一条闭环缺口
  }, () => {
    const h = run(['门禁']), j = run(['门禁', '--json']);
    console.log('    人类模式末行：' + h.out.trim().split(/\r?\n/).slice(-1)[0]);
    A('场景2 闭环缺口：人类 exit 1', h.code === 1, '实测 ' + h.code);
    A('场景2 闭环缺口：机器 exit 1（改前是 0 = 假绿灯）', j.code === 1, '实测 ' + j.code);
    A('★ 场景2 两种模式同码同判', h.code === j.code && h.code === 1);
    const env = JSON.parse(j.out.trim());
    A('场景2 机器通道 ok=false 且点名原因', env.ok === false && env.problems.some(p => /闭环未完成/.test(p)),
      JSON.stringify(env.problems));
    A('场景2 机器通道点名了具体条目', Array.isArray(env.noVerdict) && env.noVerdict.length === 1, JSON.stringify(env.noVerdict));
  });

  /* 场景 3：仍有未确认项 ⇒ 两种模式都 exit 1（回归，防改坏原本就对的那条） */
  withLedger(j => {
    const t = j.items[0];
    t.status = '未确认'; t.answer = ''; t.resolvedAt = ''; t.verdict = ''; t.disposition = '';
  }, () => {
    const h = run(['门禁']), j = run(['门禁', '--json']);
    A('场景3 有待确认：人类 exit 1', h.code === 1, '实测 ' + h.code);
    A('场景3 有待确认：机器 exit 1', j.code === 1, '实测 ' + j.code);
    A('场景3 两种模式同码', h.code === j.code);
  });

  /* 收尾自证：真源已逐字节还原（不再写死条数——活库条数会随业务增长） */
  const now = fs.readFileSync(SRC);
  A('收尾：真源台账已逐字节还原', now.equals(ORIG), now.length + 'B vs ' + ORIG.length + 'B');
} finally {
  fs.writeFileSync(SRC, ORIG);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
}

console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail));
process.exit(fail ? 1 : 0);
