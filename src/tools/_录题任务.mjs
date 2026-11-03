/* 拾光小册 · 录题任务记录（本地任务绑定）
 *
 * 为什么要有它（建议书 §4「任务绑定及兼容」）：
 *   现在页面把任务单交给 AI 之后**什么都不留**——AI 回传的 JSON 只做格式校验，
 *   没人知道"这份结果对应的是哪张图、哪版配方、哪次任务"。于是"把 A 的结果贴进 B"这种错配
 *   在程序看来完全合法；而它是最危险的一类静默错误：卡会挂到错的题上，且不可回溯。
 *
 * 三层校验（对应建议书 §4 的"格式通过 / 与任务及原图匹配 / 内容已人工确认"）：
 *   ① 格式：**不在这里实现**，直接调 `_配方.mjs 校验`（唯一实现，界面与 CLI 共用同一份）；
 *   ② 匹配：信封 taskId 必须等于本地记录；卡的 sourceImageSha256 / 信封 imageSha256
 *      必须等于记录里的原图 sha（跨任务、图不一致、任务不存在都给**具体原因**）；
 *      ★ 记录**没有**原图 sha（image.sha256=null）时第二层**未覆盖**：如实打印并按不匹配
 *        给 exit 3 —— 契约对该层是无条件表述，缺 sha 就永远满足不了它（D-4：旧实现跳过却打印"通过"）。
 *   ③ 人工确认：记录里的 `confirmedAt` 只由人显式 `确认` 才写。程序不替人确认。
 *
 * 数据落点：`<库根>\_录题\<taskId>.json`（**用户数据**，随库走，走 `_安全写.mjs` 原子写）。
 *   它不是过程件——删掉它就等于删掉"这批卡当时是哪张图、哪版配方产的"。
 *
 * 退出码：0 通过/成功 · 1 格式不通过 · 2 任务不存在/用法错 · 3 与任务不匹配
 *   （旧命令 `_配方.mjs` 的 0/1/2 语义不变；3 只属于本工具）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { libraryRoot, toolPath } from './_库根.mjs';
import { writeJsonAtomic, readJsonStrict } from './_安全写.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || '';
const val = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d; };
const has = (k) => argv.includes(k);
const JSON_OUT = has('--json');

/* ★ 2026-11-03（批次 1 收尾「页面接线」）：`--data` 与 `_配方.mjs` 同口径 —— 壳显式传库根，
   不依赖环境变量继承（桌面壳起 node 子进程时 CTB_DATA 不一定在）。必须落在任何 libraryRoot()
   调用之前；ROOT() 是惰性的（见下），这里改 env 就够。
   被当库引入时（`_配方.mjs` import 本模块）没有 --data，env 由 `_配方.mjs` 自己落。 */
const explicitData = val('--data', '');
if (explicitData) process.env.CTB_DATA = path.resolve(explicitData);

/* ★ 库根**惰性**解析：本模块会被 `_配方.mjs` import，而 `_配方.mjs` 的 `--data` 是在
   模块体里（import 执行完之后）才写进 CTB_DATA 的 ⇒ 顶层就调 libraryRoot() 会解析成错的根。 */
let _root = null, _dir = null;
const ROOT = () => (_root || (_root = libraryRoot()));
const TASK_DIR = () => (_dir || (_dir = path.join(ROOT(), '_录题')));
const SCHEMA = 'glimmernote.ingest-task/v1';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowLocal = () => {
  const d = new Date(); const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset(); const sg = off >= 0 ? '+' : '-';
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' +
    p(d.getMinutes()) + ':' + p(d.getSeconds()) + sg + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
};
const stamp = () => nowLocal().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** 新任务号：时间戳 + 6 位随机（同图同配方再生成也是**两个**任务，便于"错配必须被发现"） */
export function newTaskId() {
  return 't-' + stamp() + '-' + crypto.randomBytes(3).toString('hex');
}

const taskFile = (id) => path.join(TASK_DIR(), id + '.json');

export function loadTask(id) {
  const f = taskFile(String(id || ''));
  if (!id || !fs.existsSync(f)) return null;
  return readJsonStrict(f, { shape: j => j && j.taskId === id, what: '任务记录', label: id + '.json' });
}

