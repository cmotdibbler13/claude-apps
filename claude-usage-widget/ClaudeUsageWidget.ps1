<#
.SYNOPSIS
  Shows Claude 5-hour and 7-day usage as a small strip on the Windows taskbar, left of the clock/tray.
.NOTES
  Left-click: check now.  Right-click: menu (refresh, open claude.ai usage, quit).
  The numbers live in a small local file with two feeds, both Claude Code's own documented features:
    1. Every -CheckMinutes the widget runs `claude -p "/usage"` in the background. Claude Code
       looks up the account-wide figures (desktop app and claude.ai included) and prints them.
       This uses no model tokens.
    2. Claude Code's status line (Save-ClaudeUsage.ps1) updates the file after each response
       in a terminal session.
  The widget itself makes no network calls and uses no login.
  Launch with no console window:  conhost --headless powershell -NoProfile -ExecutionPolicy Bypass -File ClaudeUsageWidget.ps1
  (Install-Shortcuts.ps1 creates Startup and Desktop shortcuts that do this.)
#>
param(
    [int]$CheckMinutes = 5,      # how often to ask Claude Code for /usage; 0 = only on click
    [int]$RefreshSeconds = 5,    # how often to re-read the local file
    [int]$Width = 184,
    [int]$Height = 40,
    [int]$Gap = 6,
    [switch]$Restart             # close a copy that is already running, then start (the desktop shortcut uses this)
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$modulePath = Join-Path $here 'ClaudeUsage.Core.psm1'
Import-Module $modulePath -Force

# Single instance. With -Restart, close any running copy first and wait for it to let go.
if ($Restart) {
    foreach ($id in @(Get-WidgetProcessId)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
$mutex = New-Object System.Threading.Mutex($false, 'Local\ClaudeUsageWidget')
$waitMs = if ($Restart) { 5000 } else { 0 }
$owned = $false
try { $owned = $mutex.WaitOne($waitMs, $false) }
catch [System.Threading.AbandonedMutexException] { $owned = $true }   # the old copy was closed while holding it
if (-not $owned) { exit 0 }

# --- Win32 helpers ---------------------------------------------------------
$native = @"
[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string wnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
public struct RECT { public int Left, Top, Right, Bottom; }
"@
Add-Type -Namespace Win32 -Name Native -MemberDefinition $native

function Get-TaskbarRects {
    $tb = [Win32.Native]::FindWindow('Shell_TrayWnd', $null)
    if ($tb -eq [IntPtr]::Zero) { return $null }
    $r = New-Object Win32.Native+RECT
    [void][Win32.Native]::GetWindowRect($tb, [ref]$r)
    $taskbar = New-Object System.Drawing.Rectangle $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    $tray = [Win32.Native]::FindWindowEx($tb, [IntPtr]::Zero, 'TrayNotifyWnd', $null)
    if ($tray -eq [IntPtr]::Zero) { return $null }
    [void][Win32.Native]::GetWindowRect($tray, [ref]$r)
    $trayRect = New-Object System.Drawing.Rectangle $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    [pscustomobject]@{ Taskbar = $taskbar; Tray = $trayRect }
}

function Get-ScreenColorAt([int]$x, [int]$y) {
    $bmp = New-Object System.Drawing.Bitmap 1, 1
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size 1, 1))
    $g.Dispose()
    $c = $bmp.GetPixel(0, 0); $bmp.Dispose()
    [System.Drawing.Color]::FromArgb(255, $c.R, $c.G, $c.B)
}

# --- State -----------------------------------------------------------------
$state = [pscustomobject]@{
    Model = $null      # display model from Read-UsageSnapshot, or $null when there is no data yet
    Error = $null      # last read error or $null
    CheckError = $null # last /usage check error or $null
    Checking = $false  # a background /usage check is running
    Async = $null      # IAsyncResult of the running check
    PS    = $null      # PowerShell instance running the check
    Bg    =[System.Drawing.Color]::FromArgb(32, 32, 32)
    Fg    = [System.Drawing.Color]::White
}

# --- Form ------------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.Size = New-Object System.Drawing.Size $Width, $Height
$form.Text = 'Claude usage'
$form.Cursor = [System.Windows.Forms.Cursors]::Hand
# double-buffer to avoid flicker
$form.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic').SetValue($form, $true, $null)

$tip = New-Object System.Windows.Forms.ToolTip
$tip.InitialDelay = 300; $tip.AutoPopDelay = 15000; $tip.ReshowDelay = 200

$fontLabel = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Regular)
$fontValue = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)

