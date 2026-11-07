#!/usr/bin/env node
/**
 * 「`_影像备份\` 已退休」的机械证明（2026-11-06 改写；**本文件原为 `_影像备份.mjs` 的分母/覆盖率用例**）
 *
 * ══ 为什么改写 ══
 *   用户 2026-11-06 定案 **P10「一个字节一个家」**（规范 §一）：
 *     原图恰好两个家（活路径工作家 + `_原图\` 保全家）；**其它一切影像只许一个家、无备份**。
 *     `_影像备份\`（按路径镜像）既是原图的第 3 个家、又是其它影像的备份 ⇒ 冗余，退休（§3.2/§3.5 第 10 行）。
 *   于是**原来那些判据失去了对象**：分母口径、覆盖率、`--verify` 一致性、
 *   "全覆盖不乱红"……全是"镜像该不该全"的问题。**把它们的对象删掉之后，
 *   正确的做法不是让用例变成永远 SKIP 的空壳，而是把它改写成守"退休这件事本身"**：
 *   工具必须**显式拒绝执行**、必须**不创建** `_影像备份\`、源码里必须**没有任何重建镜像的实现**。
 *   （判据替换的依据："每删一条镜像判据，就要补一条新判据顶上" —— 那两条新判据
 *     "原图必须有两个家""非原图影像只能有一个家"在 `tests\neg-orig-backup-fallback.cjs`。）
 *
 * 用法：node tests\neg-image-backup-coverage.cjs
 * 退出码：0=全绿；1=有断言失败
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
const TOOL = E.tool('_影像备份.mjs');
let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = E.allocTempDir('gn-testlib-');       // 登记进退出清扫表（被杀也有兜底）
const LIB = path.join(TMP, 'lib');

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: LIB }),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

/* 一个最小库（只为证明"跑它不会在库里建出镜像目录"） */
fs.mkdirSync(path.join(LIB, '学生A', '数学', 'M0001-测试'), { recursive: true });
fs.writeFileSync(path.join(LIB, '学生A', '数学', 'M0001-测试', '原卷截图.jpg'), Buffer.alloc(32, 7));

console.log('临时库：' + LIB + '\n');

console.log('══ ① 工具显式拒绝执行（不是"找不到模块"也不是静默 exit 0）══');
{
  const r = run([]);
  A('①a 退出码 = 2（拒绝执行；沿用 --mirror 移除分支的既有风格）', r.code === 2, 'exit=' + r.code);
  A('①b 说明里写清"为什么退休"（P10 / 一个字节一个家）', /P10|一个字节一个家/.test(r.out), r.out.split('\n').filter(Boolean)[1] || '');
  A('①c 说明里给出"现在该怎么备份"（指向 `_原图.mjs`）', /_原图\.mjs/.test(r.out), '');
  A('①d 说明里点名规范出处（docs\\数据区规范.md）', /数据区规范\.md/.test(r.out), '');
}

console.log('\n══ ② 任何参数都一样拒绝（没有藏一条"还能跑"的路径）══');
{
  for (const args of [[], ['--status'], ['--verify'], ['--mirror'], ['--dry']]) {
    A('② `' + (args.join(' ') || '(无参数)') + '` ⇒ exit 2', run(args).code === 2, '');
  }
}

console.log('\n══ ③ 跑它绝不创建 `_影像备份\\` ══');
{
  A('③a 跑过五种参数之后，库里仍没有 `_影像备份\\`', !fs.existsSync(path.join(LIB, '_影像备份')),
    path.join(LIB, '_影像备份'));
  A('③b 库里除夹具外没多出任何条目', fs.readdirSync(LIB).join(',') === '学生A', fs.readdirSync(LIB).join(','));
}

console.log('\n══ ④ 源码里没有任何"重建镜像"的实现 ══');
{
  const src = fs.readFileSync(TOOL, 'utf8');
  const banned = ['mkdirSync', 'copyFileSync', 'writeFileSync', 'ensureDirs', 'copyOne', 'writeJsonAtomic', 'REBUILDABLE_RE', 'coverageVerdict'];
  const hit = banned.filter((b) => src.includes(b));
  A('④a 没有任何写盘/建目录/复制/覆盖率实现', hit.length === 0, hit.join(' ') || ('源码 ' + src.split('\n').length + ' 行'));
  A('④b 没有 import 任何库内模块（连读库的能力都不给它）', !/from\s+'\.\//.test(src), '');
  const chk = spawnSync(process.execPath, ['--check', TOOL], { encoding: 'utf8' });
  A('④c 语法自检通过', chk.status === 0, String(chk.stderr || '').split('\n')[0] || '');
}

console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}`);
process.exit(fail ? 1 : 0);