/** 写一条任务记录（导出给 `_配方.mjs 组装 --task` 用） */
export function createTask(rec) {
  fs.mkdirSync(TASK_DIR(), { recursive: true });
  const taskId = rec.taskId || newTaskId();
  const text = String(rec.taskText || '');
  /* ★ 2026-11-03（批次 1 收尾 · D-4）：`image.rel` 与 `image.sha256` 必须**同生同灭**。
     有 rel 没有 sha 的记录（"勾了图却没拿到 sha"）第二层永远无从核对 —— 契约 §四 对该层是
     **无条件**表述，那种记录只会产一条"永远对不上"的空壳。写入口 fail-closed。
     （`_配方.mjs 组装` 的 rel 非空必然带着算好的 sha：原图读不到时它在更早处 return 2；
       故本抛错对它是不可达路径，只挡"手工调库/新子命令"这类旁路。`新` 另有一处用法级检查，
       给的是 exit 2 + 一句话，而不是这里的一行栈。） */
  const image = rec.image || { sha256: null, rel: null };
  if (image.rel && !image.sha256) {
    throw new Error('createTask 拒绝落盘：image.rel=' + image.rel + ' 但没有 image.sha256 —— 无法对图的任务记录不许生成（D-4）');
  }
  const doc = {
    schema: SCHEMA,
    taskId,
    createdAt: nowLocal(),
    recipe: rec.recipe || null,
    cards: rec.cards || [],
    image,
    subject: rec.subject || null,
    contractDigest: rec.contractDigest || null,
    taskDigest: sha256(text),
    taskText: text,
  };
  writeJsonAtomic(taskFile(taskId), doc, { indent: 1 });
  return doc;
}

/* ---------- 新 ---------- */
function cmdNew() {
  const inFile = val('--in', '');
  if (!inFile || !fs.existsSync(path.resolve(inFile))) { console.error('用法：新 --recipe <id> --in <任务单.md> …（--in 必填且须存在）'); return 2; }
  const text = fs.readFileSync(path.resolve(inFile), 'utf8');
  const cardsRaw = val('--cards', '');
  /* ★ 2026-11-03（D-4 同族）：勾了图却没拿到 sha 的组合在**生成时**就拒掉。
     为什么要在这里再拦一次（`createTask` 已有同一条不变量）：它是**用法错**——应当给人
     一句话 + exit 2，而不是让库函数抛出的栈打在用户脸上。 */
  const imgRel = val('--image', ''), imgSha = val('--image-sha', '');
  if (imgRel && !imgSha) {
    console.error('✖ 拒绝：给了 --image（' + imgRel + '）却没给 --image-sha —— 这种任务记录的第二层永远无从核对（契约 §四 第二层是无条件的）。要么两个都给，要么两个都不给。');
    return 2;
  }
  if (imgSha && !/^[0-9a-f]{64}$/i.test(imgSha)) {
    console.error('✖ 拒绝：--image-sha 必须是原图完整 sha256（64 位十六进制），收到：' + imgSha);
    return 2;
  }
  const doc = createTask({
    recipe: { id: val('--recipe'), version: val('--recipe-ver'), fingerprint: val('--fingerprint') },
    subject: val('--subject') || null,
    image: { sha256: imgSha.toLowerCase() || null, rel: imgRel || null },
    cards: cardsRaw ? cardsRaw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [id, ver] = s.split('@'); const [packId, cardId] = id.split('/');
      return { packId: packId || null, cardId: cardId || id, version: ver || null };
    }) : [],
    contractDigest: val('--contract-digest') || null,
    taskText: text,
  });
  if (JSON_OUT) { process.stdout.write(JSON.stringify({ taskId: doc.taskId, taskDigest: doc.taskDigest }) + '\n'); return 0; }
  process.stdout.write(doc.taskId + '\n');
  process.stderr.write('已记录任务 ' + doc.taskId + '（图 ' + (doc.image.sha256 ? doc.image.sha256.slice(0, 12) + '…' : '未指定') +
    '，任务单 ' + text.length + ' 字符，摘要 ' + doc.taskDigest.slice(0, 12) + '…）\n');
  return 0;
}

/* ---------- 列 / 看 ---------- */
function allTasks() {
  if (!fs.existsSync(TASK_DIR())) return [];
  const out = [];
  for (const f of fs.readdirSync(TASK_DIR())) {
    if (!/^t-.*\.json$/.test(f)) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(TASK_DIR(), f), 'utf8')); if (j && j.taskId) out.push(j); } catch { /* 坏记录跳过（列清单不该因一条坏件整体失败） */ }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

