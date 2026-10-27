#!/usr/bin/env node
/**
 * 拾光小册 · 作答契约门禁（v2.6，2026-10-25 建）—— 「答案齐全 / 图上作答 / 横线够宽」的唯一执行入口
 *
 * 起源（用户报障三连，原话级）：
 *   ①「M0066，答案好像不全」           → 题干 10 个空，答案只写了 2 条（且只覆盖右半表）；
 *   ②「M0011，在图上写出答案，所以组卷时这类题目不需要再留答题区」 → 图里作答的题照样印 220px 大空框；
 *   ③「M0084，给出的下横线长度根本不够写答案」 → 6em 的横线，答案「−a 的相反数是 a」要 9em。
 *   用户明确要求：**不许点名改三张卡，要把这三类做成制度**。
 *
 * 制度本体（卡片级显式契约，缺一条就红）：
 *   answerMode   blank（答案写在题干空位里）| figure（答案画/写在配图上，不留答题区）
 *                | zone（题干下另留答题区：计算/解答/长答）| none（选择/判断，无需作答区）
 *   answerSlots  逐空答案，**顺序＝卷面顺序**（数组长度必须等于题干里数出来的空位数）
 *   answerScope  缺省 full；合卡/只考错空时写 partial，并用 answerSlotsAt 指明是第几空
 *   answerNote   partial 的人话说明（会印在答案册上，不许沉默）
 *
 * 为什么"逐空答案"是答案不全的唯一可机械化判据：
 *   题干里的空位是**可数的客观事实**（span.blank / 下划线串，`_空位.mjs` 唯一实现），
 *   而"答案写全了没有"原先只能靠人看。把逐空答案登记进索引后，机器就能对账：
 *   空 10 个、登记 2 条 ⇒ 答案不全，一秒钟暴露。同一份数据还顺带解决另外两件事：
 *   · 渲染器按每空答案的长度撑宽横线（长答自然变宽，短答不浪费纸）；
 *   · 答案册按空逐条列出，家长批改不必再从一段话里猜哪个空。
 *
 * 用法（node _作答门禁.mjs <动作>）：
 *   扫描                只读：全库逐卡列出「空位数 / 已登记 / 判定」，把候选缺陷标出来
 *   清单 [--json]       只读：逐卡状态（{key:{slots,answers,mode,state,ok}}）
 *   门禁 [--json]       判定：不合契约即退出码 1（人类模式与 --json 同码同判，绝不假绿）
 *   工单 --out <dir>    只读：按学科导出「待登记」工单（JSON+MD），供人/子代理逐卡填答案
 *   补登 --card 学生|编号 --slots "…；…" [--mode blank|figure|zone|none] [--scope full|partial]
 *        [--at 1,3] [--note "..."]     单卡写回索引（走 _安全写：备份 + 原子写 + 形状守卫）
 *   批量 --file <decl.json>           批量写回：[{card, mode, slots:[…], scope, at, note}]
 *   刷指纹 [--dry]      只读+盖章：给"已登记答案但无指纹"的老卡以当前题干为基线补登记
 *                        （v2.7；会落 answerSlotsFpAssumed=true —— 那是**假设**不是复核）
 *   修宽 [--dry]        按声明答案把 题干.html 里过窄的空位改宽（原子写 + 备份；默认 dry 预览）
 *
 * ⚠ 本工具是 answerMode/answerSlots 的**唯一写入入口**；手工改索引不算数（Gate 会重新数空位对账）。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { libraryRoot, toolPath } from './_库根.mjs';
import { readJsonStrict, writeJsonAtomic, backupJson, writeTextAtomic } from './_安全写.mjs';
import { slotsOf, slotCount, needEm, blankWidthEm, alignedAnswers, fitSlots, applySlotWidths, BLANK_MAX_EM, CHILD_FACTOR } from './_空位.mjs';

const ROOT = libraryRoot();
const STEM_HTML = '题干.html';
const MODES = ['blank', 'figure', 'zone', 'none'];
/* 图上作答的题面信号：动词出现在「题面」而不是「答案」里才说明要画/写在图上。
   这批关键词只用来**发现疑似**，最终判权在 answerMode（显式登记），同配图门禁的台账设计。 */
const FIG_ANSWER_WORDS = /填在|填入|填到|画在|画出|圈出|标出|在图上|在图中|补全图|作图|连[线起]|涂[色黑]/;

const argv = process.argv.slice(2);
const action = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith('--')) continue;
  const k = t.slice(2);
  if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { opt[k] = argv[++i]; }
  else { opt[k] = true; }
}
const dstr = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const today = () => dstr(new Date());
const fail = m => { console.error('✖ ' + m); process.exit(2); };

