#!/usr/bin/env node
/* 阴性用例（2026-11-04 外部复核实测 P0·Critical）：桌面壳 `src\shell\CTBShellV2.cs` 的**写闸取放配对**。
 *
 * 缺陷（真跑复现，不是读代码猜）：
 *   壳的 `WriteGate`（`SemaphoreSlim(1,1)`）是所有写操作的互斥闸。
 *   原先 **8 个取闸的写操作里有 3 个取闸不放**：`TaskConfirm` / `ReviewCandidate` / `ReviewAdopt`。
 *   ⇒ 一次调用（哪怕它自己以 exit 2 失败、什么也没写）就**永久占住**壳的写闸，
 *     此后组卷/批改/归档/办结/新建学生/修订采用全部排队等 20 分钟
 *     （`WriteGate.Wait(1200000)`）后超时，用户看到的是"点了没反应"，直到重启程序。
 *
 * 为什么它同时解释了两件事：
 *   ① `tests\e2e-ui.mjs` 每次都调 `taskConfirm` ⇒ 每次跑界面回归都把写闸焊死
 *      ⇒ 紧随其后的 `e2e-writepath` 拿不到桥响应 ⇒ `tests\run.mjs full` 恒 exit 3。
 *   ② 它是"用户点一下就把程序写死"的那种缺陷 —— 不是测试问题，是产品问题。
 *
 * 判据（源码级，可机械钉住）：
 *   ① 真源码：**每个** `WriteGate.Wait(` 所在的写操作方法体里，必须有且仅有一次
 *      `WriteGate.Release()`，且**必须挂在 finally 上**（不是正常路径末尾 ——
 *      异常路径不释放 ⇒ 一样会焊死）。
 *   ② 取放**数量**必须相等（8 == 8）。
 *   ③ 阴性自证：把某个方法的 `WriteGate.Release()` 去掉（改回改前形态），
 *      断言集必须变红 —— 证明这些断言抓得住旧缺陷，不是恒真。
 *   ④ 变异自证：把 `finally { WriteGate.Release(); }` 改成**正常路径末尾**的释放
 *      （异常路径不释放）⇒ 也必须变红。
 *
 * 不读不写任何题库文件；纯源码级断言。退出码 0=全绿。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CS_PATH = path.join(REPO, 'src', 'shell', 'CTBShellV2.cs');
const CS = fs.readFileSync(CS_PATH, 'utf8');

let fails = 0, asserts = 0;
const A = (label, ok, detail) => {
  asserts++;
  if (ok) console.log('  ✔ ' + label + (detail ? '  [' + detail + ']' : ''));
  else { fails++; console.log('  ✖ ' + label + '  [' + (detail || '') + ']'); }
};

/* ════════════════════════════════════════════════════════════════════════════
   找出所有取闸的方法：从 `WriteGate.Wait(` 往上找最近的方法头，往下取方法体
   ════════════════════════════════════════════════════════════════════════════ */

/** 取一个写操作方法的完整方法体（含签名行到配对的 } ）——签名可以带参数也可以不带（Rebuild() 无参） */
function methodBody(src, name) {
  const m = new RegExp('public string ' + name + '\\s*\\(([\\w\\s,]*)\\)\\s*\\{').exec(src);
  if (!m) return null;
  const start = m.index;
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return { start, text: src.slice(from, i + 1), textStart: from };
}

