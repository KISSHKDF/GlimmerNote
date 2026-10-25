/* 拾光小册 · 测试环境（唯一入口）
 *
 * 为什么要有这个文件：
 *   程序与数据分家之后（AppRoot / DataRoot），测试里那个 `const ROOT = resolve(__dirname,'..')`
 *   只对一半用途还成立 —— 它既是"仓库根"（找 src\、tests\、VERSION.json），
 *   又曾被当成"库根"（找 九年级\_索引.json、_待确认.json）。
 *   现在拆开：
 *     REPO = 仓库根（程序侧，只读）
 *     TOOLS = REPO\src\tools（业务 .mjs 都在这儿）
 *     LIB  = 库根（用户数据，测试的**数据源**）
 *
 * LIB 优先级：
 *   ① 环境变量 CTB_TEST_LIB
 *   ② 仓库的同级目录 ..\错题本（本机的真库；只在开发机存在）
 *   ③ 仓库的同级目录 ..\GlimmerNote\数据（运行区的库）
 *   都没有就响亮失败——**绝不**静默指向一个空目录然后让测试"全绿"。
 *
 * ⚠ 铁律：真库只读。任何会写盘的测试必须先 assertWritableLib()，
 *   它会在 LIB 指向真库时**直接抛错**，逼你把测试跑在副本上（见 makeTempLib）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const TOOLS = path.join(REPO, 'src', 'tools');

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function resolveLib() {
  const env = process.env.CTB_TEST_LIB;
  if (env && String(env).trim()) {
    const p = path.resolve(String(env).trim());
    if (!isDir(p)) throw new Error('[测试环境] CTB_TEST_LIB 指向的目录不存在：' + p);
    /* ★ 2026-10-25：显式指向 fixtures 合成库时也要物化（与候选分支同一条规则）——
       否则"显式指定"反而绕开影像生成，门禁在合成库上永远缺图（实测踩过）。 */
    if (p.startsWith(path.join(REPO, 'fixtures'))) {
      const { materialize } = require('./_合成库.cjs');
      return materialize();
    }
    return p;
  }
  /* ★ 2026-10-24 审计修复（F-06 / DEFECT-REGISTRY D-051）：
   * 原先只有下面两个候选，都是**本机才有**的目录（..\错题本、..\GlimmerNote\数据）。
   * 于是新克隆（换机 / 换人 / CI）跑 `node tests\run.mjs quick` 必然
   * throw「找不到库」⇒ F-06「新克隆能跑测试」永久 FAIL。
   * 现在加第三个候选：**仓库自带的合成库 fixtures\库-最小**。
   * 优先级放在真库之后，所以开发机上行为不变（仍优先用真实数据做回归），
   * 而在没有真库的机器上自动落到合成库。
   * ★ 2026-10-24 迁移：真库已迁至运行区 GlimmerNote\数据（对账全绿），候选序对调；
   *   旧冻结区（已改名 错题本-冻结-20261024）保留为观察期兜底候选，目录不在则自然跳过。 */
  const cands = [
    path.resolve(REPO, '..', 'GlimmerNote', '数据'),        // 运行区库（真库所在）
    path.resolve(REPO, '..', '错题本'),                    // 旧冻结区（观察期兜底）
    path.join(REPO, 'fixtures', '库-形状'),                 // ★ 仓库自带合成形状库（新克隆默认；影像运行时物化）
    path.join(REPO, 'fixtures', '库-最小'),                 // 合成最小库（形状库缺失时的兜底）
  ];
  for (const c of cands) {
    if (!isDir(c)) continue;
    /* 像库的判据：有索引 / 有学生目录 / 有状态包，任一成立。
       ★ 2026-10-24 B-09：目录名判据不再写死某个真实学生目录名，
       改成「任意 <年级> 或 <年级>-<姓名> 目录」——合成库与新建学生目录都认。 */
    const gradeLike = fs.readdirSync(c).some(n => /^\d+年级(-.+)?$/.test(n));
    if (fs.existsSync(path.join(c, '_索引.json')) ||
      gradeLike ||
      fs.existsSync(path.join(c, '_状态.json'))) {
      /* ★ 2026-10-25：选中的是仓库 fixtures 合成库时，自动「物化」到临时目录——
       * 合成库的影像（原卷整页/题图/证据图）不进 git（.gitignore 挡全部 png，
       * 2026-10-25 刚删掉 fixtures png 反向口子），只存 _影像清单.json 契约；
       * 物化 = 复制文本 + 按清单现场生成 PNG。此后所有门禁（_原卷台账/_待确认 证据/
       * _配图门禁 的"图必须在盘上"判据）在合成库上也能真跑，而不是 SKIP。 */
      if (c.startsWith(path.join(REPO, 'fixtures'))) {
        const { materialize } = require('./_合成库.cjs');
        const m = materialize();
        if (process.env.CTB_TEST_LIB) process.env.CTB_TEST_LIB = m;
        return m;
      }
      return c;
    }
  }
  throw new Error('[测试环境] 找不到库。三种办法任选其一：' +
    '\n  ① 什么都不做 —— 仓库自带的 fixtures\\库-最小 应当被自动选中（若报这个错说明它缺文件）' +
    '\n  ② 设 CTB_TEST_LIB 指向一个库目录（含 _索引.json / 学生目录）' +
    '\n  ③ 在本仓同级放一个 错题本\\ 或 GlimmerNote\\数据\\ 目录' +
    '\n  试过：' + cands.join(' 、 '));
}

