#!/usr/bin/env node
/* 分片往返（审计 §4 缺口清单第 1 条 / F-01）：把 `src\shell\CTBShellV2.cs` 的 `SplitByByteBudget`
   同构复现成 JS，注入 emoji / 代理对 / 中文 / 末尾单字符，断言**所有分片拼起来逐字符等于原文**。

   两层断言（对齐 tests\gates-contract.mjs --selftest 的"断言自己会红"纪律）：
     ① 同构复现：本文件的 splitByByteBudget 与 C# 侧逐行同构（同一条"字节预算 + 不切代理对"逻辑）；
     ② 有牙齿自证：同一组样本喂给**旧算法**（`len--` 之后游标仍按原片长前进）必须红——
        否则说明样本没踩到缺陷，断言不算数（旧算法文本取自 _probe\audit-chunk.cjs 的 simulate）。

   退出码 0=全绿；非 0=有断言红了。不读不写任何题库文件。 */
'use strict';

const MSG_LIMIT_BYTES = 256 * 1024;   // 与 C# `ShellForm.MSG_LIMIT_BYTES` 同值
const OLD_MSG_LIMIT = 700 * 1024;     // 旧实现的字符口径（审计实测的那个 700KB）

let fails = 0, asserts = 0;
const A = (name, cond, detail) => {
  asserts++;
  if (cond) { console.log('  ✔ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fails++; console.log('  ✖ ' + name + '  [' + (detail || '') + ']'); }
};

/* ---------- 唯一实现（C# SplitByByteBudget 的同构版） ---------- */
function splitByByteBudget(s, byteBudget) {
  const parts = [];
  if (s == null) return parts;
  if (s.length === 0) { parts.push(''); return parts; }
  let pos = 0;
  while (pos < s.length) {
    let len = 0, used = 0;
    while (pos + len < s.length) {
      const c = s.charCodeAt(pos + len);
      const pair = c >= 0xD800 && c <= 0xDBFF && pos + len + 1 < s.length &&
        s.charCodeAt(pos + len + 1) >= 0xDC00 && s.charCodeAt(pos + len + 1) <= 0xDFFF;
      const cb = pair ? 4 : ((c >= 0xD800 && c <= 0xDFFF) ? 3 : (c < 0x80 ? 1 : (c < 0x800 ? 2 : 3)));
      if (len > 0 && used + cb > byteBudget) break;   // 满片即止；len==0 时至少收 1 个字符 ⇒ 游标必前进
      used += cb;
      len += pair ? 2 : 1;
    }
    parts.push(s.substr(pos, len));
    pos += len;
  }
  return parts;
}

/* ---------- 旧算法（审计复现的那版；仅用于自证本测试有牙齿） ---------- */
const IsHigh = ch => ch.charCodeAt(0) >= 0xD800 && ch.charCodeAt(0) <= 0xDBFF;
function oldSplit(resp, limit) {
  const L = resp.length;
  if (L <= limit) return { n: 1, parts: [resp], sent: L, complete: true, dropped: 0 };
  const n = Math.ceil(L / limit);
  const parts = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    let len = Math.min(limit, L - pos);
    if (pos + len < L && IsHigh(resp[pos + len - 1])) len--;   // ← 缺陷：len-- 后 pos 仍 += len（少发 1）
    parts.push(resp.substr(pos, len));
    pos += len;
  }
  return { n, parts, sent: pos, complete: pos === L, dropped: L - pos };
}

/* ---------- 消费者（v2\js\host.js:24-35 重组判定的同构版） ---------- */
function reassembleViaHost(parts) {
  const p = { n: parts.length, got: 0, buf: [] };
  for (let i = 0; i < parts.length; i++) { if (!p.buf[i]) p.got++; p.buf[i] = parts[i]; }
  if (p.got !== p.n) return { ok: false, reason: '未收齐 got=' + p.got + '/' + p.n };
  try { return { ok: true, value: JSON.parse(p.buf.join('')) }; }
  catch (e) { return { ok: false, reason: 'JSON.parse: ' + e.message }; }
}

/* 逐字符（UTF-16 码元）比对，返回差异位置，用于"逐字符相等"的显式证据 */
function diffAt(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  return a.length === b.length ? -1 : n;
}

/* 一个样本的完整体检 */
function checkCase(label, s, budget) {
  const parts = splitByByteBudget(s, budget);
  const joined = parts.join('');
  const d = diffAt(joined, s);
  const maxBytes = Math.max(...parts.map(p => Buffer.byteLength(p, 'utf8')));
  const over = parts.filter(p => Buffer.byteLength(p, 'utf8') > Math.max(budget, 4)).length;
  /* 只有"上一片末尾是高位代理 **且** 下一片开头是低位代理"才算真的把一个代理对切成了两半；
     输入自身本来就有不成对的孤代理时，边界落在那儿不算切（否则断言会冤枉正确实现） */
  const isHigh = c => c >= 0xD800 && c <= 0xDBFF, isLow = c => c >= 0xDC00 && c <= 0xDFFF;
  const badEdge = parts.filter((p, i) => i > 0 && p.length > 0 && parts[i - 1].length > 0 &&
    isHigh(parts[i - 1].charCodeAt(parts[i - 1].length - 1)) && isLow(p.charCodeAt(0))).length;
  const empty = parts.filter(p => p.length === 0).length;
  A(label + ' · 拼回逐字符相等', d === -1,
    'L=' + s.length + ' 片数=' + parts.length + ' 首处差异=' + (d === -1 ? '无' : d) +
    ' 最坏片字节=' + maxBytes + ' 预算=' + budget);
  A(label + ' · 无空片/无超预算片/无被切断的代理对', empty === 0 && over === 0 && badEdge === 0,
    '空片=' + empty + ' 超预算=' + over + ' 切断代理对=' + badEdge);
  return { parts, joined, maxBytes };
}

console.log('══ ① 同构复现：新算法必须逐字符往返 ══');

/* 用例 1：审计的构造样本（切点正落在一个 emoji 的高位代理上） */
{
  const L = 2 * OLD_MSG_LIMIT;
  const a = 'a'.repeat(OLD_MSG_LIMIT - 1) + '\uD83D\uDE00';
  const s = a + 'b'.repeat(L - a.length);
  console.log('[1] 审计样本 L=' + s.length + '（切点落在 emoji 高位代理上）');
  checkCase('审计样本', s, MSG_LIMIT_BYTES);
}

/* 用例 2：中文 + emoji 混合 + 末尾单字符（长度 = k*预算 + 1） */
{
  const unit = '错题本😀复盘\uD83D\uDE00ABC题图';
  let s = '';
  while (Buffer.byteLength(s, 'utf8') < MSG_LIMIT_BYTES * 2) s += unit;
  s = s.slice(0, s.length - 1) + '尾';   // 末尾单字符
  console.log('[2] 中文+emoji 混合，末尾单字符 L=' + s.length);
  checkCase('中文emoji末单字', s, MSG_LIMIT_BYTES);
}

/* 用例 3：纯 emoji（全部 4 字节，最容易被切坏） */
{
  const s = '\uD83D\uDE00'.repeat(MSG_LIMIT_BYTES / 4 + 7);
  console.log('[3] 纯 emoji L=' + s.length);
  checkCase('纯emoji', s, MSG_LIMIT_BYTES);
}

/* 用例 4：孤代理（不成对）—— .NET 与 Node 都按替换字符计 3 字节 */
{
  const s = '中文\uD83D错\uDE00题' + 'x'.repeat(50) + '\uD83D';
  console.log('[4] 含孤代理 L=' + s.length);
  checkCase('孤代理', s, 16);
}

/* 用例 5：退化预算（1..4 字节）也不许死循环、不许丢字符 */
{
  for (const b of [1, 2, 3, 4]) {
    const s = 'a错\uD83D\uDE00' .repeat(3);
    const parts = splitByByteBudget(s, b);
    A('退化预算 ' + b + ' · 往返相等且片数有限', parts.join('') === s && parts.length <= s.length,
      '片数=' + parts.length);
  }
}

/* 用例 6：随机模糊（定种 PRNG，跨预算 97..4096，含切点密集踩代理对的形态） */
{
  let seed = 20261011;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed / 0x7FFFFFFF; };
  const alpha = ['a', '中', '😀', '\uD83D\uDE00', '题', '\n', '"', '\\', '\uD83D', '\uDE00'];
  let bad = 0, cases = 0, worst = 0;
  for (let i = 0; i < 300; i++) {
    const budget = 97 + Math.floor(rnd() * 4000);
    const len = Math.floor(rnd() * 4000) + 1;
    let s = '';
    for (let k = 0; k < len; k++) s += alpha[Math.floor(rnd() * alpha.length)];
    const parts = splitByByteBudget(s, budget);
    cases++;
    if (parts.join('') !== s) bad++;
    worst = Math.max(worst, Math.max(...parts.map(p => Buffer.byteLength(p, 'utf8'))));
  }
  A('随机模糊 300 组 · 全部逐字符往返', bad === 0, '不一致=' + bad + '/' + cases + ' 最坏片字节=' + worst);
}

