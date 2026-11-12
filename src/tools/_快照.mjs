#!/usr/bin/env node
/**
 * 错题本 · 数据快照提交器（工程管理件）
 *
 * 把「题库数据真源」的当前状态提交进 git —— 让每次录卡/办结/批改都有可回滚的时间点。
 * 只碰数据路径，绝不裹挟代码改动；提交不是第二条写路径（数据仍只由 CLI 工具写盘，本脚本只 commit 已落盘结果）。
 *
 * 用法：node _快照.mjs ["事由"]        例：node _快照.mjs "学生A物理p41-p45入册12卡"
 *      node _快照.mjs --dry           只看会提交什么（不提交）
 *      node _快照.mjs --list          打印纳管清单
 *      node _快照.mjs --status        看历史 data: 提交数与当前未快照改动（有未快照则 exit 1）
 *      node _快照.mjs --restore <文件> [来源]  从历史恢复一个真源（见下方"恢复流程"）
 *      node _快照.mjs --restore-list <文件>     只列出该文件的全部历史版本
 *
 * ══ 未知参数必须报错退出（2026-10-12 加）══
 *   起因（真实事故）：审计子代理为探测"有无 --restore"而执行 `node _快照.mjs --restore`，
 *   本脚本只认 --dry/--list/--status，**未识别参数静默落到默认的提交分支**，
 *   于是产生了一次意料之外的 commit。打字手滑（--restor/--resotre）同理。
 *   铁律：**任何写操作型工具，未知参数必须 exit 2 打印用法**，绝不"猜一个分支跑"。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readJsonStrict, writeTextAtomic, acquireLibLock } from './_安全写.mjs';
import { libraryRoot } from './_库根.mjs';

/* ★ 2026-10-23 程序与数据分家：ROOT 是**库根**（数据 + 库所在的 git 仓库），不是工具目录。
   原先是 `path.dirname(fileURLToPath(import.meta.url))`，工具搬进 <AppRoot>\tools\ 之后
   那样算出来的 git 仓库是**程序仓库**而不是库仓库（恢复演练因此查错过仓库），
   纳管清单里的 _索引.json 也全都找不到。语义要点：快照的对象永远是**库**，不是程序。 */
const ROOT = libraryRoot();
const args = process.argv.slice(2);
const dry = args.includes('--dry');

const USAGE = `用法：
  node _快照.mjs ["事由"]            提交数据真源快照
  node _快照.mjs --dry               只看会提交什么
  node _快照.mjs --list              打印纳管清单
  node _快照.mjs --status            历史快照数 + 当前未快照改动（未快照则 exit 1）
  node _快照.mjs --restore-list <文件>          列出该真源的全部历史版本
  node _快照.mjs --restore <文件> [版本] [--force-restore --confirm-force=<文件名>]   恢复该真源（默认最近一版），恢复前自动备份
  （--force-restore：跳过"掏空/缩水"内容校验（JSON 与 md/html/csv 同口径）。用途：**有意**恢复一个旧的小版本，
    或有意恢复一个清零后的空态 —— "最富历史基线"会把这两种合法意图误判成内容丢失。
    必须同时给 --confirm-force=<要恢复的文件名> 做二次确认；每次强制恢复记入 _备份-真源\\_强制恢复审计.log。
    恢复前内容仍会留档进 _备份-真源\\，恢复后仍要过形状守卫与同构校验。）`;

const FLAGS = ['--dry', '--list', '--status', '--restore', '--restore-list', '--force-restore'];
/* ★ 2026-11-04（外部复核实测 F04/N4）：**关键计数字段清单**（按真源文件名 → 该文件里"内容条数"住在哪个数组字段）。
   用途：快照恢复时，除了比对顶层形状，还要比对**内容条数** ——
   原先只比"顶层键名 + 类型"，于是 items/batches 被**掏空**（仍是 array，类型没变）照样通过，
   校验报"通过"并把一个空库当成正常版本写回真源。
   刻意**按文件名**索引而不是猜：猜错就会误判正常恢复。
   本轮补两处覆盖缺口（MUSE 实测）：
     · `_笔形台账.json` 在 DATA_PATHS 里纳管，却不在本表 ⇒ items 被掏空照样恢复通过；
     · `_索引.json` 有**两种合法形态**（学科级 items[] / 学生级 subjects{}）——
       subjects 被掏空成 `{}` 时顶层键名与类型没变、内容循环因字段缺失而 continue ⇒ 漏网。
       故此处用**多字段**表达：items 或 subjects 任一被掏空都判红。 */
