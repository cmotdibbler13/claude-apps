// The laptop's stand-in runner for graphics tools: writes a request into the shared queue folder, then waits
// for the desktop's answer file. It never runs the tool itself, and resume never writes a second request.
import { rebaseDeep } from "../rebase.js";
import { desktopState } from "../presence.js";
import { writeRequest, readAnswer, hasWithdrawn, writeWithdrawn, writeCheck, listRequests, moveMine } from "../queue.js";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeDesktopRunner({ root, computer, spellings, peers, poll = 5000, sleep = defaultSleep }) {
  async function wait(job, ctx, checkName) {
    const host = ctx.host;
    const id = job.jobRef;
    let remote = null;
    const setRemote = (s) => { if (s !== remote) { remote = s; ctx.setRemote(s); } };
    const running = (a) => {
      setRemote("running");
      const pct = Math.round((a.progress ?? 0) * 100) + "%";
      const eta = typeof a.eta === "string" && a.eta ? a.eta : pct;
      ctx.progress(a.progress ?? null, "On the desktop: " + eta);
    };
    for (;;) {
      const a = await readAnswer(host, root, id);
      if (!a) {
        if (await hasWithdrawn(host, root, id) && !desktopState(peers()).ready) {
          await moveMine(host, root, id, "laptop");
          throw new Error("Withdrawn");
        }
        setRemote("waiting");
        ctx.progress(null, "Waiting for the desktop" + desktopState(peers()).text);
      } else if (a.status === "done") {
        await moveMine(host, root, id, "laptop");
        return rebaseDeep({ file: a.file, meta: a.meta }, spellings, root);
      } else if (a.status === "withdrawn") {
        await moveMine(host, root, id, "laptop");
        throw new Error("Withdrawn");
      } else if (a.status === "failed" && !(checkName && !(a.checks ?? []).includes(checkName))) {
        if (!a.ambiguous) await moveMine(host, root, id, "laptop");
        throw Object.assign(new Error("On the desktop: " + (a.error ?? "Failed")), a.ambiguous ? { ambiguous: true } : {});
      } else {
        running(a); // running, or failed but the desktop has not answered our check yet
      }
      await sleep(poll);
    }
  }

  return {
    lane: "gpu",
    async start(job, ctx) {
      const id = `${computer}-${job.id}`;
      const { film, assetId, take, tool, what, why, input } = job;
      await writeRequest(ctx.host, root, { id, from: computer, root, job: { film, assetId, take, tool, what, why, input } });
      ctx.setRef(id);
      return wait({ ...job, jobRef: id }, ctx, null);
    },
    async resume(job, ctx) {
      const a = await readAnswer(ctx.host, root, job.jobRef);
      const checkName = a?.status === "failed" && a.ambiguous ? await writeCheck(ctx.host, root, job.jobRef) : null;
      return wait(job, ctx, checkName);
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
