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
├── china_clay_line_script.txt   # line script for re-recording China Clay
├── requirements.txt
└── Recordings/         # created automatically on first run
```

## Install

```
pip install -r requirements.txt
```

(Equivalent to `pip install customtkinter sounddevice numpy`. No compiler
needed — `sounddevice` ships prebuilt PortAudio binaries for Windows.)

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
