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

// ---- hand tweaks in Stem Remixer ----
export const stemPythonw = (dir) => join(dir, ".venv", "Scripts", "pythonw.exe");
export const MSG_OPENED = "Opened in Stem Remixer";
const OPEN_GRACE_MS = 1500;

// Starts Stem Remixer on the score with the fit plan, detached, and never waits for it to close.
// Only a start that fails within graceMs (pythonw missing, refused) is reported.
export function openInStemRemixer(host, settings, { score, plan = null }, { graceMs = OPEN_GRACE_MS } = {}) {
  const dir = settings?.stemRemixerDir;
  if (!dir) return Promise.reject(new Error(MSG_NO_STEM_REMIXER));
  if (typeof score !== "string" || !score) return Promise.reject(new Error("There is no score take to open."));
  const args = ["main.py", "--open", score, ...(plan ? ["--plan", plan] : [])];
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

// Stem Remixer's Export mix dialog opens in its own folder (the app's working folder): the .wav and .mp3
// files there newer than sinceMs, newest first.
export async function listExports(host, settings, sinceMs = 0) {
  const dir = settings?.stemRemixerDir;
  if (!dir) throw new Error(MSG_NO_STEM_REMIXER);
  let entries;
  try { entries = await host.fs.list(dir); } catch { throw new Error(`Couldn't read ${dir}.`); }
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
