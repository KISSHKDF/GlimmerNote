#!/usr/bin/env node
/**
 * 拾光小册 · 原图寻址（路径 ⇄ 身份 互查）
 *
 * ══ 为什么有这个文件 ══
 * 用户定的前提：**原图是唯一不可复现的数据，是核心。**
 * 原来的做法是"卡片上贴一张纸条，写着原件在哪个抽屉"——也就是台账里存**路径字符串**。
 * 路径会被改名、被搬、被"转正另存"，实测同一张照片在台账里同时存在两套路径
 * （`_收件箱/…/p08-src61.jpg` ↔ `九年级/英语/原卷/课课练9上-p08-src61.jpg`，sha 相同），
 * 只认路径的判据在 256 张里漏判 4 张。
 *
 * 所以身份必须是**内容哈希**。但**不能**因此把 452 张卡的台账全改一遍：
 * `_原卷台账.mjs` 的 `生成/采集/回填/合并` 四个写入口都会重建或改写条目，
 * 一次性改格式风险极高（而且 135 条人工精修条目不能被机器碰）。
 *
 * **本文件给出的解法：路径只是"提示"，哈希才是"身份"，两者之间有一张反查表。**
 * 卡片上的纸条不动；读的时候多走一步：
 *   ① 纸条上的路径还在 → 直接用（零成本，行为与从前完全一致）；
 *   ② 路径没了（收件箱被清空 / 原件被改名 / 目录被搬）→ 用反查表把路径换成 sha，
 *      再从内容寻址的保全库 `_原图\` 里找到**字节完全相同**的那一份。
 *
 * 这样：**清空收件箱不会让任何一张卡断链**，而台账一个字节都不用改。
 *
 * ══ 反查表从哪来 ══
 * `_原图台账.json`（内容寻址保全库的名册）里每个对象都记着它的 `sources`
 * ——即"它当初是从哪些路径收进来的"。实测 939 个对象覆盖 1134 条来源路径，
 * 452 张卡里 442 张有 `page` 的卡，**442/442 都能通过这张表查到 sha**。
 *
 * ══ 边界（不许含糊）══
 * · 反查是**按内容**确认的：命中后还要核对目标文件的 sha256 等于登记值，
 *   避免"路径被复用成另一个文件"导致张冠李戴。
 * · 找不到就**明确报"这条断了"**，不许静默返回空 —— 藏掉一条断链比报错危害大得多。
 * · 本文件**只读**：不写任何文件、不改任何台账。
 *
 * ══ ★ 2026-11-03（P1-2 整改）两处"静默"被拿掉 ══
 * ① `opts.expectBytes` 给了却**不比**：旧 `resolveByPath` 在原路径还在时只 `statSync` 一下
 *    就 `return direct`，`expectBytes` 与真实大小不符也照样"直接可用"（那段是个空 if + 注释）
 *    ⇒ 台账路径被复用成另一个文件时，调用方会拿到**字节不符**的路径。
 *    现在：给了 `expectBytes` 就必须比大小；不符 ⇒ 不再判 direct，落 ② 按内容找回；
 *    找不回 ⇒ null + 可归因原因。**`expectBytes` 为 null 时保持"零 IO 常态"**（热路径语义，
 *    见下面 explain() 的 ① 分支注释）—— 那正是 452 张卡每次解析都走的路径。
 * ② 一个来源路径登记了**多个不同 sha** 时旧代码 `if (!rev.has(k)) rev.set(k, sha)`
 *    ＝**静默取第一个**。现在：有歧义的路径**不进** rev（任何 resolve 都拿不到它 ⇒ fail-closed，
 *    宁可报"这条定位不了"也不猜），全部 sha 留在 revAll 里由 `pathShas()` 如实报出，
 *    并在 stderr 打一条**可见**告警（去重，每路径一次）。真库实测：1162 条来源路径全部互不相同，
 *    即本改动**不动**既有兜底结果（回归基线见 tests\neg-orig-address-verify.cjs）。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { libraryRoot } from './_库根.mjs';

/* ★ 2026-11-03（批次 4）：库根**懒解析**（原先这里是三个顶层常量，出过一次真事故）。
   事故形态：本文件在**导入期**调 `libraryRoot()` ⇒ `_库根.mjs` 的缓存被"首访即定"，
   之后再设 `process.env.CTB_DATA`（各工具的 `--data` 正是这么做的）**不再生效** ——
   实测 `生成状态.mjs --data <临时库>` 会静默去读**另一个**库（本轮撞见：它读了真库/源码树），
   而"静默读错/写错地方"正是本仓最忌讳的形态。
   与批次 2 给 `_路径护栏.mjs` 做的处理同款：把顶层常量改成函数调用。
   ⚠ 谁也不要把它改回顶层常量 —— 回归锁见 `tests\neg-v2-review-sidebyside.cjs`（`--data` 必须真的生效）。 */
