// Review view, music and sound effects: the Score card, the Sound effects cards and the Stable Audio chip.
// audioModel is pure; audioSections builds the DOM from it.
import { h, btn, toolLabel, playToggle } from "./dom.js";
import { foldable } from "./fold.js";
import { nodeSig } from "../tools/elevenlabs.js";
import { formatStart } from "../audioplan.js";
import { MAKE_ON_DESKTOP } from "../labels.js";

const SA_LABEL = { off: "Off", starting: "Starting…", ready: "Ready", music: "Music model loaded", failed: "Didn't start" };
const SOURCES = ["stableaudio", "elevenlabs"];
const busyTake = (t) => t.status === "queued" || t.status === "running";
const filled = (v) => typeof v === "string" && v.trim() !== "";
const isScore = (id) => id === "SCORE";

function currentSig(kind, item) {
  try { return nodeSig(kind, item); } catch { return null; } // no length yet
}

function takeMeta(t) {
  const parts = [];
  if (Number.isFinite(t.lengthS)) parts.push(`${t.lengthS.toFixed(1)} s`);
  if (Number.isFinite(t.peakDb)) parts.push(`peak ${Math.round(t.peakDb)} dB`);
  return parts.join(" · ");
}

function takeStatus(t) {
  if (t.status === "queued") return "Queued";
  if (t.status === "running") return "Generating…";
  if (t.status === "failed" || t.status === "interrupted") return `Failed: ${t.error ?? "no reason given"}`;
  return null;
}

export function itemModel(item, { pending = false, estimating = false, error = null, noteOpen = false, playing = null, role = "desktop" } = {}) {
  const score = isScore(item.id);
  const kind = score ? "score" : "sfx";
  const source = score ? "elevenlabs" : item.source ?? "stableaudio";
  const takes = item.takes ?? [];
  const running = takes.some(busyTake);
  const busy = running || pending;
  const free = !busy;
  const count = score ? 2 : 1;
  const what = count > 1 ? `Generate ${count} takes` : "Generate take";
  const ready = filled(item.prompt) && item.durationS != null && item.durationS !== "";

  const sig = source === "elevenlabs" ? currentSig(kind, item) : null;
  const current = source === "elevenlabs" && !!item.est && sig !== null && item.est.sig === sig;
  let generateLabel, canGenerate, canGetCost = false;
  // On a laptop, Stable Audio takes are made on the desktop.
  const onDesktop = source === "stableaudio" && role === "laptop";
  if (onDesktop) {
    generateLabel = MAKE_ON_DESKTOP;
    canGenerate = false;
  } else if (source === "stableaudio") {
    generateLabel = `${what} · Free`;
    canGenerate = free && ready;
  } else if (current) {
    generateLabel = `${what} · about ${count * item.est.credits} credits`;
    canGenerate = free && ready;
  } else {
    generateLabel = estimating ? "Getting the cost…" : "Get the cost";
    canGenerate = false;
    canGetCost = free && ready;
  }

  const chosenTake = takes.find((t) => t.n === item.chosen) ?? null;
  return {
    id: item.id,
    isScore: score,
    cue: item.cue ?? (score ? "Score" : ""),
    prompt: item.prompt ?? "",
    durationS: item.durationS ?? null,
    loop: !!item.loop,
    startText: score ? "" : formatStart(item.startS),
    placedNote: score || (item.startS != null && item.startS !== "") ? null : "Not placed yet",
    loopShown: !score && source === "elevenlabs",
    source,
    sourceLabel: toolLabel(source),
    sourceSwitch: score ? null : {
      options: SOURCES.map((s) => ({ source: s, label: toolLabel(s), pressed: s === source })),
      disabled: !free,
    },
    tag: `${item.id} · ${toolLabel(source)}${takes.length ? ` · take ${item.chosen ?? "-"}/${takes.length}` : ""}`,
    busy,
    pending,
    est: current ? item.est.credits : null,
    estStale: source === "elevenlabs" && !!item.est && !current,
    generateLabel,
    canGenerate,
    canGetCost,
    canEdit: free,
    canEditStart: !pending, // the start time doesn't touch the take, so it can change while one runs
    takes: takes.map((t) => ({
      n: t.n, source: t.source ?? source, sourceLabel: toolLabel(t.source ?? source), file: t.status === "done" ? t.file ?? null : null,
      playing: !!t.file && t.status === "done" && t.file === playing,
      lengthS: t.lengthS ?? null, peakDb: t.peakDb ?? null, quiet: !!t.quiet,
      meta: t.status === "done" ? takeMeta(t) : "",
      chip: t.status === "done" && t.quiet ? "Near-silent" : null,
      status: t.status, statusText: takeStatus(t), error: t.error ?? null,
      chosen: t.n === item.chosen,
      note: t.note ?? null,
    })),
    chosen: item.chosen ?? null,
    approved: !!item.approved,
    canPick: free && takes.length > 1,
    canApprove: free && !item.approved && chosenTake?.status === "done",
    canUndo: free && !!item.approved,
    canRedo: free && takes.length > 0 && !onDesktop,
    onDesktop,
    nextNote: filled(item.pendingNote) ? `Next take: from your note “${item.pendingNote}”` : null,
    error,
    noteOpen,
  };
}

