// Jon on camera: which lines he says to camera (from the script marks, Claude's suggestions or his own
// picks), and one TC asset per chosen line. Later steps add the look, portraits and clips.
import { askJson } from "./claude.js";
import { deriveWaiting } from "./shots.js";
import { scanFilms } from "./films.js";
import { join, filmKey } from "./paths.js";
export { sameLine, onCameraConflict } from "./shots.js";

export const MAX_CLIP_S = 15;
export const TOO_LONG = "Too long for one clip: 15 s at most";

export const scriptCameraIds = (lineScript) => (lineScript?.lines ?? []).filter((l) => l.toCamera).map((l) => l.id);

export const LINES_INSTRUCTIONS = `You choose the lines of a Six Minutes On... documentary film that Jon says face to camera.
You get the line script: [{id, section, text}] in order.
Choose about five lines: one or two near the start, two in the middle, one near the end.
Each is one sentence, spoken in 12 seconds or less (about 30 words). Pick lines that carry the film's voice (a claim, a turn, a question, the sign-off), not lines over maps or data.
Use ids exactly as given, each at most once.
Reply with JSON only: {"lines":[{"id":"<line id>","why":"<one short sentence on why>"}]}.`;

export async function suggestLines(host, lineScript) {
  const lines = lineScript?.lines ?? [];
  const ids = new Set(lines.map((l) => l.id));
  const r = await askJson(host, {
    instructions: LINES_INSTRUCTIONS,
    data: { lines: lines.map(({ id, section, text }) => ({ id, section, text })) },
    tier: "default",
    validate: (v) => {
      const a = v?.lines;
      if (!Array.isArray(a)) throw new Error("lines is missing");
      if (a.length < 3 || a.length > 7) throw new Error(`expected 3 to 7 lines, got ${a.length}`);
      const seen = new Set();
      for (const x of a) {
        if (!x || !ids.has(x.id)) throw new Error(`unknown line id ${x?.id}`);
        if (seen.has(x.id)) throw new Error(`line ${x.id} is listed twice`);
        seen.add(x.id);
      }
    },
  });
  return r.lines.map((x) => ({ id: x.id, why: typeof x.why === "string" ? x.why : "" }));
}

// Spoken length of one line in the voiceover, or null when the transcript has no such sentence.
export function lineLengthS(transcript, id) {
  const s = (transcript?.sentences ?? []).find((x) => x.sentence === id);
  if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end)) return null;
  return s.end - s.start;
}

const busy = (a) => (a.takes ?? []).some((t) => t.status === "queued" || t.status === "running");
const starting = (store, id) => [...(store.pending ?? [])].some((k) => k.startsWith(`${id}#`));
const nextTcId = (d) => {
  const top = [...d.assets, ...(d.removed ?? [])].reduce((m, a) => Math.max(m, Number(/^TC-(\d+)$/.exec(a.id)?.[1] ?? 0)), 0);
  return `TC-${String(top + 1).padStart(2, "0")}`;
};
const firstWords = (t) => {
  const w = String(t ?? "").trim().split(/\s+/).filter(Boolean);
  return w.slice(0, 8).join(" ") + "…";
};

