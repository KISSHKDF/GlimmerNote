#!/usr/bin/env node
/**
 * neg-runtime-artifacts.cjs —— 「运行期产物」白名单必须**只有一份真源**（2026-11-12 立，审计 R-04）
 *
 * 事故形态：`app\` 既是"发布包镜像"、又被运行中的壳写（日志降级落点、`wv2-profile\` 降级）。
 *   · `verify-deploy.mjs` 一度把白名单**硬编码**在自己文件里；
 *   · `deploy.ps1` 备份 `_app-上一版` 时**整目录拷**（连运行期产物一起）⇒ **回滚会把它们"洗白"
 *     成基线的一部分**，此后 verify-deploy 再也报不出这类漂移；
 *   · `rollback.ps1` 拷回时同理。
 * 三处口径一旦不同，就会出现"一处豁免、另一处照旧"（本仓 L-286 族）。
 *
 * 本用例守四件事（零依赖：只读本仓源码 + 读那份 JSON）：
 *   ① `scripts\运行期产物.json` 存在、可解析、patterns 非空且都是合法正则；
 *   ② `verify-deploy.mjs` 读它（源码里出现文件名）且**不再硬编码** `^shell\.log$`；
 *   ③ `deploy.ps1` 与 `rollback.ps1` 都调用 `Remove-RuntimeArtifacts`，且该函数的定义处读同一份 JSON；
 *   ④ 行为对照：按该 JSON 编译出的正则，对一组样本的判定与预期一致（含"白名单外的文件不命中"）。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const SPEC = path.join(E.REPO, 'scripts', '运行期产物.json');
const VD = path.join(E.REPO, 'scripts', 'verify-deploy.mjs');
const DEPLOY = path.join(E.REPO, 'scripts', 'deploy.ps1');
const ROLLBACK = path.join(E.REPO, 'scripts', 'rollback.ps1');
const MANIFEST = path.join(E.REPO, 'scripts', 'deploy-manifest.ps1');

console.log('测试环境：' + E.describe());

console.log('\n══ ① 白名单真源 ══');
let spec = null;
try { spec = JSON.parse(fs.readFileSync(SPEC, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { }
A('scripts\\运行期产物.json 存在且可解析', !!spec, spec ? '' : '解析失败');
A('patterns 非空且都是合法正则', !!(spec && Array.isArray(spec.patterns) && spec.patterns.length > 0) &&
  spec.patterns.every(p => { try { new RegExp(p); return true; } catch { return false; } }),
  spec ? JSON.stringify(spec.patterns) : '');

console.log('\n══ ② verify-deploy 读真源、且不再硬编码 ══');
const vd = fs.readFileSync(VD, 'utf8');
A('★ verify-deploy.mjs 读 `运行期产物.json`', /运行期产物\.json/.test(vd), '');
A('★ verify-deploy.mjs 里**不再**硬编码 `^shell\\.log$`（防回抄）', !/\^shell\\\.log\$/.test(vd), '');

console.log('\n══ ③ deploy / rollback 都走同一个函数 ══');
const dp = fs.readFileSync(DEPLOY, 'utf8');
const rb = fs.readFileSync(ROLLBACK, 'utf8');
const mf = fs.readFileSync(MANIFEST, 'utf8');
A('★ deploy.ps1 调 Remove-RuntimeArtifacts（备份时剔除，否则回滚洗白基线）', /Remove-RuntimeArtifacts\s+-Root/.test(dp), '');
A('★ rollback.ps1 也调它（防旧备份里带着）', /Remove-RuntimeArtifacts\s+-Root/.test(rb), '');
A('函数定义在 deploy-manifest.ps1（两脚本 dot-source 的共享件）', /function\s+Remove-RuntimeArtifacts/.test(mf), '');
A('函数定义处读同一份 JSON', /运行期产物\.json/.test(mf), '');

console.log('\n══ ④ 行为对照（用真源里的正则判定样本）══');
{
  const res = spec.patterns.map(p => new RegExp(p));
  const hit = rel => res.some(re => re.test(rel));
  const cases = [
    ['shell.log', true], ['shell.log.1', true], ['wv2-profile\\x.dat', true], ['a.tmp-1234-5678', true],
    ['app.js', false], ['js\\model.js', false], ['node.exe', false], ['版本.json', false],
  ];
  for (const [rel, want] of cases) {
    A(`  ${rel} → ${want ? '命中（运行期产物）' : '不命中（发布包内容）'}`, hit(rel) === want, '');
  }
}

console.log(`\n[neg-runtime-artifacts] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
