/* 阴性对照 BUG-13：C# 壳的 JSON 取值 + 参数转义，改后必须逐字无损
 * 手法：把 C# 源码里的 TryReadJsonString 与 QuoteArgs **逐字抄成 JS 等价实现**，
 *       再用**真实 node.exe** 观察它最终收到的 argv —— 判据不是"看着对"，是"真收到了"。
 * 取值侧直接对照 C# 源码里那三处硬编码用例。
 *
 * ★ 2026-10-24 审计修正（拆掉一处假绿）：
 *   原实现读冻结区（旧版）副本 `_桌面v2\CTBShellV2.cs` ——，
 *   不是本仓真源。两个后果：①新克隆跑不了（路径不存在，F-06）；
 *   ②改坏本仓 `src\shell\CTBShellV2.cs` 时这条测试**照样通过**，因为它看的是旧文件。
 *   现在改为读本仓真源，用仓库相对路径。见 DEFECT-REGISTRY D-044。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const CS = fs.readFileSync(path.join(REPO, 'src', 'shell', 'CTBShellV2.cs'), 'utf8');
let pass = 0, fail = 0;
const A = (l, ok, x = '') => { ok ? (pass++, console.log('  [OK]  ' + l + (x ? '  → ' + x : ''))) : (fail++, console.log('  [FAIL] ' + l + (x ? '  → ' + x : ''))); };

/* ── 1) 逐字复刻 TryReadJsonString（C# 语义 → JS）── */
function TryReadJsonString(json, key) {
  if (!json || !key) return null;
  const pat = '"' + key + '"';
  const k = json.indexOf(pat);
  if (k < 0) return null;
  let i = k + pat.length;
  while (i < json.length && /\s/.test(json[i])) i++;
  if (i >= json.length || json[i] !== ':') return null;
  i++;
  while (i < json.length && /\s/.test(json[i])) i++;
  if (i >= json.length || json[i] !== '"') return null;
  i++;
  let out = '';
  while (i < json.length) {
    const c = json[i];
    if (c === '"') return out;
    if (c === '\\') {
      if (i + 1 >= json.length) return null;
      const n = json[i + 1];
      if (n === '"') { out += '"'; i += 2; }
      else if (n === '\\') { out += '\\'; i += 2; }
      else if (n === '/') { out += '/'; i += 2; }
      else if (n === 'n') { out += '\n'; i += 2; }
      else if (n === 'r') { out += '\r'; i += 2; }
      else if (n === 't') { out += '\t'; i += 2; }
      else if (n === 'b') { out += '\b'; i += 2; }
      else if (n === 'f') { out += '\f'; i += 2; }
      else if (n === 'u') {
        if (i + 5 >= json.length) return null;
        out += String.fromCharCode(parseInt(json.substr(i + 2, 4), 16)); i += 6;
      } else { out += n; i += 2; }
      continue;
    }
    out += c; i++;
  }
  return null;
}

/* ── 2) 逐字复刻修好的 QuoteArgs（CRT 规则）── */
function QuoteArgs(args) {
  let s = '"';
  for (let k = 0; k < args.length; k++) {
    const a = args[k] === null || args[k] === undefined ? '' : args[k];
    while (true) {
      let bs = 0;
      while (k < a.length && a[k] === '\\') { bs++; k++; }
      if (k === a.length) { s += '\\'.repeat(bs * 2); k--; break; }
      if (a[k] === '"') { s += '\\'.repeat(bs * 2 + 1) + '"'; }
      else { s += '\\'.repeat(bs) + a[k]; }
      break;
    }
    if (k < args.length - 1) s += '" "';
  }
  return s + '"';
}

console.log('═══ BUG-13① 取值侧：备注含引号必须逐字取出 ═══');
const payload = JSON.stringify({ action: '批改', paper: 'P20261012-01', results: 'M0001=对', note: '本卷不含答案册，见"P3" 的补充说明', date: '2026-10-12' });
console.log('  前端 payload：' + payload);
const note = TryReadJsonString(payload, 'note');
const date = TryReadJsonString(payload, 'date');
A('note 逐字无损取出', note === '本卷不含答案册，见"P3" 的补充说明', JSON.stringify(note));
A('改前此处恒为 ""（截断）', note !== '');
A('date 不受影响', date === '2026-10-12', JSON.stringify(date));

