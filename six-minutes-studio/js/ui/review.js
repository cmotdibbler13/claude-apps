// Review view, b-roll section: shot cards in script order (or a grid), takes, approve, redo with a note.
import { h, btn, toolLabel, mediaEl, playToggle } from "./dom.js";
import { foldable } from "./fold.js";
import { orderByScript } from "../shots.js";
import { canStart, has3d, hasDerived } from "../redo.js";
import { join } from "../paths.js";
import { countsLine, STATUS_LABEL, NO_LINE_SCRIPT } from "../narration.js";
import { audioModel, audioSections } from "./audio.js";
import { mixModel, mixSection } from "./mix.js";
import { onCameraModel, onCameraSection, costLabel, STALE_PORTRAIT, ON_CAMERA } from "./oncamera.js";
import { clipLock, lineLengthS, clipSeconds, onCameraConflict, VOICEOVER_CHANGED } from "../presenter.js";
import { part2Model, part2Bar } from "./part2.js";

const busyTake = (t) => t.status === "queued" || t.status === "running";
const isBusy = (a) => a.takes.some(busyTake);
const VIDEO_EXT = /\.(mp4|mov|webm|mkv)$/i;
export const isVideo = (file) => VIDEO_EXT.test(String(file ?? ""));
const BROLL_TOOLS = ["higgsfield", "comfyui"];
const chosenOf = (a) => a?.takes.find((t) => t.n === a.chosen) ?? null;
const DERIVED = new Set(["blender", "animated"]);
export const MSG_I2V_SETUP = "Set up the image-to-video workflow (see Probe)";
export const removeConfirmText = (id) => `Remove ${id} from the review? Its takes stay on disk.`;
const NOTE_SNIP = 80;

// What each check did. A fix on the last round (3) is never rendered: the take uses round 3's script.
const VERDICT = { matches: "matched", fix: "fixed", blank: "blank" };
const verdictLabel = (c) => (c.verdict === "fix" && c.round >= 3 ? "not applied" : VERDICT[c.verdict] ?? String(c.verdict ?? "checked"));

// The Blender check rounds of the chosen take (or the newest take that has them): the last still and each note.
function checksOf(asset) {
  const has = (t) => Array.isArray(t?.checks) && t.checks.length > 0;
  const chosen = chosenOf(asset);
  const t = has(chosen) ? chosen : [...asset.takes].reverse().find(has);
  if (!t) return null;
  const still = [...t.checks].reverse().find((c) => c.still)?.still ?? null;
  return {
    take: t.n,
    still,
    notes: t.checks.map((c) => {
      const full = String(c.note ?? "").trim();
      return { label: `Check ${c.round} (${verdictLabel(c)})`, text: full.length > NOTE_SNIP ? `${full.slice(0, NOTE_SNIP).trimEnd()}\u2026` : full, full };
    }),
  };
}

export function summarize(assets = []) {
  return { approved: assets.filter((a) => a.approved).length, total: assets.length, regenerating: assets.filter(isBusy).length };
}

// A presenter clip's cost for its padded length: estimates.clips[seconds] (undefined while fetched, null when unknown).
function clipCost(asset, transcript, estimates) {
  const len = lineLengthS(transcript, asset.lineId);
  return len == null ? undefined : estimates?.clips?.[clipSeconds(len)];
}

