import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { makeJobs } from "../js/jobs.js";
import { watchJobs, holders } from "../js/redo.js";
import { startJoin, startFit, startMix } from "../js/mixplan.js";
import { marksSig, takeSig } from "../js/pacing.js";
import { pacingStale } from "../js/mixplan.js";
import { canApply, shiftJonStarts, applyPauses, NO_FRAME } from "../js/pacingchain.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const MEDIA = DIR + "\\studio\\media";
const VO = DIR + "\\studio\\voiceover";
const MIXD = DIR + "\\studio\\mix";
const REC = "C:\\rec";
const SCORE1 = MEDIA + "\\Film_A_score_t1.wav";
const SCORE2 = MEDIA + "\\Film_A_score_t2.wav";
const SFX1 = MEDIA + "\\Film_A_sfx_sfx-01_door_t1.wav";
const CSV = "clip,section,name,start_s,end_s,timecode\n01,Opening,film_a_01,0.0,14.0,00:00.00\n02,Opening,film_a_02,14.6,30.0,00:14.60\n";
const MEASURE = { duration_s: 60, loud: Array.from({ length: 600 }, () => -20), beats: [], bpm: null, moves: [{ t: 6.5, kind: "rise", db: 7 }] };
const lineScript = { name: "film_a", path: DIR + "\\film_a_line_script.txt", lines: [{ id: "01.1", section: "Opening", text: "Hello." }] };

function score(chosen = 1, approved = true) {
  return { id: "SCORE", cue: "Score", prompt: "p", durationS: 60, approved, chosen,
    takes: [{ n: 1, status: "done", file: SCORE1 }, { n: 2, status: "done", file: SCORE2 }] };
}
const sfx = (o = {}) => ({ id: "SFX-01", cue: "door", prompt: "p", durationS: 3, loop: false, source: "stableaudio", lineId: "01", startS: 8,
  approved: true, chosen: 1, takes: [{ n: 1, status: "done", file: SFX1, meanDb: -25 }], ...o });

async function setup({ settings = {}, audio, csv = CSV, python = true, exportS = 42.5 } = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  await host.fs.mkdir(MEDIA);
  if (python) {
    await host.fs.mkdir("C:\\sr\\.venv\\Scripts");
    for (const f of ["python.exe", "pythonw.exe"]) await host.fs.write("C:\\sr\\.venv\\Scripts\\" + f, "exe");
  }
  for (const f of [SCORE1, SCORE2, SFX1]) await host.fs.write(f, "audio");
  const store = await openFilm(host, DIR);
  await store.update((d) => { d.audio = audio ?? { flowId: null, score: score(), sfx: [sfx(), sfx({ id: "SFX-02", startS: null, approved: true })] }; });
  const calls = { join: [], measure: [], fit: [], mix: [] };
  const csvText = csv;
  const runners = {
    block: { lane: "gpu", start: () => new Promise(() => {}) },
    voicejoin: { lane: "gpu", async start(job) {
      calls.join.push(job.input);
      const wav = VO + "\\film_a_voiceover.wav", csv = VO + "\\film_a_voiceover_timings.csv";
      await host.fs.mkdir(VO);
      await host.fs.write(csv, csvText);
      return { file: wav, meta: { wav, csv, transcript: VO + "\\t.json", lengthS: 30.5, tightened: [{ id: "01.1", at_s: 1, from_s: 0.9, to_s: 0.3 }], tight: [{ id: "01.1", at_s: 2 }], extra: [], silent: [],
        duplicates: [{ id: "01.1", files: [REC + "\\film_a\\film_a_01.1.wav", REC + "\\old\\film_a_01.1.wav"] }] } };
    } },
    stemfit: { lane: "gpu", async start(job) {
      const i = job.input;
      if (i.measureOnly) {
        calls.measure.push(i);
        const f = i.measureOut ?? i.score + ".measure.json";
        // an export (measured into Studio's mix folder) runs exportS; a score take runs 60 s
        await host.fs.write(f, JSON.stringify(i.measureOut ? { ...MEASURE, duration_s: exportS } : MEASURE));
        return { file: f, meta: { measureFile: f, lengthS: 60 } };
      }
      calls.fit.push(i);
      await host.fs.mkdir(MIXD);
      await host.fs.write(i.out + ".measure.json", JSON.stringify({ ...MEASURE, duration_s: 42.5 }));
      return { file: i.out, meta: { lengthS: 42.5, measureFile: i.out + ".measure.json" } };
    } },
    mixdown: { lane: "gpu", async start(job) {
      calls.mix.push(job.input);
      const b = MIXD + "\\Film_A";
      return { file: b + "_mix.wav", meta: { files: { wav: b + "_mix.wav", mp3: b + "_mix_preview.mp3", voice: b + "_voice_stem.flac", music: b + "_music_stem.flac" }, unplaced: ["SFX-02"] } };
    } },
  };
  const jobs = makeJobs(host, { runners });
  const ctx = { host, store, jobs, lineScript, settings: { autocueRecordings: REC, autocueDir: "C:\\autocue", stemRemixerDir: "C:\\sr", endCardS: 12, ...settings } };
  const off = watchJobs(ctx);
  let plans = 0;
  host.claudeScript((kind, input) => {
    plans++;
    const filmS = Number(/"filmS":([\d.]+)/.exec(input)[1]);
    return { steps: [{ from_s: 0, to_s: filmS, tempo: 1, xfade_s: 0.03 }], notes: "Kept the opening." };
  });
  return { host, store, jobs, ctx, calls, off, plans: () => plans };
}
const st = (s) => s.store.state.mix;
async function until(fn, what = "condition") {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(`timed out waiting for ${what}`);
}
const MARKED = { lines: { "01.1": { pauses: [{ key: "end", size: "long", by: "jon" }] } } };
async function prepared(s, { fitSource = "app", mix = true } = {}) {
  await startJoin(s.ctx);
  await until(() => st(s).voiceover?.status === "done");
  await startFit(s.ctx, { note: "keep the rise" });
  await until(() => st(s).fit?.status === "done");
  if (mix) { await startMix(s.ctx); await until(() => st(s).mix?.status === "done"); }
  await s.store.update((d) => { d.mix.pacing = JSON.parse(JSON.stringify(MARKED)); if (fitSource !== "app") d.mix.fit.source = fitSource; });
  s.ctx.narration = { rows: [{ id: "01.1", status: "ok" }] };
}
const order = (s) => s.jobs.list().map((j) => j.assetId);

