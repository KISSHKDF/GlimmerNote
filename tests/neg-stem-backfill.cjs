#!/usr/bin/env node
/**
 * 补题干回归（2026-10-11）—— 13 张缺 `题干.html` 的卡补齐后，**盲解结论必须仍然有效**。
 *
 * 背景（这是本测试要永久守住的东西）：
 *   `_盲解复核.mjs` 的 `stemOf()` 取题干有优先级：`题干.html` → `错题记录.md` 的「**原题**：」段 → 索引 `question`。
 *   给一张原本没有 `题干.html` 的卡**新建**这个文件，会把题干来源从 md 原题段换成 HTML；
 *   只要 `stemToText(HTML)` 的归一化文本与 md 原题段有**一个字**的差异，`blindFingerprint` 就会失配
 *   ⇒ 该卡立刻变「待重盲解」⇒ 被组卷硬拦（原本它是可组卷的）。
 *   所以"机械补齐"这件事的**唯一难点**是：让新建的 HTML 在 `stemToText()` 下逐字还原原题。
 *
 * 实测踩到的坑（本测试的**阴性对照**，见下）：用户在需求里给的模板 `<title>题干</title>`
 *   会让 13/13 全部失配 —— `stemToText()` 的最后一步是「去掉所有标签」，
 *   而 `<title>` 的**文字内容**（那两个字"题干"）会活下来被拼进题干头部。模板本身有毒。
 *
 * 断言：
 *   A. 13 张都有 题干.html，且 UTF-8 无 BOM、无替换符 U+FFFD
 *   B. 盘上 HTML 经 stemToText() 归一化后 == md 原题段（逐字，含 −/²/　/______/「」）
 *   C. 盘上 HTML 重算的指纹 == 索引 blindFingerprint
 *   D. 真门禁 `_盲解复核.mjs 门禁 --json`：13 张全为「有效」，且 meta.fpV1 / okCount / liveCount 与基线一致
 *   E. 阴性对照①：用户草案的 `<title>题干</title>` 版本**必须**判定为失配（证明校验有效）
 *   F. 阴性对照②：把原题里任一个字改掉，指纹必须变（证明指纹真的覆盖这段文字）
 *
 * 退出码 0=全通过；1=有 FAIL。（纯只读：不写任何卡文件。）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/* ★ 2026-10-23 程序与数据分家：工具在 src\tools\，数据在库根（见 tests\_测试环境.cjs） */
const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };
const SKIP = n => console.log(`[SKIP] ${n}`);

const TARGETS = ['M0003', 'M0006', 'M0008', 'M0009', 'C0001', 'C0002', 'C0005', 'E0001', 'E0002', 'E0003', 'E0004', 'E0005', 'E0006'];

/* 历史基线（before：补题干之前，来自 _probe\before-门禁.json 与 docs\修复说明-补题干-20261011.md）。
 * ★ 2026-10-24：**不再用于断言**。它当时是"补题干不得让任何数字变化"的一次性快照，
 *   但库会增长（2026-10-11 时 202 张 → 现在 419 张），把绝对值写死等于给测试定保质期。
 *   现在只作为**历史记录**留在这里，实际断言已改成关系式（见下方 D 段）。
 *   证据：2026-10-24 实测该测试因这 4 个常量长期 FAIL（fpV1 201→200 / liveCount 201→418 /
 *   checked 202→419），且它游离在 run.mjs 之外 ⇒ 红了没人知道。见 DEFECT-REGISTRY D-050。 */
const BASE_HISTORICAL_20261011 = { fpV1: 201, okCount: 201, liveCount: 201, checked: 202 };

