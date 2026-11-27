import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAUSE_S, norm, lineWords, addMark, setSize, moveMark, removeMark,
  markState, toUnpaused, buildPauses, marksSig, takeSig,
  notesToPlace, placeFromNotes,
} from "../js/pacing.js";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";

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

test("toUnpaused inside a pause right after another one lands on that pause's start", () => {
  // pauses 0.15 s apart: the second one sits at 0.975 + 0.6 in the paused audio
  assert.equal(toUnpaused(1.875, [{ at_s: 0.825, add_s: 0.6 }, { at_s: 0.975, add_s: 0.6 }]), 0.975);
  assert.equal(toUnpaused(1.6, [{ at_s: 0.825, add_s: 0.6 }, { at_s: 0.975, add_s: 0.6 }]), 0.975);
});

test("buildPauses leaves out the inside marks of lines it is told to skip, keeps their gap marks", () => {
  const p = pacingOf([mk("pictish#2", "Pictish", 2), mk("end", null, null, "short")]);
  const { file, skipped } = buildPauses(p, TR, {}, {}, { skipInside: new Set(["02.1"]) });
  assert.deepEqual(file.inside, {});
  assert.deepEqual(file.after, { "02.1": 0.3 });
  assert.deepEqual(skipped, [{ id: "02.1", key: "pictish#2", reason: "new-take" }]);
  assert.equal(marksSig(p, {}, { skipInside: new Set(["02.1"]) }), marksSig(pacingOf([mk("end", null, null, "short")]), {}));
});

test("toUnpaused inside an inserted pause lands on its start", () => {
  assert.equal(toUnpaused(2.71, [{ at_s: 2.41, add_s: 0.6 }]), 2.41);
});

test("a mark with no stored take is never take-changed", () => {
  const words = lineWords(TR, "02.1");
  assert.equal(markState(mk("in#1", "in", 1), words, {}, "b"), "ok");
  const p = pacingOf([mk("in#1", "in", 1)]);
  assert.equal(marksSig(p, { "02.1": "b" }), marksSig(p, { "02.1": "c" }));
  assert.equal(buildPauses(p, TR, {}, { "02.1": "b" }).skipped.length, 0);
});

test("addMark without a word is ignored", () => {
  const l = { pauses: [] };
  assert.equal(addMark(l, { after: true, by: "jon" }), l);
});

test("an inside mark on the last word is sent as the gap, keeping the larger", () => {
  let r = buildPauses(pacingOf([mk("he#1", "he", 1, "long")]), TR, {}, {});
  assert.equal(r.file.after["02.1"], 1.0);
  assert.deepEqual(r.file.inside, {});
  r = buildPauses(pacingOf([mk("he#1", "he", 1, "short"), mk("end", null, null, "medium")]), TR, {}, {});
  assert.equal(r.file.after["02.1"], 0.6);
  r = buildPauses(pacingOf([mk("end", null, null, "short"), mk("he#1", "he", 1, "medium")]), TR, {}, {});
  assert.equal(r.file.after["02.1"], 0.6);
});

// --- placeFromNotes ---
const DIR = "S:\\Youtube video ideas\\Film A";
const SCRIPT = { lines: [
  { id: "01.1", section: "Intro", text: "First line." },
  { id: "02.1", section: "Body", text: "Pictish village in Orkney, Pictish he" },
  { id: "02.2", section: "Body", text: "Last line." },
] };
async function pSetup(lines) {
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  const store = await openFilm(host, DIR);
  await store.update((s) => { s.mix = { pacing: { lines } }; });
  return { host, store };
}
const jonMark = { key: "village#1", word: "village", nth: 1, size: "short", by: "jon", take: null };

test("notesToPlace picks lines with a note newer than placedAt", () => {
  const p = { lines: {
    a: { note: "x", noteAt: 5 }, b: { note: "x", noteAt: 5, placedAt: 5 },
    c: { note: "", noteAt: 9 }, d: { note: "y", noteAt: 9, placedAt: 4 },
  } };
  assert.deepEqual(notesToPlace(p), ["a", "d"]);
});