const root = () => libraryRoot();
const storeDir = () => path.join(root(), '_原图');
const ledgerPath = () => path.join(root(), '_原图台账.json');

/* 归一：台账里的路径可能是反斜杠、可能有 `./` 前缀、大小写可能不同。
   统一成"库根相对 + 正斜杠 + 小写"再比。 */
export function normRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

/* 库根相对路径 → 前端消费的 URL 形态：反斜杠转正斜杠，再逐段 encodeURIComponent。
   ★ 2026-11-01：这份编码口径原先只活在 `生成状态.mjs:99` 的一行 const 里。
   `_状态刷新.mjs` 的"原图路径自愈"也要写同一个字段，两份实现一漂移就会出现
   "同一个文件两种写法"（前端 decode 后等效、断言/门禁却对不上）。所以搬到这里做
   **唯一实现**，两边 import 同一份。 */
export function encRel(rel) {
  return String(rel).split(path.sep).join('/').split('/').map(encodeURIComponent).join('/');
}

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

/* ══ 反查表：库根相对路径（小写）→ sha ══
   ★ 2026-11-03（P1-2）：一个来源路径可能登记**多个不同 sha**（同名件二次入库、路径被复用）。
   旧实现保留第一个 ⇒ 调用方拿到的是"猜的"身份，猜错就是把**另一份字节**当成这张卡的整页
   （本文件头号忌讳）。现在 rev 只收**唯一**映射；歧义路径一律不进 rev。
   revAll 是全量（含歧义），供 pathShas()/explain() 如实报出"到底有几个、分别是哪些"。 */
let _revCache = null;
let _revCacheRoot = null;   // 这份缓存是"给哪个库"建的（库根懒解析后必须记住，免得缓存跨库串用）
function reverseIndex() {
  /* ★ 2026-11-03（批次 4）：缓存连同**库根**一起判 —— 原先只看 `_revCache` 真假，
     一旦有谁在缓存建好之后再改库根（`--data`/`CTB_DATA` 迟到），就会拿**上一个库**的反查表去解析路径。
     "缓存属于哪个库"必须显式记下来，这是懒解析的必要配套，不是可选项。 */
  if (_revCache && _revCacheRoot === root()) return _revCache;
  const rev = new Map();          // normRel(来源路径) → sha（**仅唯一**；歧义路径不在其中）
  const revAll = new Map();       // normRel(来源路径) → Set(sha)（全量，含歧义）
  const objAt = new Map();        // sha → 保全库内对象的相对路径
  if (fs.existsSync(ledgerPath())) {
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8').replace(/^\uFEFF/, '')); } catch { doc = null; }
    const objects = (doc && doc.objects && typeof doc.objects === 'object') ? doc.objects : {};
    for (const sha of Object.keys(objects)) {
      const o = objects[sha] || {};
      const up = String(sha).toUpperCase();
      for (const s of (o.sources || [])) {
        const k = normRel(s);
        if (!k) continue;
        if (!revAll.has(k)) revAll.set(k, new Set());
        revAll.get(k).add(up);
      }
    }
  }
  for (const [k, set] of revAll) if (set.size === 1) rev.set(k, [...set][0]);
  /* 保全库内的物理对象 */
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_快照') walk(p); continue; }
      const m = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/i.exec(e.name);
      if (m) objAt.set(m[1].toUpperCase(), path.relative(root(), p).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(storeDir())) walk(storeDir());
  _revCache = { rev, revAll, objAt };
  _revCacheRoot = root();   // ★ 记下"这份缓存属于哪个库"（懒解析的必要配套，见 reverseIndex 开头）
  return _revCache;
}

