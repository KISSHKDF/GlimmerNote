#!/usr/bin/env node
/* 拾光小册 · 经验草稿（2026-11-03，批次 3 · 贡献试点）
 *
 * 为什么要有它（施工方案 §6 批次 3 交付物① / 建议书 §7）：
 *   批次 2 让"一条方法"能装成经验包，但**方法从哪来**还没闭环：家长/用户手里有大量
 *   "我当时为什么这么纠正"的一手经验，而公开仓库不能收原始素材（孩子原图、真实哈希、
 *   家庭路径、聊天原文、手写批注、任务全文）。中间缺一道**可以先看、再决定分享**的闸。
 *   本工具就是那道闸：只读源，把**只有白名单字段**的东西搬进一份草稿，把私有形态当场扫红。
 *
 * 三条硬边界（违反即返工）：
 *   ① **白名单从零组装**：草稿对象从 `{}` 开始，只把白名单字段搬进去。源里任何不在白名单的
 *      字段**默认丢弃** —— 这不是"过滤黑名单"。（黑名单永远漏掉当时没想到的那一类；
 *      而"从零组装"的失败模式是"少搬了东西"，那是看得见的；黑名单的失败模式是"夹带出门"，
 *      那是看不见的。本仓最忌后者。）
 *   ② **只读 + 只写 --out**：不写用户库、不写经验包根、不建过程件；`预览` 一个字节都不写。
 *      扫出私有标记时 `导出` **拒绝写盘**（exit 1）—— 半份泄漏也是泄漏。
 *   ③ **不静默降级**：缺 `expected.json`、案例与卡不匹配、两种源同时给、形态不认、字段形状不对
 *      —— 一律给**具体原因** + 退出码 2；扫出私有标记给退出码 1 并**点名**是哪一条、在哪个字段。
 *
 * 契约真源：`docs\经验包规范.md` §十四「经验草稿与贡献导出」（本工具每个子命令/字段都在那里
 *   登记，代码只做组装与判读，不在两处各写一份）。接口由批次 3 接口契约 §1 冻结。
 *   ⚠ 复用 `_经验包.mjs` 的 `packsRoot/parseCardSel/loadCard`（**不另写一份**）：
 *     选卡串形状、包根解析顺序、坏包原因分类都只有那一个实现。
 *
 * ── CLI ──────────────────────────────────────────────────────────────
 *   node src\tools\_经验草稿.mjs 白名单 [--json]
 *   node src\tools\_经验草稿.mjs 预览 <源> [--json] [--at <ISO8601>]
 *   node src\tools\_经验草稿.mjs 导出 <源> --out <文件> [--form local|cloud] [--json] [--at <ISO8601>]
 *     （`--at` 把草稿的「生成时间」钉死，让"两次独立调用逐字相同"这条判据可复现；缺省＝现在）
 *
 *   <源>（互斥，必须给且**只给一种**）：
 *     --card <packId>/<cardId>@<version> [--case <caseId>]   已安装的经验包卡（可选带一个合成案例）
 *     --from-pending <Txxx>                                  <库根>\_待确认.json 里的一条「经验线索」
 *   通用：--packs <经验包根>（与 `_经验包.mjs` 同一条解析链）· --data <库根>（只给 --from-pending 用）
 *
 *   退出码：0 = 通过；1 = 扫出私有标记（**不写盘**）；2 = 参数或环境错。
 *
 * ── 库导出（供用例直接对拍；形状冻结）───────────────────────────────
 *   DRAFT_FIELDS / EXCLUDED / SCAN_RULES / CASE_HASH_PATHS
 *   assembleFromCard(sel, caseId, packsArg) → { ok, draft, declaredHashes, notes } | { ok:false, code:2, why }
 *   assembleFromPending(id)                 → 同上（库根按 `_库根.mjs` 的 CTB_DATA 口径惰性解析）
 *   renderLocal(draft) / renderCloud(draft, opts)
 *   scanText(text, exemptValues) / declaredCaseHashes(draft)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* ★ 复用批次 2 的只读引擎：包根解析顺序、选卡串形状、坏包原因分类**只有那一份实现**。 */
import { packsRoot, parseCardSel, loadCard } from './_经验包.mjs';
/* 读用户库的 JSON 一律走 readJsonStrict（形状异常**抛错**，绝不"当空库"）——本工具只读，
   但它读的是 `_待确认.json` 这种不可再生的人工留痕，读歪了比不读更坏。 */
import { readJsonStrict } from './_安全写.mjs';
import { libraryRoot, APP_ROOT } from './_库根.mjs';

/* ══════════════════ 白名单 / 显式排除 / 扫描判据（唯一真源）══════════════════
 * `白名单` 子命令直接读这三张表 —— 表改了，自证输出跟着改，不存在"文档说要排除、代码没排除"。
 * `from` 一栏是**该字段从源里的哪里搬来**（人读预览与自证都打印它）。 */
export const DRAFT_FIELDS = [
  { name: '方法正文', from: '卡的正文文件（原样文本）' },
  { name: '步骤', from: 'pack.json 的 cards[].steps（本卡覆盖了内置配方的哪些步骤）' },
  { name: '适用条件', from: '卡正文里「适用条件 / 什么时候用」小节' },
  { name: '反例', from: '合成案例 expected.json 的 controls[]' },
  { name: '预期行为', from: '合成案例 expected.json 的 expected（登记/不收的小问、区域角色与理由）' },
  { name: '合成案例', from: '案例目录的 input.svg + expected.json（原样文本，见 §十四 的哈希例外）' },
  { name: '配方id', from: 'pack.json 的 recipe.id（源里没声明 ⇒ 本条草稿不含该字段）' },
  { name: '配方版本', from: 'pack.json 的 recipe.version' },
  { name: '配方指纹', from: 'pack.json 的 recipe.fingerprint' },
  { name: '作者', from: 'pack.json 的 author' },
  { name: '许可', from: 'pack.json 的 license' },
  { name: '包id', from: '选卡串解析结果（= pack.json 的 id，二者已由 `_经验包.mjs 校验` 对账）' },
  { name: '卡id', from: '选卡串解析结果' },
  { name: '包版本', from: '选卡串解析结果' },
  { name: '生成时间', from: '本工具生成（本机时区 ISO 8601）' },
  { name: '工具版本', from: '程序目录的 版本.json（开发区回落到仓库 VERSION.json）' },
];
export const DRAFT_FIELD_NAMES = DRAFT_FIELDS.map((f) => f.name);

/* 显式排除：源里有这些也**一律不进草稿**。列出来的意义不是"实现"，而是**可核对的承诺**
 * （接口契约 §1.3 要求逐条列在自证与人读预览里）。 */
export const EXCLUDED = [
  '孩子原图（任何图片字节：jpg/jpeg/png/webp/gif/bmp… 一律不进草稿；合成案例只允许 input.svg 文本）',
  '真实哈希（库内对象的 sha256；本工具唯一具名例外见 CASE_HASH_PATHS）',
  '家庭路径（盘符路径、家目录、库内相对路径）',
  '聊天原文（字段名或正文形态）',
  '手写批注（字段名或正文形态）',
  '任务全文（t-YYYYMMDD-HHmmss-xxxxxx 形态的任务号）',
  '学生/家长标识（student / parent / 姓名 一类字段一律丢弃）',
];

