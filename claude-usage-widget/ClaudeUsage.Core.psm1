# ClaudeUsage.Core - pure helpers for the Claude usage taskbar widget.
#
# Data flow: Claude Code runs Save-ClaudeUsage.ps1 as its status line command and hands it the
# session's rate-limit numbers. That script saves them to a small local file. The widget only
# reads that file. Nothing here signs in anywhere or talks to the network.
# Everything is testable without a UI. See tests\Core.Tests.ps1.

Add-Type -AssemblyName System.Drawing

$script:Epoch = [datetime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
$script:DefaultUsagePath = Join-Path $env:LOCALAPPDATA 'ClaudeUsageWidget\usage.json'

function Get-UsageFilePath { $script:DefaultUsagePath }

function ConvertTo-EpochSeconds([datetime]$d) { [long]($d.ToUniversalTime() - $script:Epoch).TotalSeconds }

# --- Status line side: turn Claude Code's input into a snapshot ----------------------------

function ConvertFrom-StatusLineInput {
    <# Picks the rate-limit windows out of the JSON Claude Code sends to a status line command.
       Returns {five_hour, seven_day, updated_at} or $null when no rate limits were sent. #>
    param($Json, [datetime]$Now = [datetime]::UtcNow)
    $rl = $Json.rate_limits
    if ($null -eq $rl -or ($null -eq $rl.five_hour -and $null -eq $rl.seven_day)) { return $null }
    $windows = @{}
    foreach ($name in 'five_hour', 'seven_day') {
        $w = $rl.$name
        $windows[$name] = if ($null -eq $w) { $null } else {
            [pscustomobject]@{ used_percentage = $w.used_percentage; resets_at = $w.resets_at }
        }
    }
    [pscustomobject]@{
        five_hour  = $windows['five_hour']
        seven_day  = $windows['seven_day']
        updated_at = (ConvertTo-EpochSeconds $Now)
    }
}

# --- /usage side: ask Claude Code itself for the account-wide report ------------------------
# `claude -p "/usage"` is Claude Code's documented headless form of its /usage command. Claude Code
# does the lookup and prints the report; it is answered locally and uses no model tokens. This
# covers usage from the desktop app and claude.ai as well, because the figures are account-wide.

function ConvertFrom-UsageReport {
    <# Turns the usage_report object printed by `claude -p "/usage"` into a snapshot, or $null. #>
    param($Report, [datetime]$Now = [datetime]::UtcNow)
    $limits = $Report.rate_limits.limits
    if (-not $limits) { return $null }
    $map = @{ session = 'five_hour'; weekly_all = 'seven_day' }
    $windows = @{ five_hour = $null; seven_day = $null }
    foreach ($row in $limits) {
        $name = $map[[string]$row.kind]
        if (-not $name) { continue }
        $reset = $null
        if ($row.resets_at) {
            $reset = ConvertTo-EpochSeconds ([datetimeoffset]::Parse([string]$row.resets_at, [cultureinfo]::InvariantCulture)).UtcDateTime
        }
        $windows[$name] = [pscustomobject]@{ used_percentage = $row.percent; resets_at = $reset }
    }
    if ($null -eq $windows['five_hour'] -and $null -eq $windows['seven_day']) { return $null }
    [pscustomobject]@{
        five_hour  = $windows['five_hour']
        seven_day  = $windows['seven_day']
        updated_at = (ConvertTo-EpochSeconds $Now)
    }
}

function Select-UsageReport {
    <# Finds the usage_report in Claude Code's stream-json output lines. Returns it or $null. #>
    param([string[]]$Lines)
    foreach ($line in $Lines) {
        if (-not $line -or $line.IndexOf('usage_report') -lt 0) { continue }
        try { $d = $line | ConvertFrom-Json } catch { continue }
        if ($d.usage_report) { return $d.usage_report }
    }
    $null
}

function Find-ClaudeCli {
    $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $fallback) { return $fallback }
    throw 'Claude Code CLI not found. Install it or add it to PATH.'
}

function Invoke-ClaudeUsageCommand {
    <# Runs `claude -p "/usage"` hidden and returns its output lines. Throws on timeout or failure.
       Flags: Haiku is only a guard in case the command ever falls through to the model; no MCP
       servers, no saved transcript, and only project settings (none in the neutral working
       directory) so user hooks and plugins are not started for a status check. #>
    param([string]$ClaudePath = (Find-ClaudeCli), [int]$TimeoutSeconds = 60)
    $workDir = Split-Path -Parent $script:DefaultUsagePath
    if (-not (Test-Path $workDir)) { [void](New-Item -ItemType Directory -Force $workDir) }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ClaudePath
    $psi.Arguments = '-p "/usage" --model haiku --output-format stream-json --verbose --strict-mcp-config --no-session-persistence --setting-sources project'
    $psi.WorkingDirectory = $workDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $stdout = $p.StandardOutput.ReadToEndAsync()
    $stderr = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
        try { $p.Kill() } catch {}
        throw "Claude Code did not answer /usage within $TimeoutSeconds s."
    }
    $p.WaitForExit()
    $text = $stdout.Result
    if ($p.ExitCode -ne 0 -and -not $text) {
        $err = ([string]$stderr.Result).Trim()
        if ($err.Length -gt 200) { $err = $err.Substring(0, 200) }
        throw "Claude Code exited with code $($p.ExitCode). $err"
    }
    $text -split "`r?`n"
}

