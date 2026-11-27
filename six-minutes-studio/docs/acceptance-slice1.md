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
- Pauses only ever add time; they never shorten anything. A whole-film gap change (every gap a bit shorter or longer) is a later one-number change.

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

## Voiceover and mix (version 6)
Before you start:
- **Stem Remixer 1.9.0.** Its Update button only looks at the `main` branch, so merge PR #4 first, then press **Update** in Stem Remixer. The window title should say 1.9.0.
- **The join script.** Copy these four files from the repo's `autocue-studio` folder into `C:\Users\Jon\desktop autocue`, replacing the old copies of the last two: `voiceover_join.py`, `line_script.py`, `take_checks.py`, `app.py`. Nothing else there changes. (Probe's "Autocue join" checks the first two are there.)
- **Where Stem Remixer is.** Add `"stemRemixerDir": "C:\\…\\stem-remixer"` (your Stem Remixer folder) to `S:\Youtube video ideas\.studio-settings.json`.

1. **Probe:** "Stem Remixer" and "Autocue join" pass.
2. On a film whose narration is all OK (or OK by Jon), press **Join voiceover**. Live jobs shows "Voiceover join". When done, play it and check: no clipped starts ("Six…", "First…"), no Space-key clicks, natural pauses. Long stalls tightened are listed.
3. Sound-effect cards now show **Starts at** times from the joined voiceover. Change one by typing; it stays as you typed it.
4. **Fit score** (needs an approved score take). The first fit of a 7-minute score can use about 3–4 GB of memory for a minute; if the PC struggles, tell me. Read the table: each section's target and where its move lands. A line suggests a new score take if a big move is still more than 5 s off.
5. **Mix preview.** Listen right through: music should sit well under your voice and not swell in the short gaps; sound effects should be in the background. If the music or effects are too loud or quiet overall, change `"mixMusicDb"` (default -26) or `"mixSfxDb"` (default -18) in `.studio-settings.json` and make the mix again.
6. **Open in Stem Remixer.** It opens the score as one track with Section 1, 2… in a chain. Play the chain: it should sound exactly like the fitted score. Change one section's tempo (right-click → Tempo…) and Export mix: the Save dialog should start in the film's `studio\mix\stem-remixer` folder. Back in Studio, **Use this export**: it re-measures and remakes the mix by itself.
7. **Approve mix.**
8. Re-record one line in Autocue Studio: Join, Fit and Mix all show **Out of date: run again**, and Approve is off until you re-run them.
9. Close Studio while Stem Remixer is open: tell me if Stem Remixer closes too.
10. With the timings CSV open in Excel, press **Join again**: it should say to close the file, and your earlier voiceover is still there.

