import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { makeJobs } from "../js/jobs.js";
import { watchJobs, holders } from "../js/redo.js";
import { startJoin, startFit, startMix, useStemRemixerExport, approveMix, fitStale, mixStale, OUT_OF_DATE, parseCsv } from "../js/mixplan.js";
import { MSG_NO_STEM_REMIXER } from "../js/tools/stemfit.js";

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

async function setup({ settings = {}, audio, csv = CSV } = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  await host.fs.mkdir(MEDIA);
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
      return { file: wav, meta: { wav, csv, transcript: VO + "\\t.json", lengthS: 30.5, tightened: [{ id: "01.1", at_s: 1, from_s: 0.9, to_s: 0.3 }], extra: [], silent: [] } };
    } },
    stemfit: { lane: "gpu", async start(job) {
      const i = job.input;
      if (i.measureOnly) {
        calls.measure.push(i);
        const f = i.measureOut ?? i.score + ".measure.json";
        await host.fs.write(f, JSON.stringify(MEASURE));
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
  assert.equal(v.at, s.host.now());
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
  assert.deepEqual(i.sfx.map((x) => [x.id, x.file, x.startS, x.loop, x.meanDb, x.speaking]), [["SFX-01", SFX1, 8, false, -25, true], ["SFX-02", SFX1, null, false, -25, false]]);
  assert.ok(Number.isFinite(i.ride.baseDb) && i.ride.ride.length >= 1);
  const m = st(s).mix;
  assert.equal(m.files.mp3, MIXD + "\\Film_A_mix_preview.mp3");
  assert.deepEqual(m.unplaced, ["SFX-02"]);
  assert.equal(m.fromFitAt, st(s).fit.at);
  assert.equal(s.jobs.list().find((j) => j.assetId === "MIX").what, "Mix preview");
  await approveMix(s.ctx);
  assert.equal(st(s).mix.approved, true);
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

test("parseCsv reads the timings, quoted fields too", () => {
  assert.deepEqual(parseCsv('a,b\n1,"x, ""y"""\n'), [{ a: "1", b: 'x, "y"' }]);
  assert.equal(parseCsv(CSV).length, 2);
});