// Make the chosen lines exactly `ids`. opts.from: "script" | "claude" | "jon" for newly added ids
// (default: "script" when the script marks it, else "jon"). The line script comes from ctx.lineScript,
// the transcript (for the 15 s check) from ctx.transcript when present.
export async function setCameraLines(ctx, ids, opts = {}) {
  const { store } = ctx;
  const want = [...new Set(ids)];
  const lines = ctx.lineScript?.lines ?? [];
  const marked = new Set(scriptCameraIds(ctx.lineScript));
  const cur = store.state.presenter?.lines ?? [];
  const have = new Set(cur.map((l) => l.id));
  const added = want.filter((id) => !have.has(id));
  const dropped = cur.filter((l) => !want.includes(l.id)).map((l) => l.id);
  const assetFor = (state, id) => state.assets.find((a) => a.kind === "presenter" && a.lineId === id);

  for (const id of added) {
    if (!lines.some((l) => l.id === id)) throw new Error(`Line ${id} is not in the script.`);
    const len = lineLengthS(ctx.transcript, id);
    if (len != null && len > MAX_CLIP_S) throw new Error(TOO_LONG);
  }
  const check = (state) => {
    for (const id of dropped) {
      const a = assetFor(state, id);
      if (a && (busy(a) || starting(store, a.id))) throw new Error(`${a.id} has a take in progress.`);
    }
  };
  check(store.state);
  await store.update((d) => {
    check(d);
    const p = (d.presenter ??= {});
    const byId = new Map((p.lines ?? []).map((l) => [l.id, l]));
    for (const id of dropped) {
      const a = assetFor(d, id);
      if (!a) continue;
      d.assets = d.assets.filter((x) => x !== a && x.id !== a.id);
      if (a.takes?.length) (d.removed ??= []).push({ ...a, removedAt: ctx.host.now() });
    }
    for (const id of added) {
      const idx = lines.findIndex((l) => l.id === id);
      const line = lines[idx];
      byId.set(id, { id, from: opts.from ?? (marked.has(id) ? "script" : "jon") });
      d.assets.push({
        id: nextTcId(d), kind: "presenter", tool: "higgsfield", lineId: id, line: line.text, lineIndex: idx,
        desc: `On camera: ${firstWords(line.text)}`, takes: [], chosen: 0, approved: false,
      });
    }
    p.lines = want.map((id) => byId.get(id));
    d.waiting = deriveWaiting(d.assets);
  });
}

// The chosen lines against the line script now. A chosen id the script no longer has is `missing`.
export function cameraLineState(state, lineScript) {
  const lines = lineScript?.lines ?? [];
  return (state.presenter?.lines ?? []).map(({ id, from }) => {
    const l = lines.find((x) => x.id === id);
    const a = state.assets.find((x) => x.kind === "presenter" && x.lineId === id);
    return { id, text: l?.text ?? a?.line ?? "", from, missing: !l, assetId: a?.id ?? null };
  });
}

// ---- Look and portraits ----
const filled = (v) => typeof v === "string" && v.trim() !== "";

export const LOOK_INSTRUCTIONS = `You suggest how Jon looks on camera in a Six Minutes On... documentary film.
You get the film's script and, when there is one, the look used in his last film.
Suggest exactly 3 outfits and exactly 3 sets suited to the film's subject.
An outfit is what he wears, in a short phrase (for example "a navy blazer over a white open-neck shirt").
A set is a real-feeling place or interior that suits the topic, calm and uncluttered (a reading room, a workshop, a quiet harbour office), in a short phrase. It will be shown softly out of focus behind him.
Reply with JSON only: {"outfits":["<outfit>","<outfit>","<outfit>"],"sets":["<set>","<set>","<set>"]}.`;

export async function suggestLooks(host, { scriptText, lastLook = null } = {}) {
  const three = (a, what) => {
    if (!Array.isArray(a) || a.length !== 3 || !a.every(filled)) throw new Error(`${what} must be 3 non-empty strings`);
  };
  const r = await askJson(host, {
    instructions: LOOK_INSTRUCTIONS,
    data: { script: scriptText ?? "", lastLook },
    tier: "quick",
    validate: (v) => { three(v?.outfits, "outfits"); three(v?.sets, "sets"); },
  });
  return { outfits: r.outfits.map((x) => x.trim()), sets: r.sets.map((x) => x.trim()) };
}

export async function setLook(ctx, { outfit, set }) {
  const { store, host } = ctx;
  if (!filled(outfit) || !filled(set)) throw new Error("Choose an outfit and a set first");
  await store.update((d) => { (d.presenter ??= {}).look = { outfit: outfit.trim(), set: set.trim(), at: host.now() }; });
}

// The most recent other film's look, or null.
export async function lastLook(host, root, currentFilmDir) {
  const me = filmKey(currentFilmDir);
  let best = null;
  for (const f of await scanFilms(host, root)) {
    if (filmKey(f.dir) === me) continue;
    let look;
    try { look = JSON.parse(await host.fs.read(join(f.dir, "studio", "state.json"), "utf8"))?.presenter?.look; } catch { continue; }
    if (!look || !filled(look.outfit) || !filled(look.set) || !Number.isFinite(look.at)) continue;
    if (!best || look.at > best.at) best = look;
  }
  return best ? { outfit: best.outfit, set: best.set } : null;
}

