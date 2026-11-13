/**
 * 拾光小册 · `answerSource`（答案来源）取值的**唯一真源**（2026-11-12 立，审计 F04）
 *
 * 为什么单独成文件：同一份取值契约原先散在 **3 处代码 + 2 份配方 schema** 里，而且**语义还不一致**：
 *   · `_标记复习.mjs:193`  前缀集 `['独立判卷','官方答案']` + 精确集 `['红笔订正+官方答案页核对']`
 *   · `_盲解复核.mjs:122`  **又一份**前缀集 `AS_PREFIX_OK = ['独立判卷','官方答案']`
 *   · `_录题入库.mjs:868`  **精确集** `['独立判卷','官方答案','红笔订正+官方答案页核对','未能确认']`
 *   · `recipes\ingest-page|ingest-single\schema.json` 同精确集（AI 回传值的输入契约）
 * 后果（实测形态）：`_盲解复核.mjs:159` 自己写入的值是 **`独立判卷（双路盲解×2 一致）`**（带括号限定）
 *   ⇒ 前缀式判据放行、**精确集判"取值不在契约内"** —— 于是 `_录题入库.mjs 改卡` 对这类卡直接失败。
 *
 * 口径（用户 2026-11-09 裁定的"三级证据"）：**带括号的限定后缀是合法且更信息丰富的**，
 * 例如 `独立判卷（双路盲解×2 一致）` 说明"哪一路判的"。⇒ 判据一律**按基础值比对**（剥掉后缀）。
 * 「老师定案」**已废除**：卷面红字绝大部分不是老师批的，红字只作普通参考、不作定案标准
 * （即使确认是老师写的也不行）。
 *
 * ★ 2026-11-13（P0-B 复合值修复，决策点 1 用户批准）：库里有大量**复合形态**取值
 *   （`独立判卷+红笔一致` 88 张、`独立判卷（…）+老师红笔一致（…）` 等）——旧实现只剥**末尾**
 *   括号，复合值整体不匹配任何在册值 ⇒ 103 张证据更强的卡被误拒在组卷池外（审计终稿 §二）。
 *   新口径：**先剥全部括号 → 整体在册则整体算 → 否则按 +/＋ 切段**；
 *   复合值按"各段证据强度的最大值"判：任一段是独立来源/双源即合格，红笔段只加强、不否决。
 *   `官方答案比对（…）` 仍**不在册**（2026-11-13 决策点 1b：涉事卡走数据修正改写为规范形，
 *   **不扩契约别名**）。
 *
 * ⚠ 本文件必须保持**零副作用**（不解析 argv、不读库根）——它被多个 CLI 工具 import（见 L-729）。
 */

/** 与红笔无关的**独立来源**：合格，单靠自己就能确立答案。 */
export const SOURCE_INDEPENDENT = ['独立判卷', '官方答案'];

/** **双源**：红笔订正 + 官方答案页核对 ⇒ 权威性来自官方答案页，红笔只是"对照片"。 */
export const SOURCE_DUAL = ['红笔订正+官方答案页核对'];

/** 明确记下"没查到可靠来源"——它是**诚实的取值**，不是不合格。 */
export const SOURCE_UNCONFIRMED = ['未能确认'];

/** 契约内全部取值（= 三级证据 + 未确认）。 */
export const SOURCE_BASE = [...SOURCE_INDEPENDENT, ...SOURCE_DUAL, ...SOURCE_UNCONFIRMED];

/** 已废除的取值前缀（2026-11-07 用户裁定）。 */
export const SOURCE_RETIRED = '老师定案';

/** 剥掉**所有**「（…）」限定括号与多余空白（P0-B：复合值的括号可能出现在任意段的中部）。
 *  迭代到不动点：嵌套括号外层剥掉后内层才可见。 */
function stripAllParens(v) {
  let prev, s = String(v == null ? '' : v).trim();
  do { prev = s; s = s.replace(/[（(][^（()）]*[）)]/g, ' '); } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim();
}

/** 复合值切段：按 `+`/`＋` 拆开、逐段去空白。
 *  ⚠ 合法单值 `红笔订正+官方答案页核对` 自身含 `+`——调用方必须**先**做整体在册匹配，
 *  没匹配上才允许切段（顺序反了会把合法单值打散）。 */
function splitCompound(s) {
  return s.split(/[+＋]/).map(x => x.trim()).filter(Boolean);
}

/** 取**基础值**：剥掉全部「（…）」限定括号与首尾空白。
 *  `独立判卷（双路盲解×2 一致）` → `独立判卷`；
 *  `独立判卷（…）+老师红笔一致（…）` → `独立判卷 +老师红笔一致`（含中部括号）；
 *  `老师定案` → `老师定案`（由调用方判废除）。 */
