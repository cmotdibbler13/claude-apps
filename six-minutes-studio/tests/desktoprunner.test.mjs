import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeJobs } from "../js/jobs.js";
import { makeDesktopRunner, withdraw, tidyRequests } from "../js/tools/desktop.js";
import { listRequests, readAnswer, writeAnswer, listChecks, writeRequest } from "../js/queue.js";

const ROOT = "N:\\Youtube video ideas";
const QDIR = ROOT + "\\.studio-queue";
let gen = 0; // each test's loops stop once the test is over
afterEach(() => { gen++; });
const tick = () => new Promise((r) => setImmediate(r));
const spec = (extra = {}) => ({ film: "F", assetId: "a1", take: 2, tool: "comfyui", what: "w", why: "y", input: { p: 1 }, ...extra });
const peer = (o = {}) => ({ computer: "DESK", role: "desktop", seen: true, lastSeen: 1, paused: false, running: 0, waiting: 0, tools: {}, ...o });

async function setup({ peers = [peer()], poll = 5000 } = {}) {
  const mine = gen;
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  const state = { peers };
  const sleep = async () => { if (mine !== gen) throw new Error('stop'); host.t += poll; await tick(); };
  const runner = makeDesktopRunner({ root: ROOT, computer: "LAP", spellings: ["S:\\Youtube video ideas"], peers: () => state.peers, poll, sleep });
  const jobs = makeJobs(host, { runners: { comfyui: runner }, file: ROOT + "\\.studio-jobs-LAP.json" });
  return { host, state, runner, jobs };
}
const answer = (o) => ({ id: "x", by: "DESK", status: "running", progress: null, eta: null, ...o });
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

test("start writes one request and sets the ref; waiting shows busy desktop", async () => {
  const { host, state, jobs } = await setup({ peers: [peer({ running: 1 })] });
  const id = jobs.add(spec());
  await settle();
  const j = jobs.list()[0];
  const rid = `LAP-${id}`;
  assert.equal(j.jobRef, rid);
  assert.equal(j.remote, "waiting");
  assert.equal(j.eta, "Waiting for the desktop (busy)");
  const reqs = await listRequests(host, ROOT);
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0].job, { film: "F", assetId: "a1", take: 2, tool: "comfyui", what: "w", why: "y", input: { p: 1 } });
  assert.equal(reqs[0].from, "LAP");
  assert.equal(reqs[0].root, ROOT);
  assert.equal(reqs[0].id, rid);
  state.peers = [];
  await settle();
  assert.equal(jobs.list()[0].eta, "Waiting for the desktop (not seen yet)");
});

test("running answer shows percent or the desktop's eta", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  const rid = `LAP-${id}`;
  await writeAnswer(host, ROOT, answer({ id: rid, progress: 0.4 }));
  await settle();
  let j = jobs.list()[0];
  assert.equal(j.remote, "running");
  assert.equal(j.progress, 0.4);
  assert.equal(j.eta, "On the desktop: 40%");
  await writeAnswer(host, ROOT, answer({ id: rid, progress: 0.5, eta: "2 min left" }));
  await settle();
  assert.equal(jobs.list()[0].eta, "On the desktop: 2 min left");
});

test("done answer rebases the file and moves the request", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  const rid = `LAP-${id}`;
  await writeAnswer(host, ROOT, answer({ id: rid, status: "done", file: "S:\\Youtube video ideas\\out\\a.mp4", meta: { path: "S:\\Youtube video ideas\\m.json", n: 1 } }));
  await settle();
  const j = jobs.list()[0];
  assert.equal(j.status, "done");
  assert.equal(j.file, "N:\\Youtube video ideas\\out\\a.mp4");
  assert.deepEqual(j.meta, { path: "N:\\Youtube video ideas\\m.json", n: 1 });
  assert.equal((await listRequests(host, ROOT)).length, 0);
  assert.ok(host.files.has(`${QDIR}\\finished\\${rid}.request.json`.toLowerCase().replace(/\\/g, "/")) || [...host.files.keys()].some((k) => /finished/i.test(k) && /request/.test(k)));
});

test("failed answer: non-ambiguous moves the request", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  await writeAnswer(host, ROOT, answer({ id: `LAP-${id}`, status: "failed", error: "Out of memory" }));
  await settle();
  const j = jobs.list()[0];
  assert.equal(j.status, "failed");
  assert.equal(j.error, "On the desktop: Out of memory");
  assert.equal(j.ambiguous, undefined);
  assert.equal((await listRequests(host, ROOT)).length, 0);
});

