// B-roll library catalogue entries and Markdown rows. Pure: no file access (the caller reads and writes).
const KEYS = ["id", "film", "shot", "status", "aspect", "description", "setting", "period", "tags", "prompt", "job_id", "notes", "size_mb",
  "source_path", "library_path", "in_library", "duplicate_of", "duration_s", "width", "height", "fps"];
const REJECTED_KEYS = KEYS.slice(0, 17);
const NO_LIST = "The B-roll catalogue has no list of clips.";
const DASH = "–";

export function catalogueArray(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(NO_LIST);
  const keys = Object.keys(doc).filter((k) => Array.isArray(doc[k]));
  if (keys.length !== 1) throw new Error(NO_LIST);
  return { key: keys[0], entries: doc[keys[0]] };
}

export function nextBrNumber(entries, mdText) {
  let max = 0;
  const see = (s) => { for (const m of String(s || "").matchAll(/BR-(\d+)/g)) max = Math.max(max, Number(m[1])); };
  for (const e of entries || []) see(e && e.id);
  see(mdText);
  return max + 1;
}

const lower = (s) => String(s || "").toLowerCase();

export function librarySlug(entries, filmFolder, topic) {
  const prefix = lower(filmFolder) + "\\";
  for (const e of entries || []) {
    if (!e || !lower(e.source_path).startsWith(prefix)) continue;
    const m = /^B-roll library\\clips\\([^\\]+)\\/i.exec(e.library_path || "");
    if (m) return m[1];
  }
  return String(topic).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function rel(root, p) {
  const r = root.endsWith("\\") ? root : root + "\\";
  const s = String(p);
  return lower(s).startsWith(lower(r)) ? s.slice(r.length) : s;
}

const round1 = (n) => Math.round(n * 10) / 10;
const sizeOf = (n) => (typeof n === "number" && isFinite(n) ? round1(n) : null);

function jobId(take, root, shot) {
  if (take.hfJob) return `higgsfield:${take.hfJob}`;
  const l = take.local;
  if (l && l.tool === "comfyui") {
    if (!l.workflow || l.seed == null) throw new Error(`${shot} take has no ComfyUI workflow/seed recorded`);
    return `local ComfyUI ${String(l.workflow).split(/[\\/]/).pop()} seed ${l.seed}`;
  }
  if (l && l.tool === "blender") return `Blender: ${rel(root, l.script)}`;
  return null;
}

const brId = (n) => "BR-" + String(n).padStart(3, "0");

export function plannedEntries({ shots, entries, film, filmFolder, slug, startNumber, root }) {
  const have = new Set((entries || []).map((e) => lower(e && e.source_path)));
  const out = [];
  let n = startNumber;
  for (const s of shots) {
    const chosenRel = rel(root, s.chosen.file);
    if (have.has(lower(chosenRel))) continue;
    const common = { film, shot: s.id, aspect: s.aspect };
    const id = brId(n++);
    out.push({
      entry: {
        id, film, shot: s.id, status: "approved", aspect: s.aspect,
        description: undefined, setting: undefined, period: undefined, tags: undefined,
        prompt: s.prompt, job_id: jobId(s.chosen, root, s.id), notes: undefined,
        size_mb: sizeOf(s.probe.size_mb), source_path: chosenRel,
        library_path: `B-roll library\\clips\\${slug}\\${slug}_${s.id}.mp4`, in_library: true, duplicate_of: null,
        duration_s: s.probe.duration_s, width: s.probe.width, height: s.probe.height, fps: s.probe.fps,
      },
      copyFrom: s.chosen.file,
      thumb: `thumbs\\${id}.jpg`,
    });
    for (const o of s.others || []) {
      const srcRel = rel(root, o.file);
      if (have.has(lower(srcRel))) continue;
      out.push({
        entry: {
          id: brId(n++), film: common.film, shot: common.shot, status: "rejected", aspect: common.aspect,
          description: undefined, setting: undefined, period: undefined, tags: undefined,
          prompt: s.prompt, job_id: jobId(o, root, s.id), notes: undefined,
          size_mb: sizeOf(o.size_mb), source_path: srcRel,
          library_path: null, in_library: false, duplicate_of: null,
        },
      });
    }
  }
  return out;
}

const CLAUDE_KEYS = ["description", "setting", "period", "tags", "notes"];

export function withClaudeFields(entry, fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Claude's answer is not an object.");
  const keys = Object.keys(fields);
  const missing = CLAUDE_KEYS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !CLAUDE_KEYS.includes(k));
  if (missing.length) throw new Error(`Claude's answer is missing: ${missing.join(", ")}.`);
  if (extra.length) throw new Error(`Claude's answer has unexpected fields: ${extra.join(", ")}.`);
  const rejected = entry.status === "rejected";
  if (typeof fields.description !== "string" || !fields.description.trim()) throw new Error("description must be a non-empty string.");
  if (typeof fields.setting !== "string") throw new Error("setting must be a string.");
  if (typeof fields.period !== "string") throw new Error("period must be a string.");
  const t = fields.tags;
  if (!Array.isArray(t) || !t.every((x) => typeof x === "string" && x.trim() && x === x.toLowerCase())) {
    throw new Error("tags must be a list of lower-case, non-empty strings.");
  }
  const [lo, hi] = rejected ? [1, 6] : [8, 12];
  if (t.length < lo || t.length > hi) throw new Error(`tags must have ${lo} to ${hi} entries (got ${t.length}).`);
  if (rejected && t[t.length - 1] !== "rejected") throw new Error('The last tag of a rejected row must be "rejected".');
  if (typeof fields.notes !== "string" || !fields.notes.trim()) throw new Error("notes must be a non-empty string.");
  if (rejected && !fields.notes.startsWith("Rejected: ")) throw new Error('notes of a rejected row must start with "Rejected: ".');
  const merged = { ...entry, ...fields };
  const out = {};
  for (const k of rejected ? REJECTED_KEYS : KEYS) if (k in merged) out[k] = merged[k];
  return out;
}

