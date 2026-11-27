---
name: "documentary-explainer-script"
description: "Turn a research brief (MD/PDF) into Jon's documentary explainer reading script, asking first: own voice (Autocue Studio line script) or cloned voice (VoiceStudio copy). Ready for voicestudio-narration and documentary-explainer-video."
---

> **Storage (from 7 Nov 2026):** Jon's project files live on his home server, mapped on his PC as `S:` (`\\192.168.1.171\jon`). The working folder is `S:\Youtube video ideas\`. If `S:` isn't visible to a tool, use the UNC path `\\192.168.1.171\jon\Youtube video ideas\`. Never fall back to the old `C:\Users\Jon\Youtube video ideas\` copy. Autocue Studio also copies every saved take (and its `superseded\` folder) to `S:\Youtube video ideas\Autocue recordings\<project>\` in the background (`server_backup.py`, from 7 Nov 2026); the PC folder stays the master copy, and the server copy never deletes anything.

# Documentary explainer script from a research brief

Use this when Jon hands over a research brief and wants a narrated YouTube explainer script. The brief is usually a long Markdown report with sources, sometimes a PDF.

- **Reference scripts:** `S:\Youtube video ideas\Shipping Forecast\shipping_forecast_script.md` and `S:\Youtube video ideas\London Sewers\london_sewers_script.md`. Read one before writing so the format matches exactly.
- **Pipeline:** this skill → `voicestudio-narration` (his cloned voice, or the takes he records in his own voice in Autocue Studio) → `documentary-explainer-video`.
- **Series:** the films go out on his channel **Six Minutes on…**: YouTube @SixMinuteson, X and Bluesky @sixminuteson, website sixminuteson.com, creator Jon Cowan. Each film's full title is "Six minutes on… <Topic>".

## Three-session rule (Jon's rule, not optional)

Every film is made in exactly three sessions. When a part is finished:

1. Write its handover file.
2. Commit it to his PC.
3. Stop.

Never start the next part's work in the same session, even if Jon asks in passing. Remind him of his rule and give him the opening message for the new session. Fixes that belong to the current part (rewrites, retakes, regenerations, re-renders after his notes) carry on in the same session.

| Part | Skills | Ends when |
|---|---|---|
| **1 Script** | this skill, plus `voicestudio-narration` (name test only, cloned voice) | Jon approves the script, the name test (cloned voice) or the pronunciation notes (own voice), the sound-effects list and the episode number |
| **2 Assets** | `voicestudio-narration` (full recording, or processing his own takes) and `documentary-explainer-video` (music, sound effects, Higgsfield b-roll) | Jon approves the combined review: the voiceover, the chosen score take, the sound effects and every b-roll clip |
| **3 Build** | `documentary-explainer-video` (preview, build, render, thumbnail, upload pack) | The final render, thumbnail and upload pack are delivered and his final notes are fixed |

**Own voice:** Jon records every line in Autocue Studio between Part 1 and Part 2, so Part 2 starts with his takes already in the recordings folder.

**The handover file** is `<project folder>\handover\partN_handover.md`. Commit it to his PC and also save it in outputs. The cloud workspace is wiped between sessions, so the file must let a fresh session carry on from his PC folder alone. It contains:

- **Project details:** the project name, the file prefix, the episode number and the folder paths.
- **Voice choice:** own voice (Autocue Studio) or cloned voice (VoiceStudio), and the folder where the recordings are or will be saved.
- **To-camera lines (own voice):** the id and text of each line marked `> to camera`.
- **His decisions:** every decision Jon made in this part, in his words where possible (approved respellings, chosen takes, notes).
- **File index:** every file the next part needs, with its path on his PC. Commit them first: nothing may exist only in the cloud workspace.
- **Settings and IDs:**
  - VoiceStudio profile and settings;
  - ElevenLabs flow and node IDs;
  - Higgsfield job IDs for every chosen clip, so the originals can be fetched again;
  - timing offsets.
- **Open items:** known problems and anything still open.
- **Usage:** the `explain-usage` summary for the part, in a few lines.
- **Opening message:** a ready-to-paste first message for the next session, naming the skills and the handover path. For example: "Part 2 of Six minutes on… <Topic>. Load /voicestudio-narration and /documentary-explainer-video, read C:\…\handover\part1_handover.md, and carry on."

**Starting Part 2 or 3:** read the handover from his folder first. Then bring over only the files that part needs. Don't go looking through earlier sessions.

## Voice choice (ask first)

At the start of Part 1, before writing anything, ask Jon with AskUserQuestion whether this film is narrated in **his own voice** (recorded line by line in Autocue Studio) or **his cloned voice** (VoiceStudio). The answer decides which voice copy you write. Settle the file prefix `<project>` at the same time (lowercase with underscores, for example `post_office`), because it names every recording.

Show him where the recordings will be saved, in the question and again in your final Part 1 message:

- **Own voice:** `C:\Users\Jon\desktop autocue\Recordings\<project>\<project>_<NN.s>.wav` (for example `…\Recordings\post_office\post_office_05.2.wav`). A replaced take moves to `…\Recordings\<project>\superseded\`. The processed clips and joined voiceover go to `<project folder>\narration\` in Part 2.
- **Cloned voice:** raw takes in `S:\Youtube video ideas\voice files\<audio_id>.wav`; finished clips in `<project folder>\narration\<project>_NN.wav`.

Record the choice and the recordings folder in the script's Voice line, in the final Part 1 message and in `part1_handover.md`. If he wants to re-voice a film that is already finished, see "Re-voicing a finished film" in `voicestudio-narration`.

## Inputs

- Read the whole brief, including the caveats, the myths section and the source list. The caveats decide what the narration may state as fact.
- Read the reference script for format.
- Check memory for the project's area file: pronunciations he approved and runtime wishes.
- Confirm the **episode number**; the thumbnail and upload pack need it. The Post Office was 007.

## Deliverables

Both files go in the project folder and in outputs:

1. `<project>_script.md`, the reading script, used for captions and the build.
2. The voice copy, depending on the voice choice:
   - **cloned voice:** `<project>_script_voice_VS.txt`, the VoiceStudio copy: one `### <project>_NN` heading and one paragraph per clip;
   - **own voice:** `<project>_line_script.txt`, the Autocue Studio line script: one line per sentence (see Line script for Autocue Studio). Commit it to `<project folder>\narration\` and also to `C:\Users\Jon\desktop autocue\`, where the app's Load script button opens.

## Reading script format

- **Header:**
  - title `# <Title> — Reading Script`;
  - runtime target · word count in N clips · `Voice: Jon (VoiceStudio, speed 0.9)` or `Voice: Jon, own voice (Autocue Studio → Recordings\<project>\)`;
  - a Build line naming the pipeline and the b-roll source.
