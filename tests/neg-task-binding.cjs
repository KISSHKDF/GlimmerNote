#!/usr/bin/env node
/**
 * 录题任务绑定（建议书 §4）阴性对照：三层校验每层都要能红。
 *
 * 为什么必须有它：错配是**最危险的静默错误**——把 A 的结果贴进 B，格式完全合法，
 * 卡却会挂到错的题上，而且事后无从回溯。所以每一条都必须有一个"故意违反它、必须报红"的证据。
 *
 * 退出码语义：0 通过 · 1 格式不通过 · 2 任务不存在/用法错 · 3 与任务不匹配
 *
 * ★ 2026-11-03（批次 1 收尾）补两段：
 *   5 · 信封畸形（有 envelope、缺 result）必须**可归因**（P1-#2）：输出要点到"信封 + result"，
 *       不得给出"缺必填字段 pageSummary"这类指错方向的文案；--json 带 envelope:'malformed'。
 *       判据自证：把"修复前的降级路径"（外层对象直接进格式层）真跑一遍，判据对它的输出必须判红。
 *   6 · 容错抽取（P1-#1）：唯一实现在工具侧。原样 JSON 与"裹了说明文字的 JSON"两种输入各跑一次
 *       （`绑定校验` 与 `_配方.mjs 校验` 各一遍），放宽必须说出口（extracted/how）；
 *       并真跑一次"裸 JSON.parse 失败 / 页面旧截取成功"，证明旧注释那句"与工具侧同口径"是假口径。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-task-'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const run = (args, extraEnv) => {
  try {
    const out = execFileSync(process.execPath, [E.tool(args[0]), ...args.slice(1)], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: LIB }, extraEnv || {}),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
const w = (rel, buf) => { const p = path.join(LIB, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };

/* 两张内容不同的"原图"（sha 不同 ⇒ 两个任务必须能区分） */
const JPG_A = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x05, 0x78, 0x03, 0xE8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9, 0x01]);
const JPG_B = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x05, 0x78, 0x03, 0xE8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9, 0x02]);
w('_收件箱/a.jpg', JPG_A); w('_收件箱/b.jpg', JPG_B);
const SHA_A = sha256(JPG_A), SHA_B = sha256(JPG_B);

/* ---------- 1) 生成两个任务（A、B） ---------- */
const rA = run(['_配方.mjs', '组装', '--recipe', 'ingest-page', '--subject', '数学', '--task', '--image', '_收件箱/a.jpg', '--out', path.join(LIB, 'taskA.md')]);
const rB = run(['_配方.mjs', '组装', '--recipe', 'ingest-page', '--subject', '数学', '--task', '--image', '_收件箱/b.jpg', '--out', path.join(LIB, 'taskB.md')]);
A('1a 组装 A（--task）成功', rA.code === 0, 'exit=' + rA.code);
A('1b 组装 B（--task）成功', rB.code === 0, 'exit=' + rB.code);
A('1c 任务单里写了任务号段', /任务号/.test(fs.readFileSync(path.join(LIB, 'taskA.md'), 'utf8')));
A('1d 任务单要求用信封回传', /envelope/.test(fs.readFileSync(path.join(LIB, 'taskA.md'), 'utf8')));

const listJson = run(['_录题任务.mjs', '列', '--json']);
let tasks = [];
try { tasks = JSON.parse(listJson.out).tasks || []; } catch { /* 下面断言会红 */ }
A('1e 列清单里正好两条任务', tasks.length === 2, 'len=' + tasks.length);
const tA = (tasks.find(t => t.image === SHA_A.slice(0, 12)) || {}).taskId;
const tB = (tasks.find(t => t.image === SHA_B.slice(0, 12)) || {}).taskId;
A('1f A/B 是两个不同任务号', !!tA && !!tB && tA !== tB, tA + ' / ' + tB);

/* ---------- 2) 记录字段齐（建议书 §4 要求的最小集） ---------- */
const recA = JSON.parse(run(['_录题任务.mjs', '看', tA, '--json']).out);
A('2a 记录有 taskId/schema/createdAt', recA.taskId === tA && recA.schema === 'glimmernote.ingest-task/v1' && !!recA.createdAt);
A('2b 记录有配方 id+version+fingerprint', !!(recA.recipe && recA.recipe.id && recA.recipe.version && recA.recipe.fingerprint));
A('2c 记录有原图 sha（= 真实文件字节的 sha256）', recA.image && recA.image.sha256 === SHA_A, String(recA.image && recA.image.sha256).slice(0, 12));
A('2d contractDigest 是 64 位十六进制（含 schema 摘要）', /^[0-9a-f]{64}$/.test(String(recA.contractDigest)), String(recA.contractDigest).slice(0, 16));
A('2e taskDigest = sha256(记录的 taskText)', recA.taskDigest === sha256(recA.taskText), String(recA.taskDigest).slice(0, 12));
A('2f 记录里留了任务单全文', String(recA.taskText).length > 1000, String(recA.taskText).length + ' 字符');

