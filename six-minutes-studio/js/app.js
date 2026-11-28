// Boot: host, install gate, project root, jobs, routing and re-rendering of the three screens.
import { makeHost } from "./host.js";
import { accessGate } from "./gate.js";
import { join, filmKey, rootSpellings } from "./paths.js";
import { loadSettings } from "./settings.js";
import { setToolPaths } from "./toolpaths.js";
import { findRoot, rebasedHost, liveHost, readRawSettings, rootToRecord } from "./boot.js";
import { computerName, roleNeeded, saveComputerSettings, sendsToDesktop, UNNAMED } from "./computer.js";
import { DESKTOP_TOOLS } from "./labels.js";
import { makePresence, linkLine, BEAT_MS } from "./presence.js";
import { presenceState } from "./linkstate.js";
import { makeDesktopRunner, tidyRequests } from "./tools/desktop.js";
import { makeDesktopWorker } from "./desktopworker.js";
import { installApp } from "./installapps.js";
import { withRerecord, rerecordsToClear, lineWords, takeSig, addMark, setSize, moveMark, removeMark, placeFromNotes, newTakeIds } from "./pacing.js";
import { applyPauses, JOINED_WITHOUT } from "./pacingchain.js";
import { findLineScript, loadLineScript, refreshLineScript, narrationStatus } from "./narration.js";
import { scanFilms } from "./films.js";
import { makeFilmSession, readSavedJobs } from "./session.js";
import { makeJobs, jobsFile } from "./jobs.js";
import { notifyRules } from "./notify.js";
import { buildShotList } from "./shots.js";
import { scriptCameraIds, seedCameraLines, suggestLines, setCameraLines, suggestLooks, setLook, lastLook, startPortraits, approvePortrait, keepAnyway,
  clipSeconds, lineLengthS } from "./presenter.js";
import { estimateCredits } from "./tools/hfmedia.js";
import { makeCosts } from "./oncamcosts.js";
import { costPress, onCameraModel, OWN as OWN_PICK } from "./ui/oncamera.js";
import { startTake, approve, unapprove, choose, setTool, setPreferComfy, addBlender3d, addAnimated, removeVersion, jobGone, jobRemoved, removedText } from "./redo.js";
import { ensureProxy, toBlobUrl, openFull, revokeAll } from "./media.js";
import { makeHiggsfieldRunner } from "./tools/higgsfield.js";
import { makeBlenderRunner } from "./tools/blender.js";
import { makeComfyRunner, i2vReady } from "./tools/comfyui.js";
import { makeStableAudioStarter, makeStableAudioRunner } from "./tools/stableaudio.js";
import { makeComfyStarter } from "./tools/comfystart.js";
import { autostart, toolsLine } from "./autostart.js";
import { makeCredits } from "./credits.js";
import { savePresenterPhotos } from "./presenterphotos.js";
import { makeElevenRunner } from "./tools/elevenlabs.js";
import { planAudio, addCue, editItem, getEstimate, rewriteFromNote, startAudioTake, approveAudio, unapproveAudio, chooseAudio, proposeStarts } from "./audioplan.js";
import { makeVoiceJoinRunner } from "./tools/voicejoin.js";
import { makeStemFitRunner, listExports } from "./tools/stemfit.js";
import { makeMixdownRunner } from "./tools/mixdown.js";
import { startFit, startMix, useStemRemixerExport, approveMix, parseCsv, openFitInStemRemixer, stemExportDir, pastedPath, goodFrame } from "./mixplan.js";
import { mountProbe, saveRoot } from "./ui/probe.js";
import { approvePart2, part2InFlight, alreadyText } from "./part2run.js";
import { createFilm, currentDraft, part1Busy, writeScript, redoOne, editClip, editLists, restoreDraft, setPicks, approvePart1 } from "./part1run.js";
import { filmFolders, takenPrefixes, briefsIn, addBrief } from "./part1setup.js";
import { clipList } from "./part1script.js";
import * as newFilmView from "./ui/newfilm.js";
import { part1Model, listRows, listFromRows, LISTS } from "./ui/part1.js";
import * as filmsView from "./ui/films.js";
import * as jobsView from "./ui/jobs.js";
import * as reviewView from "./ui/review.js";
import { keepPlayer } from "./ui/mix.js";
import { followPlayer } from "./ui/pacing.js";
import { prompterBar } from "./ui/prompter.js";

const $ = (id) => document.getElementById(id);
const msg = (e) => String(e?.message ?? e);
const LAYOUT_KEY = "six-minutes-studio.reviewLayout";
// For everything made before (or kept across) a root change: always the current app.host.
const live = liveHost(() => app.host);

const app = {
  // rawHost: the host as made (this computer's name, its local record, the root search).
  // host: once the root is known, the same host re-basing project-folder paths saved on another computer.
  rawHost: null, host: null, computer: null, chosenRoot: null, chosenMissing: null,
  root: null, jobs: null, films: [], view: "films",
  film: null, store: null, session: null, playing: null, retried: new Set(), goneJobs: new Map(), movedAside: null, stateError: null, bootError: null, openError: null,
  review: { making: false, listError: null, cardErrors: new Map(), pending: new Set(), estimating: new Set(), noteFor: null, draft: "", oc: {} },
  starter: null, saBusy: false, peers: [], link: null,
  previews: new Map(),
  layout: (() => { try { return localStorage.getItem(LAYOUT_KEY) || "script"; } catch { return "script"; } })(),
};

function showView(name) {
  app.view = name;
  for (const s of document.querySelectorAll("main > section[data-view]")) s.hidden = s.dataset.view !== name;
  for (const b of document.querySelectorAll("#nav button")) b.setAttribute("aria-selected", String(b.dataset.view === name));
  if (name === "review") pollNarration();
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
      toolTip: `Six Minutes Studio \u2014 ${n} running${app.comfyStarter ? `\n${toolsLine({ comfy: app.comfyStarter, stableAudio: app.starter })}` : ""}${app.credits?.line() ? `\nCredits: ${app.credits.line()}` : ""}`,
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

const PAID = new Set(["higgsfield", "elevenlabs"]);
function paintCredits() {
  const el = $("credits"); if (!el || !app.credits) return;
  const line = app.credits.line();
  el.hidden = !line; el.textContent = line ?? ""; el.title = app.credits.title();
}
// The header's link line and Pause button: the line shows when linkLine has text, the button on a desktop with a laptop peer.
function paintLink() {
  const line = $("link"), btn = $("pause-laptop");
  if (!line || !btn) return;
  line.hidden = !app.link; line.textContent = app.link ?? "";
  btn.hidden = !(app.settings?.role === "desktop" && app.peers.some((p) => p.role === "laptop"));
  btn.textContent = app.settings?.laptopJobs === "paused" ? "Resume laptop jobs" : "Pause laptop jobs";
}
async function toggleLaptopJobs() {
  const btn = $("pause-laptop");
  const laptopJobs = app.settings.laptopJobs === "paused" ? "on" : "paused";
  try {
    await saveComputerSettings(app.rawHost, app.root, app.computer, { laptopJobs });
    app.settings.laptopJobs = laptopJobs; btn.title = "";
  } catch (e) { btn.title = msg(e); }
  render();
}
// Runs fn now and then every ms, never two at once; a failure is logged, never thrown out of the timer.
function every(ms, fn) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(e); } finally { busy = false; }
  };
  run();
  setInterval(run, ms);
}
// Presence (both roles) and, on a named desktop, the worker that takes laptop jobs. Not started while this computer's role is unknown.
async function startLink(host, raw) {
  const { root, computer, settings } = app;
  if (app.roleNeeded || computer === UNNAMED) return;
  const role = settings.role;
  let worker = null;
  if (role === "desktop") {
    worker = makeDesktopWorker({ host, root, computer, jobs: app.jobs, spellings: rootSpellings(raw), paused: () => app.settings.laptopJobs === "paused" });
    await worker.reconcile().catch((e) => console.error(e));
  } else {
    await tidyRequests(host, root, computer, app.jobs.list()).catch((e) => console.error(e));
  }
  const presence = makePresence(host, { root, computer, role, state: () => presenceState({
    role, jobs: app.jobs.list(), settings: app.settings, counts: worker?.counts(),
    tools: { comfyui: app.comfyStarter?.state() ?? null, stableaudio: app.starter?.state() ?? null } }) });
  $("pause-laptop").onclick = toggleLaptopJobs;
  every(BEAT_MS, async () => {
    await presence.beat();
    app.peers = await presence.read();
    app.link = linkLine({ role, peers: app.peers, serverError: presence.serverError, root });
    render();
  });
  if (worker) every(10_000, () => worker.tick());
}
function onJobsChanged(list) {
  if (!armed) { prevJobs = list; return; }
  const msgs = notifyRules(prevJobs, list);
  // A paid take finishing changes a balance: read it again (free).
  const was = new Map((prevJobs ?? []).map((j) => [j.id, j.status]));
  if (list.some((j) => PAID.has(j.tool) && (j.status === "done" || j.status === "failed") && was.get(j.id) !== j.status)) app.credits?.refresh();
  prevJobs = list;
  for (const m of msgs) { try { Promise.resolve(app.host.notify(m)).catch(() => {}); } catch { /* a no is final */ } }
  updateTray();
}

