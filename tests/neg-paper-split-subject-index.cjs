#!/usr/bin/env node
/**
 * 阴性对照：同一学生按学科拆多个索引文件时，组卷必须选对索引（2026-10-25 用户实测报障）
 *
 * 现场：七年级-某学生\数学\_索引.json 与 七年级-某学生\英语\_索引.json 都写着同一个 student。
 * findIndexFile 旧实现取**扫描序第一个**（readdir 字母序「数学」排在「英语」前面），
 * 于是该学生的第一张英语卷必炸「库中不存在编号 E00xx」；前端又只留 stderr 尾部 400 字，
 * 界面上是一段没有原因行的裸堆栈（用户 2026-10-25 02:00 截图）。
 * 历史台账 3 批（语文/化学/数学）恰好全是"单索引库或字母序第一份索引"，所以一直没暴露。
 *
 * 手法（同 neg-paper-no-repeat）：真跑工具，跑在 makeTempLib 副本上，真库一个字节不碰。
 * 构造：给副本库里某真学生**额外**塞一份 readdir 排序在前、同名学生、**学科不同** 的小索引
 *       （精确复刻"subject 不匹配 + 排序在前"两个中招前提），然后用该学生**真实编号**组卷——
 *       旧行为必选错（炸「库中不存在编号」），新行为按「subject 命中 + ids 覆盖数」选对并真入账。
 * 变异自证：把 findIndexFile 调用点的 prefer 掏掉（= 退回"取第一个"旧行为），同一条命令必须变红；
 *       这证明正例的通过确实来自新选择逻辑，而不是别的门禁恰好放行。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const A = (label, ok, extra = '') => {
  if (ok) { pass++; console.log('  [OK]  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + extra : '')); }
};

const toolPath = path.join(ROOT, 'src', 'tools', '_标记复习.mjs');
const TOOL_SRC = fs.readFileSync(toolPath, 'utf8');
const BLIND_OK = ['已通过', '已修正'];

/* ── 副本库注入：同名学生、排序在前、学科与真索引不同的小索引（复刻现场前提）──
   目录名前缀 'aaa' 确保 readdir 扫描序在所有真实学生目录之前，
   绝不硬编码真实目录名/真实编号（B-09 同款纪律）。 */
function injectSplitIndex(tmp, student, otherSubject) {
  const dir = path.join(tmp, 'aaa拆分-' + student);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_索引.json'), JSON.stringify({
    student, subject: otherSubject,
    note: '回归测试合成：同名学生拆分索引，编号故意与真库不重叠（ZZZZ 开头）',
    items: [{ id: 'ZZZZ01', dir: 'ZZZZ01', subject: otherSubject, question: '（合成占位卡）', answer: '0', status: '在册', blindStatus: '已通过' }],
  }, null, 2), 'utf8');
  return dir;
}

/* 从一份真索引里挑"同一学科、已过盲解门禁"的前 n 个真实编号。
   （防重复门禁用 --no-repeat-days 0 显式关闭，不与真台账日期耦合。） */
function pickSample(tmp, idxRel, n) {
  const j = JSON.parse(fs.readFileSync(path.join(tmp, idxRel), 'utf8').replace(/^\uFEFF/, ''));
  const rows = [];
  if (j.subjects) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) rows.push([it, sn]);
  else for (const it of (j.items || [])) rows.push([it, j.subject || '']);
  const ok = rows.filter(([it]) => BLIND_OK.indexOf(it.blindStatus || '') >= 0 && it.id);
  if (!ok.length) return null;
  const subject = ok[0][1];
  const ids = ok.filter(([, sn]) => sn === subject).slice(0, n).map(([it]) => it.id);
  return { student: j.student, subject, ids };
}

