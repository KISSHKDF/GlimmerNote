#!/usr/bin/env node
/**
 * 拾光小册 · 配图清洗工具（v1.0）—— 「剪自原卷的图怎么救」的机器实现
 *
 * 背景（2026-11-23 用户裁定）：配图的三级来源是
 *      ① 上网找图（公开题库的干净印刷版原图）→ ② 清洗裁图 → ③ 矢量重画
 *   第 ② 级的"清洗"此前**只存在于人的手工操作**（C0003 那次做了「红笔去除 + 对比度
 *   拉伸 + lanczos 2x + unsharp」，但没有任何代码），所以同一条路别人走不了、也没法复核。
 *   本工具把清洗做成**可跑、可复核、零依赖**的一条命令。
 *
 * 零依赖：本仓纪律是"不装外部依赖"。图像处理用 **Windows 自带 System.Drawing**，
 *   经由临时 PowerShell 脚本执行（同 `_录题入库.mjs` 的裁图做法：PS 5.1 读无 BOM 的
 *   UTF-8 会按 GBK 解码 ⇒ 脚本必须带 BOM；用 -File 而非 -Command 内联）。
 *
 * 五个动作（可组合）：
 *   --去红笔      去除红色系笔画（红笔批改/红字标记），保留印刷体
 *   --去黑笔      去除**黑色**手写笔画（可选，默认关——印刷体也是黑的，误伤风险高）
 *   --矫正        透视矫正 + 旋转摆正（把拍照歪斜/弯曲的页面拉正）
 *   --增强        去噪 + 对比度拉伸 + 锐化
 *   --放大 2      放大到目标倍数（lanczos 风格高质量插值）
 *
 * 用法：
 *   node src\tools\_配图清洗.mjs --in <原图> --out <输出> [动作...] [--放大 N] [--最小宽 N]
 *   node src\tools\_配图清洗.mjs --in <原图> --探测          # 只分析不写盘：报红笔/黑笔占比与尺寸
 *
 * ⚠ **不改数据区**：本工具只读写**用户显式给的** --in / --out 路径。
 *   批量整改存量卡时，调用方必须自己把输出写到卡目录，并先备份。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { parseArgs, COMMON_VALUE_FLAGS } from './_参数.mjs';

const argv = process.argv.slice(2);
const { opt } = parseArgs(argv, {
  valueFlags: [...COMMON_VALUE_FLAGS, 'in', 'out', '放大', '最小宽', '裁剪', '抹除', '裁剪后最小宽'],
  boolFlags: ['探测', '边缘墨迹', '去红笔', '去黑笔', '矫正', '增强', '锐化', '去噪', 'help', 'h'],
});

if (opt.help || opt.h || (!opt['in'] && !opt['探测'] && !opt['边缘墨迹'])) {
  console.log([
    '拾光小册 · 配图清洗工具 v1.0（零依赖 · System.Drawing）',
    '',
    '  node src\\tools\\_配图清洗.mjs --in <原图> --out <输出> [动作...]',
    '  node src\\tools\\_配图清洗.mjs --in <原图> --探测        （只分析：红/黑笔占比、尺寸、包围盒）',
    '  node src\\tools\\_配图清洗.mjs --in <原图> --边缘墨迹    （只分析：四条边界上的暗像素数 ⇒ 判"图是否被切在边界上"）',
    '',
    '  --去红笔    去除红色系笔画（红笔批改），保留印刷体',
    '  --去黑笔    去除黑色手写笔画（默认关：印刷体也是黑的，误伤风险高）',
    '  --去噪      3x3 中值滤波，去扫描噪点（保线条）',
    '  --增强      对比度拉伸（2%–98% 分位）',
    '  --锐化      unsharp 锐化（**默认关**：扫描件会放大半调网点成噪点）',
    '  --裁剪 x,y,w,h   按 0~1 归一化框裁剪（裁掉压边的字迹/留白）',
    '  --放大 N    放大到 N 倍（高质量插值）',
    '  --最小宽 N  放大到宽度不小于 N 像素（与 --放大 二选一，--最小宽 优先）',
    '  --裁剪后最小宽 N  裁剪完若仍不足 N 宽则再放大（**注意：--最小宽 是"先缩放后裁剪"**）',
    '',
    '  例：去红笔 + 去噪 + 裁掉下边字迹 + 放大到 1200 宽',
    '    node src\\tools\\_配图清洗.mjs --in a.jpg --out b.jpg --去红笔 --去噪 --裁剪 0,0,1,0.92 --最小宽 1200',
  ].join('\n'));
  process.exit(opt.help || opt.h ? 0 : 2);
}

if (!opt['in']) { console.error('✖ 缺少 --in <原图>'); process.exit(2); }
const IN = String(opt['in']);
if (!fs.existsSync(IN)) { console.error('✖ 原图不存在：' + IN); process.exit(2); }
if (!opt['探测'] && !opt['边缘墨迹'] && !opt.out) { console.error('✖ 缺少 --out <输出>（或用 --探测 只分析）'); process.exit(2); }

/* ───────────────── 边缘墨迹（只分析，不写盘） ─────────────────
 * ⚠ 放在 PS_EDGE 定义之后调用（const 有 TDZ，见文件末尾的 --边缘墨迹 分支）。 */

/* ───────────────── PowerShell 图像处理脚本（零依赖） ─────────────────
 * 一律写成参数化的 .ps1 临时文件执行：
 *   ① -Command 内联拼字符串 ⇒ 路径里的引号/反斜杠要手工转义，是"看起来对、偶发失败"的坑；
 *   ② PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解码 ⇒ 必须带 BOM（AGENTS.md 红线7）。 */
const PS_HEAD = [
  'param([string]$In,[string]$Out,[int]$Mode,[double]$Scale,[int]$MinW,[int]$Threshold,[int]$MinBlob)',
  'Add-Type -AssemblyName System.Drawing',
  '$ErrorActionPreference = "Stop"',
  '$img=[System.Drawing.Image]::FromFile($In)',
  '$W=$img.Width; $H=$img.Height',
  'if($MinW -gt 0 -and $W -lt $MinW){ $k=[double]$MinW/$W; $W=[int]([math]::Round($W*$k)); $H=[int]([math]::Round($H*$k)) }',
  'elseif($Scale -gt 0 -and [math]::Abs($Scale-1.0) -gt 0.001){ $W=[int]([math]::Round($W*$Scale)); $H=[int]([math]::Round($H*$Scale)) }',
  'if($W -lt 1){$W=1}; if($H -lt 1){$H=1}',
  '$bmp=New-Object System.Drawing.Bitmap($W,$H)',
  '$g=[System.Drawing.Graphics]::FromImage($bmp)',
  '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
  '$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
  '$g.DrawImage($img,0,0,$W,$H)',
  '$g.Dispose()',
  '$img.Dispose()',
];

