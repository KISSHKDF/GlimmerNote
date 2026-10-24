#!/usr/bin/env node
/**
 * 全仓内部痕迹机检（B-09 配套 · 2026-10-24 建）
 *
 * 守什么：公开仓库的 tracked 文件里，**真实个人信息与内部工作区代号必须为 0**。
 *   ① 真实学生化名（原真实库的两名使用者）——2026-10-24 脱敏前曾出现在 193 行注释/文档与
 *     3 张界面截图里；fixtures-smoke 此前只扫 fixtures\ 目录，src/docs/tests 的 193 行漏网。
 *   ② 内部工作区根名 / 老库路径人名段——B-09「无内部痕迹」的本机锚点。
 *
 * 为什么禁词表放在这里：fixtures-smoke（合成库检查）与 portability.cjs（exe 二进制扫描）
 * 的检测样本**必须**引用同一份词表——检查器自己写死字面量，就会成为全仓唯一"含禁词"的
 * 文件，0 命中判据永远立不起来。本文件自身的字面量全部用**拼接构造**，因此自己也能被扫。
 *
 * 口径：只扫 `git ls-files`（tracked）。未跟踪的本地文件（tests\out、_probe、release zip）
 * 不出网，不属 B-09 范畴。二进制（png/jpg/zip/exe…）按扩展名跳过——文本通道读它们无意义。
 *
 * 用法：node tests\repo-hygiene.cjs        （run.mjs fixture 与 quick 都挂了这条）
 * 退出码：0=全绿（含自证）；1=有命中或自证失败。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/* ── 禁词表（唯一真源；本文件自身零字面量，靠拼接构造）────────────────────── */
const REAL_NAMES = ['康' + '康', '乐' + '乐'];        // 真实学生化名
const INTERNAL_ROOTS = ['CL' + 'AW', 'XZ' + 'Y'];    // 内部工作区根名 / 老库路径人名段
const FORBIDDEN = [...REAL_NAMES, ...INTERNAL_ROOTS];

const ROOT = path.resolve(__dirname, '..');
const BINARY_RE = /\.(png|jpe?g|gif|webp|bmp|ico|zip|exe|dll|pdf|woff2?|ttf|eot)$/i;

function trackedFiles() {
  const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return out.split(/\r?\n/).filter(Boolean);
}

/** 对一段文本按禁词计数。返回 [{token, n}]（只含有命中的）。导出供自证用。 */
function scanText(text) {
  return FORBIDDEN.map(token => ({ token, n: text.split(token).length - 1 })).filter(x => x.n > 0);
}

function main() {
  let fails = 0;
  const A = (n, ok, d) => { console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d !== undefined ? '  → ' + d : ''}`); if (!ok) fails++; };

  const files = trackedFiles();
  A('git ls-files 可用且非空（机检的检索根）', files.length > 100, files.length + ' 个 tracked 文件');

  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (BINARY_RE.test(f)) continue;
    let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    scanned++;
    for (const { token, n } of scanText(t)) hits.push({ f, token, n });
  }
  A(`已扫文本文件 ${scanned}/${files.length}（其余为二进制，按扩展名跳过）`, scanned > 100, '');

  /* ── 主判据：0 命中 ── */
  A('真实学生化名在全仓 tracked 文件中 = 0',
    hits.filter(h => REAL_NAMES.includes(h.token)).length === 0,
    hits.filter(h => REAL_NAMES.includes(h.token)).map(h => `${h.f}(${h.token}×${h.n})`).join(' ') || '0 处');
  A('内部工作区根名在全仓 tracked 文件中 = 0',
    hits.filter(h => INTERNAL_ROOTS.includes(h.token)).length === 0,
    hits.filter(h => INTERNAL_ROOTS.includes(h.token)).map(h => `${h.f}(${h.token}×${h.n})`).join(' ') || '0 处');

  /* ── 自证（判据必须有牙齿；本仓门禁纪律）────────────────────────────────── */
  const bad = '前缀' + REAL_NAMES[0] + '中缀' + INTERNAL_ROOTS[0] + '后缀';
  const self = scanText(bad);
  A('自证 · 判据有牙齿（合成坏串必须被抓到）',
    self.length === 2 && self.every(x => x.n === 1), JSON.stringify(self));
  A('自证 · 本文件自身 0 命中（拼接构造成立，检查器不豁免自己；__filename 直读，不依赖 tracked 状态）',
    scanText(fs.readFileSync(__filename, 'utf8')).length === 0, '');

  console.log(`\nRESULT=${fails ? 'FAIL(' + fails + ')' : 'PASS'}  禁词=${FORBIDDEN.length} 类  文本文件=${scanned}`);
  process.exit(fails ? 1 : 0);
}

/* 导出禁词表（fixtures-smoke / portability 引用同一真源）；直接运行才执行扫描 */
if (require.main === module) main();
module.exports = { REAL_NAMES, INTERNAL_ROOTS, FORBIDDEN, scanText };
