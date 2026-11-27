// Apply pauses: rejoin the voiceover with Jon's pause marks, then refit the score and remake the mix
// (only the steps that already exist).
import { startJoin, startFit, startMix, waitJob } from "./mixplan.js";
import { buildPauses, marksSig, takeSig, toUnpaused } from "./pacing.js";

const NOT_OK = new Set(["flagged", "unchecked", "outdated", "error", "rerecord"]);
const live = (s) => s === "queued" || s === "running";
const SLOT = { VOICEOVER: "voiceover", FIT: "fit", MIX: "mix" };
const LABEL = { VOICEOVER: "voiceover join", FIT: "score fit", MIX: "mix" };

const notOkRows = (narration) => (narration?.rows ?? []).filter((r) => NOT_OK.has(r.status));
const sigsOf = (narration) => Object.fromEntries((narration?.rows ?? []).map((r) => [r.id, takeSig(r)]).filter(([, v]) => v != null));

export function canApply({ state, narration, sig, running } = {}) {
  if (running) return { ok: false, why: "Applying pauses is already running." };
  for (const id of Object.keys(SLOT)) {
    if (live(state?.mix?.[SLOT[id]]?.status)) return { ok: false, why: `The ${LABEL[id]} is running.` };
  }
  const allowed = new Set(state?.mix?.voiceover?.allowedIds ?? []);
  const bad = notOkRows(narration).filter((r) => r.status !== "rerecord" && !allowed.has(r.id));
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

// waitJob resolves on the job; the holder follows it a moment later.
async function holderDone(store, key, host) {
  for (let i = 0; i < 400; i++) {
    const s = store.state.mix?.[key]?.status;
    if (s === "done") return;
    if (s === "failed" || s === "interrupted") throw new Error(store.state.mix[key].error ?? "It stopped.");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function runStep(ctx, key, start) {
  await start();
  const id = ctx.store.state.mix?.[key]?.jobId;
  if (!id) throw new Error("The step did not start.");
  await waitJob(ctx.jobs, id);
  await holderDone(ctx.store, key, ctx.host);
}

export async function applyPauses(ctx, { onStep } = {}) {
  const { host, store, narration } = ctx;
  const before = store.state.mix ?? {};
  const fit = before.fit?.status === "done" ? before.fit : null;
  const hadMix = before.mix?.status === "done";
  const oldApplied = before.voiceover?.pausesApplied ?? {};
  const oldTranscript = await readJson(host, before.voiceover?.transcript);
  const takeSigs = sigsOf(narration);
  const sig = marksSig(before.pacing, takeSigs);
  const { file } = buildPauses(before.pacing, oldTranscript, oldApplied, takeSigs);
  const rows = notOkRows(narration);
  const allowedIds = rows.map((r) => r.id);
  const allowedSet = new Set(before.voiceover?.allowedIds ?? []);
  const allowFlagged = rows.length > 0 && rows.every((r) => r.status === "rerecord" || allowedSet.has(r.id));

  onStep?.("VOICEOVER");
  await runStep(ctx, "voiceover", () => startJoin(ctx, { allowFlagged, pauses: { file, sig, applied: file.inside, allowedIds } }));
  await store.update((d) => {
    d.mix.pacing ??= { lines: {} };
    d.mix.pacing.appliedSig = sig;
    d.mix.pacing.applied = file.inside;
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

  if (!fit || fit.source !== "app") return { stoppedAt: "FIT" };
  onStep?.("FIT");
  await runStep(ctx, "fit", () => startFit(ctx, { note: fit.note ?? undefined }));
  if (!hadMix) return { stoppedAt: null };
  onStep?.("MIX");
  await runStep(ctx, "mix", () => startMix(ctx));
  return { stoppedAt: null };
}
