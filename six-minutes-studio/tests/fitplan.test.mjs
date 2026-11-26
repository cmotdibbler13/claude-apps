import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import {
  filmTargets, renderedLength, snapToBeats, planFit, landing, fitSheet, FIT_INSTRUCTIONS,
} from "../js/fitplan.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

const TIMINGS = [
  // As voiceover_join.py writes them: name is <project>_<clip>, section is the ## title.
  { clip: "01", section: "Cold open", name: "film_a_01", start_s: 0, end_s: 20 },
  { clip: "02", section: "The harbour", name: "film_a_02", start_s: 21.2, end_s: 60 },
  { clip: "03", section: "The harbour", name: "film_a_03", start_s: 60.6, end_s: 100 },
];

test("filmTargets: sections start at their first clip + 6, film = last end + 0.5 + 6 + end card", () => {
  const t = filmTargets(TIMINGS, 12);
  close(t.filmS, 100 + 0.5 + 6 + 12);
  assert.deepEqual(t.sections, [
    { name: "Cold open", startS: 6 },
    { name: "The harbour", startS: 27.2 },
  ]);
});

test("filmTargets falls back to the file name when a clip has no section title", () => {
  const t = filmTargets([{ clip: "01", section: "", name: "film_a_01", start_s: 0, end_s: 10 }]);
  assert.deepEqual(t.sections, [{ name: "film_a_01", startS: 6 }]);
});

test("filmTargets reads CSV strings and defaults the end card to 12", () => {
  const rows = TIMINGS.map((r) => ({ ...r, start_s: String(r.start_s), end_s: String(r.end_s) }));
  close(filmTargets(rows).filmS, 118.5);
});

test("renderedLength matches a hand calculation, including crossfades", () => {
  const steps = [
    { from_s: 0, to_s: 30, tempo: 1.0, xfade_s: 2.5 },   // 30
    { from_s: 40, to_s: 51, tempo: 1.1, xfade_s: 0.03 }, // 10, overlap with next 0.03
    { from_s: 60, to_s: 63.6, tempo: 0.9, xfade_s: 2.5 }, // 4, last: no overlap
  ];
  // 30 + 10 + 4 - 2.5 - 0.03
  close(renderedLength(steps), 41.47, 1e-9);
});

test("renderedLength clamps an overlap to half of either neighbour", () => {
  const steps = [
    { from_s: 0, to_s: 10, tempo: 1, xfade_s: 2.5 },
    { from_s: 10, to_s: 13, tempo: 1, xfade_s: 2.5 }, // 3 s long: overlaps capped at 1.5
    { from_s: 20, to_s: 30, tempo: 1, xfade_s: 0.03 },
  ];
  close(renderedLength(steps), 23 - 1.5 - 1.5);
});

test("renderedLength with a sample rate counts frames as chain_length_s does", () => {
  const steps = [
    { from_s: 0, to_s: 1, tempo: 0.9, xfade_s: 0.03 },
    { from_s: 2, to_s: 3, tempo: 1, xfade_s: 0.03 },
  ];
  // ceil(48000 / 0.9) = 53334 frames, + 48000, - round(0.03 * 48000) = 1440
  close(renderedLength(steps, { rate: 48000 }), (53334 + 48000 - 1440) / 48000);
});

test("snapToBeats moves 10.04 to the beat at 10.0, and is a no-op without beats", () => {
  const steps = [{ from_s: 0, to_s: 10.04, tempo: 1, xfade_s: 0.03 }, { from_s: 19.97, to_s: 30, tempo: 1, xfade_s: 0.03 }];
  const snapped = snapToBeats(steps, [0.5, 10.0, 10.5, 20.0, 29.5]);
  assert.equal(snapped[0].to_s, 10.0);
  assert.equal(snapped[1].from_s, 20.0);
  assert.deepEqual(snapToBeats(steps, []), steps);
  assert.deepEqual(snapToBeats(steps, undefined), steps);
});

test("snapToBeats keeps the score's start and end where asked", () => {
  const steps = [{ from_s: 0, to_s: 60, tempo: 1, xfade_s: 2.5 }];
  const snapped = snapToBeats(steps, [0.4, 59.2], { keep: [0, 60] });
  assert.deepEqual(snapped, steps);
});

test("snapToBeats leaves 2.5 s ambient joins alone (few beats)", () => {
  const steps = [{ from_s: 0, to_s: 33, tempo: 1, xfade_s: 2.5 }, { from_s: 40.1, to_s: 90, tempo: 1, xfade_s: 2.5 }];
  assert.deepEqual(snapToBeats(steps, [12, 40], { keep: [0, 90] }), steps);
});