function cmdList() {
  const limit = Number(val('--limit', '20')) || 20;
  const all = allTasks();
  const rows = all.slice(0, limit).map(j => ({
    taskId: j.taskId, createdAt: j.createdAt, recipe: (j.recipe && j.recipe.id) || null,
    subject: j.subject, image: (j.image && j.image.sha256) ? j.image.sha256.slice(0, 12) : null,
    confirmed: !!j.confirmedAt,
  }));
  if (JSON_OUT) { process.stdout.write(JSON.stringify({ total: all.length, tasks: rows }) + '\n'); return 0; }
  if (!rows.length) { console.log('（还没有任务记录；生成任务单时加 --task 才会留痕）'); return 0; }
  console.log('任务记录 ' + all.length + ' 条（最新 ' + rows.length + '）：');
  for (const r of rows) console.log('  ' + r.taskId + '  ' + (r.createdAt || '') + '  ' + (r.recipe || '?') +
    '  ' + (r.subject || '?') + '  图=' + (r.image || '(无)') + (r.confirmed ? '  ✔已确认' : ''));
  return 0;
}

function cmdShow() {
  const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : val('--task', '');
  const j = loadTask(id);
  if (!j) { console.error('任务不存在：' + (id || '(未给 taskId)')); return 2; }
  if (JSON_OUT) { process.stdout.write(JSON.stringify(j) + '\n'); return 0; }
  console.log('任务 ' + j.taskId);
  console.log('  建立时间：' + j.createdAt);
  console.log('  配方：' + ((j.recipe && j.recipe.id) || '?') + ' v' + ((j.recipe && j.recipe.version) || '?') +
    '  指纹=' + ((j.recipe && j.recipe.fingerprint) || '?'));
  console.log('  学科：' + (j.subject || '?'));
  console.log('  原图：' + ((j.image && j.image.sha256) || '(未记录)') + ((j.image && j.image.rel) ? '  ' + j.image.rel : ''));
  console.log('  卡：' + (j.cards && j.cards.length ? j.cards.map(c => (c.packId ? c.packId + '/' : '') + c.cardId + (c.version ? '@' + c.version : '')).join(', ') : '(无，仅内置配方)'));
  console.log('  契约摘要：' + (j.contractDigest || '(无)'));
  console.log('  任务单摘要：' + j.taskDigest + '（' + String(j.taskText || '').length + ' 字符，记录里留了全文）');
  console.log('  人工确认：' + (j.confirmedAt ? j.confirmedAt + (j.confirmNote ? '（' + j.confirmNote + '）' : '') : '**未确认**'));
  return 0;
}

/* ---------- 确认（第三层由人写） ---------- */
function cmdConfirm() {
  const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : val('--task', '');
  const j = loadTask(id);
  if (!j) { console.error('任务不存在：' + (id || '(未给 taskId)')); return 2; }
  j.confirmedAt = nowLocal();
  j.confirmNote = val('--note', '') || null;
  writeJsonAtomic(taskFile(j.taskId), j, { indent: 1 });
  console.log('已确认任务 ' + j.taskId + '：' + j.confirmedAt + (j.confirmNote ? '（' + j.confirmNote + '）' : ''));
  return 0;
}

