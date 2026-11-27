import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAUSE_S, norm, lineWords, addMark, setSize, moveMark, removeMark,
  markState, toUnpaused, buildPauses, marksSig, takeSig,
} from "../js/pacing.js";

const W = (word, start, end, sentence = "02.1") => ({ word, start, end, sentence });
const TR = {
  sentences: [{ sentence: "02.1", text: "Pictish village in Orkney Pictish he", start: 0, end: 3 }],
  words: [
    W("Pictish", 0.0, 0.5), W("village", 0.6, 1.0), W("in", 1.1, 1.2),
    W("Orkney,", 1.3, 1.8), W("Pictish", 1.9, 2.3), W("he", 2.52, 2.9),
  ],
};
const mk = (key, word, nth, size = "medium", extra = {}) => ({ key, word, nth, size, by: "claude", ...extra });
const pacingOf = (pauses, id = "02.1") => ({ lines: { [id]: { pauses } } });

test("norm keeps lowercase letters, digits and apostrophes", () => {
  assert.equal(norm("Orkney,"), "orkney");
  assert.equal(norm("Don't!"), "don't");
});

test("lineWords counts occurrences", () => {
  const w = lineWords(TR, "02.1");
  assert.equal(w.length, 6);
  assert.equal(w[0].nth, 1);
  assert.equal(w[4].nth, 2);
  assert.equal(w[4].i, 4);
  assert.deepEqual(lineWords(TR, "09.9"), []);
});

test("toUnpaused removes inserted silence before a position", () => {
  assert.equal(toUnpaused(3.0, [{ at_s: 1.0, add_s: 0.6 }]), 2.4);
  assert.equal(toUnpaused(0.8, [{ at_s: 1.0, add_s: 0.6 }]), 0.8);
  assert.equal(toUnpaused(5.0, [{ at_s: 1.0, add_s: 0.6 }, { at_s: 2.0, add_s: 0.4 }]), 4.0);
  assert.equal(toUnpaused(2.0, undefined), 2.0);
});

test("buildPauses places the second Pictish", () => {
  const { file, skipped } = buildPauses(pacingOf([mk("pictish#2", "Pictish", 2)]), TR, {}, {});
  assert.deepEqual(file.inside["02.1"], [{ at_s: 2.41, add_s: 0.6 }]);
  assert.deepEqual(skipped, []);
});

test("buildPauses undoes pauses applied last time", () => {
  const { file } = buildPauses(pacingOf([mk("pictish#2", "Pictish", 2)]), TR, { "02.1": [{ at_s: 1.0, add_s: 0.6 }] }, {});
  assert.deepEqual(file.inside["02.1"], [{ at_s: 1.81, add_s: 0.6 }]);
});

test("gap mark", () => {
  const { file } = buildPauses(pacingOf([mk("end", null, null, "short")]), TR, {}, {});
  assert.equal(file.after["02.1"], 0.3);
  assert.deepEqual(file.inside, {});
  assert.equal(PAUSE_S.long, 1.0);
});

test("not found", () => {
  const { file, skipped } = buildPauses(pacingOf([mk("pictish#3", "Pictish", 3)]), TR, {}, {});
  assert.deepEqual(skipped, [{ id: "02.1", key: "pictish#3", reason: "not-found" }]);
  assert.deepEqual(file.inside, {});
});

test("take changed skips inside marks but not gap marks", () => {
  const p = pacingOf([mk("pictish#2", "Pictish", 2, "medium", { take: "a" }), mk("end", null, null, "long", { take: "a" })]);
  const { file, skipped } = buildPauses(p, TR, {}, { "02.1": "b" });
  assert.deepEqual(skipped, [{ id: "02.1", key: "pictish#2", reason: "take-changed" }]);
  assert.equal(file.after["02.1"], 1.0);
  assert.deepEqual(file.inside, {});
});

test("silent line: inside not-found, gap sent", () => {
  const p = pacingOf([mk("hello#1", "hello", 1), mk("end", null, null)], "09.9");
  const { file, skipped } = buildPauses(p, TR, {}, {});
  assert.deepEqual(skipped, [{ id: "09.9", key: "hello#1", reason: "not-found" }]);
  assert.equal(file.after["09.9"], 0.6);
});

