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
Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $here 'Theme.cs')) -ReferencedAssemblies System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$bin = Get-YtdBinFolder
$settings = Read-YtdSettings
$psExe = (Get-Process -Id $PID).Path
$P = [SixMinutesOn.Palette]
$dot = [string][char]0x00B7

# ---------- window (Six Minutes On... design system, Night theme) ----------
$form = New-Object Windows.Forms.Form
$form.Text = 'YouTube Downloader'
$form.Font = $P::Regular(10)
$form.BackColor = $P::Surface000
$form.ForeColor = $P::Ink
$form.ClientSize = New-Object Drawing.Size(680, 716)
$form.MinimumSize = New-Object Drawing.Size(600, 696)
$form.StartPosition = 'CenterScreen'
$iconPath = Join-Path $here 'downloader.ico'
if (Test-Path $iconPath) { $form.Icon = New-Object Drawing.Icon($iconPath) }
$form.Add_HandleCreated({
    [SixMinutesOn.Native]::DarkTitleBar($form)
    # taskbar: pin and group as "YouTube Downloader" with its own icon, not as PowerShell
    [SixMinutesOn.Native]::SetWindowAppId($form, (Get-YtdAppId), (Get-YtdLauncher $here).Command, "$iconPath,0", 'YouTube Downloader')
})

function Add-Control($ctl, [int]$x, [int]$y, [int]$w, [int]$h, [string]$anchor = 'Top,Left', $parent = $form) {
    $ctl.Location = New-Object Drawing.Point($x, $y)
    $ctl.Size = New-Object Drawing.Size($w, $h)
    $ctl.Anchor = $anchor
    $parent.Controls.Add($ctl)
    $ctl
}
function New-Eyebrow([string]$text) {
    # small uppercase brass label, widely tracked
    $l = New-Object Windows.Forms.Label
    $l.Text = $P::Track($text); $l.AccessibleName = $text
    $l.Font = $P::Medium(8.25); $l.ForeColor = $P::Brass; $l.BackColor = [Drawing.Color]::Transparent
    $l.TextAlign = 'BottomLeft'
    $l
}
function New-Button([string]$text, [switch]$Primary) {
    $b = New-Object SixMinutesOn.FlatButton
    $b.Text = $text; $b.Primary = [bool]$Primary; $b.Font = $P::Medium(8.75)
    $b
}
function New-Field([switch]$ReadOnly) {
    $f = New-Object SixMinutesOn.Field
    $f.Font = $P::Regular(10)
    $f.Box.ReadOnly = [bool]$ReadOnly
    $f.Box.BackColor = $P::Surface200          # stays navy when read-only
    $f
}
function New-Check([string]$text) {
    $c = New-Object SixMinutesOn.Check
    $c.Text = $text; $c.Font = $P::Regular(9.75)
    $c
}

# header band: eyebrow and title, a hairline rule beneath
$header = Add-Control (New-Object Windows.Forms.Panel) 0 0 680 92 'Top,Left,Right'
$header.BackColor = $P::Surface100
[void](Add-Control (New-Eyebrow 'Offline viewing') 24 18 400 20 'Top,Left' $header)
$title = Add-Control (New-Object Windows.Forms.Label) 21 38 600 40 'Top,Left' $header
$title.Text = 'YouTube Downloader'; $title.Font = $P::Light(20); $title.ForeColor = $P::Ink
$rule = Add-Control (New-Object Windows.Forms.Panel) 0 92 680 1 'Top,Left,Right'
$rule.BackColor = $P::Rule

[void](Add-Control (New-Eyebrow 'Video link') 24 112 300 20)
$urlField = Add-Control (New-Field) 24 136 520 36 'Top,Left,Right'
$urlBox = $urlField.Box
$pasteBtn = Add-Control (New-Button 'Paste') 556 136 100 36 'Top,Right'

[void](Add-Control (New-Eyebrow 'Quality') 24 188 200 20)
$qualityBox = Add-Control (New-Object SixMinutesOn.Picker) 24 212 210 36
$qualityBox.Font = $P::Regular(10)
foreach ($q in Get-QualityNames) { $qualityBox.Items.Add($q) }
$qualityBox.SelectedItem = $settings.Quality
$qualityBox.AccessibleName = 'Quality'

[void](Add-Control (New-Eyebrow 'Save to') 250 188 200 20)
$folderField = Add-Control (New-Field -ReadOnly) 250 212 294 36 'Top,Left,Right'
$folderBox = $folderField.Box
$folderBox.Text = $settings.Folder
$browseBtn = Add-Control (New-Button 'Change') 556 212 100 36 'Top,Right'

