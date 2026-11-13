#!/usr/bin/env node
/**
 * T-19（2026-11-14，方案批次 1-4）：`_体检.mjs` 与 `_web-launcher.mjs` 此前在 tests\ 里
 * **零引用零断言**（grep 只有注释提及）——两个"平时没人跑"的工具，坏了不会有任何门禁红。
 * 本用例把两者的**源码级契约**钉住（不起壳、不占端口、不写真库，全部 %TEMP% 夹具）：
 *
 *   ① `_体检.mjs`（一键体检，只读）：
 *      a) 硬门禁项与进度项是**两个清单**（"系统有病"与"活没干完"不许混报）；
 *      b) 硬门禁里必须有配图/作答契约/安全写底座这三道核心闸（清单被掏空=体检被架空）；
 *      c) 源码里"硬红 → 退出码 1"的链路真实存在（进度红不许影响退出码——它只报工作量）；
 *      d) `--json` 输出形状契约（hard/progress/info/hardBad/progressBad 字段在）。
 *
 *   ② `_web-launcher.mjs`（网页版兜底启动器）：
 *      a) 端口真源读序：CTB_PORT 优先于 端口.json（P2-10 修的缺陷不许回归）；
 *      b) 边界文案是**双向**的：能做什么与不能做什么都要在（只写"能做"不写"不能做"
 *         = 让用户以为网页版是完整版——2026-11-04 事故的根因）；
 *      c) 缺服务端脚本 / 端口真源读不到时 exit 2（失败要响亮，不许静默挂着）；
 *      d) 探活走 /health（30s 上限、400ms 步进）——"起来了吗"的判据是能应答，不是子进程没退；
 *      e) Ctrl+C 带走子进程（SIGINT/SIGTERM 处理器在源码里）——不留孤儿服务端占端口。
 *
 * 用法：node tests\neg-healthcheck-weblauncher.cjs   退出码 0=全过。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = path.resolve(__dirname, '..');
const TIJIAN = path.join(REPO, 'src', 'tools', '_体检.mjs');
const LAUNCHER = path.join(REPO, 'src', 'tools', '_web-launcher.mjs');

let fails = 0, asserts = 0;
const A = (n, ok, d) => { asserts++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 300) : ''}`); if (!ok) fails++; };

const tj = fs.readFileSync(TIJIAN, 'utf8');
const wl = fs.readFileSync(LAUNCHER, 'utf8');

/* ── ① _体检.mjs ─────────────────────────────────────────── */
A('①a 体检源码：硬门禁与进度是两个独立清单（hard/progress 分开收集）',
  /const hard = \[\]/.test(tj) && /const progress = \[\]/.test(tj) &&
  /hard\.push/.test(tj) && /progress\.push/.test(tj));
A('①b 体检硬门禁含三道核心闸：配图 / 作答契约 / 安全写底座（清单被掏空=体检被架空）',
  tj.includes('配图门禁') && tj.includes('作答契约门禁') && tj.includes('安全写底座自检'));
