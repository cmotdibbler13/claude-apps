<#
.SYNOPSIS
  Adds a "YouTube Downloader" shortcut to the Desktop and the Start menu (or with -Remove,
  deletes them), and draws downloader.ico for them. The shortcut starts the app with no
  console window.
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

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
    # A red rounded square with a white down arrow, at several sizes, written as one .ico file.
    Add-Type -AssemblyName System.Drawing
    $sizes = 16, 24, 32, 48, 256
    $images = New-Object System.Collections.ArrayList
    foreach ($size in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = 'AntiAlias'
        $g.Clear([System.Drawing.Color]::Transparent)
        $s = [single]$size; $r = [single]($s * 0.22)
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
        $path.AddArc($s - $r * 2 - 1, 0, $r * 2, $r * 2, 270, 90)
        $path.AddArc($s - $r * 2 - 1, $s - $r * 2 - 1, $r * 2, $r * 2, 0, 90)
        $path.AddArc(0, $s - $r * 2 - 1, $r * 2, $r * 2, 90, 90)
        $path.CloseFigure()
        $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xE5, 0x2D, 0x27))
        $g.FillPath($red, $path)
        $white = [System.Drawing.Brushes]::White
        # arrow: a shaft and a head, then a tray line underneath
        $g.FillRectangle($white, $s * 0.42, $s * 0.16, $s * 0.16, $s * 0.36)
        $head = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF ($s * 0.24), ($s * 0.46)),
            (New-Object System.Drawing.PointF ($s * 0.76), ($s * 0.46)),
            (New-Object System.Drawing.PointF ($s * 0.50), ($s * 0.72)))
        $g.FillPolygon($white, $head)
        $g.FillRectangle($white, $s * 0.22, $s * 0.78, $s * 0.56, [math]::Max(1, $s * 0.08))
        $g.Dispose(); $red.Dispose(); $path.Dispose()
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
    # conhost --headless gives PowerShell a console that never shows a window.
    $script = Join-Path $here 'YouTubeDownloader.ps1'
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($LinkPath)
    $s.TargetPath = Join-Path $env:SystemRoot 'System32\conhost.exe'
    $s.Arguments = "--headless powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File `"$script`""
    $s.WorkingDirectory = $here
    $s.IconLocation = "$iconPath,0"
    $s.Description = 'Download YouTube videos to watch offline'
    $s.Save()
    Write-Host "Created $LinkPath"
}

New-DownloaderIcon $iconPath
New-AppShortcut $desktopLnk
New-AppShortcut $startLnk
Write-Host 'Double-click "YouTube Downloader" on the Desktop to start it.'
