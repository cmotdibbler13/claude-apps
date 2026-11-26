import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeJobs } from "../js/jobs.js";
import { openFilm } from "../js/store.js";
import { watchJobs } from "../js/redo.js";
import { makeFilmSession, readSavedJobs } from "../js/session.js";

const ROOT = "S:\\Youtube video ideas";
const A = ROOT + "\\Film A", B = ROOT + "\\Film B";

function setup() {
  const host = new FakeHost();
  const jobs = makeJobs(host, {});
  const opened = [], watching = new Set();
  const session = makeFilmSession({
    host, jobs,
    open: async (h, dir) => { await new Promise((r) => setTimeout(r, 5)); const s = await openFilm(h, dir); opened.push(s); return s; },
    watch: (ctx) => { const off = watchJobs(ctx); watching.add(ctx.store); return () => { off(); watching.delete(ctx.store); }; },
  });
  return { host, jobs, session, opened, watching };
}

test("opening the same film twice at once makes one store and one watcher", async () => {
  const { host, session, opened, watching } = setup();
  await host.fs.mkdir(A);
  const [s1, s2] = await Promise.all([session.open(A), session.open(A)]);
  assert.equal(s1, s2);
  assert.equal(opened.length, 1);
  assert.equal(watching.size, 1);
  assert.equal(await session.open(A), s1, "already open: same store");
  assert.equal(opened.length, 1);
});

test("opening A then B quickly watches only B", async () => {
  const { host, session, watching } = setup();
  await host.fs.mkdir(A); await host.fs.mkdir(B);
  const pa = session.open(A);
  const pb = session.open(B);
  const [sa, sb] = await Promise.all([pa, pb]);
  assert.equal(sa, null, "superseded open is discarded");
  assert.equal(sb.dir, B);
  assert.deepEqual([...watching].map((s) => s.dir), [B]);
  assert.equal(session.current.dir, B);
});

test("switching films unwatches the old one", async () => {
  const { host, session, watching } = setup();
  await host.fs.mkdir(A); await host.fs.mkdir(B);
  await session.open(A);
  await session.open(B);
  assert.deepEqual([...watching].map((s) => s.dir), [B]);
  session.close();
  assert.equal(watching.size, 0);
  assert.equal(session.current, null);
});

test("saved updates call onSaved", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(A);
  let n = 0;
  const session = makeFilmSession({ host, jobs: makeJobs(host, {}), onSaved: () => { n++; } });
  const s = await session.open(A);
  await s.update((d) => { d.waiting = "x"; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(n, 1);
});

const FILE = ROOT + "\\.studio-jobs.json";

test("saved jobs: missing file gives [] and moves nothing", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  assert.deepEqual(await readSavedJobs(host, FILE), []);
  assert.deepEqual([...host.files.keys()], []);
});

test("saved jobs: valid file is returned", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(FILE, JSON.stringify([{ id: "j1", jobRef: "abc" }]));
  assert.deepEqual(await readSavedJobs(host, FILE), [{ id: "j1", jobRef: "abc" }]);
  assert.ok(await host.fs.exists(FILE));
});

test("saved jobs: unreadable or bad file is renamed aside before starting empty", async () => {
  for (const bad of ["{not json", JSON.stringify({ not: "an array" })]) {
    const host = new FakeHost();
    await host.fs.mkdir(ROOT);
    await host.fs.write(FILE, bad);
    assert.deepEqual(await readSavedJobs(host, FILE), []);
    assert.equal(await host.fs.exists(FILE), false);
    assert.equal(await host.fs.read(`${ROOT}\\.studio-jobs.bad-${host.now()}.json`, "utf8"), bad);
  }
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(FILE, "[]");
  host.fs.read = async () => { throw new Error("EIO: i/o error"); };
  assert.deepEqual(await readSavedJobs(host, FILE), []);
  assert.ok(await host.fs.exists(`${ROOT}\\.studio-jobs.bad-${host.now()}.json`));
});

test("going back to the open film while another opens keeps the open one watched", async () => {
  const { host, session, watching } = setup();
  await host.fs.mkdir(A); await host.fs.mkdir(B);
  const sa = await session.open(A);
  const pb = session.open(B);
  assert.equal(await session.open(A), sa);
  assert.equal(await pb, null);
  assert.deepEqual([...watching].map((s) => s.dir), [A]);
});
