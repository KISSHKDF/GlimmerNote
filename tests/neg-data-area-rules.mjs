#!/usr/bin/env node
/**
 * 数据区门禁 · 阴性对照（2026-11-06 建）——「这些判据真会红」的永久护栏。
 *
 * 判决依据：`docs\数据区规范.md` §六「门禁（G 系列）」。规范原文的纪律：
 *   「只测正例的检查是恒真的，等于没测」—— 所以本用例在**临时合成库**上逐条制造违规，
 *   断言每条判据都被判红、且违规条目在输出里被**点名**（规则号 + 路径 + 根因）；另加一组
 *   **合法库断言全绿**（防假阳：判据过宽会把好库也判红，那等于门禁没有牙齿）。
 *
 * 用例形态（每条判据都在**全新的一份合法库**上只改一处）：
 *   · 起点永远是 `buildLegal()`（全绿基线，已先自证 exit 0）⇒ 报出来的任何违规都只可能来自那一处改动；
 *   · 断言两层：① 退出码 = 2；② 该规则号的违规里有一条路径/根因对得上（"点名"）。
 *
 * 为什么不拿真库当判据（AGENTS.md 红线 5：测试不依赖真实用户数据）：
 *   真库当前**本来就该红**（未搬迁），拿它做断言的基线的测试会随搬迁变绿/变红而漂移。
 *   本用例只用 `os.tmpdir()` 下的合成库；夹具经 `tests\_测试环境.cjs` 的 `allocTempDir()` 登记，
 *   `process.on('exit')` 统一切除（前缀 `gn-testlib-` 在启动清扫表里 ⇒ 被 SIGKILL 也有兜底）。
 *
 * 用法：
 *   node tests\neg-data-area-rules.mjs                 # 阴性对照（退出码 0=全绿）
 *   node tests\neg-data-area-rules.mjs --emit-lib <dir> # 只在 <dir> 造一份**合法合成库**（不删），
 *                                                       # 供人工跑 `_数据区门禁.mjs --data <dir>` 看全绿
 * 输出：`RESULT=PASS 断言=N`（与仓内 tests 风格一致）；失败非零退出。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const E = require('./_测试环境.cjs');          // 临时夹具登记/清扫的唯一实现
const SELF = fileURLToPath(import.meta.url);   // 自证要把"本用例自己"当子进程再跑一遍
const REPO = path.resolve(import.meta.dirname, '..');
/* 自证缝：默认用仓库里的真件；只有本用例的内部子进程才会把门禁指向一份"判据被改坏"的副本
   （规范 §六 明写要求"临时把某条判据改成永假，阴性对照必须失败"）。 */
const GATE = process.env.CTB_DATA_GATE || path.join(REPO, 'src', 'tools', '_数据区门禁.mjs');