// ---- rendering ----
// Coalesce bursts (Blender reports every frame) into one render; skip views whose model has not changed.
let timer = null, rendering = false;
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
  // An audio prompt, length or cue box Jon is typing in keeps its caret across the re-render.
  const act = document.activeElement;
  const keep = act?.id?.startsWith("au-") || act?.id?.startsWith("pace-") || act?.id?.startsWith("oc-own-") || act?.id?.startsWith("nf-") || act?.id?.startsWith("p1-") ? { id: act.id, start: act.selectionStart ?? null, end: act.selectionEnd ?? null } : null;
  rendering = true;
  try { view.render(el, model, actions); } finally { rendering = false; }
  const ta = refocus ? $("note-box") : null;
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); app.review.focusNote = false; }
  const back = keep && !ta ? $(keep.id) : null;
  if (back && !back.disabled) {
    back.focus();
    try { if (keep.start !== null) back.setSelectionRange(keep.start, keep.end); } catch { /* number inputs have no selection */ }
  }
}

async function renderNow() {
  paintLink();
  const list = app.jobs ? app.jobs.list() : [];
  const count = jobsView.activeCount(list);
  const badge = $("jobcount");
  badge.textContent = count ? String(count) : "";
  badge.hidden = !count;
  $("keep-open").hidden = !list.some((j) => j.status === "queued" || j.status === "running");
  $("keep-text").textContent = jobsView.keepOpenText(armed);
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

  if (app.view === "films" && app.nf) {
    paint("films", $("view-films"), newFilmModelNow(), newFilmView, newFilmActions);
  } else if (app.view === "films") {
    paint("films", $("view-films"), filmsView.filmsModel({ root: app.root, films: app.films, jobs: list, error: app.bootError, chosenMissing: app.chosenMissing, roleNeeded: app.roleNeeded,
      tools: app.comfyStarter ? toolsLine({ comfy: app.comfyStarter, stableAudio: app.starter }) : null }), filmsView, filmsActions);
  } else if (app.view === "jobs") {
    const log = app.store ? await app.store.readLog(50) : null;
    const model = jobsView.jobsModel({ jobs: list, log, retried: app.retried, persistError: null, gone: goneJobs(list) });
    paint("jobs", $("view-jobs"), model, jobsView, jobsActions);
  } else if (app.view === "review") {
    const r = app.review;
    const model = reviewView.reviewModel({
      part1: part1Now(),
      film: app.film, state: app.store?.state, layout: app.layout, making: r.making, listError: r.listError,
      cardErrors: r.cardErrors, pending: r.pending, noteFor: r.noteFor, openError: app.openError, prefError: r.prefError ?? null, i2v: r.i2v ?? null, removeFor: r.removeFor ?? null, narration: r.narration ?? null, playing: app.playing, paused: !!app.paused,
      audio: app.store?.state?.audio ?? null,
      sa: app.starter ? { state: app.starter.state(), message: app.starter.message() } : null,
      audioUi: { estimating: r.estimating, planning: !!r.planning, planError: r.planError ?? null, adding: !!r.adding, addError: r.addError ?? null },
      mixUi: { settings: { stemRemixer: !!app.settings?.stemRemixerDir }, jobs: list, ui: { exports: r.exports ?? null, opened: r.opened ?? null, confirm: r.exportConfirm ?? null },
        pacing: { transcript: r.transcript ?? null, lineScript: r.lineScript ?? null, menu: r.paceMenu ?? null,
          chain: { applying: r.applying ?? null, placing: !!r.placing, error: r.paceError ?? null, info: r.paceInfo ?? null } } },
      lineScript: r.lineScript ?? null, transcript: r.transcript ?? null, transcriptAt: r.transcript ? r.transcriptAt ?? null : undefined,
      onCamera: { estimates: estimatesView(), photosOk: !!r.oc.photosOk, ui: r.oc },
      part2Ui: part2UiNow(),
      role: app.settings?.role ?? "desktop",
    });
    r.paceSource = model.mix?.pacing?.source ?? null;
    // No voiceover player in the review now (a rejoin is running, or the mix is current): stop the old one, unseen.
    if (!model.mix?.pacing?.player && players.review.el) dropPlayer("review");
    paint("review", $("view-review"), model, reviewView, reviewActions);
    attachFollow();
    // A ‖ just opened: its menu takes the focus (Escape closes it).
    if (r.focusMenu) { r.focusMenu = false; document.querySelector("#view-review .pmenu .pop")?.focus(); }
    proposeOnce();
    loadTranscript();
    loadOnCamera();
  }
}

// "Choose presenter photos…" (Probe and On camera): copy them under the root, list them in .studio-settings.json,
// then re-read the settings so every runner sees the new photos at once.
async function choosePresenterPhotos(files) {
  if (!app.root || !app.host) throw new Error("Studio can't see your films folder yet.");
  const paths = await savePresenterPhotos(app.host, app.root, files);
  await reloadSettings();
  return paths;
}

async function reloadSettings() {
  if (!app.root || !app.settings) return;
  const fresh = await loadSettings(app.host, app.root, { computer: app.computer });
  for (const k of Object.keys(app.settings)) if (!(k in fresh)) delete app.settings[k];
  Object.assign(app.settings, fresh);
  setToolPaths(app.settings);
  await refreshRoleNeeded();
}

// A new computer (no role, not the desktop on S:): Probe asks first and Films says to open Probe.
async function refreshRoleNeeded() {
  try { app.roleNeeded = !!app.root && roleNeeded(await readRawSettings(app.rawHost, app.root), await thisComputer(), app.root); }
  catch { app.roleNeeded = false; }
  return app.roleNeeded;
}

// Probe's This computer row and fix buttons. Every save is this computer's entry in the shared settings file,
// written through the host without re-basing; then the settings are re-read and Probe runs again.
const thisComputer = async () => app.computer ?? (app.computer = await computerName(app.rawHost));
const needRoot = () => { if (!app.root) throw new Error("Studio can't see your films folder yet."); };
const probeSetup = {
  computer: () => app.computer ?? "THIS-PC",
  rawHost: () => app.rawHost,
  chosenMissing: () => app.chosenMissing,
  roleNeeded: () => refreshRoleNeeded(),
  async save(patch) {
    needRoot();
    await saveComputerSettings(app.rawHost, app.root, await thisComputer(), patch);
    await reloadSettings();
  },
  // A new project folder: kept on this computer and recorded for the others, then films, settings and paths follow it.
  async chooseRoot(path) {
    let why = null;
    try { await saveRoot(app.rawHost, await thisComputer(), path); } catch (e) { why = e; }
    if (why?.where === "local") throw new Error(`Couldn't save the choice on this computer, so nothing changed: ${msg(why)}`);
    await loadRoot();
    await reloadSettings();
    render();
    if (why) throw new Error(`Studio is using ${path} on this computer, but couldn't record it in .studio-settings.json for the other computers: ${msg(why)}`);
  },
  async install(opts) {
    needRoot();
    await installApp(app.rawHost, { ...opts, root: app.root, computer: await thisComputer() });
    await reloadSettings();
  },
};

