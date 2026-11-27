import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogueArray, nextBrNumber, librarySlug, plannedEntries, withClaudeFields, mdRow, appendMd } from "../js/library.js";

const doc = JSON.parse(readFileSync(new URL("./fixtures/broll_catalogue.json", import.meta.url), "utf8"));
const ROOT = "S:\\Youtube video ideas\\";
const KEYS = ["id", "film", "shot", "status", "aspect", "description", "setting", "period", "tags", "prompt", "job_id", "notes", "size_mb",
  "source_path", "library_path", "in_library", "duplicate_of", "duration_s", "width", "height", "fps"];
const probe = { duration_s: 5, width: 1920, height: 1080, fps: 24, size_mb: 8.26 };

function shot(id, extra = {}) {
  return { id, kind: "broll", aspect: "16:9", prompt: `prompt ${id}`,
    chosen: { file: `S:\\Youtube video ideas\\The Christmas Tree\\studio\\media\\${id}_t2.mp4`, hfJob: "job-" + id, local: null },
    others: [{ file: `s:\\youtube video ideas\\The Christmas Tree\\studio\\media\\${id}_t1.mp4`, note: "too dark", hfJob: "job-o" + id, size_mb: 7.04 },
             { file: `S:\\Youtube video ideas\\The Christmas Tree\\studio\\media\\${id}_t3.mp4`, hfJob: null }],
    probe, ...extra };
}
const base = { entries: doc.entries, film: "The Christmas Tree", filmFolder: "The Christmas Tree", slug: "christmas_tree", startNumber: 600, root: ROOT };

test("catalogueArray finds the key under any name", () => {
  assert.equal(catalogueArray(doc).key, "entries");
  const other = { clips: doc.entries, note: "x" };
  const r = catalogueArray(other);
  assert.equal(r.key, "clips");
  assert.equal(r.entries, other.clips);
});

test("catalogueArray throws unless exactly one array", () => {
  const msg = "The B-roll catalogue has no list of clips.";
  assert.throws(() => catalogueArray({ a: [], b: [] }), { message: msg });
  assert.throws(() => catalogueArray({ a: 1 }), { message: msg });
  assert.throws(() => catalogueArray(null), { message: msg });
  assert.throws(() => catalogueArray([]), { message: msg });
});

test("nextBrNumber takes the highest from JSON or MD", () => {
  assert.equal(nextBrNumber(doc.entries, ""), 13);
  assert.equal(nextBrNumber(doc.entries, "| BR-099 | x |\n| BR-005 |"), 100);
  assert.equal(nextBrNumber([], ""), 1);
});

test("librarySlug reuses the film's existing slug, else derives it", () => {
  assert.equal(librarySlug(doc.entries, "The Old Lighthouse", "Whatever"), "old_lighthouse");
  assert.equal(librarySlug(doc.entries, "The Christmas Tree", "The Christmas Tree!"), "the_christmas_tree");
  assert.equal(librarySlug(doc.entries, "New", "Mary's  Lamb"), "mary_s_lamb");
});

test("plannedEntries: ids in shot order, approved then rejected, key order", () => {
  const out = plannedEntries({ ...base, shots: [shot("HF-01"), shot("HF-02")] });
  assert.deepEqual(out.map((p) => p.entry.id), ["BR-600", "BR-601", "BR-602", "BR-603", "BR-604", "BR-605"]);
  assert.deepEqual(out.map((p) => p.entry.status), ["approved", "rejected", "rejected", "approved", "rejected", "rejected"]);
  const a = out[0];
  assert.deepEqual(Object.keys(a.entry), KEYS);
  assert.equal(a.entry.film, "The Christmas Tree");
  assert.equal(a.entry.shot, "HF-01");
  assert.equal(a.entry.aspect, "16:9");
  assert.equal(a.entry.prompt, "prompt HF-01");
  assert.equal(a.entry.job_id, "higgsfield:job-HF-01");
  assert.equal(a.entry.size_mb, 8.3);
  assert.equal(a.entry.source_path, "The Christmas Tree\\studio\\media\\HF-01_t2.mp4");
  assert.equal(a.entry.library_path, "B-roll library\\clips\\christmas_tree\\christmas_tree_HF-01.mp4");
  assert.equal(a.entry.in_library, true);
  assert.equal(a.entry.duplicate_of, null);
  assert.deepEqual([a.entry.duration_s, a.entry.width, a.entry.height, a.entry.fps], [5, 1920, 1080, 24]);
  assert.equal(a.entry.description, undefined);
  assert.equal(a.entry.notes, undefined);
  assert.equal(a.copyFrom, "S:\\Youtube video ideas\\The Christmas Tree\\studio\\media\\HF-01_t2.mp4");
  assert.equal(a.thumb, "thumbs\\BR-600.jpg");
});

