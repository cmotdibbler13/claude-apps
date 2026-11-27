import { test } from "node:test";
import assert from "node:assert/strict";
import { lineAt } from "../js/ui/prompter.js";

function withDom(fn) {
  const mk = (tag) => {
    const el = { tag, attrs: {}, children: [], listeners: {}, style: {}, className: "", hidden: false,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
      removeEventListener(k, f) { this.listeners[k] = (this.listeners[k] || []).filter((g) => g !== f); },
      append(...k) { this.children.push(...k); },
      replaceChildren(...k) { this.children = k; },
      contains(x) { return x === this || this.children.some((c) => c?.contains?.(x)); },
      set textContent(v) { this.children = [{ t: v }]; }, get textContent() { return ""; } };
    Object.setPrototypeOf(el, globalThis.Node.prototype);
    el.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    return el;
  };
  globalThis.Node = class {};
  globalThis.document = { createElement: mk, createTextNode: (t) => ({ t }), activeElement: null };
  return Promise.resolve().then(fn).finally(() => { delete globalThis.document; delete globalThis.Node; });
}
const all = (el, pred, out = []) => {
  if (!el || typeof el !== "object") return out;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) all(c, pred, out);
  return out;
};
const textOf = (el) => (el.children ?? []).map((c) => (c.t ?? textOf(c))).join("");
const hasClass = (el, c) => String(el.className ?? "").split(" ").includes(c);
const fire = (el, k) => { for (const f of el.listeners?.[k] ?? []) f({}); };

const word = (i, w) => ({ i, word: w, key: `${w.toLowerCase()}#1`, mark: null, first: i === 0, last: false });
const LINES = [
  { id: "01.1", start: 0, end: 3, text: "Skara Brae", words: [word(0, "Skara"), word(1, "Brae")], gap: null, lost: [], note: "", reply: null, rerecord: false, newTake: false },
  { id: "01.2", start: 3.5, end: 6, text: "Pictish village", words: [word(0, "Pictish"), word(1, "village")], gap: null, lost: [], note: "", reply: null, rerecord: false, newTake: false },
  { id: "02.1", start: 7.7, end: 9, text: "The sea", words: [word(0, "The"), word(1, "sea")], gap: null, lost: [], note: "", reply: null, rerecord: false, newTake: false },
];
const M = { lines: LINES };
const audio = (t = 0, duration = 401) => {
  const el = { currentTime: t, duration, paused: true, listeners: {},
    addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
    removeEventListener(k, f) { this.listeners[k] = (this.listeners[k] || []).filter((g) => g !== f); },
    play() { this.paused = false; fire(this, "play"); return Promise.resolve(); }, pause() { this.paused = true; fire(this, "pause"); } };
  return el;
};
const acts = (calls = []) => ({
  markWord: (id, i) => calls.push(["markWord", id, i]), markGap: (id) => calls.push(["markGap", id]),
  openMark() {}, editMark() {}, setRerecord: (id, v) => calls.push(["rr", id, v]),
  saveNote: (id, v) => { calls.push(["note", id, v]); return true; },
  field: (k) => acts.fields.get(k), setField: (k, v) => { if (v === undefined) acts.fields.delete(k); else acts.fields.set(k, v); },
  rendering: () => false, seekReview() {},
});
acts.fields = new Map();

test("lineAt: before the first line, inside, and after the last", () => {
  assert.equal(lineAt(LINES, -1), 0);
  assert.equal(lineAt(LINES, 0.5), 0);
  assert.equal(lineAt(LINES, 4), 1);
  assert.equal(lineAt(LINES, 6.5), 1);
  assert.equal(lineAt(LINES, 500), 2);
});

test("the bar shows the first line before playback, and the time", () => withDom(async () => {
  const { prompterBar } = await import("../js/ui/prompter.js");
  const bar = prompterBar(M, acts());
  const a = audio(0);
  bar.attach(a);
  assert.equal(bar.el.hidden, false);
  assert.match(textOf(bar.el), /01\.1/);
  a.currentTime = 121; fire(a, "timeupdate");
  assert.match(textOf(bar.el), /02\.1/);
  assert.match(textOf(bar.el), /2:01 \/ 6:41/);
}));