/* 具名例外（**白名单**，不是黑名单）：这**两处路径**上的 64 位十六进制是「合成案例自己那张
 * input.svg 的 sha256」，它随同批交付的 input.svg 一起走、可由它复算，**不是库内对象哈希**。
 * 除此以外，草稿里任何位置（含案例文本）出现 64 位十六进制都判红 —— 这是本工具的立身判据。
 * ⚠ 这两条路径是**逐个点名**的：将来案例契约新增哈希字段，会在这里判红并点名，
 *   逼人回来显式决定"它算不算自证哈希"，而不是被某个通配规则静默放过。 */
export const CASE_HASH_PATHS = [
  { at: 'input.pageSha', what: 'input.pageSha（input.svg 的字节 sha256，可由同批交付的 input.svg 复算）' },
  { at: 'expected.regions[].pageSha', what: 'expected.regions[].pageSha（同上）' },
];

/* 隐私扫描判据（组装/渲染后逐条扫；命中即 exit 1 并点名字段）。
 * 为什么"盘符"那条要写 lookbehind：`http://` 里的 `p:/` 不是盘符（前面是字母），
 * 写成裸 `[A-Za-z]:[\\/]` 会把每一段带 URL 的正文都判红 —— 恒红的判据等于没有判据。 */
export const SCAN_RULES = [
  {
    id: '盘符/家目录',
    re: /(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/]|Users[\\/])/,
    why: '绝对路径一律不许外发（它会暴露本机目录结构）',
  },
  {
    id: '库内路径',
    re: /_(?:收件箱|原图|录题|备份-真源|待确认)/,
    why: '库内目录名指回用户库的布局（哪怕是相对路径，也把库结构带出去了）',
  },
  {
    id: '任务号',
    re: /(?<![0-9a-zA-Z])t-\d{8}-\d{6}-[0-9a-f]{6}(?![0-9a-zA-Z])/,
    why: '任务号能反查到一次具体的录题任务（哪张图、哪次配方）',
  },
  {
    id: '64 位十六进制',
    re: /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/,
    why: 'sha256 形态 —— 白名单字段里一个都不许有（唯一具名例外见 CASE_HASH_PATHS）',
  },
];
/* 第六类：**源记录的字段名**出现手写批注/聊天原文形态即红。
 * 为什么查字段名而不是查内容：这类内容进了草稿也认不出来（它是任意中文），
 * 但"源记录里存在这样一个字段"是确定的信号 —— 说明这份源带着不该外发的一类数据，
 * 应当先把它清出去，而不是指望扫描器猜。 */
export const SOURCE_KEY_RED = /(handwriting|chat|微信|批注|手写|聊天|scribble)/i;

/* 孩子化名（**拼接构造**）：`tests\repo-hygiene.cjs` 把这两个词列为 tracked 文件禁词，
 * 那个检查器自己零字面量；本工具要**检测并替换**它们，同样不许在源码里落字面量
 * （照 `_路径护栏.mjs` 里 SEG 的写法）。导出时替换为「孩子A」/「孩子B」并报处数。 */
export const PSEUDO = [
  { from: '康' + '康', to: '孩子A' },
  { from: '乐' + '乐', to: '孩子B' },
];

/* 形态：两种都是"给人看的同一份草稿"，差别在**给谁看**（接口契约 §1.4）。 */
export const FORM_LOCAL = 'local';
export const FORM_CLOUD = 'cloud';
export const FORM_NOTE = {
  local: 'local（默认，JSON）：保留字段名与案例相对结构，适合**本地留档 / 日后自己再加工**',
  cloud: 'cloud（纯 Markdown）：零本机路径、零哈希、零任务号，适合**贴给云端 AI 或公开提交**',
};

/* ══════════════════ 小工具 ══════════════════ */
/* 生成时间：默认「现在」，--at 给了就用它（人为可复现 —— 见 CLI 段 --at 的说明）。 */
function draftTime() { return (typeof currentAt === 'string' && currentAt) ? currentAt : nowLocal(); }
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** 本机时区 ISO 8601（与 `_录题任务.mjs` 同一口径：带偏移量，便于人读） */
function nowLocal() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sg = off >= 0 ? '+' : '-';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sg + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
}

/** 工具版本：程序目录的 `版本.json`（发布包由 build-release.ps1 生成）
 *  → 回落 `<程序目录>\..\VERSION.json`（开发区：程序目录 = <仓库>\src）。
 *  两处都没有 ⇒ 响亮地说出来（打印 ⚠、字段写「未知」），**不静默编一个版本号**。 */
export function toolVersion() {
  const cands = [
    path.join(APP_ROOT, '版本.json'),
    path.join(APP_ROOT, '..', 'VERSION.json'),
    path.join(APP_ROOT, 'VERSION.json'),
  ];
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      if (j && j.version) return { version: String(j.version), from: p };
    } catch { /* 试下一个候选；全都读不到在下面统一报 */ }
  }
  return { version: '', from: '', tried: cands };
}

/** 读文本文件，并**校验它是有效 UTF-8**。
 *  为什么必须校验：`合成案例` 要的是"原样字节"，而 JSON/Markdown 只能承载文本；
 *  非法 UTF-8 用 `toString('utf8')` 读会变成一串 U+FFFD（**看起来像正常读到了**），
 *  于是"原样字节"这句承诺当场变成假的 —— 本仓最忌这种静默降级。 */
function readTextStrictUtf8(abs, what) {
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, why: what + ' 读不出来：' + abs + '（' + e.message + '）' }; }
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    return { ok: false, why: what + ' 不是有效 UTF-8（' + abs + '，' + buf.length + ' 字节）—— "原样字节"无法用文本承载，拒绝导出' };
  }
  return { ok: true, text, bytes: buf.length };
}

/** 把对象里的字符串叶子**就地**跑一遍替换函数，返回替换处数。
 *  为什么递归：白名单字段既有字符串（方法正文）也有嵌套结构（合成案例/预期行为/反例），
 *  按字段名逐个处理会漏掉将来新增的嵌套字段 —— 漏一个就是一条静默的出网通道。 */
function mapLeaves(node, fn) {
  let n = 0;
  const walk = (v) => {
    if (typeof v === 'string') { const r = fn(v); n += (r.n || 0); return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  const replaced = walk(node);
  /* 顶层对象需要就地改写（调用方拿的是同一个引用）；walk 返回新对象，故逐键回填。 */
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    for (const k of Object.keys(replaced)) node[k] = replaced[k];
  }
  return n;
}

/** 收集所有字符串叶子：`[{ field: '合成案例/input.svg/文本', text }]`（field 用斜杠拼路径）。 */
export function leavesOf(node, prefix = '') {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === 'string') { out.push({ field: p, text: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']')); return; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], p ? p + '/' + k : k); }
  };
  walk(node, prefix);
  return out;
}

