/* 用反射直接调**已编译的** 拾光小册.exe 里的 ParseResults，证明修复真的进了二进制。
 * 这不是"读源码看着对"——壳是编译产物，源码对而 exe 旧是这类事故的常态。
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/* ★ 2026-10-23 搬进开发区时的护栏（原为写死的真库绝对路径）：
   ROOT 从自身位置上溯；并拒绝指向「错题本」冻结区的路径——本文件虽只读 exe，
   但"去冻结区取二进制"会让开发区测试永远在验旧程序，等于假绿。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (/(^|[\\/])错题本([\\/]|$)/.test(ROOT)) {
  console.error('✖ 拒绝运行：ROOT 指向冻结区 → ' + ROOT);
  process.exit(2);
}
const EXE = path.join(ROOT, 'src', 'app', '拾光小册.exe');

/* ⚠ 样本里必须放**真字符**（✔ ↔ ✖）：PowerShell 单引号字符串不解释 \u 转义，
   写成 '\u2714' 会变成字面的六个字符，壳的解析器当然认不出——那是测试自己的 bug。 */
const ps = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$asm = [Reflection.Assembly]::LoadFrom('EXE_PATH')
$t = $asm.GetType('CTBShell2.HostBridge')
if (-not $t) { Write-Output 'TYPE_NOT_FOUND'; exit 1 }
$m = $t.GetMethod('ParseResults', [Reflection.BindingFlags]'NonPublic,Static')
if (-not $m) { Write-Output 'METHOD_NOT_FOUND'; exit 1 }
$samples = @(
  '  ✔ T196 → 已确认：在题目编号上打了斜线',
  '  ↔ T192：已是「已作废」（旧条目），跳过',
  '  ✖ T999：台账中不存在',
  '同步完成：落库 1，跳过 0，未找到 0',
  '  ✔ T045 → 已确认：x',
  '  ✔ T1234 → 已确认：四位编号'
)
foreach ($s in $samples) {
  $r = $m.Invoke($null, @($s))
  Write-Output ('IN=' + $s)
  Write-Output ('OUT=' + $r)
}
`.replace('EXE_PATH', EXE.replace(/\\/g, '/'));

const tmp = path.join(os.tmpdir(), 'ctb-reflect-' + Date.now() + '.ps1');
fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8');
const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { encoding: 'utf8' });
fs.unlinkSync(tmp);

const out = String(r.stdout || '') + String(r.stderr || '');
console.log(out.trim());

/* 断言：T196/T1234 必须被识别，汇总行必须被跳过 */
const outs = [...out.matchAll(/IN=(.+)\r?\nOUT=(.*)/g)].map(m => ({ in: m[1].trim(), out: m[2].trim() }));
let fail = 0;
const A = (l, ok, d = '') => { console.log((ok ? '  [OK]  ' : '  [FAIL] ') + l + (d ? '  → ' + d : '')); if (!ok) fail++; };

const find = s => outs.find(o => o.in.includes(s));
A('已编译 exe 里 ParseResults 可反射调用', outs.length === 6, outs.length + ' 条样本');
const t196 = find('T196');
A('T196（T1xx，改前解析器扫不到）被识别为 ok',
  !!t196 && /"id":"T196"/.test(t196.out) && /"status":"ok"/.test(t196.out), t196 ? t196.out : 'missing');
const t192 = find('T192');
A('T192 的「↔ 已作废」被识别为 skipped',
  !!t192 && /"status":"skipped"/.test(t192.out), t192 ? t192.out : 'missing');
const t999 = find('T999');
A('T999 的「✖」被识别为 missing', !!t999 && /"status":"missing"/.test(t999.out), t999 ? t999.out : 'missing');
const t045 = find('T045');
A('T045（旧解析器本来就能认）仍然 ok', !!t045 && /"id":"T045"/.test(t045.out), t045 ? t045.out : 'missing');
const t1234 = find('T1234');
A('T1234（四位编号）被识别', !!t1234 && /"id":"T1234"/.test(t1234.out), t1234 ? t1234.out : 'missing');
const summary = find('同步完成');
/* 汇总行的 OUT 必须是空数组 `[]`（= 没有产出任何结果行）。
   ⚠ 别写成 `!summary`：find() 找不到样本时返回 undefined，那样这条断言恒真、没有牙齿；
   ⚠ 也别写成"样本不在 outs 里"：壳对每一行都调用 ParseResults，汇总行会有 OUT 行，只是内容为空。 */
const summaryOut = summary ? summary.out : '(缺样本)';
A('汇总行不产出结果（OUT 必须是空数组）', summaryOut === '[]', summaryOut);

console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + 7);
process.exit(fail ? 1 : 0);