/* ---------- 3) 三层校验：正例 + 每层各自的反例 ---------- */
const payload = (cards) => ({
  pageSummary: { totalQuestions: 3, markedWrong: 1 },
  cards, skipped: [{ what: '第2题', reason: '未作答' }],
});
const card = (sha) => ({
  subject: '数学', title: '合成题', questionText: '1+1=?', studentAnswer: '3',
  answerSource: '独立判卷', causeCode: 'K1', confidence: 'high', sourceImageSha256: sha,
});
const envelope = (taskId, imgSha, cards) => ({
  envelope: { schema: 'glimmernote.ingest-result/v1', taskId, imageSha256: imgSha },
  result: payload(cards),
});
const put = (name, obj) => w(name, Buffer.from(JSON.stringify(obj, null, 1), 'utf8'));

put('r-ok.json', envelope(tA, SHA_A, [card(SHA_A)]));
const ok = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-ok.json')]);
A('3a 正确信封 + 正确原图 ⇒ exit 0（格式与匹配都通过）', ok.code === 0, 'exit=' + ok.code);
A('3b 未确认时第三层显式写"未确认"（不许假装全通）', /未确认/.test(ok.out) && /第三层未完成/.test(ok.out));

put('r-cross.json', envelope(tA, SHA_A, [card(SHA_A)]));
const cross = run(['_录题任务.mjs', '绑定校验', tB, '--in', path.join(LIB, 'r-cross.json')]);
A('3c 把 A 的结果贴给 B ⇒ exit 3 且点名"信封 taskId 不匹配"', cross.code === 3 && /信封 taskId/.test(cross.out), 'exit=' + cross.code);

put('r-forge.json', envelope('t-19990101-000000-deadbe', SHA_A, [card(SHA_A)]));
const forge = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-forge.json')]);
A('3d 伪造 taskId ⇒ exit 3', forge.code === 3, 'exit=' + forge.code);

put('r-img.json', envelope(tA, SHA_B, [card(SHA_A)]));
const imgBad = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-img.json')]);
A('3e 信封原图 sha 与本任务不符 ⇒ exit 3', imgBad.code === 3, 'exit=' + imgBad.code);

put('r-card.json', envelope(tA, SHA_A, [card(SHA_B)]));
const cardBad = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-card.json')]);
A('3f 卡内 sourceImageSha256 与本任务不符 ⇒ exit 3', cardBad.code === 3, 'exit=' + cardBad.code);

put('r-bare.json', payload([card(SHA_A)]));
const bare = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-bare.json')]);
A('3g 旧格式（无信封）仍按"仅格式校验"通过 ⇒ exit 0', bare.code === 0, 'exit=' + bare.code);
A('3h 旧格式明确说"未与任务关联"（不许算成已验证）', /未与任务关联/.test(bare.out));

put('r-badfmt.json', envelope(tA, SHA_A, [{ subject: '数学', title: '缺字段' }]));
const badfmt = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-badfmt.json')]);
A('3i 格式不合法 ⇒ exit 1（不是 0，也不是 3）', badfmt.code === 1, 'exit=' + badfmt.code);

put('r-badjson.json', {});
fs.writeFileSync(path.join(LIB, 'r-badjson.json'), '{ 这不是 JSON', 'utf8');
const badjson = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-badjson.json')]);
A('3j 非法 JSON ⇒ exit 1', badjson.code === 1, 'exit=' + badjson.code);

const missing = run(['_录题任务.mjs', '绑定校验', 't-19990101-000000-nope00', '--in', path.join(LIB, 'r-ok.json')]);
A('3k 任务不存在 ⇒ exit 2 且给具体原因', missing.code === 2 && /任务不存在/.test(missing.out), 'exit=' + missing.code);

/* ---------- 4) 第三层由人写：确认前后必须不同 ---------- */
const before = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-ok.json')]);
const conf = run(['_录题任务.mjs', '确认', tA, '--note', '人工看过']);
const after = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-ok.json')]);
A('4a 确认命令成功', conf.code === 0, 'exit=' + conf.code);
A('4b 确认前第三层是"未确认"、确认后是"已确认"',
  /未确认/.test(before.out) && /已确认/.test(after.out) && !/未确认/.test(after.out));
