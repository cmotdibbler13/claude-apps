# Stem Remixer

A Windows desktop app that takes a song, splits it into its instruments, and lets you remix
them. Open a music file and each part (vocals, drums, bass and the rest, or six parts with
guitar and piano as well) gets its own lane. Mute, solo, rebalance and pan the parts while
the song plays, then export your mix.

The splitting is done on your own PC by [Demucs](https://github.com/adefossez/demucs), a free,
open-source model from Meta. Nothing is uploaded.

## Features

- **Split** a WAV, FLAC, MP3 or OGG into stems. Pick 4 stems, 6 stems (adds guitar and piano),
  or the slower best-quality 4-stem model. A progress bar shows how long is left; **Cancel**
  stops it.
- **One lane per stem**, each with a waveform, volume (0 to 150%), pan, **M** (mute) and
  **S** (solo: hear only that part).
- **Play / Pause** (or Space), **Stop**, and click or drag on any waveform to jump.
- **Tempo** from 50% to 150% without changing the pitch, and **Pitch** up or down by up to
  6 semitones without changing the tempo. Both work live and in the export.
- **Loop a section.** Hold Shift and drag across a waveform (or drag with the right mouse
  button) to mark a section; it plays round and round while you work on the mix. **Loop** (or
  the L key) turns it on and off. `[` and `]` move the section's start and end to the
  playhead, which is handy for trimming it by ear.
- **Save sections.** **+ Save section** keeps the marked section in the Sections row. A song
  can keep as many as you like; when they don't all fit, the row scrolls sideways (drag its
  scroll bar, or Shift and the mouse wheel over it). Click one to jump to it and loop it; the
  first nine also have their number keys, 1 to 9. Double-click to name it ("Chorus"),
  right-click to rename or delete it, or to set its tempo or crossfade. Saved sections show as
  thin bars along the top of the waveforms and are kept with the song. To change one, select
  it, adjust with `[` and `]` or a new drag, save that, and delete the old one.
- **Tempo per section.** Right-click a section and choose **Tempo…** to play it a little
  faster or slower than the rest, from 90% to 110% (100% plays it as it is). It works on top
  of the Tempo slider, and the pitch stays where it is. The section's button shows it, for
  example "Intro · 97 %".
- **Crossfades.** Right-click a section and choose **Crossfade…**: None, 30 ms or 2.5 s. In a
  chain, the section then fades into the one after it over that time, instead of the usual
  few-millisecond join. 30 ms suits a cut on a beat; 2.5 s suits a slow, ambient stretch. The
  button shows it, for example "Intro · 97 % · xf 30 ms".
- **Chain sections.** Type an order into the **Chain** box by section number, for example
  `1 2 2 3`, and press **Play chain** (or Enter). The sections play one after another, round
  and round, each at its own tempo and with its own crossfade, so you can rearrange the song.
  With ten or more sections, put spaces between the numbers (`1 12 3`). **Stop chain** goes
  back to normal play. With a chain playing, Export offers to save it once through, exactly
  as it plays.
- **Open a single file without splitting it.** Started with `--open` (below), the app opens
  the file as it is, as one lane called "score", with no split and no model download. It is
  kept in `Stems/<file> [single]/` like a split, so your sections and mix come back next
  time. If the file changes, the app notices and reads it again.
- **EQ per stem.** The **EQ** button on a lane opens Low, Mid and High controls (up to 12 dB
  up or down); **Flat** clears them. A change is heard a second or two after you let go of the
  slider, because the whole stem is reworked. The button lights up when a stem has EQ on it.
- **Level meters.** A bar beside each waveform shows how loud that part is in the mix, and one
  under Master shows the mix as a whole. They turn red when over full scale.
- **Master** volume, with a "too loud" warning if the mix is clipping.
- **Export mix** saves what you hear as a WAV or a 320 kbps MP3. With a section marked, it
  asks whether to save just that section (once through, ready to use as a sample) or the whole song. If the mix would distort, the
  export is turned down just enough and the status line says so.
- **Stems are kept.** Each song's stems are saved as WAVs in `Stems/<song> [model]/`, so
  opening the same song again is instant and brings back your last mix. **Show stems** opens
  the folder if you want the files for another program (an instrumental is just the vocals
  muted and exported). **Open stems folder** loads a folder split earlier, or any folder of
  equal-length WAVs.

## Opening a file from another program