const CRITICAL_FIELDS_BY_NAME = {
  '_索引.json': ['items', 'subjects'],
  '_组卷台账.json': ['batches'],
  '_待确认.json': ['items'],
  '_原卷台账.json': ['cards'],
  '_影像清单.json': ['files'],
  '_盲解双路.json': ['cards'],
  '_配图台账.json': ['figures'],
  '_页码映射.json': ['mappings'],
  '_原图台账.json': ['objects'],
  '_笔形台账.json': ['items'],
};
const unknown = args.filter(a => a.startsWith('--') && !FLAGS.includes(a) && !a.startsWith('--confirm-force='));
if (unknown.length) {
  console.error('✖ 未知参数：' + unknown.join(' '));
  console.error(USAGE);
  process.exit(2);
}

const reason = args.find(a => !a.startsWith('--')) || '例行快照';

/* git 无 :(glob) 前缀时 '*' 可跨 '/'，故 '*_索引.json' 即匹配任意深度。
   ⚠ 2026-10-10（BUG-13）：原先漏了 3 个真源（_原卷台账.json / _盲解双路.json / _笔形台账.json）
   与撤卡留档目录 —— 那三个文件装的是 205 条双路盲解结论、202 条原卷溯源坐标、19 条笔形判读，
   全是不可再生的人工判读；漏掉它们等于"快照"名不副实。
   ⚠ 2026-10-31：再补 `_原图台账.json`（原图保全库的对象名册）。
   丢了它不等于丢原图字节（字节在 `_原图\` 与备份里），但会丢掉"哪个 sha 是哪个批次/原名/学生"
   这层溯源 —— 而卡片关系里的 pageSha 指着它，名册一丢就只能靠人工重认。
   同理补 `_页码映射.json`（原卷扫描件 → 印刷页码的单一真源，153 条映射且含偏移规则）。
   自检：tests\gate-contracts 不覆盖此项，故在本文件底部给出 `--list` 打印实际纳管清单。 */
const DATA_PATHS = [
  '*_索引.json', '_待确认.json', '_组卷台账.json', '_配图台账.json',
  '_原卷台账.json', '_盲解双路.json', '_笔形台账.json',
  '_原图台账.json', '_页码映射.json',
  '*错题记录.md', '*题干.html', '_词表.md',
  /* ★ 2026-11-12（审计 R-05）：库根**人工维护**的 .md 台账也要纳管 —— 它们不能从任何 json 推出来。
     原先只纳管了 `_词表.md` 一个，其余靠"想起来才加"，于是 `_整改台账.md`（28 KB，整改决策的
     唯一记录）与会话中新写的 `_原卷待定位-按批次.md`（134 KB 的分批工单）都**不在**快照里。
     ⚠ 派生视图**刻意不纳管**（`_待确认清单.md` / `_复习队列.md`）——它们可由 `_待确认.json` 与
     队列生成器重建，纳管只会让每次快照都产生无意义 diff（与 `_状态.json` 同理）。
     新增人工维护的根层 .md 时，记得加到这里。 */
  '_整改台账.md', '_原卷待定位-按批次.md',
  '_撤卡留档/**',
  /* 收件箱里的来源映射/人工判读（2026-10-31 实测：本机别处没有同字节副本，
     且它们不能从任何原图推出。清空收件箱前必须先被快照纳管。） */
  '_收件箱/**/_来源映射.csv', '_收件箱/**/_答案页映射.csv', '_收件箱/*.md',
];

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 64e6 });
const gitBin = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'buffer', maxBuffer: 256e6 });
/* 同理（2026-11-12 实测）：展开后的纳管路径有 1404 条 / 43 KB，直接进 argv 会撞 Windows 的
   CreateProcess 上限（`spawnSync git ENAMETOOLONG`）。故凡是"路径条数随库增长"的调用，
   一律走 `--pathspec-from-file=-` + NUL 分隔的 stdin（add / reset / commit 三个子命令都支持，
   已逐条查 `git <cmd> -h` 确认）；不支持该选项的（如 `diff`）改用分批调用——两者都不改语义。 */
const gitStdin = (input, ...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', input, maxBuffer: 64e6 });
const PS_FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];
const nulList = list => list.join('\0') + '\0';
function* batches(arr, n = 100) { for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n); }

/* ══════════════ 恢复流程（2026-10-12 建）══════════════
   起因：审计发现"全库没有任何一条可执行的恢复流程"——出事只能人工翻备份目录猜版本，
   且从未演练过。数据不安全不是"没备份"，是"有备份但不知道怎么用、也没验证过能用"。
   本命令把恢复变成**一条可执行、可演练、有安全网**的操作：
     来源优先级：① 指定 git 版本 ② 最近一次含该文件的 data: 提交 ③ `_备份-真源\` 最新一份
   三道安全网（缺一不可）：
     1. **恢复前把当前内容存进 `_备份-真源\`**（万一恢复错，还能退回来）
     2. **恢复后必须过形状守卫**（`readJsonStrict`），形状不对 ⇒ 判定失败并自动退回原文件
     3. **--dry 先看再恢复**（默认建议先跑一次 --restore-list 看清楚版本） */
