# Six Minutes Studio: sending heavy jobs to the desktop

Status: draft for Jon's approval. Date: 2026-11-28. Follows `2026-11-28-six-minutes-studio-computer-setup-design.md`
(piece one: per-computer settings and roles).

## Why
The laptop does the lighter work (Part 1, recording, audio, the mix). The graphics jobs (ComfyUI images and
Animate, Blender 3D, Stable Audio sounds) need the desktop's graphics card. Today the laptop's Make buttons for them
are greyed out ("Make this on the desktop"), so Jon has to walk to the desktop. He wants to press Make on the laptop,
have the desktop make it, and get the take on the laptop as if it had been made there. He also wants to see that the
two computers are connected.

## What Jon gets
1. **Make works on the laptop for graphics jobs.** The button reads **Make on the desktop**. The job shows in the
   laptop's job list as "Waiting for the desktop", then "On the desktop: running 40%", then done; the take appears
   in the film like any other, and the laptop's usual "finished" notice fires.
2. **The desktop starts laptop jobs straight away** (Jon picked A), one at a time in its graphics lane alongside its
   own jobs (a laptop job waits its turn while the desktop renders something of its own). A **Pause laptop jobs** switch on the desktop holds new ones (for a game or a render); jobs already
   running finish. The switch is remembered for that computer.
3. **A connection line at the top of Studio**, on both computers:
   - Laptop: **Desktop: ready** · **Desktop: busy (2 jobs)** · **Desktop: laptop jobs paused** ·
     **Desktop: not seen since 14:05** · **Can't reach the server (N:)**.
   - Desktop: **Laptop: seen just now** / **Laptop: last seen 14:05**, and how many laptop jobs are waiting or
     running. Shown only once another computer has been seen.
   - The laptop's Probe graphics rows say "On the desktop · ready" (or the same states) instead of plain
     "On the desktop".
4. **Nothing is lost when a computer closes.** Closing the laptop's Studio while the desktop works is fine: on
   reopening, the laptop picks the job up again and records the take. A job sent while the desktop's Studio is closed
   waits and starts when Studio opens there. A waiting job (not yet started) can be **Withdrawn** from the laptop.

## Goals
- A graphics take made for the laptop lands in the film exactly as one made on the desktop.
- Jon can always tell from the laptop whether the desktop will pick a job up now.
- The desktop on its own behaves exactly as today.

