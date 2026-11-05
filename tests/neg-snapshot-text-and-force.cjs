#!/usr/bin/env node
/**
 * 拾光小册 · 快照恢复：非 JSON 真源内容校验 + --force-restore 二次确认/审计
 * （2026-11-05 建，合并评审 P1-5 / P0-4 的护栏）
 *
 *  P1-5：修前内容校验整段包在 `if (/\.json$/i)` 里 ⇒ 掏空的 错题记录.md / 题干.html
 *        **不用 --force-restore 就直接恢复通过**。判据：恢复成"空/缩水过半"的文本版本 ⇒ exit 1 且自动退回。
 *  P0-4：--force-restore 无二次确认、无审计。判据：只给 --force-restore ⇒ exit 2 未动；
 *        给齐 --confirm-force=<文件名> ⇒ 放行，且 _备份-真源\_强制恢复审计.log 多一行。
 *  阴性自证：把文本校验掏掉 ⇒ 掏空版本必须被直接恢复（证明判据有牙齿）。
 *
 * 只在 %TEMP% 的迷你 git 仓里跑，不碰任何真源。退出码 0=PASS / 1=FAIL。
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

const REL = '九年级-学生甲/数学/M0001-测试/错题记录.md';
const RICH = '# M0001 测试\n\n## 题目\n\n计算 1+1。\n\n## 错因\n\n把加法当成乘法，概念混淆。\n\n## 订正\n\n1+1=2。\n';
const EMPTY = '\n\n';

function setup(tag, mutate) {
  const mini = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-snap-text-' + tag + '-'));
  const abs = path.join(mini, REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const g = (...a) => spawnSync('git', ['-C', mini, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@local'); g('config', 'user.name', 't');
  fs.writeFileSync(abs, RICH, 'utf8'); g('add', '-A'); g('commit', '-q', '-m', 'data: 正常版');
  fs.writeFileSync(abs, EMPTY, 'utf8'); g('add', '-A'); g('commit', '-q', '-m', 'data: 被掏空的版本');
  fs.writeFileSync(abs, RICH, 'utf8');   // 当前是正常内容；用户（误）要恢复到"最近一版" = 掏空版
  for (const f of ['_快照.mjs', '_安全写.mjs', '_库根.mjs']) {
    let src = fs.readFileSync(path.join(E.TOOLS, f), 'utf8');
    if (f === '_快照.mjs' && mutate) src = mutate(src);
    fs.writeFileSync(path.join(mini, f), src, 'utf8');
  }
  const run = (...a) => spawnSync(process.execPath, [path.join(mini, '_快照.mjs'), ...a],
    { encoding: 'utf8', cwd: mini, env: Object.assign({}, process.env, { CTB_DATA: mini, CTB_TXN_DIR: path.join(mini, '.txn') }) });
  const head = g('rev-parse', '--short', 'HEAD').stdout.trim();
  return { mini, abs, run, head, audit: path.join(path.dirname(abs), '_备份-真源', '_强制恢复审计.log') };
}

console.log('\n══ ① P1-5：掏空的 md 不能直接恢复 ══');
{
  const t = setup('a');
  const r = t.run('--restore', REL, t.head);
  A('恢复掏空版 ⇒ 非零退出', r.status === 1, 'exit=' + r.status + ' ' + String(r.stderr || '').trim().split('\n').pop());
  A('★ 文件自动退回为正常内容', fs.readFileSync(t.abs, 'utf8') === RICH);
  A('报错说清是"掏空"', /掏空/.test(r.stderr || ''));
  /* 正对照：恢复到正常版通过 */
  const prev = spawnSync('git', ['-C', t.mini, 'rev-parse', '--short', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(t.abs, '被写坏了', 'utf8');
  const r2 = t.run('--restore', REL, prev);
  A('对照：恢复到正常版 ⇒ exit 0 且内容一致', r2.status === 0 && fs.readFileSync(t.abs, 'utf8') === RICH, 'exit=' + r2.status);
  fs.rmSync(t.mini, { recursive: true, force: true });
}

console.log('\n══ ② P0-4：--force-restore 需要二次确认，且留审计 ══');
{
  const t = setup('b');
  const r = t.run('--restore', REL, t.head, '--force-restore');
  A('★ 只给 --force-restore ⇒ exit 2 且未动文件', r.status === 2 && fs.readFileSync(t.abs, 'utf8') === RICH, 'exit=' + r.status);
  const rw = t.run('--restore', REL, t.head, '--force-restore', '--confirm-force=别的文件.md');
  A('★ --confirm-force 文件名不符 ⇒ exit 2', rw.status === 2, 'exit=' + rw.status);
  const r2 = t.run('--restore', REL, t.head, '--force-restore', '--confirm-force=错题记录.md');
  A('给齐二次确认 ⇒ 按显式意图放行（exit 0，内容为掏空版）', r2.status === 0 && fs.readFileSync(t.abs, 'utf8') === EMPTY, 'exit=' + r2.status + ' ' + String(r2.stderr || '').slice(0, 120));
  const log = fs.existsSync(t.audit) ? fs.readFileSync(t.audit, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return {}; } }) : [];
  const st = log.map(x => x.status).join(',');
  A('★ 被拒的两次也留痕（refused ×2）', log.filter(x => x.status === 'refused').length === 2, st);
  A('★ 放行的那次"先记后做"：attempt 在前、done 在后', /attempt,done$/.test(st), st);
  const att = log.find(x => x.status === 'attempt') || {};
  A('审计行含文件与来源', att.file === REL && /git/.test(att.source || ''), JSON.stringify(att).slice(0, 160));
  fs.rmSync(t.mini, { recursive: true, force: true });
}

