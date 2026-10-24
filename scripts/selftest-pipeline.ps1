# ═══════════════════════════════════════════════════════════
# 拾光小册 · 流水线自检（回滚演练）
#   在一套临时沙箱里真跑一遍：装旧版 → 升级 → 回滚 → 指定版本回滚
#   全程验证「数据目录一个字节都没变」
#   铁律：绝不碰真实运行区（GlimmerNote）
#   用法：powershell -File scripts\selftest-pipeline.ps1 [-Keep]
# ═══════════════════════════════════════════════════════════
param([switch]$Keep)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$scripts = Join-Path $root 'scripts'
$relDir = Join-Path $root 'release'

# 取包：优先 release\，不够再并入 归档\（历史包也能参与回滚演练）
$zips = @(Get-ChildItem $relDir -Filter 'GlimmerNote-*.zip' -ErrorAction SilentlyContinue)
$archDir = Join-Path $root '归档'
if ($zips.Count -lt 2 -and (Test-Path $archDir)) {
  $zips += @(Get-ChildItem $archDir -Filter 'GlimmerNote-*.zip' -ErrorAction SilentlyContinue)
}
$zips = @($zips | Sort-Object Name)
if ($zips.Count -lt 2) { throw "自检需要至少两个版本的包（当前 $($zips.Count) 个）。先改 VERSION.json 打两次包。" }

$oldZip = $zips[0]
$newZip = $zips[$zips.Count - 1]
$oldVer = ($oldZip.BaseName -split '-')[1]
$newVer = ($newZip.BaseName -split '-')[1]

$sandbox = Join-Path $env:TEMP ("glimmernote-selftest-" + [guid]::NewGuid().ToString('N'))
$pass = 0; $fail = 0
function Check($name, $cond, $detail) {
  if ($cond) { Write-Host "  ✔ $name" -ForegroundColor Green; $script:pass++ }
  else { Write-Host "  ✖ $name   $detail" -ForegroundColor Red; $script:fail++ }
}
function DataHash($dir) {
  $files = Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue | Sort-Object FullName
  $sb = New-Object System.Text.StringBuilder
  foreach ($f in $files) {
    $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
    [void]$sb.AppendLine($f.FullName.Replace($dir,'') + '|' + $f.Length + '|' + $h)
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes($sb.ToString())
  $sha = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ($sha | ForEach-Object { $_.ToString('x2') }) -join ''
}
function CurVerOf($p) {
  $f = Join-Path $p 'app\版本.json'
  if (Test-Path $f) { return [string]((Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).version) }
  return '(空)'
}

Write-Host "拾光小册 · 流水线自检" -ForegroundColor Cyan
Write-Host "  沙箱：$sandbox"
Write-Host "  用包：$oldVer → $newVer"
Write-Host ""

try {
  # ── 准备沙箱 ──
  foreach ($d in @('app','数据','_app-上一版','_releases')) { New-Item -ItemType Directory -Path (Join-Path $sandbox $d) -Force | Out-Null }
  $dataDir = Join-Path $sandbox '数据'
  New-Item -ItemType Directory -Path (Join-Path $dataDir 'students\s1-小明\cards\M0001-样卡') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $dataDir 'library.json'), '{"schemaVersion":1,"libraryName":"沙箱库"}', (New-Object System.Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $dataDir 'students\s1-小明\cards\M0001-样卡\card.json'), '{"id":"M0001"}', (New-Object System.Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $dataDir 'students\s1-小明\reviews.jsonl'), '{"at":"2026-10-23","cardId":"M0001","result":"right"}' + "`n", (New-Object System.Text.UTF8Encoding($false)))
  $hash0 = DataHash $dataDir
  Write-Host "  数据基线哈希：$($hash0.Substring(0,16))…（共 $((Get-ChildItem $dataDir -Recurse -File).Count) 个文件）"
  Write-Host ""

  # ── 1) 装旧版 ──
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'deploy.ps1') -Zip $oldZip.FullName -ProdRoot $sandbox | Out-Null
  Check "装旧版 $oldVer" ((CurVerOf $sandbox) -eq $oldVer) "实际 $(CurVerOf $sandbox)"
  Check "装旧版后数据未变" ((DataHash $dataDir) -eq $hash0) "数据被动了"

  # ── 2) 升级 ──
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'deploy.ps1') -Zip $newZip.FullName -ProdRoot $sandbox | Out-Null
  Check "升级到 $newVer" ((CurVerOf $sandbox) -eq $newVer) "实际 $(CurVerOf $sandbox)"
  Check "升级后数据未变" ((DataHash $dataDir) -eq $hash0) "数据被动了"
  Check "升级后留下上一版备份" (Test-Path (Join-Path $sandbox '_app-上一版\版本.json')) "没有备份目录"

  # ── 3) 一键回滚 ──
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'rollback.ps1') -ProdRoot $sandbox | Out-Null
  Check "回滚到 $oldVer" ((CurVerOf $sandbox) -eq $oldVer) "实际 $(CurVerOf $sandbox)"
  Check "回滚后数据未变" ((DataHash $dataDir) -eq $hash0) "数据被动了"

  # ── 4) 指定版本回滚 ──
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'rollback.ps1') -ProdRoot $sandbox -Version $newVer | Out-Null
  Check "指定版本切到 $newVer" ((CurVerOf $sandbox) -eq $newVer) "实际 $(CurVerOf $sandbox)"
  Check "指定版本回滚后数据未变" ((DataHash $dataDir) -eq $hash0) "数据被动了"

  # ── 5) 部署记录完整性 ──
  $log = Join-Path $sandbox '部署记录.txt'
  $n = if (Test-Path $log) { (Get-Content $log -Encoding UTF8 | Where-Object { $_ -match '\|' }).Count } else { 0 }
  Check "部署记录写了 $n 条" ($n -ge 3) "记录条数不足"
}
finally {
  if (-not $Keep -and (Test-Path $sandbox)) { Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue }
  elseif ($Keep) { Write-Host "`n（-Keep：沙箱保留在 $sandbox）" -ForegroundColor Yellow }
}

Write-Host ""
if ($fail -eq 0) {
  Write-Host "✔ 流水线自检全部通过（$pass 项）" -ForegroundColor Green
  Write-Host "  这意味着：升级和回滚都不会碰数据目录。"
  exit 0
} else {
  Write-Host "✖ 流水线自检有 $fail 项未通过（通过 $pass 项）" -ForegroundColor Red
  exit 1
}
