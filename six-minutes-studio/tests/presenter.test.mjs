import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { parseLineScript } from "../js/narration.js";
import { makeJobs } from "../js/jobs.js";
import { LOOK_INSTRUCTIONS, suggestLooks, setLook, lastLook, portraitPrompt, startPortraits, approvePortrait } from "../js/presenter.js";
import { holders, watchJobs } from "../js/redo.js";
import { checkClipAudio, keepAnyway } from "../js/presenter.js";
import { audioSigOf } from "../js/tools/clipaudio.js";
import { deriveWaiting } from "../js/shots.js";
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
  await assert.rejects(() => startPortraits(a.ctx), /Add one or two photos of you first/);
  const b = await psetup();
  await assert.rejects(() => startPortraits(b.ctx), /Choose an outfit and a set first/);
  assert.equal(b.jobs.list().length, 0);
  const c = await psetup();
  c.ctx.settings = { presenter: { photos: ["C:\\gone.jpg"] } };
  await setLook(c.ctx, LOOK);
  await assert.rejects(() => startPortraits(c.ctx), /Add one or two photos of you first/);
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
  const st = (portrait, vo = true) => ({ presenter: portrait ? { portrait: { n: 1, hfId: "h" } } : {}, mix: vo ? { voiceover: { wav: "v.wav" } } : undefined });
  assert.equal(clipLock(a, st(false), TR), "Approve a portrait first");
  assert.equal(clipLock(a, st(true), null), "Join the voiceover first");
  assert.equal(clipLock({ ...a, lineId: "04" }, st(true), TR), "Join the voiceover first");
  assert.equal(clipLock({ ...a, lineId: "02" }, st(true), TR), "Too long for one clip: 15 s at most");
  assert.equal(clipLock(a, st(true), TR), null);
  assert.equal(clipLock(a, st(true, false), TR), "Join the voiceover first");
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

// ---- Task 6: voiceover changed ----
const VO_WAV = DIR + "\\Film A_voiceover.wav";
const TRPATH = DIR + "\\studio\\voiceover_transcript.json";
const tickN = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise((r) => setImmediate(r)); };

// content: map of clip audio file name -> bytes the fake ffmpeg "cuts"
async function vsetup({ content = {}, transcript = TR, ready = true } = {}) {
  const s = await csetup();
  const { host, store } = s;
  host.cuts = [];
  await host.fs.mkdir(DIR + "\\studio\\presenter");
  host.spawnScript(async (cmd, args, _o, p) => {
    if (cmd !== "ffmpeg") return p.exit(1);
    const out = args[args.length - 1];
    host.cuts.push(args);
    const name = out.split("\\").pop();
    if (!(name in content)) return p.exit(1);
    await host.fs.write(out, content[name]);
    p.exit(0);
  });
  await host.fs.write(TRPATH, JSON.stringify(transcript));
  await store.update((d) => { d.mix.voiceover = { status: "done", wav: VO_WAV, transcript: TRPATH }; });
  if (ready) await host.fs.write(VO_WAV, "w");
  const sigOf = async (text) => { const f = DIR + "\\tmp_sig.wav"; await host.fs.write(f, text); return audioSigOf(host, f, 5); };
  return { ...s, sigOf, content };
}
const setSig = (store, id, sig) => store.update((d) => { d.assets.find((x) => x.id === id).takes[0].audioSig = sig; });
const mkTake = (store, id, status, extra = {}) => store.update((d) => {
  const a = d.assets.find((x) => x.id === id); a.takes = [{ n: 1, status, ...extra }]; a.chosen = 1;
});
const CHK = (id) => `check_${id}_audio.mp3`;

test("checkClipAudio: unchanged audio sets no flag", async () => {
  const { ctx, store, sigOf, host } = await vsetup({ content: { [CHK("TC-01")]: "AAA" } });
  await mkTake(store, "TC-01", "done", { audioSig: await sigOf("AAA") });
  await checkClipAudio(ctx);
  assert.equal(store.state.assets[0].voiceoverChanged, undefined);
  assert.equal(host.cuts.length, 1);
  assert.ok(host.cuts[0].some((a) => a.endsWith("\\studio\\presenter\\check_TC-01_audio.mp3")));
});

test("checkClipAudio: changed audio flags the clip, rewrites waiting; a later match clears it", async () => {
  const content = { [CHK("TC-01")]: "BBB" };
  const { ctx, store, sigOf } = await vsetup({ content });
  await mkTake(store, "TC-01", "done", { audioSig: await sigOf("AAA") });
  // A shot list exists, so the waiting line talks about clips (clips alone say "Shot list not made yet").
  await store.update((d) => { d.assets.push({ id: "HF-01", kind: "broll", line: "A b-roll line here.", takes: [], chosen: 0, approved: true }); });
  await checkClipAudio(ctx);
  const a = store.state.assets[0];
  assert.equal(a.voiceoverChanged, true);
  assert.equal(a.staleReason, undefined);
  assert.match(store.state.waiting, /1 clip out of step/);
  content[CHK("TC-01")] = "AAA";
  await checkClipAudio(ctx);
  assert.equal(store.state.assets[0].voiceoverChanged, undefined);
});

