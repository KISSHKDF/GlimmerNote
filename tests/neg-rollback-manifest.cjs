#!/usr/bin/env node
/**
 * 拾光小册 · E04 阴性对照：一键回滚必须按落地内容重写部署清单（2026-10-31 建）
 *
 * 事故（外部复核已证实，沙箱实测）：
 *   `scripts\rollback.ps1:88-96` 只恢复 `app\`，全文件 107 行**零** `_deploy-manifest` 写入；
 *   而 `scripts\verify-deploy.mjs` 拿清单逐文件比对 ⇒
 *     deploy 0.0.1 → verify exit 0；deploy 0.0.2 → verify exit 0；
 *     **rollback → verify exit 1**（清单 0.0.2 / 实际 0.0.1 / 3 个文件被改过）。
 *   也就是说"一键回滚"这个**唯一被允许的线上回退手段**，每用一次都会让一致性门禁误红。
 *   而 `scripts\selftest-pipeline.ps1` 全文**不调用** verify-deploy ⇒ 自检恒绿，看不见这个缺陷。
 *   （`-Version` 那条路走 deploy.ps1，本来就会写清单，不受影响。）
 *
 * 修法（E04）：
 *   ① 清单写入抽成 `scripts\deploy-manifest.ps1` 的 `Write-DeployManifest`，deploy.ps1 与
 *      rollback.ps1 **共用一份**（两份实现必然漂移 → 清单是闸门的唯一依据 → 漂移 = 闸门失真）；
 *   ② rollback.ps1 在恢复 app\ 并校验版本之后，按**落地内容**重写清单（失败则连清单一起回退）；
 *   ③ selftest-pipeline.ps1 在两个回滚场景之后都跑一次 verify-deploy，并把失败记成断言红。
 *
 * 本用例的牙齿：
 *   ① 在 %TEMP% 沙箱里**真跑** rollback.ps1：断言 app\ 版本、清单版本、以及 verify-deploy exit 0；
 *   ② 阴性自证：把**修复前的回滚行为**原样搬进来（只恢复 app\、不碰清单）⇒ verify-deploy 必须 exit 1；
 *      这正是"回滚后清单版本 ≠ 落地版本"的最小复现；
 *   ③ 静态判据：rollback.ps1 真的调用共享函数、deploy.ps1 里不再有第二份内联清单实现、
 *      selftest 真的在回滚后调 verify-deploy 且把失败记成断言。
 *
 * ⚠ 全程 %TEMP% 沙箱，绝不碰真实运行区。不需要真实的发布包（场景一只要 `_app-上一版` 目录），
 *   所以本用例在任何机器上都能跑，不依赖 `release\` 里有没有 zip。
 *
 * 用法：node tests\neg-rollback-manifest.cjs
 * 退出码：0=PASS（含阴性自证）/ 1=FAIL；0 也可能是"可见 SKIP"（本机没有 PowerShell）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const E = require('./_测试环境.cjs');
const REPO = E.REPO;
const VD = path.join(REPO, 'scripts', 'verify-deploy.mjs');
const RB = path.join(REPO, 'scripts', 'rollback.ps1');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

console.log('测试环境：' + E.describe());

/* PowerShell 是硬依赖（被测对象就是 .ps1）。缺了就**可见 SKIP**，绝不静默当通过。 */
const psOk = spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0;
if (!psOk) {
  console.log('\n[SKIP] 本机没有可用的 powershell，无法真跑 rollback.ps1 —— 这是可见跳过，不是通过。');
  console.log('RESULT=SKIP(no-powershell) 断言=0');
  process.exit(0);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-rb-'));
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 造一个"已部署两版"的运行区沙箱：app\ = 新版，_app-上一版\ = 旧版，清单指向新版 */
function makeSandbox(tag, verNew, verOld) {
  const prod = path.join(base, tag);
  const app = path.join(prod, 'app');
  const prev = path.join(prod, '_app-上一版');
  fs.mkdirSync(path.join(app, 'js'), { recursive: true });
  fs.mkdirSync(path.join(prev, 'js'), { recursive: true });
  const put = (dir, version, marker) => {
    fs.writeFileSync(path.join(dir, '版本.json'), JSON.stringify({ version }), 'utf8');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>' + marker + '</html>\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'js', 'model.js'), 'var v = "' + marker + '";\n', 'utf8');
  };
  put(app, verNew, 'new');
  put(prev, verOld, 'old');
  /* 清单按新版 app\ 逐文件生成（deploy.ps1 落地后就长这样） */
  const files = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      files[r] = sha(full).toUpperCase();
    }
  })(app, '');
  fs.writeFileSync(path.join(prod, '_deploy-manifest.json'), JSON.stringify({
    schema: 1, version: verNew, zip: 'GlimmerNote-test.zip', zipSha256: 'X'.repeat(64),
    deployedAt: '2026-01-01 00:00:00', appDir: 'app', count: Object.keys(files).length,
    files, note: '用例夹具',
  }, null, 2), 'utf8');
  return { prod, app, prev };
}
function curVer(prod) {
  try { return String(JSON.parse(fs.readFileSync(path.join(prod, 'app', '版本.json'), 'utf8')).version); }
  catch { return '(读不到)'; }
}
function manVer(prod) {
  /* ⚠ 清单由 PowerShell 的 `Set-Content -Encoding UTF8` 写出，PS 5.1 会带 BOM
     （PS 7 不带）。判据读它的一律先剥 BOM —— verify-deploy.mjs 里也是这么做的。
     这里不剥就会把"读不懂"误报成"清单没写"（本用例第一版就是这么红的）。 */
  try {
    const raw = fs.readFileSync(path.join(prod, '_deploy-manifest.json'), 'utf8').replace(/^\uFEFF/, '');
    return String(JSON.parse(raw).version);
  } catch { return '(读不到)'; }
}
function runVD(prod) {
  const r = spawnSync(process.execPath, [VD, '--prod', prod], { encoding: 'utf8', cwd: REPO });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runRollback(prod) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RB, '-ProdRoot', prod],
    { encoding: 'utf8', cwd: REPO, timeout: 180000 });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/* ══════════ ① 基线：回滚前 verify 必须是绿的（否则"回滚后红"证明不了什么）══════════ */
