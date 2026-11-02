#!/usr/bin/env node
/* 阴性用例（审计 A2/A3 → 整改清单 R3「类型准入」+ R4「失败回执传播」）
   守的是 `src\shell\CTBShellV2.cs` 里**三条链路共用**的那一份判据：
     openFile op / NavigationStarting 的库内 file: 转交 / NewWindowRequested 的库内 file: 转交。

   判据（R3）：系统关联程序只放行 jpg jpeg png webp gif bmp tif tiff pdf；`.md` 走内置阅读器；
     **其余一律不交系统程序**（exe cmd bat ps1 psm1 vbs wsf js jse lnk url hta msi reg scr cpl
     com pif jar chm html htm xhtml svg …），改为在资源管理器里定位并回 ok:false。
   判据（R4）：Dispatch/OpenWithSystem 必须**有返回值**；openFile 只在真成功时回 {"ok":true}，
     文件不存在 / 系统程序打不开 / 类型被拒 一律 ok:false，且用户可见的 Warn 告警保留。

   本文件两段判据：
     A. **源码级**：从 CTBShellV2.cs 抽唯一那份扩展名表与 RouteFor/Dispatch/openFile 的源码文本做断言
        （表里多了/少了扩展名、唯一实现被拆成三份、回执被改回固定 ok:true，都会红）。
     B. **运行级（可证伪的真证据）**：把 A 段抽出来的**真源码文本**（不是重写版）拼成一个最小 C#
        控制台复刻体，用 .NET Framework 的 csc 编出来真跑，断言逐个扩展名的真实回执与真实路由：
          · 库内不存在的路径        → ok:false（改前实测回 ok:true，见 run.log E1）
          · 库内 .bat               → 不启动、改走「定位」、ok:false（改前实测被执行，marker 为证）
          · 库内 .html/.svg/….exe   → 一律不交系统程序
          · 库内 .png/.pdf          → 交系统程序（白名单里的类型不许被误杀）
          · .md 打开成功            → ok:true；内置阅读器失败 → ok:false（不再掉进系统程序）
          · 系统程序打不开          → ok:false（不再"成功但没反应"）
         ⚠ 安全红线：复刻体里**没有任何 Process.Start / UseShellExecute** —— 开系统程序与定位
           两个动作都换成纯记录桩，跑它不会启动任何程序、不弹任何窗口；.bat 的 marker 文件必须
           保持不存在（这是"没有真的被执行"的现场证据）。测试源码里断言了这两条。

   阴性自证（C 段）：把新判据掏掉——RouteFor 还原成"除 .md 外一律交系统程序"、openFile 回执还原成
     固定 {"ok":true}——同一批复刻体必须复现缺陷（.bat 被交出去、不存在的路径回 ok:true）。
     变异点用"必须命中"断言守住：若源码结构变了导致掏不动，本用例当场红，不会静默失去牙齿。

   用法：node tests\neg-shell-openfile-policy.cjs
   退出码：0=PASS / 1=FAIL（csc 缺席时 B/C 段可见 SKIP，A 段仍判）
   （本机无 .NET Framework csc 属异常环境：build.ps1 本身就要求它）
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CS_PATH = path.join(ROOT, 'src', 'shell', 'CTBShellV2.cs');
const CS = fs.readFileSync(CS_PATH, 'utf8');

let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]   ' + label + (extra ? '  → ' + String(extra).slice(0, 240) : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + String(extra).slice(0, 240) : '')); }
};

/* ── 期望的准入面（本用例是判据的**权威副本**，不读源码来定期望值） ────────────── */
const ALLOW_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.pdf'];
/* 覆盖清单里的全部"必须拒绝"类型（html/htm/xhtml/svg 是 2026-11-02 这一轮新增的明确要求） */
const DENY_EXT = ['.exe', '.cmd', '.bat', '.ps1', '.psm1', '.vbs', '.wsf', '.js', '.jse', '.lnk',
  '.url', '.hta', '.msi', '.reg', '.scr', '.cpl', '.com', '.pif', '.jar', '.chm',
  '.html', '.htm', '.xhtml', '.svg'];

/* ══════════════════════════════════════════════════════════════════════════
   抽取工具：按大括号配对从 C# 源码里取**原文**（不是重新写一遍的复刻）
   ══════════════════════════════════════════════════════════════════════════ */
