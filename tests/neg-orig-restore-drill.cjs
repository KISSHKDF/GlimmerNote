#!/usr/bin/env node
/**
 * 原图保全库 · 隔离恢复演练（2026-11-03 建）
 *
 * ══ 与 tests\restore-drill.cjs 的关系（两份演练各管一段，不是重复）══
 *   · `restore-drill.cjs` 管 **JSON 真源**：`_快照.mjs --restore` 的"破坏 → 恢复 → 逐字节相等"，
 *     外加形状守卫自动退回与未知参数 exit 2。
 *   · 本文件管 **不可复现的原图字节**：`_原图.mjs 入库` 的四种情形 → `_影像备份.mjs` 独立备份
 *     → **换一个全新库目录按备份恢复** → `_原图.mjs 核对 --from` 三方逐字节校验。
 *   两者同型（都拒绝"有备份 == 能恢复"这个未验证的假设），但对象不同：一个是台账，一个是原图字节。
 *
 * ══ 四种情形（施工方案 §6 批次 0 交付物 9 点名的四种）══
 *   ① 同图导入两次   同一份字节、两个文件名 ⇒ 去重成 1 个对象，两条来源都记在台账里
 *   ② 同名异图       两个目录下同名、内容不同 ⇒ **必须是 2 个对象**（路径不是身份，内容才是）
 *   ③ 带 EXIF 方向标记  只差 Orientation 的两份 JPEG ⇒ 2 个对象，且恢复后**字节完全一致**
 *                      （不得重编码、不得按方向旋转、不得剥掉 EXIF 段）
 *   ④ 跨页题         一道题的两页原图 ⇒ 两页都必须独立保全并恢复
 *
 * ══ 阴性对照：缺陷复现时它靠什么变红（每条都真跑出红）══
 *   判据若只靠自己复制完再说一句"我复制好了"，等于什么都没证明。所以每条配一个对照：
 *   ① 恢复目标里改坏 1 个字节（**长度不变**）⇒ `核对` exit 1 + "字节不符[库]"
 *      —— 靠"重算 sha256 比对"；只比 size 的判据在这里必然判绿。
 *   ② 备份副本里改坏 1 个字节 ⇒ "字节不符[备份]"
 *      —— 靠"备份也要逐字节验"，不是只验库内、也不是只信文件名（文件名还是那个 sha）。
 *   ③ 删掉恢复后的对象 ⇒ "缺文件[库]"；删掉备份里的对象 ⇒ "缺文件[备份]"
 *      —— 靠"台账是分母"；"备份里有什么就核什么"的判据两条都发现不了。
 *   ④ 只改台账里的 bytes（内容一个字节没动）⇒ "大小不符"，且**不许**同时报"字节不符"
 *      —— 靠"与台账登记值对账"。这条专门证明它不是"拿文件名当哈希自证"：文件名和内容都还是对的。
 *   ⑤ 往备份里塞一个台账不认的 64-hex 对象 ⇒ "多出"
 *      —— 靠"反向也核"（备份 → 台账），只朝台账登记方向核的判据永远看不见它。
 *   ⑥ 每次对照后都还原，并断言 `核对` **回到 exit 0** —— 证明判据不是恒红。
 *   另加"只读"判据：`核对` 前后对恢复库与备份根做整树指纹，必须逐字节不变。
 *
 * ⚠ 全程 %TEMP% 合成库，绝不碰用户真库（库根一律用 CTB_DATA 显式指到临时目录）。
 * ⚠ 夹具走 `_测试环境.cjs` 的 allocTempDir（退出统一清）。前缀刻意用 `gn-testlib-`：
 *   它已在 `_测试环境.cjs` 的 TMP_PREFIXES 里，被 SIGKILL 的残留下一轮启动清扫能认出；
 *   换成新前缀必须同时改那个文件，而它不在本任务的写作用域内。
 * 退出码 0=全部成立；1=有判据守不住（原图恢复链不可信）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, oks = 0;
const A = (label, cond, detail) => {
  if (cond) { oks++; console.log('  [OK]  ' + label + (detail ? '  → ' + detail : '')); }
  else { fails++; console.log('  [FAIL] ' + label + '  → ' + detail); }
};
const H = (s) => console.log('\n═══ ' + s + ' ═══');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const shaOfFile = (f) => sha256(fs.readFileSync(f));

/** 跑**绝对路径**的工具（阴性对照要用"源码级替身"，见第八节）；绝不抛。 */
const runAbs = (abs, args, lib) => {
  try {
    const out = execFileSync(process.execPath, [abs, ...args], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: lib }),
    });
    return { code: 0, out: String(out), err: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
};
/** 跑本仓 `src\tools\` 里的工具：显式给 CTB_DATA；**绝不抛**（要断言"它会失败"）。stdout/stderr 分开存，
 *  因为 `--json` 在退出码非 0 时仍必须可解析（机器可读结果不许只在成功路径上给）。 */