/* ---------- 绑定校验（三层） ---------- */
function cmdBind() {
  const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : val('--task', '');
  const inFile = val('--in', '');
  if (!id) { console.error('用法：绑定校验 <taskId> --in <cards.json>'); return 2; }
  if (!inFile || !fs.existsSync(path.resolve(inFile))) { console.error('输入文件不存在：' + (inFile || '(未给 --in)')); return 2; }
  const rec = loadTask(id);
  if (!rec) { console.error('✖ 任务不存在：' + id + '（跨任务贴错、或任务记录被删；先跑 `列` 看有哪些任务）'); return 2; }
  const abs = path.resolve(inFile);

  let obj;
  try { obj = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error('✖ 第一层不通过：不是合法 JSON（' + e.message + '）'); return 1; }

  /* 信封：`{envelope:{schema,taskId,imageSha256}, result:{…原业务对象…}}`
     —— 外层信封携带任务身份，**不动** cards 上已设的 additionalProperties:false（建议书 §4）。 */
  const env = (obj && typeof obj === 'object' && obj.envelope && obj.result) ? obj.envelope : null;
  const result = env ? obj.result : obj;
  const reasons = [];

  /* 第一层：格式 —— 交给 `_配方.mjs 校验`（唯一实现；它自己也会剥信封） */
  const tmp = path.join(os.tmpdir(), 'gn-bind-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.json');
  fs.writeFileSync(tmp, JSON.stringify(env ? obj : result), 'utf8');
  let fmtCode = 0, fmtOut = '';
  try {
    fmtOut = execFileSync(process.execPath, [toolPath('_配方.mjs'), '校验', '--recipe', (rec.recipe && rec.recipe.id) || '', '--in', tmp, '--data', ROOT()],
      { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    fmtCode = e.status == null ? -1 : e.status;
    fmtOut = String(e.stdout || '') + String(e.stderr || '');
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* 临时件删不掉不该掩盖校验结论 */ } }

  /* 第二层：与任务及原图匹配 —— 契约 §四 对它是**无条件**表述：
     信封 taskId == 记录 taskId；信封 imageSha256 == 记录图 sha；每张卡 sourceImageSha256 == 记录图 sha。 */
  const wantSha = rec.image && rec.image.sha256 ? String(rec.image.sha256).toLowerCase() : null;
  /* ★ 2026-11-03（批次 1 收尾 · D-4 修）：记录**没有原图 sha** 时第二层无从核对。
     旧判据是 `if (wantSha && …)` ⇒ 整段静默跳过，下面却仍打印「② 通过」；diff-reviewer 实测：
     记录 image.sha256=null + 信封 64×0 + 卡 64×f ⇒ **exit 0 且"② 通过"**。那是"更宽松 + 更响亮地
     说通过"，比没有防线更坏：页面侧 `ingest.js` 把 exit 0 直接渲染成
     "✔ 绑定校验通过（① 格式 + ② 与任务及原图匹配）"，于是界面也一起说谎。
     现按契约处置：记录缺 sha ⇒ 第二层**未覆盖**，如实打印（**绝不**打印"通过"）并按**不匹配**
     给 exit 3（唯一被页面映射成"不要入库"的码 ⇒ fail-closed）。 */
  const layer2Uncovered = !wantSha;
  if (env) {
    if (String(env.taskId || '') !== rec.taskId) reasons.push('信封 taskId=' + (env.taskId || '(空)') + ' ≠ 本任务 ' + rec.taskId + '（这是**另一个任务**的结果）');
  }
  if (layer2Uncovered) {
    reasons.push('本任务记录没有原图 sha256（image.sha256=null' + ((rec.image && rec.image.rel) ? '，rel=' + rec.image.rel : '') +
      '）⇒ 第二层**无从核对**' + ((env && env.imageSha256) ? '（信封声明 imageSha256=' + String(env.imageSha256).slice(0, 12) + '… 也无从比对）' : '') +
      '；这份结果**不能当作已验证**（重新生成任务单时带上照片）');
  } else {
    if (env && env.imageSha256 && String(env.imageSha256).toLowerCase() !== wantSha) {
      reasons.push('信封 imageSha256=' + String(env.imageSha256).slice(0, 12) + '… ≠ 本任务原图 ' + wantSha.slice(0, 12) + '…');
    }
    if (Array.isArray(result.cards)) {
      result.cards.forEach((c, i) => {
        const got = c && c.sourceImageSha256 ? String(c.sourceImageSha256).toLowerCase() : null;
        if (got && got !== wantSha) reasons.push('cards[' + i + '].sourceImageSha256=' + got.slice(0, 12) + '… ≠ 本任务原图 ' + wantSha.slice(0, 12) + '…');
      });
    }
  }
  if (!env) {
    reasons.push('（提示）返回 JSON 没带信封 ⇒ 无法核对任务号，本次只核对原图 sha；旧格式仍按"仅格式校验"对待');
  }

  /* 第三层：人工确认（只读展示；确认由 `确认` 子命令写） */
  const confirmed = !!rec.confirmedAt;
  const hard = reasons.filter(r => !r.startsWith('（提示）'));
  /* layer2：pass（核对过且相符）· fail（核对过但不符）· not-covered（记录没有原图 sha，无从核对）。
     注意 not-covered 也进 hard ⇒ exit 3：**不许**把"没核对"当成"通过"。 */
  const layer2 = layer2Uncovered ? 'not-covered' : (hard.length ? 'fail' : 'pass');
  const code = fmtCode !== 0 ? 1 : (hard.length ? 3 : 0);

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      taskId: rec.taskId, format: fmtCode === 0 ? 'pass' : 'fail', formatCode: fmtCode,
      matched: hard.length === 0, layer2, confirmed, reasons, layer3: confirmed ? 'confirmed' : 'pending-human',
    }) + '\n');
    return code;
  }
  const L2_TXT = {
    'pass': '通过',
    'fail': '**不匹配**',
    'not-covered': '**未覆盖**（本任务记录没有原图 sha256 ⇒ 第二层无从核对，**不算通过**）',
  };
  console.log('绑定校验 · 任务 ' + rec.taskId);
  console.log('  ① 格式：' + (fmtCode === 0 ? '通过' : '**不通过**（exit ' + fmtCode + '）'));
  if (fmtCode !== 0) for (const line of String(fmtOut).trim().split('\n').slice(0, 20)) console.log('     ' + line);
  else console.log('     仅格式校验' + (env ? '（信封已识别）' : '（未与任务关联：返回 JSON 无信封）'));
  console.log('  ② 与任务及原图匹配：' + L2_TXT[layer2]);
  for (const r of hard) console.log('     ✖ ' + r);
  for (const r of reasons.filter(x => x.startsWith('（提示）'))) console.log('     ' + r);
  console.log('  ③ 内容已人工确认：' + (confirmed ? '已确认（' + rec.confirmedAt + '）' : '**未确认**（人看过之后再跑 `确认 ' + rec.taskId + '`）'));
  if (code === 0) console.log('  ⇒ 结论：格式与任务匹配都通过' + (confirmed ? '，且已人工确认' : '；**第三层未完成**'));
  else if (code === 1) console.log('  ⇒ 结论：格式不通过，先改 JSON');
  else if (layer2 === 'not-covered') console.log('  ⇒ 结论：第二层**未覆盖** —— 本任务记录没有原图可比，无法证明这份结果属于本次录题，**不要入库**（记录缺 image.sha256；重新生成任务单时带上照片）');
  else console.log('  ⇒ 结论：与任务不匹配（跨任务/图不一致），**不要入库**');
  return code;
}