function skipCSharpNonCode(src, i) {
  const c = src[i];
  if (c === '"' || c === "'") {                       // 字符串/字符字面量（含 @"…" 与逐字串）
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
/** 从 marker 起（含 marker）抽到第一个配平的大括号块结束（含结尾 ';' 若有） */
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
    else if (c === '}') { depth--; if (depth === 0) { const semi = src[i + 1] === ';' ? 1 : 0; return src.slice(at, i + 1 + semi); } }
  }
  return null;
}
function sliceBetween(src, fromMarker, toMarker) {
  const a = src.indexOf(fromMarker);
  if (a < 0) return null;
  const b = src.indexOf(toMarker, a);
  if (b < 0) return null;
  return src.slice(a, b).replace(/\s+$/, '');
}

const EX = {};
const MISSING = [];
function take(name, marker, mode) {
  const got = mode === 'slice' ? null : extractBlock(CS, marker);
  EX[name] = got;
  if (!got) MISSING.push(name + ' ← ' + marker);
  return got;
}
take('tryResolve', 'public bool TryResolveInsideRoot(string rel, out string abs, out string why)');
take('isUnderDir', 'public static bool IsUnderDir(string p, string root)');
take('tryReal', 'static bool TryResolveRealPath(string full, out string real, out string why)');
take('tryFinal', 'static bool TryFinalPath(string path, out string finalPath, out string why)');
take('stripExt', 'static string StripExtendedPrefix(string p)');
take('sysOpenExt', 'public static readonly HashSet<string> SystemOpenExt');
take('openRoute', 'public enum OpenRoute');
take('routeFor', 'public static OpenRoute RouteFor(string path, out string ext)');
take('openResult', 'public struct OpenResult');
take('dispatch', 'public static OpenResult Dispatch(Form owner, CoreWebView2Environment env, string uri)');
take('relPath', 'public static string RelPath(string path)');
take('normPath', 'public static string NormalizePath(string p)');
take('fileUriToPath', 'public static string FileUriToPath(string uri)');
take('escJs', 'static string EscJs(string s)');
take('openWithSystem', 'public static OpenResult OpenWithSystem(Form owner, string target)');
take('reveal', 'public static bool Reveal(string relOrAbs)');
take('openFileBlock', 'else if (op == "openFile")');
EX.pinvoke = sliceBetween(CS, 'const uint FILE_READ_ATTRIBUTES = 0x0080;', 'static bool TryFinalPath(string path, out string finalPath, out string why)');
if (!EX.pinvoke) MISSING.push('pinvoke 常量与 DllImport 段');

console.log('═══ 0. 抽取（本用例的输入就是真源码文本） ═══');
A('从 CTBShellV2.cs 抽到全部判据文本（抽不到就没资格谈判据）', MISSING.length === 0,
  MISSING.length ? MISSING.join(' | ') : Object.keys(EX).length + ' 段');

/* ══════════════════════════════════════════════════════════════════════════
   A. 源码级判据
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\n═══ A. 源码级（唯一实现 / 类型表 / 回执形状） ═══');

/* A1 扩展名表：逐字面量比对（多一个少一个都红） */
const tableExts = (EX.sysOpenExt.match(/"\.[A-Za-z0-9]+"/g) || []).map(s => s.slice(1, -1).toLowerCase());
const tableSet = new Set(tableExts);
A('A1a 放行表恰好是那 9 个图片/PDF 扩展名（顺序无关，字面量逐个比）',
  tableExts.length === ALLOW_EXT.length && ALLOW_EXT.every(e => tableSet.has(e)),
  '表=' + JSON.stringify([...tableSet].sort()));
A('A1b 放行表里没有任何一个"必须拒绝"类型',
  DENY_EXT.every(e => !tableSet.has(e)),
  DENY_EXT.filter(e => tableSet.has(e)).join(',') || '0 个越界');
A('A1c html/htm/xhtml/svg 四个"看起来无害"的类型必须在拒绝侧（系统浏览器里没有本仓 CSP）',
  ['.html', '.htm', '.xhtml', '.svg'].every(e => !tableSet.has(e)), '');
A('A1d 表只有一份（`SystemOpenExt.Contains` 在全文恰好出现 1 次）',
  (CS.match(/SystemOpenExt\.Contains/g) || []).length === 1,
  (CS.match(/SystemOpenExt\.Contains/g) || []).length + ' 处');

