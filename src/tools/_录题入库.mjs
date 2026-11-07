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
  valueFlags: [...COMMON_VALUE_FLAGS, 'task', 'file', 'in', 'student', 'grade', 'slots', 'note', 'date', 'reason'],   // 'in' = --file 的老别名（二次复审：严格模式下漏列会误杀）
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

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
/** 文件是否存在且是普通文件（改卡动作找原图时用） */
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
/** 红色批注与采用答案是否冲突（去空白、全半角归一后比；没写 ⇒ 不算冲突） */
const normAns = v => String(v || '').normalize('NFKC').replace(/\s+/g, '');
const teacherConflictOf = c => typeof c.teacherAnswer === 'string' && c.teacherAnswer.trim() !== '' && normAns(c.teacherAnswer) !== normAns(c.answer);

/* ★ 2026-11-07（红字归属，用户裁定）：**卷面上的红字不一定是老师批的** ——
 * 可能是孩子自己订正的、家长订改的、同学互批的。红字**单独不能当权威答案**。
 * 修前：契约把"红字"与"老师的"焊成一个概念（schema 写"老师用红笔写出的正确答案"、
 *   卡面落盘写死 "> 老师红笔："），全库**没有任何字段记录红字是谁写的** ——
 *   归属在入库那一刻就被丢弃，机器再无据可查。
 * 修后（第二次收紧）：`inkAttribution` 必填（有红色批注时），作用是**如实记录红字是谁写的**
 *   （供人核对、供追责），**不参与答案权威性判定** ——
 *   即使确认是老师写的，红字也不作定案标准。`老师定案` 这个 answerSource 取值**已废除**。 */
