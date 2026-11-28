# Desktop jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the laptop, graphics jobs (ComfyUI, Blender, Stable Audio) are sent through a queue folder on the server to the desktop, which makes them and answers; both computers show whether the other is connected.

**Architecture:** Small JSON files in `<root>\.studio-queue\` (one writer per file) carry requests and answers. On a laptop the three graphics tools get a stand-in runner that writes a request and waits on the answer, so the laptop's job list, notices and film recording are unchanged. On the desktop a worker claims requests when its graphics lane is free, runs them through its normal runners as jobs marked `from`, and writes answers. Each Studio writes a presence file every 30 s; a connection line in the header reads them.

**Tech Stack:** Plain ES modules; `node --test` with `tests/fake-host.mjs`. Paths relative to `six-minutes-studio/` unless they start with `docs/`.

**Spec:** `docs/superpowers/specs/2026-11-28-six-minutes-studio-desktop-jobs-design.md`

## Global Constraints

- The desktop on its own behaves exactly as today: with no requests and no other presence files, nothing in its job list, film recording, notices or UI changes except the header line staying hidden.
- Queue folder `<root>\.studio-queue\`, finished files in `<root>\.studio-queue\finished\`; presence folder `<root>\.studio-presence\`. File names: `<id>.request.json`, `<id>.answer.json`, `<id>.withdrawn.json`, `<id>.check-<ms>.json`, `<COMPUTERNAME>.json`. Request id = `<COMPUTERNAME>-<laptop job id>`.
- One writer per file: the laptop writes request, withdrawn and check files and moves only those; the desktop writes answers and moves only those. Every JSON write is `.tmp` then rename. Nothing is ever deleted.
- Timings: presence every 30 000 ms, "seen" = contents changed within 90 000 ms by the reader's own clock; desktop worker every 10 000 ms; laptop runner checks every 5 000 ms; desktop answer progress rewritten at most every 5 000 ms (status changes at once).
- Graphics tools: `comfyui`, `blender`, `stableaudio` (the existing `DESKTOP_TOOLS`).
- Exact copy: `Make on the desktop` (replaces `Make this on the desktop`); `Waiting for the desktop`; suffixes ` (busy)`, ` (laptop jobs paused)`, ` (not seen since HH:MM)`, ` (not seen yet)`; running eta `On the desktop: <desktop eta or NN%>`; `Withdrawn`; `Interrupted on the desktop; press Retry`; `Lost on the desktop; press Retry`; desktop failure prefix `On the desktop: `; line texts `Desktop: ready`, `Desktop: busy (1 job)` / `(N jobs)`, `Desktop: laptop jobs paused`, `Desktop: not seen since HH:MM`, `Desktop: not seen yet`, `Can't reach the server (<root>)`, `Laptop: seen just now`, `Laptop: last seen HH:MM` with suffix ` · N waiting, M running` (each part only when non-zero); buttons `Pause laptop jobs`, `Resume laptop jobs`, `Withdraw`; tray tag `from <COMPUTERNAME>`; desktop retry note `Retry it from <COMPUTERNAME>`. HH:MM via `clock()` in `js/ui/jobs.js`.
- Never re-fire: a failed or interrupted job is never retried automatically; Check is free and only on a desktop answer `failed` with `ambiguous`.
- British English, plain UI words. No model identifiers in the repo. Commit trailers as usual.

## Review Focus

1. A laptop path inside a job input (`N:\Youtube video ideas\Orkney\studio\media\x.mp4`, and `sourceFile`, `out`, `base`) reaches the desktop's runner as `S:\…` even when the laptop's root is only in the request (not yet in `computers`). → Task 1 and Task 4 tests.
2. A laptop job the desktop runs is never written into the film state or notified on the desktop, while the desktop's own job for the same film still is. → Task 4 test.
3. The laptop closes mid-job and reopens: the restored job resumes on the same request id and records the take when the answer says done; no second request is written. → Task 3 test.
4. Withdraw while the desktop is offline fails the job at once; withdraw racing a claim lets the claim win and the job carries on. → Task 3 and Task 4 tests.
5. The two clocks differ by an hour: the laptop still shows `Desktop: ready` while the desktop's presence file keeps changing. → Task 1 test.

---

### Task 1: Presence, the connection line, and deep re-basing

