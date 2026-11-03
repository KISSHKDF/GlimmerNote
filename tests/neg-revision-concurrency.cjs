/* 拾光小册 · 批次 4 幂等/并发对抗钻孔（Lead 亲自做的那一条，固化成常驻用例）
 *
 * 验收原文（施工方案 §6 批次 4）：「双击/重试/并发不重复建卡；故障后状态一致」。
 * 为什么不能只证"串行幂等"：串行幂等靠的是**读到状态**；并发靠的是**锁 + 读到已更新状态**，
 *   两者是两套机制。真正会出事的是"两个进程同时进来、都读到 待采用"。
 *
 * 判据（全部真跑真并发，不是 mock）：
 *   ① 6 个进程**同时**采用同一候选 ⇒ 恰好一次"真写入"，其余全部走幂等分支；
 *      `_修订\<kind>\<目标>\<candId>.md` 只存在一份且内容正确；
 *      `revisions[]` 恰好 1 条；候选状态恰好 已采用。
 *   ② 两个进程同时登记**同一条**候选 ⇒ 同一个 candId，候选只 1 条（稳定 ID 幂等）。
 *   ③ 双击式串行重试（同一 candId 连点 3 次）⇒ 仍是 1 条 revision、内容不变。
 *   ④ 故障后状态一致：把一个写的落点作成障碍（`_修订` 变成文件）⇒ 整体失败 + 台账逐字节不变
 *      + 候选仍 待采用 + revisions 仍 0 条（事务真的回滚了）。
 *
 * 只写 %TEMP% 夹具；真库零写入。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const E = require('./_测试环境.cjs');
const ROOT = E.REPO;
const TOOL = E.tool('_待确认.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? '  → ' + detail : ''));
  ok ? pass++ : fail++;
};
const LIB = E.allocTempDir('gn-revconc-');
const env = Object.assign({}, process.env, { CTB_DATA: LIB, CTB_TXN_DIR: path.join(LIB, '_txn') });

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TOOL, ...args], { cwd: ROOT, env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
/* `--json` 的人读行仍打在 stdout 上（JSON 在**最后一行**）⇒ 不许 JSON.parse 整段 stdout。
   这条偏差已登记（与 `_原图.mjs` 的"`--json` 时人读走 stderr"不同口径）；界面侧同样按最后一行解析。 */
const lastJson = (out) => {
  const lines = String(out || '').split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('{')) { try { return JSON.parse(t); } catch { /* 往前找 */ } }
  }
  return null;
};
const ledger = () => JSON.parse(fs.readFileSync(path.join(LIB, '_待确认.json'), 'utf8'));
const item = () => ledger().items.find((x) => x.id === 'T001');
function snap(dir) {
  const m = new Map();
  (function walk(d, rel) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (/^_备份-真源/.test(r) || /^_txn/.test(r)) continue;   // 写前留档/锁留档：按口径排除
      if (e.isDirectory()) walk(full, r); else { try { m.set(r, sha(full)); } catch { } }
    }
  })(dir, '');
  return m;
}
const diff = (a, b) => {
  const o = [];
  for (const [k, v] of a) if (!b.has(k)) o.push('消失:' + k); else if (b.get(k) !== v) o.push('变了:' + k);
  for (const k of b.keys()) if (!a.has(k)) o.push('新增:' + k);
  return o;
};

