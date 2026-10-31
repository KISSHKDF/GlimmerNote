#!/usr/bin/env node
/**
 * 错题本 · 影像备份（2026-10-12 建）
 *
 * 为什么存在（用户 2026-10-12 指令：在题库目录下建影像备份，把两份影像各备一份）：
 *   孩子错题链路一共有三份产物，只有两份是**影像文件**，第三份不是：
 *     ① **原件**（第一份影像）＝ 你交给我们的错题原照片（整页扫描/实拍）。
 *        不可再生：丢了就再也回不到"这道题来自哪一页"。
 *     ② **切片**（第二份影像）＝ 从原件上裁下来的每道错题图（卡目录里的 `题图.jpg`）。
 *        由原件派生，但它本身也是一份实体影像，同样要保。
 *     ③ **印刷图**＝ 画在 `题干.html` 里的内联 `<svg>`，**是代码不是图片文件**，
 *        跟着源码走，不进本备份（备份了也没有对应文件）。
 *
 *   此前全仓影像（2.78GB）都在 D 盘同一块盘上、且无任何离机副本；
 *   文档 `DEVELOPMENT.md` 声称的备份目录实测**不存在**。
 *
 *   ⚠ 2026-10-12 第二次加固（同盘副本 ≠ 备份）：
 *     ① 判定口径从「文件名正则猜」改为「**台账反查 ∪ 目录规则 ∪ 卡目录整页截图**」——
 *        旧口径漏掉了 `原卷\学生A物理-*-p01..p60.jpg` 这类真实整页原片（`九年级\原卷` 76 个只备了 2 个）；
 *     ② 新增**离机镜像**（`_影像镜像.txt` 配置落点，默认指向另一块物理盘）——
 *        `_影像备份\` 与原件同盘时，硬盘一坏两边一起没，那不叫备份；
 *     ③ 新增**覆盖率体检**：`--verify/--status` 现在会输出「已备份 N/应备份 M + 百分比」，
 *        且覆盖率 <50% 直接判红——防"校验全绿但没备该备的"复发（这正是旧口径骗过自己的地方）。
 *
 * 备份策略：**增量 + 幂等**。已存在且大小/哈希一致的直接跳过，
 * 所以可以每次入库后随手跑一次，不会重复占空间、不会打断流程。
 *
 * 用法：
 *   node _影像备份.mjs            # 增量备份 + 自动推离机镜像（日常就用这个）
 *   node _影像备份.mjs --verify   # 只校验：备份与源是否一致 + 覆盖率体检，不写入
 *   node _影像备份.mjs --status   # 只看统计（覆盖了没、离机配了没）
 *   node _影像备份.mjs --mirror   # 只推离机镜像
 *
 * 约定（写进开发规范，由 _工具\裁图.ps1 与人工入库流程共同遵守）：
 *   · 收到新的原片 → 立刻跑一次本脚本（原件入库即备份，不等切片）
 *   · 切片成功之后 → 再跑一次本脚本（切片入库即备份）
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { libraryRoot } from './_库根.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 是**库根**（影像与台账都在库里），不是工具目录。
   原先是 `path.dirname(fileURLToPath(import.meta.url))`，工具搬进 <AppRoot>\tools\ 之后
   那样算出来是程序目录 ⇒ 会把程序目录当题库扫、备份落错地方。 */
const ROOT = libraryRoot();
const BACKUP = path.join(ROOT, '_影像备份');
/* 离机备份落点：默认 <系统盘>\CTB-影像离机备份。
   覆盖方式：环境变量 CTB_IMG_MIRROR，或库根下的 _影像镜像.txt 首行。
   要点：**必须指向与题库不同的物理盘**，否则硬盘一坏两边一起没，那不叫备份。 */
const MIRROR_FILE = path.join(ROOT, '_影像镜像.txt');
function mirrorTarget() {
  if (process.env.CTB_IMG_MIRROR) return process.env.CTB_IMG_MIRROR.trim();
  try {
    const s = fs.readFileSync(MIRROR_FILE, 'utf8');
    const first = (s.split(/\r?\n/) || []).map(x => x.trim()).find(x => x && !x.startsWith('#'));
    if (first) return first;
  } catch { }
  return '';
}
const IMG_EXT = /\.(jpe?g|png|pdf|webp|gif|bmp|tiff?)$/i;

/* 题库根下**不备份**的目录：加工过程的临时产物、产物副本、工具自测区。
   这些丢了最多重做一次（重裁/重跑），不是不可再生底稿。 */
