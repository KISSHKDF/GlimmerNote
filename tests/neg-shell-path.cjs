#!/usr/bin/env node
/* 阴性用例（审计 F-03 / §4 缺口清单第 7 条）：`HostBridge.TryResolveInsideRoot`（root 包含性校验）
   的**同构**复现 + 反例集。断言：
     ① 绝对路径越界（`C:\Windows\System32\calc.exe`—— .NET `Path.Combine` 会直接返回第二参）被拒；
     ② `..\` 逃逸被拒；
     ③ **同前缀兄弟目录**（`…\MY\错题本-X`）被拒——裸 `StartsWith(root)` 会漏，本文件显式自证它会漏；
     ④ 根内相对/绝对路径（含 `/` 混用、盘符大小写）放行且规范化后确在根内。

   同构说明：C# 侧 `Path.Combine(rootFull, rel)` + `Path.GetFullPath` 的语义，在本文件里用
   `path.win32.resolve(rootFull, rel)` 复现（rel 为绝对路径时 resolve 同样返回 rel 本身）；
   盘符/大小写不敏感用 toLowerCase 复现 `StringComparison.OrdinalIgnoreCase`。
   **真实代码**的直接证据见修复说明里的 C# 探针（把 CTBShellV2.cs 一起编译后直接调用该方法）。
   退出码 0=全绿。不读不写任何题库文件。 */
'use strict';
const P = require('path');                       // 需要 P.join / P.resolve（不叫 path，避免与上面的 W 混淆）
const W = require('path').win32;

const ROOT = require('./_测试环境.cjs').LIB;
/* ★ 2026-10-23：这条判据守的是**库根**（C# 里 TryResolveInsideRoot 的边界 = DataRoot），
   所以 ROOT 取库根，不是仓库根。兄弟目录名一律从 ROOT 现算 —— 原先写死 `错题本-X`，
   库一改名/换位置，用例本身就变成假命题（会误报"裸 StartsWith 不放行"）。 */
const LIB_NAME = P.basename(ROOT);
const SIBLING = (suffix) => P.resolve(ROOT, '..', LIB_NAME + suffix);
let fails = 0, asserts = 0;
const A = (name, cond, detail) => {
  asserts++;
  if (cond) console.log('  ✔ ' + name + (detail ? '  [' + detail + ']' : ''));
  else { fails++; console.log('  ✖ ' + name + '  [' + (detail || '') + ']'); }
};

