// Higgsfield runner (connector lane): generate_video / generate_image, wait with jobs_wait, download with curl.
// A generation costs credits, so generate is called at most once per start() and never retried.
import { DEFAULT_SETTINGS } from "../settings.js";

const MIN_POLL_MS = 20_000;
const CAP_MS = 30 * 60 * 1000;
const MAX_WAIT_ERRORS = 5;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const OK = new Set(["completed", "succeeded", "success", "done", "finished"]);
const BAD = new Set(["failed", "nsfw", "ip_detected", "cancelled", "canceled", "error", "rejected"]);
const UNREACHABLE = "Couldn't reach Higgsfield to check this job; it may still be running. Run again only if you're sure it failed.";

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (e) => String(e?.message ?? e);
const excerpt = (v) => { let s; try { s = JSON.stringify(v); } catch { s = String(v); } return (s ?? "undefined").slice(0, 200); };

function parseJobId(p) {
  const direct = [p?.job_id, p?.id, p?.jobs?.[0]?.job_id, p?.jobs?.[0]?.id, p?.results?.[0]?.job_id, p?.results?.[0]?.id];
  for (const d of direct) if (typeof d === "string" && d) return d;
  let s = "";
  try { s = JSON.stringify(p) ?? ""; } catch { /* ignore */ }
  return s.match(UUID_RE)?.[0] ?? null;
}

function parseEntry(p) {
  const e = p?.jobs?.[0] ?? p?.results?.[0] ?? p ?? {};
  const status = String(e.status ?? e.state ?? "").toLowerCase();
  let s = ""; try { s = JSON.stringify(e) ?? ""; } catch { /* ignore */ }
  const url = s.match(/https:\/\/[^\s"\\<>]+/)?.[0] ?? null;
  const httpUrl = url ? null : s.match(/http:\/\/[^\s"\\<>]+/)?.[0] ?? null;
  return { status, error: typeof e.error === "string" ? e.error : e.error?.message, url, httpUrl };
}

const extOf = (url, kind) => {
  const m = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : kind === "lineart" ? "png" : "mp4";
};

export function makeHiggsfieldRunner({ settings = DEFAULT_SETTINGS, sleep = realSleep } = {}) {
  const call = (host, tool, input) => host.mcp.call("Higgsfield", tool, input);

  async function download(host, url, input) {
    if (!/^https:\/\//i.test(url)) throw new Error("Higgsfield returned a non-https result URL; refusing to download it.");
    if (/["%`$!^'\s]/.test(url)) throw new Error("Higgsfield returned a result URL with characters that are unsafe to pass to curl; refusing to download it.");
    if (/["%&|<>^`$!]/.test(input.out)) throw new Error("The output path contains characters that are unsafe for the shell (\" % & | < > ^ ` $ !); refusing to download.");
    const file = `${input.out}.${extOf(url, input.kind)}`;
    const dir = file.replace(/[\\/][^\\/]*$/, "");
    await host.fs.mkdir(dir);
    const r = await host.exec(`curl -L --fail -o "${file}" "${url}"`, { cwd: dir });
    if (r.code !== 0) throw new Error(`Download failed (curl exit ${r.code}): ${String(r.stderr ?? "").slice(0, 200)}`);
    if (!(await host.fs.exists(file))) throw new Error("Download failed: the file was not written.");
    return { file };
  }

  async function waitAndDownload(job, ctx, jobId, { tolerateErrors }) {
    const { host } = ctx;
    const t0 = host.now();
    let slept = 0, errors = 0, pollMs = MIN_POLL_MS, first = true;
    for (;;) {
      if (!first) {
        const ms = Math.max(MIN_POLL_MS, pollMs);
        await sleep(ms);
        slept += ms;
      }
      first = false;
      if (Math.max(slept, host.now() - t0) >= CAP_MS) throw new Error("Still running on Higgsfield after 30 min");
      ctx.progress(null);
      let p;
      try {
        p = await call(host, "jobs_wait", { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 15 });
      } catch (e) {
        if (!tolerateErrors) throw new Error(msg(e));
        if (++errors >= MAX_WAIT_ERRORS) throw new Error(UNREACHABLE);
        pollMs = MIN_POLL_MS;
        continue;
      }
      errors = 0;
      const { status, error, url, httpUrl } = parseEntry(p);
      if (BAD.has(status)) throw new Error(`Higgsfield job ${status}${error ? `: ${error}` : ""}`);
      if (OK.has(status) || (!status && (url || httpUrl))) {
        if (!url) throw new Error(httpUrl ? "Higgsfield returned a non-https result URL; refusing to download it." : "Higgsfield finished but returned no result URL.");
        return download(host, url, job.input);
      }
      const after = Number(p?.poll_after_seconds ?? p?.jobs?.[0]?.poll_after_seconds);
      pollMs = Number.isFinite(after) ? after * 1000 : MIN_POLL_MS;
    }
  }

  return {
    lane: "connector",

    async start(job, ctx) {
      const { host } = ctx;
      const { kind, prompt } = job.input ?? {};
      const video = kind === "broll";
      const params = { model: video ? settings.videoModel : settings.imageModel, prompt, aspect_ratio: "16:9", count: 1, use_unlim: false };
      if (video) { params.mode = "pro"; params.sound = false; }
      const payload = await call(host, video ? "generate_video" : "generate_image", { params }).catch((e) => { throw new Error(msg(e)); });
      if (payload && typeof payload === "object" && "unlim_choice" in payload) {
        throw new Error("Higgsfield is asking which balance to use; open Higgsfield and choose, then Run again.");
      }
      const jobId = parseJobId(payload);
      if (!jobId) throw new Error(`Higgsfield did not return a job id (not generating again). Response: ${excerpt(payload)}`);
      ctx.setRef(jobId);
      return waitAndDownload(job, ctx, jobId, { tolerateErrors: true });
    },

    async resume(job, ctx) {
      if (!job.jobRef) throw new Error("Cannot resume: no jobRef stored for this job.");
      return waitAndDownload(job, ctx, job.jobRef, { tolerateErrors: true });
    },
  };
}

export const higgsfieldRunner = makeHiggsfieldRunner();
