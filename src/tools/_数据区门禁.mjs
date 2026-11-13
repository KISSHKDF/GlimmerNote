#!/usr/bin/env node
/**
 * 拾光小册 · 数据区门禁（唯一实现）
 *
 * 判决依据：`docs\数据区规范.md` §六「门禁（G 系列）」的 G1..G9 判据表。
 * ⚠ 本文件**不发明规则**：每条判据都能指回规范里的一条规则（N / C / F 系列）。
 *   规范新增一类 = 改规范 §三 的登记表 + 改本文件的登记表 + 加一条阴性对照用例，三件一起做，缺一不算。
 *
 * 为什么要有它（它治什么形态）：
 *   规范立起来之前，"库里放什么、叫什么"只活在人的记忆与各工具的隐含假设里 —— 实测真库同时存在
 *   两种命名 × 两种索引形态（一个目录用**年级**当名字、另一个是 `<年级>-<小名>` 且把索引按学科拆成三份），
 *   而**没有任何机器判据**能说出"这样不对"。本工具把判据变成可执行的：
 *   能红、点名到路径、给可照做的修法（先根因与证据，再给修法，见 AGENTS.md「与用户协作」）。
 *   ⚠ 本文**不举真实化名**：`tests\repo-hygiene.cjs` 对 tracked 文件做禁词 0 命中机检，
 *     这里一律用 `<小名>` / `学生甲` / `学生乙` 这类占位（阴性对照里也有一条自查断言守着）。
 *
 * 与其他门禁的分工（一份事实只住一个家，红线 8）：
 *   · 卡片内容类（空位/答案、配图、着重号、盲解、原卷台账…）各有自己的门禁，本工具**不重算**；
 *   · **G10 原卷落点**（规范 §二 N10）的机器判据已存在于 `_原卷台账.mjs 门禁` 的"库外 page"检查里，
 *     本工具只在判据表里注明指针，不实现第二份；
 *   · 本工具**不得接进** `tests\run.mjs`：`fixtures\` 是**故意**造成畸形形态的合成库
 *     （见规范 §六「作用域」），拿它判那些库等于要求工具链放弃读旧形态。
 *
 * 判据之外的"容许清单"也来自规范，别在本文件里加口径：
 *   · N11 学科目录闭集（卡目录 / `原卷\` / `待办证据\`·`_待确认证据-<YYYYMMDD>\` / `*.md` / `_`·`.` 开头）；
 *   · N12 `_备份-真源\` **任何层级**都合法（它由 `_安全写.mjs` 的 `backupJson()` 写在被备份文件旁边，
 *     规范按 §一「P1 双向义务」跟随唯一实现 —— 不是"下沉违规"）；
 *   · N10 `原卷\` 的两种合法落点。以上任一改动 = 改规范 + 改这里 + 改阴性对照。
 *
 * 用法：
 *   node src\tools\_数据区门禁.mjs [--data <库根>] [--json] [--help]
 *
 *   --data <库根>  显式指定库；**必须**在任何 libraryRoot() 之前落进 process.env.CTB_DATA
 *                  （`_原图寻址.mjs` 2026-11-03 的真实事故：库根在导入期被缓存 ⇒ --data 静默失效，
 *                   工具去读了**另一个**库。"静默读错地方"是本仓最忌讳的形态，故这里显式排序。）
 *   --json         机器可读信封
 *   --help / -h    判据表与用法
 *
 * 退出码：0 = 全绿；2 = 有违规；3 = 入参/环境错（未知参数、--data 缺值、库根不存在/解析不出）。
 *
 * 只读：本工具不写任何文件（阴性对照里有"跑前跑后逐字节快照相等"的断言守着这条）。
 */
import fs from 'fs';
import path from 'path';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';
import { readJsonStrict } from './_安全写.mjs';       // JSON 读取的唯一实现（剥 BOM / 拒绝"形状不对当空库"）
import { libraryRoot, describeRoots } from './_库根.mjs';

/* ══════════════════════════════════════════════════════════════════════════
 * 规范 → 机器判据的登记表（唯一真源是 docs\数据区规范.md）
 * ══════════════════════════════════════════════════════════════════════════ */
const RULES = [
  { id: 'G1', rule: 'N1', title: '学生目录名 = 该目录 _索引.json 的 student 字段（逐字符相等）' },
  { id: 'G2', rule: 'N2', title: '小名（目录名与 student 字段）不含年级词/学科词/时间词/日期/空白/分隔符/非法字符，且 ≤ 20 字符（词表见规范 §二 N2 表）' },
  { id: 'G3', rule: 'N3', title: '小名不是保留名（组卷、_ 或 . 开头）也不是 Windows 设备名' },
  { id: 'G4', rule: 'N4+N11末段+N12', title: '学科目录与 subjects 键一一对应、学科名在闭集内；`<小名>\\` 这一层是闭集（只允许 `_索引.json` + 学科目录 + `原卷\\` + `_`/`.` 开头，**不放 `*.md`**）' },
  { id: 'G5', rule: 'N5+N11', title: '卡目录名 = `<前缀><4位>-<描述>`（前缀对学科、描述 ≤ 40 字符、不重号）；学科目录里不得出现 N11 之外的条目' },
  { id: 'G6', rule: 'C3.1/3.2/3.3', title: '库根顶层是闭集（未登记条目即违规，P4）' },
  { id: 'G7', rule: 'C3.4②③', title: '库内任何位置不留 `*.bak-*` `*.bak` `*.old` `*.orig` `*.tmp-*` `_probe\\` `_tmp*\\` `_快照\\`；`tiles\\`/`_crops\\` 只在卡目录/原卷目录内部合法' },
  { id: 'G8', rule: 'F1', title: '一个学生恰好一份 _索引.json（禁止按学科拆成多份）' },
  { id: 'G9', rule: 'N6', title: '库级台账住在库根，不得下沉进学生目录' },
  { id: 'G11', rule: 'P9+N13', title: '跨学生同构：每个学生的必答项都成立（聚合 G1/G4/G5/G8，不重复实现）；共用区命名（`_收件箱`/`_盲解`/`_录题`/`_撤卡留档`/`组卷`/`_笔形`）按**每个学生分别**算合规率且各自 100%' },
];

/* §3.1 无前缀顶层（用户能看见的实体）+ §3.2 `_` 前缀程序保留区（枚举在册）
   ⚠ `_影像备份\` **已于 2026-11-06 按 P10 删除**（它既是原图的第 3 个家、又是其它影像的备份 ⇒ 冗余），
   因此**不在本表里** ⇒ 它一旦重新出现就是"库根顶层未登记条目"（G6 红）+ 库内残渣（G7 红）。
   这条是刻意的（P10：镜像不许回来）：要让镜像回来 = 推翻 P10，得改规范 + 改这里 + 加阴性对照。 */
const REGISTERED_DIRS = ['组卷', '_原图', '_备份-真源', '_收件箱', '_录题', '_盲解', '_撤卡留档', '_笔形', '_工具'];
/* §3.3 库根台账文件（枚举在册）—— 同时是 G9「台账下沉」的判据依据。
   ⚠ 白名单的语义是「**允许存在**」，不是「必须存在」：本工具只判"出现了什么"，
     某个登记文件缺席**永远不是违规**（没有任何"必答文件"判据）。
   `_整改台账.md` 是人读的整改欠账登记（只登记、不执行、不被任何工具写）——
     本门禁**只认它在不在白名单里，不读它的内容**（内容自由，扫它等于给"记笔记"立格式）。 */
const REGISTERED_FILES = [
  '_组卷台账.json', '_配图台账.json', '_原卷台账.json', '_原图台账.json', '_盲解双路.json',
  '_笔形台账.json', '_页码映射.json', '_待确认.json', '_待办欠账-派发.json',
  '_状态.json', '_复习队列.md', '_待确认清单.md', '_词表.md', '首页.html', '先看这里.txt', '_整改台账.md',
  /* ★ 2026-11-14（方案批次 2-3）：人读的原卷定位清账工作单。由 `_原卷台账.mjs 工单` 重算派生，
     门禁只认名字不读内容（同 `_整改台账.md` 的"记笔记不立格式"口径）。规范 §3.3 已同步登记。 */
  '_原卷待定位-按批次.md',
];
/* N9 唯一例外：库自身是 git 仓库，这两个是版本控制载体，不算数据条目 */
const N9_EXCEPTIONS = ['.git', '.gitignore'];

