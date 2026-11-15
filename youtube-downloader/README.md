# YouTube Downloader

A small Windows app for saving a YouTube video to your PC so you can watch it offline.
Paste a link, pick a quality, press **Download**. You get an MP4 that plays in the Windows
Media Player / Films & TV app, or an MP3 if you only want the sound.

Pure PowerShell + WinForms, like the other apps here. Nothing to install by hand: on first use
it fetches three free, open-source tools into `%LOCALAPPDATA%\YouTubeDownloader\bin`
(about 270 MB to download, once):

| Tool | What it does | From |
|------|--------------|------|
| yt-dlp | does the downloading | [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| FFmpeg | joins picture and sound into one MP4, makes MP3s | [github.com/yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds) |
| Deno | runs YouTube's JavaScript, which yt-dlp now needs | [github.com/denoland/deno](https://github.com/denoland/deno) |

No admin rights are needed, and nothing is added to your PATH.

> **Use it fairly.** YouTube's terms only allow downloading where YouTube offers it. Stick to
> your own uploads, Creative Commons videos, or videos you have permission to keep. For anything
> else, YouTube Premium has official offline viewing.

## Setup

1. Download this folder (or clone the repo) somewhere permanent, for example `Documents\youtube-downloader`.
2. In that folder, right-click an empty space, choose **Open in Terminal**, and run:
   ```
   powershell -ExecutionPolicy Bypass -File Install-Shortcuts.ps1
   ```
   This adds **YouTube Downloader** to the Desktop and the Start menu. Remove both with
   `Install-Shortcuts.ps1 -Remove`.
3. Double-click **YouTube Downloader**.

If Windows says the files came from the internet and won't run them, run this once in the
same folder: `Get-ChildItem -Recurse | Unblock-File`.

## Using it

- **Video link**: paste a YouTube link (watch, youtu.be, Shorts or playlist). If you copied a
  YouTube link before opening the app, it is filled in for you.
- **Quality**: *Best available*, 1080p, 720p, 480p (all MP4), or *Audio only (MP3)*.
  The app prefers H.264 video because every Windows player can play it. YouTube only has
  H.264 up to 1080p, so *Best available* on a 4K video gives VP9 or AV1 inside the MP4. If
  your player won't open it, use [VLC](https://www.videolan.org/) or choose 1080p.
- **Whole playlist**: off by default, so a link copied from inside a playlist saves just that
  video. Turn it on to save every video, numbered in order, in a folder named after the playlist.
- **Save to**: defaults to `Videos\YouTube`. **Change...** picks another folder; the app remembers it.
- **Cancel** stops straight away. A half-finished `.part` file may be left; downloading the same
  video again carries on from where it stopped.
- **Play last download** opens the file in your default player. **Open folder** shows it in Explorer.

Files are named `Title [video id].mp4`. Downloading the same video twice doesn't download it again.

## When downloads stop working

YouTube changes its site often, and older yt-dlp versions stop working. The app checks for a new
yt-dlp once a week on its own. If a download fails with "HTTP 403" or similar, press
**Update tools** to fetch the newest yt-dlp, FFmpeg and Deno, then try again.

Some videos can't be downloaded at all: private, members-only, age-restricted (YouTube wants a
sign-in) or not yet premiered. The app says which in plain words.

## Files

| File | Purpose |
|------|---------|
| `YouTubeDownloader.ps1` | The window. Runs the tools in the background and shows their progress |
| `YouTubeDownloader.Core.psm1` | Helpers: yt-dlp command line, reading its output, running a tool without freezing the window, settings |
| `Setup-Tools.ps1` | Fetches the three tools (the app runs it; `-Update` fetches them all again) |
| `Install-Shortcuts.ps1` | Adds/removes the Desktop and Start menu shortcuts, draws `downloader.ico` |
| `tests\Core.Tests.ps1` | Pester tests for the helpers |

Settings are kept in `%LOCALAPPDATA%\YouTubeDownloader\settings.json`. To uninstall, run
`Install-Shortcuts.ps1 -Remove`, then delete this folder and `%LOCALAPPDATA%\YouTubeDownloader`.

## Tests

```
Invoke-Pester .\tests
```

Written for the Pester 3/4 that comes with Windows.

## How it was checked

Built and tested in a Linux cloud session, so the window itself hasn't been opened on Windows yet.
What was run there:

- The unit tests (27 passing) and PSScriptAnalyzer, including its check for Windows PowerShell 5.1 syntax.
- The window's own logic (job queue, progress, cancel, weekly update check, errors) driven with
  stand-in controls, running the real yt-dlp and FFmpeg against a test video with separate
  picture and sound streams, as YouTube serves them. The results were a playable H.264/AAC MP4,
  an MP3, a working cancel, and plain-English errors.
- `Setup-Tools.ps1` against the real GitHub downloads, which gave genuine Windows `yt-dlp.exe`,
  `ffmpeg.exe`, `ffprobe.exe` and `deno.exe`.
- A real YouTube link got through YouTube's checks. The video data itself wasn't downloaded
  there, because YouTube blocks that from cloud servers. Home connections aren't blocked.

Unofficial personal project. Not made, endorsed or supported by Anthropic or YouTube.
