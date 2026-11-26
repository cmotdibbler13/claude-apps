// Music and sound effects: plan the score and cues, edit them, get ElevenLabs costs, start takes, approvals.
// Takes follow the b-roll rules: added, never replaced. Nothing paid starts without a current estimate.
import { askJson } from "./claude.js";
import { join } from "./paths.js";
import { projectOf } from "./audio.js";
import { nodeSig, ensureFlow, addNode, estimate } from "./tools/elevenlabs.js";

export const PLAN_INSTRUCTIONS = `You plan the music and sound effects for a Six Minutes On... documentary film (dark, calm, precise, British English).
You get the narration script, its word count, an estimated narration length in seconds, and the Part 1 handover (part1_handover.md).

The score: one instrumental piece for the whole film.
- Write one prompt for a music generator: the style, the instruments, the tempo (bpm), then "Energy arc:" followed by timed sections as mm:ss, for example "Energy arc: 0:00 sparse low drone; 0:06 pulse enters; 2:40 builds; 5:50 resolves under the end card".
- Time the sections from estimated times: the script read at about 150 words a minute, after a 6 second cold-open hold, with the end card at the finish.
- durationS is the whole film in seconds (the 6 second hold, the narration and the end card), a whole number from 3 to 600.
- No vocals and no lyrics.

The sound effects: one cue for each sound effect on the approved list in the handover, in the order given there (it may be prose or a table). Do not add cues that are not on the list.
- cue: a short name for the sound, two to four words, for example "door creak".
- prompt: one plain description of the sound for a sound-effect generator: the source, the space and the character, for example "an old wooden door creaks slowly open in a quiet stone hallway". No music, no speech.
- durationS: a whole number of seconds from 1 to 30.
- lineId: the line the cue sits under, as an id from the line script or handover such as "05.2", or null when you cannot tell.
- loop: true only for ambience (a bed of sound that runs under a scene, such as wind, rain or a room tone); false for everything else.

Reply with JSON only: {"score": {"prompt": "...", "durationS": 0}, "sfx": [{"cue": "...", "prompt": "...", "durationS": 0, "lineId": "05.2", "loop": false}]}.`;

const REWRITE_INSTRUCTIONS = `You improve one music or sound-effect generation prompt for a Six Minutes On... documentary film (dark, calm, precise, British English).
You get the item (id, cue, kind, length in seconds, loop), the previous prompt and Jon's note. Change the previous prompt to follow the note and keep everything else the same.
For the score keep the style, instruments, tempo and the "Energy arc:" timings unless the note asks to change them. Keep it instrumental.
For a sound effect keep it a plain description of one sound, with no music or speech.
Reply with JSON only: {"prompt": "<the new prompt>"}.`;

const SOURCES = ["stableaudio", "elevenlabs"];
const SOURCE_LABEL = { stableaudio: "Stable Audio", elevenlabs: "ElevenLabs" };
const SCORE_RANGE = [3, 600];
const SFX_RANGE = [1, 30];

const filled = (v) => typeof v === "string" && v.trim() !== "";
const isScore = (id) => id === "SCORE";
const kindOf = (id) => (isScore(id) ? "score" : "sfx");
const sourceOf = (item) => (isScore(item.id) ? "elevenlabs" : item.source);
const labelOf = (item) => (isScore(item.id) ? "Score" : `${item.id} ${item.cue}`);
const busy = (item) => (item.takes ?? []).some((t) => t.status === "queued" || t.status === "running");
const starting = (store, id) => [...(store.pending ?? [])].some((k) => k.startsWith(`${id}#`));
const lastSeg = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? "";
const words = (s) => String(s ?? "").split(/\s+/).filter(Boolean).length;

