// Review, Part 1 step: the script Claude wrote, its numbers and warnings, drafts, per-clip edits and redos,
// the lists, the to-camera lines, the episode, and Approve Part 1.
import { h, btn } from "./dom.js";
import { foldable } from "./fold.js";
import { scriptStats, scriptWarnings, scriptLines, clipList, mmss, NOTE_HEADINGS } from "../part1script.js";

export const WRITING = "Writing… (about a minute)";
export const NO_DRAFT = "Write the script first.";
export const WAIT = "Wait for Claude to finish.";
export const NO_EPISODE = "Add the episode number.";
export const APPROVE = "Approve Part 1";
export const APPROVING = "Approving…";
const FROM = { claude: "suggested", jon: "added by you" };
const two = (n) => String(n).padStart(2, "0");

// The list editors: which fields each row has, and whether rows can be added or removed.
export const LISTS = {
  pronunciations: { title: "Pronunciation notes", fields: [["name", "Name"], ["say", "Say"]], addable: true, blank: { name: "", say: "" } },
  sfx: { title: "Sound effects", fields: [["cue", "Cue"], ["clip", "Clip"], ["idea", "Idea"]], addable: true, blank: { cue: "", clip: "", idea: "" } },
  shots: { title: "Shot list", fields: [["id", "Shot", true], ["usedIn", "Used in", true], ["prompt", "Prompt"]], addable: false },
};

// The rows as the editor shows them (all text).
export function listRows(kind, items = []) {
  return (items ?? []).map((x) => (kind === "shots"
    ? { id: x.id ?? "", usedIn: (x.usedIn ?? []).map(two).join(", "), prompt: x.prompt ?? "" }
    : kind === "sfx" ? { cue: x.cue ?? "", clip: x.clip == null ? "" : two(x.clip), idea: x.idea ?? "" }
      : { name: x.name ?? "", say: x.say ?? "" }));
}

// The editor's rows back into the script's shape (shots keep their id and usedIn). Throws with a plain message.
export function listFromRows(kind, rows, { script } = {}) {
  const clips = clipList(script).length;
  const keep = (r) => Object.values(r).some((v) => String(v ?? "").trim());
  if (kind === "pronunciations") {
    return rows.filter(keep).map((r, i) => {
      const name = String(r.name ?? "").trim(), say = String(r.say ?? "").trim();
      if (!name || !say) throw new Error(`Pronunciation ${i + 1}: add both the name and how to say it.`);
      return { name, say };
    });
  }
  if (kind === "sfx") {
    return rows.filter(keep).map((r, i) => {
      const clip = Number(String(r.clip ?? "").trim());
      if (!Number.isInteger(clip) || clip < 1 || clip > clips) throw new Error(`Sound effect ${i + 1}: the clip is a number from 01 to ${two(clips)}.`);
      return { cue: String(r.cue ?? "").trim(), clip, idea: String(r.idea ?? "").trim() };
    });
  }
  const old = script?.shots ?? [];
  return old.map((s, i) => ({ ...s, prompt: String(rows[i]?.prompt ?? s.prompt ?? "").trim() }));
}

function draftLabel(d, i, len) {
  const why = d.note ? `from your note "${d.note}"` : d.why ?? "";
  return `Draft ${i + 1} of ${len}${why ? ` (${why})` : ""}`;
}

export const nextStepText = (prefix) =>
  `Record every line in Autocue Studio (Load script → ${prefix}_line_script.txt). The narration list below fills in as takes arrive.`;

