// The desktop's side of the queue: takes laptop jobs one at a time, keeps their answers up to date,
// answers withdrawals and Check requests, and files its finished answers. Everything runs one step at a time.
import { rebaseDeep } from "./rebase.js";
import {
  pendingRequests, listAnswers, readAnswer, writeAnswer, hasWithdrawn, listChecks, moveMine, requestFinished, answerInQueue,
} from "./queue.js";

const PROGRESS_EVERY = 5000;
export const INTERRUPTED = "Interrupted on the desktop; press Retry";
export const LOST = "Lost on the desktop; press Retry";
const FINAL = new Set(["done", "failed", "withdrawn"]);
const live = (j) => j.status === "queued" || j.status === "running";

const blank = { progress: null, eta: null, file: null, meta: null, error: null, ambiguous: false };

// What an answer should say about a desktop job.
function fromJob(job) {
  switch (job.status) {
    case "done": return { ...blank, status: "done", progress: 1, file: job.file ?? null, meta: job.meta ?? null };
    case "failed": return { ...blank, status: "failed", error: job.error ?? "Failed", ambiguous: !!job.ambiguous };
    case "interrupted": return { ...blank, status: "failed", error: INTERRUPTED };
    default: return { ...blank, status: "running", progress: job.progress ?? null, eta: job.eta ?? null };
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function makeDesktopWorker({ host, root, computer, jobs, spellings = [], paused = () => false, now = () => host.now() }) {
  const cache = new Map(); // request id -> the answer as last written
  const wroteAt = new Map();
  const settled = new Set(); // request ids with no answer of ours left to keep up to date: never read again
  let waiting = 0;
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  async function put(answer) {
    const a = { ...blank, checks: [], ...answer, by: computer };
    await writeAnswer(host, root, a);
    cache.set(a.id, a);
    wroteAt.set(a.id, now());
    return a;
  }
  const mine = async () => (await listAnswers(host, root)).filter((a) => a.by === computer);

  // Bring each laptop job's answer in line with the job.
  async function follow(list) {
    for (const job of list) {
      if (!job.request || settled.has(job.request)) continue;
      let cur = cache.get(job.request);
      if (!cur) {
        const onDisk = await readAnswer(host, root, job.request);
        if (!onDisk) {
          // Settled only when the answer is really gone from the queue folder (filed); a failed read tries again later.
          let there = true;
          try { there = await answerInQueue(host, root, job.request); } catch { /* can't tell: try again */ }
          if (!there) settled.add(job.request);
          continue;
        }
        if (onDisk.by !== computer) { settled.add(job.request); continue; }
        cur = { checks: [], ...onDisk };
        cache.set(job.request, cur);
      }
      if (cur.status === "withdrawn") continue;
      const next = fromJob(job);
      const was = { ...cur, status: cur.status };
      const keys = ["status", "file", "meta", "error", "ambiguous"];
      const statusLevel = keys.some((k) => !same(was[k] ?? null, next[k] ?? null));
      const progressLevel = !same(was.progress ?? null, next.progress) || !same(was.eta ?? null, next.eta);
      if (!statusLevel && !progressLevel) continue;
      if (!statusLevel && now() - (wroteAt.get(job.request) ?? 0) < PROGRESS_EVERY) continue;
      await put({ id: job.request, ...next, checks: cur.checks ?? [] });
    }
  }

  const unsubscribe = jobs.onChange((list) => { serial(() => follow(list)).catch(() => {}); });

  async function reconcile() {
    return serial(async () => {
      const have = new Set(jobs.list().filter((j) => j.request).map((j) => j.request));
      for (const a of await mine()) {
        if (a.status !== "running" || have.has(a.id)) continue;
        await put({ ...a, status: "failed", progress: null, eta: null, error: LOST, ambiguous: false, checks: a.checks ?? [] });
      }
    });
  }

  async function tick() {
    return serial(async () => {
      let pending = await pendingRequests(host, root);
      // Withdrawn before it was claimed: answer and forget it.
      const open = [];
      // Never take a request twice: one that is already a job here is not new, whatever its answer says.
      const taken = new Set(jobs.list().filter((j) => j.request).map((j) => j.request.toLowerCase()));
      pending = pending.filter((r) => !taken.has(r.id.toLowerCase()));
      for (const r of pending) {
        if (await hasWithdrawn(host, root, r.id)) await put({ id: r.id, status: "withdrawn", checks: [] });
        else open.push(r);
      }
      // Check: new check files on a failed, ambiguous answer.
      for (const a of await mine()) {
        if (a.status !== "failed" || !a.ambiguous) continue;
        const fresh = (await listChecks(host, root, a.id)).filter((n) => !(a.checks ?? []).includes(n));
        if (!fresh.length) continue;
        // Check the job first, then write one answer: the job's state now plus the new checks, so the laptop
        // never sees its check answered while the job is still marked failed.
        const job = jobs.list().find((j) => j.request === a.id);
        if (job && (job.status === "failed" || job.status === "interrupted")) {
          try { jobs.check(job.id); } catch { /* refused: the answer stays failed, the check is recorded */ }
        }
        const after = jobs.list().find((j) => j.request === a.id);
        await put({ ...a, ...(after ? fromJob(after) : {}), checks: [...(a.checks ?? []), ...fresh] });
      }
      // Claim the next request when the graphics lane is free.
      const busy = jobs.list().some((j) => j.lane === "gpu" && live(j));
      if (!paused() && !busy && open.length) {
        const req = open[0];
        if (await hasWithdrawn(host, root, req.id)) {
          await put({ id: req.id, status: "withdrawn", checks: [] });
          open.shift();
        } else {
          await put({ id: req.id, status: "running", checks: [] });
          jobs.add({ ...rebaseDeep(req.job, [...spellings, req.root], root), from: req.from, request: req.id });
          open.shift();
        }
      }
      waiting = open.length;
      await follow(jobs.list());
      // File finished answers once the laptop has filed its request.
      for (const a of await mine()) {
        if (!FINAL.has(a.status) || !(await requestFinished(host, root, a.id))) continue;
        await moveMine(host, root, a.id, "desktop");
        cache.delete(a.id);
        settled.add(a.id);
        wroteAt.delete(a.id);
      }
    });
  }

  return {
    tick,
    reconcile,
    counts: () => ({ waiting, running: jobs.list().filter((j) => j.from && live(j)).length }),
    stop: () => unsubscribe(),
  };
}
