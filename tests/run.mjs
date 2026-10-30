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

function run(script, args = []) {
  console.log('\n═══ ' + script + ' ' + args.join(' ') + ' ═══');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', script), ...args], { cwd: ROOT, stdio: 'inherit', encoding: 'utf8' });
  return r.status ?? 1;
}

/* ════════ 运行区部署一致性（两种模式都跑，2026-10-25 用户定规）════════
 * 用户原话：「我需要你以后只能走正确链路：dev 改 → dev 测 → build-release.ps1 打包 →
 *   deploy.ps1 部署（自动写部署记录）。如何设置，确保以后只能走这条路？」
 * 起因：AI 直接 edit 了运行区 app\js\model.js，绕过打包与部署，运行区于是有一套
 *   「不对应任何发布包」的代码（部署记录.txt 最后一条还是旧版本）。
 * 判据：scripts\verify-deploy.mjs 逐文件 sha256 比对 <运行区>\_deploy-manifest.json。
 * ⚠ 放在 fixture 分支**之前**：新克隆/换机跑 fixture 时也应当知道"运行区有没有漂移"，
 *   否则这道检查只在开发机 quick/full 时存在（本仓 L-175「能绿但没人跑」的老坑）。
 * ⚠ 退出码 3 = 运行区尚无清单（机制建立前的历史状态）→ 只告警不判红：
 *   否则基线建立之前本门禁会永久红，反而逼人跳过它。建基线只有一条路：
 *   走一次正规 build-release.ps1 → deploy.ps1。 */
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-deploy.mjs'), '--quiet'], { encoding: 'utf8', cwd: ROOT });
  const code = r.status == null ? 1 : r.status;
  if (code === 3) {
    console.log('\n⚠ 运行区尚无部署清单（_deploy-manifest.json）——本门禁暂无法判定；');
    console.log('  建立基线只有一条路：scripts\\build-release.ps1 → scripts\\deploy.ps1');
  } else if (code === 2) {
    /* ★ 2026-10-25：exit 2 = 运行区不存在（新克隆 / 换机 / CI——仓库旁边根本没有 GlimmerNote\）。
       这不是"有人绕过链路"，是"这台机器本来就没有运行区"。判死 fixture 会把新克隆第一步
       堵死（实测：干净克隆跑 fixture 直接红，README 承诺的 3 秒 exit 0 失效）。
       语义修正：运行区在 ⇒ 一致性照旧硬判（开发机红线不动）；运行区不在 ⇒ 提示后继续。 */
    console.log('\n○ 本机没有运行区（' + String(r.stderr || '').trim().split('\n')[0].replace(/^✖\s*/, '') + '）——部署一致性门禁只在有运行区的机器上生效');
  } else if (code !== 0) {
    console.log('\n' + String(r.stderr || r.stdout || '').trim());
    console.log('✖ 运行区被绕过 deploy.ps1 改动过（或版本与清单不符），先归位再发版');
    process.exit(1);
  } else {
    console.log('\n✔ 运行区与部署清单一致（' + String(r.stdout || '').trim().split('\n')[0] + '）');
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
let LIB0 = null, libChecked = false;
function checkLibZeroWrite() {
  if (libChecked || !LIB0) return 0;
  libChecked = true;
  const after = libSnapshot(E.LIB);
  const changed = [], derived = [], gone = [], added = [];
  for (const [rel, a] of LIB0) {
    const b = after.get(rel);
    if (!b) { gone.push(rel); continue; }
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || (a.sha && b.sha && a.sha !== b.sha)) {
      (DERIVED_CACHE.has(rel) ? derived : changed).push(rel + '（' + a.size + 'B → ' + b.size + 'B' + (a.sha && b.sha && a.sha !== b.sha ? '，内容也变了' : '') + '）');
    }
  }
  for (const rel of after.keys()) if (!LIB0.has(rel)) added.push(rel);
  console.log('\n────────── 真库零写入断言（记录 ' + LIB0.size + ' 个文件）──────────');
  if (derived.length) {
    console.log('⚠ 派生缓存被重写（**允许**，但必须可见，故不判红）：' + derived.join('、'));
    console.log('  依据：_状态.json 是可再生的派生件；且 tests\\neg-server-get-readonly.cjs 会故意删它的');
    console.log('        _pendingSrc 指纹来验证"台账没变就不刷"。**"允许"不等于"静默"** —— 这就是那份清单。');
  } else {
    console.log('✔ 派生缓存（_状态.json）也未被重写');
  }
  if (changed.length || gone.length || added.length) {
    console.log('✖ 真库出现**非派生**变化（红线 2：任何脚本都不得写 数据\\）：');
    for (const x of changed) console.log('   · 内容/时间戳变了：' + x);
    for (const x of gone) console.log('   · 文件消失了：' + x);
    for (const x of added) console.log('   · 多出了文件：' + x);
    console.log('   合法情形：该测试必须先把库复制到临时目录（见 tests\\_测试环境.cjs 的 assertWritableLib/makeTempLib）。');
    return changed.length + gone.length + added.length;
  }
  console.log('✔ 真库零写入：除上面列出的派生缓存外，' + LIB0.size + ' 个文件全部零变化');
  return 0;
}
if (mode !== 'fixture') {
  LIB0 = libSnapshot(E.LIB);
  console.log('\n真库零写入断言：已记录 ' + LIB0.size + ' 个文件的 size+mtime（文本类另算 sha256）—— ' + E.LIB);
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
  ];
  const SKIPPED = [
    ['portability.cjs', '需要已构建的 src\\app\\拾光小册.exe（gitignored）'],
    ['e2e-ui.mjs / neg-v2-ui-*.cjs', '需要桌面壳 exe + 9223 调试口'],
    ['selftest-pipeline.ps1', '需要已构建的发布包与运行区'],
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
  ['neg-shell-args.mjs'],              // ★ 壳的取值 + 参数转义：带引号的备注必须逐字送达 node（真 node.exe 验证）
  ['neg-stem-img-fit.cjs'],            // ★ 题图不得撑破卷面/抽屉：卡片行内 max-width 必须被 !important 压住（P0035 溢出 39mm）
  /* ★ 2026-10-27（用户实测 P20261027-01：「刚组的卷打印有问题，应该是受了 M0111 的影响」）：
     三类卷面元素比纸宽——① 表内空位被按答案撑宽 ×6 列（M0111 表格 1351px/纸面 635px，右侧两列被裁）；
     ② 无空位宽表（M0066 乘方 8 列）；③ 内联 <svg> 带像素 width（物理/化学 45 张卡，10-12 只修了 img）。
     本用例守：渲染链真实性（空位真的带行内 min-width）/ CSS 封顶规则在场（删规则即红）/
     headless Edge 真排版 0 溢出 / 阴性自证（掏掉规则必须复现溢出）。 */
  ['neg-stem-table-fit.cjs'],
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
  ['neg-paper-count-and-ledger-filter.mjs'], // ★ 组卷角标/配卷屏同口径 + 台账按学生过滤 + 行可读性 + 未入账打印警告 + 回录题号 + 台账复原卷 + 操作条吸顶（75+ 断言）
  /* ★ 2026-10-24（用户报障「我给学生A出了两次试卷，发现第一次与第二次题目是一样的」）：
     实测两批交集 30/30。两层根因各一条断言：① 工具侧没有"这题最近印过"的概念 → 新增防重复组卷门禁（默认 7 天）；
     ② 入账后不清空选题篮（localStorage 持久化）→ 下次直接再印一遍。
     真跑工具（副本库，不碰真库）+ 变异自证（把 REPEAT_DAYS 掏成 0，拦截必须消失）。 */
  ['neg-paper-no-repeat.cjs'],
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
  /* P01：发行包夹带开发机日志。实测 release\GlimmerNote-2026.10.30.03 的 app\shell.log 有 480 字节，
     内容是本机绝对路径；根因是打包脚本整目录复制界面目录。本用例从 build-release.ps1 里**读出真实
     黑名单**在临时目录上实跑，并用"规则掏空"做阴性自证。 */
  ['neg-release-package-hygiene.cjs'],
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
