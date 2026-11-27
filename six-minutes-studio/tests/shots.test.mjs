import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { buildShotList, orderByScript, deriveWaiting } from "../js/shots.js";
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

test("a plan with an animated shot is refused (animated versions come only from the button)", async () => {
  const { h, store } = await mk([
    shot({ id: "a", kind: "lineart", lineIndex: 0 }),
    shot({ id: "m", kind: "animated", tool: "comfyui", sourceId: "a", lineIndex: 1 }),
  ]);
  await assert.rejects(buildShotList(h, store, input), (e) => e.code === "invalid" && /bad kind/.test(e.message));
  assert.deepEqual(store.state.assets, []);
});

const CAM = "I have walked this shore a hundred times, and it still surprises me.";
const tc = (o = {}) => ({ id: "TC-01", kind: "presenter", lineId: "L3", line: CAM, takes: [], chosen: 0, approved: false, ...o });

test("sameLine matches by normalised text, containment only for 4+ words", async () => {
  const { sameLine } = await import("../js/shots.js");
  assert.equal(sameLine(CAM, "i have walked this shore a hundred times and it still surprises me"), true);
  assert.equal(sameLine(`${CAM} And then it rained all night.`, CAM), true);
  assert.equal(sameLine("Hello there.", "Oh, hello there. Again."), false);
  assert.equal(sameLine("", ""), false);
  assert.equal(sameLine("Different line entirely here now.", CAM), false);
});

test("instructions carry the to-camera sentence and data has cameraLines", async () => {
  const { SHOT_INSTRUCTIONS } = await import("../js/shots.js");
  assert.ok(SHOT_INSTRUCTIONS.includes("Plan no shot on these to-camera lines: Jon is on camera for the whole line."));
  const { h, store } = await mk([shot({})]);
  let sent = null;
  h.claudeScript((kind, text) => { sent = text; return [shot({})]; });
  const cameraLines = [{ id: "L3", text: CAM }];
  await buildShotList(h, store, { ...input, cameraLines });
  const data = JSON.parse(sent.split("DATA (JSON):\n")[1].split("\n\nAnswer with JSON only.")[0]);
  assert.deepEqual(data.cameraLines, cameraLines);
});

test("validator refuses a shot on a camera line, naming the id", async () => {
  const { h, store } = await mk([shot({ line: CAM })]);
  await assert.rejects(buildShotList(h, store, { ...input, cameraLines: [{ id: "L3", text: CAM }] }), (e) => e.code === "invalid" && /L3/.test(e.message));
  assert.deepEqual(store.state.assets, []);
  const ok = await mk([shot({ line: "Another line altogether." })]);
  await buildShotList(ok.h, ok.store, { ...input, cameraLines: [{ id: "L3", text: CAM }] });
  assert.equal(ok.store.state.assets.length, 1);
});

test("onCameraConflict: true for non-presenter asset on a chosen camera line", async () => {
  const { onCameraConflict } = await import("../js/shots.js");
  const state = { assets: [tc(), { id: "HF-01", kind: "broll", line: CAM }, { id: "HF-02", kind: "broll", line: "Other." }] };
  assert.equal(onCameraConflict(state.assets[1], state), true);
  assert.equal(onCameraConflict(state.assets[2], state), false);
  assert.equal(onCameraConflict(state.assets[0], state), false);
  assert.equal(onCameraConflict(state.assets[1], { assets: [state.assets[1]] }), false);
});

test("deriveWaiting skips a conflicting unapproved shot", async () => {
  const { deriveWaiting } = await import("../js/shots.js");
  const conflict = { id: "HF-01", kind: "broll", line: CAM, takes: [{ n: 1, status: "done" }], chosen: 1, approved: false };
  const fine = { id: "HF-02", kind: "broll", line: "Other.", takes: [{ n: 1, status: "done" }], chosen: 1, approved: true };
  assert.equal(deriveWaiting([tc({ approved: true }), conflict, fine]), "All shots approved");
  assert.equal(deriveWaiting([tc(), conflict, fine]), deriveWaiting([tc(), fine]));
  assert.notEqual(deriveWaiting([tc(), conflict, fine]), "1 shot to review");
});

test("clips chosen before the shot list: the list can still be made and the clips stay", async () => {
  const { h, store } = await mk([shot({ id: "c", lineIndex: 0, line: "L0" })]);
  const clip = { id: "TC-01", kind: "presenter", tool: "higgsfield", lineId: "01", line: "To camera here.", lineIndex: 3, takes: [], chosen: 0, approved: false };
  await store.update((d) => { d.assets.push(clip); });
  const r = await buildShotList(h, store, input);
  assert.deepEqual(r.map((a) => a.id), ["HF-01"]);
  assert.deepEqual(store.state.assets.map((a) => a.id), ["TC-01", "HF-01"]);
  await assert.rejects(buildShotList(h, store, input), (e) => e.code === "exists");
});

test("deriveWaiting: clips alone are no shot list; an out-of-step clip counts once", () => {
  const tc = (o = {}) => ({ id: "TC-01", kind: "presenter", line: "To camera here now.", takes: [], chosen: 0, approved: false, ...o });
  assert.equal(deriveWaiting([tc()]), "Shot list not made yet");
  assert.equal(deriveWaiting([tc({ approved: true, takes: [{ n: 1, status: "done" }], chosen: 1 })]), "Shot list not made yet");
  const hf = { id: "HF-01", kind: "broll", line: "Other line entirely.", takes: [], chosen: 0, approved: true };
  const out = tc({ takes: [{ n: 1, status: "done" }], chosen: 1, voiceoverChanged: true });
  assert.equal(deriveWaiting([hf, out]), "1 clip out of step");
});
