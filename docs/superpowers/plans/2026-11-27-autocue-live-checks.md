# Autocue Studio Live Take Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every line-mode take in Autocue Studio is checked in the background a few seconds after it is saved. The result shows in Autocue Studio's status line and on the line, is saved as JSON beside the takes, and is listed per line in Six Minutes Studio's review.

**Architecture:** A new module, `autocue-studio/take_checks.py`, does the pure analysis: decode with ffmpeg, frame energy and zero-crossing rate, end-of-speech, the flags, and a word diff against an injectable transcriber backed by faster-whisper. `autocue-studio/check_worker.py` is a single background worker. It writes results atomically and drops stale ones, and hands results to the UI through a callback. `app.py` wires it in: queue on save, status line, line marks, and a "Check all" button. Six Minutes Studio gains a read-only narration section in its review.

**Tech Stack:** Python 3 (Autocue Studio: customtkinter, numpy, faster-whisper), stdlib `unittest` (run with `python -m unittest discover -s tests` in `autocue-studio`), ffmpeg on PATH. Six Minutes Studio as before (ES modules, `npm test`).

**Spec:** `docs/superpowers/specs/2026-11-27-autocue-live-checks-design.md`

## Global Constraints
- Never change, move or delete a take, never play a sound, never open a dialog while recording. The checker only reads WAVs and writes `Recordings\<project>\checks\<project>_<id>.json` (temp file then `os.replace`).
- Recording, the Space bar, ←/→, Auto-next, Count-in and the server backup (`server_backup.py`) behave exactly as now. `server_backup` mirrors only `.wav` files, so the checks JSON stays local.
- The UI thread is never blocked. Checks run on one worker thread, one take at a time. Results reach Tk only through `self.after(0, …)`.
- Thresholds, from the spec's Builder's calls:
  - voiced frame = a 10 ms frame above -24 dBFS with a zero-crossing rate below 0.12;
  - end of speech = the last voiced frame, ignoring a broadband transient under 40 ms after it;
  - cut-off = end of speech within 0.1 s of the file's end, or a one-frame drop of more than 18 dB at 5 ms resolution from above -48 dB at the end of speech, or the line's last word missing from the transcript;
  - pause = a run quieter than -30 dBFS lasting 0.6 s or more between the first and last voiced frames;
  - clipping = any sample at full scale or a peak above -0.3 dBFS;
  - noise = the quietest 10 % of 50 ms frames above -55 dBFS.
- Severity: `cut_off`, `misread` and `clipping` set `ok: false`. `pause` and `noise` are notes (`ok` unaffected). Display order: cut_off, misread, clipping, pause, noise.
- Result JSON (version 1): `{"id","file","checked_at","take_mtime","ok","flags":[{"kind","text","at_s"}],"transcript","duration_s","peak_dbfs","noise_dbfs","version":1}`, or `{"id","file","checked_at","take_mtime","error","version":1}`.
- Copy, in Jon's style (British English, sentence case, no exclamation marks):
  - `<id> ✓ OK`;
  - `<id> flagged: <first flag text>. Press ← to redo.`, plus ` (+N more)` when there are more flags;
  - flag texts: `last word "<w>" cut off` / `ends too abruptly`; `may have misread: "<said>" for "<expected>"` / `may have missed "<w>"` / `may have added "<w>"`; `clipping: re-record a little quieter`; `pause of <x.x> s after "<w>"`; `room noise at <n> dBFS`;
  - `Checks are getting ready (downloading the speech model)…`;
  - `Checks unavailable: <reason>`.
- Settings: `autocue_settings.json` next to `app.py`, `{"check_model": "medium.en", "check_device": "auto"}`. Missing or bad JSON → defaults. `auto` tries CUDA, then CPU int8.
- No voice recordings in the repo. Tests use synthetic numpy audio and a stub transcriber.

## Review Focus
1. **A take replaced while its check runs:** the stale result must not overwrite the new take's result. Test: `test_check_worker.StaleResultDropped`.
2. **The Space-key click after the last word:** it must not be mistaken for speech running to the end. Test: `test_take_checks.ClickIgnored` (speech, then 0.5 s room tone, then a 20 ms broadband burst at the end → not cut off).
3. **Numbers spoken versus written:** "1854" read as "eighteen fifty-four" must not count as a misread. Test: `test_take_checks.NumberWordsMatch`.
4. **faster-whisper missing or the model download failing:** recording still works and the status says why. Test: `test_check_worker.TranscriberUnavailable` (an error JSON is written, the callback fires with the error, and the worker keeps going).
5. **Six Minutes Studio when the takes or checks folder doesn't exist yet:** it shows every line as missing, without crashing. Test: `narration.test.mjs › no recordings folder lists all lines missing`.

