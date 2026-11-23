<#
  Helpers for YouTube Downloader: where the tools live, the yt-dlp command line, reading
  yt-dlp's output, and running a tool in the background without blocking the window.
  Works in Windows PowerShell 5.1 and PowerShell 7.
#>

$script:ToolSources = @(
    [pscustomobject]@{ Name = 'yt-dlp'; Exe = 'yt-dlp.exe'; Zip = $false
        Url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' }
    [pscustomobject]@{ Name = 'FFmpeg'; Exe = 'ffmpeg.exe'; Zip = $true
        Url = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
        Keep = @('ffmpeg.exe', 'ffprobe.exe') }
    [pscustomobject]@{ Name = 'Deno'; Exe = 'deno.exe'; Zip = $true
        Url = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip'
        Keep = @('deno.exe') }
)

$script:Qualities = [ordered]@{
    'Best available (MP4)'  = 'best'
    '1080p (MP4)'           = '1080'
    '720p (MP4)'            = '720'
    '480p (MP4)'            = '480'
    'Audio only (MP3)'      = 'mp3'
}

function Get-YtdDataFolder {
    # %LOCALAPPDATA%\YouTubeDownloader (settings, and the tools in .\bin)
    $base = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $base) { $base = [IO.Path]::GetTempPath() }
    Join-Path $base 'YouTubeDownloader'
}

function Get-YtdBinFolder { Join-Path (Get-YtdDataFolder) 'bin' }

function Get-ToolSources { $script:ToolSources }

function Get-MissingTools([string]$BinFolder = (Get-YtdBinFolder)) {
    # The tools whose program is not in the bin folder yet.
    @($script:ToolSources | Where-Object { -not (Test-Path (Join-Path $BinFolder $_.Exe)) })
}

function Test-YtDlpStale([string]$BinFolder = (Get-YtdBinFolder), [int]$Days = 7, [datetime]$Now = (Get-Date)) {
    # YouTube changes often and old yt-dlp versions stop working, so it is updated weekly.
    $stamp = Join-Path $BinFolder 'yt-dlp.checked'
    $exe = Join-Path $BinFolder 'yt-dlp.exe'
    if (-not (Test-Path $exe)) { return $false }
    $last = if (Test-Path $stamp) { (Get-Item $stamp).LastWriteTime } else { (Get-Item $exe).LastWriteTime }
    ($Now - $last).TotalDays -ge $Days
}

function Set-YtDlpChecked([string]$BinFolder = (Get-YtdBinFolder)) {
    $stamp = Join-Path $BinFolder 'yt-dlp.checked'
    Set-Content -Path $stamp -Value (Get-Date -Format o)
}

$script:AppId = 'SixMinutesOn.YouTubeDownloader'
function Get-YtdAppId { $script:AppId }

function Get-YtdLauncher([string]$Folder) {
    # How the app is started: PowerShell under conhost --headless, a console that never shows a
    # window. Used by the shortcuts and as the taskbar's relaunch command, so the two always match.
    $script = [IO.Path]::Combine($Folder, 'YouTubeDownloader.ps1')
    $target = [IO.Path]::Combine($env:SystemRoot, 'System32\conhost.exe')
    $arguments = "--headless powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File `"$script`""
    [pscustomobject]@{ Target = $target; Arguments = $arguments; Command = "`"$target`" $arguments" }
}

function Get-QualityNames { @($script:Qualities.Keys) }

# Where the YouTube sign-in comes from when YouTube asks for one. Chrome and Edge are left out on
# purpose: on Windows they lock and encrypt their cookies, so yt-dlp cannot read them.
$script:SignIns = [ordered]@{
    'Not signed in' = 'none'
    'Firefox'       = 'firefox'
    'Cookies file'  = 'file'
}
function Get-SignInNames { @($script:SignIns.Keys) }
function Get-SignInCode([string]$Name) {
    if ($Name -and $script:SignIns.Contains($Name)) { return $script:SignIns[$Name] }
    'none'
}

function Get-QualityCode([string]$Name) {
    if ($script:Qualities.Contains($Name)) { return $script:Qualities[$Name] }
    'best'
}

