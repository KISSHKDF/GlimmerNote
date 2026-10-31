#!/usr/bin/env node
/**
 * 拾光小册 · 配方引擎（AI 方法层的唯一读取/校验入口）
 *
 * 为什么要有这个文件（2026-10-27 建）：
 *   本仓的"数据层"已经齐全（索引/台账/门禁/渲染/打印），但**"怎么用 AI 把照片变成卡"这件事
 *   一直只存在于作者的工作习惯里**——没有随程序交付。别人换了自己的 AI，就得把同样的坑
 *   重新踩一遍。本文件把那一层变成可加载、可校验、可自检的**文本资产**。
 *
 * 分层职责（关键：内核一行不动）：
 *   · 内核（src\tools 其余工具）= 数据、门禁、渲染、打印 —— 不认识任何一道题、任何学科
 *   · 配方（src\recipes\）= 提示词 / 输出契约 / 验收清单 / 反例库 —— 纯文本，可插拔
 *   · 本文件 = 只做三件事：**拼提示词、校验输出、给自检打分** —— 绝不写用户库
 *
 * 【铁律一】本工具**从不写入用户数据根**。它只读配方、只写调用方指定的输出文件。
 *   入库仍由现有工具负责（`_作答门禁.mjs` 管 answerSlots、`_标记复习.mjs` 管准入），
 *   本工具不越过任何一道既有闸门。
 *
 * 【铁律二】schema 必须**真校验**，不能只当文本读给前端看。
 *   原型（work\github-publish\proto）的教训：schema.json 写得很漂亮，但运行时零校验，
 *   真正的闸只有 3 条手写规则 ⇒ enum、maxLength、minItems 全是摆设，"门禁"是假的。
 *   本文件实现一个**零依赖**的 JSON Schema 子集校验器（只支持本仓配方实际用到的关键字），
 *   并且把 `confidence` 与 `sourceImageSha256` 列为**必填**——原型就因为缺 confidence
 *   导致单题配方永远进不了 trusted、每条都被迫跑两遍。
 *
 * 用法：
 *   node src\tools\_配方.mjs 清单
 *   node src\tools\_配方.mjs 收件箱
 *   node src\tools\_配方.mjs 找图 --sha <内容指纹或前12位>   （照片改名后按指纹找回那一张）
 *   node src\tools\_配方.mjs 组装 --recipe ingest-single --subject 数学 --image <原图路径> [--out <任务.md>]
 *   node src\tools\_配方.mjs 校验 --in cards.json [--recipe <id>] [--json]
 *   node src\tools\_配方.mjs 自检 --recipe <id> --in cards.json [--json]
 *   node src\tools\_配方.mjs 指纹 [--recipe <id>]
 *
 * 退出码：0=通过  1=校验/自检未通过  2=参数或环境错误
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { APP_ROOT, libraryRoot } from './_库根.mjs';

/* ⚠ 2026-10-31：**不要**在模块顶层 import `_路径护栏.mjs`。
 *   那个模块在**导入时**就求值 `libraryRoot()` 并缓存，于是它会抢在下面
 *   `process.env.CTB_DATA = …`（--data 参数的落地点）之前把库根定死
 *   ⇒ `--data` 直接失效（实测：root 仍指向仓库 src，而不是 --data 指的库）。
 *   教训同族：**任何在导入期求值库根的模块，都不能在参数处理之前被引入**。
 *   下面的 `insideLib()` 用**本次运行的库根**自建同口径判据（纯字符串、零 IO），
 *   与 `_路径护栏.mjs` 的 `isInsideRoot` 逐条同族（归一化 + 带尾分隔符前缀比较 + 小写）。 */
function insideLib(root, abs) {
  const base = path.normalize(root);
  const prefix = (base.endsWith(path.sep) ? base : base + path.sep).toLowerCase();
  const a = path.normalize(String(abs)).toLowerCase();
  return a === prefix.slice(0, -1) || a.startsWith(prefix);
}

const argv = process.argv.slice(2);
const cmd = argv[0] || '';
const has = (k) => argv.includes(k);
const valOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = has('--json');

/* --data 走环境变量同一条路（与 `生成状态.mjs` 同一惯例）：
   桌面壳会显式把 DataRoot 传进来，避免"壳以为库在 A、工具以为库在 B"这类口径漂移
   （本仓踩过：工具搬走后 ROOT 算成了程序目录，对空库报绿）。*/
const explicitData = valOf('--data', null);
if (explicitData) process.env.CTB_DATA = path.resolve(explicitData);

/* ══════════════ 配方根：与 _库根.mjs 的 APP_ROOT 同口径 ══════════════
 * 发布包：<AppRoot>\recipes\        （build-release.ps1 把 src\recipes 平移到 app\recipes）
 * 开发区：<仓库>\src\recipes\       （APP_ROOT 在开发区就是 <仓库>\src）
 * 老布局（工具散在库根）：没有 recipes，显式报错而不是静默返回空。 */
function recipesRoot() {
  const cand = path.join(APP_ROOT, 'recipes');
  if (fs.existsSync(cand)) return cand;
  throw new Error(
    '找不到配方目录：' + cand + '\n' +
    '  说明：配方随程序包发布（app\\recipes）。若你在开发区，应为 <仓库>\\src\\recipes；\n' +
    '  若是老布局（工具散在库根），本程序没有配方层，请用发布包里的版本。\n' +
    '  当前程序目录=' + APP_ROOT + '　库目录=' + libraryRoot()
  );
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const readJson = (p) => JSON.parse(readText(p));

/** 把目录里的 *.json 读成对象；任何解析失败都抛（绝不"当空的"） */
function listRecipeDirs() {
  const root = recipesRoot();
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const dir = path.join(root, name);
    if (!isDir(dir)) continue;
    const meta = path.join(dir, 'meta.json');
    if (!isFile(meta)) continue;
    out.push({ id: name, dir });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function loadMeta(id) {
  const root = recipesRoot();
  const dir = path.join(root, id);
  const metaFile = path.join(dir, 'meta.json');
  if (!isFile(metaFile)) throw new Error('配方不存在或缺 meta.json：' + id);
  const meta = readJson(metaFile);
  if (meta.id !== id) {
    throw new Error('配方 id 与目录名不一致：目录=' + id + '　meta.id=' + meta.id +
      '（改名必须两处同改，否则指纹与引用会漂）');
  }
  return { meta, dir };
}

/* ══════════════ 层拼装：${subject} / ${textbook} 占位符 ══════════════
 * 原型缺陷：两个配方的 layers 同时列了数学+物理+英语三个文件，拼装时无条件全拼，
 * ⇒ 物理题也带着英语规则。现在改成**占位符 + 按需替换**：
 *   · 出现 ${subject} 的层，按 --subject 换成具体学科文件；找不到该学科 → 回落 通用.md 并**响亮警告**
 *   · 出现 ${textbook} 的层，只有显式给 --textbook 才挂载（默认不挂）
 *   · 层文件缺失 → **抛错**，不再静默跳过（原型 server.mjs 是静默跳过的，等于配方悄悄残废） */
function resolveLayers(meta, opts, warn) {
  const root = recipesRoot();
  const layers = Array.isArray(meta.layers) ? meta.layers : [];
  if (!layers.length) throw new Error('配方 ' + meta.id + ' 的 meta.layers 为空');
  const files = [];
  for (const rel of layers) {
    if (rel.includes('${subject}')) {
      const subj = String(opts.subject || '').trim();
      if (!subj) throw new Error('配方 ' + meta.id + ' 需要 --subject（学科），例如 --subject 数学');
      const hit = rel.replace('${subject}', subj);
      if (isFile(path.join(root, hit))) { files.push(hit); continue; }
      const fallback = rel.replace('${subject}', '通用');
      if (!isFile(path.join(root, fallback))) {
        throw new Error('学科文件与兜底文件都不存在：' + hit + ' / ' + fallback);
      }
      warn.push('配方 ' + meta.id + ' 没有「' + subj + '」的学科文件，已回落 _subject/通用.md' +
        '（该学科的判错规则不会生效，建议补一份 src\\recipes\\_subject\\' + subj + '.md）');
      files.push(fallback);
      continue;
    }
    if (rel.includes('${textbook}')) {
      const tb = String(opts.textbook || '').trim();
      if (!tb) continue;                       // 默认不挂载，空占位不产生开销
      const hit = rel.replace('${textbook}', tb);
      if (!isFile(path.join(root, hit))) throw new Error('教材层不存在：' + hit);
      files.push(hit);
      continue;
    }
    if (!isFile(path.join(root, rel))) throw new Error('配方层文件缺失：' + rel + '（在 ' + root + '）');
    files.push(rel);
  }
  return files;
}

/** 组装最终提示词。返回 {text, layers, hash, warnings} */
function compose(id, opts) {
  const { meta, dir } = loadMeta(id);
  const warn = [];
  const layerFiles = resolveLayers(meta, opts, warn);
  const root = recipesRoot();

  const parts = [];
  for (const rel of layerFiles) parts.push({ rel, text: readText(path.join(root, rel)).trim() });

  const ownPrompt = path.join(dir, 'prompt.md');
  if (!isFile(ownPrompt)) throw new Error('配方缺 prompt.md：' + id);
  parts.push({ rel: id + '/prompt.md', text: readText(ownPrompt).trim() });

  const ap = path.join(dir, 'anti-patterns.md');
  let antiText = '';
  if (isFile(ap)) {
    antiText = readText(ap).trim();
    parts.push({ rel: id + '/anti-patterns.md', text: antiText });
  } else {
    warn.push('配方 ' + id + ' 没有 anti-patterns.md —— 反例库是质量基础设施，缺它等于没有踩坑经验');
  }

  const text = parts.map((p) => p.text).join('\n\n---\n\n');

  /* 内容指纹：把**实际拼进去的每一层**算进来。
     用途：① 任务单上写出"这份提示词是哪一版"，事后可复现；② 改任何一个字，指纹必变，
     从而能回答"换了反例之后质量变好还是变差"。原型完全没有这个能力。 */
  const h = crypto.createHash('sha256');
  for (const p of parts) { h.update(p.rel); h.update('\u0000'); h.update(p.text); h.update('\u0000'); }
  const hash = h.digest('hex').slice(0, 12);

  return { meta, dir, text, parts, layerFiles, hash, warnings: warn };
}

/* ══════════════ 零依赖 JSON Schema 子集校验器 ══════════════
 * 支持的关键字（够用即止，不追求完整实现）：
 *   type / required / properties / additionalProperties / enum / const
 *   pattern / minLength / maxLength / minItems / maxItems / minimum / maximum / items
 * 遇到不支持的关键字 → **报错**，而不是静默放过（静默放过 = 假门禁，本仓吃过这个亏）。 */
const SUPPORTED = new Set(['$schema', 'title', 'description', 'type', 'required', 'properties',
  'additionalProperties', 'enum', 'const', 'pattern', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'minimum', 'maximum', 'items']);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function validateNode(node, schema, at, errs) {
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED.has(k)) errs.push(at + ' schema 用了不支持的校验关键字「' + k + '」（拒绝静默放过）');
  }
  if (schema.type) {
    const want = [].concat(schema.type);
    const got = typeOf(node);
    const ok = want.some((w) => w === got || (w === 'number' && got === 'integer'));
    if (!ok) { errs.push(at + ' 类型应为 ' + want.join('|') + '，实际 ' + got); return; }
  }
  if ('const' in schema && node !== schema.const) errs.push(at + ' 必须等于 ' + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.includes(node)) {
    errs.push(at + ' 取值不在允许集合内：' + JSON.stringify(node) + '　允许=' + JSON.stringify(schema.enum));
  }
  if (typeof node === 'string') {
    if (schema.minLength != null && node.length < schema.minLength) errs.push(at + ' 长度 ' + node.length + ' < 最小 ' + schema.minLength);
    if (schema.maxLength != null && node.length > schema.maxLength) errs.push(at + ' 长度 ' + node.length + ' > 最大 ' + schema.maxLength);
    if (schema.pattern && !new RegExp(schema.pattern).test(node)) errs.push(at + ' 不符合格式 ' + schema.pattern);
  }
  if (typeof node === 'number') {
    if (schema.minimum != null && node < schema.minimum) errs.push(at + ' 小于最小值 ' + schema.minimum);
    if (schema.maximum != null && node > schema.maximum) errs.push(at + ' 大于最大值 ' + schema.maximum);
  }
  if (Array.isArray(node)) {
    if (schema.minItems != null && node.length < schema.minItems) errs.push(at + ' 元素数 ' + node.length + ' < 最少 ' + schema.minItems);
    if (schema.maxItems != null && node.length > schema.maxItems) errs.push(at + ' 元素数 ' + node.length + ' > 最多 ' + schema.maxItems);
    if (schema.items) node.forEach((el, i) => validateNode(el, schema.items, at + '[' + i + ']', errs));
  }
  if (typeOf(node) === 'object') {
    const props = schema.properties || {};
    for (const r of (schema.required || [])) {
      if (!(r in node)) errs.push(at + ' 缺必填字段「' + r + '」');
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(node)) {
        if (!(k in props)) errs.push(at + ' 出现契约外字段「' + k + '」（多写字段会被下游忽略，等于白写）');
      }
    }
    for (const k of Object.keys(props)) {
      if (k in node) validateNode(node[k], props[k], at + '.' + k, errs);
    }
  }
}

