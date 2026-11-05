/* 拾光小册 · 录题入库（把校验通过的 cards.json 落成真错题卡）
 *
 * 为什么要有它（2026-11-04 实测）：
 *   录题页（`src\app\js\views\ingest.js`）三段式走完只能到「校验通过 + 人工确认」，
 *   页面自己写着「本页不落库」——**因为仓内没有任何东西能把 JSON 变成卡**。
 *   实测后果：2026-11-04 19:36 那次录题，任务记录 `t-20261104-193617-a063bc.json`
 *   的 `cards` 是**空数组**（校验用的 JSON 只在页面上过了一遍，从没存进记录），
 *   库里**零张新卡**。用户点完「确认本任务」什么也没发生。
 *
 *   历史真相：所有入库都是**仓外一次性脚本**做的（如 `work\kk-math-20261101\land.mjs`），
 *   而且那脚本连三道门禁都只是**打印命令让人手跑** ⇒ 落库瞬间 `blindStatus='未盲解'`、
 *   `answerMode/answerSlots` 缺失，是事后手工补的。本工具把这条链**收进仓内**。
 *
 * 它做什么（**只做这五件事**，其余一律不碰）：
 *   ① 校验入库前置条件（任务已确认 / 信封匹配 / 学生·学科落点存在 / 契约字段齐）
 *   ② 写卡目录四件套：`题干.html` / `错题记录.md` / `原卷截图.jpg` / `_裁图记录.json`
 *   ③ 往学科 `_索引.json` 的 `items[]` 追加条目（**answerMode/answerSlots 不在这里写** —— 红线）
 *   ④ **当场**跑四道门禁（作答契约 / 配图 / 原卷溯源 / 盲解清稿），不留"事后手跑"的欠账
 *   ⑤ 把 AI 回传的 cards 写回任务记录的 `cards[]`（让"确认"确认的是真东西，不是空盒子）
 *
 * 退出码（与 `docs\录题任务契约.md` §五同口径）：
 *   0 成功 · 1 入库前置不通过（格式/契约/门禁） · 2 用法错/任务不存在 · 3 与任务不匹配
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { libraryRoot, toolPath } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic, acquireLibLock, openTransaction } from './_安全写.mjs';
import { procPath } from './_过程目录.mjs';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';
import { extractJsonText } from './_配方.mjs';
import { slotCount } from './_空位.mjs';
import { displaySize } from './_图尺寸.mjs';

/* ───────────────── 参数 ───────────────── */
const { action: _cmd, opt, positional } = parseArgs(process.argv.slice(2), {
  valueFlags: [...COMMON_VALUE_FLAGS, 'task', 'file', 'student', 'grade', 'slots', 'note', 'date', 'reason'],
  /* ★ 2026-11-05（PR #13 复审 ①）：写盘工具一律严格模式 —— 拼错的开关（如 --dryy）当场报错，绝不静默丢弃后真写盘。
     清单 = 本文件用到的布尔开关（机扫 opt.x / val('x') 后人工核对），新增开关必须同步加进来，否则会被拒。 */
  boolFlags: ['dry', 'json', 'help', 'h'],
});
const cmd = _cmd || '';
const val = (k, d = '') => { const v = opt[k]; return (v === undefined || v === true) ? d : v; };
const JSON_OUT = !!opt.json;
const DRY = !!opt.dry;

/* ───────────────── 库根 ─────────────────
 * `--data` 必须在任何 libraryRoot() 之前落 env（壳显式传库根，不靠环境变量继承）。 */
const explicitData = val('data', '');
if (explicitData) process.env.CTB_DATA = path.resolve(explicitData);
let _root = null;
const ROOT = () => (_root || (_root = libraryRoot()));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** 老师红笔与采用答案是否冲突（去空白、全半角归一后比；老师没写 ⇒ 不算冲突） */
const normAns = v => String(v || '').normalize('NFKC').replace(/\s+/g, '');
const teacherConflictOf = c => typeof c.teacherAnswer === 'string' && c.teacherAnswer.trim() !== '' && normAns(c.teacherAnswer) !== normAns(c.answer);
const dstr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => dstr();

function fail(msg, code = 1) {
  console.error('✖ ' + msg);
  return code;
}

/* ───────────────── 任务记录 ───────────────── */
function taskDir() { return path.join(ROOT(), '_录题'); }
function taskFile(id) { return path.join(taskDir(), id + '.json'); }

function loadTask(id) {
  if (!id || !/^t-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id)) return { why: '任务号形状不对（应为 t-YYYYMMDD-HHmmss-6位hex）' };
  const f = taskFile(id);
  if (!fs.existsSync(f)) return { why: '任务不存在：' + id + '（任务记录被删？先跑 `_录题任务.mjs 列` 看有哪些任务）' };
  try {
    const j = readJsonStrict(f, { shape: x => x && x.taskId === id, what: '任务记录', label: id + '.json' });
    return { task: j };
  } catch (e) {
    return { why: '任务记录读不动：' + String(e && e.message || e) };
  }
}

