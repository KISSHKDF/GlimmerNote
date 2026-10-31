#!/usr/bin/env node
/**
 * neg-state-gen-mixed-snapshot.cjs —— 状态生成器必须持库写锁（2026-10-31 建，
 * 外部 codex 审查 A03 的护栏）
 *
 * 缺陷（修前实测）：
 *   生成器**从不取锁**。与 CLI 写入并发时会出现"跨事务拼接的快照"：
 *     ① 生成器读旧 `_索引.json`（reviewCount=0）；
 *     ② CLI 拿到锁，完成批改事务（索引 reviewCount=1、台账 status=已批改）；
 *     ③ 生成器继续读台账（已是"已批改"）并写出 `_状态.json`
 *   结果同一份状态包里"试卷已批改"与"卡片还没复习"并存（实测 snapshotReview=0 + paperStatus=graded）。
 *   `_状态.json` 虽是派生缓存，却是**界面唯一读的东西** —— 用户会看到自相矛盾的报表，
 *   而且下次重建前一直是错的（不是"慢一拍"，是"两份真源各取一半"）。
 *
 * 判据（三条）：
 *   ① 静态：`生成状态.mjs` 必须在**第一次读真源之前**调用 acquireLibLock；
 *   ② 动态：生成器进程运行时，本库的锁文件里必须是它（外部看到"有人在写这个库"）；
 *   ③ 阴性自证：把取锁那句摘掉 ⇒ ② 必须变红。
 *   附加：`--out -`（只输出到 stdout）是纯读，**不该**取锁（否则只读调用会被写操作堵住）。
 *
 * 用法：node tests\neg-state-gen-mixed-snapshot.cjs
 * 退出码：0=PASS / 1=FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const GEN = path.join(ROOT, 'src', 'tools', '生成状态.mjs');
const SAFE_WRITE = pathToFileURL(path.join(ROOT, 'src', 'tools', '_安全写.mjs')).href;

let worst = 0, passed = 0;
/* ⚠ 本用例会 await 子进程；**如果某次 await 永远不落地，Node 会在事件循环空掉时直接 exit 0**，
   于是"一个字都没跑完"看起来像"全绿"（本用例第一版就这样假绿过一次：只打印了 ①，②③ 没跑，exit=0）。
   兜底：只有真正跑到末尾才置 finished=true；否则 exit 钩子把退出码改成 3。 */
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.error('✖ 用例未跑到末尾就退出了（某个 await 未落地）—— 判 FAIL，不许当绿');
    process.exitCode = 3;
  }
});
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
}
const src = fs.readFileSync(GEN, 'utf8');

/* ---------- ① 静态判据 ---------- */
/* ⚠ "第一次读真源"的锚点要选**真正读文件内容**的那一个，不能选 `findIndexes(ROOT`
   —— 那只是 `readdirSync` 列目录，列完不会拿到内容；真正的读是 `readJson(`。
   第一版选错锚点，判据变成恒假红（取锁在 readdir 之后、readJson 之前，本来是对的）。 */
console.log('== ① 静态：取锁必须在第一次读真源**内容**之前 ==');
A('生成了导入 acquireLibLock', /import\s*\{[^}]*acquireLibLock[^}]*\}\s*from\s*'\.\/_安全写\.mjs'/.test(src),
  (src.match(/import \{[^}]*\} from '\.\/_安全写\.mjs'/) || ['（没找到）'])[0]);
const lockAt = src.indexOf('acquireLibLock(ROOT');
const firstReadAt = src.indexOf('const indexFiles = findIndexes(ROOT');   // 第一个"读库"动作
const firstContentAt = src.indexOf('function readJson(') >= 0 ? src.indexOf('readJson(f)') : -1;
A('取锁出现在文件里', lockAt > 0, 'offset=' + lockAt);
/* 注：`findIndexes(ROOT,…)` 只列目录（readdirSync），排在取锁之前是**可以的** ——
   它不读任何文件内容，列出来的路径后面才逐个 readJson。第一版把它当"读真源"锚点，
   于是判据恒假红（取锁在 readdir 之后、readJson 之前，本来是对的）。这里只记观察项。 */
console.log('  ℹ 目录列举位置：findIndexes@' + firstReadAt + '（取锁@' + lockAt + '：只列目录，不读内容，允许在其后）');
A('★ 取锁早于第一次读文件内容（真正的"读到旧值"窗口，readJson）',
  lockAt > 0 && firstContentAt > 0 && lockAt < firstContentAt,
  'lock@' + lockAt + ' 首个 readJson 调用@' + firstContentAt);