- **Key paragraph:**
  - visual cues go in [brackets];
  - `HF-nn` means a Higgsfield shot;
  - name one or two **reusable graphics** that are built once and used throughout (Shipping Forecast: `MAP` of sea areas; Sewers: `MAP` of the Thames and `EGG` sewer cross-section);
  - each numbered paragraph is one clip, `<project>_NN.wav`.
- **Sections:** about seven, each headed `## SECTION n — NAME *(about m:ss–m:ss)*` and separated by `---`.
- **Clips:** a bold number (`**01**`), the narration on the next line, then a [bracketed] cue. An optional delivery note in italics can follow the number; that is in the script only, never on screen.
- **Cue vocabulary (house style):**
  - readouts in bold (`Readout: **25 OCT 1859**` with a sub-line);
  - line art drawing on in amber;
  - MAP moves;
  - quote cards in Inter Light with amber attribution;
  - small source notes and text cards;
  - a title card at the end of the cold open: a small amber **SIX MINUTES ON…** label above the title, an amber rule and a sub-line;
  - an end card.
- **On-screen text is Inter only, with no italics anywhere.**
- **End card cue (always):**
  - a small amber label **SIX MINUTES ON…** above the topic title in caps;
  - an amber rule and a subtitle;
  - A film by Jon Cowan · **youtube.com/@SixMinuteson** · **sixminuteson.com** · **@sixminuteson** on X and Bluesky;
  - small credits: sources, archive with licences, photo credits, map data and music.
