<#
.SYNOPSIS
  Adds a "YouTube Downloader" shortcut to the Desktop and the Start menu (or with -Remove,
  deletes them), and draws downloader.ico for them. The shortcut starts the app with no
  console window.
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'YouTubeDownloader.Core.psm1') -Force

$name = 'YouTube Downloader.lnk'
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) $name
$startLnk = Join-Path ([Environment]::GetFolderPath('Programs')) $name
$iconPath = Join-Path $here 'downloader.ico'

if ($Remove) {
    foreach ($lnk in $desktopLnk, $startLnk) {
        if (Test-Path $lnk) { Remove-Item $lnk; Write-Host "Removed $lnk" }
    }
    return
}

function New-DownloaderIcon([string]$Path) {
    # Six Minutes On... colours: a square surface-100 tile with a rule hairline, a down arrow in
    # ink drawn with rounded strokes like the logo, and the tray beneath it in brass.
    Add-Type -AssemblyName System.Drawing
    $sizes = 16, 24, 32, 48, 256
    $images = New-Object System.Collections.ArrayList
    $navy = [System.Drawing.ColorTranslator]::FromHtml('#091a2e')
    $hair = [System.Drawing.ColorTranslator]::FromHtml('#24395a')
    $ink = [System.Drawing.ColorTranslator]::FromHtml('#eaebed')
    $brass = [System.Drawing.ColorTranslator]::FromHtml('#d5a867')
    foreach ($size in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = 'AntiAlias'
        $s = [single]$size
        $g.Clear($navy)
        if ($size -ge 32) {
            $edge = New-Object System.Drawing.Pen($hair, [single][math]::Max(1, $s / 64))
            $g.DrawRectangle($edge, 0, 0, $s - 1, $s - 1); $edge.Dispose()
        }
        $w = [single][math]::Max(1.6, $s * 0.085)                                 # stroke weight
        $pen = New-Object System.Drawing.Pen($ink, $w)
        $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
        $g.DrawLine($pen, $s * 0.5, $s * 0.18, $s * 0.5, $s * 0.62)              # shaft
        $g.DrawLines($pen, [System.Drawing.PointF[]]@(                            # head
            (New-Object System.Drawing.PointF ($s * 0.29), ($s * 0.43)),
            (New-Object System.Drawing.PointF ($s * 0.5), ($s * 0.64)),
            (New-Object System.Drawing.PointF ($s * 0.71), ($s * 0.43))))
        $tray = New-Object System.Drawing.Pen($brass, $w)
        $tray.StartCap = 'Round'; $tray.EndCap = 'Round'
        $g.DrawLine($tray, $s * 0.24, $s * 0.81, $s * 0.76, $s * 0.81)            # tray
        $g.Dispose(); $pen.Dispose(); $tray.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)          # PNG entries (Windows Vista and later)
        $bmp.Dispose()
        [void]$images.Add($ms.ToArray())
        $ms.Dispose()
    }
    $out = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $out
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)     # ICO header
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }                  # 0 means 256
        $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
        $w.Write([uint16]1); $w.Write([uint16]32)
        $w.Write([uint32]$images[$i].Length); $w.Write([uint32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($img in $images) { $w.Write([byte[]]$img) }
    $w.Flush()
    [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
    $w.Dispose(); $out.Dispose()
}

function New-AppShortcut([string]$LinkPath) {
    $launch = Get-YtdLauncher $here
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($LinkPath)
    $s.TargetPath = $launch.Target
    $s.Arguments = $launch.Arguments
    $s.WorkingDirectory = $here
    $s.IconLocation = "$iconPath,0"
    $s.Description = 'Download YouTube videos to watch offline'
    $s.Save()
    # the same app ID as the window, so a pinned shortcut and the open window share one taskbar button
    [SixMinutesOn.Native]::SetShortcutAppId($LinkPath, (Get-YtdAppId))
    Write-Host "Created $LinkPath"
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $here 'Theme.cs')) -ReferencedAssemblies System.Windows.Forms, System.Drawing
New-DownloaderIcon $iconPath
New-AppShortcut $desktopLnk
New-AppShortcut $startLnk
# ask Windows to reload its icon cache, so shortcuts and pins show the new icon
$refresh = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
if (Test-Path $refresh) { & $refresh -show }
Write-Host 'Double-click "YouTube Downloader" on the Desktop to start it.'
Write-Host 'To pin it: right-click the Start menu entry (or the open window''s taskbar button) and choose Pin to taskbar.'