/** 命中片段：只给**定位用的上下文**（±40 字符，换行压成空格）。
 *  为什么不做"高亮完整命中串"：预览是给人决定"要不要外发"的屏，把夹带内容整段打上去
 *  ＝换一个地方外泄（终端、日志、贴图）。 */
function snippet(text, index, len) {
  const a = Math.max(0, index - 40), b = Math.min(text.length, index + len + 40);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\r?\n/g, ' ') + (b < text.length ? '…' : '');
}

/** 一个"值 → 剩余可用次数"的袋子（豁免按**处数**消费，不是"这个值出现过就全放过"）。 */
function bagOf(values) {
  const m = new Map();
  for (const v of values || []) { const k = String(v).toLowerCase(); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

/** 扫一段文本。`exemptValues` 是本次允许的**具名例外**值（多重集）。
 *  返回 `{ hits:[{rule, snippet}], exemptions }`。 */
export function scanText(text, exemptValues = []) {
  const bag = bagOf(exemptValues);
  const hits = [];
  let exemptions = 0;
  for (const r of SCAN_RULES) {
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const tok = m[0];
      if (r.id === '64 位十六进制') {
        const k = tok.toLowerCase();
        const left = bag.get(k) || 0;
        if (left > 0) { bag.set(k, left - 1); exemptions++; continue; }
      }
      hits.push({ rule: r.id, snippet: snippet(text, m.index, tok.length) });
      if (m.index === re.lastIndex) re.lastIndex++;      // 零宽命中保护（别把自己转死）
    }
  }
  return { hits, exemptions };
}

/* ══════════════════ 组装（从零组装）══════════════════
 * 纪律：**草稿对象从 `{}` 开始**，只把下面这些"搬"语句里的字段放进去。
 * 新加字段 = 先改 `DRAFT_FIELDS`，再在这里加一条搬运 —— 顺序反了就会出现
 * "文档没登记却导出了"的字段（本仓"一份事实一个家"）。 */
const 搬 = (draft, name, value) => {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && !value.trim()) return;
  if (Array.isArray(value) && !value.length) return;
  if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return;
  draft[name] = value;
};

/** 卡正文里的「适用条件 / 什么时候用」小节（标题匹配，取到下一个同级或更高级标题为止）。
 *  为什么要抽小节而不是"整篇正文都算适用条件"：整篇正文是**方法正文**（另一个白名单字段），
 *  两者混在一起就等于把"什么时候用"这件事丢给读草稿的人自己从正文里找。
 *  抽不到 ⇒ **不搬**（并在预览里说明"源里没有这一节"），绝不编。 */
export function mdSection(body, keys = ['适用条件', '什么时候用', '何时用', '适用场景']) {
  const lines = String(body || '').split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(l);
    if (m) heads.push({ i, level: m[1].length, text: m[2] });
  });
  for (const h of heads) {
    if (!keys.some((k) => h.text.includes(k))) continue;
    const next = heads.find((x) => x.i > h.i && x.level <= h.level);
    const seg = lines.slice(h.i + 1, next ? next.i : lines.length).join('\n').trim();
    if (seg) return { title: h.text, text: seg };
  }
  return null;
}

/** 递归收集对象的**字段名**（第六类判据：手写批注/聊天原文形态的字段名出现即红）。 */
function redKeysOf(node, prefix = '') {
  const out = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']')); return; }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const at = p ? p + '.' + k : k;
        if (SOURCE_KEY_RED.test(k)) out.push(at);
        walk(v[k], at);
      }
    }
  };
  walk(node, prefix);
  return out;
}