/* ───────────────── 学生·学科落点 ─────────────────
 * 索引有两种形态（`生成状态.mjs:156-158` 是既有判据）：
 *   ① 单学科：{student, grade, subject:'数学', items:[]}      文件在 库\<年级>-<学生>\数学\_索引.json
 *   ② 多学科：{student, grade, subjects:{ 数学:{items:[]} }}  文件在 库\九年级\_索引.json
 * 落点查找：先按「学生+学科」精确找索引文件，再决定卡目录挂在哪。 */
function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    /* ⚠ 目录名以 `_`/`.` 开头 ⇒ 跳过**目录**；但**文件**要单独判 `_索引.json`
       （否则 `_索引.json` 自己被 `_` 前缀规则挡掉 ⇒ 一个学生都找不到）。
       判据与 `_盲解复核.mjs:168-176` 逐字同口径。 */
    if (!e.isDirectory()) { if (e.name === '_索引.json') acc.push(path.join(dir, e.name)); continue; }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    indexFiles(path.join(dir, e.name), acc);
  }
  return acc;
}

function readIdx(p) {
  return readJsonStrict(p, {
    shape: j => Array.isArray(j.items) || (!!j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects)),
    what: 'items 数组或 subjects 对象', label: path.basename(p),
  });
}

/** 找「学生+学科」的落点：返回 {idxFile, idx, subject, dirAbs, itemsOwner} */
function findTarget(student, subject) {
  const root = ROOT();
  const files = indexFiles(root);
  const multi = [];
  const single = [];
  for (const f of files) {
    let j;
    try { j = readIdx(f); } catch { continue; }
    if (String(j.student || '') !== student) continue;
    if (j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects)) multi.push({ f, j });
    else if (String(j.subject || '') === subject) single.push({ f, j });
  }
  if (single.length === 1) {
    const { f, j } = single[0];
    return { idxFile: f, idx: j, subject, dirAbs: path.dirname(f), owner: 'single' };
  }
  if (single.length > 1) return { why: '学生 ' + student + ' 的「' + subject + '」有多个索引文件（' + single.map(x => path.basename(path.dirname(x.f))).join('、') + '）——请先合并成一个' };
  if (multi.length === 1) {
    const { f, j } = multi[0];
    const v = j.subjects[subject];
    if (!v) return { why: '学生 ' + student + ' 的索引里没有学科「' + subject + '」这一节（现有：' + Object.keys(j.subjects).join('、') + '）' };
    return { idxFile: f, idx: j, subject, dirAbs: path.join(path.dirname(f), subject), owner: 'multi', subjNode: v };
  }
  if (multi.length > 1) return { why: '学生 ' + student + ' 有多个索引文件（' + multi.map(x => path.basename(x.f)).join('、') + '）——请先合并成一个' };
  const names = [];
  for (const f of files) { try { const j = readIdx(f); if (j.student) names.push(j.student); } catch { } }
  return { why: '库里没有学生「' + student + '」的索引（现有学生：' + [...new Set(names)].join('、') + '）——先用「新建学生」建好，或用 --student 指定正确的化名' };
}

