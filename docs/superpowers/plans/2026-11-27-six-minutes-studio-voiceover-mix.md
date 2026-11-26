# Voiceover join, score fit and mix preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From Jon's approved own-voice takes, the approved score and the approved sound effects, Studio joins the voiceover, fits the score with Stem Remixer's engine, and makes a mix preview he can play, tweak in Stem Remixer and approve.

**Architecture:** Three programs on Jon's PC, each doing what it already owns.
- **Autocue Studio's Python** joins the voiceover: a new `voiceover_join.py` that reuses `take_checks.py`.
- **Stem Remixer** gains:
  - per-section tempo and crossfades in its engine and UI;
  - a one-stem open;
  - `measure.py` (score analysis) and `fit.py` (renders a fit plan exactly as the app plays it).
- **Six Minutes Studio:**
  - runs these with argument lists on the GPU lane and reads JSON back;
  - plans the fit with one Claude call;
  - builds the mix with ffmpeg;
  - shows everything in a new "Voiceover and mix" section on Review.

**Tech Stack:**
- Python 3.10+, numpy, soundfile and faster-whisper (unittest), as already used.
- Plain ES modules with `node --test` and FakeHost.
- ffmpeg.

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-voiceover-mix-design.md`. The values quoted from the skills come from `voicestudio-narration` ("Processing his takes" and "Levels and joining") and `documentary-explainer-video` ("Music" → Mix).

## Global Constraints
- **Inputs are only read.** Takes, score takes and SFX takes are never changed, moved or deleted. Outputs go in `<film>\studio\voiceover\` and `<film>\studio\mix\`. Re-running a step moves its earlier outputs aside to `<name>.old-<timestamp>.<ext>`, never deleting them. Stem Remixer writes only in its own `Stems\` folder.
- **Join values, verbatim:**
  - **Head trim:** keep 0.05 s before the first voiced frame. A voiced frame is a 10 ms frame above -24 dBFS with a zero-crossing rate below 0.12.
  - **Tail trim:** cut 0.15 s after the last voiced frame, ignoring a broadband transient under about 40 ms after it, with a 30 ms fade-out.
  - **High-pass:** 80 Hz.
  - **Stalls:** a mid-sentence gap quieter than -30 dBFS longer than 0.6 s is shortened to 0.3 s.
  - **Levels:**
    - each sentence part at -13.5 dB RMS, with 0.55 s of silence between sentences in a clip;
    - then `alimiter=limit=0.84:level=false:attack=2:release=50`;
    - 48 kHz;
    - each clip within ±0.5 dB of -13.8 dB RMS (gain plus the same limiter).
  - **Spacing:** 0.6 s between clips in a section, 1.2 s between sections, and a 0.5 s tail.
- **Outputs:**
  - `<project>_voiceover.wav`;
  - `<project>_voiceover_timings.csv` with header `clip,section,name,start_s,end_s,timecode`;
  - `<project>_voiceover_transcript.json`, in which every word carries `sentence` = the line-script id.
- **Film time and length:** film time = voiceover time + 6.0 s (cold-open hold). Film length = voiceover length + 6.0 + `endCardS` (a setting, default 12).
- **Fit rules:**
  - tempo between 0.90 and 1.10;
  - cuts snapped to the nearest detected beat;
  - 30 ms equal-power crossfades on a beat, or 2.5 s in an ambient stretch;
  - the rendered length within 0.5 s of the film length.
  - If any big move lands more than 5 s from its target, Studio suggests a new score take and never forces one.
- **Mix values, verbatim:**
  - `sidechaincompress=threshold=0.03:ratio=6:attack=40:release=600` keyed by the voice;
  - music 20–30 dB under the voice while he speaks, and about -30 dBFS in the pauses;
  - a section ride with 3 s ramps;
  - 2.5 s fade-in and a 5 s fade-out ending at the film's end;
  - SFX at -24 to -18 dBFS while he speaks, ducked with the music;
  - a limiter, then about -1.5 dB of headroom after mp3 encoding.
- **No shell.** Every program is spawned with an argument list. Python programs print one JSON object per line on stdout: `{"progress":0..1,"text":"…"}` while running, and a final `{"done":true,…}` or `{"error":"…"}`.
- **Stem Remixer stays a normal app.** Its 35 existing tests keep passing. The new features work for any song and are in its README. `VERSION` becomes `1.9.0`.
- **No paid calls.** Nothing in this build spends credits.
- **Copy and commits:** British English and short sentences. No em dashes in new UI strings. No model identifiers in code or commits.

## Review Focus
1. **A take is missing, or the line script changed after the takes were recorded** (an id with no take, a take with no id). The join refuses on a missing take and names the ids. It ignores extra takes and reports them. Test in Task 1.
2. **Stem Remixer must play exactly what `fit.py` renders**, including when a section is used twice in a chain with different neighbours. Test in Tasks 3 and 5: render the chain through the app path (`render_chain`) and through `fit.py`, and assert the samples match.
3. **Jon re-runs the join after re-recording one line.** The old voiceover is moved aside, not overwritten, and a fit and mix made from the old voiceover show as "out of date" until they are re-run. Test in Task 7.
4. **A score with no clear beat** (an ambient stretch). The beat finder returns few beats, cuts still snap, and the long crossfade is used. Test in Tasks 4 and 6.
5. **Stem Remixer isn't set up** (no `stemRemixerDir`, or a folder without `.venv`). Fit and Open in Stem Remixer say exactly what to set, and the join and the mix still work. Test in Task 9.

---

### Task 1: Voiceover join core (`autocue-studio/voiceover_join.py`)

**Files:**
- Create: `autocue-studio/voiceover_join.py`
- Test: `autocue-studio/tests/test_voiceover_join.py`

**Interfaces:**
- Consumes:
  - `take_checks._frames`, `_frame_db`, `_zcr`, `_speech_end`, `_runs` (frame tools);
  - `app.parse_line_script` (or the same parser, if importing app pulls in Tk: then copy the parser into a small shared function and test both against the same script);
  - ffmpeg on PATH for decoding to 48 kHz float.
- Produces (pure numpy, `rate` = 48000):
  - `trim_take(x, rate) -> (y, info)` with `info = {head_s, tail_s}`.
  - `tighten_stalls(x, rate) -> (y, stalls)` with `stalls = [{at_s, from_s, to_s}]`.
  - `rms_db(x) -> float`; `set_rms(x, target_db) -> x`; `limit(x) -> x` (numpy equivalent of the alimiter values; the builder may run ffmpeg instead).
  - `build_clip(parts) -> x` joins sentence parts at -13.5 dB RMS with 0.55 s gaps.
  - `assemble(clips, sections) -> (x, timings)`:
    - `clips` are in script order;
    - spacing is 0.6 s, or 1.2 s across a section change, plus a 0.5 s tail;
    - `timings = [{clip, section, name, start_s, end_s}]`.
  - `plan_join(script_lines, take_files) -> {clips:[{clip:"05", section, ids:[…]}], missing:[ids], extra:[names]}`. Pure. The clip is the part of the id before the dot. Take files are matched by `<project>_<id>.wav`. `superseded\` and `*.recording.tmp.wav` are ignored.
- [ ] **Step 1: Write failing tests** (synthetic audio only: tones, noise and silence; no recordings).
  - **trim_take:** 0.5 s of -60 dB noise, then 1 s of a 200 Hz tone at -12 dB, then 0.3 s of noise, then a 20 ms full-band click. The head is kept to 0.05 s ±10 ms before the tone, and the tail ends 0.15 s ±10 ms after the tone with a fade (the last sample is near 0). The click is gone.
  - **tighten_stalls:** a tone, then 0.9 s of silence, then a tone becomes a 0.3 s ±10 ms gap with one stall reported. A 0.5 s gap is unchanged.
  - **build_clip:** two parts at different levels each measure -13.5 ±0.3 dB RMS before limiting, with a 0.55 s gap.
  - **assemble:** three clips in sections A, A, B give gaps of 0.6 then 1.2, a 0.5 s tail, and timings that add up.
  - **plan_join (Review Focus 1):** script ids `01.1 01.2 02.1` with takes for `01.1` and `02.1` give missing `["01.2"]`. A stray take `09.9` is reported as extra.
- [ ] **Step 2: Run** `cd autocue-studio && python3 -m unittest tests.test_voiceover_join -v`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then the whole suite (`python3 -m unittest discover -s tests`). Expect PASS, with 126 or more OK.
- [ ] **Step 5: Commit** `Autocue Studio: voiceover join core`.

### Task 2: Join command and transcript (`voiceover_join.py` CLI)

**Files:**
- Modify: `autocue-studio/voiceover_join.py`
- Modify: `autocue-studio/README.md` (a "Joining the voiceover" section)
- Test: `autocue-studio/tests/test_voiceover_join.py`

**Interfaces:**
- Consumes: Task 1, and `take_checks.WhisperTranscriber` (16 kHz input; a stub in tests).
- Produces:
  - **CLI:** `python voiceover_join.py --script <line script> --takes <dir> --out <dir> [--allow-flagged] [--model medium.en] [--device auto]`.
    - It refuses if any take is missing: `{"error":"Missing takes: 01.2, 03.4"}`, exit 2.
    - It moves existing outputs in `--out` aside (`.old-<YYYYmmdd-HHMMSS>`) before writing.
    - It writes the three output files named in Global Constraints. The project name is the line script's `# name:`.
    - It prints progress lines, then `{"done":true,"wav","csv","transcript","length_s","tightened":[{id,at_s,from_s,to_s}],"extra":[…],"clips":N}`.
  - `transcript_for(parts_with_offsets, transcriber) -> {"sentences":[{sentence,text,start,end}],"words":[{word,start,end,sentence}]}`. Each sentence part is transcribed on its own, and its word times are offset to voiceover time.
  - The CSV `name` is `<project>_<clip>`, and the timecode is `MM:SS.cc` of `start_s`.
