/* 阴性对照：判定 → 应做动作 的映射必须**只有一份**，且「处置」写盘前必须挡住与判定不符的取值。
 *
 * 起因（2026-11-09 实机事故，用户选 B：先钉根因再修数据）：
 *   04:00 夜间自动处理链那一批派发 42 条（11-07 那批 20 条全是判定「错」⇒ 20/20 绿），
 *   **第一次**吃进非「错」类条目：11×不适用 / 9×对 / 2×无法判定。
 *   结果 37/42 登记成「无需处置」，`_闭环稽核.mjs` 判 25 条 RED（其中 16 条是
 *   「判定不适用 ⇒ 应做已核销，实际登记无需处置」）。
 *   根因不是模型跑错：`_闭环稽核.mjs` 从首次公开导入（2026.10.25.02）起就算
 *   「不适用 ⇒ 已核销」，而 `_待确认.mjs` 的注释里**另写了一份**「固定为无需处置」，
 *   夜间链信的是文件里的取值说明 ⇒ 两边契约相反。触发点是 11-08 08:57
 *   `夜间待办处理.mjs` 把 MAX 从 20 提到 50（把积压的老条目拉进窗口）。
 *
 * 本用例守三件事：
 *   ① 映射语义本身（含 11-09 那个确切形状：不适用 + 无需处置 = 不闭环）；
 *   ② **单一真源**（两个消费方都只能 import，不许再各写一份 function required）；
 *   ③ 「处置」命令的准入闸真的会红（阴性对照：把闸掏掉，那 25 条形状必须重新判红）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./_测试环境.cjs');

const REPO = E.REPO;
const TOOLS = path.join(REPO, 'src', 'tools');
const MAP_MOD = path.join(TOOLS, '_应做动作.mjs');
const AUDIT = path.join(TOOLS, '_闭环稽核.mjs');
const PENDING = path.join(TOOLS, '_待确认.mjs');

let pass = 0, fail = 0;
const A = (l, ok, x = '') => ok ? (pass++, console.log('  [OK]  ' + l + (x ? '  → ' + x : ''))) : (fail++, console.log('  [FAIL] ' + l + (x ? '  → ' + x : '')));

/* ---------- ① 映射语义（唯一真源模块，纯函数，零库依赖） ---------- */
(async () => {
  console.log('═══ ① 应做动作映射：语义与 2026-11-09 事故形状 ═══');
  const M = await import('file://' + MAP_MOD.replace(/\\/g, '/'));
  const { required, closed, requiredWhy, DISPOSITIONS, VERDICT_BOUND_DISPOSITIONS } = M;

  A('模块导出 required/closed/requiredWhy', typeof required === 'function' && typeof closed === 'function' && typeof requiredWhy === 'function');
  A('处置取值闭集 = 5 个', Array.isArray(DISPOSITIONS) && DISPOSITIONS.length === 5, DISPOSITIONS.join('/'));

  A('不适用 ⇒ 已核销（在册与否都成立）', required('不适用', true) === '已核销' && required('不适用', false) === '已核销', required('不适用', true) + '/' + required('不适用', false));
  A('无法判定 ⇒ 待人工', required('无法判定', true) === '待人工');
  A('错 + 在册 ⇒ 无需处置', required('错', true) === '无需处置');
  A('错 + 不在册 ⇒ 补建卡', required('错', false) === '补建卡');
  A('部分对 + 不在册 ⇒ 补建卡', required('部分对', false) === '补建卡');
  A('对 + 在册 ⇒ 撤卡', required('对', true) === '撤卡');
  A('对 + 不在册 ⇒ 无需处置', required('对', false) === '无需处置');

  /* ★ 事故的确切形状：不适用 + 无需处置 必须判「不闭环」 */
  A('★ 不适用+无需处置 = 不闭环（11-09 那 16 条的形状）', closed('已核销', '无需处置') === false);
  A('不适用+已核销 = 闭环', closed('已核销', '已核销') === true);
  A('撤卡+已撤卡 = 闭环；撤卡+待人工 = 不算闭环（稽核记 BLOCKED＝留给人）',
    closed('撤卡', '已撤卡') === true && closed('撤卡', '待人工') === false);
  A('待人工+待人工 = 闭环', closed('待人工', '待人工') === true);
  A('已核销对 撤卡/无需处置/待人工 都算闭环，但对「补建卡」不算（卡必须真建出来，不许用核销顶替）',
    closed('撤卡', '已核销') === true && closed('无需处置', '已核销') === true && closed('待人工', '已核销') === true &&
    closed('补建卡', '已核销') === false);

  A('判定绑定表不含「无需处置」这类会被判红的取值',
    !VERDICT_BOUND_DISPOSITIONS['不适用'].includes('无需处置') && !VERDICT_BOUND_DISPOSITIONS['无法判定'].includes('无需处置'),
    JSON.stringify(VERDICT_BOUND_DISPOSITIONS));
  A('人话解释里带出正确取值', /已核销/.test(requiredWhy('不适用', true)));

  /* ---------- ② 单一真源（源码级断言） ---------- */
  console.log('═══ ② 单一真源：两个消费方都 import，谁都不许再各写一份 ═══');
  const aSrc = fs.readFileSync(AUDIT, 'utf8');
  const pSrc = fs.readFileSync(PENDING, 'utf8');
  A('稽核 import 了 _应做动作.mjs', /from '\.\/_应做动作\.mjs'/.test(aSrc));
  A('待确认 import 了 _应做动作.mjs', /from '\.\/_应做动作\.mjs'/.test(pSrc));
  A('稽核里没有本地 function required（已搬走）', !/^function required\(/m.test(aSrc));
  A('稽核里没有本地 function closed（已搬走）', !/^function closed\(/m.test(aSrc));
  A('待确认里没有本地 function required', !/^function required\(/m.test(pSrc));
  A('待确认不再自持取值数组（改用 DISPOSITIONS 真源）', /const AS = DISPOSITIONS;/.test(pSrc));

  /* ---------- ③ 准入闸：阴性对照（闸必须在，且必须真会红） ---------- */
  console.log('═══ ③ 「处置」准入闸：与判定不符的取值必须在写盘前被拒 ═══');
  const LIB = E.makeTempLib();
  if (E.isFrozen(LIB)) throw new Error('临时库不该在冻结区：' + LIB);
  const DB = path.join(LIB, '_待确认.json');
  const ORIG = fs.readFileSync(DB);
  const run = args => spawnSync(process.execPath, [E.tool('_待确认.mjs'), ...args], {
    encoding: 'utf8', maxBuffer: 64e6,
    env: Object.assign({}, process.env, { CTB_DATA: LIB }),
  });
  try {
    const seed = (verdict, disposition) => {
      const j = JSON.parse(ORIG.toString('utf8').replace(/^\uFEFF/, ''));
      j.items = (j.items || []).filter(it => it.id !== 'T9001');
      j.items.push({ id: 'T9001', status: '已确认', subject: '数学', question: '（本用例自构造，不是真实条目）', verdict, disposition });
      fs.writeFileSync(DB, JSON.stringify(j, null, 2), 'utf8');
    };

    seed('不适用', '');
    const bad1 = run(['处置', '--id', 'T9001', '--as', '无需处置', '--note', '阴性对照：这条必须被拒']);
    A('不适用 + 无需处置 ⇒ exit 2（挡在写盘前）', bad1.status === 2, '实测 ' + bad1.status);
    A('  且报错点名了「与判定不符」与正确取值', /与判定不符/.test(bad1.stderr || '') && /已核销/.test(bad1.stderr || ''));
    const jAfter = JSON.parse(fs.readFileSync(DB, 'utf8'));
    A('  且台账**没被写脏**（disposition 仍为空）', (jAfter.items.find(x => x.id === 'T9001') || {}).disposition === '');

    const good1 = run(['处置', '--id', 'T9001', '--as', '已核销', '--note', '阴性对照：正例']);
    A('不适用 + 已核销 ⇒ exit 0', good1.status === 0, '实测 ' + good1.status);

    seed('无法判定', '');
    const bad2 = run(['处置', '--id', 'T9001', '--as', '无需处置', '--note', 'x']);
    A('无法判定 + 无需处置 ⇒ exit 2', bad2.status === 2, '实测 ' + bad2.status);
    const good2 = run(['处置', '--id', 'T9001', '--as', '待人工', '--note', 'x']);
    A('无法判定 + 待人工 ⇒ exit 0（留给人是合法出路）', good2.status === 0, '实测 ' + good2.status);

    seed('对', '');
    const free = run(['处置', '--id', 'T9001', '--as', '无需处置', '--note', '对/错类要看在册与否，闸放行由稽核兜底']);
    A('对 + 无需处置 ⇒ 放行（是否判红交给稽核，闸不越权猜在册）', free.status === 0, '实测 ' + free.status);

    /* 阴性自证：闸挡的那两个取值，正是稽核会判红的形状 —— 不是"随手加的闸" */
    A('★ 阴性自证：闸拒的两个取值确实是稽核判红形状',
      closed(required('不适用', false), '无需处置') === false && closed(required('无法判定', false), '无需处置') === false);
  } finally {
    fs.writeFileSync(DB, ORIG);
  }

  console.log(`\nRESULT=${fail ? 'FAIL' : 'PASS'} 断言=${pass + fail}（通过 ${pass} / 失败 ${fail}）`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('用例自身崩了：' + (e && e.stack || e)); process.exit(1); });
