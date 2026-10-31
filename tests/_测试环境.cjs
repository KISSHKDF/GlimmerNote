/* 拾光小册 · 测试环境（唯一入口）
 *
 * 为什么要有这个文件：
 *   程序与数据分家之后（AppRoot / DataRoot），测试里那个 `const ROOT = resolve(__dirname,'..')`
 *   只对一半用途还成立 —— 它既是"仓库根"（找 src\、tests\、VERSION.json），
 *   又曾被当成"库根"（找 九年级\_索引.json、_待确认.json）。
 *   现在拆开：
 *     REPO = 仓库根（程序侧，只读）
 *     TOOLS = REPO\src\tools（业务 .mjs 都在这儿）
 *     LIB  = 库根（用户数据，测试的**数据源**）
 *
 * LIB 优先级：
 *   ① 环境变量 CTB_TEST_LIB
 *   ② 仓库的同级目录 ..\错题本（本机的真库；只在开发机存在）
 *   ③ 仓库的同级目录 ..\GlimmerNote\数据（运行区的库）
 *   都没有就响亮失败——**绝不**静默指向一个空目录然后让测试"全绿"。
 *
 * ⚠ 铁律：真库只读。任何会写盘的测试必须先 assertWritableLib()，
 *   它会在 LIB 指向真库时**直接抛错**，逼你把测试跑在副本上（见 makeTempLib）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const TOOLS = path.join(REPO, 'src', 'tools');

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function resolveLib() {
  const env = process.env.CTB_TEST_LIB;
  if (env && String(env).trim()) {
    const p = path.resolve(String(env).trim());
    if (!isDir(p)) throw new Error('[测试环境] CTB_TEST_LIB 指向的目录不存在：' + p);
    /* ★ 2026-10-25：显式指向 fixtures 合成库时也要物化（与候选分支同一条规则）——
       否则"显式指定"反而绕开影像生成，门禁在合成库上永远缺图（实测踩过）。 */
    if (p.startsWith(path.join(REPO, 'fixtures'))) {
      const { materialize } = require('./_合成库.cjs');
      return materialize();
    }
    return p;
  }
  /* ★ 2026-10-24 审计修复（F-06 / DEFECT-REGISTRY D-051）：
   * 原先只有下面两个候选，都是**本机才有**的目录（..\错题本、..\GlimmerNote\数据）。
   * 于是新克隆（换机 / 换人 / CI）跑 `node tests\run.mjs quick` 必然
   * throw「找不到库」⇒ F-06「新克隆能跑测试」永久 FAIL。
   * 现在加第三个候选：**仓库自带的合成库 fixtures\库-最小**。
   * 优先级放在真库之后，所以开发机上行为不变（仍优先用真实数据做回归），
   * 而在没有真库的机器上自动落到合成库。
   * ★ 2026-10-24 迁移：真库已迁至运行区 GlimmerNote\数据（对账全绿），候选序对调；
   *   旧冻结区（已改名 错题本-冻结-20261024）保留为观察期兜底候选，目录不在则自然跳过。 */
  const cands = [
    path.resolve(REPO, '..', 'GlimmerNote', '数据'),        // 运行区库（真库所在）
    path.resolve(REPO, '..', '错题本'),                    // 旧冻结区（观察期兜底）
    path.join(REPO, 'fixtures', '库-形状'),                 // ★ 仓库自带合成形状库（新克隆默认；影像运行时物化）
    path.join(REPO, 'fixtures', '库-最小'),                 // 合成最小库（形状库缺失时的兜底）
  ];
  for (const c of cands) {
    if (!isDir(c)) continue;
    /* 像库的判据：有索引 / 有学生目录 / 有状态包，任一成立。
       ★ 2026-10-24 B-09：目录名判据不再写死某个真实学生目录名，
       改成「任意 <年级> 或 <年级>-<姓名> 目录」——合成库与新建学生目录都认。 */
    const gradeLike = fs.readdirSync(c).some(n => /^\d+年级(-.+)?$/.test(n));
    if (fs.existsSync(path.join(c, '_索引.json')) ||
      gradeLike ||
      fs.existsSync(path.join(c, '_状态.json'))) {
      /* ★ 2026-10-25：选中的是仓库 fixtures 合成库时，自动「物化」到临时目录——
       * 合成库的影像（原卷整页/题图/证据图）不进 git（.gitignore 挡全部 png，
       * 2026-10-25 刚删掉 fixtures png 反向口子），只存 _影像清单.json 契约；
       * 物化 = 复制文本 + 按清单现场生成 PNG。此后所有门禁（_原卷台账/_待确认 证据/
       * _配图门禁 的"图必须在盘上"判据）在合成库上也能真跑，而不是 SKIP。 */
      if (c.startsWith(path.join(REPO, 'fixtures'))) {
        const { materialize } = require('./_合成库.cjs');
        const m = materialize();
        if (process.env.CTB_TEST_LIB) process.env.CTB_TEST_LIB = m;
        return m;
      }
      return c;
    }
  }
  throw new Error('[测试环境] 找不到库。三种办法任选其一：' +
    '\n  ① 什么都不做 —— 仓库自带的 fixtures\\库-最小 应当被自动选中（若报这个错说明它缺文件）' +
    '\n  ② 设 CTB_TEST_LIB 指向一个库目录（含 _索引.json / 学生目录）' +
    '\n  ③ 在本仓同级放一个 错题本\\ 或 GlimmerNote\\数据\\ 目录' +
    '\n  试过：' + cands.join(' 、 '));
}

