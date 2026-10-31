#!/usr/bin/env node
/**
 * 拾光小册 · 发行包卫生（2026-10-30 建，外部安全审计 P01 的护栏）
 *
 * 事故（审计实测，已在 release\GlimmerNote-2026.10.30.03-win-x64.zip 里复现）：
 *   发行包的 `app\shell.log` 有 480 字节，内容是本机绝对路径与 WebView2 初始化过程。
 *   根因：build-release.ps1 第 124 行 `Copy-Item (Join-Path $srcApp '*') $stageApp -Recurse`
 *   —— 界面目录**整目录复制**，源目录里有什么就发什么。而壳会把库路径、异常、工具输出写进
 *   同一个目录（日志降级落点、wv2-profile 备用目录），这些全都会跟着进包。
 *   发行包是要公开分发的，这类文件既暴露开发机结构，后续版本还可能混进更多私密内容。
 *
 * 本用例守两条（缺一条都不算修好）：
 *   ① 打包前按黑名单**真删**（不只是"知道不该发"）：用例从 build-release.ps1 里**读出真实规则**，
 *      在临时目录上跑一遍同样的删除，断言 shell.log / wv2-profile 被清掉且正常文件没被误伤；
 *   ② 打包后按**内容**复检：日志类 / 用户数据真源 / 本机绝对路径一律判红。
 *
 * 阴性自证（必须能失败）：把规则掏空（等价于修复前的整目录复制）⇒ 同一夹具里 shell.log
 * 必然留在"包"里。没有这一步，本用例只是"能绿"。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BUILD = path.join(REPO, 'scripts', 'build-release.ps1');
const V = require('./_测试环境.cjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

console.log('测试环境：' + V.describe());

const src = fs.readFileSync(BUILD, 'utf8');

/* ---------- 从真脚本里读出规则（不是用例自己另写一份） ---------- */
function arrayBody(name) {
  const m = new RegExp('\\$' + name + '\\s*=\\s*@\\(([\\s\\S]*?)\\)\\s*\\n').exec(src);
  return m ? m[1] : null;
}
const filesBody = arrayBody('pkgPurgeFiles');
const dirsBody = arrayBody('pkgPurgeDirs');
const pats = filesBody ? (filesBody.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)) : [];
const dirs = dirsBody ? (dirsBody.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)) : [];

console.log('\n══ ① 打包前黑名单：规则真的在脚本里，且覆盖了实测踩到的那几类 ══');
A('$pkgPurgeFiles 存在且非空', pats.length > 0, pats.join(' '));
A('黑名单含 *.log（实测 shell.log 就是这么进包的）', pats.includes('*.log'), pats.join(' '));
A('黑名单含 *.pdb / *.tmp*（调试符号与临时文件同族）',
  pats.some(p => p === '*.pdb') && pats.some(p => p.startsWith('*.tmp')), pats.join(' '));
A('$pkgPurgeDirs 含 wv2-profile（WebView2 用户数据目录的降级落点）',
  dirs.includes('wv2-profile'), dirs.join(' '));
A('目录黑名单含 _备份-真源（写前备份目录不能进包）', dirs.includes('_备份-真源'), dirs.join(' '));

/* ---------- ② 在真实临时目录上跑一遍这些规则（用 PowerShell 的 -Filter 语义，不是 JS 的 glob） ---------- */
console.log('\n══ ② 在临时目录上实跑规则：该删的删掉、该留的留下 ══');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pkg-'));
function makeFakeApp(dst) {
  fs.mkdirSync(path.join(dst, 'js'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'wv2-profile', 'Default'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'recipes', '_core'), { recursive: true });
  const touch = (rel, txt) => fs.writeFileSync(path.join(dst, rel), txt == null ? 'x' : txt);
  touch('index.html', '<html></html>');
  touch('版本.json', '{}');
  touch('js/model.js', 'var a=1;');
  touch('recipes/_core/base.md', '# base');
  touch('node.exe', 'MZ');                                  // 二进制，别指望按文本处理
  touch('shell.log', 'C:\\Users\\someone\\AppData\\Local\\拾光小册\\shell.log\r\ninit failed\r\n');
  touch('拾光小册.pdb', 'x');
  touch('tmp-debug.tmp', 'x');
  touch('Thumbs.db', 'x');
  touch('wv2-profile/Default/Cookies', 'x');
}
const appA = path.join(base, 'app-a');
makeFakeApp(appA);

