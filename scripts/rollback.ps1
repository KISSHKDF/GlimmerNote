# ═══════════════════════════════════════════════════════════
# 拾光小册 · 回滚
#   场景一：退回上一版（部署时自动备份的那份）
#   场景二：退回指定版本（从 _releases 里的包重新部署）
#   铁律：数据\ 全程不动
#   用法：
#     powershell -File scripts\rollback.ps1 -List
#     powershell -File scripts\rollback.ps1
#     powershell -File scripts\rollback.ps1 -Version 0.1.0
# ═══════════════════════════════════════════════════════════
param(
  # 默认运行区 = <仓库上一级>\GlimmerNote（开发区与运行区并列）。可用 -ProdRoot 覆盖。
  [string]$ProdRoot,
  [switch]$List,
  [string]$Version
)
$ErrorActionPreference = 'Stop'

# 默认运行区 = <仓库上一级>\GlimmerNote（开发区与运行区并列），可用 -ProdRoot 覆盖。
# ⚠ 不能写成 param() 的默认值：Windows PowerShell 5.1 求值 param 默认值时 $PSScriptRoot 仍为空。
if (-not $ProdRoot) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $ProdRoot = Join-Path (Split-Path -Parent $repoRoot) 'GlimmerNote'
}

$appDir     = Join-Path $ProdRoot 'app'
$prevDir    = Join-Path $ProdRoot '_app-上一版'
$relArchive = Join-Path $ProdRoot '_releases'
$logFile    = Join-Path $ProdRoot '部署记录.txt'

function CurVer() {
  $f = Join-Path $appDir '版本.json'
  if (Test-Path $f) { try { return [string]((Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).version) } catch { return '(未知)' } }
  return '(空)'
}
function PrevVer() {
  $f = Join-Path $prevDir '版本.json'
  if (Test-Path $f) { try { return [string]((Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).version) } catch { return '(未知)' } }
  return $null
}

if ($List) {
  Write-Host "拾光小册 · 运行区状态" -ForegroundColor Cyan
  Write-Host "  目录：$ProdRoot"
  Write-Host "  当前版本：$(CurVer)"
  $pv = PrevVer
  if ($pv) { Write-Host "  上一版（可一键回退）：$pv" } else { Write-Host "  上一版：无" }
  Write-Host ""
  $zips = Get-ChildItem $relArchive -Filter *.zip -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  if ($zips) {
    Write-Host "  已归档的发布包：" 
    foreach ($z in $zips) { Write-Host ("    {0}  ({1}, {2:N2} MB)" -f $z.Name, $z.LastWriteTime.ToString('yyyy-MM-dd HH:mm'), ($z.Length/1MB)) }
  } else { Write-Host "  已归档的发布包：无" }
  Write-Host ""
  if (Test-Path $logFile) { Write-Host "  部署记录（最近 10 条）："; Get-Content $logFile -Encoding UTF8 | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" } }
  return
}

$cur = CurVer
Write-Host "拾光小册 · 回滚" -ForegroundColor Cyan
Write-Host "  当前版本：$cur"

if ($Version) {
  # ── 场景二：从归档包重新部署指定版本 ──
  $zip = Get-ChildItem $relArchive -Filter "*$Version*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $zip) {
    $all = (Get-ChildItem $relArchive -Filter *.zip -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ', '
    throw "[回滚失败] _releases 里找不到版本 $Version。现有：$all"
  }
  Write-Host "  目标：$Version（来自 $($zip.Name)）"
  $deploy = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\deploy.ps1'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $deploy -Zip $zip.FullName -ProdRoot $ProdRoot
  return
}

# ── 场景一：退回上一版 ──
$pv = PrevVer
if (-not $pv) { throw "[回滚失败] 没有 _app-上一版 备份，无法一键回退。请用 -Version <版本号> 从归档包重装。" }
if (-not (Test-Path $prevDir)) { throw "[回滚失败] 找不到 $prevDir" }

Write-Host "  目标：$pv（来自 _app-上一版）"
# 把当前版先存到临时，万一回滚也失败还能退回来
$tmpHold = Join-Path $env:TEMP ("glimmernote-rollback-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpHold -Force | Out-Null
Copy-Item (Join-Path $appDir '*') $tmpHold -Recurse -Force -ErrorAction SilentlyContinue

try {
  Get-ChildItem $appDir -Force | Remove-Item -Recurse -Force
  Copy-Item (Join-Path $prevDir '*') $appDir -Recurse -Force
  $now = CurVer
  if ($now -ne $pv) { throw "回滚后版本号不符：期望 $pv，实际 $now" }

  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $logFile -Value "$stamp | $pv | _app-上一版 | 回滚：从 $cur 退到 $pv" -Encoding UTF8

  Write-Host ""
  Write-Host "✔ 回滚完成：$cur → $pv" -ForegroundColor Green
  Write-Host "  数据目录未改动。"
  Write-Host "  注意：现在 _app-上一版 里是 $cur（如需再切回去，用 -Version $cur）"
} catch {
  Write-Host "✖ 回滚失败，正在恢复回滚前的状态…" -ForegroundColor Red
  Get-ChildItem $appDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $tmpHold '*') $appDir -Recurse -Force -ErrorAction SilentlyContinue
  throw $_
} finally {
  if (Test-Path $tmpHold) { Remove-Item $tmpHold -Recurse -Force -ErrorAction SilentlyContinue }
}