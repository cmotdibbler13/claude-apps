import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLineScript } from "../js/narration.js";
import {
  onCameraModel, costLabel, costPress, render, NEED_PHOTOS, NOT_IN_SCRIPT, PRESS_AGAIN, STALE_PORTRAIT, ON_CAMERA, OWN,
} from "../js/ui/oncamera.js";
import { portraitParams, clipParams, portraitPrompt, clipPrompt, TOO_LONG } from "../js/presenter.js";
import { cardModel, reviewModel, card } from "../js/ui/review.js";
import { removeConfirmText } from "../js/ui/review.js";

const LS = parseLineScript("## Opening\n[01]\nOne is here.\n> to camera\n[02]\nTwo is here and it is a long line.\n[03]\nThree is here now.\n> To Camera\n[04]\nFour.\n");
const NOMARKS = parseLineScript("[01]\nOne is here.\n[02]\nTwo is here.\n[03]\nThree.\n");
const TR = { sentences: [{ sentence: "01", start: 0, end: 5 }, { sentence: "02", start: 5, end: 21 }, { sentence: "03", start: 21, end: 30.2 }] };
const tc = (o = {}) => ({ id: "TC-01", kind: "presenter", tool: "higgsfield", lineId: "01", line: "One is here.", lineIndex: 0, desc: "On camera: One is here.…", takes: [], chosen: 0, approved: false, ...o });
const st = (o = {}) => ({ assets: [], presenter: { lines: [] }, ...o });
const LOOK = { outfit: "a navy blazer", set: "a reading room", at: 5 };
const ready = (o = {}) => st({
  presenter: { lines: [{ id: "01", from: "script" }], look: LOOK, portrait: { n: 1, hfId: "hf-1", file: "p1.png", at: 6 } },
  mix: { voiceover: { status: "done", wav: "vo.wav", transcript: "t.json" } }, assets: [tc()], ...o,
});

// ---- lines ----

test("script-marked lines show 'from the script'; no Suggest lines when the script has marks", () => {
  const m = onCameraModel({ state: st({ presenter: { lines: [{ id: "01", from: "script" }, { id: "03", from: "script" }] } }), lineScript: LS, transcript: TR });
  assert.equal(m.canSuggest, false);
  assert.deepEqual(m.lines.map((l) => [l.id, l.text, l.fromLabel, l.note]), [["01", "One is here.", "from the script", null], ["03", "Three is here now.", "from the script", null]]);
  assert.equal(m.lines[0].section, "Opening");
  assert.equal(m.lines[0].lengthText, "5.0 s");
});

test("labels for suggested and Jon's lines; a vanished id says Not in the script any more; too-long copy", () => {
  const state = st({ presenter: { lines: [{ id: "02", from: "claude" }, { id: "04", from: "jon" }, { id: "09", from: "jon" }] }, assets: [tc({ id: "TC-03", lineId: "09", line: "Gone line." })] });
  const m = onCameraModel({ state, lineScript: LS, transcript: TR });
  assert.deepEqual(m.lines.map((l) => l.fromLabel), ["suggested", "added by you", "added by you"]);
  assert.equal(m.lines[0].note, TOO_LONG);
  assert.equal(m.lines[2].note, NOT_IN_SCRIPT);
  assert.equal(m.lines[2].text, "Gone line.");
  assert.equal(NOT_IN_SCRIPT, "Not in the script any more");
  // Add a line offers the Narration lines not chosen yet.
  assert.deepEqual(m.addOptions.map((o) => o.id), ["01", "03"]);
});

test("no marks: Suggest lines is shown; suggestions tick when chosen", () => {
  const m = onCameraModel({ state: st({ presenter: { lines: [{ id: "02", from: "claude" }] } }), lineScript: NOMARKS, ui: { suggestions: [{ id: "01", why: "Opens the film" }, { id: "02", why: "A turn" }] } });
  assert.equal(m.canSuggest, true);
  assert.deepEqual(m.suggestions.map((s) => [s.id, s.text, s.why, s.ticked]), [["01", "One is here.", "Opens the film", false], ["02", "Two is here.", "A turn", true]]);
  assert.equal(onCameraModel({ state: st(), lineScript: NOMARKS, ui: { suggesting: true } }).suggesting, true);
});

// ---- look ----