**Files:**
- Create: `js/presence.js`
- Modify: `js/rebase.js`
- Test: `tests/presence.test.mjs`, `tests/rebase.test.mjs`

**Interfaces:**
- Produces:
  - `rebaseDeep(value, spellings, root)` in `js/rebase.js` — returns a copy with every string (in arrays and plain objects, any depth) passed through `rebasePath`; non-strings unchanged.
  - `PRESENCE_DIR = ".studio-presence"`, `BEAT_MS = 30000`, `SEEN_MS = 90000`.
  - `makePresence(host, { root, computer, role, state })` → `{ beat(): Promise<void>, read(): Promise<Peer[]>, serverError: string|null }`. `state()` returns `{ paused, running, waiting, tools }`. `beat` writes `{ computer, role, at: host.now(), paused, running, waiting, tools }` to `<root>\.studio-presence\<computer>.json` (folder made; `.tmp` then rename); does nothing when `computer` is `UNNAMED`. `read` lists the folder, skips its own file, and for each other file remembers the time (`host.now()`) its contents last changed; the first sighting uses the file's `at` as `lastSeen` and counts as unchanged. `Peer = { computer, role, seen, lastSeen, paused, running, waiting, tools }`. A failed write or list sets `serverError` to the error text (cleared on the next success).
  - `linkLine({ role, peers, serverError, root, now })` → `string|null`. Laptop: follows the most recently seen peer with role `desktop` (none → `Desktop: not seen yet`); seen → paused / busy / ready texts; not seen → `Desktop: not seen since HH:MM`. Desktop: one part per laptop peer, `Laptop` when there is one, its computer name when more; `null` when no peers. `serverError` → `Can't reach the server (<root>)` first.
  - `desktopState(peers)` → `{ text, ready }` for the laptop runner and Probe: `text` is one of `""`, ` (busy)`, ` (laptop jobs paused)`, ` (not seen since HH:MM)`, ` (not seen yet)`; `ready` when a desktop is seen and not paused.

- [ ] **Step 1: Failing tests** — `rebaseDeep` rewrites `{ out: "N:\\Youtube video ideas\\a\\x.mp4", list: ["N:\\Youtube video ideas\\b"], n: 3 }` to `S:` with root `S:\\Youtube video ideas` and spellings `["N:\\Youtube video ideas"]`, leaves `C:\\Users\\x` and `3`; `beat` writes the file with the fields above; `UNNAMED` writes nothing; Review Focus 5: a peer whose `at` is an hour ahead but whose contents change between two `read`s 30 s apart reads `seen: true`, and after 91 s with no change `seen: false` with `lastSeen` the reader's time of the last change; `linkLine` cases for every text in Global Constraints (busy 1 job / 2 jobs, paused, ready, not seen since, not seen yet, server error, desktop with one laptop `Laptop: seen just now · 1 waiting`, two laptops by name, no peers → `null`); `desktopState` cases.
- [ ] **Step 2: Run** `node --test tests/presence.test.mjs tests/rebase.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(desktop-jobs): presence, connection line, deep re-basing`.

### Task 2: The queue files

**Files:**
- Create: `js/queue.js`
- Test: `tests/queue.test.mjs`

