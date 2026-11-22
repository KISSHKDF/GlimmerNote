#!/usr/bin/env node
/**
 * 阴性用例（2026-11-23，审计 D-04 · P1）：快照恢复的**防掏空校验**对全部纳管台账真有效。
 *
 * 缺陷（修前）：
 *   ① 关键字段名写错：_盲解双路 写成 cards（真源顶层是 lanes）、_配图台账 写成 figures（真源是 cards）；
 *   ② countOf 只认"数组"或"对象包 items[]"，而 _原卷台账.cards / _原图台账.objects /
 *      _盲解双路.lanes / _配图台账.cards 的值是**裸对象**（{ "<key>": {...} }）⇒ 恒计 0。
 *   后果：这些台账被**掏空**（顶层键名与类型都没变）也照样"恢复通过"。
 *
 * 本用例（restore-drill 同款：临时迷你 git 仓 + 真 _快照.mjs）：
 *   对每份关键台账：基线（N 条）→ 提交 → 掏空（同形状 0 条）→ 提交 →
 *   `--restore <文件> <基线hash>` 恢复**掏空版** ⇒ 必须判红并自动退回。
 *   另加阴性自证：把字段表/countOf 改回旧逻辑 ⇒ 至少一个台账的掏空恢复放行（判据有牙齿）。
 *
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const E = require('./_测试环境.cjs');
let fails = 0, total = 0;
const A = (n, ok, d) => {
  total++;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 200) : ''}`);
  if (!ok) fails++;
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-snap-emptied-'));
const mini = path.join(sandbox, 'repo');
fs.mkdirSync(mini, { recursive: true });
for (const f of ['_快照.mjs', '_安全写.mjs', '_库根.mjs']) {
  fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(mini, f));
}
const runG = (...a) => spawnSync('git', ['-C', mini, ...a], { encoding: 'utf8' });
runG('init', '-q'); runG('config', 'user.email', 'drill@local'); runG('config', 'user.name', 'drill');
const runSnap = (...a) => spawnSync(process.execPath, [path.join(mini, '_快照.mjs'), ...a],
  { encoding: 'utf8', cwd: mini, env: Object.assign({}, process.env, { CTB_DATA: mini }) });

/* 每份台账的形状工厂：n 条内容、掏空时保持同形状 */
const SHAPES = {
  '_原卷台账.json': n => ({ version: 1, generatedAt: '2026-11-23T00:00:00+08:00', note: '', cards: Object.fromEntries(Array.from({ length: n }, (_, i) => ['c' + i, { page: 'p.jpg', bbox: [0, 0, 1, 1] }])) }),
  '_原图台账.json': n => ({ version: 1, note: '', generatedAt: 'x', objects: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i).padStart(8, '0') + '.jpg', { sha: 'x' }])) }),
  '_盲解双路.json': n => ({ note: '', lanes: Object.fromEntries(Array.from({ length: n }, (_, i) => ['lane' + i, { status: 'done' }])) }),
  '_配图台账.json': n => ({ note: '', updatedAt: 'x', cards: Object.fromEntries(Array.from({ length: n }, (_, i) => ['学生甲|M' + String(i + 1).padStart(4, '0'), { need: true, kind: 'jpg', ref: '题图.jpg' }])) }),
};
delete SHAPES['_盲解双路-复核用.json'];

const N = 5;
for (const [rel, shape] of Object.entries(SHAPES)) {
  const abs = path.join(mini, rel);
  /* 基线（富）：提交；掏空版：也提交（它是要被恢复的"历史版本"）。
     场景：用户/工具想恢复到**掏空的那一版**（比如误提交了掏空版后又被它排到最近）。
     恢复源 = 掏空版 hash；防掏空校验的分母取历史里"最富"的基线 ⇒ 必须拦下并退回。 */
  fs.writeFileSync(abs, JSON.stringify(shape(N), null, 1), 'utf8');
  runG('add', '-A'); runG('commit', '-q', '-m', 'data: 富基线 ' + rel);
  fs.writeFileSync(abs, JSON.stringify(shape(0), null, 1), 'utf8');
  runG('add', '-A'); runG('commit', '-q', '-m', 'data: 掏空版 ' + rel);
  const emptiedHash = runG('rev-parse', 'HEAD').stdout.trim();

  /* 恢复"掏空版"：防掏空校验必须拦下并自动退回（退回目标 = 恢复前的当前内容 = 掏空版本身） */
  const r = runSnap('--restore', rel, emptiedHash);
  const outAll = String(r.stdout || '') + String(r.stderr || '');
  const restored = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const blocked = r.status !== 0 && Object.keys(restored.cards ?? restored.objects ?? restored.lanes ?? {}).length === 0;
  A('★ ' + rel + '：恢复掏空版（' + N + '→0 条）被拦下（exit≠0）且文件退回恢复前状态', blocked,
    'exit=' + r.status + ' 输出=' + outAll.replace(/\s+/g, ' ').slice(0, 110));

  /* 复原到富基线，进入下一个台账 */
  fs.writeFileSync(abs, JSON.stringify(shape(N), null, 1), 'utf8');
  runG('add', '-A'); runG('commit', '-q', '-m', 'data: 复原 ' + rel);
}

