#!/usr/bin/env node
/**
 * 录题入库的三道新闸门（2026-11-05 建）
 *
 * 这三道闸门都是 2026-11-05 在真库上**实测踩到**之后补的，各自有对应的真实缺陷：
 *
 *  ① **裁图空白检测**（`_录题入库.mjs` 的 cropInkRatio）
 *     缺陷原形：AI 给的 bbox 偏了 0.05（框到「评价检测」标签而不是题目），
 *     入库器照单全收，裁出 1400×70 的**近全白**图（5967 字节），
 *     作答契约/配图/原卷溯源**三道门禁全绿**、卡照样进库 ——
 *     直到人点开「原卷截图」才发现框里没有题。
 *     判据：裁图非白像素占比。实测标定：框错的 2.59%、真实卡最低 14.07% ⇒ 阈值 5%。
 *
 *  ② **figBbox 必填**（hasFigure=true 却没给插图的位置）
 *     缺陷原形：契约只让 AI 给 `bbox`（整道题的位置），**没让 AI 说清"图在哪儿"**，
 *     程序无从裁出「题图.jpg」⇒「题干提到图、图却没落地」的卡混进库
 *     （实测 P0116 走马灯图 / P0117 扫地车图被配图门禁判「缺图」）。
 *
 *  ③ **配图如实登记**（不能再写假的"题干.html 内联 SVG"）
 *     缺陷原形：入库器一律写 kind='svg'、ref='题干.html 内联 SVG'，
 *     而 buildStemHtml() **只包纯文本**、永远产不出内联 SVG
 *     ⇒ 登记与实际资产不符 ⇒ 配图门禁被架空（它只查资产在不在）。
 *
 * 本用例在**临时库**上真跑 `_录题入库.mjs`：
 *   · ①②③ 各一条正向断言（该拦的拦住、该过的放过）；
 *   · ①②③ 各一条**阴性自证**（摘掉判据 ⇒ 对应断言当场变红）。
 *
 * 用法：node tests\neg-ingest-crop-and-figure.cjs
 * 退出码：0=全绿；1=有断言失败
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pngGray } = require('../scripts/png-cjs.cjs');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_录题入库.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-cropfig-'));
const LIB = path.join(TMP, 'lib');
/* 过程目录：独立的一份，不污染真实过程区（`_过程目录.mjs` 的落点可用 GLIMMERNOTE_PROC 覆盖） */
const PROC = path.join(TMP, 'proc');
fs.mkdirSync(PROC, { recursive: true });
const PROC_ENV = { GLIMMERNOTE_PROC: PROC };

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const norm = s => String(s || '').normalize('NFKC').replace(/\s+/g, '');

/** 造一张"有题"的图（大量黑像素）与一张"几乎全白"的图 */
function makeImages() {
  const dense = pngGray(600, 400, (x, y) => (x * 5 + y * 11) % 251);   // 题干块：非白占比高
  const blank = pngGray(600, 40, () => 250);                            // 空白条：非白占比≈0
  return { dense, blank };
}

/** 建一个最小可用的库：一个学生 + 数学学科 + 一张"整页原图" */
function makeLib(images) {
  const inbox = path.join(LIB, '_收件箱', '批次甲');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(LIB, '九年级', '数学'), { recursive: true });

  const pageAbs = path.join(inbox, '原卷页.png');
  fs.writeFileSync(pageAbs, images.dense);
  const pageSha = sha256(images.dense);

  fs.writeFileSync(path.join(LIB, '九年级', '数学', '_索引.json'), JSON.stringify({
    student: '学生甲', grade: '九年级', subject: '数学', items: [],
  }, null, 1) + '\n', 'utf8');

  /* 任务记录：已人工确认（第三层） */
  const taskId = 't-20260101-120000-aaaaaa';
  fs.mkdirSync(path.join(LIB, '_录题'), { recursive: true });
  fs.writeFileSync(path.join(LIB, '_录题', taskId + '.json'), JSON.stringify({
    schema: 'glimmernote.ingest-task/v1', taskId, createdAt: '2026-01-01T12:00:00+08:00',
    recipe: { id: 'ingest-page', version: '2.3.0', fingerprint: 'test' },
    cards: [], image: { sha256: pageSha, rel: '_收件箱/批次甲/原卷页.png' },
    subject: '数学', contractDigest: null, taskDigest: 'x', taskText: 'test',
    confirmedAt: '2026-01-01T12:01:00+08:00', confirmNote: 'test',
  }, null, 1) + '\n', 'utf8');

  return { pageAbs, pageSha, taskId };
}