console.log('\n══ ① 基线：回滚前一致性校验为绿 ══');
const S = makeSandbox('沙箱', '0.0.2', '0.0.1');
const v0 = runVD(S.prod);
A('回滚前 app\\版本 = 0.0.2', curVer(S.prod) === '0.0.2', curVer(S.prod));
A('回滚前清单版本 = 0.0.2', manVer(S.prod) === '0.0.2', manVer(S.prod));
A('回滚前 verify-deploy = 0（基线是绿的）', v0.code === 0, 'exit ' + v0.code);

/* ══════════ ② 真跑 rollback.ps1：app\ 与清单必须同时落到旧版 ══════════ */
console.log('\n══ ② 真跑 rollback.ps1（场景一：退回上一版）══');
const r1 = runRollback(S.prod);
A('rollback.ps1 退出码 = 0', r1.code === 0, 'exit ' + r1.code + '｜' + (r1.err || '').split('\n')[0]);
A('回滚后 app\\ 版本 = 0.0.1（落地内容真的退回去了）', curVer(S.prod) === '0.0.1', curVer(S.prod));
A('★ 回滚后清单版本 = 落地版本 0.0.1（E04 的修复本体）',
  manVer(S.prod) === '0.0.1', '清单=' + manVer(S.prod) + ' / 落地=' + curVer(S.prod));