const LIB = resolveLib();

/* ★ 2026-10-24 审计修复（DEFECT-REGISTRY D-045 的根因，一次修一类）：
 * 程序与数据分家（2026-10-23）之后，所有工具都用 `_库根.mjs libraryRoot()` 定位库，
 * 而 `libraryRoot()` 认的是 **环境变量 CTB_DATA**；不传就退回"工具自己所在目录"
 * → 工具去 src\tools\ 下找 _状态.json → 恒 ENOENT。
 *
 * 症状：多个测试（neg-server-bom、neg-server-get-readonly 等）直接 execFileSync 起
 * 工具却**没传 CTB_DATA** ⇒ 断言永久 FAIL ⇒ `run.mjs quick` 永久红 ⇒ 发版检查单第 3 步
 * 永远过不去 ⇒ 没人真跑门禁。这一整类 bug 的共同根因就是这里没把 CTB_DATA 铺到子进程。
 *
 * 修法：这里统一把 CTB_DATA 写进 process.env。子进程默认继承 process.env，
 * 于是"忘记传 env"的调用也自动拿到正确库根。走临时库的测试仍可用
 * runToolSync(..., { data: tmp }) 显式覆盖。 */
if (!process.env.CTB_DATA) process.env.CTB_DATA = LIB;

/** 冻结区（真库）路径判定：任何写入都必须被挡住 */
/** 冻结区（真库）路径判定：任何写入都必须被挡住。
 *  ★ 2026-10-24 迁移：真库搬到 GlimmerNote\数据 后不再带「错题本」字样，
 *    守卫扩展为两条：旧冻结区路径（错题本*）+ 运行区数据根（GlimmerNote\数据）。 */
const FROZEN = /(^|[\\/])错题本([^\\/]*)([\\/]|$)|[\\/]GlimmerNote[\\/]数据([\\/]|$)/i;

function isFrozen(p) { return FROZEN.test(String(p || '')); }

/** ★ 2026-10-24 B-09：动态发现库里的索引文件（替代测试里写死的真实库路径）。
 *  口径与 _原卷台账.mjs loadCards 相同：库根下（跳过 _ / . 开头）一层与两层目录里的
 *  `_索引.json`（年级级 + 学科级索引都认）。返回相对 root 的 'dir/_索引.json' 列表（已排序）。
 *  不传 root 用 LIB；测试跑在 makeTempLib 副本上时传自己的临时库根。 */
