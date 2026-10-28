/* 拾光小册 · 阴性回归：盲解工具「顺带补 answerSource」的三条边界
 *
 * 起因（2026-10-28，用户截图报障「这是什么错误？」）：
 *   某学生库里 97 张卡被 `_标记复习.mjs 准入` 当「数据欠账」拦在组卷池外，
 *   而逐张查下来**盲解那道门全部已过** —— 缺的只是没人把「独立判卷」写进 answerSource。
 *   根因是结构性的：全仓没有任何工具写这个字段（`_盲解复核.mjs` 只写 blindStatus 等）。
 *
 * 修法：`_盲解复核.mjs` 的 录入/批量 与 迁移双路/同步双路 落结论时顺带补 answerSource。
 * 本用例守它的**三条边界**，每条都必须是"能红"的：
 *   ① 只跑一路 → **不写**（单路分不清"题错"还是"解题者自己错"）
 *   ② 两路指纹不等（题干在两次盲解之间被改过）→ **不写**
 *   ③ 字段已有非空值（人工判断，如「仅红笔」）→ **一律不覆盖**
 *      —— 这条是本用例的**阴性对照**：谁把规则 ③ 删掉，M0002 会立刻变成「独立判卷」而红。
 * 另守：写出的值必须真的过 `_标记复习.mjs` 的准入判据（不是自说自话），以及本动作幂等
 *      （同步双路 跑第二次 srcFilled=0、文件逐字节不变）。
 *
 * 全程跑在 os.tmpdir() 下自建的合成库上：**每一次工具调用都显式带 `data: tmp`**，
 * 不依赖 E.LIB，也就绝不落到真库（下面另有一道"临时库必须在 os.tmpdir() 下"的自证）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const E = require('./_测试环境.cjs');

let pass = 0; const fails = [];
const T = (name, ok, detail) => { if (ok) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); };

/* ---------- 合成库 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-asfill-'));
/* 自证：临时库必须在系统临时目录下。写错路径要当场红，而不是悄悄写到用户数据上。 */
if (!path.resolve(tmp).startsWith(path.resolve(os.tmpdir()))) {
  console.error('✖ 合成库不在 os.tmpdir() 下，拒绝继续：' + tmp); process.exit(1);
}
const STU = '测试甲';
const IDX = path.join(tmp, '九年级-' + STU, '_索引.json');
fs.mkdirSync(path.dirname(IDX), { recursive: true });

const card = (id, question, extra) => Object.assign({
  id, dir: id + '-x', question, answer: '答' + id, studentAnswer: '错' + id,
  blindStatus: '未盲解', status: '在册',
}, extra || {});
const writeIdx = (items) => fs.writeFileSync(IDX, JSON.stringify({ student: STU, subject: '数学', updatedAt: '', items }, null, 2) + '\n', 'utf8');
const readIdx = () => JSON.parse(fs.readFileSync(IDX, 'utf8'));
const byId = (id) => readIdx().items.find(x => x.id === id);

writeIdx([
  card('M0001', '合成题一：1+1=?'),                                    // 全空白 → 应被补
  card('M0002', '合成题二：2+2=?', { answerSource: '仅红笔', answerSourceNote: '人工刻意留待定案' }),  // 人工值 → 不许覆盖
  card('M0003', '合成题三：3+3=?', { answerSource: '', answerSourceNote: '' }),                       // 空串 → 应被补
  card('M0004', '合成题四：4+4=?'),                                    // 两路之间改题干 → 指纹不等 → 不许补
  card('M0005', '合成题五：5+5=?'),                                    // 只跑一路 → 不许补
]);
fs.writeFileSync(path.join(tmp, '_盲解双路.json'),
  JSON.stringify({ note: '测试用双路台账', lanes: {} }, null, 2) + '\n', 'utf8');

const HAPPY = '独立判卷（双路盲解×2 一致）';
const runBlind = (args) => E.runToolSync('_盲解复核.mjs', args, { data: tmp });

/* ---------- 第 1 路 ---------- */
let r = runBlind(['批量', '--student', STU, '--lane', '1', '--solver', '测试第1路',
  '--results', 'M0001=一致,M0002=一致,M0003=一致,M0004=一致,M0005=一致']);
T('批量(第1路) 退出码 0', r.code === 0, 'code=' + r.code + ' ' + (r.err || '').slice(0, 200));
T('① 只跑一路 → 没有任何卡被写入本工具的取值',
  ['M0001', 'M0002', 'M0003', 'M0004', 'M0005'].every(id => byId(id).answerSource !== HAPPY),
  JSON.stringify(['M0001', 'M0002', 'M0003', 'M0004', 'M0005'].map(id => [id, byId(id).answerSource])));
T('① 只跑一路 → 原本没字段的卡仍然没有字段',
  ['M0001', 'M0004', 'M0005'].every(id => !Object.prototype.hasOwnProperty.call(byId(id), 'answerSource')),
  JSON.stringify(['M0001', 'M0004', 'M0005'].map(id => [id, byId(id).answerSource])));
T('只跑一路 → 合成态为「待双路」', byId('M0001').blindStatus === '待双路', byId('M0001').blindStatus);