/* N4 学科闭集 + N5 前缀映射 */
const SUBJECTS = ['数学', '语文', '英语', '物理', '化学', '生物', '历史', '地理', '政治'];
const PREFIX = { 数学: 'M', 语文: 'Y', 英语: 'E', 物理: 'P', 化学: 'C', 生物: 'B', 历史: 'H', 地理: 'G', 政治: 'Z' };
/* N10 原卷落点：`<小名>\原卷\<批次>\` 与 `<小名>\<学科>\原卷\<批次>\` 是**规范写明的合法形态** ⇒
   `原卷\` 这个名字必须被 G4/G5 放行（否则门禁会把规范自己认可的位置判红 —— 首个版本正是这么误报的）。
   它的内容判据（page 落点）在 `_原卷台账.mjs 门禁`。 */
const ORIG_DIR = '原卷';
/* N11 学科目录闭集（除卡目录与 `_`/`.` 开头之外的三类）：
   ② `原卷\`（含 `_crops\`/`tiles\`）、③ `待办证据\` 与 `_待确认证据-<YYYYMMDD>\`、④ `*.md` 报告件。
   ⑤ `_`/`.` 开头的条目（N12 的 `_备份-真源\` 属此类）。其余即违规。 */
const EVIDENCE_DIR = '待办证据';
const EVIDENCE_DATED_RE = /^_待确认证据-\d{8}$/;
const REPORT_MD_RE = /\.md$/i;
/* N12：`_备份-真源\` 由 `_安全写.mjs` 的 `backupJson()` 写在**被备份文件旁边** ⇒ 任何层级都合法。 */
const BACKUP_DIR = '_备份-真源';

/* N2 词表（**字面集真源是规范 §二 N2 的表格**；对齐 = 改规范 + 改这里 + 加阴性对照，三件一起做）。
   ⚠ 规范表里没有的词不要在这里"顺手加上"，表里有的也不要"顺手删掉"：规则要写死，就不能靠实现的宽松兜底
     （表里没有的词不判红 = 规则有暗门）。`--help` 指向那张表。 */
const GRADE_RE = [
  /年级/,                                  // 七年级 / 9年级 / 年级上册 / 年级下册
  /[一二三四五六七八九][上下]/,             // 七上 / 八下
  /小学|初中|高中/,                         // 学段词
  /初[一二三]/,                             // 初一 / 初二 / 初三
  /高[一二三]/,                             // 高一 / 高二 / 高三
];
const SUBJECT_WORDS = SUBJECTS.slice();     // 学科词 = N4 的闭集
const TIME_RE = [
  /[上下]册/,                                        // 上册 / 下册
  /第[一二三四五六七八九十百千\d]+周/,                 // 第一周 / 第3周
  /第[一二三四五六七八九十百千\d]+单元/,               // 第一单元
  /[\d一二三四五六七八九十]+月份/,                     // 3月份
  /\d{1,2}月\d{1,2}日/,                              // 10月6日
  /国庆|寒假|暑假|期中|期末|月考/,
  /五一|十一|元旦|开学|假期/,                          // 节假日/学期节点
  /[春秋]季/,                                        // 春季 / 秋季
  /[上下]学期/,                                      // 上学期 / 下学期
  /\d{4}年/,                                         // 2026年
];
const DATE_RE = /\d{4}[-./]\d{1,2}([-./]\d{1,2})?/;   // 日期形态：2026-10-06 / 2026.10 / 2026/10/6
const SEPARATORS = ['-', '_', '.', '/', '\\'];
const ILLEGAL_CHARS = [':', '*', '?', '"', '<', '>', '|'];
const NAME_MAX = 20;      // N2 长度 ≤ 20 字符
const DESC_MAX = 40;      // N5 描述 ≤ 40 字符（防退化上限，不是审美；理由见规范 §二 N5）
/* N3 保留名 / Windows 设备名（CON/PRN/AUX/NUL/COM1..9/LPT1..9）。
   只判"严格等于设备名"：`CON.txt` 这种带点的形态已被 G2 的分隔符规则（`.` 是分隔符）拦下。 */
const RESERVED_NAMES = ['组卷'];
const DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const CARD_RE = /^([A-Z])(\d{4})-(.+)$/;
/* 卡目录候选：**只有**以 `^[A-Z]\d{4}` 开头的目录名才拿去套 N5 的形态判据。
   为什么要这条守卫：`待办证据\`、`_待确认证据-20261015\`、`2026-10-07-…批改报告.md` 都不是卡，
   拿 `<前缀><4位>-<描述>` 去套它们只会刷出一屏假阳（首个版本真这么误报过）。 */
const CARD_HEAD_RE = /^([A-Z])(\d{4})/;

/* §3.4 ② 残渣形态（G7）——**库内任何位置**（不限顶层）都不许有这些名字。
   判据是**名字形态**，与它是不是目录无关。`_快照\` 有唯一的合法位置（见 RESIDUE_LEGAL_AT）。 */
const RESIDUE = [
  { re: /^_probe$/i, why: '探针目录 `_probe\\`（P6：过程件零留存）' },
  { re: /^_tmp/i, why: '`_tmp*\\` 临时件（P6）' },
  { re: /^_快照$/, why: '`_快照\\`（库内快照清单；唯一合法位置是 `_原图\\_快照\\`）' },
  { re: /\.tmp-/, why: '`*.tmp-*` 写入临时件（W3）' },
  { re: /\.bak-/, why: '`*.bak-*` 备份残渣（W3）' },
  { re: /\.bak$/i, why: '`*.bak` 备份残渣（W3）' },
  { re: /\.old$/i, why: '`*.old` 备份残渣（W3）' },
  { re: /\.orig$/i, why: '`*.orig` 备份残渣（W3）' },
];
const residueOf = (name) => RESIDUE.find((r) => r.re.test(name)) || null;
/* `_快照\` 唯一的合法位置（§3.4 豁免表）：正好是 `<库根>\_原图\_快照`。别处的 `_快照\` 一律判红。 */
const RESIDUE_LEGAL_AT = new Map([['_快照', ['_原图', '_快照']]]);
function residueAllowedHere(root, p, name) {
  const legal = RESIDUE_LEGAL_AT.get(name);
  if (!legal) return false;
  const seg = path.relative(root, p).split(path.sep).filter(Boolean);
  return seg.length === legal.length && seg.every((s, i) => s === legal[i]);
}

/* §3.4 ② 的**穷举豁免**（只有这两处；理由见规范）：
   ① `_备份-真源\` 内部 —— **任何层级**（N12：它由 `backupJson()` 写在被备份文件旁边）；
   ② `_原图\_快照\`（内容寻址库的内部快照清单）。
   ⚠ 2026-11-06：`_影像备份\` 的豁免**已随目录删除而移除** —— 它现在不是"豁免区"，
     而是"不许出现"（见 REGISTERED_DIRS 上方那段）。 */
const RESIDUE_EXEMPT_NAME = BACKUP_DIR;                       // 任意层级的 `_备份-真源\`
function residueExempt(root, dir) {
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..')) return false;
  const seg = rel.split(path.sep).filter(Boolean);
  if (seg.includes(RESIDUE_EXEMPT_NAME)) return true;                        // N12：任何层级的 _备份-真源\
  if (seg.length >= 2 && seg[0] === '_原图' && seg[1] === '_快照') return true; // 保全库内部快照清单
  return false;
}

/* §3.4 ③ `tiles\` / `_crops\` 只在**卡目录 / 原卷目录内部**合法（可重建的中间产物）。
   出现在别处（尤其库根顶层）即违规。 */
const TILE_RE = /^(tiles|_crops)$/i;
function tileAllowedAt(root, dir) {
  const seg = path.relative(root, dir).split(path.sep).filter(Boolean);
  if (!seg.length) return false;                       // 库根顶层：违规
  if (seg.includes(ORIG_DIR)) return true;             // 原卷目录内部（含其下批次目录）
  return CARD_RE.test(seg[seg.length - 1]);            // 卡目录内部（父目录是卡目录）
}