test("checkClipAudio: a line that only moved in time (same audio, other start) is not flagged; never touches portrait stale", async () => {
  const moved = { sentences: [{ sentence: "01", start: 7, end: 12 }, { sentence: "03", start: 21, end: 30 }] };
  const { ctx, store, sigOf, host } = await vsetup({ content: { [CHK("TC-01")]: "AAA" }, transcript: moved });
  await mkTake(store, "TC-01", "done", { audioSig: await sigOf("AAA") });
  await store.update((d) => { d.assets[0].staleReason = "portrait"; });
  await checkClipAudio(ctx);
  assert.equal(store.state.assets[0].voiceoverChanged, undefined);
  assert.equal(store.state.assets[0].staleReason, "portrait");
  const a = host.cuts[0];
  assert.equal(a[a.indexOf("-ss") + 1], "7");
  assert.equal(a[a.indexOf("-to") + 1], "12");
});

test("checkClipAudio: skips running takes, takes without audioSig, lines missing from the transcript; no-op without a done voiceover", async () => {
  const { ctx, store, host } = await vsetup({ content: { [CHK("TC-01")]: "X", [CHK("TC-02")]: "X" } });
  await mkTake(store, "TC-01", "running");
  await mkTake(store, "TC-02", "done"); // no audioSig
  await checkClipAudio(ctx);
  assert.equal(host.cuts.length, 0);
  await store.update((d) => { d.mix.voiceover.status = "running"; });
  await mkTake(store, "TC-01", "done", { audioSig: { lengthS: 5, hash: "h" } });
  await checkClipAudio(ctx);
  assert.equal(host.cuts.length, 0);
  await store.update((d) => { d.mix.voiceover = { status: "done", wav: VO_WAV, transcript: DIR + "\\nope.json" }; });
  await checkClipAudio(ctx);
  assert.equal(host.cuts.length, 0);
});

test("keepAnyway clears the flag, records keptAt and keptSig; same new audio is not re-flagged, a different one is", async () => {
  const content = { [CHK("TC-01")]: "BBB" };
  const { ctx, store, sigOf } = await vsetup({ content });
  await mkTake(store, "TC-01", "done", { audioSig: await sigOf("AAA") });
  await checkClipAudio(ctx);
  assert.equal(store.state.assets[0].voiceoverChanged, true);
  await keepAnyway(ctx, "TC-01");
  let a = store.state.assets[0];
  assert.equal(a.voiceoverChanged, undefined);
  assert.ok("keptAt" in a);
  assert.equal(a.keptSig.hash, (await sigOf("BBB")).hash);
  assert.doesNotMatch(String(store.state.waiting), /out of step/);
  await checkClipAudio(ctx);
  assert.equal(store.state.assets[0].voiceoverChanged, undefined);
  content[CHK("TC-01")] = "CCC";
  await checkClipAudio(ctx);
  assert.equal(store.state.assets[0].voiceoverChanged, true);
  await assert.rejects(() => keepAnyway(ctx, "TC-99"), /Unknown/);
});

test("deriveWaiting counts clips out of step", () => {
  const mk = (id, extra) => ({ id, kind: "presenter", lineId: id, takes: [{ n: 1, status: "done" }], chosen: 1, approved: true, ...extra });
  const hf = { id: "HF-01", kind: "broll", line: "A b-roll line here.", takes: [{ n: 1, status: "done" }], chosen: 1, approved: true };
  assert.equal(deriveWaiting([hf, mk("a", { voiceoverChanged: true })]), "1 clip out of step");
  assert.equal(deriveWaiting([hf, mk("a", { voiceoverChanged: true }), mk("b", { voiceoverChanged: true })]), "2 clips out of step");
  // An unapproved out-of-step clip counts once, as out of step.
  assert.equal(deriveWaiting([hf, mk("a", { approved: false, voiceoverChanged: true }), mk("b", {})]), "1 clip out of step");
  assert.equal(deriveWaiting([hf, mk("a", {})]), "All shots approved");
});

