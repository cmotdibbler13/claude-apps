// Probe view: checks the PC and connectors. Never calls a generate tool.
import { runProcess } from "../proc.js";
import { cmdCheck, stemRemixerCheck } from "../toolchecks.js";
import { tool } from "../toolpaths.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { autocueJoinState, installAutocueJoin } from "../autocueinstall.js";
import { i2vReady } from "../tools/comfyui.js";
import { stableAudioState, MSG_MUSIC } from "../tools/stableaudio.js";
import { join } from "../paths.js";
import { photoPicker } from "./photopick.js";
import { MSG_SET_STEM_REMIXER, stemPython } from "../tools/stemfit.js";
import { readCatalogue } from "../libraryio.js";
import { nextBrNumber } from "../library.js";

const ROOT = "S:\\Youtube video ideas\\";
const UNC = "\\\\192.168.1.171\\jon\\Youtube video ideas\\";

const listCheck = (path) => async (host) => {
  const entries = await host.fs.list(path);
  return `${entries.length} entries`;
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

// B-roll library: the catalogue Approve Part 2 adds to reads, and the next BR number it would give.
const libraryCheck = (root) => async (host) => {
  const cat = await readCatalogue(host, root);
  const n = cat.entries.filter((e) => e && e.in_library !== false).length;
  return `${n} ${n === 1 ? "clip" : "clips"}, next BR-${String(nextBrNumber(cat.entries, cat.md)).padStart(3, "0")}`;
};

// Part 1: the reference script Claude reads for voice and structure (the first of referenceScripts that exists).
export const MSG_NO_REFERENCE = "None of the referenceScripts in .studio-settings.json is there. Set referenceScripts to one or more finished scripts.";
const referenceCheck = (paths) => async (host) => {
  for (const p of Array.isArray(paths) ? paths : []) {
    try { if (p && (await host.fs.exists(p))) return p; } catch { /* try the next */ }
  }
  throw new Error(MSG_NO_REFERENCE);
};

// Part 1: approved pronunciations. Missing is a warning: Studio starts the file at the first Part 1 approval.
export const MSG_NO_PRONUNCIATIONS = "No pronunciations file yet: Studio starts one when you approve a Part 1.";
const pronunciationsCheck = (file) => async (host) => {
  let there = false;
  try { there = !!(await host.fs.exists(file)); } catch { /* treat as missing */ }
  if (!there) throw Object.assign(new Error(MSG_NO_PRONUNCIATIONS), { warn: true });
  return file;
};

const toolsCheck = (server, want) => async (host) => {
  if (!host.mcp) throw new Error("connector access is not available");
  const tools = await host.mcp.listTools(server);
  const missing = want.filter((t) => !tools.includes(t));
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  return `${tools.length} tools`;
};

// root: the films folder (the app's resolved root), where the B-roll library lives.
export const makeChecks = (settings = DEFAULT_SETTINGS, root = ROOT) => [
  { name: "S: root readable", run: listCheck(ROOT) },
  { name: "UNC root readable", run: listCheck(UNC) },
  { name: "Blender", run: cmdCheck(settings.blenderPath || DEFAULT_SETTINGS.blenderPath, ["--version"]) },
  { name: "ffmpeg", run: (host) => cmdCheck(tool("ffmpeg"), ["-version"])(host) },
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
  { name: "B-roll library", run: libraryCheck(root || ROOT) },
  { name: "Reference script", run: referenceCheck(settings.referenceScripts ?? DEFAULT_SETTINGS.referenceScripts) },
  { name: "Pronunciations", run: pronunciationsCheck(settings.pronunciationsFile || join(root || ROOT, "pronunciations.md")) },
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

export async function runChecks(host, onResult = () => {}, settings = DEFAULT_SETTINGS, root = ROOT) {
  const out = [];
  for (const c of makeChecks(settings, root)) {
    let r;
    try { r = { name: c.name, ok: true, detail: await c.run(host) }; }
    catch (e) { r = { name: c.name, ok: false, detail: String(e?.message ?? e), install: !!e?.install, ...(e?.neutral ? { neutral: true } : {}), ...(e?.warn ? { warn: true } : {}), ...(e?.start ? { start: e.start } : {}) }; }
    out.push(r);
    onResult(r);
  }
  return out;
}

export function probeRow(r) {
  const li = document.createElement("li");
  li.className = r.ok ? "pass" : r.neutral ? "neutral" : r.warn ? "warn" : "fail";
  const st = document.createElement("span"); st.className = "st"; st.textContent = r.ok ? "Pass" : r.neutral ? "Optional" : r.warn ? "Warning" : "Fail";
  const nm = document.createElement("span"); nm.textContent = r.name;
  const d = document.createElement("span"); d.className = "detail"; d.textContent = r.detail;
  li.append(st, nm, d);
  return li;
}

// getSettings() gives the loaded .studio-settings.json (defaults until the root is read). reload(), when
// given, re-reads the file first, so a setting changed while the app is open counts straight away.
// getStarters(): { comfy, stableAudio } — a check that finds the tool not running gets a Start now row.
// onDone(results), when given, runs after each Probe (the app re-checks what depends on the settings).
// choosePhotos(files), when given, adds a "Choose presenter photos…" row (saves them, then Probe runs again).
// getRoot(): the films folder once it is resolved (the B-roll library row reads its catalogue there).
export function mountProbe(host, button, list, getSettings = () => DEFAULT_SETTINGS, reload = null, getStarters = () => ({}), onDone = null, choosePhotos = null, getRoot = () => null) {
  const run = async () => {
    button.disabled = true;
    list.replaceChildren();
    if (reload) { try { await reload(); } catch { /* keep the settings already loaded */ } }
    const settings = getSettings() ?? DEFAULT_SETTINGS;
    const results = await runChecks(host, (r) => list.append(probeRow(r)), settings, getRoot?.() || ROOT);
    // A missing or old join script can be put right from here: Studio carries the current copy.
    if (results.some((r) => r.install)) list.append(installRow(host, settings.autocueDir ?? DEFAULT_SETTINGS.autocueDir, run));
    const starters = getStarters?.() ?? {};
    for (const r of results) if (r.start && starters[r.start]) list.append(startRow(host, r.name, starters[r.start], run));
    if (choosePhotos) list.append(photosRow(choosePhotos, run));
    button.disabled = false;
    if (onDone) { try { await onDone(results); } catch { /* the app's follow-up never breaks Probe */ } }
  };
  button.onclick = run;
}

function photosRow(choosePhotos, rerun) {
  const li = document.createElement("li");
  li.className = "install";
  const d = document.createElement("span"); d.className = "detail";
  d.textContent = "Pick one or two pictures of you. Studio copies them into the Presenter photos folder and saves them in .studio-settings.json.";
  li.append(photoPicker("Choose presenter photos…", async (files) => {
    d.textContent = "Saving…";
    try { const paths = await choosePhotos(files); d.textContent = `Saved ${paths.length} photo${paths.length === 1 ? "" : "s"}. Checking again…`; await rerun(); }
    catch (e) { d.textContent = `Couldn't save: ${e?.message ?? e}`; }
  }, { ghost: false }), d);
  return li;
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
