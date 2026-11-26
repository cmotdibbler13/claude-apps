// Voiceover and mix: join the voiceover, fit the score, make the mix preview, approve it.
// state.mix holds one holder per step (VOICEOVER, FIT, MIX). Each has a one-element takes list for its
// current run, so redo.watchJobs mirrors its job like any take. A later step made from an earlier step's
// older output is out of date until it is run again.
import { join } from "./paths.js";
import { projectOf } from "./audio.js";
import { filmTargets, planFit, fitSheet } from "./fitplan.js";
import { NO_LINE_SCRIPT } from "./narration.js";
import { MSG_NO_STEM_REMIXER, measureFileFor } from "./tools/stemfit.js";
import { musicRide, speakingSpans, VOICE_RMS_DB } from "./tools/mixdown.js";

export const OUT_OF_DATE = "Out of date: run again";
const SLOTS = { VOICEOVER: "voiceover", FIT: "fit", MIX: "mix" };
const LABEL = { VOICEOVER: "Voiceover join", FIT: "Score fit", MIX: "Mix preview" };
const TOOL = { VOICEOVER: "voicejoin", FIT: "stemfit", MIX: "mixdown" };
export const MIX_IDS = new Set(Object.keys(SLOTS));
export const runLabel = (id) => LABEL[id];

const filled = (v) => typeof v === "string" && v.trim() !== "";
const live = (s) => s === "queued" || s === "running";

export const mixHolders = (d) => (d?.mix ? Object.values(SLOTS).map((k) => d.mix[k]).filter((h) => h && Array.isArray(h.takes)) : []);

// Called by redo.applyJobs when a VOICEOVER, FIT or MIX job is done: copy its results onto the holder.
export function mixJobDone(h, j) {
  const m = j.meta ?? {};
  const copy = (keys) => { for (const k of keys) if (m[k] !== undefined) h[k] = m[k]; };
  h.at = j.endedAt ?? null;
  if (h.id === "VOICEOVER") copy(["wav", "csv", "transcript", "lengthS", "tightened", "extra", "silent"]);
  else if (h.id === "FIT") { if (j.file) h.file = j.file; copy(["lengthS", "measureFile", "turnedDown"]); }
  else if (h.id === "MIX") { copy(["files", "unplaced", "lengthS", "sfx"]); h.approved = false; }
}

// The holder's status, jobId and error follow its run's take. Returns whether anything changed.
export function syncMixHolder(h) {
  const t = h.takes?.[0];
  if (!t) return false;
  let changed = false;
  for (const k of ["status", "jobId", "error"]) {
    if (h[k] === t[k]) continue;
    if (t[k] === undefined) { if (k in h) { delete h[k]; changed = true; } } else { h[k] = t[k]; changed = true; }
  }
  return changed;
}

// ---- out of date (Review Focus 3) ----
export function fitStale(state) {
  const f = state?.mix?.fit;
  if (!f || f.status !== "done") return false;
  const vo = state.mix.voiceover;
  if (!vo || vo.status !== "done" || vo.at == null || f.fromVoiceoverAt !== vo.at) return true;
  const sc = state.audio?.score;
  return !sc?.approved || sc.chosen !== f.fromScoreTake;
}

export function mixStale(state) {
  const x = state?.mix?.mix;
  if (!x || x.status !== "done") return false;
  if (fitStale(state)) return true;
  const { fit: f, voiceover: vo } = state.mix;
  return !f || f.status !== "done" || x.fromFitAt !== f.at || !vo || vo.status !== "done" || x.fromVoiceoverAt !== vo.at;
}

// ---- helpers ----
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  const [head, ...body] = rows;
  return (body ?? []).map((r) => Object.fromEntries((head ?? []).map((h, i) => [h.trim(), r[i] ?? ""])));
}

async function readTimings(host, csv) {
  let text;
  try { text = await host.fs.read(csv, "utf8"); } catch { throw new Error("The voiceover timings are missing. Join the voiceover again."); }
  return parseCsv(text);
}

