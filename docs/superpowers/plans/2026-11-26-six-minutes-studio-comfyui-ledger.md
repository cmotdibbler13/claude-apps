# SDD ledger — plan: /home/user/claude-apps/docs/superpowers/plans/2026-11-26-six-minutes-studio-comfyui.md
- Task 1: fix round 1/5 (1 addressed — lane cap for check/restore via queued+resumeNext; commits 6fc57f0..806815e)
- Task 1: minor (deferred): comfy scalar settings not type-validated (url null)
Task 1: complete (commits 41bdb19..806815e, review clean)
- Ruling C1: plan-mandated defect — "a curl failure means not running" hid ComfyUI's HTTP 400 validation errors. Spec wins (useful errors): drop --fail on POST, read the HTTP code, surface ComfyUI's error body; only connection failures say "isn't running". Folded into the same fix: POST timeout → ambiguous "may have been queued"; reject .. / absolute output paths from history; crop uses min(iw,1920):min(ih,1080); discard .part if rename fails — all in the same lines — cost if wrong: small.
- Task 2: minor (deferred): 60-min cap and ETA restart on resume; cap checked before final poll; test hygiene leftovers
- Task 2: fix round 1/5 (6 addressed; commits b640e0b..df1260c)
Task 2: complete (commits 806815e..df1260c, review clean)
- Task 3: minor (deferred): setTool vs startTake preparation race (unreachable from UI if setTool goes through cardAction's per-shot pending guard — CARRY to T4); "(1 shots switched)" plural; buildShotList reads prefs outside the updater
Task 3: complete (commits df1260c..c6a8973, review clean)
- Task 4: minor (deferred): probe URL starting with '-' could be read as a curl option (also comfy url used by the runner); probe skips workflow check when curl fails; checkbox revert untested; DOM not browser-run
Task 4: complete (commits c6a8973..418ddf6, review clean)
- Final review: With fixes — Important: unknown prompt waits 60 min holding the GPU lane; minors: 'Comfyui' label, silent bad node map, card shows asset tool not job tool, temp file trashed each submit, stale Higgsfield-only wording. Ruling C2: fix all six in one wave.
