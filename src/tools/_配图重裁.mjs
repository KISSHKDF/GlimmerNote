#!/usr/bin/env node
/**
 * 拾光小册 · 配图重裁（第 2 级「清洗裁图」的机器实现）
 *
 * ══ 为什么有这个工具 ══
 * 2026-11-23 配图三级来源整改实测：`题图.jpg` 的尺寸不足（宽度 < 1000，印刷后线条不可辨）
 * 有 27 张。人工重裁一次要 5 分钟、且**每一步都不可复核**——这正是配图质量闸门
 * 想消灭的那种"改了但说不清改了什么"。
 *
 * 本工具把「按原卷重裁 + 放大 + 清洗」做成一条**可跑、可复核、零依赖**的命令：
 *   · 源页从**活路径或内容寻址保全库 `_原图\`** 找（不猜、不下载）；
 *   · 裁剪框用**任务 json 的 `figBbox`**（那是当初真的按它裁出这张图的框）；
 *   · 放大到入库器同一口径（1200 宽，`cropFigure` 的 maxW=1200）；
 *   · 清洗后**自动自检**（重新探测输出图的红笔残留），不靠"命令没报错"当成功。
 *
 * ⚠ **为什么不用原卷台账的 `box`**（实测踩到，写死在这里防止下一个人再踩）：
 *   `_原卷台账.json` 的 `box` 是**错题区域**（孩子作答 + 红笔批改 + 整道题），
 *   不是**插图区域**。拿它裁图 ⇒ 裁出来的是"带答案的题干文字"，正是 P0082 那种
 *   "图与题干对不上、直接泄答案"的缺陷来源。
 *   插图自己的框在 `_录题\t-*.json` 的 `cards[].figBbox`。
 *
 * ⚠ **放大救不了"本身就糊"的图**（M0070 实测）：
 *   照片型源（手机拍的作业本）放大后噪点满屏、线条反而更脏 ⇒ 那种必须回第 1 级
 *   （上网找印刷版原图）或第 3 级（矢量重画）。本工具**不假装**能救它：
 *   照片型源默认**拒绝**放大并报出来（见 --允许照片源 开关）。
 *
 * 用法：
 *   node src\tools\_配图重裁.mjs 列表 [--json]
 *   node src\tools\_配图重裁.mjs 计划 --card 学生|编号 [--json]
 *   node src\tools\_配图重裁.mjs 执行 --card 学生|编号 [--宽 1200] [--去红笔] [--干跑]
 *   node src\tools\_配图重裁.mjs 执行 --file <json>      # [{card, 宽?, 去红笔?}]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { libraryRoot, toolPath } from './_库根.mjs';
import { readJsonStrict, withLibWrite } from './_安全写.mjs';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';
import { indexFiles } from './_题库发现.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = libraryRoot();
/* 临时目录：优先系统 TEMP；**不写死本机路径**（`tests\portability.cjs` 会拦）。 */
const TMPDIR = process.env.TEMP || os.tmpdir();

/** 配图宽度下限（与 `_配图质量.mjs` 的 MIN_WIDTH 同口径） */
export const MIN_WIDTH = 1000;
/** 重裁后的目标宽度（与入库器 `cropFigure` 的 maxW=1200 同一口径） */
const TARGET_W = 1200;

/* ─────────── 保全库反查（原图内容寻址） ─────────── */
function loadLibraryManifest() {
  const p = path.join(ROOT, '_原图台账.json');
  if (!fs.existsSync(p)) return { objects: {} };
  try { return readJsonStrict(p, { shape: j => !!j.objects, what: 'objects', label: '_原图台账.json' }); } catch { return { objects: {} }; }
}
function buildSrcIndex() {
  const { objects } = loadLibraryManifest();
  const map = new Map();                       // 归一化源路径 → {abs, sha}
  for (const [sha, o] of Object.entries(objects)) {
    const lp = path.join(ROOT, '_原图', sha.slice(0, 2), sha + '.' + (o.ext || 'jpg'));
    for (const s of (o.sources || [])) {
      map.set(normalizeRel(s), { abs: fs.existsSync(lp) ? lp : null, sha });
    }
  }
  return map;
}
/** 源路径归一化：库里三种写法（相对 / 绝对 / 旧盘绝对）都归一到"库内相对路径"。
 *  ⚠ 不得在 tracked 文件里写真实学生化名（隐私门禁 `tests\repo-hygiene.cjs` 会拦）
 *     ⇒ 学生目录名**从磁盘上发现**，不写死在代码里。 */
