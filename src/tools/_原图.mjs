#!/usr/bin/env node
/**
 * 拾光小册 · 原图保全库（内容寻址，只增不改）
 *
 * ══ 为什么存在（2026-10-31）══
 * 用户定的铁律：**原图是唯一不可复现的数据，是核心。**
 * 实测（2026-10-31 全库扫描）却显示它没有统一的家：
 *   · 同一个影像的"身份"是 `_原卷台账.json` 里的**路径字符串**（page / import）；
 *   · 实测同一张照片在台账里同时出现「收件箱原名」与「原卷库改名后」两套路径（sha 相同），
 *     只认路径的判据在 256 张里漏判 4 张，用户当场复报"这些照片我们都处理过了呀"；
 *   · `_页码映射.json` 的 en 段有 7 条指向**根本不存在的**文件，而真实字节还躺在收件箱里没改名。
 *   ⇒ 结论：**路径不是身份，内容才是。**
 *
 * 本工具提供一层与业务目录解耦的保全库：
 *
 *   数据\_原图\<sha256 前 2 位>\<sha256>.<原扩展名>
 *   数据\_原图台账.json        sha → {字节数, 扩展名, 首次入库时间, 来源路径, 原名}
 *
 * 三条不变量（违反即报错，绝不"猜一个分支继续跑"）：
 *   ① **只增不改**：已存在的对象内容不一致时**报错退出，绝不覆盖**（那是哈希碰撞或磁盘损坏，
 *      都轮不到"顺手覆盖一下"来处理）。
 *   ② **永不删除源文件**。入库只复制。清理是另一件事，必须单独批准。
 *   ③ **落盘后逐字节复核**：写完立刻重读目标算 sha256，对不上就删掉目标并报错。
 *      （这一步是必需的，不是保险丝：源文件可能在"算哈希"与"复制"之间被改名/覆盖，
 *        只有事后复核才能发现。实测场景见下方 ingestOne 的注释。）
 *
 * 用法：
 *   node _原图.mjs 入库 <文件或目录...> [--batch "批次名"] [--student X] [--subject Y] [--dry]
 *   node _原图.mjs 入库 --scan [--dry]  # 扫全库，把"应保全"的文件全部入库（见 scanLibrary 的判据）
 *   node _原图.mjs 校验 [--json]        # 逐字节核对每个登记对象；报告孤儿文件；有错 exit 1
 *   node _原图.mjs 核对 --from <备份根> [--json]
 *                                      # ★ 只读：备份 ↔ 库 ↔ 台账三方逐字节对账；有差异 exit 1
 *   node _原图.mjs 名册 [--list] [--json]
 *   node _原图.mjs 快照                 # 写一份 sha 清单（不是字节副本，见下）
 *   node _原图.mjs 快照 --list
 *   node _原图.mjs 快照 --diff <清单名>  # ★ 对照：哪些 sha 从库里"非正常消失"了
 *
 * ══ 快照为什么只存清单、不存字节（以及它**不**能替代什么）══
 * 能这么做的唯一理由是**不变量①**：对象永不被改写 ⇒ "某时刻的库" == "那一刻的 sha 清单"。
 * **但它不能替代字节备份。** 清单只能证明"丢了什么"，不能把字节变回来。
 * 所以本工具的前提是（P10 口径）：**保全家 `_原图\` 就是"那一份备份"** ——
 *   库外再放一份 `_原图\` 的副本（`核对 --from` / `恢复 --from` 认它）才是"防盘坏"的那一份；
 *   `_影像备份\`（按路径镜像）已于 2026-11-06 按 P10 退休，不再是本工具的前提。
 * **清单是护栏，不是备份。**
 * 而且库写锁只约束"愿意配合的程序"，挡不住资源管理器删除、磁盘位损坏、绕开工具的脚本 ——
 * 所以 `快照 --diff` 的意义正是：事后能**精确定位**是哪几个对象没了。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { libraryRoot } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic, acquireLibLock } from './_安全写.mjs';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';

const ROOT = libraryRoot();
const STORE = path.join(ROOT, '_原图');
const LEDGER = path.join(ROOT, '_原图台账.json');
const SNAP_DIR = path.join(STORE, '_快照');
const [cmd, ...rest] = process.argv.slice(2);
/* ★ 2026-11-05（PR #13 二次复审 ①）：修前 DRY/JSON 是 `process.argv.includes('--dry')` 精确匹配 ——
   `--dryy` 拼错、`--dry=true` 都不命中 ⇒ 用户以为预演、实际真写盘（与 _录题入库 修前同款）。
   现在入口先以**严格模式**整体解析一遍：拼错/未知开关当场报错、零写盘；DRY/JSON 读解析结果。 */
const ORIG_VALUE_OPTS = ['batch', 'student', 'subject', 'diff', 'from', 'sha', 'derived-from', 'op', 'file', 'note'];
const ORIG_BOOL_OPTS = ['dry', 'json', 'list', 'scan', 'help', 'h'];
let GLOBAL_OPT;
try { GLOBAL_OPT = parseArgs(rest, { valueFlags: [...ORIG_VALUE_OPTS, ...COMMON_VALUE_FLAGS], boolFlags: ORIG_BOOL_OPTS, start: 0 }).opt; }
catch (e) { console.error('✖ ' + e.message); process.exit(1); }
const JSON_OUT = GLOBAL_OPT.json === true;
const DRY = GLOBAL_OPT.dry === true;

/* 持锁：本工具是"读台账 → 改内存 → 写回"的模式，没有锁时与其它写入口并发会丢更新。
   ⚠ 例外：**只读子命令不取锁**。取锁本身虽然只写系统临时目录（`_安全写.mjs` 的 stateDirOf），
   但取到之后 `recoverTransactions()` 会顺带回滚上一次没做完的写事务 —— 那是对库的写入。
   `核对` 承诺"库 / 备份根 / 台账一个字节都不动"，就不能有任何这类副作用，
   否则"只读"只是口号（本仓 2026-11-02 刚因为"只读命令往真库写文件"判过一次红）。 */
const READONLY_CMDS = new Set(['核对']);
const release = READONLY_CMDS.has(cmd) ? () => { } : acquireLibLock(ROOT, { label: '_原图' });
process.on('exit', release);

/* ── 小工具 ───────────────────────────────────────────── */
const say = (s) => { if (!JSON_OUT) console.log(s); };
const fail = (s) => { console.error('✖ ' + s); process.exit(1); };

/** 流式算 sha256（不整文件读进内存；原图里有 2MB+ 的页，也有将来的大 PDF）。 */
function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex').toUpperCase();
}
const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();

/** 目标扩展名：**保留原格式**，绝不改成 .jpg 冒充转换。未知/无扩展名一律 .bin。 */
function extOf(name) {
  const e = path.extname(String(name)).toLowerCase().replace(/^\./, '');
  return /^[a-z0-9]{1,8}$/.test(e) ? e : 'bin';
}
/** 对象在库里的相对路径（分桶 = sha 前 2 位小写） */
function objectRel(sha, ext) {
  return path.join(sha.slice(0, 2).toLowerCase(), sha.toLowerCase() + '.' + ext);
}
/** 找已存在的对象（sha 相同但扩展名可能不同 —— 内容寻址下同一 sha 只该有一份） */
function findObject(sha) {
  const dir = path.join(STORE, sha.slice(0, 2).toLowerCase());
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const base = sha.toLowerCase();
  for (const n of names) {
    if (n === base + '.tmp') continue;
    const m = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(n);
    if (m && m[1] === base) return path.join(dir, n);
  }
  return null;
}

