#!/usr/bin/env node
/**
 * 区域契约 + P2-2 统一坐标系 · 阴性对照（2026-11-03 · 批次 2 / W4）
 *
 * 缺陷原形（两条，都是"长得像值、其实不可复算 / 会被静默吃掉"）：
 *   ① 两套坐标系并存无契约：`_原卷台账.json` 的 `box` 是**归一化 0~1**，`_待确认.json` 的 `box`
 *      是**源图像素**。实测事故 T187~T192：把 0~1 的值按像素用，灯箱红框缩成左上角 1 像素点。
 *   ② 规划中的区域 `regions[]` 住在台账条目上，而台账是"重算已知字段 + 透传未知字段"的写回模式
 *      （P1-1）——白名单一旦被误加 `regions`，下一次 生成/采集 就会把用户登记的区域**静默吃掉**，
 *      表面上完全正常（exit 0、覆盖率照报）。`lost` 字段当年就是这样无声丢掉 10 张卡的免检资格。
 *
 * 本用例守七段（全部真跑；库一律自建在 %TEMP%，绝不碰用户真库）：
 *   ① `regionsOk()` 表驱动单元：合规通过 + 六类违规各自判红（未知角色/越界/缺 imgW/imgW 非正/
 *      pageSha 形状/跨页引用），且 `regions` 缺失 ⇒ 合规（旧记录兼容红线）；
 *   ② `门禁` 真跑：合规 regions → exit 0；六类违规各自 → exit 1 且输出里点名**具体原因**；
 *   ③ 重建（`生成`）后台账里 `regions[]` **逐字节保留**；且"把 regions 加进白名单"的变异体
 *      必须被 P1-1 显式断言拦下（exit 1 + 台账一个字节没动）；
 *   ④ `normEvidenceBox()` 对**真合成图**（PNG / JPEG / 带 EXIF 方向的 JPEG）：`boxNorm × imgW`
 *      与原像素框一致；量不出尺寸时给**原因**（**不给 0**）；
 *   ⑤ `GET /api/state` 的 pending 条目附加 `boxNorm/imgW/imgH`：旧字段逐字节不变、缺 box 的条目
 *      一个字段都不加、读不到图只给 `boxNormWhy`、GET 不写盘、`_待确认.json` 一个字节不改；
 *   ⑥ 阴性自证：把「缺 imgW 判红」这条判据掏掉 ⇒ ②的"缺 imgW"那格**当场变绿**（判据有牙齿）；
 *   ⑦ `_区域坐标.mjs` **零导入期副作用**：不设 `CTB_DATA` 也 import 得动、不建锁、不改环境变量；
 *      同一装置下 import `_待确认.mjs` 必须**抛错**（证明⑦的装置真能看见"导入期求值库根"）。
 *
 * 用法：node tests\neg-region-contract.cjs
 * 退出码：0=全绿；1=有断言失败
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { ROOT, req, waitHealth, counter, stripComments } = require('./neg-server-lib.cjs');

const { A, end } = counter();

const TOOL_LEDGER = path.join(ROOT, 'src', 'tools', '_原卷台账.mjs');
const TOOL_PENDING = path.join(ROOT, 'src', 'tools', '_待确认.mjs');
const TOOL_COORD = path.join(ROOT, 'src', 'tools', '_区域坐标.mjs');
const TOOL_SERVER = path.join(ROOT, 'src', 'tools', '_服务端.mjs');
const PAGE_W = 1600, PAGE_H = 1200;                    // 合成 PNG 整页的显示宽高
const PORT = 18061;                                    // 独立实例，不碰用户那个 7187

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rg-'));
const LIB = path.join(WORK, 'lib');
const PROC = path.join(WORK, 'proc');
const TXN = path.join(WORK, 'txn');
const MUT = path.join(WORK, 'mut');
const PROBE = path.join(WORK, 'probe.mjs');
const PAGE_REL = '原卷/整页.png';
const PAGE_ABS = path.join(LIB, '原卷', '整页.png');

const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1) + '\n', 'utf8'); };
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sha1_16 = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ───────────────────────── 工具调用（永远显式给库根与过程目录） ───────────────────────── */
function toolEnv(extra) {
  const env = Object.assign({}, process.env, { CTB_DATA: LIB, GLIMMERNOTE_PROC: PROC, CTB_TXN_DIR: TXN });
  delete env.CTB_LOCK_TOKEN;
  return Object.assign(env, extra || {});
}
function runTool(tool, args) {
  const r = spawnSync(process.execPath, [tool, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: toolEnv() });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/* ───────────────────────── 合成影像（真写盘） ─────────────────────────
 * PNG：本用例自建**完整合法**的 8bit 灰度 PNG（IHDR+IDAT+IEND，CRC 正确）。
 * JPEG：SOI + APP0(JFIF) + [APP1(Exif 方向)] + DQT + SOF0(声明宽高) + SOS + EOI。
 *   ⚠ 诚实写明：它**够 `_图尺寸.mjs` 按设计只读文件头**（扫到 SOF 取宽高、扫到 SOS 即停），
 *     但**不是可解码的完整码流**（没有 DHT 熵表）。本段要证的是"证据图是 JPEG 时宽高量得对、
 *     带 EXIF 方向时宽高按**显示**口径交换"，不是"JPEG 能解码"。 */
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_T[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function writePng(abs, w, h) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;   // 8bit 灰度
  const raw = Buffer.alloc((w + 1) * h);                                          // 每行 1 字节滤波标记 + w 字节像素
  fs.writeFileSync(abs, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}
function jpegSeg(marker, payload) {
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xFF, marker]), len, payload]);
}
function app1ExifOrientation(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);                          // IFD0：1 个条目
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18); tiff.writeUInt16LE(0, 20);
  tiff.writeUInt32LE(0, 22);                         // 无下一个 IFD
  return jpegSeg(0xE1, Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]));
}
function writeJpeg(abs, w, h, orientation) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const parts = [Buffer.from([0xFF, 0xD8])];
  parts.push(jpegSeg(0xE0, Buffer.concat([Buffer.from('JFIF\0', 'binary'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])));
  if (orientation != null) parts.push(app1ExifOrientation(orientation));
  parts.push(jpegSeg(0xDB, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 16), Buffer.from([0x01]), Buffer.alloc(64, 16)])));
  const sof = Buffer.alloc(15);
  sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  sof[6] = 1; sof[7] = 0x11; sof[8] = 0; sof[9] = 2; sof[10] = 0x11; sof[11] = 1; sof[12] = 3; sof[13] = 0x11; sof[14] = 1;
  parts.push(jpegSeg(0xC0, sof));
  const sos = Buffer.alloc(10);
  sos[0] = 3; sos[1] = 1; sos[2] = 0; sos[3] = 2; sos[4] = 0x11; sos[5] = 1; sos[6] = 3; sos[7] = 0x11; sos[8] = 1; sos[9] = 0;
  parts.push(jpegSeg(0xDA, sos));
  parts.push(Buffer.alloc(8, 0));                    // 占位熵数据
  parts.push(Buffer.from([0xFF, 0xD9]));
  fs.writeFileSync(abs, Buffer.concat(parts));
}

