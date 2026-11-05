#!/usr/bin/env node
/**
 * PR 复验器：把 GitHub 上任何一个 PR 拉到本地隔离目录，跑拾光小册的零依赖门禁。
 *
 * 为什么要有它（真实动机，不是仪式）：
 *   托管 CI 只跑 fixture 档，且**只覆盖干净克隆 + 合成库**这一种环境。
 *   本机跑门禁时却会因为 `GLIMMERNOTE_PROD` 指向真库而拿到**另一种环境**，
 *   于是出现"同一提交 CI 绿、本机红"的错位——这本身是一个真实缺陷（见 CHANGELOG）。
 *   本脚本把"拉 PR → 隔离 → 钉死环境 → 跑门禁 → 出结论"固化成一条命令，
 *   并强制**基线对照**：同一个 PR 的基线（base）也用同样方式跑一遍。
 *
 * 铁律（不可协商）：
 *   ① 永远在 git worktree 里复验，**绝不**在开发区 checkout PR（会污染唯一源码树）。
 *   ② 永远钉住 `CTB_TEST_LIB=fixtures\库-形状`，否则门禁结果依赖本机真库规模。
 *   ③ 永远跑基线对照：PR 红了要分清"PR 引入的"还是"基线本来就红的"。
 *   ④ 只读远端，不推、不合并、不打 tag、不删分支。
 *
 * 用法：
 *   node tools\verify-pr.mjs --pr 11
 *   node tools\verify-pr.mjs --pr 11 --base origin/main
 *   node tools\verify-pr.mjs --list
 *
 * 退出码：0=PR 侧全绿（或仅基线红、PR 侧不新增红）；1=PR 侧有红且基线侧为绿（真回归）；2=用法/环境错。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const GIT = 'git';
const NODE = process.execPath;
const TIMEOUT_MS = 30 * 60 * 1000;

/* ── 参数 ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);

if (has('--help') || has('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

/* ── 工具函数 ─────────────────────────────────────────────────────────── */
function git(args, opts = {}) {
  const r = spawnSync(GIT, args, {
    cwd: opts.cwd || REPO,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
    }),
    maxBuffer: 64e6,
    timeout: opts.timeout || 15 * 60 * 1000,
  });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} 失败（exit=${r.status}）\n${r.stderr || ''}`);
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** 跑一道门禁，返回 {code, tail}。门禁红不是异常——红本身就是结论。 */
function runGate(cwd, args, env) {
  const r = spawnSync(NODE, args, {
    cwd,
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
    maxBuffer: 128e6,
    timeout: TIMEOUT_MS,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const lines = out.split(/\r?\n/).filter(Boolean);
  return { code: r.status == null ? -1 : r.status, out, tail: lines.slice(-12).join('\n') };
}

/* ── 步骤 1：找到 PR 的 head 与 base ───────────────────────────────────── */
function remoteInfo(pr) {
  // 公开仓可直接用 API；私有仓走 git 兜底
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${pr}`;
  const r = spawnSync('curl', ['-sSL', '-H', 'Accept: application/vnd.github+json', url], {
    encoding: 'utf8', maxBuffer: 16e6, timeout: 60 * 1000,
  });
  if (r.status === 0 && r.stdout && r.stdout.trim().startsWith('{')) {
    try {
      const j = JSON.parse(r.stdout);
      if (j && j.head && j.base) return j;
    } catch { /* 落到 git 兜底 */ }
  }
  return null;
}

function gitRemoteInfo(pr) {
  const head = git(['ls-remote', 'origin', `refs/pull/${pr}/head`], { allowFail: true });
  const m = head.out.split(/\s+/);
  const sha = m[0] || '';
  return sha ? { head: { sha, ref: `refs/pull/${pr}/head` }, base: null, api: false } : null;
}

const remoteUrl = git(['remote', 'get-url', 'origin']).out;
const mRepo = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(\.git)?$/);
const REPO_OWNER = mRepo ? mRepo[1] : 'KISSHKDF';
const REPO_NAME = mRepo ? mRepo[2] : 'GlimmerNote';

