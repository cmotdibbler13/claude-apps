import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCosts } from "../js/oncamcosts.js";
import { portraitParams, portraitPrompt, clipParams, clipPrompt } from "../js/presenter.js";

const LOOK = { outfit: "a navy blazer", set: "a reading room", at: 1 };
const TR = { sentences: [{ sentence: "01", start: 0, end: 5 }, { sentence: "03", start: 9, end: 16.5 }] };
const state = (o = {}) => ({ presenter: { lines: [{ id: "01" }], look: LOOK }, assets: [{ id: "TC-01", kind: "presenter", lineId: "01" }, { id: "TC-02", kind: "presenter", lineId: "03" }], ...o });
const tick = () => new Promise((r) => setImmediate(r));
function fake(answer) {
  const calls = [];
  return { calls, estimate: (tool, input) => { calls.push([tool, input]); return Promise.resolve(answer(tool)); } };
}

test("asks once per portrait prompt and per clip length; loading reads undefined, then the answer", async () => {
  const f = fake((t) => (t === "estimate_image_cost" ? 6 : 20));
  const c = makeCosts(f.estimate);
  let changed = 0;
  c.ask({ state: state(), transcript: TR }, () => { changed++; });
  assert.deepEqual(c.view(), { portrait: undefined, clips: {} });
  await tick();
  assert.deepEqual(c.view(), { portrait: 6, clips: { 5: 20, 8: 20 } });
  assert.ok(changed >= 1);
  assert.deepEqual(f.calls.map((x) => x[0]).sort(), ["estimate_image_cost", "estimate_video_cost", "estimate_video_cost"]);
  assert.deepEqual(f.calls.find((x) => x[0] === "estimate_image_cost")[1], { params: portraitParams(portraitPrompt(LOOK)) });
  assert.ok(f.calls.some((x) => JSON.stringify(x[1]) === JSON.stringify({ params: clipParams({ seconds: 8, prompt: clipPrompt() }) })));
  c.ask({ state: state(), transcript: TR }, () => {});
  await tick();
  assert.equal(f.calls.length, 3);
  // A new look asks the portrait cost again.
  c.ask({ state: state({ presenter: { lines: [{ id: "01" }], look: { ...LOOK, set: "a harbour" } } }), transcript: TR }, () => {});
  assert.equal(c.view().portrait, undefined);
  await tick();
  assert.equal(f.calls.length, 4);
});

test("a reopened review asks again: reset drops a stuck (cost unknown) and late answers from before", async () => {
  let ans = null;
  const f = fake(() => ans);
  const c = makeCosts(f.estimate);
  c.ask({ state: state(), transcript: TR }, () => {});
  await tick();
  assert.deepEqual(c.view(), { portrait: null, clips: { 5: null, 8: null } });
  c.reset();
  ans = 7;
  c.ask({ state: state(), transcript: TR }, () => {});
  await tick();
  assert.deepEqual(c.view(), { portrait: 7, clips: { 5: 7, 8: 7 } });
  assert.equal(f.calls.length, 6);
  // An answer to a request made before reset is ignored.
  let release;
  const slow = makeCosts(() => new Promise((r) => { release = r; }));
  slow.ask({ state: state({ assets: [] }), transcript: TR }, () => {});
  slow.reset();
  release(99);
  await tick();
  assert.equal(slow.view().portrait, undefined);
});

test("forgetClips asks clip costs again; nothing is asked without chosen lines", async () => {
  const f = fake(() => 3);
  const c = makeCosts(f.estimate);
  c.ask({ state: state({ presenter: { lines: [] } }), transcript: TR }, () => {});
  assert.equal(f.calls.length, 0);
  c.ask({ state: state(), transcript: TR }, () => {});
  await tick();
  c.forgetClips();
  assert.deepEqual(c.view().clips, {});
  c.ask({ state: state(), transcript: TR }, () => {});
  await tick();
  assert.equal(f.calls.length, 5);
});