/** 合成案例：读 input.svg + expected.json 的**原样文本**，并校验"案例与卡匹配"。 */
function buildCase(cardDir, card, caseId) {
  const raw = String(caseId == null ? '' : caseId).trim();
  if (!raw) return { ok: false, why: '--case 需要一个案例 id（例 --case shared-stem），收到空值' };
  if (/[\\/]/.test(raw)) {
    return { ok: false, why: '--case 要的是**案例 id**（一段，例 shared-stem），不是路径：' + JSON.stringify(raw) };
  }
  const declared = (card.cases || []).filter((rel) => String(rel).split('/').pop() === raw);
  if (!declared.length) {
    /* 磁盘上"存在但没在卡的 cases 里声明"的目录要**单独点名**（接口契约 §1.5 的验收点：
       案例目录不在卡的 cases 里 ⇒ exit 2，而且要说清是"没声明"还是"根本没有"）。 */
    let onDisk = [];
    try {
      const casesDir = path.join(cardDir, 'cases');
      onDisk = fs.readdirSync(casesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch { /* 没有 cases 目录：下面按"根本没有"报 */ }
    const undeclared = onDisk.filter((n) => !(card.cases || []).some((rel) => String(rel).split('/').pop() === n));
    return {
      ok: false,
      why: '案例与卡不匹配：卡 ' + JSON.stringify(card.cardId) + ' 的 cases 里没有案例 ' + JSON.stringify(raw) +
        '（卡声明了：' + ((card.cases || []).join('、') || '（无）') + '）' +
        (undeclared.length ? '\n  磁盘上存在但**没在本卡的 cases 里声明**的案例目录：' + undeclared.join('、') +
          '\n  —— 未声明的案例不会被 `_经验包.mjs 校验` 检查，也就没有"input.svg + expected.json 齐备"的保证；先把它写进 pack.json 的 cards[].cases' : ''),
    };
  }
  if (declared.length > 1) {
    return { ok: false, why: '案例 id 有歧义：' + JSON.stringify(raw) + ' 同时匹配 ' + declared.join('、') + '，请改名或直接指出是哪一个' };
  }
  const rel = declared[0];
  const abs = path.join(cardDir, ...rel.split('/'));
  const expAbs = path.join(abs, 'expected.json');
  const svgAbs = path.join(abs, 'input.svg');
  if (!fs.existsSync(expAbs)) {
    return { ok: false, why: '案例缺 expected.json：' + expAbs + '（案例目录 ' + rel + ' 下必须有 input.svg + expected.json 两个文件）' };
  }
  const svg = readTextStrictUtf8(svgAbs, '案例 input.svg');
  if (!svg.ok) return { ok: false, why: svg.why };
  const exp = readTextStrictUtf8(expAbs, '案例 expected.json');
  if (!exp.ok) return { ok: false, why: exp.why };
  let doc;
  try { doc = JSON.parse(exp.text); } catch (e) {
    return { ok: false, why: '案例 expected.json 不是合法 JSON：' + rel + '/expected.json（' + e.message + '）' };
  }
  if (doc && doc.caseId !== undefined && String(doc.caseId) !== raw) {
    return {
      ok: false,
      why: '案例 id 对不上：expected.json 里写的是 ' + JSON.stringify(doc.caseId) + '，你点名的是 ' + JSON.stringify(raw) +
        '（案例目录 ' + rel + '）—— 两者必须一致，否则"导出的案例是哪一份"没有判据',
    };
  }
  const node = {
    '案例id': raw,
    '目录': rel.split(path.sep).join('/'),
    'input.svg': { '字节数': svg.bytes, '文本': svg.text },
    'expected.json': { '字节数': exp.bytes, '文本': exp.text },
  };
  const declaredHashes = declaredCaseHashes({ '合成案例': node });
  return { ok: true, node, doc, declaredHashes, keyHits: redKeysOf(doc, 'expected.json') };
}

/** 从**已组装**的草稿里取出「契约声明的原页哈希」值（CASE_HASH_PATHS 逐个点名，不猜）。
 *  返回 `[{ value, where }]`；值必须是 64 位十六进制才登记（否则它本来就会被扫描判红）。 */
export function declaredCaseHashes(draft) {
  const c = draft && draft['合成案例'];
  if (!c || !c['expected.json'] || typeof c['expected.json']['文本'] !== 'string') return [];
  let doc;
  try { doc = JSON.parse(c['expected.json']['文本']); } catch { return []; }
  const out = [];
  const push = (v, where) => { if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) out.push({ value: v, where }); };
  if (doc && doc.input && typeof doc.input === 'object') push(doc.input.pageSha, 'input.pageSha');
  const regs = doc && doc.expected && Array.isArray(doc.expected.regions) ? doc.expected.regions : [];
  regs.forEach((r, i) => push(r && r.pageSha, 'expected.regions[' + i + '].pageSha'));
  return out;
}

/** 组装一份经验包卡草稿。返回 `{ok, draft, declaredHashes, notes}` 或 `{ok:false, code:2, why}`。 */
export function assembleFromCard(sel, caseId, packsArg) {
  const notes = [];
  const p = parseCardSel(sel);
  if (!p.ok) return { ok: false, code: 2, why: '选卡串不合法：' + p.why };
  const loaded = loadCard(sel, packsArg);
  if (!loaded.ok) {
    return { ok: false, code: 2, why: '选卡失败（' + loaded.reason + '）：' + loaded.why };
  }
  const c = loaded.card;
  let pack = {};
  try { pack = JSON.parse(fs.readFileSync(path.join(c.dir, 'pack.json'), 'utf8').replace(/^\uFEFF/, '')) || {}; }
  catch (e) { return { ok: false, code: 2, why: 'pack.json 读不出来（校验刚通过、这里又读不出，说明文件在两次读之间被改动过）：' + e.message }; }
  const cardDoc = (Array.isArray(pack.cards) ? pack.cards : []).find((x) => x && String(x.id) === c.cardId) || {};

  const draft = {};
  /* ── 逐条"搬"（从零组装的全部内容就是这十几行；没有搬运语句 = 字段不在草稿里）── */
  搬(draft, '方法正文', c.body);
  if (Array.isArray(c.steps) && c.steps.length) 搬(draft, '步骤', c.steps.slice());
  else notes.push('步骤：源里没有声明（pack.json 的 cards[].steps 为空）⇒ 草稿不含该字段');
  const use = mdSection(c.body);
  if (use) 搬(draft, '适用条件', use.text);
  else notes.push('适用条件：卡正文里没有「适用条件 / 什么时候用」小节 ⇒ 草稿不含该字段');
  if (pack.recipe && typeof pack.recipe === 'object') {
    搬(draft, '配方id', pack.recipe.id);
    搬(draft, '配方版本', pack.recipe.version);
    搬(draft, '配方指纹', pack.recipe.fingerprint);
  } else {
    notes.push('配方id/配方版本/配方指纹：pack.json 没有声明 recipe ⇒ 草稿不含这三个字段');
  }
  搬(draft, '作者', pack.author);
  搬(draft, '许可', pack.license);
  搬(draft, '包id', c.packId);
  搬(draft, '卡id', c.cardId);
  搬(draft, '包版本', c.version);

  let declaredHashes = [];
  const keyHits = redKeysOf(pack, 'pack.json');
  const cid = caseId === undefined || caseId === '' ? '' : String(caseId);
  if (!cid) {
    notes.push('合成案例：没给 --case ⇒ 草稿不含 合成案例 / 反例 / 预期行为（这三个字段都只有案例能提供）');
  } else {
    const b = buildCase(c.dir, { cardId: c.cardId, cases: c.cases }, cid);
    if (!b.ok) return { ok: false, code: 2, why: b.why };
    搬(draft, '合成案例', b.node);
    搬(draft, '反例', (Array.isArray(b.doc.controls) ? b.doc.controls : []).map((x) => ({
      id: x && x.id, 场景: x && x.scene, 期望: x && x.expect,
    })));
    const ex = (b.doc && b.doc.expected && typeof b.doc.expected === 'object') ? b.doc.expected : {};
    const 预期 = {
      '登记小问': Array.isArray(ex.registerQuestions) ? ex.registerQuestions.slice() : [],
      '不收的小问': Array.isArray(ex.skipQuestions) ? ex.skipQuestions.slice() : [],
      '区域角色': (Array.isArray(ex.regions) ? ex.regions : []).map((r) => r && r.role).filter(Boolean),
    };
    /* 区域理由（给人读的那几句）单独搬：**只搬文本**，不搬 regions[] 的坐标与哈希
       （坐标属于 合成案例 的原样字节；哈希进任何白名单字段都会判红）。 */
    if (ex.regionReason && typeof ex.regionReason === 'object' && Object.keys(ex.regionReason).length) {
      预期['区域理由'] = ex.regionReason;
    }
    搬(draft, '预期行为', 预期);
    declaredHashes = b.declaredHashes;
    keyHits.push(...b.keyHits);
    if (!declaredHashes.length) notes.push('合成案例：expected.json 里没有契约声明的原页哈希（input.pageSha / expected.regions[].pageSha）—— 本次没有可豁免的哈希');
  }
  搬(draft, '生成时间', draftTime());
  const tv = toolVersion();
  if (tv.version) 搬(draft, '工具版本', tv.version);
  else { 搬(draft, '工具版本', '未知'); notes.push('工具版本：在 ' + (tv.tried || []).join(' 、 ') + ' 都没读到版本号 ⇒ 字段写「未知」'); }

  return { ok: true, draft, declaredHashes, keyHits, notes, sel: { kind: 'card', sel, caseId: cid || null } };
}

/** 组装一份「经验线索」待办草稿（<库根>\_待确认.json 里的一条）。
 *  映射（口径真源 = docs §十四；批次 3 由 Lead 2026-11-03 冻死）：
 *    方法正文 ← `detail`（家长原话所在字段）；最后一条 corrections[].why 的原话以
 *              「纠正理由（原话）：…」同段保留（白名单里没有"纠正理由"这个字段）
 *    适用条件 ← **最后一条** corrections[].scope（它还有 target 就附一行）; 没有 corrections ⇒ qRef
 *    包id/卡id/包版本 ← 最后一条（其次其它条）corrections[].target 里第一个合法选卡串
 *  学生/家长标识（student 一类）**一个字段都不搬** —— 它在显式排除清单里。
 *  ⚠ `_待确认.mjs` 自己**不支持 `--data`**（只认 CTB_DATA）；本工具不调它，直接读
 *    `<库根>\_待确认.json`，库根按 `--data` → `CTB_DATA` → `_库根.mjs` 解析。 */
export function assembleFromPending(id, libRoot) {
  const notes = [];
  const raw = String(id == null ? '' : id).trim();
  if (!/^T\d{3,}$/.test(raw)) {
    if (!raw) return { ok: false, code: 2, why: '--from-pending 需要一个待办编号（形如 T003）' };
    return { ok: false, code: 2, why: '--from-pending 的编号形状不对：' + JSON.stringify(raw) + '（期望 T 开头 + 数字，例 T003）' };
  }
  let root = libRoot;
  if (!root) {
    try { root = libraryRoot(); }
    catch (e) { return { ok: false, code: 2, why: '解析不到用户库根（--from-pending 要读 <库根>\\_待确认.json）：' + e.message }; }
  }
  const db = path.join(root, '_待确认.json');
  if (!fs.existsSync(db)) {
    return { ok: false, code: 2, why: '用户库里没有 _待确认.json：' + db + '（库根=' + root + '；加一条经验线索：node src\\tools\\_待确认.mjs 加 --kind 经验线索 …）' };
  }
  let doc;
  try { doc = readJsonStrict(db, { shape: (j) => j && Array.isArray(j.items), what: 'items 数组', label: '_待确认.json' }); }
  catch (e) { return { ok: false, code: 2, why: e.message }; }
  const all = doc.items.filter((x) => x && x.id === raw);
  if (!all.length) {
    return { ok: false, code: 2, why: '台账里没有 ' + raw + '（库根=' + root + '；跑 `node src\\tools\\_待确认.mjs 状态` 看有哪些条目）' };
  }
  /* 重号：优先「未确认」那条，其次 raisedAt 较晚的那条 —— 与 `_待确认.mjs` 的 findById 同口径。
     ⚠ 那是 T2 的模块内部函数（未导出），这里按同口径复刻了两行；口径若要改，两处一起改。 */
  const live = all.filter((x) => x.status === '未确认');
  const pick = (live.length ? live : all).slice().sort((a, b) => String(b.raisedAt || '').localeCompare(String(a.raisedAt || '')))[0];
  if (all.length > 1) notes.push('台账里 ' + raw + ' 有 ' + all.length + ' 条（重号）：本次取『' + (pick.status || '?') + '』那条（' + (pick.raisedAt || '无日期') + '）');

  const declKind = '经验线索';
  if (String(pick.kind || '') !== declKind) {
    return {
      ok: false, code: 2,
      why: raw + ' 的类型是 ' + JSON.stringify(pick.kind || '(空)') + '，不是「' + declKind + '」——只有经验线索能整理成公开草稿' +
        '\n  家长对孩子/AI 的纠正理由归到这一类：node src\\tools\\_待确认.mjs 加 --kind ' + declKind + ' --detail "<原话>"',
    };
  }

  const corr = (Array.isArray(pick.corrections) ? pick.corrections : [])
    .filter((x) => x && typeof x === 'object')
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const last = corr.length ? corr[corr.length - 1] : null;
  const detail = String(pick.detail || '').trim();
  const why = String(last && last.why || '').trim();
  /* 方法正文 = `detail`（家长原话所在字段；批次 3 口径，Lead 2026-11-03 指定）。
   * `detail` 为空才退到 corrections 的 why。最后一条 correction 的 why 是"**为什么**这么纠正"的
   * 原话，**不许丢**；但白名单里没有"纠正理由"这个字段（接口契约 §1.2 冻结 16 个），
   * 所以它随 方法正文 同段保留、并用一行标签标出来 —— 免得读者把它当成方法正文的一部分。 */
  let body = detail;
  if (!body) {
    body = corr.map((x) => String(x.why || '').trim()).filter(Boolean).join('\n\n');
    if (!body) {
      return {
        ok: false, code: 2,
        why: raw + ' 既没有 detail（家长原话）也没有 corrections[].why —— 没有可导出的原话' +
          '（先把它记下来：node src\\tools\\_待确认.mjs 纠因 --id ' + raw + ' --why "<原话>"）',
      };
    }
    notes.push('方法正文：这条线索没有 detail ⇒ 用 corrections[].why 兜底（家长原话仍在，但字段来源不同）');
  } else if (why && !body.includes(why)) {
    body = body + '\n\n纠正理由（原话）：' + why;
  }

  const draft = {};
  搬(draft, '方法正文', body);
  /* 适用条件/范围 = **最后一条** correction 的 scope（批次 3 口径）；它还有 target 就一并写出来，
     没有 corrections 才退到 qRef（这条针对哪一题）。 */
  const scope = String(last && last.scope || '').trim();
  const lastTarget = String(last && last.target || '').trim();
  const applies = scope
    ? '范围：' + scope + (lastTarget ? '\n适用对象：' + lastTarget : '')
    : (lastTarget ? '适用对象：' + lastTarget : '');
  搬(draft, '适用条件', applies || String(pick.qRef || '').trim());
  if (!applies && !String(pick.qRef || '').trim()) notes.push('适用条件：这条线索既没有 corrections[].scope/target 也没有 qRef ⇒ 草稿不含该字段');

  /* target 里若有一个合法选卡串，就把包id/卡id/包版本搬出来（形状判据复用引擎的 parseCardSel）。
     优先取**最后一条** correction 的 target（与"适用条件"取同一条，口径才一致），再退到其它条。 */
  const targetCands = [lastTarget].concat(corr.map((x) => String(x.target || '').trim()).reverse())
    .filter((t, i, a) => t && a.indexOf(t) === i);
  const target = targetCands.find((t) => parseCardSel(t).ok);
  if (target) {
    const cp = parseCardSel(target);
    搬(draft, '包id', cp.packId);
    搬(draft, '卡id', cp.cardId);
    搬(draft, '包版本', cp.version);
  } else {
    notes.push('包id/卡id/包版本：这条线索的 corrections[].target 里没有形如 <包>/<卡>@<版本> 的选卡串 ⇒ 草稿不含这三个字段');
  }
  搬(draft, '生成时间', draftTime());
  const tv = toolVersion();
  if (tv.version) 搬(draft, '工具版本', tv.version);
  else { 搬(draft, '工具版本', '未知'); notes.push('工具版本：在 ' + (tv.tried || []).join(' 、 ') + ' 都没读到版本号 ⇒ 字段写「未知」'); }

  return {
    ok: true, draft, declaredHashes: [], keyHits: redKeysOf(pick, '待办 ' + raw), notes,
    sel: { kind: 'pending', id: raw, kind_text: String(pick.kind || ''), libRoot: root },
  };
}

/* ══════════════════ 渲染（两种形态）══════════════════ */
export function renderLocal(draft) {
  return JSON.stringify(draft, null, 2) + '\n';
}

/** cloud：**纯 Markdown**，零本机路径、零哈希、零任务号。
 *  与 local 的差别写在文首（接口契约 §1.4 要求"打印一行区别说明"）。 */
export function renderCloud(draft, opts = {}) {
  const L = [];
  L.push('# 经验草稿（云外发形态）');
  L.push('');
  L.push('> 这份是要贴给**云端 AI** 或**公开提交**的版本：纯 Markdown，零本机路径、零哈希、零任务号。');
  L.push('> 要本地留档 / 日后自己再加工，请用 `--form local`（JSON，保留字段名与案例相对结构）。');
  if (opts.maskedHashes) {
    L.push('> 本版已把合成案例里 ' + opts.maskedHashes + ' 处**契约声明的原页哈希**替换为说明文字（它就是同批交付的 input.svg 的字节 sha256，可复算）。');
  }
  L.push('');
  for (const f of DRAFT_FIELDS) {
    if (!(f.name in draft)) continue;
    L.push('## ' + f.name);
    L.push('');
    L.push(renderFieldCloud(draft[f.name]));
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('本文件由「拾光小册」经验草稿工具按**白名单从零组装**生成：源记录里不在白名单的字段一个都没有进来。');
  return L.join('\n').replace(/\n+$/, '\n');
}

function fenceFor(text) {
  const runs = String(text).match(/`{3,}/g) || [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  return '`'.repeat(n);
}
function renderFieldCloud(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && v['expected.json'] && v['input.svg']) {
    const L = [];
    L.push('- 案例 id：' + (v['案例id'] || '(未记)'));
    if (v['目录']) L.push('- 目录（包内相对）：' + v['目录']);
    L.push('');
    for (const [label, node] of [['input.svg', v['input.svg']], ['expected.json', v['expected.json']]]) {
      L.push('### ' + label + '（' + (node['字节数'] || '?') + ' 字节，原样文本）');
      L.push('');
      const f = fenceFor(node['文本'] || '');
      L.push(f + (label.endsWith('.svg') ? 'svg' : 'json'));
      L.push(String(node['文本'] || '').replace(/\n*$/, ''));
      L.push(f);
      L.push('');
    }
    return L.join('\n').replace(/\n+$/, '');
  }
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.map((x) => '- ' + x).join('\n');
  const f = fenceFor(JSON.stringify(v, null, 2));
  return f + 'json\n' + JSON.stringify(v, null, 2) + '\n' + f;
}

/* ══════════════════ 扫描 / 判定 ══════════════════ */
/** 化名替换（**就地**改写草稿里的字符串叶子）。返回 `[{slot, to, n}]`（只含真发生过的）。
 *  ⚠ 返回值里**不复述原词**（只给序号）：预览输出是会被复制/贴图的屏，报"改了什么"用
 *    「源码里的二字化名 #1 → 孩子A（2 处）」已经足够，把原词再打一遍等于换个地方外泄。 */
export function replacePseudonyms(draft) {
  const counts = new Map();
  mapLeaves(draft, (s) => {
    let text = s, n = 0;
    for (const { from, to } of PSEUDO) {
      const parts = text.split(from);
      if (parts.length > 1) {
        counts.set(from, (counts.get(from) || 0) + parts.length - 1);
        n += parts.length - 1;
        text = parts.join(to);
      }
    }
    return { text, n };
  });
  return PSEUDO
    .map((p, i) => ({ slot: i + 1, to: p.to, n: counts.get(p.from) || 0 }))
    .filter((x) => x.n > 0);
}

/** cloud 形态：把**契约声明的原页哈希**（按值计数，逐处）替换为说明文字。
 *  为什么 cloud 要连这两处也剔除：云外发版的承诺就是"零哈希"，而这两处哈希可由
 *  同批交付的 input.svg 复算 —— 带上它只是冗余，去掉它让承诺变成字面事实。 */
export function maskDeclaredHashes(draft) {
  const c = draft && draft['合成案例'];
  if (!c || !c['expected.json'] || typeof c['expected.json']['文本'] !== 'string') return { n: 0 };
  const declared = declaredCaseHashes(draft);
  if (!declared.length) return { n: 0 };
  const left = new Map();
  for (const d of declared) { const k = d.value.toLowerCase(); left.set(k, (left.get(k) || 0) + 1); }
  let n = 0;
  const MARK = '（原页哈希已按云外发形态剔除；它就是 input.svg 的字节 sha256，可复算）';
  c['expected.json']['文本'] = c['expected.json']['文本'].replace(/[0-9a-fA-F]{64}/g, (m) => {
    const k = m.toLowerCase();
    const rest = left.get(k) || 0;
    if (!rest) return m;
    left.set(k, rest - 1); n++;
    return MARK;
  });
  return { n };
}

/** 组装结果 → 扫描结论。返回 `{ hits, exemptions, replacements, keyHits, text }`。
 *  `text` 是**将要外发的那份文本**（local = JSON / cloud = Markdown），扫描对它再做一次复核。 */
export function evaluateDraft(draft, form, declaredHashes = [], keyHits = []) {
  const replacements = replacePseudonyms(draft);
  let exemptions = 0;
  let maskedHashes = 0;
  if (form === FORM_CLOUD) {
    const m = maskDeclaredHashes(draft);
    maskedHashes = m.n;
  }
  const text = form === FORM_CLOUD ? renderCloud(draft, { maskedHashes }) : renderLocal(draft);
  const exemptValues = form === FORM_CLOUD ? [] : declaredHashes.map((d) => d.value);

  const hits = [];
  for (const leaf of leavesOf(draft)) {
    const r = scanText(leaf.text, exemptValues);          // 每个叶子各扫（豁免袋按叶子重算，避免跨字段"借"处数）
    exemptions += r.exemptions;
    for (const h of r.hits) hits.push({ rule: h.rule, field: leaf.field, snippet: h.snippet });
  }
  /* 复核：**将要外发的文本**自己也扫一遍。序列化/围栏不该引入新形态；
     真出现了（比如某天改了序列化）就 fail-closed 判红，而不是信"叶子扫过就够了"。 */
  const recheck = scanText(text, exemptValues);
  if (recheck.hits.length > hits.length) {
    for (const h of recheck.hits.slice(hits.length)) hits.push({ rule: h.rule, field: '(外发文本 · 序列化后复核)', snippet: h.snippet });
  }
  for (const k of keyHits) hits.push({ rule: '手写批注/聊天原文形态的字段名', field: k, snippet: '源记录里存在字段 ' + k });
  return { hits, exemptions, replacements, maskedHashes, keyHits, text };
}

/* ══════════════════ CLI ══════════════════ */
const argv = process.argv.slice(2);
const opt = {};
const pos = [];
const ALLOW = new Set(['json', 'card', 'case', 'from-pending', 'out', 'form', 'packs', 'data', 'at', 'help', 'h']);
let badArg = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const k = a.slice(2);
  if (!ALLOW.has(k)) { badArg = '未知参数：' + a + '　可用：--json --card <选卡串> --case <案例id> --from-pending <Txxx> --out <文件> --form local|cloud --packs <目录> --data <库根> --at <ISO8601>'; break; }
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) { opt[k] = true; }
  else { opt[k] = v; i++; }
}
const currentAt = (typeof opt.at === 'string') ? opt.at.trim() : '';
const cmd = pos[0] || '';
const JSON_OUT = !!opt.json;
/* ★ 2026-11-03（Lead 补）：`--at <ISO 8601>` —— 把「生成时间」钉死，让草稿**人为可复现**。
   为什么必须能钉：批 3 的门禁里有一条"`导出 --out` 的落盘内容 == `预览` 的 stdout 逐字"，
   而那是**两次独立调用**；只要跨过秒边界，两次的 `生成时间` 就差一秒 ⇒ **假红**（本轮 quick 实测撞上）。
   加 `--at` 之后：判据仍然逐字比（不放松），但两次调用能钉到同一个时刻；日常用不带 `--at` 就是"现在"。
   ⚠ 不许只把这条断言改宽（比如忽略生成时间那一行）—— 那会把"两次跑必须一致"这个真判据弄丢。 */
