// Score measure and fit (gpu lane), with Stem Remixer's own Python: measure.py reads a score's loudness,
// beats and moves; fit.py renders a fit plan exactly as Stem Remixer plays it. Free and local.
import { runJsonLines } from "../proc.js";
import { join, moveAside } from "../paths.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { MSG_INTERRUPTED } from "./voicejoin.js";

const MEASURE_MS = 15 * 60 * 1000;
const FIT_MS = 30 * 60 * 1000;
const FIT_SHARE = 0.85; // of the progress bar; measuring the fitted score is the rest

export const MSG_NO_STEM_REMIXER = "Set where Stem Remixer is (stemRemixerDir in .studio-settings.json, or the Probe screen).";

const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");
export const measureFileFor = (audio) => `${audio}.measure.json`;
export const stemPython = (dir) => join(dir, ".venv", "Scripts", "python.exe");

// The measure as cached: everything measure.py printed except "done".
const strip = ({ done, ...rest }) => { void done; return rest; };

export function makeStemFitRunner({ settings = DEFAULT_SETTINGS } = {}) {
  const run = (host, script, args, { timeout, onProgress }) => {
    const dir = settings.stemRemixerDir;
    return runJsonLines(host, stemPython(dir), [join(dir, script), ...args], {
      cwd: dir, name: script === "fit.py" ? "The score fit" : "The score measure", timeout, onProgress,
    });
  };
  const measureTo = async (host, audio, cacheFile, onProgress) => {
    const m = strip(await run(host, "measure.py", [audio], { timeout: MEASURE_MS, onProgress }));
    const part = cacheFile + ".part";
    await host.fs.mkdir(parentOf(cacheFile));
    await host.fs.write(part, JSON.stringify(m));
    await host.fs.rename(part, cacheFile);
    return m;
  };

  return {
    lane: "gpu",
    async start(job, ctx) {
      const { host } = ctx;
      if (!settings.stemRemixerDir) throw new Error(MSG_NO_STEM_REMIXER);
      const { score, plan, out, measureOnly, measureOut } = job.input ?? {};
      if (typeof score !== "string" || !score) throw new Error("This job has no score.");

      if (measureOnly) {
        const cache = measureOut || measureFileFor(score);
        const m = await measureTo(host, score, cache, (p) => ctx.progress(p));
        return { file: cache, meta: { measureFile: cache, lengthS: m.duration_s ?? null } };
      }

      if (typeof out !== "string" || !/\.wav$/i.test(out)) throw new Error("This fit has no .wav output path; not rendering.");
      if (!Array.isArray(plan?.steps) || !plan.steps.length) throw new Error("This fit has no plan.");
      const mixDir = parentOf(out);
      const planFile = join(mixDir, "plan.json");
      const cache = measureFileFor(out);
      await host.fs.mkdir(mixDir);
      // fit.py writes atomically but keeps no earlier output: move the last fit aside first.
      for (const f of [out, cache, planFile]) await moveAside(host, f);
      await host.fs.write(planFile, JSON.stringify({ steps: plan.steps }, null, 2));
      const r = await run(host, "fit.py", [score, planFile, out], { timeout: FIT_MS, onProgress: (p) => ctx.progress(p * FIT_SHARE) });
      if (!(await host.fs.exists(out))) throw new Error("The score fit finished but no fitted score was saved.");
      const m = await measureTo(host, out, cache, (p) => ctx.progress(FIT_SHARE + p * (1 - FIT_SHARE)));
      const meta = { lengthS: r.length_s ?? m.duration_s ?? null, measureFile: cache, plan: planFile };
      if (r.turned_down != null) meta.turnedDown = r.turned_down;
      return { file: out, meta };
    },
    async resume() { throw new Error(MSG_INTERRUPTED); },
  };
}