/* Mode 位：1=去红笔 2=去黑笔 4=对比度拉伸 8=锐化 16=去噪 */
const MODE_RED = 1, MODE_BLACK = 2, MODE_ENH = 4, MODE_SHARP = 8, MODE_DENOISE = 16;

function psRun(lines, args) {
  const body = Array.isArray(lines) ? lines.join('\r\n') : String(lines);
  const tmp = path.join(os.tmpdir(), 'gn-figclean-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.ps1');
  try {
    fs.writeFileSync(tmp, '﻿' + body, 'utf8');
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp, ...args],
      { encoding: 'utf8', stdio: 'pipe' });
    return String(out || '').trim();
  } catch (e) {
    const msg = (e && e.stderr ? String(e.stderr) : String(e && e.message || e)).trim();
    throw new Error('图像处理失败：' + msg.slice(0, 400));
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
  }
}

/* ───────────────── ① 探测：红/黑笔像素分析（连通域 + 包围盒） ─────────────────
 * 为什么用连通域而不是"单像素判红"：抗锯齿边缘的笔画，颜色被背景稀释成粉/浅红，
 * 单像素判据会漏掉大半；而一根红线可能有几百个像素，也可能只有几十个（细线）。
 * 连通域能回答"**这一簇红色像素是不是一根成形的笔画**"，这才是泄答案的判据。 */