- **Higgsfield shot list**, after the script:
  - a table of Shot | Used in | Prompt;
  - 16:9, 1080p, 5–8 s, slow moves;
  - graded navy `#0a1b30` and amber `#e3a64a`;
  - illustrative only, never captioned as a real place, ship or object.

  Write prompts that avoid known failures:
  - name the period for any vessel or vehicle ("no modern ships") and rule out modern street furniture, road markings and cars in period scenes;
  - say "low-rise European city, no skyscrapers" for a British skyline;
  - say "a single man" when one figure will do, because extra figures vanish mid-shot;
  - spell out the direction of physical motion ("water flows down into the drain");
  - for an underground or night shot, ask for it dark and low-key;
  - for a held opening shot, ask for 15 s and "one single continuous unbroken shot, no cuts". Kling can hide a jump cut inside a clip: the first sewer tunnel jumped at 3.96 s.
- **Sound-effects list:** a table of Cue | clip | prompt idea, kept few and in the background. Jon approves this list in Part 1, before any sound effect is made.
- **Optional music line.**
- **Archive and rights**, when archive images are proposed:
  - public-domain pre-1900 engravings and cartoons are the safe choice;
  - name the licence of each scan;
  - press photos need permission;
  - give the map data source and credit.
- **Notes for the build:**
  - corrections to the brief;
  - myths kept out or hedged;
  - softer-sourced lines he may cut;
  - conflicting figures;
  - time-sensitive lines to re-check before publishing;
  - material left out on purpose, suggested as a Short or an optional clip with its text;
  - ways to film things himself;
  - a pronunciation test list;
  - the timing maths with a cut order.

## Writing the narration

- **Length:** about 6:00–6:45 unless he says otherwise, which is roughly 825–925 words in 26–29 clips of 5–50 words each. "Six minutes on…" films should land close to six minutes.
- **Cold open:** a vivid present-day hook, then the stakes, then a short punchy line into the title card ("It began with a shipwreck." / "And it took a smell to build it."). The ending bookends the opening image.
- **Style:** plain spoken British English, short sentences, concrete numbers and dates, one idea per sentence. Let a few lines land on their own ("The word was his.").
- **Quotes:** only short, well-sourced lines, with the speaker named in the narration and the cue.
- Never quote song lyrics or poems; mention them only.

## Accuracy rules

- State as fact only what the brief supports with a good source.
- Hedge anything the brief marks as contested, modelled, unverified or folklore ("Many believed…", "That figure is modelled…"), or leave it out and say so in the notes.
- Prefer the brief's own recommended framings and figures.
- Flag every date conflict and every place where the brief corrects popular accounts.
- Use real years, never "this year" or "last year", so the film doesn't date.
- Flag fast-changing facts (companies, finances, policy) for re-checking on publish day.
- Visual cues must never label a generic image as a specific real thing.

## VoiceStudio copy rules

Change punctuation and spelling only, never words. Ask him before rewording.

- **Numbers:** spell out all numbers and years ("eighteen fifty-eight", "twenty twenty-five", "four point seven billion pounds", "eighty-six percent").
- **Initialisms:** spell out letter-by-letter initialisms with spaces (`H M S`, `F M`, `A D forty-seven`). Write MPs as plain `MPs`, because `M Ps` was read as "em pee ess".
- **Commas:** remove commas before "and" and commas that split a phrase. Remove ellipses.
- **Place names:** never hyphenate a place name onto its adjective (`tidal-Thames` became "tames").
- **Respellings:** use his approved respellings from memory and from `voicestudio-narration` (for example `Bazzle-jet`, `Kollera`, `Tems` after "tidal", `Tuppence`, `thruppence`).
- **Check:** afterwards, diff the two copies with difflib (ignoring punctuation) and confirm that the only differences are numbers and respellings.

## Line script for Autocue Studio (own voice)

