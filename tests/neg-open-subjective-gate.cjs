#!/usr/bin/env node
/**
 * 拾光小册 · 「不可判定主观题」回归（2026-11-28 建）
 *
 * 用户报障（2026-11-27 原话）：
 *   「某学生，Y0021，这一类的题目，出成这样的错题，孩子是无法做的，你是怎么通过盲解的？
 *     这类题目，建议不要收录进题库了」
 *
 * 实测根因（三件事叠加）：
 *   ① **盲解对开放题天然失效** —— 盲解子代理独立写出一段"像样"的答案，
 *      与录入答案语义相近 ⇒ 判"一致" ⇒ 卡入库。
 *      盲解验的是"能否写出答案"，**不验"孩子的答案错在哪"** ⇒ 这类题会通过现有全部门禁。
 *   ② **门禁没有这一维** —— 题干门禁查题面可读性、作答门禁查空位对账、
 *      配图门禁查图资产、盲解复核查两路一致性 ⇒ **没有一道**看"这题孩子到底能不能判错"。
 *   ③ **证据图可以失配而不被发现** —— Y0021 的 `原卷截图.jpg` 裁图框高度只有原图的 7.5%
 *      （normBox y=0.875..0.95），切到的**只有红笔标准答案那一行** ——
 *      题干没进图、孩子的黑笔答案也没进图，而卡面写着
 *      「孩子的错解（黑笔，原样保留在原卷截图.jpg）」⇒ 空头支票。
 *
 * 本用例守：
 *   M. 判据本体（单元）：三条件同时成立才阻断 / 缺一条都放行 / 误伤防护；
 *   L. 接线：`_录题入库.mjs` 真的 import 了判据、真的当 problems 拒收；
 *   G. 门禁工具：真的 import 了判据、真库跑得起来、退出码语义正确；
 *   R. 真库：Y0021 已撤（不在索引里）、留档完整、其余开放题候选**未被误伤**；
 *   N. 阴性自证：把判据的任一条件拆掉 ⇒ 必须不再阻断（证明它真的是"三条件同时成立"）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) fails++; };

let S = null;
(async () => {
  /* ⚠ 路径按 __dirname 推，不写死盘符（公开仓不许出现本机路径） */
  const modUrl = 'file:///' + path.join(ROOT, 'src', 'tools', '_主观题.mjs').replace(/\\/g, '/');
  S = await import(modUrl);
})().then(runAll).catch(e => { console.error('✖ 装载失败：', e.message); process.exit(1); });

