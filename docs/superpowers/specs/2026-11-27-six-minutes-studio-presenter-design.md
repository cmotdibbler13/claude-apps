# Six Minutes Studio: Jon on camera (talking-head clips)

Status: draft for Jon's approval. Date: 2026-11-27.

## Why
Jon appears in his films for a few lines, face to camera. Until now that was filmed on his PC in a studio with a blue
background and a CGI suit. He wants a nicer, slightly blurred background that suits the film and better clothes, made
for each film, without filming. Trials (Runway, Higgsfield Wan 2.7, local ComfyUI) settled on **Higgsfield**: a
portrait made from his photo keeps his face, and Wan 2.7 lip-syncs it to his own recorded line. His one note on the
trial: on an outdoor shot the hands and elbows need to look more natural.

## What Jon gets
1. **Lines picked when the script is agreed.** While writing a film's script, Claude picks the to-camera lines and
   marks each in the line script with a note `> to camera`. Autocue Studio shows the note in amber while he records,
   so he can deliver those lines to the lens. (Fallback: a script without marks gets suggestions in Studio.)
2. **A new presenter shot for each film,** in Studio. Claude suggests three outfits and three sets that suit the film
   (for an Orkney film: e.g. the Bay of Skaill at dusk); he picks one of each or types his own, presses a costed
   button, gets two portraits, and approves one. That portrait is used for all the film's clips.
3. **The clips.** Each marked line becomes a shot in the Review (kind `presenter`), lip-synced to his own voice for
   that line, made and reviewed like any other shot: costed Make button, takes, redo with a note, approve.

## Goals
- His face stays his; the lips match his own recording; hands and elbows look natural.
- One look per film, chosen by Jon, different from film to film.
- Lines that suit the camera: about five per film, placed through it, decided when the script is agreed.

## Non-goals
- Cloning his voice or changing what he said: the audio is always his recording.
- Putting the clips into the film's edit (that is the video build, from the approved files and their line ids).
- Runway or local ComfyUI for this (trialled; not chosen). Animated b-roll of Jon doing things.

## Anti-goals
- A face that drifts from Jon's, or clothes and set that change between clips of one film.
- Any credits spent without Jon pressing a button that shows the cost.
- A clip whose audio no longer matches the film's voiceover without Studio saying so.

## Approaches (Jon picked A with B as fallback)
- **A. Marks written in the script step (picked).** The documentary-explainer-script skill picks the lines and writes
  `> to camera` under each in the line script. Jon knows while recording. Needs a skill update he re-installs.
- **B. Studio suggests the lines (fallback).** When a film's line script has no `> to camera` marks, Studio asks
  Claude for suggestions and Jon accepts or swaps them. Works for old films; nothing else changes.

## A: the script skill
- Section "Line script for Autocue Studio" gains: after the script is agreed, pick **about five to-camera lines: one
  or two near the start, two in the middle, one near the end**, one sentence each, spoken in **12 s or less (about
  30 words)**, lines that carry the film's voice (a claim, a turn, a question, the sign-off), not lines over maps
  or data. Write `> to camera` under each line's `[id]`, and list them in the handover.
- Delivered as an updated SKILL.md in the repo (`skills/documentary-explainer-script/SKILL.md`) for Jon to upload;
  Studio can't install skills.

## B and editing the choice in Studio
- Studio's line-script parser keeps notes; a line with a note equal to `to camera` (case-insensitive, trimmed) is a
  to-camera line.
- A new step in the film's Review, **On camera**, above the shots, shows the chosen lines (id, text, where in the film).
  - Script has marks: those lines, labelled "from the script".
  - No marks: a **Suggest lines** button (Claude, free) proposes about five with a one-line reason each, by the same
    rules as A; Jon ticks to accept.
  - Either way, Jon can untick a line or add one ("Add a line" picks from the Narration list). A line longer than
    15 s spoken can't be added ("Too long for one clip: 15 s at most").
  - Studio never writes to the line script; the choice is saved in the film's `state.json` (`presenter.lines`).

## The presenter shot (per film)
- Settings `presenter: { photos: [<path>, ...] }`: one or two photos of Jon used as face references (his office photo
  and the blazer frame used in the trial). Probe gets a row "Presenter photos" (pass when the files exist).
- **Look** (in the On camera step): Claude (free) suggests three outfits and three sets from the script and the
  film's subject, with the last film's choice offered too. Jon picks one of each or types his own.
  - Set wording always includes: softly out of focus, shallow depth of field, calm and uncluttered.
