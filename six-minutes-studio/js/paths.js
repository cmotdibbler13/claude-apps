// Project root resolution and Windows-style path joining.
export const PRIMARY_ROOT = "S:\\Youtube video ideas";
export const FALLBACK_ROOT = "\\\\192.168.1.171\\jon\\Youtube video ideas";

async function present(host, p) {
  try { return !!(await host.fs.exists(p)); } catch { return false; }
}

export async function resolveRoot(host) {
  for (const root of [PRIMARY_ROOT, FALLBACK_ROOT]) {
    if (await present(host, root)) return root;
  }
  return null;
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