// sa: {state, message} from the Stable Audio starter.
export function audioModel(audio, { pending = new Set(), estimating = new Set(), cardErrors = new Map(), noteFor = null, playing = null, sa = null,
  planning = false, planError = null, adding = false, addError = null, role = "desktop" } = {}) {
  const st = sa?.state ?? "off";
  const saModel = { state: st, label: SA_LABEL[st] ?? st, canStart: st !== "starting" && st !== "ready", message: sa?.message ?? null };
  const sfx = audio?.sfx ?? [];
  const needsPlan = !audio || (!audio.score && sfx.length === 0);
  const opts = (id) => ({ pending: pending.has(id), estimating: estimating.has(id), error: cardErrors.get(id) ?? null, noteOpen: noteFor === id, playing, role });
  return {
    needsPlan,
    planning,
    planError,
    adding,
    addError,
    sa: saModel,
    score: audio?.score ? itemModel(audio.score, opts(audio.score.id ?? "SCORE")) : null,
    sfx: sfx.map((x) => itemModel(x, opts(x.id))),
  };
}

// ---- DOM ----
// Text boxes keep what Jon typed across re-renders (actions.field / setField) and save on blur or change.

// Saves a typed value. The kept text is cleared only once the save succeeded (editAudio resolves true)
// and Jon hasn't typed more since; a failed or refused save leaves it in the box.
// always: send it even when it matches what is saved (a retyped start time marks it Jon's).
export function saveTyped(actions, id, key, value, saved, patch, { always = false } = {}) {
  if (!always && String(value) === String(saved ?? "")) { actions.setField(key, undefined); return Promise.resolve(true); }
  return Promise.resolve(actions.editAudio(id, patch)).then((ok) => {
    if (ok === true && actions.field(key) === value) actions.setField(key, undefined);
    return ok === true;
  });
}

function promptBox(c, actions) {
  const key = `au-${c.id}-prompt`;
  const ta = h("textarea", { id: key, rows: c.isScore ? 8 : 3, "aria-label": `Prompt for ${c.cue}`, disabled: !c.canEdit });
  ta.value = actions.field(key) ?? c.prompt;
  ta.addEventListener("input", () => actions.setField(key, ta.value));
  ta.addEventListener("blur", () => {
    if (actions.rendering()) return; // replaced by a re-render, not left by Jon
    actions.setField(key, ta.value);
    saveTyped(actions, c.id, key, ta.value, c.prompt, { prompt: ta.value });
  });
  return ta;
}

function lengthBox(c, actions) {
  const key = `au-${c.id}-len`;
  const inp = h("input", { type: "number", id: key, class: "alen", min: c.isScore ? 3 : 1, max: c.isScore ? 600 : 30, step: 1,
    "aria-label": `Length of ${c.cue} in seconds`, disabled: !c.canEdit });
  inp.value = actions.field(key) ?? (c.durationS ?? "");
  inp.addEventListener("input", () => actions.setField(key, inp.value));
  inp.addEventListener("change", () => {
    const v = inp.value;
    actions.setField(key, v);
    saveTyped(actions, c.id, key, v, c.durationS, { durationS: v === "" ? null : Number(v) });
  });
  return h("label", { class: "aopt" }, h("span", { text: "Length" }), inp, h("span", { text: "s" }));
}