/** 这个路径在台账里登记了哪些 sha（0 个 / 1 个 / N 个都如实返回，已排序去重）。
 *  与 `shaOfPath` 的分工：`shaOfPath` 只回答"能不能**唯一**定位"（歧义 ⇒ null），
 *  本函数回答"到底有几个、分别是哪些"——诊断与歧义信号用它。 */
export function pathShas(rel) {
  const { revAll } = reverseIndex();
  const set = revAll.get(normRel(rel));
  return set ? [...set].sort() : [];
}

/** 告警去重（每类问题每个路径只喊一次）：stderr 可见，但不会在 452 张卡的循环里刷屏 */
const _warned = new Set();
function warnOnce(key, msg) {
  if (_warned.has(key)) return;
  _warned.add(key);
  try { process.stderr.write('⚠ 原图寻址：' + msg + '\n'); } catch { /* 告警通道写不出去不该打断解析 */ }
}

/** 保全库里这个 sha 的对象在不在盘（且内容对不对）。
 *  verifyContent=false 只比大小 —— 批量版（resolver）走这条路：它被 452 张卡的热路径调用，
 *  每次都重算 sha256 会把"零 IO 常态"彻底毁掉（`_状态刷新.mjs` 的 pending 自愈就在这条路上）。
 *  单条版 `resolveByPath` 仍然默认 verifyContent=true（它本来就是核对路径）。 */
function lookupStore(sha, expectBytes, verifyContent) {
  const { objAt } = reverseIndex();
  const rel = objAt.get(String(sha).toUpperCase());
  if (!rel) return null;
  const abs = path.join(root(), rel);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (expectBytes != null && st.size !== expectBytes) return null;
    /* 内容核对：这是"路径被复用/对象被改写"这一类张冠李戴的唯一防线。 */
    if (verifyContent && sha256File(abs) !== String(sha).toUpperCase()) return null;
    return rel;
  } catch { return null; }
}

/**
 * ★ 2026-11-06：**"影像备份同路径副本"这一层已整体摘除**（用户定案 P10「一个字节一个家」，
 *   `_影像备份\` 退休）。原来的三层兜底（原路径 → 保全库 → 影像备份）现在只剩两层。
 *
 * 摘除前先做了**实测证明**（不是"看着像死代码"就删）：把 `_原图台账.json` 里全部 1,192 条
 * 引用路径各跑一遍 `explainPath()`，现状引擎的 status 分布是 `direct 918 / store 274`，
 * **`backup` 条数 = 0**；再把这一层变异成"永远返回 null"跑同一套 ⇒ 分布**逐字相同**。
 * 也就是说这一层早已不再承担任何一次解析 —— 它存在的理由是 2026-11-05 那批"收件箱照片被清掉、
 * 52 张卡全报导入原件失效"，而那批照片**现在已经进了 `_原图\`**（274 条走 store），
 * 兜底层成了纯死代码。判据留档见 `tests\neg-p10-image-homes.cjs`。
 */

/**
 * 一次解析的**可归因**结论（`resolveByPath` / `resolver().resolve` 共用同一个判据，
 * 避免两份实现漂移）。**不做任何 IO 之外的副作用**。
 * @returns {{status:string, code:string, path?:string, via?:string, sha?:string, shas?:string[], reason?:string}}
 *   status：
 *     'direct'       原路径在盘且（给了 expectBytes 时）字节数相符 —— 常态，**不读一个字节**
 *     'store'        原路径不可用（不存在 / 字节数不符）⇒ 已按内容从保全库找回
 *     'empty'        没给路径
 *     'ambiguous'    该路径在台账里对应**多个** sha ⇒ 拒绝猜（旧实现静默取第一个）
 *     'size-mismatch' 原路径还在但字节数不符，且按内容也找不回（两侧字节数都写进 reason）
 *     'store-missing' 台账里有唯一 sha，但保全库里没有可用对象（或对象字节数不符）
 *     'no-sha'       台账反查表里没有这个路径的任何线索
 */
