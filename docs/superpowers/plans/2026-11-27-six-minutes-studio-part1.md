# Part 1 in the app (own voice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a film in Studio from a brief, have Claude write the script as structured clips, review and approve it, and write the reading script, line script and `part1_handover.md`.

**Architecture:** Pure modules turn a structured script (clips + lists) into numbers, warnings, a line script and a reading script. A Claude module holds the instructions and validated calls. A run module owns drafts in `state.json` (`part1`), the to-camera picks and approval (file writes). Two UI modules (New film form, Part 1 step) plug into the existing Films and Review views through `app.js`.

**Tech Stack:** Plain ES modules, no build step; `node --test` with `tests/fake-host.mjs`. All paths below are relative to `six-minutes-studio/` unless they start with `docs/`.

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-part1-design.md`

## Global Constraints

- Never overwrite or delete Jon's files: an existing target is moved aside with `moveAside` from `js/libraryio.js` (stamped name), new files written with `writeSafely`.
- Every Claude call goes through `askJson` (`js/claude.js`), tier `"default"`. Part 1 spends no credits and calls no MCP tools.
- Speech rate 0.40 s per spoken word; 0.6 s between clips; 1.2 s between sections (in place of the clip gap); `settings.titleHoldS` (6) after section 1; `settings.endCardS` (12) at the end. Finished voiceover expected 3–4% shorter (show `total × 0.965` as "expected finished").
- Warnings (shown, never refused): clips outside 26–29; reading words outside 825–925; a clip under 5 or over 50 words; sections other than 6–8; raw runtime outside the target range.
- File prefix rule: `^[a-z0-9]+(_[a-z0-9]+)*$`.
- Line script format exactly: `# <Title> — line-by-line recording script (N lines)`, `# name: <prefix>`, `## <n> · <SECTION NAME>`, `[NN.s]  (clip NN)` (two spaces), text line, `> Name = "say"` notes, `> to camera`.
- Reading script voice line: `Voice: Jon, own voice (Autocue Studio → Recordings\<prefix>\)`.
- Handover has `Episode: <NNN>` at the start of a line (Films reads `^\s*Episode:\s*(\d+)`).
- British English, plain words in all UI text. No Claude model identifiers in the repo. No voice recordings committed.

## Review Focus

1. A sentence ending in an abbreviation (`St Austell`, `Dr Snow`) or an initial (`J. Bazalgette`) must not split a line. → Task 3 test.
2. A clip whose last sentence is three words or fewer ("Do not demolish.") joins the previous sentence, and a one-sentence clip stays one line. → Task 3 test.
3. Numbers that differ only in form ("£4.7 billion" / "four point seven billion pounds", "1850s" / "eighteen fifties", "19th" / "nineteenth", "86%" / "eighty-six percent") pass the narration/spoken check; one changed ordinary word fails it. → Task 2 test.
4. Approving a film whose files already exist (a repeat press, or a chat-made script) moves the old files aside, never overwrites. → Task 8 test.
5. Autocue Studio's folder missing at approval: film files and handover still written, open item recorded. → Task 8 test.

---

### Task 1: Setup helpers and settings

**Files:**
- Create: `js/part1setup.js`
- Modify: `js/settings.js` (defaults)
- Test: `tests/part1setup.test.mjs`, `tests/settings.test.mjs`

