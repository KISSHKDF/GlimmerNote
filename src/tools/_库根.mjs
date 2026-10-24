/* 拾光小册 · 库根解析（唯一实现）
 *
 * 为什么要有这个文件：
 *   老代码每个工具都写 `const ROOT = path.dirname(fileURLToPath(import.meta.url))`，
 *   即"工具在哪儿，库就在哪儿" —— 因为那时程序和用户数据**装在同一个目录**里。
 *   程序与数据分家之后（架构设计 §2.1），工具住在 <AppRoot>\tools\，
 *   而用户数据在 <AppRoot>\..\数据\，两者不再是一个地方。
 *
 * 两个根（与 C# 壳 CTBShellV2.cs 的 AppRoot / DataRoot 完全同口径）：
 *   AppRoot  = 工具目录的上一级（exe 所在目录）—— 程序，只读
 *   DATA     = 用户库 —— 可读可写，所有真源只在这里
 *
 * DATA 优先级（顺序与壳一致，改一处必须同时改两处）：
 *   CTB_DATA 环境变量 > <AppRoot>\..\数据 > <AppRoot>\数据 > AppRoot（老布局：程序与数据同目录）
 *
 * 用法：
 *   import { libraryRoot, toolPath, TOOL_DIR } from './_库根.mjs';
 *   const ROOT = libraryRoot();          // 数据根：所有 _索引.json / _待确认.json 都从它取
 *   toolPath('_待确认.mjs')              // 兄弟工具：永远指向本目录，不是数据目录
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** 本工具所在目录（包内是 <AppRoot>\tools） */
export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 程序目录（工具目录的上一级） */
export const APP_ROOT = path.resolve(TOOL_DIR, '..');

/* 界面根：**真的放着 index.html 的那个目录**。
   为什么要单独算：两种布局不一样 ——
     · 发布包：<AppRoot>\index.html、<AppRoot>\tools\*.mjs   ⇒ 界面根 = AppRoot
     · 开发区：<仓库>\src\app\index.html、<仓库>\src\tools\*.mjs ⇒ 界面根 = AppRoot\app
   静态服务与"前端在哪儿"一律问它，别再各自猜。 */
export const WEB_ROOT = (() => {
  for (const cand of [APP_ROOT, path.join(APP_ROOT, 'app')]) {
    try { if (fs.existsSync(path.join(cand, 'index.html'))) return cand; } catch { }
  }
  return APP_ROOT;
})();

/** 兄弟工具/脚本的绝对路径（永远在工具目录里，与用户数据无关） */
export function toolPath(name) {
  return path.join(TOOL_DIR, name);
}

/** 用户库根（缓存一次，避免同一进程内因环境变量变动产生两个答案） */
let cached = null;

export function libraryRoot() {
  if (cached) return cached;
  cached = resolveLibraryRoot();
  return cached;
}

function resolveLibraryRoot() {
  // ① CTB_DATA 环境变量（测试 / 库放别处 / 多库切换）
  const env = process.env.CTB_DATA;
  if (env && String(env).trim()) {
    const p = path.resolve(String(env).trim());
    if (!fs.existsSync(p)) {
      throw new Error('[库根] CTB_DATA 指向的目录不存在：' + p);
    }
    return p;
  }
  // ② <AppRoot>\..\数据   （标准布局：运行区 app\ 与 数据\ 并列）
  const up1 = path.join(APP_ROOT, '..', '数据');
  if (isDir(up1)) return path.resolve(up1);
  // ③ <AppRoot>\数据     （程序目录里带一个数据子目录）
  const inApp = path.join(APP_ROOT, '数据');
  if (isDir(inApp)) return path.resolve(inApp);
  // ④ 老布局：程序与数据同目录（迁移期兼容，不改老库一行）
  return APP_ROOT;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 供 --help / 报错用：一句话说清当前解析到了哪 */
export function describeRoots() {
  return '程序目录=' + APP_ROOT + '　库目录=' + libraryRoot() +
    (process.env.CTB_DATA ? '（来自 CTB_DATA）' : '（自动识别）');
}