function explain(rel, opts = {}) {
  const expect = opts.expectBytes;
  const verifyContent = opts.verifyContent !== false;   // 单条版默认核对内容；批量版按性能口径传 false
  if (!rel) return { status: 'empty', code: 'empty', reason: '没有给路径' };
  const relPosix = String(rel).replace(/\\/g, '/');
  const abs = path.join(root(), relPosix);
  let statOk = false, sizeOnDisk = null;
  try { const st = fs.statSync(abs); if (st.isFile()) { statOk = true; sizeOnDisk = st.size; } } catch { }
  /* ① 原路径在盘。★ `expectBytes == null` ⇒ **零 IO 常态**：一次 stat 直接放行，
        不读字节（452 张卡每次解析都走这里；这条性能语义不许破）。
        给了 `expectBytes` 才多比一个 size（仍是零字节读取）—— 大小不符意味着"路径可能被
        复用成别的文件"，此时**不许**再判 direct（P1-2 缺陷原状），落到 ② 按内容找回。 */
  if (statOk && (expect == null || sizeOnDisk === expect)) {
    return { status: 'direct', code: 'direct', path: relPosix, via: 'direct' };
  }
  /* ② 原路径不可用 ⇒ 用反查表找 sha，再从保全库按内容找回 */
  const shas = pathShas(rel);
  if (!shas.length) {
    /* ★ 2026-11-06（P10）：原来这里还有一层"去 `_影像备份\` 按同路径找副本"，已随镜像退休摘除。
       实测依据：全部 1,192 条引用的 status 分布里 `backup` 条数 = 0（见本文件上方那段注释）。 */
    return {
      status: 'no-sha', code: 'no-sha',
      reason: (statOk
        ? '原路径在盘但字节数 ' + sizeOnDisk + ' ≠ 期望 ' + expect + '；'
        : '原路径不在盘；') + '台账反查表里没有这个路径的任何 sha 线索 ⇒ 没有按内容找回的抓手' +
        '（保全库 `_原图\\` 里也没有它 —— 该路径从未入库过）',
    };
  }
  if (shas.length > 1) {
    return {
      status: 'ambiguous', code: 'ambiguous', shas,
      reason: '这个路径在 _原图台账.json 里同时对应 ' + shas.length + ' 个不同 sha（' +
        shas.map(s => s.slice(0, 12) + '…').join(' / ') + '）⇒ 判不出这份结果指哪一份字节，**拒绝猜**' +
        '（要么修正台账，要么按 sha 直接指定）',
    };
  }
  const sha = shas[0];
  const usable = lookupStore(sha, expect, verifyContent);
  if (usable) return { status: 'store', code: 'store', path: usable, via: 'store', sha };
  /* ★ 2026-11-06（P10）：原来这里还有"再看 `_影像备份\` 的同路径副本"这一层，已随镜像退休摘除。 */
  const sizeMismatch = statOk && expect != null;
  return {
    status: sizeMismatch ? 'size-mismatch' : 'store-missing',
    code: sizeMismatch ? 'size-mismatch' : 'store-missing',
    sha,
    reason: (sizeMismatch
      ? '原路径在盘但字节数 ' + sizeOnDisk + ' ≠ 期望 ' + expect + '；'
      : '原路径不在盘；') +
      '按内容找回 ' + sha.slice(0, 12) + '… 也失败（保全库里没有这个 sha 的可用对象' +
      (expect != null ? '，或它的字节数 ≠ ' + expect : '') + '）⇒ 真的断了，**不给字节不符的路径**',
  };
}