[void](Add-Control (New-Eyebrow 'Options') 24 264 200 20)
$playlistBox = Add-Control (New-Check 'Whole playlist (if the link has one)') 24 288 620 28
$sponsorBox = Add-Control (New-Check 'Cut out sponsor sections (SponsorBlock)') 24 318 620 28
$sponsorBox.Checked = $settings.SkipSponsors
$promoBox = Add-Control (New-Check 'Also cut self-promotion and "like and subscribe" reminders') 44 348 600 28
$promoBox.Checked = $settings.SkipPromos
$promoBox.Enabled = $sponsorBox.Checked

[void](Add-Control (New-Eyebrow 'YouTube sign-in') 24 388 300 20)
$signInBox = Add-Control (New-Object SixMinutesOn.Picker) 24 412 210 36
$signInBox.Font = $P::Regular(10)
foreach ($n in Get-SignInNames) { $signInBox.Items.Add($n) }
$signInBox.SelectedItem = $settings.SignIn
$signInBox.AccessibleName = 'YouTube sign-in'
$signInNote = Add-Control (New-Object Windows.Forms.Label) 250 412 406 36 'Top,Left,Right'
$signInNote.ForeColor = $P::InkFaint; $signInNote.TextAlign = 'MiddleLeft'; $signInNote.AutoEllipsis = $true

$downloadBtn = Add-Control (New-Button 'Download' -Primary) 24 472 170 42
$cancelBtn = Add-Control (New-Button 'Cancel') 206 472 120 42
$cancelBtn.Enabled = $false
$updateBtn = Add-Control (New-Button 'Update tools') 506 472 150 42 'Top,Right'

$bar = Add-Control (New-Object SixMinutesOn.SlimBar) 24 534 632 4 'Top,Left,Right'
$status = Add-Control (New-Object Windows.Forms.Label) 24 546 632 26 'Top,Left,Right'
$status.Text = 'Paste a YouTube link and press Download.'
$status.ForeColor = $P::InkMuted; $status.TextAlign = 'MiddleLeft'; $status.AutoEllipsis = $true

# log: a surface-100 plate with a hairline border
$logFrame = Add-Control (New-Object Windows.Forms.Panel) 24 580 632 78 'Top,Bottom,Left,Right'
$logFrame.BackColor = $P::Rule
$logFrame.Padding = New-Object Windows.Forms.Padding(1)
$logInner = New-Object Windows.Forms.Panel
$logInner.Dock = 'Fill'; $logInner.BackColor = $P::Surface100
$logInner.Padding = New-Object Windows.Forms.Padding(10, 8, 4, 8)
$logFrame.Controls.Add($logInner)
$log = New-Object Windows.Forms.TextBox
$log.Dock = 'Fill'; $log.Multiline = $true; $log.ReadOnly = $true; $log.ScrollBars = 'Vertical'
$log.BorderStyle = 'None'; $log.BackColor = $P::Surface100; $log.ForeColor = $P::InkMuted
$log.Font = $P::Mono(9); $log.TabStop = $false
$logInner.Controls.Add($log)
$log.Add_HandleCreated({ [SixMinutesOn.Native]::DarkScrollBars($log) })

$playBtn = Add-Control (New-Button 'Play last download') 24 670 200 34 'Bottom,Left'
$playBtn.Enabled = $false
$openBtn = Add-Control (New-Button 'Open folder') 236 670 140 34 'Bottom,Left'

$appBtn = Add-Control (New-Button 'Update app') 506 670 150 34 'Bottom,Right'
$version = Get-YtdVersion $here

$form.AcceptButton = $downloadBtn
$tip = New-Object Windows.Forms.ToolTip
$tip.SetToolTip($updateBtn, 'Fetch the newest yt-dlp, FFmpeg and Deno. Try this if downloads stop working.')
$tip.SetToolTip($appBtn, "Fetch the newest version of this app from GitHub. This is version $version.")
$tip.SetToolTip($playlistBox, 'Off: only the one video in the link. On: every video in its playlist.')
$tip.SetToolTip($sponsorBox, 'Uses SponsorBlock, where viewers mark the paid sponsor sections of videos. Those parts are cut out of the saved file.')
$tip.SetToolTip($promoBox, 'Also cuts the creator''s own merch plugs and "like and subscribe" reminders, as marked on SponsorBlock.')
$tip.SetToolTip($signInBox, 'Only needed when YouTube asks for a sign-in. Firefox: uses the YouTube sign-in from Firefox on this PC. Cookies file: a cookies.txt exported from any browser.')

$cookies = @{ File = [string]$settings.CookiesFile; Quiet = $false }
function Update-SignInNote {
    switch (Get-SignInCode $signInBox.SelectedItem) {
        'firefox' { $signInNote.Text = 'Uses your YouTube sign-in from Firefox on this PC.' }
        'file'    { $signInNote.Text = 'Using ' + [IO.Path]::GetFileName($cookies.File) }
        default   { $signInNote.Text = 'Only needed if YouTube asks you to sign in.' }
    }
}
Update-SignInNote

