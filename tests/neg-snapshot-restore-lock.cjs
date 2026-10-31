#!/usr/bin/env node
/**
 * neg-snapshot-restore-lock.cjs —— `_快照 --restore` 必须持库写锁（2026-10-31 建，
 * 外部 codex 审查 B03 的护栏）
 *
 * 缺陷（已复现）：
 *   `--restore` 全程不取锁，可以把某个文件恢复成旧版本，**穿插到另一笔未提交事务的内部**：
 *     ① CLI 持锁，事务已写新台账；② CLI 还没写索引；
 *     ③ 有人跑 `_快照 --restore _组卷台账.json`，未取锁 ⇒ 台账被恢复成旧值、校验通过、报成功；
 *     ④ CLI 写完新索引并提交 ⇒ **台账旧、索引新**，两边都报成功（正是事务要防的半截状态）。
 *   恢复单个文件是用户授权动作，但它不该插进另一笔事务中间。
 *
 * 判据：
 *   ① 静态：`--restore` 分支里必须有 acquireLibLock，且**在写盘之前**；
 *   ② 动态：另一个进程持锁时启动 `_快照 --restore`，它必须**等锁**（不上手写），
 *      锁释放后它才写；期间数据文件的 mtime/内容不变；
 *   ③ 阴性自证：把取锁那句摘掉（副本上改，不动仓库）⇒ ② 必须变红（不等锁、直接写）。
 *
 * 用法：node tests\neg-snapshot-restore-lock.cjs
 * 退出码：0=PASS / 1=FAIL（跑到末尾才置 finished，防"await 未落地却 exit 0"的假绿）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SNAP = path.join(ROOT, 'src', 'tools', '_快照.mjs');
const SAFE_WRITE = pathToFileURL(path.join(ROOT, 'src', 'tools', '_安全写.mjs')).href;

let worst = 0, passed = 0, finished = false;
process.on('exit', () => {
  if (!finished) { console.error('✖ 用例未跑到末尾就退出了（某个 await 未落地）—— 判 FAIL，不许当绿'); process.exitCode = 3; }
});
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
}
const src = fs.readFileSync(SNAP, 'utf8');

/* ---------- ① 静态判据 ---------- */
console.log('== ① 静态：--restore 分支必须取锁，且在写盘之前 ==');
const branchAt = src.indexOf("if (args.includes('--restore'))");
const lockAt = src.indexOf('acquireLibLock(ROOT', branchAt >= 0 ? branchAt : 0);
const writeAt = src.indexOf('writeTextAtomic(abs, content', branchAt >= 0 ? branchAt : 0);
A('--restore 分支存在', branchAt > 0, 'offset=' + branchAt);
A('★ 分支里调用了 acquireLibLock', lockAt > branchAt, 'lock@' + lockAt);
A('★ 取锁早于第一次写盘（恢复前备份/写正文都算写）', lockAt > 0 && writeAt > 0 && lockAt < writeAt,
  'lock@' + lockAt + ' write@' + writeAt);
A('释放挂在 exit 钩子上（该分支多处 process.exit）',
  /process\.on\('exit'[^)]*releaseRestoreLock|releaseRestoreLock\(\)/.test(src.slice(branchAt, writeAt + 4000)),
  '找到 releaseRestoreLock 的 exit 挂载');
A('--dry 在取锁之前就返回（预览不需要锁，别把只读调用堵住）',
  src.indexOf("if (dry) {", branchAt) < lockAt, 'dry 早退@' + src.indexOf('if (dry) {', branchAt));

/* ---------- 造一个最小可恢复库 ---------- */
function mkLib() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-snaplock-'));
  fs.writeFileSync(path.join(dir, '_组卷台账.json'), JSON.stringify({ batches: [{ paperId: 'P1', status: '待批改' }], paperSeq: { '测试生': 1 } }, null, 1));
  /* 手工造一个"历史版本"：用 git 仓库太重，直接走 _备份-真源\ 来源分支（脚本支持的后备来源） */
  const bdir = path.join(dir, '_备份-真源');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, '_组卷台账-旧版.json'),
    JSON.stringify({ batches: [{ paperId: 'P0', status: '已批改' }], paperSeq: { '测试生': 1 } }, null, 1));
  /* 让 git 调用失败的库（没有 .git）——脚本会退到 _备份-真源\ 分支 */
  return dir;
}

