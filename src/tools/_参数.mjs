#!/usr/bin/env node
/**
 * 错题本 · 命令行参数解析（唯一实现）
 *
 * 为什么存在（2026-11-04 外部复核实测 M1）：
 *   原先 7 个工具各抄一份解析器，判据都是这一句：
 *       if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
 *       else opt[k] = true;
 *   也就是说：**"下一个参数长得像不像 flag"决定了它是不是这个 flag 的值**。
 *   于是值以 `--` 开头时会被**解析成另一个 flag**：
 *       node _标记复习.mjs 组卷 --student 学生甲 --ids C0101 --note --force
 *       ⇒ opt = { note: true, force: true }
 *       ⇒ --force 被**凭空打开** ⇒ 盲解门禁 / 答案来源门禁 / 作答契约门禁 /
 *         防重复印卷门禁**全被绕过**。
 *   这不是命令注入（Node 侧全是 argv 数组，C# 侧有 QuoteArgs 转义，值进不了命令位），
 *   但它让**数据质量守卫**可以被一个普通字段悄悄关掉。
 *
 * 本模块的修法（**唯一实现，不给各工具留例外**）：
 *   ① **已知带值 flag 一律无条件消费下一个参数** —— 哪怕它长得像 `--xxx`。
 *      这样 `--note --force` ⇒ opt.note = "--force"，opt.force 不存在（没传就是没传）。
 *      判据表由调用方传入（每个工具声明自己的带值 flag 清单），带**兜底**：
 *      未知 flag 一律按"布尔开关"处理（`opt[k] = true`），不猜它有没有值。
 *   ② **未声明的 flag** 仍按老口径：下一个不像 flag 就当值 —— 但这条只对
 *      "调用方自己拼 argv"的场景有意义；壳的 AddFlag 是**逐项固定映射**，
 *      声明表覆盖得到。
 *   ③ 提供 `--` 终止符：其后的一切都是**位置参数**，一律不当 flag。
 *
 * 为什么要"已知带值 flag 无条件消费"而不是"拒绝以 -- 开头的值"：
 *   前者一次修好所有 flag（以后加新 flag 不会重犯），且不改变正常用法的行为；
 *   后者需要每个工具各自记得检查（7 处 = 7 个漏网机会）。
 *
 * 用法：
 *   import { parseArgs } from './_参数.mjs';
 *   const opt = parseArgs(process.argv.slice(2), { valueFlags: ['student', 'ids', 'note'] });
 */
import path from 'path';
import { fileURLToPath } from 'url';

export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析命令行参数。
 * @param {string[]} argv    完整 argv（含动作名在 [0]）
 * @param {object}  opts
 * @param {string[]} opts.valueFlags  已知"带值"的 flag 名（不含 --）
 * @param {number}   opts.start       从第几个参数开始当 flag（默认 1：argv[0] 是动作名）
 * @returns {{action: string|undefined, opt: object, positional: string[]}}
 */
export function parseArgs(argv, { valueFlags = [], start = 1 } = {}) {
  const valueSet = new Set(valueFlags);
  const opt = {};
  const positional = [];
  let action;
  let i = 0;
  /* 动作名 = 第一个既不是 flag 也不是 flag 值的参数
     ⚠ start=0：**没有动作名**的工具（argv[0] 永远是 flag，如 `_建学生.mjs --name 小明`）
       —— 此时**不预留动作名槽**，argv 里每个 token 都按 flag/位置参数解析。
       为什么必须有这条：没有它时，`--name 小明` 里的"小明"会被当成动作名吃掉，
       而 `--name` 因为落在动作名槽之前**整条没被解析** ⇒ 参数静默丢失。 */
  if (start > 0) {
    for (; i < argv.length; i++) {
      const t = argv[i];
      if (t === '--') { i++; break; }        // 终止符：其后全是位置参数
      if (t.startsWith('--')) continue;      // flag 在动作名之前 ⇒ 忽略（罕见）
      action = t; i++; break;
    }
  }
  for (; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') { for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]); break; }
    if (!t.startsWith('--')) { positional.push(t); continue; }
    const k = t.slice(2);
    if (valueSet.has(k)) {
      /* ★ 已知带值 flag：**无条件**消费下一个参数（哪怕它长得像 flag）。
         这是修 M1 的核心：值是 "--force" 时，它就是 "--force" 这个**值**，
         不会变成"打开了 force 开关"。 */
      if (i + 1 < argv.length) { opt[k] = argv[++i]; }
      else { opt[k] = true; }               // 给了 flag 但没给值 ⇒ 视为布尔（后续校验会响亮拒绝）
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      /* 未知 flag：保留老口径（下一个不像 flag 就当值）—— 兼容既有调用方式 */
      opt[k] = argv[++i];
    } else {
      opt[k] = true;
    }
  }
  return { action, opt, positional };
}

/**
 * 常见带值 flag 的默认清单（工具按需扩展）。
 * 语义：**列进来的 flag 一定带值**，解析器无条件消费下一个参数。
 * ⚠ 布尔开关（force / dry / json / refresh / all / k / allow-empty …）**绝不能**进这个表 ——
 *   它们后面跟的下一个参数是**别的 flag**，无条件消费会把那个 flag 吃掉。
 *   本表与各工具的 opt.<name> 用法一一核对过（2026-11-04）。
 * ⚠ 两个曾经踩过的坑（**别把它们加回来**）：
 *   · `auto` —— `_待确认.mjs 定位 --auto` 是**布尔**（自动推导题号）。
 *     它在本表里 ⇒ `定位 --auto --dry` 会让解析器吃掉 `--dry`
 *     ⇒ `opt.auto='--dry'`、`opt.dry=undefined` ⇒ **"只预览"悄悄变成"真写盘"**。
 *   · `apply` —— `_待确认.mjs 去黑话 --apply` 同样是**布尔**，同族坑。
 *   布尔开关进表 = 把"下一个 flag"吞掉 = 安全门禁失效，这类错误**必须靠逐个 flag 核对**发现。
 */
export const COMMON_VALUE_FLAGS = [
  // 壳的 AddFlag 固定映射覆盖的（全部带值）
  'ask', 'at', 'box', 'card', 'cardConflict', 'card-conflict', 'date', 'detail',
  'evidence', 'grade', 'ids', 'image', 'kind', 'name', 'note', 'paper', 'q',
  'qref', 'reason', 'recipe', 'results', 'sha', 'source', 'student', 'subject',
  'textbook', 'title', 'to',
  // 其它工具的带值 flag
  'file', 'data', 'text', 'target', 'mode', 'scope', 'slots', 'out', 'answer',
  'payload', 'payload-file', 'verdict', 'why', 'as', 'candidate',
  'origbox', 'origpage', 'evidnote', 'by', 'need', 'ref', 'char', 'conf',
  'counter', 'feature', 'ink', 'material', 'metric', 'page', 'range', 'sample',
  'type', 'zoom', 'case', 'from-pending', 'packs', 'lane', 'layer', 'solver',
  'no-repeat-days', 'leech-at', 'id',
];
