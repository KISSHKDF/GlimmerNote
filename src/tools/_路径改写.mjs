#!/usr/bin/env node
/**
 * 错题本 · 路径改写（2026-11-07 建）
 *
 * ══ 为什么要有它（规范 §七.1「路径改写的判据」之前**没进程序**）══
 *   用户 2026-11-06 质询"目录命名随意"→ 立规范；搬迁/改名时**唯一允许的做法**被写死在 §七.1。
 *   但实测 `src\` 与 `tests\` 里对那三条判据**零命中** —— 它只活在文档和一次性的工作目录脚本里。
 *   于是同一件事会按每个执行者的记忆各写一遍，而 2026-11-06 那次改名**真的栽过两次**：
 *     · 第一版只实现 JSON ⇒ **102 份 `.md` 的指针行变成死链**（100 份是第一轮漏的）；
 *     · 初版判据多了一条"整串相等也算路径" ⇒ `_索引.json` 的 **`grade` 字段**（值恰好是旧目录名）
 *       被静默改坏。
 *   本文件把 §七.1 搬进程序，就是那句"该写进程序的当然要写进程序"。
 *
 * ══ 三条判据（不许改；改动要三件一起做：规范 + 这里 + 阴性对照）══
 *   ① **相对路径**（JSON 的值与对象键、`.md` 里成段的路径）
 *      值以 `<旧相对路径>` 开头**且带分隔符** ⇒ 换前缀。
 *      ⚠ **整串相等不算路径** —— 那是上一版把 `grade` 改坏的原因（见 `--id`，标识走 ③）。
 *   ② **绝对路径**（`_录题\*.json` 的 `image.rel`、卡目录 `_裁图记录.json` 的 `src`）
 *      值以**盘符根**开头且含 `<旧相对路径>` 那一段 ⇒ **只换那一段**（其余字符一个不动）。
 *   ③ **非路径标识**（如 `objects[*].batch` 这类批次标签）
 *      值**恰好等于**旧标识 ⇒ 整串替换。用 `--id` 声明（标识没有分隔符，只能整串比）。
 *
 * ══ 载体要扫全（这是上轮真栽的地方）══
 *   · JSON 的**值**与**对象键**（`_页码映射.json` 的键就是库内相对路径）；
 *   · `*.md` 里的**路径 token**（卡的 `错题记录.md`「原图整页：」/「原图：」指针行、
 *     `_撤卡留档\…\_本批说明.md` 的恢复指引）。
 *   ⚠ ① 是**前缀**判据：`--map` 的旧值要写到**要改的那一层为止**（可以是多段相对路径）。
 *     若旧段名只出现在值的**中间**（如 `_撤卡留档/2026-10-08/<旧名>/…`），那不是"顶层改名"的现场；
 *     真要改那种，把 `--map` 的旧值写成多段形态（`_撤卡留档/2026-10-08/<旧名>=…`）才会命中。
 *   ② 绝对路径是**段**判据：值里任何位置的那一段都换（换完仍是绝对路径）。
 *   **`.md` 的判据比 JSON 严**：一个 token 被改写 ⟺ ① 它**现在解析不到**（死链）
 *   ② 把旧段名换成新段名后**能解析**。⇒ 天然放过"本来就失效"的库外路径与历史叙述。
 *
 * ══ 刻意不改 ══
 *   · 叙述/溯源字段（`note`/`detail`/`evidenceFix`/`origFix`/`answer`/`dispositionNote`/`source`/`why`…）
 *     —— 历史留痕（AGENTS.md 红线 6）。判据①天然跳过它们（值不以旧段名开头）；
 *     万一命中，本工具**不改写**而是把它记成"可疑"并**拒绝执行**（可疑必须为 0）。
 *   · `_备份-真源\` 下的任何快照（冻结证据，改了就不是备份了）；
 *   · 派生物 `_状态.json` / `_复习队列.md` / `_待确认清单.md` / `首页.html`（改了也会被重算覆盖）。
 *   · 例外：`_原图台账.json` 的 `objects[*].sources[]` **属于**①②的默认集合（它是 `pathShas()`
 *     反查表的键来源，不改就会让一批 `page` 永远解析不到）—— 它不需要特殊开关，走 ① 即可。
 *
 * ══ 用法 ══
 *   node src\tools\_路径改写.mjs 预演 --map '<旧相对路径>=<新相对路径>' [--map ...] [--id '<旧标识>=<新标识>'] [--root <库根>] [--json]
 *   node src\tools\_路径改写.mjs 执行 --map ... [--yes] [--root <库根>] [--json]
 *   node src\tools\_路径改写.mjs 对账 --map ... [--root <库根>] [--json]
 *
 *   预演 = 只读，把要改的每一处逐条印出来（含规则名与前后值）；
 *   执行 = 真写盘（必须 `--yes`）；**走 `_安全写.mjs`**：锁 + 事务 + 逐文件快照 + 原子替换，
 *          且**不传 indent/newline** ⇒ 沿用盘上原格式（规范 W6「改盘别改格式」）；
 *   对账 = 死链对拍（§七.1 末条，比"有没有旧名字符串"更强）：
 *          全库扫路径 token，凡"**现在解析不到、改名后能解析**"的即为本次制造的死链，**必须为 0**。
 *
 * 退出码：0 = 成功 / 对账无死链；1 = 对账有死链、或执行前发现可疑命中（未写盘）；2 = 用法错（含 执行 缺 --yes）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from './_参数.mjs';
import { libraryRoot } from './_库根.mjs';
import { withLibWrite } from './_安全写.mjs';

/* ── 不改的字段（叙述/溯源）：值不以旧段名开头，① 天然跳过；命中即记为"可疑"并拒绝执行 ── */
const NARRATIVE_KEYS = new Set([
  'note', 'detail', 'evidenceFix', 'origFix', 'answer', 'dispositionNote', 'source', 'why', 'reason',
  'summary', 'question', 'title', 'text', 'taskText', 'comment', 'remark',
]);
/* ── 整份跳过的派生物（改了也会被重算覆盖）与冻结证据目录 ── */
const SKIP_FILES = new Set(['_状态.json', '_复习队列.md', '_待确认清单.md', '首页.html']);
const SKIP_DIRS = new Set(['_备份-真源', '.git', 'node_modules', '_probe', '_快照', '_crops', 'tiles']);