Another program (Six Minutes Studio does this to let you adjust a score it has fitted) can
start the app with a file to open:

```
pythonw.exe main.py --open <file> [--plan <plan.json>] [--export-dir <folder>]
```

`--open` opens the file as a single lane, without splitting it. `--plan` also gives it a fit
plan, a JSON file of the form

```
{"steps": [{"from_s": 0.0, "to_s": 8.0, "tempo": 1.0, "xfade_s": 0.03}, ...]}
```

Each step is a stretch of the file in seconds, its tempo (0.9 to 1.1 makes sense) and its
crossfade into the next step. The plan's steps become saved sections, "Section 1", "Section 2"
and so on (a step used twice is one section, used twice in the chain), and the chain plays them
in order. They replace the sections and chain saved for that file, and the song's tempo,
pitch, master and loop go back to plain, so the chain sounds just as the plan renders it.
The chain is on when the window opens: press Play to hear it, adjust sections by ear, then
**Export mix** saves the chain once through. If the file or the plan can't be read, the app
says why and starts as normal. `--export-dir` makes **Export mix**'s Save dialog start in that
folder (Six Minutes Studio passes the film's own folder, so it can find the export). Anything
else on the command line is ignored.

If Stem Remixer is already open on the same score, close that window before opening it with
a plan. The app saves its mix when it closes, so an old window closed later would write its
old sections back over the plan's.

## Updating

Press **Update** in the top right of the window. If there is a newer version the button
says so (the app looks once each time it starts); pressing it downloads the new version
from this repository, replaces the app's files and restarts the app. Your stems, mixes
and the `.venv` folder are left alone. The version you have is in the window's title.

## Install

1. [Download the zip](https://github.com/cmotdibbler13/claude-apps/archive/refs/heads/claude/peaceful-davinci-h3btsz.zip),
   right-click it and choose **Extract All**. Move the `stem-remixer` folder somewhere
   permanent, for example `Documents\stem-remixer`.
2. In that folder, double-click **Install.cmd**. If Windows shows a "protected your PC" or
   security warning, choose **More info**, then **Run anyway** (or **Run**).
3. Wait for "Done". It downloads about 1 GB and takes 5 to 15 minutes.
4. Double-click **Stem Remixer** on the Desktop or in the Start menu.
5. To pin it, right-click **Stem Remixer** in the Start menu (or its taskbar button while it
   is open) and choose **Pin to taskbar**.

The installer needs no admin rights. It:

- finds Python, or installs Python 3.12 with `winget` if you have none;
- puts the app's parts in a `.venv` folder inside this folder, so nothing else on your PC changes;
- fetches the graphics card version of PyTorch if you have an NVIDIA card (a bigger download,
  about 2.5 GB; `.\Install.cmd -Cpu` in a terminal skips it);
- adds the two shortcuts.

If it stops part-way (for example the internet drops), run it again. To uninstall,
double-click **Uninstall.cmd**, then delete the folder.

The first split downloads the model (about 80 MB per model), once.

### By hand instead

With [Python](https://www.python.org/downloads/) 3.10 or newer, in this folder:

```
pip install -r requirements.txt
python main.py
```

## How long a split takes

On a normal PC without a suitable graphics card, expect a split to take about as long as half
the song (a 4-minute song in about 2 minutes). The best-quality model takes four times longer.

With an NVIDIA graphics card it should take seconds. The installer sets that up. If you
installed by hand, `pip` gives you the processor-only PyTorch; get the CUDA build with the
command from [pytorch.org/get-started](https://pytorch.org/get-started/locally/).

## Notes

- M4A, AAC and WMA files need [FFmpeg](https://ffmpeg.org/) installed and on your PATH. The
  other types work without it.
- Tempo and pitch changes are best kept modest. Up to about 20% either way (or 3 semitones)
  sounds clean on most music; further out, drums can start to flam and sustained notes to
  flutter. At 100% and 0 the audio is untouched.
- For the record-deck effect (faster and higher together), move both: for example Tempo 106%
  with Pitch +1.
- The split is a best guess by the model. Expect a little of one instrument to bleed into
  another stem, most often in "other" and in the guitar and piano stems.
- Each stem with EQ on it takes about another 85 MB of memory for a 4-minute song.
- A 4-minute song takes about 250 MB of memory while open, and its stems about 170 MB on disk
  (4 stems). Delete folders in `Stems/` you no longer want.
- Only split music you have the right to use. Remixes of other people's songs are theirs to
  license, not yours to publish.

## Changes

- **2026-11-27** (1.9.0): Each saved section can have its own tempo (90% to 110%) and a
  crossfade into the next section in a chain (none, 30 ms or 2.5 s), from its right-click
  menu. Its button shows them. A song can keep more than nine sections: the row scrolls, and
  keys 1 to 9 pick the first nine. `--open <file>` opens one file without splitting it, and
  `--plan <plan.json>` opens it with a fit plan as its sections and chain.

- **2026-11-22** (1.8.3): Update could say "you have the newest version" for up to five
  minutes after a new one came out, because GitHub served an old copy of the version number.
  The check now asks GitHub's API, which is always current. (Versions before 1.8.3 still
  have the delay: if Update finds nothing, try again five minutes later.)
- **2026-11-22** (1.8.1): The taskbar icon could still be Python's logo. Python from the
  Microsoft Store forces its own logo onto anything it runs, so the installer now uses the
  standard Python (installing it if needed) and rebuilds a `.venv` that was made with the
  Store one. The app says so on its status line if it is running on Store Python.
- **2026-11-22** (1.8.0): Chains of sections, EQ per stem, level meters, and an Update button.
  A pinned taskbar icon showed Python's logo: the installer now ties the shortcuts to the
  app's window. Run Install.cmd once more to get that, unpin the old icon and pin again.
- **2026-11-22**: Several saved sections per song, in a Sections row above the lanes.
- **2026-11-22**: Loop sections: mark a section on a waveform and it repeats. Exports can be
  just the marked section.
- **2026-11-22**: Splitting with a model that had not been downloaded yet failed with
  "'NoneType' object has no attribute 'write'" when the app was started from its shortcut.
  The download's progress bar had no console to print to; it now has somewhere to go.
- **2026-11-22**: Tempo now leaves the pitch alone (it replaces Speed, which changed both),
  and there is a separate Pitch control in semitones. Reset mix and Show stems moved to the
  top bar to make room.
- **2026-11-22**: Play failed with "Invalid number of channels [PaErrorCode -9998]" when the
  default Windows output would not open in stereo (for example a Bluetooth headset in call
  mode). Play now tries the same output in mono, then the output through Windows' other audio
  drivers, and says so when it is playing in mono.

## Files

```
stem-remixer/
├── Install.cmd        # double-click to install (runs Install.ps1)
├── Uninstall.cmd      # double-click to uninstall
├── Install.ps1        # the installer: Python, .venv, shortcuts
├── main.py            # entry point (and --open, --plan)
├── app.py             # the window (CustomTkinter)
├── mixer.py           # mixing engine, export, playback (sounddevice)
├── updater.py         # the Update button: fetches the newest version from GitHub
├── VERSION            # this version's number
├── separator.py       # runs Demucs, reads and writes the Stems folders
├── fit.py             # renders a fit plan for a score, exactly as the app plays it
├── measure.py         # measures a score (loudness, beats, rises and drops) for a fit
├── tests/             # pytest tests for the mixer and the Stems folders
├── requirements.txt
└── Stems/             # created on the first split
```

## Tests

```
pip install pytest
python -m pytest tests
```

## How it was checked

Built and tested in a Linux cloud session. It has not been run on Windows yet.

- The 48 unit tests pass: mixing, mute and solo, pan, tempo and pitch (length, pitch and beat
  spacing measured on test tones and clicks), looping, saved sections, chains, EQ, meters, the updater, export level, WAV and MP3 writing,
  saved mixes and the Stems folders.
- Real splits with the 4-stem and 6-stem Demucs models on a 30-second test track, including
  Cancel and an unreadable file.
- The window was opened on a virtual display and driven through opening stems, changing a mix,
  a full split with its progress bar, and saving and restoring a mix.
- The updater downloaded the real repository zip from GitHub into a scratch folder and
  replaced an older copy of the app there.
- **Not checked:** the installer. It is PowerShell for Windows and could not be run in the
  cloud session, so its first real run will be yours.
- **Not checked:** sound output. The cloud machine has no sound card, so Play has not been
  heard there, and the tempo and pitch changes have been measured but not listened to. The fallback between outputs is tested against a stand-in sound card.

Unofficial personal project. Not made, endorsed or supported by Anthropic or Meta.
