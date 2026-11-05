#!/usr/bin/env node
/**
 * 拾光小册 · 写锁旧布局迁移 / 启动时间缓存 回归（2026-11-05 建，合并评审 P0-1 / P0-2 / P1-2 / P1-3 / P2-5 的护栏）
 *
 * 守四件事（每件都带阴性自证：把修法掏掉，判据必须变红）：
 *
 *  P0-2 迁移殃及别的库：
 *    修前迁移完 `rmSync(%TEMP%\glimmernote-write-state, recursive)`，删的是**整个旧父目录**，
 *    别的库（key 不同）还没迁、也没回滚的 journal.json 一起被删。
 *    判据：迁移库 A 之后，库 B 的旧 journal 仍在；库 A 自己的旧目录被清掉。
 *
 *  P0-1 没持锁就回滚：
 *    修前迁移写在 stateDirOf() 里，只读探针 lockPathOf() 都会触发回滚（往库里写）。
 *    判据：lockPathOf() 之后旧事务**原样**未回滚；acquireLibLock() 之后才回滚。
 *
 *  P2-5 旧日志属于活进程（可能是还在跑的旧版本工具）：不得回滚、不得删。
 *
 *  P1-2 / P1-3 启动时间：
 *    · 别的 PID 一旦被观察到死亡，缓存必须作废（修前永不失效 ⇒ PID 复用被当成原持有者）；
 *    · 查不到启动时间时锁里写 0，绝不用 Date.now() 冒充（源码级）。
 *
 * 用法：node tests\neg-lock-migration-and-cache.cjs
 * 退出码：0=PASS（含阴性自证）/ 1=FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const E = require('./_测试环境.cjs');
const SRC = path.join(E.REPO, 'src', 'tools', '_安全写.mjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}
const mkTmp = tag => fs.mkdtempSync(path.join(os.tmpdir(), 'gn-mig-' + tag + '-'));
const keyOf = root => crypto.createHash('sha1').update(String(root).toLowerCase()).digest('hex').slice(0, 16);
const DEAD_PID = 999999;    // 远超常见 pid_max 的值，视为"已死"

/** 在旧布局里造一份"未完成事务"：目标文件现值 NEW，留档是 OLD；日志的 pid 可指定 */
function plantLegacyTxn(legacyBase, root, pid) {
  const dir = path.join(legacyBase, 'glimmernote-write-state', keyOf(root));
  const snapDir = path.join(dir, 'txn-legacy');
  fs.mkdirSync(snapDir, { recursive: true });
  const target = path.join(root, '_状态.json');
  fs.writeFileSync(target, 'NEW');
  const snap = path.join(snapDir, '0001-_状态.json');
  fs.writeFileSync(snap, 'OLD');
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify({
    txId: 'legacy', label: 'legacy-sim', pid, startedAt: new Date().toISOString(), dir: snapDir,
    entries: [{ file: target, snap }],
  }));
  return { dir, target };
}

/** 跑一个子进程：import 指定的 _安全写 源（可以是变异副本），执行 body */
function runChild(modUrl, env, body) {
  const code = `import(${JSON.stringify(modUrl)}).then(async m => { ${body} }).catch(e => { console.log(JSON.stringify({ err: String(e && e.message) })); });`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, ...env } });
  const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
  try { return JSON.parse(line); } catch { return { err: 'bad output: ' + line + ' / ' + r.stderr }; }
}