**Interfaces:**
- Produces:
  - `suggestPrefix(topic: string) -> string` — lower case, every run of non `[a-z0-9]` → `_`, trimmed of `_`.
  - `prefixProblem(prefix: string, taken: string[]) -> string|null` — `"Use lower-case letters, digits and _ only."` when the rule fails; `"Another film already uses <prefix>."` when in `taken` (case-insensitive); else null.
  - `suggestEpisode(films: {number: string|null}[]) -> string` — max of parseable numbers + 1, padded to 3; `"001"` when none.
  - `takenPrefixes(host, root, settings) -> Promise<string[]>` — `# name:` values (via `parseLineScript`) of `*_line_script.txt` in `settings.autocueDir`, plus prefixes from other films' `part1_handover.md` lines matching `^\s*(?:-\s*)?(?:File prefix|Prefix):\s*` `?([a-z0-9_]+)` `?` (case-insensitive). Unreadable folders are skipped.
  - `filmFolders(host, root) -> Promise<{name, dir}[]>` — subfolders of root without `handover\part1_handover.md`, sorted by name, skipping names starting with `.` and the folders `B-roll library`, `Presenter photos`, `ComfyUI workflows`, `Autocue recordings`, `voice files`.
  - `briefsIn(host, dir) -> Promise<{name, path, mtimeMs}[]>` — `.md`/`.txt` files (case-insensitive), newest first, excluding names ending `_script.md`, `_line_script.txt`.
  - `addBrief(host, dir, {name, bytes}) -> Promise<string>` — writes bytes to `<dir>\<name>`, or `<stem>_2<ext>`, `_3`… when taken; refuses names not ending `.md`/`.txt` with `"Save the brief as Markdown or text in the film's folder first."` (same text for `.pdf`).
  - `DEFAULT_SETTINGS.referenceScripts = ["S:\\Youtube video ideas\\Shipping Forecast\\shipping_forecast_script.md", "S:\\Youtube video ideas\\London Sewers\\london_sewers_script.md"]`; `DEFAULT_SETTINGS.pronunciationsFile = null` and `withDefaults` sets it to `join(root, "pronunciations.md")` when null.

- [ ] **Step 1: Write failing tests** — `suggestPrefix("The Post Office") === "the_post_office"`, `suggestPrefix("St. Kilda's Mail-boat") === "st_kilda_s_mail_boat"`; `prefixProblem("Post", [])` is the letters message, `prefixProblem("post_office", ["Post_Office"])` the taken message, `prefixProblem("post_office", [])` null; `suggestEpisode([{number:"007"},{number:null},{number:"12"}]) === "013"`, `suggestEpisode([]) === "001"`; `filmFolders` skips a folder with a Part 1 handover and `B-roll library`; `briefsIn` orders by mtime and skips `x_script.md`; `addBrief` twice with `brief.md` gives `brief.md` then `brief_2.md`, `brief.pdf` rejects with the exact text; `takenPrefixes` finds `# name: china_clay` in the autocue folder and `File prefix: \`post_office\`` in another film's handover; settings default `pronunciationsFile` is `<root>\pronunciations.md` and `referenceScripts` has the two paths.
- [ ] **Step 2: Run** `node --test tests/part1setup.test.mjs tests/settings.test.mjs` — FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(part1): setup helpers and settings`.

### Task 2: Script numbers, words check and warnings

**Files:**
- Create: `js/part1script.js`
- Test: `tests/part1script.test.mjs`

**Interfaces:**
- Script shape (used by every later task):
  `{ title, buildLine, key: {graphics:[{name, what}], extra}, sections:[{name, clips:[{narration, spoken, cue, delivery|null, pronunciations:[{name, say}]}]}], pronunciations:[{name, say}], shots:[{id, usedIn:number[], prompt}], sfx:[{cue, clip:number, idea}], music: string|null, archive:[{item, licence, credit}], notes:{corrections, myths, softer, conflicts, timeSensitive, leftOut, filmYourself, pronunciationTests, cutOrder} }` (each note is a string array).
- Produces:
  - `clipList(script) -> {n, section, sectionIndex, clip}[]` — clips numbered from 1 across sections.
  - `words(text) -> string[]` — split on whitespace after stripping punctuation except internal `'` and `-`… compare-ready lower case tokens (hyphenated words split into parts).
  - `NUMBER_WORDS: Set<string>` — cardinals zero–nineteen, tens twenty–ninety, hundred, thousand, million, billion, trillion, their ordinals (first…twentieth, thirtieth…ninetieth, hundredth, thousandth, millionth) and plural decades (tens, twenties…nineties, including teens like fifties of "eighteen fifties"), plus `point`, `oh`, `and`, `a`, `percent`, `per`, `cent`, `pounds`, `pound`, `pence`, `dollars`, `dollar`, `euros`, `degrees`.
  - `sameWords(narration, spoken) -> {ok: boolean, diff: string|null}` — compares `words()` of both after dropping tokens containing a digit and tokens in `NUMBER_WORDS`; `diff` names the first mismatch as `"«reading word» vs «spoken word»"`.
  - `scriptStats(script, settings) -> {clips, sections, words, spokenWords, rawS, expectedS, sectionTimes:[{startS, endS}], clipWords:number[]}` using the Global Constraints formula; `words` counts `words(narration)` including digits tokens.
  - `scriptWarnings(stats, runtimeTarget: string) -> string[]` — the exact texts: `"Clips: <n> (aim for 26–29)."`, `"Words: <n> (aim for 825–925)."`, `"Clip <NN> is <w> words (5–50)."`, `"Sections: <n> (aim for 6–8)."`, `"Estimated <m:ss>, outside <target>."`. The target parses `m:ss–m:ss` (en dash or hyphen); an unparseable target skips that warning.
  - `mmss(s) -> "m:ss"`.

