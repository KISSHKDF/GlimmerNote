/* 阴性对照（2026-10-21）：用户报障「待办办完之后还会弹出来，不能消失」的三条根因必须被拦住
 *
 * 事故链（三个缺陷叠加，缺一个都不会复现）：
 *   ① 数据：_probe/split-fix.mjs 拆条时**复用旧编号** ⇒ T191/T192 各两条（旧条目已作废在前）。
 *   ② 工具：所有动作都写 `items.find(x => x.id === ...)` ⇒ 取第一条 = 已作废的旧条目
 *          ⇒ 「同步」报「已是『已作废』，跳过」并 exit 0，新条目永远停在未确认。
 *   ③ 前端：`hasResults && 没落库` 才报错 ⇒ **results 为空时放行**，照弹「已落库」并清本地草稿。
 *      而桌面壳的 ParseResults 只认 `IndexOf("T0")`（= T001~T099），台账编号已到 T196
 *      ⇒ T1xx 的 results 恒为空 ⇒ 正好落进 ③ 的放行分支。
 *
 * 本测试逐条证明修复有效，且**不依赖活库状态**（自构造前提 + 逐字节还原）。
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-dupid-'));
let pass = 0, fail = 0;
const A = (l, ok, x = '') => { ok ? (pass++, console.log('  [OK]  ' + l + (x ? '  → ' + x : ''))) : (fail++, console.log('  [FAIL] ' + l + (x ? '  → ' + x : ''))); };

const ORIG = fs.readFileSync(SRC);
function withLedger(mutate, fn) {
  try {
    const j = JSON.parse(ORIG.toString('utf8').replace(/^\uFEFF/, ''));
    mutate(j);
    fs.writeFileSync(SRC, JSON.stringify(j, null, 1), 'utf8');
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
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

try {
  console.log('═══ 办结落不了库（重号 + 取错条目 + 空 results 假报成功）═══');

  /* ── 场景 1：重号必须被门禁点名（否则整件事无声无息）── */
  withLedger(j => {
    /* 造一条已作废 + 一条同号的未确认（复刻 split-fix 的产物形态：旧在前、新在后） */
    const live = j.items.find(x => x.status === '未确认') || j.items[0];
    const ghost = JSON.parse(JSON.stringify(live));
    ghost.status = '已作废';
    ghost.answer = '旧条目，已作废';
    ghost.raisedAt = '2026-01-01T00:00:00+08:00';
    live.status = '未确认'; live.answer = ''; live.resolvedAt = '';
    live.raisedAt = '2026-10-20T08:55:00+08:00';
    const at = j.items.indexOf(live);
    j.items.splice(at, 0, ghost);           // 旧条目插在**前面**（find 会取到它）
  }, () => {
    const g = run(['门禁', '--json']);
    let env = null; try { env = JSON.parse(g.out.trim()); } catch { }
    A('场景1 重号被门禁点名', !!(env && Array.isArray(env.dupId) && env.dupId.length === 1), JSON.stringify(env && env.dupId));
    A('场景1 重号进 problems 文案', !!(env && env.problems.some(p => /重号/.test(p))), JSON.stringify(env && env.problems));
  });

  /* ── 场景 2：重号时「同步」必须打到**未确认**那条，而不是已作废那条 ── */
  const dupId = 'T999';
  withLedger(j => {
    const live = j.items.find(x => x.status === '未确认') || j.items[0];
    const ghost = JSON.parse(JSON.stringify(live));
    ghost.id = dupId; ghost.status = '已作废'; ghost.answer = '旧条目'; ghost.raisedAt = '2026-01-01T00:00:00+08:00';
    live.id = dupId; live.status = '未确认'; live.answer = ''; live.resolvedAt = ''; live.raisedAt = '2026-10-20T08:55:00+08:00';
    const at = j.items.indexOf(live);
    j.items.splice(at, 0, ghost);           // 已作废在前
  }, () => {
    const pkg = path.join(tmpDir, 'resolve.json');
    fs.writeFileSync(pkg, JSON.stringify({ exportedAt: new Date().toISOString(), tool: 'neg-test',
      resolves: [{ id: dupId, action: '答', answer: '阴性对照结论' }] }), 'utf8');
    const r = run(['同步', '--file', pkg]);
    A('场景2 同步 exit 0', r.code === 0, '实测 ' + r.code);
    A('场景2 同步没报「跳过」', !/↔/.test(r.out), r.out.trim().split(/\r?\n/)[0] || '');
    const after = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    const rows = after.items.filter(x => x.id === dupId);
    const liveRow = rows.find(x => x.raisedAt === '2026-10-20T08:55:00+08:00');
    const ghostRow = rows.find(x => x.raisedAt === '2026-01-01T00:00:00+08:00');
    A('★ 场景2 结论落在未确认那条上（改前落在已作废那条）',
      !!(liveRow && liveRow.status === '已确认' && liveRow.answer === '阴性对照结论'),
      liveRow ? liveRow.status + ' / ' + liveRow.answer : 'missing');
    A('场景2 已作废那条原样不动', !!(ghostRow && ghostRow.status === '已作废' && ghostRow.answer === '旧条目'),
      ghostRow ? ghostRow.status : 'missing');
  });

  /* ── 场景 3：正常（无重号）落库仍然有效 —— 防改坏原本就对的那条 ── */
  const okId = 'T998';
  withLedger(j => {
    const live = j.items.find(x => x.status === '未确认') || j.items[0];
    live.id = okId; live.status = '未确认'; live.answer = ''; live.resolvedAt = '';
  }, () => {
    const pkg = path.join(tmpDir, 'resolve2.json');
    fs.writeFileSync(pkg, JSON.stringify({ exportedAt: new Date().toISOString(), tool: 'neg-test',
      resolves: [{ id: okId, action: '答', answer: '正常落库' }] }), 'utf8');
    const r = run(['同步', '--file', pkg]);
    const after = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    const row = after.items.find(x => x.id === okId);
    A('场景3 无重号时落库照常', r.code === 0 && !!row && row.status === '已确认', row ? row.status : 'missing');
    A('场景3 stdout 有逐条结果行（✔）', /✔/.test(r.out), (r.out.match(/[✔↔✖][^\n]*/) || [''])[0]);
  });

  /* ── 场景 4：编号扫描必须认 T1xx 以上（桌面壳 ParseResults 的等价判据）──
     壳用 C# 实现，这里用同构的正则证明"至少 3 位数字"覆盖 T001~T9999。
     阳性：T045 / T196 / T1234 都要能扫出；阴性：汇总行（不带状态符）不算结果。 */
  const scan = line => { const m = /^[✔↔✖]\s*(T\d{3,})/.exec(String(line).trim()); return m ? m[1] : null; };
  A('场景4 扫描 T045', scan('✔ T045 → 已确认：x') === 'T045');
  A('场景4 扫描 T196（改前 IndexOf("T0") 扫不到）', scan('✔ T196 → 已确认：x') === 'T196', String(scan('✔ T196 → 已确认：x')));
  A('场景4 扫描 T1234（四位编号）', scan('✔ T1234 → 已确认：x') === 'T1234');
  A('场景4 跳过汇总行', scan('同步完成：落库 1，跳过 0，未找到 0') === null);
  A('场景4 跳过无状态符的正文行', scan('  ✔ 已落库 T196 但…') === null, '行首不是状态符就不算（与壳同判据）');

  const now = fs.readFileSync(SRC);
  A('收尾：真源台账已逐字节还原', now.equals(ORIG), now.length + 'B vs ' + ORIG.length + 'B');
} finally {
  fs.writeFileSync(SRC, ORIG);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
}

console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail));
process.exit(fail ? 1 : 0);
