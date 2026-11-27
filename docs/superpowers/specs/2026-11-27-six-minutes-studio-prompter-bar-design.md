# Six Minutes Studio: prompter bar and collapsible sections (short design)

Status: approved by Jon, 2026-11-27.

## Why
Reviewing the pacing line by line, Jon has to scroll back up to the player to pause, and the Review page is very long.

## What
1. **Prompter bar.** A bar that stays at the top (under the existing sticky header) whenever the pacing review is
   available (a joined voiceover). It controls the same audio element the review follows (the mix player when the
   mix is current, else the review's voiceover player):
   - ⏮ / ⏭: previous / next line start; ❚❚ / ▶ pause and carry on; time `m:ss / m:ss`.
   - The current line's id and text on one line, autocue style. Its words are buttons: click → ‖ Medium after it
     (same action as in the list); a ‖ is a button with the same Short / Medium / Long / ◀ / ▶ / Remove menu.
     Same rules as the list (no word clicks on a new-take line, greyed marks as in the list).
   - ＋ gap (after this line), Note… (opens a note box in the bar for this line, saved on blur like the list's),
     Re-record tick.
   - Updates on the audio's timeupdate without a full re-render (like followPlayer); before playback starts it
     shows the first line.
   - Phone width: wraps to two rows; the text line truncates with an ellipsis and the full text is its title.
2. **Collapsible sections.** Each Review section heading (Narration, Score, Sound effects, Voiceover and mix,
   B-roll) gets a ▾ / ▸ button that folds the section's content. Remembered per viewer in localStorage
   (try/catch; works without it). All open by default. A collapsed Voiceover and mix keeps the prompter bar working
   (the audio element stays alive).

## Approaches
A top bar (picked: Jon asked for it at the top) vs a floating bottom mini-player (fights the phone's own bottom
bars) vs making the whole review list sticky (too tall). One sensible way.

## Calls I made
Bar contents beyond Jon's ask (⏮ ⏭, ＋ gap, Note…, Re-record); all sections open by default; the existing sticky
b-roll summary sits below the bar when both are visible.

## Left to the builder
Exact layout and styles in Studio's look; how the bar and the summary stack.