export function cueSlug(cue) {
  return String(cue ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

function findItem(state, id) {
  const a = state.audio;
  if (!a) return undefined;
  return isScore(id) ? a.score ?? undefined : (a.sfx ?? []).find((x) => x.id === id);
}
function need(state, id) {
  const item = findItem(state, id);
  if (!item) throw new Error(`Unknown cue ${id}`);
  return item;
}
function notBusy(store, item) {
  if (busy(item) || starting(store, item.id)) throw new Error(`${labelOf(item)} has a take in progress.`);
}

const inRange = (n, [lo, hi]) => Number.isFinite(n) && n >= lo && n <= hi;
function length(id, v) {
  if (v == null || v === "") return null; // "Set a length first." when it is needed
  const n = Math.round(Number(v));
  const range = isScore(id) ? SCORE_RANGE : SFX_RANGE;
  if (!inRange(n, range)) {
    throw new Error(isScore(id) ? "The score must be 3 to 600 seconds long." : "A sound effect must be 1 to 30 seconds long.");
  }
  return n;
}

const LINE_ID = /^\d+(\.\d+)?$/;
const FILM_OFFSET_S = 6; // the cold-open hold: film time = voiceover time + 6
function lineId(v) {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !LINE_ID.test(v.trim())) throw new Error("A line id looks like 05 or 05.2.");
  return v.trim();
}
const STARTS_AT = "Starts at needs a time like 1:05.3, 1:05 or 65 seconds.";
// "m:ss.s", "m:ss", or seconds (number or numeric string). "" or null clears it.
export function parseStart(v) {
  if (v == null || (typeof v === "string" && v.trim() === "")) return null;
  let n;
  if (typeof v === "number") n = v;
  else {
    const t = String(v).trim();
    const m = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(t);
    if (m) n = Number(m[1]) * 60 + Number(m[2]);
    else if (/^\d+(\.\d+)?$/.test(t)) n = Number(t);
    else throw new Error(STARTS_AT);
  }
  if (!Number.isFinite(n) || n < 0) throw new Error(STARTS_AT);
  return n;
}
export function formatStart(s) {
  if (s == null || !Number.isFinite(Number(s))) return "";
  const tenths = Math.round(Number(s) * 10);
  const m = Math.floor(tenths / 600);
  const rest = (tenths - m * 600) / 10;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

const newItem = (id, cue, prompt, durationS, extra = {}) => ({
  id, cue, prompt, durationS, ...extra, takes: [], chosen: null, approved: false, node: null, est: null,
});

function validatePlan(v) {
  if (!v || typeof v !== "object") throw new Error("reply is not an object");
  const s = v.score;
  if (!s || !filled(s.prompt)) throw new Error("score prompt is empty");
  if (!/Energy arc:/i.test(s.prompt)) throw new Error("score prompt has no energy arc");
  if (!inRange(Number(s.durationS), SCORE_RANGE)) throw new Error("score length is not 3 to 600 seconds");
  if (!Array.isArray(v.sfx)) throw new Error("sfx is not a list");
  v.sfx.forEach((c, i) => {
    if (!c || !filled(c.cue) || !filled(c.prompt)) throw new Error(`cue ${i + 1} has no name or prompt`);
    if (!inRange(Number(c.durationS), SFX_RANGE)) throw new Error(`cue ${i + 1} length is not 1 to 30 seconds`);
    if (c.loop !== undefined && typeof c.loop !== "boolean") throw new Error(`cue ${i + 1} loop is not true or false`);
    try { lineId(c.lineId); } catch { throw new Error(`cue ${i + 1} lineId is not a line id or null`); }
  });
}

const planned = (state) => !!state.audio && (!!state.audio.score || (state.audio.sfx ?? []).length > 0);
const ALREADY = "Music and sound effects are already planned.";

export async function planAudio(host, store, { scriptText, handoverText }) {
  if (planned(store.state)) throw new Error(ALREADY);
  const n = words(scriptText);
  const r = await askJson(host, {
    instructions: PLAN_INSTRUCTIONS,
    data: { script: scriptText ?? "", scriptWords: n, narrationS: Math.round((n / 150) * 60), handover: handoverText ?? "" },
    tier: "default",
    validate: validatePlan,
  });
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(Number(v))));
  await store.update((d) => {
    if (planned(d)) throw new Error(ALREADY);
    d.audio = {
      flowId: d.audio?.flowId ?? null,
      score: newItem("SCORE", "Score", r.score.prompt.trim(), clamp(r.score.durationS, SCORE_RANGE)),
      sfx: r.sfx.map((c, i) => newItem(`SFX-${String(i + 1).padStart(2, "0")}`, c.cue.trim(), c.prompt.trim(),
        clamp(c.durationS, SFX_RANGE), { loop: c.loop === true, source: "stableaudio", lineId: lineId(c.lineId), startS: null })),
    };
  });
  await store.log(`Music and sound effects planned (${r.sfx.length} cues)`);
}