// Resolves with the job once it is done; rejects with its error if it fails or is interrupted.
export function waitJob(jobs, id) {
  return new Promise((resolve, reject) => {
    let off = null, settled = false;
    const check = (list) => {
      if (settled) return;
      const j = list.find((x) => x.id === id);
      if (!j) return;
      if (j.status === "done") { settled = true; off?.(); resolve(j); }
      else if (j.status === "failed" || j.status === "interrupted") { settled = true; off?.(); reject(new Error(j.error ?? "It stopped.")); }
    };
    off = jobs.onChange(check);
    check(jobs.list());
  });
}

const goodMeasure = (m) => m && typeof m === "object" && Array.isArray(m.loud) && Number(m.duration_s) > 0;
let measureN = 0;

// A measure.py result for this audio: the cached one, or a fresh measure job (gpu lane) awaited here.
async function measured(ctx, audio, { cacheFile, force = false, why } = {}) {
  const { host, store, jobs } = ctx;
  const cache = cacheFile ?? measureFileFor(audio);
  if (!force) {
    try { const m = JSON.parse(await host.fs.read(cache, "utf8")); if (goodMeasure(m)) return m; } catch { /* not cached yet */ }
  }
  const id = jobs.add({
    film: store.dir, assetId: "MEASURE", take: host.now() * 1000 + (++measureN % 1000), tool: "stemfit",
    what: "Score measure", why: why ?? "Before the fit",
    input: { score: audio, measureOnly: true, ...(cacheFile ? { measureOut: cacheFile } : {}) },
  });
  const job = await waitJob(jobs, id);
  const m = JSON.parse(await host.fs.read(job.meta?.measureFile ?? cache, "utf8"));
  if (!goodMeasure(m)) throw new Error("The measure came back empty.");
  return m;
}

function approvedScore(state) {
  const sc = state.audio?.score;
  if (!sc?.approved) return null;
  const t = (sc.takes ?? []).find((x) => x.n === sc.chosen && x.status === "done" && x.file);
  return t ? { n: sc.chosen, file: t.file } : null;
}

const starting = (store, id) => [...(store.pending ?? [])].some((k) => k.startsWith(`${id}#`));
const busy = (store, id) => live(store.state.mix?.[SLOTS[id]]?.takes?.[0]?.status) || starting(store, id);
const ensure = (d) => { d.mix ??= { voiceover: null, fit: null, mix: null }; return d.mix; };
const runOf = (h) => h?.takes?.[0]?.n ?? 0;
const mixDir = (store) => join(store.dir, "studio", "mix");

// Start one run: the holder (fields plus a one-element takes list) is written, then the job is added.
async function startRun(ctx, id, fields, { why, input }) {
  const { host, store, jobs } = ctx;
  const slot = SLOTS[id];
  const n = runOf(store.state.mix?.[slot]) + 1;
  const key = `${id}#${n}`;
  store.pending?.add(key);
  let jobId;
  try {
    await store.update((d) => {
      const m = ensure(d);
      if (runOf(m[slot]) !== n - 1) throw new Error(`The ${LABEL[id].toLowerCase()} changed while it was being prepared.`);
      m[slot] = { id, ...fields, status: "queued", jobId: null, takes: [{ n, status: "queued", at: host.now() }] };
    });
    try {
      jobId = jobs.add({ film: store.dir, assetId: id, take: n, tool: TOOL[id], what: LABEL[id], why: why ?? `Run ${n}`, input });
    } catch (e) {
      const msg = String(e?.message ?? e);
      await store.update((d) => {
        const h = d.mix?.[slot];
        if (runOf(h) === n) { h.takes[0].status = "failed"; h.takes[0].error = msg; h.status = "failed"; h.error = msg; }
      });
      await store.log(`${LABEL[id]} run ${n} failed: ${msg}`);
      throw e;
    }
  } finally {
    store.pending?.delete(key);
  }
  await store.update((d) => {
    const h = d.mix?.[slot];
    if (runOf(h) !== n) return;
    if (!h.takes[0].jobId) h.takes[0].jobId = jobId;
    if (!h.jobId) h.jobId = jobId;
  });
  await store.log(`${LABEL[id]} run ${n} started${filled(fields.note) ? `: ${fields.note}` : ""}`);
  return n;
}

