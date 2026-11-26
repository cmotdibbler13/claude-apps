# Six Minutes Studio: ComfyUI for b-roll (design)

Approved by Jon, 26 Nov 2026. Adds to `2026-11-26-six-minutes-studio-design.md` and slice 1.

## Why
Higgsfield b-roll costs credits. Jon wants ComfyUI on his PC as a free alternative for filmed-looking b-roll clips. A test session on his PC (26 Nov) built and tested two workflows. LTX-2.5 22B distilled is recommended: about 3.7 min per 5 s clip at 1920×1088, 24 fps, with a sound track. Wan 2.2 TI2V 5B is the slower fallback: about 9.6 min at 1280×704, no sound.

## Goals
- B-roll shots can use **Higgsfield** (paid) or **ComfyUI** (free, local GPU), switchable on the card whenever no take is running. New takes use the shot's current tool.
- A per-film setting, **Prefer ComfyUI for b-roll**, makes the shot list propose ComfyUI for b-roll. Line art stays on Higgsfield and 3D on Blender.
- ComfyUI takes run on the GPU lane with Blender, one at a time, and show in Live jobs with an estimated time left.
- Redo with a note works the same: Claude rewrites the prompt and the new take is added beside the old ones.
- If the app closes mid-render, reopening reconnects to the same ComfyUI render by its prompt id and never submits a second one.

## Non-goals
- Image-to-video from line art or stills (Wan's start-image slot), for later.
- Live per-step progress over ComfyUI's websocket. The page can't hold one, so progress comes from polling.
- Installing or managing ComfyUI, models or workflows.

## Approaches considered
| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | The app drives ComfyUI's HTTP API directly (submit, poll history, copy output) using Jon's exported API-format workflows | Free and fast, no sessions, fits the existing runner and job model |
| B | A Claude Code session runs each workflow | Brings back the sessions the app replaces |

## Design
- **Workflow and mapping in settings.** `.studio-settings.json` gains a `comfy` object, merged over defaults for LTX:
  - URL `http://127.0.0.1:8188`, output folder `C:\Users\Jon\AppData\Local\Comfy-Desktop\ComfyUI-Shared\output`;
  - workflow `S:\Youtube video ideas\ComfyUI workflows\broll_ltx.json`;
  - node map: prompt `364.text`, width `372.value`, height `360.value`, length `362.value` in seconds, fps `361.value`, seed `339.noise_seed`, output `9999.filename_prefix`;
  - render values: 1920×1088, 5 s, 24 fps.
  - A Wan mapping can replace it without code changes. Length can be in "seconds" or "frames" (Wan: frames = 4n+1).
- **Submit.** Fill a copy of the workflow: the prompt, the size, the length, the fps, a new random seed, and a unique output prefix `broll/sixmin_<film>_<id>_t<n>_<time>`. POST `{"prompt": workflow}` to `/prompt` through curl, an argument list with no shell and the body in a temp file. Store the returned `prompt_id` as the job's `jobRef` before waiting.
- **Wait.** Poll `/history/<prompt_id>` every 5 s, with no paid limits involved:
  - status success → done;
  - status error → failed, with ComfyUI's message;
  - not in history yet → still queued or running.
  - ETA comes from the elapsed time against the expected clip time (default 4 min). A cap of 60 min.
  - ComfyUI unreachable at submit → fail straight away: "ComfyUI isn't running at 127.0.0.1:8188. Open ComfyUI Desktop and press Run again."
  - Unreachable while waiting → up to 5 tries, then "Couldn't reach ComfyUI; the render may still be running. Check again."
- **Collect.** Find the output file in the history outputs (the `filename` and `subfolder` of the saved video under the output node). Then ffmpeg `crop=1920:1080` and drop the audio into `<film>\studio\media\HF-nn_tN.mp4`, through a `.part` file and a rename. The original stays in ComfyUI's output folder.
- **Resume.** The job engine resumes any job whose runner has `resume` and whose job has a `jobRef`, whatever its lane (previously connector only). Check again works for ComfyUI jobs too. Run again submits a new render and costs nothing.
- **Probe** gets a ComfyUI check (GET `/system_stats`, plus the workflow file exists).

## Left to the builder
The exact module split, poll and retry details within the rules above, and copy wording in the house style.