const SKIP_DIRS = new Set([
  '_影像备份',   // 自身
  '_probe',      // 探针/自测截图
  '_桌面', '_桌面v2', '_archive', '_备份-真源', 'tests', 'docs', '.git', 'node_modules',
  'wv2-profile',
]);

/* ══ 2026-10-12 重写判定口径（修覆盖率 5.9% ⇒ 接近 100%）══
   旧口径是**按文件名正则猜**（ORIGIN_RE = /原卷|整页|原件|转正/），
   漏掉了两类真实不可再生文件：
     ① `九年级\原卷\学生A物理-20261007-p01.jpg`…`p60.jpg` —— 整页试卷扫描原片，
        文件名里没有"原卷/整页/原件/转正"任何一个词；
     ② `九年级\化学\C0001-xxx\原卷截图.jpg` —— 卡片目录里的整页截图，
        文件名是"原卷截图"，含"原卷"但旧正则 `ORIGIN_RE` 匹配的是**整名**，
        且 collect() 用 `else if` 把它归到"未识别"分支之外的另一个层级（见 collect 重写）。
   新口径 = **目录规则 ∪ 台账反查**，两者都算权威，任一命中即备份：
     A. 整页/原件目录：路径里含 `原卷`、`_收件箱`、顶层作业目录（如 `国庆假期作业1`）下的影像。
     B. 台账反查：`_原卷台账.json` 每张卡的 `page` 字段指的就是那张"整页原卷图"的相对路径
        ——这是**外部真源**，不依赖文件名长什么样，直接把 205 张卡引用的原片全部纳入。
     C. 切片/单题图：卡目录下的 `题图*.jpg` / `原卷截图-*.jpg` / `裁图*` / `crop*`。 */
const ORIGIN_DIR_RE = /(原卷|_收件箱|整页|原件)/;
const SLICE_RE = /^(题图|裁图|crop)/i;
/** 卡目录里的"整页截图"也是不可再生原件（如 原卷截图.jpg / 原卷截图-图3题行.jpg）。 */
const CARD_ORIGIN_RE = /^原卷截图/;
/** `_crops\`、`_work-*` 等加工中间产物仍不备份。
    注意：`_crops` 可能出现在**路径中段**（如 `九年级/原卷/_crops/a1.png`），
    不能只判首段 —— 2026-10-12 首次实跑就是漏在这里，覆盖率虚高 208 条。 */
const CROP_DIR_RE = /(^|\/)_crops(\/|$)|(^|\/)_work-[^/]*(\/|$)|(^|\/)zzznew(\/|$)/;

/** 从台账反查：所有被卡片引用的 page 相对路径（已是 posix 形态）。 */
function ledgerPages() {
  const p = path.join(ROOT, '_原卷台账.json');
  let doc; try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return new Set(); }
  const out = new Set();
  const cards = doc && doc.cards ? doc.cards : {};
  for (const k of Object.keys(cards)) {
    const v = cards[k] || {};
    if (typeof v.page === 'string' && v.page) out.add(v.page.split('\\').join('/'));
  }
  return out;
}

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (IMG_EXT.test(e.name)) {
      out.push(full);
    }
  }
}

function sha1(file) {
  try {
    const h = crypto.createHash('sha1');
    h.update(fs.readFileSync(file));
    return h.digest('hex').slice(0, 16);
  } catch { return null; }
}

/**
 * 收集两类影像（2026-10-12 重写口径，见文件头注释）。
 * 判定优先级（任一命中即备份，先到先得，避免重复统计）：
 *   1. **台账反查**：`page` 字段命中 ⇒ 原件（这是唯一权威清单，205 张卡全部覆盖）。
 *   2. **卡目录整页截图**：`原卷截图*.jpg` ⇒ 原件（不可再生：回不到"这道题来自哪一页"）。
 *   3. **原件目录**：路径含 原卷/整页/原件/_收件箱 ⇒ 原件（整页试卷扫描原片）。
 *   4. **切片**：卡目录里的 `题图*.jpg` / `裁图*` / `crop*`。
 * 加工中间产物（`_crops\`、`_work-*`、`zzznew`）一律排除 —— 丢了可重做。
 * 返回 { origin:[{abs,rel,why}], slice:[...] }
 */
