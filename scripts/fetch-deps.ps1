# ═══════════════════════════════════════════════════════════
# 拾光小册 · 取 WebView2 依赖（构建前置步骤）
#
#   为什么需要这一步：
#     WebView2 的 3 个文件是**微软的三方二进制**，不该进 git（.gitignore 挡 *.dll），
#     但编壳 / 打包时必须拿到它们。所以：从官方 NuGet 包取，落到 vendor\（同样不入 git），
#     并且把版本与哈希记进 vendor\webview2\DEPS.json —— 下次任何人重跑都能拿到同样的文件。
#
#   注意：这 3 个文件**不是"用完就删的编译零件"**。
#     · Core/WinForms 两个 dll 是壳 exe 运行时必须加载的 .NET 库；
#     · WebView2Loader.dll 是 exe 启动时用来找系统 Edge 运行时的加载器。
#     三者必须**跟 exe 一起发布**（build.ps1 会把它们拷到 src\app\，打包时进包）。
#
#   ★ 2026-11-02 R9 整改（外部复核 A4 已实证：伪造包可过）：
#     改前 nupkg 与 DLL 的哈希都是**取得之后**才算，唯一的比对对象是脚本自己上一次写的
#     vendor\webview2\DEPS.json（而 vendor/ 被 .gitignore 忽略）⇒ 只能发现后续篡改，
#     验不了"首次获取到的到底是不是官方那一份"。实测：两个内容任意的 715 字节伪包
#     都打印 `✔ 依赖就位`、exit 0，并各自把伪造值的哈希如实写进锁文件。
#     现在多一份**受控预期哈希清单** src\shell\webview2-deps.lock.json（入 git，唯一外部锚点）：
#       ① 锁文件缺失 / 读不懂 / 形状不对 → **fail-closed**，不猜、不放过，并给出获取途径；
#       ② **解包前**比 nupkg 的 sha256；
#       ③ 先解到**临时暂存区**，逐个比 DLL 的字节数与 sha256（任一不符 → 响亮失败）；
#       ④ 全部通过才搬进 vendor\，搬完再复核一次（目标目录不可写/被占用也能立刻发现）；
#       ⑤ 幂等早退分支也比**锁文件**的预期值，不再比脚本自己上次写的 DEPS.json。
#     所以任何一步不合格时，vendor\ 里的文件**一个字节都不会被改**。
#     DEPS.json 仍然只是**运行时取得记录**（格式不变）—— 它是记录，不是判据。
#
#   用法：
#     powershell -File scripts\fetch-deps.ps1
#     powershell -File scripts\fetch-deps.ps1 -Force
#     powershell -File scripts\fetch-deps.ps1 -LocalNupkg D:\某个\microsoft.web.webview2.1.0.2903.40.nupkg
#     （-LocalNupkg 走**完全相同**的校验规则。版本真源是锁文件，-Version 只用于一致性自检。）
#   产出：vendor\webview2\{Microsoft.Web.WebView2.Core.dll, Microsoft.Web.WebView2.WinForms.dll, WebView2Loader.dll, DEPS.json}
# ═══════════════════════════════════════════════════════════
param(
  [string]$Version = '',    # 省略即用锁文件里的版本；给了就必须与锁文件一致（不许两处各写一份版本号）
  [string]$OutDir,
  [string]$LocalNupkg,      # 离线：已下好的 .nupkg（其实就是个 zip）
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

# ★ 2026-11-02 R21：5.1 宿主环境自愈（见 scripts\_PS环境.ps1 的说明）
#   ⚠ 只在文件真存在时 dot-source：本文件会被部分用例/工具**单独**复制到沙箱里跑，
#     那时没有 _PS环境.ps1。缺了就**显式告警**继续（可见降级），不静默、也不硬崩。
$psEnvSelfHeal = Join-Path $PSScriptRoot '_PS环境.ps1'
if (Test-Path -LiteralPath $psEnvSelfHeal) { . $psEnvSelfHeal }
else { Write-Host '  ⚠ 缺少 scripts\_PS环境.ps1（5.1 宿主环境自愈）：沿用当前 PSModulePath 继续' -ForegroundColor Yellow }
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot          # ...\GlimmerNotedev\scripts → ...\GlimmerNotedev
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'vendor\webview2' }

# 受控预期哈希清单（**入 git** 的唯一外部锚点：每台机器、每次取包都从它读期望值）
$lockFile = Join-Path $repoRoot 'src\shell\webview2-deps.lock.json'
$depsFile = Join-Path $OutDir 'DEPS.json'

function HashOf($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToUpperInvariant() }