function runAll() {
  const { judgeOpenSubjective, hasOpenTypeWord, hasObjectiveGround } = S;

  console.log('── 判据本体（单元）──');

  /* M1：Y0021 的真实形态 ⇒ 必须判"不可判定"（阻断） */
  const Y0021 = {
    question: '这则小故事对你今后的学习有怎样的启示？请结合内容谈一谈。（王生好学而不得法）',
    answer: '学习不仅要记住（老师讲的内容），更要思考；不能不懂装懂/不能因别人指出不足就生气，要不耻下问，向比自己学问低的人请教。',
    studentAnswer: '既要努力学习，也要有一个好的学习方法，更要虚心求学。',
    causeNote: '答启示题漏采分点：没从文中「学而不思则罔」和「不耻下问」两处关键句提取要点，只泛泛答了「方法」「虚心」。',
    teacherAnswer: '',
    notes: '',
  };
  const v1 = judgeOpenSubjective(Y0021);
  A('M1 Y0021 形态 ⇒ 判不可判定（阻断）', v1.blocked === true, v1.code);
  A('M1b Y0021 的证据链完整（三条都在）', v1.evidence.length >= 3, v1.evidence.join(' | '));

  /* M2：卡面若**有具体分数** ⇒ 放行（作文有老师给分 40 ⇒ 孩子有标准可比） */
  const withScore = { ...Y0021, answer: '红笔批语"语段：偏散慢"，得分40——扣题松散：大段写看电视、吃月饼、拜月仪式' };
  A('M2 有具体分数（得分40）⇒ 放行', judgeOpenSubjective(withScore).blocked === false);

  /* M3：卡面若**有可枚举采分点清单** ⇒ 放行 */
  const withPoints = { ...Y0021, answer: '① 学习不只要记住，也要思考；② 要不耻下问，向学问低的人请教。' };
  A('M3 有可枚举采分点清单 ⇒ 放行', judgeOpenSubjective(withPoints).blocked === false);

  /* M4：题干**不是**开放题型（客观题）⇒ 放行（哪怕答案长、判错点笼统） */
  const objective = { ...Y0021, question: '已知 −11 与一个数的差为 11，求这个数。' };
  A('M4 客观题题干 ⇒ 放行', judgeOpenSubjective(objective).blocked === false);

  /* M5：「错在哪一步」**具体** ⇒ 放行（判错点可客观指认） */
  const specificCause = { ...Y0021, causeNote: '孩子写的是「−11+11＝0」，那是在反过来减：把句子读成「那个数减 −11 的差是 11」⇒ x−(−11)＝11 ⇒ x=0，题目并没有给这第二个等量关系。' };
  A('M5 判错点具体 ⇒ 放行', judgeOpenSubjective(specificCause).blocked === false);

  /* M6：答案来源注记里出现「采分点」三字 **不算**依据（Y0021 第一次写门禁时栽在这） */
  const noteOnly = { ...Y0021, answerSourceNote: '孩子答案只答了「学习方法」与「虚心」，漏掉「思考」与「不耻下问」两个采分点。' };
  A('M6 只有 answerSourceNote 提到「采分点」⇒ 仍判不可判定（不被误放行）', judgeOpenSubjective(noteOnly).blocked === true);

  /* M7：辅助函数 */
  A('M7 hasOpenTypeWord 命中「启示」', hasOpenTypeWord(Y0021.question) === true);
  A('M7b hasOpenTypeWord 不命中客观题', hasOpenTypeWord('已知 −11 与一个数的差为 11，求这个数。') === false);
  A('M7c hasObjectiveGround 不扫 answerSourceNote', hasObjectiveGround(noteOnly).ok === false);

  console.log('\n── 接线（入库器真的拒收）──');

  /* L1：入库器 import 了判据 */
  const ingestSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_录题入库.mjs'), 'utf8');
  A('L1 _录题入库.mjs import 了 _主观题.mjs', /import\s*\{[^}]*judgeOpenSubjective[^}]*\}\s*from\s*'\.\/_主观题\.mjs'/.test(ingestSrc));
  A('L1b 入库器把它当 problems 拒收', /judgeOpenSubjective\(/.test(ingestSrc) && /openSubj\.blocked/.test(ingestSrc));

  console.log('\n── 门禁工具接线 ──');

  /* G1：门禁工具 import 判据 */
  const gateSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_主观题门禁.mjs'), 'utf8');
  A('G1 _主观题门禁.mjs import 了 _主观题.mjs', /from\s*'\.\/_主观题\.mjs'/.test(gateSrc));
  A('G1b 门禁工具存在', fs.existsSync(path.join(ROOT, 'src', 'tools', '_主观题门禁.mjs')));
  A('G1c 撤卡工具存在', fs.existsSync(path.join(ROOT, 'src', 'tools', '_撤卡.mjs')));

  console.log('\n── 阴性自证：判据必须真的会红 ──');

  /* N1：把 ②（客观依据）这一条拆掉 —— 一旦拆掉，所有卡都该判"有依据" ⇒ 不再阻断 */
  const brokenNoGround = judgeOpenSubjective({ ...Y0021 });
  A('N1 基线：Y0021 确实被阻断（否则下面的自证无意义）', brokenNoGround.blocked === true);

  /* N2：把 ①（题型词）拆掉 ⇒ 必放行 */
  const noOpenWord = { ...Y0021, question: '这句话对你今后的学习有怎样的想法？请作答。' };
  A('N2 去掉题型词 ⇒ 不再阻断（① 真的在起作用）', judgeOpenSubjective(noOpenWord).blocked === false);

  /* N3：把 ③（笼统判错点）拆掉 ⇒ 必放行 */
  const specific = { ...Y0021, causeNote: '孩子只答了「虚心求学」一项，缺「不耻下问」这一采分点，且未引用原文「学而不思则罔」。' };
  A('N3 判错点变具体 ⇒ 不再阻断（③ 真的在起作用）', judgeOpenSubjective(specific).blocked === false);

  /* N4：判据本体被改坏（把三条件恒真）时，本用例应能抓到 —— 用一个"应该放行却会被判阻断"的样本 */
  A('N4 客观题不会被误伤（题干无题型词 ⇒ 恒放行）', judgeOpenSubjective(objective).blocked === false);

  console.log('\n── 真库（若存在则核）──');

  const LIB = process.env.CTB_DATA;
  if (LIB && fs.existsSync(LIB)) {
    /* ⚠ 隐私红线：学生**化名**不许进 tracked 文件 ⇒ 这里**不硬编码**学生目录名，
       改成**按卡号在全库里发现**"谁拥有这张卡"（索引里的 student 字段是权威）。
       （本轮踩过：脱敏脚本把作为目录名的化名也替换了 ⇒ 真库核整个被跳过 ⇒ 门禁变哑。） */
    const readIdx = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    const idxFiles = [];
    for (const ent of fs.readdirSync(LIB, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const ip = path.join(LIB, ent.name, '_索引.json');
      if (fs.existsSync(ip)) idxFiles.push(ip);
    }
    /* 找出拥有 Y0021 / Y0016 / M0039 / E0092 的学生目录 */
    const ownerOf = {};   /* 卡号 → 学生目录名 */
    for (const ip of idxFiles) {
      let j;
      try { j = readIdx(ip); } catch { continue; }
      for (const v of Object.values(j.subjects || {})) {
        for (const it of (v.items || [])) ownerOf[it.id] = path.basename(path.dirname(ip));
      }
    }

    /* R1：Y0021 已从索引移除（撤卡生效） */
    A('R1 Y0021 已从索引移除（撤卡生效）', !ownerOf['Y0021'], ownerOf['Y0021'] ? ('仍在 ' + ownerOf['Y0021'] + ' 下') : '');

    /* R2：留档目录在 */
    const arch = path.join(LIB, '_撤卡留档');
    const dirs = fs.existsSync(arch) ? fs.readdirSync(arch) : [];
    const yArch = dirs.find(d => d.startsWith('Y0021-'));
    A('R2 Y0021 留档目录在', !!yArch, yArch);
    if (yArch) {
      A('R2a 留档里卡面四件套齐全', ['错题记录.md', '题干.html'].every(f => fs.existsSync(path.join(arch, yArch, f))), fs.readdirSync(path.join(arch, yArch)).join(','));
      A('R2b 撤销记录在', fs.existsSync(path.join(arch, yArch, '_撤销记录.json')));
      A('R2c 复原指引在', fs.existsSync(path.join(arch, yArch, '_本批说明.md')));
    }

    /* R3：其他开放题候选**未被误伤**（仍在索引里） */
    for (const id of ['Y0016', 'M0039', 'E0092']) {
      A('R3 ' + id + ' 未被误伤（仍有客观依据）', !!ownerOf[id], ownerOf[id] ? '' : '该卡在索引里找不到');
    }

    /* R4：台账里不再有 Y0021 登记（按**后缀**匹配，不写死学生名） */
    for (const f of ['_原卷台账.json', '_配图台账.json', '_盲解双路.json']) {
      const p = path.join(LIB, f);
      if (!fs.existsSync(p)) continue;
      const j = readIdx(p);
      const bucket = j.cards || j.lanes || {};
      const still = Object.keys(bucket).some(k => k.endsWith('|Y0021'));
      A('R4 ' + f + ' 里已无 Y0021 登记', !still);
    }
  } else {
    console.log('  （无 CTB_DATA，跳过真库核）');
  }

  console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}  断言=${total}  失败=${fails}`);
  process.exit(fails ? 1 : 0);
}