test("snapToBeats leaves an on-beat join alone when the nearest beat is over half a beat away", () => {
  const steps = [{ from_s: 0, to_s: 33, tempo: 1, xfade_s: 0.03 }, { from_s: 40.3, to_s: 90, tempo: 1, xfade_s: 0.03 }];
  // no bpm: window 0.25 s
  assert.deepEqual(snapToBeats(steps, [12, 40], { keep: [0, 90] }), steps);
  // 120 bpm: window 0.25 s too; 60 bpm: window 0.5 s, so 40.3 snaps but 33 does not
  const wide = snapToBeats(steps, [12, 40], { keep: [0, 90], bpm: 60 });
  assert.equal(wide[0].to_s, 33);
  assert.equal(wide[1].from_s, 40);
});

test("snapToBeats only snaps the ends of on-beat joins, not the first start or last end", () => {
  const steps = [{ from_s: 5.1, to_s: 20.1, tempo: 1, xfade_s: 0.03 }, { from_s: 30.1, to_s: 50.1, tempo: 1, xfade_s: 0.03 }];
  const snapped = snapToBeats(steps, [5, 20, 30, 50]);
  assert.deepEqual(snapped.map((x) => [x.from_s, x.to_s]), [[5.1, 20], [30, 50.1]]);
});

const MEASURE = {
  done: true,
  duration_s: 120,
  loud: Array.from({ length: 1200 }, (_, i) => -30 + (i % 10)),
  beats: [],
  bpm: null,
  moves: [{ t: 30, kind: "rise", db: 6 }, { t: 90, kind: "fade", db: -12 }],
};
const TARGETS = { filmS: 118.5, sections: [{ name: "Cold open", startS: 6 }, { name: "The harbour", startS: 27.2 }] };

test("planFit rejects a plan 3 s too long with a message", async () => {
  const h = new FakeHost();
  h.claudeScript(() => ({ steps: [{ from_s: 0, to_s: 121.5, tempo: 1, xfade_s: 2.5 }], notes: "" }));
  await assert.rejects(planFit(h, { measure: { ...MEASURE, duration_s: 130 }, targets: TARGETS, note: "" }),
    { message: "The fit came out 3.0 s too long; try again or add a note." });
  h.claudeScript(() => ({ steps: [{ from_s: 0, to_s: 115.5, tempo: 1, xfade_s: 2.5 }], notes: "" }));
  await assert.rejects(planFit(h, { measure: MEASURE, targets: TARGETS }),
    { message: "The fit came out 3.0 s too short; try again or add a note." });
});

test("planFit clamps tempo 1.2 to 1.10, coerces crossfades and passes the note through", async () => {
  const h = new FakeHost();
  let seen;
  h.claudeScript((kind, input, opts) => {
    seen = { input, opts };
    return {
      steps: [
        { from_s: 0, to_s: 60, tempo: 1.0, xfade_s: 0.1 },
        { from_s: 60, to_s: 124.4, tempo: 1.2, xfade_s: 3 }, // at 1.10: 60 + 58.545 - 0.03 = 118.515
      ],
      notes: "Trimmed the bridge.",
    };
  });
  const prev = { steps: [{ from_s: 0, to_s: 118.5, tempo: 1, xfade_s: 2.5 }] };
  const r = await planFit(h, { measure: { ...MEASURE, duration_s: 130, beats: [60] }, targets: TARGETS, note: "Keep the rise at the harbour.", previous: prev });
  assert.equal(r.steps[1].tempo, 1.1);
  assert.equal(r.steps[0].xfade_s, 0.03);
  assert.equal(r.steps[1].xfade_s, 2.5);
  assert.equal(r.notes, "Trimmed the bridge.");
  assert.equal(seen.opts.tier, "default");
  assert.ok(seen.input.startsWith(FIT_INSTRUCTIONS));
  const data = JSON.parse(seen.input.slice(seen.input.indexOf("DATA (JSON):\n") + 13, seen.input.lastIndexOf("\n\nAnswer")));
  assert.equal(data.note, "Keep the rise at the harbour.");
  assert.deepEqual(data.previous, prev);
  assert.equal(data.targets.filmS, 118.5);
  assert.equal(data.measure.loud.length, 120); // every 1 s, not every 0.1 s
  assert.equal(data.measure.duration_s, 130);
  assert.equal(data.measure.beats, 1);
  assert.deepEqual(data.measure.beatSpan, [60, 60]);
  assert.deepEqual(data.measure.beatTimes, [60]);
  assert.deepEqual(data.measure.moves, MEASURE.moves);
});

