#!/usr/bin/env node
/**
 * 错题本 · 恢复能力演练（2026-10-12 建，挂进 tests\run.mjs）
 *
 * 为什么需要这条（审计发现，最高危的缺口）：
 *   `tests\safe-write.test.mjs` 只验"备份目录里出现了文件"，**从不验"能把备份还原回去"**。
 *   全库 grep `restore|git checkout|回滚` 在 tests 下 0 命中 —— 恢复能力**从未被演练过**。
 *   于是"有备份"和"出事能救回来"之间隔着一整层未验证的假设。
 *
 * 这条测试做什么（全程在临时目录，**不碰任何真源**）：
 *   ① 备份存在性：每个真源的 `_备份-真源\` 至少有一份（无备份的列出来供人决策）
 *   ② ★ 真实恢复演练：造一个临时"真源" → 走 `writeJsonAtomic(backup:true)` 产生备份
 *      → 破坏当前文件 → 调**真实**的 `_快照.mjs --restore` 恢复 → 断言内容与破坏前一致
 *   ③ ★ 恢复的安全网：故意恢复一份**形状错误**的 JSON → 断言被形状守卫拒绝并自动退回
 *   ④ 未知参数必须 exit 2（防"手滑参数 → 意料之外的提交"，这是真实发生过的事故）
 *
 * 断言只依赖不变量（恢复后内容逐字节相等），不写死数据条数。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
/* ★ 2026-10-23 程序与数据分家：数据在库根（LIB），工具在 src\tools（TOOLS）。 */
const E = require('./_测试环境.cjs');
let fails = 0, oks = 0;
const A = (label, cond, detail) => {
  if (cond) { oks++; console.log('  [OK]  ' + label + (detail ? '  → ' + detail : '')); }
  else { fails++; console.log('  [FAIL] ' + label + '  → ' + detail); }
};
const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16); } catch { return null; } };
const shaOfStr = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/* ─────────── ① 真源备份覆盖普查（只读）─────────── */
console.log('═══ ① 真源备份存在性普查 ═══');
const SOURCES = [
  '_组卷台账.json', '_待确认.json', '_配图台账.json', '_原卷台账.json',
  '_盲解双路.json', '_笔形台账.json', '_撤卡留档',
  ...E.findIndexes(),   /* ★ 2026-10-24 B-09：索引动态发现（原写死真实库的两个路径） */
];
const notRecoverable = [];
/* ★ 2026-10-23：git 历史要查**库所在的那个仓库**，不是开发区仓库。
   起因：`_撤卡留档` 在冻结区旧库（自身是 git 仓库）里有 3 个提交，
   但测试原先 `git -C ROOT`（ROOT=开发区）查 → 0 个 ⇒ 误报"不可恢复"。
   现在先问库根属于哪个 git 仓库，查不到就只认本地备份（新库可能还没 init git）。 */
let gitTop = null;
try {
  const r = spawnSync('git', ['-C', E.LIB, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status === 0) gitTop = String(r.stdout || '').trim() || null;
} catch { }
console.log('  库所在 git 仓库：' + (gitTop || '（无，只认本地备份）'));
for (const rel of SOURCES) {
  const abs = path.join(E.LIB, rel);
  let isDir = false;
  try { isDir = fs.statSync(abs).isDirectory(); } catch { }
  if (!fs.existsSync(abs)) { console.log('  [跳过] 不存在：' + rel); continue; }

  // ① 本地备份（写前产生；从未被写过的文件自然没有）
  const dir = isDir ? abs : path.join(path.dirname(abs), '_备份-真源');
  const key = path.basename(abs).replace(/\.json$/, '');
  const localHits = (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith(key)) : []).length;

  // ② git 历史（另一个可恢复时间点）——查库所在的仓库，路径要相对它的根
  let gitHits = 0;
  if (gitTop) {
    try {
      const relToGit = path.relative(gitTop, abs).split(path.sep).join('/');
      const out = spawnSync('git', ['-C', gitTop, 'log', '--format=%H', '--', relToGit], { encoding: 'utf8' });
      gitHits = (out.stdout || '').trim().split(/\r?\n/).filter(Boolean).length;
    } catch { }
  }

  // 判据：至少有一条可恢复路径。真正的风险是"写了很多次却两边都没有"。
  const recoverable = localHits > 0 || gitHits > 0;
  A('可恢复 · ' + rel, recoverable, '本地备份 ' + localHits + ' 份 / git 历史 ' + gitHits + ' 个提交');
  if (!recoverable) notRecoverable.push(rel);
}

/* ─────────── ② 真实恢复演练（临时目录，不碰真源）─────────── */
console.log('\n═══ ② 真实恢复演练：破坏 → 恢复 → 逐字节相等 ═══');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-restore-drill-'));
// 造一个迷你仓库，让 _快照.mjs 能真的跑 git
const mini = path.join(sandbox, 'repo');
fs.mkdirSync(mini, { recursive: true });
const dbRel = '_组卷台账.json';
const dbAbs = path.join(mini, dbRel);
const GOOD = JSON.stringify({ batches: [{ id: 'P-TEST-01', title: '演练卷' }] }, null, 2) + '\n';
const BROKEN = '{ "batches": [ {"id": "P-TEST-01"   ← 故意写坏：截断的 JSON';
fs.writeFileSync(dbAbs, GOOD, 'utf8');
const runG = (...a) => spawnSync('git', ['-C', mini, ...a], { encoding: 'utf8' });
runG('init', '-q'); runG('config', 'user.email', 'drill@local'); runG('config', 'user.name', 'drill');
runG('add', '-A'); runG('commit', '-q', '-m', 'data: 演练基线');

