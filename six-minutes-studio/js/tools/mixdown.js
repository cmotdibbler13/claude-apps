// Mix preview (gpu lane): one ffmpeg run puts the voice over the fitted score and the placed sound effects.
// The music rides by section, fades in and out, and ducks under the voice; the sound effects duck with it.
import { moveAside } from "../paths.js";
import { tool } from "../toolpaths.js";
import { measure } from "../audio.js";
import { MSG_INTERRUPTED } from "./voicejoin.js";

export const SIDECHAIN = "sidechaincompress=threshold=0.03:ratio=6:attack=40:release=600";
export const LIMITER = "alimiter=limit=0.84:level=false:attack=2:release=50";
const HOLD_S = 0; // the title hold is in the voiceover itself: film time = voiceover time
const FADE_IN_S = 2.5;
const FADE_OUT_S = 5;
const LOOP_FADE_S = 1;
const MIX_MS = 30 * 60 * 1000;

// ---- levels ----
// The bed (music plus sound effects) sits at one steady level before the duck. The sidechain then pulls it
// down about 18 dB while he speaks (measured through mixGraph), so it is heard about 30 dB under the voice
// while he speaks and near the steady level in the gaps, without pumping between speech and pauses.
export const VOICE_RMS_DB = -13.8; // each joined clip's RMS
export const MUSIC_DB = -26;       // settings.mixMusicDb: the bed's music before the duck
export const SFX_DB = -18;         // settings.mixSfxDb: each sound effect's mean before the duck
const RIDE_MAX_DB = 9;
const RAMP_S = 3;
const MIN_PAUSE_S = 4;             // shorter gaps (between clips and sections) ride with their section
const STEP_S = 0.1;                // measure.py loudness steps
const SFX_GAIN_MAX_DB = 30;
const MP3_TRIM_DB = -0.5;          // the MP3 encode overshoots: about -1.5 dBFS peaks after it

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Film-time section spans from the voiceover timings (voiceover time).
function sections(timings) {
  const out = [];
  for (const r of timings ?? []) {
    const a = Number(r.start_s) + HOLD_S, b = Number(r.end_s) + HOLD_S;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const last = out[out.length - 1];
    if (last && last.key === String(r.section)) { last.end = Math.max(last.end, b); last.clips.push([a, b]); }
    else out.push({ key: String(r.section), start: a, end: b, clips: [[a, b]] });
  }
  return out;
}

// Pure. The music's gain: baseDb, plus a ride by section (dB offsets at film times, linear between).
// The base puts the score's median at musicDb; each section (and the cold open and end card) is then
// nudged towards musicDb by up to RIDE_MAX_DB, so only the score's own loudness changes are evened out.
// Ramps take RAMP_S and end where the next section starts.
export function musicRide(measureMusic, timings, { musicDb = MUSIC_DB } = {}) {
  const loud = measureMusic?.loud ?? [];
  const endS = Number(measureMusic?.duration_s) || loud.length * STEP_S;
  const framesIn = (a, b) => {
    const out = [];
    for (let i = Math.max(0, Math.ceil(a / STEP_S)); i * STEP_S < b && i < loud.length; i++) out.push(loud[i]);
    return out;
  };
  const all = median(framesIn(0, endS));
  if (all == null) return { baseDb: 0, ride: [{ t: 0, db: 0 }] };
  const baseDb = r1(musicDb - all);

  // Segments: pauses of MIN_PAUSE_S or more, and each section with the short gaps before it.
  const segs = [];
  let cursor = 0;
  for (const s of sections(timings)) {
    const prev = segs[segs.length - 1];
    let start = s.start;
    if (s.start - cursor >= MIN_PAUSE_S) segs.push({ start: cursor, end: s.start });
    else if (prev) prev.end = s.start;
    else start = 0;
    segs.push({ start, end: s.end });
    cursor = s.end;
  }
  if (endS - cursor >= MIN_PAUSE_S || !segs.length) segs.push({ start: cursor, end: endS });
  else segs[segs.length - 1].end = Math.max(segs[segs.length - 1].end, endS);
  for (const g of segs) {
    const level = median(framesIn(g.start, g.end));
    g.db = level == null ? 0 : r1(clamp(musicDb - level - baseDb, -RIDE_MAX_DB, RIDE_MAX_DB));
  }

  const ride = [{ t: 0, db: segs[0].db }];
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1].db, b = segs[i].db, B = segs[i].start;
    if (a === b) continue;
    const t0 = Math.max(ride[ride.length - 1].t, B - RAMP_S);
    const t1 = Math.max(t0, B);
    ride.push({ t: r3(t0), db: a }, { t: r3(t1), db: b });
  }
  return { baseDb, ride };
}