function collect() {
  const all = [];
  walk(ROOT, all);
  const pages = ledgerPages();
  const origin = [], slice = [];
  const seen = new Set();
  const add = (arr, item) => { if (!seen.has(item.rel)) { seen.add(item.rel); arr.push(item); } };
  for (const abs of all) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (CROP_DIR_RE.test(rel)) continue;                       // 加工中间产物
    const base = path.basename(abs);
    if (SLICE_RE.test(base)) { add(slice, { abs, rel, why: '切片文件名' }); continue; }
    if (pages.has(rel)) { add(origin, { abs, rel, why: '台账 page 字段' }); continue; }
    if (CARD_ORIGIN_RE.test(base)) { add(origin, { abs, rel, why: '卡目录原卷截图' }); continue; }
    if (ORIGIN_DIR_RE.test(rel)) { add(origin, { abs, rel, why: '原件目录规则' }); continue; }
  }
  return { origin, slice };
}

function ensureDirs() {
  fs.mkdirSync(path.join(BACKUP, '原件'), { recursive: true });
  fs.mkdirSync(path.join(BACKUP, '切片'), { recursive: true });
}

/** 备份一个文件：目标保持与源的相对路径（原样平铺，按 rel 建目录） */
function copyOne(item, kind) {
  const dst = path.join(BACKUP, kind, item.rel.replace(/^[/\\]+/, ''));
  const srcHash = sha1(item.abs);
  if (fs.existsSync(dst)) {
    if (sha1(dst) === srcHash) return 'skip';
    // 内容变了 → 覆盖前把旧版留一份 .bak，避免"改坏了连原件都没了"
    try { fs.renameSync(dst, dst + '.bak'); } catch { }
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // 先写 .tmp 再 rename，避免备份本身半截（与 _安全写.mjs 同一原则）
  const tmp = dst + '.tmp';
  fs.copyFileSync(item.abs, tmp);
  fs.renameSync(tmp, dst);
  return 'copy';
}

function fmtSize(n) { return (n / 1048576).toFixed(1) + ' MB'; }

function statsOf(dir) {
  let n = 0, size = 0;
  (function w(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) w(f);
      else { n++; try { size += fs.statSync(f).size; } catch { } }
    }
  })(dir);
  return { n, size };
}

/** 离机镜像：把 _影像备份 原样复制到另一块物理盘。
    —— 同盘复制不是备份。这一步才是"备份"。可增量、可重复。 */
