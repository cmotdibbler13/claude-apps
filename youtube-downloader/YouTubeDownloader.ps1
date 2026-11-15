<#
.SYNOPSIS
  YouTube Downloader: paste a link, pick a quality, press Download. Saves an MP4 (or MP3) you
  can watch offline. Uses yt-dlp, FFmpeg and Deno, which it fetches itself on first use.
  Start it with the Desktop shortcut (Install-Shortcuts.ps1), or:
    powershell -NoProfile -ExecutionPolicy Bypass -File YouTubeDownloader.ps1
#>
param([string]$Url)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'YouTubeDownloader.Core.psm1') -Force

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$bin = Get-YtdBinFolder
$settings = Read-YtdSettings
$psExe = (Get-Process -Id $PID).Path

# ---------- window ----------
$font = New-Object Drawing.Font('Segoe UI', 10)
$form = New-Object Windows.Forms.Form
$form.Text = 'YouTube Downloader'
$form.Font = $font
$form.ClientSize = New-Object Drawing.Size(640, 470)
$form.MinimumSize = New-Object Drawing.Size(560, 460)
$form.StartPosition = 'CenterScreen'
$iconPath = Join-Path $here 'downloader.ico'
if (Test-Path $iconPath) { $form.Icon = New-Object Drawing.Icon($iconPath) }

function Add-Control($ctl, [int]$x, [int]$y, [int]$w, [int]$h, [string]$anchor = 'Top,Left') {
    $ctl.Location = New-Object Drawing.Point($x, $y)
    $ctl.Size = New-Object Drawing.Size($w, $h)
    $ctl.Anchor = $anchor
    $form.Controls.Add($ctl)
    $ctl
}
function New-Label([string]$text) { $l = New-Object Windows.Forms.Label; $l.Text = $text; $l.TextAlign = 'MiddleLeft'; $l }
function New-Button([string]$text) { $b = New-Object Windows.Forms.Button; $b.Text = $text; $b }

[void](Add-Control (New-Label 'Video link') 16 16 90 26)
$urlBox = Add-Control (New-Object Windows.Forms.TextBox) 110 16 420 26 'Top,Left,Right'
$pasteBtn = Add-Control (New-Button 'Paste') 540 15 84 28 'Top,Right'

[void](Add-Control (New-Label 'Quality') 16 56 90 26)
$qualityBox = Add-Control (New-Object Windows.Forms.ComboBox) 110 56 200 26
$qualityBox.DropDownStyle = 'DropDownList'
foreach ($q in Get-QualityNames) { [void]$qualityBox.Items.Add($q) }
$qualityBox.SelectedItem = $settings.Quality
$playlistBox = Add-Control (New-Object Windows.Forms.CheckBox) 330 56 280 26
$playlistBox.Text = 'Whole playlist (if the link has one)'

[void](Add-Control (New-Label 'Save to') 16 96 90 26)
$folderBox = Add-Control (New-Object Windows.Forms.TextBox) 110 96 420 26 'Top,Left,Right'
$folderBox.ReadOnly = $true
$folderBox.Text = $settings.Folder
$browseBtn = Add-Control (New-Button 'Change...') 540 95 84 28 'Top,Right'

$downloadBtn = Add-Control (New-Button 'Download') 110 140 140 36
$downloadBtn.Font = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold)
$cancelBtn = Add-Control (New-Button 'Cancel') 260 140 100 36
$cancelBtn.Enabled = $false
$updateBtn = Add-Control (New-Button 'Update tools') 504 140 120 36 'Top,Right'

$bar = Add-Control (New-Object Windows.Forms.ProgressBar) 16 190 608 22 'Top,Left,Right'
$bar.Maximum = 1000
$status = Add-Control (New-Label 'Paste a YouTube link and press Download.') 16 216 608 26 'Top,Left,Right'

$log = Add-Control (New-Object Windows.Forms.TextBox) 16 248 608 168 'Top,Bottom,Left,Right'
$log.Multiline = $true; $log.ReadOnly = $true; $log.ScrollBars = 'Vertical'
$log.Font = New-Object Drawing.Font('Consolas', 9)
$log.BackColor = [Drawing.SystemColors]::Window