// state/transcript: the film's state and the last good join's transcript (clip locks, the on-camera conflict).
// estimates/confirm: clip costs and the card whose unknown-cost press is waiting for a second press.
export function cardModel(asset, assets, { pending = false, error = null, i2v = null, confirmRemove = false, state = null, transcript = null, transcriptAt, estimates = null, confirm = null } = {}) {
  const chosen = chosenOf(asset);
  const busy = isBusy(asset);
  const presenter = asset.kind === "presenter";
  const lock = presenter ? clipLock(asset, state ?? { assets }, transcript, transcriptAt) : null;
  const locked = presenter ? lock !== null : !canStart(asset, assets);
  const conflict = !presenter && !!state && onCameraConflict(asset, state);
  const removable = DERIVED.has(asset.kind) || conflict;
  const running = asset.takes.find(busyTake);
  const runTool = running?.tool ?? asset.tool;
  const tool = toolLabel(running ? runTool : asset.tool);
  const free = !busy && !pending;
  let status = null;
  if (!asset.takes.length) status = locked ? null : "No take yet";
  else if (chosen?.status === "failed" || chosen?.status === "interrupted") status = `Take ${chosen.n} failed: ${chosen.error ?? "no reason given"}`;
  const src = asset.tool === "blender" || asset.kind === "animated" ? assets.find((a) => a.id === asset.sourceId) : null;
  const srcTake = chosenOf(src);
  return {
    id: asset.id,
    tool,
    line: asset.line,
    desc: asset.desc,
    tag: `${asset.id} \u00B7 ${tool}${asset.takes.length ? ` \u00B7 take ${asset.chosen}/${asset.takes.length}` : ""}`,
    approved: !!asset.approved,
    busy,
    pending,
    overlay: running ? (running.status === "running" ? (runTool === "comfyui" ? "Rendering in ComfyUI" : `Regenerating in ${tool}`) : `Queued for ${tool}`) : null,
    toolSwitch: asset.kind === "broll" ? {
      options: BROLL_TOOLS.map((t) => ({ tool: t, label: toolLabel(t), pressed: asset.tool === t })),
      disabled: !free,
    } : null,
    locked,
    lockText: presenter ? lock : locked ? `Approve ${asset.sourceId} first` : null,
    sourceId: asset.sourceId ?? null,
    sourceFile: srcTake?.status === "done" ? srcTake.file ?? null : null,
    file: chosen?.status === "done" ? chosen.file ?? null : null,
    isVideo: chosen?.status === "done" && isVideo(chosen.file),
    status,
    takes: asset.takes.map((t) => ({ n: t.n, pressed: t.n === asset.chosen })),
    history: asset.takes.filter((t) => t.note).map((t) => `take ${t.n}, your note: "${t.note}"`),
    canPick: free && asset.takes.length > 1,
    canApprove: free && !asset.approved && chosen?.status === "done",
    canUndo: free && !!asset.approved,
    canMakeFirst: free && !locked && asset.takes.length === 0,
    canRedo: free && !locked && asset.takes.length > 0,
    can3d: free && asset.kind === "lineart" && !has3d(assets, asset.id),
    showAnimate: asset.kind === "lineart" && !hasDerived(assets, asset.id, "animated"),
    canAnimate: free && asset.kind === "lineart" && !hasDerived(assets, asset.id, "animated") && !!i2v?.ok,
    animateWhy: i2v?.ok ? null : MSG_I2V_SETUP,
    removable,
    removeLabel: conflict ? "Remove" : "Remove this version",
    canRemove: free && removable,
    confirmRemove: confirmRemove && removable ? removeConfirmText(asset.id) : null,
    conflict: conflict ? ON_CAMERA : null,
    clip: presenter ? clipModel(asset, clipCost(asset, transcript, estimates), confirm === asset.id, free) : null,
    checks: asset.tool === "blender" ? checksOf(asset) : null,
    error,
  };
}

function clipModel(asset, est, confirming, free) {
  return {
    makeLabel: costLabel("Make clip", est, confirming),
    redoLabel: costLabel("Redo with note", est, confirming),
    costReady: est !== undefined,
    stale: asset.staleReason === "portrait" ? STALE_PORTRAIT : null,
    voiceover: asset.voiceoverChanged ? VOICEOVER_CHANGED : null,
    canKeep: free && !!asset.voiceoverChanged,
  };
}

const SNIP = 60;
const snip = (t) => (t.length > SNIP ? `${t.slice(0, SNIP).trimEnd()}\u2026` : t);

