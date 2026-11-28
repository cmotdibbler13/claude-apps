import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { ClaudeError } from "../js/claude.js";
import {
  writeClips, writeLists, redoClip, BRIEF_TOO_BIG,
  CLIPS_INSTRUCTIONS, LISTS_INSTRUCTIONS, CLIP_INSTRUCTIONS,
} from "../js/part1claude.js";

const host = (...replies) => {
  const h = new FakeHost();
  h.seen = [];
  h.claudeScript((kind, input, opts) => {
    h.seen.push({ kind, input, opts });
    const r = replies[Math.min(h.seen.length - 1, replies.length - 1)];
    return typeof r === "function" ? r(input) : structuredClone(r);
  });
  return h;
};
const dataOf = (seen) => JSON.parse(seen.input.split("DATA (JSON):\n")[1].split("\n\nAnswer with JSON only.")[0]);

const clip = (narration, spoken = narration, extra = {}) => ({ narration, spoken, cue: "Line art draws on in amber.", delivery: null, pronunciations: [], ...extra });
const goodClips = () => ({
  title: "The Shipping Forecast",
  buildLine: "Remotion motion graphics; b-roll from Higgsfield.",
  key: { graphics: [{ name: "MAP", what: "the sea areas" }], extra: null },
  sections: [
    { name: "Cold open", clips: [
      clip("In 1859 a storm sank the Royal Charter.", "In eighteen fifty-nine a storm sank the Royal Charter.", { delivery: "quietly" }),
      clip("It began with a shipwreck."),
    ] },
    { name: "The admiral", clips: [
      clip("Robert FitzRoy drew the first chart.", "Robert FitzRoy drew the first chart.", { pronunciations: [{ name: "FitzRoy", say: "Fits-roy" }] }),
    ] },
  ],
});
const input = { brief: "A brief about the forecast.", reference: "REFERENCE SCRIPT TEXT", pronunciations: "Tems = \"Tems\"", setup: { topic: "The Shipping Forecast", prefix: "shipping", episode: "008", runtimeTarget: "6:00–6:45" } };

const notes = () => ({ corrections: [], myths: [], softer: [], conflicts: [], timeSensitive: [], leftOut: [], filmYourself: [], pronunciationTests: [], cutOrder: [] });
const goodLists = () => ({
  shots: [{ id: "HF-01", usedIn: [1, 3], prompt: "A storm at sea, 1850s sailing ship, no modern ships." }],
  sfx: [{ cue: "Wind", clip: 1, idea: "Low wind over open water." }],
  music: "Slow strings.",
  archive: [{ item: "Engraving of the wreck", licence: "Public domain", credit: "Illustrated London News, 1859" }],
  notes: notes(),
});

test("writeClips returns a valid reply, sends the data, tier default", async () => {
  const h = host(goodClips());
  const r = await writeClips(h, input);
  assert.deepEqual(r, goodClips());
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0].opts.tier, "default");
  assert.ok(h.seen[0].input.startsWith(CLIPS_INSTRUCTIONS));
  const d = dataOf(h.seen[0]);
  assert.equal(d.brief, input.brief);
  assert.equal(d.reference, input.reference);
  assert.equal(d.pronunciations, input.pronunciations);
  assert.deepEqual(d.setup, input.setup);
  assert.equal("previousError" in d, false);
});

test("writeClips revise sends the note and the current draft", async () => {
  const h = host(goodClips());
  await writeClips(h, { ...input, note: "Shorter cold open.", current: goodClips() });
  const d = dataOf(h.seen[0]);
  assert.equal(d.note, "Shorter cold open.");
  assert.deepEqual(d.current.sections[0].name, "Cold open");
});

test("writeClips retries once with the error and no cache after a narration/spoken mismatch", async () => {
  const bad = goodClips();
  bad.sections[1].clips[0].spoken = "Robert Fitzwilliam drew the first chart.";
  const h = host(bad, goodClips());
  const r = await writeClips(h, input);
  assert.deepEqual(r, goodClips());
  assert.equal(h.seen.length, 2);
  const d2 = dataOf(h.seen[1]);
  assert.match(d2.previousError, /^Clip 03: fitzroy vs fitzwilliam/);
  assert.equal(h.seen[1].opts.cache, false);
  assert.equal("cache" in h.seen[0].opts, false);
});

