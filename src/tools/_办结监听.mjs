#!/usr/bin/env node
/**
 * 错题本 · 办结自动落库监听器（v2.1，2026-10-07）
 *
 * 用户裁定（2026-10-07）：「页面上点『确认办结』，就是办结，后续操作由 agent/系统完成，
 *  而不应该再由我参与」——废除 v2.0b 的「导出办结包 → 发给 agent → 手动同步」三步。
 *
 * 机制：本机常驻小 HTTP 服务（只绑 127.0.0.1），首页点「✓ 确认办结 / 作废」即 POST 过来，
 *       本监听器调 _待确认.mjs 同步 落库（幂等、已办结自动跳过），再自动重跑 _生成首页.ps1
 *       重建首页（待办计数、工作台、面板全部刷新）。用户无任何后续动作。
 *
 * 接口：
 *   GET  /health → {ok, port, lastSync, lastBuild, rebuilding}
 *   POST /resolve  body: {exportedAt?, tool?, resolves:[{id, action:'答'|'作废', answer}]}
 *                → 逐条落库（跳过已办结），触发重建，返回 {ok, results:[{id,status,answer,skipped}], build}
 *   POST /rebuild  → 手动触发重建（调试用）
 *
 * 安全：只绑 127.0.0.1；仅接受同源 file:// 页面的 POST（校验 Origin 头不存在或为 null——
 *       file:// 页面发 fetch 的 Origin 恒为 null，浏览器不可能伪造 file:// 源）；
 *       无写盘逻辑（全部交给既有工具），单并发队列防重入。
 *
 * 自启：计划任务 CTB-PendingSync（SYSTEM 启动时拉起，见注册段）。
 */
'use strict';
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { libraryRoot, toolPath } from './_库根.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 现在是**用户库根**，不再是"本脚本所在目录"。
   兄弟工具一律用 toolPath(...)，见 _库根.mjs。 */
const ROOT = libraryRoot();
const PORT = 7187;
const TOOL = toolPath('_待确认.mjs');
const GEN = toolPath('_生成首页.ps1');

const state = { lastSync: null, lastBuild: null, rebuilding: false, buildQueued: false, lastError: '' };

function runNode(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let out = '', err = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch (e) {} resolve({ code: 124, out, err: err + '\n[timeout]' }); } }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out, err: String(e) }); } });
    p.on('close', code => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}
/* 跑 PowerShell 生成器（_生成首页.ps1）：必须用 powershell.exe，不是 node */
function runGen(timeoutMs = 180000) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GEN], { cwd: ROOT, windowsHide: true });
    let out = '', err = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch (e) {} resolve({ code: 124, out, err: err + '\n[timeout]' }); } }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out, err: String(e) }); } });
    p.on('close', code => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}

/* 重建首页：串行化（同一时刻只跑一个生成器，排队合并请求） */
function rebuild(reason) {
  state.buildQueued = true;
  if (state.rebuilding) return;
  state.rebuilding = true;
  (async () => {
    while (state.buildQueued) {
      state.buildQueued = false;
      const r = await runGen();
      state.lastBuild = { at: new Date().toISOString(), ok: r.code === 0, reason };
      if (r.code !== 0) { state.lastError = '生成器退出码 ' + r.code + '：' + (r.err || r.out).slice(-400); }
      console.log('[rebuild] reason=' + reason + ' code=' + r.code);
    }
    state.rebuilding = false;
  })();
}

/* 落库：_待确认.mjs 同步 只接受 --file；用临时文件传递（os.tmpdir()，不污染题库目录） */
async function syncResolvesViaFile(list) {
  const tmp = path.join(os.tmpdir(), 'ctb-pending-' + Date.now() + '.json');
  fs.writeFileSync(tmp, JSON.stringify({ exportedAt: new Date().toISOString(), tool: 'ctb-homepage-pending', resolves: list }), 'utf8');
  try {
    const r = await runNode([TOOL, '同步', '--file', tmp], 120000);
    return r;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  // file:// 页面 fetch 的 Origin 为 null；本服务只服务这一种客户端。其余来源一律拒绝。
  if (origin && origin !== 'null') { res.writeHead(403); res.end('{"ok":false,"error":"forbidden origin"}'); return; }
  // CORS 预检：页面用 application/json POST，浏览器会先发 OPTIONS——必须放行，否则预检失败页面发不出请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, port: PORT, lastSync: state.lastSync, lastBuild: state.lastBuild, rebuilding: state.rebuilding, lastError: state.lastError }));
    return;
  }
  if (req.method === 'POST' && (req.url === '/resolve' || req.url === '/rebuild')) {
    let body = '';
    let tooBig = false;
    req.on('data', d => { body += d; if (body.length > 1e6) { tooBig = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooBig) { res.writeHead(413); res.end('{"ok":false,"error":"payload too large"}'); return; }
      if (req.url === '/rebuild') {
        rebuild('manual');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, rebuilding: true }));
        return;
      }
      let pkg;
      try { pkg = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('{"ok":false,"error":"bad json"}'); return; }
      const list = Array.isArray(pkg && pkg.resolves) ? pkg.resolves.filter(r => r && r.id && (r.action === '答' || r.action === '作废')) : [];
      if (!list.length) { res.writeHead(400); res.end('{"ok":false,"error":"resolves empty or malformed"}'); return; }
      const r = await syncResolvesViaFile(list);
      state.lastSync = { at: new Date().toISOString(), count: list.length, code: r.code };
      const ok = r.code === 0;
      if (!ok) state.lastError = '同步退出码 ' + r.code + '：' + (r.err || r.out).slice(-400);
      // 同步成功 → 重建首页（排队合并）；失败也要把工具输出带回给页面展示
      if (ok) rebuild('resolve');
      const results = [];
      try {
        // _待确认.mjs 同步 的 stdout 逐行是「  ✔ Txxx → …」/「  ↔ Txxx：…」/「  ✖ Txxx：…」，解析出来回显
        for (const line of String(r.out || '').split(/\r?\n/)) {
          const m = line.match(/[✔↔✖]\s*(T\d+)/);
          if (m) results.push({ id: m[1], status: line.includes('↔') ? 'skipped' : (line.includes('✖') ? 'missing' : 'ok'), line: line.trim() });
        }
      } catch (e) {}
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok, results, build: ok ? 'queued' : 'not-triggered', toolOut: String(r.out || '').slice(-1200), toolErr: String(r.err || '').slice(-400) }));
    });
    return;
  }
  res.writeHead(404); res.end('{"ok":false,"error":"not found"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[ctb-pending-sync] listening on http://127.0.0.1:' + PORT + '  root=' + ROOT);
  // 启动即自检一次首页是否与台账一致（只在缺首页时重建，平时不折腾）
  if (!fs.existsSync(path.join(ROOT, '首页.html'))) rebuild('boot-missing');
});
