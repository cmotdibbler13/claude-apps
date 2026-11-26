import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyRules } from "../js/notify.js";

const job = (o) => ({ id: "j1", film: "S:\\Youtube video ideas\\Deep Sea", assetId: "BR-07", take: 3, tool: "blender", status: "running", ...o });

test("done, failed and all-shots messages", () => {
  const prev = [job({ id: "a" }), job({ id: "b", tool: "higgsfield", assetId: "HF-02", take: 1 })];
  const next = [job({ id: "a", status: "done" }), job({ id: "b", tool: "higgsfield", assetId: "HF-02", take: 1, status: "failed" })];
  assert.deepEqual(notifyRules(prev, next), [
    "BR-07 take 3 is ready to review",
    "HF-02 take 1 failed in Higgsfield",
    "Nothing left running for Deep Sea: 1 ready, 1 failed",
  ]);
});

test("the film message counts this batch only, the latest job per take, and omits zero parts", () => {
  const prev = [
    job({ id: "old", assetId: "HF-01", take: 1, status: "done", startedAt: 1, endedAt: 2 }),
    job({ id: "early", assetId: "HF-02", take: 1, status: "done", startedAt: 5, endedAt: 15 }),
    job({ id: "f1", assetId: "HF-03", take: 1, status: "failed", startedAt: 11, endedAt: 12 }),
    job({ id: "f2", assetId: "HF-03", take: 1, status: "running", startedAt: 13 }),
    job({ id: "last", assetId: "HF-04", take: 1, status: "running", startedAt: 10 }),
  ];
  const next = prev.map((j) => (j.status === "running" ? { ...j, status: "done", endedAt: 20 } : j));
  assert.equal(notifyRules(prev, next).at(-1), "Nothing left running for Deep Sea: 3 ready");
  const allFailed = notifyRules([job({ id: "x", startedAt: 1 })], [job({ id: "x", status: "interrupted", startedAt: 1 })]);
  assert.deepEqual(allFailed, ["Nothing left running for Deep Sea: 1 failed"]);
});

test("the film message treats the S: and UNC copies as one film", () => {
  const unc = "\\\\192.168.1.171\\jon\\Youtube video ideas\\Deep Sea";
  const prev = [job({ id: "a", startedAt: 1 }), job({ id: "b", film: unc, startedAt: 1 })];
  const next = [job({ id: "a", status: "done", startedAt: 1 }), job({ id: "b", film: unc, startedAt: 1 })];
  assert.deepEqual(notifyRules(prev, next), ["BR-07 take 3 is ready to review"]);
});

test("failed names Blender capitalised and no film message while others are active", () => {
  const prev = [job({ id: "a" }), job({ id: "b", status: "queued" })];
  const next = [job({ id: "a", status: "failed" }), job({ id: "b", status: "queued" })];
  assert.deepEqual(notifyRules(prev, next), ["BR-07 take 3 failed in Blender"]);
});

test("no duplicate on repeated identical states", () => {
  const prev = [job({ status: "done" })];
  assert.deepEqual(notifyRules(prev, [job({ status: "done" })]), []);
  assert.deepEqual(notifyRules([job()], [job({ progress: 0.5 })]), []);
});

test("jobs arriving already terminal (restore) give no message", () => {
  assert.deepEqual(notifyRules([], [job({ status: "done" }), job({ id: "x", status: "failed" })]), []);
});

test("bodies are capped at 300 characters", () => {
  const film = "S:\\x\\" + "F".repeat(400);
  const out = notifyRules([job({ film })], [job({ film, status: "done" })]);
  assert.ok(out.length === 2);
  for (const m of out) { assert.ok(m.length <= 300); }
  assert.ok(out[1].endsWith("…"));
});
