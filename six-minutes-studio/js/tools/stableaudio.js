// Stable Audio 3 Small SFX (Pinokio): status check and a starter that keeps the pterm process alive.
import { runProcess } from "../proc.js";

const CURL_TIMEOUT = 10_000;
const POLL_MS = 2000, MAX_POLLS = 60; // 120 s
const KEEP = 4096;

export const MSG_MUSIC = "Stable Audio Music is running. Stop it in Pinokio, then press Start Stable Audio.";
export const MSG_PINOKIO = "Open Pinokio first, then press Start Stable Audio.";
export const MSG_DIDNT_START = "Stable Audio didn't start. Look at its Terminal in Pinokio, or switch this cue to ElevenLabs.";

const base = (sa) => String(sa.url).replace(/\/+$/, "");

async function curlGet(host, url) {
  return runProcess(host, "curl", ["-sS", "--max-time", "5", url], { timeout: CURL_TIMEOUT });
}

// "ready" (SFX model with /generate), "music" (Music model on the port), "off" (nothing listening), "other".
export async function stableAudioState(host, sa) {
  let r;
  try { r = await curlGet(host, base(sa) + "/"); } catch { return "off"; }
  if (r.code === 7 || r.code === 6) return "off";
  if (r.code !== 0) return "other";
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.stdout)?.[1] ?? "");
  if (/small sfx/i.test(title)) {
    try {
      const i = await curlGet(host, base(sa) + "/gradio_api/info");
      return i.code === 0 && i.stdout.includes('"/generate"') ? "ready" : "other";
    } catch { return "other"; }
  }
  if (/music/i.test(title)) return "music";
  return "other";
}

export function makeStableAudioStarter({ sleep, settings }) {
  let state = "off", message = null, proc = null, running = null;
  const subs = new Set();
  const set = (s, m = null) => {
    if (s === state && m === message) return;
    state = s; message = m;
    for (const f of [...subs]) { try { f(); } catch { /* listener errors never stop the starter */ } }
  };
  const sa = () => settings.stableAudio;

  async function start(host) {
    const live = await stableAudioState(host, sa());
    if (live === "ready") { set("ready"); return; }
    if (live === "music") { set("music", MSG_MUSIC); throw new Error(MSG_MUSIC); }
    set("starting");
    let output = "", exited = false;
    const p = host.spawn(sa().pterm, ["run", sa().app, "--default", "start.js?model=small-sfx"], { shell: true });
    proc = p;
    const add = (c) => { output = (output + String(c)).slice(-KEEP); };
    p.onOut(add); p.onErr(add);
    p.onExit(() => {
      exited = true;
      if (proc === p) { proc = null; if (state === "ready") set("off"); }
    });
    const fail = (msg) => { set("failed", msg); try { Promise.resolve(p.kill()).catch(() => {}); } catch { /* gone */ } if (proc === p) proc = null; throw new Error(msg); };
    for (let i = 1; i <= MAX_POLLS; i++) {
      await sleep(POLL_MS);
      const s = await stableAudioState(host, sa());
      if (s === "ready") { set("ready"); return; }
      if (s === "music") return fail(MSG_MUSIC);
      if (exited) return fail(i === 1 || /42000|ECONNREFUSED|connect/i.test(output) ? MSG_PINOKIO : MSG_DIDNT_START);
    }
    return fail(MSG_DIDNT_START);
  }

  return {
    state: () => state,
    message: () => message,
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    ensure(host) {
      if (!running) running = start(host).finally(() => { running = null; });
      return running;
    },
    async stop() {
      const p = proc;
      proc = null;
      if (p) { try { await p.kill(); } catch { /* already gone */ } }
      if (state === "ready" || state === "starting") set("off");
    },
  };
}
