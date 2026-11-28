// Pure rules for desktop notifications: compare two job snapshots, return the messages to show.
import { filmKey } from "./paths.js";
import { toolLabel } from "./labels.js";

const MAX = 300;
const cap = (s) => (s.length > MAX ? s.slice(0, MAX - 1) + "…" : s);
const live = (j) => j.status === "queued" || j.status === "running";
const nameOf = (id) => (id === "SCORE" ? "Score" : id);
const folder = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

export function notifyRules(prev = [], next = []) {
  // Jobs taken from another computer are that computer's business, not this one's.
  prev = prev.filter((j) => !j.from);
  next = next.filter((j) => !j.from);
  const before = new Map(prev.map((j) => [j.id, j]));
  const out = [];
  for (const j of next) {
    const old = before.get(j.id);
    if (!old || old.status === j.status) continue;
    if (j.status === "done") out.push(`${nameOf(j.assetId)} take ${j.take} is ready to review`);
    else if (j.status === "failed") out.push(`${nameOf(j.assetId)} take ${j.take} failed in ${toolLabel(j.tool)}`);
  }
  for (const key of new Set(prev.filter(live).map((j) => filmKey(j.film)))) {
    if (next.some((j) => filmKey(j.film) === key && live(j))) continue;
    out.push(filmDone(key, prev, next));
  }
  return out.map(cap);
}

// "Nothing left running for <film>: <a> ready, <b> failed", counting this batch only: jobs that were
// running or queued just now, and jobs that ended since the earliest of those started. A retried take
// counts once, by its latest job.
function filmDone(key, prev, next) {
  const ofFilm = (j) => filmKey(j.film) === key;
  const wasLive = prev.filter((j) => ofFilm(j) && live(j));
  const ids = new Set(wasLive.map((j) => j.id));
  const starts = wasLive.map((j) => j.startedAt).filter(Number.isFinite);
  const since = starts.length ? Math.min(...starts) : Infinity;
  const latest = new Map();
  for (const j of next) if (ofFilm(j)) latest.set(`${j.assetId}\u0000${j.take}`, j);
  let ready = 0, failed = 0;
  for (const j of latest.values()) {
    if (!ids.has(j.id) && !(Number.isFinite(j.endedAt) && j.endedAt >= since)) continue;
    if (j.status === "done") ready++;
    else if (j.status === "failed" || j.status === "interrupted") failed++;
  }
  const parts = [ready ? `${ready} ready` : null, failed ? `${failed} failed` : null].filter(Boolean);
  const name = folder(wasLive[0]?.film);
  return `Nothing left running for ${name}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}
