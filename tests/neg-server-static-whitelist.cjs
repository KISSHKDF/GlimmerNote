#!/usr/bin/env node
/**
 * R2（2026-11-02）· 库内静态路由白名单 + `Cache-Control: no-store`
 *
 * 缺陷（ws1-http 2026-11-02 亲测，合成库 + 真库交叉）：
 *   静态路由只做「库根包含性」判据 ⇒ 库根下**任何**文件都能被一条不带 token 的裸 GET 读走：
 *     `/.git/index` → 200 / 198619 B（整树可读：config、对象库、reflog）
 *     `/_待确认.json` → 200 / 324907 B、`/_原卷台账.json` → 200 / 303986 B
 *   且**没有任何 `Cache-Control`**（该头只在程序根 index.html 分支发）。
 *
 * 判据（`src\tools\_服务端.mjs::staticAllowed`，唯一实现）——四道，任一命中即 403：
 *   ① 任一路径段以 `.` 开头；② 目录段以 `_` 开头且不在 `{_原图, _收件箱}`；
 *   ③ 文件名以 `_` 开头且不在 `{_组卷台账.json}`；④ 文件名含 `.bak`。
 *   库内（非程序根）响应必须带 `Cache-Control: no-store`。
 *
 * 本用例的库是**自建临时库**（%TEMP%），因此正/负对照都逐条可控、不依赖真库现状：
 *   负对照（必须 403）：`.git\config`、`.git\index`、`.git\objects\xx\yy`、`_状态.json`、
 *     `_待确认.json`、`_待确认清单.md`、`_原卷台账.json`、`_备份-真源\x.json`、`_影像备份\x.jpg`、
 *     `_原图\_快照\x`、`_原图\_来源映射.csv`、`x.json.bak-1`（+ `_盲解`/`_快照`/`_probe`）
 *   正对照（必须 200 + no-store + 字节相同）：卡片 `题图.jpg`/`题干.html`/`错题记录.md`、
 *     `_原图\<sha256>.jpg`、`_收件箱\<批次>\x.jpg`、`_组卷台账.json`（UI 唯一静态读的根台账）
 *   阴性自证：把白名单调用点掏掉（源码级替身）⇒ `.git/config` 必须变 200（缺陷复现）。
 *
 * 退出码 0 = 全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, req, waitHealth, counter } = require('./neg-server-lib.cjs');

const { A, end } = counter();
const PORT = 18021;          // 被测（真源码）
const MUT_PORT = 18022;      // 阴性自证（掏掉白名单的源码级替身）
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-whitelist-lib-'));
const MUT_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-whitelist-mut-'));

/* 写一个库内文件（相对路径用 `/` 分段，内容可控，便于逐字节比对） */
function w(rel, text) {
  const p = path.join(LIB, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

function startServerAt(serverJs, port) {
  const proc = spawn(process.execPath, [serverJs], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: LIB }),
  });
  const s = { proc, out: '', err: '', port };
  proc.stdout.on('data', d => { s.out += d; });
  proc.stderr.on('data', d => { s.err += d; });
  s.stop = () => new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; setTimeout(res, 120); } };
    proc.once('exit', fin);
    try { proc.kill(); } catch (e) { }
    setTimeout(fin, 1500);
  });
  return s;
}

/** 源码级替身：只把白名单调用点掏掉（`!fromApp && !staticAllowed(rel)` → `false`），其余一字不动 */
function makeNoWhitelistRepo() {
  const repo = path.join(MUT_REPO, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'app'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'tools'))) {
    fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(repo, 'src', 'tools', f));
  }
  fs.copyFileSync(path.join(ROOT, 'src', 'app', 'index.html'), path.join(repo, 'src', 'app', 'index.html'));
  const p = path.join(repo, 'src', 'tools', '_服务端.mjs');
  const src = fs.readFileSync(p, 'utf8');
  const from = '!fromApp && !staticAllowed(rel)';
  if (!src.includes(from)) {
    throw new Error('阴性自证无效：源码里找不到白名单调用点 ' + JSON.stringify(from) + ' —— 先改本用例，别让它变成恒真');
  }
  fs.writeFileSync(p, src.split(from).join('false'), 'utf8');
  return path.join(repo, 'src', 'tools', '_服务端.mjs');
}

