#!/usr/bin/env node
/**
 * neg-inbox-zero-card.cjs —— 「0 卡页」必须也判"已处理"（2026-11-19 立）
 *
 * 事故形态（用户报障）：一份**未批改**的期中卷 6 页跑完整条 AGENT 流水线，
 * 6 张全部登记成「整页无错题（0 卡）」闭环（`landedZeroAt` 都写进任务记录了）——
 * 而收件箱里那 6 张**一张都没消失**，永远挂在待处理清单上。
 * 用户看到的结论是"这程序什么也没做"。
 *
 * 根因：`_配方.mjs` 的 `inboxArchivedSet()` 判"已处理"**只看 `_原卷台账.json`**（卡片 ↔ 原图），
 * 而 0 卡页天生没有卡 ⇒ 永远进不了台账 ⇒ 永远判不出已处理。
 * 而 `_录题入库.mjs` 的 0 卡分支当场打印「收件箱按台账判"已处理"」—— 那句话当时是假的
 * （实测真库：26 条 0 卡任务里 24 张仍挂在待处理清单）。
 *
 * 现在判据多一条真源：`_录题\t-*.json` 里 `landedZeroAt` 非空 ⇒ 这张原图已走完
 * 「校验 → 确认 → 入库登记」全链。取证用任务记录自带的 `image.sha256` / `image.rel`。
 *
 * 本用例在**临时库**上真跑 `_配方.mjs 收件箱 --json`（绝不碰真库），守四条：
 *   ① 有 0 卡登记 ⇒ 该件判已处理（从待处理清单消失，但仍报在 `archived` 里、文件没被搬动）；
 *   ② **阴性对照**：抹掉 `landedZeroAt` ⇒ 必须回到待处理清单（证明判据不是"一律隐藏"）；
 *   ③ 指纹判据：任务记录只给 `image.sha256`（rel 写错/缺失）仍能判已处理 ——
 *      内容才是身份，路径不是（与台账判据同族）；
 *   ④ 坏任务记录（非法 JSON / 形状不对）不许拖垮整张清单，也不许把该件误判成已处理。
 *
 * 用法：node tests\neg-inbox-zero-card.cjs
 * 退出码：0=全绿；1=有断言失败
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_配方.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-zerocard-'));
const LIB = path.join(TMP, 'lib');
const INBOX = path.join(LIB, '_收件箱');
const TASKS = path.join(LIB, '_录题');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** 造一张"照片"：内容随意但确定（这里用可复现的字节序列） */
const mkPhoto = (name, seed) => {
  const buf = Buffer.alloc(512);
  for (let i = 0; i < buf.length; i++) buf[i] = (seed + i * 7) & 0xff;
  fs.writeFileSync(path.join(INBOX, name), buf);
  return { name, sha: sha256(buf), bytes: buf.length };
};
const writeTask = (id, obj) => {
  fs.writeFileSync(path.join(TASKS, id + '.json'), JSON.stringify(obj), 'utf8');
};
const taskOf = (id, image, extra) => Object.assign({
  schema: 'glimmernote.ingest-task/v1',
  taskId: id,
  createdAt: '2026-11-19T12:00:00+08:00',
  recipe: { id: 'ingest-independent', version: '1.0.0', fingerprint: 'deadbeefcafe' },
  cards: [],
  image,
  subject: '数学',
  student: '测试',
  taskText: '（用例夹具）',
}, extra || {});

function runInbox() {
  const r = spawnSync(process.execPath, [ENGINE, '收件箱', '--json', '--data', LIB], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: LIB }),
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '')); } catch { /* 下面按 null 判红 */ }
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json };
}
/** 待处理清单里所有 sha（空清单 = 已全部归档） */
const pendingShas = (j) => new Set(((j && j.batches) || []).flatMap((b) => (b.files || []).map((f) => f.sha256)));
/** 已归档清单里所有 rel（小写，与工具内部口径一致） */
const archivedRels = (j) => new Set(((j && j.archived) || []).map((x) => String(x.rel).toLowerCase()));

fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(TASKS, { recursive: true });

/* 三张照片，各自对应一个任务记录（三种不同形态） */
const P1 = mkPhoto('zero-one.jpg', 11);       // 有 landedZeroAt（rel 正确）
const P2 = mkPhoto('zero-two.jpg', 22);       // 有 landedZeroAt（rel 写错，只能靠指纹）
const P3 = mkPhoto('still-pending.jpg', 33);  // 没有 landedZeroAt ⇒ 必须仍在待处理清单

writeTask('t-20261119-120000-aaaaaa', taskOf('t-20261119-120000-aaaaaa',
  { sha256: P1.sha, rel: '_收件箱/zero-one.jpg' }, { landedZeroAt: '2026-11-19', landedDigest: 'd1' }));
