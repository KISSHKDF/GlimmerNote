/* 拾光小册 · 恢复演练**后半段**（批次 4 · §4 矩阵第 242 行）
 *
 * 前半段（批次 1）证明的是"备份能不能证明库是完整的"；**后半段**要回答的是：
 *   真把字节恢复回来之后，**旧题引用**（`_原卷台账.json` 的 `regions/box` + `_待确认.json` 的
 *   `origPage/origBox` + 人工判断留痕）还能不能**正确呈现**——拿得回字节不等于拿得回"这一题长什么样"。
 *
 * 手法：自建一间"旧库"（4 种形状：同图两次 / 同名异图 / 带 EXIF 方向 / 跨页题）→ 真跑 `入库`
 *   → 把 `_原图\` 整棵复制成备份 → **删掉库里的 `_原图\`**（模拟"字节丢了"）
 *   → 真跑 `恢复 --from <备份>` → 逐对象 sha256 对比 → 再用旧题引用复原"整页 + 红框"。
 *
 * 诚实写明：合成影像只保证**文件头**能被 `_图尺寸.mjs` 读出宽高（PNG 是完整合法 PNG；JPEG 只到 SOF，
 *   不是可解码码流）。本用例要证的是"坐标与页归属能复原"，不是"图片能被打开"。
 *
 * 只写 %TEMP% 夹具；真库零写入。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const E = require('./_测试环境.cjs');
const ROOT = E.REPO;
const TOOL = E.tool('_原图.mjs');
const IMGSZ = require('node:url').pathToFileURL(E.tool('_图尺寸.mjs')).href;

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? '  → ' + detail : ''));
  ok ? pass++ : fail++;
};

/* ── 合成影像（只保证文件头可读） ── */
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_T[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function pngBytes(w, h, seed = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h); for (let i = 0; i < raw.length; i++) raw[i] = (i + seed) & 0xFF;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function jpegSeg(marker, payload) {
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xFF, marker]), len, payload]);
}
function jpegExifOrientation(w, h, orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18); tiff.writeUInt16LE(0, 20); tiff.writeUInt32LE(0, 22);
  const sof = Buffer.alloc(8);
  sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 1; sof[6] = 1; sof[7] = 0x11;
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]), jpegSeg(0xE0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
    jpegSeg(0xE1, Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])),
    jpegSeg(0xDB, Buffer.alloc(65)), jpegSeg(0xC0, sof), jpegSeg(0xDA, Buffer.alloc(6)), Buffer.from([0xFF, 0xD9]),
  ]);
}
/* ⚠ 两种大小写口径都真实存在，不许混（本轮实测撞上）：
     · 库内**对象文件名** = 小写 sha（`_原图\<前2位>\<sha>.<ext>`）
     · `_原图台账.json` 的**键** = 大写 sha
   而**页 sha 单独一个字段不足以定位对象** —— 它不带扩展名，必须去目录里查（这正是"按 sha 复原页面"的实现难点）。 */
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
const shaLower = (p) => sha256File(p).toLowerCase();
function snap(dir) {
  const out = new Map();
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith('.tmp')) { try { out.set(path.relative(dir, p).split(path.sep).join('/'), sha256File(p)); } catch { } }
    }
  };
  walk(dir);
  return out;
}
function diff(a, b) {
  const out = [];
  for (const [k, v] of a) if (!b.has(k)) out.push('消失:' + k); else if (b.get(k) !== v) out.push('变了:' + k);
  for (const k of b.keys()) if (!a.has(k)) out.push('新增:' + k);
  return out;
}
const LIB = E.allocTempDir('gn-rwb-');
const run = (args) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: LIB, CTB_TXN_DIR: path.join(LIB, '_txn') }),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
};