console.log('\n══ ②b 审计写不进 ⇒ 中止、不恢复（先记后做）══');
{
  const run2 = (mutate) => {
    const t = setup('d', mutate);
    fs.mkdirSync(t.audit, { recursive: true });      // 让审计文件路径是个目录 ⇒ appendFileSync 必失败
    const r = t.run('--restore', REL, t.head, '--force-restore', '--confirm-force=错题记录.md');
    const out = { code: r.status, content: fs.readFileSync(t.abs, 'utf8') };
    fs.rmSync(t.mini, { recursive: true, force: true });
    return out;
  };
  const ok = run2();
  A('★ 审计写不进 ⇒ 非零退出且文件未被恢复', ok.code !== 0 && ok.content === RICH, 'exit=' + ok.code);
  const ANCHOR = "catch (e) { console.error('✖ --force-restore 的审计行写不进去（' + e.message + '），按\"先记后做\"中止，未恢复任何内容。'); process.exit(1); }";
  const src = fs.readFileSync(path.join(E.TOOLS, '_快照.mjs'), 'utf8');
  A('变异锚点存在（审计失败即中止）', src.includes(ANCHOR));
  const bad = run2(s => s.replace(ANCHOR, 'catch (e) { }'));
  A('★ 阴性自证 · 去掉"写不进就中止" ⇒ 无痕恢复成功（判据有牙齿）', bad.code === 0 && bad.content === EMPTY, 'exit=' + bad.code);
}

console.log('\n══ ③ 阴性自证：掏掉文本校验 ⇒ 掏空版被直接恢复 ══');
{
  const ANCHOR = 'if (why && !forceRestore) {';
  const src = fs.readFileSync(path.join(E.TOOLS, '_快照.mjs'), 'utf8');
  A('变异锚点存在', src.includes(ANCHOR));
  const t = setup('c', s => s.replace(ANCHOR, 'if (false) {'));
  const r = t.run('--restore', REL, t.head);
  A('★ 变异体放行了掏空版（证明 ① 抓得住）', r.status === 0 && fs.readFileSync(t.abs, 'utf8') === EMPTY, 'exit=' + r.status);
  fs.rmSync(t.mini, { recursive: true, force: true });
}

console.log('\nRESULT=' + (worst ? 'FAIL' : 'PASS') + ' 断言=' + (passed + worst) + (worst ? ' 失败=' + worst : ''));
process.exit(worst ? 1 : 0);
