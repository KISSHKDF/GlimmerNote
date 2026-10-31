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
 *   ⚠ 2026-10-12 第二次加固（同盘副本 ≠ 备份）：
 *     ① 判定口径从「文件名正则猜」改为「**台账反查 ∪ 目录规则 ∪ 卡目录整页截图**」；
 *     ② 新增**离机镜像**（`_影像镜像.txt` 配置落点，默认指向另一块物理盘）——
 *        `_影像备份\` 与原件同盘时，硬盘一坏两边一起没，那不叫备份；
 *     ③ 新增**覆盖率体检**：`--verify/--status` 输出「已备份 N/应备份 M + 百分比」。
 *
 *   ⚠⚠ 2026-10-31 第三次加固：**分母不能再由工具自己挑**（本轮核心改动）。
 *     实测（2026-10-31 全库扫描）：库内影像 1298 个 / 1070.6 MB，其中**明显可重建**的只有
 *     178 个（`_crops\` 裁切中间产物 144 + `tiles\` 组卷平铺 25 + `组卷\` 成品 PDF 9），
 *     其余 1120 个是「不可证明可重建的」，必须保全。
 *     而旧口径是**白名单式**的：只认「文件名切片正则 ∪ 台账 page 反查 ∪ 原件目录正则」——
 *     不在任何规则里的影像**静默不备份**。实测这类有 271 个，其中 93 个不在可重建集合里
 *     （`待办证据\`、`_笔形\`、`_撤卡留档\`、卡片 `题干.jpg` 等）；按 sha256 逐字节比对，
 *     93 个里有 80 个 / 19.4 MB 在本机备份与离机镜像里**都没有任何同内容副本**，
 *     只存在于同一块机械盘上 —— 这是当前全项目唯一真正会永久丢数据的口子。
 *     所以口径反过来：**分母 = 全库扫描 − 显式声明的可重建集合**（`REBUILDABLE_RE`）。
 *     新增任何目录（如内容寻址库 `_原图\`）**默认进分母**；要排除必须写进 `REBUILDABLE_RE`
 *     并在那里说清"为什么它可重做"——这就是"声明制"与"规则猜"的区别。
 *     同一轮修掉三个同源缺陷（都在本文件）：
 *       ① 镜像跳过判据原先只比 `size`（同大小不同内容永远不推，镜像里那份坏的永远修不好）；
 *       ② 镜像里「源已删除」的陈旧件从不报告（实测 169 个 / 45.1 MB，只报告不删除）；
 *       ③ `--status` 永远 exit 0，而 `--verify` 会 exit 2 ⇒ 按退出码判断的自动化（计划任务、
 *          体检）把"没备份好"记成"备份成功"。现在两个模式共用同一个判据 `coverageVerdict()`。
 *
 * 备份策略：**增量 + 幂等**。已存在且内容（sha1）一致的直接跳过，
 * 所以可以每次入库后随手跑一次，不会重复占空间、不会打断流程。
 *
 *   ⚠ 2026-10-31 再补一处（外部评审点名的口子，实测存在）：
 *     `_原图\`（内容寻址保全库）里除了影像对象，还有 **5 个非影像对象**
 *     （`_来源映射.csv` ×3、`_答案页映射.csv`、某题 `…独立重做用.md`）。它们是**人工判读产物**：
 *     页码偏移规则、原文件名↔归档名↔sha 对应、胶带遮挡复原依据 —— **不能从任何原图推出**，
 *     丢一次就永远补不回来。而旧的收集口径只看影像扩展名 ⇒ 这 5 个既不在分母、也从没备份过
 *     （实测：本机备份与离机镜像里都找不到同内容副本，只在 D 盘机械盘上）。
 *     现在判据一句话：**「原图库里有什么，就必须备份什么」** —— `_原图\` 下按内容全收，
 *     唯一的排除项是 `*.tmp`（写一半的半成品）与 `_快照\`（库自身可再生的内部快照）。
 *
 * 用法：
 *   node _影像备份.mjs            # 增量备份 + 自动推离机镜像（日常就用这个）
 *   node _影像备份.mjs --verify   # 只校验：备份与源是否一致 + 覆盖率体检，不写入
 *   node _影像备份.mjs --status   # 只看统计（分母/覆盖率/缺失/镜像陈旧件），同样按覆盖率判红
 *   node _影像备份.mjs --mirror   # 只推离机镜像
 *
 * 退出码（全模式同一套口径，2026-10-31 统一）：
 *   0 = 分母内全部已备份（且镜像推送成功）
 *   1 = 有该备的没备上 / 镜像推送失败 / 备份内容与源不一致
 *   2 = 覆盖率异常偏低或分母为 0（判定口径退化——"分母被改回去"这种缺陷必须能自动红）
 *
 * 约定（写进开发规范，由 _工具\裁图.ps1 与人工入库流程共同遵守）：
 *   · 收到新的原片 → 立刻跑一次本脚本（原件入库即备份，不等切片）
 *   · 切片成功之后 → 再跑一次本脚本（切片入库即备份）
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { libraryRoot } from './_库根.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 是**库根**（影像与台账都在库里），不是工具目录。 */
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
/** 备份落盘的两个桶（只决定落盘子目录，**不影响分母**；新增影像默认进「原件」） */
const KINDS = ['原件', '切片'];

/* 题库根下**不算"库内影像"**的目录：工具自身、自测区、归档区、程序/文档目录。
   它们不进分母不是因为"可重建"，而是因为它们不是孩子错题链路的影像（`_影像备份\` 是自身，
   扫它会自我递归）。注意口径后果：**这里是唯一一处按目录整体排除**，所以名单要短、要有理由；
   判断"某个影像要不要保"的权威判据只有一个 —— 它在库内、且不在 `REBUILDABLE_RE` 里。 */
const SKIP_DIRS = new Set([
  '_影像备份',   // 自身
  '_probe',      // 探针/自测截图
  '_桌面', '_桌面v2', '_archive', '_备份-真源', 'tests', 'docs', '.git', 'node_modules',
  'wv2-profile',
]);

/* ══ 可重建集合（**唯一**允许不进分母的东西）══
   判据是"显式声明"，不是"文件名正则猜"：
     · `_crops\`   裁切中间产物（有原件就能重裁）
     · `tiles\`   组卷平铺（有原件就能重排；实测 25 个）
     · `组卷\`    成品 PDF（有卡片就能重印；实测 9 个）
     · `_work-*` / `zzznew`  加工临时目录（同族中间产物）
   ⚠ 必须按**路径段**判：`_crops` 会出现在**路径中段**（如 `九年级/原卷/_crops/a1.png`），
     只判首段就漏 —— 2026-10-12 首次实跑踩过这个坑（覆盖率虚高 208 条）。
   ⚠ 往这里加目录 = 声明"这类丢了能重做"。加错的后果不是多备几个文件，
     而是**该保的影像从此静默不进分母**（这正是 2026-10-31 修的那类缺陷）。 */
const REBUILDABLE_RE = /(^|\/)_crops(\/|$)|(^|\/)tiles(\/|$)|(^|\/)组卷(\/|$)|(^|\/)_work-[^/]*(\/|$)|(^|\/)zzznew(\/|$)/;

/* ══ 内容寻址保全库 `_原图\`：**按内容全收，不看扩展名** ══
   为什么不能只看影像扩展名（2026-10-31 外部评审点名的口子，实测存在）：
   `_原图\` 里除了影像对象，还有 5 个**非影像对象**（`_来源映射.csv` ×3、`_答案页映射.csv`、
   某题 `…独立重做用.md`）。它们是**人工判读产物** —— 页码偏移规则、原文件名↔归档名↔sha 对应、
   胶带遮挡复原依据 —— **不能从任何原图推出**，丢一次就永远补不回来。
   判据一句话：**「原图库里有什么，就必须备份什么」**。
   排除项只有两类，且都不是"对象"：
     · `*.tmp`   写入过程中的半成品（写到一半就没了的东西不算对象）
     · `_快照\`  库自身的内部快照（可再生成，且单个清单就有十几万字节）
   ⚠ 这两条排除是**穷举**的：新增任何排除都要问一句"它能不能从库里其它东西再生成"。 */
const STORE_DIR = '_原图';
const STORE_SNAPSHOT = '_快照';
const isStorePath = rel => rel === STORE_DIR || rel.startsWith(STORE_DIR + '/');

/* 下面三条 2026-10-31 起**只用于标注 why**（"为什么这个文件在分母里"），
   不再决定"备不备" —— 决定权已经交给"全量减可重建"。留着是因为排查时要知道
   某个文件是靠哪条线索被识别成原件的，而不是靠"兜底扫描"。 */
const SLICE_RE = /^(题图|裁图|crop)/i;            // 卡目录切片 → 「切片」桶
const ORIGIN_DIR_RE = /(原卷|_收件箱|整页|原件)/;
const CARD_ORIGIN_RE = /^原卷截图/;

/** 从台账反查：所有被卡片引用的 page 相对路径（已是 posix 形态）。只用于 why 标注。 */
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
      continue;
    }
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    /* ★ 2026-10-31：`_原图\`（内容寻址保全库）**按内容全收，不看扩展名** ——
       里面的 `_来源映射.csv` / `_答案页映射.csv` / 某题 `.md` 是人工判读产物，
       不能从任何原图推出（见上面 STORE_DIR 那段）。排除项只有 `.tmp` 与 `_快照\`。 */
    if (isStorePath(rel)) {
      if (/\.tmp$/i.test(e.name)) continue;
      if (rel.split('/').includes(STORE_SNAPSHOT)) continue;
      out.push(full);
      continue;
    }
    if (IMG_EXT.test(e.name)) out.push(full);
  }
}

/** 内容指纹（sha1 前 16 位十六进制）。
 *  ★ 2026-10-31：改成**流式**读。影像里有 1GB 级 PDF，旧的 `readFileSync` 整份进内存
 *  在镜像逐文件比对时会把进程撑爆（新判据要比两边的内容，调用次数比改前多一倍）。 */
function sha1(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = crypto.createHash('sha1');
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    return h.digest('hex').slice(0, 16);
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { } } }
}

/** 递归列目录下的文件（posix 相对路径）。镜像推送、陈旧件报告、备份统计共用。 */
function listFiles(dir) {
  const out = [];
  (function w(d, rel) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) w(f, r); else out.push(r);
    }
  })(dir, '');
  return out;
}
const joinRel = (base, rel) => path.join(base, ...rel.split('/'));

/**
 * 收集**全部**应备份对象：全库扫描 − 显式可重建集合（2026-10-31 改口径，见文件头）。
 * 返回 { origin, slice, rebuildable, total }：
 *   total       = 全库扫描到的对象个数（分母的原料，无规则筛选）
 *   rebuildable = 被显式声明为可重建而排除的个数（必须在输出里可见，否则又是"工具自己挑分母"）
 *   origin/slice= 分母本体，只按落盘桶分组 + 带 why 说明
 * 判定顺序：① 显式可重建集合排除；② `_原图\` 库对象全收（不看扩展名）→「原件」；
 *          ③ 其余按名字决定落哪个桶。
 * 注意：**没有任何一条规则命中时也照样进分母**（why 会写"全库扫描"）——
 *   这就是 2026-10-31 修掉的那个口子：旧口径里"不在任何规则内"= 静默不备份。
 */
function collect() {
  const all = [];
  walk(ROOT, all);
  const pages = ledgerPages();
  const origin = [], slice = [], rebuildable = [];
  for (const abs of all) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (REBUILDABLE_RE.test(rel)) { rebuildable.push(rel); continue; }
    /* `_原图\` 库对象：影像与非影像一律进「原件」桶（它们都是"原图库里有什么"的一部分） */
    if (isStorePath(rel)) { origin.push({ abs, rel, why: '原图库对象' }); continue; }
    const base = path.basename(abs);
    let why;
    if (SLICE_RE.test(base)) why = '卡目录切片';
    else if (pages.has(rel)) why = '台账 page 字段';
    else if (CARD_ORIGIN_RE.test(base)) why = '卡目录原卷截图';
    else if (ORIGIN_DIR_RE.test(rel)) why = '原件目录规则';
    else why = '全库扫描（无明规则命中 ⇒ 仍属不可复现影像）';
    (SLICE_RE.test(base) ? slice : origin).push({ abs, rel, why });
  }
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  origin.sort(byRel); slice.sort(byRel); rebuildable.sort();
  return { origin, slice, rebuildable, total: all.length };
}

/** 可重建集合的明细（写进输出，让"分母被人挑掉多少"一眼可核） */
function rebuildableBreakdown(list) {
  const out = new Map();
  for (const rel of list) {
    const segs = rel.split('/');
    const seg = segs.find(s => s === '_crops' || s === 'tiles' || s === '组卷' || s === 'zzznew' || /^_work-/.test(s));
    const k = seg || '（其他）';
    out.set(k, (out.get(k) || 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(' / ');
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
  for (const r of listFiles(dir)) { n++; try { size += fs.statSync(joinRel(dir, r)).size; } catch { } }
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
  let copied = 0, same = 0, err = 0;
  for (const kind of KINDS) {
    const src = path.join(BACKUP, kind);
    if (!fs.existsSync(src)) continue;
    for (const r of listFiles(src)) {
      const s = joinRel(src, r), d = path.join(tgt, kind, ...r.split('/'));
      try {
        /* ★ 2026-10-31：跳过判据从「size 相同」改成「**内容**（sha1）相同」。
           改前只比 size ⇒ 同大小不同内容的镜像副本**永远**不会被修正：
           工具报"备份在"，可镜像里那份其实与源不同（正是"备份看着在、其实坏了"的形态）。
           size 只作廉价前置筛（大小不同直接覆盖），最终判据是内容哈希。 */
        if (fs.existsSync(d)) {
          const ss = fs.statSync(s), ds = fs.statSync(d);
          if (ds.size === ss.size) {
            const hs = sha1(s), hd = sha1(d);
            if (hs !== null && hs === hd) { same++; continue; }
          }
        }
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d + '.tmp'); fs.renameSync(d + '.tmp', d); copied++;
      } catch { err++; }
    }
  }
  log('  [离机] → ' + tgt + '  新增 ' + copied + ' 个，内容一致跳过 ' + same + ' 个，失败 ' + err + ' 个');
  return { ok: err === 0, copied, same, err };
}

/** 镜像里的**陈旧件**：镜像有、本机备份已无（源被删 / 改名 / 被排除后，旧副本还留在镜像里）。
    ★ 2026-10-31 新增。**只报告，不删除**：删除是不可逆动作（本仓纪律：不可逆决定要问），
    而"镜像里多出来的东西"可能是某份唯一副本；清理必须由人看清单后自己决定。
    改前这些件一个都不报 —— 实测 169 个 / 45.1 MB，占着镜像空间却无人知晓。 */
function staleInMirror(log) {
  const tgt = mirrorTarget();
  if (!tgt || !fs.existsSync(tgt)) { log('  镜像陈旧件：未配置/未落盘镜像，无法统计'); return { known: false, n: 0, size: 0, list: [] }; }
  const local = new Set();
  for (const kind of KINDS) for (const r of listFiles(path.join(BACKUP, kind))) local.add(kind + '/' + r);
  let n = 0, size = 0;
  const list = [];
  for (const kind of KINDS) {
    for (const r of listFiles(path.join(tgt, kind))) {
      if (local.has(kind + '/' + r)) continue;
      n++; list.push(kind + '/' + r);
      try { size += fs.statSync(path.join(tgt, kind, ...r.split('/'))).size; } catch { }
    }
  }
  list.sort();
  log('  镜像陈旧件：' + n + ' 个 ' + fmtSize(size) + '（镜像有、本机备份已无；**只报告不删除**）');
  for (const x of list.slice(0, 5)) log('    - ' + x);
  if (list.length > 5) log('    … 还有 ' + (list.length - 5) + ' 条');
  return { known: true, n, size, list };
}

/** 覆盖率体检：应备份 vs 已备份（含离机）。
    铁律（2026-10-12 立，2026-10-31 加强）：备份工具的绿灯只能证明"它自己选中的文件是好的"，
    必须额外报出**分母与覆盖率**，而且分母必须是"全库减可重建"这个扫描结果，
    不是工具自己按名字挑出来的那一撮。三个数必须齐：应备份 / 已备份 / 缺失（缺失还要能列出）。 */
function coverage(origin, slice, log) {
  let need = 0, have = 0, needB = 0, haveB = 0, missB = 0;
  const missing = [];
  for (const [kind, list] of [['原件', origin], ['切片', slice]]) {
    for (const it of list) {
      need++;
      let sz = 0; try { sz = fs.statSync(it.abs).size; } catch { }
      needB += sz;
      const dst = path.join(BACKUP, kind, it.rel.replace(/^[/\\]+/, ''));
      if (fs.existsSync(dst)) { have++; haveB += sz; }
      else { missing.push(kind + ' ' + it.rel); missB += sz; }
    }
  }
  const pct = need ? (have / need * 100).toFixed(1) : '100.0';
  log('  覆盖率：应备份 ' + need + ' / 已备份 ' + have + ' / 缺失 ' + missing.length +
    '（' + pct + '%），字节 ' + fmtSize(haveB) + ' / ' + fmtSize(needB) + '，缺失 ' + fmtSize(missB));
  if (missing.length) listMissing(missing, log);
  return { need, have, missing, missB, pct };
}

/** 列出未备份项。
    ★ 2026-10-31：从"前 20 条"改成**按顶层目录分组**（大区域列前 3 条 + 计数，小区域全列）。
    原因：库里有 `_原图\`（内容寻址库，一个目录几百上千个）之后，"按路径排的前 20 条"会被
    一个区域刷满，`待办证据\`、`_笔形\`、`_撤卡留档\` 这些**真正需要人去看**的地方反而看不见。
    "缺失要能列出"这条要求的意思是"人能从清单上看手"，不是"打 20 行"。 */
function listMissing(missing, log) {
  const groups = new Map();
  for (const m of missing) {
    const sp = m.indexOf(' ');
    const kind = m.slice(0, sp), rel = m.slice(sp + 1);
    const top = rel.split('/')[0] || rel;
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(kind + ' ' + rel);
  }
  const list = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  log('  未备份按顶层目录：' + list.slice(0, 8).map(([k, v]) => k + ' ' + v.length).join(' / ') +
    (list.length > 8 ? ' / …（共 ' + list.length + ' 个区域）' : ''));
  const shown = list.slice(0, 12);
  for (const [k, v] of shown) {
    for (const x of v.slice(0, 3)) log('    - ' + x);
    if (v.length > 3) log('    … ' + k + ' 还有 ' + (v.length - 3) + ' 条');
  }
  if (list.length > shown.length) log('    … 另有 ' + (list.length - shown.length) + ' 个区域未展开');
}

/* ══ 覆盖率判红的**唯一**判据（`--status` / `--verify` / 默认模式共用）══
   改前两套口径：`--status` 永远 exit 0（只看统计），只有 `--verify` 会 exit 2
   ⇒ 按退出码判断的自动化（计划任务、体检脚本）把"没备份好"记成"备份成功"。
   现在"没备份好"在任何模式下都是非 0，判据只写在这里一份（两份实现必然漂移，本仓 L-286）。
   退出码语义见文件头。 */
const LOW_PCT = 50;
function coverageVerdict(cov, total) {
  if (cov.need === 0 && total > 0) {
    return { code: 2, reason: '分母为 0，但库里有 ' + total + ' 个影像 ⇒ 可重建集合声明过宽（会把该保的影像全排除掉）' };
  }
  if (Number(cov.pct) < LOW_PCT) {
    return { code: 2, reason: '覆盖率异常偏低（' + cov.pct + '% < ' + LOW_PCT + '%）：先查判定口径（分母被改坏/被扩大），也可能是库刚进了一大批新影像还没跑过备份 —— 两种都不能当"备份成功"' };
  }
  if (cov.missing.length) {
    return { code: 1, reason: '有 ' + cov.missing.length + ' 个应备份影像未备份（覆盖率 ' + cov.pct + '%，缺 ' + fmtSize(cov.missB) + '）' };
  }
  return { code: 0, reason: '' };
}

function main() {
  const mode = process.argv[2] || '';
  const { origin, slice, rebuildable, total } = collect();
  const log = (s) => console.log(s);

  log('【错题本 · 影像备份】' + new Date().toLocaleString('zh-CN'));
  log('  源：全库扫描 ' + total + ' 个（库内影像 + `_原图\` 库对象，按内容全收），' +
    '其中显式声明可重建 ' + rebuildable.length + ' 个不计入分母' +
    (rebuildable.length ? '（' + rebuildableBreakdown(rebuildable) + '）' : '') +
    ' ⇒ 应备份 原件 ' + origin.length + ' 个 / 切片 ' + slice.length + ' 个');

  if (mode === '--status') {
    const o = statsOf(path.join(BACKUP, '原件'));
    const s = statsOf(path.join(BACKUP, '切片'));
    log('  本机备份：原件 ' + o.n + ' 个 ' + fmtSize(o.size) + ' / 切片 ' + s.n + ' 个 ' + fmtSize(s.size));
    const cov = coverage(origin, slice, log);
    const tgt = mirrorTarget();
    log('  离机镜像：' + (tgt || '（未配置——建 _影像镜像.txt）'));
    staleInMirror(log);
    const v = coverageVerdict(cov, total);
    if (v.code) { console.error('✖ ' + v.reason + ' ⇒ 退出码 ' + v.code); process.exit(v.code); }
    log('  ✔ 分母内全部已备份（' + cov.need + ' 个）');
    process.exit(0);
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
    staleInMirror(log);
    /* 与 --status 同一个判据：覆盖率不达标就红，异常项也红 —— 两条都过才算备份好 */
    const v = coverageVerdict(cov, total);
    if (v.code) { console.error('✖ ' + v.reason + ' ⇒ 退出码 ' + v.code); process.exit(v.code); }
    if (bad) { console.error('  校验异常 ' + bad + ' 项（备份与源内容不一致），退出码 1'); process.exit(1); }
    log('  ✔ 校验通过：' + ok + ' 个与源逐字节一致，分母无缺失');
    process.exit(0);
  }

  if (mode === '--mirror') {
    const r = mirrorAll(log);
    staleInMirror(log);
    process.exit(r.ok ? 0 : 1);
  }

  // 默认：增量备份 + 自动镜像到离机盘（备份的意义在离机那一份）
  ensureDirs();
  const c = { 原件: 0, 切片: 0 }, s = { 原件: 0, 切片: 0 };
  let fail = 0;
  for (const [kind, list] of [['原件', origin], ['切片', slice]]) {
    for (const it of list) {
      let r;
      /* 单个文件复制失败不许打断整轮：否则"备到一半就崩"⇒ 没有覆盖率报告、退出码也没有落脚点。
         失败必须计数并在最后判红（静默降级是本仓最忌讳的形态）。 */
      try { r = copyOne(it, kind); } catch (e) { r = 'err'; }
      if (r === 'copy') c[kind]++;
      else if (r === 'skip') s[kind]++;
      else { fail++; log('  [FAIL] 复制失败 ' + kind + ' ' + it.rel); }
    }
  }
  log('  新增：原件 ' + c['原件'] + ' / 切片 ' + c['切片'] + '（复制失败 ' + fail + '）');
  log('  跳过（内容已一致）：原件 ' + s['原件'] + ' / 切片 ' + s['切片']);
  const o = statsOf(path.join(BACKUP, '原件'));
  const sl = statsOf(path.join(BACKUP, '切片'));
  log('  本机备份：原件 ' + o.n + ' 个 ' + fmtSize(o.size) + ' / 切片 ' + sl.n + ' 个 ' + fmtSize(sl.size));
  const cov = coverage(origin, slice, log);
  /* ★ 2026-10-29（R2 审计 D-03）：默认模式原先把 mirrorAll 的返回值**丢掉** ⇒ 离机镜像失败
     （未配置落点 / 镜像盘没插 / 落点与题库同卷 / 逐个 copy 出错）仍然退出 0。
     本文件头自己写着"备份的意义在离机那一份""同盘复制不是备份"，所以这里必须如实报失败。 */
  const m = mirrorAll(log);   // 每次都推一次离机（幂等、增量）
  staleInMirror(log);
  log('  本机位置：' + BACKUP + '   ← 同盘副本，防误删');
  log('  离机位置：' + (mirrorTarget() || '（未配置——建 _影像镜像.txt）') + '   ← 真备份，防硬盘坏');
  const v = coverageVerdict(cov, total);
  if (!m.ok) {
    console.error('✖ 离机镜像未成功（' + (m.reason || ('copy 出错 ' + (m.err | 0) + ' 项')) +
      '）：本机副本已更新，但**真备份**没落盘 ⇒ 退出码 1');
    process.exitCode = 1;
  }
  if (v.code) {
    console.error('✖ ' + v.reason + ' ⇒ 退出码 ' + v.code);
    process.exitCode = Math.max(process.exitCode | 0, v.code);
  }
  if (!m.ok || v.code) return;   // 已在上面如实报过（退出码也设好了）
  log('  ✔ 默认模式完成：分母内全部已备份，且已推离机');
}

main();