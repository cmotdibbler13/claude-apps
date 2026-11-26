# SDD ledger — plan: /home/user/claude-apps/docs/superpowers/plans/2026-11-27-autocue-live-checks.md
- Ruling A1 (spec change): the 18 dB one-frame drop rule applies only when the end of speech is within 0.3 s of the file's end (named constant); natural sharp stops followed by room tone are not flagged. Own-voice cut-off is mainly "stopped too soon" — cost if wrong: a few real truncations with long room tone missed (the transcript last-word rule still catches them).
- Ruling A2: M1 (wrap CPU retry; don't re-attempt a failed model load every take — cache failure for the session, retry on Check all) and M3 (ffmpeg timeout 60 s) folded into this fix round — they protect the worker thread.
- Task 1: minor (deferred): ZCR/noise measured at 16 kHz; number forms 40th / 1990s / 3.5 / £5; check_take may raise non-CheckError (Task 2 worker must catch broadly — CARRY)
- Task 1: fix round 1/5 (I1–I4, A2 addressed; ratio rule min length open; commits cdc5dcd..05d9a5b)
- Task 1: fix round 2/5 (1 addressed — ratio rule only for words ≥5 letters; commit bfbe4c4). Ruling A3: the 4-line diff was verified by the controller directly (exactly the requested change + its failing-then-passing test) instead of a separate re-review — cost if wrong: low.
Task 1: complete (commits d945db2..bfbe4c4, review clean)
- Ruling A4: Task 2 fix round also takes Minor 1 (results via a thread-safe queue drained by an after() loop on the Tk thread, like _poll_backup), Minor 2 (append check text to a "Saved…" status instead of replacing it), Minor 3 (skip takes already queued), Minor 4 ("All takes checked" instead of "Checking 0 takes…") — cheap while app.py is open, and 1–2 protect recording. Important 2: auto mode probes CUDA once in a subprocess and falls back to CPU if it crashes, plus a README line.
- Task 2: minor (deferred): "downloading" notice on every launch; passed-with-notes mark all brass; tiny stat→replace race
- Task 2: fix round 1/5 (6 addressed; commit 2a96f9e)
- Task 2: minor (deferred): "Checking N takes…" counts already-queued takes
Task 2: complete (commits bfbe4c4..2a96f9e, review clean)
- Task 3: fix round 1/5 (null text node + poll overlap guard addressed; commit 4b436b1). Diff verified by the controller directly (two-line change + guard test) — Ruling A5, cost if wrong: low.
- Task 3: minor (deferred): 86 parallel fs calls per 10 s tick; transient stat failure flickers "Missing"; parity: newer result than take not treated as checking; ok=false with no flag kinds; cached line script until film reopened; interval never cleared
Task 3: complete (commits 2a96f9e..4b436b1, review clean)
- Final review: With fixes — Important: quiet final word falsely cut off; autocueDir fallback picks another film's script. Ruling A6: one wave for I1–2, minors 3–8, deferred D1–D4.