function findIndexes(root) {
  const base = root || LIB;
  const out = [];
  (function walk(d, depth) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (fs.existsSync(path.join(full, '_索引.json')))
        out.push(path.relative(base, full).replace(/\\/g, '/') + '/_索引.json');
      if (depth > 0) walk(full, depth - 1);
    }
  })(base, 1);
  return out.sort();
}

/** 库内路径 */
function lib(...parts) { return path.join(LIB, ...parts); }
/** 工具绝对路径（兄弟工具一律走它，不要自己拼 ROOT） */
function tool(name) { return path.join(TOOLS, name); }

/* ══════════════════════════════════════════════════════════════════════
   写盘准入守卫（2026-10-31 E01 整改的唯一判据）
   为什么要有唯一判据：改前 `assertWritableLib` 全仓**真实调用点 = 0**（只有定义与注释），
   于是这道"真库拒写守卫"是死代码，写路径用例照样往用户真库写（实测吃掉 24 份已跟踪备份）。
   现在三种形态全部走 `writeGuard()` 同一个判据，任何一处放宽都会让另外两处失真：
     · writeGuard(target)      —— 纯查询，返回 {ok, target, reason}，不抛错（供需要"SKIP 而不是红"的用例）
     · assertWritableLib(what) —— 抛错形态（供"进去就等于事故"的写盘点，如组卷/批改）
     · guardWriteTest(name)    —— 用例级准入，返回 {skip, reason}（供 e2e 打印 RESULT=SKIP）
   ⚠ 判据看的是**写盘目标**：默认 LIB，但显式传 CTB_DATA 时以它为准 ——
     因为桌面壳的库根是 launch-dev 在 spawn 时用 CTB_DATA 定死的，测试改不了它；
     只看 LIB 会漏掉"测试用副本、壳仍指向真库"这种半改状态（那正是最危险的一种）。
   ══════════════════════════════════════════════════════════════════════ */
function writeGuard(target) {
  const t = target ? String(target) : String(process.env.CTB_DATA || LIB);
  if (isFrozen(t)) {
    return {
      ok: false, target: t,
      reason: '写盘目标是冻结区（用户真库）：' + t,
    };
  }
  return { ok: true, target: t, reason: '' };
}
/** 会写盘的测试必须先调它：目标指向真库就**抛错**（不给"静默通过"留口子） */
function assertWritableLib(what) {
  const g = writeGuard();
  if (!g.ok) {
    throw new Error('[测试环境] 拒绝执行：本次测试会写盘（' + (what || '未说明') + '），而 ' + g.reason + '\n' +
      '  请改用 makeTempLib() 副本，或把 CTB_TEST_LIB 指向一份副本。');
  }
}
/** 用例级写盘准入：不抛错，返回 {skip, reason}，让用例自己打印 `RESULT=SKIP(理由)` 后 exit 0。
 *  为什么不用抛错：门禁里"环境不具备"必须**可见地跳过**（打印理由 + exit 0），
 *  而"门禁该红"要 exit≠0 —— 两者不能混成同一个形态，否则真红会被当成 SKIP 吞掉。 */
function guardWriteTest(name) {
  const g = writeGuard();
  if (g.ok) return { skip: false, reason: '' };
  return {
    skip: true,
    reason: name + ' 会真写盘（组卷/批改/撤批），而 ' + g.reason +
      ' —— 明确 SKIP，绝不静默通过。真跑办法：把**整个库目录（含影像）**复制到副本，' +
      '再设 CTB_TEST_LIB=<副本> 跑 full（壳的 CTB_DATA 由 launch-dev 取 E.LIB，会一并对上）。' +
      '⚠ 只复制文本（makeTempLib 默认行为）不够：组卷要过盲解/答案来源/影像门禁，选不出卡会退化成 exit 2。',
  };
}

