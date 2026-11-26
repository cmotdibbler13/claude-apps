import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import {
  filmTargets, renderedLength, snapToBeats, planFit, landing, fitSheet, FIT_INSTRUCTIONS,
} from "../js/fitplan.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

const TIMINGS = [
  { clip: "01", section: "1", name: "Cold open", start_s: 0, end_s: 20 },
  { clip: "02", section: "2", name: "The harbour", start_s: 21.2, end_s: 60 },
  { clip: "03", section: "2", name: "The harbour", start_s: 60.6, end_s: 100 },
];

test("filmTargets: sections start at their first clip + 6, film = last end + 0.5 + 6 + end card", () => {
  const t = filmTargets(TIMINGS, 12);
  close(t.filmS, 100 + 0.5 + 6 + 12);
  assert.deepEqual(t.sections, [
    { name: "Cold open", startS: 6 },
    { name: "The harbour", startS: 27.2 },
  ]);
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

test("snapToBeats with few beats (ambient) still snaps a cut", () => {
  const steps = [{ from_s: 0, to_s: 33, tempo: 1, xfade_s: 2.5 }, { from_s: 41, to_s: 90, tempo: 1, xfade_s: 2.5 }];
  const snapped = snapToBeats(steps, [12, 40], { keep: [0, 90] });
  assert.equal(snapped[0].to_s, 40);
  assert.equal(snapped[1].from_s, 40);
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
  const r = await planFit(h, { measure: { ...MEASURE, duration_s: 130 }, targets: TARGETS, note: "Keep the rise at the harbour.", previous: prev });
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
  assert.equal(data.measure.beats, 0);
  assert.deepEqual(data.measure.moves, MEASURE.moves);
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
  assert.equal(r.steps[1].to_s, 128.5);
  close(renderedLength(r.steps), 50 + 68.5 - 0.03);
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
  assert.deepEqual(s.rows[0], { section: "Cold open", targetS: 6, landsS: null, missS: null });
  assert.equal(s.rows[1].section, "The harbour");
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
});
