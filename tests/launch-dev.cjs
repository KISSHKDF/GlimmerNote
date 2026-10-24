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
      /* ★ 2026-10-23：显式指定库根 —— 壳与测试必须看同一份数据，否则界面回归断言对不上 */
      CTB_DATA: E.LIB,
    }),
  });
  p.unref();
  console.log('relaunched pid', p.pid);
  process.exit(0);
})();
