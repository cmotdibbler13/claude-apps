// Installs and checks Autocue Studio's join files (voiceover_join.py, line_script.py) on Jon's PC from the
// copies Studio carries (js/autocue-bundle.js). Earlier copies are renamed aside, never deleted.
import { AUTOCUE_FILES } from "./autocue-bundle.js";
import { join } from "./paths.js";

export const INSTALL_HINT = "Open Probe and press Install join script.";
const norm = (t) => String(t ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
const stamp = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// { state: "ok" | "missing" | "outdated", files: [names not matching], takeChecksOld: boolean }
export async function autocueJoinState(host, dir) {
  const files = [];
  let missing = false;
  for (const [name, text] of Object.entries(AUTOCUE_FILES)) {
    const p = join(dir, name);
    if (!(await host.fs.exists(p))) { missing = true; files.push(name); continue; }
    let have = null;
    try { have = await host.fs.read(p, "utf8"); } catch { /* unreadable counts as out of date */ }
    if (norm(have) !== norm(text)) files.push(name);
  }
  // voiceover_join.py needs take_checks.decode(path, rate); Studio doesn't replace Autocue's own take_checks.py.
  let takeChecksOld = false;
  try { takeChecksOld = !/def decode\(path,\s*rate/.test(await host.fs.read(join(dir, "take_checks.py"), "utf8")); }
  catch { takeChecksOld = true; }
  const state = files.length ? (missing ? "missing" : "outdated") : "ok";
  return { state, files, takeChecksOld };
}

// Writes Studio's copies into dir. Each existing file is first renamed <name>.before-<stamp>.py.
export async function installAutocueJoin(host, dir) {
  if (!dir || !(await host.fs.exists(dir))) throw new Error(`Autocue Studio's folder isn't there (${dir || "autocueDir"}). Set autocueDir in .studio-settings.json.`);
  const done = [];
  for (const [name, text] of Object.entries(AUTOCUE_FILES)) {
    const p = join(dir, name);
    if (await host.fs.exists(p)) {
      let have = null;
      try { have = await host.fs.read(p, "utf8"); } catch { /* replace it */ }
      if (norm(have) === norm(text)) continue;
      await host.fs.rename(p, join(dir, name.replace(/\.py$/, `.before-${stamp(host.now())}.py`)));
    }
    await host.fs.write(p, text);
    done.push(name);
  }
  return done;
}

// A join that failed because its script is missing or older than Studio: add how to fix it.
export function joinFailureHint(message) {
  const m = String(message ?? "");
  return /unrecognized arguments|can't open file|No module named 'line_script'|ImportError|cannot import name/i.test(m)
    ? `${m} Your join script is missing or out of date. ${INSTALL_HINT}` : m;
}
