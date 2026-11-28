// The laptop's stand-in runner for graphics tools: writes a request into the shared queue folder, then waits
// for the desktop's answer file. It never runs the tool itself, and resume never writes a second request.
import { rebaseDeep } from "../rebase.js";
import { desktopState } from "../presence.js";
import {
  writeRequest, readAnswer, hasWithdrawn, writeWithdrawn, writeCheck, listRequests, moveMine,
  requestFinished, requestAnywhere, readFinishedAnswer, answerInQueue,
} from "../queue.js";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withdrawn = () => new Error("Withdrawn");
// The desktop's failure, with the prefix unless its words already say where it happened.
const failure = (error) => {
  const e = String(error ?? "Failed");
  return /on the desktop/i.test(e) ? e : "On the desktop: " + e;
};
const requestOf = (job) => {
  const { film, assetId, take, tool, what, why, input } = job;
  return { film, assetId, take, tool, what, why, input };
};

export function makeDesktopRunner({ root, computer, spellings, peers, poll = 5000, sleep = defaultSleep }) {
  // A job whose reference was saved but whose request may never have been written (Studio closed in between):
  // write it now, unless it is anywhere already (queue folder or finished\) or was withdrawn. Returns false when
  // it can't tell yet (the folder couldn't be read), so the caller tries again on its next look.
  async function sendIfNeverSent(host, job) {
    const id = job.jobRef;
    try {
      if (await requestAnywhere(host, root, id)) return true;
    } catch { return false; }
    if (await hasWithdrawn(host, root, id)) {
      await moveMine(host, root, id, "laptop");
      throw withdrawn();
    }
    await writeRequest(host, root, { id, from: computer, root, job: requestOf(job) });
    return true;
  }

  async function wait(job, ctx, { checkName = null, ensureSent = false } = {}) {
    const host = ctx.host;
    const id = job.jobRef;
    let remote = null;
    const setRemote = (s) => { if (s !== remote) { remote = s; ctx.setRemote(s); } };
    const waiting = (state) => {
      setRemote(state);
      ctx.progress(null, "Waiting for the desktop" + desktopState(peers()).text);
    };
    const running = (a) => {
      setRemote("running");
      const eta = typeof a.eta === "string" && a.eta ? a.eta
        : a.progress == null ? "starting" : Math.round(a.progress * 100) + "%";
      ctx.progress(a.progress ?? null, "On the desktop: " + eta);
    };
    const finish = async (a) => {
      if (a?.status === "done") return rebaseDeep({ file: a.file, meta: a.meta }, spellings, root);
      if (a?.status === "failed") throw new Error(failure(a.error));
      throw withdrawn(); // withdrawn, or nothing filed at all
    };
    for (;;) {
      const a = await readAnswer(host, root, id);
      if (!a) {
        if (ensureSent) ensureSent = !(await sendIfNeverSent(host, job));
        if (await requestFinished(host, root, id)) {
          // Filed already (Studio closed before the result was saved): the desktop's answer is in finished\.
          const filed = await readFinishedAnswer(host, root, id);
          let inQueue = false;
          if (!filed) { try { inQueue = await answerInQueue(host, root, id); } catch { inQueue = true; } }
          if (!inQueue) {
            await moveMine(host, root, id, "laptop");
            return finish(filed);
          }
        } else if (await hasWithdrawn(host, root, id) && !desktopState(peers()).ready) {
          await moveMine(host, root, id, "laptop");
          // The desktop may have taken it meanwhile: its answer wins.
          if (!(await readAnswer(host, root, id))) throw withdrawn();
          continue;
        }
        waiting("waiting");
      } else if (a.status === "done") {
        await moveMine(host, root, id, "laptop");
        return rebaseDeep({ file: a.file, meta: a.meta }, spellings, root);
      } else if (a.status === "withdrawn") {
        await moveMine(host, root, id, "laptop");
        throw withdrawn();
      } else if (a.status === "failed" && checkName && !(a.checks ?? []).includes(checkName)) {
        waiting("running"); // our check is not answered yet
      } else if (a.status === "failed") {
        if (!a.ambiguous) await moveMine(host, root, id, "laptop");
        throw Object.assign(new Error(failure(a.error)), a.ambiguous ? { ambiguous: true } : {});
      } else {
        running(a);
      }
      await sleep(poll);
    }
  }

  return {
    lane: "gpu",
    async start(job, ctx) {
      const id = `${computer}-${job.id}`;
      // The reference is saved first, so a Studio closed straight after still knows the job was (or may be) sent.
      ctx.setRef(id);
      await writeRequest(ctx.host, root, { id, from: computer, root, job: requestOf(job) });
      return wait({ ...job, jobRef: id }, ctx);
    },
    async resume(job, ctx) {
      const a = await readAnswer(ctx.host, root, job.jobRef);
      // A check file only when Jon pressed Check, never on a resume after a restart.
      const checkName = ctx.checking && a?.status === "failed" && a.ambiguous ? await writeCheck(ctx.host, root, job.jobRef) : null;
      return wait(job, ctx, { checkName, ensureSent: true });
    },
  };
}

// Ask the desktop to drop a job; the wait loop sees the outcome.
export const withdraw = (host, root, job) => writeWithdrawn(host, root, job.jobRef);

// Move aside this computer's requests that no job in the list refers to any more.
export async function tidyRequests(host, root, computer, jobs) {
  const known = new Set(jobs.map((j) => `${computer}-${j.id}`));
  for (const r of await listRequests(host, root)) {
    if (r.from === computer && !known.has(r.id)) await moveMine(host, root, r.id, "laptop");
  }
}
