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
 *   3 = **解析到的运行区路径不存在**（或存在但没有 app\）                → 唯一可豁免：无法评估 ≠ 有漂移
 *       ★ 2026-11-02 R12：措辞从"**本机**没有运行区"改为"**解析到的路径**不存在" ——
 *         本脚本的判据只能证明这一个路径不存在，证明不了"这台机器上没有运行区"
 *         （运行区完全可能在别处，只是没解析对；实测就是这样：进程没继承 GLIMMERNOTE_PROD
 *         时兜底指向不存在的目录，而本机其实有运行区）。
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
 *   node scripts\verify-deploy.mjs --prod D:\x\y   指定运行区
 *     （运行区解析顺序：--prod → 环境变量 GLIMMERNOTE_PROD → 兜底 <仓库上一级>\GlimmerNote）
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

/* ---- 运行区路径 ----
 * 解析顺序（唯一契约，与 scripts\_运行区.ps1 的 Resolve-ProdRoot 同序；改一处必须同步另一处）：
 *   ① --prod <目录>  ② 环境变量 GLIMMERNOTE_PROD  ③ 兜底 <仓库上一级>\GlimmerNote
 * ★ 2026-11-01：运行区不再保证与开发仓库同级（可以整套搬到别的盘）。原先只按
 *   「<仓库上一级>\GlimmerNote」推导 ⇒ 运行区一搬走，校验/部署/回滚/急救全部指向
 *   同一个不存在的目录。机器差异用**用户级环境变量**承载，留在仓库外。
 * ⚠ 本仓库是公开仓：这里不许写任何本机绝对路径（加目录请用 --prod / 环境变量）。
 * 空字符串按"没给"处理（setx 尾部空格、`GLIMMERNOTE_PROD=` 都退回下一档），
 * 否则会 resolve 成当前工作目录，变成一个"看着正常、其实在查别处"的结论。 */
const ENV_PROD = String(process.env.GLIMMERNOTE_PROD || '').trim();
const PROD = path.resolve(valOf('--prod', ENV_PROD || path.join(REPO, '..', 'GlimmerNote')));
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
 * ★ 2026-10-31 E03：这两个分支才是「解析到的运行区路径不存在」，独占 exit 3（唯一可豁免的码）。
 *   （本行 2026-11-01 修：原写"exit 4"，与本文件第 21 行的权威表及 `RC.NO_RUNTIME: 3` 不符。）
 *   ★ 2026-11-02 R12 文案整改：原话是「✖ **本机**没有运行区：<path>」。这句话**超出了判据能证明的范围** ——
 *   `fs.existsSync(PROD)` 只能证明「解析到的这个路径不存在」。把"路径没解析对"说成"本机没有运行区"，
 *   会把排查方向带偏（实测就是这样：那个进程没继承用户级 GLIMMERNOTE_PROD，兜底指向不存在的目录，
 *   而本机其实有运行区并通过了校验），客观上还鼓励"那就放手吧"。现在只说判据证明得了的那件事。
 *   不要再和"清单损坏"共用同一个码 —— 那正是本轮缺陷的根因。 */