/* ───────────────────────── 台账夹具 ───────────────────────── */
const SIX64A = 'a'.repeat(64);
const STUDENT = '学生A';
const IDS = ['M0001', 'M0002', 'M0003', 'M0004', 'M0005', 'M0006', 'M0007'];

/** 合规区域（角色/边界/宽高/pageSha 全对） */
const R_OK = { role: '错误位置', x: 0.1, y: 0.23333, w: 0.4, h: 0.16667, pageSha: SIX64A, imgW: PAGE_W, imgH: PAGE_H };
const R_PUBLIC = { role: '公共条件', x: 0, y: 0, w: 1, h: 0.2, pageSha: 'b'.repeat(64), imgW: 800, imgH: 600 };
const R_FIG = { role: '配图', x: 0.5, y: 0.5, w: 0.25, h: 0.25, pageSha: SIX64A, imgW: PAGE_W, imgH: PAGE_H };

/** 六类违规（每条只错一处；idx = 门禁在哪一条上点名） */
const BAD = [
  { key: 'M0001', idx: 0, code: 'role-unknown', region: { role: '随便什么角色', x: 0.1, y: 0.1, w: 0.2, h: 0.2, pageSha: SIX64A, imgW: PAGE_W, imgH: PAGE_H } },
  { key: 'M0002', idx: 0, code: 'bounds', region: { role: '错误位置', x: 0.8, y: 0.1, w: 0.4, h: 0.2, pageSha: SIX64A, imgW: PAGE_W, imgH: PAGE_H } },
  { key: 'M0003', idx: 0, code: 'imgw-missing', region: { role: '错误位置', x: 0.1, y: 0.1, w: 0.2, h: 0.2, pageSha: SIX64A } },
  { key: 'M0004', idx: 0, code: 'imgw-nonpositive', region: { role: '错误位置', x: 0.1, y: 0.1, w: 0.2, h: 0.2, pageSha: SIX64A, imgW: 0, imgH: PAGE_H } },
  { key: 'M0005', idx: 0, code: 'pagesha', region: { role: '错误位置', x: 0.1, y: 0.1, w: 0.2, h: 0.2, pageSha: 'abc', imgW: PAGE_W, imgH: PAGE_H } },
  { key: 'M0006', idx: 1, code: 'cross-page', regions: [
    { role: '错误位置', x: 0.1, y: 0.1, w: 0.2, h: 0.2, pageSha: 'c'.repeat(64), imgW: 800, imgH: 600 },
    { role: '配图', x: 0.3, y: 0.3, w: 0.2, h: 0.2, pageSha: 'c'.repeat(64), imgW: 1600, imgH: 1200 },
  ] },
];

/** 造库：一个学生 + 7 张卡（index 与卡目录一一对应）+ 一张真 PNG 整页 */
function makeLib() {
  fs.mkdirSync(LIB, { recursive: true });
  writeJson(path.join(LIB, STUDENT, '_索引.json'), {
    student: STUDENT, grade: '九年级', subject: '数学',
    items: IDS.map((id, i) => ({ id, dir: id, source: '合成样例·区域契约 · 第' + (i + 1) + '题' })),
  });
  for (const id of IDS) fs.mkdirSync(path.join(LIB, STUDENT, id), { recursive: true });
  writePng(PAGE_ABS, PAGE_W, PAGE_H);
}
/** 写台账：regionsById = { M0001: [区域…] }；**7 张卡都要有条目**（否则门禁会因"缺条目"而红，
 *  区域判据的红绿就不可归因了）。extrasById 用于给某条塞 P1-1 同族字段。 */
function seedAll(regionsById, extrasById) {
  const cards = {};
  for (const id of IDS) {
    const e = {
      key: STUDENT + '|' + id, student: STUDENT, subject: '数学', cardDir: STUDENT + '/' + id,
      source: '合成样例·区域契约', page: PAGE_REL, box: null, by: '规则', need: false,
      note: '合成夹具', import: null,
    };
    if (regionsById && regionsById[id] !== undefined) e.regions = regionsById[id];
    Object.assign(e, (extrasById && extrasById[id]) || {});
    cards[e.key] = e;
  }
  writeJson(path.join(LIB, '_原卷台账.json'), { version: 1, generatedAt: '2026-11-03T00:00:00.000Z', note: '合成夹具台账', cards });
}
const ledgerPath = () => path.join(LIB, '_原卷台账.json');
const ledgerRaw = () => fs.readFileSync(ledgerPath(), 'utf8');

/** 从 JSON 文本里抠出某个 key 的**数组字面量原文**（含方括号；按字符串感知的括号配对） */
function arrayLiteralAfter(text, anchor) {
  const i = text.indexOf(anchor);
  if (i < 0) return null;
  const start = text.indexOf('[', i + anchor.length - 1);
  if (start < 0) return null;
  let depth = 0, q = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === '"') q = false; continue; }
    if (c === '"') { q = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return text.slice(start, j + 1); }
  }
  return null;
}
/** 目录下（递归）有没有叫 name 的文件 */
function anyFileNamed(dir, name) {
  if (!fs.existsSync(dir)) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (anyFileNamed(path.join(dir, e.name), name)) return true; }
    else if (e.name === name) return true;
  }
  return false;
}