const PS_PROBE = [
  'param([string]$In,[int]$Threshold,[int]$MinBlob)',
  'Add-Type -AssemblyName System.Drawing',
  '$ErrorActionPreference = "Stop"',
  '$img=[System.Drawing.Image]::FromFile($In)',
  '$W=$img.Width; $H=$img.Height',
  '$bmp=New-Object System.Drawing.Bitmap($W,$H)',
  '$g=[System.Drawing.Graphics]::FromImage($bmp)',
  '$g.DrawImage($img,0,0,$W,$H)',
  '$g.Dispose(); $img.Dispose()',
  '$isRed=New-Object bool[] ($W*$H)',
  '$isBlk=New-Object bool[] ($W*$H)',
  '$redN=0; $blkN=0; $redStrict=0',
  'for($y=0;$y -lt $H;$y++){ for($x=0;$x -lt $W;$x++){',
  '  $c=$bmp.GetPixel($x,$y)',
  '  $r=$c.R; $gg=$c.G; $b=$c.B',
  '  # ★ 2026-11-23 严格口径红味计数（R-G>=25 且 R-B>=15）：区分"真红笔"与"泛黄旧纸"。',
  '  #   实测 C0003 的干净扫描页红味占 1.58% ⇒ 旧口径（R-G>=15）会把旧纸算成红笔 ⇒ 假红。',
  '  #   实测分界：旧纸 R-G=18~19；真红笔 R-G>=25（褪色）/ >=60（洋红）。',
  '  if($r -ge 120 -and ($r-$gg) -ge 25 -and ($r-$b) -ge 15){ $redStrict++ }',
  '  # 红笔判据（2026-11-23 四轮修正后定版 → 五轮增补「浅粉」类）：并集 —— 三类都判红。',
  '  #   背景：要挡住三种像红但不是红的颜色，又不能漏掉真红笔。实测四类样本：',
  '  #     · 真红笔·褪色（M0070 卷面） R=255 G=207 B=221 => G/R=0.81 B/R=0.87  <- 判红',
  '  #     · 真红笔·纯红（合成夹具）   R=185 G=67  B=63  => G/R=0.36 B/R=0.34  <- 判红',
  '  #     · 橙棕印刷边缘（套色偏移） R=203 G=143 B=81  => G/R=0.70 B/R=0.40  <- 不判红',
  '  #     · 灰/褐抗锯齿边           R=194 G=164 B=144 => G/R=0.85 B/R=0.74  <- 不判红',
  '  #   注意：单一线性阈值必然漏一类（褪色红 B/R≈0.87，纯红 B/R≈0.34 —— B 上是对立的）。',
  '  #   故判三次取并集：',
  '  #     A. 褪色红：B >= R*0.70 且 G <= R*0.82',
  '  #     B. 纯红  ：B <= R*0.45 且 G <= R*0.45（R 远大于 G、B 也远小于 R => 强饱和红）',
  '  #     C. 浅粉  ：★ 2026-11-23 第五轮补（实测 M0061 孩子用红笔画的曲线洗不掉）',
  '  #        R >= 120 且 R-G >= 15 且 R-B >= 10 且 |G-B| <= R*0.06',
  '  #        实测样本：R=246 G=227 B=231（G/R=0.92 ⇒ A 不满足、B 更不满足）——',
  '  #        扫描/压缩把细红线摊成**极浅的粉**，A 的 G<=0.82R 判不到 ⇒ 红曲线留在图上',
  '  #        （实测那张图「成形红笔 0 个」却肉眼可见红曲线 ⇒ 重做卷泄答案）。',
  '  #        区分「浅粉」与「灰褐抗锯齿边」的判据 = **|G-B|**：',
  '  #          浅粉  R=246 G=227 B=231 => |G-B|=4  (R*0.06=14.8 => 判粉 ✓)',
  '  #          灰褐  R=194 G=164 B=144 => |G-B|=20 (R*0.06=11.6 => 不判 ✓)',
  '  #        橙棕  R=203 G=143 B=81  => |G-B|=62 (不判 ✓)',
  '  #        纸张  R=255 G=254 B=250 => R-G=1 < 15  (不判 ✓)',
  '  if($r -ge 85 -and ($r-$gg) -ge 25){',
  '    $isFaded = ($b -ge ($r*0.70)) -and ($gg -le ($r*0.82))',
  '    $isPure  = ($b -le ($r*0.45)) -and ($gg -le ($r*0.45))',
  '    # ★ 2026-11-23 第七轮：褪色红加**中性排除**（实测 M0070 假红）。',
  '    #   实测 M0070（网上题库的干净印刷版原图，无任何笔迹）被判「成形红笔 4 处」——',
  '    #   实际是**黑色印刷体的抗锯齿边缘**：采样 R=163 G=127 B=113、|G-B|=14。',
  '    #   真红笔即使褪色，B 与 G 也**不会差这么多**（红笔是"红"，B/G 都低于 R）。',
  '    #   故：褪色红再要求 |G-B| <= R*0.12（163*0.12=19.6 ⇒ 14 仍会中）——不够。',
  '    #   改用**B 必须明显低于 R**（B <= R*0.92）来排掉"抗锯齿黑"：',
  '    #     抗锯齿黑 B=113 / R=163 ⇒ B/R=0.69 ⇒ 仍会中 ✗',
  '    #   ⇒ 光靠比值排不掉。真正的分界是 **B 相对 G 的位置**：',
  '    #     真红（褪色）R=255 G=207 B=221 ⇒ B > G（B/G=1.07）',
  '    #     抗锯齿黑   R=163 G=127 B=113 ⇒ B < G（B/G=0.89）',
  '    #   抗锯齿黑是"黑字压在纸上"的混色 ⇒ B 不会高于 G；',
  '    #   红笔是"红字"⇒ 纸的白底透出来 ⇒ B 会略高于 G。',
  '    #   故褪色红加一条：**B >= G**（容差 2）。',
  '    $isFaded = ($b -ge ($r*0.70)) -and ($gg -le ($r*0.82)) -and ($b -ge ($gg - 2))',
  '    if($isFaded -or $isPure){ $isRed[$y*$W+$x]=$true; $redN++ }',
  '  }',
  '  # C. 浅粉  ：R >= 120 且 R-G >= 25 且 R-B >= 20 且 |G-B| <= R*0.06',
  '  #        （第四类：极浅的粉，扫描/压缩把细红线摊出来的）',
  '  #        ★ 2026-11-23 第八轮：**R-G >= 25**（原为 15）——实测 C0003 的干净旧纸',
  '  #          整页 R=201 G=187 B=186（R-G=14、|G-B|=0）被原判据全页判红（7697 像素、',
  '  #          1.58%）⇒ 假红。旧纸的 R-G 只有 14~16，真红笔的浅粉 R-G >= 25。',
  '  elseif($r -ge 120 -and ($r-$gg) -ge 25 -and ($r-$b) -ge 20 -and ([math]::Abs($gg-$b) -le ($r*0.06))){',
  '    $isRed[$y*$W+$x]=$true; $redN++',
  '  }',
  '  # D. 洋红红（★ 2026-11-23 第六轮补，实测 M0061 孩子手画的红色曲线）：',
  '  #        实测样本 R=248 G=72 B=109（B > G ⇒ 偏洋红/品红）。',
  '  #        前三条判据全不满足：A 褪色红要 B>=R*0.70（109 < 174 ✗）；',
  '  #          B 纯红要 G<=R*0.45（72 > 112 ✗）；C 浅粉要 |G-B|<=R*0.06（37 > 15 ✗）。',
  '  #        ⇒ 红曲线原样留在图上（实测「成形红笔 0 个」而肉眼清清楚楚）。',
  '  #        判据：R 远大于 G（R-G >= 60）**且 G 很低**（G <= R*0.45）',
  '  #        且 R 远大于 B（R-B >= 40）且 B 不是极深（B >= R*0.20）。',
  '  #        "G <= R*0.45" 这一条是**排掉橙棕套色偏移**的关键：',
  '  #          洋红红 R=248 G=72  => G/R=0.29 ✓ 判红',
  '  #          橙棕   R=203 G=143 => G/R=0.70 ✗ 不判红',
  '  #          灰褐   R=194 G=164 => R-G=30 < 60 ✗ 不判红',
  '  elseif($r -ge 120 -and ($r-$gg) -ge 60 -and ($gg -le ($r*0.45)) -and ($r-$b) -ge 40 -and ($b -ge ($r*0.20))){',
  '    $isRed[$y*$W+$x]=$true; $redN++',
  '  }',
  '  # 黑笔（可疑手写）：很暗且近中性（R,G,B 极差小）——印刷体正文也命中，故只是"可疑"',
  '  elseif($r -le 90 -and $gg -le 90 -and $b -le 90 -and ([math]::Abs($r-$gg) -le 22) -and ([math]::Abs($r-$b) -le 22)){ $isBlk[$y*$W+$x]=$true; $blkN++ }',
  '} }',
  '$bmp.Dispose()',
  'function BlobCount($mask,$total){',
  '  $seen=New-Object bool[] $total; $blobs=@(); $stack=New-Object System.Collections.Stack',
  '  for($i=0;$i -lt $total;$i++){',
  '    if(-not $mask[$i] -or $seen[$i]){continue}',
  '    $stack.Push($i); $seen[$i]=$true; $cnt=0; $minx=999999;$maxx=-1;$miny=999999;$maxy=-1',
  '    while($stack.Count -gt 0){',
  '      $p=[int]$stack.Pop(); $px=$p % $W; $py=[int]($p / $W); $cnt++',
  '      if($px -lt $minx){$minx=$px}; if($px -gt $maxx){$maxx=$px}; if($py -lt $miny){$miny=$py}; if($py -gt $maxy){$maxy=$py}',
  '      foreach($d in @(-1,1,-$W,$W)){',
  '        $q=$p+$d',
  '        if($q -lt 0 -or $q -ge $total){continue}',
  '        if($mask[$q] -and -not $seen[$q]){ $seen[$q]=$true; $stack.Push($q) }',
  '      }',
  '    }',
  '    if($cnt -ge $MinBlob){ $blobs += [pscustomobject]@{ n=$cnt; x0=$minx; y0=$miny; x1=$maxx; y1=$maxy } }',
  '  }',
  '  return $blobs',
  '}',
  '$redBlobs=BlobCount $isRed ($W*$H)',
  '$blkBlobs=BlobCount $isBlk ($W*$H)',
  '$redBig=@($redBlobs | Where-Object { $_.n -ge $Threshold })',
  '$blkBig=@($blkBlobs | Where-Object { $_.n -ge $Threshold })',
  /* ★ 2026-11-23 结构性判据：**红笔是"细长的一笔"**，而彩色印刷边缘是"字母周围的短斑块"。
     纯色相判据在题库原图上仍有误报（彩色字母的套色偏移边缘也会偏红）。
     过滤三关：
       ① 长宽比：真红笔横线 21×3（比 7.0）；边缘斑块 3×9（比 0.33）⇒ 要么横长要么竖长。
       ② **绝对宽度 ≥ 3 像素**：实测残余误报是 2×9 的竖边（字母 C 的套色偏移），
          宽度只有 2 像素 ⇒ 抗锯齿边缘，不是笔画。真红笔实测宽 3 像素（21×3）。
       ③ **面积 ≤ 400 像素**：真红笔是一"笔"，面积有限（实测 8–258 像素）；
          面积上千的"红簇"是**印刷偏色/水印的大片区域**（实测 C0016 出现 2588 / 2854 / 3337
          像素的簇）⇒ 不是笔迹，不该报红。
     ⚠⚠ **变量名必须避开 $W / $H**（2026-11-23 实测踩到）：
        PowerShell **变量名不区分大小写** ⇒ Where-Object 块里的 `$w=` / `$h=`
        会把外层的 `$W`（图宽）/`$H`（图高）**直接改掉** ⇒ 循环边界变成 8×1，
        扫描只跑了极小一块，统计全错（实测输出「尺寸：8x1」「红色像素 862%」）。
        故这里一律用 `$bw` / `$bh`（bbox width/height）。 */
  '$redStroke=@($redBig | Where-Object { $bw=$_.x1-$_.x0; $bh=$_.y1-$_.y0; if($bh -le 0){$bh=1}; if($bw -le 0){$bw=1}; $mw=[math]::Max($bw,$bh); $mn=[math]::Min($bw,$bh); ($mw/$mn) -ge 2.0 -and $mw -ge 3 -and $_.n -le 400 })',
  '$redAll=@($redBlobs)',
  '$blkAll=@($blkBlobs)',
  '$o=[ordered]@{ w=$W; h=$H; redPixels=$redN; redStrict=$redStrict; redStrictPct=([double]$redStrict / ($W*$H) * 100); redBlobs=$redAll.Count; redBig=$redBig.Count; redStroke=$redStroke.Count; blkPixels=$blkN; blkBlobs=$blkAll.Count; blkBig=$blkBig.Count; redBoxes=@(); blkBoxes=@(); redAllBoxes=@() }',
  'foreach($b in ($redStroke | Select-Object -First 20)){ $o.redBoxes += ("" + $b.n + "," + $b.x0 + "," + $b.y0 + "," + $b.x1 + "," + $b.y1) }',
  'foreach($b in ($blkBig | Select-Object -First 20)){ $o.blkBoxes += ("" + $b.n + "," + $b.x0 + "," + $b.y0 + "," + $b.x1 + "," + $b.y1) }',
  /* ★ 2026-11-23 第七轮：把**全部红簇**（不只"成形"的）的包围盒也输出，供"逐点抹除"用。
     孩子手画的细红线被抗锯齿断成一堆 n=2~7 的碎簇，"成形红笔"（n>=8 且长宽比>=2）
     只认出其中一小部分 ⇒ 曲线还在图上。碎簇本身面积小（n=2~7），逐个涂掉不影响正文。
     AL 前缀是给调用方的标记：区分"红笔笔画"(redBoxes) 与"全部红簇"(redAllBoxes)。 */
  'foreach($b in ($redAll | Select-Object -First 400)){ $o.redAllBoxes += ("AL|" + $b.n + "," + $b.x0 + "," + $b.y0 + "," + $b.x1 + "," + $b.y1) }',
  'Write-Output ($o | ConvertTo-Json -Depth 5 -Compress)',
].join('\r\n');