// Pure. Gain for a sound effect so its mean sits at sfxDb in the bed (it ducks with the music).
export function sfxGainDb(meanDb, { sfxDb = SFX_DB } = {}) {
  if (meanDb == null || !Number.isFinite(meanDb)) return 0;
  return r1(clamp(sfxDb - meanDb, -SFX_GAIN_MAX_DB, SFX_GAIN_MAX_DB));
}

const n = (x) => { const v = r3(x); return v < 0 ? `(${v})` : String(v); };

// Pure. An ffmpeg expression in t for the music's linear gain: baseDb plus the ride, linear in dB between points.
export function rideExpr(baseDb, ride) {
  const pts = (ride ?? []).filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.db));
  if (!pts.length) pts.push({ t: 0, db: 0 });
  let expr = n(pts[pts.length - 1].db);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1];
    if (b.t <= a.t) continue;
    const seg = a.db === b.db ? n(a.db) : `${n(a.db)}+${n(b.db - a.db)}*(t-${n(a.t)})/${n(b.t - a.t)}`;
    expr = `if(lt(t,${n(b.t)}),${seg},${expr})`;
  }
  return `pow(10,(${n(baseDb)}+${expr})/20)`;
}

export function mixOutputs(out) {
  const base = String(out).replace(/_mix\.wav$/i, "").replace(/\.wav$/i, "");
  return { wav: base + "_mix.wav", mp3: base + "_mix_preview.mp3", voice: base + "_voice_stem.flac", music: base + "_music_stem.flac" };
}
export const partOf = (p) => String(p).replace(/(\.[^.\\/]+)$/, ".part$1");

const MONO = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono";
// Mono goes to both sides at full level (aformat alone would put it 3 dB down on each side).
const STEREO = "aresample=48000,pan=stereo|FL=FL+FC|FR=FR+FC,aformat=sample_fmts=fltp:channel_layouts=stereo";

// Pure. The whole ffmpeg argument list. sfx: [{id, file, startS, loop, endS, gainDb}]; ones with no startS
// are left out and listed in unplaced. outs: {wav, mp3, voice, music} (the paths ffmpeg writes).
export function mixGraph({ voice, music, sfx = [], filmS, ride = { baseDb: 0, ride: [] }, outs }) {
  const F = n(filmS);
  const placed = [], unplaced = [];
  for (const s of sfx) {
    if (s.startS == null || !Number.isFinite(Number(s.startS)) || Number(s.startS) >= filmS) unplaced.push(s.id ?? s.file);
    else placed.push(s);
  }
  const args = ["-hide_banner", "-nostdin", "-y", "-i", voice, "-i", music];
  for (const s of placed) { if (s.loop) args.push("-stream_loop", "-1"); args.push("-i", s.file); }

  const g = [];
  g.push(`[0:a]${MONO},apad=whole_dur=${F},atrim=0:${F},asplit=3[vstem][vk][vm]`);
  g.push("[vk]pan=stereo|FL=FC|FR=FC[vkey]");
  g.push("[vm]pan=stereo|FL=FC|FR=FC[vmix]");
  g.push(`[1:a]${STEREO},apad=whole_dur=${F},atrim=0:${F},volume='${rideExpr(ride.baseDb ?? 0, ride.ride)}':eval=frame,`
    + `afade=t=in:st=0:d=${FADE_IN_S},afade=t=out:st=${n(Math.max(0, filmS - FADE_OUT_S))}:d=${FADE_OUT_S}[mus]`);
  const beds = ["[mus]"];
  placed.forEach((s, i) => {
    const start = Number(s.startS);
    const ms = Math.round(start * 1000);
    const parts = [`[${i + 2}:a]${STEREO}`];
    if (s.loop) {
      const dur = Math.max(0.1, Math.min(Number(s.endS ?? filmS), filmS) - start);
      parts.push(`atrim=0:${n(dur)}`, "asetpts=N/SR/TB");
      if (dur > 2 * LOOP_FADE_S) parts.push(`afade=t=out:st=${n(dur - LOOP_FADE_S)}:d=${LOOP_FADE_S}`);
    }
    parts.push(`volume=${r1(Number(s.gainDb) || 0)}dB`, `adelay=${ms}|${ms}`);
    g.push(`${parts.join(",")}[s${i}]`);
    beds.push(`[s${i}]`);
  });
  if (beds.length > 1) g.push(`${beds.join("")}amix=inputs=${beds.length}:duration=first:dropout_transition=0:normalize=0[bed]`);
  else g.push("[mus]anull[bed]");
  g.push(`[bed][vkey]${SIDECHAIN}[duck]`);
  g.push("[duck]asplit=2[mstem][mm]");
  g.push(`[vmix][mm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${LIMITER},atrim=0:${F},asplit=2[mixwav][mx]`);
  g.push(`[mx]volume=${MP3_TRIM_DB}dB[mixmp3]`);
  const filter = g.join(";");

  args.push("-filter_complex", filter,
    "-map", "[mixwav]", "-c:a", "pcm_s16le", "-ar", "48000", outs.wav,
    "-map", "[mixmp3]", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "48000", outs.mp3,
    "-map", "[vstem]", "-c:a", "flac", "-ar", "48000", outs.voice,
    "-map", "[mstem]", "-c:a", "flac", "-ar", "48000", outs.music);
  return { args, filter, unplaced, placed: placed.map((s) => s.id ?? s.file) };
}