/* ───────────────────────── 探针与辅助 ───────────────────────── */
const PROBE_SRC = [
  '/* 探针（%TEMP%）：按 argv[2] import 一个模块并打印可观测事实。',
  '   用途：验证 `_区域坐标.mjs` 导入期零副作用（不设/给错 CTB_DATA 都 import 得动），',
  '   并作为对照证明 `_待确认.mjs` 导入期就会求值库根（所以服务端不能 import 它）。 */',
  "console.log('IMPORTED ' + Object.keys(await import(process.argv[2])).sort().join(','));",
  "console.log('CTB_DATA=' + String(process.env.CTB_DATA));",
  '',
].join('\n');

/** 在干净环境里 import 一个模块：dataMode = 'unset' | 'missing' | 'ok' */
function probeImport(toolPath, dataMode) {
  const env = Object.assign({}, process.env);
  delete env.CTB_DATA;
  delete env.CTB_LOCK_TOKEN;
  env.CTB_TXN_DIR = TXN;
  if (dataMode === 'missing') env.CTB_DATA = path.join(WORK, '__不存在__');
  if (dataMode === 'ok') env.CTB_DATA = LIB;
  const r = spawnSync(process.execPath, [PROBE, pathToFileURL(toolPath).href], { cwd: ROOT, encoding: 'utf8', env });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/** 用真工具算一遍 regionsOk（子进程）。
 *
 *  ⚠ 为什么探针写得这么绕：`_原卷台账.mjs` **导入即执行 CLI**（文件末尾一整条 `if (cmd === …)`
 *    分发到 `process.exit`），而且**导入期就 `libraryRoot()` + `acquireLibLock()`**。所以：
 *      ① 不能在本进程里 import（会抢库锁、还可能 `process.exit` 掉整个用例）；
 *      ② 探针必须先 `process.argv = [node, probe, '覆盖']`（一条"有台账就只打印报告、不 exit"的子命令），
 *         再用**动态** import（静态 `import` 会被提升到赋值之前，摆 argv 就白摆了）。
 *    这条本身就是"服务端不能 import `_待确认.mjs` / `_原卷台账.mjs` 这类 CLI"的实证，
 *    也是 `_区域坐标.mjs` 必须独立成零副作用模块的理由（见 ⑦）。 */
function regionsOkOf(cases) {
  const src = [
    "import { fileURLToPath } from 'node:url';",
    "/* argv[1] 必须是**真实存在**的路径：`_路径护栏.mjs:321` 的自我 CLI 守卫在导入期就",
    "   `fs.realpathSync(process.argv[1])`（不 try），摆一个假名字会 ENOENT。 */",
    "process.argv = [process.execPath, fileURLToPath(import.meta.url), '覆盖'];",
    "const m = await import(process.env.GT_TOOL);",
    "const cases = JSON.parse(process.env.GT_CASES);",
    "console.log('<<<JSON>>>' + JSON.stringify(cases.map(c => m.regionsOk(c === null ? undefined : c))));",
    '',
  ].join('\n');
  const f = path.join(WORK, 'regions-ok-probe.mjs');
  fs.writeFileSync(f, src, 'utf8');
  const r = spawnSync(process.execPath, [f], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6,
    env: toolEnv({ GT_TOOL: pathToFileURL(TOOL_LEDGER).href, GT_CASES: JSON.stringify(cases) }),
  });
  const out = String(r.stdout || '');
  const i = out.indexOf('<<<JSON>>>');
  if (i < 0) {
    throw new Error('regionsOk 探针没打出结果：exit=' + r.status + ' ｜ stdout 尾=' + out.slice(-200).replace(/\n/g, ' / ') +
      ' ｜ stderr=' + String(r.stderr || '').slice(0, 300));
  }
  return JSON.parse(out.slice(i + '<<<JSON>>>'.length));
}

/** 变异体 = 改过的 `_原卷台账.mjs` + 它全部同目录兄弟（整目录复制，防"夹具没配好"掩盖真结论） */
function copyToolGraph(mutSrc, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const srcDir = path.join(ROOT, 'src', 'tools');
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(srcDir, f), path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, '_原卷台账.mjs'), mutSrc, 'utf8');   // UTF-8 无 BOM + LF
}

/** 起一个**独立端口**的服务端实例（库根由 CTB_DATA 显式给；绝不碰用户那个 7187） */
function startServerAt(port, lib) {
  const proc = spawn(process.execPath, [TOOL_SERVER], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: lib, GLIMMERNOTE_PROC: PROC, CTB_TXN_DIR: TXN }),
  });
  const s = { proc, out: '', err: '', port };
  proc.stdout.on('data', d => { s.out += d; });
  proc.stderr.on('data', d => { s.err += d; });
  s.stop = () => new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; setTimeout(res, 120); } };
    proc.once('exit', fin);
    try { proc.kill(); } catch (e) { }
    setTimeout(fin, 1500);
  });
  return s;
}

