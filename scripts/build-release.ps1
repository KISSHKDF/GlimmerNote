# ═══════════════════════════════════════════════════════════
# 拾光小册 · 打发布包
#   版本号唯一来源：VERSION.json（本脚本不接收版本参数，避免两处打架）
#   产出：release\GlimmerNote-<ver>-win-x64.zip + 同名 .sha256
#   用法：powershell -File scripts\build-release.ps1
#
#   ★ 2026-10-25：默认把 **node.exe 一起打进包**（-WithoutNode 可关掉）。
#     为什么必须打：壳里 RunNode 是裸调 "node.exe"（CTBShellV2.cs:597，只给文件名、
#     UseShellExecute=false），而 Windows CreateProcess 的搜索序**第一个就是调用方 exe
#     所在目录**（2026-10-25 实测：目录里没有 node.exe 且 PATH 剥离 → 报"系统找不到指定
#     的文件"；把 node.exe 拷到旁边 → 正常返回 v26.10.0）。所以只要 node.exe 与
#     「拾光小册.exe」同目录，**一行 C# 都不用改**，陌生人机器也能直接跑。
#     不打的话：空库能打开，但点「＋新建学生」就失败，且报错不提 Node。
# ═══════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [string]$NodeExe,        # 指定要打进包的 node.exe（不填则取 PATH 里的）
  [switch]$WithoutNode     # 打"不带 Node"的精简包（体积 0.6 MB，但要求用户自备 Node ≥18）
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$verFile = Join-Path $root 'VERSION.json'
$srcApp  = Join-Path $root 'src\app'
$relDir  = Join-Path $root 'release'
$exeName = '拾光小册.exe'
$exePath = Join-Path $srcApp $exeName
$shellBuild = Join-Path $root 'src\shell\build.ps1'

if (-not (Test-Path $verFile)) { throw "找不到 VERSION.json：$verFile" }
if (-not (Test-Path $srcApp))  { throw "找不到源码目录：$srcApp" }

$V = Get-Content $verFile -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = [string]$V.version
if ($ver -notmatch '^\d{4}\.\d{2}\.\d{2}\.\d{2}$') { throw "VERSION.json 里的 version 不符合日期制（YYYY.MM.DD.NN）：$ver" }

# ── 0a) 打包前必须工作区干净（2026-10-25 用户要求「只能走正确链路」）──
#  为什么：本脚本把构建时间戳钉在 **git HEAD 的提交时间**上。若工作区有未提交改动，
#  打出来的包里有新代码、时间戳却是旧提交 ⇒ 事后无法用 tag 复现这个包，
#  "包 ↔ 提交"的对应关系断掉（这正是 2026-10-25 那次绕过部署的同类断链）。
#  所以：不干净就拒绝打包 —— 逼你先在 dev 改完、测完、commit，再打包。
try { $porcelain = (git -C $root status --porcelain 2>$null) } catch { $porcelain = $null }
if ($null -eq $porcelain) {
  # ★ 2026-10-28 修：干净工作区下 `git status --porcelain` 一行都不输出 ⇒ PowerShell 赋成 $null，
  # 旧写法据此报「取不到 git 状态（不是 git 仓库？）」并跳过检查 —— 是**假警报**，而且让
  # 下面那个「工作区干净」分支永远走不到（死代码）。判据必须区分两种 $null：
  #   「git 说没有改动」（在树内，输出为空）  vs  「git 根本没跑起来 / 不是仓库」。
  # 实测：干净树下 rev-parse 返回 true，旧写法却报"不是 git 仓库"。
  $inTree = "$(git -C $root rev-parse --is-inside-work-tree 2>$null)".Trim()
  if ($inTree -eq 'true') {
    Write-Host "  工作区干净（git status 无改动）"
  } else {
    Write-Host "  ⚠ 取不到 git 状态（不是 git 仓库 / git 不可用）—— 跳过干净树检查" -ForegroundColor Yellow
  }
} elseif ($porcelain.Trim()) {
  $lines = (($porcelain -split "`n") | Where-Object { $_.Trim() } | Select-Object -First 12) -join "`n"
  throw ("工作区不干净，拒绝打包（先 commit 再打包，否则包内容与 git 时间戳对不上）：`n" + $lines +
    "`n  正确顺序：dev 改 → dev 测（tools\lint.mjs / tests\run.mjs fixture）→ git commit → 本脚本")
} else {
  Write-Host "  工作区干净（git status 无改动）"
}