- [ ] **Step 1: Write failing tests** — Review Focus 3 cases all `ok: true`; `sameWords("The tunnel ran east.", "The tunnel ran west.")` gives `ok:false, diff:"east vs west"`; a 2-section, 3-clip script with 10, 20, 30 spoken words: `rawS = 4+0.6+8 + 1.2 + 12 + 6 + 12 = 43.8` (sections: clips 1–2 in section 1, clip 3 in section 2; hold after section 1, end card at end) and `sectionTimes[1].startS = 4+0.6+8+6+1.2 = 19.8`; warnings list for that script contains the clips, words, sections texts and `"Clip 01 is 10 words"` does not appear (10 is within 5–50); `mmss(381) === "6:21"`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Order of time: section 1 clips with 0.6 gaps, then `titleHoldS`, then 1.2 before each later section's first clip, clips with 0.6 gaps, then `endCardS`. A section's `endS` is the end of its last clip.
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** `feat(part1): script numbers and checks`.

### Task 3: Line script builder

**Files:**
- Modify: `js/part1script.js`
- Test: `tests/part1script.test.mjs`

**Interfaces:**
- Produces:
  - `splitSentences(text) -> string[]` — ends at `.`, `?`, `!` (optionally followed by closing quotes/brackets) then whitespace, except after `St`, `Mr`, `Mrs`, `Ms`, `Dr`, `Prof`, `No` or a single capital letter; then a sentence of ≤3 words joins the next sentence of the clip, or the previous one when it is last.
  - `scriptLines(script) -> {id, clip, section, sectionIndex, text}[]` — ids `NN.s` from `spoken`.
  - `lineScriptText(script, {prefix, picks: string[]}) -> string` — the Global Constraints format; under a line, one `> Name = "say"` for each `script.pronunciations` name found in the line text (case-sensitive), then `> to camera` when its id is in `picks`.

- [ ] **Step 1: Write failing tests** — Review Focus 1 and 2; `splitSentences("Kenwyn. Do not demolish. The house stood empty.")` → `["Kenwyn. Do not demolish.", "The house stood empty."]` (short joins the next, repeatedly while still ≤3 words); `"It was cold that winter. Nobody came."` → one line (the short last sentence joins the previous); `"Dr Snow mapped it. J. Bazalgette built it."` → two lines. Round trip: `parseLineScript(lineScriptText(s, {prefix:"china_clay", picks:["01.2"]}))` has `name "china_clay"`, the same ids/texts as `scriptLines(s)`, `toCamera` only on `01.2`, and the section headings `"1 · COLD OPEN"`; the title line reads `# <Title> — line-by-line recording script (N lines)`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** `feat(part1): line script from clips`.

### Task 4: Reading script

**Files:**
- Modify: `js/part1script.js`
- Test: `tests/part1script.test.mjs`

