import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { parseLineScript } from "../js/narration.js";
import { scriptCameraIds, suggestLines, lineLengthS, setCameraLines, cameraLineState, LINES_INSTRUCTIONS } from "../js/presenter.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const LS = parseLineScript("[01]\nOne is here.\n> to camera\n[02]\nTwo is here.\n[03]\nThree is here now.\n> To Camera\n[04]\nFour.\n");
const TR = { sentences: [{ sentence: "01", start: 0, end: 5 }, { sentence: "02", start: 5, end: 21 }, { sentence: "03", start: 21, end: 30 }] };

async function setup(extra = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  const store = await openFilm(host, DIR);
  return { host, store, ctx: { host, store, lineScript: LS, ...extra } };
}

test("scriptCameraIds in script order", () => assert.deepEqual(scriptCameraIds(LS), ["01", "03"]));

test("lineLengthS from the transcript", () => {
  assert.equal(lineLengthS(TR, "01"), 5);
  assert.equal(lineLengthS(TR, "04"), null);
});

test("suggestLines accepts a good answer and rejects unknown ids, duplicates and 2 entries", async () => {
  const host = new FakeHost();
  const ls = parseLineScript("[a]\nA.\n[b]\nB.\n[c]\nC.\n[d]\nD.\n");
  const ans = (ids) => ({ lines: ids.map((id) => ({ id, why: "w" })) });
  host.claudeScript(() => ans(["a", "b", "c"]));
  assert.deepEqual(await suggestLines(host, ls), [{ id: "a", why: "w" }, { id: "b", why: "w" }, { id: "c", why: "w" }]);
  for (const ids of [["a", "b", "zz"], ["a", "a", "b"], ["a", "b"]]) {
    host.claudeScript(() => ans(ids));
    await assert.rejects(() => suggestLines(host, ls));
  }
  assert.match(LINES_INSTRUCTIONS, /12 seconds/);
});

test("setCameraLines: TC-01, TC-02, untick without takes deletes, with takes moves to removed, re-tick is TC-03", async () => {
  const { ctx, store } = await setup();
  await setCameraLines(ctx, ["01", "03"]);
  const s = store.state;
  assert.deepEqual(s.presenter.lines, [{ id: "01", from: "script" }, { id: "03", from: "script" }]);
  assert.deepEqual(s.assets.map((a) => [a.id, a.lineId, a.lineIndex]), [["TC-01", "01", 0], ["TC-02", "03", 2]]);
  assert.equal(s.assets[0].desc, "On camera: One is here.…");
  assert.equal(s.assets[0].tool, "higgsfield");
  await setCameraLines(ctx, ["03", "02"]);
  assert.deepEqual(store.state.assets.map((a) => a.id), ["TC-02", "TC-03"]);
  assert.equal(store.state.presenter.lines[1].from, "jon");
  assert.equal(store.state.removed ?? undefined, undefined);
  await store.update((d) => { d.assets[0].takes = [{ n: 1, status: "done" }]; });
  await setCameraLines(ctx, ["02"]);
  assert.deepEqual(store.state.assets.map((a) => a.id), ["TC-03"]);
  assert.equal(store.state.removed[0].id, "TC-02");
  assert.ok(store.state.removed[0].removedAt);
  await setCameraLines(ctx, ["02", "03"]);
  assert.deepEqual(store.state.assets.map((a) => a.id), ["TC-03", "TC-04"]);
});

test("setCameraLines refuses a line over 15 s and a running take", async () => {
  const { ctx, store } = await setup({ transcript: TR });
  await assert.rejects(() => setCameraLines(ctx, ["02"]), { message: "Too long for one clip: 15 s at most" });
  assert.equal(store.state.assets.length, 0);
  await setCameraLines(ctx, ["01"]);
  await store.update((d) => { d.assets[0].takes = [{ n: 1, status: "running" }]; });
  await assert.rejects(() => setCameraLines(ctx, []), { message: "TC-01 has a take in progress." });
  assert.equal(store.state.assets.length, 1);
});

test("cameraLineState flags a chosen id the script lost; its asset stays", async () => {
  const { ctx, store } = await setup();
  await setCameraLines(ctx, ["01", "03"]);
  const edited = parseLineScript("[01]\nOne is here.\n[02]\nTwo.\n");
  const st = cameraLineState(store.state, edited);
  assert.deepEqual(st.map((x) => [x.id, x.missing, x.assetId]), [["01", false, "TC-01"], ["03", true, "TC-02"]]);
  assert.equal(st[1].text, "Three is here now.");
  assert.equal(store.state.assets.length, 2);
});
