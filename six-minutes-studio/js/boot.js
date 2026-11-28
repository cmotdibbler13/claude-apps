// Boot decisions, free of the page: which computer this is, which project folder it uses,
// and the host that reads paths saved on another computer from this computer's folder.
import { computerName, localStore, samePath, UNNAMED } from "./computer.js";
import { resolveRoot, rootSpellings, join, isHomeRoot } from "./paths.js";
import { withRebase } from "./rebase.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// rawHost is the unwrapped host. A chosen folder that can't be reached gives root null and
// chosenMissing set (no fallback search, so Films can say so).
export async function findRoot(rawHost, { computer } = {}) {
  const name = computer ?? await computerName(rawHost);
  let local = {};
  try { local = (await localStore(rawHost).read()) ?? {}; } catch { /* nothing chosen */ }
  const chosenRoot = typeof local.root === "string" && local.root ? local.root : null;
  const root = await resolveRoot(rawHost, { chosen: chosenRoot });
  return { computer: name, chosenRoot, root, chosenMissing: chosenRoot && !root ? chosenRoot : null };
}

// The settings file as saved (only for the folder spellings); missing or unreadable is {}.
export async function readRawSettings(host, root) {
  try {
    const v = JSON.parse(await host.fs.read(join(root, ".studio-settings.json"), "utf8"));
    return isObj(v) ? v : {};
  } catch { return {}; }
}

export async function rebasedHost(rawHost, root) {
  return withRebase(rawHost, rootSpellings(await readRawSettings(rawHost, root)), root);
}

// A host that always forwards to the current one, for things made before the root is known.
export function liveHost(get) {
  return new Proxy({}, {
    get: (_, k) => get()?.[k],
    has: (_, k) => !!get() && k in get(),
  });
}

// At boot: should this computer's folder be recorded in its computers entry (so the other computers
// can re-base paths saved here)? Never on S: or the network path (the desktop doesn't write at boot), never when already there.
export function rootToRecord(raw, computer, root) {
  if (!root || !computer || computer === UNNAMED || isHomeRoot(root)) return false;
  const e = raw?.computers?.[computer];
  return !(e && typeof e === "object" && typeof e.root === "string" && samePath(e.root, root));
}