/* ══════════════════════════════════════════════════════════════════════════
 * G11 共用区命名（N13）—— **跨学生共用**的那几个区，同一个目录里放两个孩子的件，
 * 所以命名必须"一眼分得清、且写法完全一致"（P9）。判据是**名字形态**，纯函数。
 *
 * ⚠ 最容易写错的一条（写在这里免得下轮又踩）：**判红只能是"某个位置出现了闭集外的条目"**，
 *   不许是"两个学生缺了同一种目录"。学生甲有物理、学生乙没有；学生甲物理有 `原卷\`、学生乙数学没有 ——
 *   那是**内容差异**，不是规则差异（规范 §一 P9 与 §六 G11 都写明了）。本文件里没有任何
 *   "两个学生的树必须一样"的比较逻辑，那是刻意的。
 * ══════════════════════════════════════════════════════════════════════════ */
const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_DATE_RE = /(?<!\d)\d{8}(?!\d)/;          // YYYYMMDD：N13 硬规矩判红（_录题 任务号除外）
const COMPACT_HINT = '；日期写成 `YYYYMMDD`，N13 硬规矩是**一律 `YYYY-MM-DD`**（唯一例外：`_录题\` 的时间戳型任务号）';

/** 在 `-` 分段的串里认出"在册小名"：先试整段，再试 `<小名>-` 前缀（长名优先，避免前缀歧义）。 */
function matchStudent(rest, students) {
  for (const n of students) {
    if (rest === n) return { name: n, tail: '' };
    if (rest.startsWith(n + '-')) return { name: n, tail: rest.slice(n.length + 1) };
  }
  // 没带分隔符的粘连（`<小名><学科>-…`）：把"小名 + 学科词"整体当前缀再试一次 —— 这类要按"缺分隔符"报，不许当解析不出去丢掉
  for (const n of students) {
    if (rest.startsWith(n)) return { name: n, tail: rest.slice(n.length), glued: true };
  }
  return null;
}

/** `_收件箱\` 批次目录：`<YYYY-MM-DD>-<小名>-<学科>[-<描述>]`（N13 第 2 条：描述可省，分隔符不可省） */
function checkInboxName(name, students) {
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name);
  if (!m) return { why: '不合 `<YYYY-MM-DD>-<小名>-<学科>[-<描述>]`（N13）' + (COMPACT_DATE_RE.test(name) ? COMPACT_HINT : '') };
  const hit = matchStudent(m[2], students);
  if (!hit) return { why: '小名不属于任何**在册学生目录**（N13：`<小名>` 必须是真实存在的学生目录名）' };
  if (hit.glued) return { why: '小名「' + hit.name + '」与学科之间**缺分隔符**（N13 第 2 条：少了分隔符即违规，小名成了「' + m[2].split('-')[0] + '」）', student: hit.name };
  if (!hit.tail) return { why: '缺 `<学科>`（N13：`<学科>` 不可省）', student: hit.name };
  const segs = hit.tail.split('-');
  if (!SUBJECTS.includes(segs[0])) return { why: '学科段「' + segs[0] + '」不在学科闭集内（N13）', student: hit.name };
  if (segs.some((s) => s === '')) return { why: '分段里出现空段（`--` 或结尾 `-`）—— 描述可省，但空段不是"省"（N13）', student: hit.name };
  return { ok: true, student: hit.name };
}

/** `_盲解\`：`<小名>-<学科>-盲解清稿[-第2路｜-重盲解].md` */
function checkBlindName(name, students) {
  const m = /^([^-]+)-([^-]+)-盲解清稿(-第2路|-重盲解)?\.md$/.exec(name);
  if (!m) return { why: '不合 `<小名>-<学科>-盲解清稿[-第2路|-重盲解].md`（N13）' };
  if (!students.includes(m[1])) return { why: '小名「' + m[1] + '」不在册（N13）' };
  if (!SUBJECTS.includes(m[2])) return { why: '学科段「' + m[2] + '」不在学科闭集内（N13）', student: m[1] };
  return { ok: true, student: m[1] };
}

/** `_录题\`：`t-YYYYMMDD-HHmmss-<6位hex>.json` —— **N13 日期硬规矩的唯一例外**（时间戳型 ID） */
function checkTaskName(name) {
  if (/^t-\d{8}-\d{6}-[0-9a-f]{6}\.json$/i.test(name)) return { ok: true };
  return { why: '不合 `t-YYYYMMDD-HHmmss-<6位hex>.json`（N13；任务号是时间戳型 ID，是日期硬规矩的唯一例外）' };
}

/** `_撤卡留档\`：批次式 `<YYYY-MM-DD>[-<描述>]` 或 单卡式 `<卡号>-<描述>-<YYYY-MM-DD>-<原因>` */
function checkWithdrawName(name) {
  if (/^\d{4}-\d{2}-\d{2}(-.*)?$/.test(name)) return { ok: true };        // 批次式（描述可省）
  const segs = name.split('-');
  const cardOk = /^[A-Z]\d{4}$/.test(segs[0]);                            // 单卡式：卡号开头
  for (let i = 2; i + 3 <= segs.length - 1; i++) {
    if (/^\d{4}$/.test(segs[i]) && /^\d{2}$/.test(segs[i + 1]) && /^\d{2}$/.test(segs[i + 2]) && segs[i + 3] !== '' && cardOk) return { ok: true };
  }
  return { why: '不合批次式 `<YYYY-MM-DD>[-<描述>]` 或单卡式 `<卡号>-<描述>-<YYYY-MM-DD>-<原因>`（N13）' + (COMPACT_DATE_RE.test(name) ? COMPACT_HINT : '') };
}

/** `组卷\`：`<YYYY-MM-DD>-<小名>-<重做卷｜答案册>-<HHmm>.pdf` */
function checkPaperName(name, students) {
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)-(重做卷|答案册)-(\d{4})\.pdf$/.exec(name);
  if (!m) return { why: '不合 `<YYYY-MM-DD>-<小名>-<重做卷|答案册>-<HHmm>.pdf`（N13）' + (COMPACT_DATE_RE.test(name) ? COMPACT_HINT : '') };
  if (!students.includes(m[2])) return { why: '小名「' + m[2] + '」不在册（N13）' };
  return { ok: true, student: m[2] };
}

/** `_笔形\` 样本件：`<YYYY-MM-DD>-<4位序号>.<ext>` */
function checkSampleName(name) {
  if (/^\d{4}-\d{2}-\d{2}-\d{4}\.[^.]+$/.test(name)) return { ok: true };
  return { why: '不合 `<YYYY-MM-DD>-<4位序号>.<ext>`（N13）' + (COMPACT_DATE_RE.test(name) ? COMPACT_HINT : '') };
}

/** 走一遍六个共用区，返回逐条判定（`student` 为 null = 库级、无学生归属）。 */
function sharedAreaChecks(root, students) {
  const sorted = students.slice().sort((a, b) => b.length - a.length);   // 长名优先，避免前缀歧义
  const out = [];
  const add = (area, p, r) => out.push({ area, path: p, name: path.basename(p), ok: !!r.ok, why: r.why || '', student: r.student || null });
  const kids = (d) => listEntries(d) || [];

  for (const e of kids(path.join(root, '_收件箱'))) add('_收件箱', path.join(root, '_收件箱', e.name), checkInboxName(e.name, sorted));
  for (const e of kids(path.join(root, '_盲解'))) add('_盲解', path.join(root, '_盲解', e.name), checkBlindName(e.name, sorted));
  for (const e of kids(path.join(root, '_录题'))) add('_录题', path.join(root, '_录题', e.name), checkTaskName(e.name));
  for (const e of kids(path.join(root, '_撤卡留档'))) add('_撤卡留档', path.join(root, '_撤卡留档', e.name), checkWithdrawName(e.name));
  for (const e of kids(path.join(root, '组卷'))) add('组卷', path.join(root, '组卷', e.name), checkPaperName(e.name, sorted));

  /* `_笔形\`：`<小名>\<标签>\<YYYY-MM-DD>-<4位序号>.<ext>`；`_笔形\*.md`（README/各人说明）放行；
     标签自由命名**不判**。放行的 `.md` 不进分母（"放行"= 不判，不是"合规样本"）。 */
  const pen = path.join(root, '_笔形');
  for (const e of kids(pen)) {
    const p = path.join(pen, e.name);
    if (!e.isDir && /\.md$/i.test(e.name)) continue;                       // 放行且不计入分母
    if (!e.isDir) { add('_笔形', p, { why: '`_笔形\\` 顶层只允许 `<小名>\\` 目录与 `*.md`（README/各人说明）（N13）' }); continue; }
    if (!sorted.includes(e.name)) { add('_笔形', p, { why: '小名「' + e.name + '」不在册（N13：`_笔形\\<小名>\\`）' }); continue; }
    for (const t of kids(p)) {
      const tp = path.join(p, t.name);
      if (!t.isDir) { add('_笔形', tp, { why: '`_笔形\\<小名>\\` 下只允许 `<标签>\\` 目录（N13）', student: e.name }); continue; }
      for (const s of kids(tp)) {
        add('_笔形', path.join(tp, s.name), Object.assign(checkSampleName(s.name), { student: e.name }));
      }
    }
  }
  return out;
}

