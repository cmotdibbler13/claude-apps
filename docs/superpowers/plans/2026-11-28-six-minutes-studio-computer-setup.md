# Computer setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Studio run on a second computer (Jon's laptop) with its own project folder letter and tool paths, and make every failing Probe row fixable from Studio (choose, get, install), without changing the desktop.

**Architecture:** A `computer` module knows this computer's name, role and locally saved project folder. Settings gain a per-computer section merged over the shared values. A host wrapper re-bases any path that starts with a known project-folder spelling onto this computer's folder, for file access and process arguments alike, so paths saved on the desktop (`S:\…`) work on the laptop (`N:\…`). A tool-path module makes `ffmpeg`/`ffprobe` configurable. Probe grows the fix buttons and an installer for Jon's own apps.

**Tech Stack:** Plain ES modules; `node --test` with `tests/fake-host.mjs`. Paths relative to `six-minutes-studio/` unless they start with `docs/`.

**Spec:** `docs/superpowers/specs/2026-11-28-six-minutes-studio-computer-setup-design.md`

## Global Constraints

- The desktop is unchanged: with no `computers` entries and no local choice, root search, settings and behaviour are exactly as today (S: first, then the network path is still found).
- Per-computer keys (only these): `role`, `autocueDir`, `autocueRecordings`, `autocuePython`, `blenderPath`, `stemRemixerDir`, `ffmpegPath`, `comfy.url`, `comfy.outputDir`, `comfy.exe`, all of `stableAudio`, `autostart`. Everything else stays shared.
- Role values: `"desktop"` (label "Desktop (everything)") and `"laptop"` (label "Laptop (scripts and audio)"). A laptop defaults to `autostart: { comfy: false, stableAudio: false }`. Graphics tools on a laptop: ComfyUI, Animate workflow, Blender, Stable Audio.
- Never overwrite or delete: `.studio-settings.json` is copied aside (`copyAside` from `js/libraryio.js`) before Studio's first write of the day, then written with `writeSafely`; installs never go into an existing non-empty folder.
- Known project-folder spellings: `S:\Youtube video ideas`, `\\192.168.1.171\jon\Youtube video ideas`, and every `computers.*.root`. Matching is case-insensitive and on whole path segments.
- Get it links: ffmpeg `https://www.gyan.dev/ffmpeg/builds/`, Blender `https://www.blender.org/download/`, ComfyUI `https://www.comfy.org/download`, Pinokio `https://pinokio.computer/`, Python `https://www.python.org/downloads/windows/`. Repo page `https://github.com/cmotdibbler13/claude-apps`; app zip `https://codeload.github.com/cmotdibbler13/claude-apps/zip/refs/heads/main`.
- British English, plain UI words. No model identifiers in the repo. Commit trailers as usual.

## Review Focus

1. A path saved on the desktop (`S:\Youtube video ideas\Orkney\studio\media\x.mp4`) opened on the laptop whose root is `N:\Youtube video ideas` must resolve to `N:\…`, including inside ffmpeg arguments like `-i S:\…`; a path outside the root (`C:\Users\Jon\…`) is left alone. → Task 2 tests.
2. The desktop with today's settings file (no `computers`) gets exactly today's merged settings. → Task 1 test.
3. A laptop Probe choice writes only `computers.<NAME>` and leaves every shared key byte-for-byte as it was. → Task 1 test.
4. An install whose download or unpack fails leaves no folder at the target. → Task 5 test.
5. A chosen project folder that later disappears shows "Can't reach the project folder you chose (<path>)", not the generic message. → Task 6 test.

---

### Task 1: This computer and per-computer settings

**Files:**
- Create: `js/computer.js`
- Modify: `js/settings.js`
- Test: `tests/computer.test.mjs`, `tests/settings.test.mjs`

**Interfaces:**
- Produces:
  - `computerName(host) -> Promise<string>` — `cmd /c echo %COMPUTERNAME%` via `runProcess` (`js/proc.js`), trimmed, upper case; `"THIS-PC"` when it fails.
  - `localStore(host) -> {read(): Promise<{root?}>, write(obj): Promise<void>}` — file `%APPDATA%\Six Minutes Studio\computer.json` (APPDATA from `cmd /c echo %APPDATA%`; folder created); when the read/write of that file throws, falls back to `globalThis.localStorage` key `sms.computer` (wrapped in try/catch; no storage → `{}`).
  - `PER_COMPUTER = ["role","autocueDir","autocueRecordings","autocuePython","blenderPath","stemRemixerDir","ffmpegPath","autostart"]`, plus nested `COMFY_KEYS = ["url","outputDir","exe"]` and all of `stableAudio`.
  - `loadSettings(host, root, {computer} = {})` — as today, then merges `v.computers?.[computer]` over the result for the per-computer keys only (`comfy` keys and `stableAudio` merged field by field). Adds `role` (default `"desktop"`), `computer` (the name), `ffmpegPath` (default `"ffmpeg"`). Laptop role with no `autostart` in its entry → both off.
  - `saveComputerSettings(host, root, computer, patch, {now}) -> Promise<void>` — reads the raw file (missing → `{}`), sets `computers[computer] = {...old, ...patch}` (nested `comfy`/`stableAudio` merged), copies the file aside once per calendar day (skip when a `.studio-settings_<YYYY-MM-DD>-*.json` copy from today exists beside it), writes with `writeSafely` (`JSON.stringify(…, null, 2)`). Refuses keys not in the per-computer list (`"<key> is shared by every computer."`); `root` is also accepted (recorded for `rootSpellings`, never merged into settings).
  - `roleNeeded(rawSettings, computer) -> boolean` — true when `computers` has at least one entry and none for `computer`.

