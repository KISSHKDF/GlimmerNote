#!/usr/bin/env node
/**
 * 路径改写判据（规范 §七.1）阴性对照 —— `src\tools\_路径改写.mjs` 的唯一用例。
 *
 * 为什么必须有它：§七.1 是从**两次真实事故**里长出来的判据 ——
 *   · 初版多一条"整串相等也算路径" ⇒ `_索引.json` 的 `grade` 字段（值恰好是旧目录名）被静默改坏；
 *   · 第一版只实现 JSON ⇒ **102 份 `.md` 的指针行变成死链**（独立复核方只看到第二轮那 4 份）。
 * 所以每条判据都要**正例 + 反例**，而且都要有"判据不是恒真/恒假"的自证。
 *
 * 覆盖：
 *   ① 相对路径：正例（前缀替换）/ 反例（`grade: "九年级"` 整串相等**不许动**）+ 键也要改
 *   ② 绝对路径：正例（只换中段）/ 反例（库外路径不被误改）
 *   ③ 非路径标识（--id）：正例（整串相等）/ 反例（只是包含 ⇒ 不换）
 *   W6 格式保真：缩进 1 的 JSON 改写后**仍是缩进 1**
 *   `.md` 载体：指针行的死链被改活；历史叙述里"本来就坏"的路径**不动**
 *   改盘不改叙述：`note` 等字段若命中 ⇒ **拒绝执行**（可疑必须为 0）
 *   冻结证据与派生物：`_备份-真源\` / `_状态.json` / `_复习队列.md` / `_待确认清单.md` **一个字不动**
 *   预演：不写盘（前后逐字节相同）
 *   对账：造一条"改了名但某个载体没跟着改"的库 ⇒ **必须报红**；补齐 ⇒ **恢复绿**（防恒红）
 *
 * 用法：node tests\neg-path-rewrite.cjs
 * 退出码：0=全绿；1=有断言失败
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const ROOT = path.resolve(__dirname, '..');
const TOOL = E.tool('_路径改写.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail !== undefined ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const H = (s) => console.log('\n══ ' + s + ' ══');

const TMP = E.allocTempDir('gn-pathrw-');
const LIB = path.join(TMP, 'lib');

const mk = (rel, text) => { const p = path.join(LIB, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8'); return p; };
const rd = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(LIB, rel))).digest('hex');
const jget = (rel) => JSON.parse(rd(rel).replace(/^\uFEFF/, ''));

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: LIB }),
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  let json = null;
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a >= 0 && b > a) { try { json = JSON.parse(out.slice(a, b + 1)); } catch { } }
  return { code: r.status == null ? -1 : r.status, out, json };
}

/* ══════════ 夹具：一个含三种载体 + 叙述字段 + 冻结证据 + 派生 的合成库 ══════════
   旧目录名 `九年级`，新名 `学生甲`。改名**已经在盘上做过**（`学生甲\` 存在、`九年级\` 不存在），
   载体里仍写着旧名 —— 这正是 §七.1 要处理的现场。 */