// narration: null (not looked yet), {missingScript:true}, or narrationStatus() output.
export function narrationModel(n, playing = null) {
  if (!n) return null;
  if (n.missingScript) return { message: NO_LINE_SCRIPT, counts: null, rows: [] };
  return {
    message: null,
    counts: countsLine(n.counts),
    rows: n.rows.map((r) => ({ id: r.id, text: snip(r.text), full: r.text, status: r.status, chip: STATUS_LABEL[r.status], flag: r.flags.join("; "), notes: r.notes.join("; "), file: r.file ?? null, playing: !!r.file && r.file === playing,
      takeS: r.takeS ?? null,
      // Jon listened and it's fine: offered on any recorded take that isn't already OK.
      canOk: !!r.file && !["ok", "jon", "missing", "rerecord"].includes(r.status),
      canUndoOk: r.status === "jon" })),
  };
}

function narrationSection(n, actions) {
  const kids = [h("div", { class: "h2row" }, h("h2", { text: "Narration" }))];
  if (n.message) kids.push(h("p", { class: "note", text: n.message }));
  else {
    kids.push(h("p", { class: "note", text: n.counts }));
    kids.push(h("ul", { class: "narr" }, n.rows.map((r) => h("li", { class: `n-${r.status}` },
      r.file
        ? playToggle(r.file, r.playing, r.id, actions)
        : h("span", { class: "nplay-gap" }),
      h("span", { class: "nid", text: r.id }),
      h("span", { class: "ntx", title: r.full, text: r.text }),
      h("span", { class: `chip ${r.status}`, text: r.chip }),
      r.canOk ? h("button", { type: "button", class: "nok", title: "I've listened: this take is fine", onclick: () => actions.okByJon(r.id, r.takeS) }, "Sounds OK") : null,
      r.canUndoOk ? h("button", { type: "button", class: "nok undo", title: "Remove my OK", onclick: () => actions.undoOk(r.id) }, "Undo") : null,
      r.flag ? h("span", { class: "nflag", text: r.flag }) : null,
      r.notes ? h("span", { class: "nnote", text: r.notes }) : null))));
  }
  return foldable(h("section", { class: "narration", "aria-label": "Narration" }, kids), "Narration");
}

// lineScript/transcript: the film's parsed line script and last good join's transcript (On camera, clip locks).
// onCamera: { estimates, photosOk, ui } for the On camera step (oncamera.onCameraModel).
export function reviewModel({ film, state, layout = "script", making = false, listError = null, cardErrors = new Map(), pending = new Set(), noteFor = null, openError = null, prefError = null, i2v = null, removeFor = null, narration = null, playing = null, paused = false, audio, sa = null, audioUi = {}, mixUi = {}, lineScript = null, transcript = null, transcriptAt, onCamera = {}, part2Ui = {} }) {
  if (openError) return { openFailed: true, dir: openError.dir, title: openError.title, message: `Couldn't open ${openError.title}: ${openError.message}` };
  if (!film) return { noFilm: true };
  const assets = state?.assets ?? [];
  const ordered = orderByScript(assets);
  const shots = ordered.filter((a) => a.kind !== "presenter");
  const oc = onCamera ?? {};
  const cardFor = (a) => cardModel(a, assets, { pending: pending.has(a.id), error: cardErrors.get(a.id) ?? null, i2v, confirmRemove: removeFor === a.id,
    state, transcript, transcriptAt, estimates: oc.estimates ?? null, confirm: oc.ui?.confirm ?? null });
  const onCam = lineScript || state?.presenter?.lines?.length ? {
    ...onCameraModel({ state, lineScript, transcript, estimates: oc.estimates ?? {}, photosOk: !!oc.photosOk, ui: oc.ui ?? {} }),
    // In line-script order (lineIndex is the line script's), not among the b-roll.
    clips: ordered.filter((a) => a.kind === "presenter").sort((a, b) => a.lineIndex - b.lineIndex).map(cardFor),
  } : null;
  return {
    noFilm: false,
    paused: !!playing && !!paused, // a take paused part way: its button shows ▶ to carry on
    title: film.title,
    eyebrow: `${film.title} / Part 2 assets / review`,
    layout: layout === "grid" ? "grid" : "script",
    needsShotList: shots.length === 0,
    preferComfy: !!state?.prefs?.preferComfy,
    preferDisabled: making || pending.size > 0,
    prefError,
    making,
    listError,
    narration: narrationModel(narration, playing),
    audio: audioModel(audio === undefined ? state?.audio : audio, { pending, cardErrors, noteFor, playing, sa, ...audioUi }),
    mix: mixModel({ state, narration, pending, cardErrors, noteFor, playing, settings: mixUi.settings ?? {}, jobs: mixUi.jobs ?? [], ui: mixUi.ui ?? {}, pacingUi: mixUi.pacing ?? {} }),
    summary: summarize(shots), // b-roll only: clips are counted in On camera
    part2: part2Model({ state, ui: part2Ui }),
    noteFor,
    onCamera: onCam,
    cards: shots.map(cardFor),
  };
}