Write-Host "拾光小册 · 打包" -ForegroundColor Cyan
Write-Host "  版本：$ver"
Write-Host "  源码：$srcApp"

# ── 0) 先确保 exe 是最新的（打包=出成品，包里必须有能双击的程序）──
#    判据：exe 不存在，或任一源文件比 exe 新 ⇒ 重编。避免"改了源码却打出旧 exe"这种假成品。
$stale = -not (Test-Path $exePath)
if (-not $stale) {
  $exeTime = (Get-Item $exePath).LastWriteTimeUtc
  foreach ($f in @(
      (Join-Path $root 'src\shell\CTBShellV2.cs'),
      $shellBuild,
      (Join-Path $root 'src\shell\ctb.ico'),
      $verFile)) {
    if ((Test-Path $f) -and ((Get-Item $f).LastWriteTimeUtc -gt $exeTime)) { $stale = $true; break }
  }
  # ★ 2026-10-23：光比 mtime 不够 —— 只改 VERSION.json 的版本号时，源文件一个都没变，
  #   上面那轮会判"最新"⇒ 跳过重编 ⇒ 包里 exe 的 FileVersion 还是旧号（portability.cjs 会红）。
  #   所以再比一次**二进制里的版本资源**：exe 的 FileVersion 必须等于 VERSION.json 的版本。
  if (-not $stale) {
    try {
      $fv = (Get-Item $exePath).VersionInfo.FileVersion
      # VERSION.json 的 2026.10.23.02 → 程序集 2026.10.23.2（末段去前导零）
      $parts = $ver.Split('.')
      $expectFv = ($parts[0..2] -join '.') + '.' + [int]$parts[3]
      if ([string]$fv -ne $expectFv) {
        Write-Host "  exe 里的 FileVersion=$fv ≠ VERSION.json=$expectFv，需要重编" -ForegroundColor Yellow
        $stale = $true
      }
    } catch {
      Write-Host "  读不出 exe 的 FileVersion，按过期处理（宁可多编一次）" -ForegroundColor Yellow
      $stale = $true
    }
  }
  if ($stale) { Write-Host "  exe 比源码旧，需要重编" -ForegroundColor Yellow }
}
if ($stale) {
  if (-not (Test-Path $shellBuild)) { throw "找不到编壳脚本：$shellBuild" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $shellBuild
  if ($LASTEXITCODE -ne 0) { throw "编壳失败（exit $LASTEXITCODE）" }
  if (-not (Test-Path $exePath)) { throw "编壳后仍没有 exe：$exePath" }
} else {
  Write-Host "  exe 已是最新，跳过重编"
}

# ── 1) 可复现构建：所有时间戳都钉在「本次提交时间」上 ──
#   为什么：如果 builtAt 用 Now、文件时间用复制时的当前时间，
#   同一个 tag 每次构建出来的 zip 哈希都不一样 —— "可重放"就是假承诺。
#   做法：取 git HEAD 的提交时间，同时把它写进 版本.json 并钉到每个文件上。
$commitIso = $null
try { $commitIso = (git -C $root log -1 --format=%cI 2>$null) } catch { }
if (-not $commitIso) {
  $commitIso = '2000-01-01T00:00:00+00:00'
  Write-Host "  ⚠ 取不到 git 提交时间，使用固定回退时间戳（仍可复现，但时间不准）" -ForegroundColor Yellow
}
$stamp = ([datetime]::Parse($commitIso)).ToString('yyyy-MM-dd HH:mm:ss')
$stampUtc = ([datetime]::Parse($commitIso)).ToUniversalTime()
$stage = Join-Path $env:TEMP ("glimmernote-stage-" + [guid]::NewGuid().ToString('N'))
$stageApp = Join-Path $stage 'app'
New-Item -ItemType Directory -Path $stageApp -Force | Out-Null
Copy-Item (Join-Path $srcApp '*') $stageApp -Recurse -Force

# ── 1b) 业务工具链 src\tools\ → 包内 app\tools\ ──
#   为什么必须进包：界面显示的数据由 `生成状态.mjs` 现算；待办办结、组卷、批改各自要走 .mjs。
#   壳按 AppRoot\tools\ 找它们（见 CTBShellV2.cs 的 ToolPath）。不带工具链的包 = 空壳。
$srcTools = Join-Path $root 'src\tools'
if (-not (Test-Path $srcTools)) { throw "找不到工具目录：$srcTools" }
$stageTools = Join-Path $stageApp 'tools'
New-Item -ItemType Directory -Path $stageTools -Force | Out-Null
Copy-Item (Join-Path $srcTools '*.mjs') $stageTools -Force
$toolN = (Get-ChildItem $stageTools -File -Filter *.mjs).Count
if ($toolN -lt 15) { throw "工具链不全：只拷到 $toolN 个 .mjs（期望 >= 15）" }
Write-Host "  工具链：$toolN 个 .mjs -> app\tools\"
# ── 1c) 配方 src\recipes\ → 包内 app\recipes\ ──
#   为什么必须进包：AI 方法层（提示词 / 输出契约 / 验收清单 / 反例库）是纯文本资产，
#   由 app\tools\_配方.mjs 按 AppRoot\recipes 读取。不带配方的包 = 只发数据、不发方法，
#   用户换了自己的 AI 就只能重新踩一遍我们踩过的坑。
#   内容红线：不含任何学生数据、不含 API Key、不联网；纯 Markdown / JSON。
$srcRecipes = Join-Path $root 'src\recipes'
if (-not (Test-Path $srcRecipes)) {
  throw "找不到配方目录：$srcRecipes（配方是 AI 方法层，缺它等于只发数据不发方法）"
}
$stageRecipes = Join-Path $stageApp 'recipes'
Copy-Item $srcRecipes $stageRecipes -Recurse -Force
$recipeN = (Get-ChildItem $stageRecipes -Recurse -File).Count
$recipeCore = Join-Path $stageRecipes '_core'
if (-not (Test-Path (Join-Path $recipeCore 'base.md'))) { throw "配方核心层缺失：$recipeCore\base.md" }
Write-Host "  配方：$recipeN 个文件 -> app\recipes\"

$verObj = [ordered]@{
  name     = [string]$V.name
  nameEn   = [string]$V.nameEn
  version  = $ver
  platform = [string]$V.platform
  builtAt  = $stamp
}
$verJson = $verObj | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $stageApp '版本.json'), $verJson, (New-Object System.Text.UTF8Encoding($false)))
# 同时生成 版本.js：file:// 下浏览器禁止 fetch 本地 json，只能用 script 注入
$verJs = 'window.__GNOTE_VERSION__ = ' + ($verObj | ConvertTo-Json -Depth 5 -Compress) + ';' + "`r`n"
[IO.File]::WriteAllText((Join-Path $stageApp '版本.js'), $verJs, (New-Object System.Text.UTF8Encoding($false)))