// state: the film's state (state.part1). busy: a Claude call or another Part 1 change is running for this film.
// ui: what is open in the step (a clip edit, a note box, a list editor, the episode box) and anything typed there.
export function part1Model({ state, settings = {}, busy = false, error = null, ui = {} } = {}) {
  const p = state?.part1 ?? {};
  const setup = p.setup ?? {};
  const drafts = p.drafts ?? [];
  const draft = drafts.at(-1) ?? null;
  const script = draft?.script ?? null;
  const approved = !!p.approvedAt;
  const stats = script ? scriptStats(script, settings) : null;
  const warnings = stats ? scriptWarnings(stats, setup.runtime) : [];
  const lines = script ? scriptLines(script) : [];
  const picks = p.picks ?? [];
  const pickIds = new Set(picks.map((x) => x.id));
  const byId = new Map(lines.map((l) => [l.id, l]));

  let n = 0;
  const sections = (script?.sections ?? []).map((s, si) => {
    const t = stats.sectionTimes[si] ?? { startS: 0, endS: 0 };
    return {
      heading: `SECTION ${si + 1} — ${String(s?.name ?? "").toUpperCase()} (about ${mmss(t.startS)}–${mmss(t.endS)})`,
      clips: (s?.clips ?? []).map((c) => {
        n += 1;
        const ids = lines.filter((l) => l.clip === n).map((l) => l.id);
        return { n, num: two(n), narration: c?.narration ?? "", spoken: c?.spoken ?? "", cue: c?.cue ?? "", delivery: c?.delivery ?? null, ids, picked: ids.filter((id) => pickIds.has(id)) };
      }),
    };
  });

  const episode = String(setup.episode ?? "").trim();
  let approveWhy = null;
  if (busy) approveWhy = WAIT;
  else if (!draft) approveWhy = NO_DRAFT;
  else if (!episode) approveWhy = NO_EPISODE;

  return {
    hasDraft: !!draft,
    title: script?.title ?? setup.topic ?? "",
    stats,
    expectedS: stats ? stats.expectedS : null,
    numbers: stats ? `${mmss(stats.rawS)} est · ${mmss(stats.expectedS)} expected · ${stats.words} words · ${stats.clips} clips · ${stats.sections} sections` : null,
    runtime: setup.runtime ?? "",
    warnings,
    busy: !!busy,
    // Only a quick edit this review is running locks the step without the Writing… line; a call already
    // running when Jon came back to the film (ui fresh, not running) shows it.
    busyText: busy && !(ui.running && ui.writing === false) ? WRITING : null,
    error: error ?? null,
    draft: draft ? draftLabel(draft, drafts.length - 1, drafts.length) : null,
    drafts: drafts.map((d, i) => ({ n: d.n, label: draftLabel(d, i, drafts.length), current: i === drafts.length - 1 })),
    draftsOpen: !!ui.draftsOpen,
    sections,
    pronunciations: script?.pronunciations ?? [],
    sfx: script?.sfx ?? [],
    shots: script?.shots ?? [],
    music: script?.music ?? null,
    notes: NOTE_HEADINGS.map(([k, heading]) => ({ heading, items: script?.notes?.[k] ?? [] })).filter((x) => x.items.length),
    picks: picks.map((x) => ({ id: x.id, text: byId.get(x.id)?.text ?? x.text, from: FROM[x.from] ?? "" })),
    pickNotes: p.pickNotes ?? [],
    addable: lines.filter((l) => !pickIds.has(l.id)).map((l) => ({ id: l.id, text: l.text })),
    addLine: ui.addLine ?? "",
    episode,
    canApprove: !approved && approveWhy === null && !ui.approving,
    approveLabel: ui.approving ? APPROVING : APPROVE,
    approveWhy: approved ? null : approveWhy,
    approved,
    nextStep: approved ? nextStepText(setup.prefix ?? "") : null,
    openItems: approved ? ui.openItems ?? [] : [],
    editing: ui.editing ?? null,
    redo: ui.redo ?? null,
    revise: ui.revise ?? null,
    list: ui.list ?? null,
    episodeEdit: ui.episode ?? null,
  };
}

// ---- DOM ----

function textBox(id, value, label, onInput, rows = 3) {
  const ta = h("textarea", { id, rows: String(rows), "aria-label": label });
  ta.value = value ?? "";
  ta.addEventListener("input", () => onInput(ta.value));
  return ta;
}

function textInput(id, value, label, onInput, o = {}) {
  const el = h("input", { type: "text", id, "aria-label": label, ...o });
  el.value = value ?? "";
  el.addEventListener("input", () => onInput(el.value));
  return el;
}

function noteBox(id, value, label, placeholder, onInput, onGo, goLabel, onCancel, disabled) {
  const ta = textBox(id, value, label, onInput, 2);
  ta.setAttribute("placeholder", placeholder);
  return h("div", { class: "p1note" }, ta, h("div", { class: "row" },
    btn(goLabel, () => onGo(ta.value), { disabled: disabled || !String(value ?? "").trim() }),
    btn("Cancel", onCancel, { ghost: true })));
}

