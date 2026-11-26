# Autocue Studio

A lightweight, local Windows desktop app for recording faceless video speeches:
a teleprompter on top, a voice recorder underneath.

## Features

- **Teleprompter** — paste your script, adjust font size (+/−) and scroll speed
  (10–150 px/s slider).
- **Recorder** — microphone picker, Record / Pause / Stop, live LED peak meter
  (bottom-right of the teleprompter), and a timer that only counts recorded
  time (pauses excluded).
- **Mic gain** — the slider controls the selected mic's Windows input level
  (via pycaw), so changes act before the signal can clip. With *Auto-trim on
  clipping* ticked, repeated clipping (4 clips within 3 s) steps the gain down
  5% at a time, never below 10%; the status line reports each trim. Shows
  "n/a" for virtual devices (Sound Mapper etc.).
- **Synchronized start** — pressing Record shows a 3-2-1 countdown, then the
  script scrolls smoothly while audio capture begins.
- **Line mode** — press **Load script** and pick a line script (see below).
  One line shows at a time with the next line in grey underneath. Each take is
  saved as `<name>_<id>.wav` in `Recordings/<name>/`; re-recording a line keeps
  the old take in `Recordings/<name>/superseded/`. Space = record / stop,
  ← → = previous / next line, *Count-in* sets 0–3 s, *Auto-next* moves on after
  each take, *Next missing* jumps to the next line with no take.
- **Local storage** — recordings are saved as 44.1 kHz 16-bit mono WAV files in
  the `Recordings` folder next to the app. The recent-recordings list lets you
  play (▶) or delete (🗑) each take.

## Take checks

In line mode every saved take is checked in the background a few seconds after
you press Stop. Nothing plays and nothing pops up; recording carries on as
normal while a check runs.

- **What's checked:** a cut-off ending (including the line's last word missing
  from the transcript), the words against the line's text ("may have
  misread"), pauses of 0.6 s or more, clipping and room noise. Cut-offs,
  misreads and clipping flag the take; pauses and noise are notes only.
- **Where it shows:** the status line names the line, e.g. `05.2 ✓ OK` or
  `05.2 flagged: last word "Skaill" cut off. Press ← to redo.` A result that
  arrives mid-take waits until you stop. Stepping back to a line shows its
  check under the text. **Check all** (beside *Folder*, line mode only) checks
  every take with no result, an out-of-date one or an error, e.g. takes made
  before this feature; it says "All takes checked" when there is nothing to do.
- **Results** are small JSON files in `Recordings/<name>/checks/` (they stay
  local; the server backup only copies `.wav` files).
- **Settings:** `autocue_settings.json` next to `app.py` (not committed).
  Missing or unreadable means the defaults:

  ```
  {"check_model": "medium.en", "check_device": "auto"}
  ```

  `auto` first test-runs CUDA in a separate process (once per session) and
  uses it only if that works, otherwise the CPU (int8). `small.en` is quicker
  if checks lag. If Autocue Studio closes by itself when checks start, set
  `"check_device": "cpu"` in `autocue_settings.json`.
- **First run** downloads the speech model (about 1.5 GB for `medium.en`); the
  status says "Checks are getting ready (downloading the speech model)…" until
  then. Later runs only load it from disk and say "Checks are getting ready
  (loading the speech model)…". Checks need `faster-whisper` (in `requirements.txt`) and `ffmpeg` on
  PATH; without them the status says "Checks unavailable: …" once and
  recording works as normal. Fix the cause, then press **Check all** to retry.
- **Using the GPU:** faster-whisper on Windows needs NVIDIA's cuBLAS and
  cuDNN 9 for CUDA 12, e.g. `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`,
  or Purfview's whisper-standalone DLLs on PATH. Without them checks run on the
  CPU (int8, using at most half the cores and at low priority), which is fine
  but slower; set `"check_model": "small.en"` if checks are too slow. The
  calibration command below prints the device it used (e.g. `Checked on cuda
  (float16)`).
