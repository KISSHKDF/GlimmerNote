#!/usr/bin/env node
/**
 * 原卷台账 · 建卡清单跨学生串号（C01 · P1）阴性对照（2026-10-31 建）
 *
 * 缺陷原形（`src\tools\_原卷台账.mjs` 的 ruleBuildList，外部审查复核后定性为 P1）：
 *   建卡清单的缓存键是**裸卡号**（`_buildList.set(card.id, …)` / `_buildList.get(c.id)`），
 *   而卡号**跨学生会撞号**（真库现场：两名学生同号卡 96 个；台账主键本来就叫 `学生|卡号`）。
 *   于是：
 *     · 只有一份清单、里面只有一条 M0001 ⇒ 两名学生都命中同一条，**一开始就串号**
 *       （学生A|M0001 与 学生B|M0001 指向同一张 pA.jpg）；
 *     · 有两份清单 ⇒ 后枚举的 set 覆盖前一条，学生A 自己的卡被指到学生B 的页。
 *   最要命的是**没有纠正机会**：命中本规则后 build() 的规则链就不再走 reconcilePage 兜底，
 *   错页会被当成"有证据"直接写进真源。
 *
 * 本用例守三条（全部在该工具**真跑**的临时库上，绝不碰真库）：
 *   ① 清单**未标注学生** + 同号卡跨学生 ⇒ 两张卡都**不许**被 `by: '建卡清单'` 关联，
 *      必须被标成歧义，且**不得指向同一个 page**（旧缺陷正是"都指到 pA.jpg"）；
 *   ② 清单**标注了 student** ⇒ 各自关联到自己那张页（修法不许把好数据也一起拒掉）；
 *   兼任"防退化"对照：卡号全库唯一时，老清单（无 student 字段）**仍要能用**——
 *   否则"一律回歧义"这种偷懒修法也能骗过断言①；
 *   ③ 阴性自证：把"未标注学生 + 跨学生重复 ⇒ 歧义"这条判据摘掉（= 退回裸卡号匹配），
 *      断言①必须当场变红（变异体里两张卡又都指到同一张页）。
 *
 * 为什么用真工具而不是直接 import 函数：本工具的规则链、规则优先级、写盘口径都在 CLI 里，
 *   函数级测试证明不了"命中后就不再走兜底"这件事。
 * 为什么用 temp 库：会写 `_原卷台账.json`（工具会取库写锁，锁文件还在系统临时目录）。
 *
 * 用法：node tests\neg-orig-ledger-ambiguity.cjs
 * 退出码：0=全绿；1=有断言失败（且会打印台账原文，便于归因）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'src', 'tools', '_原卷台账.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-buildlist-'));
const LIB = path.join(TMP, 'lib');
const CLIST_DIR = '_work-建卡清单-1';
const CLIST_FILE = path.join(LIB, CLIST_DIR, 'cards-g1.json');
const PAGE_A = CLIST_DIR + '/pages/pA.jpg';
const PAGE_B = CLIST_DIR + '/pages/pB.jpg';
const PAGE_C = CLIST_DIR + '/pages/pC.jpg';

/* 文本一律走 node 的 writeFileSync('utf8')：UTF-8 无 BOM + LF（本仓红线 7） */
const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1) + '\n', 'utf8'); };
const writeTxt = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); };

