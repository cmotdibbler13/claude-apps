// ElevenLabs runner (connector lane): score and sound-effect takes through flow nodes.
// A generation spends credits, so creative_run_flow_nodes is called at most once per start() and never in resume().
import { runProcess } from "../proc.js";
import { finishSfx, measure } from "../audio.js";
import { DEFINITE } from "./higgsfield.js";

const CAP_MS = 30 * 60 * 1000;
const DOWNLOAD_MS = 15 * 60 * 1000;
const MAX_ERRORS = 5;
const DEFAULT_POLL_S = 10;
const MIN_POLL_S = 5;
const AMBIGUOUS_RUN = "ElevenLabs may have started this take. Use Check again before running it again.";
const UNREACHABLE = "Couldn't reach ElevenLabs to check this take; it may still be running. Check again before running it again.";
const EXPIRED = "The ElevenLabs link has expired; open the flow in ElevenLabs to download it.";

const ambiguous = (m) => Object.assign(new Error(m), { ambiguous: true });
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (e) => String(e?.message ?? e);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : lo));
const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");
const call = (host, tool, input) => host.mcp.call("ElevenLabs", tool, input);

export function nodeSpec(kind, { prompt, durationS, loop } = {}) {
  if (durationS == null || durationS === "" || !Number.isFinite(Number(durationS))) throw new Error("Set a length first.");
  if (kind === "score") {
    return {
      node_type: "music", model_id: "eleven_music_v2_5", prompt,
      model_parameters: { duration_seconds: clamp(durationS, 3, 600), lyrics_type: "instrumental", instrumental: true },
    };
  }
  return {
    node_type: "sfx", model_id: "eleven_text_to_sound_v3", prompt,
    model_parameters: { duration_seconds: clamp(durationS, 0.5, 30), prompt_influence: 0.3, loop: !!loop },
  };
}

export const nodeSig = (kind, item) => JSON.stringify(nodeSpec(kind, item));

export async function ensureFlow(host, name) {
  const p = await call(host, "creative_create_flow", { name });
  const id = p?.flow_id ?? p?.flow?.id ?? p?.id;
  if (typeof id !== "string" || !id) throw new Error("ElevenLabs did not return a flow id.");
  return id;
}

export async function addNode(host, flowId, kind, item, label) {
  const p = await call(host, "creative_add_flow_node", { flow_id: flowId, label, ...nodeSpec(kind, item) });
  // Observed reply (26 Nov): {success, node_ids:[id], created_nodes:[{id, …}], …}.
  const id = p?.node_ids?.[0] ?? p?.created_nodes?.[0]?.id ?? p?.node_id ?? p?.node?.id ?? p?.nodes?.[0]?.id;
  if (typeof id !== "string" || !id) throw new Error("ElevenLabs did not return a node id.");
  return id;
}

