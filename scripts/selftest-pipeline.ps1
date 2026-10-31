# ═══════════════════════════════════════════════════════════
# 拾光小册 · 流水线自检（回滚演练）
#   在一套临时沙箱里真跑一遍：装旧版 → 升级 → 回滚 → 指定版本回滚
#   全程验证「数据目录一个字节都没变」
#   ★ 2026-10-31 E04：回滚之后必须再跑一次 verify-deploy（部署一致性），
#     并把它的失败记成断言红。改前本脚本**全文不调用** verify-deploy ⇒
#     "回滚不写清单、门禁必然误红"这个缺陷在自检里永远看不见（自检恒绿 = 假绿）。
#   铁律：绝不碰真实运行区（GlimmerNote）
#   用法：powershell -File scripts\selftest-pipeline.ps1 [-Keep]
# ═══════════════════════════════════════════════════════════
param([switch]$Keep)
$ErrorActionPreference = 'Stop'

# ── 回退耗时上限（判据 L-05：「回退耗时已知且有上限」）──
# 依据：2026-10-29 审计轮实测 场景一 0.528 s / 场景二 3.893 s（40 MB 包），各留约 3~4 倍余量。
# 上限不是 SLA，是"某次改动让回退悄悄慢一个数量级"的报警器：超限即 exit 3。
$LIMIT1_SEC = 2.0     # 场景一：一键回退（从 app\_app-上一版 恢复）
$LIMIT2_SEC = 15.0    # 场景二：指定版本回退（从 _releases\ 归档包重装）
$sw = [Diagnostics.Stopwatch]::StartNew()   # 总耗时
$sec1 = $null; $sec2 = $null; $timingBad = $false

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$scripts = Join-Path $root 'scripts'
$relDir = Join-Path $root 'release'
$recFile = Join-Path $root 'docs\回退演练记录.md'   # 计时落盘（只追加数据行）

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
# ── 部署一致性校验（回滚后必跑；失败要变成断言红，不许只打印）──
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue)
function VerifyDeployOf($prod) {
  if (-not $nodeExe) { return [pscustomobject]@{ Code = -1; Out = '本机找不到 node，无法跑 verify-deploy' } }
  $script = Join-Path (Join-Path $root 'scripts') 'verify-deploy.mjs'
  $out = & $nodeExe.Source $script --prod $prod 2>&1
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = (@($out) -join ' ') }
}
function ManifestVerOf($prod) {
  $f = Join-Path $prod '_deploy-manifest.json'
  if (-not (Test-Path $f)) { return $null }
  try { return [string]((Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).version) } catch { return '(读不懂)' }
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

  # ── 3) 一键回滚（计时）──
  $sw1 = [Diagnostics.Stopwatch]::StartNew()
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'rollback.ps1') -ProdRoot $sandbox | Out-Null
  $sw1.Stop()
  $sec1 = [Math]::Round($sw1.Elapsed.TotalSeconds, 2)
  Write-Host "  场景一（一键回退）耗时：$sec1 s（上限 $LIMIT1_SEC s）"
  Check "回滚到 $oldVer" ((CurVerOf $sandbox) -eq $oldVer) "实际 $(CurVerOf $sandbox)"
  Check "回滚后数据未变" ((DataHash $dataDir) -eq $hash0) "数据被动了"
  # ★ E04：回滚必须重写清单，且"落地版本 == 清单版本"，否则一致性门禁必然误红
  Check "回滚后清单版本 == 落地版本（$oldVer）" ((ManifestVerOf $sandbox) -eq $oldVer) "清单版本 $(ManifestVerOf $sandbox) / 落地 $(CurVerOf $sandbox)"
  $vd1 = VerifyDeployOf $sandbox
  Check "回滚后部署一致性校验通过（verify-deploy exit 0）" ($vd1.Code -eq 0) ("exit $($vd1.Code)：$($vd1.Out)")

  # ── 4) 指定版本回滚（计时）──
  $sw2 = [Diagnostics.Stopwatch]::StartNew()
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'rollback.ps1') -ProdRoot $sandbox -Version $newVer | Out-Null
  $sw2.Stop()
  $sec2 = [Math]::Round($sw2.Elapsed.TotalSeconds, 2)
  Write-Host "  场景二（指定版本回退）耗时：$sec2 s（上限 $LIMIT2_SEC s）"
  Check "指定版本切到 $newVer" ((CurVerOf $sandbox) -eq $newVer) "实际 $(CurVerOf $sandbox)"
  Check "指定版本回滚后数据未变" ((DataHash $dataDir) -eq $hash0) "数据被动了"
  Check "指定版本回滚后清单版本 == 落地版本（$newVer）" ((ManifestVerOf $sandbox) -eq $newVer) "清单版本 $(ManifestVerOf $sandbox) / 落地 $(CurVerOf $sandbox)"
  $vd2 = VerifyDeployOf $sandbox
  Check "指定版本回滚后部署一致性校验通过（verify-deploy exit 0）" ($vd2.Code -eq 0) ("exit $($vd2.Code)：$($vd2.Out)")

  # ── 5) 部署记录完整性 ──
  $log = Join-Path $sandbox '部署记录.txt'
  $n = if (Test-Path $log) { (Get-Content $log -Encoding UTF8 | Where-Object { $_ -match '\|' }).Count } else { 0 }
  Check "部署记录写了 $n 条" ($n -ge 3) "记录条数不足"

  # ── 6) 计时落盘 + 上限判定（沙箱照旧删除，只留记录行）──
  $timingBad = ($sec1 -gt $LIMIT1_SEC) -or ($sec2 -gt $LIMIT2_SEC)
  $mark = if ($timingBad) { '❌' } else { '✅' }
  $row = '| {0} | {1}→{2} | 场景一 {3}s | 场景二 {4}s | 断言 {5} | 上限 {6}s/{7}s | {8} |' -f `
    (Get-Date).ToString('yyyy-MM-dd HH:mm'), $oldVer, $newVer,
    $sec1.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture),
    $sec2.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture),
    "$pass/$($pass + $fail)",
    [int]$LIMIT1_SEC, [int]$LIMIT2_SEC, $mark
  if (Test-Path -LiteralPath $recFile) {
    $raw = Get-Content -LiteralPath $recFile -Raw
    $prefix = if ($raw.EndsWith("`n")) { '' } else { "`n" }
    # 无 BOM + LF：与本仓库 .md 的编码约定一致（*.md text eol=lf）
    [IO.File]::AppendAllText($recFile, $prefix + $row + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "  记录已追加：docs\回退演练记录.md"
  } else {
    Write-Host "  ⚠ 未找到 $recFile，跳过记录追加" -ForegroundColor Yellow
  }
}
finally {
  if (-not $Keep -and (Test-Path $sandbox)) { Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue }
  elseif ($Keep) { Write-Host "`n（-Keep：沙箱保留在 $sandbox）" -ForegroundColor Yellow }
}

Write-Host ""
$sw.Stop()
if ($fail -ne 0) {
  Write-Host "✖ 流水线自检有 $fail 项未通过（通过 $pass 项）" -ForegroundColor Red
}
if ($timingBad) {
  Write-Host "✖ 回退耗时超上限" -ForegroundColor Red
  Write-Host ("  场景一 {0} s（上限 {1} s） / 场景二 {2} s（上限 {3} s）" -f $sec1, $LIMIT1_SEC, $sec2, $LIMIT2_SEC) -ForegroundColor Red
}
if ($fail -eq 0 -and -not $timingBad) {
  Write-Host "✔ 流水线自检全部通过（$pass 项，总耗时 $([Math]::Round($sw.Elapsed.TotalSeconds,2)) s）" -ForegroundColor Green
  Write-Host "  这意味着：升级和回滚都不会碰数据目录，且两个回退场景都还在耗时上限内。"
  exit 0
}
# 优先级：断言失败（数据被动过）比超时更严重，先报 exit 1；断言全过而超时才 exit 3。
if ($fail -ne 0) { exit 1 }
exit 3
