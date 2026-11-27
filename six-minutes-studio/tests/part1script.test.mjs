import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSentences, scriptLines, lineScriptText, clipList, words, NUMBER_WORDS, sameWords, scriptStats, scriptWarnings, mmss } from "../js/part1script.js";
import { parseLineScript } from "../js/narration.js";

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

test("splitSentences joins short sentences and respects abbreviations", () => {
  assert.deepEqual(splitSentences("Kenwyn. Do not demolish. The house stood empty."), ["Kenwyn. Do not demolish.", "The house stood empty."]);
  assert.deepEqual(splitSentences("It was cold that winter. Nobody came."), ["It was cold that winter. Nobody came."]);
  assert.deepEqual(splitSentences("Dr Snow mapped it. J. Bazalgette built it."), ["Dr Snow mapped it.", "J. Bazalgette built it."]);
  assert.deepEqual(splitSentences("Yes. No. Stop. The tide came in over the sands."), ["Yes. No. Stop. The tide came in over the sands."]);
  assert.deepEqual(splitSentences("Why did it fall? \"It fell,\" he said. Nobody knew why."), ["Why did it fall?", "\"It fell,\" he said. Nobody knew why."]);
  assert.deepEqual(splitSentences("One clip only."), ["One clip only."]);
});

const LS = {
  title: "China Clay",
  pronunciations: [{ name: "Kenwyn", say: "KEN-win" }, { name: "Truro", say: "TROO-roh" }],
  sections: [
    { name: "Cold open", clips: [
      { narration: "", spoken: "Kenwyn. Do not demolish. The house stood empty.", cue: "", delivery: null, pronunciations: [] },
      { narration: "", spoken: "It was cold in Truro that winter. Nobody came.", cue: "", delivery: null, pronunciations: [] },
    ] },
    { name: "The pit", clips: [{ narration: "", spoken: "Then the pit closed down.", cue: "", delivery: null, pronunciations: [] }] },
  ],
};

test("scriptLines ids, sections and text", () => {
  assert.deepEqual(scriptLines(LS).map((l) => [l.id, l.clip, l.section, l.sectionIndex]), [
    ["01.1", 1, "1 · COLD OPEN", 0], ["01.2", 1, "1 · COLD OPEN", 0], ["02.1", 2, "1 · COLD OPEN", 0], ["03.1", 3, "2 · THE PIT", 1],
  ]);
});

test("lineScriptText round trips through parseLineScript", () => {
  const text = lineScriptText(LS, { prefix: "china_clay", picks: ["01.2"] });
  assert.equal(text.split("\n")[0], "# China Clay — line-by-line recording script (4 lines)");
  assert.match(text, /\[01\.1\]  \(clip 01\)\n/);
  assert.match(text, /> Kenwyn = "KEN-win"\n/);
  assert.match(text, /> Truro = "TROO-roh"\n/);
  const p = parseLineScript(text);
  const want = scriptLines(LS);
  assert.equal(p.name, "china_clay");
  assert.deepEqual(p.lines.map((l) => [l.id, l.text, l.section]), want.map((l) => [l.id, l.text, l.section]));
  assert.deepEqual(p.lines.filter((l) => l.toCamera).map((l) => l.id), ["01.2"]);
});

test("splitSentences does not end at a lower-case continuation", () => {
  assert.deepEqual(splitSentences("“Why did it fall down the hill?” asked the vicar slowly. Nobody knew why it fell."),
    ["“Why did it fall down the hill?” asked the vicar slowly.", "Nobody knew why it fell."]);
  assert.deepEqual(splitSentences("The works closed down in 1985... and nobody noticed for years."),
    ["The works closed down in 1985... and nobody noticed for years."]);
});

test("splitSentences abbreviation guard with periods", () => {
  for (const t of ["Mr. Smith arrived.", "They lived at No. 10 Downing Street.", "St. Austell grew.", "It cost £4.7 million."]) {
    assert.deepEqual(splitSentences(t), [t], t);
  }
  // "What a sight!" alone is 3 words and would join the next, so use a longer first sentence
  assert.deepEqual(splitSentences("What a sight it was! Everyone came to see it."), ["What a sight it was!", "Everyone came to see it."]);
});

test("lineScriptText emits one note per name per line", () => {
  const s = { ...LS, pronunciations: [{ name: "Kenwyn", say: "KEN-win" }, { name: "Kenwyn", say: "other" }] };
  const text = lineScriptText(s, { prefix: "china_clay" });
  assert.equal(text.split('> Kenwyn = "KEN-win"').length - 1, 1);
  assert.ok(!text.includes('"other"'));
});
