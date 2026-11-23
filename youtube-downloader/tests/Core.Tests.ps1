$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here '..\YouTubeDownloader.Core.psm1') -Force

Describe 'Test-VideoUrl' {
    It 'accepts YouTube links in their usual forms' {
        Test-VideoUrl 'https://www.youtube.com/watch?v=jNQXAC9IVRw' | Should Be $true
        Test-VideoUrl 'https://youtu.be/jNQXAC9IVRw?si=abc' | Should Be $true
        Test-VideoUrl 'https://www.youtube.com/shorts/abc123' | Should Be $true
        Test-VideoUrl '  https://www.youtube.com/playlist?list=PL123  ' | Should Be $true
    }
    It 'rejects things that are not web links' {
        Test-VideoUrl '' | Should Be $false
        Test-VideoUrl 'hello there' | Should Be $false
        Test-VideoUrl 'C:\Videos\clip.mp4' | Should Be $false
        Test-VideoUrl 'ftp://example.com/x' | Should Be $false
        Test-VideoUrl 'https://localhost' | Should Be $false
    }
}

Describe 'Get-QualityCode' {
    It 'maps each menu entry to a code' {
        Get-QualityCode 'Best available (MP4)' | Should Be 'best'
        Get-QualityCode '720p (MP4)' | Should Be '720'
        Get-QualityCode 'Audio only (MP3)' | Should Be 'mp3'
    }
    It 'falls back to best for anything unknown' {
        Get-QualityCode 'nonsense' | Should Be 'best'
    }
}

Describe 'New-YtDlpArguments' {
    It 'downloads one video as an MP4, H.264 preferred, at the highest resolution' {
        $a = New-YtDlpArguments -Url ' https://youtu.be/x ' -Folder 'D:\Videos' -Quality 'best'
        ($a -join ' ') | Should Match '-S res,vcodec:h264,acodec:m4a --merge-output-format mp4'
        $a -contains '--no-playlist' | Should Be $true
        $a[$a.Count - 2] | Should Be '--'
        $a[$a.Count - 1] | Should Be 'https://youtu.be/x'
        $a[[array]::IndexOf($a, '-P') + 1] | Should Be 'D:\Videos'
    }
    It 'caps the resolution for a chosen quality' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -Quality '720'
        $a[[array]::IndexOf($a, '-S') + 1] | Should Be 'res:720,vcodec:h264,acodec:m4a'
    }
    It 'extracts MP3 for audio only' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -Quality 'mp3'
        ($a -join ' ') | Should Match '-x --audio-format mp3'
        $a -contains '--merge-output-format' | Should Be $false
    }
    It 'puts a playlist in its own numbered folder' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -Playlist
        $a -contains '--yes-playlist' | Should Be $true
        $a -contains '--no-playlist' | Should Be $false
        $a[[array]::IndexOf($a, '-o') + 1] | Should Match '^%\(playlist_title\|Playlist\)s/%\(playlist_index\)03d'
    }
    It 'points yt-dlp at FFmpeg and Deno in the tools folder' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -BinFolder 'C:\Tools'
        $a[[array]::IndexOf($a, '--ffmpeg-location') + 1] | Should Be 'C:\Tools'
        $a[[array]::IndexOf($a, '--js-runtimes') + 1] | Should Be ('deno:' + [IO.Path]::Combine('C:\Tools', 'deno.exe'))
    }
    It 'leaves SponsorBlock off unless asked' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V'
        $a -contains '--sponsorblock-remove' | Should Be $false
    }
    It 'cuts sponsor sections, and optionally self-promotion and subscribe reminders' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -SkipSponsors
        $a[[array]::IndexOf($a, '--sponsorblock-remove') + 1] | Should Be 'sponsor'
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -SkipSponsors -SkipPromos
        $a[[array]::IndexOf($a, '--sponsorblock-remove') + 1] | Should Be 'sponsor,selfpromo,interaction'
        [array]::IndexOf($a, '--sponsorblock-remove') -lt [array]::IndexOf($a, '--') | Should Be $true
    }
    It 'stops a link from being read as an option' {
        $a = New-YtDlpArguments -Url '--exec=calc' -Folder 'D:\V'
        $a[$a.Count - 2] | Should Be '--'
    }
}

