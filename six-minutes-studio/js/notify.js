// Pure rules for desktop notifications: compare two job snapshots, return the messages to show.
const MAX = 300;
const cap = (s) => (s.length > MAX ? s.slice(0, MAX - 1) + "…" : s);
const cap1 = (s) => String(s ?? "").charAt(0).toUpperCase() + String(s ?? "").slice(1);
const live = (j) => j.status === "queued" || j.status === "running";
const folder = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

export function notifyRules(prev = [], next = []) {
  const before = new Map(prev.map((j) => [j.id, j]));
  const out = [];
  for (const j of next) {
    const old = before.get(j.id);
    if (!old || old.status === j.status) continue;
    if (j.status === "done") out.push(`${j.assetId} take ${j.take} is ready to review`);
    else if (j.status === "failed") out.push(`${j.assetId} take ${j.take} failed in ${cap1(j.tool)}`);
  }
  for (const film of new Set(prev.filter(live).map((j) => j.film))) {
    if (!next.some((j) => j.film === film && live(j))) out.push(`All shots for ${folder(film)} are ready`);
  }
  return out.map(cap);
}
