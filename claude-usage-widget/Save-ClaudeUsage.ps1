<#
.SYNOPSIS
  Claude Code status line command. Claude Code pipes session JSON to this script; it saves the
  5-hour and 7-day usage numbers to a local file for the taskbar widget, then prints a status line.
.NOTES
  Configured in ~\.claude\settings.json:
    "statusLine": { "type": "command",
                    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<you>/claude-usage-widget/Save-ClaudeUsage.ps1" }
  This script reads only what Claude Code hands it. It makes no network calls.
#>
$ErrorActionPreference = 'Stop'
try {
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    $raw = [Console]::In.ReadToEnd()
    $json = $raw | ConvertFrom-Json
    Import-Module (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'ClaudeUsage.Core.psm1') -Force
    $snapshot = ConvertFrom-StatusLineInput $json
    if ($null -ne $snapshot) { Save-UsageSnapshot -Snapshot $snapshot }
    Write-Output (Format-StatusLine $json)
} catch {
    # Never break Claude Code's status line; show nothing on failure.
    Write-Output ''
}
exit 0
