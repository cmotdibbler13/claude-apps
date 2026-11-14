# Builds T2 Fan Control with the C# compiler that ships with Windows.
#   .\build.ps1            build build\T2FanControl.exe
#   .\build.ps1 -Probe     also build the read-only diagnostic build\Probe.exe
#   .\build.ps1 -Install   build, copy to %LOCALAPPDATA%\Programs\T2FanControl,
#                          register to start with Windows, and launch
param([switch]$Install, [switch]$Probe)
$ErrorActionPreference = 'Stop'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc (.NET Framework 4.x x64 is required)." }

$root = $PSScriptRoot
$out = Join-Path $root 'build'
New-Item -ItemType Directory -Force $out | Out-Null

& $csc /nologo /optimize+ /platform:x64 /target:winexe "/out:$out\T2FanControl.exe" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    "$root\src\Smc.cs" "$root\src\Engine.cs" "$root\src\Ui.cs"
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Built $out\T2FanControl.exe"

if ($Probe) {
    & $csc /nologo /platform:x64 "/out:$out\Probe.exe" "$root\src\Smc.cs" "$root\tools\Probe.cs"
    if ($LASTEXITCODE -ne 0) { throw 'Probe build failed.' }
    Write-Host "Built $out\Probe.exe"
}

if ($Install) {
    $dst = Join-Path $env:LOCALAPPDATA 'Programs\T2FanControl'
    $exe = Join-Path $dst 'T2FanControl.exe'
    if ((Get-Process T2FanControl -ErrorAction SilentlyContinue) -and (Test-Path $exe)) {
        # ask the running copy to quit cleanly so the fans go back to automatic
        Start-Process $exe -ArgumentList '--exit' -Wait
        Start-Sleep -Seconds 4
    }
    New-Item -ItemType Directory -Force $dst | Out-Null
    Copy-Item "$out\T2FanControl.exe" $exe -Force
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'T2FanControl' -Value "`"$exe`" --tray"
    Start-Process $exe
    Write-Host "Installed to $dst, registered to start with Windows, and launched."
}
