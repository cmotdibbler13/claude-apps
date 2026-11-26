# Six Minutes Studio: ComfyUI b-roll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** B-roll shots can be made by ComfyUI on Jon's PC (free) as well as Higgsfield, chosen per shot or by a per-film preference.

**Architecture:** A new `comfyui` runner on the GPU lane drives ComfyUI's HTTP API with curl (argument lists, no shell). It fills Jon's exported API-format workflow from a node map in settings, polls `/history`, and collects and crops the output with ffmpeg. The job engine resumes any runner with `resume` and a `jobRef`. Shots gain a tool switch, and films a "Prefer ComfyUI for b-roll" flag in `state.json`.

**Tech Stack:** As slice 1: vanilla ES modules, Node 22 `node:test`, FakeHost.

**Spec:** `docs/superpowers/specs/2026-11-26-six-minutes-studio-comfyui-design.md` (and the slice 1 spec and plan, whose Global Constraints still bind).

## Global Constraints
- Every slice 1 Global Constraint still holds (`docs/superpowers/plans/2026-11-26-six-minutes-studio-slice1.md`).
- Defaults:
  - ComfyUI URL `http://127.0.0.1:8188`;
  - output folder `C:\Users\Jon\AppData\Local\Comfy-Desktop\ComfyUI-Shared\output`;
  - workflow `<root>\ComfyUI workflows\broll_ltx.json`.
- LTX node map:
  - prompt `["364","text"]`;
  - width `["372","value"]` and height `["360","value"]`;
  - length `["362","value"]` (unit `"seconds"`);
  - fps `["361","value"]`;
  - seed `["339","noise_seed"]`;
  - output prefix `["9999","filename_prefix"]`.
