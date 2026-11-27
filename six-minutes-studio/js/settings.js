// Per-project tool settings from <root>\.studio-settings.json merged over defaults.
import { join } from "./paths.js";

export const DEFAULT_SETTINGS = {
  autocueRecordings: "C:\\Users\\Jon\\desktop autocue\\Recordings", autocueDir: "C:\\Users\\Jon\\desktop autocue",
  autocuePython: "python", stemRemixerDir: null, endCardS: 12, titleHoldS: 6, mixMusicDb: -26, mixSfxDb: -18,
  videoModel: "kling3_0", imageModel: "gpt_image_2", blenderPath: "blender",
  comfy: {
    url: "http://127.0.0.1:8188",
    outputDir: "C:\\Users\\Jon\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Shared\\output",
    workflow: null,
    nodes: {
      prompt: ["364", "text"], width: ["372", "value"], height: ["360", "value"], length: ["362", "value"],
      fps: ["361", "value"], seed: ["339", "noise_seed"], output: ["9999", "filename_prefix"],
    },
    lengthUnit: "seconds", width: 1920, height: 1088, seconds: 5, fps: 24, expectedSeconds: 240,
  },
  // Started when Studio opens (each can be turned off).
  autostart: { comfy: true, stableAudio: true },
  stableAudio: {
    url: "http://127.0.0.1:7860", pterm: "C:\\pinokio\\bin\\npm\\pterm.cmd",
    app: "C:\\pinokio\\api\\stable-audio-3-small.pinokio.git", steps: 8, cfg: 1.0,
    // Pinokio itself: opened first when it isn't running (Stable Audio starts through it).
    pinokioExe: "C:\\Users\\Jon\\AppData\\Local\\Programs\\Pinokio\\Pinokio.exe", pinokioUrl: "http://127.0.0.1:42000",
  },
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function withDefaults(root, v = {}) {
  const d = structuredClone(DEFAULT_SETTINGS);
  const c = isObj(v.comfy) ? v.comfy : {};
  const comfy = { ...d.comfy, ...c, nodes: { ...d.comfy.nodes, ...(isObj(c.nodes) ? c.nodes : {}) } };
  if (!comfy.workflow) comfy.workflow = join(root, "ComfyUI workflows", "broll_ltx.json");
  const stableAudio = { ...d.stableAudio, ...(isObj(v.stableAudio) ? v.stableAudio : {}) };
  // "autostart": false (or true) switches both; an object sets each.
  const autostart = typeof v.autostart === "boolean" ? { comfy: v.autostart, stableAudio: v.autostart }
    : { ...d.autostart, ...(isObj(v.autostart) ? v.autostart : {}) };
  return { ...d, ...v, comfy, stableAudio, autostart };
}

export async function loadSettings(host, root) {
  try {
    const raw = await host.fs.read(join(root, ".studio-settings.json"), "utf8");
    const v = JSON.parse(raw);
    if (isObj(v)) return withDefaults(root, v);
  } catch { /* missing or unreadable: defaults */ }
  return withDefaults(root);
}
