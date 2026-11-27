// Higgsfield media helpers: upload a local file (free) and ask what a generation would cost.
import { runProcess } from "../proc.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UPLOAD_MS = 10 * 60 * 1000;
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", wav: "audio/wav", mp3: "audio/mpeg" };
const msg = (e) => String(e?.message ?? e);
const parse = (p) => { if (typeof p !== "string") return p; try { return JSON.parse(p); } catch { return p; } };
const call = (host, tool, input) => host.mcp.call("Higgsfield", tool, input);

// Signed upload URLs contain % (percent-encoding), so only quotes, backticks, whitespace, $, ! and ^ are refused.
export async function uploadMedia(host, file, type) {
  const filename = String(file).split(/[\\/]/).pop();
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  const contentType = TYPES[ext];
  if (!contentType) throw new Error(`Can't upload ${filename}: unsupported file type (png, jpg, webp, wav or mp3).`);
  const reply = parse(await call(host, "media_upload", { files: [{ filename, content_type: contentType }] }));
  const up = reply?.uploads?.[0];
  const url = up?.upload_url;
  if (typeof url !== "string" || !url) throw new Error("Upload to Higgsfield failed: no upload URL was returned.");
  if (!/^https:\/\//i.test(url)) throw new Error("Upload to Higgsfield failed: the upload URL isn't https; refusing to use it.");
  if (/["`$!^'\s]/.test(url)) throw new Error("Upload to Higgsfield failed: the upload URL has characters that are unsafe to pass to curl; refusing to use it.");
  const mediaId = up.media_id ?? up.id ?? url.split(/[?#]/)[0].match(UUID_RE)?.[0];
  if (!mediaId) throw new Error("Upload to Higgsfield failed: no media id was returned.");
  let r;
  try {
    r = await runProcess(host, "curl", ["-sS", "--fail", "-X", "PUT", "-T", file, "-H", `Content-Type: ${contentType}`, "-H", "If-None-Match: *", url], { timeout: UPLOAD_MS });
  } catch (e) { throw new Error(`Upload to Higgsfield failed: ${msg(e)}`); }
  if (r.code !== 0) throw new Error(`Upload to Higgsfield failed (curl exit ${r.code}): ${String(r.stderr ?? "").trim().slice(0, 200)}`);
  await call(host, "media_confirm", { media_id: String(mediaId), type });
  return String(mediaId);
}

// Credits a generation would cost, or null when the estimate can't be had.
export async function estimateCredits(host, tool, params) {
  try {
    const n = Number(parse(await call(host, tool, params))?.cost?.credits);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
