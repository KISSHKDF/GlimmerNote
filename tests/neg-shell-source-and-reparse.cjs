#!/usr/bin/env node
/* 阴性用例（审计 S03 / S07）：桌面壳 `src\shell\CTBShellV2.cs` 的两条安全判据。
 *
 *   S03 导航白名单 + 消息桥来源校验：改前 `NavigationStarting` 用**字符串前缀**
 *       `u.StartsWith("http://127.0.0.1:" + srvPort)` 判据 —— `http://127.0.0.1:7187@attacker.example/`
 *       会**通过**（userinfo 形态：真 host 是 attacker.example，字符串却以白名单前缀开头）；
 *       非 http/file 的 scheme 也没有统一默认拒绝；`OnWebMessage` 处理业务命令前**不核 e.Source**。
 *   S07 路径护栏不解析重解析点：`Path.GetFullPath` 不解析 junction/symlink，而读文件/起进程会跟随，
 *       ⇒ 库内一条 `mklink /J link C:\Windows` 就能读库外。
 *
 * 为什么是**源码级**用例：壳是编译产物（src\app\拾光小册.exe），fixture 模式下跑不了真桥；
 *   而本轮修复的关键恰恰是"判据写法"（Uri 解析 vs 字符串前缀、有没有 realpath 那一段），
 *   源码级断言能机械地钉住它，并且能在**变异体**上证明自己真的会红。
 *
 * 五段（每段都带自证，不许只有"看着对"）：
 *   ① 真源码结构断言：Uri 严格解析 / userinfo 必须为空 / host+端口白名单 / 默认拒绝 /
 *      OnWebMessage 先核 e.Source 再分发 / TryResolveInsideRoot 含 realpath 且两个根都参与。
 *   ② 阴性自证（审计点名的自证）：把判据换回**旧的裸 StartsWith**，`http://127.0.0.1:7187@attacker.example/`
 *      必须被判"通过" —— 证明这些断言抓得住旧缺陷，不是恒真。
 *   ③ 变异自证：把真源码文本分别改回旧写法 / 掏掉 e.Source 校验 / 掏掉 realpath 那一段，
 *      断言集必须至少有一条变红（并指出是哪条）。三个变异都**只动个位数行**，防"锚点打偏"。
 *   ④ 判据同构跑真表：用 JS 复刻新判据（Uri 语义与 .NET 一致，已逐条对拍），跑 30 条攻击/正常样本，
 *      结果必须与仓库里的 C# 探针逐条一致（探针证据见修复说明）。
 *   ⑤ 重解析点同构（skip-safe）：真建临时 junction，证明旧字符串判据放行、新判据拒绝，
 *      且"库根本身是 junction"时新判据**不误伤**正常路径（审计给的最小修法踩的坑）。
 *
 * 不读不写任何题库文件；⑤ 只用 %TEMP% 下的临时树，跑完清理。退出码 0=全绿。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = path.win32;

const REPO = path.resolve(__dirname, '..');
const CS_PATH = path.join(REPO, 'src', 'shell', 'CTBShellV2.cs');
const CS = fs.readFileSync(CS_PATH, 'utf8');

let fails = 0, asserts = 0;
const A = (label, ok, detail) => {
  asserts++;
  if (ok) console.log('  ✔ ' + label + (detail ? '  [' + detail + ']' : ''));
  else { fails++; console.log('  ✖ ' + label + '  [' + (detail || '') + ']'); }
};
/* 跳过也算一条断言（打印出来，但**不冒充通过**）—— 与 neg-server-junction.cjs 同口径 */
const S = (label, why) => { asserts++; console.log('  · 跳过（不假装通过）' + label + '  [' + why + ']'); };

/* ════════════════════════════════════════════════════════════════════════════
   判据/断言集：同一个函数既跑真源码，也跑变异体（③ 靠它证明有牙齿）
   ════════════════════════════════════════════════════════════════════════════ */

/* 只挑"注释里不会出现"的代码记号做结构断言 —— 本文件不做注释剥离，靠记号区分代码与注释。
   每个 check 返回 { label, ok, detail }。 */