function Show-Notice([string]$heading, [string]$text) { [SixMinutesOn.Notice]::Show($form, $heading, $text) }
function Save-CurrentSettings {
    Save-YtdSettings ([pscustomobject]@{
        Folder = $folderBox.Text; Quality = [string]$qualityBox.SelectedItem
        SkipSponsors = $sponsorBox.Checked; SkipPromos = $promoBox.Checked
        SignIn = [string]$signInBox.SelectedItem; CookiesFile = $cookies.File })
}

# ---------- state ----------
$state = @{
    Jobs = New-Object System.Collections.Generic.Queue[object]
    Run = $null; Job = $null
    Files = New-Object System.Collections.Generic.List[string]
    LastFile = $null; Errors = New-Object System.Collections.Generic.List[string]
    LastPct = 0.0; Part = 1; Item = ''; Cancelled = $false; Cut = 0; App = $null
}

function Add-LogLine([string]$text) {
    $log.AppendText($text + [Environment]::NewLine)
}

function Set-Busy([bool]$busy) {
    $downloadBtn.Enabled = -not $busy
    $updateBtn.Enabled = -not $busy
    $appBtn.Enabled = -not $busy
    $browseBtn.Enabled = -not $busy
    $urlBox.ReadOnly = $busy
    $qualityBox.Enabled = -not $busy
    $signInBox.Enabled = -not $busy
    $playlistBox.Enabled = -not $busy
    $sponsorBox.Enabled = -not $busy
    $promoBox.Enabled = (-not $busy) -and $sponsorBox.Checked
    $cancelBtn.Enabled = $busy
}

function Start-NextJob {
    if ($state.Jobs.Count -eq 0) { Complete-All; return }
    $job = $state.Jobs.Dequeue()
    $state.Job = $job
    $state.LastPct = 0.0; $state.Part = 1
    $bar.Busy = $false; $bar.Value = 0
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
            if ($null -eq $l.Percent) { $bar.Busy = $true; $status.Text = "$($state.Item)Downloading..."; return }
            $bar.Busy = $false
            if ($l.Percent + 50 -lt $state.LastPct) { $state.Part++ }     # next part (sound after picture)
            $state.LastPct = $l.Percent
            $bar.Value = [int][math]::Min(1000, [math]::Max(0, $l.Percent * 10))
            $what = if ($state.Job.Kind -eq 'download') { if ($state.Part -gt 1) { 'Downloading the sound' } else { 'Downloading' } } else { $state.Job.Title.TrimEnd('.') }
            $bits = @("$($state.Item)$what $([math]::Floor($l.Percent))%")
            if ($l.Speed) { $bits += $l.Speed }
            if ($l.Eta) { $bits += "$($l.Eta) left" }
            $status.Text = $bits -join "  $dot  "
        }
        'Item'       { $state.Item = "Video $($l.Item) of $($l.Of): "; $state.Part = 1; $state.LastPct = 0; Add-LogLine $l.Text }
        'Processing' { $bar.Busy = $true; $status.Text = "$($state.Item)Putting the file together..."; Add-LogLine $l.Text }
        'Sponsor'    {
            if ($l.Segments -gt 0) { $state.Cut += $l.Segments }
            if ($l.Segments -eq 0) { Add-LogLine 'SponsorBlock: no sponsor sections marked for this video.' }
            else { Add-LogLine "SponsorBlock: $($l.Segments) section(s) to cut." }
        }
        'Cutting'    { $bar.Busy = $true; $status.Text = "$($state.Item)Cutting out sponsor sections..."; Add-LogLine $l.Text }
        'File'       { $state.Files.Add($l.Path); $state.LastFile = $l.Path; Add-LogLine "Saved: $($l.Path)" }
        'Already'    { Add-LogLine $l.Text }
        'AppUpdate'  { $state.App = $l }
        'Error'      { $state.Errors.Add($l.Text); Add-LogLine "ERROR: $($l.Text)" }
        'Warning'    { if ($l.Text -notmatch 'JavaScript runtime|Falling back') { Add-LogLine "Note: $($l.Text)" } }
        default      {
            if ($l.Text -match '^\[update\] Downloading') { $bar.Busy = $true; $status.Text = 'Downloading the new version...' }
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
        if ($job.Kind -eq 'appupdate' -and $state.Errors.Count -eq 0) { $state.Errors.Add('The update failed.') }
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
    $bar.Busy = $false
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
        Show-Notice 'Download problem' $msg
    } elseif ($state.Job -and $state.Job.Kind -eq 'appupdate') {
        $bar.Value = 1000
        if ($state.App -and $state.App.Result -eq 'updated') {
            $status.Text = "Updated to version $($state.App.Version). Restarting..."
            Add-LogLine $status.Text
            Show-Notice 'Updated' "YouTube Downloader is now version $($state.App.Version). It will restart when you press OK."
            $launch = Get-YtdLauncher $here
            Start-Process -FilePath $launch.Target -ArgumentList $launch.Arguments -WorkingDirectory $here
            $state.Job = $null
            $form.Close()
            return
        }
        $status.Text = "You have the newest version ($version)."
        Add-LogLine $status.Text
    } elseif ($state.Job -and $state.Job.Kind -eq 'download') {
        $bar.Value = 1000
        if ($state.Files.Count -gt 1) { $done = "Done: saved $($state.Files.Count) files" }
        elseif ($state.Files.Count -eq 1) { $done = 'Done: ' + [IO.Path]::GetFileName($state.Files[0]) }
        else { $done = 'Done (it was already downloaded)' }
        if ($state.Cut -gt 0) { $done += "  $dot  $($state.Cut) sponsor section(s) cut" }
        $status.Text = $done
        $status.ForeColor = $P::Ink
    } else {
        $bar.Value = 1000; $status.Text = 'The tools are up to date.'
    }
    $state.Job = $null
}

