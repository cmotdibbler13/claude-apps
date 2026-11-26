import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { makeJobs } from "../js/jobs.js";
import { startTake, watchJobs, approve, unapprove, choose, canStart, setTool, setPreferComfy, addBlender3d, has3d } from "../js/redo.js";

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
  host.claudeScript(() => ({ script: "print(1)", frames: 48 }));
  const t = await startTake(ctx, "HF-02");
  assert.equal(t.script, DIR + "\\studio\\blender\\HF-02_t1.py");
  assert.deepEqual(jobs.list()[0].input, {
    kind: "blender", script: t.script, sourceFile: "S:\\a.png", out: DIR + "\\studio\\media\\HF-02_t1.mp4", frames: 48,
  });
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
  host.spawnScript((cmd, args, o, ctl) => {
    for (let i = 1; i <= 200; i++) ctl.out(`Fra:${i} Mem:1M | Rendering\nFra:${i} Mem:1M | Sample 1/64\n`);
    host.files.set(args.at(-1), "x");
    ctl.exit(0);
  });
  const jobs = makeJobs(host, { runners: { blender: makeBlenderRunner() }, file: "S:\\Youtube video ideas\\.studio-jobs.json" });
  watchJobs({ host, store, jobs });
  jobs.add({ film: DIR, assetId: "HF-02", take: 1, tool: "blender", input: { script: "s.py", sourceFile: "a.png", out: DIR + "\\studio\\media\\HF-02_t1.mp4", frames: 200 } });
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