function walkFiles(target, out = []) {
  let st;
  try { st = fs.statSync(target); } catch { return out; }
  if (st.isFile()) { out.push(target); return out; }
  if (!st.isDirectory()) return out;
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
    const p = path.join(target, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return { version: 1, note: '原图保全库台账：sha256 → 对象元数据。只增不改。', objects: {} };
  const j = readJsonStrict(LEDGER, {
    shape: (x) => x && typeof x.objects === 'object' && x.objects !== null && !Array.isArray(x.objects),
    what: 'objects 对象',
    label: '_原图台账.json',
  });
  return j;
}
/**
 * 落台账。★ 2026-11-03：**默认必须留 `_备份-真源\` 副本**（改前是 `backup: false`，且一字解释都没有）。
 *
 * 为什么它是①真源、必须有显式备份：台账记的是 `sha256 → {bytes, ext, addedAt, sources, names}`。
 * 丢了以后，**扫 `_原图\` 只能复原对象本身**（内容寻址，文件名就是 sha），
 * **`sources` / `names` 复原不出来** —— 而"台账里那条路径 → 是哪个对象"正是
 * `_原图寻址.mjs` 兜底寻址链的另一半（真库实测有 460 条卡靠这条链从保全库按内容找回）。
 * 实测改前的处境：真库 `_备份-真源\` 下 `*原图台账*` 副本 **0 份**，而工作区那份比 HEAD 新
 * （292,865 B vs 303,986 B）⇒ 所谓"还有 git 恢复点"其实只是**一个提交前的旧版本**。
 *
 * ⚠ 但**不是每次写都留**（这才是当初写 `false` 的合理内核，不能一并丢掉）：
 * 一轮 `入库 --scan` 会写 20+ 次（每 50 个文件一次检查点 + 收尾一次），
 * 若每次都备份，`backupJson` 的 keep=8 会被**同一轮运行**的 8 个快照灌满，
 * 反而把**入库前**那份恢复点挤掉。所以：默认 `backup: true`（收尾那次留一份），
 * 中间检查点显式传 `{ backup: false }`。语义 = **每轮入库恰好一个恢复点**，
 * keep=8 ⇒ 最近 8 轮，与其它真源"每次真实提交一份"完全一致。
 * 体积：真库台账约 300 KB × 8 ≈ 2.4 MB，可接受。
 */
function saveLedger(doc, { backup = true } = {}) {
  doc.generatedAt = new Date().toISOString();
  writeJsonAtomic(LEDGER, doc, { backup, indent: 1 });
}
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/* 参数解析：★ 2026-11-05（外部复核实测 N2）：迁移到**唯一实现** `_参数.mjs`。
   本文件原先自带一份 VALUE_OPTS + parseArgs —— 与旧解析器同病："下一个参数像不像 flag
   决定它是不是值" ⇒ 值以 `--` 开头会被解析成另一个开关（M1 同族，见 _参数.mjs 头部）。
   迁移后：已知带值 flag 无条件消费下一个参数（哪怕长得像 flag）。
   ⚠ 本文件没有动作名参数（argv[0] 就是子命令，已在上面 `const [cmd, …rest]` 拆出），
   解析 rest ⇒ start=0（无动作名槽）；带值表 = 本文件专属 VALUE_OPTS + COMMON_VALUE_FLAGS。 */
const parseArgsLocal = (argv) => parseArgs(argv, { valueFlags: [...ORIG_VALUE_OPTS, ...COMMON_VALUE_FLAGS], boolFlags: ORIG_BOOL_OPTS, start: 0 });

/* 清理上次崩溃留下的 .tmp（>5 分钟的）。持锁期间不会有别的入库在写。 */
function sweepTmp() {
  let n = 0;
  const now = Date.now();
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_快照') walk(p); continue; }
      if (e.name.endsWith('.tmp')) {
        try { if (now - fs.statSync(p).mtimeMs > 5 * 60000) { fs.unlinkSync(p); n++; } } catch { }
      }
    }
  };
  if (fs.existsSync(STORE)) walk(STORE);
  return n;
}

/* ══════════════ 入库 ══════════════ */
/**
 * 单个对象入库。返回 {status, sha, rel, bytes, error}。
 *
 * ⚠ 为什么落盘后必须重读复核（这不是多此一举）：
 *   设源路径原本装的是字节 A。我们算出 sha(A) 之后、复制之前，
 *   外部程序（同步盘、图片编辑器、另一个脚本、用户手工改名后在同名位置放了新文件）
 *   把该路径换成了字节 B。于是我们会把 B 复制成 `sha(A).jpg` ——
 *   名字说是 A，内容是 B。**这个错误一旦落盘就再也看不出来**，而且它会在去重时
 *   让"两个本该不同的对象"看起来相同。唯一的防线是写完立刻重读目标算哈希比对。
 *   对不上：删掉刚写的目标、报错、**保留源文件**。
 */
function ingestOne(src, meta) {
  let st;
  try { st = fs.statSync(src); } catch (e) { return { status: 'error', src, error: '读不到源文件：' + e.message }; }
  if (!st.isFile()) return { status: 'skip', src, error: '不是文件' };

  const h1 = sha256File(src);
  const ext = extOf(path.basename(src));
  const rel = objectRel(h1, ext);
  const dst = path.join(STORE, rel);

  /* 已存在 ⇒ 逐字节复核（不是比 size：同大小不同内容必须能查出来） */
  const existing = findObject(h1);
  if (existing) {
    const h2 = sha256File(existing);
    if (h2 === h1) {
      return { status: 'exists', src, sha: h1, rel: path.relative(STORE, existing), bytes: st.size };
    }
    return {
      status: 'error', src, sha: h1,
      error: `★ 库里已有同名对象但内容不同（${path.basename(existing)}）——` +
        `这是哈希碰撞或磁盘损坏，**拒绝覆盖**。请人工核查后再处理。`,
    };
  }

  if (DRY) return { status: 'dry', src, sha: h1, rel, bytes: st.size };

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.tmp';
  try {
    fs.copyFileSync(src, tmp);
    /* fsync：让"已 rename"真的意味着"已落盘"（copyFileSync 不保证） */
    let fd = null;
    try { fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd); } catch { } } finally { if (fd !== null) fs.closeSync(fd); }
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { }
    return { status: 'error', src, sha: h1, error: '复制失败（源文件未动）：' + e.message };
  }

  /* ★ 落盘后复核：目标字节必须等于我们算过的那个 sha */
  const h3 = sha256File(dst);
  const sz = fs.statSync(dst).size;
  if (h3 !== h1 || sz !== st.size) {
    try { fs.unlinkSync(dst); } catch { }
    return {
      status: 'error', src, sha: h1,
      error: `★ 落盘复核失败：源在复制期间被改动或磁盘出错（期望 ${h1.slice(0, 16)}/${st.size}B，` +
        `实得 ${h3.slice(0, 16)}/${sz}B）。已删除刚写的对象，**源文件保留**。请重跑。`,
    };
  }
  return { status: 'copy', src, sha: h1, rel, bytes: sz };
}

/** 库内**应保全**文件的判据（唯一实现）。
 *
 *  纳入：全部影像（jpg/png/pdf/webp/gif/bmp/tif），**以及 `_收件箱\` 下的所有文件**
 *        —— 那里除了照片还有 `_来源映射.csv`（页码/原文件名对应）与 `.md`（人工判读依据），
 *        它们**不能从任何原图推出**，实测在本机别处没有同字节副本，是最容易被"清空收件箱"
 *        顺手删掉的东西。
 *  排除：
 *    · `_crops\`、`tiles\` —— 由原图 + 裁切参数派生（本项目自己文档化的可重生成产物）
 *    · `_probe\` —— 探针；`_原图\` —— 库自己；`.git\`、`_快照\`
 *    · `_影像备份\` —— **已按 P10 删除**（2026-11-06）。这一条**只在过渡期有意义**：
 *      目录还在的那段时间里必须排除它，否则镜像副本会被当成"来源路径"写进 `sources`，
 *      等于给同一个字节记了第二个家（那正是 P10 要治的）。目录删掉之后它是无害的空配置；
 *      哪天有人把镜像重建回来，这一条会再次生效 —— 但那时 `_数据区门禁` 的 G6 会先判红（"出现即红"）。
 *
 *  ⚠ 刻意**不**排除 `组卷\*.pdf`：那是给人看的成品，不能仅凭"在组卷目录里"就宣布可重算。
 *  ⚠ 刻意**不**排除卡片目录里的 `原卷截图*.jpg`：实测它其实是"整页 + 红框"裁出来的那一块，
 *     有 box 也不等于能重建出同一份字节（源图版本、旋转、缩放、编码都可能不同）——
 *     给不可复现资产降级，不能只看一个字段齐不齐。 */
const SCAN_EXCLUDE_DIRS = new Set(['_crops', 'tiles', '_影像备份', '_probe', '_原图', '_快照', '.git', 'node_modules']);
const SCAN_IMG_RE = /\.(jpe?g|png|pdf|webp|gif|bmp|tiff?)$/i;
function scanLibrary(targets, out = []) {
  for (const dir of targets) {
    const walk = (d) => {
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        if (e.name.startsWith('.')) continue;
        if (e.name.endsWith('.tmp') || e.name.endsWith('.tmp-')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!SCAN_EXCLUDE_DIRS.has(e.name)) walk(p); continue; }
        const rel = path.relative(ROOT, p).split(path.sep).join('/');
        /* 收件箱下**所有**文件都保全（含 csv/md）；其余目录只保全影像 */
        if (rel.toLowerCase().startsWith('_收件箱/') || SCAN_IMG_RE.test(e.name)) out.push(p);
      }
    };
    walk(dir);
  }
  return out;
}

