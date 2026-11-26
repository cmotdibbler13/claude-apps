// Voiceover and mix: join the voiceover, fit the score, make the mix preview, approve it.
// state.mix holds one holder per step (VOICEOVER, FIT, MIX). Each has a one-element takes list for its
// current run, so redo.watchJobs mirrors its job like any take. A later step made from an earlier step's
// older output is out of date until it is run again.
import { join, filmKey } from "./paths.js";
import { projectOf } from "./audio.js";
import { filmTargets, planFit, fitSheet } from "./fitplan.js";
import { NO_LINE_SCRIPT } from "./narration.js";
import { measureFileFor, needStemRemixer, openInStemRemixer } from "./tools/stemfit.js";
import { musicRide, MUSIC_DB, SFX_DB } from "./tools/mixdown.js";

export const OUT_OF_DATE = "Out of date: run again";
export const REJOIN = "Waits for the voiceover join to be run again.";
const EXPORT_SLACK_S = 1;
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
  h.startedAt = j.startedAt ?? null; // a take saved after this is not in the run
  if (h.id === "VOICEOVER") copy(["wav", "csv", "transcript", "lengthS", "tightened", "extra", "silent", "duplicates"]);
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
// A take saved after the join started (or re-recorded since) is not in the voiceover.
export function joinStale(vo, narration) {
  if (vo?.status !== "done") return false;
  const since = vo.startedAt ?? vo.at;
  if (since == null) return false;
  return (narration?.rows ?? []).some((r) => Number.isFinite(r.takeS) && r.takeS * 1000 > since);
}

// ctx.joinStale when the caller worked it out, else from ctx.narration (the Narration list's rows).
function refuseIfJoinStale(ctx) {
  const stale = ctx.joinStale ?? joinStale(ctx.store.state.mix?.voiceover, ctx.narration);
  if (stale) throw new Error(REJOIN);
}
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
  if (!f || f.status !== "done" || x.fromFitAt !== f.at || !vo || vo.status !== "done" || x.fromVoiceoverAt !== vo.at) return true;
  return JSON.stringify(x.fromSfx ?? []) !== JSON.stringify(sfxUsed(state));
}