/** 一轮完整场景：库 A、库 B 各有一份旧事务（都属死进程）；先探针、再对 A 取锁。返回观测值 */
function scenario(modUrl) {
  const legacyBase = mkTmp('legacy');
  const txnDir = mkTmp('txn');
  const rootA = mkTmp('libA'), rootB = mkTmp('libB');
  const a = plantLegacyTxn(legacyBase, rootA, DEAD_PID);
  const b = plantLegacyTxn(legacyBase, rootB, DEAD_PID);
  const env = { CTB_LEGACY_TXN_BASE: legacyBase, CTB_TXN_DIR: txnDir, CTB_LOCK_TOKEN: '' };
  const probe = runChild(modUrl, env, `m.lockPathOf(${JSON.stringify(rootA)}); console.log(JSON.stringify({ ok: 1 }));`);
  const afterProbeA = fs.readFileSync(a.target, 'utf8');
  const afterProbeLegacyA = fs.existsSync(path.join(a.dir, 'journal.json'));
  const acq = runChild(modUrl, env, `const rel = m.acquireLibLock(${JSON.stringify(rootA)}, { label: 't', timeoutMs: 5000 }); rel(); console.log(JSON.stringify({ ok: 1 }));`);
  const out = {
    probe, acq, afterProbeA, afterProbeLegacyA,
    afterAcqA: fs.readFileSync(a.target, 'utf8'),
    legacyADirGone: !fs.existsSync(a.dir),
    legacyBJournal: fs.existsSync(path.join(b.dir, 'journal.json')),
    libBUntouched: fs.readFileSync(b.target, 'utf8') === 'NEW',
  };
  for (const d of [legacyBase, txnDir, rootA, rootB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  return out;
}

(async () => {
  /* ══════════ ① P0-1 / P0-2：真源跑一遍 ══════════ */
  console.log('\n══ ① 旧布局迁移：只在持锁后、只动本库 ══');
  const ok = scenario(pathToFileURL(SRC).href);
  A('探针 lockPathOf() 不触发回滚（目标仍是 NEW）', ok.afterProbeA === 'NEW' && ok.afterProbeLegacyA, 'A=' + ok.afterProbeA + ' 旧日志在=' + ok.afterProbeLegacyA);
  A('取锁之后才回滚旧事务（目标恢复为 OLD）', ok.afterAcqA === 'OLD', 'A=' + ok.afterAcqA + (ok.acq.err ? ' err=' + ok.acq.err : ''));
  A('本库自己的旧目录迁移后被清掉', ok.legacyADirGone);
  A('★ 别的库（B）的旧 journal 仍在（P0-2）', ok.legacyBJournal);
  A('★ 别的库（B）的真源未被动过', ok.libBUntouched);

  /* ══════════ ①b 第二个旧布局：2026.11.05.01 的 %LOCALAPPDATA%\GlimmerNote\write-state ══════════ */
  console.log('\n══ ①b 第二个旧布局（%LOCALAPPDATA%\\GlimmerNote\\write-state）也迁走，且只删空父目录 ══');
  {
    const lad = mkTmp('lad'), legacyTmp = mkTmp('legacy'), txnDir = mkTmp('txn');
    const rootA = mkTmp('libA2'), rootB = mkTmp('libB2');
    const base2 = path.join(lad, 'GlimmerNote', 'write-state');
    const plant2 = (root) => {
      const dir = path.join(base2, keyOf(root)); const snapDir = path.join(dir, 'txn-x');
      fs.mkdirSync(snapDir, { recursive: true });
      const target = path.join(root, '_状态.json'); fs.writeFileSync(target, 'NEW');
      const snap = path.join(snapDir, '0001'); fs.writeFileSync(snap, 'OLD');
      fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify({ txId: 'x', label: 'x', pid: DEAD_PID, startedAt: '', dir: snapDir, entries: [{ file: target, snap }] }));
      return { dir, target };
    };
    const a = plant2(rootA), b = plant2(rootB);
    const r = runChild(pathToFileURL(SRC).href, { LOCALAPPDATA: lad, CTB_LEGACY_TXN_BASE: legacyTmp, CTB_TXN_DIR: txnDir, CTB_LOCK_TOKEN: '' },
      `const rel = m.acquireLibLock(${JSON.stringify(rootA)}, { label: 't', timeoutMs: 5000 }); rel(); console.log(JSON.stringify({ ok: 1 }));`);
    A('取锁成功', !r.err, r.err || '');
    A('GlimmerNote\\write-state 里本库的旧事务被回滚（OLD）', fs.readFileSync(a.target, 'utf8') === 'OLD');
    A('★ 同目录下别的库的旧 journal 仍在', fs.existsSync(path.join(b.dir, 'journal.json')));
    A('非空的 GlimmerNote\\ 目录没被删', fs.existsSync(path.join(lad, 'GlimmerNote')));
    fs.rmSync(b.dir, { recursive: true, force: true });
    runChild(pathToFileURL(SRC).href, { LOCALAPPDATA: lad, CTB_LEGACY_TXN_BASE: legacyTmp, CTB_TXN_DIR: txnDir, CTB_LOCK_TOKEN: '' },
      `m.acquireLibLock(${JSON.stringify(rootA)}, { label: 't', timeoutMs: 5000 })(); console.log('{}');`);
    A('全部迁完后空的 GlimmerNote\\ 被清掉（不留空壳）', !fs.existsSync(path.join(lad, 'GlimmerNote')));
    A('★ 新布局落在 %LOCALAPPDATA%\\拾光小册\\write-state（目录名统一，P2-7）', fs.readFileSync(SRC, 'utf8').includes("os.tmpdir(), '拾光小册', 'write-state')"));
    for (const d of [lad, legacyTmp, txnDir, rootA, rootB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  }

  /* ══════════ ② 阴性自证：把修法掏掉，判据必须变红 ══════════ */
  console.log('\n══ ② 阴性自证 ══');
  const src = fs.readFileSync(SRC, 'utf8');
  const mutate = (tag, from, to) => {
    if (!src.includes(from)) return null;
    const p = path.join(path.dirname(SRC), '_安全写.__mut-' + tag + '-' + process.pid + '.mjs');
    fs.writeFileSync(p, src.replace(from, to));
    return p;
  };
  // ②a 还原"删整个旧父目录"
  const m1 = mutate('rmbase', 'try { fs.rmdirSync(d); } catch { break; }', 'try { fs.rmSync(d, { recursive: true, force: true }); } catch { break; }');
  A('变异锚点存在（父目录非递归 rmdirSync）', !!m1);
  if (m1) {
    try { const r = scenario(pathToFileURL(m1).href); A('阴性 · 还原成递归删父目录 ⇒ 库 B 的旧 journal 被删（判据有牙齿）', r.legacyBJournal === false); }
    finally { try { fs.unlinkSync(m1); } catch { } }
  }
  // ②b 还原"迁移写在 stateDirOf 里"（探针即回滚）
  const m2 = mutate('probe', '  const dir = path.join(base, key);\n  fs.mkdirSync(dir, { recursive: true });',
    '  const dir = path.join(base, key);\n  fs.mkdirSync(dir, { recursive: true });\n  if (!stateDirOf.__busy) { stateDirOf.__busy = 1; try { migrateLegacyState(root); } finally { stateDirOf.__busy = 0; } }');
  A('变异锚点存在（stateDirOf 体）', !!m2);
  if (m2) {
    try { const r = scenario(pathToFileURL(m2).href); A('阴性 · 迁移挪回 stateDirOf ⇒ 探针就回滚（判据有牙齿）', r.afterProbeA === 'OLD'); }
    finally { try { fs.unlinkSync(m2); } catch { } }
  }

  /* ══════════ ③ P2-5：旧日志属于活进程 ⇒ 不碰 ══════════ */
  console.log('\n══ ③ 旧日志的持有进程还活着（可能是旧版本工具）══');
  {
    const legacyBase = mkTmp('legacy'), txnDir = mkTmp('txn'), root = mkTmp('libL');
    const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
    const t = plantLegacyTxn(legacyBase, root, live.pid);
    const r = runChild(pathToFileURL(SRC).href, { CTB_LEGACY_TXN_BASE: legacyBase, CTB_TXN_DIR: txnDir, CTB_LOCK_TOKEN: '' },
      `const rel = m.acquireLibLock(${JSON.stringify(root)}, { label: 't', timeoutMs: 5000 }); rel(); console.log(JSON.stringify({ ok: 1 }));`);
    A('取锁本身成功（活进程的旧事务不阻塞新锁）', !r.err, r.err || '');
    A('活进程的旧事务不回滚（目标仍是 NEW）', fs.readFileSync(t.target, 'utf8') === 'NEW');
    A('活进程的旧日志不删', fs.existsSync(path.join(t.dir, 'journal.json')));
    live.kill();
    for (const d of [legacyBase, txnDir, root]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  }

  /* ══════════ ④ P1-2 / P1-3：启动时间缓存与兜底 ══════════ */
  console.log('\n══ ④ 启动时间：缓存在 PID 死亡后作废；查不到写 0 ══');
  const m = await import(pathToFileURL(SRC).href);
  const self = m.__test_procStartTime(process.pid);
  const supported = process.platform === 'win32' || process.platform === 'linux';
  if (supported) {
    A('本进程启动时间可查（平台通道可用）', self > 0 && self <= Date.now(), String(self));
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 300));
    const t1 = m.__test_procStartTime(child.pid);
    A('子进程启动时间可查', t1 > 0, String(t1));
    A('缓存里有子进程的条目', m.__test_procStartCache.has(child.pid));
    child.kill();
    await new Promise(r => child.on('exit', r));
    const alive = m.__test_lockHolderAlive({ pid: child.pid, startedAt: t1 });
    A('子进程死后判"不存活"', alive === false);
    A('★ 观察到死亡后缓存条目被作废（P1-2）', !m.__test_procStartCache.has(child.pid));
  } else {
    console.log('[SKIP] 本平台没有启动时间通道（只支持 win32 / linux），④ 的动态段跳过（不冒充通过）');
  }
  A('★ 源码级：startedAt 不再用 Date.now() 兜底（P1-3）', !/procStartTime\(process\.pid\)\s*\|\|\s*Date\.now\(\)/.test(src));
  A('源码级：没有描述不存在的心跳常量', !/HEARTBEAT_STALE_MS\s*[)=]/.test(src) && !/心跳刷新/.test(src.replace(/修前注释描述了"心跳刷新[^"]*"/g, '')));

  console.log('\nRESULT=' + (worst ? 'FAIL' : 'PASS') + ' 断言=' + (passed + worst) + (worst ? ' 失败=' + worst : ''));
  process.exit(worst ? 1 : 0);
})();
