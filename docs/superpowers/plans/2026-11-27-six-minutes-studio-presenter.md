# Jon on Camera Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each film gets about five to-camera clips of Jon: lines marked in the script (or suggested in Studio), a per-film look and portrait made in Higgsfield from his photos, and Wan 2.7 lip-sync clips of his own voiceover lines, with no b-roll on those lines.

**Architecture:** Pure logic in `js/presenter.js` (lines, look, portrait holder, clip assets, audio staleness); Higgsfield upload/estimate helpers in `js/tools/hfmedia.js`; the Higgsfield runner gains kinds `portrait` and `presenter`; a new Review step "On camera" in `js/ui/oncamera.js`; the script skill update ships as a file.

**Tech Stack:** ES modules, `node --test` with `tests/fake-host.mjs`; Higgsfield MCP (`generate_image`, `generate_video`, `jobs_wait`, `media_upload`, `media_confirm`, `estimate_image_cost`, `estimate_video_cost`); ffmpeg.

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-presenter-design.md`

## Global Constraints
- Note marking a line: `> to camera` (match case-insensitive, trimmed).
- Lines: about five; one or two near the start, two in the middle, one near the end; one sentence; spoken ≤ 12 s (about 30 words) when suggested; a line over 15 s spoken can't be a clip: "Too long for one clip: 15 s at most".
- Clip ids `TC-01`, `TC-02`… in creation order, never reused (count `state.removed` too).
- Portrait: `seedream_5_5`, 16:9, `resolution: "2k"`, photos as `image_references`, two jobs of `count: 1` per press; prompt copied verbatim from the spec with `<outfit>` and `<set>` filled; set text always followed by the spec's blur wording.
- Clip: `wan2_7`, `resolution: "1080p"`, `aspect_ratio: "16:9"`, `duration` = ceil(line length) clamped 2..15, medias `[{value: <portrait hfId>, role: "start_image"}, {value: <audio media id>, role: "audio_references"}]`, prompt copied verbatim from the spec; a redo note is appended as `" " + note` (no Claude rewrite).
- Upload: `media_upload {files:[{filename, content_type}]}` → `uploads[i].upload_url`; media id = `uploads[i].media_id ?? uploads[i].id ?? ` the UUID in the URL path; `curl -X PUT -T <file> -H "Content-Type: <type>" -H "If-None-Match: *" <url>` (argument list, no shell); then `media_confirm {media_id, type}` (`"image"`/`"audio"`). Uploads are free.
- Cost: `estimate_*_cost` → `cost.credits`; buttons read "Make portraits (≈N credits)" / "Make clip (≈N credits)"; when the estimate fails: "(cost unknown)" and the button still works only after a second confirm click.
- Credits are spent only on Jon's press; generate is never retried (existing Higgsfield runner rules).
- Settings: `presenter: { photos: [] }` (paths). Portraits and clip audio live in `<film>\studio\presenter\`; clips in `<film>\studio\presenter\TC-01_t1.mp4`.
- Voice recordings and portraits never committed; never delete or overwrite takes.
- Copy: "This line is on camera" (b-roll conflict); "Made with an earlier portrait"; "The voiceover for this line changed: redo to match, or Keep anyway"; "Approve a portrait first"; "Join the voiceover first".

## Review Focus
1. A to-camera line id that isn't in the transcript (silent take, or joined before the line existed) → its clip's Make is locked with "Join the voiceover first", never a crash (Task 5 test).
2. Line script edited after lines were chosen (a chosen id disappears) → that line shows "Not in the script any more"; its TC asset stays until Jon unticks it (Task 1 test).
3. Changing the look or approving a new portrait while a clip take is running → the running take keeps the portrait it started with (its input carries the hfId); finished clips get "Made with an earlier portrait" (Task 4 test).
4. Upload PUT fails (expired URL, 4xx) → the take fails before `generate_video` is called; no credits spent (Task 3 test).
5. Join finishes while a clip take is running → staleness check skips running takes and checks them when they finish (Task 6 test).

---

### Task 1: To-camera lines (parse, choose, suggest)
**Files:** Modify `js/narration.js` (`parseLineScript` lines gain `toCamera: boolean`); Create `js/presenter.js`; Test `tests/presenter.test.mjs`, extend `tests/narration.test.mjs`.
**Interfaces (produces):**
- `parseLineScript(text) -> {name, lines: [{id, section, text, toCamera}]}`.
- `scriptCameraIds(lineScript) -> string[]`.
- `LINES_INSTRUCTIONS` (Claude prompt with the rules above; answer `{"lines":[{"id","why"}]}`), `suggestLines(host, lineScript) -> [{id, why}]` (`askJson`, tier `"default"`, validator: ids exist, 3–7 entries, unique).
- `lineLengthS(transcript, id) -> number|null` (from `transcript.sentences[].sentence/start/end`).
- `setCameraLines(ctx, ids: string[]) -> void`: writes `state.presenter.lines = [{id, from: "script"|"claude"|"jon"}]`; for each new id creates asset `{id: TC-nn, kind: "presenter", tool: "higgsfield", lineId, line, lineIndex, desc: "On camera: <first 8 words>…", takes: [], chosen: 0, approved: false}`; for a removed id: no takes → asset deleted; takes → moved to `state.removed` with `removedAt`. Refuses an id whose `lineLengthS > 15` with the copy; refuses while that asset has a take queued/running ("<TC id> has a take in progress.").
- `cameraLineState(state, lineScript) -> [{id, text, from, missing: bool, assetId}]` (`missing` when the id isn't in the script).
- [ ] Tests: `> To Camera ` parses as toCamera, other notes don't; scriptCameraIds order; suggestLines validator rejects unknown id/duplicates/2 entries; setCameraLines creates TC-01, TC-02, untick with no takes deletes, untick with takes moves to removed, re-tick makes TC-03; 16 s line refused with copy; missing id flagged (Review Focus 2).
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: to-camera lines".

### Task 2: No b-roll on camera lines
**Files:** Modify `js/shots.js`, `js/redo.js` (`removeVersion` accepts any non-presenter asset whose line is on camera); Test `tests/shots.test.mjs`, `tests/redo.test.mjs`.
**Interfaces:** Consumes Task 1 `scriptCameraIds`. `buildShotList(host, store, {scriptText, handoverText, cameraLines})`: `cameraLines` = `[{id, lineIndex, text}]` is added to `data` and to `SHOT_INSTRUCTIONS` ("Plan no shot on these to-camera lines: Jon is on camera for the whole line."); the validator refuses a shot whose `lineIndex` is in it. Produces `onCameraConflict(asset, state) -> boolean` (non-presenter asset whose `lineIndex` matches a chosen camera line); `deriveWaiting` skips conflicting assets.
- [ ] Tests: instructions contain the sentence and data has `cameraLines`; validator refuses a shot on a camera line; conflict true/false; deriveWaiting doesn't count a conflicting unapproved shot; removeVersion allowed for a conflicting broll (moves to removed), still refused for a broll not on a camera line and while a take runs.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: no b-roll on to-camera lines".

### Task 3: Higgsfield uploads and estimates, settings, Probe
**Files:** Create `js/tools/hfmedia.js`; Modify `js/settings.js` (`presenter: { photos: [] }` default, merged like `stableAudio`), `js/ui/probe.js` (Higgsfield tools check adds `media_upload`, `media_confirm`, `estimate_image_cost`, `estimate_video_cost`; new row "Presenter photos": pass "<n> photos" when 1–2 exist; else "Add presenter.photos in .studio-settings.json" or "Not found: <path>"); Test `tests/hfmedia.test.mjs`, extend `tests/probe.test.mjs`, `tests/settings.test.mjs`.
**Interfaces (produces):** `uploadMedia(host, file, type: "image"|"audio") -> Promise<string mediaId>` (content type from extension: png, jpg/jpeg, webp, wav, mp3); `estimateCredits(host, tool: "estimate_image_cost"|"estimate_video_cost", params) -> Promise<number|null>` (null on any error).
- [ ] Tests: upload call shapes (media_upload args, curl args incl. `If-None-Match: *`, confirm args); media id from `media_id`, from `id`, from the URL UUID; curl exit 22 → throws "Upload to Higgsfield failed…" and confirm not called (Review Focus 4); estimate returns `cost.credits`, null on throw; Probe rows; settings default and merge.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: Higgsfield uploads, estimates and presenter photos".

### Task 4: Look and portraits
**Files:** Modify `js/presenter.js`, `js/tools/higgsfield.js` (kind `portrait`), `js/redo.js` (`holders` includes `state.presenter.portrait` holder; `META` gains `hfId`, `audioSig`); Test `tests/presenter.test.mjs`, `tests/higgsfield.test.mjs`.
**Interfaces (produces):**
- `LOOK_INSTRUCTIONS`, `suggestLooks(host, {scriptText, lastLook}) -> {outfits: string[3], sets: string[3]}` (tier `"quick"`).
- `setLook(ctx, {outfit, set})` → `state.presenter.look`; `lastLook(host, root)` reads the most recent other film's `presenter.look` (null when none).
- `portraitPrompt(look) -> string` (spec text, filled).
- `startPortraits(ctx) -> void`: needs `settings.presenter.photos` (1–2 existing) and a look; adds two takes to holder `{id: "PORTRAIT", kind: "portrait", tool: "higgsfield", takes, chosen, approved}` and two jobs with input `{kind: "portrait", prompt, photos, out: <film>\studio\presenter\PORTRAIT_t<n>}`.
- Runner kind `portrait`: uploads photos (Task 3), `generate_image` with the Global params, returns `{file, meta: {hfId: <job id>}}`; image extensions as line art.
- `approvePortrait(ctx, n)` sets `presenter.portrait = {n, hfId, file, at}`; clips whose chosen take used another hfId get `staleReason: "portrait"`.
- [ ] Tests: prompt contains "same bald head", the outfit, the set and "strongly out of focus"; two jobs per press; refused without photos ("Add presenter photos (see Probe)") or look; runner params (model, `count: 1`, `resolution: "2k"`, two `image_references`); hfId in meta; approving a new portrait marks done clips stale but the running take's input keeps its hfId (Review Focus 3); lastLook picks the newest other film.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: presenter look and portraits".

### Task 5: The clips
**Files:** Modify `js/redo.js` (startTake `presenter` branch; `canStart`), `js/tools/higgsfield.js` (kind `presenter`), `js/presenter.js`; Test `tests/presenter.test.mjs`, `tests/higgsfield.test.mjs`.
**Interfaces:**
- `clipLock(asset, state, transcript) -> null | "Approve a portrait first" | "Join the voiceover first" | "Too long for one clip: 15 s at most"`; `canStart` returns false when locked.
- `clipPrompt(note?) -> string`; `clipSeconds(lengthS) -> int` (ceil, clamp 2..15).
- startTake presenter input: `{kind: "presenter", lineId, voiceover: <VOICEOVER wav>, start, end, seconds, hfId, prompt, out: <film>\studio\presenter\TC-nn_t<n>}`.
- Runner kind `presenter`: `ffmpeg -y -i <wav> -ss <start> -to <end> -af apad=whole_dur=<seconds> -ar 48000 <out>_audio.wav`; `audioSig = {lengthS: end-start rounded to 0.01, hash: sha256 hex of the WAV bytes}`; upload (audio); `generate_video` with the Global params; returns `{file, meta: {hfId, audioSig}}`.
- [ ] Tests: lock copy for each case incl. a line missing from the transcript (Review Focus 1); clipSeconds(0.8)=2, (7.2)=8, (15)=15; ffmpeg args; generate params exactly; note appended; upload failure → no generate call; audioSig in meta.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: lip-synced clips of Jon".

### Task 6: Voiceover changed
**Files:** Modify `js/presenter.js`, `js/redo.js` (`applyJobs`: after a VOICEOVER job turns done, call the check); Test `tests/presenter.test.mjs`.
**Interfaces:** `checkClipAudio(ctx, transcript, wav) -> Promise<void>`: for each presenter asset whose chosen take is done and has `audioSig`, re-cut the line (same ffmpeg as Task 5 to `<film>\studio\presenter\check_<id>.wav`), compare length (±0.01) and hash; differing → `asset.staleReason = "voiceover"`; same → clears a voiceover staleReason. Running/queued takes are skipped and checked when they finish (Review Focus 5). `keepAnyway(ctx, id)` clears `staleReason` and records `keptAt`. `deriveWaiting` counts stale clips ("1 clip out of step").
- [ ] Tests: unchanged audio → no flag; changed hash → flag; moved in time only (same audio, other start) → no flag; running take skipped then checked on finish; keepAnyway clears; waiting text.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: clips flag a changed voiceover".

### Task 7: On camera step, cards, skill file, publish
**Files:** Create `js/ui/oncamera.js`; Modify `js/ui/review.js` (step above the shots; conflict note + Remove on b-roll cards; presenter cards with stale copy and Keep anyway), `js/app.js` (actions: suggestLines, setCameraLines, suggestLooks, setLook, makePortraits, approvePortrait, keepAnyway; estimates fetched when the step opens and after a look/portrait change), `css/studio.css`, `docs/acceptance-slice1.md` (section "Jon on camera (version 25)", incl. setting `presenter.photos`), Create `../skills/documentary-explainer-script/SKILL.md` (copy of Jon's current skill with the spec's "A: the script skill" rules added to "Line script for Autocue Studio" and the handover list); Test `tests/oncamera.test.mjs`.
**Interfaces:** `onCameraModel({state, lineScript, transcript, estimates, photosOk}) -> {lines, canSuggest, look, portraits, approvedN, buttons: {portraits: {label, enabled}}}`; `render(el, model, actions)`.
- [ ] Tests: model for script-marked lines ("from the script"), no marks (Suggest lines shown), missing photos (button disabled with Probe copy), cost labels incl. "(cost unknown)" two-click confirm, approved portrait shown, conflict note copy on a b-roll card, stale copy and Keep anyway on a clip card.
- [ ] Run → FAIL; implement; `npm test` → PASS; Playwright stub check at 1280/390 (no horizontal scroll); commit; push; publish with `capabilities: { desktop: {}, mcp: { servers: [ {server: "Higgsfield", tools: ["generate_image","generate_video","jobs_wait","models_explore","balance","media_upload","media_confirm","estimate_image_cost","estimate_video_cost"]}, {server: "ElevenLabs", tools: ["creative_create_flow","creative_add_flow_node","creative_run_flow_nodes","creative_get_flow_run_status","account_get_usage"]} ] }, sample: { images: true } }`.
