// Approve Part 2: the facts the handover needs from the film's state, the two small hand-off files and the
// handover markdown. Pure except checkFiles (reads the file system). No Claude calls here: the prose comes in.
import { join } from "./paths.js";
import { part2Readiness, hfJobIdFor } from "./part2.js";
import { onCameraConflict } from "./shots.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export const NO_EPISODE = "Episode: not found in part1_handover.md";
export const MUTE_NOTE = "mute the clip: the voice is already in the voiceover";
const NOT_RECORDED = "not recorded";
const GROUPS = ["Voiceover", "Score", "Sound effects", "Mix preview", "B-roll and art", "On camera"];

const baseOf = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const filled = (v) => typeof v === "string" && v.trim() !== "";
const chosenTake = (h) => (h?.takes ?? []).find((t) => t.n === h.chosen && t.status === "done" && t.file) ?? null;
const clean = (n) => Math.round(n * 100) / 100;

export const openingMessage = (topic, dir) =>
  `Part 3 of Six minutes on… ${topic}. Load /documentary-explainer-video, read ${join(dir, "handover", "part2_handover.md")}, and carry on.`;

// "made locally (Blender): script <path>" or "made locally (ComfyUI): workflow <file>, seed <n>".
function localText(asset, take, jobs) {
  const job = (jobs ?? []).find((j) => j?.id === take?.jobId);
  const comfy = asset.tool === "comfyui";
  if (!comfy) return `made locally (Blender): script ${take.script ?? job?.input?.script ?? NOT_RECORDED}`;
  const l = take.local ?? {};
  const wf = l.workflow ?? take.workflow ?? job?.input?.workflow;
  const seed = l.seed ?? take.seed ?? job?.input?.seed;
  return `made locally (ComfyUI): workflow ${wf ? baseOf(wf) : NOT_RECORDED}, seed ${seed ?? NOT_RECORDED}`;
}

function filesOf(v) {
  if (Array.isArray(v)) return v.filter(filled);
  if (v && typeof v === "object") return Object.values(v).filter(filled);
  return filled(v) ? [v] : [];
}

export function sfxCues(state, jobs) {
  const mixSfx = state?.mix?.mix?.sfx ?? [];
  const fromJob = (jobs ?? []).find((j) => j?.id === state?.mix?.mix?.jobId)?.input?.sfx ?? [];
  const out = [];
  for (const x of state?.audio?.sfx ?? []) {
    if (!x.approved) continue;
    const t = chosenTake(x);
    if (!t) continue;
    const g = mixSfx.find((m) => m.id === x.id);
    const j = fromJob.find((m) => m.id === x.id);
    out.push({
      id: x.id, file: t.file, startS: x.startS == null ? null : Number(x.startS), loop: !!x.loop,
      endS: j?.endS ?? x.endS ?? null, gainDb: g?.gainDb ?? j?.gainDb ?? null,
    });
  }
  return out;
}

export function mixSettings(state, settings = {}, jobs) {
  const mix = state?.mix ?? {};
  const job = (jobs ?? []).find((j) => j?.id === mix.mix?.jobId);
  return {
    mixMusicDb: Number(settings.mixMusicDb ?? DEFAULT_SETTINGS.mixMusicDb),
    mixSfxDb: Number(settings.mixSfxDb ?? DEFAULT_SETTINGS.mixSfxDb),
    ride: job?.input?.ride ?? mix.mix?.ride ?? null,
    voiceover: { wav: mix.voiceover?.wav ?? null, csv: mix.voiceover?.csv ?? null, transcript: mix.voiceover?.transcript ?? null },
    score: { file: mix.fit?.file ?? null, take: state?.audio?.score?.chosen ?? null, measureFile: mix.fit?.measureFile ?? null },
  };
}

