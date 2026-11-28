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
  assert.ok(ds[1], "the resume started");
  ds[1].reject(Object.assign(new Error("lost"), { ambiguous: true }));
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

test("after a restart an interrupted laptop job is answered, and a filed one is never read again", async () => {
  const first = await setup();
  const { host } = first;
  await send(host, ID);
  await first.w.tick();
  await settle();
  const saved = first.jobs.list();
  first.w.stop();
  // New process: fresh jobs, fresh worker, same shared folder.
  const jobs = makeJobs(host, { runners: { blender: { lane: "gpu", start: () => new Promise(() => {}) } } });
  jobs.restore(saved);
  const w = makeDesktopWorker({ host, root: ROOT, computer: "DESK", jobs, spellings: [], paused: () => false, now: () => host.now() });
  await w.reconcile();
  await w.tick();
  await settle();
  assert.equal(jobs.list().length, 1);
  const a = await readAnswer(host, ROOT, ID);
  assert.equal(a.status, "failed");
  assert.equal(a.error, "Interrupted on the desktop; press Retry");
  await moveMine(host, ROOT, ID, "laptop");
  await w.tick();
  assert.ok(!host.files.has(q(`${ID}.answer.json`)));
  // Own job on the desktop reports progress: the filed laptop job's answer is not touched.
  let ctx;
  jobs.add({ film: "S:\\f", assetId: "A", take: 1, tool: "blender", input: {} });
  await settle();
  const calls = [];
  for (const k of ["read", "exists", "list"]) {
    const orig = host.fs[k];
    host.fs[k] = async (p, ...r) => { if (String(p).includes(`${ID}.answer`)) calls.push(k); return orig(p, ...r); };
  }
  jobs.list(); void ctx;
  jobs.restore(jobs.list()); // fires change events
  await settle();
  await w.tick();
  assert.deepEqual(calls, []);
});

test("one failed folder listing never re-claims a done request (the job is made once)", async () => {
  let starts = 0;
  const blender = { lane: "gpu", start: async () => { starts++; return { file: "x.mp4" }; } };
  const { host, jobs, w } = await setup({ runners: { blender } });
  await send(host, ID);
  await w.tick(); await settle(); await w.tick();
  assert.equal((await readAnswer(host, ROOT, ID)).status, "done");
  const orig = host.fs.list.bind(host.fs);
  let fail = 1;
  host.fs.list = async (d) => { if (fail-- > 0) throw new Error("EIO"); return orig(d); };
  await w.tick(); await settle();
  host.fs.list = orig;
  await w.tick(); await settle();
  assert.equal(starts, 1);
  assert.equal(jobs.list().length, 1);
  assert.equal((await readAnswer(host, ROOT, ID)).status, "done");
});

test("a request that is already a job's request is never claimed again, even with no answer", async () => {
  const { host, jobs, w } = await setup();
  jobs.add({ film: "S:\\f", assetId: "A", take: 1, tool: "blender", input: {}, from: "LAPTOP", request: ID });
  await settle();
  // its answer went missing; the lane frees up
  jobs.restore(jobs.list().map((j) => ({ ...j, status: "done" })));
  await send(host, ID);
  await w.tick(); await settle();
  assert.equal(jobs.list().length, 1);
});

test("Check: the answer never shows failed with the new check name; it goes straight to running", async () => {
  const { host, jobs, w, ds } = await setup();
  await send(host, ID);
  await w.tick(); await settle();
  jobs.restore(jobs.list().map((j) => ({ ...j, jobRef: "r" })));
  await settle();
  ds[1].reject(Object.assign(new Error("lost"), { ambiguous: true }));
  await settle();
  assert.equal((await readAnswer(host, ROOT, ID)).status, "failed");
  const name = await writeCheck(host, ROOT, ID);
  const written = [];
  const wr = host.fs.write;
  host.fs.write = async (p, d) => { if (/answer/.test(p)) written.push(JSON.parse(d)); return wr(p, d); };
  await w.tick(); await settle();
  assert.ok(written.length >= 1);
  for (const a of written) if ((a.checks ?? []).includes(name)) assert.equal(a.status, "running");
  assert.equal((await readAnswer(host, ROOT, ID)).status, "running");
});