function validateAgainst(recipeId, obj) {
  const { dir } = loadMeta(recipeId);
  const schemaFile = path.join(dir, 'schema.json');
  if (!isFile(schemaFile)) throw new Error('配方 ' + recipeId + ' 缺 schema.json —— 没有输出契约就无法校验');
  const schema = readJson(schemaFile);
  const errs = [];
  validateNode(obj, schema, 'root', errs);
  return errs;
}

/* ══════════════ 自检：与 examples 的期望比对（给"别人的 AI"打分） ══════════════
 * 这不是回归测试，是**评分卡**：用户拿自己的 AI 跑同一配方，用这里告诉他"你的 AI 在
 * 这套配方上能打多少分"。原型只比 5 项且忽略 pageSummary —— 这里补上结构差异。 */
const norm = (s) => String(s == null ? '' : s)
  .replace(/\s+/g, '')
  .replace(/[，。；：、]/g, (m) => ({ '，': ',', '。': '.', '；': ';', '：': ':', '、': ',' }[m]))
  .replace(/（/g, '(').replace(/）/g, ')')
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .toLowerCase();

function dice(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(A), gb = grams(B);
  let inter = 0, total = 0;
  for (const [g, n] of ga) { total += n; inter += Math.min(n, gb.get(g) || 0); }
  for (const [, n] of gb) total += n;
  return total ? (2 * inter) / total : 0;
}

function selfTest(recipeId, actual) {
  const { dir, meta } = loadMeta(recipeId);
  const exDir = path.join(dir, 'examples');
  if (!isDir(exDir)) throw new Error('配方 ' + recipeId + ' 没有 examples/ —— 无法自检（先备好黄金样本）');

  const cases = fs.readdirSync(exDir).filter((n) => isDir(path.join(exDir, n))).sort();
  if (!cases.length) throw new Error('配方 ' + recipeId + ' 的 examples/ 下没有样本');

  const results = [];
  for (const caseId of cases) {
    const f = path.join(exDir, caseId, 'expected.json');
    if (!isFile(f)) { results.push({ caseId, verdict: 'SKIP', detail: '缺 expected.json' }); continue; }
    const exp = readJson(f).expect || {};
    const checks = [];
    const A = (name, ok, detail) => checks.push({ name, ok, detail });

    /* ① 结构先过 schema —— 结构不合格，后面全免谈 */
    const structErrs = validateAgainst(recipeId, actual);
    A('结构符合 schema', structErrs.length === 0, structErrs.slice(0, 5).join('；') || 'ok');

    /* ② pageSummary（整页配方才有） */
    if (exp.pageSummary) {
      const got = actual && actual.pageSummary;
      if (!got) A('pageSummary 存在', false, '实际输出没有 pageSummary');
      else {
        for (const k of Object.keys(exp.pageSummary)) {
          A('pageSummary.' + k, Number(got[k]) === Number(exp.pageSummary[k]), '期望 ' + exp.pageSummary[k] + ' 实际 ' + got[k]);
        }
      }
    }

    /* ③ 条数 */
    if (Array.isArray(exp.cards)) {
      const got = (actual && Array.isArray(actual.cards)) ? actual.cards : [];
      A('cards 条数', got.length === exp.cards.length, '期望 ' + exp.cards.length + ' 实际 ' + got.length);
      for (let i = 0; i < Math.min(got.length, exp.cards.length); i++) {
        for (const k of Object.keys(exp.cards[i])) {
          const e = exp.cards[i][k], g = got[i] ? got[i][k] : undefined;
          if (typeof e === 'string' && ['questionText', 'studentAnswer', 'answer'].includes(k)) {
            const s = dice(e, g);
            A('cards[' + i + '].' + k + ' 相似度', s >= 0.6, 'dice=' + s.toFixed(2));
          } else {
            A('cards[' + i + '].' + k, g === e, '期望 ' + JSON.stringify(e) + ' 实际 ' + JSON.stringify(g));
          }
        }
      }
    }

    /* ④ 整页配方的铁律：skipped 不许为空数组 */
    if (recipeId === 'ingest-page') {
      const sk = actual && actual.skipped;
      A('skipped 非空（不许装懂）', Array.isArray(sk) && sk.length > 0, Array.isArray(sk) ? sk.length + ' 条' : '缺失');
    }

    const pass = checks.filter((c) => c.ok).length;
    const verdict = pass === checks.length ? 'PASS' : (pass >= checks.length * 0.6 ? 'MOSTLY' : 'FAIL');
    results.push({ caseId, verdict, pass, total: checks.length, checks });
  }
  return { recipe: recipeId, version: meta.version, results };
}

/* ══════════════ 收件箱：界面「录题」页的数据来源 ══════════════
 * 为什么由引擎提供而不是壳做：壳不该会"扫目录"（多一套文件系统语义就多一套越界风险）。
 * 引擎本来就知道库根在哪、也会算 sha256，让它顺带列出待处理照片最省事。
 *
 * 铁律：**只读**。不移动、不改名、不删除收件箱里的任何文件。
 * 用户把照片丢进 数据\_收件箱\<批次>\ 就行 —— 这就是"入口"，不需要文件选择对话框。 */
const IMG_RE = /\.(jpe?g|png|webp|bmp|tiff?)$/i;
const INBOX_SKIP = new Set(['_任务单', '_已处理', '_probe']);