// ---- films ----
async function loadRoot() {
  // This computer, its chosen project folder (if any), then the host that re-bases paths onto it.
  const found = await findRoot(app.rawHost, { computer: app.computer ?? undefined });
  app.computer = found.computer;
  app.chosenRoot = found.chosenRoot;
  app.chosenMissing = found.chosenMissing;
  app.root = found.root;
  if (!app.root) { app.host = app.rawHost; app.films = []; app.roleNeeded = false; render(); return; }
  // A computer on another folder (the laptop on N:) records it, so the others can re-base paths saved here.
  // The desktop on S: never writes at boot. A failed write never stops Studio opening.
  const raw = await readRawSettings(app.rawHost, app.root);
  if (rootToRecord(raw, app.computer, app.root)) {
    try { await saveComputerSettings(app.rawHost, app.root, app.computer, { root: app.root }); }
    catch (e) { console.error(e); }
  }
  await refreshRoleNeeded();
  app.host = await rebasedHost(app.rawHost, app.root);
  const host = live;
  if (!app.jobs) {
    const settings = await loadSettings(app.host, app.root, { computer: app.computer });
    setToolPaths(settings);
    app.settings = settings;
    // The desktop's job list is .studio-jobs.json; a laptop (or a computer not set up yet) keeps its own.
    const file = jobsFile(app.root, { role: settings.role, computer: app.computer, roleNeeded: app.roleNeeded });
    // One Stable Audio starter for the app: the runner starts it when a take needs it, Review shows its state.
    const starter = makeStableAudioStarter({ settings, sleep: (ms) => new Promise((res) => setTimeout(res, ms)) });
    app.starter = starter;
    starter.onChange(() => { render(); updateTray(); });
    // ComfyUI Desktop, started with Stable Audio when Studio opens (settings "autostart"); closed on exit if Studio started it.
    app.comfyStarter = makeComfyStarter({ settings, sleep: (ms) => new Promise((res) => setTimeout(res, ms)) });
    app.comfyStarter.onChange(() => { render(); updateTray(); });
    // Load ComfyUI and Stable Audio now, so a job never waits on them (states show on Films and in the tray).
    autostart(host, settings, { comfy: app.comfyStarter, stableAudio: starter }).catch(() => {});
    // A free check every 30 s keeps the line true when Jon opens or closes either tool himself.
    setInterval(() => { for (const s of [app.comfyStarter, app.starter]) Promise.resolve(s?.refresh(host)).catch(() => {}); }, 30_000);
    // A laptop sends the graphics tools it doesn't run itself to the desktop through one shared runner.
    const toDesktop = settings.role === "laptop" ? makeDesktopRunner({ root: app.root, computer: app.computer, spellings: rootSpellings(raw), peers: () => app.peers }) : null;
    const desktopRunners = Object.fromEntries([...DESKTOP_TOOLS].filter((t) => sendsToDesktop(settings, t)).map((t) => [t, toDesktop]));
    app.jobs = makeJobs(host, {
      runners: {
        higgsfield: makeHiggsfieldRunner({ settings }),
        blender: makeBlenderRunner({ settings }),
        comfyui: makeComfyRunner({ settings }),
        stableaudio: makeStableAudioRunner({ settings, starter }),
        elevenlabs: makeElevenRunner({}),
        voicejoin: makeVoiceJoinRunner({ settings }),
        stemfit: makeStemFitRunner({ settings }),
        mixdown: makeMixdownRunner(),
        ...desktopRunners,
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
    await startLink(host, raw);
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
  // A film still on Part 1 opens the same review, which shows the Part 1 step.
  openScript: (dir) => { openReview(dir); },
  newFilm: () => { openNewFilm(); },
};

function resetReview() {
  app.review?.bar?.attach(null);
  stopTake();
  unfollow();
  for (const slot of Object.keys(players)) dropPlayer(slot);
  app.previews.clear();
  revokeAll();
  app.review = { making: false, listError: null, cardErrors: new Map(), pending: new Set(), estimating: new Set(), noteFor: null, draft: "", oc: {} };
  fields.clear();
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
  costs.reset(); // costs are asked again each time a review opens
  if (app.store !== store) {
    resetReview();
    app.film = film;
    app.store = store;
  }
  showView("review");
  refreshI2v();
  // One free check so the Stable Audio chip is right when Small SFX is already running or was stopped by hand.
  if (app.starter) Promise.resolve(app.starter.refresh(app.host)).catch(() => {}).then(() => render());
}

// Animate with ComfyUI needs the image-to-video workflow set up: checked when a review opens and after Probe.
async function refreshI2v() {
  const r = app.review;
  if (!r || !app.host) return;
  let v;
  try { v = await i2vReady(app.host, app.settings?.comfy ?? {}); } catch (e) { v = { ok: false, why: msg(e) }; }
  if (app.review === r) { r.i2v = v; render(); }
}

// ---- live jobs ----
// Jobs whose shot was removed from the review (open film from its state; others once a click was refused).
function goneJobs(list) {
  const m = new Map(app.goneJobs);
  const st = app.store;
  if (st) for (const j of list) if (filmKey(j.film) === filmKey(st.dir) && jobGone(st.state, j)) m.set(j.id, removedText(j.assetId));
  return m;
}

// Retry or Check on a removed shot would run the whole job and throw the result away: refuse it.
async function refusedAsGone(id) {
  const job = app.jobs?.list().find((j) => j.id === id);
  if (!job) return false;
  let why = null;
  try { why = await jobRemoved(app.host, job, app.store); } catch (e) { console.error(e); }
  if (!why) return false;
  app.goneJobs.set(id, why);
  render();
  return true;
}

const jobsActions = {
  async retry(id) {
    if (app.retried.has(id)) return;
    // An ElevenLabs re-run is paid: new takes start only from the card, where the cost is shown.
    if (app.jobs?.list().find((j) => j.id === id)?.tool === "elevenlabs") return;
    app.retried.add(id);
    if (await refusedAsGone(id)) return;
    userStarted();
    try { app.jobs.retry(id); } catch (e) { console.error(e); }
    render();
  },
  // Free: polls the existing job by its id, never generates.
  async check(id) {
    if (await refusedAsGone(id)) return;
    userStarted();
    try { app.jobs.check(id); } catch (e) { console.error(e); }
    render();
  },
};

// ---- narration (reads only; refreshed every 10 s while Review is open; the line script is re-read when it changes) ----
async function refreshNarration() {
  const film = app.film, r = app.review;
  if (app.view !== "review" || !film || !app.store || app.host?.fs?.stat === undefined) return;
  try {
    if (r.lineScript) r.lineScript = await refreshLineScript(app.host, r.lineScript); // one stat; re-read if edited
    if (!r.lineScript) {
      const handover = await readText(join(film.dir, "handover", "part1_handover.md"));
      const path = await findLineScript(app.host, film.dir, handover ?? "", app.settings ?? {});
      if (!path) { if (app.review === r) r.narration = { missingScript: true }; return; }
      r.lineScript = await loadLineScript(app.host, path);
    }
    const st = await narrationStatus(app.host, app.settings ?? {}, r.lineScript, app.store?.state?.narrationOk ?? {});
    const stale = rerecordsToClear(st, app.store.state.mix?.pacing);
    if (stale.length) await app.store.update((d) => { for (const id of stale) { const l = d.mix?.pacing?.lines?.[id]; if (l) l.rerecord = null; } });
    if (app.review === r) r.narration = withRerecord(st, app.store.state.mix?.pacing);
  } catch (e) { console.error(e); }
}
let narrTimer = null;
function pollNarration() {
  if (narrTimer) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const before = JSON.stringify(app.review?.narration ?? null);
      await refreshNarration();
      if (JSON.stringify(app.review?.narration ?? null) !== before) render();
    } finally { busy = false; }
  };
  tick();
  narrTimer = setInterval(() => { if (app.view === "review") tick(); }, 10_000);
}

// ---- listening: one sound at a time. A take's ▶ plays, pauses and carries on from the same place;
// pressing another take (or a player below) pauses this one and forgets where it was. ----
let player = null;
function stopTake() {
  if (player) { player.pause(); player.onended = player.onerror = null; player = null; }
  app.playing = null;
  app.paused = false;
}
function pausePlayers(except = null) {
  for (const p of Object.values(players)) if (p.el && p.el !== except) { try { p.el.pause(); } catch { /* not loaded */ } }
}
async function playTake(file) {
  if (app.playing === file && player) {
    if (app.paused) {
      pausePlayers();
      app.paused = false;
      player.play().catch((e) => { console.error(e); stopTake(); render(); });
    } else {
      player.pause();
      app.paused = true;
    }
    render();
    return;
  }
  if (app.playing === file) return;              // still loading: the press counts once
  stopTake();
  pausePlayers();
  app.playing = file;
  render();
  try {
    const url = await toBlobUrl(app.host, file); // cached until the take changes
    if (app.playing !== file) return;            // another press came first
    player = new Audio(url);
    player.onended = () => { if (app.playing === file) { stopTake(); render(); } };
    player.onerror = player.onended;
    await player.play();
  } catch (e) {
    console.error(e);
    if (app.playing === file) { stopTake(); render(); }
  }
}

// ---- the voiceover, fitted score and mix players: <audio> with pause and a scrubber, one per slot,
// kept across re-renders so they keep playing and keep their place ----
const players = { voice: { key: null, el: null }, fit: { key: null, el: null }, mix: { key: null, el: null }, review: { key: null, el: null } };
const mixPlayer = players.mix;
function dropPlayer(slot) {
  const p = players[slot];
  if (p.el) { try { p.el.pause(); } catch { /* gone */ } p.el.removeAttribute("src"); }
  p.key = null; p.el = null;
}
function dropMixPlayer() { dropPlayer("mix"); }
// key = the file and its run's time: a new join, fit or mix writes the same path, so a new run gets a new player.
function audioEl(slot, file, key, label) {
  const p = players[slot];
  if (keepPlayer(p, key)) return p.el;
  dropPlayer(slot);
  const el = document.createElement("audio");
  el.controls = true;
  el.preload = "metadata";
  el.className = "maudio";
  el.setAttribute("aria-label", `Player for ${label ?? ""}`.trim());
  // Starting one stops a take that is playing and pauses the other players.
  el.addEventListener("play", () => {
    pausePlayers(el);
    if (app.playing) { stopTake(); render(); }
  });
  p.key = key; p.el = el;
  toBlobUrl(app.host, file).then((url) => { if (p.el === el) el.src = url; }, (e) => console.error(e));
  return el;
}
function mixAudioEl(file, key, label) { return audioEl("mix", file, key, `Mix preview ${label ?? ""}`.trim()); }
function seekMix(t) {
  const el = mixPlayer.el;
  if (!el) return;
  try { el.currentTime = Math.max(0, Number(t) || 0); } catch { /* not loaded yet */ }
  el.play().catch(() => {});
}

// ---- pacing review: the line being spoken follows the mix player (or the voiceover's, when the mix is older) ----
let follow = { el: null, list: null, off: null };
function unfollow() { follow.off?.(); follow = { el: null, list: null, off: null }; }
const reviewEl = () => (app.review.paceSource === "mix" ? players.mix.el : players.review.el);
// After a render: the list is new whenever the review was painted again; the player only on a new run.
function attachFollow() {
  const list = document.querySelector("#view-review ul.pace");
  const el = app.view === "review" ? reviewEl() : null;
  app.review.bar?.attach(el ?? null);
  if (!list || !el) { unfollow(); return; }
  if (follow.el === el && follow.list === list) return;
  unfollow();
  follow = { el, list, off: followPlayer(el, list) };
}
function seekReview(t) {
  const el = reviewEl();
  if (!el || t == null) return;
  try { el.currentTime = Math.max(0, Number(t) || 0); } catch { /* not loaded yet */ }
  el.play().catch(() => {});
}

// The last good join's transcript (lines and words; mixplan.goodFrame), read once per join. While a join runs,
// or after one failed, it is the one before it, so the marks Jon places sit where the next join reads them from.
function loadTranscript() {
  const r = app.review;
  const f = goodFrame(app.store?.state?.mix?.voiceover);
  if (!f?.transcript || !app.host) return Promise.resolve(f ? r.transcript ?? null : null);
  if (r.transcriptFor?.at === f.at && r.transcriptFor?.path === f.transcript) return r.transcriptFor.p;
  const p = app.host.fs.read(f.transcript, "utf8").then((t) => JSON.parse(t)).catch((e) => { console.error(e); return null; })
    .then((t) => { if (app.review === r && r.transcriptFor?.p === p) { r.transcript = t; r.transcriptAt = f.at; render(); } return t; });
  r.transcriptFor = { at: f.at, path: f.transcript, p };
  return p;
}

const takeSigsNow = () => Object.fromEntries((app.review.narration?.rows ?? []).map((x) => [x.id, takeSig(x)]).filter(([, v]) => v != null));
const takeOf = (id) => takeSig((app.review.narration?.rows ?? []).find((x) => x.id === id)) ?? null;
const wordsOf = (id) => lineWords(app.review.transcript, id);
// A take saved after the last good join: its words in the transcript are the old take's (no word marks until it is joined).
const newTake = (id) => newTakeIds(app.review.narration, goodFrame(app.store?.state?.mix?.voiceover)).has(id);

// One line's marks and note, changed through the store (saved in the film's state.json).
async function editLine(id, fn) {
  const r = app.review;
  try {
    await app.store.update((d) => {
      d.mix ??= {};
      d.mix.pacing ??= { lines: {} };
      d.mix.pacing.lines ??= {};
      d.mix.pacing.lines[id] = fn(d.mix.pacing.lines[id] ?? {});
    });
    return true;
  } catch (e) {
    if (app.review === r) r.paceError = `Couldn't save: ${msg(e)}`;
    return false;
  } finally { render(); }
}

// A mark Jon changes is his from then on, so Claude's next placing leaves it alone.
const jonOwns = (line, keys) => ({ ...line, pauses: (line.pauses ?? []).map((p) => (keys.has(p.key) ? { ...p, by: "jon" } : p)) });

async function editMark(id, key, op) {
  const r = app.review;
  const words = wordsOf(id);
  let next = key;
  await editLine(id, (l) => {
    if (op === "remove") { next = null; return removeMark(l, key); }
    if (op === "left" || op === "right") {
      const before = new Set((l.pauses ?? []).filter((p) => p.key !== key).map((p) => p.key));
      const moved = moveMark(l, key, op === "left" ? -1 : 1, words);
      if (moved === l) return l;
      next = (moved.pauses ?? []).map((p) => p.key).find((k) => !before.has(k)) ?? null;
      return next ? jonOwns(moved, new Set([next])) : moved;
    }
    return jonOwns(setSize(l, key, op), new Set([key]));
  });
  if (app.review === r) { r.paceMenu = next ? { id, key: next } : null; render(); }
}

async function placePauses() {
  const r = app.review;
  if (r.placing || r.applying || !app.store) return;
  r.placing = true; r.paceError = null; r.paceInfo = null; render();
  try {
    const transcript = await loadTranscript();
    await placeFromNotes(app.host, app.store, { transcript, lineScript: r.lineScript ?? null, takeSigs: takeSigsNow() });
  } catch (e) {
    if (app.review === r) r.paceError = msg(e);
  } finally {
    r.placing = false;
    render();
  }
}

// Join with the marks, then fit and mix again (pacingchain). Notes and marks can still be edited meanwhile.
async function runApplyPauses() {
  const r = app.review;
  if (r.applying || r.placing || !app.store) return;
  userStarted();
  r.applying = { step: null }; r.paceError = null; r.paceInfo = null; r.paceMenu = null; render();
  try {
    const fit = app.store.state.mix?.fit;
    const res = await applyPauses(mixCtx(), { onStep: (step) => { if (r.applying) { r.applying = { step }; render(); } } });
    if (app.review === r && res?.stoppedAt === "FIT" && fit?.status === "done" && fit.source === "stemremixer") {
      r.paceInfo = "Joined with the pauses. The score fit is your Stem Remixer export, so it was left as it is.";
    }
  } catch (e) {
    if (app.review === r) r.paceError = msg(e);
  } finally {
    r.applying = null;
    render();
  }
}

// Once a voiceover is joined (and when Review opens on a film that has one), Claude's start times for the
// sound effects come from its timings. proposeStarts never overwrites a time Jon set.
async function proposeOnce() {
  const r = app.review, store = app.store;
  const vo = store?.state?.mix?.voiceover;
  if (!vo || vo.status !== "done" || !vo.csv || r.proposedAt === vo.at) return;
  r.proposedAt = vo.at;
  try {
    const rows = parseCsv(await app.host.fs.read(vo.csv, "utf8"));
    if (app.store === store && app.review === r) await proposeStarts(store, rows, r.lineScript ?? null);
  } catch (e) { console.error(e); }
}

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
    // The to-camera lines come from the line script: read it now if Narration hasn't yet, so no b-roll is planned on them.
    if (!r.lineScript && !app.store.state.presenter?.lines?.length) await refreshNarration();
    if (app.review !== r) return;
    if (!r.lineScript && !r.narration?.missingScript && !app.store.state.presenter?.lines?.length) {
      throw new Error("The line script is still loading. Try again in a moment.");
    }
    await buildShotList(app.host, app.store, { scriptText, handoverText, cameraLines: cameraLinesNow() });
  } catch (e) {
    r.listError = msg(e);
  } finally {
    r.making = false;
    render();
  }
}

