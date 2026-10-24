#!/usr/bin/env node
/**
 * 用合成演示库重截 docs\images 三张界面截图（★ 2026-10-24 B-09 配套）
 *
 * 为什么存在：三张文档截图原先截自真实题库（真实学生名/真实卷面标题/真实库路径随图入仓）。
 * 本脚本改用 scripts\make-demo-lib.mjs 生成的**纯合成库**，通过 服务端 + headless Edge 通道
 * （与 tests\neg-v2-ui-review-bank.cjs 同法，无需构建 exe）渲染并截图，直接覆盖 docs\images\*.png。
 *
 * 前置：node scripts\make-demo-lib.mjs --out <演示库>
 * 用法：node scripts\make-doc-shots.mjs --lib <演示库>    （缺省 %TEMP%\gn-demo-lib）
 * 自检（有牙齿，不过拒写盘）：
 *   ① 页面文本必须含合成学生名（学生A/学生B）、必须**不含**任何真实化名（词表 repo-hygiene）；
 *   ② 三张产物都 > 20 KB（防空页面截图）。
 * 退出码 0=全部成功。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 库定位：--lib 或缺省临时演示库；必须在 require 测试环境**之前**设好 CTB_TEST_LIB */
const LIB = (() => {
  const i = process.argv.indexOf('--lib');
  const p = i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(os.tmpdir(), 'gn-demo-lib');
  if (!fs.existsSync(path.join(p, '_状态.json'))) {
    console.error('[make-doc-shots] ✖ 演示库不存在或缺 _状态.json：' + p + '\n  先跑 node scripts\\make-demo-lib.mjs --out <目录>');
    process.exit(1);
  }
  return p;
})();
process.env.CTB_TEST_LIB = LIB;
const E = require(path.join(ROOT, 'tests', '_测试环境.cjs'));

const CSS_W = 1536, CSS_H = 808;        // 与真实桌面壳一致的 CSS 视口口径（neg-v2-ui 同款）
/* ★ 2026-10-24：真实化名词表从 repo-hygiene 引（唯一真源）——
   本文件自己写死字面量就会让全仓机检（repo-hygiene）红，自食其果实测一次。 */
const { REAL_NAMES } = require(path.join(ROOT, 'tests', 'repo-hygiene.cjs'));
const SYN_NAMES = ['学生A', '学生B'];    // 演示库合成学生名：必须出现
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EDGES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGES.find(p => fs.existsSync(p));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

class Cdp {
  constructor() { this.id = 0; this.pm = new Map(); this.errs = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    const c = new Cdp(); c.ws = ws;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pm.has(m.id)) { const p = c.pm.get(m.id); c.pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') c.errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
    };
    return c;
  }
  send(method, params = {}, timeoutMs = 20000) { const id = ++this.id; return new Promise((res, rej) => {
    const t = setTimeout(() => { this.pm.delete(id); rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + method)); }, timeoutMs);
    this.pm.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch { } }
}

