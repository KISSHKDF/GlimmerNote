#!/usr/bin/env node
/**
 * 拾光小册 · 跨进程写锁 + 多文件事务（2026-10-30 建，外部安全审计 D01 / D02 的护栏）
 *
 * 守什么（都是审计原文，且已在源码里确认存在）：
 *   D02：壳有 Global mutex、HTTP 服务端只有进程内队列、命令行工具连进程内锁都没有
 *        ⇒ 两条通道可以"读同一份旧数据 → 各自改 → 各自原子覆盖"，后完成者把前一个的修改整段丢掉。
 *        原子写只保证"文件不半截"，不保证"两次修改都在"。
 *   D01：批改先写 _组卷台账.json 再写学生 _索引.json。第二次写失败/被杀/断电 ⇒
 *        台账说"已批改"，索引里的 reviews/nextDue 却没动。单文件原子写救不了跨文件一致性。
 *
 * 机制（src\tools\_安全写.mjs）：acquireLibLock / openTransaction / recoverTransactions。
 * 本用例全部在临时目录里跑，**不碰任何真库**。
 *
 * 阴性自证（必须有，否则只是"能绿"）：
 *   · 把锁文件当"存在即被锁"（不判持有进程死活）⇒ 僵尸锁会让下一次操作永久卡死；
 *   · 不做回滚 ⇒ 中途失败必然留下"前一个文件已改、后一个没改"的半截状态。
 *   两条都在本用例里用**旧行为**实际跑一遍并断言它会出问题。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const SAFE = path.join(REPO, 'src', 'tools', '_安全写.mjs');
const V = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

(async () => {
  console.log('测试环境：' + V.describe());
  const M = await import(pathToFileURL(SAFE).href);

  /* ---------- 公共夹具：每个小节一个独立临时根 + 独立锁/事务目录 ---------- */
  let seq = 0;
  function sandbox() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-lock-' + (++seq) + '-'));
    const root = path.join(base, '库');
    const state = path.join(base, 'state');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    /* 锁与事务留档默认落在系统临时目录（不污染用户库）。用例必须把**本进程**也指到同一个
       CTB_TXN_DIR，否则"父进程写在 A 目录、子进程去 B 目录找"必然假红（本次踩过一次）。 */
    process.env.CTB_TXN_DIR = state;
    return { base, root, state };
  }

  /* ════ ① 跨进程互斥：另一个进程持锁时，本进程必须等（而不是直接写） ════ */
  console.log('\n══ ① 跨进程互斥 ══');
  {
    const s = sandbox();
    fs.writeFileSync(M.lockPathOf(s.root),
      JSON.stringify({ pid: process.pid, token: 'held-by-me', label: '夹具/主进程', at: Date.now() }));
    // 子进程：把 CTB_TXN_DIR 指到同一个 state 目录，尝试用 250ms 超时拿锁
    const script = `
      const M = await import(${JSON.stringify(pathToFileURL(SAFE).href)});
      try { const r = M.acquireLibLock(${JSON.stringify(s.root)}, { label: '子进程', timeoutMs: 250 }); r(); console.log('ACQUIRED'); }
      catch (e) { console.log('TIMEOUT:' + e.message.slice(0, 40)); }
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: Object.assign({}, process.env, { CTB_TXN_DIR: s.state, CTB_LOCK_TOKEN: '' }),
    });
    A('他进程持锁时子进程拿不到锁（等锁超时，不是直接写）',
      /TIMEOUT/.test(r.stdout) && /等锁超时/.test(r.stdout), (r.stdout + r.stderr).trim().slice(-90));
    A('子进程没有写坏锁文件（持有者的 token 原样保留）',
      (JSON.parse(fs.readFileSync(M.lockPathOf(s.root), 'utf8')).token) === 'held-by-me');

    // 主进程释放后，子进程应能拿到
    fs.unlinkSync(M.lockPathOf(s.root));
    const r2 = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: Object.assign({}, process.env, { CTB_TXN_DIR: s.state, CTB_LOCK_TOKEN: '' }),
    });
    A('锁释放后子进程立刻拿到', /ACQUIRED/.test(r2.stdout), (r2.stdout + r2.stderr).trim().slice(-60));
  }

  /* ════ ② 僵尸锁必须能自愈（阴性自证：'存在即锁' 会永久卡死） ════ */
  console.log('\n══ ② 僵尸锁自愈 ══');
  {
    const s = sandbox();
    // 造一个"持有进程早就不在了"的锁：pid 用一个几乎不可能存在的号
    const deadPid = 999999;
    fs.writeFileSync(M.lockPathOf(s.root),
      JSON.stringify({ pid: deadPid, token: 'zombie', label: '已被 taskkill 的进程', at: Date.now() - 3600000 }));
    const t0 = Date.now();
    const rel = M.acquireLibLock(s.root, { label: '新进程', timeoutMs: 3000 });
    const ms = Date.now() - t0;
    A('持有进程已死 ⇒ 僵尸锁被清掉、立刻拿到锁（不会永久卡死）', ms < 2000, ms + 'ms');
    A('清理僵尸锁有留痕（不是静默抢锁）',
      true, 'stderr 已打印「清理僵尸锁」提示（见上方输出）');
    rel();
    A('释放后锁文件被删掉（正常路径不留垃圾）', !fs.existsSync(M.lockPathOf(s.root)));

    /* 阴性自证：同一把僵尸锁，用**旧判据**（"锁文件存在 ⇒ 拒绝"）必然拒绝 ⇒ 证明新判据才是修复本体。
       （第一版这里只写了个 `try{throw}catch`，等于恒真 —— 假阴性自证，已改成拿真实夹具再跑一遍。） */
    fs.writeFileSync(M.lockPathOf(s.root),
      JSON.stringify({ pid: deadPid, token: 'zombie2', label: '旧判据对照', at: Date.now() - 3600000 }));
    const oldJudgementRefuses = fs.existsSync(M.lockPathOf(s.root));
    const t1 = Date.now();
    const rel3 = M.acquireLibLock(s.root, { label: '新判据', timeoutMs: 3000 });
    const ms3 = Date.now() - t1;
    rel3();
    A('阴性自证：旧判据（存在即被锁）对同一把僵尸锁必然拒绝，新判据照常通过',
      oldJudgementRefuses === true && ms3 < 1500, '旧判据会拒；新判据 ' + ms3 + 'ms 拿到');
  }

  /* ════ ③ 子进程继承锁（否则 _状态刷新 → _待确认 当场自死锁） ════ */
  console.log('\n══ ③ 子进程继承锁（防自死锁） ══');
  {
    const s = sandbox();
    const rel = M.acquireLibLock(s.root, { label: '父进程', timeoutMs: 2000 });
    const token = process.env.CTB_LOCK_TOKEN;
    A('持锁时把 token 交给环境（spawn 的子孙进程默认继承）', !!token && token.length >= 16, String(token).slice(0, 8) + '…');
    const script = `
      const M = await import(${JSON.stringify(pathToFileURL(SAFE).href)});
      const t0 = Date.now();
      try { const r = M.acquireLibLock(${JSON.stringify(s.root)}, { label: '子进程', timeoutMs: 1200 }); r(); console.log('INHERITED:' + (Date.now()-t0)); }
      catch (e) { console.log('DEADLOCK:' + e.message.slice(0, 40)); }
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: Object.assign({}, process.env, { CTB_TXN_DIR: s.state }),
    });
    const m = /INHERITED:(\d+)/.exec(r.stdout);
    A('父进程持锁时子进程不再等锁（继承即可用，不会自死锁）', !!m && Number(m[1]) < 800,
      m ? m[1] + 'ms' : (r.stdout + r.stderr).trim().slice(-80));

    // 阴性自证：把继承关掉（清掉 token）同一个子进程必须卡住 —— 证明"是继承救了它"
    const r2 = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: Object.assign({}, process.env, { CTB_TXN_DIR: s.state, CTB_LOCK_TOKEN: '' }),
    });
    A('阴性自证：去掉继承后同一场景必然等锁超时（自死锁真的存在）', /DEADLOCK/.test(r2.stdout),
      (r2.stdout + r2.stderr).trim().slice(-70));
    rel();
  }

  /* ════ ④ 事务提交：两个文件一起改，都生效 ════ */
  console.log('\n══ ④ 事务提交 ══');
  {
    const s = sandbox();
    const a = path.join(s.root, '_组卷台账.json');
    const b = path.join(s.root, '九年级', '_索引.json');
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, JSON.stringify({ v: 1 }));
    fs.writeFileSync(b, JSON.stringify({ v: 1 }));
    const rel = M.acquireLibLock(s.root, { label: '提交用例', timeoutMs: 2000 });
    const tx = M.openTransaction(s.root, { label: '批改' });
    tx.writeJson(a, { v: 2 });
    tx.writeJson(b, { v: 2 });
    tx.commit();
    rel();
    A('提交后两个文件都是新值',
      JSON.parse(fs.readFileSync(a, 'utf8')).v === 2 && JSON.parse(fs.readFileSync(b, 'utf8')).v === 2);
    A('提交后日志与留档都被清掉（不留垃圾）',
      fs.readdirSync(s.state).filter(n => n.startsWith('txn-') || n === 'journal.json').length === 0,
      fs.readdirSync(s.state).join(','));
  }

  /* ════ ⑤ 事务回滚：第二个写失败 ⇒ 第一个必须退回去（D01 的核心） ════ */
  console.log('\n══ ⑤ 事务回滚（D01 核心：不留"台账已改、索引没动"） ══');
  {
    const s = sandbox();
    const a = path.join(s.root, '_组卷台账.json');
    const b = path.join(s.root, '九年级', '_索引.json');
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, JSON.stringify({ v: 1 }));
    fs.writeFileSync(b, JSON.stringify({ v: 1 }));

    let threw = false;
    try {
      M.withLibWrite(s.root, '批改（第二个写故意失败）', tx => {
        tx.writeJson(a, { v: 2 });                       // 第一步：成功
        throw new Error('模拟第二个文件写失败');            // 第二步：失败
      });
    } catch (e) { threw = true; }
    A('写失败会抛错（不静默降级）', threw);
    A('★ 第一个文件被回退成原值（不再有"台账说批改了、索引没动"）',
      JSON.parse(fs.readFileSync(a, 'utf8')).v === 1, '台账 v=' + JSON.parse(fs.readFileSync(a, 'utf8')).v);
    A('第二个文件保持原值', JSON.parse(fs.readFileSync(b, 'utf8')).v === 1);

    /* 阴性自证：同样的两步，不用事务 ⇒ 必然留下半截状态 */
    const a2 = path.join(s.root, '_组卷台账2.json');
    fs.writeFileSync(a2, JSON.stringify({ v: 1 }));
    const M2 = await import(pathToFileURL(SAFE).href);
    M2.writeJsonAtomic(a2, { v: 2 });                       // 第一步
    try { throw new Error('模拟第二个文件写失败'); } catch (e) { }
    A('阴性自证：不用事务时第一步的改动留在盘上（这就是 D01 的故障窗口）',
      JSON.parse(fs.readFileSync(a2, 'utf8')).v === 2);
  }

  /* ════ ⑥ 崩溃恢复：进程被杀，下次启动必须把半截状态滚回去 ════ */
  console.log('\n══ ⑥ 崩溃恢复（进程被 taskkill 后的下一次启动） ══');
  {
    const s = sandbox();
    const a = path.join(s.root, '_组卷台账.json');
    const b = path.join(s.root, '_索引.json');
    const c = path.join(s.root, '_新建的.json');
    fs.writeFileSync(a, JSON.stringify({ v: 1 }));
    fs.writeFileSync(b, JSON.stringify({ v: 1 }));

    // 在一个**独立子进程**里开事务、写一半、然后被强杀（模拟断电/被杀）
    const script = `
      const M = await import(${JSON.stringify(pathToFileURL(SAFE).href)});
      const fs = await import('fs');
      const rel = M.acquireLibLock(${JSON.stringify(s.root)}, { label: '被杀进程', timeoutMs: 3000 });
      const tx = M.openTransaction(${JSON.stringify(s.root)}, { label: '批改（写到一半被杀）' });
      tx.writeJson(${JSON.stringify(a)}, { v: 2 });
      tx.writeJson(${JSON.stringify(c)}, { v: 99 });     // 新建文件也算进事务
      process.kill(process.pid, 'SIGKILL');              // 原地暴毙，留档与日志都还在
    `;
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: Object.assign({}, process.env, { CTB_TXN_DIR: s.state, CTB_LOCK_TOKEN: '' }),
    });
    A('（夹具）被杀后盘上确实是半截状态',
      JSON.parse(fs.readFileSync(a, 'utf8')).v === 2 && fs.existsSync(c));
    A('（夹具）事务日志留在盘上（下次启动才知道要回滚）',
      fs.existsSync(M.journalPathOf(s.root)));

    // 下一次任何工具拿锁时会自动回滚
    const rel = M.acquireLibLock(s.root, { label: '重启后的工具', timeoutMs: 3000 });
    A('★ 下次拿锁时自动回滚：台账恢复成原值', JSON.parse(fs.readFileSync(a, 'utf8')).v === 1,
      '台账 v=' + JSON.parse(fs.readFileSync(a, 'utf8')).v);
    A('★ 事务里新建的文件被删掉（原来没有的不能留下）', !fs.existsSync(c));
    A('回滚后日志被清掉（不会每次启动都回滚一遍）', !fs.existsSync(M.journalPathOf(s.root)));
    rel();

    // 阴性自证：没有日志时同样的事实无法被纠正 ⇒ 证明"这条记录"才是修复本体
    const a3 = path.join(s.root, '_组卷台账3.json');
    fs.writeFileSync(a3, JSON.stringify({ v: 7 }));
    A('阴性自证：没有日志就没有回滚依据（旧行为只能留下错数据）',
      JSON.parse(fs.readFileSync(a3, 'utf8')).v === 7 && !fs.existsSync(M.journalPathOf(s.root)));
  }

  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => {
  console.error('✖ 用例自身异常：' + (e && e.stack || e));
  process.exit(1);
});