const run = (tool, args, lib) => runAbs(E.tool(tool), args, lib);
const jsonOf = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
const pick = (j, where, why) => ((j && j.diffs) || []).find((d) => d.where === where && d.why === why);

/** 目录下所有文件的绝对路径（跳 .tmp；`_快照` 不跳 —— 只读判据要连它一起看） */
const filesOf = (dir) => {
  const out = [];
  (function w(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) w(p);
      else if (!e.name.endsWith('.tmp')) out.push(p);
    }
  })(dir);
  return out.sort();
};
/** 整树指纹（路径 + 内容 sha）：用来断言"只读命令一个字节都没动" */
const fingerprint = (dir) => filesOf(dir)
  .map((p) => path.relative(dir, p).split(path.sep).join('/') + ':' + shaOfFile(p).slice(0, 16)).join('\n');
/** 库对象文件（文件名是 64 位 sha 的那些） */
const objectsOf = (dir) => filesOf(dir).filter((p) => /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/i.test(path.basename(p)));
/** 同长度改坏 1 个字节 —— 这正是"只比 size"的判据必然漏掉的那类损坏 */
const flipOneByte = (p) => {
  const b = fs.readFileSync(p);
  const i = Math.min(3, b.length - 1);
  b[i] = b[i] ^ 0xff;
  fs.writeFileSync(p, b);
  return b.length;
};

/* ══════════ 夹具：四种情形（全在 %TEMP%，合成库） ══════════ */
const LIB = E.allocTempDir('gn-testlib-');            // "现场"库
const LIB2 = E.allocTempDir('gn-testlib-');           // "换一台机器" —— 恢复到这里

const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
/** 一个"带 EXIF 方向标记"的最小 JPEG：SOI + APP1(Exif/TIFF/IFD0: Orientation=n) + 填充 + EOI。
 *  它不需要能被解码 —— 本用例证明的是**字节被原样保全**，不是"能显示"。 */
