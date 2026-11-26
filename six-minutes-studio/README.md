# Six Minutes Studio

A desktop app for the Six Minutes On... pipeline: a Claude artifact page (plain HTML and ES modules, no build step) that runs as an installed app in the Claude desktop app on Windows.

Artifact URL: (added on publish)

## Install

Open the published page in the Claude desktop app, choose Install as app, and allow full access when asked. Then open Probe and run the checks.

## Tests

From this folder, with Node 22: `npm test` (runs `node --test`). Tests use the in-memory `FakeHost` in `tests/fake-host.mjs`.

## Known setup

(Failing probe checks on the PC are recorded here.)
