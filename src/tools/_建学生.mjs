#!/usr/bin/env node
/**
 * 拾光小册 · 新建学生
 *
 * ⚠ 2026-10-24 改版（用户指正）：
 *   上一版要求「姓名 + 年级 + 学科」。用户一句话点破：**要这个程序的人，肯定每个学科都要录入错题**。
 *   建学生时问"哪一科"是把顺序搞反了 —— 学科不是"人"的属性，是"题"的属性。
 *   一个孩子天然有 数学/语文/英语/物理/化学……，问学科等于逼用户为同一个孩子重复建好几次。
 *
 * 所以现在最少信息只有两项，且只有第一项必填：
 *   ① 姓名（必填）—— 用来区分孩子；只存在本机
 *   ② 年级（可留空）—— 只用于显示与统计分组；跨学年改它，不动任何卡
 *
 * 数据形态（学生级一份索引，学科**按需长出来**）：
 *   <库根>\<姓名>\_索引.json
 *     { student, grade, subjects: {}, note, updatedAt }
 *   之后录某门课的题时，`subjects[该学科] = { items: [ ... ] }` 自动出现；
 *   卡目录 = <库根>\<姓名>\<学科>\<卡目录>\。
 *   这与库里既有的多学科形态（如 九年级\_索引.json）完全一致，生成器直接认，不用改它。
 *
 * 用法：
 *   node _建学生.mjs --name 小明 --grade 七年级
 *   node _建学生.mjs --name 小明                  （年级留空）
 *   node _建学生.mjs --name 小明 --grade 七年级 --json
 *
 * 退出码：0=建好（或就是同一个孩子，幂等）；2=参数/冲突被拒；1=其它错误。
 */
import fs from 'fs';
import path from 'path';
import { libraryRoot } from './_库根.mjs';
import { writeJsonAtomic } from './_安全写.mjs';

const ROOT = libraryRoot();
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const valOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = has('--json');

const name = String(valOf('--name', '') || '').trim();
const grade = String(valOf('--grade', '') || '').trim();

function die(msg, code = 2) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else console.error('✖ ' + msg);
  process.exit(code);
}

/* ---------- 参数校验（姓名会变成磁盘目录名，宁严不松）---------- */
if (!name) die('缺少 --name（孩子叫什么）');
const BAD = /[\\/:*?"<>|\r\n\t]/;
if (BAD.test(name)) die('姓名不能包含这些字符：\\ / : * ? " < > |');
if (name.length > 20) die('姓名太长（最多 20 字）');
if (name === '.' || name === '..') die('姓名不能是 . 或 ..');
if (/^[._]/.test(name)) die('姓名不能以 . 或 _ 开头（下划线开头是程序保留区，生成器会跳过）');
if (grade) {
  if (BAD.test(grade)) die('年级不能包含这些字符：\\ / : * ? " < > |');
  if (grade.length > 20) die('年级太长（最多 20 字）');
  if (/^[._]/.test(grade)) die('年级不能以 . 或 _ 开头');
}

/* ---------- 重名检查（与 生成状态.mjs 同口径：扫两层找 _索引.json 比 student 字段）---------- */
function findIndexes(base, depth) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const dir = path.join(base, e.name);
    const idx = path.join(dir, '_索引.json');
    if (fs.existsSync(idx)) out.push(idx);
    if (depth > 1) out.push(...findIndexes(dir, depth - 1));
  }
  return out;
}
const readJson = (p) => {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return JSON.parse(t);
};

const stuDir = path.join(ROOT, name);
const idxPath = path.join(stuDir, '_索引.json');

/* 已经就是这个孩子（同目录同名）→ 幂等；若这次带了年级而之前没填/不同，顺手补上 */
if (fs.existsSync(idxPath)) {
  let cur = null;
  try { cur = readJson(idxPath); } catch { }
  if (cur && String(cur.student || '').trim() === name) {
    let updated = false;
    if (grade && String(cur.grade || '') !== grade) {
      /* 只补/改年级，绝不动 subjects（那是人家的题库） */
      cur.grade = grade;
      cur.updatedAt = new Date().toISOString();
      try { writeJsonAtomic(idxPath, cur, { backup: false }); updated = true; } catch { /* 补年级失败不致命 */ }
    }
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify({
        ok: true, existed: true, updated, student: name, grade: cur.grade || '',
        index: path.relative(ROOT, idxPath).split(path.sep).join('/'),
        subjects: Object.keys(cur.subjects || {}),
      }) + '\n');
    } else {
      console.log('ℹ 已经有「' + name + '」了' + (updated ? '（已把年级补成 ' + grade + '）' : '，无需重复创建') + '：' + idxPath);
    }
    process.exit(0);
  }
  die('目录「' + name + '」已存在，里面还有一份不认识的 _索引.json（student=' + (cur && cur.student) + '）。' +
    '请换个名字，或先手工核对那个目录。');
}

/* 别处已有同名学生（历史库目录名可能是 <年级>-<姓名>）→ 拒 */
for (const f of findIndexes(ROOT, 2)) {
  let j = null;
  try { j = readJson(f); } catch { continue; }
  if (String(j.student || '').trim() === name) {
    die('库里已经有叫「' + name + '」的孩子了（' + (j.grade || '未设年级') + '，目录 ' +
      path.relative(ROOT, path.dirname(f)) + '）。同名会让界面把两个身份合成一个，' +
      '请换个小名区分（比如「' + name + '2」）。');
  }
}

/* ---------- 落盘 ---------- */
const now = new Date();
const today = now.toISOString().slice(0, 10);
const doc = {
  student: name,
  grade: grade || '',
  subjects: {},
  note: '由「新建学生」创建（' + today + '）。学科不用现在定；录哪门课的题，那门课就自动出现在题库与统计里。',
  updatedAt: now.toISOString(),
};

try {
  fs.mkdirSync(stuDir, { recursive: true });
  writeJsonAtomic(idxPath, doc, { backup: false });
} catch (e) {
  die('建目录/写索引失败：' + String((e && e.message) || e), 1);
}

/* ---------- 回读自检 ---------- */
try {
  const back = readJson(idxPath);
  if (back.student !== name || !back.subjects || typeof back.subjects !== 'object' || Array.isArray(back.subjects)) {
    die('写完回读形状不对：' + JSON.stringify(back).slice(0, 200), 1);
  }
} catch (e) {
  die('写完回读失败：' + String((e && e.message) || e), 1);
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    ok: true, created: true, student: name, grade: grade || '',
    dir: name, index: path.relative(ROOT, idxPath).split(path.sep).join('/'),
    subjects: [],
  }) + '\n');
} else {
  console.log('✔ 已建学生：' + name + (grade ? '（' + grade + '）' : '（未设年级）'));
  console.log('  目录：' + name + path.sep);
  console.log('  学科不用现在定 —— 之后录哪门课的题，那门课就自动出现。');
}
