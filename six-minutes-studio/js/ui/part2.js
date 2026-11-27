// Review summary bar: Approve Part 2 (locked with what's left), the steps while it runs, then the handover's
// date, any warnings and the Part 3 opening message with Copy.
import { h, btn } from "./dom.js";
import { part2Readiness, leftText } from "../part2.js";
import { part2Changed } from "../part2run.js";

export const APPROVE = "Approve Part 2";
export const AGAIN = "Write the handover again";
export const APPROVING = "Approving…";
export const CHANGED = "Changed since the Part 2 handover";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

// "Part 2 handed over 27 Nov 2026 14:05", local time.
export function handedOverText(at) {
  const d = new Date(at);
  return `Part 2 handed over ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ui: { running, steps: [text], error, warnings, copied } from the app's press; elsewhere: another film's run.
export function part2Model({ state, ui = {} }) {
  const r = part2Readiness(state);
  const p2 = state?.part2 ?? null;
  const running = !!ui.running;
  const steps = ui.steps ?? [];
  return {
    label: running ? APPROVING : p2 ? AGAIN : APPROVE,
    disabled: running || !r.ready || !!ui.elsewhere,
    // Another film's press is writing to the shared library: that says why, before what's left here.
    lock: !running && ui.elsewhere ? ui.elsewhere : r.ready ? null : leftText(r.left),
    // The steps while it runs, and after a failure (so Jon sees where it stopped).
    steps: running || (ui.error && steps.length) ? [...steps] : null,
    error: running ? null : ui.error ?? null,
    done: p2 && !running ? { when: handedOverText(p2.approvedAt), warnings: [...(ui.warnings ?? [])], message: p2.message ?? null,
      copyLabel: ui.copied ? "Copied" : "Copy" } : null,
    changed: p2 && part2Changed(state) ? CHANGED : null,
  };
}

export function part2Bar(m, actions) {
  const b = btn(m.label, () => actions.approvePart2(), { disabled: m.disabled });
  if (m.lock) b.setAttribute("title", m.lock);
  const kids = [h("div", { class: "p2row" }, b, m.lock ? h("span", { class: "locked", text: m.lock }) : null,
    m.done ? h("span", { class: "p2when", text: m.done.when }) : null,
    m.changed ? h("span", { class: "p2changed", text: m.changed }) : null)];
  if (m.steps) kids.push(h("ol", { class: "p2steps", "aria-live": "polite" }, m.steps.map((s) => h("li", { text: s }))));
  if (m.error) kids.push(h("p", { class: "err", text: m.error }));
  if (m.done?.warnings.length) kids.push(h("ul", { class: "p2warn" }, m.done.warnings.map((w) => h("li", { text: w }))));
  if (m.done?.message) {
    const box = h("textarea", { class: "p2msg", rows: "3", "aria-label": "Part 3 opening message" });
    box.readOnly = true;
    box.value = m.done.message;
    kids.push(h("div", { class: "p2copy" }, box, btn(m.done.copyLabel, () => actions.copyMessage(box.value, box), { ghost: true })));
  }
  return h("div", { class: "p2" }, kids);
}
