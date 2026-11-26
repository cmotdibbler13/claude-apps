# Six Minutes Studio: score and sound effects (design)

Agreed with Jon, 27 Nov 2026. This is the first of three builds: (1) score and SFX, generate and review; (2) voiceover join and mix preview; (3) face-to-camera talking head. Main spec: `2026-11-26-six-minutes-studio-design.md`.

## Why
Music and sound effects are made in a Claude session today. Jon wants them on the app's review board like the b-roll: generated without a session, played, picked, and redone with a note, with the cost clear before credits are spent.

## Goals
- **Score.** One "Score" card per film.
  - Claude drafts the score prompt from the script and `part1_handover.md`: genre, instruments, tempo, and a timed energy arc using **estimated** section times (script words at about 150 wpm, plus a 6 s cold-open hold and the end card).
  - Jon sees the prompt, can edit it, and sees ElevenLabs' **credit estimate** before pressing **Generate 2 takes**.
  - Each take has ▶, Pick, and Redo with a note.
- **Sound effects.** One card per cue on the approved Part 1 list, which Claude reads from `part1_handover.md` (prose or table, whatever its layout), 2 takes per cue.
  - Each cue has a **source switch**, **Stable Audio (free, local)** / **ElevenLabs (credits)**, defaulting to Stable Audio.
  - A **Loop** option on ambience cues (ElevenLabs only; Stable Audio has none).
  - Each take shows its source, length and level, and is **flagged when near-silent**.