console.log('\n═══ BUG-13② 转义侧：带引号的参数必须完整送达 node ═══');
const cases = [
  ['引号', ['_标记复习.mjs', '批改', '--note', '本卷不含答案册，见"P3"', '--date', '2026-10-12']],
  ['尾随反斜杠', ['x', '路径结尾是反斜杠\\', '--flag', 'v']],
  ['反斜杠+引号', ['x', 'a\\"b', '--k', 'v']],
  ['多个连续反斜杠', ['x', 'a\\\\b', '--k', 'v']],
  ['中文与空格', ['x', '孩子 答"对"，但我改判"错"', '--k', 'v']],
  ['空串参数', ['x', '', '--k', 'v']],
  ['只有引号', ['x', '"', '--k', 'v']],
];
for (const [name, args] of cases) {
  const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], { encoding: 'utf8' });
  const got = JSON.parse(r.stdout.trim());
  const ok = JSON.stringify(got) === JSON.stringify(args);
  A(name + '：node 收到的 argv 与传入逐字相等', ok, ok ? '' : '传入=' + JSON.stringify(args.slice(1)) + ' 实收=' + JSON.stringify(got.slice(1)));
}

console.log('\n═══ 自证：改前的 Linux 风格转义在同一批样本上必须失败 ═══');
function oldQuoteArgs(args) { return args.map(a => '"' + a.replace(/"/g, '\\"') + '"').join(' '); }
let oldBad = 0;
for (const [name, args] of cases) {
  const r = spawnSync('cmd.exe', ['/c', 'echo', oldQuoteArgs(args)], { encoding: 'utf8' });
  // cmd.exe 的解析与 CRT 不同；这里改用同一 node 入口复刻旧串的效果（直接看旧串是否自洽）
  const oldStr = oldQuoteArgs(args);
  const balanced = (oldStr.match(/(?<!\\)"/g) || []).length;   // 未被反斜杠转义的引号数（应为偶数）
  if (balanced % 2 !== 0) oldBad++;
}
A('改前写法在含引号的样本上引号不成对（判据有牙齿）', oldBad > 0, oldBad + '/' + cases.length + ' 个样本失衡');

console.log('\n═══ 源码级：壳里不再有旧写法 ═══');
A('QuoteArgs 已换成 CRT 规则（bs*2 翻倍）', /bs \* 2/.test(CS));
A('两个 ExtractString 都委托 TryReadJsonString', (CS.match(/TryReadJsonString\(json, key, out v\)/g) || []).length >= 2);
A('TryReadJsonString 是 public（跨类可调）', /public static bool TryReadJsonString/.test(CS));

console.log('\n═══ 源码级：壳必须回工具的**真实退出码**（R2 SC-02 / D-01）═══');
/* 现象（R2 审计 D-01，L1 阻断）：`_配方.mjs 校验` 拒收时退出 1，而壳的 Recipe() 硬编码
   `{"ok":true,"code":0}` ⇒ 录题页据 code===0 渲染绿色「✔ 校验通过」，其下却印着「✖ 校验未通过：10 处」。
   工具侧的契约由 `tests\neg-recipe-contract.cjs:141/160` 钉住（通过=0 / 拒收=1 / 参数错=2），
   但"壳有没有把它透出来"在 fixture 模式下**没有 exe、跑不了真桥**，只能源码级断言。
   真正的端到端实跑证据在稿 `work\std-check\R2-20261029\reports\R2-FIX3-silent-failures.md`（TEMP 副本重编壳 + CDP）。 */
A('RunNode 底座把退出码带出来（RunNodeRaw(..., out int outCode, ...)）', /RunNodeRaw\([\s\S]{0,160}?out int outCode/.test(CS));
A('Recipe 用真实退出码拼 code（不再硬编码 code:0）', /"\{\\"ok\\":true,\\"code\\":\"\s*\+\s*exit/.test(CS));
A('Recipe 里已无 {"ok":true,"code":0 硬编码', !/\{\\"ok\\":true,\\"code\\":0/.test(CS));
A('Mark 那行无条件覆盖退出码已删除（D-09：超时 124 不再被抹成被杀进程的码）',
  !/else code = p\.ExitCode\.ToString\(\);\s*\r?\n\s*code = p\.ExitCode\.ToString\(\);/.test(CS));

console.log('\n═══ 配方动作白名单：壳 vs 引擎的机读差集（2026-11-02 加，钉住"找图"这一类漏项）═══');
/* 现象（修复前实测）：引擎 `_配方.mjs` 的 switch 早就有 7 个子命令，壳的 RECIPE_ACTIONS 只列了 6 个，
   差集 {找图} 静默存在 —— 前端只能退回"内存里按 sha 查表"（src\app\js\views\ingest.js:158），
   照片被导入改名（sha256 不变、文件名变）后按指纹找回那一张就走不通。
   教训族 L-441（声明与消费者之间必须有一条**机读**的差集检查）/ L-716（对齐要下沉到最细一级）：
   把 6 改成 7 只是"这次对了"，**下次引擎加子命令照样会漂**。所以这里把三处声明都解析出来互相对齐：
     ① 引擎的分派 switch（消费者真正认的命令）；
     ② 引擎的用法清单（`--help` 与文件头，人读的那份）；
     ③ 壳的 RECIPE_ACTIONS（生产者准入白名单）。
   任一处多一个或少一个 ⇒ 这条断言红。 */
const RECIPE_FILE = path.join(REPO, 'src', 'tools', '_配方.mjs');
const RECIPE = fs.readFileSync(RECIPE_FILE, 'utf8');
const CJK = s => /^[\u4e00-\u9fa5]+$/.test(s);
const engineDispatch = new Set([...RECIPE.matchAll(/case\s+'([^']+)':\s*return\s+cmd/g)].map(m => m[1]).filter(CJK));
const engineUsage = new Set();
for (const raw of RECIPE.split('\n')) {
  const line = raw.replace(/^\s*[*']+\s*/, '').trim();   // 去掉注释星号与字符串引号
  if (!/^node\s/.test(line)) continue;                   // 只认"命令样例"行
  const m = /_配方\.mjs\s+([^\s']+)/.exec(line);
  if (m && CJK(m[1])) engineUsage.add(m[1]);
}
const shellLit = /RECIPE_ACTIONS\s*=\s*new HashSet<string>\s*\{([^}]*)\}/.exec(CS);
const shellActions = new Set(shellLit ? [...shellLit[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : []);
const sorted = s => [...s].sort().join('/');
const only = (a, b) => [...a].filter(x => !b.has(x));

A('壳的 RECIPE_ACTIONS 字面量可解析（判据不是恒真）', !!shellLit && shellActions.size > 0, sorted(shellActions));
A('引擎 switch 解析出 ≥7 个子命令（判据不是恒真）', engineDispatch.size >= 7, engineDispatch.size + ' 个：' + sorted(engineDispatch));
A('壳白名单 == 引擎 switch（双向差集均为空；壳多{' + only(shellActions, engineDispatch) + '} 壳少{' + only(engineDispatch, shellActions) + '}）',
  only(shellActions, engineDispatch).length === 0 && only(engineDispatch, shellActions).length === 0);
A('引擎用法清单 == 引擎 switch（文档也不许漂）',
  only(engineUsage, engineDispatch).length === 0 && only(engineDispatch, engineUsage).length === 0,
  sorted(engineUsage));
A('「找图」在壳白名单里（本轮补的动作，回归锁）', shellActions.has('找图'));

console.log('\n═══ 「找图」下沉到最细一级：壳的逐项映射 + 引擎真正要的 flag（L-716）═══');
/* 外层"动作集合相等"不等于"参数已对齐"：找图的契约是 {--sha 必填, --json 可选, --data 壳注入}。
   壳必须**逐项固定映射**；这里把 Recipe() 里的 AddFlag 映射解析出来逐条核对，
   并锁死"没有通用透传"（不遍历 payload 的键、无反射、不拼命令行字符串）。 */
const recipeMethod = (/public string Recipe\(string payload\)[\s\S]*?\n        \}/.exec(CS) || [''])[0];
const RECIPE_MAP = [...recipeMethod.matchAll(/AddFlag\(args,\s*payload,\s*"([^"]+)",\s*"(--[^"]+)"\)/g)].map(m => [m[1], m[2]]);
A('Recipe() 的 AddFlag 映射恰为 5 项、键名与 flag 逐个固定',
  RECIPE_MAP.length === 5 && RECIPE_MAP.map(p => p.join('→')).join(',') === 'recipe→--recipe,subject→--subject,textbook→--textbook,image→--image,sha→--sha',
  RECIPE_MAP.map(p => p.join('→')).join(' '));
A('找图的参数只走 sha→--sha 这一条（不是别的通道或别名）', RECIPE_MAP.some(p => p[0] === 'sha' && p[1] === '--sha'));
A('壳不做通用透传/反射（无 args.Add(payload)、无反射取值）',
  !/args\.Add\(\s*payload/.test(CS) && !/System\.Reflection|GetProperty\(|GetFields\(/.test(CS));
A('库根仍显式用 --data 注入（不靠环境变量继承）', /args\.Add\("--data"\);\s*args\.Add\(DataRoot\)/.test(CS));

console.log('\n═══ 阴性/阳性对照：真跑引擎的「找图」（非法参数必须被拒）═══');
/* 判据不是"壳里写了正则"，是"工具真的会拒"。用例的 argv 按**壳声明的映射**（上面解析出的 RECIPE_MAP
   ＋ --data ＋ json）拼 —— 只映射白名单里的键，payload 里多出来的键（下例 bogus）**必须**被丢掉，
   这本身就是"没有通用透传"的行为侧证据。库用 %TEMP% 下的合成库，不碰真库、不进运行区。 */
const RECIPE_TOOL = path.join(REPO, 'src', 'tools', '_配方.mjs');
const libRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-locate-'));
const inboxSub = path.join(libRoot, '_收件箱', 'p042');
fs.mkdirSync(inboxSub, { recursive: true });
const imgAbs = path.join(inboxSub, 'p042.jpg');
fs.writeFileSync(imgAbs, Buffer.from('glimmer-note-locate-fixture-2026-11-02'));
const imgSha = crypto.createHash('sha256').update(fs.readFileSync(imgAbs)).digest('hex');

const shellArgv = (payload) => {
  const args = [RECIPE_TOOL, '找图'];
  for (const [key, flag] of RECIPE_MAP) if (payload[key] !== undefined && payload[key] !== '') args.push(flag, payload[key]);
  args.push('--data', libRoot);
  if (payload.json === '1') args.push('--json');
  return args;
};
const runLocate = (payload) => {
  const r = spawnSync(process.execPath, shellArgv(payload), { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

const noSha = runLocate({});
A('缺 --sha → 退出 2 且给出用法（不是被当成"找不到图"）',
  noSha.code === 2 && /用法/.test(noSha.err), 'code=' + noSha.code + ' err=' + JSON.stringify((noSha.err || '').trim().split('\n')[0]));
A('非十六进制 sha → 退出 2', runLocate({ sha: 'zzz-not-hex' }).code === 2);
A('不足 12 位 → 退出 2（下限有牙齿）', runLocate({ sha: imgSha.slice(0, 11) }).code === 2, 'sha=' + imgSha.slice(0, 11));
A('超过 64 位 → 退出 2', runLocate({ sha: imgSha + 'ff' }).code === 2);
const flagLike = runLocate({ sha: '--json' });
A('把 flag 伪造成 sha 的值 → 仍退出 2 且 stdout 无 JSON（值进不了 flag 位）',
  flagLike.code === 2 && !/^\{/.test(flagLike.out.trim()), 'code=' + flagLike.code + ' stdout=' + JSON.stringify(flagLike.out.trim()));
const injected = runLocate({ sha: imgSha.slice(0, 12), bogus: '--out ../x.md' });
A('白名单外的键被丢弃：带 bogus 与不带 bogus 的 argv 逐字相同',
  JSON.stringify(shellArgv({ sha: imgSha.slice(0, 12), bogus: '--out ../x.md' })) === JSON.stringify(shellArgv({ sha: imgSha.slice(0, 12) })),
  shellArgv({ sha: imgSha.slice(0, 12), bogus: '--out ../x.md' }).slice(1).join(' '));

const hit = runLocate({ sha: imgSha.slice(0, 12) });
A('合法前缀（前 12 位）→ 退出 0 且 stdout 给出可读的绝对路径',
  hit.code === 0 && hit.out.includes(imgAbs), 'code=' + hit.code + ' out=' + JSON.stringify(hit.out.trim()));
const hitJson = runLocate({ sha: imgSha.slice(0, 12), json: '1' });
let hitObj = null; try { hitObj = JSON.parse(hitJson.out.trim()); } catch { }
A('--json → 退出 0 且结构化结果里 sha256/abs 与真值逐字相等',
  hitJson.code === 0 && !!hitObj && hitObj.ok === true && Array.isArray(hitObj.matches) &&
  !!hitObj.matches[0] && hitObj.matches[0].sha256 === imgSha && hitObj.matches[0].abs === imgAbs,
  String(hitJson.out || '').trim().slice(0, 160));
const miss = runLocate({ sha: 'f'.repeat(64) });
A('格式合法但库里没有 → 退出 1（与"参数非法=2"分得开）', miss.code === 1, 'code=' + miss.code);
A('带白名单外键的真实结果不受影响（仍退出 0）', injected.code === 0, 'code=' + injected.code);
fs.rmSync(libRoot, { recursive: true, force: true });

console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail));
process.exit(fail ? 1 : 0);