# Little orange Claude critter drawn at the left of the strip (pixel grid from the core module)
$mascot = Get-MascotShape
$mascotPx = 2
$mascotBody = [System.Drawing.Color]::FromArgb(0xd9, 0x77, 0x57)
$mascotEye = [System.Drawing.Color]::FromArgb(0x1b, 0x1b, 0x1b)

function Set-Placement {
    $rects = Get-TaskbarRects
    if ($null -eq $rects) { return }
    $b = Get-WidgetBounds -Taskbar $rects.Taskbar -Tray $rects.Tray -Width $Width -Height $Height -Gap $Gap
    if ($form.Bounds -ne $b) { $form.Bounds = $b }
    # keep above the taskbar without stealing focus (HWND_TOPMOST = -1; SWP_NOSIZE|NOMOVE|NOACTIVATE = 0x13)
    [void][Win32.Native]::SetWindowPos($form.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x13)
}

function Set-Theme {
    # Sample the taskbar just to the left of where the strip sits so it blends in.
    $x = [math]::Max(0, $form.Left - 3); $y = $form.Top + [int]($form.Height / 2)
    try { $state.Bg = Get-ScreenColorAt $x $y } catch {}
    $state.Fg = Get-TextColorFor $state.Bg
    $form.BackColor = $state.Bg
}

function Update-Tooltip {
    $lines = @()
    if ($state.Model) {
        $m = $state.Model
        $p5 = if ($null -ne $m.FiveHour.Percent) { $m.FiveHour.Percent } else { '--' }
        $p7 = if ($null -ne $m.SevenDay.Percent) { $m.SevenDay.Percent } else { '--' }
        $lines += ('5-hour window:  {0}%  {1}' -f $p5, (Format-ResetIn $m.FiveHour.ResetsAt))
        $lines += ('7-day window:   {0}%  {1}' -f $p7, (Format-ResetIn $m.SevenDay.ResetsAt))
        if ($m.UpdatedAt) { $lines += ('Last reported by Claude Code {0} ({1:HH:mm})' -f (Format-Age $m.UpdatedAt), $m.UpdatedAt.ToLocalTime()) }
    } else {
        $lines += 'No usage data yet.'
    }
    if ($state.Checking) { $lines += 'Checking now...' }
    if ($state.CheckError) { $lines += "Check failed: $($state.CheckError)" }
    if ($state.Error) { $lines += "Error: $($state.Error)" }
    $lines += 'Click to check now - right-click for menu'
    $tip.SetToolTip($form, ($lines -join "`r`n"))
}

function Update-Usage {
    # Reads the local snapshot file. Cheap, so it runs on the UI thread.
    try { $state.Model = Read-UsageSnapshot; $state.Error = $null }
    catch { $state.Error = $_.Exception.Message }
    Update-Tooltip
    $form.Invalidate()
}

# --- Background /usage check (off the UI thread; takes about 2 s) -----------
function Start-Check {
    if ($state.Checking) { return }
    $state.Checking = $true
    $ps = [powershell]::Create()
    [void]$ps.AddScript({
        param($modulePath)
        Import-Module $modulePath -Force
        try { [void](Update-UsageFromCli); [pscustomobject]@{ Ok = $true; Error = $null } }
        catch { [pscustomobject]@{ Ok = $false; Error = $_.Exception.Message } }
    }).AddArgument($modulePath)
    $state.PS = $ps
    $state.Async = $ps.BeginInvoke()
    Update-Tooltip
    $form.Invalidate()
}

function Complete-CheckIfDone {
    if (-not $state.Checking -or -not $state.Async.IsCompleted) { return }
    try {
        $r = $state.PS.EndInvoke($state.Async) | Select-Object -Last 1
        $state.CheckError = if ($r.Ok) { $null } else { $r.Error }
    } catch { $state.CheckError = $_.Exception.Message }
    finally {
        $state.PS.Dispose(); $state.PS = $null; $state.Async = $null
        $state.Checking = $false
    }
    Update-Usage
}

