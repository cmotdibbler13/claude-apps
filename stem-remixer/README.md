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
- **Speed** from 50% to 150%. It works like a record deck: slower is also lower in pitch.
- **Master** volume, with a "too loud" warning if the mix is clipping.
- **Export mix** saves what you hear as a WAV or a 320 kbps MP3. If the mix would distort, the
  export is turned down just enough and the status line says so.
- **Stems are kept.** Each song's stems are saved as WAVs in `Stems/<song> [model]/`, so
  opening the same song again is instant and brings back your last mix. **Show stems** opens
  the folder if you want the files for another program (an instrumental is just the vocals
  muted and exported). **Open stems folder** loads a folder split earlier, or any folder of
  equal-length WAVs.

## Install

Needs [Python](https://www.python.org/downloads/) 3.10 or newer. In this folder:

```
pip install -r requirements.txt
```

This is a big install (about 1 GB), because Demucs runs on PyTorch.

## Run

```
python main.py
```

The first split downloads the model (about 80 MB per model), once.

## How long a split takes

On a normal PC without a suitable graphics card, expect a split to take about as long as half
the song (a 4-minute song in about 2 minutes). The best-quality model takes four times longer.

With an NVIDIA graphics card it takes seconds, but `pip` installs the processor-only PyTorch on
Windows by default. To use the card, install the CUDA build of PyTorch using the command from
[pytorch.org/get-started](https://pytorch.org/get-started/locally/). The app uses the card
when PyTorch can see it.

## Notes

- M4A, AAC and WMA files need [FFmpeg](https://ffmpeg.org/) installed and on your PATH. The
  other types work without it.
- The split is a best guess by the model. Expect a little of one instrument to bleed into
  another stem, most often in "other" and in the guitar and piano stems.
- A 4-minute song takes about 250 MB of memory while open, and its stems about 170 MB on disk
  (4 stems). Delete folders in `Stems/` you no longer want.
- Only split music you have the right to use. Remixes of other people's songs are theirs to
  license, not yours to publish.

## Files

```
stem-remixer/
├── main.py            # entry point
├── app.py             # the window (CustomTkinter)
├── mixer.py           # mixing engine, export, playback (sounddevice)
├── separator.py       # runs Demucs, reads and writes the Stems folders
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

- The 15 unit tests pass: mixing, mute and solo, pan, speed, export level, WAV and MP3 writing,
  saved mixes and the Stems folders.
- Real splits with the 4-stem and 6-stem Demucs models on a 30-second test track, including
  Cancel and an unreadable file.
- The window was opened on a virtual display and driven through opening stems, changing a mix,
  a full split with its progress bar, and saving and restoring a mix.
- **Not checked:** sound output. The cloud machine has no sound card, so Play has not been
  heard. With no sound device the app shows a message instead of crashing.

Unofficial personal project. Not made, endorsed or supported by Anthropic or Meta.