const IS_ABS = /^[A-Za-z]:[\\/]/;                     // 盘符根（UNC 不在 §七.1 的判据里，见文件末尾边界）
const SEP = /[\\/]/;

/* ══════════ 三条判据（纯函数，可单测） ══════════ */

/** 值以 `old` 开头**且带分隔符** ⇒ 换前缀（①）。整串相等**不算**路径。 */
export function rewriteRelative(v, old, neu) {
  if (typeof v !== 'string' || !old) return null;
  if (v.length <= old.length) return null;                       // 至少得有一个分隔符
  if (!v.startsWith(old)) return null;
  const sep = v[old.length];
  if (!SEP.test(sep)) return null;                               // 必须带分隔符
  return neu + v.slice(old.length);
}

/** 值以盘符根开头且含 `old` 那一段 ⇒ 只换那一段（②）。 */
export function rewriteAbsolute(v, old, neu) {
  if (typeof v !== 'string' || !old || !IS_ABS.test(v)) return null;
  const parts = v.split(/([\\/])/);                              // 保序保分隔符
  let hit = false;
  for (let i = 0; i < parts.length; i += 2) {                    // 偶数下标才是段
    if (parts[i] === old) { parts[i] = neu; hit = true; }
  }
  return hit ? parts.join('') : null;
}

/** 值**恰好等于**旧标识 ⇒ 整串替换（③）。 */
export function rewriteIdent(v, old, neu) {
  if (typeof v !== 'string' || !old) return null;
  return v === old ? neu : null;
}

/** 一条字符串按 ①②③ 求新值；返回 {value, rule} 或 null（不改）。
 *  `field` = 该值所在的字段名：③ 只对**显式声明过的标识字段**生效（`--id-field`）——
 *  否则 `--id 九年级=学生甲` 会顺手把 `_索引.json` 的 `grade: "九年级"` 也改掉（那正是初版栽的坑）。 */
export function rewriteString(v, maps, field) {
  if (typeof v !== 'string' || !v) return null;
  for (const m of maps.paths) {
    const a = rewriteRelative(v, m.old, m.new);
    if (a !== null) return { value: a, rule: '①相对路径', map: m };
    const b = rewriteAbsolute(v, m.old, m.new);
    if (b !== null) return { value: b, rule: '②绝对路径', map: m };
  }
  if (field && maps.idFields && maps.idFields.has(field)) {
    for (const m of maps.ids) {
      const c = rewriteIdent(v, m.old, m.new);
      if (c !== null) return { value: c, rule: '③非路径标识', map: m };
    }
  }
  return null;
}