const LIB = resolveLib();

/* ★ 2026-10-24 审计修复（DEFECT-REGISTRY D-045 的根因，一次修一类）：
 * 程序与数据分家（2026-10-23）之后，所有工具都用 `_库根.mjs libraryRoot()` 定位库，
 * 而 `libraryRoot()` 认的是 **环境变量 CTB_DATA**；不传就退回"工具自己所在目录"
 * → 工具去 src\tools\ 下找 _状态.json → 恒 ENOENT。
 *
 * 症状：多个测试（neg-server-bom、neg-server-get-readonly 等）直接 execFileSync 起
 * 工具却**没传 CTB_DATA** ⇒ 断言永久 FAIL ⇒ `run.mjs quick` 永久红 ⇒ 发版检查单第 3 步
 * 永远过不去 ⇒ 没人真跑门禁。这一整类 bug 的共同根因就是这里没把 CTB_DATA 铺到子进程。
 *
 * 修法：这里统一把 CTB_DATA 写进 process.env。子进程默认继承 process.env，
 * 于是"忘记传 env"的调用也自动拿到正确库根。走临时库的测试仍可用
 * runToolSync(..., { data: tmp }) 显式覆盖。 */
if (!process.env.CTB_DATA) process.env.CTB_DATA = LIB;

/** 冻结区（真库）路径判定：任何写入都必须被挡住 */
/** 冻结区（真库）路径判定：任何写入都必须被挡住。
 *  ★ 2026-10-24 迁移：真库搬到 GlimmerNote\数据 后不再带「错题本」字样，
 *    守卫扩展为两条：旧冻结区路径（错题本*）+ 运行区数据根（GlimmerNote\数据）。 */
const FROZEN = /(^|[\\/])错题本([^\\/]*)([\\/]|$)|[\\/]GlimmerNote[\\/]数据([\\/]|$)/i;

function isFrozen(p) { return FROZEN.test(String(p || '')); }

/** ★ 2026-10-24 B-09：动态发现库里的索引文件（替代测试里写死的真实库路径）。
 *  口径与 _原卷台账.mjs loadCards 相同：库根下（跳过 _ / . 开头）一层与两层目录里的
 *  `_索引.json`（年级级 + 学科级索引都认）。返回相对 root 的 'dir/_索引.json' 列表（已排序）。
 *  不传 root 用 LIB；测试跑在 makeTempLib 副本上时传自己的临时库根。 */
function findIndexes(root) {
  const base = root || LIB;
  const out = [];
  (function walk(d, depth) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (fs.existsSync(path.join(full, '_索引.json')))
        out.push(path.relative(base, full).replace(/\\/g, '/') + '/_索引.json');
      if (depth > 0) walk(full, depth - 1);
    }
  })(base, 1);
  return out.sort();
}