/* ══════════════ 「已处理」判定：收件箱里哪些照片**不该再占待处理清单** ══════════════
 * 用户原话（2026-10-30）：「这个收件箱，把所有的照片都显示出来，又长又多，显示还慢，这个设置明显不合理。
 *   应该把已处理过的照片全部归档，不要在这个窗口显示了」。
 * 实测现场：256 张里 184 张早就变成过错题卡，列表却一张不落地全列，还对每张都算 sha256。
 *
 * 判据（两条，都可查证）：**这张照片已经被 `_原卷台账.json` 引用过**。
 *   那本台账是"卡 ↔ 原图"的唯一真源（`_原卷台账.mjs` 头部就这么写），
 *   所以"被它引用过"= 这张照片已经用掉、不再是待处理件。不猜、不看文件名、不看日期。
 *
 * ⚠ 2026-10-31 修（用户复报「这些照片我们都处理过了呀」还是显示着）：
 *   上一版（2026-10-30）**只认路径字符串**，于是漏判了一大片。实测现场：
 *   台账里同一张照片的 `page`/`import` 有时被记成**收件箱原路径**，
 *   有时被记成**原卷库里重命名后的路径**（例：收件箱 `.../p08-src61.jpg`
 *   ↔ 台账 `九年级/英语/原卷/课课练9上-p08-src61.jpg`）——**内容同一张，路径两套**。
 *   纯路径判据 ⇒ 这类件永远判不出来。真库实测：256 张里 **176 张路径命中**
 *   （page 命中 56 + 只被 import 命中 120），**内容判据额外命中 4 张**。
 *
 *   ⇒ 判据升级为**两条并行**：
 *     ① 路径命中（快，零 IO）：台账 page/import 的路径集合；
 *     ② 内容命中（慢，要读文件）：收件箱该件的 sha256 ∈ 候选文件的 sha256 集合。
 *       候选源两处：台账 page/import 点名的文件 **+ 各卡片目录里的 `原卷截图.jpg`**。
 *       加后者是因为有一批卡（错题卷图3~图7 → M0021~M0025）的 `page` 指向**另一张整页**，
 *       "这张照片本身"被裁成了卡片题图，而那张裁图不在台账引用集合里 ⇒ 只用台账会漏判这 5 张。
 *   ② 只在 ① 不命中时才算指纹 ⇒ **路径命中的 176 张仍然一次字节都不读**，
 *     2026-10-30 那次性能优化（256→80 张、502→214ms）**不被这次修复推翻**。
 *     （内容命中的那几张要读自己的字节才能算指纹，这是物理上躲不掉的，不是退化。）
 *
 *   为什么 ② 不会把没做过的照片藏起来：候选源里的文件要么就是**这张照片本身**
 *   （整页母本或导入原件），要么是**从它裁出来的题图**（裁图与母图字节必然不同，
 *   指纹相同仍等价于"同一张母图被用过"），判定方向一致。
 *
 *   退化方向（宁可多显示，绝不藏掉没做的）：台账缺失/损坏/cards 不是对象
 *     ⇒ 一律退回"全部待处理"并把原因说出来。
 *   为什么不把文件真的搬进 `_收件箱\_已处理\`：台账里现有 176 个不同路径指向 `_收件箱\…`，
 *   挪文件会让 `_原卷台账.mjs 门禁` 当场整片报红（"整页不在盘"）。归档要动真源，得连台账一起改，
 *   那是另一件事（要单独批准、可回滚）。本函数**只读**：不动任何文件、不写任何东西。 */
const LEDGER_NAME = '_原卷台账.json';
function inboxArchivedSet(root) {
  const set = new Set();
  const p = path.join(root, LEDGER_NAME);
  if (!isFile(p)) return { set, seen: null, doneBatches: null, doneStems: null, doneFamilies: null, transposed: null, note: '' };   // 新库/空库：正常的"还没有台账"，不是异常
  let doc;
  try { doc = readJson(p); }
  catch (e) {
    /* 台账坏了 ⇒ **宁可多显示**：退回"全部待处理"，并把原因说出来（不许静默把待处理件藏掉）。 */
    return { set, seen: null, doneBatches: null, doneStems: null, doneFamilies: null, transposed: null, note: '原卷台账读不动（' + String((e && e.message) || e).split('\n')[0] + '），已按"全部待处理"显示' };
  }
  const cards = (doc && doc.cards && typeof doc.cards === 'object' && !Array.isArray(doc.cards)) ? doc.cards : {};
  /* ① 路径集合 + 台账指纹集合（内容判据与转置判据都要用） */
  const refs = [];                       // 台账点名的绝对路径（去重后）
  const refSeen = new Set();
  const ledSha = new Set();              // 台账引用文件的 sha256（惰性算，见下）
  for (const key of Object.keys(cards)) {
    const c = cards[key] || {};
    for (const field of ['page', 'import']) {
      const v = c[field];
      if (typeof v !== 'string' || !v.trim()) continue;
      set.add(inboxRelKey(v));
      const abs = path.resolve(root, inboxRelKey(v));
      if (refSeen.has(abs)) continue;
      refSeen.add(abs);
      refs.push(abs);
    }
  }
  /* ①d **转置**判据（2026-10-31，同日按外部审查 C02 收紧）。
   *    有一批照片是**横着拍的**（手机把纸转过来），库里存了两份：
   *      收件箱 `_收件箱/2026-10-15-…物理10月阶段练习-p1p2.jpg`  （横置，2646×1860）
   *      库内   `九年级/物理/原卷/_横置备份-20261016/…-p1p2.jpg`（转正前，1860×2646）
   *    台账引用的是**转正后**那份 ⇒ 路径/指纹/批次/族四条判据全都认不出收件箱那张。
   *
   *    ⚠ 收紧原因（外部审查实测）：只比"尺寸互为转置 + 体积同量级"**不足以**下"已处理"结论——
   *      台账引用 1200×1600 的 A，收件箱放一张内容无关、恰好 1600×1200、体积比 1.000 的 B，
   *      B 就从待处理清单消失了。尺寸/体积只能当**候选筛选**，结论必须另有**内容证据**
   *      （sha256 相等），见 inboxTransposedSet() 的条件④与那里的取舍说明。
   *    代价：真正的"转正"件（重新编码过）从此留在待处理清单 —— 宁可多列，不可误藏。 */
  const transposed = inboxTransposedSet(root, cards);

  /* ①b **批次级**判据（2026-10-31，用户裁定「只要处理过，那当然不应该放在收件箱里了呀」）。
   *    为什么需要：同一份作业是**一次处理**的（同一次扫描、同一次挑错），
   *    不是逐页处理。台账里给一张卡记的 `page` 常常是**合卷扫描件**或**另一张整页**，
   *    而不是"这张照片所在的那一页"，于是纯路径/纯指纹判据认不出同批次的其它页。
   *    实测现场：错题卷批次的 7 张卡（M0019~M0025）的 `page` 全指向
   *    `九年级/原卷/九上第一周数学练习-扫描.jpg` 这类合卷件 ⇒ 收件箱里那 7 张原图一张都不认。
   *
   *    判据（**两条独立证据，任一成立**即该批次已建过卡 ⇒ 整批归档）：
   *      A. 台账的 `page`/`import` 里出现了**该批次目录下**的任一路径
   *         （例：`_收件箱/2026-10-08-某学生A-数学-学习与评价29页/p01.jpg` 被 M0027 引用
   *           ⇒ 该批次已建卡 ⇒ 同批次的 p06/p07/p20/p24 也算处理过）。
   *         这条最可靠：路径是机器写的，不会有措辞差异。
   *      B. 台账的 `source`/`note` 里出现了该批次的**日期**
   *         （例：批次目录 `2026-10-06-某学生A-数学-错题卷` ↔ source `2026-10-06 数学错题卷`）。
   *         这条补 A 的盲区：卡的 `page` 指向合卷件时，目录名对不上，但日期两边都有。
   *
   *    收紧（防误藏）：
   *      · 只认**收件箱里真实存在的批次目录**（不猜、不模糊匹配）；
   *      · A 要路径**真的在该批次目录下**（不是全库任意路径）；
   *      · B 要日期在 source 里**原样出现**；
   *      · 从未建过卡的批次 ⇒ 整批留在待处理清单（不多藏）。
   *    ⚠ 代价（诚实记录）：这会把"该批次里孩子做对了、因此没建卡的页"也归档。
   *      这是用户明确要的语义（整份作业处理过就算处理过），原图仍在收件箱里，随时可再挑错。 */
  const doneBatches = new Set();
  const batchDates = inboxBatchDates(root);       // 批次目录名 → 该批次的日期串
  for (const key of Object.keys(cards)) {
    const c = cards[key] || {};
    /* 证据 A：page/import 落在某个批次目录下。
       ⚠ 这里**不能**用 inboxRelKey（它会转小写）：批次目录名里可能有大写
       （实测 `2026-10-22-某学生A-英语-七上Unit1起-51页` 里的 `Unit1`），
       转小写后与真实目录名对不上 ⇒ 批次认不出来。
       所以这里只做**分隔符归一**，大小写保持原样。 */
    for (const field of ['page', 'import']) {
      const v = c[field];
      if (typeof v !== 'string' || !v.trim()) continue;
      const norm = String(v).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      const m = norm.match(/^_收件箱\/([^/]+)\//);
      if (m) { doneBatches.add(m[1]); break; }
    }
    /* 证据 B：source/note 里含该批次的日期 */
    const blob = [c.source, c.note].map(x => String(x || '')).join('\n');
    if (blob.trim()) {
      for (const [b, dates] of batchDates) {
        if (dates.some(x => blob.includes(x))) { doneBatches.add(b); break; }
      }
    }
  }
  /* ①c **顶层同族**判据（2026-10-31）。
   *    收件箱**顶层**（没有批次目录）的照片，常常是同一份材料的**一组页**或**一组变体**：
   *      `2026-10-15-某学生B-物理10月阶段练习-p1p2.jpg` … `-p7p8.jpg`、`-答题纸1.jpg`、`-答题纸2.jpg`
   *      `2026-10-07-…默写-原卷.jpg` / `-原卷-增强.png` / `-标准答案.jpg`
   *      `2026-10-05-…数学-作业.jpg` / `-作业-转正.jpg`
   *    它们没有批次目录 ⇒ 判据①②认不出，批次级判据（①b）也覆盖不到。
   *    判据：**同一个"族"里，只要有一个件已被台账引用 ⇒ 整族都算处理过**。
   *
   *    "族"的定义（两条同时成立才算一族，刻意保守）：
   *      · **共享前缀**：去掉页码/加工后缀后剩下的部分相同
   *        （`2026-10-15-某学生B-物理10月阶段练习-p1p2` 与 `…-答题纸2` 同族；
   *          `…数学-作业` 与 `…数学-作业-转正` 同族）；
   *      · 前缀**够长**（≥ 8 个字符）—— 否则「数学作业」会把「数学作业2」也拖进来。
   *
   *    收紧：只认**顶层**文件；只认台账**确实引用过**的族；
   *          没被引用过的族 ⇒ 一张都不归档（不多藏）。 */
  const doneStems = new Set();
  const doneFamilies = new Set();
  for (const key of Object.keys(cards)) {
    const c = cards[key] || {};
    for (const field of ['page', 'import']) {
      const v = c[field];
      if (typeof v !== 'string' || !v.trim()) continue;
      const norm = String(v).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      if (!norm.startsWith('_收件箱/')) continue;
      const parts = norm.split('/');
      const fileName = parts[parts.length - 1];
      /* 顶层文件（parts.length===2）：登记"主体"与"族" */
      if (parts.length === 2) {
        doneStems.add(inboxVariantStem(fileName));
        const fam = inboxFamily(fileName);
        if (fam) doneFamilies.add(fam);
      } else {
        /* 批次目录下的文件：它的**文件名**同样能提供族证据
           （例：台账引用 `_收件箱/2026-10-06-…国庆假期作业2-原卷p2(18-22).jpg`
             ⇒ 族 `2026-10-06-…国庆假期作业2` 已处理 ⇒ 顶层的
             `_横置备份-20261016-原卷p2(18-22).jpg` 同族，也算处理过）。 */
        const fam = inboxFamily(fileName);
        if (fam) doneFamilies.add(fam);
        const stem = inboxVariantStem(fileName);
        if (stem) doneStems.add(stem);
      }
    }
  }
  /* 收件箱顶层文件的"主体" → 主体集合（用于"同主体的另一个件已处理"） */
  const topStems = new Map();                    // stem → [顶层文件名]
  for (const name of inboxTopFiles(root)) {
    const st = inboxVariantStem(name);
    if (!topStems.has(st)) topStems.set(st, []);
    topStems.get(st).push(name);
  }
  /* ② 内容判据：**惰性**指纹索引。
   *    实测性能坑（2026-10-31）：台账引用 788 条、涉及 351 个不同文件、约 1GB。
   *    一上来就把这些文件全读一遍算 sha256 ⇒ 单次列收件箱要 1.8 秒（2026-10-30 那版只要 0.2 秒），
   *    等于把用户抱怨过的"慢"又请回来了。
   *    ⇒ 改成两段：
   *      · 先按**文件大小**把引用文件分桶（stat 一次，不读内容）；
   *      · 收件箱那张件算完自己的 sha256 后，只有**大小相同**的引用文件才可能是同一张
   *        （sha 相同 ⇒ 大小必然相同 ⇒ 大小不同的候选直接排除）；
   *      · 且这些候选的 sha256 **用到才算**，同一进程内算一次就缓存。
   *    实测：真库上列收件箱回到 0.2 秒量级。 */
  const bySize = new Map();              // size → [绝对路径]
  const addCand = (abs) => {
    if (!insideLib(root, abs)) return;    // 库外一律不读（见下方注释）
    let st; try { st = fs.statSync(abs); } catch { return; }
    if (!st.isFile()) return;
    if (!bySize.has(st.size)) bySize.set(st.size, []);
    const arr = bySize.get(st.size);
    if (!arr.includes(abs)) arr.push(abs);
  };
  for (const abs of refs) {
    /* ⚠ 库外路径一律不读（2026-10-31 加固）。
       台账里的 page/import 若写成 `../..\老库\…` 或绝对路径，`path.resolve` 会把它解析到
       **库根之外** ⇒ 内容判据会去读库外的文件（既可能被老库数据误判成"已处理"，
       也等于让一个只读工具碰了库外文件）。用 `insideLib()` 判（零 IO 纯字符串判据，
       与 `_路径护栏.mjs` 的 `isInsideRoot` 逐条同族：归一化 + 带尾分隔符前缀比较 + 小写）。
       库外引用 ⇒ 不参与内容判据（退回"多显示"方向，与整体退化策略一致）。 */
    addCand(abs);
  }
  /* ②b 卡片目录里的 **原卷截图.jpg** 也纳入候选源（2026-10-31 复核补上）。
   *    为什么必须加：有一批卡（例：错题卷图3~图7 → M0021~M0025），
   *    它的 `page` 指向**另一张整页**，而"这张照片本身"是被裁成卡片题图的（`原卷截图.jpg`）。
   *    那张裁图**不在台账的 page/import 引用集合里** ⇒ 只用台账做候选源会漏判这 5 张，
   *    用户仍会看到"已经建过卡的照片"挂在待办清单上。
   *    实测：加入卡片裁图候选源后，这 5 张从待处理清单消失（76 → 71）。
   *    代价：候选源从 351 涨到约 800 个文件；仍靠 size 分桶把实际读盘压到很小。 */
  for (const cd of inboxCardDirs(root)) {
    addCand(path.join(cd, '原卷截图.jpg'));
  }
  const shaCache = new Map();            // 绝对路径 → sha256（惰性填充）
  function seen(sha, size) {
    const cand = bySize.get(size);
    if (!cand) return false;             // 大小都对不上 ⇒ 不可能是同一张
    for (const abs of cand) {
      if (!shaCache.has(abs)) {
        let h; try { h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); }
        catch { shaCache.set(abs, ''); continue; }
        shaCache.set(abs, h);
      }
      const h = shaCache.get(abs);
      if (h && h === sha) return true;
    }
    return false;
  }
  return { set, seen, doneBatches, doneStems, doneFamilies, transposed, note: '' };
}
/** 图片的像素尺寸（**只读文件头**，不解码整图 —— 性能关键：
 *  台账引用 351 个文件，若每个都 readFileSync 整图（约 1GB）要 1.5 秒；
 *  只读前 64KB 文件头就够拿尺寸 ⇒ 几毫秒）。读不出返回 null。 */