const esc = (v) => String(v ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

export function mdRow(e) {
  const rej = e.status === "rejected";
  if (!rej && !Number.isFinite(e.duration_s)) throw new Error(`${e.id} has no duration`);
  const status = rej ? "rejected (not copied)" : e.status;
  const dur = rej ? DASH : `${Number(e.duration_s).toFixed(1)} s`;
  const period = rej ? DASH : e.period;
  return `| ${[e.id, e.shot, status, dur, e.description, period, (e.tags || []).join(", "), e.notes].map(esc).join(" | ")} |`;
}

export function appendMd(mdText, film, rows) {
  const eol = mdText.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /\n$/.test(mdText);
  const lines = mdText.replace(/\r?\n$/, "").split(/\r?\n/);
  const isRow = (l) => l.trimStart().startsWith("|");
  let end = lines.length - 1;
  while (end >= 0 && !isRow(lines[end])) end--;
  if (end < 0) throw new Error("Couldn't find a table in broll_catalogue.md to copy its columns from.");
  let start = end;
  while (start > 0 && isRow(lines[start - 1])) start--;
  const header = lines.slice(start, Math.min(start + 2, end + 1));
  const h = lines.findIndex((l) => l.trim() === `## ${film}`);
  if (h >= 0) {
    let i = h + 1;
    while (i < lines.length && !isRow(lines[i]) && !/^#/.test(lines[i])) i++;
    if (i < lines.length && isRow(lines[i])) {
      while (i < lines.length && isRow(lines[i])) i++;
      lines.splice(i, 0, ...rows);
    } else {
      const add = ["", ...header, ...rows];
      if (h + 1 < lines.length && lines[h + 1].trim() !== "") add.push("");
      lines.splice(h + 1, 0, ...add);
    }
    return lines.join(eol) + (trailing ? eol : "");
  }
  const base = mdText.replace(/(\r?\n)*$/, "");
  return base + eol + ["", `## ${film}`, "", ...header, ...rows].join(eol) + eol;
}
