# ═══════════════════════════════════════════════════════════
# 拾光小册 · 部署到运行区
#   铁律：只替换 app\，绝不触碰 数据\
#   用法：
#     powershell -File scripts\deploy.ps1 -Zip release\GlimmerNote-0.1.0-win-x64.zip
#     powershell -File scripts\deploy.ps1 -Zip <包> -WhatIf   （只看会做什么，不执行）
# ═══════════════════════════════════════════════════════════
param(
  [Parameter(Mandatory=$true)][string]$Zip,
  [string]$ProdRoot,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'

# 默认运行区 = <仓库上一级>\GlimmerNote（开发区与运行区并列），可用 -ProdRoot 覆盖。
# ⚠ 不能写成 param() 的默认值：Windows PowerShell 5.1 求值 param 默认值时 $PSScriptRoot 仍为空，
#   会报 "Cannot bind argument to parameter 'Path' because it is an empty string"（2026-10-23 实测）。
if (-not $ProdRoot) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $ProdRoot = Join-Path (Split-Path -Parent $repoRoot) 'GlimmerNote'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

function Fail($msg) { throw "[部署失败] $msg" }

# ── 0) 前置检查 ──
if (-not (Test-Path $Zip)) { $Zip = Join-Path (Get-Location) $Zip }
if (-not (Test-Path $Zip)) { Fail "找不到发布包：$Zip" }
if (-not (Test-Path $ProdRoot)) { Fail "找不到运行区：$ProdRoot（请先建好 app\ 与 数据\）" }

$zipItem = Get-Item $Zip

# 哈希校验（若同目录有 .sha256）
$shaFile = "$($zipItem.FullName).sha256"
$expect = $null
if (Test-Path $shaFile) {
  $line = (Get-Content $shaFile -Raw -Encoding UTF8).Trim()
  $expect = ($line -split '\s+')[0]
}
$actual = (Get-FileHash $zipItem.FullName -Algorithm SHA256).Hash
if ($expect -and ($expect.ToUpper() -ne $actual.ToUpper())) {
  Fail "哈希不符！期望 $expect，实际 $actual（包可能被改动或损坏）"
}

# ── 1) 解到临时目录并验形状 ──
$tmp = Join-Path $env:TEMP ("glimmernote-deploy-" + [guid]::NewGuid().ToString('N'))
[IO.Compression.ZipFile]::ExtractToDirectory($zipItem.FullName, $tmp)
$newApp = Join-Path $tmp 'app'
if (-not (Test-Path (Join-Path $newApp '版本.json'))) {
  Remove-Item $tmp -Recurse -Force
  Fail "包结构不对：解包后应有 app\版本.json"
}
$V = Get-Content (Join-Path $newApp '版本.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$newVer = [string]$V.version

# ── 2) 现状 ──
$appDir     = Join-Path $ProdRoot 'app'
$dataDir    = Join-Path $ProdRoot '数据'
$prevDir    = Join-Path $ProdRoot '_app-上一版'
$relArchive = Join-Path $ProdRoot '_releases'
$logFile    = Join-Path $ProdRoot '部署记录.txt'

foreach ($d in @($appDir,$dataDir,$prevDir,$relArchive)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

$oldVer = '(空)'
if (Test-Path (Join-Path $appDir '版本.json')) {
  try { $oldVer = [string]((Get-Content (Join-Path $appDir '版本.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version) } catch { $oldVer = '(未知)' }
}

Write-Host "拾光小册 · 部署" -ForegroundColor Cyan
Write-Host "  从：$oldVer"
Write-Host "  到：$newVer"
Write-Host "  包：$($zipItem.Name)（$([math]::Round($zipItem.Length/1MB,2)) MB）"
Write-Host "  运行区：$ProdRoot"
Write-Host "  数据目录：$dataDir  ← 本次部署不会碰它"
if ($WhatIf) { Write-Host "`n（-WhatIf：只做检查，未实际部署）" -ForegroundColor Yellow; Remove-Item $tmp -Recurse -Force; return }

# ── 3) 备份当前 app（失败可退）──
$backupMade = $false
if ((Get-ChildItem $appDir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
  if (Test-Path $prevDir) { Remove-Item $prevDir -Recurse -Force }
  New-Item -ItemType Directory -Path $prevDir -Force | Out-Null
  Copy-Item (Join-Path $appDir '*') $prevDir -Recurse -Force
  $backupMade = $true
}

try {
  # ── 4) 替换 app\（只动这一个目录）──
  Get-ChildItem $appDir -Force | Remove-Item -Recurse -Force
  Copy-Item (Join-Path $newApp '*') $appDir -Recurse -Force

  # ── 5) 校验落地版本 ──
  $landed = (Get-Content (Join-Path $appDir '版本.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ([string]$landed -ne $newVer) { throw "落地版本号不符：期望 $newVer，实际 $landed" }

  # ── 6) 归档发布包 + 写部署记录 ──
  # 注意：从 _releases 重新部署时，源就是目标，直接 Copy-Item 会报"不能覆盖自己"
  $destZip = Join-Path $relArchive $zipItem.Name
  if ([IO.Path]::GetFullPath($zipItem.FullName) -ne [IO.Path]::GetFullPath($destZip)) {
    Copy-Item $zipItem.FullName $destZip -Force
  }
  $destSha = "$destZip.sha256"
  if ((Test-Path $shaFile) -and ([IO.Path]::GetFullPath($shaFile) -ne [IO.Path]::GetFullPath($destSha))) {
    Copy-Item $shaFile $destSha -Force
  }

  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $rec = @()
  if (-not (Test-Path $logFile)) {
    $rec += '# 拾光小册 · 部署记录'
    $rec += '# 格式：时间 | 版本 | 来源包 | 说明'
    $rec += ''
  }
  $rec += "$stamp | $newVer | $($zipItem.Name) | 从 $oldVer 升级"
  Add-Content -Path $logFile -Value $rec -Encoding UTF8

  Write-Host ""
  Write-Host "✔ 部署完成：$oldVer → $newVer" -ForegroundColor Green
  Write-Host "  程序：$appDir"
  Write-Host "  数据：$dataDir（未改动）"
  Write-Host "  记录：$logFile"
  Write-Host ""
  Write-Host "下一步：启动 app\ 里的程序，确认能开；再用两天再发布。"
} catch {
  Write-Host ""
  Write-Host "✖ 部署过程中出错，正在自动回退…" -ForegroundColor Red
  if ($backupMade) {
    Get-ChildItem $appDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $prevDir '*') $appDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  已回退到 $oldVer" -ForegroundColor Yellow
  } else {
    Write-Host "  之前没有可回退的版本，app\ 可能为空" -ForegroundColor Yellow
  }
  throw $_
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}