## Pacing review (version 17)
Before you start: Probe → **Install join script** (the join script now takes pauses; Probe's "Autocue join" should pass afterwards). Placing pauses is one quick Claude call and costs nothing. You need a film with a joined voiceover and a mix.
1. **Install.** Open Probe and press **Install join script**. It says it's installed and "Autocue join" passes.
2. **The lines.** Under the Mix preview player, the script appears as rolling lines. Press play: the line being spoken is highlighted and the list follows it. Click a line's id (at its left): the player jumps there and plays from that line.
3. **Mark a pause by clicking.** Click a word in a line: a ‖ appears after it (Medium). Click the ‖: a small box opens with **Short / Medium / Long / ◀ / ▶ / Remove**. Try Long, then ◀ and ▶ (they move the mark one word), then **Remove**.
4. **Pause after a line.** Press the ＋ after a line: it adds a pause to the gap after that line. Click it to change or remove it.
5. **Notes.** Type a note in a line's **Note** box, for example "needs a breath after Pictish". Tick **Re-record** on a different line. The counts under the lines say how many pauses are marked and how many lines to re-record.
6. **Place pauses.** Press **Place pauses**. It reads only the new notes (one quick Claude call, free) and puts ‖ marks where they belong, or replies in plain words, for example "This sounds like a delivery change: tick Re-record". Your own marks are never moved.
7. **The real test, at about 2:00.** The line reads "Pictish village in Orkney. Pictish he was out…". Click the word after the second "Pictish" to put a pause there (Medium to start). Press **Apply pauses**. Live jobs shows the voiceover joining, then the score fitting, then the mix being made. When it finishes, play from that line: the second "Pictish" should now have a breath after it.
8. **Too tight?** If a mark sits where two words ran together in the recording, it shows **Tight cut: have a listen**. Listen. If it clicks, move it with ◀ / ▶ or make it Short and Apply again.
9. **Marks changed.** Change any mark after Apply. The Join voiceover step says **Pause marks changed: press Apply pauses.** Press it and it goes away.
10. **Sound effects.** Sound effects whose **Starts at** time you typed yourself move with the pauses, so they still land on the same word. Ones you never touched are re-timed from the new voiceover as before.
11. **Re-record clears itself.** The ticked line shows **Re-record** in the Review → Narration list. Record a new take in Autocue Studio: the tick and the **Re-record** label clear on their own once the newer take arrives.
12. **Stem Remixer export.** If the current score is a **Use this export** from Stem Remixer, press **Apply pauses**: it joins the voiceover, then stops and says it hasn't replaced your export. Open in Stem Remixer again to fit the longer voiceover. Your export is never overwritten.
13. **Nothing wasted.** With no marks changed and nothing out of date, Apply pauses says why it's off instead of re-running.
14. **Prompter bar (version 18).** Once a voiceover is joined, a bar sits at the top of the Review with ⏮ ❚❚ ⏭, the time, and the line being spoken. Scroll right down to B-roll: the bar stays. Pause, click a word in the bar (a ‖ appears there and in the list), type a note in the bar's box, then ▶ to carry on.
15. **Fold sections (version 18).** Each section heading (Narration, Score, Sound effects, Voiceover and mix, B-roll) has ▾. Press it: the section folds to its heading (▸). Close and reopen Studio: it stays folded. The bar still plays with Voiceover and mix folded.

## Tools start with Studio (version 20)
1. Close ComfyUI and Stable Audio (in Pinokio). Exit Studio from the tray and open it again.
2. The Films page shows **ComfyUI: Starting… · Stable Audio: Starting…** and, after a minute or two, **Ready** for both. The tray tooltip shows the same.
3. Run Probe: ComfyUI and Stable Audio pass without you opening them.
4. Exit Studio from the tray: ComfyUI and Stable Audio close (they were started by Studio). In Task Manager, no python.exe from ComfyUI or Pinokio is left behind. Open ComfyUI yourself, then open Studio: it says Ready and, on Exit, leaves your ComfyUI open.
5. If it says **ComfyUI: Not found**, add `"comfy": { "exe": "<path to ComfyUI.exe>" }` to `.studio-settings.json` (Probe then has **Start ComfyUI now**).
6. To stop either starting with Studio: `"autostart": { "comfy": false }` (or `"stableAudio": false`) in `.studio-settings.json`.

## Drawings that move (version 23)
Nothing here spends credits: Blender and ComfyUI run on the PC.
1. **Allow pictures.** The first time a 3D take runs, Studio asks to send pictures to Claude: allow it. (If you said no, the take fails with "Claude can't see pictures in this view yet. Allow pictures for Six Minutes Studio (reopen Studio, or its Permissions menu), then press Run again." A no stands until Studio is reopened, so press Run again only after allowing pictures. If it says "Claude couldn't take the drawing (…): it may be too large", save the drawing smaller and press Run again.)
2. **Make 3D on HF-01 (the stone dresser).** Approve HF-01, press **Make 3D in Blender**, then **Make first take** on the new card. Jobs shows **Modelling**, then **Check 1 of 3** (up to **Check 3 of 3**), then the render.
3. **The take.** When it's done, the card shows a small check still and a short list of notes ("Check 1 (fixed): …", "Check 2 (matched): …"; "(blank)" for an empty still, and "Check 3 (not applied): …" when the last check asked for a change the render didn't get) saying what each check changed. The MP4 opens on the drawing's view, then the dresser turns about 70° on its own centre so the far upright comes forward. The camera stays still; amber hand-drawn lines on black, no flat picture cards and no dots.
4. **Redo with a note.** Press **Redo…**, write e.g. "make the top slab thicker", **Redo with note**: a new take runs the same steps, starting from the last one.
5. **Remove this version.** On the 3D card press **Remove this version**: the card asks "Remove HF-nn from the review? Its takes stay on disk." Press **Remove**: the card goes, and HF-01 has **Make 3D in Blender** again. The take files are still in the film's media folder. (While a take runs, Remove is greyed out.)
6. **Animate with ComfyUI (set up once).** Until this is done the button is greyed out, and hovering it says "Set up the image-to-video workflow (see Probe)"; Probe's **Animate workflow** row says "Not set up (only needed for Animate with ComfyUI)" and what's missing.
   1. In ComfyUI open the templates (**Workflow → Browse Templates**) and pick the **LTX Video image-to-video** template. Load the models it asks for.
   2. **Workflow → Export (API)** and save it as `S:\Youtube video ideas\ComfyUI workflows\animate_i2v.json`.
   3. Open that JSON in Notepad and note the node ids (the `"12": {` numbers) of: the **LoadImage** node (its input `"image"`), the **positive prompt** text node (input `"text"`), and the **video save** node (input `"filename_prefix"`).
   4. Add them to `.studio-settings.json`, merged with what's already in `"comfy"`:
      `"comfy": { "i2v": { "nodes": { "image": ["<id>", "image"], "prompt": ["<id>", "text"], "output": ["<id>", "filename_prefix"], "seed": ["<id>", "seed"] } } }`
      Also add the **seed**: the sampler node's `"seed"` input (or `"noise_seed"` on a RandomNoise / SamplerCustomAdvanced template, e.g. `"seed": ["<id>", "noise_seed"]`). Without it every take re-uses the seed saved in the template, so Redo gives the same video; with it each take gets a fresh seed.
      If the template has **width**, **height** and **length** inputs (often on the image-to-video or empty-latent node, e.g. `"width": ["<id>", "width"], "height": ["<id>", "height"], "length": ["<id>", "length"]`), add those too: Studio then sets 1920×1088 (cropped to 1080p) and the clip length itself. Without them the template's own size is used and the take may not be 1080p. The LTX template counts length in frames, so with a length node also add `"lengthUnit": "frames"` beside `"nodes"` in `"i2v"`.
   5. Run Probe: **Animate workflow** says ready. Open the film's Review again: **Animate with ComfyUI** on HF-01 is live. Press it: an animated card appears after the drawing; **Make first take** renders it in ComfyUI. **Remove this version** works the same as for 3D.

