import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { makeJobs } from "../js/jobs.js";
import {
  planAudio, addCue, editItem, getEstimate, startAudioTake, rewriteFromNote,
  chooseAudio, approveAudio, unapproveAudio, cueSlug, PLAN_INSTRUCTIONS,
} from "../js/audioplan.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const MEDIA = DIR + "\\studio\\media\\";
const idle = { stableaudio: { lane: "gpu", start: () => new Promise(() => {}) }, elevenlabs: { start: () => new Promise(() => {}) } };
const PLAN = {
  score: { prompt: "Dark ambient strings, 70 bpm. Energy arc: 0:00 hold, 0:06 low pulse", durationS: 412 },
  sfx: [
    { cue: "door creak", prompt: "an old wooden door creaks open", durationS: 3.4, loop: false },
    { cue: "harbour wind", prompt: "steady wind over a harbour", durationS: 20, loop: true },
  ],
};

async function setup(runners = idle) {
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  const store = await openFilm(host, DIR);
  const jobs = makeJobs(host, { runners });
  return { host, store, jobs, ctx: { host, store, jobs } };
}

async function planned(o = {}) {
  const s = await setup(o.runners);
  s.host.claudeScript(() => structuredClone(PLAN));
  await planAudio(s.host, s.store, { scriptText: "one two three", handoverText: "SFX: door creak, harbour wind" });
  return s;
}

// ElevenLabs MCP fake: counts calls by tool.
function eleven(host, { credits = 6149 } = {}) {
  const calls = [];
  let nodes = 0;
  host.mcpScript((server, tool, input) => {
    calls.push({ server, tool, input });
    if (tool === "creative_create_flow") return { flow_id: "F1" };
    if (tool === "creative_add_flow_node") return { node_id: `N${++nodes}` };
    if (tool === "creative_run_flow_nodes") return input.estimate_only ? { credits } : { session_ids: ["S1"] };
    return undefined;
  });
  return calls;
}
const count = (calls, tool) => calls.filter((c) => c.tool === tool).length;

test("cue slug", () => {
  assert.equal(cueSlug("door creak"), "door-creak");
  assert.equal(cueSlug("  Gull's cry -- distant!  "), "gull-s-cry-distant");
  assert.equal(cueSlug("x".repeat(60)).length, 40);
});

test("planAudio writes the plan with SFX ids and Stable Audio by default, and refuses a second time", async () => {
  const s = await setup();
  let seen;
  s.host.claudeScript((kind, input, opts) => { seen = { input, opts }; return structuredClone(PLAN); });
  await planAudio(s.host, s.store, { scriptText: "one two three", handoverText: "SFX list" });
  assert.equal(seen.opts.tier, "default");
  assert.ok(seen.input.startsWith(PLAN_INSTRUCTIONS));
  assert.match(seen.input, /SFX list/);
  const a = s.store.state.audio;
  assert.equal(a.flowId, null);
  assert.deepEqual(a.score, { id: "SCORE", cue: "Score", prompt: PLAN.score.prompt, durationS: 412, takes: [], chosen: null, approved: false, node: null, est: null });
  assert.deepEqual(a.sfx.map((x) => x.id), ["SFX-01", "SFX-02"]);
  assert.deepEqual(a.sfx[0], { id: "SFX-01", cue: "door creak", prompt: PLAN.sfx[0].prompt, durationS: 3, loop: false, source: "stableaudio", lineId: null, startS: null, takes: [], chosen: null, approved: false, node: null, est: null });
  assert.equal(a.sfx[1].loop, true);
  assert.ok((await s.store.readLog()).some((l) => l.text === "Music and sound effects planned (2 cues)"));
  await assert.rejects(() => planAudio(s.host, s.store, { scriptText: "x", handoverText: "y" }), /Music and sound effects are already planned\./);
});

test("planAudio rejects a bad reply and writes nothing", async () => {
  const s = await setup();
  s.host.claudeScript(() => ({ score: { prompt: "p", durationS: 2 }, sfx: [] }));
  await assert.rejects(() => planAudio(s.host, s.store, { scriptText: "x", handoverText: "y" }));
  assert.equal(s.store.state.audio, undefined);
});