function Test-VideoUrl([string]$Url) {
    # Any web link is passed to yt-dlp (it knows many sites); this only stops obvious mistakes.
    if (-not $Url) { return $false }
    $u = $null
    if (-not [Uri]::TryCreate($Url.Trim(), [UriKind]::Absolute, [ref]$u)) { return $false }
    ($u.Scheme -eq 'http' -or $u.Scheme -eq 'https') -and $u.Host.Contains('.')
}

function New-YtDlpArguments {
    # The yt-dlp command line for one download, as a list of separate arguments.
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Folder,
        [string]$Quality = 'best',
        [switch]$Playlist,
        [string]$BinFolder,
        [string]$JsRuntime = 'deno',
        [switch]$SkipSponsors,
        [switch]$SkipPromos,
        [string]$SignIn = 'none',
        [string]$CookiesFile
    )
    $a = New-Object System.Collections.Generic.List[string]
    $a.AddRange([string[]]@(
        '--newline', '--no-colors', '--encoding', 'utf-8',
        '--progress-delta', '0.5',
        '--progress-template', 'download:DL|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
        '--print', 'after_move:FILE|%(filepath)s',
        '--no-quiet', '--progress',                 # --print alone would hide the progress
        '--no-simulate', '--no-mtime', '--windows-filenames',
        '-P', $Folder
    ))
    if ($Playlist) {
        # each playlist gets its own folder, files numbered in playlist order
        $a.AddRange([string[]]@('--yes-playlist', '-o', '%(playlist_title|Playlist)s/%(playlist_index)03d - %(title)s [%(id)s].%(ext)s'))
    } else {
        $a.AddRange([string[]]@('--no-playlist', '-o', '%(title)s [%(id)s].%(ext)s'))
    }
    if ($BinFolder) {
        $a.AddRange([string[]]@('--ffmpeg-location', $BinFolder))
        $deno = [IO.Path]::Combine($BinFolder, 'deno.exe')
        $a.AddRange([string[]]@('--js-runtimes', "deno:$deno"))
    } elseif ($JsRuntime) {
        $a.AddRange([string[]]@('--js-runtimes', $JsRuntime))
    }
    if ($Quality -eq 'mp3') {
        $a.AddRange([string[]]@('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'))
    } else {
        # H.264 video with AAC audio in MP4 plays in every Windows player. 'res' first means the
        # highest resolution wins (above 1080p YouTube only has VP9/AV1, still put in an MP4).
        $res = if ($Quality -eq 'best') { 'res' } else { "res:$Quality" }
        $a.AddRange([string[]]@('-S', "$res,vcodec:h264,acodec:m4a", '--merge-output-format', 'mp4'))
    }
    if ($SkipSponsors -or $SkipPromos) {
        # SponsorBlock: viewers mark these sections; yt-dlp looks them up and FFmpeg cuts them out.
        $cats = @()
        if ($SkipSponsors) { $cats += 'sponsor' }
        if ($SkipPromos) { $cats += 'selfpromo', 'interaction' }
        $a.AddRange([string[]]@('--sponsorblock-remove', ($cats -join ',')))
    }
    # YouTube sometimes wants proof of a signed-in person. yt-dlp can borrow the sign-in from Firefox,
    # or read a cookies.txt exported from any browser.
    if ($SignIn -eq 'firefox') {
        $a.AddRange([string[]]@('--cookies-from-browser', 'firefox'))
    } elseif ($SignIn -eq 'file' -and $CookiesFile) {
        $a.AddRange([string[]]@('--cookies', $CookiesFile))
    }
    $a.Add('--')
    $a.Add($Url.Trim())
    , $a.ToArray()
}

function ConvertTo-CommandLine([string[]]$Arguments) {
    # Joins arguments into one Windows command line (the rules programs use to split it again),
    # because Windows PowerShell's ProcessStartInfo has no ArgumentList.
    $parts = foreach ($arg in $Arguments) {
        if ($arg -ne '' -and $arg -notmatch '[\s"]') { $arg; continue }
        $bs = [char]'\'
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('"')
        $slashes = 0
        foreach ($ch in $arg.ToCharArray()) {
            if ($ch -eq $bs) { $slashes++; continue }
            if ($ch -eq [char]'"') { [void]$sb.Append($bs, $slashes * 2 + 1); [void]$sb.Append([char]'"') }
            else { if ($slashes) { [void]$sb.Append($bs, $slashes) }; [void]$sb.Append($ch) }
            $slashes = 0
        }
        if ($slashes) { [void]$sb.Append($bs, $slashes * 2) }
        [void]$sb.Append('"')
        $sb.ToString()
    }
    $parts -join ' '
}

