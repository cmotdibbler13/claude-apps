# Six Minutes Studio: drawings that turn in 3D, drawings animated in ComfyUI, and removing a derived shot

Status: draft for Jon's approval. Date: 2026-11-27.

## Why
Jon's line-art drawings (Higgsfield images, e.g. HF-01 "stone dresser": amber hand-drawn lines on black, rough
stone uprights, slab top, two shelves, grain strokes) should move. His picture of a good result: **the object
turns about its own centre so you see other sides of it — for the dresser, the far upright swings round toward
the viewer — and it still looks like his drawing.** Today's "Make 3D in Blender" fails: Claude writes the Blender
script **without ever seeing the drawing** (it gets only the one-line description), so take 1 was a guessed
wireframe of boxes (with a stray post), and the redos turned the picture's pixels into a dot grid and spun it
(chunky "dot-matrix" look). Jon doesn't mind it taking longer if the result is much better.

## Goals
- A 3D version that matches the drawing's shape and proportions and its look (amber hand-drawn line, slight wobble,
  grain/texture strokes, dark navy background), turning smoothly about the object's centre.
- A second, different way to bring a drawing to life: an AI image-to-video animation of the drawing in Jon's local
  ComfyUI, so he can try both on a shot and keep the better.
- Jon can change his mind: any 3D or animated version made from a drawing can be removed.

## Non-goals
- Photoreal or shaded 3D. Characters or living things in Blender (they suit B).
- Paid image-to-3D (Higgsfield 3D) in this build (approach C below; may come later).
- Changing how the source drawings are made.

## Anti-goals
- A render that no longer looks like the drawing (boxy wireframe, dot grid, a flat card spinning).
- Spending credits without Jon pressing a costed button (both A and B here are local and free).
- Deleting takes or files: removing a version only takes it off the review list.

## Approaches (Jon picked A plus B)
- **A. Claude models it in Blender, drawn in Jon's style, checking its work against the drawing (picked, main route).**
  Claude sees the drawing, builds a real model, Blender draws it with Freestyle lines in amber with a hand-drawn
  wobble; before the full render Studio renders one still from the drawing's angle and Claude compares it with the
  drawing and corrects it, up to three rounds; then a slow turn. Exact, smooth, local; a slightly cleaner look than
  a true hand drawing.
- **B. AI image-to-video of the drawing in ComfyUI (picked, second button "Animate with ComfyUI").** Keeps the drawn
  style at the start; the AI invents hidden sides, so lines may shimmer. Local and free. Needs an image-to-video
  workflow in Jon's ComfyUI.
- **C. AI image-to-3D (Higgsfield) then Blender line render.** Not now: meshes from line drawings on black are
  often lumpy, and it costs credits.

## A: How it works

### Claude sees the pictures
The app's Claude access (`sample`) is declared with images (`{sample: {images: true}}`); the host's `claude.json`
gains an `images` option (Blob list, PNG/JPEG read from disk). If the viewer reports no image support
(`sample.limits().images` false), the 3D take fails with a clear message rather than modelling blind.

### One Blender take = model, check, render (all inside the Blender job, gpu lane)
1. **Script.** Claude gets the drawing (image), the shot's line and description, and the instructions below, and
   writes the scene script. On a redo it also gets the previous script, the note, and the previous take's check
   still.
2. **Check still.** Blender runs the script in still mode and writes one PNG: frame 1, from the camera angle that
   matches the drawing's view.
3. **Compare.** Claude gets the drawing and the still side by side and answers either "matches" or a corrected
   script, with one line saying what it changed. Steps 2–3 repeat up to 3 times (first still + up to 2
   corrections); after the third still the take renders whatever it has.
4. **Render.** The full MP4.
The job's progress shows each stage ("Modelling", "Check 1 of 3", "Rendering frame 40 of 240"). The stills and each
round's script are kept next to the take (`studio\blender\HF-02_t1_check1.png`, `_t1_r2.py`) and the take shows the
last still and Claude's one-line notes ("made the top slab thicker; moved the shelves up"). Claude calls cost
nothing; a take takes a few minutes longer than today.

### The script contract (what the instructions say)
- Run as `blender -b -P script.py -- <source> <output> [--still <png>]`; with `--still` render only frame 1 to the
  PNG; never hard-code paths; read only the source image; write only the output.
- **Model the object as solid geometry matching the drawing's proportions** (e.g. the dresser: an irregular slab
  top, two rough stone uprights, two shelves), with irregular edges where the drawing is rough; no flat image
  cards, no pixel/point clouds, no tracing the picture into dots.