test("look: three suggestions each plus the last film's look, prefilled; your own text; Use this look", () => {
  const ui = { looks: { outfits: ["o1", "o2", "o3"], sets: ["s1", "s2", "s3"] }, lastLook: { outfit: "a tweed jacket", set: "a harbour office" } };
  let m = onCameraModel({ state: st(), lineScript: LS, ui });
  assert.deepEqual(m.look.outfits.map((o) => o.value), ["a tweed jacket", "o1", "o2", "o3"]);
  assert.match(m.look.outfits[0].label, /last film/);
  assert.equal(m.look.outfits[0].checked, true);
  assert.equal(m.look.sets[0].checked, true);
  assert.deepEqual(m.look.chosen, { outfit: "a tweed jacket", set: "a harbour office" });
  assert.equal(m.look.canSave, true);
  // Own text
  m = onCameraModel({ state: st(), lineScript: LS, ui: { ...ui, lookPick: { outfit: OWN, set: "s2" }, own: { outfit: "a grey jumper" } } });
  assert.equal(m.look.own.outfit.checked, true);
  assert.deepEqual(m.look.chosen, { outfit: "a grey jumper", set: "s2" });
  // Own picked but empty: can't save.
  m = onCameraModel({ state: st(), lineScript: LS, ui: { ...ui, lookPick: { outfit: OWN, set: "s2" } } });
  assert.equal(m.look.canSave, false);
  // The saved look is checked and saving it again is off.
  m = onCameraModel({ state: st({ presenter: { lines: [], look: LOOK } }), lineScript: LS, ui });
  assert.equal(m.look.outfits.find((o) => o.checked).value, LOOK.outfit);
  assert.deepEqual(m.look.saved, { outfit: LOOK.outfit, set: LOOK.set });
  assert.equal(m.look.canSave, false);
});

// ---- portraits button and cost ----

test("missing photos: Make portraits disabled with the Probe copy", () => {
  const m = onCameraModel({ state: st({ presenter: { lines: [], look: LOOK } }), lineScript: LS, estimates: { portrait: 10 }, photosOk: false });
  assert.equal(m.buttons.portraits.enabled, false);
  assert.equal(m.buttons.portraits.why, NEED_PHOTOS);
  assert.equal(NEED_PHOTOS, "Add presenter photos (see Probe)");
});

test("cost labels: two portraits a press, cost unknown, press again, getting the cost", () => {
  const base = { state: st({ presenter: { lines: [], look: LOOK } }), lineScript: LS, photosOk: true };
  let b = onCameraModel({ ...base, estimates: { portrait: 10 } }).buttons.portraits;
  assert.deepEqual([b.label, b.enabled], ["Make portraits (≈20 credits)", true]);
  b = onCameraModel({ ...base, estimates: { portrait: null } }).buttons.portraits;
  assert.deepEqual([b.label, b.enabled], ["Make portraits (cost unknown)", true]);
  b = onCameraModel({ ...base, estimates: { portrait: null }, ui: { confirm: "PORTRAIT" } }).buttons.portraits;
  assert.deepEqual([b.label, b.enabled], [PRESS_AGAIN, true]);
  assert.equal(PRESS_AGAIN, "Press again to spend credits");
  b = onCameraModel({ ...base, estimates: {} }).buttons.portraits;
  assert.equal(b.enabled, false);
  assert.match(b.label, /getting the cost/);
  // No look yet
  b = onCameraModel({ ...base, state: st(), estimates: { portrait: 10 } }).buttons.portraits;
  assert.deepEqual([b.label, b.enabled, b.why], ["Make portraits", false, "Choose an outfit and a set first"]);
  // Running
  const running = st({ presenter: { lines: [], look: LOOK, portraits: { id: "PORTRAIT", takes: [{ n: 1, status: "running" }], chosen: 0 } } });
  b = onCameraModel({ ...base, state: running, estimates: { portrait: 10 } }).buttons.portraits;
  assert.equal(b.enabled, false);
  assert.equal(b.label, "Making portraits…");
  assert.equal(costLabel("Make clip", 12.5, false), "Make clip (≈12.5 credits)");
});

test("costPress: a known cost goes; unknown needs a second press; loading never goes", () => {
  assert.deepEqual(costPress(5, null, "K"), { go: true, confirm: null });
  assert.deepEqual(costPress(null, null, "K"), { go: false, confirm: "K" });
  assert.deepEqual(costPress(null, "K", "K"), { go: true, confirm: null });
  assert.deepEqual(costPress(null, "OTHER", "K"), { go: false, confirm: "K" });
  assert.deepEqual(costPress(undefined, null, "K"), { go: false, confirm: null });
});

test("approved portrait shown; finished takes can be approved", () => {
  const portraits = { id: "PORTRAIT", takes: [{ n: 1, status: "done", file: "p1.png", hfId: "h1" }, { n: 2, status: "done", file: "p2.png", hfId: "h2" }, { n: 3, status: "failed", error: "nsfw" }], chosen: 1, approved: true };
  const m = onCameraModel({ state: st({ presenter: { lines: [], look: LOOK, portraits, portrait: { n: 1, hfId: "h1", file: "p1.png" } } }), lineScript: LS });
  assert.equal(m.approvedN, 1);
  assert.deepEqual(m.portraits.map((p) => [p.n, p.approved, p.canApprove, p.file]), [[1, true, false, "p1.png"], [2, false, true, "p2.png"], [3, false, false, null]]);
  assert.match(m.portraits[2].status, /nsfw/);
});

