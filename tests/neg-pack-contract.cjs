#!/usr/bin/env node
/**
 * 经验包契约门禁（2026-11-03，批次 2 建）
 *
 * 守什么：`src\tools\_经验包.mjs` 是"可插拔方法层"的唯一读取入口。它一旦松了，后果都不会报错：
 *   · 形状判据松 ⇒ `../evil/card@1.0.0` 这种选卡串能过壳、能过引擎，最后去找包根之外的目录
 *     （Lead 2026-11-03 在真 exe 反射测试里当场抓到一次，本文件第二节就是那条 bug 的回归锁）；
 *   · 包含性判据松 ⇒ 一个 junction 就把"只读包内文件"变成"读包外任意文件"；
 *   · 限值/重复 ID/未知 formatVersion 松 ⇒ 坏包被当成好包，用户以为装上了、实际没生效；
 *   · 同版异内容不报 ⇒ 改了内容却沿用版本号，装的和回退的都说不清是哪一份。
 *
 * 写法纪律（本仓惯例）：**每条判据都要有能变红的阴性对照**，而且要**真跑**——
 *   只放正例的断言是恒真的（等于没测）。所以这里对每条规则都造一个"必须被拒"的包/串，
 *   断言 exit code 与**具体原因**（不是"有错"就算过）。
 *
 * 另外两类断言：
 *   · **兼容正例**：仓库里那份 B-07 试点包 `校验` 必须 exit 0（谁改坏试点包，这里先红）；
 *   · **坏包只影响自身**：一个好包 + 一个坏包同处一个包根 ⇒ `清单` 仍 exit 0，两条都列出来。
 *
 * 用法：node tests\neg-pack-contract.cjs
 * 退出码：0=全绿；1=有断言失败
 *
 * ⚠ 本文件**不写**任何用户库：所有夹具都在 %TEMP%（allocTempDir 登记，退出即删）。
 *   `CTB_DATA` 在多数用例里被**显式删除**，用来证明经验包工具不依赖任何库。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const E = require('./_测试环境.cjs');

const ROOT = E.REPO;
const ENGINE = E.tool('_经验包.mjs');
const GUARD = E.tool('_路径护栏.mjs');
/* 仓库内样本包（**不随发布包分发**；安装＝手工复制这个文件夹）。相对路径写，别写死本机绝对路径。 */
const PILOT = path.join(ROOT, 'src', 'packs', 'family-a', 'shared-stem', '1.0.0');
const SRC_PACKS = path.join(ROOT, 'src', 'packs');

let pass = 0, fail = 0, skip = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const SKIP = (name, why) => {
  console.log(`[SKIP] ${name}  → ${why}`);
  skip++;
};

