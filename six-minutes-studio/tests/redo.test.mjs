import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { makeJobs } from "../js/jobs.js";
import { startTake, watchJobs, approve, unapprove, choose, canStart, setTool, setPreferComfy, addBlender3d, has3d, hasDerived, addAnimated, removeVersion, jobGone, removedText, jobRemoved } from "../js/redo.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const hf = (o = {}) => ({ id: "HF-01", kind: "lineart", line: "L", lineIndex: 0, desc: "A lighthouse", tool: "higgsfield", draftPrompt: "draft prompt", takes: [], chosen: 0, approved: false, ...o });
const bl = (o = {}) => ({ id: "HF-02", kind: "blender", line: "L2", lineIndex: 1, desc: "3D lighthouse", tool: "blender", sourceId: "HF-01", takes: [], chosen: 0, approved: false, ...o });

async function setup(assets, runners = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  const store = await openFilm(host, DIR);
  await store.update((d) => { d.assets = assets; });
  const jobs = makeJobs(host, { runners });
  return { host, store, jobs, ctx: { host, store, jobs } };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const idle = { higgsfield: { start: () => new Promise(() => {}) }, blender: { lane: "gpu", start: () => new Promise(() => {}) } };

test("first take uses the draft prompt", async () => {
  const { ctx, host, store, jobs } = await setup([hf()], idle);
  let asked = 0;
  host.claudeScript(() => { asked++; });
  const t = await startTake(ctx, "HF-01");
  assert.equal(asked, 0);
  assert.equal(t.n, 1);
  assert.equal(t.prompt, "draft prompt");
  assert.equal(t.status, "queued");
  const a = store.state.assets[0];
  assert.equal(a.chosen, 1);
  const [j] = jobs.list();
  assert.equal(j.why, "First take");
  assert.equal(j.take, 1);
  assert.deepEqual(j.input, { kind: "lineart", prompt: "draft prompt", out: DIR + "\\studio\\media\\HF-01_t1" });
  assert.equal(a.takes[0].jobId, j.id);
});

test("redo rewrites prompt with note and keeps old takes", async () => {
  const { ctx, host, store, jobs } = await setup([hf({ takes: [{ n: 1, prompt: "old", status: "done", file: "x.png", at: 1 }], chosen: 1, approved: true })], idle);
  let seen;
  host.claudeScript((kind, input, opts) => { seen = { input, opts }; return { prompt: "new prompt" }; });
  const t = await startTake(ctx, "HF-01", { note: "more amber" });
  assert.equal(seen.opts.tier, "quick");
  assert.match(seen.input, /"previousPrompt":"old"/);
  assert.match(seen.input, /"note":"more amber"/);
  const a = store.state.assets[0];
  assert.equal(a.takes.length, 2);
  assert.equal(a.takes[0].prompt, "old");
  assert.equal(t.n, 2);
  assert.equal(t.prompt, "new prompt");
  assert.equal(t.note, "more amber");
  assert.equal(a.chosen, 2);
  assert.equal(a.approved, false);
  assert.equal(jobs.list()[0].why, 'Take 2, from your note "more amber"');
  assert.match((await store.readLog())[0].text, /HF-01 take 2 started/);
});

test("failed rewrite leaves state unchanged", async () => {
  const { ctx, host, store, jobs } = await setup([hf({ takes: [{ n: 1, prompt: "old", status: "done", file: "x.png", at: 1 }], chosen: 1 })], idle);
  host.claudeScript(() => ({ prompt: "  " }));
  const before = JSON.stringify(store.state);
  await assert.rejects(() => startTake(ctx, "HF-01", { note: "n" }));
  assert.equal(JSON.stringify(store.state), before);
  assert.equal(jobs.list().length, 0);
});

test("blender shot cannot start until source line art is approved", async () => {
  const src = hf({ takes: [{ n: 1, prompt: "p", status: "done", file: "S:\\a.png", at: 1 }], chosen: 1 });
  const { ctx, host, store, jobs } = await setup([src, bl()], idle);
  assert.equal(canStart(store.state.assets[1], store.state.assets), false);
  await assert.rejects(() => startTake(ctx, "HF-02"), /approved/);
  await approve(ctx, "HF-01");
  assert.equal(canStart(store.state.assets[1], store.state.assets), true);
  let asked = 0;
  host.claudeScript(() => { asked++; });
  const t = await startTake(ctx, "HF-02");
  assert.equal(asked, 0);
  assert.equal(t.n, 1);
  assert.equal(t.script, undefined);
  assert.deepEqual(jobs.list()[0].input, {
    kind: "blender", asset: { id: "HF-02", desc: "3D lighthouse", line: "L2" }, take: 1, sourceFile: "S:\\a.png",
    base: DIR + "\\studio\\blender\\HF-02_t1", out: DIR + "\\studio\\media\\HF-02_t1.mp4",
  });
});

test("blender redo passes the note, previous script and last check still; done copies script and checks", async () => {
  const src = hf({ takes: [{ n: 1, prompt: "p", status: "done", file: "S:\\a.png", at: 1 }], chosen: 1, approved: true });
  const pb = DIR + "\\studio\\blender\\HF-02_t1";
  const prev = { n: 1, status: "done", file: "S:\\t1.mp4", script: pb + ".py", at: 1 };
  const meta = { script: DIR + "\\studio\\blender\\HF-02_t2.py", checks: [{ round: 1, still: "S:\\n1.png", verdict: "matches", note: "ok" }] };
  const runners = { blender: { lane: "gpu", start: async (j) => ({ file: j.input.out, meta }) } };
  const { ctx, host, store, jobs } = await setup([src, bl({ takes: [prev], chosen: 1 })], runners);
  await host.fs.mkdir(DIR + "\\studio\\blender");
  for (const f of ["_r1.py", "_r2.py", ".py", "_check1.png", "_check2.png", "_check3.png"]) host.files.set(pb + f, "x");
  watchJobs(ctx);
  await startTake(ctx, "HF-02", { note: "turn left" });
  const input = jobs.list()[0].input;
  assert.equal(input.note, "turn left");
  assert.equal(input.previousScript, pb + ".py");
  // The final script is round 2's (no _r3.py), so round 2's still goes with it, not a stray _check3.png.
  assert.equal(input.previousStill, pb + "_check2.png");
  assert.equal(input.base, DIR + "\\studio\\blender\\HF-02_t2");
  await tick(); await tick();
  const t = store.state.assets[1].takes[1];
  assert.equal(t.status, "done");
  assert.equal(t.script, meta.script);
  assert.deepEqual(t.checks, meta.checks);
});

test("blender redo after a failed take finds its last round script and still on disk", async () => {
  const src = hf({ takes: [{ n: 1, prompt: "p", status: "done", file: "S:\\a.png", at: 1 }], chosen: 1, approved: true });
  const pb = DIR + "\\studio\\blender\\HF-02_t1";
  const prev = { n: 1, status: "failed", error: "The 3D render came out blank. Redo with a note.", at: 1 };
  const { ctx, host, jobs } = await setup([src, bl({ takes: [prev], chosen: 1 })], idle);
  await host.fs.mkdir(DIR + "\\studio\\blender");
  for (const f of ["_r1.py", "_r2.py", "_check1.png", "_check2.png"]) host.files.set(pb + f, "x");
  await startTake(ctx, "HF-02", { note: "camera further back" });
  const input = jobs.list()[0].input;
  assert.equal(input.previousScript, pb + "_r2.py");
  assert.equal(input.previousStill, pb + "_check2.png");
});

test("blender redo with nothing on disk from the previous take sends no previous script or still", async () => {
  const src = hf({ takes: [{ n: 1, prompt: "p", status: "done", file: "S:\\a.png", at: 1 }], chosen: 1, approved: true });
  const { ctx, jobs } = await setup([src, bl({ takes: [{ n: 1, status: "failed", at: 1 }], chosen: 1 })], idle);
  await startTake(ctx, "HF-02", { note: "n" });
  const input = jobs.list()[0].input;
  assert.equal(input.previousScript, undefined);
  assert.equal(input.previousStill, undefined);
});

test("refuses a second take while one is running", async () => {
  const { ctx } = await setup([hf()], idle);
  await startTake(ctx, "HF-01");
  await assert.rejects(() => startTake(ctx, "HF-01"), /in progress/);
});

test("job done sets take file and logs", async () => {
  const runners = { higgsfield: { start: async () => ({ file: "S:\\out.png" }) } };
  const { ctx, store } = await setup([hf()], runners);
  const stop = watchJobs(ctx);
  await startTake(ctx, "HF-01");
  await tick(); await tick();
  const t = store.state.assets[0].takes[0];
  assert.equal(t.status, "done");
  assert.equal(t.file, "S:\\out.png");
  const lines = (await store.readLog()).map((l) => l.text);
  assert.equal(lines.filter((l) => l === "HF-01 take 1 ready").length, 1);
  stop();
});

test("job failure marks take failed, and a retry updates the same take", async () => {
  let n = 0;
  const runners = { higgsfield: { start: async () => { if (n++ === 0) throw new Error("boom"); return { file: "S:\\ok.png" }; } } };
  const { ctx, store, jobs } = await setup([hf()], runners);
  watchJobs(ctx);
  await startTake(ctx, "HF-01");
  await tick(); await tick();
  let t = store.state.assets[0].takes[0];
  assert.equal(t.status, "failed");
  assert.equal(t.error, "boom");
  assert.ok((await store.readLog()).some((l) => l.text === "HF-01 take 1 failed: boom"));
  jobs.retry(jobs.list()[0].id);
  await tick(); await tick();
  t = store.state.assets[0].takes[0];
  assert.equal(store.state.assets[0].takes.length, 1);
  assert.equal(t.status, "done");
  assert.equal(t.file, "S:\\ok.png");
  assert.equal(t.error, undefined);
});

test("approve requires a done take", async () => {
  const { ctx, store } = await setup([hf({ takes: [{ n: 1, prompt: "p", status: "running", at: 1 }], chosen: 1 }), hf({ id: "HF-03", takes: [{ n: 1, prompt: "p", status: "done", file: "f", at: 1 }, { n: 2, prompt: "q", status: "failed", at: 2 }], chosen: 1 })]);
  await assert.rejects(() => approve(ctx, "HF-01"), /finished take/);
  await approve(ctx, "HF-03");
  assert.equal(store.state.assets[1].approved, true);
  await unapprove(ctx, "HF-03");
  assert.equal(store.state.assets[1].approved, false);
  await approve(ctx, "HF-03");
  await choose(ctx, "HF-03", 2);
  assert.equal(store.state.assets[1].chosen, 2);
  assert.equal(store.state.assets[1].approved, false);
  await assert.rejects(() => choose(ctx, "HF-03", 9), /no take 9/);
});

test("watchJobs syncs at subscribe: interrupted after restore frees the take", async () => {
  const { ctx, host, store, jobs } = await setup([hf({ takes: [{ n: 1, prompt: "p", status: "running", jobId: "j1", at: 1 }], chosen: 1 })], idle);
  jobs.restore([{ id: "j1", film: DIR, assetId: "HF-01", take: 1, tool: "blender", lane: "gpu", status: "running", input: {} }]);
  watchJobs(ctx);
  await tick();
  const t = store.state.assets[0].takes[0];
  assert.equal(t.status, "interrupted");
  assert.ok(t.error);
  host.claudeScript(() => ({ prompt: "again prompt" }));
  assert.equal((await startTake(ctx, "HF-01", { note: "again" })).n, 2);
});

test("jobs.add failure marks the take failed and rethrows", async () => {
  const { ctx, host, store, jobs } = await setup([hf()], idle);
  jobs.add = () => { throw new Error("queue broke"); };
  await assert.rejects(() => startTake(ctx, "HF-01"), /queue broke/);
  const t = store.state.assets[0].takes[0];
  assert.equal(t.status, "failed");
  assert.equal(t.error, "queue broke");
  assert.ok((await store.readLog()).some((l) => /take 1 failed: queue broke/.test(l.text)));
  jobs.add = () => "jx";
  host.claudeScript(() => ({ prompt: "again" }));
  assert.equal((await startTake(ctx, "HF-01")).n, 2);
});

test("a 200-frame Blender render writes state.json and the jobs file only a few times", async () => {
  const { makeBlenderRunner } = await import("../js/tools/blender.js");
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  const store = await openFilm(host, DIR);
  await store.update((d) => { d.assets = [bl({ takes: [{ n: 1, status: "queued", at: 1 }], chosen: 1 })]; });
  const writes = { state: 0, jobs: 0 };
  const w = host.fs.write;
  host.fs.write = async (p, x) => { if (/state\.json\.tmp$/i.test(p)) writes.state++; if (/studio-jobs\.json\.tmp$/i.test(p)) writes.jobs++; return w(p, x); };
  host.limitsScript(() => ({ images: { max: 5 } }));
  host.files.set("S:\\a.png", "DRAWING");
  let asks = 0;
  host.claudeScript(() => (asks++ === 0 ? { script: "import bpy\n", frames: 200 } : { verdict: "matches", note: "ok" }));
  host.spawnScript((cmd, args, o, ctl) => {
    if (args.includes("--still")) { host.files.set(args.at(-1), "png"); return ctl.exit(0); }
    for (let i = 1; i <= 200; i++) ctl.out(`Fra:${i} Mem:1M | Rendering\nFra:${i} Mem:1M | Sample 1/64\n`);
    host.files.set(args.at(-1), "x");
    ctl.exit(0);
  });
  const jobs = makeJobs(host, { runners: { blender: makeBlenderRunner() }, file: "S:\\Youtube video ideas\\.studio-jobs.json" });
  watchJobs({ host, store, jobs });
  jobs.add({ film: DIR, assetId: "HF-02", take: 1, tool: "blender", input: { kind: "blender", asset: { id: "HF-02", desc: "d", line: "l" }, take: 1, sourceFile: "S:\\a.png", base: DIR + "\\studio\\blender\\HF-02_t1", out: DIR + "\\studio\\media\\HF-02_t1.mp4" } });
  await new Promise((r) => setTimeout(r, 100)); await jobs.flush(); await tick();
  assert.equal(store.state.assets[0].takes[0].status, "done");
  assert.ok(writes.state <= 10, `state.json written ${writes.state} times`);
  assert.ok(writes.jobs <= 10, `jobs file written ${writes.jobs} times`);
});

test("a busy take with no matching job is marked interrupted: lost track", async () => {
  const { ctx, host, store } = await setup([hf({ takes: [{ n: 1, prompt: "p", status: "running", jobId: "gone", at: 1 }], chosen: 1 })], idle);
  watchJobs(ctx);
  await tick();
  const t = store.state.assets[0].takes[0];
  assert.equal(t.status, "interrupted");
  assert.equal(t.error, "Lost track of this job");
  assert.ok((await store.readLog()).some((l) => l.text === "HF-01 take 1 failed: Lost track of this job"));
  host.claudeScript(() => ({ prompt: "again" }));
  assert.equal((await startTake(ctx, "HF-01", { note: "again" })).n, 2);
});

test("a take being started is not mistaken for a lost one", async () => {
  const { ctx, store, jobs } = await setup([hf()], idle);
  watchJobs(ctx);
  const update = store.update;
  store.update = (fn) => {
    const p = update(fn);
    // Another job changes the moment the new take is written, before its job is added.
    p.then(() => { try { jobs.add({ film: "S:\\Youtube video ideas\\Other", assetId: "HF-09", take: 1, tool: "higgsfield", input: {} }); } catch { /* ignore */ } });
    return p;
  };
  await startTake(ctx, "HF-01");
  await tick(); await tick();
  assert.ok(["queued", "running"].includes(store.state.assets[0].takes[0].status), store.state.assets[0].takes[0].status);
});

test("jobs match a film by folder name, so S: and the UNC copy are the same film", async () => {
  const runners = { higgsfield: { start: async () => ({ file: "x.png" }) } };
  const { ctx, store, jobs } = await setup([hf({ takes: [{ n: 1, prompt: "p", status: "queued", at: 1 }], chosen: 1 })], runners);
  jobs.add({ film: "\\\\192.168.1.171\\jon\\Youtube video ideas\\FILM A", assetId: "HF-01", take: 1, tool: "higgsfield", input: {} });
  watchJobs(ctx);
  await tick(); await tick();
  assert.equal(store.state.assets[0].takes[0].status, "done");
});

test("waiting follows takes: running, ready to review, approved", async () => {
  const runners = { higgsfield: { start: async () => ({ file: "S:\\out.png" }) } };
  const { ctx, store } = await setup([hf()], runners);
  watchJobs(ctx);
  await startTake(ctx, "HF-01");
  await tick(); await tick();
  assert.equal(store.state.assets[0].takes[0].status, "done");
  assert.equal(store.state.waiting, "1 shot to review");
  await approve(ctx, "HF-01");
  assert.equal(store.state.waiting, "All shots approved");
  await unapprove(ctx, "HF-01");
  assert.equal(store.state.waiting, "1 shot to review");
});

test("a failed state write from the job watcher is logged and reported, then cleared", async () => {
  const runners = { higgsfield: { start: async () => ({ file: "S:\\out.png" }) } };
  const { host, store, jobs } = await setup([hf({ takes: [{ n: 1, prompt: "p", status: "queued", at: 1 }], chosen: 1 })], runners);
  const errors = [], logged = [];
  const ce = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const w = host.fs.write;
    host.fs.write = async () => { throw new Error("EACCES: denied"); };
    watchJobs({ host, store, jobs, onError: (m) => errors.push(m) });
    await tick();
    assert.deepEqual(errors, ["EACCES: denied"]);
    assert.equal(logged.length, 1);
    host.fs.write = w;
    jobs.add({ film: DIR, assetId: "HF-01", take: 1, tool: "higgsfield", input: {} });
    await tick(); await tick();
    assert.equal(errors.at(-1), null);
    assert.equal(store.state.assets[0].takes[0].status, "done");
  } finally { console.error = ce; }
});

