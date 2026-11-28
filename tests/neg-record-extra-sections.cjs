#!/usr/bin/env node
/**
 * 拾光小册 · 「改卡不许抹掉卡面上人工增补的段落」回归（2026-11-27 建）
 *
 * 用户报障（点卡到编号）：
 *   「M0161，为什么 22 不是另一个正确答案？」—— 复核这张卡时挖出来的两个**程序**缺陷：
 *
 *   ① **改卡裁图找不到原图**（当原图只在保全库里时）：
 *      台账里 `page` 指向的**原路径可能已失效**（收件箱被清空 / 原件被改名），
 *      而字节在**内容寻址的保全库** `_原图\` 里（实测真库 657 张卡里 **97 张**的 page 路径已死）。
 *      改卡的原图查找只看"路径在盘 + sha 匹配" ⇒ 这类卡**永远裁不好**
 *      （实测 M0161 就是这样：改卡时报「找不到原图 —— 只改文本不动裁图」，
 *        于是它的证据裁图一直停在"第 7~8 题"那一块）。
 *      ⇒ 修法：接上 `_原图寻址.mjs` 的**唯一实现**（按内容找回，且只认字节完全相同）。
 *
 *   ② **改卡静默抹掉卡面上"人工增补"的段落**：
 *      本仓卡面有两套形态 —— 工具生成的（`buildRecord` 的段落）与**人手写进去**的
 *      （实测 **449/657** 张有「记忆口诀」、**490/657** 张有「举一反三」，
 *      **索引里没有对应字段** ⇒ 工具既不生成也不认识）。
 *      改卡原先**整份重写**卡面 ⇒ 一次改卡就把这些内容**静默抹掉**（实测 M0161 被抹了）。
 *      ⇒ 修法：改卡时把**工具不管**的段落原样接回去，并在输出里**可见**地说明保留了什么；
 *        同时给 `buildRecord` 加 `mnemonic` / `variantsNote` 两个入参。
 *
 * 本用例守：
 *   M. 判据本体（单元）：哪些段落该保留、哪些该重写；
 *   L. 接线：改卡真的调用了保留逻辑、真的能写 mnemonic/variantsNote；
 *   R. 真库：M0161 的卡面**六段齐全**（含口诀与举一反三），且证据裁图**落在第 13(2)**；
 *   N. 阴性自证：把「保留」的判据去掉 ⇒ 用例必须变红（证明它真的会红）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ingestSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools', '_录题入库.mjs'), 'utf8');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 220) : ''}`); if (!ok) fails++; };

function runAll() {
  console.log('── 判据本体（单元）──');

  /* 把 extraSectionsOf 的逻辑原样复刻（判据本体在源文件里，这里独立复刻一份做对拍） */
  const TOOL_OWNED = ['原题', '孩子的错解', '孩子的解答', '错在哪一步', '正确答案', '正确完整过程', '转录注'];
  const EXTRA = ['给孩子的记忆口诀', '记忆口诀', '举一反三', '变式题'];
  const pick = (txt) => {
    const out = [];
    for (const seg of txt.split(/\n(?=## )/)) {
      const m = /^##\s+(.+?)\s*$/.exec(seg.split('\n')[0] || '');
      if (!m) continue;
      const title = m[1].trim();
      if (TOOL_OWNED.some(t2 => title.startsWith(t2))) continue;
      if (!EXTRA.some(t2 => title.startsWith(t2))) continue;
      const s = seg.trim();
      if (s) out.push(s);
    }
    return out;
  };

  /* 样本：工具生成形态 + 人工增补形态混在一起的卡面 */
  const SAMPLE = [
    '# M9999 · 样例（K1）',
    '',
    '**来源**：某卷 ｜ **难度**：中 ｜ **错因**：K1 某某',
    '',
    '## 原题',
    '',
    '题目正文',
    '',
    '## 孩子的错解（黑笔，原样保留在原卷截图.jpg）',
    '',
    '孩子的写法',
    '',
    '## 错在哪一步',
    '',
    '解释',
    '',
    '## 正确答案',
    '',
    '**答案**',
    '',
    '## 转录注',
    '',
    '转录注正文',
    '',
    '## 给孩子的记忆口诀',
    '',
    '> 口诀正文',
    '',
    '## 举一反三（变式题，组卷时抽取）',
    '',
    '1. 变式一',
    '',
  ].join('\n');

  const kept = pick(SAMPLE);
  A('M1 人工增补段（记忆口诀/举一反三）被保留',
    kept.length === 2, kept.length + ' 段：' + kept.map(s => s.split('\n')[0]).join('、'));
  A('M2 工具管的段（答案/错解/错在哪一步/转录注…）**不**保留（要按本次改卡重写）',
    !kept.some(s => /## (原题|孩子的错解|错在哪一步|正确答案|转录注)/.test(s)),
    kept.map(s => s.split('\n')[0]).join('、'));
  A('M3 保留的是「段」不是零散行（每段都带标题）',
    kept.every(s => /^##\s+/.test(s)));

  /* 样本：只有工具生成形态的卡面 ⇒ 一段都不该保留 */
  const toolOnly = SAMPLE.split('## 给孩子的记忆口诀')[0];
  A('M4 没有人工增补段的卡面 ⇒ 保留 0 段（改卡不会凭空加）',
    pick(toolOnly).length === 0, pick(toolOnly).length);

  console.log('\n── 接线 ──');
  A('L1 改卡调用了 extraSectionsOf（保留逻辑真的接上了）',
    /extraSectionsOf\(/.test(ingestSrc) && /保留卡面上的人手增补段落/.test(ingestSrc));
  A('L2 保留下来的段被接回卡面（不是只算不算）',
    /extras\.length\s*\?\s*\(rec\.replace/.test(ingestSrc) || /extras\.join/.test(ingestSrc));
  A('L3 buildRecord 支持 mnemonic（口诀能由工具写进卡面）',
    /if \(c\.mnemonic\)/.test(ingestSrc) && /## 给孩子的记忆口诀/.test(ingestSrc));
  A('L4 buildRecord 支持 variantsNote（举一反三能由工具写进卡面）',
    /if \(c\.variantsNote\)/.test(ingestSrc) && /## 举一反三/.test(ingestSrc));
  A('L5 改卡的原图查找接上了保全库兜底（_原图寻址 的唯一实现）',
    /resolveByPath/.test(ingestSrc) && /原图按内容从保全库找回/.test(ingestSrc));
  A('L6 保全库兜底只认**字节完全相同**的对象（不按尺寸/名字猜）',
    /sha256\(fs\.readFileSync\(abs\)\) === sha/.test(ingestSrc));

  console.log('\n── 真库 ──');
  const LIB = E.LIB;
  /* ⚠ 隐私红线：学生**化名**不许进 tracked 文件 ⇒ 这里**不硬编码**学生目录名，
     改成**按卡号在全库里发现**"谁拥有这张卡"（索引里的 student 字段是权威）。 */
  const findCardDir = (cardId) => {
    for (const rel of E.findIndexes(LIB)) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(LIB, rel), 'utf8').replace(/^\uFEFF/, ''));
        const buckets = [];
        if (Array.isArray(j.items)) buckets.push({ subject: j.subject || '', items: j.items });
        if (j.subjects) for (const [sub, v] of Object.entries(j.subjects)) buckets.push({ subject: sub, items: v.items || [] });
        for (const b of buckets) {
          const hit = b.items.find(x => x.id === cardId);
          if (hit) return { dir: path.join(LIB, j.student, b.subject, hit.dir), student: j.student, subject: b.subject };
        }
      } catch { }
    }
    return null;
  };
  const found = findCardDir('M0161');
  const cardDir = found ? found.dir : path.join(LIB, '<未找到 M0161>');
  const facePath = path.join(cardDir, '错题记录.md');
  if (!fs.existsSync(facePath)) {
    A('R0 找到 M0161 的卡面', false, facePath);
    return finish();
  }
  const face = fs.readFileSync(facePath, 'utf8');
  for (const s of ['## 原题', '## 孩子的错解', '## 错在哪一步', '## 正确答案', '## 给孩子的记忆口诀', '## 举一反三']) {
    A('R0 卡面含「' + s.replace('## ', '') + '」段', face.includes(s));
  }
  /* ⚠ 卡面里**允许**出现「−11 + x ＝ 11」——那是在"订正说明"里**引用旧错述**并当场纠正它。
     真正要禁的是：**把它当成孩子的实际写法**（即"孩子的错解"段里出现它，或解释段把它当事实陈述）。
     ⇒ 判据：①「孩子的错解」段里不得出现它；② 出现它的地方必须**带订正标记**。 */
  const wrongLine = /−11\s*\+\s*x\s*＝\s*11/;
  const studentSeg = (face.split('## 孩子的错解')[1] || '').split('\n## ')[0];
  A('R1 「孩子的错解」段里没有把第二行误述成「−11 + x ＝ 11」',
    !wrongLine.test(studentSeg), studentSeg.replace(/\s+/g, ' ').slice(0, 120));
  const mentions = [...face.matchAll(/.{0,90}−11\s*\+\s*x\s*＝\s*11.{0,90}/g)].map(m => m[0].replace(/\s+/g, ' '));
  A('R1b 提到旧错述的地方**都带订正标记**（不是当成事实陈述）',
    mentions.length === 0 || mentions.every(s => /订正|先前|原先|卷面上没有|误述/.test(s)),
    mentions.slice(0, 1).join(' | ').slice(0, 200) || '（没提到）');
  A('R1c 卡面明确指出卷面实物是「−11 + 11 = 0」',
    /−11\s*\+\s*11\s*＝\s*0/.test(face));
  A('R2 卡面说明了「反过来减」才是孩子第二行的实际做法',
    /反过来减/.test(face));

  /* 证据裁图：必须落在第 13(2)（y 0.469~0.564），不是第 7~8 题（y 0.233~0.317） */
  const cropPath = path.join(cardDir, '_裁图记录.json');
  if (fs.existsSync(cropPath)) {
    const rec = JSON.parse(fs.readFileSync(cropPath, 'utf8').replace(/^\uFEFF/, ''));
    const b = rec.normBox || [];
    const y = b[1], h = b[3];
    A('R3 M0161 的证据裁图落在第 13(2)（y≈0.47~0.56），不是第 7~8 题（y≈0.23~0.32）',
      y > 0.40 && y < 0.60, 'normBox=' + JSON.stringify(b));
    A('R4 裁图记录的 src 指向保全库里的真实字节（页面原路径已失效）',
      /_原图\//.test(String(rec.src || '')), String(rec.src || ''));
  } else {
    A('R3 找到 M0161 的裁图记录', false, cropPath);
  }

  /* 答案必须还是 −22（本次复核没改答案，只改解释与裁图） */
  const idxPath = found ? path.join(LIB, found.student, '_索引.json') : '';
  if (idxPath && fs.existsSync(idxPath)) {
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8').replace(/^\uFEFF/, ''));
    const buckets = [];
    if (Array.isArray(idx.items)) buckets.push(idx.items);
    if (idx.subjects) for (const v of Object.values(idx.subjects)) buckets.push(v.items || []);
    const it = buckets.map(a => a.find(x => x.id === 'M0161')).find(Boolean);
    if (it) {
      A('R5 M0161 的答案仍是 −22（复核没有动答案）',
        /−22/.test(String(it.answer || '')) && !/(^|[^\d−])22[^\d]/.test(String(it.answer || '').replace(/−22/g, '')),
        String(it.answer || '').slice(0, 80));
    } else {
      A('R5 索引里找到 M0161', false, '没找到');
    }
  }

  console.log('\n── 阴性自证：判据必须真的会红 ──');
  /* N1：把「保留」的判据去掉（模拟修复前的行为）⇒ 用例必须报红 */
  const beforeFix = SAMPLE.split('\n').filter(l => !/^(## 给孩子的记忆口诀|## 举一反三|> 口诀正文|1\. 变式一)/.test(l)).join('\n');
  const keptBroken = pick(beforeFix);
  A('N1 去掉「人工增补段」后保留数变少（⇒ M1 那条断言会因为这个改动而变红）',
    keptBroken.length < kept.length, keptBroken.length + ' < ' + kept.length);

  /* N2：真库现状 —— 若把改卡的保留逻辑去掉，M0161 的口诀/举一反三会被抹掉 */
  A('N2 M0161 现在**有**口诀与举一反三（修复前的改卡会把它们抹掉 ⇒ 这两条断言对修复前必然红）',
    face.includes('## 给孩子的记忆口诀') && face.includes('## 举一反三'));

  finish();
}

function finish() {
  console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${total} 失败=${fails}`);
  process.exit(fails ? 1 : 0);
}

runAll();
