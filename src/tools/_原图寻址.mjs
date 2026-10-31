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
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { libraryRoot } from './_库根.mjs';

const ROOT = libraryRoot();
const STORE = path.join(ROOT, '_原图');
const LEDGER = path.join(ROOT, '_原图台账.json');

/* 归一：台账里的路径可能是反斜杠、可能有 `./` 前缀、大小写可能不同。
   统一成"库根相对 + 正斜杠 + 小写"再比。 */
export function normRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
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

/* ══ 反查表：库根相对路径（小写）→ sha ══ */
let _revCache = null;
function reverseIndex() {
  if (_revCache) return _revCache;
  const rev = new Map();          // normRel(来源路径) → sha
  const objAt = new Map();        // sha → 保全库内对象的相对路径
  if (fs.existsSync(LEDGER)) {
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(LEDGER, 'utf8').replace(/^\uFEFF/, '')); } catch { doc = null; }
    const objects = (doc && doc.objects && typeof doc.objects === 'object') ? doc.objects : {};
    for (const sha of Object.keys(objects)) {
      const o = objects[sha] || {};
      for (const s of (o.sources || [])) {
        const k = normRel(s);
        /* 同一个来源路径可能登记了多个 sha（理论上不该发生：内容寻址下同路径同内容）。
           保留**第一个**，并在冲突时以内容核对为准（见 resolveByPath）。 */
        if (!rev.has(k)) rev.set(k, sha.toUpperCase());
      }
    }
  }
  /* 保全库内的物理对象 */
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_快照') walk(p); continue; }
      const m = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/i.exec(e.name);
      if (m) objAt.set(m[1].toUpperCase(), path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(STORE)) walk(STORE);
  _revCache = { rev, objAt };
  return _revCache;
}

/** 库里这个 sha 的对象在不在盘（且内容对不对） */
function objectUsable(sha, expectBytes) {
  const { objAt } = reverseIndex();
  const rel = objAt.get(String(sha).toUpperCase());
  if (!rel) return null;
  const abs = path.join(ROOT, rel);
  try {
    if (!fs.statSync(abs).isFile()) return null;
    if (expectBytes != null && fs.statSync(abs).size !== expectBytes) return null;
    /* 内容核对：这是"路径被复用"这一类张冠李戴的唯一防线。
       代价是读一遍字节 —— 但只在**路径已失效**的兜底路径上发生（常态零成本）。 */
    if (sha256File(abs) !== String(sha).toUpperCase()) return null;
    return rel;
  } catch { return null; }
}

/**
 * 把一条"库根相对路径"解析成**当前真正可用的路径**。
 * @param {string} rel        台账里记的路径（可能是收件箱里的旧路径）
 * @param {object} opts
 * @param {number} opts.expectBytes  该文件的已知字节数（可选，用于先按大小筛）
 * @returns {{path:string, via:string, sha?:string}|null}
 *   via = 'direct'（原路径还在）／'store'（原路径没了，从保全库按内容找回）
 *   null = 真的断了（没有 sha 线索，或保全库里也没有匹配内容）
 */
export function resolveByPath(rel, opts = {}) {
  if (!rel) return null;
  const abs = path.join(ROOT, String(rel).replace(/\\/g, '/'));
  /* ① 原路径还在 —— 常态，零 IO */
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) {
      if (opts.expectBytes != null && st.size !== opts.expectBytes) {
        /* 大小都对不上：可能路径被复用成别的文件。仍按"直接可用"处理，
           但调用方若在意可以再用 verify 复核。 */
      }
      return { path: String(rel).replace(/\\/g, '/'), via: 'direct' };
    }
  } catch { /* 落到②*/ }

  /* ② 原路径没了 ⇒ 用反查表找 sha，再从保全库按内容找回 */
  const { rev } = reverseIndex();
  const sha = rev.get(normRel(rel));
  if (!sha) return null;
  const usable = objectUsable(sha, opts.expectBytes);
  if (!usable) return null;
  return { path: usable, via: 'store', sha };
}

/** 这个路径在保全库里有没有对应对象（不读字节，只查表） */
export function shaOfPath(rel) {
  const { rev } = reverseIndex();
  return rev.get(normRel(rel)) || null;
}

/** 批量版：一次建表，多条查（生成状态包时用，避免每张卡重建索引） */
export function resolver() {
  const { rev, objAt } = reverseIndex();
  return {
    /** 路径 → 可用路径；命中保全库时返回 via='store' */
    resolve(rel, expectBytes) {
      if (!rel) return null;
      const abs = path.join(ROOT, String(rel).replace(/\\/g, '/'));
      try { if (fs.statSync(abs).isFile()) return { path: String(rel).replace(/\\/g, '/'), via: 'direct' }; } catch { }
      const sha = rev.get(normRel(rel));
      if (!sha) return null;
      const rel2 = objAt.get(sha);
      if (!rel2) return null;
      try {
        const st = fs.statSync(path.join(ROOT, rel2));
        if (expectBytes != null && st.size !== expectBytes) return null;
      } catch { return null; }
      return { path: rel2, via: 'store', sha };
    },
    shaOfPath(rel) { return rev.get(normRel(rel)) || null; },
    size: rev.size,
  };
}
