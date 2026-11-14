$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here '..\ClaudeUsage.Core.psm1') -Force

$now   = [datetime]::new(2026,11,11,12,0,0,[DateTimeKind]::Utc)
$epoch = [datetime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)
function ToEpoch([datetime]$d) { [long]($d - $epoch).TotalSeconds }

Describe 'ConvertFrom-StatusLineInput' {
    It 'extracts both windows and stamps the time' {
        $json = '{"model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1794400000},"seven_day":{"used_percentage":41.2,"resets_at":1794800000}}}' | ConvertFrom-Json
        $s = ConvertFrom-StatusLineInput $json $now
        $s.five_hour.used_percentage | Should Be 23.5
        $s.five_hour.resets_at | Should Be 1794400000
        $s.seven_day.used_percentage | Should Be 41.2
        $s.updated_at | Should Be (ToEpoch $now)
    }
    It 'returns null when Claude Code sends no rate limits' {
        ConvertFrom-StatusLineInput ('{"model":{"display_name":"Opus"}}' | ConvertFrom-Json) $now | Should Be $null
    }
    It 'keeps a missing window as null' {
        $s = ConvertFrom-StatusLineInput ('{"rate_limits":{"seven_day":{"used_percentage":9,"resets_at":1794800000}}}' | ConvertFrom-Json) $now
        $s.five_hour | Should Be $null
        $s.seven_day.used_percentage | Should Be 9
    }
}

Describe 'ConvertFrom-UsageReport' {
    $reportJson = '{"session":{"total_cost_usd":0},"rate_limits":{"limits":[{"kind":"session","group":"session","percent":27,"resets_at":"2026-11-11T23:49:59.712556+00:00","scope":null,"severity":"normal","is_active":false},{"kind":"weekly_all","group":"weekly","percent":44,"resets_at":"2026-11-12T22:59:59.712575+00:00","scope":null,"severity":"normal","is_active":false},{"kind":"weekly_scoped","group":"weekly","percent":47,"resets_at":"2026-11-12T22:59:59.712758+00:00","scope":{"model":{"display_name":"Fable"}},"severity":"normal","is_active":true}],"extra_usage":{"is_enabled":true}}}'
    It 'maps the session row to the 5-hour window and weekly_all to the 7-day window' {
        $s = ConvertFrom-UsageReport ($reportJson | ConvertFrom-Json) $now
        $s.five_hour.used_percentage | Should Be 27
        $s.seven_day.used_percentage | Should Be 44
        # reset times arrive as 23:49:59.71 and are rounded to the nearest second
        $s.five_hour.resets_at | Should Be (ToEpoch ([datetime]::new(2026,11,11,23,50,0,[DateTimeKind]::Utc)))
        $s.seven_day.resets_at | Should Be (ToEpoch ([datetime]::new(2026,11,12,23,0,0,[DateTimeKind]::Utc)))
        $s.updated_at | Should Be (ToEpoch $now)
    }
    It 'ignores the per-model weekly row' {
        $s = ConvertFrom-UsageReport ($reportJson | ConvertFrom-Json) $now
        $s.seven_day.used_percentage | Should Not Be 47
    }
    It 'returns null when the report has no limits' {
        ConvertFrom-UsageReport ('{"rate_limits":{"limits":null}}' | ConvertFrom-Json) $now | Should Be $null
        ConvertFrom-UsageReport ('{"session":{}}' | ConvertFrom-Json) $now | Should Be $null
    }
    It 'tolerates a row without a reset time' {
        $s = ConvertFrom-UsageReport ('{"rate_limits":{"limits":[{"kind":"session","percent":0,"resets_at":null}]}}' | ConvertFrom-Json) $now
        $s.five_hour.used_percentage | Should Be 0
        $s.five_hour.resets_at | Should Be $null
        $s.seven_day | Should Be $null
    }
}