test("the chain joins, fits with the previous note, then mixes, each after the last", async () => {
  const s = await setup();
  await prepared(s);
  const n0 = order(s).length;
  const steps = [];
  const r = await applyPauses(s.ctx, { onStep: (x) => steps.push(x) });
  assert.deepEqual(r, { stoppedAt: null });
  assert.deepEqual(steps, ["VOICEOVER", "FIT", "MIX"]);
  assert.deepEqual(order(s).slice(n0).filter((x) => x !== "MEASURE"), ["VOICEOVER", "FIT", "MIX"]);
  assert.equal(st(s).fit.note, "keep the rise");
  assert.ok(!("appliedSig" in st(s).pacing) && !("applied" in st(s).pacing), "no copy of the join's record on the marks");
  assert.equal(st(s).voiceover.pausesSig, marksSig(MARKED, {}));
  assert.equal(s.calls.join.length, 2);
});

test("without an earlier mix the chain stops after the fit", async () => {
  const s = await setup();
  await prepared(s, { mix: false });
  assert.deepEqual(await applyPauses(s.ctx, {}), { stoppedAt: null });
  assert.equal(s.calls.mix.length, 0);
  assert.equal(s.calls.fit.length, 2);
});

test("a Stem Remixer fit stops after the join", async () => {
  const s = await setup();
  await prepared(s, { fitSource: "stemremixer" });
  const fits = s.calls.fit.length;
  assert.deepEqual(await applyPauses(s.ctx, {}), { stoppedAt: "FIT" });
  assert.equal(s.calls.fit.length, fits);
  assert.equal(s.calls.join.length, 2);
});

test("a join failure rejects and starts nothing else", async () => {
  const s = await setup();
  await prepared(s);
  const jobs0 = s.jobs.list().length;
  // the join's timings write fails
  const orig = s.host.fs.write;
  s.host.fs.write = async (p, d) => { if (String(p).endsWith("_timings.csv")) throw new Error("disk full"); return orig(p, d); };
  await assert.rejects(applyPauses(s.ctx, {}));
  s.host.fs.write = orig;
  const added = s.jobs.list().slice(jobs0).map((j) => j.assetId);
  assert.deepEqual(added, ["VOICEOVER"]);
});