test("writeClips rejects invalid after two bad replies", async () => {
  const bad = goodClips();
  bad.sections[0].clips[1].narration = "";
  const h = host(bad);
  await assert.rejects(writeClips(h, input), (e) => e instanceof ClaudeError && e.code === "invalid" && /Clip 02/.test(e.message));
  assert.equal(h.seen.length, 2);
});

test("writeClips refuses bad shapes", async () => {
  const cases = [
    (v) => { v.sections = []; },
    (v) => { delete v.title; },
    (v) => { v.sections[0].clips[0].delivery = 3; },
    (v) => { v.sections[0].clips[0].pronunciations = [{ name: "X" }]; },
    (v) => { delete v.sections[0].clips[0].cue; },
    (v) => { v.sections[1].clips = []; },
    (v) => { v.key = null; },
  ];
  for (const change of cases) {
    const v = goodClips();
    change(v);
    await assert.rejects(writeClips(host(v), input), (e) => e.code === "invalid");
  }
});

test("other errors are not retried", async () => {
  const h = host(() => { throw { code: "rate_limited", message: "slow" }; });
  await assert.rejects(writeClips(h, input), (e) => e.code === "rate_limited");
  assert.equal(h.seen.length, 1);
});

test("a brief over the limit is refused before any call", async () => {
  const h = host(goodClips());
  const brief = "x".repeat(400001);
  await assert.rejects(writeClips(h, { ...input, brief }), (e) => e instanceof ClaudeError && e.code === "too_big"
    && e.message === "The brief is too long for Studio to send (400001 characters, 400000 at most).");
  await assert.rejects(writeLists(h, { brief, setup: input.setup, sections: goodClips().sections }), (e) => e.code === "too_big");
  await assert.rejects(redoClip(h, { brief, setup: input.setup, script: goodClips(), n: 1, note: "x" }), (e) => e.code === "too_big");
  assert.equal(h.seen.length, 0);
  assert.equal(BRIEF_TOO_BIG, "The brief is too long for Studio to send (<n> characters, <max> at most).");
});

test("the runtime's limit is used when it reports a number", async () => {
  const h = host(goodClips());
  h.limitsScript(() => ({ maxInputChars: 100 }));
  await assert.rejects(writeClips(h, { ...input, brief: "y".repeat(101) }), (e) => e.code === "too_big" && /101 characters, 100 at most/.test(e.message));
  h.limitsScript(() => ({ maxInputChars: "lots" }));
  assert.ok(await writeClips(h, { ...input, brief: "y".repeat(1000) }));
});

test("writeLists returns the lists and sends numbered clips", async () => {
  const h = host(goodLists());
  const r = await writeLists(h, { brief: input.brief, setup: input.setup, sections: goodClips().sections });
  assert.deepEqual(r, goodLists());
  assert.ok(h.seen[0].input.startsWith(LISTS_INSTRUCTIONS));
  const d = dataOf(h.seen[0]);
  assert.equal(d.brief, input.brief);
  assert.deepEqual(d.clips.map((c) => c.n), [1, 2, 3]);
  assert.equal(d.clips[2].section, "The admiral");
  assert.equal(d.clips[0].narration, "In 1859 a storm sank the Royal Charter.");
});

test("writeLists refuses a shot using clip 99, bad ids, bad sfx clips and missing notes", async () => {
  const cases = [
    (v) => { v.shots[0].usedIn = [1, 99]; },
    (v) => { v.shots[0].id = "HF-1"; },
    (v) => { v.shots.push({ ...v.shots[0] }); },
    (v) => { v.sfx[0].clip = 4; },
    (v) => { delete v.notes.cutOrder; },
    (v) => { v.notes.myths = [3]; },
  ];
  for (const change of cases) {
    const v = goodLists();
    change(v);
    const h = host(v);
    await assert.rejects(writeLists(h, { brief: "b", setup: input.setup, sections: goodClips().sections }), (e) => e.code === "invalid");
    assert.equal(h.seen.length, 2);
  }
  const v = goodLists();
  v.shots[0].usedIn = [99];
  await assert.rejects(writeLists(host(v), { brief: "b", setup: input.setup, sections: goodClips().sections }), (e) => /99/.test(e.message));
});