// Hold a step while its async preparation runs (measure, Claude), so a second press cannot start another.
async function preparing(store, id, fn) {
  if (busy(store, id)) throw new Error(`The ${LABEL[id].toLowerCase()} is already running.`);
  const key = `${id}#preparing`;
  store.pending?.add(key);
  try { return await fn(); } finally { store.pending?.delete(key); }
}

// ---- actions ----
export async function startJoin(ctx, { allowFlagged = false } = {}) {
  const { store, settings = {} } = ctx;
  const ls = ctx.lineScript;
  if (!ls?.path || !ls?.name) throw new Error(NO_LINE_SCRIPT);
  if (!settings.autocueRecordings) throw new Error("Set where Autocue Studio's recordings are (autocueRecordings in .studio-settings.json).");
  if (busy(store, "VOICEOVER")) throw new Error("The voiceover join is already running.");
  const input = { script: ls.path, takes: join(settings.autocueRecordings, ls.name), out: join(store.dir, "studio", "voiceover"), allowFlagged: !!allowFlagged };
  return startRun(ctx, "VOICEOVER", {
    allowFlagged: !!allowFlagged, wav: null, csv: null, transcript: null, lengthS: null, tightened: [], extra: [], silent: [], at: null,
  }, { why: allowFlagged ? "Flagged lines allowed" : undefined, input });
}

function needVoiceover(state) {
  const vo = state.mix?.voiceover;
  if (!vo || vo.status !== "done" || !vo.csv || !vo.wav) throw new Error("Join the voiceover first.");
  return vo;
}
function needScore(state) {
  const sc = approvedScore(state);
  if (!sc) throw new Error("Approve a score take first.");
  return sc;
}

export async function startFit(ctx, { note } = {}) {
  const { host, store, settings = {} } = ctx;
  if (!settings.stemRemixerDir) throw new Error(MSG_NO_STEM_REMIXER);
  const vo = needVoiceover(store.state);
  const sc = needScore(store.state);
  return preparing(store, "FIT", async () => {
    const targets = filmTargets(await readTimings(host, vo.csv), settings.endCardS ?? 12);
    const measure = await measured(ctx, sc.file);
    const prev = store.state.mix?.fit;
    const hasNote = filled(note);
    const previous = hasNote && prev?.source === "app" && prev?.plan?.steps && prev.fromScoreTake === sc.n ? prev.plan.steps : null;
    const plan = await planFit(host, { measure, targets, note: hasNote ? note : "", previous });
    const sheet = fitSheet(plan.steps, measure, targets);
    const out = join(mixDir(store), `${projectOf(store.dir)}_score_fitted.wav`);
    return startRun(ctx, "FIT", {
      plan, sheet, targets, note: hasNote ? note : null, source: "app", file: null, measureFile: null, lengthS: null,
      scoreFile: sc.file, fromVoiceoverAt: vo.at, fromScoreTake: sc.n, at: null,
    }, { why: hasNote ? `From your note "${note}"` : undefined, input: { score: sc.file, plan: { steps: plan.steps }, out } });
  });
}