Describe 'Select-UsageReport' {
    It 'finds the usage report among Claude Code output lines' {
        $lines = @(
            'some warning text',
            '{"type":"system","subtype":"init","model":"claude-haiku-5-5"}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"Current session: 27% used"}]},"usage_report":{"rate_limits":{"limits":[{"kind":"session","percent":27,"resets_at":null}]}}}',
            '{"type":"result","subtype":"success","total_cost_usd":0}'
        )
        $r = Select-UsageReport $lines
        $r.rate_limits.limits[0].percent | Should Be 27
    }
    It 'returns null when no line carries a report' {
        Select-UsageReport @('{"type":"result","subtype":"success"}', 'not json {') | Should Be $null
    }
}

Describe 'Merge-UsageSnapshot' {
    It 'keeps the previous window when the new snapshot lacks it' {
        $old = [pscustomobject]@{ five_hour = [pscustomobject]@{ used_percentage = 50; resets_at = 111 }; seven_day = [pscustomobject]@{ used_percentage = 10; resets_at = 222 }; updated_at = 1 }
        $new = [pscustomobject]@{ five_hour = $null; seven_day = [pscustomobject]@{ used_percentage = 12; resets_at = 222 }; updated_at = 2 }
        $m = Merge-UsageSnapshot $old $new
        $m.five_hour.used_percentage | Should Be 50
        $m.seven_day.used_percentage | Should Be 12
        $m.updated_at | Should Be 2
    }
    It 'returns the new snapshot when there is no previous one' {
        $new = [pscustomobject]@{ five_hour = $null; seven_day = $null; updated_at = 2 }
        (Merge-UsageSnapshot $null $new).updated_at | Should Be 2
    }
}

Describe 'Save-UsageSnapshot / Read-UsageSnapshot' {
    $tmp = Join-Path $env:TEMP ("cu-test-" + [guid]::NewGuid() + "\usage.json")
    AfterEach { if (Test-Path (Split-Path $tmp)) { Remove-Item (Split-Path $tmp) -Recurse -Force } }

    It 'round-trips a snapshot into the display model' {
        $snap = [pscustomobject]@{
            five_hour = [pscustomobject]@{ used_percentage = 23.5; resets_at = (ToEpoch $now.AddHours(2)) }
            seven_day = [pscustomobject]@{ used_percentage = 41.2; resets_at = (ToEpoch $now.AddDays(3)) }
            updated_at = (ToEpoch $now.AddMinutes(-4))
        }
        Save-UsageSnapshot $tmp $snap
        $m = Read-UsageSnapshot $tmp $now
        $m.FiveHour.Percent | Should Be 24
        $m.SevenDay.Percent | Should Be 41
        $m.FiveHour.ResetsAt | Should Be $now.AddHours(2)
        $m.UpdatedAt | Should Be $now.AddMinutes(-4)
    }
    It 'returns null when no snapshot exists yet' {
        Read-UsageSnapshot (Join-Path $env:TEMP 'definitely-missing-cu\usage.json') $now | Should Be $null
    }
    It 'shows a window as 0% once its reset time has passed' {
        $snap = [pscustomobject]@{
            five_hour = [pscustomobject]@{ used_percentage = 80; resets_at = (ToEpoch $now.AddMinutes(-1)) }
            seven_day = [pscustomobject]@{ used_percentage = 41; resets_at = (ToEpoch $now.AddDays(3)) }
            updated_at = (ToEpoch $now.AddHours(-6))
        }
        Save-UsageSnapshot $tmp $snap
        $m = Read-UsageSnapshot $tmp $now
        $m.FiveHour.Percent | Should Be 0
        $m.FiveHour.ResetsAt | Should Be $null
        $m.SevenDay.Percent | Should Be 41
    }
    It 'merges with what is already on disk' {
        Save-UsageSnapshot $tmp ([pscustomobject]@{ five_hour = [pscustomobject]@{ used_percentage = 30; resets_at = (ToEpoch $now.AddHours(1)) }; seven_day = $null; updated_at = 1 })
        Save-UsageSnapshot $tmp ([pscustomobject]@{ five_hour = $null; seven_day = [pscustomobject]@{ used_percentage = 7; resets_at = (ToEpoch $now.AddDays(2)) }; updated_at = 2 })
        $m = Read-UsageSnapshot $tmp $now
        $m.FiveHour.Percent | Should Be 30
        $m.SevenDay.Percent | Should Be 7
    }
    It 'clamps to 0..100 and tolerates a missing window' {
        Save-UsageSnapshot $tmp ([pscustomobject]@{ five_hour = [pscustomobject]@{ used_percentage = 140; resets_at = (ToEpoch $now.AddHours(1)) }; seven_day = $null; updated_at = 1 })
        $m = Read-UsageSnapshot $tmp $now
        $m.FiveHour.Percent | Should Be 100
        $m.SevenDay.Percent | Should Be $null
    }
}

