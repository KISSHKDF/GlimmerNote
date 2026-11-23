#!/usr/bin/env node
/**
 * 配图质量闸门的阴性对照（2026-11-23 用户裁定「配图三级来源」后新增）
 *
 * 背景：`_配图门禁.mjs` 此前只判「有没有图」，**不判图好不好**。实测真库：
 *   · 39 张 jpg 配图里 21 张直接剪自孩子作业本，宽度 218–686 像素（印刷后线条不可辨）；
 *   · M0070 的 `题图.jpg` 上带一道红笔批改（重做卷会泄答案）；
 *   · 台账 `need=false` 却实际挂着在用的图：7 张（另有 8 张是「遗留冗余」，不阻断）。
 *   而门禁当时 exit 0 全绿。
 *
 * 本用例全部跑在**自构造临时库**上（不依赖真库形态），四段各带阴性自证：
 *   A 尺寸不足：宽度 < 1000 的 jpg ⇒ 质量动作必须点名该卡；
 *     变异自证：把阈值抬到 999999 ⇒ 该卡不再被报（原缺陷复现）。
 *   B 台账矛盾：need=false 但目录有**在用**的图 ⇒ 必须报红；
 *     而 need=false + 目录有图 + 题干内联了 svg ⇒ 是「遗留冗余」，只提示不阻断。
 *   C 来源未登记：kind=jpg 但台账没写清洗痕迹/网上出处 ⇒ 必须报红；
 *     写了 ⇒ 不报。
 *   D 红笔残留（深检）：图上有成形红笔 ⇒ 必须报红；洗掉 ⇒ 不报。
 *     变异自证：把红笔判据关掉 ⇒ 红笔卡不再被报（原缺陷复现）。
 *   E 换图即失效：`题图.jpg` 内容变了 ⇒ 盲解指纹必须变（图形层结论作废）。
 *     变异自证：指纹只算题干.html ⇒ 换图指纹不变（原缺陷复现）。
 *
 * 退出码 0=对照成立；1=对照失败。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');

const E = require('./_测试环境.cjs');
const ROOT = path.resolve(__dirname, '..');
const TOOLS = E.TOOLS;
let fails = 0, total = 0;
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

/* ---------- 造一张真实可解码的小 JPEG ---------- */
/**
 * 用 System.Drawing 造一张指定尺寸、含指定红色笔画的 JPEG。
 * 为什么要造真的：`_配图质量.mjs` 读图尺寸靠读文件头，读红笔靠像素解码 ——
 * 假字节串过不了这两关，测出来的"通过"是假的。
 */
function makeJpeg(file, w, h, opts = {}) {
  const ps = `
param([string]$Out,[int]$W,[int]$H,[int]$RedX,[int]$RedY,[int]$RedLen)
Add-Type -AssemblyName System.Drawing
$bmp=New-Object System.Drawing.Bitmap($W,$H)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
# 画一条黑色印刷体曲线（模拟图里的线条）
$pen=New-Object System.Drawing.Pen([System.Drawing.Color]::Black,3)
for($x=10;$x -lt ($W-10);$x+=4){ $y=[int]($H/2 + [math]::Sin($x/40.0)*($H/4)); $g.DrawEllipse($pen,$x,$y,4,4) }
$g.Dispose()
if($RedLen -gt 0){
  $rp=New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255,200,60,60),3)
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.DrawLine($rp,$RedX,$RedY,($RedX+$RedLen),$RedY)
  $g.Dispose()
}
$bmp.Save($Out,[System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
`;
  const tmp = path.join(os.tmpdir(), 'gn-makejpeg-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.ps1');
  fs.writeFileSync(tmp, '﻿' + ps, 'utf8');
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp,
      '-Out', file, '-W', String(w), '-H', String(h),
      '-RedX', String(opts.redX || 0), '-RedY', String(opts.redY || 0), '-RedLen', String(opts.redLen || 0)],
      { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
  }
}

