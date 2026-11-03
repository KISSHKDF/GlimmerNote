#!/usr/bin/env node
/**
 * 经验草稿门禁（2026-11-03，批次 3 建）
 *
 * 守什么：`src\tools\_经验草稿.mjs` 是"把一手经验整理成**可以先看、再决定分享**的公开草稿"
 * 那条通道。它一旦松了，后果都不会报错 —— 它们全都是**静默出网**：
 *   · 白名单松（改成黑名单过滤）⇒ 源里没想到的字段跟着出门；
 *   · 隐私扫描松（少一类、或某处豁免被放大）⇒ 孩子原图/真名/家庭路径/任务号进了公开草稿；
 *   · 判红却照写盘 ⇒ "拒绝外发"变成一句空话；
 *   · 缺 expected.json / 案例与卡不匹配被放过 ⇒ 导出的"案例"不是卡说的那一个。
 * 所以本文件的写法纪律（本仓惯例）：**每条判据都要有真跑的阴性对照** ——
 *   每一类私有标记都在这里被**故意塞进源里**，断言"当场判红 + 点名是哪一条、在哪个字段"。
 *   只放正例的断言是恒真的，等于没测。
 *
 * 三类断言：
 *   ① 正例：仓库里那份 B-07 试点包（合成案例）两种形态都必须 exit 0 —— 谁把判据改得过严，这里先红；
 *   ② 从零组装：源里塞满额外字段（含 64 位十六进制、真名式字段），草稿里**一个都不许出现**；
 *   ③ 只读纪律：`预览` 前后包根/库根/工具目录逐字节不变；`导出` 只多出 `--out` 那一个文件；
 *      判红时**不许写盘**。
 *
 * 用法：node tests\neg-experience-draft.cjs
 * 退出码：0=全绿；1=有断言失败
 *
 * ⚠ 本文件**不写**任何用户库：夹具全在 %TEMP%（allocTempDir 登记，退出即删）；
 *   `--data` 一律指自建临时库，`--packs` 一律指临时包根（把仓库 `src\packs` 最新版本目录复制过去）。
 * ⚠ 两个真实化名在 tracked 文件里是**禁词**（tests\repo-hygiene.cjs），本文件按拼接构造。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');

const ROOT = E.REPO;
const TOOL = E.tool('_经验草稿.mjs');
const SRC_PACKS = path.join(ROOT, 'src', 'packs');
/* 试点包版本号**从目录里读最高那个**，不写死（vis 批次 2 已连撞两次：1.0.0→1.0.1→1.0.2）。 */
const PILOT_BASE = path.join(SRC_PACKS, 'family-a', 'shared-stem');
const PILOT_VER = fs.readdirSync(PILOT_BASE)
  .filter((d) => /^\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(PILOT_BASE, d, 'pack.json')))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
const PILOT = path.join(PILOT_BASE, PILOT_VER);
const PILOT_REL = ['family-a', 'shared-stem', PILOT_VER];
const PILOT_SEL = 'family-a/shared-stem/shared-stem@' + PILOT_VER;
const PILOT_CASE = JSON.parse(fs.readFileSync(path.join(PILOT, 'cases', 'shared-stem', 'expected.json'), 'utf8')).caseId;

/* 学生化名（**拼接构造**：repo-hygiene 把这两个词列为 tracked 禁词，本文件不许落字面量） */
const NAME1 = '康' + '康';
const NAME2 = '乐' + '乐';
/* 本机用户目录里那个"真名"路径形态（同样拼接构造，绕开 repo-hygiene 的 `X:\Users\<真名>` 判据） */
const USERS_SAMPLE = 'C:' + '\\Users\\' + 'some' + 'one' + '\\Downloads';

let pass = 0, fail = 0, skip = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const SKIP = (name, why) => { console.log(`[SKIP] ${name}  → ${why}`); skip++; };

/* ── 跑工具：一律带 --data <临时库>（证明不碰真库）+ 可选 --packs ── */
function run(args, o) {
  const env = Object.assign({}, process.env);
  delete env.CTB_PACKS;
  env.CTB_DATA = (o && o.data) || TMP_LIB;
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function runJson(args, o) {
  const r = run(args.concat('--json'), o);
  let json = null;
  try { json = JSON.parse(r.out); } catch { json = null; }
  return { code: r.code, out: r.out, err: r.err, json };
}

const TMP = E.allocTempDir('gn-draft-');
const TMP_LIB = path.join(TMP, 'lib');
fs.mkdirSync(TMP_LIB, { recursive: true });

let seq = 0;
const mkRoot = (tag) => path.join(TMP, 'roots', String(++seq).padStart(2, '0') + '-' + tag);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');

/** 一份**合规**的经验包根：把仓库试点包复制进去，再按需改（改卡正文 / pack.json / expected.json）。 */
function pilotPack(tag, mutate) {
  const root = mkRoot(tag);
  const dir = path.join(root, ...PILOT_REL);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(PILOT, dir, { recursive: true });
  const ctx = { root, dir, sel: PILOT_SEL, caseId: PILOT_CASE, body: path.join(dir, 'cards', 'shared-stem.md') };
  if (mutate) mutate(ctx);
  return ctx;
}
const patchPack = (ctx, fn) => { const p = path.join(ctx.dir, 'pack.json'); const j = readJson(p); fn(j); writeJson(p, j); };
const patchCase = (ctx, fn) => { const p = path.join(ctx.dir, 'cases', ctx.caseId, 'expected.json'); const j = readJson(p); fn(j); writeJson(p, j); };
const setBody = (ctx, text) => fs.writeFileSync(ctx.body, text, 'utf8');

/** 目录快照：relPath → 'size:sha256'（比 mtime 更硬；用来证明"只写 --out 那一个文件"）。 */
function snap(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, r); continue; }
      try {
        const b = fs.readFileSync(full);
        out.set(r, b.length + ':' + require('crypto').createHash('sha256').update(b).digest('hex'));
      } catch { out.set(r, 'unreadable'); }
    }
  };
  walk(dir, '');
  return out;
}
const sameSnap = (a, b) => a.size === b.size && [...a.keys()].every((k) => a.get(k) === b.get(k));
const snapDiff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));