Describe 'Format-StatusLine' {
    It 'shows model and both windows' {
        $json = '{"model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1},"seven_day":{"used_percentage":41.2,"resets_at":2}}}' | ConvertFrom-Json
        Format-StatusLine $json | Should Be 'Opus | 5h 24% | 7d 41%'
    }
    It 'shows just the model before rate limits arrive' {
        Format-StatusLine ('{"model":{"display_name":"Opus"}}' | ConvertFrom-Json) | Should Be 'Opus'
    }
}

Describe 'Format-Age' {
    It 'describes how old the data is' {
        Format-Age $now.AddSeconds(-20) $now | Should Be 'just now'
        Format-Age $now.AddMinutes(-5) $now | Should Be '5 min ago'
        Format-Age $now.AddHours(-3).AddMinutes(-10) $now | Should Be '3 h ago'
        Format-Age $now.AddDays(-2) $now | Should Be '2 d ago'
    }
}

Describe 'Get-UsageColor' {
    It 'is green under 50, amber under 80, red at 80+' {
        (Get-UsageColor 10).Name | Should Be 'ff2e9e5b'
        (Get-UsageColor 49).Name | Should Be 'ff2e9e5b'
        (Get-UsageColor 50).Name | Should Be 'ffd9a21b'
        (Get-UsageColor 79).Name | Should Be 'ffd9a21b'
        (Get-UsageColor 80).Name | Should Be 'ffd94a3d'
        (Get-UsageColor 100).Name | Should Be 'ffd94a3d'
    }
    It 'is grey when unknown' {
        (Get-UsageColor $null).Name | Should Be 'ff8a8a8a'
    }
}

Describe 'Format-ResetIn' {
    It 'formats hours and minutes' {
        Format-ResetIn ($now.AddHours(2).AddMinutes(13)) $now | Should Be 'resets in 2h 13m'
    }
    It 'formats days and hours' {
        Format-ResetIn ($now.AddDays(3).AddHours(4)) $now | Should Be 'resets in 3d 4h'
    }
    It 'formats minutes only' {
        Format-ResetIn ($now.AddMinutes(7)) $now | Should Be 'resets in 7m'
    }
    It 'handles past and unknown' {
        Format-ResetIn ($now.AddMinutes(-1)) $now | Should Be 'resetting now'
        Format-ResetIn $null $now | Should Be ''
    }
}

Describe 'Get-WidgetBounds' {
    It 'sits just left of the tray, vertically centred in the taskbar' {
        $tb = New-Object System.Drawing.Rectangle 0,1392,2560,48
        $tray = New-Object System.Drawing.Rectangle 2314,1392,246,48
        $b = Get-WidgetBounds -Taskbar $tb -Tray $tray -Width 150 -Height 40 -Gap 6
        $b.X | Should Be (2314 - 6 - 150)
        $b.Y | Should Be (1392 + 4)
        $b.Width | Should Be 150
        $b.Height | Should Be 40
    }
    It 'works for a top taskbar too' {
        $tb = New-Object System.Drawing.Rectangle 0,0,2560,48
        $tray = New-Object System.Drawing.Rectangle 2314,0,246,48
        $b = Get-WidgetBounds -Taskbar $tb -Tray $tray -Width 100 -Height 48 -Gap 0
        $b.X | Should Be 2214
        $b.Y | Should Be 0
    }
}