test("addCue adds the next SFX id", async () => {
  const s = await planned();
  const id = await addCue(s.store, { cue: "bell", prompt: "a ship's bell", durationS: 2 });
  assert.equal(id, "SFX-03");
  const c = s.store.state.audio.sfx[2];
  assert.equal(c.source, "stableaudio");
  assert.equal(c.loop, false);
  assert.deepEqual(c.takes, []);
});

test("editItem: a prompt change clears the estimate; source must be known", async () => {
  const s = await planned();
  await s.store.update((d) => { d.audio.sfx[0].est = { credits: 10, sig: "x" }; });
  await editItem(s.store, "SFX-01", { source: "elevenlabs" });
  assert.deepEqual(s.store.state.audio.sfx[0].est, { credits: 10, sig: "x" });
  await editItem(s.store, "SFX-01", { prompt: "a squeakier door" });
  assert.equal(s.store.state.audio.sfx[0].prompt, "a squeakier door");
  assert.equal(s.store.state.audio.sfx[0].est, null);
  await assert.rejects(() => editItem(s.store, "SFX-01", { source: "higgsfield" }));
});

test("editItem is refused while a take is busy", async () => {
  const s = await planned();
  await startAudioTake(s.ctx, "SFX-01");
  await assert.rejects(() => editItem(s.store, "SFX-01", { prompt: "x" }), /in progress/);
});

test("Stable Audio take: whole seconds and the film's media path", async () => {
  const s = await planned();
  const ns = await startAudioTake(s.ctx, "SFX-01");
  assert.deepEqual(ns, [1]);
  const [j] = s.jobs.list();
  assert.equal(j.tool, "stableaudio");
  assert.equal(j.assetId, "SFX-01");
  assert.equal(j.take, 1);
  assert.equal(j.what, "SFX-01 door creak take 1");
  assert.equal(j.why, "First take");
  assert.deepEqual(j.input, { prompt: PLAN.sfx[0].prompt, seconds: 3, out: MEDIA + "Film_A_sfx_sfx-01_door-creak_t1.wav" });
  assert.ok(Number.isInteger(j.input.seconds));
  const c = s.store.state.audio.sfx[0];
  assert.equal(c.chosen, 1);
  assert.equal(c.takes[0].status, "queued");
  assert.equal(c.takes[0].source, "stableaudio");
  assert.equal(c.takes[0].jobId, j.id);
  assert.equal(s.store.pending.size, 0);
});

test("ElevenLabs take without a current estimate is refused and adds no job", async () => {
  const s = await planned();
  eleven(s.host);
  await assert.rejects(() => startAudioTake(s.ctx, "SCORE", { count: 2 }), /Get the cost first\./);
  assert.equal(s.jobs.list().length, 0);
  assert.deepEqual(s.store.state.audio.score.takes, []);
});

test("getEstimate reuses the node while the prompt is unchanged and adds one after an edit", async () => {
  const s = await planned();
  const calls = eleven(s.host);
  assert.equal(await getEstimate(s.ctx, "SCORE"), 6149);
  assert.equal(await getEstimate(s.ctx, "SCORE"), 6149);
  assert.equal(count(calls, "creative_create_flow"), 1);
  assert.equal(calls.find((c) => c.tool === "creative_create_flow").input.name, "Film A — score and SFX");
  assert.equal(count(calls, "creative_add_flow_node"), 1);
  const a = s.store.state.audio;
  assert.equal(a.flowId, "F1");
  assert.equal(a.score.node.id, "N1");
  assert.equal(a.score.est.credits, 6149);
  assert.equal(a.score.est.sig, a.score.node.sig);
  assert.ok(calls.every((c) => c.tool !== "creative_run_flow_nodes" || c.input.estimate_only === true));
  await editItem(s.store, "SCORE", { prompt: "brighter strings" });
  await getEstimate(s.ctx, "SCORE");
  assert.equal(count(calls, "creative_create_flow"), 1);
  assert.equal(count(calls, "creative_add_flow_node"), 2);
  assert.equal(s.store.state.audio.score.node.id, "N2");
});

