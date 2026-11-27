// Review, On camera step: the lines Jon says to camera, the look, the portraits and the clips (one card per line).
import { h, btn, mediaEl } from "./dom.js";
import { foldable } from "./fold.js";
import { photoPicker } from "./photopick.js";
import { scriptCameraIds, cameraLineState, lineLengthS, MAX_CLIP_S, TOO_LONG } from "../presenter.js";

export const FROM_LABEL = { script: "from the script", claude: "suggested", jon: "added by you" };
export const NOT_IN_SCRIPT = "Not in the script any more";
export const NEED_PHOTOS = "Add one or two photos of you first";
export const NO_LOOK = "Choose an outfit and a set first";
export const PRESS_AGAIN = "Press again to spend credits";
export const STALE_PORTRAIT = "Made with an earlier portrait";
export const ON_CAMERA = "This line is on camera";
export const OWN = "\u0000own"; // the "your own" radio's value
const PORTRAITS_A_PRESS = 2;

const filled = (v) => typeof v === "string" && v.trim() !== "";
const busyTake = (t) => t.status === "queued" || t.status === "running";
const fmt = (n) => String(Math.round(n * 10) / 10);
const SNIP = 70;
const snip = (t) => (t.length > SNIP ? `${t.slice(0, SNIP).trimEnd()}…` : t);

// est: a number of credits, null (the estimate failed) or undefined (still being fetched).
export function costLabel(what, est, confirming) {
  if (confirming) return PRESS_AGAIN;
  if (est === undefined) return `${what} (getting the cost…)`;
  if (est === null) return `${what} (cost unknown)`;
  return `${what} (≈${fmt(est)} credits)`;
}

// Whether a paid press goes ahead. With no estimate, the first press only asks (confirm = key), the second goes.
export function costPress(est, confirm, key) {
  if (typeof est === "number") return { go: true, confirm: null };
  if (est === null) return confirm === key ? { go: true, confirm: null } : { go: false, confirm: key };
  return { go: false, confirm: confirm ?? null };
}

function lookModel(state, ui) {
  const saved = state?.presenter?.look && filled(state.presenter.look.outfit) && filled(state.presenter.look.set)
    ? { outfit: state.presenter.look.outfit, set: state.presenter.look.set } : null;
  const last = ui.lastLook ?? null;
  const pick = { outfit: ui.lookPick?.outfit ?? saved?.outfit ?? last?.outfit ?? null, set: ui.lookPick?.set ?? saved?.set ?? last?.set ?? null };
  const own = ui.own ?? {};
  const options = (k) => {
    const out = [];
    const add = (value, label) => { if (filled(value) && !out.some((o) => o.value === value)) out.push({ value, label, checked: pick[k] === value }); };
    if (saved) add(saved[k], saved[k]);
    if (last) add(last[k], `${last[k]} (last film)`);
    for (const v of ui.looks?.[k === "outfit" ? "outfits" : "sets"] ?? []) add(v, v);
    return out;
  };
  const chosenOf = (k) => (pick[k] === OWN ? (filled(own[k]) ? own[k].trim() : null) : pick[k]);
  const chosen = { outfit: chosenOf("outfit"), set: chosenOf("set") };
  const same = saved && chosen.outfit === saved.outfit && chosen.set === saved.set;
  return {
    outfits: options("outfit"),
    sets: options("set"),
    own: { outfit: { text: own.outfit ?? "", checked: pick.outfit === OWN }, set: { text: own.set ?? "", checked: pick.set === OWN } },
    chosen,
    saved,
    canSave: filled(chosen.outfit) && filled(chosen.set) && !same && !ui.lookSaving,
    suggesting: !!ui.suggestingLooks,
    error: ui.lookError ?? null,
  };
}

