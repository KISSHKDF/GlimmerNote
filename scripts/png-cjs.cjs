'use strict';
/* png-cjs.cjs — scripts/make-png.mjs 的 CommonJS 桥（★ 2026-10-25）
 *
 * 为什么需要：tests\ 下全是 .cjs（CommonJS），而 PNG 编码器按仓库惯例写成 ESM (.mjs)。
 * Node 没有"从 cjs 同步 import ESM"的稳定 API，动态 import() 在这里又是异步多米诺。
 * 与其把编码器改成 cjs（scripts 下 .mjs 是工具链惯例），不如加这座 8 行的桥：
 * 编码器本体只在 make-png.mjs 一处，本文件只做转发——不存在第二实现。
 * 风险与守卫：若 make-png.mjs 被移动/改名，require 本文件会在启动时同步抛
 * ERR_MODULE_NOT_FOUND（不会静默空图）；synthetic-lib-shape.cjs 的门禁会抓到。 */
const path = require('path');
const M = `${path.resolve(__dirname, 'make-png.mjs')}`;
let mod = null;
function load() {
  if (mod) return mod;
  /* 创建 ESM 模块的 require 侧句柄：Node ≥ 22 支持 require(esm)；
     老版本走 spawn 自举太重——直接报清楚错，让门禁红得明白。 */
  try {
    mod = require(M);
  } catch (e) {
    throw new Error('[png-cjs] 无法加载 ESM 编码器 ' + M + '：' + e.message +
      '\n  （Node ≥ 22 直接 require(.mjs)；更老版本请升级 Node ≥ 18 并检查文件存在）');
  }
  return mod;
}
module.exports = {
  get pngGray() { return load().pngGray; },
  get pngRGB() { return load().pngRGB; },
  get paperPage() { return load().paperPage; },
  get figureGraph() { return load().figureGraph; },
};
