// Job queue: gpu lane runs one at a time, connector lane up to three. Persisted after every status,
// jobRef or structural change; progress-only changes notify listeners but are not written.
// A failed or interrupted job is never retried automatically; retry(id) adds a fresh job on request.
// check(id) re-polls any job with a jobRef by its jobRef (spends nothing) on the same job record.
import { join, isHomeRoot } from "./paths.js";

const CAPS = { gpu: 1, connector: 3 };

// The job list this computer keeps: the desktop's is <root>\.studio-jobs.json as always; a laptop (or a new
// computer whose role isn't set yet) keeps its own, so two Studios never restore or overwrite each other's jobs.
export function jobsFile(root, { role, computer, roleNeeded = false } = {}) {
  const own = (role === "laptop" || (roleNeeded && !isHomeRoot(root))) && computer;
  return join(root, own ? `.studio-jobs-${computer}.json` : ".studio-jobs.json");
}

export function makeJobs(host, { runners = {}, file } = {}) {
  let jobs = [];
  let counter = 0;
  const listeners = new Set();
  let chain = Promise.resolve();
  let persistError = null;
  const errListeners = new Set();

  const snap = () => jobs.map((j) => structuredClone(j));
  const changed = (save = true) => {
    if (save) persist();
    const s = snap();
    for (const fn of [...listeners]) { try { fn(s); } catch { /* a bad listener must not stop the queue */ } }
  };
  function persist() {
    if (!file) return;
    chain = chain.then(async () => {
      try {
        const tmp = file + ".tmp";
        await host.fs.write(tmp, JSON.stringify(jobs, null, 2));
        await host.fs.rename(tmp, file);
        persistError = null;
      } catch (e) {
        // Keep the queue running, but make the failure visible: a lost jobRef means a paid job cannot reconnect.
        persistError = String(e?.message ?? e);
        for (const fn of [...errListeners]) { try { fn(persistError); } catch { /* ignore */ } }
      }
    });
  }

  const newId = () => {
    let id;
    do { id = `j${host.now()}-${++counter}`; } while (jobs.some((j) => j.id === id));
    return id;
  };
  const laneOf = (j) => j.lane ?? runners[j.tool]?.lane ?? "connector";

  function ctxFor(job) {
    return {
      host,
      progress(p, eta) {
        job.progress = p ?? null;
        if (eta !== undefined) job.eta = eta ?? null;
        changed(false);
      },
      setRef(ref) { job.jobRef = ref; changed(); },
      // Where a job sent to another computer has got to; persisted, so call it only when the state changes.
      setRemote(state) { job.remote = state; changed(); },
    };
  }

  async function run(job, how) {
    job.status = "running";
    job.startedAt = host.now();
    changed();
    try {
      const runner = runners[job.tool];
      if (!runner) throw new Error(`No runner for ${job.tool}`);
      const fn = runner[how];
      if (!fn) throw new Error(`${job.tool} cannot ${how}`);
      const res = await fn.call(runner, job, ctxFor(job));
      if (res && res.file !== undefined) job.file = res.file;
      if (res && res.meta !== undefined) job.meta = res.meta;
      job.status = "done";
      job.progress = 1;
      job.eta = null;
      delete job.ambiguous;
    } catch (e) {
      job.status = "failed";
      job.error = String(e?.message ?? e);
      // The runner flags failures where the job may still be running upstream.
      if (e?.ambiguous) job.ambiguous = true; else delete job.ambiguous;
    }
    job.endedAt = host.now();
    changed();
    pump();
  }

  function pump() {
    for (const lane of Object.keys(CAPS)) {
      let running = jobs.filter((j) => j.status === "running" && laneOf(j) === lane).length;
      // Resumes go first and never call start: they must not re-fire a paid or already-submitted job.
      const queued = jobs.filter((j) => j.status === "queued" && laneOf(j) === lane);
      for (const j of [...queued.filter((q) => q.resumeNext), ...queued.filter((q) => !q.resumeNext)]) {
        if (running >= CAPS[lane]) break;
        running++;
        const how = j.resumeNext ? "resume" : "start";
        delete j.resumeNext;
        run(j, how);
      }
    }
  }

  const api = {
    add(spec) {
      const job = {
        ...structuredClone(spec),
        id: newId(),
        lane: spec.lane ?? runners[spec.tool]?.lane ?? "connector",
        status: "queued", progress: null, eta: null,
      };
      delete job.file; delete job.meta; delete job.error; delete job.startedAt; delete job.endedAt; delete job.resumeNext; delete job.remote;
      jobs.push(job);
      changed();
      pump();
      return job.id;
    },
    retry(id) {
      const old = jobs.find((j) => j.id === id);
      if (!old) throw new Error(`Unknown job ${id}`);
      if (old.status !== "failed" && old.status !== "interrupted") throw new Error(`Job ${id} is ${old.status}, not failed or interrupted`);
      const { film, assetId, take, tool, what, why, lane, input } = old;
      return api.add({ film, assetId, take, tool, what, why, lane, input });
    },
    check(id) {
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new Error(`Unknown job ${id}`);
      if (!job.jobRef || !runners[job.tool]?.resume) {
        throw new Error("Only a job with an id can be checked again.");
      }
      if (job.status !== "failed" && job.status !== "interrupted") throw new Error(`Job ${id} is ${job.status}, not failed or interrupted`);
      delete job.error; delete job.ambiguous; delete job.endedAt;
      job.status = "queued"; job.resumeNext = true;
      changed();
      pump();
    },
    list: snap,
    toJSON: snap,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    restore(saved) {
      jobs = (saved ?? []).map((j) => structuredClone(j));
      for (const j of jobs) {
        if (j.status !== "running") continue;
        if (j.jobRef && runners[j.tool]?.resume) { j.status = "queued"; j.resumeNext = true; }
        else { j.status = "interrupted"; j.endedAt = host.now(); }
      }
      changed();
      pump();
    },
    // Resolves once every change so far is written. Mainly for tests and clean shutdown.
    flush: () => chain,
    // Last write failure (null once a later write succeeds).
    get persistError() { return persistError; },
    onPersistError(fn) { errListeners.add(fn); return () => errListeners.delete(fn); },
  };
  return api;
}
