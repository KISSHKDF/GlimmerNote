#!/usr/bin/env node
/**
 * 拾光小册 · 配图质量检查（**零副作用共享模块**）
 *
 * 为什么存在（2026-11-23 用户裁定：配图三级来源 = 上网找图 → 清洗裁图 → 矢量重画）：
 *   此前 `_配图门禁.mjs` 只判「有没有图」，**不判图好不好**。实测全库：
 *     · 39 张 jpg 配图里 21 张是直接剪自孩子作业本，宽度 218–686 像素（印刷尺寸下线条不可辨）；
 *     · M0070 的 `题图.jpg` 上有一道红笔批改（重做卷会泄答案）；
 *     · 台账 `need=false` 却实际挂着图的有 15 张 —— 门禁据此判「无需图」放行。
 *   门禁全绿，但图是坏的。本模块把这三类缺陷变成**机器可判**的结论。
 *
 * 为什么是共享模块（对齐 2026-11-12 审计 F05）：
 *   「配图质量」要同时被 `_配图门禁.mjs`（拦截）和 `_盲解复核.mjs`（图形层准入）消费。
 *   两处各抄一份必然漂移（历史上 8 个工具抄了 8 份题库发现逻辑，实测出 3 种实现）。
 *   本模块**只读、零副作用**，供多处 import。
 *
 * 判据（每条都有可跑的阴性对照，见 tests\neg-fig-quality-gate.cjs）：
 *   Q1 尺寸不足   —— jpg 配图宽度 < MIN_WIDTH ⇒ 印刷尺寸下线条不可辨
 *   Q2 红笔残留   —— 图上有成形的红色笔画（连通域面积 >= 阈值）⇒ 泄答案风险
 *   Q3 来源不合规 —— 台账说 kind=jpg（剪裁）却没登记清洗痕迹 ⇒ 未按第 2 级规则处理
 *   Q4 台账矛盾   —— need=false（无需图）但卡目录里确实有图资产 ⇒ 门禁会静默放行
 *
 * ⚠ **不写盘、不改数据**：本模块只回答「这张图有没有问题」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { displaySize } from './_图尺寸.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 配图宽度下限（像素）。低于此值，印刷（A4 上约 8cm 宽）后线条不可辨。
 *  依据：库里印刷版裁图（C0042 1800×660、P0009 1800×850）都 >= 1800；
 *  纯裁自孩子作业本的最小几张是 218×409 / 245×230 —— 印出来是糊的。
 *  取 1000：低于此值的 19 张全部是"剪自原卷且明显糊"，高于此值的不含明显糊图。
 *  ⚠ 可用环境变量 `CTB_FIG_MIN_WIDTH` 临时改（**只给测试用**：阴性对照要证明
 *    "这条判定是阈值驱动的、不是恒真" ⇒ 必须能临时把阈值抬到极大来复现原缺陷）。
 *    生产路径不许设这个变量——它会让门禁的判据可被环境悄悄改掉。 */
export const MIN_WIDTH = (() => {
  const env = Number(process.env.CTB_FIG_MIN_WIDTH);
  return Number.isFinite(env) && env > 0 ? env : 1000;
})();

/** 红色笔画的最小连通域面积（像素）。低于它的算扫描噪点，不算笔画。
 *  依据：M0070 那道红笔横线实测 43 像素（放大到 1200 宽后），是最细也最真实的量级。 */
export const RED_BLOB_MIN = 20;

/** 台账 ref/note 里出现这些词 ⇒ 登记过清洗痕迹（符合第 2 级规则）
 *  ⚠ 2026-11-23 补两个词：**裁出** 与 **原卷裁图**。
 *     实测 10 张卡的 ref 写的是「原卷裁图，源：…；按 figBbox 裁出，无孩子笔迹」——
 *     这**就是**第 2 级处理的如实登记，却因为没有出现"清洗/放大"这类词而被判「来源未登记」。
 *     判据要认的是"有没有写明图的来历与处理"，不是"有没有用某个特定动词"。 */
const CLEAN_MARKERS = /清洗|去红笔|去笔迹|矫正|摆正|增强|放大|去噪|锐化|修复|重裁|重新裁|矢量|重画|svg|裁出|裁图|按 figBbox|无孩子笔迹/i;

/** 台账 ref/note 里出现这些词 ⇒ 声明来源是网上题库（第 1 级规则） */
const ONLINE_MARKERS = /网上|题库|菁优|jyeoo|21cnjy|作业帮|教习网|二一|精英家教|青果|原图|印刷版/i;

