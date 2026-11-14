<#
.SYNOPSIS
  Creates two shortcuts for the widget (or with -Remove, deletes them):
    - Startup folder: starts the widget at logon.
    - Desktop: starts the widget, or restarts it if it is already running.
  Both start it with no console window, so nothing appears on the taskbar except the strip.
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'ClaudeUsage.Core.psm1') -Force

$name = 'Claude Usage Widget.lnk'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) $name
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) $name
$iconPath = Join-Path $here 'widget.ico'

if ($Remove) {
    foreach ($lnk in $startupLnk, $desktopLnk) {
        if (Test-Path $lnk) { Remove-Item $lnk; Write-Host "Removed $lnk" }
    }
    return
}

function New-MascotIcon([string]$Path) {
    # Draws the mascot at several sizes and writes them as one .ico file.
    Add-Type -AssemblyName System.Drawing
    $rows = Get-MascotShape
    $cols = $rows[0].Length
    $body = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xd9, 0x77, 0x57))
    $eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x1b, 0x1b, 0x1b))
    $sizes = 16, 24, 32, 48, 256
    $pngs = New-Object System.Collections.ArrayList
    foreach ($size in $sizes) {
        $cell = [int][math]::Max(1, [math]::Floor($size / $cols))
        $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.Clear([System.Drawing.Color]::Transparent)
        $ox = [int](($size - $cols * $cell) / 2); $oy = [int](($size - $rows.Count * $cell) / 2)
        for ($y = 0; $y -lt $rows.Count; $y++) {
            for ($x = 0; $x -lt $cols; $x++) {
                $ch = $rows[$y][$x]
                if ($ch -eq '.') { continue }
                $brush = if ($ch -eq 'o') { $eye } else { $body }
                $g.FillRectangle($brush, $ox + $x * $cell, $oy + $y * $cell, $cell, $cell)
            }
        }
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        if ($size -ge 256) {
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)          # large size: PNG
        } else {
            # small sizes: classic 32-bit bitmap entry (header, bottom-up BGRA rows, empty mask)
            $bw = New-Object System.IO.BinaryWriter $ms
            $bw.Write([uint32]40); $bw.Write([int32]$size); $bw.Write([int32]($size * 2))
            $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0); $bw.Write([uint32]($size * $size * 4))
            $bw.Write([uint32]0); $bw.Write([uint32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
            for ($y = $size - 1; $y -ge 0; $y--) {
                for ($x = 0; $x -lt $size; $x++) {
                    $c = $bmp.GetPixel($x, $y)
                    $bw.Write([byte]$c.B); $bw.Write([byte]$c.G); $bw.Write([byte]$c.R); $bw.Write([byte]$c.A)
                }
            }
            $maskRow = [int]([math]::Floor(($size + 31) / 32) * 4)
            $bw.Write((New-Object byte[] ($maskRow * $size)))
            $bw.Flush()
        }
        $bmp.Dispose()
        [void]$pngs.Add($ms.ToArray())
        $ms.Dispose()
    }
    $body.Dispose(); $eye.Dispose()

    $out = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $out
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)     # ICO header
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }                  # 0 means 256
        $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
        $w.Write([uint16]1); $w.Write([uint16]32)
        $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
        $offset += $pngs[$i].Length
    }
    foreach ($png in $pngs) { $w.Write([byte[]]$png) }
    $w.Flush()
    [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
    $w.Dispose(); $out.Dispose()
}

function New-WidgetShortcut([string]$LinkPath, $Launcher, [string]$Description) {
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($LinkPath)
    $s.TargetPath = $Launcher.Target
    $s.Arguments = $Launcher.Arguments
    $s.WorkingDirectory = $here
    $s.IconLocation = "$iconPath,0"
    $s.Description = $Description
    $s.Save()
    Write-Host "Created $LinkPath"
}

New-MascotIcon $iconPath
$script = Join-Path $here 'ClaudeUsageWidget.ps1'
New-WidgetShortcut $startupLnk (Get-WidgetLauncher -ScriptPath $script) 'Claude 5h / 7d usage on the taskbar'
New-WidgetShortcut $desktopLnk (Get-WidgetLauncher -ScriptPath $script -Restart) 'Start or restart the Claude usage strip on the taskbar'
Write-Host 'Double-click "Claude Usage Widget" on the desktop to start or restart it.'