/**
 * 把一条"库根相对路径"解析成**当前真正可用的路径**。
 * @param {string} rel        台账里记的路径（可能是收件箱里的旧路径）
 * @param {object} opts
 * @param {number} opts.expectBytes  该文件的已知字节数（可选）。**给了就必须相符**：
 *   原路径在盘但大小不符 ⇒ 不再判 direct，改按内容找回；找不回 ⇒ null（附原因，见 explainPath）。
 *   不给 ⇒ 零 IO 常态（只 stat，不读字节）。
 * @returns {{path:string, via:string, sha?:string}|null}
 *   via = 'direct'（原路径还在且字节数相符）／'store'（原路径不可用，从保全库按内容找回）
 *   null = 真的断了（没有 sha 线索 / 歧义 / 保全库里也没有匹配内容）——原因走 explainPath()，
 *          同时在 stderr 留一条**去重的可见告警**（静默返回 null 正是 P1-2 那一类"藏掉断链"）
 */
export function resolveByPath(rel, opts = {}) {
  const ex = explain(rel, opts);
  if (ex.status === 'direct' || ex.status === 'store') {
    /* direct 不带 sha（旧形态就是这样，调用方可能逐字段比对）：只有 store 兜底才有确定的 sha */
    return ex.sha ? { path: ex.path, via: ex.via, sha: ex.sha } : { path: ex.path, via: ex.via };
  }
  if (ex.status !== 'empty') warnOnce(ex.status + '|' + normRel(rel), normRel(rel) + '：' + ex.reason);
  return null;
}

/** 解析的**可归因**结论（不改任何状态、不写任何东西）。
 *  为什么要有它：`resolveByPath` 只回 null，调用方分不清"没有这条线索 / 有线索但歧义 /
 *  字节对不上"——P1-2 的告警要求就是"别让调用方只能看到一个空"。 */
export function explainPath(rel, opts = {}) {
  return explain(rel, opts);
}

/** 这个路径在保全库里有没有对应对象（不读字节，只查表）。
 *  ★ 2026-11-03（P1-2）：歧义路径返回 **null**（旧实现返回第一个 sha）。
 *  要区分"没有线索"与"有多个线索"，用 pathShas() / explainPath()。 */
export function shaOfPath(rel) {
  const { rev } = reverseIndex();
  const hit = rev.get(normRel(rel)) || null;
  if (!hit) {
    const shas = pathShas(rel);
    if (shas.length > 1) warnOnce('sha-ambiguous|' + normRel(rel), normRel(rel) + '：登记了 ' + shas.length + ' 个不同 sha ⇒ shaOfPath 返回 null（不做静默取第一个）');
  }
  return hit;
}

/** 批量版：一次建表，多条查（生成状态包时用，避免每张卡重建索引）。
 *  ★ 2026-11-03（P1-2）：两条入口共用上面同一个 explain() 判据（原件里这里是**第二套实现**，
 *  与单条版口径不一致：direct 分支不比 expectBytes）。性能口径保留：
 *  expectBytes 为 null 时零 IO；expectBytes 给了才比大小；只有显式给了 expectBytes 才做内容核对
 *  （热路径被 452 张卡调用，每次都重算 sha256 会把"零 IO 常态"毁掉，见 lookupStore 注释）。 */
export function resolver() {
  const { rev } = reverseIndex();
  const shaOfPathFn = shaOfPath;   // 起个本地名：下面同名方法里直接写 shaOfPath() 读起来像递归
  return {
    /** 路径 → 可用路径；命中保全库时返回 via='store'（direct 不带 sha，与单条版同形） */
    resolve(rel, expectBytes) {
      const ex = explain(rel, { expectBytes, verifyContent: expectBytes != null });
      if (ex.status === 'direct' || ex.status === 'store') {
        return ex.sha ? { path: ex.path, via: ex.via, sha: ex.sha } : { path: ex.path, via: ex.via };
      }
      if (ex.status !== 'empty') warnOnce(ex.status + '|' + normRel(rel), normRel(rel) + '：' + ex.reason);
      return null;
    },
    /** 同上但给可归因结论（与单条版 explainPath 同一判据） */
    explain(rel, expectBytes) { return explain(rel, { expectBytes, verifyContent: expectBytes != null }); },
    /** 这个路径登记的全部 sha（0/1/N） */
    shasOf(rel) { return pathShas(rel); },
    /** 与单条版同一条判据（歧义 ⇒ null + 可见告警），不是"再写一遍取第一个" */
    shaOfPath(rel) { return shaOfPathFn(rel); },
    size: rev.size,
  };
}