/* 用例 7：端到端（JSON 包 → 分片 → host.js 式重组 → JSON.parse 深比） */
{
  const obj = {
    ok: true,
    data: {
      generatedAt: '2026-10-11T09:00:00+08:00',
      students: [{ name: '学生A😀', items: [] }],
      items: []
    }
  };
  for (let i = 0; i < 4000; i++) obj.data.items.push({ id: 'M' + String(i).padStart(4, '0'), question: '第' + i + '题：求浮力😀（g=10N/kg）"注释\\反斜杠"' });
  const json = JSON.stringify(obj);
  const parts = splitByByteBudget(json, MSG_LIMIT_BYTES);
  const r = reassembleViaHost(parts);
  A('端到端 · 分片经 host.js 式重组后 JSON.parse 成功且深比一致',
    r.ok && JSON.stringify(r.value) === json,
    '字符=' + json.length + ' 字节=' + Buffer.byteLength(json, 'utf8') + ' 片数=' + parts.length + (r.ok ? '' : ' 失败=' + r.reason));
}

/* 用例 8：边界（空串 / 单字符 / 恰好等于预算） */
{
  A('空串仍出 1 片（不返回 0 片，避免调用方 n=0）', splitByByteBudget('', 8).length === 1);
  A('单字符', splitByByteBudget('中', 8).join('') === '中');
  const exact = 'a'.repeat(1024);
  A('恰好等于预算 → 单片', splitByByteBudget(exact, 1024).length === 1);
  A('等于预算+1 → 两片', splitByByteBudget('a'.repeat(1025), 1024).length === 2);
}

