# Six Minutes Studio: voiceover join, score fit and mix preview (design)

Agreed with Jon, 27 Nov 2026. Build 2 of 3 after score/SFX (`2026-11-27-six-minutes-studio-score-sfx-design.md`); build 3 is the face-to-camera talking head. Main spec: `2026-11-26-six-minutes-studio-design.md`.

## Why
After the narration takes are checked and the score and sound effects are picked, Part 2 still needs a Claude session to:
- join the voiceover;
- fit the score to it;
- mix a preview so Jon can judge the fit.

The fit is the slow part. ElevenLabs lands the score's big moves 5–15 s off the estimated times, and the score is made before the voiceover exists. Jon wants the app to do this work, using **Stem Remixer**, his own app, to make the music fit. He keeps the final say by ear.

## Goals
1. **Join the voiceover** from his approved own-voice takes, following the narration skill's "Processing his takes" steps 3, 4, 6 and 8 and its "Levels and joining" section:
   - trim the head (keep 0.05 s before the first voiced frame) and the tail (cut 0.15 s after the last voiced frame, ignoring the Space-key click, with a 30 ms fade-out);
   - 80 Hz high-pass;
   - tighten mid-sentence stalls longer than 0.6 s down to 0.3 s;
   - sentences into clips with 0.55 s gaps, each part at about -13.5 dB RMS;
   - resample to 48 kHz;
   - clips at -13.8 dB RMS (±0.5 dB) with `alimiter=limit=0.84:level=false:attack=2:release=50`;
   - 0.6 s between clips in a section, 1.2 s between sections, a 0.5 s tail.

   Outputs:
   - `<project>_voiceover.wav`;
   - `<project>_voiceover_timings.csv` (clip, section, name, start_s, end_s, timecode);
   - a word-level transcript JSON (`sentence` field = line-script ids), for captions in Part 3.
2. **Fit the score.** Plan A, Jon's choice:
   - **Studio measures** the approved score take against the voiceover's section times in film time (voiceover + 6 s cold-open hold): loudness over time, beats, and the times of its big moves.
   - **Claude proposes a fit:** which stretches of the score to keep, repeat or skip, and small per-stretch tempo changes (within ±10 %), so the moves land on the section starts.
   - **Stem Remixer's engine renders the fit** through a new command-line entry point.
   - A **fit sheet** goes with it: each section's target time, where the move now lands, the edits and the tempo changes. Its wording says the character is inferred from measurements, to be checked by ear.
3. **Mix preview.** The fitted score is ducked under the voice:
   - sidechain `sidechaincompress=threshold=0.03:ratio=6:attack=40:release=600`;
   - gain by measurement, aiming for music 20–30 dB under the voice while he speaks and about -30 dBFS in the pauses, with a section ride where the score's loudness needs it;
   - 2.5 s fade-in and 5 s fade-out;
   - sound effects placed on the timeline at about -24 to -18 dBFS while he speaks, ducked with the music;
   - voice delayed 6 s (the cold-open hold);
   - a limiter with about -1.5 dB headroom.

   Studio plays it with a scrubber and the section marks. It also exports `<project>_mix_preview.mp3`, the mix WAV, a voice stem and a ducked-music stem.
4. **Hand-tweak in Stem Remixer.** An **Open in Stem Remixer** button opens the score with the fit's stretches saved as sections and the chain set. Jon fixes a join by ear and exports. Studio offers **Use this export** and remakes the mix from it.

## Non-goals (this build)
- The cloned voice (VoiceStudio). This build is own voice only.
- Writing `part2_handover.md` (a later build), the video render, captions and Part 3 work.
- Regenerating the score when it can't be fitted. Studio says so, and Jon makes a new take on the Score card.
- Splitting the score into stems for the mix. Possible later.

## Anti-goals
- Changing, moving or deleting his takes, the score takes or the sound-effect takes. Outputs are new files.
- A fit that sounds wrong but looks right: every edit sits on a detected beat with a crossfade, and Jon hears the result before anything is called approved.
- Spending credits. Nothing here is paid.
- Breaking Stem Remixer for normal use: the new entry point is additive, and its existing tests keep passing.

## Constraints
- **Where the work runs.** Everything runs on Jon's PC.
  - **Join:** Autocue Studio's Python (`C:\Users\Jon\desktop autocue`). It already has numpy, ffmpeg on PATH and faster-whisper (for the word transcript). It is a new command-line script beside `take_checks.py`, which reuses its voiced-frame code.
  - **Fit render:** Stem Remixer's `.venv` (numpy, soundfile, its `Mixer` and `Stretcher`), as a new `fit.py`.
  - **Measuring the score and the mix:** ffmpeg, run by Studio, plus numpy in one of those Pythons. The builder chooses which.
  - Studio starts each one with an argument list (no shell) and reads JSON back, as it does with Blender.