- **Draw it like the drawing:** Freestyle lines (silhouette, crease, border, marked edges), amber #d5a867 (or white
  when the drawing is white), thickness matched to the drawing, a slight wobble (line style geometry modifiers such
  as Perlin noise and thickness variation), extra marked edges for grain/texture strokes like the drawing's;
  surfaces themselves black/near-black so only lines read; world dark navy #03070c–#091a2e. Render engine that
  supports Freestyle in Blender 5 (Cycles at low samples, or EEVEE if Freestyle is available there).
- **Frame 1 matches the drawing's view** (camera angle and framing as in the picture).
- **Motion:** the object turns about its own centre (vertical axis through its middle), smoothly eased, about 70° by
  default (enough that a far side comes toward the viewer; for the dresser, the far upright), over the shot length;
  camera otherwise still. A note can change angle/direction/speed.
- 1920x1080, 24 fps, H.264 MP4, the Blender 5 video-format lines as today.

## B: Animate with ComfyUI

- A line-art shot gets **Animate with ComfyUI** next to Make 3D in Blender. It adds a derived shot (kind
  `animated`, tool `comfyui`, `sourceId` = the drawing), like Make 3D does, with a draft prompt from the shot's
  description plus "slow orbit around the <object>, keep the hand-drawn amber line-art style on black, no new
  colours" that Jon can edit; redo with a note works as for other ComfyUI takes.
- It runs an **image-to-video workflow** Jon keeps in `ComfyUI workflows\animate_i2v.json` (API format, like the
  existing b-roll workflow), configured in settings `comfy.i2v: { workflow, nodes: { image, prompt, seed, length?,
  output } }` (node id + input name, like `comfy.nodes`). Studio uploads the drawing to ComfyUI (`/upload/image`),
  sets the image node to it, sets prompt/seed/length, queues it and collects the video as the existing ComfyUI
  runner does.
- Until the workflow is there, the button is shown but disabled with "Set up the image-to-video workflow (see
  Probe)", and Probe has an "Animate workflow" row saying what's missing. The acceptance checklist gives Jon the
  steps to save his ComfyUI's LTX image-to-video template as `animate_i2v.json` and fill in the node ids.

## Removing a 3D or animated version
- Every derived shot (kind `blender` or `animated`) gets **Remove this version** (with a one-step confirm:
  "Remove HF-02 from the review? Its takes stay on disk."). It is refused while a take of it is running.
- The asset moves from `state.assets` to `state.removed` (kept with its takes and a `removedAt`); its files stay;
  the drawing's Make 3D / Animate buttons come back. Nothing on disk is touched.

## Constraints
- Studio stays the existing artifact; republish with capabilities `desktop`, the two `mcp` servers as now, and
  `sample: {images: true}`.
- Blender 5.2 on Jon's PC; scripts must use only Blender 5 APIs; runs in the gpu lane like today.
- Never delete or overwrite takes; earlier outputs moved aside as now.
- No credits spent by A or B.

## Settled after the builder check (my calls)
- **Images API (confirmed in the runtime's type definitions):** `sample(input, { images: Blob[] })`, declared
  `capabilities: {sample: {images: true}}`; `sample.limits()` has an `images` member (max count, max size, types)
  only where images can be sent; otherwise a call with images rejects `images_unavailable`. Viewers are asked again
  for consent at the next Claude use after the declaration changes.
- **Where it runs:** the whole take (script, stills, compares, render) is one Blender job holding the gpu lane; the
  Claude calls are short next to the render. The script is written inside the job (the job's input carries the
  shot, take, note and previous script instead of a ready script). An interrupted job's Run again starts from the
  last saved round's script and skips to the render if the check loop had finished.
- **Sanity gate:** Claude's compare answer also says whether the still is blank/unreadable. A blank still gets one
  corrected script; two blank stills in a row fail the take ("The 3D render came out blank. Redo with a note.")
  before any full render.
- **`animated` shots** are created only by the button (never in Claude's shot plan); `shots.js` accepts kind
  `animated` with tool `comfyui`; the same "approve the drawing first" lock as Make 3D.
- **Ids after Remove:** a re-made version gets a new id (next HF number), so files never collide; removed versions
  can't be restored from the UI in this build (they stay in `state.removed`).
- **Source picture:** the drawing's chosen take (the one that must be approved), as Make 3D uses today.
- **B's workflow:** `length` is optional (left as the workflow has it when unset); the output is collected like the
  b-roll runner's (the configured output node's video file).

## Calls I made (Jon to check)
- Up to three check rounds, then render regardless.
- Default turn ~70° about the vertical axis, eased; camera still.
- Freestyle (not Grease Pencil Line Art) for the drawn look: steadier from Python across Blender versions.
- B needs Jon's own image-to-video workflow file; Studio doesn't ship one.
- Removed versions are kept in state, not deleted.

## Left to the builder
- Exact prompt wording for Claude's script and check steps, as long as the contract above holds.
- How stills are shown on the take card.
- Detecting image support and the exact failure copy.
- B's runner sharing code with the existing ComfyUI runner.