const br = (o = {}) => hf({ id: "HF-03", kind: "broll", lineIndex: 2, ...o });
const idle3 = { ...idle, comfyui: { lane: "gpu", start: () => new Promise(() => {}) } };

test("setTool switches a broll shot, logs it, and a same-tool call is a no-op", async () => {
  const { ctx, store } = await setup([br({ approved: true })], idle3);
  await setTool(ctx, "HF-03", "comfyui");
  assert.equal(store.state.assets[0].tool, "comfyui");
  assert.equal(store.state.assets[0].approved, true);
  assert.ok((await store.readLog()).some((l) => l.text === "HF-03 now uses ComfyUI"));
  const before = (await store.readLog()).length;
  const st = store.state;
  await setTool(ctx, "HF-03", "comfyui");
  assert.equal(store.state, st);
  assert.equal((await store.readLog()).length, before);
  await setTool(ctx, "HF-03", "higgsfield");
  assert.ok((await store.readLog()).some((l) => l.text === "HF-03 now uses Higgsfield"));
});

test("setTool refuses while a take is busy", async () => {
  const { ctx, store } = await setup([br()], idle3);
  await startTake(ctx, "HF-03");
  await assert.rejects(() => setTool(ctx, "HF-03", "comfyui"), /has a take in progress/);
  assert.equal(store.state.assets[0].tool, "higgsfield");
  const { ctx: c2, store: s2 } = await setup([br()], idle3);
  s2.pending.add("HF-03#1");
  await assert.rejects(() => setTool(c2, "HF-03", "comfyui"), /has a take in progress/);
});