- **Where Stem Remixer is.** Its folder is a Studio setting, `stemRemixerDir`, with no default. Studio asks for it once, and Probe checks it (`.venv\Scripts\python.exe` and `mixer.py` exist).
- **What needs to be in place.**
  - **Takes:** every line in the line script has a take, and each take is `ok` or OK by Jon, or Jon has chosen to join anyway. A missing take blocks the join.
  - **Score and effects:** a Score take approved on the Score card. Sound effects are optional; the approved ones are used.
- **Files** go in `<film>\studio\voiceover\` and `<film>\studio\mix\`. Takes in the Autocue recordings folder are only read. The fitted score is `<film>\studio\mix\<project>_score_fitted.wav`. Stem Remixer's own `Stems\` folder is untouched unless Jon uses **Open in Stem Remixer**.
- **Long work** goes on the GPU lane:
  - join (whisper for the transcript);
  - fit render;
  - mix.

  Live jobs shows each one with progress. Re-running one makes new files with the old ones moved aside, never deleted.

## Approaches
| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Studio measures, Claude proposes the fit, Stem Remixer's engine renders it, and Jon can open it in Stem Remixer to tweak | The least of Jon's time, with the final say still by ear. Stem Remixer needs a command-line entry point, crossfades on the beat and per-section tempo |
| B | Jon fits it by hand in Stem Remixer; Studio shows where the moves land and picks up his export | The least to build, but every film costs him the listening and dragging |
| C | Studio fits it alone with ffmpeg crossfades | Throws away Stem Remixer and finds beats less well |

## Design (Claude's calls; Jon may change them)
- **Review screen:** a new **Voiceover and mix** section below Sound effects, with three steps in order. Each step shows its state and a button, and is ready only when the step before it is done.
  1. **Join voiceover**
     - Shows the line counts from the Narration list.
     - If any line is flagged and not OK by Jon, the button says **Join anyway (N flagged)** and lists the lines.
     - Done shows the length (e.g. 6:02 against the script estimate), ▶, and a list of stalls tightened (id and seconds) and anything it couldn't fix.
  2. **Fit score**
     - Needs an approved score take and a joined voiceover.
     - Shows the fit sheet as a small table (section, target, lands at, change) and ▶ for the fitted score.
     - **Fit again with a note** re-plans with Jon's note ("keep the swell at 2:35, shorten the middle instead").
     - **Open in Stem Remixer** and **Use this export** for hand tweaks.
  3. **Mix preview**
     - ▶ with a scrubber and the section marks, plus the exported files.
     - **Approve mix** records the approved voiceover, fit and mix in the film's state for the Part 2 handover.
- **Sound-effect timing.** Each sound-effect card gains a **Starts at** time in film time.
  - Claude proposes it from the cue's line in the handover, using the timings CSV once the voiceover is joined. Jon can type over it.
  - It defaults to the start of the line the cue belongs to. Loops run to the end of their section.
- **Fit plan format.** Claude returns `{steps:[{from_s, to_s, tempo}], notes}`.
  - `from_s`/`to_s` are times in the score take and are snapped to the nearest detected beat before rendering.
  - The steps are rendered in order with 30 ms equal-power crossfades on the beat, or 2.5 s crossfades in ambient stretches with no clear beat.
  - Studio checks the plan before rendering: the total length is within 0.5 s of the film length, and the tempos are within ±10 %.
- **Measuring.** Loudness in 0.1 s steps smoothed over 1.5 s, an onset/beat grid, and the big moves (rises and drops of 6 dB or more held for 2 s, and the final fade). One JSON per take, cached beside it.
- **Stem Remixer `fit.py`.** `fit.py <score> <plan.json> <out.wav>` loads the audio as one stem, renders the steps with the new per-step tempo and beat crossfades, and writes a 48 kHz WAV. It also prints JSON progress lines.
  - **Open in Stem Remixer** writes the plan's steps as that song's saved sections and chain (in the settings file Stem Remixer already keeps per song), then starts the app with the score's path.
  - Stem Remixer gains a matching option: an optional path argument to open a file on start.

## Left to the builder
- Which Python measures the score and runs the mix.
- The beat tracker: onset envelope plus autocorrelation in numpy is enough, and adds no new dependency.
- The ducking and ride values within the stated targets.
- The table and scrubber layout in the house style.
- The progress text.
