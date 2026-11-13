#!/usr/bin/env node
/**
 * 原卷台账 · `导入历史 --from`（2026-11-06 新增命令）阴性对照。
 *
 * 它解决什么：2026-11-01 库根换目录（换盘）之后，当前库有一批卡只剩裁图、台账 `page` 为空；
 * 而**老库台账还在**（冻结库/备份系列），记着这些卡当初的整页与归一化框。
 * 这条链一旦放松，坏处是"凭一份来路不明的 JSON 就往真源里写路径"——
 * 那正是本仓最忌讳的形态（假 page 比"未定位"危害大）。所以每条硬约束都必须**能红**：
 *   ① 逐条自证：历史 page 归一化后必须"在盘 或 能被三层兜底找回"，否则**不许导入**；
 *   ② 全键命中：`学生|卡号` 必须都在库里（卡号跨学生会撞号），库内没这张卡就不许建条目；
 *   ③ 框以卡自己的裁图记录为准：与历史框冲突时取裁图记录，且**报出来**（不静默二选一）；
 *   ④ `--dry` 必须一个字节都不写（用 write ledger 的 sha 前后比对自证）；
 *   ⑤ 幂等：已有 page 的条目默认跳过。
 *
 * 退出码 0=全部成立；1=有判据守不住。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = require('./_测试环境.cjs');

let fails = 0, total = 0;   /* ★ 2026-11-13：total 供 `断言=N` 对账用 */
const A = (n, ok, d) => { total++; console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

const LIB = E.allocTempDir('gn-ledger-hist-');
const TMP = E.allocTempDir('gn-ledger-histsrc-');
const run = (args) => {
  try {
    const out = execFileSync(process.execPath, [E.tool(args[0]), ...args.slice(1)], {
      encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CTB_DATA: LIB }),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(String(e.stdout || '') + String(e.stderr || '')) };
  }
};
const png = (w, h) => { const b = Buffer.alloc(64, 0); b.write('\x89PNG\r\n\x1a\n', 0, 'binary'); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const mk = (root, rel, buf) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const wj = (root, rel, obj) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8'); return p; };
const ledger = () => JSON.parse(fs.readFileSync(path.join(LIB, '_原卷台账.json'), 'utf8').replace(/^\uFEFF/, ''));
const ledSha = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(LIB, '_原卷台账.json'))).digest('hex');
const card = (k) => ledger().cards[k] || {};

/* ── 夹具 ── */
const CANON = '学生A/数学/原卷/批次2/p02.jpg';                  /* 规范路径：库里没有，保全家 `_原图\` 里有 */
const LEGACY = 'D:' + path.sep + '某老库' + path.sep + '错题本' + path.sep + CANON.split('/').join(path.sep);
const B_REC = [0.5, 0.5, 0.2, 0.1];                             /* 卡目录裁图记录的框（权威） */
const B_HIST = [0.1, 0.2, 0.3, 0.4];                            /* 历史台账的框（与上面冲突） */
const PAGE_BYTES = png(2024, 2940);

/* ★ 2026-11-06（P10）：字节放**保全家** `_原图\`（`_影像备份\` 已退休）。
   用真工具入库（唯一实现：对象 + `_原图台账.json` 的 sources 一并就位），再把活路径删掉
   —— 那就是"规范路径不在盘、字节还在"的真实现场。 */
function putInStore() {
  mk(LIB, CANON, PAGE_BYTES);
  const r = run(['_原图.mjs', '入库', CANON]);
  if (r.code !== 0) throw new Error('夹具：入库失败 ' + r.out.slice(0, 200));
  fs.unlinkSync(path.join(LIB, CANON));
}

wj(LIB, '学生A/数学/_索引.json', {
  student: '学生A', grade: '七年级', subject: '数学',
  items: [
    { id: 'M0001', dir: 'M0001-测试', title: '有历史可导', question: 'q', answer: 'a' },
    { id: 'M0002', dir: 'M0002-测试', title: '历史页也找不回', question: 'q', answer: 'a' },
  ],
});
mk(LIB, '学生A/数学/M0001-测试/原卷截图.jpg', png(300, 80));
wj(LIB, '学生A/数学/M0001-测试/_裁图记录.json', {
  src: '_收件箱/某批次/p01.jpg',                                /* 库内不存在、备份里也没有 */
  srcPx: '2024x2940', normBox: B_REC, scale: 2, out: '原卷截图.jpg',
});
mk(LIB, '学生A/数学/M0002-测试/原卷截图.jpg', png(300, 80));
putInStore();                                                    /* 历史 page 的字节在保全家 `_原图\` 里 */

const HIST = path.join(TMP, 'hist.json');
wj(TMP, 'hist.json', {
  version: 1,
  cards: {
    '学生A|M0001': { page: LEGACY, box: B_HIST, by: 'sidecar' },      /* 应导入；框冲突取裁图记录 */
    '学生A|M0002': { page: 'Z:' + path.sep + '根本不存在' + path.sep + 'x.jpg', box: null },  /* 找不到 ⇒ 不许导入 */
    '学生B|M0001': { page: LEGACY, box: null },                        /* 库里没有这张卡 ⇒ 不许建条目 */
  },
});