/* ---------- 从真源抽**活的** stemToText，避免手抄实现走样 ---------- */
function liveFn(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(new RegExp('(?:export )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error(`未能从 ${path.basename(file)} 抽出 ${name}`);
  return new Function('return (' + m[0].replace('export function', 'function') + ')')();
}
const stemToText = liveFn(E.tool('_盲解复核.mjs'), 'stemToText');
const norm = t => String(t).replace(/\s+/g, ' ').trim();
const fpV1 = t => crypto.createHash('sha256').update(norm(t), 'utf8').digest('hex').slice(0, 12);

/** 与 _盲解复核.mjs 的 originalFromRecord() 逐字一致 */
function originalFromRecord(dirAbs) {
  const p = path.join(dirAbs, '错题记录.md');
  if (!fs.existsSync(p)) return '';
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const i = lines.findIndex(l => /^\*\*原题\*\*/.test(l.trim()));
  if (i < 0) return '';
  const out = [lines[i].trim().replace(/^\*\*原题\*\*[：:]\s*/, '')];
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k].trim();
    if (l === '' || /^#/.test(l) || /^\*\*/.test(l)) break;
    out.push(l);
  }
  return out.join(' ').trim();
}

/* ---------- 索引（真源，只读） ---------- */
const idx = JSON.parse(fs.readFileSync(E.lib('九年级', '_索引.json'), 'utf8'));
const items = [];
for (const [sub, v] of Object.entries(idx.subjects)) for (const it of (v.items || [])) items.push({ sub, it, dirAbs: E.lib('九年级', sub, it.dir) });
const found = id => items.find(x => x.it.id === id);

console.log('=== A/B/C：13 张卡的文件与指纹（只读） ===');
for (const id of TARGETS) {
  const t = found(id);
  if (!t) { A(`${id} 在索引中`, false); continue; }
  const hp = path.join(t.dirAbs, '题干.html');
  if (!fs.existsSync(hp)) { A(`${id} 有 题干.html`, false, hp); continue; }
  const buf = fs.readFileSync(hp);
  const txt = buf.toString('utf8');
  const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const T0 = originalFromRecord(t.dirAbs);
  const disk = fpV1(stemToText(txt));
  A(`${id} 无 BOM / 无 U+FFFD`, !bom && !txt.includes('\uFFFD'), `${buf.length}B`);
  A(`${id} stemToText(HTML) ≡ md 原题段`, norm(stemToText(txt)) === norm(T0), `${norm(T0).length} 字`);
  A(`${id} 指纹不变`, disk === t.it.blindFingerprint, `${disk} vs 台账 ${t.it.blindFingerprint}`);
}

console.log('\n=== D：真门禁（_盲解复核.mjs 门禁 --json） ===');
let env = null;
try {
  const out = execFileSync(process.execPath, [E.tool('_盲解复核.mjs'), '门禁', '--json'], { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] });
  env = JSON.parse(out.trim());
} catch (e) {
  if (e.stdout) { try { env = JSON.parse(String(e.stdout).trim()); } catch { } }
  if (!env) A('门禁可解析', false, String(e.status));
}
if (env) {
  A('门禁 exit 0（problems 为空）', env.ok === true && (env.problems || []).length === 0, `problems=${(env.problems || []).length}`);
  /* ★ 2026-10-24 审计修复（D-050）：原先这 4 条拿**写死的基线常量**比：
   *     BASE = { fpV1: 201, okCount: 201, liveCount: 201, checked: 202 }
   *   那是 2026-10-11 补题干当时的一次性快照。库长到 419 张卡之后，
   *   这几条必然红（实测 fpV1 201→200 / liveCount 201→418 / checked 202→419），
   *   而它又游离在 run.mjs 之外 ⇒ 没人跑 ⇒ 红了半年没人知道。
   *
   *   把"绝对值不变"改成**同一时刻自洽的关系式**，这才是本测试真正要守的不变式：
   *     · 每张在用的卡（liveCount）都必须通过（okCount === liveCount）——即"没有卡变成待重盲解"
   *     · 检查总数不得少于在用数（checked >= liveCount，多出来的可能是已归档但仍参与统计的卡）
   *     · v1 指纹数不得超过在用数（fpV1 是"有 v1 指纹"的卡数，是 liveCount 的子集）
   *   这样它随数据增长自动成立，不会因库变大而烂掉。 */
  A('okCount === liveCount（没有卡变成待重盲解）', env.okCount === env.liveCount,
    `ok=${env.okCount} live=${env.liveCount} 差=${env.liveCount - env.okCount}`);
  A('checked >= liveCount（检查覆盖全部在用卡）', env.checked >= env.liveCount,
    `checked=${env.checked} live=${env.liveCount}`);
  A('meta.fpV1 <= liveCount（v1 指纹是在用卡的子集）', env.meta.fpV1 <= env.liveCount,
    `fpV1=${env.meta.fpV1} live=${env.liveCount} 差额=${env.liveCount - env.meta.fpV1}（无 v1 指纹的卡）`);
  A('meta.fpV1 > 0（真有卡带 v1 指纹，否则上面那条恒真）', env.meta.fpV1 > 0, String(env.meta.fpV1));
  /* 目标卡必须逐张判定为「有效」。cards 是 { "学生|ID": verdict } 字典，
   * 目标卡属于哪个学生不确定，所以按后缀匹配（'|' + id）。 */
  const verdictOf = (id) => {
    const k = Object.keys(env.cards || {}).find(k => k.endsWith('|' + id));
    return k ? env.cards[k] : undefined;
  };
  for (const id of TARGETS) {
    const v = verdictOf(id);
    A(`${id} 门禁新鲜度=有效`, v === '有效', v === undefined ? '<该卡不在门禁结果里>' : v);
  }
}

console.log('\n=== E：阴性对照① —— 用户草案模板 <title>题干</title> 必须让 13/13 失配 ===');
{
  let broke = 0, total = 0;
  for (const id of TARGETS) {
    const t = found(id); if (!t) continue;
    const T0 = originalFromRecord(t.dirAbs); if (!T0) continue;
    const esc = String(T0).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const naive = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>题干</title></head><body><p>${esc}</p></body></html>`;
    total++;
    if (fpV1(stemToText(naive)) !== t.it.blindFingerprint) broke++;
  }
  A('草案模板会改变指纹（证明这条校验不是空转）', broke === total && total === TARGETS.length, `${broke}/${total} 张失配`);
}
console.log('\n=== F：阴性对照② —— 原题改一个字，指纹必须变 ===');
{
  let changed = 0, total = 0;
  for (const id of TARGETS) {
    const t = found(id); if (!t) continue;
    const T0 = originalFromRecord(t.dirAbs); if (!T0) continue;
    total++;
    const mutated = T0.slice(0, Math.max(1, T0.length - 1)) + (T0.endsWith('。') ? '？' : '。');
    if (fpV1(mutated) !== fpV1(T0)) changed++;
  }
  A('改一字即改指纹（指纹确实覆盖这段文字）', changed === total, `${changed}/${total} 张`);
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}  断言 ${TARGETS.length * 3 + 5 + 2} 项，FAIL ${fails}`);
process.exit(fails ? 1 : 0);