test("a restarted worker meeting a job whose answer is filed settles it; a failed read does not", async () => {
  const first = await setup();
  const { host } = first;
  await send(host, ID);
  await send(host, "LAPTOP-j2");
  await first.w.tick(); await settle();
  first.ds[0].resolve({ file: "S:\\o.mp4" });
  await settle();
  await first.w.tick(); await settle();
  // j1 filed by both sides
  await moveMine(host, ROOT, ID, "laptop");
  await moveMine(host, ROOT, ID, "desktop");
  const saved = first.jobs.list();
  first.w.stop();
  let ctx;
  const jobs = makeJobs(host, { runners: { blender: { lane: "gpu", start: () => new Promise(() => {}), resume: (_j, c) => { ctx = c; return new Promise(() => {}); } } } });
  jobs.restore(saved.map((j) => (j.request === "LAPTOP-j2" ? { ...j, jobRef: "r" } : j)));
  await settle();
  // One failed read of j2's answer while the restarted worker first meets it.
  const read = host.fs.read;
  let failRead = 1;
  host.fs.read = async (p, ...r) => { if (String(p).includes("LAPTOP-j2.answer") && failRead-- > 0) throw new Error("EIO"); return read(p, ...r); };
  const calls = [];
  for (const k of ["read", "exists"]) {
    const orig = host.fs[k];
    host.fs[k] = async (p, ...r) => { if (String(p).includes(`${ID}.answer`)) calls.push(k); return orig(p, ...r); };
  }
  const w = makeDesktopWorker({ host, root: ROOT, computer: "DESK", jobs, spellings: [], paused: () => false, now: () => host.now() });
  ctx.progress(0.3); // the worker first meets both jobs here, through a job change
  await settle();
  assert.ok(failRead <= 0, "the failed read hit the worker's first look");
  await w.tick(); await settle();
  const n = calls.length;
  ctx.progress(0.5, "1 min");
  await settle();
  host.t += 6000;
  await w.tick(); await settle();
  assert.equal(calls.length, n, "a filed answer is settled and not read again");
  const a = await readAnswer(host, ROOT, "LAPTOP-j2");
  assert.equal(a.progress, 0.5);
  assert.equal(a.eta, "1 min");
});

test("N1: a failed read with a spurious false from exists, or a failed listing, settles nothing", async () => {
  for (const how of ["exists", "list"]) {
    const { host, jobs, w } = await setup();
    let ctx;
    const blender = { lane: "gpu", start: (_j, c) => { ctx = c; return new Promise(() => {}); } };
    const jobs2 = makeJobs(host, { runners: { blender } });
    await send(host, ID);
    await w.tick(); await settle();
    w.stop();
    void jobs;
    // A restarted desktop meets the job: its answer read fails once, and the presence check misleads or fails.
    jobs2.add({ film: "S:\\f", assetId: "A", take: 1, tool: "blender", input: {}, from: "LAPTOP", request: ID });
    await settle();
    const { read, exists, list } = host.fs;
    let fails = 1;
    host.fs.read = async (p, ...r) => { if (/answer/.test(p) && fails-- > 0) throw new Error("EIO"); return read(p, ...r); };
    if (how === "exists") host.fs.exists = async () => false;
    else host.fs.list = async (d) => { if (fails >= 0) throw new Error("EIO"); return list(d); };
    const w2 = makeDesktopWorker({ host, root: ROOT, computer: "DESK", jobs: jobs2, spellings: [], paused: () => false, now: () => host.now() });
    ctx.progress(0.3);
    await settle();
    assert.ok(fails <= 0, how);
    host.fs.exists = exists; host.fs.list = list;
    ctx.progress(0.5, "1 min");
    host.t += 6000;
    await w2.tick(); await settle();
    const a = await readAnswer(host, ROOT, ID);
    assert.equal(a.progress, 0.5, how);
    w2.stop();
  }
});