## Non-goals
- Waking the desktop from sleep, or starting Studio there remotely. Studio must be open on the desktop
  (Windows sleep settings are Jon's).
- Sending jobs from the desktop to the laptop, or between more than one desktop.
- Paid tools (Higgsfield, ElevenLabs): they already run from either computer and stay where they are.

## Anti-goals
- A job made twice, or a paid or finished job re-fired by itself. A failed or interrupted desktop job is never
  retried automatically; Retry on the laptop sends a fresh request.
- Either computer overwriting or deleting the other's files.

## Approaches
- **How the computers talk (picked by Jon earlier: A, a queue on the server).** Both already see the project folder,
  so requests and answers are small files there. B (a network connection between the two Studios) would need ports,
  firewall rules and the desktop's address; C (Jon carries work over) is today.
- **Where the laptop's job lives (my call).** On the laptop the graphics tools get a stand-in runner, "send to
  desktop": its start writes the request and waits for the answer, its resume (after a restart) waits on the same
  request. The laptop's job list, notices and film recording stay unchanged, because to them it is just a job that
  takes a while. The alternative, a second list of remote jobs, would duplicate all of that.
- **Starting straight away vs waiting for a press (Jon picked straight away, with a Pause switch).**

## Details (my calls unless marked)
- **Queue folder:** `<root>\.studio-queue\`. Each file has one writer, so two computers never write the same file:
  - `<id>.request.json`, written by the laptop: `{ id, from: <COMPUTERNAME>, root: <laptop's project folder>, at,
    job: { film, assetId, take, tool, what, why, input } }` (the same fields `retry` copies). `id` is
    `<COMPUTERNAME>-<laptop job id>`, so it is unique across computers.
  - `<id>.answer.json`, written by the desktop: `{ id, by: <COMPUTERNAME>, status: "running"|"done"|"failed"|"withdrawn",
    progress, eta, file, meta, error, ambiguous }`, rewritten as the job moves (write to `.tmp`, then rename, as the
    job list does).
  - `<id>.withdrawn.json`, written by the laptop when Jon withdraws a waiting job.
  - `<id>.check-<n>.json`, written by the laptop when Jon presses Check on a desktop failure marked ambiguous.
  - Tidying: each computer moves only the files it wrote. When the laptop has recorded a finished, failed or
    withdrawn job, it moves its request (and withdrawal) into `.studio-queue\finished\`; the desktop, seeing an answer
    whose request has gone there, moves its answer there too. Nothing is deleted.
- **The desktop's worker:** every 10 seconds (and at start), with Pause off **and its graphics lane free**, it takes
  the oldest `*.request.json` that has no answer, checks once more that it has no withdrawal, writes an answer with
  `status: "running"` (that claims it), and adds the job to its own job list with `from` and `request` (the id) set,
  using its normal runner. So a claimed job always starts at once: a job waiting behind the desktop's own render is
  simply unclaimed, and Withdraw and Pause only ever deal with unclaimed requests. Its own list persists and resumes
  the job as today; each change rewrites the answer. A job interrupted by closing Studio there is answered `failed`
  ("Interrupted on the desktop; press Retry") unless its runner resumes it (ComfyUI with its prompt id).
- **The desktop never records laptop jobs.** Jobs with `from` are left out of the film watcher (`applyJobs`) and the
  desktop's finished notices; the laptop is the only writer of its films' takes. They do show in the desktop's tray.
- **Start-up reconcile on the desktop:** any answer it wrote that still says `running` but has no job in its list
  (job file moved aside, reset) is answered `failed`: "Lost on the desktop; press Retry".
- **Withdraw:** offered on a laptop job with no answer yet. The laptop writes the withdrawal; the desktop, seeing a
  withdrawal with no answer, answers `withdrawn` and the laptop fails the job as "Withdrawn". If the desktop isn't
  seen (presence stale), the laptop fails the job as "Withdrawn" at once; the desktop never claims a request that
  has a withdrawal. If the desktop had claimed it a moment before, its answer wins and the job carries on.
- **Check:** on a laptop job whose desktop answer is `failed` with `ambiguous` (ComfyUI may still be rendering), Check
  writes a check file; the desktop runs its own Check on that job (spends nothing) and the answer moves on. Retry
  always sends a new request.
- **Only a computer whose role is Desktop takes jobs.** A laptop never runs the worker.
- **Paths:** the request carries the laptop's paths (`N:\Youtube video ideas\...`) and its root. On taking a request the
  desktop re-bases every string in `job` (film, every path in `input`) onto its own project folder, using its known
  spellings plus the request's `root`, because runners build arguments like `"image=@" + path` that the host wrapper
  can't see inside. The laptop does the same to every string in an answer's `file` and `meta`.
- **Which tools go to the desktop:** on a laptop, `comfyui`, `blender` and `stableaudio` use the stand-in runner
  (with `lane: "gpu"`, `start` and `resume`), except a tool Jon set up there with "Set up here anyway", which runs
  locally as on the desktop. Make on the desktop is always enabled; if no desktop has ever been seen, the line says
  "Desktop: not seen yet" and the job waits.
- **The laptop's runner:** start writes the request, sets the job's reference to the request id, then checks the
  answer every 5 seconds: no answer → progress text "Waiting for the desktop" (plus the presence state); running →
  mirrors progress and eta; done → returns `{ file, meta }`; failed → fails with the desktop's message. It never gives
  up by itself. Withdraw (only before an answer exists) writes the withdrawal and fails the job as "Withdrawn".
- **Tidying the laptop's side:** a request is final when its answer is `done`, `withdrawn` or a `failed` without
  `ambiguous`; only then does the laptop move it to `finished\`. At start the laptop also moves any request of its own
  whose job is no longer in its list. The worker skips any request that has an answer, whatever its state.
- **Presence:** each Studio writes `<root>\.studio-presence\<COMPUTERNAME>.json` every 30 seconds: `{ computer, role,
  at, paused, running, waiting, tools: { comfyui, stableaudio } }` (tool states from the existing starters). A reader
  counts a computer as "seen" when the file's contents changed within the last 90 seconds **by the reader's own
  clock**, so the two computers' clocks needn't agree. The laptop's line follows the computer with role Desktop seen
  most recently. A computer named `THIS-PC` (name unknown) writes no presence and runs no worker; Probe already warns. "Not seen since" shows the last change the reader saw, or the
  file's `at` when Studio has just opened.
- **Server unreachable:** if the presence write or the queue check fails, the line says "Can't reach the server
  (<root>)" and the laptop's waiting jobs keep waiting.
- **Pause switch:** per-computer setting `laptopJobs: "on" | "paused"` in `computers.<NAME>` (default on), shown on the
  desktop next to the connection line and in Probe.
- **Labels:** Make on the desktop (laptop button), Pause laptop jobs / Resume laptop jobs (desktop), "from LAPTOP"
  beside laptop jobs in the desktop's job tray.

## Constraints
- Studio stays the existing artifact; capabilities unchanged. No credits spent: ComfyUI and Stable Audio are local;
  Blender asks Claude for its script and check from the desktop's Studio, as it does today when Jon makes it there.
- Never overwrite or delete: queue files are moved to `finished\`, never removed.
- No secrets in files.

## Calls I made (Jon to check)
- The laptop's job waits for the desktop for as long as it takes; it never times out by itself. Withdraw is the way
  out while it waits.
- A desktop job cut off by closing Studio there fails with Retry, except ComfyUI renders, which reconnect.
- Presence every 30 seconds; "seen" means seen within 90 seconds.
- The Pause switch holds new laptop jobs only; running ones finish.
- The desktop takes a laptop job only when it can start it, so a laptop job queued behind the desktop's own render
  still shows "Waiting for the desktop (busy)" and can still be withdrawn.
- Blender jobs from the laptop use the desktop's Claude (its picture permission); a Blender failure there shows on
  the laptop with "On the desktop:" before the message.
- The laptop is the only computer that records a laptop job's take in the film.

## Left to the builder
- Layout of the connection line and the Pause switch, within Studio's look.
- The wording of progress text, within the labels above.
