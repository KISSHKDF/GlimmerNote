#!/usr/bin/env node
/**
 * M0070 报障（2026-11-22）三条修复的阴性对照：**图在卡目录里，整条显示/盲解链却看不见它**。
 *
 * 根因三处：
 *   ① `生成状态.mjs` 派生 fig 只探测「配图.svg」（全库 0 个）；入库器裁出的叫「题图.jpg」
 *      ⇒ 60 张带 jpg 题图的卡 fig 恒为 null，前端 stemHtmlSafe 的 fig 兜底永不触发。
 *   ② `_盲解复核.mjs` 清稿只对题干里**内联 <svg>** 插图形区域占位（stemToText），
 *      jpg 图卡的清稿连"这题有图"都不声明 ⇒ 解题者按纯文字题解。
 *   ③ `_盲解复核.mjs` 门禁的图形层检查写作 `if (action === '双路')`，位于 `状态/门禁` case
 *      ⇒ 恒假死代码，图形层缺失从未进过 problems。
 *
 * 本用例全部跑在**自构造临时库**上（不依赖真库形态），三段各带阴性自证：
 *   A 生成状态 fig 探测：题图.jpg 优先 / 配图.svg 兜底 / 都没有 ⇒ null；
 *     变异自证：把探测改回只认 配图.svg ⇒ jpg 卡 fig 必然变 null（原缺陷复现）。
 *   B 清稿占位：jpg 图卡（题干无内联 svg）清稿必须出现图形缺失声明；内联 svg 卡不重复提示。
 *     变异自证：摘掉占位逻辑 ⇒ 清稿回到无声无息（原缺陷复现）。
 *   C 门禁图形层：新批次（两路 at ≥ 切换日）缺 layer='fig' ⇒ 门禁 --json 必须点名且 exit 1；
 *     历史批次（at < 切换日）只 ⚠ 计数不拦；带 layer 的卡不拦。
 *
 * 退出码 0=对照成立；1=对照失败。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
const TOOLS = E.TOOLS;
let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

/** 自构造最小库：一个学生/学科/卡，卡片文件按需放置；返回库根 */
function makeLib(t) {
  const dir = E.allocTempDir('gn-fig-chain-');
  fs.mkdirSync(path.join(dir, '小图', '数学', t.dir), { recursive: true });
  /* 题干指纹按真实算法预计算（stemToText('…') 的纯文本 + '\0' + 空图形签名），
     让带台账的卡合成态是「已通过·有效」，门禁只考图形层这一件事。 */
  /* 门禁用例的卡：无 题干.html ⇒ stemOf 走「索引 question」；指纹按该文本预计算对齐 */
  const gateStem = String(t.stemText || '如图，求证。');
  const fp = require('crypto').createHash('sha256')
    .update((gateStem + '\u0000').replace(/\s+/g, ' ').trim(), 'utf8').digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(dir, '小图', '数学', '_索引.json'), JSON.stringify({
    student: '小图', grade: '九年级', subject: '数学', updatedAt: '2026-11-22T00:00:00+08:00',
    items: [{
      id: t.id, dir: t.dir, source: '测试', type: '几何', question: gateStem, answer: '略',
      status: '在册', hasImage: !!t.figJpg, blindStatus: t.blindStatus || '未盲解',
      blindFingerprint: t.lanes ? fp : '', blindFingerprintVer: 2, blindSolveAt: '', blindSolver: '', blindNote: '',
      reviews: [],
    }],
  }, null, 1), 'utf8');
  if (t.figJpg) fs.writeFileSync(path.join(dir, '小图', '数学', t.dir, '题图.jpg'), 'FAKE-JPEG-' + t.id, 'utf8');
  if (t.figSvg) fs.writeFileSync(path.join(dir, '小图', '数学', t.dir, '配图.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="8"/></svg>', 'utf8');
  if (t.stemHtml !== undefined) fs.writeFileSync(path.join(dir, '小图', '数学', t.dir, '题干.html'), t.stemHtml, 'utf8');
  if (t.lanes) {
    fs.writeFileSync(path.join(dir, '_盲解双路.json'), JSON.stringify({ note: '测试', lanes: t.lanes }, null, 1), 'utf8');
  }
  return dir;
}