test("failed ambiguous keeps the request and flags the job", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  await writeAnswer(host, ROOT, answer({ id: `LAP-${id}`, status: "failed", error: "Lost it", ambiguous: true }));
  await settle();
  const j = jobs.list()[0];
  assert.equal(j.status, "failed");
  assert.equal(j.ambiguous, true);
  assert.equal((await listRequests(host, ROOT)).length, 1);
});

test("restore resumes without a second request, and finishes when the answer arrives", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  await jobs.flush();
  const saved = JSON.parse(await host.fs.read(ROOT + "\\.studio-jobs-LAP.json", "utf8"));
  assert.equal(saved[0].status, "running");
  const mine = gen;
  // same host contents: build a fresh queue on the original host
  const runner = makeDesktopRunner({ root: ROOT, computer: "LAP", spellings: ["S:\\Youtube video ideas"], peers: () => [peer()], poll: 5000, sleep: async () => { if (mine !== gen) throw new Error('stop'); host.t += 5000; await tick(); } });
  const jobs2 = makeJobs(host, { runners: { comfyui: runner } });
  jobs2.restore(saved);
  await settle();
  assert.equal((await listRequests(host, ROOT)).length, 1);
  assert.equal(jobs2.list()[0].status, "running");
  await writeAnswer(host, ROOT, answer({ id: `LAP-${id}`, status: "done", file: "S:\\Youtube video ideas\\a.mp4" }));
  await settle();
  assert.equal(jobs2.list()[0].status, "done");
  assert.equal(jobs2.list()[0].file, "N:\\Youtube video ideas\\a.mp4");
});

test("Check on an ambiguous failure writes a check and waits for the desktop to answer it", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  const rid = `LAP-${id}`;
  await writeAnswer(host, ROOT, answer({ id: rid, status: "failed", error: "Lost it", ambiguous: true, progress: 0.3 }));
  await settle();
  jobs.check(id);
  await settle();
  const checks = await listChecks(host, ROOT, rid);
  assert.equal(checks.length, 1);
  let j = jobs.list()[0];
  assert.equal(j.status, "running");
  assert.equal(j.remote, "running");
  assert.equal(j.eta, "Waiting for the desktop");
  assert.equal((await listRequests(host, ROOT)).length, 1);
  await writeAnswer(host, ROOT, answer({ id: rid, status: "failed", error: "Still gone", ambiguous: true, checks }));
  await settle();
  j = jobs.list()[0];
  assert.equal(j.status, "failed");
  assert.equal(j.error, "On the desktop: Still gone");
});

test("withdraw with no desktop seen fails Withdrawn within a poll", async () => {
  const { host, jobs, state } = await setup({ peers: [] });
  const id = jobs.add(spec());
  await settle();
  await withdraw(host, ROOT, jobs.list()[0]);
  await settle();
  const j = jobs.list()[0];
  assert.equal(j.status, "failed");
  assert.equal(j.error, "Withdrawn");
  assert.equal((await listRequests(host, ROOT)).length, 0);
  void id; void state;
});

test("withdraw while the desktop is ready keeps waiting; a running answer carries on", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  await withdraw(host, ROOT, jobs.list()[0]);
  await settle();
  assert.equal(jobs.list()[0].status, "running");
  await writeAnswer(host, ROOT, answer({ id: `LAP-${id}`, progress: 0.2 }));
  await settle();
  assert.equal(jobs.list()[0].eta, "On the desktop: 20%");
  await writeAnswer(host, ROOT, answer({ id: `LAP-${id}`, status: "withdrawn" }));
  await settle();
  assert.equal(jobs.list()[0].error, "Withdrawn");
});

test("tidyRequests moves an orphan and leaves a matched one", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await writeRequest(host, ROOT, { id: "LAP-j1", from: "LAP", root: ROOT, job: {} });
  await writeRequest(host, ROOT, { id: "LAP-j2", from: "LAP", root: ROOT, job: {} });
  await writeRequest(host, ROOT, { id: "OTHER-j3", from: "OTHER", root: ROOT, job: {} });
  await tidyRequests(host, ROOT, "LAP", [{ id: "j1" }]);
  assert.deepEqual((await listRequests(host, ROOT)).map((r) => r.id).sort(), ["LAP-j1", "OTHER-j3"]);
  void readAnswer;
});

// A fresh laptop Studio on the same shared folder, restoring `saved`.
function reopen(host, saved, peers = [peer()]) {
  const mine = gen;
  const runner = makeDesktopRunner({ root: ROOT, computer: "LAP", spellings: ["S:\\Youtube video ideas"], peers: () => peers, poll: 5000, sleep: async () => { if (mine !== gen) throw new Error("stop"); host.t += 5000; await tick(); } });
  const jobs = makeJobs(host, { runners: { comfyui: runner } });
  jobs.restore(saved);
  return jobs;
}