/* ───────────────── ② 清洗：去笔迹 + 增强 ─────────────────
 * 去笔迹用"色相判定 + 连通域面积门槛"：
 *   ① 标出候选像素（红笔=红显著；黑笔=暗且近中性）；
 *   ② 找连通域，**只有成形的笔画簇**（面积 >= MinBlob）才处理——零散噪点不动；
 *   ③ 把这些像素替换为邻域的中性白（纸张色），不留红边。
 * 增强：对灰度做对比度拉伸 + 3x3 unsharp 掩模（把印刷线条的边缘拉锐）。
 */
/**
 * 边缘墨迹探针（只分析，不写盘）：统计图**四条边界**上的暗像素数。
 *
 * 为什么需要（2026-11-24 实测 P0128 踩到）：裁图时如果内容**正好被切在裁切框边界上**，
 * 肉眼看整图未必察觉（尤其图(b) 右侧那只电压表只被切掉"15/3"那一端的一小条），
 * 但**印出来会缺一块**。判据：裁完再逐列/逐行统计边界处的墨迹 ——
 * 任一边不为 0 ⇒ 内容压在边界上 ⇒ 可能被截断。
 *
 * 只数**暗像素**（R,G,B 都 < 200）：彩色印刷边缘不算，避免误报。
 */
const PS_EDGE = [
  'param([string]$In)',
  'Add-Type -AssemblyName System.Drawing',
  '$ErrorActionPreference = "Stop"',
  '$img=[System.Drawing.Image]::FromFile($In)',
  '$W=$img.Width; $H=$img.Height',
  'function DarkAt($x,$y){ $c=$img.GetPixel($x,$y); if($c.R -lt 200 -and $c.G -lt 200 -and $c.B -lt 200){ return 1 } return 0 }',
  '$l=0; for($y=0;$y -lt $H;$y++){ $l += DarkAt 0 $y }',
  '$r=0; for($y=0;$y -lt $H;$y++){ $r += DarkAt ($W-1) $y }',
  '$t=0; for($x=0;$x -lt $W;$x++){ $t += DarkAt $x 0 }',
  '$b=0; for($x=0;$x -lt $W;$x++){ $b += DarkAt $x ($H-1) }',
  '$img.Dispose()',
  '"左=" + $l + " 右=" + $r + " 上=" + $t + " 下=" + $b',
].join('\r\n');

