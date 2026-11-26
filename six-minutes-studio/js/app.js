// Boot: host, install gate, project root, jobs, routing and re-rendering of the three screens.
import { makeHost } from "./host.js";
import { accessGate } from "./gate.js";
import { resolveRoot, join } from "./paths.js";
import { loadSettings } from "./settings.js";
import { scanFilms } from "./films.js";
import { makeFilmSession, readSavedJobs } from "./session.js";
import { makeJobs } from "./jobs.js";
import { notifyRules } from "./notify.js";
import { buildShotList } from "./shots.js";
import { startTake, approve, unapprove, choose, setTool, setPreferComfy } from "./redo.js";
import { ensureProxy, toBlobUrl, openFull, revokeAll } from "./media.js";
import { makeHiggsfieldRunner } from "./tools/higgsfield.js";
import { makeBlenderRunner } from "./tools/blender.js";
import { makeComfyRunner } from "./tools/comfyui.js";
import { mountProbe } from "./ui/probe.js";
import * as filmsView from "./ui/films.js";
import * as jobsView from "./ui/jobs.js";
import * as reviewView from "./ui/review.js";

const $ = (id) => document.getElementById(id);
const msg = (e) => String(e?.message ?? e);
const LAYOUT_KEY = "six-minutes-studio.reviewLayout";

