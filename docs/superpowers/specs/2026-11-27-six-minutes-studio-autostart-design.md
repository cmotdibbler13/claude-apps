# Six Minutes Studio: start ComfyUI and Stable Audio when Studio opens (short design)

Status: approved by Jon, 2026-11-27.

## Why
Jon forgets to open ComfyUI / Stable Audio before a Probe or a job; he wants them loaded when Studio opens so jobs
never wait on a model loading.

## What
- When Studio opens (after `.studio-settings.json` is read), in parallel:
  - **ComfyUI**: if `<comfy.url>/system_stats` answers, leave it. Otherwise start the ComfyUI Desktop app:
    `comfy.exe` from settings, else the first that exists of
    `C:\Users\Jon\AppData\Local\Programs\@comfyorgcomfyui-electron\ComfyUI.exe`,
    `C:\Users\Jon\AppData\Local\Programs\ComfyUI\ComfyUI.exe`. Poll `/system_stats` until it answers (up to 4 min).
    Not found → state "missing" with "ComfyUI Desktop wasn't found. Set comfy.exe in .studio-settings.json."
  - **Stable Audio (Small SFX)**: the existing starter's `ensure` (same as the Start button). Music model loaded →
    left alone with the existing message.
- `"autostart": { "comfy": true, "stableAudio": true }` in settings, both on by default.
- Status shows on the Films page as one line ("ComfyUI: starting… · Stable Audio: ready") and in the tray tooltip.
- On exit (pagehide) Studio closes only what it started itself (Stable Audio already does this; ComfyUI the same).
- Probe: the ComfyUI and Stable Audio rows, when not running, offer **Start now** (the same starters).

## Approaches
Start everything at launch (picked by Jon) vs on Probe vs just in time. Launch the ComfyUI Desktop app (what Jon
uses; output dir already points at Comfy-Desktop) rather than a headless ComfyUI python.

## Calls I made
Close only what Studio started; autostart switchable per tool; the two exe locations above; 4-minute ComfyUI wait.

## Not included
Blender, Stem Remixer, the voiceover join (started per job already).