let fails = 0, asserts = 0;
const A = (n, ok, d) => {
  asserts++;
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + String(d).slice(0, 260) : ''}`);
  if (!ok) fails++;
};

/* ══════════════════════════════════════════════════════════════════════════
 * 合成库（合法基线）
 * ══════════════════════════════════════════════════════════════════════════ */
/* 登记表是**规范 §3.1/3.2/3.3 的转写**；转写错一处，这里的合法库就会自己判红（自证） */
const REGISTERED_DIRS = ['组卷', '_原图', '_备份-真源', '_收件箱', '_录题', '_盲解', '_撤卡留档', '_笔形', '_工具'];   // _影像备份 已按 P10 删除 ⇒ 不在白名单（出现即红）
const REGISTERED_FILES = [
  '_组卷台账.json', '_配图台账.json', '_原卷台账.json', '_原图台账.json', '_盲解双路.json',
  '_笔形台账.json', '_页码映射.json', '_待确认.json', '_待办欠账-派发.json',
  '_状态.json', '_复习队列.md', '_待确认清单.md', '_词表.md', '首页.html', '先看这里.txt', '_整改台账.md',
];
const CARD_FILES = ['题干.html', '错题记录.md', '原卷截图.jpg', '_裁图记录.json'];
/* N5 描述上限（与规范 §二 N5 表同一口径：40 是防退化上限，不是审美） */
const DESC_MAX = 40;

function wf(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
function wj(file, obj) { wf(file, JSON.stringify(obj, null, 2) + '\n'); }
function mkCard(subjectDir, name) {
  const d = path.join(subjectDir, name);
  fs.mkdirSync(d, { recursive: true });
  for (const f of CARD_FILES) wf(path.join(d, f), f.endsWith('.json') ? '{}\n' : '（合成库占位，不含任何真实学生信息）\n');
}
function mkStudent(root, name, subjects) {
  const sDir = path.join(root, name);
  fs.mkdirSync(sDir, { recursive: true });
  const sub = {};
  for (const [k, cards] of Object.entries(subjects)) {
    sub[k] = { items: cards.map((c) => ({ id: c.slice(0, 5), dir: c })) };
    fs.mkdirSync(path.join(sDir, k), { recursive: true });
    for (const c of cards) mkCard(path.join(sDir, k), c);
  }
  wj(path.join(sDir, '_索引.json'), { student: name, grade: '七年级', subjects: sub, note: '', updatedAt: '' });
  return sDir;
}
/** 合法合成库：两个学生（一个有卡、一个空册）+ 库根全部登记条目 + N9 例外
 *  + §3.4 ② 的三处**穷举豁免** + §3.4 ③ / N10 / N11 / N12 的合法落点（这些位置一个都不许判红）。 */
function buildLegal(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const d of REGISTERED_DIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of REGISTERED_FILES) wf(path.join(root, f), /\.(json)$/.test(f) ? '{}\n' : (f === '首页.html' ? '<!doctype html>\n' : '# 合成库占位\n'));
  wf(path.join(root, '.gitignore'), '_原图/\n');   // ★ P10：_影像备份\ 已删除，不再进 .gitignore
  /* §3.2 新登记的影像真源：`_笔形\` 里就是样本文件（`_笔形台账.json` 的 items[*].sample 指向它） */
  wf(path.join(root, '_笔形', '小甲.md'), '# 笔迹样本（合成占位）\n');
  /* §3.4 ② 的三处豁免：里面的 `.bak` 是**规则允许**的历史留存，不许判红 */
  wf(path.join(root, '_备份-真源', '_组卷台账-20261106-010101001.json'), '{}\n');
  wf(path.join(root, '_备份-真源', '随便什么.bak'), 'x\n');
  wf(path.join(root, '_原图', '_快照', '20261031-213815.list'), 'deadbeef.jpg\n');
  wf(path.join(root, '_原图', 'ab', 'ab' + 'c'.repeat(62) + '.jpg'), 'x\n');
  mkStudent(root, '小甲', { 数学: ['M0001-煮面条最少时间未作答'], 语文: [] });
  mkStudent(root, '小乙', {});
  /* N10 两种合法原卷落点 + §3.4 ③ 的合法中间产物位置 */
  wf(path.join(root, '小甲', '原卷', '2026-11-06-合卷', 'p1.jpg'), 'x\n');
  wf(path.join(root, '小甲', '数学', '原卷', '2026-11-06-数学', 'p1.jpg'), 'x\n');
  fs.mkdirSync(path.join(root, '小甲', '数学', 'M0001-煮面条最少时间未作答', 'tiles'), { recursive: true });
  wf(path.join(root, '小甲', '数学', 'M0001-煮面条最少时间未作答', 'tiles', '0-0.png'), 'x\n');
  fs.mkdirSync(path.join(root, '小甲', '原卷', '2026-11-06-合卷', '_crops'), { recursive: true });
  /* N11 闭集：③ 待办证据（两种）· ④ *.md 报告件 · ⑤ `_` 开头；N12 的 `_备份-真源\`（任何层级） */
  wf(path.join(root, '小甲', '数学', '待办证据', 'ev-01.png'), 'x\n');
  wf(path.join(root, '小甲', '语文', '_待确认证据-20261015', 'ev-02.png'), 'x\n');
  wf(path.join(root, '小甲', '数学', '2026-10-07-第三单元-批改报告.md'), '# 报告\n');
  wf(path.join(root, '小甲', '_备份-真源', '_索引-20261106-010101001.json'), '{}\n');
  wf(path.join(root, '小甲', '_备份-真源', '_索引.json.bak-20261106'), '{}\n');
  wf(path.join(root, '小甲', '数学', '_备份-真源', '_索引.json.bak-20261106'), '{}\n');
  /* N5 上限的**边界正例**：正好 40 字符的描述必须绿（41 才红） */
  mkCard(path.join(root, '小甲', '数学'), 'M0002-' + '长'.repeat(DESC_MAX));
  /* N13 共用区（G11）的合法样例：全合规 ⇒ ① 段的"全绿"顺带把 G11 的 C 段也盖住了 */
  wf(path.join(root, '_收件箱', '2026-11-05-小甲-数学', 'p1.jpg'), 'x\n');
  wf(path.join(root, '_收件箱', '2026-11-05-小乙-语文-练习', 'p2.jpg'), 'x\n');
  wf(path.join(root, '_盲解', '小甲-数学-盲解清稿.md'), '# 清稿\n');
  wf(path.join(root, '_盲解', '小甲-数学-盲解清稿-第2路.md'), '# 清稿\n');
  wf(path.join(root, '_录题', 't-20261105-120000-abcdef.json'), '{}\n');
  fs.mkdirSync(path.join(root, '_撤卡留档', '2026-10-08'), { recursive: true });
  fs.mkdirSync(path.join(root, '_撤卡留档', 'C0007-变化类型两格-2026-10-16-学生全对误建'), { recursive: true });
  wf(path.join(root, '组卷', '2026-10-25-小甲-答案册-1637.pdf'), 'x\n');
  wf(path.join(root, '_笔形', 'README.md'), '# 说明\n');                       // 放行且不进分母
  wf(path.join(root, '_笔形', '小甲', 'A', '2026-10-09-0009.jpg'), 'x\n');      // 标签自由命名不判
  return root;
}
/** 全新一份合法库（临时目录，登记进退出清扫表） */
function freshLib() { return buildLegal(E.allocTempDir('gn-testlib-')); }

/* ══════════════════════════════════════════════════════════════════════════
 * 跑门禁
 * ══════════════════════════════════════════════════════════════════════════ */
function runGate(args, env) {
  try {
    const out = execFileSync(process.execPath, [GATE, ...args], {
      encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024,
      /* ⚠ stdio 必须显式给全：不给时 Node 把子进程 stderr **直接透到本进程 stderr**，
         于是"入参错"这类用例的 stderr 会漏进本用例的输出（读起来像自己红了）。 */
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, env || {}),
    });
    return { code: 0, out: String(out), err: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
function gateLib(lib, extra = [], env) { return runGate(['--data', lib, ...extra], env); }
function gateJson(lib, extra = [], env) {
  const r = gateLib(lib, [...extra, '--json'], env);
  let json = null;
  try { json = JSON.parse(r.out.trim()); } catch { }
  return { ...r, json };
}
const V = (j, rule) => (j && Array.isArray(j.violations) ? j.violations.filter((v) => v.rule === rule) : []);
const hit = (j, rule, needle) => V(j, rule).some((v) => String(v.path).includes(needle) || String(v.why).includes(needle));

/* 每条判据的阴性用例：全新合法库 + 只改一处 ⇒ 必须 exit 2 且点名该规则 */
const exercised = new Set();
function negCase(rule, title, mutate, needle) {
  exercised.add(rule);
  const lib = freshLib();
  mutate(lib);
  const r = gateJson(lib);
  A('[' + rule + '] ' + title + ' ⇒ 判红（exit 2）', r.code === 2, 'exit=' + r.code + (r.json ? '' : ' 非 JSON：' + r.out.slice(0, 120) + r.err.slice(0, 120)));
  A('[' + rule + '] ' + title + ' ⇒ 违规被点名（规则号 + 路径/根因）',
    hit(r.json, rule, needle),
    V(r.json, rule).map((v) => v.why).join(' ｜ ').slice(0, 240) || '（该规则无违规 —— 判据没红）');
  return r;
}

/* `--emit-lib`：只造库、不判、不删（人工验收用） */
if (process.argv.includes('--emit-lib')) {
  const i = process.argv.indexOf('--emit-lib');
  const dir = process.argv[i + 1];
  if (!dir) { console.error('用法：node tests\\neg-data-area-rules.mjs --emit-lib <目录>'); process.exit(3); }
  buildLegal(path.resolve(dir));
  console.log('已造合法合成库：' + path.resolve(dir) + '（未删除；请人工跑 `_数据区门禁.mjs --data <它>` 看全绿）');
  process.exit(0);
}

/* ══════════════════════════════════════════════════════════════════════════
 * ① 合法库必须全绿（防假阳 —— 阴性对照的另一半）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('── ① 合法合成库：G1..G9 必须全绿（否则判据过宽 = 假阳）──');
const legal = freshLib();
const g0 = gateJson(legal);
A('①a 合法库 exit 0', g0.code === 0, 'exit=' + g0.code + ' 违规=' + (g0.json ? g0.json.violations.length : '?') + (g0.json && g0.json.violations.length ? ' 首条：' + g0.json.violations[0].why : ''));
A('①b 合法库 violations 为空数组', !!g0.json && Array.isArray(g0.json.violations) && g0.json.violations.length === 0, JSON.stringify((g0.json || {}).violations || null).slice(0, 200));
A('①c 合法库不是"空真"（真判了对象：学生 2 / 卡 2 / 索引 2）',
  !!g0.json && g0.json.stats.studentDirs === 2 && g0.json.stats.cardDirs === 2 && g0.json.stats.indexFiles === 2 && g0.json.stats.rootEntries > 0,
  JSON.stringify((g0.json || {}).stats || null));
A('①d 全部判据都有"已判数量"（防空真，含 G11）',
  !!g0.json && ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G11'].every((id) => {
    const r = (g0.json.rules || []).find((x) => x.id === id);
    return r && r.evaluated > 0;
  }),
  JSON.stringify(((g0.json || {}).rules || []).map((r) => r.id + ':' + r.evaluated).join(' ')));
A('①e 人类模式与 --json 同判同码（全绿）', gateLib(legal).code === 0, 'exit=' + gateLib(legal).code);
A('①f 稳定性：同一库连跑两次结论一致（无随机/顺序依赖）',
  JSON.stringify(gateJson(legal).json.violations) === JSON.stringify(g0.json.violations), '两次 violations 逐字相等');

/* 只读自证：门禁跑前跑后，库逐字节不变、不多一个条目（真库零写入是同一条纪律） */
{
  const snap = (dir) => {
    const m = new Map();
    (function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { walk(p, r); continue; }
        const st = fs.statSync(p);
        m.set(r, st.size + '@' + st.mtimeMs);
      }
    })(dir, '');
    return m;
  };
  const before = snap(legal);
  runGate(['--data', legal, '--json']);
  const after = snap(legal);
  const diff = [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => '改:' + k)
    .concat([...before].filter(([k]) => !after.has(k)).map(([k]) => '消失:' + k));
  A('①g 门禁是只读的：跑完库逐字节不变、不多不少任何条目', diff.length === 0, diff.join('、') || '快照相等（' + before.size + ' 个文件）');
}

/* ══════════════════════════════════════════════════════════════════════════
 * ①.5 合法形态（防假阳的另一半：规范写明的合法落点**一个都不许判红**）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── ①.5 规范写明的合法落点：必须全绿（判据过宽 = 假阳）──');
function greenCase(title, mutate) {
  const lib = freshLib();
  mutate(lib);
  const r = gateJson(lib);
  const bad = r.json ? r.json.violations : null;
  A('【防假阳】' + title + ' ⇒ 全绿', r.code === 0 && !!bad && bad.length === 0,
    'exit=' + r.code + (bad && bad.length ? ' 首条：' + bad[0].rule + ' ' + bad[0].why : ''));
}
greenCase('N10 形态 A：`<小名>\\原卷\\<批次>\\`', (lib) => {
  wf(path.join(lib, '小甲', '原卷', '2026-11-06-合卷', 'p2.jpg'), 'x\n');
});
greenCase('N10 形态 B：`<小名>\\<学科>\\原卷\\<批次>\\`', (lib) => {
  wf(path.join(lib, '小甲', '数学', '原卷', '2026-11-06-数学', 'p2.jpg'), 'x\n');
});
greenCase('`tiles\\` 在卡目录内部', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '数学', 'M0001-煮面条最少时间未作答', 'tiles', '5'), { recursive: true });
});
greenCase('`_crops\\` 在原卷目录内部', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '数学', '原卷', '2026-11-06-数学', '_crops'));
});
greenCase('`*.bak` 在 `_备份-真源\\` 内部（§3.4 豁免①）', (lib) => {
  wf(path.join(lib, '_备份-真源', '_待确认-20261106-040650912.json.bak'), '{}\n');
});
/* ── P10：`_影像备份\` 已删除，**不许回来**（2026-11-06 由"豁免②"翻成阴性）──
   它不在 §3.2 白名单里 ⇒ 重新出现就是"库根顶层未登记条目"（G6），且它内部**不再有豁免**
   ⇒ 里面任何 `.bak`/`_tmp` 之类残渣同时吃 G7。两条一起钉住（判据不许变成恒真）。 */
{
  const lib = freshLib();
  fs.mkdirSync(path.join(lib, '_影像备份'));
  const r = gateJson(lib);
  A('【P10·镜像不许回来】库根重新出现 `_影像备份\\` ⇒ G6 判红（未登记条目）',
    r.code === 2 && V(r.json, 'G6').some((v) => String(v.path).includes('_影像备份')),
    'exit=' + r.code + ' ｜ ' + V(r.json, 'G6').map((v) => v.why).join(' ｜ ').slice(0, 140));
}
{
  const lib = freshLib();
  wf(path.join(lib, '_影像备份', '原件', '小甲', '数学', 'M0001', '题干.html.bak'), 'x\n');
  const r = gateJson(lib);
  A('【P10·镜像不许回来】它**内部不再豁免** ⇒ 里面的 `*.bak` 同时吃 G7（不只是 G6）',
    r.code === 2 && V(r.json, 'G7').some((v) => String(v.path).includes('_影像备份')),
    'exit=' + r.code + ' ｜ G7：' + V(r.json, 'G7').map((v) => v.why).join(' ｜ ').slice(0, 140));
}
greenCase('`*.bak` 与快照清单在 `_原图\\_快照\\` 内部（§3.4 豁免③）', (lib) => {
  wf(path.join(lib, '_原图', '_快照', '20261106-120000.list.bak'), 'x\n');
  wf(path.join(lib, '_原图', '_快照', '20261106-120000.list'), 'x\n');
});
greenCase('§3.2 新登记的 `_笔形\\` + `_笔形台账.json`', (lib) => {
  wf(path.join(lib, '_笔形', '小乙.md'), '# 笔迹样本\n');
  /* N13 形态是 `<小名>\\<标签>\\<YYYY-MM-DD>-<4位序号>.<ext>`：样本必须住在**标签目录**里、且名带日期与序号 */
  wf(path.join(lib, '_笔形', '小甲', 'A', '2026-11-06-0001.jpg'), 'x\n');
});
greenCase('§3.3 新登记的 `首页.html`（派生看板）', (lib) => {
  wf(path.join(lib, '首页.html'), '<!doctype html><p>x</p>\n');
});
greenCase('N11③ `待办证据\\` 在学科目录里', (lib) => {
  wf(path.join(lib, '小甲', '数学', '待办证据', 'ev-03.png'), 'x\n');
});
greenCase('N11③ `_待确认证据-<YYYYMMDD>\\` 在学科目录里', (lib) => {
  wf(path.join(lib, '小甲', '数学', '_待确认证据-20261106', 'ev-04.png'), 'x\n');
});
greenCase('N11④ `*.md` 报告件在学科目录里（不许套卡目录格式）', (lib) => {
  wf(path.join(lib, '小甲', '数学', '2026-10-07-Unit3词组句子默写-批改报告.md'), '# 报告\n');
});
greenCase('N11 末段：`<小名>\\原卷\\<批次>\\` 与任意 `_` 开头条目在学生层合法（与学科层的不对称处只有 `*.md`）', (lib) => {
  wf(path.join(lib, '小甲', '_随手留档.json'), '{}\n');
  fs.mkdirSync(path.join(lib, '小甲', '_某工具暂存'));
  wf(path.join(lib, '小甲', '原卷', '2026-11-06-跨学科', 'p9.jpg'), 'x\n');
});
greenCase('N11⑤ `_` 开头的程序件在学科目录里', (lib) => {
  wf(path.join(lib, '小甲', '数学', '_裁图记录.json'), '{}\n');
  fs.mkdirSync(path.join(lib, '小甲', '数学', '_某工具暂存'));
});
greenCase('N12 `_备份-真源\\` 下沉到 `<小名>\\`（backupJson 写在被备份件旁边，合法）', (lib) => {
  wf(path.join(lib, '小甲', '_备份-真源', '_索引-20261106-999999999.json'), '{}\n');
});
greenCase('N12 `_备份-真源\\` 下沉到 `<小名>\\<学科>\\`，且其内的 `.bak` 属豁免', (lib) => {
  wf(path.join(lib, '小甲', '数学', '_备份-真源', '_索引.json.bak-20261106-235959'), '{}\n');
});
greenCase('N5 描述正好 40 字符（上限边界正例）', (lib) => {
  mkCard(path.join(lib, '小甲', '数学'), 'M0003-' + '边'.repeat(DESC_MAX));
});
greenCase('N9 例外：`.git\\` 与 `.gitignore`', (lib) => {
  wf(path.join(lib, '.git', 'config'), '[core]\n');
  wf(path.join(lib, '.git', 'objects', 'ab', 'cdef'), 'x\n');
});
greenCase('§3.3 新登记的 `_整改台账.md`（人读的整改欠账登记：只登记、不执行、门禁不读它内容）', (lib) => {
  wf(path.join(lib, '_整改台账.md'), '# 整改台账\n\n## 待裁量\n- （人读，内容自由）\n');
});
/* ★ 2026-11-14（方案批次 2-3）：`_原卷待定位-按批次.md` 同口径登记（人读的原卷定位清账工作单，
   由 `_原卷台账.mjs 工单` 重算派生）。正向：在册 ⇒ 全绿；反向：近名未登记 ⇒ G6 判红。 */
greenCase('§3.3 新登记的 `_原卷待定位-按批次.md`（人读清账工作单：工单重算派生，门禁不读内容）', (lib) => {
  wf(path.join(lib, '_原卷待定位-按批次.md'), '# 原卷待定位 · 按批次\n\n（`_原卷台账.mjs 工单` 重算派生）\n');
});
{
  const lib = freshLib();
  wf(path.join(lib, '_原卷待定位-按批次.txt'), '# 近名但不是登记的那个\n');
  const r = gateJson(lib);
  A('【防前缀/包含匹配】`_原卷待定位-按批次.md` 换成未登记的近名 `.txt` ⇒ G6 判红',
    r.code === 2 && V(r.json, 'G6').some((v) => String(v.path).includes('_原卷待定位-按批次.txt')),
    'exit=' + r.code + ' ｜ ' + V(r.json, 'G6').map((v) => path.basename(v.path)).join(' '));
}
/* 白名单的语义必须是「**允许存在**」而不是「必须存在」：任何登记文件缺席都不算违规。
   这条专门钉住"删掉一个登记文件会不会被判红"——否则白名单会被误实现成"必答清单"。 */
{
  const lib = freshLib();
  fs.rmSync(path.join(lib, '_整改台账.md'));
  const r = gateJson(lib);
  A('【白名单=允许存在·不是必须存在】合规库**删掉** `_整改台账.md` ⇒ 仍全绿（它不是必答项）',
    r.code === 0 && r.json.violations.length === 0,
    'exit=' + r.code + (r.json.violations.length ? ' 首条：' + r.json.violations[0].why : ''));
}
/* 反向：换成**未登记**的近名 ⇒ G6 必须判红（防止白名单被写成前缀/包含匹配） */
{
  const lib = freshLib();
  fs.rmSync(path.join(lib, '_整改台账.md'));
  wf(path.join(lib, '_整改台账.txt'), '# 近名但不是登记的那个\n');
  const r = gateJson(lib);
  A('【防前缀/包含匹配】`_整改台账.md` 换成未登记的近名 `_整改台账.txt` ⇒ G6 判红',
    r.code === 2 && V(r.json, 'G6').some((v) => String(v.path).includes('_整改台账.txt')),
    'exit=' + r.code + ' ｜ ' + V(r.json, 'G6').map((v) => path.basename(v.path)).join(' '));
}

/* ══════════════════════════════════════════════════════════════════════════
 * ② 逐条判据的阴性用例（G1..G9）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── ② 阴性用例：每条判据至少一个"该红"的合成库 ──');

/* G1 · N1：学生目录名 ≠ student 字段 */
negCase('G1', '学生目录名「小甲乙」≠ student 字段「小甲」', (lib) => {
  fs.renameSync(path.join(lib, '小甲'), path.join(lib, '小甲乙'));
}, '小甲乙');
negCase('G1', '学生目录缺 _索引.json（F1 的"恰好一份"缺一份也要红）', (lib) => {
  fs.rmSync(path.join(lib, '小甲', '_索引.json'));
}, '_索引.json');

/* G2 · N2：名集（**按规范 §二 N2 的表格逐类**：年级/学段词 / 学科词 / 时间词 / 日期形态 / 空白 / 分隔符 / 超长） */
const G2_CASES = [
  ['年级词·`*年级`', '七年级'],
  ['年级词·缩写（八下）', '八下'],
  ['学段词·`初中`', '初中'],
  ['学段词·`高一`（高+数字）', '高一'],
  ['学科词（数学）', '小甲数学'],
  ['时间词·`第*单元`', '第3单元'],
  ['时间词·`*月份`', '3月份'],
  ['时间词·`*月*日`', '10月6日'],
  ['时间词·`国庆`', '国庆作业'],
  ['时间词·`月考`', '月考二'],
  ['时间词·`开学`', '开学摸底'],
  ['时间词·`上学期`', '上学期'],
  ['时间词·`春季`', '春季'],
  ['时间词·`\\d{4}年`', '2026年'],
  ['日期形态（2026-10-06）', '2026-10-06'],
  ['空白（半角空格）', '小 甲'],
  ['分隔符（- _ .）', '小甲_乙'],
  /* 超长用例要**只**触发长度那一条：初版用了「一二三…十一」，其中 `十一` 恰好是新表里的时间词，
     证据行会同时报两条（判据对、但用例不再隔离）。换成不含任何表内词的 21 字串。 */
  ['超长（21 字符 > 20）', '小明'.repeat(10) + '小'],
];
for (const [what, bad] of G2_CASES) {
  negCase('G2', '小名含' + what + '（目录名与 student 字段同为「' + bad + '」）', (lib) => {
    fs.renameSync(path.join(lib, '小甲'), path.join(lib, bad));
    wj(path.join(lib, bad, '_索引.json'), { student: bad, grade: '七年级', subjects: { 数学: { items: [] }, 语文: { items: [] } } });
  }, bad);
}
negCase('G2', '目录名合法但 student 字段含分隔符（判字段这一侧）', (lib) => {
  wj(path.join(lib, '小甲', '_索引.json'), { student: '小甲-乙', grade: '七年级', subjects: { 数学: { items: [] }, 语文: { items: [] } } });
}, '_索引.json');

/* G3 · N3：保留名 / Windows 设备名 */
negCase('G3', 'student 字段是保留名「组卷」', (lib) => {
  wj(path.join(lib, '小甲', '_索引.json'), { student: '组卷', grade: '七年级', subjects: { 数学: { items: [] }, 语文: { items: [] } } });
}, '_索引.json');
negCase('G3', 'student 字段是 Windows 设备名「CON」', (lib) => {
  wj(path.join(lib, '小甲', '_索引.json'), { student: 'CON', grade: '七年级', subjects: { 数学: { items: [] }, 语文: { items: [] } } });
}, '_索引.json');
negCase('G3', '学生目录名是 Windows 设备名「NUL」（真在盘上建出来）', (lib) => {
  fs.mkdirSync(path.join(lib, 'NUL'));
}, 'NUL');
{
  const lib = freshLib();
  fs.mkdirSync(path.join(lib, '_探针学生'));
  const r = gateJson(lib);
  A('[G3] `_` 开头的小名被判保留名（同时按 G6 未登记点名）', hit(r.json, 'G3', '_探针学生') || hit(r.json, 'G6', '_探针学生'),
    V(r.json, 'G3').concat(V(r.json, 'G6')).map((v) => v.why).join(' ｜ ').slice(0, 200));
  exercised.add('G3');
}

/* G4 · N4：学科目录 ↔ subjects 键；闭集 */
negCase('G4', '学科目录「科学」不在闭集内', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '科学'));
}, '科学');
negCase('G4', 'subjects 有键「英语」却没有目录（有册无卡）', (lib) => {
  const p = path.join(lib, '小甲', '_索引.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.subjects['英语'] = { items: [] };
  wj(p, j);
}, '有册无卡');
negCase('G4', '学科目录「物理」不在 subjects 键里（有卡无册）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '物理'));
}, '有卡无册');
negCase('G4', '学生层出现闭集之外的目录（素材批次）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '2026-10-06-素材批次'));
}, '这一层的闭集');
negCase('G4', '学生层出现闭集之外的文件（不是 *.md）', (lib) => {
  wf(path.join(lib, '小甲', '清单.xlsx'), 'x\n');
}, '这一层的闭集');
negCase('G4', '`<小名>\\报告.md`（N11 末段：学生层**不放 `*.md`**，报告件只在学科目录层）', (lib) => {
  wf(path.join(lib, '小甲', '2026-10-07-第三单元-批改报告.md'), '# 报告\n');
}, '这一层的闭集');

/* G5 · N5+N11：卡目录名 / 前缀 / 重号 / 描述（上限 40）；以及 N11 闭集之外 */
negCase('G5', '卡号前缀与学科不符（数学目录里放 Y0002）', (lib) => {
  mkCard(path.join(lib, '小甲', '数学'), 'Y0002-前缀不对');
}, '前缀');
negCase('G5', '有卡号头但没有 `-<描述>`（`M0009`）', (lib) => {
  mkCard(path.join(lib, '小甲', '数学'), 'M0009');
}, '不合');
negCase('G5', '同学生同学科内重号（两个 M0001）', (lib) => {
  mkCard(path.join(lib, '小甲', '数学'), 'M0001-重号卡');
}, '重号');
negCase('G5', '描述 41 字符 > 40（上限边界之外）', (lib) => {
  mkCard(path.join(lib, '小甲', '数学'), 'M0004-' + '长'.repeat(DESC_MAX + 1));
}, '描述');
negCase('G5', '描述以 `.` 结尾（真建出带尾点的目录）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '数学', 'M0005-末尾带点.'));
}, '结尾');
negCase('G5', '描述以空格结尾（真建出带尾空格的目录）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '数学', 'M0006-末尾带空格 '));
}, '结尾');
negCase('G5', '学科目录里出现 N11 之外的条目（随手放的目录）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '数学', '随手放的目录'));
}, 'N11 闭集内');
negCase('G5', '学科目录里出现 N11 之外的文件（不是 *.md）', (lib) => {
  wf(path.join(lib, '小甲', '数学', 'notes.txt'), 'x\n');
}, 'N11 闭集内');

/* G6 · C3.1/3.2/3.3：库根闭集 */
negCase('G6', '库根多出一个未登记文件', (lib) => {
  wf(path.join(lib, '未登记条目.md'), '# x\n');
}, '未登记条目.md');
negCase('G6', '库根多出一个未登记的 `_` 前缀目录', (lib) => {
  fs.mkdirSync(path.join(lib, '_未登记目录'));
}, '_未登记目录');
negCase('G6', '登记名形态不符（`_原图` 被写成文件）', (lib) => {
  fs.rmSync(path.join(lib, '_原图'), { recursive: true, force: true });
  wf(path.join(lib, '_原图'), 'x\n');
}, '_原图');
A('[G6] 登记在册的条目（§3.1/3.2/3.3）与 N9 例外**不**被判违规（否则合法库就红了）',
  g0.json.violations.length === 0, '①a/①b 已证；此处再点名一次判据方向');
{
  /* 口径钉死：§3.1 说无前缀顶层只有「<小名>\」与「组卷\」两类 ⇒ 一个陌生名字的无前缀目录
     按**学生库**判（缺索引 ⇒ G1），而不是 G6「未登记条目」。这条区分决定修法是哪一条。 */
  const lib = freshLib();
  fs.mkdirSync(path.join(lib, '新来的'));
  const r = gateJson(lib);
  A('[G6] 无前缀顶层目录按 §3.1 当**学生库**判（缺索引 ⇒ G1），不当未登记条目',
    r.code === 2 && hit(r.json, 'G1', '新来的') && !hit(r.json, 'G6', '新来的'),
    'G1=' + V(r.json, 'G1').length + ' G6=' + V(r.json, 'G6').length);
}
{
  /* 已知能力边界（与门禁输出里的 boundaries 同一句）：Win32 上 `?` `*` 之类**非法字符**
     建目录当场 EINVAL ⇒「描述含 Windows 非法字符」这一条子判据在本机**造不出**阴性库。
     这里把"造不出"本身变成断言：哪天平台/Node 允许了，这条会先红，逼人回来补用例。 */
  const probe = E.allocTempDir('gn-testlib-');
  const mk = (n) => { try { fs.mkdirSync(path.join(probe, n)); return true; } catch { return false; } };
  const okDot = mk('x.');
  const okSpace = mk('y ');
  const okQ = mk('z?w');
  const okStar = mk('w*w');
  A('【边界】Win32 建不出含 `?` / `*` 的目录 ⇒ G5「描述含 Windows 非法字符」这条子判据无阴性用例（事实成立才允许留白）',
    okDot && okSpace && !okQ && !okStar,
    '建 x.=' + okDot + ' y(尾空格)=' + okSpace + ' z?w=' + okQ + ' w*w=' + okStar + ' ｜ 目录内容 ' + fs.readdirSync(probe).join(' '));
}

/* G7 · C3.4②③：残渣（**库内任何位置**，含程序保留区内部；豁免只有穷举的三处） */
negCase('G7', '库根出现 `_probe\\`（探针）', (lib) => {
  fs.mkdirSync(path.join(lib, '_probe'));
  wf(path.join(lib, '_probe', 'x.txt'), 'x\n');
}, '_probe');
negCase('G7', '库根出现 `*.bak-*` 备份残渣', (lib) => {
  wf(path.join(lib, '_组卷台账.json.bak-1'), '{}\n');
}, '.bak-');
negCase('G7', '库根出现裸 `*.bak`（§3.4 ② 新增的形态）', (lib) => {
  wf(path.join(lib, '_状态.json.bak'), '{}\n');
}, '.bak');
negCase('G7', '库根出现 `*.tmp-*` 临时件', (lib) => {
  wf(path.join(lib, 'x.tmp-123'), 'x\n');
}, '.tmp-');
negCase('G7', '学生目录里出现备份残渣（库内也判）', (lib) => {
  wf(path.join(lib, '小甲', '_索引.json.bak-20261007-1345'), '{}\n');
}, '小甲');
negCase('G7', '卡目录里出现 `.old` 残渣（扫到卡级）', (lib) => {
  wf(path.join(lib, '小甲', '数学', 'M0001-煮面条最少时间未作答', '题干.html.old'), 'x\n');
}, '.old');
negCase('G7', '程序保留区 `_工具\\` 里出现 `*.bak`（§3.4 ② 是"库内任何位置"，只有三处豁免）', (lib) => {
  wf(path.join(lib, '_工具', '裁图.ps1.bak'), 'x\n');
}, '_工具');
negCase('G7', '`_收件箱\\` 里出现 `_tmp*` 临时目录', (lib) => {
  fs.mkdirSync(path.join(lib, '_收件箱', '_tmp-20261106'));
}, '_tmp');
negCase('G7', '`tiles\\` 出现在库根顶层（§3.4 ③）', (lib) => {
  fs.mkdirSync(path.join(lib, 'tiles'));
}, 'tiles');
negCase('G7', '`tiles\\` 出现在学科目录里（不在卡目录/原卷目录内部）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '数学', 'tiles'));
}, 'tiles');
negCase('G7', '`_crops\\` 出现在学生目录里（不在卡目录/原卷目录内部）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '_crops'));
}, '_crops');
/* `_快照\`（§3.4 ② 新增的名字）：唯一合法位置是 `_原图\_快照\`（①.5 已证绿），别处一律红 */
negCase('G7', '`_快照\\` 出现在库根顶层', (lib) => {
  fs.mkdirSync(path.join(lib, '_快照'));
  wf(path.join(lib, '_快照', '20261031-213815.list'), 'x\n');
}, '_快照');
negCase('G7', '`_快照\\` 出现在学生目录里', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '_快照'));
}, '_快照');
negCase('G7', '`_快照\\` 出现在 `_原图\\<桶>\\` 里（只有 `_原图\\_快照\\` 那一处合法）', (lib) => {
  fs.mkdirSync(path.join(lib, '_原图', 'ab', '_快照'));
}, '_快照');
/* N12：`_备份-真源\` 内部豁免 —— 反面用例证明"豁免"不是把 G7 整条关掉 */
negCase('G7', '`_备份-真源\\` **之外**的 `*.bak` 仍判红（豁免是穷举的，不是把 G7 关掉）', (lib) => {
  wf(path.join(lib, '_收件箱', '2026-11-06-小甲-数学-素材', 'p1.jpg.bak'), 'x\n');
}, '_收件箱');
negCase('G7', '`_影像备份\\` **之外**的同名形态仍判红', (lib) => {
  wf(path.join(lib, '_原图', 'ab', 'deadbeef.jpg.bak'), 'x\n');
}, '_原图');

/* G8 · F1：一学生多份索引 */
negCase('G8', '同一学生拆出第二份 `_索引.json`（学科级）', (lib) => {
  wj(path.join(lib, '小甲', '数学', '_索引.json'), { student: '小甲', items: [] });
}, '数学');
negCase('G8', '同一学生拆出第三份 `_索引.json`（学科级）', (lib) => {
  wj(path.join(lib, '小甲', '数学', '_索引.json'), { student: '小甲', items: [] });
  wj(path.join(lib, '小甲', '语文', '_索引.json'), { student: '小甲', items: [] });
}, '3 份');

/* G9 · N6：台账下沉 */
negCase('G9', '库级台账 `_组卷台账.json` 下沉进学生目录', (lib) => {
  wf(path.join(lib, '小甲', '_组卷台账.json'), '{}\n');
}, '_组卷台账.json');
negCase('G9', '库级台账下沉进学科目录', (lib) => {
  wf(path.join(lib, '小甲', '数学', '_原卷台账.json'), '{}\n');
}, '_原卷台账.json');
{
  const lib = freshLib();
  wf(path.join(lib, '小甲', '数学', 'M0001-煮面条最少时间未作答', '_待确认.json'), '{}\n');
  const r = gateJson(lib);
  A('[G9] 台账下沉到卡目录也被判红', r.code === 2 && hit(r.json, 'G9', '_待确认.json'),
    V(r.json, 'G9').map((v) => v.why).join(' ｜ ').slice(0, 200));
  exercised.add('G9');
}

/* ══════════════════════════════════════════════════════════════════════════
 * ②.5 G11 跨学生同构（P9 + N13）—— 必答项是**聚合**（A 段），共用命名按学生分别算（C 段）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── ②.5 G11 跨学生同构：A 段（必答项 · 聚合）+ C 段（N13 共用区命名，逐个区）──');

/* A 段：必答项不成立 ⇒ G11 红（它是 G1/G4/G5/G8 的聚合，不重扫一遍） */
negCase('G11', 'A段·目录名 ≠ `student` 字段（必答项 1）', (lib) => {
  fs.renameSync(path.join(lib, '小甲'), path.join(lib, '小甲乙'));
}, '必答项');
negCase('G11', 'A段·学科目录不在 `subjects` 键里（必答项 3）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '物理'));
}, '必答项');
negCase('G11', 'A段·学科目录里出现 N11 之外的条目（必答项 4）', (lib) => {
  fs.mkdirSync(path.join(lib, '小甲', '数学', '随手放的目录'));
}, '必答项');
negCase('G11', 'A段·一个学生两份 `_索引.json`（必答项 2）', (lib) => {
  wj(path.join(lib, '小甲', '数学', '_索引.json'), { student: '小甲', items: [] });
}, '必答项');

/* C 段：每个共用区各至少一条（N13 那张表逐行） */
negCase('G11', 'C段·`_收件箱\\` 小名与学科之间**缺分隔符**（真实违规形态 `…-小甲物理-…`）', (lib) => {
  fs.mkdirSync(path.join(lib, '_收件箱', '2026-11-01-小甲物理-机械能与内能'));
}, '缺分隔符');
negCase('G11', 'C段·`_收件箱\\` 小名不在册', (lib) => {
  fs.mkdirSync(path.join(lib, '_收件箱', '2026-11-05-查无此人-数学'));
}, '在册');
negCase('G11', 'C段·`_收件箱\\` 日期写成 `YYYYMMDD`', (lib) => {
  fs.mkdirSync(path.join(lib, '_收件箱', '20261105-小甲-数学'));
}, 'YYYY-MM-DD');
negCase('G11', 'C段·`_收件箱\\` 学科段不在闭集内', (lib) => {
  fs.mkdirSync(path.join(lib, '_收件箱', '2026-11-05-小甲-科学'));
}, '学科段');
negCase('G11', 'C段·`_盲解\\` 清稿名不合 `<小名>-<学科>-盲解清稿[-第2路|-重盲解].md`', (lib) => {
  wf(path.join(lib, '_盲解', '小甲-数学-清稿.md'), '# x\n');
}, '盲解清稿');
negCase('G11', 'C段·`_录题\\` 任务号不合 `t-YYYYMMDD-HHmmss-<6位hex>.json`', (lib) => {
  wf(path.join(lib, '_录题', 't-2026-11-05-120000-abcdef.json'), '{}\n');
}, '任务号');
negCase('G11', 'C段·`_撤卡留档\\` 批次式日期写成 `YYYYMMDD`', (lib) => {
  fs.mkdirSync(path.join(lib, '_撤卡留档', '20261008'));
}, 'YYYY-MM-DD');
negCase('G11', 'C段·`_撤卡留档\\` 单卡式日期写成 `YYYYMMDD`', (lib) => {
  fs.mkdirSync(path.join(lib, '_撤卡留档', 'C0007-变化类型两格-20261016-学生全对误建'));
}, 'YYYY-MM-DD');
negCase('G11', 'C段·`组卷\\` 类型段不在 `重做卷|答案册` 里', (lib) => {
  wf(path.join(lib, '组卷', '2026-10-25-小甲-练习卷-1637.pdf'), 'x\n');
}, '重做卷');
negCase('G11', 'C段·`_笔形\\` 样本日期写成 `YYYYMMDD`', (lib) => {
  wf(path.join(lib, '_笔形', '小甲', 'A', '20261009-0009.jpg'), 'x\n');
}, 'YYYY-MM-DD');
negCase('G11', 'C段·`_笔形\\` 样本序号不是 4 位', (lib) => {
  wf(path.join(lib, '_笔形', '小甲', 'A', '2026-10-09-09.jpg'), 'x\n');
}, '4位序号');
negCase('G11', 'C段·`_笔形\\` 顶层出现既不是 `<小名>\\` 也不是 `*.md` 的条目', (lib) => {
  wf(path.join(lib, '_笔形', '随手.txt'), 'x\n');
}, '顶层');
negCase('G11', 'C段·`_笔形\\<小名>\\` 下出现文件（只允许 `<标签>\\` 目录）', (lib) => {
  wf(path.join(lib, '_笔形', '小甲', '散件.jpg'), 'x\n');
}, '标签');

/* ── 防假阳（G11 最容易写错的两条，各钉一条）──────────────────────────────
   ① B 段：**内容差异不判红** —— 两个学生的学科集合/可选顶各不相同，必须全绿；
   ② C 段：合规率**按学生分别**算、各自 100%，且"归属不明"的条目不许被静默跳过。 */
console.log('\n── ②.6 G11 防假阳：内容差异不判红 + 合规率按学生分别算 ──');
{
  const lib = freshLib();
  /* 小甲：四科 + 原卷（跨学科）+ 数学待办证据 + 数学报告件 + 英语原卷；小乙：只有语文一科、什么都不多。 */
  const p = path.join(lib, '小甲', '_索引.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.subjects['物理'] = { items: [] };
  j.subjects['英语'] = { items: [] };
  wj(p, j);
  fs.mkdirSync(path.join(lib, '小甲', '物理'));
  fs.mkdirSync(path.join(lib, '小甲', '英语'));
  wf(path.join(lib, '小甲', '原卷', '2026-11-06-跨学科', 'p1.jpg'), 'x\n');
  wf(path.join(lib, '小甲', '数学', '待办证据', 'ev.png'), 'x\n');
  wf(path.join(lib, '小甲', '数学', '2026-11-06-批改报告.md'), '# r\n');
  const r = gateJson(lib);
  A('【防假阳】G11-B：两个学生的学科集合/可选顶**各不相同**（小甲 4 科+原卷+待办证据+报告件；小乙 1 科）⇒ 全绿',
    r.code === 0 && r.json.violations.length === 0, 'exit=' + r.code + (r.json.violations.length ? ' 首条：' + r.json.violations[0].why : ''));
  A('【防假阳】G11-B：该库里两个学生的"必答项"各自成立（不因对方少了什么而红）',
    r.json.g11.mandatory.length === 2 && r.json.g11.mandatory.every((m) => m.ok), JSON.stringify(r.json.g11.mandatory));
}
{
  /* ① 人多的一方不许掩盖另一方：小甲 10 条合规，小乙 1 条 ⇒ 两边各自 100%（全绿） */
  const lib = freshLib();
  for (let i = 1; i <= 10; i++) fs.mkdirSync(path.join(lib, '_收件箱', '2026-11-0' + (i % 9 + 1) + '-小甲-数学-第' + i + '批'));
  fs.mkdirSync(path.join(lib, '_收件箱', '2026-11-05-小乙-语文'));
  const r = gateJson(lib);
  const rate = (n) => (r.json.g11.perStudent.find((s) => s.student === n) || {}).rate;
  A('【防假阳】G11-C：小甲 10 条合规 + 小乙 1 条 ⇒ 两边**各自** 100%（合规率按学生分别算）',
    r.code === 0 && rate('小甲') === '100%' && rate('小乙') === '100%', 'exit=' + r.code + ' 小甲=' + rate('小甲') + ' 小乙=' + rate('小乙'));
}
{
  /* ② 反向：小乙的那 1 条违规 ⇒ 必须红，而且**小甲仍是 100%**（证明不是用整体率掩盖） */
  const lib = freshLib();
  for (let i = 1; i <= 10; i++) fs.mkdirSync(path.join(lib, '_收件箱', '2026-11-0' + (i % 9 + 1) + '-小甲-数学-第' + i + '批'));
  fs.mkdirSync(path.join(lib, '_收件箱', '2026-11-05-小乙-科学'));      // 学科段不在闭集
  const r = gateJson(lib);
  const rate = (n) => (r.json.g11.perStudent.find((s) => s.student === n) || {}).rate;
  A('【防假阳/抗掩盖】G11-C：人多的小甲全合规、小乙 1 条违规 ⇒ **仍判红**（不许被整体合规率掩盖）',
    r.code === 2 && rate('小甲') === '100%' && rate('小乙') !== '100%',
    'exit=' + r.code + ' 小甲=' + rate('小甲') + ' 小乙=' + rate('小乙'));
  A('【防假阳/抗掩盖】G11-C：违规在 --json 里点名到小乙那个条目（按学生可归因）',
    V(r.json, 'G11').some((v) => String(v.path).includes('小乙')), V(r.json, 'G11').map((v) => v.why).join(' ｜ ').slice(0, 200));
}
{
  /* ③ 归属：粘连名（`…-小甲物理-…`）必须**记在小甲账上**（不是"无归属 ⇒ 丢掉"）；
       真正认不出小名的（`查无此人`）必须判红并单列 —— 两种都不许静默跳过。
       这两条正是"人多的一方掩盖另一方"的两个入口：丢掉违规条目、或把它算进别人的合规分母。 */
  const libA = freshLib();
  fs.mkdirSync(path.join(libA, '_收件箱', '2026-11-01-小甲物理-机械能与内能'));   // 粘连：小名成了"小甲物理"
  const rA = gateJson(libA);
  const rateA = (n) => (rA.json.g11.perStudent.find((s) => s.student === n) || {}).rate;
  A('【防假阳/抗掩盖】G11-C：粘连名（缺分隔符）判红，且**记在小甲账上**（小甲 < 100%，不许当无归属丢掉）',
    rA.code === 2 && rateA('小甲') !== '100%' && rA.json.g11.unattributed.length === 0,
    'exit=' + rA.code + ' 小甲=' + rateA('小甲') + ' unattributed=' + JSON.stringify(rA.json.g11.unattributed));

  const libB = freshLib();
  fs.mkdirSync(path.join(libB, '_收件箱', '2026-11-05-查无此人-数学'));          // 小名根本不在册
  const rB = gateJson(libB);
  const rateB = (n) => (rB.json.g11.perStudent.find((s) => s.student === n) || {}).rate;
  A('【防假阳/抗掩盖】G11-C：小名不在册的条目判红、单列在 `g11.unattributed`（不静默跳过）',
    rB.code === 2 && rB.json.g11.unattributed.length === 1 && String(rB.json.g11.unattributed[0].path).includes('查无此人'),
    'unattributed=' + JSON.stringify(rB.json.g11.unattributed).slice(0, 160));
  A('【防假阳/抗掩盖】G11-C：它**不进**任何学生的分母（两个在册学生仍各自 100%，但整体并不因此变绿）',
    rateB('小甲') === '100%' && rateB('小乙') === '100%' && rB.code === 2, 'exit=' + rB.code + ' 小甲=' + rateB('小甲') + ' 小乙=' + rateB('小乙'));
}
{
  /* ④ `_录题\` 的时间戳任务号是 N13 日期硬规矩的**唯一例外** ⇒ 多条 `YYYYMMDD` 任务号必须全绿 */
  const lib = freshLib();
  for (let i = 0; i < 8; i++) wf(path.join(lib, '_录题', 't-2026110' + (i % 9) + '-1916' + String(i).padStart(2, '0') + '-' + (i.toString(16).padStart(6, '0')) + '.json'), '{}\n');
  const r = gateJson(lib);
  A('【防假阳】G11-C：`_录题\\` 的 `t-YYYYMMDD-…` 时间戳任务号是日期硬规矩的唯一例外 ⇒ 全绿',
    r.code === 0 && r.json.g11.global.bad === 0 && r.json.g11.global.total > 0,
    'exit=' + r.code + ' 库级=' + JSON.stringify(r.json.g11.global));
}

/* 覆盖自证：G1..G9 + G11 **一条都不能少**（少一条 = 判据没被阴性对照守） */
A('②z 阴性用例覆盖 G1..G9 + G11 全部十条判据', ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G11'].every((id) => exercised.has(id)),
  [...exercised].sort().join(' '));

/* ══════════════════════════════════════════════════════════════════════════
 * ③ CLI 契约（入参/环境错 = exit 3；--data 必须压过继承的 CTB_DATA）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── ③ CLI 契约与 `--data` 优先级 ──');
{
  const legalA = freshLib();                       // 全绿
  const libBad = freshLib();
  wf(path.join(libBad, '未登记条目.md'), '# x\n'); // 必红（G6）

  const r = gateJson(legalA, [], { CTB_DATA: libBad });   // 环境指 B，--data 指 A ⇒ 必须判 A
  A('③a `--data` 压过继承的 CTB_DATA（判的是 --data 那个库：全绿）', r.code === 0 && r.json && r.json.root === legalA,
    'exit=' + r.code + ' root=' + (r.json && r.json.root));
  const r2 = gateJson(libBad, [], { CTB_DATA: legalA });  // 反向：环境指全绿库，--data 指坏库
  A('③b 反向同样成立（--data 指坏库 ⇒ exit 2，且违规路径在坏库下）',
    r2.code === 2 && V(r2.json, 'G6').every((v) => String(v.path).startsWith(libBad)),
    'exit=' + r2.code + ' 违规=' + V(r2.json, 'G6').map((v) => v.path).join(' '));
  A('③c 不给 --data 时认 CTB_DATA（环境那条通道仍然有效）',
    gateJson(libBad, [], { CTB_DATA: libBad }).code === 2 && gateJson(legalA, [], { CTB_DATA: legalA }).code === 0, '');

  const noVal = runGate(['--data'], {});
  A('③d `--data` 缺值 ⇒ exit 3（不许静默回落到别的库）', noVal.code === 3, 'exit=' + noVal.code + ' ' + (noVal.out + noVal.err).trim().slice(0, 120));
  const unknown = runGate(['--jsoon'], {});
  A('③e 未知参数 ⇒ exit 3（严格模式；拼错的开关不许被静默吞掉）', unknown.code === 3, 'exit=' + unknown.code + ' ' + (unknown.out + unknown.err).trim().slice(0, 120));
  const missing = runGate(['--data', path.join(os.tmpdir(), 'gn-不存在的库-' + process.pid)], {});
  A('③f `--data` 指向不存在的目录 ⇒ exit 3', missing.code === 3, 'exit=' + missing.code + ' ' + (missing.out + missing.err).trim().slice(0, 120));
  const envBad = runGate([], { CTB_DATA: path.join(os.tmpdir(), 'gn-不存在的库-env-' + process.pid) });
  A('③g CTB_DATA 指向不存在的目录 ⇒ exit 3（读不到库不许当"全绿"）', envBad.code === 3, 'exit=' + envBad.code + ' ' + (envBad.out + envBad.err).trim().slice(0, 120));
  const pos = runGate(['whatever'], { CTB_DATA: legalA });
  A('③h 位置参数 ⇒ exit 3（本工具没有动作名）', pos.code === 3, 'exit=' + pos.code + ' ' + (pos.out + pos.err).trim().slice(0, 120));

  const help = runGate(['--help'], {});
  A('③i `--help` ⇒ exit 0 且列出 G1..G9 + G10 指针',
    help.code === 0 && ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'].every((id) => help.out.includes(id)),
    'exit=' + help.code);
  A('③j `--help` 里 G10 明确指向既有实现（不在本工具重复实现一份）',
    help.out.includes('_原卷台账.mjs'), help.out.split(/\r?\n/).find((l) => l.includes('G10')) || '');
  const human = gateLib(libBad);
  const jsonBad = gateJson(libBad);
  A('③k 人类模式与 --json 同码（exit 2）', human.code === 2 && jsonBad.code === 2, '人类=' + human.code + ' json=' + jsonBad.code);
  A('③l 人类模式点名到**绝对路径**与修法（可照做）',
    human.out.includes(path.resolve(libBad, '未登记条目.md')) && human.out.includes('修法：'), '');
  A('③m --json 信封含 rules / stats / boundaries / notImplementedHere(G10)',
    !!jsonBad.json && Array.isArray(jsonBad.json.rules) && !!jsonBad.json.stats && Array.isArray(jsonBad.json.boundaries)
    && (jsonBad.json.notImplementedHere || []).some((x) => x.id === 'G10'),
    Object.keys(jsonBad.json || {}).join(','));

  /* 把 exit 2 与"合法库 exit 0"放一起再自证一次：判据不是恒红也不是恒绿 */
  A('③n 自证：同一个工具在全绿库上 exit 0、在坏库上 exit 2（既非恒红也非恒绿）',
    gateLib(legalA).code === 0 && gateLib(libBad).code === 2, '0 / 2');
}

/* ══════════════════════════════════════════════════════════════════════════
 * ④ 夹具卫生：退出钩子必须真把临时库删净（不许在真库或仓库里留残渣）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── ④ 夹具卫生 ──');
{
  const probe = freshLib();
  A('④a 合成库都建在 os.tmpdir() 下（不落仓库、不落真库）',
    path.resolve(probe).startsWith(path.resolve(os.tmpdir())), probe);
  A('④b 合成库登记在退出清扫表的前缀里（被 SIGKILL 也能被下一轮认领清掉）',
    E.TMP_PREFIXES.includes('gn-testlib-'), E.TMP_PREFIXES.join(' '));
  E.cleanupTempDirs();
  A('④c 退出钩子真把本轮夹具删净（cleanupTempDirs 后一个不剩）', !fs.existsSync(probe), probe);
}

/* ══════════════════════════════════════════════════════════════════════════
 * ⑤ 禁词自查（与 `tests\repo-hygiene.cjs` 同一判据：禁词 0 命中）
 *   为什么本用例要自查这条：门禁的头注要讲清"它治什么形态"，很容易顺手把真实化名写进去；
 *   而 repo-hygiene 只扫 **tracked** 文件 —— 新文件在 commit 之前那道机检看不见它。
 *   这里提前拦一道（判据同源：词表**拼接构造**，本文件自己也能被这条判据扫）。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── ⑤ 禁词自查（公开仓隐私红线；repo-hygiene 同一口径）──');
{
  const BAN = ['康' + '康', '乐' + '乐', 'CL' + 'AW', 'XZ' + 'Y', 'CLIP' + '_BACK' + 'UP'];
  const userRe = () => new RegExp('[A-Za-z]:\\\\' + 'Users' + '\\\\' + '(?![<\\u2026\\s\\\\*.%])', 'g');
  for (const rel of ['src/tools/_数据区门禁.mjs', 'tests/neg-data-area-rules.mjs']) {
    const t = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const hits = BAN.map((b) => [b, t.split(b).length - 1]).filter((x) => x[1] > 0);
    A('⑤ ' + rel + '：禁词 0 命中（含本机用户目录路径）',
      hits.length === 0 && !userRe().test(t), hits.length ? JSON.stringify(hits) : '0 命中');
  }
  /* 自证：判据有牙齿 —— 造坏串必须被抓到，否则"0 命中"是恒真的 */
  const probe = '前缀' + BAN[0] + '中缀' + BAN[2] + '后缀';
  A('⑤z 自证：禁词判据有牙齿（合成坏串被抓到）', BAN.filter((b) => probe.includes(b)).length === 2, probe);
}

/* ══════════════════════════════════════════════════════════════════════════
 * ⑥ 自证：把一条判据改成永假 ⇒ 整套阴性对照必须失败
 *   规范 §六 明写要求这条。做法不靠"人记得手动改一次"：
 *     · 用 `E.copyToolDeps()` 把门禁**及其相对 import 的传递闭包**复制到临时目录（仓内唯一实现）；
 *     · 在副本里把 G9 判据改成永假；
 *     · 把**本用例自己**当子进程再跑一遍（`CTB_DATA_GATE` 指向副本）⇒ 它必须非零退出，
 *       而且失败点必须正是那几条 G9 用例（否则"红"可能是别的原因导致的假证）。
 * ══════════════════════════════════════════════════════════════════════════ */
if (!process.env.CTB_DATA_GATE) {
  console.log('\n── ⑥ 自证：判据改成永假 ⇒ 阴性对照必须红 ──');
  const tree = E.allocTempDir('gn-testlib-');
  const copied = E.copyToolDeps(['_数据区门禁.mjs'], tree);
  const mutated = path.join(tree, '_数据区门禁.mjs');
  A('⑥a 门禁及其依赖被复制进隔离树（含 `_数据区门禁.mjs`）', copied.includes('_数据区门禁.mjs') && fs.existsSync(mutated), copied.join(' '));
  const src = fs.readFileSync(mutated, 'utf8');
  const patched = src.replace("if (REGISTERED_FILES.includes(e.name)) put('G9'", "if (false && REGISTERED_FILES.includes(e.name)) put('G9'");
  A('⑥b 判据确实被改坏（patch 命中，不是空操作）', patched !== src, '');
  fs.writeFileSync(mutated, patched, 'utf8');
  let child;
  try {
    const out = execFileSync(process.execPath, [SELF], {
      encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA_GATE: mutated }),
    });
    child = { code: 0, out: String(out) };
  } catch (e) {
    child = { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') };
  }
  const failLines = child.out.split(/\r?\n/).filter((l) => l.startsWith('[FAIL]'));
  A('⑥c 判据改永假 ⇒ 阴性对照非零退出（判据是活的，不是恒真）', child.code !== 0, 'child exit=' + child.code + ' ｜ ' + (child.out.match(/RESULT=.*/) || [''])[0]);
  A('⑥d 失败点正是被改坏的那条判据（G9），不是别的原因', failLines.length > 0 && failLines.every((l) => l.includes('[G9]')),
    failLines.length + ' 条 FAIL，首条：' + (failLines[0] || '（无）').slice(0, 160));
}

console.log('\nRESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS') + ' 断言=' + asserts + (fails ? ' 失败=' + fails : ''));
process.exit(fails ? 1 : 0);