if (opt.at === true) badArg = badArg || '--at 需要一个 ISO 8601 时刻：--at 2026-11-03T15:00:00+08:00';
if (typeof opt.at === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.test(opt.at.trim())) {
  badArg = badArg || ('--at 不是合法的 ISO 8601 时刻（要带时区偏移或 Z）：' + opt.at);
}
/* `--packs` 显式给了就要**给值**（少一个参数是用法错，不许静默回落到默认根）——
   与 `_经验包.mjs` 同一条纪律。 */
if (opt.packs === true) badArg = badArg || '--packs 需要一个目录参数：--packs <dir>';
if (opt.out === true) badArg = badArg || '--out 需要一个文件参数：--out <文件>';
if (opt.card === true) badArg = badArg || '--card 需要一个选卡串：--card <packId>/<cardId>@<version>';
if (opt['from-pending'] === true) badArg = badArg || '--from-pending 需要一个待办编号：--from-pending <Txxx>';
if (opt.form === true) badArg = badArg || '--form 需要一个值：--form local|cloud';
/* `--data` 必须在任何 libraryRoot() 调用之前落进 CTB_DATA（与 `_录题任务.mjs` 同口径：
   壳显式传库根，不依赖环境变量继承）。 */
if (typeof opt.data === 'string' && opt.data.trim()) process.env.CTB_DATA = path.resolve(opt.data.trim());