function ConvertFrom-ToolLine([string]$Line) {
    # Turns one line of yt-dlp (or Setup-Tools.ps1) output into something the window can show.
    $t = if ($null -eq $Line) { '' } else { $Line.TrimEnd() }
    $o = [ordered]@{ Kind = 'Info'; Text = $t; Percent = $null; Speed = ''; Eta = ''; Path = ''; Item = 0; Of = 0; Segments = -1 }
    if ($t -match '^DL\|\s*([\d.]+)%\|([^|]*)\|(.*)$') {
        $o.Kind = 'Progress'
        $o.Percent = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
        $o.Speed = $Matches[2].Trim(); $o.Eta = $Matches[3].Trim()
        if ($o.Speed -match '^(N/A|Unknown)') { $o.Speed = '' }
        if ($o.Eta -match '^(N/A|Unknown)') { $o.Eta = '' }
    } elseif ($t -match '^DL\|') {
        $o.Kind = 'Progress'                          # size unknown (live or streamed): no percent
    } elseif ($t -match '^FILE\|(.+)$') {
        $o.Kind = 'File'; $o.Path = $Matches[1].Trim()
    } elseif ($t -match '^ERROR:\s*(.*)$') {
        $o.Kind = 'Error'; $o.Text = $Matches[1]
    } elseif ($t -match '^WARNING:\s*(.*)$') {
        $o.Kind = 'Warning'; $o.Text = $Matches[1]
    } elseif ($t -match '^\[download\] Downloading (?:item|video) (\d+) of (\d+)') {
        $o.Kind = 'Item'; $o.Item = [int]$Matches[1]; $o.Of = [int]$Matches[2]
    } elseif ($t -match '^\[SponsorBlock\] Found (\d+) segments?') {
        $o.Kind = 'Sponsor'; $o.Segments = [int]$Matches[1]
    } elseif ($t -match '^\[SponsorBlock\] No matching segments') {
        $o.Kind = 'Sponsor'; $o.Segments = 0
    } elseif ($t -match '^\[ModifyChapters\] Removing chapters') {
        $o.Kind = 'Cutting'
    } elseif ($t -match '^\[(Merger|ExtractAudio|VideoConvertor|FixupM3u8|FixupM4a)\]') {
        $o.Kind = 'Processing'
    } elseif ($t -match '^\[download\] .+ has already been downloaded') {
        $o.Kind = 'Already'
    }
    [pscustomobject]$o
}

function Get-FriendlyError([string]$Text) {
    # Plain-English versions of the yt-dlp errors people actually meet.
    switch -Regex ($Text) {
        'Sign in to confirm (you.re not a bot|your age)' { return 'YouTube is asking for a sign-in before it will hand over this video. Under YouTube sign-in, choose Firefox (signed in to YouTube there) or a cookies file, then press Download again. If you are already using one, sign in to YouTube again in the browser, or wait an hour.' }
        'could not find firefox cookies database'        { return 'No Firefox sign-in was found. Install Firefox, sign in to YouTube in it once, then try again.' }
        'cookies are no longer valid|does not look like a Netscape format' { return 'The YouTube sign-in is out of date or the cookies file is not valid. Sign in to YouTube again in the browser (and export the cookies file again), then try again.' }
        'rate-limited by YouTube|content isn.t available, try again later' { return 'YouTube has paused downloads from your connection for a while. Wait about an hour, then try again.' }
        'Private video'                                   { return 'This video is private.' }
        'Video unavailable|This video has been removed'   { return 'This video is not available (removed, or blocked in your country).' }
        'members-only|Join this channel'                  { return 'This video is for channel members only.' }
        'Premieres in|live event will begin'              { return 'This video has not started yet.' }
        'is not a valid URL|Unsupported URL'              { return 'That link is not a video yt-dlp can download.' }
        'HTTP Error 404'                                  { return 'Nothing was found at that link. Check it and try again.' }
        'HTTP Error 403'                                  { return 'YouTube refused the download (HTTP 403). Press Update tools, then try again.' }
        'No space left'                                   { return 'The disk is full.' }
        'getaddrinfo failed|Failed to resolve|timed out'  { return 'Could not reach YouTube. Check your internet connection.' }
    }
    $Text
}