- Render values: width 1920, height 1088, seconds 5, fps 24, expected clip time 240 s.
- Final b-roll file: `<film>\studio\media\<id>_t<n>.mp4`, cropped to 1920×1080 with no audio. It is written through `<…>.part.mp4` then renamed. ComfyUI's own output is never moved or deleted.
- ComfyUI calls: curl via `runProcess` (argument list, no shell). The POST body is written to a temp file under `<film>\studio\tmp\` and passed as `--data-binary @<file>`.
- Polling every 5 s, cap 60 min. Unreachable while waiting → 5 tries, then an ambiguous failure with "Couldn't reach ComfyUI; the render may still be running. Check again."
- Unreachable at submit → "ComfyUI isn't running at 127.0.0.1:8188. Open ComfyUI Desktop and press Run again." (use the configured URL's host:port).
- Tool label "ComfyUI". Copy: British English, sentence case.

## Review Focus
1. **App closed mid-render:** a ComfyUI job with a `jobRef` resumes by prompt id and never re-submits. Test: `jobs.test.mjs › restore resumes a gpu job with jobRef when its runner can resume`.
2. **Two GPU jobs at once:** a resumed ComfyUI job and a queued Blender job never run together. Test: `jobs.test.mjs › resumed gpu job holds the gpu lane`.
3. **Switching tool mid-take:** refused while a take is queued or running. Test: `redo.test.mjs › setTool refuses while a take is busy`.
4. **The history shape differs** (videos under `images`, `gifs` or `videos`): any entry with a `filename` is found, and none means failure, not a hang. Test: `comfyui.test.mjs › finds the output under images, gifs or videos`.
5. **A workflow node missing from the map:** reject before submitting, with the node id named. Test: `comfyui.test.mjs › missing mapped node rejects before submit`.

---

### Task 1: Settings and lane-agnostic resume
**Files:** Modify `js/settings.js`, `js/jobs.js`; tests in `tests/settings.test.mjs`, `tests/jobs.test.mjs`.
**Interfaces:**
- `DEFAULT_SETTINGS.comfy = {url, outputDir, workflow: null, nodes: {prompt, width, height, length, fps, seed, output}, lengthUnit: "seconds", width: 1920, height: 1088, seconds: 5, fps: 24, expectedSeconds: 240}`.
- `loadSettings(host, root)` deep-merges `comfy` (and `comfy.nodes`) over the defaults. When `comfy.workflow` is unset it resolves to `join(root, "ComfyUI workflows", "broll_ltx.json")`.
- `jobs.restore`: a `running` job with `jobRef` whose runner has `resume` is resumed, whatever its lane. Resumed jobs count toward their lane cap, and `pump` waits for them.
- `jobs.check(id)`: allowed for any job with a `jobRef` whose runner has `resume`, whatever its lane. The error text becomes "Only a job with an id can be checked again."
- [ ] Tests:
  - partial `comfy` override keeps the other defaults;
  - workflow default under root;
  - `restore resumes a gpu job with jobRef when its runner can resume`;
  - `resumed gpu job holds the gpu lane` (a queued Blender job waits until it ends);
  - a gpu job without `resume` is still interrupted.
- [ ] RED → implement → GREEN (`npm test`) → commit `feat(studio): comfy settings, resume any lane`.

### Task 2: ComfyUI runner
**Files:** Create `js/tools/comfyui.js`, `tests/comfyui.test.mjs`.
**Interfaces:**
- `makeComfyRunner({settings, sleep?}) -> Runner`, lane `"gpu"`.
  - `start(job, ctx)`, with `job.input = {kind:"broll", prompt, out}` where `out` ends `.mp4`.
  - `resume(job, ctx)` uses `job.jobRef`.
- `fillWorkflow(workflow, comfy, {prompt, seed, prefix}) -> object`, pure: it sets the mapped inputs. Length is seconds, or frames as `4n+1` from seconds × fps when `lengthUnit` is "frames". It throws `Workflow has no node <id>` (or no input) for a missing map entry.
- `findOutput(historyEntry, outputNodeId) -> {filename, subfolder}|null`, pure. It looks under that node first, then any node, in `videos`, `gifs` and `images`.
- Flow:
  - read the workflow file (read/parse failure → reject "Couldn't read the ComfyUI workflow at <path>");
  - fill it with a random integer seed and prefix `broll/sixmin_<filmfolder>_<id>_t<n>_<now>`;
  - write the body to `<film>\studio\tmp\comfy_<jobid>.json`;
  - curl POST `<url>/prompt` (`-sS --fail -X POST -H "Content-Type: application/json" --data-binary @file`). A curl failure means not running (constraint message). Parse `prompt_id` or reject with an excerpt;
  - `ctx.setRef(prompt_id)`;
  - loop: sleep 5 s, curl GET `<url>/history/<id>`:
    - `{}` or missing → still running; progress null, eta "about N min left" from `expectedSeconds` minus elapsed, or "running long";
    - `status.status_str === "error"` → reject with the last message text;
    - completed or success → `findOutput` → ffmpeg `-y -i <outputDir>\<subfolder>\<filename> -vf crop=1920:1080 -an -c:v libx264 -crf 18 -pix_fmt yuv420p <out .part.mp4>` → rename to `out` → `{file: out}`. No output → reject "ComfyUI finished but saved no video".
  - The crop uses the configured width and height when they differ from 1920×1088, clamped to 1920×1080 at most.
- [ ] Tests:
  - `fillWorkflow` for LTX (seconds) and a Wan-style map (frames 121 for 5 s at 24 fps);
  - missing mapped node rejects before submit;
  - not-running message on a curl failure at submit;
  - `setRef` before the first poll;
  - error status rejects with ComfyUI's message;
  - finds the output under images, gifs or videos;
  - ffmpeg crop+strip writes through `.part` then renames, and ComfyUI's output is untouched;
  - resume never POSTs;
  - 5 failed polls → ambiguous error with the constraint message;
  - 60-min cap.
- [ ] RED → implement → GREEN → commit `feat(studio): comfyui runner`.

### Task 3: Shots and takes with a tool choice
**Files:** Modify `js/shots.js`, `js/redo.js`; tests in `tests/shots.test.mjs`, `tests/redo.test.mjs`.
**Interfaces:**
- Tools: `higgsfield | blender | comfyui`. `comfyui` is valid only for kind `broll`.
- `state.prefs = {preferComfy: boolean}`, default false. `buildShotList` sets broll shots' tool to `comfyui` when `prefs.preferComfy` is set. The shot-list instructions are unchanged, and the code makes the switch.
- `setTool(ctx, assetId, tool)`:
  - broll only (higgsfield ↔ comfyui);
  - refused while a take is busy ("<id> has a take in progress");
  - `approved` is unchanged;
  - logs "<id> now uses <Tool>".
- `setPreferComfy(ctx, on)`: sets `prefs.preferComfy`, and switches the tool of broll shots with no takes to match. Logs it.
- `startTake` for `comfyui`: same prompt logic as Higgsfield; `input = {kind:"broll", prompt, out: base + ".mp4"}`; job tool `"comfyui"`.
- [ ] Tests:
  - prefer flag → broll shots get comfyui;
  - `setTool refuses while a take is busy`;
  - `setTool` rejects comfyui on lineart or blender;
  - `setPreferComfy` changes only broll shots without takes;
  - `startTake` on a comfyui shot adds a comfyui job with an `.mp4` out.
- [ ] RED → implement → GREEN → commit `feat(studio): per-shot b-roll tool and prefer ComfyUI`.

### Task 4: Screens, wiring and probe
**Files:** Modify `js/app.js`, `js/ui/review.js`, `js/ui/dom.js` (`TOOL_LABEL` comfyui → "ComfyUI"), `js/ui/probe.js`, `css/studio.css`; tests in `tests/viewmodel.test.mjs`, `tests/probe.test.mjs` (create if absent).
- Runners: add `comfyui: makeComfyRunner({settings})`.
- **Review header:** a "Prefer ComfyUI for b-roll" checkbox → `setPreferComfy`.
- **Broll cards:** a two-button tool switch (Higgsfield / ComfyUI, `aria-pressed`) → `setTool`, disabled while the shot is busy or pending. Card tag and overlay use the tool label ("Rendering in ComfyUI").
- **Live jobs:**
  - ComfyUI jobs show Check again (free) and a plain "Run again" (no credits wording);
  - the ambiguity warning reads "Check ComfyUI first: this render may still be running." for comfyui jobs.
- **Probe:** a "ComfyUI" check runs curl GET `<url>/system_stats` (pass shows the ComfyUI version from the JSON if present) and confirms the workflow file exists.
- [ ] View-model tests:
  - tool switch shown only for broll;
  - disabled while busy;
  - comfyui retry label and warning;
  - probe ComfyUI check pass and fail with FakeHost.
- [ ] RED → implement → GREEN → commit `feat(studio): ComfyUI in review, jobs and probe`.

### Task 5: Publish and checklist (controller)
- `npm test` all pass. Republish the artifact (same URL), add to `docs/acceptance-slice1.md` a "ComfyUI" section (Probe check; one ComfyUI b-roll take; close the app mid-render and reopen → reconnects), update the README known limits, push, and comment the change on the PR.
