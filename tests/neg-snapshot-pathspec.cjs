#!/usr/bin/env node
/**
 * 拾光小册 · 快照的纳管清单必须容忍「当前零匹配」的模式（2026-11-12 建）
 *
 * 事故：2026-11-08 起 `_快照.mjs` **完全不可用** —— `--dry`、真跑、恢复分支全部 exit 128：
 *     fatal: pathspec '_收件箱/**\/_来源映射.csv' did not match any files
 * 根因：纳管清单 `DATA_PATHS` 里写的是 glob，它**允许当前没有任何匹配**
 *   （收件箱清空后「来源映射.csv」就不在了），而 `git add -A -- <pattern>` 对不匹配的
 *   pathspec **会 fatal**；`git add` 又**没有** `--ignore-unmatch` 选项（实测 2.54.0：
 *   `error: unknown option 'ignore-unmatch'`，那是 `git rm`/`git checkout` 的选项）。
 * 代价：数据区连续 4 天没有快照回滚点，期间一次数据提交只能「定向手工提交」
 *   （2026-11-08 的 `c076b59` 提交信息自陈「`_快照.mjs` 当前不可用故本次为定向手工提交」）。
 * 修法：先把模式展开成**实际存在的路径**（`git ls-files` 对不匹配 pathspec 静默返回空，
 *   正好当展开器），再经 stdin 把路径表交给 add/reset/commit —— 展开后 1404 条 / 43 KB
 *   直接进 argv 会撞 Windows CreateProcess 上限（`spawnSync git ENAMETOOLONG`）。
 *
 * 本用例四条判据（全部在 %TEMP% 迷你 git 仓里跑，不碰真源、不需要真库、不需要 exe）：
 *   ① 清单含「零匹配模式」时 `--dry` 必须 exit 0；
 *   ② `--dry` 不许留下暂存；
 *   ③ 真跑必须成功，且**未跟踪的新真源要被纳入**（不许为了不报错而漏纳管）；
 *   ④ 阴性自证：把展开那一步换回旧写法 `git('add','-A','--',...DATA_PATHS)` ⇒ 必须复现非零退出。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

/* 阴性自证的变异点：必须与 `_快照.mjs` 里那一行**逐字一致**（对不上即判 FAIL，防止判据改名后自证空转）。 */
const MUTATE_FROM = "gitStdin(nulList(NAMED), 'add', '-A', ...PS_FROM_STDIN);";
const MUTATE_TO = "git('add', '-A', '--', ...DATA_PATHS);";

function setup(tag, mutate) {
  const mini = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-snap-pathspec-' + tag + '-'));
  const g = (...a) => spawnSync('git', ['-C', mini, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@local'); g('config', 'user.name', 't');
  const tracked = path.join(mini, '七年级-学生甲', '数学', 'M0001-旧卡', '错题记录.md');
  const fresh = path.join(mini, '七年级-学生甲', '数学', 'M0002-新卡', '错题记录.md');
  for (const abs of [tracked, fresh]) fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(tracked, '# M0001\n\n题干甲。\n', 'utf8');
  g('add', '-A'); g('commit', '-q', '-m', 'data: 初始');
  fs.writeFileSync(fresh, '# M0002\n\n题干乙。\n', 'utf8');   // 未跟踪的新真源
  let hit = 0;
  for (const f of ['_快照.mjs', '_安全写.mjs', '_库根.mjs']) {
    let src = fs.readFileSync(path.join(E.TOOLS, f), 'utf8');
    if (f === '_快照.mjs' && mutate) { const before = src; src = mutate(src); if (src !== before) hit++; }
    fs.writeFileSync(path.join(mini, f), src, 'utf8');
  }
  const run = (...a) => spawnSync(process.execPath, [path.join(mini, '_快照.mjs'), ...a], {
    encoding: 'utf8', cwd: mini,
    env: Object.assign({}, process.env, { CTB_DATA: mini, CTB_TXN_DIR: path.join(mini, '.txn') }),
  });
  return {
    mini, fresh, run, hit, g,
    staged: () => g('diff', '--cached', '--name-only').stdout.trim(),
    listed: () => g('ls-files', '-z').stdout.split('\0').filter(Boolean),
    subject: () => g('log', '-1', '--format=%s').stdout.trim(),
  };
}

console.log('\n══ ① 纳管清单含零匹配模式时，--dry 必须成功 ══');
{
  const t = setup('a');
  const r = t.run('--dry');
  A('--dry 退出码 0（修前 128：pathspec … did not match any files）', r.status === 0,
    'exit=' + r.status + ' ' + String(r.stderr || '').trim().split('\n').pop());
  A('识别出待快照的真源（含未跟踪的新文件）', /将快照\s*[1-9]/.test(r.stdout || ''),
    (String(r.stdout || '').trim().split('\n').pop() || '').slice(0, 80));
  A('--dry 不留暂存（展开与回退都要干净）', t.staged() === '', 'staged=' + JSON.stringify(t.staged()));
}

console.log('\n══ ② 真跑：成功，且未跟踪的新真源要被纳入 ══');
{
  const t = setup('b');
  const r = t.run();
  A('真跑退出码 0', r.status === 0, 'exit=' + r.status + ' ' + String(r.stderr || '').trim().split('\n').pop());
  A('产生一条 data: 提交', /^data: /.test(t.subject()), t.subject().slice(0, 60));
  const hitFresh = t.listed().some(p => p.includes('M0002-新卡'));
  A('★ 新真源已被纳入版本控制（不是"为了不报错而漏纳管"）', hitFresh,
    'ls-files 里错题记录.md 命中=' + t.listed().filter(p => p.includes('错题记录.md')).length);
}

console.log('\n══ ③ 阴性自证：换回旧写法必须复现缺陷 ══');
{
  const t = setup('c', src => src.replace(MUTATE_FROM, MUTATE_TO));
  A('变异点命中恰好 1 处', t.hit === 1, 'hit=' + t.hit);
  const r = t.run('--dry');
  A('旧写法下 --dry 非零退出', r.status !== 0, 'exit=' + r.status);
  A('错误正是 pathspec 不匹配', /did not match any files/.test(String(r.stderr || '') + String(r.stdout || '')),
    (String(r.stderr || '').trim().split('\n').filter(l => /pathspec/.test(l)).pop() || '').slice(0, 100));
}

console.log(`\n[neg-snapshot-pathspec] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