- **Calibrating** against takes you know are good or bad:

  ```
  python take_checks.py "Recordings\china_clay\china_clay_05.2.wav" "The line's text."
  ```

  prints the result as JSON.

## Joining the voiceover

`voiceover_join.py` joins a film's takes into one voiceover. Six Minutes
Studio runs it for you, but it works on its own too:

```
python voiceover_join.py --script china_clay_line_script.txt --takes Recordings\china_clay --out <film>\studio\voiceover
```

- **Every line needs a take.** If any are missing it stops and names them,
  e.g. `Missing takes: 01.2, 03.4`. Takes that match no line are left out
  and listed as `extra`. Takes in `superseded\` are ignored.
- **Each take** is high-passed at 80 Hz and trimmed (0.05 s kept before the
  speech, 0.15 s after it, with a short fade). Pauses longer than 0.6 s are
  shortened to 0.3 s and listed as `tightened`, timed in the take.
- **Levels:** each line at -13.5 dB RMS, 0.55 s apart within a clip, then a
  limiter. Each clip ends up at -13.8 dB RMS. Clips are 0.6 s apart, 1.2 s
  across a section change, with 0.5 s of silence at the end.
- **A take with no speech found** stops the join and is listed as `silent`.
  `--allow-flagged` joins it anyway, as 0.5 s of silence (still listed).
- **It writes three files** in `--out`: `<name>_voiceover.wav` (48 kHz,
  24-bit), `<name>_voiceover_timings.csv` (one row per clip) and
  `<name>_voiceover_transcript.json` (every word with the id of its line).
  Files from an earlier run are renamed to `<name>.old-<date>-<time>.<ext>`,
  never deleted. The takes themselves are only read. If a file can't be
  replaced because it is open (say the CSV in Excel), the earlier files are
  put back and it says which one to close.
- **The transcript** uses the same speech model as the take checks
  (`autocue_settings.json`); `--model` and `--device` override it.
- **Output** is one JSON object per line: progress while it works, then a
  final line with `done` or `error`.

## Line-script format

```
# name: china_clay            file prefix for takes (otherwise the file name)
# any other comment           ignored
## 1 · Cold open              section heading shown above the lines that follow
[01.1]  (clip 01)             starts line 01.1 (text after the ] is ignored)
On a hill above St Austell…   the words to read (can run over several lines)
> St Austell = "Saint Ostul"  note shown in amber, not read
```

## Project structure

```
desktop autocue/
├── main.py             # entry point
├── app.py              # CustomTkinter UI (teleprompter + recorder dashboard)
├── audio_recorder.py   # sounddevice capture → WAV writer thread
├── take_checks.py      # checks one take (also a calibration CLI)
├── check_worker.py     # runs the checks on a background thread
├── line_script.py      # reads line scripts (no UI)
├── voiceover_join.py   # joins the takes into a voiceover (a CLI)
├── china_clay_line_script.txt   # line script for re-recording China Clay
├── requirements.txt
└── Recordings/         # created automatically on first run
```

## Install

```
pip install -r requirements.txt
```

(Equivalent to `pip install customtkinter sounddevice numpy pycaw
faster-whisper`. No compiler needed — `sounddevice` ships prebuilt PortAudio
binaries for Windows.)

## Run

```
python main.py
```

## Notes

- WAV was chosen over MP3 so recordings stay lossless for editing. To convert
  a take: `ffmpeg -i recording.wav -b:a 192k recording.mp3`.
- Windows lists the same mic through several host APIs; the dropdown
  de-duplicates by device name.

## Changes

- **2026-11-21** — Line mode: long script lines now wrap at the window edge on
  high-DPI displays (e.g. a Mac running Windows). The wrap width was in screen
  pixels but CustomTkinter scales it again, so on 200% scaling the text ran off
  the right-hand side.
- **2026-11-22** — Recording: if a mic refuses to open (e.g. "PaErrorCode
  -9999 … MME error 32" from a webcam mic), the recorder now tries the same mic
  through Windows' other audio drivers and in stereo (downmixed to mono). If
  all of those fail it shows a plain message naming the mic and what to try
  instead of the raw PortAudio error.