function startBox(c, actions) {
  const key = `au-${c.id}-start`;
  const inp = h("input", { type: "text", id: key, class: "alen", placeholder: "m:ss.s", size: 7,
    "aria-label": `Film time ${c.cue} starts at`, disabled: !c.canEditStart });
  inp.value = actions.field(key) ?? c.startText;
  // Typing the same time again fires no change event, so a typed box also saves when Jon leaves it.
  let typed = false;
  const save = () => {
    typed = false;
    const v = inp.value;
    actions.setField(key, v);
    saveTyped(actions, c.id, key, v, c.startText, { startS: v }, { always: v.trim() !== "" });
  };
  inp.addEventListener("input", () => { typed = true; actions.setField(key, inp.value); });
  inp.addEventListener("change", save);
  inp.addEventListener("blur", () => { if (typed && !actions.rendering()) save(); });
  return h("label", { class: "aopt" }, h("span", { text: "Starts at" }), inp);
}

function loopBox(c, actions) {
  const cb = h("input", { type: "checkbox", id: `au-${c.id}-loop`, disabled: !c.canEdit });
  cb.checked = c.loop;
  cb.addEventListener("change", () => actions.editAudio(c.id, { loop: cb.checked }));
  return h("label", { class: "aopt" }, cb, h("span", { text: "Loop" }));
}

function takeRow(c, t, actions) {
  return h("li", { class: `arow${t.chosen ? " on" : ""}` },
    t.file
      ? playToggle(t.file, t.playing, `${c.id} take ${t.n}`, actions)
      : h("span", { class: "nplay-gap" }),
    h("div", { class: "abody" },
      h("div", { class: "ahead" }, h("span", { class: "an", text: `Take ${t.n}` }), h("span", { class: "asrc", text: t.sourceLabel })),
      t.statusText || t.meta || t.chip ? h("div", { class: "aline" },
        t.statusText ? h("span", { class: t.error ? "err" : "ameta", text: t.statusText }) : t.meta ? h("span", { class: "ameta", text: t.meta }) : null,
        t.chip ? h("span", { class: "achip", text: t.chip }) : null) : null));
}

function audioCard(c, actions) {
  const cls = `card audio${c.approved ? " ok" : ""}${c.busy ? " gen" : ""}`;
  const sw = c.sourceSwitch ? h("div", { class: "toggle tool-switch", role: "group", "aria-label": `Sound source for ${c.id}` },
    c.sourceSwitch.options.map((o) => h("button", { type: "button", "aria-pressed": String(o.pressed), disabled: c.sourceSwitch.disabled,
      onclick: () => { if (!o.pressed) actions.editAudio(c.id, { source: o.source }); } }, o.label))) : null;
  const picker = c.takes.length > 1 ? h("div", { class: "takes" }, c.takes.map((t) =>
    h("button", { type: "button", "aria-pressed": String(t.chosen), "aria-label": `Take ${t.n}`, disabled: !c.canPick,
      onclick: () => actions.chooseAudio(c.id, t.n) }, String(t.n)))) : null;
  const history = c.takes.filter((t) => t.note).map((t) => `take ${t.n}, your note: "${t.note}"`);

  let controls;
  if (c.noteOpen) {
    const ta = h("textarea", { id: "note-box", placeholder: "What should change? e.g. slower, darker, less reverb", "aria-label": `Note for ${c.id}` });
    ta.value = actions.draft();
    ta.addEventListener("input", () => actions.setDraft(ta.value));
    controls = [ta, h("div", { class: "row" },
      btn(c.source === "elevenlabs" ? "Rewrite the prompt" : "Redo with note", () => actions.redoAudio(c.id, ta.value), { disabled: !c.canRedo }),
      btn("Cancel", () => actions.closeNote(), { ghost: true }))];
  } else {
    const gen = c.canGenerate || c.source !== "elevenlabs" || c.est !== null
      ? btn(c.generateLabel, () => actions.generateAudio(c.id), { disabled: !c.canGenerate })
      : btn(c.generateLabel, () => actions.getCost(c.id), { disabled: !c.canGetCost });
    const row = [picker, gen];
    if (c.approved) row.push(h("span", { class: "ok-tag", text: "✓ Approved" }), btn("Undo", () => actions.unapproveAudio(c.id), { ghost: true, disabled: !c.canUndo }));
    else if (c.takes.length) row.push(btn("Approve", () => actions.approveAudio(c.id), { disabled: !c.canApprove }));
    if (c.takes.length && !c.onDesktop) row.push(btn("Redo…", () => actions.openNote(c.id), { ghost: true, disabled: !c.canRedo }));
    controls = [h("div", { class: "row" }, row)];
  }

  return h("article", { class: cls },
    h("div", { class: "cb" },
      h("span", { class: "atag", text: c.tag }),
      c.isScore ? null : h("div", { class: "d", text: c.cue }),
      sw,
      promptBox(c, actions),
      h("div", { class: "aopts" }, lengthBox(c, actions), c.isScore ? null : startBox(c, actions), c.loopShown ? loopBox(c, actions) : null),
      c.placedNote ? h("div", { class: "hist", text: c.placedNote }) : null,
      c.takes.length ? h("ul", { class: "atakes" }, c.takes.map((t) => takeRow(c, t, actions))) : h("div", { class: "hist", text: "No take yet" }),
      history.length ? h("div", { class: "hist" }, "History: ", history.join("; ")) : null,
      c.nextNote ? h("div", { class: "hist", text: c.nextNote }) : null,
      c.pending ? h("div", { class: "hist", text: "Working…" }) : null,
      c.error ? h("div", { class: "err", text: c.error }) : null,
      controls));
}

