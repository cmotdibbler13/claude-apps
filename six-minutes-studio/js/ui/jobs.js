// Live jobs view: every job newest first, with progress and why it exists; activity log beside.
import { h, btn, basename, toolLabel } from "./dom.js";
import { filmKey } from "../paths.js";
import { DESKTOP_TOOLS } from "../labels.js";

const active = (j) => j.status === "queued" || j.status === "running";
const sameFilm = (a, b) => filmKey(a.film) === filmKey(b.film);
const same = (a, b) => sameFilm(a, b) && a.assetId === b.assetId && a.take === b.take && a.assetId !== undefined;

const isAudio = (j) => j.assetId === "SCORE" || String(j.assetId ?? "").startsWith("SFX-");

export const activeCount = (jobs = []) => jobs.filter(active).length;

// With a tray icon, closing the window only hides the app, so jobs keep running; Exit is in the tray menu.
export const keepOpenText = (inTray) => inTray
  ? "Jobs keep running if you close this window: the app stays in the system tray. To quit, right-click its tray icon and choose Exit."
  : "Keep this window open while jobs run.";

const STATUS_TEXT = { done: "Done", failed: "Failed", interrupted: "Interrupted", queued: "queued" };

// gone: why a job can't run or be checked again (its shot was removed from the review), or undefined.
export function jobRow(job, index, jobs, retried, gone, { role } = {}) {
  const pct = typeof job.progress === "number" ? Math.round(Math.min(1, Math.max(0, job.progress)) * 100) : null;
  let eta;
  if (job.status === "running") eta = typeof job.eta === "string" && job.eta ? job.eta : pct !== null ? `${pct}%` : "Running";
  else eta = STATUS_TEXT[job.status] ?? job.status;
  const ended = job.status === "failed" || job.status === "interrupted";
  // Not when a later job covers this take, or another take of the same shot is still queued or running.
  const superseded = jobs.slice(index + 1).some((k) => same(k, job))
    || (!isAudio(job) && jobs.some((k) => k !== job && active(k) && sameFilm(k, job) && k.assetId !== undefined && k.assetId === job.assetId));
  const hf = job.tool === "higgsfield", comfy = job.tool === "comfyui", eleven = job.tool === "elevenlabs";
  const graphics = DESKTOP_TOOLS.has(job.tool);
  const sent = role === "laptop" && graphics;
  const unsure = ended && (job.ambiguous || (job.status === "interrupted" && !job.jobRef));
  return {
    id: job.id,
    what: job.what ?? job.tool,
    tool: toolLabel(job.tool),
    filmTitle: basename(job.film),
    why: job.why ?? "",
    status: job.status,
    live: active(job),
    pct: job.status === "done" ? 100 : pct,
    indeterminate: job.status === "running" && pct === null,
    eta,
    error: ended ? job.error ?? (job.status === "interrupted" ? "Interrupted when the app closed" : "Failed") : null,
    // An ElevenLabs re-run is paid, and its cost is shown only on the card's Generate button.
    from: job.from ? `from ${job.from}` : null,
    canWithdraw: sent && job.remote === "waiting" && job.status === "running",
    canRetry: !job.from && ended && !eleven && !retried.has(job.id) && !superseded && !gone,
    retryNote: job.from ? `Retry it from ${job.from}` : ended && gone ? gone : ended && eleven ? "Make a new take from its card" : null,
    // Checking by job id (or ComfyUI prompt id, or ElevenLabs flow run) is free; running Higgsfield again is a new paid generation.
    canCheck: !job.from && ended && !!job.jobRef && (hf || comfy || eleven || (sent && !!job.ambiguous)) && !superseded && !gone,
    retryLabel: hf ? "Run again (new generation, uses credits)" : "Run again",
    warning: !unsure ? null
      : hf ? "Check Higgsfield first: this job may still be running."
      : comfy ? "Check ComfyUI first: this render may still be running."
      : eleven ? "Check ElevenLabs first: this take may still be running." : null,
  };
}

const two = (n) => String(n).padStart(2, "0");
export const clock = (t) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

export const movedAsideBanner = (name) => name
  ? `The job list couldn't be read and was saved as ${name}. Jobs that were running may not reconnect.`
  : "The job list couldn't be read. Jobs that were running may not reconnect.";

export const stateErrorBanner = (film, message) => `Couldn't save ${basename(film)}'s state: ${message}`;

export function jobsModel({ jobs = [], log = null, retried = new Set(), persistError = null, gone = new Map(), role }) {
  const rows = jobs.map((j, i) => jobRow(j, i, jobs, retried, gone.get(j.id), { role })).reverse();
  return {
    rows,
    log: log ? log.map((e) => ({ time: clock(e.t), text: String(e.text ?? "") })) : null,
    logEmpty: log ? (log.length ? null : "Nothing logged yet") : "Open a film to see its activity",
    keepOpen: jobs.some(active),
    banner: persistError
      ? `Couldn't save job progress to the drive: ${persistError}. If you close the app now, running jobs may not reconnect.`
      : null,
  };
}

function jobCard(r, actions) {
  const bar = r.status !== "running" && r.status !== "done" ? null
    : h("div", { class: `bar${r.indeterminate ? " ind" : ""}` }, h("i", { style: { width: r.indeterminate ? "100%" : `${r.pct ?? 0}%` } }));
  return h("div", { class: `job ${r.status}` },
    h("div", { class: "h" },
      r.live ? h("span", { class: "dot live" }) : null,
      h("span", { class: "what", text: r.what }),
      h("span", { class: "tool", text: r.tool }),
      r.from ? h("span", { class: "tool from", text: r.from }) : null,
      h("span", { class: "eta", text: r.eta })),
    bar,
    h("div", { class: "sub" }, [r.filmTitle, r.why].filter(Boolean).join(" · ")),
    r.error ? h("div", { class: "err", text: r.error }) : null,
    r.warning ? h("div", { class: "warn", text: r.warning }) : null,
    r.canWithdraw ? h("div", { class: "row" }, btn("Withdraw", (e) => { e.currentTarget.disabled = true; actions.withdraw(r.id); }, { ghost: true })) : null,
    r.error ? h("div", { class: "row" },
      r.canCheck ? btn("Check again", (e) => { e.currentTarget.disabled = true; actions.check(r.id); }) : null,
      r.retryNote ? h("span", { class: "hist", text: r.retryNote })
        : btn(r.retryLabel, (e) => { e.currentTarget.disabled = true; actions.retry(r.id); }, { ghost: true, disabled: !r.canRetry })) : null,
  );
}

export function render(el, model, actions) {
  const list = model.rows.length ? model.rows.map((r) => jobCard(r, actions)) : h("p", { class: "lede", text: "No jobs yet." });
  const log = h("div", { class: "log" },
    model.log && model.log.length
      ? model.log.map((e) => h("p", {}, h("time", { text: e.time }), h("span", { text: e.text })))
      : h("p", { class: "empty", text: model.logEmpty }));
  el.replaceChildren(
    h("h1", { text: "What's happening now" }),
    h("p", { class: "lede", text: "Every job the app has started, in plain English, with progress where the tool reports it. Finished jobs land on the review board." }),
    h("div", { class: "grid2" },
      h("div", {}, list),
      h("div", {}, h("div", { class: "eyebrow", style: { marginBottom: "10px" }, text: "Activity" }), log)),
  );
}