/** 库内路径 */
function lib(...parts) { return path.join(LIB, ...parts); }
/** 工具绝对路径（兄弟工具一律走它，不要自己拼 ROOT） */
function tool(name) { return path.join(TOOLS, name); }

/** 会写盘的测试必须先调它：LIB 指向真库就拒绝执行 */
function assertWritableLib(what) {
  if (isFrozen(LIB)) {
    throw new Error('[测试环境] 拒绝执行：本次测试会写盘（' + (what || '未说明') + '），' +
      '而 LIB 指向真库 → ' + LIB + '\n  请先 const tmp = makeTempLib(); 并把 LIB 换成 tmp。');
  }
}

/* 复制库到临时目录（只复制数据文件，不复制 1.4GB 影像；需要图的任务另行指定） */
const COPY_FILES = [
  '_索引.json', '_状态.json', '_待确认.json', '_组卷台账.json', '_配图台账.json',
  '_原卷台账.json', '_盲解双路.json', '_笔形台账.json', '_页码映射.json',
  '_词表.md', '_复习队列.md', '_待确认清单.md',
];

function makeTempLib(extraDirs, opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-testlib-'));
  for (const f of COPY_FILES) {
    const s = path.join(LIB, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, f));
  }
  /* 复制时**保留 mtime**：盲解指纹门禁除了比指纹，还比「题干.html 的 mtime 日期是否晚于盲解日」
     （_盲解复核.mjs 的 stemEditedAfterBlind）。copyFileSync 会把 mtime 刷成现在，
     于是整库卡都会被判「盲解后改过题干」⇒ 组卷被门禁拦下。这不是真缺陷，是复制方式丢了证据。 */
  const copyKeepTime = (src, dst) => {
    fs.copyFileSync(src, dst);
    try { const st = fs.statSync(src); fs.utimesSync(dst, st.atime, st.mtime); } catch { }
  };
  /* 卡片级文件：指纹/渲染要用，但影像（1.4GB+）不复制。
     opts.copyCardFiles=true 时才复制 —— 组卷/批改类测试需要它（否则指纹判失效、题干渲染为空）。 */
  const CARD_FILES = ['题干.html', '错题记录.md', '配图.svg'];
  const copySidecars = (idxAbs, relDir) => {
    if (!o.copyCardFiles) return;
    let j;
    try { j = JSON.parse(fs.readFileSync(idxAbs, 'utf8').replace(/^\uFEFF/, '')); } catch { return; }
    const multi = j.subjects && typeof j.subjects === 'object' && !Array.isArray(j.subjects);
    const rows = [];
    if (multi) for (const [sn, v] of Object.entries(j.subjects)) for (const it of (v.items || [])) rows.push([it, path.join(relDir, sn)]);
    else for (const it of (j.items || [])) rows.push([it, relDir]);
    for (const [it, rel] of rows) {
      const sub = it.dir || it.id || '';
      if (!sub) continue;
      const srcDir = path.join(LIB, rel, sub);
      const dstDir = path.join(dir, rel, sub);
      for (const f of CARD_FILES) {
        const s = path.join(srcDir, f);
        if (!fs.existsSync(s)) continue;
        try { fs.mkdirSync(dstDir, { recursive: true }); copyKeepTime(s, path.join(dstDir, f)); } catch { }
      }
    }
  };
  /* 学生目录：只复制结构（含 _索引.json 的层级），不复制图片，除非调用方点名要 */
  const walk = (base, rel, depth) => {
    let ents; try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const abs = path.join(base, e.name), r = path.join(rel, e.name);
      const idx = path.join(abs, '_索引.json');
      if (fs.existsSync(idx)) {
        fs.mkdirSync(path.join(dir, r), { recursive: true });
        copyKeepTime(idx, path.join(dir, r, '_索引.json'));
        copySidecars(idx, r);
      }
      if (depth > 1) walk(abs, r, depth - 1);
    }
  };
  walk(LIB, '', 2);
  /* extraDirs：额外整目录复制的相对路径（如 '九年级' 需要图片时） */
  for (const d of (extraDirs || [])) {
    const s = path.join(LIB, d);
    if (isDir(s)) fs.cpSync(s, path.join(dir, d), { recursive: true });
  }
  return dir;
}