function jpegWithExif(orientation, fill) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(0x2a, 2); tiff.writeUInt32LE(8, 4);      // TIFF 头
  tiff.writeUInt16LE(1, 8);                                                                   // IFD0：1 条
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12);                                  // Orientation / SHORT
  tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18); tiff.writeUInt16LE(0, 20);
  tiff.writeUInt32LE(0, 22);                                                                  // 下一个 IFD = 0
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(exif.length + 2), exif]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app1,
    Buffer.alloc(fill, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const SAME = Buffer.alloc(3072, 0x11);            // ① 同图：同一份字节
const CLASH_A = Buffer.alloc(2048, 0x22);         // ② 同名异图（收件箱那份）
const CLASH_B = Buffer.alloc(2048, 0x33);         // ② 同名异图（原卷库那份）
const EXIF6 = jpegWithExif(6, 1500);              // ③ 方向标记 = 6（需顺时针转 90°）
const EXIF1 = jpegWithExif(1, 1500);              // ③ 同像素、只方向标记不同
const PAGE8 = Buffer.alloc(4096, 0x88);           // ④ 跨页题 · 上页
const PAGE9 = Buffer.alloc(4096, 0x99);           // ④ 跨页题 · 下页

const w = (rel, buf) => {
  const p = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
};
w('_收件箱/原卷/p01-src01.jpg', SAME);
w('_收件箱/原卷/p01-src01-dup.jpg', SAME);          // ① 同字节、不同名
w('_收件箱/原卷/p02-src02.jpg', CLASH_A);           // ② 与下一行同名
w('九年级/数学/原卷/p02-src02.jpg', CLASH_B);        // ② 内容不同
w('_收件箱/原卷/p03-src03-exif6.jpg', EXIF6);       // ③
w('_收件箱/原卷/p03-src03-exif1.jpg', EXIF1);       // ③
w('_收件箱/原卷/p08-src08.jpg', PAGE8);             // ④
w('_收件箱/原卷/p09-src09.jpg', PAGE9);             // ④
w('九年级/数学/错题/跨页题-001/题干.html',
  Buffer.from('<div>这道题的第 8 页与第 9 页各印了一半（跨页题）。</div>', 'utf8'));

console.log('夹具库：' + LIB + '\n恢复目标：' + LIB2);

/* ══════════ 一、入库（四种情形） ══════════ */
H('一、入库：同图两次 / 同名异图 / EXIF 方向 / 跨页题');
const ing = run('_原图.mjs', ['入库', '--scan'], LIB);
A('1.0 入库 --scan exit 0', ing.code === 0, 'exit=' + ing.code + ' ｜ ' + ing.out.trim().split('\n').pop());

const LEDGER = path.join(LIB, '_原图台账.json');
const doc = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const shas = Object.keys(doc.objects);
A('1.1 7 份源字节 → 7 个对象（同图去重 1 个，其余各 1 个）', shas.length === 7, shas.length + ' 个对象');

/* ① 同图导入两次 */
const sameSha = sha256(SAME);
A('① 同图两次：只存 1 个对象', shas.filter((s) => s === sameSha).length === 1);
A('① 同图两次：两个来源文件名都记进台账（溯源不丢）',
  (doc.objects[sameSha] && (doc.objects[sameSha].sources || []).length) === 2,
  JSON.stringify((doc.objects[sameSha] || {}).sources));

/* ② 同名异图 */
A('② 同名异图：两个 sha 都存在且互不相同',
  !!doc.objects[sha256(CLASH_A)] && !!doc.objects[sha256(CLASH_B)] && sha256(CLASH_A) !== sha256(CLASH_B));
A('② 同名异图：同名两份各记各的来源路径（路径不是身份）',
  (doc.objects[sha256(CLASH_A)].sources || []).includes('_收件箱/原卷/p02-src02.jpg') &&
  (doc.objects[sha256(CLASH_B)].sources || []).includes('九年级/数学/原卷/p02-src02.jpg'),
  JSON.stringify(doc.objects[sha256(CLASH_A)].sources) + ' ／ ' + JSON.stringify(doc.objects[sha256(CLASH_B)].sources));

/* ③ EXIF 方向标记 */
A('③ EXIF：只差方向标记的两份是两个对象（字节不同 ⇒ 不许当同一张）',
  !!doc.objects[sha256(EXIF6)] && !!doc.objects[sha256(EXIF1)] && sha256(EXIF6) !== sha256(EXIF1));
const exifObj = path.join(LIB, '_原图', sha256(EXIF6).slice(0, 2).toLowerCase(), sha256(EXIF6) + '.jpg');
A('③ EXIF：入库后字节逐字节等于源（未重编码/未旋转/未剥 EXIF）',
  fs.existsSync(exifObj) && shaOfFile(exifObj) === sha256(EXIF6) && fs.readFileSync(exifObj).length === EXIF6.length,
  fs.existsSync(exifObj) ? shaOfFile(exifObj).slice(0, 16) + '…' : '对象文件不存在');
A('③ EXIF：EXIF 段（`Exif\\0\\0` + Orientation）仍在对象里',
  fs.existsSync(exifObj) && fs.readFileSync(exifObj).includes(Buffer.from('Exif\0\0', 'latin1')));

/* ④ 跨页题 */
A('④ 跨页题：两页各自成对象，不合并、不丢页',
  !!doc.objects[sha256(PAGE8)] && !!doc.objects[sha256(PAGE9)] && sha256(PAGE8) !== sha256(PAGE9));

/* 幂等：同图再导一次什么都不做 */
const ing2 = run('_原图.mjs', ['入库', '--scan'], LIB);
A('1.2 重跑入库幂等（对象数不变、输出"新增 0"）',
  ing2.code === 0 && Object.keys(JSON.parse(fs.readFileSync(LEDGER, 'utf8')).objects).length === 7 && /新增 0/.test(ing2.out),
  'exit=' + ing2.code + ' ｜ ' + (ing2.out.match(/新增 \d+/) || [''])[0]);

/* ══════════ 二、"库外那一份"备用副本 ══════════
   ★ 2026-11-06（P10）：原来这一步跑 `_影像备份.mjs`（同盘镜像）。镜像已按 P10 退休 ⇒
   改成 P10 认可的形态：**库外**放一份 `_原图\` 的副本（"防盘坏"的那一份必须在库外；
   同样的字节在同一块盘上再放一份不叫备份）。`_原图.mjs 核对/恢复 --from` 认这种形态。 */
H('二、库外副本：把 `_原图\` 拷到库外（P10：保全家就是那一份备份，库外那份才防盘坏）');
const BAK = path.join(path.dirname(LIB), '库外副本', path.basename(LIB) + '-_原图');   // 库外（不在 LIB 里）
(function copyTree2(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree2(s, d); else fs.copyFileSync(s, d);
  }
})(path.join(LIB, '_原图'), BAK);
const bakObjs = objectsOf(BAK);
A('2.1 库外副本建好（库外 = ' + BAK + '）', fs.existsSync(BAK), BAK);
A('2.2 副本里有 7 个库对象（文件名 = sha）', bakObjs.length === 7, bakObjs.length + ' 个');
const bakSha6 = path.join(BAK, sha256(EXIF6).slice(0, 2).toLowerCase(), sha256(EXIF6) + '.jpg');
A('2.3 副本与源逐字节一致（含 EXIF 那份）',
  fs.existsSync(bakSha6) && shaOfFile(bakSha6) === sha256(EXIF6));

