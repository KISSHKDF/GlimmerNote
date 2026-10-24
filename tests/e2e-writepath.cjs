// 写路径全闭环回归：mark 状态(只读) → 组卷 → 批改 → regen → 校验 → 撤批 → regen → 复原校验
// 通过运行中的 错题本V2.exe 的 CDP 通道执行（= 复习流用的同一条桥路径）。
//
// ⚠ 2026-10-10（BUG-07）：本脚本会**真的往题库写**（组卷 + 批改两条记录），
//   原来没有任何 finally —— 组卷成功之后若第 [3]~[4] 步断言抛异常，
//   测试批次就留在 _组卷台账.json 与索引的 reviews[] 里，污染真源且没人知道。
//   现在：进 [2] 时登记批次号，进程退出/异常/信号一律先撤批再退出（撤批自身幂等）。
const fs = require('fs');
/* ★ 2026-10-23：测试环境（页面 URL 判据 / 库根 / 工具目录）走唯一实现 */
const E = require('./_测试环境.cjs');
/* ★ 2026-10-12：单次 CDP 调用超时（基础设施缺陷修复）。
   原 send() 挂上 pending 就永远不超时，而 evalJs 用 awaitPromise:true ——
   页面里只要有一个卡住的 Promise，整条门禁就无限期挂住（实测卡过 20~40 分钟，只能人工 kill）。
   门禁必须永远能自己跑完。覆盖：CTB_CDP_TIMEOUT（毫秒，默认 20000）。 */
function cdpTimeout() { const v = Number(process.env.CTB_CDP_TIMEOUT); return Number.isFinite(v) && v > 0 ? v : 20000; }
let PAPER = null;          // 已登记、尚未回滚的测试批次
let CLEANED = false;
let EV = null;             // 页面求值函数（撤批要用）
async function cleanup(reason) {
  if (CLEANED || !PAPER || !EV) return;
  CLEANED = true;
  try {
    const r = await EV(`CTB.host.mark('撤批',{paper:'${PAPER}'})`);
    console.error(`[清理] 异常退出（${reason}）→ 已撤批 ${PAPER}：code=${r && r.code}`);
    try { await EV(`CTB.host.regen()`); } catch { }
  } catch (e) { console.error(`[清理] 撤批失败，请手工跑：node _标记复习.mjs 撤批 --paper ${PAPER}（原因：${e.message}）`); }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => { await cleanup('signal ' + sig); process.exit(130); });
}
process.on('uncaughtException', async e => { await cleanup('uncaught ' + (e && e.message)); console.error('EXC', e && e.stack || e); process.exit(3); });
process.on('unhandledRejection', async e => { await cleanup('rejection ' + (e && e.message)); console.error('EXC', e && e.stack || e); process.exit(3); });

