#!/usr/bin/env node
/**
 * 拾光小册 · R9 阴性对照：WebView2 依赖必须有「受控预期哈希」才准落盘（2026-11-02 建）
 *
 * 事故（外部复核 A4：亲自复现 + 源码确认）：
 *   `scripts\fetch-deps.ps1` 改前 nupkg 与 DLL 的 SHA256 都是**取得之后**才算，唯一的比对对象是
 *   脚本自己上一次写的 `vendor\webview2\DEPS.json`（而 `vendor/` 被 `.gitignore` 忽略、不入库）⇒
 *   只能发现"后续被篡改"，验不了"第一次取到的到底是不是官方那一份"。
 *   实测：内容任意的 715 字节伪包（结构对）两次都打印 `✔ 依赖就位`、exit 0，并把伪造值的哈希
 *   如实写进锁文件；全仓 tracked 文件里 `git grep -nE '[0-9A-Fa-f]{64}'` = 0 命中（无外部锚点）。
 *
 * 修法（R9）：
 *   ① 新增 `src\shell\webview2-deps.lock.json`（**入 git**，唯一外部锚点）：nupkg 与 3 个 DLL 的
 *      受控预期 sha256 / 字节数 / 包内路径；
 *   ② `fetch-deps.ps1`：锁文件缺失或读不懂 → fail-closed 并给出获取途径；**解包前**比 nupkg；
 *      先解到 `%TEMP%` 暂存区，**解包后**逐个比 DLL 的字节数与 sha256；全部通过才搬进 `vendor\`；
 *      `-LocalNupkg` 走**完全相同**的规则；
 *   ③ 幂等早退也比锁文件的预期值（不再比脚本自己写的 DEPS.json）。
 *
 * 本用例的牙齿（全部在 `%TEMP%` 自建沙箱里真跑 `fetch-deps.ps1`；**绝不联网**、绝不碰真 `vendor\`）：
 *   ① 伪包（结构对、哈希错）+ 真锁 → 必须 exit≠0，且 vendor\ 里预置的 DLL **一个字节都不变**、
 *      不多出任何文件（尤其不许留下 DEPS.json）；
 *   ② "nupkg 哈希对、DLL 哈希错"的锁 → 必须红（证明**解包后**那道校验真在跑，不是只有包级校验）；
 *   ③ 锁文件被篡改一个字符（nupkg 值 / DLL 值各一次）→ 必须红；
 *   ④ 锁文件缺失 → 必须 exit≠0，且输出给出恢复途径（`checkout -- src/shell/webview2-deps.lock.json`）；
 *   ⑤ 正对照：合成包 + 与它一致的合成锁 → exit 0，三个 DLL 逐字节落地，DEPS.json 形状如实；
 *   ⑥ 幂等早退：三个 DLL 与锁一致时再跑一次（**不给** `-LocalNupkg`）必须"跳过下载"、exit 0；
 *   ⑦ **阴性自证**：把两处 `-ne` 判据掏成 `$false` ⇒ 同一个伪包必须被**接受**（exit 0 且 DLL 落地）。
 *      没有这一条，前面所有"必须红"都不知道是不是因为别的原因红的。
 *
 * ⚠ 本用例不读用户库、不需要 exe、不需要发布包 —— 只读仓内两个文件 + 自建 %TEMP% 夹具。
 * 用法：node tests\neg-deps-lock.cjs
 * 退出码：0=PASS（含阴性自证）/ 1=FAIL；0 也可能是"可见 SKIP"（本机没有 PowerShell）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FETCH = path.join(REPO, 'scripts', 'fetch-deps.ps1');
const LOCK = path.join(REPO, 'src', 'shell', 'webview2-deps.lock.json');
/* 壳真正需要的三份 + 它们在官方 nupkg 里的路径（清单与本用例的判据同源） */
const REQUIRED = [
  ['Microsoft.Web.WebView2.Core.dll', 'lib/net462/Microsoft.Web.WebView2.Core.dll'],
  ['Microsoft.Web.WebView2.WinForms.dll', 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'],
  ['WebView2Loader.dll', 'runtimes/win-x64/native/WebView2Loader.dll'],
];

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

/* ── 极简 ZIP 写入器（store 方式，零依赖）─────────────────────────────────
   为什么自己写：伪包的判据是"**结构对**、哈希错"，所以夹具必须是一个真能被
   .NET `ZipFile.OpenRead` 读开、且条目路径正确的 nupkg。本仓零 npm 依赖（红线），
   不引 zip 库；store 方式不需要压缩实现，只需要 CRC32。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/** entries: [{name, data:Buffer}] → 一个 store 方式的 .zip/.nupkg Buffer */
function zipStore(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // flags：文件名为 UTF-8
    lh.writeUInt16LE(0, 8);         // method 0 = store
    lh.writeUInt16LE(0, 10);        // mod time
    lh.writeUInt16LE(0x21, 12);     // mod date = 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);        // extra length
    locals.push(lh, nameBuf, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // version made by
    ch.writeUInt16LE(20, 6);        // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);        // extra
    ch.writeUInt16LE(0, 32);        // comment
    ch.writeUInt16LE(0, 34);        // disk
    ch.writeUInt16LE(0, 36);        // internal attrs
    ch.writeUInt32LE(0, 38);        // external attrs
    ch.writeUInt32LE(offset, 42);   // local header offset
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

const sha256Buf = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const sha256File = p => sha256Buf(fs.readFileSync(p));

/* ── PowerShell 是硬依赖（被测对象就是 .ps1）。缺了就**可见 SKIP**，绝不静默当通过 ──
 *
 * ⚠ 环境坑（2026-11-02 本机实测，与"被测脚本"无关，是宿主串味）：
 *   从 **PowerShell 7** 里 `node tests\…` 时，子进程环境里的 `PSModulePath` 带着 PS7 自己的
 *   模块目录；Windows PowerShell 5.1 会被它带着先撞上 PS7 版的 `Microsoft.PowerShell.Utility`
 *   （二进制模块，5.1 加载不了），于是 **`Get-FileHash` 这类 cmdlet 整个不可用**。
 *   实测：`spawnSync('powershell', …, {env: 继承})` → `Get-Command Get-FileHash` = False 且
 *   `fetch-deps.ps1` 报 `CommandNotFoundException`；把 `PSModulePath` 换成 5.1 自己的三档目录
 *   → True、脚本正常。从 pwsh 直接 `& powershell` 不会踩到（PS7 会替下位引擎把该变量摆正）。
 *   所以本用例：**先用继承环境探一次**，探不通才改用 5.1 的模块路径并在输出里显式说明 ——
 *   不去掩盖环境差异，也不让一个与被测对象无关的宿主问题把门禁判红。 */
function probeFileHash(env) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-Command Get-FileHash -ErrorAction SilentlyContinue) -ne $null'], { encoding: 'utf8', env });
  return r.status === 0 && String(r.stdout || '').trim() === 'True';
}
const PS_ENV_NORMALIZED = Object.assign({}, process.env, {
  PSModulePath: [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell', 'Modules'),
    path.join(process.env.USERPROFILE || '', 'Documents', 'WindowsPowerShell', 'Modules'),
  ].join(';'),
});
let PS_ENV = process.env;
if (!probeFileHash(PS_ENV) && probeFileHash(PS_ENV_NORMALIZED)) {
  PS_ENV = PS_ENV_NORMALIZED;
  console.log('[INFO] 继承来的 PSModulePath 让 Windows PowerShell 5.1 找不到 Get-FileHash（宿主串味，' +
    '非被测脚本问题）；本用例改用 5.1 自己的模块路径。');
}
if (!probeFileHash(PS_ENV)) {
  console.log('[SKIP] 本机没有可用的 powershell（或 5.1 缺 Microsoft.PowerShell.Utility），' +
    '无法真跑 fetch-deps.ps1 —— 这是可见跳过，不是通过。');
  console.log('RESULT=SKIP(no-powershell) 断言=0');
  process.exit(0);
}

/* PowerShell 5.1 往重定向管道写中文时用的是控制台代码页（本机 GBK），按 utf8 解会出替换字符。
   判据尽量只依赖**退出码 / 文件系统 / ASCII 串（哈希、路径、命令）**，解码只为可读性兜底。 */
function decodePS(buf) {
  const u = buf.toString('utf8');
  if (!/\uFFFD/.test(u)) return u;
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return u; }
}

