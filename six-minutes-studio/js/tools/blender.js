// Blender runner (gpu lane): Claude writes a Python scene script, Blender renders it headless.
// Claude never chooses the output path; the runner passes source and output after "--".
import { askJson } from "../claude.js";
import { join } from "../paths.js";
import { DEFAULT_SETTINGS } from "../settings.js";

const INSTRUCTIONS = `You write a Blender Python script (bpy) for one shot of a documentary film.
Build the scene with Blender's Python API from the shot description: asset.desc says whether it is a 3D line-art version of the source line-art image or a 3D model of a place.
The script runs as: blender -b -P script.py -- <source> <output>. Read both paths from sys.argv after "--": source = sys.argv[sys.argv.index("--") + 1], output = sys.argv[sys.argv.index("--") + 2]. Never hard-code either path.
Render an MP4 (H.264, FFMPEG container) at 1920x1080, 24 fps, with frame_start = 1 and frame_end = frames, to the output path.
Look: Six Minutes On... Thin brass/amber (#d5a867) or white lines on a dark navy world (#03070c to #091a2e). Slow, deliberate camera movement.
The script MUST NOT use the network, MUST NOT delete or overwrite any file other than the output path, and MUST NOT read any file other than the source image.
If a previous script and a note are given, change the previous script to follow the note and keep everything else the same.
Reply with JSON only: {"script": "<the full Python script>", "frames": <integer from 1 to 2400, the number of frames to render>}. Do not include an output path.`;

function validate(v) {
  if (!v || typeof v !== "object") throw new Error("expected an object");
  if (typeof v.script !== "string" || !v.script.trim()) throw new Error("script is empty");
  if (!Number.isInteger(v.frames) || v.frames < 1 || v.frames > 2400) throw new Error("frames must be a whole number from 1 to 2400");
}

// Returns the path of the written script. The frame count (needed for job.input.frames) is
// passed to the optional onFrames callback.
export async function writeBlenderScript(host, store, asset, take, { note, previous, onFrames } = {}) {
  const redo = note != null || previous != null;
  const data = { asset: { id: asset.id, desc: asset.desc, line: asset.line }, take };
  if (previous != null) data.previousScript = previous;
  if (note != null) data.note = note;
  const r = await askJson(host, { instructions: INSTRUCTIONS, data, tier: redo ? "quick" : "default", validate });
  const path = join(store.dir, "studio", "blender", `${asset.id}_t${take}.py`);
  await host.fs.write(path, r.script);
  if (onFrames) onFrames(r.frames);
  return path;
}

const FRA = /Fra:(\d+)/g;

export function makeBlenderRunner({ settings = DEFAULT_SETTINGS } = {}) {
  return {
    lane: "gpu",
    async start(job, ctx) {
      const { script, sourceFile, out, frames } = job.input;
      const { host } = ctx;
      // A leftover file at out (earlier interrupted run) must not pass for this run's result. Move it aside, never delete.
      if (await host.fs.exists(out)) await host.fs.rename(out, out.replace(/\.mp4$/i, "") + `.stale-${host.now()}.mp4`);
      return new Promise((resolve, reject) => {
        const tail = [];
        let partial = "", errText = "", last = -1;
        const feed = (chunk) => {
          partial += String(chunk);
          const lines = partial.split(/\r?\n|\r/);
          partial = lines.pop();
          for (const line of lines) {
            if (!line) continue;
            tail.push(line);
            if (tail.length > 20) tail.shift();
            for (const m of line.matchAll(FRA)) {
              if (!(frames > 0)) continue;
              const p = Math.min(1, Math.max(0, Number(m[1]) / frames));
              // Blender prints several lines per frame: report only moves of 1 % or more (and the end).
              if (p - last >= 0.01 || (p === 1 && last !== 1)) { last = p; ctx.progress(p); }
            }
          }
        };
        const p = host.spawn(settings.blenderPath, ["-b", "--python-exit-code", "1", "-P", script, "--", sourceFile, out]);
        p.onOut((c) => feed(c));
        p.onErr((c) => { errText = String(c); feed(c); });
        p.onExit(async (code) => {
          try {
            if (partial) feed("\n");
            if (code === null || code === undefined) {
              return reject(new Error(`Blender didn't start: ${errText || "no reason given"}. Check the Blender path in .studio-settings.json.`));
            }
            const log = tail.join("\n");
            if (code !== 0) return reject(new Error(`Blender stopped with exit code ${code}.\n${log}`));
            if (!(await host.fs.exists(out))) return reject(new Error(`Blender finished but didn't write an output file.\n${log}`));
            resolve({ file: out });
          } catch (e) { reject(e); }
        });
      });
    },
  };
}

export const blenderRunner = makeBlenderRunner();