if (!fs.existsSync(PROD)) die(RC.NO_RUNTIME, '✖ 解析到的运行区路径不存在：' + PROD + '（干净克隆 / 换机 / CI 的预期状态）', {
  hint: '判据只能证明这一个路径不存在，**证明不了"本机没有运行区"**：运行区可能在别处，只是没解析对。\n' +
    '  解析顺序（唯一契约）：--prod <目录> → 用户级环境变量 GLIMMERNOTE_PROD → 兜底 <仓库上一级>\\GlimmerNote。\n' +
    '  干净克隆 / 换机 / CI 里这是**预期状态**（无法评估 ≠ 有漂移），门禁会显示跳过。',
});
if (!fs.existsSync(APP)) die(RC.NO_RUNTIME, '✖ 解析到的运行区路径存在，但其中没有 app\\：' + APP, {
  hint: '解析到的路径确实在，只是里面没有程序目录 ⇒ 还没部署过，同样属于"无法评估"（门禁会显示跳过）。\n' +
    '  若"本机明明有运行区"，先把 --prod / GLIMMERNOTE_PROD 指对再跑。',
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
/* 运行期产物白名单（2026-11-12 立；**唯一真源 = `scripts\运行期产物.json`**）。
   背景：`app\` 既是"发布包镜像"，又被**运行中的程序**写——桌面壳在日志/用户数据降级落点会往
   程序目录写东西（`src\shell\CTBShellV2.cs:159-164` 的 `LogTarget` ②、`:1499` 的 wv2-profile 降级）。
   实测 2026-11-12：清单内 90 个文件 **changed=[] missing=[] verMismatch=false**，唯一差异是
   壳自己写的 `app\shell.log`（内容与 `:405` 的 `Log("pendingResolve tmp="+…)` 逐字对应，
   且 `.log` 进不了发行包——打包黑名单 + 解包复检双重排除），而门禁文案说「有人绕过 deploy.ps1
   直接改了运行区」——**超出了判据能证明的范围**，且测试驱动的壳自己就能产出它（fixture 档因此
   在本机必红、在 CI 必绿）。
   判据收窄为三条，**牙齿不削**：
     ① 只有清单文件 §patterns 显式列出的运行期产物才豁免（加一条必须说明"哪个代码路径产出它"）；
     ② 它们不进 `extra`，单列 `runtimeArtifacts`（JSON 与人类可读输出都给）；
     ③ **任何不在白名单里的多出文件仍然判红**——"有人往 app\ 里塞了东西"照样抓得住。
   ⚠ 口径曾在本文件里硬编码过一版，2026-11-12 抽成 JSON：`deploy.ps1`（备份时剔除，否则回滚会把
     它们"洗白"成基线）与 `rollback.ps1`（拷回后同样剔除）也要读同一份——同一规则多处实现必然漂。 */
const RUNTIME_ARTIFACTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '运行期产物.json');
let RUNTIME_ARTIFACTS = [];
try {
  RUNTIME_ARTIFACTS = JSON.parse(fs.readFileSync(RUNTIME_ARTIFACTS_FILE, 'utf8').replace(/^\uFEFF/, '')).patterns.map(p => new RegExp(p));
} catch (e) {
  die(RC.BAD_MANIFEST, '✖ 读不到运行期产物白名单：' + RUNTIME_ARTIFACTS_FILE, {
    hint: '它是 `scripts\\运行期产物.json`（随仓库版本化）。读不到时**不豁免任何东西**（fail-closed，宁可多报一次漂移）。原因：' + (e && e.message),
  });
}
const isRuntimeArtifact = rel => RUNTIME_ARTIFACTS.some(re => re.test(rel));

const changed = [], missing = [], extra = [], runtimeArtifacts = [];
for (const [rel, hash] of Object.entries(man.files)) {
  if (!(rel in actual)) missing.push(rel);
  else if (!sameHash(actual[rel], hash)) changed.push(rel);
}
for (const rel of Object.keys(actual)) {
  if (rel in man.files) continue;
  (isRuntimeArtifact(rel) ? runtimeArtifacts : extra).push(rel);
}

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
    checked: Object.keys(actual).length, drift, changed, missing, extra, runtimeArtifacts, verMismatch,
  }, null, 2) + '\n');
  process.exit(ok ? RC.OK : RC.DRIFT);
}

if (ok) {
  if (!QUIET) {
    console.log('✔ 运行区与部署清单一致（' + (man.zip || '?') + ' / ' + man.version +
      ' / ' + (man.deployedAt || '?') + ' / ' + Object.keys(actual).length + ' 个文件逐字节相符）');
    if (runtimeArtifacts.length) {
      console.log('  另有 ' + runtimeArtifacts.length + ' 个**运行期产物**（不参与比对，下次部署会随 app\\ 重建清掉）：' +
        runtimeArtifacts.slice(0, 5).join('、') + (runtimeArtifacts.length > 5 ? ' …' : ''));
    }
  }
  process.exit(RC.OK);
}

console.error('✖ 运行区与清单不一致');
console.error('  判据能证明的范围：清单内被改 ' + changed.length + ' / 被删 ' + missing.length +
  ' / 多出（非运行期产物）' + extra.length + (verMismatch ? ' / 版本号不符' : ''));
console.error('  运行区：' + PROD);
console.error('  清单版本：' + (man.version || '?') + '（包 ' + (man.zip || '?') + '，部署于 ' + (man.deployedAt || '?') + '）');
console.error('  实际版本：' + landedVer + (verMismatch ? '  ← 与清单不符' : ''));
if (changed.length) console.error('  被改过（' + changed.length + '）：' + changed.slice(0, 10).join('、') + (changed.length > 10 ? ' …' : ''));
if (missing.length) console.error('  被删掉（' + missing.length + '）：' + missing.slice(0, 10).join('、') + (missing.length > 10 ? ' …' : ''));
if (extra.length) console.error('  凭空多出（' + extra.length + '）：' + extra.slice(0, 10).join('、') + (extra.length > 10 ? ' …' : ''));
if (runtimeArtifacts.length) {
  console.error('  （另有 ' + runtimeArtifacts.length + ' 个**运行期产物**已按白名单豁免：' +
    runtimeArtifacts.slice(0, 5).join('、') + (runtimeArtifacts.length > 5 ? ' …' : '') + '）');
}
console.error('');
console.error('  怎么办：清单内被改/被删 ⇒ 用 `powershell -File scripts\\deploy.ps1` 重新覆盖 app\\；');
console.error('            凭空多出（非运行期产物）⇒ 查出是谁塞的，别直接删掉证据。');
console.error('  正确链路（唯一允许的路径）：');
console.error('    ① dev 改代码：<开发仓库>\\src\\…');
console.error('    ② dev 测：node tools\\lint.mjs；node tests\\run.mjs fixture（发版前 quick）');
console.error('    ③ 升版本 → git commit → powershell -File scripts\\build-release.ps1');
console.error('    ④ powershell -File scripts\\deploy.ps1 -Zip release\\GlimmerNote-<ver>-win-x64.zip');
process.exit(RC.DRIFT);