function normalizeTarget(input) {
  if (!input) return '';
  let p = input.trim().split('\\').join('/');
  if (fs.existsSync(path.join(ROOT, p))) return p;
  // 允许只给文件名：到 DATA_PATHS 里找唯一匹配
  const base = p.split('/').pop();
  const all = git('ls-files', '--', ...DATA_PATHS).split(/\r?\n/).filter(Boolean);
  const hit = all.filter(f => f.split('/').pop() === base);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) {
    console.error(`✖ "${base}" 匹配到 ${hit.length} 个文件，请给完整相对路径：`);
    hit.slice(0, 10).forEach(f => console.error('    ' + f));
    process.exit(2);
  }
  return p;
}

function historyOf(rel) {
  const out = [];
  try {
    const log = git('log', '--format=%H|%h|%ad|%s', '--date=iso', '--', rel);
    for (const line of log.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [full, short, date, ...rest] = line.split('|');
      out.push({ full, short, date, msg: rest.join('|') });
    }
  } catch { }
  return out;
}

if (args.includes('--restore-list')) {
  const i = args.indexOf('--restore-list');
  const rel = normalizeTarget(args.slice(i + 1).filter(a => !a.startsWith('--'))[0]);
  if (!rel) { console.error(USAGE); process.exit(2); }
  const hist = historyOf(rel);
  console.log(`历史版本（${rel}）：共 ${hist.length} 个提交`);
  hist.slice(0, 20).forEach((h, i) => console.log(`  [${i === 0 ? '最近' : i}] ${h.short} ${h.date}  ${h.msg}`));
  if (!hist.length) console.log('  （git 里没有该文件的任何提交）');
  process.exit(0);
}

