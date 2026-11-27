# Six Minutes Studio: Approve Part 2 (handover and B-roll library)

Status: draft for Jon's approval. Date: 2026-11-27.

## Why
Part 2 (assets) now happens in Studio: shots, on-camera clips, score, sound effects, voiceover and mix are made,
reviewed and approved there. Jon's rule is that every part ends with its handover file, so a fresh Part 3 session can
carry on from his PC folder alone. Today nothing writes `part2_handover.md` or adds the approved clips to the B-roll
library, so that is still a manual Claude step. This build ends Part 2 inside Studio with one button.

## What Jon gets
- **Approve Part 2** in the film's Review summary bar. It stays locked, saying what's left ("3 shots, the score and 2
  sound effects still to approve"), until everything is approved.
- Pressing it (free, no credits) does, in order, with each step shown as it happens:
  1. **B-roll library:** every approved new video clip is copied into `B-roll library\clips\<film_slug>\`, gets the
     next BR- number, a catalogue entry in both `broll_catalogue.json` and `broll_catalogue.md`, and a thumbnail; the
     takes he didn't choose get a "rejected" row only.
  2. **Hand-off extras:** `sfx_cues.json` and `mix_settings.json` written into the film's `studio\handover\`.
  3. **`handover\part2_handover.md`**, in the script skill's format, ending with the ready-to-paste Part 3 opening
     message, which Studio also shows with a Copy button.
- Films then shows Part 2 as done (it already reads `part2_handover.md`).

## Goals
- Part 3 can start from the handover alone: every file it needs listed with its real path, every id needed to fetch a
  clip again, every decision Jon made.
- The B-roll library grows exactly as the video skill describes, in the same layout as its existing entries.
- Nothing is lost or overwritten; pressing it again is safe.

## Non-goals
- Starting the Part 3 session inside Studio (a later build; this one gives the opening message).
- Proposing library reuse before generating shots (a separate build).
- Archive images and rights permissions (they stay outside the app).
- Copying files to the cloud or into the repo.

## Anti-goals
- A handover that lists a file that isn't there, or misses one Part 3 needs.
- Library entries in a different layout from Jon's existing ones, or a reused BR- number.
- Deleting or overwriting a catalogue, a handover or any take.

## Approaches (Jon picked A)
- **A. Studio fills a fixed template; Claude writes only the prose (picked).** Facts (paths, ids, times, project
  details, the opening message) come from Studio's own records; Claude (free, default tier) writes "His decisions"
  from Jon's notes and choices, the open items, and each library entry's descriptive fields. Paths and ids can't be
  wrong or missing.
- **B. Claude writes the whole handover from a dump of the state.** Reads naturally; a missed file or wrong path only
  shows when Part 3 fails.
- **C. Leave it to a Claude Code session.** No build; keeps the manual step.

## What "everything approved" means (the lock)
All of these, counting only live items (removed versions and b-roll on to-camera lines don't count):
- every shot (b-roll, line art, 3D, animated) approved;
- if the film has on-camera lines: a portrait approved and every clip (TC-nn) approved;
- the score approved; every sound-effect cue approved;
- the voiceover joined and the mix approved, and the mix not out of date with the voiceover.
Warnings that don't block, listed under Open items instead: clips "Made with an earlier portrait" or "out of step"
that Jon approved anyway; flagged narration lines he joined anyway; `awaiting_permission.md` /
`images_to_download.md` present in the project folder.

## The handover file
`<film>\handover\part2_handover.md`, following "The handover file" in documentary-explainer-script and "Part 2
hand-off files" in documentary-explainer-video:
- **Project details:** film name, file prefix, episode number (from `part1_handover.md`), folder paths.
- **Voice choice** and recordings folder (from `part1_handover.md`; own voice: also the line script and takes folder).
- **His decisions** (Claude, in his words where possible): chosen takes, redo notes, pacing notes, the look, the
  on-camera lines, score fit note, tight cuts he kept.
- **File index** (Studio, from state, each path checked to exist; a missing one is an error, not a silent gap):
  - Voiceover: the joined WAV, timings CSV, word-level transcript JSON; own voice: line script and takes folder.
  - Score: the chosen take fitted, its timing sheet if the fit made one, `mix_settings.json` (gain ride and levels).
  - Sound effects: each chosen take and `sfx_cues.json` (id, file, film start time, loop/end, gain dB).
  - Mix preview: the approved mix files.
  - B-roll and art: each approved shot's chosen take with its HF id, line, kind, tool and its new BR- id.
  - On camera: each TC clip's chosen take, its line id and film start/end time, and the approved portrait.
- **Settings and IDs:** Higgsfield job id of every chosen Higgsfield take; ElevenLabs flow id and node ids (score and
  each cue); ComfyUI/Blender takes say "made locally" with their script/workflow file.
- **Open items** (Studio's warnings + Claude's summary).
- **Usage:** the number of takes made per tool for this film (Studio can't see token usage).
- **Opening message:** "Part 3 of Six minutes on… <Topic>. Load /documentary-explainer-video, read
  <film>\handover\part2_handover.md, and carry on."
Files stay where Studio made them (`<film>\studio\…`, already on his PC); the handover points at them.

## The B-roll library
At `<root>\B-roll library\` (`S:\Youtube video ideas\B-roll library\`), with its `README.md`, `broll_catalogue.json`,
`broll_catalogue.md` and `clips\`.
- Studio reads the README and the catalogue first. The new entries copy the field names, order and thumbnail
  location of the newest existing entries; Claude fills the descriptive fields (subject, setting, period, tags,
  description) from the shot's description, prompt and line, following the README's rules.
- Next BR- number = highest in the JSON + 1. Copy = the chosen take's original file, renamed as the existing
  entries are. Thumbnail made with ffmpeg as the existing ones are.
- Rejected rows: for each new entry's other finished takes, a "rejected" row only (no copy).
- **Which clips:** approved video shots made in this film (b-roll, 3D, animated). Not line-art stills, not Jon's
  on-camera clips, not the portrait. (My call.)
- **Safe to repeat:** each entry records its source (`<film> HF-nn take n`); a clip already in the catalogue is
  skipped. Before writing, each catalogue file is copied aside with the date; the files are then rewritten whole.
- If the library or its catalogue can't be read or parsed, that step stops with the reason and nothing is written;
  the handover isn't written either.

### From the library's README (Jon, 2026-11-27)
- Layout: `broll_catalogue.md` (one table per film: ID, what it shows, period, tags, notes), `broll_catalogue.json`
  (full details), `clips\<film>\`, `thumbs\BR-nnn.jpg`, `contact_sheets\` (one sheet per film, clip ids on each
  frame), `BUILD.md`.
- JSON fields to fill for each new entry: film, shot, status, aspect, description, setting, period, tags, prompt, job
  ID, notes, size, source path, library path (named as the existing entries name them).
- Status words: **approved** for the chosen take of each approved shot (Studio can't know the final cut yet);
  the other finished takes of that shot get a **rejected** row, no copy, notes "not chosen in review" plus Jon's redo
  note for that take if any (the skill's rule; "alternate" is left for Jon to set by hand).
- Add a row to that film's table in the MD (a new table under a heading for the film if it has none yet).
- Thumbnail `thumbs\BR-nnn.jpg`; then **refresh the film's contact sheet** in `contact_sheets\` (`contact_sheets\\<slug>.jpg`, e.g. `christmas_tree.jpg`; rebuilt from the film's
  approved thumbnails with each BR id on its frame, in the existing sheets' layout; the old sheet is moved aside
  first).
- The originals stay where they are; for Studio films that's `<film>\studio\media\` (the README's "each film's
  own `broll\` folder" is where older, pre-Studio films kept them).

### From the catalogue itself (Jon pasted it, 2026-11-27)
- `broll_catalogue.json` is one object whose single array property holds the entries (written by PowerShell
  `ConvertTo-Json`; Studio finds the array property rather than assuming its name, keeps every other property, and
  writes UTF-8 JSON with 2-space indents: same content, different spacing). The last id was BR-601.
- An approved entry has, in this order: `id, film, shot, status, aspect, description, setting, period, tags, prompt,
  job_id, notes, size_mb, source_path, library_path, in_library, duplicate_of, duration_s, width, height, fps`.
  A rejected row has the same keys up to `duplicate_of` with `library_path: null`, `in_library: false`,
  `size_mb` and `prompt` filled when known, and no duration/width/height/fps.
- Values, as the newest films have them:
  - `film`: the film's display name ("The Christmas Tree"); clips go in `clips\<slug>\` with `<slug>` the film's
    existing slug if it has entries, else lowercase-underscored ("christmas_tree").
  - `shot`: Studio's shot id (`HF-03`); `aspect` "16:9" (or "9:16"); `tags` 8–12 lower-case tags.
  - `job_id`: `"higgsfield:<job id>"` for Higgsfield takes; `"local ComfyUI <workflow file> seed <n>"` for ComfyUI;
    `"Blender: <script path>"` for Blender.
  - `notes`: starts with the maker and format ("Higgsfield Kling 3.0 pro, 16:9, 1920x1080 24 fps, sound off.")
    then any caveats from Jon's notes and the reuse caution ("Illustrative: never caption it as …") where it fits.
  - `source_path` / `library_path`: relative to `S:\Youtube video ideas\` (`"<Film folder>\studio\media\HF-03_t2.mp4"`,
    `"B-roll library\clips\<slug>\<slug>_HF-03.mp4"`); `size_mb` 1 decimal; `duration_s`, `width`, `height`, `fps`
    from ffprobe; `in_library: true`, `duplicate_of: null`.
  - Rejected rows: short `description`, `tags` ending "rejected", `notes` "Rejected: <Jon's redo note, or 'not chosen
    in review'>", `setting`/`period` may be "".
- Claude writes only `description, setting, period, tags, notes` (and the rejected rows' short description); Studio
  fills every other field. A Claude answer with any other key, or a missing one, is refused.
- `broll_catalogue.md` (UTF-8; Jon pasted its tail): each film table has 8 columns, in this order:
  `| BR-596 | PS03 | used | 5.0 s | <description> | 1970s | tag, tag, tag | <notes> |`, i.e. id, shot, status,
  duration (`5.0 s`, one decimal), description, period, tags joined with ", ", notes. Rejected rows read
  `| BR-597 | PS03 | rejected (not copied) | – | <description> | – | tag, rejected | <notes> |` (en dash `–` for no
  duration and for the period). A `|` inside a value is written `\|`. Studio still reads the last table's header
  row (the column names) and copies it for a new film's table under a heading with the film's name, as the existing
  tables have.

## Pressing it again / changes after approval
- The state records `part2 = { approvedAt, handover, brIds: [BR ids], topic, message, sig }`.
- If anything is unapproved or changed after that, the summary shows "Changed since the Part 2 handover" and the button
  reads **Write the handover again**: the old `part2_handover.md` moves aside as `part2_handover_<date>.md`, new
  approved clips are added to the library, existing entries are left alone.

## Constraints
- Free: no generations, only Claude (`sample`) and local ffmpeg/file work. Never delete or overwrite files: move aside.
- Studio stays the existing artifact; no new capabilities needed (desktop file access already granted).
- Voice recordings and media never go into the repo.
- The handover format stays compatible with the existing skills (Part 3 sessions read it).

## Settled after the builder check (my calls)
- **Files stay in `studio\`, originals, no transcode.** Part 3 now runs on Jon's PC, so the video skill's "original
  under 30 MB, else a CRF 18 copy" (a cloud-transfer limit) doesn't apply; the handover points at the originals.
  Studio records no grades, so none are listed.
- **Ids:** the library source string and the handover use Studio's shot id (`HF-nn`, never reused, also for Blender
  and ComfyUI shots): `<film> HF-nn take n`. The "Higgsfield job id" field says "made locally (Blender|ComfyUI)" for
  local takes, with their script or workflow file. Higgsfield takes record their job id on the take (`hfId`) from now
  on; older takes get it from `.studio-jobs.json` by the take's job, else "not recorded".
- **Project details:** the file prefix is the line script's `# name:` (Studio already uses it for every take path);
  own voice when the film has a line script, else cloned. The episode number and anything else from
  `part1_handover.md` is extracted by Claude as JSON and checked (episode = 1–4 digits); if it isn't found the
  handover says "Episode: not found in part1_handover.md" and it goes under Open items. Paths are written as the
  Windows paths Studio already holds.
- **Claude's parts are structured and checked:** "His decisions" and "Open items" come back as JSON lists of short
  lines; library entries as JSON objects that must have exactly the existing entries' keys. The decisions are drawn
  from: take notes (redo notes), pacing notes and marks, the fit note, the look, the on-camera lines and where they
  came from, approvals of out-of-step/earlier-portrait clips, joined-anyway lines. If a Claude call fails, the step
  stops and nothing more is written; pressing again carries on (the library step skips what's done).
- **Partial failure:** order is copy clips and thumbnails → write the JSON catalogue → the MD catalogue → the hand-off
  extras → the handover. Each file is written to `<name>.tmp` then renamed over (the dated copy is made first). A
  failure stops there with its reason; pressing again repeats safely because entries are found by their source string
  (in the JSON; the MD is regenerated for new entries only by appending rows in the existing table format). The next
  BR- number is the highest in either catalogue + 1.
- **"Changed since the handover":** at approval Studio stores a signature of every approved item (id, chosen take,
  file) plus the mix; any difference later lights "Changed since the Part 2 handover". "Mix out of date" uses the
  mix step's existing check.
- **Art and archive:** line-art and other still shots are in the file index under "Archive and art"; archive images
  are only mentioned under Open items when `awaiting_permission.md` / `images_to_download.md` exist.

## Calls I made (Jon to check)
- Library gets video clips only (not line-art stills, not on-camera clips or the portrait).
- Files stay in `studio\` and the handover points at them, rather than copying them into the project folder.
- Warnings (out-of-step clips kept, flagged lines joined anyway, archive files present) don't block approval; they go
  under Open items.
- Usage is the take count per tool, not token usage.

## Left to the builder
- Layout of the step list and the opening-message box.
- Exact Claude prompts within the rules above.
- How the existing entries' layout is inferred, as long as new entries match it field for field.
