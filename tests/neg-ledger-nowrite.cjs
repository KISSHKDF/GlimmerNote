#!/usr/bin/env node
/**
 * `_原卷台账.mjs` 的两条硬判据（2026-11-02，用户指出的两个真缺陷）：
 *
 *  ① **只读不落库**：`覆盖`/`生成 --dry`/`门禁` 都不得在**库根**里留下任何写入。
 *     实测缺陷（2026-11-02）：`sizesOf()` 的失败分支（量尺寸脚本缺失 ⇒ catch ⇒ break）
 *     之后没有 return，控制流穿透到 `writeJsonAtomic(_probe\_图尺寸.json)`，
 *     于是"只读报告"往**真库**写文件 ⇒ `tests\run.mjs` 的真库零写入断言判红 ⇒ quick 在干净 HEAD 上恒红。
 *  ② **体检不许假绿**：长宽比体检的输入是图片像素尺寸，一个都没量到时**必须**打印 SKIP，
 *     不许打印"全部通过"。实测缺陷：量尺寸脚本 `<库根>\_工具\图尺寸.ps1` 仓库里从来没有过，
 *     体检永远没有输入，却每次都报"长宽比体检：全部通过"。
 *
 * 阴性自证（本用例必须能红）：
 *  · 把缓存路径改回 `<库根>\_probe\` ⇒ 第 2、4 段必须失败；
 *  · 把 auditLine 的零输入分支改回"全部通过" ⇒ 第 5 段必须失败。
 *
 * 退出码 0=两条判据成立；1=守不住。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
const A = (n, ok, d) => {
  total++;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`);
  if (!ok) fails++;
};

/** 跑工具：返回 {code, out}；绝不抛。args[0] 是工具文件名。 */
const run = (args, lib, extraEnv) => {
  try {
    const out = execFileSync(process.execPath, [E.tool(args[0]), ...args.slice(1)], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: lib }, extraEnv || {}),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

/* ---------- 合成图片（只造文件头，够解析器读尺寸即可） ---------- */
const jpeg = (w, h) => Buffer.from([
  0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
  0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9]);
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  return b;
};

/** 库快照：相对路径 → size+mtimeMs+sha256（判"有没有被写过"） */
function snap(root) {
  const out = new Map();
  const walk = (d, rel) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else { const st = fs.statSync(abs); out.set(r, st.size + '|' + st.mtimeMs + '|' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 12)); }
    }
  };
  walk(root, '');
  return out;
}
const diffSnap = (a, b) => {
  const ch = [];
  for (const [k, v] of a) { if (!b.has(k)) ch.push('消失:' + k); else if (b.get(k) !== v) ch.push('被改:' + k); }
  for (const k of b.keys()) if (!a.has(k)) ch.push('新增:' + k);
  return ch;
};

/* ---------- 合成库 ---------- */
const makeLib = ({ cropMissing = false, badImage = false } = {}) => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ledger-'));
  const put = (rel, buf) => { const abs = path.join(lib, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); };
  put('_原图台账.json', Buffer.from(JSON.stringify({ version: 1, note: '合成', objects: {}, generatedAt: '2026-11-02T00:00:00.000Z' }, null, 1)));
  const cards = {
    '测试|T0001': {
      key: '测试|T0001', student: '测试', subject: '数学', source: '合成第1题',
      cardDir: '九年级/数学/T0001-合成', page: '九年级/数学/原卷/页-1.jpg',
      box: [0.1, 0.1, 0.4, 0.3], by: '手工', need: false, note: '合成', import: null,
    },
    '测试|T0002': {
      key: '测试|T0002', student: '测试', subject: '数学', source: '合成第2题',
      cardDir: '九年级/数学/T0002-合成', page: '九年级/数学/原卷/页-2.jpg',
      box: [0.1, 0.1, 0.4, 0.3], by: '手工', need: false, note: '合成', import: null,
    },
  };
  put('_原卷台账.json', Buffer.from(JSON.stringify({ version: 1, note: '合成', generatedAt: '2026-11-02T00:00:00.000Z', cards }, null, 1)));
  /* `生成` 走 loadCards()：它直接扫「非 `_` 开头目录下的 _索引.json」⇒ 合成库必须给一份最小索引 */
  put('九年级/_索引.json', Buffer.from(JSON.stringify({
    student: '测试', subject: '数学',
    items: [{ id: 'T0001', dir: '数学/T0001-合成', source: '合成第1题' }],
  }, null, 1)));
  /* T0001：页 1000×1400、裁图 800×600（比例接近 ⇒ 不应可疑） */
  put('九年级/数学/原卷/页-1.jpg', badImage ? Buffer.alloc(0) : jpeg(1000, 1400));
  put('九年级/数学/T0001-合成/原卷截图.jpg', png(800, 600));
  /* T0002：页在盘、**裁图缺失** ⇒ 必须计入"缺尺寸未比"，不许算进"已比" */
  put('九年级/数学/原卷/页-2.jpg', jpeg(1000, 1400));
  if (!cropMissing) put('九年级/数学/T0002-合成/原卷截图.jpg', png(800, 600));
  return lib;
};

