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
import { MSG_SET_STEM_REMIXER } from "../tools/stemfit.js";
import { readCatalogue } from "../libraryio.js";
import { nextBrNumber } from "../library.js";
import { GET_IT, openLink, findCandidates, checkChoice } from "../findtools.js";
import { candidateRoots } from "../paths.js";
import { localStore, saveComputerSettings } from "../computer.js";
import { h, btn } from "./dom.js";

const ROOT = "S:\\Youtube video ideas\\";
const trimSlash = (p) => String(p ?? "").replace(/\\+$/, "");
const samePath = (a, b) => trimSlash(a).toLowerCase() === trimSlash(b).toLowerCase();

// This computer's role, and the graphics rows a laptop leaves to the desktop.
export const ROLE_LABEL = { desktop: "Desktop (everything)", laptop: "Laptop (scripts and audio)" };
export const ROLE_QUESTION = "Is this computer the desktop (everything) or a laptop (scripts and audio)?";
export const ROLE_RESTART = "Restart Studio: it uses this role's job list from the next start.";
export const ON_DESKTOP = "On the desktop";
export const GRAPHICS_ROWS = ["Blender", "ComfyUI", "Animate workflow", "Stable Audio"];
export const roleLine = (computer, role) => `${computer} \u00B7 ${ROLE_LABEL[role === "laptop" ? "laptop" : "desktop"]}`;
const onDesktopCheck = async () => { throw Object.assign(new Error(ON_DESKTOP), { neutral: true, onDesktop: true }); };

