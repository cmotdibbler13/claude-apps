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
    "All shots for Deep Sea are ready",
  ]);
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
