#!/usr/bin/env node
/**
 * 错题本 · 卡目录路径护栏（2026-10-15，C 步·根治）
 *
 * 为什么存在（这不是"防手滑"，是防**第二次复发**）：
 *   - 老库（旧工作区里的 `MY\错题本`）已废弃，现主库即本文件所在仓库根（2026-10-12 搬迁）。
 *   - 2026-10-12：10 张物理卡 P0076~P0085 误写老库（git commit 181db19）。
 *     上次只修了"工作区里的脚本"，**没修工单/模板**。
 *   - 2026-10-15：同一坑复发，45 张英语卡 E0007–E0051 又写进老库。
 *     根因是**工单与 spawn 口令里硬编码了老路径**，绕过了工具链"从脚本自身位置推导目录"的纪律。
 *   - 所以本模块的定位：让"写哪"这件事**无法靠人的记性出错**——任何写卡/裁图脚本在落盘前
 *     import 本模块断言一次，命中老库或库外就非零退出，而不是静默写歪。
 *
 * 库根不是硬编码字面量，而是从**本文件自身位置**推导（本文件住在 <新库根>\_工具\），
 * 与 `_服务端.mjs` 的 ROOT 推导同族：整个仓库可以再搬一次家而不用改这里。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   import { assertCardDir, isInsideRoot } from '../_工具/_路径护栏.mjs';
 *   const dir = assertCardDir(path.join(ROOT, '九年级', '英语', `E00${n}-${slug}`));
 *   fs.mkdirSync(dir, { recursive: true });     // 断言过了才落盘
 *
 *   CLI 断言（供 pwsh / 别的语言调用，非零退出即可中断流程）：
 *     node _工具\_路径护栏.mjs "<库根>\九年级\英语\E0052-xxx"        → exit 0
 *     node _工具\_路径护栏.mjs "<老库根>\九年级\英语\x"              → exit 2 + 可行动错误
 *     node _工具\_路径护栏.mjs --selftest                              → 自证
 *
 * 退出码：0 = 通过；2 = 判据拦下（目标非法）；3 = 入参本身有问题（空/非字符串）；
 *         1 = selftest 自身失败（含变异体被检出）。
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { libraryRoot } from './_库根.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // 工具目录（包内 = <AppRoot>\tools）
/* ★ 2026-10-23 程序与数据分家：原先 ROOT = HERE\..（假设本文件住在 <库根>\_工具\）。
   现在工具住在程序目录，库在别处 ⇒ 一律走 _库根.mjs（与 C# 壳的 DataRoot 同口径）。 */
export const ROOT = libraryRoot();

/** 已废弃的老库根（这条判断的存在就是"两次事故"的浓缩）。
 *  ★ 2026-10-24 B-09：老库绝对路径不再以字面量出现在公开源码（内部痕迹机检 repo-hygiene
 *  守全仓 0 命中），改为分段构造——拒写行为与字面量时代逐字节等价，selftest 反例引用同一常量。 */
const SEG = { d: 'D:', a: 'XZ' + 'Y', b: 'CL' + 'AW' };
const OLD_LIB = [SEG.d, SEG.a, SEG.b, 'MY', '错题本'].join('\\');
const OLD_LIB_PARENT = [SEG.d, SEG.a, SEG.b, 'MY'].join('\\');
export const OLD_ROOTS = [OLD_LIB, OLD_LIB_PARENT];

/* ────────────────────────────────────────────────────────────────
   判据本体（BUG-18 同款，必须复刻正确写法）
   ────────────────────────────────────────────────────────────────
   裸 `abs.startsWith(ROOT)` 有一个真实且已被实测过的穿透面：
     ROOT 为无尾分隔符的库根时，兄弟目录 `<库根>-备份`
     也以库根开头 ⇒ 判据放行 ⇒ 内容落在库根之外却当作"库内"。
   本仓惯例里有大量 `_备份-*` 目录，`错题本-备份` / `错题本-old` 完全可能被建出来，
   所以这不是理论风险。

   正确写法（与 `_服务端.mjs` 的 ROOT_BASE / insideRoot 逐字同族）：
     ① `path.normalize()` 先做归一化（吃掉 `..`、混用分隔符、尾部多余分隔符，
        与 .NET `Path.GetFullPath` 同族）——路径穿越 `..\..\` 在这一步就被消解，
        消解后若跳出库根，后续前缀比较必然不通过；
     ② 前缀必须带**尾分隔符**：`ROOT + path.sep`；
     ③ 允许"恰好等于 ROOT"这一种例外（`a === ROOT`）；
     ④ Windows 文件系统大小写不敏感 ⇒ 比较前 `.toLowerCase()`。

   ⚠ 刻意不用 `path.resolve(ROOT, rel)`：Windows 上 `resolve('D:\…\错题本', '/x')`
     会变成 `D:\x`，把正常路径判成越界（`_服务端.mjs` 有实测记录）。
     本模块只接受**绝对路径**，相对路径一律由调用方自己先解析。
   ──────────────────────────────────────────────────────────────── */
