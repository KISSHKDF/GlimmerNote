#!/usr/bin/env node
/**
 * 生成「文档截图用合成演示库」（★ 2026-10-24 B-09 配套）
 *
 * 为什么存在：docs\images 的界面截图原先截自真实题库，真实学生名与真实卷面标题随之进了仓库。
 * 本脚本在任意目录生成一份**纯合成**演示库（2 名合成学生 / 18 张合成卡 / 复习历史铺满近两个月），
 * 供 scripts\make-doc-shots.mjs 重截截图 —— 仓库不再出现任何真实个人信息。
 * 数据形状与 fixtures\库-最小 同源（那是「最小门禁库」，这是「内容丰满的截图库」）。
 *
 * 用法：node scripts\make-demo-lib.mjs --out <目录>    （目录会被整个重建；缺省 %TEMP%\gn-demo-lib）
 * 最后一步用**真生成器**（src\tools\生成状态.mjs）产 _状态.json，并断言 dataHealth 全 ok。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'fixtures', '库-最小');

const out = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(os.tmpdir(), 'gn-demo-lib');
})();
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/* 1) 台账骨架直接复制 fixtures（形状已与各门禁工具的 readJsonStrict 约定对齐，2026-10-24 修过） */
for (const f of ['_待确认.json', '_配图台账.json', '_笔形台账.json', '_页码映射.json', '_词表.md', '_待确认清单.md', '_复习队列.md'])
  fs.copyFileSync(path.join(FIX, f), path.join(out, f));