/* ── 跑工具：默认**删掉 CTB_DATA**（证明不依赖库根）；--packs 用环境变量给 ── */
function run(args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env);
  delete env.CTB_PACKS;
  if (o.packs) env.CTB_PACKS = o.packs;
  if (o.noData || !o.data) delete env.CTB_DATA; else env.CTB_DATA = o.data;
  const r = spawnSync(process.execPath, [ENGINE, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function runJson(args, opts) {
  const r = run(args.concat('--json'), opts);
  let json = null;
  try { json = JSON.parse(r.out); } catch { json = null; }
  return { code: r.code, out: r.out, err: r.err, json };
}

const TMP = E.allocTempDir('gn-packneg-');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let rootSeq = 0;
/** 每个用例一个独立包根：避免"同版异内容"判据在用例之间互相串味。 */
const mkRoot = (tag) => path.join(TMP, 'roots', String(++rootSeq).padStart(2, '0') + '-' + tag);

/* ══════════════════ 夹具构造 ══════════════════ */
/** 一份**合规**的最小经验包：pack.json + cards/card-a.md + cases/c1/{input.svg,expected.json} */
function mkValidPack(root, opts) {
  const o = opts || {};
  const packId = o.packId || 'test/pack';
  const version = o.version || '1.0.0';
  const dir = path.join(root, ...packId.split('/'), version);
  fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cases', 'c1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cards', 'card-a.md'), '# 测试卡\n\n这是合成夹具的卡正文，不含任何真实信息。\n', 'utf8');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>\n';
  fs.writeFileSync(path.join(dir, 'cases', 'c1', 'input.svg'), svg, 'utf8');
  const pageSha = sha256(Buffer.from(svg, 'utf8'));
  fs.writeFileSync(path.join(dir, 'cases', 'c1', 'expected.json'), JSON.stringify({
    schema: 'glimmernote.pack-case/v1',
    caseId: 'c1',
    input: { file: 'input.svg', pageSha, imgW: 20, imgH: 20 },
    expected: { registerQuestions: [], regions: [] },
  }, null, 2) + '\n', 'utf8');
  writePackJson(dir, Object.assign({ id: packId, version }, o.pack || {}));
  return dir;
}
/** 写 pack.json；值写 '<<DEL>>' 表示删掉该字段（用来造"缺字段"的坏包） */
function writePackJson(dir, over) {
  const doc = Object.assign({
    formatVersion: 1,
    id: 'test/pack',
    version: '1.0.0',
    title: '测试包',
    author: '测试',
    license: 'CC0-1.0',
    cards: [{ id: 'card-a', title: '测试卡', body: 'cards/card-a.md', steps: ['整页拆分'], cases: ['cases/c1'] }],
  }, over || {});
  for (const k of Object.keys(doc)) if (doc[k] === '<<DEL>>') delete doc[k];
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
}
/** 读校验 JSON（exit 1 时 stdout 仍是完好 JSON） */
function validate(dir, packs) {
  return runJson(['校验', dir], { packs });
}
const hasErr = (v, code, sub) => {
  if (!v || !v.json) return false;
  return (v.json.errors || []).some((e) => e.code === code && (!sub || (e.what + ' ' + e.why).includes(sub)));
};
const errText = (v) => (v && v.json && v.json.errors ? v.json.errors.map((e) => '[' + e.code + '] ' + e.what).join(' | ') : '(无 JSON)');

/* ══════════════════════════════════════════════════════════════════ */
(async () => {
  /* ── 动态 import 两个模块：.cjs 里没有顶层 await，但函数内可以 ── */
  const M = await import(pathToFileURL(ENGINE).href);
  const G = await import(pathToFileURL(GUARD).href);

  console.log('══ 一、试点包（B-07）正例：仓库里那份必须整份合规 ══');
  {
    const r = validate(PILOT, SRC_PACKS);
    A('试点包 校验 exit 0', r.code === 0, 'code=' + r.code + (r.json ? ' ok=' + r.json.ok : ''));
    const j = r.json || {};
    A('试点包 id/version/formatVersion 正确',
      j.id === 'family-a/shared-stem' && j.version === '1.0.0' && j.formatVersion === 1,
      JSON.stringify({ id: j.id, version: j.version, formatVersion: j.formatVersion }));
    const card = (j.cards || [])[0] || {};
    A('试点包恰好 1 张卡且 id=shared-stem', (j.cards || []).length === 1 && card.id === 'shared-stem',
      '卡=' + (j.cards || []).map((c) => c.id).join(','));
    A('试点包卡声明覆盖步骤与案例',
      JSON.stringify(card.steps) === '["整页拆分"]' && JSON.stringify(card.cases) === '["cases/shared-stem"]',
      JSON.stringify({ steps: card.steps, cases: card.cases }));
    A('bodySha256 是 64 位十六进制', /^[0-9a-f]{64}$/.test(String(card.bodySha256)), String(card.bodySha256));

    const bodyAbs = path.join(PILOT, 'cards', 'shared-stem.md');
    A('bodySha256 == 直接算卡文件的字节 sha256',
      card.bodySha256 === sha256(fs.readFileSync(bodyAbs)),
      card.bodySha256 + ' vs ' + sha256(fs.readFileSync(bodyAbs)));

    const l = runJson(['清单'], { packs: SRC_PACKS });
    A('清单 exit 0 且列出 1 个包（id/version/启用状态/校验结论）',
      l.code === 0 && l.json && l.json.packs.length === 1 &&
      l.json.packs[0].id === 'family-a/shared-stem' && l.json.packs[0].version === '1.0.0' &&
      l.json.packs[0].enabled === true && l.json.packs[0].verdict.ok === true,
      l.json ? JSON.stringify(l.json.packs.map((p) => [p.id, p.version, p.enabled, p.verdict.ok])) : 'out=' + l.out.slice(0, 120));

    const s = runJson(['摘要', PILOT], { packs: SRC_PACKS });
    A('摘要 exit 0 且给整包摘要 + 每张卡正文 sha256 前 12 位',
      s.code === 0 && /^[0-9a-f]{64}$/.test(String(s.json && s.json.digest)) &&
      s.json.cards[0].bodySha256Short === String(s.json.cards[0].bodySha256).slice(0, 12),
      s.json ? 'digest=' + s.json.digestShort + ' card=' + s.json.cards[0].bodySha256Short : 'out=' + s.out.slice(0, 120));
  }

  /* ── 试点包案例：区域契约自检（形状口径引用 docs\区域契约.md；本文件不另造一份判据实现）── */
  {
    const caseDir = path.join(PILOT, 'cases', 'shared-stem');
    const exp = JSON.parse(fs.readFileSync(path.join(caseDir, 'expected.json'), 'utf8'));
    const svgSha = sha256(fs.readFileSync(path.join(caseDir, exp.input.file)));
    A('案例 pageSha == input.svg 的字节 sha256（坐标可复算的锚）',
      exp.input.pageSha === svgSha, exp.input.pageSha + ' vs ' + svgSha);
    const ROLE_OK = ['错误位置', '公共条件', '配图'];
    const regions = exp.expected.regions || [];
    const eps = 0.001;
    const shapeOk = regions.every((r) =>
      ROLE_OK.includes(r.role) &&
      typeof r.x === 'number' && typeof r.y === 'number' && typeof r.w === 'number' && typeof r.h === 'number' &&
      r.x >= 0 && r.x <= 1 && r.y >= 0 && r.y <= 1 && r.w > 0 && r.w <= 1 && r.h > 0 && r.h <= 1 &&
      r.x + r.w <= 1 + eps && r.y + r.h <= 1 + eps &&
      Number.isInteger(r.imgW) && r.imgW > 0 && Number.isInteger(r.imgH) && r.imgH > 0 &&
      /^[0-9a-f]{64}$/.test(String(r.pageSha)));
    A('案例 regions 满足区域契约形状（归一化 0~1、imgW/imgH、pageSha 64hex、role 合法）',
      regions.length === 2 && shapeOk, 'regions=' + regions.length + ' 形状=' + shapeOk);
    A('案例两个区域角色分别是「错误位置」「公共条件」',
      regions.map((r) => r.role).join(',') === '错误位置,公共条件',
      regions.map((r) => r.role).join(','));
    A('案例区域引用的 pageSha 就是本页 input.svg',
      regions.every((r) => r.pageSha === svgSha), '');
    A('案例期望：登记 (2)、跳过 (1)',
      JSON.stringify(exp.expected.registerQuestions) === '["(2)"]'
      && JSON.stringify(exp.expected.skipQuestions) === '["(1)"]',
      JSON.stringify({ reg: exp.expected.registerQuestions, skip: exp.expected.skipQuestions }));
    A('案例带两个对照（小问互不依赖不扩区域 / 条件在未提供的下一页 ⇒ 待确认）',
      (exp.controls || []).length === 2
      && exp.controls.some((c) => /independent/.test(c.id))
      && exp.controls.some((c) => /next-page/.test(c.id) && /待确认/.test(c.expect)),
      (exp.controls || []).map((c) => c.id).join(','));
  }

  console.log('\n══ 二、选卡串形状（与 C# 壳 §4 同一条判据；Lead 抓到的 `../evil` 漏洞回归锁）══');
  {
    const ok1 = M.parseCardSel('family-a/shared-stem/shared-stem@1.0.0');
    A('正例：三段选卡串解析正确（packId=前两段, cardId=最后一段）',
      ok1.ok && ok1.packId === 'family-a/shared-stem' && ok1.cardId === 'shared-stem' && ok1.version === '1.0.0',
      JSON.stringify(ok1));
    const ok2 = M.parseCardSel('a/b/c@2.3.4');
    A('正例：>2 段按"最后一段 = cardId"切',
      ok2.ok && ok2.packId === 'a/b' && ok2.cardId === 'c' && ok2.version === '2.3.4', JSON.stringify(ok2));
    const ok3 = M.parseCardSel('p/c@1.0.0');
    A('正例：两段（packId 一段 + cardId）合法',
      ok3.ok && ok3.packId === 'p' && ok3.cardId === 'c', JSON.stringify(ok3));

    /* ★ 回归锁：这条就是 Lead 在真 exe 反射里抓到的缺陷 —— `..` 段曾经整条通过形状门禁 */
    const evil = M.parseCardSel('../evil/card@1.0.0');
    A('★ 反例：`../evil/card@1.0.0` 必须不合法（`..` 段 = 路径穿越）',
      evil.ok === false && /\.\.|\. 或/.test(evil.why), evil.ok ? '被放行了！' : evil.why);
    A('★ loadCard 对 `../evil/card@1.0.0` 必须拒（code=2 + 可归因 sel-format）',
      (() => { const r = M.loadCard('../evil/card@1.0.0', TMP); return r.ok === false && r.code === 2 && r.reason === 'sel-format'; })(),
      JSON.stringify(M.loadCard('../evil/card@1.0.0', TMP)));

    const bads = [
      ['./a/b@1.0.0', '首段以 . 开头'],
      ['a/../b@1.0.0', '.. 段'],
      ['a/./b@1.0.0', '. 段'],
      ['/etc/c@1.0.0', '绝对路径'],
      ['C:/x/c@1.0.0', '盘符绝对路径'],
      ['a\\b\\c@1.0.0', '反斜杠'],
      ['a/b@1.0', '版本号少一段'],
      ['a/b@1.0.0.0', '版本号多一段'],
      ['a/b@v1.0.0', '版本号非数字'],
      ['ab@1.0.0', '只有一段（没有 packId）'],
      ['a/b c@1.0.0', '段里有空格'],
      ['a/b@1.0.0 ', '尾部空格（trim 后合法，但这里测内部空格）'],
      ['', '空串'],
      [null, 'null'],
    ];
    let badOk = 0;
    const detail = [];
    for (const [s, why] of bads) {
      const r = M.parseCardSel(s);
      /* 最后一条 `a/b@1.0.0 ` trim 后是合法的 —— 它测的是"允许前后空格、但形状仍按 trim 后判" */
      const expectOk = s === 'a/b@1.0.0 ';
      const good = expectOk ? r.ok === true : r.ok === false;
      if (good) badOk++; else detail.push(JSON.stringify(s) + '(' + why + ') → ' + (r.ok ? '被放行' : r.why));
    }
    A('★ 反例组：' + bads.length + ' 条畸形选卡串全部按预期处理（含 . / .. / 绝对 / 反斜杠 / 版本号 / 空格）',
      badOk === bads.length, badOk + '/' + bads.length + (detail.length ? ' 不符：' + detail.join('；') : ''));
  }

  console.log('\n══ 三、loadCard 失败原因必须可归因（6 类各一条）══');
  {
    const root = mkRoot('loadcard');
    const dir = mkValidPack(root);
    const okSel = 'test/pack/card-a@1.0.0';

    const good = M.loadCard(okSel, root);
    A('正例：loadCard 成功且带上正文/steps/cases/dir',
      good.ok === true && good.card.packId === 'test/pack' && good.card.cardId === 'card-a'
      && good.card.body.includes('测试卡') && good.card.bodySha256 === sha256(Buffer.from(good.card.body, 'utf8'))
      && JSON.stringify(good.card.steps) === '["整页拆分"]' && good.card.dir === dir,
      good.ok ? JSON.stringify({ steps: good.card.steps, dir: path.basename(good.card.dir) }) : JSON.stringify(good));

    const unknownCard = M.loadCard('test/pack/nope@1.0.0', root);
    A('未知卡 ⇒ code=2 + reason=card-unknown（并列出包里有哪几张）',
      unknownCard.ok === false && unknownCard.reason === 'card-unknown' && /card-a/.test(unknownCard.why),
      String(unknownCard.why || '').split('\n')[0]);

    const unknownVer = M.loadCard('test/pack/card-a@9.9.9', root);
    A('未知版本 ⇒ code=2 + reason=version-unknown（并列出已安装版本）',
      unknownVer.ok === false && unknownVer.reason === 'version-unknown' && /1\.0\.0/.test(unknownVer.why),
      String(unknownVer.why || '').split('\n')[0]);

    const unknownPack = M.loadCard('no/such@1.0.0', root);
    A('未知包 ⇒ code=2 + reason=pack-unknown',
      unknownPack.ok === false && unknownPack.reason === 'pack-unknown',
      String(unknownPack.why || '').split('\n')[0]);

    const rootMissing = M.loadCard(okSel, path.join(TMP, 'no-such-root'));
    A('包根不存在 ⇒ code=2 + reason=packs-root-missing（并给出"安装=手工复制"）',
      rootMissing.ok === false && rootMissing.reason === 'packs-root-missing' && /手工复制/.test(rootMissing.why),
      String(rootMissing.why || '').split('\n')[0]);

    /* 停用：包内放 .停用 ⇒ 选它 exit 2 且**带出停用原因**；但 校验 仍 exit 0（停用不是坏包）*/
    fs.writeFileSync(path.join(dir, '.停用'), '合成夹具：停用原因=等下一版\n', 'utf8');
    const disabled = M.loadCard(okSel, root);
    A('★ 已停用包被选 ⇒ code=2 + reason=pack-disabled + 带出停用原因 + 说明恢复办法',
      disabled.ok === false && disabled.reason === 'pack-disabled'
      && /停用原因=等下一版/.test(disabled.why) && /删掉/.test(disabled.why),
      String(disabled.why || '').split('\n')[0]);
    const vDisabled = validate(dir, root);
    A('停用包本身仍能 校验 通过（停用是状态，不是内容不合法）',
      vDisabled.code === 0 && vDisabled.json.ok === true
      && (vDisabled.json.notes || []).some((n) => /停用/.test(n)),
      'code=' + vDisabled.code + ' notes=' + JSON.stringify((vDisabled.json || {}).notes));
    fs.unlinkSync(path.join(dir, '.停用'));

    /* 坏包被选：删掉卡正文 ⇒ pack-broken，且原因里点名缺哪个文件 */
    fs.unlinkSync(path.join(dir, 'cards', 'card-a.md'));
    const broken = M.loadCard(okSel, root);
    A('★ 包损坏（卡正文缺失）被选 ⇒ code=2 + reason=pack-broken + 点名缺的文件',
      broken.ok === false && broken.reason === 'pack-broken' && /cards\/card-a\.md/.test(broken.why),
      String(broken.why || '').split('\n')[0]);
  }

  console.log('\n══ 四、校验：结构类阴性对照（每条都必须 exit 1 且给具体原因）══');
  {
    const cases = [
      ['缺 pack.json', (dir) => { fs.unlinkSync(path.join(dir, 'pack.json')); }, '结构', 'pack.json'],
      ['formatVersion=2（未知版本）', (dir) => { writePackJson(dir, { formatVersion: 2 }); }, '未知版本', 'formatVersion'],
      ['formatVersion 缺失', (dir) => { writePackJson(dir, { formatVersion: '<<DEL>>' }); }, '未知版本', 'formatVersion'],
      ['cards 非数组', (dir) => { writePackJson(dir, { cards: 'x' }); }, '结构', 'cards'],
      ['cards 空数组', (dir) => { writePackJson(dir, { cards: [] }); }, '结构', 'cards'],
      ['缺 id', (dir) => { writePackJson(dir, { id: '<<DEL>>' }); }, '结构', 'id'],
      ['id 形状非法（含 ..）', (dir) => { writePackJson(dir, { id: 'a/../b' }); }, '结构', 'id'],
      ['缺 version', (dir) => { writePackJson(dir, { version: '<<DEL>>' }); }, '结构', 'version'],
      ['version 非 数字.数字.数字', (dir) => { writePackJson(dir, { version: '1.0' }); }, '结构', 'version'],
    ];
    for (const [name, mutate, code, sub] of cases) {
      const root = mkRoot('struct');
      const dir = mkValidPack(root);
      mutate(dir);
      const r = validate(dir, root);
      A(name + ' ⇒ exit 1 + [' + code + '] 含 "' + sub + '"',
        r.code === 1 && hasErr(r, code, sub), 'code=' + r.code + ' ' + errText(r));
    }

    /* 重复卡 ID：同一包内两张卡同 id */
    const root2 = mkRoot('dup');
    const dir2 = mkValidPack(root2);
    writePackJson(dir2, {
      cards: [
        { id: 'card-a', body: 'cards/card-a.md' },
        { id: 'card-a', body: 'cards/card-a.md' },
      ],
    });
    const r2 = validate(dir2, root2);
    A('重复卡 ID ⇒ exit 1 + [重复] + 点名 cards[1]（选卡串会因此指代不明）',
      r2.code === 1 && hasErr(r2, '重复', 'cards[1]'), 'code=' + r2.code + ' ' + errText(r2));

    /* 目录名与 pack.json 对账（只在"已安装"位置才有意义） */
    const root3 = mkRoot('dirname');
    mkValidPack(root3, { packId: 'fam/pkg', version: '1.0.0' });
    const wrongVer = path.join(root3, 'fam', 'pkg', '1.0.1');
    fs.cpSync(path.join(root3, 'fam', 'pkg', '1.0.0'), wrongVer, { recursive: true });
    const r3 = validate(wrongVer, root3);
    A('目录名 version 与 pack.json 不一致 ⇒ exit 1 + [结构] 目录/版本',
      r3.code === 1 && hasErr(r3, '结构', '目录/版本'), 'code=' + r3.code + ' ' + errText(r3));

    const root4 = mkRoot('dirname2');
    mkValidPack(root4, { packId: 'fam/pkg', version: '1.0.0' });
    const wrongId = path.join(root4, 'other', 'name', '1.0.0');
    fs.mkdirSync(path.dirname(wrongId), { recursive: true });
    fs.cpSync(path.join(root4, 'fam', 'pkg', '1.0.0'), wrongId, { recursive: true });
    const r4 = validate(wrongId, root4);
    A('目录推出的 packId 与 pack.json id 不一致 ⇒ exit 1 + [结构] 目录/id',
      r4.code === 1 && hasErr(r4, '结构', '目录/id'), 'code=' + r4.code + ' ' + errText(r4));

    /* 候选目录（不在包根下）不按目录名对账，且不许误报 —— 试点包在空包根下必须仍 exit 0 */
    const root5 = mkRoot('candidate');
    fs.mkdirSync(root5, { recursive: true });
    const r5 = validate(PILOT, root5);
    A('候选目录（不在包根下）⇒ 不按目录名对账、不误报，exit 0 + note 说明是候选',
      r5.code === 0 && (r5.json.notes || []).some((n) => /候选/.test(n)),
      'code=' + r5.code + ' notes=' + JSON.stringify((r5.json || {}).notes));
  }

  console.log('\n══ 五、校验：缺文件 / 越界 阴性对照 ══');
  {
    /* 缺文件三连：body / cases 目录 / input.svg / expected.json */
    const rootA = mkRoot('missing-body');
    const dirA = mkValidPack(rootA);
    fs.unlinkSync(path.join(dirA, 'cards', 'card-a.md'));
    const rA = validate(dirA, rootA);
    A('卡 body 指向的文件不存在 ⇒ exit 1 + [缺文件] 含 body 路径',
      rA.code === 1 && hasErr(rA, '缺文件', 'card-a.md'), 'code=' + rA.code + ' ' + errText(rA));

    const rootB = mkRoot('missing-case');
    const dirB = mkValidPack(rootB);
    fs.rmSync(path.join(dirB, 'cases', 'c1'), { recursive: true, force: true });
    const rB = validate(dirB, rootB);
    A('cases[] 目录不存在 ⇒ exit 1 + [缺文件]',
      rB.code === 1 && hasErr(rB, '缺文件', 'cases/c1'), 'code=' + rB.code + ' ' + errText(rB));

    const rootC = mkRoot('missing-input');
    const dirC = mkValidPack(rootC);
    fs.unlinkSync(path.join(dirC, 'cases', 'c1', 'input.svg'));
    const rC = validate(dirC, rootC);
    A('案例缺 input.svg ⇒ exit 1 + [缺文件] 含 input.svg',
      rC.code === 1 && hasErr(rC, '缺文件', 'input.svg'), 'code=' + rC.code + ' ' + errText(rC));

    const rootD = mkRoot('missing-expected');
    const dirD = mkValidPack(rootD);
    fs.unlinkSync(path.join(dirD, 'cases', 'c1', 'expected.json'));
    const rD = validate(dirD, rootD);
    A('案例缺 expected.json ⇒ exit 1 + [缺文件] 含 expected.json',
      rD.code === 1 && hasErr(rD, '缺文件', 'expected.json'), 'code=' + rD.code + ' ' + errText(rD));

    const rootE = mkRoot('bad-expected');
    const dirE = mkValidPack(rootE);
    fs.writeFileSync(path.join(dirE, 'cases', 'c1', 'expected.json'), '{ 这不是 JSON', 'utf8');
    const rE = validate(dirE, rootE);
    A('expected.json 不是合法 JSON ⇒ exit 1 + [结构]（坏案例不许静默跳过）',
      rE.code === 1 && hasErr(rE, '结构', 'JSON'), 'code=' + rE.code + ' ' + errText(rE));

    /* 越界四连：绝对路径 / .. 越界 / 外部 URL / // 开头 */
    const cases = [
      ['body 用绝对路径', 'Q:/x.md', '绝对路径'],
      ['body 用盘符绝对路径', 'Q:\\x.md', '绝对路径'],
      ['body 用 .. 越界', '../../outside.md', '越出包根'],
      ['body 用外部 URL', 'https://example.com/x.md', '外部 URL'],
      ['body 用 // 开头', '//host/share/x.md', '外部 URL'],
    ];
    for (const [name, body, sub] of cases) {
      const root = mkRoot('escape');
      const dir = mkValidPack(root);
      writePackJson(dir, { cards: [{ id: 'card-a', body, cases: ['cases/c1'] }] });
      const r = validate(dir, root);
      A(name + ' ⇒ exit 1 + [越界] 含 "' + sub + '"',
        r.code === 1 && hasErr(r, '越界', sub), 'code=' + r.code + ' ' + errText(r));
    }
  }

  console.log('\n══ 六、校验：限值（给实际数字，不写"过大"）══');
  {
    /* 超文件数：包内非隐藏文件 > MAX_FILES(64) */
    const root1 = mkRoot('limit-files');
    const dir1 = mkValidPack(root1);
    for (let i = 0; i < 64; i++) fs.writeFileSync(path.join(dir1, 'bulk-' + i + '.txt'), 'x', 'utf8');
    const r1 = validate(dir1, root1);
    /* 夹具是"递归数非隐藏文件"（与引擎同一口径）——数错了这条断言就会变成恒真/恒假 */
    const countFiles = (d) => fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(d, e.name)) : 1), 0);
    const n1 = countFiles(dir1);
    A('包内数据文件超过 MAX_FILES ⇒ exit 1 + [限值] 含实际数字 ' + n1 + ' 与上限 64',
      r1.code === 1 && n1 > 64 && hasErr(r1, '限值', '数据文件 ' + n1 + ' 个') && hasErr(r1, '限值', '64'),
      'code=' + r1.code + ' ' + errText(r1));

    /* 超单文件体积：MAX_FILE_BYTES=262144 */
    const root2 = mkRoot('limit-filebytes');
    const dir2 = mkValidPack(root2);
    fs.writeFileSync(path.join(dir2, 'big.bin'), Buffer.alloc(262145, 0x41));
    const r2 = validate(dir2, root2);
    A('单文件超过 MAX_FILE_BYTES ⇒ exit 1 + [限值] 含实际字节 262145 与上限 262144',
      r2.code === 1 && hasErr(r2, '限值', '262145') && hasErr(r2, '限值', '262144'),
      'code=' + r2.code + ' ' + errText(r2));

    /* 整包合计：MAX_PACK_BYTES=1048576（5 × 230000 = 1150000，每个都低于单文件上限）*/
    const root3 = mkRoot('limit-total');
    const dir3 = mkValidPack(root3);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir3, 'chunk-' + i + '.bin'), Buffer.alloc(230000, 0x42));
    const r3 = validate(dir3, root3);
    A('整包合计超过 MAX_PACK_BYTES ⇒ exit 1 + [限值] 含实际合计与上限 1048576',
      r3.code === 1 && hasErr(r3, '限值', '1048576'), 'code=' + r3.code + ' ' + errText(r3));

    /* 反例的反面：刚好在限值内必须放行（否则"限值"会变成恒红的假门禁） */
    const root4 = mkRoot('limit-ok');
    const dir4 = mkValidPack(root4);
    fs.writeFileSync(path.join(dir4, 'ok.bin'), Buffer.alloc(262144, 0x43));
    const r4 = validate(dir4, root4);
    A('恰好在限值上（单文件=262144 字节）⇒ 放行 exit 0（限值不是恒红）',
      r4.code === 0, 'code=' + r4.code + ' ' + errText(r4));
  }

  console.log('\n══ 七、校验：重解析点逃逸（junction）══');
  {
    const root = mkRoot('junction');
    const dir = mkValidPack(root);
    /* 包外目录：一份"看起来完全合规"的案例，用 junction 挂进包内 */
    const outside = path.join(TMP, 'outside-case');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'input.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n', 'utf8');
    fs.writeFileSync(path.join(outside, 'expected.json'), JSON.stringify({ schema: 'glimmernote.pack-case/v1' }) + '\n', 'utf8');
    const linkPath = path.join(dir, 'cases', 'evil');
    let junctionErr = null;
    try { fs.symlinkSync(outside, linkPath, 'junction'); } catch (e) { junctionErr = e; }
    if (junctionErr) {
      SKIP('junction 逃逸阴性对照', '本机建不出 junction（' + junctionErr.code + '）：' + junctionErr.message);
    } else {
      writePackJson(dir, { cards: [{ id: 'card-a', body: 'cards/card-a.md', cases: ['cases/evil'] }] });
      const r = validate(dir, root);
      A('★ 案例目录是 junction、真实路径在包根外 ⇒ exit 1 + [越界] 重解析点逃逸',
        r.code === 1 && hasErr(r, '越界', '重解析点逃逸'), 'code=' + r.code + ' ' + errText(r));

      /* 字符串包含性判据看不到它（路径字符串还在包内）—— 证明 realpath 那一道**不可省** */
      const insideStr = G.isInside(dir, path.join(dir, 'cases', 'evil'));
      A('对照：纯字符串判据对 junction 看不出问题（所以 realpath 判据不能省）',
        insideStr === true, 'isInside=' + insideStr);
    }

    /* 版本目录本身是 junction（指向包根之外）：
       ① 清单必须**把它列出来**（不许因为"目录是链接"就静默消失）；
       ② 校验必须判红（realpath 逃逸）。 */
    const root3 = mkRoot('junction-pack');
    fs.mkdirSync(root3, { recursive: true });
    const realRoot = path.join(TMP, 'real-pack-root');
    const realPack = mkValidPack(realRoot, { packId: 'linked/pack' });
    const linkParent = path.join(root3, 'linked', 'pack');
    fs.mkdirSync(linkParent, { recursive: true });
    let packLinkErr = null;
    try { fs.symlinkSync(realPack, path.join(linkParent, '1.0.0'), 'junction'); } catch (e) { packLinkErr = e; }
    if (packLinkErr) {
      SKIP('包目录为 junction 的清单可见性', '本机建不出 junction（' + packLinkErr.code + '）');
    } else {
      const l3 = runJson(['清单'], { packs: root3 });
      const p3 = l3.json && (l3.json.packs || [])[0];
      A('★ 版本目录是 junction ⇒ 清单仍然列出来（不许因为"它是链接"就静默消失）',
        l3.code === 0 && p3 && p3.id === 'linked/pack' && p3.version === '1.0.0' && p3.enabled === true,
        p3 ? JSON.stringify({ id: p3.id, version: p3.version, ok: p3.verdict.ok }) : 'out=' + l3.out.slice(0, 120));
      /* 边界（写进 docs\经验包规范.md §七）：包含性判据以**包根的真实路径**为界，
         所以"包根本身就是链接"不算逃逸（真实路径就是包根本身），包内引用仍必须落在其中。
         这一条是把边界钉住：哪天有人把判据改成"包根必须是普通目录"，这里先红。 */
      const v3 = validate(path.join(linkParent, '1.0.0'), root3);
      A('边界：包根本身是重解析点不算逃逸（判据以真实路径为界）；包内引用仍受包含性约束',
        v3.code === 0, 'code=' + v3.code + ' ' + errText(v3));
    }

    /* body 用文件级软链（Windows 需要权限）；建不出来就显式 SKIP，绝不静默放过 */
    const root2 = mkRoot('symlink-file');
    const dir2 = mkValidPack(root2);
    const outFile = path.join(TMP, 'outside-body.md');
    fs.writeFileSync(outFile, '# 包外正文\n', 'utf8');
    let fileLinkErr = null;
    try { fs.symlinkSync(outFile, path.join(dir2, 'cards', 'linked.md'), 'file'); } catch (e) { fileLinkErr = e; }
    if (fileLinkErr) {
      SKIP('body 文件软链逃逸阴性对照', '本机无建文件软链权限（' + fileLinkErr.code + '）');
    } else {
      writePackJson(dir2, { cards: [{ id: 'card-a', body: 'cards/linked.md' }] });
      const r2 = validate(dir2, root2);
      A('★ body 是文件软链、真实路径在包根外 ⇒ exit 1 + [越界] 重解析点逃逸',
        r2.code === 1 && hasErr(r2, '越界', '重解析点逃逸'), 'code=' + r2.code + ' ' + errText(r2));
    }
  }

  console.log('\n══ 八、同版异内容（改内容却沿用版本号 ⇒ 必须显式报告）══');
  {
    const root = mkRoot('same-ver');
    const installed = mkValidPack(root, { packId: 'test/pack' });
    /* 候选目录：同 id@version，但正文被改过 ⇒ 应报「同版异内容」并给两侧摘要前 12 位 */
    const cand = path.join(TMP, 'cand-same-ver');
    fs.cpSync(installed, cand, { recursive: true });
    fs.writeFileSync(path.join(cand, 'cards', 'card-a.md'), '# 测试卡\n\n**改过**的正文。\n', 'utf8');
    const r = validate(cand, root);
    A('★ 同一 id@version 内容不同 ⇒ exit 1 + [同版异内容] + 提示"新版本号并列留存"',
      r.code === 1 && hasErr(r, '同版异内容', '新版本号'), 'code=' + r.code + ' ' + errText(r));
    const digestLine = (r.json && r.json.errors || []).map((e) => e.why).join(' ');
    A('同版异内容的原因里带**两侧摘要前 12 位**',
      /[0-9a-f]{12}/.test(digestLine) && (digestLine.match(/[0-9a-f]{12}/g) || []).length >= 2,
      (digestLine.match(/[0-9a-f]{12}/g) || []).join(' vs '));

    /* 反面：同内容复制过去必须放行（否则每次复制都会红，判据变成噪音） */
    const cand2 = path.join(TMP, 'cand-same-content');
    fs.cpSync(installed, cand2, { recursive: true });
    const r2 = validate(cand2, root);
    A('同内容复制到别处（摘要相同）⇒ exit 0（不误报）',
      r2.code === 0, 'code=' + r2.code + ' ' + errText(r2));
  }

  console.log('\n══ 九、坏包只影响自身 + 清单是报告不是门禁 ══');
  {
    const root = mkRoot('isolation');
    /* 好包：路径必须与它 pack.json 里的 id 对上（`family-a/shared-stem`），否则会因"目录/id 不一致"判红 */
    const good = path.join(root, 'family-a', 'shared-stem', '1.0.0');
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.cpSync(PILOT, good, { recursive: true });
    const bad = mkValidPack(root, { packId: 'bad/pack' });
    fs.unlinkSync(path.join(bad, 'pack.json'));          // 坏包：连清单文件都没有

    const l = runJson(['清单'], { packs: root });
    A('清单 exit 0（一个坏包不许让整份清单崩）', l.code === 0, 'code=' + l.code);
    A('清单把好包和"缺 pack.json 的坏包"都列出来（2 个，坏包不许从清单里消失）',
      l.json && l.json.packs.length === 2, l.json ? l.json.packs.map((p) => p.id + '@' + p.version).join(',') : 'out=' + l.out.slice(0, 160));
    const byId = new Map(((l.json && l.json.packs) || []).map((p) => [p.id, p]));
    A('好包 verdict.ok=true、坏包 verdict.ok=false 且带具体原因',
      byId.get('family-a/shared-stem') && byId.get('family-a/shared-stem').verdict.ok === true
      && byId.get('bad/pack') && byId.get('bad/pack').verdict.ok === false
      && (byId.get('bad/pack').verdict.errors || []).some((e) => /pack\.json/.test(e.what + e.why)),
      JSON.stringify({
        good: byId.get('family-a/shared-stem') && byId.get('family-a/shared-stem').verdict.ok,
        bad: byId.get('bad/pack') && byId.get('bad/pack').verdict.errors.map((e) => e.code),
      }));

    /* 根不存在：清单 exit 0 + 明确说"没有安装任何经验包"（不是报错、也不是静默空输出） */
    const empty = run(['清单'], { packs: path.join(TMP, 'never-created-root') });
    A('包根不存在 ⇒ 清单 exit 0 且打印「没有安装任何经验包」',
      empty.code === 0 && /没有安装任何经验包/.test(empty.out), 'code=' + empty.code + ' out=' + empty.out.slice(0, 60));

    /* 空目录（存在但没包）也必须 exit 0 */
    const emptyDir = path.join(TMP, 'empty-root');
    fs.mkdirSync(emptyDir, { recursive: true });
    const empty2 = run(['清单'], { packs: emptyDir });
    A('空包根（目录在、无包）⇒ 清单 exit 0 且打印「没有安装任何经验包」',
      empty2.code === 0 && /没有安装任何经验包/.test(empty2.out), 'code=' + empty2.code);
  }

  console.log('\n══ 十、退出码与用法（0/1/2 语义不许混）══');
  {
    const missing = run(['校验', path.join(TMP, 'no-such-pack-dir')], { packs: path.join(TMP, 'x') });
    A('校验 目录不存在 ⇒ exit 2（环境/用法错，不是"内容不合法"的 1）', missing.code === 2, 'code=' + missing.code);

    const noSub = run([], { packs: path.join(TMP, 'x') });
    A('无子命令 ⇒ exit 2 且打印用法', noSub.code === 2, 'code=' + noSub.code);

    const unknown = run(['不认识'], { packs: path.join(TMP, 'x') });
    A('未知子命令 ⇒ exit 2（不许猜一个分支跑）', unknown.code === 2 && /未知子命令/.test(unknown.err), 'code=' + unknown.code);

    const packsNoVal = run(['清单', '--packs'], {});
    A('`--packs` 缺值 ⇒ exit 2（不许静默回落到默认根）', packsNoVal.code === 2, 'code=' + packsNoVal.code);

    /* 摘要对坏包：契约 §2.1 的表只写 0/2，这里刻意加 1（已上报 Lead）——
       否则坏包会被打印成一份看起来正常的摘要。 */
    const root = mkRoot('summary-bad');
    const dir = mkValidPack(root);
    fs.unlinkSync(path.join(dir, 'pack.json'));
    const s = run(['摘要', dir], { packs: root });
    A('摘要 对坏包 ⇒ exit 1（拒绝输出"看起来正常"的摘要；契约表只写了 0/2，已上报 Lead）',
      s.code === 1 && /拒绝输出/.test(s.err), 'code=' + s.code + ' err=' + s.err.split('\n')[0]);
  }

  console.log('\n══ 十一、不依赖库根（导入期不求值 libraryRoot）+ 路径护栏 isInside ══');
  {
    /* 显式删掉 CTB_DATA：若 `_经验包.mjs` 在导入期求值库根，开发区会当场抛
       「拒绝把源码树当作库根」⇒ 这一条会红。这是 2026-10-31 `_配方.mjs` 那次事故的同族回归锁。 */
    const noLib = run(['清单'], { packs: SRC_PACKS });
    A('★ 无 CTB_DATA（无库）也能 清单：经验包工具不依赖库根',
      noLib.code === 0 && /family-a\/shared-stem/.test(noLib.out),
      'code=' + noLib.code + ' out=' + noLib.out.replace(/\s+/g, ' ').slice(0, 80));

    const vNoLib = validate(PILOT, SRC_PACKS);
    A('无 CTB_DATA 也能 校验 试点包', vNoLib.code === 0, 'code=' + vNoLib.code);

    /* isInside：同前缀兄弟目录穿透（裸 startsWith 会放行）*/
    const base = path.join(TMP, 'packs-root');
    A('isInside：兄弟目录 <root>-备份 不算在包根内（裸 startsWith 会穿透）',
      G.isInside(base, base + '-备份' + path.sep + 'x.md') === false, '');
    A('isInside：<root>.bak 不算在包根内', G.isInside(base, base + '.bak') === false, '');
    A('isInside：包根内的子路径算在内（正例，防"恒 false"）',
      G.isInside(base, path.join(base, 'a', 'b.md')) === true, '');
    A('isInside：同等路径（含尾分隔符）算在内', G.isInside(base, base + path.sep) === true, '');
    A('isInside：包根之外的同级目录不算在内', G.isInside(base, path.join(TMP, 'other', 'x')) === false, '');
  }

  /* 清场（allocTempDir 也登记了，双保险） */
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

  console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}` +
    (skip ? '  跳过=' + skip : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('[neg-pack-contract] 用例自身抛错：' + (e && e.stack || e));
  process.exit(1);
});