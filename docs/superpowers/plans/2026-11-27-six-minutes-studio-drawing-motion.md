# Drawing Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 3D in Blender models the drawing it can see and checks its render against it before a slow turn; Animate with ComfyUI turns a drawing into an image-to-video shot; any 3D/animated version can be removed.

**Architecture:** Claude gets pictures through `sample` images (host option + a small `js/images.js`). The Blender take becomes one multi-stage gpu job (`js/tools/blender.js`: write → still → compare ×≤3 → render), its Claude prompts in `js/tools/blenderprompts.js`. `animated` is a new derived kind run by the ComfyUI runner with an i2v workflow from settings. `redo.js` gains `addAnimated` and `removeVersion`; the Review cards gain the buttons.

**Tech Stack:** ES modules, `node --test` with `tests/fake-host.mjs`; Blender 5 Python (generated); ComfyUI API workflows.

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-drawing-motion-design.md`

## Global Constraints
- Images: `sample(input, { images: Blob[] })`; declared `capabilities: {sample: {images: true}}`; `sample.limits()` has `images` only where they can be sent; else calls reject `images_unavailable`.
- Script contract: `blender -b --python-exit-code 1 -P script.py -- <source> <output> [--still <png>]`; `--still` renders frame 1 only to the PNG; 1920x1080, 24 fps, H.264 MP4 with the Blender 5 media_type lines (`ensureVideoMediaType` stays).
- Look: Freestyle lines amber #d5a867 (white when the drawing is white), slight wobble, grain strokes as marked edges, black surfaces, world #03070c–#091a2e; solid geometry matching the drawing; no image cards, no point/pixel clouds.
- Motion default: object turns about its own vertical centre axis, eased, ~70°, camera still; frame 1 = the drawing's view.
- Check loop: at most 3 stills; blank twice in a row fails with "The 3D render came out blank. Redo with a note."
- No image support: the take fails with "Claude can't see pictures in this view yet. Allow pictures for Six Minutes Studio when it asks, then press Run again."
- Remove confirm copy: "Remove HF-02 from the review? Its takes stay on disk." (id substituted). Refused while a take runs.
- i2v not set: button disabled, title "Set up the image-to-video workflow (see Probe)".
- Derived ids: next free HF number; removed assets go to `state.removed` with `removedAt`; nothing on disk changes.
- No credits spent; never delete or overwrite takes.

## Review Focus
1. A viewer without image support → Blender take fails with the copy above before any Blender run (Task 3 test).
2. The still render itself crashes (script error) → Blender's error text goes to Claude as that round's compare input and counts as a round; three crashes → the take fails with Blender's last error (Task 3 test).
3. Remove while a take of that version is queued/running → refused (Task 4 test).
4. Animate pressed before `comfy.i2v.workflow` exists → the runner refuses with the setup copy; the button is disabled (Tasks 5, 6 tests).
5. A job interrupted after round 2 → Run again resumes from the last round's script file and doesn't redo finished rounds (Task 3 test).

---

### Task 1: Pictures to Claude
**Files:** Create `six-minutes-studio/js/images.js`; Modify `js/host.js` (claude.json/text pass `images`; `claude.limits()`), `tests/fake-host.mjs` (record `opts.images`, scripted `limits`); Test `tests/images.test.mjs`.
**Interfaces:** Produces `readImages(host, paths: string[]) -> Promise<Blob[]>` (type from extension: png, jpg/jpeg, webp; unknown → throws "Can't send <name> to Claude: not a PNG, JPEG or WebP picture."); `canSendImages(host) -> Promise<boolean>` (`host.claude?.limits` → `!!(await limits()).images`, false on any error); `host.claude.json(input, { tier, images })`.
- [ ] Tests: readImages types and order; an unknown extension throws the copy; canSendImages true/false/limits-throws→false; host passes `images` through to `sample.json` options (stub sample) and omits the key when none.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: Claude can be shown pictures".

### Task 2: Blender prompts (pure)
**Files:** Create `js/tools/blenderprompts.js`; Test `tests/blenderprompts.test.mjs`.
**Interfaces:** Produces `SCRIPT_INSTRUCTIONS` (the full script contract from Global Constraints and the spec's "script contract" section, incl. `--still`), `CHECK_INSTRUCTIONS` (compare the drawing (image 1) and the still (image 2), or Blender's error text when no still; answer `{"verdict":"matches"|"fix"|"blank","note":"<one line>","script":"<full script when fix or blank>","frames":<int, when fix>}`), `validateScript(v)` (`{script, frames 1..2400}`), `validateCheck(v)` (verdict enum; `script` required for fix/blank; `note` non-empty string).
- [ ] Tests: SCRIPT_INSTRUCTIONS contains "--still", "Freestyle", "#d5a867", "vertical", "70", "never" image cards / "point" clouds wording; CHECK_INSTRUCTIONS names image 1 = drawing, image 2 = still; validators accept good and reject each bad shape.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: Blender prompts that see the drawing".

### Task 3: The Blender take: model, check, render
**Files:** Modify `js/tools/blender.js` (runner stages; `writeBlenderScript` removed or reduced to a helper used by the runner), `js/redo.js` (startTake's blender branch: no Claude call before the job; `META` gains `checks`, `script`); Test `tests/blender.test.mjs` (extend).
**Interfaces:**
- Consumes: Task 1 `readImages`, `canSendImages`; Task 2 prompts/validators; `askJson(host, {instructions, data, tier, validate, images})` (Task 1 adds `images` pass-through to `askJson` → `host.claude.json`).
- job.input for blender: `{ kind: "blender", asset: {id, desc, line}, take: n, note?: string, previousScript?: path, sourceFile, base, out }` where `base` = `<film>\studio\blender\<id>_t<n>` and `out` = media mp4 as today.
- Files: round k script `${base}_r${k}.py`, still `${base}_check${k}.png`, final `${base}.py` (copy of the chosen round).
- Result: `{ file: out, meta: { script: `${base}.py`, checks: [{ round, still: path|null, verdict, note }] } }`; progress text "Modelling", "Check k of 3", then frame progress as today.
- [ ] Tests (FakeHost: scripted `spawn` for blender writing the still/mp4 files; scripted claude):
  - happy path: script → still → "matches" → render; Claude's check call got 2 images (drawing, still); meta.checks length 1.
  - fix then matches: round 2 script written as `_r2.py`; render uses it; `.py` final equals r2.
  - blank twice → fails with the blank copy, no mp4 render spawned.
  - still crash: Blender exit 1 on `--still` → check call gets `blenderError` text and no still image; three crashes → take fails with Blender's error.
  - no image support → fails with the copy before any spawn.
  - resume: `_r2.py` and `_check2.png` exist with a saved verdict file (`${base}_check2.json` written each round) → Run again starts at round 3 / render, not round 1.
  - redo: `previousScript` and `note` reach the first script call; the previous take's last still is sent as a third image when present.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: Blender takes model the drawing and check themselves".

### Task 4: Derived versions: animated kind, add and remove
**Files:** Modify `js/redo.js`, `js/shots.js`; Test `tests/redo.test.mjs` (or the existing file covering addBlender3d).
**Interfaces:** Produces `hasDerived(assets, lineartId, kind)`; `addAnimated(ctx, lineartId) -> id` (kind `animated`, tool `comfyui`, desc `Animated version of <desc>`, draftPrompt `<desc>; slow orbit around it, keep the hand-drawn amber line-art style on black, no new colours`); `removeVersion(ctx, id) -> void` (only kinds blender/animated; refuses while a take is queued/running or pending: "<id> has a take in progress."; moves the asset to `state.removed` with `removedAt: host.now()`; logs "<id> removed from the review (takes kept on disk)"). `has3d` keeps working (blender kind only). `canStart` treats `animated` like `blender` (source drawing approved). shots.js accepts `animated` with tool `comfyui` (not produced by the shot plan).
- [ ] Tests: addAnimated ids/desc/prompt; second addAnimated refused; removeVersion moves to removed and the drawing can get a new version with a new id; refused while running; refused for a lineart/broll shot; startTake for an animated asset builds `input = { kind: "animated", prompt, out: <mp4>, sourceFile }`.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: animated versions, and removing a 3D or animated version".

### Task 5: ComfyUI image-to-video
**Files:** Modify `js/settings.js` (`comfy.i2v` default `{ workflow: null, nodes: {} }`, filled `workflow` default `<root>\ComfyUI workflows\animate_i2v.json` like the b-roll one), `js/tools/comfyui.js` (kind `animated`: read `comfy.i2v.workflow`, upload `sourceFile` with `curl -F image=@<file> -F overwrite=true <url>/upload/image`, set `nodes.image` to the returned name, fill prompt/seed/length?/output as `fillWorkflow` with `nodes` = i2v nodes), `js/ui/probe.js` (row "Animate workflow": pass when the file exists and `nodes.image`, `nodes.prompt`, `nodes.output` are set; else what's missing); Test `tests/comfyui.test.mjs` (extend), `tests/probe.test.mjs`.
**Interfaces:** `i2vReady(host, comfy) -> Promise<{ok, why}>` (also used by the UI); runner refuses kind animated when not ready with "Set up the image-to-video workflow (see Probe)".
- [ ] Tests: upload call args and image node filled with the uploaded name; missing workflow → refusal copy; Probe row pass/fail texts; b-roll path unchanged.
- [ ] Run → FAIL; implement; `npm test` → PASS; commit "Studio: animate a drawing in ComfyUI".

### Task 6: Review cards, checklist, publish
**Files:** Modify `js/ui/review.js` (line-art card: "Animate with ComfyUI" beside "Make 3D in Blender", disabled with the i2v title when not ready; derived cards: "Remove this version" with an inline confirm row using the copy; blender take rows: last check still thumbnail + the check notes), `js/app.js` (actions `animate`, `removeVersion`; i2v readiness cached on review open and after Probe), `css/studio.css`, `docs/acceptance-slice1.md` (a "Drawings that move (version 21)" section, incl. how to save ComfyUI's LTX image-to-video template as `animate_i2v.json` in API format and fill `comfy.i2v.nodes`); Test `tests/viewmodel.test.mjs`.
- [ ] Tests: card model flags (`canAnimate`, `animateWhy`, `canRemove` false while running); confirm row copy; check notes listed on a blender take.
- [ ] Run → FAIL; implement; `npm test` → PASS; Playwright stub check at 1280/390 (buttons, confirm, notes); commit; push; publish with `capabilities: { desktop: {}, mcp: { servers: [ <the two existing entries unchanged> ] }, sample: { images: true } }`.