/* 2) 合成卡内容（学科 → 题目池）。全部为编写的合成题，不含任何真实试卷内容。 */
const POOL = {
  数学9: [
    { id: 'A0001', slug: '有理数混合运算', kp: '有理数运算', q: '计算 (−12)+7×(−3) = ____。', a: '−33', sa: '−15', type: '填空题', cl: '技能', cc: 'S01', cd: '乘法运算漏了负号', diff: '易', stem: '<p>计算 <b>(−12)+7×(−3)</b> = ____。</p>' },
    { id: 'A0002', slug: '一元二次方程根的判别', kp: '一元二次方程', q: '关于 x 的方程 x²−2x+m=0 有两个不相等实根，求 m 的取值范围。', a: 'm<1', sa: 'm≤1', type: '解答题', cl: '知识', cc: 'K01', cd: '判别式等于零的情形没排除', diff: '中', stem: '<p>关于 x 的方程 <b>x²−2x+m=0</b> 有两个不相等的实数根，求 m 的取值范围。</p>' },
    { id: 'A0003', slug: '反比例函数图像', kp: '反比例函数', q: '反比例函数 y=k/x 的图像经过点 (2,−3)，则 k = ____。', a: '−6', sa: '6', type: '填空题', cl: '知识', cc: 'K02', cd: 'k=xy 记成了 k=x/y', diff: '易', stem: '<p>反比例函数 <b>y=k/x</b> 的图像经过点 (2, −3)，则 k = ____。</p>' },
    { id: 'A0004', slug: '圆周角定理', kp: '圆的性质', q: '同弧所对的圆周角等于圆心角的 ____。', a: '一半', sa: '两倍', type: '填空题', cl: '知识', cc: 'K01', cd: '圆周角与圆心角关系记反', diff: '易', stem: '<p>同弧所对的圆周角等于它所对圆心角的 ____。</p>' },
    { id: 'A0005', slug: '相似三角形判定', kp: '相似三角形', q: '两个角对应相等的两个三角形 ____（填判定依据）。', a: '相似', sa: '全等', type: '填空题', cl: '审式', cc: 'W01', cd: '把"相似"答成"全等"', diff: '中', stem: '<p>两个角对应相等的两个三角形 ____（填判定结论）。</p>' },
    { id: 'A0006', slug: '列表法求概率', kp: '概率', q: '掷两枚均匀硬币，恰好一正一反的概率是 ____。', a: '1/2', sa: '1/4', type: '填空题', cl: '知识', cc: 'K02', cd: '样本空间列漏了两种', diff: '中', stem: '<p>掷两枚均匀硬币，恰好一正一反的概率是 ____。</p>' },
  ],
  物理9: [
    { id: 'A0007', slug: '浮力方向', kp: '浮力', q: '浸没在水中的物体受到的浮力方向是 ____。', a: '竖直向上', sa: '竖直向下', type: '选择题', cl: '知识', cc: 'K01', cd: '浮力方向记反', diff: '易', stem: '<p>浸没在水中的物体受到的浮力方向是（　）</p><p>A. 竖直向下　B. 竖直向上　C. 与重力同向　D. 无法确定</p>' },
    { id: 'A0008', slug: '欧姆定律应用', kp: '欧姆定律', q: '一段导体两端电压 6V，电阻 12Ω，通过它的电流是 ____ A。', a: '0.5', sa: '2', type: '填空题', cl: '技能', cc: 'S01', cd: 'I=U/R 代成了 I=R/U', diff: '易', stem: '<p>一段导体两端电压 6V、电阻 12Ω，通过它的电流是 ____ A。</p>' },
    { id: 'A0009', slug: '电功率估算', kp: '电功率', q: '"220V 40W"的白炽灯正常发光 5h耗电 ____ kW·h。', a: '0.2', sa: '0.4', type: '填空题', cl: '技能', cc: 'S02', cd: '单位换算时乘了 2', diff: '中', stem: '<p>"220V 40W"的白炽灯正常发光 5 小时耗电 ____ kW·h。</p>' },
    { id: 'A0010', slug: '光的反射定律', kp: '光的反射', q: '反射角 ____ 入射角（填"等于"）。', a: '等于', sa: '大于', type: '填空题', cl: '知识', cc: 'K01', cd: '三线共面记混', diff: '易', stem: '<p>光的反射中，反射角 ____ 入射角。</p>' },
  ],
  数学8: [
    { id: 'B0001', slug: '全等三角形判定', kp: '全等三角形', q: '两边及其夹角对应相等的两个三角形 ____。', a: '全等', sa: '相似', type: '填空题', cl: '知识', cc: 'K01', cd: 'SAS 与 SSA 混淆', diff: '中', stem: '<p>两边及其<b>夹角</b>对应相等的两个三角形 ____。</p>' },
    { id: 'B0002', slug: '轴对称性质', kp: '轴对称', q: '成轴对称的两个图形 ____（填全等关系）。', a: '全等', sa: '面积相等但不全等', type: '填空题', cl: '审式', cc: 'W01', cd: '把轴对称当成了中心对称', diff: '易', stem: '<p>成轴对称的两个图形是 ____ 关系（就形状大小而言）。</p>' },
    { id: 'B0003', slug: '一次函数图像平移', kp: '一次函数', q: '直线 y=2x 向上平移 3 个单位后的解析式是 ____。', a: 'y=2x+3', sa: 'y=2(x+3)', type: '填空题', cl: '知识', cc: 'K02', cd: '上下平移加在 x 上', diff: '中', stem: '<p>直线 <b>y=2x</b> 向上平移 3 个单位后的解析式是 ____。</p>' },
    { id: 'B0004', slug: '勾股定理', kp: '勾股定理', q: '直角三角形两直角边 3 和 4，斜边 = ____。', a: '5', sa: '7', type: '填空题', cl: '技能', cc: 'S01', cd: '两直角边相加了', diff: '易', stem: '<p>直角三角形两直角边长为 3 和 4，斜边长 = ____。</p>' },
    { id: 'B0005', slug: '加权平均数', kp: '数据的分析', q: '数据 2、4、4、6 的平均数是 ____。', a: '4', sa: '4.5', type: '填空题', cl: '技能', cc: 'S02', cd: '求和时抄错一个 4', diff: '易', stem: '<p>数据 2、4、4、6 的平均数是 ____。</p>' },
  ],
  英语8: [
    { id: 'B0006', slug: '一般过去时', kp: '一般过去时', q: 'He ____ (go) to the library yesterday.', a: 'went', sa: 'goes', type: '填空题', cl: '知识', cc: 'K01', cd: ' yesterday 对应过去时没反应', diff: '易', stem: '<p>He ____ (go) to the library yesterday.</p>' },
    { id: 'B0007', slug: '形容词比较级', kp: '比较级', q: 'This box is much ____ (heavy) than that one.', a: 'heavier', sa: 'more heavy', type: '填空题', cl: '知识', cc: 'K02', cd: '重读闭音节双写加 er 忘了', diff: '中', stem: '<p>This box is much ____ (heavy) than that one.</p>' },
    { id: 'B0008', slug: '情态动词', kp: '情态动词', q: 'You ____ (can/must) finish your homework before dinner — it&apos;s a rule.', a: 'must', sa: 'can', type: '选择题', cl: '审式', cc: 'W01', cd: '没看后面的 it&apos;s a rule 提示', diff: '易', stem: '<p>You ____ finish your homework before dinner — it&apos;s a rule.（can / must）</p>' },
  ],
};

