# Prompter Bar and Collapsible Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sticky one-line prompter bar for the pacing review (transport, current line with clickable words, gap / note / re-record) and ▾/▸ collapsing for every Review section.

**Architecture:** `js/ui/prompter.js` renders the bar from the existing `pacingModel` output plus the current line index; it updates itself from the followed audio element's `timeupdate` (no full re-render), reusing the pacing actions. Collapsing is a small `js/ui/fold.js` helper (state in localStorage) used by each section heading.

**Tech Stack:** ES modules, `node --test`, Playwright stub check.

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-prompter-bar-design.md`

## Global Constraints

- The bar only appears when the pacing review is available (a joined voiceover); it controls the element the review follows (`reviewEl()` in app.js).
- Word / ‖ / ＋ gap / Note / Re-record behave exactly as in the list (same actions, same new-take and greyed rules).
- localStorage wrapped in try/catch; all sections open by default; key `studio.fold.<section>`.
- Phone width (390 px): bar wraps to two rows, line text truncates with an ellipsis, full text in `title`; no sideways scroll.
- Copy: buttons "Previous line", "Next line" (aria-labels for ⏮ ⏭), "＋ gap", "Note…", "Re-record"; fold buttons aria-label "Fold <name>" / "Unfold <name>".

## Review Focus

1. Pressing ⏭ on the last line / ⏮ before the first → stays put, no error (Task 1 test).
2. The element changes (mix becomes current, rejoin drops the review player) → the bar re-attaches or hides, never controls a detached element (Task 1 test on `attach` with a null element).
3. Typing in the bar's note box while audio plays → the timeupdate refresh never replaces the box or loses text (Task 1 test).
4. A collapsed Voiceover and mix → the bar still plays and follows (Task 2 test: collapsing only hides content, the audio element stays mounted).
5. localStorage throwing → sections render open, toggling still works for the session (Task 2 test).

---

### Task 1: The prompter bar

**Files:**
- Create: `six-minutes-studio/js/ui/prompter.js`
- Modify: `six-minutes-studio/js/app.js` (mount the bar under the sticky header in the review view; attach it alongside `attachFollow`), `six-minutes-studio/css/studio.css`
- Test: `six-minutes-studio/tests/prompter.test.mjs`

**Interfaces:**
- Consumes: `pacingModel(...)` output `m.lines[]` (`{id, start, end, text, words[{i, word, key, mark}], gap, note, rerecord, newTake…}`) and the pacing actions in app.js (`markWord`, `editMark`, `markGap`, `saveNote`, `setRerecord`, `seekReview`).
- Produces: `lineAt(lines, t) -> index` (last line whose start ≤ t; 0 before the first); `prompterBar(m, actions) -> { el, attach(audioEl | null), update() }` where `attach` (re)binds `timeupdate`/`play`/`pause`/`seeked` and returns nothing; re-attaching the same element is a no-op; `null` hides the bar.

- [ ] **Step 1: Failing tests** (stub DOM as `tests/pacingui.test.mjs`): `lineAt` (before first → 0, inside line 2 → 1, after last → last); ⏭ on the last line and ⏮ on the first don't seek; the bar shows the first line before playback; clicking a word calls `markWord(id, i)`; the note box keeps typed text across `update()` calls and saves on blur; `attach(null)` hides the bar; time text `"2:01 / 6:40"`.
- [ ] **Step 2:** `node --test tests/prompter.test.mjs` → FAIL.
- [ ] **Step 3:** Implement; ⏮ seeks to the previous line's start (or this line's start if more than 1.5 s into it), ⏭ to the next line's start; ❚❚/▶ toggles the element; `update()` only re-renders the line row when the line index or that line's marks change. Mount it in app.js once per review render with the current `pacingModel` output; position sticky under `.top` (`top: var(--toph)`), the b-roll `.sum` sticks below it.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Browser check (Playwright stub from the pacing review, scratchpad `pw/`): at 1280 and 390 the bar stays visible after scrolling to B-roll, pause/resume works, clicking a word adds ‖, no sideways scroll. Screenshots.
- [ ] **Step 6:** Commit "Studio: a prompter bar for the pacing review".

### Task 2: Collapsible sections

**Files:**
- Create: `six-minutes-studio/js/ui/fold.js`
- Modify: `js/ui/review.js` (Narration, B-roll), `js/ui/audio.js` (Score, Sound effects, Music and sound effects), `js/ui/mix.js` (Voiceover and mix), `css/studio.css`
- Test: `six-minutes-studio/tests/fold.test.mjs`

**Interfaces:**
- Produces: `isFolded(name) -> boolean`, `setFolded(name, bool)`, `foldButton(name, onToggle) -> Element` (▾ open / ▸ folded, aria-expanded). Sections render their heading row always and their content with `hidden` when folded; the mix player and review audio elements stay in the DOM when folded.

- [ ] **Step 1: Failing tests:** default open; toggling persists via a stub localStorage and survives a new read; a throwing localStorage → open by default and toggling works in memory; a folded Voiceover and mix keeps its audio element (rendered, hidden) so the prompter can still attach.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; toggling calls `actions.render()` (or the existing re-render path). **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Browser check at 390: fold all, page is short; unfold restores; the bar still plays with Voiceover and mix folded.
- [ ] **Step 6:** Commit "Studio: fold any Review section"; push; publish the artifact (changed files plus `js/ui/prompter.js`, `js/ui/fold.js`, `css/studio.css`); add two lines to `docs/acceptance-slice1.md` under "Pacing review".
