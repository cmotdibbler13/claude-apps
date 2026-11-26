// Review view, b-roll section: shot cards in script order (or a grid), takes, approve, redo with a note.
import { h, btn, toolLabel, mediaEl } from "./dom.js";
import { orderByScript } from "../shots.js";
import { canStart } from "../redo.js";
import { join } from "../paths.js";
import { countsLine, STATUS_LABEL, NO_LINE_SCRIPT } from "../narration.js";

const busyTake = (t) => t.status === "queued" || t.status === "running";
const isBusy = (a) => a.takes.some(busyTake);
const VIDEO_EXT = /\.(mp4|mov|webm|mkv)$/i;
export const isVideo = (file) => VIDEO_EXT.test(String(file ?? ""));
const BROLL_TOOLS = ["higgsfield", "comfyui"];
const chosenOf = (a) => a?.takes.find((t) => t.n === a.chosen) ?? null;

export function summarize(assets = []) {
  return { approved: assets.filter((a) => a.approved).length, total: assets.length, regenerating: assets.filter(isBusy).length };
}

export function cardModel(asset, assets, { pending = false, error = null } = {}) {
  const chosen = chosenOf(asset);
  const busy = isBusy(asset);
  const locked = !canStart(asset, assets);
  const running = asset.takes.find(busyTake);
  const runTool = running?.tool ?? asset.tool;
  const tool = toolLabel(running ? runTool : asset.tool);
  const free = !busy && !pending;
  let status = null;
  if (!asset.takes.length) status = locked ? null : "No take yet";
  else if (chosen?.status === "failed" || chosen?.status === "interrupted") status = `Take ${chosen.n} failed: ${chosen.error ?? "no reason given"}`;
  const src = asset.tool === "blender" ? assets.find((a) => a.id === asset.sourceId) : null;
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
    lockText: locked ? `Approve ${asset.sourceId} first` : null,
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
    error,
  };
}

const SNIP = 60;
const snip = (t) => (t.length > SNIP ? `${t.slice(0, SNIP).trimEnd()}\u2026` : t);

// narration: null (not looked yet), {missingScript:true}, or narrationStatus() output.
export function narrationModel(n) {
  if (!n) return null;
  if (n.missingScript) return { message: NO_LINE_SCRIPT, counts: null, rows: [] };
  return {
    message: null,
    counts: countsLine(n.counts),
    rows: n.rows.map((r) => ({ id: r.id, text: snip(r.text), full: r.text, status: r.status, chip: STATUS_LABEL[r.status], flag: r.flags.join("; "), notes: r.notes.join("; ") })),
  };
}

function narrationSection(n) {
  const kids = [h("div", { class: "h2row" }, h("h2", { text: "Narration" }))];
  if (n.message) kids.push(h("p", { class: "note", text: n.message }));
  else {
    kids.push(h("p", { class: "note", text: n.counts }));
    kids.push(h("ul", { class: "narr" }, n.rows.map((r) => h("li", { class: `n-${r.status}` },
      h("span", { class: "nid", text: r.id }),
      h("span", { class: "ntx", title: r.full, text: r.text }),
      h("span", { class: `chip ${r.status}`, text: r.chip }),
      r.flag ? h("span", { class: "nflag", text: r.flag }) : null,
      r.notes ? h("span", { class: "nnote", text: r.notes }) : null))));
  }
  return h("section", { class: "narration", "aria-label": "Narration" }, kids);
}

