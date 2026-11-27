// ComfyUI Desktop: started when Studio opens (if it isn't already running), so b-roll jobs never wait on it.
// Mirrors the Stable Audio starter: state, ensure (one start shared), refresh (a free check), stop (only what it started).
import { runProcess, killTree } from "../proc.js";

export const EXE_CANDIDATES = [
  "C:\\Users\\Jon\\AppData\\Local\\Programs\\@comfyorgcomfyui-electron\\ComfyUI.exe",
  "C:\\Users\\Jon\\AppData\\Local\\Programs\\ComfyUI\\ComfyUI.exe",
  "C:\\Users\\Jon\\AppData\\Local\\Programs\\Comfy Desktop\\Comfy Desktop.exe", // Jon's install (2026-11)
];
export const MSG_COMFY_MISSING = "ComfyUI Desktop wasn't found. Set comfy.exe in .studio-settings.json.";
export const MSG_COMFY_DIDNT_START = "ComfyUI didn't start. Open it yourself and look at its window.";
const POLL_MS = 3000;
const MAX_POLLS = 80; // 4 minutes
const AFTER_EXIT_POLLS = 30; // the launcher handed over to a window already loading: wait up to 90 s more
const KEEP = 16 * 1024;

const urlOf = (comfy) => String(comfy?.url || "http://127.0.0.1:8188").replace(/\/+$/, "");

export async function comfyUp(host, comfy) {
  try {
    const r = await runProcess(host, "curl", ["-sS", "--fail", "--max-time", "5", `${urlOf(comfy)}/system_stats`], { timeout: 15000 });
    return r.code === 0;
  } catch { return false; }
}

// comfy.exe from settings, else the first install place that exists.
export async function comfyExe(host, comfy) {
  const list = [comfy?.exe, ...EXE_CANDIDATES].filter((p) => typeof p === "string" && p.trim());
  for (const p of list) {
    try { if (await host.fs.exists(p)) return p; } catch { /* unreadable: try the next */ }
  }
  return null;
}

export function makeComfyStarter({ settings, sleep }) {
  let state = "off", message = null, proc = null, running = null, gen = 0, host0 = null;
  const subs = new Set();
  const set = (s, m = null) => {
    if (s === state && m === message) return;
    state = s; message = m;
    for (const f of [...subs]) { try { f(); } catch { /* listener errors never stop the starter */ } }
  };
  const comfy = () => settings.comfy ?? {};

  async function start(host) {
    host0 = host;
    const myGen = gen;
    set("starting"); // checking counts as starting, so the line never reads "Off" while Studio looks
    if (await comfyUp(host, comfy())) { set("ready"); return; }
    const exe = await comfyExe(host, comfy());
    if (!exe) { set("missing", MSG_COMFY_MISSING); throw new Error(MSG_COMFY_MISSING); }
    if (gen !== myGen) { set("off"); return; }
    set("starting");
    let exited = -1, tail = "";
    const p = host.spawn(exe, []);
    proc = p;
    // Its log is read and dropped (a full pipe would stall ComfyUI); the tail is kept for nothing else.
    const keep = (c) => { tail = (tail + String(c)).slice(-KEEP); };
    p.onOut(keep); p.onErr(keep);
    let polls = 0;
    p.onExit(() => { exited = polls; if (proc === p) proc = null; });
    const fail = () => { set("failed", MSG_COMFY_DIDNT_START); throw new Error(MSG_COMFY_DIDNT_START); };
    for (let i = 0; i < MAX_POLLS; i++) {
      polls = i;
      await sleep(POLL_MS);
      if (gen !== myGen) { set("off"); return; }
      if (await comfyUp(host, comfy())) { set("ready"); return; }
      // ComfyUI Desktop allows one window: a second launch hands over to the open one (maybe still loading) and
      // exits. So an exit only means failure once ComfyUI has stayed silent for 90 s after it.
      if (exited >= 0 && i - exited >= AFTER_EXIT_POLLS) return fail();
    }
    return fail();
  }

  return {
    state: () => state,
    message: () => message,
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    ensure(host) {
      if (!running) {
        const r = start(host).finally(() => { if (running === r) running = null; });
        running = r;
      }
      return running;
    },
    async refresh(host) {
      if (state === "starting") return;
      const up = await comfyUp(host, comfy());
      if (state === "starting") return;
      if (up) set("ready");
      else if (state === "ready") set("off");
    },
    // Closes ComfyUI only if Studio started it.
    async stop() {
      const p = proc;
      proc = null; gen++; running = null;
      if (p) await killTree(host0, p);
      if (state === "ready" || state === "starting") set("off");
    },
  };
}