test("plannedEntries: rejected row shape", () => {
  const out = plannedEntries({ ...base, shots: [shot("HF-01")] });
  const r = out[1];
  assert.deepEqual(Object.keys(r.entry), KEYS.slice(0, 17));
  assert.equal(r.entry.status, "rejected");
  assert.equal(r.entry.library_path, null);
  assert.equal(r.entry.in_library, false);
  assert.equal(r.entry.size_mb, 7);
  assert.equal(r.entry.job_id, "higgsfield:job-oHF-01");
  assert.equal(r.entry.source_path, "The Christmas Tree\\studio\\media\\HF-01_t1.mp4");
  assert.equal(r.entry.prompt, "prompt HF-01");
  assert.equal(r.copyFrom, undefined);
  assert.equal(r.thumb, undefined);
  assert.equal(out[2].entry.size_mb, null);
  assert.equal(out[2].entry.job_id, null);
});

test("plannedEntries: job_id for ComfyUI and Blender", () => {
  const comfy = shot("HF-03", { chosen: { file: ROOT + "The Christmas Tree\\studio\\media\\HF-03_t1.mp4", hfJob: null,
    local: { tool: "comfyui", workflow: "C:\\wf\\ltx_i2v.json", seed: 42 } }, others: [] });
  const blender = shot("HF-04", { chosen: { file: ROOT + "The Christmas Tree\\studio\\media\\HF-04_t1.mp4", hfJob: null,
    local: { tool: "blender", script: ROOT + "The Christmas Tree\\studio\\blender\\tree.py" } }, others: [] });
  const out = plannedEntries({ ...base, shots: [comfy, blender] });
  assert.equal(out[0].entry.job_id, "local ComfyUI ltx_i2v.json seed 42");
  assert.equal(out[1].entry.job_id, "Blender: The Christmas Tree\\studio\\blender\\tree.py");
});

test("plannedEntries skips shots already catalogued by source_path (Review Focus 1)", () => {
  const entries = [...doc.entries, { id: "BR-050", source_path: "the christmas tree\\studio\\media\\HF-01_t2.mp4", status: "approved" }];
  const out = plannedEntries({ ...base, entries, shots: [shot("HF-01"), shot("HF-07")] });
  assert.deepEqual(out.map((p) => p.entry.shot), ["HF-07", "HF-07", "HF-07"]);
  assert.equal(out[0].entry.id, "BR-600");
  const again = plannedEntries({ ...base, entries: [...entries, ...out.map((p) => p.entry)], shots: [shot("HF-01"), shot("HF-07")] });
  assert.deepEqual(again, []);
});

test("withClaudeFields places values in key order and validates", () => {
  const e = plannedEntries({ ...base, shots: [shot("HF-01")] })[0].entry;
  const f = { description: "A tree", setting: "living room", period: "1950s", tags: ["a", "b", "c", "d", "e", "f", "g", "h"], notes: "Higgsfield." };
  const w = withClaudeFields(e, f);
  assert.deepEqual(Object.keys(w), KEYS);
  assert.equal(w.description, "A tree");
  assert.equal(w.setting, "living room");
  assert.equal(w.id, e.id);
  assert.equal(e.description, undefined);
  assert.throws(() => withClaudeFields(e, { ...f, extra: 1 }), /extra/);
  const { notes, ...missing } = f;
  assert.throws(() => withClaudeFields(e, missing), /notes/);
  assert.throws(() => withClaudeFields(e, { ...f, description: "" }), /description/);
  assert.throws(() => withClaudeFields(e, { ...f, setting: 3 }), /setting/);
  assert.throws(() => withClaudeFields(e, { ...f, tags: f.tags.slice(0, 7) }), /tags/);
  assert.throws(() => withClaudeFields(e, { ...f, tags: [...f.tags, "i", "j", "k", "l", "m"] }), /tags/);
  assert.throws(() => withClaudeFields(e, { ...f, tags: ["A", ...f.tags.slice(1)] }), /tags/);
  assert.throws(() => withClaudeFields(e, { ...f, tags: ["", ...f.tags.slice(1)] }), /tags/);
});

test("withClaudeFields for rejected rows", () => {
  const r = plannedEntries({ ...base, shots: [shot("HF-01")] })[1].entry;
  const ok = { description: "Dark tree", setting: "", period: "", tags: ["tree", "rejected"], notes: "Rejected: too dark" };
  const w = withClaudeFields(r, ok);
  assert.deepEqual(Object.keys(w), KEYS.slice(0, 17));
  assert.equal(w.period, "");
  assert.throws(() => withClaudeFields(r, { ...ok, tags: ["rejected", "tree"] }), /rejected/);
  assert.throws(() => withClaudeFields(r, { ...ok, tags: ["a", "b", "c", "d", "e", "f", "rejected"] }), /tags/);
  assert.throws(() => withClaudeFields(r, { ...ok, notes: "too dark" }), /Rejected: /);
});