# 校验闸门：**唯一**的比对点（nupkg 与每个 DLL 都走这两个函数）。
# 它们就是本步骤的全部牙齿 —— tests\neg-deps-lock.cjs 的阴性自证把这两处 `-ne` 换成 `$false`，
# "伪造包必须被接受"必须复现（否则说明这道闸门是装饰）。
function AssertSha256([string]$label, [string]$got, [string]$expected) {
  if ($got -ne $expected) {
    throw "✖ $label 的 SHA256 与受控预期不符（校验未过）：`r`n    受控预期 $expected`r`n    实际     $got`r`n  已中止：不合格的文件不会落到 $OutDir"
  }
}
function AssertBytes([string]$label, [int64]$got, [int64]$expected) {
  if ($got -ne $expected) {
    throw "✖ $label 的大小与受控预期不符：受控预期 $expected 字节，实际 $got 字节"
  }
}

# ── 0) 读受控预期哈希清单（缺 / 坏一律 fail-closed：绝不"没有期望值就先放过"）──
if (-not (Test-Path -LiteralPath $lockFile)) {
  throw ("✖ 找不到受控预期哈希清单：$lockFile`r`n" +
    "  它是本步骤的**唯一外部锚点**：没有它就无法判断取到的包是不是官方那一份。`r`n" +
    "  拒绝继续（fail-closed）—— 宁可取不到依赖，也不许悄悄接受一个未经核对的三方二进制。`r`n" +
    "  获取途径：它随仓库版本化，正常克隆一定带着它。恢复方式：`r`n" +
    "    git -C `"$repoRoot`" checkout -- src/shell/webview2-deps.lock.json`r`n" +
    "  若 git 说该路径不存在，说明这份工作副本不是完整克隆（或文件被删 / 被 .gitignore 挡住）。")
}
$lock = $null
try { $lock = Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { throw "✖ 受控预期哈希清单读不出来（JSON 解析失败）：$lockFile`r`n    $($_.Exception.Message)`r`n  修法：git checkout -- src/shell/webview2-deps.lock.json" }
$lockVersion = [string]$lock.version
$expectNupkg = ([string]$lock.nupkgSha256).ToUpperInvariant()
if ($lockVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "✖ 锁文件 version 形状不对：'$lockVersion'（期望四段版本号，如 1.0.2903.40）" }
if ($expectNupkg -notmatch '^[0-9A-F]{64}$') { throw "✖ 锁文件 nupkgSha256 不是 64 位十六进制：'$expectNupkg'" }
$want = @()
$wantNames = @{}
foreach ($f in @($lock.files)) {
  $n = [string]$f.name
  $frm = [string]$f.from
  $h = ([string]$f.sha256).ToUpperInvariant()
  if (-not $n -or -not $frm) { throw "✖ 锁文件 files[] 缺 name / from：$($f | ConvertTo-Json -Compress)" }
  if ($h -notmatch '^[0-9A-F]{64}$') { throw "✖ 锁文件 files[] 的 sha256 不是 64 位十六进制（$n）：'$h'" }
  $rawBytes = $f.bytes
  if ($null -eq $rawBytes) { throw "✖ 锁文件 files[] 缺 bytes（$n）：$lockFile" }
  $nBytes = 0
  try { $nBytes = [int64]$rawBytes } catch { throw "✖ 锁文件 files[] 的 bytes 不是整数（$n）：'$rawBytes'" }
  if ($nBytes -le 0) { throw "✖ 锁文件 files[] 的 bytes 不是正整数（$n）：'$rawBytes'" }
  if ($wantNames.ContainsKey($n)) { throw "✖ 锁文件 files[] 里有重复的 name：$n（$lockFile）" }
  $wantNames[$n] = $true
  $want += @{ name = $n; entry = $frm; bytes = $nBytes; sha256 = $h }
}
if ($want.Count -lt 1) { throw "✖ 锁文件 files[] 是空的：$lockFile" }
# 壳真正需要的三份，少一份都编不出可用的壳 —— 清单里必须一条不缺（多出来的条目按清单顺序一并校验）
foreach ($req in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
  if (-not $wantNames.ContainsKey($req)) { throw "✖ 锁文件缺必需条目：$req`r`n  这 3 个文件是壳的运行时依赖，少一个都编不出可用的壳；请核对 src\shell\webview2-deps.lock.json。" }
}
if ($Version -and $Version -ne $lockVersion) {
  throw "✖ -Version $Version 与锁文件版本 $lockVersion 不符：版本号只有**一个**真源（锁文件）。`r`n  要换版本请改锁文件（version / source / nupkgSha256 / files 一起改），并重新核对官方包哈希。"
}
$Version = $lockVersion
$url = [string]$lock.source
if (-not $url) { $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg" }

# ── 1) 已就位且**与受控预期一致** → 直接返回（幂等）──
if (-not $Force -and -not $LocalNupkg -and (Test-Path $depsFile)) {
  $ok = $true
  try {
    $deps = Get-Content $depsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$deps.version -ne $Version) {
      $ok = $false
      Write-Host "  版本变了（$($deps.version) → $Version），重新取" -ForegroundColor Yellow
    } else {
      foreach ($w in $want) {
        $p = Join-Path $OutDir $w.name
        if (-not (Test-Path -LiteralPath $p)) { $ok = $false; break }
        # 比的是**锁文件**的预期值，不是 DEPS.json 自己记的那份（自算自记不算校验）
        if ((HashOf $p) -ne $w.sha256) {
          Write-Host "  已就位的文件与受控预期哈希不符（$($w.name)），重新取" -ForegroundColor Yellow
          $ok = $false; break
        }
      }
    }
  } catch { $ok = $false }
  if ($ok) {
    Write-Host "✔ WebView2 依赖已就位（$Version），与受控预期哈希一致，跳过下载" -ForegroundColor Green
    Write-Host "  $OutDir"
    return
  }
}

$tmp = Join-Path $env:TEMP ("gn-wv2-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  # ── 2) 拿到 .nupkg（在线下载 或 用本地文件）──
  Write-Host "拾光小册 · 取 WebView2 依赖" -ForegroundColor Cyan
  Write-Host "  版本：$Version（受控预期哈希清单：$lockFile）"
  Write-Host "  落地：$OutDir"
  if ($LocalNupkg) {
    if (-not (Test-Path -LiteralPath $LocalNupkg)) { throw "找不到本地包：$LocalNupkg" }
    $nupkg = Join-Path $tmp (Split-Path -Leaf $LocalNupkg)
    Copy-Item -LiteralPath $LocalNupkg -Destination $nupkg -Force
    Write-Host "  来源：本地文件 $LocalNupkg"
  } else {
    Write-Host "  来源：$url"
    Write-Host "  下载中…"
    $nupkg = Join-Path $tmp "microsoft.web.webview2.$Version.nupkg"
    try {
      Invoke-WebRequest -Uri $url -OutFile $nupkg -TimeoutSec 300 -UseBasicParsing
    } catch {
      throw "下载失败：$($_.Exception.Message)`r`n  若本机无外网，可手动下载同名 .nupkg 后跑：" +
            "`r`n    powershell -File scripts\fetch-deps.ps1 -LocalNupkg <那个文件>"
    }
  }
  # ② 解包**前**：包本身必须就是受控预期的那一份
  $nupkgHash = HashOf $nupkg
  Write-Host ("  包：{0:N0} 字节  SHA256={1}" -f (Get-Item $nupkg).Length, $nupkgHash)
  AssertSha256 'nupkg（解包前校验）' $nupkgHash $expectNupkg

  # ── 3) 解到**临时暂存区**（绝不直接写 vendor\）──
  $stage = Join-Path $tmp 'stage'
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $zip = [IO.Compression.ZipFile]::OpenRead($nupkg)
  $staged = @()
  try {
    foreach ($w in $want) {
      $e = $zip.Entries | Where-Object { $_.FullName -eq $w.entry } | Select-Object -First 1
      if (-not $e) { throw "包结构不对：找不到 $($w.entry)（WebView2 改了布局？先人工核对）" }
      $sp = Join-Path $stage $w.name
      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $sp, $true)
      $len = (Get-Item $sp).Length
      if ($len -ne $e.Length) { throw "解出大小不符：$($w.name) 包内记录 $($e.Length) 字节，实际 $len 字节" }
      # ③ 解包**后**：字节数与哈希都必须等于受控预期
      AssertBytes $w.name $len $w.bytes
      AssertSha256 $w.name (HashOf $sp) $w.sha256
      $staged += @{ name = $w.name; from = $w.entry; path = $sp; bytes = $len; sha256 = $w.sha256 }
    }
  } finally { $zip.Dispose() }

  # ── 4) 全部校验通过才搬运（上面任何一步失败时都不会碰到 vendor\）──
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $files = @()
  foreach ($s in $staged) {
    $dst = Join-Path $OutDir $s.name
    Copy-Item -LiteralPath $s.path -Destination $dst -Force
    $h = HashOf $dst
    AssertSha256 "$($s.name)（落盘后复核）" $h $s.sha256
    $files += [ordered]@{ name = $s.name; bytes = $s.bytes; sha256 = $h; from = $s.from }
    Write-Host ("  ✔ {0,-40} {1,9:N0} 字节" -f $s.name, $s.bytes)
  }

  # ── 5) 记运行时取得记录（DEPS.json 格式不变：它是"这次取到了什么"，不是判据）──
  $deps = [ordered]@{
    package     = 'Microsoft.Web.WebView2'
    version     = $Version
    source      = $(if ($LocalNupkg) { 'local:' + (Split-Path -Leaf $LocalNupkg) } else { $url })
    nupkgSha256 = $nupkgHash
    fetchedAt   = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    note        = '微软三方二进制，不入 git；构建/打包由此取。这 3 个文件是运行时依赖，必须随 exe 发布。哈希已与 src\shell\webview2-deps.lock.json 的受控预期逐个核对一致。'
    files       = $files
  }
  [IO.File]::WriteAllText($depsFile, ($deps | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ""
  Write-Host "✔ 依赖就位（已逐个核对受控预期哈希）" -ForegroundColor Green
  Write-Host "  锁文件：$depsFile"
  Write-Host "  下一步：powershell -File src\shell\build.ps1"
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
