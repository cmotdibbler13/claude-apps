import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { parseLineScript } from "../js/narration.js";
import { makeJobs } from "../js/jobs.js";
import { LOOK_INSTRUCTIONS, suggestLooks, setLook, lastLook, portraitPrompt, startPortraits, approvePortrait } from "../js/presenter.js";
import { holders, watchJobs } from "../js/redo.js";
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

// ---- Task 4: look and portraits ----
const PHOTOS = ["C:\\jon\\office.jpg", "C:\\jon\\blazer.png"];
async function psetup(photos = PHOTOS, runners = { higgsfield: { start: () => new Promise(() => {}) } }) {
  const { host, store } = await setup();
  await host.fs.mkdir("C:\\jon");
  for (const f of photos) await host.fs.write(f, "x");
  const jobs = makeJobs(host, { runners });
  return { host, store, jobs, ctx: { host, store, jobs, lineScript: LS, settings: { presenter: { photos } } } };
}
const LOOK = { outfit: "a navy blazer over a white shirt", set: "a quiet library reading room" };

test("suggestLooks: tier quick, 3 outfits and 3 sets, validated", async () => {
  const host = new FakeHost();
  const ok = { outfits: ["a", "b", "c"], sets: ["x", "y", "z"] };
  host.claudeScript(() => ok);
  assert.deepEqual(await suggestLooks(host, { scriptText: "script", lastLook: null }), ok);
  for (const bad of [{ outfits: ["a", "b"], sets: ["x", "y", "z"] }, { outfits: ["a", "b", ""], sets: ["x", "y", "z"] }, { outfits: ["a", "b", "c"], sets: "x" }]) {
    host.claudeScript(() => bad);
    await assert.rejects(() => suggestLooks(host, { scriptText: "s" }));
  }
  assert.match(LOOK_INSTRUCTIONS, /exactly 3 outfits/);
});

test("setLook stores outfit, set and time", async () => {
  const { ctx, store, host } = await psetup();
  await setLook(ctx, LOOK);
  assert.deepEqual(store.state.presenter.look, { ...LOOK, at: host.now() });
});

test("portraitPrompt: spec text with outfit and set", () => {
  const p = portraitPrompt(LOOK);
  assert.match(p, /same bald head/);
  assert.ok(p.includes(`He wears ${LOOK.outfit}.`));
  assert.ok(p.includes(`Background: ${LOOK.set}, strongly out of focus with a shallow depth of field, calm and uncluttered.`));
  assert.match(p, /85mm lens, natural skin texture\.$/);
});

test("startPortraits: two takes and two jobs per press", async () => {
  const { ctx, store, jobs } = await psetup();
  await setLook(ctx, LOOK);
  await startPortraits(ctx);
  const h = store.state.presenter.portraits;
  assert.deepEqual([h.id, h.kind, h.tool, h.chosen, h.approved], ["PORTRAIT", "portrait", "higgsfield", 0, false]);
  assert.deepEqual(h.takes.map((t) => [t.n, t.status]), [[1, "queued"], [2, "queued"]]);
  const l = jobs.list();
  assert.equal(l.length, 2);
  assert.deepEqual(l.map((j) => j.take), [1, 2]);
  assert.deepEqual(l[1].input, { kind: "portrait", prompt: portraitPrompt(LOOK), photos: PHOTOS, out: DIR + "\\studio\\presenter\\PORTRAIT_t2" });
  assert.equal(l[0].assetId, "PORTRAIT");
  assert.ok(holders(store.state).includes(h));
  await assert.rejects(() => startPortraits(ctx), /Portraits are already being made\./);
  await store.update((d) => d.presenter.portraits.takes.forEach((t) => { t.status = "done"; }));
  await startPortraits(ctx);
  assert.deepEqual(store.state.presenter.portraits.takes.map((t) => t.n), [1, 2, 3, 4]);
});