/** 造一份 cards.json */
function makeCards(taskId, pageSha, extra) {
  const cards = [{
    subject: '数学', title: '合成题', source: '合成卷 · 第1题', sourceDate: '',
    questionText: '计算 1+1=____', studentAnswer: '3', answer: '2',
    answerSource: '独立判卷', answerSourceNote: 'test', teacherAnswer: '',
    causeCode: 'S1', causeNote: '算错', kpoints: ['加法'], difficulty: '易',
    hasFigure: false, confidence: 'high', sourceImageSha256: pageSha, notes: '',
    bbox: [0.1, 0.1, 0.8, 0.2], answerMode: 'blank', answerSlots: ['2'],
  }];
  Object.assign(cards[0], extra || {});
  return {
    envelope: { schema: 'glimmernote.ingest-result/v1', taskId, imageSha256: pageSha },
    result: { pageSummary: { totalQuestions: 1, markedWrong: 1, unmarked: 0, note: '' }, cards, skipped: [{ what: '全页', reason: '无' }] },
  };
}

function runLand(args, lib) {
  const r = spawnSync(process.execPath, [ENGINE, '入库', ...args, '--data', lib], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: LIB }, PROC_ENV),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/** 把 ENGINE 与它的兄弟模块复制到临时目录（变异体要独立跑） */
function copyEngine(mutSrc, dirName) {
  const deps = new Set();
  const queue = ['_录题入库.mjs'];
  while (queue.length) {
    const f = queue.shift();
    if (deps.has(f)) continue;
    const src = path.join(ROOT, 'src', 'tools', f);
    if (!fs.existsSync(src)) continue;
    deps.add(f);
    const body = f === '_录题入库.mjs' ? mutSrc : fs.readFileSync(src, 'utf8');
    for (const m of body.matchAll(/from\s+'\.\/([^']+\.mjs)'/g)) if (!deps.has(m[1])) queue.push(m[1]);
  }
  const dir = path.join(TMP, dirName);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of deps) fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(dir, f));
  const p = path.join(dir, '_录题入库.mjs');
  fs.writeFileSync(p, mutSrc, 'utf8');
  return p;
}