/* ══════════════════════════════════════════════════════════════════════
   `_备份-真源\` 轮转的放行判据（2026-10-31 E01-d）
   背景：`writeJsonAtomic(..., {backup:true})` 每写一次真源就在 `_备份-真源\` 留一份、
   只留最近 8 份 ⇒ 任何一次合法真源写入都会让它增减。
   但这**只在副本库上**是"派生"；跑在用户真库上时它意味着**恢复点被吃掉**（实测删掉 24 份
   已跟踪备份），必须判红。所以放行不是无条件的：判据抽在这里，供 run.mjs 调用，
   也让 tests/neg-e2e-frozen-lib.cjs 能直接对拍"冻结库上必须不放行"。
   ══════════════════════════════════════════════════════════════════════ */
function backupRotationAllowed(frozenLib) {
  return !frozenLib;
}

/* ══════════════════════════════════════════════════════════════════════
   「语义等价」判据（2026-10-31 E02 整改的唯一实现）
   为什么必须搬到测试环境里：原先它写在 tests\run.mjs 内部，run.mjs 是有副作用的 ESM
   入口（一 import 就跑门禁），**无法被测试直接调用** ⇒ 判据本身没有任何用例守，
   于是它宽到什么程度都没人发现（实测 22 项扰动里 11 项真损坏被判等价）。
   现在判据是纯函数、可被 neg-semantic-equivalence.cjs 逐项对拍。
   ──────────────────────────────────────────────────────────────────────
   口径（E02 整改核心）：**递归键规范化后全量比对** —— 对象键按字典序、数组保序、值逐字节。
   改前是"挑几个字段"定义整份文件的等价性（索引只取 7 个字段、台账只取 4 个），
   于是删 answerSlots、改 reviews[].result、改批次 student/subject/date、换题序全被放行。
   显式例外只有两处，都在下面 EXCEPTIONS 里写清"为什么"，且都是**单调**判据而非"忽略"：
     ① `_组卷台账.json` 的 `paperSeq`：水印设计上只增不复用（撤批也不回退）；
     ② `_索引.json` 的 `updatedAt`：派生时间戳，批改/撤批必刷成今天；只允许**变新**。
   两处都先"摘掉再全量比对"，摘掉的那些键单独做单调性检查 —— 所以"只改这些键"能被容忍，
   "顺手改了任何业务字段"必然判不等价。
   ══════════════════════════════════════════════════════════════════════ */
const SEM_EXCEPTIONS = {
  '_组卷台账.json': { dropTopKeys: ['paperSeq'], monotonic: 'paperSeq' },
  '_索引.json': { dropTopKeys: ['updatedAt'], monotonic: 'updatedAt' },
};
function readJsonLoose(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return undefined; }
}
/** 递归规范化：对象键排序、数组保序、其余按原值（JSON 可表达的类型） */
function canonValue(v) {
  if (Array.isArray(v)) return v.map(canonValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonValue(v[k]);
    return out;
  }
  return v;
}
function semExceptionOf(rel) {
  if (SEM_EXCEPTIONS[rel]) return SEM_EXCEPTIONS[rel];
  if (/_索引\.json$/.test(String(rel))) return SEM_EXCEPTIONS['_索引.json'];
  return null;
}
/** 摘掉例外键后的规范化文本（不含例外键 ⇒ 例外的变化不会混进"业务内容"比对里） */
function canonWithout(doc, dropTopKeys) {
  if (Array.isArray(doc)) return JSON.stringify(canonValue(doc));
  if (!doc || typeof doc !== 'object') return JSON.stringify(canonValue(doc));
  const copy = {};
  for (const k of Object.keys(doc)) if (!dropTopKeys.includes(k)) copy[k] = doc[k];
  return JSON.stringify(canonValue(copy));
}
/** 数值水印只增：旧有、新无（或变小）都算退化 */
function monoNumberOk(a, b) {
  const A = (a && typeof a === 'object') ? a : {};
  const B = (b && typeof b === 'object') ? b : {};
  for (const k of Object.keys(A)) {
    if (Number(B[k] || 0) < Number(A[k] || 0)) return false;
  }
  return true;
}
/** 时间戳只进不退（ISO 日期串可直接字典序比较；新值缺失 = 退步） */
function monoStampOk(a, b) {
  const A = String(a == null ? '' : a), B = String(b == null ? '' : b);
  if (A === B) return true;
  if (!B) return false;
  if (!A) return true;
  return B > A;
}
/** 两个文件是否"业务内容等价"（字节变了但业务内容没变）。
 *  beforeAbs = 跑前的副本；afterAbs = 跑后的当前文件。任何读不懂的情况一律判**不等价**（fail-closed）。 */