function cmdIngest(argv) {
  const { opt: opts, positional: paths } = parseArgsLocal(argv);
  if (opts.scan) {
    if (paths.length) fail('--scan 与显式路径不能同时给（--scan 会自己扫全库）。');
    paths.push(...scanLibrary([ROOT]));
  }
  if (!paths.length) fail('入库需要至少一个文件或目录。用法：node _原图.mjs 入库 <路径...> [--batch 名]');
  const batch = typeof opts.batch === 'string' ? opts.batch : null;
  const student = typeof opts.student === 'string' ? opts.student : null;
  const subject = typeof opts.subject === 'string' ? opts.subject : null;

  const files = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
    if (!fs.existsSync(abs)) fail('路径不存在：' + abs);
    walkFiles(abs, files);
  }
  if (!files.length) fail('这些路径下没有可入库的文件。');

  const swept = sweepTmp();
  say('【原图保全库 · 入库】' + (DRY ? '（--dry：不写盘）' : ''));
  say('  库根：' + STORE);
  say('  待处理：' + files.length + ' 个文件' + (swept ? '（清理上次残留 .tmp ' + swept + ' 个）' : ''));

  const doc = loadLedger();
  const tally = { copy: 0, exists: 0, dry: 0, skip: 0, error: 0 };
  const errors = [];
  let copiedBytes = 0;
  let processed = 0;

  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const r = ingestOne(f, { rel });
    processed++;
    if (r.status === 'error') { tally.error++; errors.push(r); }
    else { tally[r.status] = (tally[r.status] || 0) + 1; }

    if (r.sha && r.status !== 'error') {
      const o = doc.objects[r.sha] || { bytes: r.bytes, ext: extOf(path.basename(f)), addedAt: new Date().toISOString(), sources: [], names: [] };
      if (!o.sources.includes(rel)) o.sources.push(rel);
      const nm = path.basename(f);
      if (!o.names.includes(nm)) o.names.push(nm);
      if (batch && !o.batch) o.batch = batch;
      if (student && !o.student) o.student = student;
      if (subject && !o.subject) o.subject = subject;
      doc.objects[r.sha] = o;
      if (r.status === 'copy') copiedBytes += r.bytes;
    }
    /* 每 50 个落一次台账：中断后重跑是幂等的，不用从头再来。
       ⚠ 中间检查点**不留 `_备份-真源\` 副本**（`{ backup: false }`）：一轮入库会走到这里 20+ 次，
       每次留一份就会把 keep=8 灌满同一轮运行的快照、把入库前那份恢复点挤掉。
       恢复点由收尾那次（`saveLedger(doc)`，默认 true）产生 —— 每轮恰好一份。详见 saveLedger 的注释。 */
    if (!DRY && processed % 50 === 0) { saveLedger(doc, { backup: false }); say('  … 已处理 ' + processed + '/' + files.length); }
  }

  if (!DRY && (tally.copy || tally.exists)) saveLedger(doc);

  say('  新增 ' + tally.copy + ' ｜ 已存在（幂等跳过）' + tally.exists + ' ｜ 新增字节 ' + mb(copiedBytes));
  if (tally.skip) say('  跳过（不是文件）：' + tally.skip);
  say('  台账对象总数：' + Object.keys(doc.objects).length);
  for (const e of errors.slice(0, 20)) console.error('  ✖ ' + (e.src || '') + '：' + e.error);
  if (errors.length > 20) console.error('  … 另有 ' + (errors.length - 20) + ' 条错误');
  if (errors.length) {
    console.error('✖ 有 ' + errors.length + ' 个对象未入库。**源文件一个都没动**，修好后重跑即可（入库是幂等的）。');
    process.exit(1);
  }
  say('  ✅ 全部完成。源文件一个都没动（本工具只复制）。');
  return 0;
}

/* ══════════════ 校验 ══════════════ */
/* ══════════════ P10 判据 · 原图必须有两个家 ══════════════ */
/**
 * 用户 2026-11-06 定案 P10「一个字节一个家」的第一条机器判据（规范 §3.5）：
 *   **原图恰好两个家** —— 工作家（活路径）+ 保全家（`_原图\`，内容寻址）。
 *
 * 判据方向**只有一个**：活路径 → 保全库。
 *   活路径里有一张原图 ⇒ 保全库里必须有同 sha 对象；缺 = 红（"原图没保住"）。
 * 反方向**不判**：活路径被删而保全库还在 ⇒ 那是 P10 要保住的形态（`_原图\` 就是那一份备份），
 *   不是违规 —— 2026-11-05 那 52 张卡就是这么保住的。
 *
 * 工作家 = §3.5 第 1、2 行：`<小名>\原卷\**`、`<小名>\<学科>\原卷\**`、`_收件箱\**`（只算影像）。
 * ⚠ 这一步要**逐字节算 sha**（只 stat 证明不了"字节在保全库里"），真库约七百张、秒级；
 *   它是人工/发版前跑的体检命令，不在热路径上。
 */
const LIVE_ORIG_IMG_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
function studentDirs() {
  let es = [];
  try { es = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  return es.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.') && e.name !== '组卷')
    .map((e) => e.name);
}
function scanLiveOriginals() {
  const out = [];
  /* ⚠ 必须排除 `_crops\` / `tiles\`：§3.5 第 9 行把它们定义为"可重建派生"（允许任意份数），
     它们**不是原图** —— 首版漏了这条，真库实测把 `<小名>\原卷\_crops\*.png` 225 张报成"没保住"（假阳）。 */
  const SKIP = new Set(['_crops', 'tiles']);
  const collect = (dir) => {
    let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) collect(p); continue; }
      if (LIVE_ORIG_IMG_RE.test(e.name)) out.push(p);
    }
  };
  for (const s of studentDirs()) {
    const sDir = path.join(ROOT, s);
    collect(path.join(sDir, '原卷'));                                   // §3.5 第 1 行（跨学科合卷）
    let es = []; try { es = fs.readdirSync(sDir, { withFileTypes: true }); } catch { es = []; }
    for (const e of es) if (e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')) collect(path.join(sDir, e.name, '原卷'));   // 第 1 行（学科）
  }
  collect(path.join(ROOT, '_收件箱'));                                   // §3.5 第 2 行（导入原件）
  return out;
}

function cmdVerify() {
  const doc = loadLedger();
  const keys = Object.keys(doc.objects);
  const bad = [];
  let totalBytes = 0;
  const onDisk = new Set();

  for (const sha of keys) {
    const o = doc.objects[sha] || {};
    const f = findObject(sha);
    if (!f) { bad.push({ sha, why: '登记在台账里，但库内找不到对象' }); continue; }
    onDisk.add(path.basename(f).replace(/\.[a-z0-9]+$/i, '').toUpperCase());
    const h = sha256File(f);
    if (h !== sha) { bad.push({ sha, why: '★ 内容与登记的 sha 不符（实得 ' + h.slice(0, 16) + '…）：' + path.relative(STORE, f) }); continue; }
    const sz = fs.statSync(f).size;
    if (o.bytes != null && sz !== o.bytes) { bad.push({ sha, why: '字节数与台账不符（登记 ' + o.bytes + '，实得 ' + sz + '）' }); continue; }
    totalBytes += sz;
  }

  /* 孤儿：库里有文件但台账没登记（中断留下的、或绕过工具塞进来的） */
  const orphans = [];
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_快照') walk(p); continue; }
      if (e.name.endsWith('.tmp')) continue;
      const m = /^([0-9a-f]{64})\./i.exec(e.name);
      if (!m) { orphans.push(path.relative(STORE, p) + '（文件名不是 sha256）'); continue; }
      if (!onDisk.has(m[1].toUpperCase())) orphans.push(path.relative(STORE, p));
    }
  };
  if (fs.existsSync(STORE)) walk(STORE);

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: bad.length === 0, objects: keys.length, bytes: totalBytes, bad, orphans }, null, 1) + '\n');
  } else {
    say('【原图保全库 · 校验】');
    say('  台账登记：' + keys.length + ' 个对象，' + mb(totalBytes));
    say('  逐字节核对：通过 ' + (keys.length - bad.length) + ' ／ 异常 ' + bad.length);
    for (const b of bad.slice(0, 20)) say('  ✖ ' + b.sha.slice(0, 16) + '… ' + b.why);
    if (bad.length > 20) say('  … 另有 ' + (bad.length - 20) + ' 条');
    if (orphans.length) {
      say('  ⚠ 库内未登记文件 ' + orphans.length + ' 个（中断残留或绕过工具塞入；不自动删）：');
      for (const o of orphans.slice(0, 10)) say('      ' + o);
      if (orphans.length > 10) say('      … 另有 ' + (orphans.length - 10) + ' 个');
    }
    say('  边界：本命令只回答"库内对象字节对不对"（§3.5 第 3 行）。P10 的另两条判据是 `两个家`（原图两个家）与 `单份`（非原图影像单家）。');
  }
  if (bad.length) { console.error('✖ 有 ' + bad.length + ' 个对象校验失败 —— 先从库外 `_原图\\` 副本按 sha 找回（`恢复 --from`），再跑 `入库`。'); process.exit(1); }
  return 0;
}