---

### Task 1: take_checks.py (analysis and word diff)
**Files:** Create `autocue-studio/take_checks.py`, `autocue-studio/tests/test_take_checks.py`, `autocue-studio/tests/__init__.py`.

**Interfaces (Produces):**
- `decode(path) -> (samples: np.ndarray float32 mono, rate=16000)` via ffmpeg (`-i path -ac 1 -ar 16000 -f f32le -`). `ffmpeg` missing → `CheckError("ffmpeg not found")`.
- `analyse(samples, rate) -> dict` with `duration_s, peak_dbfs, noise_dbfs, speech_end_s, flags` (the audio flags only: cut_off by energy, pause, clipping, noise). This needs a clipping view, so `decode` also returns the raw peak: `decode_with_peak(path) -> (samples, rate, peak_dbfs, clipped: bool)`, which reads the original sample format via ffmpeg `-f s16le` at its native rate for the peak.
- `normalise_words(text) -> list[str]`: lower case, strip punctuation, expand integers and years into words ("1854" → "eighteen fifty four", "2013" → "twenty thirteen", "47" → "forty seven", "1st" → "first"), and split hyphens.
- `word_flags(expected_text, transcript_words: list[(word, start, end)], audio_end_s) -> list[flag]`: aligns with `difflib.SequenceMatcher` over the normalised words and gives `misread`, `missed` and `added` as `misread` flags. When the expected last word is missing or ends within 0.1 s of `audio_end_s`, it gives a `cut_off` flag naming that word.
- `Transcriber` protocol: `transcribe(samples, rate) -> (text, words: list[(word, start_s, end_s)])`. `WhisperTranscriber(model, device)` loads faster-whisper lazily on first use, tries CUDA then CPU int8 when device is "auto", and raises `CheckError("Checks unavailable: …")` on an import or load failure.
- `check_take(path, line_text, transcriber) -> dict`: the result JSON body (without id/file/checked_at/take_mtime), with flags ordered and de-duplicated (at most one cut_off) and `ok` set by severity.
- CLI: `python take_checks.py <wav> "<line text>"` prints the JSON using `WhisperTranscriber` from settings.
- [ ] **Tests (synthetic audio built in the tests):**
  - `CleanEndOk`: speech-like signal (noise-modulated 200 Hz bursts above -24 dB), 0.4 s quiet tail → no cut_off.
  - `AbruptEndFlagged`: speech running to the last 30 ms → cut_off.
  - `ClickIgnored`: speech, 0.5 s room tone, then a 20 ms broadband burst → no cut_off.
  - `ClippingFlagged`.
  - `NoiseNote`: floor at -45 dBFS → noise note, ok stays true.
  - `PauseNote`: a 0.8 s gap → pause note at the right time.
  - `NumberWordsMatch`.
  - `MissedWordFlagged`.
  - `LastWordMissingIsCutOff`.
  - `OkSeverity`: notes only → ok true.
  - `FlagOrder`.
  - `DecodeMissingFfmpeg`: PATH stubbed → CheckError.
- [ ] RED → implement → GREEN (`cd autocue-studio && python -m unittest discover -s tests -v`) → commit `Autocue Studio: take checks module`.

### Task 2: check_worker.py and wiring into app.py
**Files:** Create `autocue-studio/check_worker.py`, `autocue-studio/tests/test_check_worker.py`. Modify `autocue-studio/app.py`, `requirements.txt` (add `faster-whisper>=1.0`), `README.md` (feature and settings), `.gitignore` if needed (`autocue_settings.json` is not committed; document the defaults).

**Interfaces:**
- `CheckWorker(transcriber_factory, on_result, now=time.time)`. It has `submit(job)` (job = `{id, path, line_text, checks_dir, project}`) and `stop()`. It runs one daemon thread with a queue. For each job it:
  1. records `take_mtime` (os.stat), runs `check_take`, and re-stats;
  2. if the mtime changed or the file is gone, drops the result silently;
  3. otherwise writes `checks_dir\<project>_<id>.json` (temp + `os.replace`) and calls `on_result(id, result)`.
  - Exceptions turn into an error result (written, and passed to `on_result`). The worker never dies.
  - The transcriber is created once, on the first job. While it loads it calls `on_result(None, {"status": "loading"})` once.
