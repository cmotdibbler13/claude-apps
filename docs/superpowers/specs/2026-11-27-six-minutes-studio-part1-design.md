# Six Minutes Studio: Part 1 in the app (own voice)

Status: draft for Jon's approval. Date: 2026-11-27.

## Why
Part 1 (the script) is still made in a chat with the documentary-explainer-script skill, and Studio only sees a film
once `part1_handover.md` exists. Jon chose the full build: start a film in Studio from a research brief, have Claude
write the script there, review and approve it in Studio, and Studio writes the Part 1 handover, so the whole film
runs in one place up to Part 3. Own voice first; cloned voice (which needs the VoiceStudio name test) comes later.

## What Jon gets
1. **New film** on the Films page. He picks the film's folder (or names a new one), the brief in it, the topic, the
   file prefix and the episode number. Voice: own voice (cloned voice shown as "coming later").
2. **Write the script** (free: Claude in Studio). One pass writes the whole film as structured clips, with the shot
   list, sound-effects list, build notes and pronunciation notes. Studio lays out the reading script and builds the
   line script from the clips, so line ids, word count and timings are exact. To-camera lines are picked straight
   after, by the same rules as the presenter build.
3. **The Part 1 review**: the script section by section, each clip with its narration, cue and line ids. Per clip:
   edit, or **Redo with a note** (only that clip changes). For the whole script: **Revise with a note**. Also the
   pronunciation notes, the sound-effects list, the to-camera lines, the shot list, the build notes and the episode
   number, with the runtime and word count always in view.
4. **Approve Part 1** writes the reading script, the line script (in the film's `narration\` folder and Autocue
   Studio's folder) and `handover\part1_handover.md`, then tells him to record every line in Autocue Studio. The
   film then moves on to Part 2 as now.

## Goals
- A script as good as the chat's, in the same house format (the skill's rules are the brief to Claude).
- The line script is always exactly right: ids, order, words matching the reading script.
- Fixing one clip never changes another.

## Non-goals
- Cloned voice, the VoiceStudio copy and the name test (a later build).
- PDF briefs in this build (my call): Studio reads `.md` and `.txt`; for a PDF it says "Save the brief as Markdown or
  text in the film's folder first." Reason: Claude in Studio takes text, and a PDF reader in the app is its own job.
- Web research or checking facts beyond the brief; the brief is the source, as in the skill.
- Re-opening Part 1 after approval (my call): the approved files are then Jon's; he edits them by hand if needed,
  as today. Studio already re-reads an edited line script.
- Changing the script skill: the chat route keeps working for films made outside Studio. (Skill updates are a
  later item.)

## Anti-goals
- A line script whose ids or words drift from the reading script.
- A note on one clip quietly rewriting others.
- Losing a draft or an earlier file: drafts are kept, files are never overwritten (earlier copies moved aside).

## Approaches (Jon picked C)
- **A. Whole script as Markdown, Studio parses it.** Closest to the chat, but Studio must parse free text to build
  line ids, and every note rewrites everything.
- **B. Outline, then a call per section.** A stop on the shape first, but about eight calls, sections that read as
  separate pieces, and a harder bookended ending.
- **C. Structured clips (picked).** One call returns every clip as data plus the lists; Studio renders the reading
  script and builds the line script. Exact ids and counts, per-clip redo; the cost is that Studio owns the reading
  script's layout, so a format change means a code change.

## New film
- The Films page gets **New film**. The form:
  - **Folder:** a list of folders under the project root that have no `handover\part1_handover.md`, or **New
    folder** (a name; Studio creates it). The folder name is the film's folder as today.
  - **Brief:** the `.md` and `.txt` files in that folder (newest first), or **Add a brief…** (a file chooser that
    copies the picked file's bytes into the folder, as the presenter photo button does, never overwriting: a clash
  gets `_2`).
  - **Topic** (the film is "Six minutes on… <Topic>"; default: the folder name).
  - **File prefix:** suggested from the topic (lowercase, words joined by `_`, letters/digits only); must match
    `^[a-z0-9]+(_[a-z0-9]+)*$` and not be used by another film's line script (checked against the other films'
    handovers and the autocue folder's `*_line_script.txt`).
  - **Episode:** suggested as the highest episode number found on the Films page plus one, written with three
    digits (`008`); editable. Films without an episode line are skipped; with none at all, `001`.
  - **Voice:** own voice. The form shows where takes will save:
    `<autocueRecordings>\<prefix>\<prefix>_<NN.s>.wav`.
  - **Runtime target:** default "6:00–6:45"; editable text.