const app = {
  host: null, root: null, jobs: null, films: [], view: "films",
  film: null, store: null, session: null, retried: new Set(), movedAside: null, stateError: null, bootError: null, openError: null,
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

// ---- notifications and tray ----
// Nothing is asked of the person until their first job start (a click): restore() at boot never notifies.
let armed = false, prevJobs = [], trayAt = 0, trayTimer = null, trayIcon = null;

function drawTrayIcon() {
  if (trayIcon) return trayIcon;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = "#d5a867"; g.beginPath(); g.arc(16, 16, 11, 0, Math.PI * 2); g.fill();
  return (trayIcon = c.toDataURL("image/png"));
}

function updateTray() {
  if (!armed || !app.host?.tray) return;
  const wait = trayAt + 2000 - Date.now();
  if (wait > 0) { if (!trayTimer) trayTimer = setTimeout(() => { trayTimer = null; updateTray(); }, wait); return; }
  trayAt = Date.now();
  try {
    const n = jobsView.activeCount(app.jobs ? app.jobs.list() : []);
    const open = () => { try { app.host.showWindow?.().catch(() => {}); } catch { /* ignore */ } };
    Promise.resolve(app.host.tray({
      icon: drawTrayIcon(), iconIsTemplate: false,
      toolTip: `Six Minutes Studio \u2014 ${n} running`,
      menu: [
        { label: "Open", click: open },
        { label: "Live jobs", click: () => { open(); showView("jobs"); } },
      ],
    })).catch(() => {});
  } catch { /* tray failures never break the app */ }
}

function userStarted() {
  if (armed) return;
  armed = true;
  prevJobs = app.jobs ? app.jobs.list() : [];
  updateTray();
}

function onJobsChanged(list) {
  if (!armed) { prevJobs = list; return; }
  const msgs = notifyRules(prevJobs, list);
  prevJobs = list;
  for (const m of msgs) { try { Promise.resolve(app.host.notify(m)).catch(() => {}); } catch { /* a no is final */ } }
  updateTray();
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
  const moved = $("moved-banner");
  moved.hidden = !app.movedAside;
  moved.textContent = app.movedAside ? jobsView.movedAsideBanner(app.movedAside.name) : "";
  const se = app.stateError;
  $("state-banner").hidden = !se;
  $("state-banner").textContent = se ? jobsView.stateErrorBanner(se.film, se.message) : "";

  if (app.view === "films") {
    paint("films", $("view-films"), filmsView.filmsModel({ root: app.root, films: app.films, jobs: list, error: app.bootError }), filmsView, filmsActions);
  } else if (app.view === "jobs") {
    const log = app.store ? await app.store.readLog(50) : null;
    const model = jobsView.jobsModel({ jobs: list, log, retried: app.retried, persistError: null });
    paint("jobs", $("view-jobs"), model, jobsView, jobsActions);
  } else if (app.view === "review") {
    const r = app.review;
    const model = reviewView.reviewModel({
      film: app.film, state: app.store?.state, layout: app.layout, making: r.making, listError: r.listError,
      cardErrors: r.cardErrors, pending: r.pending, noteFor: r.noteFor, openError: app.openError, prefError: r.prefError ?? null,
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
    app.settings = settings;
    const file = join(app.root, ".studio-jobs.json");
    app.jobs = makeJobs(host, {
      runners: {
        higgsfield: makeHiggsfieldRunner({ settings }),
        blender: makeBlenderRunner({ settings }),
        comfyui: makeComfyRunner({ settings }),
      },
      file,
    });
    const saved = await readSavedJobs(host, file, { onMovedAside: (name) => { app.movedAside = { name }; } });
    app.session = makeFilmSession({
      host, jobs: app.jobs, onSaved: () => render(),
      onSaveError: (message, film) => { app.stateError = message ? { film, message } : null; render(); },
    });
    app.jobs.onChange((list) => { onJobsChanged(list); render(); });
    app.jobs.onPersistError(() => render());
    app.jobs.restore(saved);
  }
  app.films = await scanFilms(host, app.root);
  render();
}

// Boot (and Try again): a failure shows on the Films screen with its message, not only in the console.
function startRoot() {
  if (app.bootError) { app.bootError = null; render(); }
  return loadRoot().catch((e) => { console.error(e); app.bootError = msg(e); render(); });
}

const filmsActions = {
  retryRoot: () => { startRoot(); },
  openReview: (dir) => { openReview(dir); },
};

function resetReview() {
  app.previews.clear();
  revokeAll();
  app.review = { making: false, listError: null, cardErrors: new Map(), pending: new Set(), noteFor: null, draft: "" };
}

// The session keeps one store and one watcher; a superseded open resolves to null and is ignored.
// A failed open shows on the review screen with Try again.
async function openReview(dir) {
  const film = app.films.find((f) => f.dir === dir);
  if (!film) return;
  let store;
  try {
    store = await app.session.open(dir);
  } catch (e) {
    console.error(e);
    app.openError = { dir, title: film.title, message: msg(e) };
    showView("review");
    return;
  }
  if (!store || app.session.current?.store !== store) return;
  app.openError = null;
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
    userStarted();
    try { app.jobs.retry(id); } catch (e) { console.error(e); }
    render();
  },
  // Free: polls the existing job by its id, never generates.
  check(id) {
    userStarted();
    try { app.jobs.check(id); } catch (e) { console.error(e); }
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
  userStarted();
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
  first: cardAction((id) => { userStarted(); return startTake(ctx(), id); }),
  approve: cardAction((id) => approve(ctx(), id)),
  unapprove: cardAction((id) => unapprove(ctx(), id)),
  choose: cardAction((id, n) => choose(ctx(), id, n)),
  redo: cardAction(async (id, note) => {
    if (!note || !note.trim()) throw new Error("Write a note saying what should change.");
    userStarted();
    await startTake(ctx(), id, { note: note.trim() });
    app.review.noteFor = null; app.review.draft = "";
  }),
  // Through cardAction so the per-shot pending guard also covers a take being prepared.
  setTool: cardAction((id, tool) => setTool(ctx(), id, tool)),
  // Ignored while any card action or the shot list is in flight; resolves true once saved.
  async setPreferComfy(on) {
    const r = app.review;
    if (r.pending.size || r.making || r.prefSaving || !app.store) return false;
    r.prefSaving = true; r.prefError = null;
    try { await setPreferComfy(ctx(), on); return true; }
    catch (e) { r.prefError = `Couldn't save the preference: ${msg(e)}`; return false; }
    finally { r.prefSaving = false; render(); }
  },
  openNote(id) { app.review.noteFor = id; app.review.draft = ""; app.review.focusNote = true; render(); },
  closeNote() { app.review.noteFor = null; app.review.draft = ""; render(); },
  draft: () => app.review.draft,
  setDraft(v) { app.review.draft = v; },
  openFull: (file) => { openFull(app.host, file).catch((e) => console.error(e)); },
  reopen: (dir) => { openReview(dir); },
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
  mountProbe(host, $("run-probe"), $("probe-results"), () => app.settings);
  await startWithAccess();
}

// Read the full-access state without asking; anything but "granted" waits for a click before any fs call.
async function startWithAccess(fromClick = false) {
  let state = await app.host.permissionState("full-access");
  if (fromClick && state === "prompt") state = await app.host.requestPermission("full-access");
  const g = accessGate(state);
  const sections = document.querySelectorAll("main > section[data-view]");
  if (!g.boot) {
    for (const s of sections) s.hidden = true;
    $("nav").hidden = true;
    $("gate").hidden = false;
    $("gate-title").textContent = g.title;
    $("gate-msg").textContent = g.message;
    const b = $("install");
    b.textContent = g.button;
    b.hidden = false;
    b.disabled = false;
    b.onclick = () => {
      b.disabled = true;
      const next = g.action === "manage"
        ? app.host.managePermissions().catch(() => {}).then(() => startWithAccess())
        : startWithAccess(g.action === "request");
      next.catch((e) => console.error(e)).finally(() => { b.disabled = false; });
    };
    return;
  }
  $("gate").hidden = true;
  $("nav").hidden = false;
  for (const s of sections) s.hidden = s.dataset.view !== app.view;
  await startRoot();
}

boot();