(async () => {
  if (!EDGE) { console.error('[make-doc-shots] ✖ 找不到 msedge.exe'); process.exit(2); }
  const srv = await E.startServer({ data: LIB });
  console.log('[make-doc-shots] 服务端 ' + srv.base + '｜演示库 ' + LIB);

  const CDP_PORT = await freePort();
  const profile = path.join(os.tmpdir(), 'gn-docshots-' + process.pid);
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, '--window-size=' + CSS_W + ',' + CSS_H, 'about:blank'], { stdio: 'ignore' });
  let home = null;
  for (let i = 0; i < 60 && !home; i++) {
    try { const ts = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json(); home = ts.find(t => t.type === 'page'); } catch { }
    if (!home) await sleep(400);
  }
  if (!home) { try { proc.kill(); } catch { } console.error('[make-doc-shots] ✖ Edge 调试口未就绪'); process.exit(2); }
  const c = await Cdp.connect(home.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: CSS_W, height: CSS_H, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('ctb2.seen','1');localStorage.setItem('ctb2.student','\"全部\"');" +
      "localStorage.setItem('ctb2.theme','\"light\"');localStorage.removeItem('ctb2.side');" +
      "localStorage.removeItem('ctb2.filters');localStorage.removeItem('ctb2.rvSrc');localStorage.removeItem('ctb2.rvSj');}catch(e){}"
  });
  /* ★ ?ctbPort= 是前端的通道探测提示（neg-v2-ui 同法）：没有它页面会落进 offline 模式连不上服务端。 */
  await c.send('Page.navigate', { url: srv.base + '/index.html?ctbPort=' + srv.port });
  let booted = false;
  for (let i = 0; i < 80 && !booted; i++) {
    try { booted = await c.evalJs('!!(window.CTB&&CTB.model&&CTB.model.cards&&CTB.model.cards.length)'); } catch { }
    if (!booted) await sleep(500);
  }
  if (!booted) { c.close(); try { proc.kill(); } catch { } await srv.stop(); console.error('[make-doc-shots] ✖ 页面没起来：' + await c.evalJs("(document.getElementById('bootMsg')||{}).textContent")); process.exit(1); }
  console.log('[make-doc-shots] 页面就绪，卡 ' + await c.evalJs('CTB.model.cards.length') + ' 张');

  /* ① 牙齿断言：页面文本含合成名、绝不含真实化名 */
  const bodyText = String(await c.evalJs('document.body.innerText || ""'));
  const badNames = REAL_NAMES.filter(n => bodyText.includes(n));
  const missSyn = SYN_NAMES.filter(n => !bodyText.includes(n));
  if (badNames.length || missSyn.length) {
    c.close(); try { proc.kill(); } catch { } await srv.stop();
    console.error('[make-doc-shots] ✖ 化名自检失败：出现真实化名 [' + badNames.join(',') + ']｜缺合成名 [' + missSyn.join(',') + '] —— 拒绝截图');
    process.exit(1);
  }
  console.log('[make-doc-shots] 化名自检 ✔（含 ' + SYN_NAMES.join('/') + '，无真实化名）');

  const OUT = {
    dash: path.join(ROOT, 'docs', 'images', '面板-首页-浅色.png'),
    paper: path.join(ROOT, 'docs', 'images', '组卷-预览.png'),
    stats: path.join(ROOT, 'docs', 'images', '统计-深色.png'),
  };

  /* ② 面板·首页（浅色） */
  await c.evalJs(`CTB.shell.applyTheme('light'); CTB.shell.route('dash'); 1`);
  await sleep(1100);
  await c.shot(OUT.dash);
  console.log('  ✔ ' + OUT.dash);

  /* ③ 组卷·预览（浅色；入篮 3 张可组卷卡后点预览，与 e2e 同路径） */
  await c.evalJs(`(function(){
    CTB.model.basketSet(CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card)}).slice(0,3).map(function(x){return x.kid+'|'+x.card.id}));
    CTB.shell.route('paper',{reset:true}); return 1; })()`);
  await sleep(700);
  await c.evalJs(`(function(){var b=document.getElementById('ppPrev')||document.getElementById('pbPrev2');if(b)b.click();return 1})()`);
  await sleep(1600);
  await c.shot(OUT.paper);
  console.log('  ✔ ' + OUT.paper);

  /* ④ 统计（深色） */
  await c.evalJs(`CTB.shell.applyTheme('dark'); CTB.shell.route('stats'); 1`);
  await sleep(1200);
  await c.shot(OUT.stats);
  console.log('  ✔ ' + OUT.stats);

  /* ⑤ 产物健全性：三张都要有肉 */
  const sizes = Object.values(OUT).map(f => { try { return fs.statSync(f).size; } catch { return 0; } });
  const tooSmall = Object.entries(OUT).filter(([, f], i) => sizes[i] < 20 * 1024).map(([, f]) => path.basename(f));
  c.close(); try { proc.kill(); } catch { }
  await srv.stop();
  if (c.errs.length) { console.error('[make-doc-shots] ⚠ 页面 JS 异常：' + c.errs.slice(0, 2).join(' | ')); }
  if (tooSmall.length) { console.error('[make-doc-shots] ✖ 截图疑似空页面（<20KB）：' + tooSmall.join(',')); process.exit(1); }
  console.log('[make-doc-shots] ✔ 三张截图已写入 docs\\images（' + sizes.map(s => Math.round(s / 1024) + 'KB').join(' / ') + '）');
})().catch(e => { console.error('[make-doc-shots] EXC ' + (e && e.stack || e)); process.exit(1); });