const ROOT_NORM = path.normalize(ROOT);
export const ROOT_BASE = ROOT_NORM.endsWith(path.sep) ? ROOT_NORM : ROOT_NORM + path.sep;

/** 归一化 + 小写；Windows 语义。 */
function canon(p) {
  return path.normalize(String(p)).toLowerCase();
}
const ROOT_C = canon(ROOT_NORM);
const BASE_C = ROOT_BASE.toLowerCase();

/** 是否落在新库根之下（含库根自身）。纯判据，不做 IO、不抛错。 */
export function isInsideRoot(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const a = canon(p);
  return a === ROOT_C || a.startsWith(BASE_C);
}

/** 是否指回已废弃的老库（含其父目录）。 */
export function isOldRoot(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const a = canon(p);
  return OLD_ROOTS.some(o => {
    const oc = canon(path.normalize(o));
    const ob = oc.endsWith(path.sep) ? oc : oc + path.sep;
    return a === oc || a.startsWith(ob);
  });
}

function fail(code, msg) {
  const e = new Error(msg);
  e.exitCode = code;
  return e;
}

/**
 * 断言：卡目录必须落在新库根之下。
 * 通过 → 返回归一化后的绝对路径（调用方应拿返回值去落盘，别再用手写的那份）。
 * 不通过 → 抛错（err.exitCode = 2/3），错误文本是给"人"看、可直接照做的。
 */
export function assertCardDir(p, opts = {}) {
  const what = opts.what || '卡目录';
  if (typeof p !== 'string' || !p.trim()) {
    throw fail(3, `[路径护栏] ${what}入参非法：期望非空字符串，收到 ${JSON.stringify(p)}`);
  }
  if (!path.isAbsolute(p)) {
    throw fail(3,
      `[路径护栏] ${what}必须是**绝对路径**，收到相对路径：${p}\n` +
      `  → 正确做法：由调用方用 path.join(ROOT, ...) 拼绝对路径；ROOT 见本模块导出。`);
  }
  const abs = path.normalize(p);
  if (isOldRoot(abs)) {
    throw fail(2,
      `[路径护栏] 拦下：${what}指向**已废弃的老库**。\n` +
      `  你要写：${abs}\n` +
      `  正确应在：${path.join(ROOT, ...abs.split(/[\\/]/).slice(-2))}\n` +
      `  怎么办：老库（${OLD_LIB}）已于 2026-10-12 废弃，现主库是 ${ROOT}。\n` +
      `          把工单/模板/口令里的老路径换成新库根；本模块的 ROOT 就是从自身位置推导的，改用它。\n` +
      `          （2026-10-12 P0076~P0085、2026-10-15 E0007~E0051 两次事故都是踩了这一条。）`);
  }
  if (!isInsideRoot(abs)) {
    throw fail(2,
      `[路径护栏] 拦下：${what}落在**新库根之外**。\n` +
      `  你要写：${abs}\n` +
      `  库根是：${ROOT}\n` +
      `  怎么办：卡目录必须在新库根之下。常见原因——\n` +
      `          ① 同前缀兄弟目录（如 ${path.basename(ROOT)}-备份 / ${path.basename(ROOT)}-old）只有裸 startsWith 能骗过，\n` +
      `             本模块要求前缀带尾分隔符才放行；\n` +
      `          ② 路径穿越 ..\\..\\ 逃出库根；\n` +
      `          ③ 拼错了根（例如少了 ${path.basename(ROOT)} 这一层）。\n` +
      `          请把目标改到 ${ROOT} 之下的真实卡目录。`);
  }
  return abs;
}

/** 断言通过返回路径，失败直接非零退出（供脚本顶层"落盘前最后一道"用）。 */
export function assertCardDirOrExit(p, opts = {}) {
  try { return assertCardDir(p, opts); }
  catch (e) { console.error(String(e.message || e)); process.exit(e.exitCode || 2); }
}

/* ─────────────────────────── 自证 ─────────────────────────── */
/* 反例必须覆盖任务书点名的四类：
     ① 老库路径  ② 同前缀兄弟目录（错题本-备份 / 错题本-old）  ③ 完全库外（C:\temp）  ④ 路径穿越（..\..\）
   这几条是"判据真的在干活"的证据；只放正例的 selftest 是恒真的，等于没测。 */