- **Make portraits** (costed button, cost from Higgsfield's estimate): uploads the photos (free) and runs
  `generate_image` with `seedream_5_5`, 16:9, 2k, the photos as `image_references`, count 2, prompt:
  "Keep this exact man from the reference photos: same face, same bald head, same short grey beard, same age, same
  eyes and expression; do not change his identity. Documentary presenter portrait, framed from mid-chest up, facing
  the camera directly, shoulders relaxed, arms resting naturally at his sides, hands below the frame. He wears
  <outfit>. Background: <set>, strongly out of focus with a shallow depth of field, calm and uncluttered. Warm soft
  key light on his face from the left, gentle rim light, cinematic, photorealistic, 85mm lens, natural skin texture."
  (The trial's prompt, with the trial's waist-up, hands-together framing replaced for natural arms.)
- Jon approves one portrait (or makes more, or changes the look). The approved portrait is the film's presenter
  (`presenter.portrait`), saved in the film's `studio\presenter\` folder. Changing it after clips exist marks those
  clips "Made with an earlier portrait" (they stay; redo is his choice).

## The clips
- Each chosen line becomes an asset `kind: "presenter"`, `tool: "higgsfield"`, id `TC-01`, `TC-02`… in the order
  they are created, never reused (my call: ids stay stable so take files never collide), shown by line position in
  the Review's shot list.
- **Unticking a line:** with no takes, the shot just goes. With takes, it moves to `state.removed` like "Remove this
  version" (takes stay on disk); ticking the line again makes a new id. (My call.) Make is locked until a portrait is approved and the line is in a joined voiceover.
- **Audio:** the line's stretch of the joined voiceover (start/end from `<project>_voiceover_transcript.json`, so
  pacing pauses inside the line are included), cut with ffmpeg to a WAV, padded with silence to a whole number of
  seconds (Wan 2.7 takes 2–15 s), uploaded to Higgsfield (`media_upload`, PUT, `media_confirm`; free).
- **Generate:** `generate_video` with `wan2_7`, 1080p, 16:9, duration = the padded length, medias = the portrait as
  `start_image` and the audio as `audio_references`, prompt (the trial's, with the arm note added): "The man speaks
  directly to the camera, lips precisely synced to the audio, calm and engaging documentary presenter delivery, small
  natural head movements, relaxed shoulders, natural elbow bends, small occasional gestures that stay low in frame, no
  stiff or raised arms, steady locked-off camera, the soft-focus background stays still, warm natural light,
  photorealistic." A redo note is appended. Costed button from
  `estimate_video_cost` (about 20 credits for 8 s in the trial).
- The take saves as `studio\presenter\TC-01_t1.mp4`; review, redo with a note, approve as other shots.
- **Voiceover changed (my call):** each take stores the length and a hash of its cut WAV. After each successful join,
  Studio re-cuts the lines that have presenter takes (a few short ffmpeg runs) and compares. A changed length or hash,
  e.g. a pause Jon placed inside that line or a re-recorded take, shows "The voiceover for this line changed: redo to
  match, or Keep anyway" on the shot and counts in the film's waiting line; approval stays until Jon chooses. A join
  that only moves the line in time changes neither, so doesn't count.

## B-roll on to-camera lines (Jon, 2026-11-27)
A to-camera line is Jon for the whole line; no b-roll cuts in.
- **New shot lists:** the shot plan gets the to-camera line ids and plans no shot on them (the validator refuses a
  shot whose lineIndex is a to-camera line). If the lines are chosen in Studio (fallback B) after the shot list was
  made, the next rule applies.
- **Existing shot lists:** a broll/lineart/blender/animated shot on a to-camera line shows "This line is on camera"
  with **Remove** (takes stay on disk, as Remove this version; moves to `state.removed`). It doesn't count in the
  film's waiting line. Unticking the line clears the note.

## Constraints
- Studio stays the existing artifact. Republish with `desktop`, `sample: {images: true}` and the mcp servers as now,
  with Higgsfield gaining `media_upload`, `media_confirm`, `estimate_image_cost`, `estimate_video_cost`.
- Credits only on Jon's press; never retried automatically (the Higgsfield runner's rules stand).
- Voice recordings and portraits of Jon are never committed to the repo.
- Never delete or overwrite takes; earlier outputs moved aside as now.

## Calls I made (Jon to check)
- Two portraits per Make, not three or four (each costs credits).
- Framing from mid-chest up, hands mostly out of shot, for natural arms.
- Clip audio from the joined voiceover, not the raw take, so it matches the film including pauses.
- Lines over 15 s can't be clips.
- The look is chosen in Studio, not in the script step, so it can be changed without re-recording.

## Left to the builder
- The exact wording of Claude's suggestions prompts, within the rules above.
- Layout of the On camera step, within Studio's look.
- How the media upload is called from the app (curl PUT with `If-None-Match: *`, as in the trial).