test("score with an estimate: two takes share one node", async () => {
  const s = await planned();
  const calls = eleven(s.host);
  await getEstimate(s.ctx, "SCORE");
  const ns = await startAudioTake(s.ctx, "SCORE", { count: 2 });
  assert.deepEqual(ns, [1, 2]);
  const js = s.jobs.list();
  assert.equal(js.length, 2);
  assert.deepEqual(js.map((j) => j.take), [1, 2]);
  assert.deepEqual(js.map((j) => j.what), ["Score take 1", "Score take 2"]);
  assert.equal(js[0].input.nodeId, "N1");
  assert.equal(js[1].input.nodeId, "N1");
  assert.deepEqual(js[0].input, { kind: "score", flowId: "F1", nodeId: "N1", sfx: false, out: MEDIA + "Film_A_score_t1" });
  assert.equal(js[1].input.out, MEDIA + "Film_A_score_t2");
  assert.equal(js[0].tool, "elevenlabs");
  assert.equal(count(calls, "creative_run_flow_nodes"), 1); // only the estimate
  const sc = s.store.state.audio.score;
  assert.deepEqual(sc.takes.map((t) => [t.n, t.status, t.source]), [[1, "queued", "elevenlabs"], [2, "queued", "elevenlabs"]]);
  assert.equal(sc.chosen, 2);
});

test("count above 1 is only for the score", async () => {
  const s = await planned();
  await assert.rejects(() => startAudioTake(s.ctx, "SFX-01", { count: 2 }));
  assert.equal(s.jobs.list().length, 0);
});

test("ElevenLabs cue: job input and a stale estimate after an edit", async () => {
  const s = await planned();
  eleven(s.host);
  await editItem(s.store, "SFX-02", { source: "elevenlabs" });
  await getEstimate(s.ctx, "SFX-02");
  await editItem(s.store, "SFX-02", { durationS: 25 });
  await assert.rejects(() => startAudioTake(s.ctx, "SFX-02"), /Get the cost first\./);
  await getEstimate(s.ctx, "SFX-02");
  await startAudioTake(s.ctx, "SFX-02");
  const [j] = s.jobs.list();
  assert.deepEqual(j.input, { kind: "sfx", flowId: "F1", nodeId: "N2", sfx: true, out: MEDIA + "Film_A_sfx_sfx-02_harbour-wind_t1" });
  assert.equal(j.what, "SFX-02 harbour wind take 1");
});

test("Stable Audio redo with a note rewrites the prompt and starts the take", async () => {
  const s = await planned();
  await startAudioTake(s.ctx, "SFX-01");
  await s.store.update((d) => { d.audio.sfx[0].takes[0].status = "done"; d.audio.sfx[0].takes[0].file = "f"; });
  let seen;
  s.host.claudeScript((kind, input, opts) => { seen = { input, opts }; return { prompt: "a slower creak" }; });
  const ns = await startAudioTake(s.ctx, "SFX-01", { note: "slower" });
  assert.deepEqual(ns, [2]);
  assert.equal(seen.opts.tier, "quick");
  assert.match(seen.input, /"note":"slower"/);
  const c = s.store.state.audio.sfx[0];
  assert.equal(c.prompt, "a slower creak");
  assert.equal(c.takes.length, 2);
  assert.equal(c.takes[0].prompt, PLAN.sfx[0].prompt);
  assert.equal(c.takes[1].note, "slower");
  assert.equal(c.takes[1].prompt, "a slower creak");
  assert.equal(c.pendingNote, undefined);
  assert.equal(s.jobs.list()[1].why, 'Take 2, from your note "slower"');
});

test("ElevenLabs redo with a note takes two presses and keeps the note", async () => {
  const s = await planned();
  eleven(s.host);
  await getEstimate(s.ctx, "SCORE");
  s.host.claudeScript(() => ({ prompt: "warmer strings" }));
  await assert.rejects(() => startAudioTake(s.ctx, "SCORE", { note: "warmer" }), /Get the cost first\./);
  let sc = s.store.state.audio.score;
  assert.equal(sc.prompt, "warmer strings");
  assert.equal(sc.est, null);
  assert.equal(sc.pendingNote, "warmer");
  assert.equal(s.jobs.list().length, 0);
  await getEstimate(s.ctx, "SCORE");
  await startAudioTake(s.ctx, "SCORE");
  sc = s.store.state.audio.score;
  assert.equal(sc.takes[0].note, "warmer");
  assert.equal(sc.takes[0].prompt, "warmer strings");
  assert.equal(sc.pendingNote, undefined);
  assert.equal(s.jobs.list()[0].why, 'Take 1, from your note "warmer"');
});

