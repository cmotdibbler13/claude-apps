// The one open film: one store per film folder for the app's lifetime (two stores on one state.json would
// overwrite each other), and a single job watcher at a time, safe against quick repeat clicks.
// Also reads the saved job list at boot without ever discarding a file it could not read.
import { openFilm } from "./store.js";
import { watchJobs } from "./redo.js";

const keyOf = (dir) => String(dir).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

export function makeFilmSession({ host, jobs, open = openFilm, watch = watchJobs, onSaved = () => {}, onSaveError = () => {} }) {
  let seq = 0;
  let inflight = null; // { key, promise }
  let current = null; // { key, dir, store, unwatch }
  const stores = new Map(); // key -> Promise<store>

  const storeFor = (dir) => {
    const key = keyOf(dir);
    if (!stores.has(key)) {
      const p = (async () => {
        const store = await open(host, dir);
        // The store has no change events; report every saved update (approvals, job syncs).
        const update = store.update;
        store.update = (fn) => { const q = update(fn); q.then(() => onSaved(), () => onSaved()); return q; };
        return store;
      })();
      stores.set(key, p);
      p.catch(() => { if (stores.get(key) === p) stores.delete(key); }); // a failed open can be tried again
    }
    return stores.get(key);
  };

  const session = {
    get current() { return current ? { dir: current.dir, store: current.store } : null; },
    open(dir) {
      const key = keyOf(dir);
      if (current?.key === key) {
        // Back to the film already open: drop any other open still in flight.
        if (inflight) { seq++; inflight = null; }
        return Promise.resolve(current.store);
      }
      if (inflight?.key === key) return inflight.promise;
      const my = ++seq;
      const promise = (async () => {
        const store = await storeFor(dir);
        if (my !== seq) return null; // a later open (or close) won: never subscribe this store
        current?.unwatch();
        current = { key, dir: store.dir, store, unwatch: watch({ host, store, jobs, onError: (m) => onSaveError(m, store.dir) }) };
        return store;
      })().finally(() => { if (inflight?.promise === promise) inflight = null; });
      inflight = { key, promise };
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
// onMovedAside(name) reports the new file name (null if it could not be moved) so the app can say so.
export async function readSavedJobs(host, file, { onMovedAside = () => {} } = {}) {
  try { if (!(await host.fs.exists(file))) return []; } catch { /* fall through and try to read */ }
  try {
    const v = JSON.parse(await host.fs.read(file, "utf8"));
    if (!Array.isArray(v)) throw new Error("not a list");
    return v;
  } catch {
    const bad = file.replace(/\.json$/i, "") + `.bad-${host.now()}.json`;
    let name = null;
    try { await host.fs.rename(file, bad); name = bad.split(/[\\/]/).pop(); } catch (e) { console.error(`Couldn't move ${file} aside`, e); }
    try { onMovedAside(name); } catch { /* reporting must not stop the boot */ }
    return [];
  }
}
