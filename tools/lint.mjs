/* tools/lint.mjs —— 本项目的 linter 入口（无第三方依赖）
 *
 * 为什么手写而不是装 eslint：
 *   ① 本项目零运行时依赖，加 eslint 会引入 100+ 个包和 lockfile，与"数据/工具全本地"的
 *      取舍冲突；② 真正要守的规则只有 4 条，都是本仓血泪换来的，eslint 默认规则覆盖不到。
 *
 * 检查四项（任一不过 → 退出码 1）：
 *   L1 语法：所有 .js/.mjs/.cjs 必须能被 Node 解析（`node --check`）
 *   L2 本机路径：源码里不许出现写死的盘符绝对路径（D:\ / C:\Users\ ...）
 *   L3 行尾空白：源码行尾不许有空格/制表符
 *   L4 调试残留：源码里不许留 console.log（测试与 tools 例外）
 *
 * 用法：node tools\lint.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const SELF = path.relative(ROOT, import.meta.url.replace('file:///', '').replace(/\//g, path.sep));

const SKIP_DIRS = new Set(['.git', 'vendor', 'node_modules', 'release', '_probe', '归档', 'tests\\out', 'tests/out']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs']);

let scanned = 0;
const problems = { L1: [], L2: [], L3: [], L4: [] };

/* 递归收集源码文件 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(rel)) continue;
      walk(full, out);
    } else if (CODE_EXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

/* 判断是否属于"允许有绝对路径"的目录。
 * tests/ 与 tools/ 例外，理由：
 *   - tests/portability.cjs 的正样本本身就是这类内部根名字符串；
 *   - tests/ 里有若干阴性对照需要构造非法路径；
 *   - tools/ 的 CLI 帮助文本要告诉用户路径怎么写。
 * 注意：例外只针对 L2/L4，L1 语法与 L3 行尾空白对所有文件一视同仁。 */
function isExempt(rel) {
  const p = rel.split(path.sep).join('/');
  /* scripts/ 同样例外（2026-10-24）：make-demo-lib / make-doc-shots 等是一次性 CLI 工具，
     console.log 就是它的产品输出（与 tools/ 同理）。 */
  return p.startsWith('tests/') || p.startsWith('tools/') || p.startsWith('scripts/') || p === SELF.split(path.sep).join('/');
}

/* console.log 只允许出现在"给终端用户看的 CLI 工具"里。
 * src/tools/ 是命令行工具，打印就是它的功能；src/app/js/ 是浏览器端，
 * 那里出现 console.log 才是调试残留。 */
function consoleAllowed(rel) {
  const p = rel.split(path.sep).join('/');
  return p.startsWith('src/tools/') || p.startsWith('tests/') || p.startsWith('tools/') || p.startsWith('scripts/')
      || p === SELF.split(path.sep).join('/');
}

const files = walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'tools')));
// scripts/ 是 PowerShell，另算；这里只审 JS 侧
for (const d of ['tests', 'scripts']) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walk(full, files);
}

/* 绝对路径正则。
 * 两个必须的守卫（都是 2026-10-24 审计实证踩出来的，见 DEFECT-REGISTRY D-034 / D-043）：
 *   ① 左边界不能是标识符字符 —— 否则 object 属性 `key:/re/` 里的 `y:/re/` 会被当成 Y 盘。
 *   ② 盘符只认【大写】—— 否则 JS 正则转义 `[\s:\-]` 里的 `s:\-`、`max-width:\s*` 里的
 *      `h:\s` 会被当成 S 盘 / H 盘路径。本机所有真实盘符路径都是大写（C: D: E:）。
 *      代价：小写 `d:\foo` 会漏检。这个代价是刻意的——宁可漏一个，不要每轮几十个假阳
 *      把真问题埋掉（"恒红的检查等于没有检查"，教训 D-040）。 */
const PATH_RE = /(?<![A-Za-z0-9_])[A-Z]:\\[^\\/:*?"<>|\r\n]{1,}|(?<![A-Za-z0-9_])[A-Z]:\/(?!\/)[^/:*?"<>|\r\n]{1,}/g;
const URL_RE = /[A-Za-z]+:\/\//g;

for (const full of files) {
  const rel = path.relative(ROOT, full);
  const src = fs.readFileSync(full, 'utf8');
  scanned++;

  // L1 语法
  const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' | ');
    problems.L1.push(`${rel}: ${msg}`);
  }

  const lines = src.split(/\r?\n/);
  let inBlock = false;
  lines.forEach((line, i) => {
    const ln = i + 1;
    const trimmed = line.trim();
    // 块注释状态机：同一行里先看开闭，再判断本行性质
    const opens = /\/\*/.test(line);
    const closes = /\*\//.test(line);
    const wasInBlock = inBlock;
    if (opens && !closes) inBlock = true;
    else if (closes) inBlock = false;
    const isComment = wasInBlock || inBlock
      || /^(\/\/|\*|\/\*|<!--)/.test(trimmed);

    // L2 本机绝对路径（只判可执行行）
    if (!isExempt(rel) && !isComment) {
      // 先剥行尾 // 注释：`p = '/' + p;   // D:/a → /D:/a` 里的 D:/a 是注释，不是代码。
      // 误伤代价：字符串里出现 // 会被截断 → 少报，不会多报。宁可漏，不可每日几十个假阳。
      const noUrl = line.replace(URL_RE, 'URL ');
      const codeOnly = noUrl.replace(/\s*\/\/.*$/, '');
      const m = codeOnly.match(PATH_RE);
      if (m) problems.L2.push(`${rel}:${ln}  ${m[0]}`);
    }
    // L3 行尾空白
    if (/[ \t]+$/.test(line)) problems.L3.push(`${rel}:${ln}`);
    // L4 调试残留
    if (!consoleAllowed(rel) && !isComment && /(^|[^.\w])console\.log\s*\(/.test(line)) {
      problems.L4.push(`${rel}:${ln}`);
    }
  });
}

/* 汇总输出 */
const total = problems.L1.length + problems.L2.length + problems.L3.length + problems.L4.length;
const LABEL = {
  L1: '语法错误',
  L2: '写死的本机绝对路径',
  L3: '行尾空白',
  L4: '调试残留 console.log',
};

for (const k of ['L1', 'L2', 'L3', 'L4']) {
  const list = problems[k];
  if (list.length === 0) continue;
  console.log(`\n[${k}] ${LABEL[k]} —— ${list.length} 处`);
  const show = VERBOSE ? list : list.slice(0, 10);
  show.forEach((x) => console.log('   ' + x));
  if (!VERBOSE && list.length > show.length) {
    console.log(`   …另有 ${list.length - show.length} 处，加 --verbose 看全部`);
  }
}

console.log(`\nlint: 扫描 ${scanned} 个 JS 文件，问题 ${total} 处`);
if (total === 0) {
  console.log('LINT=PASS');
  process.exit(0);
} else {
  console.log('LINT=FAIL');
  process.exit(1);
}