export async function addCue(store, { cue, prompt, durationS } = {}) {
  if (!filled(cue)) throw new Error("Give the cue a name.");
  const secs = length("SFX", durationS);
  let id;
  await store.update((d) => {
    d.audio ??= { flowId: null, score: null, sfx: [] };
    d.audio.sfx ??= [];
    const top = d.audio.sfx.reduce((m, x) => Math.max(m, Number(/^SFX-(\d+)$/.exec(x.id)?.[1] ?? 0)), 0);
    id = `SFX-${String(top + 1).padStart(2, "0")}`;
    d.audio.sfx.push(newItem(id, cue.trim(), filled(prompt) ? prompt.trim() : "", secs, { loop: false, source: "stableaudio", lineId: null, startS: null }));
  });
  await store.log(`${id} added: ${cue.trim()}`);
  return id;
}

// Start time and line can change while a take is busy: they don't change the take itself.
const ANY_TIME = new Set(["startS", "lineId"]);
export async function editItem(store, id, patch = {}) {
  const item = need(store.state, id);
  const guarded = Object.keys(patch).some((k) => patch[k] !== undefined && !ANY_TIME.has(k));
  if (guarded) notBusy(store, item);
  const next = {};
  if (patch.prompt !== undefined) next.prompt = String(patch.prompt);
  if (patch.durationS !== undefined) next.durationS = length(id, patch.durationS);
  if (patch.loop !== undefined) {
    if (isScore(id)) throw new Error("The score has no loop setting.");
    next.loop = !!patch.loop;
  }
  if (patch.source !== undefined) {
    if (!SOURCES.includes(patch.source)) throw new Error(`${patch.source} is not a sound source.`);
    if (isScore(id) && patch.source !== "elevenlabs") throw new Error("The score is made on ElevenLabs.");
    if (!isScore(id)) next.source = patch.source;
  }
  if (patch.lineId !== undefined) {
    if (isScore(id)) throw new Error("The score has no line.");
    next.lineId = lineId(patch.lineId);
  }
  let startSet = false;
  if (patch.startS !== undefined) {
    if (isScore(id)) throw new Error("The score runs from the start of the film.");
    next.startS = parseStart(patch.startS);
    startSet = true;
  }
  // Jon typing the proposed time again makes it his, so a later proposal leaves it alone.
  const claim = startSet && next.startS != null && item.startSBy !== "jon";
  const changes = Object.keys(next).filter((k) => next[k] !== item[k]);
  if (!changes.length && !claim) return;
  await store.update((d) => {
    const x = need(d, id);
    if (guarded) notBusy(store, x);
    for (const k of changes) x[k] = next[k];
    if (startSet) { if (next.startS == null) delete x.startSBy; else x.startSBy = "jon"; }
    if (changes.includes("prompt")) delete x.pendingNote; // the note was for the rewritten prompt
    if (changes.some((k) => k === "prompt" || k === "durationS" || k === "loop")) x.est = null;
  });
  if (!changes.length) { await store.log(`${labelOf(item)}: start time kept as yours`); return; }
  const what = changes.map((k) => (k === "startS" ? (next.startS == null ? "start time cleared" : `starts at ${formatStart(next.startS)}`) : k === "lineId" ? "line changed" : k === "source" ? `now uses ${SOURCE_LABEL[next.source]}` : k === "durationS" ? "length changed" : k === "loop" ? `loop ${next.loop ? "on" : "off"}` : "prompt edited"));
  await store.log(`${labelOf(item)}: ${what.join(", ")}`);
}

// Fill start times from the voiceover timings: the cue's clip start plus the 6 second hold.
// Only cues with a line id whose clip is in the timings, and never one Jon set himself. Returns the ids filled.
export async function proposeStarts(store, timingsRows, lineScript) {
  void lineScript; // the line id alone names the clip; the script is accepted for callers that hold it
  const starts = new Map();
  for (const r of timingsRows ?? []) {
    const clip = String(r?.clip ?? "");
    const t = Number(r?.start_s);
    if (!clip || !Number.isFinite(t)) continue;
    if (!starts.has(clip) || t < starts.get(clip)) starts.set(clip, t);
  }
  const done = [];
  await store.update((d) => {
    for (const x of d.audio?.sfx ?? []) {
      if (!x.lineId || x.startSBy === "jon") continue;
      const t = starts.get(String(x.lineId).split(".")[0]);
      if (t === undefined) continue;
      x.startS = Math.round((t + FILM_OFFSET_S) * 1000) / 1000;
      done.push(x.id);
    }
  });
  if (done.length) await store.log(`Start times proposed for ${done.join(", ")}`);
  return done;
}

