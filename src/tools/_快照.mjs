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
import { readJsonStrict, writeTextAtomic } from './_安全写.mjs';
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
  node _快照.mjs --restore <文件> [版本]        恢复该真源（默认最近一版），恢复前自动备份`;

const FLAGS = ['--dry', '--list', '--status', '--restore', '--restore-list'];
const unknown = args.filter(a => a.startsWith('--') && !FLAGS.includes(a));
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
   自检：tests\gate-contracts 不覆盖此项，故在本文件底部给出 `--list` 打印实际纳管清单。 */
const DATA_PATHS = [
  '*_索引.json', '_待确认.json', '_组卷台账.json', '_配图台账.json',
  '_原卷台账.json', '_盲解双路.json', '_笔形台账.json',
  '*错题记录.md', '*题干.html', '_词表.md',
  '_撤卡留档/**',
];

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 64e6 });
const gitBin = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'buffer', maxBuffer: 256e6 });

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
  const rel = normalizeTarget(positional[0]);
  const ver = positional[1] || null;         // 可选：git short/full hash
  if (!rel) { console.error(USAGE); process.exit(2); }
  const abs = path.join(ROOT, rel);

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
  if (/\.json$/i.test(abs)) {
    try {
      const now = JSON.parse(preCopy ? preCopy.toString('utf8').replace(/^\uFEFF/, '') : 'null');
      if (now && typeof now === 'object') baseObj = now;   // 当前内容本身可解析且是对象 ⇒ 可作基准
    } catch { }
    if (!baseObj) {
      for (const h of historyOf(rel).slice(0, 20)) {
        try {
          const o = JSON.parse(gitBin('show', h.full + ':' + rel).toString('utf8').replace(/^\uFEFF/, ''));
          if (o && typeof o === 'object') { baseObj = o; console.log('  （同构基准取自历史版本 ' + h.short + '：当前内容已损坏）'); break; }
        } catch { }
      }
    }
  }
  /* 安全网 2：原子写（不半截） */
  writeTextAtomic(abs, content.toString('utf8'));
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
        console.log('  ✔ 同构性校验通过（顶层结构与正常版本一致）');
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

// 1) 只暂存数据路径（新文件纳入；被 ignore 的自动跳过）
git('add', '-A', '--', ...DATA_PATHS);
// 2) 看暂存区里数据路径的变化
const staged = git('diff', '--cached', '--name-status', '--', ...DATA_PATHS);
if (!staged.trim()) { console.log('数据无变化，不必快照。'); process.exit(0); }
const lines = staged.split(/\r?\n/).filter(Boolean);
console.log('将快照 ' + lines.length + ' 个数据文件：');
lines.slice(0, 15).forEach(l => console.log('  ' + l));
if (lines.length > 15) console.log('  …共 ' + lines.length + ' 项');
if (dry) { git('reset', '-q', '--', ...DATA_PATHS); console.log('（--dry：已回退暂存，未提交）'); process.exit(0); }

const d = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
// 提交带路径限定：只落数据路径，用户 index 里其它暂存内容原样保留
git('commit', '-m', 'data: ' + reason + '（快照 ' + stamp + '）', '--', ...DATA_PATHS);
console.log('✔ 已快照提交：' + git('log', '-1', '--format=%h %s').trim());
