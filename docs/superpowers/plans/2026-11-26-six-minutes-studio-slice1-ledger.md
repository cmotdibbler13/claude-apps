# SDD ledger — plan: /home/user/claude-apps/docs/superpowers/plans/2026-11-26-six-minutes-studio-slice1.md
Spec: docs/superpowers/specs/2026-11-26-six-minutes-studio-design.md

## Pre-flight scan
| Rows | Produces / consumes | Finding |
|---|---|---|
| T1→all | Host, FakeHost | consistent |
| T2↔T3 | films reads studio/state.json `waiting`; T3 State has `waiting` | consistent |
| T3↔T5 | Asset.draftPrompt defined in T3, written in T5 | consistent (fixed in plan) |
| T4↔T6/T7 | Runner contract {lane,start,resume} | consistent |
| T5↔T7 | askJson used by writeBlenderScript | consistent |
| T7↔T8 | writeBlenderScript signature | consistent |
| T4↔T12 | .studio-jobs.json at root vs "nothing outside studio" | consistent: T12 lists the two root files as allowed |
| T10 | creates tests/viewmodel.test.mjs not in Files list | minor, allowed |
| T1 self | Steps 6-7 publish + PC manual check | not doable by subagent → ruling R1 |
| T6 self | Higgsfield arg names "from Task 1 Step 7" | resolved now from schema → ruling R2 |
| T7 S5, T12 S3 | manual PC checks | ruling R1 |

## Rulings
- Ruling R1: Implementers do code+tests+commit only. Controller publishes the artifact (T1 S6, T12 S2). Manual PC checks (T1 S7, T7 S5, T12 S3) are collected into one acceptance checklist for Jon at the end — subagents can't reach his PC — cost if wrong: issues found later on PC.
- Ruling R2: Higgsfield shapes from the connector schema (read 2026-11-26): generate_video/generate_image take {params:{model, prompt, aspect_ratio, duration?, count:1, use_unlim:false}}; jobs_wait takes {jobs:[{index,job_id}], timeout_seconds<=15} and returns statuses, result URLs, all_terminal, poll_after_seconds. Return shape of generate_* not observed (a real call costs credits): parse job id defensively (job_id | id | jobs[0].job_id | first UUID). use_unlim:false always (credits, as Jon works today) — cost if wrong: misses free allowance. Defaults in .studio-settings.json: videoModel "kling3_0" (pro mode, sound off, 16:9, per video skill), imageModel "gpt_image_2" (GPT Image 2, quality high, 2k) — both editable; probe also checks models_explore lists them. Add models_explore to declared mcp tools.
- Ruling R3: Line-art prompts use the video skill's formula ("Elegant scientific line illustration of <subject>, fine single-weight <amber #e3a64a | white> ink lines on a pure black background, no fill, no shading, no text, no frame, isolated, generous margin.").