const PS_CLEAN = [
  'param([string]$In,[string]$Out,[int]$Mode,[double]$Scale,[int]$MinW,[int]$Threshold,[int]$MinBlob,[string]$Crop,[string]$Erase,[int]$CropMinW)',
  'Add-Type -AssemblyName System.Drawing',
  '$ErrorActionPreference = "Stop"',
  '$img=[System.Drawing.Image]::FromFile($In)',
  '$sw=$img.Width; $sh=$img.Height',
  '$W=$sw; $H=$sh',
  /* ⚠ 顺序很重要（2026-11-23 实测踩到）：**先缩放、再裁剪**。
     反过来（先裁后缩放）时，--最小宽 会因为"裁剪已经改变了尺寸"而判断"已达标"⇒ 不缩放，
     输出仍是窄条（如 C0047：裁完 699 宽 < 1000 却不再放大）。
     所以：缩放按**原图**尺寸算目标倍数，裁剪在缩放后的图上进行。 */
  'if($MinW -gt 0 -and $sw -lt $MinW){ $k=[double]$MinW/$sw; $W=[int]([math]::Round($sw*$k)); $H=[int]([math]::Round($sh*$k)) }',
  'elseif($Scale -gt 0 -and [math]::Abs($Scale-1.0) -gt 0.001){ $W=[int]([math]::Round($sw*$Scale)); $H=[int]([math]::Round($sh*$Scale)) }',
  'else { $W=$sw; $H=$sh }',
  'if($W -lt 1){$W=1}; if($H -lt 1){$H=1}',
  '$bmp=New-Object System.Drawing.Bitmap($W,$H)',
  '$g=[System.Drawing.Graphics]::FromImage($bmp)',
  '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
  '$g.DrawImage($img,0,0,$W,$H)',
  '$g.Dispose(); $img.Dispose()',
  /* 裁剪：先把图内容按"有墨"的区域框出来（裁掉四周留白与压边的字迹），再按用户给的框切。
     格式 "x,y,w,h"（相对当前尺寸的 0~1 归一化）。 */
  'if($Crop -ne ""){',
  '  $parts=$Crop.Split(",")',
  '  if($parts.Count -ne 4){ throw "裁剪框格式应为 x,y,w,h（0~1 归一化）" }',
  '  $cx=[double]$parts[0]; $cy=[double]$parts[1]; $cw=[double]$parts[2]; $ch=[double]$parts[3]',
  '  $rx=[int]([math]::Round($cx*$W)); $ry=[int]([math]::Round($cy*$H))',
  '  $rw=[int]([math]::Round($cw*$W)); $rh=[int]([math]::Round($ch*$H))',
  '  if($rx -lt 0){$rx=0}; if($ry -lt 0){$ry=0}',
  '  if($rx+$rw -gt $W){$rw=$W-$rx}; if($ry+$rh -gt $H){$rh=$H-$ry}',
  '  if($rw -lt 1){$rw=1}; if($rh -lt 1){$rh=1}',
  '  $nb=New-Object System.Drawing.Bitmap($rw,$rh)',
  '  $ng=[System.Drawing.Graphics]::FromImage($nb)',
  '  $ng.DrawImage($bmp,(New-Object System.Drawing.Rectangle(0,0,$rw,$rh)),(New-Object System.Drawing.Rectangle($rx,$ry,$rw,$rh)),[System.Drawing.GraphicsUnit]::Pixel)',
  '  $ng.Dispose(); $bmp.Dispose(); $bmp=$nb',
  '  $W=$rw; $H=$rh',
  '  # 裁剪后若仍不够宽 ⇒ 再放大（线条稿放大不糊，扫描照片慎用）',
  '  if($CropMinW -gt 0 -and $W -lt $CropMinW){',
  '    $k2=[double]$CropMinW/$W; $W2=[int]([math]::Round($W*$k2)); $H2=[int]([math]::Round($H*$k2))',
  '    if($W2 -lt 1){$W2=1}; if($H2 -lt 1){$H2=1}',
  '    $nb2=New-Object System.Drawing.Bitmap($W2,$H2)',
  '    $ng2=[System.Drawing.Graphics]::FromImage($nb2)',
  '    $ng2.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '    $ng2.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
  '    $ng2.DrawImage($bmp,0,0,$W2,$H2)',
  '    $ng2.Dispose(); $bmp.Dispose(); $bmp=$nb2',
  '    $W=$W2; $H=$H2',
  '  }',
  '}',
  /* 抹除：把指定区域整块填成纸张色（去掉"压着图的红字批注"这类**整块**干扰）。
     格式同上 x,y,w,h（0~1 归一化，相对当前尺寸）。
     **可给多个框**（用分号分隔）：node --抹除 "0.1,0.2,0.05,0.05;0.3,0.4,0.02,0.02"
     —— 实测 C0016 有 24 处红笔碎片，逐个抹不现实。 */
  'if($Erase -ne ""){',
  '  $eboxes=@()',
  '  foreach($b1 in ($Erase -split ";")){ foreach($b2 in ($b1 -split "\\s+")){ if(-not [string]::IsNullOrWhiteSpace($b2)){ $eboxes += $b2 } } }',
  '  foreach($box in $eboxes){',
  '    if([string]::IsNullOrWhiteSpace($box)){ continue }',
  '    $eparts=$box.Split(",")',
  '    if($eparts.Count -ne 4){ throw "抹除框格式应为 x,y,w,h（0~1 归一化）" }',
  '    $ex=[int]([math]::Round([double]$eparts[0]*$W)); $ey=[int]([math]::Round([double]$eparts[1]*$H))',
  '    $ew=[int]([math]::Round([double]$eparts[2]*$W)); $eh=[int]([math]::Round([double]$eparts[3]*$H))',
  '    if($ex -lt 0){$ex=0}; if($ey -lt 0){$ey=0}',
  '    if($ex+$ew -gt $W){$ew=$W-$ex}; if($ey+$eh -gt $H){$eh=$H-$ey}',
  '    if($ew -gt 0 -and $eh -gt 0){',
  '      $brush=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,255,255,255))',
  '      $eg=[System.Drawing.Graphics]::FromImage($bmp)',
  '      $eg.FillRectangle($brush,$ex,$ey,$ew,$eh)',
  '      $eg.Dispose(); $brush.Dispose()',
  '    }',
  '  }',
  '}',
  '$mask=New-Object bool[] ($W*$H)',
  'for($y=0;$y -lt $H;$y++){ for($x=0;$x -lt $W;$x++){',
  '  $c=$bmp.GetPixel($x,$y); $r=$c.R; $gg=$c.G; $b=$c.B',
  '  if($c.A -lt 8){ continue }',
  '  if(($Mode -band 1) -ne 0){',
  '    # 同探测口径：并集判据（褪色红 / 纯红 / **浅粉** 三类；浅粉判据见探测段注释）',
  '    if($r -ge 80 -and ($r-$gg) -ge 20){',
  '      $isFaded = ($b -ge ($r*0.70)) -and ($gg -le ($r*0.82)) -and ($b -ge ($gg - 2))',
  '      $isPure  = ($b -le ($r*0.45)) -and ($gg -le ($r*0.45))',
  '      if($isFaded -or $isPure){ $mask[$y*$W+$x]=$true; continue }',
  '    }',
  '    # 浅粉（第五轮补 / 第八轮收紧到 R-G>=25、R-B>=20）：孩子用红笔画的曲线经扫描/压缩后摊成极浅的粉',
  '    # （实测 R=246 G=227 B=231 ⇒ G/R=0.92 ⇒ 上面的"褪色红"判不到）⇒ 红曲线留在图上。',
  '    # 区分「浅粉」与「灰褐抗锯齿边」靠 |G-B|：浅粉 4、灰褐 20、橙棕 62。',
  '    if($r -ge 120 -and ($r-$gg) -ge 25 -and ($r-$b) -ge 20 -and ([math]::Abs($gg-$b) -le ($r*0.06))){ $mask[$y*$W+$x]=$true; continue }',
  '    # 洋红红（第六轮补）：R 远大于 G（>=60 且 G<=R*0.45）且 R 远大于 B（>=40，B>=R*0.20）',
  '    if($r -ge 120 -and ($r-$gg) -ge 60 -and ($gg -le ($r*0.45)) -and ($r-$b) -ge 40 -and ($b -ge ($r*0.20))){ $mask[$y*$W+$x]=$true; continue }',
  '  }',
  '  if(($Mode -band 2) -ne 0){',
  '    if($r -le 95 -and $gg -le 95 -and $b -le 95 -and ([math]::Abs($r-$gg) -le 25) -and ([math]::Abs($r-$b) -le 25)){ $mask[$y*$W+$x]=$true }',
  '  }',
  '} }',
  '$seen=New-Object bool[] ($W*$H); $stack=New-Object System.Collections.Stack',
  'for($i=0;$i -lt ($W*$H);$i++){',
  '  if(-not $mask[$i] -or $seen[$i]){continue}',
  '  $stack.Push($i); $seen[$i]=$true; $pts=New-Object System.Collections.ArrayList',
  '  while($stack.Count -gt 0){',
  '    $p=[int]$stack.Pop(); [void]$pts.Add($p)',
  '    # ★ 2026-11-23 修（实测 M0061 崩在这）：邻居必须按二维边界判，不能只用 ±1/±W。',
  '    #   原写法只挡了整体越界、没挡跨行回绕；且 $py=[int]($p/$W) 在边界处会算出 $py=$H，',
  '    #   SetPixel 于是报 "Parameter must be positive and < Height"。修法：按 (dx,dy) 枚举并逐个查界。',
  '    $cx=$p % $W; $cy=[int]($p / $W)',
  '    foreach($nb in @(@(-1,0),@(1,0),@(0,-1),@(0,1))){',
  '      $nx=$cx+$nb[0]; $ny=$cy+$nb[1]',
  '      if($nx -lt 0 -or $nx -ge $W -or $ny -lt 0 -or $ny -ge $H){continue}',
  '      $q=$ny*$W+$nx',
  '      if($mask[$q] -and -not $seen[$q]){ $seen[$q]=$true; $stack.Push($q) }',
  '    }',
  '  }',
  '  if($pts.Count -ge $MinBlob){',
  '    foreach($p in $pts){',
  '      $px=$p % $W; $py=[int]($p / $W)',
  '      if($py -lt 0 -or $py -ge $H){continue}',
  '      # 找最近的中性背景色（纸张）：向上/下/左/右各看 3 像素，取亮的一侧',
  '      # ★ 2026-11-23 修（实测 M0061 洗完仍有 R=255 G=233 B=241 的粉）：',
  '      #   原实现把最近的一个亮像素直接当背景色填回去 —— 若那条红笔的抗锯齿边缘本身就是浅粉',
  '      #   （R=255 G=233 B=231），填回去的还是粉 ⇒ 红曲线原样留在图上。',
  '      #   修法：只在找到真正中性（近灰）的亮像素时才用它的色，否则一律填纯白。',
  '      #   判据"中性" = R,G,B 三者极差 <= 12（纸张满足；浅粉不满足：极差 14）。',
  '      $bg=[System.Drawing.Color]::White',
  '      for($d=1;$d -le 3;$d++){',
  '        $ny=$py-$d; if($ny -ge 0){ $cc=$bmp.GetPixel($px,$ny)',
  '          $spread=[math]::Max($cc.R,[math]::Max($cc.G,$cc.B)) - [math]::Min($cc.R,[math]::Min($cc.G,$cc.B))',
  '          if((($cc.R+$cc.G+$cc.B) -gt 690) -and ($spread -le 12)){ $bg=$cc; break } }',
  '      }',
  '      $bmp.SetPixel($px,$py,$bg)',
  '    }',
  '  }',
  '}',
  'if(($Mode -band 16) -ne 0){',
  '  # 3x3 中值滤波：去扫描噪点（孤立噪点被中值吃掉），线条边缘基本保留',
  '  $tmp=New-Object System.Drawing.Bitmap($W,$H)',
  '  $tg=[System.Drawing.Graphics]::FromImage($tmp); $tg.DrawImage($bmp,0,0); $tg.Dispose()',
  '  for($y=1;$y -lt ($H-1);$y++){ for($x=1;$x -lt ($W-1);$x++){',
  '    $vals=New-Object int[] 9',
  '    $k=0',
  '    for($dy=-1;$dy -le 1;$dy++){ for($dx=-1;$dx -le 1;$dx++){',
  '      $c=$tmp.GetPixel($x+$dx,$y+$dy); $vals[$k]=[int](($c.R*0.299+$c.G*0.587+$c.B*0.114)); $k++',
  '    } }',
  '    [array]::Sort($vals)',
  '    $m=$vals[4]',
  '    $tmp.SetPixel($x,$y,[System.Drawing.Color]::FromArgb(255,$m,$m,$m))',
  '  } }',
  '  $bmp.Dispose(); $bmp=$tmp',
  '}',
'if(($Mode -band 4) -ne 0){',
  '  # 对比度拉伸：先算直方图的 2%–98% 分位，做线性映射把黑压到 0、白推到 255',
  '  $hist=New-Object int[] 256',
  '  for($y=0;$y -lt $H;$y+=1){ for($x=0;$x -lt $W;$x+=1){ $c=$bmp.GetPixel($x,$y); $v=[int](($c.R*0.299+$c.G*0.587+$c.B*0.114)); $hist[$v]++ } }',
  '  $tot=$W*$H; $lo=0; $acc=0',
  '  for($v=0;$v -lt 256;$v++){ $acc+=$hist[$v]; if($acc -ge ($tot*0.02)){ $lo=$v; break } }',
  '  $hi=255; $acc=0',
  '  for($v=255;$v -ge 0;$v--){ $acc+=$hist[$v]; if($acc -ge ($tot*0.02)){ $hi=$v; break } }',
  '  if($hi -le $lo){ $lo=0; $hi=255 }',
  '  $span=[double]($hi-$lo)',
  '  $src=$bmp.Clone()',
  '  for($y=0;$y -lt $H;$y++){ for($x=0;$x -lt $W;$x++){',
  '    $c=$src.GetPixel($x,$y)',
  '    $r=[int][math]::Max(0,[math]::Min(255,($c.R-$lo)*255.0/$span))',
  '    $gg=[int][math]::Max(0,[math]::Min(255,($c.G-$lo)*255.0/$span))',
  '    $b=[int][math]::Max(0,[math]::Min(255,($c.B-$lo)*255.0/$span))',
  '    $bmp.SetPixel($x,$y,[System.Drawing.Color]::FromArgb($c.A,$r,$gg,$b))',
  '  } }',
  '  $src.Dispose()',
  '}',
  'if(($Mode -band 8) -ne 0){',
  '  # unsharp：center*1.4 - (neighbors avg)*0.4',
  '  ⚠ 扫描件慎用：印刷的半调网点（halftone）会被放大成满屏噪点（图看起来更脏）。',
  '  ⚠ 所以锐化是**独立开关**（--锐化），默认不做。',
  '  $out2=New-Object System.Drawing.Bitmap($W,$H)',
  '  $og=[System.Drawing.Graphics]::FromImage($out2); $og.DrawImage($bmp,0,0); $og.Dispose()',
  '  for($y=1;$y -lt ($H-1);$y++){ for($x=1;$x -lt ($W-1);$x++){',
  '    $c=$bmp.GetPixel($x,$y)',
  '    $n=0.0',
  '    foreach($d in @(@(-1,0),@(1,0),@(0,-1),@(0,1))){ $cc=$bmp.GetPixel($x+$d[0],$y+$d[1]); $n+=($cc.R*0.299+$cc.G*0.587+$cc.B*0.114) }',
  '    $n/=4.0; $cv=($c.R*0.299+$c.G*0.587+$c.B*0.114)',
  '    $nv=[int][math]::Max(0,[math]::Min(255,$cv*1.4-$n*0.4))',
  '    $out2.SetPixel($x,$y,[System.Drawing.Color]::FromArgb($c.A,$nv,$nv,$nv))',
  '  } }',
  '  $bmp.Dispose(); $bmp=$out2',
  '}',
  /* 输出格式按**输出文件的扩展名**决定（2026-11-23 修：原先硬编码 Jpeg ⇒ 输出 .png 时
     文件头是 JPEG、扩展名却是 .png ⇒ 浏览器/看图工具按扩展名解析会直接报错）。
     判据：.png ⇒ Png；.jpg/.jpeg ⇒ Jpeg；.bmp ⇒ Bmp；.gif ⇒ Gif；其它 ⇒ Jpeg。 */
  '$ext=[System.IO.Path]::GetExtension($Out).ToLower()',
  '$fmt=[System.Drawing.Imaging.ImageFormat]::Jpeg',
  'if($ext -eq ".png"){ $fmt=[System.Drawing.Imaging.ImageFormat]::Png }',
  'elseif($ext -eq ".bmp"){ $fmt=[System.Drawing.Imaging.ImageFormat]::Bmp }',
  'elseif($ext -eq ".gif"){ $fmt=[System.Drawing.Imaging.ImageFormat]::Gif }',
  '$bmp.Save($Out,$fmt)',
  '$bmp.Dispose()',
  'Write-Output ("{0}x{1}" -f $W,$H)',
].join('\r\n');

