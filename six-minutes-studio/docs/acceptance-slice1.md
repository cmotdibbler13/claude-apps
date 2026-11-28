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
- **Your photos.** Press **Choose presenter photos…** (in Probe, or beside Make portraits in On camera) and pick one or two pictures of you (PNG, JPEG or WebP), e.g. the office photo and the blazer frame from the trial. Studio copies them into `S:\Youtube video ideas\Presenter photos\` (a name already there gets `_2`; nothing is overwritten) and writes them into `.studio-settings.json` as `presenter.photos`, keeping everything else in that file. Choosing again replaces the list. If `.studio-settings.json` can't be read, Studio says so and leaves it alone.
- **The script skill.** Upload `skills\documentary-explainer-script\SKILL.md` from the repo to replace your documentary-explainer-script skill. New films then get `> to camera` under about five lines of the line script, and the handover lists them.

1. **Probe:** "Presenter photos" passes ("2 photos"). With a wrong path it says "Not found: …"; with none, "Add presenter.photos in .studio-settings.json". Below the checks, **Choose presenter photos…** saves new ones and runs Probe again.
2. **The lines.** Open a film's Review. **On camera** sits above the shots. A film whose line script has `> to camera` marks lists those lines, each "from the script", with its section and spoken length. An older film without marks shows **Suggest lines**: press it (free) and tick the ones you want ("suggested"). **Add a line** picks any other Narration line ("added by you"). Untick a line to drop it. A line over 15 s says "Too long for one clip: 15 s at most"; a line that has gone from the line script says "Not in the script any more" until you untick it.
3. **No b-roll on those lines.** A b-roll card on a to-camera line says **This line is on camera** with **Remove** (it asks first; its takes stay on disk). On a film with no shot list yet, Make shot list plans nothing on those lines.
4. **The look.** Press **Suggest looks** (free): three outfits and three sets for this film, with your last film's look offered first. Pick one of each, or type your own, and press **Use this look**.
5. **Portraits.** Press **Make portraits (≈N credits)**. Live jobs shows two Presenter portrait jobs. When they're done, press **Approve** under the one you like. Without photos the button is greyed out with "Add one or two photos of you first" and a **Choose presenter photos…** button beside it; once they are saved, Make portraits lights up.
6. **Clips.** Each line has a card below. Until a portrait is approved it says "Approve a portrait first"; until the voiceover is joined, "Join the voiceover first". Press **Make clip (≈N credits)**: the take saves as `studio\presenter\TC-01_t1.mp4`. Check his lips match your recording and the arms and elbows look natural. **Redo…** with a note, then **Approve**, as for other shots.
7. **A new portrait.** Approve the other portrait: finished clips say "Made with an earlier portrait". They stay as they are; redo them if you want.
8. **The voiceover changed.** Re-record a to-camera line (or put a pause inside it) and join again: its clip says "The voiceover for this line changed: redo to match, or Keep anyway" and counts in the film's waiting line. **Keep anyway** clears it. Then the other way round: change a different line (not a to-camera one) and join again: this clip shows no warning.

## Approve Part 2 (version 28)
Free: no credits. It copies files into the shared B-roll library and writes the Part 2 handover; it never deletes or overwrites anything (old catalogues are copied aside, an old contact sheet or handover is moved aside, each renamed with the date, e.g. `broll_catalogue_2026-11-27-1405.json`).

Before you press:
- **Probe:** the **B-roll library** row passes with e.g. "41 clips, next BR-042". If it fails it says why (e.g. "Couldn't read S:\Youtube video ideas\B-roll library\broll_catalogue.json: …" or "… isn't valid JSON"); fix that first, or Approve Part 2 stops at its first step with the same reason.
- **Nothing running:** let every job for this film finish (Live jobs). A press while one runs says "Wait for the running jobs to finish."

1. **The lock.** Open the film's Review. In the summary bar (beside Approved / Regenerating) **Approve Part 2** is greyed out with what's left beside it, e.g. "3 shots, the score and 2 sound effects still to approve" (hover the button for the same sentence). Approve the last thing it names: the sentence goes and the button lights up.
2. **Press and watch.** Press **Approve Part 2**. It reads **Approving…** and lists each step as it happens: "Reading the library", "Adding N clips", "Thumbnails and contact sheet", "Hand-off files", "Writing the handover". If something stops it, the reason shows under the button (e.g. "Missing file: …") and nothing has been written to the library or the handover.
3. **Done.** The bar says "Part 2 handed over 27 Nov 2026 14:05", any warnings as a short list (e.g. "The contact sheet was made without BR labels."), and the Part 3 opening message in a box: "Part 3 of Six minutes on… <Topic>. Load /documentary-explainer-video, read <film>\handover\part2_handover.md, and carry on." **Copy** puts it on the clipboard (if Windows refuses, the text is selected: press Ctrl+C). The button now reads **Write the handover again**.
4. **Check in Explorer:**
   - `S:\Youtube video ideas\B-roll library\clips\<slug>\`: one `<slug>_HF-nn.mp4` per approved b-roll, 3D and animated shot (no line art, no on-camera clips, no portrait).
   - `B-roll library\thumbs\BR-nnn.jpg` for each new clip, and `contact_sheets\<slug>.jpg` showing them with their BR labels.
   - `broll_catalogue.json` and `broll_catalogue.md`: the new rows at the end (in the MD under a `## <Film>` heading), the takes you didn't choose as "rejected" rows with your redo note; beside each catalogue the dated copy of the old one.
   - `<film>\handover\part2_handover.md`: every file with its real path, the BR ids beside the shots, your decisions, ending with the opening message.
   - `<film>\studio\handover\sfx_cues.json` and `mix_settings.json`.
   - Films shows Part 2 as done.
