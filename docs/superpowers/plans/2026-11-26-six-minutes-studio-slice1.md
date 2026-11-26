# Six Minutes Studio, slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable desktop app (a Claude artifact with the `desktop` capability) that lists Jon's films, shows live jobs with an activity log, and runs the b-roll/line-art part of the Part 2 review for one film: shot list, Higgsfield and Blender generation, take picking, approve, and redo with a note.

**Architecture:** One artifact page (`index.html`) loading plain ES modules from `js/`. All platform access goes through one `host` object (desktop fs/childProcess/notifications, the `mcp` and `sample` capabilities) so every logic module is tested in Node with a fake host. Per-film state lives on disk in `<project>\studio\` (design 6.4); the UI renders from that state and never holds anything that is not on disk.

**Tech Stack:** Vanilla JS ES modules (no build step, no framework), CSS with the Six Minutes On… Night tokens, Node 22 `node:test` for tests, Blender CLI, ffmpeg, the Higgsfield connector.

**Spec:** `docs/superpowers/specs/2026-11-26-six-minutes-studio-design.md`

**Later plans (not in this slice):** Part 1 in app; narration per-take checks (6.3a); score/SFX/ElevenLabs/Stable Audio; ComfyUI; Part 2 handover writing and B-roll library entries; Part 3 and Shorts sessions in the terminal; skill updates (6.7).

## Global Constraints

- Runs on Windows, in the Claude desktop app, as an installed artifact. Manifest permissions: `["full-access","notifications","menu-bar"]`.
- Project root: `S:\Youtube video ideas\`; UNC fallback `\\192.168.1.171\jon\Youtube video ideas\`. Never read or write `C:\Users\Jon\Youtube video ideas\`.
- Never move, rename or delete anything in `S:\Youtube video ideas\voice files\`.
- Never replace a take: new takes are added; deletions go through `shell.trashItem` and only on Jon's click.
- Never re-fire a paid generation automatically. A failed Higgsfield job is shown as failed with a "Run again" button.
- Poll Higgsfield job status no more often than every 20 s per job.
- Local GPU jobs (Blender) run one at a time; connector jobs may run up to 3 at once.
- Every in-app Claude call is memoryless: it sends instructions plus only that task's data. Tiers: `"quick"` for note→prompt and note→script edits, `"default"` for shot lists, `"complex"` reserved.
- No model identifiers anywhere in the repo.
- Copy: British English, sentence case, no emoji, no exclamation marks (design system README).
- Look: Six Minutes On… Night tokens as in the mockup (`--s0 #03070c` … `--brass #d5a867`, `--tide #86bfdb`), Inter, square corners.
- Values from files, connectors or Claude are set with `textContent` (or escaped), never as markup.

## Review Focus

1. **App closed mid-job.** On reopen, a Higgsfield job reconnects by job ID; a Blender job shows "Interrupted" with "Run again". Test: `jobs.test.mjs › restore marks local running jobs interrupted and keeps connector jobs`.
2. **`S:` not mapped or the server offline.** The Films screen says so and tries the UNC path; nothing crashes. Test: `paths.test.mjs › falls back to UNC root when S: is missing` and `› reports no root when both are missing`.
3. **Two writes racing on `state.json`** (a job finishing while Jon approves). Writes are serialised per film and atomic (temp file + rename). Test: `store.test.mjs › concurrent updates are applied in order and none are lost`.
4. **Blender exits non-zero or writes no output file.** The take is marked failed with the last 20 lines of output, not "done". Test: `blender.test.mjs › non-zero exit marks take failed with log tail`.
5. **Claude returns malformed JSON or a refusal** for a shot list or redo. Show the error on the card, keep the old prompt, change nothing on disk. Test: `claude.test.mjs › rejects shot list without required fields` and `redo.test.mjs › failed rewrite leaves state unchanged`.

---

## File structure

```
six-minutes-studio/
  index.html            page shell, manifest tag, nav, view containers
  css/studio.css        tokens and all styles
  js/host.js            makeHost(): real desktop/mcp/sample adapter; FakeHost lives in tests
  js/paths.js           project root resolution, project-relative paths
  js/films.js           scan projects, derive part status from handover/studio files
  js/store.js           per-film studio state: load, update (serialised, atomic), log append
  js/jobs.js            job queue: lanes, lifecycle, persistence, restore
  js/claude.js          memoryless Claude calls with JSON validation
  js/shots.js           build shot list from script + part1 handover; asset/take model helpers
  js/redo.js            redo with a note for any take
  js/tools/higgsfield.js  start, poll, download Higgsfield jobs
  js/tools/blender.js   write script, run blender, parse progress
  js/media.js           ffmpeg preview proxies, blob URLs
  js/ui/films.js  js/ui/jobs.js  js/ui/review.js  js/ui/probe.js   one view each
  js/app.js             boot: host, permission flow, routing, notifications, tray
  tests/fake-host.mjs   in-memory fs + scripted exec/spawn/mcp/sample
  tests/*.test.mjs
  package.json          {"type":"module","scripts":{"test":"node --test tests/"}}
  README.md             what it is, how to install, how to run tests
```

