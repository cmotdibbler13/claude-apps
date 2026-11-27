// Narration status from Autocue Studio: the line script, the takes and the checks JSON. Reads only.
import { join } from "./paths.js";

const TOL_S = 0.01;
// Results from checks older than this were made with rules since fixed (numbers): Check all redoes them.
export const MIN_CHECKS_VERSION = 2;
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
  return { name, lines: lines.filter((l) => l.text).map(({ id, section: s, text, notes }) => ({ id, section: s, text, toCamera: notes.some((n) => n.trim().toLowerCase() === "to camera") })) };
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

async function firstIn(host, dir, accept = () => true) {
  let entries = [];
  try { entries = await host.fs.list(dir); } catch { return null; }
  const hits = entries.filter((e) => !e.isDirectory && /line.*script.*\.txt$/i.test(e.name) && accept(e.name)).map((e) => e.name).sort();
  return hits.length ? join(dir, hits[0]) : null;
}

// "China Clay" -> "china_clay": lower case, every run of other characters one "_".
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Autocue Studio's folder holds every film's line script: only one naming this film will do.
function forFilm(filmDir) {
  const film = slug(String(filmDir ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop());
  if (!film) return () => false;
  const bare = film.replace(/_/g, "");
  return (name) => slug(name).includes(film) || slug(name).replace(/_/g, "").includes(bare);
}

export async function findLineScript(host, filmDir, handoverText, settings = {}) {
  for (const p of lineScriptPaths(handoverText, filmDir)) if (await isFile(host, p)) return p;
  for (const d of [filmDir, join(filmDir, "narration")]) {
    const hit = await firstIn(host, d);
    if (hit) return hit;
  }
  return settings?.autocueDir ? firstIn(host, settings.autocueDir, forFilm(filmDir)) : null;
}

// Reads and parses the file; the project name falls back to the file name, as in Autocue Studio.
// Keeps the path and mtime so refreshLineScript can tell when it is edited.
export async function loadLineScript(host, path) {
  let mtimeMs = null;
  try { mtimeMs = (await host.fs.stat(path)).mtimeMs ?? null; } catch { /* read below says why */ }
  const parsed = parseLineScript(await host.fs.read(path, "utf8"));
  const base = String(path).split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
  return { ...parsed, name: parsed.name ?? base, path, mtimeMs };
}

// One stat: the same object if unchanged, a fresh parse if the file was edited, null if it is gone.
export async function refreshLineScript(host, ls) {
  if (!ls?.path) return ls;
  let st;
  try { st = await host.fs.stat(ls.path); } catch { return null; }
  if (!st?.isFile) return null;
  if ((st.mtimeMs ?? null) === ls.mtimeMs) return ls;
  return loadLineScript(host, ls.path);
}

async function readJson(host, p) {
  try {
    const v = JSON.parse(await host.fs.read(p, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

// Jon listened and says the take is fine: approvals[id] = {take_mtime}; only for that exact take.
function approvedFor(approvals, id, takeS) {
  const a = approvals?.[id];
  return !!a && typeof a.take_mtime === "number" && Math.abs(a.take_mtime - takeS) <= TOL_S;
}

async function rowFor(host, base, project, ln, approvals) {
  const row = { id: ln.id, section: ln.section, text: ln.text, status: "missing", flags: [], notes: [] };
  let take;
  try { take = await host.fs.stat(join(base, `${project}_${ln.id}.wav`)); } catch { return row; }
  if (!take?.isFile) return row;
  row.file = join(base, `${project}_${ln.id}.wav`); // the take, for the play button
  const takeS = take.mtimeMs / 1000;
  row.takeS = takeS;
  const done = (r) => (approvedFor(approvals, ln.id, takeS) && r.status !== "ok" ? { ...r, okByJon: true, checkedStatus: r.status, status: "jon" } : r);
  return done(await checkedRow(host, base, project, ln, row, takeS));
}

async function checkedRow(host, base, project, ln, row, takeS) {
  const res = await readJson(host, join(base, "checks", `${project}_${ln.id}.json`));
  if (!res) return { ...row, status: "unchecked" }; // never checked: Check all in Autocue Studio
  if (typeof res.take_mtime !== "number" || res.take_mtime < takeS - TOL_S) return { ...row, status: "checking" };
  if (res.error) return { ...row, status: "error", flags: [String(res.error)] };
  if (!(Number(res.version) >= MIN_CHECKS_VERSION)) return { ...row, status: "outdated" };
  const all = Array.isArray(res.flags) ? res.flags : [];
  for (const f of all) (FLAG_KINDS.has(f?.kind) ? row.flags : row.notes).push(String(f?.text ?? f?.kind ?? ""));
  row.status = res.ok === false || row.flags.length ? "flagged" : "ok";
  return row;
}

export async function narrationStatus(host, settings, lineScript, approvals = {}) {
  const project = lineScript?.name ?? "";
  const base = join(settings?.autocueRecordings ?? "", project);
  const rows = await Promise.all((lineScript?.lines ?? []).map((ln) => rowFor(host, base, project, ln, approvals)));
  const n = (s) => rows.filter((r) => r.status === s).length;
  return {
    project, rows,
    counts: { total: rows.length, recorded: rows.filter((r) => r.status !== "missing").length, ok: n("ok"), jon: n("jon"), flagged: n("flagged"), unchecked: n("unchecked") + n("outdated") },
  };
}

export function countsLine(c) {
  const parts = [`${c.recorded} of ${c.total} recorded`];
  if (c.ok) parts.push(`${c.ok} ok`);
  if (c.jon) parts.push(`${c.jon} OK by Jon`);
  if (c.flagged) parts.push(`${c.flagged} flagged`);
  if (c.rerecord) parts.push(`${c.rerecord} to re-record`);
  if (c.unchecked) parts.push(`${c.unchecked} not checked \u2014 press Check all in Autocue Studio`);
  return parts.join(" \u00B7 ");
}

export const STATUS_LABEL = { missing: "Missing", unchecked: "Not checked", outdated: "Old check", checking: "Checking\u2026", ok: "OK", jon: "OK by Jon", flagged: "Flagged", rerecord: "Re-record", error: "Error" };
export const NO_LINE_SCRIPT = "No line script found for this film. Name it in part1_handover.md.";
