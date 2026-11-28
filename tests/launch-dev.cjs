const path = require('path');
/* 杀旧壳 → **等它真的死透** → 重编译 → 带调试端口重启（taskkill 按镜像名，绕开 wmic 缺失）
 *
 * ⚠ 2026-10-11 修「门禁抖动」的真实根因（本轮实测 3 次 full：2 绿 1 抖）：
 *   旧实现是 `taskkill` → 死等 2000ms → build → spawn。两个致命假设都错：
 *     ① `taskkill` 返回 ≠ 进程已退出。旧壳可能还在收尾（WebView2 子进程/单实例互斥体/文件锁仍在），
 *        于是新壳起来时**撞上单实例互斥体直接退出**（进程表里看不到它，但端口还开着）；
 *     ② 2000ms 是拍的，不是等的。旧壳一死，`run.mjs` 的 `waitPort(9223)` 可能连到**这个正在死的旧壳**上并立刻"成功"，
 *        于是 e2e 打到一半壳消失 ⇒ 无任何 `[FAIL]` 的 `TypeError: fetch failed`。
 *   现在：**轮询到进程真的消失**（最多 15s）→ **等到 9223 确实关闭**（最多 10s）→ 再编译、再拉起。
 *   顺序不能反：不等端口关闭，waitPort 就仍可能命中旧壳。
 *   诚实声明：这样改消除了上面两个竞态，但**不能证明**抖动已根除（本次未复现原抖动）；
 *   它把"猜测的等待"换成了"观察到的状态"，这本身是可验证的改进。
 */