- [ ] **Step 1: Write failing tests:**
  - CLI on a temporary folder with three synthetic takes and a stub transcriber (injected through a `--stub-transcriber` test hook or by calling `main(argv, transcriber=…)`): the three files exist, the CSV header matches exactly, the transcript words carry their sentence ids, and the last JSON line has `done:true`.
  - A missing take prints the error JSON and exits 2.
  - A second run moves the first outputs aside, and both sets exist.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement.** **Step 4: Run** the full suite. Expect PASS.
- [ ] **Step 5: Commit** `Autocue Studio: join command with timings and transcript`.

### Task 3: Stem Remixer engine: per-section tempo, crossfades, no section cap

**Files:**
- Modify: `stem-remixer/mixer.py`
- Test: `stem-remixer/tests/test_mixer.py`

**Interfaces:**
- Produces:
  - **A section** is `{"name","start","end","tempo":1.0,"xfade":0.0}`. `tempo` is clamped to MIN_TEMPO–MAX_TEMPO. `xfade` is the equal-power crossfade, in seconds, into whatever follows it in a chain (0 = today's 128-frame dip). Older saved sections without these keys load with the defaults.
  - **No cap.** `MAX_SECTIONS` is removed as a limit. A `NUMBER_KEYS = 9` constant is kept for the app.
  - **`render_chain()`:**
    - renders each step at its section's tempo (global pitch is kept, global tempo is multiplied in);
    - joins steps with an equal-power crossfade of the outgoing section's `xfade`;
    - total length = sum of the parts minus the overlaps.
  - **Live chain playback** uses the same per-section tempo and the same crossfade, so what plays matches `render_chain`.
  - **`chain_length_s() -> float`:** the length `render_chain` would produce.
- [ ] **Step 1: Write failing tests:**
  - A section saved with tempo 0.95 and xfade 0.03 round-trips through `settings()` and `apply_settings()`. An old dict without the keys gets 1.0 and 0.0.
  - Twelve sections can be saved.
  - **render_chain on a sine:** for a chain `[0, 1, 0]` with section 1 at tempo 1.05 and section 0 at xfade 0.03, the length equals `chain_length_s()` within 1 frame, and no sample exceeds 1.0.
  - **Review Focus 2:** live playback, collected block by block through `render_block` with the chain on and played once through, equals `render_chain()` within 1e-4 per sample (after aligning to the chain start).
  - The existing 35 tests pass unchanged.
- [ ] **Step 2: Run** `cd stem-remixer && python3 -m unittest discover -s tests -v`. Expect FAIL on the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `Stem Remixer: per-section tempo and crossfades, no section cap`.

### Task 4: Stem Remixer `measure.py` and `fit.py`

**Files:**
- Create: `stem-remixer/measure.py`, `stem-remixer/fit.py`
- Test: `stem-remixer/tests/test_measure.py`, `stem-remixer/tests/test_fit.py`

**Interfaces:**
- Consumes: Task 3's `Mixer` and `Stem` (one stem named "score"), and `soundfile`.
- Produces:
  - **`measure.py <audio>`** prints `{"done":true,"duration_s","loud":[dB per 0.1 s, smoothed over 1.5 s],"beats":[s…],"bpm":float|null,"moves":[{"t","kind":"rise"|"drop"|"fade","db"}]}`.
    - A rise or drop is a change of 6 dB or more in the smoothed loudness, held for 2 s. The fade is the start of the final decline to silence.
    - Beats come from an onset envelope plus autocorrelation in numpy.
    - `analyse(x, rate)` is the pure function behind it.
  - **`fit.py <score> <plan.json> <out.wav>`:**
    - the plan is `{"steps":[{"from_s","to_s","tempo","xfade_s"}]}`;
    - it builds sections from the steps (identical steps share a section) and a chain in step order, then renders with `render_chain`, resampled to 48 kHz;
    - it prints progress, then `{"done":true,"out","length_s"}`.
  - **`plan_to_sections(plan, rate) -> (sections, chain)`:** pure. It is shared with the app's open path in Task 5.
- [ ] **Step 1: Write failing tests:**
  - `analyse` on a 120 bpm click track finds a bpm within 2 % and beats within 20 ms.
  - On a pad that is quiet for 20 s, then 10 dB louder for 20 s, then a 5 s fade: one rise near 20 s ±1.5 s, and the fade near the end.
  - **Review Focus 4:** a steady sine with no onsets gives `beats == []` and `bpm` null, and no exception.
  - `plan_to_sections` dedupes repeated steps.
  - `fit.py` on a synthetic 30 s file with a 3-step plan writes a 48 kHz WAV whose length matches `chain_length_s` within 1 frame, and prints `done`.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement.** **Step 4: Run** the full suite. Expect PASS.
- [ ] **Step 5: Commit** `Stem Remixer: measure and fit commands`.

### Task 5: Stem Remixer app: section tempo and crossfade, one-stem open, `--open/--plan`, 1.9.0

**Files:**
- Modify: `stem-remixer/app.py`, `stem-remixer/main.py`, `stem-remixer/separator.py`, `stem-remixer/README.md`, `stem-remixer/VERSION`
- Test: `stem-remixer/tests/test_mixer.py` (or a new `test_single.py` for the non-Tk parts)

**Interfaces:**
- Consumes: Task 3 (sections) and Task 4 (`plan_to_sections`).
- Produces:
  - **Single-stem projects:** `separator.single_project(song_path, root) -> folder`. It creates `Stems\<song> [single]\` with `score.wav` (a copy of the file, converted to WAV) and `project.json` `{"stems":["score"], …}`, and reuses the folder if it already exists.
  - **`main.py --open <file> [--plan <plan.json>]`:** opens the file as a single-stem project, with no Demucs. With `--plan`, it writes the plan's sections and chain into that project's mix settings (replacing earlier ones) and starts with the chain on. The existing "Open" button is unchanged.
  - **Section UI:** right-clicking a section shows Tempo… (90–110 %) and Crossfade… (0, 30 ms, 2.5 s), next to Rename and Delete. A section with tempo or crossfade set shows it in its label (e.g. "Intro · 97 % · xf 30 ms").
  - **Sections beyond nine** are shown in a scrolling row. Keys 1–9 still select the first nine.
  - **README:** documents per-section tempo, crossfade, more than nine sections and `--open`. VERSION becomes `1.9.0`, with a Changes entry.
- [ ] **Step 1: Write failing tests** for the non-UI parts:
  - `single_project` on a temporary WAV creates the folder and `project.json`, and `read_project` accepts it. A second call reuses it.
  - Applying a plan to a fresh single project gives the same sections and chain as `plan_to_sections`.
  - **Review Focus 2 at app level:** `render_chain` after the `--plan` path equals the `fit.py` output samples within 1e-4.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement.** **Step 4: Run** the full suite. Also run `python3 -c "import ast,sys; ast.parse(open('app.py').read())"`, since the UI isn't covered by tests.
- [ ] **Step 5: Commit** `Stem Remixer 1.9.0: section tempo and crossfades, open a single file, open with a plan`.

### Task 6: Studio fit planning and fit sheet (`js/fitplan.js`)

**Files:**
- Create: `six-minutes-studio/js/fitplan.js`
- Test: `six-minutes-studio/tests/fitplan.test.mjs`

**Interfaces:**
- Consumes: `askJson`, the measure JSON from Task 4, and the timings rows from Task 2.
- Produces:
  - **`filmTargets(timings, endCardS) -> {filmS, sections:[{name, startS}]}`.** A section starts at its first clip's `start_s` + 6. `filmS` = the last `end_s` + 0.5 + 6 + endCardS.
  - **`planFit(host, {measure, targets, note, previous}) -> {steps, notes}`:**
    - one `askJson` call (tier "default"), which returns `{steps:[{from_s,to_s,tempo,xfade_s}], notes}`;
    - then `snapToBeats(steps, measure.beats)` (no-op when there are no beats);
    - `xfade_s` must be 0.03 or 2.5;
    - each tempo is clamped to 0.90–1.10;
    - the plan is rejected unless `renderedLength(steps)` is within 0.5 s of `filmS`.
  - **`renderedLength(steps) -> s`:** the sum of `(to_s - from_s) / tempo` minus the overlaps. It is the same formula as `chain_length_s`.
  - **`landing(steps, scoreS) -> filmS|null`:** maps a score time to film time through the plan (null if that part is cut).
  - **`fitSheet(steps, measure, targets) -> {rows:[{section, targetS, landsS, missS}], worstS, suggestNewTake}`:**
    - the move for each section is the first rise or drop within ±15 s of the target, mapped by `landing`;
    - `suggestNewTake` is true when `worstS > 5`.
- [ ] **Step 1: Write failing tests:**
  - `filmTargets` on a 3-clip timings table with endCardS 12.
  - `renderedLength` matches a hand calculation, including crossfades.
  - `snapToBeats` moves 10.04 to the beat at 10.0, and leaves values alone when there are no beats (Review Focus 4).
  - `planFit` with a stubbed Claude returning a plan 3 s too long rejects with a message. Tempo 1.2 is clamped to 1.10. The note is passed through.
  - `landing` on a plan that repeats a block maps a score time to its first use.
  - `fitSheet` gives `suggestNewTake` when a move misses by 6 s.
- [ ] **Step 2: Run** `cd six-minutes-studio && node --test tests/fitplan.test.mjs`. Expect FAIL. **Step 3: Implement.** **Step 4: Run** `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `Studio: plan the score fit and its sheet`.

### Task 7: Studio runners and mix state (`js/tools/voicejoin.js`, `js/tools/stemfit.js`, `js/tools/mixdown.js`, `js/mixplan.js`)

**Files:**
- Create: the four modules above
- Modify: `six-minutes-studio/js/settings.js`, adding `autocuePython: "python"`, `stemRemixerDir: null` and `endCardS: 12`
- Test: `tests/voicejoin.test.mjs`, `tests/stemfit.test.mjs`, `tests/mixdown.test.mjs`, `tests/mixplan.test.mjs`

**Interfaces:**
- Consumes: `runProcess`/`host.spawn`, `jobs`, `store`, Task 6, and `audioplan` approved items (`state.audio.score`, `state.audio.sfx[]` with `approved`, `chosen` and `startS`).
- Produces:
  - **The runner pattern** (all on lane "gpu"). Each spawns with an argument list, parses JSON lines into `ctx.progress`, and returns `{file, meta}`. `resume` throws `Interrupted; run it again.` (all three are free and local).
  - **`voicejoin`.** `input = {script, takes, out, allowFlagged}`. It spawns `settings.autocuePython` with `["<autocueDir>\\voiceover_join.py", "--script", …]` and `cwd` set to autocueDir. `meta = {wav, csv, transcript, lengthS, tightened, extra}`.
  - **`stemfit`.** `input = {score, plan, out, measureOnly}`.
    - `measureOnly` runs `<stemRemixerDir>\.venv\Scripts\python.exe measure.py <score>` and caches the JSON beside the score as `<score>.measure.json`.
    - Otherwise it writes `plan.json` in `<film>\studio\mix\` and runs `fit.py`.
    - With no `stemRemixerDir` it throws `Set where Stem Remixer is (stemRemixerDir in .studio-settings.json, or the Probe screen).`
  - **`mixdown`.** `input = {voice, music, sfx:[{file, startS, loop, endS}], filmS, out}`.
    - It builds one ffmpeg filtergraph from `mixGraph(...)`, a pure function exported and tested.
    - It writes `<project>_mix.wav`, `<project>_mix_preview.mp3`, `<project>_voice_stem.flac` and `<project>_music_stem.flac`.
  - **`musicRide(measureMusic, voiceRmsDb, timings) -> {baseDb, ride:[{t, db}]}`.** Pure. The music sits 24 dB under the voice RMS while he speaks (within the 20–30 dB band) and near -30 dBFS in the pauses, with ±9 dB at most and 3 s ramps.
  - **`mixplan.js` (state).**
    - `state.mix = {voiceover:{status, jobId, wav, csv, transcript, lengthS, tightened, extra, at}, fit:{status, jobId, plan, sheet, note, file, source:"app"|"stemremixer", fromVoiceoverAt, fromScoreTake}, mix:{status, jobId, files, approved, fromFitAt}}`.
    - **Actions:** `startJoin(ctx, {allowFlagged})`, `startFit(ctx, {note})` (measure if not cached, then `planFit`, then render), `startMix(ctx)`, `useStemRemixerExport(ctx, file)` (re-measure, recompute the sheet, `source:"stemremixer"`) and `approveMix(ctx)`.
    - **Staleness (Review Focus 3):** a fit is stale when `fromVoiceoverAt !== voiceover.at` or the approved score take changed. A mix is stale when its fit or voiceover changed. Stale steps show **Out of date: run again**.
  - **Mirroring jobs:** `watchJobs`/`applyJobs` mirror these jobs through `holders` with ids `VOICEOVER`, `FIT` and `MIX`; each holder has a one-element `takes` list for the current run. Extend `holders()` with these.
- [ ] **Step 1: Write failing tests:**
  - Each runner's args are exactly as above. JSON-line progress reaches `ctx.progress`. An `{"error"}` line becomes the error.
  - `stemfit` with no `stemRemixerDir` gives the exact message (Review Focus 5).
  - `mixGraph` contains the sidechaincompress string verbatim, `adelay=6000|6000` on the voice, a 2.5 s fade-in and a 5 s fade-out ending at `filmS`, and one `adelay` per SFX at `startS*1000`.
  - `musicRide` keeps the ride within ±9 dB and holds the 24 dB gap on synthetic loudness.
  - **mixplan:** a join, then a fit, then re-running the join marks the fit stale (Review Focus 3). `approveMix` is refused when the mix is stale.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement.** **Step 4: Run** `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `Studio: join, fit and mix runners and state`.

### Task 8: SFX start times (`js/audioplan.js`, `js/ui/audio.js`)

**Files:**
- Modify: `six-minutes-studio/js/audioplan.js`, `six-minutes-studio/js/ui/audio.js`, `six-minutes-studio/js/app.js`
- Test: `tests/audioplan.test.mjs`, `tests/viewmodel.test.mjs`

**Interfaces:**
- Produces:
  - **SFX items gain `startS` (film time, number or null) and `lineId` (line-script id or null).** `PLAN_INSTRUCTIONS` asks for `lineId` (the line the cue sits under, from the handover and line script). For films already planned, `lineId` is null.
  - **`proposeStarts(store, timingsRows, lineScript)`.** It sets `startS` = that line's clip `start_s` + 6, for cues with a `lineId` and no `startS` typed by Jon. Fields Jon edited (`startSBy: "jon"`) are never overwritten.
  - **The card** shows a **Starts at** box (`m:ss.s`), saved through `editItem` with `startSBy: "jon"`. A cue with no time shows "Not placed yet" and is left out of the mix, which lists it.
- [ ] **Step 1: Write failing tests:**
  - `proposeStarts` fills a cue from the timings and leaves a Jon-edited cue alone.
  - `editItem` accepts `startS` in `m:ss.s` and plain seconds.
  - The viewmodel shows "Not placed yet".
- [ ] **Step 2–4:** red, implement, green (`npm test`).
- [ ] **Step 5: Commit** `Studio: sound effect start times`.

### Task 9: Review "Voiceover and mix" section, Probe, Open in Stem Remixer

**Files:**
- Create: `six-minutes-studio/js/ui/mix.js` (`mixModel` and `mixSection`)
- Modify:
  - `js/ui/review.js`: the section goes below Sound effects;
  - `js/ui/probe.js`: "Stem Remixer" and "Autocue join" checks;
  - `js/app.js`: runners, actions, playback;
  - `css/studio.css`.
- Test: `tests/viewmodel.test.mjs`, `tests/probe.test.mjs`

**Interfaces:**
- Consumes: Tasks 6–8, `narrationStatus` (counts and flagged ids), `playTake`, `cardAction` and `userStarted`.
- Produces:
  - **The three steps** are as in the spec's Design section:
    - **Join:** "Join voiceover", or "Join anyway (N flagged)" listing the ids. It is refused with "Record these first: …" when any take is missing.
    - **Fit:** the sheet table, ▶, "Fit again with a note", "Open in Stem Remixer" and "Use this export".
    - **Mix:** ▶ with a scrubber and section marks, the file list and "Approve mix".
    - Locked steps say what they wait for. Stale steps say **Out of date: run again**.
  - **The suggestion line** when `suggestNewTake` is set: `A big move is still N s off. A new score take may fit better (Score card).`
  - **Open in Stem Remixer** spawns `<stemRemixerDir>\.venv\Scripts\pythonw.exe main.py --open <score take> --plan <plan.json>` with cwd set to stemRemixerDir, detached. It never waits.
  - **Use this export** lists the `.wav` and `.mp3` files in `<stemRemixerDir>` (where Stem Remixer exports by default; the builder checks `app.py` for its export folder) that are newer than the fit. It picks the newest, and Jon confirms it.
  - **Probe:** "Stem Remixer" passes when `.venv\Scripts\python.exe`, `fit.py` and `measure.py` exist. Otherwise it says `Set stemRemixerDir in .studio-settings.json to your Stem Remixer folder (1.9.0 or newer).` (Review Focus 5). "Autocue join" passes when `voiceover_join.py` exists in autocueDir.
- [ ] **Step 1: Write failing tests:**
  - mixModel: locked, ready, running, done and stale states for each step.
  - The flagged label and the missing-takes refusal.
  - The suggestion line.
  - The probe pass and fail texts.
- [ ] **Step 2–4:** red, implement, green. Check by eye with the Playwright stub page at 1280 px and 390 px (no sideways scroll).
- [ ] **Step 5: Commit** `Studio: voiceover and mix on Review`.

### Task 10: Checklist, publish, PR note (the controller does this)
- [ ] Add a "Voiceover and mix (version 6)" section to `six-minutes-studio/docs/acceptance-slice1.md`:
  1. Update Stem Remixer with its Update button; it should show 1.9.0.
  2. Copy `voiceover_join.py` into the Autocue folder.
  3. Probe passes.
  4. Join a film with all lines OK, and listen.
  5. Fit, and read the sheet.
  6. Mix preview, and listen.
  7. Open in Stem Remixer, move a cut, export, then Use this export.
  8. Approve the mix.
  9. Re-record one line and re-join; check that Fit and Mix show Out of date.
- [ ] Publish the artifact (same URL; capabilities unchanged).
- [ ] Push, and comment on PR #4.