function main() {
  console.log('═══ ① 场景构造：真库副本 + 注入"排在前面的同名、异学科小索引" ═══');
  /* copyCardFiles：侧车（题干/错题记录）+ mtime 保留，盲解指纹门禁才不会误拦（踩过的坑，同 no-repeat） */
  const tmp = E.makeTempLib(null, { copyCardFiles: true });
  try {
    const idxRels = E.findIndexes(tmp);
    if (!idxRels.length) { console.log('✖ 副本库里没有可用索引（库不完整），无法构造场景'); process.exit(1); }
    let sample = null;
    for (const rel of idxRels) { sample = pickSample(tmp, rel, 3); if (sample) break; }
    if (!sample) { console.log('✖ 副本库里找不到"已过盲解门禁"的真实编号，无法构造正例'); process.exit(1); }
    A('素材：找到同名学生 + 同学科真实编号（判据不是恒假）',
      sample.student && sample.subject && sample.ids.length > 0,
      sample.student + ' / ' + sample.subject + ' / ' + sample.ids.join(','));

    const other = sample.subject === '数学' ? '英语' : '数学';
    const injectDir = injectSplitIndex(tmp, sample.student, other);
    A('前提复刻：注入目录在扫描序上排在真实学生目录之前（readdir）',
      fs.readdirSync(tmp).indexOf(path.basename(injectDir)) <
      fs.readdirSync(tmp).findIndex(n => fs.existsSync(path.join(tmp, n, '_索引.json')) && n !== path.basename(injectDir)),
      path.basename(injectDir) + ' subject=' + other);

    const run = args => E.runToolSync('_标记复习.mjs', args, { data: tmp });
    const ledgerAt = () => { const p = path.join(tmp, '_组卷台账.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { batches: [] }; };

    console.log('\n═══ ② 正例：subject+ids 参与选索引 → 用真实编号组卷成功入账（只动副本）═══');
    {
      const before = ledgerAt().batches.length;
      const r = run(['组卷', '--student', sample.student, '--subject', sample.subject,
        '--ids', sample.ids.join(','), '--no-repeat-days', '0']);
      A('★ 同名学生多索引下，组"扫描序不靠前"学科的卷 → 不再炸「库中不存在编号」',
        !/库中不存在编号/.test(r.err || ''), 'exit=' + r.code);
      A('入账成功 exit 0 且打出台批次号', r.code === 0 && /已入账 P\d{8}-\d{2}/.test(r.out || ''),
        String(r.out || '').split('\n')[0].slice(0, 80));
      const led = ledgerAt();
      A('副本台账多了一个批次（真写进台账，不是空转）', led.batches.length === before + 1,
        before + ' → ' + led.batches.length);
      A('批次学科 = 调用方 --subject', led.batches.length > before &&
        led.batches[led.batches.length - 1].subject === sample.subject,
        String((led.batches[led.batches.length - 1] || {}).subject || ''));
    }

    console.log('\n═══ ③ 报错可读性：真不存在的编号，报错必须带索引文件定位（防下一次裸堆栈）═══');
    {
      const r = run(['组卷', '--student', sample.student, '--subject', sample.subject,
        '--ids', 'ZZZZ99', '--no-repeat-days', '0']);
      A('不存在的编号 exit 非 0', r.code !== 0, 'exit=' + r.code);
      A('★ 错误行指名编号 + 所查索引（一行看得懂，不再靠截尾部盲猜）',
        /库中不存在编号 ZZZZ99/.test(r.err || '') && /_索引\.json/.test(r.err || ''),
        String(r.err || '').split('\n').filter(l => /Error/.test(l))[0].slice(0, 110));
    }

    console.log('\n═══ ④ 变异自证：掏掉 prefer（退回"取第一个"旧行为）→ ② 的命令必须变红 ═══');
    {
      const callRe = /findIndexFile\(opt\.student, \{ subject: opt\.subject, ids \}\)/;
      A('前置：变异点存在且唯一', (TOOL_SRC.match(callRe) || []).length === 1);
      const mutSrc = TOOL_SRC.replace(callRe, 'findIndexFile(opt.student)');
      A('前置：变异后调用点退回单参', mutSrc !== TOOL_SRC && /findIndexFile\(opt\.student\)/.test(mutSrc));

      const tmp2 = E.makeTempLib(null, { copyCardFiles: true });
      const uniq = path.join(tmp2, path.basename(injectDir));
      fs.copyFileSync(path.join(tmp, '_组卷台账.json'), path.join(tmp2, '_组卷台账.json'));
        injectSplitIndex(tmp2, sample.student, other);
        const bak = toolPath + '.mutbak';
        const before2 = JSON.parse(fs.readFileSync(path.join(tmp2, '_组卷台账.json'), 'utf8')).batches.length;
        try {
          fs.writeFileSync(bak, TOOL_SRC, 'utf8');
          fs.writeFileSync(toolPath, mutSrc, 'utf8');
          const r = E.runToolSync('_标记复习.mjs', ['组卷', '--student', sample.student,
            '--subject', sample.subject, '--ids', sample.ids.join(','), '--no-repeat-days', '0'], { data: tmp2 });
          const errLine = String(r.err || '').split('\n').filter(l => /Error/.test(l))[0] || '';
          A('★ 自证 · 旧行为下同一条命令报「库中不存在编号」（正例的通过确由新选择逻辑带来）',
            r.code !== 0 && /库中不存在编号/.test(r.err || ''),
            'exit=' + r.code + ' ' + errLine.slice(0, 100));
          const after2 = JSON.parse(fs.readFileSync(path.join(tmp2, '_组卷台账.json'), 'utf8')).batches.length;
          A('★ 自证 · 旧行为下没有写台账（拦在选索引，不落半批）', after2 === before2, before2 + ' → ' + after2);
        } finally {
          try { fs.writeFileSync(toolPath, TOOL_SRC, 'utf8'); } catch { }
          try { fs.unlinkSync(bak); } catch { }
          try { fs.rmSync(uniq, { recursive: true, force: true }); } catch { }
          try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch { }
        }
        A('变异源码已还原（不留半截改造）', fs.readFileSync(toolPath, 'utf8') === TOOL_SRC);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
  console.log('\nRESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + '  断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main();