test("setTool rejects comfyui on lineart or blender, and unknown shots or tools", async () => {
  const { ctx } = await setup([hf(), bl(), br()], idle3);
  await assert.rejects(() => setTool(ctx, "HF-01", "comfyui"), /b-roll/);
  await assert.rejects(() => setTool(ctx, "HF-02", "comfyui"), /b-roll/);
  await assert.rejects(() => setTool(ctx, "HF-09", "comfyui"), /Unknown shot/);
  await assert.rejects(() => setTool(ctx, "HF-03", "blender"), /tool/i);
});

test("setPreferComfy changes only broll shots without takes", async () => {
  const done = { n: 1, prompt: "p", status: "done", file: "x.mp4" };
  const { ctx, store } = await setup([
    hf(), br({ id: "HF-04" }), br({ id: "HF-05", takes: [done], chosen: 1 }), br({ id: "HF-06" }),
  ], idle3);
  store.pending.add("HF-06#1");
  await setPreferComfy(ctx, true);
  const t = Object.fromEntries(store.state.assets.map((a) => [a.id, a.tool]));
  assert.deepEqual(t, { "HF-01": "higgsfield", "HF-04": "comfyui", "HF-05": "higgsfield", "HF-06": "higgsfield" });
  assert.equal(store.state.prefs.preferComfy, true);
  assert.ok((await store.readLog()).some((l) => l.text === "Prefer ComfyUI for b-roll: on (1 shots switched)"));
  await setPreferComfy(ctx, false);
  assert.equal(store.state.assets.find((a) => a.id === "HF-04").tool, "higgsfield");
  assert.equal(store.state.prefs.preferComfy, false);
});