A('4c 确认不改变匹配结论（仍然 exit 0）', after.code === 0, 'exit=' + after.code);

/* ---------- 5) P1-#2：信封畸形（有 envelope、缺 result）必须可归因 ---------- */
console.log('\n═══ 5 · 信封畸形：有 envelope 缺 result ⇒ 点名信封与 result，不许指错方向 ═══');
/* 判据（有牙齿）：输出里**必须**出现「信封」且点到 result；**不得**出现「缺必填字段…pageSummary」
   这类指错方向的文案 —— P1-#2 的症状正是用户以为自己的 cards 写错了，其实是漏了 result 包装。
   缺陷复现时它靠什么变红：`_录题任务.mjs` 的信封判据退回修复前那一行式
   （`(obj.envelope && obj.result) ? obj.envelope : null`）⇒ 缺 result 这组被**降级成裸对象**、
   外层对象被送去格式层 ⇒ 输出只剩 pageSummary 那一档 ⇒ 5b 直接红（5e 把这条路径真跑了一遍）。 */
const envelopeDiagnosisOk = (out) => /信封/.test(out) && /result/.test(out) && !/缺必填字段/.test(out) && !/pageSummary/.test(out);
put('r-env-noresult.json', { envelope: { schema: 'glimmernote.ingest-result/v1', taskId: tA, imageSha256: SHA_A } });
const envNoResult = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-env-noresult.json')]);
A('5a 有 envelope 缺 result ⇒ exit 1（格式层；不是 0，也不是 3）', envNoResult.code === 1, 'exit=' + envNoResult.code);
A('5b 输出必须出现「信封」且点到 result（判据 = envelopeDiagnosisOk）', envelopeDiagnosisOk(envNoResult.out),
  envNoResult.out.split('\n').filter(l => /信封|pageSummary|缺必填/.test(l)).join(' ｜ ').slice(0, 160));
A('5c **不得**出现「缺必填字段…pageSummary」这类指错方向的文案（P1-#2 的核心）',
  !/缺必填字段/.test(envNoResult.out) && !/pageSummary/.test(envNoResult.out));
const envNoResultJson = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-env-noresult.json'), '--json']);
let jEnv = null; try { jEnv = JSON.parse(envNoResultJson.out); } catch { /* 下面断言会红 */ }
A('5d --json 带机器可读的 envelope=malformed、matched=false、layer2=not-judged',
  envNoResultJson.code === 1 && !!jEnv && jEnv.envelope === 'malformed' && jEnv.matched === false && jEnv.layer2 === 'not-judged' && /result/.test(String(jEnv.envelopeError)),
  JSON.stringify(jEnv && { envelope: jEnv.envelope, layer2: jEnv.layer2, err: String(jEnv.envelopeError).slice(0, 46) }));

/* ★ 判据自证（本仓 T-1 同族：新判据必须说得出"缺陷复现时靠什么变红"）。
   修复前的 `绑定校验` 对同一份输入走的就是"把外层对象当业务对象交给格式层"这条路
   （`result = obj` ⇒ `JSON.stringify(result)` ⇒ `_配方.mjs 校验 --recipe <任务记录里的配方>`）。
   这里把那条路径**真跑一遍**：它只可能给出 pageSummary / cards 那一档 ⇒ 5b 的判据必然判红。
   （不真跑就无法证明 5b 不是一条恒真断言。） */
const preFixPath = run(['_配方.mjs', '校验', '--recipe', (recA.recipe && recA.recipe.id) || 'ingest-page',
  '--in', path.join(LIB, 'r-env-noresult.json')]);
A('5e 判据自证：同一份输入走"修复前的降级路径"⇒ 输出只有 pageSummary 一档、没有信封诊断 ⇒ 5b 必然判红',
  !envelopeDiagnosisOk(preFixPath.out) && /缺必填字段/.test(preFixPath.out) && /pageSummary/.test(preFixPath.out),
  'exit=' + preFixPath.code + ' ｜ ' + preFixPath.out.split('\n').filter(l => /缺必填字段|信封/.test(l)).join(' ').slice(0, 130));

put('r-env-str.json', { envelope: 'x', result: payload([card(SHA_A)]) });
const envStr = run(['_录题任务.mjs', '绑定校验', tA, '--in', path.join(LIB, 'r-env-str.json')]);
A('5f envelope 不是对象（字符串）同样按"信封畸形"处置，不退化成裸对象路径（也不指错方向）',
  envStr.code === 1 && /信封/.test(envStr.out) && !/pageSummary/.test(envStr.out), 'exit=' + envStr.code);