/**
 * P10 判据 A：**原图必须有两个家**（活路径 → 保全库）。
 * 为什么做成独立子命令而不是塞进 `校验`：
 *   `校验` 的语义是"**库内**对象字节对不对"（§3.5 第 3 行），是发版/迁移的基线命令；
 *   这条判据查的是**活路径与保全库的关系**，会把"还有导入原件没入库"这类**存量欠账**一起报出来。
 *   把存量欠账混进基线命令的退出码，会让"摘掉一层死代码"这种改动看起来像"改了校验口径"。
 *   分开之后各说各的事，两条都能红、都有阴性对照（`tests\neg-p10-image-homes.cjs`）。
 */
function cmdTwoHomes() {
  const doc = loadLedger();
  const live = scanLiveOriginals();
  const unbacked = [];
  for (const f of live) {
    const sha = sha256File(f);
    if (!doc.objects[sha]) unbacked.push({ rel: path.relative(ROOT, f).split(path.sep).join('/'), sha });
  }
  const res = { ok: unbacked.length === 0, readOnly: true, liveOriginals: live.length, unbacked };
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(res, null, 1) + '\n');
  } else {
    say('【原图保全库 · 两个家】P10：原图恰好两个家（工作家 = 活路径，保全家 = `_原图\\`）');
    say('  活路径原图（`原卷\\` / `_收件箱\\`，已排除 `_crops\\`·`tiles\\` 这两个可重建派生）：' + live.length + ' 张');
    say('  其中**保全家没有同 sha 对象**的：' + unbacked.length + ' 张');
    for (const u of unbacked.slice(0, 20)) say('  ✖ 没保住：' + u.rel + '（sha ' + u.sha.slice(0, 16) + '…）');
    if (unbacked.length > 20) say('  … 另有 ' + (unbacked.length - 20) + ' 张');
  }
  if (unbacked.length) {
    console.error('✖ P10 违反：有 ' + unbacked.length + ' 张原图只有**一个家**（活路径在工作、保全库里没有同 sha 对象）⇒ 原图没保住。' +
      ' 怎么办：`node src\\tools\\_原图.mjs 入库 --scan`（按 §3.5 第 3 行把它们收进保全家）。');
    return 1;
  }
  say('  ✅ 每一张原图都有两个家。');
  return 0;
}

/* ══════════════ 名册 ══════════════ */
function cmdRoster(argv) {
  const { opt: opts } = parseArgsLocal(argv);
  const doc = loadLedger();
  const keys = Object.keys(doc.objects).sort();
  let bytes = 0;
  for (const k of keys) bytes += (doc.objects[k].bytes || 0);
  if (JSON_OUT) { process.stdout.write(JSON.stringify({ objects: keys.length, bytes, objectsMap: doc.objects }, null, 1) + '\n'); return 0; }
  say('【原图保全库 · 名册】' + STORE);
  say('  对象 ' + keys.length + ' 个，合计 ' + mb(bytes));
  if (opts.list) for (const k of keys) say('  ' + k + '  ' + kb(doc.objects[k].bytes || 0) + '  ' + (doc.objects[k].names || []).slice(0, 1).join(''));
  return 0;
}

/* ══════════════ 快照 ══════════════ */
/** 清单格式：首行 count=，其后每行 `SHA\t字节数\t相对路径`。纯文本、可 diff、可人工核对。 */
function snapName() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function readSnap(name) {
  const f = path.join(SNAP_DIR, name.endsWith('.list') ? name : name + '.list');
  const out = new Map();
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([0-9A-F]{64})\t(\d+)\t(.*)$/.exec(line);
    if (m) out.set(m[1], { bytes: +m[2], rel: m[3] });
  }
  return out;
}
/** 物理扫描库：sha → { rel, bytes }。**这是"库里实际有什么"的唯一判据。**
 *  ⚠ 为什么不能用台账代替它（实测踩过）：台账是元数据，删掉一个对象文件后台账**照旧记着它**。
 *  第一版 `快照 --diff` 拿台账当"现在"，于是删了一个对象它仍报"消失 0"——
 *  一个专门用来发现"对象非正常消失"的功能，恰好发现不了对象消失。 */
function scanStore() {
  const out = new Map();
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_快照') walk(p); continue; }
      if (e.name.endsWith('.tmp')) continue;
      const m = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/i.exec(e.name);
      if (!m) continue;
      try { out.set(m[1].toUpperCase(), { rel: path.relative(STORE, p).split(path.sep).join('/'), bytes: fs.statSync(p).size }); } catch { }
    }
  };
  if (fs.existsSync(STORE)) walk(STORE);
  return out;
}

function cmdSnapshot(argv) {
  const { opt: opts } = parseArgsLocal(argv);

  if (opts.list) {
    if (!fs.existsSync(SNAP_DIR)) { say('（还没有快照）'); return 0; }
    const names = fs.readdirSync(SNAP_DIR).filter((n) => n.endsWith('.list')).sort();
    say('【原图保全库 · 快照清单】共 ' + names.length + ' 份');
    for (const n of names) {
      let cnt = '?', bytes = 0;
      try { const m = readSnap(n); cnt = m.size; for (const v of m.values()) bytes += v.bytes; } catch { }
      say('  ' + n + '  ' + cnt + ' 个  ' + mb(bytes));
    }
    return 0;
  }

  const diffWith = typeof opts.diff === 'string' ? opts.diff : null;
  if (diffWith) {
    let old;
    try { old = readSnap(diffWith); } catch (e) { fail('读不到快照 ' + diffWith + '：' + e.message); }
    /* ★ 与**物理扫描**对照，不是与台账对照（理由见 scanStore 的注释） */
    const now = scanStore();
    const gone = [...old.keys()].filter((s) => !now.has(s));
    const added = [...now.keys()].filter((s) => !old.has(s));
    const resized = [...old.keys()].filter((s) => now.has(s) && now.get(s).bytes !== old.get(s).bytes);
    say('【原图保全库 · 快照对照】' + diffWith);
    say('  快照 ' + old.size + ' 个 → 库里现在 ' + now.size + ' 个；新增 ' + added.length +
      '，消失 ' + gone.length + '，字节数变化 ' + resized.length);
    if (resized.length) {
      console.error('✖ 有 ' + resized.length + ' 个对象**字节数变了**（内容被改写；只增不改变量被破坏）：');
      for (const s of resized.slice(0, 20)) console.error('    ' + s + '  快照 ' + old.get(s).bytes + 'B → 现在 ' + now.get(s).bytes + 'B');
      if (resized.length > 20) console.error('    … 另有 ' + (resized.length - 20) + ' 个');
    }
    if (gone.length) {
      console.error('✖ ★ 有 ' + gone.length + ' 个对象从库里**非正常消失**（只增不改变量被破坏）：');
      for (const s of gone.slice(0, 20)) console.error('    ' + s + '  ' + (old.get(s).rel || ''));
      if (gone.length > 20) console.error('    … 另有 ' + (gone.length - 20) + ' 个');
      console.error('  怎么办：从**库外 `_原图\\` 副本**按 sha 找回（`核对 --from` 验、`恢复 --from` 写回）。');
    }
    if (gone.length || resized.length) process.exit(1);
    say('  ✅ 快照里的对象一个都没少、字节数没变。');
    return 0;
  }

  const doc = loadLedger();
  const keys = Object.keys(doc.objects).sort();
  if (DRY) { say('（--dry）将写入 ' + keys.length + ' 个对象的清单'); return 0; }
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const name = snapName() + '.list';
  const lines = ['count=' + keys.length, 'generatedAt=' + new Date().toISOString(), ...keys.map((s) => {
    const o = doc.objects[s];
    return s + '\t' + (o.bytes || 0) + '\t' + objectRel(s, o.ext || 'bin').split(path.sep).join('/');
  })];
  fs.writeFileSync(path.join(SNAP_DIR, name), lines.join('\n') + '\n', 'utf8');
  say('【原图保全库 · 快照】已写 ' + name + '（' + keys.length + ' 个对象）');
  say('  ⚠ 清单只证明"有哪些对象"，**不能替代字节备份**：真正的那一份在**库外**（`_原图\\` 的副本，见 P10）。');
  return 0;
}