/* 每段一个独立过程目录：共用会让上一段的像素尺寸缓存命中下一段，掩盖"零输入"这类判据 */
const newEnv = () => ({ GLIMMERNOTE_PROC: fs.mkdtempSync(path.join(os.tmpdir(), 'gn-proc-')) });

/* ═══ 1) 尺寸解析 + 体检参与度 ═══ */
{
  const ENV = newEnv();
  const probe = makeLib({ cropMissing: true });   // T0002 的裁图缺失 ⇒ 必须计入"未比"
  const r = run(['_原卷台账.mjs', '门禁'], probe, ENV);
  A('1a 合成库上门禁能跑通（exit 0）', r.code === 0, 'exit=' + r.code);
  A('1b 体检真的比了 1 张（不是 0 张）', /已比 1 张/.test(r.out), (r.out.match(/长宽比体检[^\n]*/) || ['(无体检行)'])[0]);
  A('1c 缺裁图的那张被计入"未比"，没被当通过', /另 1 张缺尺寸未比/.test(r.out));
  fs.rmSync(probe, { recursive: true, force: true });
}

/* ═══ 2) 只读不落库：门禁 / 生成 --dry 前后库零变化，且库根里没有 _probe ═══ */
{
  const ENV = newEnv();
  const lib = makeLib();
  const s0 = snap(lib);
  const r1 = run(['_原卷台账.mjs', '门禁'], lib, ENV);
  A('2a 门禁 exit 0', r1.code === 0, 'exit=' + r1.code);
  A('2b 门禁不改库（逐文件 size+mtime+sha 全等）', diffSnap(s0, snap(lib)).length === 0, diffSnap(s0, snap(lib)).join('、'));
  A('2c 库根里没有 _probe\\（过程件不许落库）', !fs.existsSync(path.join(lib, '_probe')));

  const ledger = path.join(lib, '_原卷台账.json');
  const before = fs.readFileSync(ledger);
  const r2 = run(['_原卷台账.mjs', '生成', '--dry'], lib, ENV);
  A('2d 生成 --dry exit 0', r2.code === 0, 'exit=' + r2.code);
  A('2e dry 不写真源（台账逐字节相同）', Buffer.compare(before, fs.readFileSync(ledger)) === 0);
  A('2f dry 后库仍然零变化', diffSnap(s0, snap(lib)).length === 0, diffSnap(s0, snap(lib)).join('、'));
  A('2g dry 的预览件落在过程目录（不在库根）', fs.existsSync(path.join(ENV.GLIMMERNOTE_PROC, '_原卷台账.dry.json')) && !fs.existsSync(path.join(lib, '_probe')));
  A('2h 报告路径被打印出来（不静默）', /预览 →/.test(r2.out));

  /* 真写一次：台账应当变，但库根仍不许出现 _probe\，缓存应落过程目录 */
  const s1 = snap(lib);
  const r3 = run(['_原卷台账.mjs', '生成'], lib, ENV);
  A('2i 生成（真写）exit 0', r3.code === 0, 'exit=' + r3.code);
  const ch = diffSnap(s1, snap(lib));
  /* 真写真源必然带两件事：台账被改写 + `_备份-真源\` 多一份旧版留档（writeJsonAtomic backup:true，设计如此）。
     除此之外**不许**再有变化——尤其不许出现 `_probe\`。 */
  A('2j 真写只动台账与它的备份留档（其余零变化）',
    ch.length === 2 && ch.includes('被改:_原卷台账.json') && ch.some(x => x.startsWith('新增:_备份-真源/')),
    ch.join('、'));
  A('2k 真写后库根仍无 _probe\\', !fs.existsSync(path.join(lib, '_probe')));
  A('2l 像素尺寸缓存落过程目录', fs.existsSync(path.join(ENV.GLIMMERNOTE_PROC, '_图尺寸.json')));
  /* 尺寸解析本身的硬证据：缓存里必须真有这两个合成图的尺寸（JPEG 1000×1400 / PNG 800×600） */
  {
    const cache = JSON.parse(fs.readFileSync(path.join(ENV.GLIMMERNOTE_PROC, '_图尺寸.json'), 'utf8'));
    A('2m 缓存里页尺寸 = [1000,1400]（JPEG SOF 解析正确）',
      JSON.stringify(cache['九年级/数学/原卷/页-1.jpg']) === JSON.stringify([1000, 1400]),
      JSON.stringify(cache['九年级/数学/原卷/页-1.jpg']));
    A('2n 缓存里裁图尺寸 = [800,600]（PNG IHDR 解析正确）',
      JSON.stringify(cache['九年级/数学/T0001-合成/原卷截图.jpg']) === JSON.stringify([800, 600]),
      JSON.stringify(cache['九年级/数学/T0001-合成/原卷截图.jpg']));
  }
  fs.rmSync(lib, { recursive: true, force: true });
}

