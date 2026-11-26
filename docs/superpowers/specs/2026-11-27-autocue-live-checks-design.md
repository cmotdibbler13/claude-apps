# Autocue Studio live take checks (design)

Agreed with Jon, 27 Nov 2026. Part of the Six Minutes Studio narration work (main spec: `2026-11-26-six-minutes-studio-design.md`, §6.3a).

## Why
Narration is one of Jon's four pain points. Nothing is checked until all the narration is in, and takes can **cut off the ends of lines**, which are slow to find, re-record and re-listen to. He records in his own voice in Autocue Studio (line mode), one take per line. Each take should be checked as soon as he stops it, and the result shown **where he is already looking, in Autocue Studio**, so he can redo the line straight away.

## Goals
- Every take saved in line mode is checked automatically in the background within a few seconds:
  - **cut-off ending**;
  - **word diff** against the line's text;
  - **long pauses**;
  - **clipping**;
  - **noise floor**.
- The result appears in Autocue Studio's status line, naming the line. For example: `05.2 ✓ OK`, or `05.2 flagged: last word "Skaill" cut off. Press ← to redo.` It also appears as a mark on the line itself when Jon steps back to it.
- No sound is ever played and nothing pops up. The mic is live.
- Results are saved beside the takes as small JSON files, so Six Minutes Studio can show a per-line list (ok / flagged / missing) in the film's review.
- Re-recording a line (the old take goes to `superseded\` as now) re-checks the new take and replaces its result.

## Non-goals (this build)
- Trimming, cleaning, fixing and joining takes into the voiceover. That is the next build, and the skill's "Processing his takes" steps 3, 4, 6 and 8 stay manual for now.
- The cloned voice (VoiceStudio).
- Pitch-jolt checks (cloned voice only, per the skill).
- Changing how takes are named, saved or superseded.

## Anti-goals
- Slowing down recording. Checking never blocks the UI or the next take.
- Any sound or modal dialog while recording.
- Changing or deleting a take. The checker only reads.
- Losing anything from the PC's current Autocue Studio (see Constraints).

## Constraints
- **The PC copy is the real one.** Autocue Studio runs from `C:\Users\Jon\desktop autocue` and has changes that are not in this repo's `autocue-studio/`. Among them is `server_backup.py` (7 Nov 2026, copies takes to `S:\Youtube video ideas\Autocue recordings\<project>\`), and possibly the 22 Nov permission-error fix. The repo copy must be brought up to date from the PC before this work lands, and installing must not overwrite the PC's extra files.
- Takes are `Recordings\<project>\<project>_<NN.s>.wav`, 44.1 kHz 16-bit mono. The newest take has the plain name, and earlier ones are in `superseded\`. `*.recording.tmp.wav` is in progress.
- Python on Jon's PC: Autocue Studio's own environment. The checks need **faster-whisper** (`medium.en`, int8, CPU, or CUDA if available) and **numpy**. Audio is decoded by ffmpeg to 16 kHz float32 (the skill: the bundled `av` breaks). ffmpeg is already on PATH (the Probe passed). The first run downloads the model (about 1.5 GB). Until the model is ready, the status says "Checks are getting ready (downloading the speech model)…" and recording works as normal.
- The thresholds are the skill's own (`voicestudio-narration` → Checks, and Own voice step 5):
  - **Cut-off ending:** the last voiced energy ends within 0.1 s of the end of the file, or, at 5 ms resolution, a drop of more than 18 dB in one frame from above -48 dB at the very end. The ending is also flagged when the transcript is missing the line's last word.
  - **Word diff:**
    - missing, extra or changed words against the line text;
    - ignore case, punctuation and number formatting (digits versus words);
    - ignore pronunciation notes (`>` lines);
    - transcripts can mishear in context, so the wording is "may have misread".
  - **Pause map:** any run quieter than -30 dB lasting 0.6 s or more between words. For own voice the skill only tightens stalls longer than about 0.6 s.
  - **Clipping:** any sample at full scale, or peaks above -0.3 dBFS.
  - **Noise floor:** the quietest 10 % of 50 ms frames is above about -55 dBFS.
- The Autocue Studio space bar, keys, Auto-next and Count-in behave exactly as now.

## Approaches considered
| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | The checks live in Autocue Studio (Python): checked on a background thread after each save, shown in its status line, results written as JSON beside the takes, and read by Six Minutes Studio | Simplest. Results appear where Jon looks, and one program owns the audio. Autocue Studio gains faster-whisper and a model download |
| B | Six Minutes Studio runs the checks, and Autocue Studio displays the result files | Two apps coordinating over files while recording, and nothing is checked if Studio isn't open |
| C | A separate checker service | A third thing to keep running, with no gain at this scale |

## Design

### In Autocue Studio
- A new module, `take_checks.py`, with no UI: `check_take(wav_path, line_text) -> dict`. It is pure apart from reading the file and running ffmpeg and whisper. It can also run on its own: `python take_checks.py <wav> "<line text>"` prints the JSON, which is useful for calibration.
- **Result shape:**
  ```
  {"id", "file", "checked_at", "ok": bool,
   "flags": [{"kind": "cut_off"|"misread"|"pause"|"clipping"|"noise", "text": "...", "at_s": float|null}],
   "transcript": "...", "duration_s", "peak_dbfs", "noise_dbfs", "version": 1}
  ```
- **After each line-mode save** (`_on_stop` → `_commit_take`), Autocue Studio queues `(line id, final path, line text)` to one background worker thread, which checks one take at a time.
  - When the check finishes, the worker writes `Recordings\<project>\checks\<project>_<id>.json` (temp file then rename) and posts the result to the UI thread with `after()`.
  - If the take was replaced before its check finished (the file's modification time changed), the stale result is dropped.
- **Status line.** On a result, show `<id> ✓ OK` (green), or `<id> flagged: <first flag>. Press ← to redo.` (brass), with the other flags as "+N more". It is shown even if Auto-next has already moved on, and stays until the next status message.
- **Line marks.** When a line is shown (`_show_line`), its saved check appears under the line: a ✓, or the flags in brass. A line with no check yet shows nothing. Recording a new take clears the mark until its check arrives.
- **"Check all" button.** In line mode, it checks every saved take that has no result, or whose result is older than its take (useful for takes made before this feature). It runs on the same worker.
- **No sounds, no dialogs.** Checker errors (model missing, ffmpeg failure) show once in the status line and are written into that take's JSON as `{"error": "..."}`. Recording carries on.

### In Six Minutes Studio
- **Narration section on the film's Review.** It finds the film's line script and project name: the line script path named in `part1_handover.md` (a `.txt` path containing "line"), or `C:\Users\Jon\desktop autocue\*<project>*line*.txt`, and the `# name:` inside it.
- It lists every line ID from the script with its status:
  - **missing** (no take yet);
  - **checking** (take newer than its result);
  - **ok**;
  - **flagged** (with the flag texts);
  - **error**.
- Counts appear at the top ("38 of 43 recorded · 35 ok · 3 flagged"). It refreshes every 10 s while the section is open (fs reads only).
- Read-only: no buttons that change takes. The takes folder path comes from settings, `autocueRecordings`, default `C:\Users\Jon\desktop autocue\Recordings`.

## Builder's calls (made by Claude; Jon may change them)
- **Voiced frame** (from the skill's trimming rule): a 10 ms frame louder than -24 dB with a zero-crossing rate below 0.12. **End of speech** is the last voiced frame, ignoring a broadband transient under about 40 ms after it (the Space-key click). Cut-off means the end of speech is within 0.1 s of the end of the file, or the 18 dB one-frame drop at the very end of the speech, or the line's last word missing from the transcript.
- **Severity:** `cut_off`, `misread` and `clipping` make a take **flagged** (`ok: false`). `pause` and `noise` are **notes**: shown, but the take stays ok, so a noisy room doesn't flag every line. Status-line order: cut-off, misread, clipping, then notes.
- **The pause threshold is 0.6 s on purpose** (own voice, per the skill's step 6). The skill's 0.3 s map is for the cloned voice.
- **Model:** `medium.en` by default, set in `autocue_settings.json` next to the app (`{"check_model": "medium.en", "check_device": "auto"}`). `auto` tries CUDA (his RTX 4060 Ti) and falls back to CPU int8. `small.en` is the fallback if checks are too slow.
- **Calibration** is done on the PC against takes Jon knows are good or bad, using `python take_checks.py <wav> "<text>"`. No recordings of his voice are committed. Unit tests use synthetic audio (tones and noise, with silence and an abrupt end) and a stubbed transcriber.
- **Install:** `faster-whisper` is added to `requirements.txt`, and `pip install -r requirements.txt` runs in the Python that runs Autocue Studio. ffmpeg is called as `ffmpeg` on PATH.

## Left to the builder
- The exact threading and queue in Tk.
- How the word diff aligns words (any reasonable sequence alignment).
- Number normalisation details.
- Where "Check all" sits in the recorder panel.
- Six Minutes Studio's narration section layout, following the existing review styles.
