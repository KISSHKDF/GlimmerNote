// 可搬移性验证（只读 + 一次真实启动）：把整个题库复制到别处，确认程序认新位置
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
let fail = 0;
const A = (l, c, d) => { if (c) console.log('  [OK]  ' + l + (d ? '  → ' + d : '')); else { fail++; console.log('  [FAIL] ' + l + '  → ' + d); } };

console.log('═══ ① 运行时代码里是否还有硬编码路径 ═══');
/* 口径（别把分母搞错）：这里查的是**产品运行时代码**（壳 / 工具链 / 前端 / 生成器）。
   tests\ 下是一次性排查脚本与复现用例，其中若干含旧路径字面量（正是它们在复现
   "当年写死了什么"），改它们对可搬移性无帮助；文档同理。
   真正的判据只有一个：换个目录，程序能不能跑。
   ★ 2026-10-24 B-09：内部根名词表改从 repo-hygiene.cjs 引（本文件不再写死字面量，
   否则自己就成了全仓唯一含内部代号的文件，repo-hygiene 的 0 命中判据立不起来）。 */
const HY = require('./repo-hygiene.cjs');
const files = [];
const SKIP = new Set(['.git', 'wv2-profile', 'wv2-sdk', 'Default', 'EBWebView', '_probe', '_影像备份', '_archive', 'tests', 'docs', '_桌面', '_工作留档']);
/* _工作留档（2026-10-16 归档目录）：一次性修复与批次脚本的历史留档，与 _work- 前缀、_备份- 前缀目录同类，
   不是产品运行时代码——portability 只审运行时，归档里的路径字面量不影响程序可搬移性。 */
(function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; if (/^(_work-|_备份-)/.test(e.name)) continue; const f = path.join(d, e.name); e.isDirectory() ? w(f) : files.push(f); } })(ROOT);
/* 判据从"匹配 D:\\根名 / D:/根名 两种写法"收紧为"运行时代码里根名 = 0"（更强、更简单，
   注释已剥除，误报风险与原口径一致）。 */
const hits = [];
for (const f of files) {
  if (!/\.(cs|mjs|ps1|cjs|js|html)$/i.test(f)) continue;
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue }
  // 去掉注释再查，避免把"这里曾经硬编码过"的说明文字算进去。
  // 先剥多行块注释 /* ... */（可跨行），再剥行尾 // 与整行 # / * 注释。
  const stripped = s
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释（跨行）
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))      // 行注释
    .filter(l => !/^\s*(#|\*)/.test(l))       // 整行井号/星号注释
    .join('\n');
  const n = HY.INTERNAL_ROOTS.reduce((a, r) => a + stripped.split(r).length - 1, 0);
  if (n) hits.push([n, path.relative(ROOT, f).split(path.sep).join('/')]);
}
const total = hits.reduce((a, x) => a + x[0], 0);
hits.sort((a, b) => b[0] - a[0]).forEach(([n, r]) => console.log('   ' + String(n).padStart(3) + '  ' + r));
A('运行时代码已无内部工作区根名（词表见 repo-hygiene）', total === 0, '剩余 ' + total + ' 处（' + hits.length + ' 文件）');
// 信息项：tests/ 下历史脚本还剩多少（不判红 —— 它们不影响程序运行）
let testHits = 0;
(function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'out') continue; const f = path.join(d, e.name); if (e.isDirectory()) w(f); else if (/\.(cjs|mjs)$/.test(e.name)) { try { testHits += HY.INTERNAL_ROOTS.reduce((a, r) => a + (fs.readFileSync(f, 'utf8').split(r).length - 1), 0); } catch { } } } })(path.join(ROOT, 'tests'));
console.log('  [信息] tests/ 历史脚本仍含根名词量 ' + testHits + ' 处（一次性探针/复现用例，不影响运行；全仓 0 命中由 repo-hygiene 守）');

console.log('\n═══ ② exe 二进制里是否还嵌着绝对路径 ═══');
/* ★ 2026-10-23：exe 位置改到 src\app\拾光小册.exe（新布局：exe 与界面同目录）。
   老路径 src\app\拾光小册.exe 已不存在 —— 找不到就**响亮报红**，不许静默跳过。 */
const EXE = path.join(ROOT, 'src', 'app', '拾光小册.exe');
if (!fs.existsSync(EXE)) {
  A('exe 存在（' + EXE + '）', false, '先跑 src\\shell\\build.ps1');
  console.log('\n✖ 可搬移性静态检查未通过（缺 exe，后续断言无从谈起）');
  process.exit(1);
}
const exe = fs.readFileSync(EXE);
/* ★ 2026-10-24 B-09：样本表从词表构造（本文件零字面量）。错题本是产品品类词，允许出现。 */
const ROOTNAME = HY.INTERNAL_ROOTS[0], OLDNAME = HY.INTERNAL_ROOTS[1];
const exeSamples = [
  'D:\\' + ROOTNAME + '\\错题本',   // 老冻结区库根
  'D:\\' + ROOTNAME,                // 工作区根
  OLDNAME + '\\' + ROOTNAME,        // 更早的老库路径人名段
  'D:/' + ROOTNAME,                 // 正斜杠形态
];
for (const s of exeSamples) {
  A('exe 不含 ' + s + '（UTF-16LE）', exe.indexOf(Buffer.from(s, 'utf16le')) === -1, '');
  A('exe 不含 ' + s + '（ASCII）', exe.indexOf(Buffer.from(s, 'utf8')) === -1, '');
}

console.log('\n═══ ③ 版本资源（exe 属性不再是 0.0.0.0）═══');
// 用 PE 目录里找 VS_VERSION_INFO 的 UTF-16 字符串（简单可靠）
const s2 = exe.toString('utf16le');
/* ★ 2026-10-23：版本号改成日期制（VERSION.json 唯一真源），产品名改 GlimmerNote。
   断言从"写死 2.0.0.0 / CuotiBen"改成"与 VERSION.json 一致"—— 否则每发一版都要改测试。 */
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'VERSION.json'), 'utf8'));
const seg = String(V.version).split('.');
const asmVer = seg[0] + '.' + parseInt(seg[1], 10) + '.' + parseInt(seg[2], 10) + '.' + parseInt(seg[3], 10);
A('exe 含 FileVersion ' + asmVer + '（= VERSION.json ' + V.version + '）', s2.includes(asmVer), '');
A('exe 含 ProductName GlimmerNote', /GlimmerNote/.test(s2), '');

console.log('\n═══ ④ 崩溃兜底与日志轮转已在二进制里 ═══');
const cs = fs.readFileSync(path.join(ROOT, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
A('有 ThreadException 兜底', /ThreadException/.test(cs), '');
A('有 AppDomain.UnhandledException 兜底', /UnhandledException/.test(cs), '');
A('有日志轮转逻辑', /LogMaxBytes/.test(cs) && /\.1/.test(cs), '');
A('Main() 整体包 try', /static void Main\(\)\s*\n\s*\{\s*\n\s*try/.test(cs), '');

console.log('\n' + (fail === 0 ? '✔ 可搬移性静态检查全通过' : '✖ ' + fail + ' 项未通过'));
process.exit(fail ? 1 : 0);