# Six Minutes Studio score and SFX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score and sound-effect cards on the film's Review. Claude plans them, Stable Audio (local, started by the app) or ElevenLabs (credits, with the estimate shown) generates them, and Jon plays, picks, approves and redoes them with a note.

**Architecture:** Two new runners join the existing job queue. `stableaudio` is on the gpu lane: local Gradio over curl, started through Pinokio's `pterm`. `elevenlabs` is on the connector lane: flow nodes through the `mcp` capability. Audio cards live in `state.audio` and reuse the b-roll take rules. `watchJobs` is generalised so it mirrors jobs onto any "take holder" (b-roll asset, score, SFX cue). The ffmpeg post-processing and measuring is shared in `js/audio.js`.

**Tech Stack:** Plain ES modules, `node --test`, the FakeHost test double, curl and ffmpeg through `runProcess` (argument lists, no shell).

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-score-sfx-design.md`. The Stable Audio API notes are `six-minutes-studio/docs/stable-audio-api-notes.md`.

## Global Constraints
- **Credits:** never spend them without Jon pressing a button that shows the estimate. Never re-run a paid generation automatically. `creative_run_flow_nodes` is called at most once per job `start()` and never in `resume()`.
- **Takes:** new takes are added and are never replaced or deleted. Stable Audio's own output files are only read.
- **Where the app writes:** only `<film>\studio\…` and the app's root files.
- **Spawning:** every spawn uses an argument list. `shell: true` is used only for the fixed pterm command, whose arguments never contain prompt or file text.
- **ElevenLabs music:** node type `music`, model `eleven_music_v2_5`, params `{duration_seconds (3–600), lyrics_type:"instrumental", instrumental:true}`.
- **ElevenLabs SFX:** node type `sfx`, model `eleven_text_to_sound_v3`, params `{duration_seconds (0.5–30), prompt_influence:0.3, loop}`.
- **ElevenLabs runs:** `generations_count: 1` on every run.
- **Stable Audio settings:**
  - URL `http://127.0.0.1:7860`;
  - 29 values in the notes' order plus a trailing `null`;
  - `seconds_total` a whole number of seconds, 1–120;
  - steps 8, CFG 1.0, seed -1, `file_format` "wav", `cut_to_seconds_total` true.
- **Near-silent:** a peak below -30 dBFS or a mean below -50 dB.
- **SFX output:** `<film>\studio\media\<project>_sfx_<cue>_t<n>.wav` (48 kHz, trimmed, 10 ms fades), with the original kept as `<same stem>.orig.<ext>`.
- **Score output:** `<film>\studio\media\<project>_score_t<n>.<ext>`.
  - `<project>` is the film folder's name sanitised to `[A-Za-z0-9_-]`.
