import { test } from "node:test";
import assert from "node:assert/strict";
import { clipList, words, NUMBER_WORDS, sameWords, scriptStats, scriptWarnings, mmss } from "../js/part1script.js";

const w = (n) => Array.from({ length: n }, () => "word").join(" ");
const clip = (n) => ({ narration: w(n), spoken: w(n), cue: "", delivery: null, pronunciations: [] });
const SCRIPT = { title: "T", sections: [{ name: "A", clips: [clip(10), clip(20)] }, { name: "B", clips: [clip(30)] }] };
const SETTINGS = { titleHoldS: 6, endCardS: 12 };

test("words lower-cases, splits hyphens, keeps inner apostrophes and digit tokens", () => {
  assert.deepEqual(words("Kilda's \"Eighty-six\" £4.7 billion, 86% in the 1850s (19th)."),
    ["kilda's", "eighty", "six", "4.7", "billion", "86", "in", "the", "1850s", "19th"]);
  assert.deepEqual(words("  one — two  "), ["one", "two"]);
});

test("NUMBER_WORDS covers the families", () => {
  for (const t of ["zero", "nineteen", "ninety", "hundred", "trillion", "twentieth", "ninetieth", "millionth", "fifties", "tens", "point", "oh", "pence", "degrees"]) {
    assert.ok(NUMBER_WORDS.has(t), t);
  }
});

test("sameWords accepts numbers that differ only in form", () => {
  for (const [a, b] of [
    ["It cost £4.7 billion.", "It cost four point seven billion pounds."],
    ["In the 1850s it grew.", "In the eighteen fifties it grew."],
    ["The 19th century.", "The nineteenth century."],
    ["86% agreed.", "Eighty-six percent agreed."],
  ]) assert.deepEqual(sameWords(a, b), { ok: true, diff: null }, a);
});

test("sameWords names the first changed word", () => {
  assert.deepEqual(sameWords("The tunnel ran east.", "The tunnel ran west."), { ok: false, diff: "east vs west" });
});

test("clipList numbers across sections", () => {
  const l = clipList(SCRIPT);
  assert.deepEqual(l.map((c) => [c.n, c.sectionIndex]), [[1, 0], [2, 0], [3, 1]]);
});

test("scriptStats timing", () => {
  const s = scriptStats(SCRIPT, SETTINGS);
  assert.equal(s.clips, 3);
  assert.equal(s.sections, 2);
  assert.equal(s.words, 60);
  assert.equal(s.spokenWords, 60);
  assert.deepEqual(s.clipWords, [10, 20, 30]);
  assert.ok(Math.abs(s.rawS - 43.8) < 1e-9);
  assert.ok(Math.abs(s.expectedS - 43.8 * 0.965) < 1e-9);
  assert.ok(Math.abs(s.sectionTimes[1].startS - 19.8) < 1e-9);
  assert.ok(Math.abs(s.sectionTimes[0].endS - 12.6) < 1e-9);
  assert.ok(Math.abs(s.sectionTimes[1].endS - 31.8) < 1e-9);
});

test("scriptWarnings texts", () => {
  const s = scriptStats(SCRIPT, SETTINGS);
  const ws = scriptWarnings(s, "6:00–6:30");
  assert.ok(ws.includes("Clips: 3 (aim for 26–29)."));
  assert.ok(ws.includes("Words: 60 (aim for 825–925)."));
  assert.ok(ws.includes("Sections: 2 (aim for 6–8)."));
  assert.ok(ws.includes("Estimated 0:44, outside 6:00–6:30."));
  assert.ok(!ws.some((x) => x.startsWith("Clip 01")));
  assert.ok(scriptWarnings(s, "6:00-6:30").some((x) => x.startsWith("Estimated")));
  assert.ok(!scriptWarnings(s, "about six").some((x) => x.startsWith("Estimated")));
  const short = scriptStats({ sections: [{ clips: [clip(4), clip(51)] }] }, SETTINGS);
  const sw = scriptWarnings(short, "");
  assert.ok(sw.includes("Clip 01 is 4 words (5–50)."));
  assert.ok(sw.includes("Clip 02 is 51 words (5–50)."));
});

test("mmss", () => assert.equal(mmss(381), "6:21"));