// The to-camera lines the shot plan leaves alone: the chosen ones once there are any, else the script's marks.
function cameraLinesNow() {
  const ls = app.review.lineScript;
  const chosen = app.store?.state?.presenter?.lines;
  const ids = chosen !== undefined ? chosen.map((l) => l.id) : scriptCameraIds(ls); // Jon's choice, even none, wins
  return ids.map((id) => ({ id, text: ls?.lines?.find((l) => l.id === id)?.text ?? app.store.state.assets.find((a) => a.kind === "presenter" && a.lineId === id)?.line ?? "" }))
    .filter((l) => l.text);
}

// ---- On camera ----
// Higgsfield's costs for the open review (oncamcosts); reset whenever a review opens.
const costs = makeCosts((tool, input) => estimateCredits(app.host, tool, input));
const estimatesView = () => costs.view();
function askEstimates() {
  if (!app.store || !app.host?.mcp) return;
  // A new cost replaces any "Press again" waiting on the old one.
  costs.ask({ state: app.store.state, transcript: app.review.transcript ?? null }, () => { app.review.oc.confirm = null; render(); });
}
const forgetClipEstimates = () => costs.forgetClips();

// Once per review: whether the presenter photos are there, and the last film's look (both free reads).
function loadOnCamera() {
  const r = app.review;
  // Script marks become the chosen lines the first time (free); once per review, never over Jon's choice.
  if (r.lineScript && app.store && app.store.state.presenter?.lines === undefined && !r.seeding) {
    r.seeding = true;
    seedCameraLines(ctx()).catch((e) => { console.error(e); r.oc.lineError = msg(e); }).finally(() => render());
  }
  askEstimates();
  if (r.ocLoaded || !app.store || !app.host || !(r.lineScript || app.store.state.presenter?.lines?.length)) return;
  r.ocLoaded = true;
  (async () => {
    const photos = (app.settings?.presenter?.photos ?? []).filter((p) => typeof p === "string" && p.trim());
    let ok = photos.length > 0;
    for (const p of photos) { try { if (!(await app.host.fs.exists(p))) ok = false; } catch { ok = false; } }
    let last = null;
    try { last = app.root ? await lastLook(app.host, app.root, app.film.dir) : null; } catch (e) { console.error(e); }
    if (app.review === r) { r.oc.photosOk = ok; r.oc.lastLook = last; render(); }
  })();
}