- [ ] **Step 1: Failing tests** — `computerName` returns `"LAPTOP-JON"` from a scripted `" laptop-jon\r\n"`; `localStore` round-trips through the file, and falls back to localStorage when `fs.write` throws; Review Focus 2 (today's file → `loadSettings` result deep-equals today's, plus `role:"desktop"`, `ffmpegPath:"ffmpeg"`, `computer`); a `computers.LAPTOP` entry with `autocueDir:"D:\\Apps\\Autocue Studio"`, `role:"laptop"` overrides only that key, keeps shared `mixMusicDb`, and turns autostart off; Review Focus 3 (`saveComputerSettings` then re-read: every key except `computers` deep-equals before, and one dated copy exists; a second save the same day makes no second copy); a shared key in the patch rejects with the exact text; `roleNeeded` cases.
- [ ] **Step 2: Run** `node --test tests/computer.test.mjs tests/settings.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(setup): this computer and per-computer settings`.

### Task 2: Project folder search and path re-basing

**Files:**
- Modify: `js/paths.js`
- Create: `js/rebase.js`
- Test: `tests/paths.test.mjs`, `tests/rebase.test.mjs`

**Interfaces:**
- Produces:
  - `resolveRoot(host, {chosen} = {}) -> Promise<string|null>` — `chosen` first when given and present (returns it); otherwise `PRIMARY_ROOT`, then `D:` … `Z:` + `\Youtube video ideas`, then `FALLBACK_ROOT`. A missing `chosen` returns `null` (no fallback search) so the app can say so.
  - `candidateRoots(host) -> Promise<string[]>` — every present one of: `C:`…`Z:` + `\Youtube video ideas`, and `FALLBACK_ROOT`.
  - `rootSpellings(rawSettings) -> string[]` — `[PRIMARY_ROOT, FALLBACK_ROOT, ...Object.values(raw.computers ?? {}).map(c => c.root).filter(Boolean)]`, unique case-insensitively.
  - `rebasePath(p, spellings, root) -> string` — when `p` (any slash style) starts with a spelling followed by `\` or end, swap that start for `root`; else return `p` unchanged. Non-strings returned as is.
  - `rebaseArg(arg, spellings, root)` — rebases a whole argument, and also the part after a leading `-i`-style `key=` (e.g. `fontfile=S\:/…` is out of scope: leave escaped filter paths alone).
  - `withRebase(host, spellings, root) -> host` — a new host object whose `fs.*` methods rebase every string path argument, whose `exec`/`spawn` rebase `cmd` and every string in `args`, and whose `shell.open` rebases its path; everything else passed through. When `root` is one of the spellings themselves, paths already under `root` are unchanged.

- [ ] **Step 1: Failing tests** — Review Focus 1 (`rebasePath("S:\\Youtube video ideas\\Orkney\\a.mp4", sp, "N:\\Youtube video ideas")` → `N:\…`; forward-slash input works; `S:\Youtube video ideas extra\x` unchanged; `C:\Users\Jon\x` unchanged; the UNC spelling rebased too); `withRebase` on a FakeHost: `fs.read("S:\\Youtube video ideas\\x")` reads `N:\…`; `spawn("ffmpeg", ["-i", "S:\\Youtube video ideas\\x.wav"])` gets the N: path; `resolveRoot` with no choice finds S: first, then `N:` when only N: exists, then UNC; with a missing `chosen` returns null; `candidateRoots` lists N: and the UNC path.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(setup): project folder per computer and path re-basing`.

### Task 3: ffmpeg path setting