/* A2 RouteFor：唯一路由函数，且默认落到 Reveal */
A('A2a RouteFor 存在且返回 OpenRoute', !!EX.routeFor && /public static OpenRoute RouteFor\(string path, out string ext\)/.test(CS), '');
A('A2b RouteFor 的默认分支是 Reveal（"其余一律不交系统程序"）', /return OpenRoute\.Reveal;/.test(EX.routeFor || ''), '');
A('A2c RouteFor 只认 SystemOpenExt 这一张表（没有第二个硬编码扩展名清单）',
  /SystemOpenExt\.Contains\(ext\)/.test(EX.routeFor || '') && (CS.match(/\.EndsWith\("\.(bat|exe|cmd|html|svg)"/gi) || []).length === 0, '');
A('A2d .md → 内置阅读器（现状不变）', /ext\.Equals\("\.md", StringComparison\.OrdinalIgnoreCase\)\) return OpenRoute\.Viewer;/.test(EX.routeFor || ''), '');
A('A2e 注释里写清了"为什么 html 也不放行"（CSP：系统浏览器里没有服务端那套 sandbox）',
  /html[\s\S]{0,400}?CSP/.test(CS) || /CSP[\s\S]{0,400}?html/.test(CS), '');

/* A3 三条链路共用一份判据 */
const dispatchCalls = (CS.match(/LocalLinks\.Dispatch\(/g) || []).length;
A('A3a 三条链路都走 LocalLinks.Dispatch（恰好 3 处调用点）', dispatchCalls === 3, dispatchCalls + ' 处');
A('A3b Dispatch 的返回值被导航链用上（不再是"调完就忘"）',
  /LocalLinks\.OpenResult r = LocalLinks\.Dispatch/.test(CS) && (CS.match(/LocalLinks\.OpenResult r = LocalLinks\.Dispatch/g) || []).length === 3,
  (CS.match(/LocalLinks\.OpenResult r = LocalLinks\.Dispatch/g) || []).length + ' 处');
A('A3c 没有一处丢弃 Dispatch 的返回值（每次调用都赋值给 OpenResult r）',
  (CS.match(/LocalLinks\.Dispatch\(/g) || []).length === (CS.match(/= LocalLinks\.Dispatch\(/g) || []).length,
  (CS.match(/= LocalLinks\.Dispatch\(/g) || []).length + ' 处赋值 / ' + dispatchCalls + ' 处调用');

/* A4 返回值（R4） */
A('A4a Dispatch 返回 OpenResult（不再是 void）', /public static OpenResult Dispatch\(/.test(CS), '');
A('A4b OpenWithSystem 返回 OpenResult（不再是 void）', /public static OpenResult OpenWithSystem\(/.test(CS), '');
A('A4c 全文不再有 `static void Dispatch` / `static void OpenWithSystem`',
  !/static void (Dispatch|OpenWithSystem)\(/.test(CS), '');
A('A4d OpenWithSystem 里有类型兜底（纵深防御：绕过 Dispatch 也交不出去）',
  /RouteFor\(target, out ext\) != OpenRoute\.System/.test(CS), '');

/* A5 回执形状：ok:true 只在成功分支 */
const ofb = EX.openFileBlock || '';
A('A5a openFile 的回执按 Dispatch 的真实结果给（`r.Ok ? "{\\"ok\\":true}" : …ok:false…`）',
  /resp = r\.Ok \? "\{\\"ok\\":true\}" : "\{\\"ok\\":false,\\"error\\":\\"" \+ EscJs\(r\.Err\) \+ "\\"\}";/.test(ofb), '');
A('A5b openFile 里没有"固定 ok:true"那种写法', !/resp = "\{\\"ok\\":true\}";/.test(ofb), '');
A('A5c openFile 里 Dispatch 的调用包在 try/catch 里（异常也必须变成 ok:false）',
  /catch \(Exception ex\)[\s\S]{0,200}resp = "\{\\"ok\\":false/.test(ofb), '');

/* A6 .md 分支不得回落到系统程序 */
const dsp = EX.dispatch || '';
const viewerSeg = dsp.slice(dsp.indexOf('OpenRoute.Viewer'), dsp.indexOf('if (route == OpenRoute.System)'));
A('A6a .md 分支的失败路径不调用 OpenWithSystem（打开失败就 ok:false，不许再交给系统程序）',
  viewerSeg.length > 0 && !/OpenWithSystem\s*\(/.test(viewerSeg), (viewerSeg.match(/OpenWithSystem\s*\(/g) || []).length + ' 处调用');
A('A6b 类型被拒的那一路调用 Reveal 并回"该类型不直接打开，已在文件夹中定位：<相对路径>"',
  /Reveal\(p\)\) \{ Log\([\s\S]{0,120}return OpenResult\.Fail\("该类型不直接打开，已在文件夹中定位：" \+ rel\);/.test(dsp), '');
A('A6c Reveal 失败时回执不撒谎（另有"定位失败"文案）',
  /在文件夹中定位失败：" \+ rel/.test(dsp), '');

/* A7 唯一出口：Dispatch 自己不起进程；"交系统程序"只有 OpenWithSystem 一个出口 */
const ows = EX.openWithSystem || '';
const rev = EX.reveal || '';
A('A7a Dispatch 里没有任何 Process.Start / UseShellExecute（打开动作只有两个下游出口）',
  !/Process\.Start\s*\(/.test(dsp) && !/UseShellExecute/.test(dsp), '');
A('A7b "交系统程序"的唯一出口是 OpenWithSystem（其函数体恰好 1 处 Process.Start + 1 处 UseShellExecute = true）',
  (ows.match(/Process\.Start\s*\(/g) || []).length === 1 && (ows.match(/UseShellExecute\s*=\s*true/g) || []).length === 1,
  (ows.match(/Process\.Start\s*\(/g) || []).length + ' / ' + (ows.match(/UseShellExecute\s*=\s*true/g) || []).length);
A('A7c "定位文件"走的是 explorer.exe /select，不是"打开文件"',
  /explorer\.exe/.test(rev) && /\/select/.test(rev), '');
A('A7d 类型被拒的那一路没有任何 Process.Start', !/Process\.Start\s*\(/.test(dsp), '');
A('A7e printPdf（另一处把库内文件交给 ShellExecute 的 op）也复用了同一张类型表',
  /else if \(op == "printPdf"\)[\s\S]{0,4000}?RouteFor\(abs, out pext\) != LocalLinks\.OpenRoute\.System/.test(CS), '');

/* ══════════════════════════════════════════════════════════════════════════
   B. 运行级：真源码文本 → 最小 C# 复刻体 → csc 编 → 真跑
   ══════════════════════════════════════════════════════════════════════════ */
const csc = findCsc();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-neg-openfile-'));
let newRun = null, mutRun = null;

/* 复刻体：抽出来的真源码文本 + 纯记录桩（无 Process.Start / 无窗口） */
function buildHarness(mutate) {
  let routeFor = EX.routeFor, openFileBlock = EX.openFileBlock;
  if (mutate) {
    /* 掏掉 R3：RouteFor 还原成"除 .md 外一律交系统程序" */
    const r2 = routeFor.replace(/if \(SystemOpenExt\.Contains\(ext\)\) return OpenRoute\.System;\s*\n\s*return OpenRoute\.Reveal;/,
      'return OpenRoute.System;');
    /* 掏掉 R4：回执还原成固定 ok:true */
    const o2 = openFileBlock.replace(/resp = r\.Ok \?[\s\S]*?;\n/, 'resp = "{\\"ok\\":true}";\n');
    if (r2 === routeFor || o2 === openFileBlock) return null;          // 掏不动就必须红，不许静默失去牙齿
    routeFor = r2; openFileBlock = o2;
  }
  const P = [];
  P.push('// 由 tests\\neg-shell-openfile-policy.cjs 生成（勿手工维护）。');
  P.push('// 【逐字抽取】= 从 src\\shell\\CTBShellV2.cs 原样抽出的真源码；【替身】= 只记录、不启动任何进程。');
  P.push('using System;');
  P.push('using System.Collections.Generic;');
  P.push('using System.IO;');
  P.push('using System.Runtime.InteropServices;');
  P.push('using System.Text;');
  P.push('');
  P.push('namespace CTBShell2');
  P.push('{');
  P.push('    static class Rec');
  P.push('    {');
  P.push('        public static readonly List<string> Lines = new List<string>();');
  P.push('        public static void Add(string s) { Lines.Add(s); }');
  P.push('        public static bool Has(string needle) { foreach (string s in Lines) if (s.Contains(needle)) return true; return false; }');
  P.push('    }');
  P.push('');
  P.push('    /* 【替身】真身是 WinForms 的 Form / WebView2 的 CoreWebView2Environment。');
  P.push('       必须是 public：被抽取的 Dispatch/OpenWithSystem 是 public 方法，参数类型不能比它更封闭。*/');
  P.push('    public class Form { }');
  P.push('    public class CoreWebView2Environment { }');
  P.push('    /* 【替身】真身 ViewerForm 会开一个 WebView2 窗口；这里只记录。');
  P.push('       故障注入：rel 路径含「读不了」时 Show() 抛异常 = 内置阅读器打不开。*/');
  P.push('    public class ViewerForm');
  P.push('    {');
  P.push('        readonly string html;');
  P.push('        public ViewerForm(CoreWebView2Environment e, string pageHtml) { html = pageHtml ?? ""; }');
  P.push('        public void Show()');
  P.push('        {');
  P.push('            Rec.Add("STUB viewer " + html);');
  P.push('            if (html.Contains("读不了")) throw new InvalidOperationException("注入的失败：内置阅读器打不开");');
  P.push('        }');
  P.push('    }');
  P.push('    /* 【替身】真身 Md.ToHtml 把 markdown 渲染成页面；这里把 rel 路径当标记带出去。*/');
  P.push('    public static class Md { public static string ToHtml(string md, string name, string rel) { return "MD:" + rel; } }');
  P.push('');
  P.push('    public class HostBridge');
  P.push('    {');
  P.push('        public static string DataRoot;');
  P.push('        public static string AppRoot;');
  P.push('        public static void Log(string s) { Rec.Add("LOG " + s); }');
  P.push('        /* ↓↓↓ 【逐字抽取】包含性判据链（与壳里同一份实现） ↓↓↓ */');
  P.push(EX.tryResolve);
  P.push(EX.isUnderDir);
  P.push(EX.tryReal);
  P.push(EX.pinvoke);
  P.push(EX.tryFinal);
  P.push(EX.stripExt);
  P.push('        /* ↑↑↑ 逐字抽取结束 ↑↑↑ */');
  P.push('    }');
  P.push('');
  P.push('    public static class LocalLinks');
  P.push('    {');
  P.push('        /* 【替身】真身写 shell.log；这里进记录器。*/');
  P.push('        static void Log(string s) { Rec.Add("LOG " + s); }');
  P.push('        /* 【替身】真身弹 MessageBox；这里进记录器（保证跑测试不弹任何窗）。*/');
  P.push('        static void Warn(Form owner, string msg) { Rec.Add("WARN " + (msg ?? "").Replace("\\r\\n", " / ").Replace("\\n", " / ")); }');
  P.push('        /* 【替身】真身 Reveal 会起 explorer.exe /select；本用例**不许启动任何进程**，只记录。');
  P.push('           故障注入：路径含「定位不了」时返回 false。*/');
  P.push('        public static bool Reveal(string relOrAbs) { Rec.Add("STUB reveal " + relOrAbs); return !(relOrAbs ?? "").Contains("定位不了"); }');
  P.push('        /* 【替身】真身 OpenWithSystem 是壳里唯一一处"把文件交给系统关联程序"的地方（会真的起进程）；');
  P.push('           本用例**不许启动任何程序**，只记录。故障注入：路径含「打不开」时返回失败。*/');
  P.push('        public static OpenResult OpenWithSystem(Form owner, string target)');
  P.push('        {');
  P.push('            Rec.Add("STUB openWithSystem " + target);');
  P.push('            if ((target ?? "").Contains("打不开")) return OpenResult.Fail("系统程序打不开：注入的失败");');
  P.push('            return OpenResult.Good();');
  P.push('        }');
  P.push(EX.normPath);
  P.push(EX.fileUriToPath);
  P.push('        /* ↓↓↓ 【逐字抽取】类型准入 + 分发（RouteFor 是变异点所在） ↓↓↓ */');
  P.push(EX.sysOpenExt);
  P.push(EX.openRoute);
  P.push(routeFor);
  P.push(EX.openResult);
  P.push(EX.dispatch);
  P.push(EX.relPath);
  P.push('        /* ↑↑↑ 逐字抽取结束 ↑↑↑ */');
  P.push('    }');
  P.push('');
  P.push('    class ShellForm : Form');
  P.push('    {');
  P.push('        public HostBridge bridge = new HostBridge();');
  P.push(EX.escJs);
  P.push('        /* 【替身】真身 = HostBridge.TryReadJsonString（JSON 取值器，不是本用例的判据对象）：');
  P.push('           从 {"payload":{"path":"…"}} 里取 path。*/');
  P.push('        static string ExtractStringTop(string json, string key)');
  P.push('        {');
  P.push('            int k = json.IndexOf(\'"\' + key + \'"\', StringComparison.Ordinal);');
  P.push('            if (k < 0) return "";');
  P.push('            int c = json.IndexOf(\':\', k);');
  P.push('            if (c < 0) return "";');
  P.push('            int q1 = json.IndexOf(\'"\', c + 1);');
  P.push('            if (q1 < 0) return "";');
  P.push('            var sb = new StringBuilder();');
  P.push('            for (int i = q1 + 1; i < json.Length; i++)');
  P.push('            {');
  P.push('                char ch = json[i];');
  P.push('                if (ch == \'\\\\\' && i + 1 < json.Length) { sb.Append(json[i + 1]); i++; continue; }');
  P.push('                if (ch == \'"\') break;');
  P.push('                sb.Append(ch);');
  P.push('            }');
  P.push('            return sb.ToString();');
  P.push('        }');
  P.push('        public string RunOpenFile(string raw, CoreWebView2Environment env)');
  P.push('        {');
  P.push('            string resp = null;');
  P.push('            /* ↓↓↓ 【逐字抽取】openFile 分派块（回执逻辑是变异点所在） ↓↓↓ */');
  /* 抽出来的是 `else if (op == "openFile") { … }`：贴进方法体时要去掉 `else if (…)` 前缀 */
  P.push(openFileBlock.slice(openFileBlock.indexOf('{')));
  P.push('            /* ↑↑↑ 逐字抽取结束 ↑↑↑ */');
  P.push('            return resp;');
  P.push('        }');
  P.push('    }');
  P.push('');
  P.push('    static class Program');
  P.push('    {');
  P.push('        static readonly StringBuilder Sink = new StringBuilder();');
  P.push('        static void Out(string s) { Sink.AppendLine(s); Console.WriteLine(s); }');
  P.push('        static int caseNo = 0;');
  P.push('        static void Case(string id, string rel, string note)');
  P.push('        {');
  P.push('            caseNo++;');
  P.push('            Rec.Lines.Clear();');
  P.push('            var sh = new ShellForm();');
  P.push('            string raw = "{\\"id\\":\\"" + caseNo + "\\",\\"op\\":\\"openFile\\",\\"payload\\":{\\"path\\":\\"" + rel.Replace("\\\\", "\\\\\\\\") + "\\"}}";');
  P.push('            string resp = sh.RunOpenFile(raw, new CoreWebView2Environment());');
  P.push('            Out("RESULT|" + id + "|" + (resp != null && resp.StartsWith("{\\"ok\\":true") ? "ok:true" : "ok:false")');
  P.push('                + "|system=" + Rec.Has("STUB openWithSystem") + "|viewer=" + Rec.Has("STUB viewer")');
  P.push('                + "|reveal=" + Rec.Has("STUB reveal") + "|receipt=" + resp + "|note=" + note);');
  P.push('        }');
  P.push('        static int Main(string[] argv)');
  P.push('        {');
  P.push('            Console.OutputEncoding = Encoding.UTF8;');
  P.push('            HostBridge.DataRoot = Path.GetFullPath(argv[0]);');
  P.push('            HostBridge.AppRoot = Path.GetFullPath(argv[1]);');
  P.push('            string lib = HostBridge.DataRoot;');
  P.push('            Directory.CreateDirectory(lib);');
  P.push('            var utf8 = new UTF8Encoding(false);');
  P.push('            string marker = Path.Combine(lib, "_E2_marker.txt");');
  P.push('            if (File.Exists(marker)) File.Delete(marker);');
  P.push('            File.WriteAllText(Path.Combine(lib, "E2_证明可被启动.bat"),');
  P.push('                "@echo off\\r\\necho ws2-repro-executed > \\"" + marker + "\\"\\r\\n", utf8);');
  P.push('            File.WriteAllText(Path.Combine(lib, "题图.png"), "fake png", utf8);');
  P.push('            File.WriteAllText(Path.Combine(lib, "原卷.pdf"), "fake pdf", utf8);');
  P.push('            File.WriteAllText(Path.Combine(lib, "题干.html"), "<html></html>", utf8);');
  P.push('            File.WriteAllText(Path.Combine(lib, "图.svg"), "<svg/>", utf8);');
  P.push('            File.WriteAllText(Path.Combine(lib, "错题记录.md"), "# 记录", utf8);');
  P.push('            File.WriteAllText(Path.Combine(lib, "读不了.md"), "# 记录", utf8);');
  P.push('            File.WriteAllText(Path.Combine(lib, "打不开的原卷图.png"), "fake png", utf8);');
  P.push('            string[] banned = new string[] {');
  P.push('                "exe","cmd","bat","ps1","psm1","vbs","wsf","js","jse","lnk","url","hta","msi",');
  P.push('                "reg","scr","cpl","com","pif","jar","chm","html","htm","xhtml","svg","xyz" };');
  P.push('            foreach (string e in banned)');
  P.push('                File.WriteAllText(Path.Combine(lib, "样本_" + e + "." + e), "x", utf8);');
  P.push('            Out("LIB=" + lib);');
  P.push('            Case("E1", "待办\\\\不存在的证据图.png", "库内不存在的路径");');
  P.push('            Case("E2", "E2_证明可被启动.bat", "库内 .bat（改前实测被执行）");');
  P.push('            Case("E3", "..\\\\..\\\\Windows\\\\System32\\\\calc.exe", "库外路径（阴性对照：门禁必须挡）");');
  P.push('            Case("E4", "题图.png", "库内图片（白名单，必须交系统程序）");');
  P.push('            Case("E5", "题干.html", "库内 html（必须拒绝）");');
  P.push('            Case("E6", "错题记录.md", "库内 md（内置阅读器成功）");');
  P.push('            Case("E7", "读不了.md", "库内 md（内置阅读器失败 → 必须 ok:false）");');
  P.push('            Case("E8", "打不开的原卷图.png", "白名单类型但系统程序打不开 → 必须 ok:false");');
  P.push('            Case("E9", "原卷.pdf", "PDF（白名单）");');
  P.push('            foreach (string e in banned) Case("X_" + e, "样本_" + e + "." + e, "禁止类型 " + e);');
  P.push('            Out("MARKER=" + (File.Exists(marker) ? "EXISTS" : "ABSENT"));');
  P.push('            File.WriteAllText(argv[2], Sink.ToString(), utf8);');
  P.push('            return 0;');
  P.push('        }');
  P.push('    }');
  P.push('}');
  return P.join('\n') + '\n';
}

function findCsc() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  for (const p of [path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function compileAndRun(csSource, tag, libDir) {
  const csFile = path.join(tmp, tag + '.cs');
  const exeFile = path.join(tmp, tag + '.exe');
  const outFile = path.join(tmp, tag + '.txt');
  fs.writeFileSync(csFile, csSource, 'utf8');                 // UTF-8 无 BOM（与仓库红线一致）
  const r = spawnSync(csc, ['/nologo', '/target:exe', '/codepage:65001', '/out:' + exeFile,
    '/reference:System.dll', '/reference:System.Core.dll', csFile],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return { error: 'csc 编译失败：' + String(r.stdout || '') + String(r.stderr || '') };
  const run = spawnSync(exeFile, [libDir, path.join(tmp, tag + '-app'), outFile],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) return { error: '复刻体退出码 ' + run.status + '：' + String(run.stdout || '') + String(run.stderr || '') };
  if (!fs.existsSync(outFile)) return { error: '复刻体没有产出结果文件' };
  const rows = {};
  let marker = '';
  for (const line of fs.readFileSync(outFile, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('RESULT|')) {
      const f = line.split('|');
      const row = {};
      f.slice(3).forEach(kv => { const i = kv.indexOf('='); if (i > 0) row[kv.slice(0, i)] = kv.slice(i + 1); });
      /* C# 的 bool.ToString() 是 True/False —— 归一成小写再断言，别让大小写假装成判据 */
      for (const k of ['system', 'viewer', 'reveal']) if (k in row) row[k] = String(row[k]).toLowerCase();
      row.id = f[1]; row.ok = f[2];
      rows[row.id] = row;
    } else if (line.startsWith('MARKER=')) marker = line.slice(7);
  }
  return { rows, marker, source: csSource };
}

console.log('\n═══ B. 运行级：真源码抽出来的复刻体（真编真跑） ═══');
if (!csc) {
  console.log('  [SKIP] 本机找不到 .NET Framework csc.exe —— B/C 两段运行级证据跳过（A 段源码判据仍生效）');
} else if (MISSING.length) {
  A('B0 抽取完整才谈得上运行级复刻', false, MISSING.join(' | '));
} else {
  const libDir = path.join(tmp, 'libroot');
  const newCs = buildHarness(false);
  newRun = compileAndRun(newCs, 'fixed', libDir);
  if (newRun.error) A('B0 复刻体编译并运行成功', false, newRun.error);
  else {
    A('B0 复刻体编译并运行成功（抽取的真源码 + 纯记录桩）', Object.keys(newRun.rows).length >= 30,
      Object.keys(newRun.rows).length + ' 个用例');
    A('B0b 复刻体里没有任何 Process.Start / UseShellExecute（安全红线：跑它不启动任何程序、不弹窗）',
      !/Process\.Start|UseShellExecute/.test(newCs), '');
    A('B0c 库内 .bat 的 marker 文件不存在（没有被真的执行）', newRun.marker === 'ABSENT', 'MARKER=' + newRun.marker);

    const R = id => newRun.rows[id] || {};
    const okFalse = id => R(id).ok === 'ok:false';
    const shows = id => R(id).receipt || '';

    A('B1 库内不存在的路径 → ok:false（改前：ok:true，见 run.log E1）',
      okFalse('E1') && /文件不存在/.test(shows('E1')), R('E1').receipt);
    A('B2 库内 .bat → 不启动（system=false）、改走定位（reveal=true）、ok:false',
      okFalse('E2') && R('E2').system === 'false' && R('E2').reveal === 'true' && R('E2').viewer === 'false', R('E2').receipt);
    A('B2b .bat 的回执文案与判据一致', /该类型不直接打开，已在文件夹中定位：E2_证明可被启动\.bat/.test(shows('E2')), shows('E2'));
    A('B3 库外路径仍被包含性判据拒绝（阴性对照：门禁有牙齿）',
      okFalse('E3') && /越界拒绝/.test(shows('E3')) && R('E3').system === 'false', R('E3').receipt);
    A('B4 库内 .png → 交系统程序且 ok:true（白名单类型不许被误杀）',
      R('E4').ok === 'ok:true' && R('E4').system === 'true' && R('E4').reveal === 'false', R('E4').receipt);
    A('B5 库内 .html → 拒绝且不交系统程序（改前：交给系统浏览器打开）',
      okFalse('E5') && R('E5').system === 'false' && R('E5').reveal === 'true', R('E5').receipt);
    A('B6 库内 .md 打开成功 → ok:true，走内置阅读器（system=false）',
      R('E6').ok === 'ok:true' && R('E6').viewer === 'true' && R('E6').system === 'false', R('E6').receipt);
    A('B7 内置阅读器失败 → ok:false（且不许回落到系统程序）',
      okFalse('E7') && R('E7').viewer === 'true' && R('E7').system === 'false' && /内置阅读器打不开/.test(shows('E7')), R('E7').receipt);
    A('B8 白名单类型但系统程序打不开 → ok:false（改前：仍回 ok:true）',
      okFalse('E8') && R('E8').system === 'true' && /系统程序打不开/.test(shows('E8')), R('E8').receipt);
    A('B9 库内 .pdf → 白名单，交系统程序且 ok:true', R('E9').ok === 'ok:true' && R('E9').system === 'true', R('E9').receipt);

    /* 逐扩展名：全部"必须拒绝"类型 */
    const bad = [];
    for (const e of DENY_EXT.concat(['.xyz'])) {
      const row = R('X_' + e.slice(1));
      if (!row.id) { bad.push(e + '(没跑到)'); continue; }
      if (row.ok !== 'ok:false' || row.system !== 'false' || row.reveal !== 'true') bad.push(e + '(ok=' + row.ok + ',system=' + row.system + ',reveal=' + row.reveal + ')');
    }
    A('B10 逐扩展名：' + DENY_EXT.length + ' 个禁止类型 + 未知类型全部 ok:false、零系统程序、走定位',
      bad.length === 0, bad.length ? bad.join(' ') : '全部通过');
    const htmlSvg = ['X_html', 'X_svg', 'X_htm', 'X_xhtml'].map(id => R(id).ok);
    A('B11 html/htm/xhtml/svg 四个必须落在拒绝侧（本轮新增要求）',
      htmlSvg.every(x => x === 'ok:false'), JSON.stringify(htmlSvg));

    /* ── C. 阴性自证：掏掉新判据必须复现缺陷 ── */
    console.log('\n═══ C. 阴性自证（掏掉 R3/R4 必须复现缺陷） ═══');
    const mutCs = buildHarness(true);
    A('C0 变异点命中（RouteFor 与 openFile 回执都掏得动 —— 掏不动就说明用例已经失去牙齿）', !!mutCs, '');
    if (mutCs) {
      mutRun = compileAndRun(mutCs, 'mutated', path.join(tmp, 'libroot-mut'));
      if (mutRun.error) A('C1 变异体编译并运行成功', false, mutRun.error);
      else {
        const MR = id => mutRun.rows[id] || {};
        A('C1a 掏掉判据后：库内不存在的路径又回 ok:true（缺陷复现）', MR('E1').ok === 'ok:true', MR('E1').receipt);
        A('C1b 掏掉判据后：库内 .bat 又被交给系统程序（system=true，缺陷复现）',
          MR('E2').system === 'true' && MR('E2').reveal === 'false' && MR('E2').ok === 'ok:true', MR('E2').receipt);
        A('C1c 掏掉判据后：.html 也被交给系统程序（缺陷复现）', MR('E5').system === 'true', MR('E5').receipt);
        A('C1d 掏掉判据后：内置阅读器失败仍回 ok:true（缺陷复现）', MR('E7').ok === 'ok:true', MR('E7').receipt);
        A('C1e 掏掉判据后：系统程序打不开仍回 ok:true（缺陷复现）', MR('E8').ok === 'ok:true', MR('E8').receipt);
        A('C1f 变异体里 .bat 的 marker 仍然不存在（两个变体都不启动任何东西）', mutRun.marker === 'ABSENT', 'MARKER=' + mutRun.marker);
        A('C1g 阳性对照仍在（图片在新旧两版都是 ok:true，说明差异来自类型准入而不是"什么都不做了"）',
          MR('E4').ok === 'ok:true' && R('E4').ok === 'ok:true', '');
      }
    }
  }
}

/* 收尾：临时目录必须清干净（里面有 .bat/.exe 样本，不留垃圾） */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }

console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + pass);
process.exit(fail ? 1 : 0);
