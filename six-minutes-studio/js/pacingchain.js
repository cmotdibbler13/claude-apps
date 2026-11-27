// Apply pauses: rejoin the voiceover with Jon's pause marks, then refit the score and remake the mix
// (only the steps that already exist).
import { startJoin, startFit, startMix, waitJob, goodFrame } from "./mixplan.js";
import { buildPauses, marksSig, takeSig, toUnpaused, newTakeIds, hasInsideMarks } from "./pacing.js";

const EMPTY_SIG = marksSig({ lines: {} }, {});

// Lines the join takes only when Jon presses Join anyway: their check found a problem, never ran, or is older than the checker.
export const NOT_OK = new Set(["flagged", "unchecked", "outdated", "error", "rerecord"]);
export const NO_FRAME = "Couldn't read the last voiceover's word timings, so the pauses can't be placed. Join again without changes first.";
export const JOINED_WITHOUT = "Joined without the pauses: the last voiceover's word timings couldn't be read. Press Apply pauses to add them.";
const live = (s) => s === "queued" || s === "running";
const SLOT = { VOICEOVER: "voiceover", FIT: "fit", MIX: "mix" };
const LABEL = { VOICEOVER: "voiceover join", FIT: "score fit", MIX: "mix" };

// Whether a line needs --allow-flagged: a Re-record tick on its own never does; the line's own check result does.
const checkOf = (r) => (r.status === "rerecord" ? r.checkedStatus ?? null : r.status);
const sigsOf = (narration) => Object.fromEntries((narration?.rows ?? []).map((r) => [r.id, takeSig(r)]).filter(([, v]) => v != null));

export function canApply({ state, narration, sig, running } = {}) {
  if (running) return { ok: false, why: "Applying pauses is already running." };
  for (const id of Object.keys(SLOT)) {
    if (live(state?.mix?.[SLOT[id]]?.status)) return { ok: false, why: `The ${LABEL[id]} is running.` };
  }
  const allowed = new Set(state?.mix?.voiceover?.allowedIds ?? []);
  const bad = (narration?.rows ?? []).filter((r) => NOT_OK.has(checkOf(r)) && !allowed.has(r.id));
  if (bad.length) return { ok: false, why: `Newly flagged: ${bad.map((r) => r.id).join(", ")}. Use Join anyway first.` };
  return { ok: true, why: null };
}

const sentencesOf = (t) => [...(t?.sentences ?? [])].filter((s) => Number.isFinite(s.start)).sort((a, b) => a.start - b.start);
const addedBefore = (applied, at) => (applied ?? []).filter((a) => a.at_s < at).reduce((n, a) => n + a.add_s, 0);

// Jon's start times follow the line they sit in when the pauses move it.
export function shiftJonStarts(sfx, oldTranscript, newTranscript, oldApplied = {}, newApplied = {}) {
  const olds = sentencesOf(oldTranscript);
  const news = new Map(sentencesOf(newTranscript).map((s) => [s.sentence, s]));
  const out = [];
  for (const x of sfx ?? []) {
    if (x.startSBy !== "jon" || x.startS == null) continue;
    const t = Number(x.startS);
    let i = -1;
    olds.forEach((s, k) => { if (s.start <= t) i = k; });
    if (i < 0) { out.push({ id: x.id, startS: t }); continue; }
    const o = olds[i], n = news.get(o.sentence);
    if (!n) { out.push({ id: x.id, startS: t }); continue; }
    let next;
    if (t < o.end) {
      const u = toUnpaused(t - o.start, oldApplied?.[o.sentence] ?? []);
      next = n.start + u + addedBefore(newApplied?.[o.sentence], u);
    } else next = n.end + (t - o.end);
    out.push({ id: x.id, startS: Math.round(next * 1000) / 1000 });
  }
  return out;
}

async function readJson(host, path) {
  if (!path) return null;
  try { return JSON.parse(await host.fs.read(path, "utf8")); } catch { return null; }
}

// waitJob resolves on the job; the holder follows it a moment later (the store has no change hook, so poll).
async function holderDone(store, key, label) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const h = store.state.mix?.[key];
    if (h?.status === "done") return;
    if (h?.status === "failed" || h?.status === "interrupted") throw new Error(h.error ?? "It stopped.");
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`The ${label} finished but Studio didn't record it in time. Press Apply pauses again.`);
}

