import { test } from "node:test";
import assert from "node:assert/strict";
import { part2Model, part2Bar, handedOverText, APPROVE, AGAIN, APPROVING, CHANGED } from "../js/ui/part2.js";
import { reviewModel } from "../js/ui/review.js";
import { part2Sig } from "../js/part2run.js";
import { makeChecks } from "../js/ui/probe.js";
import { FakeHost } from "./fake-host.mjs";

const DIR = "S:\\Youtube video ideas\\Christmas Tree";
const take = (n, file) => ({ n, file, status: "done" });
const ready = (o = {}) => ({
  assets: [{ id: "HF-01", kind: "broll", tool: "higgsfield", line: "L", lineIndex: 0, desc: "d", approved: true, chosen: 1, takes: [take(1, "a.mp4")] }],
  audio: {
    score: { id: "SCORE", approved: true, chosen: 1, takes: [take(1, "s.mp3")] },
    sfx: [{ id: "SFX-01", approved: true, chosen: 1, startS: 12.5, loop: false, takes: [take(1, "x.wav")] }],
  },
  mix: {
    voiceover: { status: "done", at: 10, takes: [] },
    fit: { status: "done", at: 20, fromVoiceoverAt: 10, fromScoreTake: 1, takes: [] },
    mix: { status: "done", approved: true, at: 30, fromFitAt: 20, fromVoiceoverAt: 10,
      fromSfx: [{ id: "SFX-01", take: 1, file: "x.wav", startS: 12.5, loop: false, meanDb: null }], takes: [] },
  },
  ...o,
});
const handed = (state, o = {}) => ({ ...state, part2: { approvedAt: new Date(2026, 10, 27, 14, 5).getTime(), handover: `${DIR}\\handover\\part2_handover.md`, brIds: ["BR-013"],
  sig: part2Sig(state), topic: "Christmas Trees", message: "Part 3 of Six minutes on… Christmas Trees. Load /documentary-explainer-video, read x, and carry on.", ...o } });

test("locked: disabled Approve Part 2 with the lock sentence", () => {
  const st = ready();
  st.assets[0].approved = false;
  st.assets.push({ ...st.assets[0], id: "HF-02" });
  const m = part2Model({ state: st });
  assert.equal(m.label, APPROVE);
  assert.equal(APPROVE, "Approve Part 2");
  assert.equal(m.disabled, true);
  assert.equal(m.lock, "2 shots still to approve");
  assert.equal(m.done, null);
  assert.equal(m.changed, null);
});

test("ready: enabled, no lock sentence", () => {
  const m = part2Model({ state: ready() });
  assert.equal(m.disabled, false);
  assert.equal(m.lock, null);
  assert.equal(m.label, "Approve Part 2");
});

test("running: the steps, latest last, and the button held as Approving…", () => {
  const m = part2Model({ state: ready(), ui: { running: true, steps: ["Reading the library", "Adding 2 clips"] } });
  assert.equal(m.label, APPROVING);
  assert.equal(APPROVING, "Approving\u2026");
  assert.equal(m.disabled, true);
  assert.deepEqual(m.steps, ["Reading the library", "Adding 2 clips"]);
  assert.equal(m.done, null);
});

test("done: handed over date, the warnings, the opening message, Write the handover again", () => {
  const st = handed(ready());
  const m = part2Model({ state: st, ui: { warnings: ["The contact sheet was made without BR labels."] } });
  assert.equal(m.label, AGAIN);
  assert.equal(AGAIN, "Write the handover again");
  assert.equal(m.disabled, false);
  assert.equal(m.done.when, "Part 2 handed over 27 Nov 2026 14:05");
  assert.deepEqual(m.done.warnings, ["The contact sheet was made without BR labels."]);
  assert.match(m.done.message, /^Part 3 of Six minutes on… Christmas Trees\./);
  assert.equal(m.changed, null);
  assert.equal(m.steps, null);
  assert.equal(handedOverText(new Date(2026, 0, 3, 9, 7).getTime()), "Part 2 handed over 3 Jan 2026 09:07");
});

test("changed since the handover: the banner, and locked again when something is unapproved", () => {
  const st = handed(ready());
  st.mix.mix.at = 31;
  let m = part2Model({ state: st });
  assert.equal(m.changed, CHANGED);
  assert.equal(CHANGED, "Changed since the Part 2 handover");
  assert.equal(m.disabled, false);
  const un = handed(ready());
  un.assets[0].approved = false;
  m = part2Model({ state: un });
  assert.equal(m.changed, CHANGED);
  assert.equal(m.disabled, true);
  assert.equal(m.label, AGAIN);
  assert.equal(m.lock, "1 shot still to approve");
});

test("an error from the run is shown, with the steps it got through", () => {
  const m = part2Model({ state: ready(), ui: { error: "Wait for the running jobs to finish.", steps: ["Reading the library"] } });
  assert.equal(m.error, "Wait for the running jobs to finish.");
  assert.deepEqual(m.steps, ["Reading the library"]);
  assert.equal(m.disabled, false);
});