- On **Create**, Studio makes `<film>\studio\` and saves the choices in `state.json` as `part1.setup`, then opens the
  film's Review on the Part 1 step. Films with `part1.setup` and no Part 1 handover show "Script: not written yet"
  or "Script: waiting on you" in their line on the Films page. (Films already lists folders with a `studio\`
  folder, so a new film shows at once, with Part 1 as "now".)

## Inputs Claude gets
- The whole brief text. If the brief is larger than Studio can send (use the runtime's limits where it reports them;
  otherwise 400,000 characters), Studio says so and does not write. A clip redo sends the clips (not the reference),
  so it stays small.
- One reference script, read from settings `referenceScripts` (default: the skill's two, Shipping Forecast then
  London Sewers; the first that exists is sent). Probe row "Reference script" passes when one exists.
- **Approved pronunciations** (Claude's memory isn't reachable from Studio): settings `pronunciationsFile`, default
  `<root>\pronunciations.md`, free text, sent when it exists. Probe row "Pronunciations" warns when missing (not a
  failure). Studio appends approved pronunciations from each Part 1 approval to it (see Approve Part 1).
- The setup: topic, prefix, episode, runtime target, own voice.
- The skill's rules, turned into instructions: reading-script format, writing the narration, accuracy rules, line
  script rules for words and numbers, shot-list prompt rules, sound-effects list, archive and rights, notes for the
  build. The instructions live in one module so they can be updated with the skill.

## What Claude returns (two calls, tier "default")
To stay well inside the runtime's reply size (my call), writing is two calls: **the clips** (title, build line, key,
sections and clips), then **the lists** (shots, sfx, music, archive, notes), which gets the brief and the finished
clips. Revise runs both; a clip redo runs neither of them, only a one-clip call. Together they return:
```
{
  title, buildLine, key: { graphics: [{ name, what }], extra },
  sections: [{ name, clips: [{
    narration,            // the reading-script words, normal digits allowed
    spoken,               // the same words for recording: numbers and years spelled out, normal spellings
    cue,                  // the [bracketed] visual cue, without brackets
    delivery,             // optional italic note, or null
    pronunciations: [{ name, say }]
  }] }],
  shots: [{ id: "HF-01", usedIn: [clip numbers], prompt }],
  sfx:   [{ cue, clip, idea }],
  music, archive: [{ item, licence, credit }],
  notes: { corrections, myths, softer, conflicts, timeSensitive, leftOut, filmYourself, pronunciationTests, cutOrder }
}
```
- Sections and clips are numbered by Studio (clip numbers run on across sections from 01), never by Claude.
- Each call is checked on its own; **Studio refuses** (and retries that call once with the error, then shows it) when: a field is missing or the wrong type;
  a clip has no narration; `narration` and `spoken` differ in any word other than numbers and number words (compare
  ignoring case and punctuation, after dropping digit tokens and number words); a shot's `usedIn` names a clip that
  doesn't exist; an sfx `clip` doesn't exist.
- **Studio warns** (shown in the review, not refused): clip count outside 26–29; words outside 825–925; a clip under
  5 or over 50 words; sections other than 6–8; estimated runtime outside the target.

## What Studio builds from it
- **Numbers and times:** words counted by script on `narration`; spoken words on `spoken`. Runtime = 0.40 s per
  spoken word + 0.6 s between clips + 1.2 s between sections (in place of the clip gap) + `titleHoldS` (6 s) after the
  cold open + `endCardS`. Section starts and the total are written into the headings
  (`## SECTION n — NAME *(about m:ss–m:ss)*`). Studio adds the skill's note that the finished voiceover usually comes
  in 3–4% shorter. Headings and warnings use the raw estimate; the review shows the raw estimate and the expected
  finished length beside it. The word-count and runtime warnings are separate; either can show alone.
- **Line script** from `spoken`: split each clip into sentences on `.`, `?`, `!` (not after St, Mr, Mrs, Ms, Dr,
  Prof, No, or a single capital letter), join a sentence of three words or fewer onto the next sentence in the clip
  (onto the previous one if it is last), number `NN.s`, and add `> Name = "say"` notes under each line where a
  clip's pronunciation name appears, and `> to camera` under chosen lines. Format exactly as the skill's example
  (`# <Title> — line-by-line recording script (N lines)`, `# name: <prefix>`, `## n · SECTION NAME`,
  `[NN.s]  (clip NN)`). It must round-trip through Studio's existing `parseLineScript` with the same ids, texts and
  notes (a test).
- **Reading script** in the reference format: header (title `# <Title> — Reading Script`, runtime target · word count
  in N clips · `Voice: Jon, own voice (Autocue Studio → Recordings\<prefix>\)`, the Build line), key paragraph,
  sections separated by `---`, each clip `**NN**` (with the delivery note in italics after it when there is one),
  the narration, then `[cue]`; then the Higgsfield shot list table (Shot | Used in | Prompt), the sound-effects
  table (Cue | Clip | Prompt idea), the music line, archive and rights, and the notes for the build (with the
  timing maths Studio computed).