const PACKS_ARG = typeof opt.packs === 'string' ? opt.packs : '';

function usage() {
  console.log([
    '拾光小册 · 经验草稿（白名单从零组装 + 隐私扫描；只读源，只写 --out）',
    '  经验包根 = ' + packsRoot(PACKS_ARG) + (PACKS_ARG ? '（来自 --packs）' : process.env.CTB_PACKS ? '（来自 CTB_PACKS）' : '（默认 %LOCALAPPDATA%）'),
    '',
    '用法：',
    '  node src\\tools\\_经验草稿.mjs 白名单 [--json]',
    '  node src\\tools\\_经验草稿.mjs 预览 <源> [--json]',
    '  node src\\tools\\_经验草稿.mjs 导出 <源> --out <文件> [--form local|cloud] [--json]',
    '',
    '  <源>（互斥，必须给且只给一种）：',
    '    --card <packId>/<cardId>@<version> [--case <案例id>]',
    '    --from-pending <Txxx>          （<库根>\\_待确认.json 里的一条「经验线索」）',
    '  通用：--packs <经验包根> · --data <库根>',
    '',
    '退出码：0 = 通过；1 = 扫出私有标记（**不写盘**）；2 = 参数或环境错。',
    '  ⚠ 本工具只读源：除 --out 指定的那一个文件外，什么都不写。',
  ].join('\n'));
}

