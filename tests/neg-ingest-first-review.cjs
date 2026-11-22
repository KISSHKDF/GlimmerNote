#!/usr/bin/env node
/**
 * 阴性用例（2026-11-23，审计 R-03 · P1）：**新卡入库即排首次复习（次日）**。
 *
 * 缺陷（修前）：入库的索引条目 `nextDue=''` ⇒ 卡永远不进到期池，
 *   只有"被组过一次卷、批改回录"之后才开始复习 —— 运行区实测 645 张卡里 482 张（75%）
 *   从未复习，且对账解释只有这一条根因链。
 * 修法：入库条目 nextDue = 明天（本地日期）；reviewStatus 仍「未复习」（无复习记录），
 *   到期池按 nextDue 判（前端 model.dueInfo：nextDue 非空且 ≤ 今天 ⇒ 'due'）。
 *   批改时 `_标记复习` 按判分重算 nextDue，初值只管"第一次"。
 *
 * 判据：
 *   ① 入库 ⇒ 索引条目 nextDue === 明天（本地时区，跨午夜安全）；
 *   ② reviewStatus 仍是「未复习」（不假装复习过）；
 *   ③ --dry 预演零写盘（回滚后索引里没有新卡）；
 *   ④ 阴性自证：把 nextDue 初值改回 '' ⇒ 断言①必红。
 *
 * 用法：node tests\neg-ingest-first-review.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 200) : ''}`); if (!ok) fails++; };

const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCABkAGQBAREA/8QAHwAAAQUBAQEBAQAAAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z', 'base64');
const shaOf = b => crypto.createHash('sha256').update(b).digest('hex');

/* 本地"明天"（与 _标记复习.mjs 的 dstr 同口径：不用 toISOString，UTC+8 会倒退一天） */
const tomorrowLocal = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const todayLocal = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

const mkLib = (tag) => {
  const lib = E.allocTempDir('gn-first-review-' + tag + '-');
  fs.mkdirSync(path.join(lib, '_收件箱', '批次'), { recursive: true });
  fs.writeFileSync(path.join(lib, '_收件箱', '批次', 'p001.jpg'), JPG);
  fs.mkdirSync(path.join(lib, '七年级-学生甲'), { recursive: true });
  fs.writeFileSync(path.join(lib, '七年级-学生甲', '_索引.json'), JSON.stringify({ schema: 'glimmernote.index/v1', student: '学生甲', grade: '七年级', subjects: { 数学: { items: [] } }, updatedAt: '2026-11-01' }));
  return lib;
};
const mkTaskAndCards = (lib, tid) => {
  const sha = shaOf(fs.readFileSync(path.join(lib, '_收件箱', '批次', 'p001.jpg')));
  fs.mkdirSync(path.join(lib, '_录题'), { recursive: true });
  fs.writeFileSync(path.join(lib, '_录题', tid + '.json'), JSON.stringify({
    schema: 'glimmernote.ingest-task/v1', taskId: tid, createdAt: '2026-11-23T20:00:00+08:00',
    recipe: { id: 'ingest-auto', version: '1.0.0', fingerprint: 'deadbeefcafe' },
    cards: [], image: { sha256: sha, rel: '_收件箱/批次/p001.jpg' }, subject: '数学',
    contractDigest: 'cafe1234', taskDigest: 'aaaa', taskText: 't', confirmedAt: '2026-11-23T20:01:00+08:00',
  }));
  const cf = path.join(lib, 'cards.json');
  fs.writeFileSync(cf, JSON.stringify({
    envelope: { schema: 'glimmernote.ingest-result/v1', taskId: tid, imageSha256: sha },
    result: { pageSummary: { totalQuestions: 1, markedWrong: 1, unmarked: 0 }, cards: [{
      subject: '数学', title: '首复排期卡', source: 's', sourceDate: todayLocal(),
      questionText: '测试：2+2=____。', studentAnswer: '5', answer: '4',
      answerSource: '独立判卷', answerSourceNote: '加法', teacherAnswer: '',
      causeCode: 'L1', causeNote: 'n', kpoints: ['k'], difficulty: '中',
      hasFigure: false, confidence: 'high', sourceImageSha256: sha, notes: '',
      bbox: [0.02, 0.29, 0.96, 0.08], answerMode: 'blank', answerSlots: ['4'],
    }], skipped: [] },
  }));
  return cf;
};
const runLand = (lib, cf, tid, extra) => spawnSync(process.execPath,
  [path.join(ROOT, 'src', 'tools', '_录题入库.mjs'), '入库', tid, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', lib, ...(extra || [])],
  { encoding: 'utf8', maxBuffer: 64e6 });
const firstItem = (lib) => {
  const j = JSON.parse(fs.readFileSync(path.join(lib, '七年级-学生甲', '_索引.json'), 'utf8').replace(/^\uFEFF/, ''));
  return (j.subjects['数学'].items || [])[0] || null;
};

/* 变异体：nextDue 初值改回 ''（复刻旧缺陷） */
const INGEST_SRC = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_录题入库.mjs'), 'utf8');
const ANCHOR = "lastReviewedAt: '', nextDue: _firstDue, masteredAt: null,";
if (!INGEST_SRC.includes(ANCHOR)) {
  console.error('[前置失败] 找不到 nextDue 初值锚点——源码已变，请同步本用例锚点');
  process.exit(2);
}
const MUTATED = INGEST_SRC.replace(ANCHOR, "lastReviewedAt: '', nextDue: '', masteredAt: null,");
const mutDir = E.allocTempDir('gn-first-review-mut-');
fs.mkdirSync(mutDir, { recursive: true });
{
  /* ⚠ 整个 tools 目录一起复制：入库器收尾会用 toolPath() 当场跑四道门禁，
     toolPath 以**引擎自身目录**定位兄弟脚本 —— 只复制 import 闭包会 MODULE_NOT_FOUND。 */
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'tools'))) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(ROOT, 'src', 'tools', f), path.join(mutDir, f));
  }
  fs.writeFileSync(path.join(mutDir, '_录题入库.mjs'), MUTATED, 'utf8');
}