// Project folder: the folder in use, readable. A chosen folder that can't be reached says so.
const projectCheck = (root, chosenMissing) => async (host) => {
  if (chosenMissing) throw Object.assign(new Error(`Can't reach the project folder you chose (${chosenMissing})`), { chooseRoot: true });
  try { await host.fs.list(root); }
  catch (e) { throw Object.assign(new Error(`Can't read ${trimSlash(root)}: ${e?.message ?? e}`), { chooseRoot: true }); }
  return trimSlash(root);
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
// here: graphics rows Jon chose to set up on this laptop anyway (this session only).
// chosenMissing: the chosen project folder, when it can't be reached.
export const makeChecks = (settings = DEFAULT_SETTINGS, root = ROOT, { here = new Set(), chosenMissing = null } = {}) => {
  const laptop = settings?.role === "laptop";
  const g = (c) => (laptop && GRAPHICS_ROWS.includes(c.name) && !here.has(c.name) ? { name: c.name, run: onDesktopCheck } : c);
  return allChecks(settings, root, chosenMissing).map(g);
};

const allChecks = (settings, root, chosenMissing) => [
  { name: "Project folder", run: projectCheck(root || ROOT, chosenMissing) },
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

async function runOne(host, c) {
  try { return { name: c.name, ok: true, detail: await c.run(host) }; }
  catch (e) {
    return { name: c.name, ok: false, detail: String(e?.message ?? e), install: !!e?.install, ...(e?.neutral ? { neutral: true } : {}), ...(e?.warn ? { warn: true } : {}),
      ...(e?.start ? { start: e.start } : {}), ...(e?.onDesktop ? { onDesktop: true } : {}), ...(e?.chooseRoot ? { chooseRoot: true } : {}) };
  }
}

export async function runChecks(host, onResult = () => {}, settings = DEFAULT_SETTINGS, root = ROOT, opts = {}) {
  const out = [];
  for (const c of makeChecks(settings, root, opts)) {
    const r = await runOne(host, c);
    out.push(r);
    onResult(r);
  }
  return out;
}

// ---- fix buttons ----
// Each failing tool row says how to put it right. The Project folder row can always be changed.
const FIXES = {
  "Project folder": [["root", null]],
  ffmpeg: [["choose", "ffmpeg"], ["get", "ffmpeg"]],
  Blender: [["choose", "blender"], ["get", "blender"]],
  ComfyUI: [["get", "comfyui"]],
  "Stable Audio": [["get", "pinokio"]],
  "Stem Remixer": [["choose", "stemremixer"], ["install", "stemremixer"]],
  "Autocue join": [["choose", "autocue"], ["install", "autocue"]],
  "Python for installs": [["choose", "python"], ["get", "python"]],
};
const FIX_LABEL = { root: "Choose\u2026", choose: "Choose where it is\u2026", install: "Install here\u2026" };
const getLabel = (kind) => (kind === "pinokio" ? "Get it: Pinokio" : "Get it");

export function fixesFor(r) {
  if (!r || (r.name !== "Project folder" && (r.ok || r.neutral))) return [];
  return (FIXES[r.name] ?? []).map(([type, kind]) => (type === "get"
    ? { type, kind, label: getLabel(kind), url: GET_IT[kind] }
    : { type, kind, label: FIX_LABEL[type] }));
}

// The setting a choice saves, for this computer only.
export function choicePatch(kind, path) {
  if (kind === "ffmpeg") return { ffmpegPath: path };
  if (kind === "blender") return { blenderPath: path };
  if (kind === "python") return { autocuePython: path };
  if (kind === "autocue") return { autocueDir: path, autocueRecordings: join(path, "Recordings") };
  if (kind === "stemremixer") return { stemRemixerDir: path };
  throw new Error(`Unknown kind: ${kind}.`);
}

// A project folder choice: kept on this computer, and recorded in the shared file (other computers re-base with it).
export async function saveRoot(rawHost, computer, path, { now } = {}) {
  const store = localStore(rawHost);
  let local = {};
  try { local = (await store.read()) ?? {}; } catch { /* nothing kept yet */ }
  // where: which write failed ("local": nothing changed; "shared": kept here, not recorded for the others).
  try { await store.write({ ...local, root: path }); }
  catch (e) { throw Object.assign(new Error(String(e?.message ?? e)), { where: "local" }); }
  try { await saveComputerSettings(rawHost, path, computer, { root: path }, now === undefined ? undefined : { now }); }
  catch (e) { throw Object.assign(new Error(String(e?.message ?? e)), { where: "shared" }); }
}

const say = (el, t) => { el.textContent = t; };

// "Choose where it is…": what Studio found, as buttons, plus a typed path. A pick is checked before it is saved.
export async function choosePanel(host, kind, save, rerun) {
  const msg = h("span", { class: "detail" });
  const typed = h("input", { type: "text", class: "fixpath", placeholder: "Or type the full path", "aria-label": "Full path" });
  const pick = async (path) => {
    const p = String(path ?? "").trim();
    if (!p) { say(msg, "Type the full path first."); return; }
    say(msg, "Checking\u2026");
    const r = await checkChoice(host, kind, p);
    if (!r.ok) { say(msg, r.detail); return; }
    try { await save(choicePatch(kind, p)); }
    catch (e) { say(msg, `Couldn't save: ${e?.message ?? e}`); return; }
    say(msg, `Saved ${p}. Checking again\u2026`);
    await rerun();
  };
  let found = [];
  try { found = await findCandidates(host, kind); } catch { /* none found */ }
  return h("div", { class: "fixpanel" },
    found.length ? h("div", { class: "fixpicks" }, found.map((p) => btn(p, () => pick(p), { ghost: true, cls: "fixpick" })))
      : h("span", { class: "detail", text: "Studio didn't find it. Type where it is." }),
    h("div", { class: "fixtype" }, typed, btn("Use this", () => pick(typed.value), { ghost: true })),
    msg);
}

// Choose… on the project folder: every project folder Studio can see, the one in use marked.
async function rootPanel(rawHost, inUse, chooseRoot, rerun) {
  const msg = h("span", { class: "detail" });
  let found = [];
  try { found = await candidateRoots(rawHost); } catch { /* none */ }
  const pick = async (p) => {
    say(msg, `Switching to ${p}\u2026`);
    try { await chooseRoot(p); }
    catch (e) { say(msg, `Couldn't switch: ${e?.message ?? e}`); return; }
    await rerun();
  };
  return h("div", { class: "fixpanel" },
    found.length ? h("div", { class: "fixpicks" }, found.map((p) => samePath(p, inUse)
      ? btn(`${p} (in use)`, () => {}, { ghost: true, cls: "fixpick on", disabled: true })
      : btn(p, () => pick(p), { ghost: true, cls: "fixpick" })))
      : h("span", { class: "detail", text: "Studio can't see a Youtube video ideas folder on any drive or the network path." }),
    msg);
}

const parentDefault = async (host) => { try { return (await host.fs.exists("D:\\")) ? "D:\\Apps" : "C:\\Apps"; } catch { return "C:\\Apps"; } };

// "Install here…": Autocue Studio needs a Python that runs (Stem Remixer's installer sees to its own); asks for the parent folder, shows each step, then Probe runs again.
async function installPanel(host, app, python, install, rerun) {
  const msg = h("span", { class: "detail" });
  const py = app === "autocue" ? await checkChoice(host, "python", python) : { ok: true };
  if (!py.ok) {
    return h("div", { class: "fixpanel" },
      h("div", { class: "fixtype" }, btn("Set up Python first", () => {}, { disabled: true }), btn("Get it", () => openLink(host, GET_IT.python).catch((e) => say(msg, String(e?.message ?? e))), { ghost: true })),
      msg);
  }
  const parent = h("input", { type: "text", class: "fixpath", "aria-label": "Folder to install into" });
  parent.value = await parentDefault(host);
  const go = btn("Install", async () => {
    const where = String(parent.value ?? "").trim();
    if (!where) { say(msg, "Type the folder to install into."); return; }
    go.disabled = true;
    say(msg, "Starting\u2026");
    try { await install({ app, parent: where, python, onStep: (t) => say(msg, t) }); }
    catch (e) { say(msg, `Couldn't install: ${e?.message ?? e}`); go.disabled = false; return; }
    await rerun();
  });
  return h("div", { class: "fixpanel" },
    h("span", { class: "detail", text: "Studio puts the app in its own folder inside this one:" }),
    h("div", { class: "fixtype" }, parent, go),
    msg);
}

function fixRow(host, r, ctx) {
  const area = h("div", { class: "fixarea" });
  const open = async (make) => {
    area.replaceChildren(h("span", { class: "detail", text: "Looking\u2026" }));
    try { area.replaceChildren(await make()); }
    catch (e) { area.replaceChildren(h("span", { class: "err", text: `Something went wrong: ${e?.message ?? e}` })); }
  };
  const buttons = [];
  if (r.onDesktop) {
    buttons.push(btn("Set up here anyway", () => { ctx.here.add(r.name); return ctx.rerun(); }, { ghost: true }));
  }
  for (const f of fixesFor(r)) {
    if (f.type === "get") buttons.push(btn(f.label, () => openLink(host, f.url).catch((e) => area.replaceChildren(h("span", { class: "err", text: String(e?.message ?? e) }))), { ghost: true }));
    else if (f.type === "root") buttons.push(btn(f.label, () => open(() => rootPanel(ctx.rawHost, ctx.root, ctx.setup.chooseRoot, ctx.rerun)), { ghost: true }));
    else if (f.type === "choose") buttons.push(btn(f.label, () => open(() => choosePanel(host, f.kind, ctx.save, ctx.rerun)), { ghost: true }));
    else if (f.type === "install") buttons.push(btn(f.label, () => open(() => installPanel(host, f.kind, ctx.python, ctx.install, ctx.rerun)), { ghost: true }));
  }
  if (!buttons.length) return null;
  return h("li", { class: "install fix" }, h("div", { class: "fixbtns" }, buttons), area);
}

// A role save that fails says so in its row (on success Probe runs again and the row is replaced).
const savingTo = (msg, save) => async (patch) => {
  say(msg, "Saving\u2026");
  try { await save(patch); }
  catch (e) { say(msg, `Couldn't save: ${e?.message ?? e}`); }
};

function roleQuestionRow(save) {
  const msg = h("span", { class: "err" });
  const go = savingTo(msg, save);
  return h("li", { class: "install role" },
    h("span", { class: "detail", text: ROLE_QUESTION }),
    h("div", { class: "fixbtns" }, ["desktop", "laptop"].map((k) => btn(ROLE_LABEL[k], () => go({ role: k })))),
    msg);
}

function roleRow(computer, role, save, restart = false) {
  const msg = h("span", { class: "err" });
  const go = savingTo(msg, save);
  const pick = h("div", { class: "fixbtns", hidden: true }, ["desktop", "laptop"].map((k) =>
    h("button", { type: "button", class: "btn ghost", "aria-pressed": String(k === role), onclick: () => (k === role ? (pick.hidden = true) : go({ role: k })) }, ROLE_LABEL[k])));
  const change = btn("Change", () => { pick.hidden = !pick.hidden; }, { ghost: true });
  return h("li", { class: "pass role" },
    h("span", { class: "st", text: "Set" }),
    h("span", { text: "This computer" }),
    h("span", { class: "detail" }, roleLine(computer, role), " ", change),
    restart ? h("span", { class: "detail", text: ROLE_RESTART }) : null,
    pick, msg);
}

export function probeRow(r) {
  const li = document.createElement("li");
  li.className = r.ok ? "pass" : r.neutral ? "neutral" : r.warn ? "warn" : "fail";
  const st = document.createElement("span"); st.className = "st"; st.textContent = r.ok ? "Pass" : r.onDesktop ? "Desktop" : r.neutral ? "Optional" : r.warn ? "Warning" : "Fail";
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
// setup, when given, adds this computer's row and the fix buttons:
//   computer(), rawHost() (the host without re-basing, for finding project folders), chosenMissing(),
//   roleNeeded() (ask the role first), save(patch) (this computer's settings, then re-read),
//   chooseRoot(path) (switch project folder), install({app, parent, python, onStep}).
export function mountProbe(host, button, list, getSettings = () => DEFAULT_SETTINGS, reload = null, getStarters = () => ({}), onDone = null, choosePhotos = null, getRoot = () => null, setup = null) {
  const here = new Set(); // graphics rows set up on this laptop anyway, for this session
  let roleSaved = false; // the role was set this session: the job list follows it at the next start
  const saveThen = async (patch) => { await setup.save(patch); if ("role" in patch) roleSaved = true; await run(); };
  const run = async () => {
    button.disabled = true;
    list.replaceChildren();
    if (reload) { try { await reload(); } catch { /* keep the settings already loaded */ } }
    if (setup?.roleNeeded) {
      let ask = false;
      try { ask = !!(await setup.roleNeeded()); } catch { /* treat as answered */ }
      if (ask) { list.append(roleQuestionRow(saveThen)); button.disabled = false; return; }
    }
    const settings = getSettings() ?? DEFAULT_SETTINGS;
    const root = getRoot?.() || ROOT;
    const ctx = setup ? {
      setup, here, rerun: run, root, rawHost: setup.rawHost?.() ?? host,
      save: async (patch) => { await setup.save(patch); },
      install: async (opts) => { await setup.install(opts); },
      python: settings.autocuePython || DEFAULT_SETTINGS.autocuePython,
    } : null;
    if (setup) list.append(roleRow(setup.computer?.() ?? "THIS-PC", settings.role, saveThen, roleSaved));
    const show = (r) => {
      list.append(probeRow(r));
      const fix = ctx ? fixRow(host, r, ctx) : null;
      if (fix) list.append(fix);
    };
    const results = await runChecks(host, show, settings, root, { here, chosenMissing: setup?.chosenMissing?.() ?? null });
    // Installing Autocue Studio needs a Python that runs: shown when Autocue join isn't set up.
    if (setup && results.some((r) => !r.ok && r.name === "Autocue join")) {
      const py = await runOne(host, { name: "Python for installs", run: cmdCheck(ctx.python, ["--version"]) });
      results.push(py);
      show(py);
    }
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