5. **Press again.** Press **Write the handover again**: the steps run, "Adding 0 clips"; the catalogues gain no rows and no new dated copies; no clip is copied twice; the old `part2_handover.md` is now `part2_handover_<date>.md` beside the new one (the same for `sfx_cues.json` and `mix_settings.json`).
6. **Changed since.** Un-approve a shot (or pick another take and approve it): the bar says "Changed since the Part 2 handover" (and the button locks again until it is approved). Approve it and press **Write the handover again** to bring the handover up to date.
7. **Part 3.** Open a new Claude Code session, paste the opening message and send it: it loads the video skill and reads the handover.

## Part 1 in Studio (version 30)
Free: Part 1 spends no credits and uses no Higgsfield tools. It writes the reading script, the line script and `part1_handover.md`; it never deletes or overwrites anything (an existing file is moved aside first, renamed with the date).

Before you start:
- **Probe**, press **Run checks**. Two new rows:
  - **Reference script** passes and shows the path of the first finished script from `referenceScripts` in `.studio-settings.json` that exists. If none is there it says "None of the referenceScripts in .studio-settings.json is there. Set referenceScripts to one or more finished scripts."
  - **Pronunciations** shows a warning (not a failure) until your first approval: "No pronunciations file yet: Studio starts one when you approve a Part 1." The file is `pronunciationsFile` in `.studio-settings.json`, or `pronunciations.md` in the Studio folder if that is not set.
