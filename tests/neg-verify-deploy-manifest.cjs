#!/usr/bin/env node
/**
 * 拾光小册 · E03 阴性对照：部署清单损坏不得被当成"本机没有运行区"（2026-10-31 建）
 *
 * 事故（外部复核已证实）：
 *   `scripts\verify-deploy.mjs:78-80` 在清单解析失败/形状不对时 `die(2, …)`，
 *   而 `exit 2` 同时又是"运行区不存在"的码；两个调用方
 *   （`tests\run.mjs:63-68`、`.githooks\pre-commit:65`）把**所有** exit 2 一律当"没有运行区"放行。
 *   实测：损坏清单 → 退出码 2 → run.mjs 不 exit 继续跑完全绿；pre-commit 返回 0 允许提交
 *   （对照组 rc=1 → 阻止）。输出里确实打印了「清单解析失败」，但**结论方向反了 + fail-open**。
 *
 * 修法（E03）：退出码拆开，且"可豁免"只剩一种：
 *   0 一致 / 1 漂移 / 2 用法错误 / 3 没有运行区（**唯一可豁免**）/ 4 清单损坏或形状不对 / 5 尚无清单
 *   消费侧判据收在 `tests\_测试环境.cjs` 的 `classifyVerifyDeploy()`，run.mjs 与 pre-commit 都按它分支
 *   （两份 if/else 必然漂移，本仓 L-286）。
 *
 * 本用例的牙齿：
 *   ① 真跑 verify-deploy 造五种沙箱，断言**实际退出码**（不是读注释）；
 *   ② 断言"损坏清单的码"在 classifyVerifyDeploy 里是 block，而"没有运行区"是 skip；
 *   ③ 阴性自证：把**旧判据**（"2 = 放行"）原样搬进来，损坏清单必须被它放行 ——
 *      证明 ② 的红/绿是判据给的；
 *   ④ 与 `.githooks/pre-commit` 的 case 分支**对拍**：豁免臂只能有 3，4/5 必须 exit 1；
 *      `tests\run.mjs` 必须调用共享判据且不再出现 `code === 2` 的旧分支。
 *
 * ⚠ 全程在 %TEMP% 造沙箱，绝不碰真实运行区（本用例连它的路径都不拼）。
 *
 * 用法：node tests\neg-verify-deploy-manifest.cjs
 * 退出码：0=PASS（含阴性自证）/ 1=FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const E = require('./_测试环境.cjs');
const REPO = E.REPO;
const VD = path.join(REPO, 'scripts', 'verify-deploy.mjs');

let worst = 0, passed = 0;
function A(name, ok, detail) {
  if (ok) { passed++; console.log('[OK]   ' + name + (detail ? '  → ' + detail : '')); }
  else { worst++; console.log('[FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

console.log('测试环境：' + E.describe());
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-neg-vd-'));
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 造一个运行区沙箱：app\ + 版本.json +（可选）清单。返回 { prod, app } */
function makeSandbox(tag, opts) {
  const o = opts || {};
  const prod = path.join(base, tag);
  const app = path.join(prod, 'app');
  fs.mkdirSync(path.join(app, 'js'), { recursive: true });
  fs.writeFileSync(path.join(app, '版本.json'), JSON.stringify({ version: o.version || '0.0.1' }), 'utf8');
  fs.writeFileSync(path.join(app, 'index.html'), '<html></html>\n', 'utf8');
  fs.writeFileSync(path.join(app, 'js', 'model.js'), 'var a = 1;\n', 'utf8');
  if (o.manifest !== undefined) fs.writeFileSync(path.join(prod, '_deploy-manifest.json'), o.manifest, 'utf8');
  return { prod, app };
}
/** 与 deploy.ps1 同形状的清单（Get-FileHash 是大写，verify-deploy 大小写不敏感） */
function goodManifest(app, version) {
  const files = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      files[r] = sha256(full).toUpperCase();
    }
  })(app, '');
  return JSON.stringify({
    schema: 1, version: version || '0.0.1', zip: 'GlimmerNote-test.zip', zipSha256: 'X'.repeat(64),
    deployedAt: '2026-01-01 00:00:00', appDir: 'app', count: Object.keys(files).length,
    files, note: '用例夹具',
  }, null, 2);
}
function runVD(prod) {
  const r = spawnSync(process.execPath, [VD, '--prod', prod], { encoding: 'utf8', cwd: REPO });
  return { code: r.status == null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/* ══════════ ① 五种沙箱真跑：退出码必须一一对上 ══════════ */
console.log('\n══ ① 真跑 verify-deploy：五种状态必须是五个不同的码 ══');
const noRuntime = path.join(base, '根本没有这个目录');
const noApp = (() => { const p = path.join(base, '有目录没app'); fs.mkdirSync(p, { recursive: true }); return p; })();
const noManifest = makeSandbox('无清单', {});
const corruptJson = makeSandbox('清单坏JSON', { manifest: '{"files": {"a.js": "abc"}' });          // 少收尾括号
const badShape = makeSandbox('清单形状错', { manifest: JSON.stringify({ schema: 1, version: '0.0.1' }) }); // 缺 files
const emptyFiles = makeSandbox('清单空files', { manifest: JSON.stringify({ version: '0.0.1', files: {} }) });
const healthy = makeSandbox('健康', {});
fs.writeFileSync(path.join(healthy.prod, '_deploy-manifest.json'), goodManifest(healthy.app, '0.0.1'), 'utf8');

const rNone = runVD(noRuntime);
const rNoApp = runVD(noApp);
const rNoMan = runVD(noManifest.prod);
const rBad = runVD(corruptJson.prod);
const rShape = runVD(badShape.prod);
const rEmpty = runVD(emptyFiles.prod);
const rOk = runVD(healthy.prod);

A('运行区目录不存在 ⇒ exit 3（唯一可豁免的码）', rNone.code === 3, 'exit ' + rNone.code + '｜' + rNone.err.split('\n')[0]);
A('运行区存在但没有 app\\ ⇒ 同样 exit 3（等于"没有运行区"）', rNoApp.code === 3, 'exit ' + rNoApp.code);
A('运行区在、但无清单 ⇒ exit 5（不许再算"没有运行区"）', rNoMan.code === 5, 'exit ' + rNoMan.code);
A('★ 清单 JSON 解析失败 ⇒ exit 4（阻断码，不是 3 也不是 2）', rBad.code === 4, 'exit ' + rBad.code + '｜' + rBad.err.split('\n')[0]);
A('★ 清单形状不对（缺 files 字典）⇒ exit 4', rShape.code === 4, 'exit ' + rShape.code);
A('★ 清单 files 为空字典 ⇒ exit 4（空清单等于任何文件都算凭空多出）', rEmpty.code === 4, 'exit ' + rEmpty.code);
A('健康运行区 ⇒ exit 0（五码之外不能把正常情形也判红）', rOk.code === 0, 'exit ' + rOk.code);
A('★ 损坏清单的码 ≠ 没有运行区的码（这是本缺陷的判据核心）',
  rBad.code !== rNone.code && rBad.code !== 3, '损坏=' + rBad.code + ' / 无运行区=' + rNone.code);
A('损坏清单的 stderr 明确写"损坏"而不是"不存在"',
  /清单解析失败|清单形状不对/.test(rBad.err) && !/本机没有运行区/.test(rBad.err),
  (rBad.err.split('\n')[0] || '').slice(0, 120));

/* ══════════ ② 共享判据：只有"没有运行区"是 skip ══════════ */
console.log('\n══ ② classifyVerifyDeploy（两个调用方的唯一判据）══');
const C = E.VERIFY_DEPLOY_CODES;
A('码表与脚本实际行为一致（NO_RUNTIME=3 / BAD_MANIFEST=4 / NO_MANIFEST=5）',
  C.NO_RUNTIME === 3 && C.BAD_MANIFEST === 4 && C.NO_MANIFEST === 5,
  JSON.stringify(C));
A('★ 没有运行区(3) ⇒ skip（无法评估 ≠ 有漂移）', E.classifyVerifyDeploy(3).action === 'skip');
A('★ 清单损坏(4) ⇒ block（fail-closed）', E.classifyVerifyDeploy(4).action === 'block');
A('尚无清单(5) ⇒ block（无法证明运行区等于某个发布包）', E.classifyVerifyDeploy(5).action === 'block');
A('漂移(1) ⇒ block', E.classifyVerifyDeploy(1).action === 'block');
A('用法错误(2) ⇒ block（静默忽略未知参数会让 --prod 拼错变成"查了别的目录"）', E.classifyVerifyDeploy(2).action === 'block');
A('一致(0) ⇒ pass', E.classifyVerifyDeploy(0).action === 'pass');
A('未知码（如 9）⇒ block（默认 fail-closed，不许落成 skip）', E.classifyVerifyDeploy(9).action === 'block');
A('实际返回值接进判据：损坏清单真跑结果被判为 block',
  E.classifyVerifyDeploy(rBad.code).action === 'block', 'code=' + rBad.code);
A('实际返回值接进判据：无运行区真跑结果被判为 skip',
  E.classifyVerifyDeploy(rNone.code).action === 'skip', 'code=' + rNone.code);

/* ══════════ ③ 阴性自证：旧判据（2 = 放行）必须吞掉损坏清单 ══════════ */
console.log('\n══ ③ 阴性自证：把旧判据搬回来，损坏清单必须被放行 ══');
/** 修复前的判据（run.mjs 原文逻辑）：0 通过 / 3、2 一律告警放行 / 其它阻断 */
function oldClassify(code) {
  if (code === 0) return 'pass';
  if (code === 3 || code === 2) return 'skip';
  return 'block';
}
/* 修复前的 verify-deploy 对"清单损坏"返回的是 2 —— 这里直接用它历史行为的码 */
A('自证 · 旧 verify-deploy 对清单损坏返回 2（写死这条历史事实）', (() => {
  /* 用源码静态核对：修复前的 die(2, '✖ 清单解析失败') 形态必须已不在 */
  const src = fs.readFileSync(VD, 'utf8');
  return !/die\(2,\s*'✖ 清单解析失败/.test(src);
})(), '源码里仍有 die(2, 清单解析失败) = 没改');
A('★ 自证 · 旧判据把"损坏清单(历史码 2)"放行 ⇒ 正是 fail-open 本体',
  oldClassify(2) === 'skip', 'oldClassify(2)=' + oldClassify(2));
A('★ 对照 · 新判据对同一个码(2)是 block ⇒ 修复生效', E.classifyVerifyDeploy(2).action === 'block');
A('★ 自证 · 如果把新判据里"唯一豁免"扩成 {3,4}，损坏清单就会重新被放行（本用例的牙齿在这里）',
  (() => { const loose = c => (c === 3 || c === 4) ? 'skip' : 'block'; return loose(4) === 'skip' && E.classifyVerifyDeploy(4).action === 'block'; })());

/* ══════════ ④ 与 .githooks\pre-commit 的分支对拍 ══════════ */
console.log('\n══ ④ pre-commit 的 case 分支必须与判据逐条对齐 ══');
const hook = fs.readFileSync(path.join(REPO, '.githooks', 'pre-commit'), 'utf8');
const seg0 = hook.indexOf('③ 运行区部署一致性');
const seg1 = hook.indexOf('[pre-commit] 全部通过');
A('钩子里能找到 verify-deploy 的分支段', seg0 >= 0 && seg1 > seg0, 'seg=' + seg0 + '..' + seg1);
const seg = seg0 >= 0 && seg1 > seg0 ? hook.slice(seg0, seg1) : '';
/** 粗解析 case 臂：`\n    4)` 开头、到下一个臂或 esac 之前 */
const arms = {};
for (const m of seg.matchAll(/^\s{4}(\d+)\)([\s\S]*?)(?=^\s{4}(?:\d+|\*)|\besac)/gm)) {
  arms[m[1]] = m[2];
}
const armNums = Object.keys(arms).sort();
A('case 臂解析成功（改造后应至少有 0 与一个豁免臂）', armNums.length >= 2, armNums.join(','));
const isBlockArm = t => /^\s*exit\s+1\s*$/m.test(t);
const exempt = armNums.filter(n => !isBlockArm(arms[n]) && n !== '0');
const blocked = armNums.filter(n => isBlockArm(arms[n]));
A('★ 唯一豁免臂只能有 3（没有运行区）', exempt.length === 1 && exempt[0] === '3', '豁免臂=' + exempt.join(','));
A('★ 4（清单损坏）必须 exit 1 —— 不许再被当"没有运行区"放行', blocked.includes('4'), '阻断臂=' + blocked.join(','));
A('★ 5（尚无清单）必须 exit 1 —— "无法证明"不等于"通过"', blocked.includes('5'), '阻断臂=' + blocked.join(','));
A('钩子里已无"2) 放行"的旧分支（那正是本轮 fail-open 的入口）', !Object.keys(arms).includes('2'),
  '存在 2) 臂 = 仍在按"所有 exit 2 = 没有运行区"处理');
A('钩子里的豁免臂注释写清了"唯一"', /唯一/.test(arms['3'] || ''), '');

/* ══════════ ④-b 真执行钩子的分支（不是只读源码）：把 case 段抽出来喂不同的 rc ══════════
 * 为什么值得单独做：静态解析能证明"文字上有 4)"，但证明不了"rc=4 时钩子真的 exit 1"。
 * 把 case 段原样抽到临时 sh 脚本里跑，判据就是可执行的。 */
const sh = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' });
const shOk = sh.status === 0 && sh.error === undefined;
if (!shOk) {
  console.log('\n[SKIP] 本机没有可用的 sh，跳过硬执行钩子分支（可见跳过，不是通过）');
} else {
  const cs = hook.indexOf('case "$rc" in');
  const ce = cs < 0 ? -1 : hook.indexOf('esac', cs);
  A('能从钩子里抽出 case 段', cs >= 0 && ce > cs, 'case@' + cs + ' esac@' + ce);
  if (cs >= 0 && ce > cs) {
    const caseBody = hook.slice(cs, ce + 4);
    const runHookArm = (rc) => {
      const script = '#!/bin/sh\nrc=' + rc + '\nset +e\n' + caseBody +
        '\necho HOOK_VERDICT=allow\n';
      const p = path.join(base, 'hook-' + rc + '.sh');
      fs.writeFileSync(p, script, 'utf8');
      const r = spawnSync('sh', [p], { encoding: 'utf8' });
      return { code: r.status == null ? -1 : r.status, out: String(r.stdout || '') };
    };
    const h3 = runHookArm(3);
    const h4 = runHookArm(4);
    const h5 = runHookArm(5);
    const h1 = runHookArm(1);
    A('★ 钩子分支真执行：rc=3（没有运行区）⇒ 放行', h3.code === 0 && /HOOK_VERDICT=allow/.test(h3.out),
      'exit ' + h3.code);
    A('★ 钩子分支真执行：rc=4（清单损坏）⇒ 阻断（exit≠0，不打印放行）',
      h4.code !== 0 && !/HOOK_VERDICT=allow/.test(h4.out), 'exit ' + h4.code);
    A('★ 钩子分支真执行：rc=5（尚无清单）⇒ 阻断', h5.code !== 0 && !/HOOK_VERDICT=allow/.test(h5.out),
      'exit ' + h5.code);
    A('钩子分支真执行：rc=1（漂移）⇒ 阻断', h1.code !== 0 && !/HOOK_VERDICT=allow/.test(h1.out),
      'exit ' + h1.code);
    A('★ 阴性自证 · 若把 4 并进 3 的放行臂，上面那条断言会红（掏得动）', (() => {
      /* 造一个"把 4 也放行"的等价钩子分支，验证它确实会被判红。
         ⚠ 缩进要按钩子真实写法匹配（case 臂是 4 空格缩进）——本用例第一版写死 2 空格，
         替换没生效 ⇒ 自证永远"通过"。自证装置本身也必须被验证（这里用 changed 标记）。 */
      let changed = false;
      const looseBody = caseBody.replace(/^([ \t]*)3\)/m, (m, sp) => { changed = true; return sp + '3|4)'; });
      if (!changed) return false;
      const script = '#!/bin/sh\nrc=4\nset +e\n' + looseBody + '\necho HOOK_VERDICT=allow\n';
      const p = path.join(base, 'hook-loose.sh');
      fs.writeFileSync(p, script, 'utf8');
      const r = spawnSync('sh', [p], { encoding: 'utf8' });
      return (r.status === 0) !== (h4.code === 0);     // 掏掉后必须与修后行为不同
    })(), '掏掉修复后行为必须不同');
  }
}

/* ══════════ ⑤ run.mjs 必须用共享判据、且旧分支已删 ══════════ */
console.log('\n══ ⑤ run.mjs 接线与旧分支清理 ══');
const runSrc = fs.readFileSync(path.join(REPO, 'tests', 'run.mjs'), 'utf8');
A('run.mjs 调用共享判据 E.classifyVerifyDeploy', /E\.classifyVerifyDeploy\(/.test(runSrc), '');
A('run.mjs 里已删掉 `code === 2` 的旧豁免分支', !/code\s*===\s*2\s*\)/.test(runSrc),
  '仍存在 code === 2 = 损坏清单会被吞掉');
A('run.mjs 不再用"所有非 0 都判红"也不再用"2 就放行"（只剩 pass/skip/block 三分支）',
  /v\.action === 'pass'/.test(runSrc) && /v\.action === 'skip'/.test(runSrc) && /v\.action === 'block'/.test(runSrc));
A('run.mjs 对 BAD_MANIFEST 有专门的处置文案（说明"损坏 ≠ 不存在"）',
  /BAD_MANIFEST/.test(runSrc), '');

console.log('\n──────────────────────────────');
try { fs.rmSync(base, { recursive: true, force: true }); } catch { }
console.log(worst === 0 ? 'RESULT=PASS 断言=' + passed : 'RESULT=FAIL 断言=' + passed + ' 失败=' + worst);
process.exit(worst === 0 ? 0 : 1);