test("startPortraits refused without photos or look", async () => {
  const a = await psetup([]);
  await setLook(a.ctx, LOOK);
  await assert.rejects(() => startPortraits(a.ctx), /Add presenter photos \(see Probe\)/);
  const b = await psetup();
  await assert.rejects(() => startPortraits(b.ctx), /Choose an outfit and a set first/);
  assert.equal(b.jobs.list().length, 0);
  const c = await psetup();
  c.ctx.settings = { presenter: { photos: ["C:\\gone.jpg"] } };
  await setLook(c.ctx, LOOK);
  await assert.rejects(() => startPortraits(c.ctx), /Add presenter photos/);
});

test("approving a new portrait marks finished clips stale; a running take keeps its own hfId", async () => {
  const { ctx, store, jobs } = await psetup();
  await setCameraLines(ctx, ["01", "03", "02"]);
  await setLook(ctx, LOOK);
  await startPortraits(ctx);
  await store.update((d) => {
    d.presenter.portraits.takes.forEach((t, i) => { t.status = "done"; t.file = `p${t.n}.png`; t.hfId = `hf-${t.n}`; });
    const [a, b, c] = d.assets;
    a.takes = [{ n: 1, status: "done", portraitHfId: "hf-1" }]; a.chosen = 1;
    b.takes = [{ n: 1, status: "done", portraitHfId: "hf-2" }]; b.chosen = 1;
    c.takes = [{ n: 1, status: "running", portraitHfId: "hf-1", jobId: "j" }]; c.chosen = 1;
  });
  await approvePortrait(ctx, 2);
  const s = store.state;
  assert.deepEqual({ ...s.presenter.portrait, at: 0 }, { n: 2, hfId: "hf-2", file: "p2.png", at: 0 });
  assert.equal(s.presenter.portraits.chosen, 2);
  assert.equal(s.presenter.portraits.approved, true);
  assert.equal(s.assets[0].staleReason, "portrait");
  assert.equal(s.assets[1].staleReason, undefined);
  assert.equal(s.assets[2].staleReason, undefined);
  assert.equal(s.assets[2].takes[0].portraitHfId, "hf-1");
  // approving the portrait the first clip was made with clears its flag
  await approvePortrait(ctx, 1);
  assert.equal(store.state.assets[0].staleReason, undefined);
  assert.equal(store.state.assets[1].staleReason, "portrait");
  await assert.rejects(() => approvePortrait(ctx, 9), /no take 9/);
});

test("approvePortrait needs a finished take with an hfId", async () => {
  const { ctx, store } = await psetup();
  await setLook(ctx, LOOK);
  await startPortraits(ctx);
  await assert.rejects(() => approvePortrait(ctx, 1), /finished/);
});