$playBtn = Add-Control (New-Button 'Play last download') 16 426 170 32 'Bottom,Left'
$playBtn.Enabled = $false
$openBtn = Add-Control (New-Button 'Open folder') 196 426 120 32 'Bottom,Left'

$form.AcceptButton = $downloadBtn
$tip = New-Object Windows.Forms.ToolTip
$tip.SetToolTip($updateBtn, 'Fetch the newest yt-dlp, FFmpeg and Deno. Try this if downloads stop working.')
$tip.SetToolTip($playlistBox, 'Off: only the one video in the link. On: every video in its playlist.')

# ---------- state ----------
$state = @{
    Jobs = New-Object System.Collections.Generic.Queue[object]
    Run = $null; Job = $null
    Files = New-Object System.Collections.Generic.List[string]
    LastFile = $null; Errors = New-Object System.Collections.Generic.List[string]
    LastPct = 0.0; Part = 1; Item = ''; Cancelled = $false
}

function Add-LogLine([string]$text) {
    $log.AppendText($text + [Environment]::NewLine)
}

function Set-Busy([bool]$busy) {
    $downloadBtn.Enabled = -not $busy
    $updateBtn.Enabled = -not $busy
    $browseBtn.Enabled = -not $busy
    $urlBox.ReadOnly = $busy
    $qualityBox.Enabled = -not $busy
    $playlistBox.Enabled = -not $busy
    $cancelBtn.Enabled = $busy
}

function Start-NextJob {
    if ($state.Jobs.Count -eq 0) { Complete-All; return }
    $job = $state.Jobs.Dequeue()
    $state.Job = $job
    $state.LastPct = 0.0; $state.Part = 1
    $bar.Style = 'Continuous'; $bar.Value = 0
    $status.Text = $job.Title
    Add-LogLine "--- $($job.Title)"
    try {
        $state.Run = Start-ToolProcess -FilePath $job.Exe -Arguments $job.Args -WorkingDirectory $bin
        $timer.Start()
    } catch {
        $state.Errors.Add("Could not start $($job.Exe): $($_.Exception.Message)")
        Complete-All
    }
}