- **To-camera lines:** straight after a write or revise, Studio runs the presenter build's line suggestion (same
  rules: about five, one or two near the start, two in the middle, one near the end, 12 s or less) on the new line
  script. Picks are kept by line id **and** text: after a redo or edit, a pick whose id no longer exists or whose text
  changed is dropped (and the review says "To-camera line 05.2 changed: pick again").

## The Part 1 review
- In the film's Review, a **Part 1** step shows while the film has no Part 1 handover (the Part 2 sections stay
  hidden until then). Sketch:

```
Part 1 · Script                      6:21 est · 871 words · 28 clips · 7 sections      [Approve Part 1]
  Warnings: clip 14 is 54 words
  [Revise with a note…]   Draft 2 of 2 (from your note "shorter cold open")  [Earlier drafts ▾]
  ── SECTION 1 — COLD OPEN (about 0:00–0:41) ──
  01  On a hill above St Austell…                       01.1 01.2 ●to camera
      [Wide shot, HF-01: the hill at dusk]              [Edit] [Redo with a note…]
  …
  Pronunciation notes   St Austell = "Saint Ostul"  [edit] [+ add]
  Sound effects         Cue | Clip | Idea                [edit] [+ add] [remove]
  To-camera lines       ☑ 01.2 Nobody knows who wrote them…  [Add a line]
  Shot list · Build notes (read only, with the prompts editable)
  Episode 008 [edit]
```

- **Edit** a clip: narration, spoken and cue fields; Studio checks the same `narration`/`spoken` rule on save.
- **Redo with a note** (one clip): Claude gets the brief, the whole current script and the note, and returns that
  one clip; nothing else changes.
- **Revise with a note** (whole script): Claude gets the brief, the reference, the current script and the note, and
  returns a whole new script.
- **Drafts:** every write, revise, redo and edit saves a new draft in `state.json` (`part1.drafts`, newest last, with
  what made it). Jon can go back to an earlier draft (it becomes the newest). Kept for the film's life.
- One Claude call at a time per film; the button shows "Writing… (about a minute)" and the call shows in Live jobs.
  A failed call keeps the draft as it was and shows the error.
- **Approve Part 1** is locked while a call is running, while there is no draft, or while the episode is empty.

## Approve Part 1
- Writes, never overwriting (an existing file is moved aside with a time stamp, as the library build does):
  - `<film>\<prefix>_script.md` (the reading script);
  - `<film>\narration\<prefix>_line_script.txt` and a copy in `autocueDir` (`C:\Users\Jon\desktop autocue\`);
  - `<film>\handover\part1_handover.md`.
- **The handover** (the skill's contents, as they apply here): `Episode: 008` on its own line near the top (the Films
  page reads it); project name, prefix, folder paths; voice choice and the recordings folder; the to-camera lines (id
  and text); his decisions (the notes he gave, in his words, the drafts' history, the approved pronunciations, the
  approved sound-effects list); a file index (brief, reading script, line script with both paths); open items (any
  warnings left); and a next step instead of an opening message: "Record every line in Autocue Studio (Load script
  → `<prefix>_line_script.txt`). Then open this film's Review in Studio for Part 2."
- Appends the approved pronunciations not already in `pronunciationsFile` (one `Name = "say"` per line, under a
  `## <Topic>` heading). A name already there with the same respelling is skipped; with a different one it is added
  again, and Claude's instructions say a later entry wins.
- If the copy to `autocueDir` fails (folder missing, no access), the film's files and handover are still written; the
  handover lists the failed copy under open items and the review says "Copy the line script to Autocue Studio's
  folder by hand: <path>". Any other failed write stops the approval before the handover is written (the handover
  is written last, so a repeat press finishes the job).
- Then the Part 1 step shows the next step with **Open Autocue Studio** when Studio already knows how to start it, and
  the film's Review switches to the Part 2 sections (the narration list fills as takes arrive).

## Constraints
- Studio stays the existing artifact; republish keeping its capabilities. No new paid calls: Part 1 spends no
  credits.
- Never overwrite or delete files Jon owns; drafts kept.
- No voice recordings committed to the repo.
- On-screen text rules (Inter only, no italics) are in Claude's instructions and in the reading script's cue
  vocabulary, as in the skill.

## Calls I made (Jon to check)
- PDF briefs wait for a later build; save as Markdown or text for now.
- Approved pronunciations live in a file Studio reads and adds to (`pronunciations.md` at the project root), since
  Studio can't reach Claude's memory.
- Approval is final in Studio; later fixes are hand edits.
- To-camera lines are picked by Studio right after writing (the presenter rules), and shown for him to change.
- Writing is two Claude calls (clips, then lists) rather than one, to stay inside the reply size.
- No separate approval ticks for the script, the pronunciations, the sound-effects list and the episode: one
  Approve Part 1 covers all four, as the skill's single approval does.

## Left to the builder
- The exact wording of Claude's instructions, within the skill's rules above.
- Layout of the New film form and the Part 1 step, within Studio's look.
- How long-call progress shows in Live jobs.
