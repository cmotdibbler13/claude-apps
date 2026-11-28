import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import {
  QUEUE_DIR, FINISHED, writeRequest, readAnswer, writeAnswer, writeWithdrawn, hasWithdrawn,
  writeCheck, listChecks, pendingRequests, moveMine, requestFinished, listRequests, listAnswers,
} from "../js/queue.js";

const ROOT = "S:\\Youtube video ideas";
const q = (n) => `${ROOT}\\${QUEUE_DIR}\\${n}`;
const f = (n) => `${ROOT}\\${QUEUE_DIR}\\${FINISHED}\\${n}`;
const req = (id, extra = {}) => ({ id, from: "LAPTOP-JON", root: "Z:\\x", job: { tool: "blender" }, ...extra });
const ans = (id, extra = {}) => ({ id, by: "DESK", status: "done", progress: 1, eta: null, file: null, meta: null, error: null, ambiguous: false, checks: [], ...extra });
const ID = "LAPTOP-JON-j1700000000000-1";

test("names", () => {
  assert.equal(QUEUE_DIR, ".studio-queue");
  assert.equal(FINISHED, "finished");
});

test("request round trip adds at, creates folders", async () => {
  const h = new FakeHost();
  await writeRequest(h, ROOT, req(ID));
  assert.ok(h.files.has(q(`${ID}.request.json`)));
  assert.ok(![...h.files.keys()].some((k) => k.endsWith(".tmp")));
  const [r] = await listRequests(h, ROOT);
  assert.equal(r.id, ID);
  assert.equal(r.at, h.t);
  assert.equal(r.from, "LAPTOP-JON");
  assert.equal(r.root, "Z:\\x");
  assert.deepEqual(r.job, { tool: "blender" });
});

test("answer round trip; missing or broken is null", async () => {
  const h = new FakeHost();
  assert.equal(await readAnswer(h, ROOT, ID), null);
  await writeAnswer(h, ROOT, ans(ID, { status: "running", progress: 0.5 }));
  assert.equal((await readAnswer(h, ROOT, ID)).progress, 0.5);
  assert.equal((await listAnswers(h, ROOT)).length, 1);
  h.files.set(q("X.answer.json"), "{nope");
  assert.equal(await readAnswer(h, ROOT, "X"), null);
  assert.equal((await listAnswers(h, ROOT)).length, 1);
});

test("withdrawn and checks", async () => {
  const h = new FakeHost();
  assert.equal(await hasWithdrawn(h, ROOT, ID), false);
  await writeWithdrawn(h, ROOT, ID);
  assert.equal(await hasWithdrawn(h, ROOT, ID), true);
  assert.equal(await hasWithdrawn(h, ROOT, "OTHER"), false);
  const n1 = await writeCheck(h, ROOT, ID);
  assert.equal(n1, `${ID}.check-${h.t}.json`);
  h.t += 5;
  const n2 = await writeCheck(h, ROOT, ID);
  await writeCheck(h, ROOT, "OTHER");
  assert.deepEqual((await listChecks(h, ROOT, ID)).sort(), [n1, n2].sort());
});

test("pendingRequests: oldest first, skips answered, broken and .tmp", async () => {
  const h = new FakeHost();
  h.t = 3000; await writeRequest(h, ROOT, req("C"));
  h.t = 1000; await writeRequest(h, ROOT, req("A"));
  h.t = 2000; await writeRequest(h, ROOT, req("B"));
  h.t = 500; await writeRequest(h, ROOT, req("D"));
  await writeAnswer(h, ROOT, ans("D"));
  h.files.set(q("E.request.json"), "{broken");
  h.files.set(q("F.request.json.tmp"), JSON.stringify(req("F", { at: 1 })));
  assert.deepEqual((await pendingRequests(h, ROOT)).map((r) => r.id), ["A", "B", "C"]);
  assert.equal((await listRequests(h, ROOT)).length, 4);
});

test("empty or missing queue folder lists nothing", async () => {
  const h = new FakeHost();
  assert.deepEqual(await pendingRequests(h, ROOT), []);
  assert.deepEqual(await listAnswers(h, ROOT), []);
  assert.equal(await requestFinished(h, ROOT, ID), false);
});

async function setup(h) {
  await writeRequest(h, ROOT, req(ID));
  await writeWithdrawn(h, ROOT, ID);
  const c = await writeCheck(h, ROOT, ID);
  await writeAnswer(h, ROOT, ans(ID));
  await writeRequest(h, ROOT, req("OTHER-j1-2"));
  return c;
}

test("moveMine laptop moves request, withdrawn, checks; leaves answer and others", async () => {
  const h = new FakeHost();
  const c = await setup(h);
  assert.equal(await requestFinished(h, ROOT, ID), false);
  await moveMine(h, ROOT, ID, "laptop");
  for (const n of [`${ID}.request.json`, `${ID}.withdrawn.json`, c]) {
    assert.ok(h.files.has(f(n)), n);
    assert.ok(!h.files.has(q(n)), n);
  }
  assert.ok(h.files.has(q(`${ID}.answer.json`)));
  assert.ok(h.files.has(q("OTHER-j1-2.request.json")));
  assert.equal(await requestFinished(h, ROOT, ID), true);
  assert.equal(await requestFinished(h, ROOT, "OTHER-j1-2"), false);
});

test("moveMine desktop moves only the answer", async () => {
  const h = new FakeHost();
  await setup(h);
  await moveMine(h, ROOT, ID, "desktop");
  assert.ok(h.files.has(f(`${ID}.answer.json`)));
  assert.ok(!h.files.has(q(`${ID}.answer.json`)));
  assert.ok(h.files.has(q(`${ID}.request.json`)));
  assert.equal(await requestFinished(h, ROOT, ID), false);
});

test("moving twice never overwrites; nothing is deleted", async () => {
  const h = new FakeHost();
  await writeRequest(h, ROOT, req(ID, { job: { marker: 1 } }));
  await moveMine(h, ROOT, ID, "laptop");
  h.t += 7;
  await writeRequest(h, ROOT, req(ID, { job: { marker: 2 } }));
  const before = h.files.size;
  await moveMine(h, ROOT, ID, "laptop");
  assert.equal(h.files.size, before);
  assert.equal(JSON.parse(h.files.get(f(`${ID}.request.json`))).job.marker, 1);
  assert.equal(JSON.parse(h.files.get(f(`${ID}.request.json`.replace(/\.json$/, `_${h.t}.json`)))).job.marker, 2);
  // same instant again still does not overwrite
  await writeRequest(h, ROOT, req(ID, { job: { marker: 3 } }));
  await moveMine(h, ROOT, ID, "laptop");
  const markers = [...h.files.entries()].filter(([k]) => k.includes("finished")).map(([, v]) => JSON.parse(v).job.marker).sort();
  assert.deepEqual(markers, [1, 2, 3]);
});

test("moving with nothing to move is harmless", async () => {
  const h = new FakeHost();
  await moveMine(h, ROOT, ID, "laptop");
  await moveMine(h, ROOT, ID, "desktop");
  assert.equal(h.files.size, 0);
});