function semanticallyEqual(rel, beforeAbs, afterAbs) {
  const ex = semExceptionOf(rel);
  if (!ex) return false;                       // 没登记的扩展名：不参与语义放行
  const A = readJsonLoose(beforeAbs), B = readJsonLoose(afterAbs);
  if (A === undefined || B === undefined) return false;
  if (canonWithout(A, ex.dropTopKeys) !== canonWithout(B, ex.dropTopKeys)) return false;
  if (ex.monotonic === 'paperSeq') return monoNumberOk(A.paperSeq, B.paperSeq);
  if (ex.monotonic === 'updatedAt') return monoStampOk(A.updatedAt, B.updatedAt);
  return true;
}

/* ══════════════════════════════════════════════════════════════════════
   verify-deploy 退出码的唯一消费判据（2026-10-31 E03 整改）
   改前缺陷：verify-deploy 用同一个 exit 2 表示"本机没有运行区"与"清单解析失败/形状不对"，
   两个调用方（run.mjs / .githooks/pre-commit）又把**所有** exit 2 一律当"没有运行区"放行
   ⇒ 清单损坏 = fail-open（实测：损坏清单 → rc=2 → pre-commit 返回 0 允许提交）。
   现在退出码拆开、判据收在一处，两个调用方都调本函数，不再各自抄一份 if/else
   （两份实现必然漂移，本仓 L-286）。
     ESC 语义：只有 `skip` 是"无法评估"；`block` 一律按失败处理（fail-closed）。
   ══════════════════════════════════════════════════════════════════════ */
const VERIFY_DEPLOY_CODES = {
  OK: 0,            // 一致
  DRIFT: 1,         // 有文件被改/增/删，或版本与清单不符
  USAGE: 2,         // 用法错误（参数不认识）
  NO_RUNTIME: 3,    // 本机没有运行区（没有 <仓库上一级>\GlimmerNote 或其中没有 app\）—— **唯一可豁免**
  BAD_MANIFEST: 4,  // 清单损坏 / 形状不对 —— **必须阻断**（不许当成"没有运行区"）
  NO_MANIFEST: 5,   // 运行区在、但尚无清单（机制建立前的历史状态）—— 阻断，但不与"没有运行区"混为一谈
};
const VERIFY_DEPLOY_MEANING = {
  0: '运行区与部署清单一致',
  1: '运行区被绕过 deploy.ps1 改动过（或版本与清单不符）',
  2: '用法错误',
  3: '本机没有运行区（干净克隆 / 换机 / CI 的预期状态）',
  4: '清单损坏或形状不对（读不懂的运行区基线 = 无法证明，必须阻断）',
  5: '运行区尚无部署清单（机制建立之前的历史状态）',
};
/** 把退出码翻译成 {action:'pass'|'skip'|'block', label}。
 *  ⚠ 只有 NO_RUNTIME(3) 是 skip —— "无法评估"；其它非 0 一律 block。 */
function classifyVerifyDeploy(code) {
  const n = Number(code);
  if (n === VERIFY_DEPLOY_CODES.OK) return { action: 'pass', code: n, label: VERIFY_DEPLOY_MEANING[0] };
  if (n === VERIFY_DEPLOY_CODES.NO_RUNTIME) return { action: 'skip', code: n, label: VERIFY_DEPLOY_MEANING[3] };
  return { action: 'block', code: n, label: VERIFY_DEPLOY_MEANING[n] || ('未知退出码 ' + code) };
}