test("startTake on a comfyui shot adds a comfyui job with an .mp4 out", async () => {
  const { ctx, host, jobs, store } = await setup([br({ tool: "comfyui" })], idle3);
  host.claudeScript(() => { throw new Error("no Claude call for a first take"); });
  const t = await startTake(ctx, "HF-03");
  assert.equal(t.prompt, "draft prompt");
  const [j] = jobs.list();
  assert.equal(j.tool, "comfyui");
  assert.equal(store.state.assets[0].takes[0].tool, "comfyui");
  assert.deepEqual(j.input, { kind: "broll", prompt: "draft prompt", out: DIR + "\\studio\\media\\HF-03_t1.mp4" });
  host.claudeScript(() => ({ prompt: "again" }));
  store.state.assets[0].takes[0].status = "done";
  const t2 = await startTake(ctx, "HF-03", { note: "slower" });
  assert.equal(t2.prompt, "again");
});

test("addBlender3d with an empty source description uses the source id", async () => {
  const { ctx, store } = await setup([hf({ id: "HF-02", lineIndex: 3, line: "L3", desc: "", approved: true })]);
  const id = await addBlender3d(ctx, "HF-02");
  assert.equal(store.state.assets.find((a) => a.id === id).desc, "3D line-art version of HF-02");
});

