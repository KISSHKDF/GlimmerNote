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
 *   node _原图.mjs 名册 [--list] [--json]
 *   node _原图.mjs 快照                 # 写一份 sha 清单（不是字节副本，见下）
 *   node _原图.mjs 快照 --list
 *   node _原图.mjs 快照 --diff <清单名>  # ★ 对照：哪些 sha 从库里"非正常消失"了
 *
 * ══ 快照为什么只存清单、不存字节（以及它**不**能替代什么）══
 * 能这么做的唯一理由是**不变量①**：对象永不被改写 ⇒ "某时刻的库" == "那一刻的 sha 清单"。
 * **但它不能替代字节备份。** 清单只能证明"丢了什么"，不能把字节变回来。
 * 所以本工具的前提是：库里的字节另有 `_影像备份\` + `C:\CTB-影像离机备份` 两层副本
 * （见 `_影像备份.mjs`）。**清单是护栏，不是备份。**
 * 而且库写锁只约束"愿意配合的程序"，挡不住资源管理器删除、磁盘位损坏、绕开工具的脚本 ——
 * 所以 `快照 --diff` 的意义正是：事后能**精确定位**是哪几个对象没了。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { libraryRoot } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic, acquireLibLock } from './_安全写.mjs';

const ROOT = libraryRoot();
const STORE = path.join(ROOT, '_原图');
const LEDGER = path.join(ROOT, '_原图台账.json');
const SNAP_DIR = path.join(STORE, '_快照');
const JSON_OUT = process.argv.includes('--json');
const DRY = process.argv.includes('--dry');

/* 持锁：本工具是"读台账 → 改内存 → 写回"的模式，没有锁时与其它写入口并发会丢更新。 */
const release = acquireLibLock(ROOT, { label: '_原图' });
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
function saveLedger(doc) {
  doc.generatedAt = new Date().toISOString();
  writeJsonAtomic(LEDGER, doc, { backup: false, indent: 1 });
}
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/* 参数解析：**必须区分"带值的选项"与"开关"**。
   ⚠ 实测踩过：第一版把所有不以 `--` 开头的参数都当成路径，
   于是 `入库 <目录> --batch "批次名"` 里的 "批次名" 被当成路径 ⇒ 报"路径不存在"。
   这里显式声明哪些选项吃值，其余一律当开关 —— 反面判据（`--dry` 后面跟路径）
   才不会把路径吃掉。 */
const VALUE_OPTS = new Set(['batch', 'student', 'subject', 'diff']);
function parseArgs(argv) {
  const opts = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (VALUE_OPTS.has(k)) {
        const nxt = argv[i + 1];
        if (nxt !== undefined && !nxt.startsWith('--')) { opts[k] = nxt; i++; }
        else opts[k] = true;
      } else opts[k] = true;
    } else positional.push(a);
  }
  return { opts, positional };
}

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
 *    · `_影像备份\` —— 备份自身；`_probe\` —— 探针；`_原图\` —— 库自己；`.git\`、`_快照\`
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
  const { opts, positional: paths } = parseArgs(argv);
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
    /* 每 50 个落一次台账：中断后重跑是幂等的，不用从头再来 */
    if (!DRY && processed % 50 === 0) { saveLedger(doc); say('  … 已处理 ' + processed + '/' + files.length); }
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
  }
  if (bad.length) { console.error('✖ 有 ' + bad.length + ' 个对象校验失败 —— 请对照 `_影像备份\\` 与离机镜像核查。'); process.exit(1); }
  return 0;
}

/* ══════════════ 名册 ══════════════ */
function cmdRoster(argv) {
  const { opts } = parseArgs(argv);
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
  const { opts } = parseArgs(argv);

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
      console.error('  怎么办：从 `_影像备份\\` 或离机镜像按 sha 找回，再跑 `入库`。');
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
  say('  ⚠ 清单只证明"有哪些对象"，**不能替代字节备份**：真正的副本靠 `_影像备份\\` 与离机镜像。');
  return 0;
}

/* ══════════════ 入口 ══════════════ */
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case '入库': process.exit(cmdIngest(rest));
  case '校验': process.exit(cmdVerify());
  case '名册': process.exit(cmdRoster(rest));
  case '快照': process.exit(cmdSnapshot(rest));
  default:
    console.error('用法：');
    console.error('  node _原图.mjs 入库 <文件或目录...> [--batch 名] [--student X] [--subject Y] [--dry]');
    console.error('  node _原图.mjs 校验 [--json]');
    console.error('  node _原图.mjs 名册 [--list] [--json]');
    console.error('  node _原图.mjs 快照 [--list | --diff <清单名>]');
    process.exit(2);
}
