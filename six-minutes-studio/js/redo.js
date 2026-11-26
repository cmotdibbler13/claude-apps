// Takes: start a first take or a redo with a note, mirror job progress onto takes, approvals.
import { askJson } from "./claude.js";
import { writeBlenderScript } from "./tools/blender.js";
import { join } from "./paths.js";

const REWRITE_INSTRUCTIONS = `You improve one image or video generation prompt for a Six Minutes On... documentary film (dark, calm, precise, British English).
You get the shot (id, desc, line, kind), the previous prompt and Jon's note. Change the previous prompt to follow the note and keep everything else the same.
For "lineart" shots keep the line-illustration wording: fine single-weight ink lines on a pure black background, no fill, no shading, no text, no frame.
Reply with JSON only: {"prompt": "<the new prompt>"}.`;

const filled = (v) => typeof v === "string" && v.trim() !== "";
const find = (state, id) => state.assets.find((a) => a.id === id);

export function canStart(asset, assets) {
  if (asset.tool !== "blender") return true;
  const src = assets.find((a) => a.id === asset.sourceId);
  return !!src && !!src.approved;
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

  // All Claude work happens before any write.
  if (asset.tool === "blender") {
    let previous;
    if (prev?.script) { try { previous = await host.fs.read(prev.script, "utf8"); } catch { /* no earlier script to show */ } }
    let frames;
    const script = await writeBlenderScript(host, store, asset, n, {
      note: hasNote ? note : undefined, previous, onFrames: (f) => { frames = f; },
    });
    const src = find(store.state, asset.sourceId);
    const sourceFile = src.takes.find((t) => t.n === src.chosen)?.file;
    take = { n, script };
    input = { kind: "blender", script, sourceFile, out: base + ".mp4", frames };
  } else {
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
    take = { n, prompt };
    input = { kind: asset.kind, prompt, out: base };
  }
  if (hasNote) take.note = note;
  take.status = "queued";
  take.at = host.now();

  await store.update((d) => {
    const a = find(d, assetId);
    if (a.takes.length !== n - 1) throw new Error(`${asset.id} changed while the take was being prepared.`);
    a.takes.push(take);
    a.chosen = n;
    a.approved = false;
  });
  const jobId = jobs.add({
    film: store.dir, assetId, take: n, tool: asset.tool,
    what: `${asset.id}: ${asset.desc}`,
    why: hasNote ? `Take ${n}, from your note "${note}"` : "First take",
    input,
  });
  await store.update((d) => {
    const t = find(d, assetId).takes.find((x) => x.n === n);
    if (t && !t.jobId) t.jobId = jobId;
  });
  await store.log(`${asset.id} take ${n} started${hasNote ? `: ${note}` : ""}`);
  return structuredClone(store.state.assets.find((a) => a.id === assetId).takes.find((t) => t.n === n));
}

export function watchJobs(ctx) {
  const { store, jobs } = ctx;
  let chain = Promise.resolve();
  const sync = (list) => {
    // Latest job per (asset, take): a retry replaces the earlier failed one.
    const latest = new Map();
    for (const j of list) if (j.film === store.dir) latest.set(`${j.assetId}\u0000${j.take}`, j);
    const wanted = [...latest.values()];
    if (!wanted.length) return;
    chain = chain.then(async () => {
      const lines = [];
      await store.update((d) => {
        lines.length = 0;
        for (const j of wanted) {
          const t = find(d, j.assetId)?.takes.find((x) => x.n === j.take);
          if (!t) continue;
          if (j.id !== t.jobId) t.jobId = j.id;
          if (!["queued", "running", "done", "failed", "interrupted"].includes(j.status) || t.status === j.status) continue;
          t.status = j.status;
          if (j.status === "done") { t.file = j.file; delete t.error; lines.push(`${j.assetId} take ${j.take} ready`); }
          else if (j.status === "failed" || j.status === "interrupted") {
            t.error = j.error ?? (j.status === "interrupted" ? "Interrupted" : "Failed");
            lines.push(`${j.assetId} take ${j.take} failed: ${t.error}`);
          } else delete t.error;
        }
      });
      for (const l of lines) await store.log(l);
    }).catch(() => {});
  };
  return jobs.onChange(sync);
}

export async function approve(ctx, assetId) {
  const { store } = ctx;
  const a = find(store.state, assetId);
  if (!a) throw new Error(`Unknown shot ${assetId}`);
  const t = a.takes.find((x) => x.n === a.chosen);
  if (!t || t.status !== "done") throw new Error(`${assetId} has no finished take to approve.`);
  await store.update((d) => { find(d, assetId).approved = true; });
  await store.log(`${assetId} take ${t.n} approved`);
}

export async function unapprove(ctx, assetId) {
  const { store } = ctx;
  if (!find(store.state, assetId)) throw new Error(`Unknown shot ${assetId}`);
  await store.update((d) => { find(d, assetId).approved = false; });
  await store.log(`${assetId} approval removed`);
}

export async function choose(ctx, assetId, n) {
  const { store } = ctx;
  const a = find(store.state, assetId);
  if (!a) throw new Error(`Unknown shot ${assetId}`);
  if (!a.takes.some((t) => t.n === n)) throw new Error(`${assetId} has no take ${n}.`);
  await store.update((d) => { const x = find(d, assetId); x.chosen = n; x.approved = false; });
  await store.log(`${assetId} take ${n} chosen`);
}