Repo `README.md`: add a line for six-minutes-studio.

---

### Task 1: Host adapter, fake host, and probe screen

**Files:**
- Create: `six-minutes-studio/index.html`, `css/studio.css`, `js/host.js`, `js/app.js`, `js/ui/probe.js`, `tests/fake-host.mjs`, `tests/host.test.mjs`, `package.json`, `README.md`
- Modify: `README.md` (repo root)

**Interfaces:**
- Produces: `makeHost(): Promise<Host | null>` in `js/host.js`, where
  ```
  Host = {
    platform: string,
    fs: { read(p, enc?), write(p, data, enc?), append(p, s), exists(p), list(p) -> DirEntry[], stat(p), mkdir(p), rename(a,b), trash(p) },
    exec(cmd, {cwd?, timeout?}) -> {stdout, stderr, code},
    spawn(cmd, args, {cwd?}) -> {onOut(fn), onErr(fn), onExit(fn), kill()},
    mcp: { call(server, tool, input) -> payload, listTools(server) -> string[] } | null,
    claude: { json(input, opts) -> any, text(input, opts) -> string } | null,
    notify(body) -> Promise<void>,
    tray(opts) -> Promise<void>,
    now() -> number
  }
  ```
  `makeHost` returns `null` when `desktop.fs` is missing (not installed / no full access).
- Produces: `FakeHost` class in `tests/fake-host.mjs` implementing `Host` with `files: Map<string,string|Uint8Array>`, `execScript(fn)`, `spawnScript(fn)`, `mcpScript(fn)`, `claudeScript(fn)`, `notified: string[]`, settable `t` for `now()`. Paths are compared case-insensitively with `\` and `/` treated alike.

- [ ] **Step 1: Write failing tests** `host.test.mjs`: `FakeHost fs round-trips text and bytes`; `exists/list reflect writes, case-insensitive with mixed slashes`; `rename moves the entry`; `exec returns scripted result`.
- [ ] **Step 2: Run** `npm test` in `six-minutes-studio/` → FAIL (module missing).
- [ ] **Step 3: Implement `FakeHost`**, then `makeHost` over `claude.use("desktop")`, `claude.use("mcp")`, `claude.use("sample")`. `trash` uses `shell.trashItem`. Errors pass through unchanged (messages start with errno codes).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Page shell and probe view.** `index.html`: `<title>Six Minutes Studio</title>`, manifest tag `{"permissions":["full-access","notifications","menu-bar"]}`, nav (Films, Live jobs, Review, Probe), install button when `desktop?.install.state()` is `"available"`, the line "This page works only in its desktop app…" otherwise. Probe view runs checks on a click and lists pass/fail with detail: `S:` root readable; UNC root readable; `blender --version`; `ffmpeg -version`; `python --version`; Higgsfield `listTools` includes `generate_video`, `generate_image`, `jobs_wait`; `claude.json` answers `{"ok":true}` on a trivial prompt at tier quick.
- [ ] **Step 6: Publish** with the Artifact tool: `file_path` = `index.html`, `files` = every file under `css/` and `js/` by relative path, `capabilities` = `{"desktop":{},"mcp":{"servers":[{"server":"Higgsfield","tools":["generate_image","generate_video","jobs_wait","job_display"]}]},"sample":{}}`, icon `film`. Record the artifact URL in `six-minutes-studio/README.md`.
- [ ] **Step 7: Manual check on Jon's PC.** Jon installs it (Install as app), allows full access, runs Probe, and reports results. Record any failing check in `README.md` under "Known setup". Before continuing, confirm Higgsfield argument names from the connector's schema (ToolSearch the `mcp__Higgsfield__*` tools in a session) and write them into `js/tools/higgsfield.js` as constants with a comment citing the schema.
- [ ] **Step 8: Commit** `feat(studio): host adapter, probe screen`.

### Task 2: Project root and film discovery

**Files:** Create `js/paths.js`, `js/films.js`, `tests/paths.test.mjs`, `tests/films.test.mjs`

**Interfaces:**
- Consumes: `Host.fs`.
- Produces:
  - `resolveRoot(host) -> Promise<string|null>`: `S:\Youtube video ideas` if it exists, else the UNC path, else `null`.
  - `join(...parts) -> string` with `\` separators.
  - `scanFilms(host, root) -> Promise<Film[]>`, `Film = {dir, title, number|null, parts: {1,2,3,shorts: "done"|"now"|"none"}, waiting: string|null, hasStudio: boolean}`.

- [ ] **Step 1: Failing tests.** `paths`: `prefers S: root`, `falls back to UNC root when S: is missing`, `reports no root when both are missing`. `films`: a project with `handover\part1_handover.md` only → parts `{1:"done",2:"now",3:"none",shorts:"none"}`; with part1+part2 → 3 `"now"`; with part3 → shorts `"now"`; folders without `handover\` or `studio\` are skipped; `number` parsed from a handover line `Episode: 014` (or `null`); `waiting` read from `studio\state.json` `waiting` field when present.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Title = folder name. Only direct children of root are scanned.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(studio): film discovery`.