**Interfaces:**
- Produces: `readingScriptText(script, {prefix, runtimeTarget, stats}) -> string`:
  - `# <title> — Reading Script`; next line `Runtime target <target> · <words> words in <clips> clips · Voice: Jon, own voice (Autocue Studio → Recordings\<prefix>\)`; then `Build: <buildLine>`.
  - Key paragraph: `**Key:** visual cues in [brackets]; HF-nn is a Higgsfield shot; reusable graphics: <NAME> (<what>), …; each numbered paragraph is one clip, <prefix>_NN.wav.` plus `key.extra` when present.
  - Per section: `---`, `## SECTION <n> — <NAME> *(about <m:ss>–<m:ss>)*`, then per clip `**NN**` (+ ` *<delivery>*` when present), the narration line, `[<cue>]`, blank line between clips.
  - After the last section `---` then, in order: `## Higgsfield shot list` table `| Shot | Used in | Prompt |` (Used in as `NN, NN`), `## Sound effects` table `| Cue | Clip | Prompt idea |`, `## Music` (when music), `## Archive and rights` table `| Item | Licence | Credit |` (when any), `## Notes for the build` with a `### <Heading>` and bullets for each non-empty notes list (headings: Corrections to the brief, Myths kept out or hedged, Softer-sourced lines, Conflicting figures, Re-check before publishing, Left out on purpose, Film it yourself, Pronunciation test list, Cut order), then `### Timing` with the raw estimate, the expected finished length and the rule (0.40 s per word, gaps).
  - Pipes inside table cells escaped as `\|`.

- [ ] **Step 1: Write failing tests** — exact header lines for a fixture; a section heading `## SECTION 2 — THE TUNNEL *(about 0:19–0:31)*` from Task 2's timing fixture; a delivery note renders `**02** *slower*`; a prompt containing `|` is escaped; empty notes lists produce no heading.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(part1): reading script layout`.

### Task 5: Claude calls

**Files:**
- Create: `js/part1claude.js`
- Test: `tests/part1claude.test.mjs`

**Interfaces:**
- Consumes: `askJson`, `ClaudeError` (`js/claude.js`); `sameWords`, `clipList` (Task 2).
- Produces:
  - `CLIPS_INSTRUCTIONS`, `LISTS_INSTRUCTIONS`, `CLIP_INSTRUCTIONS` (strings) — the skill's rules (reading-script format and cue vocabulary, writing the narration, accuracy rules, line-script word and number rules for `spoken`, shot-prompt rules, sound-effects list, archive, notes), adapted from `skills/documentary-explainer-script/SKILL.md` at the repo root; each ends with its exact JSON reply shape. Sections and clips carry no numbers.
  - `writeClips(host, {brief, reference, pronunciations, setup, note?, current?}) -> Promise<{title, buildLine, key, sections}>` — `note`/`current` present for a whole-script revise.
  - `writeLists(host, {brief, setup, sections}) -> Promise<{shots, sfx, music, archive, notes}>`.
  - `redoClip(host, {brief, setup, script, n, note}) -> Promise<clip>` — sends the brief and the clips (not the reference).
  - `withRetry(call)` behaviour inside each: when `askJson` throws `ClaudeError` with code `"invalid"`, call once more with `data.previousError = <message>` and `cache: false`; a second failure throws.
  - Briefs over the limit: `BRIEF_TOO_BIG = "The brief is too long for Studio to send (<n> characters, <max> at most)."`; max is `host.claude.limits?.()?.maxInputChars` when that is a number, else 400000; checked before any call (`ClaudeError("too_big", …)`).
- Validation (each throws with a plain message): clips — non-empty `sections` of `{name, clips[]}`; every clip has string `narration`, `spoken`, `cue`, `delivery` string|null, `pronunciations` array of `{name, say}` strings; `sameWords(narration, spoken).ok` (message `Clip <NN>: <diff>`). Lists — `shots` ids unique `HF-\d{2}` with `usedIn` all existing clip numbers; `sfx[].clip` exists; every notes key present as a string array.