## Tasks
- Note: run tests with `npm test` in six-minutes-studio (node --test tests/ fails on Node 22.23)
- Task 1: minor (deferred): spawn 'error' never fires exit handlers → job could hang; kill() promise may reject unhandled (js/host.js:245-256) — CARRY to Task 7 dispatch
- Task 1: minor (deferred): FakeHost stat size counts chars not bytes; read on dir gives ENOENT not EISDIR; write ignores enc
- Task 1: minor (deferred): installed-but-no-full-access shows misleading "works only in desktop app" (js/app.js:189-191)
- Task 1: minor (deferred): notification body 300-char cap and tray icon/title requirement not enforced (js/host.js:271-276) — CARRY to Task 11
- Task 1: minor (deferred): probe runChecks untested
- Task 1: minor (deferred): aria-selected without role=tab; unused .bar i selector
- Task 1: minor (deferred): makeHost doesn't catch use("mcp")/use("sample") rejection (js/host.js:212-213)
- Task 1: fix round 1/5 (1 addressed, 0 open — FakeHost ENOENT parents; commits c5bd3b0..96a3de6)
- Task 1: minor (deferred): fake rename slices raw path by length; POSIX paths permissive; ENOTDIR vs ENOENT
Task 1: complete (commits 441fdd4..96a3de6, review clean)
- Ruling R4: publish the artifact once, at Task 12 (controller reads all files then), not after Task 1 — avoids re-granting permissions per version and reading every file twice — cost if wrong: Jon's probe run happens later.
- Ruling R5: Film.number becomes string|null keeping the digits as written ("014") — brand rule says three-digit film numbers; plan's number|null type amended — cost if wrong: trivial.
- Task 2: minor (deferred): exists() can't tell a file named handover/studio from a folder; missing part1 with part2 present untested; join("S:\\") → "S:"; sequential awaits on UNC
- Task 2: fix round 1/5 (2 addressed, 0 open; commits 0819796..3be6604)
- Task 2: minor (deferred): stray bare block in scanOne (films.js:39); silent catch hides bugs
Task 2: complete (commits 96a3de6..3be6604, review clean)
- Task 3: minor (deferred): update(fn) doesn't await fn — CARRY: tell later tasks fn must be synchronous (do async work before update); failed write untested; loaded state not merged over defaults; store.state mutable
Task 3: complete (commits 3be6604..c7bce69, review clean)
- Task 4: minor (deferred): late ctx.progress/setRef mutate terminal jobs; restore not guarded vs populated queue; resumes bypass cap; failed resume → "failed"+Run again (CARRY to T6: runner resume should only reject on a definite remote failure); retry double-click → two paid jobs (CARRY to T10: disable Run again after click); resume resets startedAt; missing tests for sync-throw runner / failing resume; never-settling runner holds slot (CARRY to T6/T7: runners must always settle)
- Task 4: fix round 1/5 (1 addressed, 0 open; commits eac3305..49fcb2c)
- Task 4: CARRY to T10: UI must show persistError warning; disable Run again on click
Task 4: complete (commits c7bce69..49fcb2c, review clean)
- Ruling R6: shot ids are "HF-01", "HF-02"… in script order (not BR-01): the video skill's per-film shot list is HF-nn and BR-nnn is the B-roll library's catalogue id — avoids a clash — cost if wrong: rename strings.
- Task 5: minor (deferred): same-line tie-break by Claude label string (S10<S2); log failure after update rejects; no end-to-end refusal test on disk; no source-after-blender remap test; lineart prompt not checked vs R3
Task 5: complete (commits 49fcb2c..1d6a573, review clean)
- Ruling R7: add js/settings.js in Task 6: loadSettings(host, root) reads <root>\.studio-settings.json merged over defaults {videoModel:"kling3_0", imageModel:"gpt_image_2", blenderPath:"blender"}; Task 7 reuses it — plan put blenderPath there already — cost if wrong: small.
- Ruling R8: jobs carry an `input` object (runner inputs: kind, prompt or script, sourceFile, out) set by Task 8; Task 6 also makes jobs.retry copy `input` (retry currently drops it) with a test — cross-task edit, smallest fix.
- Ruling R9: Task 6 shell hardening (reject unsafe chars in URL and out path before curl via cmd.exe) promoted from Minor to the fix loop — it is a security-sensitive command built from remote data — cost if wrong: a few lines.
- Task 6: minor (deferred): first-https-URL scrape may grab a thumbnail (prefer known keys); unknown terminal status polls to 30-min cap (honour all_terminal); resume's 30-min clock restarts per resume
- Task 6: fix round 1/5 (2 addressed, 0 open; commits 8895d8c..519008b)
- Task 6: minor (deferred): no whitespace-URL test; .test(undefined) passes for missing out
Task 6: complete (commits 1d6a573..519008b, review clean)
- Ruling R10 (Task 7): Claude returns {script, frames} only — the output path is decided by code, never by Claude. Default render: MP4 H.264, 1920×1080, 24 fps (the b-roll frame rate in the video skill), out = studio\media\<id>_t<n>.mp4; to be matched to Jon's Norfolk Broads output at the PC check. Task 7 also fixes the carried Task 1 minor: host.spawn 'error' must fire exit handlers (code null) so runners always settle.
- Known risk to tell Jon: Blender runs Python that Claude writes, with full access on his PC (by design). Instructions constrain it (read argv inputs, write only the output path, no network, no deleting); the app keeps every script beside its render.
- Ruling R11: writeBlenderScript keeps returning the path (plan signature); frames come via its options.onFrames(frames) callback; store exposes store.dir. Task 8 must set job.input.frames from onFrames.
- Task 7: minor (deferred): shared partial buffer across stdout/stderr; errText only last chunk; prompt-only safety rules for Claude's Blender scripts (consider script review before first run, later); onFrames side channel
- Task 7: fix round 1/5 (1 addressed, 0 open; commits bb6aae0..553c938)
- Task 7: minor (deferred): stale-name collision same ms; no rename-fails test; stale files accumulate; --python-exit-code needs Blender ≥2.9 (add to PC check)
Task 7: complete (commits 519008b..553c938, review clean)
- Ruling R12: Task 8 stuck-queued take (jobs.add throws after the store update) promoted into the fix loop — it blocks new takes for that shot permanently — fix: try/catch around jobs.add marks the take failed with the error.
- Task 8: minor (deferred): watchJobs swallows state-write errors; note untrimmed/uncapped; test gaps (blender redo tier, failed blender script write, double-start guard); timing-sensitive 10ms waits; sourceFile may be undefined
- Task 8: fix round 1/5 (2 addressed, 0 open; commits 6acfe6d..20a1959)
- Task 8: minor (deferred): catch block store errors can mask the jobs.add error; initial sync not awaited
Task 8: complete (commits 553c938..20a1959, review clean)
- Task 9: minor (deferred): host.open ignores openPath's error string; toBlobUrl no size guard (CARRY to T10: videos only via ensureProxy); cache key mtime only + concurrent toBlobUrl leak; .mov/.mp4 proxy name collision; mtime ?? 0; CR/LF not in unsafe set; no in-flight-cleared test
- Task 9: fix round 1/5 (1 addressed, 0 open; commits 078028f..322db4e). Rename-over-existing is fine on the real host (desktop.d.ts: rename replaces an existing file).
Task 9: complete (commits 20a1959..322db4e, review clean)
- Ruling R13 (Task 10): the script file for "Make shot list" = first path ending .md containing "script" (case-insensitive) found in part1_handover.md (relative to the project folder or absolute), else the first *_script.md in the project folder; none → show "Couldn't find the script. Add its path to part1_handover.md."
- Ruling R14: Task 10 Minor 1 (bad/unreadable .studio-jobs.json overwritten with [] → loses jobRefs of paid jobs) promoted into the fix loop: on a read/parse failure other than "doesn't exist", rename it to .studio-jobs.bad-<t>.json before restoring [].
- Task 10: minor (deferred): failed preview promise cached until film closes (delete on reject); boot/open failures after root only in console (no Try again / no message); R13 prefix check unnormalised (.. segments); R13 tries all candidates; log re-read each render; Run again vs card Redo tiny race
- Task 10: fix round 1/5 (2 addressed, 0 open; commits d440ade..f40ab8d)
- Task 10: minor (deferred): readSavedJobs no explicit ENOENT; session.close unused; watch() throw edge
Task 10: complete (commits 322db4e..f40ab8d, review clean)
- Task 11: minor (deferred): "All shots … ready" fires even when the last job failed (fix wording/condition — triage in final review); notification permission prompt may appear at job completion; tooltip repeats name; app.js wiring untested
Task 11: complete (commits f40ab8d..6cc6537, review clean)
## Final review
- Final review (441fdd4..6cc6537): With fixes — 1 Critical (second store on reopen loses takes), 6 Important (write flood on S:, Run again double-spend, stuck busy takes, shell-char paths after spend, fs calls before permission check, `waiting` never set), minors triaged.
- Ruling R15: "No model identifiers in the repo" means Claude model ids (none present); Higgsfield model ids kling3_0 / gpt_image_2 stay as editable defaults in js/settings.js — cost if wrong: move them into .studio-settings.json seeding.
- Ruling R16: one fix wave covers C1, I1–I6 and six fix-before-use minors (findings in final-fix-findings.md); all other minors stay deferred.
- Final fix wave: re-review — all 13 findings ADDRESSED (commits 6cc6537..55c8f61). One new Important: repeated "Check again" clicks poll jobs_wait without the 20 s floor, and check bypasses the connector cap of 3.
- Ruling R17: parked the "Check again" 20 s floor finding — real, but a check spends no credits (jobs_wait only) and needs repeated manual clicks; no second fix wave is allowed — surface to Jon as a next fix — cost if wrong: a few extra status calls to Higgsfield.
- Final review: minor (deferred): check not refusing superseded jobs (UI guards); ffmpeg/curl .cmd shims now refused (Probe shows it); curl partial file at take name on failure; save banner persists across films; restore polls at once and ignores the cap; absolute paths when the root changes S:↔UNC.
