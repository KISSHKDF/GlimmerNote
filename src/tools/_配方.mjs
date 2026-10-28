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
  const batches = [];
  if (isDir(inbox)) {
    for (const name of fs.readdirSync(inbox).sort()) {
      if (name.startsWith('.') || INBOX_SKIP.has(name)) continue;
      const dir = path.join(inbox, name);
      const isB = isDir(dir);
      /* 支持两种投递：_收件箱\<批次>\*.jpg 或 _收件箱\*.jpg（不建批次也能用） */
      const scanDir = isB ? dir : inbox;
      if (!isB && !IMG_RE.test(name)) continue;
      const files = [];
      const pushFile = (abs, relBase) => {
        let st; try { st = fs.statSync(abs); } catch { return; }
        if (!st.isFile() || !IMG_RE.test(path.basename(abs))) return;
        files.push({
          name: path.basename(abs),
          rel: path.relative(root, abs).split(path.sep).join('/'),
          bytes: st.size,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
        });
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
      if (!files.length) continue;
      const bucketName = isB ? name : '（未分批）';
      let bucket = batches.find((b) => b.name === bucketName);
      if (!bucket) { bucket = { name: bucketName, files: [] }; batches.push(bucket); }
      bucket.files.push(...files);
    }
  }
  const total = batches.reduce((n, b) => n + b.files.length, 0);

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: true, root, inboxRel: '_收件箱', batches, total, created: ensured }) + '\n');
    return 0;
  }
  console.log('收件箱：' + inbox + (ensured === 'made' ? '（刚为你建好）' : ''));
  if (!total) {
    console.log('（空）把错题照片按批次放进 _收件箱\\<批次名>\\，再回到程序里选它。');
    return 0;
  }
  console.log('共 ' + batches.length + ' 批 / ' + total + ' 张待处理：');
  for (const b of batches) {
    console.log('  ▸ ' + b.name + '（' + b.files.length + ' 张）');
    for (const f of b.files) console.log('      ' + f.name + '  ' + (f.bytes / 1024).toFixed(0) + ' KB  ' + f.sha256.slice(0, 12));
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