export const portraitPrompt = ({ outfit, set }) =>
  "Keep this exact man from the reference photos: same face, same bald head, same short grey beard, same age, same eyes and expression; do not change his identity. " +
  "Documentary presenter portrait, framed from mid-chest up, facing the camera directly, shoulders relaxed, arms resting naturally at his sides, hands below the frame. " +
  `He wears ${outfit}. Background: ${set}, strongly out of focus with a shallow depth of field, calm and uncluttered. ` +
  "Warm soft key light on his face from the left, gentle rim light, cinematic, photorealistic, 85mm lens, natural skin texture.";

const PORTRAIT_BUSY = "Portraits are already being made.";

export async function startPortraits(ctx) {
  const { host, store, jobs } = ctx;
  const photos = [];
  for (const p of ctx.settings?.presenter?.photos ?? []) if (filled(p) && (await host.fs.exists(p))) photos.push(p);
  if (!photos.length) throw new Error("Add presenter photos (see Probe)");
  const look = store.state.presenter?.look;
  if (!look || !filled(look.outfit) || !filled(look.set)) throw new Error("Choose an outfit and a set first");
  const isBusy = (h) => busy(h ?? {}) || starting(store, "PORTRAIT");
  if (isBusy(store.state.presenter?.portraits)) throw new Error(PORTRAIT_BUSY);
  const prompt = portraitPrompt(look);
  const n = (store.state.presenter?.portraits?.takes ?? []).length + 1;
  const ns = [n, n + 1];
  const keys = ns.map((x) => `PORTRAIT#${x}`);
  for (const k of keys) store.pending?.add(k);
  try {
    await store.update((d) => {
      const p = (d.presenter ??= {});
      const h = (p.portraits ??= { id: "PORTRAIT", kind: "portrait", tool: "higgsfield", takes: [], chosen: 0, approved: false });
      if (busy(h)) throw new Error(PORTRAIT_BUSY);
      if (h.takes.length !== n - 1) throw new Error("Portraits changed while they were being started.");
      for (const x of ns) h.takes.push({ n: x, prompt, tool: "higgsfield", status: "queued", at: host.now() });
    });
    const ids = [];
    let failure = null;
    for (const x of ns) {
      try {
        ids.push([x, jobs.add({
          film: store.dir, assetId: "PORTRAIT", take: x, tool: "higgsfield", what: "Presenter portrait",
          why: `Portrait ${x}: ${look.outfit}, ${look.set}`,
          input: { kind: "portrait", prompt, photos, out: join(store.dir, "studio", "presenter", `PORTRAIT_t${x}`) },
        })]);
      } catch (e) {
        failure = e;
        const msg = String(e?.message ?? e);
        await store.update((d) => { const t = d.presenter.portraits.takes.find((y) => y.n === x); if (t) { t.status = "failed"; t.error = msg; } });
      }
    }
    await store.update((d) => {
      for (const [x, id] of ids) { const t = d.presenter.portraits.takes.find((y) => y.n === x); if (t && !t.jobId) t.jobId = id; }
    });
    await store.log(`Portraits ${ns.join(" and ")} started`);
    if (failure) throw failure;
  } finally {
    for (const k of keys) store.pending?.delete(k);
  }
}

// Approve a finished portrait as the film's presenter. Finished clips made with another portrait are
// marked stale; a queued or running clip take is left alone (its job input keeps the portrait it started with).
export async function approvePortrait(ctx, n) {
  const { store, host } = ctx;
  const h = store.state.presenter?.portraits;
  const t = h?.takes.find((x) => x.n === n);
  if (!t) throw new Error(`Portrait ${n} doesn't exist: no take ${n}.`);
  if (t.status !== "done" || !t.file || !t.hfId) throw new Error(`Portrait ${n} isn't finished yet.`);
  await store.update((d) => {
    const x = d.presenter.portraits.takes.find((y) => y.n === n);
    d.presenter.portraits.chosen = n;
    d.presenter.portraits.approved = true;
    d.presenter.portrait = { n, hfId: x.hfId, file: x.file, at: host.now() };
    for (const a of d.assets) {
      if (a.kind !== "presenter") continue;
      const ct = (a.takes ?? []).find((y) => y.n === a.chosen);
      if (!ct || ct.status !== "done" || !ct.portraitHfId) continue;
      if (ct.portraitHfId !== x.hfId) a.staleReason = "portrait";
      else if (a.staleReason === "portrait") delete a.staleReason;
    }
  });
  await store.log(`Portrait ${n} approved`);
}