/** 把 `old` 段换成 `new` 段（保分隔符）；给 `.md` 的"改名后能解析吗"用。 */
export function swapSegments(t, old, neu) {
  const parts = t.split(/([\\/])/);
  let hit = false;
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === old) { parts[i] = neu; hit = true; }
  return hit ? parts.join('') : null;
}

/** 该 token 里是否**以段的形式**含 `old`（①/② 共用的"像不像这次改写目标"初筛）。 */
export function hasSegment(t, old) {
  if (typeof t !== 'string' || !old) return false;
  return t.split(SEP).includes(old);
}

/* ══════════ 载体遍历 ══════════ */
function walkCarriers(root) {
  const json = [], md = [];
  const walk = (dir, rel) => {
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name === '_快照' || e.name.endsWith('.tmp-')) continue;
        walk(p, r); continue;
      }
      if (SKIP_FILES.has(e.name)) continue;
      if (/\.tmp-|\.bak$|\.bak-/.test(e.name)) continue;
      if (e.name.endsWith('.json')) json.push({ abs: p, rel: r });
      else if (e.name.endsWith('.md')) md.push({ abs: p, rel: r });
    }
  };
  walk(root, '');
  json.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
  md.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
  return { json, md };
}

/* ══════════ JSON 载体：值与对象键（①②）＋ 值标识（③） ══════════
   ⚠ 数组里的字符串**也要走判据**（`objects[*].sources[]` 就是数组；漏掉它 = 反查表断链）。
   `fieldHint` 把"这个值属于哪个字段"带进数组深处，供 ③ 的字段作用域判断。 */
function rewriteJsonTree(node, maps, where, hits, suspicious, fieldHint) {
  if (typeof node === 'string') {
    const r = rewriteString(node, maps, fieldHint);
    if (!r) return node;
    (NARRATIVE_KEYS.has(fieldHint) ? suspicious : hits).push({ where, rule: r.rule, from: node, to: r.value });
    return r.value;
  }
  if (Array.isArray(node)) {
    return node.map((x, i) => rewriteJsonTree(x, maps, where + '[' + i + ']', hits, suspicious, fieldHint));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      let key = k;
      const kk = rewriteString(k, { paths: maps.paths, ids: [] }, null);   // 键只走 ①②（③ 是"值恰好等于"，规范口径）
      if (kk) { key = kk.value; hits.push({ where: where + ' 的键', rule: kk.rule, from: k, to: kk.value }); }
      const childWhere = where + (where ? '.' : '') + k;
      out[key] = rewriteJsonTree(v, maps, childWhere, hits, suspicious, k);
    }
    return out;
  }
  return node;
}