test("estimate params: the generate params without medias", () => {
  assert.deepEqual(portraitParams(portraitPrompt(LOOK)), { model: "seedream_5_5", prompt: portraitPrompt(LOOK), aspect_ratio: "16:9", count: 1, use_unlim: false, resolution: "2k" });
  assert.deepEqual(clipParams({ seconds: 8, prompt: clipPrompt() }), { model: "wan2_7", resolution: "1080p", aspect_ratio: "16:9", duration: 8, prompt: clipPrompt(), use_unlim: false });
});

// ---- cards ----

test("a b-roll card on a to-camera line: This line is on camera, with Remove and the confirm", () => {
  const b = { id: "HF-01", kind: "broll", tool: "higgsfield", line: "One is here.", lineIndex: 0, desc: "d", takes: [], chosen: 0, approved: false };
  const state = st({ assets: [b, tc()] });
  let c = cardModel(b, state.assets, { state });
  assert.equal(c.conflict, ON_CAMERA);
  assert.equal(ON_CAMERA, "This line is on camera");
  assert.equal(c.removeLabel, "Remove");
  assert.equal(c.canRemove, true);
  c = cardModel(b, state.assets, { state, confirmRemove: true });
  assert.equal(c.confirmRemove, removeConfirmText("HF-01"));
  // No conflict without the camera line.
  const plain = st({ assets: [b] });
  assert.equal(cardModel(b, plain.assets, { state: plain }).conflict, null);
  assert.equal(cardModel(b, plain.assets, { state: plain }).removable, false);
});

test("a clip card: Make clip with its cost, locks, stale copy and Keep anyway", () => {
  let state = ready();
  let c = cardModel(state.assets[0], state.assets, { state, transcript: TR, estimates: { clips: { 5: 20 } } });
  assert.equal(c.locked, false);
  assert.equal(c.clip.makeLabel, "Make clip (≈20 credits)");
  assert.equal(c.clip.redoLabel, "Redo with note (≈20 credits)");
  assert.equal(c.canMakeFirst, true);
  c = cardModel(state.assets[0], state.assets, { state, transcript: TR, estimates: { clips: { 5: null } }, confirm: "TC-01" });
  assert.equal(c.clip.makeLabel, PRESS_AGAIN);
  // Locks
  c = cardModel(state.assets[0], state.assets, { state: ready({ presenter: { lines: [] } }), transcript: TR });
  assert.deepEqual([c.locked, c.lockText], [true, "Approve a portrait first"]);
  c = cardModel(state.assets[0], state.assets, { state, transcript: null });
  assert.deepEqual([c.locked, c.lockText], [true, "Join the voiceover first"]);
  // Stale and voiceover changed
  const done = tc({ takes: [{ n: 1, status: "done", file: "TC-01_t1.mp4", portraitHfId: "hf-0" }], chosen: 1, staleReason: "portrait", voiceoverChanged: true });
  state = ready({ assets: [done] });
  c = cardModel(done, state.assets, { state, transcript: TR, estimates: { clips: { 5: 20 } } });
  assert.equal(c.clip.stale, STALE_PORTRAIT);
  assert.equal(STALE_PORTRAIT, "Made with an earlier portrait");
  assert.equal(c.clip.voiceover, "The voiceover for this line changed: redo to match, or Keep anyway");
  assert.equal(c.clip.canKeep, true);
  assert.equal(c.isVideo, true);
  assert.equal(c.toolSwitch, null);
});

