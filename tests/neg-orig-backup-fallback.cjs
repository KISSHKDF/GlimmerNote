#!/usr/bin/env node
/**
 * P10「一个字节一个家」的两条机器判据（2026-11-06 建；**本文件是 `neg-orig-backup-fallback.cjs` 的改写**）
 *
 * ══ 为什么改写（别再往回找那个"兜底层"）══
 *   本文件原先测的是 `_原图寻址.mjs` 的**影像备份同路径兜底层**（2026-11-05 为"收件箱被清、
 *   52 张卡的溯源全断"补的第三层）。用户 2026-11-06 定案 **P10「一个字节一个家」**：
 *   原图恰好两个家（活路径 + `_原图\`），其它影像只许一个家 ⇒ `_影像备份\`（按路径镜像）
 *   既是原图的第 3 个家、又是其它影像的备份 ⇒ **冗余，退休**。
 *   那一层随之摘除。**摘除前做过实测**（不是"看着像死代码"就删）：
 *   `_原图台账.json` 里全部 1,192 条引用路径各跑一遍 `explainPath()`，
 *   现状引擎 status 分布 = `direct 918 / store 274`，**`backup` 条目 = 0**；
 *   再把它变异成"永远返回 null"跑同一套 ⇒ **分布逐字相同**。即那一层早已不承担任何一次解析。
 *
 *   所以本文件现在守**替代它的那两条判据**（规范 §3.5「影像的每一个落点」+ 两条判据）：
 *     A. **原图必须有两个家**：活路径（`原卷\`/`_收件箱\`）里每张原图，保全库里必须有同 sha 对象
 *        —— `node src\tools\_原图.mjs 两个家`
 *     B. **非原图影像只能有一个家**：§3.5 第 4–8 行那几类，同一 sha 出现在两个路径即红
 *        —— `node src\tools\_原图.mjs 单份`
 *   两条都带**阴性对照**（判据不许变成恒真）：
 *     · 把某个原图对象从 `_原图\` 删掉 ⇒ A 必须红；
 *     · 故意再造一个副本（同一字节放进第二个路径）⇒ B 必须红。
 *   另加一条**"镜像不会回来"的机械证明**：退休后的 `_影像备份.mjs` 非零退出且**不创建** `_影像备份\`。
 *
 * 用法：node tests\neg-orig-backup-fallback.cjs
 * 退出码：0=全绿；1=有断言失败
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pngGray } = require('../scripts/png-cjs.cjs');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'tools', '_原图寻址.mjs');

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-p10homes-'));
const LIB = path.join(TMP, 'lib');
const TOOL = (n) => path.join(ROOT, 'src', 'tools', n);

/** 跑一个仓内工具（数据根靠 CTB_DATA 传给子进程），返回 {code,out} */
function run(tool, args, lib) {
  const r = spawnSync(process.execPath, [TOOL(tool), ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { CTB_DATA: lib || LIB }),
  });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