/* ══════════════════════════════════ 主流程 ══════════════════════════════════ */
(async () => {
  console.log('临时库：' + LIB + '\n工作区：' + WORK + '\n');
  fs.writeFileSync(PROBE, PROBE_SRC, 'utf8');
  makeLib();

  /* ════════ ① regionsOk：合规通过 + 六类违规各自判红 ════════ */
  console.log('══ ① regionsOk()：合规 + 六类违规（表驱动，子进程真 import 真工具） ══');
  {
    seedAll(null);                                       // 探针里 CLI 走 `覆盖`：先保证台账存在（否则它 exit 1）
    const cases = [
      null,                                                   // regions 缺失 ⇒ 旧记录，照旧
      [R_OK],                                                 // 合规
      [R_OK, R_PUBLIC, R_FIG],                                // 跨页合规（不同 pageSha、各自宽高）
      { role: '错误位置' },                                   // regions-not-array
      [123],                                                  // region-not-object
      [BAD[0].region], [BAD[1].region], [BAD[2].region], [BAD[3].region], [BAD[4].region], BAD[5].regions,
    ];
    const res = regionsOkOf(cases);
    A('① 前置：探针返回条数与输入一致', res.length === cases.length, res.length + ' vs ' + cases.length);
    A('★ ① regions 缺失（旧记录没有该字段）⇒ 合规，errors 空', res[0].ok === true && res[0].errors.length === 0, JSON.stringify(res[0]));
    A('★ ① 合规区域（一条）⇒ 通过', res[1].ok === true, JSON.stringify(res[1].errors));
    A('★ ① 跨页三条（各自 pageSha 与宽高）⇒ 通过', res[2].ok === true, JSON.stringify(res[2].errors));
    A('★ ① regions 存在但不是数组 ⇒ 判红 regions-not-array', res[3].ok === false && res[3].errors[0].code === 'regions-not-array', JSON.stringify(res[3].errors));
    A('★ ① 元素不是对象 ⇒ 判红 region-not-object', res[4].ok === false && res[4].errors[0].code === 'region-not-object', JSON.stringify(res[4].errors));
    for (let i = 0; i < 6; i++) {
      const r = res[5 + i], want = BAD[i].code;
      const hit = (r.errors || []).find(e => e.code === want);
      A('★ ① 违规[' + want + '] ⇒ 判红且原因带具体数值/取值', r.ok === false && !!hit && String(hit.why).length > 12,
        (hit ? hit.why : JSON.stringify(r.errors)).slice(0, 150));
    }
    A('① 越界原因写清了"x+w=1.2 越出右边界"',
      /x\+w=1\.2 越出右边界/.test(JSON.stringify(res[6].errors)), JSON.stringify(res[6].errors).slice(0, 160));
    A('① 缺宽高原因写清"缺 imgW/imgH（显示宽高必需，缺了坐标不可复算）"',
      /缺 imgW\/imgH（显示宽高必需/.test(JSON.stringify(res[7].errors)), JSON.stringify(res[7].errors).slice(0, 160));
    A('① 跨页原因点名两条各自的宽高（800x600 vs 1600x1200）',
      /800x600/.test(JSON.stringify(res[10].errors)) && /1600x1200/.test(JSON.stringify(res[10].errors)),
      JSON.stringify(res[10].errors).slice(0, 200));
  }

  /* ════════ ② 门禁 真跑：合规 → 0；六类违规各自 → 1 且点名原因 ════════ */
  console.log('\n══ ② 门禁 真跑：合规 regions → exit 0；六类违规各自 → exit 1 并点名具体原因 ══');
  {
    seedAll({ M0001: [R_OK, R_FIG] });
    const ok = runTool(TOOL_LEDGER, ['门禁']);
    A('★ ② 合规 regions ⇒ 门禁 exit 0（其余 6 张卡也都有条目，红绿可归因）', ok.code === 0,
      'exit=' + ok.code + ' | ' + (ok.out + ok.err).split('\n').filter(l => l.includes('✗')).slice(0, 2).join(' | '));

    for (const b of BAD) {
      seedAll({ [b.key]: b.regions || [b.region] });
      const r = runTool(TOOL_LEDGER, ['门禁']);
      const all = r.out + r.err;
      const line = (all.split('\n').find(l => l.includes('区域[')) || '(无)').trim();
      A('★ ② 违规[' + b.code + '] ⇒ 门禁 exit 1', r.code === 1, 'exit=' + r.code);
      A('★ ② 违规[' + b.code + '] ⇒ 输出点名「区域[' + b.idx + '] 非法（' + b.code + '）」并给具体原因',
        all.includes('区域[' + b.idx + '] 非法（' + b.code + '）'), line.slice(0, 170));
    }

    /* 兼容红线：条目**没有** regions 字段时，日志里一个"区域"都不该出现 */
    seedAll(null);
    const g0 = runTool(TOOL_LEDGER, ['门禁']);
    A('★ ② 条目没有 regions ⇒ 门禁 exit 0 且输出里"区域"零命中（旧行为一字不变）',
      g0.code === 0 && !/区域\[/.test(g0.out + g0.err), 'exit=' + g0.code);
  }

  /* ════════ ③ 重建保留 regions[]（逐字节）+ P1-1 显式断言有牙齿 ════════ */
  console.log('\n══ ③ 生成（重建）后 regions[] 逐字节保留；白名单误加 regions ⇒ 显式断言拦下 ══');
  {
    seedAll({ M0001: [R_OK, R_FIG], M0002: [R_PUBLIC] }, { M0001: { sha256: 'deadbeef', lost: false, locFile: '结果-1.json' } });
    const beforeText = ledgerRaw();
    const beforeBlk = arrayLiteralAfter(beforeText, '"regions"');
    const seed = readJson(ledgerPath());
    A('③ 前置：能从台账原文里抠出 regions 数组字面量', !!beforeBlk && beforeBlk.startsWith('['), String(beforeBlk).slice(0, 90));

    const g = runTool(TOOL_LEDGER, ['生成']);
    A('③ 生成 真跑成功', g.code === 0, 'exit=' + g.code + ' ' + g.err.split('\n')[0]);
    const after = readJson(ledgerPath());
    const afterText = ledgerRaw();
    A('★ ③ 重建后 regions 值（键序+数值）逐字节不变',
      deepEq(after.cards['学生A|M0001'].regions, seed.cards['学生A|M0001'].regions),
      JSON.stringify(after.cards['学生A|M0001'].regions));
    A('★ ③ 重建后台账**原文**里 regions 数组字面量逐字节等于重建前的那一段',
      !!beforeBlk && afterText.includes(beforeBlk), '块长=' + String(beforeBlk).length);
    A('③ 另一条卡的 regions 也在', deepEq(after.cards['学生A|M0002'].regions, [R_PUBLIC]), JSON.stringify(after.cards['学生A|M0002'].regions));
    A('③ P1-1 同族字段（sha256/lost/locFile）也照旧保留',
      after.cards['学生A|M0001'].sha256 === 'deadbeef' && after.cards['学生A|M0001'].lost === false && after.cards['学生A|M0001'].locFile === '结果-1.json',
      JSON.stringify({ sha256: after.cards['学生A|M0001'].sha256, lost: after.cards['学生A|M0001'].lost, locFile: after.cards['学生A|M0001'].locFile }));

    /* —— 阴性自证：把 `regions` 加进 KNOWN_CARD_FIELDS（正是"看起来更显式"的误改）⇒ 必须被拦下 —— */
    const ORIG = fs.readFileSync(TOOL_LEDGER, 'utf8');
    const ANCHOR = 'const KNOWN_CARD_FIELDS = new Set([';
    A('③ 前置：白名单锚点存在且唯一', (ORIG.split(ANCHOR).length - 1) === 1, '出现 ' + (ORIG.split(ANCHOR).length - 1) + ' 次');
    const mutSrc = ORIG.replace(ANCHOR, "const KNOWN_CARD_FIELDS = new Set(['regions',");
    A('③ 前置：变异真的发生（不是空操作）', mutSrc !== ORIG && mutSrc.includes("new Set(['regions',"));
    A('③ 前置：变异只多一个词，行数不变', mutSrc.split('\n').length === ORIG.split('\n').length, ORIG.split('\n').length + ' → ' + mutSrc.split('\n').length);
    const mutDir = path.join(MUT, 'known-fields');
    copyToolGraph(mutSrc, mutDir);
    const mutTool = path.join(mutDir, '_原卷台账.mjs');
    A('③ 前置：变异体语法自检通过（node --check）', spawnSync(process.execPath, ['--check', mutTool], { encoding: 'utf8' }).status === 0);

    const hashBeforeMut = sha256(ledgerPath());
    const gm = runTool(mutTool, ['生成']);
    A('★★ 阴性自证：白名单误加 regions ⇒ 生成 exit 1（P1-1 显式断言真的会红）', gm.code === 1, 'exit=' + gm.code + ' ' + (gm.err || '').split('\n')[0]);
    A('★★ 阴性自证：报错点名 regions[]、条数与误加白名单这条根因',
      /重建会吃掉 2 条的 regions\[\]/.test(gm.err + gm.out) && /KNOWN_CARD_FIELDS/.test(gm.err + gm.out) &&
      /学生A\|M0001/.test(gm.err + gm.out),
      (gm.err || '').split('\n')[0].slice(0, 170));
    A('★★ 阴性自证：被拦下时台账**一个字节都没写**（先断言后写盘）',
      sha256(ledgerPath()) === hashBeforeMut, '台账哈希未变');
    A('③ 仓库里的真源码未被改动（变异只在临时副本上做）', fs.readFileSync(TOOL_LEDGER, 'utf8') === ORIG);
  }

  /* ════════ ④ normEvidenceBox：真合成图上的往返 + 量不出给原因 ════════ */
  console.log('\n══ ④ normEvidenceBox()：PNG / JPEG / 带 EXIF 方向的 JPEG；量不出给原因不给 0 ══');
  {
    const JPG = path.join(LIB, '原卷', '合成-800x600.jpg');
    const JPG_EXIF = path.join(LIB, '原卷', '合成-横拍-exif6.jpg');
    const NOTIMG = path.join(LIB, '原卷', '不是图.jpg');
    writeJpeg(JPG, 800, 600, null);
    writeJpeg(JPG_EXIF, 800, 600, 6);                  // orientation=6 ⇒ 显示时交换宽高
    fs.writeFileSync(NOTIMG, '这不是图片，只有一行字\n', 'utf8');

    /* `_区域坐标.mjs` 零导入期副作用 ⇒ 本进程里可以直接 import（与⑦互相印证） */
    const coord = await import(pathToFileURL(TOOL_COORD).href);
    const cases = [
      { name: 'PNG 1600x1200', boxPx: [160, 280, 640, 200], imgAbs: PAGE_ABS, wantW: PAGE_W, wantH: PAGE_H },
      { name: 'JPEG 800x600', boxPx: [80, 60, 400, 300], imgAbs: JPG, wantW: 800, wantH: 600 },
      { name: 'JPEG EXIF=6（存储 800x600 ⇒ 显示 600x800）', boxPx: [60, 80, 300, 400], imgAbs: JPG_EXIF, wantW: 600, wantH: 800 },
    ];
    for (const c of cases) {
      const r = coord.normEvidenceBox({ boxPx: c.boxPx, imgAbs: c.imgAbs });
      A('★ ④ ' + c.name + '：量出显示宽高 ' + c.wantW + 'x' + c.wantH,
        r.ok === true && r.imgW === c.wantW && r.imgH === c.wantH, JSON.stringify(r));
      if (!r.ok) continue;
      const back = [r.boxNorm[0] * r.imgW, r.boxNorm[1] * r.imgH, r.boxNorm[2] * r.imgW, r.boxNorm[3] * r.imgH];
      const worst = Math.max(...c.boxPx.map((v, i) => Math.abs(v - back[i])));
      A('★ ④ ' + c.name + '：boxNorm × imgW/imgH 复算回原像素框，误差 ≤ 1px（实测 ' + worst.toFixed(3) + 'px）',
        worst <= 1, '原=' + JSON.stringify(c.boxPx) + ' 回算=' + JSON.stringify(back.map(n => Math.round(n * 1000) / 1000)));
    }
    const rMissing = coord.normEvidenceBox({ boxPx: [10, 10, 20, 20], imgAbs: path.join(LIB, '原卷', '不存在.png') });
    A('★ ④ 图不在盘 ⇒ ok:false + 原因带图路径，**不给 imgW/imgH**（绝不当 0）',
      rMissing.ok === false && /不在盘/.test(rMissing.why) && rMissing.imgW === undefined && rMissing.imgH === undefined,
      JSON.stringify(rMissing));
    const rBad = coord.normEvidenceBox({ boxPx: [10, 10, 20, 20], imgAbs: NOTIMG });
    A('★ ④ 文件在但读不出文件头 ⇒ ok:false + 原因（格式不支持/损坏），仍不给 0',
      rBad.ok === false && /读不出文件头/.test(rBad.why) && rBad.imgW === undefined, JSON.stringify(rBad));
    const rNull = coord.normEvidenceBox({ boxPx: [10, 10, 20, 20], imgAbs: null });
    A('★ ④ 没有证据图路径 ⇒ ok:false + 原因', rNull.ok === false && /没有证据图路径/.test(rNull.why), JSON.stringify(rNull));
    const rOut = coord.normEvidenceBox({ boxPx: [1500, 10, 200, 20], imgAbs: PAGE_ABS });
    A('★ ④ 像素框越出图片范围 ⇒ ok:false + 原因（不许夹到 0~1 冒充合法框）',
      rOut.ok === false && /超出图片范围/.test(rOut.why), JSON.stringify(rOut));
    const rZero = coord.boxNormOf([10, 10, 20, 20], 0, 600);
    A('★ ④ imgW=0 ⇒ 判红（0 不是"不知道"的合法写法）', rZero.ok === false && /不是正整数/.test(rZero.why), JSON.stringify(rZero));
    A('④ 合规换算值精确：PNG boxNorm = [0.1,0.23333,0.4,0.16667]',
      deepEq(coord.boxNormOf([160, 280, 640, 200], PAGE_W, PAGE_H).boxNorm, [0.1, 0.23333, 0.4, 0.16667]),
      JSON.stringify(coord.boxNormOf([160, 280, 640, 200], PAGE_W, PAGE_H).boxNorm));
  }

  /* ════════ ⑤ GET /api/state：附加三字段，旧字段与旧行为不变 ════════ */
  console.log('\n══ ⑤ GET /api/state：pending 条目附加 boxNorm/imgW/imgH（只加不改） ══');
  {
    const P1 = { id: 'T001', student: STUDENT, subject: '数学', cardId: 'M0001', kind: '卷面辨认', askWho: '原卷', question: '合成条目一：这条只用来验证字段附加。', qRef: '第1题', box: [160, 280, 640, 200], evidence: PAGE_REL, status: '未确认', raisedAt: '2026-11-03', boxFix: '历史留痕' };
    const P2 = { id: 'T002', student: STUDENT, subject: '数学', cardId: 'M0002', kind: '卷面辨认', askWho: '原卷', question: '合成条目二：没有像素框，不该被加任何字段。', qRef: '第2题', box: null, evidence: PAGE_REL, status: '未确认', raisedAt: '2026-11-03' };
    const P3 = { id: 'T003', student: STUDENT, subject: '数学', cardId: 'M0003', kind: '卷面辨认', askWho: '原卷', question: '合成条目三：证据图不在盘，只该给原因。', qRef: '第3题', box: [10, 10, 20, 20], evidence: '原卷/不存在.png', status: '未确认', raisedAt: '2026-11-03' };
    const items = [P1, P2, P3];
    writeJson(path.join(LIB, '_待确认.json'), { note: '合成待确认台账', items, seq: 3 });
    const pendBytes = fs.readFileSync(path.join(LIB, '_待确认.json'));
    const pendHash = sha256(path.join(LIB, '_待确认.json'));
    const st = fs.statSync(path.join(LIB, '_待确认.json'));
    const stateDoc = {
      version: 3, generatedAt: '2026-11-03T00:00:00.000Z', data: [],
      pending: { ok: false, problems: ['待确认 3 条'], open: 3, items },
      _pendingSrc: { mtimeMs: st.mtimeMs, size: st.size, hash: sha1_16(pendBytes) },
    };
    writeJson(path.join(LIB, '_状态.json'), stateDoc);
    const stateHash = sha256(path.join(LIB, '_状态.json'));

    const srv = startServerAt(PORT, LIB);
    try {
      if (!await waitHealth(PORT)) {
        A('⑤ 被测实例启动（127.0.0.1:' + PORT + '）', false, 'health 超时；stderr=' + srv.err.slice(0, 300));
      } else {
        A('⑤ 被测实例启动（127.0.0.1:' + PORT + '，库=%TEMP% 临时库）', true);
        const g = await req(PORT, '/api/state');
        A('⑤ GET /api/state → 200 且带 pending 分区', g.status === 200 && !!(g.json && g.json.pending), 'status=' + g.status);
        const got = (g.json && g.json.pending && g.json.pending.items) || [];
        A('⑤ 前置：三条条目都在响应里', got.length === 3, 'items=' + got.length);
        const [i1, i2, i3] = got;

        /* —— 条①：有像素框 + 真图 ⇒ 附加三字段 —— */
        A('★ ⑤ 条① 附加 boxNorm=[0.1,0.23333,0.4,0.16667] 与 imgW/imgH=1600x1200',
          deepEq(i1.boxNorm, [0.1, 0.23333, 0.4, 0.16667]) && i1.imgW === PAGE_W && i1.imgH === PAGE_H,
          JSON.stringify({ boxNorm: i1.boxNorm, imgW: i1.imgW, imgH: i1.imgH }));
        A('★ ⑤ 条① 三个新字段**追加在末尾**（同一分区多次 GET 才会逐字节一致）',
          deepEq(Object.keys(i1).slice(-3), ['boxNorm', 'imgW', 'imgH']), JSON.stringify(Object.keys(i1)));
        const baseKeys = Object.keys(P1);
        const extraKeys = Object.keys(i1).filter(k => !baseKeys.includes(k));
        A('★ ⑤ 条① 旧字段**一个不多一个不少**，且值逐字节不变（含未知字段 boxFix）',
          deepEq(extraKeys, ['boxNorm', 'imgW', 'imgH']) && baseKeys.every(k => deepEq(i1[k], P1[k])),
          '新增=' + JSON.stringify(extraKeys) + ' 变了的旧字段=' + JSON.stringify(baseKeys.filter(k => !deepEq(i1[k], P1[k]))));

        /* —— 条②：没有像素 box ⇒ 一个字段都不加 —— */
        A('★ ⑤ 条② 没有像素 box ⇒ keys 与旧的一模一样（不加 boxNorm/imgW/imgH/boxNormWhy）',
          deepEq(Object.keys(i2).sort(), Object.keys(P2).sort()) && Object.keys(P2).every(k => deepEq(i2[k], P2[k])),
          JSON.stringify(Object.keys(i2)));

        /* —— 条③：图不在盘 ⇒ 只给原因，绝不给 0 —— */
        A('★ ⑤ 条③ 图量不出 ⇒ 只给 boxNormWhy（带图路径），**不给 imgW/imgH**',
          typeof i3.boxNormWhy === 'string' && /不在盘/.test(i3.boxNormWhy) && i3.imgW === undefined && i3.imgH === undefined && i3.boxNorm === undefined,
          JSON.stringify({ boxNormWhy: i3.boxNormWhy, imgW: i3.imgW }));
        A('★ ⑤ 条③ 旧字段同样逐字节不变', Object.keys(P3).every(k => deepEq(i3[k], P3[k])), JSON.stringify(Object.keys(i3)));

        /* —— 顶层旧字段与旧行为 —— */
        A('★ ⑤ 顶层旧字段（version/generatedAt/data/_pendingSrc）逐字节不变',
          g.json.version === stateDoc.version && g.json.generatedAt === stateDoc.generatedAt &&
          deepEq(g.json.data, stateDoc.data) && deepEq(g.json._pendingSrc, stateDoc._pendingSrc),
          JSON.stringify({ version: g.json.version, generatedAt: g.json.generatedAt }));
        A('★ ⑤ 顶层行为没变：pending.ok/open/problems 与状态包一致',
          g.json.pending.ok === stateDoc.pending.ok && g.json.pending.open === stateDoc.pending.open && deepEq(g.json.pending.problems, stateDoc.pending.problems),
          JSON.stringify({ ok: g.json.pending.ok, open: g.json.pending.open, problems: g.json.pending.problems }));
        A('★ ⑤ 没有多出降级/错误标记（degraded/pendingStale/stateStale/stateUnreadable 都不该出现）',
          g.json.degraded === undefined && g.json.pendingStale === undefined && g.json.stateStale === undefined && g.json.stateUnreadable === undefined,
          JSON.stringify({ degraded: g.json.degraded, pendingStale: g.json.pendingStale }));

        const g2 = await req(PORT, '/api/state');
        A('★ ⑤ GET 是只读：_状态.json 与 _待确认.json 两个真源哈希都没变（磁盘旧值一个字不改）',
          sha256(path.join(LIB, '_状态.json')) === stateHash && sha256(path.join(LIB, '_待确认.json')) === pendHash, '');
        A('⑤ 页面取数两次逐字节一致（同一分区多次 GET 不抖）', g2.text === g.text, '两次响应文本' + (g2.text === g.text ? '一致' : '不一致'));

        /* —— 与 CLI 侧对拍：同一实现（唯一实现不许两份答案） —— */
        const cli = runTool(TOOL_PENDING, ['门禁', '--json']);
        let cliJson = null;
        try { cliJson = JSON.parse(String(cli.out).slice(String(cli.out).indexOf('{'), String(cli.out).lastIndexOf('}') + 1)); } catch (e) { }
        const ct = cliJson && (cliJson.items || []).find(x => x.id === 'T001');
        const ct2 = cliJson && (cliJson.items || []).find(x => x.id === 'T002');
        const ct3 = cliJson && (cliJson.items || []).find(x => x.id === 'T003');
        A('★ ⑤ CLI `门禁 --json` 与 `/api/state` 对同一条给出**完全相同**的 boxNorm/imgW/imgH（唯一实现）',
          !!ct && deepEq(ct.boxNorm, i1.boxNorm) && ct.imgW === i1.imgW && ct.imgH === i1.imgH,
          JSON.stringify({ cli: ct && { boxNorm: ct.boxNorm, imgW: ct.imgW, imgH: ct.imgH }, srv: { boxNorm: i1.boxNorm, imgW: i1.imgW, imgH: i1.imgH } }));
        A('⑤ CLI 侧：没有 box 的条目同样不加字段、坏图同样只给原因且不给 0',
          !!ct2 && !!ct3 && ct2.boxNorm === undefined && ct2.imgW === undefined &&
          typeof ct3.boxNormWhy === 'string' && ct3.imgW === undefined && ct3.imgH === undefined,
          JSON.stringify({ t2: ct2 && Object.keys(ct2), t3: ct3 && ct3.boxNormWhy }));
        A('⑤ CLI 侧磁盘旧值不变（跑完门禁后 _待确认.json 哈希仍是原值）',
          sha256(path.join(LIB, '_待确认.json')) === pendHash, '');
      }
    } finally {
      await srv.stop();
    }
  }

  /* ════════ ⑥ 阴性自证：掏掉「imgW/imgH 必需且正整数」⇒ ②的两格必须变绿 ════════ */
  console.log('\n══ ⑥ 阴性自证：掏掉「缺 imgW / imgW 非正」两条判据 ⇒ 门禁必须当场变绿（判据真有牙齿） ══');
  {
    const ORIG = fs.readFileSync(TOOL_LEDGER, 'utf8');
    /* 锚点覆盖**两条**判据（缺 ⇒ imgw-missing；非正整数 ⇒ imgw-nonpositive）：
       只掏第一条会在 `else if` 上继续红成 imgw-nonpositive，"缺 imgW"那格就变不成绿——
       第一版就踩了这个坑（见本用例头注"每条判据配掏掉它必须变红的对照"）。 */
    const ANCHOR_RE = /if \(r\.imgW == null \|\| r\.imgH == null\) err\(i, 'imgw-missing'[\s\S]*?imgW\/imgH 必须是正整数：[\s\S]*?\);\n/;
    A('⑥ 前置：阴性自证锚点存在且唯一', (ORIG.match(ANCHOR_RE) || []).length === 1, '命中 ' + (ORIG.match(ANCHOR_RE) || []).length + ' 次');
    const mutSrc = ORIG.replace(ANCHOR_RE, '');
    A('⑥ 前置：变异真的发生（judgement 整体消失，不是空操作）', mutSrc !== ORIG && !/imgw-missing|imgw-nonpositive/.test(mutSrc));
    A('⑥ 前置：只少了那两行，其余行数不变', mutSrc.split('\n').length === ORIG.split('\n').length - 2,
      ORIG.split('\n').length + ' → ' + mutSrc.split('\n').length);
    const mutDir = path.join(MUT, 'no-imgw-required');
    copyToolGraph(mutSrc, mutDir);
    const mutTool = path.join(mutDir, '_原卷台账.mjs');
    A('⑥ 前置：变异体语法自检通过（node --check）', spawnSync(process.execPath, ['--check', mutTool], { encoding: 'utf8' }).status === 0);

    seedAll({ M0003: [BAD[2].region] });               // 缺 imgW/imgH
    const real = runTool(TOOL_LEDGER, ['门禁']);
    A('★ ⑥ 真源码：缺 imgW ⇒ exit 1 且点名 imgw-missing',
      real.code === 1 && /imgw-missing/.test(real.out + real.err), 'exit=' + real.code);
    const mut = runTool(mutTool, ['门禁']);
    A('★★ 阴性自证：判据被掏掉后，同一条数据 ⇒ 门禁 exit 0（②的"缺 imgW"那格确实靠这条判据）',
      mut.code === 0, 'exit=' + mut.code + ' | ' + (mut.out + mut.err).split('\n').filter(l => l.includes('✗')).slice(0, 2).join(' | '));

    seedAll({ M0004: [BAD[3].region] });               // imgW=0（非正整数）
    const real2 = runTool(TOOL_LEDGER, ['门禁']);
    const mut2 = runTool(mutTool, ['门禁']);
    A('★ ⑥ 真源码：imgW=0 ⇒ exit 1 且点名 imgw-nonpositive',
      real2.code === 1 && /imgw-nonpositive/.test(real2.out + real2.err), 'exit=' + real2.code);
    A('★★ 阴性自证：同一变异下"imgW 非正"那格也变绿（两格共用这段判据）', mut2.code === 0, 'exit=' + mut2.code);
    A('⑥ 仓库里的真源码未被改动（变异只在临时副本上做）', fs.readFileSync(TOOL_LEDGER, 'utf8') === ORIG);
  }

  /* ════════ ⑦ `_区域坐标.mjs` 零导入期副作用 ════════ */
  console.log('\n══ ⑦ `_区域坐标.mjs` 零导入期副作用（不求值库根/不抢锁/不写库） ══');
  {
    const src = fs.readFileSync(TOOL_COORD, 'utf8');
    /* ⚠ 静态断言必须**先剥注释**：本仓有过"修复说明把旧写法抄进注释 ⇒ 断言被自己的注释判红"的事故
       （见 neg-server-lib.cjs::stripComments 的说明）。本文件的头注里就写着 `libraryRoot()` 等词。 */
    const code = stripComments(src);
    A('★ ⑦ 源码里不 import 库根/写锁/过程目录（导入期求值库根与抢锁的入口）',
      !/from '\.\/_库根\.mjs'/.test(src) && !/from '\.\/_安全写\.mjs'/.test(src) && !/from '\.\/_过程目录\.mjs'/.test(src), '');
    A('★ ⑦ 可执行代码里不出现 libraryRoot(/acquireLibLock(/procPath(/writeFileSync(',
      !/libraryRoot\s*\(/.test(code) && !/acquireLibLock\s*\(/.test(code) && !/procPath\s*\(/.test(code) && !/writeFileSync\s*\(/.test(code), '');
    A('★ ⑦ 只按传入的绝对路径读文件头（fs.statSync + displaySize），不整文件读',
      /fs\.statSync/.test(code) && /displaySize/.test(code) && !/readFileSync/.test(code), '');

    fs.rmSync(TXN, { recursive: true, force: true });
    const p1 = probeImport(TOOL_COORD, 'unset');
    A('★ ⑦ 不设 CTB_DATA 也 import 得动', p1.code === 0, 'exit=' + p1.code + ' ' + (p1.err || '').split('\n').slice(0, 2).join(' | '));
    const p1keys = (p1.out.split('\n')[0] || '').replace('IMPORTED ', '').split(',').filter(Boolean);
    A('★ ⑦ 形状冻结的三个函数都在：boxNormOf / evidenceAbs / normEvidenceBox',
      ['boxNormOf', 'evidenceAbs', 'normEvidenceBox'].every(k => p1keys.includes(k)), JSON.stringify(p1keys));
    A('★ ⑦ import 后进程环境变量一字未改（CTB_DATA 仍是 undefined）', /CTB_DATA=undefined/.test(p1.out), p1.out.trim().replace(/\n/g, ' | '));
    A('★ ⑦ import 不建锁、不落任何文件（CTB_TXN_DIR 里没有 lock）',
      !anyFileNamed(TXN, 'lock'), fs.existsSync(TXN) ? fs.readdirSync(TXN).join(',') : '(目录未创建)');
    const p2 = probeImport(TOOL_COORD, 'missing');
    A('★ ⑦ CTB_DATA 指向不存在的目录也照样 import 得动（压根没求值库根）', p2.code === 0, 'exit=' + p2.code + ' ' + (p2.err || '').split('\n').slice(0, 2).join(' | '));
    A('★ ⑦ 给正常 CTB_DATA 也一样干净：import 成功、仍不建锁', probeImport(TOOL_COORD, 'ok').code === 0 && !anyFileNamed(TXN, 'lock'), '');

    /* 装置有牙齿：同一条件下 import `_待确认.mjs` 必须抛错（导入期 libraryRoot()） */
    const p3 = probeImport(TOOL_PENDING, 'missing');
    A('★★ 装置自证：同条件 import `_待确认.mjs` ⇒ 抛错（这就是"服务端不能 import 它"的实测依据）',
      p3.code !== 0 && /CTB_DATA 指向的目录不存在/.test(p3.err), 'exit=' + p3.code + ' ' + String((p3.err || '').split('\n').find(l => l.includes('库根')) || '').trim().slice(0, 130));
  }

  const code = end('区域契约 + P2-2 统一坐标系');
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { }
  process.exit(code);
})().catch(e => {
  console.log('[FAIL] 用例自身抛错：' + (e && e.stack || e));
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (x) { }
  process.exit(1);
});
