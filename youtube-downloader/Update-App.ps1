<#
.SYNOPSIS
  Updates YouTube Downloader from its GitHub repository. Compares the VERSION file here with the
  one on GitHub; if GitHub's is newer, downloads the repository's zip and copies this app's folder
  out of it over the installed files. Settings, the tools and downloader.ico are left alone.
  The app runs this from its Update app button and reads the lines it prints. The last line is
  APPUPDATE|current|<version> or APPUPDATE|updated|<version>.
#>
param([string]$AppFolder, [switch]$Force)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'YouTubeDownloader.Core.psm1') -Force
if (-not $AppFolder) { $AppFolder = $here }
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = Get-YtdUpdateSource

function Get-Text([string]$Url) {
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('YouTubeDownloader-updater')
    $client.DefaultRequestHeaders.Accept.ParseAdd('application/vnd.github.raw')
    try { $client.GetStringAsync($Url).GetAwaiter().GetResult() } finally { $client.Dispose() }
}

function Save-Url([string]$Url, [string]$Path) {
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('YouTubeDownloader-updater')
    try {
        $resp = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void]$resp.EnsureSuccessStatusCode()
        $in = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $out = [IO.File]::Create($Path)
        try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
    } finally { $client.Dispose() }
}

function Get-RemoteVersion {
    # GitHub's API is always current; the plain file address is the fallback and can lag a few minutes.
    foreach ($url in $source.VersionUrls) {
        try {
            $text = (Get-Text $url).Trim()
            if (ConvertTo-YtdVersion $text) { return $text }
        } catch { }
    }
    throw 'Could not reach GitHub to check for a new version. Check your internet connection.'
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('ytd-update-' + [Guid]::NewGuid().ToString('N'))
try {
    $local = Get-YtdVersion $AppFolder
    [Console]::WriteLine("[update] This is version $local. Checking GitHub...")
    $remote = Get-RemoteVersion
    if (-not $Force -and -not (Test-YtdNewer $remote $local)) {
        [Console]::WriteLine("APPUPDATE|current|$local")
        exit 0
    }
    [Console]::WriteLine("[update] Downloading version $remote...")
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $zip = Join-Path $work 'app.zip'
    Save-Url $source.ZipUrl $zip

    # take only this app's folder out of the zip, into a staging folder first
    $stage = Join-Path $work 'files'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $stageRoot = [IO.Path]::GetFullPath($stage) + [IO.Path]::DirectorySeparatorChar
    $z = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($entry in $z.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $at = $name.IndexOf('/' + $source.Folder + '/')
            if ($at -lt 0 -or $name.IndexOf('/') -ne $at -or $name.EndsWith('/')) { continue }
            $relative = $name.Substring($at + $source.Folder.Length + 2)
            $target = [IO.Path]::GetFullPath([IO.Path]::Combine($stage, $relative))
            if (-not $target.StartsWith($stageRoot)) { continue }          # never write outside the staging folder
            $dir = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally { $z.Dispose() }

    foreach ($needed in 'YouTubeDownloader.ps1', 'YouTubeDownloader.Core.psm1', 'Theme.cs', 'VERSION') {
        if (-not (Test-Path -LiteralPath (Join-Path $stage $needed))) { throw "The download is incomplete ($needed is missing). Nothing was changed." }
    }
    Copy-Item -Path (Join-Path $stage '*') -Destination $AppFolder -Recurse -Force
    [Console]::WriteLine("APPUPDATE|updated|$(Get-YtdVersion $AppFolder)")
    exit 0
} catch {
    [Console]::WriteLine("ERROR: The update failed: $($_.Exception.Message)")
    exit 1
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