const TR_OLD = { sentences: [{ sentence: "02.1", start: 8, end: 12 }, { sentence: "02.2", start: 12.5, end: 14 }] };
const TR_NEW = { sentences: [{ sentence: "02.1", start: 8.3, end: 12.6 }, { sentence: "02.2", start: 13.4, end: 15 }] };
test("shiftJonStarts moves Jon's cues with the pause, leaves Claude's out", () => {
  const cues = [{ id: "A", startS: 10, startSBy: "jon" }, { id: "B", startS: 10 }, { id: "C", startS: 3, startSBy: "jon" }];
  const out = shiftJonStarts(cues, TR_OLD, TR_NEW, {}, { "02.1": [{ at_s: 1.0, add_s: 0.6 }] });
  assert.deepEqual(out, [{ id: "A", startS: 10.9 }, { id: "C", startS: 3 }]);
});

test("canApply", () => {
  const state = { mix: { voiceover: { status: "done", allowedIds: [] } } };
  const row = (id, status) => ({ id, status });
  assert.equal(canApply({ state, narration: { rows: [] }, running: true }).ok, false);
  assert.equal(canApply({ state: { mix: { fit: { status: "running" } } }, narration: { rows: [] } }).ok, false);
  const bad = canApply({ state, narration: { rows: [row("03.2", "flagged")] } });
  assert.deepEqual(bad, { ok: false, why: "Newly flagged: 03.2. Use Join anyway first." });
  assert.equal(canApply({ state, narration: { rows: [row("03.2", "rerecord")] } }).ok, true);
  assert.equal(canApply({ state: { mix: { voiceover: { status: "done", allowedIds: ["03.2"] } } }, narration: { rows: [row("03.2", "flagged")] } }).ok, true);
});

test("after a restart with an interrupted join, the marks are still stale: Apply is offered, nothing starts", async () => {
  const s = await setup();
  await prepared(s);
  await s.store.update((d) => { d.mix.voiceover.status = "failed"; });
  const sig = marksSig(MARKED, {});
  assert.equal(pacingStale({ mix: { ...st(s), voiceover: { ...st(s).voiceover, status: "done", pausesSig: "old" } } }, sig), true);
  assert.equal(canApply({ state: s.store.state, narration: s.ctx.narration, sig }).ok, true);
  const n = s.jobs.list().length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.jobs.list().length, n);
});

test("the chain shifts Jon's cues using the old and new transcripts", async () => {
  const s = await setup();
  await prepared(s);
  const TP = VO + "\\t.json";
  await s.host.fs.write(TP, JSON.stringify({ sentences: [{ sentence: "01.1", start: 8, end: 12 }] }));
  await s.store.update((d) => { d.audio.sfx[0].startS = 10; d.audio.sfx[0].startSBy = "jon"; d.audio.sfx[1].startS = 10; d.mix.voiceover.pausesApplied = {}; });
  const orig = s.host.fs.write;
  s.host.fs.write = async (p, d) => {
    await orig(p, d);
    if (String(p).endsWith("_timings.csv")) await orig(TP, JSON.stringify({ sentences: [{ sentence: "01.1", start: 8.3, end: 12.6 }] }));
  };
  await applyPauses(s.ctx, {});
  const [a, b] = s.store.state.audio.sfx;
  assert.equal(a.startS, 10.3);
  assert.equal(a.startSBy, "jon");
  assert.equal(b.startS, 10, "a cue that is not Jon's is left alone");
});

test("a Re-record row alone never turns on allowFlagged", async () => {
  const s = await setup();
  await prepared(s);
  s.ctx.narration = { rows: [{ id: "01.1", status: "rerecord", checkedStatus: "ok" }] };
  assert.equal(canApply({ state: s.store.state, narration: s.ctx.narration }).ok, true);
  await applyPauses(s.ctx, {});
  assert.equal(s.calls.join.at(-1).allowFlagged, false);
  assert.equal(st(s).voiceover.allowFlagged, false);
  await applyPauses(s.ctx, { joinOnly: true, allowFlagged: true });
  assert.equal(s.calls.join.at(-1).allowFlagged, false, "Join anyway with only Re-record lines");
});