**Interfaces:**
- Produces (all take `host, root` first; every write `.tmp` then rename; folders made as needed):
  - `QUEUE_DIR = ".studio-queue"`, `FINISHED = "finished"`.
  - `writeRequest(host, root, { id, from, root: fromRoot, job })` — adds `at: host.now()`.
  - `readAnswer(host, root, id) -> answer|null` (missing or unreadable → null).
  - `writeAnswer(host, root, answer)` — answer `{ id, by, status, progress, eta, file, meta, error, ambiguous, checks }`.
  - `writeWithdrawn(host, root, id)`, `hasWithdrawn(host, root, id) -> bool`.
  - `writeCheck(host, root, id) -> name` (name `<id>.check-<ms>.json`), `listChecks(host, root, id) -> string[]` (names).
  - `pendingRequests(host, root) -> request[]` — requests in the queue folder with no answer file, oldest `at` first; unreadable ones skipped.
  - `moveMine(host, root, id, side)` — `side "laptop"`: moves the request, withdrawn and check files for `id` into `finished\`; `side "desktop"`: moves the answer. A name already in `finished\` gets `_<ms>` before `.json` (never overwrite).
  - `requestFinished(host, root, id) -> bool` — the request is in `finished\` and not in the queue folder.
  - `listRequests(host, root) -> request[]` (all in the queue folder, any state) and `listAnswers(host, root) -> answer[]`.

- [ ] **Step 1: Failing tests** — round trip of each write/read; `pendingRequests` orders by `at`, skips one with an answer and one with broken JSON; `moveMine("laptop")` moves the three kinds and leaves the answer; `moveMine("desktop")` moves only the answer; moving twice never overwrites (second gets the `_<ms>` name); `requestFinished` true only after the laptop's move; no file is ever deleted (fake host `files` keys only grow or are renamed).
- [ ] **Step 2: Run** `node --test tests/queue.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(desktop-jobs): queue files`.

### Task 3: The laptop's stand-in runner

**Files:**
- Create: `js/tools/desktop.js`
- Modify: `js/jobs.js` (ctx gains `setRemote(state)`: sets `job.remote = state` and persists; `add` and `retry` drop `remote`)
- Test: `tests/desktoprunner.test.mjs`, `tests/jobs.test.mjs`

**Interfaces:**
- Consumes: Task 1 `rebaseDeep`, `desktopState`; Task 2 queue functions.
- Produces:
  - `makeDesktopRunner({ root, computer, spellings, peers, poll = 5000, sleep })` → `{ lane: "gpu", start(job, ctx), resume(job, ctx) }`. `peers()` returns the latest `Peer[]`.
  - `start`: id = `<computer>-<job.id>`; `writeRequest` with `job: { film, assetId, take, tool, what, why, input }` and `root`; `ctx.setRef(id)`; then the wait loop.
  - `resume`: if the answer is `failed` with `ambiguous`, `writeCheck` first; then the wait loop on `job.jobRef`. Never writes a request.
  - Wait loop (each `poll`): no answer → if `hasWithdrawn`: desktop not `ready` → finish as withdrawn; else keep waiting; `ctx.setRemote("waiting")`, `ctx.progress(null, "Waiting for the desktop" + desktopState(peers()).text)`. Answer `running` → `ctx.setRemote("running")`, `ctx.progress(answer.progress, "On the desktop: " + (answer.eta || pct%))`. `done` → `moveMine(laptop)`, return `{ file, meta }` passed through `rebaseDeep(…, spellings, root)`. `withdrawn` → `moveMine(laptop)`, throw `Withdrawn`. `failed` → throw `On the desktop: <error>` with `ambiguous` copied; `moveMine(laptop)` only when not ambiguous. After a check file is written, a `failed` answer whose `checks` lacks that file's name is read as still running (the desktop hasn't checked yet).
  - `withdraw(host, root, job)` exported helper: `writeWithdrawn` for `job.jobRef`; the loop does the rest.
  - `tidyRequests(host, root, computer, jobs)` exported: moves (laptop side) every request from `computer` whose id matches no job in `jobs`.

- [ ] **Step 1: Failing tests** — start writes one request with the fields and sets the ref; waiting shows `Waiting for the desktop (busy)` with a busy peer and `remote: "waiting"`; running answer at 0.4 shows `On the desktop: 40%`; done answer with `S:\…` file returns the `N:\…` file and moves the request; failed non-ambiguous moves, failed ambiguous does not and the thrown error has `ambiguous`; Review Focus 3: `makeJobs` with the runner, job running, `restore()` of the saved list resumes, writes no second request, and finishes done when the answer arrives; Review Focus 4 (laptop half): withdraw with no desktop seen fails `Withdrawn` within one poll; withdraw while a desktop is ready keeps waiting, then an answer `running` carries on; `tidyRequests` moves an orphan and leaves a matched one; jobs test: `setRemote` persists and `retry` drops `remote`.
- [ ] **Step 2: Run** `node --test tests/desktoprunner.test.mjs tests/jobs.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(desktop-jobs): laptop sends graphics jobs to the desktop`.

### Task 4: The desktop's worker

**Files:**
- Create: `js/desktopworker.js`
- Modify: `js/redo.js` (`applyJobs` skips jobs with `from`), `js/notify.js` (`notifyRules` ignores jobs with `from`)
- Test: `tests/desktopworker.test.mjs`, `tests/redo.test.mjs`, `tests/notify.test.mjs`

**Interfaces:**
- Consumes: Task 1 `rebaseDeep`; Task 2 queue functions; `makeJobs` API (`add`, `list`, `check`, `onChange`).
- Produces: `makeDesktopWorker({ host, root, computer, jobs, spellings, paused, now })` → `{ tick(): Promise<void>, reconcile(): Promise<void>, counts(): { waiting, running } , stop() }`. `paused()` reads the live setting.
  - `tick`: answers withdrawals (request with a withdrawn file and no answer → answer `withdrawn`); runs Check for each new check file listed in no answer's `checks` (`jobs.check(desktopJobId)` when that job is failed or interrupted; the check name is appended to `checks`); then, if not paused and no job in the gpu lane is queued or running, takes the first `pendingRequests` entry, re-checks `hasWithdrawn` (skip if so), writes answer `running`, and `jobs.add({ ...rebaseDeep(req.job, [...spellings, req.root], root), from: req.from, request: req.id })`; finally moves its own final answers (`done`, `failed`, `withdrawn`) whose `requestFinished`.
  - Answers follow the job: `jobs.onChange` → for each job with `request`, status change writes at once, progress at most every 5 000 ms; done → `file`, `meta`; failed → `error`, `ambiguous`; interrupted → `failed` with `Interrupted on the desktop; press Retry` unless the job has a `jobRef` and its runner resumes (then left `running`).
  - `reconcile` (once at start, before the first tick): every answer by `computer` still `running` with no job of that `request` in `jobs.list()` → `failed`, `Lost on the desktop; press Retry`.
  - `counts`: `waiting` = pending requests from the last tick; `running` = jobs with `from` queued or running.

- [ ] **Step 1: Failing tests** — Review Focus 1: a request from `LAPTOP` with root `N:\Youtube video ideas` and `input.out`, `input.sourceFile` under N: is added with S: paths although `spellings` lacks N:; a busy gpu lane (own Blender job running) claims nothing, and claims once it ends; paused claims nothing; withdrawn-before-claim answers `withdrawn` and adds no job; Review Focus 4 (desktop half): a withdrawal written after the claim leaves the job running; progress writes are throttled to one per 5 s with status changes at once; interrupted without ref → the exact text; `reconcile` fails an orphan `running` answer with the exact text; a check file triggers `jobs.check` once; final answers move only after the request is finished; Review Focus 2: `applyJobs` with a `from` job and an own job for the same film records only the own one, and `notifyRules` gives no message for the `from` job.
- [ ] **Step 2: Run** `node --test tests/desktopworker.test.mjs tests/redo.test.mjs tests/notify.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(desktop-jobs): desktop takes laptop jobs`.

### Task 5: Settings and wiring

**Files:**
- Modify: `js/computer.js`, `js/app.js`, `index.html`, `styles.css` (or the stylesheet the header uses)
- Test: `tests/computer.test.mjs`, `tests/settings.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `PER_COMPUTER` gains `laptopJobs` (`"on" | "paused"`, default `"on"` in loaded settings).
  - `localTools(entry) -> string[]` in `js/computer.js`, and `settings.localTools` from `loadSettings`: `blender` when the entry sets `blenderPath`; `comfyui` when the entry's `comfy` sets `url`, `outputDir` or `exe`; `stableaudio` when the entry sets any `stableAudio` key.
  - `sendsToDesktop(settings, tool) -> bool` in `js/computer.js`: role laptop, tool in `DESKTOP_TOOLS`, tool not in `localTools`.
  - In `app.js` `loadRoot`: presence made with `state()` from the worker's counts, `paused` and the starters' states; `beat()` at once and every 30 000 ms, `read()` every 30 000 ms (just after the beat) then `render()`; on a laptop the runners for tools where `sendsToDesktop` is true are one shared `makeDesktopRunner` (peers from the last `read`), and `tidyRequests` runs after `restore`; on a desktop with a name other than `UNNAMED` the worker is made, `reconcile()` after `restore`, then `tick()` every 10 000 ms. `app.link = linkLine(…)` and `app.peers` are kept for the views.
  - `index.html`: `<span class="link" id="link" hidden></span>` and `<button type="button" class="btn ghost" id="pause-laptop" hidden></button>` beside `#credits`. The line shows when `linkLine` returns text; the button shows on a desktop once a laptop peer exists, labelled `Pause laptop jobs` / `Resume laptop jobs`, and saves `laptopJobs` with `saveComputerSettings` then reloads settings.