/* ══════════════ 核对（备份 ↔ 库 ↔ 台账 三方对账，**只读**） ══════════════ */
/**
 * 为什么要有它（施工方案 §6「批次 0」交付物 9 的一条真欠账）：
 *   `校验` 只回答"库内字节对不对"（外加 P10「原图必须有两个家」）。
 *   它不回答那个真正决定"出事能不能救回来"的问题：
 *   **这份（库外的）备份里，是不是每一个登记对象都有、且逐字节等于台账记着的那一份？**
 *   **这份备份里，是不是每一个登记对象都有、且逐字节等于台账记着的那一份？**
 *   于是"有备份"与"能恢复"之间又隔着一层没验证过的假设 —— 与 2026-10-12 建
 *   `tests\restore-drill.cjs` 时发现的那个缺口同型（当时只有"备份目录里有文件"，没有"能还原回去"）。
 *
 * 语义：`核对 --from <备份根>` 拿三份东西对账，三方必须逐字节一致：
 *   ① 台账 `_原图台账.json`（sha → 字节数/扩展名，**它是分母**）
 *   ② 库内 `_原图\<桶>\<sha>.<ext>`
 *   ③ 备份根
 * 备份根的形态**不做假设**：递归扫，**文件名是 64 位 sha 的文件**才算库对象。
 *   （给一份**库外**的 `_原图\` 副本即可；卡目录切片叫 `题图.jpg` 之类，天然不会被误收。）
 *   ⚠ 2026-11-06（P10）：`_影像备份\` 已退休，它原来那套 `<根>\原件\_原图\<桶>\<sha>.<ext>`
 *     布局仍能被本命令识别 —— 但那只是"还能读"，不是"还该有"。
 *
 * 差异分类（每条都指名到 sha + `[库]/[备份]` + 原因）：
 *   缺文件 / 字节不符 / 大小不符 / 多出
 * `多出` = 备份里有、台账不认的对象。**它判红**：那要么说明库里有未登记的残留对象
 * （先跑 `校验` 看孤儿清单），要么说明备份里混进了不属于本库的东西 —— 两种都要人看一眼，
 * 不能"反正用不上"就放过（这正是"清单是护栏不是备份"那句的同一条纪律）。
 * 库内孤儿**不判红**（与 `校验` 同口径：中断残留可识别、不自动删），只作为可见提示列出。
 *
 * 退出码（与同级命令同风格）：0 三方一致 ／ 1 有差异或缺失 ／ 2 用法错。
 * 覆盖边界（不许含糊）：只核 `_原图\` 的**库对象**（备份根 = **库外**的 `_原图\` 副本）。
 *   其余影像（卡目录切片、待办证据、笔形样本、组卷成品）按 P10 **没有备份**，
 *   它们的"规矩"是**单份**（`单份` 子命令）——"核对全绿"**不等于**"全库都合规"。
 */
/** 备份根里"这是一个库对象"的判据：文件名就是 64 位 sha（扩展名保留原格式）。 */
const OBJ_NAME_RE = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/i;

/** 递归索引备份根里的库对象：sha(大写) → {path, bytes}，同时记下同一 sha 多份的情况。 */
function indexBackupObjects(fromAbs) {
  const objs = new Map();
  const dups = [];
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_快照') walk(p); continue; }
      if (e.name.endsWith('.tmp')) continue;
      const m = OBJ_NAME_RE.exec(e.name);
      if (!m) continue;
      const sha = m[1].toUpperCase();
      let bytes = -1; try { bytes = fs.statSync(p).size; } catch { }
      if (objs.has(sha)) dups.push(path.relative(fromAbs, p).split(path.sep).join('/'));
      else objs.set(sha, { path: p, bytes });
    }
  };
  walk(fromAbs);
  return { objs, dups };
}

/** 一份副本 vs 台账登记：先比字节数、再**逐字节**验 sha256。返回 0~2 条差异。 */
function checkCopy(sha, where, abs, label, o) {
  const out = [];
  let st;
  try { st = fs.statSync(abs); } catch (e) { return [{ sha, where, why: '缺文件', detail: '读不到 ' + label + '：' + e.message }]; }
  if (!st.isFile()) return [{ sha, where, why: '缺文件', detail: '不是一个文件：' + label }];
  if (o.bytes != null && st.size !== o.bytes) {
    out.push({ sha, where, why: '大小不符', detail: '台账登记 ' + o.bytes + 'B，实得 ' + st.size + 'B：' + label });
  }
  const h = sha256File(abs);
  if (h !== sha) {
    out.push({
      sha, where, why: '字节不符',
      detail: '实得 sha256 ' + h.slice(0, 16) + '…（台账与对象名都是 ' + sha.slice(0, 16) + '…）：' + label,
    });
  }
  return out;
}

function cmdCrosscheck(argv) {
  const { opt: opts } = parseArgsLocal(argv);
  const from = typeof opts.from === 'string' ? opts.from : null;
  if (!from) {
    console.error('✖ 核对需要 `--from <备份根>`（**库外**一份 `_原图\\` 的副本；P10 说保全家就是那一份备份）。');
    console.error('  用法：node _原图.mjs 核对 --from <备份根> [--json]');
    return 2;
  }
  const fromAbs = path.isAbsolute(from) ? from : path.resolve(ROOT, from);
  let isDir = false; try { isDir = fs.statSync(fromAbs).isDirectory(); } catch { }
  if (!isDir) {
    console.error('✖ --from 指的不是一个存在的目录：' + fromAbs);
    return 2;
  }

  const doc = loadLedger();
  const keys = Object.keys(doc.objects).sort();
  const store = scanStore();
  const { objs: backup, dups } = indexBackupObjects(fromAbs);

  const diffs = [];
  let okCount = 0, okBytes = 0;
  for (const sha of keys) {
    const o = doc.objects[sha] || {};
    const live = store.get(sha) || null;
    const bak = backup.get(sha) || null;
    const before = diffs.length;
    if (!live) diffs.push({ sha, where: '库', why: '缺文件', detail: '台账登记了它，但 `_原图\\` 里没有这个对象' });
    else diffs.push(...checkCopy(sha, '库', path.join(STORE, live.rel), live.rel, o));
    if (!bak) diffs.push({ sha, where: '备份', why: '缺文件', detail: '备份根里找不到这个 sha 的文件（这份备份不完整）' });
    else diffs.push(...checkCopy(sha, '备份', bak.path, path.relative(fromAbs, bak.path).split(path.sep).join('/'), o));
    if (diffs.length === before) { okCount++; okBytes += (o.bytes != null ? o.bytes : (live ? live.bytes : 0)); }
  }

  /* 多出：备份里有、台账不认的对象（陈旧件 / 混进来的东西 / 库里有未登记残留）。 */
  for (const [sha, v] of backup) {
    if (doc.objects[sha]) continue;
    diffs.push({
      sha, where: '备份', why: '多出',
      detail: '备份里有它、台账里没有：' + path.relative(fromAbs, v.path).split(path.sep).join('/'),
    });
  }
  const storeOrphans = [...store.keys()].filter((s) => !doc.objects[s]).sort();

  const count = (why) => diffs.filter((d) => d.why === why).length;
  const res = {
    ok: diffs.length === 0, from: fromAbs, readOnly: true,
    ledgerObjects: keys.length, storeObjects: store.size, backupObjects: backup.size,
    verified: okCount, verifiedBytes: okBytes,
    counts: { 缺文件: count('缺文件'), 字节不符: count('字节不符'), 大小不符: count('大小不符'), 多出: count('多出') },
    diffs, storeOrphans, backupDuplicates: dups,
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(res, null, 1) + '\n');
  } else {
    say('【原图保全库 · 核对】备份根：' + fromAbs);
    say('  台账 ' + keys.length + ' 个对象 ｜ 库内 ' + store.size + ' 个 ｜ 备份内 ' + backup.size + ' 个');
    say('  三方逐字节核对：一致 ' + okCount + ' ／ 差异 ' + diffs.length +
      '（缺文件 ' + res.counts['缺文件'] + ' / 字节不符 ' + res.counts['字节不符'] +
      ' / 大小不符 ' + res.counts['大小不符'] + ' / 多出 ' + res.counts['多出'] + '）');
    for (const d of diffs.slice(0, 40)) {
      say('  ✖ ' + d.why + '[' + d.where + '] ' + d.sha.slice(0, 16) + '…：' + d.detail);
    }
    if (diffs.length > 40) say('  … 另有 ' + (diffs.length - 40) + ' 条');
    if (storeOrphans.length) {
      say('  ⚠ 库内未登记对象 ' + storeOrphans.length + ' 个（孤儿；与 `校验` 同口径，不算差异、不自动删）');
    }
    if (dups.length) say('  ⚠ 备份内同一对象多份 ' + dups.length + ' 个（只核了第一份）：' + dups.slice(0, 5).join('、'));
  }

  if (diffs.length) {
    console.error('✖ 有 ' + diffs.length + ' 处差异 —— **这份备份不能证明能把库原样恢复**。' +
      '按上面的 [库]/[备份] 定位：库内缺 ⇒ 从**库外副本**按 sha 拷回；备份缺/不符 ⇒ 换一份更完整的库外副本（`_影像备份\\` 已按 P10 退休，不再作为找回来源）。');
    return 1;
  }
  say('  ✅ 台账 / 库内 / 备份三方逐字节一致（' + mb(okBytes) + '）。');
  say('  ⚠ 边界：只覆盖 `_原图\\` 的库对象；其余影像按 P10 **没有备份**，它们的规矩是单份（`单份` 子命令）。');
  return 0;
}

