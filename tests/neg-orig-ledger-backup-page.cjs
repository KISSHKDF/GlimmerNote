#!/usr/bin/env node
/**
 * 原卷台账 · page 侧「原路径失效」兜底 + **尺寸自证**（2026-11-06 新增能力）阴性对照。
 *
 * 为什么必须有它：这一层解决的是"迁移（库根换目录）/清理收件箱之后，卡还能不能回到整页"。
 * 它一旦静默失效或**放松**，后果是两种都很坏的形态：
 *   ① 悄悄不定位 ⇒ 一批卡永远显示"未定位"，用户不知道字节其实还在**保全家** `_原图\` 里；
 *   ② 随便递一条路 ⇒ 把"路径被复用成另一个文件"的页当成这张卡的整页（**张冠李戴**，
 *      卡面显示成另一张卷子，比"定位不了"危害大得多）。
 * 所以自证判据（`_裁图记录.json` 的 `srcPx` 与保全家对象实际像素比对）必须**能红**。
 *
 * ⚠ 2026-11-06（P10）：本用例原先把字节放在 `_影像备份\原件\<同路径>` 里（那时的第三层兜底）。
 *   `_影像备份\` 已按 P10「一个字节一个家」退休 ⇒ 现在字节放**保全家 `_原图\`**，
 *   用真工具 `_原图.mjs 入库` 落盘（顺带把 `sources=[规范路径]` 写进 `_原图台账.json`，
 *   这正是 `pathShas()` 反查表的键来源），再把活路径删掉 —— 那就是"原路径失效、字节还在"的真实现场。
 *
 * 覆盖六条：
 *   ① 老绝对路径 + 保全家有对象 ⇒ 定位成规范相对路径，框取裁图记录，note 写明尺寸自证
 *   ② **阴性自证**：保全家对象的尺寸与 srcPx 不符 ⇒ 必须**不定位**（不许递出字节不符的页）
 *   ③ `srcPx` 为对象 `{w,h}`（2026-11-04 起的新形态）必须被接受（旧解析会 stringify 成
 *      "[object Object]" 并误判"尺寸不一致"）
 *   ④ 记录里没有 `srcPx` ⇒ 仍可定位，但 note 必须**如实**写"未做像素自证"，不许假装验过
 *   ⑤ 保全家也不在 ⇒ 不定位（落"待定位"，原因可见）
 *   ⑥ 兜底路径必须在库内：库根之外的兜底路径不许写进台账
 *
 * 退出码 0=六条全部成立；1=有判据守不住。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

const LIB = E.allocTempDir('gn-ledger-backup-');
const run = (args) => {
  try {
    const out = execFileSync(process.execPath, [E.tool(args[0]), ...args.slice(1)], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: LIB }),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
/* 造一张"尺寸可读"的图：`_图尺寸.mjs` 的 PNG 判据 = 8 字节签名 + 偏移 12 处 'IHDR' + w/h */
const png = (w, h) => {
  const b = Buffer.alloc(64, 0);
  b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const mk = (rel, buf) => { const p = path.join(LIB, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const wj = (rel, obj) => { const p = path.join(LIB, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8'); return p; };
const ledger = () => JSON.parse(fs.readFileSync(path.join(LIB, '_原卷台账.json'), 'utf8').replace(/^\uFEFF/, ''));
const entry = (k) => ledger().cards[k] || {};

const KEY = '学生A|M0001';
const CARD_DIR = '学生A/数学/M0001-测试';
const CANON = '学生A/数学/原卷/批次1/p01.jpg';           /* 规范相对路径（库里**不存在**） */
const LEGACY = 'D:\\某老库\\错题本\\' + CANON.replace(/\//g, '\\');   /* 迁移前的老绝对路径 */
const BOX = [0.1, 0.25, 0.8, 0.05];

/* ★ 2026-11-06（P10）：把某份字节收进**保全家** `_原图\`，再把活路径删掉 —— 这就是
   "原路径失效、字节还在"的真实现场。用真工具入库（唯一实现），不手写台账。 */
function putInStore(bytes, rel = CANON) {
  mk(rel, bytes);                                       // ① 活路径先有它（入库按它记 sources）
  const r = run(['_原图.mjs', '入库', rel]);             // ② 真工具：对象 + `_原图台账.json` 一并就位
  if (r.code !== 0) {
    /* 对象已在台账里、但盘上那份被本用例改坏/删掉了（②与⑤ 的现场）⇒ 按正确字节把它放回去即可。
       夹具的活由"把保全家恢复正确"承担，不依赖 `入库` 的幂等分支（它对"已存在但内容不同"是拒绝的）。 */
    const p = storeObjectPath(bytes);
    if (!p) throw new Error('夹具：入库失败且保全家对象也不在 ' + r.out.slice(0, 200));
    fs.writeFileSync(p, bytes);
  }
  fs.unlinkSync(path.join(LIB, rel));                    // ③ 活路径失效 ⇒ 只能靠保全家兜底
}
/** 保全家那个对象的实际落点（sha256 前 2 位做桶、扩展名保留） */
function storeObjectPath(bytes) {
  const sha = require('crypto').createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const dir = path.join(LIB, '_原图', sha.slice(0, 2));
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.toUpperCase().startsWith(sha)) : null;
  return f ? path.join(dir, f) : null;
}

wj('学生A/数学/_索引.json', {
  student: '学生A', grade: '七年级', subject: '数学',
  items: [{ id: 'M0001', dir: 'M0001-测试', title: '夹具', question: 'q', answer: 'a' }],
});
mk(`${CARD_DIR}/原卷截图.jpg`, png(400, 60));
/* 造 `_裁图记录.json`：形态照真实卡来 —— 顶层 + `crops[]` 各一条（`out=原卷截图.jpg` 那条才算本题证据）。
   `topSrcPx` 专造"只有顶层带 srcPx、crop 项不带"的新形态（2026-11-04 起那批就是它）。 */
const recWrite = (obj = {}) => {
  const src = obj.src !== undefined ? obj.src : LEGACY;
  const nbox = obj.normBox !== undefined ? obj.normBox : BOX;
  const top = { src, normBox: nbox, scale: 2, out: '原卷截图.jpg' };
  const crop = { src, normBox: nbox, scale: 2, out: '原卷截图.jpg' };
  if (obj.topSrcPx !== undefined) top.srcPx = obj.topSrcPx;
  else if (obj.srcPx !== undefined) { top.srcPx = obj.srcPx; crop.srcPx = obj.srcPx; }
  return wj(`${CARD_DIR}/_裁图记录.json`, Object.assign(top, { crops: [crop] }));
};
recWrite({ srcPx: '2024x2940' });
putInStore(png(2024, 2940));

/* ════ ① 老绝对路径 + 备份件在 ⇒ 定位，且自证 ════ */
{
  const r = run(['_原卷台账.mjs', '生成']);
  A('①a 生成退出 0', r.code === 0, 'exit=' + r.code);
  const e = entry(KEY);
  A('①b page = 规范相对路径（不是兜底路径）', e.page === CANON, String(e.page));
  A('①c box 取裁图记录的 normBox', Array.isArray(e.box) && e.box.length === 4 && e.box.every((v, i) => Math.abs(v - BOX[i]) < 1e-9), JSON.stringify(e.box));
  A('①d by = 保全库·尺寸自证', e.by === '保全库·尺寸自证', String(e.by));
  A('①e note 写明尺寸自证的具体像素', /尺寸自证\s*2024x2940/.test(e.note || ''), String(e.note).slice(0, 120));
  A('①f 库内确实没有这条规范路径（证明走的是兜底，不是撞对了）', !fs.existsSync(path.join(LIB, CANON)));
  const g = run(['_原卷台账.mjs', '门禁']);
  A('①g 门禁里这张卡不报"未定位"', !/✗\s*学生A\|M0001\s*未定位/.test(g.out), (g.out.match(/.*学生A\|M0001.*/) || [''])[0].slice(0, 100));
}

/* ════ ② 阴性自证：备份件尺寸不符 ⇒ 必须不定位，且**说明为什么** ════ */
{
  fs.writeFileSync(storeObjectPath(png(2024, 2940)), png(999, 111));   /* 保全家那份被换成另一个尺寸的文件（正是"字节对不上"的现场） */
  const r = run(['_原卷台账.mjs', '生成']);
  const e = entry(KEY);
  A('②a 尺寸不符时 page 必须为 null（宁可不定位）', e.page === null, String(e.page));
  A('②b 原因可见：明说"尺寸不符"并给出两边像素', /尺寸不符/.test(e.note || '') && /999x111/.test(e.note || ''), String(e.note).slice(0, 160));
  A('②c 生成仍然退出 0（"定位不了"不是崩溃）', r.code === 0, 'exit=' + r.code);
}

/* ════ ③ srcPx 为对象 {w,h}（新形态）必须被接受 ════ */
{
  putInStore(png(2024, 2940));
  recWrite({ srcPx: { w: 2024, h: 2940 } });
  run(['_原卷台账.mjs', '生成']);
  const e = entry(KEY);
  A('③a 对象型 srcPx 被正确解析（page 定位成功）', e.page === CANON, String(e.page));
  A('③b 且仍然做了尺寸自证', /尺寸自证\s*2024x2940/.test(e.note || ''), String(e.note).slice(0, 120));
}

/* ════ ④ 没有 srcPx ⇒ 可定位，但必须如实标注"未做像素自证" ════ */
{
  recWrite({ srcPx: undefined });
  run(['_原卷台账.mjs', '生成']);
  const e = entry(KEY);
  A('④a 无 srcPx 时仍定位（同相对路径命中）', e.page === CANON, String(e.page));
  A('④b note 如实写"未做像素自证"，不许假装验过', /未做像素自证/.test(e.note || ''), String(e.note).slice(0, 140));
}

/* ════ ④b srcPx 写在**记录顶层**（2026-11-04 起那批的形态）时也必须自证 ════
   实测踩过：只看 crop 项的 srcPx ⇒ 顶层带 srcPx 的 26 张卡被误标成"未做像素自证"。 */
{
  recWrite({ srcPx: undefined, topSrcPx: '2024x2940' });   // 见下方 recWrite 的 topSrcPx 处理
  run(['_原卷台账.mjs', '生成']);
  const e = entry(KEY);
  A('④c 顶层 srcPx 被采纳（定位成功）', e.page === CANON, String(e.page));
  A('④d 且 note 写的是尺寸自证，不是"未做像素自证"', /尺寸自证\s*2024x2940/.test(e.note || '') && !/未做像素自证/.test(e.note || ''), String(e.note).slice(0, 160));
}

/* ════ ⑤ 备份件也不在 ⇒ 不定位 ════ */
{
  recWrite({ srcPx: '2024x2940' });
  fs.unlinkSync(storeObjectPath(png(2024, 2940)));   /* 把保全家对象也删掉 */
  run(['_原卷台账.mjs', '生成']);
  const e = entry(KEY);
  A('⑤a 保全家对象也没有 ⇒ page 为 null', e.page === null, String(e.page));
  A('⑤b 原因可见：明说"原路径已失效"且保全家也没有同 sha 对象', /原路径已失效/.test(e.note || '') && /没有同 sha 对象/.test(e.note || ''), String(e.note).slice(0, 160));
}

/* ════ ⑥ 兜底路径必须在库内（库根之外的兜底件不许写进台账）════ */
{
  const OUTSIDE = E.allocTempDir('gn-ledger-outside-');
  fs.writeFileSync(path.join(OUTSIDE, 'p01.jpg'), png(2024, 2940));
  /* 用 `..` 上跳相对路径去指库外（历史事故形态：exists() 会把它解析回库外真文件） */
  const evil = path.relative(LIB, path.join(OUTSIDE, 'p01.jpg')).replace(/\\/g, '/');
  recWrite({ src: evil, srcPx: '2024x2940' });
  putInStore(png(2024, 2940));                    /* 备份里那份仍在：判据必须优先拒掉库外 */
  run(['_原卷台账.mjs', '生成']);
  const e = entry(KEY);
  A('⑥a 库外上跳路径不许进 page', e.page === null, String(e.page));
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}`);
process.exit(fails ? 1 : 0);
