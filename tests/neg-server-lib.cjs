#!/usr/bin/env node
/* 服务端线阴性/阳性用例的公共装置（供 tests\neg-server-*.cjs 复用）。
   职责：起一个**独立端口**的 `_服务端.mjs` 实例（绝不碰用户正在跑的 7187 那个进程）、
        原始 http.request（避免 fetch/URL 层替我们归一化路径，路径型断言必须看原始字节）、
        断言与计数、原子写（测试自己改产物文件时也别留半截）。
   本文件不是用例：直接跑它会退出 0（不产生断言）。 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
const SERVER = E.tool('_服务端.mjs');

function startServer(port) {
  const proc = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    /* ★ 2026-10-23：服务端也要读同一个库（否则它去猜库根，测试看到的是另一份数据） */
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: E.LIB }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitHealth(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await req(port, '/health', { timeoutMs: 1500 });
      if (r.status === 200) return true;
    } catch (e) { }
    await sleep(250);
  }
  return false;
}

/** 原始 http 请求：pathname 原样发出（不做 URL 归一化），返回 {status, headers, text, json} */
function req(port, pathname, { method = 'GET', headers = {}, body = null, timeoutMs = 20000, rawPath = false } = {}) {
  return new Promise((resolve, reject) => {
    /* rawPath=true 时把 pathname 当"已经贴在请求行上的原始字节"（含 `..%2f` 这类**故意编码**的
       路径穿越形态）；否则把"原始中文"转义、同时**保留已有的 %XX**——两个坑：
         · `encodeURI` 会把 `%` 再转义成 `%25`（`%` 不在 unreserved 集合里），对已编码路径会双重编码
           → 服务端 decodeURIComponent 只解一层 → 拿 `%E5…` 当文件名 → 假 404；
         · 反过来整段当已编码（不 encodeURI）时，路径里的**原始中文**会以未转义字节进请求行
           → Node 直接抛 ERR_UNESCAPED_CHARACTERS（真实浏览器不会这么发）。
       所以：先 encodeURI，再把 `%25XX` 还原成 `%XX`。 */
    const reqPath = encodeURI(pathname).replace(/%25([0-9a-fA-F]{2})/g, '%$1');
    const hs = Object.assign({}, headers);
    let payload = null;
    if (body !== null && body !== undefined) { payload = Buffer.from(String(body), 'utf8'); hs['Content-Length'] = payload.length; }
    const q = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers: hs }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    q.setTimeout(timeoutMs, () => { q.destroy(new Error('timeout ' + pathname)); });
    q.on('error', reject);
    if (payload) q.write(payload);
    q.end();
  });
}

const sha16 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const statOf = p => { const st = fs.statSync(p); return { size: st.size, mtimeMs: st.mtimeMs }; };
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const fileUrl = p => require('url').pathToFileURL(p).href;

/** 去掉 // 与 /* *\/ 注释（保留字符串字面量内容），供"源码里不得再出现某种写法"的静态断言用。
    为什么必须去注释：修复说明按惯例把**旧写法**抄进注释里（便于对照），
    不去注释的话静态断言会被自己的注释判红——第一版就踩了。 */
function stripComments(src) {
  let out = '', i = 0, n = src.length, q = null;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += (src[i + 1] || ''); i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/** 原子写（临时文件 + rename）：测试自己改产物文件时也不留半截 */
function writeAtomic(file, text) {
  const tmp = file + '.tmp-neg-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function counter() {
  let fails = 0, asserts = 0, skipped = 0;
  const A = (name, cond, detail) => {
    asserts++;
    if (cond) console.log('  ✔ ' + name + (detail !== undefined ? '  [' + String(detail).slice(0, 220) + ']' : ''));
    else { fails++; console.log('  ✖ ' + name + (detail !== undefined ? '  [' + String(detail).slice(0, 220) + ']' : '')); }
  };
  const S = (name, why) => { skipped++; console.log('  ○ ' + name + '  → ' + why); };
  const end = label => {
    console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + '  ' + label + ' 断言=' + asserts + (skipped ? ' 跳过=' + skipped : ''));
    return fails ? 1 : 0;
  };
  return { A, S, end };
}

module.exports = { ROOT, SERVER, startServer, waitHealth, req, sleep, sha16, statOf, readJson, writeAtomic, counter, stripComments, fileUrl };