/** 跑真工具；库根显式走 CTB_DATA（子进程继承 process.env 的其余部分，别把 PATH 丢了） */
function runTool(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: LIB }),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function ledger() {
  const p = path.join(LIB, '_原卷台账.json');
  if (!fs.existsSync(p)) return { cards: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ── 造临时库：学生A / 学生B 各有 M0001；学生C 有全库唯一的 M0009 ──────────────
   ⚠ 库形状必须与 loadCards() 的口径一致（<学生>/_索引.json + items[].dir），
     否则"撞号"根本没造出来，后面的断言全是空转。 */
function makeLib() {
  writeJson(path.join(LIB, '学生A', '_索引.json'), {
    student: '学生A', grade: '九年级', subject: '数学',
    items: [{ id: 'M0001', dir: 'M0001', source: '合成样例·单元测 · 第1题' }],
  });
  writeJson(path.join(LIB, '学生B', '_索引.json'), {
    student: '学生B', grade: '九年级', subject: '数学',
    items: [{ id: 'M0001', dir: 'M0001', source: '合成样例·单元测 · 第1题' }],
  });
  writeJson(path.join(LIB, '学生C', '_索引.json'), {
    student: '学生C', grade: '九年级', subject: '数学',
    items: [{ id: 'M0009', dir: 'M0009', source: '合成样例·单元测 · 第9题' }],
  });
  for (const d of ['学生A/M0001', '学生B/M0001', '学生C/M0009']) fs.mkdirSync(path.join(LIB, d), { recursive: true });
  /* 清单目录里的页文件（规则要求 work = <清单目录>/pages/<pageFile> 真的在盘） */
  for (const [rel, tag] of [[PAGE_A, 'PAGE-A'], [PAGE_B, 'PAGE-B'], [PAGE_C, 'PAGE-C']]) writeTxt(path.join(LIB, rel), tag);
  /* 预置像素尺寸缓存：`生成` 末尾要给"有整页的卡"量尺寸，而临时库里没有 `<库>/_工具/图尺寸.ps1`
     （那支 PowerShell 属于程序目录，不属于用户库），量不到就往前面的 stderr 喷一行失败信息。
     本条用例判的是**建卡清单的键**，与像素无关 ⇒ 直接把缓存填好让 sizesOf 早退（零 IO、零噪音）。
     ⚠ 不填会怎样：工具仍然 exit 0、断言也照样过，但输出里混着一段刺眼报错，读日志的人会以为坏了。 */
  writeJson(path.join(LIB, '_probe', '_图尺寸.json'), {
    [PAGE_A]: [200, 400], [PAGE_B]: [200, 400], [PAGE_C]: [200, 400],
  });
}
/** 老清单形态：只有 {id, pageFile}，**没有** student 字段 */
function writeUnlabeledClist() {
  writeJson(CLIST_FILE, {
    note: '合成样例：老清单（未标注学生）',
    cards: [
      { id: 'M0001', pageFile: 'pA.jpg', bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 } },
      { id: 'M0009', pageFile: 'pC.jpg' },
    ],
  });
}
/** 新清单形态：每条自带 student */
function writeLabeledClist() {
  writeJson(CLIST_FILE, {
    note: '合成样例：清单自带学生归属',
    cards: [
      { id: 'M0001', student: '学生A', pageFile: 'pA.jpg', bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 } },
      { id: 'M0001', student: '学生B', pageFile: 'pB.jpg' },
      { id: 'M0009', pageFile: 'pC.jpg' },
    ],
  });
}