- Make a test folder under `S:\Youtube video ideas\`, e.g. `Orkney test`. Have a brief for it saved as `.md` (or `.txt`).
- There is no Open Autocue Studio button. You open Autocue Studio yourself and use **Load script**.

1. **New film.** On Films press **New film**. Pick the Orkney test folder, or choose **New folder…** and type a name. Topic, file prefix (for example `orkney_test`) and episode are filled in for you; change any of them. Voice is Own voice (Cloned voice says "coming later" and can't be chosen). Runtime target starts at 6:00–6:45. The line under Voice shows where the takes will be saved.
2. **Brief.** With no brief in the folder it says "No .md or .txt brief in this folder yet. Add one." Press **Add a brief…** and pick a file; it is copied into the folder (for a new folder, when you press Create). With a brief there, it is in the Brief list.
3. **PDF message.** Press **Add a brief…** and pick a PDF. It is refused with "Save the brief as Markdown or text in the film's folder first." and nothing is copied. Save the brief as `.md` and add that instead.
4. **Prefix check.** Type a prefix with a capital or a space: a red message appears and **Create** stays greyed. Type one that another film (or a line script in the Autocue Studio folder) already uses: it says so. Put back a good one.
5. **Create.** Press **Create** (it reads **Creating…**). The film opens at Part 1 with **Write the script**.
6. **Write the script.** Press **Write the script**. It reads "Writing… (about a minute)" and the buttons lock. When it ends, the bar shows e.g. "6:12 est · 5:59 expected · 872 words · 27 clips · 7 sections", the sections with clip numbers, a visual cue in brackets under each clip, then Pronunciation notes, Sound effects, Shot list, To-camera lines and Build notes.
7. **Runtime and warnings.** Check the numbers against the brief. Warnings appear in a list (never a refusal): clips outside 26–29, words outside 825–925, a clip under 5 or over 50 words, sections other than 6–8, or an estimate outside the runtime target.
8. **Edit a clip.** Press **Edit** on a clip, change a word in Reading script, **Save**. The numbers update. **Cancel** leaves it as it was.
9. **Redo one clip.** Note down the text of three other clips. On one clip press **Redo with a note…**, type what to change, press **Redo**. Only that clip changes; the three you noted are exactly as before.
10. **Revise.** Press **Revise with a note…**, type a note for the whole script (e.g. "Open with the sea, not the date"), press **Revise**. A new draft appears and the draft label changes.
11. **Earlier drafts.** Press **Earlier drafts ▾**. Each draft is listed. Press **Go back to this draft** on an earlier one: the script returns to it. Go forward to the latest again.
12. **Pronunciations.** Under Pronunciation notes press **Edit or add**. Add a name and how to say it (e.g. Name `Scapa`, Say `SKAP-uh`), **Save**. Under To-camera lines tick or add a line with **Add a line**; the amber lines are the ones read to camera.
13. **Episode.** The episode number shows beside the Approve button. Press **Edit** to change it. With it blank, Approve Part 1 is greyed with "Add the episode number."
14. **Approve Part 1.** Press **Approve Part 1** (it reads **Approving…**). The tag "✓ Part 1 approved" appears with the next step: "Record every line in Autocue Studio (Load script → <prefix>_line_script.txt). Then open this film's Review in Studio for Part 2." Any warnings or problems are listed under it.
15. **Check in Explorer:**
   - `<film>\<prefix>_script.md`: the reading script, with the line `Voice: Jon, own voice (Autocue Studio → Recordings\<prefix>\)`.
   - `<film>\narration\<prefix>_line_script.txt`: starts `# <Title> — line-by-line recording script (N lines)` then `# name: <prefix>`; lines look like `[01.1]  (clip 01)`; your Scapa pronunciation shows as a `> Scapa = "SKAP-uh"` note; a picked to-camera line has `> to camera`.
   - `<film>\handover\part1_handover.md`: has `Episode: <NNN>` at the start of a line, your notes in your words, and the recordings folder.
   - The Autocue Studio folder (`autocueDir`, e.g. `C:\Users\Jon\desktop autocue`) has its own copy, `<prefix>_line_script.txt`. If that folder can't be reached, the app lists "Copy the line script to Autocue Studio's folder by hand: …".
   - The pronunciations file now exists with the Scapa row under the film's topic. Press **Run checks** in Probe again: the **Pronunciations** row now passes.
