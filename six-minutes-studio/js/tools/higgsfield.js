// Higgsfield runner (connector lane): generate_video / generate_image, wait with jobs_wait, download with curl.
// A generation costs credits, so generate is called at most once per start() and never retried.
import { DEFAULT_SETTINGS } from "../settings.js";
import { runProcess } from "../proc.js";

const MIN_POLL_MS = 20_000;
const CAP_MS = 30 * 60 * 1000;
const MAX_WAIT_ERRORS = 5;
const DOWNLOAD_MS = 15 * 60 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const OK = new Set(["completed", "succeeded", "success", "done", "finished"]);
const BAD = new Set(["failed", "nsfw", "ip_detected", "cancelled", "canceled", "error", "rejected"]);
const UNREACHABLE = "Couldn't reach Higgsfield to check this job; it may still be running. Run again only if you're sure it failed.";

// MCP error codes that mean the call definitely did not start a generation. Any other code
// (server_unavailable, upstream_error, unknown ones) is ambiguous for a write: it may have run.
const DEFINITE = new Set([
  "tool_error", "bad_request", "not_in_manifest", "needs_reauth", "server_not_connected", "selection_required",
  "server_not_found", "blocked_by_policy", "self_only", "approval_required", "cancelled", "rate_limited",
  "not_granted", "capability_disabled", "capability_removed", "transform_error", "consent_required",
]);
// An ambiguous failure: the job may still be running on Higgsfield, so the app says check first.
const ambiguous = (m) => Object.assign(new Error(m), { ambiguous: true });

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

const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");

const extOf = (url, kind) => {
  const m = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : kind === "lineart" ? "png" : "mp4";
};

export function makeHiggsfieldRunner({ settings = DEFAULT_SETTINGS, sleep = realSleep } = {}) {
  const call = (host, tool, input) => host.mcp.call("Higgsfield", tool, input);

  async function download(host, url, input) {
    if (!/^https:\/\//i.test(url)) throw new Error("Higgsfield returned a non-https result URL; refusing to download it.");
    if (/["%`$!^'\s]/.test(url)) throw new Error("Higgsfield returned a result URL with characters that are unsafe to pass to curl; refusing to download it.");
    const file = `${input.out}.${extOf(url, input.kind)}`;
    await host.fs.mkdir(parentOf(file));
    // An argument list, no shell: the path and URL reach curl exactly as they are.
    const r = await runProcess(host, "curl", ["-L", "--fail", "-sS", "-o", file, url], { timeout: DOWNLOAD_MS });
    if (r.code !== 0) throw new Error(`Download failed (curl exit ${r.code}): ${String(r.stderr ?? "").trim().slice(0, 200)}`);
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
      if (Math.max(slept, host.now() - t0) >= CAP_MS) throw ambiguous("Still running on Higgsfield after 30 min");
      ctx.progress(null);
      let p;
      try {
        p = await call(host, "jobs_wait", { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 15 });
      } catch (e) {
        if (!tolerateErrors) throw new Error(msg(e));
        if (++errors >= MAX_WAIT_ERRORS) throw ambiguous(UNREACHABLE);
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
      // Every job has ended but none succeeded: say so now instead of polling to the 30 min cap.
      if (p?.all_terminal === true) throw new Error(`Higgsfield job ${status || "ended"} without a result${error ? `: ${error}` : ""}`);
      const after = Number(p?.poll_after_seconds ?? p?.jobs?.[0]?.poll_after_seconds);
      pollMs = Number.isFinite(after) ? after * 1000 : MIN_POLL_MS;
    }
  }

  return {
    lane: "connector",

    async start(job, ctx) {
      const { host } = ctx;
      const { kind, prompt, out } = job.input ?? {};
      // A take folder that can't be made must fail before any credits are spent.
      if (typeof out !== "string" || !out) throw new Error("This job has no output path; not generating.");
      try { await host.fs.mkdir(parentOf(out)); } catch (e) { throw new Error(`Couldn't make the folder for this take (${msg(e)}); not generating.`); }
      const video = kind === "broll";
      const params = { model: video ? settings.videoModel : settings.imageModel, prompt, aspect_ratio: "16:9", count: 1, use_unlim: false };
      if (video) { params.mode = "pro"; params.sound = false; }
      const payload = await call(host, video ? "generate_video" : "generate_image", { params }).catch((e) => {
        const code = typeof e?.code === "string" ? e.code : null;
        throw code && !DEFINITE.has(code) ? ambiguous(msg(e)) : new Error(msg(e));
      });
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