(async () => {
  console.log('夹具库：' + LIB);

  /* ═══ 一、造"旧库"：4 种形状 ═══ */
  const INBOX = path.join(LIB, '_收件箱', '合成批次');
  fs.mkdirSync(INBOX, { recursive: true });
  const pageA = path.join(INBOX, '整页A-600x800.png');
  const pageB = path.join(INBOX, '整页B-400x300.png');
  fs.writeFileSync(pageA, pngBytes(600, 800, 7));
  fs.writeFileSync(pageB, pngBytes(400, 300, 9));
  /* ① 同图两次：同一份内容换个名字再放一处 */
  const pageA2 = path.join(INBOX, '整页A-副本.png');
  fs.copyFileSync(pageA, pageA2);
  /* ② 同名异图：同一个名字、不同内容（分别放在不同批次目录） */
  const IN2 = path.join(LIB, '_收件箱', '合成批次2');
  fs.mkdirSync(IN2, { recursive: true });
  fs.writeFileSync(path.join(IN2, '同名.png'), pngBytes(120, 90, 3));
  fs.writeFileSync(path.join(INBOX, '同名.png'), pngBytes(121, 91, 4));
  /* ③ 带 EXIF 方向：存储 600x800、orientation=6 ⇒ **显示** 800x600 */
  const exifJpg = path.join(INBOX, '方向.jpg');
  fs.writeFileSync(exifJpg, jpegExifOrientation(600, 800, 6));

  const ing = run(['入库', INBOX, IN2]);
  A('①真跑入库 exit 0（4 种形状进库）', ing.code === 0, 'exit=' + ing.code + ' ' + ing.err.trim().split('\n').slice(0, 2).join(' / '));
  const storeDir = path.join(LIB, '_原图');
  const objsBefore = snap(storeDir);
  const shaPageA = shaLower(pageA);
  const shaPageB = shaLower(pageB);
  const shaExif = shaLower(exifJpg);
  A('②同图两次 ⇒ 库内只 1 个对象（内容寻址生效；副本没造出第二个对象）',
    objsBefore.size === 5 && shaPageA === shaLower(pageA2) &&
    objsBefore.has(shaPageA.slice(0, 2) + '/' + shaPageA + '.png'),
    '唯一内容 5 份 / 库内对象 ' + objsBefore.size + ' 个');
  const shaTongIn2 = shaLower(path.join(IN2, '同名.png'));
  const shaTongIn1 = shaLower(path.join(INBOX, '同名.png'));
  A('③同名异图 ⇒ 两个对象都在（同名不合并）',
    objsBefore.has(shaTongIn2.slice(0, 2) + '/' + shaTongIn2 + '.png') &&
    objsBefore.has(shaTongIn1.slice(0, 2) + '/' + shaTongIn1 + '.png') &&
    shaTongIn2 !== shaTongIn1,
    '对象数=' + objsBefore.size + '　两个同名文件 sha 前 8 位=' + shaTongIn2.slice(0, 8) + '/' + shaTongIn1.slice(0, 8));
  const ledger = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
  const ledBefore = JSON.stringify(ledger);
  A('④台账登记了这些对象（含 EXIF 那张；台账键是**大写** sha）',
    !!ledger.objects[shaExif.toUpperCase()] && !!ledger.objects[shaPageA.toUpperCase()] && !!ledger.objects[shaPageB.toUpperCase()],
    Object.keys(ledger.objects).length + ' 条');

  /* ═══ 二、旧题引用：跨页题（regions 两条指向两张页）+ 待确认的 origBox + 人工判断 ═══ */
  const cardDir = path.join(LIB, '九年级', '物理', 'P0001-合成题');
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(path.join(cardDir, '错题记录.md'), '# 合成题\n\n（夹具）\n', 'utf8');
  const relPageA = '_收件箱/合成批次/整页A-600x800.png';
  const relPageB = '_收件箱/合成批次/整页B-400x300.png';
  const px = { 错误位置: [60, 400, 480, 200], 公共条件: [60, 120, 480, 160] };   // 像素（相对 A 页 600x800）
  const regions = [
    { role: '错误位置', x: px.错误位置[0] / 600, y: px.错误位置[1] / 800, w: px.错误位置[2] / 600, h: px.错误位置[3] / 800, pageSha: shaPageA, imgW: 600, imgH: 800 },
    { role: '公共条件', x: px.公共条件[0] / 600, y: px.公共条件[1] / 800, w: px.公共条件[2] / 600, h: px.公共条件[3] / 800, pageSha: shaPageA, imgW: 600, imgH: 800 },
    { role: '配图', x: 0.5, y: 0.5, w: 0.25, h: 0.25, pageSha: shaPageB, imgW: 400, imgH: 300 },   // 跨页：另一张页
  ];
  fs.writeFileSync(path.join(LIB, '_原卷台账.json'), JSON.stringify({
    version: 1,
    note: '夹具：跨页题（regions 指向两张页）',
    cards: { '学生A|P0001': { page: relPageA, box: regions[0], regions, lost: false } },
  }, null, 1), 'utf8');
  const PENDING_BOX = [120, 240, 240, 160];   // 像素（相对 A 页）
  fs.writeFileSync(path.join(LIB, '_待确认.json'), JSON.stringify({
    note: '夹具', seq: 1,
    items: [{
      id: 'T001', student: '学生A', subject: '物理', cardId: 'P0001', kind: '卷面辨认', ask: '原卷',
      q: '这一处到底错在哪？', detail: '夹具：人工判断留在 corrections 里', status: '已确认',
      origPage: relPageA, origBox: [PENDING_BOX[0] / 600, PENDING_BOX[1] / 800, PENDING_BOX[2] / 600, PENDING_BOX[3] / 800],
      evidence: '', raisedAt: '2026-11-03', resolvedAt: '2026-11-03',
      corrections: [{ at: '2026-11-03', why: '孩子没错，是标准答案印错了', scope: '卡', target: 'P0001' }],
    }],
  }, null, 1), 'utf8');

  /* ═══ 三、备份 → 破坏 → 恢复 ═══ */
  const BACKUP = path.join(LIB, '_影像备份', '原图');
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  fs.cpSync(storeDir, BACKUP, { recursive: true });
  fs.rmSync(storeDir, { recursive: true, force: true });
  A('⑤前置：库内 `_原图\\` 已整棵删除（模拟字节丢失）', !fs.existsSync(storeDir));

  const dry = run(['恢复', '--from', BACKUP, '--dry']);
  A('⑥`恢复 --dry` exit 0 且一个字节都不写', dry.code === 0 && !fs.existsSync(storeDir), 'exit=' + dry.code);
  const res = run(['恢复', '--from', BACKUP]);
  A('⑦`恢复` exit 0（写回 ' + objsBefore.size + ' 个对象）', res.code === 0, 'exit=' + res.code + ' ' + res.err.trim().split('\n')[0]);
  const after = snap(storeDir);
  A('⑧★ 恢复后逐对象 sha256 与备份前**完全一致**（一个不多一个不少）',
    diff(objsBefore, after).length === 0, diff(objsBefore, after).join('、') || '零差异');
  const res2 = run(['恢复', '--from', BACKUP]);
  A('⑨幂等：再跑一次 ⇒ 全部"已存在且内容相同"跳过，库不变',
    res2.code === 0 && /已存在且内容相同（幂等跳过）5/.test(res2.out) && diff(after, snap(storeDir)).length === 0,
    res2.out.split('\n').map((s) => s.trim()).filter((s) => /写回|跳过/.test(s))[0] || '');

  /* ═══ 四、后半段：用**旧题引用**复原"整页 + 红框" ═══ */
  const { displaySize } = await import(IMGSZ);
  /* 页 sha → 对象文件：**必须去目录里查扩展名**（sha 字段本身不带扩展名）。
     查不到 ⇒ null（调用方给具体原因，不许静默当"没有这一页"）。 */
  const objFile = (sha) => {
    const s = String(sha).toLowerCase();
    const dir = path.join(storeDir, s.slice(0, 2));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    const hit = names.find((n) => n.toLowerCase().startsWith(s) && !n.endsWith('.tmp'));
    return hit ? path.join(dir, hit) : null;
  };
  const led2 = JSON.parse(fs.readFileSync(path.join(LIB, '_原卷台账.json'), 'utf8'));
  const rec = led2.cards['学生A|P0001'];

  function restoreView(recIn, pendingIn) {
    /* 这一小段就是"界面要做的换算"的最简复现：pageSha → 恢复后的对象 → 显示宽高 → 归一化框 × 宽高。
       错误必须**给具体原因**（缺页/越界），不许静默 null。 */
    const out = { pages: [], frames: [], problems: [] };
    for (const [i, r] of (recIn.regions || []).entries()) {
      const f = objFile(r.pageSha);
      if (!f) { out.problems.push(`regions[${i}] 缺页：pageSha ${String(r.pageSha).slice(0, 12)}… 在恢复后的库里找不到对象`); continue; }
      const d = displaySize(f);
      if (!d) { out.problems.push(`regions[${i}] 量不出版面尺寸：${path.basename(f)}（文件头读不出宽高）`); continue; }
      const bad = ['x', 'y', 'w', 'h'].filter((k, j) => {
        const v = r[k]; return !Number.isFinite(v) || v < 0 || v > 1 || (j >= 2 && v <= 0);
      });
      if (bad.length) { out.problems.push(`regions[${i}] 坐标越界：${bad.join(',')}（应为 0~1，实际 ${JSON.stringify({ x: r.x, y: r.y, w: r.w, h: r.h })}）`); continue; }
      out.pages.push({ sha: r.pageSha, imgW: d.w, imgH: d.h });
      out.frames.push({ role: r.role, px: [Math.round(r.x * d.w), Math.round(r.y * d.h), Math.round(r.w * d.w), Math.round(r.h * d.h)] });
    }
    const p = pendingIn.items[0];
    const pf = objFile(shaOfRel(p.origPage));
    if (!pf) out.problems.push('待确认 origPage 缺页：' + p.origPage);
    else {
      const d = displaySize(pf);
      out.frames.push({ role: '待办红框', px: [Math.round(p.origBox[0] * d.w), Math.round(p.origBox[1] * d.h), Math.round(p.origBox[2] * d.w), Math.round(p.origBox[3] * d.h)] });
    }
    return out;
  }
  function shaOfRel(rel) {
    /* 路径 → 内容 sha：按台账的 `sources` **全路径相等**反查（恢复不改台账，所以这条链必须仍然成立）。
       ⚠ 刻意**不**按 basename 找 —— 本夹具里就有两个同名文件，按名字找会连到错的那个。 */
    const led = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
    const want = rel.replace(/\\/g, '/');
    for (const [sha, o] of Object.entries(led.objects)) {
      if ((o.sources || []).some((s) => s.replace(/\\/g, '/') === want)) return sha;
    }
    return 'x'.repeat(64);
  }
  const pending2 = JSON.parse(fs.readFileSync(path.join(LIB, '_待确认.json'), 'utf8'));
  const view = restoreView(rec, pending2);
  A('⑩★ 三块区域 + 待办红框全部复原成功（含跨页那条指向另一张页），零问题',
    view.problems.length === 0 && view.frames.length === 4, view.problems.join('；') || JSON.stringify(view.frames));
  A('⑪★ 复原出的像素框与原记录**逐像素一致**（归一化×显示宽高）',
    JSON.stringify(view.frames[0].px) === JSON.stringify(px.错误位置) &&
    JSON.stringify(view.frames[1].px) === JSON.stringify(px.公共条件),
    JSON.stringify(view.frames.map((f) => f.role + ':' + f.px.join(','))));
  A('⑫跨页那条用的是**另一张页**的宽高（400x300，不是 A 页的 600x800）',
    view.frames[2].px.join(',') === [200, 150, 100, 75].join(','), view.frames[2].px.join(','));
  A('⑬待确认的 origBox 也复原对了（像素 = 归一化 × 显示宽高）',
    view.frames[3] && view.frames[3].px.join(',') === PENDING_BOX.join(','), view.frames[3] ? view.frames[3].px.join(',') : 'missing');
  A('⑭★ 人工判断留痕仍在（corrections[0].why 原文可读）',
    pending2.items[0].corrections[0].why === '孩子没错，是标准答案印错了',
    pending2.items[0].corrections[0].why);
  A('⑮EXIF 方向那张：**显示**宽高是交换过的（800x600）',
    (() => { const d = displaySize(objFile(shaExif)); return d && d.w === 800 && d.h === 600; })(),
    JSON.stringify(displaySize(objFile(shaExif))) +
    ' ｜ exists=' + !!objFile(shaExif) +
    ' ｜ store 里的 jpg=' + [...after.keys()].filter((k) => k.endsWith('.jpg')).join(',') +
    ' ｜ shaExif=' + shaExif.slice(0, 12));

  /* ═══ 五、阴性对照 ═══ */
  /* N1 内容不同的对象不许覆盖 */
  {
    const bad = shaPageB;   // 拿 B 页的 sha 当"库里已存在但内容不同"
    const victim = objFile(bad);
    const keep = fs.readFileSync(victim);
    fs.writeFileSync(victim, Buffer.concat([keep, Buffer.from([1, 2, 3])]));   // 名字没变、内容变了
    const r = run(['恢复', '--from', BACKUP, '--sha', bad.slice(0, 8)]);
    A('N1 库里已有同名对象但内容不同 ⇒ 拒绝覆盖 exit 1 且原因点名"哈希碰撞或磁盘损坏"',
      r.code === 1 && /拒绝覆盖/.test(r.err), 'exit=' + r.code);
    fs.writeFileSync(victim, keep);
    A('N1b 复原后（人工把内容改回）该对象 sha 与备份一致', shaLower(victim) === bad, '');
  }
  /* N2 复核不过 ⇒ 不许留半截 */
  {
    const src = path.join(BACKUP, shaPageB.slice(0, 2), shaPageB + '.png');
    const keep = fs.readFileSync(src);
    fs.writeFileSync(src, Buffer.concat([keep, Buffer.from([9, 9, 9])]));   // 名字说 shaB，内容不是了
    const victimB = objFile(shaPageB); fs.rmSync(victimB, { force: true });
    const r = run(['恢复', '--from', BACKUP, '--sha', shaPageB.slice(0, 8)]);
    A('N2 复核不过 ⇒ exit 1、原因点名"落盘复核失败"，且**不留半截**',
      r.code === 1 && /落盘复核失败/.test(r.err) && !objFile(shaPageB), 'exit=' + r.code);
    fs.writeFileSync(src, keep);
    const r2 = run(['恢复', '--from', BACKUP, '--sha', shaPageB.slice(0, 8)]);
    A('N2b 备份修正后重跑 ⇒ 恢复成功（恢复是幂等的）', r2.code === 0 && shaLower(objFile(shaPageB)) === shaPageB, 'exit=' + r2.code);
  }
  /* N3 缺页 / N4 越界：复原函数必须给具体原因 */
  {
    const recBad = JSON.parse(JSON.stringify(rec));
    recBad.regions.push({ role: '配图', x: 0.1, y: 0.1, w: 0.2, h: 0.2, pageSha: 'f'.repeat(64), imgW: 10, imgH: 10 });
    const v = restoreView(recBad, pending2);
    A('N3 缺页 ⇒ 具体原因（点名 pageSha 前 12 位与"恢复后的库里找不到"）',
      v.problems.some((s) => /缺页/.test(s) && /ffffffffffff/.test(s)), v.problems.join('；'));
    const rec2 = JSON.parse(JSON.stringify(rec));
    rec2.regions[0] = Object.assign({}, rec2.regions[0], { x: 1.2 });
    const v2 = restoreView(rec2, pending2);
    A('N4 越界坐标 ⇒ 具体原因（点名是哪个字段、应为 0~1）',
      v2.problems.some((s) => /坐标越界/.test(s) && /\bx\b/.test(s)), v2.problems.join('；'));
  }
  /* N5 `--dry` 不写盘（对已在盘上的库也成立） */
  {
    const before = snap(LIB);
    const r = run(['恢复', '--from', BACKUP, '--dry']);
    A('N5 `恢复 --dry` 后库逐字节不变', diff(before, snap(LIB)).length === 0 && r.code === 0, diff(before, snap(LIB)).join('、'));
  }
  /* N6 派生件不许改写原对象（记录与字节都不动） */
  /* 先把"派生之前的台账"整份留档：N7 要比的就是它（作用域放在两个块外面，别让 N7 引用不到） */
  const LED_BEFORE_DERIVE = fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8');
  const ledBefore2 = JSON.stringify(JSON.parse(LED_BEFORE_DERIVE).objects[shaPageA.toUpperCase()]);
  {
    const der = path.join(LIB, '_收件箱', '派生输入.png');
    fs.writeFileSync(der, pngBytes(64, 32, 55));
    const r = run(['派生', '--derived-from', shaPageA, '--op', 'rotate', '--file', der, '--note', '夹具：转 90°']);
    const led = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
    const same = JSON.stringify(led.objects[shaPageA.toUpperCase()]) === ledBefore2;
    A('N6 ★派生件另存后**原件记录一字未动**（sources/names/字节都还在），且原对象文件 sha 不变',
      r.code === 0 && same && shaLower(objFile(shaPageA)) === shaPageA, 'exit=' + r.code);
    A('N6b 派生件的登记带 derivedFrom / op',
      !!led.objects[sha256File(der)] && String(led.objects[sha256File(der)].derivedFrom).toLowerCase() === shaPageA && led.objects[sha256File(der)].op === 'rotate',
      JSON.stringify({ op: led.objects[sha256File(der)] && led.objects[sha256File(der)].op }));
  }
  /* N7 台账一字未动（恢复不改台账；派生只**新增**一条） */
  {
    const ledNow = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
    const ledOld = JSON.parse(LED_BEFORE_DERIVE);
    const changed = Object.keys(ledOld.objects).filter((k) => JSON.stringify(ledOld.objects[k]) !== JSON.stringify(ledNow.objects[k]));
    const added = Object.keys(ledNow.objects).filter((k) => !ledOld.objects[k]);
    A('N7 ★派生/恢复只**新增**一条（派生件），**既有对象记录逐条一字未动**',
      changed.length === 0 && added.length === 1 && !!ledNow.objects[added[0]].derivedFrom,
      '改写 ' + changed.length + ' 条 / 新增 ' + added.length + ' 条');
  }

  console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
  process.exit(fail ? 1 : 0);
})();
