// Per-film studio state: load, serialised atomic update, append-only log.
import { join } from "./paths.js";
import { deriveWaiting } from "./shots.js";

const fresh = () => ({ v: 1, film: "", part: 2, waiting: deriveWaiting([]), assets: [], prefs: { preferComfy: false } });

export async function openFilm(host, dir) {
  const studio = join(dir, "studio");
  for (const d of [studio, join(studio, "blender"), join(studio, "media")]) await host.fs.mkdir(d);
  const file = join(studio, "state.json");
  const tmp = join(studio, "state.json.tmp");
  const logFile = join(studio, "log.jsonl");

  const log = async (text) => {
    await host.fs.append(logFile, JSON.stringify({ t: host.now(), text: String(text) }) + "\n");
  };

  let state;
  if (await host.fs.exists(file)) {
    try {
      state = JSON.parse(await host.fs.read(file, "utf8"));
      if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("not an object");
    } catch {
      const bad = `state.bad-${host.now()}.json`;
      await host.fs.rename(file, join(studio, bad));
      state = null;
      await log(`state.json could not be read; moved to ${bad} and started fresh`);
    }
  }
  if (!state) {
    state = fresh();
    await host.fs.write(tmp, JSON.stringify(state, null, 2));
    await host.fs.rename(tmp, file);
  }

  state.prefs = { ...state.prefs, preferComfy: !!state.prefs?.preferComfy };

  // pending: takes being started right now ("<assetId>#<n>"), whose job is not in the queue yet.
  const store = { state, dir, pending: new Set() };
  let chain = Promise.resolve();

  store.update = (fn) => {
    const run = async () => {
      const draft = structuredClone(store.state);
      fn(draft);
      await host.fs.write(tmp, JSON.stringify(draft, null, 2));
      await host.fs.rename(tmp, file);
      store.state = draft;
      return draft;
    };
    const p = chain.then(run);
    chain = p.catch(() => {});
    return p;
  };

  store.log = log;

  store.readLog = async (limit = 50) => {
    let raw;
    try { raw = await host.fs.read(logFile, "utf8"); } catch { return []; }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
    }
    return out.reverse().slice(0, limit);
  };

  return store;
}
