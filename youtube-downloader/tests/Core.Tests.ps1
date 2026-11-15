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
        (ConvertFrom-ToolLine $null).Text | Should Be ''
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

Describe 'Settings' {
    $file = Join-Path $TestDrive 'settings.json'
    It 'has defaults when nothing is saved' {
        $s = Read-YtdSettings $file
        $s.Quality | Should Be 'Best available (MP4)'
        $s.Folder | Should Match 'YouTube$'
    }
    It 'saves and reads back the folder and quality' {
        Save-YtdSettings ([pscustomobject]@{ Folder = 'E:\Clips'; Quality = '720p (MP4)' }) $file
        $s = Read-YtdSettings $file
        $s.Folder | Should Be 'E:\Clips'
        $s.Quality | Should Be '720p (MP4)'
    }
    It 'ignores a broken settings file' {
        'not json{' | Set-Content $file
        (Read-YtdSettings $file).Quality | Should Be 'Best available (MP4)'
    }
}