function Show-Line([string]$line) {
    $l = ConvertFrom-ToolLine $line
    switch ($l.Kind) {
        'Progress' {
            if ($null -eq $l.Percent) { $bar.Style = 'Marquee'; $status.Text = "$($state.Item)Downloading..."; return }
            $bar.Style = 'Continuous'
            if ($l.Percent + 50 -lt $state.LastPct) { $state.Part++ }     # next part (sound after picture)
            $state.LastPct = $l.Percent
            $bar.Value = [int][math]::Min(1000, [math]::Max(0, $l.Percent * 10))
            $what = if ($state.Job.Kind -eq 'download') { if ($state.Part -gt 1) { 'Downloading the sound' } else { 'Downloading' } } else { $state.Job.Title.TrimEnd('.') }
            $bits = @("$($state.Item)$what $([math]::Floor($l.Percent))%")
            if ($l.Speed) { $bits += $l.Speed }
            if ($l.Eta) { $bits += "$($l.Eta) left" }
            $status.Text = $bits -join '  -  '
        }
        'Item'       { $state.Item = "Video $($l.Item) of $($l.Of): "; $state.Part = 1; $state.LastPct = 0; Add-LogLine $l.Text }
        'Processing' { $bar.Style = 'Marquee'; $status.Text = "$($state.Item)Putting the file together..."; Add-LogLine $l.Text }
        'File'       { $state.Files.Add($l.Path); $state.LastFile = $l.Path; Add-LogLine "Saved: $($l.Path)" }
        'Already'    { Add-LogLine $l.Text }
        'Error'      { $state.Errors.Add($l.Text); Add-LogLine "ERROR: $($l.Text)" }
        'Warning'    { if ($l.Text -notmatch 'JavaScript runtime|Falling back') { Add-LogLine "Note: $($l.Text)" } }
        default      {
            if ($l.Text -match '^\[setup\] Downloading (.+)\.\.\.$') { $state.Job.Title = "First run: downloading $($Matches[1])..." }
            if ($l.Text) { Add-LogLine $l.Text }
        }
    }
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({ try { Step-Run } catch { Stop-WithError $_ } })

function Stop-WithError($err) {
    # Anything unexpected is reported in the window instead of closing it.
    if ($state.Run) { try { Stop-ToolProcess $state.Run } catch { } }
    $state.Errors.Add("Something went wrong: $($err.Exception.Message)")
    Add-LogLine "ERROR: $($err.Exception.Message) ($($err.InvocationInfo.PositionMessage))"
    Complete-All
}

function Step-Run {
    $run = $state.Run
    if (-not $run) { $timer.Stop(); return }
    foreach ($line in (Read-ToolProcess $run)) { Show-Line $line }
    if (-not (Test-ToolProcessDone $run)) { return }
    $timer.Stop()
    $code = $run.Process.ExitCode
    $state.Run = $null
    $job = $state.Job
    if ($state.Cancelled) { Complete-All; return }
    if ($job.Kind -eq 'update') {
        Set-YtDlpChecked $bin                        # an update that fails is not worth stopping for
        $state.Errors.Clear()
        Start-NextJob; return
    }
    if ($code -ne 0) {
        if ($job.Kind -eq 'setup' -and $state.Errors.Count -eq 0) { $state.Errors.Add('Setting up the tools failed.') }
        if ($job.Kind -eq 'download' -and $state.Errors.Count -eq 0) { $state.Errors.Add("yt-dlp stopped with code $code.") }
        # a playlist with one bad video still saves the rest, so carry on to report them
        if ($job.Kind -eq 'setup') { $state.Jobs.Clear() }
    }
    Start-NextJob
}

function Complete-All {
    $timer.Stop()
    $state.Run = $null
    $state.Jobs.Clear()
    $bar.Style = 'Continuous'
    Set-Busy $false
    $state.Item = ''
    $playBtn.Enabled = [bool]($state.LastFile -and (Test-Path -LiteralPath $state.LastFile))
    if ($state.Cancelled) {
        $bar.Value = 0; $status.Text = 'Cancelled.'; Add-LogLine 'Cancelled.'
    } elseif ($state.Errors.Count -gt 0) {
        $bar.Value = 0
        $msg = Get-FriendlyError $state.Errors[$state.Errors.Count - 1]
        if ($state.Files.Count -gt 0) { $msg = "Saved $($state.Files.Count) file(s), but some failed. $msg" }
        $status.Text = $msg
        [void][Windows.Forms.MessageBox]::Show($form, $msg, 'YouTube Downloader', 'OK', 'Warning')
    } elseif ($state.Job -and $state.Job.Kind -eq 'download') {
        $bar.Value = 1000
        if ($state.Files.Count -gt 1) { $status.Text = "Done: saved $($state.Files.Count) files." }
        elseif ($state.Files.Count -eq 1) { $status.Text = 'Done: ' + [IO.Path]::GetFileName($state.Files[0]) }
        else { $status.Text = 'Done (it was already downloaded).' }
    } else {
        $bar.Value = 1000; $status.Text = 'The tools are up to date.'
    }
    $state.Job = $null
}

function Start-Work([bool]$download, [bool]$forceUpdate) {
    $state.Jobs.Clear(); $state.Files.Clear(); $state.Errors.Clear(); $state.Cancelled = $false; $state.Item = ''
    if (-not (Test-Path -LiteralPath $bin)) { New-Item -ItemType Directory -Path $bin -Force | Out-Null }   # first run
    $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'Setup-Tools.ps1'), '-BinFolder', $bin)
    if ($forceUpdate) {
        $state.Jobs.Enqueue(@{ Kind = 'setup'; Title = 'Downloading the newest tools...'; Exe = $psExe; Args = $setupArgs + '-Update' })
    } elseif ((Get-MissingTools $bin).Count -gt 0) {
        Add-LogLine 'First run: fetching yt-dlp, FFmpeg and Deno (about 270 MB, once only).'
        $state.Jobs.Enqueue(@{ Kind = 'setup'; Title = 'Setting up the tools (first run only)...'; Exe = $psExe; Args = $setupArgs })
    } elseif (Test-YtDlpStale $bin) {
        $state.Jobs.Enqueue(@{ Kind = 'update'; Title = 'Checking for a newer yt-dlp...'; Exe = (Join-Path $bin 'yt-dlp.exe'); Args = @('-U') })
    }
    if ($download) {
        $folder = $folderBox.Text
        if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
        $dlArgs = New-YtDlpArguments -Url $urlBox.Text -Folder $folder -Quality (Get-QualityCode $qualityBox.SelectedItem) -Playlist:$playlistBox.Checked -BinFolder $bin
        $state.Jobs.Enqueue(@{ Kind = 'download'; Title = 'Starting the download...'; Exe = (Join-Path $bin 'yt-dlp.exe'); Args = $dlArgs })
    }
    Set-Busy $true
    Start-NextJob
}

