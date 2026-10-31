# ═══════════════════════════════════════════════════════════
# 拾光小册 · 部署清单写入（唯一实现）
#   被 scripts\deploy.ps1（部署）与 scripts\rollback.ps1（回滚）共用，二者只 dot-source 本文件。
#
# 为什么必须抽成一份（2026-10-31 E04 整改，外部复核已证实）：
#   改前只有 deploy.ps1 写 _deploy-manifest.json，rollback.ps1 全文 107 行**零**清单写入。
#   于是"正常回滚"之后：清单还写着回滚前的版本、而 app\ 已经是旧版本
#   （实测沙箱：deploy 0.0.1 → verify exit 0；deploy 0.0.2 → verify exit 0；
#    rollback → verify **exit 1**，清单 0.0.2 / 实际 0.0.1 / 3 个文件被改过）。
#   也就是说"一键回滚"这个**唯一被允许的线上回退手段**，每用一次都会让一致性门禁误红 ——
#   门禁一旦对"合法操作"报红，人就会开始无视它（本仓最贵的一类事故，见 L-175）。
#
# 为什么不把这段复制一份到 rollback.ps1：两份实现必然漂移（本仓 L-286），
#   而清单是 scripts\verify-deploy.mjs 的**唯一依据** ⇒ 实现漂移 = 闸门本身失真。
#
# 用法（dot-source 后调用；不要用 & 调用，需要拿到同一个 scope 的函数）：
#   . (Join-Path $PSScriptRoot 'deploy-manifest.ps1')
#   $mf = Write-DeployManifest -ProdRoot $ProdRoot -Version $ver -Zip $zipName -ZipSha256 $sha -Source 'deploy'
#
# 判据：清单**只许由落地内容导出** —— app\版本.json 的版本与传入版本不一致就直接 throw，
#   否则"清单写了 A、app\ 是 B"会变成一种自证清白的造假路径。
# ═══════════════════════════════════════════════════════════
function Write-DeployManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ProdRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Zip = '',
    [string]$ZipSha256 = '',
    [string]$Source = 'deploy',
    [string]$Stamp = ''
  )
  $appDir = Join-Path $ProdRoot 'app'
  $verFile = Join-Path $appDir '版本.json'
  if (-not (Test-Path $verFile)) { throw "[清单] 没有找到 $verFile，拒绝写清单" }
  $landed = [string]((Get-Content $verFile -Raw -Encoding UTF8 | ConvertFrom-Json).version)
  if ($landed -ne [string]$Version) {
    throw "[清单] 落地版本($landed) ≠ 期望版本($Version)，拒绝写清单（清单只能由落地内容导出）"
  }
  if (-not $Stamp) { $Stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }

  $fileMap = [ordered]@{}
  foreach ($f in @(Get-ChildItem $appDir -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($appDir.Length).TrimStart('\') -replace '\\', '/'
    $fileMap[$rel] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  }
  if ($fileMap.Count -eq 0) { throw "[清单] app\ 里一个文件都没有，拒绝写空清单（空清单等于把任何文件都判成凭空多出）" }

  $manifest = [ordered]@{
    schema     = 1
    version    = [string]$Version
    zip        = $Zip
    zipSha256  = $ZipSha256
    deployedAt = $Stamp
    appDir     = 'app'
    count      = $fileMap.Count
    files      = $fileMap
    source     = $Source
    note       = '本清单由 deploy.ps1 / rollback.ps1 共用的 Write-DeployManifest 唯一写入；verify-deploy.mjs 用它判断运行区是否被绕过部署改动。'
  }
  $manifestPath = Join-Path $ProdRoot '_deploy-manifest.json'
  ($manifest | ConvertTo-Json -Depth 5) | Set-Content -Path $manifestPath -Encoding UTF8
  return [pscustomobject]@{ Path = $manifestPath; Count = $fileMap.Count; Version = [string]$Version }
}