const OLD = '九年级', NEW = '学生甲';
function makeLib() {
  fs.rmSync(LIB, { recursive: true, force: true });
  fs.mkdirSync(LIB, { recursive: true });
  /* 改名后的真实文件都在：改写要"改完能解析"，所以目标必须真的在盘上 */
  mk(`${NEW}/数学/原卷/批次1/p01.jpg`, 'P1');
  mk(`${NEW}/数学/M0001-测试/原卷截图.jpg`, 'SHOT');
  mk(`_收件箱/${NEW}-数学/照片.jpg`, 'PHOTO');

  /* ① 相对路径：值与对象键 */
  mk('_原卷台账.json', JSON.stringify({
    cards: {
      '学生甲|M0001': { page: `${OLD}/数学/原卷/批次1/p01.jpg`, by: 'sidecar', note: '当时那一页是 ' + `${OLD}/数学/原卷/批次1/p01.jpg` + ' ，框取的是左半页' },
    },
  }, null, 1) + '\n');
  mk('_页码映射.json', JSON.stringify({ note: '人读', rules: { [`${OLD}/数学/原卷/批次1/p01.jpg`]: 3 } }, null, 2) + '\n');
  /* ① 反例所在的文件：grade 的值恰好是旧目录名 */
  mk(`${NEW}/数学/_索引.json`, JSON.stringify({ grade: OLD, student: NEW, items: [{ id: 'M0001', dir: 'M0001-测试' }] }, null, 1) + '\n');
  /* ② 绝对路径：只换中段；另一条库外绝对路径不许动 */
  mk('_录题/t-20261001-01.json', JSON.stringify({
    taskId: 't-20261001-01',
    image: { sha256: 'x', rel: `D:\\化学\\${OLD}\\数学\\原卷\\批次1\\p01.jpg` },
    outside: 'D:\\化学\\某老师的卷子\\p02.jpg',
  }, null, 2) + '\n');
  /* ③ 非路径标识：batch 整串相等；另一个只是包含 */
  mk('_原图台账.json', JSON.stringify({
    objects: {
      ['A'.repeat(64)]: { bytes: 2, ext: 'jpg', batch: OLD, tag: `${OLD}-副`, sources: [`${OLD}/数学/M0001-测试/原卷截图.jpg`] },
    },
  }, null, 1) + '\n');
  /* `.md` 载体：指针行（死链，改后能解析）+ 历史叙述（本来就坏，不许动） */
  mk(`${NEW}/数学/M0001-测试/错题记录.md`, [
    '# 错题记录',
    '',
    '- 原图整页：' + `${OLD}/数学/原卷/批次1/p01.jpg`,
    '- 原图：D:\\化学\\早就不在的目录\\p09.jpg',
    '- 当时那页在 ' + `${OLD}/数学/原卷/批次9/p09.jpg` + ' 上（该页早已删除，属历史叙述）',
    '',
  ].join('\n'));
  /* 冻结证据 + 派生物：整份跳过 */
  mk(`_备份-真源/2026-10-01/_原卷台账.json`, JSON.stringify({ cards: { x: { page: `${OLD}/数学/原卷/批次1/p01.jpg` } } }, null, 1) + '\n');
  mk('_状态.json', JSON.stringify({ stamp: 'x', page: `${OLD}/数学/原卷/批次1/p01.jpg` }, null, 2) + '\n');
  mk('_复习队列.md', `- 复习：${OLD}/数学/原卷/批次1/p01.jpg\n`);
  mk('_待确认清单.md', `| 卡 | 页 |\n| - | ${OLD}/数学/原卷/批次1/p01.jpg |\n`);
}

const MAP = [`--map`, `${OLD}=${NEW}`];
const MAPID = [`--id`, `${OLD}=${NEW}`, `--id-field`, `batch`];

console.log('临时库：' + LIB + '\n');
makeLib();

/* ══════════ ① 相对路径 ══════════ */
H('① 相对路径（值以旧段名开头**且带分隔符** ⇒ 换前缀）');
{
  const r = run(['预演', ...MAP, ...MAPID, '--json']);
  A('①a 预演 exit 0', r.code === 0, 'exit=' + r.code + ' ｜ ' + r.out.split('\n').slice(-1)[0]);
  const chg = (r.json && r.json.changes) || [];
  const card = chg.find((c) => c.file === '_原卷台账.json');
  A('①b `_原卷台账.json` 的 page 被命中（①相对路径）',
    !!card && card.detail.some((h) => h.rule.includes('①') && String(h.to).startsWith(NEW + '/')),
    JSON.stringify(card && card.detail.slice(0, 2)));
  const pm = chg.find((c) => c.file === '_页码映射.json');
  A('①c **对象键**也要改（`_页码映射.json` 的键就是库内相对路径）',
    !!pm && pm.detail.some((h) => h.where.includes('键') && String(h.to).startsWith(NEW + '/')),
    JSON.stringify(pm && pm.detail));
}

/* ══════════ ① 反例（上一版真栽的地方） ══════════ */
{
  const r = run(['执行', ...MAP, ...MAPID, '--yes', '--json']);
  A('①d 执行 exit 0', r.code === 0, 'exit=' + r.code + ' ｜ ' + (r.json ? JSON.stringify(r.json.hits) : r.out.slice(-160)));
  const idx = jget(`${NEW}/数学/_索引.json`);
  A('★★ ①反例：`grade` 的值整串等于旧目录名 ⇒ **一个字都不许动**（整串相等不算路径）',
    idx.grade === OLD, 'grade=' + JSON.stringify(idx.grade));
  A('①e 同一份 `_索引.json` 里 `student`/`items` 也没被误改', idx.student === NEW && idx.items[0].dir === 'M0001-测试', JSON.stringify(idx));
  A('①f `_原卷台账.json` 的 page 已换成新前缀', jget('_原卷台账.json').cards['学生甲|M0001'].page.startsWith(NEW + '/'),
    jget('_原卷台账.json').cards['学生甲|M0001'].page);
  A('①g `_页码映射.json` 的键已换成新前缀', Object.keys(jget('_页码映射.json').rules)[0].startsWith(NEW + '/'),
    Object.keys(jget('_页码映射.json').rules)[0]);
}

