# Slice 1 acceptance on the PC

Run these on the Windows PC, in the Claude desktop app, with one real film that is in Part 2. Note anything that fails under "Known setup" in README.md.

## Before you start
- Update the Claude desktop app.
- Open https://claude.ai/artifact/GjdgGKYjbtqZir2h37qYBY, choose **Install as app**, open it, and allow full access when asked.
- Have a film folder on `S:\Youtube video ideas\` with `handover\part1_handover.md` and its script `.md`.

## 1. Probe (spends nothing)
Open **Probe**, press **Run checks**. All should pass:
- S: root readable, UNC root readable
- Blender (from the path in `.studio-settings.json`, default `blender` on PATH) — version 2.9 or later
- ffmpeg and curl — must be `.exe` programs on PATH (a `.cmd`/`.bat` shim is refused)
- Higgsfield tools, Claude answers JSON

## 2. Films
- Your project folders are listed with the right part ticks and "No. 0nn".
- A Part 2 film shows **Open review**.

## 3. Shot list (one Claude call)
- Open the review, press **Make shot list**. Shots appear in script order as HF-01, HF-02…, each with a tool.

## 4. Higgsfield (spends credits: try one shot first)
- **Make first take** on one b-roll shot and one line-art shot.
- Each appears in **Live jobs** with an indeterminate bar, then lands on its card; a notification and tray icon appear.
- Look in `<film>\studio\media\`: the files are `HF-nn_t1.mp4` / `.png`, and the b-roll is a video (not a thumbnail).
- If anything looks wrong, copy the job's error text: the Higgsfield reply shapes haven't been seen yet.

## 5. Blender (local GPU)
- Approve a line-art shot; its Blender shot unlocks.
- **Make first take** on the Blender shot: Live jobs shows frame progress; the MP4 plays.
- Compare format, frame rate and transparency with your Norfolk Broads Blender output; record the settings to use in README.md.
- The script that ran is in `<film>\studio\blender\HF-nn_t1.py`.

## 6. Redo with a note
- **Redo…** on a clip with a short note. The new take appears beside the old; the history shows the note; the old file is still there.

## 7. Closing mid-job
- Start a Higgsfield take, close the app, reopen it: the job reconnects and finishes (no second charge).
- Start a Blender take, close the app, reopen it: it shows Interrupted with **Run again**.

## 8. Nothing written where it shouldn't be
- `voice files\` untouched.
- New files only inside `<film>\studio\`, plus `.studio-jobs.json` (and `.studio-settings.json` if you made one) in `S:\Youtube video ideas\`.

## Known limits in this version
- Pressing **Check again** many times quickly asks Higgsfield for the job's status each time (free, but more often than every 20 seconds).
- Blender runs Python that Claude writes, with full access to the PC.

## ComfyUI b-roll (version 2)
Have ComfyUI Desktop running, with `S:\Youtube video ideas\ComfyUI workflows\broll_ltx.json` in place. Nothing here spends credits.
1. **Probe:** the "ComfyUI" check passes and shows the ComfyUI version.
2. **Review:** tick **Prefer ComfyUI for b-roll** on a film. B-roll shots without takes switch to ComfyUI; line-art and Blender shots don't change. Untick it and they switch back.
3. On one b-roll card, use the **Higgsfield / ComfyUI** switch to choose ComfyUI, then **Make first take**. Live jobs shows it on the GPU queue with "about N min left"; it takes about 4 minutes.
4. The take lands as `<film>\studio\media\HF-nn_t1.mp4`: 1920×1080, no sound. ComfyUI's own copy is still in its `output\broll\` folder.
5. Start a ComfyUI take, close the app, reopen it: the job reconnects to the same render (no second render appears in ComfyUI's queue).
6. Start a ComfyUI take and a Blender take: they run one after the other, never together.
7. Quit ComfyUI and start a ComfyUI take: it fails at once with "ComfyUI isn't running at 127.0.0.1:8188…".

## Narration, own voice (version 4 + Autocue Studio take checks)
Install first: run the "install Autocue Studio take checks" prompt in a Claude Code session on the PC (it copies the new files into C:\Users\Jon\desktop autocue without deleting anything and runs pip install).
1. Start Autocue Studio and load a line script. The status line says "Checks are getting ready (downloading the speech model)…" the first time (about 1.5 GB), then later just "loading".
2. Record three lines normally. A few seconds after each stop: "<id> ✓ OK" in green.
3. Record one line and stop just before the last word finishes. Expect "<id> flagged: last word "…" cut off. Press ← to redo." Press ←, re-record it: the new take is checked and the mark under the line turns to ✓.
4. Record one line with a deliberate pause of over a second mid-sentence: still OK, with a muted note "pause of … s".
5. Press **Check all**: older takes from before this feature get checked; it says "All takes checked" when there's nothing left.
6. While Check all runs, record a line: listen back for clicks or dropouts.
7. Six Minutes Studio → the film's Review → **Narration** shows every line: Missing / Not checked / OK / Flagged, with counts.
8. Calibration: in the Autocue folder, run `python take_checks.py "Recordings\<project>\<take>.wav" "<line text>"` on two takes you know are good and one you know is cut off; send me the output if a good take is flagged.
If Autocue Studio ever closes by itself when checks start, set "check_device": "cpu" in autocue_settings.json.

## Make 3D in Blender (version 5)
1. On a film's Review, every line-art card without a Blender version has **Make 3D in Blender**. Line art that already has one (from the shot list) doesn't.
2. Press it: a new Blender card (the next HF number) appears right after the drawing, saying "Approve HF-nn first" until the drawing is approved. Then **Make first take** renders it as usual.

## Score and sound effects (version 5)
Have **Pinokio open** (the app starts Small SFX itself, but Pinokio must be running). Try the free parts first.
1. **Probe:** "Stable Audio" says Off (or Ready if Small SFX is already running). "ElevenLabs tools" passes.
2. On a film's Review, press **Plan music and sound effects**. A Score card and one card per sound effect appear. Read the score prompt: it should have an energy arc with times.
3. Press **Start Stable Audio**. The chip goes Starting… then Ready within about a minute, and Pinokio shows Small SFX running. If it says "Open Pinokio first", open Pinokio and press it again.
4. On a sound effect set to Stable Audio, press **Generate take · Free**. A take appears in a few seconds with its length and peak. Press ▶ to listen. It's saved as `<film>\studio\media\<project>_sfx_<cue>_t1.wav`, with the raw download beside it as `.orig.wav`.
5. Redo it with a note ("shorter, drier"): a new take appears beside the first. Pick one and Approve it.
6. Switch one cheap cue to **ElevenLabs** and press **Get the cost**. Check the number looks sensible (a few hundred credits at most for a short effect). Then press **Generate take · about N credits** once. Its job appears in Live jobs; when done, the take plays like the others.
7. Change that cue's prompt: the Generate button goes back to **Get the cost** (an old price is never used).
8. Score: **Get the cost** (about 6,000 credits per take for 6–7 minutes), then **Generate 2 takes · about N credits**. Both takes appear in a few minutes. Pick one and Approve it.
9. Close the app from the tray (Exit). Small SFX stops in Pinokio. If it keeps running, tell me: that's a known check for this version.
10. If an ElevenLabs take fails in Live jobs, there's **Check again** (free) and no Run again: a new take is made from its card, where the cost is shown.