/* ══════════════════════════════════════════════════════════════════════
   前端页面 URL 判据（唯一实现）
   为什么要有：前端从「<库根>\v2\index.html」搬到「<程序目录>\index.html」之后，
   四个界面测试各自写着 `/v2\/index/` 去认页面 —— 搬到 src\app 后这条正则永远不匹配：
     · e2e-writepath   → NO TARGET（整条写路径闭环根本没跑，却只报一行 NO TARGET）
     · interactive-sweep / shell-visual → 报 SKIP 或 FAIL
   ⚠ 匹配前必须**先剥查询串和路由哈希**：前端用 hash 记路由，实测 URL 是 index.html#dash，
     只剥 '?' 会让 /index\.html$/ 判假（2026-10-23 实测踩到）。
   三种布局都认：发布包 <AppRoot>\index.html、开发区 <仓库>\src\app\index.html、老布局 <库根>\v2\index.html
   ══════════════════════════════════════════════════════════════════════ */
function isAppUrl(u) {
  const s = String(u || '').split(/[?#]/)[0];
  return /\/index\.html$/i.test(s);
}
/** 同上，且必须是 file:// 通道（= 真桌面壳，而不是本机服务端） */
function isFileAppUrl(u) {
  return /^file:/i.test(String(u || '')) && isAppUrl(u);
}

/** 统一的"跑工具"入口：永远带 CTB_DATA=LIB，永远用 TOOLS 里的路径 */function runToolSync(name, args, opts) {
  const { execFileSync } = require('child_process');
  const o = opts || {};
  const env = Object.assign({}, process.env, { CTB_DATA: o.data || LIB });
  try {
    const out = execFileSync(process.execPath, [tool(name), ...(args || [])], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env, cwd: REPO,
    });
    return { code: 0, out: String(out || ''), err: '' };
  } catch (e) {
    /* 门禁语义：退出码 1 = 有未通过项，stdout 仍是完好 JSON，必须当成功返回 */
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   测试自带服务端（2026-10-23）
   为什么：界面类测试原先要求"本机 7187 有个服务端在跑"。但那台服务端
   可能是**用户正在用的冻结区老程序**（实测 7187 上就是冻结区旧库自己的 _服务端.mjs，
   提供的是老前端）——测试连上去必然对不上，还会把"用户的服务在不在"变成测试前提。
   现在：测试自己起一个实例、自己挑空闲端口、跑完自己关掉。
   若显式给了 CTB_SRV，就尊重它（CI / 手工指定场景）。
   ══════════════════════════════════════════════════════════════════════ */
let _srv = null;

function freePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 起一个测试专用服务端；返回 { base, port, stop() } */
async function startServer(opts) {
  if (_srv) return _srv;
  const { spawn } = require('child_process');
  const o = opts || {};
  const port = o.port || await freePort();
  const proc = spawn(process.execPath, [tool('_服务端.mjs')], {
    cwd: REPO,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: o.data || LIB }),
  });
  let out = '', err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });

  const base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 30000) {
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) { up = true; break; }
    } catch { }
    await new Promise((r) => setTimeout(r, 300));
  }
  const stop = () => new Promise((resolve) => {
    try { proc.kill(); } catch { }
    setTimeout(resolve, 200);
  });
  if (!up) {
    await stop();
    throw new Error('[测试环境] 测试服务端 30s 内没起来（port=' + port + '）\n' + out.slice(-400) + err.slice(-400));
  }
  _srv = { base, port, stop, proc, getOut: () => out, getErr: () => err };
  return _srv;
}

/** 有 CTB_SRV 就返回它，否则起一个（惰性） */
async function serverBase() {
  if (process.env.CTB_SRV) return process.env.CTB_SRV;
  const s = await startServer();
  return s.base;
}

module.exports = {
  REPO, TOOLS, LIB, isFrozen, findIndexes,
  lib, tool, assertWritableLib, makeTempLib, runToolSync,
  startServer, serverBase, freePort,
  isAppUrl, isFileAppUrl,
  describe: () => '仓库=' + REPO + '　库=' + LIB,
};
