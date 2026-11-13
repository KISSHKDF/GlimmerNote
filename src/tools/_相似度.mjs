/**
 * 拾光小册 · 中文文本相似度（**零副作用**共享模块，2026-11-13 立，批次 4）
 *
 * 为什么要有：判断"这两段题干是不是同一道题"在三个地方都要用 ——
 *   · `_配方.mjs` 给"别人的 AI"打分（回传的题面与黄金样本差多少）；
 *   · `_录题入库.mjs` 录入时提示"库里可能已经有这道题了"；
 *   · 将来题库的"找相似"入口。
 *   改前只有 `_配方.mjs` 里有一份（而它是 **CLI**，别的工具 import 它会继承 argv 解析副作用，
 *   见 L-874）⇒ 想复用只能再抄一份。抽到零副作用模块是唯一正解。
 *
 * 为什么用 **bigram Dice** 而不是分词或编辑距离：
 *   · 分词需要词典（本仓零依赖，且中文学科术语词典根本不现实）；
 *   · 编辑距离对"抄写时多一个空格/标点全半角不同"过度敏感 —— 同一道题会被算成不同题；
 *   · 字符 bigram + Dice 对中文短句的直觉与实测都够用，且**确定性**（同样输入永远同分）。
 */
export { };

/** 归一化：**NFKC**（全角→半角一步到位，含 `？`/`！`/`（）`/全角字母数字与空格）+ 去空白 +
 *  CJK 标点补映射 + 转小写。
 *
 *  ★ 2026-11-13（写用例时抓到的真缺陷）：首版只映射了 `，。；：、（）` 与全角字母数字，
 *    **漏了 `？`/`！`** ⇒ `计算：3+4=？` 与 `计算: 3+4=?` 的相似度只有 **0.857** ——
 *    同一道题因为一个全角问号被算成"不太像"。改用 `normalize('NFKC')` 一次覆盖全部兼容字符，
 *    CJK 标点（`。` `、` 等没有兼容分解的）再手工映射。
 *  ⚠ NFKC 会把上标也压平（`x²` → `x2`）—— 对**相似度**用途这是好事（抄写时上标最容易丢），
 *    但别拿 `normText` 当"内容指纹"用：同一性判据仍然是 sha256。 */
export function normText(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。；：、]/g, (m) => ({ '，': ',', '。': '.', '；': ';', '：': ':', '、': ',' }[m]))
    .toLowerCase();
}

/** 字符 bigram 的 **Dice 系数**（0..1）：1 = 完全一致，0 = 毫无共同片段或任一为空。
 *  ⚠ 它是**相似度**不是**同一性**判据：本题库里"同一道题"的硬判据仍是归一化题干的 sha256
 *  （`_分流器.mjs` 的题面级判重）—— 完全一致才算命中。相似度只用于**给人看**的提示。 */
export function dice(a, b) {
  const A = normText(a), B = normText(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(A), gb = grams(B);
  let inter = 0, total = 0;
  for (const [g, n] of ga) { total += n; inter += Math.min(n, gb.get(g) || 0); }
  for (const [, n] of gb) total += n;
  return total ? (2 * inter) / total : 0;
}

/** 「疑似同一道题」的**提示阈值**（不是拦截阈值）。
 *  0.9 的意思：归一化后 90% 的 bigram 重合。低于它的差异通常来自"多问了一句/换了数字"，
 *  那多半是**另一道题**，不该提示（提示太多人就不看了 —— 仓内 L-175 那条告警疲劳）。 */
export const SIMILAR_HINT = 0.9;

/** 在候选列表里找与新文本相似的条目，返回按相似度降序的前 N 条（默认 3）。
 *  `items` 每项需有 `text` 与任意标识字段（原样带出，便于调用方点名）。
 *  ⚠ 只看相似度、**不做任何判定**：调用方拿它去"提示人"，不许拿它去自动合并/自动拦。 */
export function findSimilar(text, items, { threshold = SIMILAR_HINT, limit = 3 } = {}) {
  const t = normText(text);
  if (t.length < 8) return [];                     // 太短的文本（"计算""填空"）没有可比性
  const out = [];
  for (const it of items || []) {
    const s = dice(t, it && it.text);
    if (s >= threshold) out.push({ score: s, item: it });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