A('①c 体检退出码链路：硬红 → exit 1；只有进度红 → 仍 0（进度是工作量不是故障）',
  /hardBad\s*>\s*0[^;]*\?\s*1\s*:\s*0/.test(tj) || /process\.exit\(.*hardBad/.test(tj) ||
  /hardBad[^]{0,400}exit/.test(tj), (tj.match(/hardBad[^;\n]{0,80}/g) || []).slice(0, 3).join(' | '));
A('①c2 体检源码：进度项不参与退出码（progressBad 只进报告不进 exit 判据）',
  !/process\.exit\([^)]*progressBad/.test(tj));
{
  /* ①d --json 形状：真跑一次（指向一个空的临时假库根——体检各子闸对"空库"的失败
     会落到 hard，但 JSON 信封形状必须完整；这正是要钉的契约）。
     ⚠ _体检.mjs 走兄弟工具跑门禁，真库不可用 ⇒ 本机有真库时用真库跑更接近生产，
       没有真库（干净克隆）时空库跑也必须给出完整信封。 */
  const tmpLib = E.allocTempDir('gn-hc-lib-');
  fs.mkdirSync(path.join(tmpLib, '_原图'), { recursive: true });
  const env = Object.assign({}, process.env, { CTB_DATA: tmpLib });
  let out = '', code = 0;
  try { out = execFileSync(process.execPath, [TIJIAN, '--json'], { encoding: 'utf8', env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { code = e.status == null ? -1 : e.status; out = String(e.stdout || ''); }
  const i = out.indexOf('{');
  let envelope = null, parseErr = '';
  if (i >= 0) { try { envelope = JSON.parse(out.slice(i)); } catch (e) { parseErr = e.message; } }
  A('①d 体检 --json 输出可解析出信封（空假库也必须给完整 JSON，不许半路裸崩）',
    envelope !== null, parseErr || 'hardBad=' + (envelope && envelope.hardBad));
  if (envelope) {
    A('①d2 信封字段齐备：hard/progress/info/hardBad/progressBad',
      Array.isArray(envelope.hard) && Array.isArray(envelope.progress) && Array.isArray(envelope.info) &&
      typeof envelope.hardBad === 'number' && typeof envelope.progressBad === 'number',
      'hard=' + envelope.hard.length + ' progress=' + envelope.progress.length);
    A('①d3 空假库 ⇒ 至少一道硬门禁红（体检不是恒绿橡皮章）',
      envelope.hardBad >= 1 && envelope.hard.some(h => h && h.ok === false));
    A('①d4 退出码非 0（空假库有硬红 ⇒ exit 1，①c 的链路真跑成立）', code !== 0, 'exit=' + code);
  }
}

/* ── ② _web-launcher.mjs ─────────────────────────────────── */
/* ②a：CTB_PORT 检查必须在 readPort() 里、先于任何 端口.json 候选的读取。
   readPort 函数体从声明到 `return null;`（候选循环前的最后一次返回）；
   CTB_PORT 分支整体必须在候选循环开始之前——用 `for (const p of` 的位置判序。 */
{
  const fnStart = wl.indexOf('function readPort()');
  const loopStart = wl.indexOf('for (const p of', fnStart);
  const fnHead = wl.slice(fnStart, loopStart);
  A('②a 启动器端口读序：readPort() 里 CTB_PORT 分支整体先于端口候选循环（P2-10 缺陷不许回归）',
    fnStart >= 0 && loopStart > fnStart && fnHead.includes('CTB_PORT') &&
    fnHead.includes('不是合法端口号'),
    'readPort@' + fnStart + ' loop@' + loopStart);
}
A('②a2 CTB_PORT 非法值拒绝并提示（不是悄悄忽略）',
  /CTB_PORT 不是合法端口号/.test(wl));
A('②b 边界文案双向：能做与不能做都在源码里（只写"能做"=骗人网页版是完整版）',
  wl.includes('能做：') && wl.includes('不能：') && wl.includes('组卷/批改'));
A('②c 缺服务端脚本 / 端口真源读不到 ⇒ exit 2（失败响亮）',
  /process\.exit\(2\)/.test(wl));
A('②c2 探活走 /health（起来了吗=能应答，不是子进程没退）',
  /\/health/.test(wl) && /waitReady/.test(wl));
A('②c3 探活有界：30 秒上限 + 400ms 步进（不许无限等）',
  /30000/.test(wl) && /400/.test(wl));
A('②d Ctrl+C 带走子进程（SIGINT/SIGTERM 处理器在源码里，不留孤儿服务端占端口）',
  /SIGINT/.test(wl) && /SIGTERM/.test(wl) && /child\.kill\(\)/.test(wl));
A('②e 启动器用 stdio inherit 起服务端（受限宿主 pipe 会 EPERM；日志给人看，别吞）',
  /stdio:\s*'inherit'/.test(wl));
/* ②f 真跑缺端口真源分支：把启动器复制到没有 端口.json 的临时目录 ⇒ 必须 exit 2 且说人话。
   （源码级断言证明"写着"，这一条证明"真会"。） */
{
  const tmpTool = E.allocTempDir('gn-hc-wl-');
  fs.mkdirSync(path.join(tmpTool, 'tools'), { recursive: true });
  const copy = path.join(tmpTool, 'tools', '_web-launcher.mjs');
  fs.writeFileSync(copy, wl, 'utf8');
  let code = 0, out = '';
  try { out = execFileSync(process.execPath, [copy], { encoding: 'utf8', timeout: 30000 }); }
  catch (e) { code = e.status == null ? -1 : e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
  A('②f 真跑：无端口真源 ⇒ exit 2（复制到无 端口.json 的临时目录实跑）',
    code === 2, 'exit=' + code + ' ' + out.trim().split(/\r?\n/).filter(l => l.includes('端口')).join(' ').slice(0, 120));
}

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + '  断言=' + asserts + (fails ? ' 失败=' + fails : ''));
process.exit(fails ? 1 : 0);