export function onCameraModel({ state, lineScript = null, transcript = null, estimates = {}, photosOk = false, ui = {} }) {
  const script = lineScript?.lines ?? [];
  const lines = cameraLineState(state ?? { assets: [] }, lineScript).map((r) => {
    const len = lineLengthS(transcript, r.id);
    const sl = script.find((l) => l.id === r.id);
    return {
      id: r.id, text: r.text, section: sl?.section ?? "", from: r.from, fromLabel: FROM_LABEL[r.from] ?? "", missing: r.missing, assetId: r.assetId,
      note: r.missing ? NOT_IN_SCRIPT : len != null && len > MAX_CLIP_S ? TOO_LONG : null,
      lengthText: len != null ? `${len.toFixed(1)} s` : null,
    };
  });
  const chosen = new Set(lines.map((l) => l.id));
  const holder = state?.presenter?.portraits;
  const portrait = state?.presenter?.portrait ?? null;
  const look = lookModel(state, ui);
  const running = (holder?.takes ?? []).some(busyTake) || !!ui.portraitPending;

  const what = "Make portraits";
  const est = typeof estimates.portrait === "number" ? estimates.portrait * PORTRAITS_A_PRESS : estimates.portrait;
  let pb;
  if (running) pb = { label: "Making portraits…", enabled: false, why: null };
  else if (!look.saved) pb = { label: what, enabled: false, why: photosOk ? NO_LOOK : NEED_PHOTOS };
  else pb = { label: costLabel(what, est, ui.confirm === "PORTRAIT"), enabled: !!photosOk && est !== undefined, why: photosOk ? null : NEED_PHOTOS };

  return {
    hasScript: !!lineScript,
    lines,
    canSuggest: !!lineScript && scriptCameraIds(lineScript).length === 0,
    suggesting: !!ui.suggesting,
    suggestions: (ui.suggestions ?? []).map((s) => ({ id: s.id, why: s.why ?? "", text: script.find((l) => l.id === s.id)?.text ?? "", ticked: chosen.has(s.id) })),
    addOptions: script.filter((l) => !chosen.has(l.id)).map((l) => ({ id: l.id, label: `${l.id} ${snip(l.text)}` })),
    lineError: ui.lineError ?? null,
    linesBusy: !!ui.linesBusy,
    look,
    portraits: (holder?.takes ?? []).map((t) => {
      const done = t.status === "done" && !!t.file;
      const approved = portrait?.n === t.n;
      return {
        n: t.n, file: done ? t.file : null, approved,
        canApprove: done && !!t.hfId && !approved && !ui.approving,
        status: done ? null : t.status === "failed" || t.status === "interrupted" ? `Failed: ${t.error ?? "no reason given"}` : t.status === "running" ? "Making…" : "Queued",
      };
    }),
    approvedN: portrait?.n ?? null,
    portraitError: ui.portraitError ?? null,
    photosError: ui.photosError ?? null,
    buttons: { portraits: pb },
  };
}

// ---- DOM ----

function linesBlock(m, actions) {
  const kids = [];
  if (!m.lines.length) kids.push(h("p", { class: "note", text: "No lines chosen yet." }));
  else kids.push(h("ul", { class: "oclines" }, m.lines.map((l) => {
    const box = h("input", { type: "checkbox", "aria-label": `Say ${l.id} to camera`, disabled: m.linesBusy });
    box.checked = true;
    box.addEventListener("change", () => actions.toggleLine(l.id, !!box.checked));
    return h("li", { class: l.note ? "warn" : "" },
      h("label", { class: "octick" }, box, h("span", { class: "nid", text: l.id })),
      h("span", { class: "octx", text: l.text }),
      h("span", { class: "ocmeta", text: [l.fromLabel, l.section, l.lengthText].filter(Boolean).join(" · ") }),
      l.note ? h("span", { class: "ocwarn", text: l.note }) : null);
  })));
  if (m.canSuggest) {
    kids.push(h("div", { class: "row" }, btn(m.suggesting ? "Suggesting…" : "Suggest lines", () => actions.suggestLines(), { ghost: true, disabled: m.suggesting })));
  }
  if (m.suggestions.length) {
    kids.push(h("ul", { class: "oclines sugg", "aria-label": "Suggested lines" }, m.suggestions.map((s) => {
      const box = h("input", { type: "checkbox", "aria-label": `Use ${s.id}`, disabled: m.linesBusy });
      box.checked = s.ticked;
      box.addEventListener("change", () => actions.toggleLine(s.id, !!box.checked, "claude"));
      return h("li", {}, h("label", { class: "octick" }, box, h("span", { class: "nid", text: s.id })),
        h("span", { class: "octx", text: s.text }), h("span", { class: "ocmeta", text: s.why }));
    })));
  }
  if (m.addOptions.length) {
    const sel = h("select", { id: "oc-add", "aria-label": "Add a line", disabled: m.linesBusy },
      h("option", { value: "", text: "Add a line…" }), m.addOptions.map((o) => h("option", { value: o.id, text: o.label })));
    sel.addEventListener("change", () => { if (sel.value) actions.addLine(sel.value); });
    kids.push(h("div", { class: "row ocadd" }, sel));
  }
  if (m.lineError) kids.push(h("p", { class: "err", text: m.lineError }));
  return kids;
}

