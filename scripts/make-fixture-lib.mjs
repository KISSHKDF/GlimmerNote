#!/usr/bin/env node
/**
 * make-fixture-lib.mjs — 生成「加厚合成测试库」（★ 2026-10-25）
 *
 * 与既有两份合成库的关系：
 *   · fixtures\库-最小 —— 最小门禁库（2 卡，只验"能跑通"）；
 *   · make-demo-lib.mjs —— 截图演示库（内容丰满，给 README 截图用）；
 *   · 本文件 —— **测试形状库**：目标是把"新克隆上只能 SKIP 的门禁"喂饱。
 *     形状清单（每条都对着一个此前 SKIP 的断言/门禁）：
 *       ① 同一学生同学科拆两份索引（neg-paper-split-subject-index 的现场形状）
 *       ② fig 兜底卡：有 配图.svg、题干.html 无内联图（e2e F-58）
 *       ③ 内联图卡：题干.html 带 <img src="题图.png">（e2e F-57 的相对图重写）
 *       ④ 原卷对位卡：_原卷台账 有真实盘上整页 + 归一化 box（_原卷台账 门禁的"有整页"路径）
 *       ⑤ 素材灭失卡：lost=true 豁免路径
 *       ⑥ 复习态铺满：未复习/复习中(半对)/已掌握/再错（复习流与统计的形状）
 *       ⑦ 待确认：有证据图+题号+像素 box（_待确认 证据/对位门禁）
 *       ⑧ 配图台账：need=true 且有图 / need=false / 题干提到"如图"且已登记
 *
 * 铁律（与 fixtures-smoke 同口径）：
 *   文本全部入库（索引/台账/题干/svg）；PNG 影像**运行时生成**、不进 git
 *   （.gitignore 挡全部 png；2026-10-25 刚堵上 fixtures png 反向口子，不许再开）。
 *   所以本脚本只写文本；PNG 由 tests\_合成库.cjs 物化时按 manifest 生成。
 *   manifest（_影像清单.json）是两者之间的契约：键=库内相对路径，值={kind,w,h,seed}。
 *
 * 用法：node scripts\make-fixture-lib.mjs --out fixtures\库-形状
 *   （目录整个重建；最后用真生成器 生成状态.mjs 产 _状态.json 并断言 dataHealth 全 ok）
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, 'fixtures', '库-形状');
})();
if (!out.includes(path.join(ROOT, 'fixtures'))) {
  console.error('[make-fixture-lib] ✖ --out 必须落在仓库 fixtures\\ 之下（文本入库铁律）');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/* ───────────────────────── 1. 影像清单（契约：物化器按它生成 PNG） ───────────────────────── */
const IMGS = {};
function img(rel, kind, w, h, seed) { IMGS[rel] = { kind, w, h, seed }; return rel; }

/* ───────────────────────── 2. 卡池：10 张，逐条注明服务的形状 ─────────────────────────
 * 字段与 make-demo-lib 同源（生成器读同一套）；hasImage/fig 另行落在卡目录资产上。 */
const RD = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17'].map(d => d + 'T20:00:00+08:00');
const F = (id, slug, o) => Object.assign({ id, slug }, o);

/* 学生甲（九年级）· 数学索引（形状①：同学科拆两份索引——数学/物理是两份 _索引.json，
 * 目录形态：九年级-学生甲\数学\_索引.json + 九年级-学生甲\物理\_索引.json，同一 student） */