# ── 2) 打包前自检：不许混进数据 / 不许混进 .git / 必须带齐能双击的东西 ──
$bad = Get-ChildItem $stageApp -Recurse -Force -File | Where-Object {
  $_.FullName -match '\\\.git\\' -or
  $_.Name -in @('_索引.json','_状态.json','_待确认.json','_组卷台账.json','_原卷台账.json','_配图台账.json','_盲解双路.json','_笔形台账.json') -or
  $_.Extension -in @('.jpg','.jpeg','.png','.pdf') -and $_.FullName -notmatch '\\fixtures\\'
}
if ($bad) {
  $names = ($bad | ForEach-Object { $_.FullName.Replace($stageApp,'') }) -join ', '
  throw "打包自检失败：发现不该进包的文件 → $names"
}
# 缺一个都起不来：exe + 3 个 WebView2 运行库（dll 是 exe 的运行时同伴，不是可选的编译零件）
$mustHave = @($exeName,
  'Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll',
  'index.html','版本.json')
$lack = @($mustHave | Where-Object { -not (Test-Path (Join-Path $stageApp $_)) })
if ($lack.Count -gt 0) {
  throw ("打包自检失败：包里缺必需文件 → " + ($lack -join ', ') +
         "`r`n  （先跑 powershell -File scripts\fetch-deps.ps1 与 src\shell\build.ps1）")
}

