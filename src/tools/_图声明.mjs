#!/usr/bin/env node
/**
 * 拾光小册 · 「录题任务声明了图、但卡上没图」的判定（唯一实现）
 *
 * 起因（2026-11-26 用户报障「M0077 裁图与题目完全不对」引出的相邻缺陷）：
 *   M0077 的题干写着「其图象如图所示」，可卡目录里**没有任何图**。
 *   查台账：`_配图台账.json` 里 `need=false`；查录题任务单 `_录题\t-*.json`：
 *   `hasFigure=true` 且给了 `figBbox` ⇒ **图本来是要裁的，但没裁出来**。
 *
 * 为什么这类"图没落地"能一路溜过去（实测，链上三个洞）：
 *   ① 任务单说 `hasFigure=true` ⇒ 入库器会去裁 `figBbox`；
 *      但**插图与题干不在同一页**时（M0077：题干在 p1、图在 p2），
 *      裁图用的源页永远是题干那页 ⇒ 图永远裁不出来 ⇒ `cropFigure` 失败 ⇒
 *      台账被写成 `need=false` ⇒ **看起来像"这张卡不需要图"**；
 *   ② 台账 `need=false` ⇒ 配图门禁判「无需图」⇒ 放行；
 *   ③ 题干提到"如图"但没登记 ⇒ 那条判据要靠**关键词**发现，
 *      而 `need=false` 已经登记过了 ⇒ "提到图/表但未登记"也不触发。
 *   ⇒ 三条判据互相掩护 ⇒ 一张**没有图的题**安安稳稳躺在库里。
 *
 * 本模块的判据（**可判定、零依赖**）：
 *   「录题任务单里这张卡声明了 hasFigure=true」∧「配图台账里这张卡 need=false」
 *   ⇒ **声明与落地不一致** ⇒ 图没落地 ⇒ 报。
 *
 * ⚠ 为什么用「任务单 × 台账」两条记录对账，而不是去 OCR 图：
 *   ① 两条都是**结构化事实**（JSON 字段），机器可判、无主观成分；
 *   ② OCR 在本机不可用（零依赖纪律），而"图有没有"这件事本身就该由**入库时声明**负责；
 *   ③ 任务单是**录题当时的原始声明**（最权威的"这题有图"证据），
 *      台账是**落地后的现状** ⇒ 两者的差集就是"该有却没有"。
 *
 * 覆盖范围：只有**录题任务单里出现过**的卡才可能被判（老卡没有任务单 ⇒ 不判）。
 *   ⇒ 这是**渐进式**判据：它只抓"录过题、声明过有图、却没落地"的卡，
 *     不去judge那些没有任务单的历史卡（避免误报一片）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 读 JSON（剥 BOM；坏了返回 null 而不是抛） */
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * 收集录题任务单里「声明有图」的卡。
 * @param {string} root 库根
 * @returns {Map<string, {hasFigure:boolean, figBbox?:number[], taskId:string, title:string}>}
 *   key = 卡目录名去掉前缀（`M0077-xxx` ⇒ `xxx`，与卡的 dir 后半段同口径）
 */
export function taskFigures(root) {
  const out = new Map();
  const dir = path.join(root, '_录题');
  if (!fs.existsSync(dir)) return out;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const j = readJson(path.join(dir, f));
    if (!j) continue;
    for (const c of (j.cards || [])) {
      if (!c || !c.title) continue;
      const key = String(c.title);
      /* 一题多卡时，标题可能重复 ⇒ 只记第一条有图的（避免后来的覆盖掉） */
      if (out.has(key)) continue;
      out.set(key, {
        hasFigure: c.hasFigure === true,
        figBbox: Array.isArray(c.figBbox) ? c.figBbox.slice() : null,
        taskId: f,
        title: key,
      });
    }
  }
  return out;
}

/** 从卡的目录名去掉编号前缀：`M0077-气压安全条件误读` ⇒ `气压安全条件误读` */
export function titleOfDir(dir) {
  return String(dir || '').replace(/^[A-Za-z]+\d+-/, '');
}

/**
 * 判定：台账说"无需图"、但录题任务单说"有图" ⇒ 图没落地。
 * @param {object} card  索引条目（要含 id / dir）
 * @param {object} entry 配图台账里这张卡的条目（可能为 undefined）
 * @param {Map} figs     taskFigures() 的结果
 * @returns {{declared:boolean, landed:boolean, ok:boolean, msg:string, taskId:string}|null}
 *   返回 null = 本卡不在本判据的覆盖范围内（没有任务单 / 任务单没说有图 / 台账说需要图）。
 */
export function figureDeclaredButMissing(card, entry, figs) {
  const t = figs.get(titleOfDir(card && card.dir));
  if (!t || !t.hasFigure) return null;               // 任务单没说有图 ⇒ 不判
  if (entry && entry.need === true) return null;     // 台账说需要图 ⇒ 已落地（或门禁另有判据管）
  return {
    declared: true,
    landed: false,
    ok: false,
    taskId: t.taskId,
    figBbox: t.figBbox,
    msg: `录题任务单 ${t.taskId} 声明这张卡有图（hasFigure=true${t.figBbox ? '，figBbox=' + JSON.stringify(t.figBbox) : ''}），` +
      '但配图台账记的是 need=false ⇒ **图没有落地**。' +
      '若图印在**另一页**（跨页插图），请用 `改卡` 补上 `figSrcPage`（插图自己的源页）+ `figBbox`，再重裁。',
  };
}
