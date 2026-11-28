// ComfyUI runner (gpu lane): submits a workflow to the local ComfyUI over curl, polls its history,
// then crops and strips the result with ffmpeg into the film's media folder. ComfyUI's own output
// file is only ever read.
import { DEFAULT_SETTINGS } from "../settings.js";
import { runProcess } from "../proc.js";
import { tool } from "../toolpaths.js";
import { join } from "../paths.js";

const POLL_MS = 5000;
const CAP_MS = 60 * 60 * 1000;
const MAX_POLL_ERRORS = 5;
const CURL_MS = 30_000;
const FFMPEG_MS = 10 * 60 * 1000;
const UNREACHABLE = "Couldn't reach ComfyUI; the render may still be running. Check again.";

const ambiguous = (m) => Object.assign(new Error(m), { ambiguous: true });
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (e) => String(e?.message ?? e);
const excerpt = (v) => { let s; try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); } return String(s ?? "").trim().slice(0, 200); };
const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");
const baseOf = (p) => String(p).split(/[\\/]/).pop();

// A node-map entry is null/undefined (unmapped), [node, input], or "node.input".
function setInput(wf, ref, value, key) {
  if (ref === null || ref === undefined) return;
  if (typeof ref === "string") {
    const dot = ref.indexOf(".");
    ref = dot > 0 ? [ref.slice(0, dot), ref.slice(dot + 1)] : null;
  }
  if (!Array.isArray(ref) || ref.length !== 2 || typeof ref[0] !== "string" || typeof ref[1] !== "string" || !ref[0] || !ref[1]) {
    throw new Error(`Bad ComfyUI node map entry for ${key}`);
  }
  const [node, input] = ref;
  const n = wf[node];
  if (!n) throw new Error(`Workflow has no node ${node}`);
  if (!n.inputs || typeof n.inputs !== "object") throw new Error(`Workflow node ${node} has no input ${input}`);
  n.inputs[input] = value;
}

// Pure: returns a copy of the workflow with the mapped inputs set.
export function fillWorkflow(workflow, comfy, { prompt, seed, prefix, image }) {
  const wf = structuredClone(workflow);
  const m = comfy.nodes ?? {};
  const seconds = Number(comfy.seconds), fps = Number(comfy.fps);
  let length = seconds;
  if (comfy.lengthUnit === "frames") length = 4 * Math.round((Math.round(seconds * fps) - 1) / 4) + 1;
  setInput(wf, m.prompt, prompt, "prompt");
  if (image !== undefined) setInput(wf, m.image, image, "image");
  setInput(wf, m.width, comfy.width, "width");
  setInput(wf, m.height, comfy.height, "height");
  setInput(wf, m.length, length, "length");
  setInput(wf, m.fps, fps, "fps");
  setInput(wf, m.seed, seed, "seed");
  setInput(wf, m.output, prefix, "output");
  return wf;
}

const fileOf = (arr) => (Array.isArray(arr) ? arr.find((f) => f && typeof f.filename === "string" && f.filename) : null);

// Pure: the saved file for a history entry. The output node first, then any node.
export function findOutput(entry, outputNodeId) {
  const outputs = entry?.outputs;
  if (!outputs || typeof outputs !== "object") return null;
  const pick = (node) => {
    for (const k of ["videos", "gifs", "images"]) {
      const f = fileOf(node?.[k]);
      if (f) return { filename: f.filename, subfolder: f.subfolder ?? "" };
    }
    return null;
  };
  return pick(outputs[outputNodeId]) ?? Object.values(outputs).map(pick).find(Boolean) ?? null;
}

const errorText = (entry) => {
  const ms = entry?.status?.messages;
  if (Array.isArray(ms)) {
    for (let i = ms.length - 1; i >= 0; i--) {
      if (ms[i]?.[0] === "execution_error" && ms[i][1]?.exception_message) return String(ms[i][1].exception_message);
    }
  }
  return "ComfyUI reported an error";
};

function rejection(p, raw) {
  const m = p?.error?.message ?? (typeof p?.error === "string" ? p.error : null);
  if (!m) return `ComfyUI rejected the workflow: ${excerpt(raw)}`;
  const ne = p?.node_errors && typeof p.node_errors === "object" ? Object.entries(p.node_errors).slice(0, 3) : [];
  const more = ne.map(([id, v]) => `node ${id}: ${v?.errors?.[0]?.message ?? v?.errors?.[0]?.type ?? "error"}`);
  return `ComfyUI rejected the workflow: ${m}${more.length ? ` (${more.join("; ")})` : ""}`;
}

export const MSG_I2V_NOT_READY = "Set up the image-to-video workflow (see Probe)";

// The image-to-video settings as a comfy-like object: i2v workflow and nodes, the rest from the b-roll settings.
export function i2vConfig(comfy) {
  const i = comfy?.i2v ?? {};
  const c = { ...comfy, workflow: i.workflow, nodes: i.nodes ?? {} };
  for (const k of ["seconds", "fps", "lengthUnit"]) if (i[k] !== undefined && i[k] !== null) c[k] = i[k];
  return c;
}