Describe 'ConvertTo-CommandLine' {
    It 'leaves plain arguments alone' {
        ConvertTo-CommandLine @('-U', '--newline') | Should Be '-U --newline'
    }
    It 'quotes spaces and empty arguments' {
        ConvertTo-CommandLine @('C:\My Videos', '') | Should Be '"C:\My Videos" ""'
    }
    It 'escapes quotes and the backslashes before them' {
        ConvertTo-CommandLine @('say "hi"') | Should Be '"say \"hi\""'
        ConvertTo-CommandLine @('C:\dir with space\') | Should Be '"C:\dir with space\\"'
        ConvertTo-CommandLine @('a\"b c') | Should Be '"a\\\"b c"'
    }
}

Describe 'ConvertFrom-ToolLine' {
    It 'reads a progress line' {
        $l = ConvertFrom-ToolLine 'DL|  45.3%|   2.10MiB/s|00:12'
        $l.Kind | Should Be 'Progress'
        $l.Percent | Should Be 45.3
        $l.Speed | Should Be '2.10MiB/s'
        $l.Eta | Should Be '00:12'
    }
    It 'drops unknown speed and time' {
        $l = ConvertFrom-ToolLine 'DL|100.0%|Unknown B/s|N/A'
        $l.Percent | Should Be 100
        $l.Speed | Should Be ''
        $l.Eta | Should Be ''
    }
    It 'treats progress without a percent as progress' {
        (ConvertFrom-ToolLine 'DL|N/A|1MiB/s|N/A').Kind | Should Be 'Progress'
        (ConvertFrom-ToolLine 'DL|N/A|1MiB/s|N/A').Percent | Should Be $null
    }
    It 'reads the saved file' {
        $l = ConvertFrom-ToolLine 'FILE|C:\Videos\Me at the zoo [jNQXAC9IVRw].mp4'
        $l.Kind | Should Be 'File'
        $l.Path | Should Be 'C:\Videos\Me at the zoo [jNQXAC9IVRw].mp4'
    }
    It 'reads errors, warnings, playlist items and processing' {
        (ConvertFrom-ToolLine 'ERROR: [youtube] abc: Private video').Text | Should Be '[youtube] abc: Private video'
        (ConvertFrom-ToolLine 'ERROR: [youtube] abc: Private video').Kind | Should Be 'Error'
        (ConvertFrom-ToolLine 'WARNING: something').Kind | Should Be 'Warning'
        $i = ConvertFrom-ToolLine '[download] Downloading item 3 of 12'
        $i.Kind | Should Be 'Item'; $i.Item | Should Be 3; $i.Of | Should Be 12
        (ConvertFrom-ToolLine '[Merger] Merging formats into "x.mp4"').Kind | Should Be 'Processing'
        (ConvertFrom-ToolLine '[ExtractAudio] Destination: x.mp3').Kind | Should Be 'Processing'
        (ConvertFrom-ToolLine '[download] C:\x.mp4 has already been downloaded').Kind | Should Be 'Already'
        (ConvertFrom-ToolLine '[youtube] Extracting URL').Kind | Should Be 'Info'
        (ConvertFrom-ToolLine '[ModifyChapters] Removing chapters from x.mp4').Kind | Should Be 'Cutting'
        (ConvertFrom-ToolLine $null).Text | Should Be ''
    }
}

Describe 'SponsorBlock lines' {
    It 'reads how many sections SponsorBlock found' {
        $l = ConvertFrom-ToolLine '[SponsorBlock] Found 3 segments in the SponsorBlock database'
        $l.Kind | Should Be 'Sponsor'; $l.Segments | Should Be 3
        $l = ConvertFrom-ToolLine '[SponsorBlock] Found 1 segments in the SponsorBlock database'
        $l.Segments | Should Be 1
        $l = ConvertFrom-ToolLine '[SponsorBlock] No matching segments were found in the SponsorBlock database'
        $l.Kind | Should Be 'Sponsor'; $l.Segments | Should Be 0
        (ConvertFrom-ToolLine '[SponsorBlock] Fetching SponsorBlock segments').Kind | Should Be 'Info'
    }
}

Describe 'Get-FriendlyError' {
    It 'explains common YouTube errors in plain words' {
        Get-FriendlyError '[youtube] x: Private video. Sign in if you''ve been granted access' | Should Be 'This video is private.'
        Get-FriendlyError '[youtube] x: Sign in to confirm you''re not a bot' | Should Match 'signed in'
        Get-FriendlyError 'unable to download video data: HTTP Error 403: Forbidden' | Should Match 'Update tools'
    }
    It 'passes anything else through' {
        Get-FriendlyError 'something odd' | Should Be 'something odd'
    }
}

Describe 'Tools folder' {
    $bin = Join-Path $TestDrive 'bin'
    New-Item -ItemType Directory -Path $bin | Out-Null
    It 'lists all three tools as missing at first' {
        (Get-MissingTools $bin | ForEach-Object Name) -join ',' | Should Be 'yt-dlp,FFmpeg,Deno'
    }
    It 'lists only what is still missing' {
        'x' | Set-Content (Join-Path $bin 'yt-dlp.exe')
        'x' | Set-Content (Join-Path $bin 'deno.exe')
        (Get-MissingTools $bin | ForEach-Object Name) -join ',' | Should Be 'FFmpeg'
    }
    It 'wants a yt-dlp update after a week' {
        Set-YtDlpChecked $bin
        Test-YtDlpStale $bin -Now (Get-Date) | Should Be $false
        Test-YtDlpStale $bin -Now (Get-Date).AddDays(8) | Should Be $true
    }
    It 'every tool comes from a GitHub release over https' {
        foreach ($t in Get-ToolSources) { $t.Url | Should Match '^https://github\.com/[^/]+/[^/]+/releases/' }
    }
}

Describe 'Get-YtdLauncher' {
    It 'starts the app with no console window, and the taskbar relaunch command matches the shortcut' {
        $l = Get-YtdLauncher 'D:\Apps\youtube downloader'
        $l.Target | Should Match 'conhost\.exe$'
        $l.Arguments | Should Match '^--headless powershell\.exe -STA .*-File ".*youtube downloader.YouTubeDownloader\.ps1"$'
        $l.Command | Should Be ('"' + $l.Target + '" ' + $l.Arguments)
    }
    It 'has a fixed app ID for the taskbar' {
        Get-YtdAppId | Should Be 'SixMinutesOn.YouTubeDownloader'
    }
}

Describe 'App updates' {
    It 'reads the installed version, and counts a missing VERSION file as 0.0' {
        $d = Join-Path $TestDrive 'app'; New-Item -ItemType Directory $d | Out-Null
        Get-YtdVersion $d | Should Be '0.0'
        '1.5.0' | Set-Content (Join-Path $d 'VERSION')
        Get-YtdVersion $d | Should Be '1.5.0'
        'rubbish' | Set-Content (Join-Path $d 'VERSION')
        Get-YtdVersion $d | Should Be '0.0'
    }
    It 'compares versions as numbers, not text' {
        Test-YtdNewer '1.10.0' '1.9.0' | Should Be $true
        Test-YtdNewer '1.5.0' '1.5.0' | Should Be $false
        Test-YtdNewer '1.4.0' '1.5.0' | Should Be $false
        Test-YtdNewer '1.5.0' '0.0' | Should Be $true
        Test-YtdNewer '<html>' '1.5.0' | Should Be $false
    }
    It 'reads the updater result lines' {
        $l = ConvertFrom-ToolLine 'APPUPDATE|updated|1.6.0'
        $l.Kind | Should Be 'AppUpdate'; $l.Result | Should Be 'updated'; $l.Version | Should Be '1.6.0'
        (ConvertFrom-ToolLine 'APPUPDATE|current|1.5.0').Result | Should Be 'current'
    }
    It 'ships a VERSION file the updater can read' {
        ConvertTo-YtdVersion (Get-YtdVersion (Split-Path -Parent $PSScriptRoot)) | Should Not Be $null
        Get-YtdVersion (Split-Path -Parent $PSScriptRoot) | Should Not Be '0.0'
    }
    It 'keeps an update failure message as it is' {
        Get-FriendlyError 'The update failed: Could not reach GitHub' | Should Match '^The update failed'
    }
}

Describe 'YouTube sign-in' {
    It 'adds nothing when not signed in' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V'
        ($a -join ' ') | Should Not Match 'cookies'
    }
    It 'borrows the sign-in from Firefox' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -SignIn firefox
        $i = [array]::IndexOf($a, '--cookies-from-browser')
        $a[$i + 1] | Should Be 'firefox'
        $a[-1] | Should Be 'https://youtu.be/x'
    }
    It 'reads a cookies file' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -SignIn file -CookiesFile 'D:\My Files\cookies.txt'
        $i = [array]::IndexOf($a, '--cookies')
        $a[$i + 1] | Should Be 'D:\My Files\cookies.txt'
    }
    It 'ignores the cookies file choice when no file is set' {
        $a = New-YtDlpArguments -Url 'https://youtu.be/x' -Folder 'D:\V' -SignIn file
        ($a -join ' ') | Should Not Match 'cookies'
    }
    It 'maps the names shown in the window' {
        Get-SignInCode 'Firefox' | Should Be 'firefox'
        Get-SignInCode 'Cookies file' | Should Be 'file'
        Get-SignInCode 'Something else' | Should Be 'none'
    }
    It 'explains the sign-in errors' {
        Get-FriendlyError 'Sign in to confirm you''re not a bot. Use --cookies-from-browser' | Should Match 'YouTube sign-in'
        Get-FriendlyError 'could not find firefox cookies database in C:\Users' | Should Match 'Firefox'
        Get-FriendlyError 'The provided YouTube account cookies are no longer valid' | Should Match 'out of date'
        Get-FriendlyError 'This content isn''t available, try again later' | Should Match 'hour'
    }
}

