/* 拾光小册 · 批次 4 界面接线「原图并排 + 区域高亮 + 候选修订 + 正式写入入口」
 *
 * 两层判据：
 *   ① **真的跑**（行为级）：`生成状态.mjs` 必须把 `_原卷台账.json` 的 `regions[]` 递给界面
 *      —— 没有它，界面画不出"角色分层"，只能画那一小块红框（批次 2 做进契约、界面一直没消费）。
 *      判据是"有 regions ⇒ 逐字段一致；没 regions ⇒ null（**不是 []**，两者语义不同）"。
 *   ② **源码级接线**（含"掏掉必须变红"的**内存变异**对照）：并排两栏、角色着色、候选三种状态、
 *      写入按钮文案与失败上屏、以及一条**反重复**判据 —— 坐标换算只许有一份实现（shell.js），
 *      `pending.js` 里不许再出现 `naturalWidth` 乘法（两份换算必然漂移，本仓 L-286 家族）。
 *
 * 只写 %TEMP% 夹具；真库零写入。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const E = require('./_测试环境.cjs');
const ROOT = E.REPO;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? '  → ' + detail : ''));
  ok ? pass++ : fail++;
};
const B = (name, cond, detail) => { A(name, cond, detail); return cond ? 0 : 1; };

const LIB = E.allocTempDir('gn-w3-review-');
/* "坐标乘法换算"的判据（唯一实现，供 noSecondScale 与 ④ 两处共用）：
   匹配 `<表达式> * naturalWidth` 形态 —— 那才是"拿坐标乘宽高得像素"。
   `naturalWidth * 100`（百分比）不算。 */
const scaleMulCount = (s) => (s.match(/[\w\])]+\s*\*\s*(?:[A-Za-z_$][\w$]*\.)?natural(?:Width|Height)/g) || []).length;
/* 为什么走 `CTB_DATA` 而不是 `--data`（2026-11-03 实测）：本用例第一版用 `--data`，结果工具**读了真库** ——
   根因是 `_原图寻址.mjs` 在**导入期**就调 `libraryRoot()`，把库根缓存成"首访即定"，此后 `--data` 再也不生效。
   该缺陷本轮已修（改成懒解析 + 缓存记住库根），并在下面留一条**回归锁**（见 ①g）。
   主流程仍用 env 驱动：那是所有工具都认、且与 `_库根.mjs` 优先级一致的方式。 */
const runState = (lib, extraArgs = []) => {
  const r = spawnSync(process.execPath, [E.tool('生成状态.mjs'), ...extraArgs, '--out', '-'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: lib }),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
};

/* ═══════════════ 一、真跑：状态包必须带 regions ═══════════════ */
console.log('═══ ① 生成状态：origRegions 透传（真跑） ═══');
const REGIONS = [
  { role: '错误位置', x: 0.1, y: 0.5, w: 0.8, h: 0.25, pageSha: 'a'.repeat(64), imgW: 600, imgH: 800 },
  { role: '公共条件', x: 0.1, y: 0.15, w: 0.8, h: 0.2, pageSha: 'a'.repeat(64), imgW: 600, imgH: 800 },
];
const CARD_ID = 'P9001';
/* 造最小可用的库：一张卡（按 §9 的库结构：<年级>/<学科>/<卡目录>/错题记录.md + _索引.json）
   ⚠ 索引形状必须与生成器一致：生成器读各年级/学科目录下的 `_索引.json`（cards[].id/dir）。 */
/* 库结构（生成器认的形状）：`<库根>\<学生>\<学科>\_索引.json` + `<学科>\<卡目录>\`。
   ⚠ 第一版我写成 `九年级\物理\`（把它当成"年级/学科"），结果生成器把 `物理` 当成了**学生名**
   —— 于是原卷台账的键 `学生A|P9001` 永远对不上（origPage/origBox 全 null）。
   这不是判据坏了，是夹具的目录层级错了：**库的层级是"学生/学科"，不是"年级/学科"**。 */
