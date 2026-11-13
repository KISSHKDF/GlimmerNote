#!/usr/bin/env node
/**
 * neg-shell-subprocess-timeout.cjs —— 桌面壳的「子进程超时」判据必须**真的可达**（2026-11-12 立，审计 F02）
 *
 * 事故形态（改前，两处各一份）：
 *     stdout = p.StandardOutput.ReadToEnd();      // 子进程不关流 ⇒ 这里永久阻塞
 *     stderr = p.StandardError.ReadToEnd();       // 两流**同步**读：谁先写满管道就互相等（既知死锁）
 *     if (!p.WaitForExit(timeoutMs)) { Kill(); }  // ← 走到这里子进程通常已退出 ⇒ 超时判据**不可达**
 * 后果：工具一卡死，界面永远转圈；`Mark` 里 WriteGate 在 finally 释放不掉 ⇒ 此后所有写入排队等死。
 * 壳源码里那两段注释自己都写着"WaitForExit(ms) 的返回值永远用不上"，但一直没修。
 *
 * 本用例**不从源码文本推断**，而是把真源码里的 `RunNodeCapture` / `BoundedResult` 抽出来，
 * 用 csc 编一个最小宿主，跑一个**永不退出、也不写输出**的 node 子进程，看超时判据能不能回来：
 *   ① 真源码版：必须在超时后返回 code=124（且总耗时远小于外层保护超时）；
 *   ② **阴性自证**：把异步读换回同步 `ReadToEnd()`（正是改前的形态）⇒ 必须**挂住**被外层超时打断，
 *      以此证明"这条断言确实有牙齿"，而不是在断言一个恒真的东西。
 * 退出码 0=PASS / 1=FAIL。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const CS = fs.readFileSync(path.join(E.REPO, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
const CSC = ['C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'].find(p => fs.existsSync(p));

console.log('测试环境：' + E.describe());
if (!CSC) { console.log('SKIP：本机找不到 .NET Framework csc.exe，无法编译最小宿主'); console.log('[neg-shell-subprocess-timeout] 断言=0 失败=0（SKIP）'); process.exit(0); }

/** 按缩进法从真源码抽出某个成员（返回原文，含签名） */
function member(src, sig, indent) {
  const lines = src.split('\n');
  const i = lines.findIndex(l => l.includes(sig));
  if (i < 0) return null;
  const close = new RegExp('^' + indent + '\\}');
  let j = i + 1;
  while (j < lines.length && !close.test(lines[j])) j++;
  return lines.slice(i, j + 1).join('\n');
}

const IND = ' '.repeat(8);
const rawCapture = member(CS, 'string RunNodeCapture(', IND);
const rawBounded = member(CS, 'static string BoundedResult(', IND);
A('从真源码抽到 RunNodeCapture', !!rawCapture, rawCapture ? rawCapture.split('\n')[0].trim() : '抽不到（签名变了？）');
A('从真源码抽到 BoundedResult', !!rawBounded, rawBounded ? rawBounded.split('\n')[0].trim() : '抽不到');
A('★ RunNodeCapture 用的是**异步读**（ReadToEndAsync），不是同步 ReadToEnd',
  !!rawCapture && /ReadToEndAsync\(\)/.test(rawCapture) && !/\.ReadToEnd\(\)/.test(rawCapture), '');
A('★ 超时分支在**读流之前**就等 WaitForExit（顺序正确：先判超时再收流）',
  !!rawCapture && rawCapture.indexOf('WaitForExit(timeoutMs)') > 0 &&
  rawCapture.indexOf('WaitForExit(timeoutMs)') < rawCapture.indexOf('BoundedResult(soTask)'), '');

const HOST_HEAD = `using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
class Host {
  static string QuoteArgs(string[] a) { var sb = new StringBuilder(); foreach (var x in a) { if (sb.Length > 0) sb.Append(' '); sb.Append('"').Append(x).Append('"'); } return sb.ToString(); }
`;
const HOST_MAIN = `
  static int Main(string[] argv) {
    var sw = Stopwatch.StartNew();
    int code; string err;
    var so = new Host().RunNodeCapture(new[] { "-e", "setInterval(function(){}, 1000)" }, 1500, null, out code, out err);
    sw.Stop();
    Console.WriteLine("code=" + code + " ms=" + sw.ElapsedMilliseconds + " err=" + (err ?? "").Replace("\\n", "|") + " out=" + (so ?? "").Length);
    return code == 124 ? 0 : 1;
  }
}`;
const asInstance = s => s.replace(/^\s*static\s+string\s+BoundedResult/m, '  static string BoundedResult');
const asMember = s => s.replace(/^ {8}string RunNodeCapture/m, '  string RunNodeCapture').replace(/^ {8}static string BoundedResult/m, '  static string BoundedResult');

const tmp = E.allocTempDir('gn-shell-timeout-');
function buildAndRun(tag, body) {
  const cs = path.join(tmp, tag + '.cs');
  const exe = path.join(tmp, tag + '.exe');
  fs.writeFileSync(cs, HOST_HEAD + body + HOST_MAIN, 'utf8');
  try {
    execFileSync(CSC, ['/nologo', '/target:exe', '/out:' + exe, cs], { stdio: 'pipe', timeout: 120000 });
  } catch (e) {
    return { compileFailed: true, detail: String(e.stdout || e.message).slice(-400) };
  }
  try {
    const out = execFileSync(exe, [], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), killed: e.killed === true || e.signal != null };
  }
}

console.log('\n══ ① 真源码版：超时判据必须可达 ══');
{
  const r = buildAndRun('real', asMember(rawCapture) + '\n' + asMember(rawBounded));
  if (r.compileFailed) A('编译最小宿主（真源码版）', false, r.detail);
  else {
    A('编译最小宿主（真源码版）', true, '');
    const ms = (r.out.match(/ms=(\d+)/) || [])[1];
    A('★★ 永不退出的 node 子进程在超时后被结束（code=124）', r.code === 0, r.out.trim() || ('exit=' + r.code));
    A('★ 且**没有**被永久阻塞（总耗时 < 10s）', Number(ms) > 0 && Number(ms) < 10000, 'ms=' + ms);
  }
}

console.log('\n══ ② 阴性自证：改回同步 ReadToEnd（=改前形态）必须挂住 ══');
{
  const mutated = asMember(rawCapture).replace(/p\.StandardOutput\.ReadToEndAsync\(\)/g, 'Task.FromResult(p.StandardOutput.ReadToEnd())')
    .replace(/p\.StandardError\.ReadToEndAsync\(\)/g, 'Task.FromResult(p.StandardError.ReadToEnd())');
  A('变异点命中（异步读确实被换成同步读）', mutated !== asMember(rawCapture), '');
  const r = buildAndRun('mut', mutated + '\n' + asMember(rawBounded));
  if (r.compileFailed) A('编译最小宿主（变异体）', false, r.detail);
  else A('★★ 同步读版**被外层超时打断**（即超时判据在改前确实不可达 —— 这条断言有牙齿）',
    r.killed === true || r.code !== 0, 'exit=' + r.code + ' killed=' + r.killed);
}

console.log(`\n[neg-shell-subprocess-timeout] 断言=${passed} 失败=${worst}`);
process.exit(worst ? 1 : 0);