const REAL_LOCK_TEXT = fs.readFileSync(LOCK, 'utf8');

/* ── 沙箱 ──────────────────────────────────────────────────────────────── */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-deps-'));
const vendorOf = root => path.join(root, 'vendor', 'webview2');

/** 造一个"只差哈希"的假仓库：scripts\fetch-deps.ps1 + src\shell\webview2-deps.lock.json */
function makeRepo(tag, lockTextOrNull) {
  const root = path.join(base, tag);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'shell'), { recursive: true });
  fs.mkdirSync(vendorOf(root), { recursive: true });
  fs.copyFileSync(FETCH, path.join(root, 'scripts', 'fetch-deps.ps1'));
  /* ★ 2026-11-02 R21：`fetch-deps.ps1` 开头现在会 dot-source `scripts\_PS环境.ps1`
     （5.1 宿主环境自愈）。假仓库必须**照真仓拓扑**一起放进去，否则跑的是"缺文件降级"
     那条支路（会打一句可见告警后继续），测不到真实链路。 */
  const psEnv = path.join(REPO, 'scripts', '_PS环境.ps1');
  if (fs.existsSync(psEnv)) fs.copyFileSync(psEnv, path.join(root, 'scripts', '_PS环境.ps1'));
  if (lockTextOrNull !== null && lockTextOrNull !== undefined) {
    fs.writeFileSync(path.join(root, 'src', 'shell', 'webview2-deps.lock.json'), lockTextOrNull, 'utf8');
  }
  return root;
}
/** 目标目录里预置三个"哨兵"DLL：跑到一半失败时它们必须**逐字节不变** */
const SENTINELS = {};
for (const [n] of REQUIRED) SENTINELS[n] = Buffer.from('SENTINEL-MUST-NOT-BE-TOUCHED:' + n + '\n', 'utf8');
function seedVendor(root) {
  for (const [n] of REQUIRED) fs.writeFileSync(path.join(vendorOf(root), n), SENTINELS[n]);
}
function vendorListing(root) {
  const d = vendorOf(root);
  return fs.readdirSync(d).sort().map(n => n + ':' + fs.statSync(path.join(d, n)).size).join(',');
}
function runFetch(root, args) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts', 'fetch-deps.ps1'), ...args],
  { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, env: PS_ENV });
  const out = decodePS(Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]));
  return { code: r.status == null ? -1 : r.status, out };
}