test("portrait job result mirrors hfId onto the take", async () => {
  const runners = { higgsfield: { start: async () => ({ file: "p.png", meta: { hfId: "abc" } }) } };
  const { ctx, store, jobs } = await psetup(PHOTOS, runners);
  watchJobs(ctx);
  await setLook(ctx, LOOK);
  await startPortraits(ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(store.state.presenter.portraits.takes.map((t) => [t.status, t.hfId]), [["done", "abc"], ["done", "abc"]]);
});

test("lastLook: newest other film's look, null when none", async () => {
  const host = new FakeHost();
  const ROOT = "S:\\Youtube video ideas";
  const mk = async (name, look) => {
    await host.fs.mkdir(`${ROOT}\\${name}\\studio`);
    await host.fs.write(`${ROOT}\\${name}\\studio\\state.json`, JSON.stringify(look ? { presenter: { look } } : {}));
  };
  await mk("Film A", { outfit: "cur", set: "cur", at: 900 });
  await mk("Film B", { outfit: "old", set: "oldset", at: 100 });
  await mk("Film C", { outfit: "new", set: "newset", at: 500 });
  await mk("Film D", null);
  assert.deepEqual(await lastLook(host, ROOT, `${ROOT}\\Film A`), { outfit: "new", set: "newset" });
  const h2 = new FakeHost();
  await h2.fs.mkdir(`${ROOT}\\Film A\\studio`);
  assert.equal(await lastLook(h2, ROOT, `${ROOT}\\Film A`), null);
});

// ---- Task 5: the clips ----
import { clipLock, clipPrompt, clipSeconds } from "../js/presenter.js";
import { startTake, canStart } from "../js/redo.js";

test("startPortraits uses at most two photos", async () => {
  const three = [...PHOTOS, "C:\\jon\\third.jpg"];
  const { ctx, jobs } = await psetup(three);
  await setLook(ctx, LOOK);
  await startPortraits(ctx);
  assert.deepEqual(jobs.list()[0].input.photos, PHOTOS);
});

test("clipSeconds: ceil clamped 2..15", () => {
  assert.equal(clipSeconds(0.8), 2);
  assert.equal(clipSeconds(7.2), 8);
  assert.equal(clipSeconds(15), 15);
  assert.equal(clipSeconds(14.01), 15);
});

test("clipPrompt: spec wording, note appended", () => {
  const p = clipPrompt();
  assert.match(p, /^The man speaks directly to the camera, lips precisely synced to the audio, calm and engaging documentary presenter delivery,/);
  assert.match(p, /the soft-focus background stays still, warm natural light, photorealistic\.$/);
  assert.equal(clipPrompt("  slower  "), p + " slower");
  assert.equal(clipPrompt("   "), p);
});

test("clipLock: portrait, voiceover, missing line, too long", () => {
  const a = { kind: "presenter", lineId: "01" };
  const st = (portrait) => ({ presenter: portrait ? { portrait: { n: 1, hfId: "h" } } : {} });
  assert.equal(clipLock(a, st(false), TR), "Approve a portrait first");
  assert.equal(clipLock(a, st(true), null), "Join the voiceover first");
  assert.equal(clipLock({ ...a, lineId: "04" }, st(true), TR), "Join the voiceover first");
  assert.equal(clipLock({ ...a, lineId: "02" }, st(true), TR), "Too long for one clip: 15 s at most");
  assert.equal(clipLock(a, st(true), TR), null);
});

async function csetup(runners) {
  const s = await psetup(PHOTOS, runners);
  await setCameraLines(s.ctx, ["01", "03"]);
  await s.store.update((d) => {
    d.presenter.portrait = { n: 1, hfId: "hf-p", file: "p.png", at: 1 };
    d.mix = { voiceover: { status: "done", wav: "S:\\Youtube video ideas\\Film A\\Film A_voiceover.wav", transcript: "t.json" } };
  });
  s.ctx.transcript = TR;
  return s;
}

test("startTake presenter: job input, take records portraitHfId, prompt with note, no Claude call", async () => {
  const { ctx, store, jobs, host } = await csetup();
  host.claudeScript(() => { throw new Error("no claude"); });
  const t = await startTake(ctx, "TC-01", { note: "calmer" });
  assert.equal(t.prompt, clipPrompt("calmer"));
  assert.equal(t.portraitHfId, "hf-p");
  assert.equal(t.note, "calmer");
  const j = jobs.list()[0];
  assert.deepEqual(j.input, {
    kind: "presenter", lineId: "01", voiceover: store.state.mix.voiceover.wav, start: 0, end: 5, seconds: 5, hfId: "hf-p",
    prompt: clipPrompt("calmer"), out: DIR + "\\studio\\presenter\\TC-01_t1",
  });
  assert.equal(j.tool, "higgsfield");
});

test("startTake presenter: locked cases throw the lock copy and write nothing", async () => {
  const { ctx, store, jobs } = await csetup();
  await store.update((d) => { delete d.presenter.portrait; });
  await assert.rejects(() => startTake(ctx, "TC-01"), { message: "Approve a portrait first" });
  await store.update((d) => { d.presenter.portrait = { n: 1, hfId: "hf-p" }; });
  ctx.transcript = { sentences: [] };
  await assert.rejects(() => startTake(ctx, "TC-01"), { message: "Join the voiceover first" });
  ctx.transcript = null;
  await assert.rejects(() => startTake(ctx, "TC-01"), { message: "Join the voiceover first" });
  assert.equal(store.state.assets[0].takes.length, 0);
  assert.equal(jobs.list().length, 0);
  assert.equal(canStart(store.state.assets[0], store.state.assets, store.state, null), false);
  assert.equal(canStart(store.state.assets[0], store.state.assets, store.state, TR), true);
});