/* §七 违规与处置的**机器可照做**形态（每条违规都带修法，仓库纪律：先根因再修法） */
const FIX = {
  G1: '改名到 student 字段值，并同步改写台账里以该目录为前缀的**路径字段**（只改路径，不改溯源叙述）；顺序不能反——门禁按字段判目录名（规范 §七）。',
  G2: '先改 `_索引.json` 的 `student`，再改目录名（顺序不能反）；年级/学科/日期是**会变的属性**，不进身份（P3）。',
  G3: '保留名与设备名一律换名：小名用化名即可（例如两三个汉字的化名），不得取 `组卷`、`_`/`.` 开头或 Windows 设备名。',
  G4: '有卡无册 ⇒ 把学科补进 `subjects`；有册无卡 ⇒ 从 `subjects` 摘掉该键（不得留空壳键）；学科名不在闭集内 ⇒ 改成闭集内的名字；`<小名>\\` 这一层多出来的条目（**含 `*.md` 报告件**）⇒ 报告件移到学科目录层，其余移走或按 §三 改规范登记（规范 §七 + §二 N11 末段）。',
  G5: '卡目录改名到 `<前缀><4位>-<描述>`：前缀按学科映射（数学 M / 语文 Y / 英语 E / 物理 P / 化学 C / 生物 B / 历史 H / 地理 G / 政治 Z），描述非空、≤ 40 字符、不含非法字符/换行、不以空格或 `.` 结尾；重号要改号并同步台账（序号只增不复用）；学科目录里的非卡条目 ⇒ 按 N11 归类（卡 ⇒ 按 N5 改；辅助目录/报告 ⇒ 登记；其余 ⇒ 移走）。',
  G6: '三选一：① 它是真源 ⇒ 在 `仓库文档 docs\\数据区规范.md` §三 登记 + 改门禁登记表；② 它是过程件 ⇒ 移 `%LOCALAPPDATA%\\拾光小册\\proc\\` 或删；③ 它是备份 ⇒ 移 `_备份-真源\\`（规范 §七）。',
  G7: '过程件一律落 `%LOCALAPPDATA%\\拾光小册\\proc\\`（`_过程目录.mjs`）；备份件只有两个合法去处：`_备份-真源\\`（库内，**任何层级**都行，N12）或库外。删掉库内这些残渣，或**搬**进 `_备份-真源\\`（搬而不是删，字节守恒对账才不被搅浑）；`tiles\\` / `_crops\\` 要移进卡目录 / 原卷目录（§3.4 ②③、W2/W3）。豁免只有**两处**：`_备份-真源\\`（任何层级）内部、`_原图\\_快照\\`（`_影像备份\\` 已随 P10 删除，"出现即红"）。',
  G8: '合并成学生级一份 `_索引.json`；合并前后**逐学科 items 条数必须相等**，并重跑四道卡门禁（规范 §七）。',
  G9: '移回库根（台账是跨学生的登记册，下沉就变成"每个学生一本"，跨学生查询立刻失效），并改引用它的工具（规范 §七）。',
  G11: '必答项 ⇒ 按对应的 G1/G4/G5/G8 修（改名到 `student`、合并多份索引、补/摘 `subjects` 键、卡目录按 N5 改）；共用区命名 ⇒ 按 N13 那张表重命名，**日期一律 `YYYY-MM-DD`**（唯一例外是 `_录题\\` 的 `t-YYYYMMDD-…` 任务号），`<小名>` 必须是在册学生目录名、且与 `<学科>` 之间必须有分隔符（P9：规则只有一套，对每个孩子逐字相同）。',
};

/* 能力边界（诚实写明 —— 同 `docs\路径规范.md` §四 的立文理由：边界不写出来，
   读者会把"没报红"读成"全覆盖"）。JSON 信封与人类输出共用这一份。 */
const BOUNDARIES = [
  '判据只认**名字形态与目录关系**，不读卡片内容（空位/答案/配图/盲解各有自己的门禁，一份事实只住一个家）。',
  'N2 的词表**字面集真源是规范 §二 N2 的表格**（年级词/学科词/时间词/日期形态/空白/分隔符/非法字符）；本文件只做转写，改词表要三件一起做（规范 + 代码 + 阴性对照）。',
  'N5 的「序号只增不复用」没有历史可查 ⇒ 机器只判**重号**，判不了"曾经用过又删掉"的复用。',
  'N5 描述里的「不含 Windows 非法字符」「不含换行」在 Win32 上造不出来（建含 `?` / `*` 的目录当场 EINVAL）⇒ 这两条子判据本机无阴性对照（判据保留：库从别处拷来 / 非 Windows 上仍会命中）。',
  'N5 描述里的「非空」「≤ 40 字符」「不以空格或 `.` 结尾」都能真造出来（`CreateDirectoryW` 保留尾点/尾空格）⇒ 阴性对照已覆盖。',
  'N10 允许 `<小名>\\原卷\\<批次>\\` 与 `<小名>\\<学科>\\原卷\\<批次>\\`；N11 允许学科目录里有 `原卷\\`、`待办证据\\`、`_待确认证据-<YYYYMMDD>\\`、`*.md` 报告件、`_`/`.` 开头的程序件；N12 允许 `_备份-真源\\` 出现在**任何层级**（`backupJson()` 写在被备份件旁边）⇒ 这些位置一律不判违规。',
  'N11 末段的 `<小名>\\` 层闭集**与之不对称**：只允许 `_索引.json`、N4 学科目录、`原卷\\`、`_`/`.` 开头的程序件 —— **`*.md` 报告件要判红**（报告件只在学科目录层；学生层是"身份+学科"的骨架）。',
  '`原卷\\` 内容的判据（page 必须住 `<小名>\\` 之下）在 `_原卷台账.mjs 门禁`，本工具不重算（G10 只给指针）。',
  'N8（通用文件名卫生：非法字符 / 结尾空格或 `.` / `.` `..`）没有独立的 G 行 —— 库根条目已被 G6 闭集覆盖，学生目录名与 student 字段已被 G2 的名集覆盖，故不另立判据。',
  'G7 的扫描面 = **库内任何位置**（§3.4 ②），豁免是穷举的**两处**：`_备份-真源\\`（任何层级）内部、`_原图\\_快照\\`；`.git\\` 按 N9 不算数据条目。`_影像备份\\` 曾是第三处豁免，**2026-11-06 随目录删除一并移除** —— 它现在属于"不许出现"。',
  '§3.4 ② 的残渣名字表是**穷举**的（`*.bak-*`/`*.bak`/`*.old`/`*.orig`/`*.tmp-*`/`_probe\\`/`_tmp*\\`/`_快照\\`）；`_快照\\` 唯一的合法位置是 `_原图\\_快照\\`，别处一律判红。要新增形态：改规范 + 改这里 + 加阴性对照。',
  '`fixtures\\` 下由 `make-fixture-lib.mjs` 造的合成库**故意**是畸形形态（规范 §六「作用域」）⇒ 不受本门禁约束，本门禁也不得接进 `tests\\run.mjs`。',
  'G11 的 A 段（必答项）是 **G1/G4/G5/G8 的聚合**，不重扫一遍（规范明写"重叠就复用"）；B 段（可选顶）**不判"有没有"** —— 本文件里没有任何"两个学生的树必须一样"的比较逻辑，那是刻意的（P9：内容差异 ≠ 规则差异）。',
  'G11 的 C 段按**每个学生分别**算合规率（各自必须 100%）：能归属的进该学生分母（含"小名与学科粘在一起"的 —— 它归**该学生**账上，不是无归属）；`_录题\\`/`_撤卡留档\\`（本来就没有学生归属）单列库级桶；小名根本不在册的条目**一律判红并单列**，绝不当"无法判定"跳过。',
  'P10「一个字节一个家」的两条判据**不在本文件**（§3.5）：`_原图.mjs 两个家`（原图恰好两个家：活路径 → 保全库）与 `_原图.mjs 单份`（非原图影像只能有一个家）。本文件只认**名字形态与目录关系**，不读影像字节（见第一条边界），所以那两条归影像工具。',
  'N13 的 `_笔形\\*.md`（README/各人说明）是**放行且不进分母**的；`_笔形\\` 的标签段自由命名**不判**。',
];

