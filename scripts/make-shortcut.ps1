param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
try {
  # 优先用原生窗口版（MemoryApp.exe，自带 WebView2 窗口），
  # 其次无窗口启动器，最后才退回 cmd。
  $appWin = Join-Path $Root 'MemoryApp.exe'
  $exe = Join-Path $Root 'LocalMemory.exe'
  $cmd = Join-Path $Root 'start.cmd'
  if (Test-Path -LiteralPath $appWin) {
    $target = $appWin
  } elseif (Test-Path -LiteralPath $exe) {
    $target = $exe
  } elseif (Test-Path -LiteralPath $cmd) {
    $target = $cmd
  } else {
    Write-Host "[ERROR] no launcher found in: $Root"
    exit 1
  }

  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { Write-Host '[ERROR] cannot resolve Desktop folder'; exit 1 }

  $ws = New-Object -ComObject WScript.Shell

  $lnkPath = Join-Path $desktop '本地记忆.lnk'
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = $target
  $lnk.Arguments = ''
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,14"
  $lnk.Description = '本地记忆 — 关系图 / 直觉 / 设置'
  $lnk.Save()

  # 第二个快捷方式：停止后台服务。只有 GUI 启动器支持 --stop。
  if ($target -eq $exe) {
    $stopPath = Join-Path $desktop '本地记忆-退出.lnk'
    $stop = $ws.CreateShortcut($stopPath)
    $stop.TargetPath = $exe
    $stop.Arguments = '--stop'
    $stop.WorkingDirectory = $Root
    $stop.IconLocation = "$env:SystemRoot\System32\shell32.dll,131"
    $stop.Description = '停止正在后台运行的本记忆服务'
    $stop.Save()
  }

  # 回读校验：不看返回值，只认文件真的在
  if (Test-Path -LiteralPath $lnkPath) {
    Write-Host "[OK] $lnkPath"
    exit 0
  }
  Write-Host '[ERROR] shortcut file was not created'
  exit 1
} catch {
  Write-Host ("[ERROR] " + $_.Exception.Message)
  exit 1
}