test("placeFromNotes places a Claude mark, keeps Jon's, sends only new notes", async () => {
  const { host, store } = await pSetup({
    "02.1": { note: "pause after the second Pictish", noteAt: 10, pauses: [jonMark, { key: "old#1", word: "old", nth: 1, size: "long", by: "claude", take: null }] },
    "02.2": { note: "old", noteAt: 3, placedAt: 4 },
  });
  let sent;
  host.claudeScript((kind, input) => {
    sent = JSON.parse(input.split("DATA (JSON):\n")[1].split("\n\nAnswer")[0]);
    return [{ id: "02.1", pauses: [{ after: 4, size: "medium" }] }];
  });
  const r = await placeFromNotes(host, store, { transcript: TR, lineScript: SCRIPT, takeSigs: { "02.1": "a.wav|3" } });
  assert.deepEqual(r, { placed: ["02.1"], replies: [] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "02.1");
  assert.equal(sent[0].before, "First line.");
  assert.equal(sent[0].after, "Last line.");
  assert.equal(sent[0].words[4].word, "Pictish");
  const line = store.state.mix.pacing.lines["02.1"];
  assert.deepEqual(line.pauses.map((m) => m.key).sort(), ["pictish#2", "village#1"]);
  const m = line.pauses.find((x) => x.key === "pictish#2");
  assert.equal(m.by, "claude");
  assert.equal(m.take, "a.wav|3");
  assert.equal(line.reply, null);
  assert.ok(line.placedAt >= 0);
});

test("placeFromNotes stores a reply and leaves marks", async () => {
  const { host, store } = await pSetup({ "02.1": { note: "slower please", noteAt: 10, pauses: [jonMark] } });
  host.claudeScript(() => [{ id: "02.1", reply: "This sounds like a delivery change: tick Re-record" }]);
  const r = await placeFromNotes(host, store, { transcript: TR, lineScript: SCRIPT });
  assert.deepEqual(r, { placed: [], replies: ["02.1"] });
  const line = store.state.mix.pacing.lines["02.1"];
  assert.match(line.reply, /Re-record/);
  assert.deepEqual(line.pauses, [jonMark]);
});

test("placeFromNotes rejects bad answers and writes nothing", async () => {
  for (const bad of [
    [{ id: "02.1", pauses: [{ after: 9, size: "medium" }] }],
    [{ id: "02.1", pauses: [{ after: 1.5, size: "medium" }] }],
    [{ id: "02.1", pauses: [{ after: 2, size: "huge" }] }],
    [{ id: "09.9", reply: "x" }],
    [{ id: "02.1" }],
  ]) {
    const { host, store } = await pSetup({ "02.1": { note: "n", noteAt: 10 } });
    host.claudeScript(() => bad);
    await assert.rejects(placeFromNotes(host, store, { transcript: TR, lineScript: SCRIPT }), (e) => e.code === "invalid");
    assert.equal(store.state.mix.pacing.lines["02.1"].placedAt, undefined);
    assert.equal(store.state.mix.pacing.lines["02.1"].pauses, undefined);
  }
});

test("placeFromNotes with nothing new does not call Claude", async () => {
  const { host, store } = await pSetup({ "02.1": { note: "n", noteAt: 3, placedAt: 4 } });
  host.claudeScript(() => { throw new Error("called"); });
  assert.deepEqual(await placeFromNotes(host, store, { transcript: TR, lineScript: SCRIPT }), { placed: [], replies: [] });
});

test("placeFromNotes tells Jon when Claude leaves a line out", async () => {
  const { host, store } = await pSetup({ "02.1": { note: "n", noteAt: 10 } });
  host.claudeScript(() => []);
  const r = await placeFromNotes(host, store, { transcript: TR, lineScript: SCRIPT });
  assert.deepEqual(r, { placed: [], replies: [] });
  const line = store.state.mix.pacing.lines["02.1"];
  assert.equal(line.reply, "Claude didn't place a pause for this note. Click the word to place one.");
  assert.ok(line.placedAt >= 0);
});

test("placeFromNotes skips a Claude mark on Jon's key and places an end mark", async () => {
  const { host, store } = await pSetup({ "02.1": { note: "n", noteAt: 10, pauses: [{ ...jonMark, size: "short" }] } });
  host.claudeScript(() => [{ id: "02.1", pauses: [{ after: 1, size: "long" }, { after: "end", size: "long" }] }]);
  await placeFromNotes(host, store, { transcript: TR, lineScript: SCRIPT, takeSigs: { "02.1": "t" } });
  const ps = store.state.mix.pacing.lines["02.1"].pauses;
  assert.deepEqual(ps.find((m) => m.key === "village#1"), { ...jonMark, size: "short" });
  const end = ps.find((m) => m.key === "end");
  assert.equal(end.by, "claude");
  assert.equal(end.size, "long");
  assert.equal(end.take, "t");
  assert.equal(ps.length, 2);
});

// ---- Re-record ----
import { withRerecord, rerecordsToClear } from "../js/pacing.js";

const rrNar = () => ({
  project: "p",
  rows: [
    { id: "01.1", text: "a", status: "ok", flags: [], notes: [], file: "a.wav", takeS: 100 },
    { id: "01.2", text: "b", status: "flagged", flags: ["x"], notes: [], file: "b.wav", takeS: 100 },
    { id: "01.3", text: "c", status: "missing", flags: [], notes: [] },
  ],
  counts: { total: 3, recorded: 2, ok: 1, flagged: 1, jon: 0, unchecked: 0 },
});

test("withRerecord marks a line whose tick is newer than its take, with the note as the reason", () => {
  const n = rrNar();
  const out = withRerecord(n, { lines: { "01.1": { rerecord: { at: 100500 }, note: "too fast" }, "01.3": { rerecord: { at: 5 } } } });
  assert.equal(out.rows[0].status, "rerecord");
  assert.equal(out.rows[0].checkedStatus, "ok");
  assert.deepEqual(out.rows[0].flags, ["too fast"]);
  assert.equal(out.rows[2].status, "missing");
  assert.deepEqual(out.rows[2].flags, []);
  assert.equal(out.rows[1].status, "flagged");
  assert.equal(out.counts.rerecord, 1);
  assert.equal(n.rows[0].status, "ok");
  assert.equal(n.counts.rerecord, undefined);
});

test("withRerecord leaves a line alone when the take is newer than the tick, and rerecordsToClear returns it", () => {
  const p = { lines: { "01.1": { rerecord: { at: 99000 } }, "01.2": { rerecord: { at: 100500 } }, "01.3": { rerecord: null } } };
  const out = withRerecord(rrNar(), p);
  assert.equal(out.rows[0].status, "ok");
  assert.equal(out.counts.rerecord, 1);
  assert.deepEqual(rerecordsToClear(rrNar(), p), ["01.1"]);
});

test("withRerecord passes through null, missingScript and no pacing", () => {
  assert.equal(withRerecord(null, {}), null);
  const m = { missingScript: true };
  assert.equal(withRerecord(m, { lines: {} }), m);
  assert.equal(withRerecord(rrNar(), undefined).counts.rerecord, 0);
  assert.deepEqual(rerecordsToClear(null, {}), []);
});

test("alignScript: exact words anchor; unheard words point back; nothing before the first anchor → null", async () => {
  const { alignScript } = await import("../js/pacing.js");
  const ws = (...a) => a.map((word) => ({ word }));
  assert.deepEqual(alignScript("Hello there world", ws("hello", "world")).map((x) => x.i), [0, 0, 1]);
  assert.deepEqual(alignScript("Oh hello", ws("hello")).map((x) => x.i), [null, 0]);
  assert.deepEqual(alignScript("", ws("a")), []);
});
