#!/usr/bin/env node
/**
 * 录题任务绑定（建议书 §4）阴性对照：三层校验每层都要能红。
 *
 * 为什么必须有它：错配是**最危险的静默错误**——把 A 的结果贴进 B，格式完全合法，
 * 卡却会挂到错的题上，而且事后无从回溯。所以每一条都必须有一个"故意违反它、必须报红"的证据。
 *
 * 退出码语义：0 通过 · 1 格式不通过 · 2 任务不存在/用法错 · 3 与任务不匹配
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

fs.rmSync(LIB, { recursive: true, force: true });
console.log('');
console.log(`RESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'} 断言=${total} 失败=${fails}`);
process.exit(fails ? 1 : 0);
