#!/usr/bin/env node
/**
 * 错题本 2.0 · 测试门禁（唯一入口）
 *
 *   node tests\run.mjs fixture —— **零依赖自检**：只跑与环境无关的子集（不需要已构建的 exe、
 *                                不需要真实题库影像）。**新克隆 / CI / 换机后先跑这个。**
 *   node tests\run.mjs quick   —— 单元+界面回归（要求已构建的壳 exe；库指向真库时最有用）
 *   node tests\run.mjs full    —— 重编+带口重启 → 界面回归 → 写路径闭环 → 收尾干净重启
 *
 * 三种模式的分工（2026-10-24 审计后写清，见 docs\路径规范.md 与 DEFECT-REGISTRY D-051）：
 *   fixture  源文件级、纯纯函数、无外部依赖 —— 干净克隆能跑通，exit 0
 *   quick    需要 `src\shell\build.ps1` 产出的 exe（gitignored），且部分门禁校验真实卡影像
 *   full     quick + 重编 + 重启 + 写路径闭环
 * 所以"克隆完直接 quick exit 0"本架构下不成立，这是设计事实，不是缺陷；
 * 新克隆请先跑 fixture，再按 README「新克隆自检」补齐 exe 与库。
 *
 * 退出码 0=全绿；非 0=有 FAIL（发版检查单第 2 步必须 full 全绿）。
 */
import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
/* ★ 2026-10-23 程序与数据分家：测试环境收进 tests\_测试环境.cjs（唯一实现）
     REPO  = 仓库根（找 tests\、src\、VERSION.json）
     TOOLS = REPO\src\tools（业务 .mjs 现在都在这儿，不再散在仓库根）
     LIB   = 库根（数据源；默认开发机真库，只读；可用 CTB_TEST_LIB 覆盖） */
const E = require('./_测试环境.cjs');
const ROOT = E.REPO;
const mode = process.argv[2] === 'full' ? 'full' : (process.argv[2] === 'fixture' ? 'fixture' : 'quick');
const t0 = Date.now();

console.log('测试环境：' + E.describe());
if (E.isFrozen(E.LIB)) console.log('⚠ 库指向真库（冻结区）：本次只跑只读门禁；写盘类测试会自己拒绝执行');
/* ★ 2026-11-01：落到合成库必须显眼。合成库上"恢复类/证据类"断言天然不可满足
   （没有本地备份、没有 git 历史）；旧版因为真库路径写死，运行区一搬就**静默**落到这里，
   于是 quick 常态红、回归也不再对着真库跑。来源判据见 tests\_测试环境.cjs 的 LIB_SOURCE。 */
if (/fixtures/.test(String(E.LIB_SOURCE || ''))) {
  console.log('⚠ 库落到仓库自带合成库（来源=' + E.LIB_SOURCE + '）：本轮的恢复/证据类断言只反映合成库形状。');
  console.log('  要对着真库跑：设 GLIMMERNOTE_PROD 指向运行区根（或 CTB_TEST_LIB 指向 <运行区>\\数据）。');
}

/* ★ 2026-11-12 新增（审计 T-01）：**断言数对账**。
   改前 `run()` 是 `stdio:'inherit'` + 只取退出码 —— 全仓**没有任何一处解析 `RESULT=… 断言=N`**，
   于是「把某个用例的断言删光」「让它走 `RESULT=SKIP 断言=0`」与「真跑过」在门禁眼里完全一样
   （AGENTS.md 却写着"断言数以 run.mjs 输出为准"）。实测仓内确有 `RESULT=SKIP 断言=0` 形态。
   现在：捕获子进程输出（仍原样转发给终端）、解析每个用例的断言数，与随仓库版本化的
   `tests\断言基线.json` 对账 —— **只许涨不许跌**（跌 = 判据被删的典型形态）；
   没报 `断言=N` 的用例也计入"未申报"。退出前统一结算，不达标则 `process.exitCode = 1`。
   更新基线：`node tests\run.mjs --update-baseline`（会打印差异，便于提交时审阅）。 */
const BASELINE_FILE = path.join(ROOT, 'tests', '断言基线.json');
let ASSERT_BASELINE = {};
try { ASSERT_BASELINE = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8').replace(/^\uFEFF/, '')); }
catch { ASSERT_BASELINE = {}; }
const ASSERT_SEEN = {};        // script → 本轮实测断言数（取最大，容忍同文件多档）
const ASSERT_UNREPORTED = [];  // 跑了但没报 `断言=N` 的用例
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

function run(script, args = []) {
  console.log('\n═══ ' + script + ' ' + args.join(' ') + ' ═══');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', script), ...args],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  process.stdout.write(out);                     // 输出仍可见（滞后到本例结束，但完整）
  const hits = out.match(/断言=(\d+)/g);
  if (hits && hits.length) {
    const n = Number(String(hits[hits.length - 1]).replace('断言=', ''));
    ASSERT_SEEN[script] = Math.max(ASSERT_SEEN[script] || 0, n);
  } else {
    ASSERT_UNREPORTED.push(script);
  }
  return r.status ?? 1;
}

function settleAssertionBudget() {
  const names = Object.keys(ASSERT_SEEN).sort();
  const total = names.reduce((a, k) => a + ASSERT_SEEN[k], 0);
  console.log('\n────────── 断言数对账（' + mode + '）──────────');
  console.log('  本轮跑过 ' + names.length + ' 个用例、合计断言 ' + total +
    (ASSERT_UNREPORTED.length ? '、**未申报断言数 ' + ASSERT_UNREPORTED.length + ' 个**' : ''));

  if (UPDATE_BASELINE) {
    const next = Object.assign({}, ASSERT_BASELINE, ASSERT_SEEN);
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 1) + '\n', 'utf8');
    console.log('  ✔ 已更新基线：' + BASELINE_FILE + '（' + Object.keys(next).length + ' 个用例）');
    return;
  }

  const dropped = [], unknown = [];
  for (const k of names) {
    const base = ASSERT_BASELINE[k];
    if (base === undefined) { unknown.push(k + '（' + ASSERT_SEEN[k] + '）'); continue; }
    if (ASSERT_SEEN[k] < base) dropped.push(k + '：' + base + ' → ' + ASSERT_SEEN[k]);
    else if (ASSERT_SEEN[k] > base) console.log('  ↑ ' + k + ' 断言增加 ' + base + ' → ' + ASSERT_SEEN[k] + '（跑 --update-baseline 登记）');
  }
  let bad = 0;
  if (dropped.length) {
    bad++;
    console.log('  ✖ 断言数**下降**（判据被删或被改窄的典型形态）：');
    for (const d of dropped) console.log('      ' + d);
    console.log('    确认是有意删除后再跑 `node tests\\run.mjs --update-baseline` 登记。');
  }
  if (ASSERT_UNREPORTED.length) {
    bad++;
    console.log('  ✖ 有 ' + ASSERT_UNREPORTED.length + ' 个用例没报 `断言=N`（无法对账）：' +
      ASSERT_UNREPORTED.slice(0, 8).join('、') + (ASSERT_UNREPORTED.length > 8 ? ' …' : ''));
  }
  if (unknown.length) {
    console.log('  ○ 基线里还没有这些用例（首次入库请跑 --update-baseline）：' + unknown.slice(0, 8).join('、') +
      (unknown.length > 8 ? ' …' : ''));
  }
  if (bad) {
    console.log('  ✖ 断言数对账未过（fail-closed）');
    process.exitCode = 1;
  } else {
    console.log('  ✔ 断言数对账通过（无一例下降、无未申报）');
  }
}
process.on('exit', () => { try { settleAssertionBudget(); } catch (e) { console.log('断言数对账自身异常：' + (e && e.message)); process.exitCode = 1; } });


/* ════════ 运行区部署一致性（两种模式都跑，2026-10-25 用户定规）════════
 * 用户原话：「我需要你以后只能走正确链路：dev 改 → dev 测 → build-release.ps1 打包 →
 *   deploy.ps1 部署（自动写部署记录）。如何设置，确保以后只能走这条路？」
 * 起因：AI 直接 edit 了运行区 app\js\model.js，绕过打包与部署，运行区于是有一套
 *   「不对应任何发布包」的代码（部署记录.txt 最后一条还是旧版本）。
 * 判据：scripts\verify-deploy.mjs 逐文件 sha256 比对 <运行区>\_deploy-manifest.json。
 * ⚠ 放在 fixture 分支**之前**：新克隆/换机跑 fixture 时也应当知道"运行区有没有漂移"，
 *   否则这道检查只在开发机 quick/full 时存在（本仓 L-175「能绿但没人跑」的老坑）。
 *
 * ★ 2026-10-31 E03 整改：**不再自己写一套退出码分支**。
 *   改前这里把 verify-deploy 的所有 exit 2 当成"运行区不存在"放行，而 verify-deploy 同时又用
 *   exit 2 表示「清单解析失败 / 形状不对」⇒ **清单损坏被当成"这机器没有运行区"**，
 *   门禁 fail-open（实测：损坏清单 → run.mjs 不 exit，继续跑完全绿）。
 *   现在退出码在 verify-deploy 头部注释里定义、判据收在 `_测试环境.cjs` 的
 *   `classifyVerifyDeploy()` 一个函数里，本文件与 .githooks\pre-commit 都调它
 *   （两份 if/else 必然漂移，见 L-286）。只豁免 NO_RUNTIME。
 */
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-deploy.mjs'), '--quiet'], { encoding: 'utf8', cwd: ROOT });
  const code = r.status == null ? 1 : r.status;
  const v = E.classifyVerifyDeploy(code);
  if (v.action === 'pass') {
    /* --quiet 下成功时 stdout 是空的（pre-commit / CI 用），所以括号要按需省略，
       否则会打出 `✔ 运行区与部署清单一致（）` 这种看着像"细节丢了"的行。 */
    const detail = String(r.stdout || '').trim().split('\n')[0];
    console.log('\n✔ 运行区与部署清单一致' + (detail ? '（' + detail + '）' : '（verify-deploy exit 0）'));
  } else if (v.action === 'skip') {
    /* ★ 2026-11-02 R12：后半句原来写"只在有运行区的机器上生效"——那是**越界表述**：
       exit 3 的判据只能证明"解析到的那个路径不存在"，证明不了"本机没有运行区"
       （运行区可能搬到了别处、只是没解析对，见 docs\发布链路.md 的运行区解析契约）。 */
    console.log('\n○ ' + v.label + '（verify-deploy exit ' + v.code + '）——无法评估 ≠ 有漂移；判据只证明解析到的那个路径不存在');
  } else if (v.action === 'block') {
    console.log('\n' + String(r.stderr || r.stdout || '').trim());
    console.log('✖ ' + v.label + '（verify-deploy exit ' + v.code + '）——不一致/读不懂都必须先归位再发版');
    if (v.code === E.VERIFY_DEPLOY_CODES.BAD_MANIFEST) {
      console.log('  清单损坏不等于"本机没有运行区"：这是 fail-closed 情形，禁止用"删掉清单"让门禁变绿。');
    } else if (v.code === E.VERIFY_DEPLOY_CODES.NO_MANIFEST) {
      console.log('  建立基线只有一条路：走一次正规 scripts\\build-release.ps1 → scripts\\deploy.ps1。');
    } else if (v.code === E.VERIFY_DEPLOY_CODES.DRIFT) {
      console.log('  正确链路：dev 改 → dev 测 → build-release.ps1 → deploy.ps1（不要直接改运行区）。');
    }
    process.exit(1);
  } else {
    /* 判据只产出 pass/skip/block 三种；出现第四种说明判据被改坏了。
       这里必须 fail-closed —— "不认识的判定结果"绝不能被当成"通过"。 */
    console.log('\n✖ 未知的部署一致性判定结果：' + JSON.stringify(v) + '（fail-closed）');
    process.exit(1);
  }
}

/* ════════ 真库零写入断言（2026-10-29 R2 新增）════════
 * 红线 2：`数据\` 是用户的，任何脚本都不得写它。本轮审计实测：`_状态.json` 在**门禁运行中**
 *   被 `生成状态.mjs` 重写（属派生缓存，但违反红线的字面口径）。"没人报"的原因是没人验 ——
 *   所以把它变成**每次 quick 都会结账**的机器结论：
 *     ① 跑之前给真库（`_测试环境.cjs` 解析出的库根）每个文件记 size+mtime，文本类再算 sha256；
 *     ② 跑完复算，**任何变化都打印是哪个文件**；文件消失/新增同样报；
 *     ③ 派生缓存（`_状态.json`）被重写 → **显式打印告警 + 派生写入清单**，不判红。
 *        依据两条：它是可再生的派生件；且 `tests\neg-server-get-readonly.cjs` 会**故意**改它
 *        （删掉 `_pendingSrc` 再验证"变了才刷"）—— 判红会让 quick 永久红。**"允许"不等于"静默"**：
 *        清单打在屏幕上，结论也写进本轮报告。
 *     ④ 其余任何文件变化（真源/索引/台账/题干/图片…）→ 判红并列出文件。
 * ⚠ 用 `process.on('exit')` 兜底：门禁中段有多处 `process.exit(worst)`，只有挂 exit 钩子才能
 *   保证**每条退出路径**都结账；同时又在最终汇总前显式结账一次，好让违反并进退出码。 */
const SNAP_TEXT_EXT = new Set(['.json', '.md', '.txt', '.html', '.htm', '.svg', '.css', '.js', '.mjs', '.cjs']);
const DERIVED_CACHE = new Set(['_状态.json']);
/* ★ 2026-11-03（偏差核对 P1-#3，补施工方案 §6「批次 1 风险」条漏做的那半）：
   库内的**用户数据**目录登记表。它跟 `DERIVED_CACHE` 是**相反的一侧** ——
   派生件（`_状态.json` / `_备份-真源\`）允许被重写但必须显式打印；
   用户数据**一写就判红**（红线 2：`数据\` 是用户的）。
   为什么要有这张显式名单（而不是靠"不在派生白名单里"这个默认）：
     `_录题\` 是 批次 1 新增的写入路径（`_配方.mjs 组装 --task` 落任务记录）。
     默认行为虽然正确（不在派生表 ⇒ 见到就红），但那是**隐式**的 ——
     将来谁为了让某个用例过而把它塞进 `DERIVED_CACHE`，没有任何东西会拦他。
     登记在这里之后，下面的阴性自证 ⑦⑧ 会当场变红。口径与 `docs\过程文件规范.md §一`、
     `docs\录题任务契约.md §七.3` 三处一致（一处事实一个家：此处只放**机读名单**）。
   新增任何"库内合法写入"都必须先加到这张表，再加门禁 —— 顺序不能反。 */
