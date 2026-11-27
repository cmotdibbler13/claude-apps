// Review view, Voiceover and mix: join the voiceover, fit the score, make the mix preview, approve it.
// mixModel is pure; mixSection builds the DOM from it. Each step is ready only when the one before it is done.
import { h, btn, basename } from "./dom.js";
import { OUT_OF_DATE, REJOIN, fitStale, mixStale, joinStale } from "../mixplan.js";
import { countsLine, NO_LINE_SCRIPT } from "../narration.js";
import { MSG_INTERRUPTED } from "../tools/voicejoin.js";
import { MSG_NO_STEM_REMIXER } from "../tools/stemfit.js";
import { LOST } from "../redo.js";

const WPM = 150;
const live = (s) => s === "queued" || s === "running";
const VERB = { VOICEOVER: "Joining…", FIT: "Fitting…", MIX: "Mixing…" };
// Lines the join takes only when Jon presses Join anyway: their check found a problem, never ran, or is older than the checker.
const NOT_OK = new Set(["flagged", "unchecked", "outdated", "error", "rerecord"]);
const COUNT_WORD = { 2: "Two", 3: "Three", 4: "Four", 5: "Five" };
export { joinStale };

// The mix player is kept across re-renders while it plays the same mix: the same file from the same run.
export const playerKey = (file, at) => `${file ?? ""}#${at ?? ""}`;
export const keepPlayer = (current, key) => !!current?.el && current.key === key;