**Files:**
- Create: `js/toolpaths.js`
- Modify: every `"ffmpeg"`/`"ffprobe"` process call: `js/audio.js:24,38`, `js/presenter.js:306`, `js/media.js:39`, `js/tools/higgsfield.js:158`, `js/tools/libmedia.js:10,31`, `js/tools/comfyui.js:125`, `js/tools/mixdown.js:195`; `js/ui/probe.js:139`
- Test: `tests/toolpaths.test.mjs` (+ existing suites stay green)

**Interfaces:**
- Produces: `setToolPaths({ffmpegPath})`, `tool("ffmpeg"|"ffprobe") -> string` — `"ffmpeg"` by default; with `ffmpegPath` set to a full `…\ffmpeg.exe`, `ffprobe` is `…\ffprobe.exe` in the same folder; a bare name stays bare. Call sites use `tool("ffmpeg")` / `tool("ffprobe")`; Probe's ffmpeg row checks `tool("ffmpeg")`.
- [ ] **Step 1: Failing tests** — defaults; `D:\Apps\ffmpeg\bin\ffmpeg.exe` gives `D:\Apps\ffmpeg\bin\ffprobe.exe`; one existing runner test (e.g. audio measure) sees the configured path in its spawned command.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(setup): configurable ffmpeg`.

### Task 4: Finding programs and opening download pages

**Files:**
- Create: `js/findtools.js`
- Test: `tests/findtools.test.mjs`

**Interfaces:**
- Produces:
  - `GET_IT = { ffmpeg, blender, comfyui, pinokio, python, repo }` — the Global Constraints URLs.
  - `openLink(host, url)` — `runProcess(host, "cmd", ["/c", "start", "", url])`; only URLs from `GET_IT` are accepted (others throw `"Not a known download page."`).
  - `findCandidates(host, kind) -> Promise<string[]>` for kind `ffmpeg | blender | python | autocue | stemremixer` — `where <exe>` results (ffmpeg, python), plus existing paths among: Blender `C:\Program Files\Blender Foundation\*\blender.exe` and the same under `D:\Program Files` and `D:\` (list the `Blender Foundation` folder, newest version name first); Python `%LOCALAPPDATA%\Programs\Python\Python3*\python.exe`; Autocue Studio and Stem Remixer folders holding `app.py` under `C:\Users\<user>\`, `D:\Apps\`, `D:\`, one level deep, whose names contain `autocue` / `stem`. Unique, existing only.
  - `checkChoice(host, kind, path) -> Promise<{ok, detail}>` — runs the same check Probe uses for that kind (`--version` for programs; for folders, `app.py` present, and for Stem Remixer the existing `stemRemixerCheck`).
- [ ] **Step 1: Failing tests** — `openLink` spawns `cmd /c start "" <url>` for a GET_IT URL and refuses another; `findCandidates("blender")` on a FakeHost with `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` and `D:\Program Files\Blender Foundation\Blender 4.5\blender.exe` lists 5.2 first; `where ffmpeg` output parsed; folders found by name; `checkChoice` passes and fails with the program check's text.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(setup): find programs and open download pages`.

### Task 5: Install Jon's apps

**Files:**
- Create: `js/installapps.js`
- Test: `tests/installapps.test.mjs`