- **Copy:** British English, Jon's house style (plain, short, no em dashes in new strings).
- **The pterm command:** `C:\pinokio\bin\npm\pterm.cmd` with args `["run", "C:\\pinokio\\api\\stable-audio-3-small.pinokio.git", "--default", "start.js?model=small-sfx"]`. Both paths are settings with these defaults.
- **No model identifiers** in code or commits (other than ElevenLabs' own model ids above).

## Review Focus
1. **The ElevenLabs download link expires** (about 4 days). A job that reconnects after a long gap must still try the link, and a curl 403 should say "The ElevenLabs link has expired; open the flow in ElevenLabs to download it" rather than show raw curl text. Test in Task 4.
2. **Jon edits the prompt after seeing an estimate.** The estimate must belong to exactly what Generate starts: a changed prompt, length or loop clears the estimate and the Generate button until a new estimate is fetched. Test in Task 5.
3. **Stable Audio is already running (started from Pinokio by hand)**, or the app reloads while its pterm process lives on. Start must see "ready" and not spawn a second pterm. Test in Task 2.
4. **The Music model is on port 7860.** A take must fail with the Music message and never submit. Test in Task 3.
5. **Two score takes started together** both run on one node with separate session ids. Neither may overwrite the other's take, and the second must not create a second node. Test in Task 5.

---

### Task 1: Audio post-processing and measuring (`js/audio.js`)

**Files:**
- Create: `six-minutes-studio/js/audio.js`
- Test: `six-minutes-studio/tests/audio.test.mjs`

**Interfaces:**
- Produces:
  - `parseMeasure(stderr: string) -> {lengthS:number|null, peakDb:number|null, meanDb:number|null}`. Pure. Reads ffmpeg `volumedetect` (`max_volume: -5.0 dB`, `mean_volume: -31.7 dB`) and the `Duration: 00:00:04.00` line.
  - `isQuiet({peakDb, meanDb}) -> boolean`: peak < -30 or mean < -50. Unknown values count as not quiet.
  - `measure(host, file) -> Promise<{lengthS, peakDb, meanDb, quiet}>`: runs `ffmpeg -hide_banner -i <file> -af volumedetect -f null -`. A non-zero exit throws `Couldn't measure <basename>`.
  - `finishSfx(host, src, out) -> Promise<{file:out}>`:
    - ffmpeg to `out.replace(/\.wav$/, ".part.wav")`, then rename to `out`;
    - filter: `silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,afade=t=in:d=0.01`, then a 10 ms fade-out placed with `areverse,afade=t=in:d=0.01,areverse`;
    - `-ar 48000 -c:a pcm_s16le`;
    - the `.part` file is trashed on failure. `src` is never touched.
  - `projectOf(filmDir) -> string`: the folder name sanitised to `[A-Za-z0-9_-]`.

- [ ] **Step 1: Write failing tests**
  - `parseMeasure` on a real-looking volumedetect stderr gives `{lengthS:4, peakDb:-5, meanDb:-31.7}`.
  - `parseMeasure("")` gives all nulls.
  - `isQuiet`: `{peakDb:-31, meanDb:-40}` is true; `{peakDb:-5, meanDb:-51}` is true; `{peakDb:-5, meanDb:-31.7}` is false; `{peakDb:null, meanDb:null}` is false.
  - `finishSfx`: FakeHost ffmpeg writes its last arg. `out` exists afterwards, no `.part.wav` is left, and the args include `-ar`, `48000` and the `afade` filter. When ffmpeg exits 1, the call rejects, `out` doesn't exist, `.part` is gone and `src` is unchanged.
  - `projectOf("S:\\Youtube video ideas\\Protect and Survive (027)")` gives `"Protect_and_Survive__027_"`.
- [ ] **Step 2: Run `cd six-minutes-studio && node --test tests/audio.test.mjs`.** Expect FAIL (module missing).
- [ ] **Step 3: Implement `js/audio.js`** using `runProcess` (FFMPEG timeout 5 min).
- [ ] **Step 4: Run the tests.** Expect PASS, and the full `npm test` still passes.
- [ ] **Step 5: Commit** `Studio: audio finishing and measuring`.

### Task 2: Stable Audio status and starter (`js/tools/stableaudio.js`, part 1)

**Files:**
- Create: `six-minutes-studio/js/tools/stableaudio.js`
- Modify: `six-minutes-studio/js/host.js:49-50` (pass `shell` through)
- Modify: `six-minutes-studio/js/settings.js` (add `stableAudio` defaults and merge them the same way `comfy` is merged)
- Test: `six-minutes-studio/tests/stableaudio.test.mjs`, `tests/settings.test.mjs` (one case)

**Interfaces:**
- Consumes: `runProcess`, the `host.spawn(cmd, args, {shell})` shape.
- Produces:
  - `DEFAULT_SETTINGS.stableAudio = { url: "http://127.0.0.1:7860", pterm: "C:\\pinokio\\bin\\npm\\pterm.cmd", app: "C:\\pinokio\\api\\stable-audio-3-small.pinokio.git", steps: 8, cfg: 1.0 }`.
  - `host.spawn(cmd, args, {cwd, shell})`: passes `shell: true` to `childProcess.spawn` only when `opts.shell === true`.
  - `stableAudioState(host, sa) -> Promise<"ready"|"music"|"off"|"other">`:
    - curl `GET <url>/` gives the title;
    - "Small SFX" in `<title>` means "ready" when `GET <url>/gradio_api/info` also contains `"/generate"`;
    - "Music" in the title means "music";
    - a connection failure (curl exit 7 or 6, or a spawn error) means "off";
    - anything else is "other".
  - `makeStableAudioStarter({sleep, settings}) -> { state(): string, message(): string|null, ensure(host): Promise<void>, stop(): Promise<void>, onChange(fn): () => void }`:
    - `state()` is one of `"off" | "starting" | "ready" | "music" | "failed"`.
    - `ensure(host)`:
      - If already "ready" by a live check, resolve without spawning.
      - If "music", set the state to "music" and throw `Stable Audio Music is running. Stop it in Pinokio, then press Start Stable Audio.`
      - Otherwise spawn pterm once (`shell: true`) and keep the process.
      - Poll `stableAudioState` every 2 s, up to 120 s.
      - If pterm exits before ready with "42000", "ECONNREFUSED" or "connect" in its output, or exits within the first poll, throw `Open Pinokio first, then press Start Stable Audio.`
      - After a timeout, throw `Stable Audio didn't start. Look at its Terminal in Pinokio, or switch this cue to ElevenLabs.`
      - Concurrent `ensure` calls share one promise.
    - `stop()` kills the kept pterm process, if any.
- [ ] **Step 1: Write failing tests**
  - Title "Stable Audio 3 Small SFX" plus info with `/generate` gives "ready"; the Music title gives "music"; curl exit 7 gives "off".
  - `ensure` while already ready makes **no** pterm spawn (Review Focus 3).
  - `ensure` from off spawns pterm once with `opts.shell === true` and exactly the four args. It polls until ready (fake sleep) and the state ends "ready".
  - Two parallel `ensure` calls make one spawn.
  - pterm exits 1 with stderr "connect ECONNREFUSED 127.0.0.1:42000" before ready, so the call rejects with the Pinokio message.
  - 61 polls without ready give the didn't-start message.
  - With "music", it rejects with the Music message and makes no spawn.
  - `stop()` calls kill on the kept process.
  - Settings: an empty settings file gives `stableAudio.url` as the default, and `{stableAudio:{steps:12}}` keeps the url and sets steps to 12.
- [ ] **Step 2: Run** `node --test tests/stableaudio.test.mjs tests/settings.test.mjs`. Expect FAIL.
- [ ] **Step 3: Implement**, including the `host.js` `shell` pass-through and the settings merge.
- [ ] **Step 4: Run.** Expect PASS, and `npm test` passes.
- [ ] **Step 5: Commit** `Studio: start and check Stable Audio Small SFX`.

### Task 3: Stable Audio runner (`js/tools/stableaudio.js`, part 2)

**Files:**
- Modify: `six-minutes-studio/js/tools/stableaudio.js`
- Test: `six-minutes-studio/tests/stableaudio.test.mjs`

**Interfaces:**
- Consumes: the starter from Task 2, and `finishSfx`, `measure` and `projectOf` from Task 1.
- Produces:
  - `saPayload(prompt, seconds, sa) -> {data: any[]}`: pure. 29 entries: the notes' order with seed -1 and `""` negative, then the trailing `null`. `seconds` is rounded to a whole number and clamped to 1–120.
  - `parseSse(text) -> {done:boolean, error:boolean, url:string|null}`: pure. Finds `event: complete` and the next `data:` line, and takes the first element's `url`. `event: error` gives error.
  - `makeStableAudioRunner({settings, starter, sleep}) -> {lane:"gpu", start(job, ctx), resume(job, ctx)}`:
    - `job.input = {prompt, seconds, out}`, where `out` ends `.wav`.
    - `start`:
      - `await starter.ensure(host)`. The Music state throws its message before any POST (Review Focus 4).
      - POST `<url>/gradio_api/call/generate` with the body written to `<film>\studio\tmp\sa_body.json` and sent with `--data-binary @file`, as ComfyUI does. Read `event_id`.
      - `curl -sS -N <url>/gradio_api/call/generate/<id>` (timeout 5 min), then `parseSse`.
      - Download the url: percent-encode only the part after `file=` with `encodeURIComponent` on each path segment and keep `/`. Accept only urls starting with `<url>/gradio_api/file=`. Download with curl to `<out stem>.orig.wav`.
      - Then `finishSfx(orig, out)`, then `measure(out)`.
      - Return `{file: out, meta: {lengthS, peakDb, meanDb, quiet, source:"stableaudio"}}`.
    - `resume` always throws `Interrupted; Stable Audio takes are quick, so run it again.` (no jobRef is set).
- [ ] **Step 1: Write failing tests**
  - `saPayload("x", 4.4, defaults).data` has length 29, `[2]` is 4, `[6]` is -1, `[14]` is "wav" and the last value is null. `saPayload(…, 0.2)` gives 1 at `[2]`.
  - `parseSse` on the notes' sample stream gives a url, and `"event: error\ndata: null"` gives error.
  - A full `start` with FakeHost scripts (title ready, POST gives `{"event_id":"E1"}`, the stream gives complete with a url containing spaces, download, ffmpeg) leaves `out` and `.orig.wav` existing. The download arg is percent-encoded ("%20"), the result has `meta.source "stableaudio"`, and `quiet` is false.
  - A url not under `<url>/gradio_api/file=` rejects without downloading.
  - With the Music title, it rejects with the Music message and no POST happens.
  - SSE error gives `Stable Audio failed on this prompt. Look at its Terminal in Pinokio.`
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS, and `npm test` passes.
- [ ] **Step 5: Commit** `Studio: Stable Audio runner`.

### Task 4: ElevenLabs runner and estimate (`js/tools/elevenlabs.js`)

**Files:**
- Create: `six-minutes-studio/js/tools/elevenlabs.js`
- Test: `six-minutes-studio/tests/elevenlabs.test.mjs`

**Interfaces:**
- Consumes: `host.mcp.call("ElevenLabs", tool, input)`, `runProcess`, and `finishSfx`, `measure` and `projectOf` from Task 1.
- Produces:
  - `nodeSpec(kind:"score"|"sfx", {prompt, durationS, loop}) -> {node_type, model_id, prompt, model_parameters}`. Pure. Values from Global Constraints. The duration is clamped (score 3–600, SFX 0.5–30).
  - `nodeSig(kind, item) -> string`: `JSON.stringify` of `nodeSpec`. Used to tell whether an existing node still matches.
  - `ensureFlow(host, name) -> Promise<string>`: `creative_create_flow {name}` gives `flow_id`.
  - `addNode(host, flowId, kind, item, label) -> Promise<string>`: `creative_add_flow_node` gives the node id. Parse `node_id ?? node?.id ?? nodes?.[0]?.id`, or throw.
  - `estimate(host, flowId, nodeId) -> Promise<number|null>`: `creative_run_flow_nodes {flow_id, node_ids:[nodeId], estimate_only:true, generations_count:1}`. Parse credits from `credits ?? estimated_credits ?? cost?.credits ?? total_credits`; otherwise use the first number under a key containing "credit". It never generates.
  - `parseStatus(p) -> {done, failed, poll:number, url:string|null, error:string|null}`: pure. Uses `all_completed`, `has_failures` and `poll_after_seconds` (default 10, minimum 5). The url is `generations[0].content_url ?? media[0].url ?? media[0].master_url`. The error is `generations[0].error ?? "ElevenLabs reported a failure"`.
  - `makeElevenRunner({sleep}) -> {lane:"connector", start, resume}`:
    - `job.input = {kind, flowId, nodeId, out, sfx:boolean}`, where `out` has no extension.
    - `start`:
      - `creative_run_flow_nodes {flow_id, node_ids:[nodeId], generations_count:1}` is called exactly once. Read `session_ids[0]`, or else `session_id`.
      - An MCP error code that isn't in the Higgsfield `DEFINITE` set throws ambiguous: `ElevenLabs may have started this take. Use Check again before running it again.`
      - Then `ctx.setRef(JSON.stringify({flowId, sessionId}))`, then wait.
    - `resume`: parse the jobRef and wait. It never runs a node.
    - Wait:
      - poll `creative_get_flow_run_status {flow_id, session_ids:[sessionId]}` every `poll` seconds, with a cap of 30 min (then ambiguous);
      - 5 consecutive call errors throw ambiguous;
      - progress eta is `"generating"`.
    - On done:
      - Accept only `https://` urls without `"` or whitespace.
      - The extension comes from the url path (mp3, wav, …), default mp3.
      - Download with curl `-L --fail -sS -o`. When curl exits 22 and stderr contains "403", throw `The ElevenLabs link has expired; open the flow in ElevenLabs to download it.` (Review Focus 1).
      - Score: the file is `out.<ext>`. SFX: download to `out.orig.<ext>`, then `finishSfx` to `out.wav`.
      - Measure, and return `{file, meta:{…, source:"elevenlabs"}}`.
- [ ] **Step 1: Write failing tests**
  - `nodeSpec("score", {prompt:"p", durationS:410})` gives the music node with `instrumental:true` and `lyrics_type:"instrumental"`. `nodeSpec("sfx", {prompt:"p", durationS:45, loop:true})` gives `duration_seconds 30`, `loop true` and `prompt_influence 0.3`.
  - `parseStatus` on the **observed payload from the spec** (copy the 027 shape with one generation) gives done and a url ending `content.mp3?Expires=…`.
  - `start` calls `creative_run_flow_nodes` exactly once with `generations_count:1` and no `estimate_only`. The jobRef is set before the first status poll. A score output is written to `out.mp3`, and `meta.source` is "elevenlabs".
  - SFX: the `.orig.mp3` and the `.wav` exist.
  - `resume` with a jobRef polls and downloads and **never** calls `creative_run_flow_nodes`.
  - A 403 download gives the expired-link message.
  - A `server_unavailable` error on run gives an ambiguous error.
  - `estimate` sends `estimate_only:true` and returns 6149 from `{credits:6148.6}` (rounded up).
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** Export `DEFINITE` from `tools/higgsfield.js` (moved, not copied) and import it here.
- [ ] **Step 4: Run.** Expect PASS, and `npm test` passes.
- [ ] **Step 5: Commit** `Studio: ElevenLabs music and SFX runner`.

### Task 5: Audio plan, takes and state (`js/audioplan.js`, `js/redo.js`, `js/jobs.js`)

**Files:**
- Create: `six-minutes-studio/js/audioplan.js`
- Modify: `six-minutes-studio/js/jobs.js` (copy `res.meta` to `job.meta`)
- Modify: `six-minutes-studio/js/redo.js` (`applyJobs` iterates take holders and copies `j.meta` onto the take when done)
- Test: `six-minutes-studio/tests/audioplan.test.mjs`, plus cases in `tests/redo.test.mjs` and `tests/jobs.test.mjs`

**Interfaces:**
- Consumes: Task 4 `nodeSpec`, `nodeSig`, `ensureFlow`, `addNode` and `estimate`; Task 1 `projectOf`; `askJson`; `store`; `jobs`.
- Produces:
  - `holders(d) -> Array<{id, takes}>`: `[...d.assets ?? [], ...(d.audio?.score ? [d.audio.score] : []), ...(d.audio?.sfx ?? [])]`. The score's id is `"SCORE"`. `applyJobs` and the lost-job sweep use it instead of `d.assets`. `deriveWaiting` is unchanged (b-roll only).
  - `PLAN_INSTRUCTIONS` (exact copy is the builder's, in house style). Claude returns `{score:{prompt, durationS}, sfx:[{cue, prompt, durationS, loop}]}`:
    - the score prompt has style, instruments, tempo and "Energy arc:" with mm:ss sections from estimated times (script words / 150 wpm, plus 6 s cold-open hold and end card);
    - SFX cues come from the handover's approved list;
    - durations: score 3–600, SFX 1–30;
    - `loop` only for ambience.
  - `planAudio(host, store, {scriptText, handoverText}) -> Promise<void>`:
    - refuses with `Music and sound effects are already planned.` when `state.audio` has a score or any cue;
    - one `askJson` (tier "default") and validation;
    - writes `state.audio = {flowId:null, score:{id:"SCORE", cue:"Score", prompt, durationS, takes:[], chosen:null, approved:false, node:null, est:null}, sfx:[{id:"SFX-01"…, cue, prompt, durationS:int, loop, source:"stableaudio", takes:[], chosen:null, approved:false, node:null, est:null}]}`;
    - logs `Music and sound effects planned (N cues)`.
  - `addCue(store, {cue, prompt, durationS}) -> id`: the next SFX-nn.
  - `editItem(store, id, {prompt?, durationS?, loop?, source?})`:
    - refused while a take is busy;
    - any change to prompt, duration or loop clears `est` (Review Focus 2);
    - `source` must be "stableaudio" or "elevenlabs".
  - `getEstimate(ctx, id) -> Promise<number>`:
    - ensures `audio.flowId` (flow name `<film title> — score and SFX`, saved);
    - ensures `item.node` matches `nodeSig` (otherwise `addNode` and save `{id, sig}`);
    - calls `estimate` and saves `item.est = {credits, sig}`.
  - `startAudioTake(ctx, id, {note, count=1}) -> Promise<number[]>` (take numbers):
    - With a note: `askJson` tier "quick" rewrites the prompt from the note first (reuse the b-roll rewrite shape, with audio wording). The new prompt is saved to the item, so the estimate is now stale.
    - For an ElevenLabs source, it needs `item.est.sig === nodeSig(...)`, or it throws `Get the cost first.`. Nothing is paid without the shown estimate.
    - Pushes `count` takes `{n, source, prompt, status:"queued", note?, at}` and adds one job each:
      - `tool: source`, `assetId: id`, `take: n`;
      - `what`: `Score take n` or `SFX-03 door creak take n`;
      - input: Stable Audio `{prompt, seconds, out: media/<project>_sfx_<cue-slug>_t<n>.wav}`; ElevenLabs `{kind, flowId, nodeId, sfx, out: media/<project>_score_t<n>}` or `…_sfx_<cue-slug>_t<n>`.
    - Uses the same pending and failure handling as `startTake`.
    - `count` > 1 is allowed only for the score. Both takes share the one node (Review Focus 5).
    - A redo with a note on ElevenLabs takes two presses: first the note rewrites the prompt and fetches the estimate, then Generate.
  - `chooseAudio`, `approveAudio` and `unapproveAudio(ctx, id, n?)`: the same rules as `choose`, `approve` and `unapprove`.
- [ ] **Step 1: Write failing tests**
  - `planAudio` writes the shape above with SFX-01.. ids and the stableaudio default, and a second call rejects.
  - `editItem` changing the prompt clears `est`.
  - `startAudioTake` on an ElevenLabs item without a matching `est` rejects and adds no job. With an estimate, `count:2` on the score adds two jobs with the **same** nodeId and takes 1 and 2.
  - `getEstimate` reuses `node` when the sig matches (`creative_add_flow_node` is called once over two estimates) and adds a new node after a prompt edit.
  - Stable Audio SFX take: the job input `out` is `…\studio\media\Film_A_sfx_door-creak_t1.wav` and `seconds` is a whole number.
  - `redo`: `watchJobs` with a done job for `SFX-01` take 1 carrying `meta` sets the take's file, lengthS and quiet.
  - A busy SCORE take with no job is marked lost.
  - `jobs`: a runner returning `{file, meta}` gives the job `meta`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS, and `npm test` passes (existing b-roll tests unchanged).
- [ ] **Step 5: Commit** `Studio: plan and take music and sound effects`.

### Task 6: Review UI, Probe and app wiring

**Files:**
- Create: `six-minutes-studio/js/ui/audio.js` (`audioModel` and `audioSections`)
- Modify:
  - `js/ui/review.js`: `reviewModel` takes `audio` and `sa`; `render` puts the sections after Narration and before the summary and B-roll, and also shows them when there's no shot list yet.
  - `js/ui/probe.js`: a "Stable Audio" check plus "ElevenLabs tools" (`creative_create_flow`, `creative_add_flow_node`, `creative_run_flow_nodes`, `creative_get_flow_run_status`).
  - `js/app.js`: runners, starter, actions, Stop on `pagehide`.
  - `js/labels.js`: `stableaudio: "Stable Audio"`, `elevenlabs: "ElevenLabs"`.
  - `css/studio.css`: reuse the card styles; add only the audio row and chip.
- Test: `six-minutes-studio/tests/viewmodel.test.mjs`, `tests/probe.test.mjs`

**Interfaces:**
- Consumes: everything above, plus the existing `playTake(file)` (the single shared player) and `cardAction`.
- Produces:
  - `audioModel(audio, {pending, cardErrors, noteFor, playing, sa}) -> {needsPlan, sa:{state, label, canStart}, score:item|null, sfx:item[]}`. An item is `{id, cue, prompt, durationS, loop, source, sourceLabel, busy, est, estStale, generateLabel, canGenerate, takes:[{n, source, file, playing, lengthS, peakDb, quiet, status, error, chosen}], chosen, approved, canApprove, error, noteOpen}`.
    - `generateLabel`:
      - Stable Audio: `Generate 2 takes · Free` for the score, or `Generate take · Free` for a cue.
      - ElevenLabs with a current estimate: `Generate 2 takes · about N credits` for the score (N = 2 × est), or `Generate take · about N credits` for a cue.
      - ElevenLabs without one: `Get the cost`.
    - A quiet take shows the chip `Near-silent`. A take shows `4.0 s · peak -5 dB`.
    - The `sa` chip labels are `Off`, `Starting…`, `Ready`, `Music model loaded` and `Didn't start`.
  - The app's actions are `planAudio`, `addCue`, `editAudio(id, patch)`, `getCost(id)`, `generateAudio(id)`, `redoAudio(id, note)`, `chooseAudio(id, n)`, `approveAudio(id)`, `unapproveAudio(id)`, `startStableAudio()` and `playTake(file)`, all through `cardAction` where per-item. Generate and Redo call `userStarted()` first.
  - The Probe's "Stable Audio" check shows `Ready (Small SFX)` or fails with `Off: press Start Stable Audio on a film's Review`, or the Music message.
  - The app creates the starter once, gives it to the runner and redraws on `starter.onChange`. On `pagehide` it calls `starter.stop()`.
- [ ] **Step 1: Write failing tests (viewmodel and probe)**
  - With no audio, `needsPlan` is true.
  - A score on ElevenLabs with `est {credits:6149, sig}` matching gives `Generate 2 takes · about 12298 credits`, and `canGenerate` is true. With a stale sig, the label is `Get the cost` and `canGenerate` is false.
  - A Stable Audio cue gives `Generate take · Free`.
  - A quiet take gets its chip, and the playing file is marked.
  - Probe: the title "Small SFX" plus info gives pass, and connection refused gives the Off message.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement the model, the sections, the probe checks and the app wiring.**
  - **Prompts** are edited in a `<textarea>` saved on blur via `editAudio`. **Length** is a number input, and **Loop** a checkbox shown only for ElevenLabs cues. The **source** is a two-button toggle like the b-roll one.
  - "Plan music and sound effects" reads the script and handover the same way `makeShotList` does (`findScript`, `readText`).
- [ ] **Step 4: Run `npm test` and `node --check` on each changed file.** Expect all to pass.
- [ ] **Step 5: Commit** `Studio: score and sound effects on Review`.

### Task 7: Publish, checklist and PR note (controller does this, not a subagent)

- [ ] Add a "Score and sound effects" section to `six-minutes-studio/docs/acceptance-slice1.md` with steps for Jon:
  1. Open Pinokio.
  2. Run Probe: Stable Audio shows Off.
  3. On a film's Review, press Plan music and sound effects.
  4. Press Start Stable Audio. It shows Ready in under a minute.
  5. Generate one SFX take on Stable Audio and play it.
  6. Switch one cue to ElevenLabs and press Get the cost. Check the number is sensible.
  7. Generate one ElevenLabs SFX take. It costs little; do this before the score.
  8. Get the score cost, generate 2 takes, pick one and approve it.
  9. Close the app from the tray. Small SFX stops in Pinokio.
- [ ] Publish the artifact (same URL) with capabilities: desktop as stored, sample, and mcp `{Higgsfield:[…same four…], ElevenLabs:["creative_create_flow","creative_add_flow_node","creative_run_flow_nodes","creative_get_flow_run_status"]}`.
- [ ] Push and comment on PR #4 with a summary and the checklist pointer.

### Task 8 (added 27 Nov at Jon's request, run after Task 2): "Make 3D in Blender" on every line drawing

Jon: "all the line drawings will need a button to make them 3d in blender please if they dont already have that option in the script."

**Files:**
- Modify: `six-minutes-studio/js/redo.js` (new `addBlender3d`)
- Modify: `six-minutes-studio/js/ui/review.js` (`cardModel` gets `can3d`; `controls` gets the button)
- Modify: `six-minutes-studio/js/app.js` (`reviewActions.make3d`)
- Test: `six-minutes-studio/tests/redo.test.mjs`, `tests/viewmodel.test.mjs`

**Interfaces:**
- Produces:
  - `has3d(assets, lineartId) -> boolean`: some asset has `kind === "blender"` and `sourceId === lineartId`.
  - `addBlender3d(ctx, lineartId) -> Promise<string>` (the new id):
    - Refused unless the source is `kind "lineart"`: `<id> is not line art.`
    - Refused when `has3d`: `<id> already has a Blender version.`
    - Adds `{id: next free "HF-nn" (highest existing number + 1, two digits minimum), kind:"blender", tool:"blender", sourceId, line, lineIndex (copied from the source), desc:"3D line-art version of <source desc, first letter lower-cased>", draftPrompt:"3D line-art version of <source id> in Blender", takes:[], chosen:0, approved:false}` through the same `save` helper, so `waiting` is updated.
    - Logs `<new id> added: 3D version of <source id> in Blender`.
    - The new card sits beside its source (same `lineIndex`, a later id). It is locked until the source is approved, as now (`canStart`).
  - `cardModel(...).can3d`: true for a lineart card with no Blender version, when the card is free (not busy or pending). The button text is `Make 3D in Blender`. It is a ghost button in the card's row, shown whether or not the drawing is approved yet.
- [ ] **Step 1: Write failing tests**
  - `addBlender3d` on HF-02 (lineart) in a list whose highest id is HF-07 adds HF-08, with `sourceId` HF-02, the same `lineIndex`, and `tool` "blender". A second call rejects with `HF-02 already has a Blender version.`
  - On a broll shot, it rejects with the not-line-art message.
  - The viewmodel shows `can3d` true for a lineart card without a Blender version, false when one exists, and false on broll and blender cards.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement.** **Step 4: Run `npm test`.** Expect PASS.
- [ ] **Step 5: Commit** `Studio: Make 3D in Blender on every line drawing`.