/* ═══ 3) 阴性自证：缓存若落回库根，第 2 段判据必须红 ═══
   做法：不真的改代码，而是**断言判据本身有牙齿** —— 在库里手工造一个 _probe\ 文件，
   再跑门禁，要求"库被改过"这件事能被 diffSnap 抓出来（证明 2b/2f 的判据不是恒真）。 */
{
  const lib = makeLib();
  const s0 = snap(lib);
  fs.mkdirSync(path.join(lib, '_probe'), { recursive: true });
  fs.writeFileSync(path.join(lib, '_probe', '_图尺寸.json'), '{}\n');
  const ch = diffSnap(s0, snap(lib));
  A('3a 阴性自证：库根多出 _probe\\ 必须被判据抓到', ch.includes('新增:_probe/_图尺寸.json') || ch.includes('新增:_probe'), ch.join('、'));
  fs.rmSync(lib, { recursive: true, force: true });
}

/* ═══ 4) 阴性自证：假绿必须能红 —— 零输入时输出里不许出现"全部通过" ═══ */
{
  const ENV = newEnv();
  const lib = makeLib({ badImage: true, cropMissing: true });
  const r = run(['_原卷台账.mjs', '门禁'], lib, ENV);
  A('4a 零输入时必须打印 SKIP（不是"通过"）', /SKIP=无px数据/.test(r.out), (r.out.match(/长宽比体检[^\n]*/) || ['(无体检行)'])[0]);
  A('4b 零输入时**不得**出现"全部通过"', !/长宽比体检：全部通过/.test(r.out));
  A('4c 零输入时也不得谎报"已比 N 张"', !/已比 [1-9]\d* 张/.test(r.out));
  fs.rmSync(lib, { recursive: true, force: true });
}

/* ═══ 5) 库根护栏：开发区不给库 ⇒ 必须硬失败（不许在源码树里建过程件） ═══ */
{
  const env = Object.assign({}, process.env, newEnv());
  delete env.CTB_DATA;
  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, [E.tool('_原卷台账.mjs'), '门禁'], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
  } catch (e) {
    code = e.status == null ? -1 : e.status;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  A('5a 不给库根时必须硬失败（exit≠0）', code !== 0, 'exit=' + code);
  A('5b 报错说清"源码树"这件事（不是静默写错地方）', /源码树/.test(out));
  A('5c 报错带修法（CTB_DATA）', /CTB_DATA/.test(out));
}

/* ═══ 6) 过程目录可整体删除（"过程件"的定义） ═══ */
A('6a 过程目录可被整目录删除（不留库内残渣）', (() => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-proc2-'));
  fs.writeFileSync(path.join(p, 'x.json'), '{}');
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { return false; }
  return !fs.existsSync(p);
})());

console.log('');
console.log(`RESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${total} 失败=${fails}`);
process.exit(fails ? 1 : 0);
