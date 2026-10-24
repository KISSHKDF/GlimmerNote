/* 错题本 2.0 · 启动 + 全局错误捕获
 *
 * ★ 2026-10-12 加全局错误捕获（为什么必须加）：
 *   `tests\run.mjs` 的注释如实记录过一个真 bug：paper.js 台账异步写 DOM 的竞态造成
 *   **unhandled rejection**，界面看着正常、S.render 的 try/catch 接不住。
 *   在生产环境里这类错误**用户完全看不到** —— 只觉得"界面卡住不动"，
 *   日志里也没有（前端没有任何全局监听，错误直接消失）。
 *   现在：捕获后同时做三件事 —— 写 console（可被测试抓）、
 *   给用户一个可见提示（toast，不打断当前操作）、并把最近若干条存进 localStorage
 *   （下次打开 help 页可查看，排查时不用复现）。
 *   注意：**不吞异常**（不 preventDefault），只做记录与告知。
 */
(function () {
  const U = CTB.util, H = CTB.host, M = CTB.model, S = CTB.shell;

  /* ---------- 全局错误捕获 ---------- */
  const ERR_KEY = 'ctb2.errlog';
  function recordErr(kind, msg, src) {
    try {
      const list = JSON.parse(localStorage.getItem(ERR_KEY) || '[]');
      list.push({ t: new Date().toISOString(), kind: kind, msg: String(msg || '').slice(0, 500), src: src || '' });
      localStorage.setItem(ERR_KEY, JSON.stringify(list.slice(-20)));   // 只留最近 20 条
    } catch (e) { /* localStorage 不可用就算了，不能因记录失败而再抛 */ }
  }
  CTB.errors = {
    list() { try { return JSON.parse(localStorage.getItem(ERR_KEY) || '[]'); } catch (e) { return []; } },
    clear() { try { localStorage.removeItem(ERR_KEY); } catch (e) { } },
  };

  function tellUser(text) {
    try {
      // 优先走界面自己的提示条（不打断当前操作）；壳不可用时退回控制台
      if (S && typeof S.toast === 'function') S.toast(text, 'error');
      else console.warn('[拾光小册] ' + text);
    } catch (e) { console.warn('[拾光小册] ' + text); }
  }

  window.addEventListener('error', function (e) {
    var msg = (e && e.message) || '未知错误';
    var src = (e && e.filename ? e.filename : '') + ':' + (e && e.lineno || '');
    console.error('[全局错误] ' + msg + ' @ ' + src, e.error || '');
    recordErr('error', msg, src);
    tellUser('页面出了点问题（' + msg + '），已记下，不会影响已保存的数据。');
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var msg = (r && (r.message || r)) || '未处理的异步错误';
    console.error('[未处理的 Promise 拒绝] ' + msg, r);
    recordErr('unhandledrejection', msg);
    tellUser('有个后台操作没成功（' + msg + '），已记下。');
  });

  async function boot() {
    const msg = U.$id('bootMsg');
    try {
      msg.textContent = '探测数据通道…';
      await H.init();
      msg.textContent = H.mode === 'shell' ? '桌面壳直连，读取 _状态.json…'
        : H.mode === 'server' ? '本机服务端在线，运行时取数…'
          : '未找到数据通道';
      const st = await H.getState();
      M.applyState(st);
      /* 2026-10-12（BUG-11 配套）：篮子身份从裸 id 换成 kid|id，这里做一次性迁移，
         否则用户上次存的组卷篮会全部失效。放在 applyState 之后（需要卡片清单）、
         mount 之前（迁移完再渲染，首屏就是对的）。 */
      try { M.basketMigrate(); } catch (e) { console.warn('basketMigrate:', e); }
      U.$id('boot').remove();
      U.$id('app').hidden = false;
      S.mount();
      if (!U.lsGet('ctb2.seen', false)) {
        U.lsSet('ctb2.seen', true);
        setTimeout(() => S.help(), 700);
      }
      M.on(() => { /* 状态变化时的全局副作用钩子（当前由显式 render 承担） */ });
      /* v2.5（2026-10-10）：磁盘状态变了界面得自己跟上——见 shell.js S.autoReload 的来由。 */
      window.addEventListener('focus', () => S.autoReload());
      document.addEventListener('visibilitychange', () => { if (!document.hidden) S.autoReload(); });
    } catch (e) {
      recordErr('boot', e && e.message);
      msg.innerHTML = '❌ ' + U.esc(e.message || String(e)) +
        '<br><span style="font-size:12px">请双击 <b>拾光小册.exe</b> 打开。</span>';
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();