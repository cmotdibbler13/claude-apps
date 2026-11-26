// Build the shot list from the script and the part 1 handover.
import { askJson, ClaudeError } from "./claude.js";

export const SHOT_INSTRUCTIONS = `You plan the visuals for a Six Minutes On... documentary film, in Jon's channel voice: dark, calm, precise, British English.
From the script and the part 1 handover below, make a shot list. Answer with a JSON array of shots:
[{"id","kind","line","lineIndex","desc","tool","sourceId","prompt"}]
- id: any unique label; it is renumbered afterwards.
- kind: "broll", "lineart" or "blender".
- line: the script line the shot covers, copied exactly. lineIndex: that line's zero-based position in the script.
- desc: one short sentence saying what the viewer sees.
- tool rule: Higgsfield makes filmed-looking b-roll (kind "broll") and 2D line art (kind "lineart"), so tool is "higgsfield". Blender makes 3D line-art versions of approved line art and 3D models of a place (kind "blender"), so tool is "blender".
- A "blender" shot must give sourceId: the id of a "lineart" shot in your list. Other shots have no sourceId.
- prompt: the generation prompt, never empty. For "lineart" shots use exactly this formula: "Elegant scientific line illustration of <subject>, fine single-weight <amber #e3a64a | white> ink lines on a pure black background, no fill, no shading, no text, no frame, isolated, generous margin." Choose amber or white.
Cover the whole script in order.`;

const KINDS = ["broll", "lineart", "blender"];
const TOOLS = ["higgsfield", "blender"];
const filled = (v) => typeof v === "string" && v.trim() !== "";

const shots = (n) => `${n} shot${n === 1 ? "" : "s"}`;

// What the film is waiting on Jon for, from its shots. Written in the same update as every change to them.
export function deriveWaiting(assets = []) {
  if (!assets.length) return "Shot list not made yet";
  const chosen = (a) => a.takes?.find((t) => t.n === a.chosen) ?? null;
  const busy = (a) => (a.takes ?? []).some((t) => t.status === "queued" || t.status === "running");
  const review = assets.filter((a) => !a.approved && chosen(a)?.status === "done").length;
  const redo = assets.filter((a) => !busy(a) && ["failed", "interrupted"].includes(chosen(a)?.status)).length;
  const parts = [];
  if (review) parts.push(`${shots(review)} to review`);
  if (redo) parts.push(`${shots(redo)} need${redo === 1 ? "s" : ""} a redo`);
  if (parts.length) return parts.join(", ");
  if (assets.some(busy)) return null; // running, not waiting on Jon
  if (assets.every((a) => a.approved)) return "All shots approved";
  const start = assets.filter((a) => !a.approved && !(a.takes ?? []).length).length;
  return start ? `${shots(start)} to start` : null;
}

export function orderByScript(assets) {
  return [...assets].sort((a, b) => a.lineIndex - b.lineIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function validateShots(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("expected a non-empty array of shots");
  const byId = new Map();
  list.forEach((s, i) => {
    const at = `shot ${i + 1}`;
    if (!s || typeof s !== "object") throw new Error(`${at} is not an object`);
    if (!filled(s.id)) throw new Error(`${at} has no id`);
    if (byId.has(s.id)) throw new Error(`${at} repeats id ${s.id}`);
    byId.set(s.id, s);
    if (!KINDS.includes(s.kind)) throw new Error(`${at} has a bad kind`);
    if (!filled(s.line)) throw new Error(`${at} has no line`);
    if (!Number.isInteger(s.lineIndex) || s.lineIndex < 0) throw new Error(`${at} has a bad lineIndex`);
    if (!filled(s.desc)) throw new Error(`${at} has no desc`);
    if (!TOOLS.includes(s.tool)) throw new Error(`${at} has a bad tool`);
    if (!filled(s.prompt)) throw new Error(`${at} has no prompt`);
    if ((s.kind === "blender") !== (s.tool === "blender")) throw new Error(`${at} tool does not match kind`);
  });
  for (const s of list) {
    if (s.kind !== "blender") continue;
    const src = byId.get(s.sourceId);
    if (!src || src.kind !== "lineart") throw new Error(`blender shot ${s.id} needs a lineart source shot`);
  }
}

export async function buildShotList(host, store, { scriptText, handoverText }) {
  if (store.state.assets.length) throw new ClaudeError("exists", "This film already has a shot list.");
  const list = await askJson(host, {
    instructions: SHOT_INSTRUCTIONS,
    data: { script: scriptText, handover: handoverText },
    tier: "default",
    validate: validateShots,
  });
  const ordered = orderByScript(list);
  const newId = new Map(ordered.map((s, i) => [s.id, `HF-${String(i + 1).padStart(2, "0")}`]));
  const assets = ordered.map((s) => {
    const a = {
      id: newId.get(s.id), kind: s.kind, line: s.line, lineIndex: s.lineIndex, desc: s.desc,
      tool: s.tool, draftPrompt: s.prompt, takes: [], chosen: 0, approved: false,
    };
    if (s.kind === "blender") a.sourceId = newId.get(s.sourceId);
    return a;
  });
  await store.update((d) => {
    if (d.assets.length) throw new ClaudeError("exists", "This film already has a shot list.");
    d.assets = assets;
    d.waiting = deriveWaiting(assets);
  });
  await store.log(`Shot list made: ${assets.length} shots`);
  return assets;
}