writeTask('t-20261119-120001-bbbbbb', taskOf('t-20261119-120001-bbbbbb',
  { sha256: P2.sha, rel: '_收件箱/另一个名字.jpg' }, { landedZeroAt: '2026-11-19', landedDigest: 'd2' }));
writeTask('t-20261119-120002-cccccc', taskOf('t-20261119-120002-cccccc',
  { sha256: P3.sha, rel: '_收件箱/still-pending.jpg' }, { confirmedAt: '2026-11-19T12:01:00+08:00' }));

console.log('═══ ① 0 卡登记 ⇒ 判"已处理"（清单里消失，但仍报在 archived 里） ═══');
const r1 = runInbox();
A('收件箱命令成功（exit 0）', r1.code === 0, 'exit=' + r1.code + ' ' + r1.err.slice(0, 120));
A('★ 有 landedZeroAt 的页不再占待处理清单', !!r1.json && !pendingShas(r1.json).has(P1.sha),
  '待处理=' + (r1.json ? [...pendingShas(r1.json)].length : 'null'));
A('★ 但没有"藏起来"：仍报在 archived 里（用户可展开看，文件一个字节没动）',
  !!r1.json && archivedRels(r1.json).has('_收件箱/zero-one.jpg'), JSON.stringify(r1.json && r1.json.archivedNote));
A('★ 文件仍在原处（本工具只读，不搬不删）', fs.existsSync(path.join(INBOX, P1.name)), P1.name);

console.log('\n═══ ② 阳性账户仍在待处理（没登记的页不许被顺手藏掉） ═══');
A('★ 没有 landedZeroAt 的页仍在待处理清单', !!r1.json && pendingShas(r1.json).has(P3.sha),
  '待处理=' + (r1.json ? r1.json.total : 'null'));
A('★ 未登记的页**不**出现在 archived 里', !!r1.json && !archivedRels(r1.json).has('_收件箱/still-pending.jpg'), '');

console.log('\n═══ ③ 指纹判据：rel 写错也能判（内容才是身份，不是路径） ═══');
A('★ 任务记录的 image.rel 与真实路径不一致时，仍按 sha256 判已处理',
  !!r1.json && !pendingShas(r1.json).has(P2.sha), 'P2 仍在待处理=' + (!!r1.json && pendingShas(r1.json).has(P2.sha)));

console.log('\n═══ ④ 坏任务记录不许拖垮清单，也不许误判 ═══');
fs.writeFileSync(path.join(TASKS, 't-20261119-120003-dddddd.json'), '{ 这不是 JSON', 'utf8');
fs.writeFileSync(path.join(TASKS, 't-20261119-120004-eeeeee.json'),
  JSON.stringify({ schema: 'x', taskId: 't-20261119-120004-eeeeee', landedZeroAt: '2026-11-19', image: null }), 'utf8');
const r2 = runInbox();
A('★ 坏任务记录在场时收件箱仍成功（单条坏件不拖垮整个列表）', r2.code === 0,
  'exit=' + r2.code + ' ' + r2.err.slice(0, 120));
A('★ image 缺失的记录不会让任何页被误判已处理', !!r2.json && pendingShas(r2.json).has(P3.sha), '');

console.log('\n═══ ⑤ 阴性自证：把判据摘掉 ⇒ ① 必须变红 ═══');
{
  /* 不真实改文件（那会让用例自我污染），而是**证明**判据的存在形态：
     ① 源码里必须真有这条判据；
     ② 把临时库里那条记录的 landedZeroAt 抹掉 ⇒ 该件立刻回到待处理（等价于判据被摘掉）。 */
  const src = fs.readFileSync(ENGINE, 'utf8');
  A('引擎里有 inboxZeroCardSet 这条判据', /function inboxZeroCardSet\(/.test(src), '');
  A('★ 判据读的是任务记录的 landedZeroAt（不是别的字段）',
    /landedZeroAt/.test(src) && /inboxZeroCardSet/.test(src), '');
  const p1Task = path.join(TASKS, 't-20261119-120000-aaaaaa.json');
  const doc = JSON.parse(fs.readFileSync(p1Task, 'utf8'));
  delete doc.landedZeroAt; delete doc.landedDigest;
  fs.writeFileSync(p1Task, JSON.stringify(doc), 'utf8');
  const r3 = runInbox();
  A('★ 抹掉 landedZeroAt ⇒ 该页**立刻**回到待处理清单（判据确实有牙齿）',
    !!r3.json && pendingShas(r3.json).has(P1.sha), '待处理=' + (r3.json ? r3.json.total : 'null'));
}

console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}`);
process.exit(fail ? 1 : 0);
