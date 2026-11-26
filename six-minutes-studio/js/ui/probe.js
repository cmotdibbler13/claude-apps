// Probe view: checks the PC and connectors. Never calls a generate tool.
import { runProcess } from "../proc.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { stableAudioState, MSG_MUSIC } from "../tools/stableaudio.js";
import { join } from "../paths.js";

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
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  let version = null;
  try { version = JSON.parse(r.stdout)?.system?.comfyui_version ?? null; } catch { /* not JSON: still running */ }
  if (!comfy.workflow) throw new Error("Workflow path not set yet; open Films first");
  if (!(await host.fs.exists(comfy.workflow))) throw new Error(`Workflow not found: ${comfy.workflow}`);
  return typeof version === "string" && version ? `ComfyUI ${version}` : "running";
};

// Stable Audio: the page title says Small SFX and /gradio_api/info lists /generate. Never starts it.
const stableAudioCheck = (sa) => async (host) => {
  const s = await stableAudioState(host, sa);
  if (s === "ready") return "Ready";
  if (s === "off") throw new Error("Off: press Start Stable Audio on a film's Review");
  if (s === "music") throw new Error(MSG_MUSIC);
  throw new Error(`Not ready: look at Stable Audio in Pinokio (${sa.url})`);
};

// Stem Remixer: its own Python plus fit.py and measure.py (1.9.0 or newer). Never starts it.
export const MSG_SET_STEM_REMIXER = "Set stemRemixerDir in .studio-settings.json to your Stem Remixer folder (1.9.0 or newer).";
const NEED_VERSION = [1, 9, 0];
const older = (v, want) => {
  const a = String(v).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < want.length; i++) if ((a[i] ?? 0) !== want[i]) return (a[i] ?? 0) < want[i];
  return false;
};
const stemRemixerCheck = (dir) => async (host) => {
  if (!dir) throw new Error(MSG_SET_STEM_REMIXER);
  for (const f of [join(dir, ".venv", "Scripts", "python.exe"), join(dir, "fit.py"), join(dir, "measure.py")]) {
    if (!(await host.fs.exists(f))) throw new Error(MSG_SET_STEM_REMIXER);
  }
  let v = null;
  try { v = String(await host.fs.read(join(dir, "VERSION"), "utf8")).trim() || null; } catch { /* no VERSION file */ }
  if (v && older(v, NEED_VERSION)) throw new Error(`Stem Remixer is ${v}; update it to 1.9.0 or newer (its Update button)`);
  return v ? `Stem Remixer ${v}` : "ready";
};

const autocueJoinCheck = (dir) => async (host) => {
  if (dir && (await host.fs.exists(join(dir, "voiceover_join.py")))) return "voiceover_join.py found";
  throw new Error(`voiceover_join.py isn't in ${dir || "autocueDir"}. Update Autocue Studio, or set autocueDir in .studio-settings.json.`);
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
  { name: "Stem Remixer", run: stemRemixerCheck(settings.stemRemixerDir) },
  { name: "Autocue join", run: autocueJoinCheck(settings.autocueDir ?? DEFAULT_SETTINGS.autocueDir) },
  { name: "Stable Audio", run: stableAudioCheck({ ...DEFAULT_SETTINGS.stableAudio, ...(settings.stableAudio ?? {}) }) },
  {
    name: "Higgsfield tools",
    async run(host) {
      if (!host.mcp) throw new Error("connector access is not available");
      const tools = await host.mcp.listTools("Higgsfield");
      const want = ["generate_video", "generate_image", "jobs_wait", "models_explore"];
      const missing = want.filter((t) => !tools.includes(t));
      if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
      return `${tools.length} tools`;
    },
  },
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
    catch (e) { r = { name: c.name, ok: false, detail: String(e?.message ?? e) }; }
    out.push(r);
    onResult(r);
  }
  return out;
}

function row(r) {
  const li = document.createElement("li");
  li.className = r.ok ? "pass" : "fail";
  const st = document.createElement("span"); st.className = "st"; st.textContent = r.ok ? "Pass" : "Fail";
  const nm = document.createElement("span"); nm.textContent = r.name;
  const d = document.createElement("span"); d.className = "detail"; d.textContent = r.detail;
  li.append(st, nm, d);
  return li;
}

// getSettings() gives the loaded .studio-settings.json (defaults until the root is read).
export function mountProbe(host, button, list, getSettings = () => DEFAULT_SETTINGS) {
  button.onclick = async () => {
    button.disabled = true;
    list.replaceChildren();
    await runChecks(host, (r) => list.append(row(r)), getSettings() ?? DEFAULT_SETTINGS);
    button.disabled = false;
  };
}
