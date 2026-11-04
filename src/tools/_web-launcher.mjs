#!/usr/bin/env node
/**
 * 拾光小册 · 网页版启动器（**桌面壳起不来时的兜底通道**）
 *
 * 为什么有它（2026-11-04，用户反馈：朋友的机器上程序起不来）：
 *   桌面壳是 C# + WebView2。WebView2 Runtime（微软的浏览器内核运行时）没装时，
 *   壳会抛 WebView2RuntimeNotFoundException —— **整个程序打不开**。
 *   但本机的"读数据"能力并不依赖 WebView2：app\tools\_服务端.mjs 是一个
 *   纯 Node 的本机 HTTP 服务端，它把界面与数据都提供给普通浏览器。
 *   所以缺 WebView2 时，**还有一条能看数据的路**。
 *
 * 它做什么（就三件事，每件都失败得很响亮）：
 *   ① 起本机服务端（app\tools\_服务端.mjs），等它真的 listen 上；
 *   ② 用默认浏览器打开 http://127.0.0.1:<端口>/；
 *   ③ 把"现在能做什么/不能做什么"写在屏幕上，别让人以为功能坏了。
 *
 * ⚠ 重要边界（不写清楚就是骗人）：
 *   网页版 = **浏览 + 待办办结 + 全量重建 + 打开图片/PDF**。
 *   **不能**：新建学生、加待办、组卷、批改、录题、候选修订/正式写入、打印/存 PDF。
 *   那些都要桌面壳（写盘通道在壳里，见 src\app\js\host.js 的 mode==='shell' 分支）。
 *   ⇒ **装上 WebView2 运行时才是正解**；本启动器只是"先能看见"。
 *
 * 用法：
 *   app\node.exe app\tools\_web-launcher.mjs           （正常用法）
 *   app\node.exe app\tools\_web-launcher.mjs --no-open  （只起服务，不自动开浏览器）
 *
 * 为什么这个文件叫 ASCII 名（`_web-launcher.mjs`）而别的工具都叫中文名：
 *   包根的「网页版启动器.cmd」要按**路径**调起本文件。.cmd 是按当前代码页读的，
 *   而代码页随系统语言变（中文 936 / 英文 437）⇒ **路径里带中文会让"双击启动器"
 *   在一部分机器上找不到文件**。同理那个 .cmd 本身也只写 ASCII。
 *   中文说明交给本文件（node 读 UTF-8 永远正确）与包内《使用说明.txt》。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TOOL_DIR, '..');

/* 端口真源与 _服务端.mjs 同口径：程序根 端口.json 的 default。
   这里**只读**它用于"告诉用户该开哪个网址"，服务端自己会再读一遍（两处读同一个文件）。 */
function readPort() {
  for (const p of [path.join(APP_ROOT, '端口.json'), path.join(path.resolve(APP_ROOT, '..'), '端口.json')]) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      const n = Number(j && j.default);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    } catch (e) { /* 读不到就试下一个候选 */ }
  }
  return null;
}

const NO_OPEN = process.argv.includes('--no-open');
const PORT = readPort();

if (!PORT) {
  console.error('[网页版] ✖ 端口真源读不到（程序根 端口.json）。\r\n' +
    '  这不该发生：服务端会以同样的方式拒绝启动。请检查解压是否完整。');
  process.exit(2);
}

const SERVER = path.join(TOOL_DIR, '_服务端.mjs');
if (!fs.existsSync(SERVER)) {
  console.error('[网页版] ✖ 找不到服务端脚本：' + SERVER + '\r\n  请检查解压是否完整（app\\tools\\ 不能单独缺失）。');
  process.exit(2);
}

console.log('[网页版] 正在启动本机服务端…（首次访问可能需要几秒做一次全量重建）');

/* 起服务端：stdout/stderr 直接继承到本终端（用户能看到门禁/降级信息，别吞）。
   ⚠ 用 'inherit' 而不是 'pipe'：管道捕获在受限宿主里会 EPERM，而这里正是给人看的。
   代价是拿不到子进程的 stdout ⇒ "起来了吗"改用**探 /health** 判定（更准：
   listen 成功 = 真能应答，比读日志行更可靠）。 */
const child = spawn(process.execPath, [SERVER], {
  cwd: APP_ROOT,
  stdio: 'inherit',
  env: process.env,
});

let opened = false;
const URL_BASE = 'http://127.0.0.1:' + PORT + '/';

function maybeOpen(url) {
  if (opened) return;
  opened = true;
  if (NO_OPEN) {
    console.log('[网页版] 已跳过自动打开浏览器。请手动访问：' + url);
  } else {
    try {
      /* cmd /c start：Windows 上最不挑食的开浏览器方式（不依赖 start 的参数解析差异）。 */
      spawn('cmd.exe', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
      console.log('[网页版] 已打开浏览器：' + url);
    } catch (e) {
      console.log('[网页版] 没能自动打开浏览器，请手动访问：' + url);
    }
  }
  printUsage(url);
}

/* 探 /health：服务端真的 listen 上并应答了，才算"就绪"。
   最多等 30 秒；每 400ms 一次。失败不静默——让下面 child.on('exit') 报真因。 */
async function waitReady() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;   /* 已经退了 ⇒ 失败原因在 stderr 里 */
    try {
      const r = await fetch(URL_BASE + 'health', { cache: 'no-store' });
      if (r.ok) { await r.text(); return true; }
    } catch (e) { /* 还没起来，继续等 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

waitReady().then(ok => {
  if (ok) maybeOpen(URL_BASE);
  else if (child.exitCode === null) {
    console.error('');
    console.error('[网页版] ✖ 等了 30 秒，本机服务端没有应答（http://127.0.0.1:' + PORT + '/health）。');
    console.error('  请看上面服务端的日志找原因（最常见：端口被占 / 库目录不可写）。');
  }
}).catch(e => {
  console.error('[网页版] ✖ 探测失败：' + String(e && e.message || e));
});

function printUsage(url) {
  console.log('');
  console.log('────────────────────────────────────────────');
  console.log(' 网页版已就绪：' + url);
  console.log('');
  console.log(' 能做：浏览题库、待办办结、全量重建、打开图片/PDF');
  console.log(' 不能：新建学生、加待办、组卷/批改、录题、打印/存 PDF');
  console.log('        （这些要桌面壳；网页版只是"先能看见"）');
  console.log('');
  console.log(' ★ 正解还是装 WebView2 运行时（缺它，桌面壳根本起不来）：');
  console.log('   https://developer.microsoft.com/microsoft-edge/webview2/consumer/');
  console.log('   下载 Evergreen Standalone Installer **x64**，双击安装，不用重启电脑。');
  console.log('');
  console.log(' 按 Ctrl+C 结束本服务。');
  console.log('────────────────────────────────────────────');
}

child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error('[网页版] 服务端退出，退出码 ' + code + '（看上面的日志找原因）');
  }
  process.exit(code == null ? 0 : code);
});

/* Ctrl+C 时把子进程带走，别留一个孤儿服务端占着端口。 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { child.kill(); } catch (e) { /* 已经退了 */ }
    setTimeout(() => process.exit(0), 300);
  });
}