const INK_ATTRIBUTIONS = ['老师', '孩子', '家长', '同学', '未确认'];
/** 有红色批注吗（teacherAnswer 非空） */
const hasRedInk = c => typeof c.teacherAnswer === 'string' && c.teacherAnswer.trim() !== '';
/** 归属「未确认」⇒ 连"红字是谁写的"都不可查 */
const inkUnclear = c => String((c && c.inkAttribution) || '').trim() === '未确认';

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
 * 索引有两种形态（`生成状态.mjs:156-158` 是既有判据；形态②是旧库遗留，工具链仍要读得动）：
 *   ① 单学科：{student, grade, subject:'数学', items:[]}      文件在 <库根>\<小名>\<学科>\_索引.json
 *   ② 多学科：{student, grade, subjects:{ 数学:{items:[]} }}  文件在 <库根>\<小名>\_索引.json
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
  /* ★ 2026-11-05（PR #13 复审 ③）：红色批注内容随卡落盘（修前只在入库那一刻比对，之后就丢了）。
     ★ 2026-11-07（红字归属·第二次收紧）：**红字只作普通参考，不能作定案标准** ——
     卡面不再断言"老师红笔"，改成中性表述「红字（谁写的）」，并**明写"仅作参考"**。
     修前这行写死 "> 老师红笔：" = 机器替AI背书"这是老师批的、这就是正确答案"。 */
  if (typeof c.teacherAnswer === 'string') {
    const ink = String(c.inkAttribution || '').trim();
    const inkTxt = ink === '老师' ? '红字（老师写的）' : ink === '未确认' ? '红字（**归属未确认**）' : ink ? ('红字（' + ink + '写的）') : '红字';
    L.push('> ' + inkTxt + '：' + (c.teacherAnswer ? c.teacherAnswer : '（没有红色批注）') +
      '　※ **仅作参考，不作定案标准**（卷面红字绝大部分不是老师批的）' +
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

/**
 * 裁图**空白检测**（2026-11-05 实测踩到的坑，加这道闸的直接原因）：
 *
 *   实测：AI 给第1题的 bbox 偏上了 0.05（框到「评价检测」标签而不是题干），
 *   入库器**照单全收**裁出 1400×70 的图（5967 字节，几乎全是白），
 *   门禁全绿、卡照样进库 —— 直到人点开「原卷截图」才发现框里没有题。
 *
 *   为什么现有门禁抓不到：作答契约查的是**题干文本**（在题干.html 里，没错），
 *   配图门禁查的是**有没有配图**（hasFigure=false 就放行），
 *   原卷溯源查的是**裁图记录有没有写**（写了就算过）——
 *   没有任何一道门禁看**裁出来的图里到底有没有东西**。
 *
 *   判据：裁图里「非白像素」占比。题目那一块必有印刷体（黑字）+ 可能的红笔，
 *   而框错时框到的往往是标签页眉或页边留白。
 *
 *   ⚠ 阈值是**实测标定**的，不是拍的（2026-11-05 在真库上量了 40 张已有卡的裁图）：
 *     · 框错的那张（偏上 0.05，框到「评价检测」标签）：**2.59%**
 *     · 正常的题目块：库里 40 张样本最低 **14.07%**、中位 23.54%
 *   取 **5%**：比框错的低 1.9 倍、比真实最低的高 2.8 倍 —— 两边都有余量。
 *   取 0.8%（最初拍的值）会**抓不到**框错的那张（2.59% > 0.8%）—— 已按实测改正。
 *
 *   ⚠ 只**报警并跳过这张卡的裁图**，不阻断整批入库：
 *   框错了可以重裁，卡的内容本身可能是对的。
 */
function cropInkRatio(file) {
  /* 用 .NET 读像素（Node 无内置图像解码，装依赖又违反本仓"零依赖"纪律）。
     取样策略：缩到最多 400×400 再数 —— 题目块里的笔画足够密，
     缩到这个尺寸后非白像素占比不会变（都是"有字"的地方变黑）。 */
  const ps = [
    'param([string]$F)',
    'Add-Type -AssemblyName System.Drawing',
    '$img=[System.Drawing.Image]::FromFile($F)',
    '$w=$img.Width; $h=$img.Height',
    '$max=400',
    'if($w -gt $max -or $h -gt $max){ $k=[math]::Min($max/$w,$max/$h); $w=[int]($w*$k); $h=[int]($h*$k) }',
    'if($w -lt 1){$w=1}; if($h -lt 1){$h=1}',
    '$bmp=New-Object System.Drawing.Bitmap($w,$h)',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.DrawImage($img,0,0,$w,$h)',
    '$g.Dispose()',
    '$ink=0; $total=$w*$h',
    'for($y=0;$y -lt $h;$y+=1){ for($x=0;$x -lt $w;$x+=1){ $c=$bmp.GetPixel($x,$y); if(($c.R+$c.G+$c.B) -lt 690){$ink++} } }',
    '$bmp.Dispose(); $img.Dispose()',
    'Write-Output ("{0:F6}" -f ($ink/$total))',
  ].join("\r\n");
  const tmp = path.join(os.tmpdir(), 'gn-ink-' + process.pid + '-' + Date.now() + '.ps1');
  try {
    fs.writeFileSync(tmp, '﻿' + ps, 'utf8');
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp, '-F', file], { encoding: 'utf8', stdio: 'pipe' });
    const v = parseFloat(String(out || '').trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;   /* 读不动 ⇒ 不知道，不下结论（宁可不下结论也不误杀） */
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
  }
}
const CROP_MIN_INK = 0.05;   /* 5% —— 实测标定：框错的 2.59%，真实卡最低 14.07% */

/**
 * 裁「题图.jpg」：**只含插图**，不含孩子的作答与红笔。
 *
 * 为什么要有它（2026-11-05 实测踩到的坑）：
 *   配图门禁只认两个资产名：`题图.jpg`（纯图）/ `题干.jpg`（旧式整题自足截图）。
 *   原卷截图（含作答与红笔）**不算**图资产 —— 这是对的：契约明说
 *   「题图自带笔迹 ⇒ 重做卷等于泄答案」，所以图必须单独裁一份干净的。
 *   而契约原先只让 AI 给 `bbox`（整道题的位置），**没让 AI 说清"图在哪儿"**
 *   ⇒ 程序无从裁出题图 ⇒ 「题干提到图、图却没落地」的卡混进库（实测 P0116/P0117）。
 *   现在契约加 `figBbox`（插图自己的框），本函数据此裁图。
 *
 * @returns {{ok:boolean, file?:string, why?:string}}
 */
function cropFigure(srcImg, outFile, fb) {
  if (!srcImg) return { ok: false, why: '找不到原图' };
  if (!Array.isArray(fb) || fb.length !== 4) return { ok: false, why: '没给 figBbox' };
  const [nx, ny, nw, nh] = fb;
  if ([nx, ny, nw, nh].some(v => typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1)) return { ok: false, why: 'figBbox 不是 4 个 0~1 的数字' };
  if (nw <= 0.001 || nh <= 0.001) return { ok: false, why: 'figBbox 的宽或高为 0' };
  try {
    cropWithDotnet(srcImg, outFile, nx, ny, nw, nh, 1200);
  } catch (e) {
    return { ok: false, why: '裁图失败：' + String(e && e.message || e).slice(0, 120) };
  }
  /* 题图也过一遍空白检测：框到留白 ⇒ 同样是没落地 */
  const ink = cropInkRatio(outFile);
  if (ink !== null && ink < CROP_MIN_INK) {
    try { fs.unlinkSync(outFile); } catch { }
    return { ok: false, why: 'figBbox 框出来的题图几乎全是空白（非白像素 ' + (ink * 100).toFixed(2) + '%）' };
  }
  return { ok: true, file: outFile };
}

/* ───────────────── 主流程：改卡（2026-11-05 新增） ───────────────── */

/**
 * 改一张**已在库**的卡：重写题干/裁图/错题记录，**保留复习状态**。
 *
 * 为什么需要它（2026-11-05 实测踩到的坑）：
 *   卡入库后发现 bbox 框错了（框到页边留白而不是题目），
 *   而 `入库` 只新建、不覆盖 ⇒ 没有修正路径 ⇒ 要么手工改库（危险），
 *   要么把错卡留着（更坏：卡面挂一张空图，印出来是空白）。
 *   本动作补上这条路径：**按卡号**重写，索引里那条**原地更新**（不删行、不换号），
 *   复习状态（reviews/reviewStatus/errorCount/nextDue…）**原样保留**。
 *
 * 边界（刻意保守）：
 *   · 只改**内容**字段（question/answer/studentAnswer/causeCode/kpoints/source 等）与裁图；
 *   · **不改** id、不改 status、不改任何复习/掌握字段；
 *   · 改完照旧跑四道门禁（作答契约/配图/原卷溯源/盲解清稿）；
 *   · `--dry` 真预演（写完整体回滚）。
 *
 * 用法：改卡 <卡号> --file <cards.json> [--student <学生>] [--subject <学科>]
 *   cards.json 里放**这一张**卡（用它的 title/questionText 等字段）。
 */
function cmdFix() {
  const cardId = positional[0] || val('card', '');
  const file = val('file', '') || val('in', '');
  const student = val('student', '');
  const subject = val('subject', '');
  if (!cardId) return fail('用法：改卡 <卡号> --file <cards.json> [--student <学生>] [--subject <学科>]', 2);
  if (!file || !fs.existsSync(path.resolve(file))) return fail('用法：改卡 <卡号> --file <cards.json>（--file 必填且须存在）', 2);

  /* ① 读回传内容（只取第一张卡） */
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  const ex = extractJsonText(raw);
  if (!ex || !ex.ok) return fail('回传内容不是合法 JSON：' + String((ex && ex.error && ex.error.message) || '抽取不到 JSON 对象'), 1);
  const obj = ex.value;
  const payload = (obj && obj.result && obj.result.cards) ? obj.result.cards : (obj && obj.cards) ? obj.cards : null;
  if (!Array.isArray(payload) || !payload.length) return fail('回传内容里没有 cards（没有要改的卡）', 1);
  if (payload.length > 1) return fail('改卡一次只改一张（收到 ' + payload.length + ' 张）——一次改一张，改错了当场看得见', 2);
  const c = payload[0];

  /* ② 找卡：按学生+学科+卡号定位索引条目 */
  const root = ROOT();
  const idxFiles = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) { if (e.name === '_索引.json') idxFiles.push(path.join(dir, e.name)); continue; }
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  let hit = null;
  for (const f of idxFiles) {
    let j;
    try { j = readJsonStrict(f, { shape: x => Array.isArray(x.items) || (!!x.subjects && typeof x.subjects === 'object'), what: '索引', label: path.basename(f) }); }
    catch { continue; }
    if (student && String(j.student || '') !== student) continue;
    const subj = subject || (j.subject || '');
    const groups = j.subjects && typeof j.subjects === 'object'
      ? Object.entries(j.subjects).map(([n, v]) => [n, v.items || []])
      : [[subj, j.items || []]];
    for (const [sn, items] of groups) {
      const it = items.find(x => String(x.id) === cardId);
      if (it) { hit = { idxFile: f, j, subject: sn, items, item: it, base: path.dirname(f), student: String(j.student || '') }; break; }
    }
    if (hit) break;
  }
  if (!hit) return fail('找不到卡 ' + cardId + '（--student/--subject 是否与库里一致？先跑 `node src\\tools\\_录题入库.mjs` 的用法说明）', 2);

  const oldDir = hit.item.dir || cardId;
  const abs = path.join(hit.base, hit.subject, oldDir);
  if (!fs.existsSync(abs)) return fail('卡的目录不见了：' + abs + '（索引与磁盘不同步——先查 `_体检.mjs`）', 2);

  console.log('改卡 ' + cardId + '（' + hit.subject + '）：' + path.basename(abs));
  console.log('  原 question：' + String(hit.item.question || '').slice(0, 60));
  console.log('  新 question：' + String(c.questionText || '').slice(0, 60));

  /* ③ 找到原图：优先用回传的 sourceImageSha256 去台账/收件箱找；找不到就只改文本不动裁图 */
  let srcImg = null;
  const sha = String(c.sourceImageSha256 || '').toLowerCase();
  if (sha) {
    const led = path.join(root, '_原卷台账.json');
    if (isFile(led)) {
      try {
        const doc = JSON.parse(fs.readFileSync(led, 'utf8'));
        for (const k of Object.keys((doc && doc.cards) || {})) {
          const cc = doc.cards[k];
          for (const f of ['page', 'import']) {
            if (typeof cc[f] !== 'string' || !cc[f].trim()) continue;
            const p = path.resolve(root, cc[f]);
            if (!isFile(p)) continue;
            try { if (sha256(fs.readFileSync(p)) === sha) { srcImg = p; break; } } catch { }
          }
          if (srcImg) break;
        }
      } catch { }
    }
    if (!srcImg) {
      /* 回退：按内容指纹在收件箱里找（台账没登记原图时） */
      const inbox = path.join(root, '_收件箱');
      const found = [];
      const scan = (d, dep) => {
        if (dep > 3) return;
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { scan(p, dep + 1); continue; }
          if (!/\.(jpe?g|png|webp|bmp)$/i.test(e.name)) continue;
          found.push(p);
        }
      };
      scan(inbox, 0);
      for (const p of found) {
        try { if (sha256(fs.readFileSync(p)) === sha) { srcImg = p; break; } } catch { }
      }
    }
  }
  if (!srcImg) console.log('  ⚠ 找不到原图（按 sha256 没找到）——只改文本与索引，**不重裁图**');

  /* ④ 写盘（锁 + 事务） */
  const release = acquireLibLock(root, { label: '_录题入库 改卡 ' + cardId });
  let tx = null;
  try {
    tx = openTransaction(root, { label: '_录题入库 改卡 ' + cardId });

    /* ④a 题干.html */
    const hasBlank = /_{3,}|＿{2,}/.test(String(c.questionText || '')) || (Array.isArray(c.answerSlots) && c.answerSlots.length > 0);
    tx.writeText(path.join(abs, '题干.html'), buildStemHtml(c.questionText, hasBlank));

    /* ④b 裁图（有了原图且给了 bbox 才重裁；空白 ⇒ 撤掉旧图） */
    let cropped = null;
    let cropBlank = false;
    if (srcImg && Array.isArray(c.bbox)) {
      try {
        const ds = displaySize(srcImg);
        if (ds && ds.w && ds.h) {
          const [nx, ny, nw, nh] = c.bbox;
          tx.snapshot(path.join(abs, '原卷截图.jpg'));
          cropWithDotnet(srcImg, path.join(abs, '原卷截图.jpg'), nx, ny, nw, nh, 1400);
          const ink = cropInkRatio(path.join(abs, '原卷截图.jpg'));
          if (ink !== null && ink < CROP_MIN_INK) {
            cropBlank = true;
            console.error('⚠ ' + cardId + ' 的 bbox 框出来的原卷截图几乎全是空白（非白像素占比 ' + (ink * 100).toFixed(2) + '% < ' + (CROP_MIN_INK * 100).toFixed(1) + '%）');
            console.error('  ⇒ 多半是 bbox 偏了。已**撤掉这张裁图**（卡面不再挂空图），旧图也没了——请核对 bbox 后再改一次。');
          }
          const px = [Math.round(nx * ds.w), Math.round(ny * ds.h), Math.max(1, Math.round(nw * ds.w)), Math.max(1, Math.round(nh * ds.h))];
          cropped = { out: '原卷截图.jpg', box: [nx, ny, nw, nh], px, srcPx: { w: ds.w, h: ds.h } };
        }
      } catch (e) {
        console.error('⚠ ' + cardId + ' 裁图失败（不影响改卡）：' + String(e && e.message || e).slice(0, 160));
      }
    }
    if (cropBlank) {
      try { fs.unlinkSync(path.join(abs, '原卷截图.jpg')); } catch { }
      cropped = null;
    }
    if (cropped) {
      tx.writeJson(path.join(abs, '_裁图记录.json'), {
        src: path.relative(root, srcImg).split(path.sep).join('/'), out: cropped.out,
        normBox: cropped.box, cropPx: cropped.px, srcPx: cropped.srcPx, scale: 1,
        by: '录题改卡:' + cardId, date: today(), note: c.source || '',
      }, { newline: true });
    }

    /* ④c 错题记录.md */
    tx.writeText(path.join(abs, '错题记录.md'), buildRecord(cardId, c, {
      recipe: 'ingest-page', recipeVer: '', fingerprint: '',
      imageRel: srcImg ? path.relative(root, srcImg).split(path.sep).join('/') : '',
      imageSha: sha, taskId: '', date: today(), teacherConflict: teacherConflictOf(c),
    }));

    /* ④d 索引条目：**只改内容字段，复习/状态字段原样保留** */
    const it = hit.item;
    if (c.source !== undefined) it.source = c.source || '';
    if (c.sourceDate !== undefined) it.sourceDate = c.sourceDate || '';
    if (c.questionText !== undefined) it.question = String(c.questionText || '').replace(/\s+/g, ' ').trim();
    if (c.answer !== undefined) it.answer = c.answer || '';
    if (c.studentAnswer !== undefined) it.studentAnswer = c.studentAnswer || '';
    if (Array.isArray(c.kpoints)) it.kpoints = c.kpoints;
    if (c.causeCode !== undefined) { it.causeCode = c.causeCode || ''; it.causeLayer = String(c.causeCode || '')[0] || ''; }
    if (c.causeNote !== undefined) it.causeDesc = c.causeNote || '';
    if (c.difficulty !== undefined) it.difficulty = c.difficulty || '中';
    if (c.answerSource !== undefined) it.answerSource = c.answerSource || '未能确认';
    if (c.answerSourceNote !== undefined) it.answerSourceNote = c.answerSourceNote || '';
    it.teacherAnswer = typeof c.teacherAnswer === 'string' ? c.teacherAnswer : (it.teacherAnswer || '');
    /* ★ 2026-11-07（红字归属）：改卡时归属一并更新；没给归属但有红字 ⇒ 回落「未确认」，
       不许默默沿用旧归属（红字内容变了，归属可能也变了）。 */
    it.inkAttribution = typeof c.inkAttribution === 'string' ? c.inkAttribution
      : (typeof c.teacherAnswer === 'string' && c.teacherAnswer.trim() !== '' ? '未确认' : (it.inkAttribution || ''));
    it.teacherConflict = teacherConflictOf(c) ? { teacher: c.teacherAnswer, adopted: c.answer || '', source: c.answerSource, note: String(c.notes || '').slice(0, 300), at: today() } : null;
    if (cropped) it.hasImage = true;
    else if (cropBlank) it.hasImage = false;
    hit.j.updatedAt = today();
    tx.writeJson(hit.idxFile, hit.j, { backup: !DRY, newline: true });

    /* ④e 配图登记（如实登记，见入库器里同一段注释的说明）：
     *   修卡时配图状态可能变了（重裁了图 / 撤了空图 / 补裁了题图），登记必须跟着改，
     *   否则配图门禁会拿旧登记判 —— 门禁就成了摆设。 */
    {
      /* 题图：hasFigure=true 且给了 figBbox ⇒ 重新裁「题图.jpg」（纯图，无笔迹）。 */
      let figCropped = false;
      if (c.hasFigure === true && srcImg && Array.isArray(c.figBbox)) {
        const r = cropFigure(srcImg, path.join(abs, '题图.jpg'), c.figBbox);
        if (r.ok) { figCropped = true; console.log('  · 题图已裁出（题图.jpg）'); }
        else console.error('⚠ ' + cardId + ' 没裁出题图：' + r.why);
      }
      const stemHtmlNow = (() => { try { return fs.readFileSync(path.join(abs, '题干.html'), 'utf8'); } catch { return ''; } })();
      const stemHasSvg = /<svg[\s>]/i.test(stemHtmlNow);
      const hasFigFile = figCropped || fs.existsSync(path.join(abs, '题图.jpg'));
      const figNeed = !!c.hasFigure;
      const figKind = stemHasSvg ? 'svg' : (hasFigFile ? 'jpg' : 'none');
      const figRef = stemHasSvg ? '题干.html 内联 SVG' : (hasFigFile ? '题图.jpg' : '');
      const figFile = path.join(root, '_配图台账.json');
      let led = { cards: {} };
      if (isFile(figFile)) { try { led = JSON.parse(fs.readFileSync(figFile, 'utf8')); } catch { led = { cards: {} }; } }
      if (!led.cards || typeof led.cards !== 'object') led.cards = {};
      led.cards[(hit.student || student) + '|' + cardId] = {
        need: figNeed && (stemHasSvg || hasFigFile), kind: figKind, ref: figRef,
        note: c.notes || (stemHasSvg ? '题干含图，随题干.html 内联印刷'
          : hasFigFile ? '题图单独裁出（题图.jpg，只含图、不含孩子的作答与红笔）'
            : '题干提到图，但**既没内联也没裁到题图** —— 需人工补图'),
        by: '录题改卡:' + cardId, date: today(),
      };
      tx.writeJson(figFile, led, { backup: !DRY, newline: true });
    }

    if (!DRY) {
      const r = tx.commit && tx.commit();
      void r;
    } else {
      tx.rollback();
    }
    console.log('✔ 改卡完成：' + cardId + '（内容已更新；复习状态与卡号原样保留）' + (DRY ? '  [dry：已整体回滚]' : ''));
    return 0;
  } catch (e) {
    console.error('✖ 改卡失败：' + String(e && e.message || e));
    if (tx) { try { const r = tx.rollback(); if (r && (r.restored || r.removed)) console.error('[事务] 已整体回滚（恢复 ' + r.restored + '、删除 ' + r.removed + '）'); } catch { } }
    return 1;
  } finally {
    release();
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
    /* ★ 2026-11-07（红字归属·第二次收紧，用户裁定）：**卷面红字绝大部分不是老师批的**
       （孩子自己批改/订正、同学互批、家长帮批）⇒ 红字**只能作普通参考，不能作定案标准**。
       ⇒ 「老师定案」这个 answerSource 取值**被废除**：它等于"把红字当定案标准"。
          即使确认是老师写的也不行 —— 老师也可能照着错题本抄、也可能批漏、也可能只写了个提示。
       ⇒ 红字只能进 `teacherAnswer`（中性记录原文 + 归属），**永不单独确立答案**。
          有红字且与采用答案不一致 ⇒ 挂 teacherConflict，组卷前人工裁决；
          裁决只有两个方向：`--as 官方答案`（保留采用答案）/ `--as 红字参考`（只记参考，不改答案）。
       ⇒ 契约取值表相应收缩为：独立判卷 / 官方答案 / 红笔订正+官方答案页核对 / 未能确认。 */
    if (c.answerSource && !['独立判卷', '官方答案', '红笔订正+官方答案页核对', '未能确认'].includes(c.answerSource)) {
      const isRetired = /^老师定案/.test(String(c.answerSource));
      problems.push(id + ' 的 answerSource 取值不在契约内：' + c.answerSource +
        (isRetired
          ? ' —— 「老师定案」已废除：**红字只作参考，不能作定案标准**（卷面红字绝大部分不是老师批的；' +
            '即使是老师写的，也可能照抄错题本或批漏）。改用：独立判卷 / 官方答案 / 未能确认；' +
            '红字与答案不一致时写进 notes，入库后走「异议裁决」'
          : ''));
    }
    /* ★ 2026-11-07（先搜公开题库，用户裁定）：录题第一步应先上网与成熟错题库比对
       （菁优网等），实在找不到再自己一点一点录 —— 这条规则**以前只写在提示词与人工 checklist 里**，
       程序一处不查 ⇒ "假装查过"（没检索却写官方答案）没有任何拦截，是来源造假里最常见的一种。
       现在补上机械判据：answerSource 是「官方答案」或「红笔订正+官方答案页核对」时，
       answerSourceNote **必须**指出具体出处（站点名 / 答案页页码 / 文件名）。
       判据刻意宽松：认出的是"有没有指向一个可复核的地方"，不是"格式对不对"。 */
    const isOfficial = /^(官方答案|红笔订正\+官方答案页核对)/.test(String(c.answerSource || ''));
    if (isOfficial) {
      const note = String(c.answerSourceNote || '');
      const hasSource = /菁优|jyeoo|21世纪|21cnjy|教习网|51jiaoxi|作业帮|zuoyebang|青果|精英家教|题库|网站|站点|答案\s*\.?\s*pdf|答案页|答案\s*PDF|第\s*\d+\s*页|真题|同题页|讲义|同步|教辅|练习册|卷/i.test(note);
      if (!hasSource) {
        problems.push(id + ' 的 answerSource=' + c.answerSource + '，但 answerSourceNote 里没有出处（站点名 / 答案页页码 / 文件名）—— ' +
          '"官方答案"必须能指着某个地方复核。查了却没命中就写「未能确认」，没查就如实写"未联网检索，来源：独立判卷"，**不许假装查过**');
      }
    }
    /* ★ 2026-11-07（红字归属）：红字不一定是老师写的，必须说清是谁写的。
       ① inkAttribution 取值非法 ⇒ 拒（写错枚举值等于没说清）。
       ② 有红色批注（teacherAnswer 非空）却没声明归属 ⇒ 拒：省略 = 归属不明 = 连"是谁写的"都不可查。
       ③ 红字与采用答案不一致 ⇒ notes 必须交代分歧，否则拒（不许悄悄覆盖）。 */
    if (c.inkAttribution !== undefined && !INK_ATTRIBUTIONS.includes(String(c.inkAttribution))) {
      problems.push(id + ' 的 inkAttribution 取值不在契约内：' + JSON.stringify(c.inkAttribution) + '（只能是 ' + INK_ATTRIBUTIONS.join(' / ') + '）');
    }
    if (hasRedInk(c) && c.inkAttribution === undefined) {
      problems.push(id + ' 照片上有红色批注却没声明 inkAttribution（红字是谁写的？）—— 红字可能是孩子自己订正的、家长订改的、同学互批的。补 inkAttribution（老师/孩子/家长/同学/未确认）；红字只作参考，永不单独确立答案');
    }
    /* ★ 2026-11-07（红字归属·第二次收紧）：**红色批注不得被悄悄覆盖，也不得单独确立答案**。
       ① **每张卡**都必须声明 teacherAnswer（照片上红色批注的原文，没有就填空串）——
          省略等于让"红字被覆盖"这条检查失明。
       ② 已填且与采用答案不一致：
          · notes 没交代分歧 ⇒ 拒（不许悄悄覆盖）。
          · 交代了 ⇒ 入库但挂 teacherConflict，组卷准入挡在池外，
            直到 `_标记复习.mjs 异议裁决` 人工裁决（裁决只有 --as 官方答案 / --as 红字参考
            两个方向；「老师定案」口径已废除）。 */
    if (typeof c.teacherAnswer !== 'string') {
      problems.push(id + ' 没有声明 teacherAnswer —— 照片上红色批注的内容就原样填，没写就填空串 ""（每张卡必填：省略等于让"红字被覆盖"这条检查失明）');
    } else if (teacherConflictOf(c)) {
      if (!/红笔不一致|红字不一致|与红.*不一致|与老师.*不一致/.test(String(c.notes || '') + String(c.answerSourceNote || ''))) {
        problems.push(id + ' 的 answerSource=' + c.answerSource + '，但答案（' + c.answer + '）与红色批注（' + c.teacherAnswer + '）不一致且未交代分歧 —— ' +
          '红字批注不能被悄悄覆盖：在 notes 写明"与红字批注不一致：…"（入库后仍须 异议裁决 才能组卷）。' +
          '注意：**红字只作参考，不能作定案标准** —— 即使确认是老师写的也一样');
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
    /* ★ 2026-11-05（补契约缺口）：hasFigure=true 时必须给 **figBbox**（插图自己的框）。
       起因：P0116/P0117（走马灯图、扫地车图）入库后配图门禁判「缺图」——
       因为契约只让 AI 给 `bbox`（整道题的位置），**没有让 AI 说清"图在哪儿"**，
       程序无从裁出「题图.jpg」，于是"题干提到图、图却没落地"。
       以前的入库器还会**假登记**（hasFigure=true 一律写成"题干.html 内联 SVG"，
       而 buildStemHtml 只包纯文本、永远产不出内联 SVG）⇒ 配图门禁被架空。已一并改掉。 */
    if (c.hasFigure === true && c.figBbox === undefined) {
      problems.push(id + ' 标了 hasFigure=true 却没给 figBbox —— 程序不知道"图在哪儿"，裁不出题图.jpg（配图门禁会判缺图）。请给出插图自己的框（归一化 [x,y,w,h]）');
    }
    if (c.figBbox !== undefined) {
      const f = c.figBbox;
      if (!Array.isArray(f) || f.length !== 4 || f.some(v => typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1)) {
        problems.push(id + ' 的 figBbox 必须是 4 个 0~1 的数字（归一化 [x,y,w,h]），收到：' + JSON.stringify(f));
      } else if (f[0] + f[2] > 1.001 || f[1] + f[3] > 1.001) {
        problems.push(id + ' 的 figBbox 越界：x+w=' + (f[0] + f[2]).toFixed(4) + '，y+h=' + (f[1] + f[3]).toFixed(4) + '（都应 ≤ 1）');
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
    inkAttribution: c.inkAttribution,   // ★ 2026-11-07（红字归属）：改了归属重提，同样是新内容
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
      let cropBlank = false;
      if (srcImg && Array.isArray(c.bbox)) {
        try {
          const ds = displaySize(srcImg);
          if (!ds || !ds.w || !ds.h) throw new Error('读不出原图尺寸（格式不支持或文件损坏）');
          const [nx, ny, nw, nh] = c.bbox;
          tx.snapshot(path.join(abs, '原卷截图.jpg'));   // 先登记：回滚时新图删掉、旧图恢复
          cropWithDotnet(srcImg, path.join(abs, '原卷截图.jpg'), nx, ny, nw, nh, 1400);
          /* ★ 2026-11-05：裁图**空白检测**（bbox 框错的最常见表现）。
             框到页边留白/标签 ⇒ 裁出来的图几乎全白 ⇒ 卡印出来是空白。
             实测踩到过：AI 给的 bbox 偏上 0.05，裁出 1400×70 的近白图，
             三道门禁全绿、卡照样进库，直到人点开原卷截图才发现里面没有题。
             这里只**报警 + 撤掉这张裁图**，不阻断整批（框错了可重裁，卡内容本身可能对）。 */
          const ink = cropInkRatio(path.join(abs, '原卷截图.jpg'));
          if (ink !== null && ink < CROP_MIN_INK) {
            cropBlank = true;
            console.error('⚠ ' + id + ' 的 bbox 框出来的原卷截图几乎全是空白（非白像素占比 ' + (ink * 100).toFixed(2) + '% < ' + (CROP_MIN_INK * 100).toFixed(1) + '%）');
            console.error('  ⇒ 多半是 bbox 偏了（框到页边留白/标签而不是题目）。已**撤掉这张裁图**，卡面内容仍入库。');
            console.error('  修法：回原图核对该题的题号与位置，改 bbox 后重新入库（bbox 在 cards.json 里）。');
          }
          const px = [Math.round(nx * ds.w), Math.round(ny * ds.h), Math.max(1, Math.round(nw * ds.w)), Math.max(1, Math.round(nh * ds.h))];
          cropped = { out: '原卷截图.jpg', box: [nx, ny, nw, nh], px, srcPx: { w: ds.w, h: ds.h } };
        } catch (e) {
          console.error('⚠ ' + id + ' 裁图失败（不影响入库）：' + String(e && e.message || e).slice(0, 160));
        }
      }
      /* 空白裁图不算裁图：撤掉文件、不写裁图记录 ⇒ 卡面不会挂一张空图。
         ⚠ 直接 unlink（事务对象没有 remove 方法）：这个文件是**本次新建**的，
         回滚时整个卡目录会被删掉，不会留下"删不回去"的窟窿。 */
      if (cropBlank) {
        try { fs.unlinkSync(path.join(abs, '原卷截图.jpg')); } catch { /* 撤不掉就留着，下面的记录不写 */ }
        cropped = null;
      }

      /* _裁图记录.json（原卷溯源的唯一 sidecar，`_原卷台账.mjs` 只认它） */
      if (cropped) {
        tx.writeJson(path.join(abs, '_裁图记录.json'), {
          src: task.image.rel, out: cropped.out, normBox: cropped.box, cropPx: cropped.px,
          srcPx: cropped.srcPx, scale: 1, by: '录题入库:' + taskId, date: today(),
          note: c.source || '',
        }, { newline: true });
      }

      /* 「题图.jpg」：**只含插图**，不含孩子的作答与红笔（见 cropFigure 的说明）。
         hasFigure=true 时按 figBbox 裁；没有 figBbox ⇒ 契约检查已拦（见 ⑧），
         这里只兜底：没裁到就如实记 need=false，不假装有图。 */
      let figCropped = false;
      if (c.hasFigure === true && srcImg) {
        const r = cropFigure(srcImg, path.join(abs, '题图.jpg'), c.figBbox);
        if (r.ok) {
          figCropped = true;
          console.log('  · ' + id + ' 题图已裁出（题图.jpg）');
        } else {
          console.error('⚠ ' + id + ' 没裁出题图：' + r.why + ' —— 该卡按"无图"登记（配图门禁会点名）');
        }
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
          /* ★ 2026-11-07（红字归属）：红字是谁写的 —— 修前**全库无此字段**，归属在入库那刻丢失。
             组卷准入据此拦「归属未确认」的卡（见 _标记复习 准入）。 */
          inkAttribution: typeof c.inkAttribution === 'string' ? c.inkAttribution : (c.teacherAnswer && String(c.teacherAnswer).trim() !== '' ? '未确认' : ''),
          teacherConflict: teacherConflictOf(c) ? { teacher: c.teacherAnswer, adopted: c.answer || '', source: c.answerSource, note: String(c.notes || '').slice(0, 300), at: today() } : null,
          answerNote: c.answerNote || '',
        };
        itemsOwner.push(it);
      }

      /* 配图登记（2026-11-05 修一个**假登记**）：
       *   修前：hasFigure=true ⇒ 一律写 kind='svg'、ref='题干.html 内联 SVG'。
       *   但 buildStemHtml() **只包纯文本**，永远不会产出内联 SVG ——
       *   于是"题干提到图、但图没登记"的卡被登记成"已内联"，配图门禁因此失明：
       *   实测 P0116/P0117（题干含「如图」，图在原卷上、没重画）就是这么混过去的。
       *   现在**如实登记**：题干.html 里真的有 <svg> 才算内联；
       *   否则看有没有**题图.jpg**（按 figBbox 单独裁的纯图）；
       *   连它也没有 ⇒ need=false 并写明"需人工补图"。
       *   ⚠ kind 必须落在配图门禁认识的取值里（svg | jpg | none）——
       *   写门禁不认识的 kind，门禁就查不出资产 ⇒ 又一次失明。
       *   登记与实际资产一致 ⇒ 配图门禁才有牙齿。 */
      const stemHasSvg = /<svg[\s>]/i.test(String(c.stemHtml || '')) || /<svg[\s>]/i.test(fs.readFileSync(path.join(abs, '题干.html'), 'utf8'));
      const hasFigFile = figCropped || fs.existsSync(path.join(abs, '题图.jpg'));
      const figNeed = !!c.hasFigure;
      const figKind = stemHasSvg ? 'svg' : (hasFigFile ? 'jpg' : 'none');
      const figRef = stemHasSvg ? '题干.html 内联 SVG' : (hasFigFile ? '题图.jpg' : '');
      figs.push({
        card: student + '|' + id, need: figNeed && (stemHasSvg || hasFigFile), kind: figKind,
        ref: figRef,
        note: c.notes || (stemHasSvg ? '题干含图，随题干.html 内联印刷'
          : hasFigFile ? '题图单独裁出（题图.jpg，只含图、不含孩子的作答与红笔）'
            : '题干提到图，但**既没内联也没裁到题图** —— 需人工补图'),
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

    /* ⑩ 当场跑门禁（不留"事后手跑"的欠账）
     * ⚠ ★ 2026-11-05 修一个**真 bug**：配图登记原来也走 `_作答门禁.mjs 批量` ——
     *   把**配图声明文件**喂给了**作答门禁**。于是：
     *     · 配图台账根本没人写（入库路径下新卡的配图登记全部丢失）；
     *     · 作答门禁却收到一份形状不对的文件（它只认 {card,mode,slots}）。
     *   实测：临时库上入库后 `_配图台账.json` 里查无此卡；而「改卡」路径是直接写台账的
     *   ⇒ 两条路径行为不一致，真库上看着"没问题"（因为那几张是改卡写的）。
     *   现在各走各的门禁：作答声明 → `_作答门禁.mjs 批量`，配图声明 → `_配图门禁.mjs 批量`。 */
    const gates = [];
    const runGate = (label, script, args) => {
      try {
        const r = execFileSync('node', [toolPath(script), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CTB_DATA: root } });
        gates.push({ label, ok: true, out: String(r || '').trim() });
      } catch (e) {
        const msg = String((e && e.stdout) || '') + String((e && e.stderr) || '');
        gates.push({ label, ok: false, out: msg.trim(), code: e && e.status });
      }
    };
    if (answers.length) {
      runGate('作答契约门禁', '_作答门禁.mjs', ['批量', '--file', ansFile]);
    }
    runGate('配图门禁', '_配图门禁.mjs', ['批量', '--file', figFile]);
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
  '  node src\\tools\\_录题入库.mjs 改卡 <卡号> --file <cards.json> [--student <学生化名>] [--subject <学科>]',
  '',
  '入库前置条件（缺一不可，程序不替你做）：',
  '  · 任务记录存在且**已人工确认**（第三层，契约 §四）',
  '  · 回传 JSON 的信封 taskId / imageSha256 与任务记录一致（第二层）',
  '  · 每张卡的 sourceImageSha256 等于任务记录的原图 sha',
  '  · 学生·学科落点存在（学生索引里有这一科）',
  '',
  '改卡（2026-11-05 新增）：重写**已在库**那一张的题干/裁图/记录，',
  '  索引条目**原地更新**（不删行、不换号），**复习状态原样保留**。',
  '  一次只改一张；--dry 预览。',
  '',
  '通用参数：--data <库根>（与其它工具同口径）｜--json 输出机器可读｜--dry 预览',
  '退出码：0 成功 · 1 前置不通过/门禁未过 · 2 用法错/任务不存在 · 3 与任务不匹配',
];

let code = 0;
switch (cmd) {
  case '入库': code = cmdLand(); break;
  case '改卡': code = cmdFix(); break;
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
