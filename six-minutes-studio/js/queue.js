// The queue: JSON files in <root>\.studio-queue\ that carry graphics jobs from a laptop to the desktop.
// One writer per file: the laptop writes request, withdrawn and check files; the desktop writes answers.
// Every write goes to .tmp then renames; nothing is ever deleted (finished files move to finished\).
import { join } from "./paths.js";
import { writeSafely } from "./libraryio.js";

export const QUEUE_DIR = ".studio-queue";
export const FINISHED = "finished";

const dirOf = (root) => join(root, QUEUE_DIR);
const lower = (s) => String(s).toLowerCase();
const REQUEST = ".request.json";
const ANSWER = ".answer.json";
const WITHDRAWN = ".withdrawn.json";

async function put(host, root, name, body) {
  const dir = dirOf(root);
  await host.fs.mkdir(dir);
  await writeSafely(host, join(dir, name), JSON.stringify(body, null, 2));
}

const fileNames = (entries) => entries.filter((e) => e.isFile !== false && e.isDirectory !== true).map((e) => e.name);

async function names(host, dir) {
  try { return fileNames(await host.fs.list(dir)); } catch { return []; }
}

async function readJson(host, path) {
  try {
    const v = JSON.parse(await host.fs.read(path, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

async function readAll(host, root, suffix) {
  const dir = dirOf(root);
  const out = [];
  for (const n of (await names(host, dir)).filter((n) => lower(n).endsWith(suffix)).sort()) {
    const v = await readJson(host, join(dir, n));
    if (v) out.push(v);
  }
  return out;
}

export const writeRequest = (host, root, { id, from, root: fromRoot, job }) =>
  put(host, root, `${id}${REQUEST}`, { id, from, root: fromRoot, job, at: host.now() });

export const readAnswer = (host, root, id) => readJson(host, join(dirOf(root), `${id}${ANSWER}`));

export const writeAnswer = (host, root, answer) => {
  const { id, by, status, progress, eta, file, meta, error, ambiguous, checks } = answer;
  return put(host, root, `${id}${ANSWER}`, { id, by, status, progress, eta, file, meta, error, ambiguous, checks });
};

export const writeWithdrawn = (host, root, id) => put(host, root, `${id}${WITHDRAWN}`, { id, at: host.now() });

export async function hasWithdrawn(host, root, id) {
  try { return !!(await host.fs.exists(join(dirOf(root), `${id}${WITHDRAWN}`))); } catch { return false; }
}

export async function writeCheck(host, root, id) {
  const at = host.now();
  const name = `${id}.check-${at}.json`;
  await put(host, root, name, { id, at });
  return name;
}

const isCheck = (n, id) => {
  const p = lower(`${id}.check-`);
  return lower(n).startsWith(p) && /^\d+\.json$/.test(lower(n).slice(p.length));
};

export async function listChecks(host, root, id) {
  return (await names(host, dirOf(root))).filter((n) => isCheck(n, id)).sort();
}

export const listRequests = (host, root) => readAll(host, root, REQUEST);
export const listAnswers = (host, root) => readAll(host, root, ANSWER);

// Requests with no answer yet. The folder is listed once and both sets come from that one listing,
// so a listing that fails (a mapped drive waking up) shows nothing pending rather than every request.
export async function pendingRequests(host, root) {
  const dir = dirOf(root);
  let all;
  try { all = fileNames(await host.fs.list(dir)); } catch { return []; }
  const answered = new Set(all.filter((n) => lower(n).endsWith(ANSWER)).map(lower));
  const out = [];
  for (const n of all.filter((n) => lower(n).endsWith(REQUEST)).sort()) {
    const r = await readJson(host, join(dir, n));
    if (r && typeof r.id === "string" && !answered.has(lower(`${r.id}${ANSWER}`))) out.push(r);
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

// Presence is decided from listings, never from exists(): an exists() that can't reach the drive may just say
// false, while a listing that fails throws. These answer false only from listings that worked.
// The queue folder's entries; [] only when the project folder lists fine and has no queue folder yet.
async function queueEntries(host, root) {
  try { return await host.fs.list(dirOf(root)); } catch (e) {
    const top = await host.fs.list(root); // throws when the project folder can't be read either
    if (top.some((t) => lower(t.name) === lower(QUEUE_DIR))) throw e;
    return [];
  }
}
// File names in finished\; [] only when the queue folder's listing shows there is no finished\ yet.
async function finishedNames(host, root) {
  const q = await queueEntries(host, root);
  if (!q.some((e) => lower(e.name) === FINISHED && e.isDirectory !== false)) return { queue: fileNames(q), finished: [] };
  return { queue: fileNames(q), finished: fileNames(await host.fs.list(join(dirOf(root), FINISHED))) };
}

// Is the answer file in the queue folder? Throws when it can't tell.
export async function answerInQueue(host, root, id) {
  return fileNames(await queueEntries(host, root)).some((n) => lower(n) === lower(`${id}${ANSWER}`));
}

// Is this request anywhere, in the queue folder or in finished\? Throws when it can't tell.
export async function requestAnywhere(host, root, id) {
  const q = await queueEntries(host, root);
  if (fileNames(q).some((n) => lower(n) === lower(`${id}${REQUEST}`))) return true;
  const { finished } = await finishedNames(host, root);
  return finished.some((n) => filedAs(n, id, REQUEST));
}

// A file name in finished\ for this id and kind: the plain name, or the plain name with `_<ms>` added.
const filedAs = (n, id, suffix) => {
  const stem = lower(`${id}${suffix.replace(/\.json$/, "")}`);
  return lower(n) === `${stem}.json` || (lower(n).startsWith(`${stem}_`) && lower(n).endsWith(".json"));
};

// The desktop's answer once it has been filed in finished\ (the latest one if there are several), or null when
// the listings worked and there is none. A failed listing or read throws, so the caller looks again later.
export async function readFinishedAnswer(host, root, id) {
  const fin = join(dirOf(root), FINISHED);
  const found = (await finishedNames(host, root)).finished.filter((n) => filedAs(n, id, ANSWER)).sort();
  for (const n of found.reverse()) {
    const v = JSON.parse(await host.fs.read(join(fin, n), "utf8"));
    if (v && typeof v === "object") return v;
  }
  return null;
}

// A name not already taken in finished\: `_<ms>` before .json, then more digits if still taken.
async function freeName(host, dir, name, now) {
  if (!(await host.fs.exists(join(dir, name)))) return name;
  const stem = name.replace(/\.json$/i, "");
  for (let i = 0; ; i++) {
    const n = `${stem}_${now}${i ? `-${i}` : ""}.json`;
    if (!(await host.fs.exists(join(dir, n)))) return n;
  }
}

export async function moveMine(host, root, id, side) {
  const dir = dirOf(root);
  const fin = join(dir, FINISHED);
  const mine = side === "laptop"
    ? (n) => lower(n) === lower(`${id}${REQUEST}`) || lower(n) === lower(`${id}${WITHDRAWN}`) || isCheck(n, id)
    : (n) => lower(n) === lower(`${id}${ANSWER}`);
  const found = (await names(host, dir)).filter(mine);
  if (!found.length) return;
  await host.fs.mkdir(fin);
  for (const n of found) {
    await host.fs.rename(join(dir, n), join(fin, await freeName(host, fin, n, host.now())));
  }
}

export async function requestFinished(host, root, id) {
  const name = `${id}${REQUEST}`;
  try {
    if (await host.fs.exists(join(dirOf(root), name))) return false;
    const inFinished = await names(host, join(dirOf(root), FINISHED));
    return inFinished.some((n) => filedAs(n, id, REQUEST));
  } catch { return false; }
}