/* ══════════ 三、新目录恢复 ══════════ */
H('三、新目录恢复：从备份铺回一个全新库目录');
fs.mkdirSync(path.join(LIB2, '_原图'), { recursive: true });
let restored = 0;
(function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else { fs.copyFileSync(s, d); restored++; }
  }
})(BAK, path.join(LIB2, '_原图'));
/* 台账不是影像备份覆盖的对象（`_影像备份.mjs` 只收影像与 `_原图\` 库对象，根台账 JSON 不在其中）。
   它的恢复点是 git / `_备份-真源\`——演练里直接取原件台账，并把这条边界**打印出来**而不是静默假设。 */
fs.copyFileSync(LEDGER, path.join(LIB2, '_原图台账.json'));
console.log('  [i] 恢复来源：字节 ← 备份 `' + path.relative(LIB, BAK) + '\\原件\\_原图\\`；' +
  '台账 ← 原件 `_原图台账.json`（根台账 JSON 不在影像备份的分母里，其恢复点是 git / `_备份-真源\\`）');

const restoreObjs = objectsOf(path.join(LIB2, '_原图'));
A('3.1 从库外副本恢复出 7 个对象文件', restoreObjs.length === 7 && restored === 7, restoreObjs.length + ' 个（复制 ' + restored + ' 个）');
const bySha = new Map();
for (const p of restoreObjs) bySha.set(/^([0-9a-f]{64})\./i.exec(path.basename(p))[1].toUpperCase(), p);
A('3.2 每个恢复件的内容 sha == 它的文件名（逐字节）',
  shas.every((s) => bySha.has(s) && shaOfFile(bySha.get(s)) === s),
  shas.length + ' 个逐个核对');