const M9 = [
  F('C0101', '有理数混合运算', {
    kp: '有理数运算', q: '计算 (−5)+3×(−2) = ____。', a: '−11', sa: '1', type: '填空题', cl: '技能', cc: 'S01', cd: '先加后乘', diff: '易',
    stem: '<p>计算 <b>(−5)+3×(−2)</b> = ____。</p>',
    shape: '复习中·半对', reviews: [RD[0], RD[1], RD[2]], lastPass: false, half: true,
  }),
  F('C0102', '一元二次方程判别式', {
    kp: '一元二次方程', q: '方程 x²−4x+m=0 有两个不相等实根，求 m 的取值范围。', a: 'm<4', sa: 'm≤4', type: '解答题', cl: '知识', cc: 'K01', cd: '漏排等于零', diff: '中',
    stem: '<p>关于 x 的方程 <b>x²−4x+m=0</b> 有两个不相等的实数根，求 m 的取值范围。</p>',
    shape: '未复习', reviews: [],
  }),
  F('C0103', '反比例函数过点', {
    kp: '反比例函数', q: '反比例函数 y=k/x 经过点 (3,−2)，则 k = ____。', a: '−6', sa: '6', type: '填空题', cl: '知识', cc: 'K02', cd: 'k=xy 记反', diff: '易',
    stem: '<p>反比例函数 <b>y=k/x</b> 的图像经过点 (3, −2)，则 k = ____。</p>',
    shape: '已掌握', reviews: [RD[0], RD[1], RD[2], RD[3]], lastPass: true, mastered: true,
  }),
  /* 形状③：题干内联 <img src="题图.png">（F-57 相对图重写的样本）。
   * 配图门禁的 FIG_ASSETS 只认 题图.jpg/题干.jpg、hasInlineFig 只看题干.html 里的
   * svg/img/table 标签——本卡的 <img> 标签就在题干里，所以 need=true 天然满足（inline 判定过）；
   * 图文件本体由清单物化（题图.png），门禁不检查它的字节，只检查显示链路（F-57 才查）。 */
  F('C0104', '函数图像读点', {
    kp: '一次函数', q: '如图，直线经过点 (1,2)，求它的解析式。', a: 'y=2x', sa: 'y=x+2', type: '解答题', cl: '审式', cc: 'W01', cd: '把斜率当成截距', diff: '中',
    stem: '<p>如图，直线经过点 (1, 2)。</p><p><img src="题图.png" alt="直线图像"></p>',
    shape: '未复习', reviews: [], inlineImg: '题图.png',
    figWords: true,   // 题干提到"如图" ⇒ 配图台账必须登记 need=true（门禁 L2）
  }),
  /* 形状②：fig 兜底——题干.html 里放**内联 svg**（hasInlineFig 的判定就是题干里出现 <svg），
   * 卡目录同时保留独立 配图.svg（生成状态 读它产生 fig 字段，喂 F-58 的 fig 兜底链路）。 */
  F('C0105', '几何示意图求角', {
    kp: '平行线性质', q: '如图，AB∥CD，∠1=55°，求∠2 的度数。', a: '125°', sa: '55°', type: '填空题', cl: '知识', cc: 'K01', cd: '同位角与内错角混', diff: '易',
    stem: '<p>如图，AB∥CD，∠1=55°，求 ∠2 的度数。</p><svg xmlns="http://www.w3.org/2000/svg" width="220" height="60"><line x1="10" y1="50" x2="210" y2="50" stroke="#333"/><line x1="60" y1="10" x2="120" y2="50" stroke="#333" stroke-width="2"/></svg>',
    shape: '复习中·再错', reviews: [RD[0], RD[1]], lastPass: false, figSvg: true, figInlineSvg: true,
    figWords: true,
  }),
  /* 形状⑧：题干提到图但**明确无需图**（文字自足；配图台账 need=false 的样本） */
  F('C0106', '统计表读数', {
    kp: '数据统计', q: '下表是某次测验成绩：85、90、78、90，则众数是 ____。', a: '90', sa: '85', type: '填空题', cl: '审式', cc: 'W01', cd: '众数与中位数混', diff: '易',
    stem: '<p>下表是某次测验成绩：85、90、78、90，则众数是 ____。</p>',
    shape: '未复习', reviews: [],
    figWordsTable: true, figNeedFalse: true,
  }),
  /* 形状②（纯 fig 兜底）：题干**纯文字**、卡目录放 配图.svg（生成状态 读它产生 fig 字段，
   * e2e F-58 的"有 fig 且题干无内联图必须补出题图"就吃这张卡）。
   * 注意：这种卡过不了配图门禁的 need=true 判定（FIG_ASSETS 只认 jpg），所以台账记 need=false
   * ——配图门禁与 F-58 的 fig 兜底是两条独立链路，各吃各的样本，这里不硬凑同一张卡。 */
  F('C0107', '数轴表示解集', {
    kp: '不等式', q: '不等式 x>2 的解集在数轴上表示为：开口向右、从 2 起画空心圆圈。请描述画法。', a: '向右开口，2 处空心', sa: '向左开口', type: '解答题', cl: '知识', cc: 'K01', cd: '空心实心混淆', diff: '易',
    stem: '<p>不等式 x&gt;2 的解集在数轴上如何表示？请描述画法。</p>',
    shape: '未复习', reviews: [], figSvg: true,
  }),
];
/* 学生甲 · 物理索引（形状①的第二份索引；同一 student=学生甲） */
const P9 = [
  /* 形状④：原卷对位卡——台账登记整页 + 归一化 box，整页 PNG 运行时生成 */
  F('C0201', '浮力与密度综合', {
    kp: '浮力', q: '物体浸没在水中，排开水的体积是 2×10⁻⁴ m³，求浮力大小。（g=10N/kg）', a: '2N', sa: '20N', type: '计算题', cl: '技能', cc: 'S01', cd: '体积单位没换算', diff: '中',
    stem: '<p>物体浸没在水中，排开水的体积是 <b>2×10⁻⁴ m³</b>，求浮力大小（g=10N/kg）。</p>',
    shape: '复习中', reviews: [RD[0], RD[1]], lastPass: true,
    origPage: true,
  }),
  /* 形状⑤：素材灭失——lost=true（豁免路径样本） */
  F('C0202', '欧姆定律动态电路', {
    kp: '欧姆定律', q: '电源电压 6V，定值电阻 10Ω，串联滑动变阻器（0~20Ω），电流最小是多少？', a: '0.2A', sa: '0.6A', type: '计算题', cl: '技能', cc: 'S02', cd: '没取最大电阻', diff: '中',
    stem: '<p>电源电压 6V，定值电阻 10Ω，串联滑动变阻器（0~20Ω），电流最小是多少？</p>',
    shape: '未复习', reviews: [],
    lost: true,
  }),
];
/* 学生乙（八年级）· 单学科索引（对照组：不拆分；目录形态 八年级-学生乙\_索引.json，subjects 两门） */
const E8 = [
  F('C0301', '全等三角形判定', {
    kp: '全等三角形', q: '两边和它们的夹角对应相等的两个三角形 ____。', a: '全等', sa: '相似', type: '填空题', cl: '知识', cc: 'K01', cd: 'SAS 记成 SSA', diff: '中',
    stem: '<p>两边和它们的<b>夹角</b>对应相等的两个三角形 ____。</p>',
    shape: '复习中·半对', reviews: [RD[1], RD[2]], lastPass: false, half: true,
  }),
  F('C0302', '英语一般过去时', {
    kp: '一般过去时', q: 'He ____ (visit) the museum last week.', a: 'visited', sa: 'visits', type: '填空题', cl: '知识', cc: 'K01', cd: 'last week 没触发过去时', diff: '易',
    stem: '<p>He ____ (visit) the museum last week.</p>',
    shape: '未复习', reviews: [],
  }),
];

