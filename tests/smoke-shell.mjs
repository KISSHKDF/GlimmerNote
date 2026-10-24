/* 壳冒烟：真启动 exe → 等 CDP → 读 DOM → 断言界面真的渲染了 → 截图 → 关掉
 *
 * 为什么不用"进程起来了"当判据：进程活着不代表界面可用。v2 有两层失败：
 *   ① 壳起不来（缺 WebView2 运行时 / 缺 dll）—— 进程直接没了；
 *   ② 壳起来了但页面 boot 失败（找不到 index.html / 拿不到状态包）—— 窗口一片红字。
 * 只测①会漏掉②，而②才是用户真实看到的样子。所以判据取 DOM：boot 层被移除、app 层可见。
 *
 * 用法：node tests\smoke-shell.mjs [--exe <路径>] [--data <数据目录>] [--keep]
 * 退出码 0=绿；非 0=红。
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(argOf('--port', '9223'));
const KEEP = argv.includes('--keep');

/* exe 位置：默认开发区产物，也允许指向运行区（--exe）。
   ⚠ 不允许指向冻结区 —— 那是在验老程序，等于假绿。 */
const exe = path.resolve(argOf('--exe', path.join(ROOT, 'src', 'app', '拾光小册.exe')));
if (/(^|[\\/])错题本([\\/]|$)/.test(exe)) {
  console.error('✖ 拒绝运行：--exe 指向冻结区 → ' + exe);
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const A = (n, ok, d) => {
  console.log((ok ? '  [OK]  ' : '  [FAIL] ') + n + (d !== undefined && d !== '' ? '  → ' + String(d).slice(0, 300) : ''));
  if (!ok) fails++;
};

function killShell() {
  const name = path.basename(exe, '.exe');
  spawnSync('taskkill', ['/F', '/IM', name + '.exe'], { encoding: 'utf8' });
}
async function waitPort(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) return true; } catch { }
    await sleep(400);
  }
  return false;
}
async function cdp(ws, method, params, id) {
  const msg = JSON.stringify({ id: id, method: method, params: params || {} });
  ws.send(msg);
}
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('open', () => res({
      send(method, params) {
        return new Promise((ok, no) => {
          const id = ++seq;
          pending.set(id, { ok, no });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => { if (pending.has(id)) { pending.delete(id); no(new Error('CDP timeout: ' + method)); } }, 30000);
        });
      },
      close() { try { ws.close(); } catch { } },
    }));
    ws.addEventListener('error', e => rej(new Error('ws error')));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const { ok, no } = pending.get(m.id); pending.delete(m.id);
        m.error ? no(new Error(JSON.stringify(m.error))) : ok(m.result);
      }
    });
  });
}
const evalJs = async (c, expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.text || '') + ' ' + JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 200));
  return r && r.result ? r.result.value : undefined;
};