/* ───────────────── 执行 ───────────────── */
const THRESHOLD = 8;      /* 探测用的连通域面积门槛：≥8 像素才算"成形的笔画" */
const MIN_BLOB = 2;       /* 去笔迹时的最小簇面积：小于它的当噪点放过。
                           ⚠ 2026-11-23 实测：原值 6 会**放掉被 JPEG 压缩打散的红字笔画**
                             （C0047 的红字碎片只有 2–5 像素/簇 ⇒ 洗不掉 ⇒ 残留 20 处）。
                             现在取 2 ⇒ 红字碎片也一并洗掉。
                             误伤风险由**色相判据**兜住（不是所有暗色像素都判红）。 */
/* ⚠ 2026-11-23 修正（实测）：
     · 原 THRESHOLD=20 ⇒ **真红笔漏检**：M0070 的红笔横线在 JPEG 压缩后被拆成
       若干小块，每块 < 20 像素 ⇒ 一簇也成不了形 ⇒ 报"未检出红笔"（假安全，最坏）。
     · 现 THRESHOLD=8 ⇒ 那道红笔（实测 69 个红像素、跨 3 行）能聚成一簇被检出。
     · 彩色印刷边缘的误报靠**色相判据**（G/R ≤ 0.85 且 B/R ≥ 0.70）挡住，
       不靠面积门槛 —— 面积门槛只负责滤噪点。 */

