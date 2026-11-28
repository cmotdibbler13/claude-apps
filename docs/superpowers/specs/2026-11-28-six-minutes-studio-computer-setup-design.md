# Six Minutes Studio: setting up each computer

Status: draft for Jon's approval. Date: 2026-11-28.

## Why
Jon now runs Studio on two computers: the desktop (everything, including graphics) and a laptop for lighter work
(scripts and audio: Part 1, Autocue Studio recording, the mix). On the laptop the server is mapped as `N:` (and
`M:` for the shared folder), programs go on `D:` to save space on `C:`, and none of the PC tools are installed yet.
Studio today assumes the desktop: `S:\Youtube video ideas` first, then the network path; one settings file on the
server holding the desktop's tool paths; Autocue Studio at `C:\Users\Jon\desktop autocue`. Fixing the laptop by
editing that file would break the desktop.

This is the first of two pieces. The second (designed next) lets the laptop send heavy jobs (ComfyUI, Blender,
Stable Audio) to the desktop through a queue on the server (Jon picked approach A).

## What Jon gets
1. **Project folder, chosen per computer.** Probe's first row shows where Studio found the films and a **Choose…**
   with the folders it can see that hold films: each mapped drive's `Youtube video ideas` (S:, N:, M: …) and the
   network path. The choice is remembered on that computer. With no choice made, Studio looks in S:, then every
   other drive letter's `Youtube video ideas` folder, then the network path, as now.
2. **Tool settings per computer.** Each computer keeps its own tool paths and switches (Autocue Studio folder,
   recordings folder, Python, Blender, ffmpeg, ComfyUI, Stable Audio, Pinokio, Stem Remixer, autostart). Shared
   film settings stay shared (mix levels, models, end card and title hold, presenter photos, reference scripts,
   pronunciations file). The desktop keeps working with no change.
3. **Every failing Probe row says how to fix it**, with buttons:
   - **Choose where it is…**: Jon picks the program or folder; Studio checks it and saves it for this computer.
   - **Get it**: opens the official download page (ffmpeg, Blender, ComfyUI Desktop, Pinokio, Python).
   - **Install here…** for Jon's own apps from the claude-apps repo (Autocue Studio, Stem Remixer): Jon picks a
     folder (e.g. `D:\Apps`); Studio downloads the app into `<folder>\<App name>`, runs its installer where it has
     one, and saves the path. Never into an existing non-empty folder.
4. **This computer's role.** Probe has "This computer: Desktop (everything) / Laptop (scripts and audio)". On the
   laptop, the graphics rows (Blender, ComfyUI, Animate workflow, and Stable Audio) show as "On the desktop"
   instead of failing. (Sending those jobs to the desktop is piece two; until then the laptop's Make buttons for
   them say "Make this on the desktop".)

## Goals
- The laptop works for Part 1, recording and audio with only its own tools set up, without touching the desktop.
- Nobody edits `.studio-settings.json` by hand to set a computer up.
- The desktop behaves exactly as today after the update.

## Non-goals
- Sending jobs to the desktop (piece two).
- A Windows installer exe for Studio itself (Studio installs through the Claude desktop app).
- Installing third-party programs silently: Studio opens their download pages; Jon runs their installers.
- Setting up other people's computers (series name, house style and paths as settings come later, if wanted).

## Anti-goals
- A laptop change that alters the desktop's tool paths, or the other way round.
- Studio overwriting or deleting anything while installing.

## Approaches
- **Where the per-computer settings live.**
  - **A. A section per computer in the shared settings file on the server (picked, my call).** `.studio-settings.json`
    gains `computers: { "<COMPUTERNAME>": { role, root?, ...tool paths } }`; the values for this computer override the
    shared ones. One file to back up, and Jon can see both machines' settings in one place. The project folder
    choice can't live there (it says where that file is), so it is kept locally: in
    `%APPDATA%\Six Minutes Studio\computer.json` (`{ root }`) when Studio may write there, otherwise in the app's own
    browser storage (my call).
  - B. Everything per computer in the local file. Simple, but the desktop's settings would be split between the
    server file and a local file nobody sees, and a reinstall loses them.