(async () => {
  const r = await fetch('http://127.0.0.1:9223/json/list');
  const ts = await r.json();
  const t = ts.find(x => E.isAppUrl(decodeURIComponent(x.url || '')));
  if (!t) { console.error('NO TARGET'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const q = new Map();
  const send = (m, p = {}, timeoutMs = cdpTimeout()) => new Promise((res, rej) => {
    const i = ++id;
    const _t = setTimeout(() => { q.delete(i); rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + m)); }, timeoutMs);
    q.set(i, { res: v => { clearTimeout(_t); res(v); }, rej: e => { clearTimeout(_t); rej(e); } });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && q.has(m.id)) { const p = q.get(m.id); q.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, cdpTimeout()); if (r.exceptionDetails) throw new Error('page exc: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result && r.result.value; };
  EV = ev;
  await send('Runtime.enable');
  let fails = 0;
  const A = (n, ok, d) => { console.log((ok ? '[OK]  ' : '[FAIL]') + n + (d !== undefined ? '  → ' + String(d).slice(0, 220) : '')); if (!ok) fails++; };

  console.log('--- [1] mark 状态（只读）---');
  const r1 = await ev(`CTB.host.mark('状态',{})`);
  /* ★ 2026-10-23：显式识别"被上一个测试的打桩污染"。
     真实事故（run7）：verify-v2-interactive-sweep 在 CDP 超时处崩了，它的写通道打桩没还原，
     本测试随后拿到的全是 'SWEEP-STUB …（打桩，未写盘）'，于是把三条"批改没生效"报成 FAIL，
     看上去像产品坏了。这里先判一次：是桩就**立刻停**并点名，绝不把假结果当产品结论。 */
  if (r1 && typeof r1.out === 'string' && /SWEEP-STUB|打桩，未写盘/.test(r1.out)) {
    console.error('[前置失败] 页面写通道仍是上一个测试的打桩（' + String(r1.out).slice(0, 80) + '）');
    console.error('           本测试无法验真实写路径。先修 verify-v2-interactive-sweep 的崩溃兜底，或重跑 launch-dev 清场。');
    process.exit(2);
  }
  A('状态动作 code=0', r1 && r1.code === 0, (r1.out || '').slice(0, 80));

  /* 测试对象**运行时选**，绝不写死卡号：准入态会随题库工作变化（2026-10-09 v2.5 双路迁移后
     原先写死的 M0021/M0022 全变「待双路」，被组卷门禁正确拦下——那是门禁对、测试错）。
     2026-10-10：改为**同一学生同一学科取 3~4 张**——这样下面的交错断言（相邻不同同族考点）
     才有 ≥3 张、≥2 种 code 的前提，否则会因"只有 2 张"静默豁免（假通过）。
     ⚠ 2026-10-11 修（门禁被用户真实操作打破）：用户会在界面里「组卷入账」产生**真实的待批改批次**
     （实测 `P20261011-01` 某孩子数学 30 题）。派生状态 `reviewStatus` 是**跨批次**算的：卡只要还在
     任一「待批改」批次里，批改本测试批次后状态仍是「复习中·待批改」⇒ 下面的断言（"批改后应为已复习·通过"）
     必然假红。**那是测试假设错，不是产品 bug**（诊断脚本 `_probe\diag-writepath-fail.cjs` 已证实
     30 张待批改卡全部 ∈ 用户那张真实批次）。
     修法：选卡时**排除已在任一「待批改」批次里的卡**；若因此选不出足够多的卡，就显式报"环境不具备"并跳过，
     绝不去动用户的真实批次。 */
  const pick = JSON.parse(await ev(`(function(){
    var led = null;
    try { led = CTB.model.state && CTB.model.state.papers; } catch(e) {}
    var pending = {};
    try {
      /* 状态包顶层就是 papers（数组），model 把它挂在 M.state.papers。
         （我第一版写了 M.papers() —— 那个函数不存在；这类"猜 API 名"必须先核。） */
      ((CTB.model.state && CTB.model.state.papers) || []).forEach(function(b){
        if (b && b.status === '待批改') (b.items||[]).forEach(function(id){ pending[b.student+'|'+id] = 1; });
      });
    } catch(e) {}
    var xs=CTB.model.cardsOf().filter(function(x){return CTB.model.canGroup(x.card) && !pending[x.kid+'|'+x.card.id]});
    /* ★ B-09：不再写死真实学生名——优先取可组卷卡最多的孩子（≥3 张才专注单孩子） */
    var byKid={};xs.forEach(function(x){(byKid[x.kid]=byKid[x.kid]||[]).push(x)});
    var ks=Object.keys(byKid).sort(function(a,b){return byKid[b].length-byKid[a].length});
    var use=(ks[0]&&byKid[ks[0]].length>=3)?byKid[ks[0]]:xs;
    if(use.length<2)return JSON.stringify({err:'可组卷且不在待批改批次里的卡不足 2 张（共 '+use.length+'；pending='+Object.keys(pending).length+'）'});
    var a=use[0];
    var same=use.filter(function(x){return x.subject===a.subject});
    var group=same.length>=3?same:use;
    var n=Math.min(4,group.length);
    /* ⚠ 这里给的是**工具的 ids**（_标记复习.mjs 组卷 --ids），不是组卷篮的键 ——
       篮子键 2026-10-12 起是 kid|id（BUG-11），但工具只认裸卡号，别搞混。 */
    return JSON.stringify({ids:group.slice(0,n).map(function(x){return x.card.id}),student:a.kid,subject:a.subject,pendingExcluded:Object.keys(pending).length});
  })()`));
  if (pick.err) { console.log('RESULT=SKIP(环境不具备：' + pick.err + ')'); process.exit(0); }
  const IDS = pick.ids.join(',');
  const ST = `CTB.model.cards.find(function(x){return x.kid===${JSON.stringify(pick.student)}&&x.card.id===${JSON.stringify(pick.ids[0])}}).card`;
  console.log(`--- [2] 组卷（运行时选卡：${pick.student}/${pick.subject} ${IDS}，均已过准入判定；已排除 ${pick.pendingExcluded} 张属于待批改批次的卡）---`);
  const r2 = await ev(`CTB.host.mark('组卷',{student:${JSON.stringify(pick.student)},subject:${JSON.stringify(pick.subject)},ids:${JSON.stringify(IDS)},title:'E2E回归自动卷',date:new Date().toISOString().slice(0,10),note:'e2e 写路径回归，测毕撤批'})`);
  A('组卷 code=0', r2 && r2.code === 0, (r2.out || r2.err || '').slice(0, 200));
  const paper = (String(r2.out || '').match(/P\d{8}-\d{2}/) || [null])[0];
  A('解析到批次号', !!paper, paper);
  if (!paper) { console.log('RESULT=FAIL(前置崩)'); process.exit(1); }
  PAPER = paper;                     // 自此之后任何异常路径都会先撤批（BUG-07）

  /* v2.6 交错组卷（Rohrer 2020：相邻不同同族考点）：**在这里断言而不是另开可选工具**——
     可选工具等于没有机械化（本仓教训 L-175）。判据：台账 items 里不存在"相邻两题同 causeCode"，
     且候选卡的同族考点多于 1 种（只有 1 种时无交错空间，豁免）。
     只用 2 张卡时也豁免（相邻对只有 1 对，避不开）。 */
  const buf = await ev(`CTB.host.readFile('_组卷台账.json').then(function(r){return r.text})`);
  const led = JSON.parse(buf);
  const batch = (led.batches || []).find(b => b.paperId === paper);
  A('台账里能找到本批次', !!batch);
  if (batch && batch.items.length >= 3) {
    /* 2026-10-11 修：断言原先按 **causeCode（错因码）** 判"同族"，而实现同日已改为按 **考点(kpoints)**
       交错 ⇒ 不同轴，必然假红（实测 M0019/M0021 界面上都是 S1，但考点并不相同，实际已交错成功）。
       现与实现同轴，并如实交代贪心边界：只有"还有不同族可选"时才避得开，考点高度重叠时做不到 0 残留
       （实测两个孩子数学分别为 4/30、5/79）。残留**必须打印**——静默放行正是本仓反复踩的坑。
       断言判据改为"实交的有交集相邻对 ≤ 原序的"，即证明实现确实在交错而不是退回原序。 */
    const kp = JSON.parse(await ev(`(function(){var ids=${JSON.stringify(batch.items)};var m={};CTB.model.cards.forEach(function(x){m[x.card.id]=x.card.kpoints||[]});return JSON.stringify(ids.map(function(i){return m[i]||[]}))})()`));
    const share = (a, b) => a.length && b.length && a.some(x => b.includes(x));
    const cnt = arr => { let n = 0; for (let i = 1; i < arr.length; i++) if (share(arr[i], arr[i - 1])) n++; return n; };
    if (!kp.some(a => a.length)) console.log('   （豁免交错断言：本批卡都没有考点标签）');
    else {
      const raw = pick.ids.filter(id => batch.items.includes(id));
      const nRaw = cnt(raw.map(id => kp[batch.items.indexOf(id)] || []));
      const nOut = cnt(kp);
      const pairs = [];
      for (let i = 1; i < kp.length; i++) if (share(kp[i], kp[i - 1])) pairs.push(batch.items[i - 1] + '/' + batch.items[i]);
      A('交错组卷：按考点交错，相邻同考点对数不高于原序', nOut <= nRaw,
        `实交 ${nOut} 对 / 原序 ${nRaw} 对` + (pairs.length ? `；残留：${pairs.join(' ')}` : ''));
      if (pairs.length) console.log(`   ⚠ 交错残留 ${nOut}/${kp.length - 1} 对相邻题考点仍有交集（${pairs.join(' ')}）——贪心边界，非失败；归零需在选题阶段控制考点分布`);
    }
  }

  console.log('--- [3] 批改（对/半对）---');
  const r3 = await ev(`CTB.host.mark('批改',{paper:'${paper}',results:${JSON.stringify(pick.ids.map((id, i) => id + '=' + (i === 0 ? '对' : '半对')).join(','))},date:new Date().toISOString().slice(0,10),note:'e2e 回归'})`);
  A('批改 code=0', r3 && r3.code === 0, (r3.out || r3.err || '').slice(0, 260));

  console.log(`--- [4] regen（全量重建，可能 1~2 分钟）---`);
  const t0 = Date.now();
  const st4 = await ev(`CTB.host.regen()`);
  console.log('regen 用时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  A('regen 返回状态包', st4 && Array.isArray(st4.data), st4 && st4.generatedAt);
  await ev(`CTB.model.applyState(${JSON.stringify(st4).replace(/</g, '\\u003c')})`);
  const c4 = await ev(`(function(){var c=${ST};return JSON.stringify({rc:c.reviewCount,rs:c.reviewStatus,nd:c.nextDue,ps:c.passStreak})})()`);
  console.log(`${pick.ids[0]} 批改后 =`, c4);
  const o4 = JSON.parse(c4);
  A('首题 reviewCount=1 / 已复习·通过 / nextDue 已排', o4.rc === 1 && o4.rs === '已复习·通过' && !!o4.nd, c4);
  const c4b = await ev(`(function(){var c=CTB.model.cards.find(function(x){return x.kid===${JSON.stringify(pick.student)}&&x.card.id===${JSON.stringify(pick.ids[1])}}).card;return c.reviewStatus})()`);
  A(`${pick.ids[1]} 半对 → 已复习·半对`, c4b === '已复习·半对', c4b);

  console.log('--- [5] 撤批（回滚本测试批次）---');
  const r5 = await ev(`CTB.host.mark('撤批',{paper:'${paper}'})`);
  A('撤批 code=0', r5 && r5.code === 0, (r5.out || r5.err || '').slice(0, 200));
  const st6 = await ev(`CTB.host.regen()`);
  await ev(`CTB.model.applyState(${JSON.stringify(st6).replace(/</g, '\\u003c')})`);
  const c6 = await ev(`(function(){var c=${ST};return JSON.stringify({rc:c.reviewCount,rs:c.reviewStatus,nd:c.nextDue,ec:c.errorCount})})()`);
  console.log(`${pick.ids[0]} 复原后 =`, c6);
  const o6 = JSON.parse(c6);
  A('复原：reviewCount=0 / 未复习 / nextDue 空 / errorCount 未动', o6.rc === 0 && o6.rs === '未复习' && !o6.nd && o6.ec === 1, c6);
  const ledAfter = await ev(`CTB.host.readFile('_组卷台账.json').then(function(r){var j=JSON.parse(r.text);return j.batches.filter(function(b){return b.paperId==='${paper}'}).length})`);
  A('台账中测试批次已清除', ledAfter === 0, ledAfter);
  CLEANED = true;                    // 已正常撤批，收尾钩子不必再动

  console.log('RESULT=' + (fails ? 'FAIL(' + fails + ')' : 'PASS'));
  ws.close();
  process.exit(fails ? 1 : 0);
})().catch(async e => { await cleanup('异常 ' + (e && e.message)); console.error('EXC', e.stack || e); process.exit(3); });