const TID = 't-20261123-230000-abc123';

/* ══ ①② 正向：入库 ⇒ nextDue=明天、状态未复习 ══ */
{
  const lib = mkLib('main');
  const cf = mkTaskAndCards(lib, TID);
  const r = runLand(lib, cf, TID);
  A('①a 入库成功', r.status === 0, 'exit=' + r.status + ' ' + (String(r.stdout || '') + String(r.stderr || '')).slice(-120));
  const it = firstItem(lib);
  A('★ ①b 新卡 nextDue = 明天（入库即排首次复习）', it && it.nextDue === tomorrowLocal(),
    'nextDue=' + (it && it.nextDue) + ' 明天=' + tomorrowLocal());
  A('② reviewStatus 仍是「未复习」（初值不假装复习过）', it && it.reviewStatus === '未复习', 'status=' + (it && it.reviewStatus));
  A('②b reviews 为空数组（没有伪造复习记录）', it && Array.isArray(it.reviews) && it.reviews.length === 0, '');
}
/* ══ ③ --dry 预演零写盘 ══ */
{
  const lib = mkLib('dry');
  const cf = mkTaskAndCards(lib, TID);
  const r = runLand(lib, cf, TID, ['--dry']);
  A('③ --dry 预演成功', r.status === 0, 'exit=' + r.status);
  A('③b --dry 后索引里没有新卡（零写盘）', firstItem(lib) === null, '');
}
/* ══ ④ 阴性自证 ══ */
{
  const lib = mkLib('mut');
  const cf = mkTaskAndCards(lib, TID);
  const r = spawnSync(process.execPath, [path.join(mutDir, '_录题入库.mjs'), '入库', TID, '--file', cf, '--student', '学生甲', '--subject', '数学', '--data', lib], { encoding: 'utf8', maxBuffer: 64e6 });
  const allOut = String(r.stdout || '') + String(r.stderr || '');
  A('④a 变异体入库成功', r.status === 0, 'exit=' + r.status + ' ' + allOut.replace(/\s+/g, ' ').slice(-200));
  const it = firstItem(lib);
  A('★★ ④b 变异体 nextDue 为空（= 旧缺陷复现，主判据①会红）', it && it.nextDue === '', 'nextDue=' + (it && JSON.stringify(it.nextDue)));
}

console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${total} 失败=${fails}`);
process.exit(fails ? 1 : 0);
