#!/usr/bin/env node
/**
 * 选卡门禁（2026-11-03 建 · 批次 2「经验包试点」）
 *
 * 守什么：`组装 --card` 这条路把**用户装的经验包正文**接进任务单与任务记录。
 *   它有两个方向都能坏，而且都不响：
 *     ① **兼容红线**：无 `--card` 时任务单/指纹/契约摘要必须与改造前**逐字节相同**
 *        —— 一旦多加一个字节（哪怕多一个空行），所有存量任务单的可复现性就没了；
 *     ② **选卡纪律**：正文必须真进「二、任务指令」段、摘要必须随卡变、选卡顺序必须影响摘要、
 *        冲突必须按策略处置（deny 必须拒、first 必须**打印**让位、all 才全拼），
 *        失败必须**可归因**（未知包/未知版本/未知卡/停用/坏包/形状错各自说清是哪一种）。
 *
 * 判据手法（本仓纪律：能绿却没人跑的断言 = 没门禁；没有阴性对照的判据 = 假门禁）：
 *   · 兼容红线用**改造前的真引擎对拍**：把 `83dbe5c`（批次 2 开工基线，契约 §0）的
 *     `src\tools\_配方.mjs` 用 `git show` 取出来，放进只替换引擎那一份的临时树里，
 *     两个引擎对同一份 `src\recipes`、同一个临时库跑同一条命令，比**字节**。
 *     为什么必须拿真引擎对拍而不是"再手写一份期望值"：手写期望值本身就是第二份实现，
 *     它漂了测试照样绿（本仓 L-286）；而且期望值会随配方正文变动而失效，逼人改判据。
 *     `git` 拿不到基线时**显式 SKIP 并打印原因**（跳过必须可见），并退到"摘要自洽"这条弱判据。
 *   · 功能判据用真 CLI 跑（`--data`/`--packs` 全指 %TEMP% 自建目录，绝不碰真库与运行区）。
 *
 * 数据边界：本文件只在 `%TEMP%` 下建库、建经验包根、写任务记录；不写仓库、不写用户真库。
 * 用法：node tests\neg-card-select.cjs
 * 退出码：0=全绿；1=有断言失败
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_配方.mjs');
const PACK_ENGINE = path.join(ROOT, 'src', 'tools', '_经验包.mjs');
const SAMPLES = path.join(ROOT, 'src', 'packs');
/** 批次 2 开工基线（接口契约 §0）。它是**不可变祖先提交**，所以"改造前"永远取得到。 */
const BASE_COMMIT = '83dbe5c';