test("rewriteFromNote saves the prompt, clears the estimate and keeps the note", async () => {
  const s = await planned();
  await s.store.update((d) => { d.audio.sfx[0].est = { credits: 3, sig: "s" }; });
  s.host.claudeScript(() => ({ prompt: "new" }));
  await rewriteFromNote(s.ctx, "SFX-01", "heavier");
  const c = s.store.state.audio.sfx[0];
  assert.equal(c.prompt, "new");
  assert.equal(c.est, null);
  assert.equal(c.pendingNote, "heavier");
});

test("a failed job add marks the takes failed", async () => {
  const s = await planned();
  s.jobs.add = () => { throw new Error("queue full"); };
  await assert.rejects(() => startAudioTake(s.ctx, "SFX-01"), /queue full/);
  const t = s.store.state.audio.sfx[0].takes[0];
  assert.equal(t.status, "failed");
  assert.equal(t.error, "queue full");
  assert.equal(s.store.pending.size, 0);
});

test("choose, approve and unapprove follow the b-roll rules", async () => {
  const s = await planned();
  await s.store.update((d) => {
    d.audio.sfx[0].takes = [{ n: 1, status: "done", file: "a" }, { n: 2, status: "failed" }];
    d.audio.sfx[0].chosen = 2;
  });
  await assert.rejects(() => approveAudio(s.ctx, "SFX-01"), /finished take/);
  await chooseAudio(s.ctx, "SFX-01", 1);
  await approveAudio(s.ctx, "SFX-01");
  assert.equal(s.store.state.audio.sfx[0].approved, true);
  await unapproveAudio(s.ctx, "SFX-01");
  assert.equal(s.store.state.audio.sfx[0].approved, false);
  await approveAudio(s.ctx, "SFX-01");
  await chooseAudio(s.ctx, "SFX-01", 2);
  assert.equal(s.store.state.audio.sfx[0].approved, false);
  await assert.rejects(() => chooseAudio(s.ctx, "SFX-01", 9), /no take 9/);
});

test("two parallel getEstimate calls add one node", async () => {
  const s = await planned();
  const calls = eleven(s.host);
  const [a, b] = await Promise.all([getEstimate(s.ctx, "SCORE"), getEstimate(s.ctx, "SCORE")]);
  assert.equal(a, 6149);
  assert.equal(b, 6149);
  assert.equal(count(calls, "creative_create_flow"), 1);
  assert.equal(count(calls, "creative_add_flow_node"), 1);
  await getEstimate(s.ctx, "SCORE"); // a later call runs again
  assert.equal(count(calls, "creative_run_flow_nodes"), 2);
});

test("a take started elsewhere during the note rewrite stops the redo", async () => {
  const s = await planned();
  s.host.claudeScript(() => ({ prompt: "a slower creak" }));
  const log = s.store.log;
  s.store.log = async (t) => { if (/rewritten/.test(t)) s.store.pending.add("SFX-01#1"); return log(t); };
  await assert.rejects(() => startAudioTake(s.ctx, "SFX-01", { note: "slower" }), /in progress/);
  assert.equal(s.jobs.list().length, 0);
  assert.deepEqual(s.store.state.audio.sfx[0].takes, []);
});

test("editing the prompt drops a waiting note", async () => {
  const s = await planned();
  s.host.claudeScript(() => ({ prompt: "new" }));
  await rewriteFromNote(s.ctx, "SFX-01", "heavier");
  await editItem(s.store, "SFX-01", { durationS: 4 });
  assert.equal(s.store.state.audio.sfx[0].pendingNote, "heavier");
  await editItem(s.store, "SFX-01", { prompt: "my own prompt" });
  assert.equal(s.store.state.audio.sfx[0].pendingNote, undefined);
});

