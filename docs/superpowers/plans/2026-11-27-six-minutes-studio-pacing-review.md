# Pacing Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A line-by-line pacing review in the Mix preview step: rolling lines, a note and Re-record per line, ‖ pause marks placed by Claude from notes or by Jon's click, and Apply pauses (join with pauses → refit → remix).

**Architecture:** `voiceover_join.py` learns `--pauses <json>` (silence inside a line at a time, extra gap after a line) and reports tight cuts. Studio keeps marks in `state.mix.pacing`, tied to a word and its occurrence, and turns them into the pauses file afresh at each Apply (`js/pacing.js`, pure). A chain (`js/pacingchain.js`) runs join → SFX shift → fit → mix with the existing step functions. The UI (`js/ui/pacing.js`) renders inside the MIX step and follows the playing audio element.

**Tech Stack:** Python 3 + numpy (autocue-studio, unittest); plain ES modules (Studio, `node --test`); Playwright stub run for the UI check.

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-pacing-review-design.md`

## Global Constraints

- Pause sizes: Short 0.3 s, Medium 0.6 s, Long 1.0 s; a clicked word gets Medium.
- Inside pauses go at the quietest 10 ms within ±0.15 s of the asked point, with 5 ms crossfades (`STALL_XFADE_S`). Never refused: a window above the part's voice threshold is reported as tight.
- Without `--pauses` the join's output is byte-identical to today's.
- Nothing is rebuilt until Apply pauses. Claude only places marks or replies; it never starts a join.
- Jon's marks (`by: "jon"`) are never replaced by Claude; Claude's replace Claude's on that line.
- A Stem Remixer export (`fit.source === "stemremixer"`) is never replaced by the chain.
- Never delete or overwrite takes or exports; earlier outputs move aside as now. No voice recordings in the repo.
- After any change to `autocue-studio/voiceover_join.py`, run `node scripts/embed-autocue.mjs` (the bundle test fails otherwise).
- Works at 390 px wide: the note box wraps under the line text.
- Copy (exact): "Tight cut: have a listen", "The take changed. Place again", "Couldn't find this word. Place again", "Apply pauses", "Place pauses", "Re-record".

## Review Focus

1. A mark whose word Whisper transcribes differently after a rejoin → greyed "Couldn't find this word. Place again", not sent, never crashes the chain (Task 2 test).
2. A silent take (digital silence, no transcript words) → line shows script text, only the gap ＋ works; inside marks impossible (Task 2 and Task 7 tests).
3. Notes or marks edited while the chain runs → saved; Apply disabled until the chain ends; the change lights Apply again after (Task 5 test).
4. Studio closed mid-chain → on reopen the chain does not resume; the step that was running shows Interrupted as today and Apply pauses is lit because `appliedSig` ≠ current marks or the join didn't finish (Task 5 test).
5. Two marks after the same word, or a mark after a line's last word → merged into one (largest size) / converted to the gap mark (Task 2 test).

---

### Task 1: `voiceover_join.py --pauses`

**Files:**
- Modify: `autocue-studio/voiceover_join.py` (`build_clip`, `assemble`, `join`, `_parser`)
- Modify: `six-minutes-studio/js/autocue-bundle.js` (regenerated)
- Test: `autocue-studio/tests/test_voiceover_join.py`

**Interfaces:**
- Produces: CLI `--pauses PATH` reading `{"inside": {"<id>": [{"at_s": float, "add_s": float}]}, "after": {"<id>": float}}`; done JSON gains `"tight": [{"id": str, "at_s": float}]` (always present, `[]` without pauses) and `"pauses": {"inside": int, "after": int}` (counts applied).
- Produces: `insert_pauses(x, pauses, rate=RATE) -> (y, tight_at_s_list)`; `build_clip(parts, rate=RATE, inside=None, after=None)` where `inside` is a list (per part) of pause lists and `after` a list (per part) of extra seconds after that part; `assemble(..., after=None)` where `after` is a list (per clip) of extra seconds added to the gap following that clip.

- [ ] **Step 1: Write the failing tests** in `tests/test_voiceover_join.py` (class `TestPauses`):
  - `test_inside_pause_adds_silence_at_the_gap`: a part = 0.5 s tone, 0.08 s silence, 0.5 s tone at 48 kHz; `insert_pauses(x, [{"at_s": 0.54, "add_s": 0.6}])` → `len(y) == len(x) + round(0.6*48000)`; the samples from 0.5 s to 1.18 s are all below −60 dBFS; `tight == []`.
  - `test_inside_pause_moves_to_the_quietest_point`: same part, `at_s = 0.40` (inside the first tone, the gap within 0.15 s) → the inserted run of silence starts between 0.5 s and 0.58 s.
  - `test_words_run_together_still_get_the_pause_flagged`: a part of 1.2 s continuous tone, `at_s = 0.6` → length grows by 0.6 s and `tight == [0.6 ± 0.15]`.
  - `test_after_gap_adds_to_sentence_and_clip_gaps`: `build_clip([a, b], after=[0.3, 0.0])` is 0.3 s longer than `build_clip([a, b])`; `assemble(clips, sections, after=[0.5, 0])` puts clip 2 0.5 s later than without.
  - `test_no_pauses_is_unchanged`: `join` on the existing fixture with and without an empty `--pauses` file (`{}`) gives identical WAV bytes and timings.
  - `test_done_line_reports_tight_and_counts`: a `join` run with one inside and one after pause → done JSON has `pauses == {"inside": 1, "after": 1}` and `tight` a list.
  - `test_transcript_offsets_follow_after_gaps`: with `after` on the first line of a clip, the second sentence's transcript `start` moves later by that amount (fake transcriber as existing tests use).
- [ ] **Step 2: Run** `cd autocue-studio && python3 -m unittest tests.test_voiceover_join -v` → the new tests FAIL (`insert_pauses` not defined / unexpected keyword).
- [ ] **Step 3: Implement.**
  - `insert_pauses`: for each pause (sorted by `at_s`, positions shifted by silence already inserted), search 10 ms windows whose centre is within ±0.15 s of `at_s` (clamped to the part); pick the lowest RMS; tight when that RMS ≥ the part's voice threshold `max(VOICE_MIN_DBFS, _noise_dbfs(x) + VOICE_OVER_NOISE_DB)`; split at the window centre, fade the left side out and the right side in over `STALL_XFADE_S` (equal power, as `tighten_stalls`), put `add_s` of zeros between.
  - `build_clip`: per part `set_rms`, then `insert_pauses(part, inside[i])`, then the gap `SENTENCE_GAP_S + after[i]` before the next part, then `limit`. Returns `(audio, tight)` only when `inside` is given; keep the old one-value return when called as today (existing callers and tests).
  - `assemble`: gap after clip `i` gains `after[i]`.
  - `join`: read `--pauses` (missing keys = none); pass inside/after per line; the last line of a clip's `after` goes to `assemble`'s `after` for that clip, others to `build_clip`; `placed` offsets follow the real gaps and the inserted silence (use each part's length after insertion); tight `at_s` reported in line time before insertion.
- [ ] **Step 4: Run** `python3 -m unittest discover -s tests` → all pass (existing ones too).
- [ ] **Step 5: Regenerate the bundle:** `cd ../six-minutes-studio && node scripts/embed-autocue.mjs && npm test` → all pass.
- [ ] **Step 6: Commit** `autocue-studio/voiceover_join.py autocue-studio/tests/test_voiceover_join.py six-minutes-studio/js/autocue-bundle.js` — "Autocue Studio: the join takes pauses (--pauses), flags tight cuts".

### Task 2: Marks and the pauses file (`js/pacing.js`, pure)

**Files:**
- Create: `six-minutes-studio/js/pacing.js`
- Test: `six-minutes-studio/tests/pacing.test.mjs`

**Interfaces:**
- Consumes: transcript JSON `{sentences: [{sentence, text, start, end}], words: [{word, start, end, sentence}]}`.
- Produces:
  - `PAUSE_S = { short: 0.3, medium: 0.6, long: 1.0 }`
  - `norm(word) -> string` (lowercase, letters/digits/apostrophes only)
  - `lineWords(transcript, id) -> [{word, start, end, i, nth}]` (`nth` = 1-based occurrence of `norm(word)` in the line)
  - `addMark(line, { after, word, nth, size = "medium", by })` / `setSize(line, key, size)` / `moveMark(line, key, dir, words)` / `removeMark(line, key)` — each returns a new line object; `key` is `"end"` or `` `${norm(word)}#${nth}` ``. A mark after the line's last word becomes the `"end"` mark; two marks with one key merge keeping the larger size and `by: "jon"` if either is Jon's.
  - `markState(mark, words, line, takeSig) -> "ok" | "take-changed" | "not-found"`
  - `toUnpaused(posPaused, applied) -> number` where `applied` = the line's inside pauses sent last time `[{at_s, add_s}]`.
  - `buildPauses(pacing, transcript, applied, takeSigs) -> { file: {inside, after}, skipped: [{id, key, reason}] }` (`at_s` = `toUnpaused(midpoint(word.end, next.start) - sentence.start, applied[id])`, rounded to ms).
  - `marksSig(pacing, takeSigs) -> string` (stable JSON of sendable marks only).
  - `takeSig(row) -> string` from a narration row (`file` + `takeS`).

