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
#   用法：
#     powershell -File scripts\fetch-deps.ps1
#     powershell -File scripts\fetch-deps.ps1 -Force
#     powershell -File scripts\fetch-deps.ps1 -LocalNupkg D:\某个\microsoft.web.webview2.1.0.2903.40.nupkg
#   产出：vendor\webview2\{Microsoft.Web.WebView2.Core.dll, Microsoft.Web.WebView2.WinForms.dll, WebView2Loader.dll, DEPS.json}
# ═══════════════════════════════════════════════════════════
param(
  [string]$Version = '1.0.2903.40',
  [string]$OutDir,
  [string]$LocalNupkg,      # 离线：已下好的 .nupkg（其实就是个 zip）
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot          # ...\GlimmerNotedev\scripts → ...\GlimmerNotedev
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'vendor\webview2' }

# 要取的 3 个文件：官方包内路径 → 落地文件名
$want = @(
  @{ entry = 'lib/net462/Microsoft.Web.WebView2.Core.dll';     name = 'Microsoft.Web.WebView2.Core.dll' },
  @{ entry = 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'; name = 'Microsoft.Web.WebView2.WinForms.dll' },
  @{ entry = 'runtimes/win-x64/native/WebView2Loader.dll';     name = 'WebView2Loader.dll' }
)
$depsFile = Join-Path $OutDir 'DEPS.json'

function HashOf($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToUpperInvariant() }

# ── 1) 已就位且哈希对得上 → 直接返回（幂等）──
if (-not $Force -and -not $LocalNupkg -and (Test-Path $depsFile)) {
  $ok = $true
  try {
    $deps = Get-Content $depsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$deps.version -ne $Version) {
      $ok = $false
      Write-Host "  版本变了（$($deps.version) → $Version），重新取" -ForegroundColor Yellow
    } else {
      foreach ($f in $deps.files) {
        $p = Join-Path $OutDir $f.name
        if (-not (Test-Path $p)) { $ok = $false; break }
        if ((HashOf $p) -ne [string]$f.sha256) { $ok = $false; break }
      }
    }
  } catch { $ok = $false }
  if ($ok) {
    Write-Host "✔ WebView2 依赖已就位（$Version），跳过下载" -ForegroundColor Green
    Write-Host "  $OutDir"
    return
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$tmp = Join-Path $env:TEMP ("gn-wv2-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  # ── 2) 拿到 .nupkg（在线下载 或 用本地文件）──
  $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"
  Write-Host "拾光小册 · 取 WebView2 依赖" -ForegroundColor Cyan
  Write-Host "  版本：$Version"
  Write-Host "  落地：$OutDir"
  if ($LocalNupkg) {
    if (-not (Test-Path $LocalNupkg)) { throw "找不到本地包：$LocalNupkg" }
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
  $nupkgHash = HashOf $nupkg
  Write-Host ("  包：{0:N0} 字节  SHA256={1}" -f (Get-Item $nupkg).Length, $nupkgHash)

  # ── 3) 解出 3 个文件（缺项就响亮失败，绝不静默少文件）──
  $zip = [IO.Compression.ZipFile]::OpenRead($nupkg)
  $files = @()
  try {
    foreach ($w in $want) {
      $e = $zip.Entries | Where-Object { $_.FullName -eq $w.entry } | Select-Object -First 1
      if (-not $e) { throw "包结构不对：找不到 $($w.entry)（WebView2 改了布局？先人工核对）" }
      $dst = Join-Path $OutDir $w.name
      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dst, $true)
      $len = (Get-Item $dst).Length
      if ($len -ne $e.Length) { throw "解出大小不符：$($w.name) 期望 $($e.Length)，实际 $len" }
      $files += [ordered]@{ name = $w.name; bytes = $len; sha256 = (HashOf $dst); from = $w.entry }
      Write-Host ("  ✔ {0,-40} {1,9:N0} 字节" -f $w.name, $len)
    }
  } finally { $zip.Dispose() }

  # ── 4) 记锁文件（版本 + 哈希 = 下次可复现、可审计）──
  $deps = [ordered]@{
    package     = 'Microsoft.Web.WebView2'
    version     = $Version
    source      = $(if ($LocalNupkg) { 'local:' + (Split-Path -Leaf $LocalNupkg) } else { $url })
    nupkgSha256 = $nupkgHash
    fetchedAt   = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    note        = '微软三方二进制，不入 git；构建/打包由此取。这 3 个文件是运行时依赖，必须随 exe 发布。'
    files       = $files
  }
  [IO.File]::WriteAllText($depsFile, ($deps | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ""
  Write-Host "✔ 依赖就位" -ForegroundColor Green
  Write-Host "  锁文件：$depsFile"
  Write-Host "  下一步：powershell -File src\shell\build.ps1"
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
