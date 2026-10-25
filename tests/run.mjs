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
  } else if (code !== 0) {
    console.log('\n' + String(r.stderr || r.stdout || '').trim());
    console.log('✖ 运行区被绕过 deploy.ps1 改动过（或版本与清单不符），先归位再发版');
    process.exit(1);
  } else {
    console.log('\n✔ 运行区与部署清单一致（' + String(r.stdout || '').trim().split('\n')[0] + '）');
  }
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
     只有这几个 exit 0。加新条目必须先在干净克隆上实测。 */
  const HERMETIC = [
    ['repo-hygiene.cjs', '全仓内部痕迹机检（真实化名/内部根名 tracked 0 命中，B-09）'],
    ['neg-v2-smoke.cjs', 'v2 纯函数回归（污染/净化/fig 兜底）'],
    ['neg-shell-path.cjs', 'C# 路径包含性（源码级断言）'],
    ['neg-shell-args.mjs', 'C# 取值与参数转义（源码级断言）'],
    ['chunk-roundtrip.cjs', 'C# 分片往返逐字符相等（源码级断言）'],
    ['safe-write.test.mjs', '原子写底座自检（自带临时目录）'],
  ];
  const SKIPPED = [
    ['portability.cjs', '需要已构建的 src\\app\\拾光小册.exe（gitignored）'],
    ['e2e-ui.mjs / neg-v2-ui-*.cjs', '需要桌面壳 exe + 9223 调试口'],
    ['_原卷台账.mjs 门禁 / _配图门禁.mjs 门禁', '需要真实题库的整页原卷与题图影像'],
    ['verify-stem-shape.cjs / verify-stem-13.cjs', '需要真实题库的题干文件'],
    ['selftest-pipeline.ps1', '需要已构建的发布包与运行区'],
  ];
  let worst = 0;
  for (const [name] of HERMETIC) {
    worst = Math.max(worst, run(name));
    if (worst !== 0) { console.log('✖ 零依赖自检未过（' + name + '）'); process.exit(worst); }
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
console.log('\n──────────────────────────────');
console.log(worst === 0 ? `✔ 门禁全绿（${mode}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s）` : `✖ 门禁未过（exit ${worst}）`);
process.exit(worst === 0 ? 0 : 1);