/* ───────────────────────── 3. 落盘：目录 / 索引 / 卡资产 ───────────────────────── */
const allCards = [];    // {stu, subject, it}
const figLedger = { note: '合成形状库：配图台账（make-fixture-lib 生成，形状⑧）', cards: {} };
const origLedger = { note: '合成形状库：原卷台账。page 指向运行时生成的 PNG（见 _影像清单.json）。', cards: {} };

function buildIndex(student, grade, subjects) {
  /* subjects: [[学科, 卡池], ...]；split=true 时每学科一份独立 _索引.json（形状①的现场） */
  const mk = (pool, flat) => {
    /* flat=true：拆分索引形态（真库实证：学生目录的学科子目录里放 _索引.json，
       用顶层 subject + 扁平 items——不是 subjects 映射。形态依据见本仓
       tests\neg-paper-split-subject-index.cjs 的事故现场描述）；
       flat=false：合集索引形态（subjects 映射）。两种形态门禁走不同解析路径，都得有样本。 */
    const idx = { student, grade, note: '合成形状数据（make-fixture-lib.mjs 生成），非真实题库。', updatedAt: '2026-10-25T00:00:00+08:00' };
    if (flat) idx.subject = pool[0][0];
    else idx.subjects = {};
    for (const [sj, cards] of pool) {
      const items = [];
      for (const c of cards) {
      const n = c.reviews.length;
      const rs = c.reviews.map((at, i) => ({ at, pass: i < n - 1 ? true : (c.half ? true : c.lastPass), mode: '到期待复习' }));
      if (c.half && n) rs[n - 1].pass = true;         // 半对：最后一次判"对"但前序有错（errorCount 体现）
      const mastered = !!c.mastered;
      const it = {
        id: c.id, dir: c.id + '-' + c.slug, source: '合成样例·单元卷' + (1 + (n % 3)) + ' 第' + (1 + (n % 9)) + '题',
        sourceDate: '2026-09-0' + (1 + (n % 7)), type: c.type, question: c.q, answer: c.a, studentAnswer: c.sa,
        kpoints: [c.kp], causeLayer: c.cl, causeCode: c.cc, causeDesc: c.cd, causeConfirmed: true,
        difficulty: c.diff, errorCount: c.half ? 2 : (n ? 1 : 1), status: '在册', hasImage: !!(c.inlineImg || c.figSvg), hasVariants: false,
        reviews: rs, reviewStatus: mastered ? '已掌握' : (n ? '复习中' : '未复习'),
        reviewCount: n, passStreak: n ? (c.lastPass || c.half ? Math.max(1, n - 1) : 0) : 0,
        lastReviewedAt: n ? rs[n - 1].at : '',
        nextDue: mastered ? '' : (n ? '2026-10-24' : '2026-10-26'),
        masteredAt: mastered ? rs[n - 1].at : null,
        blindStatus: '已通过', blindSolveAt: '2026-09-01T21:00:00+08:00', blindSolver: '合成样例',
        blindNote: '', blindFingerprint: '0000000000000000',
        answerSource: '独立判卷', answerSourceNote: '合成样例，无真实来源',
      };
      items.push(it);
      allCards.push({ stu: student, subject: sj, it, spec: c });
      }
    if (flat) idx.items = items;
    else idx.subjects[sj] = { items };
    }
    return idx;
  };
  return {
    single: () => mk(subjects, false),
    perSubject: () => subjects.map(([sj, pool]) => ({ sj, idx: mk([[sj, pool]], true) })),
  };
}