Describe 'Settings' {
    It 'keeps the sign-in choice, and drops a cookies file choice with no file' {
        $f = Join-Path $TestDrive 'signin.json'
        (Read-YtdSettings $f).SignIn | Should Be 'Not signed in'
        Save-YtdSettings ([pscustomobject]@{ Folder = 'E:\C'; Quality = '720p (MP4)'; SignIn = 'Firefox'; CookiesFile = '' }) $f
        (Read-YtdSettings $f).SignIn | Should Be 'Firefox'
        Save-YtdSettings ([pscustomobject]@{ Folder = 'E:\C'; Quality = '720p (MP4)'; SignIn = 'Cookies file'; CookiesFile = '' }) $f
        (Read-YtdSettings $f).SignIn | Should Be 'Not signed in'
    }
    $file = Join-Path $TestDrive 'settings.json'
    It 'has defaults when nothing is saved' {
        $s = Read-YtdSettings $file
        $s.Quality | Should Be 'Best available (MP4)'
        $s.Folder | Should Match 'YouTube$'
    }
    It 'skips sponsors by default, but not self-promotion' {
        $s = Read-YtdSettings $file
        $s.SkipSponsors | Should Be $true
        $s.SkipPromos | Should Be $false
    }
    It 'saves and reads back every setting' {
        Save-YtdSettings ([pscustomobject]@{ Folder = 'E:\Clips'; Quality = '720p (MP4)'; SkipSponsors = $false; SkipPromos = $true }) $file
        $s = Read-YtdSettings $file
        $s.Folder | Should Be 'E:\Clips'
        $s.Quality | Should Be '720p (MP4)'
        $s.SkipSponsors | Should Be $false
        $s.SkipPromos | Should Be $true
    }
    It 'reads a settings file saved before SponsorBlock was added' {
        '{"Folder":"E:\\Old","Quality":"480p (MP4)"}' | Set-Content $file
        $s = Read-YtdSettings $file
        $s.Folder | Should Be 'E:\Old'
        $s.SkipSponsors | Should Be $true
    }
    It 'ignores a broken settings file' {
        'not json{' | Set-Content $file
        (Read-YtdSettings $file).Quality | Should Be 'Best available (MP4)'
    }
}