test("next on the last line and previous on the first stay put", () => withDom(async () => {
  const { prompterBar } = await import("../js/ui/prompter.js");
  const bar = prompterBar(M, acts());
  const a = audio(8); bar.attach(a); fire(a, "timeupdate");
  const next = all(bar.el, (e) => e.attrs?.["aria-label"] === "Next line")[0];
  const prev = all(bar.el, (e) => e.attrs?.["aria-label"] === "Previous line")[0];
  fire(next, "click");
  assert.equal(a.currentTime, 8);
  fire(prev, "click");
  assert.equal(a.currentTime, 3.5); // 0.3 s into 02.1 → 01.2's start
}));

test("previous goes to the line before when just into a line, else to this line's start", () => withDom(async () => {
  const { prompterBar } = await import("../js/ui/prompter.js");
  const bar = prompterBar(M, acts());
  const prev = () => all(bar.el, (e) => e.attrs?.["aria-label"] === "Previous line")[0];
  const a = audio(4); bar.attach(a); fire(a, "timeupdate");
  fire(prev(), "click");
  assert.equal(a.currentTime, 0);       // 0.5 s into 01.2 → 01.1
  a.currentTime = 5.6; fire(a, "timeupdate");
  fire(prev(), "click");
  assert.equal(a.currentTime, 3.5);     // 2.1 s into 01.2 → its own start
  a.currentTime = 0.2; fire(a, "timeupdate");
  fire(prev(), "click");
  assert.equal(a.currentTime, 0);       // first line: stays at its start
}));

test("play and pause toggle the element", () => withDom(async () => {
  const { prompterBar } = await import("../js/ui/prompter.js");
  const bar = prompterBar(M, acts());
  const a = audio(0); bar.attach(a);
  const play = all(bar.el, (e) => hasClass(e, "pplay"))[0];
  fire(play, "click");
  assert.equal(a.paused, false);
  assert.equal(all(bar.el, (e) => hasClass(e, "pplay"))[0].attrs["aria-label"], "Pause");
  fire(all(bar.el, (e) => hasClass(e, "pplay"))[0], "click");
  assert.equal(a.paused, true);
}));

test("clicking a word in the bar adds a pause after it", () => withDom(async () => {
  const { prompterBar } = await import("../js/ui/prompter.js");
  const calls = [];
  const bar = prompterBar(M, acts(calls));
  bar.attach(audio(4));
  const w = all(bar.el, (e) => hasClass(e, "pword") && textOf(e) === "village")[0];
  fire(w, "click");
  assert.deepEqual(calls, [["markWord", "01.2", 1]]);
}));

test("the note box keeps typed text across updates and saves on blur", () => withDom(async () => {
  const { prompterBar } = await import("../js/ui/prompter.js");
  const calls = [];
  const a = acts(calls);
  const bar = prompterBar(M, a);
  const au = audio(4); bar.attach(au); fire(au, "timeupdate");
  const note = () => all(bar.el, (e) => e.tag === "textarea")[0];
  const ta = note();
  ta.value = "pause after Pictish"; fire(ta, "input");
  globalThis.document.activeElement = ta;
  au.currentTime = 8; fire(au, "timeupdate");   // the line changes while typing
  assert.equal(note(), ta);                      // the box stays
  globalThis.document.activeElement = null;
  fire(ta, "blur");
  assert.deepEqual(calls.at(-1), ["note", "01.2", "pause after Pictish"]);
}));

test("attach(null) hides the bar; the same element twice binds once", () => withDom(async () => {
  const { prompterBar } = await import("../js/ui/prompter.js");
  const bar = prompterBar(M, acts());
  const a = audio(0);
  bar.attach(a); bar.attach(a);
  assert.equal(a.listeners.timeupdate.length, 1);
  bar.attach(null);
  assert.equal(bar.el.hidden, true);
  assert.equal(a.listeners.timeupdate.length, 0);
}));