16. **Moved aside.** Make a second film in a folder (no `handover\part1_handover.md` yet, so it shows under New film) that already holds a `<prefix>_script.md` and `narration\<prefix>_line_script.txt` from earlier, and put a file called `<prefix>_line_script.txt` in the Autocue Studio folder too (use the same prefix for all three). Make that Autocue Studio file plain text with no `# name:` line, such as the word `old`: a real line script there marks the prefix as taken, and New film refuses it. Write and approve it. Each old file is still there with a dated name (e.g. `<prefix>_script_2026-11-27-1405.md`, `<prefix>_line_script_2026-11-27-1405.txt`) beside the new one; nothing was overwritten.
17. **Autocue Studio.** Open Autocue Studio yourself, press **Load script** and choose `<prefix>_line_script.txt`. The to-camera lines show amber with `to camera`, and the pronunciation notes show with their lines. Record or skip one line and check its take is named `<prefix>_<NN.s>.wav` in `Recordings\<prefix>\`.
18. **Review switches to Part 2.** Open the film's Review. It now works from Part 2 (shots, score, sound effects), not Part 1. Films shows Part 1 as done.
19. **Next time.** Start another film: the pronunciation you added is passed to Claude when it writes (look for your name spelled as you set it), and Probe's Reference script row still shows the same script.

## Two computers (version 31)
Studio can now run on a second computer (the laptop: Jon's server mapped as `N:`, programs on `D:`) with its own project folder and tool paths. Nothing here spends credits. Studio never overwrites or deletes your files: before its first write of the day to `.studio-settings.json` it keeps a dated copy beside it, and installs never go into a folder that already has files in it.

Known limits: after you switch the project folder in Probe, restart Studio before running jobs (the job list stays with the old folder until then). After you set or change this computer's role, restart Studio too: Probe says so, and it uses this role's job list from the next start. The desktop keeps its job list in `.studio-jobs.json` as before; a laptop keeps its own, `.studio-jobs-<computer name>.json`, so the two Studios never pick up or overwrite each other's jobs.

**A. Desktop first (nothing should have changed)**
1. Open Studio on the desktop and go to **Probe**, press **Run checks**. The first row is **This computer** (`<computer name> · Desktop (everything)`, with a **Change** button), then **Project folder** showing `S:\Youtube video ideas`. Every other row is as before. The desktop on `S:` is never asked its role (it is the desktop unless you change it), whatever entries the file has.
2. Films loads the films from `S:`, with no "New computer" line. There is no "Make this on the desktop" anywhere on the desktop: Review and Audio offer the same buttons as before.

**B. Laptop**
3. Open Studio on the laptop. Films shows "New computer: open Probe to set it up." above the list. Go to **Probe**: on its first run it asks "Is this computer the desktop (everything) or a laptop (scripts and audio)?" with two buttons. Press **Laptop (scripts and audio)**. Probe runs and the first row reads `<computer name> · Laptop (scripts and audio)`, with "Restart Studio: it uses this role's job list from the next start." under it. Close Studio and open it again: the "New computer" line has gone from Films and Autostart is off on a laptop. (This role save is the first change of the day to `.studio-settings.json`, so the dated copy in step 14 is made here. If the laptop was already on a folder other than `S:` when Studio opened, Studio records that folder for the laptop as it opens, and that is the first change instead.)
4. **Project folder.** If `S:` isn't there the row fails with "Can't read S:\Youtube video ideas: …" and a **Choose…** button. Press it: it lists every Youtube video ideas folder Studio can see, with the one in use marked "(in use)". Pick the one on `N:`. It says "Switching to …", Probe runs again and the row shows the `N:` folder. (A chosen folder that later can't be reached says "Can't reach the project folder you chose (…)".)
5. **Films load.** Films now lists the films from `N:`. Open one that was made on the desktop: a take recorded or saved with an `S:` path (or the `\\192.168.1.171\jon\…` path) still plays, because Studio swaps the start of the path for the `N:` folder.
6. **Graphics rows.** Blender, ComfyUI, Animate workflow and Stable Audio each show "On the desktop" (a neutral row, not a failure). Press **Set up here anyway** on one: the row is checked as normal for this session.
7. **Make this on the desktop.** Open a film's Review with a ComfyUI or Blender shot: the button reads "Make this on the desktop" and can't be pressed. On Audio, a Stable Audio sound effect or music item shows the same.
8. **ffmpeg, Get it.** If the ffmpeg row fails, press **Get it**. The ffmpeg builds page (`https://www.gyan.dev/ffmpeg/builds/`) opens in the browser.
9. **ffmpeg, Choose where it is.** Press **Choose where it is…**. Studio lists what it found as buttons and has a box "Or type the full path" (if it found nothing: "Studio didn't find it. Type where it is."). Pick or type the path to `ffmpeg.exe`: it says "Checking…", then "Saved <path>. Checking again…", and the row passes. A wrong path is refused with a reason and nothing is saved.
10. **Install here, Autocue Studio.** With Autocue join failing, Probe also shows a **Python for installs** row (fix buttons **Choose where it is…** and **Get it**, which opens `https://www.python.org/downloads/windows/`). Autocue Studio needs a Python that runs: with none, **Install here…** shows a greyed "Set up Python first" and **Get it**. With Python set up, press **Install here…** on the Autocue join row. It offers "Studio puts the app in its own folder inside this one:" with the folder box filled in as `D:\Apps` (`C:\Apps` if there is no `D:`). Press **Install**. The line under it shows Starting…, Downloading…, Unpacking…, Installing… and Done, then Probe runs again. Check `D:\Apps\Autocue Studio` exists with the app's files.
11. **Autocue join passes.** The **Autocue join** row passes ("Join script up to date"). The install put the join scripts in. If it shows the join is out of date, press **Install join script**.
12. (No step: once Autocue join passes there is no **Install here…** to press again. That Studio refuses to install into a folder that already has files in it, saying "…already has files in it. Choose another folder.", is covered by the tests.)
13. **Install here, Stem Remixer.** On the Stem Remixer row, press **Install here…**. It asks for the folder straight away (no Python step: Stem Remixer's installer sets up its own Python). Press **Install**: after Downloading… and Unpacking… it shows "Installing… (this can take a long while)". It can take a very long while, so leave it. When it is Done, Probe runs again and the Stem Remixer row passes.
14. **Settings file.** In the project folder open `.studio-settings.json`. It has a `computers` section with an entry for the laptop (its role, `root`, `autocueDir`, `autocueRecordings`, `autocuePython`, `stemRemixerDir` and `ffmpegPath` as you set them). Everything else in the file is as it was. Beside it there is a dated copy, `.studio-settings_<date>-<time>.json`, made at the first settings change of the day (the role save in step 3, or recording the laptop's folder as Studio opened), before anything was written: open it and check it is the file as it was before.

**C. Desktop afterwards**
15. Go back to the desktop and open Studio. It is not asked its role (it is on `S:`), Films has no "New computer" line, and Probe, Films, Review and Audio work as in section A. The desktop has none of the laptop's paths, the graphics tools are not marked "On the desktop", and its job list is still `.studio-jobs.json` (the laptop's jobs are not in it). A take saved on the laptop with an `N:` path plays here, because the laptop's folder is recorded in its `computers` entry.

## Desktop jobs (version 36)
The laptop can now send ComfyUI, Stable Audio and Blender jobs to the desktop, which makes them and hands the result back. Nothing here spends credits. Both computers need Studio open for this to work, and both need the project folder on the server (`S:` on the desktop, `N:` on the laptop). Nothing is ever deleted: finished request files are moved, not removed.

Before you start: update Studio on both computers, then close and reopen Studio on each. Do this again after you change either computer's role in Probe. The connection and the job sending start when Studio opens, so a computer that was already open will not take part.

**A. The line at the top**
1. Open Studio on the desktop first, then on the laptop. Give each about a minute. The line at the top only appears once a computer has seen the other one, so it may be missing for the first half minute or so.
2. On the laptop the line reads **Desktop: ready**. On the desktop it reads **Laptop: seen just now**.
3. On the desktop, press **Pause laptop jobs**. This button, and Probe's **Laptop jobs: on** line, only appear once the desktop has seen a laptop. Within about 30 seconds the laptop's line changes to **Desktop: laptop jobs paused**. Press **Resume laptop jobs** and within about 30 seconds the laptop says **Desktop: ready** again. Probe on the desktop shows **Laptop jobs: paused** and then **Laptop jobs: on** to match.
4. Close Studio on the desktop only, and keep Studio open on the laptop. After a minute and a half the laptop's line says **Desktop: not seen since** and the time. Open Studio on the desktop again and it goes back to **Desktop: ready**.
5. Unplug the server (or disconnect the network cable on the laptop). The laptop says **Can't reach the server** with its project folder in brackets, such as `Can't reach the server (N:\Youtube video ideas)`. Plug it back in and the line recovers by itself.

**B. A ComfyUI shot**
6. On the laptop, open a film's Review with a ComfyUI shot. The button now reads **Make on the desktop** (it used to say "Make this on the desktop") and it can be pressed. Press it.
7. The job shows **Waiting for the desktop**. When the desktop picks it up, it changes to **On the desktop:** followed by the time left or a percentage. While it runs, the laptop's line at the top reads **Desktop: busy (1 job)**. The desktop's own job list (Live jobs) shows the same job tagged **from** and the laptop's name.
8. When it finishes, the take appears in the film on the laptop and the usual "ready" notice shows on the laptop. The desktop does not record the take and does not show a "ready" notice for it. The laptop's line goes back to **Desktop: ready**.
9. (No step: the desktop's "Retry it from" note is checked in step 17, on a job that has ended.)

**C. Sound and 3D**
10. Repeat steps 6 to 8 with a Stable Audio sound effect or music item on Audio, and then with a Blender 3D shot. Each goes through waiting, running, then a take recorded on the laptop with the notice on the laptop only. Blender asks Claude for its script from the desktop's Studio, as it does when you make one there.

**D. Pause holds a new job**
11. On the desktop, press **Pause laptop jobs**. On the laptop, wait about 30 seconds for **Desktop: laptop jobs paused**, then press **Make on the desktop** on a shot. The job says **Waiting for the desktop (laptop jobs paused)** and does not start.
12. On the desktop, press **Resume laptop jobs**. Within about 10 seconds the job starts and goes through running to done as in step 7. A job that was already running when you paused finishes as normal.

**E. Withdraw**
13. Close Studio on the desktop. On the laptop, press **Make on the desktop** on a shot. The job waits and shows **Withdraw** next to it.
14. Press **Withdraw**. The job fails with **Withdrawn** and nothing is made. (Withdraw only appears while the job is still waiting for the desktop. Once the desktop has started it, the button is gone.)
15. Open Studio on the desktop again. It does not start the withdrawn job.

**F. Closing a Studio mid-job**
16. Send a ComfyUI shot from the laptop and wait until it says **On the desktop:** with progress. Close Studio on the laptop, wait a minute, and open it again. The job picks up where it was and the take is recorded when it finishes. There is only one take, not two.
17. Send a Blender shot. While it is running, close Studio on the desktop. The laptop job keeps showing **On the desktop:** and waits. Open Studio on the desktop again: the laptop job now fails with **Interrupted on the desktop; press Retry**. On the desktop, open Live jobs: that job shows **from** and the laptop's name and the note **Retry it from** and the laptop's name, with no working Retry button there. Now press **Retry** on the laptop: a fresh job is sent. Nothing is ever retried by itself.
18. If a ComfyUI job fails with a message that a render may still be running on the desktop, the job shows **Check again**. Press it: it asks the desktop to look (it spends nothing) and the job moves on to done if the render finished. **Check again** only appears in that case.

**G. Nothing deleted**
19. On the server, open the project folder's `.studio-queue` folder. Requests that are finished (done, withdrawn, or failed for good) have been moved into `.studio-queue\finished\`. Open it and check the files for your jobs are there (`.request.json`, `.answer.json` and, for the withdrawn one, `.withdrawn.json`). Nothing was deleted anywhere. The `.studio-presence` folder has one small file for each computer.
20. **The desktop on its own.** Close Studio on the laptop and leave it closed for two minutes. On the desktop the line at the top may say **Laptop: last seen** with a time, but Films, Review, Audio and the job list work exactly as before.