test("planFit gives Claude the beat span and at most 400 beat times to 0.01 s", async () => {
  const h = new FakeHost();
  let seen;
  h.claudeScript((kind, input) => { seen = input; return { steps: [{ from_s: 0, to_s: 118.5, tempo: 1, xfade_s: 2.5 }], notes: "" }; });
  const beats = Array.from({ length: 1000 }, (_, i) => 0.123456 + i * 0.12);
  await planFit(h, { measure: { ...MEASURE, beats, bpm: 500 }, targets: TARGETS });
  const data = JSON.parse(seen.slice(seen.indexOf("DATA (JSON):\n") + 13, seen.lastIndexOf("\n\nAnswer")));
  assert.equal(data.measure.beats, 1000);
  assert.deepEqual(data.measure.beatSpan, [0.12, 120.0]);
  assert.equal(data.measure.beatTimes.length, 400);
  assert.equal(data.measure.beatTimes[0], 0.12);
  assert.ok(data.measure.beatTimes.every((t) => Math.round(t * 100) / 100 === t));
});

test("planFit clamps a step that runs past the end of the score", async () => {
  const h = new FakeHost();
  h.claudeScript(() => ({ steps: [{ from_s: 0, to_s: 61, tempo: 1, xfade_s: 2.5 }, { from_s: 60, to_s: 125, tempo: 1, xfade_s: 2.5 }], notes: "" }));
  const r = await planFit(h, { measure: MEASURE, targets: TARGETS });
  assert.equal(r.steps[1].to_s, 120);
  close(renderedLength(r.steps), 118.5, 1e-9);
  // Unclamped this would be 118.5 and pass; clamped it is 5 s short.
  h.claudeScript(() => ({ steps: [{ from_s: 0, to_s: 56, tempo: 1, xfade_s: 2.5 }, { from_s: 60, to_s: 125, tempo: 1, xfade_s: 2.5 }], notes: "" }));
  await assert.rejects(planFit(h, { measure: MEASURE, targets: TARGETS }),
    { message: "The fit came out 5.0 s too short; try again or add a note." });
});

test("planFit refuses a step that starts at the end of the score or is too short", async () => {
  const h = new FakeHost();
  h.claudeScript(() => ({ steps: [{ from_s: 0, to_s: 118.5, tempo: 1, xfade_s: 0.03 }, { from_s: 119.95, to_s: 121, tempo: 1, xfade_s: 0.03 }], notes: "" }));
  await assert.rejects(planFit(h, { measure: MEASURE, targets: TARGETS }),
    { message: "Step 2 starts at the end of the score or after it; try again or add a note." });
  h.claudeScript(() => ({ steps: [{ from_s: 0, to_s: 118.5, tempo: 1, xfade_s: 0.03 }, { from_s: 50, to_s: 50.05, tempo: 1, xfade_s: 0.03 }], notes: "" }));
  await assert.rejects(planFit(h, { measure: MEASURE, targets: TARGETS }),
    { message: "Step 2 is shorter than 0.1 s; try again or add a note." });
});

test("planFit refuses a badly shaped reply", async () => {
  const h = new FakeHost();
  h.claudeScript(() => ({ steps: [{ from_s: 10, to_s: 5, tempo: 1, xfade_s: 0.03 }], notes: "" }));
  await assert.rejects(planFit(h, { measure: MEASURE, targets: TARGETS }), (e) => e.code === "invalid");
  h.claudeScript(() => ({ steps: [], notes: "" }));
  await assert.rejects(planFit(h, { measure: MEASURE, targets: TARGETS }), (e) => e.code === "invalid");
});

test("planFit snaps to beats before checking the length", async () => {
  const h = new FakeHost();
  h.claudeScript(() => ({
    steps: [{ from_s: 0, to_s: 50.1, tempo: 1, xfade_s: 0.03 }, { from_s: 59.9, to_s: 128.4, tempo: 1, xfade_s: 0.03 }],
    notes: "",
  }));
  const beats = Array.from({ length: 260 }, (_, i) => i * 0.5);
  const r = await planFit(h, { measure: { ...MEASURE, duration_s: 130, beats }, targets: TARGETS });
  assert.equal(r.steps[0].to_s, 50);
  assert.equal(r.steps[1].from_s, 60);
  assert.equal(r.steps[1].to_s, 128.4); // the last end is not a join
  close(renderedLength(r.steps), 50 + 68.4 - 0.03);
});

