/* 拾光小册 · 版本号**不在这里写死**。
   唯一真源 = 仓库根 VERSION.json；打包时 scripts\build-release.ps1 生成 app\版本.js，
   用 script 标签注入 window.__GNOTE_VERSION__（file:// 下浏览器禁止 fetch 本地 json，只能这样）。
   开发态（没打包、没有 版本.js）显示 dev —— 写死具体版本号就又多一个源头，正是要消灭的东西。 */
window.CTB = window.CTB || {};
(function () {
  var meta = window.__GNOTE_VERSION__ || null;
  CTB.version = (meta && meta.version) || 'dev';
  CTB.buildChannel = 'stable';   // trial | stable
})();
