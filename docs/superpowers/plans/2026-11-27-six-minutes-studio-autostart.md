# Autostart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio starts ComfyUI Desktop and Stable Audio (Small SFX) when it opens, shows their state, and closes only what it started.

**Architecture:** `js/tools/comfystart.js` mirrors the Stable Audio starter (state, ensure, refresh, stop, onChange); `js/autostart.js` runs both starters at launch per settings and gives a status line; app.js wires launch, Films line, tray tooltip, pagehide and Probe's Start now.

**Tech Stack:** ES modules, `node --test` with tests/fake-host.mjs.

**Spec:** `docs/superpowers/specs/2026-11-27-six-minutes-studio-autostart-design.md`

## Global Constraints
- Settings: `autostart: { comfy: true, stableAudio: true }` defaults; `comfy.exe` optional.
- Exe candidates in order: `comfy.exe`, `C:\Users\Jon\AppData\Local\Programs\@comfyorgcomfyui-electron\ComfyUI.exe`, `C:\Users\Jon\AppData\Local\Programs\ComfyUI\ComfyUI.exe`.
- Ready = `curl -sS --fail <url>/system_stats` exits 0. Poll every 3 s, give up after 4 min.
- Copy: "ComfyUI Desktop wasn't found. Set comfy.exe in .studio-settings.json."; "ComfyUI didn't start. Open it yourself and look at its window."; status line "ComfyUI: <label> · Stable Audio: <label>" with labels Off / Starting… / Ready / Not found / Didn't start / Music model loaded.
- Never kill a ComfyUI or Stable Audio Studio didn't start.

## Review Focus
1. ComfyUI already running at launch → no spawn, state ready (Task 1 test).
2. Exe missing everywhere → state missing with the copy, no spawn (Task 1 test).
3. The process exits before ready → failed with the copy, not a 4-minute hang (Task 1 test).
4. autostart off for a tool → that starter never runs at launch (Task 2 test).
5. stop() after Studio didn't start it → nothing killed (Task 1 test).

---

### Task 1: ComfyUI starter
**Files:** Create `six-minutes-studio/js/tools/comfystart.js`; Modify `js/settings.js` (autostart default, merge); Test `tests/comfystart.test.mjs`.
**Interfaces:** Produces `makeComfyStarter({ settings, sleep }) -> { state(), message(), onChange(fn), ensure(host), refresh(host), stop() }`; states `off|starting|ready|missing|failed`; `comfyExe(host, comfy) -> path|null`.
- [ ] Tests (FakeHost: scripted curl results via runProcess, `fs.exists`, `spawn`): already running → ready, no spawn; not found → missing + copy; spawns the first existing candidate and becomes ready when curl starts passing; process exits early → failed + copy; stop() kills only a process it spawned; ensure() twice shares one start; settings merge keeps `autostart` defaults and `comfy.exe`.
- [ ] Run → FAIL; implement; run `npm test` → PASS; commit "Studio: a ComfyUI starter".

### Task 2: Start at launch, show it, close on exit, Probe's Start now
**Files:** Create `js/autostart.js`; Modify `js/app.js`, `js/ui/films.js`, `js/ui/probe.js`, `docs/acceptance-slice1.md`; Test `tests/autostart.test.mjs`.
**Interfaces:** `autostart(host, settings, { comfy, stableAudio }) -> Promise` (runs enabled starters' `ensure` in parallel, swallowing errors — they show as state); `toolsLine({ comfy, stableAudio }) -> string`.
- [ ] Tests: both enabled → both ensure called; `autostart.comfy:false` → comfy not called; one failing doesn't stop the other; `toolsLine` exact text; Films model shows the line; Probe rows for ComfyUI/Stable Audio carry `start: "comfy"|"stableAudio"` when not running.
- [ ] Run → FAIL; implement (app: create the comfy starter next to the Stable Audio one in loadRoot, call autostart once, re-render on onChange, tray tooltip adds the line, pagehide stops both; Probe: a Start now row for a failed ComfyUI/Stable Audio check calls the starter then re-runs Probe); `npm test` → PASS.
- [ ] Checklist lines; commit "Studio: start ComfyUI and Stable Audio when Studio opens"; push; publish.