function lookGroup(kind, title, opts, own, actions) {
  const name = `oc-${kind}`;
  const radio = (value, checked, label) => {
    const r = h("input", { type: "radio", name, value: value === OWN ? "own" : value });
    r.checked = checked;
    r.addEventListener("change", () => { if (r.checked) actions.pickLook(kind, value); });
    return h("label", { class: "ocopt" }, r, label);
  };
  const text = h("input", { type: "text", id: `oc-own-${kind}`, placeholder: "Your own", "aria-label": `Your own ${kind}` });
  text.value = own.text;
  text.addEventListener("input", () => actions.setOwnLook(kind, text.value));
  return h("fieldset", { class: "oclook" }, h("legend", { text: title }),
    opts.map((o) => radio(o.value, o.checked, h("span", { text: o.label }))),
    radio(OWN, own.checked, text));
}

function lookBlock(m, actions) {
  const L = m.look;
  return [
    h("div", { class: "h3row" }, h("h3", { text: "Look" }),
      btn(L.suggesting ? "Suggesting…" : "Suggest looks", () => actions.suggestLooks(), { ghost: true, disabled: L.suggesting })),
    h("div", { class: "oclooks" }, lookGroup("outfit", "Outfit", L.outfits, L.own.outfit, actions), lookGroup("set", "Set", L.sets, L.own.set, actions)),
    h("div", { class: "row" }, btn("Use this look", () => actions.saveLook(), { ghost: true, disabled: !L.canSave }),
      L.saved ? h("span", { class: "ocmeta", text: `Look: ${L.saved.outfit}; ${L.saved.set}` }) : null),
    L.error ? h("p", { class: "err", text: L.error }) : null,
  ];
}

function portraitsBlock(m, actions) {
  const b = m.buttons.portraits;
  return [
    h("div", { class: "row" }, btn(b.label, () => actions.makePortraits(), { disabled: !b.enabled }),
      b.why ? h("span", { class: "locked", text: b.why }) : null,
      b.why === NEED_PHOTOS && actions.choosePhotos ? photoPicker("Choose presenter photos…", (files) => actions.choosePhotos(files)) : null),
    m.photosError ? h("p", { class: "err", text: m.photosError }) : null,
    m.portraitError ? h("p", { class: "err", text: m.portraitError }) : null,
    m.portraits.length ? h("div", { class: "ocportraits" }, m.portraits.map((p) => h("figure", { class: `ocp${p.approved ? " ok" : ""}` },
      h("div", { class: "thumb" }, p.file ? mediaEl(p.file, false, actions.preview, `Portrait ${p.n}`) : h("div", { class: "ph", text: p.status }),
        h("span", { class: "tk", text: `Portrait ${p.n}` })),
      h("figcaption", {}, p.approved ? h("span", { class: "ok-tag", text: "✓ Approved" })
        : btn("Approve", () => actions.approvePortrait(p.n), { ghost: true, disabled: !p.canApprove }))))) : null,
  ];
}

// renderCard(c): the review's shot card for one clip.
export function onCameraSection(m, actions, renderCard = () => null) {
  const kids = [h("div", { class: "h2row" }, h("h2", { text: "On camera" }))];
  if (!m.hasScript && !m.lines.length) {
    kids.push(h("p", { class: "note", text: "No line script found, so no lines to choose from." }));
  } else {
    kids.push(h("div", { class: "panel oncam" },
      h("h3", { text: "Lines" }), ...linesBlock(m, actions),
      ...lookBlock(m, actions),
      h("h3", { text: "Portrait" }), ...portraitsBlock(m, actions)));
    const clips = m.clips ?? [];
    if (clips.length) kids.push(h("div", { class: "cards occlips" }, clips.map((c) => renderCard(c))));
  }
  return foldable(h("section", { class: "oncamera", "aria-label": "On camera" }, kids), "On camera");
}

export function render(el, model, actions) {
  el.replaceChildren(onCameraSection(model, actions, actions.card));
}