// Ready when the workflow file exists and the image, prompt and output nodes are mapped.
export async function i2vReady(host, comfy) {
  const i = comfy?.i2v ?? {};
  const n = i.nodes ?? {};
  const name = baseOf(i.workflow || "animate_i2v.json");
  if (!i.workflow || !(await host.fs.exists(i.workflow))) return { ok: false, why: `${name} isn't in ComfyUI workflows` };
  const missing = ["image", "prompt", "output"].filter((k) => !n[k]);
  if (missing.length) return { ok: false, why: "comfy.i2v.nodes needs image, prompt and output" + (missing.length < 3 ? ` (missing ${missing.join(", ")})` : "") };
  return { ok: true, why: "" };
}

const safe = (s) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "_");

export function makeComfyRunner({ settings = DEFAULT_SETTINGS, sleep = realSleep, random = Math.random } = {}) {
  const comfy = () => settings.comfy ?? DEFAULT_SETTINGS.comfy;
  const hostPort = (url) => String(url).replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");

  async function ffmpegOut(host, c, file, out) {
    const w = Math.min(Number(c.width) || 1920, 1920), h = Math.min(Number(c.height) || 1080, 1080);
    const part = out.replace(/\.mp4$/i, "") + ".part.mp4";
    await host.fs.mkdir(parentOf(out));
    const discard = async () => { try { if (await host.fs.exists(part)) await host.fs.trash(part); } catch { /* best effort */ } };
    let r;
    try {
      r = await runProcess(host, tool("ffmpeg"), ["-y", "-i", file, "-vf", `crop=min(iw\\,${w}):min(ih\\,${h})`, "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", part], { timeout: FFMPEG_MS });
    } catch (e) { await discard(); throw e; }
    if (r.code !== 0) {
      await discard();
      throw new Error(`ffmpeg failed (code ${r.code}):\n${String(r.stderr ?? "").trim().split(/\r?\n/).slice(-5).join("\n")}`);
    }
    if (!(await host.fs.exists(part))) throw new Error("ffmpeg finished but the b-roll file was not created.");
    try { await host.fs.rename(part, out); } catch (e) { await discard(); throw e; }
    return { file: out };
  }

  const cfgFor = (job) => (job?.input?.kind === "animated" ? i2vConfig(comfy()) : comfy());

  async function wait(job, ctx, promptId) {
    const { host } = ctx;
    const c = cfgFor(job);
    const url = String(c.url).replace(/\/+$/, "");
    const t0 = host.now();
    let slept = 0, errors = 0, missing = 0;
    for (;;) {
      await sleep(POLL_MS);
      slept += POLL_MS;
      const elapsed = Math.max(slept, host.now() - t0);
      if (elapsed >= CAP_MS) throw ambiguous("Still running on ComfyUI after 60 min");
      const left = Number(c.expectedSeconds) - elapsed / 1000;
      ctx.progress(null, left > 0 ? `about ${Math.max(1, Math.ceil(left / 60))} min left` : "running long");
      let entry, known = true;
      try {
        const r = await runProcess(host, "curl", ["-sS", "--fail", `${url}/history/${promptId}`], { timeout: CURL_MS });
        if (r.code !== 0) throw new Error(`curl exit ${r.code}`);
        const body = JSON.parse(r.stdout);
        entry = body?.[promptId];
        if (!entry) {
          // No history yet: is ComfyUI still holding the prompt (running or pending)?
          const q = await runProcess(host, "curl", ["-sS", "--fail", `${url}/queue`], { timeout: CURL_MS });
          if (q.code !== 0) throw new Error(`curl exit ${q.code}`);
          const qb = JSON.parse(q.stdout);
          const has = (l) => Array.isArray(l) && l.some((i) => Array.isArray(i) && i[1] === promptId);
          known = has(qb?.queue_running) || has(qb?.queue_pending);
        }
      } catch {
        if (++errors >= MAX_POLL_ERRORS) throw ambiguous(UNREACHABLE);
        continue;
      }
      errors = 0;
      if (!entry) {
        missing = known ? 0 : missing + 1;
        if (missing >= 2) throw new Error("ComfyUI no longer has this render (was it restarted?). Run again.");
        continue;
      }
      missing = 0;
      const st = entry.status;
      if (st?.status_str === "error") throw new Error(errorText(entry));
      const found = findOutput(entry, c.nodes?.output?.[0]);
      const finished = st ? (st.completed === true || st.status_str === "success") : !!found;
      if (!finished) continue;
      if (!found) throw new Error("ComfyUI finished but saved no video");
      for (const seg of [found.subfolder, found.filename]) {
        if (/(^|[\\/])\.\.([\\/]|$)/.test(seg) || /^[A-Za-z]:/.test(seg) || /^[\\/]/.test(seg)) throw new Error("ComfyUI returned an unsafe output path; not using it.");
      }
      const src = join(c.outputDir, found.subfolder, found.filename);
      return ffmpegOut(host, c, src, job.input.out);
    }
  }

  return {
    lane: "gpu",

    async start(job, ctx) {
      const { host } = ctx;
      const animated = job.input?.kind === "animated";
      const c = cfgFor(job);
      const { prompt, out, sourceFile } = job.input ?? {};
      if (typeof out !== "string" || !/\.mp4$/i.test(out)) throw new Error("This job has no .mp4 output path; not rendering.");
      if (animated) {
        const ready = await i2vReady(host, comfy());
        if (!ready.ok) throw new Error(`${MSG_I2V_NOT_READY}: ${ready.why}`);
        if (typeof sourceFile !== "string" || !sourceFile) throw new Error("This job has no drawing to animate; not rendering.");
      }
      let workflow;
      try { workflow = JSON.parse(await host.fs.read(c.workflow, "utf8")); } catch { throw new Error(`Couldn't read the ComfyUI workflow at ${c.workflow}`); }
      const mediaDir = parentOf(out);
      const studioDir = parentOf(mediaDir);
      const filmDir = parentOf(studioDir);
      const stem = baseOf(out).replace(/\.mp4$/i, "");
      const id = job.assetId ?? stem.replace(/_t\d+$/, "");
      const take = job.take ?? stem.match(/_t(\d+)$/)?.[1] ?? "1";
      const prefix = `broll/sixmin_${safe(baseOf(filmDir))}_${safe(id)}_t${safe(take)}_${host.now()}`;
      const seed = Math.floor(random() * 2 ** 31);
      const url = String(c.url).replace(/\/+$/, "");
      const notRunning = `ComfyUI isn't running at ${hostPort(url)}. Open ComfyUI Desktop and press Run again.`;
      const timedOut = () => ambiguous("ComfyUI didn't answer in time; the render may have been queued. Check ComfyUI before running again.");
      let image;
      if (animated) {
        // Argument list, no shell: the path can't be quoted wrong.
        let u;
        try {
          u = await runProcess(host, "curl", ["-sS", "--fail", "-F", "image=@" + sourceFile, "-F", "overwrite=true", url + "/upload/image"], { timeout: CURL_MS });
        } catch (e) {
          throw /timed out/.test(msg(e)) ? new Error("ComfyUI didn't answer in time while sending the drawing. Check ComfyUI and run again.") : new Error(notRunning);
        }
        if (u.code === 6 || u.code === 7) throw new Error(notRunning);
        if (u.code !== 0) throw new Error(`Couldn't send the drawing to ComfyUI: ${excerpt(u.stderr)}`);
        let up; try { up = JSON.parse(u.stdout); } catch { /* not JSON */ }
        if (!up || typeof up.name !== "string" || !up.name) throw new Error(`Couldn't send the drawing to ComfyUI: ${excerpt(u.stdout)}`);
        image = up.subfolder ? up.subfolder + "/" + up.name : up.name;
      }
      const body = JSON.stringify({ prompt: fillWorkflow(workflow, c, { prompt, seed, prefix, image }) });
      const tmp = join(studioDir, "tmp");
      const bodyFile = join(tmp, "comfy_body.json"); // one file, overwritten per submit
      await host.fs.mkdir(tmp);
      await host.fs.write(bodyFile, body);
      let r;
      try {
        r = await runProcess(host, "curl", ["-sS", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@" + bodyFile, "-w", "\n%{http_code}", url + "/prompt"], { timeout: CURL_MS });
      } catch (e) {
        throw /timed out/.test(msg(e)) ? timedOut() : new Error(notRunning);
      }
      if (r.code === 28) throw timedOut();
      if (r.code === 6 || r.code === 7) throw new Error(notRunning);
      if (r.code !== 0) throw new Error(`ComfyUI request failed (curl exit ${r.code}): ${excerpt(r.stderr)}`);
      const text = String(r.stdout ?? "");
      const nl = text.lastIndexOf("\n");
      const status = Number(text.slice(nl + 1).trim());
      const resp = text.slice(0, Math.max(nl, 0));
      let parsed; try { parsed = JSON.parse(resp); } catch { /* not JSON */ }
      if (status >= 400) throw new Error(rejection(parsed, resp));
      const promptId = parsed?.prompt_id;
      if (typeof promptId !== "string" || !promptId) throw new Error(`ComfyUI did not return a prompt id. Response: ${excerpt(resp)}`);
      ctx.setRef(promptId);
      const done = await wait(job, ctx, promptId);
      return { ...done, meta: { ...(done?.meta ?? {}), workflow: c.workflow, seed } };
    },

    async resume(job, ctx) {
      if (!job.jobRef) throw new Error("Cannot resume: no jobRef stored for this job.");
      return wait(job, ctx, job.jobRef);
    },
  };
}

export const comfyRunner = makeComfyRunner();
