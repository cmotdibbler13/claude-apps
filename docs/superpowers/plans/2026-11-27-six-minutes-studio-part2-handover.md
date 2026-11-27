# Approve Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One free **Approve Part 2** button that, once everything is approved, adds the film's approved clips to the B-roll library, writes the Part 3 hand-off extras and writes `handover\part2_handover.md`.

**Architecture:** Pure modules decide (readiness, catalogue entries and MD rows, handover facts and markdown); small IO modules act (catalogue read/write with dated copies and tmp+rename; ffmpeg/ffprobe for probe, thumbnail and contact sheet); one Claude module writes the prose; one runner (`approvePart2`) does the steps in order and records `state.part2`.

**Tech Stack:** ES modules, `node --test` with `tests/fake-host.mjs`; ffmpeg/ffprobe; Claude via `askJson` (js/claude.js).

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-part2-handover-design.md`

## Global Constraints
- Free: no generation calls. Claude only through `askJson`, tier `"default"`, structured JSON, validated.
- Never delete or overwrite: before writing `broll_catalogue.json`, `broll_catalogue.md`, a contact sheet or an existing `part2_handover.md`, copy (catalogues) or move (sheet, handover) the old one aside as `<name>_<YYYY-MM-DD-HHmm><ext>` in the same folder; write new files to `<name>.tmp` then rename.
- Library root `<root>\B-roll library\`; catalogue JSON = one object with a single array property holding the entries (find it; keep other properties); write `JSON.stringify(doc, null, 2) + "\n"`, UTF-8.
- Approved entry keys, in order: `id, film, shot, status, aspect, description, setting, period, tags, prompt, job_id, notes, size_mb, source_path, library_path, in_library, duplicate_of, duration_s, width, height, fps`. Rejected row: same keys up to `duplicate_of`, `status: "rejected"`, `library_path: null`, `in_library: false`.
- Claude fills only `description, setting, period, tags, notes`; tags 8–12 lower-case for approved, rejected rows' tags end with `"rejected"`; rejected `notes` = `"Rejected: <Jon's redo note for that take, or 'not chosen in review'>"`.
- `job_id`: `"higgsfield:<id>"`; `"local ComfyUI <workflow file name> seed <n>"`; `"Blender: <script path relative to root>"`.
- Paths in entries are relative to root: `source_path` = the take file; `library_path` = `B-roll library\clips\<slug>\<slug>_<shot>.mp4`.
- MD row: `| <id> | <shot> | <status> | <d.d> s | <description> | <period> | <tags joined ", "> | <notes> |`; rejected: status `rejected (not copied)`, duration `–`, period `–`; `|` in a value → `\|`.
- Thumbnails `thumbs\BR-nnn.jpg`; contact sheet `contact_sheets\<slug>.jpg`.
- Library gets video shots only: kinds `broll`, `blender`, `animated` (not `lineart`, not `presenter`, not the portrait).
- Copy: lock "<list> still to approve" (e.g. "3 shots, the score and 2 sound effects still to approve"); "Changed since the Part 2 handover"; button **Approve Part 2** / **Write the handover again**; opening message "Part 3 of Six minutes on… <Topic>. Load /documentary-explainer-video, read <film>\handover\part2_handover.md, and carry on."
- Voice recordings and media never committed to the repo.

## Review Focus
1. Two shots of this film reuse the same shot id across a redo-and-remove (HF-03 removed, new HF-07) → the removed one never goes in the library; entries key on `source_path`, so re-running adds nothing twice (Task 2 test).
2. Catalogue JSON on disk is unreadable/invalid or has no array property → nothing is written anywhere and the handover isn't written (Task 6 test).
3. A take file listed in the state is missing on disk → the step stops naming the file; the handover is not written with a missing path (Task 4 test).
4. MD has no table for this film yet → a new `## <Film>` heading plus header row copied from the last table, then rows (Task 2 test).
5. Press while a job (any take of this film) is still running → refused with "Wait for the running jobs to finish." (Task 6 test).

---

### Task 1: Readiness and Higgsfield ids on takes
**Files:** Create `js/part2.js`; Modify `js/tools/higgsfield.js` (every kind returns `meta.hfId` = the job id; resume too), `js/redo.js` (`META` already has `hfId`); Test `tests/part2.test.mjs`, extend `tests/higgsfield.test.mjs`.
**Interfaces (produces):**
- `part2Readiness(state) -> { ready: boolean, left: string[], warnings: string[] }`. Live shots = `state.assets` minus kind `presenter` minus `onCameraConflict` (shots.js). `left` items, in order: `"<n> shot(s)"`, `"the portrait"`, `"<n> clip(s)"`, `"the score"`, `"<n> sound effect(s)"`, `"the voiceover join"`, `"the mix"` (mix missing, unapproved or `mixOutOfDate`). Warnings: approved clips with `voiceoverChanged` or `staleReason`; `state.mix.voiceover.allowFlagged`.
- `leftText(left) -> string` ("3 shots, the score and 2 sound effects still to approve").
- `hfJobIdFor(take, jobs: object[]) -> string|null`: `take.hfId` else the `jobRef` of the job with `id === take.jobId` (jobs = parsed `.studio-jobs.json` list), else null.
- [ ] Tests: each `left` item and the exact sentence; ready when all approved; removed/conflict shots don't count; warnings listed; b-roll runner meta has hfId; hfJobIdFor three cases.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: Part 2 readiness".