### Task 3: Studio state store

**Files:** Create `js/store.js`, `tests/store.test.mjs`

**Interfaces:**
- Produces:
  - `openFilm(host, dir) -> Promise<FilmStore>`; creates `studio\`, `studio\blender\`, `studio\media\` if missing.
  - `FilmStore = { state, update(fn: (draft)=>void) -> Promise<State>, log(text) -> Promise<void>, readLog(limit) -> Promise<{t,text}[]> }`
  - `State = { v:1, film, part:2, waiting: string|null, assets: Asset[] }`
  - `Asset = { id:"BR-07", kind:"broll"|"lineart"|"blender", line: string, lineIndex: number, desc, tool:"higgsfield"|"blender", sourceId?: string, draftPrompt?: string, takes: Take[], chosen: number, approved: boolean }`
  - `Take = { n, prompt?, script?, note?, jobId?, file?, proxy?, status:"queued"|"running"|"done"|"failed", error?, at }`

- [ ] **Step 1: Failing tests:** `creates studio folders and empty state`; `update persists to state.json via temp file then rename`; `concurrent updates are applied in order and none are lost` (fire 20 `update` calls without awaiting, each pushes a number; final array has 20 in order); `log appends JSON lines and readLog returns newest first`; `corrupt state.json is renamed state.bad-<t>.json and a fresh state is started, with a log line saying so`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with a per-store promise chain for serialisation; write `state.json.tmp` then `rename`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(studio): per-film state store`.

### Task 4: Job engine

**Files:** Create `js/jobs.js`, `tests/jobs.test.mjs`

**Interfaces:**
- Consumes: `Host`, `FilmStore`.
- Produces:
  - `makeJobs(host, {runners}) -> Jobs`; `runners: {higgsfield: Runner, blender: Runner}`; `Runner = { lane:"gpu"|"connector", start(job, ctx) -> Promise<{file}>, resume?(job, ctx) -> Promise<{file}> }`, `ctx = {progress(p:number|null, eta?:string), host}`.
  - `Jobs = { add(job) -> id, list() -> Job[], onChange(fn), restore(saved: Job[]), toJSON() -> Job[] }`
  - `Job = { id, film, assetId, take, tool, what, why, lane, status:"queued"|"running"|"done"|"failed"|"interrupted", progress:number|null, eta:string|null, jobRef?:string, startedAt?, endedAt?, error? }`
  - Persisted to `<root>\.studio-jobs.json` (all films) after every change.

