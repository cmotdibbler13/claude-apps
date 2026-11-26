// Preview helpers: 640px ffmpeg proxies for video, blob URLs for the webview, open-in-default-app.
import { join } from "./paths.js";

const VIDEO = new Set(["mp4", "mov", "webm", "mkv"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const MIME = {
  mp4: "video/mp4", webm: "video/webm",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};
const UNSAFE = /["%&|<>^`$!]/;
const TEN_MIN = 10 * 60 * 1000;

const split = (file) => {
  const i = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  const dir = i < 0 ? "" : file.slice(0, i);
  const base = file.slice(i + 1);
  const d = base.lastIndexOf(".");
  return { dir, name: d < 0 ? base : base.slice(0, d), ext: d < 0 ? "" : base.slice(d + 1).toLowerCase() };
};

const mtimeOf = async (host, p) => {
  try { return (await host.fs.stat(p)).mtimeMs ?? 0; } catch { return null; }
};

const inflight = new Map();

async function build(host, file, dir, name) {
  const out = join(dir, "proxy", `${name}_640.mp4`);
  const src = await mtimeOf(host, file);
  const have = await mtimeOf(host, out);
  if (have !== null && src !== null && have >= src) return out;
  if (UNSAFE.test(file) || UNSAFE.test(out)) {
    throw new Error("The file path contains characters that are unsafe for the shell (\" % & | < > ^ ` $ !); rename it to make a preview.");
  }
  await host.fs.mkdir(join(dir, "proxy"));
  const r = await host.exec(`ffmpeg -y -i "${file}" -vf scale=640:-2 -c:v libx264 -crf 28 -an "${out}"`, { timeout: TEN_MIN });
  if (r.code !== 0) {
    const tail = String(r.stderr ?? "").trim().split(/\r?\n/).slice(-5).join("\n");
    throw new Error(`ffmpeg failed (code ${r.code}):\n${tail}`);
  }
  if (!(await host.fs.exists(out))) throw new Error("ffmpeg finished but the proxy file was not created.");
  return out;
}

export function ensureProxy(host, file) {
  const { dir, name, ext } = split(file);
  if (IMAGE.has(ext)) return Promise.resolve(file);
  if (!VIDEO.has(ext)) return Promise.reject(new Error("Can't preview this file type"));
  if (inflight.has(file)) return inflight.get(file);
  const p = build(host, file, dir, name).finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

const blobs = new Map(); // path -> { mtime, url }

export async function toBlobUrl(host, file) {
  const { ext } = split(file);
  const mime = MIME[ext] ?? (ext === "mov" || ext === "mkv" ? "video/mp4" : "application/octet-stream");
  const mtime = await mtimeOf(host, file);
  const hit = blobs.get(file);
  if (hit && hit.mtime === mtime) return hit.url;
  const bytes = await host.fs.read(file);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  if (hit) URL.revokeObjectURL(hit.url);
  blobs.set(file, { mtime, url });
  return url;
}

export function revokeAll() {
  for (const { url } of blobs.values()) URL.revokeObjectURL(url);
  blobs.clear();
}

export const openFull = (host, file) => host.open(file);
