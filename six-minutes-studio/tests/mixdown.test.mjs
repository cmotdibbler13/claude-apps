import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { mixGraph, musicRide, rideExpr, sfxGainDb, mixOutputs, makeMixdownRunner, SIDECHAIN, DUCK_DB } from "../js/tools/mixdown.js";

const MIX = "S:\\Film A\\studio\\mix";
const outs = mixOutputs(MIX + "\\film_a_mix.wav");
const base = { voice: "v.wav", music: "m.wav", filmS: 300, ride: { baseDb: -3, ride: [{ t: 0, db: -5 }, { t: 3, db: -5 }, { t: 6, db: 0 }] }, outs };
const count = (s, sub) => s.split(sub).length - 1;

test("mixOutputs names the four files", () => {
  assert.deepEqual(outs, {
    wav: MIX + "\\film_a_mix.wav", mp3: MIX + "\\film_a_mix_preview.mp3",
    voice: MIX + "\\film_a_voice_stem.flac", music: MIX + "\\film_a_music_stem.flac",
  });
});

test("mixGraph: the sidechain string verbatim, the voice held 6 s, fades, one adelay per SFX", () => {
  const sfx = [
    { id: "SFX-01", file: "a.wav", startS: 12.5, loop: false, gainDb: 4 },
    { id: "SFX-02", file: "b.wav", startS: 40, loop: true, endS: 95, gainDb: -2 },
    { id: "SFX-03", file: "c.wav", startS: null, loop: false },
  ];
  const { args, filter, unplaced } = mixGraph({ ...base, sfx });
  assert.equal(SIDECHAIN, "sidechaincompress=threshold=0.03:ratio=6:attack=40:release=600");
  assert.ok(filter.includes("sidechaincompress=threshold=0.03:ratio=6:attack=40:release=600"));
  assert.match(filter, /\[bed\]\[vkey\]sidechaincompress/);
  assert.match(filter, /\[0:a\][^;]*adelay=6000\|6000/);
  assert.ok(filter.includes("afade=t=in:st=0:d=2.5"));
  assert.ok(filter.includes("afade=t=out:st=295:d=5"), "the fade-out ends at filmS");
  assert.equal(count(filter, "adelay="), 3, "the voice and two placed SFX");
  assert.ok(filter.includes("adelay=12500|12500"));
  assert.ok(filter.includes("adelay=40000|40000"));
  assert.ok(filter.includes("volume=4dB") && filter.includes("volume=(-2)dB"));
  assert.match(filter, /\[3:a\][^;]*atrim=0:55,asetpts/, "the loop runs to its end time");
  assert.ok(filter.includes("amix=inputs=3:"), "music and two SFX mix into the bed before the sidechain");
  assert.match(filter, /alimiter=limit=0\.84[^;]*,atrim=0:300,/);
  assert.deepEqual(unplaced, ["SFX-03"]);
  // inputs: voice, music, a.wav, then the loop with -stream_loop -1
  const i = args.indexOf("b.wav");
  assert.deepEqual(args.slice(i - 3, i + 1), ["-stream_loop", "-1", "-i", "b.wav"]);
  assert.equal(args.filter((a) => a === "-i").length, 4);
  assert.ok(!args.includes("c.wav"));
  for (const f of Object.values(outs)) assert.ok(args.includes(f));
  assert.deepEqual(args.slice(args.indexOf(outs.mp3) - 6, args.indexOf(outs.mp3)), ["-c:a", "libmp3lame", "-b:a", "192k", "-ar", "48000"]);
});

test("mixGraph with no SFX still has a bed", () => {
  const { filter } = mixGraph(base);
  assert.ok(filter.includes("[mus]anull[bed]"));
  assert.equal(count(filter, "adelay="), 1);
});

test("rideExpr is piecewise linear in dB", () => {
  const e = rideExpr(-3, [{ t: 0, db: -5 }, { t: 3, db: -5 }, { t: 6, db: 0 }]);
  assert.equal(e, "pow(10,((-3)+if(lt(t,3),(-5),if(lt(t,6),(-5)+5*(t-3)/3,0)))/20)");
  // evaluate it as ffmpeg would
  const js = (t) => Function("t", `const lt=(a,b)=>a<b?1:0; const pow=Math.pow; const _if=(c,a,b)=>c?a:b; return ${e.replace(/if\(/g, "_if(")};`)(t);
  const db = (t) => 20 * Math.log10(js(t));
  assert.ok(Math.abs(db(1) + 8) < 1e-9);
  assert.ok(Math.abs(db(4.5) + 5.5) < 1e-9);
  assert.ok(Math.abs(db(10) + 3) < 1e-9);
});

// Synthetic: 0.1 s loudness. Sections A (voiceover 0..30) and B (31.2..60); film adds 6 s and an end card.
const timings = [
  { clip: "01", section: "A", start_s: 0, end_s: 14 }, { clip: "02", section: "A", start_s: 14.6, end_s: 30 },
  { clip: "03", section: "B", start_s: 31.2, end_s: 60 },
];
function loudness(fn, seconds = 78.5) { return { duration_s: seconds, loud: Array.from({ length: Math.round(seconds * 10) }, (_, i) => fn(i / 10)) }; }
const gainAt = (ride, t) => {
  const p = ride.ride;
  if (t <= p[0].t) return p[0].db;
  for (let i = 1; i < p.length; i++) if (t <= p[i].t) return p[i - 1].db + (p[i].db - p[i - 1].db) * (t - p[i - 1].t) / ((p[i].t - p[i - 1].t) || 1);
  return p[p.length - 1].db;
};

