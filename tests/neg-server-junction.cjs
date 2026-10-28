#!/usr/bin/env node
/**
 * H-08-B 断言（2026-10-29 R2）：**库内 junction / symlink 不得读到库外文件**。
 *
 * 审计：`_服务端.mjs` 的包含性判据是 `path.normalize(abs)` 的**字符串前缀**比较，
 *   而 `path.normalize` **不解析** NTFS 重解析点（junction / symlink），`fs.readFile` **会跟随**它
 *   ⇒ "路径字符串在库内"与"实际读到的文件在库外"可以同时成立。审计实测（库内
 *   `mklink /J link C:\Windows`）：
 *     GET /link/win.ini                    -> 200 ct=application/octet-stream body="; for 16-bit app support…"
 *     GET /link/System32/drivers/etc/hosts -> 200 body="# Copyright (c) 1993-2009 Microsoft Corp.…"
 *   ⇒ 同一时刻 `..` 逃逸 / 同前缀兄弟目录 / 盘符 / NUL / UNC **都被正确拒绝**（403/400），
 *     唯一漏的就是重解析点这一类。
 *
 * 断言分六层：
 *   ① 纯路径自证：旧判据（字符串前缀）**放行**该路径、realpath 落在库外、realpath 判据拒绝；
 *   ② 端到端：库内正常文件 200（不过度拦截）/ 库内 junction→**库外** 403 /
 *      库内 junction→`%SystemRoot%` 403（若可建）/ 库内 junction→**库内** 200（不误伤正常软链）；
 *   ③ **阴性自证**：把"对 realpath 重跑包含性判据"掏掉之后，同一个请求必须 **200 且读到库外文件原文**；
 *   ④ 回归（审计给的最小修法**漏掉**的一条）：**库根本身就是 junction** 时，库内正常文件仍须 200 ——
 *      只比 `insideRoot(realpath)` 会把**所有**正常请求判成越界、整站静态文件全 403；
 *   ⑤ 清理安全：删 junction 不得删到它的**目标**（库外那个目录清理后必须还在）。
 *
 * 全程自建临时库 + 独立端口（7196/7197/7198），与真库、与用户正在跑的 7187 实例零接触。
 * 退出码 0=全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, SERVER, req, sleep, counter } = require('./neg-server-lib.cjs');

const E = require('./_测试环境.cjs');
const { A, S, end } = counter();
const PORT = 7196;
const PORT_MUT = 7197;
const PORT_LIBJ = 7198;
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';

/* ---------- 临时骨架：lib（库根） / outside（库外目标，**另起一棵树**，便于验证清理不会删到它） ---------- */
const ROOTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-h08b-'));
const LIB = path.join(ROOTDIR, 'lib');
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-h08b-out-'));
const LIB_JUNCTION = path.join(ROOTDIR, 'lib-as-junction');   // 指向 LIB 的 junction（模拟"库根自己是重解析点"）
const SECRET = 'OUTSIDE-SECRET-CONTENT\n';
const INSIDE = 'INSIDE-LIB-CONTENT\n';

fs.mkdirSync(LIB, { recursive: true });
fs.mkdirSync(path.join(LIB, 'sub'), { recursive: true });
fs.writeFileSync(path.join(LIB, 'inside.txt'), INSIDE);
fs.writeFileSync(path.join(LIB, 'sub', 'in.txt'), 'SUB-INSIDE\n');
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), SECRET);

function mkJunction(link, target) {
  try { fs.symlinkSync(target, link, 'junction'); return { ok: true }; }
  catch (e) { return { ok: false, err: String(e.code || e.message) }; }
}
const jOut = mkJunction(path.join(LIB, 'link-out'), OUTSIDE);
const jIn = mkJunction(path.join(LIB, 'link-in'), path.join(LIB, 'sub'));
const jWin = mkJunction(path.join(LIB, 'link-win'), SYSTEM_ROOT);
const jLib = mkJunction(LIB_JUNCTION, LIB);

