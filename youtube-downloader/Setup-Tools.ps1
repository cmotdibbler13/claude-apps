<#
.SYNOPSIS
  Downloads the free tools YouTube Downloader uses into %LOCALAPPDATA%\YouTubeDownloader\bin:
    - yt-dlp.exe   does the downloading         (github.com/yt-dlp/yt-dlp)
    - ffmpeg.exe   joins video and sound, MP3   (github.com/yt-dlp/FFmpeg-Builds)
    - deno.exe     JavaScript, YouTube needs it (github.com/denoland/deno)
  Without switches it fetches only the missing ones. -Update fetches them all again.
  The app runs this itself; it prints DL| progress lines that the window reads.
#>
param([switch]$Update, [string]$BinFolder)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'YouTubeDownloader.Core.psm1') -Force
if (-not $BinFolder) { $BinFolder = Get-YtdBinFolder }
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Save-Url([string]$Url, [string]$Path) {
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(30)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('YouTubeDownloader-setup')
    try {
        $resp = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void]$resp.EnsureSuccessStatusCode()
        $total = $resp.Content.Headers.ContentLength
        $in = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $out = [IO.File]::Create($Path)
        try {
            $buf = New-Object byte[] 262144
            $done = 0L; $lastPct = -1; $watch = [Diagnostics.Stopwatch]::StartNew()
            while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                $out.Write($buf, 0, $n); $done += $n
                if ($total) {
                    $pct = [math]::Floor($done * 100.0 / $total)
                    if ($pct -ne $lastPct) {
                        $lastPct = $pct
                        $mbps = if ($watch.Elapsed.TotalSeconds -gt 0) { $done / 1MB / $watch.Elapsed.TotalSeconds } else { 0 }
                        [Console]::WriteLine(('DL|{0}%|{1:0.0}MiB/s|' -f $pct, $mbps))
                    }
                }
            }
        } finally { $out.Dispose(); $in.Dispose() }
    } finally { $client.Dispose() }
}

function Expand-Only([string]$Zip, [string[]]$Names, [string]$Dest) {
    # Takes just the named programs out of the zip, wherever they sit inside it.
    $z = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        foreach ($name in $Names) {
            $entry = $z.Entries | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
            if (-not $entry) { throw "$name was not found in the download." }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $Dest $name), $true)
        }
    } finally { $z.Dispose() }
}

try {
    if (-not (Test-Path $BinFolder)) { New-Item -ItemType Directory -Path $BinFolder -Force | Out-Null }
    $tools = if ($Update) { Get-ToolSources } else { Get-MissingTools $BinFolder }
    if (-not $tools) { [Console]::WriteLine('All tools are already installed.'); exit 0 }
    foreach ($t in $tools) {
        [Console]::WriteLine("[setup] Downloading $($t.Name)...")
        $tmp = Join-Path $BinFolder ($t.Exe + '.download')
        Save-Url $t.Url $tmp
        if ($t.Zip) {
            Expand-Only $tmp $t.Keep $BinFolder
            Remove-Item $tmp -Force
        } else {
            Move-Item -Path $tmp -Destination (Join-Path $BinFolder $t.Exe) -Force
        }
        [Console]::WriteLine("[setup] $($t.Name) is ready.")
    }
    Set-YtDlpChecked $BinFolder
    [Console]::WriteLine('All tools are installed.')
    exit 0
} catch {
    [Console]::WriteLine("ERROR: Setting up the tools failed: $($_.Exception.Message)")
    Get-ChildItem -Path $BinFolder -Filter '*.download' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    exit 1
}