- [ ] **Step 1: Failing tests** — `loadSettings` gives `laptopJobs: "on"` by default and `"paused"` from the entry; `localTools` cases; `sendsToDesktop` false on a desktop, true for `blender` on a laptop without `blenderPath`, false with it.
- [ ] **Step 2: Run** `node --test tests/computer.test.mjs tests/settings.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the settings helpers, then the `app.js` and `index.html` wiring (wiring has no unit test; Task 7's acceptance steps cover it).
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(desktop-jobs): settings and wiring`.

### Task 6: The views

**Files:**
- Modify: `js/labels.js`, `js/ui/review.js`, `js/ui/audio.js`, `js/ui/jobs.js`, `js/ui/probe.js`, `js/app.js` (passing `localTools`, the peers and the actions)
- Test: `tests/viewmodel.test.mjs`, `tests/audio.test.mjs`, `tests/probe.test.mjs`, the jobs view test file that covers `jobRow` (find with `grep -l jobRow tests`)

**Interfaces:**
- Consumes: Task 5 `sendsToDesktop`, Task 1 `desktopState`, Task 3 `withdraw`.
- Produces:
  - `MAKE_ON_DESKTOP = "Make on the desktop"`.
  - `cardModel` (review) and `itemModel` (audio) take `localTools` beside `role`. When `sendsToDesktop` is true, Make / Generate / Redo / Make 3D / Animate are enabled as on the desktop (Animate no longer needs the local i2v check) and the first-take button and the Generate button read `Make on the desktop`; the 3D and Animate buttons keep their labels with title `Made on the desktop`. When false on a laptop (tool set up locally) they behave as on the desktop.
  - `jobRow(job, …, { role })`: a job with `from` gets `from: "from <COMPUTERNAME>"`, `canRetry: false`, `retryNote: "Retry it from <COMPUTERNAME>"`, `canCheck: false`; on a laptop a graphics job with `remote === "waiting"` and status running gets `canWithdraw: true`; a laptop graphics job's Check is allowed when ended with `ambiguous` and a `jobRef` (as ComfyUI is today). Render adds the `Withdraw` button (action `withdraw(id)`) and the `from` tag.
  - Probe: `makeChecks(…, { desktop })` where `desktop` is `desktopState(peers)`; the laptop's graphics rows read `On the desktop` + `desktop.text` replaced by ` · ready` when ready. On a desktop, `roleRow` adds `Laptop jobs: on` / `Laptop jobs: paused` with the same toggle as the header.