/** 跑生成状态 --out -，解析 stdout 里该卡的 fig 字段 */
function figOf(lib, id) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(TOOLS, '生成状态.mjs'), '--out', '-', '--quiet'], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { CTB_DATA: lib }),
    });
  } catch (e) {
    throw new Error('生成状态 exit=' + e.status + ' stderr=' + String(e.stderr || '').slice(0, 300));
  }
  const j = JSON.parse(out);
  /* 卡片住在 data[].subjects[].items[]（生成状态.mjs 的组装形状） */
  const figs = [];
  for (const s of (j.data || [])) for (const sub of (s.subjects || [])) for (const k of (sub.items || [])) figs.push(k);
  const card = figs.find(c => c.id === id);
  return card ? card.fig : undefined;
}

/** 跑盲解门禁 --json，返回信封（exit 1 也算正常返回） */
function gate(lib, extra) {
  let out = '', code = -1;
  try {
    out = execFileSync(process.execPath, [path.join(TOOLS, '_盲解复核.mjs'), '门禁', '--json', ...(extra || [])], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { CTB_DATA: lib }),
    });
    code = 0;
  } catch (e) {
    out = String(e.stdout || '');
    code = e.status == null ? -1 : e.status;
    if (!out.trim()) throw new Error('门禁崩溃 exit=' + code + ' stderr=' + String(e.stderr || '').slice(0, 300));
  }
  return { code, env: JSON.parse(out.trim()) };
}

/* ════════ A · 生成状态 fig 探测 ════════ */
console.log('\n═══ A · 生成状态.mjs fig 探测（题图.jpg 优先 / 配图.svg 兜底） ═══');
{
  const libA = makeLib({ id: 'M0901', dir: 'M0901-只用题图jpg', figJpg: true, stemHtml: '<p>如图，求证三角形全等。</p>' });
  A('A1 jpg 图卡：fig = 题图.jpg（修前恒 null）', figOf(libA, 'M0901') !== null && /题图\.jpg$/.test(decodeURIComponent(figOf(libA, 'M0901'))),
    String(figOf(libA, 'M0901')));

  const libB = makeLib({ id: 'M0902', dir: 'M0902-只用配图svg', figSvg: true, stemHtml: '<p>如图。</p>' });
  A('A2 svg 老资产：fig = 配图.svg（兜底保留，fixture 链路不破）', /配图\.svg$/.test(decodeURIComponent(figOf(libB, 'M0902'))),
    String(figOf(libB, 'M0902')));

  const libC = makeLib({ id: 'M0903', dir: 'M0903-无图', stemHtml: '<p>无图题。</p>' });
  A('A3 无图卡：fig = null', figOf(libC, 'M0903') === null, String(figOf(libC, 'M0903')));

  const libD = makeLib({ id: 'M0904', dir: 'M0904-双资产', figJpg: true, figSvg: true, stemHtml: '<p>双资产。</p>' });
  A('A4 两名并存：题图.jpg 优先', /题图\.jpg$/.test(decodeURIComponent(figOf(libD, 'M0904'))), String(figOf(libD, 'M0904')));

  /* 阴性自证：变异体 = 把探测钉成 false ⇒ jpg 卡 fig 必须变 null（原缺陷复现；svg 兜底分支不受影响） */
  const src = fs.readFileSync(path.join(TOOLS, '生成状态.mjs'), 'utf8');
  const anchor = 'const figJpg = fs.existsSync(figJpgAbs);';
  A('A5 判据锚点在源码里', src.includes(anchor) && src.includes("path.join(ROOT, cardDirRel, '题图.jpg')"), '');
  const mut = src.replace(anchor, 'const figJpg = false; /* MUTATED */');
  const mutDir = E.allocTempDir('gn-fig-chain-mut-');
  /* ⚠ 生成状态.mjs 除静态 import 外，运行期还会 spawn 四个门禁通道工具（runChannel），
     只复制静态闭包会「缺少工具 _盲解复核.mjs」——五个一起复制。 */
  E.copyToolDeps(['生成状态.mjs', '_盲解复核.mjs', '_待确认.mjs', '_配图门禁.mjs', '_标记复习.mjs'], mutDir);
  fs.writeFileSync(path.join(mutDir, '生成状态.mjs'), mut, 'utf8');
  let mutOut = '';
  try {
    mutOut = execFileSync(process.execPath, [path.join(mutDir, '生成状态.mjs'), '--out', '-', '--quiet'], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { CTB_DATA: libA }),
    });
  } catch (e) { mutOut = String(e.stdout || ''); if (!mutOut.trim()) throw e; }
  const mutFig = (() => { try { const j = JSON.parse(mutOut); const figs = []; for (const s of (j.data || [])) for (const sub of (s.subjects || [])) for (const k of (sub.items || [])) figs.push(k); const c = figs.find(c => c.id === 'M0901'); return c ? c.fig : undefined; } catch (e2) { return 'PARSE-FAIL:' + String(e2.message).slice(0, 80); } })();
  A('A6 ★ 变异自证：探测退回只认配图.svg ⇒ jpg 卡 fig 变 null（原缺陷复现）', mutFig === null, String(mutFig));
}