// A step-level On camera action: one at a time per flag, errors shown under it.
function ocAction(flag, errKey, fn) {
  return async (...a) => {
    const r = app.review, oc = r.oc;
    if (oc[flag]) return;
    oc[flag] = true; oc[errKey] = null; render();
    try { await fn(oc, ...a); } catch (e) { if (app.review === r) oc[errKey] = msg(e); }
    finally { oc[flag] = false; render(); }
  };
}

// A paid press: goes when the cost is known; with "(cost unknown)" the first press asks for a second one.
function paid(key, est) {
  const oc = app.review.oc;
  const p = costPress(est, oc.confirm ?? null, key);
  oc.confirm = p.confirm;
  if (!p.go) render();
  return p.go;
}
const clipEstimate = (id) => {
  const a = app.store?.state?.assets.find((x) => x.id === id);
  if (a?.kind !== "presenter") return 0;
  const len = lineLengthS(app.review.transcript, a.lineId);
  return len == null ? undefined : estimatesView().clips[clipSeconds(len)];
};

const startPortraitsNow = ocAction("portraitPending", "portraitError", async () => {
  userStarted();
  await startPortraits(ctx());
});

const onCameraActions = {
  toggleLine: ocAction("linesBusy", "lineError", async (oc, id, on, from) => {
    const ids = (app.store.state.presenter?.lines ?? []).map((l) => l.id);
    const next = on ? [...ids, id] : ids.filter((x) => x !== id);
    await setCameraLines(ctx(), next, on && from ? { from } : {});
  }),
  addLine: (id) => onCameraActions.toggleLine(id, true),
  suggestLines: ocAction("suggesting", "lineError", async (oc) => {
    userStarted();
    oc.suggestions = await suggestLines(app.host, app.review.lineScript);
  }),
  suggestLooks: ocAction("suggestingLooks", "lookError", async (oc) => {
    userStarted();
    const dir = app.film.dir;
    const handoverText = await readText(join(dir, "handover", "part1_handover.md"));
    const scriptText = await findScript(dir, handoverText ?? "");
    oc.looks = await suggestLooks(app.host, { scriptText: scriptText ?? "", lastLook: oc.lastLook ?? null });
  }),
  pickLook(kind, value) { const oc = app.review.oc; oc.lookPick = { ...(oc.lookPick ?? {}), [kind]: value }; render(); },
  setOwnLook(kind, text) {
    const oc = app.review.oc;
    oc.own = { ...(oc.own ?? {}), [kind]: text };
    oc.lookPick = { ...(oc.lookPick ?? {}), [kind]: OWN_PICK };
    render();
  },
  saveLook: ocAction("lookSaving", "lookError", async (oc) => {
    await setLook(ctx(), onCameraModel({ state: app.store.state, lineScript: app.review.lineScript ?? null, ui: oc }).look.chosen);
    oc.lookPick = null; oc.own = {};
  }),
  choosePhotos: ocAction("photosSaving", "photosError", async (oc, files) => { await choosePresenterPhotos(files); oc.photosOk = true; }),
  // The cost check comes first, so an unknown-cost first press shows "Press again…" without a "Making…" flash.
  makePortraits: (...a) => (app.review.oc.portraitPending || !paid("PORTRAIT", estimatesView().portrait) ? undefined : startPortraitsNow(...a)),
  approvePortrait: ocAction("approving", "portraitError", async (oc, n) => {
    await approvePortrait(ctx(), n);
    forgetClipEstimates();
  }),
  keepAnyway: cardAction((id) => keepAnyway(ctx(), id)),
};

// ---- music and sound effects ----
async function planMusic() {
  const r = app.review;
  if (r.planning) return;
  userStarted();
  r.planning = true; r.planError = null; render();
  try {
    const dir = app.film.dir;
    const handoverText = await readText(join(dir, "handover", "part1_handover.md"));
    if (handoverText === null) throw new Error("Couldn't read handover\\part1_handover.md.");
    const scriptText = await findScript(dir, handoverText);
    if (scriptText === null) throw new Error("Couldn't find the script. Add its path to part1_handover.md.");
    await planAudio(app.host, app.store, { scriptText, handoverText });
  } catch (e) {
    if (app.review === r) r.planError = msg(e);
  } finally {
    r.planning = false;
    render();
  }
}

async function addAudioCue({ cue, durationS } = {}) {
  const r = app.review;
  if (r.adding) return;
  r.adding = true; r.addError = null; render();
  try {
    await addCue(app.store, { cue, prompt: "", durationS });
    fields.delete("au-new-cue"); fields.delete("au-new-len");
  } catch (e) {
    if (app.review === r) r.addError = msg(e);
  } finally {
    r.adding = false;
    render();
  }
}

// Ignored while starting; a failure shows in the Sound effects header through starter.message().
async function startStableAudio() {
  if (!app.starter || app.saBusy || app.starter.state() === "starting") return;
  app.saBusy = true;
  try { await app.starter.ensure(app.host); } catch (e) { console.error(e); }
  finally { app.saBusy = false; render(); }
}

// "Getting the cost…" shows only while getEstimate runs for that card.
async function estimateFor(id) {
  const r = app.review;
  r.estimating.add(id); render();
  try { return await getEstimate(ctx(), id); }
  finally { r.estimating.delete(id); render(); }
}

// Typed but not yet saved text in the audio boxes, kept across re-renders.
const fields = new Map();

function cardAction(fn) {
  return async (id, ...args) => {
    const r = app.review;
    if (r.pending.has(id)) return false;
    r.pending.add(id); r.cardErrors.delete(id); render();
    // Resolves true once fn succeeded, false when it failed (or was ignored above as already pending).
    try { await fn(id, ...args); return true; } catch (e) { r.cardErrors.set(id, msg(e)); return false; }
    finally { r.pending.delete(id); render(); }
  };
}
// lineScript and transcript (the last good join's): to-camera lines and clip takes need them.
// transcriptAt: the join the loaded transcript came from; a clip take needs it to be the current join.
const ctx = () => ({ host: app.host, store: app.store, jobs: app.jobs, settings: app.settings ?? {}, lineScript: app.review.lineScript ?? null,
  transcript: app.review.transcript ?? null, transcriptAt: app.review.transcript ? app.review.transcriptAt ?? null : undefined });
