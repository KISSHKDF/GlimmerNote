#!/usr/bin/env node
/**
 * _应做动作.mjs —— 五段闭环「第四段：应做动作」的**唯一真源**。
 *
 * 为什么必须单独住一个文件（2026-11-09 事故）：
 *   「判定 → 应做动作」的映射原先在 `_闭环稽核.mjs` 里算，而 `_待确认.mjs` 的注释里
 *   **另写了一份口径**，两边从首次公开导入（2026.10.25.02）起就不一致——
 *   稽核要求 `判定=不适用 ⇒ 已核销`，工具注释写的是"应做动作固定为「无需处置」"。
 *   04:00 夜间自动处理链照文件里的取值清单办事，2026-11-09 那批**第一次**遇到
 *   「不适用」条目，就把处置登记成「无需处置」⇒ 25 条 RED（37/42 登记成同一值）。
 *   本模块把 required()/closed() 收成一个家：稽核与待确认**import 同一份函数**，
 *   以后不许再各写一份（AGENTS.md 设计红线 8：一份事实只住一个家）。
 *
 * 口径（改动前请先读 `docs/待办闭环.md` 与本文件注释；改这里的语义会同时影响
 * 稽核判红与「处置」命令的准入闸）：
 *   · 无法判定 → 待人工
 *   · 不适用   → **已核销**（非题目类：判的对象不存在，但动作可能仍存在，
 *                所以不给"自动无需处置"，必须显式写下"做了什么"才算闭环）
 *   · 错/部分对 → 在册 ⇒ 无需处置；不在册 ⇒ 补建卡
 *   · 对        → 在册 ⇒ 撤卡；不在册 ⇒ 无需处置
 */

/** 「处置」字段的合法取值（`_待确认.mjs 处置 --as` 的闭集）。 */
export const DISPOSITIONS = ['无需处置', '已补建卡', '已撤卡', '已核销', '待人工'];

/** 「判定」字段的合法取值（`_待确认.mjs 判定 --verdict` 的闭集）。 */
export const VERDICTS = ['错', '对', '部分对', '无法判定', '不适用'];

/**
 * 应做动作 = f(判定, 该题此刻是否在册)。
 * @param {string} verdict 判定值
 * @param {boolean} hasCard 该题在册库中是否存在对应卡
 * @returns {string} 应做动作（DISPOSITIONS 之一，或兜底 待人工）
 */
export function required(verdict, hasCard) {
  if (verdict === '无法判定') return '待人工';
  // 非题目类（系统维护、纯笔迹归属追责）：判的对象不存在，但**动作可能仍存在**
  // （例：T024 要求重裁 4 张低饱和截图，实测至今没做）。故不给"自动无需处置"，
  // 而是要求显式核销——必须有人写下「做了什么」才算闭环。
  if (verdict === '不适用') return '已核销';
  if (verdict === '错' || verdict === '部分对') return hasCard ? '无需处置' : '补建卡';
  if (verdict === '对') return hasCard ? '撤卡' : '无需处置';
  return '待人工';
}

/**
 * 已登记的处置是否**真的**完成了应做动作（稽核判 GREEN 的判据）。
 * 注意：`已核销` 是万能的"我显式核销了"，对任何 required 都算闭环；
 * `待人工` **不算**闭环（稽核会记 BLOCKED＝设计内的"留给人"），除非 required 本身就是它。
 * @param {string} requiredAction required() 的输出
 * @param {string} disp 已登记的处置值
 */
export function closed(requiredAction, disp) {
  if (!disp) return false;
  if (requiredAction === '补建卡') return disp === '已补建卡';
  if (requiredAction === '撤卡') return disp === '已撤卡' || disp === '已核销';
  if (requiredAction === '无需处置') return disp === '无需处置' || disp === '已核销';
  if (requiredAction === '已核销') return disp === '已核销';
  if (requiredAction === '待人工') return disp === '待人工' || disp === '已核销';
  return false;
}

/**
 * 与判定**强绑定、不依赖"在册与否"**的处置准入规则。
 *
 * 用于 `_待确认.mjs 处置` 的机械闸：这两类判定里，登记成别的值一定是错的
 * （2026-11-09 那 25 条 RED 里，16+1 条正是踩了这一格）。
 * `错/对/部分对` 不在此表内：它们要看了在册与否才能判，闸放行、由稽核兜底。
 */
export const VERDICT_BOUND_DISPOSITIONS = {
  不适用: ['已核销', '待人工'],
  无法判定: ['待人工', '已核销'],
};

/**
 * 给人/给 agent 的一句话解释：这条判定的应做动作是什么、为什么。
 * 夜间链与 CLI 报错文案共用，避免再出现"两边各写一份口径"。
 */
export function requiredWhy(verdict, hasCard) {
  const req = required(verdict, hasCard);
  if (verdict === '无法判定') return `${req}：判不了就不能自己动卡，写清缺什么证据`;
  if (verdict === '不适用') return `${req}：非题目类没有"对错"可言，但必须显式写下你做了什么（或登记 待人工）`;
  if (verdict === '对') return hasCard ? `${req}：孩子做对了而卡还在册，该撤卡——撤卡要人点头就登记 待人工 并写明「应撤卡：<卡号>」` : `${req}：孩子做对了且册内无此卡，无需动作`;
  if (verdict === '错' || verdict === '部分对') return hasCard ? `${req}：卡已在册，无需再建` : `${req}：卡不在册，要补建（补建要走录题链路，夜间只登记 待人工 并写明「应补建卡：<卡号>」）`;
  return `${req}`;
}