test("start sets the job's reference before it writes the request", async () => {
  const { host, jobs } = await setup();
  const refs = [];
  const wr = host.fs.write;
  host.fs.write = async (p, d) => { if (/\.request\.json/.test(p)) refs.push(jobs.list()[0].jobRef); return wr(p, d); };
  const id = jobs.add(spec());
  await settle();
  assert.deepEqual(refs, [`LAP-${id}`]);
});

test("resume after closing before the request was written sends it then, once", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  const saved = [{ id: "j1", ...spec(), lane: "gpu", status: "running", progress: null, eta: null, jobRef: "LAP-j1" }];
  const jobs = reopen(host, saved);
  await settle();
  const reqs = await listRequests(host, ROOT);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].id, "LAP-j1");
  assert.deepEqual(reqs[0].job, { film: "F", assetId: "a1", take: 2, tool: "comfyui", what: "w", why: "y", input: { p: 1 } });
  assert.equal(jobs.list()[0].eta, "Waiting for the desktop");
  await writeAnswer(host, ROOT, answer({ id: "LAP-j1", status: "done", file: "S:\\Youtube video ideas\\a.mp4" }));
  await settle();
  assert.equal(jobs.list()[0].status, "done");
  assert.equal((await listRequests(host, ROOT)).length, 0);
});

test("resume never writes a second request when one is filed, or when a withdrawal is there", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await writeRequest(host, ROOT, { id: "LAP-j1", from: "LAP", root: ROOT, job: {} });
  const { moveMine, writeWithdrawn } = await import("../js/queue.js");
  await moveMine(host, ROOT, "LAP-j1", "laptop");
  await writeWithdrawn(host, ROOT, "LAP-j2");
  const job = (id) => ({ id, ...spec(), lane: "gpu", status: "running", progress: null, eta: null, jobRef: `LAP-${id}` });
  const jobs = reopen(host, [job("j1"), job("j2")]);
  await settle(60);
  assert.equal((await listRequests(host, ROOT)).length, 0);
  assert.deepEqual(jobs.list().map((j) => [j.status, j.error]), [["failed", "Withdrawn"], ["failed", "Withdrawn"]]);
});

test("closing after filing the request but before saving done: reopening reads the filed answer", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  const { moveMine } = await import("../js/queue.js");
  const file = async (id, a) => {
    await writeRequest(host, ROOT, { id, from: "LAP", root: ROOT, job: {} });
    if (a) await writeAnswer(host, ROOT, answer({ id, ...a }));
    await moveMine(host, ROOT, id, "laptop");
    if (a) await moveMine(host, ROOT, id, "desktop");
  };
  await file("LAP-j1", { status: "done", file: "S:\\Youtube video ideas\\a.mp4" });
  await file("LAP-j2", { status: "withdrawn" });
  await file("LAP-j3", { status: "failed", error: "Out of memory" });
  await file("LAP-j4", null);
  const job = (id) => ({ id, ...spec(), lane: "gpu", status: "running", progress: null, eta: null, jobRef: `LAP-${id}` });
  const jobs = reopen(host, ["j1", "j2", "j3", "j4"].map(job));
  await settle(80);
  const got = jobs.list().map((j) => [j.status, j.file ?? j.error]);
  assert.deepEqual(got, [
    ["done", "N:\\Youtube video ideas\\a.mp4"],
    ["failed", "Withdrawn"],
    ["failed", "On the desktop: Out of memory"],
    ["failed", "Withdrawn"],
  ]);
});

test("a running answer with no progress says starting", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  await writeAnswer(host, ROOT, answer({ id: `LAP-${id}` }));
  await settle();
  assert.equal(jobs.list()[0].eta, "On the desktop: starting");
});

test("a desktop failure that already says on the desktop is not prefixed twice", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  await writeAnswer(host, ROOT, answer({ id: `LAP-${id}`, status: "failed", error: "Interrupted on the desktop; press Retry" }));
  await settle();
  assert.equal(jobs.list()[0].error, "Interrupted on the desktop; press Retry");
});

test("restore of a job whose answer is failed and ambiguous writes no check; it fails for Jon to Check", async () => {
  const { host, jobs } = await setup();
  const id = jobs.add(spec());
  await settle();
  await jobs.flush();
  const saved = jobs.list();
  gen++; // close the first Studio
  await writeAnswer(host, ROOT, answer({ id: `LAP-${id}`, status: "failed", error: "Lost it", ambiguous: true }));
  const jobs2 = reopen(host, saved);
  await settle();
  assert.equal((await listChecks(host, ROOT, `LAP-${id}`)).length, 0);
  assert.equal(jobs2.list()[0].status, "failed");
  assert.equal(jobs2.list()[0].ambiguous, true);
});