test("Review Focus 4: an on-beat join with no beat near it becomes a 2.5 s crossfade before the length check", async () => {
  const h = new FakeHost();
  // 60 + 61 - 2.5 = 118.5 (the 0.03 the reply asked for would make it 120.97, 2.5 s too long)
  const reply = { steps: [{ from_s: 0, to_s: 60, tempo: 1, xfade_s: 0.03 }, { from_s: 59, to_s: 120, tempo: 1, xfade_s: 0.03 }], notes: "" };
  h.claudeScript(() => reply);
  const r = await planFit(h, { measure: { ...MEASURE, beats: [] }, targets: TARGETS });
  assert.equal(r.steps[0].xfade_s, 2.5);
  close(renderedLength(r.steps), 118.5, 1e-9);
  // A beat too far from one end (no bpm: 0.25 s) makes it ambient too; a beat at both ends keeps it on the beat.
  const far = await planFit(h, { measure: { ...MEASURE, beats: [60, 70] }, targets: TARGETS });
  assert.equal(far.steps[0].xfade_s, 2.5);
  h.claudeScript(() => ({ steps: [{ from_s: 0, to_s: 60, tempo: 1, xfade_s: 0.03 }, { from_s: 61.53, to_s: 120, tempo: 1, xfade_s: 0.03 }], notes: "" }));
  const near = await planFit(h, { measure: { ...MEASURE, beats: [60, 61.5] }, targets: TARGETS });
  assert.equal(near.steps[0].xfade_s, 0.03);
  assert.equal(near.steps[1].from_s, 61.5);
});

test("landing maps a score time to its first use when a block repeats", () => {
  const steps = [
    { from_s: 0, to_s: 20, tempo: 1, xfade_s: 0.03 },
    { from_s: 10, to_s: 20, tempo: 1, xfade_s: 0.03 }, // repeats 10-20
    { from_s: 40, to_s: 50, tempo: 0.9, xfade_s: 0.03 },
  ];
  close(landing(steps, 15), 15);
  // step 3 starts at 20 + 10 - 0.03 - 0.03 = 29.94 film; 45 is 5 s in at 0.9
  close(landing(steps, 45), 29.94 + 5 / 0.9);
  assert.equal(landing(steps, 30), null); // cut
});

test("fitSheet suggests a new take when a move misses by 6 s", () => {
  const steps = [{ from_s: 0, to_s: 118.5, tempo: 1, xfade_s: 2.5 }];
  const measure = { ...MEASURE, moves: [{ t: 3, kind: "fade", db: -3 }, { t: 33.2, kind: "rise", db: 6 }, { t: 90, kind: "drop", db: -8 }] };
  const s = fitSheet(steps, measure, TARGETS);
  assert.equal(s.rows.length, 2);
  assert.deepEqual(s.rows[0], { section: "Cold open", targetS: 6, landsS: null, missS: null, noMove: true });
  assert.deepEqual(s.missing, ["Cold open"]);
  assert.equal(s.rows[1].section, "The harbour");
  assert.equal(s.rows[1].noMove, false);
  close(s.rows[1].landsS, 33.2);
  close(s.rows[1].missS, 6, 1e-9);
  close(s.worstS, 6, 1e-9);
  assert.equal(s.suggestNewTake, true);
});

test("fitSheet is happy when every move lands within 5 s", () => {
  const steps = [{ from_s: 0, to_s: 118.5, tempo: 1, xfade_s: 2.5 }];
  const measure = { ...MEASURE, moves: [{ t: 8, kind: "drop", db: -6 }, { t: 26, kind: "rise", db: 6 }] };
  const s = fitSheet(steps, measure, TARGETS);
  close(s.rows[0].missS, 2);
  close(s.rows[1].missS, -1.2);
  close(s.worstS, 2);
  assert.equal(s.suggestNewTake, false);
  assert.deepEqual(s.missing, []);
});

test("fitSheet picks the nearest qualifying move, not the first in the list", () => {
  const steps = [{ from_s: 0, to_s: 118.5, tempo: 1, xfade_s: 2.5 }];
  const measure = { ...MEASURE, moves: [{ t: 20, kind: "rise", db: 6 }, { t: 28, kind: "drop", db: -6 }] };
  const s = fitSheet(steps, measure, TARGETS);
  close(s.rows[1].landsS, 28);
  close(s.rows[1].missS, 0.8);
});

test("fitSheet with no move for a section: missing lists it, the take suggestion comes only from worstS", () => {
  const steps = [{ from_s: 0, to_s: 118.5, tempo: 1, xfade_s: 2.5 }];
  const s = fitSheet(steps, { ...MEASURE, moves: [] }, TARGETS);
  assert.deepEqual(s.missing, ["Cold open", "The harbour"]);
  assert.equal(s.worstS, 0);
  assert.equal(s.suggestNewTake, false);
});
