/* 拾光小册 · 待办欠账标注提醒 · 实机界面验证（CDP，2026-11-05）
 *
 * 验的是**用户真正看到的东西**，不是数据：
 *   ① 待办工作台顶部有欠账横幅，写明"你回答过了，但没人把它执行完"；
 *   ② 顶栏副标题报欠账条数；
 *   ③ 勾上「显示已办结」后**真的**渲染出已办结条目（此前恒为空）；
 *   ④ 每条已办结条目显示「你的回答」原文；
 *   ⑤ 欠账条目标红并写明「这条还没被执行」；
 *   ⑥ 页面无 JS 异常、无 console.error。
 *
 * 走**运行区的真实桌面壳**（CDP 9223），读真库，不造假数据。
 * 用法：node 实机验证-欠账标注.cjs
 */
'use strict';
const http = require('http');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]  ' + name); }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + (extra ? '　→ ' + extra : '')); }
}
function get(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
  });
}

(async () => {
  console.log('实机验证：待办欠账标注提醒（运行区桌面壳 CDP）');

  let target = null;
  try {
    const t = JSON.parse(await get('http://127.0.0.1:9223/json/list'));
    target = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
    if (target) console.log('  命中调试口，页面：' + (target.title || '').slice(0, 40));
  } catch (e) { console.log('  ⚠ 调试口不可达：' + String(e.message)); }
  if (!target) { console.log('RESULT=SKIP'); process.exit(0); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  const consoleErrors = [];
  const exceptions = [];
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(JSON.stringify(m.params.exceptionDetails || {}).slice(0, 160)));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleErrors.push(String((m.params.args || []).map(a => a.value || a.description || '').join(' ')).slice(0, 160));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    waiting.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (waiting.has(mid)) { waiting.delete(mid); res({}); } }, 15000);
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const rr = r && r.result && r.result.result;
    return rr ? rr.value : undefined;
  };

  await send('Runtime.enable');
  await sleep(500);

  /* 切到待办工作台（走壳自己的 S.route，location.hash 不触发重绘） */
  await evalJs(`try{ window.CTB && CTB.shell && CTB.shell.route('pending'); }catch(e){}`);
  await sleep(3000);
  const routed = String(await evalJs(`document.querySelector('#view') ? document.querySelector('#view').innerText.slice(0,60) : ''`) || '');
  console.log('  当前视图：' + routed.replace(/\n/g, ' / '));
  await evalJs(`try{ if(window.CTB&&CTB.shell&&CTB.shell.render) CTB.shell.render(); }catch(e){}`);
  await sleep(1800);

  const view = String(await evalJs(`document.querySelector('#view') ? document.querySelector('#view').innerText : '(没有 #view)'`) || '');

  console.log('\n── ① 欠账横幅 ──');
  ok('待办工作台出现欠账相关字样', /欠账|还没被执行|你回答过/.test(view), view.slice(0, 140).replace(/\n/g, ' / '));
  ok('横幅点明「回了但没被执行」的含义', /结论落了库|没人把它执行完|还没被|没被执行/.test(view));

  console.log('\n── ② 顶栏欠账计数 ──');
  /* 顶栏副标题渲染到 #tbSub（shell.js:refreshSub）——查真实 DOM，不只调函数 */
  const tbSub = String(await evalJs(`document.querySelector('#tbSub') ? document.querySelector('#tbSub').textContent : '(拿不到 #tbSub)'`) || '');
  const subFn = String(await evalJs(`(window.CTB&&CTB.views&&CTB.views.pending&&CTB.views.pending.sub)?CTB.views.pending.sub():'(拿不到)'`) || '');
  ok('顶栏副标题含「欠账」', /欠账/.test(tbSub), '#tbSub = ' + tbSub + ' ｜ sub() = ' + subFn);

  console.log('\n── ③ 「显示已办结」真的有内容 ──');
  /* 勾选框状态存在 localStorage 里（可能上一轮已勾上）⇒ 先**取消**再**勾上**，
     否则第二次跑时"勾上后"不变，测不出增量。 */
  await evalJs(`(()=>{const c=document.querySelector('#pdDone'); if(c && c.checked){c.checked=false;c.dispatchEvent(new Event('change'));}})()`);
  await sleep(2000);
  const offCount = Number(await evalJs(`document.querySelectorAll('#view .pd-item').length`) || 0);
  const offText = String(await evalJs(`document.querySelector('#view') ? document.querySelector('#view').innerText : ''`) || '');
  const offHasAnswer = /你的回答/.test(offText);

  await evalJs(`(()=>{const c=document.querySelector('#pdDone'); if(c && !c.checked){c.checked=true;c.dispatchEvent(new Event('change'));}})()`);
  await sleep(3000);
  const after = Number(await evalJs(`document.querySelectorAll('#view .pd-item').length`) || 0);
  const afterText = String(await evalJs(`document.querySelector('#view') ? document.querySelector('#view').innerText : ''`) || '');
  const afterHtml = String(await evalJs(`document.querySelector('#view') ? document.querySelector('#view').innerHTML : ''`) || '');
  ok('不勾「显示已办结」时看不到已办结条目', !offHasAnswer, '未勾时出现「你的回答」=' + offHasAnswer);
  ok('勾上后条目数明显增加', after > offCount, offCount + ' → ' + after);
  ok('渲染出的条目里含已办结状态标记', /已确认/.test(afterText));

  console.log('\n── ④ 显示「你的回答」──');
  ok('页面出现「你的回答」字样', /你的回答/.test(afterText), '样本：' + afterText.slice(0, 120).replace(/\n/g, ' / '));

  console.log('\n── ⑤ 欠账条目标红并说明未执行 ──');
  ok('页面出现「这条还没被执行」', /这条还没被执行/.test(afterText));
  ok('欠账条目带 owes 样式类', /pd-item owes/.test(afterHtml));
  ok('欠账横幅元素存在', /owes-banner/.test(afterHtml));

  console.log('\n── ⑥ 无 JS 异常 ──');
  ok('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
  ok('无 console.error/warning', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  console.log('\n失败项：');
  if (!failures.length) console.log('  （无）');
  else failures.forEach(f => console.log('  ✗ ' + f));
  console.log('\nRESULT=' + (fail ? 'FAIL' : 'PASS') + ' 断言=' + (pass + fail) + ' 通过=' + pass + ' 失败=' + fail);
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('验证脚本异常：' + String(e && e.message || e));
  process.exit(2);
});
