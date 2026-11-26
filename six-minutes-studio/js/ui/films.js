// Films view: one row per film with the four-step tracker and what is waiting on Jon.
import { h, btn } from "./dom.js";
import { filmKey } from "../paths.js";

const STEPS = [[1, "1 Script"], [2, "2 Assets"], [3, "3 Build"], ["shorts", "Shorts"]];
const active = (j) => j.status === "queued" || j.status === "running";

export const UNREACHABLE = "Can't reach S:\\Youtube video ideas or the server copy. Check the drive is connected.";

export function filmRow(film, jobs = []) {
  const running = jobs.filter((j) => filmKey(j.film) === filmKey(film.dir) && active(j)).length;
  let wait = null;
  if (film.waiting) wait = { you: true, live: false, label: "Waiting on you:", text: film.waiting };
  else if (running) wait = { you: false, live: true, label: "Running:", text: `${running} job${running === 1 ? "" : "s"}` };
  const reviewable = film.parts?.[2] === "now";
  return {
    dir: film.dir,
    title: film.title,
    meta: film.number ? `No. ${film.number}` : null,
    dot: film.series?.colour ?? null, // series is not in the data yet: no dot
    parts: STEPS.map(([k, label]) => ({ label, state: film.parts?.[k] ?? "none" })),
    wait,
    button: reviewable ? { label: "Open review", primary: !!wait?.you } : null,
  };
}

export function filmsModel({ root, films = [], jobs = [] }) {
  if (!root) return { unreachable: true, message: UNREACHABLE, rows: [], empty: false };
  const rows = films.map((f) => filmRow(f, jobs));
  return { unreachable: false, message: null, rows, empty: rows.length === 0 };
}

const MARK = { done: "\u2713 ", now: "\u25CF ", none: "" };

function row(r, actions) {
  return h("article", { class: "film" },
    h("div", {},
      r.meta || r.dot ? h("div", { class: "m" }, r.dot ? h("span", { class: "dot", style: { background: r.dot } }) : null, r.meta) : null,
      h("div", { class: "t", text: r.title })),
    h("div", { class: "parts" }, r.parts.map((p) => h("div", { class: `part ${p.state}` }, MARK[p.state] ?? "", p.label))),
    h("div", {}, r.button ? btn(r.button.label, () => actions.openReview(r.dir), { ghost: !r.button.primary }) : null),
    r.wait ? h("div", { class: `wait${r.wait.you ? " you" : ""}` },
      h("span", {}, r.wait.live ? h("span", { class: "dot live" }) : null, r.wait.label, " ", r.wait.text)) : null,
  );
}

export function render(el, model, actions) {
  const head = [
    h("h1", { text: "Your films" }),
    h("p", { class: "lede", text: "Each film shows where it is in your three parts, and anything waiting on you is in brass." }),
  ];
  if (model.unreachable) {
    el.replaceChildren(...head, h("div", { class: "panel warn" },
      h("p", { text: model.message }), btn("Try again", () => actions.retryRoot())));
    return;
  }
  if (model.empty) {
    el.replaceChildren(...head, h("p", { class: "lede", text: "No films found. A film folder needs a handover or studio folder." }));
    return;
  }
  el.replaceChildren(...head, h("div", { class: "films" }, model.rows.map((r) => row(r, actions))));
}