/* ══════════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════════ */
function listEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })); }
  catch { return null; }
}
const chars = (s) => [...String(s)].length;
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const relTo = (root, p) => path.relative(root, p) || '.';

/** 名字层判据（N2 名集 / N3 保留名）。调用方负责在 `why` 后注明"判的是目录名还是 student 字段"，
 *  因为同一个名字出现在两侧时修法不同（规范 §七：先改字段再改目录名）。 */
function nameProblems(name) {
  const out = [];
  const why = [];
  for (const re of GRADE_RE) if (re.test(name)) why.push('年级词（' + String(re).replace(/^\/|\/$/g, '') + '）');
  for (const w of SUBJECT_WORDS) if (name.includes(w)) why.push('学科词「' + w + '」');
  for (const re of TIME_RE) if (re.test(name)) why.push('时间限定词（' + String(re).replace(/^\/|\/$/g, '') + '）');
  if (DATE_RE.test(name)) why.push('日期形态（' + String(DATE_RE).replace(/^\/|\/$/g, '') + '）');
  if (/\s/.test(name)) why.push('空白符（半角/全角空格、制表符）');
  const sep = SEPARATORS.filter((s) => name.includes(s));
  if (sep.length) why.push('分隔符 ' + sep.join(' '));
  const ill = ILLEGAL_CHARS.filter((c) => name.includes(c));
  if (ill.length) why.push('Windows 非法字符 ' + ill.join(' '));
  if (chars(name) > NAME_MAX) why.push('长度 ' + chars(name) + ' > ' + NAME_MAX + ' 字符');
  if (why.length) out.push({ rule: 'G2', why: why.join('；') });

  if (RESERVED_NAMES.includes(name)) out.push({ rule: 'G3', why: '保留名「' + name + '」（§3.1 的产物目录名）' });
  else if (name.startsWith('_') || name.startsWith('.')) out.push({ rule: 'G3', why: '以 `_` / `.` 开头的名字是程序保留名（N7）' });
  else if (DEVICE_NAMES.test(name)) out.push({ rule: 'G3', why: 'Windows 设备名（N3）' });
  return out;
}

/** N5 描述判据：非空、≤ 40 字符、不含 Windows 非法字符、不含换行、不以空格或 `.` 结尾。 */
function descProblems(desc) {
  const bad = [];
  if (!desc.length) bad.push('描述为空');
  if (chars(desc) > DESC_MAX) bad.push('描述 ' + chars(desc) + ' 字符 > ' + DESC_MAX);
  const ill = ILLEGAL_CHARS.filter((c) => desc.includes(c));
  if (ill.length) bad.push('含 Windows 非法字符 ' + ill.join(' '));
  if (/[\r\n]/.test(desc)) bad.push('含换行');
  if (/[ .]$/.test(desc)) bad.push('以空格或 `.` 结尾');
  return bad;
}

/** 学生目录候选 = 库根顶层**无前缀**目录（§3.1：无前缀顶层只有 `<小名>\` 与 `组卷\` 两类）。 */
const isStudentDirName = (name) => !name.startsWith('_') && !name.startsWith('.');

/* ══════════════════════════════════════════════════════════════════════════
 * 主判据：对库根跑 G1..G9
 * ══════════════════════════════════════════════════════════════════════════ */