console.log('\n══ ② 有牙齿自证：旧算法在同一批样本上必须红 ══');
{
  const L = 2 * OLD_MSG_LIMIT;
  const a = 'a'.repeat(OLD_MSG_LIMIT - 1) + '\uD83D\uDE00';
  const s = a + 'b'.repeat(L - a.length);
  const o = oldSplit(s, OLD_MSG_LIMIT);
  A('旧算法在审计样本上确实丢字符（证明样本踩到了缺陷）',
    o.complete === false && o.dropped === 1,
    'n=' + o.n + ' 实际片数=' + o.parts.length + ' 已发送=' + o.sent + '/' + L + ' 完整=' + o.complete + ' 丢失=' + o.dropped);
  A('旧算法拼回不等于原文（若相等说明本测试抓不住 F-01）', o.parts.join('') !== s,
    '差异位置=' + diffAt(o.parts.join(''), s));
  const hostOld = reassembleViaHost(o.parts);
  A('旧分片经 host.js 式重组 → JSON.parse 失败（即审计推断的页面白屏路径）', hostOld.ok === false, hostOld.reason || 'ok');
  /* 新算法在同一输入上必须全绿 */
  const np = splitByByteBudget(s, MSG_LIMIT_BYTES);
  A('新算法在审计样本上完整（对照）', np.join('') === s, '片数=' + np.length);
  /* 丢的必须是**尾部**：拼回结果 = 原文去掉最后 dropped 个字符（旧算法按原 n 收尾，游标少走的那截永远发不出去）。
     注意 slack：只有 L 恰为 limit 的整数倍（n*limit-L=0）时，一次 len-- 才会真的丢字符。 */
  A('旧算法丢失的是尾部字符（拼回 = 原文截去末尾 dropped 字符）',
    o.dropped > 0 && o.parts.join('') === s.slice(0, s.length - o.dropped),
    '丢失=' + o.dropped + ' 末尾=' + JSON.stringify(s.slice(s.length - 3)) + ' 拼回长度=' + o.parts.join('').length + '/' + s.length);
  { /* 纯文本（非 JSON）样本同样只丢尾巴：中文 + 末尾 emoji */
    const t2 = '中'.repeat(OLD_MSG_LIMIT - 1) + '\uD83D\uDE00' + '文'.repeat(OLD_MSG_LIMIT - 1);
    const o2 = oldSplit(t2, OLD_MSG_LIMIT);
    A('旧算法 · 纯文本样本也只丢尾字符且新算法完整',
      o2.dropped === 1 && o2.parts.join('') === t2.slice(0, t2.length - 1) && splitByByteBudget(t2, MSG_LIMIT_BYTES).join('') === t2,
      'L=' + t2.length + ' 丢失=' + o2.dropped);
  }
}

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + asserts);
process.exit(fails ? 1 : 0);