(async () => {
  /* ── 造库：负对照 + 正对照 ── */
  const NEG = [
    ['.git/config', '库内 .git 整树（remote url 就在里面）'],
    ['.git/index', '库内 .git 索引（真实 198619 B）'],
    ['.git/objects/xx/yy', '库内 git 对象'],
    ['_状态.json', '状态包（1.35 MB 级）'],
    ['_待确认.json', '人工判读台账（真实 324907 B）'],
    ['_待确认清单.md', '待办清单'],
    ['_原卷台账.json', '原卷台账（真实 303986 B）'],
    ['_备份-真源/x.json', '真源备份目录（整树）'],
    ['_影像备份/x.jpg', '影像备份目录（整树）'],
    ['_盲解/x.md', '盲解留档目录'],
    ['_快照/x', '快照目录'],
    ['_probe/x', '探针目录'],
    ['_原图/_快照/x', '未命名允许目录下的**子**隐藏目录'],
    ['_原图/_来源映射.csv', '保全库里以下划线开头的人工判读产物'],
    ['x.json.bak-1', '备份残留'],
  ];
  for (const [rel] of NEG) w(rel, 'NEG-' + rel);

  const CARD = '九年级/物理/P0001-测试卡';
  const POS = [
    [CARD + '/题图.jpg', 'BIN-题图-测试卡'],
    [CARD + '/题干.html', '<div class="stem">POS-题干-测试卡</div>'],
    [CARD + '/错题记录.md', '# POS-错题记录'],
    ['_原图/0123456789abcdef0123456789abcdef.jpg', 'BIN-保全库原图'],
    /* 真库的 `_原图` 是**两位十六进制分片**布局（实测 `_原图\00\<sha256>.jpg`）——
       分片目录不是下划线开头，必须照样放行（否则真库全部原图 403）。 */
    ['_原图/a1/a1b2c3d4e5f60718293a4b5c6d7e8f90.jpg', 'BIN-保全库原图（分片布局）'],
    ['_收件箱/批次20261102/x.jpg', 'BIN-收件箱原图'],
    ['_组卷台账.json', '{"papers":[],"POS":"组卷台账"}'],
  ];
  for (const [rel, text] of POS) w(rel, text);

  const srv = startServerAt(path.join(ROOT, 'src', 'tools', '_服务端.mjs'), PORT);
  let code = 1;
  try {
    if (!await waitHealth(PORT)) {
      A('被测实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；stderr=' + srv.err.slice(0, 300));
      process.exit(end('R2 静态白名单'));
    }
    A('被测实例启动（127.0.0.1:' + PORT + '，库=临时库）', true);

    console.log('\n══ ① 负对照：这些路径必须 403（改前全部 200 + 原字节）══');
    for (const [rel, why] of NEG) {
      const url = '/' + rel.split('/').map(encodeURIComponent).join('/');
      const r = await req(PORT, url);
      A('GET ' + url + ' → 403（' + why + '）', r.status === 403, 'status=' + r.status + ' body=' + r.text.slice(0, 90));
      A('  ↳ 403 响应体里没有原文件字节', !r.text.includes('NEG-' + rel), r.text.slice(0, 60));
    }

    console.log('\n══ ② 正对照：UI 真正要读的库内文件必须 200 + no-store + 字节一致 ══');
    for (const [rel, text] of POS) {
      const url = '/' + rel.split('/').map(encodeURIComponent).join('/');
      const r = await req(PORT, url);
      A('GET ' + url + ' → 200（' + rel + '）', r.status === 200, 'status=' + r.status + ' body=' + r.text.slice(0, 90));
      A('  ↳ Cache-Control: no-store', r.headers['cache-control'] === 'no-store', 'CC=' + r.headers['cache-control']);
      A('  ↳ 正文与原文件逐字节相同', r.text === text, 'len=' + r.text.length + '/' + text.length);
      A('  ↳ Content-Length 与实际字节一致（R7 流式头的回归）',
        Number(r.headers['content-length']) === Buffer.byteLength(text, 'utf8'),
        'CL=' + r.headers['content-length'] + ' 实际=' + Buffer.byteLength(text, 'utf8'));
    }

    console.log('\n══ ③ 程序根不受白名单影响（白名单只管库内数据）══');
    {
      const home = await req(PORT, '/index.html');
      const idxHtml = fs.readFileSync(path.join(ROOT, 'src', 'app', 'index.html'), 'utf8');
      A('GET /index.html → 200（程序入口照常）', home.status === 200, 'status=' + home.status);
      A('  ↳ 程序根 index.html 仍注入 token（白名单没把它拦掉）', /__ctbToken/.test(home.text), '');
      A('  ↳ 程序根 CSP 不含 default-src（应用代码要能执行 host.js）', !/default-src/.test(String(home.headers['content-security-policy'])), String(home.headers['content-security-policy']));
      A('  ↳ 注入位置正确（在 </head> 之前，早于任何脚本）', home.text.indexOf('__ctbToken') < (home.text.search(/<\/head\s*>/i) + 7), '');
      A('  ↳ 程序根响应体除注入外与原文件逐字符一致',
        home.text.replace(/<script>window\.__ctbToken="[0-9a-f]+";<\/script>/, '') === idxHtml,
        'len=' + home.text.length + '/' + idxHtml.length);
    }

    console.log('\n══ ④ 阴性自证：掏掉白名单判据 ⇒ .git/config 必须变 200（缺陷复现）══');
    {
      const mutJs = makeNoWhitelistRepo();
      const mut = startServerAt(mutJs, MUT_PORT);
      try {
        if (!await waitHealth(MUT_PORT)) {
          A('替身实例启动（127.0.0.1:' + MUT_PORT + '）', false, 'health 超时；stderr=' + mut.err.slice(0, 300));
        } else {
          A('替身实例启动（同一临时库，仅掏掉白名单调用点）', true);
          const g = await req(MUT_PORT, '/.git/config');
          A('替身：GET /.git/config → 200（缺陷复现，证明上面的 403 有牙齿）', g.status === 200,
            'status=' + g.status + ' body=' + g.text.slice(0, 60));
          A('替身：正文就是库内 .git/config 原文', g.text === 'NEG-.git/config', g.text.slice(0, 60));
          const p2 = await req(MUT_PORT, '/_待确认.json');
          A('替身：GET /_待确认.json → 200（台账同一条通道，一并复现）', p2.status === 200, 'status=' + p2.status);
          A('替身：真源码下同一请求是 403（对照，证明差别只来自判据）',
            (await req(PORT, '/_待确认.json')).status === 403, '');
        }
      } finally { await mut.stop(); }
    }
    code = end('R2 库内静态路由白名单 + no-store');
  } finally {
    await srv.stop();
    fs.rmSync(LIB, { recursive: true, force: true });
    fs.rmSync(MUT_REPO, { recursive: true, force: true });
  }
  process.exit(code);
})().catch(e => {
  console.error('FATAL ' + (e && e.stack || e));
  try { fs.rmSync(LIB, { recursive: true, force: true }); } catch (x) { }
  try { fs.rmSync(MUT_REPO, { recursive: true, force: true }); } catch (x) { }
  process.exit(1);
});
