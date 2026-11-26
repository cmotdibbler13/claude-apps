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
export const MSG_SET_STEM_REMIXER = "Set stemRemixerDir in .studio-settings.json to your Stem Remixer folder (1.9.0 or newer).";

const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");
export const measureFileFor = (audio) => `${audio}.measure.json`;
export const stemPython = (dir) => join(dir, ".venv", "Scripts", "python.exe");
export const stemPythonw = (dir) => join(dir, ".venv", "Scripts", "pythonw.exe");

// Review Focus 5: stemRemixerDir must be set and hold Stem Remixer's own Python (pythonw for Open) before
// anything is spawned or prepared. Resolves with the folder.
export async function needStemRemixer(host, settings, { windowed = false } = {}) {
  const dir = settings?.stemRemixerDir;
  if (!dir) throw new Error(MSG_NO_STEM_REMIXER);
  if (!(await host.fs.exists((windowed ? stemPythonw : stemPython)(dir)))) throw new Error(MSG_SET_STEM_REMIXER);
  return dir;
}

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
      await needStemRemixer(host, settings);
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

// ---- hand tweaks in Stem Remixer ----
export const MSG_OPENED = "Opened in Stem Remixer";
const OPEN_GRACE_MS = 1500;

// Starts Stem Remixer on the score with the fit plan, detached, and never waits for it to close.
// Only a start that fails within graceMs (refused, crashed on start) is reported; a missing pythonw is refused first.
// exportDir: where its Export mix dialog starts (the film's own folder), so "Use this export" finds the file.
export async function openInStemRemixer(host, settings, { score, plan = null, exportDir = null }, { graceMs = OPEN_GRACE_MS } = {}) {
  const dir = await needStemRemixer(host, settings, { windowed: true });
  if (typeof score !== "string" || !score) throw new Error("There is no score take to open.");
  const args = ["main.py", "--open", score, ...(plan ? ["--plan", plan] : []), ...(exportDir ? ["--export-dir", exportDir] : [])];
  return new Promise((resolve, reject) => {
    let settled = false, err = "";
    const finish = (fn) => { if (!settled) { settled = true; fn(); } };
    let p;
    try { p = host.spawn(stemPythonw(dir), args, { cwd: dir, detached: true }); } catch (e) {
      return reject(new Error(`Stem Remixer didn't open: ${e?.message ?? e}`));
    }
    p.onErr((c) => { err = (err + String(c)).slice(-2000); });
    p.onExit((code) => finish(() => {
      if (code === 0) return resolve(MSG_OPENED);
      const why = err.trim().split(/\r?\n/).slice(-3).join(" ") || (code == null ? "it didn't start" : `it stopped (exit ${code})`);
      reject(new Error(`Stem Remixer didn't open: ${why}`));
    }));
    setTimeout(() => finish(() => resolve(MSG_OPENED)), graceMs);
  });
}

// The .wav and .mp3 files newer than sinceMs: first the film's export folder (Studio opens Stem Remixer's
// Export mix dialog there), then Stem Remixer's own folder (its dialog's usual start), each newest first.
export async function listExports(host, settings, sinceMs = 0, { exportDir = null } = {}) {
  const dir = settings?.stemRemixerDir;
  if (!dir) throw new Error(MSG_NO_STEM_REMIXER);
  const out = [];
  for (const d of [exportDir, dir].filter(Boolean)) out.push(...(await exportsIn(host, d, sinceMs, d === dir)));
  return out;
}

async function exportsIn(host, dir, sinceMs, must) {
  let entries;
  try { entries = await host.fs.list(dir); } catch {
    if (must) throw new Error(`Couldn't read ${dir}.`);
    return []; // the film's export folder is made when Stem Remixer is opened from Studio
  }
  const out = [];
  for (const e of entries) {
    if (e.isDirectory || !/\.(wav|mp3)$/i.test(e.name)) continue;
    const path = join(dir, e.name);
    let st;
    try { st = await host.fs.stat(path); } catch { continue; }
    if (!st?.isFile || !(Number(st.mtimeMs) > Number(sinceMs ?? 0))) continue;
    out.push({ path, name: e.name, when: Number(st.mtimeMs) });
  }
  return out.sort((a, b) => b.when - a.when);
}