function findCredits(v, depth = 0) {
  if (!v || typeof v !== "object" || depth > 5) return null;
  for (const [k, x] of Object.entries(v)) {
    if (/remain|balance|available/i.test(k)) continue;
    if (/credit/i.test(k) && typeof x === "number" && Number.isFinite(x)) return x;
  }
  for (const [k, x] of Object.entries(v)) {
    if (/remain|balance|available/i.test(k)) continue;
    const r = findCredits(x, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

// Never generates: estimate_only is always true.
export async function estimate(host, flowId, nodeId) {
  const p = await call(host, "creative_run_flow_nodes", { flow_id: flowId, node_ids: [nodeId], estimate_only: true, generations_count: 1 });
  // Observed reply (26 Nov): {estimate:{credits, price_cents, generations_count, …}, notes, …}.
  const direct = [p?.estimate?.credits, p?.credits, p?.estimated_credits, p?.cost?.credits, p?.total_credits].find((n) => typeof n === "number" && Number.isFinite(n));
  const n = direct ?? findCredits(p);
  return n == null ? null : Math.ceil(n);
}

// The run reply's session id: session_ids[0] or session_id, else any key named like that, at any depth.
export function findSession(p, depth = 0) {
  if (!p || typeof p !== "object" || depth > 4) return null;
  const pick = (v) => (typeof v === "string" && v ? v : Array.isArray(v) && typeof v[0] === "string" && v[0] ? v[0] : null);
  const first = pick(p.session_ids) ?? pick(p.session_id);
  if (first) return first;
  for (const [k, v] of Object.entries(p)) if (/^session_?ids?$/i.test(k) && pick(v)) return pick(v);
  for (const v of Object.values(p)) { const r = findSession(v, depth + 1); if (r) return r; }
  return null;
}

export function parseStatus(p) {
  const failed = p?.has_failures === true;
  const done = !failed && p?.all_completed === true;
  const after = Number(p?.poll_after_seconds);
  const poll = Number.isFinite(after) ? Math.max(MIN_POLL_S, after) : DEFAULT_POLL_S;
  const url = p?.generations?.[0]?.content_url ?? p?.media?.[0]?.url ?? p?.media?.[0]?.master_url ?? null;
  const error = failed ? (p?.generations?.[0]?.error ?? "ElevenLabs reported a failure") : null;
  return { done, failed, poll, url: typeof url === "string" ? url : null, error: typeof error === "string" ? error : error ? msg(error?.message ?? error) : null };
}

const urlExt = (url) => url.split(/[?#]/)[0].match(/\/[^/]*\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase() ?? "mp3";

async function download(host, url, input) {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw new Error("ElevenLabs returned a non-https result URL; refusing to download it.");
  if (/["\s]/.test(url)) throw new Error("ElevenLabs returned a result URL with characters that are unsafe to pass to curl; refusing to download it.");
  const ext = urlExt(url);
  const dest = input.sfx ? `${input.out}.orig.${ext}` : `${input.out}.${ext}`;
  const part = `${dest}.part`;
  await host.fs.mkdir(parentOf(dest));
  const r = await runProcess(host, "curl", ["-L", "--fail", "-sS", "-o", part, url], { timeout: DOWNLOAD_MS });
  if (r.code !== 0) {
    const err = String(r.stderr ?? "").trim();
    if (r.code === 22 && err.includes("403")) throw new Error(EXPIRED);
    throw new Error(`Download failed (curl exit ${r.code}): ${err.slice(0, 200)}`);
  }
  if (!(await host.fs.exists(part))) throw new Error("Download failed: the file was not written.");
  await host.fs.rename(part, dest);
  let file = dest;
  if (input.sfx) file = (await finishSfx(host, dest, `${input.out}.wav`)).file;
  const m = await measure(host, file);
  return { file, meta: { lengthS: m.lengthS, peakDb: m.peakDb, meanDb: m.meanDb, quiet: m.quiet, source: "elevenlabs" } };
}

export function makeElevenRunner({ sleep = realSleep } = {}) {
  async function wait(job, ctx, flowId, sessionId) {
    const { host } = ctx;
    const t0 = host.now();
    let slept = 0, errors = 0, pollS = DEFAULT_POLL_S, first = true;
    for (;;) {
      if (!first) {
        await sleep(pollS * 1000);
        slept += pollS * 1000;
      }
      first = false;
      if (Math.max(slept, host.now() - t0) >= CAP_MS) throw ambiguous("Still running on ElevenLabs after 30 min. Check again before running it again.");
      ctx.progress(null, "generating");
      let p;
      try {
        p = await call(host, "creative_get_flow_run_status", { flow_id: flowId, session_ids: [sessionId] });
      } catch {
        if (++errors >= MAX_ERRORS) throw ambiguous(UNREACHABLE);
        pollS = DEFAULT_POLL_S;
        continue;
      }
      errors = 0;
      const s = parseStatus(p);
      if (s.failed) throw new Error(`ElevenLabs failed: ${s.error}`);
      if (s.done) {
        if (!s.url) throw new Error("ElevenLabs finished but returned no result URL.");
        try {
          return await download(host, s.url, job.input);
        } catch (e) {
          if (e?.ambiguous || msg(e) === EXPIRED) throw e;
          throw ambiguous(`The take was made but couldn't be saved: ${msg(e)}. Use Check again to download it.`);
        }
      }
      pollS = s.poll;
    }
  }

  return {
    lane: "connector",

    async start(job, ctx) {
      const { host } = ctx;
      const { flowId, nodeId, out } = job.input ?? {};
      if (!flowId || !nodeId) throw new Error("This job has no flow or node; not generating.");
      if (typeof out !== "string" || !out) throw new Error("This job has no output path; not generating.");
      try { await host.fs.mkdir(parentOf(out)); } catch (e) { throw new Error(`Couldn't make the folder for this take (${msg(e)}); not generating.`); }
      const p = await call(host, "creative_run_flow_nodes", { flow_id: flowId, node_ids: [nodeId], generations_count: 1 }).catch((e) => {
        // Only a known "nothing started" code is a definite failure; anything else may have run.
        throw typeof e?.code === "string" && DEFINITE.has(e.code) ? new Error(msg(e)) : ambiguous(AMBIGUOUS_RUN);
      });
      const sessionId = findSession(p);
      if (!sessionId) {
        let raw = ""; try { raw = JSON.stringify(p) ?? ""; } catch { /* ignore */ }
        throw ambiguous(`${AMBIGUOUS_RUN} (ElevenLabs replied: ${raw.slice(0, 300)})`);
      }
      ctx.setRef(JSON.stringify({ flowId, sessionId }));
      return wait(job, ctx, flowId, sessionId);
    },

    async resume(job, ctx) {
      if (!job.jobRef) throw new Error("Cannot resume: no jobRef stored for this job.");
      let ref;
      try { ref = JSON.parse(job.jobRef); } catch { throw new Error("Cannot resume: the stored jobRef is not readable."); }
      if (!ref?.flowId || !ref?.sessionId) throw new Error("Cannot resume: the stored jobRef is incomplete.");
      return wait(job, ctx, ref.flowId, ref.sessionId);
    },
  };
}

export const elevenRunner = makeElevenRunner();
