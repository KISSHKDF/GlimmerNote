/* 拾光小册 · 阴性对照：**已编译的壳**真的能把选卡参数送进引擎（批次 2）
 *
 * 为什么必须验"编译产物"而不是读源码：本仓的常态事故是"源码改了、exe 还是旧的"
 *   （`tests\verify-shell-parser.mjs` 的文件头就是为这条立的）。批次 1 的教训更具体：
 *   动作在引擎里有、壳没有通道时，页面会**静默**退化（找不到图 → 退回内存查表）。
 *
 * 手法（与 neg-shell-args.mjs 同族，但下沉到真二进制）：
 *   ① 反射加载 `src\app\拾光小册.exe`，`new HostBridge()`，直接调 `Recipe(payload)`；
 *   ② `CTB_DATA` 指向 %TEMP% 临时目录，并在该目录里放一个 `_配方.mjs` **替身**——
 *      `HostBridge.ToolPath()` 的候选③就是 `<DataRoot>\<文件名>`（老布局），
 *      于是壳 spawn 的是替身，替身把**真实收到的 argv** 打成一行 JSON 打回来。
 *      判据因此不是"壳里写了 AddFlag"，而是"**argv 里真有那两个值**"。
 *   ③ 四个场景：形状非法在壳层就被拒 / 组装把逗号串逐项展开成重复 `--card` /
 *      非组装动作**不带**这两个参数 / 白名单外的键被丢弃。
 *
 * 诚实写明：本文件**不做**"掏掉 C# 那段必须变红"的变异自证（那要再编一次壳，代价大且
 *   会动共享源码）；源级映射的变异自证在 `tests\neg-shell-args.mjs`（映射由 5 项变 6 项那条）。
 *   这里证的是它证不了的那一半：**编译产物**的行为。
 *
 * 前置：`src\app\拾光小册.exe` 已编译；缺 exe ⇒ 打印 `RESULT=SKIP(<原因>)`（不静默 exit 0）。
 * 只读仓库与运行区；临时件全在 %TEMP%，跑完删。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const EXE = path.join(REPO, 'src', 'app', '拾光小册.exe');

let pass = 0, fail = 0;
const A = (l, ok, x = '') => { ok ? (pass++, console.log('  [OK]  ' + l + (x ? '  → ' + x : ''))) : (fail++, console.log('  [FAIL] ' + l + (x ? '  → ' + x : ''))); };

if (!fs.existsSync(EXE)) {
  console.log('RESULT=SKIP(未编译 exe：' + EXE + ')');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-shell-card-'));
const lib = path.join(tmp, 'lib');
fs.mkdirSync(lib, { recursive: true });
/* 替身：把收到的 argv 原样回打（探针本体）。LF、无 BOM。 */
const STUB = `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');
`;
fs.writeFileSync(path.join(lib, '_配方.mjs'), STUB, 'utf8');

const CASE = (name, payload) => ({ name, payload: JSON.stringify(payload) });
const cases = [
  CASE('形状非法', {
    action: '组装', recipe: 'ingest-page', subject: '数学',
    cards: 'family-a/shared-stem/shared-stem@1.0.0,../evil/card@1.0.0',
  }),
  CASE('组装两张卡', {
    action: '组装', recipe: 'ingest-page', subject: '数学',
    cards: 'family-a/shared-stem/shared-stem@1.0.0,family-a/b/card-b@2.0.0',
    cardConflict: 'first', json: '1',
  }),
  CASE('非组装动作', {
    action: '指纹', recipe: 'ingest-page', subject: '数学',
    cards: 'family-a/shared-stem/shared-stem@1.0.0', cardConflict: 'first', json: '1',
  }),
  CASE('白名单外键', {
    action: '组装', recipe: 'ingest-page', subject: '数学',
    cards: 'family-a/shared-stem/shared-stem@1.0.0,family-a/b/card-b@2.0.0',
    cardConflict: 'first', json: '1', bogus: '--out ../x.md', out: '../x.md',
  }),
  CASE('把 flag 伪装成卡号', {
    action: '组装', recipe: 'ingest-page', subject: '数学', cards: '--out',
  }),
];

