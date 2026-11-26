# Six Minutes Studio

A desktop app for the Six Minutes On... pipeline: a Claude artifact page (plain HTML and ES modules, no build step) that runs as an installed app in the Claude desktop app on Windows.

Artifact URL: https://claude.ai/artifact/GjdgGKYjbtqZir2h37qYBY (private to its owner)

Acceptance checklist for the first run on the PC: [docs/acceptance-slice1.md](docs/acceptance-slice1.md)

## Install

Open the published page in the Claude desktop app, choose Install as app, and allow full access when asked. Then open Probe and run the checks.

## Tests

From this folder, with Node 22: `npm test` (runs `node --test`). Tests use the in-memory `FakeHost` in `tests/fake-host.mjs`.

## Known risks and limits

- Blender runs Python that Claude writes, with full access to this PC. The script for each render is kept beside it in the film's `studio\blender\` folder, so you can read what ran.
- "Run again" on a Higgsfield job starts a new generation and spends credits. Use "Check again" first when the job may still be running on Higgsfield; it only asks for the job's status.
- Renders use `--python-exit-code`, which needs Blender 2.9 or later.

## Known setup

(Failing probe checks on the PC are recorded here.)