- [ ] **Step 1: Write the failing tests:**
  - `lineWords counts occurrences`: words "Pictish village in Orkney Pictish he" → the second "Pictish" has `nth === 2`.
  - `toUnpaused`: `toUnpaused(3.0, [{at_s: 1.0, add_s: 0.6}]) === 2.4`; `toUnpaused(0.8, [{at_s: 1.0, add_s: 0.6}]) === 0.8`; two applied pauses before → both subtracted.
  - `buildPauses places the second Pictish`: transcript with "Pictish"(2) ending 2.30 and "he" starting 2.52, sentence start 0 → `file.inside["02.1"] == [{at_s: 2.41, add_s: 0.6}]`.
  - `gap mark`: `{key: "end", size: "short"}` → `file.after["02.1"] === 0.3`.
  - `not found`: a mark on "Pictish"#3 → in `skipped` with `reason: "not-found"`, not in `file`.
  - `take changed`: mark stored with `take: "a"`, current sig `"b"` → inside mark skipped `reason: "take-changed"`; its gap mark still sent.
  - `last word becomes the gap`: `addMark` after the final word → `key === "end"`.
  - `merge`: Claude "medium" + Jon "long" on one key → one mark, `size: "long"`, `by: "jon"`.
  - `silent line`: no words for the id → inside marks skipped `not-found`, gap mark sent.
  - `marksSig` ignores notes and skipped marks; changes when a size changes.
