// This computer: its name, a small local record of which project folder it uses, and the settings
// that belong to one computer only (everything else in .studio-settings.json is shared).
import { runProcess } from "./proc.js";
import { join, isHomeRoot } from "./paths.js";
import { copyAside, writeSafely } from "./libraryio.js";

export const PER_COMPUTER = ["role", "autocueDir", "autocueRecordings", "autocuePython", "blenderPath", "stemRemixerDir", "ffmpegPath", "autostart"];
export const COMFY_KEYS = ["url", "outputDir", "exe"];
const STORE_KEY = "sms.computer";
// The name used when Windows' COMPUTERNAME can't be read: nothing is saved under it.
export const UNNAMED = "THIS-PC";
export const MSG_UNNAMED = "Studio couldn't read this computer's name, so it can't save settings for it.";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

async function echo(host, name) {
  const r = await runProcess(host, "cmd", ["/c", `echo %${name}%`], { timeout: 10000 });
  const v = r.stdout.trim();
  if (r.code !== 0 || !v || v === `%${name}%`) throw new Error(`no ${name}`);
  return v;
}

export async function computerName(host) {
  try { return (await echo(host, "COMPUTERNAME")).toUpperCase(); } catch { return UNNAMED; }
}

function browserStore() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function localStore(host) {
  const file = async () => {
    const dir = join(await echo(host, "APPDATA"), "Six Minutes Studio");
    return { dir, path: join(dir, "computer.json") };
  };
  return {
    async read() {
      try {
        const v = JSON.parse(await host.fs.read((await file()).path, "utf8"));
        if (isObj(v)) return v;
      } catch { /* fall back */ }
      try {
        const v = JSON.parse(browserStore()?.getItem(STORE_KEY) ?? "{}");
        return isObj(v) ? v : {};
      } catch { return {}; }
    },
    async write(obj) {
      let why;
      try {
        const { dir, path } = await file();
        await host.fs.mkdir(dir);
        await writeSafely(host, path, JSON.stringify(obj, null, 2));
        return;
      } catch (e) { why = e; /* fall back */ }
      const store = browserStore();
      if (!store) throw new Error(`Nowhere on this computer to keep it (${why?.message ?? why}).`);
      try { store.setItem(STORE_KEY, JSON.stringify(obj)); }
      catch (e) { throw new Error(`Nowhere on this computer to keep it (${e?.message ?? e}).`); }
    },
  };
}

// Merge one computer's entry over loaded settings (per-computer keys only).
export function applyComputer(out, entry, computer) {
  const e = isObj(entry) ? entry : {};
  const role = e.role === "laptop" ? "laptop" : "desktop";
  out.role = role;
  out.computer = computer ?? null;
  for (const k of PER_COMPUTER) {
    if (k === "role" || k === "autostart" || e[k] === undefined) continue;
    out[k] = e[k];
  }
  if (isObj(e.comfy)) for (const k of COMFY_KEYS) if (e.comfy[k] !== undefined) out.comfy[k] = e.comfy[k];
  if (isObj(e.stableAudio)) out.stableAudio = { ...out.stableAudio, ...e.stableAudio };
  if (typeof e.autostart === "boolean") out.autostart = { comfy: e.autostart, stableAudio: e.autostart };
  else if (isObj(e.autostart)) out.autostart = { ...out.autostart, ...e.autostart };
  else if (role === "laptop") out.autostart = { comfy: false, stableAudio: false };
  return out;
}

export const samePath = (a, b) => String(a ?? "").replace(/\\+$/, "").toLowerCase() === String(b ?? "").replace(/\\+$/, "").toLowerCase();

// Ask the role when this computer's entry has none and it isn't on S: or the network path (which is the desktop by default).
// A computer whose name can't be read isn't asked: its answer couldn't be saved.
export function roleNeeded(raw, computer, root) {
  if (!root || computer === UNNAMED || isHomeRoot(root)) return false;
  const e = isObj(raw?.computers) ? raw.computers[computer] : null;
  return !(isObj(e) && typeof e.role === "string" && e.role);
}

const pad = (n) => String(n).padStart(2, "0");

export async function saveComputerSettings(host, root, computer, patch, { now = host.now?.() ?? Date.now() } = {}) {
  if (!computer || computer === UNNAMED) throw new Error(MSG_UNNAMED);
  for (const k of Object.keys(patch ?? {})) {
    if (k === "root" || k === "comfy" || k === "stableAudio" || PER_COMPUTER.includes(k)) continue;
    throw new Error(`${k} is shared by every computer.`);
  }
  if (isObj(patch.comfy)) {
    for (const k of Object.keys(patch.comfy)) if (!COMFY_KEYS.includes(k)) throw new Error(`comfy.${k} is shared by every computer.`);
  }
  const path = join(root, ".studio-settings.json");
  let raw = {};
  if (await host.fs.exists(path)) {
    let v;
    try { v = JSON.parse(await host.fs.read(path, "utf8")); } catch { throw new Error(`${path} can't be read, so Studio left it alone.`); }
    if (!isObj(v)) throw new Error(`${path} isn't a settings file, so Studio left it alone.`);
    raw = v;
  }
  const computers = isObj(raw.computers) ? { ...raw.computers } : {};
  const old = isObj(computers[computer]) ? computers[computer] : {};
  const next = { ...old, ...patch };
  for (const k of ["comfy", "stableAudio"]) {
    if (isObj(patch[k])) next[k] = { ...(isObj(old[k]) ? old[k] : {}), ...patch[k] };
  }
  computers[computer] = next;

  const d = new Date(now);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const prefix = `.studio-settings_${day}-`.toLowerCase();
  let copied = false;
  try { copied = (await host.fs.list(root)).some((f) => f.name.toLowerCase().startsWith(prefix) && f.name.toLowerCase().endsWith(".json")); } catch { /* none */ }
  if (!copied) await copyAside(host, path, now);
  await writeSafely(host, path, JSON.stringify({ ...raw, computers }, null, 2) + "\n");
}