if (opt['边缘墨迹']) {
  const raw = psRun(PS_EDGE, ['-In', IN]);
  console.log('边缘墨迹：' + IN);
  console.log('  ' + raw.trim());
  console.log('  ⇒ 任一边不为 0 ⇒ 图内容被切在边界上（可能被截断），请肉眼确认边缘图元是否完整。');
  process.exit(0);
}

if (opt['探测']) {
  const raw = psRun(PS_PROBE, ['-In', IN, '-Threshold', String(THRESHOLD), '-MinBlob', String(MIN_BLOB)]);
  let o;
  try { o = JSON.parse(raw); } catch { console.error('✖ 探测输出解析失败：' + raw.slice(0, 300)); process.exit(1); }
  const pct = v => (o.w * o.h) ? (v / (o.w * o.h) * 100).toFixed(4) + '%' : '0%';
  /* redStroke = 成形红笔（面积达标 **且** 长宽比 ≥ 2 ⇒ 是"一笔"而不是"斑块"） */
  const stroke = o.redStroke !== undefined ? o.redStroke : o.redBig;
  console.log('配图探测：' + IN);
  console.log(`  尺寸：${o.w}x${o.h}`);
  console.log(`  红色像素：${o.redPixels}（${pct(o.redPixels)}）  成形红笔（面积+形状达标）：${stroke} 个（红簇共 ${o.redBlobs} 个）`);
  console.log(`  严格红味（R-G>=25，排除泛黄旧纸）：${o.redStrict === undefined ? '?' : o.redStrict}（${o.redStrictPct === undefined ? '?' : o.redStrictPct.toFixed(4) + '%'}）`);
  console.log(`  暗色像素：${o.blkPixels}（${pct(o.blkPixels)}）  成形暗色簇：${o.blkBig} 个（共 ${o.blkBlobs} 簇）`);
  if (o.redBoxes && o.redBoxes.length) {
    console.log('  红笔笔画包围盒（面积,x0,y0,x1,y1）：');
    for (const b of o.redBoxes) console.log('    ' + (typeof b === 'string' ? b : JSON.stringify(b)));
  }
  if (o.blkBoxes && o.blkBoxes.length) {
    console.log('  暗色簇包围盒（面积,x0,y0,x1,y1，前 8 个）：');
    for (const b of (typeof o.blkBoxes[0] === 'string' ? o.blkBoxes : o.blkBoxes).slice(0, 8)) console.log('    ' + b);
  }
  /* ★ 2026-11-23 第七轮：全部红簇（带 AL| 前缀）。逐点抹除用这一份 ——
     "成形红笔"只认出粗笔画，孩子手画的细红线被抗锯齿断成碎簇后认不出 ⇒ 曲线留在图上。 */
  if (o.redAllBoxes && o.redAllBoxes.length) {
    console.log('  全部红簇包围盒（AL|面积,x0,y0,x1,y1）：');
    for (const b of o.redAllBoxes) console.log('    ' + (typeof b === 'string' ? b : JSON.stringify(b)));
  }
  console.log('');
  console.log(stroke > 0
    ? '⚠ 检出成形红笔 ⇒ 这张图带批改笔迹，入库前必须清洗（--去红笔）或换图。'
    : '✓ 未检出成形红笔。');
  process.exit(0);
}

