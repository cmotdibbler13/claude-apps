import { test } from "node:test";
import assert from "node:assert/strict";

function withDom(fn, storage) {
  const mk = (tag) => {
    const el = { tag, attrs: {}, children: [], listeners: {}, style: {}, className: "", hidden: false,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
      append(...k) { this.children.push(...k); },
      set textContent(v) { this.children = [{ t: v }]; }, get textContent() { return ""; } };
    Object.setPrototypeOf(el, globalThis.Node.prototype);
    return el;
  };
  globalThis.Node = class {};
  globalThis.document = { createElement: mk, createTextNode: (t) => ({ t }) };
  globalThis.localStorage = storage;
  return Promise.resolve().then(fn).finally(() => { delete globalThis.document; delete globalThis.Node; delete globalThis.localStorage; });
}
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
const fire = (el, k) => { for (const f of el.listeners?.[k] ?? []) f({}); };

test("sections are open by default and a toggle is remembered", () => withDom(async () => {
  const { isFolded, setFolded } = await import("../js/ui/fold.js?a");
  assert.equal(isFolded("Narration"), false);
  setFolded("Narration", true);
  assert.equal(globalThis.localStorage.getItem("studio.fold.Narration"), "1");
  assert.equal(isFolded("Narration"), true);
  setFolded("Narration", false);
  assert.equal(isFolded("Narration"), false);
}, memStore()));

test("a blocked localStorage: open by default, toggling works for the session", () => withDom(async () => {
  const { isFolded, setFolded } = await import("../js/ui/fold.js?b");
  assert.equal(isFolded("Score"), false);
  setFolded("Score", true);
  assert.equal(isFolded("Score"), true);
}, throwing));

test("foldable hides everything but the heading, keeps it mounted, and the button toggles", () => withDom(async () => {
  const { foldable } = await import("../js/ui/fold.js?c");
  const { h } = await import("../js/ui/dom.js");
  const audio = h("audio");
  const sec = h("section", {}, h("div", { class: "h2row" }, h("h2", { text: "Voiceover and mix" })), h("div", {}, audio), h("p", { text: "x" }));
  foldable(sec, "Voiceover and mix");
  const row = sec.children[0];
  const btn = row.children.find((c) => c.tag === "button");
  assert.equal(btn.attrs["aria-label"], "Fold Voiceover and mix");
  assert.equal(btn.attrs["aria-expanded"], "true");
  fire(btn, "click");
  assert.equal(sec.children[1].hidden, true);
  assert.equal(sec.children[2].hidden, true);
  assert.equal(row.hidden, false);
  assert.ok(sec.children[1].children.includes(audio)); // still mounted, so the prompter can keep playing
  assert.equal(btn.attrs["aria-label"], "Unfold Voiceover and mix");
  assert.equal(btn.attrs["aria-expanded"], "false");
  fire(btn, "click");
  assert.equal(sec.children[1].hidden, false);
}, memStore()));

test("a folded section renders folded next time", () => withDom(async () => {
  const { foldable, setFolded } = await import("../js/ui/fold.js?d");
  const { h } = await import("../js/ui/dom.js");
  setFolded("B-roll", true);
  const sec = h("section", {}, h("div", { class: "h2row" }, h("h2", { text: "B-roll" })), h("div", {}));
  foldable(sec, "B-roll");
  assert.equal(sec.children[1].hidden, true);
}, memStore()));