function addCueForm(m, actions) {
  const name = h("input", { type: "text", id: "au-new-cue", placeholder: "Cue name, e.g. door creak", "aria-label": "New cue name", disabled: m.adding });
  name.value = actions.field("au-new-cue") ?? "";
  name.addEventListener("input", () => actions.setField("au-new-cue", name.value));
  const len = h("input", { type: "number", id: "au-new-len", class: "alen", min: 1, max: 30, step: 1, "aria-label": "New cue length in seconds", disabled: m.adding });
  len.value = actions.field("au-new-len") ?? "5";
  len.addEventListener("input", () => actions.setField("au-new-len", len.value));
  return h("div", { class: "aadd" },
    name, h("label", { class: "aopt" }, len, h("span", { text: "s" })),
    btn(m.adding ? "Adding…" : "Add cue", () => actions.addCue({ cue: name.value, durationS: len.value === "" ? null : Number(len.value) }), { ghost: true, disabled: m.adding }),
    m.addError ? h("p", { class: "err", text: m.addError }) : null);
}

export function audioSections(m, actions) {
  if (!m) return [];
  if (m.needsPlan) {
    return [foldable(h("section", { class: "audio-plan", "aria-label": "Music and sound effects" },
      h("div", { class: "h2row" }, h("h2", { text: "Music and sound effects" })),
      h("div", { class: "panel" },
        h("p", { text: "No music or sound effects planned yet. Claude reads the script and part1_handover.md and plans the score and each cue." }),
        btn(m.planning ? "Planning…" : "Plan music and sound effects", () => actions.planAudio(), { disabled: m.planning }),
        m.planError ? h("p", { class: "err", text: m.planError }) : null)), "Music and sound effects")];
  }
  const scoreSec = h("section", { class: "audio", "aria-label": "Score" },
    h("div", { class: "h2row" }, h("h2", { text: "Score" })),
    m.score ? h("div", { class: "score-card" }, audioCard(m.score, actions)) : h("p", { class: "note", text: "No score planned." }));
  const s = m.sa;
  const sfxSec = h("section", { class: "audio", "aria-label": "Sound effects" },
    h("div", { class: "h2row" }, h("h2", { text: "Sound effects" }),
      h("div", { class: "sahead" },
        h("span", { class: `achip sa-${s.state}`, text: `Stable Audio: ${s.label}` }),
        s.canStart ? btn("Start Stable Audio", () => actions.startStableAudio(), { ghost: true }) : null)),
    s.message ? h("p", { class: "err", text: s.message }) : null,
    m.sfx.length ? h("div", { class: "cards sfx-cards" }, m.sfx.map((c) => audioCard(c, actions))) : h("p", { class: "note", text: "No sound effects yet." }),
    addCueForm(m, actions));
  return [foldable(scoreSec, "Score"), foldable(sfxSec, "Sound effects")];
}