function main() {
  console.log('临时库：' + LIB + '\n引擎：' + path.relative(ROOT, ENGINE) + '\n');
  const images = makeImages();
  const { pageSha, taskId } = makeLib(images);
  const cardsFile = path.join(TMP, 'cards.json');
  fs.writeFileSync(cardsFile, JSON.stringify(makeCards(taskId, pageSha), null, 1), 'utf8');

  /* ═════ ① 裁图空白检测 ═════ */
  console.log('\n══ ① 裁图空白检测：bbox 框到空白 ⇒ 必须报警 + 撤掉裁图 ══');
  {
    /* 让原图**上下两半**：上半密（题），下半空白（标签区）。
       bbox 故意框下半 ⇒ 裁出来近全白。 */
    const half = path.join(TMP, 'halfpage.png');
    /* 用纯 Node 拼一张"上半密下半白"的 PNG：直接写两个 pngGray 再拼太麻烦，
       改用「改 bbox 指向空白条」的方式 —— 把 dense 图换成 blank 当整页。 */
    const blankPage = path.join(TMP, 'blankpage.png');
    fs.writeFileSync(blankPage, images.blank);
    /* 让任务指向 blank 页：改任务记录里的 sha 与 rel */
    const blankSha = sha256(images.blank);
    const t2 = JSON.parse(fs.readFileSync(path.join(LIB, '_录题', taskId + '.json'), 'utf8'));
    t2.image = { sha256: blankSha, rel: '_收件箱/批次甲/原卷页.png' };
    fs.writeFileSync(path.join(LIB, '_录题', taskId + '.json'), JSON.stringify(t2, null, 1), 'utf8');
    fs.writeFileSync(path.join(LIB, '_收件箱', '批次甲', '原卷页.png'), images.blank);

    const cf = path.join(TMP, 'cards-blank.json');
    fs.writeFileSync(cf, JSON.stringify(makeCards(taskId, blankSha, { bbox: [0.0, 0.0, 1.0, 1.0] }), null, 1), 'utf8');

    const r = runLand([taskId, '--file', cf, '--student', '学生甲', '--subject', '数学', '--dry'], LIB);
    const all = r.out + r.err;
    A('① 前置：入库真跑（dry）', r.code === 0, 'exit=' + r.code);
    A('★★ ① bbox 框到空白 ⇒ 报警并说清「撤掉这张裁图」',
      /空白/.test(all) && /撤掉这张裁图/.test(all),
      all.split('\n').filter(l => /空白|撤掉/.test(l)).slice(0, 2).join(' | ').slice(0, 160));

    /* 正向对照：密图 ⇒ 不报警 */
    const t3 = JSON.parse(fs.readFileSync(path.join(LIB, '_录题', taskId + '.json'), 'utf8'));
    t3.image = { sha256: pageSha, rel: '_收件箱/批次甲/原卷页.png' };
    fs.writeFileSync(path.join(LIB, '_录题', taskId + '.json'), JSON.stringify(t3, null, 1), 'utf8');
    fs.writeFileSync(path.join(LIB, '_收件箱', '批次甲', '原卷页.png'), images.dense);
    const cf2 = path.join(TMP, 'cards-dense.json');
    fs.writeFileSync(cf2, JSON.stringify(makeCards(taskId, pageSha, { bbox: [0.0, 0.0, 1.0, 1.0] }), null, 1), 'utf8');
    const r2 = runLand([taskId, '--file', cf2, '--student', '学生甲', '--subject', '数学', '--dry'], LIB);
    A('★ ① 正向对照：框到有内容的图 ⇒ 不报空白', !/几乎全是空白/.test(r2.out + r2.err),
      'exit=' + r2.code);
  }

  /* ═════ ② figBbox 必填 ═════ */
  console.log('\n══ ② figBbox 必填：hasFigure=true 却没给图的位置 ⇒ 必须拦下 ══');
  {
    const cf = path.join(TMP, 'cards-fig-no-bbox.json');
    fs.writeFileSync(cf, JSON.stringify(makeCards(taskId, pageSha, { hasFigure: true, questionText: '如图所示，____' }), null, 1), 'utf8');
    const r = runLand([taskId, '--file', cf, '--student', '学生甲', '--subject', '数学', '--dry'], LIB);
    const all = r.out + r.err;
    A('★★ ② hasFigure=true 没给 figBbox ⇒ 入库被拒（前置检查不通过）',
      r.code !== 0 && /figBbox/.test(all),
      'exit=' + r.code + ' ' + (all.match(/figBbox[^\n]*/) || [''])[0].slice(0, 120));

    /* 正向对照：给了 figBbox ⇒ 放行，并裁出题图.jpg */
    const cf2 = path.join(TMP, 'cards-fig-ok.json');
    fs.writeFileSync(cf2, JSON.stringify(makeCards(taskId, pageSha, { hasFigure: true, figBbox: [0.1, 0.1, 0.5, 0.5] }), null, 1), 'utf8');
    const r2 = runLand([taskId, '--file', cf2, '--student', '学生甲', '--subject', '数学', '--dry'], LIB);
    A('★ ② 正向对照：给了 figBbox ⇒ 入库通过', r2.code === 0, 'exit=' + r2.code + ' ' + (r2.out + r2.err).split('\n').slice(-2).join(' | ').slice(0, 160));
  }

  /* ═════ ③ 配图如实登记（不能再写假的"内联 SVG"） ═════ */
  console.log('\n══ ③ 配图登记：kind 必须是门禁认识的取值，且与实际资产一致 ══');
  {
    /* 跑一次带 figBbox 的入库（非 dry），然后查配图台账 */
    const cf = path.join(TMP, 'cards-fig-ok.json');
    const r = runLand([taskId, '--file', cf, '--student', '学生甲', '--subject', '数学'], LIB);
    A('③ 前置：入库真跑（非 dry）', r.code === 0, 'exit=' + r.code + ' ' + (r.out + r.err).split('\n').slice(-3).join(' | ').slice(0, 200));
    const ledFile = path.join(LIB, '_配图台账.json');
    let led = null;
    try { led = JSON.parse(fs.readFileSync(ledFile, 'utf8')); } catch { }
    const key = Object.keys((led && led.cards) || {}).find(k => /\|M\d+$/.test(k));
    const entry = key ? led.cards[key] : null;
    A('★ ③ 配图台账有这张卡的登记', !!entry, 'key=' + key);
    A('★★ ③ kind 落在门禁认识的取值里（svg|jpg|none），不是自造值',
      entry && ['svg', 'jpg', 'none'].includes(entry.kind), 'kind=' + (entry && entry.kind));
    A('★ ③ need 是布尔（不能是字符串 "true"）', entry && typeof entry.need === 'boolean', 'need=' + (entry && JSON.stringify(entry.need)));
    /* 题图.jpg 真的落地了？（登记说 jpg ⇒ 目录里就该有这个文件） */
    if (entry && entry.kind === 'jpg') {
      const idx = JSON.parse(fs.readFileSync(path.join(LIB, '九年级', '数学', '_索引.json'), 'utf8'));
      const it = (idx.items || [])[0];
      const dir = it ? path.join(LIB, '九年级', '数学', it.dir) : '';
      A('★★ ③ 登记说"题图.jpg" ⇒ 卡目录里真有这张图',
        dir && fs.existsSync(path.join(dir, '题图.jpg')), dir || '(没卡目录)');
    }
  }

  /* ═════ ①②③ 各自的阴性自证 ═════ */
  console.log('\n══ ④ 阴性自证：摘掉判据 ⇒ 对应断言当场变红 ══');
  {
    const ORIG = fs.readFileSync(ENGINE, 'utf8');

    /* ④-a 摘掉空白检测（**两处**：入库路径 + 改卡路径；只改一处会留下另一处 ⇒ 断言不变红） */
    const ANCHOR_A = 'const ink = cropInkRatio(path.join(abs, \'原卷截图.jpg\'));';
    const hitsA = ORIG.split(ANCHOR_A).length - 1;
    A('④-a 前置：空白检测锚点存在（入库路径 + 改卡路径 = 2 处）', hitsA === 2, '出现 ' + hitsA + ' 次');
    if (hitsA >= 1) {
      /* 两处都换掉（replace 只换第一处 ⇒ 用 split/join 全换） */
      const mut = ORIG.split(ANCHOR_A).join('const ink = 0.99;   // 变异：假装永远不是空白');
      const mutEngine = copyEngine(mut, 'mut-a');
      const chk = spawnSync(process.execPath, ['--check', mutEngine], { encoding: 'utf8' });
      A('④-a 前置：变异体语法自检通过', chk.status === 0, String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));
      A('④-a 前置：两处都变异掉了', mut.split('变异：假装永远不是空白').length - 1 === 2,
        '变异处数=' + (mut.split('变异：假装永远不是空白').length - 1));
      /* 空白页入库 ⇒ 变异体不再报警 ⇒ 断言① 会变红 */
      const t = JSON.parse(fs.readFileSync(path.join(LIB, '_录题', taskId + '.json'), 'utf8'));
      const blankSha = sha256(images.blank);
      t.image = { sha256: blankSha, rel: '_收件箱/批次甲/原卷页.png' };
      fs.writeFileSync(path.join(LIB, '_录题', taskId + '.json'), JSON.stringify(t, null, 1), 'utf8');
      fs.writeFileSync(path.join(LIB, '_收件箱', '批次甲', '原卷页.png'), images.blank);
      const cf = path.join(TMP, 'cards-blank.json');
      const r = spawnSync(process.execPath, [mutEngine, '入库', taskId, '--file', cf, '--student', '学生甲', '--subject', '数学', '--dry', '--data', LIB], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: Object.assign({}, process.env, { CTB_DATA: LIB }, PROC_ENV),
      });
      const all = String(r.stdout || '') + String(r.stderr || '');
      A('★★ ④-a 阴性自证：旧逻辑下**不再**报空白（即断言★① 会当场变红）',
        !/几乎全是空白/.test(all), 'exit=' + r.status);
    }

    /* ④-b 摘掉 figBbox 必填检查 */
    const ANCHOR_B = 'if (c.hasFigure === true && c.figBbox === undefined) {';
    const hitsB = ORIG.split(ANCHOR_B).length - 1;
    A('④-b 前置：figBbox 必填锚点存在', hitsB === 1, '出现 ' + hitsB + ' 次');
    if (hitsB === 1) {
      const mut = ORIG.replace(ANCHOR_B, 'if (false && c.hasFigure === true && c.figBbox === undefined) {');
      const mutEngine = copyEngine(mut, 'mut-b');
      const chk = spawnSync(process.execPath, ['--check', mutEngine], { encoding: 'utf8' });
      A('④-b 前置：变异体语法自检通过', chk.status === 0, String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));
      /* 恢复密图 */
      const t = JSON.parse(fs.readFileSync(path.join(LIB, '_录题', taskId + '.json'), 'utf8'));
      t.image = { sha256: pageSha, rel: '_收件箱/批次甲/原卷页.png' };
      fs.writeFileSync(path.join(LIB, '_录题', taskId + '.json'), JSON.stringify(t, null, 1), 'utf8');
      fs.writeFileSync(path.join(LIB, '_收件箱', '批次甲', '原卷页.png'), images.dense);
      const cf = path.join(TMP, 'cards-fig-no-bbox.json');
      const r = spawnSync(process.execPath, [mutEngine, '入库', taskId, '--file', cf, '--student', '学生甲', '--subject', '数学', '--dry', '--data', LIB], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: Object.assign({}, process.env, { CTB_DATA: LIB }, PROC_ENV),
      });
      const all = String(r.stdout || '') + String(r.stderr || '');
      A('★★ ④-b 阴性自证：旧逻辑下缺 figBbox 也放行（即断言★★② 会当场变红）',
        r.status === 0 && !/缺必填字段「figBbox」/.test(all) && !/入库前置检查不通过/.test(all),
        'exit=' + r.status + ' ' + all.split('\n').filter(l => /figBbox|前置检查/.test(l)).slice(0, 1).join('').slice(0, 110));
    }

    /* ④-c 摘掉"如实登记"（改回假的 kind='svg'）—— 两处（入库路径 + 改卡路径） */
    const ANCHOR_C = "const figKind = stemHasSvg ? 'svg' : (hasFigFile ? 'jpg' : 'none');";
    const hitsC = ORIG.split(ANCHOR_C).length - 1;
    A('④-c 前置：如实登记锚点存在（入库路径 + 改卡路径 = 2 处）', hitsC === 2, '出现 ' + hitsC + ' 次');
    if (hitsC >= 1) {
      const mut = ORIG.split(ANCHOR_C).join("const figKind = 'svg';   // 变异：写回假的内联 SVG");
      const mutEngine = copyEngine(mut, 'mut-c');
      const chk = spawnSync(process.execPath, ['--check', mutEngine], { encoding: 'utf8' });
      A('④-c 前置：变异体语法自检通过', chk.status === 0, String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));
      /* 清掉已建的卡，**并换一个新的任务号** ——
         同一个任务重复入库会被幂等跳过（同一 digest 不许造第二张同样的卡），
         那样根本走不到"写配图登记"那步，断言就测不到真东西。 */
      const ledFile = path.join(LIB, '_配图台账.json');
      try { fs.unlinkSync(ledFile); } catch { }
      const task2 = 't-20260101-130000-bbbbbb';
      fs.writeFileSync(path.join(LIB, '_录题', task2 + '.json'), JSON.stringify({
        schema: 'glimmernote.ingest-task/v1', taskId: task2, createdAt: '2026-01-01T13:00:00+08:00',
        recipe: { id: 'ingest-page', version: '2.3.0', fingerprint: 'test' },
        cards: [], image: { sha256: pageSha, rel: '_收件箱/批次甲/原卷页.png' },
        subject: '数学', contractDigest: null, taskDigest: 'x', taskText: 'test',
        confirmedAt: '2026-01-01T13:01:00+08:00', confirmNote: 'test',
      }, null, 1) + '\n', 'utf8');
      const cf2 = path.join(TMP, 'cards-fig-ok2.json');
      fs.writeFileSync(cf2, JSON.stringify(makeCards(task2, pageSha, { hasFigure: true, figBbox: [0.1, 0.1, 0.5, 0.5] }), null, 1), 'utf8');
      const r = spawnSync(process.execPath, [mutEngine, '入库', task2, '--file', cf2, '--student', '学生甲', '--subject', '数学', '--data', LIB], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: Object.assign({}, process.env, { CTB_DATA: LIB }, PROC_ENV),
      });
      let led2 = null;
      try { led2 = JSON.parse(fs.readFileSync(ledFile, 'utf8')); } catch { }
      const k2 = Object.keys((led2 && led2.cards) || {}).find(k => /\|M\d+$/.test(k));
      const e2 = k2 ? led2.cards[k2] : null;
      const outC = String(r.stdout || '') + String(r.stderr || '');
      /* ⚠ 判据看的是**过程目录里的声明文件**（入库器写给配图门禁的那份），
         而不是台账 —— 因为变异后 kind='svg' 而目录里没有内联 SVG，
         配图门禁会**当场判红** ⇒ 入库整体回滚 ⇒ 台账根本不会写。
         那恰恰说明「假的 kind=svg」会被门禁抓住（好事），但它证明不了"登记是否如实"。
         声明文件才是"入库器写了什么"的直接证据。 */
      /* 声明文件落在**过程目录**（`_过程目录.mjs` 的唯一落点：
         GLIMMERNOTE_PROC → %LOCALAPPDATA%\拾光小册\proc → 临时目录）。
         本用例给子进程设一个**独立的**过程目录，不污染真实过程区。 */
      const procDir = path.join(TMP, 'proc');
      fs.mkdirSync(procDir, { recursive: true });
      let decl = null;
      try {
        /* ⚠ 按**修改时间倒序**取最新的声明文件 ——
           过程目录里堆着历次运行留下的声明（文件名带 taskId），
           取"第一个匹配"会拿到旧任务的那份（kind 还是 jpg）⇒ 断言测的不是本次变异。 */
        const files = fs.readdirSync(procDir)
          .filter(f => /^录题入库-配图-.*\.json$/.test(f))
          .map(f => ({ f, mt: fs.statSync(path.join(procDir, f)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt);
        for (const { f } of files) {
          const arr = JSON.parse(fs.readFileSync(path.join(procDir, f), 'utf8'));
          const row = (arr || []).find(x => /\|M\d+$/.test(x.card));
          if (row) { decl = row; break; }
        }
      } catch { }
      A('★★ ④-c 阴性自证：旧逻辑下写给门禁的声明是假的 kind=svg（即断言★★③ 会当场变红）',
        !!decl && decl.kind === 'svg',
        '声明kind=' + (decl && decl.kind) + ' 台账kind=' + (e2 && e2.kind) + ' exit=' + r.status);
    }

    A('④ 仓库里的真源码未被改动（变异只在临时副本上做）', fs.readFileSync(ENGINE, 'utf8') === ORIG);
  }

  console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}`);
}

try {
  main();
} catch (e) {
  fail++;
  console.log('[FAIL] 用例自身抛错：' + (e && e.stack || e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
}
process.exit(fail ? 1 : 0);
