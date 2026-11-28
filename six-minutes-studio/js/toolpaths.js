// Where the command-line tools are. Studio sets this from settings at boot; call sites ask tool("ffmpeg").
// setToolPaths({}) restores the defaults (bare names, found on PATH).
let paths = {};

export function setToolPaths(p = {}) {
  paths = { ...(p ?? {}) };
}

export function tool(name) {
  const ffmpeg = String(paths.ffmpegPath ?? "").trim() || "ffmpeg";
  if (name === "ffmpeg") return ffmpeg;
  if (name === "ffprobe") {
    // A full path to ffmpeg.exe: ffprobe lives in the same folder. A bare name stays bare.
    const m = /^(.*[\\/])ffmpeg(\.exe)?$/i.exec(ffmpeg);
    return m ? `${m[1]}ffprobe${m[2] ?? ""}` : "ffprobe";
  }
  return name;
}