One line per sentence, so each take is short and has a fixed ID that drops straight back into the build.

- **IDs:** `NN.s` = clip NN, sentence s (`05.2`). They become the `sentence` field in the transcript JSON and the take names (`<project>_05.2.wav`).
- **Short sentences:** join a sentence of three words or fewer onto its neighbour in the same clip ("Kenwyn. Do not demolish.").
- **Words:** exactly the reading script's words, with normal spellings. Never use VoiceStudio respellings (St Austell, not Saint Ostul; TUC, not T U C; baton, not batten).
- **Numbers and years:** spelled out as words, as in the VoiceStudio copy, so they are read as intended and the captions align.
- **Pronunciation notes:** under any line with a name from his approved pronunciations or the test list, add `> Name = "say-it"`. The app shows it in amber; it isn't read.
- **To-camera lines:** after the script is agreed, pick about five lines Jon says face to camera: one or two near the start, two in the middle, one near the end. Each is one sentence, spoken in 12 s or less (about 30 words), and carries the film's voice (a claim, a turn, a question, the sign-off), not a line over maps or data. Write `> to camera` as a note under each one's line, after its text (as in the example below). Autocue Studio shows it in amber so he delivers the line to the lens, and Six Minutes Studio makes a clip of him for it and plans no b-roll on it. List them in the handover.
- **Format:**

  ```
  # <Title> — line-by-line recording script (N lines)
  # name: <project>
  ## 1 · COLD OPEN
  [01.1]  (clip 01)
  On a hill above St Austell in Cornwall, someone once sprayed four words on the wall of a house.
  > St Austell = "Saint Ostul"
  [01.2]  (clip 01)
  Nobody knows who wrote them, but everyone in the town knows what they said.
  > to camera
  ```

  `# name:` sets the take prefix, `## ` is a section heading, `[id]` starts a line (text after the `]` is ignored), `> ` is a note, other `#` lines are comments.
- **Build it with Python** from the reading script: split each clip on sentence ends (not after "St", "Mr" or "Dr"), number the sentences, add the notes.
- **Check:** count the lines, confirm every clip is present and in order, and diff the joined line text against the reading script (ignoring punctuation and number format). The words must match.

## Timing maths

- **Speech rate:** about 0.40 s per spelled-out word at speed 0.9, measured on the Shipping Forecast takes (336 s for 845 words). Use the same figure for his own voice until an own-voice film has been measured, then tell Jon his measured rate so this skill can be updated.
- **Gaps:** add 0.6 s between clips, 1.2 s between sections, a 6 s cold-open hold and the end card.
- **Section starts:** compute them with a short Python script and write them into the section headings.
- **Word count:** count the reading-script words with a script; don't estimate.
- **Expect it to come in short:** pause tightening during recording makes the finished voiceover about 3–4% shorter than this estimate.

## Finish (end of Part 1)

1. Write both script files (the reading script and the VoiceStudio copy or line script) to `/mnt/user-data/outputs/` and commit them to the project folder (own voice: the line script to the autocue folder too).
2. **Cloned voice:** run the name test (`voicestudio-narration`). **Own voice:** no name test; list the tricky names with the pronunciations in the notes for him to confirm.
3. In one short reply, ask Jon to approve the script, the name test (or, for his own voice, the pronunciation notes), the sound-effects list and the episode number together. Include:
   - the runtime and clip count;
   - the main hedges and corrections;
   - the files to listen to (cloned voice);
   - the voice choice and where his recordings will save (own voice: the full `Recordings\<project>\` path and an example take name).
4. Make his script and name-test fixes in this session.
5. Once he approves:
   - write `handover\part1_handover.md` (see the Three-session rule);
   - commit the approved script, the voice copy (VoiceStudio copy and name-test clips, or the line script) and the handover;
   - run `explain-usage`;
   - give him the opening message for Part 2. For his own voice, first tell him to record every line in Autocue Studio (Load script → `<project>_line_script.txt`), and say that Part 2 starts once the takes are in `Recordings\<project>\`.
6. Stop. Don't start recording the full narration in this session.