const LIB_USER_DATA_DIRS = new Set(['_录题', '_修订']);
function libSnapshot(dir) {
  const out = new Map();
  (function walk(d, rel) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) { out.set(r, { size: -2, mtimeMs: -2, sha: null }); continue; }   // 不跟随重解析点
      if (e.isDirectory()) { walk(full, r); continue; }
      let st; try { st = fs.statSync(full); } catch { out.set(r, { size: -1, mtimeMs: -1, sha: null }); continue; }
      let sha = null;
      if (SNAP_TEXT_EXT.has(path.extname(e.name).toLowerCase()) && st.size <= 16 * 1024 * 1024) {
        try { sha = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); } catch { }
      }
      out.set(r, { size: st.size, mtimeMs: st.mtimeMs, sha });
    }
  })(dir, '');
  return out;
}
/* ── 目录级判据（2026-11-03 新增）──
 * 为什么必须有：上面的 `libSnapshot` **只记文件**，于是"空目录被建/被删"对「真库零写入」断言
 *   **完全透明**。实测后果：`tests\neg-server-bom.cjs` 每轮 quick 都在真库根建一次 `_probe\`
 *   （`mkdirSync` + 只 `unlinkSync` 文件、不删目录），门禁连续多轮全绿 —— 定案与复现见
 *   `tests\_probe-writer-forensics-20261103.md` §1/§2/§3。
 * 口径：目录**只比存在性**（新增/消失判红），**不比 mtime** —— 任何子项增删都会改父目录 mtime，
 *   拿 mtime 判红会把 `_备份-真源\` 的正常轮转整片判成违规（那是已知的派生件，见 isDerivedPath）。
 *   重解析点同文件侧：`Dirent.isDirectory()` 对符号链接/junction 为 false ⇒ 天然不跟随。 */
function libDirSnapshot(dir) {
  const out = new Set();
  (function walk(d, rel) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      out.add(r);
      walk(path.join(d, e.name), r);
    }
  })(dir, '');
  return out;
}
/** 目录集合比对（与文件同口径处置）：不在白名单上的新增/消失目录 ⇒ 判红项；在白名单上 ⇒ 派生（可见不判红） */
function diffDirSnapshot(before, after) {
  const added = [], gone = [], derived = [];
  for (const r of after) { if (before.has(r)) continue; (isDerivedPath(r) ? derived : added).push(r); }
  for (const r of before) { if (after.has(r)) continue; (isDerivedPath(r) ? derived : gone).push(r); }
  return { added, gone, derived };
}
let LIB0 = null, libChecked = false, LIB0_DIRS = null;
/* 跑前的**内容副本**目录：语义等价判据需要拿跑前的原文跟跑后逐字段比。
 * 只复制门禁会重点盯的那两类文件（台账 + 各学生索引），不复制整库 —— 快且省心。
 * 放临时目录，退出时清掉（它是测试产物，不许留在用户库或仓库里）。 */
const LIB_SNAP_DIR = path.join(os.tmpdir(), 'gn-libsnap-' + process.pid);
const SEMANTIC_SNAP_FILES = ['_组卷台账.json'];
/* 快照文件名 → 原相对路径。**用显式映射，不靠字符串猜**：
 * 目录名里本来就可能有下划线（猜分隔符会把 `a__b` 还原错）。 */
const LIB_SNAP_INDEX = new Map();
function snapshotSemanticFiles(dir) {
  try { fs.rmSync(LIB_SNAP_DIR, { recursive: true, force: true }); } catch { }
  try { fs.mkdirSync(LIB_SNAP_DIR, { recursive: true }); } catch { }
  LIB_SNAP_INDEX.clear();
  let n = 0;
  for (const rel of SEMANTIC_SNAP_FILES) {
    const src = path.join(dir, rel);
    if (!fs.existsSync(src)) continue;
    const name = 'snap' + (n++) + '__' + rel.replace(/[\\/]/g, '_');
    try { fs.copyFileSync(src, path.join(LIB_SNAP_DIR, name)); } catch { continue; }
    LIB_SNAP_INDEX.set(name, rel);
  }
  /* 各学生索引：路径有层级（九年级\_索引.json、九年级\数学\_索引.json…） */
  (function walk(d, rel) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (e.name !== '_索引.json') continue;
      const name = 'snap' + (n++) + '__' + r.replace(/[\\/]/g, '_');
      try { fs.copyFileSync(full, path.join(LIB_SNAP_DIR, name)); } catch { continue; }
      LIB_SNAP_INDEX.set(name, r);
    }
  })(dir, '');
}
function snapshotSemanticFilesWithMap(dir) { snapshotSemanticFiles(dir); }
/* ★ 2026-10-31：`_备份-真源\` 按**派生件**对待（允许但可见），与 `_状态.json` 同口径 ——
   但**只在副本库上**允许（E01-d 整改）。
   为什么必须允许：`writeJsonAtomic(..., {backup:true})` 是**写入真源时的安全机制本身**——
   任何一次合法真源写入都会在 `_备份-真源\` 留一份，轮转只留最近 8 份。
   为什么必须加条件：跑在**用户真库**上时，"备份被轮转"意味着**恢复点被吃掉**
   （实测后果：真库三个目录各被删 8 份已跟踪备份，共 24 份，删掉的是最旧的 20261025/27/28 那批）。
   改前这里是**无条件**放行 ⇒ 写路径用例吃掉真库历史备份后门禁照样全绿。
   现在判据在 `_测试环境.cjs` 的 `backupRotationAllowed()`：冻结库 ⇒ 不放行 ⇒ 走进 changed/gone 判红。
   注意口径：**只有 `_备份-真源\` 下的轮转受这条影响**；真源本身（_索引.json / 台账 / 题干…）
   一个字节都不许动 —— 这条红线没有放宽（见下面 changed/gone/added 的判据）。 */
const isBackupPath = rel => /(^|[\\/])_备份-真源[\\/]/.test(rel);
/* 库是不是冻结区（真库）：备份轮转放行、写路径用例准入都看它，只解析一次 */
const LIB_FROZEN = E.isFrozen(E.LIB);
const isDerivedPath = rel => DERIVED_CACHE.has(rel) || (E.backupRotationAllowed(LIB_FROZEN) && isBackupPath(rel));

/* ════════ 「语义等价」判据（2026-10-31 新增 / 同日 E02 整改收窄）════════
 * 为什么需要：真库零写入断言按**字节**比对，而写路径用例跑完后必然改写两个真源：
 *     ① `_组卷台账.json` —— `paperSeq` 水印**设计上只增不复用**（批次号不复用，防撞号），
 *        撤批也不回退 ⇒ 每跑一次水印必 +1 ⇒ 字节必然变；`results` 是对象属性、键序随写入顺序变。
 *     ② 各 `_索引.json` —— 撤批后重建 `reviews[]`、刷 `updatedAt`，字节顺序/字段排列可能变。
 *   这两个文件的**业务内容**在测试后是完全复原的。判据本体在 `_测试环境.cjs` 的
 *   `semanticallyEqual()`（搬过去是为了能被 tests\neg-semantic-equivalence.cjs **直接对拍**；
 *   写在 run.mjs 里 = 判据自身零用例守 = 它能宽到什么程度都没人知道）。
 *
 * ⚠ E02 的缺陷原文与修法：改前是"挑几个字段"定义整份文件的等价性
 *   （索引只取 reviewStatus/reviewCount/nextDue/errorCount/passStreak/reviews.length 七个，
 *   台账只取 paperId/status/items(已排序!)/results），于是 **22 项扰动里 11 项真损坏被判等价**：
 *   删 answerSlots、改 reviews[].result、改批次 student/subject/date、换题目顺序全被放行。
 *   现在：**递归键规范化后全量比对**（对象键排序、数组保序），显式例外只有两处且都是
 *   "摘掉后单独做单调性检查"（`_组卷台账.json` 的 paperSeq；`_索引.json` 的 updatedAt），
 *   所以"只动例外键"能被容忍，"顺手改任何业务字段"必然判不等价。
 *   其余任何真源文件，仍然按字节判红。 */
const SEMANTIC_OK_FILES = new Set(['_组卷台账.json']);
const isIndexPath = rel => /_索引\.json$/.test(rel);
function checkLibZeroWrite() {
  if (libChecked || !LIB0) return 0;
  libChecked = true;
  const after = libSnapshot(E.LIB);
  const changed = [], derived = [], gone = [], added = [], semEq = [];
  for (const [rel, a] of LIB0) {
    const b = after.get(rel);
    if (!b) { (isDerivedPath(rel) ? derived : gone).push(rel); continue; }
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || (a.sha && b.sha && a.sha !== b.sha)) {
      if (isDerivedPath(rel)) { derived.push(rel + '（' + a.size + 'B → ' + b.size + 'B' + (a.sha && b.sha && a.sha !== b.sha ? '，内容也变了' : '') + '）'); continue; }
      /* ★ 语义等价放行：业务内容确实没变，只是字节变了（键序/水印/时间戳）。
         只对白名单里的文件生效，且必须逐键比过才算数 —— 不放宽其余真源。 */
      const afterAbs = path.join(E.LIB, rel);
      const snapName = [...LIB_SNAP_INDEX.entries()].find(([, orig]) => orig === rel);
      const beforeAbs = snapName ? path.join(LIB_SNAP_DIR, snapName[0]) : '';
      if ((SEMANTIC_OK_FILES.has(rel) || isIndexPath(rel)) &&
          beforeAbs && fs.existsSync(beforeAbs) && E.semanticallyEqual(rel, beforeAbs, afterAbs)) {
        semEq.push(rel + '（字节变了但业务内容逐键一致：' + (rel === '_组卷台账.json' ? '批次/题目/状态/每题结果全等，仅 paperSeq 水印递增' : '整份索引逐键相等，仅 updatedAt 时间戳前进') + '）');
        continue;
      }
      changed.push(rel + '（' + a.size + 'B → ' + b.size + 'B' + (a.sha && b.sha && a.sha !== b.sha ? '，内容也变了' : '') + '）');
    }
  }
  for (const rel of after.keys()) if (!LIB0.has(rel)) (isDerivedPath(rel) ? derived : added).push(rel + '（新增）');
  /* ★ 2026-11-03：**目录级**判据（唯一实现在 diffDirSnapshot，见上方注释）。只比存在性，不比 mtime。 */
  const dirAdded = [], dirGone = [];
  if (LIB0_DIRS) {
    const dd = diffDirSnapshot(LIB0_DIRS, libDirSnapshot(E.LIB));
    for (const r of dd.added) dirAdded.push(r + '（目录新增）');
    for (const r of dd.gone) dirGone.push(r + '（目录消失）');
    for (const r of dd.derived) derived.push(r + '（派生目录）');
  }
  console.log('\n────────── 真库零写入断言（记录 ' + LIB0.size + ' 个文件 + ' + (LIB0_DIRS ? LIB0_DIRS.size : 0) + ' 个目录）──────────');
  if (derived.length) {
    console.log('⚠ 派生件被重写/轮转（**允许**，但必须可见，故不判红）' +
      (LIB_FROZEN ? '［⚠ 当前 LIB 是冻结区，本条本不该出现］' : '') + '：' + derived.join('、'));
    console.log('  依据：① `_状态.json` 是可再生的派生件，且 tests\\neg-server-get-readonly.cjs 会故意删它的');
    console.log('        _pendingSrc 指纹来验证"台账没变就不刷"；');
    console.log('        ② `_备份-真源\\` 是"写真源时的安全机制本身"留下的副本（writeJsonAtomic backup:true），');
    console.log('        轮转只留最近 8 份 ⇒ 任何合法真源写入都会让它增减。**"允许"不等于"静默"** —— 这就是清单。');
    console.log('        ③ 该放行**只在副本库上成立**（E01-d）：冻结库上备份轮转 = 恢复点被吃掉，走判红。');
  } else {
    console.log('✔ 派生件（_状态.json / _备份-真源\\）也未被改写');
  }
  if (semEq.length) {
    console.log('ℹ 字节变了但**业务内容一致**（写路径测试的设计行为，允许但必须可见）：');
    for (const x of semEq) console.log('   · ' + x);
    console.log('  依据：① `_组卷台账.json` 的 paperSeq 水印**设计上只增不复用**（批次号不重用，防撞号），');
    console.log('        撤批也不回退 ⇒ 跑一次写路径测试必然 +1；② `results` 是对象属性，键序随写入顺序变；');
    console.log('        ③ 索引的 reviews[] 重建同理。**判据不是"放过"，是逐字段比对过业务内容确实没变。**');
  }
  if (changed.length || gone.length || added.length || dirAdded.length || dirGone.length) {
    console.log('✖ 真库出现**非派生**变化（红线 2：任何脚本都不得写 数据\\）：');
    for (const x of changed) console.log('   · 内容/时间戳变了：' + x);
    for (const x of gone) console.log('   · 文件消失了：' + x);
    for (const x of added) console.log('   · 多出了文件：' + x);
    for (const x of dirAdded) console.log('   · 多出了目录（**空目录也算**，2026-11-03 起）：' + x);
    for (const x of dirGone) console.log('   · 目录消失了（2026-11-03 起）：' + x);
    console.log('   合法情形：该测试必须先把库复制到临时目录（见 tests\\_测试环境.cjs 的 assertWritableLib/makeTempLib）。');
    return changed.length + gone.length + added.length + dirAdded.length + dirGone.length;
  }
  console.log('✔ 真库零写入：除上面列出的派生缓存外，' + LIB0.size + ' 个文件 + ' + (LIB0_DIRS ? LIB0_DIRS.size : 0) + ' 个目录全部零变化');
  return 0;
}
if (mode !== 'fixture') {
  LIB0 = libSnapshot(E.LIB);
  LIB0_DIRS = libDirSnapshot(E.LIB);
  snapshotSemanticFilesWithMap(E.LIB);
  console.log('\n真库零写入断言：已记录 ' + LIB0.size + ' 个文件的 size+mtime（文本类另算 sha256）＋ ' +
    LIB0_DIRS.size + ' 个目录（只比存在性，不比 mtime）—— ' + E.LIB);
  process.on('exit', () => { checkLibZeroWrite(); });
}

/* ════════ fixture 模式：零依赖自检（新克隆第一步）════════
 * 2026-10-24 审计结论：`quick` 需要两样东西 ——
 *   ① `src\shell\build.ps1` 产出的 exe（被 .gitignore 挡住，克隆里没有）
 *   ② 真实题库影像（配图门禁要验证"该有图的题真拿得出图"）
 * 因此"克隆完直接 quick exit 0"在本架构下不成立。
 * 但**"新克隆完全跑不了测试"是不可接受的**：那等于所有检查都只在一台机器上存在。
 * 所以单列这个模式：只跑**证明不依赖上述两样**的子集，其余显式 SKIP 并写明原因。
 * SKIP 必须可见 —— 这是本仓门禁纪律（同 run.mjs 里其它 SKIP 的写法）。 */