// R13: script paths named in part1_handover.md, in order of appearance, that end .md and mention "script".
const PATTERNS = [
  /`([^`\n]+?\.md)`/gi,
  /"([^"\n]+?\.md)"/gi,
  /\]\(([^)\n]+?\.md)\)/gi,
  /([A-Za-z]:[\\/][^\n`"<>|*?]*?\.md)(?![\w])/gi,
  /(\\\\[^\n`"<>|*?]*?\.md)(?![\w])/gi,
  /([^\s`"'()<>|*?]+\.md)(?![\w])/gi,
];
const FORBIDDEN = "c:\\users\\jon\\youtube video ideas";

export function scriptCandidates(text, dir) {
  const found = [];
  for (const re of PATTERNS) for (const m of String(text ?? "").matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length, path: m[1] });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    lastEnd = f.end;
    const p = f.path.trim().replace(/\//g, "\\").replace(/^\.\\/, "");
    if (!/script/i.test(p)) continue;
    const abs = /^[A-Za-z]:\\/.test(p) || p.startsWith("\\\\") ? p : join(dir, p);
    if (abs.toLowerCase().startsWith(FORBIDDEN)) continue;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

// ---- DOM ----

function thumb(c, actions) {
  const kids = [];
  if (c.file) kids.push(mediaEl(c.file, c.isVideo, actions.preview, `${c.id} take ${c.takes.find((t) => t.pressed)?.n ?? ""}`));
  else kids.push(h("div", { class: "ph", text: c.locked ? c.lockText : c.status ?? "" }));
  kids.push(h("span", { class: "tk", text: c.tag }));
  if (c.overlay) kids.push(h("div", { class: "gen" }, h("span", {}, h("span", { class: "dot live" }), c.overlay)));
  return h("div", { class: "thumb" }, kids);
}

function controls(c, model, actions) {
  if (model.noteFor === c.id) {
    const ta = h("textarea", { id: "note-box", placeholder: "What should change? e.g. darker, slower push-in, no people", "aria-label": `Note for ${c.id}` });
    ta.value = actions.draft();
    ta.addEventListener("input", () => actions.setDraft(ta.value));
    return [ta, h("div", { class: "row" },
      btn(c.clip ? c.clip.redoLabel : "Redo with note", () => actions.redo(c.id, ta.value), { disabled: !c.canRedo || (c.clip && !c.clip.costReady) }),
      btn("Cancel", () => actions.closeNote(), { ghost: true }))];
  }
  const takes = c.takes.length > 1 ? h("div", { class: "takes" }, c.takes.map((t) =>
    h("button", { type: "button", "aria-pressed": String(t.pressed), "aria-label": `Take ${t.n}`, disabled: !c.canPick, onclick: () => actions.choose(c.id, t.n) }, String(t.n)))) : null;
  const sw = c.toolSwitch ? h("div", { class: "toggle tool-switch", role: "group", "aria-label": `Tool for ${c.id}` },
    c.toolSwitch.options.map((o) => h("button", { type: "button", "aria-pressed": String(o.pressed), disabled: c.toolSwitch.disabled,
      onclick: () => { if (!o.pressed) actions.setTool(c.id, o.tool); } }, o.label))) : null;
  const row = [takes];
  if (c.locked) row.push(h("span", { class: "locked", text: c.lockText }));
  else if (c.canMakeFirst || (!c.takes.length && (c.busy || c.pending))) {
    row.push(btn(c.clip ? c.clip.makeLabel : "Make first take", () => actions.first(c.id), { disabled: !c.canMakeFirst || (c.clip && !c.clip.costReady) }));
  }
  else if (c.approved) row.push(h("span", { class: "ok-tag", text: "\u2713 Approved" }), btn("Undo", () => actions.unapprove(c.id), { ghost: true, disabled: !c.canUndo }));
  else row.push(btn("Approve", () => actions.approve(c.id), { disabled: !c.canApprove }), btn("Redo\u2026", () => actions.openNote(c.id), { ghost: true, disabled: !c.canRedo }));
  if (c.can3d) row.push(btn("Make 3D in Blender", () => actions.make3d(c.id), { ghost: true }));
  if (c.showAnimate) {
    const b = btn("Animate with ComfyUI", () => actions.animate(c.id), { ghost: true, disabled: !c.canAnimate });
    if (c.animateWhy) b.setAttribute("title", c.animateWhy);
    row.push(b);
  }
  if (c.file) row.push(btn("Open full size", () => actions.openFull(c.file), { ghost: true }));
  if (c.clip?.voiceover) row.push(btn("Keep anyway", () => actions.keepAnyway(c.id), { ghost: true, disabled: !c.clip.canKeep }));
  if (c.removable && !c.confirmRemove) row.push(btn(c.removeLabel, () => actions.askRemove(c.id), { ghost: true, disabled: !c.canRemove }));
  const confirm = c.confirmRemove ? h("div", { class: "row confirm", role: "group", "aria-label": `Remove ${c.id}` },
    h("span", { text: c.confirmRemove }),
    btn("Remove", () => actions.removeVersion(c.id), { disabled: !c.canRemove }),
    btn("Cancel", () => actions.cancelRemove(), { ghost: true })) : null;
  return [sw, h("div", { class: "row" }, row), confirm];
}

// Blender's own checks on the take: the last still it compared with the drawing, and what each round changed.
function checksBox(k, id, actions) {
  return h("div", { class: "checks3d" },
    k.still ? mediaEl(k.still, false, actions.preview, `${id} take ${k.take} last check`) : null,
    h("ul", {}, k.notes.map((n) => h("li", { title: n.full }, h("b", { text: `${n.label}: ` }), n.text))));
}

export function card(c, model, actions) {
  const cls = `card${c.approved ? " ok" : ""}${c.busy ? " gen" : ""}`;
  return h("article", { class: cls },
    thumb(c, actions),
    h("div", { class: "cb" },
      h("div", { class: "d", text: c.desc }),
      model.layout === "grid" ? h("div", { class: "hist" }, h("q", { text: c.line })) : null,
      c.sourceId ? h("div", { class: "src" },
        c.sourceFile ? mediaEl(c.sourceFile, isVideo(c.sourceFile), actions.preview, `${c.sourceId} source`) : null,
        h("span", { text: `From ${c.sourceId}` })) : null,
      c.checks ? checksBox(c.checks, c.id, actions) : null,
      c.conflict ? h("div", { class: "cnote", text: c.conflict }) : null,
      c.clip?.stale ? h("div", { class: "cnote", text: c.clip.stale }) : null,
      c.clip?.voiceover ? h("div", { class: "cnote", text: c.clip.voiceover }) : null,
      c.history.length ? h("div", { class: "hist" }, "History: ", c.history.join("; ")) : null,
      c.pending ? h("div", { class: "hist", text: "Working\u2026" }) : null,
      c.error ? h("div", { class: "err", text: c.error }) : null,
      controls(c, model, actions)));
}

const onCameraEl = (model, actions) => (model.onCamera ? [onCameraSection(model.onCamera, actions, (c) => card(c, model, actions))] : []);

export function render(el, model, actions) {
  if (model.openFailed) {
    el.replaceChildren(h("h1", { text: model.title }), h("div", { class: "panel warn" },
      h("p", { text: model.message }), btn("Try again", () => actions.reopen(model.dir))));
    return;
  }
  if (model.noFilm) {
    el.replaceChildren(h("h1", { text: "Review" }), h("p", { class: "lede", text: "Open a film's review from Films." }));
    return;
  }
  const pref = h("input", { type: "checkbox", id: "prefer-comfy", disabled: model.preferDisabled });
  pref.checked = model.preferComfy;
  // If the change was refused or failed, put the box back to what the film says.
  pref.addEventListener("change", () => {
    Promise.resolve(actions.setPreferComfy(pref.checked)).then((ok) => { if (!ok) pref.checked = model.preferComfy; });
  });
  const head = [
    h("span", { class: "eyebrow", text: model.eyebrow }),
    h("h1", { style: { marginTop: "8px" }, text: model.title }),
    h("p", { class: "lede", text: "Pick a take, approve it, or redo anything with a note." }),
    h("label", { class: "pref", for: "prefer-comfy" }, pref, h("span", { text: "Prefer ComfyUI for b-roll" })),
    model.prefError ? h("p", { class: "err", text: model.prefError }) : null,
    // The prompter bar sticks at the top while Jon scrolls (shown once a voiceover is joined).
    model.mix?.pacing && actions.prompter ? actions.prompter(model.mix.pacing) : null,
  ].filter(Boolean);
  if (model.needsShotList) {
    el.replaceChildren(...head, ...(model.narration ? [narrationSection(model.narration, actions)] : []), ...audioSections(model.audio, actions), mixSection(model.mix, actions),
      ...onCameraEl(model, actions),
      foldable(h("section", { class: "broll", "aria-label": "B-roll" }, h("div", { class: "h2row" }, h("h2", { text: "B-roll" })), h("div", { class: "panel" },
      h("p", { text: "This film has no shot list yet. Claude reads the script and part1_handover.md and plans the b-roll." }),
      btn(model.making ? "Making the shot list\u2026" : "Make shot list", () => actions.makeShotList(), { disabled: model.making }),
      model.listError ? h("p", { class: "err", text: model.listError }) : null)), "B-roll"));
    return;
  }
  const s = model.summary;
  const p2 = model.part2;
  // The steps or the opening message make the bar tall: it stops sticking then.
  const sum = h("div", { class: `sum${p2 && (p2.steps || p2.done?.message) ? " tall" : ""}` },
    h("div", {}, h("div", { class: "big", text: `${s.approved} / ${s.total}` }), h("div", { class: "lbl", text: "Approved" })),
    h("div", {}, h("div", { class: "big", text: String(s.regenerating) }), h("div", { class: "lbl", text: "Regenerating" })),
    p2 ? part2Bar(p2, actions) : null);
  const toggle = h("div", { class: "toggle", role: "group", "aria-label": "Layout" },
    ["script", "grid"].map((v) => h("button", { type: "button", "aria-pressed": String(model.layout === v), onclick: () => actions.setLayout(v) }, v === "script" ? "Script order" : "Grid")));
  const body = model.layout === "grid"
    ? h("div", { class: "cards" }, model.cards.map((c) => card(c, model, actions)))
    : h("div", { class: "script" }, model.cards.map((c) => h("div", { class: "shot" }, h("blockquote", { class: "line", text: c.line }), card(c, model, actions))));
  el.replaceChildren(...head, ...(model.narration ? [narrationSection(model.narration, actions)] : []), ...audioSections(model.audio, actions), mixSection(model.mix, actions),
    ...onCameraEl(model, actions), sum,
    foldable(h("section", { class: "broll", "aria-label": "B-roll" }, h("div", { class: "h2row" }, h("h2", { text: "B-roll" }), toggle), body), "B-roll"));
}