function audit(root) {
  const violations = [];
  const evaluated = Object.fromEntries(RULES.map((r) => [r.id, 0]));
  const put = (rule, target, why) => { violations.push({ rule, ruleText: (RULES.find((r) => r.id === rule) || {}).rule || '', path: target, why, fix: FIX[rule] || '' }); };

  const rootEnts = listEntries(root);
  if (rootEnts === null) throw new Error('库根读不出（不存在 / 不是目录 / 无权限）：' + root);
  const stats = { rootEntries: rootEnts.length, studentDirs: 0, subjectDirs: 0, cardDirs: 0, indexFiles: 0 };

  /* ── G7：残渣清扫（§3.4 ②：**库内任何位置**，不限顶层；豁免只有穷举的那两处）──
     先扫它：命中的条目就不再按 G4/G5/G6 重复判（残渣是更具体的那条规则，§3.4 已点名）。 */
  const residueHit = new Set();
  {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      if (residueExempt(root, dir)) continue;                          // 豁免区（含其下全部）不判、也不进
      for (const e of listEntries(dir) || []) {
        const p = path.join(dir, e.name);
        if (dir === root && N9_EXCEPTIONS.includes(e.name)) continue;   // N9：`.git\` / `.gitignore` 不进
        evaluated.G7++;
        const res = residueOf(e.name);
        if (res) {
          if (residueAllowedHere(root, p, e.name)) { if (e.isDir) stack.push(p); continue; }  // `_快照\` 在 `_原图\` 内的唯一合法位置
          residueHit.add(p);
          put('G7', p, res.why + '（位置：' + relTo(root, p) + '）');
          continue;
        }
        if (TILE_RE.test(e.name)) {
          if (!tileAllowedAt(root, dir)) {
            residueHit.add(p);
            put('G7', p, '`tiles\\` / `_crops\\` 只能出现在卡目录 / 原卷目录**内部**（§3.4 ③；它们是可重建的中间产物）；这里是 ' + relTo(root, p));
            continue;                                                  // 违规的中间产物目录不再往里走
          }
          if (e.isDir) stack.push(p);                                  // 合法位置：内容仍受 ② 约束，继续扫
          continue;
        }
        if (e.isDir) stack.push(p);
      }
    }
  }

  /* ── G6：库根顶层闭集（P4）── */
  const studentEnts = [];
  for (const e of rootEnts) {
    evaluated.G6++;
    const p = path.join(root, e.name);
    if (N9_EXCEPTIONS.includes(e.name)) continue;                       // N9 唯一例外
    if (residueHit.has(p)) continue;                                    // 已由 G7 点名
    if (REGISTERED_DIRS.includes(e.name)) {
      if (!e.isDir) put('G6', p, '登记为**目录**（§3.1/§3.2 枚举在册），实际是文件 —— 形态与登记不符');
      continue;
    }
    if (REGISTERED_FILES.includes(e.name)) {
      if (!e.isFile) put('G6', p, '登记为**文件**（§3.3 枚举在册），实际是目录 —— 形态与登记不符');
      continue;
    }
    if (!e.isDir) { put('G6', p, '库根顶层未登记的文件（P4：顶层是闭集，未登记者即违规；N8 文件名卫生同样要求它不在这里）'); continue; }
    if (!isStudentDirName(e.name)) {
      put('G6', p, '库根顶层未登记的目录（P4 闭集）—— `_` / `.` 前缀只留给 §3.2 枚举在册的程序保留区（N7）');
      continue;
    }
    studentEnts.push(e);                                                // 无前缀目录 = 学生库（§3.1）
  }
  stats.studentDirs = studentEnts.length;

  /* ── 每个学生：G1/G2/G3/G4/G5/G8/G9 ── */
  for (const sd of studentEnts) {
    const sDir = path.join(root, sd.name);
    evaluated.G1++; evaluated.G2++; evaluated.G3++; evaluated.G8++; evaluated.G9++; evaluated.G4++;

    /* G2/G3：目录名本身 */
    for (const p of nameProblems(sd.name)) put(p.rule, sDir, 'N' + p.rule.slice(1) + '：' + p.why + '（判的是**目录名**）');

    /* 索引：F1 要求"一个学生恰好一份"，缺一份同样判红（fail-closed：N1 无从判定） */
    const idx = path.join(sDir, '_索引.json');
    let j = null;
    if (!isFile(idx)) {
      put('G1', idx, '这里没有 `_索引.json` —— F1 要求一个学生恰好一份；缺了它 N1（目录名 = student 字段）无从判定，按红处理');
    } else {
      stats.indexFiles++;
      try { j = readJsonStrict(idx, { label: sd.name + '\\_索引.json' }); }
      catch (e) { put('G1', idx, '索引读不出 ⇒ N1 无从判定，按红处理：' + e.message); }
    }
    const student = j && typeof j.student === 'string' ? j.student : '';
    if (j) {
      if (!student) put('G1', idx, '真源缺 `student` 字段（P1：student 是身份的唯一真源，目录名只是它的投影）');
      else if (student !== sd.name) put('G1', sDir, '目录名「' + sd.name + '」≠ `_索引.json` 的 student 字段「' + student + '」（N1：必须逐字符相等）');
      if (student) for (const p of nameProblems(student)) put(p.rule, idx, p.why + '（判的是 **_索引.json 的 `student` 字段**）');
    }

    /* G4：学科目录 ↔ subjects 键；闭集；`<小名>\` 这一层是**与 N11 对称的闭集**
       （规范 §二 N11 末段）：只允许 `_索引.json` + N4 学科目录 + `原卷\` + `_`/`.` 开头的程序件。
       ⚠ **不放 `*.md` 报告件**（报告件只在学科目录层，N11④）：学生层是"身份 + 学科"的骨架，
         塞进随笔文件会让"这个学生有哪几科"不可枚举。 */
    const subjObj = j && j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects) ? j.subjects : null;
    if (j && !subjObj) put('G4', idx, '索引缺 `subjects` 对象（N4：学科目录必须恰好是 subjects 的键；没有键就无从对应）');
    const keys = subjObj ? Object.keys(subjObj) : [];
    for (const k of keys) if (!SUBJECTS.includes(k)) put('G4', idx, '`subjects` 的键「' + k + '」不在学科闭集 {' + SUBJECTS.join(' ') + '} 内（N4）');
    const subjectDirs = [];
    const LAYER_ALLOW = '`<小名>\\` 这一层只允许 `_索引.json`、N4 学科目录、`原卷\\` 与 `_`/`.` 开头的程序件（规范 §二 N11 末段；`*.md` 报告件只在学科目录层）';
    for (const c of listEntries(sDir) || []) {
      const cp = path.join(sDir, c.name);
      if (c.name === '_索引.json') continue;
      if (residueHit.has(cp)) continue;                                 // 已由 G7 点名
      if (REGISTERED_FILES.includes(c.name)) continue;                  // 库级台账下沉 = G9 的事，不在这里重复刷屏
      if (!isStudentDirName(c.name)) continue;                          // ④ `_`/`.` 开头（含 N12 的 `_备份-真源\`，任意层级）
      if (c.isDir && c.name === ORIG_DIR) continue;                     // ③ N10 形态 A：<小名>\原卷\<批次>\（判据在 _原卷台账.mjs）
      if (c.isDir && (SUBJECTS.includes(c.name) || keys.includes(c.name))) { subjectDirs.push(c.name); continue; }   // ② N4 学科目录
      put('G4', cp, (c.isDir ? '目录' : '文件') + '不属于 `<小名>\\` 这一层的闭集 —— ' + LAYER_ALLOW);
    }
    for (const dn of subjectDirs) {
      const dp = path.join(sDir, dn);
      if (!SUBJECTS.includes(dn)) put('G4', dp, '学科名「' + dn + '」不在闭集 {' + SUBJECTS.join(' ') + '} 内（N4）');
      else if (!keys.includes(dn)) put('G4', dp, '有卡无册：学科目录「' + dn + '」不在该学生 `subjects` 的键里（N4）');
    }
    for (const k of keys) {
      if (!subjectDirs.includes(k)) put('G4', idx, '有册无卡：`subjects` 有键「' + k + '」却没有对应学科目录（N4；不得留空壳键 —— 要么建目录，要么摘掉键）');
    }

    /* G8：多份 _索引.json（递归找；F1 禁止按学科拆成多份 = 两份并列真源） */
    const idxAll = [];
    (function walk(d) { for (const e of listEntries(d) || []) { const p = path.join(d, e.name); if (e.isDir) walk(p); else if (e.name === '_索引.json') idxAll.push(p); } })(sDir);
    if (idxAll.length > 1) {
      put('G8', sDir, '一个学生出现 ' + idxAll.length + ' 份 `_索引.json`：' + idxAll.map((p) => relTo(root, p)).join('、') + '（F1：拆分＝复习状态散在多处，跨学科统计要先合并）');
    }

    /* G9：库级台账下沉（§3.3 枚举在册的那些名字出现在学生树里） */
    (function walk(d) {
      for (const e of listEntries(d) || []) {
        const p = path.join(d, e.name);
        if (e.isDir) { walk(p); continue; }
        if (REGISTERED_FILES.includes(e.name)) put('G9', p, '库级台账「' + e.name + '」出现在学生目录里（N6：台账一律住库根，下沉就让跨学生查询失效）');
      }
    })(sDir);

    /* G5：学科目录内容 = N11 闭集 ①–⑤；卡目录形态判据**只对 `^[A-Z]\d{4}` 开头的目录名生效**
       （否则 `待办证据\`、`_待确认证据-20261015\`、`2026-10-07-…批改报告.md` 会被套上卡目录格式而假阳）。
       只在"闭集内且册上有名"的学科目录里判，避免对已判 G4 的目录重复刷屏。 */
    for (const dn of subjectDirs) {
      if (!SUBJECTS.includes(dn) || !keys.includes(dn)) continue;
      const dp = path.join(sDir, dn);
      stats.subjectDirs++;
      const seqs = new Map();
      for (const c of listEntries(dp) || []) {
        const cp = path.join(dp, c.name);
        if (residueHit.has(cp)) continue;                               // 已由 G7 点名
        if (REGISTERED_FILES.includes(c.name)) continue;                // 库级台账下沉 = G9 的事
        /* ── ① 卡目录（含"看起来是卡号"的错名字：前缀错/缺 `-描述` 都归 N5 判）── */
        const head = c.isDir ? CARD_HEAD_RE.exec(c.name) : null;
        if (head) {
          evaluated.G5++;
          const m = CARD_RE.exec(c.name);
          if (!m) { put('G5', cp, '卡目录名不合 `<前缀><4位>-<描述>`（N5：`' + c.name + '` 有卡号头但没有 `-<描述>`）'); continue; }
          stats.cardDirs++;
          const [, pre, seq, desc] = m;
          if (pre !== PREFIX[dn]) put('G5', cp, '卡号前缀「' + pre + '」与学科「' + dn + '」不符（N5 映射：' + dn + ' ⇒ ' + PREFIX[dn] + '）');
          const bad = descProblems(desc);
          if (bad.length) put('G5', cp, 'N5 描述不合规：' + bad.join('；'));
          const key = pre + seq;
          if (seqs.has(key)) put('G5', cp, '同学生同学科内重号：' + key + ' 已出现在「' + seqs.get(key) + '」（N5：序号只增不复用，复用会撞历史台账）');
          else seqs.set(key, c.name);
          continue;
        }
        /* ── ②–⑤ 非卡条目：必须落在 N11 闭集里 ── */
        evaluated.G5++;
        if (c.isDir && c.name === ORIG_DIR) continue;                   // ② 原卷\（N10；其内可含 _crops\/tiles\）
        if (c.isDir && (c.name === EVIDENCE_DIR || EVIDENCE_DATED_RE.test(c.name))) continue;   // ③ 待办证据\ / _待确认证据-<YYYYMMDD>\
        if (!c.isDir && REPORT_MD_RE.test(c.name)) continue;            // ④ *.md 报告件
        if (!isStudentDirName(c.name)) continue;                        // ⑤ `_`/`.` 开头（含 N12 的 `_备份-真源\`）
        put('G5', cp, (c.isDir ? '目录' : '文件') + '不在 N11 闭集内 —— 学科目录里只允许：卡目录 `<前缀><4位>-<描述>`、`原卷\\`、'
          + '`待办证据\\`/`_待确认证据-<YYYYMMDD>\\`、`*.md` 报告件、`_`/`.` 开头的程序件（N11；其余即违规）');
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * G11：跨学生同构（规范 §六 G11 + §二 N13 + §一 P9）
   *
   * A 段 必答项（少一个即红）= **G1/G4/G5/G8 的跨学生聚合**：规范明写"重叠就复用，别写两遍"，
   *      所以这里**不重扫一遍**，而是把已收集的违规按学生归堆 —— 任何学生缺任何一项必答项即红。
   * B 段 可选顶（`原卷\`/`待办证据\`/`*.md`/`_`·`.` 开头）：**不判"有没有"**，只由 A 段的闭集判据管"合不合规"。
   *      ⚠ 本函数里**没有**任何"两个学生的树必须长得一样"的比较（P9 的反面口径），这是刻意的：
   *        学生甲有物理、学生乙没有 = 内容差异，不是规则差异。
   * C 段 共用命名（N13）：**对每个学生分别算合规率、各自必须 100%**（整体合规率会被人多的一方掩盖）；
   *      无学生归属的库级共用区（`_录题\`、`_撤卡留档\` 批次式）另算一桶，同样必须 100%。
   * ══════════════════════════════════════════════════════════════════════════ */
  const g11 = { mandatory: [], perStudent: [], global: { total: 0, bad: 0 }, unattributed: [] };
  {
    /* ── A 段：必答项（聚合，不重复实现）── */
    const MAND = [
      { rules: ['G1', 'G8'], what: '目录名 = `student` 字段，且 `<小名>\\_索引.json` **恰好一份**、形态为 `subjects{}`' },
      { rules: ['G4'], what: '学生层条目 ∈ 闭集（N11 末段），且**学科目录集合 === `subjects` 键集合**' },
      { rules: ['G5'], what: '学科层条目 ∈ N11 闭集（卡目录形态 / 前缀 / 描述 / 重号）' },
    ];
    for (const sd of studentEnts) {
      evaluated.G11++;
      const sDir = path.join(root, sd.name);
      const failed = [];
      for (const it of MAND) {
        const hit = violations.filter((v) => it.rules.includes(v.rule) && (v.path === sDir || v.path.startsWith(sDir + path.sep)));
        if (!hit.length) continue;
        const rules = [...new Set(hit.map((v) => v.rule))].join('/');
        failed.push({ rules, what: it.what, n: hit.length });
        put('G11', sDir, '必答项不成立（P9 跨学生同构）：' + it.what + ' —— 见 ' + rules + ' 的 ' + hit.length + ' 条违规（本条是**聚合**，判据只有一份）');
      }
      g11.mandatory.push({ student: sd.name, ok: failed.length === 0, failed });
    }

    /* ── C 段：共用区命名（N13）── */
    const GLOBAL_AREAS = ['_录题', '_撤卡留档'];        // 这两处的条目**本来就没有**学生归属（任务号 / 批次）
    const shared = sharedAreaChecks(root, studentEnts.map((e) => e.name));
    for (const s of shared) {
      evaluated.G11++;
      if (!s.ok) put('G11', s.path, '共用区 `' + s.area + '\\` 命名不合 N13：' + s.why);
      if (s.student) continue;                          // 能归属到某个学生的，进它的分母
      if (GLOBAL_AREAS.includes(s.area)) {              // 库级共用区：另算一桶
        g11.global.total++;
        if (!s.ok) g11.global.bad++;
        continue;
      }
      /* 本该能归属（`_收件箱`/`_盲解`/`组卷`/`_笔形`）却没归属 ⇒ 名字本身就不合规（小名不在册 / 缺分隔符）。
         **不许当"无法判定"跳过**：它们已经判红，这里显式列出来免得被读成"没判"。 */
      g11.unattributed.push({ path: path.relative(root, s.path), why: s.why });
    }
    for (const e of studentEnts) {
      const mine = shared.filter((s) => s.student === e.name);
      const bad = mine.filter((s) => !s.ok).length;
      g11.perStudent.push({
        student: e.name,
        total: mine.length,
        bad,
        rate: mine.length ? Math.round(((mine.length - bad) / mine.length) * 100) + '%' : '—',
        ok: bad === 0,
      });
    }
    g11.global.rate = g11.global.total ? Math.round(((g11.global.total - g11.global.bad) / g11.global.total) * 100) + '%' : '—';
    /* 归属不明的条目**不是**"无法判定"：它们要么小名不在册、要么名字粘住了分隔符 —— 一律已判红，
       这里只是把它们显式列出来，免得被读成"没判"。按学生分别算合规率时它们不进任何学生的分母。 */
    g11.unattributed = g11.unattributed.slice(0, 20);
  }

  return { violations, evaluated, stats, g11 };
}

/* ══════════════════════════════════════════════════════════════════════════
 * CLI
 * ══════════════════════════════════════════════════════════════════════════ */
const argv = process.argv.slice(2);
/* 参数解析 = `_参数.mjs` 的唯一实现：已知带值 flag 无条件消费下一个参数（M1 事故口径），
   布尔开关进 boolFlags ⇒ 严格模式（拼错的 `--jsoon` 当场报错，而不是被静默吞掉）。
   ⚠ 本工具**没有动作名**，故 start = 0（不预留动作名槽）。 */
let parsed;
try {
  parsed = parseArgs(argv, {
    valueFlags: [...COMMON_VALUE_FLAGS],                 // 含 'data'（COMMON_VALUE_FLAGS 里的唯一实现）
    boolFlags: ['json', 'help', 'h'],
    start: 0,
  });
} catch (e) {
  console.error('[数据区门禁] 参数错：' + e.message);
  process.exit(3);
}
const { opt, positional } = parsed;
const JSON_OUT = !!opt.json;
const HELP = !!opt.help || !!opt.h;

function usage() {
  console.log([
    '拾光小册 · 数据区门禁（判决依据：仓库文档 docs\\数据区规范.md §六 G1..G9）',
    '',
    '用法：',
    '  node src\\tools\\_数据区门禁.mjs [--data <库根>] [--json] [--help]',
    '',
    '  --data <库根>  显式指定库；它**压过**继承来的 CTB_DATA（在任何 libraryRoot() 之前落进环境）。',
    '                 不给则按 `_库根.mjs`：CTB_DATA > <运行区>\\..\\数据 > …',
    '  --json         机器可读信封（规则表 + 逐条违规 + 已判数量）',
    '  --help / -h    本页',
    '',
    '退出码：0 = 全绿；2 = 有违规；3 = 入参/环境错。',
    '',
    '判据表（每条都能指回规范里的规则）：',
    ...RULES.map((r) => '  ' + r.id.padEnd(3) + ' [' + r.rule.padEnd(13) + '] ' + r.title),
    '  G10 [N10          ] 原卷落点（page 必须住 <小名>\\ 之下）→ **见 `_原卷台账.mjs 门禁`**，本工具不重复实现（P1）',
    '  G11 [P9+N13       ] 跨学生同构：必答项（聚合 G1/G4/G5/G8）+ 共用区命名按**每个学生分别** 100%；',
    '                         ⚠ G11 **不要求"两个学生的树长得一样"**：学科集合、有没有 `原卷\\`/`待办证据\\`/报告件',
    '                           本来就因人因科而异（内容差异 ≠ 规则差异，P9）。判红只能是"某处出现了闭集外的条目"。',
    '  P10 [P10+§3.5      ] 一个字节一个家 → **见 `_原图.mjs 两个家`**（原图恰好两个家）与 **`_原图.mjs 单份`**',
    '                         （非原图影像只能有一个家）；本工具只认名字形态，不读影像字节，故不重复实现（P1）。',
    '',
    '规范里与本门禁逐条对上的容许清单（改任一条 = 改规范 + 改本文件 + 改阴性对照，三件一起做）：',
    '  · N2  小名词表（年级/学段词 · 学科词 · 时间词 · 日期形态 · 空白 · 分隔符 · 非法字符）—— **字面集真源是规范 §二 N2 的表格**；',
    '  · N5  卡目录描述：非空、≤ 40 字符、不含非法字符/换行、不以空格或 `.` 结尾；',
    '  · N10 原卷落点：`<小名>\\原卷\\<批次>\\` 与 `<小名>\\<学科>\\原卷\\<批次>\\`；',
    '  · N11 学科目录闭集：卡目录 / `原卷\\` / `待办证据\\`·`_待确认证据-<YYYYMMDD>\\` / `*.md` / `_`·`.` 开头；',
    '  · N11 末段 `<小名>\\` 层闭集（与之对称）：`_索引.json` / N4 学科目录 / `原卷\\` / `_`·`.` 开头 —— **不放 `*.md`**；',
    '  · N12 `_备份-真源\\` **任何层级**都合法（备份写在被备份件旁边）；',
    '  · N13 共用区命名：`_收件箱\\<YYYY-MM-DD>-<小名>-<学科>[-<描述>]` · `_盲解\\<小名>-<学科>-盲解清稿[-第2路|-重盲解].md` ·',
    '          `_录题\\t-YYYYMMDD-HHmmss-<6位hex>.json`（**日期硬规矩的唯一例外**）· `_撤卡留档\\<YYYY-MM-DD>[-<描述>]` 或',
    '          `<卡号>-<描述>-<YYYY-MM-DD>-<原因>` · `组卷\\<YYYY-MM-DD>-<小名>-<重做卷|答案册>-<HHmm>.pdf` ·',
    '          `_笔形\\<小名>\\<标签>\\<YYYY-MM-DD>-<4位序号>.<ext>`（标签自由命名不判；`_笔形\\*.md` 放行）；',
    '          日期**一律 `YYYY-MM-DD`**（`YYYYMMDD` 判红），`<小名>` 必须是在册学生目录名且与 `<学科>` 之间有分隔符。',
    '  · §3.4 豁免（穷举）：`_备份-真源\\`（任何层级）内部、`_原图\\_快照\\`；`_影像备份\\` 已删除（出现即红）。',
    '',
    '作用域：管**用户的真库**与迁移验收；`fixtures\\` 的合成库是故意畸形形态，不受本门禁约束，',
    '       且本门禁**不得**接进 tests\\run.mjs（规范 §六「作用域」）。只读，不写任何文件。',
  ].join('\n'));
}
if (HELP) { usage(); process.exit(0); }
if (positional.length) {
  console.error('[数据区门禁] 本工具不接受位置参数，收到：' + positional.join(' '));
  console.error('判据与用法见 `node src\\tools\\_数据区门禁.mjs --help`');
  process.exit(3);
}

/* ★ `--data` 必须在**任何** libraryRoot() 调用之前落进 process.env.CTB_DATA。
   依据：`_原图寻址.mjs` 2026-11-03 的真实事故 —— 库根在导入期被 `_库根.mjs` 缓存，
   之后再设 CTB_DATA 不再生效 ⇒ `--data` 静默失效、工具去读了**另一个**库。
   本文件因此把"解析参数 → 落 CTB_DATA → 再取库根"排成固定顺序（静态 import 不触发 libraryRoot()）。 */
if (opt.data === true || opt.data === '') {
  console.error('[数据区门禁] --data 需要一个目录参数：--data <库根>');
  process.exit(3);
}
let root = '';
try {
  if (typeof opt.data === 'string' && opt.data.trim()) process.env.CTB_DATA = path.resolve(opt.data.trim());
  root = libraryRoot();
} catch (e) {
  console.error('[数据区门禁] 库根解析失败：' + e.message);
  process.exit(3);
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('[数据区门禁] 库根不是什么目录：' + root);
  process.exit(3);
}

let out;
try { out = audit(root); }
catch (e) {
  console.error('[数据区门禁] 巡检无法进行：' + e.message);
  process.exit(3);
}
const { violations, evaluated, stats, g11 } = out;

/* 空真纪律（同 `_体检.mjs` 的"空真检查"）：一道门禁"没发现违反"有两种原因 ——
   真检查了没问题，与**根本没有被检查的对象**。后者报"通过"是虚假的安心感，故显式说出来。 */
const vacuous = stats.rootEntries === 0 || (evaluated.G1 === 0 && violations.length === 0);

if (JSON_OUT) {
  const envelope = {
    ok: violations.length === 0,
    root,
    resolved: describeRoots(),
    rules: RULES.map((r) => ({ ...r, evaluated: evaluated[r.id], violations: violations.filter((v) => v.rule === r.id).length })),
    violations,
    stats,
    g11,
    vacuous,
    notImplementedHere: [{ id: 'G10', rule: 'N10', note: '原卷落点 → 见 `_原卷台账.mjs 门禁` 的"库外 page"检查（本工具不重复实现）' }],
    boundaries: BOUNDARIES,
  };
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  process.exit(violations.length ? 2 : 0);
}

console.log('数据区门禁（仓库文档 docs\\数据区规范.md §六 G1..G9 + G11 跨学生同构）');
console.log('  ' + describeRoots());
console.log('  库根 = ' + root);
console.log('  已判：库根顶层条目 ' + stats.rootEntries + ' ｜ 学生目录 ' + stats.studentDirs +
  ' ｜ 学科目录 ' + stats.subjectDirs + ' ｜ 卡目录 ' + stats.cardDirs + ' ｜ _索引.json ' + stats.indexFiles);
console.log('');
for (const r of RULES) {
  const mine = violations.filter((v) => v.rule === r.id);
  const head = '【' + r.id + '】' + r.title + '（规则 ' + r.rule + '）—— ' + (mine.length ? mine.length + ' 处违规' : '通过') +
    '　[已判 ' + evaluated[r.id] + ' 项]';
  console.log(head);
  for (const v of mine) {
    console.log('  ✖ ' + path.resolve(v.path));
    console.log('      违反：' + v.why);
    console.log('      修法：' + v.fix);
  }
}
console.log('');
console.log('【G10】原卷落点（规则 N10）—— 见 `_原卷台账.mjs 门禁` 的"库外 page"检查（本工具不重复实现，P1）');
console.log('');
/* G11 的**抗掩盖**证据：合规率必须**按学生分别**印出来（整体率会被人多的一方掩盖）。
   这一块不参与判红（判红在【G11】那一段），它只是把"每个学生各自多少"摆到人眼前。 */
console.log('【G11·共用区命名合规率】按**每个学生分别**算，各自必须 100%（不许用整体合规率：人多的一方会掩盖另一方的问题）');
if (!g11.perStudent.length) console.log('  · （没有学生目录 —— 无从算合规率）');
for (const s of g11.perStudent) {
  console.log('  · ' + s.student.padEnd(8) + (s.total - s.bad) + '/' + s.total + ' = ' + s.rate + (s.total ? '' : '（该学生在共用区没有条目）') + (s.ok ? '' : '  ✖'));
}
console.log('  · 库级（无学生归属：`_录题\\` / `_撤卡留档\\` 批次式）' + (g11.global.total - g11.global.bad) + '/' + g11.global.total + ' = ' + g11.global.rate);
console.log('  · 必答项（聚合 G1/G4/G5/G8）：' + g11.mandatory.filter((m) => m.ok).length + '/' + g11.mandatory.length + ' 个学生同构' +
  (g11.mandatory.some((m) => !m.ok) ? '　✖ ' + g11.mandatory.filter((m) => !m.ok).map((m) => m.student).join('、') : ''));
if (g11.unattributed.length) {
  console.log('  · ⚠ 归属不明的共用区条目 ' + g11.unattributed.length + ' 条（小名不在册 / 缺分隔符）—— **已判红**，不许当"无法判定"跳过：');
  for (const u of g11.unattributed.slice(0, 6)) console.log('      ' + u.path + '　← ' + u.why);
}
console.log('');
console.log('能力边界（诚实写明）：');
for (const b of BOUNDARIES) console.log('  · ' + b);
console.log('');
console.log('──────────────────────────────');
if (vacuous) {
  console.log('⚠ 空真警告：库根条目 ' + stats.rootEntries + ' 个、学生目录 ' + evaluated.G1 + ' 个 —— ' +
    '没有任何"被检查的对象"，此种"全绿"不代表健康（同 `_体检.mjs` 的空真纪律）。');
}
console.log(violations.length
  ? '✖ 违规 ' + violations.length + ' 处（' + RULES.map((r) => r.id + ' ' + violations.filter((v) => v.rule === r.id).length).filter((s) => !/ 0$/.test(s)).join('、') + '）'
  : '✔ 全绿：' + RULES.map((r) => r.id).join(' / ') + ' 均无违规');
process.exit(violations.length ? 2 : 0);