test("allowFlagged goes on when the last join had it, or for flagged lines already allowed", async () => {
  const s = await setup();
  await prepared(s);
  await s.store.update((d) => { d.mix.voiceover.allowFlagged = true; });
  s.ctx.narration = { rows: [{ id: "01.1", status: "rerecord", checkedStatus: "ok" }] };
  await applyPauses(s.ctx, {});
  assert.equal(s.calls.join.at(-1).allowFlagged, true, "the last join had it");
  await s.store.update((d) => { d.mix.voiceover.allowFlagged = false; d.mix.voiceover.allowedIds = ["01.2"]; });
  s.ctx.narration = { rows: [{ id: "01.1", status: "rerecord", checkedStatus: "ok" }, { id: "01.2", status: "flagged" }] };
  await applyPauses(s.ctx, {});
  assert.equal(s.calls.join.at(-1).allowFlagged, true, "a flagged line Jon already joined anyway");
  assert.deepEqual(st(s).voiceover.allowedIds, ["01.2"]);
  await s.store.update((d) => { d.mix.voiceover.allowFlagged = false; d.mix.voiceover.allowedIds = []; });
  s.ctx.narration = { rows: [{ id: "01.2", status: "flagged" }] };
  await applyPauses(s.ctx, { joinOnly: true, allowFlagged: true });
  assert.equal(s.calls.join.at(-1).allowFlagged, true, "Join anyway with a flagged line");
});

test("no done fit stops at FIT", async () => {
  const s = await setup();
  await startJoin(s.ctx);
  await until(() => st(s).voiceover?.status === "done");
  await s.store.update((d) => { d.mix.pacing = JSON.parse(JSON.stringify(MARKED)); });
  s.ctx.narration = { rows: [{ id: "01.1", status: "ok" }] };
  assert.deepEqual(await applyPauses(s.ctx, {}), { stoppedAt: "FIT" });
  assert.equal(s.calls.fit.length, 0);
});

// ---- the last good join's frame (final review: R1-R4) ----
const TP = VO + "\\t.json";
const WORDS = [["Pictish", 8.0, 8.4], ["village", 8.45, 8.8], ["in", 8.85, 8.95], ["Orkney.", 9.0, 9.5]];
const r3 = (n) => Math.round(n * 1000) / 1000;
// Each join writes a transcript whose words sit where the pauses it was sent put them.
function realTranscripts(s) {
  const orig = s.host.fs.write.bind(s.host.fs);
  s.host.fs.write = async (p, d) => {
    await orig(p, d);
    if (!String(p).endsWith("_timings.csv")) return;
    const input = s.calls.join.at(-1);
    const inside = input?.pauses ? JSON.parse(await s.host.fs.read(input.pauses, "utf8")).inside?.["01.1"] ?? [] : [];
    const shift = (rel) => inside.filter((a) => a.at_s < rel).reduce((n, a) => n + a.add_s, 0);
    const words = WORDS.map(([word, a, b]) => ({ sentence: "01.1", word, start: r3(a + shift(a - 8)), end: r3(b + shift(a - 8)) }));
    await orig(TP, JSON.stringify({ sentences: [{ sentence: "01.1", start: 8, end: words.at(-1).end }], words }));
  };
  return orig;
}
const INSIDE = { lines: { "01.1": { pauses: [
  { key: "village#1", word: "village", nth: 1, size: "medium", by: "jon" },
  { key: "in#1", word: "in", nth: 1, size: "medium", by: "jon" },
  { key: "end", word: null, nth: null, size: "short", by: "jon" },
] } } };
const sent = async (s) => JSON.parse(await s.host.fs.read(s.calls.join.at(-1).pauses, "utf8"));
function failJoins(s) {
  const prev = s.host.fs.write;
  s.host.fs.write = async (p, d) => { if (String(p).endsWith("_timings.csv")) throw new Error("disk full"); return prev(p, d); };
  return () => { s.host.fs.write = prev; };
}

test("after a failed join, Apply and Join again keep the inside marks at the last good join's at_s", async () => {
  const s = await setup();
  realTranscripts(s);
  await prepared(s);
  await s.store.update((d) => { d.mix.pacing = JSON.parse(JSON.stringify(INSIDE)); });
  await applyPauses(s.ctx, {});
  const good = (await sent(s)).inside;
  assert.deepEqual(good, { "01.1": [{ at_s: 0.825, add_s: 0.6 }, { at_s: 0.975, add_s: 0.6 }] });
  const sig = st(s).voiceover.pausesSig;

  const restore = failJoins(s);
  await assert.rejects(applyPauses(s.ctx, {}));
  restore();
  assert.equal(st(s).voiceover.status, "failed");

  await applyPauses(s.ctx, {});
  assert.deepEqual((await sent(s)).inside, good, "Apply after the failure");
  assert.equal(st(s).voiceover.pausesSig, sig);
  assert.deepEqual(st(s).voiceover.pausesApplied, good);

  const restore2 = failJoins(s);
  await assert.rejects(applyPauses(s.ctx, { joinOnly: true }));
  restore2();
  await applyPauses(s.ctx, { joinOnly: true });
  assert.deepEqual((await sent(s)).inside, good, "Join again after the failure");
  assert.deepEqual((await sent(s)).after, { "01.1": 0.3 });
});