/* ══ 阴性自证：把字段表与 countOf 改回旧逻辑 ⇒ 掏空恢复必须放行（判据有牙齿）══ */
console.log('\n══ 阴性自证：变异体（旧字段表 + 旧 countOf）必须放行掏空恢复 ══');
{
  let src = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_快照.mjs'), 'utf8');
  /* 变异 ①：字段表改回旧名（_盲解双路: cards） */
  const mutA = src.replace("'_盲解双路.json': ['lanes'],", "'_盲解双路.json': ['cards'],");
  if (mutA === src) { A('变异锚点①（字段表）存在', false, '字段表行被改过，请同步锚点'); }
  /* 变异 ②：countOf 退回旧逻辑（去掉裸对象分支）——锚点取"if (hasItemsSub) return n;" */
  const mutB = mutA.replace('            if (hasItemsSub) return n;\n            return Object.keys(v).length;', '            if (hasItemsSub) return n;\n            return 0;');
  if (mutB === mutA) { A('变异锚点②（countOf 裸对象分支）存在', false, 'countOf 被改过，请同步锚点'); }
  const mini2 = path.join(sandbox, 'repo-mut');
  fs.mkdirSync(mini2, { recursive: true });
  for (const f of fs.readdirSync(mini)) {
    const p = path.join(mini, f);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(mini2, f));
    else fs.cpSync(p, path.join(mini2, f), { recursive: true });
  }
  /* 变异体替换 _快照.mjs（注意：repo-mut 的 git 是从 repo 复制的 .git，历史一致） */
  fs.writeFileSync(path.join(mini2, '_快照.mjs'), mutB, 'utf8');
  const runSnapM = (...a) => spawnSync(process.execPath, [path.join(mini2, '_快照.mjs'), ...a],
    { encoding: 'utf8', cwd: mini2, env: Object.assign({}, process.env, { CTB_DATA: mini2 }) });
  const rel = '_盲解双路.json';
  const abs = path.join(mini2, rel);
  const shape = SHAPES[rel];
  fs.writeFileSync(abs, JSON.stringify(shape(N), null, 1), 'utf8');
  g2(mini2, 'add', '-A'); g2(mini2, 'commit', '-q', '-m', 'data: 富基线');
  const emptiedHash0 = '';
  fs.writeFileSync(abs, JSON.stringify(shape(0), null, 1), 'utf8');
  g2(mini2, 'add', '-A'); g2(mini2, 'commit', '-q', '-m', 'data: 掏空版');
  const emptiedHash = g2(mini2, 'rev-parse', 'HEAD').stdout.trim();
  /* 与主场景一致：恢复目标 = 掏空版。真实现拦（exit≠0）；变异体（lanes 按 cards 计 0）
     两档校验全部失效 ⇒ 放行（exit 0，文件变成 0 条）。 */
  const rm = runSnapM('--restore', rel, emptiedHash);
  const afterMut = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const afterCount = Object.keys(afterMut.lanes ?? afterMut.cards ?? afterMut.objects ?? {}).length;
  A('★★ 变异体放行掏空恢复（旧逻辑下 lanes 按 cards 计 0 ⇒ 两档校验失效）',
    rm.status === 0 && afterCount === 0,
    'exit=' + rm.status + ' 恢复后条数=' + afterCount);
}

function g2(repo, ...a) { return spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }); }

console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${total} 失败=${fails}`);
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { }
process.exit(fails ? 1 : 0);