- [ ] **Step 1: Write failing tests** with `FakeHost.claudeScript`: valid clips reply returned; first reply with a narration/spoken mismatch then a valid one → returns the second and the second call's input contains `previousError` and opts `cache:false`; two bad replies → rejects with code `"invalid"`; `writeLists` rejects a shot using clip 99; `redoClip` input contains the note and the other clips' narration but not the reference text; a 400,001-character brief rejects `too_big` with no Claude call made; instructions contain `"Inter"` and `"no italics"` and `"spelled out"`.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(part1): Claude calls for clips, lists and one clip`.

### Task 6: Drafts, picks and the write/revise/redo/edit run

**Files:**
- Create: `js/part1run.js`
- Test: `tests/part1run.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–5; `openFilm` store (`store.update(fn)`, `store.log(text)`); `suggestLines` (`js/presenter.js`); `loadSettings`.
- State: `state.part1 = { setup:{folder, brief, topic, prefix, episode, runtime, voice:"own"}, drafts:[{n, at, why, note|null, script}], picks:[{id, text, from:"claude"|"jon", why}], pickNotes: string[], approvedAt: number|null }`.
- Produces (each `ctx = {host, store, settings, root}`):
  - `currentDraft(state) -> draft|null` (last).
  - `writeScript(ctx, {note?}) -> Promise<draft>` — reads the brief, the first existing `settings.referenceScripts` (none: throws `"No reference script found. Set referenceScripts in .studio-settings.json."`), `settings.pronunciationsFile` text when it exists; runs `writeClips` then `writeLists`; merges clip pronunciations into `script.pronunciations` (dedupe by name, first wins); saves a draft with `why` `"Written"` or `"Revised from your note"`; then re-picks to-camera lines (below).
  - `redoOne(ctx, n, note)`, `editClip(ctx, n, {narration, spoken, cue})` (rejects when `sameWords` fails, message `"The reading and spoken words differ: <diff>"`), `editLists(ctx, patch)` (shots prompts, sfx rows, pronunciations, episode in setup), `restoreDraft(ctx, n)` — each saves a new draft (`why`: `"Clip NN redone: <note>"`, `"Clip NN edited"`, `"Lists edited"`, `"Back to draft <n>"`).
  - Picks: after write/revise, `suggestLines(host, {lines: scriptLines(script)})` → `picks` from `"claude"`; after any other draft change, keep picks whose `id` exists with identical `text`, drop the rest and push `"To-camera line <id> changed: pick again"` to `pickNotes`. `setPicks(ctx, ids)` sets picks (`from:"jon"` for new ids). A failed suggestion leaves `picks` empty and `pickNotes` `["Couldn't suggest to-camera lines: <message>"]`.
  - Single flight: `part1Busy(dir) -> boolean`; a second call while busy rejects `"Wait for Claude to finish."` Each Claude-backed run logs `"Part 1: writing the script"` / `"Part 1: script written (draft <n>)"` / failure text via `store.log`.
  - A failed call leaves drafts unchanged.

