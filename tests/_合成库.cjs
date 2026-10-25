'use strict';
/**
 * _合成库.cjs — 把 fixtures 的文本合成库「物化」成可跑门禁的临时库（★ 2026-10-25）
 *
 * 为什么需要：合成库的影像（原卷整页/题图/证据图）**不进 git**（.gitignore 挡全部 png；
 * 2026-10-25 刚删掉 fixtures png 的反向口子——真卷影像会静默入库）。但 _原卷台账/_待确认
 * 等门禁要"图真的在盘上"。解法：仓库里只存文本（索引/台账/题干/svg）+ 一份影像清单契约
 * （_影像清单.json），测试启动时把整库复制到临时目录并**现场生成 PNG**。
 *
 * 用法：
 *   const { materialize } = require('./_合成库.cjs');
 *   const lib = materialize();                 // fixtures\库-形状 → %TEMP%\gn-synthlib-xxx（含 PNG）
 *   process.env.CTB_TEST_LIB = lib;            // 门禁随后用它
 * 单测（CLI）：node tests\_合成库.cjs   → 自检物化 + 三门禁跑绿才算过
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

/* fixtures 里的合成库（按优先序：形状库 > 最小库） */
function fixtureLibDir() {
  for (const d of ['库-形状', '库-最小']) {
    const p = path.join(REPO, 'fixtures', d);
    if (fs.existsSync(path.join(p, '_索引.json')) || fs.existsSync(path.join(p, '九年级-学生甲', '数学', '_索引.json'))) return p;
  }
  throw new Error('[_合成库] fixtures 里没有可用合成库（库-形状 / 库-最小）');
}

/**
 * 物化：复制文本 + 按清单生成 PNG。返回临时库绝对路径（调用方用完自删，或留给门禁进程）。
 * @param opts { keep?: boolean } keep=true 时不删既有物化产物（复用同一个目录，供多进程共享）
 */
function materialize(opts) {
  const o = opts || {};
  const src = fixtureLibDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-synthlib-'));
  fs.cpSync(src, dir, { recursive: true });

  const manifest = path.join(dir, '_影像清单.json');
  if (fs.existsSync(manifest)) {
    /* PNG 编码器是 ESM，cjs 这儿用动态 import 拿（Node ≥14.8 都支持） */
    const { pngGray, paperPage, figureGraph } = require('../scripts/png-cjs.cjs');
    const list = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '')).files || {};
    let n = 0;
    for (const [rel, meta] of Object.entries(list)) {
      const dst = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      let buf;
      if (meta.kind === 'paper') buf = paperPage(meta.w, meta.h);
      else if (meta.kind === 'figure') buf = figureGraph(meta.w, meta.h);
      else buf = pngGray(meta.w, meta.h, () => 200);
      fs.writeFileSync(dst, buf);
      n++;
    }
    if (!n) throw new Error('[_合成库] 影像清单是空的，物化不出图（生成器与清单漂移？）');
  }
  return dir;
}

/* ───────────── CLI 自检：物化 + 三道数据门禁全绿才 exit 0 ───────────── */
if (require.main === module) {
  let bad = 0;
  const A = (n, ok, d = '') => { console.log((ok ? '  [OK]  ' : '  [FAIL] ') + n + (d ? '  → ' + d : '')); if (!ok) bad++; };
  const lib = materialize();
  console.log('[_合成库] 物化到 ' + lib);
  try {
    const man = JSON.parse(fs.readFileSync(path.join(lib, '_影像清单.json'), 'utf8')).files || {};
    A('清单里的 PNG 全部真的在盘上', Object.keys(man).every(rel => {
      const p = path.join(lib, ...rel.split('/'));
      const b = fs.existsSync(p) && fs.readFileSync(p);
      return b && b[0] === 0x89 && b[1] === 0x50;
    }), Object.keys(man).length + ' 张');
    A('原卷台账引用的 page 全部存在', (() => {
      const led = JSON.parse(fs.readFileSync(path.join(lib, '_原卷台账.json'), 'utf8'));
      return Object.values(led.cards).filter(e => e.page).every(e => fs.existsSync(path.join(lib, ...e.page.split('/'))));
    })(), '');
    A('待确认证据图存在', (() => {
      const j = JSON.parse(fs.readFileSync(path.join(lib, '_待确认.json'), 'utf8'));
      return j.items.every(t => !t.evidence || fs.existsSync(path.join(lib, ...t.evidence.split('/'))));
    })(), '');

    /* 三道数据门禁（quick 的前三项，正是干净克隆上原本 SKIP 的） */
    const env = Object.assign({}, process.env, { CTB_DATA: lib, CTB_TEST_LIB: lib });
    const run = (tool, args) => {
      try {
        const out = execFileSync(process.execPath, [path.join(REPO, 'src', 'tools', tool), ...args], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });
        return { code: 0, out };
      } catch (e) { return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
    };
    const g1 = run('_原卷台账.mjs', ['门禁']);
    A('_原卷台账 门禁 exit 0', g1.code === 0, (g1.out.match(/门禁：卡 \d+[^\r\n]*/) || [''])[0].slice(0, 80) || g1.out.split(/\r?\n/).filter(l => /✗|✖/.test(l)).slice(0, 2).join(' | ').slice(0, 160));
    const g2 = run('_待确认.mjs', ['证据']);
    A('_待确认 证据门禁 exit 0', g2.code === 0, (g2.out.match(/证据图覆盖[^\r\n]*/) || [''])[0]);
    const g3 = run('_配图门禁.mjs', ['门禁']);
    A('_配图门禁 门禁 exit 0', g3.code === 0, (g3.out.match(/配图状态[^\r\n]*/) || [''])[0]);

    /* 物化图再次生成必须逐字节稳定（可复现构建的图形状版本） */
    const lib2 = materialize();
    const man2 = JSON.parse(fs.readFileSync(path.join(lib2, '_影像清单.json'), 'utf8')).files || {};
    const stable = Object.keys(man2).every(rel => fs.readFileSync(path.join(lib2, ...rel.split('/'))).equals(fs.readFileSync(path.join(lib, ...rel.split('/')))));
    A('两次物化 PNG 逐字节相同（可复现）', stable, '');
    fs.rmSync(lib2, { recursive: true, force: true });
  } finally {
    fs.rmSync(lib, { recursive: true, force: true });
  }
  console.log('\nRESULT=' + (bad ? 'FAIL' : 'PASS'));
  process.exit(bad ? 1 : 0);
}

module.exports = { materialize, fixtureLibDir };
