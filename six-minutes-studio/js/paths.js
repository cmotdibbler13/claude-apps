// Project root resolution and Windows-style path joining.
export const PRIMARY_ROOT = "S:\\Youtube video ideas";
export const FALLBACK_ROOT = "\\\\192.168.1.171\\jon\\Youtube video ideas";

async function present(host, p) {
  try { return !!(await host.fs.exists(p)); } catch { return false; }
}

const LETTERS = (from) => Array.from({ length: 26 - from }, (_, i) => String.fromCharCode(65 + from + i));
const driveRoot = (l) => `${l}:\\Youtube video ideas`;

// With a chosen folder: that folder if present, else null (no fallback search, so the app can say so).
// Without: S:, then D: to Z: (a mapped drive may be any letter), then the network path.
export async function resolveRoot(host, { chosen } = {}) {
  if (chosen) return (await present(host, chosen)) ? chosen : null;
  if (await present(host, PRIMARY_ROOT)) return PRIMARY_ROOT;
  for (const l of LETTERS(3)) {
    if (l === "S") continue;
    if (await present(host, driveRoot(l))) return driveRoot(l);
  }
  return (await present(host, FALLBACK_ROOT)) ? FALLBACK_ROOT : null;
}

// The desktop's own two spellings of the project folder (S: and the network path): a computer on either
// is the desktop by default, so it is never asked its role and shares .studio-jobs.json. Case-insensitive,
// trailing slash ignored.
export const isHomeRoot = (root) => {
  const k = (p) => String(p ?? "").replace(/[\\/]+$/, "").toLowerCase();
  return !!root && (k(root) === k(PRIMARY_ROOT) || k(root) === k(FALLBACK_ROOT));
};

// Every project folder found: C: to Z: and the network path.
export async function candidateRoots(host) {
  const out = [];
  for (const l of LETTERS(2)) if (await present(host, driveRoot(l))) out.push(driveRoot(l));
  if (await present(host, FALLBACK_ROOT)) out.push(FALLBACK_ROOT);
  return out;
}

// Every spelling of the project folder Studio knows, unique case-insensitively.
export function rootSpellings(raw) {
  const all = [PRIMARY_ROOT, FALLBACK_ROOT, ...Object.values(raw?.computers ?? {}).map((c) => c?.root).filter(Boolean)];
  const seen = new Set();
  return all.filter((r) => { const k = String(r).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export function join(...parts) {
  const segs = parts.filter((p) => p != null && p !== "").map((p) => String(p).replace(/\//g, "\\"));
  if (!segs.length) return "";
  const unc = segs[0].startsWith("\\\\");
  const body = segs.join("\\").replace(/\\{2,}/g, "\\").replace(/^\\/, unc ? "" : "\\").replace(/\\+$/, "");
  return unc ? "\\\\" + body.replace(/^\\/, "") : body;
}

// A film is known by its folder name under the root, case-insensitively, so a job saved with the
// S: path still matches the film when the app runs from the UNC copy (and the other way round).
export const filmKey = (p) => (String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "").toLowerCase();

const pad2 = (n) => String(n).padStart(2, "0");
// "<name>.old-<YYYYmmdd-HHMMSS>.<ext>" beside the file (local time, as Autocue Studio names them).
export function oldName(p, ms, n = 1) {
  const d = new Date(ms);
  const tag = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const m = /^(.*?)(\.[^.\\/]*)?$/.exec(String(p));
  return `${m[1]}.old-${tag}${n > 1 ? `-${n}` : ""}${m[2] ?? ""}`;
}

// Move an earlier output aside, never deleting it. Returns the new path, or null when there was nothing there.
export async function moveAside(host, p) {
  if (!(await host.fs.exists(p))) return null;
  let n = 1, to = oldName(p, host.now());
  while (await host.fs.exists(to)) to = oldName(p, host.now(), ++n);
  await host.fs.rename(p, to);
  return to;
}