test("reviewModel carries part2 from part2Ui", () => {
  const m = reviewModel({ film: { title: "F", dir: DIR }, state: ready(), part2Ui: { running: true, steps: ["Reading the library"] } });
  assert.equal(m.part2.label, APPROVING);
});

// ---- DOM ----
function withDom(fn) {
  const mk = (tag) => {
    const el = { tag, attrs: {}, children: [], listeners: {}, style: {}, className: "", textContent: "", value: "",
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
      append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = [...k]; } };
    Object.setPrototypeOf(el, globalThis.Node.prototype);
    return el;
  };
  globalThis.Node = class {};
  globalThis.document = { createElement: mk, createTextNode: (t) => ({ t }) };
  return Promise.resolve().then(fn).finally(() => { delete globalThis.document; delete globalThis.Node; });
}
const all = (el, pred, out = []) => {
  if (!el || typeof el !== "object") return out;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) all(c, pred, out);
  return out;
};
const textOf = (el) => (el.textContent ?? "") + (el.children ?? []).map((c) => (c.t ?? textOf(c))).join("");
const byText = (el, t) => all(el, (x) => x.tag === "button").find((b) => textOf(b) === t);
const click = (b) => { for (const f of b.listeners.click ?? []) f({}); };

test("DOM locked: button disabled, the lock sentence as its title and beside it", () => withDom(() => {
  const st = ready();
  st.assets[0].approved = false;
  const el = part2Bar(part2Model({ state: st }), {});
  const b = byText(el, "Approve Part 2");
  assert.equal(b.disabled, true);
  assert.equal(b.attrs.title, "1 shot still to approve");
  assert.match(textOf(el), /1 shot still to approve/);
}));

test("DOM ready: press calls approvePart2; running shows the steps in order", () => withDom(() => {
  const calls = [];
  let el = part2Bar(part2Model({ state: ready() }), { approvePart2: () => calls.push("go") });
  click(byText(el, "Approve Part 2"));
  assert.deepEqual(calls, ["go"]);
  el = part2Bar(part2Model({ state: ready(), ui: { running: true, steps: ["Reading the library", "Adding 1 clip"] } }), {});
  assert.equal(byText(el, "Approving\u2026").disabled, true);
  const items = all(el, (x) => x.tag === "li").map(textOf);
  assert.deepEqual(items, ["Reading the library", "Adding 1 clip"]);
}));

test("DOM done: date, warnings, read-only message box and Copy; changed banner; error", () => withDom(() => {
  const calls = [];
  const st = handed(ready());
  st.mix.mix.at = 31;
  const el = part2Bar(part2Model({ state: st, ui: { warnings: ["W1"], error: "Boom" } }), { copyMessage: (t, box) => calls.push([t, box.tag]) });
  const t = textOf(el);
  assert.match(t, /Part 2 handed over 27 Nov 2026 14:05/);
  assert.match(t, /Changed since the Part 2 handover/);
  assert.match(t, /Boom/);
  assert.deepEqual(all(el, (x) => x.tag === "li").map(textOf), ["W1"]);
  const box = all(el, (x) => x.tag === "textarea")[0];
  assert.equal(box.readOnly, true);
  assert.match(box.value, /^Part 3 of Six minutes on… Christmas Trees\./);
  click(byText(el, "Copy"));
  assert.deepEqual(calls, [[box.value, "textarea"]]);
  assert.ok(byText(el, "Write the handover again"));
}));

// ---- Probe ----
const LIBROOT = "S:\\Youtube video ideas";
const LIB = `${LIBROOT}\\B-roll library`;
const libRow = async (h, root = LIBROOT) => {
  const c = makeChecks({}, root).find((x) => x.name === "B-roll library");
  assert.ok(c, "a B-roll library row");
  try { return { ok: true, detail: await c.run(h) }; } catch (e) { return { ok: false, detail: e.message }; }
};

test("Probe B-roll library: passes with the clip count and next BR number", async () => {
  const h = new FakeHost();
  h.files.set(`${LIB}\\broll_catalogue.json`, JSON.stringify({ generated: "x", entries: [{ id: "BR-001" }, { id: "BR-009" }] }));
  h.files.set(`${LIB}\\broll_catalogue.md`, "| BR-011 | x |\n");
  assert.deepEqual(await libRow(h), { ok: true, detail: "2 clips, next BR-012" });
});

test("Probe B-roll library: fails with the reason when the catalogue can't be read", async () => {
  const h = new FakeHost();
  let r = await libRow(h);
  assert.equal(r.ok, false);
  assert.match(r.detail, /^Couldn't read S:\\Youtube video ideas\\B-roll library\\broll_catalogue\.json/);
  h.files.set(`${LIB}\\broll_catalogue.json`, "{ nope");
  r = await libRow(h);
  assert.equal(r.ok, false);
  assert.match(r.detail, /isn't valid JSON/);
});