A('3.3 恢复后 EXIF 那份字节与源完全一致（EXIF 段在）',
  bySha.has(sha256(EXIF6)) && shaOfFile(bySha.get(sha256(EXIF6))) === sha256(EXIF6) &&
  fs.readFileSync(bySha.get(sha256(EXIF6))).includes(Buffer.from('Exif\0\0', 'latin1')));
A('3.4 恢复后同名异图仍是两份不同内容',
  bySha.has(sha256(CLASH_A)) && bySha.has(sha256(CLASH_B)) &&
  !fs.readFileSync(bySha.get(sha256(CLASH_A))).equals(fs.readFileSync(bySha.get(sha256(CLASH_B)))));
A('3.5 恢复后跨页题两页都在',
  bySha.has(sha256(PAGE8)) && bySha.has(sha256(PAGE9)));

/* ══════════ 四、核对：正跑（三方逐字节一致） ══════════ */
H('四、核对 --from：正跑 + 只读自证');
const fpLib2 = fingerprint(LIB2), fpBak = fingerprint(BAK);
const pos = run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2);
A('4.1 核对（恢复库 → 备份）exit 0', pos.code === 0, 'exit=' + pos.code + ' ｜ ' + pos.err.trim().split('\n').pop());
const jp = jsonOf(pos);
A('4.2 --json 可解析且 ok=true', !!jp && jp.ok === true, jp ? 'ok=' + jp.ok : '不是合法 JSON');
A('4.3 台账 7 个对象全部三方一致、差异 0',
  !!jp && jp.ledgerObjects === 7 && jp.verified === 7 && jp.diffs.length === 0 && jp.storeObjects === 7 && jp.backupObjects === 7,
  jp ? '台账=' + jp.ledgerObjects + ' 一致=' + jp.verified + ' 库内=' + jp.storeObjects + ' 备份=' + jp.backupObjects : '');
const posHuman = run('_原图.mjs', ['核对', '--from', BAK], LIB2);
A('4.4 人读输出 exit 0 且明说"三方逐字节一致"', posHuman.code === 0 && /三方逐字节一致/.test(posHuman.out));
A('4.5 只读：核对前后恢复库整树指纹不变（没写库）', fingerprint(LIB2) === fpLib2);
A('4.6 只读：核对前后备份根整树指纹不变（没写备份根）', fingerprint(BAK) === fpBak);

/* ══════════ 五、用法错必须 exit 2 ══════════ */
H('五、用法错：exit 2（不许猜一个分支继续跑）');
const u1 = run('_原图.mjs', ['核对'], LIB2);
A('5.1 缺 --from → exit 2', u1.code === 2, 'exit=' + u1.code);
const u2 = run('_原图.mjs', ['核对', '--from'], LIB2);
A('5.2 --from 没给值 → exit 2', u2.code === 2, 'exit=' + u2.code);
const u3 = run('_原图.mjs', ['核对', '--from', path.join(LIB2, '不存在的备份根')], LIB2);
A('5.3 --from 指向不存在的目录 → exit 2', u3.code === 2, 'exit=' + u3.code);
A('5.4 三次用法错都没写库（指纹不变）', fingerprint(LIB2) === fpLib2);