### Task 2: Catalogue entries and MD rows (pure)
**Files:** Create `js/library.js`; Test `tests/library.test.mjs` with a fixture `tests/fixtures/broll_catalogue.json`: a wrapper object `{ "entries": [...] }` holding three entries in the spec's shapes (approved, rejected, alternate; invented values). A test also wraps the same list under another key name to prove the key is found, not assumed.
**Interfaces (produces):**
- `catalogueArray(doc) -> { key, entries }` (throws "The B-roll catalogue has no list of clips." when not exactly one array property).
- `nextBrNumber(entries, mdText) -> int` (highest `BR-(\d+)` in either + 1).
- `librarySlug(entries, filmFolder, topic) -> string` (existing slug from a `library_path` of an entry whose `source_path` starts with `<filmFolder>\`, else topic lower-case, non-alphanumerics → `_`).
- `plannedEntries({ shots, entries, film, filmFolder, slug, startNumber }) -> [{ entry, copyFrom?, thumb? }]`: `shots` = `[{ id, kind, aspect, prompt, chosen: {file, hfJob, local}, others: [{file, note, hfJob}] , probe }]`; skips any whose `source_path` already exists in `entries`; assigns ids in shot order (approved first, then that shot's rejected rows). Studio-side fields only; Claude fields left `undefined`.
- `withClaudeFields(entry, fields) -> entry` (validator: exactly the five keys, types as spec).
- `mdRow(entry) -> string`; `appendMd(mdText, film, rows) -> string` (append rows to the film's table if a `## <film>` heading exists, else add heading + the last table's header and separator rows, then rows).
- [ ] Tests: key found under any name; two arrays → throws; next number from JSON vs MD; slug reuse vs new; skip by source_path (Review Focus 1); ids/ordering; key order exactly as Global Constraints; rejected row shape; MD rows incl. `\|` escape and `–`; new film table (Review Focus 4).
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: B-roll library entries".

### Task 3: Library media and file IO
**Files:** Create `js/tools/libmedia.js`, `js/libraryio.js`; Test `tests/libmedia.test.mjs`, `tests/libraryio.test.mjs`.
**Interfaces (produces):**
- `probeClip(host, file) -> { duration_s, width, height, fps, size_mb }` (ffprobe `-v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate:format=duration -of json`; size from `fs.stat`; 2 decimals for duration, 1 for size, fps from the rational to 1 decimal).
- `makeThumb(host, src, out)` (`ffmpeg -y -ss 1 -i src -frames:v 1 -vf scale=320:-2 out`).
- `contactSheet(host, items: [{thumb, id}], out)` (ffmpeg: each thumb padded to 320x180 with `drawtext` of the id bottom-left, `tile=4x<rows>`; rows = ceil(n/4)).
- `stampName(path, now) -> path` (`<name>_<YYYY-MM-DD-HHmm><ext>`); `writeSafely(host, path, text)` (tmp then rename); `copyAside(host, path, now)`, `moveAside(host, path, now)` (no-op when missing).
- `readCatalogue(host, root) -> { doc, key, entries, md, paths }` (throws with the reason when unreadable or not JSON).
- [ ] Tests: probe parsing of a scripted ffprobe JSON; thumb and sheet argv; stampName; writeSafely leaves no `.tmp`; copyAside keeps the original; readCatalogue errors.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: library files and media helpers".

### Task 4: Hand-off facts, extras and the handover markdown (pure + checks)
**Files:** Create `js/part2handover.js`; Test `tests/part2handover.test.mjs`.
**Interfaces (produces):**
- `handoverFacts({ state, dir, root, lineScript, part1, jobs, brIds }) -> facts` with `project {film, topic, prefix, episode, folder}`, `voice {kind: "own"|"cloned", recordings}`, `files [{group, label, path}]` (groups per spec: Voiceover, Score, Sound effects, Mix preview, B-roll and art, On camera), `ids [{label, value}]`, `usage [{tool, takes}]`, `warnings`.
- `checkFiles(host, files) -> void` (throws "Missing file: <path>" for the first missing; Review Focus 3).
- `sfxCues(state) -> object[]` (`{id, file, startS, loop, endS, gainDb}` for approved cues with chosen takes); `mixSettings(state, settings) -> object` (`{mixMusicDb, mixSfxDb, ride, voiceover, score}` from the approved fit and mix).
- `renderHandover(facts, prose: {decisions: string[], openItems: string[]}) -> string` (sections in the script skill's order: Project details, Voice choice, His decisions, File index, Settings and IDs, Open items, Usage, Opening message; the opening message exactly as Global Constraints).
- `openingMessage(topic, dir) -> string`.
- [ ] Tests: facts from a sample state (every group present, BR ids beside shots, local takes "made locally (Blender|ComfyUI)", missing episode → "Episode: not found in part1_handover.md" + open item); checkFiles error; sfxCues/mixSettings shapes; rendered markdown headings in order and the exact opening message.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: Part 2 handover writer".

### Task 5: Claude prose
**Files:** Create `js/part2prose.js`; Test `tests/part2prose.test.mjs`.
**Interfaces (produces):**
- `PART1_INSTRUCTIONS`, `part1Facts(host, text) -> { topic: string|null, episode: string|null }` (episode `^\d{1,4}$` or null).
- `LIBRARY_INSTRUCTIONS` (README reuse rules: match the period, never caption as a specific real place, notes start with the maker and format; British English), `libraryFields(host, items: [{key, kind:"approved"|"rejected", shot, desc, prompt, line, tool, model, aspect, probe, note}]) -> Map<key, fields>` (one call; validator per item with Task 2's `withClaudeFields` rules).
- `HANDOVER_INSTRUCTIONS`, `handoverProse(host, { notes, choices, warnings }) -> { decisions: string[], openItems: string[] }` (each 1–40 short lines).
- [ ] Tests (FakeHost scripted claude): each validator rejects a bad shape; tier is "default"; the library call gets every item once; prose call data contains the redo notes and pacing notes.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: Part 2 prose from Claude".

### Task 6: The run
**Files:** Create `js/part2run.js`; Modify `js/store.js` only if `state.part2` needs a default (none: absent = not approved); Test `tests/part2run.test.mjs`.
**Interfaces:** `approvePart2(ctx, { onStep }) -> { brIds, handover }` with ctx `{host, store, jobs, settings, root, lineScript}`; steps (each `onStep({step, text})`): "Reading the library", "Adding n clips", "Thumbnails and contact sheet", "Hand-off files", "Writing the handover". Order and safety:
1. Refuse unless `part2Readiness(state).ready` (copy `leftText`) and no job of this film queued/running ("Wait for the running jobs to finish." Review Focus 5).
2. Read part1 handover + facts (Claude), catalogue (Task 3), plan entries (Task 2), Claude fields (Task 5); `checkFiles` for every source; **only then** write: copy clips (`copyFrom` → library path; skip if same size already there), thumbs, JSON (copyAside then writeSafely), MD, contact sheet (moveAside), `studio\handover\sfx_cues.json` and `mix_settings.json`, then `handover\part2_handover.md` (moveAside then writeSafely).
3. `state.part2 = { approvedAt, handover, brIds, sig }` where `sig` = JSON of `[id, chosen, file]` for every approved holder plus the mix's `at`.
- `part2Changed(state) -> boolean` (stored sig vs current).
- [ ] Tests: happy path writes in order and records part2; catalogue invalid → nothing written (Review Focus 2); missing take → nothing written; second run adds nothing new and moves the old handover aside; running job refused; part2Changed after unapprove.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: Approve Part 2".

### Task 7: Review UI, Probe row, checklist, publish
**Files:** Modify `js/ui/review.js` (summary bar: Approve Part 2 / Write the handover again with the lock sentence as its title and beside it; a step list while running; after: "Part 2 handed over <date>", the opening message in a read-only box with Copy; "Changed since the Part 2 handover" when `part2Changed`), `js/app.js` (action `approvePart2`; ctx gains root; reads `.studio-jobs.json` list from `app.jobs.list()`), `js/ui/probe.js` (row "B-roll library": pass "<n> clips, next BR-<m>" when the catalogue reads; else the reason), `css/studio.css`, `docs/acceptance-slice1.md` (section "Approve Part 2 (version 28)"); Test `tests/viewmodel.test.mjs` (or a new `tests/part2ui.test.mjs`).
- [ ] Tests: model locked with the sentence; ready → enabled; running steps shown; done shows message + Copy; changed banner; Probe row pass/fail.
- [ ] Run → FAIL; implement; `npm test` → PASS; Playwright stub check at 1280/390; commit; push. (Publishing is done by the controller after the final review, capabilities carried forward.)