function clipEl(c, m, a) {
  const free = !m.busy;
  const e = m.editing?.n === c.n ? m.editing : null;
  const r = m.redo?.n === c.n ? m.redo : null;
  const ids = h("div", { class: "p1ids" }, c.ids.map((id) => h("span", { class: `p1id${c.picked.includes(id) ? " cam" : ""}` }, id, c.picked.includes(id) ? " ● to camera" : "")));
  let body;
  if (e) {
    body = h("div", { class: "p1edit" },
      h("label", { for: `p1-nar-${c.n}`, text: "Reading script" }), textBox(`p1-nar-${c.n}`, e.narration, `Reading words for clip ${c.num}`, (v) => a.editField("narration", v)),
      h("label", { for: `p1-spo-${c.n}`, text: "Spoken (numbers in words)" }), textBox(`p1-spo-${c.n}`, e.spoken, `Spoken words for clip ${c.num}`, (v) => a.editField("spoken", v)),
      h("label", { for: `p1-cue-${c.n}`, text: "Visual cue" }), textBox(`p1-cue-${c.n}`, e.cue, `Visual cue for clip ${c.num}`, (v) => a.editField("cue", v), 2),
      h("div", { class: "row" }, btn("Save", () => a.saveClip(), { disabled: !free }), btn("Cancel", () => a.closeClip(), { ghost: true })));
  } else {
    body = [
      h("p", { class: "p1nar", text: c.narration }),
      c.delivery ? h("p", { class: "p1del", text: c.delivery }) : null,
      h("p", { class: "p1cue", text: `[${c.cue}]` }),
      r ? noteBox(`p1-redo-${c.n}`, r.note, `Note for clip ${c.num}`, "What should change in this clip?", (v) => a.redoNote(v),
        (v) => a.redo(c.n, v), "Redo", () => a.closeClip(), !free)
        : m.approved ? null : h("div", { class: "row" },
          btn("Edit", () => a.openEdit(c.n), { ghost: true, disabled: !free }),
          btn("Redo with a note…", () => a.openRedo(c.n), { ghost: true, disabled: !free })),
    ];
  }
  return h("li", { class: "p1clip" }, h("span", { class: "p1n", text: c.num }), h("div", { class: "p1body" }, body, ids));
}

function listEl(kind, m, a) {
  const cfg = LISTS[kind];
  const items = m[kind];
  const ed = m.list?.kind === kind ? m.list : null;
  const free = !m.busy && !m.approved;
  const head = h("div", { class: "h3row" }, h("h3", { text: cfg.title }),
    !ed && !m.approved ? btn(cfg.addable ? "Edit or add" : "Edit prompts", () => a.openList(kind), { ghost: true, disabled: !free || !!m.list }) : null);
  if (ed) {
    const rows = ed.rows.map((r, i) => h("li", { class: `p1lrow k-${kind}` },
      cfg.fields.map(([f, label, ro]) => (ro
        ? h("span", { class: "p1ro", text: r[f] })
        : textInput(`p1-l-${kind}-${i}-${f}`, r[f], `${label} ${i + 1}`, (v) => a.listField(i, f, v), { placeholder: label }))),
      cfg.addable ? btn("Remove", () => a.listRemove(i), { ghost: true }) : null));
    return [head, h("ul", { class: "p1list" }, rows), h("div", { class: "row" },
      cfg.addable ? btn("+ Add", () => a.listAdd(), { ghost: true }) : null,
      btn("Save", () => a.saveList(), { disabled: m.busy }), btn("Cancel", () => a.closeList(), { ghost: true }))];
  }
  if (!items.length) return [head, h("p", { class: "note", text: "None yet." })];
  const text = (x) => (kind === "pronunciations" ? `${x.name} = "${x.say}"`
    : kind === "sfx" ? `${x.cue} · clip ${two(x.clip)} · ${x.idea}`
      : `${x.id} · ${(x.usedIn ?? []).map(two).join(", ")} · ${x.prompt}`);
  return [head, h("ul", { class: "p1list" }, items.map((x) => h("li", { text: text(x) })))];
}

function picksEl(m, a) {
  const free = !m.busy && !m.approved;
  const out = [h("div", { class: "h3row" }, h("h3", { text: "To-camera lines" }))];
  if (m.picks.length) {
    out.push(h("ul", { class: "oclines" }, m.picks.map((x) => {
      const box = h("input", { type: "checkbox", id: `p1-pick-${x.id}`, disabled: !free });
      box.checked = true;
      box.addEventListener("change", () => a.unpick(x.id));
      return h("li", {}, h("label", { class: "octick", for: `p1-pick-${x.id}` }, box, h("span", { class: "nid", text: x.id })),
        h("span", { class: "octx", text: x.text }), x.from ? h("span", { class: "ocmeta", text: x.from }) : null);
    })));
  } else out.push(h("p", { class: "note", text: "No lines to camera yet." }));
  for (const t of m.pickNotes) out.push(h("p", { class: "pwarn", text: t }));
  if (!m.approved && m.addable.length) {
    const sel = h("select", { id: "p1-addline", "aria-label": "Line to add", disabled: !free },
      h("option", { value: "", text: "Choose a line…" }),
      m.addable.map((l) => h("option", { value: l.id, selected: l.id === m.addLine }, `${l.id} ${l.text.length > 70 ? `${l.text.slice(0, 70).trimEnd()}…` : l.text}`)));
    sel.addEventListener("change", () => a.chooseLine(sel.value));
    out.push(h("div", { class: "row ocadd" }, sel, btn("Add a line", () => a.pick(sel.value), { ghost: true, disabled: !free || !m.addLine })));
  }
  return out;
}