// 把真实的 _快照.mjs 与 _安全写.mjs 复制进来（用真脚本，不用假实现）
/* ★ 2026-10-23：工具搬到 src\tools\ 之后，_快照.mjs 会 import 同目录的 _库根.mjs 与 _安全写.mjs，
   所以三个一起复制，否则演练仓里跑起来就 ERR_MODULE_NOT_FOUND。 */
for (const f of ['_快照.mjs', '_安全写.mjs', '_库根.mjs']) {
  fs.copyFileSync(path.join(E.TOOLS, f), path.join(mini, f));
}
const runSnap = (...a) => spawnSync(process.execPath, [path.join(mini, '_快照.mjs'), ...a],
  { encoding: 'utf8', cwd: mini, env: Object.assign({}, process.env, { CTB_DATA: mini }) });

// 破坏当前文件（模拟"真源被写坏"）
fs.writeFileSync(dbAbs, BROKEN, 'utf8');
const shaBroken = sha(dbAbs);
A('演练前置：文件已被破坏', shaBroken !== shaOfStr(GOOD), '当前 sha=' + shaBroken + ' ≠ 正确 sha=' + shaOfStr(GOOD));

// 恢复
const r = runSnap('--restore', dbRel);
A('恢复命令 exit 0', r.status === 0, 'status=' + r.status + ' ' + (r.stdout || '').trim().split('\n').slice(-2).join(' | '));
A('恢复后内容与破坏前**逐字节相等**', fs.readFileSync(dbAbs, 'utf8') === GOOD, '读回内容与写入基线完全一致');
try { const j = JSON.parse(fs.readFileSync(dbAbs, 'utf8')); A('恢复后 JSON 合法且 batches 完整', j.batches && j.batches.length === 1 && j.batches[0].id === 'P-TEST-01', JSON.stringify(j.batches)); }
catch (e) { A('恢复后 JSON 合法', false, e.message); }

/* ─────────── ③ 恢复的安全网：形状错误必须被拒并自动退回 ─── */
console.log('\n═══ ③ 恢复安全网：历史版本可指定恢复，且恢复后必须过形状守卫 ═══');
// 提交一个"形状错误"的版本（合法 JSON 但 batches 不是数组），再恢复到它上面那一版
fs.writeFileSync(dbAbs, JSON.stringify({ batches: '这不是数组' }, null, 2) + '\n', 'utf8');
runG('add', '-A'); runG('commit', '-q', '-m', 'data: 形状错误的版本');
// 再提交一个正确版本作为"上一版"
fs.writeFileSync(dbAbs, GOOD, 'utf8');
runG('add', '-A'); runG('commit', '-q', '-m', 'data: 正确版本');
const cntBefore = Number(runG('rev-list', '--count', 'HEAD').stdout.trim());
const rBad = runSnap('--restore', dbRel, 'HEAD~1');    // 目标版本：batches 是字符串（形状漂移）
// 守卫应在**写入后**发现漂移并自动退回 ⇒ 落盘结果必须是正常基线，而不是那个坏版本
A('形状错误的恢复必须判红（非零退出）', rBad.status !== 0, 'status=' + rBad.status + '（守卫拦下）');
A('守卫拦下后**已自动退回**，文件内容还原为正常基线', fs.readFileSync(dbAbs, 'utf8') === GOOD, '落盘内容 == 正确基线（非坏版本）');
A('守卫拦下时明确告知已退回', /已自动退回/.test(rBad.stderr || rBad.stdout || ''), '输出含"已自动退回"');
// 把演练仓恢复成干净状态再继续
fs.writeFileSync(dbAbs, GOOD, 'utf8'); runG('add', '-A'); runG('commit', '-q', '-m', 'data: 复原');

/* ─────────── ④ 未知参数必须 exit 2（真实发生过的事故）─────────── */
console.log('\n═══ ④ 未知参数拦截（2026-10-12 真实事故的防线）═══');
const before4 = sha(dbAbs);
for (const bad of ['--restor', '--resotre', '--recover', '--undo']) {
  const r2 = runSnap(bad);
  A('未知参数 ' + bad + ' → exit 2', r2.status === 2, 'status=' + r2.status + ' 提示含"未知参数"=' + /未知参数/.test(r2.stderr || ''));
}
A('连发未知参数后文件未被改动', sha(dbAbs) === before4, 'sha 前后一致');
// 连发后 git 历史不得多出提交
const cnt = Number(runG('rev-list', '--count', 'HEAD').stdout.trim());
A('连发未知参数未产生新提交', cnt === cntBefore + 1, '提交数=' + cnt + '（预期 ' + (cntBefore + 1) + '，只多了"复原"那次）');

console.log('\nRESULT=' + (fails === 0 ? 'PASS' : 'FAIL') + ' 断言=' + (oks + fails) + (fails ? ' 失败=' + fails : '') + (notRecoverable.length ? '\n[i] 本地与 git 都无恢复路径的真源：' + notRecoverable.join(', ') : ''));
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { }
process.exit(fails === 0 ? 0 : 1);