// One flow per film, made on first use. Concurrent callers share the one request.
const flowing = new WeakMap();
async function flowFor(host, store) {
  if (store.state.audio?.flowId) return store.state.audio.flowId;
  if (!flowing.has(store)) {
    const p = (async () => {
      const id = await ensureFlow(host, `${lastSeg(store.dir)} — score and SFX`);
      await store.update((d) => { d.audio ??= { flowId: null, score: null, sfx: [] }; d.audio.flowId ??= id; });
      return store.state.audio.flowId;
    })().finally(() => flowing.delete(store));
    flowing.set(store, p);
  }
  return flowing.get(store);
}

// Credits for ONE take of exactly the item's current prompt, length and loop.
// A second call while one is running for the same item shares it, so a double click adds one node.
const estimating = new WeakMap();
export function getEstimate(ctx, id) {
  const { store } = ctx;
  if (!estimating.has(store)) estimating.set(store, new Map());
  const running = estimating.get(store);
  if (!running.has(id)) running.set(id, estimateOnce(ctx, id).finally(() => running.delete(id)));
  return running.get(id);
}

async function estimateOnce(ctx, id) {
  const { host, store } = ctx;
  const item = need(store.state, id);
  if (sourceOf(item) !== "elevenlabs") throw new Error(`${labelOf(item)} uses Stable Audio, which is free.`);
  if (!filled(item.prompt)) throw new Error("Write a prompt first.");
  const kind = kindOf(id);
  const sig = nodeSig(kind, item); // throws "Set a length first."
  const flowId = await flowFor(host, store);
  let node = need(store.state, id).node;
  if (!node || node.sig !== sig) {
    const nodeId = await addNode(host, flowId, kind, item, labelOf(item));
    node = { id: nodeId, sig };
    await store.update((d) => { need(d, id).node = node; });
  }
  const credits = await estimate(host, flowId, node.id);
  if (credits == null) throw new Error("ElevenLabs didn't say what this would cost. Try Get the cost again.");
  await store.update((d) => {
    const x = need(d, id);
    if (nodeSig(kind, x) !== sig) throw new Error(`${labelOf(item)} changed while getting the cost. Get the cost again.`);
    x.est = { credits, sig };
  });
  await store.log(`${labelOf(item)}: about ${credits} credits a take`);
  return credits;
}

// Rewrite the prompt from Jon's note. The saved prompt makes any estimate stale; the note waits on the item.
export async function rewriteFromNote(ctx, id, note) {
  const { host, store } = ctx;
  if (!filled(note)) throw new Error("Write a note first.");
  const item = need(store.state, id);
  notBusy(store, item);
  const r = await askJson(host, {
    instructions: REWRITE_INSTRUCTIONS,
    data: {
      item: { id: item.id, cue: item.cue, kind: kindOf(id), durationS: item.durationS, loop: !!item.loop },
      previousPrompt: item.prompt,
      note,
    },
    tier: "quick",
    validate: (v) => { if (!v || !filled(v.prompt)) throw new Error("prompt is empty"); },
  });
  await store.update((d) => {
    const x = need(d, id);
    notBusy(store, x);
    x.prompt = r.prompt.trim();
    x.est = null;
    x.pendingNote = note;
  });
  await store.log(`${labelOf(item)}: prompt rewritten from your note "${note}"`);
  return r.prompt.trim();
}