function inboxImgDims(abs) {
  let fd;
  try { fd = fs.openSync(abs, 'r'); } catch { return null; }
  try {
    const head = Buffer.alloc(65536);
    const n = fs.readSync(fd, head, 0, 65536, 0);
    const b = head.subarray(0, n);
    if (b[0] === 0xFF && b[1] === 0xD8) {
      let o = 2;
      while (o < n - 4) {
        if (b[o] !== 0xFF) { o++; continue; }
        const m = b[o + 1];
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { o += 2; continue; }
        if (m === 0xDA) break;
        const len = (b[o + 2] << 8) | b[o + 3];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          return { w: (b[o + 7] << 8) | b[o + 8], h: (b[o + 5] << 8) | b[o + 6] };
        }
        o += 2 + len;
      }
      return null;
    }
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }
    return null;
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch { } }
}
/** 转置候选的**内容证据**：必须拿到"这两个文件是同一张照片"的客观凭据。
 *  本仓台账里**没有**"转置副本"这类字段（`_原卷台账.json` 的条目字段只有
 *  page/box/import/by/note/pagePx/cropPx/lost/locFile/need/key/student/subject/cardDir/source），
 *  所以这里只认一条：两个文件的 **sha256 相等**（同一份字节的两次拷贝）。
 *  拿不到 ⇒ 返回 false，调用方据此把该件**留在待处理清单**（宁可多列，不可误藏）。
 *  ★ 阴性自证锚点（tests\neg-inbox-transposed-evidence.cjs）：把调用点那一行摘掉
 *    （= 旧行为：尺寸互为转置 + 体积同量级就判已处理）必须复现"无关照片被贴上已处理标签"。 */
function transposedContentEvidence(shaA, absB, shaOf) {
  const hb = shaOf(absB);
  return !!shaA && !!hb && shaA === hb;
}

/** 收件箱顶层（及批次目录下）那些"与已处理件互为转置"的图片 → 它们的库根相对路径集合。
 *  用途：横拍的照片在库里存了"转正前"与"转正后"两份，路径/指纹都认不出对应关系。
 *
 *  ⚠ 2026-10-31 修（C02 · P2，外部审查复核）：**尺寸/体积只能当候选筛选，不许单独下
 *    "已处理"结论**。缺陷原形（只比条件②③）：台账引用过 1200×1600 的 A，收件箱里放一张
 *    **内容无关**、恰好 1600×1200、体积比 1.000 的 B ⇒ B 从待处理清单消失；
 *    尺寸改成 1600×1201 或体积比 0.002 就不消失 —— 说明判据当时确实只看了尺寸与体积。
 *    性质是"贴错标签"而不是"文件被吞"（界面有「显示已归档的 N 张」可展开、文件没搬没删），
 *    但方向错了：本仓纪律是"宁可多列，不可误藏"。
 *  修法：①②③ 三条原样保留为**候选筛选**（零内容 IO，先把范围压到极少数），
 *    通过筛选后**必须再拿到内容证据（条件④）**才进归档集合；拿不到就留在待处理清单。
 *
 *  取舍（诚实记录，别当注释噪音删掉）：
 *    · 真正的"转正"是重新编码，字节必变 ⇒ sha256 必然不同 ⇒ 这类件**从此不再自动归档**，
 *      会留在待处理清单里。这是刻意的：误藏一张没做过的照片（用户以为丢件）比多列一张
 *      已经做过的照片（用户划过去即可）代价大得多。
 *    · 推论：同一份字节 ⇒ 尺寸必然相同 ⇒ 与"尺寸互为转置"在物理上互斥，**本判据的实际效果
 *      是"转置件一律留在待处理"**。保留这条链是为了：① 判据结构完整（将来台账若记录
 *      "转置副本"关系，直接接在条件④上即可）；② 阴性自证需要一个"能摘掉的门"——
 *      tests\neg-inbox-transposed-evidence.cjs 摘掉条件④必须复现误藏。
 *    · 性能：条件④的 sha256 **只对已经通过①②③筛选的极少数候选**算（不是扫全库）；
 *      原先"零 IO"的口径因此失效，但代价被候选筛选限制住了，收件箱列表仍是"只读文件头"。 */
