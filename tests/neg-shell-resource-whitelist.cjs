#!/usr/bin/env node
/* 阴性用例（审计 A1 桌面侧 → 整改清单 R5「WebView2 资源请求白名单」）
   守的是 `NavGuard.IsAllowedResource`：**导航白名单只管顶级导航，管不到子资源**——
   文档一旦进了 WebView2，里面的 <img src=http://…> / <link rel=stylesheet> / <script src=…> /
   fetch 全是子资源请求，不设白名单就等于"库内容可以把本机使用情况打到外部服务器"。

   放行面（本用例是判据的权威副本）：file:（程序目录内 = 界面自身；库目录内 = 题库资产）、
   http://127.0.0.1:PORT 与 http://localhost:PORT、data:、blob:、devtools:（F12 的 UX，无出网能力）、
   about:blank；
   其余（外部 http(s)、https、ws、javascript:、ms-appx:、file://host/…）一律拒。

   A. 源码级：判据存在 / 复用了既有包含性与同源判据（IsUnderDir、IsSrvOrigin）/ 挂载点顺序正确
      （必须在 Navigate(home) 之前挂上，否则首屏资源已经出去了）/ 拒绝时造 403 并记 REJECT resource。
   B. 运行级：把 IsAllowedResource **原文**（连同它依赖的 LocalPathOf/IsSrvOrigin/Trim/IsUnderDir）
      抽出来编成最小 C# 程序逐样本真跑，断言放行/拒绝面。
   C. 阴性自证：①「完全没有白名单」（改前状态）必须放行外部域名 ⇒ B 段的拒绝断言有牙齿；
      ②「半吊子修复」（只做 `startsWith('http://127.0.0.1:'+port)` 前缀比较）必须放行
      `http://127.0.0.1:PORT@attacker.example/` 这种 userinfo 伪装 ⇒ 这条历史缺陷（S03）也被本用例抓得住。

   用法：node tests\neg-shell-resource-whitelist.cjs
   退出码：0=PASS / 1=FAIL（csc 缺席时 B 段可见 SKIP，A/C 仍判）
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CS = fs.readFileSync(path.join(ROOT, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');

let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]   ' + label + (extra ? '  → ' + String(extra).slice(0, 240) : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + String(extra).slice(0, 240) : '')); }
};

/* ── 抽取（与 neg-shell-openfile-policy 同法：抽**原文**，不重写判据） ────────── */
function skipCSharpNonCode(src, i) {
  const c = src[i];
  if (c === '"' || c === "'") {
    const verbatim = src[i - 1] === '@';
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\' && !verbatim) { j++; continue; }
      if (src[j] === c) { if (verbatim && src[j + 1] === c) { j++; continue; } return j; }
    }
    return src.length;
  }
  if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); return e < 0 ? src.length : e; }
  if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? src.length : e + 1; }
  return i;
}
function extractBlock(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*'))) { i = skipCSharpNonCode(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}
const EX = {};
const MISSING = [];
function take(name, marker) {
  EX[name] = extractBlock(CS, marker);
  if (!EX[name]) MISSING.push(name + ' ← ' + marker);
}
take('isAllowedResource', 'public static bool IsAllowedResource(string uri, string srvPort, out string why)');
take('isAllowedFile', 'static bool IsAllowedFileResource(Uri u, out string why)');
take('localPathOf', 'public static string LocalPathOf(Uri u)');
take('isSrvOrigin', 'public static bool IsSrvOrigin(Uri u, string srvPort)');
take('trimFn', 'static string Trim(string s)');
take('isUnderDir', 'public static bool IsUnderDir(string p, string root)');

console.log('═══ 0. 抽取 ═══');
A('从 CTBShellV2.cs 抽到 IsAllowedResource 及其依赖（抽不到就没资格谈判据）',
  MISSING.length === 0, MISSING.length ? MISSING.join(' | ') : Object.keys(EX).length + ' 段');

/* ══════════════════════════════════════════════════════════════════════════
   A. 源码级
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n═══ A. 源码级（判据在场 / 复用既有实现 / 挂载点顺序 / 拒绝形态） ═══');
const AR = EX.isAllowedResource || '';
A('A1 判据签名就是 IsAllowedResource(string uri, string srvPort, out string why)',
  /public static bool IsAllowedResource\(string uri, string srvPort, out string why\)/.test(CS), '');
A('A2 放行面：file: + 本机 http + data: + blob: + devtools: + about:blank（六个分支都在）',
  ['UriSchemeFile', 'UriSchemeHttp', '"data"', '"blob"', '"devtools"', '"about"'].every(k => AR.indexOf(k) >= 0), '');
A('A2b devtools: 是显式放行（不是靠"漏判"落过去）：有 `if (scheme == "devtools") return true;`',
  /if \(scheme == "devtools"\) return true;/.test(AR), '')
A('A3 拒绝面：https 有显式分支（不是"漏掉后落到默认"）',
  /UriSchemeHttps/.test(AR) && /https 一律不放行/.test(AR), '');
A('A4 http 同源判定复用 IsSrvOrigin（不是字符串前缀比较）',
  /IsSrvOrigin\(u, srvPort\)/.test(AR) && !/StartsWith\("http:\/\/127\.0\.0\.1:/.test(AR), '');
A('A5 file: 包含性复用 HostBridge.IsUnderDir（与 TryResolveInsideRoot 同一份实现，不是另写一份前缀比较）',
  /HostBridge\.IsUnderDir\(full, HostBridge\.AppRoot\)/.test(EX.isAllowedFile || '')
  && /HostBridge\.IsUnderDir\(full, HostBridge\.DataRoot\)/.test(EX.isAllowedFile || ''), '');
A('A6 IsUnderDir 已公开（资源白名单要复用它，不能各写一份）',
  /public static bool IsUnderDir\(string p, string root\)/.test(CS), '');
A('A7 file://host/…（UNC/共享）被显式拒绝', /UNC\/共享/.test(EX.isAllowedFile || '') && /u\.Host/.test(EX.isAllowedFile || ''), '');

const regAt = CS.indexOf('AddWebResourceRequestedFilter');
const navAt = CS.indexOf('wv.CoreWebView2.Navigate(home)');
const readyAt = CS.indexOf('EnsureCoreWebView2Async(env)');
A('A8 过滤器用 "*" + CoreWebView2WebResourceContext.All（不是只拦某几类）',
  /AddWebResourceRequestedFilter\("\*", CoreWebView2WebResourceContext\.All\)/.test(CS), '');
A('A9 WebResourceRequested 处理器在（挂上了）', /CoreWebView2\.WebResourceRequested \+=/.test(CS), '');
A('A10 挂载点在 CoreWebView2 ready 之后', readyAt >= 0 && regAt > readyAt, 'ready=' + readyAt + ' 注册=' + regAt);
A('A11 挂载点在 Navigate(home) **之前**（挂晚了首屏 js/css/图片已经出去了）', regAt > 0 && navAt > regAt,
  '注册=' + regAt + ' 导航=' + navAt);
A('A12 非白名单响应是 403（CreateWebResourceResponse(null, 403, …)）',
  /CreateWebResourceResponse\(null, 403,/.test(CS), '');
A('A13 拒绝留下可查的日志（REJECT resource: … ← 原因）',
  /Log\("REJECT resource: " \+ \(ru \?\? "\(null\)"\) \+ " ← " \+ rwhy\)/.test(CS), '');
A('A14 处理器里读的是真实请求 URI（e.Request.Uri），不是别的东西', /ru = e\.Request\.Uri;/.test(CS), '');
A('A15 处理器把端口真源值传进判据（srvPortValue，与导航白名单同源）',
  /IsAllowedResource\(ru, srvPortValue, out rwhy\)/.test(CS), '');
A('A16 处理器不阻塞 UI 线程（没有 Wait/Thread.Sleep/await 之类）',
  !/Wait\(|Thread\.Sleep|await /.test(CS.slice(regAt, regAt + 1600)), '');

/* ══════════════════════════════════════════════════════════════════════════
   B. 运行级：抽原文 → 编译 → 逐样本真跑
   ══════════════════════════════════════════════════════════════════════════ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-neg-reswl-'));
const appDir = path.join(tmp, 'app');
const libDir = path.join(tmp, 'lib');
const outDir = path.join(tmp, 'outside');
for (const d of [appDir, libDir, outDir]) fs.mkdirSync(d, { recursive: true });
const PORT = '7311';

/* 样本表（名字 / URI / 期望放行）。file: 用 pathToFileURL 构造，避免手拼编码。 */
const f = p => pathToFileURL(p).href;
const SAMPLES = [
  ['file_entry', f(path.join(appDir, 'index.html')), true],
  ['file_app_js', f(path.join(appDir, 'js', 'host.js')), true],
  ['file_app_css', f(path.join(appDir, 'css', 'app.css')), true],
  ['file_lib_img', f(path.join(libDir, '九年级', '物理', 'P0017-浮力', '题图.jpg')), true],
  ['file_lib_html', f(path.join(libDir, '题干.html')), true],
  ['file_lib_md', f(path.join(libDir, '错题记录.md')), true],
  ['file_outside', f(path.join(outDir, 'secret.png')), false],
  ['file_system', f(path.join(outDir, '..', 'outside', 'x.js')), false],
  ['file_sibling', f(appDir + '-X' + path.sep + 'a.js'), false],
  ['file_unc', 'file://server/share/x.js', false],
  ['http_127_right', 'http://127.0.0.1:' + PORT + '/api/state', true],
  ['http_localhost_right', 'http://localhost:' + PORT + '/x.css', true],
  ['http_wrong_port', 'http://127.0.0.1:7312/x.png', false],
  ['http_userinfo', 'http://127.0.0.1:' + PORT + '@attacker.example/x.png', false],
  ['http_external', 'http://attacker.example/x.png', false],
  ['http_lookalike_host', 'http://127.0.0.1.nip.io:' + PORT + '/x.png', false],
  ['https_right_port', 'https://127.0.0.1:' + PORT + '/x.png', false],
  ['https_external', 'https://attacker.example/x.js', false],
  ['ws_local', 'ws://127.0.0.1:' + PORT + '/x', false],
  ['data_uri', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', true],
  ['blob_uri', 'blob:file:///2f1a9c10-0b7e-4b7a-9a1e-111111111111', true],
  ['devtools_bundled', 'devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9222/devtools/page/1', true],
  ['devtools_remote', 'devtools://devtools/bundled/core/sdk.js', true],
  ['about_blank', 'about:blank', true],
  ['about_srcdoc', 'about:srcdoc', false],
  ['javascript', 'javascript:alert(1)', false],
  ['ms_appx', 'ms-appx:///x.png', false],
  ['ftp', 'ftp://127.0.0.1/x.png', false],
  ['relative_not_absolute', '//attacker.example/x.png', false],
  ['empty', '', false],
];

const csc = (() => {
  const root = process.env.SystemRoot || 'C:\\Windows';
  for (const p of [path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')]) if (fs.existsSync(p)) return p;
  return null;
})();

const csStr = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';

function buildHarness() {
  const P = [];
  P.push('// 由 tests\\neg-shell-resource-whitelist.cjs 生成（勿手工维护）。');
  P.push('// 【逐字抽取】段 = 从 src\\shell\\CTBShellV2.cs 原样抽出的真源码；本程序不启动进程、不建窗口。');
  P.push('using System;');
  P.push('using System.IO;');
  P.push('');
  P.push('namespace CTBShell2');
  P.push('{');
  P.push('    public class HostBridge');
  P.push('    {');
  P.push('        public static string AppRoot;');
  P.push('        public static string DataRoot;');
  P.push('        /* 【逐字抽取】唯一一份包含性判据 */');
  P.push(EX.isUnderDir);
  P.push('    }');
  P.push('');
  P.push('    public static class NavGuard');
  P.push('    {');
  P.push('        /* ↓↓↓ 【逐字抽取】资源白名单及其依赖 ↓↓↓ */');
  P.push(EX.isAllowedResource);
  P.push(EX.isAllowedFile);
  P.push(EX.localPathOf);
  P.push(EX.isSrvOrigin);
  P.push(EX.trimFn);
  P.push('        /* ↑↑↑ 逐字抽取结束 ↑↑↑ */');
  P.push('    }');
  P.push('');
  P.push('    static class Program');
  P.push('    {');
  P.push('        static int Main(string[] argv)');
  P.push('        {');
  P.push('            HostBridge.AppRoot = Path.GetFullPath(argv[0]);');
  P.push('            HostBridge.DataRoot = Path.GetFullPath(argv[1]);');
  P.push('            string port = argv[2];');
  P.push('            string[,] samples = new string[,] {');
  SAMPLES.forEach(([name, uri], i) => {
    P.push('                { ' + csStr(name) + ', ' + csStr(uri) + ' }' + (i === SAMPLES.length - 1 ? '' : ','));
  });
  P.push('            };');
  P.push('            for (int i = 0; i < samples.GetLength(0); i++)');
  P.push('            {');
  P.push('                string why;');
  P.push('                bool ok = NavGuard.IsAllowedResource(samples[i, 1], port, out why);');
  P.push('                Console.WriteLine("RESULT|" + samples[i, 0] + "|" + (ok ? "allow" : "deny") + "|" + (why ?? ""));');
  P.push('            }');
  P.push('            return 0;');
  P.push('        }');
  P.push('    }');
  P.push('}');
  return P.join('\n') + '\n';
}

console.log('\n═══ B. 运行级：抽原文 → csc 编 → 逐样本真跑 ═══');
let rows = null;
if (MISSING.length) {
  A('B0 抽取完整才谈得上运行级', false, MISSING.join(' | '));
} else if (!csc) {
  console.log('  [SKIP] 本机找不到 .NET Framework csc.exe —— B 段运行级证据跳过（A/C 两段仍生效）');
} else {
  const csFile = path.join(tmp, 'reswl.cs');
  const exeFile = path.join(tmp, 'reswl.exe');
  const src = buildHarness();
  fs.writeFileSync(csFile, src, 'utf8');
  const r = spawnSync(csc, ['/nologo', '/target:exe', '/codepage:65001', '/out:' + exeFile, '/reference:System.dll', csFile],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) A('B0 复刻体编译成功', false, String(r.stdout || '') + String(r.stderr || ''));
  else {
    const run = spawnSync(exeFile, [appDir, libDir, PORT], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (run.status !== 0) A('B0 复刻体运行成功', false, 'exit=' + run.status + ' ' + String(run.stdout || '') + String(run.stderr || ''));
    else {
      rows = {};
      String(run.stdout || '').split(/\r?\n/).forEach(line => {
        if (!line.startsWith('RESULT|')) return;
        const f2 = line.split('|');
        rows[f2[1]] = { allow: f2[2] === 'allow', why: f2[3] || '' };
      });
      A('B0 复刻体编译并运行成功（抽取的真源码 + 最小宿主）', Object.keys(rows).length === SAMPLES.length,
        Object.keys(rows).length + '/' + SAMPLES.length + ' 个样本');
      A('B0b 复刻体不含任何进程/窗口代码（安全红线）', !/Process\.Start|UseShellExecute|new Form\(/.test(src), '');
      /* 逐样本断言 */
      const wrong = [];
      for (const [name, uri, want] of SAMPLES) {
        const got = rows[name];
        if (!got) { wrong.push(name + '(没跑到)'); continue; }
        if (got.allow !== want) wrong.push(name + '(期望' + (want ? '放行' : '拒绝') + '，实际' + (got.allow ? '放行' : '拒绝') + '：' + got.why + ')');
      }
      A('B1 逐样本：' + SAMPLES.length + ' 个样本的放行/拒绝面与判据一致', wrong.length === 0,
        wrong.length ? wrong.join(' | ') : '全部一致');
      const g = n => (rows[n] || {}).allow;
      A('B2 入口页与界面自身资源必须放行（否则整站白屏）',
        g('file_entry') === true && g('file_app_js') === true && g('file_app_css') === true,
        JSON.stringify([g('file_entry'), g('file_app_js'), g('file_app_css')]));
      A('B3 库内资产（题图/题干 html/md）必须放行（否则所有照片都看不见）',
        g('file_lib_img') === true && g('file_lib_html') === true && g('file_lib_md') === true,
        JSON.stringify([g('file_lib_img'), g('file_lib_html'), g('file_lib_md')]));
      A('B4 库外 file: 与同前缀兄弟目录必须拒绝（复用 IsUnderDir 的带分隔符判据）',
        g('file_outside') === false && g('file_system') === false && g('file_sibling') === false,
        JSON.stringify([g('file_outside'), g('file_system'), g('file_sibling')]));
      A('B5 外部域名一律拒绝（http/https 都拒）',
        g('http_external') === false && g('https_external') === false && g('https_right_port') === false,
        JSON.stringify([g('http_external'), g('https_external'), g('https_right_port')]));
      A('B6 端口必须等于真源、host 必须精确等于 127.0.0.1/localhost（错端口/伪装主机都拒）',
        g('http_wrong_port') === false && g('http_lookalike_host') === false && g('http_userinfo') === false,
        JSON.stringify([g('http_wrong_port'), g('http_lookalike_host'), g('http_userinfo')]));
      A('B7 库内真有的 data: URI 与 blob:（导出下载）必须放行 —— 不许误杀',
        g('data_uri') === true && g('blob_uri') === true, JSON.stringify([g('data_uri'), g('blob_uri')]));
      A('B8 其它 scheme（javascript:/ms-appx:/ws:/ftp:/about:srcdoc）一律拒绝',
        ['javascript', 'ms_appx', 'ws_local', 'ftp', 'about_srcdoc'].every(n => g(n) === false),
        JSON.stringify(['javascript', 'ms_appx', 'ws_local', 'ftp', 'about_srcdoc'].map(g)));
      A('B9 devtools:（F12 开发者工具自己的资源）必须放行 —— 否则是纯 UX 回归、零安全收益',
        g('devtools_bundled') === true && g('devtools_remote') === true,
        JSON.stringify([g('devtools_bundled'), g('devtools_remote')]));
      A('B9b 放行 devtools: 没有顺带把外部 https 放进来（两条样本仍在拒绝侧）',
        g('https_external') === false && g('https_right_port') === false,
        JSON.stringify([g('https_external'), g('https_right_port')]));
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   C. 阴性自证：掏掉白名单 / 半吊子修复
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n═══ C. 阴性自证（判据必须有牙齿） ═══');
{
  /* ① 改前状态：根本没有资源白名单（WebResourceRequested 没挂 / 判据恒放行） */
  const noWhitelist = () => true;
  A('C1 掏掉白名单（判据恒放行）⇒ 外部域名会被放行 —— 说明 B5 的拒绝断言有牙齿',
    noWhitelist('http://attacker.example/x.png') === true && noWhitelist('https://attacker.example/x.js') === true, '');

  /* ② 半吊子修复：只做"以白名单前缀开头"的字符串比较（本仓 S03 的历史缺陷形态） */
  const naive = (u, port) => u.toLowerCase().startsWith('http://127.0.0.1:' + port) || u.toLowerCase().startsWith('http://localhost:' + port);
  A('C2 半吊子修复（裸前缀比较）会把 userinfo 伪装放过去 ⇒ 这正是本用例 http_userinfo 样本要抓的',
    naive('http://127.0.0.1:' + PORT + '@attacker.example/x.png', PORT) === true, '');
  A('C3 真判据不放行同一个伪装串（两条判据在这里分道扬镳）',
    rows && rows.http_userinfo ? rows.http_userinfo.allow === false : true,
    rows ? JSON.stringify(rows.http_userinfo) : '(B 段跳过)');

  /* ③ 变异自证：把 C# 判据的 http 分支改回裸前缀比较，重跑同一批样本，伪装样本必须变放行 */
  if (csc && rows && !MISSING.length) {
    const mutated = EX.isAllowedResource.replace(/if \(IsSrvOrigin\(u, srvPort\)\) return true;/, 'if ((uri ?? "").ToLowerInvariant().StartsWith("http://127.0.0.1:" + srvPort)) return true;');
    A('C4 变异点命中（http 分支掏得动）', mutated !== EX.isAllowedResource, '');
    if (mutated !== EX.isAllowedResource) {
      const saved = EX.isAllowedResource;
      EX.isAllowedResource = mutated;
      const src = buildHarness();
      EX.isAllowedResource = saved;
      const csFile = path.join(tmp, 'reswl-mut.cs');
      const exeFile = path.join(tmp, 'reswl-mut.exe');
      fs.writeFileSync(csFile, src, 'utf8');
      const r = spawnSync(csc, ['/nologo', '/target:exe', '/codepage:65001', '/out:' + exeFile, '/reference:System.dll', csFile],
        { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) A('C5 变异体编译成功', false, String(r.stdout || '') + String(r.stderr || ''));
      else {
        const run = spawnSync(exeFile, [appDir, libDir, PORT], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
        const got = {};
        String(run.stdout || '').split(/\r?\n/).forEach(line => {
          if (!line.startsWith('RESULT|')) return;
          const q = line.split('|');
          got[q[1]] = q[2] === 'allow';
        });
        A('C5 变异后 http_userinfo 伪装串被放行（缺陷复现 ⇒ B6 有牙齿）', got.http_userinfo === true,
          '变异体 http_userinfo=' + got.http_userinfo);
        A('C6 阳性对照：变异体仍拒绝外部域名（差异来自 userinfo 判据，不是"全都放行"）',
          got.http_external === false && got.http_wrong_port === false,
          JSON.stringify([got.http_external, got.http_wrong_port]));
      }
    }
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }

console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + pass);
process.exit(fail ? 1 : 0);