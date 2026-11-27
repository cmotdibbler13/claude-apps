# Six Minutes Studio: pacing review in the mix preview

Status: draft for Jon's approval (builder check done). Date: 2026-11-27.

## Why

The joined voiceover feels "just a little rushed". Jon would leave more room in some places when talking,
for example at 2:00, "Pictish village in Orkney. Pictish ‖ he was out…", where the second "Pictish" needs a
beat to land before the line carries on. Where those beats go needs a human ear, line by line. If the
narration feels wrong, people won't watch the films, so this is worth getting right.

## What Jon gets

The **Mix preview** step (step 3 of Voiceover and mix in a film's Review) gains a line-by-line review under
the player:

```
 ▶ ❚❚  mix player  ─────●──────────  2:01 / 6:40
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ 01.3  …and the sea took the rest.                       [note]  ☐ Re-record │
 │ 02.1  Pictish village in Orkney. Pictish ‖ he was out…  [note]  ☐ Re-record │  ← playing now
 │        ＋ (gap after line)                                                  │
 │ 02.2  Nobody knows how long it stood.                   [note]  ☐ Re-record │
 └───────────────────────────────────────────────────────────────────────────┘
   3 pauses marked · 1 line to re-record          [ Apply pauses ]
```

- **Rolling lines.** As the mix plays, the line being spoken is highlighted and the list scrolls to keep it
  in view. Clicking a line's id plays the mix from that line's start.
- **A note box on every line.** Jon types what he hears, e.g. "pause after the second Pictish".
  A **Place pauses** button (one for the whole list, for the lines with new notes) sends the notes to Claude,
  which places ‖ marks. Nothing is rebuilt yet; Jon sees every mark first. The note stays with the line.
- **Click a word to add a mark yourself.** Clicking a word in a line puts a ‖ after it (Medium).
  Clicking the ＋ between two lines adds to the gap after the first.
- **Changing a mark.** Clicking a ‖ opens a small menu: Short / Medium / Long, ◀ ▶ (move to the word
  before or after), Remove. (This is the "drag" from the approach: buttons, not dragging, are easier to
  hit and work the same on any screen.)
- **Re-record.** Ticking it marks the line for re-recording; it shows as "Re-record" in the Narration list
  until a newer take of that line arrives from Autocue Studio, then clears itself.
- **Apply pauses** joins the voiceover again with the marks, then fits the score again and remakes the
  mix, one after the other, all local and free. The marks stay (shown solid once applied) so Jon can
  listen, adjust and apply again.

## Goals

- Jon can hear each line in the film as it will be, write what feels wrong, and see exactly what will change
  before anything is rebuilt.
- Pauses land in the silence after the word Jon means, never cutting into a word.
- One button takes the film from marks to a new mix preview.

## Non-goals

- Changing how a word is said. That is a re-record; the review only marks the line.
- Making lines shorter or removing pauses Jon recorded (the join's stall tightening stays as it is).
- Changing the join's built-in gaps for the whole film (0.55 s / 0.6 s / 1.2 s). Marks are per place.
  If after a review every paragraph break wants more room, that is a one-number change Claude can make
  later.
- The auto-start for ComfyUI, Stable Audio and Stem Remixer: a separate piece of work, after this one.

## Anti-goals

- A pause that clips the end of a word without telling Jon. (Where words run together it may, so it is
  flagged for him to hear.)
- Claude changing the audio from a note Jon hasn't seen placed.
- Losing Jon's marks or notes on a rejoin, a re-record, or a Studio restart.
- Overwriting Jon's own Stem Remixer export without asking.

## Approaches considered

- **A. Claude reads the notes and applies them directly.** Natural, but a wrong guess is only found by
  listening again.
- **B. Jon clicks words to place pauses; notes are only for him.** Exact, but no way to just describe it.
- **C. Both (picked by Jon).** Notes become marks Claude places and Jon can see and change; Jon can also
  click to place marks himself. Nothing is rebuilt until Apply pauses.

## How it works

### Where the lines and words come from

The join already writes `<project>_voiceover_transcript.json`: every line ("sentence" = line id such as
`02.1`) with its start and end in voiceover time, and every word with its start and end. Film time is
voiceover time (the title hold sits inside the voiceover), so the mix player's time maps straight onto it.
The line text shown is the line script's text (what Jon wrote); words to click come from the transcript.
If a line's transcript words are missing (a silent take), the line shows its script text and only the
gap ＋ can be marked.

### What a mark is

Stored in the film's `state.json` under `mix.pacing`, so marks survive restarts:

```
mix.pacing = {
  lines: {
    "02.1": {
      note: "pause after the second Pictish",
      noteAt: <ms>,                          // last edit, to know which notes are new for Place pauses
      rerecord: { at: <ms> } | null,
      take: "<take file signature: name + size + mtime>",
      pauses: [
        { after: 3, word: "Pictish", atS: 2.41, size: "medium", by: "claude" | "jon" }, // inside the line
        { after: "end", size: "short", by: "jon" }                                        // gap after the line
      ]
    }
  },
  appliedAt: <ms> | null,                    // the join that used these marks
  appliedSig: "<signature of the marks that join used>"
}
```

- A mark is tied to a **word and its occurrence in the line** (`word: "Pictish", nth: 2`), not to a time
  or a transcript index, because every join re-transcribes and Whisper can split words differently.
  `after` (the index) and `atS` are only a cache. At each Apply, Studio finds the word again in the
  current transcript and works out `at_s` afresh: the middle of the silence between that word's end and
  the next word's start, minus the silence already inserted earlier in that line by the last join (Studio
  knows it: it sent it), so `at_s` is always measured on the line's audio without pauses. If the word
  can't be found again, the mark is greyed with "Couldn't find this word. Place again" and not sent.
  (My call, from the builder check.)
- Sizes add silence: **Short 0.3 s, Medium 0.6 s, Long 1.0 s**. A gap mark adds to the gap the join
  already leaves after that line (0.55 s within a paragraph, 0.6 s between paragraphs, 1.2 s between
  sections, the title hold after the cold open).
- When a line's take changes (re-recorded), its inside-the-line marks no longer match the words: they are
  kept but shown greyed with "The take changed. Place again", and are not sent to the join. Gap marks
  and the note carry over.

### Placing marks from notes (Claude)

Place pauses sends Claude, for each line with a note newer than its marks: the line id, its words with
their index, the note, and the line before and after for context. Claude answers with marks
(`after` index or `"end"`, a size) and, when a note is not about a pause (e.g. "say it angrier"), a short
reply instead, shown under the note, suggesting Re-record. Claude's marks replace earlier Claude marks
on that line; Jon's own marks are never replaced. Uses the app's existing Claude access (the `sample`
capability, quick tier), the same way the fit plan does. Free to Jon.

### The join with marks (Autocue Studio's voiceover_join.py)

A new optional argument `--pauses <file.json>`:

```
{ "inside": { "02.1": [ { "at_s": 2.41, "add_s": 0.6 } ] },
  "after":  { "02.1": 0.3 } }
```

- Inside: after trimming and stall tightening, the line's part has `add_s` of digital silence inserted at
  `at_s`, moved to the quietest 10 ms within ±0.15 s of it, with the same short crossfades the stall
  tightening uses so there is no click.
- **Words run together (Jon's decision).** When there is no real silence there (the quietest 10 ms is
  still above the line's voice threshold), the pause goes in anyway at that quietest point, and the join
  reports it: `"tight": [{"id": "02.1", "at_s": …}]` in its done line. Studio shows that mark with
  "Tight cut: have a listen" so Jon checks it, and he can remove it or tick Re-record.
- After: `add_s` is added to whatever gap follows that line (sentence, clip, section or title hold).
- The timings CSV and transcript are written from the result as now, so every later step (SFX starts,
  fit targets, the rolling lines) sees the new times.
- Without `--pauses` the join behaves exactly as today. Studio writes the file into the film's
  `studio\mix` folder and passes it; the Install join script button installs the new script as before.

### Apply pauses: the chain

1. Join again with the marks. It includes whatever takes are current (a new take Jon recorded since
   is used, as any join would), and allows the lines the last join allowed plus lines marked Re-record:
   Jon marked those himself, and pauses can be tried before he re-records. Lines newly flagged by the
   checker since the last join still need "Join anyway". (My call.)
2. Studio already re-proposes Claude's sound effect start times after every join, from the new timings.
   Start times Jon set himself move by the change in silence before them since the last join, so they
   stay on the words they were on. (My call; not moved twice.)
3. Fit the score again:
   - if the last fit was made in Studio, the same way, with the same note Jon gave last time;
   - if the last fit was Jon's Stem Remixer export, the chain stops after the join and the Fit step says
     the voiceover changed, with Open in Stem Remixer; Jon's export is never replaced without him.
4. Make the mix again.

Each step shows in the Voiceover and mix steps as it does now; a failure stops the chain there with its
usual message. The marks are "applied" once the join succeeds. Changing a mark after that lights
Apply pauses again and marks the voiceover out of date, the same way a new take does today.

### Re-record

Ticking Re-record stores the time. The Narration list shows the line as "Re-record" (with the note as its
reason) until a take of that line newer than that time appears; then the tick clears itself and the line is
checked as any new take is. While a line is marked Re-record, Join counts it as not OK ("Join anyway").

## Constraints

- Studio is the existing Claude artifact (desktop capability); the join runs Autocue Studio's Python on
  the PC through the GPU lane like now. No new connectors, no paid generation.
- Never delete or overwrite takes or Jon's exports; earlier outputs are moved aside as now.
- Voice recordings are never committed to the repo.
- Works at phone width (the list wraps; note boxes go under the line text).

## Calls I made (Jon to check)

- Sizes: Short 0.3 s, Medium 0.6 s, Long 1.0 s; a clicked word gets Medium.
- Move a mark with ◀ ▶ buttons rather than dragging.
- One Place pauses button for all new notes, not one per line, so Claude sees neighbouring lines together.
- Sound effect start times follow the pauses (including ones Jon set).
- A Stem Remixer export stops the chain instead of being replaced.
- The review sits under the mix player and plays the mix (music in). If no mix exists yet, or the mix is
  older than the voiceover (e.g. the chain stopped at a Stem Remixer export), it plays the joined
  voiceover instead and says so, so the highlight always matches what is heard.
- Marks are tied to the word and which time it occurs in the line, and their positions are worked out
  afresh at each Apply.
- Apply includes current takes and Re-record lines; newly flagged lines still need Join anyway.
- After `voiceover_join.py` changes, `js/autocue-bundle.js` is rebuilt so Install join script carries it.

## Left to the builder

- Exact layout and styling within Studio's existing look; how the highlighted line scrolls.
- The signature formats, file names and where the pauses JSON lives in `studio\mix`.
- How Claude's request and reply are shaped, as long as it can only produce marks or a reply.
- Test design, including a voiceover_join test that a pause never lands inside a word.