test("addBlender3d adds a Blender shot beside its line art, once", async () => {
  const assets = [hf({ id: "HF-02", lineIndex: 3, line: "L3", desc: "A Lighthouse at dusk", approved: true }), hf({ id: "HF-07", kind: "broll", lineIndex: 5 })];
  const { ctx, store } = await setup(assets);
  assert.equal(has3d(store.state.assets, "HF-02"), false);
  const id = await addBlender3d(ctx, "HF-02");
  assert.equal(id, "HF-08");
  const n = store.state.assets.find((a) => a.id === "HF-08");
  assert.deepEqual(n, {
    id: "HF-08", kind: "blender", tool: "blender", sourceId: "HF-02", line: "L3", lineIndex: 3,
    desc: "3D line-art version of a Lighthouse at dusk", draftPrompt: "3D line-art version of HF-02 in Blender",
    takes: [], chosen: 0, approved: false,
  });
  assert.equal(has3d(store.state.assets, "HF-02"), true);
  assert.equal(canStart(n, store.state.assets), true);
  await assert.rejects(() => addBlender3d(ctx, "HF-02"), /HF-02 already has a Blender version\./);
  assert.equal(store.state.assets.length, 3);
});

test("addBlender3d stays locked until the source is approved, and refuses non line art", async () => {
  const { ctx, store } = await setup([hf(), hf({ id: "HF-03", kind: "broll" })]);
  const id = await addBlender3d(ctx, "HF-01");
  assert.equal(id, "HF-04");
  assert.equal(canStart(store.state.assets[2], store.state.assets), false);
  await assert.rejects(() => addBlender3d(ctx, "HF-03"), /HF-03 is not line art\./);
  await assert.rejects(() => addBlender3d(ctx, "HF-04"), /HF-04 is not line art\./);
  await assert.rejects(() => addBlender3d(ctx, "HF-99"), /Unknown shot HF-99/);
});

