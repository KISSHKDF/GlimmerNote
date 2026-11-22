#!/usr/bin/env node
/**
 * 拾光小册 · 竖式分数保真判据（**单一真源**，2026-11-22 建）
 *
 * 规则（用户 2026-11-22 口述定案，原话级）：
 *   「数学题当中，很多分数的表达式为上下结构，而我转换过来的题目，基本用斜杠代替，
 *    我希望还是写成上下结构——至少原题是上下结构的，转换出来的也一定是上下结构。」
 *
 * 判据分层（为什么分层）：
 *   复合分式（分子或分母是多项式，必须靠括号才能在线性写法里保住结构）
 *   被压扁成 `(...)/(...)` —— **结构信息已经丢了一层**（读者看到的是程序员的写法，
 *   不是卷面的写法），且回原卷对照一眼就能确认真伪 ⇒ **A 级阻断**（入库当场拒收）。
 *
 *   简单比值（`k/x`、`1/3`、`√13/13`）压扁 —— 原卷多半也是竖式（反比例函数 y=分子/分母
 *   在教材里几乎全部竖排），但**也存在行文式写法**（行内公式、表格表头 `a/m`），
 *   机器判不了"原卷到底是哪一种" ⇒ **B 级只报告**（清单供人回原卷核对，不阻断）。
 *
 *   ⚠ 单位不是分数：`m/s`、`r/min`、`km/h`、表头 `a/m`（每行多少米）这类**比值型单位**
 *     恰好长得像分数。把单位拦下来会让物理/化学卷面大面积误报（实测扫描：单位命中
 *     远多于分式）⇒ 本判据**显式豁免**已知单位模式（见 UNIT_EXEMPT）。
 *   ⚠ 英语页码（`p25/p25`）、词组斜杠（`if/whether`、`unused/pity`）同样豁免：
 *     判据只对**数理类字符**（数字/字母/运算符/上下标/根号）组成的两侧生效。
 *
 * ★ 为什么收敛成共享模块（与 `_划线.mjs` 同一纪律，2026-11-12 审计 F03 定下的）：
 *   "两处同步改"靠人记必漂 —— 分叉时是**同一函数引用**，不可能漂。
 *   消费方：`_录题入库.mjs`（入库当场拦）、`_题干门禁.mjs`（存量扫描判据⑨）。
 */

/* ---------- A 级：复合分式被压扁 ---------- */

/**
 * 单位型侧的判别（用于单侧括号形态的豁免）：`cm³`、`m·s`、`kg·K`、`℃` 这类。
 * 判据：以字母开头、只含 单位字符集（字母/数字/上标/中点/℃°μΩ）。
 * 复合分式的括号侧带运算符（+ − ^）或以数字开头（系数 `12b`），不会命中 ⇒ 不豁免。
 */
export const UNIT_PAREN = /^[a-zA-ZμΩ℃°][a-zA-Z0-9²³·℃°μΩ]{0,9}$/;
/** 两侧都像单位/比值 ⇒ 整体豁免（g/(cm³)、J/(kg·K)、N/(m·s) 这类复合单位不是分数） */
const isUnitPair = (a, b) =>
  (UNIT_EXEMPT.test(a) || UNIT_PAREN.test(a)) && (UNIT_EXEMPT.test(b) || UNIT_PAREN.test(b));

const MATH_CHARS = /[0-9a-zA-Z√π²³⁴⁵⁶⁷⁸⁹⁰½¼¾±×÷−^_]/;
const HAN_CHARS = /[\u4e00-\u9fff]/;

/**
 * 复合分式压扁命中。三种形态（括号的存在 = 转录层为了消歧而加 ⇒ 原卷必是竖式复合分式）：
 *   ① 双侧括号 `(2x+m)/(x-4)`（事故样本 M0081）
 *   ② 左裸右括 `a/(12b)`（事故样本 C0046）
 *   ③ 左括右裸 `(x+1)/2`
 * 逐段扫描（避开 <span class="fr">…</span> 与 <svg>…</svg> 内部）；
 * ②③ 两侧都像单位时豁免（复合单位不是分数）。
 * 返回 [{raw, num, den}]；导出给回归用例复用。
 */