async function runRestore(lib, scriptPath, extraEnv) {
  /* ⚠ 不传版本号：传了会强行走 git（`git cat-file -e <ver>:<rel>`），而临时库不是 git 仓库 ⇒
     "该版本不含该文件" 直接 exit 1，测的就不是锁了。不传版本时脚本会退到
     `_备份-真源\` 后备来源（historyOf 在非 git 目录返回空）。第一版就栽在这里。 */
  const p = spawn(process.execPath, [scriptPath, '--restore', '_组卷台账.json'], {
    cwd: lib, env: Object.assign({}, process.env, { CTB_DATA: lib }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(res => p.on('close', c => res(c)));
  let out = '', err = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  return { p, closed, getOut: () => out + err };
}

(async () => {
  console.log('\n== ② 动态：别人持锁时，--restore 必须等锁（不许上手写）==');
  const lib = mkLib();
  const target = path.join(lib, '_组卷台账.json');
  const before = fs.readFileSync(target, 'utf8');
  const beforeSha = crypto.createHash('sha256').update(before).digest('hex');

  /* 用一个**真的持锁者**占住库：直接调 _安全写 的 acquireLibLock */
  const holder = `
    (async () => {
      const SW = await import(${JSON.stringify(SAFE_WRITE)});
      const rel = SW.acquireLibLock(process.argv[2], { label: 'holder', timeoutMs: 5000 });
      process.stdout.write('HELD\\n');
      await new Promise(r => setTimeout(r, 2500));   // 假装在写
      rel();
      process.stdout.write('RELEASED\\n');
    })().catch(e => { console.error(String(e.message)); process.exit(1); });
  `;
  const holderPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-holder-')), 'holder.mjs');
  fs.writeFileSync(holderPath, holder, 'utf8');
  const hp = spawn(process.execPath, [holderPath, lib], { stdio: ['ignore', 'pipe', 'pipe'] });
  const holderClosed = new Promise(res => hp.on('close', c => res(c)));
  let hout = '';
  hp.stdout.on('data', d => hout += d);
  /* 等它真的拿到锁 */
  for (let i = 0; i < 400 && !/HELD/.test(hout); i++) await new Promise(r => setTimeout(r, 10));
  A('前置：另一个进程已持库写锁', /HELD/.test(hout), 'holder 输出=' + JSON.stringify(hout));

  const r = await runRestore(lib, SNAP);
  const duringSha = crypto.createHash('sha256').update(fs.readFileSync(target, 'utf8')).digest('hex');
  A('★ 持锁期间 --restore 还没写目标文件（等锁而不是插进去写）', duringSha === beforeSha,
    duringSha === beforeSha ? '文件未变 ✓' : '文件已被改写 —— 它没等锁');
  A('★ --restore 启动后确实在等锁（进程还没退出）', r.p.exitCode === null, 'exitCode=' + r.p.exitCode);

  await holderClosed;
  const code = await r.closed;
  const outAll = String(r.getOut());
  A('★ --restore 期间打印过"等锁"提示（不是静默卡住）',
    /等待另一个进程/.test(outAll), JSON.stringify(outAll.slice(0, 160)));
  const afterSha = crypto.createHash('sha256').update(fs.readFileSync(target, 'utf8')).digest('hex');
  A('持锁者释放后 --restore 才真正写入（恢复成功）', code === 0 && afterSha !== beforeSha,
    'exit=' + code + ' 内容变了=' + (afterSha !== beforeSha));
  A('恢复后确实是旧版内容', /P0/.test(fs.readFileSync(target, 'utf8')), fs.readFileSync(target, 'utf8').replace(/\s+/g, ' ').slice(0, 70));

  /* ---------- ③ 阴性自证 ---------- */
  console.log('\n== ③ 阴性自证：摘掉取锁 ==');
  const broken = src.replace(
    /  const releaseRestoreLock = acquireLibLock\(ROOT, \{ label: '_快照 --restore ' \+ path\.basename\(abs\) \}\);/,
    '  const releaseRestoreLock = function () { };  // [阴性自证] 故意不取锁');
  A('阴性自证 · 判据能被"摘掉取锁"打红（掏得动）', broken !== src,
    broken === src ? '替换点没匹配到 —— 用例与实现脱钩，必须修用例' : '已构造坏版本');
  if (broken !== src) {
    /* 坏版本必须在仓库结构里跑（它 import 兄弟模块）——放到临时目录并复制依赖 */
    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-badsnap-'));
    const badTools = path.join(badRoot, 'src', 'tools');
    fs.mkdirSync(badTools, { recursive: true });
    for (const f of ['_安全写.mjs', '_库根.mjs']) fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(badTools, f));
    fs.writeFileSync(path.join(badTools, '_快照.mjs'), broken, 'utf8');

    const lib2 = mkLib();
    const target2 = path.join(lib2, '_组卷台账.json');
    const before2 = crypto.createHash('sha256').update(fs.readFileSync(target2, 'utf8')).digest('hex');
    const hp2 = spawn(process.execPath, [holderPath, lib2], { stdio: ['ignore', 'pipe', 'pipe'] });
    const holderClosed2 = new Promise(res => hp2.on('close', c => res(c)));
    let hout2 = '';
    hp2.stdout.on('data', d => hout2 += d);
    for (let i = 0; i < 400 && !/HELD/.test(hout2); i++) await new Promise(r => setTimeout(r, 10));
    const r2 = await runRestore(lib2, path.join(badTools, '_快照.mjs'));
    /* ⚠ 判"坏版本插队写"要在**持锁者释放之前**看文件，所以先等一小会（坏版本不等锁，会立刻写）。
       第一版在 readRestore 返回后立刻比 sha，而那时坏版本可能已经把自己的整段流程跑完了 ——
       但如果它恰好也"跑完了但没写"（比如来源找不到），就会误判成"没复现出来"。
       这里改成：先给 600ms 让它写（坏版本不需要等锁），再比；并打印它的输出便于归因。 */
    await new Promise(r => setTimeout(r, 600));
    const during2 = crypto.createHash('sha256').update(fs.readFileSync(target2, 'utf8')).digest('hex');
    A('阴性自证 · 坏版本在别人持锁时就把文件改了（= 主判据会红）', during2 !== before2,
      during2 !== before2
        ? '文件被插队改写（复现成功）'
        : '没复现出来：' + JSON.stringify(String(r2.getOut()).slice(0, 200)));
    await holderClosed2;
    await r2.closed;
    try { fs.rmSync(badRoot, { recursive: true, force: true }); } catch { }
    try { fs.rmSync(path.dirname(lib2), { recursive: true, force: true }); } catch { }
  }

  try { fs.rmSync(path.dirname(lib), { recursive: true, force: true }); } catch { }
  try { fs.rmSync(path.dirname(holderPath), { recursive: true, force: true }); } catch { }

  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  finished = true;
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => { console.error('✖ 用例自身异常：' + (e && e.stack || e)); process.exit(1); });