const STUDENT_DIR = '学生A';
const YEAR_DIR = path.join(LIB, STUDENT_DIR, '物理');
const CARD_DIR = 'P9001-合成题';
fs.mkdirSync(path.join(YEAR_DIR, CARD_DIR), { recursive: true });
fs.writeFileSync(path.join(YEAR_DIR, CARD_DIR, '错题记录.md'), '# P9001\n\n（夹具）\n', 'utf8');
fs.writeFileSync(path.join(YEAR_DIR, CARD_DIR, '题干.html'), '<div>夹具题干</div>', 'utf8');
fs.writeFileSync(path.join(YEAR_DIR, '_索引.json'), JSON.stringify({
  /* ⚠ `student` 字段**必须有**：原卷台账的键是 `学生|卡号`，而生成器取的是 `idx.student`
     （不是目录名）—— 缺它就会去查 `|P9001`，于是 origPage/origBox/origRegions 全是 null。
     这一条是本用例实测撞出来的（第一版夹具就缺它，白查了三轮）。 */
  student: STUDENT_DIR, grade: '九年级',
  note: '夹具索引', items: [{ id: CARD_ID, dir: CARD_DIR, kp: ['夹具'], status: '在册' }],
}, null, 1), 'utf8');
fs.writeFileSync(path.join(LIB, '_待确认.json'), JSON.stringify({ note: '夹具', seq: 0, items: [] }, null, 1), 'utf8');
fs.mkdirSync(path.join(LIB, '_收件箱', '合成'), { recursive: true });
fs.writeFileSync(path.join(LIB, '_收件箱', '合成', '整页.png'), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64),
]), 'utf8');
/* 原卷台账的键 = `<idx.student>|<卡号>`（生成器 `生成状态.mjs:181` 的口径，**不是目录名**）。 */
fs.writeFileSync(path.join(LIB, '_原卷台账.json'), JSON.stringify({
  version: 1, cards: {
    [STUDENT_DIR + '|' + CARD_ID]: { page: '_收件箱/合成/整页.png', box: [60, 400, 480, 200], by: '人', regions: REGIONS },
  },
}, null, 1), 'utf8');
{
  const r = runState(LIB);
  A('①a 生成状态 exit 0', r.code === 0, 'exit=' + r.code + ' ' + r.err.trim().split('\n')[0]);
  let j = null; try { j = JSON.parse(r.out); } catch { }
  /* 状态包形状（实测，别猜）：`{version,generatedAt,data:[{name,grade,subjects:[{name,dir,items:[卡…]}]}],…}`
     —— 卡是**平铺**在 `items[]` 里的（没有 `.card` 包装层），字段名就是 `origPage/origBox/origRegions…`。 */
  const flat = (j && Array.isArray(j.data) ? j.data : []).flatMap((d) => (d.subjects || []).flatMap((s) => s.items || []));
  A('①b 输出是可解析的状态包且含卡数组', !!j && Array.isArray(j.data) && flat.length > 0,
    j ? '顶层键=' + Object.keys(j).slice(0, 8).join(',') + ' 卡数=' + flat.length : '（不可解析）');
  const card = flat.find((c) => String(c && c.id) === CARD_ID);
  A('①c 找到夹具卡', !!card, card ? 'id=' + card.id : '卡数=' + flat.length);
  const got = card && card.origRegions;
  A('①d ★台账里的 regions[] 原样进了状态包（角色 + 归一化坐标 + 页归属 + imgW/imgH 一个不缺）',
    Array.isArray(got) && got.length === 2 &&
    JSON.stringify(got.map((x) => [x.role, x.x, x.y, x.w, x.h, x.imgW, x.imgH])) ===
    JSON.stringify(REGIONS.map((x) => [x.role, x.x, x.y, x.w, x.h, x.imgW, x.imgH])),
    JSON.stringify(got || null).slice(0, 160));
  A('①e 旧字段照旧：origBox 仍是那条外框记录（没被 regions 顶掉）',
    !!(card && card.origBox), card ? JSON.stringify(card.origBox) : '');
}
/* 阴性对照：台账记录**没有** regions ⇒ 状态包必须是 null（不是 []）——两者语义不同：
   [] 会被界面当成"有区域但空"，null 才是"没有区域记录"。 */
{
  const lib2 = E.allocTempDir('gn-w3-review-null-');
  fs.cpSync(LIB, lib2, { recursive: true });
  fs.writeFileSync(path.join(lib2, '_原卷台账.json'), JSON.stringify({
    version: 1, cards: { ['学生A|' + CARD_ID]: { page: '_收件箱/合成/整页.png', box: [60, 400, 480, 200] } },
  }, null, 1), 'utf8');
  const r = runState(lib2);
  let j = null; try { j = JSON.parse(r.out); } catch { }
  const flat2 = (j && Array.isArray(j.data) ? j.data : []).flatMap((d) => (d.subjects || []).flatMap((s) => s.items || []));
  const card2 = flat2.find((c) => String(c && c.id) === CARD_ID);
  A('①f 阴性对照：台账没有 regions ⇒ 状态包是 **null**（不是 []，"没有记录"与"记录为空"必须分得开）',
    !!card2 && card2.origRegions === null, card2 ? JSON.stringify(card2.origRegions) : '（无卡）');
}