- [ ] **Step 2: Run** `node --test tests/pacing.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement** the functions above. Store shape per spec: `state.mix.pacing = { lines: { [id]: { note, noteAt, placedAt, reply, rerecord, take, pauses: [{key, word, nth, size, by}] } }, appliedSig, applied: { [id]: [{at_s, add_s}] } }`.
- [ ] **Step 4: Run** `node --test tests/pacing.test.mjs` → PASS.
- [ ] **Step 5: Commit** — "Studio: pacing marks tied to words, and the pauses file".

### Task 3: Claude places marks from notes

**Files:**
- Modify: `six-minutes-studio/js/pacing.js`
- Test: `six-minutes-studio/tests/pacing.test.mjs`

**Interfaces:**
- Consumes: `askJson(host, { instructions, data, tier: "quick", validate })` from `js/claude.js`; Task 2's `lineWords`, `addMark`.
- Produces: `PLACE_INSTRUCTIONS` (string); `notesToPlace(pacing) -> ids` (note non-empty and `noteAt > (placedAt ?? 0)`); `async placeFromNotes(host, store, { transcript, lineScript }) -> { placed: ids, replies: ids }` — one Claude call for all ids; data per id: `{ id, text, words: [{i, word}], note, before, after }` (neighbour line texts). Answer: `[{ id, pauses: [{ after: int | "end", size }] } | { id, reply: string }]`. Writes with `store.update`: replaces that line's `by: "claude"` marks, keeps Jon's, sets `placedAt = host.now()`, `reply` (or null). Logs "Pauses placed for …".

- [ ] **Step 1: Failing tests** (fake `host.claude.json`):
  - places a Medium mark after word index 4 on 02.1 from a note; Jon's existing mark on 02.1 stays.
  - a reply answer ("This sounds like a delivery change: tick Re-record") is stored as `reply`, no marks changed.
  - `validate` rejects an index outside the words and a size not in `PAUSE_S` → `ClaudeError` code `invalid`, nothing written.
  - only lines with notes newer than `placedAt` are sent (assert on `data`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Instructions: British English; pauses only where the note asks; prefer `"end"` for "after this line"; answer `reply` when the note is about delivery or wording. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — "Studio: Claude places pause marks from Jon's notes".

### Task 4: The join takes the marks

**Files:**
- Modify: `six-minutes-studio/js/tools/voicejoin.js` (`joinArgs`, runner meta), `six-minutes-studio/js/mixplan.js` (`startJoin`, `mixJobDone`, new `pacingStale`)
- Test: `six-minutes-studio/tests/voicejoin.test.mjs`, `six-minutes-studio/tests/mixplan.test.mjs` (or the existing test files that cover these)

**Interfaces:**
- Consumes: Task 2's `buildPauses`, `marksSig`.
- Produces:
  - `joinArgs(settings, { ..., pauses })` appends `--pauses <path>` when `pauses` is a non-empty string.
  - runner `meta.tight` (from done `tight`) copied by `mixJobDone` onto the VOICEOVER holder.
  - `startJoin(ctx, { allowFlagged, pauses = null })` where `pauses = { file, sig, applied, allowedIds }`: writes `file` as JSON to `studio\mix\<project>_pauses.json`, passes its path, and stores `pausesSig: sig`, `pausesApplied: applied`, `allowedIds` on the holder. Without `pauses`, stores `pausesSig: null`, `pausesApplied: {}`, and `allowedIds` = the not-OK ids passed by the caller (`ctx.notOkIds ?? []`).
  - `pacingStale(state, currentSig) -> boolean`: voiceover done and `(vo.pausesSig ?? marksSig(empty)) !== currentSig`.

- [ ] **Step 1: Failing tests:** `joinArgs` with `pauses: "S:\\f\\p.json"` ends with `["--pauses", "S:\\f\\p.json"]` and without it is unchanged; a done job with `tight` lands on `state.mix.voiceover.tight`; `startJoin` with pauses writes the JSON file (FakeHost) and the holder has `pausesSig`; `pacingStale` true after a size change, false right after a join with that sig.
- [ ] **Step 2: Run** `npm test` → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — "Studio: the voiceover join carries the pause marks".

### Task 5: Apply pauses chain

**Files:**
- Create: `six-minutes-studio/js/pacingchain.js`
- Test: `six-minutes-studio/tests/pacingchain.test.mjs`

**Interfaces:**
- Consumes: `startJoin`, `startFit`, `startMix`, `waitJob` (mixplan), `buildPauses`, `marksSig`, `takeSig` (Task 2), `parseCsv`.
- Produces:
  - `canApply({ state, narration, sig, running }) -> { ok: boolean, why: string | null }`: not while any of VOICEOVER/FIT/MIX is live or the chain runs; not when not-OK lines exist that are neither Re-record nor in `vo.allowedIds` (why: `Newly flagged: 03.2. Use Join anyway first.`).
  - `shiftJonStarts(sfx, oldTranscript, newTranscript, oldApplied, newApplied) -> [{id, startS}]`: for each cue with `startSBy === "jon"`, find the line whose old `[start, nextStart)` holds `t`; `new = newStart + toUnpaused-adjusted offset` (offset in that line, plus the new inside silence before it, minus the old); a time before the first line is unchanged.
  - `async applyPauses(ctx, { onStep }) -> { stoppedAt: null | "FIT" }`: reads the current transcript JSON (old) before joining; `startJoin` with `pauses` and `allowFlagged = true` when any Re-record or allowed id is not OK; waits on the join's job id (from `store.state.mix.voiceover.jobId`); updates `pacing.appliedSig`/`applied`; writes Jon's shifted SFX starts via `editItem` semantics (keeps `startSBy: "jon"`); if `fit.source === "stemremixer"` stops (`stoppedAt: "FIT"`); else `startFit(ctx, { note: fit.note ?? undefined })`, waits, `startMix(ctx)`, waits. `onStep("VOICEOVER" | "FIT" | "MIX")` for the UI line "Applying pauses: fitting the score…".

- [ ] **Step 1: Failing tests** (FakeHost + a fake jobs object that finishes jobs on demand):
  - the chain starts join → fit (with the previous note) → mix in order, each after the previous job is done.
  - a Stem Remixer fit stops after the join with `stoppedAt: "FIT"`; no fit job added.
  - a join failure rejects and starts nothing else.
  - `shiftJonStarts`: a Jon cue at 10.0 s in line 02.1 (old start 8.0, new start 8.3, a 0.6 s pause inserted at 1.0 s into the line) → 10.9; a Claude cue isn't returned.
  - `canApply` false while running, false with a newly flagged line, true with only Re-record lines.
  - (Review Focus 4) after a simulated restart (state with VOICEOVER `failed`/interrupted and an old `appliedSig`), `pacingStale` is true so Apply is offered again; nothing auto-starts on load.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — "Studio: Apply pauses joins, refits and remixes in turn".

### Task 6: Re-record

**Files:**
- Modify: `six-minutes-studio/js/pacing.js` (helpers), `six-minutes-studio/js/ui/review.js` (`narrationModel`), `six-minutes-studio/js/narration.js` (`STATUS_LABEL`), `six-minutes-studio/js/ui/mix.js` (`NOT_OK` gains `"rerecord"`)
- Test: `six-minutes-studio/tests/narration.test.mjs`, `six-minutes-studio/tests/pacing.test.mjs`

**Interfaces:**
- Produces: `withRerecord(narration, pacing) -> narration` (rows whose `pacing.lines[id].rerecord.at` is later than `takeS * 1000` get `status: "rerecord"`, `flag: note ?? "Marked to re-record"`; counts gain `rerecord`); `rerecordsToClear(narration, pacing) -> ids` (take newer than the tick); `STATUS_LABEL.rerecord = "Re-record"`. Studio calls `withRerecord` where `r.narration` feeds the models, and clears ticks returned by `rerecordsToClear` with one `store.update` in `refreshNarration`.

- [ ] **Step 1: Failing tests:** a ticked line shows `Re-record` with the note as reason; a take newer than the tick → `rerecordsToClear` returns it and `withRerecord` leaves the row as its checked status; Join's label becomes `Join anyway (1 not OK)` with one Re-record line.
- [ ] **Step 2–4:** run → FAIL, implement, run `npm test` → PASS.
- [ ] **Step 5: Commit** — "Studio: lines marked Re-record until a new take arrives".

### Task 7: The review UI and wiring

**Files:**
- Create: `six-minutes-studio/js/ui/pacing.js`
- Modify: `six-minutes-studio/js/ui/mix.js` (MIX step body shows the review even when locked; model gets `pacing`), `six-minutes-studio/js/app.js` (load transcript, actions, highlight, fallback player slot `"review"`), `six-minutes-studio/css/studio.css`
- Test: `six-minutes-studio/tests/pacingui.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `pacingModel({ state, transcript, narration, lineScript, sig, chain, canApply }) -> { lines: [{ id, start, end, text, words: [{i, word, key, mark: {size, by, state, tight} | null}], gap: {size} | null, note, reply, rerecord, takeChanged }], counts: "3 pauses marked · 1 line to re-record", apply: { enabled, label: "Apply pauses", why }, place: { enabled, label: "Place pauses" | "Placing…" }, source: "mix" | "voiceover", status }`. `source` is `"mix"` when the mix is done and `x.fromVoiceoverAt === vo.at`, else `"voiceover"` (with status "Playing the voiceover: the mix is older than it." when a mix exists).
  - `pacingSection(m, actions) -> Element` with `ul.pace > li[data-start][data-end]`; ids are buttons (`actions.seekReview(start)`); words are buttons (`actions.markWord(id, i)`); a ‖ is a button opening an inline menu (Short / Medium / Long / ◀ / ▶ / Remove → `actions.editMark(id, key, op)`); the ＋ after a line (`actions.markGap(id)`); a note textarea saved on blur (`actions.saveNote(id, text)`, fields pattern as in `audio.js`); a Re-record checkbox (`actions.setRerecord(id, bool)`).
  - Tight marks show "Tight cut: have a listen"; `take-changed` / `not-found` marks greyed with their copy.
  - `followPlayer(el, list)`: on `timeupdate`, toggles `.now` on the `li` whose `[start, end)` holds `currentTime` and `scrollIntoView({ block: "nearest" })` only when it changed; no re-render.
  - `app.js`: reads `vo.transcript` JSON once per `vo.at` into `app.review.transcript`; actions call Task 2/3/5/6 functions through `store.update`; Apply runs `applyPauses` with `onStep` → `render()`; the review uses the mix player when `source === "mix"`, else `audioEl("review", vo.wav, playerKey(vo.wav, vo.at), "the voiceover")`.