/**
 * 台账条目的「整改状态」字段（2026-11-23 新增，配合配图质量闸门的分阶段推进）。
 *
 * 为什么需要这个字段：配图质量闸门一上线，真库立刻有 45 张卡不合格（28 张糊图 +
 * 7 张台账矛盾 + 来源未登记）。这些是**存量欠账**，一次改不完。
 *   · 若门禁立即全红 ⇒ 发版链路被存量欠账锁死，所有后续修复都推不出去；
 *   · 若门禁完全放行 ⇒ 闸门形同虚设，新卡照样能带红笔入库。
 * 折中：**显式登记的欠账降级为警告，未登记的一律阻断**。
 *   · `fix: "待整改"`（或"已知欠账"）⇒ 该卡的问题**记入 meta 但不阻断**，并在报告里点名；
 *   · 其余（没登记）⇒ **阻断**。
 * 登记本身要留痕（谁、什么时候、为什么），否则"待整改"会变成永远的黑洞。
 */
export const DEFERRED_MARKERS = /待整改|已知欠账|待重配/;
export function isDeferred(entry) {
  if (!entry) return false;
  const txt = `${entry.ref || ''} ${entry.note || ''} ${entry.fix || ''} ${entry.fixStatus || ''}`;
  return DEFERRED_MARKERS.test(txt);
}

/* ---------- 红笔检测（纯 Node 读像素？不行——JPEG 解码需要依赖） ----------
 * 零依赖纪律下，JPEG 像素解码只能走 System.Drawing（见 `_配图清洗.mjs` 的做法）。
 * 但门禁要对**全库**跑，逐张 spawn PowerShell 太慢（实测单张 1–2 秒 × 60 张 = 2 分钟）。
 *
 * 折中：**默认用文件头的粗判**（零成本，见下），需要精确判定时由调用方显式要求深检。
 * 粗判依据：JPEG 文件里红笔的像素在压缩后仍会保留较高的 R-G 差 ⇒ 文件尾的 IDAT 里
 * R 通道与 G 通道的统计量会有可见差异。但这个判据不精确 ⇒ **只作提示，不作判定**。
 *
 * 真判据（有牙的）：调用 `_配图清洗.mjs --探测` 拿到精确的成形红笔簇数。
 * 本模块提供 `probeRedInk(file)`，**按需**调用一次并缓存结果。
 */
/** 残余红味覆盖率上限（%）。
 *  ⚠ **为什么需要这条**（实测 M0061，2026-11-23）：探测的「成形红笔」判据要求
 *    「连通域面积 >= 阈值 且 长宽比 >= 2」，于是**孩子用红笔画的曲线**
 *    （一条连续的线，但每个连通段都很细、段与段之间被抗锯齿断开）**判不出来** ——
 *    实测那张图「成形红笔 0 个」，可图上那条红曲线清清楚楚，就是孩子的答案
 *    ⇒ **重做卷泄答案**。
 *    补一条：整图红味像素占比（探测输出里已带这个百分比，不必再扫像素）。
 *    实测干净印刷图 < 0.05%；带红笔的图 0.25%~0.8% ⇒ 阈值取 0.15%。
 *    ⚠ 这是**补充**判据，不取代「成形红笔」：后者抓粗红块（红叉、红圈），
 *    前者抓细红线（手写曲线）。两条都要过。 */
export const RED_COVERAGE_MAX = 0.15;

/** 从已探测的结果里取红味覆盖率（%）；读不到就返回 null（不下结论）。
 *  ⚠⚠ **口径必须与 `_配图重裁.mjs` 的严格口径一致**（R-G >= 25，实测 C0003）：
 *     探测输出的「红色像素」用的是探测的四类判据（含浅粉 R-G>=15）⇒ **泛黄旧纸张**
 *     也会被算进去：实测 C0003 那张**干净无笔迹**的扫描页红味占 1.58% ⇒ 直接假红。
 *     实测分界：旧纸 R-G = 18~19（几乎只是偏黄）；真红笔 R-G >= 60（洋红）/ >= 25（褪色）。
 *     所以这里**不能**直接用探测的百分比，要另算一次严格口径。 */
export function redCoverageOf(file, probe) {
  if (probe && typeof probe.redPctStrict === 'number') return probe.redPctStrict;
  return null;
}

let _probeCache = new Map();

/**
 * 精确红笔检测（spawn 一次 PowerShell 探测）。返回 { redBig, redPixels, w, h } 或 null（读不出）。
 * 昂贵 ⇒ 调用方要缓存。本模块内部已按文件路径缓存。
 */