test("withdraw race: a running answer that lands while the laptop files its request wins", async () => {
  const { host, jobs, state } = await setup({ peers: [] });
  const id = jobs.add(spec());
  await settle();
  const rid = `LAP-${id}`;
  const rn = host.fs.rename;
  let once = true;
  host.fs.rename = async (a, b) => {
    if (once && /finished/i.test(b) && /request/.test(a)) { once = false; await writeAnswer(host, ROOT, answer({ id: rid, progress: 0.1 })); }
    return rn(a, b);
  };
  await withdraw(host, ROOT, jobs.list()[0]);
  await settle();
  assert.equal(jobs.list()[0].status, "running");
  assert.equal(jobs.list()[0].eta, "On the desktop: 10%");
  state.peers = [peer()];
  await writeAnswer(host, ROOT, answer({ id: rid, status: "done", file: "S:\\Youtube video ideas\\a.mp4" }));
  await settle();
  assert.equal(jobs.list()[0].status, "done");
});

// Request and answer both filed in finished\ (Studio closed before done was saved).
async function filedDone(host, id) {
  const { moveMine } = await import("../js/queue.js");
  await writeRequest(host, ROOT, { id, from: "LAP", root: ROOT, job: {} });
  await writeAnswer(host, ROOT, answer({ id, status: "done", file: "S:\\Youtube video ideas\\a.mp4" }));
  await moveMine(host, ROOT, id, "laptop");
  await moveMine(host, ROOT, id, "desktop");
}
const savedJob = (id) => ({ id, ...spec(), lane: "gpu", status: "running", progress: null, eta: null, jobRef: `LAP-${id}` });

test("N1: a spurious false from exists, or a failed listing, never writes a second request", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await filedDone(host, "LAP-j1");
  const { exists, list } = host.fs;
  host.fs.exists = async (p) => (/finished/i.test(p) ? false : exists(p));
  let fails = 2;
  host.fs.list = async (d) => { if (fails-- > 0) throw new Error("EIO"); return list(d); };
  const jobs = reopen(host, [savedJob("j1")]);
  await settle(60);
  host.fs.list = list; host.fs.exists = exists;
  assert.equal((await listRequests(host, ROOT)).length, 0);
  assert.equal(jobs.list()[0].status, "done");
  assert.equal(jobs.list()[0].file, "N:\\Youtube video ideas\\a.mp4");
});

test("N2: a failed read or listing of finished\\ keeps waiting, then records the take", async () => {
  for (const kind of ["read", "list"]) {
    const host = new FakeHost();
    await host.fs.mkdir(ROOT);
    await filedDone(host, "LAP-j1");
    const orig = host.fs[kind];
    let fails = 1;
    host.fs[kind] = async (p, ...r) => {
      const hit = kind === "read" ? /finished.*answer/i.test(p) : /finished$/i.test(p);
      if (hit && fails-- > 0) throw new Error("EIO");
      return orig(p, ...r);
    };
    const jobs = reopen(host, [savedJob("j1")]);
    await settle(60);
    assert.ok(fails < 0 || fails === 0, `${kind} failed once`);
    assert.equal(jobs.list()[0].status, "done", kind);
  }
});

test("N3: a failed read after filing on the withdraw path keeps waiting; the desktop's answer wins", async () => {
  const { host, jobs, state } = await setup({ peers: [] });
  const id = jobs.add(spec());
  await settle();
  const rid = `LAP-${id}`;
  const { rename, read } = host.fs;
  let moved = false, fails = 1;
  host.fs.rename = async (a, b) => {
    if (!moved && /finished/i.test(b) && /request/.test(a)) { moved = true; await writeAnswer(host, ROOT, answer({ id: rid, progress: 0.1 })); }
    return rename(a, b);
  };
  host.fs.read = async (p, ...r) => { if (moved && /answer/.test(p) && fails-- > 0) throw new Error("EIO"); return read(p, ...r); };
  await withdraw(host, ROOT, jobs.list()[0]);
  await settle();
  assert.ok(moved && fails < 1);
  assert.equal(jobs.list()[0].status, "running");
  state.peers = [peer()];
  await writeAnswer(host, ROOT, answer({ id: rid, status: "done", file: "S:\\Youtube video ideas\\a.mp4" }));
  await settle();
  assert.equal(jobs.list()[0].status, "done");
});