test("watchJobs: a clip take that finishes after the join is checked when it finishes (Review Focus 5)", async () => {
  let release;
  const runners = { higgsfield: { start: (j) => new Promise((r) => { release = () => r({ file: j.input.out + ".mp4", meta: { hfId: "x", audioSig: { lengthS: 5, hash: "old" } } }); }) } };
  const s = await csetup(runners);
  const { host, store, jobs, ctx } = s;
  host.spawnScript(async (cmd, args, _o, p) => { await host.fs.write(args[args.length - 1], "NEW"); p.exit(0); });
  await host.fs.mkdir(DIR + "\\studio\\presenter");
  await host.fs.write(VO_WAV, "w");
  await host.fs.write(TRPATH, JSON.stringify(TR));
  await store.update((d) => { d.mix.voiceover.transcript = TRPATH; });
  watchJobs(ctx);
  await startTake(ctx, "TC-01");
  await tickN();
  assert.equal(store.state.assets[0].takes[0].status, "running");
  await checkClipAudio(ctx); // the join finished while it ran: skipped
  assert.equal(store.state.assets[0].voiceoverChanged, undefined);
  release();
  await until(() => store.state.assets[0].voiceoverChanged);
  assert.equal(store.state.assets[0].takes[0].status, "done");
  assert.equal(store.state.assets[0].voiceoverChanged, true);
});

test("watchJobs: a voiceover job turning done runs the check; an error in the check is logged, not thrown", async () => {
  const runners = { voicejoin: { start: async () => ({ file: "v.wav", meta: { wav: VO_WAV, transcript: TRPATH } }) } };
  const s = await csetup(runners);
  const { host, store, jobs, ctx } = s;
  host.spawnScript(async (cmd, args, _o, p) => { await host.fs.write(args[args.length - 1], "NEW"); p.exit(0); });
  await host.fs.mkdir(DIR + "\\studio\\presenter");
  await host.fs.write(VO_WAV, "w");
  await host.fs.write(TRPATH, JSON.stringify(TR));
  await mkTake(store, "TC-01", "done", { audioSig: { lengthS: 5, hash: "old" } });
  await store.update((d) => { d.mix.voiceover = { id: "VOICEOVER", status: "queued", takes: [{ n: 1, status: "queued" }] }; });
  watchJobs(ctx);
  jobs.add({ film: store.dir, assetId: "VOICEOVER", take: 1, tool: "voicejoin", what: "v", why: "w", input: {} });
  await until(() => store.state.assets[0].voiceoverChanged);
  assert.equal(store.state.mix.voiceover.status, "done");
  assert.equal(store.state.assets[0].voiceoverChanged, true);
  // a broken transcript is logged and the watcher keeps working
  await host.fs.write(TRPATH, "{not json");
  await store.update((d) => { d.mix.voiceover = { id: "VOICEOVER", status: "queued", takes: [{ n: 2, status: "queued" }] }; });
  jobs.add({ film: store.dir, assetId: "VOICEOVER", take: 2, tool: "voicejoin", what: "v", why: "w", input: {} });
  await until(() => store.state.mix.voiceover.status === "done" && store.state.mix.voiceover.takes?.[0]?.n === 2);
  await tickN(20);
  assert.equal(store.state.mix.voiceover.status, "done");
});

// ---- coalescing: the check never blocks job mirroring, never runs twice at once ----
async function gated() {
  const rel = {};
  const runners = { higgsfield: { start: (j) => new Promise((r) => { rel[j.assetId] = () => r({ file: j.input.out + ".mp4", meta: { hfId: "x", audioSig: { lengthS: 5, hash: "old" } } }); }) } };
  const s = await csetup(runners);
  const { host, store, ctx } = s;
  s.gate = { open: false, waiters: [] };
  s.reads = 0;
  const read = host.fs.read.bind(host.fs);
  host.fs.read = async (p, ...r) => { if (p === TRPATH) s.reads++; return read(p, ...r); };
  host.spawnScript(async (cmd, args, _o, p) => {
    if (!s.gate.open) await new Promise((r) => s.gate.waiters.push(r));
    await host.fs.write(args[args.length - 1], "NEW"); p.exit(0);
  });
  s.release = () => { s.gate.open = true; s.gate.waiters.forEach((f) => f()); };
  await host.fs.mkdir(DIR + "\\studio\\presenter");
  await host.fs.write(VO_WAV, "w");
  await host.fs.write(TRPATH, JSON.stringify(TR));
  await store.update((d) => { d.mix.voiceover.transcript = TRPATH; });
  s.rel = rel;
  watchJobs(ctx);
  await startTake(ctx, "TC-01");
  await startTake(ctx, "TC-02");
  await until(() => rel["TC-01"] && rel["TC-02"]);
  return s;
}