/* ══════════ 六、阴性对照：每条都必须真跑出红 ══════════ */
H('六、阴性对照（缺陷复现时它靠什么变红）');
const green = (why) => {
  const r = run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2);
  A('   ↳ 还原后回到 exit 0（' + why + '）', r.code === 0 && (jsonOf(r) || {}).ok === true, 'exit=' + r.code);
};
const red = (label, r, where, why, sha, human) => {
  const j = jsonOf(r);
  A(label + '：exit 1', r.code === 1, 'exit=' + r.code);
  A(label + '：--json 仍可解析且点名 ' + why + '[' + where + '] ' + sha.slice(0, 16) + '…',
    !!j && !!pick(j, where, why) && pick(j, where, why).sha === sha,
    j ? JSON.stringify(j.diffs.map((d) => d.why + '[' + d.where + ']')) : '不是合法 JSON');
  if (human) A(label + '：人读输出也指名到对象与原因', new RegExp(why + '\\[' + where + '\\]').test(human.out) && human.out.includes(sha.slice(0, 16)));
};

/* ① 恢复目标里改坏 1 个字节（长度不变） */
const t1 = bySha.get(sha256(EXIF6));
const len1 = flipOneByte(t1);
A('① 前提：改坏后长度没变（只比 size 的判据必然漏判）', fs.statSync(t1).size === len1 && shaOfFile(t1) !== sha256(EXIF6));
red('① 恢复目标坏了 1 字节', run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2), '库', '字节不符', sha256(EXIF6),
  run('_原图.mjs', ['核对', '--from', BAK], LIB2));
fs.copyFileSync(path.join(BAK, sha256(EXIF6).slice(0, 2).toLowerCase(), sha256(EXIF6) + '.jpg'), t1);
A('① 还原后内容 sha 复原', shaOfFile(t1) === sha256(EXIF6));
green('①');

/* ② 备份副本里改坏 1 个字节 */
const t2 = bakSha6;
flipOneByte(t2);
const r2 = run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2);
const j2 = jsonOf(r2);
A('② 备份副本坏了 1 字节：exit 1 且点名 字节不符[备份]',
  r2.code === 1 && !!pick(j2, '备份', '字节不符') && pick(j2, '备份', '字节不符').sha === sha256(EXIF6),
  'exit=' + r2.code + ' ｜ ' + (j2 ? JSON.stringify(j2.diffs.map((d) => d.why + '[' + d.where + ']')) : r2.out));
A('② 备份坏而库内好：差异只出现在 [备份] 一侧（不许连库内一起误报）',
  !!j2 && !pick(j2, '库', '字节不符'), j2 ? JSON.stringify(j2.counts) : '');
fs.copyFileSync(t1, t2);
A('② 还原后备份副本 sha 复原', shaOfFile(t2) === sha256(EXIF6));
green('②');

/* ③ 缺文件：库内 / 备份 各一条 */
const t3 = bySha.get(sha256(PAGE9));
fs.unlinkSync(t3);
red('③a 删掉恢复后的对象', run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2), '库', '缺文件', sha256(PAGE9));
fs.copyFileSync(path.join(BAK, sha256(PAGE9).slice(0, 2).toLowerCase(), sha256(PAGE9) + '.jpg'), t3);
green('③a');

const t3b = path.join(BAK, sha256(PAGE9).slice(0, 2).toLowerCase(), sha256(PAGE9) + '.jpg');
fs.unlinkSync(t3b);
red('③b 删掉备份里的对象', run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2), '备份', '缺文件', sha256(PAGE9));
fs.copyFileSync(t3, t3b);
green('③b');

/* ④ 只改台账 bytes（内容一个字节没动）⇒ 只许报"大小不符"，不许报"字节不符" */
const l2 = path.join(LIB2, '_原图台账.json');
const doc2 = JSON.parse(fs.readFileSync(l2, 'utf8'));
doc2.objects[sha256(CLASH_A)].bytes = doc2.objects[sha256(CLASH_A)].bytes + 1;
fs.writeFileSync(l2, JSON.stringify(doc2, null, 1) + '\n', 'utf8');
const r4 = run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2);
const j4 = jsonOf(r4);
A('④ 台账 bytes 被改：exit 1 且点名 大小不符',
  r4.code === 1 && !!pick(j4, '库', '大小不符') && !!pick(j4, '备份', '大小不符'),
  'exit=' + r4.code + ' ｜ ' + (j4 ? JSON.stringify(j4.counts) : r4.out));
