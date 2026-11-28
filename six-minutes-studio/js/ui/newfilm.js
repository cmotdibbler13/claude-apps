// New film form (Films page): folder, brief, topic, file prefix, episode, voice and runtime target.
import { h, btn } from "./dom.js";
import { suggestPrefix, prefixProblem, suggestEpisode, briefTypeOk, BRIEF_TYPE } from "../part1setup.js";
import { join } from "../paths.js";

export const NEW_FOLDER = "\u0000new"; // the folder list's "New folder" value
export const DEFAULT_RUNTIME = "6:00–6:45";
export const CREATING = "Creating…";
export { BRIEF_TYPE };

const given = (v) => typeof v === "string"; // a field Jon has typed in (even emptied) is his, not a suggestion

// What a picked brief file needs before Studio copies it: null when fine, else the message.
export const briefPickProblem = (name) => (briefTypeOk(name) ? null : BRIEF_TYPE);

// folders: [{name, dir}] from filmFolders, or null while they load. briefs: [{name, path}] for the chosen folder.
// form: what Jon has chosen or typed so far; untouched fields take the suggestions.
// pending: a brief picked for a new folder ({name}), copied in when the film is created.
export function newFilmModel({ folders = null, briefs = [], form = {}, taken = [], films = [], error = null, busy = false, recordings = null, pending = null } = {}) {
  const list = folders ?? [];
  const folder = form.folder ?? (list[0]?.dir ?? NEW_FOLDER);
  const isNew = folder === NEW_FOLDER;
  const newFolder = form.newFolder ?? "";
  const folderName = isNew ? newFolder.trim() : list.find((f) => f.dir === folder)?.name ?? "";

  const briefOptions = briefs.map((b) => ({ value: b.path, label: b.name }));
  if (pending && isNew) briefOptions.unshift({ value: `${NEW_FOLDER}brief`, label: `${pending.name} (copied in when you create the film)` });
  const brief = form.brief && briefOptions.some((o) => o.value === form.brief) ? form.brief : briefOptions[0]?.value ?? "";

  const topic = given(form.topic) ? form.topic : folderName;
  const prefix = given(form.prefix) ? form.prefix : suggestPrefix(topic);
  const episode = given(form.episode) ? form.episode : suggestEpisode(films);
  const runtime = given(form.runtime) ? form.runtime : DEFAULT_RUNTIME;
  const problem = prefix ? prefixProblem(prefix, taken) : "Add a file prefix.";
  const shown = prefix || "<prefix>";
  const where = join(recordings || "<autocueRecordings>", shown);

  const ready = !busy && folders !== null && !!folderName && !!brief && !!topic.trim() && !problem && /^\d{1,4}$/.test(episode.trim());
  return {
    loading: folders === null,
    folders: [...list.map((f) => ({ value: f.dir, label: f.name, selected: f.dir === folder })), { value: NEW_FOLDER, label: "New folder…", selected: isNew }],
    folder, isNew, newFolder,
    briefs: briefOptions.map((o) => ({ ...o, selected: o.value === brief })),
    brief,
    noBriefs: briefOptions.length === 0 ? (isNew ? "Add the brief for the new folder." : "No .md or .txt brief in this folder yet. Add one.") : null,
    topic, prefix, prefixProblem: problem, episode, runtime,
    recordingsPath: `${where}\\${shown}_<NN.s>.wav`,
    voices: [{ value: "own", label: "Own voice", selected: true, disabled: false }, { value: "cloned", label: "Cloned voice (coming later)", selected: false, disabled: true }],
    canCreate: ready,
    createLabel: busy ? CREATING : "Create",
    busy: !!busy,
    error: error ?? null,
  };
}

// The values to hand createFilm (and the pending brief, for a new folder).
export function createInput(m) {
  const base = { brief: m.brief, topic: m.topic, prefix: m.prefix.trim(), episode: m.episode.trim(), runtime: m.runtime };
  return m.isNew ? { ...base, newFolder: m.newFolder.trim() } : { ...base, folder: m.folder };
}

function field(label, id, control, extra = null) {
  return h("div", { class: "nfrow" }, h("label", { for: id, text: label }), h("div", { class: "nfctl" }, control, extra));
}

function input(id, value, onInput, o = {}) {
  const el = h("input", { type: "text", id, spellcheck: "false", ...o });
  el.value = value;
  el.addEventListener("input", () => onInput(el.value));
  return el;
}

function select(id, options, onChange, o = {}) {
  const el = h("select", { id, ...o }, options.map((x) => h("option", { value: x.value, disabled: x.disabled, selected: x.selected }, x.label)));
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

// A plain file chooser (Studio has no native dialog): the picked file's name and bytes, no path.
function briefPicker(onFile, disabled) {
  const inp = h("input", { type: "file", accept: ".md,.txt,.pdf", hidden: true });
  const b = btn("Add a brief…", () => inp.click(), { ghost: true, disabled });
  inp.addEventListener("change", async () => {
    const f = inp.files?.[0];
    inp.value = "";
    if (!f) return;
    await onFile({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  });
  return h("span", {}, b, inp);
}

export function renderNewFilm(el, m, actions) {
  const set = (k) => (v) => actions.setField(k, v);
  const folder = select("nf-folder", m.folders, (v) => actions.setFolder(v), { disabled: m.busy || m.loading });
  const kids = [
    h("div", { class: "head" }, h("h1", { text: "New film" })),
    h("p", { class: "lede", text: "Start a film from its brief. Studio makes the film's studio folder and opens the Part 1 script." }),
  ];
  const form = h("div", { class: "panel nf" },
    m.loading ? h("p", { class: "note", text: "Looking for folders…" }) : null,
    field("Folder", "nf-folder", folder,
      m.isNew ? input("nf-newfolder", m.newFolder, set("newFolder"), { placeholder: "Folder name", "aria-label": "New folder name", disabled: m.busy }) : null),
    field("Brief", "nf-brief", m.briefs.length ? select("nf-brief", m.briefs, set("brief"), { disabled: m.busy }) : h("span", { class: "note", id: "nf-brief", text: m.noBriefs }),
      briefPicker((f) => actions.addBrief(f), m.busy || m.loading)),
    field("Topic", "nf-topic", input("nf-topic", m.topic, set("topic"), { disabled: m.busy }),
      h("span", { class: "nfhint", text: `Six minutes on… ${m.topic || "<topic>"}` })),
    field("File prefix", "nf-prefix", input("nf-prefix", m.prefix, set("prefix"), { disabled: m.busy }),
      m.prefixProblem ? h("span", { class: "err", text: m.prefixProblem }) : null),
    field("Episode", "nf-episode", input("nf-episode", m.episode, set("episode"), { inputmode: "numeric", class: "short", disabled: m.busy })),
    field("Voice", "nf-voice", select("nf-voice", m.voices, () => {}, { disabled: m.busy }),
      h("span", { class: "nfhint", text: `Takes save as ${m.recordingsPath}` })),
    field("Runtime target", "nf-runtime", input("nf-runtime", m.runtime, set("runtime"), { class: "short", disabled: m.busy })),
    m.error ? h("p", { class: "err", text: m.error }) : null,
    h("div", { class: "row" },
      btn(m.createLabel, () => actions.create(), { disabled: !m.canCreate }),
      btn("Cancel", () => actions.cancel(), { ghost: true, disabled: m.busy })));
  el.replaceChildren(...kids, form);
}

export const render = renderNewFilm;