function Update-UsageFromCli {
    <# Asks Claude Code for the usage report and saves it. Returns the snapshot. Throws with a
       readable message when the report is missing (for example when not signed in). #>
    param([string]$Path = $script:DefaultUsagePath)
    $lines = Invoke-ClaudeUsageCommand
    $report = Select-UsageReport $lines
    $snapshot = $null
    if ($report) { $snapshot = ConvertFrom-UsageReport $report }
    if ($null -eq $snapshot) {
        throw "Claude Code returned no usage report. Check that 'claude' is signed in with your subscription."
    }
    Save-UsageSnapshot -Path $Path -Snapshot $snapshot
    $snapshot
}

function Merge-UsageSnapshot {
    <# Claude Code can omit a window. Keep the last known one; its reset time says when it expires. #>
    param($Old, $New)
    if ($null -eq $Old) { return $New }
    [pscustomobject]@{
        five_hour  = if ($null -ne $New.five_hour) { $New.five_hour } else { $Old.five_hour }
        seven_day  = if ($null -ne $New.seven_day) { $New.seven_day } else { $Old.seven_day }
        updated_at = $New.updated_at
    }
}

function Save-UsageSnapshot {
    param([string]$Path = $script:DefaultUsagePath, [Parameter(Mandatory)]$Snapshot)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Force $dir) }
    $old = $null
    if (Test-Path $Path) { try { $old = Get-Content $Path -Raw | ConvertFrom-Json } catch {} }
    $merged = Merge-UsageSnapshot $old $Snapshot
    $tmp = "$Path.tmp"
    $merged | ConvertTo-Json -Depth 5 | Set-Content $tmp -Encoding UTF8
    Move-Item $tmp $Path -Force
}

function Format-StatusLine {
    <# The text shown in Claude Code's own status line. #>
    param($Json)
    $parts = @()
    if ($Json.model.display_name) { $parts += [string]$Json.model.display_name }
    $rl = $Json.rate_limits
    if ($rl -and $null -ne $rl.five_hour.used_percentage) { $parts += ('5h {0}%' -f [int][math]::Round([double]$rl.five_hour.used_percentage)) }
    if ($rl -and $null -ne $rl.seven_day.used_percentage) { $parts += ('7d {0}%' -f [int][math]::Round([double]$rl.seven_day.used_percentage)) }
    $parts -join ' | '
}

# --- Widget side: read the snapshot into a display model -----------------------------------

function Read-UsageSnapshot {
    <# Returns {FiveHour, SevenDay, UpdatedAt} or $null when there is no snapshot yet.
       Each window has Percent (int 0..100 or $null) and ResetsAt (UTC DateTime or $null).
       A window whose reset time has passed is shown as 0%, because it has reset. #>
    param([string]$Path = $script:DefaultUsagePath, [datetime]$Now = [datetime]::UtcNow)
    if (-not (Test-Path $Path)) { return $null }
    $d = Get-Content $Path -Raw | ConvertFrom-Json
    $model = @{}
    foreach ($name in 'five_hour', 'seven_day') {
        $w = $d.$name
        $pct = $null; $reset = $null
        if ($null -ne $w) {
            if ($null -ne $w.used_percentage) {
                $pct = [int][math]::Round([math]::Max(0, [math]::Min(100, [double]$w.used_percentage)))
            }
            if ($null -ne $w.resets_at) {
                $reset = $script:Epoch.AddSeconds([double]$w.resets_at)
                if ($reset -le $Now.ToUniversalTime()) { $pct = 0; $reset = $null }
            }
        }
        $model[$name] = [pscustomobject]@{ Percent = $pct; ResetsAt = $reset }
    }
    $updated = $null
    if ($null -ne $d.updated_at) { $updated = $script:Epoch.AddSeconds([double]$d.updated_at) }
    [pscustomobject]@{ FiveHour = $model['five_hour']; SevenDay = $model['seven_day']; UpdatedAt = $updated }
}

function Format-Age {
    param($UpdatedAt, [datetime]$Now = [datetime]::UtcNow)
    if ($null -eq $UpdatedAt) { return '' }
    $span = $Now.ToUniversalTime() - ([datetime]$UpdatedAt).ToUniversalTime()
    if ($span.TotalMinutes -lt 1) { return 'just now' }
    if ($span.TotalHours -lt 1) { return ('{0} min ago' -f [int][math]::Floor($span.TotalMinutes)) }
    if ($span.TotalDays -lt 1) { return ('{0} h ago' -f [int][math]::Floor($span.TotalHours)) }
    '{0} d ago' -f [int][math]::Floor($span.TotalDays)
}