export async function startAudioTake(ctx, id, { note, count = 1 } = {}) {
  const { store, jobs } = ctx;
  let item = need(store.state, id);
  if (!Number.isInteger(count) || count < 1) throw new Error("The number of takes must be a whole number.");
  if (count > 1 && !isScore(id)) throw new Error("Only the score makes more than one take at a time.");
  notBusy(store, item);
  const source = sourceOf(item);
  if (!SOURCES.includes(source)) throw new Error(`${labelOf(item)} has no sound source.`);
  const kind = kindOf(id);

  let takeNote;
  if (filled(note)) {
    await rewriteFromNote(ctx, id, note);
    // An ElevenLabs take needs the cost of the new prompt shown first.
    if (source === "elevenlabs") throw new Error("Get the cost first.");
    takeNote = note;
    item = need(store.state, id);
    notBusy(store, item); // another take may have started while the prompt was rewritten
  } else if (filled(item.pendingNote)) takeNote = item.pendingNote;

  const flowId = store.state.audio.flowId;
  if (!filled(item.prompt)) throw new Error("Write a prompt first.");
  let sig = null;
  if (source === "elevenlabs") {
    sig = nodeSig(kind, item); // throws "Set a length first."
    if (!flowId || item.est?.sig !== sig || item.node?.sig !== sig || !item.node?.id) throw new Error("Get the cost first.");
  } else if (item.durationS == null || !Number.isFinite(Number(item.durationS))) throw new Error("Set a length first.");

  const first = item.takes.length + 1;
  const ns = Array.from({ length: count }, (_, i) => first + i);
  const media = join(store.dir, "studio", "media");
  const project = projectOf(store.dir);
  const stem = (n) => (isScore(id) ? `${project}_score_t${n}` : `${project}_sfx_${id.toLowerCase()}${cueSlug(item.cue) ? "_" + cueSlug(item.cue) : ""}_t${n}`);
  for (const n of ns) {
    const base = join(media, stem(n));
    const paths = source === "elevenlabs" ? [base + ".mp3", base + ".wav", base + ".orig.mp3", base + ".orig.wav"] : [base + ".wav"];
    for (const f of paths) {
      if (await ctx.host.fs.exists(f)) throw new Error(`A file for ${labelOf(item)} take ${n} is already there; not replacing it.`);
    }
  }
  const inputFor = (n) => (source === "elevenlabs"
    ? { kind, flowId, nodeId: item.node.id, out: join(media, stem(n)), sfx: kind === "sfx" }
    : { prompt: item.prompt, seconds: Math.round(Number(item.durationS)), out: join(media, stem(n) + ".wav") });
  const at = ctx.host.now();
  const takes = ns.map((n) => {
    const t = { n, source, prompt: item.prompt, status: "queued", at };
    if (takeNote) t.note = takeNote;
    return t;
  });

  const keys = ns.map((n) => `${id}#${n}`);
  for (const k of keys) store.pending?.add(k);
  const release = () => { for (const k of keys) store.pending?.delete(k); };
  try {
    await store.update((d) => {
      const x = need(d, id);
      if (x.takes.length !== first - 1 || x.prompt !== item.prompt) throw new Error(`${labelOf(item)} changed while the take was being prepared.`);
      if (sig && (x.est?.sig !== sig || x.node?.sig !== sig)) throw new Error("Get the cost first.");
      x.takes.push(...structuredClone(takes));
      x.chosen = ns[ns.length - 1];
      x.approved = false;
      delete x.pendingNote;
    });
  } catch (e) { release(); throw e; }

  const ids = new Map();
  try {
    for (const n of ns) {
      ids.set(n, jobs.add({
        film: store.dir, assetId: id, take: n, tool: source,
        what: `${labelOf(item)} take ${n}`,
        why: takeNote ? `Take ${n}, from your note "${takeNote}"` : n === 1 ? "First take" : `Take ${n}`,
        input: inputFor(n),
      }));
    }
  } catch (e) {
    const msg = String(e?.message ?? e);
    const lost = ns.filter((n) => !ids.has(n));
    await store.update((d) => {
      const x = need(d, id);
      for (const n of lost) {
        const t = x.takes.find((y) => y.n === n);
        if (t) { t.status = "failed"; t.error = msg; }
      }
      for (const [n, jobId] of ids) { const t = x.takes.find((y) => y.n === n); if (t && !t.jobId) t.jobId = jobId; }
    });
    for (const n of lost) await store.log(`${labelOf(item)} take ${n} failed: ${msg}`);
    throw e;
  } finally {
    release();
  }
  await store.update((d) => {
    const x = need(d, id);
    for (const [n, jobId] of ids) { const t = x.takes.find((y) => y.n === n); if (t && !t.jobId) t.jobId = jobId; }
  });
  for (const n of ns) await store.log(`${labelOf(item)} take ${n} started${takeNote ? `: ${takeNote}` : ""}`);
  return ns;
}

export async function approveAudio(ctx, id) {
  const { store } = ctx;
  const item = need(store.state, id);
  const t = item.takes.find((x) => x.n === item.chosen);
  if (!t || t.status !== "done") throw new Error(`${labelOf(item)} has no finished take to approve.`);
  await store.update((d) => { need(d, id).approved = true; });
  await store.log(`${labelOf(item)} take ${t.n} approved`);
}

export async function unapproveAudio(ctx, id) {
  const { store } = ctx;
  const item = need(store.state, id);
  await store.update((d) => { need(d, id).approved = false; });
  await store.log(`${labelOf(item)} approval removed`);
}

export async function chooseAudio(ctx, id, n) {
  const { store } = ctx;
  const item = need(store.state, id);
  if (!item.takes.some((t) => t.n === n)) throw new Error(`${labelOf(item)} has no take ${n}.`);
  await store.update((d) => { const x = need(d, id); x.chosen = n; x.approved = false; });
  await store.log(`${labelOf(item)} take ${n} chosen`);
}