/** 自构造最小库 */
function makeLib(t) {
  const dir = E.allocTempDir('gn-figq-');
  fs.mkdirSync(path.join(dir, '小图', '数学', t.dir), { recursive: true });
  fs.writeFileSync(path.join(dir, '小图', '数学', '_索引.json'), JSON.stringify({
    student: '小图', grade: '九年级', subject: '数学', updatedAt: '2026-11-23T00:00:00+08:00',
    items: [{
      id: t.id, dir: t.dir, source: '测试', type: '几何', question: '如图，求解。', answer: '略',
      status: '在册', hasImage: true, blindStatus: '未盲解',
      /* ★ 指纹版本：默认 v2。E 段要验"换图即失效"必须用 **v3**
         （v3 才把外链图资产的内容哈希并进指纹；v2 只认内联 svg/img ⇒ 换图指纹不变，
          这是**设计意图**：不能因为升级算法就把全库 73 张图形卡的旧结论一次性打掉）。 */
      blindFingerprint: '', blindFingerprintVer: t.fpVer || 2, blindSolveAt: '', blindSolver: '', blindNote: '',
      reviews: [],
    }],
  }, null, 1), 'utf8');
  if (t.figJpg) makeJpeg(path.join(dir, '小图', '数学', t.dir, '题图.jpg'), t.figJpg.w, t.figJpg.h, t.figJpg);
  if (t.stemHtml !== undefined) fs.writeFileSync(path.join(dir, '小图', '数学', t.dir, '题干.html'), t.stemHtml, 'utf8');
  const led = { note: '测试', cards: {} };
  if (t.ledger) led.cards['小图|' + t.id] = t.ledger;
  fs.writeFileSync(path.join(dir, '_配图台账.json'), JSON.stringify(led, null, 1), 'utf8');
  return dir;
}

