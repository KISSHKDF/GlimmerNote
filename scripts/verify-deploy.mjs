#!/usr/bin/env node
/**
 * 拾光小册 · 运行区部署一致性校验（唯一实现）
 *
 * 为什么要有这个文件（2026-10-25 用户要求）：
 *   用户原话：「我需要你以后只能走正确链路：dev 改 → dev 测 → build-release.ps1 打包 →
 *   deploy.ps1 部署（自动写部署记录）。如何设置，确保以后只能走这条路？」
 *   起因：AI 在修 D-063 时**直接 edit 了运行区** <运行区>\app\js\model.js，
 *   跳过了 dev 与打包；运行区于是有一套"不对应任何发布包"的代码（部署记录.txt 最后一条
 *   还是 00:53 的 2026.10.25.01）。
 *
 *   纪律不能只靠自觉 —— 闸门要能**拿出证据**。deploy.ps1 每次部署成功会写一份清单
 *   （<运行区>\_deploy-manifest.json，逐文件 sha256 + 版本 + 包名 + 时间）；本脚本重算
 *   运行区现状与清单比对：对不上 = 有人绕过了 deploy.ps1。
 *
 * 退出码（供门禁/hook 消费，约定固定）：
 *   0 = 一致（运行区就是清单里那一版）
 *   1 = 漂移（有文件被改/增/删，或版本号与清单不符）
 *   3 = 尚无清单（历史遗留：运行区是在建立本机制之前部署的）→ 需跑一次正规 deploy.ps1 建基线
 *   2 = 用法/环境错误
 *
 * 用法：
 *   node scripts\verify-deploy.mjs                 人类可读
 *   node scripts\verify-deploy.mjs --json          机器可读
 *   node scripts\verify-deploy.mjs --quiet         只在失败时输出（pre-commit 用）
 *   node scripts\verify-deploy.mjs --prod D:\x\y   指定运行区（默认 <仓库上一级>\GlimmerNote）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/* ---- 参数 ---- */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = has('--json');
const QUIET = has('--quiet');

const PROD = path.resolve(valOf('--prod', path.join(REPO, '..', 'GlimmerNote')));
const APP = path.join(PROD, 'app');
const MANIFEST = path.join(PROD, '_deploy-manifest.json');

const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const relOf = abs => path.relative(APP, abs).replace(/\\/g, '/');

function die(code, msg, extra) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(Object.assign({ ok: false, code, error: msg }, extra || {}), null, 2) + '\n');
  } else if (!QUIET || code !== 0) {
    console.error(msg);
    if (extra && extra.hint) console.error(extra.hint);
  }
  process.exit(code);
}

/* ---- 环境 ---- */
if (!fs.existsSync(PROD)) die(2, '✖ 运行区不存在：' + PROD);
if (!fs.existsSync(APP)) die(2, '✖ 运行区里没有 app\\：' + APP);

/* ---- 清单 ---- */
if (!fs.existsSync(MANIFEST)) {
  die(3, '运行区尚无部署清单（' + path.basename(MANIFEST) + '）', {
    hint: '这是建立本机制之前部署的历史状态，无法证明运行区等于某个发布包。\n' +
      '  正确做法：走一次正规链路 build-release.ps1 → deploy.ps1，由部署脚本写入基线。\n' +
      '  （在此之前不要用拷贝方式"补"清单——那样等于自证清白，闸门就废了。）',
  });
}

let man;
try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, '')); }
catch (e) { die(2, '✖ 清单解析失败：' + e.message); }
if (!man || typeof man.files !== 'object' || !man.files) die(2, '✖ 清单形状不对（缺 files 字典）');

/* ---- 现状 ---- */
const actual = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs);
    else if (e.isFile()) actual[relOf(abs)] = sha256(abs);
  }
})(APP);

/* ---- 比对 ---- */
const changed = [], missing = [], extra = [];
for (const [rel, hash] of Object.entries(man.files)) {
  if (!(rel in actual)) missing.push(rel);
  else if (actual[rel] !== hash) changed.push(rel);
}
for (const rel of Object.keys(actual)) if (!(rel in man.files)) extra.push(rel);

/* 版本号也要对得上（防"清单与 app 各自来自不同包"） */
let landedVer = '(读不到)';
try { landedVer = String(JSON.parse(fs.readFileSync(path.join(APP, '版本.json'), 'utf8').replace(/^\uFEFF/, '')).version); } catch { }
const verMismatch = man.version && landedVer !== String(man.version);

const drift = changed.length + missing.length + extra.length + (verMismatch ? 1 : 0);
const ok = drift === 0;

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    ok, prod: PROD, manifestVersion: man.version, landedVersion: landedVer,
    manifestZip: man.zip || null, deployedAt: man.deployedAt || null,
    checked: Object.keys(actual).length, drift, changed, missing, extra, verMismatch,
  }, null, 2) + '\n');
  process.exit(ok ? 0 : 1);
}

if (ok) {
  if (!QUIET) {
    console.log('✔ 运行区与部署清单一致（' + (man.zip || '?') + ' / ' + man.version +
      ' / ' + (man.deployedAt || '?') + ' / ' + Object.keys(actual).length + ' 个文件逐字节相符）');
  }
  process.exit(0);
}

console.error('✖ 运行区与部署清单不一致 —— 说明有人**绕过 deploy.ps1** 直接改了运行区');
console.error('  运行区：' + PROD);
console.error('  清单版本：' + (man.version || '?') + '（包 ' + (man.zip || '?') + '，部署于 ' + (man.deployedAt || '?') + '）');
console.error('  实际版本：' + landedVer + (verMismatch ? '  ← 与清单不符' : ''));
if (changed.length) console.error('  被改过（' + changed.length + '）：' + changed.slice(0, 10).join('、') + (changed.length > 10 ? ' …' : ''));
if (missing.length) console.error('  被删掉（' + missing.length + '）：' + missing.slice(0, 10).join('、') + (missing.length > 10 ? ' …' : ''));
if (extra.length) console.error('  凭空多出（' + extra.length + '）：' + extra.slice(0, 10).join('、') + (extra.length > 10 ? ' …' : ''));
console.error('');
console.error('  正确链路（唯一允许的路径）：');
console.error('    ① dev 改代码：<开发仓库>\\src\\…');
console.error('    ② dev 测：node tools\\lint.mjs；node tests\\run.mjs fixture（发版前 quick）');
console.error('    ③ 升版本 → git commit → powershell -File scripts\\build-release.ps1');
console.error('    ④ powershell -File scripts\\deploy.ps1 -Zip release\\GlimmerNote-<ver>-win-x64.zip');
process.exit(1);