/** 该学科下一张卡的编号：M0142…（前缀按学科首字母，与既有库一致） */
const PREFIX_OF = { 数学: 'M', 语文: 'Y', 英语: 'E', 物理: 'P', 化学: 'C', 生物: 'B', 历史: 'H', 地理: 'G', 政治: 'Z' };
function nextId(subject, items) {
  const p = PREFIX_OF[subject] || 'M';
  let max = 0;
  for (const it of items) {
    const m = new RegExp('^' + p + '(\\d+)$').exec(String(it.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return p + String(max + 1).padStart(4, '0');
}

/** 卡目录名：<编号>-<标题>（标题里的路径非法字符换成 '-'，长度截断） */
function dirNameOf(id, title) {
  const safe = String(title || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 24);
  return safe ? id + '-' + safe : id;
}

/* ───────────────── 原图 ───────────────── */
/** 任务记录里的原图在库内的绝对路径（rel 是库内相对路径） */
function imageAbs(task) {
  const rel = task && task.image && task.image.rel;
  if (!rel) return null;
  const abs = path.resolve(ROOT(), rel);
  const rootAbs = path.resolve(ROOT());
  if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) return null;   // 越出库根 ⇒ 不认
  return fs.existsSync(abs) ? abs : null;
}

/* ───────────────── 题干 HTML ─────────────────
 * 题干.html 必须是 `<div class="stem">…</div>`（既有卡的形态，见 `生成状态.mjs:173` 与
 * `_作答门禁.mjs` 的 stem 解析）。AI 给的是纯文本 `questionText`，这里做**最小**包装：
 * 段落按换行切，空位用 `<span class="blank">` 标出（横线题需要它才能算空位数）。 */
function buildStemHtml(text, hasBlank) {
  const paras = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const body = paras.length ? paras.map(p => '<p class="stem-lead">' + escapeHtml(p) + '</p>').join('\n  ')
    : '<p class="stem-lead">（题干为空）</p>';
  const inner = hasBlank ? body.replace(/_{3,}|＿{2,}/g, '<span class="blank" style="min-width:7em"></span>') : body;
  return '<div class="stem">\n  ' + inner + '\n</div>\n';
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ───────────────── 错题记录.md ───────────────── */
function buildRecord(id, c, meta) {
  const L = [];
  L.push('# ' + id + ' · ' + c.title + '（' + c.causeCode + '）');
  L.push('');
  L.push('**来源**：' + (c.source || '（未填）') + ' ｜ **难度**：' + (c.difficulty || '中') + ' ｜ **错因**：' + c.causeCode + ' ' + (c.causeNote || ''));
  L.push('');
  L.push('## 原题');
  L.push('');
  L.push(String(c.questionText || '').replace(/\n/g, '　'));
  L.push('');
  L.push('## 孩子的错解（黑笔，原样保留在原卷截图.jpg）');
  L.push('');
  L.push(String(c.studentAnswer || '').replace(/\n/g, '　'));
  L.push('');
  L.push('## 错在哪一步');
  L.push('');
  L.push(String(c.causeNote || '（未填）'));
  L.push('');
  L.push('## 正确答案');
  L.push('');
  L.push('**' + String(c.answer || '（未能确认）') + '**');
  L.push('');
  if (c.answerSourceNote) {
    L.push('> 答案来源：' + c.answerSource + ' —— ' + c.answerSourceNote);
    L.push('');
  }
  /* ★ 2026-11-05（PR #13 复审 ③）：老师红笔写出的答案随卡落盘（修前只在入库那一刻比对，之后就丢了） */
  if (typeof c.teacherAnswer === 'string') {
    L.push('> 老师红笔：' + (c.teacherAnswer ? c.teacherAnswer : '（老师没写出正确答案）') +
      (meta.teacherConflict ? ' ⚠ 与采用答案不一致，组卷前须裁决（`_标记复习.mjs 异议裁决`）' : ''));
    L.push('');
  }
  if (c.notes) {
    L.push('## 转录注');
    L.push('');
    L.push(c.notes);
    L.push('');
  }
  L.push('> 判定来源：录题入库（配方 ' + (meta.recipe || '?') + ' v' + (meta.recipeVer || '?') + ' · 指纹 ' + (meta.fingerprint || '?') + '）');
  L.push('> 原图：' + (meta.imageRel || '（未指定）') + '（sha256 ' + ((meta.imageSha || '').slice(0, 12) || '—') + '…）');
  L.push('> 任务号：' + (meta.taskId || '—') + ' ｜ 入库日期：' + (meta.date || today()));
  L.push('');
  return L.join('\n');
}

/* ───────────────── 裁图 ─────────────────
 * 裁图用 **Windows 自带的 System.Drawing**（PowerShell 一行脚本，零外部依赖）。
 * 坐标一律**归一化 0~1**（`docs\区域契约.md` §三：坐标只以归一化落库），
 * 由原图的**显示尺寸**换算成像素（JPEG 的 EXIF 方向已由 `_图尺寸.mjs::displaySize` 处理）。
 *
 * ⚠ 脚本落**临时文件**再执行，不用 `-Command` 内联拼字符串 ——
 *   内联拼接时路径里的引号/反斜杠要手工转义，是"看起来对、偶发失败"的那类坑。
 *   临时脚本按 §四 ④ 临时件处理：finally 里删。 */
const CROP_PS = [
  'param([string]$Src,[string]$Out,[double]$X,[double]$Y,[double]$W,[double]$H,[int]$MaxW)',
  'Add-Type -AssemblyName System.Drawing',
  '$img=[System.Drawing.Image]::FromFile($Src)',
  '$sw=$img.Width; $sh=$img.Height',
  '$rx=[int]([math]::Round($X*$sw)); $ry=[int]([math]::Round($Y*$sh))',
  '$rw=[int]([math]::Round($W*$sw)); $rh=[int]([math]::Round($H*$sh))',
  'if($rx -lt 0){$rx=0}; if($ry -lt 0){$ry=0}',
  'if($rx+$rw -gt $sw){$rw=$sw-$rx}; if($ry+$rh -gt $sh){$rh=$sh-$ry}',
  'if($rw -lt 1){$rw=1}; if($rh -lt 1){$rh=1}',
  '$ow=$rw; $oh=$rh',
  'if($MaxW -gt 0 -and $ow -gt $MaxW){ $k=$MaxW/$ow; $ow=$MaxW; $oh=[int]([math]::Round($oh*$k)) }',
  'if($ow -lt 1){$ow=1}; if($oh -lt 1){$oh=1}',
  '$bmp=New-Object System.Drawing.Bitmap($ow,$oh)',
  '$g=[System.Drawing.Graphics]::FromImage($bmp)',
  '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '$g.DrawImage($img,(New-Object System.Drawing.Rectangle(0,0,$ow,$oh)),(New-Object System.Drawing.Rectangle($rx,$ry,$rw,$rh)),[System.Drawing.GraphicsUnit]::Pixel)',
  '$g.Dispose()',
  '$bmp.Save($Out,[System.Drawing.Imaging.ImageFormat]::Jpeg)',
  '$bmp.Dispose(); $img.Dispose()',
].join("\r\n");

function cropWithDotnet(src, out, nx, ny, nw, nh, maxW) {
  const tmp = path.join(os.tmpdir(), 'gn-crop-' + process.pid + '-' + Date.now() + '.ps1');
  try {
    /* ⚠ PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解码 ⇒ 脚本必须带 BOM（AGENTS.md 红线7）。 */
    fs.writeFileSync(tmp, '﻿' + CROP_PS, 'utf8');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp,
      '-Src', src, '-Out', out,
      '-X', String(nx), '-Y', String(ny), '-W', String(nw), '-H', String(nh),
      '-MaxW', String(maxW)], { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
  }
}

/* ───────────────── 主流程：入库 ───────────────── */
function cmdLand() {
  const taskId = positional[0] || val('task', '');
  const file = val('file', '') || val('in', '');
  const student = val('student', '');
  const subject = val('subject', '') || val('grade', '');
  const note = val('note', '');

  /* ① 用法检查 */
  if (!taskId) return fail('用法：入库 <taskId> --file <cards.json> --student <学生> [--subject <学科>] [--dry]', 2);
  if (!file || !fs.existsSync(path.resolve(file))) return fail('用法：入库 <taskId> --file <cards.json>（--file 必填且须存在）', 2);
  if (!student) return fail('入库必须指定 --student <学生化名>（卡要挂在谁名下——程序不猜）', 2);

  const lt = loadTask(taskId);
  if (lt.why) return fail(lt.why, 2);
  const task = lt.task;

  /* ② 第三层：人工确认。**没确认不许入库** —— 这是契约 §四 第③层。 */
  if (!task.confirmedAt) {
    return fail('任务 ' + taskId + ' 还没经人工确认（第三层未完成）——先在录题页点「✍ 确认本任务」，或跑 `_录题任务.mjs 确认 ' + taskId + '`，再入库', 1);
  }

  /* ③ 抽 JSON（容错抽取的唯一实现；`extractJsonText` 返回 {ok,value,how,text}） */
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  const ex = extractJsonText(raw);
  if (!ex || !ex.ok) {
    return fail('回传内容不是合法 JSON：' + String((ex && ex.error && ex.error.message) || '抽取不到 JSON 对象'), 1);
  }
  const obj = ex.value;
  if (ex.how === 'braces') console.log('输入：JSON 外裹了说明文字（已按首个 { 到最后一个 } 抽取）');

  /* ④ 信封：跨任务贴错必须在这里被拦下（exit 3） */
  let result = obj;
  if (obj && typeof obj === 'object' && 'envelope' in obj) {
    const env = obj.envelope;
    if (!env || typeof env !== 'object') return fail('信封畸形：envelope 必须是对象', 1);
    if (!obj.result || typeof obj.result !== 'object') return fail('信封畸形：返回 JSON 的信封不完整：缺 result（信封必须形如 {envelope:{…}, result:{…}}）', 1);
    if (String(env.taskId || '') !== taskId) {
      return fail('与任务不匹配：信封里的 taskId=' + (env.taskId || '(空)') + '，与本次入库的任务 ' + taskId + ' 不符——不要入库（跨任务贴错）', 3);
    }
    const imgSha = task.image && task.image.sha256;
    if (imgSha && String(env.imageSha256 || '').toLowerCase() !== String(imgSha).toLowerCase()) {
      return fail('与任务不匹配：信封里的 imageSha256=' + (env.imageSha256 || '(空)') + '，与任务记录的原图 sha 不符——不要入库', 3);
    }
    result = obj.result;
  }

  const cards = Array.isArray(result.cards) ? result.cards : [];
  if (!cards.length) return fail('回传内容里没有 cards（无可入库的卡）', 1);

  /* ⑤ 每张卡的 sourceImageSha256 必须等于任务记录的原图 sha */
  const imgSha = task.image && task.image.sha256;
  if (!imgSha) return fail('任务记录没有原图 sha（image.sha256 为空）——第二层无从核对，不许入库（契约 §四 第②层）', 3);
  for (const c of cards) {
    if (String(c.sourceImageSha256 || '').toLowerCase() !== String(imgSha).toLowerCase()) {
      return fail('与任务不匹配：卡「' + (c.title || '?') + '」的 sourceImageSha256=' + String(c.sourceImageSha256 || '(空)').slice(0, 12) + '… 与任务记录的原图 sha 不符——不要入库', 3);
    }
  }

  /* ⑥ 找落点 */
  const subj = subject || task.subject || (cards[0] && cards[0].subject) || '';
  if (!subj) return fail('不知道学科：请给 --subject（或在任务单里留了学科）', 2);
  const tgt = findTarget(student, subj);
  if (tgt.why) return fail(tgt.why, 2);

  const itemsOwner = tgt.owner === 'multi' ? tgt.subjNode.items : tgt.idx.items;
  if (!Array.isArray(itemsOwner)) return fail('索引 ' + path.basename(tgt.idxFile) + ' 的 items 不是数组（形状异常，拒绝写入）', 2);

  /* ⑦ 规划卡号（先规划再写，避免半批写坏）
     ⚠ **幂等**（2026-11-04）：同一个任务重复跑入库**不许**造出第二张同样的卡。
        否则用户点两次「建卡入库」⇒ 库里两张一样的错题 ⇒ 复习池里同一个错误被算两次
        （这正是配方反例 B-07「同一道题拆成两条」要防的后果，只是换了个入口）。
        判据：任务记录里的 `landedCardIds` + `landedDigest`。
          · `landedDigest` = 本次入库内容的 sha256（不含卡号）；
          · 记录里已有同一个 digest ⇒ **幂等跳过**，回 exit 0 并点名"已入库过"；
          · digest 不同（内容改了）⇒ 那是**新内容**，正常入库。
        卡号规划本身也从"库里最大号+1"起，所以即使 digest 变了也不会撞号。 */
  const plan = [];
  const usedIds = new Set(itemsOwner.map(i => String(i.id)));
  let nextIdCur = nextId(subj, itemsOwner);
  for (const c of cards) {
    let id = nextIdCur;
    let n = Number((/(\d+)$/.exec(id) || [0, 0])[1]);
    while (usedIds.has(id)) { n += 1; id = PREFIX_OF[subj] + String(n).padStart(4, '0'); }
    usedIds.add(id);
    nextIdCur = PREFIX_OF[subj] + String(n + 1).padStart(4, '0');
    plan.push({ id, c });
  }

  /* ⑧ 契约字段检查（缺一项就点名，不静默补） */
  const need = ['subject', 'title', 'questionText', 'studentAnswer', 'answerSource', 'causeCode', 'confidence', 'sourceImageSha256'];
  const problems = [];
  for (const { id, c } of plan) {
    for (const k of need) {
      if (c[k] === undefined || c[k] === null || c[k] === '') problems.push(id + ' 缺必填字段「' + k + '」');
    }
    if (c.answerSource && !['独立判卷', '老师定案', '官方答案', '红笔订正+官方答案页核对', '未能确认'].includes(c.answerSource)) {
      problems.push(id + ' 的 answerSource 取值不在契约内：' + c.answerSource);
    }
    /* ★ 2026-11-05（合并评审 P1-6 → PR #13 复审 ③ 收紧）：官方答案不得悄悄覆盖老师红笔。
       ① 答案来源含"官方答案"的卡，**必须声明** teacherAnswer（老师没写出正确答案就填空串）——
          修前漏填即全盲：比对只在"已填"时发生。
       ② 已填且与采用答案不一致：notes 没交代 ⇒ 拒；交代了 ⇒ 放行入库，但卡上挂 teacherConflict，
          组卷准入把它挡在池外，直到 `_标记复习.mjs 异议裁决` 人工裁决（修前"写一句话就放行、不挂待复核"）。 */
    if (/官方答案/.test(String(c.answerSource || ''))) {
      if (typeof c.teacherAnswer !== 'string') {
        problems.push(id + ' 的 answerSource=' + c.answerSource + '，但没有声明 teacherAnswer —— 照片上老师写了正确答案就原样填，没写就填空串 ""（不许省略：省略等于让"官方答案覆盖老师"这条检查失明）');
      } else if (teacherConflictOf(c)) {
        if (!/老师红笔不一致|与老师.*不一致/.test(String(c.notes || '') + String(c.answerSourceNote || ''))) {
          problems.push(id + ' 的 answerSource=' + c.answerSource + '，但答案（' + c.answer + '）与老师红笔（' + c.teacherAnswer + '）不一致且未交代分歧 —— ' +
            '老师批改不能被站点答案悄悄覆盖：独立解法裁决后改成 老师定案 / 未能确认，或在 notes 写明"与老师红笔不一致：…"（入库后仍须 异议裁决 才能组卷）');
        }
      }
    }
    if (c.causeCode && !/^[KLS][1-7]$/.test(String(c.causeCode))) problems.push(id + ' 的 causeCode 非法：' + c.causeCode);
    if (c.confidence && !['high', 'medium', 'low'].includes(c.confidence)) problems.push(id + ' 的 confidence 非法：' + c.confidence);
    if (c.subject && c.subject !== subj) problems.push(id + ' 的 subject（' + c.subject + '）与本次入库的学科（' + subj + '）不符');
    if (c.bbox !== undefined) {
      const b = c.bbox;
      if (!Array.isArray(b) || b.length !== 4 || b.some(v => typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1)) {
        problems.push(id + ' 的 bbox 必须是 4 个 0~1 的数字（归一化 [x,y,w,h]），收到：' + JSON.stringify(b));
      } else if (b[0] + b[2] > 1.001 || b[1] + b[3] > 1.001) {
        problems.push(id + ' 的 bbox 越界：x+w=' + (b[0] + b[2]).toFixed(4) + '，y+h=' + (b[1] + b[3]).toFixed(4) + '（都应 ≤ 1）');
      }
    }
  }
  if (problems.length) {
    for (const p of problems) console.error('  - ' + p);
    return fail('入库前置检查不通过（' + problems.length + ' 条）——未写任何文件', 1);
  }

  /* ⑨ 幂等判定（内容摘要不含卡号 ⇒ 同一份内容重跑必得同一个摘要） */
  const digest = sha256(JSON.stringify(cards.map(c => ({
    subject: c.subject, title: c.title, source: c.source, sourceDate: c.sourceDate,
    questionText: c.questionText, studentAnswer: c.studentAnswer, answer: c.answer,
    answerSource: c.answerSource, answerSourceNote: c.answerSourceNote,
    causeCode: c.causeCode, causeNote: c.causeNote, kpoints: c.kpoints,
    difficulty: c.difficulty, hasFigure: c.hasFigure, confidence: c.confidence,
    sourceImageSha256: c.sourceImageSha256, notes: c.notes, bbox: c.bbox,
    answerMode: c.answerMode, answerSlots: c.answerSlots,
    teacherAnswer: c.teacherAnswer,   // ★ 2026-11-05（PR #13 复审 ③）：改了老师红笔重提，必须被当成新内容，不许幂等跳过
  }))));
  if (task.landedDigest && task.landedDigest === digest && Array.isArray(task.landedCardIds) && task.landedCardIds.length) {
    console.log('✔ 已入库过（幂等跳过）——任务 ' + taskId + ' 的这批内容已经进库：' + task.landedCardIds.join('、'));
    console.log('  重复提交不会造出第二张一样的卡（同一道题被算两次是复习池里最坏的一种错）。');
    return 0;
  }

  const srcImg = imageAbs(task);
  if (!srcImg) {
    console.error('⚠ 找不到原图（' + (task.image && task.image.rel) + '）——卡会入库，但**没有**原卷截图，也无法登记溯源。');
    console.error('  原图缺失时：_原卷台账 会少一条溯源；这不拦入库（卡面内容已经齐了），但请把原图补回库内再重跑一次溯源登记。');
  }

  /* ⑨ 写盘（锁 + 事务）
     ★ 2026-11-05（复核 P0-3）：修前这里注释写"锁 + 事务"，代码只拿了锁（withLibWrite 被 import 却没用）。
       建卡目录 → 题干.html → 裁图 → _裁图记录.json → 错题记录.md → 索引 → 任务记录 是**跨文件**写，
       中途任何一步抛错（磁盘满 / 占用 / 索引写失败）都会留下半张卡，而幂等锚 landedDigest 最后才写，
       重跑会撞上残留目录。现在整段进 openTransaction：失败整体回滚（含新建的空卡目录）。
       --dry 也改成**真预演**：全部写完后整体回滚，库里不留任何东西（修前 --dry 照样写盘）。
       门禁子进程放在 commit **之后**跑：子工具继承锁、会开自己的事务，同一个 journal 不能有两个主人。 */
  const root = ROOT();
  const release = acquireLibLock(root, { label: '_录题入库' });
  let tx = null;
  try {
    tx = openTransaction(root, { label: '_录题入库 ' + taskId });
    const made = [];
    const figs = [];
    const answers = [];
    for (const { id, c } of plan) {
      const dn = dirNameOf(id, c.title);
      const abs = path.join(tgt.dirAbs, dn);
      tx.mkdir(abs);

      /* 题干.html */
      const hasBlank = /_{3,}|＿{2,}/.test(String(c.questionText || '')) || (Array.isArray(c.answerSlots) && c.answerSlots.length > 0);
      const html = buildStemHtml(c.questionText, hasBlank);
      tx.writeText(path.join(abs, '题干.html'), html);

      /* 原卷截图（AI 给了 bbox 才裁；没给就不裁，明确报出来） */
      let cropped = null;
      if (srcImg && Array.isArray(c.bbox)) {
        try {
          const ds = displaySize(srcImg);
          if (!ds || !ds.w || !ds.h) throw new Error('读不出原图尺寸（格式不支持或文件损坏）');
          const [nx, ny, nw, nh] = c.bbox;
          tx.snapshot(path.join(abs, '原卷截图.jpg'));   // 先登记：回滚时新图删掉、旧图恢复
          cropWithDotnet(srcImg, path.join(abs, '原卷截图.jpg'), nx, ny, nw, nh, 1400);
          const px = [Math.round(nx * ds.w), Math.round(ny * ds.h), Math.max(1, Math.round(nw * ds.w)), Math.max(1, Math.round(nh * ds.h))];
          cropped = { out: '原卷截图.jpg', box: [nx, ny, nw, nh], px, srcPx: { w: ds.w, h: ds.h } };
        } catch (e) {
          console.error('⚠ ' + id + ' 裁图失败（不影响入库）：' + String(e && e.message || e).slice(0, 160));
        }
      }

      /* _裁图记录.json（原卷溯源的唯一 sidecar，`_原卷台账.mjs` 只认它） */
      if (cropped) {
        tx.writeJson(path.join(abs, '_裁图记录.json'), {
          src: task.image.rel, out: cropped.out, normBox: cropped.box, cropPx: cropped.px,
          srcPx: cropped.srcPx, scale: 1, by: '录题入库:' + taskId, date: today(),
          note: c.source || '',
        }, { newline: true });
      }

      /* 错题记录.md */
      tx.writeText(path.join(abs, '错题记录.md'), buildRecord(id, c, {
        recipe: task.recipe && task.recipe.id, recipeVer: task.recipe && task.recipe.version,
        fingerprint: task.recipe && task.recipe.fingerprint,
        imageRel: task.image && task.image.rel, imageSha: task.image && task.image.sha256,
        taskId, date: today(), teacherConflict: teacherConflictOf(c),
      }));

      /* 索引条目（**不含** answerMode/answerSlots —— 红线：只能由 `_作答门禁.mjs` 写） */
      if (!usedIds.has(id) || !itemsOwner.some(i => String(i.id) === id)) {
        const it = {
          id, dir: dn,
          source: c.source || '', sourceDate: c.sourceDate || '',
          type: c.type || '（未填）',
          question: String(c.questionText || '').replace(/\s+/g, ' ').trim(),
          answer: c.answer || '',
          studentAnswer: c.studentAnswer || '',
          kpoints: Array.isArray(c.kpoints) ? c.kpoints : [],
          causeLayer: String(c.causeCode || '')[0] || '',
          causeCode: c.causeCode || '',
          causeDesc: c.causeNote || '',
          causeConfirmed: false,
          difficulty: c.difficulty || '中',
          errorCount: 1, status: '在册',
          hasImage: !!cropped, hasVariants: false,
          reviews: [], reviewStatus: '未复习', reviewCount: 0, passStreak: 0,
          lastReviewedAt: '', nextDue: '', masteredAt: null,
          blindStatus: '未盲解', blindSolveAt: '', blindSolver: '', blindNote: '', blindFingerprint: '',
          answerSource: c.answerSource || '未能确认',
          answerSourceNote: c.answerSourceNote || '',
          /* ★ 2026-11-05（PR #13 复审 ③）：老师红笔进索引；冲突挂 teacherConflict，组卷准入据此拦（见 _标记复习 准入） */
          teacherAnswer: typeof c.teacherAnswer === 'string' ? c.teacherAnswer : '',
          teacherConflict: teacherConflictOf(c) ? { teacher: c.teacherAnswer, adopted: c.answer || '', source: c.answerSource, note: String(c.notes || '').slice(0, 300), at: today() } : null,
          answerNote: c.answerNote || '',
        };
        itemsOwner.push(it);
      }

      figs.push({
        card: student + '|' + id, need: !!c.hasFigure, kind: c.hasFigure ? 'svg' : 'none',
        ref: c.hasFigure ? '题干.html 内联 SVG' : true,
        note: c.notes || (c.hasFigure ? '题干含图，随题干.html 内联印刷' : '纯文字题，原卷无印刷配图'),
        by: '录题入库:' + taskId, date: today(),
      });
      if (c.answerMode) {
        answers.push({ card: student + '|' + id, mode: c.answerMode, slots: Array.isArray(c.answerSlots) ? c.answerSlots : [], scope: c.answerScope || 'full' });
      }
      made.push({ id, dir: dn, cropped: !!cropped });
    }

    /* 写索引（原子写） */
    tgt.idx.updatedAt = today();
    tx.writeJson(tgt.idxFile, tgt.idx, { backup: !DRY, newline: true });   // --dry 不留备份件（真预演 = 库里零新增）

    /* 把回传的 cards 写回任务记录（让"确认"确认的是真东西） */
    const tj = JSON.parse(fs.readFileSync(taskFile(taskId), 'utf8'));
    tj.cards = cards;
    tj.landedAt = today();
    tj.landedCardIds = made.map(m => m.id);
    tj.landedDigest = digest;              /* 幂等锚：同一份内容重跑 ⇒ 同一个摘要 ⇒ 跳过 */
    tx.writeJson(taskFile(taskId), tj, { indent: 1 });

    if (DRY) {
      const r = tx.rollback();
      tx = null;
      if (r && r.failed && r.failed.length) {
        console.error('✖ --dry 预演后回滚未完成（事务日志已保留，下次取锁会重试）：' + r.failed.join('；'));
        return 1;
      }
      console.log('--dry：已预演 ' + made.length + ' 张卡（' + made.map(m => m.id).join('、') + '），已整体回滚，库未改动');
      return 0;
    }
    tx.commit();
    tx = null;

    /* 门禁声明文件（放过程目录，不落库根 —— 过程文件规范 §三）
       ★ 2026-11-05（复核 P2-7）：改走 `_过程目录.mjs` 的唯一实现。修前自己拼
       `LOCALAPPDATA || ''` ⇒ 变量缺失时是**相对路径**，会在当前工作目录（可能就是库根）下建目录。 */
    const figFile = procPath('录题入库-配图-' + taskId + '.json');
    const ansFile = procPath('录题入库-作答-' + taskId + '.json');
    writeJsonAtomic(figFile, figs, { newline: true });
    if (answers.length) writeJsonAtomic(ansFile, answers, { newline: true });

    /* ⑩ 当场跑门禁（不留"事后手跑"的欠账） */
    const gates = [];
    const runGate = (label, args) => {
      try {
        const r = execFileSync('node', [toolPath('_作答门禁.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CTB_DATA: root } });
        gates.push({ label, ok: true, out: String(r || '').trim() });
      } catch (e) {
        const msg = String((e && e.stdout) || '') + String((e && e.stderr) || '');
        gates.push({ label, ok: false, out: msg.trim(), code: e && e.status });
      }
    };
    if (answers.length) {
      runGate('作答契约门禁', ['批量', '--file', ansFile]);
    }
    runGate('配图门禁', ['批量', '--file', figFile]);
    /* 原卷溯源：只对**有裁图**的卡跑（有裁图的卡才有 sidecar） */
    if (made.some(m => m.cropped)) {
      try {
        execFileSync('node', [toolPath('_原卷台账.mjs'), '生成'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CTB_DATA: root } });
        gates.push({ label: '原卷溯源台账', ok: true, out: '已从 _裁图记录.json 折入' });
      } catch (e) {
        gates.push({ label: '原卷溯源台账', ok: false, out: String((e && e.stdout) || '') + String((e && e.stderr) || ''), code: e && e.status });
      }
    }

    /* ⑪ 盲解清稿：落一份**只有题干**的清稿，供无上下文解题者盲解（入库即"未盲解"是事实，
     *      但清稿必须当场备好，否则这道题永远欠着一笔账） */
    let blindNote = '';
    try {
      execFileSync('node', [toolPath('_盲解复核.mjs'), '清稿', '--student', student, '--ids', made.map(m => m.id).join(',')], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CTB_DATA: root } });
      blindNote = '已生成盲解清稿（_盲解\\…）——请让无上下文解题者盲解后跑 `_盲解复核.mjs 批量` 录入结论';
    } catch (e) {
      blindNote = '盲解清稿生成失败：' + String((e && e.stdout) || '') + String((e && e.stderr) || '');
    }

    const out = {
      ok: true, taskId, student, subject: subj, cards: made.map(m => m.id),
      dirs: made.map(m => m.dir), cropped: made.filter(m => m.cropped).map(m => m.id),
      gates: gates.map(g => ({ label: g.label, ok: g.ok, code: g.code || 0 })),
      blind: blindNote,
    };
    if (JSON_OUT) { process.stdout.write(JSON.stringify(out) + '\n'); return 0; }
    console.log('✔ 已入库 ' + made.length + ' 张卡（' + student + ' · ' + subj + '）：' + made.map(m => m.id).join('、'));
    console.log('  卡目录：' + path.relative(root, tgt.dirAbs));
    for (const g of gates) console.log('  ' + (g.ok ? '✔' : '✖') + ' ' + g.label + (g.ok ? '' : '（退出码 ' + g.code + '）'));
    if (blindNote) console.log('  · ' + blindNote);
    const bad = gates.filter(g => !g.ok);
    if (bad.length) {
      console.error('⚠ 有 ' + bad.length + ' 道门禁没过（卡已入库，内容在；请按门禁输出补齐）：');
      for (const g of bad) console.error('--- ' + g.label + ' ---' + String(g.out).slice(0, 800));
      return 1;
    }
    return 0;
  } catch (e) {
    if (tx) {
      const r = tx.rollback();
      if (r && (r.restored || r.removed)) console.error('[事务] 入库失败，已整体回滚（恢复 ' + r.restored + '、删除 ' + r.removed + '）');
    }
    throw e;
  } finally {
    release();
  }
}

/* ───────────────── 入口 ───────────────── */
const HELP = [
  '拾光小册 · 录题入库',
  '',
  '用法：',
  '  node src\\tools\\_录题入库.mjs 入库 <taskId> --file <cards.json> --student <学生化名> [--subject <学科>] [--note <备注>]',
  '',
  '前置条件（缺一不可，程序不替你做）：',
  '  · 任务记录存在且**已人工确认**（第三层，契约 §四）',
  '  · 回传 JSON 的信封 taskId / imageSha256 与任务记录一致（第二层）',
  '  · 每张卡的 sourceImageSha256 等于任务记录的原图 sha',
  '  · 学生·学科落点存在（学生索引里有这一科）',
  '',
  '通用参数：--data <库根>（与其它工具同口径）｜--json 输出机器可读｜--dry 预览',
  '退出码：0 成功 · 1 前置不通过/门禁未过 · 2 用法错/任务不存在 · 3 与任务不匹配',
];

let code = 0;
switch (cmd) {
  case '入库': code = cmdLand(); break;
  case '':
  case '--help':
  case '-h':
  case 'help':
    console.log(HELP.join('\n'));
    code = 0;
    break;
  default:
    console.error('未知动作：' + cmd);
    console.error(HELP.join('\n'));
    code = 2;
}
process.exit(code);
