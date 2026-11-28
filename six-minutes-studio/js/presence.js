// Presence: each computer writes a small file in <root>\.studio-presence\ every BEAT_MS; the other
// computer reads them. "Seen" is judged by the reader's own clock (did the contents change lately?),
// never by the clock in the file, because the two computers' clocks can disagree.
import { UNNAMED } from "./computer.js";
import { join } from "./paths.js";
import { writeSafely } from "./libraryio.js";
import { clock } from "./ui/jobs.js";

export const PRESENCE_DIR = ".studio-presence";
export const BEAT_MS = 30000;
export const SEEN_MS = 90000;

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function makePresence(host, { root, computer, role, state }) {
  const dir = join(root, PRESENCE_DIR);
  const memory = new Map(); // file name -> { text, changedAt }
  // A failed write and a failed read are kept apart, so a good read can't hide a failed beat (or the other way).
  let beatError = null, readError = null;
  const api = {
    get serverError() { return beatError ?? readError; },
    async beat() {
      if (computer === UNNAMED) return;
      try {
        const s = state();
        await host.fs.mkdir(dir);
        const body = { computer, role, at: host.now(), paused: !!s.paused, running: num(s.running), waiting: num(s.waiting), tools: s.tools ?? {} };
        await writeSafely(host, join(dir, `${computer}.json`), JSON.stringify(body, null, 2));
        beatError = null;
      } catch (e) { beatError = String(e?.message ?? e); }
    },
    async read() {
      let entries;
      try {
        entries = await host.fs.list(dir);
        readError = null;
      } catch (e) { readError = String(e?.message ?? e); return []; }
      const peers = [];
      for (const e of entries) {
        if (e.isFile === false || !/\.json$/i.test(e.name)) continue;
        if (same(e.name, `${computer}.json`)) continue;
        let text, v;
        try {
          text = await host.fs.read(join(dir, e.name), "utf8");
          v = JSON.parse(text);
        } catch { continue; }
        if (!v || typeof v !== "object") continue;
        const now = host.now();
        const known = memory.get(e.name);
        let changedAt;
        if (!known) changedAt = Number.isFinite(v.at) ? v.at : now;
        else changedAt = known.text === text ? known.changedAt : now;
        memory.set(e.name, { text, changedAt });
        peers.push({
          computer: String(v.computer ?? e.name.replace(/\.json$/i, "")),
          role: v.role,
          seen: now - changedAt <= SEEN_MS,
          lastSeen: changedAt,
          paused: v.paused === true,
          running: num(v.running),
          waiting: num(v.waiting),
          tools: v.tools ?? {},
        });
      }
      return peers;
    },
  };
  return api;
}

const jobs = (n) => `${n} job${n === 1 ? "" : "s"}`;
const newest = (peers) => peers.reduce((a, b) => (!a || b.lastSeen > a.lastSeen ? b : a), null);

function desktopText(d) {
  if (!d) return "Desktop: not seen yet";
  if (!d.seen) return `Desktop: not seen since ${clock(d.lastSeen)}`;
  if (d.paused) return "Desktop: laptop jobs paused";
  if (d.running > 0) return `Desktop: busy (${jobs(d.running)})`;
  return "Desktop: ready";
}

function laptopText(p, name) {
  let t = `${name}: ${p.seen ? "seen just now" : `last seen ${clock(p.lastSeen)}`}`;
  const bits = [p.waiting > 0 && `${p.waiting} waiting`, p.running > 0 && `${p.running} running`].filter(Boolean);
  return bits.length ? `${t} · ${bits.join(", ")}` : t;
}

export function linkLine({ role, peers, serverError, root }) {
  const parts = [];
  if (serverError) parts.push(`Can't reach the server (${root})`);
  if (role === "desktop") {
    const laptops = peers.filter((p) => p.role === "laptop");
    for (const p of laptops) parts.push(laptopText(p, laptops.length === 1 ? "Laptop" : p.computer));
  } else {
    parts.push(desktopText(newest(peers.filter((p) => p.role === "desktop"))));
  }
  return parts.length ? parts.join("; ") : null;
}

export function desktopState(peers) {
  const d = newest(peers.filter((p) => p.role === "desktop"));
  if (!d) return { text: " (not seen yet)", ready: false };
  if (!d.seen) return { text: ` (not seen since ${clock(d.lastSeen)})`, ready: false };
  if (d.paused) return { text: " (laptop jobs paused)", ready: false };
  return { text: d.running > 0 ? " (busy)" : "", ready: true };
}