- [ ] **Step 1: Failing tests:** `gpu lane runs one job at a time`; `connector lane runs up to 3 at once`; `progress updates notify listeners`; `runner rejection marks job failed with message and does not retry`; `restore marks local running jobs interrupted and keeps connector jobs` (connector jobs with `jobRef` call `resume`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(studio): job queue with gpu and connector lanes`.

### Task 5: Claude calls and the shot list

**Files:** Create `js/claude.js`, `js/shots.js`, `tests/claude.test.mjs`, `tests/shots.test.mjs`

**Interfaces:**
- Consumes: `Host.claude`, `FilmStore`.
- Produces:
  - `askJson(host, {instructions, data, tier, validate}) -> Promise<any>`: one memoryless call; throws `ClaudeError{code, message}` on refusal, non-JSON or failed `validate`.
  - `buildShotList(host, store, {scriptText, handoverText}) -> Promise<Asset[]>`: asks at tier `"default"` for `[{id, kind, line, lineIndex, desc, tool, sourceId?, prompt}]`; writes the assets with no takes yet (`takes: []`) and each shot's prompt kept as `draftPrompt`; ids `BR-01…` in script order; `kind:"blender"` requires `sourceId` of a `lineart` asset.
  - `orderByScript(assets) -> Asset[]`.

- [ ] **Step 1: Failing tests:** `askJson sends instructions and data only, no prior turns`; `rejects shot list without required fields`; `refusal surfaces as ClaudeError code refusal`; `blender shot without lineart source is rejected`; `orderByScript sorts by lineIndex then id`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Shot-list instructions name Jon's channel voice and the tool rule: Higgsfield for filmed-looking b-roll and 2D line art, Blender for 3D line-art versions of approved line art and for 3D models of a place.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(studio): memoryless claude calls and shot list`.

### Task 6: Higgsfield runner

**Files:** Create `js/tools/higgsfield.js`, `tests/higgsfield.test.mjs`

**Interfaces:**
- Consumes: `Host.mcp`, `Runner` contract (Task 4), argument-name constants recorded in Task 1 Step 7.
- Produces: `higgsfieldRunner: Runner` (lane `"connector"`); `start` calls `generate_video` (kind `broll`) or `generate_image` (kind `lineart`), stores the returned job id as `job.jobRef` before waiting, waits via `jobs_wait` (or status polling ≥20 s apart), downloads the result to `<project>\studio\media\<assetId>_t<n>.<ext>` via `exec` (`curl -L -o`), returns `{file}`; `resume` does the same from `jobRef`.

- [ ] **Step 1: Failing tests:** `stores jobRef before waiting`; `polls no faster than every 20 s`; `downloads result into studio media with take-numbered name`; `connector error rejects with the connector's message and makes no second generate call`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(studio): higgsfield runner`.

### Task 7: Blender runner

**Files:** Create `js/tools/blender.js`, `tests/blender.test.mjs`

**Interfaces:**
- Consumes: `Host.spawn`, `Host.fs`, `askJson` (Task 5) for scripts.
- Produces:
  - `writeBlenderScript(host, store, asset, take, {note?, previous?}) -> Promise<string>` → path `studio\blender\<assetId>_t<n>.py`; Claude (tier `"quick"` for edits, `"default"` for first takes) returns `{script, frames, out}`; the script must read the source image path and output path from `sys.argv` after `--`.
  - `blenderRunner: Runner` (lane `"gpu"`): runs `blender -b -P <script> -- <sourceFile> <outFile>`; parses `Fra:(\d+)` lines against `frames` for progress; done only if exit code 0 **and** the output file exists.
  - Blender path from `six-minutes-studio` settings file `<root>\.studio-settings.json` key `blenderPath`, default `blender`.

- [ ] **Step 1: Failing tests:** `progress follows Fra lines`; `non-zero exit marks take failed with log tail` (last 20 lines); `exit 0 without output file fails`; `script path and args are passed after --`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Manual check on PC:** a one-shot Blender job from a real approved line-art PNG renders and its output plays. Compare format/frame rate/alpha with Jon's Norfolk Broads Blender output and set the defaults in the script instructions to match; note them in `README.md`.
- [ ] **Step 6: Commit** `feat(studio): blender runner`.

### Task 8: Redo with a note, and starting takes

**Files:** Create `js/redo.js`, `tests/redo.test.mjs`

**Interfaces:**
- Consumes: `FilmStore`, `Jobs`, `askJson`, `writeBlenderScript`.
- Produces:
  - `startTake(ctx, assetId, {note?}) -> Promise<Take>`: appends take n+1 (status `queued`), selects it, adds a job with `why` = `Take n, from your note "<note>"` or `First take`; for Higgsfield, the new prompt is the draft prompt (first take) or Claude's rewrite of the previous prompt with the note (tier `"quick"`); for Blender, calls `writeBlenderScript`.
  - `approve(ctx, assetId)`, `unapprove(ctx, assetId)`, `choose(ctx, assetId, n)`.
  - `canStart(asset, assets) -> boolean`: a Blender asset needs its `sourceId` asset approved.
  - Job completion updates the take (`done` + `file`, or `failed` + `error`) and logs a line.

- [ ] **Step 1: Failing tests:** `first take uses the draft prompt`; `redo rewrites prompt with note and keeps old takes`; `failed rewrite leaves state unchanged`; `blender shot cannot start until source line art is approved`; `job done sets take file and logs`; `approve requires a done take`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(studio): takes, redo with a note, approvals`.

### Task 9: Preview proxies

**Files:** Create `js/media.js`, `tests/media.test.mjs`

**Interfaces:**
- Produces: `ensureProxy(host, file) -> Promise<string>` → `<same dir>\proxy\<name>_640.mp4` (video, `ffmpeg -y -i in -vf scale=640:-2 -c:v libx264 -crf 28 -an out`) or the file itself for images; `toBlobUrl(host, file) -> Promise<string>`; `openFull(host, file)` via `shell.openPath`.
- [ ] **Step 1: Failing tests:** `builds ffmpeg proxy once and reuses it`; `images are not proxied`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(studio): preview proxies`.

### Task 10: Screens

**Files:** Create `js/ui/films.js`, `js/ui/jobs.js`, `js/ui/review.js`; modify `js/app.js`, `index.html`, `css/studio.css`

**Interfaces:**
- Consumes: everything above. Each view exports `render(el, model, actions)` and re-renders on store/job changes.
- Layout and copy follow the mockup (https://claude.ai/artifact/2zwT4cvvbxC7Kndbtzzaaw) and design 6.1, limited to this slice:
  - Films: rows with series dot (when known), number, title, four-step tracker, waiting line in brass, button. "Open review" for films whose part is 2.
  - Live jobs: description, tool tag, film, progress bar (`progress===null` → indeterminate stripe), eta or "queued", why; activity log beside; "Run again" on failed and interrupted jobs; nav badge with the running+queued count.
  - Review (b-roll section): "Make shot list" when the film has no assets (reads the script `.md` named in `part1_handover.md`, and the handover); cards in script order with the narration line, toggle to grid; tool tag; take picker; Approve / Undo; Redo… with note box; "Regenerating" overlay; Blender cards show the 2D source thumbnail too and a locked state with "Approve <sourceId> first"; summary bar with approved n/total and regenerating count.
  - A "Keep this window open while jobs run" line shows whenever jobs are running.
- [ ] **Step 1: Pure view-model tests** in `tests/viewmodel.test.mjs`: `waiting line uses brass when waiting on Jon`; `summary counts approved and regenerating`; `blender card locked until source approved`.
- [ ] **Step 2–4:** Run → FAIL, implement view models and views, run → PASS.
- [ ] **Step 5: Commit** `feat(studio): films, live jobs and review screens`.

### Task 11: Notifications and tray

**Files:** Modify `js/app.js`; test in `tests/notify.test.mjs`

**Interfaces:**
- Produces: `notifyRules(prev: Job[], next: Job[]) -> string[]`: one message per job that became `done` ("BR-07 take 3 is ready to review"), `failed` ("BR-07 take 3 failed in Blender"), and one "All shots for <film> are ready" when the last running job of a film finishes. Tray: icon with the running-job count in the tooltip and items "Open", "Live jobs".
- [ ] **Step 1: Failing tests** for the three messages and for no duplicate on repeated identical states.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS. Permissions are asked on first use from a click (the first job start), never on load.
- [ ] **Step 5: Commit** `feat(studio): notifications and tray`.

### Task 12: Publish, install and acceptance on the PC

**Files:** Modify `six-minutes-studio/README.md`

- [ ] **Step 1:** `npm test` → all PASS.
- [ ] **Step 2:** Republish to the same artifact URL from Task 1 (same `file_path`, all `files`). Capabilities unchanged unless a tool list changed.
- [ ] **Step 3: Acceptance with Jon, on one real film in Part 2:**
  1. Films lists his projects with correct parts.
  2. "Make shot list" produces shots in script order with tools proposed.
  3. Start three Higgsfield shots: each appears in Live jobs, progresses, lands on its card, notification shown.
  4. Approve a line-art shot; its Blender shot unlocks; the render shows frame progress and the result plays.
  5. Redo one clip with a note: new take beside the old, history shows the note.
  6. Close the app during a Higgsfield job; reopen; the job reconnects. Close during a Blender job; reopen; it shows Interrupted with Run again.
  7. Unplug/rename nothing: confirm `voice files\` untouched and no files outside `<project>\studio\` were written except `<root>\.studio-jobs.json` and `.studio-settings.json`.
- [ ] **Step 4:** Record results and any fixes in `README.md`. Commit `docs(studio): slice 1 acceptance`.
