// Score fit: where each section should land in the film, one Claude call for a fit plan, and the fit sheet.
// Plan steps are in score time: [{from_s, to_s, tempo, xfade_s}]. The fitted score's t=0 is film t=0.
import { askJson } from "./claude.js";

const HOLD_S = 6;
const TAIL_S = 0.5;
const TEMPO = [0.9, 1.1];
const XFADES = [0.03, 2.5];
const LENGTH_SLACK_S = 0.5;
const MOVE_WINDOW_S = 15;
const NEW_TAKE_S = 5;
const KEEP_NEAR_S = 0.05;

export const FIT_INSTRUCTIONS = `You fit a film score to a Six Minutes On... documentary film (dark, calm, precise, British English).
The score is already made. You plan how to cut, repeat and gently speed up or slow down parts of it so it runs the length of the film and its musical moves land where the sections start.

You get:
- measure: the score's length in seconds (duration_s), its tempo (bpm, or null when there is no clear beat), how many beats were found, its loudness in dB once a second (loud[0] is 0 s, loud[1] is 1 s and so on), and its big moves (t in seconds, kind "rise", "drop" or "fade", and the change in dB).
- targets: the film's length in seconds (filmS) and each section's start in film time (sections, name and startS).
- note: Jon's note for this fit, which may be empty. Follow it.
- previous: the last plan, or null. When there is one, change it to follow the note rather than starting again.

The plan is a list of steps played one after another. Each step plays the score from from_s to to_s (score time, in seconds) at a tempo, then crossfades into the next step.
Rules:
- tempo is from 0.90 to 1.10. Keep it near 1.00 where you can.
- xfade_s is 0.03 when the cut is on a beat, or 2.5 in an ambient stretch with no clear beat.
- A step lasts (to_s - from_s) / tempo seconds in the film. Each crossfade overlaps the next step by its xfade_s. The total, the sum of the step lengths minus the overlaps, must be within 0.5 s of filmS.
- Each section's musical move (the nearest rise or drop) should land on that section's start in film time.
- Keep the opening: the first step starts at 0. Keep the final fade: the last step ends at duration_s.
- Prefer cutting or repeating whole bars from steady stretches. Do not cut through a move.
- Steps may reuse a part of the score.

Reply with JSON only: {"steps": [{"from_s": 0, "to_s": 0, "tempo": 1.0, "xfade_s": 0.03}], "notes": "one or two short sentences on what you cut, repeated or stretched"}.`;

const num = (v) => Number(v);

export function filmTargets(timings, endCardS = 12) {
  const rows = timings ?? [];
  if (!rows.length) throw new Error("There are no voiceover timings yet. Join the voiceover first.");
  const sections = [];
  const seen = new Set();
  for (const r of rows) {
    const key = String(r.section);
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push({ name: r.name, startS: num(r.start_s) + HOLD_S });
  }
  const lastEnd = num(rows[rows.length - 1].end_s);
  return { filmS: lastEnd + TAIL_S + HOLD_S + num(endCardS), sections };
}

// Each step's film length and its overlap with the next, as Stem Remixer's chain plan works them out.
function stepLengths(steps, rate) {
  const lens = steps.map((s) => {
    if (!rate) return (s.to_s - s.from_s) / s.tempo;
    return Math.ceil((Math.round(s.to_s * rate) - Math.round(s.from_s * rate)) / s.tempo);
  });
  const overlaps = steps.map((s, i) => {
    if (i === steps.length - 1) return 0;
    const wanted = rate ? Math.round((s.xfade_s ?? 0) * rate) : (s.xfade_s ?? 0);
    const half = (n) => (rate ? Math.floor(n / 2) : n / 2);
    return Math.max(0, Math.min(wanted, half(lens[i]), half(lens[i + 1])));
  });
  const scale = rate ? 1 / rate : 1;
  return { lens: lens.map((n) => n * scale), overlaps: overlaps.map((n) => n * scale) };
}

// Seconds of fitted score. With {rate}, counts whole frames exactly as chain_length_s does.
export function renderedLength(steps, { rate } = {}) {
  const { lens, overlaps } = stepLengths(steps, rate);
  return lens.reduce((a, b) => a + b, 0) - overlaps.reduce((a, b) => a + b, 0);
}