/* ════════ B · 清稿图形占位 ════════ */
console.log('\n═══ B · 清稿对 jpg 图卡必须声明"本题配有图形" ═══');
{
  const lib = makeLib({
    id: 'M0905', dir: 'M0905-清稿占位', figJpg: true, blindStatus: '待双路',
    stemHtml: '<p>如图，抛物线与双曲线交于点A、B。</p>',
  });
  const r = E.runToolSync('_盲解复核.mjs', ['清稿', '--student', '小图', '--subject', '数学', '--ids', 'M0905', '--all'], { data: lib });
  A('B1 清稿生成成功', r.code === 0, 'exit=' + r.code + ' ' + (r.out + r.err).slice(0, 160));
  const blindDir = path.join(lib, '_盲解');
  const names = fs.existsSync(blindDir) ? fs.readdirSync(blindDir).filter(n => /小图-数学-盲解清稿/.test(n)) : [];
  A('B2 清稿文件已落盘', names.length >= 1, names.join('、'));
  const txt = names.length ? fs.readFileSync(path.join(blindDir, names[0]), 'utf8') : '';
  A('B3 ★ jpg 图卡清稿含图形缺失声明（修前：连"有图"都不说）',
    /本题配有图形（题图\.jpg）/.test(txt), (txt.match(/【本题配有图形[^\n]*/g) || ['(无)'])[0]);
  A('B4 声明要求解题者把图形缺失写进疑点', /图形缺失/.test(txt), '');

  /* 内联 SVG 卡：stemToText 已换成图形区域占位 ⇒ 不重复提示 */
  const libSvg = makeLib({
    id: 'M0906', dir: 'M0906-内联svg', blindStatus: '待双路',
    stemHtml: '<p>如图。</p><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
  });
  const r2 = E.runToolSync('_盲解复核.mjs', ['清稿', '--student', '小图', '--subject', '数学', '--ids', 'M0906', '--all'], { data: libSvg });
  A('B5 内联 svg 清稿生成成功', r2.code === 0, 'exit=' + r2.code);
  const names2 = fs.existsSync(path.join(libSvg, '_盲解')) ? fs.readdirSync(path.join(libSvg, '_盲解')).filter(n => /小图-数学-盲解清稿/.test(n)) : [];
  const txt2 = names2.length ? fs.readFileSync(path.join(libSvg, '_盲解', names2[0]), 'utf8') : '';
  A('B6 ★ 内联 svg 卡不重复提示（stemToText 已有图形区域占位）',
    /图形区域/.test(txt2) && !/本题配有图形（题图\.jpg）/.test(txt2), '含图形区域占位=' + /图形区域/.test(txt2));

  /* 阴性自证：变异体 = 摘掉占位逻辑 ⇒ jpg 图卡清稿回到无声无息 */
  const src = fs.readFileSync(path.join(TOOLS, '_盲解复核.mjs'), 'utf8');
  const anchor = 'if (isFigureCard(x.dirAbs) && !announced) {';
  A('B7 判据锚点在源码里', src.includes(anchor), '');
  const mut = src.replace(anchor, 'if (false && isFigureCard(x.dirAbs) && !announced) { /* MUTATED */');
  const mutDir = E.allocTempDir('gn-fig-mut2-');
  E.copyToolDeps(['_盲解复核.mjs'], mutDir);
  fs.writeFileSync(path.join(mutDir, '_盲解复核.mjs'), mut, 'utf8');
  const mr = spawnSync(process.execPath, [path.join(mutDir, '_盲解复核.mjs'), '清稿', '--student', '小图', '--subject', '数学', '--ids', 'M0905', '--all'], {
    encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_DATA: lib }),
  });
  const mutTxt = (mr.status === 0 || (mr.stdout || '').trim()) ? (mr.stdout || '') : '';
  const mutNames = fs.existsSync(blindDir) ? fs.readdirSync(blindDir).filter(n => /小图-数学-盲解清稿/.test(n)) : [];
  const mutFile = mutNames.length ? fs.readFileSync(path.join(blindDir, mutNames[0]), 'utf8') : '';
  A('B8 ★ 变异自证：摘掉占位 ⇒ 清稿不再声明图形（原缺陷复现）', !/本题配有图形/.test(mutFile), 'exit=' + mr.status);
}