/* ══════════════ 恢复（从备份根把对象写回库内） ══════════════ */
/**
 * 为什么要有它：`核对 --from` 只能证明"这份备份能不能证明库是完整的"，
 * **证明完了之后呢？** 真丢了对象时没有任何写回入口 —— 本轮（批次 4）补上。
 *
 * 三条规矩与 `入库` 同源（它们保护的是同一件事：字节与名字必须一一对应）：
 *   · 已存在且内容相同 ⇒ 跳过（**幂等**，报 skipped 计数）；
 *   · 已存在但内容不同 ⇒ **报错不覆盖**（那是哈希碰撞或盘坏的信号，不是"顺手覆盖"能处理的）；
 *   · 写完**逐字节复核**，对不上 ⇒ 删掉刚写的对象 + exit 1（**备份文件一个都不动**）。
 * ⚠ 恢复**不改台账**：台账记录的是"这个库里有哪些对象"，恢复不是入库。
 *   恢复出来但台账里没有的对象（孤儿）在报告里如实计数，交给 `校验` 复核。
 */
function cmdRestore(argv) {
  const { opt: opts } = parseArgsLocal(argv);
  const from = typeof opts.from === 'string' ? opts.from : null;
  if (!from) {
    console.error('✖ 恢复需要 `--from <备份根>`（**库外**一份 `_原图\\` 的副本）。');
    console.error('  用法：node _原图.mjs 恢复 --from <备份根> [--sha <前2位|完整>] [--dry] [--json]');
    return 2;
  }
  const fromAbs = path.isAbsolute(from) ? from : path.resolve(ROOT, from);
  let fromIsDir = false; try { fromIsDir = fs.statSync(fromAbs).isDirectory(); } catch { }
  if (!fromIsDir) {
    console.error('✖ --from 指的不是一个存在的目录：' + fromAbs);
    return 2;
  }
  let want = null;
  if (opts.sha !== undefined) {
    if (typeof opts.sha !== 'string' || !/^[0-9a-fA-F]{2,64}$/.test(opts.sha.trim())) {
      console.error('✖ --sha 形状不对（要 2~64 位十六进制，按前缀匹配）：' + String(opts.sha));
      return 2;
    }
    want = opts.sha.trim().toUpperCase();
  }

  const { objs, dups } = indexBackupObjects(fromAbs);
  const targets = [...objs.entries()]
    .filter(([sha]) => !want || sha.startsWith(want))
    .sort((a, b) => a[0].localeCompare(b[0]));

  say('【原图保全库 · 恢复】' + (DRY ? '（--dry：不写盘）' : ''));
  say('  备份根：' + fromAbs);
  say('  库内：  ' + STORE);
  say('  备份里可识别的库对象 ' + objs.size + ' 个' +
    (want ? '，按 --sha ' + want + ' 前缀匹配到 ' + targets.length + ' 个' : ''));
  if (dups.length) say('  ⚠ 备份内同一对象多份 ' + dups.length + ' 个（只取第一份）：' + dups.slice(0, 5).join('、'));
  if (!targets.length) {
    console.error('✖ 备份根里没有可恢复的对象' + (want ? '（--sha ' + want + ' 前缀没匹配上）' : '') + '。');
    console.error('  判据：文件名必须是 64 位 sha256（扩展名保留原格式）—— 这是库对象的命名约定，认不出的一律不当对象。');
    return 1;
  }

  const tally = { restored: 0, skipped: 0, dry: 0, error: 0 };
  const errors = [];
  let bytes = 0;
  for (const [sha, o] of targets) {
    const ext = (path.extname(o.path).slice(1) || 'bin').toLowerCase();
    const rel = objectRel(sha, ext);
    const dst = path.join(STORE, rel);
    let exists = false; try { exists = fs.statSync(dst).isFile(); } catch { }
    if (exists) {
      if (sha256File(dst) === sha) { tally.skipped++; continue; }   // 幂等
      tally.error++;
      errors.push({ sha, error: '库里已有同名对象但内容不同（' + rel + '）—— **拒绝覆盖**（哈希碰撞或磁盘损坏的信号，请人工核查）。' });
      continue;
    }
    if (DRY) { tally.dry++; continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = dst + '.tmp';
    try {
      fs.copyFileSync(o.path, tmp);
      let fd = null;
      try { fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd); } catch { } } finally { if (fd !== null) fs.closeSync(fd); }
      fs.renameSync(tmp, dst);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { }
      tally.error++;
      errors.push({ sha, error: '写回失败（备份文件未动）：' + e.message });
      continue;
    }
    const h2 = sha256File(dst);
    if (h2 !== sha) {
      try { fs.unlinkSync(dst); } catch { }
      tally.error++;
      errors.push({ sha, error: '★ 落盘复核失败：写回的对象与备份字节不符（期望 ' + sha.slice(0, 16) + '…，实得 ' + h2.slice(0, 16) + '…）。已删除刚写的对象。' });
      continue;
    }
    tally.restored++;
    bytes += fs.statSync(dst).size;
  }

  const doc = loadLedger();
  const notInLedger = targets.filter(([sha]) => !doc.objects[sha]).length;
  const res = {
    ok: tally.error === 0, from: fromAbs, dry: DRY,
    backupObjects: objs.size, matched: targets.length,
    restored: tally.restored, skipped: tally.skipped, planned: tally.dry, failed: tally.error,
    bytes, notInLedger,
  };
  if (JSON_OUT) process.stdout.write(JSON.stringify(res, null, 1) + '\n');
  else {
    say('  写回 ' + tally.restored + ' ｜ 已存在且内容相同（幂等跳过）' + tally.skipped +
      ' ｜ 计划（--dry）' + tally.dry + ' ｜ 失败 ' + tally.error);
    if (bytes) say('  写回字节：' + mb(bytes));
    if (notInLedger) {
      say('  ⚠ 其中 ' + notInLedger + ' 个**不在台账里**（孤儿对象）—— 按设计恢复不改台账，' +
        '请用 `校验` 复核是否需要补登记。');
    }
    for (const e of errors.slice(0, 20)) console.error('  ✖ ' + e.sha.slice(0, 16) + '…：' + e.error);
  }
  if (tally.error) {
    console.error('✖ 有 ' + tally.error + ' 个对象未恢复。**备份文件一个都没动**，修好后重跑即可（恢复是幂等的）。');
    return 1;
  }
  say('  ✅ 恢复完成（备份文件与台账都未改动）。');
  return 0;
}