(async () => {
  console.log('夹具库：' + LIB);
  /* 最小库 + 一条待办（`_待确认.mjs` 只认 CTB_DATA，靠 env 指到夹具） */
  fs.mkdirSync(path.join(LIB, '学生A', '数学', 'P0001-合成卡'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '学生A', '数学', 'P0001-合成卡', '错题记录.md'), '# 合成卡\n\n第3题按人教版判。\n', 'utf8');
  fs.writeFileSync(path.join(LIB, '_待确认.json'), JSON.stringify({
    note: '夹具', seq: 1, items: [{
      id: 'T001', student: '学生A', subject: '数学', cardId: 'P0001', kind: '口径确认', ask: '老师',
      q: '判罚口径按哪版教材？', detail: '夹具', status: '未确认', raisedAt: '2026-11-03',
    }],
  }, null, 1), 'utf8');

  const PAYLOAD = '把判罚口径改成按人教版（第3题）';
  /* ═══ ② 并发登记同一条候选 ⇒ 同一个 candId，只 1 条 ═══ */
  {
    const rs = await Promise.all([1, 2, 3, 4].map(() => run(['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0001', '--payload', PAYLOAD, '--json'])));
    const bad = rs.filter((r) => r.code !== 0);
    const cands = (item().candidates || []);
    const ids = new Set(rs.map((r) => (lastJson(r.out) || {}).candId).filter(Boolean));
    A('②4 个进程同时登记同一条候选 ⇒ 全部 exit 0', bad.length === 0, '非零 ' + bad.length + ' 个：' + bad.map((b) => b.code + ' ' + b.err.trim().split('\n')[0]).join(' | '));
    A('②★ 候选只有 1 条、四个进程拿到**同一个** candId（稳定 ID 幂等）',
      cands.length === 1 && ids.size === 1 && ids.has(cands[0].candId),
      '候选数=' + cands.length + ' candId 集合=' + [...ids].join(',') + ' 台账里=' + cands.map((c) => c.candId).join(','));
  }
  const CAND = item().candidates[0].candId;

  /* ═══ ① 6 个进程同时采用同一候选 ═══ */
  {
    const before = snap(LIB);
    const rs = await Promise.all([0, 1, 2, 3, 4, 5].map(() => run(['采用', '--id', 'T001', '--candidate', CAND, '--json'])));
    const zero = rs.filter((r) => r.code === 0).length;
    const idem = rs.filter((r) => (lastJson(r.out) || {}).idempotent === true).length;
    const real = rs.filter((r) => (lastJson(r.out) || {}).idempotent === false).length;
    const it = item();
    const revs = it.revisions || [];
    const rel = path.join(LIB, '_修订', '卡', 'P0001', CAND + '.md');
    const d = diff(before, snap(LIB));
    A('①a 6 个进程全部 exit 0（没有"抢锁失败"这种半成功）', zero === 6, 'exit 分布=' + JSON.stringify(rs.map((r) => r.code)));
    A('①b ★恰好 **1** 个走真写入、其余 5 个走幂等分支（并发不重复建卡）',
      real === 1 && idem === 5, '真写入=' + real + ' 幂等=' + idem);
    A('①c ★修订对象只有 1 份，内容 = 候选正文（头部元信息 + 正文）',
      fs.existsSync(rel) && fs.readFileSync(rel, 'utf8').includes(PAYLOAD),
      fs.existsSync(rel) ? fs.statSync(rel).size + 'B' : '不存在');
    A('①d ★`revisions[]` 恰好 1 条（append-only 没被并发写重）', revs.length === 1,
      '条数=' + revs.length + ' written=' + JSON.stringify(revs[0] && revs[0].written));
    A('①e 候选状态 = 已采用（只翻转一次）', it.candidates[0].status === '已采用', it.candidates[0].status + ' @' + it.candidates[0].adoptedAt);
    A('①f 全树差异 = 恰好"新增的那几件"（修订对象 + `_待确认.json` 变更，无半截文件）',
      d.filter((x) => !/^新增:_修订\/卡\/P0001\//.test(x) && x !== '变了:_待确认.json').length === 0,
      d.join('、'));
  }

  /* ═══ ③ 双击式串行重试 ═══ */
  {
    const before = snap(LIB);
    for (let i = 0; i < 3; i++) await run(['采用', '--id', 'T001', '--candidate', CAND, '--json']);
    const it = item();
    A('③连点 3 次 ⇒ revision 仍 1 条、修订对象字节不变（幂等且不重写）',
      (it.revisions || []).length === 1 && diff(before, snap(LIB)).length === 0,
      diff(before, snap(LIB)).join('、') || '零差异');
  }

  /* ═══ ④ 故障后状态一致（事务回滚）═══ */
  {
    /* 造一条新候选，然后把 `_修订` 落点做成障碍：用**文件**占住 `_修订` 这个名字 ⇒ ENOTDIR ⇒ 事务必须整体失败 */
    await run(['候选', '--id', 'T001', '--kind', '卡', '--target', 'P0001', '--payload', '第二条：按苏科版', '--json']);
    const it2 = item();
    const c2 = it2.candidates.find((c) => c.status === '待采用');
    A('④前置：第二条候选已登记且待采用', !!c2, c2 ? c2.candId : '（无）');
    const revDir = path.join(LIB, '_修订');
    const stash = path.join(LIB, '_修订.stash');
    fs.renameSync(revDir, stash);
    fs.writeFileSync(revDir, '障碍：把 _修订 做成文件', 'utf8');   // ENOTDIR
    const before = snap(LIB);
    const r = await run(['采用', '--id', 'T001', '--candidate', c2.candId, '--json']);
    const after = snap(LIB);
    const d = diff(before, after);
    const it3 = item();
    const c3 = it3.candidates.find((c) => c.candId === c2.candId);
    A('④a 落点被障碍占住 ⇒ 非 0 退出（不静默成功）', r.code !== 0, 'exit=' + r.code + ' ' + (r.err || '').trim().split('\n')[0]);
    A('④b ★故障后台账逐字节一致：候选仍「待采用」、revisions 仍 1 条（事务整体回滚）',
      c3.status === '待采用' && (it3.revisions || []).length === 1,
      '候选状态=' + c3.status + ' revisions=' + (it3.revisions || []).length);
    A('④c 全树差异恰好 1 份"写前留档"（除留档外没有任何半截）',
      d.filter((x) => !/新增:_备份-真源\//.test(x)).length === 0, d.join('、'));
    fs.rmSync(revDir, { force: true });
    fs.renameSync(stash, revDir);
    /* 故障排除后重试必须成功（幂等 + 可续跑） */
    const r2 = await run(['采用', '--id', 'T001', '--candidate', c2.candId, '--json']);
    A('④d 障碍排除后重试成功，revisions 变 2 条', r2.code === 0 && (item().revisions || []).length === 2,
      'exit=' + r2.code + ' revisions=' + (item().revisions || []).length);
  }

  console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
  process.exit(fail ? 1 : 0);
})();
