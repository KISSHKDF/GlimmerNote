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
 * 退出码（**权威真源就是这个列表**；tests\run.mjs 与 .githooks\pre-commit 都按它分支，
 *   消费侧的唯一判据在 tests\_测试环境.cjs 的 `classifyVerifyDeploy()`，别在调用方各抄一份）：
 *   0 = 一致（运行区就是清单里那一版）                                  → 通过
 *   1 = 漂移（有文件被改/增/删，或版本号与清单不符）                      → 阻断
 *   2 = 用法错误（参数不认识）                                          → 阻断（fail-closed）
 *   3 = **本机没有运行区**（没有 <运行区> 目录，或其中没有 app\）        → 唯一可豁免：无法评估 ≠ 有漂移
 *   4 = **清单损坏 / 形状不对**（有清单但读不懂：JSON 解析失败、缺 files 字典…）→ 阻断
 *   5 = 运行区在、但尚无清单（建立本机制之前部署的历史状态）              → 阻断（走一次正规部署建基线）
 *
 * ★ 2026-10-31 E03 整改（外部复核已证实）：改前 3(清单损坏) 与「没有运行区」**共用 exit 2**，
 *   于是两个调用方把所有 exit 2 都当"这机器没运行区"放行 ⇒ **清单损坏 = fail-open**
 *   （实测：损坏 manifest → exit 2 → pre-commit 返回 0 允许提交；对照组 rc=1 才拦）。
 *   现在"没有运行区"独占 exit 3，"清单损坏"独占 exit 4，且消费侧只有 3 可豁免。
 *   为什么要拆：两者的**处置方向完全相反** —— 没有运行区是"这台机器没这东西"（什么都不用做），
 *   清单损坏是"基线读不懂"（说明有人动过它，或写到一半崩了），把它当"没有"放行等于
 *   把"删除/损坏清单"变成通过门禁的捷径，闸门就废了。
 *   同理 5(尚无清单) 也不再豁免：无法证明运行区等于某个发布包就是"没通过"，
 *   建基线只有一条路——走一次正规 build-release.ps1 → deploy.ps1。
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

/* ---- 退出码常量（与头部注释逐条对应；改这里必须同步改注释与两个调用方） ---- */
const RC = { OK: 0, DRIFT: 1, USAGE: 2, NO_RUNTIME: 3, BAD_MANIFEST: 4, NO_MANIFEST: 5 };

/* ---- 参数 ---- */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const KNOWN_FLAGS = new Set(['--json', '--quiet', '--prod']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--prod') { i++; continue; }                      // 吃掉它的值
  if (!KNOWN_FLAGS.has(a)) {
    /* 用法错误必须响亮：静默忽略未知参数会让"--prod 拼错"变成"去查默认运行区"，
       得到的是一个**看起来正常、其实在查另一个目录**的结论（比报错危险得多）。 */
    console.error('✖ 未知参数：' + a + '\n  可用：--json / --quiet / --prod <运行区>');
    process.exit(RC.USAGE);
  }
}
const JSON_OUT = has('--json');
const QUIET = has('--quiet');

const PROD = path.resolve(valOf('--prod', path.join(REPO, '..', 'GlimmerNote')));
const APP = path.join(PROD, 'app');
const MANIFEST = path.join(PROD, '_deploy-manifest.json');

const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
/* ⚠ 2026-10-25（首次部署实测）：清单由 PowerShell 的 Get-FileHash 写，输出**大写**十六进制；
   而 node crypto 的 digest('hex') 是**小写**。直接比较会 45/45 全报"被改过"——假阳。
   判据只在大小写不敏感时相等，所以统一转大写后比较（与 deploy.ps1 侧同口径）。 */
const sameHash = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
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

/* ---- 环境 ----
 * ★ 2026-10-31 E03：这两个分支才是「本机没有运行区」，独占 exit 4（唯一可豁免的码）。
 *   不要再和"清单损坏"共用同一个码 —— 那正是本轮缺陷的根因。 */
if (!fs.existsSync(PROD)) die(RC.NO_RUNTIME, '✖ 本机没有运行区：' + PROD, {
  hint: '这是新克隆 / 换机 / CI 的**预期状态**（无法评估 ≠ 有漂移），门禁会显示跳过。',
});
if (!fs.existsSync(APP)) die(RC.NO_RUNTIME, '✖ 运行区里没有 app\\：' + APP, {
  hint: '运行区存在但没有程序目录 ⇒ 等同于"没有运行区"（还没部署过），门禁会显示跳过。',
});

/* ---- 清单 ----
 * ★ 2026-10-31 E03：清单"读不懂"必须与"没有清单"分开，且**一律 fail-closed**（exit 3）。
 *   处置方向相反：无清单 = 历史状态（走一次正规部署即可建基线）；
 *   损坏 = 有人动过它 / 写到一半崩了 ⇒ 绝不能当成"没有运行区"放行。 */
if (!fs.existsSync(MANIFEST)) {
  die(RC.NO_MANIFEST, '运行区尚无部署清单（' + path.basename(MANIFEST) + '）', {
    hint: '这是建立本机制之前部署的历史状态，无法证明运行区等于某个发布包。\n' +
      '  正确做法：走一次正规链路 build-release.ps1 → deploy.ps1，由部署脚本写入基线。\n' +
      '  （在此之前不要用拷贝方式"补"清单——那样等于自证清白，闸门就废了。）',
  });
}

let man;
try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, '')); }
catch (e) { die(RC.BAD_MANIFEST, '✖ 清单解析失败（这份基线读不懂，按 fail-closed 阻断）：' + e.message, {
  hint: '清单由 deploy.ps1 / rollback.ps1 写入，正常不会坏。出现这种状态通常是：手工改过它、\n' +
    '  或写清单的进程被杀。不要用"删掉清单"让门禁变绿（那会把"损坏"变成"没有运行区"）。\n' +
    '  恢复方式：重新走一次正规部署（build-release.ps1 → deploy.ps1）重建基线。',
}); }
if (!man || typeof man !== 'object' || Array.isArray(man)) {
  die(RC.BAD_MANIFEST, '✖ 清单形状不对（顶层不是对象）', { hint: '同上：这是"基线读不懂"，不是"没有运行区"。' });
}
if (!man.files || typeof man.files !== 'object' || Array.isArray(man.files)) {
  die(RC.BAD_MANIFEST, '✖ 清单形状不对（缺 files 字典）', {
    hint: '同上：这是"基线读不懂"，不是"没有运行区"。清单必须含 { files: { <相对路径>: <sha256> } }。',
  });
}
if (!Object.keys(man.files).length) {
  die(RC.BAD_MANIFEST, '✖ 清单形状不对（files 为空字典）', {
    hint: '空清单等于"任何文件都算凭空多出"，无法作为基线；同样按损坏处理。',
  });
}

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
  else if (!sameHash(actual[rel], hash)) changed.push(rel);
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
  process.exit(ok ? RC.OK : RC.DRIFT);
}

if (ok) {
  if (!QUIET) {
    console.log('✔ 运行区与部署清单一致（' + (man.zip || '?') + ' / ' + man.version +
      ' / ' + (man.deployedAt || '?') + ' / ' + Object.keys(actual).length + ' 个文件逐字节相符）');
  }
  process.exit(RC.OK);
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
process.exit(RC.DRIFT);