test("musicRide holds the music 24 dB under the voice while he speaks and near -30 in the pauses", () => {
  // Section A's music is 4 dB louder than B's; the pauses are a little quieter.
  const m = loudness((t) => (t >= 6 && t < 36 ? -16 : t >= 36 && t < 66 ? -20 : -24));
  const r = musicRide(m, -13.8, timings);
  for (const p of r.ride) assert.ok(Math.abs(p.db) <= 9, `ride within 9 dB: ${p.db}`);
  const heard = (t) => m.loud[Math.round(t * 10)] + r.baseDb + gainAt(r, t);
  // after the sidechain's duck, the music sits 24 dB under the -13.8 voice
  for (const t of [10, 25, 40, 60]) assert.ok(Math.abs(heard(t) - DUCK_DB - (-13.8 - 24)) < 0.15, `speaking at ${t}: ${heard(t) - DUCK_DB}`);
  // pauses: the cold open and the end card, no duck, as near -30 as the 9 dB ride allows
  const want = (t) => Math.max(-30, m.loud[Math.round(t * 10)] + r.baseDb - 9);
  for (const t of [1, 70, 76]) assert.ok(Math.abs(heard(t) - want(t)) < 0.15, `pause at ${t}`);
  assert.equal(r.ride[0].t, 0);
  // ramps take 3 s, and end as he starts speaking
  const into = r.ride.findIndex((p, i) => i > 0 && p.t === 6);
  assert.ok(into > 0 && r.ride[into - 1].t === 3);
});

test("musicRide clamps a very quiet section to +9 dB", () => {
  const m = loudness((t) => (t >= 36 && t < 66 ? -50 : -18));
  const r = musicRide(m, -13.8, timings);
  const max = Math.max(...r.ride.map((p) => p.db)), min = Math.min(...r.ride.map((p) => p.db));
  assert.equal(max, 9);
  assert.ok(min >= -9);
});

test("sfxGainDb puts the mean near -21 dBFS, made up for the duck while he speaks", () => {
  assert.equal(sfxGainDb(-30, false), 9);
  assert.equal(sfxGainDb(-30, true), 9 + DUCK_DB);
  assert.equal(sfxGainDb(null, true), 0);
  assert.equal(sfxGainDb(-90, false), 30);
});

async function runnerSetup({ ffmpegCode = 0, writeParts = true } = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(MIX);
  const spawns = [], progress = [];
  host.spawnScript((cmd, args, opts, p) => {
    spawns.push({ cmd, args });
    if (args.includes("volumedetect")) { p.err("mean_volume: -27.0 dB\nmax_volume: -6.0 dB\n"); return p.exit(0); }
    const files = args.filter((a) => /\.part\.(wav|mp3|flac)$/.test(a));
    p.err("size=1kB time=00:02:30.00 bitrate=1\r");
    const finish = () => { p.err("Error at the end\n"); p.exit(ffmpegCode); };
    if (writeParts) Promise.all(files.map((f) => host.fs.write(f, "new"))).then(finish); else finish();
  });
  const ctx = { host, progress: (v) => progress.push(v) };
  return { host, spawns, progress, ctx, runner: makeMixdownRunner() };
}
const job = { input: { voice: "S:\\v.wav", music: "S:\\m.wav", filmS: 300, out: MIX + "\\film_a_mix.wav",
  ride: { baseDb: 0, ride: [{ t: 0, db: 0 }] },
  sfx: [{ id: "SFX-01", file: "S:\\a.wav", startS: 20, loop: false, speaking: false }, { id: "SFX-02", file: "S:\\b.wav", startS: null }] } };

test("mixdown measures SFX, runs one ffmpeg, renames the .part files and moves earlier outputs aside", async () => {
  const s = await runnerSetup();
  await s.host.fs.write(outs.wav, "old");
  const r = await s.runner.start(job, s.ctx);
  const ff = s.spawns.filter((x) => !x.args.includes("volumedetect"));
  assert.equal(ff.length, 1);
  assert.equal(s.spawns.filter((x) => x.args.includes("volumedetect")).length, 1, "only the placed SFX is measured");
  assert.ok(ff[0].args[ff[0].args.indexOf("-filter_complex") + 1].includes("volume=6dB"), "-27 dB mean lifted to -21");
  assert.deepEqual(r.meta.files, outs);
  assert.deepEqual(r.meta.unplaced, ["SFX-02"]);
  assert.equal(r.file, outs.wav);
  for (const f of Object.values(outs)) assert.equal(await s.host.fs.read(f, "utf8"), "new");
  const names = (await s.host.fs.list(MIX)).map((e) => e.name);
  assert.ok(names.some((n) => /^film_a_mix\.old-\d{8}-\d{6}\.wav$/.test(n)));
  assert.ok(!names.some((n) => n.includes(".part.")));
  assert.deepEqual(s.progress, [0.5]);
});

test("a failed ffmpeg leaves no part files and the earlier mix in place", async () => {
  const s = await runnerSetup({ ffmpegCode: 1 });
  await s.host.fs.write(outs.wav, "old");
  await assert.rejects(s.runner.start(job, s.ctx), /The mix failed \(ffmpeg exit 1\):\n.*Error at the end/s);
  const names = (await s.host.fs.list(MIX)).map((e) => e.name);
  assert.deepEqual(names, ["film_a_mix.wav"]);
  assert.equal(await s.host.fs.read(outs.wav, "utf8"), "old");
});

test("resume asks for a fresh run", async () => {
  await assert.rejects(makeMixdownRunner().resume(), { message: "Interrupted; run it again." });
});