function nearest(beats, t) {
  let best = beats[0];
  for (const b of beats) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
  return best;
}

// Moves each from_s/to_s to the nearest beat. Times within 0.05 s of a `keep` time (the score's start and end) stay put.
export function snapToBeats(steps, beats, { keep = [] } = {}) {
  if (!Array.isArray(beats) || !beats.length) return steps;
  const snap = (t) => (keep.some((k) => Math.abs(k - t) <= KEEP_NEAR_S) ? t : nearest(beats, t));
  return steps.map((s) => ({ ...s, from_s: snap(s.from_s), to_s: snap(s.to_s) }));
}

function validatePlan(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.steps) || !r.steps.length) throw new Error("The fit plan has no steps.");
  r.steps.forEach((s, i) => {
    for (const k of ["from_s", "to_s", "tempo", "xfade_s"]) {
      if (typeof s?.[k] !== "number" || !Number.isFinite(s[k])) throw new Error(`Step ${i + 1} has no ${k}.`);
    }
    if (s.from_s < 0 || s.to_s <= s.from_s) throw new Error(`Step ${i + 1} runs backwards or is empty.`);
    if (s.tempo <= 0 || s.xfade_s < 0) throw new Error(`Step ${i + 1} has a bad tempo or crossfade.`);
  });
  if (r.notes != null && typeof r.notes !== "string") throw new Error("The notes are not text.");
}

function summary(measure) {
  const loud = measure.loud ?? [];
  const perSecond = [];
  for (let i = 0; i < loud.length; i += 10) perSecond.push(Math.round(loud[i] * 10) / 10);
  return {
    duration_s: measure.duration_s,
    bpm: measure.bpm ?? null,
    beats: (measure.beats ?? []).length,
    loud: perSecond,
    moves: measure.moves ?? [],
  };
}

export async function planFit(host, { measure, targets, note = "", previous = null }) {
  const r = await askJson(host, {
    instructions: FIT_INSTRUCTIONS,
    data: { measure: summary(measure), targets, note: note ?? "", previous: previous ?? null },
    tier: "default",
    validate: validatePlan,
  });
  const clamped = r.steps.map((s) => ({
    from_s: s.from_s,
    to_s: s.to_s,
    tempo: Math.min(TEMPO[1], Math.max(TEMPO[0], s.tempo)),
    xfade_s: Math.abs(s.xfade_s - XFADES[0]) <= Math.abs(s.xfade_s - XFADES[1]) ? XFADES[0] : XFADES[1],
  }));
  const steps = snapToBeats(clamped, measure.beats, { keep: [0, measure.duration_s] });
  if (steps.some((s) => s.to_s <= s.from_s)) throw new Error("A step vanished when its cuts were moved onto beats; try again or add a note.");
  const off = renderedLength(steps) - targets.filmS;
  if (Math.abs(off) > LENGTH_SLACK_S) {
    throw new Error(`The fit came out ${Math.abs(off).toFixed(1)} s ${off > 0 ? "too long" : "too short"}; try again or add a note.`);
  }
  return { steps, notes: typeof r.notes === "string" ? r.notes.trim() : "" };
}

// Film time of a score time, through its first use in the plan; null when that part is cut.
export function landing(steps, scoreS) {
  const { lens, overlaps } = stepLengths(steps);
  let start = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (scoreS >= s.from_s && scoreS < s.to_s) return start + (scoreS - s.from_s) / s.tempo;
    start += lens[i] - overlaps[i];
  }
  return null;
}

export function fitSheet(steps, measure, targets) {
  const moves = (measure.moves ?? []).filter((m) => m.kind === "rise" || m.kind === "drop");
  const rows = targets.sections.map((sec) => {
    let landsS = null;
    for (const m of moves) {
      const at = landing(steps, m.t);
      if (at != null && Math.abs(at - sec.startS) <= MOVE_WINDOW_S) { landsS = at; break; }
    }
    return { section: sec.name, targetS: sec.startS, landsS, missS: landsS == null ? null : landsS - sec.startS };
  });
  const worstS = rows.reduce((w, r) => (r.missS == null ? w : Math.max(w, Math.abs(r.missS))), 0);
  return { rows, worstS, suggestNewTake: worstS > NEW_TAKE_S };
}
