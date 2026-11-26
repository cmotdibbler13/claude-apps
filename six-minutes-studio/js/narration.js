// Narration status from Autocue Studio: the line script, the takes and the checks JSON. Reads only.
import { join } from "./paths.js";

const TOL_S = 0.01;
const FLAG_KINDS = new Set(["cut_off", "misread", "clipping"]);

// Port of Autocue Studio's parse_line_script (app.py).
export function parseLineScript(text) {
  let name = null;
  const lines = [];
  let section = "";
  let cur = null;
  for (const raw of String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^#\s*name\s*:\s*(\S+)/i.exec(line);
    if (m) { name = m[1]; continue; }
    if (line.startsWith("## ")) { section = line.slice(3).trim(); continue; }
    if (line.startsWith("#")) continue;
    m = /^\[([^\]]+)\]/.exec(line);
    if (m) { cur = { id: m[1].trim(), section, text: "", notes: [] }; lines.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith(">")) cur.notes.push(line.slice(1).trim());
    else cur.text = `${cur.text} ${line}`.trim();
  }
  return { name, lines: lines.filter((l) => l.text).map(({ id, section: s, text }) => ({ id, section: s, text })) };
}

const PATTERNS = [
  /`([^`\n]+?\.txt)`/gi,
  /"([^"\n]+?\.txt)"/gi,
  /\]\(([^)\n]+?\.txt)\)/gi,
  /([A-Za-z]:[\\/][^\n`"<>|*?]*?\.txt)(?![\w])/gi,
  /(\\\\[^\n`"<>|*?]*?\.txt)(?![\w])/gi,
  /([^\s`"'()<>|*?]+\.txt)(?![\w])/gi,
];

function lineScriptPaths(text, dir) {
  const found = [];
  for (const re of PATTERNS) for (const m of String(text ?? "").matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length, path: m[1] });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    lastEnd = f.end;
    const p = f.path.trim().replace(/\//g, "\\").replace(/^\.\\/, "");
    if (!/line/i.test(p)) continue;
    const abs = /^[A-Za-z]:\\/.test(p) || p.startsWith("\\\\") ? p : join(dir, p);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

async function isFile(host, p) {
  try { return !!(await host.fs.stat(p)).isFile; } catch { return false; }
}

async function firstIn(host, dir) {
  let entries = [];
  try { entries = await host.fs.list(dir); } catch { return null; }
  const hits = entries.filter((e) => !e.isDirectory && /line.*script.*\.txt$/i.test(e.name)).map((e) => e.name).sort();
  return hits.length ? join(dir, hits[0]) : null;
}

export async function findLineScript(host, filmDir, handoverText, settings = {}) {
  for (const p of lineScriptPaths(handoverText, filmDir)) if (await isFile(host, p)) return p;
  const dirs = [filmDir, join(filmDir, "narration")];
  if (settings?.autocueDir) dirs.push(settings.autocueDir);
  for (const d of dirs) {
    const hit = await firstIn(host, d);
    if (hit) return hit;
  }
  return null;
}

// Reads and parses the file; the project name falls back to the file name, as in Autocue Studio.
export async function loadLineScript(host, path) {
  const parsed = parseLineScript(await host.fs.read(path, "utf8"));
  const base = String(path).split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
  return { ...parsed, name: parsed.name ?? base };
}

async function readJson(host, p) {
  try {
    const v = JSON.parse(await host.fs.read(p, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

async function rowFor(host, base, project, ln) {
  const row = { id: ln.id, section: ln.section, text: ln.text, status: "missing", flags: [], notes: [] };
  let take;
  try { take = await host.fs.stat(join(base, `${project}_${ln.id}.wav`)); } catch { return row; }
  if (!take?.isFile) return row;
  const res = await readJson(host, join(base, "checks", `${project}_${ln.id}.json`));
  const takeS = take.mtimeMs / 1000;
  if (!res || typeof res.take_mtime !== "number" || res.take_mtime < takeS - TOL_S) return { ...row, status: "checking" };
  if (res.error) return { ...row, status: "error", flags: [String(res.error)] };
  const all = Array.isArray(res.flags) ? res.flags : [];
  for (const f of all) (FLAG_KINDS.has(f?.kind) ? row.flags : row.notes).push(String(f?.text ?? f?.kind ?? ""));
  row.status = res.ok === false || row.flags.length ? "flagged" : "ok";
  return row;
}

export async function narrationStatus(host, settings, lineScript) {
  const project = lineScript?.name ?? "";
  const base = join(settings?.autocueRecordings ?? "", project);
  const rows = await Promise.all((lineScript?.lines ?? []).map((ln) => rowFor(host, base, project, ln)));
  const n = (s) => rows.filter((r) => r.status === s).length;
  return {
    project, rows,
    counts: { total: rows.length, recorded: rows.filter((r) => r.status !== "missing").length, ok: n("ok"), flagged: n("flagged") },
  };
}

export function countsLine(c) {
  const parts = [`${c.recorded} of ${c.total} recorded`];
  if (c.ok) parts.push(`${c.ok} ok`);
  if (c.flagged) parts.push(`${c.flagged} flagged`);
  return parts.join(" \u00B7 ");
}

export const STATUS_LABEL = { missing: "Missing", checking: "Checking\u2026", ok: "OK", flagged: "Flagged", error: "Error" };
export const NO_LINE_SCRIPT = "No line script found for this film. Name it in part1_handover.md.";
