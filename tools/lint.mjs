/* tools/lint.mjs —— 本项目的 linter 入口（无第三方依赖）
 *
 * 为什么手写而不是装 eslint：
 *   ① 本项目零运行时依赖，加 eslint 会引入 100+ 个包和 lockfile，与"数据/工具全本地"的
 *      取舍冲突；② 真正要守的规则只有 4 条，都是本仓血泪换来的，eslint 默认规则覆盖不到。
 *
 * 检查八项（任一不过 → 退出码 1）：
 *   L1 语法：所有 .js/.mjs/.cjs 必须能被 Node 解析（`node --check`）
 *   L2 本机路径：源码里不许出现写死的盘符绝对路径（D:\ / C:\Users\ ...）
 *   L3 行尾空白：源码行尾不许有空格/制表符
 *   L4 调试残留：源码里不许留 console.log（测试与 tools 例外）
 *   L5 文件编码（2026-10-29 R2 新增）：`*.ps1`/`*.psm1` 必须 **UTF-8 带 BOM**
 *      （PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解码 ⇒ 中文乱码 + 假语法错）；其余文本文件必须
 *      **UTF-8 无 BOM**；**UTF-16（LE/BE）一律拒绝**——它会被 git 当二进制，而 `.gitattributes`
 *      的 `text eol=crlf` 会往 UTF-16 码流里插游离 0D，造成"新克隆脚本语法错、本机永远看不见"。
 *   L6 换行符（2026-10-29 R2 新增）：工作区字节必须与 `.gitattributes` 声明一致
 *      （`*.ps1`/`*.psm1`/`*.bat`/`*.cmd` = CRLF，其余文本 = LF）。
 *   L7 CHANGELOG 逐版格式（2026-10-29 R2 新增）：每个 `## [版本]` 条目必须同时有
 *      `**变更分类**：…`（取值只能是 Added/Changed/Fixed/Removed/Security/Deprecated 的组合，
 *      用 ` / ` 分隔）与 `**升级影响**：…` 行（或等价的 `### 升级影响` 小节）。
 *   L8 端口真源唯一（2026-10-29 R2 新增 / SC-09）：`src/**` 的 `.js/.mjs/.cjs/.cs` 里
 *      **可执行代码**不许出现端口字面量 `7187`（注释里可以）——端口唯一真源是
 *      `src\app\端口.json` 的 `default`，三端（C# 壳 / 前端 / Node 服务端）都从它取。
 *      "5 处各写一份默认值"正是 SC-09 那条缺陷的根因。
 *   ⚠ L5/L6 的清单口径是 **tracked + 未忽略的新增**（`git ls-files -co --exclude-standard`）：
 *     "还没 commit 的新文件"也要当场拦住，否则违规会一直活到提交那一刻。git 不可用时退化为遍历。
 *
 * 用法：node tools\lint.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const SELF = path.relative(ROOT, import.meta.url.replace('file:///', '').replace(/\//g, path.sep));

const SKIP_DIRS = new Set(['.git', 'vendor', 'node_modules', 'release', '_probe', '归档', 'tests\\out', 'tests/out']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs']);

let scanned = 0;
const problems = { L1: [], L2: [], L3: [], L4: [], L5: [], L6: [], L7: [], L8: [] };

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

/* ══════════════════════════════════════════════════════════════════════════
   L5 文件编码 / L6 换行符（2026-10-29 R2 新增）
   为什么单独成节：这两条判据来自本仓红线 7（编码与换行**按类型分**）+ `.gitattributes`，
   而且必须按**工作区字节**判 —— PS 5.1 与 git 读的都是工作区那一份，不是索引里那份。
   ⚠ 判据的唯一真源是 `.gitattributes`：L6 的期望换行**从它解析**，不在这里另抄一份词表
     （另一份词表必然漂移，见本仓 L-286）。
   真实事故背景：`build-release.ps1`/`deploy.ps1` 曾整份是 UTF-16LE，而 `.gitattributes` 的
   `text eol=crlf` 往 UTF-16 码流里插游离 0D ⇒ 新克隆拿到的脚本语法错、本机永远看不见。
   ══════════════════════════════════════════════════════════════════════════ */
