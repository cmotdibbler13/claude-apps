// Probe view: checks the PC and connectors. Never calls a generate tool.
import { runProcess } from "../proc.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { autocueJoinState, installAutocueJoin } from "../autocueinstall.js";
import { i2vReady } from "../tools/comfyui.js";
import { stableAudioState, MSG_MUSIC } from "../tools/stableaudio.js";
import { join } from "../paths.js";
import { MSG_SET_STEM_REMIXER, stemPython } from "../tools/stemfit.js";

const ROOT = "S:\\Youtube video ideas\\";
const UNC = "\\\\192.168.1.171\\jon\\Youtube video ideas\\";

const listCheck = (path) => async (host) => {
  const entries = await host.fs.list(path);
  return `${entries.length} entries`;
};
// The same way the app runs them: spawn with an argument list, no shell.
const cmdCheck = (cmd, args) => async (host) => {
  const r = await runProcess(host, cmd, args, { timeout: 15000 });
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
};

// ComfyUI: curl GET <url>/system_stats, then the workflow file the runner will load.
const comfyCheck = (comfy) => async (host) => {
  const url = String(comfy.url || DEFAULT_SETTINGS.comfy.url).replace(/\/+$/, "");
  const r = await runProcess(host, "curl", ["-sS", "--fail", `${url}/system_stats`], { timeout: 15000 });
  if (r.code !== 0) throw Object.assign(new Error(`Not running (exit ${r.code}: ${(r.stderr || r.stdout).trim()})`), { start: "comfy" });
  let version = null;
  try { version = JSON.parse(r.stdout)?.system?.comfyui_version ?? null; } catch { /* not JSON: still running */ }
  if (!comfy.workflow) throw new Error("Workflow path not set yet; open Films first");
  if (!(await host.fs.exists(comfy.workflow))) throw new Error(`Workflow not found: ${comfy.workflow}`);
  return typeof version === "string" && version ? `ComfyUI ${version}` : "running";
};

// Animate workflow: the image-to-video workflow file and its image, prompt and output nodes.
// Optional: not set up is a neutral row, not a failure.
export const MSG_ANIMATE_NOT_SET = "Not set up (only needed for Animate with ComfyUI)";
const animateCheck = (comfy) => async (host) => {
  const r = await i2vReady(host, comfy);
  if (!r.ok) throw Object.assign(new Error(`${MSG_ANIMATE_NOT_SET}: ${r.why}`), { neutral: true });
  return "ready";
};

// Stable Audio: the page title says Small SFX and /gradio_api/info lists /generate. Never starts it.
const stableAudioCheck = (sa) => async (host) => {
  const s = await stableAudioState(host, sa);
  if (s === "ready") return "Ready";
  if (s === "off") throw Object.assign(new Error("Off: press Start now below, or Start Stable Audio on a film's Review"), { start: "stableAudio" });
  if (s === "music") throw new Error(MSG_MUSIC);
  throw new Error(`Not ready: look at Stable Audio in Pinokio (${sa.url})`);
};