function inboxTransposedSet(root, cards) {
  const out = new Set();
  const inbox = path.join(root, '_收件箱');
  /* 台账引用过的文件（条件①的"已处理"判定）—— 这就是候选源，不用扫全库 */
  const usedFiles = [];
  for (const c of Object.values(cards || {})) {
    for (const f of ['page', 'import']) {
      const v = c && c[f];
      if (typeof v !== 'string' || !v.trim()) continue;
      const abs = path.resolve(root, v);
      if (!insideLib(root, abs)) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      /* ⚠ 阈值取 1 字节而不是 1000：合成测试素材（PNG 几百字节）也要能被认出来，
         而"图片小于 1 字节"本身就不存在，不构成误判。 */
      if (!st.isFile() || st.size < 1) continue;
      usedFiles.push(abs);
    }
  }
  /* 条件④ 的指纹：同一进程内同一文件只算一次（候选很少，但别重复读同一份大图） */
  const shaCache = new Map();
  function shaOf(abs) {
    const key = String(abs).toLowerCase();
    if (shaCache.has(key)) return shaCache.get(key);
    let h = '';
    try { h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); } catch { h = ''; }
    shaCache.set(key, h);
    return h;
  }
  /* 台账引用件按尺寸分桶（转置后的尺寸 → 候选） */
  const byDims = new Map();
  for (const abs of usedFiles) {
    const dm = inboxImgDims(abs);
    if (!dm || dm.w === dm.h) continue;
    let st; try { st = fs.statSync(abs); } catch { continue; }
    const k = dm.h + 'x' + dm.w;
    if (!byDims.has(k)) byDims.set(k, []);
    byDims.get(k).push({ abs, size: st.size });
  }
  /* 收件箱侧逐张找转置伙伴（条件②③是候选筛选，④才是结论） */
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile() || !/\.(jpe?g|png|webp|bmp|tiff?)$/i.test(e.name)) continue;
      const dm = inboxImgDims(abs);
      if (!dm || dm.w === dm.h) continue;
      const cand = byDims.get(dm.w + 'x' + dm.h);
      if (!cand) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      for (const c of cand) {
        const ratio = c.size / st.size;
        if (ratio < 0.5 || ratio > 2.0) continue;         // 条件③：同量级（候选筛选）
        /* ★ 阴性自证锚点（tests\neg-inbox-transposed-evidence.cjs）：把下面这行改成
           `if (false) continue;` = 回到"尺寸+体积即判已处理"的旧行为，用例第一个断言必须变红。 */
        if (!transposedContentEvidence(shaOf(abs), c.abs, shaOf)) continue;   // 条件④：内容证据（必须有）
        out.add(path.relative(root, abs).split(path.sep).join('/').toLowerCase());
        break;
      }
    }
  })(inbox);
  return out;
}
/** 收件箱里真实的**批次目录名**（顶层子目录，排除 `_`/`.` 开头与物理归档位）。
 *  批次级判据的锚点：只认盘上真实存在的目录名，不猜、不模糊匹配。 */
function inboxBatchNames(root) {
  const inbox = path.join(root, '_收件箱');
  const out = [];
  let ents; try { ents = fs.readdirSync(inbox); } catch { return out; }
  for (const name of ents) {
    if (name.startsWith('.') || INBOX_SKIP.has(name)) continue;
    try { if (fs.statSync(path.join(inbox, name)).isDirectory()) out.push(name); } catch { }
  }
  return out;
}
/** 收件箱**顶层**的图片文件名（不在批次目录里的那些）。 */
function inboxTopFiles(root) {
  const inbox = path.join(root, '_收件箱');
  const out = [];
  let ents; try { ents = fs.readdirSync(inbox); } catch { return out; }
  for (const name of ents) {
    if (name.startsWith('.')) continue;
    const abs = path.join(inbox, name);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile() && /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(name)) out.push(name);
  }
  return out;
}
/** 顶层文件名的**主体**：去掉已知加工后缀（转正/增强/标准答案/原卷/备份…）。
 *  只去**已知**词，不做模糊匹配 —— 否则「数学作业」与「数学作业2」会被当成同一张。
 *  ⚠ 「横置备份/备份」是**前缀**型（`_横置备份-20261016-原卷p2(18-22)`），
 *    不能用后缀规则整段吃掉（会把整名吃空）⇒ 单独处理，见 inboxFamily()。 */
const VARIANT_SUFFIX = /[-_]?(?:已转正|转正|增强|标准答案|原卷)$/;
function inboxVariantStem(name) {
  const b = String(name).replace(/\.[^.]+$/, '');
  return b.replace(VARIANT_SUFFIX, '').toLowerCase();
}
/** 顶层文件的**族**：去掉扩展名、加工后缀、页码/页区间尾巴，剩下的公共部分。
 *  例（→ 同族）：
 *    `2026-10-15-某学生B-物理10月阶段练习-p1p2.jpg` ┐
 *    `2026-10-15-某学生B-物理10月阶段练习-答题纸1.jpg`┘ ⇒ `2026-10-15-某学生B-物理10月阶段练习`
 *    `2026-10-05-某学生A-数学-作业.jpg` / `…-作业-转正.jpg` ⇒ `2026-10-05-某学生A-数学-作业`
 *    `_横置备份-20261016-原卷p2(18-22).jpg` 与 `2026-10-06-…国庆假期作业2-原卷p2(18-22).jpg`
 *      —— 前者是转正那天留的备份（带自己的日期前缀），把该前缀也剥掉才算同族。
 *  长度不足 8 字符 ⇒ 返回空串（不参与分族，避免「数学作业」拖进「数学作业2」）。 */
function inboxFamily(name) {
  let s = String(name).replace(/\.[^.]+$/, '').toLowerCase();
  /* 剥掉「备份型前缀」：`_横置备份-20261016-原卷p2(18-22)` → `原卷p2(18-22)`
     （前缀里含它自己的日期，去掉后才能与本体同族）。 */
  s = s.replace(/^_横置备份[^/]*?-/, '').replace(/^_备份[^/]*?-/, '');
  /* 再去加工后缀与页码尾巴 */
  s = s.replace(VARIANT_SUFFIX, '');
  s = s.replace(/[-_]?(p\d+(?:\s*-\s*p?\d+)?|p\d+p\d+|第?\d+页|答题纸\d*|原卷p?\d*(?:p?\d+)?|原卷p\d+\(\d+-\d+\))$/i, '');
  s = s.replace(/[-_]+\d+$/, '');
  return s.length >= 8 ? s : '';
}
/** 批次目录名 → 该批次的**日期串**列表。
 *  为什么用日期：收件箱目录名与台账 source 的写法不同
 *   （目录 `2026-10-06-某学生A-数学-错题卷` vs source `2026-10-06 数学错题卷`），
 *   只有日期两边都原样有、且足够唯一。
 *  提取规则：目录名里出现的 `YYYY-MM-DD`；另外 `某学生B-物理-20261007` 这种
 *   把日期写成 `20261007` 的，**不**折算成 `2026-10-07`（避免造出 source 里没有的串）。 */
function inboxBatchDates(root) {
  const out = new Map();
  for (const b of inboxBatchNames(root)) {
    const ds = b.match(/\d{4}-\d{2}-\d{2}/g);
    out.set(b, ds ? ds : []);
  }
  return out;
}
/* 找出库里所有"卡片目录"（含 `错题记录.md` 的目录）的绝对路径。
 * 判据与卡片目录的既有定义一致（`错题记录.md` 存在即算一张卡），
 * 只取**两层深**（学生/学科/卡号），与 `_原卷台账.mjs` 的 loadCards 口径同族。
 * 排除 `_` / `.` 开头的目录（`_收件箱`、`_probe`、`_备份-*` 等都不是卡）。 */
