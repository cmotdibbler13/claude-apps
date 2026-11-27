// When Studio opens: start ComfyUI and Stable Audio (each can be turned off in .studio-settings.json "autostart"),
// in parallel, so jobs never wait for a model to load. A tool that can't start shows it in its state, never throws.
const LABEL = { off: "Off", starting: "Starting…", ready: "Ready", missing: "Not found", failed: "Didn't start", music: "Music model loaded" };

export async function autostart(host, settings, starters) {
  const on = settings?.autostart ?? {};
  const runs = [];
  for (const k of ["comfy", "stableAudio"]) {
    const s = starters?.[k];
    if (s && on[k] !== false) runs.push(Promise.resolve().then(() => s.ensure(host)).catch(() => {}));
  }
  await Promise.all(runs);
}

export function toolsLine(starters) {
  const one = (name, s) => (s ? `${name}: ${LABEL[s.state()] ?? s.state()}` : null);
  return [one("ComfyUI", starters?.comfy), one("Stable Audio", starters?.stableAudio)].filter(Boolean).join(" · ");
}