/** 从合并输出里取 JSON（`--json` 走 stdout、判红说明走 stderr；直接 JSON.parse 整串会炸） */
function jsonOf(out) {
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(out.slice(a, b + 1)); } catch { return null; }
}
const wf = (rel, buf) => { const p = path.join(LIB, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };

/* ── 夹具：一个学生 + 一张卡 + 原图两个家（活路径 + `_原图\`）+ 一份"非原图影像" ── */
const PAGE = '学生A/数学/原卷/批次1/p01.jpg';                 // §3.5 第 1 行：原图工作家
const INBOX = '_收件箱/2026-11-06-学生A-数学/p02.jpg';         // §3.5 第 2 行：导入原件（工作家）
const SHOT = '学生A/数学/M0001-测试/原卷截图.jpg';              // §3.5 第 4 行：卡片裁图
const PAGE_BYTES = pngGray(240, 180, (x, y) => (x * 3 + y * 7) % 251);
const SHOT_BYTES = pngGray(120, 90, (x, y) => (x * 11 + y) % 241);

function makeLib() {
  fs.mkdirSync(LIB, { recursive: true });
  wf('学生A/数学/_索引.json', Buffer.from(JSON.stringify({
    student: '学生A', grade: '七年级', subjects: { 数学: { items: [{ id: 'M0001', dir: 'M0001-测试' }] } }, note: '', updatedAt: '',
  }, null, 1), 'utf8'));
  wf('学生A/数学/M0001-测试/题干.html', Buffer.from('<div class="stem"><p>夹具</p></div>', 'utf8'));
  wf(SHOT, SHOT_BYTES);
  wf(PAGE, PAGE_BYTES);
  wf(INBOX, PAGE_BYTES);          // 与 PAGE 同字节：它是"同一张原图的两个工作家位置"，不参与 B 的判据（收件箱不在 4–8 行）
  /* 把 PAGE 收进保全库（真工具，不是本用例自己拷）⇒ 原图两个家里的"保全家"就位 */
  const r = run('_原图.mjs', ['入库', PAGE]);
  if (r.code !== 0) throw new Error('夹具：入库失败 ' + r.out.slice(0, 300));
}

function main() {
  console.log('临时库：' + LIB + '\n');
  makeLib();

  console.log('\n══ ① P10-A「原图必须有两个家」：活路径 + 保全库同 sha ⇒ 绿 ══');
  {
    const r = run('_原图.mjs', ['两个家', '--json']);
    const j = jsonOf(r.out);
    A('① 前置：判据真跑（能出 JSON）', r.code === 0 && !!j, 'exit=' + r.code + ' ' + r.out.slice(0, 120));
    A('★ ① 原图两个家齐备 ⇒ 两个家 exit 0', r.code === 0 && j && j.ok === true, JSON.stringify(j).slice(0, 160));
    A('① 分母覆盖到活路径里的原图（不是空跑）', !!(j && j.liveOriginals >= 2), 'liveOriginals=' + (j && j.liveOriginals));
  }

  console.log('\n══ ② 阴性对照：把那个原图对象从 `_原图\\` 删掉 ⇒ P10-A 必须红 ══');
  {
    const ledger = JSON.parse(fs.readFileSync(path.join(LIB, '_原图台账.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(PAGE_BYTES).digest('hex').toUpperCase();
    const obj = Object.keys(ledger.objects).find((k) => k.toUpperCase() === sha);
    A('② 前置：台账里确有这个对象', !!obj, Object.keys(ledger.objects).length + ' 个对象');
    /* 删文件 + 删台账条目（真实"对象丢了"的形态） */
    const bucket = path.join(LIB, '_原图', sha.slice(0, 2));
    let removed = 0;
    for (const f of (fs.existsSync(bucket) ? fs.readdirSync(bucket) : [])) {
      if (f.toUpperCase().startsWith(sha)) { fs.unlinkSync(path.join(bucket, f)); removed++; }
    }
    delete ledger.objects[obj];
    fs.writeFileSync(path.join(LIB, '_原图台账.json'), JSON.stringify(ledger, null, 1) + '\n', 'utf8');
    A('② 前置：对象文件真被删掉', removed === 1, 'removed=' + removed);
    const r = run('_原图.mjs', ['两个家', '--json']);
    const j = jsonOf(r.out);
    A('★★ ② 阴性对照：原图少了一个家 ⇒ 两个家 exit 1 且点名该路径',
      r.code === 1 && j && j.ok === false && (j.unbacked || []).some((u) => String(u.rel).includes('原卷/批次1/p01.jpg')),
      'exit=' + r.code + ' unbacked=' + JSON.stringify((j && j.unbacked) || []).slice(0, 140));
  }

  console.log('\n══ ③ P10-B「非原图影像只能有一个家」：唯一份 ⇒ 绿 ══');
  {
    const r = run('_原图.mjs', ['单份', '--json']);
    const j = jsonOf(r.out);
    A('★ ③ 每份非原图影像只有一个家 ⇒ 单份 exit 0', r.code === 0 && j && j.ok === true, JSON.stringify(j).slice(0, 200));
    A('③ 分母覆盖到卡片裁图（不是空跑）', !!(j && j.scanned >= 1), 'scanned=' + (j && j.scanned));
  }

  console.log('\n══ ④ §3.5 的 E1/E2 例外（正例）+ 非例外仍是真冗余（负例）══');
  /* 每个子用例前先清掉上一例造的副本（隔离：免得组里混进上一例的路径而改变分类） */
  const cleanCopies = () => {
    for (const q of ['学生A/数学/M0002-测试', '_笔形/学生A/A/2026-11-06-0001.jpg', '学生A/数学/待办证据']) {
      fs.rmSync(path.join(LIB, q), { recursive: true, force: true });
    }
  };  /* E2 正例：卡目录里的图之间逐字节相同 ⇒ 豁免（F2：每卡自带四件套） */
  wf('学生A/数学/M0002-测试/原卷截图.jpg', SHOT_BYTES);
  {
    const r = run('_原图.mjs', ['单份', '--json']); const j = jsonOf(r.out);
    A('★ ④a E2 正例：相邻两卡的裁图逐字节相同 ⇒ 单份 exit 0，且豁免里点明 E2',
      r.code === 0 && j && j.ok === true && (j.exempted || []).some((e) => e.ex === 'E2'),
      'exit=' + r.code + ' exempt=' + JSON.stringify((j && j.exempted) || []).slice(0, 150));
  }
  cleanCopies();
  /* E1 正例：卡片四件套那张图与 `待办证据\` 里的图逐字节相同 ⇒ 豁免（两份各有消费方） */
  wf('学生A/数学/待办证据/T100.jpg', SHOT_BYTES);
  {
    const r = run('_原图.mjs', ['单份', '--json']); const j = jsonOf(r.out);
    A('★ ④b E1 正例：卡片 `原卷截图*` 与 `待办证据\` 的图逐字节相同 ⇒ exit 0，且豁免里点明 E1',
      r.code === 0 && j && j.ok === true && (j.exempted || []).some((e) => e.ex === 'E1'),
      'exit=' + r.code + ' exempt=' + JSON.stringify((j && j.exempted) || []).slice(0, 150));
  }
  cleanCopies();
  /* 负例①（规范 §3.5 明写「不是例外」）：同一科两个待办共用一张证据图 = 真冗余 ⇒ 必须红 */
  wf('学生A/数学/待办证据/T101.jpg', SHOT_BYTES);
  wf('学生A/数学/待办证据/T102.jpg', SHOT_BYTES);   // 两个待办各复制一份同一张证据图 = 真冗余
  {
    const r = run('_原图.mjs', ['单份', '--json']); const j = jsonOf(r.out);
    A('★★ ④c 负例：`待办证据\\` 里两份同 sha（多个待办共用一张证据图）⇒ **必须红**（规范明写这不是例外）',
      r.code === 1 && j && j.ok === false && (j.duplicates || []).length >= 1,
      'exit=' + r.code + ' dup=' + JSON.stringify((j && j.duplicates) || []).slice(0, 160));
  }
  cleanCopies();
  /* 负例②：E1/E2 之外的任何「同 sha 两处」仍必须红（这里是「把卡片图塞进笔形样本」） */
  wf('_笔形/学生A/A/2026-11-06-0001.jpg', SHOT_BYTES);
  {
    const r = run('_原图.mjs', ['单份', '--json']); const j = jsonOf(r.out);
    A('★★ ④d 负例：E1/E2 之外（卡片图 == 笔形样本）⇒ **必须红**（例外不许变成恒真）',
      r.code === 1 && j && j.ok === false && (j.duplicates || []).some((d) => d.paths.some((x) => x.includes('_笔形'))),
      'exit=' + r.code + ' dup=' + JSON.stringify((j && j.duplicates) || []).slice(0, 160));
  }
  /* 收尾：把造的副本都删掉，回到全绿（判据不是恒红） */
  for (const q of ['学生A/数学/M0002-测试', '_笔形/学生A/A/2026-11-06-0001.jpg', '学生A/数学/待办证据/T100.jpg']) {
    fs.rmSync(path.join(LIB, q), { recursive: true, force: true });
  }
  A('④ 收尾：删掉全部副本后单份恢复绿（判据不是恒红）', run('_原图.mjs', ['单份']).code === 0, '');

  console.log('\n══ ⑤ 「镜像不会回来」的机械证明 ══');
  {
    const r = run('_影像备份.mjs', []);
    A('★ ⑤a 退休后的 `_影像备份.mjs` 非零退出（显式拒绝执行）', r.code === 2, 'exit=' + r.code + ' ' + r.out.split('\n')[1]);
    A('★ ⑤b 它**没有创建** `_影像备份\\` 目录', !fs.existsSync(path.join(LIB, '_影像备份')),
      path.join(LIB, '_影像备份') + ' exists=' + fs.existsSync(path.join(LIB, '_影像备份')));
    const src = fs.readFileSync(TOOL('_影像备份.mjs'), 'utf8');
    A('⑤c 源码里没有任何写盘实现（建目录/复制/写台账一律没有）',
      !/mkdirSync|copyFileSync|writeFileSync|writeJsonAtomic|ensureDirs|copyOne/.test(src), '源码 ' + src.split('\n').length + ' 行');
  }

  console.log('\n══ ⑥ 摘除的机械证明：兜底层真的不在了 ══');
  {
    const eng = fs.readFileSync(ENGINE, 'utf8');
    A('⑥a `_原图寻址.mjs` 里没有 `lookupBackup`（那一层已摘除）', !/lookupBackup/.test(eng.replace(/^\s*\*.*$/gm, '')), '');
    A('⑥b 它也不再产出 `status: \'backup\'`（枚举里没有这个状态）', !/status: 'backup'/.test(eng), '');
    const probe = path.join(TMP, 'probe.mjs');
    fs.writeFileSync(probe, [
      'process.env.CTB_DATA = ' + JSON.stringify(LIB) + ';',
      'const m = await import("file:///' + ENGINE.replace(/\\/g, '/').replace(/^\/+/, '') + '");',
      "console.log(JSON.stringify(m.explainPath('_收件箱/2026-11-06-学生A-数学/p02.jpg', {})));",
    ].join('\n'), 'utf8');
    const pr = spawnSync(process.execPath, [probe], { cwd: ROOT, encoding: 'utf8' });
    let pj = null; try { pj = JSON.parse(String(pr.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { }
    A('⑥c 活路径在盘 ⇒ status=direct（两层兜底的第一层照旧零 IO）', !!(pj && pj.status === 'direct'), JSON.stringify(pj));
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