/* ══════════ ② 绝对路径 ══════════ */
H('② 绝对路径（盘符根 + 含旧段 ⇒ 只换那一段）');
{
  const rec = jget('_录题/t-20261001-01.json');
  A('②a 盘上绝对路径的**中段**被换掉，前后原样', rec.image.rel === `D:\\化学\\${NEW}\\数学\\原卷\\批次1\\p01.jpg`, rec.image.rel);
  A('★★ ②反例：库外绝对路径（含 `化学` 但不含旧段）**不许动**', rec.outside === 'D:\\化学\\某老师的卷子\\p02.jpg', rec.outside);
}

/* ══════════ ③ 非路径标识 ══════════ */
H('③ 非路径标识（`--id`：整串相等才换）');
{
  const obj = jget('_原图台账.json').objects['A'.repeat(64)];
  A('③a `batch` 整串等于旧标识 ⇒ 换成新标识', obj.batch === NEW, String(obj.batch));
  A('★★ ③反例：值里**包含**旧标识但不是整串（`九年级-副`）⇒ 不换', obj.tag === `${OLD}-副`, String(obj.tag));
  A('③b `sources[]` 走 ①（相对路径**前缀**）⇒ 已换新段', String(obj.sources[0]).startsWith(NEW + '/'), String(obj.sources[0]));
}

/* ══════════ `.md` 载体 ══════════ */
H('`.md` 载体（判据严：现在解析不到 + 改名后能解析）');
{
  const md = rd(`${NEW}/数学/M0001-测试/错题记录.md`);
  A('★ md① 指针行的旧路径已改成新路径（否则就是 2026-11-06 那 102 份死链）',
    md.includes(`${NEW}/数学/原卷/批次1/p01.jpg`), md.split('\n')[2]);
  A('★★ md② 历史叙述里"本来就坏"的路径**不动**（改名也救不回来 ⇒ 不是这次改名造成的）',
    md.includes(`${OLD}/数学/原卷/批次9/p09.jpg`), md.split('\n')[4]);
  A('★ md③ 库外绝对路径**不动**', md.includes('D:\\化学\\早就不在的目录\\p09.jpg'), md.split('\n')[3]);
}

