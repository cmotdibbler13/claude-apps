# Six Minutes Studio: design

A desktop app, installed from a Claude artifact on Jon's Windows PC, that runs the
whole "Six minutes on…" film pipeline in one window: brief to script, narration,
music, sound effects, b-roll and line art, review, build, render and Shorts.

Mockup (sample content): https://claude.ai/artifact/2zwT4cvvbxC7Kndbtzzaaw

## 1. Why

Making a film today means three separate Claude Code sessions per film (plus a
Shorts session), each driven by a skill (`documentary-explainer-script`,
`voicestudio-narration`, `documentary-explainer-video`, `six-minutes-shorts`).
Jon's pain points, in his words:

1. **Waiting with "no idea what's going on under the hood."** Generations and
   renders run for minutes with no visible progress.
2. **No proper UI to see how the parts are going**: the b-roll, the music, the
   audio. Assets are reviewed as files and chat attachments.
3. **Narration could be handled better.**
4. **The three-part rule stays, but it "makes for a lot of sessions to keep track
   of."** Sessions sit waiting for him without his knowing.

He also wants to **act**, not just look: redo any clip or take with a note.

## 2. Goals, non-goals, anti-goals

**Goals**
- One window that shows every film, which part it is in, and what is waiting on Jon.
- Live, plain-English status of every running job, with progress where the tool
  reports it.
- A proper review board for Part 2 assets: watch, listen, pick takes, approve,
  and **redo with a note**.
- Parts 1 and 2 run inside the app; Part 3 runs as a fresh Claude Code session the
  app starts and shows.
- Use Jon's local tools (ComfyUI, Blender, VoiceStudio, Stable Audio in Pinokio,
  Remotion, Autocue Studio) as well as his connectors (Higgsfield, ElevenLabs).

**Non-goals (v1)**
- Replacing Claude Code for the Part 3 build (writing Remotion scenes, maps, line-art
  compositions, fixing final notes). That stays a real session.
- Replacing Autocue Studio. The app opens it and watches its Recordings folder.
- Running the YouTube uploader or publishing anything. The uploader stays a
  program Jon runs himself (existing rule).
- Website updates (`sixminuteson-new-upload` stays as it is).
- Use by anyone other than Jon, or on any machine other than his PC.

**Anti-goals (a failure even if it technically works)**
- Losing or weakening a **review stop**: nothing moves to the next part without
  Jon's explicit approval.
- One long Claude conversation that accumulates context across parts. **Fresh
  context per task is required.**
- Files that exist only inside the app. Everything a later part or session needs
  lives in the film's folder on `S:`, as today.
- Silent spending: re-running paid generations without Jon asking.
- Deleting or overwriting Jon's files without showing him first. Never touch
  VoiceStudio's model cache in `S:\Youtube video ideas\voice files\` except the
  app's own `<audio_id>.wav` takes.

## 3. Constraints

- **Platform:** a Claude artifact with the `desktop` capability, installed via
  "Install as app" in the Claude desktop app on Windows. Permissions:
  `full-access` (files, processes, terminal), `notifications`, `menu-bar` (tray
  icon on Windows). Full access is allowed because the artifact is Jon's own and
  no one else writes to it. Each new published version asks for permissions again.
- **Processes end when the app window closes or reloads.** Long renders need the
  window kept open, and the UI should say so while a job runs. Closing must not
  lose state: on reopen, the app re-reads job state from disk and reconnects
  where it can (see 6.4).
- The page cannot `fetch` other hosts. Local HTTP tools (ComfyUI's API on
  localhost, Pinokio apps) are reached through child processes, for example a
  small Python helper the app runs, not browser fetch.
- **Connectors** (Higgsfield, ElevenLabs) are called with the `mcp` capability,
  with Jon's credentials, declaring only the tools used. Paid generations follow
  his existing cost rules: 2 takes for music and SFX, never re-fire a generation to
  "retry", poll status rarely.
- **Claude calls inside the app** use the `sample` capability. Each call is
  memoryless, so it gets instructions plus only the data that task needs: the
  handover, the script line, the note. That is how "fresh context" is met in-app.
