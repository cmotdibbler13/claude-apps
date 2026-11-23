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

function Find-Python([switch]$AllowStore) {
    # Returns the path of a python.exe between 3.10 and 3.14, or nothing. Python from the
    # Microsoft Store is passed over unless -AllowStore: Windows shows the Python logo on the
    # taskbar for anything it runs, whatever icon the app asks for.
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
            $minor = [int]$Matches[1]
            $path = $Matches[2].Trim()
            $store = $path -like '*WindowsApps*'
            if ($minor -ge 10 -and $minor -le 14 -and ($AllowStore -or -not $store)) { return $path }
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
        if (Find-Python -AllowStore) {
            Write-Host 'Only the Microsoft Store version of Python was found. It forces the Python logo onto the taskbar,'
            Write-Host 'so the standard Python 3.12 is being installed alongside it (Windows may ask for permission)...'
        } else {
            Write-Host 'Python is not installed. Installing Python 3.12 (Windows may ask for permission)...'
        }
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
        $python = Find-Python
    }
    if (-not $python) {
        $python = Find-Python -AllowStore
        if ($python) {
            Write-Host 'Carrying on with the Microsoft Store Python. The app will work, but its taskbar icon will be the Python logo.' -ForegroundColor Yellow
        }
    }
    if (-not $python) {
        Stop-Install ('Python is needed and could not be installed automatically. Install Python 3.12 from ' +
            'https://www.python.org/downloads/ and then run Install.cmd again.')
    }
}
Write-Host "Using $python"

# --- 2. A private copy of Python for the app --------------------------------
Write-Step '2 of 4  Making the app''s own Python folder (.venv)'
$venvConfig = Join-Path $venv 'pyvenv.cfg'
if ((Test-Path $venvConfig) -and ($python -notlike '*WindowsApps*') -and
    ((Get-Content $venvConfig -Raw) -like '*WindowsApps*')) {
    Write-Host 'The existing .venv was made with the Microsoft Store Python (the cause of the Python logo on the taskbar).'
    Write-Host 'Rebuilding it with the standard Python. Most of the parts come from the download cache, so this is quicker than the first install.'
    Remove-Item $venv -Recurse -Force
}
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
# The app's window tells Windows it is "JonH.StemRemixer" (see main.py). Stamping the same
# ID into the shortcuts makes the taskbar treat a pin and the open window as one app with
# the app's own icon, instead of showing Python's.
$appId = 'JonH.StemRemixer'
$stampSource = @'
using System;
using System.Runtime.InteropServices;
namespace StemRemixer
{
    public static class Shortcut
    {
        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        struct PropertyKey
        {
            public Guid FormatId; public uint PropertyId;
            public PropertyKey(uint pid) { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); PropertyId = pid; }
        }

        [StructLayout(LayoutKind.Explicit)]
        struct PropVariant
        {
            [FieldOffset(0)] public ushort Type;
            [FieldOffset(8)] public IntPtr Value;
            [FieldOffset(12)] int pad;
        }

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
            [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
            [PreserveSig] int Commit();
        }

        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);

        public static void SetAppId(string linkPath, string appId)
        {
            var link = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
            try
            {
                var file = (System.Runtime.InteropServices.ComTypes.IPersistFile)link;
                file.Load(linkPath, 2);
                var store = (IPropertyStore)link;
                var key = new PropertyKey(5);       // System.AppUserModel.ID
                var value = new PropVariant();
                value.Type = 31;                    // VT_LPWSTR
                value.Value = Marshal.StringToCoTaskMemUni(appId);
                try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); }
                finally { PropVariantClear(ref value); }
                Marshal.ThrowExceptionForHR(store.Commit());
                file.Save(linkPath, true);
            }
            finally { Marshal.ReleaseComObject(link); }
        }
    }
}
'@
$canStamp = $true
try { Add-Type -TypeDefinition $stampSource -ErrorAction Stop } catch { $canStamp = $false }
$shell = New-Object -ComObject WScript.Shell
foreach ($link in $links) {
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = $venvPythonW
    $shortcut.Arguments = '"' + (Join-Path $here 'main.py') + '"'
    $shortcut.WorkingDirectory = $here
    if (Test-Path $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
    $shortcut.Description = 'Split a song into its instruments and remix it'
    $shortcut.Save()
    if ($canStamp) {
        try { [StemRemixer.Shortcut]::SetAppId($link, $appId) } catch { $canStamp = $false }
    }
    Write-Host "Created $link"
}
if (-not $canStamp) {
    Write-Host 'The shortcuts work, but could not be tied to the app''s taskbar button, so a pinned icon may show Python''s logo.' -ForegroundColor Yellow
}
# ask Windows to reload its icon cache, so shortcuts and pins show the app's icon
$refresh = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
if (Test-Path $refresh) { & $refresh -show }

Write-Host ''
Write-Host 'Done. Double-click "Stem Remixer" on the Desktop to start it.' -ForegroundColor Green
Write-Host 'To pin it: right-click "Stem Remixer" in the Start menu (or its taskbar button while it is open) and choose Pin to taskbar.'
Write-Host 'Keep this folder where it is: the shortcuts point at it.'
exit 0