/* ══════════ `.md` 载体：路径 token（判据严：现在死链 + 改名后能解析） ══════════ */
const TOKEN_RE = /[^\s"'`()<>[\]{}，。；：、（）【】《》“”‘’]+/g;

/** 这个 token 现在能解析吗？（库内相对 / 盘上绝对 / 相对该 md 文件所在目录） */
function resolves(root, baseDir, token) {
  const t = String(token);
  if (IS_ABS.test(t)) { try { return fs.existsSync(t); } catch { return false; } }
  if (t.startsWith('\\\\')) return false;                            // UNC：不在判据里
  for (const base of [root, baseDir]) {
    if (!base) continue;
    try { if (fs.existsSync(path.resolve(base, t.replace(/[\\/]/g, path.sep)))) return true; } catch { }
  }
  return false;
}

function rewriteMdText(text, maps, root, baseDir, relLabel, hits) {
  let out = text;
  for (const m of maps.paths) {
    out = out.replace(TOKEN_RE, (tok) => {
      if (!hasSegment(tok, m.old)) return tok;                       // 不含旧段 ⇒ 不是这次的目标
      const swapped = swapSegments(tok, m.old, m.new);
      if (swapped === null) return tok;
      /* §七.1 的 `.md` 判据：现在解析不到（死链）**且**改名后能解析 ⇒ 才是"改名把它变死的" */
      if (resolves(root, baseDir, tok)) return tok;                  // 还活着 ⇒ 不动（历史叙述/别处的同名文件）
      if (!resolves(root, baseDir, swapped)) return tok;             // 改名也救不回来 ⇒ 本来就坏 ⇒ 不动
      hits.push({ where: relLabel, rule: '①相对路径(.md token)', from: tok, to: swapped });
      return swapped;
    });
  }
  return out;
}

/* ══════════ 对账：死链对拍 ══════════ */
/**
 * 判据（§七.1 末条）：一个**路径 token** 被算作本次制造的死链 ⟺ ① 它现在解析不到 ② 把旧段换成新段后能解析。
 * ⚠ "路径 token"的**准入**必须与改写判据**同口径**，否则会对非路径值误报：
 *   · JSON 的值/键 —— 必须满足 ①② 的形态（`old + 分隔符` 前缀，或盘符根且含该段）。
 *     反例（实测踩到）：`_索引.json` 的 `grade: "九年级"` 是**光秃秃一个段名**，既不是前缀路径也不是绝对路径，
 *     但"把段名换成学生名后 `学生甲\` 恰好存在" ⇒ 松口径会把它报成死链（假阳）。
 *   · `.md` 的 token —— 必须**含分隔符**（散文里的裸段名不是路径），再走解析判据。
 */
function pathTokenOf(tok, maps) {
  for (const m of maps.paths) {
    if (rewriteRelative(tok, m.old, m.new) !== null) return m;         // ① 形态
    if (rewriteAbsolute(tok, m.old, m.new) !== null) return m;         // ② 形态
  }
  return null;
}
function auditDeadLinks(root, carriers, maps) {
  const dead = [];
  const check = (tok, label, baseDir, kind) => {
    const m = pathTokenOf(tok, maps);
    if (!m) return;
    if (kind === 'md' && !SEP.test(tok)) return;                        // 散文里的裸段名不算路径 token
    const swapped = (kind === 'md' ? swapSegments(tok, m.old, m.new) : (rewriteRelative(tok, m.old, m.new) || rewriteAbsolute(tok, m.old, m.new)));
    if (!swapped) return;
    if (resolves(root, baseDir, tok)) return;                           // 现在还活着 ⇒ 不是死链
    if (!resolves(root, baseDir, swapped)) return;                      // 改名也救不回 ⇒ 本来就坏，不赖这次改名
    dead.push({ where: label, token: tok, wouldResolveAs: swapped, rule: rewriteRelative(tok, m.old, m.new) !== null ? '①相对路径' : '②绝对路径' });
  };
  for (const f of carriers.json) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f.abs, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const walk = (node, where) => {
      if (Array.isArray(node)) return node.forEach((x, i) => walk(x, where + '[' + i + ']'));
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          check(k, f.rel + ' 的键 ' + where, path.dirname(f.abs), 'json');
          if (typeof v === 'string') check(v, f.rel + ' ' + where + '.' + k, path.dirname(f.abs), 'json');
          else walk(v, where + '.' + k);
        }
      } else if (typeof node === 'string') {
        check(node, f.rel + ' ' + where, path.dirname(f.abs), 'json');
      }
    };
    walk(doc, '');
  }
  for (const f of carriers.md) {
    let text = '';
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    for (const tok of text.match(TOKEN_RE) || []) check(tok, f.rel, path.dirname(f.abs), 'md');
  }
  return dead;
}

/* ══════════ 入口 ══════════ */
function usage(err) {
  if (err) console.error('✖ ' + err);
  console.error('用法：');
  console.error('  node src\\tools\\_路径改写.mjs 预演 --map \'<旧相对路径>=<新相对路径>\' [--map ...] [--id \'<旧标识>=<新标识>\' --id-field <字段名>] [--root <库根>] [--json]');
  console.error('  node src\\tools\\_路径改写.mjs 执行 --map ... [--yes] [--root <库根>] [--json]');
  console.error('  node src\\tools\\_路径改写.mjs 对账 --map ... [--root <库根>] [--json]');
  console.error('  三判据（规范 §七.1）：① 相对路径（须带分隔符）② 绝对路径只换那一段 ③ 非路径标识整串相等（用 --id）。');
  return 2;
}