// narration: the mix steps refuse to run from a join that misses a take saved since (joinStale).
const mixCtx = () => ({ ...ctx(), lineScript: app.review.lineScript ?? null, settings: app.settings ?? {}, narration: app.review.narration ?? null });
// A Voiceover and mix step's action, guarded like a card (VOICEOVER, FIT or MIX).
// While Apply pauses runs its chain, no step starts by hand (the buttons are held too).
const stepAction = (id, fn) => { const run = cardAction((_, ...a) => fn(...a)); return (...a) => (app.review?.applying ? false : run(id, ...a)); };

async function findExports() {
  const r = app.review;
  const fit = app.store?.state?.mix?.fit;
  r.exports = { loading: true, files: [] }; render();
  try {
    const files = await listExports(app.host, app.settings ?? {}, fit?.at ?? 0, { exportDir: exportDirOf(app.store) });
    const when = (ms) => { try { return new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); } catch { return ""; } };
    const ed = exportDirOf(app.store).toLowerCase();
    const where = (p) => (p.toLowerCase().startsWith(ed + "\\") ? "film folder" : "Stem Remixer folder");
    if (app.review === r) r.exports = { files: files.map((f) => ({ ...f, whenText: when(f.when), whereText: where(f.path) })), pick: files[0]?.path ?? null };
  } catch (e) {
    if (app.review === r) r.exports = { files: [], error: msg(e) };
  }
  render();
}

const exportDirOf = stemExportDir;

// The fit's plan goes in only on the first open after an app fit (openFitInStemRemixer), so Jon's tweaks stay.
async function openStemRemixer() {
  const r = app.review;
  r.opened = "Opening Stem Remixer…"; r.cardErrors.delete("FIT"); render();
  try {
    const text = await openFitInStemRemixer(mixCtx());
    if (app.review === r) r.opened = text;
  } catch (e) {
    if (app.review === r) { r.opened = null; r.cardErrors.set("FIT", msg(e)); }
  }
  render();
}

function preview(file) {
  if (!app.previews.has(file)) {
    // ensureProxy returns images as they are and a 640px proxy for video: a full-size video is never read into memory.
    app.previews.set(file, ensureProxy(app.host, file).then((p) => toBlobUrl(app.host, p)));
  }
  return app.previews.get(file);
}

// ---- Approve Part 2 ----
// The press's state for the open film. A run still going (started before Review was reopened, or for another
// film: the library is shared) holds the button: "Approving…" for this film, the reason for another.
function part2UiNow() {
  const r = app.review, p2 = r.p2 ?? {};
  const f = part2InFlight();
  if (!f || p2.running) return p2;
  if (app.film && filmKey(f.dir) === filmKey(app.film.dir)) return { ...p2, running: true };
  return { ...p2, elsewhere: alreadyText(f.dir) };
}

// Free: copies into the B-roll library and writes the handover. Each step shows as it happens; one press at a time.
async function approvePart2Now() {
  const r = app.review, store = app.store;
  if (!store || r.p2?.running || part2InFlight()) return;
  r.p2 = { running: true, steps: [], error: null, warnings: [] };
  render();
  try {
    const res = await approvePart2({ ...ctx(), root: app.root }, { onStep: (s) => { if (app.review === r) { r.p2.steps.push(s.text); render(); } } });
    if (app.review === r) r.p2.warnings = res.warnings ?? [];
  } catch (e) {
    if (app.review === r) r.p2.error = msg(e);
  } finally {
    if (app.review === r) r.p2.running = false;
    render();
  }
}

// Copy the Part 3 opening message; if the clipboard refuses, select it so Ctrl+C works.
async function copyMessage(text, box) {
  const r = app.review;
  try {
    await navigator.clipboard.writeText(text);
    if (app.review !== r) return;
    r.p2 = { ...(r.p2 ?? {}), copied: true };
    render();
    clearTimeout(r.copiedTimer);
    r.copiedTimer = setTimeout(() => { if (app.review === r && r.p2) { r.p2.copied = false; render(); } }, 2000);
  } catch {
    try { box?.focus(); box?.select(); } catch { /* nothing more to do */ }
  }
}

// ---- New film (Films page) ----
// app.nf: the open form ({ form, folders, briefs, taken, pending, error, busy }), or null.
function newFilmModelNow() {
  const nf = app.nf;
  return newFilmView.newFilmModel({ folders: nf.folders, briefs: nf.briefs, form: nf.form, taken: nf.taken, films: app.films,
    error: nf.error, busy: nf.busy, recordings: app.settings?.autocueRecordings ?? null, pending: nf.pending });
}

async function openNewFilm() {
  if (!app.root || !app.host) return;
  const nf = { form: {}, folders: null, briefs: [], taken: [], pending: null, error: null, busy: false };
  app.nf = nf;
  render();
  try {
    const [folders, taken] = await Promise.all([filmFolders(app.host, app.root), takenPrefixes(app.host, app.root, app.settings ?? {})]);
    if (app.nf !== nf) return;
    nf.folders = folders; nf.taken = taken;
    await loadBriefs(nf);
  } catch (e) { if (app.nf === nf) { nf.folders ??= []; nf.error = msg(e); } }
  render();
}

// Drops the result if the form closed or the folder changed while the briefs were read.
async function loadBriefs(nf) {
  const m = newFilmModelNow();
  const folder = nf.form.folder;
  const briefs = m.isNew ? [] : await briefsIn(app.host, m.folder);
  if (app.nf !== nf || nf.form.folder !== folder) return;
  nf.briefs = briefs;
  render();
}

const newFilmActions = {
  setField(k, v) { if (!app.nf) return; app.nf.form[k] = v; app.nf.error = null; render(); },
  setFolder(v) {
    const nf = app.nf; if (!nf) return;
    nf.form.folder = v; nf.form.brief = undefined; nf.error = null;
    loadBriefs(nf).catch((e) => { nf.error = msg(e); render(); });
  },
  // A picked brief is copied into the chosen folder (never overwriting); for a new folder it waits for Create.
  async addBrief(file) {
    const nf = app.nf; if (!nf) return;
    nf.error = newFilmView.briefPickProblem(file.name);
    if (nf.error) { render(); return; }
    const m = newFilmModelNow();
    if (m.isNew) { nf.pending = file; nf.form.brief = undefined; render(); return; }
    try {
      const path = await addBrief(app.host, m.folder, file);
      await loadBriefs(nf);
      nf.form.brief = path;
    } catch (e) { nf.error = msg(e); }
    render();
  },
  cancel() { app.nf = null; render(); },
  async create() {
    const nf = app.nf; if (!nf || nf.busy) return;
    const m = newFilmModelNow();
    if (!m.canCreate) return;
    const input = newFilmView.createInput(m);
    const pending = m.isNew ? nf.pending : null;
    if (pending) input.brief = join(app.root, input.newFolder, pending.name);
    nf.busy = true; nf.error = null; render();
    let dir;
    try { dir = await createFilm(app.host, app.root, input, { taken: nf.taken, briefPending: !!pending }); }
    catch (e) { nf.busy = false; nf.error = msg(e); render(); return; }
    let briefError = null;
    if (pending) { try { await addBrief(app.host, dir, pending); } catch (e) { briefError = `Couldn't copy the brief into the folder: ${msg(e)}`; } }
    try {
      app.films = await scanFilms(app.host, app.root);
      app.nf = null;
      await openReview(dir);
      if (briefError && app.film?.dir === dir) { p1ui().error = briefError; render(); }
    } catch (e) {
      // The film is made; show what went wrong in the form if it is still open.
      if (app.nf === nf) nf.error = msg(e);
    } finally {
      nf.busy = false;
      render();
    }
  },
};

// ---- Part 1 step (Review) ----
// app.review.p1: what is open in the step and its last error. Errors clear on the next action.
const p1ui = () => (app.review.p1 ??= { error: null, running: false, writing: false });
const p1ctx = () => ({ host: app.host, store: app.store, settings: app.settings ?? {}, root: app.root });

