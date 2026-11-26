import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { buildShotList, orderByScript } from "../js/shots.js";
import { ClaudeError } from "../js/claude.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const mk = async (reply) => {
  const h = new FakeHost();
  await h.fs.mkdir(DIR);
  h.claudeScript(() => reply);
  return { h, store: await openFilm(h, DIR) };
};
const shot = (o) => ({ id: "X", kind: "broll", line: "A line.", lineIndex: 0, desc: "d", tool: "higgsfield", prompt: "p", ...o });
const input = { scriptText: "s", handoverText: "h" };


test("blender shot without lineart source is rejected", async () => {
  const { h, store } = await mk([shot({ id: "B1", kind: "blender", tool: "blender", sourceId: "nope" })]);
  await assert.rejects(buildShotList(h, store, input), (e) => e.code === "invalid" && /source/i.test(e.message));
  assert.deepEqual(store.state.assets, []);
});

test("rejects shot list without required fields", async () => {
  const bad = shot({}); delete bad.prompt;
  const { h, store } = await mk([bad]);
  await assert.rejects(buildShotList(h, store, input), (e) => e.code === "invalid");
  assert.deepEqual(store.state.assets, []);
});

test("valid list is renumbered HF-nn in script order with sourceId remapped", async () => {
  const { h, store } = await mk([
    shot({ id: "z", kind: "blender", tool: "blender", sourceId: "a", lineIndex: 2, line: "L2" }),
    shot({ id: "a", kind: "lineart", lineIndex: 1, line: "L1", prompt: "lp" }),
    shot({ id: "c", lineIndex: 0, line: "L0" }),
  ]);
  const r = await buildShotList(h, store, input);
  assert.deepEqual(r.map((a) => a.id), ["HF-01", "HF-02", "HF-03"]);
  assert.equal(r[2].kind, "blender");
  assert.equal(r[2].sourceId, "HF-02");
  assert.equal(r[1].draftPrompt, "lp");
  assert.deepEqual(r[0].takes, []);
  assert.equal(r[0].approved, false);
  assert.deepEqual(store.state.assets.map((a) => a.id), ["HF-01", "HF-02", "HF-03"]);
  assert.ok((await store.readLog()).some((l) => l.text === "Shot list made: 3 shots"));
});

test("refuses when assets already exist and never overwrites", async () => {
  const { h, store } = await mk([shot({})]);
  await store.update((d) => { d.assets.push({ id: "HF-01" }); });
  await assert.rejects(buildShotList(h, store, input), (e) => e.code === "exists");
  assert.deepEqual(store.state.assets, [{ id: "HF-01" }]);
});

test("orderByScript sorts by lineIndex then id", () => {
  const r = orderByScript([{ id: "HF-03", lineIndex: 1 }, { id: "HF-02", lineIndex: 1 }, { id: "HF-09", lineIndex: 0 }]);
  assert.deepEqual(r.map((a) => a.id), ["HF-09", "HF-02", "HF-03"]);
});

test("waiting says what is waiting on Jon", async () => {
  const { deriveWaiting } = await import("../js/shots.js");
  const a = (takes, o = {}) => ({ id: "X", takes, chosen: takes.length, approved: false, ...o });
  const t = (n, status) => ({ n, status });
  assert.equal(deriveWaiting([]), "Shot list not made yet");
  assert.equal(deriveWaiting([a([t(1, "done")]), a([t(1, "done")]), a([t(1, "running")])]), "2 shots to review");
  assert.equal(deriveWaiting([a([t(1, "done")]), a([t(1, "failed")])]), "1 shot to review, 1 shot needs a redo");
  assert.equal(deriveWaiting([a([t(1, "failed")]), a([t(1, "interrupted")])]), "2 shots need a redo");
  assert.equal(deriveWaiting([a([t(1, "done")], { approved: true }), a([t(1, "queued")])]), null);
  assert.equal(deriveWaiting([a([t(1, "done")], { approved: true }), a([t(1, "done")], { approved: true })]), "All shots approved");
  assert.equal(deriveWaiting([a([t(1, "done")], { approved: true }), a([])]), "1 shot to start");
});

test("the shot list writes waiting in the same update", async () => {
  const { h, store } = await mk([shot({ id: "A" }), shot({ id: "B", lineIndex: 1 })]);
  await buildShotList(h, store, input);
  assert.equal(store.state.waiting, "2 shots to start");
});

test("prefer flag makes broll shots comfyui, others unchanged", async () => {
  const { h, store } = await mk([
    shot({ id: "a", lineIndex: 0 }),
    shot({ id: "b", kind: "lineart", lineIndex: 1 }),
    shot({ id: "c", kind: "blender", tool: "blender", sourceId: "b", lineIndex: 2 }),
  ]);
  await store.update((d) => { d.prefs = { preferComfy: true }; });
  const r = await buildShotList(h, store, input);
  assert.deepEqual(r.map((a) => a.tool), ["comfyui", "higgsfield", "blender"]);
});

test("without the flag broll stays higgsfield; comfyui from Claude is accepted only for broll", async () => {
  const { h, store } = await mk([shot({ tool: "comfyui" })]);
  assert.equal((await buildShotList(h, store, input))[0].tool, "comfyui");
  const bad = await mk([shot({ kind: "lineart", tool: "comfyui" })]);
  await assert.rejects(buildShotList(bad.h, bad.store, input), (e) => e.code === "invalid");
});