/* ---------- 题库发现（与 _配图门禁 / _盲解复核 同规则） ---------- */
function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) { if (e.name === '_索引.json') acc.push(path.join(dir, e.name)); continue; }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    if (/(作业|假期)/.test(e.name)) continue;
    indexFiles(path.join(dir, e.name), acc);
  }
  return acc;
}
const IDX_SHAPE = j => Array.isArray(j.items) || (!!j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects));
const readIndexFile = p => readJsonStrict(p, { shape: IDX_SHAPE, what: 'items 数组或 subjects 对象', label: path.basename(p) });

/** 全库卡（带回写定位：文件 + 在文件里的容器 + 下标） */
function allCards() {
  const out = [];
  for (const f of indexFiles(ROOT)) {
    const j = readIndexFile(f);
    const base = path.dirname(f);
    if (Array.isArray(j.items)) {
      j.items.forEach((it, i) => out.push({ item: it, student: j.student, subject: j.subject || '', dirAbs: path.join(base, it.dir || it.id), file: f, holder: { kind: 'items', i }, key: j.student + '|' + it.id }));
    }
    if (j.subjects && typeof j.subjects === 'object') {
      for (const [name, v] of Object.entries(j.subjects)) {
        (v.items || []).forEach((it, i) => out.push({ item: it, student: j.student, subject: name, dirAbs: path.join(base, name, it.dir || it.id), file: f, holder: { kind: 'subject', name, i }, key: j.student + '|' + it.id }));
      }
    }
  }
  return out;
}
const stemOf = x => {
  const p = path.join(x.dirAbs, STEM_HTML);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') : '';
};
const hasFigure = x => {
  const h = stemOf(x);
  if (/<svg[\s\S]*?<\/svg>/i.test(h) || /<img\b/i.test(h)) return true;
  return fs.existsSync(path.join(x.dirAbs, '题图.jpg')) || fs.existsSync(path.join(x.dirAbs, '配图.svg'));
};
const plainText = h => String(h || '')
  .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/* ---------- 答案契约指纹（v2.7，2026-10-27） ----------
 * 为什么需要：空位数对账只挡得住"空变多/变少"，挡不住**改了措辞但空数不变**——
 *   例：题干「求 x 的值」改成「求 2x 的值」，空还是 1 个，登记答案仍对得上数，
 *   但答案已经错了；这类错会**原样印进答案册**，家长照着批改必然判错。
 *   实测口径来自用户 2026-10-10 的裁定：「答案要跟题干绑在一起，不能各说各话」。
 *
 * 设计（与盲解指纹分工，互不影响）：
 *   · 盲解指纹（_盲解复核.mjs）= 题干 ↔ **盲解结论** 的绑定；本条只管 题干 ↔ **逐空答案**。
 *   · 两者算法**各自独立**：绝不改动 _盲解复核 的规范化口径（改了就等于全库指纹失效）。
 *   · 覆盖范围 = 纯文本 + 图形签名，**不含**空位 span 的 width/style：
 *     否则跑一次 `修宽`（只改排版宽度、不改语义）就会让全库指纹失效，
 *     人会因此学会"看到红就刷指纹"，门禁随之退化成一枚橡皮图章。
 *   · 兼容：老卡没有 answerSlotsFp → 只告警不阻断（与 blindFingerprintVer 同为渐进式）；
 *     跑 `刷指纹` 以当前题干为基线补登记，此后享受保护。
 */
function figureSignatureOf(stemHtml) {
  const parts = [];
  for (const m of String(stemHtml || '').matchAll(/<svg[\s\S]*?<\/svg>/gi)) parts.push(m[0]);
  for (const m of String(stemHtml || '').matchAll(/<img\b[^>]*>/gi)) parts.push(m[0]);
  // 图形片段里的排版属性同样要规范化：只认结构，不认宽度/样式（理由同上，防"修宽即失效"）
  return parts
    .map(s => s.replace(/\s(?:width|height|style)\s*=\s*"[^"]*"/gi, '').replace(/\s+/g, ' ').trim())
    .join('\n');
}
const answerContractFingerprint = (stemHtml) =>
  crypto.createHash('sha256')
    .update(plainText(stemHtml) + '\u0000' + figureSignatureOf(stemHtml), 'utf8')
    .digest('hex')
    .slice(0, 16);

/** 错题记录里的「正确答案」段（工单要把它摘给填答案的人，别让人再翻一遍 md）
 *  ★ 2026-10-25：早一版只认 `## 正确答案` / `**正确答案` 两个标题，而库里真实段落名有
 *    「## 正确完整过程（标准已对照官方答案页 pXX…）」「## 正确答案与过程」等多种写法 ⇒
 *    工单里 recordAnswer 全是空串，填报员以为"答案数据缺失"（子代理实测报回）。
 *    现在按**语义**认：任何标题含「正确答案 / 正确完整 / 答案与过程 / 标准答案」都算。 */
function recordAnswerOf(dirAbs) {
  const p = path.join(dirAbs, '错题记录.md');
  if (!fs.existsSync(p)) return '';
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const HEAD = /^#{1,6}\s*(.*正确答案.*|.*正确完整.*|.*答案与过程.*|.*标准答案.*)\s*$/;
  const i = lines.findIndex(l => HEAD.test(l.trim()));
  if (i < 0) return '';
  const out = [];
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k].trim();
    if (/^#{1,6}\s/.test(l)) break;                     // 下一个同级/更高级标题即止
    if (l) out.push(l);
  }
  return out.join('\n').slice(0, 1600);
}