## Jon on camera (version 25)
What costs credits: only **Make portraits** and **Make clip** / **Redo with note** on a clip, and only when you press them. Each shows its cost from Higgsfield first ("Make portraits (≈N credits)" is for both portraits of a press). If Higgsfield can't give a cost the button says "(cost unknown)": the first press only changes it to **Press again to spend credits**, the second press spends. Suggest lines, Suggest looks, uploading your photos and the clip audio, and the cost checks are free.

Before you start:
- **Your photos.** Put one or two photos of yourself (the office photo and the blazer frame from the trial) somewhere on the PC and add them to `S:\Youtube video ideas\.studio-settings.json`, merged with what's already there. In JSON each `\` in a path is written `\\`:
  ```json
  "presenter": { "photos": ["C:\\Users\\Jon\\Pictures\\Presenter\\jon_office.jpg", "C:\\Users\\Jon\\Pictures\\Presenter\\jon_blazer_frame.jpg"] }
  ```
  From PowerShell you can check the file still reads as JSON: `Get-Content "S:\Youtube video ideas\.studio-settings.json" -Raw | ConvertFrom-Json | Select-Object -ExpandProperty presenter`. It should list both paths.
- **The script skill.** Upload `skills\documentary-explainer-script\SKILL.md` from the repo to replace your documentary-explainer-script skill. New films then get `> to camera` under about five lines of the line script, and the handover lists them.

1. **Probe:** "Presenter photos" passes ("2 photos"). With a wrong path it says "Not found: …"; with none, "Add presenter.photos in .studio-settings.json".
2. **The lines.** Open a film's Review. **On camera** sits above the shots. A film whose line script has `> to camera` marks lists those lines, each "from the script", with its section and spoken length. An older film without marks shows **Suggest lines**: press it (free) and tick the ones you want ("suggested"). **Add a line** picks any other Narration line ("added by you"). Untick a line to drop it. A line over 15 s says "Too long for one clip: 15 s at most"; a line that has gone from the line script says "Not in the script any more" until you untick it.
3. **No b-roll on those lines.** A b-roll card on a to-camera line says **This line is on camera** with **Remove** (it asks first; its takes stay on disk). On a film with no shot list yet, Make shot list plans nothing on those lines.
4. **The look.** Press **Suggest looks** (free): three outfits and three sets for this film, with your last film's look offered first. Pick one of each, or type your own, and press **Use this look**.
5. **Portraits.** Press **Make portraits (≈N credits)**. Live jobs shows two Presenter portrait jobs. When they're done, press **Approve** under the one you like. Without photos the button is greyed out with "Add presenter photos (see Probe)".
6. **Clips.** Each line has a card below. Until a portrait is approved it says "Approve a portrait first"; until the voiceover is joined, "Join the voiceover first". Press **Make clip (≈N credits)**: the take saves as `studio\presenter\TC-01_t1.mp4`. Check his lips match your recording and the arms and elbows look natural. **Redo…** with a note, then **Approve**, as for other shots.
7. **A new portrait.** Approve the other portrait: finished clips say "Made with an earlier portrait". They stay as they are; redo them if you want.
8. **The voiceover changed.** Re-record a to-camera line (or put a pause inside it) and join again: its clip says "The voiceover for this line changed: redo to match, or Keep anyway" and counts in the film's waiting line. **Keep anyway** clears it. Then the other way round: change a different line (not a to-camera one) and join again: this clip shows no warning.