A('④ 内容没坏 ⇒ 不许报"字节不符"（证明它真的在跟台账登记值对账，不是拿文件名自证）',
  !!j4 && j4.counts['字节不符'] === 0, j4 ? JSON.stringify(j4.counts) : '');
fs.copyFileSync(LEDGER, l2);
green('④');

/* ⑤ 多出：备份里塞一个台账不认的 64-hex 对象 */
const strayDir = path.join(BAK, 'ab');
fs.mkdirSync(strayDir, { recursive: true });
const straySha = sha256(Buffer.from('备份里多出来的、台账不认的东西', 'utf8'));
const stray = path.join(strayDir, straySha + '.jpg');
fs.writeFileSync(stray, Buffer.from('备份里多出来的、台账不认的东西', 'utf8'));
/* 对照（证明这条判据不是重复劳动）：`_原图.mjs 校验` 的分母是**库内** `_原图\` + 台账，
   库外副本里多出来的东西根本不在它的分母里 ⇒ 它必然报绿。这就是 `核对 --from` 新增的那一份覆盖。
   （★ 2026-11-06 P10：这里的对照组原先是 `_影像备份.mjs --verify`，该工具已退休，
     换成同样"分母不含备份根"的活跃判据 `校验`，对照的语义不变。） */
const blind = run('_原图.mjs', ['校验'], LIB2);
A('⑤ 对照：`_原图.mjs 校验` 看不见**库外副本**里多出的对象（exit 0）⇒ 这正是 `核对` 新增的覆盖',
  blind.code === 0, 'exit=' + blind.code + ' ｜ ' + (blind.out.match(/逐字节核对：[^\n]*/) || [''])[0]);
red('⑤ 备份里多出对象', run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2), '备份', '多出', straySha);
fs.unlinkSync(stray);
green('⑤');

/* ⑥ 结尾：必须回到全绿 —— 判据不是恒红 */
H('七、收尾');
const fin = run('_原图.mjs', ['核对', '--from', BAK, '--json'], LIB2);
const jf = jsonOf(fin);
A('7.1 全部还原后回到 exit 0 / ok=true / 差异 0',
  fin.code === 0 && !!jf && jf.ok === true && jf.diffs.length === 0,
  'exit=' + fin.code + ' ｜ ' + (jf ? '一致 ' + jf.verified + '/' + jf.ledgerObjects : fin.out));
A('7.2 库内与备份里各 7 个对象（没有多出、没有残留）',
  !!jf && jf.storeObjects === 7 && jf.backupObjects === 7, jf ? JSON.stringify({ 库: jf.storeObjects, 备份: jf.backupObjects }) : '');

/* ══════════ 八、台账自己的恢复点（`_备份-真源\`，keep=8） ══════════ */
/* 来源：task-13。`_原图台账.json` 是①真源（`sources`/`names` 扫 `_原图\` 复原不出来），
   但 `saveLedger` 原先写死 `{ backup: false }` ⇒ **零恢复点**（真库 `_备份-真源\` 下 0 份）。
   而且不能无脑改 `true`：一轮 `入库 --scan` 会写 20+ 次（每 50 个一次检查点 + 收尾），
   keep=8 会被**同一轮运行**灌满，把入库前那份恢复点挤掉 —— 所以"收尾留一份、检查点不留"。 */