function sourceChecks(src) {
  const out = [];
  const C = (label, ok, detail) => out.push({ label: label, ok: !!ok, detail: detail || '' });
  const at = (needle) => src.indexOf(needle);

  /* ── A. S03 导航白名单：必须是 Uri 严格解析 ── */
  C('A1 导航判据用 Uri.TryCreate 解析（不是字符串前缀）',
    /Uri\.TryCreate\(raw, UriKind\.Absolute, out parsed\)/.test(src));
  C('A2 scheme 白名单只放 file/http（其余默认拒）',
    /parsed\.Scheme != Uri\.UriSchemeFile && parsed\.Scheme != Uri\.UriSchemeHttp/.test(src));
  C('A3 http 来源必须 userinfo 为空（`127.0.0.1:7187@attacker.example` 的结构差异靠它抓）',
    /string\.IsNullOrEmpty\(parsed\.UserInfo\)/.test(src) && /!string\.IsNullOrEmpty\(u\.UserInfo\)/.test(src));
  C('A4 host 白名单 = 127.0.0.1 或 localhost（严格相等，不是前缀/后缀）',
    /string\.Equals\(u\.Host, "127\.0\.0\.1", StringComparison\.OrdinalIgnoreCase\)/.test(src) &&
    /string\.Equals\(u\.Host, "localhost", StringComparison\.OrdinalIgnoreCase\)/.test(src));
  C('A5 端口必须等于端口真源（不是"以端口数字开头"）',
    /int\.TryParse\(srvPort, out want\)/.test(src) && /u\.Port == want/.test(src));
  C('A6 旧的裸前缀判据与 srvPrefix 变量已彻底移除',
    !/\bsrvPrefix\b/.test(src) && !/u\.StartsWith\(srvPrefix/.test(src));
  C('A7 NavigationStarting 走 NavGuard.IsAllowedNavigation，且拒绝时 e.Cancel = true',
    /if \(NavGuard\.IsAllowedNavigation\(u, homePagePath, srvPortValue, out nwhy\)\) return;/.test(src) &&
    /HostBridge\.Log\("REJECT nav: "/.test(src) && /e\.Cancel = true;/.test(src));
  C('A8 默认拒绝：入口页/同源之外一律 return false（判据只有 IsAppOrigin 这一个出口）',
    /return IsAppOrigin\(u, homePath, srvPort, out why\);/.test(src));
  C('A9 file: 转交系统程序前必须先过库根包含性校验（不再无条件 Dispatch）',
    (function () {
      const i = at('NavigationStarting +='), j = at('NewWindowRequested +=');
      if (i < 0 || j <= i) return false;
      const block = src.slice(i, j);
      const d = block.indexOf('LocalLinks.Dispatch');
      const g = block.indexOf('TryResolveInsideRoot');
      return d > 0 && g > 0 && g < d;   // 先校验、后分发
    })());
  C('A10 新窗口（NewWindowRequested）同样只放行库内 file:，其它 scheme 不转发',
    (function () {
      const i = at('NewWindowRequested +=');
      if (i < 0) return false;
      const block = src.slice(i, i + 1600);
      return /NavGuard\.TryParse\(e\.Uri, out nw, out pwhy\)/.test(block) &&
        /nw\.Scheme != Uri\.UriSchemeFile/.test(block) &&
        /REJECT new-window/.test(block);
    })());

  /* ── B. S03 消息桥：先核 e.Source，再分发业务命令 ── */
  C('B1 OnWebMessage 读取 e.Source（改前完全没有这道检查）',
    /src = e\.Source;/.test(src));
  C('B2 来源判据走 NavGuard.IsTrustedSource（与导航白名单同一个 IsAppOrigin，不各写一份）',
    /NavGuard\.IsTrustedSource\(src, homePagePath, srvPortValue, out srcWhy\)/.test(src));
  C('B3 不受信任时记日志 + 回 {"ok":false,"error":…}，不进入业务分支',
    /webmessage REJECT id=/.test(src) && /\{\\"ok\\":false,\\"error\\":\\"消息来源不受信任/.test(src));
  C('B4 校验位置**早于**所有业务分发（readFile / mark / regen …）',
    (function () {
      const g = at('NavGuard.IsTrustedSource(src, homePagePath');
      if (g < 0) return false;
      const after = ['bridge.ReadFile(payload)', 'bridge.Mark(payload)', 'bridge.Rebuild()', 'bridge.Recipe(payload)'];
      return after.every((t) => { const i = at(t); return i > g; });
    })());
  C('B5 入口页比较不用"整串 URI 相等"（页面 replaceState 改 hash 后 Source 会带 #fragment）',
    /LocalPathOf\(u\)/.test(src) && /IndexOf\('\?'\)/.test(src) &&
    /public static string LocalPathOf\(Uri u\)/.test(src));
  C('B6 入口未知（homePath 为空）时 fail-safe 拒绝，而不是放行',
    /if \(entry == null\) return false;/.test(src) && /if \(string\.IsNullOrEmpty\(homePath\)\) return null;/.test(src));

  /* ── C. S07 重解析点 ── */
  C('C1 TryResolveInsideRoot 对 target 与库根**各解析一次**真实路径',
    /if \(!TryResolveRealPath\(cand, out candReal, out rpWhy\)\)/.test(src) &&
    /if \(!TryResolveRealPath\(rootFull, out rootReal, out rpWhy\)\)/.test(src));
  C('C2 两个根都参与判据（库根自己是 junction 时不误伤整库）',
    /if \(!IsUnderDir\(candReal, rootFull\) && !IsUnderDir\(candReal, rootReal\)\)/.test(src));
  C('C3 真实路径来自内核（GetFinalPathNameByHandle P/Invoke，.NET FX 4 没有 ResolveLinkTarget）',
    /static extern uint GetFinalPathNameByHandleW\(/.test(src) &&
    /GetFinalPathNameByHandleW\(h, sb, \(uint\)sb\.Capacity, FILE_NAME_NORMALIZED_DOS\)/.test(src));
  C('C4 目标不存在时上溯最近存在的祖先再拼接（写 PDF/建目录的常态不得跳过校验）',
    /if \(File\.Exists\(cur\) \|\| Directory\.Exists\(cur\)\)/.test(src) &&
    /tail\.Add\(Path\.GetFileName\(cur\)\)/.test(src) &&
    /for \(int i = tail\.Count - 1; i >= 0; i--\)/.test(src));
  C('C5 目录句柄需要 FILE_FLAG_BACKUP_SEMANTICS（否则解析不了目录的重解析点）',
    /FILE_FLAG_BACKUP_SEMANTICS/.test(src));
  C('C6 返回值去掉 `\\\\?\\` 扩展前缀（否则每个路径都会被判越界）',
    /static string StripExtendedPrefix\(/.test(src) && /p\.StartsWith\("\\\\\\\\\?\\\\"/.test(src));
  C('C7 老判据保留在**未解析路径**上（.. / 绝对路径 / 同前缀兄弟目录仍靠它挡）',
    /if \(!IsUnderDir\(cand, rootFull\)\)/.test(src));
  C('C8 包含性比较带目录分隔符（裸 StartsWith 会放行 `…\\错题本-X` 兄弟目录）',
    /return a\[b\.Length\] == '\\\\' \|\| a\[b\.Length\] == '\/';/.test(src));
  C('C9 旧的单行前缀判据已彻底移除',
    !/abs\.StartsWith\(rootFull \+ Path\.DirectorySeparatorChar/.test(src));
  return out;
}

const show = (label, list) => {
  console.log(label);
  for (const c of list) A(c.label, c.ok, c.detail);
};

/* ════════════════════════════════════════════════════════════════════════════
   ① 真源码
   ════════════════════════════════════════════════════════════════════════════ */
console.log('══ ① 真源码结构断言（src\\shell\\CTBShellV2.cs） ══');
const base = sourceChecks(CS);
show('  [S03 + S07 全部判据]', base);
A('① 源码断言集在真源码上全绿（作为后面变异体"必须变红"的基线）', base.every((c) => c.ok),
  base.filter((c) => !c.ok).map((c) => c.label).join(' | '));

/* ════════════════════════════════════════════════════════════════════════════
   ② 阴性自证：旧的裸 StartsWith 判据必须"通过"审计那条 URL
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\n══ ② 阴性自证：旧判据在审计 URL 上必须判"通过"（断言有牙齿） ══');
const HOME = 'C:\\Fake\\AppRoot\\index.html';
const PORT = '7187';
const TRAP = 'http://127.0.0.1:7187@attacker.example/';

/* 逐字复刻**改前**的 NavigationStarting 判据（源代码见 git show HEAD:src/shell/CTBShellV2.cs:1073-1086）：
     if (u.StartsWith("http")) { if (!u.StartsWith(srvPrefix)) e.Cancel = true; return; }
     if (u.StartsWith("file:")) { … 等于 home 放行，其余 Cancel + Dispatch }
     其它 scheme：**什么都不做 ⇒ 放行**（没有默认拒绝）
   返回 true = 这次导航被允许。 */
function oldJudge(uri, home, port) {
  const srvPrefix = 'http://127.0.0.1:' + port;
  const u = String(uri || '');
  if (u.toLowerCase().startsWith('http')) {
    if (!u.toLowerCase().startsWith(srvPrefix.toLowerCase())) return false;   // Cancel
    return true;
  }
  if (u.toLowerCase().startsWith('file:')) {
    /* 旧 code 走 LocalLinks.NormalizePath(FileUriToPath(u)) == NormalizePath(home)：
       这里用最宽松的等价形态（解码 + 归一化 + 小写），结论不变 —— 非入口一律 Cancel */
    let p = u;
    try { p = decodeURIComponent(new URL(u).pathname); } catch (e) { }
    p = p.replace(/^\/([A-Za-z]:)/, '$1');
    return W.resolve(p).toLowerCase() === W.resolve(home).toLowerCase();
  }
  return true;   // ★ 没有默认拒绝：ms-settings: / data: / javascript: 都"放行"
}
A('② 旧判据对 `' + TRAP + '` 判"通过"（userinfo 伪装端口，审计实测）',
  oldJudge(TRAP, HOME, PORT) === true, 'oldJudge=' + oldJudge(TRAP, HOME, PORT));
/* ★ 2026-10-30 实测纠正（写用例时先写错、按真代码复核后改对）：
   旧判据是"字符串**以**白名单前缀开头"，所以把 userinfo 放到 host **前面**的形态
   `http://attacker.example@127.0.0.1:7187/` 恰好被它挡住（前缀不在开头）——
   审计选 `127.0.0.1:7187@attacker.example` 这种"前缀在开头"的构造不是随手写的。 */
A('② 对照：旧判据会拒"userinfo 在前"的形态（说明它只是碰巧挡住，判据本身仍不成立）',
  oldJudge('http://attacker.example@127.0.0.1:7187/', HOME, PORT) === false);
A('② 旧判据还放行**同端口数字开头**的别的端口（`http://127.0.0.1:71871/` = 本机另一个服务）',
  oldJudge('http://127.0.0.1:71871/', HOME, PORT) === true);
A('② 旧判据对 `ms-settings:foo` 判"通过"（非 http/file 的 scheme 没有默认拒绝）',
  oldJudge('ms-settings:foo', HOME, PORT) === true);
A('② 旧判据对正常同源 URL 也判通过（说明上面三条不是"全拒"造成的假阳性）',
  oldJudge('http://127.0.0.1:7187/index.html', HOME, PORT) === true);

/* 新判据的 JS 同构（Uri 语义按 .NET 实测逐条对拍：WHATWG URL 的 hostname/username/port 拆分与 .NET 一致，
   非法端口（71870 / `127.0.0.1:7187.evil`）两边都解析失败） */
function newJudge(uri, home, port) {
  let u;
  try { u = new URL(String(uri || '')); } catch (e) { return false; }          // 解析失败 ⇒ 拒
  if (u.protocol !== 'file:' && u.protocol !== 'http:') return false;           // scheme 白名单
  if (u.protocol === 'http:' && u.username !== '') return false;                // userinfo 必须为空
  if (u.protocol === 'file:') {
    if (u.host !== '') return false;                                           // UNC 形态不认
    let p;
    try { p = decodeURIComponent(u.pathname); } catch (e) { return false; }
    const cut = p.search(/[?#]/);                                              // 同 C# LocalPathOf
    if (cut >= 0) p = p.slice(0, cut);
    p = p.replace(/^\/([A-Za-z]:)/, '$1');
    return W.resolve(p).toLowerCase() === W.resolve(home).toLowerCase();
  }
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;  // host 白名单
  const want = Number(port);
  if (!port || !Number.isInteger(want) || want <= 0) return false;             // 端口真源不可读 ⇒ 拒
  return Number(u.port || 80) === want;                                        // 端口严格相等
}
A('② 新判据对同一条审计 URL 判"拒绝"（这正是本轮修复的判据）',
  newJudge(TRAP, HOME, PORT) === false, 'newJudge=' + newJudge(TRAP, HOME, PORT));

/* ════════════════════════════════════════════════════════════════════════════
   ③ 变异自证：改回旧写法 / 掏掉新判据，断言集必须变红
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\n══ ③ 变异自证：三个变异体必须让断言集变红（不是恒真） ══');
const mutants = [
  {
    name: 'M1 判据退回旧的裸 StartsWith（把 Uri 解析换成字符串前缀）',
    from: 'if (!Uri.TryCreate(raw, UriKind.Absolute, out parsed) || parsed == null)',
    to: 'if (false) { parsed = null; } if (parsed == null)',
    mustFail: ['A1', 'A2', 'A3'],  // 至少这几条之一（下面统一判"至少一条红"）
  },
  {
    name: 'M2 掏掉 OnWebMessage 的 e.Source 校验（改前形态）',
    from: 'if (!NavGuard.IsTrustedSource(src, homePagePath, srvPortValue, out srcWhy))',
    to: 'if (false)   // 变异：掏掉来源校验',
    mustFail: ['B1', 'B2', 'B3', 'B4'],
  },
  {
    name: 'M3 掏掉重解析点那一段（退回"只比未解析路径"）',
    from: 'if (!IsUnderDir(candReal, rootFull) && !IsUnderDir(candReal, rootReal))',
    to: 'if (false)   // 变异：掏掉重解析点判据',
    mustFail: ['C1', 'C2'],
  },
];
for (const m of mutants) {
  const mut = CS.replace(m.from, m.to);
  A('③ ' + m.name + ' · 变异锚点命中', mut !== CS, m.from.slice(0, 48) + '…');
  A('③ ' + m.name + ' · 只改个位数行（防锚点打偏、整段被吃）',
    Math.abs(mut.split('\n').length - CS.split('\n').length) <= 2,
    CS.split('\n').length + ' 行 → ' + mut.split('\n').length + ' 行');
  const after = sourceChecks(mut);
  const red = after.filter((c) => !c.ok).map((c) => c.label.split(/[ ]/)[0]);
  A('③ ' + m.name + ' · 断言集**变红**（判据真有牙齿）', red.length > 0, '红=' + red.join(','));
  A('③ ' + m.name + ' · 至少命中预期的那些判据',
    m.mustFail.some((k) => red.indexOf(k) >= 0), '期望含 ' + m.mustFail.join('/') + '，实际红=' + red.join(','));
}

/* ════════════════════════════════════════════════════════════════════════════
   ④ 判据同构跑真表（与仓库的 C# 探针逐条对拍，样本同源）
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\n══ ④ 新判据同构：30 条攻击/正常样本（结果必须与 C# 探针逐条一致） ══');
const NAV_CASES = [
  ['file:///C:/Fake/AppRoot/index.html', true, '入口页本身'],
  ['file:///C:/Fake/AppRoot/index.html#bank', true, '入口页 + hash（replaceState 实测形态）'],
  ['file:///C:/Fake/AppRoot/index.html?x=1#y', true, '入口页 + query + hash'],
  ['FILE:///c:/fake/approot/INDEX.HTML', true, 'scheme/盘符/大小写差异'],
  ['file:///C:/Fake/AppRoot/%69ndex.html', true, '百分号编码的入口页'],
  ['http://127.0.0.1:7187/', true, '本机服务端根'],
  ['http://127.0.0.1:7187/index.html?a=1#b', true, '同源子路径 + query'],
  ['HTTP://127.0.0.1:7187/api/state', true, 'scheme 大小写'],
  ['http://localhost:7187/api/state', true, 'localhost 同源'],
  ['http://LOCALHOST:7187/', true, 'LOCALHOST 大小写'],
  [TRAP, false, '★审计原样用例：userinfo 伪装端口'],
  ['http://attacker.example@127.0.0.1:7187/', false, 'userinfo 非空（即使 host 对）'],
  ['http://127.0.0.1:71870/', false, '端口数字开头的主机名（解析即失败）'],
  ['http://127.0.0.1:71871/', false, '同端口数字开头的**别的端口**（旧判据会误放）'],
  ['http://127.0.0.1:7187.evil/', false, '端口后接域名'],
  ['https://127.0.0.1:7187/', false, 'https 不是本机服务端（明文 http）'],
  ['http://127.0.0.1:7188/', false, '端口不对'],
  ['http://192.168.1.5:7187/', false, '非回环地址'],
  ['http://[::1]:7187/', false, 'IPv6 回环不在白名单'],
  ['file:///C:/Windows/win.ini', false, '入口外 file:'],
  ['file:///C:/Fake/AppRoot/other.html', false, '同目录但非入口页'],
  ['file:///C:/Fake/AppRoot/../secret/index.html', false, '.. 逃出入口目录'],
  ['file://server/share/index.html', false, 'UNC 形态 file:'],
  ['about:blank', false, 'about:'],
  ['javascript:alert(1)', false, 'javascript:'],
  ['data:text/html,<b>x</b>', false, 'data:'],
  ['blob:file:///abc', false, 'blob:'],
  ['ms-appx:///a', false, '自定义 scheme'],
  ['', false, '空来源'],
  ['http://127.0.0.1:7187/', false, '端口真源不可读 ⇒ http 一侧整体关闭'],
  ['file:///C:/Fake/AppRoot/index.html', true, '端口真源不可读不影响 file: 入口页'],
];
for (const [uri, want, label] of NAV_CASES) {
  const port = label.indexOf('端口真源不可读') >= 0 ? '' : PORT;   // 空端口 = 真源不可读
  const got = newJudge(uri, HOME, port);
  A('④ ' + label + ' => ' + (want ? '允许' : '拒绝'), got === want, 'uri=' + JSON.stringify(uri) + ' 实得=' + got);
}

/* ════════════════════════════════════════════════════════════════════════════
   ⑤ 重解析点同构（真 junction；建不出来就显式跳过，不假装通过）
   ════════════════════════════════════════════════════════════════════════════ */
console.log('\n══ ⑤ 重解析点同构：真 junction 上旧判据必漏、新判据必抓、库根=junction 不误伤 ══');
const ROOTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-s07-'));
const LIB = path.join(ROOTDIR, 'lib');
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-s07-out-'));
const LIB_JUNCTION = path.join(ROOTDIR, 'lib-as-junction');
fs.mkdirSync(path.join(LIB, 'sub'), { recursive: true });
fs.writeFileSync(path.join(LIB, 'inside.txt'), 'INSIDE\n');
fs.writeFileSync(path.join(LIB, 'sub', 'in.txt'), 'SUB\n');
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'OUTSIDE-SECRET\n');
const mkJunction = (link, target) => {
  try { fs.symlinkSync(target, link, 'junction'); return { ok: true }; }
  catch (e) { return { ok: false, err: String(e.code || e.message) }; }
};
const jOut = mkJunction(path.join(LIB, 'link-out'), OUTSIDE);
const jIn = mkJunction(path.join(LIB, 'link-in'), path.join(LIB, 'sub'));
const jLib = mkJunction(LIB_JUNCTION, LIB);

/* 旧判据（改前 TryResolveInsideRoot）：Path.GetFullPath 归一化 + 带尾分隔符的前缀比较 */
const oldInside = (root, rel) => {
  const rootFull = W.resolve(root);
  const abs = W.resolve(rootFull, String(rel || '').replace(/\//g, '\\'));
  return abs.toLowerCase().startsWith((rootFull + '\\').toLowerCase());
};
/* 新判据（本次修复）的同构：真实路径 = 最近存在祖先的 realpath + 不存在的尾部；
   判据 = 未解析路径在未解析根内，且真实路径落在 {未解析根, 根 realpath} 任一之内 */
const realOr = (p) => { try { return fs.realpathSync(p); } catch (e) { return W.resolve(p); } };
const realOf = (full) => {
  let cur = W.resolve(full);
  const tail = [];
  for (;;) {
    if (fs.existsSync(cur)) {
      let r = realOr(cur);
      for (let i = tail.length - 1; i >= 0; i--) r = W.resolve(r, tail[i]);
      return W.resolve(r);
    }
    const up = W.dirname(cur);
    if (!up || up === cur) return W.resolve(full);
    tail.push(W.basename(cur));
    cur = up;
  }
};
const insideDir = (p, root) => {
  const a = String(p).replace(/[\\/]+$/, '').toLowerCase();
  const b = String(root).replace(/[\\/]+$/, '').toLowerCase();
  if (!a || !b || a.length <= b.length) return false;
  if (!a.startsWith(b)) return false;
  const ch = a[b.length];
  return ch === '\\' || ch === '/';
};
const newInside = (root, rel) => {
  const rootFull = W.resolve(root);
  const cand = W.resolve(rootFull, String(rel || '').replace(/\//g, '\\'));
  if (!insideDir(cand, rootFull)) return false;                       // ① 未解析
  const candReal = realOf(cand), rootReal = realOf(rootFull);         // ② realpath
  return insideDir(candReal, rootFull) || insideDir(candReal, rootReal);   // ③ 两个根
};

if (!jOut.ok) {
  S('⑤ 真 junction 用例', '本机建不出 junction（' + jOut.err + '）—— 无法复现重解析点场景');
} else {
  A('⑤ 装置：库内 junction → 库外、库内 junction → 库内、库根 junction 全部就绪',
    jOut.ok && jIn.ok && jLib.ok,
    'link-out=' + (jOut.ok ? 'ok' : jOut.err) + ' link-in=' + (jIn.ok ? 'ok' : jIn.err) + ' lib=' + (jLib.ok ? 'ok' : jLib.err));

  const relOut = 'link-out\\secret.txt';
  A('⑤ 自证：旧判据**放行** junction → 库外（审计 S07 的原始现象）', oldInside(LIB, relOut) === true);
  A('⑤ 新判据**拒绝** junction → 库外', newInside(LIB, relOut) === false, 'realpath=' + realOf(W.resolve(LIB, relOut)));
  A('⑤ 新判据拒绝 junction → 库外 + 目标不存在（写 PDF/建目录的路径）',
    newInside(LIB, 'link-out\\newfile.txt') === false);
  A('⑤ 新判据放行库内 junction → 库内（不是"一律拒软链"）',
    newInside(LIB, 'link-in\\in.txt') === true);
  A('⑤ 新判据仍放行库内普通文件与子目录',
    newInside(LIB, 'inside.txt') === true && newInside(LIB, 'sub/in.txt') === true);
  A('⑤ 新判据仍拒绝 `..` 逃逸 / 绝对路径 / 同前缀兄弟目录 / 库根本身',
    newInside(LIB, '..\\x.txt') === false &&
    newInside(LIB, 'C:\\Windows\\win.ini') === false &&
    newInside(LIB, '..\\' + W.basename(LIB) + '-X\\s.txt') === false &&
    newInside(LIB, '.') === false);

  if (!jLib.ok) S('⑤ 库根=junction 回归', 'mklink 不可用：' + jLib.err);
  else {
    const realOfFile = fs.realpathSync(path.join(LIB_JUNCTION, 'inside.txt'));
    A('⑤ 前置：realpath(库根内文件) 落在**库根路径之外**（正是会误判的形态）',
      insideDir(realOfFile, LIB_JUNCTION) === false, 'realpath=' + realOfFile);
    A('⑤ 新判据在"库根是 junction"时**放行**正常文件（审计最小修法在这里全拒）',
      newInside(LIB_JUNCTION, 'inside.txt') === true);
    A('⑤ 同上：子目录与库内软链也放行',
      newInside(LIB_JUNCTION, 'sub/in.txt') === true && newInside(LIB_JUNCTION, 'link-in\\in.txt') === true);
    A('⑤ 同上：junction → 库外仍然拒绝（豁免根，不放行越界）',
      newInside(LIB_JUNCTION, 'link-out\\secret.txt') === false);
    /* 变异：只与未解析的根比（审计给的最小修法）—— 必须把整库判成越界，证明 ③ 不可省 */
    const minimalFix = (root, rel) => oldInside(root, rel) && insideDir(realOf(W.resolve(root, String(rel))), W.resolve(root));
    A('⑤ 变异自证：只与未解析根比时，库根=junction 会把正常文件判成越界（③ 不可省）',
      minimalFix(LIB_JUNCTION, 'inside.txt') === false);
  }
}

/* 清理（删 junction 不能删到目标；先摘链接再删树） */
try {
  for (const l of [path.join(LIB, 'link-out'), path.join(LIB, 'link-in'), LIB_JUNCTION]) {
    try { const st = fs.lstatSync(l); if (st.isSymbolicLink()) fs.unlinkSync(l); } catch (e) { }
  }
  fs.rmSync(ROOTDIR, { recursive: true, force: true });
} catch (e) { }
A('⑤ 清理安全：删 junction 后它指向的库外目标目录仍在', fs.existsSync(OUTSIDE), OUTSIDE);
try { fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch (e) { }
A('⑤ 临时树已清理（库根与库外目标都不在了）', !fs.existsSync(ROOTDIR) && !fs.existsSync(OUTSIDE));

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + asserts);
process.exit(fails ? 1 : 0);
