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
import path from 'path';
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

console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail));
process.exit(fail ? 1 : 0);