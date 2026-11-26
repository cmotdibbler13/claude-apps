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
  assert.deepEqual(a.sfx[0], { id: "SFX-01", cue: "door creak", prompt: PLAN.sfx[0].prompt, durationS: 3, loop: false, source: "stableaudio", takes: [], chosen: null, approved: false, node: null, est: null });
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
  assert.deepEqual(j.input, { prompt: PLAN.sfx[0].prompt, seconds: 3, out: MEDIA + "Film_A_sfx_door-creak_t1.wav" });
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
  assert.deepEqual(j.input, { kind: "sfx", flowId: "F1", nodeId: "N2", sfx: true, out: MEDIA + "Film_A_sfx_harbour-wind_t1" });
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