test("reviewModel: clips sit in the On camera step in line-script order, not among the shots", () => {
  const b = { id: "HF-01", kind: "broll", tool: "higgsfield", line: "Two is here and it is a long line.", lineIndex: 0, desc: "d", takes: [], chosen: 0, approved: false };
  const state = ready({ presenter: { lines: [{ id: "03", from: "script" }, { id: "01", from: "script" }] }, assets: [tc({ id: "TC-01", lineId: "03", line: "Three is here now.", lineIndex: 2 }), tc({ id: "TC-02", lineId: "01", lineIndex: 0 }), b] });
  const m = reviewModel({ film: { title: "F", dir: "D" }, state, lineScript: LS, transcript: TR });
  assert.deepEqual(m.cards.map((c) => c.id), ["HF-01"]);
  assert.deepEqual(m.onCamera.clips.map((c) => c.id), ["TC-02", "TC-01"]);
  assert.equal(m.needsShotList, false);
  // Only clips: the shot list still has to be made.
  const only = ready();
  assert.equal(reviewModel({ film: { title: "F", dir: "D" }, state: only, lineScript: LS }).needsShotList, true);
  // No line script and no lines: no step.
  assert.equal(reviewModel({ film: { title: "F", dir: "D" }, state: st() }).onCamera, null);
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
const buttons = (el) => all(el, (x) => x.tag === "button" && !String(x.className).includes("fold"));
const byText = (el, t) => buttons(el).find((b) => textOf(b) === t);
const fire = (el, k, ev = {}) => { for (const f of el.listeners[k] ?? []) f(ev); };
const stub = (calls = []) => new Proxy({ preview: (f) => `blob:${f}`, draft: () => "" }, {
  get: (o, k) => (k in o ? o[k] : (...a) => { calls.push([k, ...a]); }),
});

test("On camera DOM: Suggest lines, untick, add a line, portraits button off with the Probe copy", () => withDom(() => {
  const calls = [];
  const m = onCameraModel({ state: st({ presenter: { lines: [{ id: "02", from: "claude" }], look: LOOK } }), lineScript: NOMARKS, estimates: { portrait: 10 }, photosOk: false });
  const el = { replaceChildren(...k) { this.children = k; }, children: [] };
  render(el, { ...m, clips: [] }, stub(calls));
  click(byText(el, "Suggest lines"));
  assert.deepEqual(calls.at(-1), ["suggestLines"]);
  const box = all(el, (x) => x.tag === "input" && x.attrs.type === "checkbox")[0];
  box.checked = false;
  fire(box, "change");
  assert.deepEqual(calls.at(-1), ["toggleLine", "02", false]);
  const sel = all(el, (x) => x.tag === "select")[0];
  sel.value = "03";
  fire(sel, "change");
  assert.deepEqual(calls.at(-1), ["addLine", "03"]);
  const mp = byText(el, "Make portraits (≈20 credits)");
  assert.equal(mp.disabled, true);
  assert.match(textOf(el), /Add presenter photos \(see Probe\)/);
}));

test("clip card DOM: Make clip with its cost, Keep anyway, stale copy", () => withDom(() => {
  const calls = [];
  const done = tc({ takes: [{ n: 1, status: "done", file: "TC-01_t1.mp4", portraitHfId: "hf-0" }], chosen: 1, staleReason: "portrait", voiceoverChanged: true });
  const state = ready({ assets: [done] });
  let el = card(cardModel(done, state.assets, { state, transcript: TR, estimates: { clips: { 5: 20 } } }), { layout: "script" }, stub(calls));
  assert.match(textOf(el), /Made with an earlier portrait/);
  click(byText(el, "Keep anyway"));
  assert.deepEqual(calls.at(-1), ["keepAnyway", "TC-01"]);
  const fresh = tc();
  el = card(cardModel(fresh, [fresh], { state: ready(), transcript: TR, estimates: { clips: { 5: 20 } } }), { layout: "script" }, stub(calls));
  click(byText(el, "Make clip (≈20 credits)"));
  assert.deepEqual(calls.at(-1), ["first", "TC-01"]);
  // Redo note box shows the cost on its button.
  el = card(cardModel(done, state.assets, { state, transcript: TR, estimates: { clips: { 5: 20 } } }), { layout: "script", noteFor: "TC-01" }, stub(calls));
  assert.ok(byText(el, "Redo with note (≈20 credits)"));
}));

test("conflict card DOM: the note and Remove opens the confirm", () => withDom(() => {
  const calls = [];
  const b = { id: "HF-01", kind: "broll", tool: "higgsfield", line: "One is here.", lineIndex: 0, desc: "d", takes: [], chosen: 0, approved: false };
  const state = st({ assets: [b, tc()] });
  const el = card(cardModel(b, state.assets, { state }), { layout: "script" }, stub(calls));
  assert.match(textOf(el), /This line is on camera/);
  click(byText(el, "Remove"));
  assert.deepEqual(calls.at(-1), ["askRemove", "HF-01"]);
}));

const click = (el) => fire(el, "click");

test("summary counts b-roll shots only, not clips", () => {
  const b = { id: "HF-01", kind: "broll", tool: "higgsfield", line: "x y z w", lineIndex: 0, desc: "d", takes: [], chosen: 0, approved: true };
  const m = reviewModel({ film: { title: "F", dir: "D" }, state: ready({ assets: [tc({ approved: true }), tc({ id: "TC-02", lineId: "03" }), b] }), lineScript: LS });
  assert.deepEqual([m.summary.approved, m.summary.total], [1, 1]);
});