A('释放挂在 exit 钩子上（本文件有多处 process.exit，finally 拦不住）',
  /process\.on\('exit'/.test(src), /process\.on\('exit'/.test(src) ? '已挂' : '没有 exit 钩子 —— 提前退出会留下僵尸锁');
A('`--out -`（纯读）不取锁', /OUT !== '-'/.test(src), '找到条件分支');

/* ---------- ② 动态判据：跑生成器，外部看锁 ---------- */
const lib = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-stategen-')), '库');
fs.cpSync(path.join(ROOT, 'fixtures', '库-形状'), lib, { recursive: true });
const stateDir = path.join(os.tmpdir(), 'glimmernote-write-state',
  require('crypto').createHash('sha1').update(String(lib).toLowerCase()).digest('hex').slice(0, 16));

async function runGenWithProbe(genPath) {
  /* 起生成器，同时高频读锁文件：只要在它跑完之前读到"锁里是它的 pid"就算持锁 */
  const p = spawn(process.execPath, [genPath, '--quiet'], {
    cwd: ROOT, env: Object.assign({}, process.env, { CTB_DATA: lib, CTB_TXN_DIR: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /* ⚠ close 监听必须在 spawn 之后**立刻**挂上：本用例第一版在轮询循环**之后**才挂，
     子进程先退出 ⇒ 'close' 已经错过 ⇒ 这个 await 永远不落地 ⇒ Node 事件循环空掉直接 exit 0，
     于是"只跑了 ①、②③ 没跑"却报 0（假绿）。这就是本仓 L-xxx 那类"判据不构成证据"的翻版。 */
  const closed = new Promise(res => p.on('close', c => res(c)));
  let out = '', err = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  const lockPath = path.join(stateDir, 'lock');
  let sawOwnLock = false, sawAny = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try {
      const j = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (j && j.pid === p.pid) { sawOwnLock = true; sawAny = j; }
    } catch { }
    if (p.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 5));
  }
  const code = await closed;
  return { code, out, err, sawOwnLock, sawAny };
}

(async () => {
  console.log('\n== ② 动态：生成器跑起来时，锁文件里必须是它自己 ==');
  const r1 = await runGenWithProbe(GEN);
  A('生成器自身正常退出（先确认探针没把环境搞坏）', r1.code === 0, 'exit=' + r1.code + ' err=' + String(r1.err).slice(0, 120));
  A('★ 运行期间本库被它持锁（外部能看到 pid）', r1.sawOwnLock,
    r1.sawOwnLock ? JSON.stringify(r1.sawAny).slice(0, 120) : '整个运行期没看到它的锁 —— 说明它没取锁');
  const lockedAfter = fs.existsSync(path.join(stateDir, 'lock'));
  A('跑完不留僵尸锁', !lockedAfter, lockedAfter ? '锁文件还在（exit 钩子没生效？）' : '已释放');

  /* --out - 纯读：不该长期持锁（用"跑完立刻查锁"判，允许极短窗口） */
  const before = { state: '' };
  try {
    const o = execFileSync(process.execPath, [GEN, '--out', '-', '--quiet'],
      { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { CTB_DATA: lib }), maxBuffer: 64e6 });
    before.state = 'ok:' + o.length;
  } catch (e) { before.state = 'fail:' + (e.status); }
  A('`--out -` 可正常输出状态包（纯读路径没被锁破坏）', /^ok:/.test(before.state), before.state.slice(0, 40));

  /* ---------- ③ 阴性自证 ---------- */
  console.log('\n== ③ 阴性自证：摘掉取锁 ==');
  const brokenPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-stategen-broken-')), '生成状态.mjs');
  const broken = src.replace(
    /  releaseLibLock = acquireLibLock\(ROOT, \{ label: '生成状态' \}\);/,
    '  /* [阴性自证] 故意不取锁 */');
  A('阴性自证 · 判据能被"摘掉取锁"打红（掏得动）', broken !== src,
    broken === src ? '替换点没匹配到 —— 用例与实现脱钩，必须修用例' : '已构造坏版本');
  if (broken !== src) {
    fs.writeFileSync(brokenPath, broken, 'utf8');
    const r2 = await runGenWithProbe(brokenPath);
    A('阴性自证 · 坏版本确实没持锁（= 主判据②会红）', !r2.sawOwnLock,
      '坏版本 sawOwnLock=' + r2.sawOwnLock + '（应为 false）');
  }

  try { fs.rmSync(path.dirname(lib), { recursive: true, force: true }); } catch { }
  try { fs.rmSync(path.dirname(brokenPath), { recursive: true, force: true }); } catch { }

  console.log('\n──────────────────────────────');
  console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
  finished = true;                       // ← 必须在 exit 之前置位，否则兜底钩子会把正常收尾也判 FAIL
  process.exit(worst === 0 ? 0 : 1);
})().catch(e => { console.error('✖ 用例自身异常：' + (e && e.stack || e)); process.exit(1); });