A('★ 回滚后 verify-deploy = 0（正常回滚不再误红）', (() => {
  const v = runVD(S.prod); return v.code === 0;
})(), (() => { const v = runVD(S.prod); return 'exit ' + v.code + '｜' + (v.err || v.out).split('\n')[0]; })());
A('清单里的逐文件 sha 与 app\\ 现状一致（不是只改了 version 字段）', (() => {
  const vj = (() => { const r = spawnSync(process.execPath, [VD, '--prod', S.prod, '--json'], { encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch { return null; } })();
  return !!vj && vj.ok === true && vj.drift === 0 && vj.manifestVersion === '0.0.1';
})(), '见 --json 输出');
A('回滚不碰数据目录（沙箱里没有 数据\\ 时也不该凭空造一个）', !fs.existsSync(path.join(S.prod, '数据')), '');
A('回滚后 app\\ 里没有被塞进清单文件（清单在运行区根，不在 app\\ 内）',
  !fs.existsSync(path.join(S.prod, 'app', '_deploy-manifest.json')), '');
A('回滚写了部署记录（人可读的那本账不能只写一半）', (() => {
  const f = path.join(S.prod, '部署记录.txt');
  return fs.existsSync(f) && /_app-上一版/.test(fs.readFileSync(f, 'utf8'));
})(), '');

/* ══════════ ③ 阴性自证：修复前的回滚行为（只恢复 app\、不碰清单）必须让 verify 变红 ══════════ */
console.log('\n══ ③ 阴性自证：把"只恢复 app\、不重写清单"的旧行为搬回来，verify 必须 exit 1 ══');
const OLD = makeSandbox('旧行为沙箱', '0.0.2', '0.0.1');
/* 这就是 rollback.ps1 修复前的场景一实现（逐行照搬）：
     Get-ChildItem $appDir -Force | Remove-Item -Recurse -Force
     Copy-Item (Join-Path $prevDir '*') $appDir -Recurse -Force
   不改清单。 */
fs.rmSync(OLD.app, { recursive: true, force: true });
fs.cpSync(OLD.prev, OLD.app, { recursive: true });
const vOld = runVD(OLD.prod);
A('旧行为下 app\\ 确实退回 0.0.1', curVer(OLD.prod) === '0.0.1', curVer(OLD.prod));
A('★ 旧行为下清单仍是 0.0.2（与落地版本不符）', manVer(OLD.prod) === '0.0.2', manVer(OLD.prod));
A('★ 旧行为下 verify-deploy = 1（= 正常回滚被门禁误红的复现）', vOld.code === 1,
  'exit ' + vOld.code + '｜' + (vOld.err || '').split('\n')[0]);
A('★ 旧行为的误红理由正是"版本不符 + 文件被改过"',
  /版本|被改过|不一致/.test(vOld.err), (vOld.err.split('\n')[2] || '').slice(0, 120));
A('对照 · 修后（同一沙箱演化）是 0，旧行为是 1 ⇒ 差别就是那次清单重写',
  r1.code === 0 && vOld.code === 1, '修后=' + r1.code + ' / 旧=' + vOld.code);

/* ══════════ ④ 静态判据：一份实现、两处调用、selftest 真的跑了 verify ══════════ */
console.log('\n══ ④ 静态判据：共享实现 / 回滚真的调用 / selftest 真的校验 ══');
const SRC = {
  manifest: fs.readFileSync(path.join(REPO, 'scripts', 'deploy-manifest.ps1'), 'utf8'),
  deploy: fs.readFileSync(path.join(REPO, 'scripts', 'deploy.ps1'), 'utf8'),
  rollback: fs.readFileSync(RB, 'utf8'),
  selftest: fs.readFileSync(path.join(REPO, 'scripts', 'selftest-pipeline.ps1'), 'utf8'),
};
A('抽出公共实现 scripts\\deploy-manifest.ps1（含 Write-DeployManifest 函数）',
  /function\s+Write-DeployManifest/.test(SRC.manifest), '');
A('公共实现会拒绝"清单版本 ≠ 落地版本"（否则清单能自证一个错版本）',
  /落地版本.*≠.*期望版本|落地版本\(\$landed\)/.test(SRC.manifest), '');
A('deploy.ps1 dot-source 了公共实现', /deploy-manifest\.ps1/.test(SRC.deploy), '');
A('rollback.ps1 dot-source 了公共实现', /deploy-manifest\.ps1/.test(SRC.rollback), '');
A('★ rollback.ps1 真的调用 Write-DeployManifest（不是只 dot-source 不调用）',
  /Write-DeployManifest\s+-ProdRoot/.test(SRC.rollback), '');
A('★ deploy.ps1 里已无第二份内联清单实现（不再复制一份 Get-FileHash 循环）',
  !/Get-FileHash -LiteralPath \$f\.FullName -Algorithm SHA256/.test(SRC.deploy), '仍有两份实现 = 必然漂移');
A('deploy.ps1 改为调用共享函数', /Write-DeployManifest\s+-ProdRoot/.test(SRC.deploy), '');
A('rollback.ps1 在写部署记录**之前**写清单（失败时不留"记录说回滚了、清单还是新版"的假账）',
  SRC.rollback.indexOf('Write-DeployManifest') > 0 &&
  SRC.rollback.indexOf('Write-DeployManifest') < SRC.rollback.indexOf('Add-Content -Path $logFile'), '');
A('回滚失败时清单也会回退（catch 段处理了清单，不是只恢复 app\\）',
  /\$tmpManifest/.test(SRC.rollback) || /清单单独回退/.test(SRC.rollback), '');
A('★ selftest-pipeline.ps1 调用 verify-deploy（改前全文为零）',
  /verify-deploy\.mjs/.test(SRC.selftest), '');
A('★ selftest 在**回滚之后**跑 verify-deploy（场景一、场景二各一次）',
  (SRC.selftest.match(/VerifyDeployOf\s+\$sandbox/g) || []).length >= 2,
  '出现 ' + (SRC.selftest.match(/VerifyDeployOf\s+\$sandbox/g) || []).length + ' 次');
A('★ selftest 把 verify-deploy 的失败记成**断言红**（Check(... $vd.Code -eq 0)），不是只打印',
  /Check\s+"[^"]*verify-deploy exit 0[^"]*"\s+\(\$\w+\.Code -eq 0\)/.test(SRC.selftest), '');
A('selftest 还断言了"清单版本 == 落地版本"（比只看 verify 更直接）',
  /ManifestVerOf/.test(SRC.selftest) && /清单版本 == 落地版本/.test(SRC.selftest), '');

console.log('\n──────────────────────────────');
try { fs.rmSync(base, { recursive: true, force: true }); } catch { }
console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
process.exit(worst === 0 ? 0 : 1);