- **Getting Jon's apps.** Download the `main` branch zip of the claude-apps repo from codeload.github.com (the
  repo is public; Stem Remixer's own updater does the same), unpack it with Windows' own `tar` into a temporary
  folder beside the target, keep only the app's folder, and move it into place. If the download or unpack fails,
  Probe says so and links to the repo page; nothing half-installed is left in the target.

## Details
- **Which settings are per computer (my call):** `role`, `autocueDir`, `autocueRecordings`, `autocuePython`,
  `blenderPath`, `stemRemixerDir`, `ffmpegPath` (new; default `ffmpeg`), `comfy.url`, `comfy.outputDir`, `comfy.exe`
  (if present), all of `stableAudio` (url, pterm, app, steps, cfg, pinokioExe, pinokioUrl) and `autostart`.
  Everything else stays shared, including `comfy.workflow` and its node map (they live under the project folder).
  A computer whose role is Laptop defaults to `autostart` off.
- **Paths into the project folder work on every computer (my call):** shared settings and saved state hold absolute
  paths such as `S:\Youtube video ideas\...` (reference scripts, presenter photos, the pronunciations file, film
  folders in saved jobs). When Studio reads one that starts with a known project-folder spelling (`S:\Youtube video
  ideas`, the network path, or any computer's chosen root in `computers`), it swaps that start for this computer's
  project folder. Stored values are never rewritten, so the desktop is unchanged.
- **First run on a new computer:** when `computers` has no entry for this computer but has one for another, Probe
  asks first "Is this computer the desktop (everything) or a laptop (scripts and audio)?" and saves the answer.
  With no `computers` entries at all (the desktop today), the role is Desktop and nothing is asked.
- **Graphics rows on a laptop** show "On the desktop" and a small **Set up here anyway** that brings back Choose
  and Get it, in case Jon ever wants one there.
- **Computer name:** from the `COMPUTERNAME` environment variable (read with a `cmd /c echo %COMPUTERNAME%` run, or
  `hostname`); upper case. Shown in Probe.
- **Existing desktop:** when `computers` has no entry for this computer, the shared values are used, so the desktop
  is unchanged. A choice made in Probe writes to `computers.<name>`; shared values are never rewritten by it.
- **Writes to `.studio-settings.json`:** read, change only `computers.<name>`, write with the never-overwrite
  helper (the old file is copied aside with a time stamp first, at most once a day is enough).
- **Role default:** "Desktop (everything)" until changed.
- **Root search with no choice:** S:, then drive letters D: to Z: holding `Youtube video ideas`, then the network
  path. A choice that later goes missing shows Probe's failing row with **Choose…**, and the Films page says
  "Can't reach the project folder you chose (<path>)".
- **Get it links** (official pages): ffmpeg (gyan.dev builds page), Blender (blender.org/download), ComfyUI Desktop
  (comfy.org/download), Pinokio (pinokio.computer), Python (python.org/downloads/windows).
- **Install here needs Python** for both apps: when the Python setting doesn't run, the button says "Set up Python
  first" with Get it for Python, and does nothing else.
- **Install here** for Autocue Studio: copy the `autocue-studio` folder, then `python -m pip install -r
  requirements.txt` with the chosen Python, then run Studio's existing Install join script into it. For Stem
  Remixer: copy the `stem-remixer` folder and run its `Install.cmd`. The paths saved: `autocueDir`,
  `autocueRecordings` = `<autocueDir>\Recordings`, `stemRemixerDir`.

## Constraints
- Studio stays the existing artifact; capabilities unchanged. No credits spent.
- Never overwrite or delete; earlier copies moved or copied aside.
- No secrets in files; no personal paths beyond the settings Jon chooses.

## Calls I made (Jon to check)
- Per-computer settings live in the shared file, under the computer's name; only the project folder choice is local.
- Stable Audio counts as heavy (it uses the graphics card), so it goes to the desktop with the graphics jobs.
- Studio opens download pages for third-party programs rather than downloading and running their installers.
- Paths into the project folder are re-based on reading, so S: paths saved by the desktop work from N: on the laptop.
- A new computer is asked whether it is the desktop or a laptop the first time Probe runs there.
- Install here takes Jon's apps from the `main` branch of the repo.

## Left to the builder
- Layout of the new Probe controls, within Studio's look.
- The exact check behind each "Choose where it is…" (reuse the existing Probe checks).