// Jon fixed the fit by ear in Stem Remixer and exported it: measure the export (its moves are in film time),
// rebuild the sheet, and use it as the fitted score.
export async function useStemRemixerExport(ctx, file) {
  const { host, store, settings = {} } = ctx;
  if (!settings.stemRemixerDir) throw new Error(MSG_NO_STEM_REMIXER);
  if (!filled(file) || !(await host.fs.exists(file))) throw new Error("That export isn't there any more. Export it again in Stem Remixer.");
  const vo = needVoiceover(store.state);
  const sc = needScore(store.state);
  return preparing(store, "FIT", async () => {
    const targets = filmTargets(await readTimings(host, vo.csv), settings.endCardS ?? 12);
    const cacheFile = join(mixDir(store), `${projectOf(store.dir)}_score_export.measure.json`);
    await host.fs.mkdir(mixDir(store));
    const measure = await measured(ctx, file, { cacheFile, force: true, why: "Stem Remixer export" });
    const sheet = fitSheet([{ from_s: 0, to_s: Number(measure.duration_s), tempo: 1, xfade_s: 0 }], measure, targets);
    const prev = store.state.mix?.fit;
    const n = runOf(prev) + 1;
    const now = host.now();
    await store.update((d) => {
      const m = ensure(d);
      if (runOf(m.fit) !== n - 1) throw new Error("The score fit changed while the export was being measured.");
      m.fit = {
        id: "FIT", plan: m.fit?.plan ?? null, sheet, targets, note: null, source: "stemremixer", file, measureFile: cacheFile,
        lengthS: Number(measure.duration_s), scoreFile: sc.file, fromVoiceoverAt: vo.at, fromScoreTake: sc.n, at: now,
        status: "done", takes: [{ n, status: "done", file, at: now }],
      };
    });
    await store.log(`Score fit run ${n}: using the Stem Remixer export`);
    return n;
  });
}

function loopEnd(startS, targets) {
  const next = targets.sections.map((s) => s.startS).filter((t) => t > startS).sort((a, b) => a - b)[0];
  return next ?? targets.filmS;
}

export async function startMix(ctx) {
  const { host, store, settings = {} } = ctx;
  const state = store.state;
  const vo = needVoiceover(state);
  const fit = state.mix?.fit;
  if (!fit || fit.status !== "done" || !fit.file) throw new Error("Fit the score first.");
  if (fitStale(state)) throw new Error("The score fit is out of date. Fit it again first.");
  return preparing(store, "MIX", async () => {
    const rows = await readTimings(host, vo.csv);
    const targets = filmTargets(rows, settings.endCardS ?? 12);
    const music = await measured(ctx, fit.file, { cacheFile: fit.measureFile ?? undefined, why: "Before the mix" });
    const ride = musicRide(music, VOICE_RMS_DB, rows);
    const spans = speakingSpans(rows);
    const sfx = [];
    for (const x of state.audio?.sfx ?? []) {
      if (!x.approved) continue;
      const t = (x.takes ?? []).find((y) => y.n === x.chosen && y.status === "done" && y.file);
      if (!t) continue;
      const startS = x.startS == null ? null : Number(x.startS);
      const item = { id: x.id, file: t.file, startS, loop: !!x.loop, meanDb: t.meanDb ?? null, speaking: startS != null && spans.some(([a, b]) => startS >= a && startS < b) };
      if (x.loop && startS != null) item.endS = loopEnd(startS, targets);
      sfx.push(item);
    }
    const out = join(mixDir(store), `${projectOf(store.dir)}_mix.wav`);
    return startRun(ctx, "MIX", {
      files: null, unplaced: [], approved: false, fromFitAt: fit.at, fromVoiceoverAt: vo.at, at: null,
    }, { input: { voice: vo.wav, music: fit.file, sfx, filmS: targets.filmS, out, ride } });
  });
}

export async function approveMix(ctx) {
  const { host, store } = ctx;
  const state = store.state;
  const m = state.mix?.mix;
  if (!m || m.status !== "done") throw new Error("There is no finished mix to approve.");
  if (mixStale(state)) throw new Error("The mix is out of date. Make it again first.");
  const now = host.now();
  await store.update((d) => {
    const { voiceover: vo, fit, mix } = d.mix;
    mix.approved = true;
    mix.approvedAt = now;
    mix.approvedWith = { voiceover: vo.wav, voiceoverAt: vo.at, fit: fit.file, fitSource: fit.source, scoreTake: fit.fromScoreTake, files: mix.files };
  });
  await store.log("Mix approved");
}
