// Plain-English tool names, shared by the notifier and the UI. No DOM in here.
export const TOOL_LABEL = { higgsfield: "Higgsfield", blender: "Blender", comfyui: "ComfyUI" };
export const toolLabel = (t) => TOOL_LABEL[t] ?? (t ? t[0].toUpperCase() + t.slice(1) : "");