if (args.includes('--restore')) {
  const i = args.indexOf('--restore');
  // 版本参数必须跳过其它 flag（--dry 可能紧跟其后，否则会被误当成版本号）
  const positional = args.slice(i + 1).filter(a => !a.startsWith('--'));
  /* ★ 2026-11-04（F04/N4）：**有意恢复旧小版本/清零空态**的显式口径。
     "内容最富的历史版"当分母抓得住"被掏空的恢复"，但也会把两种**合法意图**持续拦截：
       · 库从 10 条长到 200 条，用户想恢复 10 条的旧版（10 < 200×0.5 判红回滚）；
       · 用户有意把库清零并快照过该空态，之后想恢复回这个空态。
     修前全文件无任何 force/绕过开关 —— 合法旧版本恢复被最富基线**永远**挡住。
     现在 --force-restore 跳过掏空/缩水两档内容校验（形状守卫与同构校验**仍然要过**，
     恢复前留档也不省 —— 安全网只放宽"内容量"这一档，且必须显式打出警告留痕）。 */
  const forceRestore = args.includes('--force-restore');
  const rel = normalizeTarget(positional[0]);
  const ver = positional[1] || null;         // 可选：git short/full hash
  if (!rel) { console.error(USAGE); process.exit(2); }
  const abs = path.join(ROOT, rel);
  /* ★ 2026-11-05（合并评审 P0-4）：--force-restore 是**显式绕过口**，不是安全机制。
     修前只要多打一个 flag 就跳过内容校验，且不留任何审计痕迹。现在：
       ① 二次确认：必须同时给 `--confirm-force=<文件名>`，且文件名与要恢复的文件一致
          （防止从别的命令行复制粘贴时把 --force-restore 带过来）；
       ② 审计：每次强制恢复在 `_备份-真源\_强制恢复审计.log` 追加一行（时间/文件/来源/前后字节数/操作者）。
     审计日志与备份同目录、同权限 —— 它防的是"误操作无痕"，不防有意篡改，这一点如实写在这里。 */
  /* ★ 2026-11-05（PR #13 复审）：审计改成"先记后做"。修前审计在恢复**之后**追加、写失败只警告 ⇒
       恢复成功却无痕；被拒的强制恢复也不留痕。现在：
         · 被拒（二次确认缺失/不符）⇒ 尽力记一行 status=refused（写不进也照样拒，拒绝本身是安全的一侧）；
         · 放行前先记 status=attempt，**写不进就中止、不恢复**；恢复结束再记 done / reverted。 */
  const auditFile = path.join(path.dirname(abs), '_备份-真源', '_强制恢复审计.log');
  const audit = (rec) => {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify(Object.assign({
      at: new Date().toISOString(), file: rel,
      by: (() => { try { return os.userInfo().username; } catch { return ''; } })(),
    }, rec)) + '\n', 'utf8');
  };
  if (forceRestore) {
    const conf = (args.find(a => a.startsWith('--confirm-force=')) || '').slice('--confirm-force='.length);
    if (conf !== path.basename(abs)) {
      try { audit({ status: 'refused', reason: conf ? '--confirm-force 文件名不符：' + conf : '缺 --confirm-force', version: ver || '' }); } catch { }
      console.error('✖ --force-restore 会跳过"掏空/缩水"内容校验，需要二次确认：再加 --confirm-force=' + path.basename(abs) +
        '（文件名必须与要恢复的文件一致）。未执行任何恢复。');
      process.exit(2);
    }
  }

  let src = null, srcDesc = '', fromGit = false;
  if (ver) {
    fromGit = true;
    src = ver;
    srcDesc = 'git ' + ver;
    try { git('cat-file', '-e', ver + ':' + rel); } catch { console.error(`✖ 该版本不含 ${rel}`); process.exit(1); }
  } else {
    const hist = historyOf(rel);
    if (hist.length) { fromGit = true; src = hist[0].full; srcDesc = `最近含它的提交 ${hist[0].short}（${hist[0].date}）`; }
  }
  if (!src) {   // 退到 _备份-真源\
    const bdir = path.join(path.dirname(abs), '_备份-真源');
    if (fs.existsSync(bdir)) {
      const key = path.basename(abs);
      const cands = fs.readdirSync(bdir).filter(f => f.startsWith(key.replace(/\.json$/, '')) || f.includes(key))
        .map(f => ({ f, t: fs.statSync(path.join(bdir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (cands.length) { fromGit = false; src = path.join(bdir, cands[0].f); srcDesc = '`_备份-真源\\' + cands[0].f; }
    }
  }
  if (!src) { console.error(`✖ 找不到 ${rel} 的任何可恢复来源（git 历史 + _备份-真源\\ 都没有）`); process.exit(1); }

  let content;
  try { content = fromGit ? gitBin('show', src + ':' + rel) : fs.readFileSync(src); }
  catch (e) { console.error('✖ 读取来源失败：' + e.message); process.exit(1); }

  console.log(`将恢复：${rel}`);
  console.log(`  来源：${srcDesc}`);
  console.log(`  大小：${content.length} 字节`);

  if (dry) { console.log('（--dry：未写入。先去掉 --dry 再执行恢复）'); process.exit(0); }

  /* ★ 2026-10-31（codex B03，已复现）：恢复必须**取同一把库写锁**。
     缺陷：`--restore` 全程没有 acquireLibLock，可以把某个文件恢复成旧版本，
     穿插到另一笔**未提交事务**的内部 —— 而 `_标记复习` 的批改是"先写台账、再写索引"两文件事务：
       ① CLI 持锁，事务已写新台账；② CLI 还没写索引；
       ③ 有人跑 `_快照 --restore _组卷台账.json`，未取锁 → 台账被恢复成旧值、校验通过、报成功；
       ④ CLI 写完新索引并提交 ⇒ 台账旧、索引新，两边都报成功（正是事务要防的半截状态）。
     修法：写盘前取锁（与所有写通道同一把），锁内再复读/校验，退出时释放。
     `--dry` / `--restore-list` 是纯读，不取锁。 */
  const releaseRestoreLock = acquireLibLock(ROOT, { label: '_快照 --restore ' + path.basename(abs) });
  /* 本分支有多处 process.exit()，`finally` 对它是无效的 ⇒ 释放挂 exit 钩子 */
  process.on('exit', () => { try { releaseRestoreLock(); } catch (e) { } });

  /* 安全网 1：恢复前把当前内容留档（万一恢复错，还能退回来）。
   ⚠ 同构校验的**基准必须是"恢复前的正常内容"，不能是"当前这份"** ——
   因为"当前这份"可能正是被写坏的那份（那正是我们要恢复掉的东西）。
   故取 git 里最近一个**可解析**的版本作基准；找不到就退化为"只验合法 JSON"。 */
  let preCopy = null, baseObj = null;
  if (fs.existsSync(abs)) {
    try {
      const bdir = path.join(path.dirname(abs), '_备份-真源');
      fs.mkdirSync(bdir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      preCopy = fs.readFileSync(abs);
      fs.writeFileSync(path.join(bdir, path.basename(abs).replace(/(\.\w+)$/, `-pre-restore-$1`) + '.' + stamp + '.bak'), preCopy);
      console.log('  已把当前内容存进 _备份-真源\\（pre-restore）');
    } catch (e) { console.error('  ⚠ 现内容留档失败：' + e.message); }
  }
  // 同构基准：在 git 历史里往回找第一个能解析的 JSON 版本（跳过被写坏的那些）
  /* ★ 2026-11-04（H3）：**两个基准都要留着**。
     原来的逻辑是"当前内容能解析就用当前内容当基准，否则才翻 git 历史" ——
     这在"当前文件被写坏（解析失败）"时是对的，但漏了一种情况：
     **当前文件能解析、内容却被掏空**（items=[] / batches=[]）。
     此时基准 = 那个空内容 ⇒ 恢复一个同样空的版本 ⇒ 比对"空 vs 空" ⇒ 通过。
     所以现在两件事分开：
       · `baseObj`  = 形状比对的基准（保持原语义，不动，避免破坏既有行为）；
       · `histObj`  = git 历史里最近一个可解析版本（内容比对的基准之一）。
     内容校验用**两者里更"富"的那个**做分母 ⇒ 当前已空、历史不空时也能抓住。 */
  let histObj = null;
  if (/\.json$/i.test(abs)) {
    try {
      const now = JSON.parse(preCopy ? preCopy.toString('utf8').replace(/^\uFEFF/, '') : 'null');
      if (now && typeof now === 'object') baseObj = now;   // 当前内容本身可解析且是对象 ⇒ 可作基准
    } catch { }
    /* ⚠ 2026-11-04（H3）：历史基准要扫**最近 20 版里内容最"富"的那一版**，
       而不是"最近一版"。为什么：最近一版**恰恰可能就是被掏空的那一版**
       （用户正要恢复的就是它）⇒ 拿它当分母 ⇒ "空 vs 空" ⇒ 永远抓不住。
       只在"当前内容已损坏、需要一个形状基准"时才用最近一版（保持原语义）。 */
    const critGuess = CRITICAL_FIELDS_BY_NAME[path.basename(abs)] || [];
    /* ★ 2026-11-04（F04/N4）：richness 同样要认多形态（数组 length / subjects 各科 items 之和），
       否则学生级 _索引.json 的"最富历史版"恒 0 分 ⇒ 内容基准退化为空 ⇒ 掏空抓不住。 */
    const fieldCount = (o, f) => {
      const v = o ? o[f] : undefined;
      if (Array.isArray(v)) return v.length;
      if (v && typeof v === 'object') {
        let n = 0;
        for (const s of Object.values(v)) if (s && Array.isArray(s.items)) n += s.items.length;
        return n;
      }
      return 0;
    };
    const richness = o => {
      if (!o || typeof o !== 'object') return -1;
      let s = 0;
      for (const f of critGuess) s += fieldCount(o, f);
      /* 认不出关键字段的文件：退回"顶层键数"，至少能区分"空对象 vs 有内容" */
      if (!critGuess.length) s = Object.keys(o).length;
      return s;
    };
    let best = null, bestScore = -1;
    for (const h of historyOf(rel).slice(0, 20)) {
      try {
        const o = JSON.parse(gitBin('show', h.full + ':' + rel).toString('utf8').replace(/^\uFEFF/, ''));
        if (!o || typeof o !== 'object') continue;
        if (!histObj) histObj = o;                       // 最近一版（形状基准用）
        const sc = richness(o);
        if (sc > bestScore) { bestScore = sc; best = o; }   // 内容最富的那一版
      } catch { }
    }
    if (!baseObj && histObj) {
      baseObj = histObj;
      console.log('  （同构基准取自历史版本：当前内容已损坏）');
    }
    if (best && bestScore > 0) histObj = best;           // 内容比对用"最富"的那版
  }
  /* ★ 2026-11-05（合并评审 P1-5）：非 JSON 真源（错题记录.md / 题干.html / 收件箱 csv·md / _撤卡留档）的内容基准。
     修前内容校验整段包在 `if (/\.json$/i)` 里 ⇒ 掏空的 md/html **不用 --force-restore 就直接恢复通过**。
     判据（与 JSON 同口径的两档，只是计量单位换成"非空白字符数"）：
       ① 基准非空 ⇒ 恢复后不得为空白；② 恢复后 < 基准的一半 ⇒ 判"缩水过多"。
     基准 = 恢复前内容 与 git 最近 20 版里最大的那一版 中更大者（与 JSON 的"最富历史版"同理）。 */
  if (forceRestore) {
    try { audit({ status: 'attempt', source: srcDesc, bytesBefore: preCopy ? preCopy.length : null, bytesAfter: content.length }); }
    catch (e) { console.error('✖ --force-restore 的审计行写不进去（' + e.message + '），按"先记后做"中止，未恢复任何内容。'); process.exit(1); }
    /* 恢复走到哪一步都要有收尾行：正常结束记 done，校验失败自动退回记 reverted（exit 钩子里写，覆盖所有 process.exit 路径） */
    process.on('exit', (code) => { try { audit({ status: code === 0 ? 'done' : 'reverted', source: srcDesc, exitCode: code }); } catch { } });
  }
  const isText = !/\.json$/i.test(abs);
  const weight = buf => (buf ? buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\s+/g, '').length : 0);
  let textBase = 0;
  if (isText) {
    textBase = weight(preCopy);
    for (const h of historyOf(rel).slice(0, 20)) {
      try { textBase = Math.max(textBase, weight(gitBin('show', h.full + ':' + rel))); } catch { }
    }
  }
  /* 安全网 2：原子写（不半截） */
  writeTextAtomic(abs, content.toString('utf8'));
  if (isText) {
    const nowW = weight(content);
    let why = '';
    if (textBase > 0 && nowW === 0) why = '内容被掏空（基准 ' + textBase + ' 个非空白字符 → 现 0）';
    else if (textBase > 0 && nowW < textBase * 0.5) why = '内容大幅缩水（基准 ' + textBase + ' → 现 ' + nowW + ' 个非空白字符，低于一半）';
    if (why && !forceRestore) {
      console.error('  ✖ 恢复内容未通过校验：' + why + '。若这是**有意**恢复的旧小版本，加 --force-restore --confirm-force=' + path.basename(abs) + '。');
      if (preCopy) {
        try { writeTextAtomic(abs, preCopy); console.error('  ✔ 已自动退回恢复前版本（文件内容已还原）'); }
        catch (e2) { console.error('  ✖ 退回也失败：' + e2.message + '（请手动从 _备份-真源\\ 恢复）'); }
      } else {
        try { fs.unlinkSync(abs); } catch { }
        console.error('  ✔ 恢复前文件不存在，已删除刚写入的版本');
      }
      process.exit(1);
    }
    if (why) console.log('  ⚠ --force-restore：' + why + '，按显式意图放行。');
    else console.log('  ✔ 文本内容校验通过（非空白字符 ' + nowW + (textBase ? ' / 基准 ' + textBase : '') + '）');
  }
  if (forceRestore) console.log('  ⚠ 已记入 _备份-真源\\_强制恢复审计.log（attempt → done/reverted）');
  /* 安全网 3：**同构性**校验 —— 拿"正常的旧内容"当基准，比"损坏的当前内容"当基准合理。
     合法但结构不对的 JSON（如 batches 从数组变成字符串）照样让下游工具炸，
     正是 `_安全写.mjs` 开头警告的"形状漂移"。不一致 ⇒ 判红并**自动退回**。 */
  if (/\.json$/i.test(abs)) {
    try {
      const now = readJsonStrict(abs);
      if (!baseObj) {
        console.log('  ✔ 校验通过（合法 JSON；无可解析的历史基准可比，仅验合法性）');
      } else {
        const sameKind = Array.isArray(baseObj) === Array.isArray(now);
        const bothObj = baseObj && now && typeof baseObj === 'object' && typeof now === 'object' && !Array.isArray(baseObj) && !Array.isArray(now);
        // ★ 键集合 + **每个键的类型**都要一致。
        //   只比键名不够：`{batches:[...]}` 与 `{batches:"..."}` 键名相同但类型不同，
        //   下游照样炸（这正是 BUG-01/02 那种"形状漂移"）。故取类型签名比对。
        const sig = o => Object.keys(o).sort().map(k => k + ':' + (Array.isArray(o[k]) ? 'array' : typeof o[k])).join(',');
        const sameKeys = bothObj ? (sig(baseObj) === sig(now)) : true;
        if (!sameKind || !sameKeys) {
          const desc = !sameKind
            ? `顶层类型变了（基准 ${Array.isArray(baseObj) ? '数组' : typeof baseObj} → 现 ${Array.isArray(now) ? '数组' : typeof now}）`
            : `结构漂移（基准 ${sig(baseObj)} → 现 ${sig(now)}）`;
          throw new Error('形状漂移：' + desc);
        }
        /* ★ 2026-11-04（外部复核实测 H3）：**内容掏空校验**（在同构之上再加一层）。
           原先的同构只比"顶层键名 + 类型"，于是**内容被掏空照样通过**：
             · `_索引.json` 的 items 从 200 条截断成 `[]` —— 仍是 array，类型没变 ⇒ 通过；
             · `_组卷台账.json` 的 batches 被清空 —— 仍是 array ⇒ 通过；
             ⇒ 校验报"通过"并**完成恢复**，把一个空库/空台账当成正常版本写回真源。
           实测三种劣化（清空 / 截断到 1 条 / items 清空）全部报"校验通过"并完成恢复。
           现在加两档：
             ① **关键数组字段不得为空**（除非基准本身也是空）；
             ② **关键计数漂移超阈值 ⇒ 判红并自动退回**（防"少了一半"这种不掏空但缩水的情况）。
           关键字段清单按真源形状定；认不出的文件（不在清单里）只做 ① 的通用兜底
           —— 不认识就**不拦**，但已知的真源必须拦住。 */
        const relBase = path.basename(abs);
        const critFields = CRITICAL_FIELDS_BY_NAME[relBase] || [];
        /* ★ 2026-11-04（F04/N4）：字段条数取**多形态**。_索引.json 有两种合法形态：
           学科级 `items[]`（数组）与学生级 `subjects{学科:{items[]}}`（对象包数组）。
           修前 richness/比对只认 `Array.isArray(o[f])` —— subjects 是对象 ⇒ 永远 0 条，
           subjects 被掏空成 `{}` 时顶层键名与类型都没变、内容循环 continue ⇒ 漏网。
           countOf 统一算：数组直接 length；对象（subjects）= 各学科 items 长度之和。 */
        const countOf = (o, f) => {
          const v = o ? o[f] : undefined;
          if (Array.isArray(v)) return v.length;
          if (v && typeof v === 'object') {
            let n = 0;
            for (const s of Object.values(v)) if (s && Array.isArray(s.items)) n += s.items.length;
            return n;
          }
          return 0;
        };
        /* 内容比对的分母：baseObj（形状基准）与 histObj（git 历史里最近一版）里**更富**的那个。
           为什么要两个：当前文件可能**已经**被掏空（items=[]），此时 baseObj 也是空的，
           拿它当分母 ⇒ "空 vs 空" ⇒ 永远抓不住。histObj 才是"正常内容"的真参照。 */
        const contentBase = (() => {
          if (!histObj) return baseObj;
          if (!baseObj) return histObj;
          let bSum = 0, hSum = 0;
          for (const f of critFields) { bSum += countOf(baseObj, f); hSum += countOf(histObj, f); }
          return hSum > bSum ? histObj : baseObj;
        })();
        if (forceRestore) {
          console.log('  ⚠ --force-restore：跳过掏空/缩水两档内容校验（有意恢复旧小版本或空态）。');
          console.log('    形状守卫与同构校验仍然生效；恢复前内容已留档进 _备份-真源\\。');
        }
        /* ① 关键数组字段：基准非空 ⇒ 现不能为空（subjects 形态按 items 之和算） */
        const emptyCrit = [];
        for (const f of critFields) {
          const bN = countOf(contentBase, f);
          const nN = countOf(now, f);
          if (contentBase[f] === undefined || now[f] === undefined) continue;
          if (bN > 0 && nN === 0) {
            emptyCrit.push(f + '（基准 ' + bN + ' 条 → 现 0 条）');
          }
        }
        if (emptyCrit.length && !forceRestore) {
          throw new Error('内容被掏空：关键字段 ' + emptyCrit.join('、') + ' —— ' +
            '顶层结构没变（仍是数组），但内容全没了；这种版本不能当"正常版本"恢复。' +
            '若这是**有意**恢复的旧小版本/空态，加 --force-restore（内容已留档，可退回）。');
        }
        /* ② 关键计数漂移：现 < 基准 × (1-阈值) ⇒ 判红 */
        const DRIFT_RATIO = 0.5;   // 少于基准的一半 ⇒ 判"缩水过多"
        const driftCrit = [];
        for (const f of critFields) {
          const bN = countOf(contentBase, f);
          const nN = countOf(now, f);
          if (contentBase[f] === undefined || now[f] === undefined) continue;
          if (bN === 0) continue;
          if (nN < bN * DRIFT_RATIO) {
            driftCrit.push(f + '（基准 ' + bN + ' 条 → 现 ' + nN + ' 条）');
          }
        }
        if (driftCrit.length && !forceRestore) {
          throw new Error('内容大幅缩水：关键字段 ' + driftCrit.join('、') +
            '（低于基准的一半）—— 恢复的版本明显不完整。' +
            '若这是**有意**恢复的旧小版本（库后来长了很多），加 --force-restore（内容已留档，可退回）。');
        }
        console.log('  ✔ 同构性校验通过（顶层结构与正常版本一致；关键字段未掏空、未大幅缩水）');
      }
    } catch (e) {
      console.error('  ✖ 恢复内容未通过校验：' + e.message);
      if (preCopy) {
        try { writeTextAtomic(abs, preCopy); console.error('  ✔ 已自动退回恢复前版本（文件内容已还原）'); }
        catch (e2) { console.error('  ✖ 退回也失败：' + e2.message + '（请手动从 _备份-真源\\ 恢复）'); }
      } else console.error('  （无恢复前留档可退回，请人工核对）');
      process.exit(1);
    }
  }
  console.log('✔ 恢复完成：' + rel);
  process.exit(0);
}

if (args.includes('--list')) {
  const cur = git('ls-files', '--', ...DATA_PATHS).split(/\r?\n/).filter(Boolean);
  console.log('本工具纳管的真源模式：');
  for (const p of DATA_PATHS) console.log('  ' + p);
  console.log(`\n当前已入库 ${cur.length} 个文件：`);
  for (const f of cur) console.log('  ' + f);
  process.exit(0);
}
if (args.includes('--status')) {
  const dirty = git('status', '--porcelain', '--', ...DATA_PATHS).split(/\r?\n/).filter(Boolean);
  const log = git('log', '--format=%h %ad %s', '--date=short', '--grep=^data:').trim();
  const n = log ? log.split(/\r?\n/).length : 0;
  console.log(`历史 data: 提交 ${n} 条`);
  if (log) for (const l of log.split(/\r?\n/).slice(0, 5)) console.log('  ' + l);
  console.log(`\n当前未快照的真源改动 ${dirty.length} 个：`);
  for (const l of dirty.slice(0, 20)) console.log('  ' + l);
  process.exit(dirty.length ? 1 : 0);
}

/* 1) 只暂存数据路径（新文件纳入；被 ignore 的自动跳过）。
   ⚠ 2026-11-12 修（本工具自 2026-11-08 起**完全不可用**）：纳管清单里的 glob 允许"当前没有匹配"
   （典型：`_收件箱/**\/_来源映射.csv` —— 收件箱清空后这个文件就不在了），而
   `git add -A -- <pattern>` 对**不匹配的 pathspec 会 fatal 退出 128**：
       fatal: pathspec '_收件箱/**\/_来源映射.csv' did not match any files
   于是 `--dry` / 真跑 / 连 `--list` 之外的一切全挂，数据区连续 4 天拿不到快照回滚点
   （期间 2026-11-08 的一次提交信息自陈"`_快照.mjs` 当前不可用故本次为定向手工提交"）。
   修法：先把模式展开成**实际存在的路径**——`git ls-files` 对不匹配的 pathspec 是**静默返回空**
   （2026-11-12 实测 exit 0、零输出），正好当展开器用——只把展开结果交给 git。
   ⚠ 不要改用 `git add --ignore-unmatch`：**该选项不存在**（实测 git 2.54.0 报 `unknown option`，
   它是 `git rm` / `git checkout` 的选项）。 */
const namedDataPaths = () => [...new Set(
  git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...DATA_PATHS)
    .split('\0').filter(Boolean))];
const NAMED = namedDataPaths();
if (NAMED.length === 0) { console.log('纳管清单当前没有任何文件可暂存（模式全不匹配）。'); process.exit(0); }
gitStdin(nulList(NAMED), 'add', '-A', ...PS_FROM_STDIN);
// 2) 看暂存区里数据路径的变化（diff 不支持 --pathspec-from-file ⇒ 分批，每批 100 条）
const staged = [...batches(NAMED)]
  .map(b => git('diff', '--cached', '--name-status', '--', ...b))
  .filter(Boolean).join('\n');
if (!staged.trim()) { console.log('数据无变化，不必快照。'); process.exit(0); }
const lines = staged.split(/\r?\n/).filter(Boolean);
console.log('将快照 ' + lines.length + ' 个数据文件：');
lines.slice(0, 15).forEach(l => console.log('  ' + l));
if (lines.length > 15) console.log('  …共 ' + lines.length + ' 项');
if (dry) { gitStdin(nulList(NAMED), 'reset', '-q', ...PS_FROM_STDIN); console.log('（--dry：已回退暂存，未提交）'); process.exit(0); }

const d = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
// 提交带路径限定：只落数据路径，用户 index 里其它暂存内容原样保留
gitStdin(nulList(NAMED), 'commit', '-m', 'data: ' + reason + '（快照 ' + stamp + '）', ...PS_FROM_STDIN);
console.log('✔ 已快照提交：' + git('log', '-1', '--format=%h %s').trim());