/* ═══════════════ 一·补、回归锁：`--data` 必须真的生效 ═══════════════ */
/* 起因（本轮真事故）：`_原图寻址.mjs` 在导入期解析库根 ⇒ 缓存首访即定 ⇒ `生成状态.mjs --data <库>` 静默读**别的**库。
   修法＝懒解析 + 缓存记住库根。这条判据就是那次修复的锁：把 env 指向**诱饵库**（有另一张卡），
   再用 `--data` 指向夹具库 ⇒ 状态包里必须出现夹具卡、且**不能**出现诱饵卡。 */
{
  const decoy = E.allocTempDir('gn-w3-review-decoy-');
  fs.mkdirSync(path.join(decoy, '九年级', '物理', 'P9500-诱饵'), { recursive: true });
  fs.writeFileSync(path.join(decoy, '九年级', '物理', '_索引.json'), JSON.stringify({
    note: '诱饵', items: [{ id: 'P9500', dir: 'P9500-诱饵', status: '在册' }],
  }, null, 1), 'utf8');
  fs.writeFileSync(path.join(decoy, '_原卷台账.json'), JSON.stringify({ version: 1, cards: {} }, null, 1), 'utf8');
  fs.writeFileSync(path.join(decoy, '_待确认.json'), JSON.stringify({ note: '诱饵', seq: 0, items: [] }, null, 1), 'utf8');
  const r = runState(decoy, ['--data', LIB]);
  let j = null; try { j = JSON.parse(r.out); } catch { }
  const ids = (j && Array.isArray(j.data) ? j.data : []).flatMap((d) => (d.subjects || []).flatMap((s) => s.items || [])).map((c) => String(c && c.id));
  A('①g ★回归锁：`--data` 能压过继承来的 `CTB_DATA`（否则就是"静默读错库"）——状态包必须来自 --data 指的那个库',
    ids.includes(CARD_ID) && !ids.includes('P9500'), '卡片=' + JSON.stringify(ids));
}

/* ═══════════════ 二、源码级接线（含内存变异对照） ═══════════════ */
console.log('\n═══ ② 源码级接线 + 变异自证 ═══');
const HOST = read('src/app/js/host.js');
const SHELL = read('src/app/js/shell.js');
const PEND = read('src/app/js/views/pending.js');
const CSS = read('src/app/css/app.css');