let pass = 0, fail = 0, skip = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const SKIP = (name, why) => { skip++; console.log(`[SKIP] ${name}  → ${why}`); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const section = (t) => console.log('\n══ ' + t + ' ══');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-card-neg-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const readJ = (p) => JSON.parse(read(p));

/** 每次调用都真跑一次 CLI；lib 显式给，绝不落到环境变量兜底。 */
function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [opts.engine || ENGINE, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
/** 造一个只含夹具图的临时库（工具体会往里写 _录题\，所以每个用例一个库，互不串味）。 */
function mkLib(name) {
  const lib = path.join(TMP, 'lib-' + name);
  const inbox = path.join(lib, '_收件箱', '批次甲');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'p01.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]));
  return lib;
}
/** 读该库最新一条任务记录（`_录题\<taskId>.json`），没有就 null。 */
function newestTask(lib) {
  const dir = path.join(lib, '_录题');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.length ? readJ(files[0]) : null;
}

/* ══════════════════════ 一、夹具自证（判据不是恒真） ══════════════════════ */
section('一、夹具自证：仓库样本包在临时经验包根里装得上、校验得过');
if (!fs.existsSync(SAMPLES)) {
  A('仓库内样本经验包存在（src\\packs）—— 否则本用例无从判起', false, SAMPLES);
} else {
  const PACKS = path.join(TMP, 'packs');
  fs.cpSync(SAMPLES, PACKS, { recursive: true });
  /* ⚠ 试点包版本号**从目录里读最高那个**（pack.json 在 `<packId>/<version>/` 里），不写死：
     写死会在包升版时变成假红（1.0.0→1.0.1→1.0.2 已连撞两次）。 */
  const PILOT_ROOT = path.join(SAMPLES, 'family-a', 'shared-stem');
  const PILOT_VER = fs.readdirSync(PILOT_ROOT)
    .filter((d) => /^\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(PILOT_ROOT, d, 'pack.json')))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
  const samplePack = readJ(path.join(PACKS, 'family-a', 'shared-stem', PILOT_VER, 'pack.json'));
  const SAMPLE_DIR = path.join(PACKS, 'family-a', 'shared-stem', PILOT_VER);
  const v = run(['校验', SAMPLE_DIR, '--json', '--packs', PACKS], { engine: PACK_ENGINE });
  const vj = v.code === 0 || v.code === 1 ? JSON.parse(String(v.out).trim()) : null;
  A('样本包校验通过（工具体与经验包引擎对同一份样本结论一致）',
    v.code === 0 && !!vj && vj.ok === true, 'exit=' + v.code + ' errors=' + (vj ? JSON.stringify(vj.errors) : String(v.err).slice(0, 120)));
  A('样本包至少一张卡、卡的 steps 非空（冲突判据要靠它，判据不是恒真）',
    Array.isArray(samplePack.cards) && samplePack.cards.length >= 1 &&
    Array.isArray(samplePack.cards[0].steps) && samplePack.cards[0].steps.length >= 1,
    JSON.stringify(samplePack.cards.map((c) => ({ id: c.id, steps: c.steps }))));

  const PID = samplePack.id;                      // family-a/shared-stem
  const CARD0 = samplePack.cards[0].id;           // shared-stem
  const VER = samplePack.version;                 // 1.0.0
  const SEL0 = `${PID}/${CARD0}@${VER}`;
  const BODY0 = read(path.join(SAMPLE_DIR, samplePack.cards[0].body)).replace(/^\uFEFF/, '');
  const BODY0_SHA = sha256(fs.readFileSync(path.join(SAMPLE_DIR, samplePack.cards[0].body)));

  /* ══════════════════════ 二、兼容红线：无 --card 时对 83dbe5c 逐字节对拍 ══════════════════════ */
  section('二、兼容红线：无 --card 时任务单/指纹/契约摘要对 83dbe5c 逐字节相同');
  const H = path.join(TMP, 'head-harness');
  fs.mkdirSync(path.join(H, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src', 'recipes'), path.join(H, 'src', 'recipes'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src', 'tools'), path.join(H, 'src', 'tools'), { recursive: true });
  const g = spawnSync('git', ['show', BASE_COMMIT + ':src/tools/_配方.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const HEAD_ENGINE = path.join(H, 'src', 'tools', '_配方.mjs');
  const HAVE_BASE = g.status === 0 && String(g.stdout || '').length > 20000;
  if (HAVE_BASE) {
    /* 只把**引擎那一份**换成改造前的：recipes\ 与其余工具用现行的 ⇒ 差异只能来自引擎本身。 */
    fs.writeFileSync(HEAD_ENGINE, g.stdout, 'utf8');
  } else {
    SKIP('与改造前引擎逐字节对拍', 'git show ' + BASE_COMMIT + ' 拿不到基线（status=' + g.status + '）：' +
      String(g.stderr || '').split('\n')[0]);
  }

  const LIB_C = mkLib('compat');
  const noCardArgs = ['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', LIB_C];
  const cur = run(noCardArgs);
  A('无 --card 的组装：成功且 stdout 非空', cur.code === 0 && cur.out.length > 500, 'exit=' + cur.code + ' chars=' + cur.out.length);
  A('无 --card 时**没有**经验包段（兼容的本质：一个字节都不加）',
    !cur.out.includes('### 本次追加的方法（经验包）'), '');
  /* 无卡对照组（供"摘要随卡变化"这条判据比）：与有卡那次只差 --card 一个参数。 */
  const LIB_NOCARD = mkLib('nocard');
  const noc = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', LIB_NOCARD, '--task']);
  const REC_NOCARD = newestTask(LIB_NOCARD);
  A('无卡对照组确实落了任务记录（否则下面"摘要随卡变"无从比，判据会恒真）',
    noc.code === 0 && !!REC_NOCARD, 'exit=' + noc.code);
  if (HAVE_BASE) {
    const base = run(noCardArgs, { engine: HEAD_ENGINE });
    A('★ 无 --card 的任务单：与改造前逐字节相同',
      base.code === 0 && base.out === cur.out, 'base=' + base.out.length + ' cur=' + cur.out.length + ' 字符');
    A('★ 无 --card 的 stderr 摘要也逐字节相同（指纹/层数/字数一个都没动）',
      base.err === cur.err, JSON.stringify(String(cur.err).trim().slice(0, 120)));
    const fpBase = run(['指纹', '--recipe', 'ingest-single', '--subject', '数学', '--json'], { engine: HEAD_ENGINE });
    const fpCur = run(['指纹', '--recipe', 'ingest-single', '--subject', '数学', '--json']);
    A('★ 指纹命令：与改造前逐字节相同（选卡没有污染指纹口径）',
      fpBase.code === 0 && fpBase.out === fpCur.out, 'base=' + fpBase.out.trim() + ' cur=' + fpCur.out.trim());
    /* --task：任务号是随机的，所以对拍的是**记录里的摘要**而不是任务号。 */
    const libB = mkLib('base-task'), libN = mkLib('cur-task');
    const tB = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', libB, '--task'], { engine: HEAD_ENGINE });
    const tN = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', libN, '--task']);
    const rB = newestTask(libB), rN = newestTask(libN);
    A('★ 无 --card 的 contractDigest：与改造前逐字节相同',
      tB.code === 0 && tN.code === 0 && !!rB && !!rN && rB.contractDigest === rN.contractDigest,
      (rB && rB.contractDigest) + ' vs ' + (rN && rN.contractDigest));
    /* 带 --task 的任务单里写着**任务号**（随机），所以比"任务单"要先把任务号归一化；
       其余字节必须一致（含第五节的回传信封示例）。 */
    const noId = (s, id) => s.split(id).join('<TASKID>');
    A('★ 带 --task 的任务单：任务号归一化后逐字节相同（含第五节的回传信封示例）',
      !!rB && !!rN && noId(tB.out, rB.taskId) === noId(tN.out, rN.taskId),
      'base=' + tB.out.length + ' cur=' + tN.out.length + ' 字符');
    A('★ 无 --card 的 taskDigest 就是任务单 bytes 的 sha256（口径没变）',
      !!rN && rN.taskDigest === sha256(Buffer.from(tN.out, 'utf8')), '');
    A('无 --card 时任务记录的 cards 仍是空数组（保持现值）',
      !!rN && Array.isArray(rN.cards) && rN.cards.length === 0, rN ? JSON.stringify(rN.cards) : '(无记录)');
    /* 带原图：任务单里含**本机引擎绝对路径**（分支 A 的找图命令），两个引擎装在不同目录
       ⇒ stdout 天然有两处不同。所以这里比"路径归一化之后的字节"+ 摘要本身（摘要不含路径）。 */
    const libB2 = mkLib('base-img'), libN2 = mkLib('cur-img');
    const imgB = path.join(libB2, '_收件箱', '批次甲', 'p01.png');
    const imgN = path.join(libN2, '_收件箱', '批次甲', 'p01.png');
    const iB = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--image', imgB, '--data', libB2, '--task'], { engine: HEAD_ENGINE });
    const iN = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--image', imgN, '--data', libN2, '--task']);
    const rB2 = newestTask(libB2), rN2 = newestTask(libN2);
    /* 两处必须归一化，且两处都是**已知的环境差异**，不是判据放松：
       ① 两颗引擎装在不同目录 ⇒ 任务单里"分支 A"的找图命令路径不同；
       ② `--task` 的任务号是随机的（同图同配方再生成也是两个任务，见 _录题任务.mjs 头注）。 */
    const norm = (s, eng, id) => s.split(path.join(path.dirname(eng))).join('<TOOLS>').split(id).join('<TASKID>');
    A('★ 带原图的任务单：路径与任务号归一化后逐字节相同（其余一个字节都不许变）',
      iB.code === 0 && iN.code === 0 && !!rB2 && !!rN2 &&
      norm(iB.out, HEAD_ENGINE, rB2.taskId) === norm(iN.out, ENGINE, rN2.taskId),
      'base=' + iB.out.length + ' cur=' + iN.out.length + ' 字符');
    A('★ 带原图的 contractDigest：与改造前逐字节相同（摘要不含路径与任务号，可直接比）',
      !!rB2 && !!rN2 && rB2.contractDigest === rN2.contractDigest,
      (rB2 && rB2.contractDigest) + ' vs ' + (rN2 && rN2.contractDigest));
  }
  const lstBase = HAVE_BASE ? run(['清单', '--json', '--data', LIB_C], { engine: HEAD_ENGINE }) : null;
  const lstCur = run(['清单', '--json', '--packs', PACKS, '--data', LIB_C]);
  if (HAVE_BASE) {
    const jb = lstBase.code === 0 ? JSON.parse(lstBase.out) : null;
    const jc = lstCur.code === 0 ? JSON.parse(lstCur.out) : null;
    A('★ 清单的 recipes 段逐字不变（经验包段落只**追加**，不动既有字段）',
      !!jb && !!jc && JSON.stringify(jb.recipes) === JSON.stringify(jc.recipes),
      jc ? 'recipes=' + jc.recipes.length + ' 个' : '(解析失败)');
  }
  A('清单 --json 追加 packs 字段（listPacks() 结果；本用例指到临时根）',
    lstCur.code === 0 && (() => { const j = JSON.parse(lstCur.out); return Array.isArray(j.packs) && j.packs.length === 1 && j.packs[0].id === PID; })(),
    (() => { try { const j = JSON.parse(lstCur.out); return JSON.stringify(j.packs); } catch { return String(lstCur.err).slice(0, 120); } })());

  /* ══════════════════════ 三、选一张卡：正文进提示词 + 摘要变 ══════════════════════ */
  section('三、选一张卡：正文进「二、任务指令」段、摘要随卡变、任务记录带选卡数组');
  const LIB1 = mkLib('one');
  const one = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', LIB1, '--packs', PACKS, '--card', SEL0, '--task']);
  const rec1 = newestTask(LIB1);
  A('选一张卡 → 组装成功', one.code === 0, 'exit=' + one.code + ' err=' + JSON.stringify(String(one.err).trim().slice(0, 200)));
  A('任务单出现固定标题 `### 本次追加的方法（经验包）`', one.out.includes('### 本次追加的方法（经验包）'), '');
  A('每张卡一段：`#### <包id>/<卡id>@<版本>` 逐字',
    one.out.includes('#### ' + SEL0), '');
  A('★ 卡正文**完整**进任务单（按字节比对整段正文）', one.out.includes(BODY0.trim()), '正文 ' + BODY0.trim().length + ' 字符');
  {
    const iAi = one.out.indexOf('## 二、任务指令');
    const iCard = one.out.indexOf('### 本次追加的方法（经验包）');
    const iBack = one.out.indexOf('## 三、回来之后');
    A('★ 卡正文位于「二、任务指令」段内（否则用户只复制那一段就丢卡）',
      iAi > 0 && iCard > iAi && iCard < iBack, 'AI段@' + iAi + ' 经验包段@' + iCard + ' 回来之后@' + iBack);
    /* "排在配方正文之后"要有个**精确**的锚：配方正文（含反例库）在任务单里出现两次
       （二、任务指令 一次，四、本机留痕 一次），所以拿反例库正文的**尾端**做锚 ——
       经验包段必须在第一份配方正文结束之后。 */
    const anti = read(path.join(ROOT, 'src', 'recipes', 'ingest-single', 'anti-patterns.md')).trim();
    const iAnti = one.out.indexOf(anti);
    A('★ 卡正文排在配方正文（含反例库）之后',
      iAnti > 0 && one.out.indexOf('#### ' + SEL0) > iAnti + anti.length,
      '反例库尾端@' + (iAnti + anti.length) + ' 卡@' + one.out.indexOf('#### ' + SEL0));
    A('经验包段只出现一次（不会跟着"四、本机留痕"再抄一遍）',
      one.out.split('### 本次追加的方法（经验包）').length - 1 === 1, '');
  }
  A('每张卡有一行"来源 + 正文 sha256 前 12 位"',
    one.out.includes('来源：经验包 `' + PID + '`') && one.out.includes('sha256 前 12 位 `' + BODY0_SHA.slice(0, 12) + '`'),
    'want=' + BODY0_SHA.slice(0, 12));
  A('任务单**不写**经验包目录的绝对路径（默认根在 %LOCALAPPDATA%，绝对路径会带本机用户名）',
    !one.out.includes(PACKS), '');
  A('任务记录的 cards = [{packId,cardId,version,sha256}]，sha256 是**卡文件字节**的 sha256（契约 §3.3/§3.4）',
    !!rec1 && JSON.stringify(rec1.cards) === JSON.stringify([{ packId: PID, cardId: CARD0, version: VER, sha256: BODY0_SHA }]),
    rec1 ? JSON.stringify(rec1.cards) : '(无记录)');
  A('任务单里那 12 位前缀与任务记录里的 64 位 sha256 同源（同一份"卡正文摘要"口径）',
    !!rec1 && one.out.includes('sha256 前 12 位 `' + String(rec1.cards[0].sha256).slice(0, 12) + '`'), '');
  A('★ contractDigest 随选卡变化（无卡与有卡必须不同）',
    !!rec1 && !!REC_NOCARD && rec1.contractDigest !== REC_NOCARD.contractDigest,
    (rec1 && rec1.contractDigest) + ' vs ' + REC_NOCARD.contractDigest);
  A('同一份选卡跑两次 → contractDigest 稳定（摘要不是随机的）', (() => {
    const L = mkLib('one-again');
    const again = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', L, '--packs', PACKS, '--card', SEL0, '--task']);
    const r = newestTask(L);
    return again.code === 0 && !!r && !!rec1 && r.contractDigest === rec1.contractDigest;
  })(), '');

  /* ══════════════════════ 四、失败样本：各自 exit 2 且原因可归因 ══════════════════════ */
  section('四、失败样本：未知包/未知版本/未知卡/形状错/停用/坏包 —— 全部 exit 2 且原因可归因');
  const bad = (label, argv, want, packsRoot, slug) => {
    const r = run([...argv, '--data', mkLib('bad-' + slug), '--packs', packsRoot || PACKS]);
    A(label, r.code === 2 && want.test(String(r.err)), 'exit=' + r.code + ' err=' + JSON.stringify(String(r.err).trim().split('\n')[0].slice(0, 160)));
  };
  const CARD_ARGS = (sel) => ['组装', '--recipe', 'ingest-single', '--subject', '数学', '--card', sel];
  bad('未知包 → exit 2 且点名"没有安装经验包"', CARD_ARGS('no-such-pack/card@1.0.0'), /没有安装经验包/, null, 'unknown-pack');
  bad('未知版本 → exit 2 且点名"没有版本"+已装版本', CARD_ARGS(`${PID}/${CARD0}@9.9.9`), /没有版本 9\.9\.9/, null, 'unknown-version');
  bad('未知卡 → exit 2 且列出该包有哪些卡', CARD_ARGS(`${PID}/no-such-card@${VER}`), /里没有卡/, null, 'unknown-card');
  bad('选卡串形状错（.. 段）→ exit 2 且说清是形状错', CARD_ARGS('family-a/../../evil/card@1.0.0'), /形状/, null, 'sel-dots');
  bad('选卡串缺版本 → exit 2', CARD_ARGS(`${PID}/${CARD0}`), /形状|版本/, null, 'sel-nover');
  bad('--card-conflict 取值非法 → exit 2（语义由引擎判，不在壳层猜）',
    [...CARD_ARGS(SEL0), '--card-conflict', 'whatever'], /card-conflict/, null, 'conflict-bad');
  bad('--card 缺值 → exit 2（不许当成"没给"静默跳过）',
    ['组装', '--recipe', 'ingest-single', '--subject', '数学', '--card'], /缺少值/, null, 'card-noval');
  {   /* 停用包：包目录里放 `.停用`（内容随意，建议写原因）⇒ 选它 exit 2，且原因是"已停用" */
    const P_DIS = path.join(TMP, 'packs-disabled');
    fs.cpSync(SAMPLES, P_DIS, { recursive: true });
    fs.writeFileSync(path.join(P_DIS, 'family-a', 'shared-stem', PILOT_VER, '.停用'), '测试：临时停用\n', 'utf8');
    bad('停用包 → exit 2 且说清"已停用"（不是"包不存在"）', CARD_ARGS(SEL0), /已停用/, P_DIS, 'disabled');
    const lj = run(['清单', '--json', '--packs', P_DIS, '--data', mkLib('dis-list')]);
    let listed = null; try { listed = JSON.parse(lj.out).packs.find((p) => p.id === PID); } catch { }
    A('清单照常列出被停用的包（报告不是门禁：停用只影响选卡）',
      lj.code === 0 && !!listed && listed.enabled === false, listed ? JSON.stringify({ enabled: listed.enabled }) : String(lj.err).slice(0, 120));
    const lh = run(['清单', '--packs', P_DIS, '--data', mkLib('dis-list2')]);
    A('人读清单写出"已停用"与恢复方式（删掉 .停用）',
      lh.code === 0 && /已停用/.test(lh.out) && /\.停用/.test(lh.out), '');
  }
  {   /* 坏包：pack.json 不是合法 JSON ⇒ 包损坏 ⇒ 选它 exit 2 且说出是结构错 */
    const P_BROKEN = path.join(TMP, 'packs-broken');
    fs.cpSync(SAMPLES, P_BROKEN, { recursive: true });
    fs.writeFileSync(path.join(P_BROKEN, 'family-a', 'shared-stem', PILOT_VER, 'pack.json'), '{ 这不是 JSON\n', 'utf8');
    bad('坏包（pack.json 不是合法 JSON）→ exit 2 且点名"内容不合法/结构"', CARD_ARGS(SEL0), /内容不合法|结构/, P_BROKEN, 'broken');
  }
  {   /* 缺卡正文文件：校验层就要拒（不是"读到空正文"） */
    const P_MISS = path.join(TMP, 'packs-missing-body');
    fs.cpSync(SAMPLES, P_MISS, { recursive: true });
    fs.rmSync(path.join(P_MISS, 'family-a', 'shared-stem', PILOT_VER, 'cards', samplePack.cards[0].body.split('/').pop()));
    bad('卡正文文件缺失 → exit 2 且点名缺文件', CARD_ARGS(SEL0), /缺文件|不存在|内容不合法/, P_MISS, 'missing-body');
  }
  {   /* 同版异内容：契约 §2.1 把它归在 `校验` 的判据里（候选目录与已安装的同 id@version 内容不同）。
         为什么不在 `--card` 侧判：选卡串的 packId/version **就是**目录路径推出来的，
         `--card` 命中的永远是"已安装的那一份"⇒ 同版异内容在选卡这条路上**构造不出来**。
         所以这里按契约钉 `校验` 侧（exit 1 + 说清两侧摘要），而不是硬造一个假样本。 */
    const P_DUP = path.join(TMP, 'packs-dup');
    fs.cpSync(SAMPLES, P_DUP, { recursive: true });
    const candDir = path.join(P_DUP, 'candidate-copy', VER);
    fs.cpSync(path.join(P_DUP, 'family-a', 'shared-stem', VER), candDir, { recursive: true });
    const cj = readJ(path.join(candDir, 'pack.json'));
    cj.id = PID; cj.version = VER;                       // 冒充同一个 id@version
    fs.writeFileSync(path.join(candDir, 'pack.json'), JSON.stringify(cj, null, 2), 'utf8');
    fs.appendFileSync(path.join(candDir, 'cards', samplePack.cards[0].body.split('/').pop()), '\n（改过的内容）\n', 'utf8');
    const rv = run(['校验', candDir, '--json', '--packs', P_DUP], { engine: PACK_ENGINE });
    const rvj = rv.code !== 2 ? (() => { try { return JSON.parse(rv.out); } catch { return null; } })() : null;
    A('同版异内容 → `校验 <候选目录>` exit 1 且给出两侧摘要前 12 位（契约 §2.1）',
      rv.code === 1 && !!rvj && rvj.errors.some((e) => e.code === '同版异内容' && /内容摘要不同/.test(e.why)),
      'exit=' + rv.code + ' why=' + (rvj ? JSON.stringify((rvj.errors[0] || {}).why || '').slice(0, 180) : String(rv.err).slice(0, 120)));
  }
  {   /* 参数范围：选卡/经验包根只对 `组装`（`--packs` 另可用于`清单`）生效 —— 收下不用=静默忽略 */
    const r1 = run(['指纹', '--recipe', 'ingest-single', '--card', SEL0, '--data', mkLib('off-1')]);
    A('非组装命令带 --card → exit 2（不许静默忽略）', r1.code === 2 && /只对/.test(r1.err), 'exit=' + r1.code);
    const r2 = run(['指纹', '--recipe', 'ingest-single', '--packs', PACKS, '--data', mkLib('off-2')]);
    A('非组装/非清单命令带 --packs → exit 2', r2.code === 2 && /只对/.test(r2.err), 'exit=' + r2.code);
    const r3 = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--card', SEL0, '--card', SEL0, '--data', mkLib('off-3'), '--packs', PACKS]);
    A('同一张卡选两次 → exit 2 且原因可读（不是"A 与 A 冲突"）', r3.code === 2 && /选了两次/.test(r3.err), 'exit=' + r3.code);
  }

  /* ══════════════════════ 五、冲突三策略（契约 §3.1） ══════════════════════ */
  section('五、冲突三策略：deny 拒 / first 打印让位 / all 全拼');
  /* 造一个合成包：把样本包的卡复制成三张 —— card-b 与样本卡**同一步骤**（冲突），
     card-c 声明另一步骤（不冲突）。只改 pack.json 与新增两份正文，样本目录一个字节不动。 */
  const PACKS_C = path.join(TMP, 'packs-conflict');
  fs.cpSync(SAMPLES, PACKS_C, { recursive: true });
  const cdDir = path.join(PACKS_C, 'family-a', 'shared-stem', VER);
  const cpj = readJ(path.join(cdDir, 'pack.json'));
  const c0 = cpj.cards[0];
  const bodyFile = (n) => path.join(cdDir, 'cards', n + '.md');
  fs.writeFileSync(bodyFile('card-b'), '# 卡片 B\n\nB-MARKER：与样本卡覆盖同一个步骤。\n', 'utf8');
  fs.writeFileSync(bodyFile('card-c'), '# 卡片 C\n\nC-MARKER：覆盖另一步骤，不与任何卡冲突。\n', 'utf8');
  const STEP0 = c0.steps[0];
  cpj.cards.push(Object.assign({}, c0, { id: 'card-b', title: 'B', body: 'cards/card-b.md', steps: [STEP0] }));
  cpj.cards.push(Object.assign({}, c0, { id: 'card-c', title: 'C', body: 'cards/card-c.md', steps: ['另一步骤'] }));
  fs.writeFileSync(path.join(cdDir, 'pack.json'), JSON.stringify(cpj, null, 2), 'utf8');
  const SEL_B = `${PID}/card-b@${VER}`, SEL_C = `${PID}/card-c@${VER}`;
  const vc = run(['校验', cdDir, '--json', '--packs', PACKS_C], { engine: PACK_ENGINE });
  A('合成冲突夹具自身是合法包（不然下面的冲突判据不成立）', vc.code === 0, 'exit=' + vc.code + ' err=' + String(vc.err).slice(0, 160));

  const denyLib = mkLib('cf-deny');
  const deny = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', denyLib, '--packs', PACKS_C, '--card', SEL0, '--card', SEL_B, '--task']);
  A('★ deny（默认）→ exit 2', deny.code === 2, 'exit=' + deny.code);
  A('★ deny 点名「步骤 X 被两张卡同时覆盖：A 与 B」（可归因到具体步骤与两张卡）',
    deny.err.includes('步骤「' + STEP0 + '」') && deny.err.includes('同时覆盖') && deny.err.includes(SEL0) && deny.err.includes(SEL_B),
    JSON.stringify(String(deny.err).trim().split('\n')[0].slice(0, 200)));
  A('★ deny 给出处置用法（--card-conflict=first|all），不是一句"冲突了"',
    /--card-conflict=first/.test(deny.err) && /--card-conflict=all/.test(deny.err), '');
  A('deny 时不产出任何任务单（stdout 为空，不许"先给一半"）', deny.out === '', JSON.stringify(deny.out.slice(0, 80)));
  A('deny 时**不落**任务记录（拒得干净：没有半份留痕）', newestTask(denyLib) === null, '');

  const firstLib = mkLib('cf-first');
  const first = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', firstLib, '--packs', PACKS_C, '--card', SEL0, '--card', SEL_B, '--card-conflict', 'first', '--task']);
  A('★ first → exit 0（保留先给的）', first.code === 0, 'exit=' + first.code + ' err=' + JSON.stringify(String(first.err).trim().slice(0, 160)));
  A('★ first：让位的卡**整卡**不进提示词', first.out.includes(BODY0.trim()) && !first.out.includes('B-MARKER'), '');
  A('★ first：让位这件事**打印一行**（不静默丢卡）',
    /让位/.test(first.err) && first.err.includes(SEL_B) && first.err.includes(STEP0),
    JSON.stringify(String(first.err).trim().split('\n').filter((l) => /让位/.test(l)).join(' | ').slice(0, 200)));
  A('first：任务记录只记留下的那张（让位的卡不进 cards）',
    (() => { const r = newestTask(firstLib); return !!r && r.cards.length === 1 && r.cards[0].cardId === CARD0; })(),
    JSON.stringify((newestTask(firstLib) || {}).cards));

  const all = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', mkLib('cf-all'), '--packs', PACKS_C, '--card', SEL0, '--card', SEL_B, '--card-conflict', 'all', '--task']);
  A('★ all → exit 0 且两张卡的正文都在（按顺序拼入）', all.code === 0 && all.out.includes(BODY0.trim()) && all.out.includes('B-MARKER'), 'exit=' + all.code);
  A('all：两张卡按 --card 顺序出现', all.out.indexOf('#### ' + SEL0) < all.out.indexOf('#### ' + SEL_B), '');
  A('all：没有"让位"这类告警（没有丢任何一张）', !/让位/.test(all.err), JSON.stringify(String(all.err).trim().slice(0, 120)));

  /* ══════════════════════ 六、多卡顺序影响摘要 + 清单经验包段落 ══════════════════════ */
  section('六、多卡顺序影响 contractDigest；清单列出经验包（来源/版本/启用/校验结论）');
  const L_AB = mkLib('order-ab'), L_BA = mkLib('order-ba');
  const ab = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', L_AB, '--packs', PACKS_C, '--card', SEL0, '--card', SEL_C, '--task']);
  const ba = run(['组装', '--recipe', 'ingest-single', '--subject', '数学', '--data', L_BA, '--packs', PACKS_C, '--card', SEL_C, '--card', SEL0, '--task']);
  const rAB = newestTask(L_AB), rBA = newestTask(L_BA);
  A('两张不冲突的卡：都能进任务单（判据不是恒真）', ab.code === 0 && ba.code === 0 && ab.out.includes('C-MARKER') && ba.out.includes('C-MARKER'), 'exit=' + ab.code + '/' + ba.code);
  A('★ 选卡顺序影响 contractDigest（摘要覆盖"选择顺序"这个事实）',
    !!rAB && !!rBA && rAB.contractDigest !== rBA.contractDigest, (rAB && rAB.contractDigest) + ' vs ' + (rBA && rBA.contractDigest));
  A('★ 选卡顺序影响任务单正文（后选的卡在后面）',
    ab.out.indexOf('#### ' + SEL0) < ab.out.indexOf('#### ' + SEL_C) && ba.out.indexOf('#### ' + SEL_C) < ba.out.indexOf('#### ' + SEL0), '');
  {
    const lh = run(['清单', '--packs', PACKS_C, '--data', mkLib('list-human')]);
    A('人读清单有经验包段落：根目录 + 包 id/版本 + 启用状态 + 校验结论 + 选卡用法',
      lh.code === 0 && /经验包根/.test(lh.out) && lh.out.includes(PID) && /启用/.test(lh.out) && /校验：✔ 通过/.test(lh.out) && /--card/.test(lh.out),
      '');
    const lj = JSON.parse(run(['清单', '--json', '--packs', PACKS_C, '--data', mkLib('list-json')]).out);
    const p = (lj.packs || []).find((x) => x.id === PID);
    A('清单 --json.packs 逐字段可用（id/version/enabled/verdict/title/author/license）',
      !!p && p.version === VER && p.enabled === true && p.verdict.ok === true && !!p.title && !!p.author && !!p.license,
      JSON.stringify(p && Object.keys(p)));
    const empty = run(['清单', '--json', '--packs', path.join(TMP, 'no-such-packs-root'), '--data', mkLib('list-empty')]);
    A('经验包根不存在 ⇒ 清单照常 exit 0 且 packs=[]（报告不是门禁）',
      empty.code === 0 && Array.isArray(JSON.parse(empty.out).packs) && JSON.parse(empty.out).packs.length === 0, 'exit=' + empty.code);
  }

  /* ══════════════════════ 七、清场 ══════════════════════ */
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}  跳过=${skip}`);
  process.exit(fail ? 1 : 0);
}