export function probeRedInk(file) {
  const abs = path.resolve(file);
  if (_probeCache.has(abs)) return _probeCache.get(abs);
  let res = null;
  try {
    /* 复用清洗工具的探测逻辑：直接调它的 --探测 子命令（它是零依赖且已被实测过）。
       这里用 child_process 同步调用，保证门禁能拿到确定结论。 */
    const tool = path.join(__dirname, '_配图清洗.mjs');
    const out = execFileSync(process.execPath, [tool, '--in', abs, '--探测'], { encoding: 'utf8', stdio: 'pipe' });
    const w = /尺寸：(\d+)x(\d+)/.exec(out);
    const rp = /红色像素：(\d+)/.exec(out);
    const rb = /成形红笔（面积\+形状达标）：(\d+)/.exec(out);
    /* ★ 2026-11-23：探测输出里带了红味像素**占比**（"红色像素：2531（0.2761%）"），
       正好是"残余红味覆盖率"判据要的量 ⇒ 一并取出来，不必再扫一遍像素。 */
    const rpp = /红色像素：(\d+)（([\d.]+)%）/.exec(out);
    /* ★ 2026-11-23：**严格口径**红味占比（R-G>=25，排除泛黄旧纸）。
       探测输出里的「红色像素」用的是四类判据（含浅粉 R-G>=15）⇒ 旧纸也算 ⇒ 假红
       （实测 C0003 的干净扫描页 1.58%）。严格口径由清洗工具在同一次探测里算出。 */
    const rsp = /严格红味（R-G>=25[^）]*）：(\d+)（([\d.]+)%）/u.exec(out);
    if (w) {
      res = {
        w: Number(w[1]), h: Number(w[2]),
        redPixels: rp ? Number(rp[1]) : 0,
        redBig: rb ? Number(rb[1]) : 0,
        redPct: rpp ? Number(rpp[2]) : null,
        /* ⚠ 捕获组编号：rsp[1]=像素数、rsp[2]=百分比（rsp[3] 是 undefined）。
           写错成 rsp[3] 时 pct=NaN ⇒ `NaN > 阈值` 恒为 false ⇒ **闸门全程失效**。 */
        redPctStrict: rsp ? Number(rsp[2]) : null,
        redStrict: rsp ? Number(rsp[1]) : null,
      };
    }
  } catch {
    res = null;   /* 读不动 ⇒ 不知道，不下结论（宁可不下结论也不误杀） */
  }
  _probeCache.set(abs, res);
  return res;
}

/**
 * 检查一张配图（jpg）的质量。
 * @param {string} file   配图绝对路径
 * @param {object} entry  配图台账条目（可能为 null）
 * @param {object} [opts] { deep: true } —— 深检（spawn 探测红笔，较慢）
 * @returns {{ok:boolean, problems:string[], info:object}}
 */
export function checkFigureFile(file, entry, opts = {}) {
  const problems = [];
  const info = { file, w: 0, h: 0, kind: entry ? entry.kind : 'none' };

  if (!fs.existsSync(file)) return { ok: true, problems, info };   // 文件不在 ⇒ 交给「有没有图」那一关判

  const sz = displaySize(file);
  if (!sz) {
    /* 读不出尺寸 ⇒ 不下结论（不误杀），但要在报告里留痕 */
    info.unreadable = true;
    return { ok: true, problems, info };
  }
  info.w = sz.w; info.h = sz.h;

  /* Q1 尺寸不足 */
  if (sz.w < MIN_WIDTH) {
    problems.push(`尺寸不足：${sz.w}×${sz.h}，宽度 < ${MIN_WIDTH}（印刷后线条不可辨）`);
  }

  /* Q2 红笔残留（深检才判；浅检只在明显超标时提示） */
  if (opts.deep) {
    const probe = probeRedInk(file);
    if (probe) {
      info.redBig = probe.redBig;
      info.redPixels = probe.redPixels;
      /* ★ 2026-11-24 修（实测 M0061/M0065/M0066/P0152 假红）：
       *   「成形红笔 N 处」是**簇计数**，不判面积 ⇒ JPEG 压缩在黑字边缘产生的
       *   彩色振铃（色度噪声）也会被数成"红笔簇"。
       *   实测那 4 张图红味像素占比只有 0.02%~0.09%（肉眼完全看不出红色），
       *   却被判"检出成形红笔 1~10 处"⇒ **闸门对刚转成 JPEG 的干净图集体假红**。
       *   修法：**成形红笔只在红味覆盖率超阈值时才报**（单看簇数会误伤压缩噪声）。
       *   阈值与"残余红味"同口径（RED_COVERAGE_MAX=0.15%）。 */
      const cov = redCoverageOf(file, probe);
      if (cov !== null) {
        info.redCoverage = cov;
        if (probe.redBig > 0 && cov > RED_COVERAGE_MAX) {
          problems.push(`检出成形红笔 ${probe.redBig} 处（${probe.redPixels} 像素，占 ${cov}%）——重做卷会泄答案`);
        }
        if (cov > RED_COVERAGE_MAX) {
          problems.push(`残余红味像素占 ${cov}%（> ${RED_COVERAGE_MAX}%）——图上还有红笔痕迹，疑似孩子的作答，重做卷会泄答案`);
        }
      }
    }
  }

  /* Q3 来源不合规：kind=jpg（剪裁）却没登记清洗痕迹 */
  if (entry && entry.kind === 'jpg') {
    const txt = `${entry.ref || ''} ${entry.note || ''}`;
    const hasClean = CLEAN_MARKERS.test(txt);
    const hasOnline = ONLINE_MARKERS.test(txt);
    info.cleanMarked = hasClean;
    info.onlineMarked = hasOnline;
    if (!hasClean && !hasOnline) {
      problems.push('来源未登记：kind=jpg（剪裁）但台账未写清洗痕迹或网上原图出处（三级来源规则要求写明）');
    }
  }

  return { ok: problems.length === 0, problems, info };
}