function episodeEl(m, a) {
  if (m.episodeEdit !== null && !m.approved) {
    return h("div", { class: "row p1ep" }, h("label", { for: "p1-episode", text: "Episode" }),
      textInput("p1-episode", m.episodeEdit, "Episode", (v) => a.episodeField(v), { inputmode: "numeric", class: "short" }),
      btn("Save", () => a.saveEpisode(), { disabled: m.busy }), btn("Cancel", () => a.closeEpisode(), { ghost: true }));
  }
  return h("div", { class: "row p1ep" }, h("span", { text: `Episode ${m.episode || "not set"}` }),
    m.approved ? null : btn("Edit", () => a.openEpisode(), { ghost: true, disabled: m.busy }));
}

export function part1Section(m, a) {
  const approveBtn = m.approved ? h("span", { class: "ok-tag", text: "✓ Part 1 approved" })
    : btn(m.approveLabel, () => a.approve(), { disabled: !m.canApprove });
  const kids = [h("div", { class: "h2row" }, h("h2", { text: "Part 1 · Script" }),
    m.numbers ? h("span", { class: "p1nums", text: m.numbers }) : null, approveBtn)];
  const top = [];
  if (m.approveWhy && !m.busy) top.push(h("p", { class: "locked", text: m.approveWhy }));
  if (m.busyText) top.push(h("p", { class: "p1busy" }, h("span", { class: "dot live" }), m.busyText));
  if (m.error) top.push(h("p", { class: "err", text: m.error }));
  if (m.nextStep) {
    top.push(h("p", { class: "p1next", text: m.nextStep }));
    for (const t of m.openItems) top.push(h("p", { class: "pwarn", text: t }));
  }
  if (m.warnings.length) top.push(h("ul", { class: "p2warn" }, m.warnings.map((w) => h("li", { text: w }))));

  if (!m.hasDraft) {
    top.push(h("p", { class: "note", text: "Claude reads the brief and a reference script, then writes the clips and the lists." }),
      h("div", { class: "row" }, btn(m.busy ? WRITING : "Write the script", () => a.write(), { disabled: m.busy })));
    kids.push(h("div", { class: "panel p1" }, top));
    return foldable(h("section", { class: "part1", "aria-label": "Part 1" }, kids), "Part 1");
  }

  if (!m.approved) {
    const controls = m.revise
      ? noteBox("p1-revise", m.revise.note, "Note for the whole script", "What should change across the script?", (v) => a.reviseNote(v),
        (v) => a.revise(v), "Revise", () => a.closeRevise(), m.busy)
      : h("div", { class: "row p1drafts" },
        btn("Revise with a note…", () => a.openRevise(), { ghost: true, disabled: m.busy }),
        h("span", { class: "p1draft", text: m.draft }),
        m.drafts.length > 1 ? btn(m.draftsOpen ? "Earlier drafts ▴" : "Earlier drafts ▾", () => a.toggleDrafts(), { ghost: true }) : null);
    top.push(controls);
    if (m.draftsOpen && m.drafts.length > 1) {
      top.push(h("ul", { class: "p1list" }, m.drafts.filter((d) => !d.current).reverse().map((d) =>
        h("li", { class: "p1dr" }, h("span", { text: d.label }), btn("Go back to this draft", () => a.restore(d.n), { ghost: true, disabled: m.busy })))));
    }
  } else top.push(h("p", { class: "p1draft", text: m.draft }));

  const script = m.sections.map((s) => h("div", { class: "p1sec" }, h("h3", { text: s.heading }), h("ol", { class: "p1clips" }, s.clips.map((c) => clipEl(c, m, a)))));
  const notes = m.notes.length || m.music ? [h("div", { class: "h3row" }, h("h3", { text: "Build notes" })),
    m.music ? h("p", { class: "p1nar", text: `Music: ${m.music}` }) : null,
    ...m.notes.map((n) => h("div", { class: "p1notes" }, h("b", { text: n.heading }), h("ul", {}, n.items.map((i) => h("li", { text: i })))))] : [];
  kids.push(h("div", { class: "panel p1" }, top, script,
    listEl("pronunciations", m, a), listEl("sfx", m, a), picksEl(m, a), listEl("shots", m, a), notes, episodeEl(m, a)));
  return foldable(h("section", { class: "part1", "aria-label": "Part 1" }, kids), "Part 1");
}