/* ---------- 白名单（自证）---------- */
function whitelistDoc() {
  return {
    ok: true,
    fields: DRAFT_FIELDS,
    excluded: EXCLUDED,
    scanRules: SCAN_RULES.map((r) => ({ id: r.id, pattern: String(r.re), why: r.why })),
    caseHashPaths: CASE_HASH_PATHS,
    forms: FORM_NOTE,
    assembly: '草稿对象从**空对象**开始，只把白名单字段搬进去；源里其余字段一律丢弃（不是黑名单过滤）。',
  };
}
function cmdWhitelist() {
  const d = whitelistDoc();
  if (JSON_OUT) { process.stdout.write(JSON.stringify(d, null, 2) + '\n'); return 0; }
  console.log('经验草稿 · 白名单（谁可以进草稿）与显式排除（谁一律不许进）');
  console.log('');
  console.log('组装方式：' + d.assembly);
  console.log('');
  console.log('允许导出（' + DRAFT_FIELDS.length + ' 个字段，来源逐条列出）：');
  for (const f of DRAFT_FIELDS) console.log('  · ' + f.name + '　← ' + f.from);
  console.log('');
  console.log('显式排除（' + EXCLUDED.length + ' 条；源里有也一个字节都不进草稿）：');
  for (const e of EXCLUDED) console.log('  · ' + e);
  console.log('');
  console.log('隐私扫描判据（对**组装结果 + 源记录字段名**逐条扫；命中即 exit 1 并点名字段）：');
  for (const r of SCAN_RULES) console.log('  · ' + r.id + '：' + r.why + '\n      形状：' + String(r.re));
  console.log('  · ' + PSEUDO.map((p, i) => '源码里的二字化名 #' + (i + 1) + '→' + p.to).join('、') +
    '：**替换**而不是判红（公开仓库把这两个词列为 tracked 禁词）；替换处数会报出来，原词**不在输出里复述**');
  console.log('  · 手写批注/聊天原文形态的**字段名**（' + String(SOURCE_KEY_RED) + '）：出现即红（内容认不出来，但"源里存在这样一个字段"是确定信号）');
  console.log('');
  console.log('唯一具名例外（白名单，不是黑名单 —— 逐个点名，新增哈希字段会当场判红逼人回来决定）：');
  for (const c of CASE_HASH_PATHS) console.log('  · ' + c.at + '　' + c.what);
  console.log('');
  console.log('两种形态（同一份草稿，差别在给谁看）：');
  console.log('  · ' + FORM_NOTE.local);
  console.log('  · ' + FORM_NOTE.cloud);
  return 0;
}

/* ---------- 源解析 ---------- */
function resolveSource() {
  const hasCard = typeof opt.card === 'string';
  const hasPending = typeof opt['from-pending'] === 'string';
  if (hasCard && hasPending) return { ok: false, why: '两种源只能给一种：--card 与 --from-pending 同时给了' };
  /* `--case` 是"配 --card 用的"，先单独拦：否则用户拿到的是"必须给一种源"，
     而真正的问题是他把 --case 当成了独立的源。 */
  if (opt.case !== undefined && !hasCard) return { ok: false, why: '--case 只能配 --card 用（--from-pending 没有案例）' };
  if (!hasCard && !hasPending) {
    return { ok: false, why: '必须给一种源：--card <packId>/<cardId>@<version> [--case <案例id>] 或 --from-pending <Txxx>' };
  }
  if (hasCard && (opt.case === true)) return { ok: false, why: '--case 需要一个案例 id：--case <caseId>' };
  return { ok: true, kind: hasCard ? 'card' : 'pending' };
}