export function reviewModel({ film, state, layout = "script", making = false, listError = null, cardErrors = new Map(), pending = new Set(), noteFor = null, openError = null, prefError = null, narration = null }) {
  if (openError) return { openFailed: true, dir: openError.dir, title: openError.title, message: `Couldn't open ${openError.title}: ${openError.message}` };
  if (!film) return { noFilm: true };
  const assets = state?.assets ?? [];
  const ordered = orderByScript(assets);
  return {
    noFilm: false,
    title: film.title,
    eyebrow: `${film.title} / Part 2 assets / review`,
    layout: layout === "grid" ? "grid" : "script",
    needsShotList: assets.length === 0,
    preferComfy: !!state?.prefs?.preferComfy,
    preferDisabled: making || pending.size > 0,
    prefError,
    making,
    listError,
    narration: narrationModel(narration),
    summary: summarize(assets),
    noteFor,
    cards: ordered.map((a) => cardModel(a, assets, { pending: pending.has(a.id), error: cardErrors.get(a.id) ?? null })),
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
      btn("Redo with note", () => actions.redo(c.id, ta.value), { disabled: !c.canRedo }),
      btn("Cancel", () => actions.closeNote(), { ghost: true }))];
  }
  const takes = c.takes.length > 1 ? h("div", { class: "takes" }, c.takes.map((t) =>
    h("button", { type: "button", "aria-pressed": String(t.pressed), "aria-label": `Take ${t.n}`, disabled: !c.canPick, onclick: () => actions.choose(c.id, t.n) }, String(t.n)))) : null;
  const sw = c.toolSwitch ? h("div", { class: "toggle tool-switch", role: "group", "aria-label": `Tool for ${c.id}` },
    c.toolSwitch.options.map((o) => h("button", { type: "button", "aria-pressed": String(o.pressed), disabled: c.toolSwitch.disabled,
      onclick: () => { if (!o.pressed) actions.setTool(c.id, o.tool); } }, o.label))) : null;
  const row = [takes];
  if (c.locked) row.push(h("span", { class: "locked", text: c.lockText }));
  else if (c.canMakeFirst || (!c.takes.length && (c.busy || c.pending))) row.push(btn("Make first take", () => actions.first(c.id), { disabled: !c.canMakeFirst }));
  else if (c.approved) row.push(h("span", { class: "ok-tag", text: "\u2713 Approved" }), btn("Undo", () => actions.unapprove(c.id), { ghost: true, disabled: !c.canUndo }));
  else row.push(btn("Approve", () => actions.approve(c.id), { disabled: !c.canApprove }), btn("Redo\u2026", () => actions.openNote(c.id), { ghost: true, disabled: !c.canRedo }));
  if (c.file) row.push(btn("Open full size", () => actions.openFull(c.file), { ghost: true }));
  return [sw, h("div", { class: "row" }, row)];
}

function card(c, model, actions) {
  const cls = `card${c.approved ? " ok" : ""}${c.busy ? " gen" : ""}`;
  return h("article", { class: cls },
    thumb(c, actions),
    h("div", { class: "cb" },
      h("div", { class: "d", text: c.desc }),
      model.layout === "grid" ? h("div", { class: "hist" }, h("q", { text: c.line })) : null,
      c.sourceId ? h("div", { class: "src" },
        c.sourceFile ? mediaEl(c.sourceFile, isVideo(c.sourceFile), actions.preview, `${c.sourceId} source`) : null,
        h("span", { text: `From ${c.sourceId}` })) : null,
      c.history.length ? h("div", { class: "hist" }, "History: ", c.history.join("; ")) : null,
      c.pending ? h("div", { class: "hist", text: "Working\u2026" }) : null,
      c.error ? h("div", { class: "err", text: c.error }) : null,
      controls(c, model, actions)));
}

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
  ].filter(Boolean);
  if (model.needsShotList) {
    el.replaceChildren(...head, model.narration ? narrationSection(model.narration) : null, h("div", { class: "panel" },
      h("p", { text: "This film has no shot list yet. Claude reads the script and part1_handover.md and plans the b-roll." }),
      btn(model.making ? "Making the shot list\u2026" : "Make shot list", () => actions.makeShotList(), { disabled: model.making }),
      model.listError ? h("p", { class: "err", text: model.listError }) : null));
    return;
  }
  const s = model.summary;
  const sum = h("div", { class: "sum" },
    h("div", {}, h("div", { class: "big", text: `${s.approved} / ${s.total}` }), h("div", { class: "lbl", text: "Approved" })),
    h("div", {}, h("div", { class: "big", text: String(s.regenerating) }), h("div", { class: "lbl", text: "Regenerating" })));
  const toggle = h("div", { class: "toggle", role: "group", "aria-label": "Layout" },
    ["script", "grid"].map((v) => h("button", { type: "button", "aria-pressed": String(model.layout === v), onclick: () => actions.setLayout(v) }, v === "script" ? "Script order" : "Grid")));
  const body = model.layout === "grid"
    ? h("div", { class: "cards" }, model.cards.map((c) => card(c, model, actions)))
    : h("div", { class: "script" }, model.cards.map((c) => h("div", { class: "shot" }, h("blockquote", { class: "line", text: c.line }), card(c, model, actions))));
  el.replaceChildren(...head, model.narration ? narrationSection(model.narration) : null, sum, h("div", { class: "h2row" }, h("h2", { text: "B-roll" }), toggle), body);
}