export function normalizeRel(rel) {
  if (!rel) return '';
  let s = String(rel).replace(/\\/g, '/').trim();
  const m = s.match(/(_收件箱|_原图|_撤卡留档)\//);
  if (m) s = s.slice(s.indexOf(m[1]));
  else {
    /* 学生目录名：从库根的一级子目录里取（那两个以 _ 开头的才是系统目录） */
    let kids = [];
    try { kids = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_')).map(e => e.name); } catch { }
    for (const k of kids) {
      const i = s.indexOf(k + '/');
      if (i >= 0) { s = s.slice(i); break; }
    }
  }
  return s;
}

/* ─────────── 任务 json 里的 figBbox（插图自己的框） ─────────── */
function collectTaskFigBoxes() {
  const taskDir = path.join(ROOT, '_录题');
  const out = [];                              // {title, figBbox, img}
  if (!fs.existsSync(taskDir)) return out;
  const walk = (node, acc) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(v => walk(v, acc)); return; }
    if (node.figBbox && Array.isArray(node.figBbox) && node.figBbox.length === 4) {
      acc.push({ figBbox: node.figBbox.map(Number), title: String(node.title || ''), dir: String(node.dir || '') });
    }
    for (const v of Object.values(node)) walk(v, acc);
  };
  for (const f of fs.readdirSync(taskDir).filter(x => x.endsWith('.json'))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const acc = []; walk(j, acc);
    if (!acc.length) continue;
    const img = j.image ? (j.image.rel || j.image.abs || '') : '';
    for (const a of acc) out.push({ ...a, img });
  }
  return out;
}

/* ─────────── 卡目录 ─────────── */
function allCards() {
  const out = [];
  const seen = new Set();
  for (const idxFile of indexFiles(ROOT)) {
    let j; try { j = readJsonStrict(idxFile); } catch { continue; }
    const student = j.student || path.basename(path.dirname(idxFile));
    const subj = j.subject || path.basename(path.dirname(idxFile));
    const items = j.subjects && typeof j.subjects === 'object'
      ? Object.entries(j.subjects).flatMap(([s, v]) => ((v && v.items) || []).map(it => ({ it, s })))
      : (j.items || []).map(it => ({ it, s: subj }));
    for (const { it, s } of items) {
      if (!it || !it.id) continue;
      const dirAbs = path.join(path.dirname(idxFile), s, it.dir || it.id);
      if (!fs.existsSync(dirAbs)) continue;
      const key = student + '|' + it.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, student, subject: s, id: it.id, dirAbs, name: it.dir || it.id, item: it });
    }
  }
  return out;
}

