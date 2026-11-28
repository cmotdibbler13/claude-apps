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

async function names(host, dir) {
  try {
    const entries = await host.fs.list(dir);
    return entries.filter((e) => e.isFile !== false && e.isDirectory !== true).map((e) => e.name);
  } catch { return []; }
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

export async function pendingRequests(host, root) {
  const answered = new Set((await names(host, dirOf(root))).filter((n) => lower(n).endsWith(ANSWER)).map(lower));
  const all = await listRequests(host, root);
  return all
    .filter((r) => typeof r.id === "string" && !answered.has(lower(`${r.id}${ANSWER}`)))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
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
    return inFinished.some((n) => lower(n) === lower(name) || (lower(n).startsWith(lower(`${id}.request_`)) && lower(n).endsWith(".json")));
  } catch { return false; }
}