/* 复制库到临时目录（只复制数据文件，不复制 1.4GB 影像；需要图的任务另行指定） */
const COPY_FILES = [
  '_索引.json', '_状态.json', '_待确认.json', '_组卷台账.json', '_配图台账.json',
  '_原卷台账.json', '_盲解双路.json', '_笔形台账.json', '_页码映射.json',
  '_词表.md', '_复习队列.md', '_待确认清单.md',
];

function makeTempLib(extraDirs, opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-testlib-'));
  for (const f of COPY_FILES) {
    const s = path.join(LIB, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, f));
  }
  /* 复制时**保留 mtime**：盲解指纹门禁除了比指纹，还比「题干.html 的 mtime 日期是否晚于盲解日」
     （_盲解复核.mjs 的 stemEditedAfterBlind）。copyFileSync 会把 mtime 刷成现在，
     于是整库卡都会被判「盲解后改过题干」⇒ 组卷被门禁拦下。这不是真缺陷，是复制方式丢了证据。 */
  const copyKeepTime = (src, dst) => {
    fs.copyFileSync(src, dst);
    try { const st = fs.statSync(src); fs.utimesSync(dst, st.atime, st.mtime); } catch { }
  };
  /* 卡片级文件：指纹/渲染要用，但影像（1.4GB+）不复制。
     opts.copyCardFiles=true 时才复制 —— 组卷/批改类测试需要它（否则指纹判失效、题干渲染为空）。 */
  const CARD_FILES = ['题干.html', '错题记录.md', '配图.svg'];
  const copySidecars = (idxAbs, relDir) => {
    if (!o.copyCardFiles) return;
    let j;
    try { j = JSON.parse(fs.readFileSync(idxAbs, 'utf8').replace(/^\uFEFF/, '')); } catch { return; }
    const multi = j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects);
    const rows = [];
    if (multi) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) rows.push([it, path.join(relDir, sn)]);
    else for (const it of (j.items || [])) rows.push([it, relDir]);
    for (const [it, rel] of rows) {
      const sub = it.dir || it.id || '';
      if (!sub) continue;
      const srcDir = path.join(LIB, rel, sub);
      const dstDir = path.join(dir, rel, sub);
      for (const f of CARD_FILES) {
        const s = path.join(srcDir, f);
        if (!fs.existsSync(s)) continue;
        try { fs.mkdirSync(dstDir, { recursive: true }); copyKeepTime(s, path.join(dstDir, f)); } catch { }
      }
    }
  };
  /* 学生目录：只复制结构（含 _索引.json 的层级），不复制图片，除非调用方点名要 */
  const walk = (base, rel, depth) => {
    let ents; try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const abs = path.join(base, e.name), r = path.join(rel, e.name);
      const idx = path.join(abs, '_索引.json');
      if (fs.existsSync(idx)) {
        fs.mkdirSync(path.join(dir, r), { recursive: true });
        copyKeepTime(idx, path.join(dir, r, '_索引.json'));
        copySidecars(idx, r);
      }
      if (depth > 1) walk(abs, r, depth - 1);
    }
  };
  walk(LIB, '', 2);
  /* extraDirs：额外整目录复制的相对路径（如 '九年级' 需要图片时） */
  for (const d of (extraDirs || [])) {
    const s = path.join(LIB, d);
    if (isDir(s)) fs.cpSync(s, path.join(dir, d), { recursive: true });
  }
  return dir;
}

/* ══════════════════════════════════════════════════════════════════════
   前端页面 URL 判据（唯一实现）
   为什么要有：前端从「<库根>\v2\index.html」搬到「<程序目录>\index.html」之后，
   四个界面测试各自写着 `/v2\/index/` 去认页面 —— 搬到 src\app 后这条正则永远不匹配：
     · e2e-writepath   → NO TARGET（整条写路径闭环根本没跑，却只报一行 NO TARGET）
     · interactive-sweep / shell-visual → 报 SKIP 或 FAIL
   ⚠ 匹配前必须**先剥查询串和路由哈希**：前端用 hash 记路由，实测 URL 是 index.html#dash，
     只剥 '?' 会让 /index\.html$/ 判假（2026-10-23 实测踩到）。
   三种布局都认：发布包 <AppRoot>\index.html、开发区 <仓库>\src\app\index.html、老布局 <库根>\v2\index.html
   ══════════════════════════════════════════════════════════════════════ */