/** 去掉注释（判定"代码里有没有"时，注释不算） */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 列出所有取闸的写操作方法名 */
function acquireMethods(src) {
  const out = [];
  const re = /public string (\w+)\s*\(([\w\s,]*)\)/g;
  let m;
  while ((m = re.exec(src))) {
    const body = methodBody(src, m[1]);
    if (!body) continue;
    const code = stripComments(body.text);
    if (/WriteGate\.Wait\(/.test(code)) out.push({ name: m[1], body });
  }
  return out;
}

/* ── 判据集：同一个函数既跑真源码，也跑变异体（③ 靠它证明有牙齿） ── */
function gateChecks(src) {
  const out = [];
  const C = (label, ok, detail) => out.push({ label, ok: !!ok, detail: detail || '' });
  const acq = acquireMethods(src);

  /* ① 每个取闸的方法都必须放闸 */
  const missing = [];
  for (const m of acq) {
    const code = stripComments(m.body.text);
    const hasRelease = /WriteGate\.Release\(\)/.test(code);
    if (!hasRelease) missing.push(m.name);
  }
  C('① 每个取闸的写操作都有 WriteGate.Release()', missing.length === 0,
    missing.length ? '缺：' + missing.join(',') : acq.length + ' 个方法全部已放闸');

  /* ② 释放必须挂在 finally 上（异常路径也要放，否则一样焊死） */
  const notInFinally = [];
  for (const m of acq) {
    const code = stripComments(m.body.text);
    if (!/WriteGate\.Release\(\)/.test(code)) continue;   // ① 已单独判
    /* 取 finally 块：找最后一个 `finally` 后面的 { … } */
    const fi = code.lastIndexOf('finally');
    let inFinally = false;
    if (fi >= 0) {
      const brace = code.indexOf('{', fi);
      if (brace >= 0) {
        let depth = 0, j = brace;
        for (; j < code.length; j++) {
          if (code[j] === '{') depth++;
          else if (code[j] === '}') { depth--; if (depth === 0) break; }
        }
        inFinally = /WriteGate\.Release\(\)/.test(code.slice(brace, j + 1));
      }
    }
    if (!inFinally) notInFinally.push(m.name);
  }
  C('② 释放挂在 finally 上（异常路径也会放）', notInFinally.length === 0,
    notInFinally.length ? '不在 finally：' + notInFinally.join(',') : '全部在 finally');

  /* ③ 取放数量相等 */
  const waits = (stripComments(CS_PATH && src).match(/WriteGate\.Wait\(/g) || []).length;
  const rels = (stripComments(src).match(/WriteGate\.Release\(\)/g) || []).length;
  C('③ 取闸数 == 放闸数', waits === rels, 'Wait=' + waits + ' Release=' + rels);

  /* ④ 取闸数不少于 8（防止有人把写操作整个删掉让断言"平凡成立"） */
  C('④ 取闸的写操作不少于 8 个（防"删掉写操作"式假绿）', waits >= 8, 'Wait=' + waits);

  /* ⑤ 三个已知泄漏点必须都在、且都已修好（点名，防"改个别的"蒙混） */
  for (const n of ['TaskConfirm', 'ReviewCandidate', 'ReviewAdopt']) {
    const b = methodBody(src, n);
    const code = b ? stripComments(b.text) : '';
    C('⑤ ' + n + ' 取了闸也放了闸', !!b && /WriteGate\.Wait\(/.test(code) && /WriteGate\.Release\(\)/.test(code),
      b ? '' : '方法没找到');
  }

  return out;
}

const show = (label, list) => {
  console.log(label);
  for (const c of list) A(c.label, c.ok, c.detail);
};

console.log('══ ① 真源码：写闸取放配对 ══');
const base = gateChecks(CS);
show('  [P0 写闸泄漏]', base);
A('① 断言集在真源码上全绿（作为后面变异体"必须变红"的基线）', base.every(c => c.ok),
  base.filter(c => !c.ok).map(c => c.label).join(' | '));

console.log('\n══ ② 阴性自证：改前形态（TaskConfirm 的 finally 去掉放闸）必须被判红 ══');
{
  const pre = CS
    .replace('            finally { WriteGate.Release(); }\n        }\n\n        /* ★ 2026-11-03（批次 4「审核与正式入库」）',
      '        }\n\n        /* ★ 2026-11-03（批次 4「审核与正式入库」）')
    .replace(/            \/\* ⚠ 2026-11-04（外部复核实测 P0·Critical）：\*\*取闸必须放闸\*\*。[\s\S]*?finally \{ WriteGate\.Release\(\); \}\n        \}/,
      '        }');
  const mutated = pre !== CS;
  A('② 变异锚点命中（TaskConfirm 的 finally 已被摘掉）', mutated,
    mutated ? '' : '锚点没命中——源码形态变了，断言要同步');
  const after = gateChecks(pre);
  const red = after.filter(c => !c.ok).map(c => c.label.split(' ')[0]);
  A('② 断言集**变红**（判据真有牙齿）', red.length > 0, '红=' + red.join(','));
  A('② 至少命中 ①（缺 Release）', red.indexOf('①') >= 0, '红=' + red.join(','));
  A('② 至少命中 ③（取放数不等）', red.indexOf('③') >= 0, '红=' + red.join(','));
}

console.log('\n══ ③ 变异自证：把 finally 里的释放挪到正常路径末尾（异常路径不释放）必须变红 ══');
{
  /* TaskConfirm：把 finally { WriteGate.Release(); } 换成正常路径末尾的 Release() */
  const task = methodBody(CS, 'TaskConfirm');
  const orig = task.text;
  /* 正常路径的 return 行（成功那次）—— 在它前面插 Release()，并删掉 finally */
  const retLine = /(\n\s+return "\{\\"ok\\":true,\\"code\\":" \+ exit[^\n]*\n)/;
  let mutatedText = orig.replace('            finally { WriteGate.Release(); }', '');
  const mret = retLine.exec(mutatedText);
  if (mret) {
    mutatedText = mutatedText.replace(mret[1], '\n                WriteGate.Release();' + mret[1]);
  }
  const mut = CS.slice(0, task.textStart) + mutatedText + CS.slice(task.textStart + orig.length);
  const anchorHit = mut !== CS && /WriteGate\.Release\(\);/.test(mutatedText) && !/finally \{ WriteGate\.Release\(\); \}/.test(mutatedText);
  A('③ 变异锚点命中（释放被挪到正常路径末尾、finally 里不再放）', anchorHit,
    anchorHit ? '' : '替换没生效');
  const after = gateChecks(mut);
  const red = after.filter(c => !c.ok).map(c => c.label.split(' ')[0]);
  A('③ 断言集**变红**（异常路径不放闸同样会焊死，必须被抓住）', red.length > 0, '红=' + red.join(','));
  A('③ 至少命中 ②（不在 finally）', red.indexOf('②') >= 0, '红=' + red.join(','));
}

console.log('\n══ ④ 自证：改前的三个泄漏点**逐个**都能被抓到（不靠"整体红"蒙混）═══');
{
  for (const n of ['TaskConfirm', 'ReviewCandidate', 'ReviewAdopt']) {
    const b = methodBody(CS, n);
    const orig = b.text;
    const mutatedText = orig.replace(/finally\s*\{[^}]*WriteGate\.Release\(\);[^}]*\}/, '')
      .replace(/(\n            \})/, '\n            }');
    /* 把该方法里的 Release 全部摘掉（模拟改前形态） */
    const noRel = orig.replace(/WriteGate\.Release\(\);?/g, '');
    const mut = CS.slice(0, b.textStart) + noRel + CS.slice(b.textStart + orig.length);
    const after = gateChecks(mut);
    const red = after.filter(c => !c.ok).map(c => c.label.split(' ')[0]);
    A('④ 摘掉 ' + n + ' 的放闸后 ① 变红', red.indexOf('①') >= 0, '红=' + red.join(','));
  }
}

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + asserts);
process.exit(fails ? 1 : 0);