function inboxCardDirs(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      let kids; try { kids = fs.readdirSync(abs); } catch { continue; }
      if (kids.some(k => k.endsWith('错题记录.md'))) out.push(abs);
      else walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
/* 台账里的路径是库根相对的 posix 形态，但老数据里也可能出现反斜杠 / ./ 前缀 / 大小写差异。
   收件箱侧同样用这个口径归一，两边必须走**同一个函数**，否则"明明登记过却还显示"这种假阴性查不出来。 */
function inboxRelKey(rel) {
  return String(rel).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

function cmdInbox() {
  const root = libraryRoot();
  const inbox = path.join(root, '_收件箱');
  /* ★ 2026-10-27：缺了就建。起因——发布包里只有 数据\先看这里.txt，**没有 _收件箱**，
     而录题页告诉用户"把照片放进 _收件箱\<批次>\"，用户照着去找发现根本没有这个文件夹。
     这个目录本来就归本工具管（只有它读它），由它负责建最合适。
     只建一层空目录，不写任何数据文件，因此不违反"工具不写用户库"那条（没有任何真源被改动）。 */
  /* ★ 2026-10-29（R2 审计 D-04）：建目录失败不许被讲成"空收件箱"。
     改前 `ensured=false` **一个值同时表示**"本来就有、不用建"与"建失败了"，
     于是权限/只读故障（库目录只读挂载、ACL 拒绝、盘符不可用）被讲成"你还没丢照片"，
     用户会一直往一个根本没建出来的目录里丢东西。现在三态，且建失败**响亮退 2**：
       'none'  本来就有，不用建
       'made'  这次刚建好
       'fail'  建不出来 ⇒ 报 JSON/人读错误 + 退出码 2（参数/环境错误档，与"校验拒收=1"分开） */
  let ensured = 'none';
  if (!isDir(inbox)) {
    try { fs.mkdirSync(inbox, { recursive: true }); ensured = 'made'; }
    catch (e) {
      ensured = 'fail';
      const msg = '收件箱目录建不出来：' + inbox + '（' + e.message + '）';
      if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, root, inboxRel: '_收件箱', batches: [], total: 0, created: ensured, error: msg }) + '\n');
      process.stderr.write('✖ ' + msg + '\n' +
        '  常见原因：库目录只读 / 当前账户对该目录无写权限 / 盘符不可用。\n' +
        '  这不是"收件箱空着"——请先把 _收件箱 目录建出来（或修权限）再重试。\n');
      return 2;
    }
  }
  const arch = inboxArchivedSet(root);
  const batches = [];
  const archived = [];
  let nUnreadable = 0;                  // 读不动而跳过的文件数（跨批次累计）
  let nOutside = 0;                     // 越出库根而跳过的文件数（跨批次累计）
  if (isDir(inbox)) {
    for (const name of fs.readdirSync(inbox).sort()) {
      if (name.startsWith('.') || INBOX_SKIP.has(name)) continue;
      const dir = path.join(inbox, name);
      const isB = isDir(dir);
      /* 支持两种投递：_收件箱\<批次>\*.jpg 或 _收件箱\*.jpg（不建批次也能用） */
      const scanDir = isB ? dir : inbox;
      if (!isB && !IMG_RE.test(name)) continue;
      const files = [];
      const archHere = [];
      /* 判据③（批次级，零 IO）：该批次已建过卡 ⇒ 整批都是"处理过的"，一张一张判是多余的。
         用户原话（2026-10-31）：「只要处理过，那当然不应该放在收件箱里了呀」——
         整份作业是**一次处理**的（同一次扫描、同一次挑错）。 */
      const batchDone = isB && arch.doneBatches && arch.doneBatches.has(name);
      const pushFile = (abs) => {
        let st; try { st = fs.statSync(abs); } catch { return; }
        if (!st.isFile() || !IMG_RE.test(path.basename(abs))) return;
        /* ⚠ 库外文件一律不读（2026-10-31 复核补上，与台账侧同一个判据）。
           若 `_收件箱\<批次>` 是指向库外的 junction / 符号链接，
           下面的文件会被当成本库的照片读进来算指纹 —— 违反"只碰用户库"的边界。 */
        if (!insideLib(root, abs)) { nOutside++; return; }
        const rel = path.relative(root, abs).split(path.sep).join('/');
        const base = { name: path.basename(abs), rel, bytes: st.size };
        /* 判据③：该批次已建过卡 ⇒ 整批归档（零 IO，连 stat 都不用）。
           放在路径判据**之前**：批次级是更粗但更准的粒度，先判它最省事。 */
        if (batchDone) { archHere.push(base); return; }
        /* 判据①：路径命中（零 IO）⇒ 已处理 ⇒ 只报名字/大小，**不算哈希**。
           这一条就是"显示还慢"的正面修法：慢的那部分 IO 只花在真正待办的照片上。 */
        if (arch.set.has(inboxRelKey(rel))) { archHere.push(base); return; }
        /* 判据①c（顶层同族，零 IO）：同一"族"里已有件被台账引用 ⇒ 这张也处理过。
           例：`…物理10月阶段练习-p1p2.jpg` 与 `…物理10月阶段练习-答题纸2.jpg`（台账引用的是后者）
           —— 同一份作业的不同页，路径与指纹都认不出，只有"族"认得出。 */
        if (!isB && arch.doneStems) {
          const st = inboxVariantStem(base.name);
          const fam = inboxFamily(base.name);
          if (arch.doneStems.has(st) || (fam && arch.doneFamilies && arch.doneFamilies.has(fam))) {
            archHere.push(base); return;
          }
        }
        /* 判据①d（转置）：与某个已处理件**互为转置**且**内容证据成立**（sha256 相等）。
           ⚠ 不是"零 IO"了：sha256 只在通过尺寸/体积候选筛选的少数件上算（见 inboxTransposedSet）。
           只满足尺寸/体积的件**刻意不进这里** —— 宁可留在待处理清单，不可误藏。 */
        if (arch.transposed && arch.transposed.has(inboxRelKey(rel))) { archHere.push(base); return; }
        /* 待处理件本来就要算 sha256（前端要显示指纹、勾选时按指纹找回同内容那张），
           所以这里**顺手**用它比一次内容指纹 —— 判据②零额外 IO。
           ⚠ 2026-10-31：路径对不上但内容同一张的件（台账记的是重命名后的原卷路径）
              以前就是这么漏判的。 */
        let h;
        try { h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); }
        catch (e) {
          /* ⚠ 单个文件读不动（权限/占用/损坏）**不许拖垮整个列表**（2026-10-31 复核补上）。
             旧实现这里没有 try ⇒ 一张坏照片就让整个收件箱读不出来（EPERM 直接退出 2），
             用户连别的照片都看不到。改成：跳过这一张、记个数、继续。 */
          nUnreadable++;
          return;
        }
        if (arch.seen && arch.seen(h, st.size)) { archHere.push(base); return; }
        files.push({ ...base, sha256: h });
      };
      if (isB) {
        for (const f of fs.readdirSync(dir).sort()) {
          if (f.startsWith('.')) continue;
          const a = path.join(dir, f);
          if (isDir(a)) continue;
          pushFile(a);
        }
      } else {
        pushFile(dir);
      }
      if (files.length) {
        const bucketName = isB ? name : '（未分批）';
        let bucket = batches.find((b) => b.name === bucketName);
        if (!bucket) { bucket = { name: bucketName, files: [] }; batches.push(bucket); }
        bucket.files.push(...files);
      }
      archived.push(...archHere);
    }
  }
  const total = batches.reduce((n, b) => n + b.files.length, 0);
  const archivedCount = archived.length;
  /* 跳过项要说出口：读不动 / 越出库根的文件**没有**出现在任何清单里，
     用户看不到就以为照片丢了。宁可显式报出来，也不静默少列。 */
  const skipNote = (nUnreadable ? nUnreadable + ' 张读不动（权限或文件占用）' : '') +
    (nOutside ? (nUnreadable ? '；' : '') + nOutside + ' 张越出库根（已跳过，不读）' : '');

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      ok: true, root, inboxRel: '_收件箱', batches, total,
      archivedCount, archived, archivedNote: arch.note, created: ensured,
      skipped: { unreadable: nUnreadable, outside: nOutside },
      skipNote,
    }) + '\n');
    return 0;
  }
  console.log('收件箱：' + inbox + (ensured === 'made' ? '（刚为你建好）' : ''));
  if (arch.note) console.log('  ⚠ ' + arch.note);
  if (skipNote) console.log('  ⚠ 已跳过：' + skipNote);
  if (!total && !archivedCount) {
    console.log('（空）把错题照片按批次放进 _收件箱\\<批次名>\\，再回到程序里选它。');
    return 0;
  }
  if (!total) {
    console.log('收件箱里的 ' + archivedCount + ' 张照片都已处理完（已归档，不再列出；文件一张没动）。');
    return 0;
  }
  console.log('共 ' + batches.length + ' 批 / ' + total + ' 张待处理' +
    (archivedCount ? '（另有 ' + archivedCount + ' 张已处理，已归档不再显示）' : '') + '：');
  for (const b of batches) {
    console.log('  ▸ ' + b.name + '（' + b.files.length + ' 张）');
    for (const f of b.files) console.log('      ' + f.name + '  ' + (f.bytes / 1024).toFixed(0) + ' KB  ' + f.sha256.slice(0, 12));
  }
  /* CLI 自查用：--all 才把已归档的名字也打出来（页面通道没有这个 flag，壳的白名单不含它） */
  if (archivedCount && has('--all')) {
    console.log('\n  已归档（已处理，不再列出；仍在 _收件箱 里）：' + archivedCount + ' 张');
    for (const f of archived) console.log('      ' + f.rel);
  }
  return 0;
}

/* ══════════════ 按内容指纹找图（2026-10-27 加，界面「📂 定位这张图」的兜底）══════════════
 * 起因（第二次"任务单交不出去"）：任务单只写**文件名**，而收件箱里的照片会被导入流程按页码
 *   改名（微信图片_20261025170128_242_134.jpg → p042.jpg，**sha256 不变**）。用户拿着早先生成
 *   的单子照名字翻文件夹 ⇒ 找不到文件 ⇒ 附件发不出去 ⇒ 对端 AI 按止损指令回「我没有看到图片」。
 * 唯一不随改名失效的标识就是 sha256，而它本来就在任务单里（溯源锚）。这个动作把它变成"能定位"：
 *   只读，不改名、不移动、不删除、不写任何文件（与「收件箱」同一条铁律）。 */