/* ══════════════ 派生（旋转/增强/压缩的结果另存为独立对象） ══════════════ */
/**
 * 为什么要有它（建议书 §3 那一行）：派生件（转过向的、调过亮度的、压过的）**不是原件**，
 * 但它们同样是"不能凭原件推出来"的字节（编码器版本/参数/质量任一不同，结果就不同）。
 * 所以它们必须**另存为独立对象**，并且台账里记清"从谁派生、做了什么"——
 * 而**原件的字节与记录一个字都不许动**。
 *
 * ⚠ 边界（诚实写明）：**怎么生成派生字节不属本工具**（零依赖铁律，不做图像编码）。
 *   本工具只负责"另存 + 登记 + 不覆盖"这三件事；实际旋转/增强由外部工具（.NET/PowerShell 等）做完再喂进来。
 */
function cmdDerive(argv) {
  const { opt: opts } = parseArgsLocal(argv);
  const fromSha = typeof opts['derived-from'] === 'string' ? opts['derived-from'].trim().toUpperCase() : '';
  const op = typeof opts.op === 'string' ? opts.op.trim() : '';
  const file = typeof opts.file === 'string' ? opts.file : '';
  const note = typeof opts.note === 'string' ? opts.note : '';
  const OPS = new Set(['rotate', 'enhance', 'compress']);

  if (!/^[0-9A-F]{64}$/.test(fromSha)) {
    console.error('✖ --derived-from 要完整的 64 位 sha256（**原图对象**的内容哈希）。');
    console.error('  用法：node _原图.mjs 派生 --derived-from <sha> --op rotate|enhance|compress --file <盘上文件> [--note 说明] [--dry] [--json]');
    return 2;
  }
  if (!OPS.has(op)) {
    console.error('✖ --op 必须是 rotate / enhance / compress 之一，收到：' + JSON.stringify(op));
    return 2;
  }
  if (!file) {
    console.error('✖ --file 必填：指向**已经生成好的**派生结果文件（怎么生成不属本工具）。');
    return 2;
  }
  const fileAbs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  let st = null; try { st = fs.statSync(fileAbs); } catch { }
  if (!st || !st.isFile()) {
    console.error('✖ --file 不是一个存在的文件：' + fileAbs);
    return 2;
  }

  const doc = loadLedger();
  if (!doc.objects[fromSha]) {
    console.error('✖ 台账里没有这个原图对象：' + fromSha.slice(0, 16) + '…');
    console.error('  口径：--derived-from 必须是**已保全的原图** sha（派生件不能再当原件）；查法：node _原图.mjs 名册 --list');
    return 2;
  }

  const r = ingestOne(fileAbs, { rel: '派生/' + op });
  if (r.status === 'error') { console.error('✖ ' + r.error); return 1; }

  const sha = r.sha;
  const existing = doc.objects[sha];
  const head = '【原图保全库 · 派生】' + (DRY ? '（--dry：不写盘）' : '');
  const line = '  原件 ' + fromSha.slice(0, 16) + '… ／ 操作 ' + op + ' ／ 派生结果 ' + String(sha).slice(0, 16) +
    '…（' + (r.bytes / 1024).toFixed(0) + ' KB）';

  /* 同一份字节只能有一个身份：内容已在库里当**原图**存在 ⇒ 拒绝登记为派生件。 */
  if (existing && !existing.derivedFrom) {
    console.error('✖ 该内容的 sha 已在库里作为**原图**存在（' + String(sha).slice(0, 16) + '…）：派生件的字节必须与原件不同。');
    console.error('  （本工具不允许把同一份字节同时当原件与派生件 —— 那会让"谁是原件"变成不可判的。）');
    return 1;
  }
  if (existing && existing.derivedFrom) {
    if (existing.derivedFrom === fromSha && existing.op === op) {
      const res = { ok: true, dry: DRY, reused: true, derivedFrom: fromSha, op, sha, note };
      if (JSON_OUT) process.stdout.write(JSON.stringify(res, null, 1) + '\n');
      else { say(head); say(line); say('  ⏭ 已登记过同样的派生件（幂等复用）：' + String(sha).slice(0, 16) + '…'); }
      return 0;
    }
    console.error('✖ 该内容已登记为**另一条**派生记录（derivedFrom=' + String(existing.derivedFrom).slice(0, 16) +
      '…，op=' + existing.op + '）—— 同内容不同来源不许覆盖登记。');
    return 1;
  }

  if (DRY) {
    const res = { ok: true, dry: true, planned: true, derivedFrom: fromSha, op, sha, note };
    if (JSON_OUT) process.stdout.write(JSON.stringify(res, null, 1) + '\n');
    else { say(head); say(line); say('  （--dry）将登记派生件；**原件记录不变**。'); }
    return 0;
  }

  const o = doc.objects[sha] || {
    bytes: r.bytes, ext: extOf(path.basename(fileAbs)), addedAt: new Date().toISOString(), sources: [], names: [],
  };
  o.derivedFrom = fromSha;
  o.op = op;
  if (note) o.note = note;
  if (!o.sources.includes('派生')) o.sources.push('派生');
  doc.objects[sha] = o;
  saveLedger(doc, { backup: true });

  const res = { ok: true, dry: false, derivedFrom: fromSha, op, sha, note, bytes: o.bytes };
  if (JSON_OUT) process.stdout.write(JSON.stringify(res, null, 1) + '\n');
  else {
    say(head);
    say(line);
    say('  ✅ 派生件已另存并登记；**原件（' + fromSha.slice(0, 16) + '…）的字节与记录一个字都没动。**');
  }
  return 0;
}

/* ══════════════ P10 判据 · 单份（非原图影像只能有一个家） ══════════════ */
/**
 * 用户 2026-11-06 定案 P10「一个字节一个家」的第二条机器判据（规范 §3.5）：
 *   **非原图影像只允许一个家** —— §3.5 第 4–8 行那几类（卡片裁图 / 待办证据 / 笔形样本 /
 *   撤卡留档 / 组卷成品），同一个 sha256 不得出现在**两个路径**上；出现 = 红
 *   （那就是 P10 说的冗余："除了原图，其它东西不要再有冗余了"）。
 *
 * 刻意**不算**在内的（各有各的判据，别在这里重复判）：
 *   · 第 1、2、3 行（原图工作家 `原卷\`·`_收件箱\`、保全家 `_原图\`）—— P10 **允许**原图两个家，
 *     那条判据在 `校验`（活路径 → 保全库）；
 *   · 第 9 行 `tiles\` / `_crops\` —— 可重建派生，允许任意份数；
 *   · `_备份-真源\`（文本真源快照，N12/§3.4）、`_影像备份\`（已按 P10 退休）。
 *
 * 性能：先按字节数分组，只在**同大小**的组内算 sha256（唯一份数的文件一个字节都不用读）。
 * 退出码：0 = 每份影像只有一个家；1 = 有同 sha 出现在两个路径；2 = 用法错。
 */
const SINGLE_HOME_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?|pdf)$/i;
/* ── §3.5「单份」的两条**写死的例外**（2026-11-06，用户裁量后写进规范）──
   E1：同一题的**卡片四件套那张图**（`原卷截图*`）与 `待办证据\`/`_待确认证据-*` 里的图逐字节相同 ⇒ 两份都留。
       理由：无卡待办只能靠待办证据显示；卡的消费方（灯箱/组卷/打印）只认卡目录里那一份。删哪份都断一条链。
   E2：**卡目录里的图**（四件套内部）之间逐字节相同 ⇒ 两份都留。
       理由：F2 要求每卡自带四件套；重裁会改字节 ⇒ blindFingerprint 失效、要重跑双路盲解，代价远大于省一份图。
   ⚠ 例外**只覆盖这两类**：`待办证据\T100.jpg` 与 `T101.jpg` 这种"同一科多个待办共用一张证据图"
     **不是例外**（真冗余）—— 规范 §3.5 明写：两个待办应当**指向同一个路径**，而不是复制成两份。 */
