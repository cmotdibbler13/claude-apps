// Per-project tool settings from <root>\.studio-settings.json merged over defaults.
import { join } from "./paths.js";

export const DEFAULT_SETTINGS = { videoModel: "kling3_0", imageModel: "gpt_image_2", blenderPath: "blender" };

export async function loadSettings(host, root) {
  try {
    const raw = await host.fs.read(join(root, ".studio-settings.json"), "utf8");
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ...DEFAULT_SETTINGS, ...v };
  } catch { /* missing or unreadable: defaults */ }
  return { ...DEFAULT_SETTINGS };
}
