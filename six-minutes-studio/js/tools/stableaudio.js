// Stable Audio 3 Small SFX (Pinokio): status check and a starter that keeps the pterm process alive.
import { runProcess } from "../proc.js";
import { join } from "../paths.js";
import { finishSfx, measure } from "../audio.js";

const CURL_TIMEOUT = 10_000;
const POLL_MS = 2000, MAX_POLLS = 60; // 120 s
const KEEP = 4096;

export const MSG_MUSIC = "Stable Audio Music is running. Stop it in Pinokio, then press Start Stable Audio.";
export const MSG_PINOKIO = "Open Pinokio first, then press Start Stable Audio.";
export const MSG_DIDNT_START = "Stable Audio didn't start. Look at its Terminal in Pinokio, or switch this cue to ElevenLabs.";

export const MSG_STOPPED = "Stable Audio was stopped.";

// With shell:true Node does not quote arguments, so quote any that cmd.exe would split or interpret.
const quote = (a) => (/[\s&()^|<>%!"]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);

const base = (sa) => String(sa.url).replace(/\/+$/, "");

async function curlGet(host, url) {
  return runProcess(host, "curl", ["-sS", "--max-time", "5", url], { timeout: CURL_TIMEOUT });
}

// "ready" (Gradio is up with /generate, and it isn't the Music model), "music" (the Music model is on the
// port), "off" (nothing listening), "other" (something else answers there).
// Gradio fills the page's <title> in with scripts, so the served HTML may only say "Gradio": the app's own
// title comes from its JSON config (GET /config). When neither names a model, /generate is enough.
const SFX_RE = /small[\s_-]*sfx/i;
const MUSIC_RE = /small[\s_-]*music|audio[\s_-]*3[\s_-]*music/i;
export function modelFromTitles(titles) {
  for (const t of titles) {
    if (SFX_RE.test(t)) return "sfx";
    if (MUSIC_RE.test(t)) return "music";
  }
  return null;
}

export async function stableAudioState(host, sa) {
  let i;
  try { i = await curlGet(host, base(sa) + "/gradio_api/info"); } catch { return "off"; }
  if (i.code === 7 || i.code === 6) return "off";
  if (i.code !== 0 || !String(i.stdout).includes('"/generate"')) return "other";
  const titles = [];
  try {
    const c = await curlGet(host, base(sa) + "/config");
    if (c.code === 0) {
      try { const t = JSON.parse(c.stdout)?.title; if (typeof t === "string") titles.push(t); } catch { /* not JSON */ }
    }
  } catch { /* no config: fall back to the page */ }
  try {
    const r = await curlGet(host, base(sa) + "/");
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.stdout ?? "")?.[1];
    if (r.code === 0 && t) titles.push(t);
  } catch { /* page unreadable: /generate is enough */ }
  return modelFromTitles(titles) === "music" ? "music" : "ready";
}

export function makeStableAudioStarter({ sleep, settings }) {
  let state = "off", message = null, proc = null, running = null, gen = 0;
  const subs = new Set();
  const set = (s, m = null) => {
    if (s === state && m === message) return;
    state = s; message = m;
    for (const f of [...subs]) { try { f(); } catch { /* listener errors never stop the starter */ } }
  };
  const sa = () => settings.stableAudio;

  async function start(host) {
    const myGen = gen;
    const live = await stableAudioState(host, sa());
    if (live === "ready") { set("ready"); return; }
    if (live === "music") { set("music", MSG_MUSIC); throw new Error(MSG_MUSIC); }
    const stopped = () => { if (!running) set("off"); throw new Error(MSG_STOPPED); };
    if (gen !== myGen) stopped();
    set("starting");
    let output = "", exited = false;
    const p = host.spawn(quote(sa().pterm), ["run", sa().app, "--default", "start.js?model=small-sfx"].map(quote), { shell: true });
    proc = p;
    const add = (c) => { output = (output + String(c)).slice(-KEEP); };
    p.onOut(add); p.onErr(add);
    p.onExit(() => {
      exited = true;
      if (proc === p) { proc = null; if (state === "ready") set("off"); }
    });
    const kill = () => { try { Promise.resolve(p.kill()).catch(() => {}); } catch { /* gone */ } if (proc === p) proc = null; };
    const fail = (msg, st = "failed") => { set(st, msg); kill(); throw new Error(msg); };
    for (let i = 1; i <= MAX_POLLS; i++) {
      await sleep(POLL_MS);
      if (gen !== myGen) { kill(); stopped(); }
      const s = await stableAudioState(host, sa());
      if (gen !== myGen) { kill(); stopped(); }
      if (s === "ready") { set("ready"); return; }
      if (s === "music") return fail(MSG_MUSIC, "music");
      if (exited) return fail(i === 1 || /42000|ECONNREFUSED|connect/i.test(output) ? MSG_PINOKIO : MSG_DIDNT_START);
    }
    return fail(MSG_DIDNT_START);
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
    // Free live check, never spawns. Leaves "starting" alone.
    async refresh(host) {
      if (state === "starting") return;
      const live = await stableAudioState(host, sa());
      if (state === "starting") return;
      if (live === "ready") set("ready");
      else if (live === "music") set("music", MSG_MUSIC);
      else if (live === "off") set("off");
    },
    async stop() {
      const p = proc;
      proc = null; gen++; running = null;
      if (p) { try { await p.kill(); } catch { /* already gone */ } }
      if (state === "ready" || state === "starting") set("off");
    },
  };
}

// ---- Runner ----
const POST_MS = 30_000;
const STREAM_MS = 5 * 60 * 1000;
const DOWNLOAD_MS = 60_000;
const MSG_FAILED = "Stable Audio failed on this prompt. Look at its Terminal in Pinokio.";
const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");
const excerpt = (v) => String(v ?? "").trim().slice(0, 200);

// Pure: the 29 /generate inputs (see docs/stable-audio-api-notes.md), ending in the hidden null.
export function saPayload(prompt, seconds, sa) {
  const secs = Math.min(120, Math.max(1, Math.round(Number(seconds)) || 1));
  return { data: [
    String(prompt ?? ""), "", secs, Number(sa.cfg), Number(sa.steps), 0, -1, "pingpong", 1.0, 0.0, 1.0, 0.0, 0.0, 1.0,
    "wav", "verbose", true, null, 0.9, null, null, null, "Init audio", 100, 0, false, 6.0, 1, null,
  ] };
}

// Pure: reads a Gradio SSE stream. "event: complete" then its data line gives the first file's url.
export function parseSse(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let done = false, error = false, url = null, event = null;
  for (const line of lines) {
    if (line.startsWith("event:")) { event = line.slice(6).trim(); if (event === "error") error = true; continue; }
    if (line.startsWith("data:") && event === "complete" && !done) {
      done = true;
      try { const u = JSON.parse(line.slice(5).trim())?.[0]?.url; if (typeof u === "string" && u) url = u; } catch { /* no url */ }
    }
  }
  return { done, error, url };
}

const encodeFileUrl = (url) => {
  const i = url.indexOf("file=") + 5;
  return url.slice(0, i) + url.slice(i).split("/").map(encodeURIComponent).join("/");
};

export function makeStableAudioRunner({ settings, starter, sleep } = {}) {
  void sleep;
  const sa = () => settings.stableAudio;
  return {
    lane: "gpu",

    async start(job, ctx) {
      const { host } = ctx;
      const { prompt, seconds, out } = job.input ?? {};
      if (typeof out !== "string" || !/\.wav$/i.test(out)) throw new Error("This job has no .wav output path; not rendering.");
      await starter.ensure(host);
      const s = sa();
      const url = String(s.url).replace(/\/+$/, "");
      const hostPort = url.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
      const notRunning = `Stable Audio isn't running at ${hostPort}. Press Start Stable Audio, or switch this cue to ElevenLabs.`;
      const mediaDir = parentOf(out);
      const studioDir = parentOf(mediaDir);
      const tmp = join(studioDir, "tmp");
      const bodyFile = join(tmp, "sa_body.json");
      await host.fs.mkdir(tmp);
      await host.fs.write(bodyFile, JSON.stringify(saPayload(prompt, seconds, s)));

      let r;
      try {
        r = await runProcess(host, "curl", ["-sS", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@" + bodyFile, url + "/gradio_api/call/generate"], { timeout: POST_MS });
      } catch { throw new Error(notRunning); }
      if (r.code === 6 || r.code === 7) throw new Error(notRunning);
      if (r.code !== 0) throw new Error(`Stable Audio request failed (curl exit ${r.code}): ${excerpt(r.stderr)}`);
      let eventId;
      try { eventId = JSON.parse(r.stdout)?.event_id; } catch { /* not JSON */ }
      if (typeof eventId !== "string" || !eventId) throw new Error(`Stable Audio did not return an event id. Response: ${excerpt(r.stdout)}`);

      let g;
      try {
        g = await runProcess(host, "curl", ["-sS", "-N", `${url}/gradio_api/call/generate/${encodeURIComponent(eventId)}`], { timeout: STREAM_MS });
      } catch (e) { throw new Error(`Stable Audio took too long or stopped answering: ${String(e?.message ?? e)}`); }
      if (g.code !== 0) throw new Error(`Stable Audio stream failed (curl exit ${g.code}): ${excerpt(g.stderr)}`);
      const sse = parseSse(g.stdout);
      if (sse.error) throw new Error(MSG_FAILED);
      if (!sse.done || !sse.url) throw new Error("Stable Audio finished without an audio file. Look at its Terminal in Pinokio.");
      const prefix = url + "/gradio_api/file=";
      if (!sse.url.startsWith(prefix)) throw new Error("Stable Audio returned an unexpected file address; not downloading it.");

      const orig = out.replace(/\.wav$/i, "") + ".orig.wav";
      const part = out.replace(/\.wav$/i, "") + ".orig.part.wav";
      await host.fs.mkdir(mediaDir);
      const discard = async () => { try { if (await host.fs.exists(part)) await host.fs.trash(part); } catch { /* best effort */ } };
      let d;
      try {
        d = await runProcess(host, "curl", ["-sS", "--fail", "-o", part, encodeFileUrl(sse.url)], { timeout: DOWNLOAD_MS });
      } catch (e) { await discard(); throw e; }
      if (d.code !== 0) { await discard(); throw new Error(`Couldn't download the Stable Audio file (curl exit ${d.code}): ${excerpt(d.stderr)}`); }
      if (!(await host.fs.exists(part))) throw new Error("The Stable Audio download finished but no file was saved.");
      try { await host.fs.rename(part, orig); } catch (e) { await discard(); throw e; }

      await finishSfx(host, orig, out);
      const m = await measure(host, out);
      return { file: out, meta: { lengthS: m.lengthS, peakDb: m.peakDb, meanDb: m.meanDb, quiet: m.quiet, source: "stableaudio" } };
    },

    async resume() {
      throw new Error("Interrupted; Stable Audio takes are quick, so run it again.");
    },
  };
}
