# ═══════════════════════════════════════════════════════════
# 拾光小册 · PowerShell 宿主环境自愈（2026-11-02 R21）
#
# 症状：从 PowerShell 7 起的进程（node、计划任务、pwsh 里跑 `node` / `powershell -File`）
#   会把 PS7 的 $env:PSModulePath 一路继承给 Windows PowerShell 5.1；5.1 按这个顺序找模块时
#   会先撞上 PS7 的二进制模块（Microsoft.PowerShell.Utility），加载失败后 **Get-FileHash 整个不存在**。
#   现象：`Get-Command Get-FileHash` 为空，后继报 CommandNotFoundException —— 看起来像"脚本坏了"，
#   其实是宿主串味。实测（2026-11-02）：node 由 PS7 起、spawn('powershell', …) 继承环境 ⇒ MISSING；
#   把 PSModulePath 摆回 5.1 自己的三档 ⇒ OK。受影响调用点：deploy.ps1:43、deploy-manifest.ps1:45、
#   build-release.ps1:249/455、selftest-pipeline.ps1:53、fetch-deps.ps1（R9 起用它校验哈希）。
#
# 做法：**只在真坏了的时候**（Get-FileHash 取不到）把 PSModulePath 换回 5.1 的三档；
#   能取到就一个字节都不动 —— 不做无条件覆盖，免得抹掉调用方自己配的模块路径。
#   由 _运行区.ps1 / build-release.ps1 / fetch-deps.ps1 / selftest-pipeline.ps1 在开头 dot-source。
# ═══════════════════════════════════════════════════════════
if ($PSVersionTable.PSEdition -eq 'Desktop' -and -not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  $ps51 = @(
    (Join-Path $env:SystemRoot 'system32\WindowsPowerShell\v1.0\Modules'),
    (Join-Path ${env:ProgramFiles} 'WindowsPowerShell\Modules'),
    (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell\Modules')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if ($ps51.Count -gt 0) {
    $env:PSModulePath = ($ps51 -join ';')
    Write-Host '  ⚠ 检测到 PowerShell 宿主串味（5.1 拿不到 Get-FileHash）：已把 PSModulePath 摆回 5.1 的三档' -ForegroundColor Yellow
  }
}