function Start-ToolProcess {
    # Starts a program with its output captured. Read its lines with Read-ToolProcess.
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ConvertTo-CommandLine $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
    $p = [Diagnostics.Process]::Start($psi)
    [pscustomobject]@{
        Process = $p
        Out = $p.StandardOutput.ReadLineAsync()
        Err = $p.StandardError.ReadLineAsync()
        OutDone = $false
        ErrDone = $false
    }
}

function Read-ToolProcess($Run) {
    # Returns the lines the program has written since the last call, without waiting.
    # Uses only .NET tasks polled from the caller's thread, so it is safe from a WinForms timer.
    $lines = New-Object System.Collections.Generic.List[string]
    while (-not $Run.OutDone -and $Run.Out.IsCompleted) {
        $l = $Run.Out.Result
        if ($null -eq $l) { $Run.OutDone = $true } else { $lines.Add($l); $Run.Out = $Run.Process.StandardOutput.ReadLineAsync() }
    }
    while (-not $Run.ErrDone -and $Run.Err.IsCompleted) {
        $l = $Run.Err.Result
        if ($null -eq $l) { $Run.ErrDone = $true } else { $lines.Add($l); $Run.Err = $Run.Process.StandardError.ReadLineAsync() }
    }
    , $lines.ToArray()
}

function Test-ToolProcessDone($Run) {
    # True once the program has exited and all of its output has been read.
    $Run.OutDone -and $Run.ErrDone -and $Run.Process.HasExited
}

function Stop-ToolProcess($Run) {
    # Stops the program and anything it started (yt-dlp runs ffmpeg).
    if (-not $Run -or $Run.Process.HasExited) { return }
    $onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    if ($onWindows) {
        & taskkill.exe /T /F /PID $Run.Process.Id 2>&1 | Out-Null
    } else {
        $Run.Process.Kill()
    }
}

function Read-YtdSettings([string]$Path = (Join-Path (Get-YtdDataFolder) 'settings.json')) {
    $videos = [Environment]::GetFolderPath('MyVideos')
    if (-not $videos) { $videos = [IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), 'Videos') }
    $defaults = [pscustomobject]@{
        Folder  = [IO.Path]::Combine($videos, 'YouTube')
        Quality = 'Best available (MP4)'
        SkipSponsors = $true
        SkipPromos = $false
        SignIn = 'Not signed in'
        CookiesFile = ''
    }
    if (-not (Test-Path $Path)) { return $defaults }
    try {
        $s = Get-Content -Raw -Path $Path | ConvertFrom-Json
        if ($s.Folder) { $defaults.Folder = [string]$s.Folder }
        if ($s.Quality -and (Get-QualityNames) -contains $s.Quality) { $defaults.Quality = [string]$s.Quality }
        if ($null -ne $s.SkipSponsors) { $defaults.SkipSponsors = [bool]$s.SkipSponsors }
        if ($null -ne $s.SkipPromos) { $defaults.SkipPromos = [bool]$s.SkipPromos }
        if ($s.CookiesFile) { $defaults.CookiesFile = [string]$s.CookiesFile }
        if ($s.SignIn -and (Get-SignInNames) -contains $s.SignIn) { $defaults.SignIn = [string]$s.SignIn }
        if ((Get-SignInCode $defaults.SignIn) -eq 'file' -and -not $defaults.CookiesFile) { $defaults.SignIn = 'Not signed in' }
    } catch { }
    $defaults
}

function Save-YtdSettings($Settings, [string]$Path = (Join-Path (Get-YtdDataFolder) 'settings.json')) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $Settings | ConvertTo-Json | Set-Content -Path $Path -Encoding UTF8
}

Export-ModuleMember -Function *
