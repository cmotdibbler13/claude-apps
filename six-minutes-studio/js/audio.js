// Audio measuring and SFX finishing with ffmpeg (argument lists, no shell).
import { runProcess } from "./proc.js";

const FFMPEG_MS = 5 * 60 * 1000;
const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? "";

export function parseMeasure(stderr) {
  const s = String(stderr ?? "");
  const num = (re) => { const m = s.match(re); return m ? Number(m[1]) : null; };
  const d = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    lengthS: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    peakDb: num(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/),
    meanDb: num(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/),
  };
}

// Near-silent: peak below -30 dBFS or mean below -50 dB. Unknown values do not count.
export function isQuiet({ peakDb, meanDb }) {
  return (peakDb != null && peakDb < -30) || (meanDb != null && meanDb < -50);
}

export async function measure(host, file) {
  const r = await runProcess(host, "ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { timeout: FFMPEG_MS });
  if (r.code !== 0) throw new Error(`Couldn't measure ${base(file)}`);
  const m = parseMeasure(r.stderr);
  return { ...m, quiet: isQuiet(m) };
}

const TRIM = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02";
const FILTER = `${TRIM},areverse,${TRIM},areverse,afade=t=in:d=0.01,areverse,afade=t=in:d=0.01,areverse`;

export async function finishSfx(host, src, out) {
  const part = out.replace(/\.wav$/, ".part.wav");
  const discard = async () => { try { if (await host.fs.exists(part)) await host.fs.trash(part); } catch { /* best effort */ } };
  let r;
  try {
    r = await runProcess(host, "ffmpeg", ["-y", "-i", src, "-af", FILTER, "-ar", "48000", "-c:a", "pcm_s16le", part], { timeout: FFMPEG_MS });
  } catch (e) { await discard(); throw e; }
  if (r.code !== 0) {
    await discard();
    throw new Error(`ffmpeg failed (code ${r.code}):\n${String(r.stderr ?? "").trim().split(/\r?\n/).slice(-5).join("\n")}`);
  }
  if (!(await host.fs.exists(part))) throw new Error("ffmpeg finished but the sound effect file was not created.");
  try { await host.fs.rename(part, out); } catch (e) { await discard(); throw e; }
  return { file: out };
}

export function projectOf(filmDir) {
  return base(filmDir).replace(/[^A-Za-z0-9_-]/g, "_");
}