// Shown while the film has no Part 1 handover, and (once approved here) above the Part 2 sections.
function part1Now() {
  const state = app.store?.state;
  if (!state?.part1 || !app.film) return null;
  const u = p1ui();
  if (app.film.parts?.[1] === "done" && !u.justApproved) return null;
  return part1Model({ state, settings: app.settings ?? {}, busy: u.running || part1Busy(app.store.dir), error: u.error, ui: u });
}

// One Part 1 change at a time; a failure shows in the step. writing: a Claude call (shows "Writing…").
async function p1Run(fn, { writing = false } = {}) {
  const r = app.review, u = p1ui(), store = app.store;
  if (u.running || !store) return false;
  u.error = null; u.running = true; u.writing = writing;
  render();
  try { await fn(p1ctx()); return true; }
  catch (e) { if (app.review === r) u.error = msg(e); return false; }
  finally { u.running = false; u.writing = false; if (app.review === r) render(); }
}

const p1script = () => currentDraft(app.store?.state)?.script ?? null;
const p1pickIds = () => (app.store?.state?.part1?.picks ?? []).map((x) => x.id);
// Every action clears the last error; typing only updates what is held (no re-render needed).
const p1 = (fn, redraw = true) => (...a) => { const u = p1ui(); u.error = null; const out = fn(u, ...a); if (redraw) render(); return out; };

async function approvePart1Now() {
  const u = p1ui(), r = app.review, dir = app.film?.dir;
  u.approving = true;
  const ok = await p1Run(async (c) => { const res = await approvePart1(c); u.openItems = res.openItems; u.justApproved = true; });
  u.approving = false;
  if (!ok || app.review !== r) { render(); return; }
  // The handover is written: Films and the review move on to Part 2.
  app.films = await scanFilms(app.host, app.root);
  app.film = app.films.find((f) => f.dir === dir) ?? app.film;
  r.lineScript = null; r.narration = null;
  refreshNarration().finally(() => render());
}

const part1Actions = {
  write: p1(() => { p1Run((c) => writeScript(c), { writing: true }); }),
  openRevise: p1((u) => { u.revise = { note: "" }; }),
  reviseNote: p1((u, v) => { if (u.revise) u.revise.note = v; }),
  closeRevise: p1((u) => { u.revise = null; }),
  revise: p1((u, note) => {
    if (!String(note ?? "").trim()) return;
    p1Run((c) => writeScript(c, { note: note.trim() }), { writing: true }).then((ok) => { if (ok) u.revise = null; render(); });
  }),
  toggleDrafts: p1((u) => { u.draftsOpen = !u.draftsOpen; }),
  restore: p1((u, n) => { p1Run((c) => restoreDraft(c, n)).then((ok) => { if (ok) u.draftsOpen = false; render(); }); }),
  openEdit: p1((u, n) => {
    const c = clipList(p1script()).find((x) => x.n === n)?.clip;
    if (!c) return;
    u.redo = null;
    u.editing = { n, narration: c.narration ?? "", spoken: c.spoken ?? "", cue: c.cue ?? "" };
  }),
  editField: p1((u, k, v) => { if (u.editing) u.editing[k] = v; }, false),
  saveClip: p1((u) => {
    const e = u.editing; if (!e) return;
    p1Run((c) => editClip(c, e.n, { narration: e.narration, spoken: e.spoken, cue: e.cue })).then((ok) => { if (ok && u.editing === e) u.editing = null; render(); });
  }),
  closeClip: p1((u) => { u.editing = null; u.redo = null; }),
  openRedo: p1((u, n) => { u.editing = null; u.redo = { n, note: "" }; }),
  redoNote: p1((u, v) => { if (u.redo) u.redo.note = v; }),
  redo: p1((u, n, note) => {
    if (!String(note ?? "").trim()) return;
    const r = u.redo;
    p1Run((c) => redoOne(c, n, note.trim()), { writing: true }).then((ok) => { if (ok && u.redo === r) u.redo = null; render(); });
  }),
  openList: p1((u, kind) => { u.list = { kind, rows: listRows(kind, p1script()?.[kind] ?? []) }; }),
  listField: p1((u, i, f, v) => { if (u.list?.rows[i]) u.list.rows[i][f] = v; }, false),
  listAdd: p1((u) => { if (u.list && LISTS[u.list.kind].addable) u.list.rows.push({ ...LISTS[u.list.kind].blank }); }),
  listRemove: p1((u, i) => { u.list?.rows.splice(i, 1); }),
  closeList: p1((u) => { u.list = null; }),
  saveList: p1((u) => {
    const l = u.list; if (!l) return;
    let items;
    try { items = listFromRows(l.kind, l.rows, { script: p1script() }); } catch (e) { u.error = msg(e); return; }
    p1Run((c) => editLists(c, { [l.kind]: items })).then((ok) => { if (ok && u.list === l) u.list = null; render(); });
  }),
  unpick: p1((u, id) => { p1Run((c) => setPicks(c, p1pickIds().filter((x) => x !== id))); }),
  chooseLine: p1((u, id) => { u.addLine = id; }),
  pick: p1((u, id) => {
    if (!id) return;
    p1Run((c) => setPicks(c, [...p1pickIds(), id])).then((ok) => { if (ok) u.addLine = ""; render(); });
  }),
  openEpisode: p1((u) => { u.episode = String(app.store?.state?.part1?.setup?.episode ?? ""); }),
  episodeField: p1((u, v) => { u.episode = v; }, false),
  closeEpisode: p1((u) => { u.episode = null; }),
  saveEpisode: p1((u) => {
    const ep = String(u.episode ?? "").trim();
    if (!/^\d{1,4}$/.test(ep)) { u.error = "The episode number is digits only, such as 008."; return; }
    p1Run((c) => editLists(c, { episode: ep })).then((ok) => { if (ok) u.episode = null; render(); });
  }),
  approve: p1(() => { approvePart1Now(); }),
};