export function handoverFacts({ state, dir, root, lineScript, part1, jobs, brIds, settings, transcript }) {
  const st = state ?? {};
  const own = !!lineScript;
  const prefix = lineScript?.name ?? slug(baseOf(dir));
  const film = baseOf(dir);
  const topic = filled(part1?.topic) ? part1.topic : film;
  const episode = filled(part1?.episode) ? part1.episode : null;
  const recordings = own
    ? join(settings?.autocueRecordings ?? DEFAULT_SETTINGS.autocueRecordings, prefix)
    : join(root ?? "", "voice files");
  const warnings = [...part2Readiness(st).warnings];
  if (episode == null) warnings.push(NO_EPISODE);

  const files = [];
  const add = (group, label, path, extra = {}) => { if (filled(path)) files.push({ group, label, path, ...extra }); };
  const ids = [];
  const gen = join(dir, "studio", "handover");

  // Voiceover
  const vo = st.mix?.voiceover ?? {};
  add("Voiceover", "Joined voiceover", vo.wav);
  add("Voiceover", "Timings CSV", vo.csv);
  add("Voiceover", "Word-level transcript", vo.transcript);
  if (own) { add("Voiceover", "Line script", lineScript.path); add("Voiceover", "Takes folder", recordings); }

  // Score
  const sc = st.audio?.score;
  const st1 = chosenTake(sc);
  add("Score", `Chosen score take${sc?.chosen ? ` ${sc.chosen}` : ""}`, st1?.file);
  add("Score", "Score fitted to the film", st.mix?.fit?.file);
  add("Score", "Score timing sheet", st.mix?.fit?.measureFile);
  add("Score", "Mix settings (gain ride and levels)", join(gen, "mix_settings.json"), { extra: true });

  // Sound effects
  for (const x of st.audio?.sfx ?? []) {
    if (!x.approved) continue;
    const t = chosenTake(x);
    add("Sound effects", `${x.id}${x.cue ? ` (${x.cue})` : ""}${x.chosen ? ` take ${x.chosen}` : ""}`, t?.file);
  }
  add("Sound effects", "Sound-effect cues (id, file, film start time, loop/end, gain dB)", join(gen, "sfx_cues.json"), { extra: true });

  // Mix preview
  filesOf(st.mix?.mix?.files).forEach((f) => add("Mix preview", baseOf(f), f));

  // B-roll and art
  const live = (st.assets ?? []).filter((a) => !a.removedAt);
  for (const a of live) {
    if (a.kind === "presenter" || onCameraConflict(a, st) || !a.approved) continue;
    const t = chosenTake(a);
    const br = brIds?.get?.(a.id);
    const bits = [br ? `${a.id} (${br})` : a.id, a.line ? `line ${a.line}` : null, a.kind, a.tool].filter(Boolean);
    add("B-roll and art", bits.join(", "), t?.file);
    if (t) {
      if (a.tool === "higgsfield") ids.push({ label: `${a.id} take ${t.n}`, value: hfJobIdFor(t, jobs) ?? NOT_RECORDED });
      else ids.push({ label: `${a.id} take ${t.n}`, value: localText(a, t, jobs) });
    }
  }

  // On camera
  const sentences = transcript?.sentences ?? [];
  for (const a of live) {
    if (a.kind !== "presenter" || !a.approved) continue;
    const t = chosenTake(a);
    const s = sentences.find((x) => x.sentence === a.lineId);
    const when = s && Number.isFinite(s.start) && Number.isFinite(s.end) ? `, film time ${clean(s.start)}–${clean(s.end)} s` : "";
    add("On camera", `${a.id}, line ${a.lineId ?? a.line ?? "?"}${when}`, t?.file, { note: MUTE_NOTE });
    if (t) ids.push({ label: `${a.id} take ${t.n}`, value: hfJobIdFor(t, jobs) ?? NOT_RECORDED });
  }
  const pt = st.presenter?.portrait;
  if (pt?.file) {
    add("On camera", "Approved portrait", pt.file);
    ids.push({ label: "Portrait", value: pt.hfId ?? NOT_RECORDED });
  }

  // ElevenLabs
  const flow = st.audio?.flowId;
  if (flow) ids.push({ label: "ElevenLabs flow", value: flow });
  if (sc?.node?.id) ids.push({ label: "Score node", value: sc.node.id });
  for (const x of st.audio?.sfx ?? []) if (x.approved && x.node?.id) ids.push({ label: `${x.id} node`, value: x.node.id });

  // Usage: every take of this film, failed ones too, per tool.
  const counts = new Map();
  const count = (tool, n) => { if (n) counts.set(tool || "unknown", (counts.get(tool || "unknown") ?? 0) + n); };
  for (const a of st.assets ?? []) for (const t of a.takes ?? []) count(t.tool ?? a.tool, 1);
  for (const t of st.presenter?.portraits?.takes ?? []) count(t.tool ?? "higgsfield", 1);
  if (sc) for (const t of sc.takes ?? []) count(t.source ?? t.tool ?? "elevenlabs", 1);
  for (const x of st.audio?.sfx ?? []) for (const t of x.takes ?? []) count(t.source ?? t.tool ?? "elevenlabs", 1);
  const usage = [...counts].map(([tool, takes]) => ({ tool, takes })).sort((a, b) => a.tool.localeCompare(b.tool));

  files.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  return { project: { film, topic, prefix, episode, folder: dir }, voice: { kind: own ? "own" : "cloned", recordings }, files, ids, usage, warnings };
}

// Every file the handover points at must exist (the two hand-off files are written afterwards: marked `extra`).
export async function checkFiles(host, files) {
  for (const f of files ?? []) {
    if (f.extra) continue;
    if (!(await host.fs.exists(f.path))) throw new Error(`Missing file: ${f.path}`);
  }
}

export function renderHandover(facts, prose = {}) {
  const { project: p, voice: v } = facts;
  const out = [];
  const bullets = (xs, none) => (xs?.length ? xs.map((x) => `- ${x}`) : [`- ${none}`]);
  out.push(`# Part 2 handover: Six minutes on… ${p.topic}`, "");
  out.push("## Project details", "");
  out.push(`- Film: ${p.film}`, `- File prefix: ${p.prefix}`, p.episode ? `- Episode: ${p.episode}` : `- ${NO_EPISODE}`, `- Folder: ${p.folder}`, "");
  out.push("## Voice choice", "");
  out.push(v.kind === "own" ? "- Own voice (Autocue Studio)" : "- Cloned voice (VoiceStudio)", `- Recordings folder: ${v.recordings}`, "");
  out.push("## His decisions", "", ...bullets(prose.decisions, "None recorded."), "");
  out.push("## File index", "");
  for (const g of GROUPS) {
    const rows = facts.files.filter((f) => f.group === g);
    if (!rows.length) continue;
    out.push(`### ${g}`, "");
    for (const f of rows) out.push(`- ${f.label}: ${f.path}${f.note ? ` (${f.note})` : ""}`);
    out.push("");
  }
  out.push("## Settings and IDs", "", ...bullets(facts.ids.map((i) => `${i.label}: ${i.value}`), "None."), "");
  const open = [...(prose.openItems ?? []), ...facts.warnings.filter((w) => !(prose.openItems ?? []).includes(w))];
  out.push("## Open items", "", ...bullets(open, "None."), "");
  out.push("## Usage", "", ...bullets(facts.usage.map((u) => `${u.tool}: ${u.takes} ${u.takes === 1 ? "take" : "takes"}`), "No takes."), "");
  out.push("## Opening message", "", "```", openingMessage(p.topic, p.folder), "```", "");
  return out.join("\n");
}
