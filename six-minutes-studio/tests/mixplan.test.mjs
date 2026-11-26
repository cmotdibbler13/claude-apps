import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { makeJobs } from "../js/jobs.js";
import { watchJobs, holders } from "../js/redo.js";
import { startJoin, startFit, startMix, useStemRemixerExport, approveMix, fitStale, mixStale, OUT_OF_DATE, parseCsv,
  openFitInStemRemixer, REJOIN, pastedPath } from "../js/mixplan.js";
import { MSG_NO_STEM_REMIXER, MSG_SET_STEM_REMIXER } from "../js/tools/stemfit.js";

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

async function setup({ settings = {}, audio, csv = CSV, python = true, exportS = 48.5 } = {}) {
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
      return { file: wav, meta: { wav, csv, transcript: VO + "\\t.json", lengthS: 30.5, tightened: [{ id: "01.1", at_s: 1, from_s: 0.9, to_s: 0.3 }], extra: [], silent: [],
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
      await host.fs.write(i.out + ".measure.json", JSON.stringify({ ...MEASURE, duration_s: 48.5 }));
      return { file: i.out, meta: { lengthS: 48.5, measureFile: i.out + ".measure.json" } };
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
async function until(fn, what = "condition") {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(`timed out waiting for ${what}`);
}
const st = (s) => s.store.state.mix;
async function joined(s) { await startJoin(s.ctx); await until(() => st(s)?.voiceover?.status === "done", "join"); }
async function fitted(s, opts) { await startFit(s.ctx, opts); await until(() => st(s)?.fit?.status === "done", "fit"); }
async function mixed(s) { await startMix(s.ctx); await until(() => st(s)?.mix?.status === "done", "mix"); }

test("startJoin queues a Voiceover join job and mirrors the result onto state.mix.voiceover", async () => {
  const s = await setup();
  await startJoin(s.ctx, { allowFlagged: true });
  const [j] = s.jobs.list();
  assert.equal(j.tool, "voicejoin");
  assert.equal(j.what, "Voiceover join");
  assert.equal(j.assetId, "VOICEOVER");
  assert.equal(j.take, 1);
  assert.deepEqual(j.input, { script: lineScript.path, takes: REC + "\\film_a", out: VO, allowFlagged: true });
  await until(() => st(s).voiceover.status === "done");
  const v = st(s).voiceover;
  assert.equal(v.wav, VO + "\\film_a_voiceover.wav");
  assert.equal(v.csv, VO + "\\film_a_voiceover_timings.csv");
  assert.equal(v.lengthS, 30.5);
  assert.equal(v.tightened.length, 1);
  assert.deepEqual(v.duplicates, [{ id: "01.1", files: [REC + "\\film_a\\film_a_01.1.wav", REC + "\\old\\film_a_01.1.wav"] }]);
  assert.equal(v.at, s.host.now());
  assert.equal(v.startedAt, s.host.now(), "the join keeps when it started, for takes saved during it");
  assert.equal(v.jobId, j.id);
  assert.equal(v.takes.length, 1);
  assert.ok(holders(s.store.state).some((h) => h.id === "VOICEOVER"));
});

test("a join is refused while one is running", async () => {
  const s = await setup();
  s.jobs.add({ film: DIR, assetId: "X", take: 1, tool: "block", input: {} }); // holds the gpu lane, so the join stays queued
  await startJoin(s.ctx);
  await assert.rejects(startJoin(s.ctx), { message: "The voiceover join is already running." });
});

test("startFit measures the score once, plans with Claude and queues a Score fit", async () => {
  const s = await setup();
  await joined(s);
  await fitted(s);
  assert.equal(s.calls.measure.length, 1);
  assert.equal(s.calls.measure[0].score, SCORE1);
  const fitJob = s.jobs.list().find((j) => j.assetId === "FIT");
  assert.equal(fitJob.what, "Score fit");
  assert.equal(fitJob.tool, "stemfit");
  assert.deepEqual(fitJob.input, { score: SCORE1, plan: { steps: [{ from_s: 0, to_s: 48.5, tempo: 1, xfade_s: 0.03 }] }, out: MIXD + "\\Film_A_score_fitted.wav" });
  const f = st(s).fit;
  assert.equal(f.source, "app");
  assert.equal(f.file, MIXD + "\\Film_A_score_fitted.wav");
  assert.equal(f.fromVoiceoverAt, st(s).voiceover.at);
  assert.equal(f.fromScoreTake, 1);
  assert.equal(f.sheet.rows.length, 1);
  assert.equal(f.sheet.rows[0].section, "Opening", "the sheet shows the ## title, not the file name");
  assert.deepEqual(f.targets.sections, [{ name: "Opening", startS: 6 }], "the mix marks and Claude's targets do too");
  assert.equal(f.sheet.rows[0].targetS, 6);
  assert.ok(Math.abs(f.sheet.rows[0].landsS - 6.5) < 1e-9);
  assert.equal(f.plan.notes, "Kept the opening.");
  assert.equal(fitStale(s.store.state), false);
  // a second fit uses the cached measure
  await fitted(s, { note: "keep the swell" });
  assert.equal(s.calls.measure.length, 1);
  assert.equal(st(s).fit.note, "keep the swell");
  assert.equal(s.plans(), 2);
});

test("Review Focus 3: re-running the join marks the fit and mix out of date until they are re-run", async () => {
  const s = await setup();
  await joined(s);
  await fitted(s);
  await mixed(s);
  assert.equal(fitStale(s.store.state), false);
  assert.equal(mixStale(s.store.state), false);
  s.host.t += 60_000;
  await startJoin(s.ctx);
  assert.equal(fitStale(s.store.state), true, "stale as soon as the new join starts");
  assert.equal(mixStale(s.store.state), true);
  await until(() => st(s).voiceover.status === "done");
  assert.equal(st(s).voiceover.at, s.host.now());
  assert.equal(fitStale(s.store.state), true);
  assert.equal(mixStale(s.store.state), true);
  assert.equal(OUT_OF_DATE, "Out of date: run again");
  await assert.rejects(approveMix(s.ctx), { message: "The mix is out of date. Make it again first." });
  await assert.rejects(startMix(s.ctx), { message: "The score fit is out of date. Fit it again first." });
  await fitted(s);
  assert.equal(fitStale(s.store.state), false);
  assert.equal(mixStale(s.store.state), true, "the mix was made from the old fit");
  await mixed(s);
  assert.equal(mixStale(s.store.state), false);
  await approveMix(s.ctx);
  assert.equal(st(s).mix.approved, true);
});

test("choosing another score take makes the fit and mix stale", async () => {
  const s = await setup();
  await joined(s);
  await fitted(s);
  await mixed(s);
  await s.store.update((d) => { d.audio.score.chosen = 2; });
  assert.equal(fitStale(s.store.state), true);
  assert.equal(mixStale(s.store.state), true);
});

test("startMix passes the voice, fitted score, approved SFX with starts, film length and the ride", async () => {
  const s = await setup();
  await joined(s);
  await fitted(s);
  await mixed(s);
  const [i] = s.calls.mix;
  assert.equal(i.voice, VO + "\\film_a_voiceover.wav");
  assert.equal(i.music, MIXD + "\\Film_A_score_fitted.wav");
  assert.equal(i.filmS, 48.5);
  assert.equal(i.out, MIXD + "\\Film_A_mix.wav");
  assert.deepEqual(i.sfx.map((x) => [x.id, x.file, x.startS, x.loop, x.meanDb]), [["SFX-01", SFX1, 8, false, -25], ["SFX-02", SFX1, null, false, -25]]);
  assert.equal(i.sfxDb, -18);
  assert.ok(Number.isFinite(i.ride.baseDb) && i.ride.ride.length >= 1);
  const m = st(s).mix;
  assert.equal(m.files.mp3, MIXD + "\\Film_A_mix_preview.mp3");
  assert.deepEqual(m.unplaced, ["SFX-02"]);
  assert.equal(m.fromFitAt, st(s).fit.at);
  assert.equal(s.jobs.list().find((j) => j.assetId === "MIX").what, "Mix preview");
  await approveMix(s.ctx);
  assert.equal(st(s).mix.approved, true);
});

test("the mix goes out of date when a placed sound effect's start, take or approval changes", async () => {
  for (const change of [(x) => { x.startS = 9; }, (x) => { x.chosen = 2; x.takes.push({ n: 2, status: "done", file: SFX1 }); }, (x) => { x.approved = false; }]) {
    const s = await setup();
    await joined(s);
    await fitted(s);
    await mixed(s);
    assert.equal(mixStale(s.store.state), false);
    await s.store.update((d) => change(d.audio.sfx[0]));
    assert.equal(mixStale(s.store.state), true);
    await assert.rejects(approveMix(s.ctx), { message: "The mix is out of date. Make it again first." });
  }
});

test("measure jobs are numbered 1, 2, 3 per film", async () => {
  const s = await setup();
  await joined(s);
  await fitted(s);
  await s.host.fs.write(SCORE1 + ".measure.json", "{}"); // not a usable measure: measured again
  await fitted(s);
  assert.deepEqual(s.jobs.list().filter((j) => j.assetId === "MEASURE").map((j) => j.take), [1, 2]);
});

test("a loop runs to the next section start", async () => {
  const s = await setup({ audio: { flowId: null, score: score(), sfx: [sfx({ loop: true, startS: 7 })] }, csv: CSV + "03,Middle,film_a_03,31.2,40.0,00:31.20\n" });
  await joined(s);
  await fitted(s);
  await mixed(s);
  assert.equal(s.calls.mix[0].sfx[0].endS, 37.2);
  assert.equal(s.calls.mix[0].filmS, 58.5);
});

test("no stemRemixerDir: the fit says exactly what to set and starts nothing", async () => {
  const s = await setup({ settings: { stemRemixerDir: null } });
  await joined(s);
  const before = s.jobs.list().length;
  await assert.rejects(startFit(s.ctx), { message: MSG_NO_STEM_REMIXER });
  assert.equal(s.jobs.list().length, before);
  assert.equal(s.plans(), 0);
});

test("the fit needs a joined voiceover and an approved score", async () => {
  let s = await setup();
  await assert.rejects(startFit(s.ctx), { message: "Join the voiceover first." });
  s = await setup({ audio: { flowId: null, score: score(1, false), sfx: [] } });
  await joined(s);
  await assert.rejects(startFit(s.ctx), { message: "Approve a score take first." });
  await assert.rejects(startMix(s.ctx), { message: "Fit the score first." });
});

test("useStemRemixerExport re-measures the export, rebuilds the sheet and the mix uses it", async () => {
  const s = await setup();
  await joined(s);
  await fitted(s);
  const EXP = "C:\\sr\\Stems\\Film_A_score_t1 [single]\\export.wav";
  await s.host.fs.mkdir("C:\\sr\\Stems\\Film_A_score_t1 [single]");
  await s.host.fs.write(EXP, "x");
  await useStemRemixerExport(s.ctx, EXP);
  const f = st(s).fit;
  assert.equal(f.source, "stemremixer");
  assert.equal(f.file, EXP);
  assert.equal(f.status, "done");
  assert.equal(s.calls.measure.at(-1).score, EXP);
  assert.ok(s.calls.measure.at(-1).measureOut.startsWith(MIXD + "\\"), "the measure is kept in Studio's mix folder");
  assert.ok(Math.abs(f.sheet.rows[0].landsS - 6.5) < 1e-9, "export moves are already in film time");
  assert.equal(fitStale(s.store.state), false);
  await mixed(s);
  assert.equal(s.calls.mix[0].music, EXP);
});

test("Review Focus 5: stemRemixerDir set but no Stem Remixer Python: fit and export say what to set, nothing starts", async () => {
  const s = await setup({ python: false });
  await joined(s);
  const before = s.jobs.list().length;
  await assert.rejects(startFit(s.ctx), { message: MSG_SET_STEM_REMIXER });
  const EXP = "C:\\sr\\export.wav";
  await s.host.fs.mkdir("C:\\sr");
  await s.host.fs.write(EXP, "x");
  await assert.rejects(useStemRemixerExport(s.ctx, EXP), { message: MSG_SET_STEM_REMIXER });
  await assert.rejects(openFitInStemRemixer(s.ctx, { open: async () => "Opened" }), { message: MSG_SET_STEM_REMIXER });
  assert.equal(s.jobs.list().length, before);
  assert.equal(s.plans(), 0);
});

test("Open in Stem Remixer passes --plan only on the first open after an app fit, so later opens keep Jon's tweaks", async () => {
  const s = await setup();
  await joined(s);
  await fitted(s);
  await s.host.fs.write(MIXD + "\\plan.json", "{}");
  const opens = [];
  const open = async (host, settings, args) => { opens.push(args); return "Opened in Stem Remixer"; };
  assert.equal(await openFitInStemRemixer(s.ctx, { open }), "Opened in Stem Remixer");
  assert.deepEqual(opens[0], { score: SCORE1, plan: MIXD + "\\plan.json", exportDir: MIXD + "\\stem-remixer" });
  assert.equal(st(s).fit.openedAt, s.host.now());
  await openFitInStemRemixer(s.ctx, { open });
  assert.equal(opens[1].plan, null, "the second open leaves Stem Remixer's own state alone");
  await fitted(s); // a new app fit: its plan goes in once more
  assert.equal(st(s).fit.openedAt, undefined);
  await openFitInStemRemixer(s.ctx, { open });
  assert.equal(opens[2].plan, MIXD + "\\plan.json");
  const EXP = MIXD + "\\stem-remixer\\export.wav";
  await s.host.fs.write(EXP, "x");
  await useStemRemixerExport(s.ctx, EXP);
  await openFitInStemRemixer(s.ctx, { open });
  assert.equal(opens[3].plan, null, "a Stem Remixer export is never overwritten by the app's plan");
});

test("a take saved after the join: fit, export, mix and approval wait for the join to be run again", async () => {
  const s = await setup();
  await joined(s);
  await fitted(s);
  await mixed(s);
  const later = { rows: [{ id: "01.1", status: "ok", takeS: (st(s).voiceover.startedAt + 1000) / 1000 }] };
  const ctx = { ...s.ctx, narration: later };
  assert.equal(REJOIN, "Waits for the voiceover join to be run again.");
  await assert.rejects(startFit(ctx), { message: REJOIN });
  await assert.rejects(startMix(ctx), { message: REJOIN });
  await assert.rejects(approveMix(ctx), { message: REJOIN });
  await assert.rejects(approveMix({ ...s.ctx, joinStale: true }), { message: REJOIN });
  const EXP = MIXD + "\\e.wav";
  await s.host.fs.write(EXP, "x");
  await assert.rejects(useStemRemixerExport(ctx, EXP), { message: REJOIN });
  const earlier = { rows: [{ id: "01.1", status: "ok", takeS: (st(s).voiceover.startedAt - 1000) / 1000 }] };
  await approveMix({ ...s.ctx, narration: earlier });
  assert.equal(st(s).mix.approved, true);
});

test("Use another file: Explorer's quotes and spaces are stripped; a path that isn't there says so", async () => {
  assert.equal(pastedPath('  "C:\\sr\\my export.wav"  '), "C:\\sr\\my export.wav");
  assert.equal(pastedPath("\tC:\\sr\\e.wav\n"), "C:\\sr\\e.wav");
  const s = await setup();
  await joined(s);
  await fitted(s);
  await assert.rejects(useStemRemixerExport(s.ctx, '"C:\\sr\\nothing.wav"', { pasted: true }), { message: "Couldn't find that file." });
  const EXP = "C:\\sr\\my export.wav";
  await s.host.fs.mkdir("C:\\sr");
  await s.host.fs.write(EXP, "x");
  await useStemRemixerExport(s.ctx, ` "${EXP}" `, { pasted: true });
  assert.equal(st(s).fit.file, EXP);
});

test("an export more than 1 s off the film's length asks first; confirmed, it is used without measuring again", async () => {
  const s = await setup({ exportS: 50.3 });
  await joined(s);
  await fitted(s);
  const EXP = MIXD + "\\long.wav";
  await s.host.fs.write(EXP, "x");
  const fitAt = st(s).fit.at;
  const r = await useStemRemixerExport(s.ctx, EXP);
  assert.deepEqual(r, { confirm: "This export is 1.8 s longer than the film. Use it anyway?" });
  assert.equal(st(s).fit.at, fitAt, "nothing is used until Jon confirms");
  assert.equal(st(s).fit.source, "app");
  const measures = s.calls.measure.length;
  await useStemRemixerExport(s.ctx, EXP, { confirmed: true });
  assert.equal(s.calls.measure.length, measures);
  assert.equal(st(s).fit.file, EXP);
  assert.equal(st(s).fit.source, "stemremixer");
  const t = await setup({ exportS: 46 });
  await joined(t);
  await fitted(t);
  await t.host.fs.write(EXP, "x");
  assert.deepEqual(await useStemRemixerExport(t.ctx, EXP), { confirm: "This export is 2.5 s shorter than the film. Use it anyway?" });
  const u = await setup({ exportS: 49.2 });
  await joined(u);
  await fitted(u);
  await u.host.fs.write(EXP, "x");
  assert.equal(typeof (await useStemRemixerExport(u.ctx, EXP)), "number", "within 1 s: used straight away");
});

test("parseCsv reads the timings, quoted fields too", () => {
  assert.deepEqual(parseCsv('a,b\n1,"x, ""y"""\n'), [{ a: "1", b: 'x, "y"' }]);
  assert.equal(parseCsv(CSV).length, 2);
});
