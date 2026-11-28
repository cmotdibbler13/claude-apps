import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeJobs } from "../js/jobs.js";
import { makeDesktopWorker } from "../js/desktopworker.js";
import { QUEUE_DIR, FINISHED, writeRequest, readAnswer, writeAnswer, writeWithdrawn, writeCheck, moveMine } from "../js/queue.js";

const ROOT = "S:\\Youtube video ideas";
const q = (n) => `${ROOT}\\${QUEUE_DIR}\\${n}`;
const settle = () => new Promise((r) => setTimeout(r, 15));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ID = "LAPTOP-j1";
const request = (id = ID, extra = {}) => ({
  id, from: "LAPTOP", root: "N:\\Youtube video ideas",
  job: { film: "N:\\Youtube video ideas\\Deep Sea", assetId: "BR-07", take: 1, tool: "blender", what: "w", why: "y",
    input: { out: "N:\\Youtube video ideas\\Deep Sea\\studio\\x_t1", sourceFile: "N:\\Youtube video ideas\\Deep Sea\\a.png" } },
  ...extra,
});

async function setup({ runners, paused = false } = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  const ds = [];
  const blender = { lane: "gpu", start: () => { const d = deferred(); ds.push(d); return d.promise; }, resume: () => { const d = deferred(); ds.push(d); return d.promise; } };
  const jobs = makeJobs(host, { runners: runners ?? { blender } });
  const state = { paused };
  const w = makeDesktopWorker({ host, root: ROOT, computer: "DESK", jobs, spellings: ["S:\\Youtube video ideas"], paused: () => state.paused, now: () => host.now() });
  return { host, jobs, w, ds, state };
}
const send = (host, id, extra) => writeRequest(host, ROOT, request(id, extra));

test("a request is claimed, answered running, and its paths re-based to this computer", async () => {
  const { host, jobs, w } = await setup();
  await send(host, ID);
  await w.tick();
  const [j] = jobs.list();
  assert.equal(j.from, "LAPTOP");
  assert.equal(j.request, ID);
  assert.equal(j.film, "S:\\Youtube video ideas\\Deep Sea");
  assert.equal(j.input.out, "S:\\Youtube video ideas\\Deep Sea\\studio\\x_t1");
  assert.equal(j.input.sourceFile, "S:\\Youtube video ideas\\Deep Sea\\a.png");
  const a = await readAnswer(host, ROOT, ID);
  assert.equal(a.status, "running");
  assert.equal(a.by, "DESK");
  assert.deepEqual(a.checks, []);
  assert.deepEqual(w.counts(), { waiting: 0, running: 1 });
});

test("a busy graphics lane claims nothing until it is free", async () => {
  const { host, jobs, w, ds } = await setup();
  jobs.add({ film: "S:\\f", assetId: "A", take: 1, tool: "blender", input: {} });
  await settle();
  await send(host, ID);
  await w.tick();
  assert.equal(jobs.list().length, 1);
  assert.equal(await readAnswer(host, ROOT, ID), null);
  assert.deepEqual(w.counts(), { waiting: 1, running: 0 });
  ds[0].resolve({ file: "a.mp4" });
  await settle();
  await w.tick();
  assert.equal(jobs.list().length, 2);
  assert.equal((await readAnswer(host, ROOT, ID)).status, "running");
});

test("paused claims nothing; resuming claims", async () => {
  const { host, jobs, w, state } = await setup({ paused: true });
  await send(host, ID);
  await w.tick();
  assert.equal(jobs.list().length, 0);
  state.paused = false;
  await w.tick();
  assert.equal(jobs.list().length, 1);
});

test("withdrawn before the claim answers withdrawn and adds no job", async () => {
  const { host, jobs, w } = await setup();
  await send(host, ID);
  await writeWithdrawn(host, ROOT, ID);
  await w.tick();
  assert.equal(jobs.list().length, 0);
  const a = await readAnswer(host, ROOT, ID);
  assert.equal(a.status, "withdrawn");
  assert.equal(a.by, "DESK");
  assert.deepEqual(a.checks, []);
});

test("a withdrawal after the claim leaves the job running", async () => {
  const { host, jobs, w } = await setup();
  await send(host, ID);
  await w.tick();
  await writeWithdrawn(host, ROOT, ID);
  await w.tick();
  assert.equal(jobs.list()[0].status, "running");
  assert.equal((await readAnswer(host, ROOT, ID)).status, "running");
});

test("done writes file and meta at once", async () => {
  const { host, w, ds } = await setup();
  await send(host, ID);
  await w.tick();
  await settle();
  ds[0].resolve({ file: "S:\\o.mp4", meta: { script: "s.py" } });
  await settle();
  const a = await readAnswer(host, ROOT, ID);
  assert.equal(a.status, "done");
  assert.equal(a.file, "S:\\o.mp4");
  assert.deepEqual(a.meta, { script: "s.py" });
  assert.equal(a.progress, 1);
});

test("failure writes the plain error and ambiguous", async () => {
  const { host, w, ds } = await setup();
  await send(host, ID);
  await w.tick();
  await settle();
  ds[0].reject(Object.assign(new Error("Blender fell over"), { ambiguous: true }));
  await settle();
  const a = await readAnswer(host, ROOT, ID);
  assert.equal(a.status, "failed");
  assert.equal(a.error, "Blender fell over");
  assert.equal(a.ambiguous, true);
});