const BIN_DEFAULT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.dll', '.exe', '.nupkg']);
/* 编码契约（与 AGENTS.md 红线 7 逐字对应）：*.ps1/*.psm1 = UTF-8 **带** BOM；其余列出的文本 = UTF-8 **无** BOM */
const ENC_BOM_REQUIRED = new Set(['.ps1', '.psm1']);
const ENC_PLAIN_UTF8 = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.htm', '.css', '.yml', '.yaml']);
const ENC_LABEL = { utf8bom: 'UTF-8 带 BOM', utf8: 'UTF-8 无 BOM' };

function parseGitattributes() {
  const p = path.join(ROOT, '.gitattributes');
  const res = { eol: new Map(), binary: new Set(), defEol: 'lf', present: fs.existsSync(p) };
  if (!res.present) return res;
  for (const raw of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    const pat = parts[0];
    if (pat === '*') { const m = /eol=(crlf|lf)/.exec(t); if (m) res.defEol = m[1]; continue; }   // 默认行：* text=auto eol=lf
    if (!pat.startsWith('*.')) continue;
    const ext = pat.slice(1).toLowerCase();
    if (parts.includes('binary') || parts.includes('-text')) { res.binary.add(ext); continue; }
    const m = /eol=(crlf|lf)/.exec(t);
    if (m) res.eol.set(ext, m[1]);
  }
  return res;
}
const GA = parseGitattributes();

/* 清单口径：tracked + 未忽略的新增。为什么不用纯文件系统遍历：
   "还没 commit 的新文件"正是最需要当场拦住的那一类（违规活到提交那一刻就晚了）。 */