/* 3) 复习历史：让「今日总览/统计分析」有像样的热力与到期数据（全部合成日期） */
const REVIEW_DATES = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'];
function mkReviews(plan) {
  // plan: 复习次数 n、前几次 pass、最终态
  const out = [];
  for (let i = 0; i < plan.n; i++) {
    out.push({ at: REVIEW_DATES[i] + 'T20:00:00+08:00', pass: i < plan.n - 1 ? true : plan.last, mode: '到期待复习' });
  }
  return out;
}

const STUDENTS = [
  { name: '学生A', grade: '九年级', subjects: [['数学', '数学9'], ['物理', '物理9']] },
  { name: '学生B', grade: '八年级', subjects: [['数学', '数学8'], ['英语', '英语8']] },
];

const allCards = [];   // 供台账/断言用
for (const [si, stu] of STUDENTS.entries()) {
  const gradeDir = path.join(out, stu.grade);
  const idx = { student: stu.name, grade: stu.grade, note: '合成演示数据（make-demo-lib.mjs 生成），非真实题库。', updatedAt: '2026-10-24T00:00:00+08:00', subjects: {} };
  for (const [sj, poolKey] of stu.subjects) {
    const items = [];
    for (const [ci, c] of POOL[poolKey].entries()) {
      const k = si * 9 + ci;                        // 0..17，让两学生的复习节奏错开
      const plan = [
        { n: 4, last: true }, { n: 2, last: false }, { n: 1, last: true }, { n: 0 },     // 复习中/再错/复习中/未复习 循环铺开
        { n: 3, last: true }, { n: 0 }, { n: 2, last: true }, { n: 1, last: true }, { n: 0 },
      ][k % 9];
      const reviews = mkReviews(plan);
      const mastered = plan.n >= 3 && plan.last === true && k % 2 === 0;
      const it = {
        id: c.id, dir: c.id + '-' + c.slug, source: '合成样例·单元卷' + (1 + (k % 3)) + ' 第' + (1 + (k % 12)) + '题',
        sourceDate: REVIEW_DATES[(k * 3) % 9].slice(0, 10), type: c.type, question: c.q, answer: c.a, studentAnswer: c.sa,
        kpoints: [c.kp], causeLayer: c.cl, causeCode: c.cc, causeDesc: c.cd, causeConfirmed: true,
        difficulty: c.diff, errorCount: 1 + (k % 3), status: '在册', hasImage: false, hasVariants: false,
        reviews, reviewStatus: mastered ? '已掌握' : (reviews.length ? '复习中' : '未复习'),
        reviewCount: reviews.length, passStreak: reviews.length ? (plan.last ? Math.max(1, plan.n - 1) : 0) : 0,
        lastReviewedAt: reviews.length ? reviews[reviews.length - 1].at : '',
        nextDue: mastered ? '' : (reviews.length ? (k % 3 === 0 ? '2026-10-22' : '2026-10-2' + (5 + (k % 5))) : '2026-10-2' + (2 + (k % 4))),
        masteredAt: mastered ? reviews[reviews.length - 1].at : null,
        blindStatus: '已通过', blindSolveAt: REVIEW_DATES[(k * 2) % 9] + 'T21:00:00+08:00', blindSolver: '合成样例',
        blindNote: '', blindFingerprint: '0000000000000000',
        answerSource: '独立判卷', answerSourceNote: '合成样例，无真实来源',
      };
      items.push(it);
      allCards.push({ stu: stu.name, id: c.id, it });
      const cardDir = path.join(gradeDir, sj, it.dir);
      fs.mkdirSync(cardDir, { recursive: true });
      fs.writeFileSync(path.join(cardDir, '题干.html'), '\uFEFF' + c.stem + '\n', 'utf8');
    }
    idx.subjects[sj] = { items };
  }
  fs.writeFileSync(path.join(gradeDir, '_索引.json'), JSON.stringify(idx, null, 2) + '\n', 'utf8');
}