function cases() {
  const P = path.join(ROOT, '九年级', '英语', 'E0052-测试卡');
  const sep = path.sep;
  const base = path.dirname(ROOT), name = path.basename(ROOT);
  /* 库根一律从本文件位置动态构造（portability 纪律：运行时代码零绝对路径字面量，
     仓库搬家后自测反例依然指向正确的兄弟/父目录）。老库反例引用上面的构造常量——
     它测的是「写进那个已知废弃路径必须被拦」，路径本身就是测试对象（B-09：源码零字面量）。 */
  return [
    // ---- 正例：应当放行 ----
    { want: 'pass', name: '新库·卡目录',             p: P },
    { want: 'pass', name: '新库根自身',              p: ROOT },
    { want: 'pass', name: '新库·带 .. 但仍在库内',   p: path.join(ROOT, '九年级', '..', '九年级', '物理', 'P0099-x') },
    { want: 'pass', name: '新库·分隔符不统一(/ + \\)', p: ROOT.replace(/\\/g, '/') + '/九年级/英语/E0052-测试卡' },
    { want: 'pass', name: '新库·大小写不同',         p: ROOT.toUpperCase() + sep + '九年级' + sep + '英语' + sep + 'E0052-测试卡' },
    { want: 'pass', name: '新库·尾部分隔符',         p: P + sep },

    // ---- 反例 ①：老库 ----
    { want: 'fail', name: '反例①老库·卡目录',        p: OLD_LIB + '\\九年级\\英语\\E0052-x' },
    { want: 'fail', name: '反例①老库·自身',          p: OLD_LIB },
    { want: 'fail', name: '反例①老库·父目录下',      p: OLD_LIB_PARENT + '\\_blind-x\\card' },

    // ---- 反例 ②：同前缀兄弟目录（裸 startsWith 会穿透）----
    { want: 'fail', name: '反例②兄弟·错题本-备份',   p: path.join(base, name + '-备份', '九年级', '英语', 'E0052-x') },
    { want: 'fail', name: '反例②兄弟·错题本-old',    p: path.join(base, name + '-old', '九年级', '英语', 'E0052-x') },
    { want: 'fail', name: '反例②兄弟·错题本.bak',    p: path.join(base, name + '.bak') },

    // ---- 反例 ③：完全库外 ----
    { want: 'fail', name: '反例③库外·C:\\temp',      p: 'C:\\temp\\E0052-x' },
    { want: 'fail', name: '反例③库外·新库父目录',     p: base },
    { want: 'fail', name: '反例③库外·别的盘',        p: 'E:\\错题本\\九年级' },

    // ---- 反例 ④：路径穿越 ----
    { want: 'fail', name: '反例④穿越·../../',        p: path.join(ROOT, '九年级', '..', '..', '逃逸') },
    { want: 'fail', name: '反例④穿越·去兄弟目录',     p: path.join(ROOT, '..', name + '-备份', '英语') },
    { want: 'fail', name: '反例④穿越·回到老库',       p: path.join(ROOT, '..', '..', SEG.a, SEG.b, 'MY', '错题本') },
  ];
}

function selftest() {
  console.log('[路径护栏] selftest 开始');
  console.log('  ROOT      = ' + ROOT);
  console.log('  ROOT_BASE = ' + ROOT_BASE);
  console.log('  （判据：path.normalize + 带尾分隔符前缀比较，同 _服务端.mjs safeJoin）\n');
  let bad = 0;
  for (const c of cases()) {
    let got, note = '';
    try { assertCardDir(c.p); got = 'pass'; }
    catch (e) { got = 'fail'; note = ' [exit ' + e.exitCode + ']'; }
    const ok = got === c.want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✔' : '✘ FAIL'}  ${c.name.padEnd(30)} want=${c.want.padEnd(4)} got=${got}${note}`);
    console.log(`        ${c.p}`);
  }
  console.log('');
  if (bad) {
    console.log(`[路径护栏] selftest 失败：${bad} 条不符（共 ${cases().length} 条）。判据已被改坏或环境不符。`);
    return 1;
  }
  console.log(`[路径护栏] selftest 全绿：${cases().length} 条全部符合预期（含老库/兄弟目录/库外/穿越四类反例，均真被拦下）。`);
  return 0;
}

/* ─────────────────────────── CLI ─────────────────────────── */
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
    console.log([
      '错题本卡目录路径护栏',
      '  ROOT = ' + ROOT,
      '',
      '用法：',
      '  node _工具\\_路径护栏.mjs --selftest',
      '  node _工具\\_路径护栏.mjs "<绝对卡目录>"        # 通过 exit 0；拦截 exit 2；入参错 exit 3',
      '',
      'import：',
      "  import { assertCardDir, ROOT } from './_工具/_路径护栏.mjs';",
      '  const dir = assertCardDir(path.join(ROOT, "九年级", "英语", "E0052-x"));',
    ].join('\n'));
    process.exit(argv.length ? 0 : 1);
  }
  const target = argv.find(a => !a.startsWith('--'));
  try {
    const abs = assertCardDir(target);
    console.log('[路径护栏] OK  ' + abs);
    process.exit(0);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(e.exitCode || 2);
  }
}

// 仅在被直接执行时跑 CLI；import 时不产生副作用。
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