# ── 2.6) 把 node.exe 打进包（★ 2026-10-25 加，见文件头注释）──
#   壳的 RunNode 只给文件名 "node.exe"，靠 CreateProcess 的搜索序；
#   而搜索序第一个就是"调用方 exe 所在目录" ⇒ 与「拾光小册.exe」同目录即可命中。
#   工具链 19 个 .mjs 全部只用 Node 内置模块（2026-10-25 实测），所以只要 node.exe 一个文件，
#   不需要 node_modules、不需要 npm。
$nodeInfo = $null
if ($WithoutNode) {
  Write-Host "  ⚠ -WithoutNode：本包不含 node.exe，最终用户必须自备 Node.js ≥18" -ForegroundColor Yellow
} else {
  $nodeSrc = $NodeExe
  if (-not $nodeSrc) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeSrc = $cmd.Source }
  }
  if (-not $nodeSrc -or -not (Test-Path $nodeSrc)) {
    throw ("找不到 node.exe 可打进包（试过 -NodeExe 与 PATH）。`r`n" +
           "  · 想打「绿色免安装」完整包：先装 Node.js ≥18，或用 -NodeExe 指定 node.exe 路径`r`n" +
           "  · 确实要打不含 Node 的精简包：加 -WithoutNode（用户需自备 Node）")
  }
  $nodeVer = (& $nodeSrc --version) 2>$null
  if (-not $nodeVer) { throw "无法执行 $nodeSrc --version，可能不是可用的 node.exe" }
  $major = 0
  if ($nodeVer -match '^v(\d+)\.') { $major = [int]$Matches[1] }
  if ($major -lt 18) { throw "node.exe 版本过低：$nodeVer（要求 ≥ v18）" }
  $nodeDst = Join-Path $stageApp 'node.exe'
  Copy-Item -LiteralPath $nodeSrc -Destination $nodeDst -Force
  $nodeBytes = (Get-Item $nodeDst).Length
  $nodeInfo = [ordered]@{
    version = $nodeVer.Trim()
    bytes   = $nodeBytes
    sha256  = (Get-FileHash -LiteralPath $nodeDst -Algorithm SHA256).Hash
  }
  $nodeNotice = @"
拾光小册内置的 Node.js runtime
================================
版本：$($nodeInfo.version)
文件：app\node.exe（$([math]::Round($nodeBytes/1MB,1)) MB）
SHA256：$($nodeInfo.sha256)

为什么内置：本程序的"写盘"动作（新建学生 / 组卷 / 批改 / 待办办结）由一批 .mjs 工具完成，
由桌面壳按名字调用 node.exe。把 node.exe 放在程序同目录，程序就能自己找到它，
不需要用户另外安装、也不需要联网。

Node.js 由 OpenJS Foundation 及贡献者开发，以 MIT 许可发布。
许可全文见同目录 node-LICENSE.txt；项目主页 https://nodejs.org/
本程序未修改 node.exe，原样分发。
"@
  [IO.File]::WriteAllText((Join-Path $stage '内置Node说明.txt'), $nodeNotice + "`r`n", (New-Object System.Text.UTF8Encoding($true)))
  $nodeLicense = @"
Node.js is licensed for use as follows:

Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.

This license applies to parts of Node.js originating from the
https://github.com/joyent/node repository:

Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.

Node.js also bundles third-party libraries under their own licenses;
see https://github.com/nodejs/node/blob/main/LICENSE for the full list.
"@
  [IO.File]::WriteAllText((Join-Path $stage 'node-LICENSE.txt'), $nodeLicense + "`r`n", (New-Object System.Text.UTF8Encoding($true)))
  # 落位断言：node.exe 必须真在 app\ 里，否则这个包对外就是"能开不能存"
  if (-not (Test-Path (Join-Path $stageApp 'node.exe'))) {
    throw "内置 Node 失败：app\node.exe 不存在（源：$nodeSrc）"
  }
  Write-Host ("  内置 Node：{0}（{1:N1} MB）→ app\node.exe" -f $nodeInfo.version, ($nodeBytes / 1MB))
  Write-Host "  已放：内置Node说明.txt、node-LICENSE.txt"
}

# ── 2.5) 补"解压即可用"的两样东西（★ 2026-10-24 加）──
# 为什么要数据目录：壳的库根解析顺序是 CTB_DATA > <AppRoot>..\数据 > <AppRoot>\数据 > AppRoot。
#   包里不给数据目录时，新手解压后在 app 里双击 ⇒ 找不到上一级的数据 ⇒ 回落 AppRoot = app 本身
#   ⇒ 用户题库被写进程序目录，下次升级替换 app 就把题库删了（数据丢失级缺陷）。
#   放一个空数据目录进去，第一次启动就落到正确位置，程序与数据天然分离。
$stageData = Join-Path $stage '数据'
New-Item -ItemType Directory -Path $stageData -Force | Out-Null
$dataNote = @'
这个目录是你的题库（数据）—— 刚解压时是空的。

它和程序是分开的：
  · 程序在上一级的 app 目录里 —— 升级时整个替换
  · 数据在这里               —— 升级时一个字节都不动