/* ---------- 单卡判定（唯一判据实现：门禁/清单/扫描/工单全用它） ---------- */
function judge(x) {
  const it = x.item;
  const stem = stemOf(x);
  const slots = slotsOf(stem);
  const n = slots.length;
  const mode = it.answerMode == null ? '' : String(it.answerMode);
  const scope = it.answerScope == null ? 'full' : String(it.answerScope);
  const raw = Array.isArray(it.answerSlots) ? it.answerSlots.map(v => (v == null ? '' : String(v))) : [];
  const at = Array.isArray(it.answerSlotsAt) ? it.answerSlotsAt.map(Number) : [];
  const fig = hasFigure(x);
  const text = plainText(stem) + ' ' + String(it.question || '');
  const figSuspect = fig && FIG_ANSWER_WORDS.test(text);
  const problems = [];
  const warnsWidth = [];

  /* ① 字段形状（写坏了要响亮，否则下游全按"没登记"静默降级） */
  if (mode && MODES.indexOf(mode) < 0) problems.push({ code: 'mode', msg: `answerMode 非法：${JSON.stringify(it.answerMode)}（应为 ${MODES.join('/')}）` });
  if (scope !== 'full' && scope !== 'partial') problems.push({ code: 'scope', msg: `answerScope 非法：${JSON.stringify(it.answerScope)}` });

  /* ② 答案齐全：有空就必须逐空登记，且条数对得上 */
  if (n > 0) {
    if (!raw.length) problems.push({ code: 'slots-missing', msg: `题干有 ${n} 个空，但没有逐空答案（answerSlots）——答案不全` });
    else if (scope === 'partial') {
      if (!at.length) problems.push({ code: 'slots-at', msg: 'answerScope=partial 必须用 answerSlotsAt 指明是第几空（1 起）' });
      else if (at.length !== raw.length) problems.push({ code: 'slots-at', msg: `answerSlots ${raw.length} 条 vs answerSlotsAt ${at.length} 条，对不齐` });
      else if (at.some(k => !(k >= 1 && k <= n))) problems.push({ code: 'slots-at', msg: `answerSlotsAt 越界：${at.join(',')}（本题只有 ${n} 个空）` });
      /* ★ 2026-10-25：序号必须严格递增且互不相同。实测踩到：把"编号横线算两个空"的旧解析
         迁移到新解析时，两个旧空会塌进同一个新空，`at` 出现 [1,1,2] 这种重号 ——
         答案册会把两条答案都印成「第1空」，家长照它批改必然对错位置（比缺答案更坏）。 */
      else if (new Set(at).size !== at.length || at.some((k, i) => i > 0 && k <= at[i - 1])) {
        problems.push({ code: 'slots-at-order', msg: `answerSlotsAt 必须严格递增且不重复：${at.join(',')}` });
      }
      else if (!String(it.answerNote || '').trim()) problems.push({ code: 'partial-note', msg: 'answerScope=partial 必须写 answerNote（会印在答案册上，说明为什么只列部分空）' });
    } else if (raw.length !== n) {
      problems.push({ code: 'slots-count', msg: `逐空答案 ${raw.length} 条 ≠ 题干空位 ${n} 个——答案不全/多写` });
    }
    raw.forEach((v, i) => { if (!v.trim()) problems.push({ code: 'slots-empty', msg: `第 ${i + 1} 条逐空答案为空` }); });
    /* ③ 横线够宽 —— 分两档，判据不同（2026-10-25 定档，避免"机器本来就能自动修的"混进阻断）：
       · **太长（答案本身 > BLANK_MAX_EM=18em）** ⇒ 阻断：这是排版**决策**（该空改成另留答题区），
         机器不该替人决定；
       · **偏窄（声明宽度 < 答案所需 × 1.5）** ⇒ 只提示：渲染器每次都按 blankWidthEm 撑宽
         （model.js applySlotWidths），印出来一定够写；`修宽` 可把数据基线也补齐。
         ★ 2026-10-25 晚用户二次报障（Y0003 横线明显不够写）后定档：横线 ≡ 答案所需 × 1.5，
           上一版只撑到 1.0 倍（成人字迹刚好写满），孩子的字一落笔就挤出线外。
       · mode=zone（答案写在答题区）与 mode=figure（答案在图上/是一段画法描述）不做宽度判定。 */
    if (raw.length && mode !== 'zone' && mode !== 'figure') {
      /* 逐空对照：partial 合卡先按 answerSlotsAt 摊平到"第几空"再判——旧版因为不知道第几条
         对应第几空，只能逐条判"太长"，**偏窄永远发现不了**（而这正是用户看得见的那个毛病）。 */
      const aligned = scope === 'partial' ? alignedAnswers(raw, at, n) : raw;
      const fit = fitSlots(stem, aligned);
      for (const b of fit.bad) {
        if (b.code === 'too-long') problems.push({ code: 'width-too-long', msg: `第 ${b.i} 空：「${b.answer}」答案太长（${b.need}em > ${BLANK_MAX_EM}em），应把该空改成另留答题区（answerMode=zone）` });
        else warnsWidth.push(`第${b.i}空 ${b.width}em < 需 ${b.want}em（答案 ${b.need}em × ${CHILD_FACTOR}）「${b.answer}」（渲染时自动撑宽，跑 修宽 可把题干基线也补上）`);
      }
    }
  }

  /* ④ 图上作答：图里下笔的题不许留答题区 */
  if (mode === 'figure' && !fig) problems.push({ code: 'figure-nofig', msg: 'answerMode=figure 但题干里没有图' });
  if (!mode && n === 0 && figSuspect) {
    problems.push({ code: 'figure-unregistered', msg: '题干要求在图里填写/画出，但没登记 answerMode（应为 figure：不留答题区；若确实要另写文字，登记 zone）' });
  }
  /* ⑤ 自相矛盾
     ★ 2026-10-25 实测修正：`none` **允许**有空位——选择题/判断题的答案本来就是写在
       题干括号（`（　）`）里的，而括号在转录时常被写成 `<span class="blank">`。
       早一版把"none + 有空"判成矛盾，逼得一批选择题要么改 blank（卷面语义错），
       要么删空位（题干失真）。现在只保留真正矛盾的那条：blank 却数不到空。 */
  if (mode === 'blank' && n === 0) problems.push({ code: 'mode-blank-noslot', msg: 'answerMode=blank 但题干里数不到空位' });

  /* ⑥ 答案契约指纹：题干在登记答案之后被改过（措辞/图形变了但空数没变）⇒ 答案可能已不对。
     这是「声明（答案）vs 权威（题干）」的绑定，与盲解指纹分工（见文件上方注释）。
     老卡无指纹只告警不阻断：渐进式，靠 `刷指纹` 以当前题干为基线补齐。
     ⚠ 只能往 problems 里推；warns 在下面才声明，这里引用会 ReferenceError（本改动首跑实测踩到）。 */
  const curFp = answerContractFingerprint(stem);
  let fpWarn = '';
  if (raw.length > 0) {
    if (!it.answerSlotsFp) {
      fpWarn = '答案契约指纹未登记（老卡）——跑 `node _作答门禁.mjs 刷指纹` 以当前题干为基线补登记，此后改题干会被拦';
    } else if (String(it.answerSlotsFp) !== curFp) {
      problems.push({
        code: 'stem-changed',
        msg: `题干在登记答案之后被改过（指纹 ${String(it.answerSlotsFp)} → ${curFp}，登记于 ${it.answerSlotsFpAt || '未记'}）`
          + '——空数虽然还对得上，但措辞/图形变了，答案很可能已不对。**请复核答案**，确认无误后用 `补登` 重登记（会以当前题干为基线重新记指纹）。',
      });
    }
  }

  /* 归档卡：只报告不阻断（沿用本仓惯例），但要可见 */
  const archived = it.status === '已归档';
  /* 只报告不阻断的两类"契约覆盖不到的地方"（2026-10-25 子代理填报时实测提出）：
     ① 表格里整格空了却没写 blank span/下划线 —— 真门禁数不到它，答案就可能缺这一格
        （实测 P0016：原卷要补"弹簧测力计示数 F/N""绳端移动的距离 s/m"两个表头，题干里是两个空 <th>）；
     ② 空位以"同一处横线被拆成两段 span"的形式出现（P0079）—— 数得出但卷面上只有一处作答。
     两类都不算阻断（改题干有风险），但必须出现在扫描输出里，让人知道契约的边界在哪。 */
  const bareCells = n > 0 ? 0 : (function () {
    const cells = [...String(stem).matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
    let k = 0;
    for (const c of cells) { const inner = String(c[2]).replace(/<span class="blank"[^>]*><\/span>/g, '').replace(/\s|&nbsp;/g, ''); if (!inner) k++; }
    return k;
  })();
  const warns = [];
  if (fpWarn) warns.push(fpWarn);          // ⑥ 的指纹未登记提示（此处才拿得到 warns）
  if (bareCells > 0) warns.push(`表格里有 ${bareCells} 个空格子（不是 blank span/下划线，契约数不到；若那是作答处请在题干里补空位）`);
  for (const w of warnsWidth) warns.push(w);
  const ok = problems.length === 0;
  return { key: x.key, id: it.id, subject: x.subject, type: it.type || '', mode, scope, slots: n, answers: raw.length, fig, figSuspect, archived, ok, problems, warns,
    need: raw.map(a => needEm(a)), want: raw.map(a => blankWidthEm(a)), widths: slots.map(s => s.width) };
}

/* ---------- 回写（唯一写入入口） ----------
   ★ 2026-10-25 修（子代理实测报回）：原先 writeDecl 是"有值才写"的补丁式写入 ⇒
     把一张卡从 partial 改回 full 时，旧 `answerSlotsAt` **原样残留在索引里**，
     门禁继续按旧序号判红（decl 文件看着是对的、库里是脏的）。语义字段的"降级/清空"
     必须显式落空——这里统一做归一：非 partial 一律删 answerSlotsAt；重设 slots 时
     若没给 at，也按"没有 at"处理。 */
function writeDecl(x, d) {
  const j = readIndexFile(x.file);
  const it = x.holder.kind === 'items' ? j.items[x.holder.i] : j.subjects[x.holder.name].items[x.holder.i];
  if (!it || it.id !== x.item.id) fail(`定位失效：${x.key}（索引被并发改动？重跑即可）`);
  if (d.mode != null) { if (MODES.indexOf(String(d.mode)) < 0) fail(`mode 非法：${d.mode}`); it.answerMode = String(d.mode); }
  if (d.slots != null) {
    if (!Array.isArray(d.slots)) fail('slots 必须是数组');
    it.answerSlots = d.slots.map(v => String(v == null ? '' : v));
    if (!Array.isArray(d.at)) delete it.answerSlotsAt;          // 重设答案而未给序号 ⇒ 旧的必须清掉
  }
  if (d.scope != null) {
    if (!['full', 'partial'].includes(String(d.scope))) fail('scope 只能 full/partial');
    it.answerScope = String(d.scope);
    if (String(d.scope) === 'full' && !Array.isArray(d.at)) delete it.answerSlotsAt;   // ← 残留 bug 的根
  }
  if (d.at != null) {
    const arr = Array.isArray(d.at) ? d.at : String(d.at).split(/[,，\s]+/);
    it.answerSlotsAt = arr.map(Number).filter(n => n > 0);
    if (!it.answerSlotsAt.length) delete it.answerSlotsAt;      // at: [] 的语义是"清空"
  }
  if (d.note != null) { const s = String(d.note); if (s.trim()) it.answerNote = s; else delete it.answerNote; }
  it.answerSlotsBy = it.answerSlotsBy || 'agent';
  it.answerSlotsAt2 = today();     // 登记/复核日期（与"第几空"的 answerSlotsAt 是两回事，名字刻意分开）
  /* ★ 2026-10-27：登记答案即"以当前题干为基线"盖章——人是在看着这一版题干填答案的，
     所以这一刻的指纹就是"答案所依据的题干版本"。之后题干再变，judge() 就会红。 */
  it.answerSlotsFp = answerContractFingerprint(stemOf(x));
  it.answerSlotsFpAt = today();
  delete it.answerSlotsDate;       // 旧名兼容清理
  x.item.answerMode = it.answerMode; x.item.answerSlots = it.answerSlots; x.item.answerScope = it.answerScope;
  x.item.answerSlotsAt = it.answerSlotsAt; x.item.answerNote = it.answerNote;
  x.item.answerSlotsFp = it.answerSlotsFp; x.item.answerSlotsFpAt = it.answerSlotsFpAt;
  writeJsonAtomic(x.file, j, { backup: true });
  return it;
}

switch (action) {

  case '扫描': {
    const cards = allCards();
    const rows = cards.map(judge);
    const g = { 通过: 0, 阻断: 0, 归档跳过: 0 };
    for (const r of rows) {
      if (r.ok) g.通过++;
      else if (r.archived) g.归档跳过++;
      else g.阻断++;
    }
    for (const r of rows) {
      const flag = r.ok ? '✓' : (r.archived ? '·归档' : '⛔');
      if (r.ok && !r.warns.length) continue;                 // 只列有事的，别刷屏
      console.log(`${r.key.padEnd(12)} ${String(r.id).padEnd(6)} ${r.subject.padEnd(3)} ${flag} 空${r.slots}/登${r.answers} mode=${r.mode || '—'}`);
      for (const p of r.problems) console.log(`             ↳ ${p.msg}`);
      for (const w of r.warns) console.log(`             ⓘ ${w}`);
    }
    console.log(`\n合计 ${rows.length} 张：契约通过 ${g.通过}，阻断 ${g.阻断}，归档不阻断 ${g.归档跳过}`);
    /* 同题多卡（同一道原题被拆成两张卡分别记不同空）：组卷同时抽中就是一道题印两遍。
       只报告不阻断——这是"选卡"的问题，不是卡本身的问题。 */
    const byStem = new Map();
    for (const x of cards) {
      if (x.item.status === '已归档') continue;
      const k = plainText(stemOf(x)).replace(/\s+/g, '').slice(0, 200);
      if (k.length < 40) continue;
      if (!byStem.has(k)) byStem.set(k, []);
      byStem.get(k).push(x.key);
    }
    const dup = [...byStem.values()].filter(v => v.length > 1);
    if (dup.length) console.log(`\nⓘ 同题多卡（组卷时别同时抽中，否则一道题印两遍）：\n   ` + dup.map(v => v.join(' = ')).join('\n   '));
    if (g.阻断) console.log('  补法：node _作答门禁.mjs 工单 --out <目录> 生成逐卡工单，填好后 批量 --file <decl.json>');
    break;
  }

  case '清单': {
    const map = {};
    for (const r of allCards().map(judge)) map[r.key] = { slots: r.slots, answers: r.answers, mode: r.mode, ok: r.ok, state: r.ok ? 'ok' : (r.archived ? 'archived' : 'block'), problems: r.problems.map(p => p.code) };
    if (opt.json) { console.log(JSON.stringify(map)); break; }
    for (const k of Object.keys(map).sort()) {
      const v = map[k];
      console.log(`${k.padEnd(12)} 空${String(v.slots).padStart(2)} 登${String(v.answers).padStart(2)} ${String(v.mode || '—').padEnd(7)} ${v.state === 'ok' ? '✓' : (v.state === 'archived' ? '·归档' : '⛔')}${v.problems.length ? ' ' + v.problems.join(',') : ''}`);
    }
    break;
  }

  case '门禁': {
    const cards = allCards();
    const rows = cards.map(judge);
    const block = rows.filter(r => !r.ok && !r.archived);
    const archived = rows.filter(r => !r.ok && r.archived);
    const problems = block.map(r => `${r.key}[${r.problems.map(p => p.msg).join('；')}]`);
    if (opt.json) {
      console.log(JSON.stringify({
        ok: block.length === 0, action, problems, archivedSkipped: archived.map(r => r.key),
        stats: { total: rows.length, pass: rows.filter(r => r.ok).length, block: block.length },
        cards: Object.fromEntries(rows.map(r => [r.key, { slots: r.slots, answers: r.answers, mode: r.mode, ok: r.ok }])),
      }));
      if (block.length) process.exitCode = 1;
      break;
    }
    console.log(`作答契约：${rows.filter(r => r.ok).length}/${rows.length} 张已登记（阻断 ${block.length}）`);
    if (archived.length) console.log(`（已归档卡另有 ${archived.length} 张不合契约，只记录不阻断：${archived.slice(0, 10).map(r => r.key).join(' ')}${archived.length > 10 ? ' …' : ''}）`);
    if (block.length) {
      console.log(`⛔ 作答契约门禁未通过（${block.length} 张）：\n   ` + problems.join('\n   '));
      process.exitCode = 1;
    } else {
      console.log('作答契约门禁通过：每道有空的题都逐空给了答案，图里作答的题已标 figure，长答不塞横线。');
    }
    break;
  }

  case '工单': {
    const outDir = opt.out && opt.out !== true ? String(opt.out) : path.join(ROOT, '_作答工单');
    fs.mkdirSync(outDir, { recursive: true });
    const groups = new Map();
    for (const x of allCards()) {
      const r = judge(x);
      if (r.ok || r.archived) continue;
      const k = x.student + '|' + x.subject;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ x, r });
    }
    let files = 0;
    for (const [k, list] of groups) {
      const [student, subject] = k.split('|');
      const rows = [];
      for (const { x, r } of list) {
        const stem = stemOf(x);
        const sl = slotsOf(stem);
        const answers = Array.isArray(x.item.answerSlots) ? x.item.answerSlots.map(String) : [];
        /* 摊平到"第几空"，工单直接把「这个空答案多长、横线至少要几 em」写清楚，
           免得填报人再自己估（上一版就是这么估出 1.0 倍窄线的）。 */
        const aligned = String(x.item.answerScope || '') === 'partial'
          ? alignedAnswers(answers, x.item.answerSlotsAt, sl.length)
          : answers;
        rows.push({
          card: x.key, id: r.id, type: r.type, difficulty: x.item.difficulty || '',
          slots: r.slots,
          slotDetail: sl.map((s, i) => ({
            n: i + 1, kind: s.kind, widthEm: s.width,
            answer: aligned[i] == null ? '' : String(aligned[i]).slice(0, 40),
            needEm: aligned[i] == null || !String(aligned[i]) ? null : needEm(aligned[i]),
            wantEm: aligned[i] == null || !String(aligned[i]) ? null : blankWidthEm(aligned[i]),
          })),
          mode: r.mode || null,
          fig: r.fig, figSuspect: r.figSuspect,
          problems: r.problems.map(p => p.code + ':' + p.msg),
          currentAnswer: String(x.item.answer || ''),
          recordAnswer: recordAnswerOf(x.dirAbs),
          stemText: plainText(stem),
          stemHtmlPath: path.join(x.dirAbs, STEM_HTML),
          imgPath: path.join(x.dirAbs, '原卷截图.jpg'),
          recordPath: path.join(x.dirAbs, '错题记录.md'),
        });
      }
      const name = `${student}-${subject}`;
      fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(rows, null, 1) + '\n', 'utf8');
      files++;
    }
    console.log(`已生成 ${files} 份工单 → ${outDir}（逐卡含：空位数/每空宽度/题干/现有答案/缺什么）`);
    break;
  }

  case '补登': {
    if (!opt.card) fail('补登需要 --card 学生|编号');
    const cards = allCards();
    const hit = cards.filter(c => c.key === String(opt.card) || c.item.id === String(opt.card).toUpperCase());
    if (hit.length !== 1) fail(`卡片定位失败：${opt.card}（命中 ${hit.length} 张，请用 学生|编号）`);
    const slots = opt.slots ? String(opt.slots).split(/[；;]/).map(s => s.trim()) : undefined;
    writeDecl(hit[0], { mode: opt.mode, slots, scope: opt.scope, at: opt.at, note: opt.note });
    const r = judge(hit[0]);
    console.log(`${r.key} 已登记：mode=${r.mode || '—'} 空${r.slots}/登${r.answers} → ${r.ok ? '✓ 通过' : '⛔ 仍不合契约'}`);
    for (const p of r.problems) console.log('   ↳ ' + p.msg);
    break;
  }

  case '批量': {
    if (!opt.file || opt.file === true) fail('批量需要 --file <decl.json>');
    if (!fs.existsSync(opt.file)) fail('文件不存在：' + opt.file);
    const list = readJsonStrict(opt.file, { shape: j => Array.isArray(j), what: '数组', label: path.basename(opt.file) });
    const cards = allCards();
    const byKey = new Map(cards.map(c => [c.key, c]));
    let n = 0; const miss = [];
    for (const row of list) {
      const x = byKey.get(String(row.card));
      if (!x) { miss.push(row.card); continue; }
      writeDecl(x, { mode: row.mode, slots: row.slots, scope: row.scope, at: row.at, note: row.note });
      n++;
    }
    console.log(`已写回 ${n} 张卡的作答契约` + (miss.length ? `；未命中 ${miss.length} 张：${miss.slice(0, 10).join(' ')}` : ''));
    if (miss.length) process.exitCode = 1;
    break;
  }

  /* 刷指纹：给"已登记答案但没指纹"的老卡以**当前题干**为基线补登记（v2.7）。
     ⚠ 语义要说清：这是一个**假设**——它假设"现在的题干就是当初填答案时的那一版"。
       若题干其实已经改过而答案没跟上，本动作会把错误答案盖章成"有效"。
       所以必须一并落 `answerSlotsFpAssumed=true`，让"这条有效性是假设来的"永久可见，
       扫描/门禁单独计数，人不至于以为全库都真核过。 */
  case '刷指纹': {
    const all = allCards();
    let stamped = 0, already = 0, blocked = 0;
    for (const x of all) {
      const it = x.item;
      const raw = Array.isArray(it.answerSlots) ? it.answerSlots.filter(v => String(v == null ? '' : v).trim()) : [];
      if (!raw.length) continue;                       // 没登记答案的卡不盖章（盖章会掩盖"答案缺失"）
      if (it.answerSlotsFp) { already++; continue; }
      const r = judge(x);
      // 只给"除指纹外没有其它硬问题"的卡盖章：有真缺陷的卡必须先修，不能靠刷指纹变绿
      const hard = r.problems.filter(p => p.code !== 'stem-changed');
      if (hard.length) { blocked++; continue; }
      if (opt.dry) { console.log(`[dry] ${x.key} 会盖章 → ${answerContractFingerprint(stemOf(x))}`); continue; }
      const j = readIndexFile(x.file);
      const t = x.holder.kind === 'items' ? j.items[x.holder.i] : j.subjects[x.holder.name].items[x.holder.i];
      if (!t || t.id !== x.item.id) fail(`定位失效：${x.key}`);
      t.answerSlotsFp = answerContractFingerprint(stemOf(x));
      t.answerSlotsFpAt = today();
      t.answerSlotsFpAssumed = true;      // 假设基线：永远可见，不许悄悄当"已核实"
      writeJsonAtomic(x.file, j, { backup: true });
      stamped++;
    }
    console.log(opt.dry
      ? `[dry] 会盖章 ${stamped} 张（已有指纹 ${already}，有其它硬问题跳过 ${blocked}）`
      : `已盖章 ${stamped} 张（已有指纹 ${already}，有其它硬问题跳过 ${blocked}）。⚠ 这批是「假设当前题干＝填答案时那版」，不等于已复核；题干若曾改过请逐卡看答案。`);
    break;
  }

  case '修宽': {    /* 按声明答案把 题干.html 里过窄的空位改宽（数据侧兜底）。
       渲染器已经会按答案实时撑宽（model.js applySlotWidths，口径＝答案所需 × 1.5），
       这里是把"数据本身"也补齐，让任何离屏消费（导出 HTML、别的渲染器、直接看文件的人）
       不会重新踩窄线。★ 2026-10-25 晚用户二次报障（Y0003）后：目标宽度改成 blankWidthEm
       （needEm × 1.5），旧版撑到 1.0 倍等于"成人字迹刚好写满"，孩子写不下。
       ★ 同晚修：partial 合卡不再跳过——用 answerSlotsAt 摊平后按真实空号撑宽
       （旧版整卡跳过 ⇒ 那批合卡的横线永远是原始排版值，用户看到的就是"不够写"）。 */
    const all = allCards();
    let n = 0, need = 0;
    for (const x of all) {
      const it = x.item;
      const ans = Array.isArray(it.answerSlots) ? it.answerSlots.map(String) : null;
      if (!ans || !ans.length) continue;
      const stem = stemOf(x);
      const slotCountHere = slotsOf(stem).length;
      if (!slotCountHere) continue;
      const partial = String(it.answerScope || '') === 'partial';
      const aligned = partial ? alignedAnswers(ans, it.answerSlotsAt, slotCountHere) : ans;
      /* onlySpan：裸下划线串是正文的一部分，换成 span 会改纯净文本 ⇒ 盲解指纹整库失效
         （指纹对"纯文本+图形"取哈希）。所以写回文件时只动本来就是 span 的空位，
         裸下划线交给渲染器在内存里转（`M.stemBlankify`）。 */
      const next = applySlotWidths(stem, aligned, { onlySpan: true });
      if (next === stem) continue;
      need++;
      if (opt.dry) { console.log(`[dry] ${x.key} 的 span 空位会被改宽`); continue; }
      backupJson(path.join(x.dirAbs, STEM_HTML), { dir: path.join(ROOT, '_备份-真源'), keep: 4 });
      writeTextAtomic(path.join(x.dirAbs, STEM_HTML), next);
      n++;
    }
    console.log(opt.dry ? `[dry] 共 ${need} 张卡的空位会被改宽（去掉 --dry 即执行）` : `已改宽 ${n} 张卡的题干空位`);
    break;
  }

  default:
    console.log('未知动作：' + action + '\n可用：扫描 / 清单 / 门禁 / 工单 / 补登 / 批量 / 修宽 / 刷指纹');
    process.exitCode = 2;
}