function writeStudent(dirBase, student, grade, subjects, split) {
  const dir = path.join(out, dirBase);
  fs.mkdirSync(dir, { recursive: true });
  const built = buildIndex(student, grade, subjects);
  if (split) {
    /* 形状①：同学科拆两份索引——每个学科目录一份 _索引.json（单 subjects 键） */
    for (const { sj, idx } of built.perSubject()) {
      fs.mkdirSync(path.join(dir, sj), { recursive: true });
      fs.writeFileSync(path.join(dir, sj, '_索引.json'), JSON.stringify(idx, null, 2) + '\n', 'utf8');
    }
  } else {
    fs.writeFileSync(path.join(dir, '_索引.json'), JSON.stringify(built.single(), null, 2) + '\n', 'utf8');
  }
  for (const [sj, pool] of subjects) {
    for (const c of pool) {
      const cardDir = path.join(dir, sj, c.id + '-' + c.slug);
      fs.mkdirSync(cardDir, { recursive: true });
      fs.writeFileSync(path.join(cardDir, '题干.html'), c.stem + '\n', 'utf8');
      const rel = path.posix.join(dirBase, sj, c.id + '-' + c.slug);
      const key = student + '|' + c.id;
      /* 形状③：内联题图（PNG 运行时生成 → 清单登记） */
      if (c.inlineImg) img(path.posix.join(rel, c.inlineImg), 'figure', 180, 180, c.id);
      /* 形状②：配图.svg（文本，直接入库；生成状态 会把它读成 fig 字段） */
      if (c.figSvg) {
        fs.writeFileSync(path.join(cardDir, '配图.svg'),
          `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="140" viewBox="0 0 220 140">
  <rect x="8" y="8" width="204" height="124" fill="none" stroke="#333" stroke-width="2"/>
  <line x1="30" y1="30" x2="190" y1="110" stroke="#333" stroke-width="2"/>
  <text x="96" y="24" font-size="14" fill="#333">AB ∥ CD 示意</text>
</svg>
`, 'utf8');
      }
      /* 形状④：原卷整页 + 归一化 box（PNG 运行时生成；登记进 _原卷台账） */
      if (c.origPage) {
        const page = path.posix.join(grade, '原卷', c.id + '-整页.png');
        img(page, 'paper', 240, 320, c.id);
        origLedger.cards[key] = {
          page, box: [0.08, 0.12, 0.84, 0.20], import: null,
          by: 'make-fixture-lib', note: '合成形状：有整页+box（形状④）',
        };
      }
      /* 形状⑤：素材灭失。无母本的卡一律走 lost 豁免——门禁里不存在"page:null 且合法"的态：
         每张卡要么有真实整页，要么显式 lost（豁免但永久可见），没有第三条路。 */
      if (!origLedger.cards[key]) origLedger.cards[key] = { page: null, box: null, import: null, by: 'make-fixture-lib', note: c.lost ? '合成形状：素材灭失豁免' : '合成形状：无母本，显式 lost', lost: true };

      /* 配图台账（形状⑧的三种态）。
         C0105/C0107 的题干含图词（如图/数轴）：C0105 题干有内联 svg → need=true 过门禁；
         C0107 纯文字 + 独立 配图.svg → 配图门禁的 FIG_ASSETS 不认 svg 文件，need 必须 false
         （配图门禁与 e2e F-58 的 fig 兜底是两条独立链路，样本分开养，见卡池注释）。 */
      if (c.figWords) figLedger.cards[key] = { need: true, kind: c.figSvg && !c.figInlineSvg ? 'svg' : (c.figSvg ? 'svg' : 'jpg'), ref: '', note: '题干提到图，必须有图', by: 'make-fixture-lib', date: '2026-10-25' };
      else if (c.figNeedFalse || (c.figSvg && !c.figInlineSvg)) figLedger.cards[key] = { need: false, kind: 'svg', ref: '配图.svg', note: '图走 fig 兜底链路（生成状态→前端 F-58），配图门禁侧无需图', by: 'make-fixture-lib', date: '2026-10-25' };
      else figLedger.cards[key] = { need: false, kind: 'none', ref: '', note: '纯文字题', by: 'make-fixture-lib', date: '2026-10-25' };
    }
  }
}