export function flatComplexFractions(html) {
  const s = String(html || '');
  /* 先挖掉不该看的区域：已竖排的分数标记、svg 图形、真标签（只留文本骨架） */
  const skeleton = s
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ');
  const out = [];
  const push = (num, den, raw) => {
    /* 两侧必须含数理类字符（数字/字母/运算符），且不含中文 —— 中文括号旁注不是分式 */
    if (HAN_CHARS.test(num) || HAN_CHARS.test(den)) return;
    if (!MATH_CHARS.test(num) || !MATH_CHARS.test(den)) return;
    out.push({ raw, num, den });
  };
  for (const m of skeleton.matchAll(/\(([^()<>]{1,40})\)\/\(([^()<>]{1,40})\)/g)) push(m[1], m[2], m[0]);
  for (const m of skeleton.matchAll(/(?<![0-9a-zA-Z√²³])([0-9a-zA-Z√]{1,6}[²³]?)\/\(([^()<>]{1,40})\)(?![0-9a-zA-Z])/g)) {
    if (isUnitPair(m[1], m[2])) continue;
    push(m[1], m[2], m[0]);
  }
  for (const m of skeleton.matchAll(/\(([^()<>]{1,40})\)\/([0-9a-zA-Z√]{1,6}[²³]?)(?![0-9a-zA-Z])/g)) {
    if (isUnitPair(m[1], m[2])) continue;
    push(m[1], m[2], m[0]);
  }
  return out;
}

/** A 级判据的**人话修法**（错误信息里直接给出正确写法，抄着就能改） */
export const FRACTION_FIX_HINT =
  '把被压扁的分式还原成竖式标记：' +
  '`<span class="fr"><span class="nu">2x+m</span><span class="de">x−4</span></span>`' +
  '（渲染端 .fr/.nu/.de 已支持竖排：分子在上、分母在下、中间分数线）。' +
  '原卷本来就是行文式斜杠（如行内 y=k/x）的保持斜杠不动——只还原**卷面上是上下结构**的。';

/** 入库器与门禁共用的人话错误信息（A级）。`hits` 取 flatComplexFractions 的返回值。 */
export function flatComplexFractionMsg(hits) {
  const show = hits.slice(0, 3).map(h => h.raw).join('、');
  return `题干里有**复合分式被压扁成斜杠**（${show}${hits.length > 3 ? ` 等 ${hits.length} 处` : ''})——` +
    '原卷上是上下结构（分子在上、分母在下）的分式，转录时被拍平成了 `(...)/(...)`，' +
    '读者看到的不是卷面的写法（用户 2026-11-22 定案：原题是上下结构，转换出来也必须是上下结构）。' +
    FRACTION_FIX_HINT;
}

/* ---------- B 级：简单比值清单（只报告，不阻断） ---------- */

/**
 * 已知**单位/比值型**豁免：这些两侧组合不是分数，永远不报。
 * 分母是时间/转速单位、或整体是「量纲比值」的形态。
 */
export const UNIT_EXEMPT =
  /^(?:m|km|cm|mm|s|min|h|t|L|mL|g|kg|r|rev|n|J|W|Pa|Hz|N|V|A|Ω)$/i;

/**
 * 简单分式压扁命中：`a/b` 线性形态，两侧均为短数理串。
 * ⚠ 只出**B 级清单**（原卷可能是行文式也可能是竖式，机器判不了，人工回原卷核对）。
 * 豁免：单位（UNIT_EXEMPT 侧）、前后紧邻字母数字（`a1/b2` 变量名、`p25/p25` 页码、
 * `if/whether` 词组——词组因含非数理字符自然排除，页码由前后文剔除）。
 * 返回 [{raw, num, den}]。
 */
export function flatSimpleFractions(html) {
  const s = String(html || '');
  const skeleton = s
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ');
  const out = [];
  for (const m of skeleton.matchAll(/(?<![0-9a-zA-Z√π²³⁴⁵⁶⁷⁸⁹⁰½¼¾])((?:\d{1,4}|[a-z][a-z0-9]{0,5}|√[0-9a-z]{1,6}|[0-9a-z]{1,4}√[0-9a-z]{1,6}))\/([0-9a-z]{1,6})(?![0-9a-zA-Z])/g)) {
    const num = m[1], den = m[2];
    /* 单位豁免：m/s、r/min、km/h、N/kg 这类——两侧都命中单位词表才豁免（a/m 表头=num侧是字母也算） */
    if (UNIT_EXEMPT.test(num) && UNIT_EXEMPT.test(den)) continue;
    /* 页码豁免：p25/p25、p36/p50 这类——两侧都是「字母 p + 纯数字」的组合形态 */
    if (/^p\d{1,4}$/i.test(num) && /^p?\d{1,4}$/i.test(den)) continue;
    out.push({ raw: m[0], num, den });
  }
  return out;
}

/** 判据⑨的 B 级提示（人话） */
export const SIMPLE_FRACTION_NOTE =
  '这些是**线性斜杠比值**——若原卷上是竖式分数（分子在上分母在下），应改成 ' +
  '`<span class="fr"><span class="nu">…</span><span class="de">…</span></span>`；' +
  '若原卷本来就是行文式（行内 y=k/x、表头 a/m）则保持斜杠。机器判不了原卷形态，请回原卷逐处核对（只报告，不阻断）。';
