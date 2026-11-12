/**
 * 拾光小册 · 题库发现（`_索引.json` 的扫描）——**零副作用共享模块**（2026-11-12 立，审计 F05）
 *
 * 为什么单独成文件：这段逻辑原先在 **8 个工具里各抄一份**：
 *   `_录题入库` / `_作答门禁` / `_配图门禁` / `_着重号门禁` / `_变式` / `_题干门禁` / `_盲解复核` / `_标记复习`。
 *   2026-11-12 按归一化哈希实测：它们是 **3 种实现** —— 6 处逐字一致、一份**漏了「作业/假期」跳过行**
 *   （`_录题入库.mjs`：于是**入库会往"其余门禁扫不到"的目录里写卡**，而两边自测都绿）、
 *   一份只是排版不同（`_标记复习.mjs`）。
 *   症状形态与判据⑦那次同类：**同一规则多处实现，改一处漏一处，且各自的测试都绿**。
 *
 * ⚠ 本文件必须保持**零副作用**（不解析 argv、不读库根）：它被 8 个 CLI 工具 import，
 *   一旦带上启动副作用，import 方就会继承（本仓已两次踩到，见 L-729）。
 *   判断方法：`Select-String -Path src\tools\_题库发现.mjs -Pattern 'parseArgs\(|libraryRoot\(|process\.argv'` 必须 0 命中。
 */
import fs from 'fs';
import path from 'path';

/** 「作业 / 假期」类目录：**原始试卷档案**，不是题库卡目录 ⇒ 不进扫描。
 *  （2026-11-12 之前 `_录题入库.mjs` 漏了这一行，导致它与其余 7 处口径不一致。） */
export const SKIP_DIR_RE = /(作业|假期)/;

/** 递归收集库里的全部 `_索引.json` 路径。
 *
 *  ⚠ 目录名以 `_` / `.` 开头 ⇒ 跳过**目录**；但**文件**要单独判 `_索引.json`
 *    —— 否则 `_索引.json` 自己被 `_` 前缀规则挡掉，一个学生都找不到。 */
export function indexFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) { if (e.name === '_索引.json') acc.push(path.join(dir, e.name)); continue; }
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    if (SKIP_DIR_RE.test(e.name)) continue;
    indexFiles(path.join(dir, e.name), acc);
  }
  return acc;
}