let mode = 0;
const acts = [];
if (opt['去红笔']) { mode |= MODE_RED; acts.push('去红笔'); }
if (opt['去黑笔']) { mode |= MODE_BLACK; acts.push('去黑笔'); }
if (opt['去噪']) { mode |= MODE_DENOISE; acts.push('去噪'); }
if (opt['增强']) { mode |= MODE_ENH; acts.push('对比度拉伸'); }
if (opt['锐化']) { mode |= MODE_SHARP; acts.push('锐化'); }
if (opt['矫正']) acts.push('矫正(近似：按内容居中裁切+摆正预判，见 --矫正 说明)');
if (opt['裁剪']) acts.push('裁剪 ' + opt['裁剪']);
if (opt['抹除']) acts.push('抹除 ' + opt['抹除']);
/* ⚠ 缩放本身也算一个动作：只给 --最小宽 / --放大 而不给别的，也应当能跑通
   （"把题库原图放大到可印刷宽度"是最常见的用法，不该被拒）。 */
if (opt['最小宽']) acts.push('放大到宽度 ≥ ' + opt['最小宽']);
if (opt['放大']) acts.push('放大 ' + opt['放大'] + ' 倍');
if (!mode && !acts.length) { console.error('✖ 至少给一个动作（--去红笔/--去黑笔/--去噪/--增强/--锐化/--裁剪/--放大/--最小宽）'); process.exit(2); }

const scale = opt['放大'] ? Number(opt['放大']) : 1;
const minW = opt['最小宽'] ? Number(opt['最小宽']) : 0;
if (opt['放大'] && !(scale > 0)) { console.error('✖ --放大 必须是正数'); process.exit(2); }
if (opt['最小宽'] && !(minW > 0)) { console.error('✖ --最小宽 必须是正数'); process.exit(2); }
if (opt['裁剪'] && !/^[\d.]+,[\d.]+,[\d.]+,[\d.]+$/.test(String(opt['裁剪']))) {
  console.error('✖ --裁剪 格式应为 x,y,w,h（0~1 归一化），收到：' + opt['裁剪']); process.exit(2);
}
if (opt['抹除'] && !/^[\d.]+,[\d.]+,[\d.]+,[\d.]+([;\s]+[\d.]+,[\d.]+,[\d.]+,[\d.]+)*$/.test(String(opt['抹除']))) {
  console.error('✖ --抹除 格式应为 x,y,w,h（0~1 归一化），多个框用分号或空格分隔，收到：' + opt['抹除']); process.exit(2);
}

const OUT = String(opt.out);
const outDir = path.dirname(OUT);
if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const dim = psRun(PS_CLEAN, [
  '-In', IN, '-Out', OUT, '-Mode', String(mode),
  '-Scale', String(scale), '-MinW', String(minW),
  '-Threshold', String(THRESHOLD), '-MinBlob', String(MIN_BLOB),
  '-Crop', String(opt['裁剪'] || ''),
  '-Erase', String(opt['抹除'] || ''),
  '-CropMinW', String(opt['裁剪后最小宽'] || 0),
]);

/* 处理完立刻自检：确认输出确实存在、可读、且红笔没了 —— 不靠"命令没报错"当成功 */
let verify = { ok: false, why: '' };
try {
  const raw2 = psRun(PS_PROBE, ['-In', OUT, '-Threshold', String(THRESHOLD), '-MinBlob', String(MIN_BLOB)]);
  const o2 = JSON.parse(raw2);
  verify = {
    ok: true,
    w: o2.w, h: o2.h,
    redBig: o2.redStroke !== undefined ? o2.redStroke : o2.redBig,
    size: fs.existsSync(OUT) ? fs.statSync(OUT).size : 0,
  };
} catch (e) {
  verify = { ok: false, why: String(e.message || e).slice(0, 200) };
}

console.log('配图清洗完成：' + IN + ' → ' + OUT);
console.log('  动作：' + (acts.length ? acts.join(' + ') : '（仅缩放）'));
console.log('  输出尺寸：' + dim);
if (verify.ok) {
  console.log('  自检：残留成形红笔 ' + verify.redBig + ' 个' + (verify.redBig === 0 ? ' ✓' : ' ⚠ 仍有残留，需加强清洗或换图'));
  console.log('  文件大小：' + verify.size + ' 字节');
} else {
  console.log('  ⚠ 自检未通过：' + verify.why);
  process.exit(1);
}