async function runStep(ctx, key, label, start) {
  await start();
  const id = ctx.store.state.mix?.[key]?.jobId;
  if (!id) throw new Error("The step did not start.");
  await waitJob(ctx.jobs, id);
  await holderDone(ctx.store, key, label);
}

// Apply pauses (and, with joinOnly, the plain Join / Join again): join with the marks as they are now, placed from the
// last good join's transcript and pauses (goodFrame), move Jon's cue starts with them, then (not joinOnly) refit and remix.
// allowFlagged (joinOnly): Jon pressed Join anyway.
// onStarted: called once the join's job is queued (Join's button is free again from then on).
export async function applyPauses(ctx, { onStep, onStarted, joinOnly = false, allowFlagged: anyway = false } = {}) {
  const { host, store, narration } = ctx;
  const before = store.state.mix ?? {};
  const fit = before.fit?.status === "done" ? before.fit : null;
  const hadMix = before.mix?.status === "done";
  const frame = goodFrame(before.voiceover);
  const oldApplied = frame?.applied ?? {};
  const oldTranscript = await readJson(host, frame?.transcript);
  const takeSigs = sigsOf(narration);
  const pacing = before.pacing;
  const skipInside = newTakeIds(narration, frame);
  // Marks inside lines can't be placed without the last good join's word timings: Apply refuses; the plain Join
  // ("Join again without changes") joins with no pauses at all, so the next Apply places them from that join.
  const blind = !oldTranscript && hasInsideMarks(pacing, takeSigs, { skipInside });
  if (blind && !joinOnly) throw new Error(NO_FRAME);
  const sig = marksSig(pacing, takeSigs, { skipInside });
  const { file } = buildPauses(pacing, oldTranscript, oldApplied, takeSigs, { skipInside });

  const others = (narration?.rows ?? []).filter((r) => NOT_OK.has(checkOf(r)));
  const allowedSet = new Set(before.voiceover?.allowedIds ?? []);
  const lastHad = !!before.voiceover?.allowFlagged || !!frame?.allowFlagged;
  const allowFlagged = joinOnly
    ? !!anyway && (others.length > 0 || lastHad)
    : lastHad || (others.length > 0 && others.every((r) => allowedSet.has(r.id)));
  const allowedIds = allowFlagged ? others.map((r) => r.id) : [];
  const pauses = blind || (joinOnly && sig === EMPTY_SIG) ? null : { file, sig, applied: file.inside, allowedIds };

  onStep?.("VOICEOVER");
  await runStep(ctx, "voiceover", "voiceover join", async () => {
    await startJoin({ ...ctx, notOkIds: allowedIds }, { allowFlagged, pauses });
    onStarted?.("VOICEOVER");
  });

  const newTranscript = await readJson(host, store.state.mix.voiceover.transcript);
  if (oldTranscript && newTranscript) {
    const shifted = shiftJonStarts(store.state.audio?.sfx ?? [], oldTranscript, newTranscript, oldApplied, file.inside);
    const changed = shifted.filter((s) => store.state.audio.sfx.find((x) => x.id === s.id)?.startS !== s.startS);
    if (changed.length) {
      await store.update((d) => {
        for (const s of changed) { const x = d.audio.sfx.find((y) => y.id === s.id); if (x) { x.startS = s.startS; x.startSBy = "jon"; } }
      });
      await store.log(`Pauses moved the start of ${changed.map((s) => s.id).join(", ")}`);
    }
  }

  if (joinOnly) return blind ? { stoppedAt: null, joinOnly: true, withoutPauses: true } : { stoppedAt: null, joinOnly: true };
  if (!fit || fit.source !== "app") return { stoppedAt: "FIT" };
  onStep?.("FIT");
  await runStep(ctx, "fit", "score fit", () => startFit(ctx, { note: fit.note ?? undefined }));
  if (!hadMix) return { stoppedAt: null };
  onStep?.("MIX");
  await runStep(ctx, "mix", "mix", () => startMix(ctx));
  return { stoppedAt: null };
}