/** 从 argv 里摘出可重复的 `--map` / `--id`（`--map=x` 与 `--map x` 两种写法都认）。 */
function takeRepeatable(argv) {
  const rest = [], raw = { map: [], id: [], 'id-field': [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    let key = null, val = null;
    if (t === '--map' || t === '--id' || t === '--id-field') { key = t.slice(2); val = argv[++i]; }
    else if (t.startsWith('--map=')) { key = 'map'; val = t.slice(6); }
    else if (t.startsWith('--id=')) { key = 'id'; val = t.slice(5); }
    else if (t.startsWith('--id-field=')) { key = 'id-field'; val = t.slice(11); }
    if (key) { if (val === undefined) throw new Error('--' + key + ' 缺值'); raw[key].push(val); continue; }
    rest.push(t);
  }
  return { rest, raw };
}

function parseMaps(raw, kind) {
  const out = [];
  for (const s of raw) {
    const i = String(s).indexOf('=');
    if (i <= 0) throw new Error('--' + kind + ' 的形态必须是 \'<旧>=<新>\'，收到：' + JSON.stringify(s));
    const old = String(s).slice(0, i), neu = String(s).slice(i + 1);
    if (!old || !neu) throw new Error('--' + kind + ' 两侧都不能为空：' + JSON.stringify(s));
    if (kind === 'map') {
      if (IS_ABS.test(old) || old.includes('/') === false && old.includes('\\') === false) {
        /* 旧值应当是一条**相对路径**（含分隔符或至少是一个段名）；这里只做温和提示，不当错误 */
      }
    }
    out.push({ old, new: neu, raw: s });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!['预演', '执行', '对账'].includes(cmd)) return usage(cmd ? '未知动作 ' + cmd : '缺少动作');
  let taken;
  try { taken = takeRepeatable(argv.slice(1)); } catch (e) { return usage(e.message); }

  let parsed;
  try {
    parsed = parseArgs(['_路径改写', cmd, ...taken.rest], {
      valueFlags: ['root'],
      boolFlags: ['yes', 'json'],
      start: 1,
    });
  } catch (e) { return usage(e.message); }
  const opt = parsed.opt || {};
  const root = opt.root ? path.resolve(opt.root) : libraryRoot();
  const JSON_OUT = !!opt.json;

  let maps;
  try {
    maps = { paths: parseMaps(taken.raw.map, 'map'), ids: parseMaps(taken.raw.id, 'id'), idFields: new Set(taken.raw['id-field'].map(String)) };
  } catch (e) { return usage(e.message); }
  if (!maps.paths.length && !maps.ids.length) return usage('至少要给一条 --map（或 --id）。');
  if (maps.ids.length && !maps.idFields.size) {
    return usage('给 --id 时必须同时给 `--id-field <字段名>`：标识只在**声明过的字段**里整串替换，' +
      '否则 --id 会顺手改掉同名的非路径字段（如 `_索引.json` 的 grade）——那是初版真栽过的坑。');
  }
  if (!fs.existsSync(root)) return usage('库根不存在：' + root);

  const carriers = walkCarriers(root);

  /* ── 对账 ── */
  if (cmd === '对账') {
    const dead = auditDeadLinks(root, carriers, maps);
    const res = { ok: dead.length === 0, command: '对账', root, maps: maps.paths, carriers: { json: carriers.json.length, md: carriers.md.length }, deadLinks: dead.length, dead };
    if (JSON_OUT) process.stdout.write(JSON.stringify(res, null, 1) + '\n');
    else {
      console.log('【路径改写 · 对账（死链对拍）】库根：' + root);
      console.log('  载体：JSON ' + carriers.json.length + ' 份 ｜ md ' + carriers.md.length + ' 份');
      console.log('  判据（§七.1 末条）：token **现在解析不到** 且 **把旧段换成新段后能解析** ⇒ 本次制造的死链，必须为 0');
      console.log('  死链：' + dead.length);
      for (const d of dead.slice(0, 30)) console.log('  ✖ ' + d.where + '：' + d.token + '\n      → 改名后应为：' + d.wouldResolveAs);
      if (dead.length > 30) console.log('  … 另有 ' + (dead.length - 30) + ' 条');
    }
    if (dead.length) { console.error('✖ 对账未过：有 ' + dead.length + ' 条死链（改了名但某个载体没跟着改）。'); return 1; }
    console.log('  ✅ 死链 0 条。');
    return 0;
  }

  /* ── 预演 / 执行：逐载体算出新内容 ── */
  const plan = [];                     // {abs, rel, kind, text?|obj?, hits[]}
  const suspicious = [];
  for (const f of carriers.json) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f.abs, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const hits = [];
    const next = rewriteJsonTree(doc, maps, '', hits, suspicious, null);
    if (hits.length) plan.push({ abs: f.abs, rel: f.rel, kind: 'json', obj: next, hits });
  }
  for (const f of carriers.md) {
    let text = '';
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const hits = [];
    const next = rewriteMdText(text, maps, root, path.dirname(f.abs), f.rel, hits);
    if (next !== text) plan.push({ abs: f.abs, rel: f.rel, kind: 'md', text: next, hits: hits.length ? hits : [{ rule: '①相对路径(.md token)', from: '(见 diff)', to: '(见 diff)' }] });
  }

  const totalHits = plan.reduce((n, p) => n + p.hits.length, 0);
  const res = {
    ok: suspicious.length === 0, command: cmd, root, dryRun: cmd === '预演',
    maps: { paths: maps.paths, ids: maps.ids },
    carriers: { json: carriers.json.length, md: carriers.md.length },
    files: plan.length, hits: totalHits, suspicious,
    changes: plan.map((p) => ({ file: p.rel, kind: p.kind, hits: p.hits.length, detail: p.hits })),
  };

  if (JSON_OUT) process.stdout.write(JSON.stringify(res, null, 1) + '\n');
  else {
    console.log('【路径改写 · ' + cmd + '】库根：' + root);
    for (const m of maps.paths) console.log('  --map ' + m.raw);
    for (const m of maps.ids) console.log('  --id  ' + m.raw);
    console.log('  载体：JSON ' + carriers.json.length + ' 份 ｜ md ' + carriers.md.length + ' 份');
    console.log('  待改文件 ' + plan.length + ' 份 ｜ 命中 ' + totalHits + ' 处 ｜ 可疑 ' + suspicious.length + ' 处');
    for (const p of plan.slice(0, 40)) {
      console.log('  · ' + p.rel + '（' + p.hits.length + ' 处）');
      for (const h of p.hits.slice(0, 5)) console.log('      [' + h.rule + '] ' + h.where + '：' + String(h.from).slice(0, 90) + ' → ' + String(h.to).slice(0, 90));
      if (p.hits.length > 5) console.log('      … 另有 ' + (p.hits.length - 5) + ' 处');
    }
    if (plan.length > 40) console.log('  … 另有 ' + (plan.length - 40) + ' 份文件');
    for (const s of suspicious.slice(0, 10)) console.log('  ⚠ 可疑（叙述字段命中，**不改写**）：' + s.where + '：' + String(s.from).slice(0, 80));
  }

  /* 可疑命中 = §七.1 独立复核里"必须为 0"的那类 ⇒ 一律拒绝写盘（不许静默改历史） */
  if (suspicious.length) {
    console.error('✖ 有 ' + suspicious.length + ' 处**叙述/溯源字段**命中改写判据 —— 那是历史留痕（红线 6），本工具不改写，' +
      '也不许"顺手"改。请核对判据与参数（`--map` 的旧段名是否太宽？），确认无误后改规范再说。未写盘。');
    return 1;
  }

  if (cmd === '预演') {
    console.log('  （预演：一个字节都没写；确认无误后加 `执行 --yes`。）');
    return 0;
  }

  /* ── 执行 ── */
  if (!opt.yes) return usage('`执行` 会真写盘，必须显式加 `--yes`（想先看改动请用 `预演`）。');
  if (!plan.length) { console.log('  （没有需要改的地方，未写盘。）'); return 0; }

  let written = 0;
  withLibWrite(root, '_路径改写 ' + maps.paths.map((m) => m.raw).join(','), (tx) => {
    for (const p of plan) {
      if (p.kind === 'json') tx.writeJson(p.abs, p.obj, { backup: true });   // 不传 indent/newline ⇒ 沿用盘上原格式（W6）
      else tx.writeText(p.abs, p.text);
      written++;
    }
    tx.commit();
  });
  console.log('  ✅ 已改写 ' + written + ' 份文件（走 `_安全写.mjs`：锁 + 事务 + 逐文件快照 + 原子替换；格式沿用盘上原样）。');
  console.log('  下一步：`node src\\tools\\_路径改写.mjs 对账 --map ...` 必须 0 条死链。');
  return 0;
}

/* 只在直接运行时执行（被 import 时只导出三条判据，给阴性对照用） */
const isMain = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(main());

/*
 * 边界（写清以免被读成"全覆盖"）：
 *   · UNC 路径（`\\server\share\…`）与相对盘符（`..\…`）**不在** §七.1 的判据里 ⇒ 本工具不碰它们；
 *   · 二进制载体（图片/PDF 本身）不扫；
 *   · `_备份-真源\` 快照与派生物整份跳过（改了会被重算覆盖 / 冻结证据不许动）；
 *   · "可疑命中"只覆盖**声明过的叙述字段名**（NARRATIVE_KEYS）；没声明到的字段若被 ① 命中，
 *     会照改 —— 所以 `--map` 的旧段名必须是一个**真实的目录段名**（普查过：没有需要改写的路径值是光秃秃一个段名）。
 */