/* 4) 根 _索引 / 组卷台账（两学生各一条已批改合成批次）/ 原卷台账（逐卡占位，dataHealth 才不降级）/ 盲解双路（两路已通过） */
fs.writeFileSync(path.join(out, '_索引.json'), JSON.stringify({
  note: '合成演示库：仅供文档截图与人工体验，全部为合成数据，不含任何真实学生信息。',
  schemaVersion: 1, students: STUDENTS.map(s => s.name), grades: STUDENTS.map(s => s.grade),
  subjectDirs: Object.fromEntries(STUDENTS.flatMap(s => s.subjects.map(([sj]) => [s.grade + '/' + sj, sj]))),
  updatedAt: '2026-10-24T00:00:00+08:00',
}, null, 2) + '\n', 'utf8');

const fs_d = null;   // （日期用固定合成值，不取当天）
fs.writeFileSync(path.join(out, '_组卷台账.json'), JSON.stringify({
  note: '合成演示数据（make-demo-lib.mjs 生成）。', batches: [
    { paperId: 'P20261020-01', date: '2026-10-20', student: '学生A', subject: '数学', title: '错题重做卷·合成样例一', items: ['A0001', 'A0003', 'A0004'], status: '已批改', results: { A0001: '对', A0003: '对', A0004: '半对' }, note: '合成批次' },
    { paperId: 'P20261018-01', date: '2026-10-18', student: '学生B', subject: '数学', title: '错题重做卷·合成样例二', items: ['B0001', 'B0004'], status: '已批改', results: { B0001: '对', B0004: '错' }, note: '合成批次' },
  ],
}, null, 2) + '\n', 'utf8');

fs.writeFileSync(path.join(out, '_原卷台账.json'), JSON.stringify({
  note: '合成演示数据：全部卡无整页原卷（page=null），仅保证台账形状与逐卡在册。',
  cards: Object.fromEntries(allCards.map(c => [c.stu + '|' + c.id, { page: null, box: null, import: null, by: '合成样例', note: '合成数据无整页原卷' }])),
}, null, 2) + '\n', 'utf8');

fs.writeFileSync(path.join(out, '_盲解双路.json'), JSON.stringify({
  note: '合成演示数据（make-demo-lib.mjs 生成）。形状与 _盲解复核.mjs loadLanes 约定一致。',
  lanes: Object.fromEntries(allCards.map(c => [c.stu + '|' + c.id, {
    lane1: { verdict: '已通过', at: '2026-10-01', solver: '合成样例第1路', note: '独立求解与录入一致' },
    lane2: { verdict: '已通过', at: '2026-10-01', solver: '合成样例第2路', note: '独立复算一致' },
  }])),
}, null, 2) + '\n', 'utf8');

/* 5) 用真生成器产 _状态.json，并断言 dataHealth 全 ok */
const gen = execFileSync(process.execPath, [path.join(ROOT, 'src', 'tools', '生成状态.mjs'), '--data', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const state = JSON.parse(fs.readFileSync(path.join(out, '_状态.json'), 'utf8'));
const bad = Object.entries(state.dataHealth || {}).filter(([, v]) => v !== 'ok');
if (bad.length) {
  console.error('[make-demo-lib] ✖ 生成器报数据源降级：' + JSON.stringify(Object.fromEntries(bad)));
  process.exit(1);
}
console.log('[make-demo-lib] ✔ 演示库已生成：' + out);
console.log('  学生 ' + STUDENTS.map(s => s.name + '(' + s.subjects.map(([sj]) => sj).join('/') + ')').join('、') + '｜卡 ' + allCards.length + ' 张｜批次 2｜dataHealth 全 ok');