Describe 'Get-TextColorFor' {
    It 'uses dark text on light backgrounds and light text on dark' {
        (Get-TextColorFor ([System.Drawing.Color]::FromArgb(240,240,240))).Name | Should Be 'ff1b1b1b'
        (Get-TextColorFor ([System.Drawing.Color]::FromArgb(32,32,32))).Name | Should Be 'fff2f2f2'
    }
}

Describe 'Get-MascotShape' {
    It 'is a rectangular grid of body, eye and empty cells with two eyes' {
        $rows = Get-MascotShape
        $rows.Count | Should Be 11
        ($rows | ForEach-Object { $_.Length } | Sort-Object -Unique).Count | Should Be 1
        (($rows -join '') -replace '[Xo.]', '').Length | Should Be 0
        (($rows -join '').ToCharArray() | Where-Object { $_ -eq 'o' }).Count | Should Be 8
    }
}

Describe 'Get-WidgetLauncher' {
    It 'starts PowerShell under a headless console host so no window appears' {
        $l = Get-WidgetLauncher -ScriptPath 'C:\w\ClaudeUsageWidget.ps1' -SystemRoot 'C:\Windows'
        $l.Target | Should Be 'C:\Windows\System32\conhost.exe'
        $l.Arguments | Should Be '--headless "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\w\ClaudeUsageWidget.ps1"'
    }
    It 'adds -Restart for the restart shortcut' {
        $l = Get-WidgetLauncher -ScriptPath 'C:\w\ClaudeUsageWidget.ps1' -SystemRoot 'C:\Windows' -Restart
        $l.Arguments | Should Match ' -File "C:\\w\\ClaudeUsageWidget\.ps1" -Restart$'
    }
    It 'produces a command line that is recognised as the widget' {
        $l = Get-WidgetLauncher -ScriptPath 'C:\my files\ClaudeUsageWidget.ps1' -SystemRoot 'C:\Windows' -Restart
        Test-WidgetCommandLine $l.Arguments | Should Be $true
    }
}

Describe 'Test-WidgetCommandLine' {
    It 'matches the widget started with -File, quoted or not' {
        Test-WidgetCommandLine 'powershell.exe -NoProfile -File C:\apps\claude-usage-widget\ClaudeUsageWidget.ps1' | Should Be $true
        Test-WidgetCommandLine '"powershell.exe" -NoProfile -WindowStyle Hidden -File "C:\a b\ClaudeUsageWidget.ps1" -CheckMinutes 1' | Should Be $true
    }
    It 'ignores other PowerShell processes' {
        Test-WidgetCommandLine 'powershell.exe -NoProfile -File C:\x\Save-ClaudeUsage.ps1' | Should Be $false
        Test-WidgetCommandLine 'powershell.exe -Command "Get-Content C:\x\ClaudeUsageWidget.ps1"' | Should Be $false
        Test-WidgetCommandLine 'powershell.exe -File C:\x\NotClaudeUsageWidget.ps1' | Should Be $false
        Test-WidgetCommandLine $null | Should Be $false
    }
}

Describe 'No network or credential access' {
    It 'the module and scripts never touch the login file or the network' {
        $root = Join-Path $here '..'
        foreach ($f in 'ClaudeUsage.Core.psm1','ClaudeUsageWidget.ps1','Save-ClaudeUsage.ps1') {
            $text = Get-Content (Join-Path $root $f) -Raw
            $text | Should Not Match 'credentials\.json'
            $text | Should Not Match 'Invoke-RestMethod|Invoke-WebRequest|WebClient|HttpClient'
            $text | Should Not Match 'oauth'
        }
    }
}
