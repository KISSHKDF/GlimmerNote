# ═══════════════════════════════════════════════════════════
# 拾光小册 · 回滚
#   场景一：退回上一版（部署时自动备份的那份）
#   场景二：退回指定版本（从 _releases 里的包重新部署）
#   铁律：数据\ 全程不动
#   铁律：回滚成功后必须**按落地内容重写** _deploy-manifest.json（2026-10-31 E04）——
#         否则"回滚"这个合法操作会让 scripts\verify-deploy.mjs 必然误红
#         （清单还是新版、app\ 已是旧版 ⇒ 门禁把合法回滚判成"绕过部署改动"）。
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

# ── 清单写入的唯一实现（与 deploy.ps1 共用；2026-10-31 E04）──
. (Join-Path $PSScriptRoot 'deploy-manifest.ps1')

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
  # 场景二走 deploy.ps1，清单由它写；但子进程退出码必须透传 ——
  # 原实现直接 return，deploy 失败时本脚本仍报成功（失败被静默吞掉）。
  if ($LASTEXITCODE -ne 0) { throw "[回滚失败] deploy.ps1 退出码 $LASTEXITCODE（版本 $Version 未能部署）" }
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
# 清单也要备份：本脚本会重写它，回滚中途失败时必须能一起退回去，
# 否则会出现"app\ 已退回旧版、清单却写着新版"的错配（比不回滚更糟）。
# ⚠ 备份**不能**放进 $tmpHold：回退段是 `Copy-Item (Join-Path $tmpHold '*') $appDir`，
#   放进去会被一起塞进 app\（污染运行区，还让 verify-deploy 报"凭空多出"）。
#   所以单独放一个临时文件。
$manifestPath = Join-Path $ProdRoot '_deploy-manifest.json'
$tmpManifest = $null
if (Test-Path $manifestPath) {
  $tmpManifest = Join-Path $env:TEMP ("glimmernote-manifest-" + [guid]::NewGuid().ToString('N') + '.json')
  Copy-Item $manifestPath $tmpManifest -Force
}

try {
  Get-ChildItem $appDir -Force | Remove-Item -Recurse -Force
  Copy-Item (Join-Path $prevDir '*') $appDir -Recurse -Force
  $now = CurVer
  if ($now -ne $pv) { throw "回滚后版本号不符：期望 $pv，实际 $now" }

  # ── 按**落地内容**重写部署清单（E04 的修复本体）──
  #  为什么放在写部署记录之前：清单写失败就 throw → 走 catch 整体回退（含清单）；
  #  先写记录后写清单的话，失败时会留下"记录说回滚了、清单还是新版"的假账。
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $mf = Write-DeployManifest -ProdRoot $ProdRoot -Version $pv -Source 'rollback（_app-上一版）' -Stamp $stamp
  Write-Host "  清单：$($mf.Path)（$($mf.Count) 个文件 sha256，版本 $($mf.Version)）"
  Add-Content -Path $logFile -Value "$stamp | $pv | _app-上一版 | 回滚：从 $cur 退到 $pv" -Encoding UTF8

  Write-Host ""
  Write-Host "✔ 回滚完成：$cur → $pv" -ForegroundColor Green
  Write-Host "  数据目录未改动。"
  Write-Host "  注意：现在 _app-上一版 里是 $cur（如需再切回去，用 -Version $cur）"
} catch {
  Write-Host "✖ 回滚失败，正在恢复回滚前的状态…" -ForegroundColor Red
  Get-ChildItem $appDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $tmpHold '*') $appDir -Recurse -Force -ErrorAction SilentlyContinue
  # 清单单独回退：它在 $ProdRoot 下（不在 app\ 里），上面的 Copy-Item 不会带它。
  # 无旧清单（历史上从没部署过）时删掉刚写的那份，保持"没有清单"这个原状。
  if ($tmpManifest -and (Test-Path $tmpManifest)) {
    Copy-Item $tmpManifest $manifestPath -Force -ErrorAction SilentlyContinue
  } else {
    Remove-Item $manifestPath -Force -ErrorAction SilentlyContinue
  }
  throw $_
} finally {
  if (Test-Path $tmpHold) { Remove-Item $tmpHold -Recurse -Force -ErrorAction SilentlyContinue }
  if ($tmpManifest -and (Test-Path $tmpManifest)) { Remove-Item $tmpManifest -Force -ErrorAction SilentlyContinue }
}