test("takes without a note: First take, then Take n", async () => {
  const s = await planned();
  eleven(s.host);
  await getEstimate(s.ctx, "SCORE");
  await startAudioTake(s.ctx, "SCORE", { count: 2 });
  assert.deepEqual(s.jobs.list().map((j) => j.why), ["First take", "Take 2"]);
});

test("two cues with the same name get different out paths", async () => {
  const s = await planned();
  await addCue(s.store, { cue: "door creak", prompt: "another door", durationS: 2 });
  await startAudioTake(s.ctx, "SFX-01");
  await startAudioTake(s.ctx, "SFX-03");
  const outs = s.jobs.list().map((j) => j.input.out);
  assert.deepEqual(outs, [MEDIA + "Film_A_sfx_sfx-01_door-creak_t1.wav", MEDIA + "Film_A_sfx_sfx-03_door-creak_t1.wav"]);
});

test("an empty slug leaves no double underscore", async () => {
  const s = await planned();
  await editItem(s.store, "SFX-01", {});
  await s.store.update((d) => { d.audio.sfx[0].cue = "!!!"; });
  await startAudioTake(s.ctx, "SFX-01");
  assert.equal(s.jobs.list()[0].input.out, MEDIA + "Film_A_sfx_sfx-01_t1.wav");
});

test("an existing file for the take refuses the start and adds no job", async () => {
  const s = await planned();
  await s.host.fs.mkdir(MEDIA);
  await s.host.fs.write(MEDIA + "Film_A_sfx_sfx-01_door-creak_t1.wav", "x");
  await assert.rejects(() => startAudioTake(s.ctx, "SFX-01"), /A file for SFX-01 door creak take 1 is already there; not replacing it\./);
  assert.equal(s.jobs.list().length, 0);
  assert.equal(s.store.state.audio.sfx[0].takes.length, 0);
  await editItem(s.store, "SFX-02", { source: "elevenlabs" });
  eleven(s.host);
  await getEstimate(s.ctx, "SFX-02");
  await s.host.fs.write(MEDIA + "Film_A_sfx_sfx-02_harbour-wind_t1.mp3", "x");
  await assert.rejects(() => startAudioTake(s.ctx, "SFX-02"), /already there/);
  assert.equal(s.jobs.list().length, 0);
});

// ---- sound effect start times ----
import { proposeStarts } from "../js/audioplan.js";

const ROWS = [
  { clip: "04", section: "A", name: "four", start_s: 40.25, end_s: 50 },
  { clip: "05", section: "A", name: "five", start_s: 59.3, end_s: 70 },
];

test("PLAN_INSTRUCTIONS asks for a lineId and new cues start unplaced", async () => {
  assert.match(PLAN_INSTRUCTIONS, /lineId/);
  const s = await planned();
  assert.equal(s.store.state.audio.sfx[0].startS, null);
  assert.equal(s.store.state.audio.sfx[0].lineId, null);
});

test("planAudio keeps a valid lineId and rejects a bad one", async () => {
  const s = await setup();
  s.host.claudeScript(() => ({ ...structuredClone(PLAN), sfx: [{ ...PLAN.sfx[0], lineId: "05.2" }] }));
  await planAudio(s.host, s.store, { scriptText: "a", handoverText: "b" });
  assert.equal(s.store.state.audio.sfx[0].lineId, "05.2");
  const t = await setup();
  t.host.claudeScript(() => ({ ...structuredClone(PLAN), sfx: [{ ...PLAN.sfx[0], lineId: "line five" }] }));
  await assert.rejects(() => planAudio(t.host, t.store, { scriptText: "a", handoverText: "b" }));
});

test("proposeStarts fills a cue from its clip start plus 6 and leaves a Jon-edited cue alone", async () => {
  const s = await planned();
  await s.store.update((d) => {
    d.audio.sfx[0].lineId = "05.2";
    d.audio.sfx[1].lineId = "04.1";
    d.audio.sfx[1].startS = 99;
    d.audio.sfx[1].startSBy = "jon";
  });
  const filled = await proposeStarts(s.store, ROWS, null);
  assert.deepEqual(filled, ["SFX-01"]);
  assert.ok(Math.abs(s.store.state.audio.sfx[0].startS - 65.3) < 1e-9);
  assert.equal(s.store.state.audio.sfx[1].startS, 99);
});