# ---------- buttons ----------
$downloadBtn.Add_Click({
    $u = $urlBox.Text.Trim()
    if (-not (Test-VideoUrl $u)) {
        [void][Windows.Forms.MessageBox]::Show($form, 'Paste a video link first, for example https://www.youtube.com/watch?v=...', 'YouTube Downloader', 'OK', 'Information')
        [void]$urlBox.Focus(); return
    }
    $urlBox.Text = $u
    try {
        Save-YtdSettings ([pscustomobject]@{ Folder = $folderBox.Text; Quality = [string]$qualityBox.SelectedItem })
        Start-Work $true $false
    } catch { Stop-WithError $_ }
})
$updateBtn.Add_Click({ try { Start-Work $false $true } catch { Stop-WithError $_ } })
$cancelBtn.Add_Click({
    $state.Cancelled = $true
    $state.Jobs.Clear()
    if ($state.Run) { Stop-ToolProcess $state.Run } else { Complete-All }
})
function Get-ClipboardText {
    try { if ([Windows.Forms.Clipboard]::ContainsText()) { return [Windows.Forms.Clipboard]::GetText().Trim() } } catch { }
    ''
}
$pasteBtn.Add_Click({
    $t = Get-ClipboardText
    if ($t) { $urlBox.Text = $t }
})
$browseBtn.Add_Click({
    $dlg = New-Object Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Where should downloads be saved?'
    if (Test-Path -LiteralPath $folderBox.Text) { $dlg.SelectedPath = $folderBox.Text }
    if ($dlg.ShowDialog($form) -eq 'OK') {
        $folderBox.Text = $dlg.SelectedPath
        Save-YtdSettings ([pscustomobject]@{ Folder = $folderBox.Text; Quality = [string]$qualityBox.SelectedItem })
    }
})
$openBtn.Add_Click({
    $f = $folderBox.Text
    if (-not (Test-Path -LiteralPath $f)) { New-Item -ItemType Directory -Path $f -Force | Out-Null }
    if ($state.LastFile -and (Test-Path -LiteralPath $state.LastFile)) {
        Start-Process explorer.exe -ArgumentList "/select,`"$($state.LastFile)`""
    } else {
        Start-Process explorer.exe -ArgumentList "`"$f`""
    }
})
$playBtn.Add_Click({
    if ($state.LastFile -and (Test-Path -LiteralPath $state.LastFile)) { Invoke-Item -LiteralPath $state.LastFile }
})
$form.Add_FormClosing({
    if ($state.Run) { $state.Cancelled = $true; Stop-ToolProcess $state.Run }
})
$form.Add_Shown({
    if ($Url) { $urlBox.Text = $Url }
    else {
        $c = Get-ClipboardText
        if ((Test-VideoUrl $c) -and $c -match 'youtu') { $urlBox.Text = $c }     # a copied YouTube link is filled in
    }
    $form.Activate()
})

[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
