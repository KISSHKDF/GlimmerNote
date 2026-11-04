/* 拾光小册 · 批次 4 界面「原图并排 + 区域高亮」的**真实浏览器 DOM** 级判据
 *
 * 为什么要有这一条（2026-11-04 真机看出问题后补）：
 *   批次 4 的 `neg-v2-review-sidebyside.cjs` 只证了两件事 ——
 *     ① `生成状态.mjs` 把 `_原卷台账.json` 的 `regions[]` 递给了**卡**（`origRegions`）；
 *     ② `pending.js` 的源码里有 `S.roleClass(r.role)` / `S.regionPx(r, img)` 这些**字样**。
 *   它**没证**"待办那条路上真能拿到区域"。真机一看：待办条目只有 `origPage/origBox`（旧红框），
 *   区域挂在**卡**上 ⇒ 界面静默退化成"红框对准（无角色记录）"，1 个框、0 个角色标签。
 *   教训：源码级接线断言挡不住"数据没接上"。所以这一条**真起服务端 + 真开无头浏览器**，
 *   把渲染后的 DOM 抓下来数框、数标签、看来源。
 *
 * 判据（全部机检）：
 *   ① 有待办时并排块在场（`.pd-pair` / `.pair-orig` / `.pair-ev`）
 *   ② **区域框 = 2 个**，角色类分别是 `r-err`（错误位置）与 `r-cond`（公共条件）
 *   ③ 角色标签 = 2 个，且**没有**"无角色记录"那个退化标签
 *   ④ `data-region-from` 写明区域来自**关联卡**（来源必须显示出来，不许静默）
 *   ⑤ 候选修订块在场（`.pd-review` + `[data-rvload]` 按钮）
 *   ⑥ 阴性对照：把卡上的 `regions` 去掉 ⇒ 必须退化成 1 个 `r-other` 框 + "无角色记录"标签
 *      （证明判据分得清"有区域"与"没区域"，不是恒真）
 *
 * 环境：需要 Edge（无头）+ 本机端口。缺 Edge 或服务端起不来 ⇒ 打印 `RESULT=SKIP(原因)` 并 exit 0
 * （本仓 SKIP 约定）。只写 %TEMP% 夹具，不碰真库、不碰运行区。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

const E = require('./_测试环境.cjs');
const ROOT = E.REPO;

let pass = 0, fail = 0;
const A = (name, ok, detail) => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? '  → ' + detail : ''));
  ok ? pass++ : fail++;
};
function skip(why) { console.log('RESULT=SKIP(' + why + ')'); process.exit(0); }
const edgePath = () => ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/* ── 最小 PNG（8bit 灰度；够 _图尺寸 读头、够浏览器显示） ── */
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC_T[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (t, d) => { const T = Buffer.from(t, 'ascii'); const L = Buffer.alloc(4); L.writeUInt32BE(d.length, 0); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(Buffer.concat([T, d])), 0); return Buffer.concat([L, T, d, C]); };
function png(w, h, bars) {
  const raw = Buffer.alloc((w + 1) * h, 0xFF);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  const px = (x, y, v) => { if (x >= 0 && x < w && y >= 0 && y < h) raw[y * (w + 1) + 1 + x] = v; };
  for (const b of bars) for (let y = b.y; y < b.y + (b.th || 3); y++) for (let x = b.x; x < b.x + b.w; x++) px(x, y, 30);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const PORT_RE = /http:\/\/127\.0\.0\.1:(\d+)/;

/** 造一个临时库（可选：卡上带不带 regions）；返回 {lib, cleanup} */
function makeLib(tag, withRegions) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pairdom-' + tag + '-'));
  const W = 620, H = 860;
  const page = png(W, H, [{ x: 40, y: 100, w: 520 }, { x: 40, y: 380, w: 300 }, { x: 70, y: 410, w: 140 }, { x: 150, y: 640, w: 200 }]);
  const sha = crypto.createHash('sha256').update(page).digest('hex');
  fs.mkdirSync(path.join(lib, '_收件箱', '合成'), { recursive: true });
  fs.writeFileSync(path.join(lib, '_收件箱', '合成', '整页.png'), page);
  const cardDir = path.join(lib, '学生A', '物理', 'P9001-合成卡');
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(path.join(cardDir, '原卷截图.png'), png(300, 120, [{ x: 10, y: 20, w: 260 }]));
  fs.writeFileSync(path.join(cardDir, '错题记录.md'), '# P9001\n\n（夹具）\n', 'utf8');
  fs.writeFileSync(path.join(cardDir, '题干.html'), '<div>夹具</div>', 'utf8');
  fs.writeFileSync(path.join(lib, '学生A', '物理', '_索引.json'), JSON.stringify({
    student: '学生A', grade: '九年级', items: [{ id: 'P9001', dir: 'P9001-合成卡', status: '在册' }],
  }, null, 1), 'utf8');
  const rec = { page: '_收件箱/合成/整页.png', box: [40, 380, 300, 90], by: '人' };
  if (withRegions) {
    rec.regions = [
      { role: '错误位置', x: 0.0645, y: 0.4419, w: 0.4839, h: 0.1047, pageSha: sha, imgW: W, imgH: H },
      { role: '公共条件', x: 0.0645, y: 0.1023, w: 0.8710, h: 0.1744, pageSha: sha, imgW: W, imgH: H },
    ];
  }
  fs.writeFileSync(path.join(lib, '_原卷台账.json'), JSON.stringify({ version: 1, cards: { '学生A|P9001': rec } }, null, 1), 'utf8');
  const payload = '把第(2)小题的判罚口径改成：硫酸铝应为 Al₂(SO₄)₃';
  const digest = crypto.createHash('sha256').update(payload.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  fs.writeFileSync(path.join(lib, '_待确认.json'), JSON.stringify({
    note: '夹具', seq: 1, items: [{
      id: 'T900', student: '学生A', subject: '物理', cardId: 'P9001', kind: '卷面辨认', ask: '原卷',
      q: '这一处错在哪？', detail: '夹具', status: '未确认', raisedAt: '2026-11-04',
      evidence: '学生A/物理/P9001-合成卡/原卷截图.png', box: [10, 20, 280, 90],
      origPage: '_收件箱/合成/整页.png', origBox: [0.0645, 0.4419, 0.4839, 0.1047],
      candidates: [{ candId: 'c-' + digest.slice(0, 12), at: '2026-11-04', kind: '卡', target: 'P9001', payload, payloadDigest: digest, status: '待采用', adoptedAt: null }],
      revisions: [],
    }],
  }, null, 1), 'utf8');
  return lib;
}

async function dumpDom(lib, edge) {
  /* 状态包先生成（服务端不会替一个还没有 _状态.json 的库兜底 —— 见批次 5 报告里的未结案） */
  const st = spawn(process.execPath, [E.tool('生成状态.mjs'), '--data', lib], { cwd: ROOT, encoding: 'utf8' });
  await new Promise((r) => st.on('close', r));
  const port = await freePort();
  const srv = spawn(process.execPath, [E.tool('_服务端.mjs')], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { CTB_PORT: String(port), CTB_DATA: lib }),
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d; });
  srv.stderr.on('data', (d) => { srvOut += d; });
  const stop = () => { try { srv.kill(); } catch { } };
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 30000) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) }); if (r.ok) { up = true; break; } } catch { }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) { stop(); return { ok: false, why: '服务端 30s 没起来：' + srvOut.slice(-300) }; }
  const domFile = path.join(lib, '_dom.html');
  const ud = path.join(lib, '_edge-profile');   // 每次用例自带 profile：不碰用户的 Edge 数据
  const p = spawn(edge, ['--headless=new', '--disable-gpu', '--window-size=1700,1400', '--virtual-time-budget=9000',
    '--user-data-dir=' + ud, '--dump-dom',
    'http://127.0.0.1:' + port + '/#pending'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let dom = '';
  p.stdout.on('data', (d) => { dom += d; });
  await new Promise((r) => { p.on('close', r); setTimeout(r, 45000); });
  fs.writeFileSync(domFile, dom, 'utf8');
  stop();
  return { ok: true, dom };
}

const boxesOf = (dom) => [...dom.matchAll(/<div class="pair-box ([a-z\-]+)"[^>]*style="([^"]*)"/g)].map((m) => ({ cls: m[1], style: m[2] }));
const chipsOf = (dom) => [...dom.matchAll(/<span class="rp-chip ([a-z\-]+)"[^>]*>([^<]*)</g)].map((m) => ({ cls: m[1], text: m[2] }));

(async () => {
  const edge = edgePath();
  if (!edge) skip('本机没有 Edge/Chrome，无法做 DOM 级验证');

  console.log('═══ ① 卡上**有**区域：待办并排必须画出 2 个带角色的框 ═══');
  const lib1 = makeLib('yes', true);
  const r1 = await dumpDom(lib1, edge);
  if (!r1.ok) skip(r1.why);
  const dom1 = r1.dom;
  A('①a 并排块在场（.pd-pair / .pair-orig / .pair-ev）',
    /class="pd-pair"/.test(dom1) && /class="pair-orig"/.test(dom1) && /class="pair-ev"/.test(dom1),
    'pd-pair=' + (dom1.match(/class="pd-pair"/g) || []).length + ' orig=' + (dom1.match(/class="pair-orig"/g) || []).length);
  const b1 = boxesOf(dom1), c1 = chipsOf(dom1);
  A('①b ★区域框 = 2 个，且角色类是 r-err（错误位置）+ r-cond（公共条件）',
    b1.length === 2 && b1.some((b) => b.cls === 'r-err') && b1.some((b) => b.cls === 'r-cond'),
    JSON.stringify(b1));
  A('①c ★区域框带百分比坐标（说明真的按归一化换算过，不是空壳）',
    b1.every((b) => /left:\s*[\d.]+%/.test(b.style) && /width:\s*[\d.]+%/.test(b.style)),
    b1.map((b) => b.style).join(' | '));
  A('①d ★角色标签 = 2 个（错误位置/公共条件），且**没有**"无角色记录"退化标签',
    c1.length === 2 && c1.some((c) => c.text === '错误位置') && c1.some((c) => c.text === '公共条件') &&
    !c1.some((c) => /无角色记录/.test(c.text)),
    JSON.stringify(c1));
  A('①e ★区域来源显示为"关联卡"（来源必须可见，不许静默）',
    /data-region-from="关联卡 学生A·P9001"/.test(dom1),
    (dom1.match(/data-region-from="[^"]*"/) || ['（无）'])[0]);
  A('①f 候选修订块在场且带「查候选修订」按钮',
    /class="pd-review"/.test(dom1) && /data-rvload="T900"/.test(dom1),
    'pd-review=' + (dom1.match(/class="pd-review"/g) || []).length);

  console.log('\n═══ ② 阴性对照：卡上**没有**区域 ⇒ 必须退化成 1 个 r-other + "无角色记录" ═══');
  const lib2 = makeLib('no', false);
  const r2 = await dumpDom(lib2, edge);
  if (!r2.ok) skip(r2.why);
  const b2 = boxesOf(r2.dom), c2 = chipsOf(r2.dom);
  A('②a ★没有区域时只画 1 个 r-other 框（旧红框路），不假装有角色',
    b2.length === 1 && b2[0].cls === 'r-other' && c2.length === 1 && /无角色记录/.test(c2[0].text),
    JSON.stringify({ boxes: b2, chips: c2 }));
  A('②b 来源显示为"（无）"（说明查过卡、卡上没有区域，而不是没查）',
    /data-region-from="（无）"/.test(r2.dom),
    (r2.dom.match(/data-region-from="[^"]*"/) || ['（无）'])[0]);

  /* 清理 */
  for (const d of [lib1, lib2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  console.log('\nRESULT=' + (fail ? 'FAIL(' + fail + ')' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
  process.exit(fail ? 1 : 0);
})();
