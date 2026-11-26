// Boot: host, install gate, project root, jobs, routing and re-rendering of the three screens.
import { makeHost } from "./host.js";
import { resolveRoot, join } from "./paths.js";
import { loadSettings } from "./settings.js";
import { scanFilms } from "./films.js";
import { makeFilmSession, readSavedJobs } from "./session.js";
import { makeJobs } from "./jobs.js";
import { buildShotList } from "./shots.js";
import { startTake, approve, unapprove, choose } from "./redo.js";
import { ensureProxy, toBlobUrl, openFull, revokeAll } from "./media.js";
import { makeHiggsfieldRunner } from "./tools/higgsfield.js";
import { makeBlenderRunner } from "./tools/blender.js";
import { mountProbe } from "./ui/probe.js";
import * as filmsView from "./ui/films.js";
import * as jobsView from "./ui/jobs.js";
import * as reviewView from "./ui/review.js";

const $ = (id) => document.getElementById(id);
const msg = (e) => String(e?.message ?? e);
const LAYOUT_KEY = "six-minutes-studio.reviewLayout";

const app = {
  host: null, root: null, jobs: null, films: [], view: "films",
  film: null, store: null, session: null, retried: new Set(),
  review: { making: false, listError: null, cardErrors: new Map(), pending: new Set(), noteFor: null, draft: "" },
  previews: new Map(),
  layout: (() => { try { return localStorage.getItem(LAYOUT_KEY) || "script"; } catch { return "script"; } })(),
};

function showView(name) {
  app.view = name;
  for (const s of document.querySelectorAll("main > section[data-view]")) s.hidden = s.dataset.view !== name;
  for (const b of document.querySelectorAll("#nav button")) b.setAttribute("aria-selected", String(b.dataset.view === name));
  render();
  // Coming back to Films re-reads the folders so parts and waiting lines are current.
  if (name === "films" && app.root && app.host) scanFilms(app.host, app.root).then((f) => { app.films = f; render(); }, () => {});
}

function drawIcon() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#091a2e"; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "#d5a867"; g.lineWidth = 8; g.strokeRect(24, 24, 208, 208);
  g.fillStyle = "#d5a867"; g.font = "300 120px Inter, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("6", 128, 136);
  return c.toDataURL("image/png");
}

// ---- rendering ----
// Coalesce bursts (Blender reports every frame) into one render; skip views whose model has not changed.
let timer = null;
const last = {};
function render() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; renderNow().catch((e) => console.error(e)); }, 120);
}

function paint(name, el, model, view, actions) {
  const sig = JSON.stringify(model);
  if (last[name] === sig) return;
  last[name] = sig;
  // A re-render replaces the note box; keep the caret there if Jon was typing (or just opened it).
  const refocus = document.activeElement?.id === "note-box" || (name === "review" && app.review.focusNote);
  view.render(el, model, actions);
  const ta = refocus ? $("note-box") : null;
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); app.review.focusNote = false; }
}

async function renderNow() {
  const list = app.jobs ? app.jobs.list() : [];
  const count = jobsView.activeCount(list);
  const badge = $("jobcount");
  badge.textContent = count ? String(count) : "";
  badge.hidden = !count;
  $("keep-open").hidden = !list.some((j) => j.status === "queued" || j.status === "running");
  const pe = app.jobs?.persistError ?? null;
  const banner = $("persist-banner");
  banner.hidden = !pe;
  banner.textContent = pe ? jobsView.jobsModel({ persistError: pe }).banner : "";

  if (app.view === "films") {
    paint("films", $("view-films"), filmsView.filmsModel({ root: app.root, films: app.films, jobs: list }), filmsView, filmsActions);
  } else if (app.view === "jobs") {
    const log = app.store ? await app.store.readLog(50) : null;
    const model = jobsView.jobsModel({ jobs: list, log, retried: app.retried, persistError: null });
    paint("jobs", $("view-jobs"), model, jobsView, jobsActions);
  } else if (app.view === "review") {
    const r = app.review;
    const model = reviewView.reviewModel({
      film: app.film, state: app.store?.state, layout: app.layout, making: r.making, listError: r.listError,
      cardErrors: r.cardErrors, pending: r.pending, noteFor: r.noteFor,
    });
    paint("review", $("view-review"), model, reviewView, reviewActions);
  }
}

// ---- films ----
async function loadRoot() {
  const { host } = app;
  app.root = await resolveRoot(host);
  if (!app.root) { app.films = []; render(); return; }
  if (!app.jobs) {
    const settings = await loadSettings(host, app.root);
    const file = join(app.root, ".studio-jobs.json");
    app.jobs = makeJobs(host, {
      runners: { higgsfield: makeHiggsfieldRunner({ settings }), blender: makeBlenderRunner({ settings }) },
      file,
    });
    const saved = await readSavedJobs(host, file);
    app.session = makeFilmSession({ host, jobs: app.jobs, onSaved: () => render() });
    app.jobs.onChange(() => render());
    app.jobs.onPersistError(() => render());
    app.jobs.restore(saved);
  }
  app.films = await scanFilms(host, app.root);
  render();
}