// What the mix takes from the sound effects: each approved cue with a finished chosen take, its take and start.
export function sfxUsed(state) {
  const out = [];
  for (const x of state?.audio?.sfx ?? []) {
    if (!x.approved) continue;
    const t = (x.takes ?? []).find((y) => y.n === x.chosen && y.status === "done" && y.file);
    if (!t) continue;
    out.push({ id: x.id, take: x.chosen, file: t.file, startS: x.startS == null ? null : Number(x.startS), loop: !!x.loop, meanDb: t.meanDb ?? null });
  }
  return out;
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

// A measure.py result for this audio: the cached one, or a fresh measure job (gpu lane) awaited here.
async function measured(ctx, audio, { cacheFile, force = false, why } = {}) {
  const { host, store, jobs } = ctx;
  const cache = cacheFile ?? measureFileFor(audio);
  if (!force) {
    try { const m = JSON.parse(await host.fs.read(cache, "utf8")); if (goodMeasure(m)) return m; } catch { /* not cached yet */ }
  }
  const film = filmKey(store.dir);
  const take = jobs.list().filter((j) => j.assetId === "MEASURE" && filmKey(j.film) === film).reduce((m, j) => Math.max(m, Number(j.take) || 0), 0) + 1;
  const id = jobs.add({
    film: store.dir, assetId: "MEASURE", take, tool: "stemfit",
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
    allowFlagged: !!allowFlagged, wav: null, csv: null, transcript: null, lengthS: null, tightened: [], extra: [], silent: [], duplicates: [], at: null,
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
  await needStemRemixer(host, settings);
  const vo = needVoiceover(store.state);
  refuseIfJoinStale(ctx);
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

// A path pasted into "Use another file…": Explorer's Copy as path wraps it in double quotes.
export const pastedPath = (v) => String(v ?? "").trim().replace(/^"+|"+$/g, "").trim();

// The last export measured for each film, kept while Jon decides on a length warning.
const lastExport = new WeakMap();

// Jon fixed the fit by ear in Stem Remixer and exported it: measure the export (its moves are in film time),
// rebuild the sheet, and use it as the fitted score. An export more than 1 s off the film's length is not used
// yet: this resolves with {confirm: question}, and Jon's yes calls again with {confirmed: true}.
// pasted: the path came from "Use another file…".
export async function useStemRemixerExport(ctx, file, { pasted = false, confirmed = false } = {}) {
  const { host, store, settings = {} } = ctx;
  await needStemRemixer(host, settings);
  if (pasted) file = pastedPath(file);
  if (!filled(file) || !(await host.fs.exists(file))) {
    throw new Error(pasted ? "Couldn't find that file." : "That export isn't there any more. Export it again in Stem Remixer.");
  }
  const vo = needVoiceover(store.state);
  refuseIfJoinStale(ctx);
  const sc = needScore(store.state);
  return preparing(store, "FIT", async () => {
    const targets = filmTargets(await readTimings(host, vo.csv), settings.endCardS ?? 12);
    const cacheFile = join(mixDir(store), `${projectOf(store.dir)}_score_export.measure.json`);
    await host.fs.mkdir(mixDir(store));
    const kept = lastExport.get(store);
    const measure = confirmed && kept?.file === file ? kept.measure
      : await measured(ctx, file, { cacheFile, force: true, why: "Stem Remixer export" });
    lastExport.set(store, { file, measure });
    const off = Number(measure.duration_s) - targets.filmS;
    if (!confirmed && Math.abs(off) > EXPORT_SLACK_S) {
      return { confirm: `This export is ${Math.abs(off).toFixed(1)} s ${off > 0 ? "longer" : "shorter"} than the film. Use it anyway?` };
    }
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
    lastExport.delete(store);
    await store.log(`Score fit run ${n}: using the Stem Remixer export`);
    return n;
  });
}

// Stem Remixer's Export mix dialog starts here (the film's own folder), so "Use this export" finds the file.
export const stemExportDir = (store) => join(mixDir(store), "stem-remixer");

// Open the score in Stem Remixer. The app's plan goes in (--plan) only on the first open after an app fit:
// Stem Remixer keeps Jon's hand tweaks itself, and a later --plan would replace them.
export async function openFitInStemRemixer(ctx, { open = openInStemRemixer } = {}) {
  const { host, store, settings = {} } = ctx;
  await needStemRemixer(host, settings, { windowed: true });
  const fit = store.state.mix?.fit;
  const score = fit?.scoreFile ?? approvedScore(store.state)?.file ?? null;
  const planFile = join(mixDir(store), "plan.json");
  const withPlan = fit?.status === "done" && fit.source === "app" && fit.openedAt == null && (await host.fs.exists(planFile));
  const exportDir = stemExportDir(store);
  await host.fs.mkdir(exportDir);
  const run = runOf(fit);
  const text = await open(host, settings, { score, plan: withPlan ? planFile : null, exportDir });
  if (fit) {
    const now = host.now();
    await store.update((d) => { const f = d.mix?.fit; if (f && runOf(f) === run && f.openedAt == null) f.openedAt = now; });
  }
  return text;
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
  refuseIfJoinStale(ctx);
  if (fitStale(state)) throw new Error("The score fit is out of date. Fit it again first.");
  return preparing(store, "MIX", async () => {
    const rows = await readTimings(host, vo.csv);
    const targets = filmTargets(rows, settings.endCardS ?? 12);
    const music = await measured(ctx, fit.file, { cacheFile: fit.measureFile ?? undefined, why: "Before the mix" });
    const ride = musicRide(music, rows, { musicDb: Number(settings.mixMusicDb ?? MUSIC_DB) });
    const used = sfxUsed(state);
    const sfx = used.map(({ id, file, startS, loop, meanDb }) => {
      const item = { id, file, startS, loop, meanDb };
      if (loop && startS != null) item.endS = loopEnd(startS, targets);
      return item;
    });
    const out = join(mixDir(store), `${projectOf(store.dir)}_mix.wav`);
    return startRun(ctx, "MIX", {
      files: null, unplaced: [], approved: false, fromFitAt: fit.at, fromVoiceoverAt: vo.at, fromSfx: used, at: null,
    }, { input: { voice: vo.wav, music: fit.file, sfx, filmS: targets.filmS, out, ride, sfxDb: Number(settings.mixSfxDb ?? SFX_DB) } });
  });
}

export async function approveMix(ctx) {
  const { host, store } = ctx;
  const state = store.state;
  const m = state.mix?.mix;
  if (!m || m.status !== "done") throw new Error("There is no finished mix to approve.");
  refuseIfJoinStale(ctx);
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