function Start-Work([bool]$download, [bool]$forceUpdate) {
    $state.Jobs.Clear(); $state.Files.Clear(); $state.Errors.Clear(); $state.Cancelled = $false; $state.Item = ''; $state.Cut = 0
    $status.ForeColor = $P::InkMuted
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
        $dlArgs = New-YtDlpArguments -Url $urlBox.Text -Folder $folder -Quality (Get-QualityCode $qualityBox.SelectedItem) -Playlist:$playlistBox.Checked -BinFolder $bin `
            -SkipSponsors:$sponsorBox.Checked -SkipPromos:($sponsorBox.Checked -and $promoBox.Checked) `
            -SignIn (Get-SignInCode $signInBox.SelectedItem) -CookiesFile $cookies.File
        $state.Jobs.Enqueue(@{ Kind = 'download'; Title = 'Starting the download...'; Exe = (Join-Path $bin 'yt-dlp.exe'); Args = $dlArgs })
    }
    Set-Busy $true
    Start-NextJob
}

# ---------- buttons ----------
$downloadBtn.Add_Click({
    $u = $urlBox.Text.Trim()
    if (-not (Test-VideoUrl $u)) {
        Show-Notice 'Video link' 'Paste a video link first, for example https://www.youtube.com/watch?v=...'
        [void]$urlBox.Focus(); return
    }
    $urlBox.Text = $u
    try {
        Save-CurrentSettings
        Start-Work $true $false
    } catch { Stop-WithError $_ }
})
$updateBtn.Add_Click({ try { Start-Work $false $true } catch { Stop-WithError $_ } })
$appBtn.Add_Click({
    try {
        $state.Jobs.Clear(); $state.Files.Clear(); $state.Errors.Clear(); $state.Cancelled = $false; $state.Item = ''; $state.Cut = 0; $state.App = $null
        $status.ForeColor = $P::InkMuted
        $state.Jobs.Enqueue(@{ Kind = 'appupdate'; Title = 'Checking for a new version...'; Exe = $psExe
            Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'Update-App.ps1'), '-AppFolder', $here) })
        Set-Busy $true
        Start-NextJob
    } catch { Stop-WithError $_ }
})
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
        Save-CurrentSettings
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
$sponsorBox.Add_CheckedChanged({ $promoBox.Enabled = $sponsorBox.Checked -and $sponsorBox.Enabled; Save-CurrentSettings })
$promoBox.Add_CheckedChanged({ Save-CurrentSettings })
$qualityBox.Add_SelectedChanged({ Save-CurrentSettings })
$signInBox.Add_SelectedChanged({
    if ($cookies.Quiet) { return }
    if ((Get-SignInCode $signInBox.SelectedItem) -eq 'file') {
        # ask which cookies.txt; backing out returns to not signed in
        $dlg = New-Object Windows.Forms.OpenFileDialog
        $dlg.Title = 'Choose the cookies.txt exported from your browser'
        $dlg.Filter = 'Cookies file (*.txt)|*.txt|All files (*.*)|*.*'
        if ($cookies.File -and (Test-Path -LiteralPath $cookies.File)) { $dlg.FileName = $cookies.File }
        if ($dlg.ShowDialog($form) -eq 'OK') {
            $cookies.File = $dlg.FileName
        } elseif (-not $cookies.File) {
            $cookies.Quiet = $true; $signInBox.SelectedItem = 'Not signed in'; $cookies.Quiet = $false
        }
    }
    Update-SignInNote
    Save-CurrentSettings
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