**Interfaces:**
- Consumes: `runProcess`, `installAutocueJoin(host, dir)` (`js/autocueinstall.js`), `saveComputerSettings` (Task 1).
- Produces:
  - `APPS = { autocue: {folder: "autocue-studio", name: "Autocue Studio"}, stemremixer: {folder: "stem-remixer", name: "Stem Remixer"} }`.
  - `installApp(host, {app, parent, python, root, computer, now, onStep}) -> Promise<{dir}>`:
    1. `target = <parent>\<name>`; refuse when it exists and is not empty (`"<target> already has files in it. Choose another folder."`); refuse when `python --version` fails (`"Set up Python first."`).
    2. `tmp = <parent>\.sms-install-<now>`; `curl -L -f -o <tmp>\repo.zip <zip URL>`; `tar -xf <tmp>\repo.zip -C <tmp>`; the app folder is `<tmp>\claude-apps-main\<folder>`; rename it to `target`.
    3. Autocue: `<python> -m pip install -r <target>\requirements.txt`, then `installAutocueJoin(host, target)`, then save `autocueDir: target`, `autocueRecordings: <target>\Recordings`, `autocuePython: python`. Stem Remixer: run `<target>\Install.cmd` (via `cmd /c`), then save `stemRemixerDir: target`.
    4. Always remove `tmp` afterwards with `host.fs.trash` when available (the temp folder is Studio's own); on any failure before the rename, nothing exists at `target`; a failure after the rename leaves `target` and reports the step that failed.
    `onStep(text)` reports "Downloading…", "Unpacking…", "Installing…", "Done".
- [ ] **Step 1: Failing tests** — happy path for both apps on a FakeHost with scripted processes (the scripted `tar` creates `<tmp>\claude-apps-main\autocue-studio\app.py`): target exists with `app.py`, settings saved under the computer, `pip` and `Install.cmd` commands seen; Review Focus 4 (curl exit 22 → rejects with a message naming the download, no target folder, tmp removed); non-empty target refused before any download; no Python refused.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(setup): install Autocue Studio and Stem Remixer from the repo`.

### Task 6: Boot order and Films message

**Files:**
- Modify: `js/app.js` (boot `loadRoot`, `reloadSettings`), `js/ui/films.js`
- Test: `tests/films.test.mjs` (+ an app-free test for any new pure helper)

**Interfaces:**
- Boot: `computer = await computerName(host)`; `local = await localStore(host).read()`; `root = await resolveRoot(host, {chosen: local.root})`; raw settings read once for `rootSpellings`; `app.host = withRebase(host, spellings, root)` (keep the unwrapped host for `localStore` and `computerName`); `settings = await loadSettings(app.host, root, {computer})`; `setToolPaths(settings)`; everything else as today. `reloadSettings` passes `{computer}` and calls `setToolPaths`.
- `filmsModel` gains `chosenMissing: string|null`; when set the message is `"Can't reach the project folder you chose (<path>). Choose another in Probe."`.
- [ ] **Step 1: Failing tests** — Review Focus 5 via `filmsModel({root:null, chosenMissing:"N:\\Youtube video ideas"})`; the generic message unchanged without it.
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(setup): boot with this computer's folder and settings`.

### Task 7: Probe — role, project folder and fix buttons; laptop Make buttons

**Files:**
- Modify: `js/ui/probe.js`, `js/app.js` (Probe mount arguments, role question), `js/ui/review.js` and `js/ui/audio.js` (Make buttons on a laptop), `css/studio.css`
- Test: `tests/probe.test.mjs`, `tests/review*.test.mjs` / `tests/audio*.test.mjs` as they exist

**Interfaces:**
- Probe rows:
  - First row **"This computer"**: `<NAME> · Desktop (everything)` or `· Laptop (scripts and audio)`, with a **Change** toggle saving `role`. When `roleNeeded`, Probe shows only the question "Is this computer the desktop (everything) or a laptop (scripts and audio)?" with two buttons until answered.
  - The two root rows become one **"Project folder"** row: pass with the path in use; **Choose…** lists `candidateRoots` (with the path in use marked) and saves the pick with `localStore.write({root})` and `saveComputerSettings(…, {root})` (the record other computers use for re-basing), then reloads Studio's films and settings.
  - Every failing tool row gets fix buttons by kind: ffmpeg (Choose where it is…, Get it), Blender (Choose…, Get it), ComfyUI (Get it), Stable Audio (Get it: Pinokio), Stem Remixer (Choose…, Install here…), Autocue join (Choose…, Install here…, plus the existing Install join script), Python for installs (Choose…, Get it). **Choose where it is…** shows `findCandidates` as buttons plus a text field; a pick runs `checkChoice` and saves with `saveComputerSettings`. **Install here…** asks for the parent folder (text field, default `D:\Apps` when D: exists, else `C:\Apps`), shows `onStep` text, then re-runs Probe.
  - On a laptop the graphics rows show `On the desktop` (neutral, not failing) and **Set up here anyway** (reveals that row's normal check and buttons for this session).
- Laptop Make buttons: for assets whose tool is `comfyui`, `blender`, or Stable Audio takes, the Make/Redo button is disabled with the text "Make this on the desktop" when `settings.role === "laptop"`.
- [ ] **Step 1: Failing tests** — `probeRow`/model tests for: role question shown when needed; laptop graphics row is neutral "On the desktop"; fix buttons per kind; the project folder row; a review card for a ComfyUI shot on a laptop shows the disabled "Make this on the desktop".
- [ ] **Step 2–4:** run (FAIL), implement, `npm test` (pass).
- [ ] **Step 5: Commit** `feat(setup): Probe role, project folder and fix buttons`.

### Task 8: Acceptance notes

**Files:** Modify `docs/acceptance-slice1.md` (section "Two computers (version 31)").
- [ ] **Step 1:** Checklist: desktop first — Probe unchanged apart from the new rows, films load from S:; laptop — role question, choose N:, films load, a desktop-made take plays (re-based path), Get it opens the ffmpeg page, Choose where it is for ffmpeg, Install here for Autocue Studio into `D:\Apps`, Autocue join passes, Stem Remixer install, graphics rows "On the desktop", a ComfyUI shot shows "Make this on the desktop"; check `.studio-settings.json` has a `computers` section and a dated copy beside it, and the desktop still works afterwards.
- [ ] **Step 2:** `npm test` — pass. **Step 3: Commit** `docs(setup): acceptance checklist`.