function Get-UsageColor {
    <# Green under 50%, amber under 80%, red from 80%, grey when unknown. #>
    param($Percent)
    if ($null -eq $Percent) { return [System.Drawing.Color]::FromArgb(0x8a, 0x8a, 0x8a) }
    if ($Percent -ge 80)   { return [System.Drawing.Color]::FromArgb(0xd9, 0x4a, 0x3d) }
    if ($Percent -ge 50)   { return [System.Drawing.Color]::FromArgb(0xd9, 0xa2, 0x1b) }
    [System.Drawing.Color]::FromArgb(0x2e, 0x9e, 0x5b)
}

function Format-ResetIn {
    param($ResetsAt, [datetime]$Now = [datetime]::UtcNow)
    if ($null -eq $ResetsAt) { return '' }
    $span = [datetime]$ResetsAt - $Now
    if ($span.TotalSeconds -le 0) { return 'resetting now' }
    if ($span.TotalDays -ge 1) { return ('resets in {0}d {1}h' -f [int][math]::Floor($span.TotalDays), $span.Hours) }
    if ($span.TotalHours -ge 1) { return ('resets in {0}h {1}m' -f $span.Hours, $span.Minutes) }
    'resets in {0}m' -f [math]::Max(1, $span.Minutes)
}

function Get-WidgetBounds {
    <# Places the strip just left of the tray, vertically centred in the taskbar. #>
    param(
        [Parameter(Mandatory)][System.Drawing.Rectangle]$Taskbar,
        [Parameter(Mandatory)][System.Drawing.Rectangle]$Tray,
        [int]$Width, [int]$Height, [int]$Gap = 6
    )
    $x = $Tray.Left - $Gap - $Width
    $y = $Taskbar.Top + [int][math]::Floor(($Taskbar.Height - $Height) / 2)
    New-Object System.Drawing.Rectangle $x, $y, $Width, $Height
}

function Get-TextColorFor {
    param([Parameter(Mandatory)][System.Drawing.Color]$Background)
    $lum = (0.299 * $Background.R + 0.587 * $Background.G + 0.114 * $Background.B)
    if ($lum -gt 140) { [System.Drawing.Color]::FromArgb(0x1b, 0x1b, 0x1b) } else { [System.Drawing.Color]::FromArgb(0xf2, 0xf2, 0xf2) }
}

function Get-MascotShape {
    <# Pixel rows for the little orange Claude critter: X = body, o = eye, . = empty. 12 columns x 11 rows. #>
    @(
        '..XXXXXXXX..',
        '.XXXXXXXXXX.',
        'XXXXXXXXXXXX',
        'XXooXXXXooXX',
        'XXooXXXXooXX',
        'XXXXXXXXXXXX',
        'XXXXXXXXXXXX',
        'XXXXXXXXXXXX',
        '.XXXXXXXXXX.',
        '.XX.XXXX.XX.',
        '.XX.XXXX.XX.'
    )
}

function Get-WidgetLauncher {
    <#
      Target and arguments for a shortcut that starts the widget with no console window at all.
      powershell.exe always gets a console, and "-WindowStyle Hidden" only hides it after it has
      appeared (and not at all under some terminal hosts). Running it under "conhost --headless"
      gives it a console that never has a window, so nothing shows on the taskbar.
      -Restart makes the shortcut close a running copy first, so it doubles as a restart button.
    #>
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [switch]$Restart,
        [string]$SystemRoot = $env:SystemRoot
    )
    $ps = Join-Path $SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '--headless "{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}"' -f $ps, $ScriptPath
    if ($Restart) { $arguments += ' -Restart' }
    [pscustomobject]@{ Target = (Join-Path $SystemRoot 'System32\conhost.exe'); Arguments = $arguments }
}

function Test-WidgetCommandLine {
    <# True when a process command line is PowerShell running the widget script with -File. #>
    param([string]$CommandLine)
    if (-not $CommandLine) { return $false }
    $CommandLine -match '-File\s+"?[^"]*\\ClaudeUsageWidget\.ps1(\s|"|$)'
}

function Get-WidgetProcessId {
    <# Process ids of running widget copies, other than this process. #>
    param([int]$ExceptId = $PID)
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.ProcessId -ne $ExceptId -and (Test-WidgetCommandLine $_.CommandLine) } |
        ForEach-Object { [int]$_.ProcessId }
}

Export-ModuleMember -Function Get-UsageFilePath, ConvertFrom-StatusLineInput, Merge-UsageSnapshot, Save-UsageSnapshot,
    ConvertFrom-UsageReport, Select-UsageReport, Find-ClaudeCli, Invoke-ClaudeUsageCommand, Update-UsageFromCli,
    Format-StatusLine, Read-UsageSnapshot, Format-Age, Get-UsageColor, Format-ResetIn, Get-WidgetBounds,
    Get-TextColorFor, Get-MascotShape, Get-WidgetLauncher, Test-WidgetCommandLine, Get-WidgetProcessId
