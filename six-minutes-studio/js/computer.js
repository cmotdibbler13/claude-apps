// This computer: its name, a small local record of which project folder it uses, and the settings
// that belong to one computer only (everything else in .studio-settings.json is shared).
import { runProcess } from "./proc.js";
import { join } from "./paths.js";
import { copyAside, writeSafely } from "./libraryio.js";

export const PER_COMPUTER = ["role", "autocueDir", "autocueRecordings", "autocuePython", "blenderPath", "stemRemixerDir", "ffmpegPath", "autostart"];
export const COMFY_KEYS = ["url", "outputDir", "exe"];
const STORE_KEY = "sms.computer";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

async function echo(host, name) {
  const r = await runProcess(host, "cmd", ["/c", `echo %${name}%`], { timeout: 10000 });
  const v = r.stdout.trim();
  if (r.code !== 0 || !v || v === `%${name}%`) throw new Error(`no ${name}`);
  return v;
}

export async function computerName(host) {
  try { return (await echo(host, "COMPUTERNAME")).toUpperCase(); } catch { return "THIS-PC"; }
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
      try {
        const { dir, path } = await file();
        await host.fs.mkdir(dir);
        await writeSafely(host, path, JSON.stringify(obj, null, 2));
        return;
      } catch { /* fall back */ }
      try { browserStore()?.setItem(STORE_KEY, JSON.stringify(obj)); } catch { /* nowhere to keep it */ }
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

export function roleNeeded(raw, computer) {
  const c = raw?.computers;
  if (!isObj(c)) return false;
  const names = Object.keys(c);
  return names.length > 0 && !Object.prototype.hasOwnProperty.call(c, computer);
}

const pad = (n) => String(n).padStart(2, "0");

export async function saveComputerSettings(host, root, computer, patch, { now = host.now?.() ?? Date.now() } = {}) {
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
  await writeSafely(host, path, JSON.stringify({ ...raw, computers }, null, 2));
}
