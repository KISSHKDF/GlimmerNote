#!/usr/bin/env node
/**
 * 过程件卫生（2026-11-02 批次0尾项）—— 三条都**机器守**，每条都带"故意违反必须红"的判据。
 *
 * 背景（用户 2026-11-02 原话口径："过程件做完就该处理掉"）：
 *   跑一次就产生、删掉不影响任何结果的东西（工单 / 缓存 / 预览 / Edge profile）此前会长期留在盘上：
 *     · 作答工单默认落 `ROOT\_作答工单`（**库根**）⇒ 被 run.mjs 的「真库零写入」判违规，还搅浑用户数据；
 *     · 测试夹具只建不删（`gn-testlib-*` / `gn-synthlib-*` / `gn-libsnap-*` / `ctb-neg-v2-ui-*`
 *       / `ctb-neg-rb-*` / `v2fix-profile-*`）⇒ 实测累积 **418 个目录 / 7.43 GB**，
 *       仓库 `_probe\` 另积 **16 394 文件 / 1.29 GB**。
 *
 * 本用例守的三条判据（与三处改动一一对应）：
 *   ① 工单**默认**落过程目录（`_过程目录.mjs` 的 procPath），显式 `--out` 仍被尊重，且工单动作对库**零写入**；
 *   ② 夹具登记 + `process.on('exit')` 统一切除 + **启动清扫**（死主残留立刻清、活主/新无主绝不误删、非登记前缀一律不碰）；
 *   ③ pagesmoke 的 profile 清理**在 finally 里**，并且 pid 前缀进了清扫表（被 SIGKILL 也有兜底）。
 *
 * 为什么判据要**双向**：只会"清得掉"是不够的 —— 同机并行跑两轮门禁是常态，
 * 一个见目录就删的清扫会把并发那一轮的夹具挖掉（比残留更坏）。所以每条既有"必须删"也有"必须留"。
 *
 * 用法：node tests\neg-proc-hygiene.cjs     退出码 0=判据全部成立；1=有判据不成立。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = path.resolve(__dirname, '..');
const TMP = os.tmpdir();
const GATE = path.join(REPO, 'src', 'tools', '_作答门禁.mjs');
const PAGESMOKE = path.join(REPO, 'tests', 'neg-v2-pagesmoke.cjs');
const ENV_CJS = path.join(REPO, 'tests', '_测试环境.cjs');
const OUT_PS = path.join(REPO, 'tests', 'out', 'neg-v2-pagesmoke.txt');

let fails = 0, asserts = 0;
const A = (n, ok, d) => { asserts++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 400) : ''}`); if (!ok) fails++; };
const J = (v) => JSON.stringify(v);
/* 库的完整快照（相对路径 + 字节 + mtime）：用来证明"工单动作对库零写入" */
function snapDir(dir) {
  const out = new Map();
  (function walk(d, rel) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      let st; try { st = fs.statSync(full); } catch { out.set(r, '?'); continue; }
      out.set(r, st.size + '@' + st.mtimeMs);
    }
  })(dir, '');
  return out;
}
const diffSnap = (a, b) => {
  const diffs = [];
  for (const [k, v] of b) if (a.get(k) !== v) diffs.push('新增/改:' + k);
  for (const [k] of a) if (!b.has(k)) diffs.push('消失:' + k);
  return diffs;
};
/* 跑一个"子进程小脚本"，返回它打印的 JSON（子进程里 require 测试环境） */
function childJson(body) {
  const script = `const E=require(${J(ENV_CJS)});${body}`;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: REPO, env: process.env, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(String(out).trim().split(/\r?\n/).pop());
}
/* 跑 _作答门禁.mjs（工单，只读）：返回 {code,out,err}，绝不抛 */
function runGate(args, extraEnv) {
  try {
    const out = execFileSync(process.execPath, [GATE, ...args], {
      encoding: 'utf8', cwd: REPO, maxBuffer: 32 * 1024 * 1024,
      env: Object.assign({}, process.env, { CTB_DATA: LIBTMP }, extraEnv || {}),
    });
    return { code: 0, out: String(out), err: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
const dirsWithPrefix = (p) => { try { return fs.readdirSync(TMP).filter(n => n.startsWith(p)); } catch { return []; } };
const rmsafe = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { } };

console.log('── ① 作答工单的默认落点：过程目录，不是库根 ──');
/* 副本库：工单动作只读，且**必须**跑在副本上（真库零写入是红线） */
const LIBTMP = E.makeTempLib(null, { copyCardFiles: true });
/* 让工单**真有内容**：在副本里给一张卡多加一个空位（空位数 > 已登记答案数 ⇒ 判不合契约）。
   只在副本上动 —— 真库一个字节不碰；这样"工单文件真写出来了"才是被验到的行为，而不是空跑。 */
function injectNonCompliant(lib) {
  const stems = [];
  (function walk(d, depth) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (fs.existsSync(path.join(full, '题干.html'))) stems.push(path.join(full, '题干.html'));
      if (depth < 3) walk(full, depth + 1);
    }
  })(lib, 0);
  for (const stem of stems) {
    const html = fs.readFileSync(stem, 'utf8');
    if (!/class\s*=\s*["']?blank/.test(html)) continue;      // 只挑本来就有空位的卡
    const extra = '<span class="blank"></span>';
    fs.writeFileSync(stem, /<\/body>/i.test(html) ? html.replace(/<\/body>/i, extra + '</body>') : html + extra, 'utf8');
    return stem;
  }
  return null;
}
const injected = injectNonCompliant(LIBTMP);
console.log('   （副本里注入一张不合契约的卡：' + (injected ? path.relative(LIBTMP, injected) : '没有可注入的卡') + '）');
const gateSrc = fs.readFileSync(GATE, 'utf8');
A('①a 源码：默认落点是过程目录 procPath(\'作答工单\')', /procPath\('作答工单'\)/.test(gateSrc), GATE);
A('①b 源码：库里不再有 ROOT\\_作答工单 落点', !/path\.join\(ROOT,\s*'_作答工单'\)/.test(gateSrc));
const before = snapDir(LIBTMP);
const PROC1 = E.allocTempDir('gn-testlib-');     // 模拟 GLIMMERNOTE_PROC 指向的过程目录
const r1 = runGate(['工单'], { GLIMMERNOTE_PROC: PROC1 });
const gen1 = (r1.out.match(/已生成\s*(\d+)\s*份工单/) || [])[1];
A('①c 默认落点 = 过程目录（<proc>\\作答工单 存在）', fs.existsSync(path.join(PROC1, '作答工单')), 'exit=' + r1.code + ' ' + r1.out.trim().split(/\r?\n/).pop());
A('①d 库根里**没有** _作答工单（工单不再是库里的东西）', !fs.existsSync(path.join(LIBTMP, '_作答工单')), LIBTMP);
A('①e 工具自报的落点就是过程目录', r1.out.includes(PROC1), '已生成=' + gen1);
const OUT2 = E.allocTempDir('gn-testlib-');
const PROC2 = path.join(E.allocTempDir('gn-testlib-'), 'proc');   // 另起一个过程目录，验证 --out 不落它
const r2 = runGate(['工单', '--out', OUT2], { GLIMMERNOTE_PROC: PROC2 });
const gen2 = (r2.out.match(/已生成\s*(\d+)\s*份工单/) || [])[1];
const nJson = fs.existsSync(OUT2) ? fs.readdirSync(OUT2).filter(n => n.endsWith('.json')).length : -1;
A('①f 显式 --out 仍被尊重（落指定目录，不落过程目录）', fs.existsSync(OUT2) && !fs.existsSync(path.join(PROC2, '作答工单')), OUT2);
A('①g --out 的工单文件数与工具自报一致', String(nJson) === String(gen2), '自报=' + gen2 + ' 实际=' + nJson);
A('①g2 注入的不合契约卡真进了工单（工单内容非空，不是空跑）', !injected || Number(gen2) >= 1, '已生成=' + gen2);
A('①h 工单动作对库**零写入**（真源一个字节没动）', diffSnap(before, snapDir(LIBTMP)).length === 0, diffSnap(before, snapDir(LIBTMP)).join('、'));
A('①i 工单**只**落过程目录/指定目录，库根没多出任何东西', !fs.existsSync(path.join(LIBTMP, '_作答工单')) && diffSnap(before, snapDir(LIBTMP)).length === 0);

console.log('\n── ② 夹具：登记 + 退出统一切除 + 启动清扫（双向判据）──');
/* ②a/②b：子进程正常退出 ⇒ 它建的夹具必须被 exit 钩子删干净 */
const c1 = childJson(`const d=E.makeTempLib();console.log(JSON.stringify({d,pid:process.pid}));`);
A('②a 子进程正常退出：makeTempLib() 的临时库被删净（改前永久残留）', !fs.existsSync(c1.d), c1.d);
const c2 = childJson(`const fs=require('fs'),path=require('path');const d=E.allocTempDir('gn-testlib-');fs.writeFileSync(path.join(d,'x.bin'),'x');console.log(JSON.stringify({d,pid:process.pid}));`);
A('②b 子进程正常退出：allocTempDir() 的夹具（含文件）被删净', !fs.existsSync(c2.d), c2.d);
A('②c allocTempDir 的目录名带 pid（被 SIGKILL 后下一轮才认得出"主已死"）', path.basename(c2.d).includes('-' + c2.pid + '-'), path.basename(c2.d));
/* ②d：死主残留 ⇒ 启动清扫立刻清（这是 exit 钩子覆盖不到的路径：SIGKILL / 任务管理器结束） */
const deadDir = fs.mkdtempSync(path.join(TMP, 'gn-testlib-' + c1.pid + '-'));
const s1 = E.sweepStaleTempDirs();
A('②d 死主残留（崩溃/被杀的夹具）⇒ 启动清扫立刻清掉', !fs.existsSync(deadDir) && s1.removed.includes(path.basename(deadDir)), path.basename(deadDir));
/* ②e：活主 ⇒ 绝不许删（同机并行两轮门禁是常态） */
const liveDir = fs.mkdtempSync(path.join(TMP, 'gn-testlib-' + process.pid + '-'));
const s2 = E.sweepStaleTempDirs();
A('②e 活主（并发在跑的那一轮）⇒ 清扫绝不删', fs.existsSync(liveDir) && s2.kept.includes(path.basename(liveDir)), path.basename(liveDir));
rmsafe(liveDir);
/* ②f：无主但很新 ⇒ 留（老式夹具/别人的；保守方向） */
const freshNoPid = fs.mkdtempSync(path.join(TMP, 'gn-synthlib-'));
E.sweepStaleTempDirs();
A('②f 无主但很新 ⇒ 留着（不冒进）', fs.existsSync(freshNoPid), path.basename(freshNoPid));
rmsafe(freshNoPid);
/* ②g：无主且陈旧（>24h）⇒ 清（老式残留的兜底） */
const oldNoPid = fs.mkdtempSync(path.join(TMP, 'gn-synthlib-'));
const old = new Date(Date.now() - (E.TMP_STALE_MS + 3600 * 1000));
fs.utimesSync(oldNoPid, old, old);
const s3 = E.sweepStaleTempDirs();
A('②g 无主且陈旧（>24h 的老式残留）⇒ 清掉', !fs.existsSync(oldNoPid) && s3.removed.includes(path.basename(oldNoPid)), path.basename(oldNoPid));
/* ②h：非登记前缀 ⇒ 一律不碰（清扫绝不做通配删除） */
const stranger = fs.mkdtempSync(path.join(TMP, 'gn-not-registered-'));
fs.utimesSync(stranger, old, old);
const s4 = E.sweepStaleTempDirs();
A('②h 非登记前缀（哪怕又老又无主）⇒ 一律不碰', fs.existsSync(stranger) && !s4.removed.includes(path.basename(stranger)), path.basename(stranger));
rmsafe(stranger);
/* ②i：本轮自己登记的、名字里**没有** pid 的夹具（如物化库）⇒ 清扫不许碰（否则会在半路把正在用的库挖掉） */
const ownNoPid = fs.mkdtempSync(path.join(TMP, 'gn-synthlib-'));
E.registerTempDir(ownNoPid);
fs.utimesSync(ownNoPid, old, old);
E.sweepStaleTempDirs();
A('②i 本轮登记的无 pid 夹具（如物化库）⇒ 清扫不碰，交给退出钩子', fs.existsSync(ownNoPid), path.basename(ownNoPid));
rmsafe(ownNoPid);

console.log('\n── ③ pagesmoke：清理必须在 finally（被杀也有兜底）──');
const psSrc = fs.readFileSync(PAGESMOKE, 'utf8');
const finIdx = psSrc.lastIndexOf('} finally {');
const cleanCall = psSrc.indexOf('rmProfileEventually(profile)');
A('③a 源码：profile 的清理只出现在 finally 块内', finIdx > 0 && cleanCall > finIdx && psSrc.indexOf('rmProfileEventually(profile)', cleanCall + 1) === -1 && !/fs\.rmSync\(profile/.test(psSrc), 'finally@' + finIdx + ' 清理@' + cleanCall);
A('③a2 源码：清理是"重试到真没了"，不是调一次就算数（Edge 句柄不会立刻释放）', /async function rmProfileEventually/.test(psSrc) && /for \(let i = 0; i < 10; i\+\+\)/.test(psSrc));
A('③b 源码：profile 不再落仓库 _probe\\（过程件不落库/仓库）', !/'_probe'/.test(psSrc));
A('③c 源码：profile 经 E.allocTempDir 登记（前缀带 pid，可被清扫认出主已死）', /E\.allocTempDir\('v2fix-profile-'\)/.test(psSrc));
A('③d 清扫表覆盖 pagesmoke 的 profile 前缀 v2fix-profile-', E.TMP_PREFIXES.includes('v2fix-profile-'));
/* ③i（2026-11-14 T-05 全量清账，方案批次 1-4）：**清扫表覆盖全部实际前缀**——机械对账。
 *  11-02 立的"新用例必须登记前缀"纪律到 11-14 实际漂移成 71 个前缀里 62 个没登记
 *  （11-02 那次 8.3 GB 残留正是这么漏的）——纪律没有牙齿。本断言把纪律变成门禁：
 *  全仓 grep mkdtemp 提取前缀字面量，逐个必须出现在 E.TMP_PREFIXES。
 *  唯一豁免 `gn-not-registered-`（②h 的阴性对照专用前缀：它存在的意义就是"证明没登记的不碰"）。
 *  注意本断言的 grep 不包含本文件自己拼 `gn-not-registered-` 之外动态生成的前缀——
 *  mkdtemp 前缀一律是字面量（登记表设计的前提），动态拼前缀会让 ②h 的"非登记前缀"判据失效。 */
const PREFIX_EXEMPT = new Set(['gn-not-registered-']);
{
  const greps = ['src/', 'tests/', 'tools/'];
  const actual = new Set();
  for (const d of greps) {
    let out = '';
    try { out = execFileSync('git', ['grep', '-h', 'mkdtemp', '--', d], { encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    for (const m of out.matchAll(/mkdtemp(?:Sync)?\([^;\r\n]*?['"]([^'"]{2,40})['"]/g)) actual.add(m[1]);
  }
  const table = new Set(E.TMP_PREFIXES);
  const missing = [...actual].filter(p => !table.has(p) && !PREFIX_EXEMPT.has(p));
  A('③i 清扫表覆盖全仓全部 mkdtemp 前缀（豁免仅阴性对照 gn-not-registered-）',
    missing.length === 0, missing.length ? '未登记：' + missing.join('、') : actual.size + ' 个前缀全覆盖');
  A('③ii mkdtemp 前缀一律是字面量（登记表设计前提；动态拼接会让"非登记前缀"判据失效）',
    [...actual].every(p => /^[a-z][a-z0-9-]*-$/.test(p)), actual.size + ' 个前缀全部匹配字面量形状');
}
/* ③e/③f：真跑一次 pagesmoke，逼它走**异常**路径（服务端不可达 + CDP 1ms 超时）——
   正常路径下 finally 与旧代码都会清；只有异常路径能分辨"清理在不在 finally"。
   ⚠ 它会覆写 tests\out\neg-v2-pagesmoke.txt（那是真 pagesmoke 用例的证据），跑完原样还回去。 */
const psOutBak = fs.existsSync(OUT_PS) ? fs.readFileSync(OUT_PS) : null;
const probeDir = path.join(REPO, '_probe');
const probeProfiles = () => { try { return fs.readdirSync(probeDir).filter(n => n.startsWith('v2fix-profile-')); } catch { return []; } };
const beforeProfiles = dirsWithPrefix('v2fix-profile-');
let ps;
try {
  const o = execFileSync(process.execPath, [PAGESMOKE], {
    encoding: 'utf8', cwd: REPO, maxBuffer: 32 * 1024 * 1024, timeout: 180000,
    env: Object.assign({}, process.env, { CTB_SRV: 'http://127.0.0.1:1', CTB_CDP_TIMEOUT: '1' }),
  });
  ps = { code: 0, out: String(o), err: '' };
} catch (e) {
  ps = { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
}
const leftover = dirsWithPrefix('v2fix-profile-').filter(d => !beforeProfiles.includes(d));
const psTxt = fs.existsSync(OUT_PS) ? fs.readFileSync(OUT_PS, 'utf8') : '';
const edgeMissing = !/RESULT=/.test(psTxt) && /ENOENT|not recognized|不是内部或外部命令/i.test(ps.out + ps.err);
A('③e 真跑一次后仓库 _probe\\ 里没有 v2fix-profile-*（profile 不落仓库）', probeProfiles().length === 0, probeProfiles().join(' ') || '<none>');
A('③f 异常退出（服务端不可达 + CDP 1ms 超时）时 profile 仍被删净（改前会留在盘上）', leftover.length === 0, leftover.join(' '));
if (edgeMissing) {
  console.log('[SKIP] ③g 本机没有 headless Edge（spawn ENOENT，进程被未捕获异常终止）⇒ 只验"删净"，不验 RESULT 行');
} else {
  A('③g 退出码非 0（确实走的异常路径，不是"跑绿了所以干净"）', ps.code !== 0, 'exit=' + ps.code + ' ' + (ps.out.trim().split(/\r?\n/).pop() || ''));
  A('③h RESULT 行挪进 finally：异常路径也在 tests\\out 留下结论', /RESULT=/.test(psTxt), (psTxt.match(/RESULT=.*/) || [''])[0]);
}
if (psOutBak) fs.writeFileSync(OUT_PS, psOutBak); else rmsafe(OUT_PS);

/* ②j 收尾：cleanupTempDirs() 真删自己登记的全部夹具（跑在最后，前面用到的副本库该收就收） */
const owned = E.allocTempDir('gn-testlib-');
E.cleanupTempDirs();
A('②j cleanupTempDirs() 真删掉本轮登记的全部夹具', !fs.existsSync(owned), owned);

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + '  断言=' + asserts + (fails ? ' 失败=' + fails : ''));
process.exit(fails ? 1 : 0);