if (mode === 'fixture') {
  /* 白名单不是猜的：2026-10-24 在干净克隆上用 CTB_TEST_LIB=fixtures\库-最小 逐个实跑筛出来的，
     只有这几个 exit 0。加新条目必须先在干净克隆上实测。
     ★ 2026-10-25 扩：合成库升级为「形状库」（fixtures\库-形状，11 卡铺满 8 类形状）+ 影像
     运行时物化（_测试环境 选中 fixtures 即自动生成 PNG）之后，**三道数据门禁在干净克隆上
     也能真跑了**（原先因"图不在盘上"必然 SKIP）。fixture 模式把它们从 SKIP 挪进白名单：
     干净克隆的门禁覆盖从 6 项升到 10 项——原卷台账（含 lost 豁免/box 对位路径）、
     待办证据图、配图台账三条主链路从此有真实回归。 */
  const HERMETIC = [
    ['repo-hygiene.cjs', '全仓内部痕迹机检（真实化名/内部根名 tracked 0 命中，B-09）'],
    ['neg-v2-smoke.cjs', 'v2 纯函数回归（污染/净化/fig 兜底）'],
    ['neg-shell-path.cjs', 'C# 路径包含性（源码级断言）'],
    ['neg-shell-args.mjs', 'C# 取值与参数转义（源码级断言）'],
    ['chunk-roundtrip.cjs', 'C# 分片往返逐字符相等（源码级断言）'],
    ['safe-write.test.mjs', '原子写底座自检（自带临时目录）'],
    ['neg-recipe-contract.cjs', '配方层契约（五件套/学科分派/schema 真校验/指纹/自检，纯文本资产，不需要任何库）'],
    /* ★ 2026-10-30 外部安全审计整改的护栏，全部零库依赖（只读本仓源码 / 自建 %TEMP% 夹具）：
       「加新条目必须先在干净克隆上实测」这条纪律本次**未做**（干净克隆需要重装环境），
       所以只挂进 quick/full 的 unitTests，不擅自扩 HERMETIC 白名单 —— 要扩请先按规矩实跑。 */
    ['neg-stem-sanitize.cjs', 'S01/S04 题干净化（尾部 fail-closed + CSS/SVG URL 型值全拦）'],
    ['neg-shell-source-and-reparse.cjs', 'S03/S07 壳的导航/消息来源/重解析点判据（源码级 + 真 junction 同构）'],
    ['neg-write-lock-and-txn.cjs', 'D01/D02 跨进程写锁与多文件事务（含崩溃恢复回滚）'],
    /* ★ 2026-10-31：影像备份的**分母口径**（全库扫描 − 显式声明的可重建集合）。
       守的不是"备份能不能跑"，而是"分母是不是工具自己挑的"——旧口径下 271 个库内影像
       静默不进分母、覆盖率恒 100.0%，其中 80 个 / 19.4 MB 全机无第二份副本。
       夹具全部自建在 %TEMP%（不碰真库、不依赖真实用户数据）。已按规矩在本地克隆上实测
       （`git clone --no-hardlinks` 到 %TEMP%，没有真库、没有 exe 的情形下 fixture 全绿）。
       ★ 同日补：`_原图\`（内容寻址保全库）**按内容全收、不看扩展名** —— 里面的
       `_来源映射.csv` / 某题 `.md` 是人工判读产物，不能从任何原图推出，旧口径（只看影像扩展名）
       让它们既不进分母也从未备份。
       ★ 2026-11-01：离机镜像功能整体移除（用户决策不做异盘镜像），原"镜像 sha1 判据/
       陈旧件只报告"各条与"未配镜像判红"随之删除（40 → 27 断言）。 */
    ['neg-image-backup-coverage.cjs', '「`_影像备份` 已退休」的机械证明：桩拒绝执行（exit 2）/不建目录/源码里没有重建实现（14 断言）'],
    ['neg-orig-fallback.cjs', '原图兜底寻址：路径失效后按内容从保全库找回（不判红）/内容对不上不许顶替（25 断言）'],
    /* ★ 2026-11-04（外部复核整改）：两个新用例**零库依赖**（只读本仓源码 / 自建 %TEMP% 夹具），
       已按规矩在**干净克隆**（`git clone --no-hardlinks` 到 %TEMP%，无真库、无 exe）上实测通过，
       所以可以进 HERMETIC 白名单 —— 它们守的恰好是"没有库也能判红"的那些缺陷：
       ① 壳的写闸取放配对：一次 taskConfirm 就把写闸焊死 ⇒ 界面回归一跑、写路径全堵死；
       ② 抽屉/确认框的 HTML 汇点收口：未转义的动态文本进 innerHTML。 */
    ['neg-shell-writegate.cjs', '桌面壳写闸取放必须一一配对 + 释放必须在 finally 上（18 断言，带三组阴性自证）'],
    ['neg-confirm-html-sanitize.cjs', '抽屉/确认框 HTML 汇点收口（12 载荷 + S.confirm 直测 + 富文本回归 + 阴性自证，37 断言）'],
    /* ★ 2026-11-05（合并评审整改）：两个新用例零库依赖（自建 %TEMP% 夹具 / 迷你 git 仓）。
       已在**干净克隆**（`git clone --no-hardlinks` 到临时目录，无真库、无 exe）上实测通过 —— 但实测平台是 Linux；
       Windows 干净克隆上首跑请照常核对一次（PowerShell 启动时间通道只在 Windows 上走）。 */
    ['neg-lock-migration-and-cache.cjs', '写锁旧布局迁移只在持锁后、只动本库 + 启动时间缓存随 PID 死亡作废（含阴性自证）'],
    ['neg-snapshot-text-and-force.cjs', '快照恢复：md/html 掏空不许直接恢复 + --force-restore 二次确认与审计（含阴性自证）'],
    /* ★ 2026-11-05：分流器判重护栏。零库依赖（自建 %TEMP% 夹具 + 临时库）。
       守「同一张照片重复录入必须被认出来」：台账路径命中 / 内容指纹命中 / 批次级命中，
       外加题面级跨任务去重；含正向对照（未处理过的照片不许被误藏）与阴性自证
       （摘掉批次级判据 ⇒ 同批次照片必须回到待判科清单）。 */
    ['neg-triage-dedupe.cjs', '分流器判重：路径/指纹/批次三判据 + 题面级跨任务去重（15 断言，含阴性自证）'],
    /* ★ 2026-11-05：录题入库的三道新闸门（都是真库实测踩到后补的）。
       ① 裁图空白检测（bbox 框到页边留白 ⇒ 裁出近全白图，三道门禁全绿却混进库）；
       ② figBbox 必填（hasFigure=true 却没说清"图在哪儿" ⇒ 裁不出题图.jpg）；
       ③ 配图如实登记（不能再写假的"题干.html 内联 SVG"——buildStemHtml 只包纯文本，
          永远产不出内联 SVG ⇒ 配图门禁被架空）。
       每道闸门各有自己的阴性自证（摘掉判据 ⇒ 对应断言当场变红）。 */
    ['neg-ingest-crop-and-figure.cjs', '录题入库三闸门：裁图空白检测 / figBbox 必填 / 配图如实登记（21 断言，含三条阴性自证）'],
    /* ★ 2026-11-05：原图寻址的**影像备份兜底层**。
       起因：用户清理收件箱里的"重复"照片 —— 但那些照片是 52 张卡的溯源依据（台账 page 指向它们），
       删掉就断链；当时两条找回路径都兜不住（保全库没进过、影像备份有但**根本不去查**）。
       判据：保全库查不到 ⇒ 按**同路径**去影像备份找，并**核对内容 sha**（不只看路径/字节数）。 */
    ['neg-orig-backup-fallback.cjs', 'P10「一个字节一个家」：原图必须有两个家 / 非原图影像只能有一个家（含两条阴性对照与「镜像不会回来」证明，16 断言）'],
    /* ★ 2026-11-09：变式题 Phase 1 检索工具（_变式.mjs）。零库依赖（%TEMP% 自建迷你库），
       守：确定性（--json 两次逐字节相同）/ 七条候选门禁逐条生效 / 单门禁隔离 /
       跨学生重号硬失败（BUG-05 同源）/ 两种索引形态＋fixture 形状库（旧错因码）兼容。
       顺带抓过真 bug：首版门禁读 item 层的 student/subject（真库这两个字段在包装层），
       跨学生卡静默过闸——本用例的"跨学生候选"断言即由此而来。 */
    ['verify-variant-retrieval.cjs', '变式 Phase 1：检索确定性 + 七门禁逐条 + 重号硬失败 + 形状库兼容（23 断言）'],
  ];
  const SKIPPED = [
    ['portability.cjs', '需要已构建的 src\\app\\拾光小册.exe（gitignored）'],
    ['e2e-ui.mjs / neg-v2-ui-*.cjs', '需要桌面壳 exe + 9223 调试口'],
    /* ★ 2026-11-02 R11：它已挂进 full（见下方 full 块）——fixture 里不跑，别再让这行读成"quick/full 会跑"。 */
    ['selftest-pipeline.ps1', '需要 ≥2 个发布包（release\\ / 归档\\）；已挂进 full，fixture 里不跑'],
  ];
  let worst = 0;
  for (const [name] of HERMETIC) {
    worst = Math.max(worst, run(name));
    if (worst !== 0) { console.log('✖ 零依赖自检未过（' + name + '）'); process.exit(worst); }
  }
  /* ★ 2026-10-25：三道数据门禁（干净克隆可跑版）。库来自 _测试环境 的物化合成库。
     verify-stem-shape 是普查脚本（不设退出判据），fixture 下不跑；它跑真库时也只是打印。 */
  if (!E.isFrozen(E.LIB)) {
    worst = Math.max(worst, runTool('_原卷台账.mjs', ['门禁']));
    if (worst !== 0) { console.log('✖ 原卷台账门禁未过（合成库形状与门禁口径漂移）'); process.exit(worst); }
    worst = Math.max(worst, runTool('_待确认.mjs', ['证据']));
    if (worst !== 0) { console.log('✖ 待办证据图门禁未过'); process.exit(worst); }
    worst = Math.max(worst, runTool('_配图门禁.mjs', ['门禁']));
    if (worst !== 0) { console.log('✖ 配图门禁未过'); process.exit(worst); }
    /* ★ 2026-10-25：作答契约门禁也进这份白名单。合成库里的空位题必须带 answerSlots
       （fixtures\库-形状 的 _索引.json 已补），否则干净克隆一上手就被这条门禁判红 ——
       "新克隆能跑测试"是硬要求，夹具必须跟上门禁口径（同 F-06 那一类缺陷）。 */
    worst = Math.max(worst, runTool('_作答门禁.mjs', ['门禁']));
    if (worst !== 0) { console.log('✖ 作答契约门禁未过（合成库没带逐空答案）'); process.exit(worst); }
  } else {
    console.log('\n────────── fixture 模式：数据门禁因 LIB 指向真库而跳过（quick 会以只读方式跑）──────────');
  }
  console.log('\n────────── fixture 模式：以下项因缺依赖而 SKIP（可见，不隐藏）──────────');
  for (const [what, why] of SKIPPED) console.log('  [SKIP] ' + what + '  ← ' + why);
  console.log('\n要跑全量：先在 README「新克隆自检」里补齐 exe 与真实库，再 `node tests\\run.mjs quick`。');
  console.log('✔ 零依赖自检全绿（fixture，用时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's）');
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitPort(ms) {
  const t1 = Date.now();
  while (Date.now() - t1 < ms) {
    try { const r = await fetch('http://127.0.0.1:9223/json/list'); if (r.ok) return true; } catch { }
    await sleep(700);
  }
  return false;
}

let worst = 0;
/* ════════ 目录级判据的**阴性自证**（2026-11-03 新增）════════
 * 为什么要（本仓老坑：判据自身零用例守 ⇒ 它宽到什么程度都没人知道）：
 *   补目录级判据的起因是 `tests\neg-server-bom.cjs` 每轮 quick 都在真库根建一次 `_probe\`，
 *   而旧断言只记文件 ⇒ 空目录对门禁**完全透明**（tests\_probe-writer-forensics-20261103.md §3）。
 * 做法：在 %TEMP% 上真造四种情形，要求判据分别"抓到 / 不误报"，另加两条源码级断言证明
 *   「分类函数不是死代码、判红真的会进退出码」。抓不到就判红 —— **不许只在心里认定它会红**。
 * ★ 2026-11-03 追加 ⑦⑧（偏差核对 P1-#3）：把"**往别的路径写必须仍红**"也做成机读对照 ——
 *   `_录题\` 是批次 1 新增的库内写入路径，当时只写了口径（`docs\录题任务契约.md §七.3`）没写判据；
 *   现在断言它「已登记在 `LIB_USER_DATA_DIRS`、不在派生白名单、多出一个文件会被判红」，
 *   并对照 `_状态.json` 仍按派生放行（防"顺手把放行改宽"）。
 * ⚠ 全程只碰 %TEMP%，不碰库。 */
if (mode !== 'fixture') {
  const dp = E.allocTempDir('gn-testlib-dirprobe-');
  const B = (name, ok, detail) => {
    console.log((ok ? '  ✔ ' : '  ✖ ') + name + (detail ? '  [' + detail + ']' : ''));
    return ok ? 0 : 1;
  };
  console.log('\n═══ 真库零写入 · 目录级判据阴性自证 ═══');
  fs.mkdirSync(path.join(dp, '已有', '子'), { recursive: true });
  fs.writeFileSync(path.join(dp, '已有', 'f.txt'), 'x');
  const snap0 = libDirSnapshot(dp);
  let dBad = 0;
  /* ① 凭空多一个**空**目录 ⇒ 必须抓到并指名（这正是旧判据漏掉的那一类） */
  fs.mkdirSync(path.join(dp, '_凭空多出的空目录'), { recursive: true });
  let dd = diffDirSnapshot(snap0, libDirSnapshot(dp));
  dBad += B('① 凭空多一个空目录 ⇒ 抓到并指名', dd.added.includes('_凭空多出的空目录'), JSON.stringify(dd.added));
  /* ② 已存在目录只改 mtime（子项增删）⇒ 不许误报（目录只比存在性，不比 mtime） */
  const snap1 = libDirSnapshot(dp);
  const mBefore = fs.statSync(path.join(dp, '已有')).mtimeMs;
  fs.writeFileSync(path.join(dp, '已有', '临时.txt'), 'x');
  fs.rmSync(path.join(dp, '已有', '临时.txt'));
  const mAfter = fs.statSync(path.join(dp, '已有')).mtimeMs;
  console.log('  ' + (mAfter !== mBefore ? '✔' : 'ℹ') + ' ②前置：已存在目录的 mtime ' +
    (mAfter !== mBefore ? '确实被改了' : '未变（NTFS 可能批处理，本臂退化为"存在性误报"检查）'));
  dd = diffDirSnapshot(snap1, libDirSnapshot(dp));
  dBad += B('② 已存在目录只改 mtime ⇒ 不误报', dd.added.length === 0 && dd.gone.length === 0,
    JSON.stringify([dd.added, dd.gone]));
  /* ③ 目录被删 ⇒ 必须抓到并指名 */
  fs.rmSync(path.join(dp, '已有', '子'), { recursive: true, force: true });
  dd = diffDirSnapshot(snap1, libDirSnapshot(dp));
  dBad += B('③ 目录被删 ⇒ 抓到并指名', dd.gone.includes('已有/子'), JSON.stringify(dd.gone));
  try { fs.rmSync(dp, { recursive: true, force: true }); } catch { }
  dBad += B('④ 自证夹具已清理（不落库、不落仓库）', !fs.existsSync(dp), dp);
  /* ⑤⑥ 源码级：证明分类函数**不是死代码**、判红真的会进退出码（否则补了也等于没补） */
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  dBad += B('⑤ 判红条件包含目录级两项（分类不是死代码）',
    /if \(changed\.length \|\| gone\.length \|\| added\.length \|\| dirAdded\.length \|\| dirGone\.length\)/.test(self));
  dBad += B('⑥ 目录级判红会进退出码（return 里计入）',
    /return changed\.length \+ gone\.length \+ added\.length \+ dirAdded\.length \+ dirGone\.length;/.test(self));
  /* ⑦⑧ 文件级：**"往别的路径写必须仍红"**的机读对照（施工方案 §6 批次 1 风险条要的那一条）。
     起因：`_录题\` 是批次 1 新增的库内写入路径，当时只写了口径没写判据（偏差核对 P1-#3）。
     这里用**真分类函数** `isDerivedPath`（不是另抄一份）跑两条样本：
     用户数据 ⇒ 必须落进"非派生变化"（判红）；派生件 ⇒ 仍按派生放行（证明没把放行改宽）。 */
  const clsLib = rel => (isDerivedPath(rel) ? 'derived' : 'red');
  dBad += B('⑦ 库内用户数据目录已登记且**不在**派生白名单（`_录题`）',
    LIB_USER_DATA_DIRS.has('_录题') && !DERIVED_CACHE.has('_录题') && !isDerivedPath('_录题/t-x.json'),
    'registered=' + LIB_USER_DATA_DIRS.has('_录题') + ' inDerived=' + DERIVED_CACHE.has('_录题'));
  dBad += B('⑧ 库里多出 数据\\_录题\\<taskId>.json ⇒ 必须判红（"往别的路径写仍红"）',
    clsLib('_录题/t-20261103-120000-abcdef.json') === 'red', clsLib('_录题/t-20261103-120000-abcdef.json'));
  /* ★ 2026-11-03（批次 4）：`_修订\` 是"正式写入入口"的落点（`_待确认.mjs 采用`），
     与 `_录题\` 同族 = **库内合法写入但当轮必须判红**（用户数据不是派生件）。
     登记顺序纪律同 ⑦：先加名单、再加门禁，不许为了变绿塞进 DERIVED_CACHE。 */
  dBad += B('⑦b 库内用户数据目录已登记且**不在**派生白名单（`_修订`，批次 4）',
    LIB_USER_DATA_DIRS.has('_修订') && !DERIVED_CACHE.has('_修订') && !isDerivedPath('_修订/卡/P0012/c-0123456789ab.md'),
    'registered=' + LIB_USER_DATA_DIRS.has('_修订') + ' inDerived=' + DERIVED_CACHE.has('_修订'));
  dBad += B('⑧b 库里多出 数据\\_修订\\…\\<candId>.md ⇒ 必须判红（正式写入落点也不例外）',
    clsLib('_修订/卡/P0012/c-0123456789ab.md') === 'red' && clsLib('_修订.json') === 'red',
    clsLib('_修订/卡/P0012/c-0123456789ab.md'));
  dBad += B('⑧对照 派生件 `_状态.json` 仍按派生放行（没有把放行改宽）',
    clsLib('_状态.json') === 'derived', clsLib('_状态.json'));
  if (dBad) console.log('✖ 目录级判据的阴性自证未过 —— 判据没有牙齿，等于没补');
  worst = Math.max(worst, dBad);
}
/* 数据门禁先跑：原卷台账必须每张卡都回得到「整页原卷」（2026-10-09 起）。
   判据来源显式写全，不借脚本自带默认基准（教训 L-286）。
   ★ 2026-10-23：工具从 src\tools\ 找（不再从仓库根），并显式传 CTB_DATA=LIB，
     让工具和测试读同一个库 —— 否则工具会去猜库根，跟测试看到的不是一份数据。 */
function runTool(script, args) {
  console.log('\n═══ ' + script + ' ' + args.join(' ') + ' ═══');
  const r = spawnSync(process.execPath, [E.tool(script), ...args], {
    cwd: ROOT, stdio: 'inherit', encoding: 'utf8',
    env: Object.assign({}, process.env, { CTB_DATA: E.LIB }),
  });
  return r.status ?? 1;
}
worst = Math.max(worst, runTool('_原卷台账.mjs', ['门禁']));
if (worst !== 0) { console.log('✖ 原卷台账门禁未过（有卡回不到整页原卷），先修台账再跑界面回归'); process.exit(worst); }
/* v2.5（2026-10-10）：待办证据图门禁也挂进来。
   起因：T086 的证据图路径是通配符，界面上就是一张破图（用户：「没有图形链接」），
   而这条门禁此前只在有人手动跑时才生效 ⇒ 坏数据一路漏到界面。 */
worst = Math.max(worst, runTool('_待确认.mjs', ['证据']));
if (worst !== 0) { console.log('✖ 待办证据图门禁未过（缺图/通配符/文件不在），待办会显示破图，先修再跑界面回归'); process.exit(worst); }
/* 配图门禁（v2.2）：题干提到图却没图 → 卷面印出"如图"却空着（用户 2026-10-07 的原始投诉）。
   此前只在有人手动跑时才生效，2026-10-10 挂进门禁。 */
worst = Math.max(worst, runTool('_配图门禁.mjs', ['门禁']));
if (worst !== 0) { console.log('✖ 配图门禁未过（该有图的题拿不出图），组卷会印出"如图…"却没图，先修再跑界面回归'); process.exit(worst); }
/* 作答契约门禁（2026-10-25 建）：用户同一天三条报障——答案不全 / 图上作答的题白留答题区 /
   下横线写不下答案。判据＝题干空位数（客观可数）× 卡片逐空答案登记。
   为什么必须是硬门禁：这三类缺陷**印出来才被发现**（孩子卷面/家长答案册），
   以前没有任何机器检查，只能靠用户一题一题点出来。 */
worst = Math.max(worst, runTool('_作答门禁.mjs', ['门禁']));
if (worst !== 0) { console.log('✖ 作答契约门禁未过（答案不全 / 图上作答未登记 / 横线写不下），组卷会印出残缺答案册，先修再跑界面回归'); process.exit(worst); }
/* 着重号门禁（2026-10-25 晚建）：用户指着印出来的 Y0001 说「打点能力很差，全库都是这样」。
   根因是 `.rd` 标记在 app.css 里**从来没有样式**（新旧两版都没有）⇒ 加点字被当普通字印出来。
   判据：题面要加点必须有标记 / 一字一个标记 / 标记不许写进 svg / `.rd` 必须有可见样式
   （样式被删就被这条判据当场抓住——这是这次事故唯一能自动复现的形态）。 */
worst = Math.max(worst, runTool('_着重号门禁.mjs', ['门禁']));
if (worst !== 0) { console.log('✖ 着重号门禁未过（加点字印不出来 / 一个字点两处 / 样式被删），卷面会缺"加点"这个条件，先修再跑界面回归'); process.exit(worst); }
/* 题干门禁（2026-11-07 建）：用户指着 E0017 的单题预览说「你转换出来的题干莫名其妙，谁能看得懂？
   这样的题干也能通过双盲解答？也能进库？」
   事故根因两件叠加：① **转义层套了两次**（AI 回传的 questionText 已含真标签 `<u>`，
   入库器再转义一遍 ⇒ 落盘成 `&lt;u&gt;` ⇒ 印出来是字面的 "<u>a</u>" 垃圾）；
   ② **大题指令没带进来**（只抄小题 ⇒ 题号成孤儿号，读者不知道要做什么）。
   门禁盲区：作答契约门禁查空位/答案、着重号门禁查 `.rd` 样式、配图门禁查图资产
   —— **没有任何一道门禁看"题面本身能不能读懂"**；盲解的指纹还恰恰算在乱码题面上，
   乱码反而成了"已通过"的凭据。 */
worst = Math.max(worst, runTool('_题干门禁.mjs', ['门禁']));
if (worst !== 0) { console.log('✖ 题干门禁未过（题干里有实体化标签 / 字面标签 / 标记不配对 / 孤儿题号却没带大题指令 / 语篇残篇 / 该画线却没画线），卷面会印出读不懂的题，先修再跑界面回归'); process.exit(worst); }
/* 机器通道契约（2026-10-10 建）：各工具 --json 的**外部形状**。
   起因：`_盲解复核.mjs 门禁 --json` 的信封里卡片字典在 .cards，而两个消费方都按"顶层就是字典"取值
   ⇒ 指纹新鲜度门禁在工具组卷口与 v1 首页**双双静默失效**（门禁看着在、实际永远放行）。
   形状漂移没有测试兜底 = 同一类 bug 必然复发，所以把它变成断言；--selftest 顺带自证这条断言真会红。 */
worst = Math.max(worst, run('gates-contract.mjs', ['--selftest']));
if (worst !== 0) { console.log('✖ 门禁契约漂移（有消费方会静默失效），先修再跑界面回归'); process.exit(worst); }
/* 安全写底座自检（2026-10-10 建）：原子写 + 拒绝"形状不对当空库" + 写前备份。
   起因：全库 JSON 真源都是 writeFileSync 就地截断覆盖（写一半被杀留半截），
   且 load() 用"形状不对就重置为空"兜底后又写回 ⇒ 真源可能被一次正常操作静默清空（BUG-01/02）。 */
worst = Math.max(worst, run('safe-write.test.mjs'));
if (worst !== 0) { console.log('✖ 安全写底座自检未过（真源的原子写/形状防护有问题）'); process.exit(worst); }
/* ============ 静态/单元级断言（2026-10-11 新增） ============
   起因：本轮新增了 6 条断言脚本，但**没挂进门禁 = 能绿但没人看**（同 L-175「可选工具 ≠ 机械化」）。
   这些都是纯 node、不起壳的：跑得动、够快，就全部前置为硬门禁。
   顺序：通道形状 → 原子写 → 分片往返 → 路径包含 → 服务端 4 条 → v1 注入消费 → 题干形状/指纹。 */
const unitTests = [
  ['repo-hygiene.cjs'],                // ★ 全仓内部痕迹机检（B-09：真实化名/内部根名 tracked 0 命中；fixture 模式也跑）
  ['fixtures-smoke.cjs'],            // ★ fixtures 合成库真能用（F-05：此前 fixtures\ 是空目录）
  ['portability.cjs'],                 // ★ 可搬移性（2026-10-12）：运行时代码零硬编码路径 + exe 不嵌绝对路径 + 版本资源 + 崩溃兜底 + 日志轮转
  ['restore-drill.cjs'],               // ★ 恢复能力（2026-10-12）：真实"破坏→恢复→逐字节相等"演练 + 形状守卫自动退回 + 未知参数 exit 2
  ['chunk-roundtrip.cjs'],            // C# 分片往返逐字符相等（并自证旧算法会丢字符）
  ['neg-shell-path.cjs'],             // C# 路径包含性（并自证裸 StartsWith 会放行同前缀兄弟目录）
  ['neg-server-bom.cjs'],             // BOM 剥离一致（改前裸 JSON.parse 必抛，已自证）
  ['neg-server-get-readonly.cjs'],    // GET /api/state 不得写盘
  ['neg-server-origin.cjs'],          // Origin 加固 + POST 只收 json
  ['neg-server-static-path.cjs'],     // 静态服务路径包含（同前缀兄弟目录必须 403）
  /* ★ 2026-10-29 R2（审计 H-08，两条都是原始 socket 独立复现的）：
     ① 畸形 request-target 打挂进程（8 种 target 全部 exit=1）—— 用**原始 socket** 复现，
        并含"掏掉修复必须复现崩溃"的阴性自证；
     ② 库内 junction/symlink 读到库外文件（GET /link/win.ini → 200）—— 含"掏掉 realpath
        判据必须读到库外原文"的阴性自证，外加"库根本身是 junction 时不许误伤"的回归
        （审计给的最小修法漏了这条，会把整站静态文件全判 403）。
     两个文件还各自守住同批次的服务端加固：413（按字节计）、写路径不回显 ACAO:null、
     降级必须带 degraded 标记、端口真源 端口.json（读不到 exit 2，不回退 7187）。 */
  ['neg-server-bad-target.cjs'],      // ★ H-08-A/C/D/E + SC-09：服务端入口加固（73 断言）
  ['neg-server-junction.cjs'],        // ★ H-08-B：重解析点包含性（29 断言）
  ['neg-v2-smoke.cjs'],                // ★ v2 纯函数回归（2026-10-12 补 process.exit，此前"红了也不红"）
  ['neg-pending-answer-visible.cjs'],  // ★ 2026-11-05：待办「回话可见 + 欠账可执行」（用户报障"没人看、没人懂"；29 断言 + 负向对照）
  /* ★ 2026-11-06（收口）：待办「回话分情况」判据 —— 用户每条回话归到哪一类、推出什么判定/处置。
     正例/负例（不该被认成这类的不许被认出来）/枚举合法性/不越权（撤卡·建卡必须留给人）
     + 真台账覆盖度（≥85%）。被判的判据脚本在**仓外**（agent 侧 dsh-ops\，不进本仓、不随包发布），
     缺它时本用例可见 SKIP 并给出 CTB_OPS_DIR 用法 —— 只挂 quick/full，不进 fixture/CI 白名单。 */
  ['neg-pending-reply-cases.cjs'],
  /* ★ 2026-11-06：原卷台账「迁移丢掉的溯源」两个新入口的护栏（都是零依赖：自建 %TEMP% 夹具）。
     ① page 侧影像备份兜底 + **尺寸自证**（尺寸不符必须拒绝，不许张冠李戴）；
     ② `导入历史 --from`（逐条自证 / 全键命中 / 框以裁图记录为准 / --dry 不写 / 幂等 / 坏输入 fail-closed）。
     ⚠ 暂挂 unitTests（quick/full）：HERMETIC 白名单的规矩是"必须先在干净克隆上实测"，
     本机这两条已在 %TEMP% 夹具上实测通过，干净克隆复核后再提升（见 commit 说明）。 */
  ['neg-orig-ledger-backup-page.cjs'],
  ['neg-orig-ledger-hist-import.cjs'],
  ['neg-v1-admit-consumption.cjs'],   // ★ v1 JS 必须真的引用 ADMIT/HEALTH（注入了没人读 = 等于没注入）
  ['verify-stem-13.cjs'],             // 13 张补出的题干.html 与盲解所据文本等价
  ['verify-stem-shape.cjs'],          // 全库题干形状（片段/无 BOM/无整篇文档）
  ['neg-v2-ui-dash-toast-grid.cjs'],  // ★ v2 界面回归：提示不得堆叠遮挡正文 + 右栏不得挤成一字一行（含阴性自证）
  ['neg-v2-ui-review-bank.cjs'],      // ★ v2 复习流/题库：重复入账、陈旧事件、空态两态分离、判分预告口径（51 断言 + 变异自证）
  /* ★ 2026-10-12 新增四组（审计 BUG-01~06/13/17 的护栏）：
     身份模型（kid|id 而非裸 id：组卷篮串题 / 剔除跨孩子误删 / 跳过-撤销同步 / 判分丢失死路）、
     待办门禁两通道同码、v1 题干净化、壳的 JSON 取值与参数转义。 */
  ['neg-v2-identity-and-session.mjs'], // ★ 组卷篮串题 / 判定丢失 / 跳过撤销不同步 / 剔除误删（28 断言）
  ['neg-pending-gate-parity.mjs'],     // ★ 门禁 --json 与人类模式必须同码同判（临时副本构造场景，跑完还原）
  /* ★ 2026-11-09（用户选 B：先钉根因再修数据）：应做动作映射**只能有一份**，且
     「处置」写盘前必须挡住与判定不符的取值。守的是当晚 25 条 RED 的确切形状：
     04:00 夜间链第一次吃到「不适用」条目，把 16 条登记成「无需处置」——
     根因是稽核算「不适用⇒已核销」、而 _待确认.mjs 注释另写一份「固定为无需处置」，
     两边从首次公开导入起就相反（触发点：11-08 08:57 夜间派发 MAX 20→50）。
     30 断言：映射语义 + 单一真源源码级断言 + 准入闸正/负例（含"台账没被写脏"）。 */
  ['neg-disposition-mapping.cjs'],
  ['neg-shell-args.mjs'],              // ★ 壳的取值 + 参数转义：带引号的备注必须逐字送达 node（真 node.exe 验证）
  ['neg-stem-img-fit.cjs'],            // ★ 题图不得撑破卷面/抽屉：卡片行内 max-width 必须被 !important 压住（P0035 溢出 39mm）
  /* ★ 2026-10-27（用户实测 P20261027-01：「刚组的卷打印有问题，应该是受了 M0111 的影响」）：
     三类卷面元素比纸宽——① 表内空位被按答案撑宽 ×6 列（M0111 表格 1351px/纸面 635px，右侧两列被裁）；
     ② 无空位宽表（M0066 乘方 8 列）；③ 内联 <svg> 带像素 width（物理/化学 45 张卡，10-12 只修了 img）。
     本用例守：渲染链真实性（空位真的带行内 min-width）/ CSS 封顶规则在场（删规则即红）/
     headless Edge 真排版 0 溢出 / 阴性自证（掏掉规则必须复现溢出）。 */
  ['neg-stem-table-fit.cjs'],
  /* ★ 2026-11-04（用户报障：「M0066 表格最左下角，负5分之一的3次方，打印版换行了，
     这一换行会造成很多误解，能不能不换行？」——附打印件截图：(− / 1⁄5 / )³ 三行）：
     根因不是分数自己的两行（.fr 是竖排分数，本就该两行），而是**边距被扣了两遍**：
     @page 已给 16mm 页边距，.sheet 自己又有 padding:16mm ⇒ 题干内容区只剩 542px；
     M0066 那格表达式要 46px 而只有 42px ⇒ 缺 4px ⇒ 被拆成三段。
     本用例守：渲染链真实性 / CSS 三条规则在场 / headless Edge **打印媒体**真排版
     （含分数的格 0 折行、0 溢出纸面、0 横向溢出）/ 阴性自证（撤掉修复必须复现折行与溢出）。 */
  ['neg-stem-math-nowrap.cjs'],
  /* ★ 2026-10-25（用户同一天三条报障，原话级）：「M0066 答案好像不全」「M0011 在图上写出答案，
     所以组卷时这类题目不需要再留答题区」「M0084 给出的下横线长度根本不够写答案」。
     用户明确要求"不许只改这三张卡，要变成制度"。本用例守四条：两份空位实现逐卡对拍 /
     有空的题必须逐空登记答案且条数对齐 / figure 卡不留答题区 / 横线按答案撑宽，
     并用临时库做**阴性自证**（少一条答案、图上作答未登记时必须红）。 */
  ['neg-answer-slot-contract.cjs'],
  /* ★ 2026-10-25 晚（用户指着印出来的 Y0001：「从印刷体来看，你的打点能力很差，全库都是这样」）：
     实测根因不是标错字，是 `.rd`（加点标记）在 app.css 里从来没有样式 ⇒ 加点字印成普通字。
     本用例守四段：样式画得出点 / 净化链路不吞 class / 清稿保留加点语义 / 真库无漏标，
     外加 6 条**阴性自证**（删样式、藏样式、漏标、一字点两处、标记写进 svg 都必须红）。 */
  ['neg-emphasis-mark.cjs'],
  /* ★ 2026-11-07（用户指着 E0017 的单题预览：「你转换出来的题干莫名其妙，谁能看得懂？
     这样的题干也能通过双盲解答？也能进库？」）：
     事故根因两件叠加 —— ① **转义层套了两次**（questionText 已含真标签 `<u>`，
     入库器再 escapeHtml 一遍 ⇒ 落盘成 `&lt;u&gt;` ⇒ 印出来是字面 "<u>a</u>" 垃圾）；
     ② **大题指令没带进来**（只抄小题 ⇒ 题号成孤儿号，读者不知道要做什么）。
     本用例守五段：判据能力（**含已知事故样本**）/ 判据**不误报**（数学不等号、合法内联标记、
     卡片外壳都判绿 —— 第一版写宽了会全库 590 张误报）/ 题号抽取必须命中 `( ) 3.` 形态
     （不剥行首括号就命中不了事故样本 ⇒ 自证失败）/ 入库器拒收 + 保真 / 阴性自证。 */
  ['neg-stem-readability.cjs'],
  ['neg-paper-count-and-ledger-filter.mjs'], // ★ 组卷角标/配卷屏同口径 + 台账按学生过滤 + 行可读性 + 未入账打印警告 + 回录题号 + 台账复原卷 + 操作条吸顶（75+ 断言）
  /* ★ 2026-10-24（用户报障「我给学生A出了两次试卷，发现第一次与第二次题目是一样的」）：
     实测两批交集 30/30。两层根因各一条断言：① 工具侧没有"这题最近印过"的概念 → 新增防重复组卷门禁（默认 7 天）；
     ② 入账后不清空选题篮（localStorage 持久化）→ 下次直接再印一遍。
     真跑工具（副本库，不碰真库）+ 变异自证（把 REPEAT_DAYS 掏成 0，拦截必须消失）。 */
  ['neg-paper-no-repeat.cjs'],
  /* ★ 2026-11-05（MUSE 复核整改）：_标记复习.mjs 八项守卫（F02/F03/F05/F06/F08a/F08b/F08c/F08e）。
     起因：CHANGELOG 2026.11.04.01 声称修了这 8 项，但该文件在 PR #9 的 diff 里零改动
     （blob 6adf193d… 前后相同）—— "文档说修了、代码里不存在"。本用例每项都真跑工具
     （副本库）+ 变异自证（掏掉守卫必须复现缺陷），防"只改 CHANGELOG"复发。 */
  ['neg-mark-review-gates.cjs'],
  /* ★ 2026-10-25（用户实测：第一张英语卷「组卷入账」报裸堆栈）：同一学生按学科拆多份索引
     （七年级-某学生\数学 与 英语 都指向同一个 student），findIndexFile 旧实现"取扫描序第一个"永远命中
     字母序靠前的数学，英语卷必在编号检查处 throw；前端又只留 stderr 尾部 400 字，原因行被切掉。
     修复后 subject+ids 覆盖率参与选索引；报错带索引文件定位。真跑工具（副本库 + 注入排序在前的
     同名异学科小索引）+ 变异自证（掏掉 prefer 退回旧行为必须复现事故签名）。 */
  ['neg-paper-split-subject-index.cjs'],
  /* ★ 2026-10-24（用户要求「任何时候、任何阶段都可以撤销某张试卷；撤销后题目恢复未组卷」）：
     工具侧真跑（副本库）：撤批=整卷退回（已判流水/错误次数回滚，复习态逐字段回组卷前）+
     ledger.paperSeq 水印防批次号复用（撤掉当天最大号，新卷拿更大的号；掏掉水印的变异源码复现重号）。 */
  ['neg-paper-revoke-restore.cjs'],
  ['neg-card-shape-reviews.cjs'],     // ★ 复习字段形状：reviews 元素全为对象 + 字段不得整体缺失（2026-10-16 启动崩溃 37 卡事故门禁，含阴性自证）
  /* ★ 2026-10-27：配方层（AI 方法层）是**唯一没有硬门禁兜底**的一层——它退化时的表现不是报错，
     而是"AI 输出变得略微变差"，肉眼看不出来。本用例守：五件套齐全 / 学科真分派（物理不许带英语规则）/
     schema 真校验（12 个阴性样本逐条必须被拒）/ skipped 不许空数组（装懂）/ 指纹随内容变 / 自检真能判 FAIL。
     起因：原型（work\github-publish\proto）的 schema.json 写得漂亮但运行时零校验、0 条断言，谁也没发现。 */
  ['neg-recipe-contract.cjs'],
  /* ★ 2026-10-21 新增（用户报障「办完之后还会弹出来，不能消失」）：三个缺陷叠加的护栏——
     拆条复用旧编号（重号）→ find 取到已作废那条 → results 为空被当成功。
     三条缺一条都不会复现，所以必须一起守：重号门禁 / 落库打对条目 / 编号扫描认 T1xx。 */
  ['neg-pending-dupid-resolve.mjs'],
  /* ★ 2026-10-21：反射直接调**已编译 exe** 里的 ParseResults，证明 T1xx 能被解析。
     壳是编译产物——"源码改了但 exe 还是旧的"是这类事故的常态，只读源码证明不了修复生效。 */
  ['verify-shell-parser.mjs'],
  /* ★ 2026-10-24（用户实测 BUG#1）：空库里没有任何地方能建"孩子"，新用户进门就堵死。
     本用例守三层：工具能建出合法索引 / 界面空库有「＋ 新建学生」/ 前端→壳→工具这条链接上了。
     它同时守"空库可用性"这条产品底线 —— 没有它，删掉那个按钮不会有任何门禁变红。 */
  ['neg-create-student.cjs'],
  /* ★ 2026-10-24 审计整改（D-049/D-050）：把 3 个**有效但游离**的测试挂进门禁。
     游离 = 能绿但没人跑。实测这批游离测试里有 1 个已经红了半年没人知道
     （neg-stem-backfill 把动态基线写死），所以"游离"本身就该当缺陷处理。 */
  ['neg-stem-backfill.cjs'],            // ★ 补题干后 13 张卡盲解仍有效（原游离且已红，基线改关系式）
  ['smoke-shell.mjs'],                  // ★ 壳冒烟：能起、页面能载、关得掉（5.8s）
  ['neg-v2-pagesmoke.cjs'],             // ★ v2 页面冒烟：内联题图加载 + 真实卡 C0003 补图（14.3s）
  /* ★ 2026-11-03（批次 1 收尾 + R8 整改①实机证据）：真 exe + 真 CDP 驱动录题页全流程 ——
     勾图 → 生成任务单（--task 透传，任务号上屏，记录落临时库）→ 桥级三层校验（0/2/3）→
     UI 粘回三层显示 → 人工确认写 confirmedAt → 跨任务贴错红显"不要入库"。
     同时实证 meta CSP 下 AddScriptToExecuteOnDocumentCreated 注入的桥还活着（壳模式 file://）。
     ★ 2026-11-03 补齐（B-1 回归后，34 断言）：本用例**兼守「页面在新 CSP 下还能用」** ——
     CDP `Log.enable` 收 `Log.entryAdded`，断言 security 违规 = 0（规范类提示白名单化，
     白名单就写在断言旁边），并实测「⟳ 重载界面」按钮真能 reload、证据图坏图红块真会出现。
     为什么必须由它守：CSP 违规走 `Log`（security）而**不是** `Runtime.exceptionThrown`，
     只收未捕获异常的用例对这类回归是全盲的 —— 实测漏掉过 `shell.js`/`pending.js` 两处
     内联 `onclick`/`onerror` 被自家新 CSP 打死（B-1）。
     前置：`src\app\拾光小册.exe` 已编译；缺 exe ⇒ 显式打印 `RESULT=SKIP(<原因>)`
     （SKIP ≠ FAIL，但**不许静默 exit 0**；干净克隆因此只是"跳过"，真覆盖在有 exe 的发布前那一轮）。
     只杀自己启动的那个 pid（不再按镜像名 taskkill /IM —— 那会打掉用户正开着的壳与并发用例）。 */
  ['neg-v2-ingest-task-e2e.cjs'],
  /* ★ 2026-10-28（用户截图报障「拾光小册正式版，这是什么错误？」）：某学生库 97 张卡被准入当
     「数据欠账」拦下，而它们**盲解全部已过** —— 缺的只是没人把「独立判卷」写进 answerSource。
     根因是结构性的：全仓没有任何工具写这个字段。修法：盲解工具落结论时顺带补。
     本用例守三条边界（只跑一路不写 / 两路指纹不等不写 / **已有非空值一律不覆盖**），
     在自建合成库上真跑工具，并已做变异自证（掏掉"不覆盖"规则 → 用例当场红）。 */
  ['neg-answer-source-autofill.cjs'],
  /* ★ 2026-10-30 外部安全审计（Codex 那轮 11 项）的整改护栏。每条都自带"掏掉修复必红"的阴性自证，
     所以它们是**真的会红**的门禁，不是"装个样子能绿"。 */
  /* S03+S07：桌面壳导航白名单 / 消息桥来源 / 重解析点。
     改前 NavigationStarting 用字符串前缀 `u.StartsWith("http://127.0.0.1:"+port)` ⇒
     `http://127.0.0.1:7187@attacker.example/` 直接通过（userinfo 伪装另一端主机）；
     OnWebMessage 处理 readFile/mark/openFile 前不核 e.Source；TryResolveInsideRoot 只做字符串包含性
     ⇒ 库内一条 `mklink /J link C:\Windows` 就能读库外（HTTP 侧早已补 realpath，C# 桥一直漏着）。 */
  ['neg-shell-source-and-reparse.cjs'],
  /* ★ 2026-11-04（外部复核实测 P0·Critical）：桌面壳**写闸取放配对**。
     壳的 `WriteGate`（SemaphoreSlim(1,1)）是所有写操作的互斥闸；改前 8 个取闸的写操作里
     **3 个取闸不放**（TaskConfirm / ReviewCandidate / ReviewAdopt）⇒ 一次调用就把写闸焊死，
     此后组卷/批改/归档/办结全部排队等 20 分钟后超时（用户看到"点了没反应"）。
     它同时解释了 `run.mjs full` 恒 exit 3：e2e-ui 每次都调 taskConfirm ⇒ 把写闸焊死
     ⇒ 紧随其后的 e2e-writepath 拿不到桥响应。用例自带"摘掉放闸必红 / 挪到正常路径必红"的阴性自证。 */
  ['neg-shell-writegate.cjs'],
  /* ★ 2026-11-04（外部复核实测 M2）：抽屉/确认框 body 的 **HTML 汇点收口**。
     实测漏洞：`views\paper.js:276` 的 `body: M.healthText() + …` **没有** `U.esc`
     （同一段文案在 `views\review.js:422` 转了）⇒ 而 `M.healthText()` 的值来自
     `dataHealth.papers`，那里拼着 **Node 的 JSON.parse 报错**（它会把输入前 30 字符原样回显）
     ⇒ 数据里天然带 HTML ⇒ 未转义时进 drawer.innerHTML ⇒ 注入链闭合。
     修法：**在汇点收口**（body 走标签白名单净化 `S.safeConfirmHtml`），
     不是逐个调用点补 —— 本仓同族已栽两次，都是"复制粘贴文案时漏一处"。
     用例含 12 种载荷 + 合法富文本回归 + 摘掉净化必红的阴性自证。 */
  ['neg-confirm-html-sanitize.cjs'],
  /* S01+S04：题干净化。改前标签白名单循环结束后 `out += s.slice(last)` 把**未匹配原文**直通，
     末尾不闭合的 `<img src=x onerror=…` 整段原样输出，再被模板补的 `</div>` 补上闭合 ⇒ 事件脚本执行
     （审计在真 Edge 里复现过）；CSS 转义 `u\72l(...)` 与 SVG fill/stroke 的 url() 也一路放行。 */
  ['neg-stem-sanitize.cjs'],
  /* S02+S05+S06+B01：本机服务端。改前 `Origin: null` 被当可信来源（沙箱 iframe 的源就是 null）、
     不校验 Host（DNS rebinding 的服务端必要条件）、POST /api/state 不收 JSON 也不拒不受信来源、
     状态包读失败被空 catch 吞掉继续回旧数据。 */
  ['neg-server-host-and-token.cjs'],
  /* D01+D02：写入一致性。改前壳有 Global mutex、HTTP 只有进程内队列、CLI 连进程内锁都没有
     ⇒ 两条通道"读同一份旧数据 → 各自改 → 各自原子覆盖"，后完成的把前一个的修改整段丢掉
     （本用例用 6 个真进程跑，一次就抓到锁自身的抢锁竞态）；批改先写台账再写索引，
     第二次写失败就留下"台账说批改了、索引没动"的半截状态。 */
  ['neg-write-lock-and-txn.cjs'],
  ['neg-concurrent-write-lock.cjs'],
  /* ★ 2026-10-31（Lead 本轮新写，原为游离文件）：写锁僵尸回收的 TOCTOU + 事务回滚保留恢复材料。
     「游离 = 能绿但没人跑」，本仓已把它当缺陷处理（见上面 D-049/D-050 那段），故一并登记。 */
  ['neg-lock-reclaim-race.cjs'],
  ['neg-lock-migration-and-cache.cjs'],   // ★ 2026-11-05 合并评审 P0-1/P0-2/P1-2/P1-3/P2-5：旧布局迁移只在持锁后、只动本库；启动时间缓存随 PID 死亡作废
  /* P01：发行包夹带开发机日志。实测 release\GlimmerNote-2026.10.30.03 的 app\shell.log 有 480 字节，
     内容是本机绝对路径；根因是打包脚本整目录复制界面目录。本用例从 build-release.ps1 里**读出真实
     黑名单**在临时目录上实跑，并用"规则掏空"做阴性自证。 */
  ['neg-release-package-hygiene.cjs'],
  /* ★ 2026-10-31：影像备份的分母口径（同一份用例，fixture 模式也跑）。
     它是本仓"唯一真正会永久丢数据"的那个口子的机器化判据：覆盖率的分母必须是
     "全库扫描 − 显式可重建"，不是工具按文件名挑出来的那一撮。
     ★ 2026-11-01：镜像判据随离机镜像功能移除（用户决策）而删除。 */
  ['neg-image-backup-coverage.cjs'],
  /* ★ 2026-10-31：原图兜底寻址（`_原图寻址.mjs`）。
     这条链解决的是"**清空收件箱不会让任何一张卡断链**"：
     台账记的是路径字符串，路径没了（收件箱被清空 / 原件被改名）时，
     按内容（sha256）从保全库找回**字节完全相同**的那一份。
     判据必须能红：①路径与保全库都没了 ⇒ 必须判红，不许兜底成"没事"；
     ②同路径换成**内容不同**的另一份 ⇒ 不许顶替（必须按内容核对，不是按路径猜）。 */
  ['neg-orig-fallback.cjs'],
  /* ★ 2026-11-03（偏差核对 P3-#7 / 施工方案 §3 P1-2）：`_原图寻址.mjs` 的两条硬判据 ——
     ①原路径在盘但**大小与台账不符**时不许再判 `direct`（旧代码那段是个空 if + 注释，字节不符也照用）；
     ②一路径登记两个 sha 不许**静默取第一**（旧代码 `if (!rev.has(sha))` 保留先到的那个 ⇒ 悄悄给错人）。
     含三级"零 IO 常态"自证（同尺寸异内容仍必须 `direct`、`hashed===0`、且有 `hashed>=1` 的反向自证防恒真），
     以及"掏掉①/掏掉②必须分别变红"的变异自证（隔离副本里真变异，真文件零改动）。
     回归基线：真库 `_原卷台账.mjs 门禁` 的"已从保全库按内容兜底 460 条"改前改后**输出逐字节相同**。 */
  ['neg-orig-address-verify.cjs'],
  /* ═════════ 2026-10-31 外部复核 E 区四条整改的护栏（同一次改动里补，见 CONTRIBUTING §七）═════════
     E01：`full` 门禁真写用户真库、吃掉历史备份。根因链：`_测试环境.cjs` 的 LIB 在开发机上就是
     真库（isFrozen=true）→ launch-dev 把 CTB_DATA 传给壳 → e2e-writepath 通过 CDP 真跑组卷/批改/撤批
     → `_安全写` 的 backupJson 只留 8 份 ⇒ 真库三个目录各被删 8 份已跟踪备份。
     而 `assertWritableLib` 全仓**真实调用点=0**（死代码），`_备份-真源\` 的轮转还是**无条件**按派生放行。
     本用例守三件事：冻结库上 e2e 必须打印 RESULT=SKIP（不是静默通过、更不是真写）、
     `assertWritableLib` 必须真有调用点、备份轮转放行必须是**有条件**的（冻结库上必须不放行）。 */
  ['neg-e2e-frozen-lib.cjs'],
  /* E02：`run.mjs` 的"语义等价"判据太宽（索引只比 7 个字段、台账只比 4 个），实测 22 项扰动里
     11 项真损坏被判等价。本用例逐项构造"只改一个业务字段"的变体，要求每种都判不等价，
     并把旧判据原样搬进来做**对照**（旧判据必须放行 ⇒ 证明这条用例有牙齿）。 */
  ['neg-semantic-equivalence.cjs'],
  /* E03：verify-deploy 的 exit 2 同时表示"没有运行区"与"清单损坏"，两个调用方一律当"没有运行区"
     放行 ⇒ 清单损坏 = fail-open（实测损坏清单能让 pre-commit 允许提交）。
     本用例造临时运行区真跑 verify-deploy，断言损坏清单返回阻断码、且 run.mjs/pre-commit 的豁免
     分支**不会**吞掉它（判据收在 `_测试环境.cjs` 的 classifyVerifyDeploy，调用方与它做对拍）。 */
  ['neg-verify-deploy-manifest.cjs'],
  /* E04：一键回滚不重写 `_deploy-manifest.json` ⇒ 正常回滚后 verify-deploy 必然误红（实测
     deploy 0.0.1→0.0.2 都 exit 0，rollback 后 exit 1）。本用例在沙箱里真跑 rollback.ps1，
     断言"回滚后清单版本 == 落地版本"且 verify-deploy exit 0，并用"只恢复 app\、不重写清单"的
     旧行为做阴性自证（旧行为下 verify 必须红）。 */
  ['neg-rollback-manifest.cjs'],
  /* ═════════ 2026-10-31 外部复核 A/B/C/D 区整改的护栏（同一次改动里补，见 CONTRIBUTING §七）═════════
     A03：状态生成器从不取库写锁 ⇒ 与 CLI 批改并发时产出"跨事务拼接"的 `_状态.json`
     （同一份包里"试卷已批改"+"卡片还没复习"并存）。本用例起真生成器进程，从外部读锁文件
     断言运行期确实被它持锁；阴性自证：摘掉取锁后它整个运行期都不持锁。 */
  ['neg-state-gen-mixed-snapshot.cjs'],
  /* B03：`_快照 --restore` 不取锁 ⇒ 能把台账恢复成旧版、插进另一笔未提交事务内部
     （台账旧、索引新，两边都报成功）。本用例用一个真持锁者占库，断言 restore 在锁释放前
     不写目标文件、且释放后才完成；阴性自证：摘掉取锁后它当场插队改写。 */
  ['neg-snapshot-restore-lock.cjs'],
  /* ★ 2026-11-12：把「数据区门禁」整族的阴性对照接进链。此前 `neg-data-area-rules.mjs`
     （223 断言、61 KB 门禁的守卫）**不在 run.mjs、不在三个钩子、也不在 CI** ——
     而 CONTRIBUTING 与 `docs\数据区规范.md` 都把它写成必跑步骤 ⇒ 整族数据区规则事实上无人执行。
     它零库依赖（自建 %TEMP% 合成库 + `allocTempDir` 登记清扫），可直接进 unitTests。 */
  ['neg-data-area-rules.mjs'],
  ['neg-snapshot-text-and-force.cjs'],    // ★ 2026-11-05 合并评审 P1-5/P0-4：md/html 掏空不许直接恢复；--force-restore 二次确认 + 审计
  /* ★ 2026-11-12：`_快照.mjs` 自 2026-11-08 起**完全不可用** —— 纳管清单里的 glob 允许"当前零匹配"
     （`_收件箱/**\/_来源映射.csv`：收件箱清空后该文件就不在了），而 `git add -A -- <pattern>` 对
     不匹配的 pathspec 会 fatal（exit 128），`git add` 又**没有** `--ignore-unmatch`（实测 2.54.0）。
     代价：数据区连续 4 天没有快照回滚点，期间一次提交只能"定向手工提交"。
     本用例四条判据：零匹配模式不许报错 / --dry 不留暂存 / 未跟踪新真源仍要被纳入 / 换回旧写法必须复现 128。
     零库依赖（自建 %TEMP% 迷你 git 仓 + 只读本仓源码）。 */
  ['neg-snapshot-pathspec.cjs'],
  /* ★ 2026-11-12：`_题干门禁` 的 `allCards()` 原先 `catch { continue; }` ⇒ 索引读不出时
     收集到 0 张卡、`judgeLibrary` 直接 ok:true，体检还会报「✔ 扫描 0 张，阻断 0」——
     一份全绿但什么都没查的报告（兄弟门禁 `_作答门禁` 用的是会抛错的 readJsonStrict）。
     本用例守四条：好库不误伤 / 坏索引判红并点名 / 空真判红 / 空库不误伤，并带阴性自证。
     零库依赖（自建 %TEMP% 合成库 + 工具副本动态 import）。 */
  ['neg-stem-gate-broken-index.cjs'],
  /* ★ 2026-11-07 规范 W6「改盘别改格式」进程序：`writeJsonAtomic` 的缩进过去写死默认 2，
     而台账缩进是**每份文件自己定的**（`_原卷台账.json`/`_录题任务.json` 用 1）⇒ 一次纯路径改写
     把 `_原卷台账.json` 从 410,280 B 重排到 451,899 B（+41.6 KB）。修法：不传 indent/newline 时
     沿用盘上原格式。阴性自证：显式传 indent:2 必须仍然重排（判据不是恒真）+ 旧行为确实会改格式。 */
  ['neg-write-format-preserve.cjs'],
  /* ★ 2026-11-07 规范 §七.1「路径改写判据」进程序：`src\tools\_路径改写.mjs`。
     过去它只活在文档 + 一次性脚本里（实测 src\/tests\ 零命中）⇒ 每次搬迁都得重写一遍。
     三条判据：① 相对前缀（带分隔符，禁"整串相等"——那会改坏 `_索引.json` 的 `grade`）、
     ② 绝对路径只换中段、③ 非路径标识须**声明字段作用域**（`--id` 必配 `--id-field`）。
     载体扫全：JSON 值 + 对象键 + `*.md` 路径 token；死链对拍（现在解析不到 + 改名后能解析 = 本次制造的死链，必须 0）。 */
  ['neg-path-rewrite.cjs'],
  /* D01：题卡元数据回显不走净化器，`lastReviewedAt`/`blindSolveAt` 未转义 ⇒ 索引里放
     `<img src=x onerror=…>` 打开卡片详情即执行。静态（源级判据防新字段漏）+ 动态（真跑前端渲染）
     双判据；阴性自证：摘掉 U.esc 后同一 payload 原样进 HTML。 */
  ['neg-meta-escape.cjs'],
  /* D02+D04：结算屏「再来一场」无确认清空未落库判分（同屏「丢弃不写」却有确认）；
     没有 `原卷截图.jpg` 的合法卡（生成器本来就给 img:null）在 `U.$id('rvImg').onclick` 崩掉整屏，
     且崩在退出/判分按钮绑定之前 ⇒ 整场复习锁死、重进仍崩。两条都带阴性自证。 */
  ['neg-review-leave-and-noidx.cjs'],
  /* D03：门禁剔除被拒题只改提交列表、不改卷面题源 `sheet.refs` ⇒ 纸面仍印着被拒题、
     题号错位（纸上第 2 题成了台账第 1 题）、清篮还把没入账的题一起摘掉。
     附带守"剔除重试不得对已成功组重复组卷"（external 复核抓到的第二个缺陷）。 */
  ['neg-paper-reject-sync.cjs'],
  /* C01：建卡清单缓存键是裸卡号 ⇒ 跨学生同号卡串号（实测**单份**清单就会错；
     真库两学生同号卡 96 个，只是当前恰好没有清单目录）。判据：老清单无学生归属 + 跨学生重号
     ⇒ 必须返回歧义，不许"后枚举覆盖前者"。 */
  ['neg-orig-ledger-ambiguity.cjs'],
  /* C02：收件箱"转置件"判据只有尺寸+体积 ⇒ 内容无关但恰好互为转置、体积同量级的照片被贴上
     "已处理"标签（从待处理清单消失）。判据改为"必须有内容证据"；阴性自证摘掉证据闸门，
     正向对照用"同一份字节的副本"（防"改成一律不隐藏"）。 */
  ['neg-inbox-transposed-evidence.cjs'],
  /* 2026-11-05：分流器（`_分流器.mjs`）—— 一坨混科照片的判科/判重/分组。
     已挂进 HERMETIC 白名单（零库依赖，fixture 模式也跑）—— 那里才是它真正会被跑到的位置。 */
  /* ═════════ 2026-11-02 外部审查（Codex 首轮）核对结论的整改护栏 ═════════
     来源：work\audit-codex-20261102\拾光小册-首轮审查报告-核对结论-20261102.md（逐条实测复核过，
     不是照抄指控）+ 整改清单 2026.11.02.01。每条都带"掏掉修复必须复现缺陷"的阴性自证。

     A1 库内文档 CSP：真服务端返回的 CSP 只有 `sandbox` 时，库内 HTML 里的远程
     `img/link/@import/script src` 会**照发请求**（实到达本机计数器 8 条）；加 `default-src 'none'`
     后 0 条。本用例用 headless Edge + 计数器做**真浏览器**判据，并要求"本地图片必须真的加载出来"
     作正对照 —— 只断言"脚本没跑"会漏掉"取"这一半。 */
  ['neg-server-lib-csp.cjs'],
  /* ★ 2026-11-03（R8 整改①）：程序页 CSP 后备 —— 响应头（服务端）与 index.html meta（含壳的
     file:// 模式）两份同内容，最小可用集（default-src 'none' + 逐类开口）。本用例做机读对拍
     （头与 meta 逐字相等）+ 行为断言 + 阴性自证（掏回旧值必须红）。 */
  ['neg-server-csp.cjs'],
  /* A5 静态路由白名单：库根通配放行让 `数据\.git\` 整树（含 index/logs/objects）与全部根台账
     无 token 可读（真库实测 /_待确认.json 200/324907B、/.git/index 200/198619B）。现在四道判据：
     dot 段 / `_` 段目录(除 _原图、_收件箱) / `_` 开头文件名(除 _组卷台账.json) / .bak，外加 no-store。
     ★ 2026-11-03（R8 整改③）四道之上再叠类型准入：图片按扩展名准 + 文本只留两个有消费者的
     （错题记录.md / _组卷台账.json）；`题干.html`（零消费方，R8 实测 506 个）从正对照移入负对照。 */
  ['neg-server-static-whitelist.cjs'],
  /* 架1 refreshPendingSection 曾用 execFileSync：慢桩 6s 时 /health 被拖 5815ms（125s 桩实测 119727ms）。
     改异步 + in-flight 复用后，慢桩进行中 /health 必须 < 500ms，且并发请求只 spawn 一个子进程。 */
  ['neg-server-refresh-nonblocking.cjs'],
  /* 架2 静态响应曾 fs.readFile 全量入内存（256MiB 文件 → 工作集 +256.3MB 且不归还、无 Range）。
     现在流式 + 64MiB 上限 413 + 单段 Range 206/416，用例连 RSS 增幅一起断言。 */
  ['neg-server-static-stream.cjs'],
  /* 新发现：`_服务端.mjs:242` 只看 mtime+size，而 `_状态刷新.mjs:70` hash 优先且命中时不写盘
     ⇒ "内容没变但 mtime 变过"（touch / 同字节重存 / 还原复制）时两者永久互相抵消，
     **每次 GET /api/state 都同步 spawn 子进程**（实测 81/74/79ms vs 改内容后 1ms）。判据统一为 hash 优先。 */
  ['neg-server-pending-fresh.cjs'],
  /* A2/A3 壳：openFile 只做目录包含性检查、无类型准入（库内 .bat 实测真被执行）；且 Dispatch/
     OpenWithSystem 吞异常 → 文件不存在、系统程序打不开都回 `{"ok":true}`。现在系统关联只放行
     图片+pdf、其余改走"定位文件"并回 ok:false，三条链路（openFile / 导航 file: / 新窗口 file:）共用一张表。
     用例按大括号配对抽真源码编成最小 C# 程序真跑，复刻体里没有任何 Process.Start/窗口。 */
  ['neg-shell-openfile-policy.cjs'],
  /* A1 桌面侧：库内 html/svg 经系统关联打开时拿不到服务端 CSP（file:// 直接执行脚本）⇒ 一并纳入
     类型准入；另加 WebView2 资源请求白名单（NavGuard.IsAllowedResource），堵住壳内出网面。 */
  ['neg-shell-resource-whitelist.cjs'],
  /* A4 依赖可信性：改前哈希是"下载后自算自记"，715 字节的伪造 nupkg 也能 `✔ 依赖就位`。
     现在 `src\shell\webview2-deps.lock.json` 是受控预期哈希（两次独立官方下载一致），
     解包前校验 nupkg、解包后校验每个 DLL，缺锁文件 fail-closed。 */
  ['neg-deps-lock.cjs'],
  /* ★ 2026-11-02（用户当天两条质问，都是真缺陷）：
     ① `_原卷台账.mjs` 的"只读"承诺不成立——`sizesOf()` 失败分支（量尺寸脚本缺失 ⇒ catch ⇒ break）
        后没有 return，控制流穿透到 `writeJsonAtomic(_probe\_图尺寸.json)`，即**只读报告往真库写文件**，
        于是收尾的真库零写入断言判红 ⇒ `quick` 在干净 HEAD 上恒 red；
     ② 长宽比体检**假绿**：它要的 `<库根>\_工具\图尺寸.ps1` 仓库与运行区都不存在 ⇒ 永远零输入，
        却每次都打印"长宽比体检：全部通过"。现已改为纯 Node 读文件头（`_图尺寸.mjs`）+ 零输入打印 SKIP。
     本用例用合成库守这两条，并含"库根多出 `_probe\` 必须被抓到"的阴性自证。 */
  ['neg-ledger-nowrite.cjs'],
  /* ★ 2026-11-02：`neg-orig-store.cjs` 此前是**游离文件**（写了但没挂进任何档 ⇒ 能绿但没人跑，
     同 L-175「可选工具 ≠ 机械化」）。本轮登记进 quick。 */
  ['neg-orig-store.cjs'],
  /* ★ 2026-11-03（偏差核对 P3-#6）：补施工方案 §6「批次 0」交付物 9 那条**当时没做**的欠账 ——
     `_原图.mjs 核对 --from <备份根>`（只读三方逐字节对账）+ 隔离恢复演练。
     演练：四情形（同图两次 / 同名异图 / 带 EXIF 方向 / 跨页题）→ 入库 → 拷一份**库外** `_原图\` 副本
     → **换全新库目录恢复** → `核对 --from` 校验；含 5 条阴性对照（长度不变的 1 字节损坏、备份侧损坏、
     库内/备份各删一个、只改台账 bytes、备份多出一个台账不认的对象），每条都真红且还原后回绿。
     与既有 `restore-drill.cjs` 的分工：那份管 **JSON 真源**走 git 的恢复，这份管**原图字节**走独立备份的恢复。 */
  ['neg-orig-restore-drill.cjs'],
  /* ★ 2026-11-02（批次 1「任务绑定」）：把 A 的结果贴进 B 必须被拒——错配是最危险的静默错误。
     三层：① 格式交给 `_配方.mjs 校验`（唯一实现，界面与 CLI 共用）② 信封 taskId / 原图 sha /
     卡内 sourceImageSha256 三重匹配 ③ 人工确认只能由 `确认` 子命令写。含 11 条反例。 */
  ['neg-task-binding.cjs'],
  /* ★ 2026-11-03（批次 1 收尾「页面接线」）：页面 → 壳 → 工具整条链的源码级+CLI 级钉。
     壳两个新 op（taskCheck/taskConfirm）、taskId 形状门禁、写读分界（确认进写闸）；
     前端四条纪律（勾图才发 --task / stderr 解析任务号 / 三层 vs 仅格式 / 确认由人点）；
     --data 真跑（壳传库根的通路）+ A/B 错配 CLI 侧证据。
     端到端（真 exe + CDP 驱动页面）在 neg-v2-ingest-task-e2e.cjs —— 两层各管一段。 */
  ['neg-task-page-wiring.cjs'],
  /* ★ 2026-11-04：录题「建卡入库」整条链 —— 从校验通过的 JSON 到库里真的一张卡。
     为什么必须有它（**实测出来的缺陷**）：录题页走完「生成任务单 → 校验 → 人工确认」就**结束**了，
     页面写着「本页不落库」——因为仓内**没有任何东西能把 JSON 变成卡**。实测 2026-11-04 19:36 那次录题：
     任务记录 `cards` 是**空数组**、全库**零张新卡**，用户点完「确认本任务」什么也没发生，
     而且界面**没有任何提示说"没落库"**。历史上所有入库都是**仓外一次性脚本**做的
     （`work\kk-math-20261101\land.mjs`），那脚本连三道门禁都只是**打印命令让人手跑**。
     本用例六段：A 壳侧（op/形状门禁/写闸在 finally 放/固定映射/真实退出码）
     B 前端（host 通道 + `onLand` **真被驱动**，断言实际送出的参数）
     C 引擎（真跑入库 ⇒ 卡目录四件套 + 索引条目 + 任务记录回写 + **幂等**不造重复卡）
     D 三层前置（没确认 / 信封 taskId 不符 / 卡片 sha 不符 / 学生不存在 / 契约缺项 / bbox 越界
       ⇒ **零写盘**）E 门禁当场跑（作答契约/配图/原卷溯源/盲解清稿）
     F **变异自证**（摘掉任一前置检查 ⇒ 变异体确实放行 ⇒ 判据有牙齿）。
     51 断言。 */
  ['neg-ingest-land.cjs'],
  /* ★ 2026-11-02（批次 0 尾项「过程件卫生」）：① `_作答门禁` 的作答工单默认落 `procPath()`（不再写库根）
     ② 测试夹具临时目录集中登记 + 进程退出统一删 + 启动清扫 ③ `neg-v2-pagesmoke` 的 profile 清理挪进 finally。
     为什么值得单挂一档：实测曾一次压出 10.2 GB 残留（%TEMP% 8.3 GB / 仓库 `_probe` 1.29 GB）。 */
  ['neg-proc-hygiene.cjs'],
  /* ════════ ★ 2026-11-03 批次 2「经验包试点（可插拔）」五条新用例 ════════
     为什么必须挂进门禁：经验包是**用户自己往目录里放东西**的一条新入口，坏包、越界、停用、
     同版异内容这些形态全靠这几条判据守着；而"能绿但没人跑"是本仓记过账的缺陷形态（L-175）。 */
  /* ① 经验包引擎（`_经验包.mjs` 只读）：形状门禁 / 四道包含性判据（含 realpath 重解析点逃逸）/
     限值 / 重复卡 ID / 未知 formatVersion / 缺文件 / `.停用` / 同版异内容 / 坏包只影响自身。
     80 断言，含"掏掉实现必须变红"的变异自证（W1 实跑过 3 组）。 */
  ['neg-pack-contract.cjs'],
  /* ② 选卡接进任务单（`_配方.mjs --card/--card-conflict`）：卡正文进提示词、卡摘要进 contractDigest、
     冲突三策略、坏包各自 exit 2。兼容红线用**真引擎对拍**（基线取自不可变提交 83dbe5c，
     只归一化 tools 目录与随机 taskId 两处）证明"不选卡时逐字节不变"。64 断言。 */
  ['neg-card-select.cjs'],
  /* ③ 区域契约 + 统一坐标系：`regions[]` 六类违规判红 / 重建保留 / 像素 box 读取时归一化
     （boxNorm×imgW 与原像素一致）/ `/api/state` 只附加不改旧行为 / `_区域坐标.mjs` 无导入期副作用。 */
  ['neg-region-contract.cjs'],
  /* ④ 前端接线（选卡区 / 经验包页 / 侧栏入口 / 灯箱两条坐标路等价 + pending 透传）。
     纯源码级 + 真跑 `_经验包.mjs 清单`，不需要 exe。 */
  ['neg-pack-ui-wiring.cjs'],
  /* ⑤ **已编译壳**的选卡透传：反射加载 exe 调 `Recipe()`，用替身工具把真实收到的 argv 打回来
     ——判据是 argv 逐字相等（"源码改了但 exe 旧"是本仓常态事故）。缺 exe 时打印 RESULT=SKIP。 */
  ['neg-shell-card-passthrough.mjs'],
  /* 未做（如实记）：这五条**没有**先进 HERMETIC 白名单 —— 规矩是"要进必须先干净克隆实测"，
     本轮没做那一步（同 2026-10-30 那次的口径）。它们全部只依赖本仓源码 + %TEMP% 夹具，够格进的
     概率很高，但"没实测就不写进白名单"。 */
  /* ════════ ★ 2026-11-03 批次 3「贡献试点」三条新用例 ════════ */
  /* ⑥ 经验草稿导出：**字段白名单从零组装**（源里塞满额外字段/私有标记，一个都不许进草稿）、
     六类私有标记各自的阴性对照、判红时不写盘（fail-closed）、local/cloud 两形态差异
     （cloud 版零哈希是字面事实）、以及**跨模块对拍**（公开仓 Issue 表单七个必填 id ↔ 白名单字段）。
     103 断言；9 组变异自证（含"豁免被改窄"这一族）全部被抓、还原后 sha256 一致。 */
  ['neg-experience-draft.cjs'],
  /* ⑦ 家长纠正「记录原因」入口：`纠因` append-only 写 `corrections[]`（同 why 幂等且不写盘）、
     缺条目/空 why/非法 scope ⇒ exit 2、既有 28 步子命令**逐字节对拍**（真旧实现取自不可变提交）、
     以及 `_待确认.mjs` 与 `src\app\js\model.js` **两份 KINDS 逐字一致**（阴性对照：只改一份必红）。
     100 断言。 */
  ['neg-reason-entry.cjs'],
  /* ⑧ 公开仓贡献通道：Issue 表单七字段与草稿白名单**同口径**、PR 模板可选段且既有标题未丢、
     labels 四档结论与 CONTRIBUTING 正文**互相锁定**（只写一边必红）、四档结论的**前提**也被断言
     （谁删标签或抬上限 ⇒ 当场红）。自写最小 YAML 解析、零依赖、fail-closed。63 断言。 */
  ['neg-contrib-templates.cjs'],
  /* ════════ ★ 2026-11-03 批次 4「审核与正式入库」两条新用例 ════════ */
  /* ⑨ 候选修订与**正式写入入口**：`候选/修订/采用/作废候选` 四子命令、`candidates[]`/`revisions[]`
     只增不改、`_修订\<kind>\<目标>\<candId>.md` 落点、锁+事务+整体回滚、串行幂等；
     既有子命令与真旧实现（不可变提交）**逐字节对拍**。224 断言（含 6 个真跑变异体）。 */
  ['neg-revision-chain.cjs'],
  /* ⑩ **恢复演练后半段**：自建 4 种形状（同图两次/同名异图/带 EXIF 方向/跨页题）→ 真跑入库 → 备份 →
     删掉库内 `_原图\` → `恢复 --from` → 逐对象 sha256 零差异 → **用旧题引用复原"整页+红框+人工判断"**
     （跨页指向另一张页、EXIF 显示宽高交换）；含"内容不同不许覆盖""复核不过不留半截""缺页/越界各给具体原因"
     "派生件不改写原件"等阴性对照。25 断言。 */
  ['neg-orig-restore-writeback.cjs'],
  /* ⑪ 界面接线：`生成状态.mjs` 必须把 `_原卷台账.json` 的 `regions[]` 递给界面（真跑；没有 it 画不出角色分层），
     `shell.js` 的坐标换算唯一实现 + `pending.js` 不许有第二份（反重复判据）、并排/候选/写入按钮接线齐；
     含 **`--data` 必须压过继承的 CTB_DATA** 这条回归锁（本轮修掉"_原图寻址 导入期解析库根 ⇒ --data 静默失效"）。 */
  ['neg-v2-review-sidebyside.cjs'],
  /* ⑫ **并发对抗钻孔**（Lead 亲自做的那条，已固化成常驻）：4 进程同时登记同一候选 ⇒ 同一 candId、只 1 条；
     6 进程同时采用 ⇒ 恰好 1 个真写入 + 5 个幂等、修订对象 1 份、`revisions[]` 1 条；双击重试字节不变；
     落点被 ENOTDIR 占住 ⇒ 整体回滚（台账逐字节一致）+ 排除障碍后重试成功。 */
  ['neg-revision-concurrency.cjs'],
  /* ⑬ 批次 5「扩展」：`pack.json` 的 `extensions[]`（学科/接口扩展声明）机检 ——
     §6 原文「每条扩展必须有：适用条件、能发现误伤的反例、维护者」+ §9.1「逐条扩展各自附反例」。
     判据：不声明 ⇒ 老包一字不改照过（向后兼容）；声明了四项缺一/空值/占位词 ⇒ 红；
     **反例必须可跑**（指到真实案例 + 该案例 controls[] 里真有那条对照）⇒ 反例失去支撑时当场红。
     正向用真扩展包（化学 family-b/periodic-symbols）跑；装机路径（装/停）在临时包根抽查。 */
  ['neg-pack-extensions.cjs'],
  /* ════════ ★ 2026-11-04 真机体检后补的两条（都是"以第三者身份打开程序"才发现的） ════════ */
  /* ⑭ **真实浏览器 DOM** 级判据：批次 4 的 `neg-v2-review-sidebyside.cjs` 只证了"卡上有 origRegions"
     与"源码里有 S.roleClass 字样"，**没证**待办那条路真能拿到区域 —— 真机一看：待办只有旧红框，
     界面静默退化成"红框对准（无角色记录）"。这条真起服务端 + 真开无头浏览器（Edge/Chrome），
     数区域框（必须 2 个、角色 r-err/r-cond）、数角色标签、看来源标注；阴性对照=卡上无区域时
     必须老实退化成 1 个 r-other。没装浏览器则 RESULT=SKIP。 */
  ['neg-v2-review-pair-dom.cjs'],
  /* ⑮ 服务端模式**冷库首开**：库里还没有 `_状态.json` 时 `GET /api/state` 曾 500（页面白屏），
     而启动横幅本来就承诺 "will rebuild on first /api/state"。判据：冷库 ⇒ 200 + 真状态包 + 自建成功；
     阴性对照=重建也失败时仍 200，但必须挂 `degraded=state-missing-rebuild-failed` 并给原因。 */
  ['neg-server-cold-library.cjs'],
];
for (const [name] of unitTests) {
  worst = Math.max(worst, run(name));
  if (worst !== 0) { console.log('✖ 单元级断言未过（' + name + '），先修再跑界面回归'); process.exit(worst); }
}
if (mode === 'full') {
  /* 会临时写真源（测毕撤批/还原）的对照，放在 full 里跑 */
  for (const name of ['neg-interval-and-axis.cjs', 'interleave-check.cjs', 'neg-paper-order-blank.cjs']) {
    worst = Math.max(worst, run(name));
    if (worst !== 0) { console.log('✖ 对照未过（' + name + '）'); process.exit(worst); }
  }
  /* ★ 2026-10-12 把 neg-datahealth 从"游离"升为门禁项。
     它此前一直游离 ⇒ "能绿却常被跳过"（同 L-175），而它守的正是 BUG-03 那个真缺陷：
     **数据源读不到时会不会静默变成"一切正常"**。
     实测只跑 5 秒（它自己带备份+还原，实测前后真源 sha 不变），完全够格进链。
     挂链前先修了它自己的判据缺陷（红条容器是常驻空容器，原判据恒红 ⇒ 它一直 FAIL）。 */
  worst = Math.max(worst, run('neg-datahealth.cjs'));
  if (worst !== 0) { console.log('✖ 数据源降级红条对照未过（降级又被静默了？）'); process.exit(worst); }
  /* ★ 2026-10-12 把 neg-figure-fingerprint 也升为门禁项（只跑 0.6 秒）。
     它守 BUG-08：「只改图形、不改文字」是否会让盲解结论失效。
     挂链前修了它两处问题：① 它一律按 v2 指纹判读，而存量 201/202 张卡还是 v1 指纹
     ⇒ 必然报红（把"存量现状"误报成"机制坏了"）；现按卡的真实指纹版本分别判读，
     v1 卡显式 SKIP 并打印存量缺口。② 补 skipped 计数，符合"跳过必须可见"的门禁纪律。 */
  worst = Math.max(worst, run('neg-figure-fingerprint.cjs'));
  if (worst !== 0) { console.log('✖ 图形指纹对照未过（有 v2 卡改了图形却没失效？）'); process.exit(worst); }
  /* ★ 2026-11-02 R11：把游离的发布链路演练挂进门禁。
     改前 `selftest-pipeline.ps1` 在 run.mjs 里**只有 fixture 的 SKIP 展示行、0 个调用点**
     ——任何模式都不跑它（"能绿但没人跑"，L-175 同族）。
     实测（2026-11-02，隔离整树副本 + %TEMP% 沙箱）：14/14 断言、exit 0、12.75 s；
     真运行区 app\ 与 数据\ 前后指纹一致（PROD-UNCHANGED=YES），真源 docs\回退演练记录.md 未被写。
     ⚠ 两条前置：① release\ 与 归档\ 里至少**两个**版本的包（脚本 :36 直接 throw）；
              ② 脚本成功时会往 docs\回退演练记录.md **追加一行**（设计如此）⇒ 这里先备份、跑完还原，
                 否则每跑一次 full 工作树就脏一行，会把真正的未提交改动淹掉。
     包不够时**显式跳过**（不是静默通过）。 */
  {
    const zipNames = [path.join(ROOT, 'release'), path.join(ROOT, '归档')]
      .filter(d => fs.existsSync(d))
      .flatMap(d => fs.readdirSync(d).filter(n => /^GlimmerNote-.+\.zip$/i.test(n)));
    if (zipNames.length < 2) {
      console.log('\n○ 发布链路自检（selftest-pipeline.ps1）跳过：release\\ 与 归档\\ 里只有 ' + zipNames.length +
        ' 个包，它需要至少两个版本（先跑两次 build-release.ps1 打两个包）。这是**可见跳过**，不是通过。');
    } else {
      const rec = path.join(ROOT, 'docs', '回退演练记录.md');
      const recBak = fs.existsSync(rec) ? fs.readFileSync(rec) : null;
      const sp = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(ROOT, 'scripts', 'selftest-pipeline.ps1')], { cwd: ROOT, stdio: 'inherit' });
      if (recBak) fs.writeFileSync(rec, recBak); else if (fs.existsSync(rec)) fs.unlinkSync(rec);
      worst = Math.max(worst, sp.status == null ? 1 : sp.status);
      if (worst !== 0) { console.log('✖ 发布链路自检未过（升级/回滚动了数据，或耗时超上限）'); process.exit(worst); }
    }
  }
}
if (mode === 'full') {
  // launch-dev 是 fire-and-forget（spawn 新壳后自身退出），跑完等端口
  const l = run('launch-dev.cjs');
  worst = Math.max(worst, l);
  if (l !== 0) { console.log('launch 失败，中止'); process.exit(1); }
  if (!await waitPort(60000)) { console.log('✖ 9223 调试口 60s 未就绪'); process.exit(1); }
  await sleep(2500);   // 等 boot 完成
} else {
  /* ★ 2026-10-12：quick 也能独立跑。
     原先 quick 要求"用户自己先起一个带调试口的壳"，否则直接 exit 2 让人一头雾水
     （实测最常见的原因是 full 收尾重启了一个**不带调试口**的干净壳 —— 程序好好的，
      但界面回归连不上 9223）。现在：端口不通就自动拉起开发壳，省掉手工步骤。 */
  if (!await waitPort(1500)) {
    console.log('\n═══ 未检测到开发壳，自动拉起（node tests\\launch-dev.cjs）═══');
    const l = run('launch-dev.cjs');
    worst = Math.max(worst, l);
    if (l !== 0) { console.log('launch 失败，中止'); process.exit(1); }
    if (!await waitPort(60000)) { console.log('✖ 9223 调试口 60s 未就绪'); process.exit(1); }
    await sleep(2500);
  }
}
worst = Math.max(worst, run('e2e-ui.mjs'));
if (mode === 'full') {
  /* ⚠ 2026-10-11 新增：**页面内 CTA 按钮**的路由回归。
     起因（用户实测）：「今日总览」点「🔁 进入复习流」→「视图渲染出错 Cannot read properties of undefined (reading '1')」——
     该按钮走 `S.route('review',{queue:'pick'})` 而 pools 无 pick 键。而此前验收**只点侧栏**，完全没覆盖页面内按钮
     ⇒ 用户一用就崩。本项逐个点击六个视图里的所有 `[data-a]|[data-go]|[data-anchor]|[data-pend]` 按钮并断言不报错。
     同时它已抓出第二个真 bug：`shell.js` 里 `U.$id('sideFoot').innerHTML=` 未判空，抛在 render 尾部会连带
     renderHealth/statusbar/顶栏副标题全不执行。 */
  worst = Math.max(worst, run('verify-v2-route-cta.cjs'));
  worst = Math.max(worst, run('verify-shell-visual.cjs'));
  /* ⚠ 2026-10-11 新增：**交互元素穷举扫描**（508 个元素 / 468 次点击 / 22 个范围）。
     起因：route-cta 只覆盖 4 类路由按钮（17 个），而用户会点的其它按钮（筛选 chip、排序、抽屉、灯箱、
     命令面板、主题、学生分段、组卷生成/打印…）从未被点过 —— "没被点过的按钮"就是"没被走过的崩溃路径"
     （上一个真 bug 正是这么漏掉的）。它已抓到 2 处真缺陷：`paper.js` 台账异步写 DOM 的竞态（unhandled
     rejection，界面看着正常、S.render 的 try/catch 接不住）、`chart.js` 单学科标签被压成 width=0
     （不抛错不 console，只能量几何）。本脚本自打桩写通道、跑前跑后校验真源 SHA 不变、localStorage 前后隔离。 */
  worst = Math.max(worst, run('verify-v2-interactive-sweep.cjs'));
  /* ★ 2026-10-31 E01：写路径闭环用例的**库准入**在这里先声明一次。
     为什么还要在这一层再说一遍（用例自己也会判）：
       ① 让"这次 full 到底有没有验写路径"在**汇总输出**里就看得见 —— 不能只在某个子进程的
          输出中间有一行 SKIP，那样等于静默（本仓的老坑：SKIP 不可见 = 假绿）；
       ② 用例自身的准入闸仍有独立判据（它才是最靠近写盘点的那道），两层不冲突。
     真跑写路径：先把库复制到副本，`set CTB_TEST_LIB=<副本>`，再跑 full。 */
  const wpGate = E.guardWriteTest('e2e-writepath.cjs');
  if (wpGate.skip) {
    console.log('\n[SKIP] e2e-writepath.cjs —— ' + wpGate.reason);
    console.log('       本轮 full **没有**验证写路径闭环（这不是通过，是没跑）。');
  }
  worst = Math.max(worst, run('e2e-writepath.cjs'));
  // 收尾：干净重启（无调试口），把桌面留给用户
  console.log('\n═══ 收尾：干净重启 ═══');
  spawnSync('taskkill', ['/F', '/IM', '拾光小册.exe'], { encoding: 'utf8' });
  await sleep(1500);
  const p = spawn(path.join(ROOT, 'src', 'app', '拾光小册.exe'), [], { detached: true, stdio: 'ignore' });
  p.unref();
  await sleep(2500);
}
/* 真库零写入断言结账：放在最终汇总**之前**，好让违反并进退出码（早退路径由 exit 钩子兜底） */
worst = Math.max(worst, checkLibZeroWrite() ? 1 : 0);
console.log('\n──────────────────────────────');
console.log(worst === 0 ? `✔ 门禁全绿（${mode}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s）` : `✖ 门禁未过（exit ${worst}）`);
process.exit(worst === 0 ? 0 : 1);