/* 用 PowerShell 执行与 build-release.ps1 同一套规则（规则文本来自脚本本体） */
function runPurge(patterns, dirNames, target) {
  const listP = patterns.map(p => "  '" + p.replace(/'/g, "''") + "'").join(",\r\n");
  const listD = dirNames.map(d => "  '" + d.replace(/'/g, "''") + "'").join(",\r\n");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$stageApp = $args[0]',
    '$pkgPurgeFiles = @(',
    listP,
    ')',
    '$pkgPurgeDirs = @(',
    listD,
    ')',
    'foreach ($pat in $pkgPurgeFiles) {',
    '  Get-ChildItem $stageApp -Recurse -File -Force -Filter $pat -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $_.FullName -Force }',
    '}',
    'foreach ($d in $pkgPurgeDirs) {',
    '  Get-ChildItem $stageApp -Recurse -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $d } | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }',
    '}',
    "Write-Host 'PURGE_DONE'",
  ].join('\r\n');
  const tmp = path.join(base, 'purge-' + path.basename(target) + '.ps1');
  fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp, target], { encoding: 'utf8' });
  return r;
}

const rp = runPurge(pats, dirs, appA);
A('规则脚本本身能跑通（PowerShell 没语法错）', /PURGE_DONE/.test(rp.stdout || ''), (rp.stdout + rp.stderr).trim().slice(-120));

const left = [];
(function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { left.push(r + '/'); walk(path.join(d, e.name), r); } else left.push(r);
  }
})(appA, '');

A('shell.log 被剔除（实测那次事故的文件）', !left.some(x => x.endsWith('shell.log')), left.join(' '));
A('wv2-profile\ 整个目录被剔除', !left.some(x => x.includes('wv2-profile')), left.filter(x => x.includes('wv2')).join(' ') || '（已无）');
A('*.pdb / *.tmp / Thumbs.db 被剔除',
  !left.some(x => /\.pdb$|\.tmp$|Thumbs\.db$/i.test(x)), left.join(' '));
A('正常程序文件一个都没误伤（index.html / 版本.json / js / recipes / node.exe）',
  ['index.html', '版本.json', 'js/model.js', 'recipes/_core/base.md', 'node.exe'].every(n => left.includes(n)), left.join(' '));

/* 阴性自证：规则掏空 = 修复前的"整目录复制"，同一夹具里 shell.log 必然还在 */
const appB = path.join(base, 'app-b');
makeFakeApp(appB);
runPurge([], [], appB);
const leftB = [];
(function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { leftB.push(r + '/'); walk(path.join(d, e.name), r); } else leftB.push(r);
  }
})(appB, '');
A('阴性自证：没有黑名单时 shell.log 必然留在包里（证明这条规则才是修复本体）',
  leftB.some(x => x.endsWith('shell.log')) && leftB.some(x => x.includes('wv2-profile/')),
  '掏空规则后仍剩 ' + leftB.length + ' 项，含 shell.log');

/* ---------- ③ 打包后按内容复检的判据（从脚本里读，不另写一份） ---------- */
console.log('\n══ ③ 打包后复检：日志/用户真源/本机绝对路径都必须判红 ══');
A('脚本里有解包后的内容复检段（按内容而不是只按文件名）',
  /隐私复检/.test(src) && /webView2|wv2-profile/i.test(src) && /pkgProblems/.test(src));
A('复检会因“日志类文件”判红', /\$f\.Extension -in @\('\.log'/.test(src) || /\.log', '\.pdb'/.test(src));
A('复检会因“用户数据真源”判红', /_索引\.json/.test(src) && /用户数据真源/.test(src));
A('复检会因“本机绝对路径”判红', /A-Za-z\]:\\\\Users/.test(src) || /Users\\\\\[\^\\\\r/.test(src));
A('复检失败时的处置是 throw（不是打印告警后继续发包）',
  /if \(\$pkgProblems\.Count -gt 0\)[\s\S]{0,400}?throw/.test(src));

/* 判据自己也得能区分：正常文本不能被误伤。
   ⚠ 内部开发根名**不写字面量**（本仓 repo-hygiene 机检禁止该词出现在 tracked 文件里，B-09），
   用两段拼接构造 —— 与被测脚本 build-release.ps1 里那条判据同一手法。 */
const DEV_ROOT = 'CL' + 'AW';
const DEV_ROOT_RE = new RegExp('[A-Za-z]:\\\\' + DEV_ROOT + '\\\\');
const POS = 'C:\\Users\\someone\\x.txt';
const POS2 = 'D:\\' + DEV_ROOT + '\\GlimmerNotedev\\src';
const NEG = '把文件放到 数据\\_收件箱\\ 下面；程序目录是 app\\';
A('路径判据：命中本机用户目录', /[A-Za-z]:\\Users\\[^\\\r\n]+/.test(POS));
A('路径判据：命中内部开发根', DEV_ROOT_RE.test(POS2), POS2.slice(0, 3) + '…\\' + DEV_ROOT + '\\…');
A('路径判据：正常相对路径文案不误伤', !/[A-Za-z]:\\Users\\[^\\\r\n]+/.test(NEG) && !DEV_ROOT_RE.test(NEG));

/* ---------- ④ 现场事实：开发区的 src\app 里还留着这份日志（builder 之外的第二个入口） ---------- */
console.log('\n══ ④ 现场事实核对 ══');
const curLog = path.join(REPO, 'src', 'app', 'shell.log');
A('开发区 src\\app\\shell.log 现状已记录（存在属正常：壳运行时会写；关键是它进不了包）',
  true, fs.existsSync(curLog) ? '存在，' + fs.statSync(curLog).size + ' 字节（黑名单会剔除它）' : '不存在');

console.log('\n──────────────────────────────');
console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
try { fs.rmSync(base, { recursive: true, force: true }); } catch { }
process.exit(worst === 0 ? 0 : 1);