const cp = require('child_process');
const net = require('net');
const fs = require('fs');
/* ★ 2026-10-23：测试环境（仓库 / 工具 / 库根）——拉起壳时要显式指定库根 */
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');   // 2026-10-12：原写死真库绝对路径，改为自推导
const EXE = path.join(ROOT, 'src', 'app', '拾光小册.exe');
const BUILD = path.join(ROOT, 'src', 'shell', 'build.ps1');
const PORT = 9223;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function portUp(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    const done = v => { try { s.destroy(); } catch { } res(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(1200, () => done(false));
  });
}
function shellCount() {
  const r = cp.spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-Process -Name 拾光小册 -ErrorAction SilentlyContinue | Measure-Object).Count'],
    { encoding: 'utf8' });
  const n = parseInt(String(r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

(async () => {
  /* ★★ 2026-11-26（真实事故，根因封堵）：**开发壳绝不许指向用户真库**。
   *
   * 事故现场（实测，日志为证 `%LOCALAPPDATA%\拾光小册\shell.log`）：
   *   22:27:00  起了一个壳，导航白名单是 `file:<运行区>\app\index.html`
   *             ⇒ 它的 DataRoot = **用户真库** `<运行区>\数据`；
   *   22:28:43  那个壳收到 `op=mark`（动作=批改），把真库里**待批改批次 P20261117-06
   *             的 30 张卡全判了**（note='桌面版回录'），并重写了索引的复习流水与复习日志。
   *             ⇒ 用户的真实复习记录被测试污染（真库零写入断言在收尾时才判红，但数据已脏）。
   *
   * 为什么以前没挡住：`launch-dev.cjs` 把 `CTB_DATA: E.LIB` 传给壳，而 E.LIB 在开发机上
   * **就是真库**（`isFrozen()` 为 true）。开发壳 = 真库 + **带 CDP 调试口** ⇒
   * 任何一条 CDP 用例都能点它的按钮、提交它的表单 ⇒ 它就是一个"能被自动化点击的真实程序"。
   *
   * 修法（**不静默改库根**，那会让测试的断言对不上用户数据）：**开发壳一律用副本库**。
   *   · 副本 = makeTempLib（含卡目录文件：题干.html/错题记录.md —— 组卷要过盲解指纹门禁）；
   *   · **不含影像**（1.4 GB）⇒ 选不出带图的卡是已知的取舍（见 e2e-writepath 的同款说明）；
   *   · 壳与工具必须看**同一份**副本 ⇒ CTB_DATA 指向副本，且本进程写进 process.env，
   *     让所有"忘了传 env"的子进程也自动对上；
   *   · 用户若**显式**给了 CTB_TEST_LIB（= 想在副本上跑），照它来；
   *   · 真库上跑门禁 ⇒ **只读**（本仓红线 2：任何脚本都不得写 数据\）。
   */
  const LIB_IS_FROZEN = E.isFrozen(E.LIB);
  let SHELL_LIB = E.LIB;
  if (LIB_IS_FROZEN) {
    /* keep:true ⇒ 这份副本**活过本进程**（launch-dev 是 fire-and-forget，起完壳就退出；
       默认的「退出时切除」会把壳的库根删掉 ⇒ 壳报「重建后仍无 _状态.json」，
       e2e-ui 直接红在"启动完成·数据到位"）。它由下一轮 sweepStaleTempDirs 按陈旧期回收。
       copyOrigPages ⇒ 整页原卷也复制过来（210 MB）—— e2e-ui 的两条「整页原卷」断言
       要真的加载整页图；不复制 ⇒ 那两条恒红。 */
    const tmp = E.makeTempLib(null, { copyCardFiles: true, keep: true, copyOrigPages: true });
    SHELL_LIB = tmp;
    process.env.CTB_DATA = tmp;      // 子进程默认继承 ⇒ 工具与壳看同一份
    console.log('=== ⓪ 开发壳改用副本库（真库只读）===');
    console.log('   真库（冻结区，只读）：' + E.LIB);
    console.log('   副本库（壳与工具都指它）：' + tmp);
    console.log('   副本含：索引 / 卡目录文件（题干·错题记录·题图·证据图）/ 整页原卷（210 MB）');
    console.log('   ⚠ 副本**不含卡片的原卷截图之外的大批量影像**；真跑写路径请把整库复制后设 CTB_TEST_LIB。');
  } else {
    console.log('=== ⓪ 开发壳库根：' + SHELL_LIB + '（非冻结区，直接用）===');
  }

  console.log('=== ① 杀旧壳 ===');
  const r = cp.spawnSync('taskkill', ['/F', '/IM', '拾光小册.exe'], { encoding: 'utf8' });
  console.log('taskkill:', (r.stdout || r.stderr || '').trim().replace(/\s+/g, ' '), '| code', r.status);

  console.log('=== ② 等进程真的消失（taskkill 返回 ≠ 已退出）===');
  let t0 = Date.now(), n = shellCount();
  while (n > 0 && Date.now() - t0 < 15000) { await sleep(300); n = shellCount(); }
  console.log(`剩余壳进程 = ${n}（等了 ${Date.now() - t0}ms）` + (n > 0 ? '  ⚠ 超时：旧壳仍在，新壳可能撞单实例互斥体' : '  ✔'));

  console.log('=== ③ 等调试口关闭（否则 waitPort 会连到正在死的旧壳）===');
  t0 = Date.now();
  while (await portUp(PORT) && Date.now() - t0 < 10000) await sleep(200);
  const stillUp = await portUp(PORT);
  console.log(`${PORT} 已关闭 = ${!stillUp}（等了 ${Date.now() - t0}ms）` + (stillUp ? `  ⚠ 超时：${PORT} 仍被占用，本次断言可能打到旧壳` : '  ✔'));

  console.log('=== ④ 重编译 ===');
  /* 等到 exe **真的可写**再编译：上一轮收尾拉起的壳会占着 exe，`build.ps1` 直接报
     `error CS0016 未能写入输出文件`（2026-11-11 实测失败 1 次，等 ~12s 重跑才绿）。
     进程数为 0 通常已释放锁，但 Windows 上句柄回收有延迟，所以这里再显式探一次可写性。 */
  t0 = Date.now();
  let writable = false;
  while (Date.now() - t0 < 15000) {
    try { fs.closeSync(fs.openSync(EXE, 'r+')); writable = true; break; } catch { await sleep(300); }
  }
  console.log(`exe 可写 = ${writable}（等了 ${Date.now() - t0}ms）` + (writable ? '  ✔' : '  ⚠ 超时：可能仍被占用，编译或报 CS0016'));
  const b = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BUILD], { encoding: 'utf8' });
  console.log('build:', (b.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 300));
  if (b.status !== 0) { console.log('BUILD FAIL', (b.stderr || '').slice(0, 500)); process.exit(1); }

  console.log('=== ⑤ 拉起（带 CDP 9223 + CTB_DEV=1）===');
  /* CTB_DEV=1：让壳在启动时清掉浏览缓存。
     起因（2026-10-12 实测踩到）：`file://` 下 WebView2 照样缓存 JS/CSS ——
     改了 v2\js\*.js 重跑门禁，页面仍在用**旧脚本**，FAIL 里显示的是本该已被修掉的旧行为，
     极难判断"是我改错了还是没生效"。开发态一律清缓存；日常启动不带该变量，行为不变。 */
  const p = cp.spawn(EXE, [], {
    detached: true, stdio: 'ignore',
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      CTB_DEV: '1',
      /* ★ 2026-10-23：显式指定库根 —— 壳与测试必须看同一份数据，否则界面回归断言对不上。
         ★ 2026-11-26：这里传的是**副本库**（真库冻结区时），不是用户真库 ——
            开发壳带 CDP 调试口 ⇒ 能被自动化点击 ⇒ 指向真库就等于"让测试改用户数据"（实测事故）。 */
      CTB_DATA: SHELL_LIB,
    }),
  });
  p.unref();
  console.log('relaunched pid', p.pid);
  /* ★ 2026-11-28（发版前 quick 连续判红挖出）：登记这个 pid。
     本脚本起的壳是**故意留着的**（e2e-ui 要连它的 CDP 调试口），
     而 `neg-v2-ingest-task-e2e.cjs` / `smoke-shell.mjs` 需要**独占**起壳 ——
     两者撞车 ⇒ 残留壳占着单实例互斥体 ⇒ 后起的壳立即退出 ⇒ CDP 端口永远不就绪。
     ⇒ 把 pid 登记下来，让"需要独占"的用例能**只关这一个**（按 pid 杀，不按镜像名
     ⇒ 不波及用户正开着的程序）。契约见 `_开发壳登记.cjs`。 */
  try {
    require('./_开发壳登记.cjs').rememberDevShell(p.pid);
    console.log('已登记开发壳 pid（独占用例可据此只关这一个）');
  } catch (e) { console.log('（登记开发壳 pid 失败，不阻断：' + String((e && e.message) || e).slice(0, 120) + '）'); }
  process.exit(0);
})();