const sfxItem = (o = {}) => ({ id: "SFX-01", cue: "door creak", prompt: "a door creaks", durationS: 3, loop: false, source: "stableaudio", takes: [], chosen: null, approved: false, node: null, est: null, ...o });
const scoreItem = (o = {}) => ({ id: "SCORE", cue: "Score", prompt: "calm strings", durationS: 400, takes: [], chosen: null, approved: false, node: null, est: null, ...o });

test("holders lists b-roll, then the score, then the cues", async () => {
  const { holders } = await import("../js/redo.js");
  assert.deepEqual(holders({}).map((h) => h.id), []);
  assert.deepEqual(holders({ assets: [hf()], audio: { score: scoreItem(), sfx: [sfxItem()] } }).map((h) => h.id), ["HF-01", "SCORE", "SFX-01"]);
});

test("a done job for a cue sets the take's file and measurements", async () => {
  const { ctx, store, jobs } = await setup([]);
  await store.update((d) => { d.audio = { flowId: null, score: null, sfx: [sfxItem({ takes: [{ n: 1, source: "stableaudio", prompt: "p", status: "queued", at: 1 }], chosen: 1 })] }; });
  jobs.restore([{ id: "j1", film: DIR, assetId: "SFX-01", take: 1, tool: "stableaudio", lane: "gpu", status: "done", file: "S:\\x.wav", meta: { lengthS: 2.4, peakDb: -40, meanDb: -60, quiet: true, source: "stableaudio" }, input: {} }]);
  const stop = watchJobs(ctx);
  await tick();
  const t = store.state.audio.sfx[0].takes[0];
  assert.equal(t.status, "done");
  assert.equal(t.file, "S:\\x.wav");
  assert.equal(t.lengthS, 2.4);
  assert.equal(t.peakDb, -40);
  assert.equal(t.meanDb, -60);
  assert.equal(t.quiet, true);
  assert.equal(t.jobId, "j1");
  stop();
});