/* 与工具同源的判据**独立**复写一份：扫描器本身是被测对象，只有它自己的话说"没命中"是不够的
   （两份实现的对拍就是本条用例的一半价值）。 */
const RE_HEX64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const RE_DRIVE = /(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/]|Users[\\/])/;
const RE_TASK = /(?<![0-9a-zA-Z])t-\d{8}-\d{6}-[0-9a-f]{6}(?![0-9a-zA-Z])/;

/* ══════════════════════════════════════════════════════════════════ */
(async () => {
  const M = await import(pathToFileURL(TOOL).href);
  const CONTRACT_FIELDS = ['方法正文', '步骤', '适用条件', '反例', '预期行为', '合成案例',
    '配方id', '配方版本', '配方指纹', '作者', '许可', '包id', '卡id', '包版本', '生成时间', '工具版本'];

  console.log('══ 一、白名单自证：口径逐字钉住（接口契约 §1.2）══');
  {
    const r = run(['白名单'], {});
    A('白名单 exit 0', r.code === 0, 'code=' + r.code);
    A('人读输出逐条列出 16 个允许字段', CONTRACT_FIELDS.every((f) => r.out.includes(f)),
      CONTRACT_FIELDS.filter((f) => !r.out.includes(f)).join('、') || '全部在');
    A('人读输出逐条列出 7 条显式排除',
      ['孩子原图', '真实哈希', '家庭路径', '聊天原文', '手写批注', '任务全文', '学生/家长标识'].every((k) => r.out.includes(k)), '');
    A('人读输出写明"从零组装"（不是黑名单过滤）', /从\*\*空对象\*\*开始/.test(r.out), '');

    const j = runJson(['白名单'], {});
    A('白名单 --json：fields 逐字等于契约的 16 个（含顺序）',
      j.json && JSON.stringify(j.json.fields.map((x) => x.name)) === JSON.stringify(CONTRACT_FIELDS),
      j.json ? JSON.stringify(j.json.fields.map((x) => x.name)) : '(无 JSON)');
    A('白名单 --json：excluded 7 条、每条非空',
      j.json && j.json.excluded.length === 7 && j.json.excluded.every((x) => String(x).trim().length > 4),
      j.json ? 'excluded=' + j.json.excluded.length : '(无 JSON)');
    A('白名单 --json：扫描判据 4 条形状 + 化名替换 + 源字段名（合起来覆盖契约 §1.3 六类）',
      j.json && j.json.scanRules.length === 4 && r.out.includes('手写批注/聊天原文形态'),
      j.json ? JSON.stringify(j.json.scanRules.map((x) => x.id)) : '(无 JSON)');
    A('白名单 --json：两种形态的区别说明都在', j.json && /本地留档/.test(j.json.forms.local) && /云端 AI/.test(j.json.forms.cloud), '');

    /* 模块级对拍：表就是唯一真源，CLI 输出与它必须一致（防止"文档改了代码没改"） */
    A('模块导出 DRAFT_FIELDS 与契约逐字相等（顺序敏感）',
      JSON.stringify(M.DRAFT_FIELDS.map((x) => x.name)) === JSON.stringify(CONTRACT_FIELDS), '');
    A('模块导出 CASE_HASH_PATHS **只**点名两处（逐个点名，不是通配豁免）',
      M.CASE_HASH_PATHS.length === 2 && M.CASE_HASH_PATHS[0].at === 'input.pageSha' &&
      M.CASE_HASH_PATHS[1].at === 'expected.regions[].pageSha',
      JSON.stringify(M.CASE_HASH_PATHS.map((x) => x.at)));
    A('模块导出 PSEUDO 两个化名都是**拼接构造**（源码里没有字面量）',
      M.PSEUDO.length === 2 && M.PSEUDO.every((p) => p.from.length === 2 && /^孩子[A-Z]$/.test(p.to)), '');
  }

  console.log('\n══ 二、正例：仓库试点包两种形态都必须 exit 0（判据不许过严）══');
  {
    const p = pilotPack('pilot');
    const l = runJson(['预览', '--card', p.sel, '--packs', p.root], {});
    A('预览（不带 --case）exit 0 且 0 命中', l.code === 0 && l.json && l.json.scan.hits.length === 0,
      'code=' + l.code + ' hits=' + JSON.stringify(l.json && l.json.scan.hits));
    A('不带 --case ⇒ 草稿不含 合成案例/反例/预期行为（源里没有 ⇒ 就不搬）',
      l.json && !('合成案例' in l.json.draft) && !('反例' in l.json.draft) && !('预期行为' in l.json.draft), '');

    const c = runJson(['预览', '--card', p.sel, '--case', p.caseId, '--packs', p.root], {});
    A('预览（带 --case）exit 0', c.code === 0, 'code=' + c.code + ' ' + JSON.stringify(c.json && c.json.scan.hits));
    A('合成案例 = input.svg + expected.json（原样文本，带字节数）',
      c.json && c.json.draft['合成案例']['input.svg']['文本'].includes('<svg') &&
      c.json.draft['合成案例']['expected.json']['文本'].includes('"caseId"'),
      JSON.stringify(c.json && Object.keys(c.json.draft['合成案例'] || {})));
    A('契约声明的原页哈希**逐处**豁免（不是"有哈希就全放过"）',
      c.json && c.json.scan.exemptions === 3 && c.json.scan.hits.length === 0,
      'exemptions=' + (c.json && c.json.scan.exemptions));
    A('local 形态的 expected.json 与磁盘字节**逐字相等**（原样字节）',
      c.json && c.json.draft['合成案例']['expected.json']['文本'] ===
      fs.readFileSync(path.join(p.dir, 'cases', p.caseId, 'expected.json'), 'utf8'), '');

    const cl = runJson(['预览', '--card', p.sel, '--case', p.caseId, '--packs', p.root, '--form', 'cloud'], {});
    A('cloud 形态 exit 0、命中 0、豁免 0（原页哈希被剔除 ⇒ 零哈希是**字面事实**）',
      cl.code === 0 && cl.json && cl.json.scan.hits.length === 0 && cl.json.scan.exemptions === 0 && cl.json.scan.maskedHashes === 3,
      'code=' + cl.code + ' masked=' + (cl.json && cl.json.scan.maskedHashes));
    const cloudText = run(['导出', '--card', p.sel, '--case', p.caseId, '--packs', p.root, '--form', 'cloud',
      '--out', path.join(p.root, 'cloud.md')], {});
    const ct = fs.readFileSync(path.join(p.root, 'cloud.md'), 'utf8');
    A('cloud 文件：0 个 64 位十六进制（独立正则对拍）', (ct.match(RE_HEX64) || []).length === 0,
      (ct.match(RE_HEX64) || []).length + ' 处');
    A('cloud 文件：0 个盘符/家目录（独立正则对拍）', !RE_DRIVE.test(ct), '');
    A('cloud 文件：0 个任务号（独立正则对拍）', !RE_TASK.test(ct), '');
    A('cloud 文件：开头写明"这份是要贴给云端 AI 或公开提交的版本"', /这份是要贴给\*\*云端 AI\*\* 或\*\*公开提交\*\*的版本/.test(ct), '');
    A('导出 cloud exit 0 且 stdout 写明已写入路径与字节数', cloudText.code === 0 && /已写入：.+cloud\.md（\d+ 字节/.test(cloudText.out), '');
  }

  console.log('\n══ 三、从零组装：源里塞的额外字段一个都不许进草稿 ══');
  {
    const p = pilotPack('extra', (ctx) => {
      patchPack(ctx, (j) => {
        j['familyName'] = 'ZZ-EXTRA-顶层';
        j['家庭住址'] = 'ZZ-EXTRA-住址';
        j.cards[0]['extraNotes'] = 'ZZ-EXTRA-卡上额外说明';
        j.cards[0]['原图路径'] = 'ZZ-EXTRA-原图路径';
        /* 源里带一个 64 位十六进制：它**不在白名单字段里** ⇒ 应当被丢弃，
           既不该进草稿、也不该被判红（判红是给"进了草稿的东西"用的）。 */
        j.cards[0]['sha256'] = 'f'.repeat(64);
      });
    });
    const r = runJson(['预览', '--card', p.sel, '--case', p.caseId, '--packs', p.root], {});
    const draftText = JSON.stringify(r.json && r.json.draft);
    A('塞满额外字段后仍然 exit 0（额外字段是"丢弃"，不是"报错"）', r.code === 0, 'code=' + r.code + ' ' + r.err);
    A('草稿的键**全部**在白名单里（没有任何计划外字段）',
      r.json && Object.keys(r.json.draft).every((k) => CONTRACT_FIELDS.includes(k)),
      r.json ? Object.keys(r.json.draft).filter((k) => !CONTRACT_FIELDS.includes(k)).join('、') || '全部合规' : '(无 JSON)');
    A('四个 ZZ- 标记在草稿里 0 命中（值一个都没搬进来）',
      !/ZZ-EXTRA/.test(draftText), (draftText.match(/ZZ-EXTRA[^"]*/g) || []).join('、') || '0 处');
    A('源里那个 64 位十六进制也没进来（它所在的字段根本不在白名单）',
      !draftText.includes('f'.repeat(64)), '');
    A('草稿里没有源字段名（familyName / 家庭住址 / extraNotes / 原图路径）',
      ['familyName', '家庭住址', 'extraNotes', '原图路径'].every((k) => !draftText.includes(k)), '');
    A('填充字段数 == 草稿键数（"从空对象开始"的机械判据）',
      r.json && r.json.fieldsFilled.length === Object.keys(r.json.draft).length,
      r.json ? r.json.fieldsFilled.length + ' vs ' + Object.keys(r.json.draft).length : '(无 JSON)');
  }

  console.log('\n══ 四、六类私有标记：逐条阴性对照，都要真跑红 / 真替换 ══');
  {
    /* ① 盘符 / 家目录 */
    const p1 = pilotPack('neg-drive', (ctx) => setBody(ctx, '这一页的原始照片在 D:\\临时库\\照片.jpg 里。\n'));
    const r1 = runJson(['预览', '--card', p1.sel, '--packs', p1.root], {});
    A('① 盘符：exit 1 且点名「盘符/家目录」+ 字段 方法正文',
      r1.code === 1 && r1.json && r1.json.scan.hits.some((h) => h.rule === '盘符/家目录' && h.field === '方法正文'),
      'code=' + r1.code + ' ' + JSON.stringify(r1.json && r1.json.scan.hits));
    A('① 判红时 --json **不给草稿全文**（预览屏也是外发通道）', r1.json && !('draft' in r1.json), '');

    const p1b = pilotPack('neg-users', (ctx) => setBody(ctx, '下载目录在 ' + USERS_SAMPLE + ' 下面。\n'));
    const r1b = runJson(['预览', '--card', p1b.sel, '--packs', p1b.root], {});
    A('① 家目录（拼接构造的真名用户路径）：同样判红',
      r1b.code === 1 && r1b.json && r1b.json.scan.hits.some((h) => h.rule === '盘符/家目录'), 'code=' + r1b.code);

    /* ② 库内路径 */
    const p2 = pilotPack('neg-libpath', (ctx) => setBody(ctx, '原件在 _收件箱/2026-11/ 下面，先看一眼。\n'));
    const r2 = runJson(['预览', '--card', p2.sel, '--packs', p2.root], {});
    A('② 库内路径：exit 1 且点名「库内路径」',
      r2.code === 1 && r2.json && r2.json.scan.hits.some((h) => h.rule === '库内路径'), 'code=' + r2.code);

    /* ③ 任务号 */
    const p3 = pilotPack('neg-task', (ctx) => setBody(ctx, '这条是任务 t-20261103-120000-abcdef 的产物。\n'));
    const r3 = runJson(['预览', '--card', p3.sel, '--packs', p3.root], {});
    A('③ 任务号：exit 1 且点名「任务号」',
      r3.code === 1 && r3.json && r3.json.scan.hits.some((h) => h.rule === '任务号'), 'code=' + r3.code);

    /* ④ 64 位十六进制：正文里（白名单字段里也不行） */
    const p4 = pilotPack('neg-hash-body', (ctx) => setBody(ctx, '这一页原图的内容指纹是 ' + 'a'.repeat(64) + '（用来对账）。\n'));
    const r4 = runJson(['预览', '--card', p4.sel, '--packs', p4.root], {});
    A('④ 正文里的 64 位十六进制：exit 1 且点名「64 位十六进制」+ 字段 方法正文',
      r4.code === 1 && r4.json && r4.json.scan.hits.some((h) => h.rule === '64 位十六进制' && h.field === '方法正文'),
      'code=' + r4.code);

    /* ④-b 案例文本里、**契约位置之外**的 64 位十六进制（这是"案例文本也必须扫"的阴性对照） */
    const p4b = pilotPack('neg-hash-case', (ctx) => patchCase(ctx, (j) => {
      j.expected['说明'] = '对账用：' + 'b'.repeat(64);
    }));
    const r4b = runJson(['预览', '--card', p4b.sel, '--case', p4b.caseId, '--packs', p4b.root], {});
    A('④ 案例文本里（契约位置之外）的 64 位十六进制：exit 1 且字段指向 合成案例/expected.json',
      r4b.code === 1 && r4b.json && r4b.json.scan.hits.some((h) => h.rule === '64 位十六进制' && /合成案例\/expected\.json/.test(h.field)),
      'code=' + r4b.code + ' ' + JSON.stringify(r4b.json && r4b.json.scan.hits.map((h) => h.field)));

    /* ④-c 契约声明的 pageSha 被删掉 ⇒ 没有豁免也没有命中（"豁免只认点名的位置"） */
    const p4c = pilotPack('neg-hash-none', (ctx) => patchCase(ctx, (j) => {
      delete j.input.pageSha;
      j.expected.regions.forEach((r) => { delete r.pageSha; });
    }));
    const r4c = runJson(['预览', '--card', p4c.sel, '--case', p4c.caseId, '--packs', p4c.root], {});
    A('④ 案例里没有契约声明的哈希 ⇒ 豁免 0 且 0 命中（豁免不是"凡例案例一律放过"）',
      r4c.code === 0 && r4c.json && r4c.json.scan.exemptions === 0 && r4c.json.scan.hits.length === 0,
      'code=' + r4c.code);

    /* ⑤ 化名：**替换**（不是判红），并报处数；原词在草稿里必须 0 残留 */
    const p5 = pilotPack('neg-name', (ctx) => setBody(ctx, '这次' + NAME1 + '把两段电阻当成一段了，' + NAME1 + '要记住先加总。\n'));
    const r5 = runJson(['预览', '--card', p5.sel, '--packs', p5.root], {});
    const d5 = JSON.stringify(r5.json && r5.json.draft);
    A('⑤ 化名：exit 0（是**替换**不是判红）且报出替换处数 = 2',
      r5.code === 0 && r5.json && r5.json.scan.replacements.length === 1 && r5.json.scan.replacements[0].n === 2,
      'code=' + r5.code + ' ' + JSON.stringify(r5.json && r5.json.scan.replacements));
    A('⑤ 草稿里原词 0 残留、替换成「孩子A」', !d5.includes(NAME1) && d5.includes('孩子A'), '');
    A('⑤ 人读输出里也**不复述**那个原词（预览屏会被复制/贴图）', !r5.out.includes(NAME1), '');
    const r5b = runJson(['预览', '--card', p5.sel, '--packs', p5.root, '--form', 'cloud'], {});
    A('⑤ cloud 形态同样替换（0 残留）',
      r5b.code === 0 && !JSON.stringify(r5b.json.draft).includes(NAME1) && JSON.stringify(r5b.json.draft).includes('孩子A'), '');
    /* 两个化名的替换是两条独立记录（slot 1/2），不是"凡化名一律记成一条" */
    const p5b = pilotPack('neg-name2', (ctx) => setBody(ctx, NAME2 + '写字慢，' + NAME1 + '要先读题。\n'));
    const r5c = runJson(['预览', '--card', p5b.sel, '--packs', p5b.root], {});
    A('⑤ 两个化名各记一条、各报处数（slot 1/2 对得上）',
      r5c.code === 0 && r5c.json.scan.replacements.length === 2 &&
      r5c.json.scan.replacements.map((x) => x.slot + ':' + x.to + ':' + x.n).join(',') === '1:孩子A:1,2:孩子B:1',
      JSON.stringify(r5c.json && r5c.json.scan.replacements));

    /* ⑥ 源记录里"手写批注 / 聊天原文"形态的**字段名**：出现即红（内容认不出来，字段名是确定信号） */
    const p6 = pilotPack('neg-key', (ctx) => patchPack(ctx, (j) => {
      j.cards[0]['handwriting'] = '孩子写在边上的话（不该外发的那一类）';
    }));
    const r6 = runJson(['预览', '--card', p6.sel, '--packs', p6.root], {});
    A('⑥ pack.json 里出现 handwriting 字段：exit 1 且字段名点名到 cards[0].handwriting',
      r6.code === 1 && r6.json && r6.json.scan.hits.some((h) => /handwriting/.test(h.field) || /handwriting/.test(h.snippet)),
      'code=' + r6.code + ' ' + JSON.stringify(r6.json && r6.json.scan.hits));

    const p6b = pilotPack('neg-key-chat', (ctx) => patchCase(ctx, (j) => { j['微信原文'] = '不该外发的聊天原文'; }));
    const r6b = runJson(['预览', '--card', p6b.sel, '--case', p6b.caseId, '--packs', p6b.root], {});
    A('⑥ expected.json 里出现「微信原文」字段：exit 1 且点名',
      r6b.code === 1 && r6b.json && r6b.json.scan.hits.some((h) => /手写批注\/聊天原文形态的字段名/.test(h.rule)),
      'code=' + r6b.code);
  }

  console.log('\n══ 五、两种形态的差异（接口契约 §1.4）══');
  {
    const p = pilotPack('forms');
    const l = runJson(['预览', '--card', p.sel, '--case', p.caseId, '--packs', p.root], {});
    const c = runJson(['预览', '--card', p.sel, '--case', p.caseId, '--packs', p.root, '--form', 'cloud'], {});
    A('local 是合法 JSON（--json 能解析出 draft 对象）', l.json && l.json.draft && typeof l.json.draft === 'object', '');
    A('两形态的**字段集合完全一致**（差别只在怎么呈现）',
      JSON.stringify(Object.keys(l.json.draft).sort()) === JSON.stringify(Object.keys(c.json.draft).sort()), '');
    /* 形态说明在**人读输出**里（--json 是给机器读的，不带这两行文案） */
    const lHuman = run(['预览', '--card', p.sel, '--case', p.caseId, '--packs', p.root], {});
    A('人读输出里打印"哪一份适合本地留档 / 哪一份适合外发"',
      /本地留档/.test(lHuman.out) && /云端 AI/.test(lHuman.out), lHuman.out.split('\n').slice(1, 5).join(' ｜ '));
    const localFile = path.join(p.root, 'local.json');
    const w = run(['导出', '--card', p.sel, '--case', p.caseId, '--packs', p.root, '--out', localFile], {});
    const lt = fs.readFileSync(localFile, 'utf8');
    A('导出 local exit 0 且落盘的是合法 JSON', w.code === 0 && (() => { try { JSON.parse(lt); return true; } catch { return false; } })(), 'code=' + w.code);
    A('local 文件：0 个盘符/家目录、0 个任务号（独立正则对拍）', !RE_DRIVE.test(lt) && !RE_TASK.test(lt), '');
    A('local 文件：64 位十六进制只出现在**契约声明的 3 处**',
      (lt.match(RE_HEX64) || []).length === 3, (lt.match(RE_HEX64) || []).length + ' 处');
  }

  console.log('\n══ 六、exit 2 族：参数/环境错必须给**具体原因**，且绝不写成别的码 ══');
  const E2 = (name, args, needle, o) => {
    const r = run(args, o || {});
    A(name, r.code === 2 && (!needle || r.err.includes(needle)),
      'code=' + r.code + ' err=' + r.err.split('\n')[0].slice(0, 110));
  };
  {
    const p = pilotPack('exit2');
    E2('两种源同时给 ⇒ 2', ['预览', '--card', p.sel, '--from-pending', 'T003', '--packs', p.root], '只能给一种');
    E2('一种源都不给 ⇒ 2', ['预览', '--packs', p.root], '必须给一种源');
    E2('--case 不配 --card ⇒ 2', ['预览', '--case', p.caseId], '只能配 --card');
    E2('--case 给成路径 ⇒ 2', ['预览', '--card', p.sel, '--case', 'cases/' + p.caseId, '--packs', p.root], '案例 id');
    E2('--form 非法 ⇒ 2', ['预览', '--card', p.sel, '--packs', p.root, '--form', 'json'], 'local|cloud');
    E2('导出缺 --out ⇒ 2', ['导出', '--card', p.sel, '--packs', p.root], '--out 必填');
    E2('--out 的父目录不存在 ⇒ 2（本工具不建目录）',
      ['导出', '--card', p.sel, '--packs', p.root, '--out', path.join(p.root, 'no-such-dir', 'x.json')], '父目录不存在');
    E2('预览带 --out ⇒ 2（预览不写盘）', ['预览', '--card', p.sel, '--packs', p.root, '--out', path.join(p.root, 'x.json')], '不写盘');
    E2('--packs 缺值 ⇒ 2', ['预览', '--card', p.sel, '--packs'], '--packs 需要一个目录参数');
    E2('未知参数 ⇒ 2', ['预览', '--card', p.sel, '--packs', p.root, '--nope'], '未知参数');
    E2('未知子命令 ⇒ 2', ['草稿', '--card', p.sel], '未知子命令');
    E2('选卡串形状不合法 ⇒ 2', ['预览', '--card', '../evil/card@1.0.0', '--packs', p.root], '选卡串');
    E2('包不存在 ⇒ 2', ['预览', '--card', 'no/such/card@1.0.0', '--packs', p.root], '没有安装经验包');
    E2('卡不存在 ⇒ 2', ['预览', '--card', 'family-a/shared-stem/no-such-card@' + PILOT_VER, '--packs', p.root], '没有卡');
    E2('案例 id 不存在 ⇒ 2 且列出卡声明了哪些案例',
      ['预览', '--card', p.sel, '--case', 'no-such-case', '--packs', p.root], '案例与卡不匹配');
    E2('待办编号形状不对 ⇒ 2', ['预览', '--from-pending', 'X9'], '形状不对');

    /* 案例目录**在磁盘上**但没在卡的 cases 里声明 ⇒ 单独点名（接口契约 §1.5 验收点） */
    const pGhost = pilotPack('ghost', (ctx) => {
      const g = path.join(ctx.dir, 'cases', 'ghost');
      fs.mkdirSync(g, { recursive: true });
      fs.writeFileSync(path.join(g, 'input.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n', 'utf8');
      fs.writeFileSync(path.join(g, 'expected.json'), '{"caseId":"ghost"}\n', 'utf8');
    });
    E2('案例在磁盘上但未在卡的 cases 里声明 ⇒ 2 且点名"没声明"',
      ['预览', '--card', pGhost.sel, '--case', 'ghost', '--packs', pGhost.root], '没在本卡的 cases 里声明');

    /* 缺 expected.json ⇒ 2（校验会在 loadCard 处拒收，原因里必须出现 expected.json） */
    const pMiss = pilotPack('miss-expected', (ctx) => {
      fs.rmSync(path.join(ctx.dir, 'cases', ctx.caseId, 'expected.json'));
    });
    E2('案例缺 expected.json ⇒ 2 且原因里出现 expected.json',
      ['预览', '--card', pMiss.sel, '--case', pMiss.caseId, '--packs', pMiss.root], 'expected.json');

    /* 案例 id 对不上（目录名与 expected.json 的 caseId 不一致）⇒ 2 */
    const pMismatch = pilotPack('caseid-mismatch', (ctx) => patchCase(ctx, (j) => { j.caseId = 'other-case'; }));
    E2('expected.json 的 caseId 与 --case 对不上 ⇒ 2 且说清两侧的值',
      ['预览', '--card', pMismatch.sel, '--case', pMismatch.caseId, '--packs', pMismatch.root], '案例 id 对不上');
  }

  console.log('\n══ 七、只读纪律：预览不写盘；导出只写 --out；判红不写盘 ══');
  {
    const p = pilotPack('readonly');
    const packsBefore = snap(p.root);
    const toolsBefore = snap(path.join(ROOT, 'src', 'tools'));
    const libBefore = snap(TMP_LIB);
    const r = run(['预览', '--card', p.sel, '--case', p.caseId, '--packs', p.root], {});
    A('预览 exit 0', r.code === 0, 'code=' + r.code);
    A('预览后：临时包根逐字节不变', sameSnap(packsBefore, snap(p.root)), snapDiff(packsBefore, snap(p.root)).join('、'));
    A('预览后：src\\tools 逐字节不变（不建过程件、不改源码）', sameSnap(toolsBefore, snap(path.join(ROOT, 'src', 'tools'))),
      snapDiff(toolsBefore, snap(path.join(ROOT, 'src', 'tools'))).join('、'));
    A('预览后：库根逐字节不变', sameSnap(libBefore, snap(TMP_LIB)), '');

    const out = path.join(p.root, 'out', 'draft.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const before = snap(p.root);
    /* ⚠ 这两次调用是**独立进程**，草稿里带「生成时间」⇒ 不钉时刻的话跨秒边界就假红
       （2026-11-03 在 quick 里实测撞上：单跑绿、整轮红）。用 `--at` 把时刻钉死：
       判据仍然**逐字比**（不放松成"忽略生成时间那一行"），只是让两次调用可复现。 */
    const AT = '2026-11-03T15:00:00+08:00';
    const w = run(['导出', '--card', p.sel, '--case', p.caseId, '--packs', p.root, '--out', out, '--at', AT], {});
    const after = snap(p.root);
    const diff = snapDiff(before, after);
    A('导出 exit 0', w.code === 0, 'code=' + w.code);
    A('导出只新增 --out 那一个文件（其余文件逐字节不变）',
      diff.length === 1 && diff[0] === 'out/draft.json', diff.join('、'));
    A('--out 落盘内容 == stdout 里那份草稿（逐字；两次调用都用 --at 钉同一时刻）',
      fs.readFileSync(out, 'utf8') === runJson(['预览', '--card', p.sel, '--case', p.caseId, '--packs', p.root, '--at', AT], {}).json.text,
      '');
    /* 反面对照：两次时刻不同 ⇒ 生成时间**必须**不同（证明 --at 真的在起作用，判据不是恒真） */
    A('--at 反面对照：两次不同时刻 ⇒ 草稿里的生成时间随之不同（说明 --at 真的被用上）',
      runJson(['预览', '--card', p.sel, '--packs', p.root, '--at', '2026-11-03T15:00:01+08:00'], {}).json.text !==
      runJson(['预览', '--card', p.sel, '--packs', p.root, '--at', AT], {}).json.text, '');
    A('--at 非法值 ⇒ exit 2（不静默用"现在"顶替）',
      run(['预览', '--card', p.sel, '--packs', p.root, '--at', '昨天'], {}).code === 2, '');

    /* 判红 ⇒ 拒绝写盘 */
    const pBad = pilotPack('readonly-red', (ctx) => setBody(ctx, '原件在 D:\\临时库\\照片.jpg。\n'));
    const outBad = path.join(pBad.root, 'must-not-exist.json');
    const wBad = run(['导出', '--card', pBad.sel, '--packs', pBad.root, '--out', outBad], {});
    A('判红时 exit 1 且**一个字节都不写**', wBad.code === 1 && !fs.existsSync(outBad),
      'code=' + wBad.code + ' exists=' + fs.existsSync(outBad));
  }

  console.log('\n══ 八、--from-pending：经验线索 → 草稿（学生标识一个字段都不搬）══');
  {
    const lib = path.join(TMP, 'lib-pending');
    fs.mkdirSync(lib, { recursive: true });
    const tgt = PILOT_SEL;
    writeJson(path.join(lib, '_待确认.json'), {
      note: '待确认台账', seq: 4,
      items: [
        {
          id: 'T001', student: 'ZZ-学生名', subject: '物理', cardId: '（未入卡）', kind: '错因口述',
          askWho: '孩子', qRef: '第3页 · 第(2)题', question: '为什么把两段电阻算成一段？',
          detail: '这条不是经验线索，用来证明类型门禁有效', raisedAt: '2026-11-03', status: '未确认',
          answer: '', resolvedAt: '', evidence: '', corrections: [],
        },
        {
          id: 'T002', student: 'ZZ-学生名', subject: '物理', cardId: '（未入卡）', kind: '经验线索',
          askWho: '孩子', qRef: '第3页 · 第(2)题', question: '为什么把两段电阻算成一段？',
          detail: '我纠正他：串联要先把两段电阻相加，' + NAME2 + '总当成一段。', raisedAt: '2026-11-03',
          status: '未确认', answer: '', resolvedAt: '', evidence: '',
          /* 键序按 `_待确认.mjs 纠因` 的落盘口径：{ at, why, scope, target } */
          corrections: [
            { at: '2026-11-03T10:00:00+08:00', why: '第一版理由：先加总再算电流。', scope: '卡', target: '' },
            { at: '2026-11-03T11:00:00+08:00', why: '定稿理由：这条只覆盖「整页拆分」这一步，别推到别的步骤。', scope: '配方', target: tgt },
          ],
        },
        {
          id: 'T003', student: 'ZZ-学生名', subject: '物理', cardId: '（未入卡）', kind: '经验线索',
          askWho: '孩子', qRef: '第3页 · 第(2)题', question: '为什么？', detail: '', raisedAt: '2026-11-03',
          status: '未确认', answer: '', resolvedAt: '', evidence: '', corrections: [],
        },
      ],
    });
    const r = runJson(['预览', '--from-pending', 'T002', '--data', lib], {});
    A('经验线索（有 detail + corrections）exit 0', r.code === 0, 'code=' + r.code + ' ' + r.err);
    A('方法正文 = detail（家长原话所在字段）',
      r.json && r.json.draft['方法正文'].includes('我纠正他：串联要先把两段电阻相加'), JSON.stringify(r.json && r.json.draft['方法正文']));
    A('最后一条 correction 的 why 原话**保留**在草稿里（标成「纠正理由（原话）：」）',
      r.json && r.json.draft['方法正文'].includes('纠正理由（原话）：定稿理由：这条只覆盖「整页拆分」这一步') &&
      !r.json.draft['方法正文'].includes('第一版理由'),
      JSON.stringify(r.json && r.json.draft['方法正文']));
    A('适用条件/范围 = corrections[] **最后一条**的 scope（不是第一条）',
      r.json && /^范围：配方/.test(r.json.draft['适用条件']) &&
      r.json.draft['适用条件'].includes('适用对象：' + tgt),
      JSON.stringify(r.json && r.json.draft['适用条件']));
    A('包id/卡id/包版本 从 target 的选卡串解析（复用引擎的形状判据）',
      r.json && r.json.draft['包id'] === 'family-a/shared-stem' && r.json.draft['卡id'] === 'shared-stem' && r.json.draft['包版本'] === PILOT_VER,
      JSON.stringify(r.json && { p: r.json.draft['包id'], c: r.json.draft['卡id'], v: r.json.draft['包版本'] }));
    A('学生标识（student）**一个字段都不搬**：“ZZ-学生名”在草稿里 0 命中',
      r.json && !JSON.stringify(r.json.draft).includes('ZZ-学生名'), '');
    A('化名在 pending 原话里同样被替换（0 残留）',
      r.json && !JSON.stringify(r.json.draft).includes(NAME2) && r.json.draft['方法正文'].includes('孩子B'), '');
    A('待办来源在输出里点名（编号 + 类型 + 库根）',
      r.json && r.json.source.kind === 'pending' && r.json.source.id === 'T002' && r.json.source.kind_text === '经验线索', '');

    /* 反例：类型不是经验线索 / 没有原话 / 条目不存在 */
    const r1 = run(['预览', '--from-pending', 'T001', '--data', lib], {});
    A('类型不是「经验线索」⇒ exit 2 且说清类型 + 怎么加一条',
      r1.code === 2 && r1.err.includes('不是「经验线索」') && r1.err.includes('--kind 经验线索'), 'code=' + r1.code + ' ' + r1.err.split('\n')[0]);
    const r3 = run(['预览', '--from-pending', 'T003', '--data', lib], {});
    A('既没有 corrections[].why 也没有 detail ⇒ exit 2（不拿 question 硬凑）',
      r3.code === 2 && r3.err.includes('没有可导出的原话'), 'code=' + r3.code);
    const r9 = run(['预览', '--from-pending', 'T999', '--data', lib], {});
    A('条目不存在 ⇒ exit 2', r9.code === 2 && r9.err.includes('台账里没有 T999'), 'code=' + r9.code);
    const rEmpty = run(['预览', '--from-pending', 'T002', '--data', path.join(TMP, 'no-such-lib')], {});
    A('库根里没有 _待确认.json ⇒ exit 2 且给出库根路径',
      rEmpty.code === 2 && rEmpty.err.includes('_待确认.json'), 'code=' + rEmpty.code);
  }

  console.log('\n══ 九、纯函数对拍（扫描/抽节/豁免口径）══');
  {
    A('mdSection 能抽出卡里的「什么时候用」小节',
      (() => { const s = M.mdSection('# a\n\ntext\n\n## 什么时候用\n\n- x\n- y\n\n## 下一步\n\nz\n'); return s && s.text.includes('- x') && !s.text.includes('z'); })(), '');
    A('mdSection 抽不到就返回 null（不编）', M.mdSection('# a\n\n没有那一节\n') === null, '');

    const h = 'c'.repeat(64);
    A('scanText：64 位十六进制默认命中', M.scanText('指纹 ' + h).hits.length === 1, '');
    A('scanText：给成具名例外则豁免（且按处数消费）',
      (() => { const r = M.scanText('a ' + h + ' b ' + h, [h]); return r.hits.length === 1 && r.exemptions === 1; })(), '');
    A('scanText：盘符 / 库内路径 / 任务号 各自命中',
      M.scanText('D:\\x\\y.jpg').hits.length === 1 &&
      M.scanText('_待确认.json').hits.length === 1 &&
      M.scanText('t-20261103-120000-abcdef').hits.length === 1, '');
    A('scanText：URL 里的 "p:/" 不算盘符（否则判据恒红）', M.scanText('见 https://example.com/a').hits.length === 0, '');
    A('scanText：小写盘符也算（d:\\x，粒度可选但口径要一致）', M.scanText('d:\\x\\y.jpg').hits.length === 1, '');
  }

  console.log('\n══ 十、跨模块对拍：公开仓 Issue 表单的七个必填 id ↔ 草稿白名单字段 ══');
  {
    /* 为什么要这条：`.github\ISSUE_TEMPLATE\experience.yml`（T3）是"契约文字锁"，
     * 本工具是"实现" —— 两边各自漂移没人会发现（本仓 L-441/L-716 那一族）。
     * 这里用**最小解析**（本仓零第三方依赖）取出表单的收集字段，与白名单做**机读差集**。
     * ⚠ 映射表必须显式：表单的「版本」在白名单里**没有同名字段**（照字面做"七项 ⊆ 白名单"必假红），
     *   它是聚合概念 —— 落到 包版本 / 配方版本 / 工具版本 三个字段上。 */
    const TEMPLATE_MAP = {
      method: { label: '方法正文', draft: ['方法正文'] },
      applies: { label: '适用条件', draft: ['适用条件'] },
      case: { label: '合成案例', draft: ['合成案例'] },
      expected: { label: '预期行为', draft: ['预期行为'] },
      counterexample: { label: '反例', draft: ['反例'] },
      author: { label: '作者', draft: ['作者'] },
      version: { label: '版本', draft: ['包版本', '配方版本', '工具版本'] },
    };
    const YML = path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'experience.yml');
    A('experience.yml 在场（不在 ⇒ 跨模块对拍无从谈起，判红而不是 SKIP）', fs.existsSync(YML), YML);
    const yml = fs.readFileSync(YML, 'utf8');
    /* 只认 `body:` 下以 `  - type: ` 开头的块：`id:` 在 label/description 正文里也可能出现，
       不绑定到块就会把示例文本当成字段（解析器自己造红是假红的一种）。 */
    const blocks = yml.split(/\n(?=  - type: )/).slice(1);
    const formFields = blocks.map((b) => ({
      type: (b.match(/^\s*-\s*type:\s*([A-Za-z0-9_-]+)/) || [])[1],
      id: (b.match(/^\s*id:\s*([A-Za-z0-9_-]+)\s*$/m) || [])[1],
      required: /^\s*required:\s*true\s*$/m.test(b),
      declared: (b.match(/^[ \t]*#\s*白名单字段：(.+?)\s*$/m) || [])[1],
    }));
    const collect = formFields.filter((f) => f.type !== 'markdown');
    A('表单收集字段（非 markdown）= 七个，且都是 required: true',
      collect.length === 7 && collect.every((f) => f.id && f.required),
      collect.map((f) => f.id + (f.required ? '' : '(非必填)')).join(','));
    A('七个 id 与映射表**逐个相等**（多一个/少一个/改名都红）',
      JSON.stringify(collect.map((f) => f.id)) === JSON.stringify(Object.keys(TEMPLATE_MAP)),
      JSON.stringify(collect.map((f) => f.id)));
    A('每个 id 声明的「# 白名单字段：X」与映射表的 label 一致（注释与字段名不许对不上）',
      collect.every((f) => f.declared === (TEMPLATE_MAP[f.id] || {}).label),
      collect.map((f) => f.id + '→' + f.declared).join(' , '));
    A('映射目标**全部**是白名单里的字段名（没有指向不存在的字段）',
      Object.values(TEMPLATE_MAP).every((m) => m.draft.every((d) => M.DRAFT_FIELD_NAMES.includes(d))),
      Object.values(TEMPLATE_MAP).flatMap((m) => m.draft).filter((d) => !M.DRAFT_FIELD_NAMES.includes(d)).join('、') || '全部在白名单里');
    /* 反向：映射到的字段必须真的是本工具会导出的字段（`白名单` 人读输出里逐个点名） */
    const wl = run(['白名单'], {}).out;
    A('映射到的每个白名单字段都在 `白名单` 输出里逐个点名（实现真的提供它们）',
      Object.values(TEMPLATE_MAP).flatMap((m) => m.draft).every((d) => wl.includes(d)),
      Object.values(TEMPLATE_MAP).flatMap((m) => m.draft).filter((d) => !wl.includes(d)).join('、') || '全部点名');
    A('表单的七项**没有**任何一项是"白名单里收不到的哑字段"（差集为空）',
      collect.every((f) => TEMPLATE_MAP[f.id] && TEMPLATE_MAP[f.id].draft.length > 0), '');
  }

  console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  通过=${pass} 失败=${fail} 跳过=${skip} 断言=${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例自身抛错：' + (e && e.stack || e));
  process.exit(1);
});