/* ---------- 6) P1-#1：容错抽取（唯一实现在工具侧） ---------- */
console.log('\n═══ 6 · 容错抽取：唯一实现，行为只变宽、且放宽要说出口 ═══');
const okText = JSON.stringify(payload([card(SHA_A)]), null, 1);
const asisFile = w('r-asis.json', Buffer.from(okText, 'utf8'));
const PROSE = '好的，以下是识别结果：\n' + okText + '\n希望有帮助！';
const proseFile = w('r-prose.json', Buffer.from(PROSE, 'utf8'));
const asis = run(['_录题任务.mjs', '绑定校验', tA, '--in', asisFile]);
const prose = run(['_录题任务.mjs', '绑定校验', tA, '--in', proseFile]);
A('6a 原样 JSON ⇒ exit 0（与修复前一致：行为没有变窄）', asis.code === 0, 'exit=' + asis.code);
A('6b 裹了说明文字 ⇒ 同一个工具 exit 0（修复前这里是 exit 1：容错口径只在工具侧）', prose.code === 0, 'exit=' + prose.code);
A('6c 抽取发生了就**说出口**（静默放宽比不放宽更坏）', /抽取/.test(prose.out), prose.out.split('\n')[0].slice(0, 90));
const proseJson = run(['_录题任务.mjs', '绑定校验', tA, '--in', proseFile, '--json']);
let jProse = null; try { jProse = JSON.parse(proseJson.out); } catch { }
A('6d --json 里 extracted=braces（页面与 CLI 同口径的机读凭据）',
  !!jProse && jProse.extracted === 'braces' && jProse.envelope === 'absent', JSON.stringify(jProse && { extracted: jProse.extracted, envelope: jProse.envelope }));
const v1 = run(['_配方.mjs', '校验', '--in', asisFile]);
const v2 = run(['_配方.mjs', '校验', '--in', proseFile]);
A('6e `_配方.mjs 校验` 同一个函数：原样 exit 0 / 裹说明文字 exit 0（页面"没生成任务单"走的就是它）',
  v1.code === 0 && v2.code === 0, 'asis=' + v1.code + ' prose=' + v2.code);
let jV2 = null; try { jV2 = JSON.parse(run(['_配方.mjs', '校验', '--in', proseFile, '--json']).out); } catch { }
A('6f `_配方.mjs 校验 --json` 也带 extracted=braces', !!jV2 && jV2.extracted === 'braces', JSON.stringify(jV2 && jV2.extracted));
const noBraceFile = w('r-nobrace.json', Buffer.from('我没有看到图片，无法识别。', 'utf8'));
const nb = run(['_录题任务.mjs', '绑定校验', tA, '--in', noBraceFile]);
A('6g 连花括号都没有 ⇒ 仍 exit 1，且点名"连花括号都没有"（放宽 ≠ 放行）',
  nb.code === 1 && /不是合法 JSON/.test(nb.out) && /连花括号都没有/.test(nb.out), 'exit=' + nb.code + ' ｜ ' + nb.out.split('\n')[0].slice(0, 80));
/* ★ 判据自证（P1-#1 的"唯一实现"这件事本身）：同一段原文，
   裸 JSON.parse（= 修复前工具的容错口径）**失败**，而页面旧截取**成功**
   ⇒ 两份实现的口径确实不同 ⇒ ingest.js 里那句注释「与工具侧同一容错口径」是假的。
   这条断言真跑两种解析，不是文字比对。 */
{
  const rawProse = fs.readFileSync(proseFile, 'utf8');
  let bareFails = false; try { JSON.parse(rawProse); } catch { bareFails = true; }
  const a0 = rawProse.indexOf('{'), b0 = rawProse.lastIndexOf('}');
  let sliceOk = false; try { JSON.parse(rawProse.slice(a0, b0 + 1)); sliceOk = true; } catch { }
  A('6h 判据自证：同段原文"裸 JSON.parse 失败 / 页面旧截取成功" ⇒ 旧注释"与工具侧同口径"确为假口径（差值就是这次单点化掉的）',
    bareFails && sliceOk && a0 > 0 && b0 > a0, 'bareFails=' + bareFails + ' sliceOk=' + sliceOk);
}

fs.rmSync(LIB, { recursive: true, force: true });
console.log('');
console.log(`RESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${total} 失败=${fails}`);
process.exit(fails ? 1 : 0);