export function baseSourceOf(v) {
  return stripAllParens(v);
}

/** 复合值拆段（P0-B 内部用 + 导出供测试对拍）：整体在册的值不进这里。 */
export function basePartsOf(v) {
  const raw = String(v == null ? '' : v).trim();
  if (raw.startsWith(SOURCE_RETIRED)) return [raw];     // 废除值保持原语义（由 isRetiredSource 判）
  const s0 = stripAllParens(raw);
  if (SOURCE_BASE.includes(s0)) return [s0];            // 保住含 + 的合法单值（红笔订正+官方答案页核对）
  return splitCompound(s0);
}

/** 佐证段特征（P0-B，按 2026-11-13 真库全枚举定界）：红笔批改佐证与整页照片复核段。
 *  佐证段**只加强、永不单独确立契约**（some-独立/双源 兜住），所以特征匹配放宽不破坏红线；
 *  破红线的唯一通道（乱写值被当成独立/双源段）由 SOURCE_BASE 闭集守住。 */
const SUPPORTING_RE = /红(笔|字)|复核|核验/;

/** 取值是否在契约内（P0-B 后：**整体在册 或 复合值逐段判定**）。
 *  ⚠ 这是"读卡/改卡"的宽容判据 —— 工具自己会写带限定的值，不能因此判非法。
 *  逐段判定：独立/双源段 ∈ SOURCE_BASE（闭集）；佐证段按 SUPPORTING_RE 特征认。
 *  纯佐证段序列（无独立/双源段）不在册 —— 红字想复合着单独定案，不行。 */
export function isInContract(v) {
  const parts = basePartsOf(v);
  if (parts.length === 1) return SOURCE_BASE.includes(parts[0]);
  const ok = parts.every(b => SOURCE_BASE.includes(b) || SUPPORTING_RE.test(b));
  const hasReal = parts.some(b => SOURCE_INDEPENDENT.includes(b) || SOURCE_DUAL.includes(b));
  return ok && hasReal;
}

/** 是否属于**与红笔无关的独立来源**（组卷准入用：决定这张卡能不能自己站住）。
 *  P0-B：复合值按"最强段"判——任一段是独立来源即算（红笔段只加强）。 */
export function isIndependentSource(v) {
  return basePartsOf(v).some(b => SOURCE_INDEPENDENT.includes(b));
}

/** 是否声明了**官方渠道**（`官方答案` / `红笔订正+官方答案页核对`，或复合值中含这两类段）。
 *  这两类都要求 `answerSourceNote` 写出可复核的出处（站点名 / 答案页页码 / 文件名）——
 *  判据在 `_录题入库.mjs`，见"先搜公开题库"那一段。 */
export function isOfficialSource(v) {
  return basePartsOf(v).some(b => b === '官方答案' || SOURCE_DUAL.includes(b));
}

/** 是否已废除的取值（「老师定案」及其任何限定形态）。 */
export function isRetiredSource(v) {
  return String(v == null ? '' : v).trim().startsWith(SOURCE_RETIRED);
}

/** 答案来源是否**合格**（组卷准入用）。
 *  `_标记复习.mjs` 与 `_盲解复核.mjs` 原先**各抄一份**同一判据（后者的注释自己就写着
 *  "两处各抄一份必然漂移 —— 见 L-530 族"），本函数是它俩的唯一真源。
 *
 *  · 独立来源（独立判卷 / 官方答案）⇒ 合格；
 *  · 红笔订正 + 官方答案页核对 ⇒ 双源，合格；
 *  · **复合值**（P0-B 修复）⇒ 按"最强段"判：任一段独立/双源即合格，红笔段只加强、不否决；
 *  · 「老师定案」（已废除）⇒ **单靠自己一律不合格**，只有 `independentProof` 为真时放行 ——
 *    放行理由是"答案本身另有独立出处、站得住"，**不是**"老师写的所以对"。
 *
 *  `independentProof` 由**调用方注入**（`_标记复习` 传 `blindVerified(it)`、`_盲解复核` 传
 *  `VERIFIED.includes(it.blindStatus)`）—— 共享模块不认识盲解台账/准入字段，保持零依赖。 */
export function isAcceptableSource(v, { independentProof = false } = {}) {
  if (isRetiredSource(v)) return independentProof;
  const parts = basePartsOf(v);
  if (parts.some(b => SOURCE_INDEPENDENT.includes(b))) return true;
  if (parts.some(b => SOURCE_DUAL.includes(b))) return true;
  return false;
}