- [ ] **Step 1: Failing tests** — laptop card for a ComfyUI shot with no take: `canMakeFirst: true`, label `Make on the desktop`; with `localTools: ["comfyui"]`: the desktop behaviour; laptop line-art card: `can3d` and `canAnimate` true with `i2v` not ok; audio Stable Audio item on a laptop: `canGenerate` true when ready, label `Make on the desktop`; `jobRow` cases for `from`, `canWithdraw`, laptop Check; Probe laptop graphics row reads `On the desktop · ready` and `On the desktop (not seen since 14:05)`; desktop role row shows `Laptop jobs: paused` with a `Resume laptop jobs` button.
- [ ] **Step 2: Run** the four test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(desktop-jobs): Make on the desktop, Withdraw, Probe states`.

### Task 7: Acceptance notes

**Files:**
- Modify: `docs/acceptance-slice1.md` (new section "Desktop jobs (version 36)")

- [ ] **Step 1: Write** numbered steps Jon can follow with both computers: header line on each (ready, busy, paused, not seen since after closing the desktop's Studio, server unplugged); laptop ComfyUI shot Make on the desktop → waiting → running → take recorded and notice on the laptop only; Stable Audio sound and Blender 3D the same; Pause on the desktop holds a new job, Resume starts it; Withdraw with the desktop closed; close the laptop's Studio mid-job and reopen; close the desktop's Studio mid-Blender job → `Interrupted on the desktop; press Retry` on the laptop; `.studio-queue\finished\` holds the moved files and nothing was deleted.
- [ ] **Step 2: Run** `npm test` — all pass.
- [ ] **Step 3: Commit** `docs(desktop-jobs): acceptance steps`.