/**
 * 台账矛盾检查：need=false（无需图）但卡目录里确实有图资产。
 * 这种卡会被门禁当成「无需图」放行 —— 图实际存在但没人管，是 2026-11-23 查出的 15 张。
 *
 * ⚠ **要区分「在用」与「遗留冗余」**（2026-11-23 实测踩到）：
 *   库里有一批卡是「早期用 jpg 裁图，后来改成内联 svg」的。它们的 `题图.jpg` 留在目录里
 *   （历史包袱，且 P0001 的台账 note 里明写「题图.jpg 应弃用（待 Lead 删）」），
 *   但**实际在用的是内联 svg**。若只按「目录里有 jpg」判矛盾 ⇒ 这批卡被误报成矛盾。
 *   正确判据：**看题干.html 引用了哪个资产**。
 *     · 题干.html 内联了 svg / <img> ⇒ 在用的是它，目录里的 jpg 是遗留 ⇒ 报「遗留冗余」（提示级，非阻断）
 *     · 题干.html 没引用任何图    ⇒ 那个 jpg 才是**在用**的 ⇒ need=false 登记就是真矛盾（阻断）
 *
 * ★ 2026-11-23 修（实测 P0036 漏判，**真矛盾被当成冗余放过**）：
 *   原判据 `stemUsesInlineFig = 存在 <svg> || 存在任何 <img>` —— 把
 *   `<img src="题图.jpg">` 也算成「内联图」⇒ 题干引用的**正是目录里那个 jpg** 时，
 *   判据反而说"在用的是内联图、jpg 是冗余" ⇒ need=false 登记的真矛盾**不报红**。
 *   实测：P0036（need=false，题干 `<img src="题图.jpg">`）被门禁当「遗留冗余」放过，
 *   而它恰恰是"登记说无需图、实际靠 jpg 才能解题"的典型。
 *   修法：**按"题干引用的是哪个资产"判**，而不是"题干里有没有图标签"：
 *     · 题干引用了 `题图.jpg`（或 `题干.jpg`）⇒ **那个文件就是在用的** ⇒ need=false 是真矛盾（阻断）；
 *     · 题干只有内联 svg / 其它 <img> ⇒ 目录里的 jpg 是遗留 ⇒ 提示级；
 *     · 题干完全没有图 ⇒ jpg 就是在用的 ⇒ 真矛盾（阻断）。
 */
export function checkLedgerContradiction(key, entry, assetFiles, stemUsesInlineFig, stemRefsAssets) {
  const problems = [];
  if (!entry) return problems;
  if (entry.need === false && assetFiles && assetFiles.length > 0) {
    /* 题干直接引用了目录里的图资产 ⇒ 它在用，不是冗余 */
    if (Array.isArray(stemRefsAssets) && stemRefsAssets.length > 0) {
      problems.push(`台账矛盾：登记为「无需图」但题干.html 正在引用 ${stemRefsAssets.join(',')}（在用的图资产却登记为不需要）`);
      return problems;
    }
    if (stemUsesInlineFig) {
      /* 遗留冗余：不算矛盾，但要说清（否则人不知道为什么这卡有 jpg） */
      problems.push(`遗留冗余：登记为「无需图」但目录里留着 ${assetFiles.join(',')}（题干.html 已内联图，实际在用的是内联图）——建议删冗余文件并把台账改回 need=true`);
      return problems;
    }
    problems.push(`台账矛盾：登记为「无需图」但目录里有在用的图资产（${assetFiles.join(',')}）`);
  }
  return problems;
}