function isAppUrl(u) {
  const s = String(u || '').split(/[?#]/)[0];
  return /\/index\.html$/i.test(s);
}
/** 同上，且必须是 file:// 通道（= 真桌面壳，而不是本机服务端） */
function isFileAppUrl(u) {
  return /^file:/i.test(String(u || '')) && isAppUrl(u);
}

/** 统一的"跑工具"入口：永远带 CTB_DATA=LIB，永远用 TOOLS 里的路径 */function runToolSync(name, args, opts) {
  const { execFileSync } = require('child_process');
  const o = opts || {};
  const env = Object.assign({}, process.env, { CTB_DATA: o.data || LIB });
  try {
    const out = execFileSync(process.execPath, [tool(name), ...(args || [])], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env, cwd: REPO,
    });
    return { code: 0, out: String(out || ''), err: '' };
  } catch (e) {
    /* 门禁语义：退出码 1 = 有未通过项，stdout 仍是完好 JSON，必须当成功返回 */
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   测试自带服务端（2026-10-23）
   为什么：界面类测试原先要求"本机 7187 有个服务端在跑"。但那台服务端
   可能是**用户正在用的冻结区老程序**（实测 7187 上就是冻结区旧库自己的 _服务端.mjs，
   提供的是老前端）——测试连上去必然对不上，还会把"用户的服务在不在"变成测试前提。
   现在：测试自己起一个实例、自己挑空闲端口、跑完自己关掉。
   若显式给了 CTB_SRV，就尊重它（CI / 手工指定场景）。
   ══════════════════════════════════════════════════════════════════════ */
let _srv = null;

function freePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 起一个测试专用服务端；返回 { base, port, stop() } */
async function startServer(opts) {
  if (_srv) return _srv;
  const { spawn } = require('child_process');
  const o = opts || {};
  const port = o.port || await freePort();
  const proc = spawn(process.execPath, [tool('_服务端.mjs')], {
    cwd: REPO,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: o.data || LIB }),
  });
  let out = '', err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });

  const base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 30000) {
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) { up = true; break; }
    } catch { }
    await new Promise((r) => setTimeout(r, 300));
  }
  const stop = () => new Promise((resolve) => {
    try { proc.kill(); } catch { }
    setTimeout(resolve, 200);
  });
  if (!up) {
    await stop();
    throw new Error('[测试环境] 测试服务端 30s 内没起来（port=' + port + '）\n' + out.slice(-400) + err.slice(-400));
  }
  _srv = { base, port, stop, proc, getOut: () => out, getErr: () => err };
  return _srv;
}

/** 有 CTB_SRV 就返回它，否则起一个（惰性） */
async function serverBase() {
  if (process.env.CTB_SRV) return process.env.CTB_SRV;
  const s = await startServer();
  return s.base;
}

module.exports = {
  REPO, TOOLS, LIB, isFrozen, findIndexes,
  lib, tool, makeTempLib, runToolSync,
  /* 写盘准入（E01）：三种形态共用 writeGuard 一个判据 */
  writeGuard, assertWritableLib, guardWriteTest, backupRotationAllowed,
  /* 语义等价（E02）：纯函数，可被 neg-semantic-equivalence.cjs 直接对拍 */
  semanticallyEqual, canonValue, SEM_EXCEPTIONS,
  /* verify-deploy 退出码（E03）：两个调用方的唯一判据 */
  VERIFY_DEPLOY_CODES, VERIFY_DEPLOY_MEANING, classifyVerifyDeploy,
  startServer, serverBase, freePort,
  isAppUrl, isFileAppUrl,
  describe: () => '仓库=' + REPO + '　库=' + LIB,
};