- `load_settings(app_dir) -> dict` with the defaults.
- `read_result(checks_dir, project, id) -> dict|None`.
- **app.py:**
  - Create the worker in `__init__`. `_on_stop`, after a successful line-mode commit, submits the job for that line, using the final path, the line text and `Recordings\<project>\checks`. Note that `_commit_take` may return the temp path on failure: submit only when the final path was committed.
  - `on_result` → `self.after(0, self._show_check, id, result)`.
  - `_show_check`:
    - sets the status line (green ✓ or brass flag text, per the copy constraint), unless recording or counting down. In that case it holds the message and shows it after the next stop;
    - refreshes the line mark if that line is showing.
  - `_show_line` reads `read_result` and shows a small mark label under the line text: `✓ checked`, or the flags joined by " · " in brass. Empty when there is no result, or when the result's `take_mtime` is older than the take.
  - Add a **Check all** secondary button in the recorder panel, visible in line mode. It submits every saved take whose result is missing or stale, and the status shows `Checking <n> takes…`.
  - The server-backup status suffix logic still works: a check result line is shown as-is. Don't break `_poll_backup` (it only appends to "Saved…" text).
  - `_on_close` stops the worker.
- [ ] **Tests:**
  - `ResultWrittenAndCallback`;
  - `StaleResultDropped` (the stub check_take touches the file mid-check);
  - `TranscriberUnavailable`;
  - `ErrorDoesNotStopWorker`;
  - `LoadingStatusOnce`;
  - `SettingsDefaults` (missing and bad JSON);
  - `ReadResult`.
  - App wiring isn't unit-tested (Tk). Keep the logic in `check_worker.py` and make `app.py` thin, with an `import app` smoke test skipped if customtkinter isn't installed.
- [ ] RED → implement → GREEN → commit `Autocue Studio: check takes in the background as they are saved`.

### Task 3: Six Minutes Studio narration section
**Files:** Create `six-minutes-studio/js/narration.js`, `six-minutes-studio/tests/narration.test.mjs`. Modify `js/settings.js` (`autocueRecordings` default `C:\Users\Jon\desktop autocue\Recordings`, `autocueDir` default `C:\Users\Jon\desktop autocue`), `js/ui/review.js`, `js/app.js`, `css/studio.css`.

**Interfaces:**
- `parseLineScript(text) -> {name|null, lines:[{id, section, text}]}`, a JS port of Autocue Studio's `parse_line_script`, including the `# name:` line, `##` sections, `[id]` starts, `>` notes and multi-line text.
- `findLineScript(host, filmDir, handoverText, settings) -> path|null`:
  - first, a path in the handover text ending `.txt` that contains "line" (case-insensitive; relative to the film folder or absolute);
  - then the first `*line*script*.txt` in the film folder or its `narration\` folder;
  - then in `settings.autocueDir`.
- `narrationStatus(host, settings, lineScript) -> {project, rows:[{id, section, text, status:"missing"|"checking"|"ok"|"flagged"|"error", flags:[text], notes:[text]}], counts:{total, recorded, ok, flagged}}`. A take is `Recordings\<project>\<project>_<id>.wav`, and a result is `Recordings\<project>\checks\<project>_<id>.json`. The status is `checking` when the take's mtime is newer than `take_mtime`. A missing folder means every line is missing.
- **Review:** a "Narration" section above B-roll with the counts line ("38 of 43 recorded · 35 ok · 3 flagged") and a compact list. Each row shows the id, the start of the line text, and a status chip (flagged in brass with its flag text). It refreshes every 10 s while the Review view is open (fs reads only). When no line script is found, it says "No line script found for this film. Name it in part1_handover.md." All text goes through `h()` / textContent.
- [ ] **Tests:**
  - parse parity (sections, notes, multi-line);
  - `findLineScript` order;
  - statuses for missing / ok / flagged / checking / error;
  - counts;
  - no recordings folder lists all lines missing.
- [ ] RED → implement → GREEN (`npm test`) → commit `feat(studio): narration line list from Autocue Studio checks`.

### Task 4: Publish, install and checklist (controller)
- Republish Six Minutes Studio (same URL).
- Add to `six-minutes-studio/docs/acceptance-slice1.md` a "Narration (own voice)" section:
  - install: the PC session copies the changed Autocue Studio files back and runs `pip install -r requirements.txt`;
  - record three lines, one with a deliberately cut ending → status line results, line marks, then the Studio narration list;
  - "Check all" on older takes;
  - calibration with the CLI against known good and bad takes.
- Give Jon the PC install prompt (copy back without deleting anything, then pip install). Update the PR with a comment.