备份 = 把「数据」这个目录整个拷走。
换电脑 = 带上 app 和 数据 两个目录就行。

第一次用：双击 app 里的「拾光小册.exe」→ 点「＋ 新建学生」填个小名（不用选学科）。

录题（核心用法）：
  1. 把错题照片放进「_收件箱」这个文件夹（可以按批次建子文件夹，例：_收件箱\数学-10月28日\）
  2. 回到程序 → 左侧「录题」→ 勾一张照片 → 点「生成任务单」→ 点「复制任务单」
  3. 把任务单和那张照片一起发给你自己的 AI（程序不联网、不带模型、不收密钥）
  4. 把 AI 回的 JSON 粘回第 3 步的框 → 点「校验」，逐条看哪条不合格

处理过的照片会自动"归档"、不再列在待处理清单里（判据：它在「原卷台账」里被某道错题卡
登记过）。**文件一张都不会删**，仍在 _收件箱 里；录题页点「显示已归档的 N 张」能翻看。
'@
[IO.File]::WriteAllText((Join-Path $stageData '先看这里.txt'), $dataNote + "`r`n", (New-Object System.Text.UTF8Encoding($true)))

# ── 2.6) 预建「_收件箱」并放一句说明（★ 2026-10-27 加）──
# 为什么必须在包里：录题页告诉用户"把照片放进 _收件箱\<批次>\"，而发布包里原先根本没这个目录
#   （干净机器上用户照着找就是找不到）。程序侧 _配方.mjs 收件箱 也会自动补建，
#   但包里先给一个更直观——解压就能看见该往哪放。
$stageInbox = Join-Path $stageData '_收件箱'
New-Item -ItemType Directory -Path $stageInbox -Force | Out-Null
$inboxNote = @'
把错题照片放进这个文件夹（可以按批次建子文件夹）。

例：
  _收件箱\数学-10月28日\p01.jpg
  _收件箱\英语-11月02日\p03.jpg

放好之后 → 打开程序 → 左侧「录题」→ 勾一张照片 → 生成任务单 → 复制给你自己的 AI。
（原图是这套系统里唯一不可再生的数据，放进来的别删；备份时整个「数据」目录一起拷走。）

处理过的照片（已经在「原卷台账」里登记过的）会自动从待处理清单里隐去、算作"已归档"，
列表因此只显示真正还没做的。文件本身不会被移动或删除，仍在 _收件箱 里；
录题页点「显示已归档的 N 张」可以翻看。
'@
[IO.File]::WriteAllText((Join-Path $stageInbox '把照片放这里.txt'), $inboxNote + "`r`n", (New-Object System.Text.UTF8Encoding($true)))

$readme = @'
拾光小册 · GlimmerNote __VER__
================================
完全离线、数据全留在本机的错题本。不联网、不上传、不需要账号。

一、怎么开始
   1. 解压整个文件夹（不要只挑 app 出来）
   2. 双击 app 里的「拾光小册.exe」
   3. 第一次启动 Windows 可能提示"未知发布者"——本程序用的是自签证书（不是购买的正规
      代码签名证书），点「更多信息」→「仍要运行」即可。
   4. 进去点右上角「＋ 新建学生」，填个小名就行（不用选学科）

   ★ 本程序已内置所需的 Node.js（app\node.exe）：**不用另外安装 Node，也不用联网。**
     内置版本与 SHA256 见同目录「内置Node说明.txt」，其许可见「node-LICENSE.txt」。

   ⚠ 唯一需要系统自带的东西：**Microsoft Edge WebView2 运行时**。
     它是 Windows 11 和较新的 Windows 10 自带的组件，多数机器不用管；
     如果双击后弹窗说"缺少 WebView2"、或者窗口一片空白，去微软官网下载
     「Microsoft Edge WebView2 Runtime (Evergreen)」装一次即可，装完不用重启。

二、目录说明
   app    程序（exe + 运行库 + 工具链）。升级时整个替换，不要在里面放自己的东西。
   数据   你的题库。程序升级不会动它一个字节；备份就是把它整个拷走。

三、校验完整性
   同目录的 .sha256 是发布包的 SHA256。核对方法：
     certutil -hashfile 包名.zip SHA256

四、日志在哪
   %LOCALAPPDATA%\拾光小册\shell.log

五、许可
   MIT，见仓库 LICENSE。
'@
$readme = $readme.Replace('__VER__', $ver)
[IO.File]::WriteAllText((Join-Path $stage '使用说明.txt'), $readme + "`r`n", (New-Object System.Text.UTF8Encoding($true)))
Write-Host "  已放：数据\先看这里.txt、使用说明.txt"

