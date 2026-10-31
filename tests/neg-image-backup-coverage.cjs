#!/usr/bin/env node
/**
 * 拾光小册 · 影像备份的分母口径与镜像判据（2026-10-31 建）
 *
 * 事故背景（本轮实测，2026-10-31 全库扫描）：库内影像 1298 个，旧的收集口径
 *   「文件名切片正则 ∪ 台账 page 反查 ∪ 原件目录正则」漏掉 271 个 —— 它们**静默不备份**。
 *   其中 93 个不在任何可重建集合里（`待办证据\`、`_笔形\`、`_撤卡留档\`、卡片 `题干.jpg`），
 *   按 sha256 逐字节比对，80 个 / 19.4 MB 在本机备份与离机镜像里**都没有同内容副本**。
 *   而工具的覆盖率一直是 100.0% —— 因为**分母是它自己挑的**。这就是"分母不能由工具自己挑"。
 *
 * 本用例守五条（每条都对应一处真缺陷，缺一条都不算修好）：
 *   ① **分母 = 全库扫描 − 显式声明的可重建集合**：不在任何"文件名字典"里的影像
 *      （`待办证据\`、`_笔形\`）必须进分母；显式可重建的（`_crops\`/`tiles\`/`组卷\`）不进；
 *      新目录 `_原图\` **默认进分母**，而且**按内容全收、不看扩展名** ——
 *      库里的 `_来源映射.csv` / `_答案页映射.csv` / 某题 `.md` 是**人工判读产物**
 *      （页码偏移规则、原文件名↔归档名↔sha 对应、遮挡复原依据），不能从任何原图推出；
 *      唯一不进分母的是 `*.tmp`（写一半的半成品）与 `_快照\`（库自身可再生的内部快照）。
 *   ② **阴性对照：覆盖率会掉**。把分母里任意一份的备份删掉，覆盖率必须严格 <100%
 *      且等于 (N-1)/N、缺失清单能点出是哪一份、退出码非 0 —— 防"恒 100%"。
 *   ③ `--status` 与 `--verify` **同口径判红**（改前 `--status` 永远 exit 0，
 *      按退出码判断的计划任务把"没备份好"记成成功）。
 *   ④ 离机镜像的跳过判据是**内容（sha1）**不是大小：同大小不同内容的镜像副本必须被修正。
 *      用例里同时把旧判据（只比 size）原样搬进来做对照 —— 它对同一份必然判"跳过"。
 *   ⑤ 镜像陈旧件（镜像有、本机备份已无）**只报告不删除**。
 *
 * 夹具全部自建在 %TEMP%（不依赖真实用户数据、不碰真库）。
 * ⚠ 镜像用例的前提是"镜像盘 ≠ 题库盘"（同卷复制不是备份，这是被测代码的正确行为），
 *   所以运行时**枚举**可用卷找一块与临时库不同卷的；单卷机器上那几条**可见 SKIP**，其余照跑。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

let worst = 0, passed = 0, skipped = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}
function SKIP(name, why) { skipped++; console.log('[SKIP] ' + name + '  ← ' + why); }

console.log('测试环境：' + E.describe());
const TOOL = E.tool('_影像备份.mjs');

/* ── 夹具：自己造库，绝不碰真库 ─────────────────────────────────────────── */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-imgbak-'));
function put(dirAbs, rel, content) {
  const abs = path.join(dirAbs, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content === undefined ? 'IMG:' + rel : content);
  return abs;
}
function mkLib(name) {
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ★ 2026-10-31 补：`_原图\` 库里的**非影像对象**（人工判读产物）也必须进分母。
   真库里是 3 个 `_来源映射.csv` + 1 个 `_答案页映射.csv` + 1 个 `…独立重做用.md`，
   旧口径只看影像扩展名 ⇒ 这 5 个既不在分母也从未备份，只在 D 盘机械盘上（外部评审点名的口子）。 */
const STORE_NONIMG = ['_原图/cd/00112233aabbccdd.csv', '_原图/ef/ffeeddccbbaa9988.md'];

/* 必须在分母里的（"不可证明可重建" —— 前两条是旧口径完全碰不到的那一类） */
const MUST = [
  '待办证据/T186.jpg',                                // 旧口径：不在任何规则内
  '_笔形/学生甲/D/2026-10-01-0003.jpg',                // 旧口径：同上（文件名字典也碰不到）
  '九年级/学生甲/数学/C0001-选择题/题干.jpg',
  '九年级/学生甲/数学/C0001-选择题/题图.jpg',           // 落「切片」桶
  '九年级/原卷/学生甲-20261001-p01.jpg',               // 旧口径能命中（原件目录规则）
  '_撤卡留档/20261008/P0001-旧卡/原卷截图.jpg',
  '_原图/ab/ab12cd34ef56.jpg',                        // 新目录：内容寻址库，必须跟着备份
  ...STORE_NONIMG,                                    // 原图库里的非影像对象（.csv / .md）
];
/* 原图库里**不算对象**的两类（唯一排除项）：写一半的半成品 + 库自身可再生的内部快照 */
const STORE_EXCLUDED = [
  '_原图/aa/半截写入.tmp',
  '_原图/bb/_快照/20261031-213815.list',
];
/* 显式声明的可重建集合（有原件就能重做）—— 不进分母 */
const REBUILD = [
  '九年级/原卷/_crops/a1.png',                        // 路径中段，只判首段会漏（2026-10-12 的坑）
  '九年级/原卷/tiles/p1-L.jpg',
  '组卷/2026-10-01-学生甲-重做卷.pdf',
];

const lib = mkLib('库-主');
put(lib, '_原卷台账.json', '{"cards":{}}');
for (const r of MUST) put(lib, r);
for (const r of REBUILD) put(lib, r);
for (const r of STORE_EXCLUDED) put(lib, r);                  // 只用来证明"不进分母"
put(lib, '待办证据/T186.md', '# 非影像，不进分母');          // 非影像扩展名（原图库**之外**）

/* ── 跑工具的唯一入口（永远显式 CTB_DATA + 显式镜像落点）──────────────── */
function run(mode, libDir, mirror) {
  const env = Object.assign({}, process.env, { CTB_DATA: libDir });
  if (mirror) env.CTB_IMG_MIRROR = mirror; else delete env.CTB_IMG_MIRROR;
  const r = spawnSync(process.execPath, [TOOL].concat(mode ? [mode] : []), {
    encoding: 'utf8', env, cwd: E.REPO, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
/** 从输出里取「应备份 / 已备份 / 缺失（pct）」四个数（这三个数必须齐，缺一个就解析失败） */
function covOf(out) {
  const m = /应备份 (\d+) \/ 已备份 (\d+) \/ 缺失 (\d+)（([\d.]+)%）/.exec(out);
  return m ? { need: +m[1], have: +m[2], miss: +m[3], pct: m[4] } : null;
}
const isSlice = rel => /^(题图|裁图|crop)/i.test(path.basename(rel));
const backupPath = (libDir, rel) => path.join(libDir, '_影像备份', isSlice(rel) ? '切片' : '原件', ...rel.split('/'));
/** 内容哈希（按**内容**证明镜像里有这一份，而不是按路径"看起来在"） */
function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let n;
  try { while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); }
  finally { try { fs.closeSync(fd); } catch { } }
  return h.digest('hex');
}

/* ════════ ① 分母 = 全库扫描 − 显式可重建 ════════ */
console.log('\n══ ① 分母不能由工具自己挑：全库扫描 − 显式可重建 ══');
const st0 = run('--status', lib, '');
const cov0 = covOf(st0.out);
A('--status 能跑通并给出「应备份/已备份/缺失/百分比」四个数', cov0 !== null, JSON.stringify(cov0));
A('分母 = 全库扫描对象 − 显式可重建（' + MUST.length + ' 个）', cov0 && cov0.need === MUST.length,
  '应备份 ' + (cov0 && cov0.need) + '，期望 ' + MUST.length);
A('全库扫描个数 = 分母 + 可重建（' + (MUST.length + REBUILD.length) + '）',
  st0.out.indexOf('全库扫描 ' + (MUST.length + REBUILD.length) + ' 个') >= 0);
A('可重建集合被排除，且**在输出里可见**（能被审计"工具瞒着排掉了多少"）',
  st0.out.indexOf('显式声明可重建 ' + REBUILD.length + ' 个') >= 0 &&
  st0.out.indexOf('_crops 1') >= 0 && st0.out.indexOf('tiles 1') >= 0 && st0.out.indexOf('组卷 1') >= 0);
A('★ 旧口径完全碰不到的影像照样进分母：待办证据/T186.jpg 出现在缺失清单',
  st0.out.indexOf('待办证据/T186.jpg') >= 0);
A('★ 旧口径碰不到的第二类：_笔形/学生甲/D/2026-10-01-0003.jpg 出现在缺失清单',
  st0.out.indexOf('_笔形/学生甲/D/2026-10-01-0003.jpg') >= 0);
A('★ 新目录 _原图/ 默认进分母（内容寻址库不会漏备份）',
  st0.out.indexOf('_原图/ab/ab12cd34ef56.jpg') >= 0);
A('★★ 原图库里的**非影像对象**（.csv/.md）也进分母 —— 人工判读产物不能从任何原图推出',
  STORE_NONIMG.every(r => st0.out.indexOf(r) >= 0), STORE_NONIMG.join(' | '));
A('原图库的两类排除项不进分母：*.tmp 半成品 与 _快照/ 内部快照（清单里都不许出现）',
  STORE_EXCLUDED.every(r => st0.out.indexOf(r) < 0) &&
  st0.out.indexOf('半截写入.tmp') < 0 && st0.out.indexOf('_快照') < 0,
  STORE_EXCLUDED.join(' | '));
A('可重建件一个都没进清单（_crops / tiles / 组卷）',
  st0.out.indexOf('_crops/a1.png') < 0 && st0.out.indexOf('tiles/p1-L.jpg') < 0 &&
  st0.out.indexOf('重做卷.pdf') < 0);
A('非影像扩展名（.md）不进分母', st0.out.indexOf('T186.md') < 0);
A('分母数与「原件 + 切片」两个桶之和自洽',
  st0.out.indexOf('应备份 原件 ' + (MUST.length - MUST.filter(isSlice).length) + ' 个 / 切片 ' + MUST.filter(isSlice).length + ' 个') >= 0);
A('全未备份 ⇒ exit 2（覆盖率 <50% = 判定口径退化，必须能自动红）', st0.code === 2, 'exit=' + st0.code);
A('缺失数 = 分母（一份都不能少报）', cov0 && cov0.miss === cov0.need);

/* ════════ ② 备份齐全 ⇒ 100% + exit 0 ════════ */
console.log('\n══ ② 备份齐全时覆盖率 100%、--status exit 0 ══');
const d1 = run('', lib, '');                 // 默认模式（不配镜像）：只写本机副本
A('默认模式把分母内每一份都写进 _影像备份（逐份核对，不数总数）',
  MUST.every(r => fs.existsSync(backupPath(lib, r))), MUST.length + ' 份');
const st1 = run('--status', lib, '');
const cov1 = covOf(st1.out);
A('全覆盖：已备份 = 应备份', cov1 && cov1.have === cov1.need && cov1.miss === 0, JSON.stringify(cov1));
A('全覆盖时 --status exit 0（修好"永远红"的另一面：不乱红）', st1.code === 0, 'exit=' + st1.code);
A('全覆盖时 --verify exit 0 且逐字节一致', run('--verify', lib, '').code === 0);
A('未配离机镜像时默认模式如实判红（exit 1：同盘副本不是备份）', d1.code === 1, 'exit=' + d1.code);

/* ════════ ③ 阴性对照：漏掉一份 ⇒ 覆盖率必须掉 ════════ */
console.log('\n══ ③ 阴性对照：漏掉一个应备份文件，覆盖率必须严格掉下去 ══');
const victim = '待办证据/T186.jpg';
fs.rmSync(backupPath(lib, victim));
const st2 = run('--status', lib, '');
const cov2 = covOf(st2.out);
const want = (MUST.length - 1) / MUST.length * 100;
A('★ 覆盖率严格 <100%（不是恒 100%）', cov2 && Number(cov2.pct) < 100, cov2 && cov2.pct + '%');
A('★ 掉到 (N-1)/N 的具体值（' + want.toFixed(1) + '%）', cov2 && Math.abs(Number(cov2.pct) - want) < 0.06,
  cov2 && cov2.pct + '%');
A('★ 缺失清单能点出是哪一份', st2.out.indexOf('缺失 1') >= 0 && st2.out.indexOf('待办证据/T186.jpg') >= 0);
A('★ --status 此时 exit 1（改前恒 0：自动化会把"没备份好"当成功）', st2.code === 1, 'exit=' + st2.code);
A('★ --verify 同口径也判红（两套口径已合并成一个判据）', run('--verify', lib, '').code === 1);
run('', lib, '');                            // 复原（供后面镜像用例用）

/* ════════ ④ 离机镜像：判据是内容不是大小 ════════ */
console.log('\n══ ④ 离机镜像：跳过判据从 size 改成 sha1 ══');
/** 找一块与题库**不同卷**的可写盘：镜像判据要求镜像盘≠题库盘（不写死盘符，运行时枚举） */
function pickOtherVolume(sameRoot) {
  for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
    const root = ch + ':' + path.sep;
    if (path.parse(root).root.toLowerCase() === String(sameRoot).toLowerCase()) continue;
    try { fs.accessSync(root, fs.constants.W_OK); if (fs.statSync(root).isDirectory()) return root; } catch { }
  }
  return '';
}
const vol = pickOtherVolume(path.parse(base).root);
let mirror = '';
if (vol) { try { mirror = fs.mkdtempSync(path.join(vol, 'gn-imgmir-')); } catch { mirror = ''; } }

if (!mirror) {
  SKIP('镜像四条（推送 / 同大小不同内容必须修正 / 陈旧件只报告 / 同卷拒绝）',
    '本机只有一块可写卷，而"镜像盘 ≠ 题库盘"是被测代码的正确前提（单卷机器上这些判据无从验证）');
} else {
  const dm = run('', lib, mirror);           // 默认模式 + 镜像
  A('默认模式：本机副本齐全 + 镜像成功 ⇒ exit 0', dm.code === 0, 'exit=' + dm.code);
  A('镜像里逐份都在（原件/切片两个桶）',
    MUST.every(r => fs.existsSync(path.join(mirror, isSlice(r) ? '切片' : '原件', ...r.split('/')))));

  /* ★★ 非影像对象也必须按**内容**到离机镜像（判据是"原图库里有什么就备什么"，
     不是"扩展名像不像影像"）。这里按 sha256 比对，而不是"路径存在" —— 路径存在可能是旧尸体。 */
  const NONIMG = STORE_NONIMG[0];                       // .csv
  const nonimgLib = backupPath(lib, NONIMG);
  const nonimgMir = path.join(mirror, '原件', ...NONIMG.split('/'));
  A('★★ 非影像对象（.csv）已到离机镜像，且按内容 sha256 一致（不按路径判断）',
    fs.existsSync(nonimgMir) && sha256(nonimgMir) === sha256(nonimgLib),
    NONIMG + '  sha256=' + sha256(nonimgLib).slice(0, 16) + '…');

  /* 造"同大小不同内容"：这正是旧判据（只比 size）盲掉的那一类 */
  const target = '_原图/ab/ab12cd34ef56.jpg';
  const srcAbs = backupPath(lib, target);
  const dstAbs = path.join(mirror, '原件', ...target.split('/'));
  const good = fs.readFileSync(srcAbs);
  const bad = Buffer.from(good); bad[0] = bad[0] ^ 0xFF;      // 字节数完全不变，内容变了
  fs.writeFileSync(dstAbs, bad);
  A('前提：造出的坏副本与源**大小完全相同**、内容不同',
    fs.statSync(dstAbs).size === fs.statSync(srcAbs).size && !fs.readFileSync(dstAbs).equals(good));
  /* 旧判据原样搬进来做对照：只比 size ⇒ 必然判"跳过"（这就是被修掉的那个缺陷） */
  const oldWouldSkip = (s, d) => fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size;
  A('阴性自证：旧判据（只比 size）对这一份判"跳过" ⇒ 坏副本永远修不好', oldWouldSkip(srcAbs, dstAbs) === true);

  run('--mirror', lib, mirror);
  A('★ 新判据（sha1）把它修正了：镜像这份与源内容一致',
    fs.readFileSync(dstAbs).equals(good));
  A('正常份没有被无谓重推（内容一致的仍然跳过，增量语义保住）',
    run('--mirror', lib, mirror).out.indexOf('新增 0 个') >= 0);

  /* ── 陈旧件：镜像有、本机备份已无（源被删后遗留在镜像里）── */
  const staleRel = '原件/_已删除目录/源已删除.jpg';
  const staleAbs = path.join(mirror, ...staleRel.split('/'));
  fs.mkdirSync(path.dirname(staleAbs), { recursive: true });
  fs.writeFileSync(staleAbs, 'STALE-CONTENT');
  const sts = run('--status', lib, mirror);
  A('★ --status 报出陈旧件数量与字节（改前一个都不报）',
    /镜像陈旧件：1 个 [\d.]+ MB/.test(sts.out), (sts.out.match(/镜像陈旧件：[^\n]*/) || [''])[0]);
  A('★ 陈旧件只报告**不删除**（文件仍在盘上）', fs.existsSync(staleAbs));
  A('陈旧件不影响覆盖率判定（它不是"该备没备"，不该把 --status 判红）', sts.code === 0, 'exit=' + sts.code);
  run('', lib, mirror);                      // 再跑一轮默认模式（含镜像推送）
  A('★ 再跑一轮默认模式后陈旧件仍然在（没有任何代码路径会删它）', fs.existsSync(staleAbs));

  const same = run('--mirror', lib, path.join(lib, '_同卷镜像'));
  A('同卷镜像落点仍被拒绝（exit 1：同盘复制不是备份）', same.code === 1 && same.out.indexOf('同卷') >= 0, 'exit=' + same.code);
  fs.rmSync(path.join(lib, '_同卷镜像'), { recursive: true, force: true });
}

/* ════════ ⑤ 分母为 0 / 空库：两种极端都必须有确定结论 ════════ */
console.log('\n══ ⑤ 分母为 0 与空库（"分母被改回去"必须红）══');
const libAll = mkLib('库-全可重建');
put(libAll, '九年级/原卷/_crops/a1.png');
put(libAll, '九年级/原卷/tiles/p1-L.jpg');
put(libAll, '组卷/x.pdf');
const stA = run('--status', libAll, '');
A('分母为 0 但库里有影像 ⇒ exit 2（可重建集合声明过宽 = 会把该保的全排除）', stA.code === 2, 'exit=' + stA.code);
A('输出能自查：全库扫描 3 个 / 应备份 0 个', stA.out.indexOf('全库扫描 3 个') >= 0 &&
  stA.out.indexOf('应备份 原件 0 个 / 切片 0 个') >= 0);

const libEmpty = mkLib('库-空');
const stE = run('--status', libEmpty, '');
A('空库（库里一个影像都没有）不判红：exit 0（别把"没东西可备"当口径退化）', stE.code === 0, 'exit=' + stE.code);
A('空库覆盖率按 0/0 报，不谎报"已备份 0/0 有百分比问题"', /应备份 0 \/ 已备份 0 \/ 缺失 0（100\.0%）/.test(stE.out));

/* ── 收尾 ─────────────────────────────────────────────────────────────── */
console.log('\n──────────────────────────────');
console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed + ' SKIP=' + skipped
  : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst + ' SKIP=' + skipped);
for (const d of [base, mirror]) { if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } } }
process.exit(worst === 0 ? 0 : 1);