/* ── 步骤 2：建隔离 worktree ──────────────────────────────────────────── */
const WORK_ROOT = process.env.GN_PR_VERIFY_ROOT || path.join(REPO, '..', '_pr_verify');

function makeWorktree(ref, name) {
  const dir = path.join(WORK_ROOT, name);
  git(['worktree', 'remove', '--force', dir], { allowFail: true });
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  git(['worktree', 'add', '--detach', dir, ref]);
  return dir;
}

/* ── 步骤 3：跑门禁 ───────────────────────────────────────────────────── */
/**
 * ⚠️ 必须钉住 CTB_TEST_LIB 到 fixtures 合成库。
 *   否则测试会去挑"本机真库"（GLIMMERNOTE_PROD 指向运行区时命中），
 *   门禁结果随本机数据规模漂移——同一提交可能本机红、CI 绿，无从判读。
 */
function gateEnv(dir) {
  return {
    // ⚠ 只跑 fixture 档（不涉及真库零写入断言），钉合成库即可。
    //   若日后要跑 quick/full：注意 fixtures 会被**物化到临时目录**且
    //   `CTB_TEST_LIB` 被改写成该临时路径（见 tests\_测试环境.cjs resolveLib），
    //   此刻把 CTB_TEST_LIB 钉在源目录会让快照与实际库不同源 ⇒ 误报"文件消失"。
    CTB_TEST_LIB: path.join(dir, 'fixtures', '库-形状'),
    GLIMMERNOTE_PROD: '',
  };
}

const GATES = [
  { name: 'lint', args: ['tools/lint.mjs'], parse: (o) => /LINT=PASS/.test(o) },
  { name: 'fixture', args: ['tests/run.mjs', 'fixture'], parse: (o) => /零依赖自检全绿/.test(o) },
  { name: 'portability', args: ['tests/portability.cjs', '--allow-no-exe'], parse: (o) => /全通过/.test(o) },
];

function runAllGates(dir) {
  const env = gateEnv(dir);
  const results = [];
  for (const g of GATES) {
    const r = runGate(dir, g.args, env);
    results.push({ name: g.name, code: r.code, ok: r.code === 0 && g.parse(r.out), tail: r.tail });
  }
  // .ps1 解析（与 CI 第四步同口径）
  const ps1 = runPs1Parse(dir);
  results.push(ps1);
  return results;
}