/* 形状①：学生甲拆两份学科索引 → 九年级-学生甲\数学\_索引.json + 九年级-学生甲\物理\_索引.json（同一 student） */
writeStudent('九年级-学生甲', '学生甲', '九年级', [['数学', M9], ['物理', P9]], true);
/* 对照：学生乙单索引两学科 → 八年级-学生乙\_索引.json */
writeStudent('八年级-学生乙', '学生乙', '八年级', [['数学', [E8[0]]], ['英语', [E8[1]]]], false);

/* ───────────────────────── 4. 根台账 ───────────────────────── */
fs.writeFileSync(path.join(out, '_原卷台账.json'), JSON.stringify(origLedger, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(out, '_配图台账.json'), JSON.stringify(figLedger, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(out, '_组卷台账.json'), JSON.stringify({
  note: '合成形状库：组卷台账（含 paperSeq 水印形状）。',
  batches: [
    { paperId: 'P20261017-01', date: '2026-10-17', student: '学生甲', subject: '数学', title: '错题重做卷·合成形状一', items: ['C0101', 'C0103'], status: '已批改', results: { C0101: '半对', C0103: '对' }, note: '合成批次' },
  ],
  paperSeq: { 'P20261017': 1 },
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(out, '_盲解双路.json'), JSON.stringify({
  note: '合成形状库：盲解双路。',
  lanes: Object.fromEntries(allCards.map(c => [c.stu + '|' + c.it.id, {
    lane1: { verdict: '已通过', at: '2026-09-01', solver: '合成样例第1路', note: '独立求解与录入一致' },
    lane2: { verdict: '已通过', at: '2026-09-01', solver: '合成样例第2路', note: '独立复算一致' },
  }])),
}, null, 2) + '\n', 'utf8');
/* 待确认：带证据图 + 题号 + 像素 box（形状⑦）。证据图=运行时生成的待办裁图 PNG。 */
{
  const evRel = '九年级-学生甲/数学/待办证据/T101.png';
  img(evRel, 'crop', 480, 160, 'T101');
  fs.writeFileSync(path.join(out, '_待确认.json'), JSON.stringify({
    note: '合成形状库：待确认台账（带证据图/题号/像素 box）。',
    items: [{
      id: 'T101', cardId: 'C0101', student: '学生甲', subject: '数学', kind: '笔迹归属',
      askWho: '孩子', question: '这步 −5+3 的结果是多少？请孩子口述。',
      qRef: '第3题', box: '40,30,380,90', detail: '合成样例：字迹较潦草', source: '合成样例',
      raisedAt: '2026-10-20', status: '未确认', answer: '', resolvedAt: '', evidence: evRel,
    }],
    seq: 101, updatedAt: '2026-10-25T00:00:00+08:00',
  }, null, 2) + '\n', 'utf8');
}
fs.writeFileSync(path.join(out, '_词表.md'), '# 词表（合成形状库）\n\n（空。测试不需要内容。）\n', 'utf8');
/* 影像清单最后写：所有 img() 调用（含待办证据图）都结束后才算契约完整——
   曾经写在文件中部，T101 的证据图就漏在清单外（物化器看不到 → 盘上没图 → 证据门禁红）。 */
fs.writeFileSync(path.join(out, '_影像清单.json'), JSON.stringify({ note: '合成影像清单（契约）：tests\\_合成库.cjs 按 kind/w/h/seed 现场生成 PNG；PNG 不进 git。', files: IMGS }, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(out, '_待确认清单.md'), '# 待确认清单（合成形状库）\n\n由工具刷新；此处占位。\n', 'utf8');
fs.writeFileSync(path.join(out, '_复习队列.md'), '# 复习队列（合成形状库）\n\n由工具刷新；此处占位。\n', 'utf8');
fs.writeFileSync(path.join(out, '_笔形台账.json'), JSON.stringify({ note: '合成形状库：笔形台账占位。', entries: {} }, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(out, '_页码映射.json'), JSON.stringify({ note: '合成形状库：页码映射占位。', en: {}, chem: {} }, null, 2) + '\n', 'utf8');

/* ───────────────────────── 5. 真生成器产 _状态.json + 自检 ───────────────────────── */
execFileSync(process.execPath, [path.join(ROOT, 'src', 'tools', '生成状态.mjs'), '--data', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const state = JSON.parse(fs.readFileSync(path.join(out, '_状态.json'), 'utf8'));
const badH = Object.entries(state.dataHealth || {}).filter(([, v]) => v !== 'ok');
if (badH.length) { console.error('[make-fixture-lib] ✖ 生成器报数据源降级：' + JSON.stringify(Object.fromEntries(badH))); process.exit(1); }

/* 形状完备性自检：8 类形状缺一即红（判据有牙齿——这是物化门禁能跑绿的前提） */
const shapeCheck = {
  '①同学科拆索引': fs.existsSync(path.join(out, '九年级-学生甲', '数学', '_索引.json')) && fs.existsSync(path.join(out, '九年级-学生甲', '物理', '_索引.json')) && !fs.existsSync(path.join(out, '九年级-学生甲', '_索引.json')),
  '②fig兜底卡(配图.svg+题干无内联图)': allCards.some(c => c.spec.figSvg && !c.spec.figInlineSvg && !c.spec.figWords),
  '③内联图卡(题干.html 带 img)': allCards.some(c => !!c.spec.inlineImg),
  '④原卷对位(page+box)': Object.values(origLedger.cards).some(e => e.page && e.box),
  '⑤素材灭失(lost)': Object.values(origLedger.cards).some(e => e.lost),
  '⑥复习态铺满(未复习/复习中/已掌握)': ['未复习', '复习中', '已掌握'].every(s => allCards.some(c => c.it.reviewStatus === s)),
  '⑦待确认带证据图+题号+box': (() => { const j = JSON.parse(fs.readFileSync(path.join(out, '_待确认.json'), 'utf8')); const t = j.items[0]; return !!(t && t.evidence && t.qRef && t.box); })(),
  '⑧配图台账三态': (() => { const vs = Object.values(figLedger.cards); return vs.some(e => e.need === true) && vs.some(e => e.need === false); })(),
};
let bad = 0;
for (const [k, ok] of Object.entries(shapeCheck)) { console.log((ok ? '  [OK]  ' : '  [FAIL] ') + k); if (!ok) bad++; }

console.log('\n[make-fixture-lib] ✔ 形状库已生成：' + out);
console.log('  学生 学生甲(数学/物理 拆索引)、学生乙(数学/英语 单索引)｜卡 ' + allCards.length + ' 张｜影像清单 ' + Object.keys(IMGS).length + ' 项｜dataHealth 全 ok');
process.exit(bad ? 1 : 0);