test("a busy score take with no job is marked lost", async () => {
  const { ctx, store } = await setup([]);
  await store.update((d) => { d.audio = { flowId: "F", score: scoreItem({ takes: [{ n: 1, source: "elevenlabs", prompt: "p", status: "running", at: 1 }], chosen: 1 }), sfx: [] }; });
  const stop = watchJobs(ctx);
  await tick();
  const t = store.state.audio.score.takes[0];
  assert.equal(t.status, "interrupted");
  assert.equal(t.error, "Lost track of this job");
  stop();
});

const lineart2 = () => hf({ id: "HF-02", lineIndex: 3, line: "L3", desc: "A Lighthouse at dusk", approved: true });

test("addAnimated adds a ComfyUI animated version beside its drawing, once", async () => {
  const { ctx, store } = await setup([lineart2(), hf({ id: "HF-07", kind: "broll", lineIndex: 5 })]);
  const id = await addAnimated(ctx, "HF-02");
  assert.equal(id, "HF-08");
  assert.deepEqual(store.state.assets.find((a) => a.id === id), {
    id: "HF-08", kind: "animated", tool: "comfyui", sourceId: "HF-02", line: "L3", lineIndex: 3,
    desc: "Animated version of a Lighthouse at dusk",
    draftPrompt: "a Lighthouse at dusk; slow orbit around it, keep the hand-drawn amber line-art style on black, no new colours",
    takes: [], chosen: 0, approved: false,
  });
  assert.equal(hasDerived(store.state.assets, "HF-02", "animated"), true);
  assert.equal(has3d(store.state.assets, "HF-02"), false);
  await assert.rejects(() => addAnimated(ctx, "HF-02"), /HF-02 already has an animated version\./);
  await assert.rejects(() => addAnimated(ctx, "HF-07"), /HF-07 is not line art\./);
  assert.equal(canStart(store.state.assets.find((a) => a.id === id), store.state.assets), true);
});

test("addAnimated waits for the drawing to be approved", async () => {
  const { ctx, store } = await setup([hf()]);
  const id = await addAnimated(ctx, "HF-01");
  assert.equal(canStart(store.state.assets.find((a) => a.id === id), store.state.assets), false);
  await assert.rejects(() => startTake(ctx, id), /needs its source line art approved/);
});

test("removeVersion moves a derived version to removed, and a re-made one gets a new id", async () => {
  const { ctx, store, host } = await setup([lineart2()]);
  const id = await addBlender3d(ctx, "HF-02");
  assert.equal(id, "HF-03");
  await removeVersion(ctx, id);
  assert.equal(store.state.assets.some((a) => a.id === id), false);
  assert.equal(store.state.removed.length, 1);
  assert.equal(store.state.removed[0].id, id);
  assert.equal(store.state.removed[0].removedAt, host.now());
  assert.equal(has3d(store.state.assets, "HF-02"), false);
  const again = await addBlender3d(ctx, "HF-02");
  assert.equal(again, "HF-04");
  const anim = await addAnimated(ctx, "HF-02");
  assert.equal(anim, "HF-05");
  await removeVersion(ctx, anim);
  assert.equal(await addAnimated(ctx, "HF-02"), "HF-06");
});

test("removeVersion refuses while a take runs or is starting, and for line art or b-roll", async () => {
  const { ctx, store } = await setup([lineart2(), hf({ id: "HF-09", kind: "broll" })], idle);
  const id = await addAnimated(ctx, "HF-02");
  await store.update((d) => { d.assets.find((a) => a.id === id).takes = [{ n: 1, status: "running" }]; });
  await assert.rejects(() => removeVersion(ctx, id), new RegExp(`${id} has a take in progress\\.`));
  await store.update((d) => { d.assets.find((a) => a.id === id).takes = [{ n: 1, status: "done", file: "x.mp4" }]; });
  store.pending.add(`${id}#2`);
  await assert.rejects(() => removeVersion(ctx, id), /has a take in progress\./);
  store.pending.delete(`${id}#2`);
  await assert.rejects(() => removeVersion(ctx, "HF-02"), /HF-02 is not a 3D or animated version\./);
  await assert.rejects(() => removeVersion(ctx, "HF-09"), /HF-09 is not a 3D or animated version\./);
  await assert.rejects(() => removeVersion(ctx, "HF-99"), /Unknown shot HF-99/);
  await removeVersion(ctx, id);
  assert.equal(store.state.removed[0].takes[0].file, "x.mp4");
});

