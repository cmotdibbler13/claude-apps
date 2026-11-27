// Helpers for starting a film from a brief: prefixes, episode numbers, film folders, briefs.
import { join } from "./paths.js";
import { parseLineScript } from "./narration.js";

const PREFIX_RULE = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const SKIP_FOLDERS = ["b-roll library", "presenter photos", "comfyui workflows", "autocue recordings", "voice files"];
const HANDOVER = "handover\\part1_handover.md";

export function suggestPrefix(topic) {
  return String(topic ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function prefixProblem(prefix, taken = []) {
  if (!PREFIX_RULE.test(String(prefix ?? ""))) return "Use lower-case letters, digits and _ only.";
  const p = prefix.toLowerCase();
  if (taken.some((t) => String(t).toLowerCase() === p)) return `Another film already uses ${prefix}.`;
  return null;
}

export function suggestEpisode(films = []) {
  let max = 0;
  for (const f of films) {
    const n = parseInt(String(f?.number ?? "").trim(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(3, "0");
}

async function listDir(host, dir) {
  try { return (await host.fs.list(dir)) ?? []; } catch { return []; }
}

async function subfolders(host, root) {
  return (await listDir(host, root))
    .filter((e) => e.isDirectory && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function takenPrefixes(host, root, settings) {
  const out = new Set();
  const dir = settings?.autocueDir;
  if (dir) {
    for (const e of await listDir(host, dir)) {
      if (e.isDirectory || !/_line_script\.txt$/i.test(e.name)) continue;
      try {
        const { name } = parseLineScript(await host.fs.read(join(dir, e.name), "utf8"));
        if (name) out.add(name);
      } catch { /* unreadable: skip */ }
    }
  }
  for (const name of await subfolders(host, root)) {
    try {
      const text = await host.fs.read(join(root, name, HANDOVER), "utf8");
      for (const line of text.split(/\r\n|\n|\r/)) {
        const m = /^\s*(?:-\s*)?(?:File prefix|Prefix):\s*`?([a-z0-9_]+)`?/i.exec(line);
        if (m) out.add(m[1]);
      }
    } catch { /* no handover: skip */ }
  }
  return [...out];
}

export async function filmFolders(host, root) {
  const out = [];
  for (const name of await subfolders(host, root)) {
    if (SKIP_FOLDERS.includes(name.toLowerCase())) continue;
    const dir = join(root, name);
    let has = false;
    try { has = !!(await host.fs.exists(join(dir, HANDOVER))); } catch { /* treat as none */ }
    if (!has) out.push({ name, dir });
  }
  return out;
}

export async function briefsIn(host, dir) {
  const out = [];
  for (const e of await listDir(host, dir)) {
    if (e.isDirectory) continue;
    if (!/\.(md|txt)$/i.test(e.name) || /(_script\.md|_line_script\.txt)$/i.test(e.name)) continue;
    const path = join(dir, e.name);
    let mtimeMs = 0;
    try { mtimeMs = (await host.fs.stat(path)).mtimeMs ?? 0; } catch { continue; }
    out.push({ name: e.name, path, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function addBrief(host, dir, { name, bytes }) {
  const m = /^(.*?)(\.[^.]*)?$/.exec(String(name ?? ""));
  if (!/^\.(md|txt)$/i.test(m[2] ?? "")) throw new Error("Save the brief as Markdown or text in the film's folder first.");
  let path = join(dir, name), n = 1;
  while (await host.fs.exists(path)) { n += 1; path = join(dir, `${m[1]}_${n}${m[2]}`); }
  await host.fs.write(path, bytes);
  return path;
}