/* ---------- 装置（neg-server-lib 的 startServer 写死了 E.LIB，本用例要求指定库且与真库零接触） ---------- */
function startAt(port, lib, serverPath) {
  const proc = spawn(process.execPath, [serverPath], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: lib }),
  });
  const s = { proc, out: '', err: '', port, exited: undefined };
  proc.stdout.on('data', d => { s.out += d; });
  proc.stderr.on('data', d => { s.err += d; });
  proc.on('exit', c => { if (s.exited === undefined) s.exited = c; });
  s.alive = () => s.exited === undefined;
  s.stop = () => new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; setTimeout(res, 120); } };
    proc.once('exit', fin);
    try { proc.kill(); } catch (e) { }
    setTimeout(fin, 2000);
  });
  return s;
}
async function waitHealth(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await req(port, '/health', { timeoutMs: 1500 }); if (r.status === 200) return true; } catch (e) { }
    await sleep(250);
  }
  return false;
}

/* 判据同构版（与服务端同一套写法，便于"自证有牙齿"）：旧=纯字符串前缀，新=对 realpath 重跑 */
const norm = p => path.normalize(String(p)).toLowerCase();
const oldJudge = (baseAbs, abs) => { const b = path.normalize(baseAbs).toLowerCase(); return norm(abs).startsWith(b.endsWith(path.sep) ? b : b + path.sep) || norm(abs) === b; };

const JUNCTIONS = [path.join(LIB, 'link-out'), path.join(LIB, 'link-in'), path.join(LIB, 'link-win'), LIB_JUNCTION];