$form.Add_Paint({
    param($s, $e)
    $g = $e.Graphics
    $g.TextRenderingHint = 'ClearTypeGridFit'
    $g.Clear($state.Bg)
    $fg = New-Object System.Drawing.SolidBrush $state.Fg
    $dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110, $state.Fg))
    $track = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(45, $state.Fg))

    # mascot, vertically centred at the left edge
    $mw = $mascot[0].Length * $mascotPx; $mh = $mascot.Count * $mascotPx
    $mx = 7; $my = [int](($form.Height - $mh) / 2)
    $body = New-Object System.Drawing.SolidBrush $mascotBody
    $eye = New-Object System.Drawing.SolidBrush $mascotEye
    $g.SmoothingMode = 'None'
    for ($ry = 0; $ry -lt $mascot.Count; $ry++) {
        $row = $mascot[$ry]
        for ($rx = 0; $rx -lt $row.Length; $rx++) {
            $ch = $row[$rx]
            if ($ch -eq '.') { continue }
            $b = if ($ch -eq 'o') { $eye } else { $body }
            $g.FillRectangle($b, $mx + $rx * $mascotPx, $my + $ry * $mascotPx, $mascotPx, $mascotPx)
        }
    }
    $g.SmoothingMode = 'AntiAlias'
    $body.Dispose(); $eye.Dispose()

    $pad = 8
    $left = $mx + $mw + 8
    $colW = [int](($form.Width - $left - $pad - 6) / 2)
    $labels = @('5h', '7d')
    for ($i = 0; $i -lt 2; $i++) {
        $x = $left + $i * ($colW + 6)
        $win = $null
        if ($state.Model) { $win = if ($i -eq 0) { $state.Model.FiveHour } else { $state.Model.SevenDay } }
        $pct = if ($win) { $win.Percent } else { $null }
        $txt = if ($null -ne $pct) { "$pct%" } else { '--' }
        # label (dim) then value (bold)
        $g.DrawString($labels[$i], $fontLabel, $dim, [single]($x - 2), [single]3)
        $lw = $g.MeasureString($labels[$i], $fontLabel).Width
        $g.DrawString($txt, $fontValue, $fg, [single]($x + $lw - 4), [single]1)
        # bar
        $barY = $form.Height - 11; $barH = 4
        $g.FillRectangle($track, $x, $barY, $colW, $barH)
        if ($null -ne $pct -and $pct -gt 0) {
            $fillW = [int][math]::Max(2, $colW * $pct / 100)
            $fill = New-Object System.Drawing.SolidBrush (Get-UsageColor $pct)
            $g.FillRectangle($fill, $x, $barY, $fillW, $barH)
            $fill.Dispose()
        }
    }
    if ($state.Checking) { $g.FillEllipse($dim, $form.Width - 7, 3, 4, 4) }
    $fg.Dispose(); $dim.Dispose(); $track.Dispose()
})

# --- Timer -----------------------------------------------------------------
$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 1000
$script:tick = 0
$poll.Add_Tick({
    $script:tick++
    Complete-CheckIfDone
    if ($script:tick % 2 -eq 0) { Set-Placement }                    # every 2 s: follow taskbar/tray changes
    if ($script:tick % $RefreshSeconds -eq 0) { Update-Usage }       # every RefreshSeconds: re-read the file
    if ($CheckMinutes -gt 0 -and $script:tick % ($CheckMinutes * 60) -eq 0) { Start-Check }   # ask Claude Code for /usage
})

# --- Interaction -----------------------------------------------------------
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Check now', $null, { Start-Check })
[void]$menu.Items.Add('Open claude.ai usage', $null, { Start-Process 'https://claude.ai/settings/usage' })
[void]$menu.Items.Add('-')
[void]$menu.Items.Add('Quit', $null, { $form.Close() })
$form.ContextMenuStrip = $menu
$form.Add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Start-Check } })

$form.Add_Shown({
    # WS_EX_TOOLWINDOW (0x80) hides it from Alt+Tab; WS_EX_NOACTIVATE (0x08000000) stops focus stealing
    $ex = [Win32.Native]::GetWindowLong($form.Handle, -20)
    [void][Win32.Native]::SetWindowLong($form.Handle, -20, ($ex -bor 0x80 -bor 0x08000000))
    Set-Placement
    Set-Theme
    Update-Usage
    Start-Check
    $poll.Start()
})
$form.Add_FormClosed({ $poll.Stop(); if ($state.PS) { $state.PS.Dispose() }; $mutex.ReleaseMutex() })

# Re-sample the taskbar colour when the system theme changes
[Microsoft.Win32.SystemEvents]::add_UserPreferenceChanged({ Set-Theme; $form.Invalidate() })

[System.Windows.Forms.Application]::Run($form)