- [ ] **Step 1: Write failing tests** (FakeHost, a film folder with a brief, a reference script, scripted Claude replies keyed on instruction text): write → one draft, `why:"Written"`, picks from the scripted suggestion; revise with a note → draft 2 and the clips call input contains the note and draft 1's narration; `redoOne(ctx, 2, "shorter")` changes only clip 2 (deep-equal others); edit that changes a picked line drops the pick and adds the note; restore draft 1 → draft 3 equals draft 1's script; second concurrent `writeScript` rejects with the busy text; a Claude failure leaves `drafts.length` unchanged; no reference → the exact error.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(part1): drafts, to-camera picks and runs`.

### Task 7: New film and the Films page

**Files:**
- Modify: `js/part1run.js` (createFilm), `js/films.js`, `js/ui/films.js`
- Test: `tests/part1run.test.mjs`, `tests/films.test.mjs`

**Interfaces:**
- Produces:
  - `createFilm(host, root, {folder|newFolder, brief, topic, prefix, episode, runtime}, {taken}) -> Promise<dir>` — `newFolder` creates `<root>\<name>` (rejects an existing name: `"A folder called <name> is already there."`, and names with `\ / : * ? " < > |`); checks `prefixProblem`; `episode` must match `^\d{1,4}$`; opens the store and sets `part1.setup` (voice `"own"`), `drafts: []`, `picks: []`, `pickNotes: []`, `approvedAt: null`.
  - `films.js` film gains `part1: "none" | "draft" | null` — `null` when no `state.part1`; `"none"` when setup only; `"draft"` with drafts. When `parts[1] === "now"` and `part1` is not null, `waiting` becomes `"Script: not written yet"` or `"Script: waiting on you"`.
  - `filmRow`: button `{label: "Open script", primary: true}` when `parts[1] === "now"` and `part1 !== null`; Part 2 behaviour unchanged.
  - Films view head gains a **New film** button (`actions.newFilm()`).

- [ ] **Step 1: Write failing tests** — createFilm with a new folder makes `<root>\X\studio\state.json` with the setup; an existing folder name rejects with the exact text; a bad prefix rejects with Task 1's text; `scanFilms` returns `part1:"draft"` and waiting `"Script: waiting on you"` for a film with a draft and no handover; `filmRow` gives the Open script button; an existing Part 2 film still gets "Open review".
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(part1): new film and Films page`.

### Task 8: Approve Part 1

**Files:**
- Create: `js/part1handover.js`
- Modify: `js/part1run.js` (approvePart1)
- Test: `tests/part1handover.test.mjs`, `tests/part1run.test.mjs`

**Interfaces:**
- Produces:
  - `renderPart1Handover(facts) -> string` with `facts = {topic, prefix, episode, dir, root, brief, files:{script, lineScript, autocueCopy|null}, recordings, picks, pronunciations, sfx, decisions: string[], openItems: string[], approvedAt}`. Sections in order: `# Part 1 handover — Six minutes on… <topic>`; `Episode: <episode>` alone on a line; `## Project` (name, `File prefix: <prefix>`, folder paths); `## Voice` (`- Own voice (Autocue Studio)`, `- Recordings folder: <recordings>` — same wording as `js/part2handover.js`); `## To-camera lines` (`- <id>: <text>`); `## His decisions`; `## Approved pronunciations`; `## Sound-effects list` (table); `## File index` (brief, reading script, line script in film and autocue folder); `## Open items` (or `- None.`); `## Next step` with `Record every line in Autocue Studio (Load script → <prefix>_line_script.txt). Then open this film's Review in Studio for Part 2.`
  - `decisionsFrom(drafts, setup) -> string[]` — each note Jon gave, in his words (`Revise: "<note>"`, `Clip NN: "<note>"`), plus `Draft <n> approved`, `Episode <episode>`.
  - `appendPronunciations(text|null, topic, list) -> string|null` — adds `## <topic>` and `Name = "say"` lines for entries not already present as the identical line; null when nothing to add.
  - `approvePart1(ctx) -> Promise<{handover, openItems}>` — refuses while busy, with no draft, or with an empty episode. Order: reading script `<dir>\<prefix>_script.md`; line script `<dir>\narration\<prefix>_line_script.txt`; copy to `<autocueDir>\<prefix>_line_script.txt` (failure → open item `Copy the line script to Autocue Studio's folder by hand: <path>` and the approval continues); pronunciations file; handover `<dir>\handover\part1_handover.md` last; then `part1.approvedAt`. Each existing target is moved aside first. Any non-autocue write failure throws before the handover is written.

- [ ] **Step 1: Write failing tests** — handover has `Episode: 008` at line start and parses through `films.js` (scanFilms gives `number "008"`, parts 1 done, 2 now); `File prefix: china_clay` line is found by Task 1's `takenPrefixes`; Review Focus 4: existing `china_clay_script.md` is moved to a stamped name and the new one written; Review Focus 5: no autocue folder → handover written with the open item and the function resolves; a failing reading-script write → no handover file; `appendPronunciations` skips an identical line and adds a changed one; `findLineScript` (narration.js) finds the new line script from the handover.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(part1): approve Part 1 and write the handover`.

