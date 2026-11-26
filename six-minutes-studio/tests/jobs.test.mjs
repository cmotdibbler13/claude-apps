import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeJobs } from "../js/jobs.js";

const ROOT = "S:\\Youtube video ideas";
const FILE = ROOT + "\\.studio-jobs.json";
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const spec = (tool, extra = {}) => ({ film: "Film A", assetId: "a1", take: 1, tool, what: "w", why: "y", ...extra });

async function setup(runners) {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  return { host, jobs: makeJobs(host, { runners, file: FILE }) };
}
const statuses = (jobs) => jobs.list().map((j) => j.status);

test("gpu lane runs one job at a time", async () => {
  const ds = [];
  const blender = { lane: "gpu", start: () => { const d = deferred(); ds.push(d); return d.promise; } };
  const { jobs } = await setup({ blender });
  jobs.add(spec("blender")); jobs.add(spec("blender"));
  await tick();
  assert.deepEqual(statuses(jobs), ["running", "queued"]);
  ds[0].resolve({ file: "a.mp4" });
  await tick(); await tick();
  assert.deepEqual(statuses(jobs), ["done", "running"]);
  assert.equal(jobs.list()[0].file, "a.mp4");
  ds[1].resolve({ file: "b.mp4" });
  await tick(); await tick();
  assert.deepEqual(statuses(jobs), ["done", "done"]);
});

test("connector lane runs up to 3 at once", async () => {
  const ds = [];
  const higgsfield = { lane: "connector", start: () => { const d = deferred(); ds.push(d); return d.promise; } };
  const { jobs } = await setup({ higgsfield });
  for (let i = 0; i < 5; i++) jobs.add(spec("higgsfield"));
  await tick();
  assert.deepEqual(statuses(jobs), ["running", "running", "running", "queued", "queued"]);
  ds[0].resolve({ file: "x" });
  await tick(); await tick();
  assert.deepEqual(statuses(jobs), ["done", "running", "running", "running", "queued"]);
});

test("progress updates notify listeners", async () => {
  const d = deferred();
  let ctx;
  const blender = { lane: "gpu", start: (j, c) => { ctx = c; return d.promise; } };
  const { jobs } = await setup({ blender });
  const seen = [];
  const off = jobs.onChange((list) => seen.push(list.map((j) => [j.progress, j.eta])));
  jobs.add(spec("blender"));
  await tick();
  ctx.progress(0.5, "2 min");
  assert.deepEqual(seen.at(-1), [[0.5, "2 min"]]);
  assert.equal(jobs.list()[0].progress, 0.5);
  off();
  const n = seen.length;
  ctx.progress(0.7);
  assert.equal(seen.length, n);
  d.resolve({ file: "f" });
});

test("runner rejection marks job failed with message and does not retry", async () => {
  let calls = 0;
  const higgsfield = { lane: "connector", start: async () => { calls++; throw new Error("no credits"); } };
  const { jobs } = await setup({ higgsfield });
  const id = jobs.add(spec("higgsfield"));
  await tick(); await tick(); await tick();
  const j = jobs.list()[0];
  assert.equal(j.status, "failed");
  assert.equal(j.error, "no credits");
  assert.ok(j.endedAt);
  assert.equal(calls, 1);
  assert.equal(jobs.list().length, 1);
  const id2 = jobs.retry(id);
  assert.notEqual(id2, id);
  await tick();
  assert.equal(calls, 2);
  assert.equal(jobs.list().length, 2);
  assert.equal(jobs.list()[0].status, "failed");
});

test("retry refuses jobs that are not failed or interrupted", async () => {
  const blender = { lane: "gpu", start: () => new Promise(() => {}) };
  const { jobs } = await setup({ blender });
  const id = jobs.add(spec("blender"));
  await tick();
  assert.throws(() => jobs.retry(id));
});

test("list returns snapshots", async () => {
  const { jobs } = await setup({ blender: { lane: "gpu", start: () => new Promise(() => {}) } });
  jobs.add(spec("blender"));
  jobs.list()[0].status = "done";
  assert.equal(jobs.list()[0].status, "running");
});

test("persists to the jobs file via temp then rename, including setRef", async () => {
  const d = deferred();
  let ctx;
  const higgsfield = { lane: "connector", start: (j, c) => { ctx = c; return d.promise; } };
  const { host, jobs } = await setup({ higgsfield });
  const ops = [];
  const { write, rename } = host.fs;
  host.fs.write = async (p, x) => { ops.push(["write", p]); return write(p, x); };
  host.fs.rename = async (a, b) => { ops.push(["rename", a, b]); return rename(a, b); };
  jobs.add(spec("higgsfield"));
  await tick();
  ctx.setRef("job-123");
  await jobs.flush();
  assert.equal(jobs.list()[0].jobRef, "job-123");
  const saved = JSON.parse(await host.fs.read(FILE, "utf8"));
  assert.equal(saved[0].jobRef, "job-123");
  assert.equal(saved[0].status, "running");
  assert.deepEqual(ops.slice(0, 2), [["write", FILE + ".tmp"], ["rename", FILE + ".tmp", FILE]]);
  assert.equal(await host.fs.exists(FILE + ".tmp"), false);
  d.resolve({ file: "f" });
});

test("restore marks local running jobs interrupted and keeps connector jobs", async () => {
  const resumed = [], started = [];
  const higgsfield = {
    lane: "connector",
    start: async (j) => { started.push(j.id); return { file: "s" }; },
    resume: async (j) => { resumed.push(j.jobRef); return { file: "r" }; },
  };
  const blender = { lane: "gpu", start: async (j) => { started.push(j.id); return { file: "b" }; } };
  const { jobs } = await setup({ higgsfield, blender });
  const base = { film: "F", assetId: "a", take: 1, what: "w", why: "y", progress: null, eta: null };
  jobs.restore([
    { ...base, id: "b1", tool: "blender", lane: "gpu", status: "running" },
    { ...base, id: "b2", tool: "blender", lane: "gpu", status: "queued" },
    { ...base, id: "h1", tool: "higgsfield", lane: "connector", status: "running", jobRef: "R1" },
    { ...base, id: "h2", tool: "higgsfield", lane: "connector", status: "running" },
    { ...base, id: "h3", tool: "higgsfield", lane: "connector", status: "queued" },
    { ...base, id: "h4", tool: "higgsfield", lane: "connector", status: "failed", error: "x" },
    { ...base, id: "h5", tool: "higgsfield", lane: "connector", status: "done" },
  ]);
  await tick(); await tick(); await tick();
  const by = Object.fromEntries(jobs.list().map((j) => [j.id, j.status]));
  assert.deepEqual(by, { b1: "interrupted", b2: "done", h1: "done", h2: "interrupted", h3: "done", h4: "failed", h5: "done" });
  assert.deepEqual(resumed, ["R1"]);
  assert.deepEqual(started.sort(), ["b2", "h3"]);
  assert.equal(jobs.list().find((j) => j.id === "h1").file, "r");
});

test("toJSON round-trips through restore", async () => {
  const { jobs } = await setup({ blender: { lane: "gpu", start: () => new Promise(() => {}) } });
  jobs.add(spec("blender"));
  await tick();
  const json = jobs.toJSON();
  assert.equal(json[0].status, "running");
  assert.doesNotThrow(() => JSON.stringify(json));
});