const reviewActions = {
  part1: part1Actions,
  makeShotList: () => { makeShotList(); },
  approvePart2: () => { approvePart2Now(); },
  copyMessage: (text, box) => { copyMessage(text, box); },
  setLayout(v) {
    app.layout = v;
    try { localStorage.setItem(LAYOUT_KEY, v); } catch { /* storage blocked: per-session only */ }
    render();
  },
  // A clip costs credits: its press goes through paid() (a second press when the cost is unknown).
  first: cardAction((id) => {
    if (!paid(id, clipEstimate(id))) return;
    userStarted();
    return startTake(ctx(), id);
  }),
  approve: cardAction((id) => approve(ctx(), id)),
  unapprove: cardAction((id) => unapprove(ctx(), id)),
  choose: cardAction((id, n) => choose(ctx(), id, n)),
  redo: cardAction(async (id, note) => {
    if (!note || !note.trim()) throw new Error("Write a note saying what should change.");
    if (!paid(id, clipEstimate(id))) return;
    userStarted();
    await startTake(ctx(), id, { note: note.trim() });
    app.review.noteFor = null; app.review.draft = "";
  }),
  make3d: cardAction((id) => addBlender3d(ctx(), id)),
  animate: cardAction((id) => addAnimated(ctx(), id)),
  // Remove this version asks first, on the card; the takes stay on disk.
  askRemove(id) { app.review.removeFor = id; app.review.cardErrors.delete(id); render(); },
  cancelRemove() { app.review.removeFor = null; render(); },
  removeVersion: cardAction(async (id) => {
    try { await removeVersion(ctx(), id); } finally { if (app.review.removeFor === id) app.review.removeFor = null; }
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
  playTake,
  // Saved in the film's own studio state, for this take only (a re-record clears it).
  okByJon: cardAction(async (id, takeS) => {
    if (typeof takeS !== "number") return;
    await app.store.update((d) => { d.narrationOk = { ...(d.narrationOk ?? {}), [id]: { take_mtime: takeS, at: Date.now() } }; });
    await app.store.log(`Narration ${id}: OK by Jon`);
    await refreshNarration();
  }),
  undoOk: cardAction(async (id) => {
    await app.store.update((d) => { if (d.narrationOk) delete d.narrationOk[id]; });
    await app.store.log(`Narration ${id}: OK removed`);
    await refreshNarration();
  }),
  reopen: (dir) => { openReview(dir); },
  preview,
  // Music and sound effects
  planAudio: () => { planMusic(); },
  addCue: (v) => { addAudioCue(v); },
  editAudio: cardAction((id, patch) => editItem(app.store, id, patch)),
  getCost: cardAction((id) => estimateFor(id)),
  // The score makes 2 takes a press, a cue 1. An ElevenLabs press needs a current estimate (shown on the button).
  generateAudio: cardAction((id) => { userStarted(); return startAudioTake(ctx(), id, { count: id === "SCORE" ? 2 : 1 }); }),
  // Stable Audio is free: rewrite and start. ElevenLabs: rewrite, then get the cost; Jon presses Generate to pay.
  redoAudio: cardAction(async (id, note) => {
    if (!note || !note.trim()) throw new Error("Write a note saying what should change.");
    userStarted();
    const item = id === "SCORE" ? app.store.state.audio?.score : app.store.state.audio?.sfx?.find((x) => x.id === id);
    const paid = id === "SCORE" || item?.source === "elevenlabs";
    if (paid) {
      await rewriteFromNote(ctx(), id, note.trim());
      fields.delete(`au-${id}-prompt`);
      app.review.noteFor = null; app.review.draft = "";
      await estimateFor(id);
    } else {
      await startAudioTake(ctx(), id, { note: note.trim() });
      fields.delete(`au-${id}-prompt`);
      app.review.noteFor = null; app.review.draft = "";
    }
  }),
  chooseAudio: cardAction((id, n) => chooseAudio(ctx(), id, n)),
  approveAudio: cardAction((id) => approveAudio(ctx(), id)),
  unapproveAudio: cardAction((id) => unapproveAudio(ctx(), id)),
  startStableAudio: () => { startStableAudio(); },
  // Voiceover and mix
  // The join always takes the pause marks as they are now: the same code as Apply pauses (pacingchain), stopping
  // after the join, so Jon's cue starts move with the pauses too. The card is free once the job is queued; a failure
  // before that shows on the card, the join's own failure on its step, anything after it under the review.
  joinVoiceover: stepAction("VOICEOVER", async (allowFlagged) => {
    userStarted();
    const r = app.review;
    let begun = false, started;
    const queued = new Promise((res) => { started = res; });
    const run = applyPauses(mixCtx(), { joinOnly: true, allowFlagged: !!allowFlagged, onStarted: () => { begun = true; started(); } });
    run.then((res) => { if (res?.withoutPauses && app.review === r) { r.paceInfo = JOINED_WITHOUT; render(); } }, (e) => {
      if (!begun || app.review !== r) return;
      const st = app.store?.state?.mix?.voiceover?.status;
      if (st === "failed" || st === "interrupted") return;
      r.paceError = msg(e); render();
    });
    await Promise.race([queued, run]);
  }),
  fitScore: stepAction("FIT", async (note) => {
    if (note !== undefined && !String(note).trim()) throw new Error("Write a note saying what should change.");
    userStarted();
    app.review.opened = null; app.review.exportConfirm = null;
    await startFit(mixCtx(), note === undefined ? {} : { note: String(note).trim() });
    if (app.review.noteFor === "FIT") { app.review.noteFor = null; app.review.draft = ""; }
  }),
  openStemRemixer: () => { openStemRemixer(); },
  findExports: () => { findExports(); },
  pickExport(path) { if (app.review.exports) { app.review.exports.pick = path; render(); } },
  closeExports() { app.review.exports = null; render(); },
  closeConfirm() { app.review.exportConfirm = null; render(); },
  // An export more than 1 s off the film's length comes back as a question; "Use it anyway" sends confirmed.
  useExport: stepAction("FIT", async (path, opts = {}) => {
    userStarted();
    app.review.exportConfirm = null;
    const r = await useStemRemixerExport(mixCtx(), path, opts);
    if (r && typeof r === "object" && r.confirm) {
      app.review.exportConfirm = { path: opts.pasted ? pastedPath(path) : path, text: r.confirm };
      return;
    }
    app.review.exports = null;
    fields.delete("mix-other");
    // Free and local: the mix is made again from the export straight away (its errors show on the Mix step).
    queueMicrotask(() => { reviewActions.makeMix(); });
  }),
  makeMix: stepAction("MIX", () => { userStarted(); return startMix(mixCtx()); }),
  approveMix: stepAction("MIX", () => approveMix(mixCtx())),
  mixPlayer: (file, key, label) => mixAudioEl(file, key, label),
  audioPlayer: (slot, file, key, label) => audioEl(slot, file, key, label),
  isPaused: (file) => app.playing === file && !!app.paused,
  seekMix,
  // Pacing review
  reviewPlayer: (file, key, label) => audioEl("review", file, key, label),
  // A new bar per paint (the old one is dropped with the old DOM); attachFollow binds it to the review's player.
  prompter(m) {
    const old = app.review.bar;
    old?.attach(null);
    app.review.bar = prompterBar(m, reviewActions, { index: old?.index() ?? 0 });
    return app.review.bar.el;
  },
  seekReview,
  markWord(id, i) {
    if (newTake(id)) return;
    const words = wordsOf(id);
    const w = words[i];
    if (!w) return;
    editLine(id, (l) => addMark(l, { after: true, word: w.word, nth: w.nth, size: "medium", by: "jon", take: takeOf(id), words }));
  },
  markGap(id) { editLine(id, (l) => addMark(l, { after: "end", size: "medium", by: "jon", take: takeOf(id), words: wordsOf(id) })); },
  openMark(id, key) {
    const m = app.review.paceMenu;
    app.review.paceMenu = m && m.id === id && m.key === key ? null : { id, key };
    app.review.focusMenu = !!app.review.paceMenu;
    render();
  },
  editMark: (id, key, op) => { editMark(id, key, op); },
  // Saving a note never asks Claude; Place pauses does.
  saveNote(id, text) {
    const now = app.host.now();
    return editLine(id, (l) => ({ ...l, note: text, noteAt: now }));
  },
  async setRerecord(id, on) {
    const now = app.host.now();
    await editLine(id, (l) => ({ ...l, rerecord: on ? { at: now } : null }));
    await Promise.resolve(app.store.log(`Narration ${id}: ${on ? "marked to re-record" : "Re-record removed"}`)).catch(() => {});
    await refreshNarration();
    render();
  },
  placePauses: () => { placePauses(); },
  applyPauses: () => { runApplyPauses(); },
  ...onCameraActions,
  field: (k) => fields.get(k),
  setField(k, v) { if (v === undefined) fields.delete(k); else fields.set(k, v); },
  rendering: () => rendering,
};

// ---- boot ----
async function boot() {
  // Choosing Films from the nav closes the New film form.
  $("nav").onclick = (e) => { const v = e.target.closest("button")?.dataset.view; if (!v) return; if (v === "films") app.nf = null; showView(v); };
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
  app.rawHost = host;
  app.host = host;
  // Credits left in Higgsfield and ElevenLabs, in the top bar and the tray: now, every 10 minutes, after paid takes.
  app.credits = makeCredits(live);
  app.credits.onChange(() => { paintCredits(); updateTray(); });
  app.credits.refresh();
  setInterval(() => app.credits.refresh(), 10 * 60_000);
  const desktop = await window.claude.use("desktop");
  desktop.app?.dock?.setIcon(drawIcon()).catch(() => {});
  // Probe re-reads .studio-settings.json and updates the one settings object every runner holds.
  mountProbe(live, $("run-probe"), $("probe-results"), () => app.settings, reloadSettings,
    () => ({ comfy: app.comfyStarter, stableAudio: app.starter }), () => refreshI2v(), choosePresenterPhotos, () => app.root, probeSetup);
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
  // Tray and notifications already allowed (an earlier version or run): put the tray icon up now, so
  // closing the window hides the app instead of ending running jobs. Never asks on load.
  try { if ((await app.host.permissionState("menu-bar")) === "granted") { userStarted(); render(); } } catch { /* stay unarmed */ }
}

// Closing the app stops the Stable Audio process the app started (never one Jon started himself).
// Closing the app stops the ComfyUI and Stable Audio processes the app started (never ones Jon started himself).
window.addEventListener("pagehide", () => {
  for (const s of [app.starter, app.comfyStarter]) { try { Promise.resolve(s?.stop()).catch(() => {}); } catch { /* closing anyway */ } }
});

// The sticky summary bar on Review sits just under the sticky header, whatever its height.
{
  const top = document.querySelector(".top");
  const setH = () => document.documentElement.style.setProperty("--toph", `${top.offsetHeight}px`);
  setH();
  try { new ResizeObserver(setH).observe(top); } catch { /* older webview: header height fixed at load */ }
}

boot();