/* ---------- 唯一实现（C# TryResolveInsideRoot 的同构版） ---------- */
function tryResolveInsideRoot(root, rel) {
  if (!rel) return { ok: false, why: 'path 为空' };
  const rootFull = W.resolve(root);                                  // Path.GetFullPath(Root)
  let abs;
  try { abs = W.resolve(rootFull, String(rel).replace(/\//g, '\\')); } // GetFullPath(Combine(rootFull, rel))
  catch (e) { return { ok: false, why: '路径非法：' + e.message }; }
  const prefix = rootFull + '\\';                                     // 必须带尾分隔符
  if (!abs.toLowerCase().startsWith(prefix.toLowerCase())) return { ok: false, why: '越界拒绝（只允许题库根内路径）' };
  return { ok: true, abs: abs };
}
/* 修复前 readFile 用的写法（带尾分隔符）；以及审计点名的"更早的裸 StartsWith(root)"写法 */
const oldReadFileStyle = (root, rel) => W.resolve(root, String(rel).replace(/\//g, '\\'))
  .toLowerCase().startsWith(W.resolve(root).toLowerCase() + '\\');
const naiveStartsWith = (root, rel) => W.resolve(root, String(rel).replace(/\//g, '\\'))
  .toLowerCase().startsWith(W.resolve(root).toLowerCase());

console.log('══ ① .NET Path.Combine 语义（复现 F-03 的根因） ══');
{
  const abs = W.resolve(ROOT, 'C:\\Windows\\System32\\calc.exe');
  A('绝对路径「覆盖」掉根目录（Path.Combine 返回第二参）', abs === 'C:\\Windows\\System32\\calc.exe', abs);
  A('该越界路径修复后被拒', tryResolveInsideRoot(ROOT, 'C:\\Windows\\System32\\calc.exe').ok === false, 'ok:false');
  A('对照 · 旧 readFile 那版（有校验）也拒（说明 openFile 缺的是校验本身，不是判据写法）',
    oldReadFileStyle(ROOT, 'C:\\Windows\\System32\\calc.exe') === false, '旧 readFile 版=false');
}

console.log('\n══ ② 越界必须被拒 ══');
const rejected = [
  ['绝对路径 · 系统 exe', 'C:\\Windows\\System32\\calc.exe'],
  ['绝对路径 · 系统目录', 'C:\\Windows\\System32'],
  ['绝对路径 · 别的盘', 'E:\\secret\\x.txt'],
  ['相对 · 向上逃逸', '..\\..\\..\\Windows\\System32\\calc.exe'],
  ['相对 · 单层逃逸', '..\\_秘密.txt'],
  ['相对 · 逃逸后回来（规范化仍在根外）', '九年级\\..\\..\\错题本-X\\a.txt'],
  ['相对 · 向前斜杠逃逸', '../../../Windows/notepad.exe'],
  ['同前缀兄弟目录（裸 StartsWith 会漏）', '..\\' + LIB_NAME + '-X\\secret.txt'],
  ['同前缀兄弟目录（绝对）', SIBLING('-X') + '\\secret.txt'],
  ['同前缀兄弟目录（夹在中间）', '九年级\\物理\\..\\..\\..\\' + LIB_NAME + '-X\\s.txt'],
  ['空路径', ''],
  ['正好是根目录本身', '.'],
  ['规范化后正好是根目录', '九年级\\..'],
  ['UNC 路径（根外）', '\\\\?\\C:\\Windows\\notepad.exe'],
  ['设备路径（根外）', '\\\\.\\PhysicalDrive0'],
];
for (const [label, rel] of rejected) {
  const r = tryResolveInsideRoot(ROOT, rel);
  A('拒绝 · ' + label, r.ok === false, 'rel=' + JSON.stringify(rel) + ' → ' + (r.ok ? '放行到 ' + r.abs : 'ok:false'));
}
{ /* 自证：其中"同前缀兄弟目录"这条，裸 StartsWith 写法确实会漏 ⇒ 这条断言有牙齿 */
  const rel = '..\\' + LIB_NAME + '-X\\secret.txt';
  A('自证 · 裸 StartsWith(root) 会放行同前缀兄弟目录（本测试抓得住）', naiveStartsWith(ROOT, rel) === true,
    '裸校验=' + naiveStartsWith(ROOT, rel) + ' 修复后=' + tryResolveInsideRoot(ROOT, rel).ok);
  A('对照 · 修复前 readFile 那版（带尾分隔符）已能挡住这条', oldReadFileStyle(ROOT, rel) === false, '旧 readFile 版=false');
}

console.log('\n══ ③ 根内路径必须放行 ══');
const accepted = [
  ['卡片题图（相对 · 正斜杠）', '九年级/物理/P0017-浮力/题图.jpg'],
  ['卡片题干（相对 · 反斜杠）', '九年级\\物理\\P0017-浮力\\题干.html'],
  ['下划线开头的真源', '_状态.json'],
  ['子目录 PDF', '_待确认\\原卷\\01.pdf'],
  ['绝对路径 · 根内', P.join(ROOT, '九年级', '物理', 'a.png')],
  ['绝对路径 · 盘符小写', P.join(ROOT, '九年级', '物理', 'a.png').replace(/^([A-Z]):/, (m, d) => d.toLowerCase() + ':')],
  ['含空格与中文', '九年级/物理/第 17 题 浮力/原卷截图.jpg'],
  ['带单点段（规范化仍在内）', '九年级/./物理/./a.png'],
];
for (const [label, rel] of accepted) {
  const r = tryResolveInsideRoot(ROOT, rel);
  const inside = r.ok && r.abs.toLowerCase().startsWith((W.resolve(ROOT) + '\\').toLowerCase());
  A('放行 · ' + label, inside, 'rel=' + JSON.stringify(rel) + ' → ' + (r.ok ? r.abs : 'ok:false ' + r.why));
}

console.log('\n══ ④ 前缀相似但不同根（防同前缀兄弟目录的另一半） ══');
{
  const A1 = tryResolveInsideRoot(ROOT, '..\\' + LIB_NAME + '-X\\s.txt');
  const A2 = tryResolveInsideRoot(ROOT, '..\\' + LIB_NAME + '2\\s.txt');
  const A3 = tryResolveInsideRoot(ROOT, '..\\' + LIB_NAME + '.bak\\_状态.json');
  A('兄弟目录 ' + LIB_NAME + '-X / ' + LIB_NAME + '2 / ' + LIB_NAME + '.bak 全部拒绝',
    A1.ok === false && A2.ok === false && A3.ok === false,
    JSON.stringify([A1.ok, A2.ok, A3.ok]));
}

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + asserts);
process.exit(fails ? 1 : 0);
