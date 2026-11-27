// Part 2 prose from Claude: Part 1 facts, library entry descriptions, handover decisions and open items.
// Every answer is validated before use; tier "default".
import { askJson } from "./claude.js";
import { withClaudeFields } from "./library.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export const PART1_INSTRUCTIONS = `You read the Part 1 handover of a Six Minutes On... documentary film.
Find the film's subject as in "Six minutes on... <Topic>" (just the Topic, as written) and the episode number if one is given (digits only).
Use null for anything the text doesn't state. Do not guess.
Reply with JSON only: {"topic": string or null, "episode": string of 1 to 4 digits or null}.`;

export async function part1Facts(host, text) {
  const r = await askJson(host, {
    instructions: PART1_INSTRUCTIONS,
    data: { text },
    tier: "default",
    validate: (v) => {
      if (!isObj(v)) throw new Error("Claude's answer is not an object.");
      if (v.topic !== null && (typeof v.topic !== "string" || !v.topic.trim())) throw new Error("topic must be a non-empty string or null.");
      if (v.episode !== null && !(typeof v.episode === "string" && /^\d{1,4}$/.test(v.episode))) throw new Error("episode must be 1 to 4 digits or null.");
      if (!("topic" in v) || !("episode" in v)) throw new Error("topic and episode are both needed.");
    },
  });
  return { topic: r.topic, episode: r.episode };
}

export const LIBRARY_INSTRUCTIONS = `You write the descriptive fields of B-roll library catalogue entries for Jon's Six Minutes On... films. British English, plain.
You get items: [{key, kind ("approved" or "rejected"), shot, desc, prompt, line, tool, model, aspect, probe {width, height, fps}, note}]. desc is the shot's description, line the narration line it sits under, note Jon's redo note for that take (may be empty).
Answer once per item, using its key exactly, every key exactly once. For each give: description, setting, period, tags, notes. Nothing else.
Reuse rules (from the library's README):
- description: one plain sentence saying what the shot shows, so Jon can find it again. Rejected rows: a short description.
- setting: where it is, in general terms ("a living room", "a harbour"). Never name a specific real place.
- period: match the period the shot looks like ("1970s", "present day"). Rejected rows may have "" for setting and period.
- tags: lower-case, non-empty strings. Approved: 8 to 12 tags. Rejected: 1 to 6 tags, and the last tag must be "rejected".
- notes, approved: start with the maker and format using the values given, exactly like "Higgsfield Kling 3.0 pro, 16:9, 1920x1080 24 fps, sound off." (that is "<maker> <model>, <aspect>, <width>x<height> <fps> fps, sound off."), then any caveats from Jon's note, then, where the shot shows a place, a building or a person, "Illustrative: never caption it as a real place or person."
- notes, rejected: "Rejected: " followed by Jon's redo note for that take, or "not chosen in review" when there is none.
Reply with JSON only: {"items":[{"key","description","setting","period","tags":[...],"notes"}]}.`;

export async function libraryFields(host, items) {
  const status = new Map(items.map((i) => [i.key, i.kind === "approved" ? "approved" : "rejected"]));
  const r = await askJson(host, {
    instructions: LIBRARY_INSTRUCTIONS,
    data: { items },
    tier: "default",
    validate: (v) => {
      if (!isObj(v) || !Array.isArray(v.items)) throw new Error("items is missing.");
      const seen = new Set();
      for (const f of v.items) {
        if (!isObj(f) || !status.has(f.key)) throw new Error(`unknown item key ${f?.key}.`);
        if (seen.has(f.key)) throw new Error(`item ${f.key} is listed twice.`);
        seen.add(f.key);
        const { key, ...rest } = f;
        try { withClaudeFields({ status: status.get(key) }, rest); } catch (e) { throw new Error(`${key}: ${e.message}`); }
      }
      const missing = [...status.keys()].filter((k) => !seen.has(k));
      if (missing.length) throw new Error(`missing items: ${missing.join(", ")}.`);
    },
  });
  return new Map(r.items.map(({ key, ...rest }) => [key, rest]));
}

export const HANDOVER_INSTRUCTIONS = `You write two lists for the Part 2 handover of a Six Minutes On... film, which Jon hands to the next stage.
You get: notes [{id, take, note}] (Jon's own redo and pacing notes), choices (short strings of what he picked or approved) and warnings (things the checks flagged).
"His decisions": what Jon decided, one short line each, from the choices and his notes.
"Open items": what is still unresolved or needs a look next, one short line each, from the warnings and any note that asks for something.
British English, plain. Use Jon's words where possible: quote his notes rather than paraphrase them. Invent nothing.
"decisions" has at least one line; "openItems" may be empty when nothing is open. Each line is a non-empty string of 600 characters or fewer.
Reply with JSON only: {"decisions":[...],"openItems":[...]}.`;

// No upper limit: a film with many shots and notes has many decisions (42 for a 39-shot film).
const lines = (v, name, min) => {
  if (!Array.isArray(v)) throw new Error(`${name} must be a list.`);
  if (v.length < min) throw new Error(`${name} must have at least ${min} line.`);
  for (const s of v) if (typeof s !== "string" || !s.trim() || s.length > 600) throw new Error(`${name} lines must be non-empty strings of 600 characters or fewer.`);
};

export async function handoverProse(host, { notes, choices, warnings }) {
  const r = await askJson(host, {
    instructions: HANDOVER_INSTRUCTIONS,
    data: { notes, choices, warnings },
    tier: "default",
    validate: (v) => {
      if (!isObj(v)) throw new Error("Claude's answer is not an object.");
      lines(v.decisions, "decisions", 1);
      lines(v.openItems, "openItems", 0);
    },
  });
  return { decisions: r.decisions, openItems: r.openItems };
}
