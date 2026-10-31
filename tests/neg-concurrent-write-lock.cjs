#!/usr/bin/env node
/**
 * 拾光小册 · 并发写回归（2026-10-30 建，外部安全审计 D02 的端到端护栏）
 *
 * 守什么（审计原文 D02，已复现）：
 *   壳有自己的 Global mutex，HTTP 服务端只有**进程内**队列，命令行工具连进程内锁都没有
 *   ⇒ 两条通道可以"读同一份旧数据 → 各自改 → 各自原子覆盖"，**后完成的把前一个的修改整段丢掉**。
 *   原子写只保证"文件不半截"，完全不保证"两次修改都在"。
 *
 * 本用例用**真工具**（`_标记复习.mjs 组卷`）跑并发，不是纯函数模拟：
 *   ① 6 个进程同时组卷、共用同一把锁 ⇒ 6 条批次全在台账里、批次号不撞；
 *   ② 阴性自证：把它们各指一处锁目录（= 等于没有公共锁）⇒ 必然丢更新。第②条是真跑的，
 *      不是"心里知道会丢"——没有它，本用例只是"能绿"。
 *
 * 为什么判据是"批次条数 == 进程数"：丢更新的表现就是进程全报成功、台账少几条。
 * 第一次写这条用例时就靠它抓到锁自身的抢锁竞态（空锁文件被当残留抢走），已修。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const E = require('./_测试环境.cjs');
const REPO = E.REPO;
const FIX = path.join(REPO, 'fixtures', '库-形状');
const N = 6;

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

function mkLib(tag) {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-conc-' + tag + '-')), '库');
  fs.cpSync(FIX, d, { recursive: true });
  return d;
}
function runOne(lib, lockDir) {
  return new Promise(res => {
    const p = spawn(process.execPath, [path.join(REPO, 'src', 'tools', '_标记复习.mjs'),
      '组卷', '--student', '学生甲', '--ids', 'C0101,C0102', '--subject', '数学',
      '--no-repeat-days', '0', '--date', '2026-10-30', '--force'],
    { cwd: REPO, env: Object.assign({}, process.env, { CTB_DATA: lib, CTB_TXN_DIR: lockDir, CTB_LOCK_TOKEN: '' }) });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => res({ code, out, err }));
  });
}
const ledgerOf = lib => JSON.parse(fs.readFileSync(path.join(lib, '_组卷台账.json'), 'utf8'));

(async () => {
  console.log('测试环境：' + E.describe());
  A('夹具库存在（fixtures\\库-形状）', fs.existsSync(FIX), FIX);

  const libA = mkLib('a');
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-lockdir-'));
  const before = ledgerOf(libA).batches.length;
  const rs = await Promise.all(Array.from({ length: N }, () => runOne(libA, shared)));
  const after = ledgerOf(libA).batches;
  const okN = rs.filter(r => r.code === 0).length;
  const newIds = after.slice(before).map(b => b.paperId);
  const dup = newIds.filter((x, i) => newIds.indexOf(x) !== i);

  console.log('\n══ ① 6 个进程同时组卷（共用一把库级写锁）══');
  console.log('  成功进程 ' + okN + '/' + N + '，新增批次 ' + newIds.length + ' 条：' + newIds.join(','));
  A('所有进程都成功退出（锁不会让人失败，只是排队）', okN === N, okN + '/' + N);
  A('★ 每个进程的修改都留在台账里（无丢更新）', newIds.length === N, newIds.length + '/' + N);
  A('★ 批次号不撞（读改写确实在锁内完成）', dup.length === 0, '撞号 ' + dup.length + ' 个');
  A('锁用完即删（不留锁文件占着，否则下次全卡死）',
    !fs.existsSync(path.join(shared, require('crypto').createHash('sha1')
      .update(libA.toLowerCase()).digest('hex').slice(0, 16), 'lock')),
    '目录 ' + fs.readdirSync(shared).join(','));

  /* ---------- ② 阴性自证：拿掉公共锁 ---------- */
  const libB = mkLib('b');
  const beforeB = ledgerOf(libB).batches.length;
  const rs2 = await Promise.all(Array.from({ length: N }, (_, i) => {
    const s = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-nolock-' + i + '-')), 'state');
    fs.mkdirSync(s, { recursive: true });
    return runOne(libB, s);
  }));
  const afterB = ledgerOf(libB).batches;
  const okN2 = rs2.filter(r => r.code === 0).length;
  const newIdsB = afterB.slice(beforeB).map(b => b.paperId);
  console.log('\n══ ② 阴性自证：各用各的锁目录（等价于修复前"没有公共锁"）══');
  console.log('  成功进程 ' + okN2 + '/' + N + '，新增批次 ' + newIdsB.length + ' 条');
  A('没有公共锁时确实丢更新（进程都说成功、台账少几条）', newIdsB.length < N,
    newIdsB.length + '/' + N + ' 条留存 = 丢了 ' + (N - newIdsB.length) + ' 条');

  for (const d of [libA, libB, shared]) { try { fs.rmSync(path.dirname(d) === path.dirname(libA) ? path.dirname(d) : d, { recursive: true, force: true }); } catch { } }

  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => { console.error('✖ 用例自身异常：' + (e && e.stack || e)); process.exit(1); });