const isInCardDir = (rel) => {
  const seg = String(rel).split('/');
  return seg.length >= 4 && /^[A-Z]\d{4}-/.test(seg[2]);
};
const isCardFourPieceShot = (rel) => isInCardDir(rel) && /^原卷截图/i.test(path.basename(String(rel)));
const isInEvidenceDir = (rel) => {
  const seg = String(rel).split('/');
  const i = seg.findIndex((s) => s === '待办证据' || /^_待确认证据-\d{8}$/.test(s));
  return i >= 0 && i === seg.length - 2;                      // 直接住在证据目录里的那张图
};
function singleHomeExempt(paths) {
  /* **逐对**判（不是整组一刀切）：组里每一对都得落在 E1 或 E2 里才算豁免。
     为什么必须逐对：`{卡图, 卡图, 待办证据}` 里每一对都合法（卡-卡=E2、卡-证据=E1）⇒ 豁免；
     但 `{卡图, 卡图, 证据, 证据}` 里那一对 **证据-证据** 既不属 E2 也不属 E1 ⇒ **不豁免**
     （规范 §3.5 明写"同一科多个待办共用一张证据图"是真冗余：应当指向同一个路径）。 */
  const pairOk = (a, b) => (isInCardDir(a) && isInCardDir(b))
    || (isCardFourPieceShot(a) && isInEvidenceDir(b))
    || (isCardFourPieceShot(b) && isInEvidenceDir(a));
  for (let i = 0; i < paths.length; i++) {
    for (let k = i + 1; k < paths.length; k++) if (!pairOk(paths[i], paths[k])) return null;
  }
  if (paths.every(isInCardDir)) return { ex: 'E2', why: '卡目录里的图（F2：每卡自带四件套）之间逐字节相同' };
  return { ex: 'E1', why: '卡片 `原卷截图*` 与 `待办证据\\` 里的图逐字节相同（两份各有消费方）' };
}
function cmdSingleHome() {
  const cand = [];
  const roots = [...studentDirs().map((s) => path.join(ROOT, s)), path.join(ROOT, '_笔形'), path.join(ROOT, '_撤卡留档'), path.join(ROOT, '组卷')];
  for (const t of roots) {
    for (const f of walkFiles(t)) {
      if (!SINGLE_HOME_RE.test(f)) continue;                                   // 只看影像 / 成品 PDF
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      const seg = rel.split('/');
      if (seg.some((s) => s === 'tiles' || s === '_crops')) continue;          // 第 9 行：可重建，允许任意份数
      if (seg.some((s) => s === '原卷')) continue;                             // 第 1 行：原图工作家（两个家，见 `校验`）
      if (seg[0] === '_备份-真源' || seg[0] === '_原图' || seg[0] === '_影像备份') continue;
      let size = 0; try { size = fs.statSync(f).size; } catch { continue; }
      if (!size) continue;                                                      // 空文件不参与（没有"字节"可谈）
      cand.push({ rel, abs: f, size });
    }
  }

  const bySize = new Map();
  for (const c of cand) { if (!bySize.has(c.size)) bySize.set(c.size, []); bySize.get(c.size).push(c); }
  const dup = [], exempted = [];
  for (const [size, group] of bySize) {
    if (group.length < 2) continue;                                            // 唯份数 ⇒ 不可能有第二个家
    const bySha = new Map();
    for (const c of group) {
      const sha = sha256File(c.abs);
      if (!bySha.has(sha)) bySha.set(sha, []);
      bySha.get(sha).push(c.rel);
    }
    for (const [sha, rels] of bySha) {
      if (rels.length < 2) continue;
      const sorted = rels.slice().sort();
      const ex = singleHomeExempt(sorted);                                     // §3.5 的 E1/E2
      if (ex) { exempted.push({ sha, bytes: size, ex: ex.ex, why: ex.why, paths: sorted }); continue; }
      dup.push({ sha, bytes: size, paths: sorted });
    }
  }
  dup.sort((a, b) => b.bytes - a.bytes);
  exempted.sort((a, b) => b.bytes - a.bytes);

  const res = {
    ok: dup.length === 0, readOnly: true,
    scanned: cand.length, distinctSizes: bySize.size,
    duplicateGroups: dup.length, duplicateFiles: dup.reduce((n, d) => n + d.paths.length, 0),
    duplicates: dup,
    exemptGroups: exempted.length, exemptFiles: exempted.reduce((n, d) => n + d.paths.length, 0),
    exempted,
  };
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(res, null, 1) + '\n');
  } else {
    say('【原图保全库 · 单份】P10：非原图影像只允许一个家（§3.5 第 4–8 行）');
    say('  扫描 ' + cand.length + ' 份影像（卡目录 / 待办证据 / 笔形样本 / 撤卡留档 / 组卷；' +
      '已排除 `原卷\\`·`_原图\\`·`tiles\\`·`_crops\\`·`_备份-真源\\`）');
    say('  同 sha 出现在 ≥2 个路径：**违规 ' + dup.length + ' 组**（' + res.duplicateFiles + ' 个文件）｜' +
      '§3.5 例外豁免 ' + exempted.length + ' 组（' + res.exemptFiles + ' 个文件）');
    for (const d of dup.slice(0, 20)) {
      say('  ✖ ' + d.sha.slice(0, 16) + '…（' + mb(d.bytes) + '）× ' + d.paths.length + ' 份：');
      for (const p of d.paths) say('      ' + p);
    }
    if (dup.length > 20) say('  … 另有 ' + (dup.length - 20) + ' 组');
    /* 豁免必须**可见**（不许静默放行）：逐条印出来，写清走的是 E1 还是 E2。 */
    for (const e of exempted.slice(0, 20)) {
      say('  ○ 豁免 ' + e.ex + '：' + e.sha.slice(0, 16) + '…（' + mb(e.bytes) + '）× ' + e.paths.length + ' 份 —— ' + e.why);
      for (const p of e.paths) say('      ' + p);
    }
    if (exempted.length > 20) say('  … 另有 ' + (exempted.length - 20) + ' 组豁免（见 --json 全文）');
  }
  if (dup.length) {
    console.error('✖ P10 违反：有 ' + dup.length + ' 组影像**有两个家**（非原图影像只允许一个家）。' +
      ' 怎么办：按 §七 处置 —— 留一份（程序真正读的那一份），其余移走或删；' +
      ' 若它其实是**原图**（整页扫描/导入原件），那它该走 `原图\\` 保全家，见 §3.5 第 1–3 行。' +
      ' ⚠ §3.5 的两条例外（E1 卡片四件套图 ↔ 待办证据图；E2 卡目录内部的图）已自动豁免，' +
      ' 本清单**不含**它们；"同一科多个待办共用一张证据图"**不在**例外里（应当指向同一路径）。');
    return 1;
  }
  say('  ✅ 每一份非原图影像都只有一个家' + (exempted.length ? '（另有 ' + exempted.length + ' 组按 §3.5 的 E1/E2 豁免，已逐条印在上面）' : '') + '。');
  return 0;
}

/* ══════════════ 入口 ══════════════ */
switch (cmd) {
  case '入库': process.exit(cmdIngest(rest));
  case '校验': process.exit(cmdVerify());
  case '两个家': process.exit(cmdTwoHomes());
  case '单份': process.exit(cmdSingleHome());
  case '核对': process.exit(cmdCrosscheck(rest));
  case '恢复': process.exit(cmdRestore(rest));
  case '派生': process.exit(cmdDerive(rest));
  case '名册': process.exit(cmdRoster(rest));
  case '快照': process.exit(cmdSnapshot(rest));
  default:
    console.error('用法：');
    console.error('  node _原图.mjs 入库 <文件或目录...> [--batch 名] [--student X] [--subject Y] [--dry]');
    console.error('  node _原图.mjs 校验 [--json]   # §3.5 第 3 行：库内对象逐字节核对（基线命令）');
    console.error('  node _原图.mjs 两个家 [--json] # P10 判据 A：原图恰好两个家（活路径 → 保全库；缺 = 红）');
    console.error('  node _原图.mjs 单份 [--json]   # P10 判据 B：非原图影像只能有一个家（同 sha 两个路径即红，§3.5 第 4–8 行）');
    console.error('  node _原图.mjs 核对 --from <备份根> [--json]   # 只读：备份 ↔ 库 ↔ 台账 三方逐字节对账');
    console.error('  node _原图.mjs 恢复 --from <备份根> [--sha <前2位|完整>] [--dry] [--json]   # 写回：把备份里的对象拷回库（幂等、不覆盖、逐字节复核）');
    console.error('  node _原图.mjs 派生 --derived-from <sha> --op rotate|enhance|compress --file <盘上文件> [--note 说明] [--dry] [--json]   # 派生件另存（原件不可变）');
    console.error('  node _原图.mjs 名册 [--list] [--json]');
    console.error('  node _原图.mjs 快照 [--list | --diff <清单名>]');
    process.exit(2);
}