function cmdLocate() {
  const raw = String(valOf('--sha', '')).trim().toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(raw)) {
    console.error('用法：找图 --sha <内容指纹（64 位，或前 12 位起）>');
    console.error('  值从任务单「sourceImageSha256」那行抄，或从录题页每张图后面的指纹前缀抄。');
    return 2;
  }
  const root = libraryRoot();
  const inbox = path.join(root, '_收件箱');
  if (!isDir(inbox)) { console.error('收件箱不存在：' + inbox); return 2; }
  const matches = [];
  const walk = (dir, depth) => {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (INBOX_SKIP.has(name) || depth >= 3) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!st.isFile() || !IMG_RE.test(name)) continue;
      let sha = '';
      try { sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); } catch { continue; }
      if (sha.startsWith(raw)) {
        matches.push({
          name, bytes: st.size, sha256: sha,
          rel: path.relative(root, abs).split(path.sep).join('/'),
        });
      }
    }
  };
  walk(inbox, 0);
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: true, want: raw, total: matches.length, matches }) + '\n');
    return matches.length ? 0 : 1;
  }
  if (!matches.length) { console.log('收件箱里没有内容指纹以 ' + raw + ' 开头的图片（可能被移出库了）。'); return 1; }
  for (const m of matches) console.log(m.rel + '　' + (m.bytes / 1024).toFixed(0) + ' KB　' + m.sha256.slice(0, 12));
  return 0;
}

/* ══════════════ 命令实现 ══════════════ */

function cmdList() {
  const root = recipesRoot();
  const list = listRecipeDirs();
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      root,
      recipes: list.map(({ id }) => {
        const { meta } = loadMeta(id);
        return { id, version: meta.version, title: meta.title, kind: meta.kind, layers: meta.layers };
      }),
    }) + '\n');
    return 0;
  }
  console.log('配方根：' + root);
  console.log('共 ' + list.length + ' 个配方：\n');
  for (const { id } of list) {
    const { meta, dir } = loadMeta(id);
    const ex = isDir(path.join(dir, 'examples')) ? fs.readdirSync(path.join(dir, 'examples')).filter((n) => isDir(path.join(dir, 'examples', n))).length : 0;
    console.log('  ' + id + '  v' + meta.version);
    console.log('     ' + (meta.title || ''));
    console.log('     层：' + (meta.layers || []).join(' + '));
    console.log('     样本：' + ex + ' 个　反例：' + (isFile(path.join(dir, 'anti-patterns.md')) ? '有' : '**缺**'));
    console.log('');
  }
  return 0;
}

function cmdCompose() {
  const id = valOf('--recipe', '');
  if (!id) { console.error('用法：组装 --recipe <id> --subject <学科> [--image <路径>] [--out <文件>]'); return 2; }
  const img = valOf('--image', '');
  const out = valOf('--out', '');

  let imgAbs = '', imgSha = '';
  if (img) {
    /* ⚠ 2026-10-27 修（用户实测「生成不了任务单」，界面显示"已生成（0 字符 / 1 行）"）：
       原写法 `path.resolve(img)` 是**相对进程 cwd** 解析的。而界面传进来的是**库内相对路径**
       （`_收件箱/xxx.jpg`），壳 spawn node 时 cwd 是程序目录 ⇒ 解析成 `app\_收件箱\xxx.jpg`
       ⇒ 文件不存在 ⇒ 本函数返回 2 ⇒ 界面拿到空 stdout，还当成生成成功。
       正确语义：相对路径一律按**库根**解析（库根就是由 --data / CTB_DATA 定下来的那个）。
       绝对路径仍然按原样（允许诊断时直接指定盘上任何位置）。 */
    const root0 = libraryRoot();
    imgAbs = path.isAbsolute(img) ? path.normalize(img) : path.resolve(root0, img.replace(/[\\/]+/g, path.sep));
    if (!isFile(imgAbs)) {
      console.error('原图不存在：' + imgAbs);
      console.error('  说明：相对路径按库根解析（库根=' + root0 + '）；若文件确实在别处，请传绝对路径。');
      return 2;
    }
    imgSha = crypto.createHash('sha256').update(fs.readFileSync(imgAbs)).digest('hex');
  }

  const c = compose(id, { subject: valOf('--subject', ''), textbook: valOf('--textbook', '') });
  for (const w of c.warnings) console.error('⚠ ' + w);

  /* ══════════ 任务单结构（2026-10-27 重写）══════════
   * 起因（用户拿第一版去问 WorkBuddy，对方直接拒绝做）：
   *   ① **sha256 在「给 AI 的段落」之外** —— 用户被告知只复制「三、任务指令」，
   *      而溯源锚写在「一、本次任务」表里 ⇒ AI 拿不到这个值，只能编或拒（对方拒了，拒得对）；
   *   ② 交付要求里让 AI 跑 `node src\tools\_配方.mjs 校验` —— 对方在**另一个程序**里，
   *      没有这个仓库、也没有这个命令，看到只会追问"你的仓库在哪"，整场跑偏；
   *   ③ 「连同规定的原图」只是引用块里半句话，用户漏发附件，整单空转。
   *
   * 现在的结构原则：**「给 AI 的」与「给本机看的」彻底分开，且 AI 那段自带全部所需信息**。
   *   一、你要做的两件事   ── 给人：先发图，再粘下面那段
   *   二、任务指令         ── 给 AI：本次任务表（含 sha256）+ 止损指令 + 配方正文
   *   三、回来之后         ── 给人：本机怎么校验、怎么入库
   *   四、本机留痕         ── 只供排查，明确标注"不用发给 AI"
   *
   * 另外两条硬规矩：
   *   · **不写任何本机绝对路径**（目录结构会带出孩子化名/年级/学科）；
   *   · **不写任何要对方执行的命令**（它没有我们的仓库，写命令只会误导）。 */
  const subject = valOf('--subject', '');
  const fileName = imgSha ? path.basename(imgAbs) : '';

  const head = [];
  head.push('# 录题任务单');
  head.push('');
  head.push('> 由拾光小册程序生成 · 配方 `' + id + '` v' + c.meta.version + ' · 指纹 `' + c.hash + '`');
  head.push('');
  head.push('## 一、你要做的两件事（照着做，别跳步）');
  head.push('');
  head.push('1. **先把这张照片作为附件发出去**：' + (fileName ? '`' + fileName + '`' : '（本次没选照片，见下方说明）'));
  if (fileName) {
    /* ★ 2026-10-27 改（第二次交不出去事故）：原先这句是「点打开收件箱文件夹就能找到它」，
       等于把"发哪张图"锚在**文件名**上。而收件箱里的照片会被导入流程按页码改名
       （微信图片_20261025170128_242_134.jpg → p042.jpg，sha256 不变），
       用户拿着一张早先生成的单子去翻文件夹，**照着名字找不到文件** ⇒ 附件发不出去
       ⇒ 对端 AI 按止损指令回「我没有看到图片」（它拒得对）。
       改法：给"库内路径 + sha 前缀"双标识，并把动作从「自己找」换成「程序帮你选中」。 */
    head.push('   - 这张图的内容指纹前 12 位：`' + imgSha.slice(0, 12) + '`（发图前后对一下这个，就知道发的是不是它）');
    head.push('   - 在程序左侧「📥 录题」页点 **「📂 定位这张图」**，资源管理器会**直接选中这一张**');
    head.push('     （不用自己翻文件夹认文件名——一屏缩略图里挑错一张，整单就废了）');
    head.push('     任务单里**故意不写它在哪个文件夹**：目录名带着孩子化名和学科，不该进任何 AI 会话。');
    head.push('   - **要发原图**，不要发微信/相册里的缩略图（缩略图分辨率不够，AI 看不清笔下笔划）');
    head.push('   - ⚠ **这张单子别囤着用**：照片导入后会按页码改名，旧单子里的文件名会失效。');
    head.push('     手上这张如果不是刚生成的，回程序重新勾一次那张图、重新生成一份。');
  } else {
    head.push('   - ⚠ 本次生成时没选照片，所以没有文件名可给。**没有照片，AI 无法判题**，请不要往下发。');
  }
  head.push('2. **再把下面「二、任务指令」整段复制**，和照片一起发给你的 AI。');
  head.push('');
  head.push('> ⚠ 这两件事必须**一起**做。只发文字不发照片，AI 看不到题目，只能拒绝——');
  head.push('> **它拒绝是对的**：没有原图就编 `pageSummary`、编 sha256，等于给不可查证的数据盖章。');
  head.push('> 如果你漏发了图，AI 按第二段里的止损指令会直接说"我没看到图片"，那是正常行为。');
  head.push('');
  head.push('## 二、任务指令（整段复制给你的 AI，含下面这张表）');
  head.push('');
  head.push('### 本次任务');
  head.push('');
  head.push('| 项 | 值 |');
  head.push('|---|---|');
  head.push('| 学科 | ' + (subject || '（未指定）') + ' |');
  if (imgSha) {
    head.push('| 原图文件名 | `' + fileName + '` |');
    head.push('| **sourceImageSha256** | `' + imgSha + '` |');
    head.push('');
    head.push('> 上面这个 `sourceImageSha256` 是**本次这张原图的内容指纹**。你产出的**每一条**记录都必须');
    head.push('> 原样回填它（一个字符都不许改）。这是"这条记录来自哪张图"的唯一凭据。');
  } else {
    head.push('| **sourceImageSha256** | ⚠ 缺（本次未选照片）—— 没有它，回传会被程序拒收 |');
  }
  head.push('');
  head.push('### 止损指令（先看这条，再看下面的规则）');
  head.push('');
  head.push('**如果你没有在本次对话里收到那张图片，就直接回答「我没有看到图片」，然后停下。**');
  head.push('不要根据文件名猜内容，不要用别的图顶替，不要编 `pageSummary`，也不要追问仓库路径——');
  head.push('这只是录题，你不需要访问任何文件或命令，全部输入都在上面和附件里。');
  head.push('');
  head.push('你会看到的所有规则都写在下面，**不需要运行任何命令、不需要访问任何本地路径、不需要保存文件**。');
  head.push('直接把结果以 JSON 文本回给我即可。');
  head.push('');
  head.push('---');
  head.push('');
  head.push(c.text);
  head.push('');
  head.push('---');
  head.push('');
  head.push('## 三、回来之后（这一步在本机做，**不用发给 AI**）');
  head.push('');
  head.push('1. 把 AI 回的 JSON **原样**粘回程序「📥 录题」页第 3 步的输入框');
  head.push('2. 点「校验」→ 程序按契约逐条检查（结构、枚举、必填、溯源锚）');
  head.push('3. 校验通过后，按 `docs\\作答契约.md` 建卡入库（程序不自动入库，要过三道门禁）');
  head.push('');
  head.push('## 四、本机留痕（仅供排查，**不用发给 AI**）');
  head.push('');
  head.push('| 项 | 值 |');
  head.push('|---|---|');
  head.push('| 配方 | `' + id + '` v' + c.meta.version + ' |');
  head.push('| 配方指纹 | `' + c.hash + '`（提示词任何一字改动都会变） |');
  head.push('| 装载层 | ' + c.layerFiles.join(' → ') + ' → `' + id + '/prompt.md` → `' + id + '/anti-patterns.md` |');
  head.push('| 原图 | ' + (fileName ? '`' + fileName + '`（本机完整路径不写入任务单，避免目录结构进 AI 会话）' : '（未指定）'));
  head.push('');
  head.push('');
  head.push(c.text);
  head.push('');

  const text = head.join('\n');
  if (out && out !== '-') {
    const abs = path.resolve(out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    console.log('已写任务单：' + abs);
    console.log('配方=' + id + ' v' + c.meta.version + '  指纹=' + c.hash + '  层数=' + c.layerFiles.length +
      '  提示词=' + text.length + ' 字符' + (imgSha ? '  原图sha256=' + imgSha.slice(0, 16) + '…' : ''));
  } else {
    /* 产物走 stdout、摘要走 stderr（2026-10-27 定）：
       界面要把整份任务单当"干净产物"取走，摘要混进 stdout 会被一起显示出来。
       这也与本仓其余工具的约定一致：stdout 只放机器/人会消费的东西，进度信息一律 stderr。 */
    process.stdout.write(text);
    process.stderr.write('配方=' + id + ' v' + c.meta.version + '  指纹=' + c.hash + '  层数=' + c.layerFiles.length +
      '  提示词=' + text.length + ' 字符' + (imgSha ? '  原图sha256=' + imgSha.slice(0, 16) + '…' : '') + '\n');
  }
  return 0;
}

function cmdValidate() {
  const inFile = valOf('--in', '');
  if (!inFile) { console.error('用法：校验 --in <cards.json> [--recipe <id>]'); return 2; }
  const abs = path.resolve(inFile);
  if (!isFile(abs)) { console.error('输入文件不存在：' + abs); return 2; }

  let obj;
  try { obj = readJson(abs); }
  catch (e) { console.error('✖ 不是合法 JSON：' + e.message + '\n  提示：AI 常常在 JSON 外裹一段解释文字，只保留花括号内内容。'); return 1; }

  /* 默认按配方推断：有 pageSummary 走整页配方，否则走单题配方。
     ⚠ 推断必须**说出口**（不静默）：整页输出若漏了 pageSummary，会被误判成单题配方，
     而单题 schema 不要求 pageSummary ⇒ 一份残缺的整页结果可能"悄悄通过"。
     所以这里把推断依据打印出来，调用方一眼能看出"它拿哪套契约验的"。 */
  let id = valOf('--recipe', '');
  let inferred = false;
  if (!id) {
    id = (obj && obj.pageSummary) ? 'ingest-page' : 'ingest-single';
    inferred = true;
  }

  const errs = validateAgainst(id, obj);
  const cards = Array.isArray(obj && obj.cards) ? obj.cards : [];
  const skipped = Array.isArray(obj && obj.skipped) ? obj.skipped : [];

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: errs.length === 0, recipe: id, inferred, cards: cards.length, skipped: skipped.length, errors: errs }) + '\n');
    return errs.length ? 1 : 0;
  }

  console.log('配方：' + id + (inferred ? '（未指定 --recipe，按输入形态推断：' + (obj && obj.pageSummary ? '有 pageSummary' : '无 pageSummary') + '）' : ''));
  console.log('记录：' + cards.length + ' 条　跳过：' + skipped.length + ' 条');
  if (!errs.length) {
    console.log('✔ 校验通过');
    /* 通过之后再给两条"程序能算、但不该阻断"的提示 */
    const low = cards.filter((c) => c && c.confidence === 'low').length;
    if (low) console.log('  提示：' + low + ' 条 confidence=low，按清单要求人工看一眼 notes 写没写清疑点');
    const nosrc = cards.filter((c) => c && c.answerSource === '未能确认').length;
    if (nosrc) console.log('  提示：' + nosrc + ' 条 answerSource=未能确认 —— 这些进不了组卷池，属正常（缺第二来源）');
    return 0;
  }
  console.log('✖ 校验未通过：' + errs.length + ' 处');
  for (const e of errs) console.log('   - ' + e);
  return 1;
}