/* ---------- 预览 / 导出 ---------- */
function cmdDraft(write) {
  const form = opt.form === undefined ? FORM_LOCAL : String(opt.form);
  if (form !== FORM_LOCAL && form !== FORM_CLOUD) {
    console.error('--form 只认 local|cloud，收到 ' + JSON.stringify(opt.form));
    return 2;
  }
  if (!write && opt.out !== undefined) {
    console.error('预览**不写盘**（接口契约 §1.1）：--out 只属于 `导出`。要看全文就 `预览`，要落盘就 `导出 <源> --out <文件>`。');
    return 2;
  }
  let outAbs = '';
  if (write) {
    if (typeof opt.out !== 'string' || !opt.out.trim()) { console.error('用法：导出 <源> --out <文件>（--out 必填）'); return 2; }
    outAbs = path.resolve(opt.out.trim());
    const dir = path.dirname(outAbs);
    if (!fs.existsSync(dir)) {
      console.error('--out 的父目录不存在：' + dir + '\n  本工具**不建目录**（除 --out 那一个文件外不写任何东西）—— 请先把目录建好。');
      return 2;
    }
    if (fs.existsSync(outAbs) && fs.statSync(outAbs).isDirectory()) {
      console.error('--out 指向一个目录：' + outAbs + '（要给文件名）');
      return 2;
    }
  }

  const src = resolveSource();
  if (!src.ok) { console.error(src.why); return 2; }

  let built;
  if (src.kind === 'card') {
    built = assembleFromCard(opt.card, opt.case === undefined ? '' : String(opt.case), PACKS_ARG);
  } else {
    built = assembleFromPending(opt['from-pending']);
  }
  if (!built.ok) { console.error(built.why); return 2; }

  const ev = evaluateDraft(built.draft, form, built.declaredHashes, built.keyHits || []);
  const code = ev.hits.length ? 1 : 0;
  const filled = DRAFT_FIELD_NAMES.filter((n) => n in built.draft);
  const omitted = DRAFT_FIELD_NAMES.filter((n) => !(n in built.draft));

  let wrote = null;
  if (!code && write) {
    try { fs.writeFileSync(outAbs, ev.text, 'utf8'); wrote = { path: outAbs, bytes: Buffer.byteLength(ev.text, 'utf8') }; }
    catch (e) { console.error('写 --out 失败：' + outAbs + '（' + e.message + '）'); return 2; }
  }

  if (JSON_OUT) {
    const o = {
      ok: code === 0, code, cmd: write ? '导出' : '预览', form,
      source: built.sel,
      fieldsFilled: filled, fieldsOmitted: omitted, omittedNotes: built.notes || [],
      scan: {
        hits: ev.hits,
        exemptions: ev.exemptions,
        replacements: ev.replacements,
        maskedHashes: ev.maskedHashes,
        caseHashPaths: CASE_HASH_PATHS,
      },
      out: wrote,
    };
    /* 判红时**不给 draft 全文**：JSON 也是外发通道（会被贴进 Issue/日志），
       把夹带内容整份放进 stdout 等于换个地方泄漏。 */
    if (code === 0) { o.draft = built.draft; o.text = ev.text; }
    process.stdout.write(JSON.stringify(o, null, 2) + '\n');
    return code;
  }

  console.log('拾光小册 · 经验草稿（' + (write ? '导出' : '预览，**不写盘**') + '）');
  console.log('  源：' + (src.kind === 'card'
    ? '卡 ' + built.sel.sel + (built.sel.caseId ? '（案例 ' + built.sel.caseId + '）' : '（未指定案例）')
    : '待办 ' + built.sel.id + '（类型 ' + built.sel.kind_text + '，库根 ' + built.sel.libRoot + '）'));
  console.log('  形态：' + FORM_NOTE[form]);
  console.log('  另一种形态：' + FORM_NOTE[form === FORM_LOCAL ? FORM_CLOUD : FORM_LOCAL]);
  console.log('  组装：草稿从**空对象**开始，只搬白名单字段（共 ' + DRAFT_FIELDS.length + ' 个）；源里其余字段一律丢弃。');
  console.log('  本次填充 ' + filled.length + ' 个 / 未填充 ' + omitted.length + ' 个（源里没有对应数据）：');
  for (const n of filled) console.log('    ✔ ' + n);
  for (const n of omitted) console.log('    ✘ ' + n);
  for (const n of built.notes || []) console.log('      · ' + n);
  console.log('');
  console.log('  显式排除（' + EXCLUDED.length + ' 条，一条都不进草稿）：' + EXCLUDED.join('；'));
  console.log('');
  console.log('  隐私扫描：' + (ev.hits.length ? '**' + ev.hits.length + ' 处命中（exit 1）**' : '0 处命中（通过）') +
    ' ｜ 化名替换 ' + ev.replacements.reduce((a, r) => a + r.n, 0) + ' 处' +
    ' ｜ 合成案例原页哈希豁免 ' + ev.exemptions + ' 处（契约声明位置，见白名单判据）' +
    (ev.maskedHashes ? ' ｜ cloud 形态另剔除 ' + ev.maskedHashes + ' 处原页哈希' : ''));
  for (const r of ev.replacements) console.log('    ↔ 化名替换：源码里的二字化名 #' + r.slot + ' → ' + r.to + ' **' + r.n + ' 处**（草稿里已替换，原词不再出现；本报告不复述原词）');
  for (const h of ev.hits) console.log('    ✖ [' + h.rule + '] 字段 ' + h.field + '：' + h.snippet);
  if (ev.hits.length) {
    console.log('');
    console.log('  ⇒ 结论：草稿里有私有标记，**拒绝外发**（exit 1；导出时也不会写盘）。');
    console.log('     这里只打命中处的上下文片段，不打草稿全文 —— 预览屏也是外发通道（会被贴图/复制）。');
    return 1;
  }
  if (wrote) {
    console.log('  ⇒ 已写入：' + wrote.path + '（' + wrote.bytes + ' 字节，UTF-8 无 BOM）');
  }
  console.log('');
  console.log('──── 草稿全文（' + form + '）────');
  console.log(ev.text.replace(/\n$/, ''));
  return 0;
}

function main() {
  if (opt.help || opt.h || !argv.length) { usage(); return argv.length ? 0 : 2; }
  if (badArg) { console.error(badArg); return 2; }
  switch (cmd) {
    case '白名单': return cmdWhitelist();
    case '预览': return cmdDraft(false);
    case '导出': return cmdDraft(true);
    default:
      console.error('未知子命令：' + JSON.stringify(cmd) + '　可用：白名单 / 预览 <源> / 导出 <源> --out <文件>');
      return 2;
  }
}

/* 仅在被直接执行时跑 CLI；import 时不产生副作用（用例要 import 上面的纯函数对拍）。 */
const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })()) {
  process.exit(main());
}