- Picked takes are recorded in the film's state for the Part 2 handover (a later build writes the handover).
- **The app starts Stable Audio itself** (Jon's call, 27 Nov): a **Start Stable Audio** button, and a Stable Audio take started while it's off starts it first.

## Non-goals (this build)
- Measuring the score against the voiceover sections, beat-fitting, the timing sheet and the mix preview. Those are build 2, which also joins the voiceover.
- Starting Pinokio itself. Pinokio.exe must already be open; the app says so if it isn't.
- ElevenLabs flows the app didn't make.

## Anti-goals
- Spending credits without Jon seeing the estimate first. Never re-running a paid generation automatically.
- Replacing or deleting takes.
- Writing anywhere except the film's `studio\` folder and the app's own root files.

## Constraints
- **ElevenLabs** through the `mcp` capability, server "ElevenLabs":
  - `creative_create_flow`, `creative_add_flow_node`, `creative_run_flow_nodes` (with `estimate_only: true` for the cost), `creative_get_flow_run_status`.
  - Music is node type `music`, model `eleven_music_v2_5`, params `duration_seconds` (3–600), `lyrics_type: "instrumental"`, `instrumental: true`.
  - SFX is node type `sfx`, model `eleven_text_to_sound_v3`, params `duration_seconds` (0.5–30), `prompt_influence` (0–1, default 0.3), `loop`.
  - Generations are poll-based. Pass the `generations_count` explicitly. A single take costs about 6,150 credits (about $1.12) for a 6:50 score.
  - **Observed result shape** (Jon's 027 score flow, 27 Nov): `creative_get_flow_run_status {flow_id, session_ids}` returns `{all_completed, has_failures, generations:[{id, status, content_url, duration_secs, price:{credits}}], media:[{generation_id, url, master_url}]}`. The file is `content_url` (or `media[].url`): a signed mp3 link that expires in about 4 days, so download it as soon as the take completes. Still parse defensively (fall back from `content_url` to `media[].url` to `master_url`).
  - One ElevenLabs flow per film, its id kept in the film's state.
- **Stable Audio 3 Small SFX** (Pinokio, Gradio 6.3) at `http://127.0.0.1:7860`, per `S:\Youtube video ideas\Stable Audio\api_notes.md`:
  - POST `/gradio_api/call/generate` with `{"data":[…29 values…]}`, in the exact order given there, with a trailing `null`. Returns `{"event_id"}`.
  - GET `/gradio_api/call/generate/<event_id>` streams until `event: complete` with `data: [{path, url, …}, …]`. `event: error` means failure.
  - `seconds_total` must be a **whole number**. Download the `url`, URL-encoding the part after `file=`.
  - Default steps 8 and CFG 1.0. Seed -1 (random) for each take.
  - About 1–3 s per take on the GPU. The SFX model must be the one loaded (the page title includes "Small SFX").
  - All calls via curl with argument lists (no shell), as with ComfyUI.
- **Starting Stable Audio** (from the same notes):
  - Command: `C:\pinokio\bin\npm\pterm.cmd run "C:\pinokio\api\stable-audio-3-small.pinokio.git" --default "start.js?model=small-sfx"`. Fixed arguments only; nothing from a prompt or file goes into it.
  - A `.cmd` file needs `shell: true` to spawn on Windows, so `host.spawn` gains a `shell` option used only for this command.
  - The app runs only while that command keeps running. The app keeps the process for as long as it is open and never kills it on a take; it stops it on Exit from the tray (Pinokio then stops Small SFX).
  - Ready check: `GET /` title says "Small SFX" and `/gradio_api/info` lists `/generate`. Poll every 2 s, up to 120 s (it usually takes 20–40 s).
  - Pinokio not open (the control port 42000 refuses, or pterm exits at once with an error): "Open Pinokio first, then press Start Stable Audio."
  - The Music model already on 7860: "Stable Audio Music is running. Stop it in Pinokio, then press Start Stable Audio." The app never stops a model it didn't start.
- **Files:**
  - SFX → `<film>\studio\media\<project>_sfx_<cue>_t<n>.wav`, converted to 48 kHz WAV with leading and trailing silence trimmed and 10 ms fades (ffmpeg). The original download is kept beside it as `.orig.<ext>`.
  - Score → `<film>\studio\media\<project>_score_t<n>.<ext>`, as delivered.
  - Each take is measured with ffmpeg (length, peak, integrated loudness): near-silent means a peak below -30 dBFS or mean below -50 dB.
- **Lanes:** Stable Audio is on the GPU lane (shared with ComfyUI and Blender, one at a time). ElevenLabs is on the connector lane.
- The same take rules as b-roll: new takes are added, never replaced; jobs reconnect after a restart (ElevenLabs by its session id; a Stable Audio take is quick and is marked interrupted).

## Approaches
There's one sensible way: the app drives both services directly, ElevenLabs through the connector and Stable Audio through its local HTTP API (like ComfyUI). The alternatives (Claude sessions; clicking in Pinokio) bring back exactly what the app replaces.

## Design
- **State:**
  - `state.audio = { flowId, score: {prompt, durationS, takes[], chosen, approved}, sfx: [{id:"SFX-01", cue, prompt, durationS, loop, source, takes[], chosen, approved}] }`;
  - take = `{n, source, prompt, file, status, jobId, note, lengthS, peakDb, meanDb, quiet, error}`.
- **Making the list:** a "Plan music and sound effects" button. One memoryless Claude call reads the script and `part1_handover.md`, and returns the score prompt and duration plus the SFX cues (id, what it is, prompt, seconds, loop yes/no). Jon can edit any prompt or length before generating.
- **Costs:** before any ElevenLabs generation the app runs `estimate_only` and shows "This will use about N credits" on the button. Stable Audio shows "Free".
- **Review board:** a "Score" section and a "Sound effects" section below Narration and above B-roll, with the same card look. Each take has ▶ (one player for the whole screen), a take picker, Approve/Undo and Redo…, and the source tag.
- **Redo with a note:** Claude rewrites the prompt from the note (tier "quick"); a new take goes beside the old ones.
- **Live jobs:** "Score take 2: ElevenLabs", "SFX-03 door creak take 1: Stable Audio", with a progress estimate.
- **Probe:** a "Stable Audio" check: GET `/gradio_api/info` lists `/generate`, and the page title says Small SFX. When it's off, the check offers **Start Stable Audio**.
- **Sound effects header:** a status chip (Off / Starting… / Ready / Music model loaded) with the **Start Stable Audio** button.
- **Errors:**
  - Stable Audio didn't come up in 120 s: "Stable Audio didn't start. Look at its Terminal in Pinokio, or switch this cue to ElevenLabs."
  - The Music model loaded instead of SFX: say so (above).

## Calls made after the builder check (Claude's; Jon may change them)
- **Pick and Approve work as on b-roll cards.** The take picker chooses a take; **Approve** confirms it. The Part 2 handover reads the approved, chosen take.
- **Plan once.** "Plan music and sound effects" runs only while the film has no score or cues, so it can never overwrite takes or picks. After that, Jon edits prompts and lengths on the cards. An **Add cue** button covers a cue the plan missed.
- **The estimate is shown per press.** Each ElevenLabs job is one take (`generations_count: 1`). The button shows the estimate for exactly what it will start: "Generate 2 takes · about N credits" for the score, and per take for an SFX cue. Pressing it is the confirmation. Redo with a note also shows its estimate first, and nothing paid starts without that press.
- **ElevenLabs files** are downloaded from `content_url` with curl into `studio\media` (as Higgsfield's are), straight after completion because the link expires.
- **Stable Audio parameters** come from Jon's `api_notes.md` (copied for the builders). The runner hard-codes the 29-value order from those notes and checks `/gradio_api/info` in Probe. The page title is read from `GET /`.
- **Score length** is editable. The app suggests the estimate and never warns.

## Left to the builder
Module split, the exact ffmpeg filters for trimming and measuring, the poll cadence (ElevenLabs no faster than the returned `poll_after_seconds`; Stable Audio's stream is one request), and copy wording in the house style.
