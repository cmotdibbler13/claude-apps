// Higgsfield runner (connector lane): generate_video / generate_image, wait with jobs_wait, download with curl.
// A generation costs credits, so generate is called at most once per start() and never retried.
import { DEFAULT_SETTINGS } from "../settings.js";
import { runProcess } from "../proc.js";
import { tool } from "../toolpaths.js";
import { uploadMedia } from "./hfmedia.js";
import { clipAudioArgs, clipAudioFile, audioSigOf } from "./clipaudio.js";
import { portraitParams, clipParams } from "../presenter.js";

const FFMPEG_MS = 5 * 60 * 1000;

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
export const DEFINITE = new Set([
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

const VIDEO_EXT = ["mp4", "mov", "webm"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
const isImage = (kind) => kind === "lineart" || kind === "portrait";
const allowedExt = (kind) => (isImage(kind) ? IMAGE_EXT : VIDEO_EXT);
const urlExt = (url) => url.split(/[?#]/)[0].match(/\/[^/]*\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase() ?? null;
const isUrl = (v) => typeof v === "string" && /^https?:\/\//i.test(v);

// Result URL: the known keys first (url, result_url, results[].url, outputs[].url, video_url, image_url),
// then any other URL in the reply. A URL must end in a video extension for b-roll and an image extension
// for line art; a known key without an extension is accepted and saved with the kind's default.
function parseEntry(p, kind) {
  const e = p?.jobs?.[0] ?? p?.results?.[0] ?? p ?? {};
  const status = String(e.status ?? e.state ?? "").toLowerCase();
  const known = [e.url, e.result_url, ...(Array.isArray(e.results) ? e.results.map((r) => r?.url) : []),
    ...(Array.isArray(e.outputs) ? e.outputs.map((r) => r?.url) : []), e.video_url, e.image_url].filter(isUrl);
  let s = ""; try { s = JSON.stringify(e) ?? ""; } catch { /* ignore */ }
  const scraped = s.match(/https?:\/\/[^\s"\\<>]+/gi) ?? [];
  const ok = allowedExt(kind);
  const url = known.find((u) => ok.includes(urlExt(u)))
    ?? known.find((u) => urlExt(u) === null)
    ?? scraped.find((u) => ok.includes(urlExt(u)))
    ?? null;
  return { status, error: typeof e.error === "string" ? e.error : e.error?.message, url, anyUrl: known.length > 0 || scraped.length > 0 };
}

const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");

const extOf = (url, kind) => {
  const ext = urlExt(url);
  return allowedExt(kind).includes(ext) ? ext : isImage(kind) ? "png" : "mp4";
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
      const { status, error, url, anyUrl } = parseEntry(p, job.input?.kind);
      if (BAD.has(status)) throw new Error(`Higgsfield job ${status}${error ? `: ${error}` : ""}`);
      if (OK.has(status) || (!status && anyUrl)) {
        if (!url) {
          const what = isImage(job.input?.kind) ? "image" : "video";
          throw new Error(anyUrl ? `Higgsfield finished but returned no ${what} result URL.` : "Higgsfield finished but returned no result URL.");
        }
        const r = await download(host, url, job.input);
        // A portrait's Higgsfield job id is the media value later used as a clip's start_image.
        if (job.input?.kind === "portrait") return { ...r, meta: { hfId: jobId } };
        if (job.input?.kind === "presenter") {
          // The cut audio is on disk beside the take, so a resumed job gets its signature too.
          const { start, end, out } = job.input;
          let audioSig;
          try { audioSig = await audioSigOf(host, clipAudioFile(out), end - start); } catch { audioSig = undefined; }
          return { ...r, meta: { hfId: jobId, ...(audioSig ? { audioSig } : {}) } };
        }
        return { ...r, meta: { hfId: jobId } };
      }
      // Every job has ended but none succeeded: say so now instead of polling to the 30 min cap.
      if (p?.all_terminal === true) throw new Error(`Higgsfield job ${status || "ended"} without a result${error ? `: ${error}` : ""}`);
      const after = Number(p?.poll_after_seconds ?? p?.jobs?.[0]?.poll_after_seconds);
      pollMs = Number.isFinite(after) ? after * 1000 : MIN_POLL_MS;
    }
  }

  async function generate(job, ctx, tool, params) {
    const { host } = ctx;
    const payload = await call(host, tool, { params }).catch((e) => {
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
  }

  // Cut the line's audio, upload it, then generate. Everything free happens first, so a failure
  // in any of it spends no credits; generate_video is called once and never retried.
  async function startPresenter(job, ctx) {
    const { host } = ctx;
    const { voiceover, start, end, seconds, hfId, prompt, out } = job.input;
    const r = await runProcess(host, tool("ffmpeg"), clipAudioArgs({ wav: voiceover, start, end, seconds, out }), { timeout: FFMPEG_MS });
    const audio = clipAudioFile(out);
    if (r.code !== 0 || !(await host.fs.exists(audio))) {
      throw new Error(`ffmpeg couldn't cut this line's audio (code ${r.code}): ${String(r.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" ")}; not generating.`);
    }
    const audioId = await uploadMedia(host, audio, "audio");
    const params = { ...clipParams({ seconds, prompt }), medias: [{ value: hfId, role: "start_image" }, { value: audioId, role: "audio_references" }] };
    return generate(job, ctx, "generate_video", params);
  }

  return {
    lane: "connector",

    async start(job, ctx) {
      const { host } = ctx;
      const { kind, prompt, out } = job.input ?? {};
      // A take folder that can't be made must fail before any credits are spent.
      if (typeof out !== "string" || !out) throw new Error("This job has no output path; not generating.");
      try { await host.fs.mkdir(parentOf(out)); } catch (e) { throw new Error(`Couldn't make the folder for this take (${msg(e)}); not generating.`); }
      if (kind === "presenter") return startPresenter(job, ctx);
      const video = kind === "broll";
      const portrait = kind === "portrait";
      const params = portrait ? portraitParams(prompt) : { model: video ? settings.videoModel : settings.imageModel, prompt, aspect_ratio: "16:9", count: 1, use_unlim: false };
      if (video) { params.mode = "pro"; params.sound = false; }
      if (portrait) {
        // Uploads are free and happen before generate, so a failure here is a plain failure.
        params.medias = [];
        for (const photo of job.input.photos ?? []) params.medias.push({ value: await uploadMedia(host, photo, "image"), role: "image_references" });
      }
      return generate(job, ctx, video ? "generate_video" : "generate_image", params);
    },

    async resume(job, ctx) {
      if (!job.jobRef) throw new Error("Cannot resume: no jobRef stored for this job.");
      return waitAndDownload(job, ctx, job.jobRef, { tolerateErrors: true });
    },
  };
}

export const higgsfieldRunner = makeHiggsfieldRunner();