function cmdSelfTest() {
  const id = valOf('--recipe', '');
  const inFile = valOf('--in', '');
  if (!id || !inFile) { console.error('用法：自检 --recipe <id> --in <cards.json>'); return 2; }
  const abs = path.resolve(inFile);
  if (!isFile(abs)) { console.error('输入文件不存在：' + abs); return 2; }
  const obj = readJson(abs);
  const r = selfTest(id, obj);

  if (JSON_OUT) { process.stdout.write(JSON.stringify(r) + '\n'); return r.results.some((x) => x.verdict === 'FAIL') ? 1 : 0; }

  console.log('配方自检：' + id + ' v' + r.version);
  for (const c of r.results) {
    console.log('  [' + c.verdict + '] ' + c.caseId + '　' + (c.pass || 0) + '/' + (c.total || 0));
    for (const k of (c.checks || [])) {
      if (!k.ok) console.log('      ✗ ' + k.name + '　' + (k.detail || ''));
    }
  }
  const fail = r.results.filter((x) => x.verdict === 'FAIL').length;
  if (fail) console.log('✖ ' + fail + ' 个样本 FAIL —— 你的 AI 在这套配方上还没达标，先看上面的失败项');
  else console.log('✔ 无 FAIL');
  return fail ? 1 : 0;
}

function cmdFingerprint() {
  const id = valOf('--recipe', '');
  /* 不给 --subject 时用「通用」：`_subject/通用.md` 是真实存在的兜底文件，
     所以不会触发回落警告，指纹含义明确 =「核心层 + 通用学科 + 该配方自身」。
     给 --subject 则算的是该学科的完整提示词指纹（不同学科必然不同）。 */
  const subj = valOf('--subject', '') || '通用';
  if (id) {
    const c = compose(id, { subject: subj });
    if (JSON_OUT) { process.stdout.write(JSON.stringify({ recipe: id, version: c.meta.version, fingerprint: c.hash, subject: subj, layers: c.layerFiles }) + '\n'); return 0; }
    console.log(id + '  v' + c.meta.version + '  指纹=' + c.hash + '　学科=' + subj);
    console.log('  层：' + c.layerFiles.join(' → '));
    return 0;
  }
  const list = listRecipeDirs();
  const out = [];
  for (const { id: rid } of list) {
    try {
      const c = compose(rid, { subject: subj });
      out.push({ recipe: rid, version: c.meta.version, fingerprint: c.hash, subject: subj });
    } catch (e) {
      out.push({ recipe: rid, error: String(e.message).split('\n')[0] });
    }
  }
  if (JSON_OUT) { process.stdout.write(JSON.stringify({ recipes: out }) + '\n'); return 0; }
  for (const o of out) console.log('  ' + o.recipe.padEnd(16) + (o.error ? '✖ ' + o.error : 'v' + o.version + '  ' + o.fingerprint));
  return 0;
}

/* ══════════════ 入口 ══════════════ */
function main() {
  try {
    switch (cmd) {
      case '清单': return cmdList();
      case '收件箱': return cmdInbox();
      case '找图': return cmdLocate();
      case '组装': return cmdCompose();
      case '校验': return cmdValidate();
      case '自检': return cmdSelfTest();
      case '指纹': return cmdFingerprint();
      case '':
      case '--help':
      case '-h':
        console.log([
          '拾光小册 · 配方引擎',
          '',
          '用法：',
          '  node src\\tools\\_配方.mjs 清单',
          '  node src\\tools\\_配方.mjs 收件箱 [--json]',
          '  node src\\tools\\_配方.mjs 找图 --sha <内容指纹或前12位> [--json]   （照片改名后按指纹找回那一张）',
          '  node src\\tools\\_配方.mjs 组装 --recipe <id> --subject <学科> --image <原图路径> [--out <任务.md>] [--textbook <版本>]',
          '  node src\\tools\\_配方.mjs 校验 --in <cards.json> [--recipe <id>] [--json]',
          '  node src\\tools\\_配方.mjs 自检 --recipe <id> --in <cards.json> [--json]',
          '  node src\\tools\\_配方.mjs 指纹 [--recipe <id>] [--json]',
          '',
          '本工具只读配方、只写你指定的 --out 文件，从不写入用户库。',
        ].join('\n'));
        return 0;
      default:
        console.error('未知命令：' + cmd + '　可用：清单/收件箱/找图/组装/校验/自检/指纹');
        return 2;
    }
  } catch (e) {
    console.error('✖ ' + String(e && e.message || e));
    return 2;
  }
}

process.exit(main());