/* ══════════ 改盘不改格式（W6） ══════════ */
H('W6 改盘别改格式（缩进沿用盘上原样）');
{
  const raw1 = rd('_原卷台账.json');
  const indentOf = (x) => { const m = /\n([ \t]+)"/.exec(x); return m ? m[1] : ''; };
  A('★ W6a 缩进 1 的 JSON 改写后**仍是缩进 1**（不传 indent ⇒ `_安全写.mjs` 沿用盘上格式）',
    indentOf(raw1) === ' ' && indentOf(rd('_页码映射.json')) === '  ', '缩进：_原卷台账.json=' + JSON.stringify(indentOf(raw1)) + ' / _页码映射.json=' + JSON.stringify(indentOf(rd('_页码映射.json'))));
  mk(`${NEW}/数学/M0002-测试/原卷截图.jpg`, 'SHOT2');
  mk('_缩进0.json', JSON.stringify({ p: `${NEW}/数学/原卷/批次1/p01.jpg` }) + '\n');   // 紧凑单行（缩进 0）
  const r = run(['执行', '--map', `${NEW}/数学/原卷/批次1/p01.jpg=${NEW}/数学/原卷/批次1/p01b.jpg`, '--yes']);
  A('★ W6b 紧凑单行（缩进 0）的文件改写后仍是单行', !rd('_缩进0.json').includes('\n  '), JSON.stringify(rd('_缩进0.json').slice(0, 60)));
  A('W6c 且收尾换行保留（上面那次执行 exit 0）', r.code === 0 && rd('_缩进0.json').endsWith('\n'), 'exit=' + r.code);
}

/* ══════════ 冻结证据 / 派生物 / 预演不写盘 ══════════ */
H('冻结证据与派生物不许动 + 预演不写盘');
{
  A('★ 冻结证据 `_备份-真源\` 一个字不动', rd(`_备份-真源/2026-10-01/_原卷台账.json`).includes(OLD), '');
  A('★ 派生物 `_状态.json` / `_复习队列.md` / `_待确认清单.md` 都不动',
    rd('_状态.json').includes(OLD) && rd('_复习队列.md').includes(OLD) && rd('_待确认清单.md').includes(OLD), '');
  const before = sha('_原卷台账.json');
  const r = run(['预演', '--map', `${NEW}/数学/原卷/批次1=${NEW}/数学/原卷/批次2`]);
  A('★ 预演 exit 0 且**不写盘**（前后逐字节相同）', r.code === 0 && sha('_原卷台账.json') === before, 'exit=' + r.code);
}

/* ══════════ 叙述字段命中 ⇒ 拒绝执行 ══════════ */
H('叙述/溯源字段命中 ⇒ 拒绝写盘（可疑必须为 0）');
{
  /* note 的值故意写成"以旧段名开头"（现实中不该发生；一旦发生必须当场拒绝，而不是静默改历史） */
  mk('_待确认.json', JSON.stringify({ items: [{ key: 'x', page: `${OLD}/数学/原卷/批次1/p01.jpg`, note: `${OLD}/数学/原卷/批次1/p01.jpg` }] }, null, 1) + '\n');
  const before = sha('_待确认.json');
  const r = run(['执行', ...MAP, '--yes']);
  A('★★ 有可疑命中 ⇒ exit 1 且**没有写盘**（若是 0 就是"静默改历史"）',
    r.code === 1 && sha('_待确认.json') === before && /可疑|叙述/.test(r.out),
    'exit=' + r.code + ' ｜ ' + (r.json ? JSON.stringify(r.json.suspicious).slice(0, 120) : r.out.slice(-160)));
  fs.writeFileSync(path.join(LIB, '_待确认.json'), JSON.stringify({ items: [] }, null, 1) + '\n', 'utf8');
}

/* ══════════ 对账：死链对拍（红 → 补齐 → 绿） ══════════ */
H('对账（死链对拍）：改名后某个载体没跟着改 ⇒ 必须红；补齐 ⇒ 恢复绿');
{
  /* 造一份"忘了改"的载体：盘上已是新名，它仍写旧名（这正是本次改名造成的死链） */
  mk('_盲解双路.json', JSON.stringify({ cards: { x: { page: `${OLD}/数学/原卷/批次1/p01.jpg` } } }, null, 1) + '\n');
  const red = run(['对账', ...MAP, '--json']);
  A('★★ 对账：有一份载体没跟着改 ⇒ **报红**（exit 1）且点名该文件',
    red.code === 1 && !!red.json && red.json.deadLinks >= 1 && red.json.dead.some((d) => d.where.includes('_盲解双路.json')),
    'exit=' + red.code + ' ｜ dead=' + (red.json ? red.json.deadLinks : '?') + ' ｜ ' + (red.json && red.json.dead[0] ? red.json.dead[0].where : ''));
  const fix = run(['执行', ...MAP, '--yes', '--json']);
  A('对账·补齐：把漏掉的载体改过来 ⇒ exit 0', fix.code === 0, 'exit=' + fix.code);
  const green = run(['对账', ...MAP, '--json']);
  A('★ 对账恢复绿（判据不是恒红）', green.code === 0 && !!green.json && green.json.deadLinks === 0, 'exit=' + green.code);
}

/* ══════════ 用法与边界 ══════════ */
H('用法与边界');
{
  A('执行缺 `--yes` ⇒ exit 2（不会偷偷写盘）', run(['执行', ...MAP]).code === 2, '');
  A('未知动作 ⇒ exit 2', run(['改一改', ...MAP]).code === 2, '');
  A('没有 --map/--id ⇒ exit 2', run(['预演']).code === 2, '');
  A('--map 形态不对 ⇒ exit 2', run(['预演', '--map', '没有等号']).code === 2, '');
  A('拼错的开关被严格模式拦下（不是静默吞掉）', run(['预演', ...MAP, '--dryy']).code === 2, '');
  A('★ 给 --id 却不给 --id-field ⇒ exit 2（不许按值乱改同一个名字的非路径字段）', run(['预演', '--id', `${OLD}=${NEW}`]).code === 2, '');
}

console.log(`\nRESULT=${fail ? 'FAIL(' + fail + ')' : 'PASS'}  断言=${pass + fail}  通过=${pass}  失败=${fail}`);
process.exit(fail ? 1 : 0);
