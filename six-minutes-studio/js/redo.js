// Takes: start a first take or a redo with a note, mirror job progress onto takes, approvals.
import { askJson } from "./claude.js";
import { join, filmKey } from "./paths.js";
import { deriveWaiting } from "./shots.js";
import { mixHolders, mixJobDone, syncMixHolder, MIX_IDS, runLabel } from "./mixplan.js";

const REWRITE_INSTRUCTIONS = `You improve one image or video generation prompt for a Six Minutes On... documentary film (dark, calm, precise, British English).
You get the shot (id, desc, line, kind), the previous prompt and Jon's note. Change the previous prompt to follow the note and keep everything else the same.
For "lineart" shots keep the line-illustration wording: fine single-weight ink lines on a pure black background, no fill, no shading, no text, no frame.
Reply with JSON only: {"prompt": "<the new prompt>"}.`;

const filled = (v) => typeof v === "string" && v.trim() !== "";
const find = (state, id) => state.assets.find((a) => a.id === id);
// Everything that has takes: b-roll shots, then the score, then the sound-effect cues, then the
// voiceover join, score fit and mix preview (VOICEOVER, FIT, MIX: one take per run).
export const holders = (d) => [...d.assets ?? [], ...(d.audio?.score ? [d.audio.score] : []), ...(d.audio?.sfx ?? []), ...mixHolders(d)];
const META = ["lengthS", "peakDb", "meanDb", "quiet", "checks", "script"];
const nameOf = (id) => (id === "SCORE" ? "Score" : id);
const takeName = (id, n) => (MIX_IDS.has(id) ? `${runLabel(id)} run ${n}` : `${nameOf(id)} take ${n}`);
// Every change to the shots also rewrites what the film is waiting on Jon for, in the same update.
const save = (store, fn) => store.update((d) => { fn(d); d.waiting = deriveWaiting(d.assets); });

export function canStart(asset, assets) {
  if (asset.tool !== "blender" && asset.kind !== "animated") return true;
  const src = assets.find((a) => a.id === asset.sourceId);
  return !!src && !!src.approved;
}

export const hasDerived = (assets, lineartId, kind) => assets.some((a) => a.kind === kind && a.sourceId === lineartId);
export const has3d = (assets, lineartId) => hasDerived(assets, lineartId, "blender");

// The next free HF number counts removed assets too, so a re-made version never reuses an id.
const nextId = (d) => {
  const top = [...d.assets, ...(d.removed ?? [])].reduce((m, a) => Math.max(m, Number(/^HF-(\d+)$/.exec(a.id)?.[1] ?? 0)), 0);
  return `HF-${String(top + 1).padStart(2, "0")}`;
};

// Add a derived shot that uses a line drawing as its source. It sits beside the source (same line)
// and stays locked until the source is approved. One live version of each kind per drawing.
async function addDerived(ctx, lineartId, kind, label, make) {
  const { store } = ctx;
  const src = find(store.state, lineartId);
  if (!src) throw new Error(`Unknown shot ${lineartId}`);
  if (src.kind !== "lineart") throw new Error(`${lineartId} is not line art.`);
  const refuse = () => new Error(`${lineartId} already has ${label} version.`);
  if (hasDerived(store.state.assets, lineartId, kind)) throw refuse();
  let id;
  await save(store, (d) => {
    if (hasDerived(d.assets, lineartId, kind)) throw refuse();
    id = nextId(d);
    const desc = src.desc ? src.desc[0].toLowerCase() + src.desc.slice(1) : lineartId;
    d.assets.push({
      id, kind, tool: kind === "animated" ? "comfyui" : "blender", sourceId: lineartId, line: src.line, lineIndex: src.lineIndex,
      ...make(desc), takes: [], chosen: 0, approved: false,
    });
  });
  return id;
}

export async function addBlender3d(ctx, lineartId) {
  const id = await addDerived(ctx, lineartId, "blender", "a Blender", (desc) => ({
    desc: `3D line-art version of ${desc}`, draftPrompt: `3D line-art version of ${lineartId} in Blender`,
  }));
  await ctx.store.log(`${id} added: 3D version of ${lineartId} in Blender`);
  return id;
}

export async function addAnimated(ctx, lineartId) {
  const id = await addDerived(ctx, lineartId, "animated", "an animated", (desc) => ({
    desc: `Animated version of ${desc}`,
    draftPrompt: `${desc}; slow orbit around it, keep the hand-drawn amber line-art style on black, no new colours`,
  }));
  await ctx.store.log(`${id} added: animated version of ${lineartId}`);
  return id;
}

