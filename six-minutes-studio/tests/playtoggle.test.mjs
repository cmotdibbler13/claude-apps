import { test } from "node:test";
import assert from "node:assert/strict";
import { mixModel, playerKey } from "../js/ui/mix.js";

function withDom(fn) {
  const mk = (tag) => ({ tag, attrs: {}, children: [], listeners: {}, style: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; }, append(...k) { this.children.push(...k); } });
  globalThis.Node = class {};
  globalThis.document = { createElement: mk, createTextNode: (t) => ({ t }) };
  return Promise.resolve().then(fn).finally(() => { delete globalThis.document; delete globalThis.Node; });
}
const text = (el) => el.children.map((c) => c.t ?? "").join("");

test("a take's button plays, pauses, then carries on", () => withDom(async () => {
  const { playToggle } = await import("../js/ui/dom.js");
  const pressed = [];
  const acts = (paused) => ({ isPaused: () => paused, playTake: (f) => pressed.push(f) });
  const idle = playToggle("a.wav", false, "01.1", acts(false));
  assert.equal(idle.attrs["aria-label"], "Play 01.1");
  assert.equal(text(idle), "\u25B6");
  const going = playToggle("a.wav", true, "01.1", acts(false));
  assert.equal(going.attrs["aria-label"], "Pause 01.1");
  assert.equal(text(going), "\u275A\u275A");
  assert.equal(going.className, "nplay on");
  const paused = playToggle("a.wav", true, "01.1", acts(true));
  assert.equal(paused.attrs["aria-label"], "Resume 01.1");
  assert.equal(text(paused), "\u25B6");
  assert.equal(paused.attrs.title, "Carry on from here");
  paused.listeners.click();
  assert.deepEqual(pressed, ["a.wav"]);
}));

test("the voiceover and fitted score get player keys that change with each run", () => {
  const VOW = "S:\\f\\vo.wav", FITW = "S:\\f\\fit.wav";
  const state = (voAt, fitAt) => ({
    assets: [], audio: { score: { id: "SCORE", chosen: 1, takes: [{ n: 1, status: "done", file: "S:\\f\\s.wav" }] } },
    mix: { voiceover: { id: "VOICEOVER", status: "done", at: voAt, wav: VOW, lengthS: 10, takes: [] },
      fit: { id: "FIT", status: "done", at: fitAt, file: FITW, fromVoiceoverAt: voAt, scoreFile: "S:\\f\\s.wav", fromScoreTake: 1, takes: [] } },
  });
  const steps = (s) => Object.fromEntries(mixModel({ state: s, narration: { rows: [], counts: {} }, settings: { stemRemixer: true } }).steps.map((x) => [x.id, x]));
  const a = steps(state(1, 2)), b = steps(state(3, 4));
  assert.equal(a.VOICEOVER.playerKey, playerKey(VOW, 1));
  assert.equal(a.FIT.playerKey, playerKey(FITW, 2));
  assert.notEqual(a.VOICEOVER.playerKey, b.VOICEOVER.playerKey);
  assert.notEqual(a.FIT.playerKey, b.FIT.playerKey);
});