- **Storage:** projects live on Jon's home server, `S:\Youtube video ideas\` (UNC
  fallback `\\192.168.1.171\jon\Youtube video ideas\`). Never the old
  `C:\Users\Jon\Youtube video ideas\` copy. Own-voice takes are at
  `C:\Users\Jon\desktop autocue\Recordings\<project>\`.
- **The handover format is the contract** between parts and must stay compatible
  with the existing skills, because Part 3 and Shorts sessions read them. The
  contents of `partN_handover.md` are defined in `documentary-explainer-script`
  ("The handover file").
- **One GPU** (RTX 4060 Ti). ComfyUI, Blender, VoiceStudio and Stable Audio compete
  for it, so local GPU jobs run one at a time from a queue. Connector jobs run in
  parallel.
- **Look:** the Six Minutes On… design system
  (https://claude.ai/artifact/FEf9kh1wyvzYpQnM1zxioL), Night theme: navy surfaces,
  off-white ink, brass accent, tide for live/focus, Inter, square corners.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Dashboard that watches sessions; all work stays in Claude Code sessions | Smallest build, but redo still goes through a session, so it fixes visibility, not the waiting |
| **B (chosen)** | **App does Parts 1 and 2; starts a fresh Claude Code session for Part 3 and shows it** | Fixes all four pain points and keeps review stops and fresh context. Medium-to-large build; the app takes over the generation and QA steps the skills describe today |
| C | Everything in the app, including the Remotion build, via an in-app agent | Most fragile; rebuilds what the video skill and a real session already do well |

Jon chose **B**. His three-part rule protects **review stops** and **fresh
context**. B keeps both: each part ends at an approval screen that writes the
handover, every in-app Claude call is memoryless, and Part 3 is a new session.

## 5. What Jon decided

- Approach B.
- **Act on assets:** every b-roll clip, line-art shot, music take and sound effect
  can be **redone with a note** from the review board.
- Keep the three-part rule, with an explicit approval at the end of each part.
- **Blender line art:** Claude builds the scenes as Python scripts, and Blender
  renders them headless. Redo notes go to Claude, which edits the script and
  re-renders.
- ComfyUI is one of his tools, to be used in the pipeline.

## 6. The design

### 6.1 Screens (see mockup)

1. **Films.** One row per film: series dot, number, title; a four-step tracker
   (1 Script, 2 Assets, 3 Build, Shorts) showing done / current / not started; one
   line on what is happening or what is **waiting on Jon** (in brass), with a
   button to go there. "New film" starts Part 1 from a brief.
2. **Live jobs.** Every running or queued job: a plain-English description ("B-roll
   BR-07: midden cross-section, slow push-in"), the tool tag, film, progress bar
   where available, time left or "queued", and why it exists ("take 3, from your
   note 'darker, no people'"). Beside it, an **activity log** of what the app and
   Claude did, newest first. A job count shows on the nav at all times.
3. **Review**, per part:
   - **Part 1:** the script in the reference format, the name test (cloned voice)
     or the line script and pronunciation notes (own voice), the SFX list and the
     episode number. Edit, ask Claude to revise with a note, approve.
   - **Part 2, the combined review:** a sticky summary (approved n/total,
     regenerating count, **Approve Part 2** locked until everything is approved).
     Then sections:
     - *Narration:* the joined voiceover as a waveform, flagged spots from QA
       marked on it with clip and time, playable per clip; a retake or regenerate
       action per sentence.
     - *Score and SFX:* each cue with its takes, play, pick, approve, redo with a
       note.
     - *B-roll and line art:* by default **in script order, each shot beside the
       narration line it covers**, with a toggle to a plain grid. Each card shows
       the tool (Higgsfield / ComfyUI / Blender), take n of m with a take picker,
       its history of notes, and Approve / Redo….
4. **Build:** the Part 3 session in an embedded terminal, beside a checklist of
   Part 3 steps from the handover format (preview, full render, thumbnail and
   website still, upload pack, uploader entry, `part3_handover.md` with Shorts
   plan). The render also appears in Live jobs.

Tray icon and notifications: notify when a review becomes ready, a job fails, a
render finishes, or a session is waiting for Jon.

### 6.2 Parts and review stops

- **Part 1 (in app).** Input: a brief (MD or PDF) in the project folder. Ask own
  voice or cloned voice, and settle the file prefix, as the script skill does.
  Claude writes the script in the reference format (read a reference script
  first). For cloned voice, run the name test in VoiceStudio. Jon reviews and
  approves → the app writes `handover\part1_handover.md`.
- **Between 1 and 2 (own voice):** the app shows the line script and opens Autocue
  Studio; it watches `Recordings\<project>\` and shows a per-line checklist of
  takes as they arrive.
- **Part 2 (in app).** Produce in one pass: the full voiceover (cloned:
  VoiceStudio; own: process Jon's takes) with the skill's QA and joining; the score
  (2 takes, ElevenLabs); SFX from the approved list (Stable Audio first, ElevenLabs
  fallback, 2 takes each); b-roll (Higgsfield, ComfyUI) and line art (Blender,
  ComfyUI). Then the combined review. On approval: commit the Part 2 hand-off files
  to the project folder, add approved clips to the B-roll library (catalogue JSON and
  MD, next BR- ID, thumbnail; rejected takes get a "rejected" row only), write
  `part2_handover.md`.
- **Part 3 (fresh session).** "Start Part 3" opens a terminal in the project folder
  and runs Claude Code with the opening message from the Part 2 handover
  ("Part 3 of Six minutes on… <Topic>. Load /documentary-explainer-video, read
  …\handover\part2_handover.md, and carry on."). Jon talks to it in the terminal. The
  app shows the checklist and the render progress it can read (the render's output),
  and marks Part 3 done when `part3_handover.md` appears.
- **Shorts (fresh session).** Same pattern with `six-minutes-shorts`, after Part 3.

### 6.3 Redo with a note

1. Jon types a note on a card.
2. A memoryless Claude call gets the shot's description, the current prompt or
   Blender script, the narration line it covers, the brief's relevant facts and the
   note; it returns the new prompt or script.
3. The app starts the job with the right tool and shows it in Live jobs. The card
   shows "Regenerating".
4. The new take is added next to the old ones (never replacing them) and selected;
   the note goes into the card's history.
5. Every take keeps its prompt or script, tool settings and job ID, so the chosen
   one goes into the handover and the B-roll library and can be fetched or re-run.

### 6.4 Where state lives

- **Per film:** the existing project folder and handover files are the source of
  truth. The app adds one folder, `<project>\studio\`, holding:
  - `state.json`: the film's current part, the asset list (id, kind, script line,
    tool, takes with prompt/script, settings, job ID, file path, status, chosen
    take, approved), notes history, and review decisions;
  - `jobs.json`: open and recent jobs, so a reopened app can reconnect (connector
    jobs by job ID) or mark local ones as interrupted with a "run again" button;
  - `log.jsonl`: the activity log.
  - `blender\`: the scene scripts, one per shot and take.
- **Films list:** found by scanning `S:\Youtube video ideas\` for project folders
  that have a `handover\` or `studio\` folder; read their status from those files.
- Nothing essential lives in browser storage. Per-window conveniences (last view,
  grid/script toggle) may.

### 6.5 Tools and how they are reached

| Tool | Used for | How |
|---|---|---|
| Claude (in app) | script, prompt rewrites, QA judgement, upload copy | `sample`, memoryless calls (model tier per task, 6.6) |
| Higgsfield | b-roll video, stills | connector via `mcp`; keep job IDs |
| ElevenLabs | score, SFX fallback | connector via `mcp`, using one flow per film |
| ComfyUI | stills, line art, image-to-video | its local HTTP API through a helper process; workflows stored as JSON files |
| Blender | line-art scenes | `blender -b -P <script>` child process; Claude writes the script; progress from Blender's frame output |
| Stable Audio 3 (Pinokio) | SFX first choice | its local interface through a helper process |
| VoiceStudio | cloned-voice narration and name test | local; file output mode to `voice files\` as the skill describes |
| Autocue Studio | own-voice recording | opened as a program; Recordings folder watched |
| Python, ffmpeg, faster-whisper | QA, joining, levels, proxies | child processes on the PC |
| Remotion | Part 3 render | run by the Part 3 session |
| Claude Code | Part 3 and Shorts sessions | started in the app's terminal (`pty`) |

**Previews:** large video is shown from a small proxy the app makes with ffmpeg
(for example 640px H.264). Full-size files open in the default player.

### 6.6 Claude model per task (Jon may change these)

- Most capable tier: writing the script; Part 3 sessions (where it most pays off).
- Default tier: QA judgement, handover writing, upload copy.
- Quick tier: turning a note into a new prompt, shot descriptions, short checks.

## 7. Left to the builder

- Code structure, framework (or none) and file layout inside the artifact.
- The helper-process design for local HTTP tools (one Python helper vs per-tool
  scripts) and how progress is parsed from each tool.
- The exact shape of `state.json` / `jobs.json`, as long as 6.4's contents are there.
- The GPU queue policy details, and how many connector jobs run at once.
- Error, retry and empty states.
- How the films list is sorted, and the exact copy.
- Build order. A sensible first slice is Films + Live jobs + Part 2 review for one
  film with Higgsfield and Blender, then widen.

## 8. Things to verify early

- `mcp` connector calls from the installed app for Higgsfield and ElevenLabs: the
  tools' argument and result shapes (read their schemas, one safe real call).
- How VoiceStudio is reachable from the app: as a local MCP server (`host:` server
  in the `mcp` capability, only if the Claude desktop app has it configured) or via
  its own local interface.
- Stable Audio 3 in Pinokio: how to call it locally.
- Claude Code's CLI is installed on the PC and starts in the app's terminal with the
  skills loaded.
- The installed app can read and write `S:` (a mapped network drive) or needs the
  UNC path.
