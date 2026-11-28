// Finding programs Studio needs, and opening the pages to get them. Nothing here installs or changes anything.
import { runProcess } from "./proc.js";
import { join } from "./paths.js";
import { cmdCheck, stemRemixerCheck } from "./toolchecks.js";

export const GET_IT = {
  ffmpeg: "https://www.gyan.dev/ffmpeg/builds/",
  blender: "https://www.blender.org/download/",
  comfyui: "https://www.comfy.org/download",
  pinokio: "https://pinokio.computer/",
  python: "https://www.python.org/downloads/windows/",
  repo: "https://github.com/cmotdibbler13/claude-apps",
};

export async function openLink(host, url) {
  if (!Object.values(GET_IT).includes(url)) throw new Error("Not a known download page.");
  await runProcess(host, "cmd", ["/c", "start", "", url]);
}

const exists = async (host, p) => { try { return !!(await host.fs.exists(p)); } catch { return false; } };
const lines = (s) => String(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const unique = (list) => { const seen = new Set(), out = []; for (const p of list) { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(p); } } return out; };

// `where` exits non-zero when nothing is found: that is no candidates, not an error.
async function where(host, exe) {
  try {
    const r = await runProcess(host, "where", [exe], { timeout: 15000 });
    return r.code === 0 ? lines(r.stdout) : [];
  } catch { return []; }
}

// The value of a Windows environment variable, or null when it can't be read.
async function envVar(host, name) {
  try {
    const r = await runProcess(host, "cmd", ["/c", "echo", `%${name}%`], { timeout: 15000 });
    const v = r.code === 0 ? lines(r.stdout)[0] : "";
    return v && !v.includes("%") ? v : null;
  } catch { return null; }
}

const versionParts = (name) => (String(name).match(/\d+/g) ?? []).map(Number);
const newestFirst = (a, b) => {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

async function listDirs(host, dir) {
  try { return (await host.fs.list(dir)).filter((e) => e.isDirectory).map((e) => e.name); } catch { return []; }
}

// Folders under `parent` whose names pass `want`, newest version first, holding `file`.
async function versioned(host, parents, want, sub, file) {
  const found = [];
  for (const parent of parents) {
    for (const name of await listDirs(host, parent)) if (want(name)) found.push({ name, path: join(parent, name, ...sub, file) });
  }
  found.sort((a, b) => newestFirst(a.name, b.name));
  const out = [];
  for (const f of found) if (await exists(host, f.path)) out.push(f.path);
  return out;
}

async function appFolders(host, word) {
  const user = await envVar(host, "USERPROFILE");
  const roots = [...(user ? [user] : []), "D:\\Apps", "D:\\"];
  const out = [];
  for (const root of roots) {
    for (const name of await listDirs(host, root)) {
      if (!name.toLowerCase().includes(word)) continue;
      const dir = join(root, name);
      if (await exists(host, join(dir, "app.py"))) out.push(dir);
    }
  }
  return out;
}

export async function findCandidates(host, kind) {
  let found = [];
  if (kind === "ffmpeg") found = await where(host, "ffmpeg");
  else if (kind === "python") {
    found = await where(host, "python");
    const local = await envVar(host, "LOCALAPPDATA");
    if (local) found.push(...await versioned(host, [join(local, "Programs", "Python")], (n) => /^python3/i.test(n), [], "python.exe"));
  } else if (kind === "blender") {
    const parents = ["C:\\Program Files", "D:\\Program Files", "D:\\"].map((p) => join(p, "Blender Foundation"));
    found = await versioned(host, parents, () => true, [], "blender.exe");
  } else if (kind === "autocue") found = await appFolders(host, "autocue");
  else if (kind === "stemremixer") found = await appFolders(host, "stem");
  const out = [];
  for (const p of unique(found)) if (await exists(host, p)) out.push(p);
  return out;
}

// The same check Probe uses for that kind.
export async function checkChoice(host, kind, path) {
  try {
    if (kind === "autocue") {
      if (!(await host.fs.exists(join(path, "app.py")))) throw new Error(`app.py isn't in ${path}. Choose the Autocue Studio folder.`);
      return { ok: true, detail: "Autocue Studio" };
    }
    if (kind === "stemremixer") return { ok: true, detail: await stemRemixerCheck(path)(host) };
    return { ok: true, detail: await cmdCheck(path, [kind === "ffmpeg" ? "-version" : "--version"])(host) };
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
}