function listVersionedFiles() {
  try {
    const out = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', '-co', '--exclude-standard'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { files: out.split('\u0000').filter(Boolean), source: 'git ls-files -z -co --exclude-standard' };
  } catch (e) {
    /* ⚠ stdio 必须显式给 ['ignore','pipe','pipe']：否则 execFileSync 会把子进程 stderr **直接透到
       控制台**，在非 git 目录下打出一行刺眼的 `fatal: not a git repository`（实测），
       而真正的信息（"退化为遍历"）反而被淹没。 */
    const why = String((e && (e.stderr || e.message)) || e).split('\n')[0].trim();
    const files = [];
    (function walkAll(dir) {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        const full = path.join(dir, ent.name);
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        if (ent.isDirectory()) { if (SKIP_DIRS.has(ent.name) || SKIP_DIRS.has(rel)) continue; walkAll(full); }
        else files.push(rel);
      }
    })(ROOT);
    return { files, source: '文件系统遍历（git 不可用：' + why + '）' };
  }
}
function detectEncoding(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'UTF-16LE(BOM)';
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'UTF-16BE(BOM)';
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'UTF-8(BOM)';
  const head = buf.subarray(0, 4096);
  let nuls = 0;
  for (const b of head) if (b === 0) nuls++;
  if (nuls >= 2) return 'UTF-16(无 BOM，含 NUL 字节)/二进制';
  return 'UTF-8(无 BOM)';
}
function detectEol(buf) {
  const s = buf.toString('latin1');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length - crlf;
  if (crlf && lf) return 'MIXED';
  if (crlf) return 'CRLF';
  if (lf) return 'LF';
  return 'NONE';   // 空文件 / 整份没有任何换行：两种期望都成立，不判违规
}
const VER = listVersionedFiles();
let encChecked = 0, eolChecked = 0;
for (const rel of VER.files) {
  const ext = path.extname(rel).toLowerCase();
  if (GA.binary.has(ext) || BIN_DEFAULT.has(ext)) continue;      // 二进制：本检查不管
  let buf; try { buf = fs.readFileSync(path.join(ROOT, rel)); } catch { continue; }   // 已删除/不可读：不归本检查
  const actualEnc = detectEncoding(buf);
  const wantEnc = ENC_BOM_REQUIRED.has(ext) ? 'utf8bom' : (ENC_PLAIN_UTF8.has(ext) ? 'utf8' : null);
  if (wantEnc) {
    encChecked++;
    const isUtf16 = actualEnc.startsWith('UTF-16');
    const ok = !isUtf16 && (wantEnc === 'utf8bom' ? actualEnc === 'UTF-8(BOM)' : actualEnc === 'UTF-8(无 BOM)');
    if (!ok) {
      problems.L5.push(`${rel}  实际：${actualEnc} ｜ 期望：${ENC_LABEL[wantEnc]}` +
        (isUtf16 ? '（禁止 UTF-16：git 会当二进制，且 eol=crlf 会往码流里插游离 0D ⇒ 新克隆语法错）' : '') +
        ` ｜ 复核：git ls-files --eol -- "${rel}"`);
    }
  }
  const wantEol = (GA.eol.get(ext) || GA.defEol).toUpperCase();
  const actualEol = detectEol(buf);
  eolChecked++;
  if (actualEol !== 'NONE' && actualEol !== wantEol) {
    problems.L6.push(`${rel}  实际：${actualEol} ｜ 期望：${wantEol}` +
      `（.gitattributes：${ext || '(无扩展名)'} → eol=${wantEol.toLowerCase()}）` +
      ` ｜ 复核：git ls-files --eol -- "${rel}"`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   L8 端口真源唯一（2026-10-29 R2 / SC-09）
   端口只有一个真源：`src\app\端口.json` 的 `default`（C# 壳 `ResolveSrvPort`、前端
   `window.__ctbPortDefault`/hello 回执、Node 服务端 `resolvePort()` 三端都从它取）。
   缺陷原形正是"5 处各写一份默认 7187，改端口要动 5 个文件" ⇒ 这里把它变成机检：
   `src/**` 的 `.js/.mjs/.cjs/.cs` 里出现 `7187` 且**该行是可执行代码**（不在注释里）即报红。
   为什么要字符串感知地剥注释，而不是套 L2 那句 `/\s*\/\/.*$/`：
     · 该口径会把 `const u = 'http://127.0.0.1:7187';` 里的 `//` 当注释起点截断 ⇒ **漏报**；
       而这一条恰恰是"写死端口"最可能的形态，漏了等于没查。
   ══════════════════════════════════════════════════════════════════════════ */
const PORT_LITERAL_EXT = new Set(['.js', '.mjs', '.cjs', '.cs']);
const PORT_TRUTH_SRC = 'src/app/端口.json';
/** 字符串感知地剥掉行尾 `//` 注释（`'`/`"`/`` ` `` 三种引号 + 反斜杠转义） */
function stripLineComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}
/* 剥掉行内 `/* … *\/` 片段；若开了块注释没在本行闭合，就丢到行尾（跨行状态由调用方的状态机管） */
function stripInlineBlock(line) {
  let s = line.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const open = s.indexOf('/*');
  if (open >= 0) s = s.slice(0, open);
  return s;
}
let portScanned = 0;
for (const rel of VER.files) {
  const ext = path.extname(rel).toLowerCase();
  if (!rel.startsWith('src/') || !PORT_LITERAL_EXT.has(ext)) continue;
  portScanned++;
  let src; try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  const lines = src.replace(/^\uFEFF/, '').split(/\r?\n/);
  let inBlock = false;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const opens = /\/\*/.test(line), closes = /\*\//.test(line);
    const wasInBlock = inBlock;
    if (opens && !closes) inBlock = true;
    else if (closes) inBlock = false;
    const wholeLineComment = wasInBlock || inBlock || /^(\/\/|\*|\/\*)/.test(trimmed);
    if (wholeLineComment) return;
    const code = stripInlineBlock(stripLineComment(line));
    if (!/\b7187\b/.test(code)) return;
    problems.L8.push(`${rel}:${i + 1}  原文：${trimmed.slice(0, 110)}` +
      ` ｜ 期望：这些行不许出现端口字面量 —— 端口唯一真源是 ${PORT_TRUTH_SRC} 的 default（C# 壳 / 前端 / Node 服务端都从它取）` +
      ` ｜ 复核：git grep -n "7187" -- src`);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   L7 CHANGELOG 逐版格式（2026-10-29 R2 新增）
   每个 `## [版本]` 条目开头两行是**机器可校验的必填字段**（见 CHANGELOG.md 自己的说明）：
     `**变更分类**：…` 取值只能是六类词表的组合，用 ` / ` 分隔；
     `**升级影响**：…`（或等价的 `### 升级影响` 小节——两种形式历史上都出现过，都要认）。
   为什么必须机械校验：这两行是"这次改动对用户/升级者意味着什么"的唯一入口，
   漏了不会让任何功能变坏，只会让下一个人看不懂该不该升级 —— 纯人工约定必然漂移。
   ══════════════════════════════════════════════════════════════════════════ */
const CATEGORIES = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Deprecated'];
const CL_FILE = path.join(ROOT, 'CHANGELOG.md');
let clEntries = 0;
if (fs.existsSync(CL_FILE)) {
  const lines = fs.readFileSync(CL_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => { if (/^##\s+\[/.test(l)) heads.push(i); });
  clEntries = heads.length;
  if (!heads.length) problems.L7.push('CHANGELOG.md  一个 `## [版本]` 条目都没有 —— 这条断言等于没生效（文件被改坏了？）');
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const body = lines.slice(h + 1, end);
    const who = 'CHANGELOG.md ' + lines[h].replace(/^##\s*/, '').slice(0, 56);
    const clsLine = body.find(x => /^\*\*变更分类\*\*\s*[：:]/.test(x));
    if (!clsLine) {
      problems.L7.push(`${who}  缺 \`**变更分类**：…\` 行 ｜ 期望：${CATEGORIES.join(' / ')} 的组合（用 " / " 分隔）`);
    } else {
      const val = clsLine.replace(/^\*\*变更分类\*\*\s*[：:]\s*/, '').trim();
      const parts = val.split(' / ');
      const bad = parts.filter(p => !CATEGORIES.includes(p));
      if (!val) problems.L7.push(`${who}  \`**变更分类**\` 取值为空 ｜ 期望：${CATEGORIES.join(' / ')} 的组合`);
      else if (bad.length) problems.L7.push(`${who}  \`**变更分类**\` 出现词表外的取值 ${bad.map(x => JSON.stringify(x)).join('、')} ｜ 期望：${CATEGORIES.join(' / ')} 的组合（用 " / " 分隔）；原值：${JSON.stringify(val)}`);
    }
    const hasImp = body.some(x => /^\*\*升级影响\*\*\s*[：:]/.test(x)) || body.some(x => /^###\s*升级影响/.test(x));
    if (!hasImp) problems.L7.push(`${who}  缺 \`**升级影响**：…\` 行（或等价的 \`### 升级影响\` 小节）`);
  });
} else {
  problems.L7.push('CHANGELOG.md 不存在 —— 逐版格式断言无法生效');
}

/* 汇总输出 */
const KEYS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
const total = KEYS.reduce((n, k) => n + problems[k].length, 0);
const LABEL = {
  L1: '语法错误',
  L2: '写死的本机绝对路径',
  L3: '行尾空白',
  L4: '调试残留 console.log',
  L5: '文件编码不合规',
  L6: '换行符不合规（工作区字节 vs .gitattributes）',
  L7: 'CHANGELOG 逐版字段不合规',
  L8: '端口字面量（端口真源之外写死端口）',
};

console.log(`L5/L6 清单来源：${VER.source}（${VER.files.length} 个文件；编码检查 ${encChecked} 个、换行检查 ${eolChecked} 个）`);
console.log(`L7 CHANGELOG 版本条目：${clEntries} 个`);
console.log(`L8 端口字面量扫描：${portScanned} 个 src/** 源码文件（真源：${PORT_TRUTH_SRC}）`);

for (const k of KEYS) {
  const list = problems[k];
  if (list.length === 0) continue;
  console.log(`\n[${k}] ${LABEL[k]} —— ${list.length} 处`);
  const show = VERBOSE ? list : list.slice(0, 10);
  show.forEach((x) => console.log('   ' + x));
  if (!VERBOSE && list.length > show.length) {
    console.log(`   …另有 ${list.length - show.length} 处，加 --verbose 看全部`);
  }
}

console.log(`\nlint: 扫描 ${scanned} 个 JS 文件、${VER.files.length} 个版本化文件（编码/换行）、${clEntries} 个 CHANGELOG 版本条目、${portScanned} 个端口字面量扫描点，问题 ${total} 处`);
if (total === 0) {
  console.log('LINT=PASS');
  process.exit(0);
} else {
  console.log('LINT=FAIL');
  process.exit(1);
}