# ── 3) 把所有文件时间钉到提交时间（zip 条目会继承文件 mtime）──
Get-ChildItem $stageApp -Recurse -File | ForEach-Object { $_.LastWriteTimeUtc = $stampUtc }
Write-Host "  构建时间戳（钉死）：$stamp"

# ── 4) 压缩 ──
if (-not (Test-Path $relDir)) { New-Item -ItemType Directory -Path $relDir -Force | Out-Null }
$zipName = "GlimmerNote-$ver-win-x64.zip"
$zipPath = Join-Path $relDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)

# ★ 2026-10-24：把 zip 条目名里的反斜杠统一成正斜杠。
#   根因：.NET Framework 的 CreateFromDirectory 在 Windows 上按平台分隔符写条目名，
#   而 ZIP 规范要求正斜杠；macOS/Linux 解压会把整条路径当成一个文件名。
#   Windows 资源管理器虽然能容忍，但公开发布不能靠"能容忍"。做法：只改名，内容不变。
$fixTmp = "$zipPath.rewriting"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$needFix = $false
$zi = [IO.Compression.ZipFile]::OpenRead($zipPath)
foreach ($e in $zi.Entries) { if ($e.FullName.Contains([char]92)) { $needFix = $true; break } }
$zi.Dispose()
if ($needFix) {
  if (Test-Path $fixTmp) { Remove-Item $fixTmp -Force }
  $zo = [IO.Compression.ZipFile]::Open($fixTmp, [IO.Compression.ZipArchiveMode]::Create)
  $zi2 = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    foreach ($e in $zi2.Entries) {
      $name = $e.FullName.Replace([char]92, [char]47)
      $ne = $zo.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
      $ne.LastWriteTime = $e.LastWriteTime
      $src = $e.Open(); $dst = $ne.Open()
      try { $src.CopyTo($dst) } finally { $dst.Dispose(); $src.Dispose() }
    }
  } finally { $zi2.Dispose(); $zo.Dispose() }
  Move-Item $fixTmp $zipPath -Force
  Write-Host "  zip 条目名已规范化（反斜杠 -> 正斜杠）"
} else {
  Write-Host "  zip 条目名已是正斜杠，无需处理"
}

# ── 5) SHA256 ──
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
$shaPath = "$zipPath.sha256"
$line = "$hash *$zipName"
[IO.File]::WriteAllText($shaPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

# ── 6) 产物自检（解回来数一遍）──
$check = Join-Path $env:TEMP ("glimmernote-check-" + [guid]::NewGuid().ToString('N'))
[IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $check)
$hasVer = Test-Path (Join-Path $check 'app\版本.json')
<# ⚠ 2026-10-24：这两条的 Test-Path 必须在 Remove-Item $check **之前**求值 ——
   上一版直接写在清理之后，临时目录已删 ⇒ 恒 False ⇒ 假红。 #>
$hasDataNote = Test-Path (Join-Path $check '数据\先看这里.txt')
$hasReadme = Test-Path (Join-Path $check '使用说明.txt')
$fileN = (Get-ChildItem (Join-Path $check 'app') -Recurse -File).Count
$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Remove-Item $check -Recurse -Force
Remove-Item $stage -Recurse -Force
if (-not $hasVer) { throw "产物自检失败：解包后没有 app\版本.json" }
if (-not $hasDataNote) { throw "产物自检失败：包里缺 数据\先看这里.txt（新手会把数据写进程序目录，升级时丢库）" }
if (-not $hasReadme) { throw "产物自检失败：包里缺 使用说明.txt" }
$zi3 = [IO.Compression.ZipFile]::OpenRead($zipPath)
$badSep = @($zi3.Entries | Where-Object { $_.FullName.Contains([char]92) })
$zi3.Dispose()
if ($badSep.Count -gt 0) { throw ("产物自检失败：zip 条目名含反斜杠 " + $badSep.Count + " 个（例：" + $badSep[0].FullName + "）") }

Write-Host ""
Write-Host "✔ 打包完成" -ForegroundColor Green
Write-Host "  产物：$zipPath"
Write-Host "  大小：$sizeMB MB ／ app 内 $fileN 个文件"
Write-Host "  哈希：$hash"
Write-Host "  校验：$shaPath"
Write-Host ""
Write-Host "下一步：powershell -File scripts\deploy.ps1 -Zip `"$zipPath`""