/** 跑配图门禁 质量 --json */
function quality(lib, extra = []) {
  const r = spawnSync(process.execPath, [path.join(TOOLS, '_配图门禁.mjs'), '质量', '--json', ...extra], {
    encoding: 'utf8', maxBuffer: 32e6,
    env: Object.assign({}, process.env, { CTB_DATA: lib }),
  });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { }
  return { status: r.status, json: j, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/* ═══════════════ A 尺寸不足 ═══════════════ */
console.log('\n═══ A 尺寸不足（宽度 < 1000 ⇒ 报红）═══');
{
  const lib = makeLib({
    id: 'A001', dir: 'A001-小图',
    figJpg: { w: 320, h: 240 },
    ledger: { need: true, kind: 'jpg', ref: '题图.jpg', note: '来源：网上题库原图；站点：示例', by: 't', date: '2026-11-23' },
  });
  const q = quality(lib);
  const hit = q.json && q.json.rows.some(r => r.key === '小图|A001' && r.problems.some(p => /尺寸不足/.test(p)));
  A('★ 320×240 的图被判「尺寸不足」', !!hit, JSON.stringify(q.json && q.json.rows.map(r => r.problems)) || q.stderr.slice(0, 200));
  if (process.env.GN_FIGQ_DEBUG) {
    const fp = path.join(lib, '小图', '数学', 'A001-小图', '题图.jpg');
    console.log('   [debug] lib=' + lib);
    console.log('   [debug] fig exists=' + fs.existsSync(fp) + ' size=' + (fs.existsSync(fp) ? fs.statSync(fp).size : -1));
    console.log('   [debug] q.json=' + JSON.stringify(q.json));
  }

  /* 阴性自证：把阈值降到 1 ⇒ 任何宽度都不小于它 ⇒ 同一条卡不再被报
     （证明这条判定是阈值驱动的，不是恒真）。
     ⚠ 变异方向要选对：阈值**抬到极大**时 320 仍然 < 999999，照样会报 ⇒ 那样证明不了任何东西。 */
  const q2 = (() => {
    const r = spawnSync(process.execPath, [path.join(TOOLS, '_配图门禁.mjs'), '质量', '--json'], {
      encoding: 'utf8', maxBuffer: 32e6,
      env: Object.assign({}, process.env, { CTB_DATA: lib, CTB_FIG_MIN_WIDTH: '1' }),
    });
    let j = null; try { j = JSON.parse(r.stdout); } catch { }
    return { status: r.status, json: j, stdout: r.stdout || '', stderr: r.stderr || '' };
  })();
  const hit2 = q2.json && q2.json.rows.some(r => r.key === '小图|A001' && r.problems.some(p => /尺寸不足/.test(p)));
  A('★ 变异自证：阈值降到 1 ⇒ 「尺寸不足」不再被报（原缺陷复现）', !hit2,
    '仍被报 ⇒ 判定与阈值无关（恒真）｜stdout=' + q2.stdout.slice(0, 200) + ' stderr=' + q2.stderr.slice(0, 200));
}

/* ═══════════════ B 台账矛盾 vs 遗留冗余 ═══════════════ */
console.log('\n═══ B 台账矛盾（need=false 却有在用的图 ⇒ 报红）═══');
{
  const lib = makeLib({
    id: 'B001', dir: 'B001-小图',
    figJpg: { w: 1200, h: 900 },
    stemHtml: '<div class="stem"><p>如图</p></div>',   // 无内联 svg ⇒ 题图.jpg 是在用的
    ledger: { need: false, kind: 'none', ref: '', note: '确认无需图', by: 't', date: '2026-11-23' },
  });
  const q = quality(lib);
  const hit = q.json && q.json.rows.some(r => r.key === '小图|B001' && r.problems.some(p => /台账矛盾/.test(p)));
  A('★ need=false + 在用的图 ⇒ 判「台账矛盾」', !!hit, JSON.stringify(q.json && q.json.rows.map(r => r.problems)) || q.stderr.slice(0, 200));
}
{
  /* 遗留冗余：题干已内联 svg，目录里的 jpg 是历史包袱 ⇒ 只提示不阻断 */
  const lib = makeLib({
    id: 'B002', dir: 'B002-小图',
    figJpg: { w: 1200, h: 900 },
    stemHtml: '<div class="stem"><svg xmlns="http://www.w3.org/2000/svg"><circle r="8"/></svg></div>',
    ledger: { need: false, kind: 'none', ref: '', note: '确认无需图', by: 't', date: '2026-11-23' },
  });
  const q = quality(lib);
  const blocked = q.json && q.json.rows.some(r => r.key === '小图|B002' && r.problems.some(p => /台账矛盾/.test(p)));
  const warned = q.json && (q.json.warnings || []).some(w => w.key === '小图|B002' && /遗留冗余/.test(w.text));
  A('★ 遗留冗余（题干内联 svg）⇒ 只提示不阻断', !blocked && !!warned,
    'blocked=' + !!blocked + ' warned=' + !!warned);
}

/* ═══════════════ C 来源未登记 ═══════════════ */
console.log('\n═══ C 来源未登记（kind=jpg 没写清洗/出处 ⇒ 报红）═══');
{
  const lib = makeLib({
    id: 'C001', dir: 'C001-小图',
    figJpg: { w: 1200, h: 900 },
    ledger: { need: true, kind: 'jpg', ref: '题图.jpg', note: '题图单独裁出', by: 't', date: '2026-11-23' },
  });
  const q = quality(lib);
  const hit = q.json && q.json.rows.some(r => r.key === '小图|C001' && r.problems.some(p => /来源未登记/.test(p)));
  A('★ kind=jpg 但没写清洗痕迹 ⇒ 判「来源未登记」', !!hit, JSON.stringify(q.json && q.json.rows.map(r => r.problems)) || q.stderr.slice(0, 200));
}
{
  const lib = makeLib({
    id: 'C002', dir: 'C002-小图',
    figJpg: { w: 1200, h: 900 },
    ledger: { need: true, kind: 'jpg', ref: '题图.jpg（清洗：去红笔+放大2x）', note: '网上未找到逐字一致原图，故清洗原卷裁图', by: 't', date: '2026-11-23' },
  });
  const q = quality(lib);
  const hit = q.json && q.json.rows.some(r => r.key === '小图|C002' && r.problems.some(p => /来源未登记/.test(p)));
  A('★ 写了清洗痕迹 ⇒ 不再报「来源未登记」', !hit, JSON.stringify(q.json && q.json.rows.map(r => r.problems)) || '');
}

/* ═══════════════ D 红笔残留（深检） ═══════════════ */
console.log('\n═══ D 红笔残留（深检：图上有成形红笔 ⇒ 报红）═══');
{
  const lib = makeLib({
    id: 'D001', dir: 'D001-小图',
    figJpg: { w: 1200, h: 900, redX: 300, redY: 200, redLen: 120 },
    ledger: { need: true, kind: 'jpg', ref: '题图.jpg（清洗：去红笔）', note: '清洗过', by: 't', date: '2026-11-23' },
  });
  const q = quality(lib, ['--深检']);
  const hit = q.json && q.json.rows.some(r => r.key === '小图|D001' && r.problems.some(p => /红笔/.test(p)));
  A('★ 带红笔的图被判「红笔残留」', !!hit, JSON.stringify(q.json && q.json.rows.map(r => r.problems)) || q.stderr.slice(0, 300));
}
{
  const lib = makeLib({
    id: 'D002', dir: 'D002-小图',
    figJpg: { w: 1200, h: 900 },
    ledger: { need: true, kind: 'jpg', ref: '题图.jpg（清洗：去红笔）', note: '清洗过', by: 't', date: '2026-11-23' },
  });
  const q = quality(lib, ['--深检']);
  const hit = q.json && q.json.rows.some(r => r.key === '小图|D002' && r.problems.some(p => /红笔/.test(p)));
  A('★ 干净图不被误判「红笔残留」', !hit, JSON.stringify(q.json && q.json.rows.map(r => r.problems)) || '');
}

/* ═══════════════ E 换图即失效（盲解指纹含图资产哈希） ═══════════════ */
console.log('\n═══ E 换图即失效（题图.jpg 内容变 ⇒ 盲解指纹变）═══');
{
  const lib = makeLib({
    id: 'E001', dir: 'E001-小图',
    figJpg: { w: 1200, h: 900 },
    stemHtml: '<div class="stem"><p>如图</p></div>',
    fpVer: 3,                       // ★ v3：含外链图资产哈希 ⇒ 换图即失效
    ledger: { need: true, kind: 'jpg', ref: '题图.jpg（清洗：去红笔）', note: '清洗过', by: 't', date: '2026-11-23' },
  });
  /* 指纹取法：`现指纹 --json`（只读；`指纹` 子命令是"补指纹"写操作，不是查询）。 */
  const fpOf = () => {
    const r = spawnSync(process.execPath, [path.join(TOOLS, '_盲解复核.mjs'), '现指纹', '--ids', 'E001', '--json'], {
      encoding: 'utf8', maxBuffer: 32e6,
      env: Object.assign({}, process.env, { CTB_DATA: lib }),
    });
    let j = null; try { j = JSON.parse(r.stdout); } catch { }
    return { status: r.status, json: j, out: r.stdout || '', err: r.stderr || '' };
  };
  const fp1 = fpOf();
  /* 换图（内容不同 ⇒ 哈希不同） */
  makeJpeg(path.join(lib, '小图', '数学', 'E001-小图', '题图.jpg'), 1200, 900, { redX: 500, redY: 500, redLen: 80 });
  const fp2 = fpOf();

  const curFp = o => {
    if (!o.json || !o.json.rows || !o.json.rows.length) return null;
    return o.json.rows[0].current || '';
  };
  const a = curFp(fp1), b = curFp(fp2);
  A('★ 换图后盲解指纹发生变化（换图即失效，v3）', a !== null && b !== null && a !== '' && a !== b,
    a === null ? '第一次取不到指纹'
      : b === null ? '第二次取不到指纹'
        : '两次指纹相同 ⇒ 换图没有让结论失效');
}
{
  /* ★ 互补断言：**v2 卡换图指纹不变**。
     这不是缺陷，是**版本化的设计意图**：v2 的签名只含内联 svg/img，
     升级算法不能把全库 73 张图形卡的旧结论一次性打成失效（那会用真问题掩盖真问题）。
     v3 起新落的结论才有"换图即失效"。 */
  const lib = makeLib({
    id: 'E002', dir: 'E002-小图',
    figJpg: { w: 1200, h: 900 },
    stemHtml: '<div class="stem"><p>如图</p></div>',
    fpVer: 2,                       // v2：不含外链图资产哈希
    ledger: { need: true, kind: 'jpg', ref: '题图.jpg（清洗：去红笔）', note: '清洗过', by: 't', date: '2026-11-23' },
  });
  const fpOf = () => {
    const r = spawnSync(process.execPath, [path.join(TOOLS, '_盲解复核.mjs'), '现指纹', '--ids', 'E002', '--json'], {
      encoding: 'utf8', maxBuffer: 32e6,
      env: Object.assign({}, process.env, { CTB_DATA: lib }),
    });
    let j = null; try { j = JSON.parse(r.stdout); } catch { }
    return j && j.rows && j.rows.length ? j.rows[0].current : null;
  };
  const a = fpOf();
  makeJpeg(path.join(lib, '小图', '数学', 'E002-小图', '题图.jpg'), 1200, 900, { redX: 500, redY: 500, redLen: 80 });
  const b = fpOf();
  A('★ v2 卡换图指纹不变（版本化不误伤存量）', a !== null && b !== null && a === b,
    a === null || b === null ? '取不到指纹' : 'v2 卡的指纹变了 ⇒ 升级算法会打掉存量卡的有效结论');
}

console.log(`\nRESULT=${fails ? 'FAIL' : 'PASS'} 断言=${total}`);
process.exit(fails ? 1 : 0);
