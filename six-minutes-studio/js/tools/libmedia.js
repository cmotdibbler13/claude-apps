// ffprobe / ffmpeg helpers for the B-roll library (argument lists, no shell).
import { runProcess } from "../proc.js";
import { tool } from "../toolpaths.js";

const base = (p) => String(p).split(/[\\/]/).pop();
const lastLine = (s) => String(s).trim().split(/\r?\n/).pop() || "";

export async function probeClip(host, file) {
  const name = base(file);
  const fail = (why) => new Error(`Couldn't read ${name}: ${why}`);
  const r = await runProcess(host, tool("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", file], { timeout: 60000 }).catch((e) => { throw fail(e.message); });
  if (r.code !== 0) throw fail(lastLine(r.stderr) || `ffprobe exit code ${r.code}`);
  let j;
  try { j = JSON.parse(r.stdout); } catch { throw fail("ffprobe gave no readable result"); }
  const s = j?.streams?.[0];
  const duration = Number(j?.format?.duration);
  const [n, d] = String(s?.r_frame_rate ?? "").split("/").map(Number);
  const fps = n / (d === undefined ? 1 : d);
  if (s && !(fps > 0)) throw fail("no frame rate");
  if (!s || !Number.isFinite(duration) || !Number.isFinite(fps) || !Number.isInteger(s.width) || !Number.isInteger(s.height)) throw fail("no video stream found");
  const st = await host.fs.stat(file).catch((e) => { throw fail(e?.message ?? e); });
  return {
    duration_s: Math.round(duration * 100) / 100,
    width: s.width,
    height: s.height,
    fps: Math.round(fps * 10) / 10,
    size_mb: Math.round((st.size / 1048576) * 10) / 10,
  };
}

async function ffmpeg(host, args) {
  const r = await runProcess(host, tool("ffmpeg"), args, { timeout: 300000 });
  if (r.code !== 0) throw new Error(lastLine(r.stderr) || `ffmpeg stopped with exit code ${r.code}`);
}

export async function makeThumb(host, src, out) {
  for (const ss of ["1", "0"]) {
    await ffmpeg(host, ["-y", "-ss", ss, "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", out]);
    if (await host.fs.exists(out)) return;
  }
  throw new Error(`Couldn't make a thumbnail for ${base(src)}`);
}

const WIN_FONT = "C:/Windows/Fonts/arial.ttf";
export async function windowsFont(host) {
  try { return (await host.fs.exists(WIN_FONT)) ? WIN_FONT : null; } catch { return null; }
}

// Resolves { labelled: true } when the ids were drawn; if that run fails, tries once more with plain tiles.
export async function contactSheet(host, items, out, { fontfile } = {}) {
  if (!items?.length) throw new Error("No thumbnails for the contact sheet.");
  for (const it of items) if (!/^BR-\d+$/.test(String(it.id))) throw new Error(`Contact sheet id must look like BR-123, got "${it.id}".`);
  const font = fontfile ? `fontfile='${String(fontfile).replace(/\\/g, "/").replace(/:/g, "\\:")}':` : "";
  const build = (label) => {
    const n = items.length, rows = Math.ceil(n / 4), total = Math.max(rows * 4, 2);
    const parts = items.map((it, i) => `[${i}:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2${label ? `,drawtext=${font}text='${it.id}':x=8:y=h-th-8:fontcolor=white:fontsize=20:box=1:boxcolor=black@0.5` : ""}[v${i}]`);
    for (let i = n; i < total; i++) parts.push(`color=c=black:s=320x180:d=1[v${i}]`);
    const layout = Array.from({ length: total }, (_, i) => `${(i % 4) * 320}_${Math.floor(i / 4) * 180}`).join("|");
    const ins = Array.from({ length: total }, (_, i) => `[v${i}]`).join("");
    parts.push(`${ins}xstack=inputs=${total}:layout=${layout}[sheet]`);
    const args = ["-y"];
    for (const it of items) args.push("-i", it.thumb);
    args.push("-filter_complex", parts.join(";"), "-map", "[sheet]", "-frames:v", "1", out);
    return args;
  };
  try { await ffmpeg(host, build(true)); return { labelled: true }; } catch { /* drawtext can fail on a missing font */ }
  await ffmpeg(host, build(false));
  return { labelled: false };
}