/* ════════ C · 门禁图形层：死代码复活 + 新批次硬拦 ════════ */
console.log('\n═══ C · 门禁图形层检查（原 if(action===\'双路\') 恒假死代码） ═══');
const CUT = '2026-11-22';
{
  /* 新批次（两路 at >= 切换日）缺图形层 → 必须拦 */
  const libNew = makeLib({
    id: 'M0907', dir: 'M0907-新批次无图形层', figJpg: true, blindStatus: '已通过',
    lanes: {
      '小图|M0907': {
        lane1: { verdict: '已通过', at: '2026-11-25', solver: 't1', note: '', fp: 'aaaaaaaaaaaa', fpVer: 2 },
        lane2: { verdict: '已通过', at: '2026-11-26', solver: 't2', note: '', fp: 'aaaaaaaaaaaa', fpVer: 2 },
      },
    },
  });
  const g1 = gate(libNew);
  A('C1 ★ 新批次图形题缺 layer=fig：门禁 exit 1（修前死代码恒放行）', g1.code === 1, 'exit=' + g1.code);
  A('C2 problems 点名了这张卡', (g1.env.problems || []).some(p => /小图\|M0907\[图形题缺图形层记录\]/.test(p)),
    (g1.env.problems || []).join(' ; '));

  /* ★ 2026-11-23（用户裁定「最后都要通过双路盲解」）：口径从「**至少一路** layer=fig」
     升级为「**两路都** layer=fig」。
     理由：只有一路看过图时，若两路结论打架，无法判断是「图有问题」还是「那一路没读图」——
     双路都读图才能互为对照。旧口径下 C3（任一路有 fig 即放行）现在**必须拦**。 */
  const libOneOnly = makeLib({
    id: 'M0908', dir: 'M0908-只有一路带图形层', figJpg: true, blindStatus: '已通过',
    lanes: {
      '小图|M0908': {
        lane1: { verdict: '已通过', at: '2026-11-25', solver: 't1', note: '', fp: 'bbbbbbbbbbbb', fpVer: 2, layer: 'fig' },
        lane2: { verdict: '已通过', at: '2026-11-26', solver: 't2', note: '', fp: 'bbbbbbbbbbbb', fpVer: 2 },
      },
    },
  });
  const g2 = gate(libOneOnly);
  const figProblems2 = (g2.env.problems || []).filter(p => /只有一路跑了图形层/.test(p));
  A('C3 ★ 只有一路跑图形层的新批次：门禁 exit 1（两路都必须读图）',
    g2.code === 1 && figProblems2.length > 0,
    'exit=' + g2.code + ' problems=' + figProblems2.join(';'));

  /* 两路都带图形层 → 放行 */
  const libBoth = makeLib({
    id: 'M0910', dir: 'M0910-两路带图形层', figJpg: true, blindStatus: '已通过',
    lanes: {
      '小图|M0910': {
        lane1: { verdict: '已通过', at: '2026-11-25', solver: 't1', note: '', fp: 'dddddddddddd', fpVer: 2, layer: 'fig' },
        lane2: { verdict: '已通过', at: '2026-11-26', solver: 't2', note: '', fp: 'dddddddddddd', fpVer: 2, layer: 'fig' },
      },
    },
  });
  const g2b = gate(libBoth);
  const figProblems2b = (g2b.env.problems || []).filter(p => /图形层/.test(p));
  A('C3b ★ 两路都跑图形层：门禁 exit 0（不拦）',
    g2b.code === 0 && figProblems2b.length === 0,
    'exit=' + g2b.code + ' problems=' + figProblems2b.join(';'));

  /* 历史批次（at < 切换日）缺图形层 → ⚠ 计数不拦（不打破存量门禁绿态） */
  const libOld = makeLib({
    id: 'M0909', dir: 'M0909-历史批次', figJpg: true, blindStatus: '已通过',
    lanes: {
      '小图|M0909': {
        lane1: { verdict: '已通过', at: '2026-11-01', solver: 't1', note: '', fp: 'cccccccccccc', fpVer: 2 },
        lane2: { verdict: '已通过', at: '2026-11-02', solver: 't2', note: '', fp: 'cccccccccccc', fpVer: 2 },
      },
    },
  });
  const g3 = gate(libOld);
  A('C4 ★ 历史批次缺图形层：门禁仍 exit 0（存量不拦，meta 计数可见）',
    g3.code === 0 && (g3.env.problems || []).every(p => !/图形题缺图形层记录/.test(p)),
    'exit=' + g3.code + ' meta=' + JSON.stringify(g3.env.meta || {}));
  A('C5 meta.figLayerMissing = 1（历史欠账可见，不放行也不拦）', (g3.env.meta || {}).figLayerMissing === 1,
    'meta.figLayerMissing=' + (g3.env.meta || {}).figLayerMissing);

  /* 门禁 --json 与人类模式同码同判（门禁五律） */
  const h = E.runToolSync('_盲解复核.mjs', ['门禁'], { data: libNew });
  A('C6 人类模式同码：新批次缺图形层也 exit 1', h.code === 1, 'exit=' + h.code);
  A('C7 人类输出点名了图形层缺口', /图形题缺"图形层"记录/.test(h.out), '');

  /* 阴性自证：变异体 = 恢复 `if (action === '双路')` 恒假写法 ⇒ 门禁必须回到 exit 0（原缺陷复现） */
  const src = fs.readFileSync(path.join(TOOLS, '_盲解复核.mjs'), 'utf8');
  const anchor = "if (action === '门禁') {\n      const FIG_LAYER_CUTOVER";
  A('C8 判据锚点在源码里', src.includes(anchor), '');
  const mut = src.replace(anchor, "if (action === '双路') {\n      const FIG_LAYER_CUTOVER");
  const mutDir = E.allocTempDir('gn-fig-mut3-');
  E.copyToolDeps(['_盲解复核.mjs'], mutDir);
  fs.writeFileSync(path.join(mutDir, '_盲解复核.mjs'), mut, 'utf8');
  let mcode = -1, mout = '';
  try {
    mout = execFileSync(process.execPath, [path.join(mutDir, '_盲解复核.mjs'), '门禁', '--json'], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { CTB_DATA: libNew }),
    });
    mcode = 0;
  } catch (e) { mout = String(e.stdout || ''); mcode = e.status == null ? -1 : e.status; }
  A('C9 ★ 变异自证：恢复死代码写法 ⇒ 新批次缺图形层回到 exit 0（原缺陷复现）',
    mcode === 0, 'exit=' + mcode);
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${total} 失败=${fails}`);
process.exit(fails ? 1 : 0);