// Take a 3D or animated version out of the review. Its takes stay on disk.
export async function removeVersion(ctx, id) {
  const { store } = ctx;
  const a = find(store.state, id);
  if (!a) throw new Error(`Unknown shot ${id}`);
  if (a.kind !== "blender" && a.kind !== "animated") throw new Error(`${id} is not a 3D or animated version.`);
  const inProgress = () => busy(a) || starting(store, id);
  if (inProgress()) throw new Error(`${id} has a take in progress.`);
  await save(store, (d) => {
    const x = find(d, id);
    if (busy(x) || starting(store, id)) throw new Error(`${id} has a take in progress.`);
    d.assets = d.assets.filter((y) => y.id !== id);
    (d.removed ??= []).push({ ...x, removedAt: ctx.host.now() });
  });
  await store.log(`${id} removed from the review (takes kept on disk)`);
}

function previousTake(asset) {
  return asset.takes.find((t) => t.n === asset.chosen) ?? asset.takes[asset.takes.length - 1];
}

export async function startTake(ctx, assetId, { note } = {}) {
  const { host, store, jobs } = ctx;
  const asset = find(store.state, assetId);
  if (!asset) throw new Error(`Unknown shot ${assetId}`);
  if (!canStart(asset, store.state.assets)) throw new Error(`${asset.id} needs its source line art approved first.`);
  if (asset.takes.some((t) => t.status === "queued" || t.status === "running")) {
    throw new Error(`${asset.id} already has a take in progress.`);
  }
  const hasNote = filled(note);
  const n = asset.takes.length + 1;
  const prev = previousTake(asset);
  const base = join(store.dir, "studio", "media", `${asset.id}_t${n}`);
  let take, input;
  const nextPrompt = async () => {
    let prompt = asset.draftPrompt;
    if (hasNote || prev) {
      const r = await askJson(host, {
        instructions: REWRITE_INSTRUCTIONS,
        data: {
          shot: { id: asset.id, desc: asset.desc, line: asset.line, kind: asset.kind },
          previousPrompt: prev?.prompt ?? asset.draftPrompt,
          note: hasNote ? note : null,
        },
        tier: "quick",
        validate: (v) => { if (!v || !filled(v.prompt)) throw new Error("prompt is empty"); },
      });
      prompt = r.prompt;
    }
    return prompt;
  };

  // All Claude work happens before any write. A Blender take does its Claude work inside the job
  // (script, check stills, render), so it only needs the drawing and the previous take here.
  if (asset.kind === "animated") {
    // Like a ComfyUI b-roll take, but it starts from the drawing's chosen take.
    const src = find(store.state, asset.sourceId);
    const sourceFile = src.takes.find((t) => t.n === src.chosen)?.file;
    const prompt = await nextPrompt();
    take = { n, prompt };
    input = { kind: "animated", prompt, out: base + ".mp4", sourceFile };
  } else if (asset.tool === "blender") {
    const src = find(store.state, asset.sourceId);
    const sourceFile = src.takes.find((t) => t.n === src.chosen)?.file;
    take = { n };
    input = {
      kind: "blender", asset: { id: asset.id, desc: asset.desc, line: asset.line }, take: n,
      sourceFile, base: join(store.dir, "studio", "blender", `${asset.id}_t${n}`), out: base + ".mp4",
    };
    if (hasNote) input.note = note;
    // The previous take's files on disk, not its record: a failed take (say, blank twice) never got
    // script or checks from the job, and that is exactly when Jon redoes it with a note.
    if (prev) {
      const pb = join(store.dir, "studio", "blender", `${asset.id}_t${prev.n}`);
      // The newest round script; the final script is a copy of it. The still sent with it must be
      // that same round's: a round whose still never came (Blender crashed) sends none.
      let round = 0;
      for (let k = 3; k >= 1 && !round; k--) if (await host.fs.exists(`${pb}_r${k}.py`)) round = k;
      let previousScript;
      if (await host.fs.exists(pb + ".py")) previousScript = pb + ".py";
      else if (round) previousScript = `${pb}_r${round}.py`;
      else if (prev.script && (await host.fs.exists(prev.script))) previousScript = prev.script;
      if (previousScript) input.previousScript = previousScript;
      const previousStill = round ? `${pb}_check${round}.png` : null;
      if (previousScript && previousStill && (await host.fs.exists(previousStill))) input.previousStill = previousStill;
    }
  } else {
    const prompt = await nextPrompt();
    take = { n, prompt };
    input = { kind: asset.kind, prompt, out: asset.tool === "comfyui" ? base + ".mp4" : base };
  }
  if (hasNote) take.note = note;
  take.tool = asset.tool;
  take.status = "queued";
  take.at = host.now();

  const key = `${assetId}#${n}`;
  store.pending?.add(key);
  let jobId;
  try {
    await save(store, (d) => {
      const a = find(d, assetId);
      if (!a || a.takes.length !== n - 1) throw new Error(`${asset.id} changed while the take was being prepared.`);
      a.takes.push(take);
      a.chosen = n;
      a.approved = false;
    });
  } catch (e) { store.pending?.delete(key); throw e; }
  try {
    jobId = jobs.add({
      film: store.dir, assetId, take: n, tool: asset.tool,
      what: `${asset.id}: ${asset.desc}`,
      why: hasNote ? `Take ${n}, from your note "${note}"` : "First take",
      input,
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    await save(store, (d) => {
      const t = find(d, assetId).takes.find((x) => x.n === n);
      if (t) { t.status = "failed"; t.error = msg; }
    });
    await store.log(`${asset.id} take ${n} failed: ${msg}`);
    throw e;
  } finally {
    store.pending?.delete(key);
  }
  await store.update((d) => {
    const t = find(d, assetId).takes.find((x) => x.n === n);
    if (t && !t.jobId) t.jobId = jobId;
  });
  await store.log(`${asset.id} take ${n} started${hasNote ? `: ${note}` : ""}`);
  return structuredClone(store.state.assets.find((a) => a.id === assetId).takes.find((t) => t.n === n));
}

// A job whose shot was removed from the film's review (in state.removed: a 3D or animated version): running or
// checking it again would do the whole job and throw the result away. Unknown state is never refused.
export const removedText = (id) => `${id} was removed from the review.`;
export function jobGone(state, job) {
  if (!state || job?.assetId === undefined || job?.assetId === null) return false;
  // Only shots taken out with Remove this version: other jobs without a holder (the score measure) run as before.
  const removed = (state.removed ?? []).some((a) => a?.id === job.assetId);
  return removed && !holders(state).some((h) => h.id === job.assetId);
}

// The refusal text for a Jobs-panel Retry or Check, or null to go ahead. The open film's state is
// used when the job is for it; any other film's is read from disk (unreadable: not refused).
export async function jobRemoved(host, job, store) {
  if (job?.assetId === undefined || job?.assetId === null) return null;
  let state = null;
  if (store && filmKey(store.dir) === filmKey(job.film)) state = store.state;
  else {
    try { state = JSON.parse(await host.fs.read(join(job.film, "studio", "state.json"), "utf8")); } catch { state = null; }
  }
  return jobGone(state, job) ? removedText(job.assetId) : null;
}

// Mirror job status onto takes. Each sync reconciles against the current job list and writes
// state.json only when some take actually changes (progress alone never writes).
export const LOST = "Lost track of this job";

function applyJobs(d, dir, list, lines, pending) {
  // Latest job per (asset, take): a retry replaces the earlier failed one.
  const film = filmKey(dir);
  const latest = new Map();
  for (const j of list) if (filmKey(j.film) === film) latest.set(`${j.assetId}\u0000${j.take}`, j);
  let changed = false;
  const all = holders(d);
  for (const j of latest.values()) {
    const holder = all.find((h) => h.id === j.assetId);
    const t = holder?.takes?.find((x) => x.n === j.take);
    if (!t) continue;
    if (j.id !== t.jobId) { t.jobId = j.id; changed = true; }
    if (!["queued", "running", "done", "failed", "interrupted"].includes(j.status) || t.status === j.status) continue;
    changed = true;
    t.status = j.status;
    if (j.status === "done") {
      t.file = j.file;
      for (const k of META) if (j.meta?.[k] !== undefined) t[k] = j.meta[k];
      delete t.error;
      if (MIX_IDS.has(j.assetId)) mixJobDone(holder, j);
      lines.push(`${takeName(j.assetId, j.take)} ready`);
    } else if (j.status === "failed" || j.status === "interrupted") {
      t.error = j.error ?? (j.status === "interrupted" ? "Interrupted" : "Failed");
      lines.push(`${takeName(j.assetId, j.take)} failed: ${t.error}`);
    } else delete t.error;
  }
  // A busy take with no job (job list moved aside, not saved before close) would stay busy for ever.
  for (const a of all) {
    for (const t of a.takes ?? []) {
      if (t.status !== "queued" && t.status !== "running") continue;
      if (latest.has(`${a.id}\u0000${t.n}`) || pending?.has(`${a.id}#${t.n}`)) continue;
      t.status = "interrupted";
      t.error = LOST;
      changed = true;
      lines.push(`${takeName(a.id, t.n)} failed: ${LOST}`);
    }
  }
  for (const h of mixHolders(d)) if (syncMixHolder(h)) changed = true;
  const w = deriveWaiting(d.assets);
  if (d.waiting !== w) { d.waiting = w; changed = true; }
  return changed;
}

// ctx.onError(message) reports a failed state write (null once a later reconcile succeeds).
export function watchJobs(ctx) {
  const { store, jobs, onError = () => {} } = ctx;
  let chain = Promise.resolve();
  let queued = false;
  const run = async () => {
    queued = false;
    if (!applyJobs(structuredClone(store.state), store.dir, jobs.list(), [], store.pending)) return;
    const lines = [];
    try {
      await store.update((d) => {
        lines.length = 0;
        applyJobs(d, store.dir, jobs.list(), lines, store.pending);
      });
    } catch (e) {
      console.error(`Couldn't save ${store.dir} state`, e);
      try { onError(String(e?.message ?? e)); } catch { /* reporting must not stop the watcher */ }
      return;
    }
    try { onError(null); } catch { /* ignore */ }
    for (const l of lines) await store.log(l);
  };
  const sync = () => {
    if (queued) return; // one pending reconcile covers every change since it was queued
    queued = true;
    chain = chain.then(run).catch(() => {});
  };
  const off = jobs.onChange(sync);
  sync();
  return off;
}

export async function approve(ctx, assetId) {
  const { store } = ctx;
  const a = find(store.state, assetId);
  if (!a) throw new Error(`Unknown shot ${assetId}`);
  const t = a.takes.find((x) => x.n === a.chosen);
  if (!t || t.status !== "done") throw new Error(`${assetId} has no finished take to approve.`);
  await save(store, (d) => { find(d, assetId).approved = true; });
  await store.log(`${assetId} take ${t.n} approved`);
}

export async function unapprove(ctx, assetId) {
  const { store } = ctx;
  if (!find(store.state, assetId)) throw new Error(`Unknown shot ${assetId}`);
  await save(store, (d) => { find(d, assetId).approved = false; });
  await store.log(`${assetId} approval removed`);
}

export async function choose(ctx, assetId, n) {
  const { store } = ctx;
  const a = find(store.state, assetId);
  if (!a) throw new Error(`Unknown shot ${assetId}`);
  if (!a.takes.some((t) => t.n === n)) throw new Error(`${assetId} has no take ${n}.`);
  await save(store, (d) => { const x = find(d, assetId); x.chosen = n; x.approved = false; });
  await store.log(`${assetId} take ${n} chosen`);
}

const TOOL_LABEL = { higgsfield: "Higgsfield", comfyui: "ComfyUI" };
const busy = (a) => (a.takes ?? []).some((t) => t.status === "queued" || t.status === "running");
const starting = (store, id) => [...(store.pending ?? [])].some((k) => k.startsWith(`${id}#`));

// Switch a b-roll shot between Higgsfield and ComfyUI. Approval is unchanged.
export async function setTool(ctx, assetId, tool) {
  const { store } = ctx;
  const a = find(store.state, assetId);
  if (!a) throw new Error(`Unknown shot ${assetId}`);
  if (a.kind !== "broll") throw new Error(`${assetId} is not b-roll, so its tool can't change.`);
  if (!TOOL_LABEL[tool]) throw new Error(`${tool} is not a tool for b-roll.`);
  if (a.tool === tool) return;
  if (busy(a) || starting(store, assetId)) throw new Error(`${assetId} has a take in progress.`);
  await save(store, (d) => { find(d, assetId).tool = tool; });
  await store.log(`${assetId} now uses ${TOOL_LABEL[tool]}`);
}

// Remember the preference and move b-roll shots that have not started yet.
export async function setPreferComfy(ctx, on) {
  const { store } = ctx;
  const want = on ? "comfyui" : "higgsfield";
  let n = 0;
  await save(store, (d) => {
    d.prefs = { ...d.prefs, preferComfy: !!on };
    n = 0;
    for (const a of d.assets) {
      if (a.kind !== "broll" || (a.takes ?? []).length || starting(store, a.id) || a.tool === want) continue;
      a.tool = want;
      n++;
    }
  });
  await store.log(`Prefer ComfyUI for b-roll: ${on ? "on" : "off"} (${n} shots switched)`);
}
