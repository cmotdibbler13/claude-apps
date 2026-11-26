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