// m:ss, rounded to the second.
export function mmss(s) {
  if (s == null || !Number.isFinite(Number(s))) return "";
  const t = Math.max(0, Math.round(Number(s)));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
const signed = (s) => `${s >= 0 ? "+" : "-"}${Math.abs(s).toFixed(1)} s`;

function approvedScore(state) {
  const sc = state?.audio?.score;
  if (!sc?.approved) return null;
  return (sc.takes ?? []).find((t) => t.n === sc.chosen && t.status === "done" && t.file) ?? null;
}

// The common part of a step: running, done or stale, locked, failed or interrupted, or ready.
function base(id, holder, { lock, stale, pending, jobs, error }) {
  const st = holder?.status;
  let state, statusText = null;
  if (live(st)) {
    state = "running";
    const job = (jobs ?? []).find((j) => j.id === (holder.jobId ?? holder.takes?.[0]?.jobId));
    const p = job?.status === "running" && Number.isFinite(job?.progress) ? ` ${Math.round(job.progress * 100)}%` : "";
    statusText = st === "queued" && job?.status !== "running" ? "Queued" : `${VERB[id]}${p}`;
  } else if (pending) {
    state = "running";
    statusText = "Working…";
  } else if (st === "done") {
    state = stale ? "stale" : "done";
    if (stale) statusText = OUT_OF_DATE;
  } else if (lock) {
    state = "locked";
    statusText = lock;
  } else if (st === "interrupted" || ((st === "failed") && (holder.error === MSG_INTERRUPTED || holder.error === LOST))) {
    state = "interrupted";
    statusText = MSG_INTERRUPTED;
  } else if (st === "failed") {
    state = "failed";
    statusText = `Failed: ${holder.error ?? "no reason given"}`;
  } else state = "ready";
  const free = state !== "running";
  return { id, state, statusText, lock: lock ?? null, free, error: error ?? null };
}

function joinStep(state, narration, o) {
  const vo = state?.mix?.voiceover ?? null;
  let lock = null, counts = null, notOk = [];
  if (!narration) lock = "Waiting for the Narration list.";
  else if (narration.missingScript) lock = NO_LINE_SCRIPT;
  else {
    counts = countsLine(narration.counts);
    const missing = narration.rows.filter((r) => r.status === "missing").map((r) => r.id);
    if (missing.length) lock = `Record these first: ${missing.join(", ")}`;
    notOk = narration.rows.filter((r) => NOT_OK.has(r.status));
  }
  const stale = o.joinStale;
  const s = base("VOICEOVER", vo, { lock, stale, pending: o.pending.has("VOICEOVER"), jobs: o.jobs, error: o.cardErrors.get("VOICEOVER") });
  const again = vo && vo.status !== "queued" && vo.status !== "running";
  const label = notOk.length ? `Join anyway (${notOk.length} not OK)` : again ? "Join again" : "Join voiceover";
  const out = { ...s, title: "Join voiceover", counts, flagged: notOk.length ? `Not OK: ${notOk.map((r) => `${r.id} ${r.status}`).join(", ")}` : null,
    run: { label, allowFlagged: notOk.length > 0, enabled: s.free && !lock }, file: null, playing: false, playerKey: null, lengthText: null, details: [] };
  if (vo?.status === "done") {
    const words = (narration?.rows ?? []).reduce((n, r) => n + String(r.text ?? "").split(/\s+/).filter(Boolean).length, 0);
    out.file = vo.wav ?? null;
    out.playing = !!vo.wav && vo.wav === o.playing;
    out.playerKey = vo.wav ? playerKey(vo.wav, vo.at) : null;
    out.lengthText = Number.isFinite(vo.lengthS) ? `${mmss(vo.lengthS)}${words ? ` (the script estimate is ${mmss((words / WPM) * 60)})` : ""}` : null;
    for (const t of vo.tightened ?? []) out.details.push(`Stall tightened: ${t.id}, ${Number(t.from_s).toFixed(1)} s to ${Number(t.to_s).toFixed(1)} s`);
    if (vo.extra?.length) out.details.push(`Takes that match no line: ${vo.extra.join(", ")}`);
    if (vo.silent?.length) out.details.push(`No speech found, joined as silence: ${vo.silent.join(", ")}`);
    for (const d of vo.duplicates ?? []) {
      const n = d.files?.length ?? 0;
      if (n > 1) out.details.push(`${COUNT_WORD[n] ?? n} takes for ${d.id}; used ${basename(d.files[0])}`);
    }
  }
  return out;
}

function fitStep(state, o) {
  const vo = state?.mix?.voiceover;
  const fit = state?.mix?.fit ?? null;
  let lock = null;
  if (vo?.status !== "done") lock = "Waits for the voiceover join.";
  else if (o.joinStale) lock = REJOIN;
  else if (!approvedScore(state)) lock = "Waits for an approved score take (Score card).";
  else if (!o.settings.stemRemixer) lock = MSG_NO_STEM_REMIXER;
  const stale = fitStale(state) || o.joinStale;
  const s = base("FIT", fit, { lock, stale, pending: o.pending.has("FIT"), jobs: o.jobs, error: o.cardErrors.get("FIT") });
  const label = s.state === "done" ? "Fit again with a note" : fit && s.state !== "ready" && s.state !== "locked" ? "Fit again" : "Fit score";
  const out = { ...s, title: "Fit score", run: { label, enabled: s.free && !lock, note: s.state === "done" }, noteOpen: o.noteFor === "FIT",
    sheet: null, suggestion: null, notes: null, sourceText: null, file: null, playing: false, playerKey: null, lengthText: null,
    canOpen: false, canUseExport: false, exports: null, opened: o.ui.opened ?? null, confirm: o.ui.confirm ?? null };
  if (fit?.status === "done") {
    const sh = fit.sheet ?? { rows: [] };
    out.sheet = (sh.rows ?? []).map((r) => ({
      section: r.section, target: mmss(r.targetS), lands: r.noMove ? "no move found" : mmss(r.landsS), miss: r.missS == null ? "" : signed(r.missS),
    }));
    if (sh.suggestNewTake) out.suggestion = `A big move is still ${Number(sh.worstS).toFixed(1)} s off. A new score take may fit better (Score card).`;
    out.notes = fit.source === "app" ? fit.plan?.notes || null : null;
    if (fit.source === "stemremixer") out.sourceText = `Using your Stem Remixer export: ${basename(fit.file)}`;
    out.file = fit.file ?? null;
    out.playing = !!fit.file && fit.file === o.playing;
    out.playerKey = fit.file ? playerKey(fit.file, fit.at) : null;
    out.lengthText = Number.isFinite(fit.lengthS) ? mmss(fit.lengthS) : null;
    out.canOpen = s.free && !!o.settings.stemRemixer && !!(fit.scoreFile ?? approvedScore(state)?.file);
    out.canUseExport = s.free && !lock;
  }
  const ex = o.ui.exports;
  if (ex) out.exports = { ...ex, files: (ex.files ?? []).map((f) => ({ ...f, picked: f.path === ex.pick })) };
  return out;
}

function mixStep(state, o) {
  const fit = state?.mix?.fit;
  const x = state?.mix?.mix ?? null;
  let lock = null;
  if (o.joinStale) lock = REJOIN;
  else if (fit?.status !== "done") lock = "Waits for the score fit.";
  else if (fitStale(state)) lock = "Waits for the score fit to be run again.";
  const stale = mixStale(state) || o.joinStale;
  const s = base("MIX", x, { lock, stale, pending: o.pending.has("MIX"), jobs: o.jobs, error: o.cardErrors.get("MIX") });
  const again = x && s.state !== "ready" && s.state !== "locked";
  const out = { ...s, title: "Mix preview", run: { label: again ? "Make mix again" : "Make mix preview", enabled: s.free && !lock },
    player: null, playerKey: null, playerLabel: null, marks: [], files: [], unplaced: null, approved: false, canApprove: false, approvalNote: null };
  if (x?.status === "done") {
    const f = x.files ?? {};
    out.player = f.mp3 ?? f.wav ?? null;
    out.playerLabel = out.player ? basename(out.player) : null;
    out.playerKey = out.player ? playerKey(out.player, x.at) : null;
    out.marks = (fit?.targets?.sections ?? []).map((sec) => ({ t: sec.startS, label: `${mmss(sec.startS)} ${sec.name}` }));
    out.files = ["wav", "mp3", "voice", "music"].filter((k) => f[k]).map((k) => ({ path: f[k], name: basename(f[k]) }));
    if (x.unplaced?.length) out.unplaced = `Not placed (no start time): ${x.unplaced.join(", ")}`;
    out.approved = !!x.approved && !stale;
    if (x.approved && stale) out.approvalNote = "The approval was for an earlier mix.";
    out.canApprove = s.free && !stale && !x.approved;
  }
  return out;
}

// settings: { stemRemixer: bool }. ui: { exports: {files, pick, error, loading}, opened, confirm: {path, text, pasted} }.
export function mixModel({ state, narration = null, settings = {}, pending = new Set(), cardErrors = new Map(), noteFor = null, playing = null, jobs = [], ui = {} } = {}) {
  const o = { settings, pending, cardErrors, noteFor, playing, jobs, ui, joinStale: joinStale(state?.mix?.voiceover, narration) };
  return { steps: [joinStep(state, narration, o), fitStep(state, o), mixStep(state, o)] };
}

// ---- DOM ----

function statusLine(s) {
  if (!s.statusText) return null;
  const cls = s.state === "failed" ? "err" : s.state === "stale" || s.state === "interrupted" ? "mstale" : s.state === "locked" ? "locked" : "hist";
  return h("p", { class: `mstatus ${cls}` }, s.state === "running" ? h("span", { class: "dot live" }) : null, s.statusText);
}

function joinBody(s, actions) {
  return [
    s.counts ? h("p", { class: "hist", text: s.counts }) : null,
    s.flagged ? h("p", { class: "mflag", text: s.flagged }) : null,
    s.lengthText ? h("p", { class: "mplay", text: `Voiceover ${s.lengthText}` }) : null,
    s.file ? h("div", { class: "mplayer" }, actions.audioPlayer("voice", s.file, s.playerKey, "the voiceover")) : null,
    s.details.length ? h("ul", { class: "mlist" }, s.details.map((d) => h("li", { text: d }))) : null,
    h("div", { class: "row" }, btn(s.run.label, () => actions.joinVoiceover(s.run.allowFlagged), { disabled: !s.run.enabled, ghost: s.state === "done" })),
  ];
}

function sheetTable(rows) {
  return h("div", { class: "mtable" }, h("table", {},
    h("thead", {}, h("tr", {}, ["Section", "Target", "Lands at", "Miss"].map((t) => h("th", { scope: "col", text: t })))),
    h("tbody", {}, rows.map((r) => h("tr", {},
      h("td", { text: r.section }), h("td", { class: "num", text: r.target }),
      h("td", { class: r.lands === "no move found" ? "nomove" : "num", text: r.lands }), h("td", { class: "num", text: r.miss }))))));
}

// "Use another file…": a full path Jon pastes, quoted or not (useStemRemixerExport cleans it and checks it is there).
function otherFile(s, actions) {
  const key = "mix-other";
  const inp = h("input", { type: "text", id: key, class: "mother", placeholder: "Use another file… paste its full path", "aria-label": "Use another file: its full path" });
  inp.value = actions.field(key) ?? "";
  inp.addEventListener("input", () => actions.setField(key, inp.value));
  return h("div", { class: "mrow" }, inp,
    btn("Use this file", () => { if (inp.value.trim()) actions.useExport(inp.value, { pasted: true }); }, { ghost: true, disabled: !s.canUseExport }));
}

function exportsBox(ex, s, actions) {
  if (!ex) return null;
  if (ex.loading) return h("p", { class: "hist", text: "Looking for exports…" });
  if (ex.error) return h("div", { class: "mexports" }, h("p", { class: "err", text: ex.error }), otherFile(s, actions), btn("Close", () => actions.closeExports(), { ghost: true }));
  if (!ex.files.length) {
    return h("div", { class: "mexports" }, h("p", { class: "hist", text: "No exports newer than the fit. Export the mix in Stem Remixer first, or paste the file's path below." }),
      otherFile(s, actions), btn("Close", () => actions.closeExports(), { ghost: true }));
  }
  const pick = ex.files.find((f) => f.picked);
  return h("div", { class: "mexports" },
    h("p", { class: "hist", text: "Stem Remixer exports newer than the fit, newest first. Using one makes the mix again from it." }),
    h("ul", { class: "mlist pick", role: "radiogroup", "aria-label": "Stem Remixer exports" }, ex.files.map((f) => h("li", {},
      h("button", { type: "button", role: "radio", "aria-checked": String(f.picked), class: `mpick${f.picked ? " on" : ""}`, onclick: () => actions.pickExport(f.path) },
        h("span", { class: "mname", text: f.name }), h("span", { class: "hist", text: [f.whereText, f.whenText].filter(Boolean).join(" · ") }))))),
    h("div", { class: "row" },
      btn(pick ? `Use ${pick.name}` : "Use this export", () => pick && actions.useExport(pick.path), { disabled: !pick || !s.canUseExport }),
      btn("Cancel", () => actions.closeExports(), { ghost: true })),
    otherFile(s, actions));
}

function fitBody(s, actions) {
  const kids = [];
  if (s.sourceText) kids.push(h("p", { class: "hist", text: s.sourceText }));
  if (s.file) {
    kids.push(h("p", { class: "mplay", text: `Fitted score${s.lengthText ? ` ${s.lengthText}` : ""}` }));
    kids.push(h("div", { class: "mplayer" }, actions.audioPlayer("fit", s.file, s.playerKey, "the fitted score")));
  }
  if (s.sheet?.length) kids.push(sheetTable(s.sheet));
  if (s.suggestion) kids.push(h("p", { class: "mflag", text: s.suggestion }));
  if (s.notes) kids.push(h("p", { class: "hist", text: s.notes }));
  if (s.noteOpen) {
    const ta = h("textarea", { id: "note-box", placeholder: "e.g. keep the swell at 2:35, shorten the middle instead", "aria-label": "Note for the score fit" });
    ta.value = actions.draft();
    ta.addEventListener("input", () => actions.setDraft(ta.value));
    kids.push(ta, h("div", { class: "row" },
      btn("Fit again", () => actions.fitScore(ta.value), { disabled: !s.run.enabled }),
      btn("Cancel", () => actions.closeNote(), { ghost: true })));
  } else {
    const row = [btn(s.run.label, () => (s.run.note ? actions.openNote("FIT") : actions.fitScore()), { disabled: !s.run.enabled, ghost: s.state === "done" })];
    if (s.state === "done" || s.state === "stale") {
      row.push(btn("Open in Stem Remixer", () => actions.openStemRemixer(), { ghost: true, disabled: !s.canOpen }));
      row.push(btn("Use this export", () => actions.findExports(), { ghost: true, disabled: !s.canUseExport }));
    }
    kids.push(h("div", { class: "row" }, row));
  }
  if (s.opened) kids.push(h("p", { class: "hist", text: s.opened }));
  if (s.confirm) {
    kids.push(h("div", { class: "mexports", role: "alertdialog", "aria-label": "Export length" },
      h("p", { class: "mflag", text: s.confirm.text }),
      h("div", { class: "row" },
        btn("Use it anyway", () => actions.useExport(s.confirm.path, { confirmed: true }), { disabled: !s.canUseExport }),
        btn("Cancel", () => actions.closeConfirm(), { ghost: true }))));
  }
  kids.push(exportsBox(s.exports, s, actions));
  return kids;
}

function mixBody(s, actions) {
  const kids = [];
  if (s.player) {
    kids.push(h("div", { class: "mplayer" }, actions.mixPlayer(s.player, s.playerKey, s.playerLabel)));
    if (s.marks.length) {
      kids.push(h("div", { class: "mmarks", role: "group", "aria-label": "Section marks" },
        s.marks.map((mk) => h("button", { type: "button", class: "mmark", title: "Play from here", onclick: () => actions.seekMix(mk.t) }, mk.label))));
    }
  }
  if (s.files.length) {
    kids.push(h("ul", { class: "mlist files" }, s.files.map((f) => h("li", {},
      h("button", { type: "button", class: "mfile", title: "Open in its default app", onclick: () => actions.openFull(f.path) }, f.name)))));
  }
  if (s.unplaced) kids.push(h("p", { class: "hist", text: s.unplaced }));
  if (s.approvalNote) kids.push(h("p", { class: "hist", text: s.approvalNote }));
  const row = [btn(s.run.label, () => actions.makeMix(), { disabled: !s.run.enabled, ghost: s.state === "done" })];
  if (s.approved) row.push(h("span", { class: "ok-tag", text: "✓ Approved" }));
  else if (s.player) row.push(btn("Approve mix", () => actions.approveMix(), { disabled: !s.canApprove }));
  kids.push(h("div", { class: "row" }, row));
  return kids;
}

const BODY = { VOICEOVER: joinBody, FIT: fitBody, MIX: mixBody };

export function mixSection(m, actions) {
  if (!m) return null;
  return h("section", { class: "mix", "aria-label": "Voiceover and mix" },
    h("div", { class: "h2row" }, h("h2", { text: "Voiceover and mix" })),
    h("ol", { class: "msteps" }, m.steps.map((s, i) => h("li", { class: `mstep m-${s.state}` },
      h("div", { class: "mhead" }, h("span", { class: "mnum", text: String(i + 1) }), h("h3", { text: s.title }),
        h("span", { class: `achip ms-${s.state}`, text: CHIP[s.state] })),
      statusLine(s),
      s.lock && s.state !== "locked" && s.state !== "running" ? h("p", { class: "mstatus locked", text: s.lock }) : null,
      s.state === "locked" && s.id !== "VOICEOVER" ? null : BODY[s.id](s, actions),
      s.error ? h("p", { class: "err", text: s.error }) : null))));
}

const CHIP = { locked: "Waiting", ready: "Ready", running: "Running", done: "Done", stale: "Out of date", failed: "Failed", interrupted: "Interrupted" };
