#!/usr/bin/env node
/**
 * 拾光小册 · 写锁回收竞态 / 事务回滚保留 回归（2026-10-31 建，外部 codex 审查 A01+B01 的护栏）
 *
 * 守两件事（两件都已先复现、再修，判据都带阴性自证）：
 *
 *  A01 僵尸锁回收的 TOCTOU：
 *    旧实现 `读锁 → 判死 → unlink` 之间没有互斥。两个进程同时遇到同一个僵尸锁时，
 *    先到的那个可能删掉**后到者刚建好的活锁** ⇒ 两者同时进入写区（静默丢更新）。
 *    复现（修前）：25 轮 × 3 进程，8 次在临界区内读到别人的 token。
 *    判据：任何进程在"自认为持锁"期间，锁文件里的 token 必须一直是它自己的。
 *
 *  B01 回滚失败仍删恢复材料：
 *    旧实现 rollback() 无条件 unlink 日志 + rm 留档，于是"一半恢复到旧值、一半失败"的现场
 *    连下次重试的依据都没了。判据：failed 非空 ⇒ 事务日志必须仍在（可重试），且
 *    recoverTransactions() 必须报"未完成"而不是报"已回滚"。
 *
 * 用法：node tests\neg-lock-reclaim-race.cjs
 * 退出码：0=PASS（含阴性自证）/ 1=FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const E = require('./_测试环境.cjs');
const REPO = E.REPO;
const SAFE_WRITE = pathToFileURL(path.join(REPO, 'src', 'tools', '_安全写.mjs')).href;

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}
const mkTmp = tag => fs.mkdtempSync(path.join(os.tmpdir(), 'gn-lock-' + tag + '-'));

/* ══════════ ① A01：僵尸锁回收竞态 ══════════ */
const CHILD = `
const fs=require('fs');
(async () => {
  const SW = await import(${JSON.stringify(SAFE_WRITE)});
  const [root, holdMs] = [process.argv[2], Number(process.argv[3] || 40)];
  let release;
  try { release = SW.acquireLibLock(root, { label: 'child', timeoutMs: 60000, pollMs: 5 }); }
  catch (e) { console.log(JSON.stringify({ acquired: false, err: String(e.message).slice(0, 80) })); process.exit(0); }
  const myToken = process.env.CTB_LOCK_TOKEN || '';
  const lockPath = SW.lockPathOf(root);
  const read = () => { try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; } };
  const t0 = Date.now(); let stolen = 0;
  while (Date.now() - t0 < holdMs) {
    const cur = read();
    if (!cur || cur.token !== myToken) stolen++;
    const t = Date.now() + 4; while (Date.now() < t) { }
  }
  release();
  console.log(JSON.stringify({ acquired: true, stolenPeek: stolen > 0, stolen }));
})();
`;

function runChild(scriptPath, root, holdMs) {
  return new Promise(res => {
    const p = spawn(process.execPath, [scriptPath, root, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', () => {
      const line = out.split(/\r?\n/).filter(Boolean).pop();
      let j = null; try { j = JSON.parse(line); } catch { }
      res(j || { acquired: false, err: (out + err).slice(0, 200) });
    });
  });
}

