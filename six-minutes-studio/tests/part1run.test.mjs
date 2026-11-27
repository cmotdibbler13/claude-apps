import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { CLIPS_INSTRUCTIONS, LISTS_INSTRUCTIONS, CLIP_INSTRUCTIONS } from "../js/part1claude.js";
import { LINES_INSTRUCTIONS } from "../js/presenter.js";
import { scriptLines } from "../js/part1script.js";
import { writeScript, redoOne, editClip, editLists, restoreDraft, setPicks, currentDraft, part1Busy } from "../js/part1run.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const BRIEF = `${DIR}\\brief.md`;
const REF = "S:\\ref\\reference.md";
const clip = (t, extra = {}) => ({ narration: t, spoken: t, cue: "Line art.", delivery: null, pronunciations: [], ...extra });
const clips = (tag = "A") => ({
  title: "The Forecast", buildLine: "Remotion.", key: { graphics: [], extra: null },
  sections: [
    { name: "Open", clips: [clip(`Storm one ${tag}. It sank the ship.`, { pronunciations: [{ name: "FitzRoy", say: "Fits-roy" }] }), clip(`Second clip ${tag} is here now.`)] },
    { name: "End", clips: [clip("Third clip is here now.", { pronunciations: [{ name: "FitzRoy", say: "other" }] })] },
  ],
});
const lists = () => ({ shots: [], sfx: [], music: null, archive: [], notes: { corrections: [], myths: [], softer: [], conflicts: [], timeSensitive: [], leftOut: [], filmYourself: [], pronunciationTests: [], cutOrder: [] } });

async function setup({ reference = true, suggest = ["01.1", "02.1", "03.1"], fail = null } = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  await host.fs.write(BRIEF, "The brief text.");
  if (reference) { await host.fs.mkdir("S:\\ref"); await host.fs.write(REF, "REFERENCE"); }
  host.seen = [];
  let tag = "A";
  host.claudeScript((kind, input) => {
    host.seen.push(input);
    if (fail && fail(input)) throw new Error("boom");
    if (input.startsWith(CLIPS_INSTRUCTIONS)) return clips(tag);
    if (input.startsWith(LISTS_INSTRUCTIONS)) return lists();
    if (input.startsWith(CLIP_INSTRUCTIONS)) return clip("Second clip shorter here.");
    if (input.startsWith(LINES_INSTRUCTIONS)) {
      if (suggest === null) throw new Error("no lines");
      return { lines: suggest.map((id) => ({ id, why: "good" })) };
    }
    throw new Error("unexpected");
  });
  const store = await openFilm(host, DIR);
  await store.update((s) => {
    s.part1 = { setup: { folder: DIR, brief: BRIEF, topic: "The Forecast", prefix: "forecast", episode: "008", runtime: "6:00–6:45", voice: "own" }, drafts: [], picks: [], pickNotes: [], approvedAt: null };
  });
  const ctx = { host, store, settings: { referenceScripts: ["S:\\none.md", REF], pronunciationsFile: "S:\\p.md" }, root: "S:\\Youtube video ideas" };
  return { host, store, ctx, setTag: (t) => { tag = t; } };
}

test("write: one draft, picks from the suggestion, merged pronunciations", async () => {
  const { ctx, store, host } = await setup();
  const d = await writeScript(ctx);
  assert.equal(store.state.part1.drafts.length, 1);
  assert.equal(d.n, 1);
  assert.equal(d.why, "Written");
  assert.equal(d.at, host.now());
  assert.deepEqual(d.script.pronunciations, [{ name: "FitzRoy", say: "Fits-roy" }]);
  assert.deepEqual(store.state.part1.picks.map((p) => [p.id, p.from]), [["01.1", "claude"], ["02.1", "claude"], ["03.1"].concat("claude")]);
  assert.equal(currentDraft(store.state), store.state.part1.drafts[0]);
  const logs = (await store.readLog()).map((l) => l.text);
  assert.ok(logs.includes("Part 1: writing the script") && logs.includes("Part 1: script written (draft 1)"));
  assert.equal(part1Busy(DIR), false);
});

test("revise with a note: draft 2, clips call holds the note and draft 1", async () => {
  const { ctx, store, host, setTag } = await setup();
  await writeScript(ctx);
  setTag("B");
  host.seen.length = 0;
  const d = await writeScript(ctx, { note: "Make it punchier" });
  assert.equal(d.n, 2);
  assert.equal(d.why, "Revised from your note");
  assert.equal(d.note, "Make it punchier");
  const clipsCall = host.seen.find((i) => i.startsWith(CLIPS_INSTRUCTIONS));
  assert.match(clipsCall, /Make it punchier/);
  assert.match(clipsCall, /Storm one A/);
  assert.equal(store.state.part1.drafts.length, 2);
});