/** 题图.jpg 在不在、是不是**在用**的（题干引用了它 / 题干无图 ⇒ 前端 fig 兜底会渲染它） */
function figureUsage(card) {
  const jpg = path.join(card.dirAbs, '题图.jpg');
  if (!fs.existsSync(jpg)) return { jpg, exists: false, inUse: false, hasSvg: false, refsJpg: false };
  const hp = path.join(card.dirAbs, '题干.html');
  const stem = fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '';
  const hasSvg = /<svg[\s\S]*?<\/svg>/i.test(stem);
  const refsJpg = /<img\b[^>]*\bsrc\s*=\s*["']?[^"'>]*题图\.jpg/i.test(stem);
  const hasImgAny = /<img\b/i.test(stem);
  /* 在用 = 题干引用了它，或题干里没有任何图（前端 fig 兜底会渲染，见 model.js:663） */
  const inUse = refsJpg || (!hasSvg && !hasImgAny);
  return { jpg, exists: true, inUse, hasSvg, refsJpg, hasImgAny };
}

/* ─────────── 计划 ─────────── */
/**
 * @param {object} card
 * @param {Array} taskFigs
 * @param {object} [override] 人工覆盖：{ src?: 源页相对路径, box?: [x,y,w,h] }
 *   ★ 为什么要覆盖项（实测 M0060/M0071/M0075/P0126）：
 *     任务 json 里的 `figBbox` 是**当初 AI 框的"插图区"**，对多数题准确，
 *     但有几张它框得偏大，把**孩子写在图上的红笔演算**一起框进来了
 *     （实测 M0075：框里含"r²=z+(x+y)=4+x²"整行红笔演算 ⇒ 重做卷泄答案）。
 *     而**同一份卷子的"印刷原卷"页里有干净的图**（答题卡上有孩子的红笔，
 *     印刷原卷上没有）⇒ 换源页 + 收紧框 就能救，不必矢量重画。
 */
function buildPlan(card, taskFigs, override = {}) {
  const u = figureUsage(card);
  if (!u.exists) return { card, skip: '没有 题图.jpg' };
  if (!u.inUse) return { card, skip: '题图.jpg 未被引用（遗留冗余）' };
  const title = card.name.split('-').slice(1).join('-');
  const hits = taskFigs.filter(t => t.title === title);
  if (!hits.length && !override.box) return { card, skip: '任务 json 里没有该题的 figBbox（插图框）' };
  const hit = hits[0] || { figBbox: override.box, img: override.src || '' };
  const srcIndex = buildSrcIndex();
  const rawSrc = override.src || hit.img || '';
  if (!rawSrc) return { card, skip: '没有可用的源页（该题无 figBbox ⇒ 需人工给 src）' };
  const rel = normalizeRel(rawSrc);
  let srcAbs = path.join(ROOT, rel);
  if (!fs.existsSync(srcAbs)) {
    const e = srcIndex.get(rel);
    srcAbs = e && e.abs ? e.abs : null;
  }
  if (!srcAbs || !fs.existsSync(srcAbs)) return { card, skip: '源页不可达：' + rawSrc };
  const figBbox = override.box || hit.figBbox;
  return { card, title, figBbox, srcAbs, srcRel: override.src || hit.img, srcIsPhoto: false };
}

/* ─────────── 裁剪（走清洗工具，零依赖） ─────────── */
function runClean(args) {
  return execFileSync(process.execPath, [toolPath('_配图清洗.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });
}
function probeRed(file) {
  try {
    const out = runClean(['--in', file, '--探测']);
    const w = /尺寸：(\d+)x(\d+)/.exec(out);
    const rb = /成形红笔（面积\+形状达标）：(\d+)/.exec(out);
    const rp = /红色像素：(\d+)/.exec(out);
    /* ⚠ **只取「红笔笔画包围盒」那一段**（实测踩到）：探测输出里还有一段
       「暗色簇包围盒」，两段的行格式一模一样（n,x0,y0,x1,y1）⇒ 用全局正则会把
       **暗色簇（印刷体正文）当成红笔**⇒ 抹除时把正文涂白、红笔反而留着
       （实测 M0061：红色像素 2531 → 2532，一像素没少；暗色像素倒是少了 831）。
       修法：先定位「红笔笔画包围盒」标题行，只在**下一段标题之前**取行。 */
    const lines = out.split(/\r?\n/);
    const boxes = [];
    const grab = (startRe, endRe, tag) => {
      const start = lines.findIndex(l => startRe.test(l));
      if (start < 0) return;
      for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l) continue;
        if (endRe.test(l)) break;               // 下一段标题 / 结论行 ⇒ 停
        const m = l.match(/^(?:AL\|)?(\d+),(\d+),(\d+),(\d+),(\d+)$/);
        if (!m) break;
        if (tag && !l.startsWith('AL|')) continue;
        boxes.push({ n: Number(m[1]), x0: Number(m[2]), y0: Number(m[3]), x1: Number(m[4]), y1: Number(m[5]) });
      }
    };
    /* 优先用「全部红簇」（AL| 前缀，第七轮新增）：孩子手画的细红线被抗锯齿断成
       n=2~7 的碎簇，"成形红笔"（n>=8 且长宽比>=2）只认出其中一小部分 ⇒ 曲线留在图上。
       碎簇面积小（n=2~7），逐个涂掉不影响印刷正文（正文是黑的，不判红）。 */
    grab(/全部红簇包围盒/, /^\s*(暗色簇|红笔笔画|⚠|✓)/, 'AL');
    if (!boxes.length) grab(/红笔笔画包围盒/, /^\s*(暗色簇|全部红簇|⚠|✓)/, null);
    return { w: w ? Number(w[1]) : 0, h: w ? Number(w[2]) : 0, redBig: rb ? Number(rb[1]) : 0, redPixels: rp ? Number(rp[1]) : 0, boxes };
  } catch { return null; }
}

/** 抹除框的最小簇面积。
 *  ⚠ **必须取 1**（不是 8）：孩子手画的细红线被抗锯齿断成一堆 n=1~7 的碎簇
 *    （实测 M0061：全图 236 个红簇，"成形红笔"只认出 8 个；红味像素 1510 里
 *    大头都在碎簇里）⇒ 阈值取 8 时碎簇全被放过 ⇒ 曲线原样留在图上。
 *    为什么取 1 安全：红簇是**色相判出来**的（红/粉/洋红四类），印刷正文是黑的，
 *    不判红 ⇒ 逐簇涂白不会误伤正文。实测：抹完红味像素 1510 → 0，正文完好。 */
const ERASE_MIN = 1;

/** 残余红味覆盖率上限（%）。
 *  ⚠ **为什么需要这条**（实测 M0061）：探测的"成形红笔"判据要求「连通域面积 >= 阈值
 *    且长宽比 >= 2」，于是**孩子用红笔画的曲线**（一条连续的线，但每个连通段都很细、
 *    段与段之间被抗锯齿断开）**判不出来** —— 实测那张图「成形红笔 0 个」，
 *    可图上那条红曲线清清楚楚，就是孩子的答案 ⇒ **重做卷泄答案**。
 *    补一条：**整图红味像素占比**（R 明显大于 G/B 的像素占全图的比例）。
 *    实测：干净印刷图 < 0.05%；带红笔的图 0.25%~0.8%。阈值取 0.15%。
 *    ⚠ 这是**补充**判据，不取代"成形红笔"：后者抓粗红块（红叉、红圈），
 *    前者抓细红线（手写曲线）。两条都要过。
 *    ⚠⚠ **"红味"的阈值必须用 R-G >= 25**（实测 C0003）：
 *       旧口径 R-G >= 15 把**泛黄旧纸张**也算成红味 —— 实测 C0003 的扫描页
 *       （干净、无任何笔迹）红味像素 7697 个、占 1.58% ⇒ 直接假红。
 *       实测真红笔与旧纸的分界在 R-G：旧纸 R-G=18~19（几乎只是偏黄），
 *       真红笔 R-G >= 60（洋红红）/ >= 25（褪色红）。故取 25。 */
export const RED_COVERAGE_MAX = 0.15;
/** "红味"像素的最小红绿差（与 `_配图清洗.mjs` 的褪色红判据同口径：R-G >= 25） */
const RED_MIN_DG = 25;

/** 整图红味像素占比（%）—— **严格口径**：R>=120 且 R-G>=25 且 R-B>=15。
 *  ⚠ 口径必须与 `_配图清洗.mjs` 的严格口径一致（否则旧纸算成红笔 ⇒ 假红）。
 *     数值由清洗工具在同一次探测里算出（`严格红味` 行），不必再扫一遍像素。 */
function redCoverage(file) {
  try {
    const out = runClean(['--in', file, '--探测']);
    const m = /严格红味（R-G>=25[^）]*）：(\d+)（([\d.]+)%）/.exec(out);
    if (!m) return null;
    /* ⚠ 捕获组编号：m[1]=像素数、m[2]=百分比（m[3] 是 undefined）。
       写错成 m[3] 时 pct=NaN ⇒ `NaN > 阈值` 恒为 false ⇒ **闸门全程失效**（实测漏放 4 张）。 */
    return { redPixels: Number(m[1]), pct: Number(m[2]) };
  } catch { return null; }
}

function eraseBoxesFor(probe) {
  if (!probe || !probe.boxes) return [];
  return probe.boxes
    .filter(b => b.n >= ERASE_MIN)
    .map(b => {
      const pad = 2;
      const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad);
      const x1 = Math.min(probe.w - 1, b.x1 + pad), y1 = Math.min(probe.h - 1, b.y1 + pad);
      return [x0 / probe.w, y0 / probe.h, (x1 - x0 + 1) / probe.w, (y1 - y0 + 1) / probe.h]
        .map(v => v.toFixed(6)).join(',');
    });
}

/* ─────────── 裁切框「贴边截断」检测（2026-11-24，实测 P0128 踩到） ─────────── */
/**
 * 事件：P0128 重裁后，图(b) 右侧 V₂ 电压表的**右端（"15"刻度那头）被切掉一条**，
 *   印到卷面上会缺块（读数不受影响，但图不完整）。
 *   根因：裁切框的右边界**正好压在图内墨迹上** ⇒ 墨迹被切成两半。
 *   现有门禁查不出来：它只看**输出图**的像素，看不到"输出图的边缘正好断在某根线上"。
 *
 * 判据：**输出图最右/最左/最上/最下那一列（行）的暗像素数不为 0** ⇒ 墨迹被切在边界上
 *   ⇒ 图内容可能被截断，**告警**（不阻断：整页扫描的边也会命中，最后还得人眼看）。
 *   实测：P0128 旧版（944 宽，V₂ 被切）右边界 = 36；当前版（1057 宽）右边界 = 0。
 */
function edgeInk(file) {
  try {
    const out = runClean(['--in', file, '--边缘墨迹']);
    /* ⚠ 正则必须与 `_配图清洗.mjs --边缘墨迹` 的**实际输出格式**一致：
     *   它打印的是「左=8 右=0 上=0 下=0」（**等号**分隔，不是空格）。
     *   写成 /左(\d+)\s+右(\d+)/ 会永远匹配不上 ⇒ warnTruncated 永远静默 ⇒
     *   告警形同虚设（2026-11-24 实测踩到：输出明明有「左=8」，函数却返回 null）。 */
    const m = /左\s*=\s*(\d+)\s+右\s*=\s*(\d+)\s+上\s*=\s*(\d+)\s+下\s*=\s*(\d+)/.exec(out);
    if (!m) return null;
    return { left: Number(m[1]), right: Number(m[2]), top: Number(m[3]), bottom: Number(m[4]) };
  } catch { return null; }
}

/** 边界墨迹告警（人眼复核前先给机器提示） */
function warnTruncated(c, file) {
  const e = edgeInk(file);
  if (!e) return false;
  const hits = [];
  if (e.right > 0) hits.push(`右边界 ${e.right} px`);
  if (e.left > 0) hits.push(`左边界 ${e.left} px`);
  if (e.bottom > 0) hits.push(`下边界 ${e.bottom} px`);
  if (e.top > 0) hits.push(`上边界 ${e.top} px`);
  if (!hits.length) return false;
  console.log(`⚠ ${c.key}：裁切框边缘有墨迹（${hits.join('，')}）⇒ 图内容**可能被截断**（实测 P0128：V₂ 表右端被切）——请肉眼确认边缘图元是否完整；不够就把框往外放宽一档再裁。`);
  return true;
}

const argv = process.argv.slice(2);
const { action, opt } = parseArgs(argv, {
  valueFlags: [...COMMON_VALUE_FLAGS, 'card', 'file', '宽', 'note'],
  boolFlags: ['json', 'help', 'h', '去红笔', '干跑', '允许照片源'],
});

if (opt.help || opt.h) {
  console.log(`配图重裁（第 2 级：按原卷重裁 + 放大 + 清洗）

  列表                              列出所有"题图.jpg 宽度不足"的卡与可重裁性
  计划   --card 学生|编号            打印这一张的重裁计划（源页 / 框 / 尺寸）
  执行   --card 学生|编号            真的重裁（默认干跑需加 --干跑 关闭）
        [--宽 1200] [--去红笔] [--干跑]
  执行   --file <json>               批量：[{card, 宽?, 去红笔?}]

  注意：裁剪框取自 _录题\\t-*.json 的 figBbox（插图自己的框），
        **不是** _原卷台账.json 的 box（那是错题区域，含孩子答案与红笔）。`);
  process.exit(0);
}

switch (action) {
  case '列表': {
    const taskFigs = collectTaskFigBoxes();
    const rows = [];
    for (const c of allCards()) {
      const u = figureUsage(c);
      if (!u.exists || !u.inUse) continue;
      const w = probeRed(u.jpg);                  // 探测输出图，顺便拿尺寸
      const curW = w ? w.w : 0;
      const curH = w ? w.h : 0;
      const needFix = curW < MIN_WIDTH || (w && w.redBig > 0);
      if (!needFix) continue;                    // 只列**真的有问题**的
      const p = buildPlan(c, taskFigs);
      rows.push({
        key: c.key, name: c.name, subject: c.subject,
        curW, curH, redBig: w ? w.redBig : null,
        skip: p.skip || null, srcRel: p.srcRel || null, figBbox: p.figBbox || null,
      });
    }
    if (opt.json) { console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 1)); break; }
    const doable = rows.filter(r => !r.skip), blocked = rows.filter(r => r.skip);
    console.log(`有图且有问题的卡 ${rows.length} 张：可重裁 ${doable.length}，需另法 ${blocked.length}`);
    console.log('\n【可重裁（源页可达 + 有插图框）】');
    for (const r of doable) console.log(`  ${r.key.padEnd(11)} ${r.subject}  现 ${r.curW}x${r.curH}${r.redBig ? ' 红笔' + r.redBig : ''}  框 ${r.figBbox.map(v => v.toFixed(4)).join(',')}`);
    console.log('\n【需另法（上网找图 / 矢量重画）】');
    for (const r of blocked) console.log(`  ${r.key.padEnd(11)} ${r.subject}  现 ${r.curW}x${r.curH}${r.redBig ? ' 红笔' + r.redBig : ''}  —— ${r.skip}`);
    break;
  }

  case '计划': {
    if (!opt.card) { console.error('计划需要 --card 学生|编号'); process.exit(2); }
    const taskFigs = collectTaskFigBoxes();
    const c = allCards().find(x => x.key === opt.card || x.id === String(opt.card).toUpperCase());
    if (!c) { console.error('找不到卡：' + opt.card); process.exit(2); }
    const p = buildPlan(c, taskFigs);
    if (p.skip) { console.log(`${c.key}：${p.skip}`); break; }
    const probe = probeRed(p.srcAbs);
    console.log(`${c.key}`);
    console.log(`  源页: ${p.srcAbs}`);
    console.log(`  框  : ${p.figBbox.map(v => v.toFixed(4)).join(',')}  （插图区，非错题区）`);
    if (probe) console.log(`  源页尺寸: ${probe.w}x${probe.h}   源页成形红笔: ${probe.redBig}`);
    break;
  }

  case '执行': {
    if (!opt.card && !opt.file) { console.error('执行需要 --card 或 --file'); process.exit(2); }
    const taskFigs = collectTaskFigBoxes();
    let list = [];
    if (opt.file) {
      const p = path.resolve(String(opt.file));
      if (!fs.existsSync(p)) { console.error('文件不存在：' + p); process.exit(2); }
      list = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(list)) { console.error('内容应为数组：[{card,...}]'); process.exit(2); }
    } else {
      list = [{ card: opt.card, 宽: opt['宽'] ? Number(opt['宽']) : undefined, 去红笔: !!opt['去红笔'] }];
    }
    const dry = !!opt['干跑'];
    let ok = 0, fail = 0;
    for (const row of list) {
      const c = allCards().find(x => x.key === row.card || x.id === String(row.card).toUpperCase());
      if (!c) { console.log(`✖ ${row.card}：找不到卡`); fail++; continue; }
      /* ★ 「就地放大」模式（实测 C0040/C0041）：该卡的**现有题图.jpg 本身已经是干净的**
         （教材扫描图、无笔迹），只是宽度差一点点不够印刷 ⇒ 只需放大，不需要重新裁。
         此时没有 src/box 可用（任务 json 里没有 figBbox）⇒ 走"就地放大"分支。 */
      if (row.就地放大) {
        const src0 = path.join(c.dirAbs, '题图.jpg');
        const targetW0 = Number(row.宽 || opt['宽'] || TARGET_W);
        const up = path.join(TMPDIR, `gn-up-${c.id}-${Date.now()}.png`);
        const upJpg = up.replace(/\.png$/, '.jpg');
        try {
          runClean(['--in', src0, '--out', up, '--最小宽', String(targetW0)]);
        } catch (e) { console.log(`✖ ${c.key}：放大失败 ${String(e.message).slice(0, 100)}`); fail++; continue; }
        const pu = probeRed(up);
        const cu = redCoverage(up);
        if (!pu || pu.w < MIN_WIDTH) { console.log(`✖ ${c.key}：放大后宽度 ${pu ? pu.w : '?'} 仍不足`); fail++; continue; }
        if (cu && cu.pct > RED_COVERAGE_MAX) { console.log(`✖ ${c.key}：放大后红味 ${cu.pct}% 超阈值`); fail++; continue; }
        if (dry) { console.log(`（干跑）${c.key}：${pu.w}x${pu.h}（就地放大）  ← ${up}`); ok++; continue; }
        /* ⚠ 同"重裁"分支：落进 `题图.jpg` 的必须是 **JPEG 字节**。
         *   中间产物是 PNG ⇒ 必须转一次；清洗器不给动作会拒跑 ⇒ 带 `--最小宽 <当前宽>`
         *   （放大到自己已是目标宽 ⇒ 尺寸不变，纯格式转换）。 */
        let upOk = false;
        try {
          runClean(['--in', up, '--out', upJpg, '--最小宽', String(pu.w)]);
          upOk = true;
        } catch (e) {
          console.log(`✖ ${c.key}：PNG→JPEG 转换失败 ${String((e.stderr || e.message || e)).slice(0, 120)}`);
        }
        const head = upOk && fs.existsSync(upJpg) ? fs.readFileSync(upJpg).subarray(0, 3) : null;
        if (!head || !(head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF)) {
          console.log(`✖ ${c.key}：未能产出合法 JPEG（不写盘，避免 PNG 字节冒充 .jpg）`);
          try { fs.unlinkSync(up); } catch { }
          fail++; continue;
        }
        withLibWrite(ROOT, '_配图重裁 放大 ' + c.key, (tx) => {
          tx.snapshot(src0);
          fs.copyFileSync(upJpg, src0);
        });
        try { fs.unlinkSync(up); } catch { }
        try { fs.unlinkSync(upJpg); } catch { }
        console.log(`✔ ${c.key}：${pu.w}x${pu.h}（就地放大）`);
        ok++;
        continue;
      }
      const p = buildPlan(c, taskFigs, { src: row.src, box: row.box });
      if (p.skip) { console.log(`✖ ${c.key}：${p.skip}`); fail++; continue; }
      const targetW = Number(row.宽 || opt['宽'] || TARGET_W);
      const out = path.join(c.dirAbs, '题图.jpg');
      /* ⚠ 中间产物必须用 .jpg 扩展名：`_配图清洗.mjs` 按**扩展名**选输出格式
         （.png ⇒ PNG / 其它 ⇒ JPEG）。干跑用 .png（无损、便于肉眼核对），
         真写也用 .png 暂存，最后一步再转成 JPEG 落进卡目录 ——
         否则直接写 .jpg 会让清洗工具按 JPEG 存，字节更小但与库里其它图一致。
         统一做法：**中间 .png，真写时转 JPEG**。 */
      const tmp = path.join(TMPDIR, `gn-recrop-${c.id}-${Date.now()}.png`);
      const tmpJpg = tmp.replace(/\.png$/, '.jpg');
      let rotTmp = null;
      /* ★ 源页需要先旋转时（实测 P0087）：那份卷子是**两页拼合**的竖版照片，
         题目与图都横着 ⇒ 必须先转 90° 再裁。清洗工具没有 --旋转 ⇒ 这里自己转。
         ⚠ 路径坑（本机库根路径**含空格** + 库里的 `裁图.ps1` 无 BOM）：
           任何 `powershell -File x.ps1 -Src <路径>` 形式都会把路径**按空格拆开**
            （实测报 `FromFile ... "<库根>"`，路径只剩前半段）；
           `execFileSync` 在 Windows 上已给参数加引号，再手工加会变成 `'"..."'` ⇒ 非法路径；
           套 wrapper 也救不了 —— **内层调用**仍按空格分词。
           修法：**自己写一份带 BOM 的旋转脚本**，路径从**环境变量**读（不经过命令行分词）。 */
      if (row.rotate) {
        const rot = path.join(TMPDIR, `gn-rot-${c.id}-${Date.now()}.jpg`);
        try {
          const dir = path.join(TMPDIR, `gn-rotdir-${c.id}-${Date.now()}`);
          fs.mkdirSync(dir, { recursive: true });
          const rotPs = path.join(dir, 'rot.ps1');
          fs.writeFileSync(rotPs, '\uFEFF' + [
            'param()',
            '$ErrorActionPreference = "Stop"',
            'Add-Type -AssemblyName System.Drawing',
            '$img = [System.Drawing.Image]::FromFile($env:GN_ROT_SRC)',
            'if($env:GN_ROT_DEG -eq 90){ $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }',
            'elseif($env:GN_ROT_DEG -eq 180){ $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }',
            'elseif($env:GN_ROT_DEG -eq 270){ $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }',
            '$bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height)',
            '$g = [System.Drawing.Graphics]::FromImage($bmp)',
            '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
            '$g.DrawImage($img, 0, 0)',
            '$g.Dispose(); $img.Dispose()',
            '$bmp.Save($env:GN_ROT_OUT, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
            '$bmp.Dispose()',
          ].join('\r\n'), 'utf8');
          execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rotPs], {
            stdio: 'pipe',
            env: Object.assign({}, process.env, { GN_ROT_SRC: p.srcAbs, GN_ROT_OUT: rot, GN_ROT_DEG: String(row.rotate) }),
          });
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
          if (!fs.existsSync(rot)) throw new Error('旋转产物不存在');
          p.srcAbs = rot;                      // 后续裁剪用旋转后的页
          rotTmp = rot;
        } catch (e) {
          console.log(`✖ ${c.key}：源页旋转失败 ${String((e.stderr || e.message || e)).slice(0, 300)}`);
          fail++; continue;
        }
      }
      /* ⚠ acts 必须在旋转**之后**构造：acts 里的 --in 是 p.srcAbs 的快照，
         放在旋转之前 ⇒ 裁的仍是没转过的原图。 */
      const cropArgs = p.figBbox.map(v => v.toFixed(6)).join(',');
      const acts = ['--in', p.srcAbs, '--out', tmp, '--裁剪', cropArgs, '--裁剪后最小宽', String(targetW)];
      if (row.去红笔 || opt['去红笔']) acts.push('--去红笔');
      let outText = '';
      try { outText = runClean(acts); } catch (e) { console.log(`✖ ${c.key}：清洗失败 ${String(e.message).slice(0, 100)}`); fail++; continue; }
      /* 第二遍：把残余红笔整块抹掉。
         ⚠ **不只看 redBig**：孩子手画的细红线被抗锯齿断成 n=1~7 的碎簇，
         "成形红笔"（n>=8 且长宽比>=2）一个也认不出 ⇒ 曲线原样留在图上。
         所以判据改成：**只要图里有任何红簇**（boxes 非空）就抹。
         抹除框取自「全部红簇」（AL| 前缀），面积下限 ERASE_MIN=1。 */
      let after = probeRed(tmp);
      if (after && after.boxes.length) {
        const boxes = eraseBoxesFor(after);
        if (boxes.length) {
          try {
            runClean(['--in', tmp, '--out', tmp + '.2.png', '--抹除', boxes.join(';')]);
            fs.copyFileSync(tmp + '.2.png', tmp);
            try { fs.unlinkSync(tmp + '.2.png'); } catch { }
            after = probeRed(tmp);
          } catch { /* 抹除失败就保留原样（不假装成功） */ }
        }
      }
      if (!after || after.w < MIN_WIDTH) {
        console.log(`✖ ${c.key}：重裁后宽度 ${after ? after.w : '?'} 仍不足 ${MIN_WIDTH}（源图本身太小 ⇒ 需上网找图或矢量重画）`);
        try { fs.unlinkSync(tmp); } catch { }
        fail++; continue;
      }
      /* 残余红味覆盖率闸门（抓"孩子用红笔画的曲线"——成形红笔判据抓不到的那种） */
      const cov = redCoverage(tmp);
      if (cov && cov.pct > RED_COVERAGE_MAX) {
        const keep = path.join(TMPDIR, `gn-recrop-REJECT-${c.id}.png`);
        try { fs.copyFileSync(tmp, keep); } catch { }
        console.log(`✖ ${c.key}：残余红味像素 ${cov.pct}% > ${RED_COVERAGE_MAX}%（图上还有红笔痕迹，疑似孩子的作答 ⇒ 重做卷会泄答案）——需人工处理或换图`);
        console.log(`    留样：${keep}`);
        try { fs.unlinkSync(tmp); } catch { }
        fail++; continue;
      }
      const redWarn = after.redBig > 0 ? `  ⚠ 残留成形红笔 ${after.redBig} 处` : '';
      if (dry) {
        console.log(`（干跑）${c.key}：${after.w}x${after.h}  ← ${tmp}${redWarn}`);
        ok++;
        continue;
      }
      /* 真写：持锁 + 事务（旧图可回滚） */
      /* 中间产物是 PNG，落进卡目录前转成 JPEG（与库里其它 题图.jpg 同格式）。
       * ⚠ **必须给一个"动作"，否则清洗器会拒跑**（2026-11-23 实测踩到）：
       *   `_配图清洗.mjs` 有一条硬规则「至少给一个动作（--去红笔/--去黑笔/--去噪/--增强/
       *   --锐化/--裁剪/--放大/--最小宽）」⇒ 纯格式转换（"--in x.png --out x.jpg"）
       *   会被拒（exit 2）。而原来那行 catch 把失败**吞掉了**
       *   ⇒ 落进卡目录的是**PNG 字节、扩展名却是 .jpg** ⇒ 浏览器按 image/jpeg 解析 ⇒
       *   **图片在页面上直接裂开**（服务端还带 `X-Content-Type-Options: nosniff`）。
       *   修法：转换时带上 `--最小宽 <当前宽>`（放大到自己已是目标宽 ⇒ 尺寸不变，
       *   纯格式转换），并把失败**响亮报出来**，不许静默写 PNG。
       *   （另：转换后要验文件头确实是 JPEG，见下面的 head 自检。） */
      let fmtOk = false;
      try {
        runClean(['--in', tmp, '--out', tmpJpg, '--最小宽', String(after.w || targetW)]);
        fmtOk = true;
      } catch (e) {
        console.log(`✖ ${c.key}：PNG→JPEG 转换失败 ${String((e.stderr || e.message || e)).slice(0, 120)}`);
      }
      const finalFile = fmtOk && fs.existsSync(tmpJpg) ? tmpJpg : null;
      if (!finalFile) {
        /* 转换失败 ⇒ **不写盘**（宁可让这张卡欠账，也不要落一个"扩展名骗人"的文件）。 */
        console.log(`✖ ${c.key}：未能产出 JPEG（不写盘，避免 PNG 字节冒充 .jpg）`);
        try { fs.unlinkSync(tmp); } catch { }
        fail++; continue;
      }
      /* 字节级自检：文件头必须是 JPEG（FFD8FF）⇒ 不然就是"扩展名骗人"的坏图。 */
      const head = fs.readFileSync(finalFile).subarray(0, 3);
      if (!(head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF)) {
        console.log(`✖ ${c.key}：输出文件头不是 JPEG（${head.toString('hex')}）—— 不写盘`);
        try { fs.unlinkSync(tmp); } catch { }
        fail++; continue;
      }
      /* ⚠ 落盘前自检（2026-11-24，实测 P0128 踩到）：**边界墨迹**。
       *   裁切框的右/左/下/上边界若**正好压着图内墨迹** ⇒ 图内容被切在边界上
       *   （实测 P0128：图(b) 右侧 V₂ 电压表的"15/3"端被切掉一条，印到卷面上缺块；
       *     把框从 831 px 放宽到 1057 px 就好了）。
       *   ⇒ **告警但不阻断**：整页扫描/贴边图的边也会命中，最终仍要人眼看一眼。
       *   注意：**测量要在裁好的卡图上做，不能在原图上做**（原图是斜着拍的手机照，
       *   行列方向不对，量出来全是垃圾读数）。 */
      warnTruncated(c, finalFile);
      const sha = crypto.createHash('sha256').update(fs.readFileSync(finalFile)).digest('sha256');
      const srcSize = probeRed(p.srcAbs);
      /* 写 sidecar：**追加**一条 crops[] 记录，不覆盖整份 —— `_原卷台账.mjs` 的
         ruleSidecar 从 crops[] 里挑 `out` 含「原卷截图」的那条作为**整页证据图的出处**
         （cropPx/normBox 讲的是"原卷截图怎么裁出来的"）。
         我们重裁的是**插图**（题图.jpg），不是原卷截图 ⇒ 若把整份 sidecar 覆盖成
         "插图的重裁记录"，原卷溯源就断了（门禁会报「未定位到整页」）。
         所以：保留既有记录，追加一条 out=题图.jpg 的插图记录。 */
      withLibWrite(ROOT, '_配图重裁 ' + c.key, (tx) => {
        tx.snapshot(out);
        fs.copyFileSync(finalFile, out);
        const sidecar = path.join(c.dirAbs, '_裁图记录.json');
        let rec = { crops: [] };
        if (fs.existsSync(sidecar)) {
          try { rec = JSON.parse(fs.readFileSync(sidecar, 'utf8').replace(/^\uFEFF/, '')); } catch { rec = { crops: [] }; }
        }
        if (!Array.isArray(rec.crops)) rec.crops = [];
        rec.crops.push({
          out: path.relative(ROOT, out),
          src: p.srcRel,
          srcPx: srcSize ? [srcSize.w, srcSize.h] : null,
          cropPx: p.figBbox.map(v => Math.round(v * (srcSize ? srcSize.w : 0))),
          normBox: p.figBbox,
          scale: 1,
          rotate: 0,
          ts: new Date().toISOString(),
          tool: '_配图重裁.mjs',
          note: row.note || ('插图重裁：按 figBbox 从原卷裁出并放大到 ' + targetW + ' 宽（' + after.w + 'x' + after.h + '）'),
          sha256: sha,
        });
        tx.writeText(sidecar, JSON.stringify(rec, null, 1), { newline: true });
      });
      try { fs.unlinkSync(tmp); } catch { }
      try { fs.unlinkSync(tmpJpg); } catch { }
      if (rotTmp) { try { fs.unlinkSync(rotTmp); } catch { } }
      console.log(`✔ ${c.key}：${after.w}x${after.h}  ← ${path.basename(p.srcAbs)}${redWarn}`);
      ok++;
    }
    console.log(`\n完成 ${ok} 张${fail ? `，失败 ${fail} 张` : ''}${dry ? '（干跑，未写盘）' : ''}`);
    if (fail) process.exitCode = 1;
    break;
  }

  default:
    console.error('未知动作：' + action + '\n可用：列表 / 计划 / 执行');
    process.exit(2);
}