test("watchJobs: a second trigger while a check runs gives exactly one more run; job mirroring is not held up", async () => {
  const s = await gated();
  const { store, rel } = s;
  rel["TC-01"]();
  await until(() => store.state.assets[0].takes[0].status === "done");
  await until(() => s.gate.waiters.length === 1); // check 1 is cutting TC-01, held
  assert.equal(s.reads, 1);
  rel["TC-02"](); // another trigger, and it is mirrored while check 1 is stuck
  await until(() => store.state.assets[1].takes[0].status === "done");
  assert.equal(store.state.assets[1].takes[0].status, "done");
  assert.equal(s.reads, 1);
  s.release();
  await until(() => store.state.assets[1].voiceoverChanged);
  await tickN(40);
  assert.equal(s.reads, 2);
  assert.equal(store.state.assets[0].voiceoverChanged, true);
  assert.equal(store.state.assets[1].voiceoverChanged, true);
});

test("watchJobs: a failing check is logged as 'Clip audio check failed' and the watcher keeps going", async () => {
  const s = await gated();
  const { store, host, rel } = s;
  const logs = [];
  const log = store.log.bind(store);
  store.log = async (m) => { logs.push(m); return log(m); };
  s.release();
  await host.fs.write(TRPATH, "{not json");
  rel["TC-01"]();
  await until(() => logs.some((m) => /^Clip audio check failed/.test(m)));
  assert.ok(logs.some((m) => /^Clip audio check failed/.test(m)));
  rel["TC-02"]();
  await until(() => store.state.assets[1].takes[0].status === "done");
  assert.equal(store.state.assets[1].takes[0].status, "done");
});

// ---- final-review fix wave ----
import { seedCameraLines } from "../js/presenter.js";
import { choose } from "../js/redo.js";

test("seedCameraLines: the script's marks become the chosen lines on first open, from the script; free", async () => {
  const { ctx, store, host } = await setup({ transcript: null });
  let asked = 0;
  host.claudeScript(() => { asked++; throw new Error("no Claude here"); });
  assert.equal(store.state.presenter?.lines, undefined);
  assert.equal(await seedCameraLines(ctx), true);
  assert.deepEqual(store.state.presenter.lines, [{ id: "01", from: "script" }, { id: "03", from: "script" }]);
  assert.deepEqual(store.state.assets.map((a) => [a.id, a.lineId]), [["TC-01", "01"], ["TC-02", "03"]]);
  assert.equal(asked, 0);
  // Never again: Jon's choice stands, even none.
  await setCameraLines(ctx, []);
  assert.equal(await seedCameraLines(ctx), false);
  assert.deepEqual(store.state.presenter.lines, []);
});

test("seedCameraLines: a marked line over 15 s is left out when the transcript is known; no marks, no seeding", async () => {
  const long = { sentences: [{ sentence: "01", start: 0, end: 5 }, { sentence: "03", start: 10, end: 30 }] };
  const a = await setup({ transcript: long });
  await seedCameraLines(a.ctx);
  assert.deepEqual(a.store.state.presenter.lines.map((l) => l.id), ["01"]);
  const b = await setup({ lineScript: parseLineScript("[01]\nOne.\n[02]\nTwo.\n") });
  assert.equal(await seedCameraLines(b.ctx), false);
  assert.equal(b.store.state.presenter?.lines, undefined);
});

test("clipLock: a transcript from an earlier join locks the clip (Join the voiceover first)", () => {
  const a = { lineId: "01" };
  const st = { presenter: { portrait: { n: 1, hfId: "h" } }, mix: { voiceover: { status: "done", wav: "v.wav", at: 200 } } };
  assert.equal(clipLock(a, st, TR, 100), "Join the voiceover first");
  assert.equal(clipLock(a, st, TR, null), "Join the voiceover first");
  assert.equal(clipLock(a, st, TR, 200), null);
});

test("choose on a clip clears its out-of-step flag and checks the new take's audio", async () => {
  const { ctx, store, sigOf, host } = await vsetup({ content: { [CHK("TC-01")]: "BBB" } });
  await store.update((d) => {
    const a = d.assets.find((x) => x.id === "TC-01");
    a.takes = [{ n: 1, status: "done", file: "a.mp4" }, { n: 2, status: "done", file: "b.mp4" }];
    a.chosen = 1; a.voiceoverChanged = true;
  });
  await setSig(store, "TC-01", await sigOf("AAA"));
  await store.update((d) => { const a = d.assets.find((x) => x.id === "TC-01"); a.takes[1].audioSig = a.takes[0].audioSig; });
  await choose(ctx, "TC-01", 2);
  assert.equal(store.state.assets.find((x) => x.id === "TC-01").voiceoverChanged, undefined);
  await until(() => host.cuts.length > 0 && store.state.assets.find((x) => x.id === "TC-01").voiceoverChanged);
  assert.equal(host.cuts.length, 1);
  assert.equal(store.state.assets.find((x) => x.id === "TC-01").voiceoverChanged, true);
});