test("redoClip sends the note, the clip number and the other clips, not the reference", async () => {
  const reply = clip("It all began with a shipwreck.");
  const h = host(reply);
  const r = await redoClip(h, { brief: input.brief, setup: input.setup, script: goodClips(), n: 2, note: "Make it land harder." });
  assert.deepEqual(r, reply);
  assert.ok(h.seen[0].input.startsWith(CLIP_INSTRUCTIONS));
  const text = h.seen[0].input;
  assert.ok(text.includes("Make it land harder."));
  assert.ok(text.includes("Robert FitzRoy drew the first chart."));
  assert.ok(text.includes("In 1859 a storm sank the Royal Charter."));
  assert.ok(!text.includes(input.reference));
  const d = dataOf(h.seen[0]);
  assert.equal(d.n, 2);
  assert.equal(d.brief, input.brief);
});

test("redoClip carries the pronunciations file text and the script's list; later entries win", async () => {
  const h = host(clip("It all began with a shipwreck."));
  const script = { ...goodClips(), pronunciations: [{ name: "FitzRoy", say: "Fits-roy" }] };
  await redoClip(h, { brief: "b", setup: input.setup, script, n: 2, note: "x", approvedPronunciations: 'Scapa = "SKAP-uh"' });
  const d = dataOf(h.seen[0]);
  assert.equal(d.approvedPronunciations, 'Scapa = "SKAP-uh"');
  assert.deepEqual(d.pronunciations, [{ name: "FitzRoy", say: "Fits-roy" }]);
  assert.match(CLIP_INSTRUCTIONS, /pronunciations: the pronunciations already in the script/);
  assert.doesNotMatch(CLIP_INSTRUCTIONS, /approved pronunciations already in the script/);
  for (const t of [CLIPS_INSTRUCTIONS, CLIP_INSTRUCTIONS]) assert.match(t, /When a name appears more than once, the later entry wins\./);
  const none = host(clip("It all began with a shipwreck."));
  await redoClip(none, { brief: "b", setup: input.setup, script: goodClips(), n: 2, note: "x" });
  assert.equal(dataOf(none.seen[0]).approvedPronunciations, null);
});

test("redoClip validates the clip like any clip and retries once", async () => {
  const h = host(clip("Robert FitzRoy drew it.", "Robert drew it."), clip("Robert FitzRoy drew it."));
  const r = await redoClip(h, { brief: "b", setup: input.setup, script: goodClips(), n: 3, note: "Shorter." });
  assert.equal(r.narration, "Robert FitzRoy drew it.");
  assert.match(dataOf(h.seen[1]).previousError, /^Clip 03: /);
  assert.equal(h.seen[1].opts.cache, false);
  await assert.rejects(redoClip(host({ narration: "x" }), { brief: "b", setup: input.setup, script: goodClips(), n: 1, note: "n" }), (e) => e.code === "invalid");
});

test("instructions carry the house rules and the reply shapes", () => {
  for (const s of [CLIPS_INSTRUCTIONS, CLIP_INSTRUCTIONS]) {
    for (const want of ["Inter", "no italics", "spelled out", "SIX MINUTES ON…", "sixminuteson.com", "British English"]) {
      assert.ok(s.includes(want), `missing ${want}`);
    }
  }
  assert.match(CLIPS_INSTRUCTIONS, /format and tone only/);
  assert.match(CLIPS_INSTRUCTIONS, /825/);
  for (const want of ["#0a1b30", "#e3a64a", "no skyscrapers", "a single man", "public-domain", "pronunciationTests", "cutOrder"]) {
    assert.ok(LISTS_INSTRUCTIONS.toLowerCase().includes(want.toLowerCase()), `lists missing ${want}`);
  }
  for (const s of [CLIPS_INSTRUCTIONS, LISTS_INSTRUCTIONS, CLIP_INSTRUCTIONS]) {
    assert.match(s, /Reply with JSON only: \{.*\}\.?$/s);
    assert.match(s, /previousError/);
  }
});