test("when the last good join's word timings can't be read, Apply refuses; Join again joins without any pauses", async () => {
  const s = await setup();
  realTranscripts(s);
  await prepared(s);
  await s.store.update((d) => { d.mix.pacing = JSON.parse(JSON.stringify(INSIDE)); });
  await s.host.fs.write(TP, "not json");
  const n = s.jobs.list().length;
  await assert.rejects(applyPauses(s.ctx, {}), (e) => e.message === NO_FRAME);
  assert.equal(s.jobs.list().length, n, "Apply starts nothing");
  assert.equal(NO_FRAME, "Couldn't read the last voiceover's word timings, so the pauses can't be placed. Join again without changes first.");
  // "Join again without changes": no pauses file at all, and the marks are not taken as joined.
  const r = await applyPauses(s.ctx, { joinOnly: true });
  assert.deepEqual(r, { stoppedAt: null, joinOnly: true, withoutPauses: true });
  assert.ok(!("pauses" in s.calls.join.at(-1)));
  assert.equal(st(s).voiceover.pausesSig, null);
  assert.equal(pacingStale(s.store.state, marksSig(st(s).pacing, {})), true);
  // From that join the marks are placed again, at their unpaused times.
  await applyPauses(s.ctx, {});
  assert.deepEqual((await sent(s)).inside, { "01.1": [{ at_s: 0.825, add_s: 0.6 }, { at_s: 0.975, add_s: 0.6 }] });
});

test("gap marks alone need no word timings", async () => {
  const s = await setup();
  realTranscripts(s);
  await prepared(s);
  await s.host.fs.write(TP, "not json");
  await applyPauses(s.ctx, { joinOnly: true });
  assert.deepEqual((await sent(s)).after, { "01.1": 1 });
});

test("a line with a take newer than the last good join: its inside marks are not sent, its gap mark is", async () => {
  const s = await setup();
  realTranscripts(s);
  await prepared(s);
  await s.store.update((d) => { d.mix.pacing = JSON.parse(JSON.stringify(INSIDE)); });
  const takeS = st(s).voiceover.startedAt / 1000 + 5;
  const row = { id: "01.1", status: "ok", file: "C:\\rec\\film_a_01.1.wav", takeS };
  s.ctx.narration = { rows: [row] };
  await applyPauses(s.ctx, { joinOnly: true });
  const f = await sent(s);
  assert.deepEqual(f.inside, {});
  assert.deepEqual(f.after, { "01.1": 0.3 });
  assert.deepEqual(st(s).voiceover.pausesApplied, {});
  // The inside marks were not joined, so they still count as changed once the new take is in.
  assert.equal(pacingStale(s.store.state, marksSig(st(s).pacing, { "01.1": takeSig(row) })), true);
});

test("plain Join again moves Jon's cues with the pauses and does not fit or mix", async () => {
  const s = await setup();
  realTranscripts(s);
  await prepared(s);
  await s.store.update((d) => { d.mix.pacing = JSON.parse(JSON.stringify(INSIDE)); d.audio.sfx[0].startS = 9.2; d.audio.sfx[0].startSBy = "jon"; });
  const fits = s.calls.fit.length, mixes = s.calls.mix.length;
  const r = await applyPauses(s.ctx, { joinOnly: true });
  assert.deepEqual(r, { stoppedAt: null, joinOnly: true });
  // 9.2 is 0.2 s into "Orkney." (9.0): both 0.6 s pauses come before it.
  assert.equal(s.store.state.audio.sfx[0].startS, 10.4);
  assert.equal(s.calls.fit.length, fits);
  assert.equal(s.calls.mix.length, mixes);
});

test("plain Join with no marks sends no pauses file", async () => {
  const s = await setup();
  await prepared(s);
  await s.store.update((d) => { d.mix.pacing = { lines: {} }; });
  await applyPauses(s.ctx, { joinOnly: true });
  assert.ok(!("pauses" in s.calls.join.at(-1)));
  assert.equal(st(s).voiceover.pausesSig, null);
});
