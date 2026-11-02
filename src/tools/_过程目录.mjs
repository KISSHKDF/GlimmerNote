/* 过程目录：缓存 / 预览 / 派发单 这类「跑完就该没」的文件，一律**不落库根**。
 *
 * 为什么要有这个模块（2026-11-02，用户质问"过程中的文件不止 _probe 吧？做完就该处理掉"）：
 *   库根（`数据\`）按本项目红线只放**用户真源**与**显式备份**；可过程件住在库根里会带来两件坏事：
 *   ① `tests\run.mjs` 的「真库零写入」把它们判成违规（实测 ⇒ quick 在干净 HEAD 上恒红）；
 *   ② 「什么算用户数据」被搅浑，清理时不敢动手（怕删到真源）。
 *   所以过程件有唯一落点：`%LOCALAPPDATA%\拾光小册\proc\`（可用 GLIMMERNOTE_PROC 覆盖）。
 *
 * 纪律：
 *   ① 过程件**只允许**经 procPath()/procDir() 取路径，不许再 `path.join(ROOT, '_probe', …)`；
 *   ② 过程件不进备份、不进版本包、不需要迁移；
 *   ③ 删掉整个 proc 目录永远是安全的（这是"过程件"的定义）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachedDir = null;

/** 过程目录（不存在则创建）。优先级：GLIMMERNOTE_PROC → %LOCALAPPDATA%\拾光小册\proc → 系统临时目录 */
export function procDir() {
  if (cachedDir) return cachedDir;
  const env = (process.env.GLIMMERNOTE_PROC || '').trim();
  const base = (process.env.LOCALAPPDATA || '').trim() || os.tmpdir();
  cachedDir = env ? path.resolve(env) : path.join(base, '拾光小册', 'proc');
  fs.mkdirSync(cachedDir, { recursive: true });
  return cachedDir;
}

/** 过程件路径：procPath('定位单', 'x.json') */
export function procPath(...parts) {
  return path.join(procDir(), ...parts);
}

/** 供 --help / 报错用：一句话说清过程件落在哪 */
export function describeProcDir() {
  return '过程目录=' + procDir() + (process.env.GLIMMERNOTE_PROC ? '（来自 GLIMMERNOTE_PROC）' : '');
}