### Task 9: UI — New film form, Part 1 step, Probe rows, wiring

**Files:**
- Create: `js/ui/newfilm.js`, `js/ui/part1.js`
- Modify: `js/ui/review.js` (render Part 1 step when the model has `part1`), `js/ui/films.js`, `js/ui/probe.js`, `js/app.js`, `css/studio.css`
- Test: `tests/part1ui.test.mjs`, `tests/probe.test.mjs`

**Interfaces:**
- Produces:
  - `newFilmModel({folders, briefs, form, taken, films, error, busy}) -> model` and `renderNewFilm(el, model, actions)`; `form` fields folder/newFolder/brief/topic/prefix/episode/runtime with Task 1 suggestions filled when empty; shows `<autocueRecordings>\<prefix>\<prefix>_<NN.s>.wav`; Voice shows "Own voice" selected and "Cloned voice (coming later)" disabled; the PDF/other-file message from Task 1 on a bad pick (file chooser as in `js/ui/photopick.js`, accepting `.md,.txt,.pdf`).
  - `part1Model({state, settings, busy, error}) -> {stats, expectedS, warnings, drafts, sections:[{heading, clips:[{n, narration, spoken, cue, delivery, ids:string[], picked:string[]}]}], pronunciations, sfx, shots, notes, picks, pickNotes, episode, canApprove, approveWhy, nextStep|null}` and `part1Section(m, actions)` following the spec sketch: header numbers (raw and expected), warnings, Write the script / Revise with a note… / Earlier drafts, per clip Edit and Redo with a note…, lists with edit/add/remove, To-camera ticks and Add a line, Approve Part 1. Busy text `"Writing… (about a minute)"`. After approval: the next-step text and an **Open Autocue Studio** button only when the app already has a way to start it (check `js/autostart.js`/`js/autocueinstall.js`; otherwise no button).
  - `reviewModel` takes `part1` (the `part1Model` result) and `render` shows only the film heading and the Part 1 step when it is set; `app.js` passes it while `app.film.parts[1] !== "done"` and the store has `part1`, re-scans films after approval and switches to the Part 2 review.
  - Probe rows: `"Reference script"` pass when one of `settings.referenceScripts` exists (fail text names the setting); `"Pronunciations"` pass when the file exists, else a warning `"No pronunciations file yet: Studio starts one when you approve a Part 1."`.
- [ ] **Step 1: Write failing tests** for the two models: prefix and episode suggestions appear; the recordings example path; `canApprove` false with `approveWhy` `"Write the script first."` (no draft), `"Wait for Claude to finish."` (busy), `"Add the episode number."` (empty); warnings and expected length shown; picked ids marked; Probe row texts.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass). Then load `index.html` in Playwright with a FakeHost-like stub only if one already exists in `tests/`; otherwise rely on the model tests.
- [ ] **Step 5: Commit** `feat(part1): New film form and Part 1 review`.

### Task 10: Acceptance notes and publish

**Files:**
- Modify: `docs/acceptance-slice1.md` (section "Part 1 in Studio (version 30)"), `README.md` if it lists features

- [ ] **Step 1:** Write the checklist: New film on an Orkney test folder; brief pick and Add a brief; PDF message; Write the script; check runtime and warnings; Redo one clip with a note and confirm the others unchanged; Revise with a note; Earlier drafts; edit a pronunciation and see it in the line script after approval; Approve Part 1; check the three files, the moved-aside copies on a second film, the Autocue Studio copy, Load script in Autocue Studio shows the amber `to camera` and pronunciation notes; the film's Review switches to Part 2.
- [ ] **Step 2:** `npm test` — all pass.
- [ ] **Step 3: Commit** `docs(part1): acceptance checklist`. Publishing is done by the controller.