// Stem Remixer: its own Python plus fit.py and measure.py (1.9.0 or newer). Never starts it.
export { MSG_SET_STEM_REMIXER };
const NEED_VERSION = [1, 9, 0];
const older = (v, want) => {
  const a = String(v).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < want.length; i++) if ((a[i] ?? 0) !== want[i]) return (a[i] ?? 0) < want[i];
  return false;
};
const stemRemixerCheck = (dir) => async (host) => {
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

// The join files Studio carries must match the ones in Autocue Studio's folder; Install join script fixes it.
export const MSG_JOIN_MISSING = "The join script isn't installed. Press Install join script below.";
export const MSG_JOIN_OLD = "The join script is out of date. Press Install join script below.";
export const MSG_TAKE_CHECKS_OLD = "take_checks.py in Autocue Studio is older than the join needs. Copy autocue-studio\\take_checks.py from the repo into it.";
const autocueJoinCheck = (dir) => async (host) => {
  if (!dir || !(await host.fs.exists(dir))) throw new Error(`Autocue Studio's folder isn't there (${dir || "autocueDir"}). Set autocueDir in .studio-settings.json.`);
  const st = await autocueJoinState(host, dir);
  if (st.state === "missing") throw Object.assign(new Error(MSG_JOIN_MISSING), { install: true });
  if (st.state === "outdated") throw Object.assign(new Error(MSG_JOIN_OLD), { install: true });
  if (st.takeChecksOld) throw new Error(MSG_TAKE_CHECKS_OLD);
  return "Join script up to date";
};

// Presenter photos: one or two pictures of Jon, listed in presenter.photos.
const presenterPhotosCheck = (presenter) => async (host) => {
  const photos = Array.isArray(presenter?.photos) ? presenter.photos : [];
  if (photos.length < 1 || photos.length > 2) throw new Error("Add presenter.photos in .studio-settings.json");
  for (const p of photos) if (!(await host.fs.exists(p))) throw new Error(`Not found: ${p}`);
  return `${photos.length} photos`;
};

const toolsCheck = (server, want) => async (host) => {
  if (!host.mcp) throw new Error("connector access is not available");
  const tools = await host.mcp.listTools(server);
  const missing = want.filter((t) => !tools.includes(t));
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  return `${tools.length} tools`;
};

export const makeChecks = (settings = DEFAULT_SETTINGS) => [
  { name: "S: root readable", run: listCheck(ROOT) },
  { name: "UNC root readable", run: listCheck(UNC) },
  { name: "Blender", run: cmdCheck(settings.blenderPath || DEFAULT_SETTINGS.blenderPath, ["--version"]) },
  { name: "ffmpeg", run: cmdCheck("ffmpeg", ["-version"]) },
  { name: "curl", run: cmdCheck("curl", ["--version"]) },
  { name: "ComfyUI", run: comfyCheck(settings.comfy ?? DEFAULT_SETTINGS.comfy) },
  { name: "Animate workflow", run: animateCheck(settings.comfy ?? DEFAULT_SETTINGS.comfy) },
  { name: "Stem Remixer", run: stemRemixerCheck(settings.stemRemixerDir) },
  { name: "Autocue join", run: autocueJoinCheck(settings.autocueDir ?? DEFAULT_SETTINGS.autocueDir) },
  { name: "Stable Audio", run: stableAudioCheck({ ...DEFAULT_SETTINGS.stableAudio, ...(settings.stableAudio ?? {}) }) },
  {
    name: "Higgsfield tools",
    async run(host) {
      if (!host.mcp) throw new Error("connector access is not available");
      const tools = await host.mcp.listTools("Higgsfield");
      const want = ["generate_video", "generate_image", "jobs_wait", "models_explore", "media_upload", "media_confirm", "estimate_image_cost", "estimate_video_cost"];
      const missing = want.filter((t) => !tools.includes(t));
      if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
      return `${tools.length} tools`;
    },
  },
  { name: "Presenter photos", run: presenterPhotosCheck(settings.presenter) },
  { name: "ElevenLabs tools", run: toolsCheck("ElevenLabs", ["creative_create_flow", "creative_add_flow_node", "creative_run_flow_nodes", "creative_get_flow_run_status"]) },
  {
    name: "Claude answers JSON",
    async run(host) {
      if (!host.claude) throw new Error("Claude access is not available");
      const r = await host.claude.json('Reply with exactly this JSON and nothing else: {"ok":true}', { tier: "quick" });
      if (r?.ok !== true) throw new Error(`unexpected answer: ${JSON.stringify(r)}`);
      return "ok";
    },
  },
];

export const CHECKS = makeChecks();

export async function runChecks(host, onResult = () => {}, settings = DEFAULT_SETTINGS) {
  const out = [];
  for (const c of makeChecks(settings)) {
    let r;
    try { r = { name: c.name, ok: true, detail: await c.run(host) }; }
    catch (e) { r = { name: c.name, ok: false, detail: String(e?.message ?? e), install: !!e?.install, ...(e?.neutral ? { neutral: true } : {}), ...(e?.start ? { start: e.start } : {}) }; }
    out.push(r);
    onResult(r);
  }
  return out;
}

export function probeRow(r) {
  const li = document.createElement("li");
  li.className = r.ok ? "pass" : r.neutral ? "neutral" : "fail";
  const st = document.createElement("span"); st.className = "st"; st.textContent = r.ok ? "Pass" : r.neutral ? "Optional" : "Fail";
  const nm = document.createElement("span"); nm.textContent = r.name;
  const d = document.createElement("span"); d.className = "detail"; d.textContent = r.detail;
  li.append(st, nm, d);
  return li;
}

// getSettings() gives the loaded .studio-settings.json (defaults until the root is read). reload(), when
// given, re-reads the file first, so a setting changed while the app is open counts straight away.
// getStarters(): { comfy, stableAudio } — a check that finds the tool not running gets a Start now row.
// onDone(results), when given, runs after each Probe (the app re-checks what depends on the settings).
export function mountProbe(host, button, list, getSettings = () => DEFAULT_SETTINGS, reload = null, getStarters = () => ({}), onDone = null) {
  const run = async () => {
    button.disabled = true;
    list.replaceChildren();
    if (reload) { try { await reload(); } catch { /* keep the settings already loaded */ } }
    const settings = getSettings() ?? DEFAULT_SETTINGS;
    const results = await runChecks(host, (r) => list.append(probeRow(r)), settings);
    // A missing or old join script can be put right from here: Studio carries the current copy.
    if (results.some((r) => r.install)) list.append(installRow(host, settings.autocueDir ?? DEFAULT_SETTINGS.autocueDir, run));
    const starters = getStarters?.() ?? {};
    for (const r of results) if (r.start && starters[r.start]) list.append(startRow(host, r.name, starters[r.start], run));
    button.disabled = false;
    if (onDone) { try { await onDone(results); } catch { /* the app's follow-up never breaks Probe */ } }
  };
  button.onclick = run;
}

function startRow(host, name, starter, rerun) {
  const li = document.createElement("li");
  li.className = "install";
  const b = document.createElement("button");
  b.type = "button"; b.className = "btn"; b.textContent = `Start ${name} now`;
  const d = document.createElement("span"); d.className = "detail";
  d.textContent = "Studio starts it when it opens; this starts it now. It can take a minute or two to load.";
  b.onclick = async () => {
    b.disabled = true;
    d.textContent = `Starting ${name}…`;
    try { await starter.ensure(host); d.textContent = `${name} is ready. Checking again…`; await rerun(); }
    catch (e) { d.textContent = `Couldn't start ${name}: ${e?.message ?? e}`; b.disabled = false; }
  };
  li.append(b, d);
  return li;
}

function installRow(host, dir, rerun) {
  const li = document.createElement("li");
  li.className = "install";
  const b = document.createElement("button");
  b.type = "button"; b.className = "btn"; b.textContent = "Install join script";
  const d = document.createElement("span"); d.className = "detail";
  d.textContent = `Writes voiceover_join.py and line_script.py into ${dir}. Older copies are kept, renamed with the date.`;
  b.onclick = async () => {
    b.disabled = true;
    try {
      const done = await installAutocueJoin(host, dir);
      d.textContent = done.length ? `Installed ${done.join(" and ")}. Checking again…` : "Already up to date. Checking again…";
      await rerun();
    } catch (e) { d.textContent = `Couldn't install: ${e?.message ?? e}`; b.disabled = false; }
  };
  li.append(b, d);
  return li;
}