test("redoOne changes only that clip", async () => {
  const { ctx, store } = await setup();
  const d1 = await writeScript(ctx);
  const d2 = await redoOne(ctx, 2, "shorter");
  assert.equal(d2.why, "Clip 02 redone: shorter");
  const a = d1.script.sections, b = d2.script.sections;
  assert.deepEqual(b[0].clips[0], a[0].clips[0]);
  assert.deepEqual(b[1], a[1]);
  assert.notDeepEqual(b[0].clips[1], a[0].clips[1]);
  assert.equal(b[0].clips[1].narration, "Second clip shorter here.");
  assert.equal(store.state.part1.drafts.length, 2);
});

test("edit that changes a picked line drops the pick and adds a note; bad words refused", async () => {
  const { ctx, store } = await setup();
  await writeScript(ctx);
  await assert.rejects(() => editClip(ctx, 1, { narration: "Totally different words here." }), /The reading and spoken words differ: /);
  assert.equal(store.state.part1.drafts.length, 1);
  const d = await editClip(ctx, 1, { narration: "Storm changed A. It sank the ship.", spoken: "Storm changed A. It sank the ship." });
  assert.equal(d.why, "Clip 01 edited");
  assert.deepEqual(store.state.part1.picks.map((p) => p.id), ["02.1", "03.1"]);
  assert.deepEqual(store.state.part1.pickNotes, ["To-camera line 01.1 changed: pick again"]);
});

test("editLists replaces lists; episode alone makes no draft", async () => {
  const { ctx, store } = await setup();
  await writeScript(ctx);
  const shots = [{ id: "HF-01", usedIn: [1], prompt: "p" }];
  const d = await editLists(ctx, { shots, pronunciations: [{ name: "X", say: "ex" }], episode: "009" });
  assert.equal(d.why, "Lists edited");
  assert.deepEqual(d.script.shots, shots);
  assert.deepEqual(d.script.pronunciations, [{ name: "X", say: "ex" }]);
  assert.equal(store.state.part1.setup.episode, "009");
  await editLists(ctx, { episode: "010" });
  assert.equal(store.state.part1.drafts.length, 2);
  assert.equal(store.state.part1.setup.episode, "010");
});

test("restore draft 1 gives draft 3 equal to draft 1's script", async () => {
  const { ctx, store } = await setup();
  const d1 = await writeScript(ctx);
  await redoOne(ctx, 2, "shorter");
  const d3 = await restoreDraft(ctx, 1);
  assert.equal(d3.n, 3);
  assert.equal(d3.why, "Back to draft 1");
  assert.deepEqual(d3.script, d1.script);
});

test("setPicks marks new ids as jon's", async () => {
  const { ctx, store } = await setup();
  await writeScript(ctx);
  await setPicks(ctx, ["01.1"]);
  const picks = await setPicks(ctx, ["01.1", "03.1"]);
  assert.deepEqual(picks.map((p) => [p.id, p.from]), [["01.1", "claude"], ["03.1", "jon"]]);
  assert.equal(picks[1].text, scriptLines(currentDraft(store.state).script).find((l) => l.id === "03.1").text);
  assert.deepEqual(store.state.part1.picks, picks);
});

test("a failed suggestion leaves picks empty with a note", async () => {
  const { ctx, store } = await setup({ suggest: null });
  await writeScript(ctx);
  assert.deepEqual(store.state.part1.picks, []);
  assert.match(store.state.part1.pickNotes[0], /^Couldn't suggest to-camera lines: /);
});

test("second concurrent write is refused", async () => {
  const { ctx, store } = await setup();
  const first = writeScript(ctx);
  await assert.rejects(() => writeScript(ctx), { message: "Wait for Claude to finish." });
  await first;
  assert.equal(store.state.part1.drafts.length, 1);
});

test("a Claude failure leaves drafts unchanged and logs", async () => {
  const { ctx, store } = await setup({ fail: (i) => i.startsWith(LISTS_INSTRUCTIONS) });
  await assert.rejects(() => writeScript(ctx));
  assert.equal(store.state.part1.drafts.length, 0);
  assert.equal(part1Busy(DIR), false);
  assert.ok((await store.readLog()).some((l) => /^Part 1: failed/.test(l.text)));
});

test("no reference script, missing brief", async () => {
  let s = await setup({ reference: false });
  await assert.rejects(() => writeScript(s.ctx), { message: "No reference script found. Set referenceScripts in .studio-settings.json." });
  s = await setup();
  await s.host.fs.trash(BRIEF);
  await assert.rejects(() => writeScript(s.ctx), { message: `Couldn't read the brief: ${BRIEF}` });
});