/* ---------- 入口 ---------- */
function main() {
  switch (cmd) {
    case '新': return cmdNew();
    case '列': return cmdList();
    case '看': return cmdShow();
    case '确认': return cmdConfirm();
    case '绑定校验': return cmdBind();
    case '':
    case '--help':
    case '-h':
      console.log([
        '拾光小册 · 录题任务记录',
        '',
        '用法：',
        '  node src\\tools\\_录题任务.mjs 新 --recipe <id> --recipe-ver <v> --fingerprint <h> --subject <学科> --in <任务单.md>',
        '                                [--image <库内相对路径>] [--image-sha <64hex>] [--contract-digest <h>] [--cards <包/卡@版本,…>]',
        '  node src\\tools\\_录题任务.mjs 列 [--limit N] [--json]',
        '  node src\\tools\\_录题任务.mjs 看 <taskId> [--json]',
        '  node src\\tools\\_录题任务.mjs 确认 <taskId> [--note <一句话>]        # 第三层：由人写',
        '  node src\\tools\\_录题任务.mjs 绑定校验 <taskId> --in <cards.json> [--json]',
        '',
        '通用参数：--data <库根>（与 _配方.mjs 同口径；不传则读 CTB_DATA 环境变量）',
        '退出码：0 通过/成功 · 1 格式不通过 · 2 任务不存在或用法错 · 3 与任务不匹配',
        '记录落点：<库根>\\_录题\\<taskId>.json（用户数据，随库走）',
      ].join('\n'));
      return 0;
    default:
      console.error('未知命令：' + cmd + '　可用：新/列/看/确认/绑定校验');
      return 2;
  }
}

/* 只有被当脚本跑时才执行入口：本模块同时被 `_配方.mjs` import（导出 createTask/newTaskId）。 */
const __isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (__isMain) process.exit(main());