test("mdRow for approved and rejected rows with escaping", () => {
  const e = { id: "BR-600", shot: "HF-01", status: "approved", duration_s: 5, description: "A | B\nC", period: "1950s", tags: ["x", "y"], notes: "n|m" };
  assert.equal(mdRow(e), "| BR-600 | HF-01 | approved | 5.0 s | A \\| B C | 1950s | x, y | n\\|m |");
  const r = { id: "BR-601", shot: "HF-01", status: "rejected", description: "d", period: "", tags: ["x", "rejected"], notes: "Rejected: no" };
  assert.equal(mdRow(r), "| BR-601 | HF-01 | rejected (not copied) | \u2013 | d | \u2013 | x, rejected | Rejected: no |");
  assert.equal(mdRow({ ...e, duration_s: 4.26 }).includes("4.3 s"), true);
});

const HEAD = "| ID | Shot | Status | Duration | What it shows | Period | Tags | Notes |\n|---|---|---|---|---|---|---|---|";
const MD = `# Catalogue\n\n## The Old Lighthouse\n\n${HEAD}\n| BR-010 | HF-01 | used | 5.0 s | a | b | c | d |\n\n## Other Film\n\n${HEAD}\n| BR-020 | PS01 | used | 5.0 s | a | b | c | d |\n`;

test("appendMd inserts into the film's table when another section follows", () => {
  const out = appendMd(MD, "The Old Lighthouse", ["| BR-011 | x |", "| BR-012 | y |"]);
  const lines = out.split("\n");
  const i = lines.indexOf("| BR-010 | HF-01 | used | 5.0 s | a | b | c | d |");
  assert.equal(lines[i + 1], "| BR-011 | x |");
  assert.equal(lines[i + 2], "| BR-012 | y |");
  assert.equal(lines[i + 3], "");
  assert.equal(lines[i + 4], "## Other Film");
  assert.equal(out.length, MD.length + "| BR-011 | x |\n| BR-012 | y |\n".length);
});

test("appendMd appends at the end of the last film's table", () => {
  const out = appendMd(MD, "Other Film", ["| BR-021 | x |"]);
  assert.equal(out, MD + "| BR-021 | x |\n");
  const noNl = appendMd(MD.trimEnd(), "Other Film", ["| BR-021 | x |"]);
  assert.equal(noNl, MD.trimEnd() + "\n| BR-021 | x |");
});

test("appendMd adds a new film table copying the last table's header (Review Focus 4)", () => {
  const out = appendMd(MD, "The Christmas Tree", ["| BR-600 | x |"]);
  assert.equal(out, MD + `\n## The Christmas Tree\n\n${HEAD}\n| BR-600 | x |\n`);
});

test("appendMd keeps CRLF line endings", () => {
  const crlf = MD.replace(/\n/g, "\r\n");
  const out = appendMd(crlf, "The Old Lighthouse", ["| BR-011 | x |"]);
  assert.ok(out.includes("| BR-010 | HF-01 | used | 5.0 s | a | b | c | d |\r\n| BR-011 | x |\r\n\r\n## Other Film"));
  assert.ok(!/[^\r]\n/.test(out));
});

test("appendMd puts a table under an existing heading that has none", () => {
  const md = `${MD}\n## Empty Film\n\n## Last\n\n${HEAD}\n| BR-030 | a |\n`.replace("## Last", "## Later");
  const out = appendMd(md, "Empty Film", ["| BR-040 | x |"]);
  assert.equal(out.split("## Empty Film").length, 2);
  assert.ok(out.includes(`## Empty Film\n\n${HEAD}\n| BR-040 | x |\n\n## Later`));
  const atEnd = appendMd(`${MD}\n## Empty Film\n`, "Empty Film", ["| BR-040 | x |"]);
  assert.ok(atEnd.endsWith(`## Empty Film\n\n${HEAD}\n| BR-040 | x |\n`));
});

test("appendMd throws when the MD has no table", () => {
  assert.throws(() => appendMd("# Catalogue\n", "F", ["| x |"]), { message: "Couldn't find a table in broll_catalogue.md to copy its columns from." });
});

test("mdRow throws for an approved entry without a duration", () => {
  const e = { id: "BR-600", shot: "HF-01", status: "approved", description: "d", period: "p", tags: ["x"], notes: "n" };
  assert.throws(() => mdRow(e), { message: "BR-600 has no duration" });
  assert.throws(() => mdRow({ ...e, duration_s: NaN }), /no duration/);
});

test("plannedEntries tolerates ComfyUI without workflow or seed", () => {
  const mk = (local) => shot("HF-03", { chosen: { file: ROOT + "The Christmas Tree\\studio\\media\\HF-03_t1.mp4", hfJob: null, local }, others: [] });
  const none = "local ComfyUI (workflow and seed not recorded)";
  assert.equal(plannedEntries({ ...base, shots: [mk({ tool: "comfyui", seed: 1 })] })[0].entry.job_id, none);
  assert.equal(plannedEntries({ ...base, shots: [mk({ tool: "comfyui", workflow: "w.json" })] })[0].entry.job_id, none);
  assert.equal(plannedEntries({ ...base, shots: [mk({ tool: "comfyui", workflow: "w.json", seed: 0 })] })[0].entry.job_id, "local ComfyUI w.json seed 0");
});
