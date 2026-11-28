// Plain-English tool names, shared by the notifier and the UI. No DOM in here.
export const TOOL_LABEL = { higgsfield: "Higgsfield", blender: "Blender", comfyui: "ComfyUI", stableaudio: "Stable Audio", elevenlabs: "ElevenLabs" };
export const toolLabel = (t) => TOOL_LABEL[t] ?? (t ? t[0].toUpperCase() + t.slice(1) : "");
// On a laptop, graphics jobs (ComfyUI, Blender, Stable Audio) are made on the desktop.
export const MAKE_ON_DESKTOP = "Make this on the desktop";
export const DESKTOP_TOOLS = new Set(["comfyui", "blender", "stableaudio"]);
