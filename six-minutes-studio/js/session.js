// The one open film: a single store and a single job watcher at a time, safe against quick repeat clicks.
// Also reads the saved job list at boot without ever discarding a file it could not read.
import { openFilm } from "./store.js";
import { watchJobs } from "./redo.js";

export function makeFilmSession({ host, jobs, open = openFilm, watch = watchJobs, onSaved = () => {} }) {
  let seq = 0;
  let inflight = null; // { dir, promise }
  let current = null; // { dir, store, unwatch }

  const session = {
    get current() { return current ? { dir: current.dir, store: current.store } : null; },
    open(dir) {
      if (current?.dir === dir) {
        // Back to the film already open: drop any other open still in flight.
        if (inflight) { seq++; inflight = null; }
        return Promise.resolve(current.store);
      }
      if (inflight?.dir === dir) return inflight.promise;
      const my = ++seq;
      const promise = (async () => {
        const store = await open(host, dir);
        if (my !== seq) return null; // a later open (or close) won: never subscribe this store
        // The store has no change events; report every saved update (approvals, job syncs).
        const update = store.update;
        store.update = (fn) => { const p = update(fn); p.then(() => onSaved(), () => onSaved()); return p; };
        current?.unwatch();
        current = { dir, store, unwatch: watch({ host, store, jobs }) };
        return store;
      })().finally(() => { if (inflight?.promise === promise) inflight = null; });
      inflight = { dir, promise };
      return promise;
    },
    close() {
      seq++;
      inflight = null;
      current?.unwatch();
      current = null;
    },
  };
  return session;
}

// R14: missing file -> []. Any other read or parse failure: move the file aside so paid jobRefs survive, then [].
export async function readSavedJobs(host, file) {
  try { if (!(await host.fs.exists(file))) return []; } catch { /* fall through and try to read */ }
  try {
    const v = JSON.parse(await host.fs.read(file, "utf8"));
    if (!Array.isArray(v)) throw new Error("not a list");
    return v;
  } catch {
    const bad = file.replace(/\.json$/i, "") + `.bad-${host.now()}.json`;
    try { await host.fs.rename(file, bad); } catch (e) { console.error(`Couldn't move ${file} aside`, e); }
    return [];
  }
}