(async () => {
  console.log('═══ 壳冒烟：' + exe);

  A('exe 存在', fs.existsSync(exe), exe);
  if (!fs.existsSync(exe)) process.exit(1);

  // 同目录必须齐 3 个运行库（exe 的运行时同伴，缺一个就起不来）
  const dir = path.dirname(exe);
  for (const d of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) {
    A('exe 旁边有 ' + d, fs.existsSync(path.join(dir, d)));
  }

  console.log('=== ① 清场 + 拉起（CDP ' + PORT + '）===');
  killShell();
  await sleep(1500);

  const env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    CTB_DEV: '1',
  });
  const dataDir = argOf('--data', '');
  if (dataDir) env.CTB_DATA = path.resolve(dataDir);

  const p = spawn(exe, [], { detached: true, stdio: 'ignore', env });
  p.unref();
  console.log('  pid=' + p.pid + (dataDir ? '  CTB_DATA=' + path.resolve(dataDir) : ''));

  const up = await waitPort(45000);
  A('CDP 端口就绪（壳窗口与 WebView2 都起来了）', up, up ? `127.0.0.1:${PORT}` : '45s 内未就绪');
  if (!up) { if (!KEEP) killShell(); console.log('\nRESULT=FAIL'); process.exit(1); }

  console.log('=== ② 连 CDP，看页面到底渲染了什么 ===');
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  A('拿到 page target', !!page, page ? page.url.slice(0, 120) : JSON.stringify(list.map(t => t.type)));
  if (!page) { if (!KEEP) killShell(); console.log('\nRESULT=FAIL'); process.exit(1); }

  const c = await connect(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Page.enable');

  // 等 boot 完成（最多 40s：空库要等 state 往返）
  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    st = await evalJs(c, `(function(){
      var boot=document.getElementById('boot'), app=document.getElementById('app');
      var msg=document.getElementById('bootMsg');
      return JSON.stringify({
        hasBoot: !!boot, bootVisible: !!(boot && !boot.hidden && boot.style.display!=='none'),
        bootMsg: msg ? msg.textContent : null,
        appHidden: app ? app.hidden : null,
        appDisplay: app ? getComputedStyle(app).display : null,
        viewLen: (document.getElementById('view')||{innerHTML:''}).innerHTML.length,
        sidebarLen: (document.getElementById('sidebar')||{innerHTML:''}).innerHTML.length,
        title: document.title,
        ctbVer: (window.CTB && CTB.version) || null,
        hostMode: (window.CTB && CTB.host && CTB.host.mode) || null,
        bodyText: (document.body.innerText||'').slice(0,300)
      });
    })()`);
    const j = st ? JSON.parse(st) : null;
    if (j && !j.bootVisible && j.appHidden === false && j.viewLen > 200) break;
    await sleep(800);
  }
  const S = st ? JSON.parse(st) : {};

  A('boot 遮罩已移除（没卡在"正在连接…"）', S.bootVisible === false, 'bootMsg=' + S.bootMsg);
  A('#app 已显示', S.appHidden === false, 'hidden=' + S.appHidden);
  A('#view 有内容（视图真的渲染了）', (S.viewLen || 0) > 200, 'view innerHTML=' + S.viewLen + ' 字符');
  A('#sidebar 有内容（导航渲染了）', (S.sidebarLen || 0) > 100, S.sidebarLen + ' 字符');
  A('宿主通道 = shell（走的是桌面壳桥，不是离线）', S.hostMode === 'shell', 'mode=' + S.hostMode);
  /* 版本号：唯一真源是 VERSION.json，打包时由 build-release.ps1 生成 app\版本.js。
     开发目录里没有 版本.js ⇒ 界面显示 'dev'，这是**正确**行为（不是缺陷）。
     所以判据分两种：旁边有 版本.js → 必须等于 VERSION.json；没有 → 必须恰好是 'dev'。 */
  const appDir = path.dirname(exe);
  const verJsPath = path.join(appDir, '版本.js');
  const wantVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'VERSION.json'), 'utf8')).version;
  if (fs.existsSync(verJsPath)) {
    A('界面版本 = VERSION.json（打包态）', S.ctbVer === wantVer, 'CTB.version=' + S.ctbVer + ' / VERSION.json=' + wantVer);
  } else {
    A("开发态无 版本.js ⇒ 界面显示 'dev'", S.ctbVer === 'dev', 'CTB.version=' + S.ctbVer);
  }

  // 页面里不许有"未连接数据通道"这类致命文案
  const fatal = /未连接数据通道|未找到数据通道|❌/.test(String(S.bodyText || ''));
  A('页面上没有致命报错', !fatal, fatal ? S.bodyText.slice(0, 200) : '干净');

  console.log('=== ③ 截图 ===');
  try {
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(ROOT, 'tests', 'out');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const shotPath = path.join(outDir, 'shell-smoke.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    const len = fs.statSync(shotPath).size;
    A('截图已存', len > 10000, shotPath + '（' + len + ' 字节）');
    console.log('  截图：' + shotPath);
  } catch (e) {
    A('截图已存', false, e.message);
  }

  // 控制台致命的 JS 错误
  const errs = await evalJs(c, `JSON.stringify((window.__SMOKE_ERR||[]))`).catch(() => '[]');
  c.close();

  console.log('\n  页面标题：' + S.title + '　界面版本：' + S.ctbVer);
  console.log('  正文前 200 字：' + String(S.bodyText || '').replace(/\s+/g, ' ').slice(0, 200));

  if (!KEEP) { console.log('=== ④ 关掉壳 ==='); killShell(); }

  console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS'));
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.log('EXC ' + (e && e.stack || e));
  if (!KEEP) killShell();
  process.exit(3);
});