test("addMark after the last word becomes the gap mark", () => {
  const words = lineWords(TR, "02.1");
  const l = addMark({ pauses: [] }, { after: true, word: "he", nth: 1, words, by: "jon" });
  assert.equal(l.pauses[0].key, "end");
  const l2 = addMark({ pauses: [] }, { after: "end", by: "jon" });
  assert.equal(l2.pauses[0].key, "end");
  const l3 = addMark({}, { after: true, word: "Pictish", nth: 2, words });
  assert.equal(l3.pauses[0].key, "pictish#2");
  assert.equal(l3.pauses[0].size, "medium");
});

test("merge keeps the larger size and Jon", () => {
  let l = addMark({ pauses: [] }, { after: true, word: "village", nth: 1, size: "medium", by: "claude" });
  l = addMark(l, { after: true, word: "village", nth: 1, size: "long", by: "jon" });
  assert.equal(l.pauses.length, 1);
  assert.equal(l.pauses[0].size, "long");
  assert.equal(l.pauses[0].by, "jon");
  l = addMark(l, { after: true, word: "village", nth: 1, size: "short", by: "claude" });
  assert.equal(l.pauses[0].size, "long");
  assert.equal(l.pauses[0].by, "jon");
});

test("setSize, removeMark and moveMark return new lines", () => {
  const words = lineWords(TR, "02.1");
  const l0 = { note: "x", pauses: [mk("in#1", "in", 1)] };
  const l1 = setSize(l0, "in#1", "long");
  assert.equal(l1.pauses[0].size, "long");
  assert.equal(l0.pauses[0].size, "medium");
  assert.deepEqual(removeMark(l1, "in#1").pauses, []);
  const l2 = moveMark(l0, "in#1", 1, words);
  assert.equal(l2.pauses[0].key, "orkney#1");
  const l3 = moveMark(l0, "in#1", -1, words);
  assert.equal(l3.pauses[0].key, "village#1");
  assert.equal(l3.note, "x");
  const last = moveMark({ pauses: [mk("pictish#2", "Pictish", 2)] }, "pictish#2", 1, words);
  assert.equal(last.pauses[0].key, "end");
  const back = moveMark({ pauses: [mk("end", null, null)] }, "end", -1, words);
  assert.equal(back.pauses[0].key, "pictish#2");
  const stay = moveMark({ pauses: [mk("end", null, null)] }, "end", 1, words);
  assert.equal(stay.pauses[0].key, "end");
});

test("markState", () => {
  const words = lineWords(TR, "02.1");
  assert.equal(markState(mk("end", null, null, "medium", { take: "a" }), words, {}, "b"), "ok");
  assert.equal(markState(mk("pictish#2", "Pictish", 2), words, {}, null), "ok");
  assert.equal(markState(mk("pictish#3", "Pictish", 3), words, {}, null), "not-found");
  assert.equal(markState(mk("pictish#2", "Pictish", 2, "medium", { take: "a" }), words, {}, "b"), "take-changed");
});

test("takeSig", () => {
  assert.equal(takeSig({ file: "S:\\film\\02.1.wav", takeS: 100 }), "02.1.wav|100");
  assert.equal(takeSig({ file: "a/b/c.wav", takeS: 7 }), "c.wav|7");
  assert.equal(takeSig({ id: "02.1" }), null);
});

test("marksSig ignores notes and skipped marks; changes with size", () => {
  const base = { lines: { "02.1": { note: "n", pauses: [mk("in#1", "in", 1, "medium", { take: "a" }), mk("end", null, null, "short", { take: "z" })] } } };
  const sigs = { "02.1": "a" };
  const s1 = marksSig(base, sigs);
  const noted = { lines: { "02.1": { ...base.lines["02.1"], note: "different" } } };
  assert.equal(marksSig(noted, sigs), s1);
  assert.notEqual(marksSig(base, { "02.1": "b" }), s1);
  const bigger = { lines: { "02.1": { pauses: [mk("in#1", "in", 1, "long", { take: "a" }), mk("end", null, null, "short")] } } };
  assert.notEqual(marksSig(bigger, sigs), s1);
  const staleIn = { lines: { "02.1": { pauses: [mk("in#1", "in", 1, "medium", { take: "old" }), mk("end", null, null, "short")] } } };
  const gapOnly = { lines: { "02.1": { pauses: [mk("end", null, null, "short")] } } };
  assert.equal(marksSig(staleIn, sigs), marksSig(gapOnly, sigs));
});