function main() {
  console.log('临时库：' + LIB + '\n工具：' + path.relative(ROOT, TOOL) + '\n');
  makeLib();

  /* ════════ ① 清单未标注学生 + 跨学生同号 ⇒ 必须歧义、不得串页 ════════ */
  console.log('══ ① 老清单（无 student 字段）+ 学生A/学生B 同号 M0001 ══');
  writeUnlabeledClist();
  {
    const r = runTool(['生成']);
    A('① 前置：工具真跑成功（生成台账）', r.code === 0, 'exit=' + r.code + ' ' + (r.err || r.out).split('\n').slice(0, 2).join(' | '));
    const led = ledger();
    const a = led.cards['学生A|M0001'] || {};
    const b = led.cards['学生B|M0001'] || {};
    const c = led.cards['学生C|M0009'] || {};
    A('① 前置：两名学生都有 M0001 卡（撞号场景成立）', !!led.cards['学生A|M0001'] && !!led.cards['学生B|M0001'],
      Object.keys(led.cards).join(', '));
    A('★ ① 学生A 的卡**不得**被 by=\'建卡清单\' 关联（旧缺陷：串到学生B 的页）',
      a.by !== '建卡清单', 'by=' + a.by + ' page=' + a.page);
    A('★ ① 学生B 的卡同样不得被关联', b.by !== '建卡清单', 'by=' + b.by + ' page=' + b.page);
    A('★ ① 两张卡都被标成「歧义」（拒绝自动匹配，而不是"猜一个"）',
      /歧义/.test(a.by || '') && /歧义/.test(b.by || ''),
      'byA=' + a.by + ' byB=' + b.by);
    A('★ ① 歧义原因写清了"清单未标注学生 + 卡号在 N 个学生下重复"',
      /未标注学生/.test(a.note || '') && /2 个学生下重复/.test(a.note || ''),
      String(a.note || '').slice(0, 120));
    A('★ ① 两张卡**不得指向同一个 page**（旧缺陷签名：都指到 pA.jpg）',
      !(a.page && a.page === b.page), 'pageA=' + a.page + ' pageB=' + b.page);
    A('★ ① 也不得指向清单里那张页（两个方向都不许）',
      a.page !== PAGE_A && b.page !== PAGE_A, 'pageA=' + a.page + ' pageB=' + b.page);
    A('① 防退化：卡号全库唯一（学生C|M0009）⇒ 老清单**仍然可用**（不许一律回歧义）',
      c.by === '建卡清单' && c.page === PAGE_C, 'by=' + c.by + ' page=' + c.page);
  }

  /* ════════ ② 清单标注了 student ⇒ 各自关联到自己的页 ════════ */
  console.log('\n══ ② 清单自带 student ⇒ 各自关联到自己的页 ══');
  writeLabeledClist();
  {
    const r = runTool(['生成']);
    A('② 前置：工具真跑成功', r.code === 0, 'exit=' + r.code);
    const led = ledger();
    const a = led.cards['学生A|M0001'] || {};
    const b = led.cards['学生B|M0001'] || {};
    A('★ ② 学生A|M0001 → 自己的 pA.jpg', a.by === '建卡清单' && a.page === PAGE_A, 'by=' + a.by + ' page=' + a.page);
    A('★ ② 学生B|M0001 → 自己的 pB.jpg', b.by === '建卡清单' && b.page === PAGE_B, 'by=' + b.by + ' page=' + b.page);
    A('★ ② 两张卡指向**不同**的页（串号已消除）', a.page !== b.page, 'pageA=' + a.page + ' pageB=' + b.page);
    A('② 归一化 bbox 仍然带得出来（标注学生不许把框丢了）',
      Array.isArray(a.box) && a.box.length === 4, JSON.stringify(a.box));
  }

  /* ════════ ③ 阴性自证：摘掉"跨学生重复 ⇒ 歧义"这条判据 ⇒ ② 必须变红 ════════
     变异体放临时目录（连同它的三个相对 import 一起复制），**绝不改仓库里的真源码**：
     改真源码再还原是本仓踩过的"半截改造"风险源（还原失败就留下半死的工具）。 */
  console.log('\n══ ③ 阴性自证：把「未标注学生 + 跨学生重复 ⇒ 歧义」摘掉（= 退回裸卡号匹配）══');
  {
    const ORIG = fs.readFileSync(TOOL, 'utf8');
    const ANCHOR = 'if (owners.size > 1) return ambiguousBuildList(';
    A('③ 前置：阴性自证锚点存在且唯一', (ORIG.split(ANCHOR).length - 1) === 1,
      '出现 ' + (ORIG.split(ANCHOR).length - 1) + ' 次');
    const mutSrc = ORIG.replace(ANCHOR, 'if (false) return ambiguousBuildList(');
    A('③ 前置：变异真的发生了（不是空操作）', mutSrc !== ORIG && /if \(false\) return ambiguousBuildList\(/.test(mutSrc));
    A('③ 前置：变异只动一个词，行数不变（防"锚点打偏、整段被吃"）',
      mutSrc.split('\n').length === ORIG.split('\n').length,
      ORIG.split('\n').length + ' 行 → ' + mutSrc.split('\n').length + ' 行');

    const mutDir = path.join(TMP, 'mut');
    fs.mkdirSync(mutDir, { recursive: true });
    for (const f of ['_原卷台账.mjs', '_安全写.mjs', '_库根.mjs', '_路径护栏.mjs']) {
      const src = path.join(ROOT, 'src', 'tools', f);
      fs.copyFileSync(src, path.join(mutDir, f));
    }
    const mutTool = path.join(mutDir, '_原卷台账.mjs');
    fs.writeFileSync(mutTool, mutSrc, 'utf8');       // UTF-8 无 BOM + LF（源文件就是 LF）
    const chk = spawnSync(process.execPath, ['--check', mutTool], { encoding: 'utf8' });
    A('③ 前置：变异体语法自检通过（node --check）', chk.status === 0,
      String(chk.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | '));

    /* 变异体跑在"场景①"的数据上（老清单 + 同号卡），且先删台账从零生成 */
    writeUnlabeledClist();
    try { fs.unlinkSync(path.join(LIB, '_原卷台账.json')); } catch { }
    const r = spawnSync(process.execPath, [mutTool, '生成'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { CTB_DATA: LIB }),
    });
    A('③ 变异体真跑成功', r.status === 0, 'exit=' + r.status + ' ' + String(r.stderr || '').split('\n')[0]);
    const led = ledger();
    const a = led.cards['学生A|M0001'] || {};
    const b = led.cards['学生B|M0001'] || {};
    A('★★ 阴性自证：旧逻辑下两张卡**被指到同一张页**（断言★① 会当场变红）',
      !!a.page && a.page === b.page,
      'pageA=' + a.page + ' pageB=' + b.page);
    A('★★ 阴性自证：而且指的还是同一张清单页 pA.jpg（跨学生串号复现）',
      a.page === PAGE_A && b.page === PAGE_A, 'pageA=' + a.page + ' pageB=' + b.page);

    /* 不留半截改造：仓库里的真源码一个字节都没动过 */
    A('③ 仓库里的真源码未被改动（变异只在临时副本上做）', fs.readFileSync(TOOL, 'utf8') === ORIG);
    try { fs.rmSync(mutDir, { recursive: true, force: true }); } catch { }
  }

  console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}`);
}

try {
  main();
} catch (e) {
  fail++;
  console.log('[FAIL] 用例自身抛错：' + (e && e.stack || e));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
}
process.exit(fail ? 1 : 0);