/* ---------- 第 2 路 ---------- */
const today = (() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
r = runBlind(['批量', '--student', STU, '--lane', '2', '--solver', today + ' 第2路（测试）',
  '--results', 'M0001=一致,M0002=一致,M0003=一致']);   // M0005 故意不给第 2 路：它是"只跑一路"的样本
T('批量(第2路) 退出码 0', r.code === 0, 'code=' + r.code + ' ' + (r.err || '').slice(0, 200));

T('② 两路都过 → M0001 补出 answerSource=' + HAPPY, byId('M0001').answerSource === HAPPY, String(byId('M0001').answerSource));
T('② note 非空且带指纹', /指纹 [0-9a-f]{12}$/.test(String(byId('M0001').answerSourceNote || '')), String(byId('M0001').answerSourceNote));
T('② note 不重复日期前缀（solver 自带日期时不再前缀）',
  !/第[12]路（\d{4}-\d{2}-\d{2} 第[12]路/.test(String(byId('M0001').answerSourceNote || '')), String(byId('M0001').answerSourceNote));

T('③【阴性对照】已有非空值「仅红笔」逐字不变',
  byId('M0002').answerSource === '仅红笔', String(byId('M0002').answerSource));
T('③【阴性对照】人工 note 也不被动', byId('M0002').answerSourceNote === '人工刻意留待定案', String(byId('M0002').answerSourceNote));
T('③ M0002 的 blindStatus 照常推进到「已通过」', byId('M0002').blindStatus === '已通过', byId('M0002').blindStatus);

T('② 值为空串 → M0003 同样被补', byId('M0003').answerSource === HAPPY, String(byId('M0003').answerSource));

T('① M0005 只跑一路 → 仍无 answerSource', !Object.prototype.hasOwnProperty.call(byId('M0005'), 'answerSource'));
T('① M0005 合成态 = 待双路', byId('M0005').blindStatus === '待双路', byId('M0005').blindStatus);

/* ---------- 第 2 路（M0004：两路之间改过题干 → 指纹不等） ---------- */
const before = readIdx();
before.items.find(x => x.id === 'M0004').question = '合成题四（改过）：4+4=?';
fs.writeFileSync(IDX, JSON.stringify(before, null, 2) + '\n', 'utf8');
r = runBlind(['批量', '--student', STU, '--lane', '2', '--results', 'M0004=一致']);
T('批量(M0004 第2路) 退出码 0', r.code === 0, 'code=' + r.code + ' ' + (r.err || '').slice(0, 200));
T('② 两路指纹不等（题干改过）→ 不写 answerSource',
  !Object.prototype.hasOwnProperty.call(byId('M0004'), 'answerSource'), String(byId('M0004').answerSource));
T('② 但 blindStatus 仍由台账合成（不因指纹不等而无声拦住）', byId('M0004').blindStatus === '已通过', byId('M0004').blindStatus);

/* ---------- 写出的值必须真的过准入判据 ---------- */
const gate = E.runToolSync('_标记复习.mjs', ['准入', '--student', STU, '--json'], { data: tmp });
let admit = null;
try { admit = JSON.parse(gate.out); } catch (e) { }
T('准入 --json 可解析', !!admit && !!admit.admit, (gate.out || '').slice(0, 120) + (gate.err || '').slice(0, 120));
if (admit && admit.admit) {
  T('M0001 过准入', admit.admit[STU + '|M0001'].ok === true, JSON.stringify(admit.admit[STU + '|M0001']));
  T('M0003 过准入', admit.admit[STU + '|M0003'].ok === true, JSON.stringify(admit.admit[STU + '|M0003']));
  T('M0002 仍被拦且理由＝仅红笔', admit.admit[STU + '|M0002'].ok === false && /仅红笔/.test(admit.admit[STU + '|M0002'].why), JSON.stringify(admit.admit[STU + '|M0002']));
  T('M0004 仍被拦（缺第二来源）', admit.admit[STU + '|M0004'].ok === false, JSON.stringify(admit.admit[STU + '|M0004']));
  T('M0005 仍被拦（单路 = 盲解未过）', admit.admit[STU + '|M0005'].ok === false, JSON.stringify(admit.admit[STU + '|M0005']));
}

/* ---------- 幂等：同步双路 第二次不得再动文件 ---------- */
const sha = (p) => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const s1 = sha(IDX);
const sync1 = runBlind(['同步双路']);
T('同步双路 第一次退出码 0', sync1.code === 0, (sync1.err || '').slice(0, 200));
const s2 = sha(IDX);
const sync2 = runBlind(['同步双路']);
T('同步双路 第二次退出码 0', sync2.code === 0, (sync2.err || '').slice(0, 200));
T('幂等：第二次运行索引逐字节不变', sha(IDX) === s2, s1 + ' → ' + s2 + ' → ' + sha(IDX));
T('幂等：第二次不再报告补录', !/顺带补 answerSource/.test(sync2.out || ''), (sync2.out || '').trim());

/* ---------- 收尾 ---------- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
console.log(`RESULT=${fails.length ? 'FAIL' : 'PASS'} 断言=${pass + fails.length} 通过=${pass} 失败=${fails.length}`);
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  ✖ ' + f); process.exit(1); }