test("startTake for an animated asset sends a ComfyUI video input from the drawing's chosen take", async () => {
  const src = lineart2();
  src.takes = [{ n: 1, status: "done", file: "a.png" }, { n: 2, status: "done", file: "b.png" }];
  src.chosen = 2;
  const { ctx, store, jobs } = await setup([src], { comfyui: { start: () => new Promise(() => {}) } });
  const id = await addAnimated(ctx, "HF-02");
  const t = await startTake(ctx, id);
  assert.equal(t.prompt, "a Lighthouse at dusk; slow orbit around it, keep the hand-drawn amber line-art style on black, no new colours");
  const [j] = jobs.list();
  assert.equal(j.tool, "comfyui");
  assert.deepEqual(j.input, { kind: "animated", prompt: t.prompt, out: DIR + `\\studio\\media\\${id}_t1.mp4`, sourceFile: "b.png" });
  assert.equal(store.state.assets.find((a) => a.id === id).takes[0].tool, "comfyui");
});

test("startTake fails cleanly when the version is removed during the prompt rewrite", async () => {
  const src = lineart2();
  const { ctx, host, store } = await setup([src], idle);
  const id = await addAnimated(ctx, "HF-02");
  await store.update((d) => { d.assets.find((a) => a.id === id).takes = [{ n: 1, status: "failed", prompt: "old", at: 1 }]; });
  host.claudeScript(async () => {
    await store.update((d) => { d.removed = [d.assets.find((a) => a.id === id)]; d.assets = d.assets.filter((a) => a.id !== id); });
    return { prompt: "new" };
  });
  await assert.rejects(() => startTake(ctx, id, { note: "n" }), new RegExp(`${id} changed while the take was being prepared\\.`));
});

test("blender redo: the previous still is the chosen script's round, none when that round crashed", async () => {
  const src = hf({ takes: [{ n: 1, prompt: "p", status: "done", file: "S:\\a.png", at: 1 }], chosen: 1, approved: true });
  const pb = DIR + "\\studio\\blender\\HF-02_t1";
  const prev = { n: 1, status: "failed", error: "Blender stopped", at: 1 };
  const { ctx, host, jobs } = await setup([src, bl({ takes: [prev], chosen: 1 })], idle);
  await host.fs.mkdir(DIR + "\\studio\\blender");
  // Round 2's script was written by round 1's fix, but its still never came (crash): no still at all.
  for (const f of ["_r1.py", "_r2.py", "_check1.png"]) host.files.set(pb + f, "x");
  await startTake(ctx, "HF-02", { note: "n" });
  const input = jobs.list()[0].input;
  assert.equal(input.previousScript, pb + "_r2.py");
  assert.equal(input.previousStill, undefined);
});

test("jobGone: a job whose shot was removed from the review", () => {
  const state = { assets: [bl()], audio: { score: { id: "SCORE", takes: [] }, sfx: [{ id: "SFX-01", takes: [] }] } };
  assert.equal(jobGone(state, { assetId: "HF-02" }), false);
  assert.equal(jobGone(state, { assetId: "SCORE" }), false);
  assert.equal(jobGone(state, { assetId: "SFX-01" }), false);
  assert.equal(jobGone(state, { assetId: "HF-07" }), true);
  assert.equal(jobGone(state, {}), false, "a job without a shot is never gone");
  assert.equal(jobGone(null, { assetId: "HF-07" }), false, "unknown state: not refused");
  assert.equal(removedText("HF-07"), "HF-07 was removed from the review.");
});

test("jobRemoved: Retry and Check refuse a job whose shot was removed, for the open film or one on disk", async () => {
  const { ctx, host, store } = await setup([hf({ approved: true }), bl()], idle);
  await removeVersion(ctx, "HF-02");
  const job = { id: "j", film: DIR, assetId: "HF-02", take: 1, tool: "blender" };
  assert.equal(await jobRemoved(host, job, store), "HF-02 was removed from the review.");
  assert.equal(await jobRemoved(host, { ...job, assetId: "HF-01" }, store), null);
  // Not the open film: its state is read from disk.
  assert.equal(await jobRemoved(host, job, null), "HF-02 was removed from the review.");
  // A film whose state can't be read is not refused.
  assert.equal(await jobRemoved(host, { ...job, film: "S:\\Youtube video ideas\\Nope" }, null), null);
});