test("proposeStarts matches ids numerically: line 5.2 finds clip 05, line 04.1 finds clip 4", async () => {
  const s = await planned();
  await s.store.update((d) => { d.audio.sfx[0].lineId = "5.2"; d.audio.sfx[1].lineId = "04.1"; });
  const rows = [{ ...ROWS[0], clip: "4" }, ROWS[1]];
  assert.deepEqual(await proposeStarts(s.store, rows, null), ["SFX-01", "SFX-02"]);
  assert.ok(Math.abs(s.store.state.audio.sfx[0].startS - 65.3) < 1e-9);
  assert.ok(Math.abs(s.store.state.audio.sfx[1].startS - 46.25) < 1e-9);
});

test("proposeStarts skips cues with no lineId or a clip missing from the timings", async () => {
  const s = await planned();
  await s.store.update((d) => { d.audio.sfx[1].lineId = "09.1"; });
  assert.deepEqual(await proposeStarts(s.store, ROWS, null), []);
  assert.equal(s.store.state.audio.sfx[0].startS, null);
  assert.equal(s.store.state.audio.sfx[1].startS, null);
});

test("editItem accepts startS as m:ss.s, m:ss and seconds, marks Jon, and keeps the estimate", async () => {
  const s = await planned();
  await s.store.update((d) => { d.audio.sfx[0].est = { credits: 5, sig: "x" }; });
  await editItem(s.store, "SFX-01", { startS: "1:05.3" });
  const x = () => s.store.state.audio.sfx[0];
  assert.ok(Math.abs(x().startS - 65.3) < 1e-9);
  assert.equal(x().startSBy, "jon");
  assert.deepEqual(x().est, { credits: 5, sig: "x" });
  await editItem(s.store, "SFX-01", { startS: "2:10" });
  assert.equal(x().startS, 130);
  await editItem(s.store, "SFX-01", { startS: "75.5" });
  assert.equal(x().startS, 75.5);
  await editItem(s.store, "SFX-01", { startS: 12 });
  assert.equal(x().startS, 12);
  await editItem(s.store, "SFX-01", { startS: "" });
  assert.equal(x().startS, null);
  assert.equal(x().startSBy, undefined);
  await assert.rejects(() => editItem(s.store, "SFX-01", { startS: "soon" }), /Starts at/);
  await assert.rejects(() => editItem(s.store, "SFX-01", { startS: "-3" }), /Starts at/);
});

test("editItem validates lineId and refuses startS on the score", async () => {
  const s = await planned();
  await editItem(s.store, "SFX-01", { lineId: "05.2" });
  assert.equal(s.store.state.audio.sfx[0].lineId, "05.2");
  await editItem(s.store, "SFX-01", { lineId: null });
  assert.equal(s.store.state.audio.sfx[0].lineId, null);
  await assert.rejects(() => editItem(s.store, "SFX-01", { lineId: "five" }));
  await assert.rejects(() => editItem(s.store, "SCORE", { startS: "0:10" }));
});

test("start time and line can change while a take is busy; other edits still cannot", async () => {
  const s = await planned();
  await startAudioTake(s.ctx, "SFX-01");
  await editItem(s.store, "SFX-01", { startS: "0:30" });
  assert.equal(s.store.state.audio.sfx[0].startS, 30);
  await editItem(s.store, "SFX-01", { lineId: "05" });
  assert.equal(s.store.state.audio.sfx[0].lineId, "05");
  await assert.rejects(() => editItem(s.store, "SFX-01", { startS: "0:31", prompt: "x" }), /in progress/);
});

test("Jon retyping the proposed time marks it his", async () => {
  const s = await planned();
  await s.store.update((d) => { d.audio.sfx[0].lineId = "05.2"; });
  await proposeStarts(s.store, ROWS, null);
  assert.equal(s.store.state.audio.sfx[0].startSBy, undefined);
  await editItem(s.store, "SFX-01", { startS: s.store.state.audio.sfx[0].startS });
  assert.equal(s.store.state.audio.sfx[0].startSBy, "jon");
  await proposeStarts(s.store, [{ clip: "05", start_s: 1 }], null);
  assert.ok(Math.abs(s.store.state.audio.sfx[0].startS - 65.3) < 1e-9);
});