(async () => {
  console.log('测试环境：' + E.describe());
  const SW = await import(SAFE_WRITE);
  const childPath = path.join(mkTmp('child'), 'child.cjs');
  fs.writeFileSync(childPath, CHILD);

  const lib = path.join(mkTmp('lib'), '库');
  fs.mkdirSync(lib, { recursive: true });
  const lockPath = SW.lockPathOf(lib);

  const ROUNDS = 12, CONC = 3;
  let acquired = 0, violations = 0, firstBad = null;
  for (let r = 0; r < ROUNDS; r++) {
    try { fs.unlinkSync(lockPath + '.gc'); } catch { }
    try { fs.unlinkSync(lockPath); } catch { }
    /* 造僵尸锁：pid 999999 基本不可能在跑（且 pidAlive 会判死） */
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'deadbeefdeadbeefdead', label: 'crashed', at: Date.now() }));
    const rs = await Promise.all(Array.from({ length: CONC }, () => runChild(childPath, lib, 30)));
    for (const x of rs) {
      if (x.acquired) acquired++;
      if (x.stolenPeek) { violations++; if (!firstBad) firstBad = { round: r, x }; }
    }
    try { fs.unlinkSync(lockPath); } catch { }
  }
  console.log('\n══ ① 僵尸锁 + ' + CONC + ' 进程并发抢（' + ROUNDS + ' 轮）══');
  console.log('  抢锁成功 ' + acquired + '/' + (ROUNDS * CONC) + '，临界区内看到别人锁 ' + violations + ' 次');
  A('★ 没有任何进程在"持锁期间"看到锁属于别人（无双重持锁）', violations === 0,
    violations ? '违反 ' + violations + ' 次；样例 ' + JSON.stringify(firstBad) : '0 次');
  A('进程都成功拿到过锁（不是靠"全失败"换来的绿）', acquired >= ROUNDS, acquired + ' 次');

  /* ② 阴性自证（确定性交错）：把"互斥内重读判活"掏掉后，同一个交错必须变成双重持锁。
         ⚠ 为什么这一段不用真进程：竞态窗口极窄（真进程 20 轮只命中 0~1 次），
         用它做自证会变成"时红时绿"的假门禁。这里把两个进程的**系统调用交错固定下来**，
         直接证明"读与删之间没有互斥"这一条判据成立与否 —— 判据本身是可完全确定的。 */
  const det = await (async () => {
    const srcAll = fs.readFileSync(path.join(REPO, 'src', 'tools', '_安全写.mjs'), 'utf8');
    const a = srcAll.indexOf('export function acquireLibLock(');
    const b = srcAll.indexOf('/* ---------- 多文件业务事务');
    if (a < 0 || b < 0) return { ok: false, why: '源码边界找不到（重构了这个函数就要同步改本用例）' };

    /* 用一份内存 FS 固定交错：A 读到僵尸锁 → B 完成"清理僵尸锁 + 建自己的锁" → A 继续 */
    function build(broken) {
      /* 起始现场：锁文件里是一个"持有者已死"的僵尸锁 */
      const ZOMBIE = JSON.stringify({ pid: 999999, token: 'zombie-token', label: 'crashed', at: 0 });
      const st = { owner: ZOMBIE, gc: false, stolenLive: false, unlockedLive: null, aResult: null };
      const B = { pid: 202, token: 'B-alive-token', label: 'B' };
      const fds = new Map();
      let afterFirstRead = false;
      const fakeFs = {
        mkdirSync() { },
        openSync(p, mode) {
          if (String(p).endsWith('.gc')) {
            if (st.gc) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
            st.gc = true; const fd = 900 + fds.size; fds.set(fd, { path: String(p) }); return fd;
          }
          if (st.owner) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
          st.owner = ''; const fd = 100 + fds.size; fds.set(fd, { path: String(p) }); return fd;
        },
        /* ⚠ 只有"主锁文件"的写入才更新 owner；写 <lock>.gc（持有者 pid）不能算（本用例第一版踩到：
           把 gc 的 pid 写进了 owner，导致后续读取拿到 "101"、整个交错失真）。 */
        writeFileSync(fd, body) {
          const f = fds.get(fd); if (!f) return;
          if (f.path.endsWith('.gc')) { st.gcBody = String(body); return; }
          st.owner = String(body);
        },
        closeSync(fd) { fds.delete(fd); },
        readFileSync(p) {
          if (String(p).endsWith('.gc')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          if (st.owner === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          const out = st.owner;
          /* 只在 A 读到**僵尸锁**那一次之后插入交错：B 抢先清理并建了自己的锁。
             （修后版本在拿到 gc 互斥后会重读，读到 B 的活锁 ⇒ 放弃；旧版本直接删 ⇒ 偷锁） */
          if (!afterFirstRead && /999999/.test(out)) {
            afterFirstRead = true;
            st.owner = JSON.stringify(B);
          }
          return out;
        },
        unlinkSync(p) {
          if (String(p).endsWith('.gc')) { st.gc = false; return; }
          /* 判断"本次删的是不是别人的活锁" */
          try {
            const cur = st.owner === null ? null : JSON.parse(st.owner);
            if (cur && cur.token === B.token) { st.stolenLive = true; st.unlockedLive = cur; }
          } catch { }
          st.owner = null;
        },
        statSync() { return { mtimeMs: Date.now() }; },
      };
      let code = srcAll.slice(a, b).replace(/\bexport /g, '');
      if (broken) code = code.replace('if (again && pidAlive(again.pid)) return false;       // 持有者活着：绝不删',
        '/* [阴性自证] 去掉互斥内重读判活 */');
      const ctx = {
        fs: fakeFs, path, crypto: require('crypto'),
        console: { error() { } },
        process: { pid: 101, env: {} },
        TXN_ENV: 'CTB_LOCK_TOKEN', LOCK_FILE: 'lock',
        stateDirOf: () => '/virtual-state',
        inheritedToken: () => '',
        pidAlive: p => p !== 999999,          // 只有僵尸锁的 pid 是"死的"
        recoverTransactions: () => '',
        sleepMs() { },
        readLockFile(p) { try { return JSON.parse(fakeFs.readFileSync(p)); } catch { return null; } },
      };
      try {
        const fn = new Function(...Object.keys(ctx), code + '\nreturn acquireLibLock;')(...Object.values(ctx));
        fn('/virtual-lib', { label: 'A', timeoutMs: 120, pollMs: 1 });
        st.aResult = 'acquired';
      } catch (e) { st.aResult = /超时/.test(String(e.message)) ? 'timeout' : 'error:' + e.message.slice(0, 60); }
      st.finalOwner = st.owner === null ? null : JSON.parse(st.owner).token;
      return st;
    }

    const fixed = build(false);
    const bad = build(true);
    return { ok: true, fixed, bad };
  })();

  if (!det.ok) {
    A('阴性自证 · 交错装置可用', false, det.why);
  } else {
    console.log('\n══ ③ 确定性交错：A 读到僵尸锁后 B 抢先建锁 ══');
    A('★ 修后：A 没有删掉 B 的活锁（未发生偷锁）', det.fixed.stolenLive === false,
      det.fixed.stolenLive ? 'A 删了 B 的锁！' : 'B 的锁完好');
    A('★ 修后：A 没有同时进入写区（等锁超时才退出）', det.fixed.aResult === 'timeout',
      'A 的结果=' + det.fixed.aResult + '，最终锁持有者=' + det.fixed.finalOwner);
    A('阴性自证 · 掏掉"重读判活"后 A 确实删掉 B 的活锁', det.bad.stolenLive === true,
      det.bad.stolenLive ? '已复现偷锁（B 的锁被删）' : '没复现出来，自证无效');
    A('阴性自证 · 掏掉后 A 成功进入写区 = 与 B 双重持锁', det.bad.aResult === 'acquired',
      'A 的结果=' + det.bad.aResult);
  }

  /* ══════════ ② B01：回滚失败必须保留日志与留档 ══════════ */
  console.log('\n══ ② 事务回滚失败时保留恢复材料 ══');
  const lib2 = path.join(mkTmp('tx'), '库');
  fs.mkdirSync(lib2, { recursive: true });
  const fA = path.join(lib2, '_索引.json');
  const fB = path.join(lib2, '_组卷台账.json');
  fs.writeFileSync(fA, JSON.stringify({ v: 'A-old' }));
  fs.writeFileSync(fB, JSON.stringify({ v: 'B-old' }));
  const journal = SW.journalPathOf(lib2);

  const tx = SW.openTransaction(lib2, { label: 'B01 回归' });
  tx.writeJson(fA, { v: 'A-new' });
  tx.writeJson(fB, { v: 'B-new' });
  /* 把 fB 变成非空目录 ⇒ 恢复必然失败（模拟占用/权限/磁盘错误） */
  fs.unlinkSync(fB);
  fs.mkdirSync(fB);
  fs.writeFileSync(path.join(fB, 'x'), 'x');

  const r = tx.rollback();
  A('回滚报告了失败项（不是"静默成功"）', r && r.failed && r.failed.length > 0,
    r && r.failed ? r.failed.length + ' 项：' + String(r.failed[0]).slice(0, 90) : '没有 failed 字段');
  A('★ 回滚失败后事务日志仍在（下次启动可重试）', fs.existsSync(journal),
    fs.existsSync(journal) ? 'journal 保留' : 'journal 已被删 —— 半更新永久失去恢复依据');

  /* recoverTransactions 的第一条判据是"日志里的 pid 不是自己"（同进程的上次事务不算），
     所以这里把日志里的 pid 改成一个已死的 pid，模拟"下一个进程启动时看到遗留日志"。 */
  const j2 = JSON.parse(fs.readFileSync(journal, 'utf8'));
  j2.pid = 999999;
  fs.writeFileSync(journal, JSON.stringify(j2, null, 1));
  const healed = SW.recoverTransactions(lib2);
  A('★ recoverTransactions 报"未完成"而不是"已回滚"', /未完成/.test(healed), String(healed).slice(0, 120));
  A('失败现场下日志仍保留（不会被"重试一次"顺手清掉）', fs.existsSync(journal), fs.existsSync(journal) ? '仍保留' : '被清掉了');

  /* ③ 阴性自证：把"回滚成功才清理"的判据掏掉（改成旧行为：无条件清理），判据必须变红 */
  const brokenTxPath = path.join(mkTmp('brokentx'), '_安全写.mjs');
  const srcTx = fs.readFileSync(path.join(REPO, 'src', 'tools', '_安全写.mjs'), 'utf8');
  const guard = `      if (r.failed.length) {
        console.error('[事务] ⚠ 回滚未完成（' + r.failed.length + ' 个文件恢复失败），已**保留**事务日志与留档以便下次重试：' + r.failed.join('；'));
        return r;
      }
`;
  const brokenTx = srcTx.includes(guard)
    ? srcTx.replace(guard, '      /* [阴性自证] 故意去掉"失败则保留恢复材料"，还原成无条件清理 */\n')
    : srcTx;
  A('阴性自证 · 判据能被"还原成无条件清理"打红（掏得动）', brokenTx !== srcTx,
    brokenTx === srcTx ? '替换点没匹配到，自证无效' : '已构造旧行为版本');
  if (brokenTx !== srcTx) {
    fs.writeFileSync(brokenTxPath, brokenTx);
    const OLD = await import(pathToFileURL(brokenTxPath).href);
    const lib4 = path.join(mkTmp('tx3'), '库');
    fs.mkdirSync(lib4, { recursive: true });
    const hA = path.join(lib4, '_索引.json'), hB = path.join(lib4, '_组卷台账.json');
    fs.writeFileSync(hA, JSON.stringify({ v: 'A-old' })); fs.writeFileSync(hB, JSON.stringify({ v: 'B-old' }));
    const journal4 = OLD.journalPathOf(lib4);
    const tx4 = OLD.openTransaction(lib4, { label: '旧行为' });
    tx4.writeJson(hA, { v: 'A-new' }); tx4.writeJson(hB, { v: 'B-new' });
    fs.unlinkSync(hB); fs.mkdirSync(hB); fs.writeFileSync(path.join(hB, 'x'), 'x');
    const r4 = tx4.rollback();
    A('阴性自证 · 旧行为下"回滚失败"确实发生', !!(r4 && r4.failed && r4.failed.length),
      r4 && r4.failed ? r4.failed.length + ' 项失败' : '没能造出失败');
    A('阴性自证 · 旧行为下事务日志被删（= 主判据「journal 仍在」会红）', !fs.existsSync(journal4),
      fs.existsSync(journal4) ? '旧行为没删日志，自证无效' : '已证明旧行为下主判据为红');
    try { fs.rmSync(path.dirname(lib4), { recursive: true, force: true }); } catch { }
  }

  for (const d of [path.dirname(lib), path.dirname(lib2)]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { }
  }
  /* 失败现场里的目录型目标（我们故意造的）会让 rmSync 失败，逐个清掉再删根 */
  try { fs.rmSync(fB, { recursive: true, force: true }); fs.rmSync(path.dirname(lib2), { recursive: true, force: true }); } catch { }

  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => { console.error('✖ 用例自身异常：' + (e && e.stack || e)); process.exit(1); });