H('八、台账自己的恢复点（_备份-真源\\，keep=8）');
const ledgerBackups = (lib) => {
  try { return fs.readdirSync(path.join(lib, '_备份-真源')).filter((n) => n.startsWith('_原图台账-') && n.endsWith('.json')).sort(); }
  catch { return []; }
};
const lb = ledgerBackups(LIB);
A('8.1 入库后台账副本出现在 `_备份-真源\\`（改前恒 0 份）', lb.length >= 1, lb.length + ' 份：' + (lb.join('、') || '无'));
let lbParsed = null;
try { lbParsed = JSON.parse(fs.readFileSync(path.join(LIB, '_备份-真源', lb[0]), 'utf8')); } catch { }
A('8.2 副本本身是可解析的台账（不是半截文件）',
  !!lbParsed && !!lbParsed.objects && Object.keys(lbParsed.objects).length === 7,
  lbParsed ? Object.keys(lbParsed.objects).length + ' 个对象' : '读不出/不合法');

/* 一轮入库里的中间检查点**不许**产生恢复点：否则 keep=8 被同一轮灌满。 */
const LIB3 = E.allocTempDir('gn-testlib-');
for (let i = 0; i < 60; i++) {
  const p = path.join(LIB3, '_收件箱', '原卷', 'p' + String(i).padStart(2, '0') + '.jpg');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(64, i & 0xff));
}
const big = run('_原图.mjs', ['入库', '--scan'], LIB3);
A('8.3 60 个文件的一轮入库 exit 0 且确实走到了中间检查点（输出含"已处理 50/60"）',
  big.code === 0 && /已处理 50\/60/.test(big.out), 'exit=' + big.code + ' ｜ ' + (big.out.match(/已处理 \d+\/\d+/) || ['（没有检查点）'])[0]);
const n3 = ledgerBackups(LIB3).length;
A('8.4 一轮入库最多只留 1 份恢复点（检查点不备份 ⇒ 不会自我灌爆 keep=8）',
  n3 === 1, n3 + ' 份' + (n3 > 1 ? '（>1 说明检查点也在留副本，keep=8 会被同一轮挤满）' : ''));

/* ── 阴性对照：源码级替身把 `backup` 掏回改前的 `false`，同一判据必须变红 ──
   两条链路必须**对称**：都先建台账（第一次入库时副本还不存在），再写第二次才该产生副本。 */
const subDir = E.allocTempDir('gn-testlib-');
for (const f of ['_原图.mjs', '_安全写.mjs', '_库根.mjs']) fs.copyFileSync(E.tool(f), path.join(subDir, f));
const subPath = path.join(subDir, '_原图.mjs');
const subSrc = fs.readFileSync(subPath, 'utf8');
const subPatched = subSrc.replace('writeJsonAtomic(LEDGER, doc, { backup, indent: 1 });',
  'writeJsonAtomic(LEDGER, doc, { backup: false, indent: 1 });');
A('8.5 替身补丁命中（确实把 backup 掏回了改前的 false）',
  subPatched !== subSrc && subPatched.includes('{ backup: false, indent: 1 }'));
fs.writeFileSync(subPath, subPatched, 'utf8');

const mkOne = (lib) => {
  const p = path.join(lib, '_收件箱', '原卷', 'one.jpg');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(128, 0x7e));
  return p;
};
const LIB4 = E.allocTempDir('gn-testlib-');   // 正跑（真工具）
mkOne(LIB4);
run('_原图.mjs', ['入库', '--scan'], LIB4);
A('8.6 正跑对称链路：第一次入库后尚无副本，第二次之后应当有', (() => {
  const first = ledgerBackups(LIB4).length;
  const second = (run('_原图.mjs', ['入库', '--scan'], LIB4), ledgerBackups(LIB4).length);
  return first === 0 && second >= 1;
})());
const LIB5 = E.allocTempDir('gn-testlib-');   // 阴性跑（替身）
mkOne(LIB5);
runAbs(subPath, ['入库', '--scan'], LIB5);
runAbs(subPath, ['入库', '--scan'], LIB5);
const n5 = ledgerBackups(LIB5).length;
A('8.7 阴性对照：替身（backup:false）同样两跑 ⇒ 副本必须 0 份（原判据在这里必然变红）',
  n5 === 0, n5 + ' 份');

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + (oks + fails) + ' 失败=' + fails);
process.exit(fails ? 1 : 0);