/* PowerPoint 侧只做一件事：设环境变量 → 加载 exe → 反射造对象 → 逐例调用。
   样本用**单引号**PS 字符串（JS 侧把 ' 翻倍），所以 payload 里的双引号是字面量。 */
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const ps = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:CTB_DATA = ${q(lib)}
$asm = [Reflection.Assembly]::LoadFrom(${q(EXE.replace(/\\/g, '/'))})
$t = $asm.GetType('CTBShell2.HostBridge')
if (-not $t) { Write-Output 'TYPE_NOT_FOUND'; exit 1 }
$o = [Activator]::CreateInstance($t)
$m = $t.GetMethod('Recipe')
if (-not $m) { Write-Output 'METHOD_NOT_FOUND'; exit 1 }
${cases.map((c, i) => `Write-Output ('CASE=${i} ${c.name}')
Write-Output ('OUT=' + $m.Invoke($o, @(${q(c.payload)})))`).join('\n')}
`;
const psFile = path.join(tmp, 'reflect.ps1');
fs.writeFileSync(psFile, '\uFEFF' + ps, 'utf8');

const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { encoding: 'utf8' });
const out = String(r.stdout || '') + String(r.stderr || '');
if (/TYPE_NOT_FOUND|METHOD_NOT_FOUND/.test(out)) {
  console.log(out.trim());
  console.log('RESULT=SKIP(反射取不到 CTBShell2.HostBridge.Recipe)');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

const got = [...out.matchAll(/CASE=(\d+) (.+?)\r?\nOUT=(.*)/g)].map((m) => ({ i: Number(m[1]), name: m[2].trim(), raw: m[3].trim() }));
const byName = (n) => got.find((g) => g.name === n);
const env = (g) => { try { return JSON.parse(g.raw); } catch { return null; } };

console.log('═══ 已编译壳：`Recipe()` 的选卡透传（真 argv，不是"看着对"）═══');
A('五个场景都被反射调用到（用例数不是恒真的）', got.length === 5, got.length + ' 个');

const bad = byName('形状非法');
{
  const j = bad ? env(bad) : null;
  A('形状非法的选卡串 ⇒ 壳层直接 code=2（不落到"包不存在"）',
    !!j && j.ok === false && j.code === 2 && /选卡串形状不对/.test(j.err || ''), bad ? bad.raw.slice(0, 160) : 'missing');
  A('错误里点名那一项（可归因，不含糊）', !!j && (j.err || '').includes('../evil/card@1.0.0'), j ? j.err : 'missing');
  A('被拒时**没有**起 node（argv 探针没被打回来）', !!j && (j.out || '') === '', j ? JSON.stringify(j.out) : 'missing');
}

const ok = byName('组装两张卡');
{
  const j = ok ? env(ok) : null;
  const argv = j ? (() => { try { return JSON.parse(j.out.trim()); } catch { return null; } })() : null;
  A('组装 + 两张卡 ⇒ 桥通道成功且引擎退出码 0（探针真被起过）',
    !!j && j.ok === true && j.code === 0 && Array.isArray(argv), ok ? ok.raw.slice(0, 200) : 'missing');
  A('argv 逐字 == 壳声明的固定映射（逗号串展开成**两个** --card，值各占一个 argv 元素）',
    JSON.stringify(argv) === JSON.stringify([
      '组装', '--recipe', 'ingest-page', '--subject', '数学',
      '--card-conflict', 'first',
      '--card', 'family-a/shared-stem/shared-stem@1.0.0',
      '--card', 'family-a/b/card-b@2.0.0',
      '--data', lib, '--json',
    ]), JSON.stringify(argv));
  A('库根仍是壳显式注入的 --data（不靠环境变量继承）',
    Array.isArray(argv) && argv[argv.indexOf('--data') + 1] === lib, Array.isArray(argv) ? String(argv[argv.indexOf('--data') + 1]) : 'missing');
}

const notCompose = byName('非组装动作');
{
  const j = notCompose ? env(notCompose) : null;
  const argv = j ? (() => { try { return JSON.parse(j.out.trim()); } catch { return null; } })() : null;
  A('非组装动作（指纹）⇒ argv 里**没有** --card / --card-conflict（放行会变成静默忽略）',
    Array.isArray(argv) && !argv.includes('--card') && !argv.includes('--card-conflict'), JSON.stringify(argv));
}

const bogus = byName('白名单外键');
{
  const j = bogus ? env(bogus) : null;
  const argv = j ? (() => { try { return JSON.parse(j.out.trim()); } catch { return null; } })() : null;
  const clean = ok ? (() => { try { return JSON.parse(env(ok).out.trim()); } catch { return null; } })() : null;
  A('payload 里的白名单外键（bogus / out）被丢弃：argv 与不带它们时逐字相同',
    !!argv && JSON.stringify(argv) === JSON.stringify(clean), JSON.stringify(argv));
  A('丢弃后 argv 里没有 --out（值进不了 flag 位）', Array.isArray(argv) && !argv.includes('--out'), JSON.stringify(argv));
}

const flagLike = byName('把 flag 伪装成卡号');
{
  const j = flagLike ? env(flagLike) : null;
  A('cards="--out" ⇒ 形状不合法被拒（不是被当成卡号透传）',
    !!j && j.ok === false && j.code === 2 && (j.out || '') === '', flagLike ? flagLike.raw.slice(0, 160) : 'missing');
}

console.log('');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('RESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