const TIME = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/;

function runFfmpeg(host, args, filmS, onProgress) {
  return new Promise((resolve, reject) => {
    const tail = [];
    let partial = "", settled = false;
    const done = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const feed = (c) => {
      const lines = (partial + String(c)).split(/\r?\n|\r/);
      partial = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = TIME.exec(l);
        if (m && filmS > 0) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / filmS));
        else { tail.push(l.trim()); if (tail.length > 5) tail.shift(); }
      }
    };
    const p = host.spawn(tool("ffmpeg"), args);
    const timer = setTimeout(() => done(() => {
      try { Promise.resolve(p.kill()).catch(() => {}); } catch { /* gone */ }
      reject(new Error("The mix timed out."));
    }), MIX_MS);
    p.onOut(() => {});
    p.onErr(feed);
    p.onExit((code) => done(() => {
      if (partial) feed("\n");
      if (code === null || code === undefined) return reject(new Error(`ffmpeg didn't start or was stopped${tail.length ? `:\n${tail.join("\n")}` : ""}`));
      if (code !== 0) return reject(new Error(`The mix failed (ffmpeg exit ${code}):\n${tail.join("\n")}`));
      resolve();
    }));
  });
}

const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");

export function makeMixdownRunner() {
  return {
    lane: "gpu",
    async start(job, ctx) {
      const { host } = ctx;
      const { voice, music, sfx = [], filmS, out, ride, sfxDb = SFX_DB } = job.input ?? {};
      if (typeof voice !== "string" || !voice) throw new Error("This mix has no voiceover.");
      if (typeof music !== "string" || !music) throw new Error("This mix has no fitted score.");
      if (!(Number(filmS) > 0)) throw new Error("This mix has no film length.");
      if (typeof out !== "string" || !/\.wav$/i.test(out)) throw new Error("This mix has no .wav output path; not mixing.");
      const outs = mixOutputs(out);
      const withGain = [];
      for (const s of sfx) {
        let meanDb = s.meanDb;
        if (s.startS != null && (meanDb == null || !Number.isFinite(meanDb))) meanDb = (await measure(host, s.file)).meanDb;
        withGain.push({ ...s, gainDb: sfxGainDb(meanDb, { sfxDb }) });
      }
      const parts = { wav: partOf(outs.wav), mp3: partOf(outs.mp3), voice: partOf(outs.voice), music: partOf(outs.music) };
      const { args, unplaced } = mixGraph({ voice, music, sfx: withGain, filmS: Number(filmS), ride, outs: parts });
      await host.fs.mkdir(parentOf(out));
      const discard = async () => {
        for (const p of Object.values(parts)) { try { if (await host.fs.exists(p)) await host.fs.trash(p); } catch { /* best effort */ } }
      };
      await discard(); // a part file left by an earlier stopped mix is ours and incomplete
      try { await runFfmpeg(host, args, Number(filmS), (p) => ctx.progress(p)); } catch (e) { await discard(); throw e; }
      for (const p of Object.values(parts)) {
        if (!(await host.fs.exists(p))) { await discard(); throw new Error("ffmpeg finished but a mix file was not created."); }
      }
      for (const k of Object.keys(outs)) await moveAside(host, outs[k]);
      for (const k of Object.keys(outs)) await host.fs.rename(parts[k], outs[k]);
      return {
        file: outs.wav,
        meta: { files: outs, unplaced, lengthS: Number(filmS), sfx: withGain.filter((s) => !unplaced.includes(s.id ?? s.file)).map((s) => ({ id: s.id, gainDb: s.gainDb })) },
      };
    },
    async resume() { throw new Error(MSG_INTERRUPTED); },
  };
}