test("progress is written at most every 5 seconds; a status change is at once", async () => {
  let ctx;
  const blender = { lane: "gpu", start: (_j, c) => { ctx = c; return new Promise(() => {}); } };
  const { host, jobs, w } = await setup({ runners: { blender } });
  await send(host, ID);
  await w.tick();
  await settle();
  const writes = [];
  const wr = host.fs.write;
  host.fs.write = async (p, d) => { if (/answer/.test(p)) writes.push(JSON.parse(d).progress); return wr(p, d); };
  host.t += 1000; ctx.progress(0.1); await settle();
  assert.deepEqual(writes, []);
  host.t += 4500; ctx.progress(0.5, "3 min"); await settle();
  assert.deepEqual(writes, [0.5]);
  host.t += 100; ctx.progress(0.6); await settle();
  assert.deepEqual(writes, [0.5]);
  // The held-back progress is flushed by the next tick once 5 s have passed.
  host.t += 5000;
  await w.tick();
  assert.deepEqual(writes, [0.5, 0.6]);
  assert.equal(jobs.list()[0].progress, 0.6);
});

test("interrupted without a ref answers with the exact text", async () => {
  const { host, jobs, w } = await setup();
  await send(host, ID);
  await w.tick();
  await settle();
  jobs.restore(jobs.list());
  await settle();
  const a = await readAnswer(host, ROOT, ID);
  assert.equal(a.status, "failed");
  assert.equal(a.error, "Interrupted on the desktop; press Retry");
});

test("a resumable job after a restart stays running", async () => {
  const { host, jobs, w } = await setup();
  await send(host, ID);
  await w.tick();
  await settle();
  const saved = jobs.list().map((j) => ({ ...j, jobRef: "ref1" }));
  jobs.restore(saved);
  await settle();
  assert.equal(jobs.list()[0].status, "running");
  assert.equal((await readAnswer(host, ROOT, ID)).status, "running");
});

test("reconcile fails an orphan running answer; leaves ones with a job and other computers' answers", async () => {
  const { host, jobs, w } = await setup();
  const base = { progress: null, eta: null, file: null, meta: null, error: null, ambiguous: false, checks: ["c1"] };
  await writeAnswer(host, ROOT, { id: "LAPTOP-j9", by: "DESK", status: "running", ...base });
  await writeAnswer(host, ROOT, { id: "LAPTOP-j8", by: "OTHER", status: "running", ...base });
  await writeAnswer(host, ROOT, { id: "LAPTOP-j7", by: "DESK", status: "running", ...base });
  jobs.add({ film: "S:\\f", assetId: "A", take: 1, tool: "blender", input: {}, from: "LAPTOP", request: "LAPTOP-j7" });
  await w.reconcile();
  const a = await readAnswer(host, ROOT, "LAPTOP-j9");
  assert.equal(a.status, "failed");
  assert.equal(a.error, "Lost on the desktop; press Retry");
  assert.deepEqual(a.checks, ["c1"]);
  assert.equal((await readAnswer(host, ROOT, "LAPTOP-j8")).status, "running");
  assert.equal((await readAnswer(host, ROOT, "LAPTOP-j7")).status, "running");
});

test("a check file triggers jobs.check once and is recorded", async () => {
  const { host, jobs, w, ds } = await setup();
  await send(host, ID);
  await w.tick();
  await settle();
  ds[0].reject(Object.assign(new Error("lost"), { ambiguous: true }));
  await settle();
  jobs.list(); // job has no jobRef: the check is refused but recorded
  const name = await writeCheck(host, ROOT, ID);
  await w.tick();
  let a = await readAnswer(host, ROOT, ID);
  assert.deepEqual(a.checks, [name]);
  assert.equal(a.status, "failed");
  await w.tick();
  assert.deepEqual((await readAnswer(host, ROOT, ID)).checks, [name]);
});

test("a check on a resumable failed job puts the job back to running", async () => {
  const { host, jobs, w, ds } = await setup();
  await send(host, ID);
  await w.tick();
  await settle();
  const jid = jobs.list()[0].id;
  // Give the job a ref the runner can resume.
  const saved = jobs.list().map((j) => ({ ...j, jobRef: "r" }));
  jobs.restore(saved);
  await settle();
  ds[1]?.reject(Object.assign(new Error("lost"), { ambiguous: true }));
  await settle();
  assert.equal(jobs.list()[0].status, "failed");
  assert.equal((await readAnswer(host, ROOT, ID)).status, "failed");
  const name = await writeCheck(host, ROOT, ID);
  await w.tick();
  await settle();
  assert.equal(jobs.list()[0].id, jid);
  assert.equal(jobs.list()[0].status, "running");
  const a = await readAnswer(host, ROOT, ID);
  assert.equal(a.status, "running");
  assert.deepEqual(a.checks, [name]);
});

test("final answers move only after the request is finished", async () => {
  const { host, w, ds } = await setup();
  await send(host, ID);
  await w.tick();
  await settle();
  ds[0].resolve({ file: "S:\\o.mp4" });
  await settle();
  await w.tick();
  assert.ok(host.files.has(q(`${ID}.answer.json`)));
  await moveMine(host, ROOT, ID, "laptop");
  await w.tick();
  assert.ok(!host.files.has(q(`${ID}.answer.json`)));
  assert.ok(host.files.has(`${ROOT}\\${QUEUE_DIR}\\${FINISHED}\\${ID}.answer.json`));
});

test("stop unsubscribes from job changes", async () => {
  const { host, jobs, w } = await setup();
  await send(host, ID);
  await w.tick();
  w.stop();
  jobs.restore(jobs.list());
  await settle();
  assert.equal((await readAnswer(host, ROOT, ID)).status, "running");
});
