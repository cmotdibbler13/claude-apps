// Voiceover join (gpu lane): Autocue Studio's voiceover_join.py joins Jon's approved takes into one voiceover.
// It moves its own earlier outputs aside. Free and local, so an interrupted join is simply run again.
import { runJsonLines } from "../proc.js";
import { join } from "../paths.js";
import { DEFAULT_SETTINGS } from "../settings.js";

const JOIN_MS = 60 * 60 * 1000;
export const MSG_INTERRUPTED = "Interrupted; run it again.";

export function joinArgs(settings, { script, takes, out, allowFlagged }) {
  const args = [join(settings.autocueDir, "voiceover_join.py"), "--script", script, "--takes", takes, "--out", out];
  if (allowFlagged) args.push("--allow-flagged");
  return args;
}

export function makeVoiceJoinRunner({ settings = DEFAULT_SETTINGS } = {}) {
  return {
    lane: "gpu",
    async start(job, ctx) {
      const { host } = ctx;
      const input = job.input ?? {};
      for (const k of ["script", "takes", "out"]) {
        if (typeof input[k] !== "string" || !input[k]) throw new Error(`This join has no ${k} path.`);
      }
      if (!settings.autocueDir) throw new Error("Set where Autocue Studio is (autocueDir in .studio-settings.json).");
      await host.fs.mkdir(input.out);
      const r = await runJsonLines(host, settings.autocuePython || "python", joinArgs(settings, input), {
        cwd: settings.autocueDir, name: "The voiceover join", timeout: JOIN_MS,
        onProgress: (p) => ctx.progress(p),
      });
      return {
        file: r.wav,
        meta: {
          wav: r.wav, csv: r.csv, transcript: r.transcript, lengthS: r.length_s,
          tightened: r.tightened ?? [], extra: r.extra ?? [], silent: r.silent ?? [],
        },
      };
    },
    async resume() { throw new Error(MSG_INTERRUPTED); },
  };
}