function runPs1Parse(dir) {
  // 用 node 做 PowerShell 解析（避免依赖 shell=pwsh 的差异），逐个 *.ps1
  const r = spawnSync(NODE, ['-e', `
    const {execFileSync}=require('child_process');const fs=require('fs');const path=require('path');
    const root=process.argv[1];const bad=[];
    const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
      if(e.isDirectory()){if(e.name!=='.git'&&e.name!=='node_modules')walk(p);}
      else if(/\\.ps1$/i.test(e.name)){try{
        execFileSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-Command',
          "$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('"+p.replace(/'/g,"''")+"',[ref]$null,[ref]$e);if($e.Count -gt 0){exit 3}"],{stdio:'ignore'});
      }catch(err){bad.push(path.basename(p));}}}};
    walk(root);console.log(bad.length?('BAD:'+bad.join(',')):'ALL_OK');
  `, dir], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 16e6 });
  const ok = /ALL_OK/.test(String(r.stdout || ''));
  return { name: 'ps1-parse', code: ok ? 0 : 1, ok, tail: ok ? '全部 .ps1 解析通过' : String(r.stdout || '').trim() };
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */
function listPRs() {
  const r = spawnSync('curl', ['-sSL', '-H', 'Accept: application/vnd.github+json',
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=all&per_page=20&sort=updated&direction=desc`],
    { encoding: 'utf8', maxBuffer: 32e6, timeout: 60 * 1000 });
  try {
    const j = JSON.parse(String(r.stdout || '[]'));
    if (!Array.isArray(j)) return [];
    return j.map((p) => ({ number: p.number, state: p.state, title: p.title, user: p.user && p.user.login, head: p.head && p.head.sha, updated: p.updated_at }));
  } catch { return []; }
}

function main() {
  if (has('--list')) {
    const prs = listPRs();
    if (!prs.length) { console.log('（拿不到 PR 列表：可能仓库私有或网络受限）'); return 0; }
    console.log('PR 列表（最新在前）：');
    for (const p of prs) {
      console.log(`  #${p.number} [${p.state}] ${p.title}`);
      console.log(`      作者=${p.user}  head=${p.head}  更新=${p.updated}`);
    }
    return 0;
  }

  const pr = arg('--pr');
  if (!pr) {
    console.error('用法：node tools\\verify-pr.mjs --pr <编号> [--base <ref>] | --list');
    return 2;
  }

  console.log(`═══ 复验 PR #${pr} ═══`);
  const api = remoteInfo(pr);
  const gitInfo = gitRemoteInfo(pr);
  const headSha = (api && api.head && api.head.sha) || (gitInfo && gitInfo.head && gitInfo.head.sha);
  if (!headSha) {
    console.error(`拿不到 PR #${pr} 的 head（refs/pull/${pr}/head 不存在或无权限）`);
    return 2;
  }
  const baseRef = arg('--base') || (api && api.base && api.base.ref ? `origin/${api.base.ref}` : 'origin/main');
  console.log(`head = ${headSha}`);
  console.log(`base = ${baseRef}`);

  // 拉 PR ref 到本地（只读远端）
  git(['fetch', '--no-tags', 'origin', `refs/pull/${pr}/head:refs/verify/pr${pr}`]);

  // ── 基线对照：base 也用同样方式跑一遍 ──
  const baseSha = git(['rev-parse', baseRef], { allowFail: true }).out;
  console.log(`\n[1/3] 建隔离 worktree（基线对照：${baseRef}）`);
  const baseDir = makeWorktree(baseSha || 'origin/main', `pr${pr}-base`);
  console.log(`      → ${baseDir}`);

  console.log(`\n[2/3] 跑门禁（基线侧）`);
  const baseRes = runAllGates(baseDir);
  for (const r of baseRes) console.log(`      ${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : '  ← 红'}`);

  console.log(`\n[3/3] 跑门禁（PR 侧）`);
  const prDir = makeWorktree(`refs/verify/pr${pr}`, `pr${pr}`);
  console.log(`      → ${prDir}`);
  const prRes = runAllGates(prDir);
  for (const r of prRes) console.log(`      ${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : '  ← 红'}`);

  // ── 判读 ──
  const baseRed = baseRes.filter((r) => !r.ok).map((r) => r.name);
  const prRed = prRes.filter((r) => !r.ok).map((r) => r.name);
  const introduced = prRed.filter((n) => !baseRed.includes(n));

  console.log('\n═══ 结论 ═══');
  console.log(`基线侧红：${baseRed.length ? baseRed.join('、') : '（无）'}`);
  console.log(`PR 侧红  ：${prRed.length ? prRed.join('、') : '（无）'}`);
  if (!prRed.length) {
    console.log('\n✔ PR 侧全绿。可合并（仍需走 PR + CI + merge commit 流程）。');
    return 0;
  }
  if (introduced.length) {
    console.log(`\n✘ PR 引入的红：${introduced.join('、')} ⇒ 这是本次 PR 的真回归，不能合。`);
    for (const n of introduced) {
      const r = prRes.find((x) => x.name === n);
      console.log(`\n── ${n} 末尾输出 ──\n${r.tail}`);
    }
    return 1;
  }
  console.log(`\n⚠ PR 侧红但基线同样红（${prRed.join('、')}）⇒ 非本次 PR 引入，是既有问题。`);
  console.log('   基线侧明细：');
  for (const n of prRed) {
    const r = prRes.find((x) => x.name === n);
    console.log(`\n── ${n} 末尾输出 ──\n${r.tail}`);
  }
  return 0;
}

process.exit(main());