const filmsActions = {
  retryRoot: () => { loadRoot().catch((e) => console.error(e)); },
  openReview: (dir) => { openReview(dir).catch((e) => console.error(e)); },
};

function resetReview() {
  app.previews.clear();
  revokeAll();
  app.review = { making: false, listError: null, cardErrors: new Map(), pending: new Set(), noteFor: null, draft: "" };
}

// The session keeps one store and one watcher; a superseded open resolves to null and is ignored.
async function openReview(dir) {
  const film = app.films.find((f) => f.dir === dir);
  if (!film) return;
  const store = await app.session.open(dir);
  if (!store || app.session.current?.store !== store) return;
  if (app.store !== store) {
    resetReview();
    app.film = film;
    app.store = store;
  }
  showView("review");
}

// ---- live jobs ----
const jobsActions = {
  retry(id) {
    if (app.retried.has(id)) return;
    app.retried.add(id);
    try { app.jobs.retry(id); } catch (e) { console.error(e); }
    render();
  },
};

// ---- review ----
async function readText(p) { try { return await app.host.fs.read(p, "utf8"); } catch { return null; } }

async function findScript(dir, handoverText) {
  for (const p of reviewView.scriptCandidates(handoverText ?? "", dir)) {
    const t = await readText(p);
    if (t !== null) return t;
  }
  let entries = [];
  try { entries = await app.host.fs.list(dir); } catch { /* unreadable folder */ }
  const hit = entries.find((e) => !e.isDirectory && /_script\.md$/i.test(e.name));
  return hit ? readText(join(dir, hit.name)) : null;
}

async function makeShotList() {
  const r = app.review;
  if (r.making) return;
  r.making = true; r.listError = null; render();
  try {
    const dir = app.film.dir;
    const handoverText = await readText(join(dir, "handover", "part1_handover.md"));
    if (handoverText === null) throw new Error("Couldn't read handover\\part1_handover.md.");
    const scriptText = await findScript(dir, handoverText);
    if (scriptText === null) throw new Error("Couldn't find the script. Add its path to part1_handover.md.");
    await buildShotList(app.host, app.store, { scriptText, handoverText });
  } catch (e) {
    r.listError = msg(e);
  } finally {
    r.making = false;
    render();
  }
}

function cardAction(fn) {
  return async (id, ...args) => {
    const r = app.review;
    if (r.pending.has(id)) return;
    r.pending.add(id); r.cardErrors.delete(id); render();
    try { await fn(id, ...args); } catch (e) { r.cardErrors.set(id, msg(e)); }
    finally { r.pending.delete(id); render(); }
  };
}
const ctx = () => ({ host: app.host, store: app.store, jobs: app.jobs });

function preview(file) {
  if (!app.previews.has(file)) {
    // ensureProxy returns images as they are and a 640px proxy for video: a full-size video is never read into memory.
    app.previews.set(file, ensureProxy(app.host, file).then((p) => toBlobUrl(app.host, p)));
  }
  return app.previews.get(file);
}

const reviewActions = {
  makeShotList: () => { makeShotList(); },
  setLayout(v) {
    app.layout = v;
    try { localStorage.setItem(LAYOUT_KEY, v); } catch { /* storage blocked: per-session only */ }
    render();
  },
  first: cardAction((id) => startTake(ctx(), id)),
  approve: cardAction((id) => approve(ctx(), id)),
  unapprove: cardAction((id) => unapprove(ctx(), id)),
  choose: cardAction((id, n) => choose(ctx(), id, n)),
  redo: cardAction(async (id, note) => {
    if (!note || !note.trim()) throw new Error("Write a note saying what should change.");
    await startTake(ctx(), id, { note: note.trim() });
    app.review.noteFor = null; app.review.draft = "";
  }),
  openNote(id) { app.review.noteFor = id; app.review.draft = ""; app.review.focusNote = true; render(); },
  closeNote() { app.review.noteFor = null; app.review.draft = ""; render(); },
  draft: () => app.review.draft,
  setDraft(v) { app.review.draft = v; },
  openFull: (file) => { openFull(app.host, file).catch((e) => console.error(e)); },
  preview,
};

// ---- boot ----
async function boot() {
  $("nav").onclick = (e) => { const v = e.target.closest("button")?.dataset.view; if (v) showView(v); };
  const host = await makeHost().catch(() => null);
  if (!host) {
    for (const s of document.querySelectorAll("main > section[data-view]")) s.hidden = true;
    $("nav").hidden = true;
    $("gate").hidden = false;
    const desktop = await window.claude?.use("desktop").catch(() => null);
    if ((await desktop?.install?.state()) === "available") {
      $("gate-msg").textContent = "Install this page as an app, then allow full access when asked.";
      $("install").hidden = false;
      $("install").onclick = () => desktop.install.request().catch(() => {});
    } else {
      $("gate-msg").textContent = "This page works only in its desktop app, which can be installed from the Claude desktop app.";
    }
    return;
  }
  app.host = host;
  const desktop = await window.claude.use("desktop");
  desktop.app?.dock?.setIcon(drawIcon()).catch(() => {});
  mountProbe(host, $("run-probe"), $("probe-results"));
  await loadRoot().catch((e) => { console.error(e); render(); });
}

boot();