const check = {
  /* 通道：三把 op 的名字、payload 键、以及"非壳模式不许写" */
  hostOps: (s) => /bridge\('reviewList',\s*\{\s*pendingId:\s*pendingId\s*\}/.test(s) &&
    /bridge\('reviewCandidate',\s*\{\s*pendingId:\s*pendingId,\s*kind:\s*kind,\s*target:\s*target,\s*text:\s*text\s*\}/.test(s) &&
    /bridge\('reviewAdopt',\s*\{\s*pendingId:\s*pendingId,\s*candId:\s*candId,\s*dry:\s*dry\s*\?\s*'1'\s*:\s*''\s*\}/.test(s) &&
    /H\.reviewAdopt\s*=\s*async function/.test(s) &&
    (s.match(/需要桌面壳通道/g) || []).length >= 3,
  /* 换算唯一实现：shell.js 里恰好各一份 normToPx/boxNormPx，且 regionPx 走它们。
     ⚠ 计数必须**行首锚定**（`^\s*const normToPx\s*=`）：注释里提到这几个名字是常事，
     用不锚定的 match 会把注释也数进去 —— 本用例第一版正因为自己写的一句注释而假红。 */
  oneScale: (s) => (s.match(/^[ \t]*const normToPx\s*=/gm) || []).length === 1 &&
    (s.match(/^[ \t]*function boxNormPx\(/gm) || []).length === 1 &&
    /S\.regionPx = function[\s\S]{0,400}?normToPx\(b, img\)/.test(s) &&
    /S\.roleClass = function/.test(s),
  /* 反重复：pending.js 里不许出现自己的 naturalWidth 乘法（那是第二份换算） */
  /* 判据：坐标**乘法**换算一份都不许有（`x * naturalWidth` 形态）。
     ⚠ 别写成"naturalWidth 后面跟乘号" —— 百分比换算 `ww / img.naturalWidth * 100` 里 naturalWidth
     也在乘号左边，那样写会把合法实现误判成"第二份换算"（本用例第一版就这么假红过）。 */
  noSecondScale: (s) => scaleMulCount(s) === 0,
  /* 并排与候选两块都要被 itemHtml 调上，且角色/状态/按钮齐全 */
  wiring: (s) => /evBlock\(p\)\s*\+\s*pairBlock\(p\)\s*\+\s*reviewBlock\(p\)/.test(s) &&
    /data-pair=/.test(s) && /data-regions=/.test(s) && /pair-boxes/.test(s) &&
    /data-rvload=/.test(s) && /data-rvadopt=/.test(s) && /data-rvdry=/.test(s) &&
    /S\.roleClass\(r\.role\)/.test(s) && /S\.regionPx\(r, img\)/.test(s) &&
    /已采用/.test(s) && /已作废/.test(s) && /待采用/.test(s),
  /* 写入入口文案必须说清"写进库"，且把工具原文上屏（rv-err / rv-out） */
  adoptCopy: (s) => /这会把修订正文写进库/.test(s) && /_修订/.test(s) &&
    /rv-err/.test(s) && /e\.message/.test(s) &&
    /S\.confirm\(/.test(s) && /不会\*\*改写卡正文/.test(s.replace(/\*/g, '*')),
  /* 现值缺失必须显示原因（不许静默空串） */
  presence: (s) => /currentPresence === 'read'/.test(s) && /读不到：/.test(s) && /currentWhy/.test(s),
  css: (s) => /\.pair-row\{display:grid;grid-template-columns:1fr 1fr/.test(s) &&
    /\.pair-box\.r-err\{/.test(s) && /\.rp-chip\.on\{/.test(s) && /\.rv-pair\{display:grid/.test(s),
};
const cases = [
  ['hostOps', HOST, 'host.js 三把 op 的 payload 键与"非壳模式不写"'],
  ['oneScale', SHELL, 'shell.js 坐标换算唯一实现 + S.regionPx/S.roleClass 外供'],
  ['noSecondScale', PEND, 'pending.js 没有第二份坐标换算（不许 naturalWidth 乘法）'],
  ['wiring', PEND, '并排/候选两块接线齐全（含角色着色与三种候选状态）'],
  ['adoptCopy', PEND, '写入入口：确认框写明"写进库"、不卡正文、失败上屏原文'],
  ['presence', PEND, '现值读不到要显示原因（不静默空串）'],
  ['css', CSS, 'CSS：两栏网格 + 角色三色 + 芯片高亮'],
];
for (const [k, src, label] of cases) A('②' + (cases.indexOf(cases.find((c) => c[0] === k)) + 1) + ' ' + label, check[k](src), '');

/* 变异对照：**掏掉/改窄**各判据必须变红（不落盘，全在内存里做） */
const mutants = [
  ['hostOps', (s) => s.replace("bridge('reviewAdopt', { pendingId: pendingId, candId: candId, dry: dry ? '1' : '' }", "bridge('reviewAdopt', { pendingId: pendingId, candId: candId }")],
  ['oneScale', (s) => s.replace("return normToPx(b, img);", "return [region.x * img.naturalWidth, region.y * img.naturalHeight, region.w * img.naturalWidth, region.h * img.naturalHeight];")],
  ['noSecondScale', (s) => s.replace('const px = S.regionPx(r, img);', 'const px = [r.x * img.naturalWidth, r.y * img.naturalHeight, r.w * img.naturalWidth, r.h * img.naturalHeight];')],
  ['wiring', (s) => s.replace('pairBlock(p) +', '')],
  ['wiring', (s) => s.replace(/data-rvadopt/g, 'data-rvadoptX')],
  ['adoptCopy', (s) => s.replace('这会把修订正文写进库', '这会处理一下')],
  ['presence', (s) => s.replace("c.currentWhy || '未说明'", "''")],
  ['css', (s) => s.replace('.pair-row{display:grid;grid-template-columns:1fr 1fr', '.pair-row{display:block')],
];
let mBad = 0;
const srcOf = { hostOps: HOST, oneScale: SHELL, noSecondScale: PEND, wiring: PEND, adoptCopy: PEND, presence: PEND, css: CSS };
mutants.forEach(([k, mut], i) => {
  const m = mut(srcOf[k]);
  const changed = m !== srcOf[k];
  const caught = changed && !check[k](m);
  if (!caught) mBad++;
  console.log('  ' + (caught ? '[OK]  ' : '[FAIL]') + ' 变异 ' + (i + 1) + '（' + k + '）：改动生效=' + changed + ' 判据变红=' + !check[k](m));
});
A('③★ 变异自证：' + mutants.length + ' 个"掏掉/改窄"变异全部被抓住（判据有牙齿）', mBad === 0, '漏抓 ' + mBad + ' 个');

/* 反重复判据的**独立**一条：全仓只许出现一份 naturalWidth 换算（除 shell.js 那份） */
{
  const files = ['src/app/js/views/pending.js', 'src/app/js/views/ingest.js', 'src/app/js/views/bank.js', 'src/app/js/views/packs.js',
    'src/app/js/views/paper.js', 'src/app/js/views/dash.js', 'src/app/js/shell.js'];
  const offenders = files.filter((f) => {
    let t = ''; try { t = read(f); } catch { return false; }
    return scaleMulCount(t) > 0 && f !== 'src/app/js/shell.js';
  });
  A('④ 全仓只有 shell.js 一份坐标换算实现（其它视图 0 处 naturalWidth 乘法）', offenders.length === 0, offenders.join('、') || '无');
}

console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
