<#
.SYNOPSIS
  Installs Stem Remixer: finds (or installs) Python, puts everything the app needs in a
  .venv folder next to this file, and adds "Stem Remixer" to the Desktop and Start menu.
  Run it by double-clicking Install.cmd (Uninstall.cmd runs it with -Remove).

  -Remove  takes the shortcuts and the .venv folder away again (your Stems are kept).
  -Cpu     skips the NVIDIA graphics card build of PyTorch (a much smaller download).
#>
param([switch]$Remove, [switch]$Cpu)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here '.venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
$venvPythonW = Join-Path $venv 'Scripts\pythonw.exe'
$iconPath = Join-Path $here 'assets\icon.ico'
$name = 'Stem Remixer.lnk'
$links = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) $name),
    (Join-Path ([Environment]::GetFolderPath('Programs')) $name))

function Stop-Install([string]$Message) {
    Write-Host ''
    Write-Host $Message -ForegroundColor Red
    exit 1
}

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host $Message -ForegroundColor Cyan
}

if ($Remove) {
    foreach ($link in $links) {
        if (Test-Path $link) { Remove-Item $link; Write-Host "Removed $link" }
    }
    if (Test-Path $venv) { Remove-Item $venv -Recurse -Force; Write-Host "Removed $venv" }
    Write-Host 'Stem Remixer is uninstalled. Your Stems folder was left alone; delete this folder to remove it.'
    exit 0
}

function Find-Python {
    # Returns the path of a python.exe between 3.10 and 3.14, or nothing.
    $probe = "import sys; print('%d.%d|%s' % (sys.version_info[0], sys.version_info[1], sys.executable))"
    $tries = New-Object System.Collections.ArrayList
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($version in '3.12', '3.13', '3.11', '3.10', '3.14') { [void]$tries.Add(@('py', "-$version")) }
    }
    foreach ($dir in 'Python312', 'Python313', 'Python311', 'Python310', 'Python314') {
        $exe = Join-Path $env:LOCALAPPDATA "Programs\Python\$dir\python.exe"
        if (Test-Path $exe) { [void]$tries.Add(@($exe)) }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) { [void]$tries.Add(@('python')) }
    foreach ($try in $tries) {
        $exe = $try[0]
        $found = $null
        if ($try.Count -gt 1) { $found = & $exe $try[1] -c $probe 2>$null }
        else { $found = & $exe -c $probe 2>$null }
        if ($LASTEXITCODE -eq 0 -and "$found" -match '^3\.(\d+)\|(.+)$') {
            if ([int]$Matches[1] -ge 10 -and [int]$Matches[1] -le 14) { return $Matches[2].Trim() }
        }
    }
    return $null
}

Write-Host 'Installing Stem Remixer' -ForegroundColor Yellow
Write-Host 'This downloads about 1 GB (more with an NVIDIA graphics card) and can take 5 to 15 minutes.'

# --- 1. Python ---------------------------------------------------------------
Write-Step '1 of 4  Looking for Python'
$python = Find-Python
if (-not $python) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host 'Python is not installed. Installing Python 3.12 (Windows may ask for permission)...'
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
        $python = Find-Python
    }
    if (-not $python) {
        Stop-Install ('Python is needed and could not be installed automatically. Install Python 3.12 from ' +
            'https://www.python.org/downloads/ and then run Install.cmd again.')
    }
}
Write-Host "Using $python"

# --- 2. A private copy of Python for the app --------------------------------
Write-Step '2 of 4  Making the app''s own Python folder (.venv)'
if (-not (Test-Path $venvPython)) {
    & $python -m venv $venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPython)) {
        Stop-Install 'Could not create the .venv folder. Check this folder is not read-only and try again.'
    }
}
& $venvPython -m pip install --upgrade pip --quiet

# --- 3. The splitter and the rest -------------------------------------------
Write-Step '3 of 4  Downloading the splitter (the long part)'
$nvidia = $false
if (-not $Cpu) {
    try { $nvidia = [bool](Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' }) } catch { $nvidia = $false }
}
if ($nvidia) {
    Write-Host 'NVIDIA graphics card found: fetching the version of PyTorch that uses it (about 2.5 GB).'
    & $venvPython -m pip install torch --index-url https://download.pytorch.org/whl/cu126
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'That did not work, so the normal version will be used instead. Splits will be slower.' -ForegroundColor Yellow
    }
}
& $venvPython -m pip install -r (Join-Path $here 'requirements.txt')
if ($LASTEXITCODE -ne 0) {
    Stop-Install 'The download failed. Check your internet connection and run Install.cmd again; it carries on where it stopped.'
}
$check = & $venvPython -c "import customtkinter, sounddevice, soundfile, lameenc, demucs.api, torch; print('card' if torch.cuda.is_available() else 'processor')"
if ($LASTEXITCODE -ne 0) {
    Stop-Install 'Everything downloaded, but the app''s parts would not load. Copy the messages above into a bug report.'
}
Write-Host "Splits will run on the $check."

# --- 4. Shortcuts -----------------------------------------------------------
Write-Step '4 of 4  Adding shortcuts'
$shell = New-Object -ComObject WScript.Shell
foreach ($link in $links) {
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = $venvPythonW
    $shortcut.Arguments = '"' + (Join-Path $here 'main.py') + '"'
    $shortcut.WorkingDirectory = $here
    if (Test-Path $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
    $shortcut.Description = 'Split a song into its instruments and remix it'
    $shortcut.Save()
    Write-Host "Created $link"
}

Write-Host ''
Write-Host 'Done. Double-click "Stem Remixer" on the Desktop to start it.' -ForegroundColor Green
Write-Host 'Keep this folder where it is: the shortcuts point at it.'
exit 0
