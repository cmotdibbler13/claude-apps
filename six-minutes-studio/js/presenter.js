// Jon on camera: which lines he says to camera (from the script marks, Claude's suggestions or his own
// picks), and one TC asset per chosen line. Later steps add the look, portraits and clips.
import { askJson } from "./claude.js";
import { deriveWaiting } from "./shots.js";

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