run(['_原卷台账.mjs', '生成']);          /* 建台账基线（两张卡都应是"待定位"） */
A('①a 基线：两张卡都还没定位', card('学生A|M0001').page === null && card('学生A|M0002').page === null,
  JSON.stringify([card('学生A|M0001').page, card('学生A|M0002').page]));

/* ════ ① --dry 必须一个字节都不写 ════ */
{
  const before = ledSha();
  const r = run(['_原卷台账.mjs', '导入历史', '--from', HIST, '--dry']);
  A('①b --dry 退出 0', r.code === 0, 'exit=' + r.code);
  A('①c --dry 自证"未变=true"', /未变=true/.test(r.out), (r.out.match(/DRY：.*/) || [''])[0].slice(0, 120));
  A('①d --dry 之后台账 sha 未变', ledSha() === before);
  A('①e --dry 之后该卡仍未导定位（没偷偷写）', card('学生A|M0001').page === null, String(card('学生A|M0001').page));
}

/* ════ ② 真导入：逐条自证 + 框取裁图记录 ════ */
{
  const r = run(['_原卷台账.mjs', '导入历史', '--from', HIST]);
  A('②a 退出 0', r.code === 0, 'exit=' + r.code);
  A('②b 报告"实际导入 1 张"（M0002 找不回、学生B 不在库，都不许导）', /实际导入 1 张/.test(r.out),
    (r.out.match(/实际导入.*/) || [''])[0]);
  const e = card('学生A|M0001');
  A('②c page = 规范相对路径', e.page === CANON, String(e.page));
  A('②d by = 手工·历史台账迁移', e.by === '手工·历史台账迁移', String(e.by));
  A('②e need = false（已经定位，不再挂"待定位"）', e.need === false, String(e.need));
  A('②f 框冲突时取卡目录裁图记录', Array.isArray(e.box) && e.box.every((v, i) => Math.abs(v - B_REC[i]) < 1e-9), JSON.stringify(e.box));
  A('②g 冲突被**报出来**（不静默二选一）', /框冲突 1 条/.test(r.out), (r.out.match(/.*框冲突.*/) || [''])[0].slice(0, 140));
  A('②h 字节落点写进 note（保全家 _原图\）', /保全库/.test(e.note || ''), String(e.note).slice(0, 140));
}

/* ════ ③ 找不到整页的历史条目：不许导入，且原因可见 ════ */
{
  const r = run(['_原卷台账.mjs', '导入历史', '--from', HIST]);
  A('③a M0002 仍为未定位', card('学生A|M0002').page === null, String(card('学生A|M0002').page));
  A('③b "未采纳明细"里点名 M0002', /学生A\|M0002/.test((r.out.match(/未采纳明细[\s\S]*/) || [''])[0].slice(0, 300)),
    (r.out.match(/学生A\|M0002.*/) || [''])[0].slice(0, 120));
  A('③c 幂等：再跑一次报告"已有 page 1"', /已有 page 1/.test(r.out), (r.out.match(/实际导入.*/) || [''])[0]);
}

/* ════ ④ 全键命中：库内没这张卡就不许建条目 ════ */
{
  A('④a 台账里没有被凭空造出的「学生B|M0001」', ledger().cards['学生B|M0001'] === undefined,
    JSON.stringify(ledger().cards['学生B|M0001'] || null));
}

/* ════ ⑤ 门禁接受它（规范路径不在盘，但字节在保全家 _原图\ 里 ⇒ 不是断链） ════ */
{
  const g = run(['_原卷台账.mjs', '门禁']);
  A('⑤a 我这张卡没被判成错误', !/✗\s*学生A\|M0001/.test(g.out), (g.out.match(/.*学生A\|M0001.*/) || [''])[0].slice(0, 120));
  A('⑤b 门禁把它算作"已从保全库按内容兜底"', /已从保全库按内容兜底\s*1\s*条/.test(g.out), (g.out.match(/门禁：.*/) || [''])[0].slice(0, 140));
}

/* ════ ⑥ 输入健壮性：坏输入必须显式失败（不许静默成功） ════ */
{
  const r1 = run(['_原卷台账.mjs', '导入历史', '--from', path.join(TMP, '不存在.json')]);
  A('⑥a 来源文件不存在 ⇒ exit 2', r1.code === 2, 'exit=' + r1.code);
  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, '{"cards": []}', 'utf8');
  const r2 = run(['_原卷台账.mjs', '导入历史', '--from', bad]);
  A('⑥b cards 不是对象 ⇒ exit 4（fail-closed，不猜）', r2.code === 4, 'exit=' + r2.code);
  const r3 = run(['_原卷台账.mjs', '导入历史']);
  A('⑥c 不给 --from ⇒ exit 2 + 用法', r3.code === 2 && /用法/.test(r3.out), 'exit=' + r3.code);
}

console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}  断言=${total}  失败=${fails}`);
process.exit(fails ? 1 : 0);