function mirrorAll(log) {
  const tgt = mirrorTarget();
  if (!tgt) { log('  [离机] 未配置镜像落点（建 _影像镜像.txt 写一行目标路径，或设 CTB_IMG_MIRROR）—— 当前只有同盘副本'); return { ok: false, reason: '未配置' }; }
  if (path.parse(tgt).root.toLowerCase() === path.parse(ROOT).root.toLowerCase()) {
    log('  [离机] ⚠ 镜像落点与题库同卷（' + tgt + '）—— 硬盘一坏两边一起没，请改到另一块物理盘'); return { ok: false, reason: '同卷' };
  }
  let copied = 0, err = 0;
  for (const kind of ['原件', '切片']) {
    const src = path.join(BACKUP, kind);
    if (!fs.existsSync(src)) continue;
    (function w(sdir, rel) {
      let es; try { es = fs.readdirSync(sdir, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const s = path.join(sdir, e.name), r = rel ? rel + '/' + e.name : e.name, d = path.join(tgt, kind, ...r.split('/'));
        if (e.isDirectory()) { w(s, r); continue; }
        try {
          if (fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size) continue;
          fs.mkdirSync(path.dirname(d), { recursive: true });
          fs.copyFileSync(s, d + '.tmp'); fs.renameSync(d + '.tmp', d); copied++;
        } catch { err++; }
      }
    })(src, '');
  }
  log('  [离机] → ' + tgt + '  新增 ' + copied + ' 个，失败 ' + err + ' 个');
  return { ok: err === 0, copied, err };
}

/** 覆盖率体检：应备份 vs 已备份（含离机）。
    铁律（2026-10-12 立）：备份工具的绿灯只能证明"它自己选中的文件是好的"，
    必须额外报出**分母与覆盖率**，否则就是"校验全绿但没备该备的"。 */
function coverage(origin, slice, log) {
  let need = 0, have = 0, needB = 0, haveB = 0, missing = [];
  for (const [kind, list] of [['原件', origin], ['切片', slice]]) {
    for (const it of list) {
      need++;
      let sz = 0; try { sz = fs.statSync(it.abs).size; } catch { }
      needB += sz;
      const dst = path.join(BACKUP, kind, it.rel);
      if (fs.existsSync(dst)) { have++; haveB += sz; }
      else missing.push(kind + ' ' + it.rel);
    }
  }
  const pct = need ? (have / need * 100).toFixed(1) : '100.0';
  log('  覆盖率：已备份 ' + have + '/' + need + '（' + pct + '%），字节 ' + fmtSize(haveB) + '/' + fmtSize(needB));
  if (missing.length) {
    log('  未备份（前 10 条）：');
    for (const m of missing.slice(0, 10)) log('    - ' + m);
    if (missing.length > 10) log('    … 还有 ' + (missing.length - 10) + ' 条');
  }
  return { need, have, pct, missing };
}

function main() {
  const mode = process.argv[2] || '';
  const { origin, slice } = collect();
  const log = (s) => console.log(s);

  log('【错题本 · 影像备份】' + new Date().toLocaleString('zh-CN'));
  log('  源：原件 ' + origin.length + ' 个 / 切片 ' + slice.length + ' 个');

  if (mode === '--status') {
    const o = statsOf(path.join(BACKUP, '原件'));
    const s = statsOf(path.join(BACKUP, '切片'));
    log('  本机备份：原件 ' + o.n + ' 个 ' + fmtSize(o.size) + ' / 切片 ' + s.n + ' 个 ' + fmtSize(s.size));
    coverage(origin, slice, log);
    log('  离机镜像：' + (mirrorTarget() || '（未配置）'));
    return;
  }

  if (mode === '--verify') {
    let bad = 0, ok = 0;
    for (const [kind, list] of [['原件', origin], ['切片', slice]]) {
      for (const it of list) {
        const dst = path.join(BACKUP, kind, it.rel);
        if (!fs.existsSync(dst)) { log('  [MISSING] ' + kind + ' ' + it.rel); bad++; continue; }
        if (sha1(dst) !== sha1(it.abs)) { log('  [DIFF]    ' + kind + ' ' + it.rel); bad++; continue; }
        ok++;
      }
    }
    log('  校验：一致 ' + ok + ' / 异常 ' + bad);
    const cov = coverage(origin, slice, log);
    // 自检：如果新口径退回到旧口径（覆盖率 <50%），判红——防"改回去也没人发现"
    if (Number(cov.pct) < 50) { console.error('  ⚠ 覆盖率异常偏低（' + cov.pct + '%），判定口径可能退化'); process.exit(2); }
    if (bad) { console.error('  异常 ' + bad + ' 项，退出码 1'); process.exit(1); }
    process.exit(0);
  }

  if (mode === '--mirror') { const r = mirrorAll(log); process.exit(r.ok ? 0 : 1); }

  // 默认：增量备份 + 自动镜像到离机盘（备份的意义在离机那一份）
  ensureDirs();
  let c1 = 0, c2 = 0, s1 = 0, s2 = 0;
  for (const it of origin) { const r = copyOne(it, '原件'); if (r === 'copy') c1++; else s1++; }
  for (const it of slice) { const r = copyOne(it, '切片'); if (r === 'copy') c2++; else s2++; }
  const o = statsOf(path.join(BACKUP, '原件'));
  const s = statsOf(path.join(BACKUP, '切片'));
  log('  新增：原件 ' + c1 + ' / 切片 ' + c2);
  log('  跳过（已是最新）：原件 ' + s1 + ' / 切片 ' + s2);
  log('  本机备份：原件 ' + o.n + ' 个 ' + fmtSize(o.size) + ' / 切片 ' + s.n + ' 个 ' + fmtSize(s.size));
  coverage(origin, slice, log);
  /* ★ 2026-10-29（R2 审计 D-03）：默认模式原先把 mirrorAll 的返回值**丢掉** ⇒ 离机镜像失败
     （未配置落点=新用户默认状态 / 镜像盘没插 / 落点与题库同卷 / 逐个 copy 出错）仍然退出 0。
     任何按退出码判断的自动化（计划任务、体检）都会把"只剩同盘副本"记成"备份成功"。
     而 --mirror 支（上面那行）一直是如实回退出码的 —— 同一文件两套口径，属遗漏。
     本文件头注释自己写着"备份的意义在离机那一份""同盘复制不是备份"，所以这里必须如实报失败。 */
  const m = mirrorAll(log);   // 每次都推一次离机（幂等、增量）
  log('  本机位置：' + BACKUP + '   ← 同盘副本，防误删');
  log('  离机位置：' + (mirrorTarget() || '（未配置——建 _影像镜像.txt）') + '   ← 真备份，防硬盘坏');
  if (!m.ok) {
    console.error('✖ 离机镜像未成功（' + (m.reason || ('copy 出错 ' + (m.err | 0) + ' 项')) +
      '）：本机副本已更新，但**真备份**没落盘 ⇒ 退出码 1');
    process.exitCode = 1;
  }
}

main();