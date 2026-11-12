/**
 * 拾光小册 · 难度在线估计（Elo 式，**零副作用**模块，2026-11-13 立，批次 4「后接 Elo」）
 *
 * 为什么要有：卡上的 `difficulty` 是**人工三档**（易/中/难），录入时凭手感填、之后再没人动过 ——
 * 它既不知道"这道题对**这个孩子**到底难不难"，也不会随孩子进步而变。外部调研把
 * "Elo 式在线更新（每答一次就更新题难度与孩子能力）"列为**最推荐的算法改动**
 * （为冷启动/小样本设计，零依赖可实现；Klinkenberg et al. 2011）。
 *
 * 口径（写清楚，免得后人调参时把方向搞反）：
 *   · `ability`＝孩子当前能力（一个学生一个数）；
 *   · `elo`＝这道题的**难度估计**，语义是"能力到多少的孩子有 50% 把握做对"；
 *   · 期望得分 `E = 1 / (1 + 10^((elo - ability)/400))`（标准差 400 的 logistic）；
 *   · 实际得分：对 = 1、半对 = 0.5、错 = 0；
 *   · **答对** ⇒ 孩子能力**升**，同时这道题**被证明比预想的容易** ⇒ 题的 `elo` **降**。
 *     两个方向相反不是笔误：题目是"对手"，孩子赢 ⇒ 对手显得弱。
 *
 * ⚠ 与人工 `difficulty` 的关系：**不替代、不修改**它。人工档位只用来给新卡一个**先验**
 *   （见 `initialEloOf`），比一律 1500 收敛得快；之后两套并存，各说各的话。
 * ⚠ 纯函数、确定性：同样输入永远同样输出（便于测试与对拍），不读文件、不碰 argv。
 */

/** 新卡/新学生的起点分。 */
export const ELO_INIT = 1500;

/** 题目难度的学习率。比学生的**慢**：一道题只会被答几次，抖太厉害没意义（噪声当信号）。 */
export const K_CARD = 16;

/** 孩子能力的学习率。比题目的**快**：能力会变（学会了就是学会了），而且要尽快跟上。 */
export const K_STUDENT = 24;

/** 用人工三档给新卡一个**先验**难度（之后由数据自己走）。
 *  没填档位（空串/缺字段）就回落到中位。 */
export function initialEloOf(difficulty) {
  const d = String(difficulty == null ? '' : difficulty).trim();
  return { '易': 1420, '中': 1500, '难': 1600 }[d] || ELO_INIT;
}

/** 期望得分：能力 `ability` 的孩子做难度 `elo` 的题，能拿多少分（0..1）。 */
export function expectedScore(elo, ability) {
  return 1 / (1 + Math.pow(10, (Number(elo) - Number(ability)) / 400));
}

/** 判分结果 → 实际得分。未知结果按 0（调用方本来就只允许 对/半对/错）。 */
export function scoreOf(result) {
  return result === '对' ? 1 : (result === '半对' ? 0.5 : 0);
}

/** 一次判分后的新估计。返回 `{ elo, ability, expected, score, delta }`（都是整数分，便于落盘比对）。
 *  `elo` / `ability` 传 `undefined`/非有限数时，分别用"人工档位先验"与 `ELO_INIT` 兜底。 */
export function applyElo(opts) {
  const o = opts || {};
  const elo0 = Number.isFinite(o.elo) ? Number(o.elo) : initialEloOf(o.difficulty);
  const ab0 = Number.isFinite(o.ability) ? Number(o.ability) : ELO_INIT;
  const kCard = Number.isFinite(o.kCard) ? Number(o.kCard) : K_CARD;
  const kStu = Number.isFinite(o.kStudent) ? Number(o.kStudent) : K_STUDENT;
  const s = scoreOf(o.result);
  const exp = expectedScore(elo0, ab0);
  const delta = s - exp;
  return {
    elo: Math.round(elo0 - kCard * delta),      // 题目：被答对 ⇒ 变简单（方向与学生相反）
    ability: Math.round(ab0 + kStu * delta),    // 学生：答对 ⇒ 能力升
    expected: exp,
    score: s,
    delta,
  };
}