- [ ] **Step 1: Failing tests** (stub DOM as `tests/playtoggle.test.mjs`): the model highlights nothing at rest; marks render as ‖ after the right word; a silent line has no word buttons but a ＋; `source` is `"voiceover"` when the mix is older than the join; Apply disabled with the `why` text while the chain runs (Review Focus 3); counts line text exact.
- [ ] **Step 2–4:** run → FAIL, implement, `npm test` → PASS.
- [ ] **Step 5: Browser check:** extend the scratchpad stub (`pw/stub5.js` pattern: FakeHost with a 20 s WAV, a transcript JSON and a line script) and confirm with Playwright at 1280 and 390 px: clicking a word adds ‖, the menu changes size, the highlight follows playback, no page errors. Screenshot both widths.
- [ ] **Step 6: Commit** — "Studio: pacing review under the mix player".

### Task 8: Checklist, publish

**Files:**
- Modify: `six-minutes-studio/docs/acceptance-slice1.md` (a "Pacing review" section: install the new join script from Probe; mark the second Pictish at 2:00, Apply, hear it; a Re-record tick clears after a new take; a Stem Remixer fit stops the chain)

- [ ] **Step 1:** Write the checklist section (steps Jon runs on the PC, each with what he should see).
- [ ] **Step 2:** Full runs: `npm test` (Studio), `python3 -m unittest discover -s tests` (autocue-studio), `python3 -m pytest -q tests` (stem-remixer, unchanged) → all pass.
- [ ] **Step 3:** Commit and push to `claude/compassionate-dijkstra-0fjt50`; publish the artifact (`index.html`, root `six-minutes-studio`, the changed files plus `js/pacing.js`, `js/pacingchain.js`, `js/ui/pacing.js`, `js/autocue-bundle.js`).
