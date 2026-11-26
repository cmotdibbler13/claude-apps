// ComfyUI runner (gpu lane): submits a workflow to the local ComfyUI over curl, polls its history,
// then crops and strips the result with ffmpeg into the film's media folder. ComfyUI's own output
// file is only ever read.
import { DEFAULT_SETTINGS } from "../settings.js";
import { runProcess } from "../proc.js";
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

function setInput(wf, ref, value) {
  if (!Array.isArray(ref) || ref.length < 2) return;
  const [node, input] = ref;
  const n = wf[node];
  if (!n) throw new Error(`Workflow has no node ${node}`);
  if (!n.inputs || typeof n.inputs !== "object") throw new Error(`Workflow node ${node} has no input ${input}`);
  n.inputs[input] = value;
}

// Pure: returns a copy of the workflow with the mapped inputs set.
export function fillWorkflow(workflow, comfy, { prompt, seed, prefix }) {
  const wf = structuredClone(workflow);
  const m = comfy.nodes ?? {};
  const seconds = Number(comfy.seconds), fps = Number(comfy.fps);
  let length = seconds;
  if (comfy.lengthUnit === "frames") length = 4 * Math.round((Math.round(seconds * fps) - 1) / 4) + 1;
  setInput(wf, m.prompt, prompt);
  setInput(wf, m.width, comfy.width);
  setInput(wf, m.height, comfy.height);
  setInput(wf, m.length, length);
  setInput(wf, m.fps, fps);
  setInput(wf, m.seed, seed);
  setInput(wf, m.output, prefix);
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
      r = await runProcess(host, "ffmpeg", ["-y", "-i", file, "-vf", `crop=${w}:${h}`, "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", part], { timeout: FFMPEG_MS });
    } catch (e) { await discard(); throw e; }
    if (r.code !== 0) {
      await discard();
      throw new Error(`ffmpeg failed (code ${r.code}):\n${String(r.stderr ?? "").trim().split(/\r?\n/).slice(-5).join("\n")}`);
    }
    if (!(await host.fs.exists(part))) throw new Error("ffmpeg finished but the b-roll file was not created.");
    await host.fs.rename(part, out);
    return { file: out };
  }

  async function wait(job, ctx, promptId) {
    const { host } = ctx;
    const c = comfy();
    const url = String(c.url).replace(/\/+$/, "");
    const t0 = host.now();
    let slept = 0, errors = 0;
    for (;;) {
      await sleep(POLL_MS);
      slept += POLL_MS;
      const elapsed = Math.max(slept, host.now() - t0);
      if (elapsed >= CAP_MS) throw ambiguous("Still running on ComfyUI after 60 min");
      const left = Number(c.expectedSeconds) - elapsed / 1000;
      ctx.progress(null, left > 0 ? `about ${Math.max(1, Math.ceil(left / 60))} min left` : "running long");
      let entry;
      try {
        const r = await runProcess(host, "curl", ["-sS", "--fail", `${url}/history/${promptId}`], { timeout: CURL_MS });
        if (r.code !== 0) throw new Error(`curl exit ${r.code}`);
        const body = JSON.parse(r.stdout);
        entry = body?.[promptId];
      } catch {
        if (++errors >= MAX_POLL_ERRORS) throw ambiguous(UNREACHABLE);
        continue;
      }
      errors = 0;
      if (!entry) continue;
      const st = entry.status;
      if (st?.status_str === "error") throw new Error(errorText(entry));
      const found = findOutput(entry, c.nodes?.output?.[0]);
      const finished = st ? (st.completed === true || st.status_str === "success") : !!found;
      if (!finished) continue;
      if (!found) throw new Error("ComfyUI finished but saved no video");
      const src = join(c.outputDir, found.subfolder, found.filename);
      return ffmpegOut(host, c, src, job.input.out);
    }
  }

  return {
    lane: "gpu",

    async start(job, ctx) {
      const { host } = ctx;
      const c = comfy();
      const { prompt, out } = job.input ?? {};
      if (typeof out !== "string" || !/\.mp4$/i.test(out)) throw new Error("This job has no .mp4 output path; not rendering.");
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
      const body = JSON.stringify({ prompt: fillWorkflow(workflow, c, { prompt, seed, prefix }) });

      const tmp = join(studioDir, "tmp");
      const bodyFile = join(tmp, `comfy_${safe(job.id)}.json`);
      await host.fs.mkdir(tmp);
      await host.fs.write(bodyFile, body);
      const url = String(c.url).replace(/\/+$/, "");
      let r;
      try {
        r = await runProcess(host, "curl", ["-sS", "--fail", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@" + bodyFile, url + "/prompt"], { timeout: CURL_MS });
      } catch { r = { code: -1, stdout: "" }; }
      try { await host.fs.trash(bodyFile); } catch { /* best effort */ }
      if (r.code !== 0) throw new Error(`ComfyUI isn't running at ${hostPort(url)}. Open ComfyUI Desktop and press Run again.`);
      let promptId;
      try { promptId = JSON.parse(r.stdout)?.prompt_id; } catch { /* handled below */ }
      if (typeof promptId !== "string" || !promptId) throw new Error(`ComfyUI did not return a prompt id. Response: ${excerpt(r.stdout)}`);
      ctx.setRef(promptId);
      return wait(job, ctx, promptId);
    },

    async resume(job, ctx) {
      if (!job.jobRef) throw new Error("Cannot resume: no jobRef stored for this job.");
      return wait(job, ctx, job.jobRef);
    },
  };
}

export const comfyRunner = makeComfyRunner();