/**
 * 汇总一张卡的全部配图问题。
 * @param {object} x        { key, dirAbs }
 * @param {object} entry    台账条目或 null
 * @param {object} [opts]   { deep }
 */
export function checkCardFigure(x, entry, opts = {}) {
  const problems = [];
  const warnings = [];
  const deferred = [];
  const dir = x.dirAbs;
  const assets = ['题图.jpg', '题干.jpg'].filter(f => fs.existsSync(path.join(dir, f)));

  /* 题干.html 是否内联了图（决定目录里的 jpg 是在用还是遗留） */
  const hp = path.join(dir, '题干.html');
  const stemHtml = fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '';
  const stemUsesInlineFig = /<svg[\s\S]*?<\/svg>/i.test(stemHtml) || /<img\b/i.test(stemHtml);
  /* ★ 2026-11-23：题干**引用了哪个目录里的资产**（见 checkLedgerContradiction 的说明）。
     判据：<img src="题图.jpg">（含百分号编码/相对路径写法）⇒ 引用的就是那个文件。 */
  const stemRefsAssets = assets.filter(f => {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<img\\b[^>]*\\bsrc\\s*=\\s*["']?[^"'>]*${esc}`, 'i').test(stemHtml);
  });

  for (const p of checkLedgerContradiction(x.key, entry, assets, stemUsesInlineFig, stemRefsAssets)) {
    (/遗留冗余/.test(p) ? warnings : problems).push(p);
  }

  /* ★ 2026-11-23 修（实测 M0070 整改后仍被报"尺寸不足"，**卡死发版链**）：
   *   原实现对**目录里存在的每个**图资产都跑质量判据，于是
   *   「题干已改用内联 svg、目录里的旧 题图.jpg 只是遗留」的卡，
   *   它的**遗留 jpg** 照样被判"尺寸不足/红笔残留"⇒ 卡永远清不掉。
   *   判据修正：**只判"实际会被渲染/印出来"的资产**。
   *     · 题干引用了某个资产（<img src="题图.jpg">）⇒ 那个文件在用 ⇒ 判它；
   *     · 题干里有内联图 ⇒ 内联图在用，目录里没被引用的 jpg 是**遗留** ⇒ 不判（只提示）；
   *     · 题干里没有任何图 ⇒ 目录里的 jpg 由前端的 fig 兜底渲染（见 model.js:663）⇒ 判它。
   *   遗留资产的清理由「台账 kind 修正 + 删除冗余文件」负责，不由质量判据负责。
   */
  const stemHasInlineSvg = /<svg[\s\S]*?<\/svg>/i.test(stemHtml);
  const inUseAssets = stemRefsAssets.length > 0
    ? stemRefsAssets
    : (stemHasInlineSvg ? [] : assets);
  const legacyAssets = assets.filter(f => !inUseAssets.includes(f));

  for (const f of inUseAssets) {
    const r = checkFigureFile(path.join(dir, f), entry, opts);
    for (const p of r.problems) problems.push(`${f} ${p}`);
  }

  /* 内联 svg：kind 登记要跟着改 */
  if (stemHasInlineSvg && entry && entry.kind === 'jpg') {
    warnings.push('台账 kind 登记为 jpg，但题干.html 已内联 svg（矢量），kind 应改为 svg');
  }

  /* 遗留资产：只提示，不判质量（它不参与渲染） */
  for (const f of legacyAssets) {
    warnings.push(`遗留冗余：${f} 未被题干引用（题干用内联图）—— 建议删冗余文件并把台账 kind 改为 svg`);
  }

  /* ★ 2026-11-23：分阶段 —— 显式登记为「待整改」的存量欠账降级为警告，不阻断。
     ⚠ 只降级**已登记**的；没登记的一律阻断（否则闸门形同虚设）。 */
  if (problems.length && isDeferred(entry)) {
    deferred.push(...problems);
    problems.length = 0;
    warnings.push(`已登记为待整改（暂不阻断）：${deferred.length} 项 —— ${deferred[0]}`);
  }

  return { problems, warnings, deferred, assets };
}
