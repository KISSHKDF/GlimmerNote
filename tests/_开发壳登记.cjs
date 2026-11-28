/**
 * 拾光小册 · **开发壳 pid 登记**（唯一实现，2026-11-28 立）
 *
 * 背景（2026-11-28 发版前 quick 连续判红挖出）：
 *   `tests\launch-dev.cjs` 会**故意留一个带 CDP 调试口的壳**（`e2e-ui.mjs` 要连它），
 *   而 `tests\neg-v2-ingest-task-e2e.cjs` / `smoke-shell.mjs` 这类用例需要**独占**起一个壳。
 *   ⇒ 两者撞车：残留壳占着**单实例互斥体** ⇒ 后起的壳立即退出 ⇒ CDP 端口永远不就绪
 *   ⇒ 用例报「壳起来且 CDP 就绪：**失败**」。
 *
 * 为什么不能直接 taskkill /IM（按镜像名全杀）：
 *   那会把**用户正开着的程序**一起杀掉（本仓 2026-11-03 已为此修过一次，遗留口径在
 *   `neg-v2-ingest-task-e2e.cjs` 的文件头）。⇒ 必须能区分
 *   「**这个壳是测试自己起的**」与「**那是用户开的**」。
 *
 * 本模块提供的契约：
 *   · `launch-dev.cjs` 起完壳 ⇒ `rememberDevShell(pid)` 登记；
 *   · 需要独占壳的用例 ⇒ `claimExclusiveShell()` **只关登记在册的那个**；
 *   · 登记文件带 pid ⇒ 关它只按 pid 杀，不按镜像名 ⇒ 不波及用户的程序。
 *
 * ⚠ 本模块**零副作用**（不杀进程、不写盘）—— 真正的读/写/杀在上面的函数里。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** 登记文件（放 %TEMP%，不进仓库、不进真库）。 */
function devShellRegistryPath() {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || 'C:\\Windows\\Temp';
  return path.join(tmp, 'gn-dev-shell.json');
}

/** 登记刚起起来的开发壳 pid。 */
function rememberDevShell(pid) {
  try {
    fs.writeFileSync(devShellRegistryPath(),
      JSON.stringify({ pid: Number(pid), at: new Date().toISOString() }, null, 1) + '\n', 'utf8');
  } catch { /* 登记失败不该阻断起壳 */ }
}

/** 读登记（没有就返回 null）。 */
function readDevShell() {
  try {
    const p = devShellRegistryPath();
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return j && Number.isFinite(Number(j.pid)) ? Number(j.pid) : null;
  } catch { return null; }
}

/** 清登记。 */
function forgetDevShell() {
  try { fs.unlinkSync(devShellRegistryPath()); } catch { }
}

/** 那个 pid 还活着吗？（用 tasklist，只看 ASCII 的 pid 数字，避免 OEM 代码页乱码） */
function pidAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV'], { encoding: 'buffer' });
  const txt = Buffer.isBuffer(r.stdout) ? r.stdout.toString('latin1') : String(r.stdout || '');
  return txt.includes('"' + pid + '"');
}

/** 同步等 pid 消失（单实例互斥体释放有延迟，taskkill 返回 ≠ 已退出）。 */
function waitGone(pid, timeoutMs) {
  const t0 = Date.now();
  while (pidAlive(pid) && Date.now() - t0 < timeoutMs) {
    const t1 = Date.now();
    while (Date.now() - t1 < 200) { /* 让出 200ms 给系统回收 */ }
  }
  return !pidAlive(pid);
}

/**
 * 独占模式：**只**关掉「登记在册的那个开发壳」，让本用例能自己起一个。
 * 返回 { closed: boolean, pid: number|null, note: string }
 *   · 登记里没 pid / 那个 pid 已死 ⇒ 不杀任何东西（closed=false）；
 *   · 登记里的 pid 还活着 ⇒ 按 **pid** 杀它（不按镜像名 ⇒ 不波及用户正开着的程序），
 *     并等它真的退出。
 */
function claimExclusiveShell(opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 15000;
  const pid = readDevShell();
  if (!pid) return { closed: false, pid: null, note: '没有登记的开发壳（不杀任何进程）' };
  if (!pidAlive(pid)) {
    forgetDevShell();
    return { closed: false, pid, note: '登记的开发壳已死（不杀任何进程）' };
  }
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'buffer' });
  const gone = waitGone(pid, timeoutMs);
  forgetDevShell();
  return {
    closed: gone,
    pid,
    note: gone
      ? ('已关掉登记在册的开发壳 pid=' + pid + '（只按 pid 杀，没碰用户正开着的程序）')
      : ('登记的开发壳 pid=' + pid + ' 关不掉（单实例互斥体可能仍被占）'),
  };
}

module.exports = {
  devShellRegistryPath, rememberDevShell, readDevShell, forgetDevShell,
  pidAlive, claimExclusiveShell,
};