(async () => {
  let srv = null, srvMut = null, srvLibJ = null;
  let code = 1;
  const stopAll = async () => { for (const s of [srvLibJ, srvMut, srv]) { if (s) { try { await s.stop(); } catch (e) { } } } };
  const cleanupJunctions = () => {
    for (const l of JUNCTIONS) {
      try { const st = fs.lstatSync(l); if (st.isSymbolicLink() || st.isDirectory()) fs.rmdirSync(l); } catch (e) { }
    }
  };
  try {
    console.log('══ ① 纯路径自证：旧判据放行、realpath 判据拒绝 ══');
    if (!jOut.ok) {
      S('① 纯路径自证', '本机建不出 junction（' + jOut.err + '）—— 该平台无法复现重解析点场景，显式跳过（不假装通过）');
    } else {
      const rel = '/link-out/secret.txt';
      const absLib = path.normalize(path.join(LIB, rel));
      const real = fs.realpathSync(absLib);
      A('待测路径的**字符串**形态落在库根之内（旧判据看得到的就是它）', oldJudge(LIB, absLib), absLib);
      A('自证：旧判据（纯字符串前缀）会**放行**这条路径（本断言的牙齿）', oldJudge(LIB, absLib) === true);
      A('realpath 解析后落在**库外**（不同的目录树）', real === path.join(OUTSIDE, 'secret.txt'), real);
      A('realpath 判据拒绝它', oldJudge(LIB, real) === false && real !== path.normalize(path.join(LIB, rel)));
    }
    A('前置：junction 创建情况', true,
      'link-out=' + (jOut.ok ? 'ok' : 'FAIL:' + jOut.err) + ' link-in=' + (jIn.ok ? 'ok' : 'FAIL:' + jIn.err) +
      ' link-win=' + (jWin.ok ? 'ok' : 'FAIL:' + jWin.err) + ' lib-as-junction=' + (jLib.ok ? 'ok' : 'FAIL:' + jLib.err));

    /* ══ ② 端到端 ══ */
    console.log('\n══ ② 端到端：库内正常 200 / junction→库外 403 / junction→库内 200 ══');
    srv = startAt(PORT, LIB, SERVER);
    if (!await waitHealth(PORT)) {
      A('独立实例启动（临时库，127.0.0.1:' + PORT + '）', false, ('stderr=' + srv.err).slice(0, 300));
      console.log(end('H-08-B 重解析点'));
      process.exit(1);
    }
    A('独立实例启动（临时库 ' + LIB + '，不与真库接触）', true);
    {
      const inside = await req(PORT, '/inside.txt');
      A('GET /inside.txt → 200 且内容正确（库内正常文件不受影响）',
        inside.status === 200 && inside.text === INSIDE, 'status=' + inside.status + ' body=' + JSON.stringify(inside.text));
      const sub = await req(PORT, '/sub/in.txt');
      A('GET /sub/in.txt → 200（库内子目录不受影响）', sub.status === 200 && sub.text === 'SUB-INSIDE\n', 'status=' + sub.status);
    }
    if (jOut.ok) {
      const r = await req(PORT, '/link-out/secret.txt');
      A('GET /link-out/secret.txt → **403**（库内 junction 指向库外，审计实测改前是 200）',
        r.status === 403, 'status=' + r.status + ' body=' + r.text.slice(0, 90));
      A('403 体里能看出是"链接越界"而不是普通 forbidden（可归因）',
        /forbidden \(link/.test(r.text), r.text.slice(0, 90));
      A('响应体里**没有**库外文件的内容（机密性）', !String(r.text).includes('OUTSIDE-SECRET'), JSON.stringify(String(r.text).slice(0, 60)));
      const deep = await req(PORT, '/link-out/../link-out/secret.txt');
      A('GET /link-out/../link-out/secret.txt → 403（归一化后仍指向库外链接）', deep.status === 403, 'status=' + deep.status);
    } else S('② junction→库外（403）', 'mklink 不可用：' + jOut.err);
    if (jIn.ok) {
      const r = await req(PORT, '/link-in/in.txt');
      A('GET /link-in/in.txt → 200（junction 指向**库内**时不得误伤 —— 不是"一律拒软链"）',
        r.status === 200 && r.text === 'SUB-INSIDE\n', 'status=' + r.status + ' body=' + JSON.stringify(r.text));
    } else S('② junction→库内（200）', 'mklink 不可用：' + jIn.err);
    if (jWin.ok && fs.existsSync(path.join(SYSTEM_ROOT, 'win.ini'))) {
      const r = await req(PORT, '/link-win/win.ini');
      A('GET /link-win/win.ini → **403**（复现审计原样用例：库内 junction → ' + SYSTEM_ROOT + '）',
        r.status === 403, 'status=' + r.status + ' body=' + r.text.slice(0, 80));
      A('响应体里没有 win.ini 的内容', !/for\s+16-bit app support/.test(r.text));
    } else S('② junction→' + SYSTEM_ROOT + '（403）', jWin.ok ? 'win.ini 不存在' : ('mklink 不可用：' + jWin.err));

    /* ══ ③ 阴性自证：掏掉"对 realpath 重跑判据" ══ */
    console.log('\n══ ③ 阴性自证：掏掉 realpath 判据后必须读到库外内容 ══');
    {
      const src = fs.readFileSync(SERVER, 'utf8');
      const origLines = src.split('\n').length;
      /* 行首锚定：修复说明注释里也引用了这几个判据名，不锚定会打偏（另一个用例踩过这个坑） */
      const mut = src.replace(/^  if \(!insideApp\(real\) && !insideRoot\(real\) && !insideRealApp\(real\) && !insideRealRoot\(real\)\) \{$/m,
        '  if (false) {   // 变异：掏掉"对 realpath 重跑包含性判据"');
      A('变异锚点命中（realpath 判据那一行，行首锚定）', mut !== src);
      const mutLines = mut.split('\n').length;
      A('变异只增删了个位数行（行数差 ≤ 2）—— 防"锚点打偏、整段代码被吃"', Math.abs(mutLines - origLines) <= 2, origLines + ' 行 → ' + mutLines + ' 行');

      const mutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-h08b-mut-'));
      for (const f of ['_库根.mjs', '_安全写.mjs']) fs.copyFileSync(E.tool(f), path.join(mutDir, f));
      const mutServer = path.join(mutDir, '_服务端.mjs');
      fs.writeFileSync(mutServer, mut);
      const chk = spawnSync(process.execPath, ['--check', mutServer], { encoding: 'utf8' });
      A('变异源码语法自检通过（node --check）', chk.status === 0, String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));

      srvMut = startAt(PORT_MUT, LIB, mutServer);
      const up = await waitHealth(PORT_MUT);
      A('变异实例能正常起来', up, 'stderr=' + String(srvMut.err).slice(0, 200));
      if (up && jOut.ok) {
        const r = await req(PORT_MUT, '/link-out/secret.txt');
        A('掏掉修复后：GET /link-out/secret.txt → **200**（漏洞复现）', r.status === 200, 'status=' + r.status);
        A('掏掉修复后：响应体就是**库外**文件的原文（机密性失效，审计原样现象）',
          r.text === SECRET, JSON.stringify(r.text.slice(0, 60)));
      }
      await srvMut.stop();
      try { fs.rmSync(mutDir, { recursive: true, force: true }); } catch (e) { }
      A('变异目录已清理', !fs.existsSync(mutDir));
    }

    /* ══ ④ 回归：库根本身是 junction 时不得把整站判成越界（审计最小修法漏掉的一条） ══ */
    console.log('\n══ ④ 回归：库根本身是 junction（迁移期常见布局） ══');
    if (!jLib.ok) S('④ 库根=junction', 'mklink 不可用：' + jLib.err);
    else {
      const realLibFile = fs.realpathSync(path.join(LIB_JUNCTION, 'inside.txt'));
      A('前置：realpath(库根内文件) 落在**库根本身路径之外**（正是会误判的那种形态）',
        oldJudge(LIB_JUNCTION, realLibFile) === false, 'realpath=' + realLibFile + '  libJ=' + LIB_JUNCTION);
      srvLibJ = startAt(PORT_LIBJ, LIB_JUNCTION, SERVER);
      const up = await waitHealth(PORT_LIBJ);
      A('实例以 junction 形态的库根启动', up, 'stderr=' + String(srvLibJ.err).slice(0, 200));
      if (up) {
        const r = await req(PORT_LIBJ, '/inside.txt');
        A('GET /inside.txt → 200（库根是 junction 时**不得**把所有正常请求判成越界）',
          r.status === 200 && r.text === INSIDE, 'status=' + r.status + ' body=' + JSON.stringify(r.text.slice(0, 40)));
        const s2 = await req(PORT_LIBJ, '/sub/in.txt');
        A('GET /sub/in.txt → 200（同上，子目录也正常）', s2.status === 200, 'status=' + s2.status);
      }
      await srvLibJ.stop();
    }

    /* ══ ⑤ 清理安全：摘 junction 不得连带删到它的目标 ══
       （把断言放在 end() **之前** —— end() 一打印 RESULT，后面的断言就不计数了。） */
    console.log('\n══ ⑤ 清理安全：摘 junction 不碰目标 ══');
    await stopAll();
    cleanupJunctions();
    try { fs.rmSync(ROOTDIR, { recursive: true, force: true }); } catch (e) { }
    A('删 junction 之后，它指向的**库外目标目录仍存在**（没删到目标）', fs.existsSync(OUTSIDE), OUTSIDE);
    A('库外目标里的机密文件内容未变（未被连带删除/改写）',
      (() => { try { return fs.readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8') === SECRET; } catch (e) { return false; } })());
    try { fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch (e) { }
    A('临时树已清理（库根与库外目标目录都不在了）', !fs.existsSync(ROOTDIR) && !fs.existsSync(OUTSIDE));

    code = end('H-08-B 重解析点（junction/symlink）');
  } finally {
    /* 兜底（只在异常路径生效）：只清理，不产生断言 */
    await stopAll();
    cleanupJunctions();
    try { fs.rmSync(ROOTDIR, { recursive: true, force: true }); } catch (e) { }
    try { fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(code);
})();