try {
  /* ═══════════ 0) 真仓锁文件的形状（静态判据） ═══════════ */
  let lock = null;
  try { lock = JSON.parse(REAL_LOCK_TEXT); } catch (e) { /* 下面统一报错 */ }
  A('仓内锁文件存在且是合法 JSON（src\\shell\\webview2-deps.lock.json）', !!lock,
    lock ? '' : '解析失败');
  if (!lock) { console.log('\nRESULT=FAIL(' + worst + ') 断言=' + passed); process.exit(1); }

  A('锁文件字段齐全（package / version / source / nupkgSha256 / files / note）',
    ['package', 'version', 'source', 'nupkgSha256', 'files', 'note'].every(k => lock[k] !== undefined),
    Object.keys(lock).join(','));
  A('锁文件声明的是官方 NuGet 源（https://api.nuget.org/…）且路径含版本号',
    /^https:\/\/api\.nuget\.org\//.test(String(lock.source)) && String(lock.source).includes(String(lock.version)),
    String(lock.source));
  A('锁文件 nupkgSha256 是 64 位十六进制',
    /^[0-9A-Fa-f]{64}$/.test(String(lock.nupkgSha256)), String(lock.nupkgSha256));
  const lockFiles = Array.isArray(lock.files) ? lock.files : [];
  A('锁文件 files[] 恰好登记壳需要的三份（name 与包内 from 路径都对得上）',
    lockFiles.length === REQUIRED.length &&
    REQUIRED.every(([n, from]) => lockFiles.some(f => f.name === n && f.from === from)),
    lockFiles.map(f => f.name).join('、'));
  A('锁文件每个文件的 sha256 是 64 位十六进制、bytes 是正整数',
    lockFiles.length > 0 && lockFiles.every(f => /^[0-9A-Fa-f]{64}$/.test(String(f.sha256)) &&
      Number.isInteger(f.bytes) && f.bytes > 0),
    lockFiles.map(f => f.name + '=' + f.bytes).join('、'));
  A('锁文件 note 写明"改版本必须同步更新 + 必须重新核对官方包哈希"',
    /改版本必须同步更新/.test(String(lock.note)) && /核对官方包/.test(String(lock.note)),
    String(lock.note).slice(0, 40) + '…');

  const fetchSrc = fs.readFileSync(FETCH, 'utf8');
  A('脚本真的读受控清单，且幂等判据比的是**锁文件**的预期值（不再比脚本自己写的 DEPS.json）',
    fetchSrc.includes('webview2-deps.lock.json') &&
    fetchSrc.includes('(HashOf $p) -ne $w.sha256)') &&
    !fetchSrc.includes('foreach ($f in $deps.files)'),
    '');

  /* ═══════════ 夹具：合成包 + 合成锁 ═══════════ */
  const synData = REQUIRED.map(([n], i) => Buffer.from(
    'SYNTHETIC-DLL-' + i + '-' + n + '\n' + 'x'.repeat(500 + i * 37) + '\n', 'utf8'));
  const synNupkg = zipStore(REQUIRED.map(([, from], i) => ({ name: from, data: synData[i] })));
  const synPkgPath = path.join(base, 'syn.nupkg');
  fs.writeFileSync(synPkgPath, synNupkg);
  const synLock = (over) => {
    const o = over || {};
    return JSON.stringify({
      package: 'Microsoft.Web.WebView2',
      version: '1.0.2903.40',
      source: 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.2903.40/microsoft.web.webview2.1.0.2903.40.nupkg',
      nupkgSha256: o.nupkgSha256 !== undefined ? o.nupkgSha256 : sha256Buf(synNupkg),
      files: REQUIRED.map(([n, from], i) => ({
        name: n, bytes: synData[i].length, from,
        sha256: (o.fileSha && o.fileSha[i]) ? o.fileSha[i] : sha256Buf(synData[i]),
      })),
      note: '测试合成清单：改版本必须同步更新，且必须重新核对官方包哈希。',
    }, null, 2);
  };
  const synLockObj = JSON.parse(synLock());

  /* 伪包：结构对（条目路径正确）、内容任意 → 任何真实/受控哈希都对不上 */
  const fakeData = REQUIRED.map(([n]) => Buffer.from('FAKE-NOT-THE-OFFICIAL-BINARY:' + n, 'utf8'));
  const fakeNupkg = zipStore(REQUIRED.map(([, from], i) => ({ name: from, data: fakeData[i] })));
  const fakePath = path.join(base, 'fake.nupkg');
  fs.writeFileSync(fakePath, fakeNupkg);

  /* ═══════════ ⑤ 正对照：合成包 + 一致的合成锁 → 必须成功落地 ═══════════ */
  const okRoot = makeRepo('ok', synLock());
  const okRun = runFetch(okRoot, ['-LocalNupkg', synPkgPath]);
  A('正对照 · 包与受控清单一致时正常落地（exit 0）', okRun.code === 0,
    'exit=' + okRun.code + ' ｜ ' + okRun.out.trim().split('\n').slice(-3).join(' / '));
  A('正对照 · 三个 DLL 逐字节等于包内字节',
    REQUIRED.every(([n], i) => {
      const p = path.join(vendorOf(okRoot), n);
      return fs.existsSync(p) && Buffer.compare(fs.readFileSync(p), synData[i]) === 0;
    }), '');
  let okDeps = null;
  try { okDeps = JSON.parse(fs.readFileSync(path.join(vendorOf(okRoot), 'DEPS.json'), 'utf8')); } catch (e) { }
  A('正对照 · DEPS.json 仍是运行时记录且形状不变（package/version/source/nupkgSha256/fetchedAt/note/files[name,bytes,sha256,from]）',
    !!okDeps && ['package', 'version', 'source', 'nupkgSha256', 'fetchedAt', 'note', 'files'].every(k => okDeps[k] !== undefined) &&
    okDeps.files.length === REQUIRED.length &&
    okDeps.files.every(f => ['name', 'bytes', 'sha256', 'from'].every(k => f[k] !== undefined)),
    okDeps ? Object.keys(okDeps).join(',') : '读不出 DEPS.json');
  A('正对照 · DEPS.json 记录的哈希与受控清单一致（记录如实，但记录不是判据）',
    !!okDeps && okDeps.files.every(f => {
      const want = synLockObj.files.find(x => x.name === f.name);
      return want && String(f.sha256).toUpperCase() === String(want.sha256).toUpperCase();
    }), '');

  /* ═══════════ ⑥ 幂等早退：包已就位（与锁一致）时不给 -LocalNupkg 必须"跳过下载" ═══════════ */
  const idemOk = REQUIRED.every(([n], i) => {
    const p = path.join(vendorOf(okRoot), n);
    return fs.existsSync(p) && sha256File(p) === sha256Buf(synData[i]);
  });
  if (idemOk) {
    const idemRun = runFetch(okRoot, []);
    /* 判据用 ASCII 串：进入下载分支时脚本一定会打印 `来源：<source>`（合成清单里 source 是
       api.nuget.org 的 URL），没打印就证明它走了幂等早退、根本没碰网络。 */
    A('幂等早退 · 已就位且与受控清单一致时不给 -LocalNupkg 必须走"跳过下载"（不联网）',
      idemRun.code === 0 && !idemRun.out.includes('api.nuget.org'),
      'exit=' + idemRun.code + ' ｜ ' + idemRun.out.trim().split('\n').slice(-2).join(' / '));
    A('幂等早退 · 已就位分支没有改写 DLL（字节不变）',
      REQUIRED.every(([n], i) => Buffer.compare(fs.readFileSync(path.join(vendorOf(okRoot), n)), synData[i]) === 0), '');
  } else {
    A('幂等早退 · 前置检查（DLL 与受控清单一致）', false, '正对照落地后哈希对不上，后续断言无法进行');
  }

  /* ═══════════ ① 伪包 + 真锁 → 必须红，且 vendor\ 一个字节都不动 ═══════════ */
  const f1 = makeRepo('fake-real-lock', REAL_LOCK_TEXT);
  seedVendor(f1);
  const before1 = vendorListing(f1);
  const r1 = runFetch(f1, ['-LocalNupkg', fakePath]);
  A('① 伪包（结构对、哈希错）必须 exit≠0', r1.code !== 0, 'exit=' + r1.code);
  A('① 失败时 vendor\\ 里预置的 DLL 逐字节不变（不合格文件不许留下/改坏）',
    before1 === vendorListing(f1) &&
    REQUIRED.every(([n]) => Buffer.compare(fs.readFileSync(path.join(vendorOf(f1), n)), SENTINELS[n]) === 0), before1);
  A('① 失败时没有留下 DEPS.json（没通过校验就不许记"取到了"）',
    !fs.existsSync(path.join(vendorOf(f1), 'DEPS.json')), '');
  A('① 报错里给出受控预期值（能对证，不是一句"失败了"）',
    r1.out.includes(String(lock.nupkgSha256).toUpperCase()), '');

  /* ═══════════ ② nupkg 哈希对、DLL 哈希错 → 必须红（解包后那道校验真在跑） ═══════════ */
  const wrongDllHash = 'A'.repeat(64);
  const f2 = makeRepo('dll-hash-wrong', synLock({ fileSha: [wrongDllHash, null, null] }));
  seedVendor(f2);
  const before2 = vendorListing(f2);
  const r2 = runFetch(f2, ['-LocalNupkg', synPkgPath]);
  A('② nupkg 哈希对但 DLL 哈希错必须 exit≠0（解包前后各校验一次，不是只有包级校验）',
    r2.code !== 0, 'exit=' + r2.code);
  A('② 这一红确实来自 DLL 那一道（报错里出现被篡改的受控预期值）',
    r2.out.includes(wrongDllHash), '');
  A('② 失败时 vendor\\ 未被写（预置 DLL 不变、无新文件）', before2 === vendorListing(f2), before2);

  /* ═══════════ ③ 锁文件被篡改一个字符 → 必须红（nupkg 值 / DLL 值各一次） ═══════════ */
  const tamper = (s, i) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);
  const t1Lock = synLock({ nupkgSha256: tamper(sha256Buf(synNupkg), 10) });
  const f3 = makeRepo('lock-tamper-nupkg', t1Lock);
  seedVendor(f3);
  const before3 = vendorListing(f3);
  const r3 = runFetch(f3, ['-LocalNupkg', synPkgPath]);
  A('③ 锁文件的 nupkgSha256 被改一个字符 → 必须 exit≠0', r3.code !== 0, 'exit=' + r3.code);
  A('③ 该失败发生在**解包前**（没有解出任何文件：vendor\\ 不变）', before3 === vendorListing(f3), before3);

  const goodLockObj = JSON.parse(synLock());
  const t2Lock = synLock({ fileSha: [null, tamper(goodLockObj.files[1].sha256, 20), null] });
  const f4 = makeRepo('lock-tamper-dll', t2Lock);
  seedVendor(f4);
  const before4 = vendorListing(f4);
  const r4 = runFetch(f4, ['-LocalNupkg', synPkgPath]);
  A('③ 锁文件的 DLL sha256 被改一个字符 → 必须 exit≠0', r4.code !== 0, 'exit=' + r4.code);
  A('③ 该失败同样不落地任何文件（vendor\\ 不变）', before4 === vendorListing(f4), before4);

  /* ═══════════ ④ 锁文件缺失 → 必须 exit≠0 且给出获取途径 ═══════════ */
  const f5 = makeRepo('no-lock', null);
  seedVendor(f5);
  const before5 = vendorListing(f5);
  const r5 = runFetch(f5, ['-LocalNupkg', fakePath]);
  A('④ 锁文件缺失必须 exit≠0（fail-closed，不猜、不放过）', r5.code !== 0, 'exit=' + r5.code);
  A('④ 缺失时给出恢复途径（输出含 checkout -- src/shell/webview2-deps.lock.json）',
    r5.out.includes('checkout -- src/shell/webview2-deps.lock.json'), '');
  A('④ 缺失时也没有落地任何文件', before5 === vendorListing(f5), before5);

  /* ═══════════ ⑦ 阴性自证：掏掉两处 -ne 判据 ⇒ 伪包必须被接受 ═══════════ */
  const NEUTER_FROM = 'if ($got -ne $expected) {';
  const hits = fetchSrc.split(NEUTER_FROM).length - 1;
  A('⑦ 前置 · 校验闸门的比对点（AssertSha256 / AssertBytes）在源码里确实是 2 处',
    hits === 2, 'occurrences=' + hits);
  const neutered = fetchSrc.split(NEUTER_FROM).join('if ($false) {');
  const nRoot = makeRepo('neutered', REAL_LOCK_TEXT);
  fs.writeFileSync(path.join(nRoot, 'scripts', 'fetch-deps.ps1'), neutered, 'utf8');
  const rN = runFetch(nRoot, ['-LocalNupkg', fakePath]);
  A('⑦ 阴性自证 · 掏掉校验后同一个伪包**必须被接受**（exit 0）—— 证明①的红是这道闸门造成的',
    rN.code === 0, 'exit=' + rN.code + ' ｜ ' + rN.out.trim().split('\n').slice(-2).join(' / '));
  A('⑦ 阴性自证 · 掏掉校验后伪包的字节真的落进了 vendor\\（= 改前的缺陷形态）',
    REQUIRED.every(([n], i) => {
      const p = path.join(vendorOf(nRoot), n);
      return fs.existsSync(p) && Buffer.compare(fs.readFileSync(p), fakeData[i]) === 0;
    }), '');
  A('⑦ 阴性自证 · 对照：未掏掉校验的那一份（①）对同一个伪包是红的，不是环境问题',
    r1.code !== 0 && rN.code === 0, 'original exit=' + r1.code + ' neutered exit=' + rN.code);
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { }
}

console.log('\n（全部夹具自建在 %TEMP%，已清理；真 vendor\\ 与真运行区未参与）');
console.log('RESULT=' + (worst ? 'FAIL(' + worst + ')' : 'PASS') + ' 断言=' + (passed + worst));
process.exit(worst ? 1 : 0);
