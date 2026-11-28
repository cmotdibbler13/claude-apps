// Checks shared by Probe and the program finder: a program answers --version, Stem Remixer is complete.
import { runProcess } from "./proc.js";
import { join } from "./paths.js";
import { MSG_SET_STEM_REMIXER, stemPython } from "./tools/stemfit.js";

// The same way the app runs them: spawn with an argument list, no shell.
export const cmdCheck = (cmd, args) => async (host) => {
  const r = await runProcess(host, cmd, args, { timeout: 15000 });
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
};

// Stem Remixer: its own Python plus fit.py and measure.py (1.9.0 or newer). Never starts it.
const NEED_VERSION = [1, 9, 0];
const older = (v, want) => {
  const a = String(v).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < want.length; i++) if ((a[i] ?? 0) !== want[i]) return (a[i] ?? 0) < want[i];
  return false;
};
export const stemRemixerCheck = (dir) => async (host) => {
  if (!dir) throw new Error(MSG_SET_STEM_REMIXER);
  if (!(await host.fs.exists(dir))) throw new Error(`No folder at ${dir}. ${MSG_SET_STEM_REMIXER}`);
  if (!(await host.fs.exists(stemPython(dir)))) {
    throw new Error(`Stem Remixer's Python isn't at ${stemPython(dir)}. Run Install.cmd in ${dir}, then Probe again.`);
  }
  for (const f of ["fit.py", "measure.py"]) {
    if (!(await host.fs.exists(join(dir, f)))) throw new Error(`${f} isn't in ${dir}. Press Update in Stem Remixer (1.9.0 or newer).`);
  }
  let v = null;
  try { v = String(await host.fs.read(join(dir, "VERSION"), "utf8")).trim() || null; } catch { /* no VERSION file */ }
  if (v && older(v, NEED_VERSION)) throw new Error(`Stem Remixer is ${v}; update it to 1.9.0 or newer (its Update button)`);
  return v ? `Stem Remixer ${v}` : "ready";
};
