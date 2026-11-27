import { test } from "node:test";
import assert from "node:assert/strict";
import { part2Readiness, leftText, hfJobIdFor } from "../js/part2.js";

const shot = (id, o = {}) => ({ id, kind: "broll", line: `L${id}`, approved: true, takes: [], chosen: 1, ...o });
const clip = (id, o = {}) => ({ id, kind: "presenter", line: `Line ${id} said to camera by Jon now`, approved: true, takes: [], chosen: 1, ...o });
const good = (o = {}) => ({
  assets: [shot("HF-01"), shot("HF-02")],
  audio: { score: { approved: true, chosen: 1 }, sfx: [{ id: "SFX-01", approved: true }] },
  mix: {
    voiceover: { status: "done", at: 10, takes: [] },
    fit: { status: "done", at: 20, fromVoiceoverAt: 10, fromScoreTake: 1, takes: [] },
    mix: { status: "done", approved: true, at: 30, fromFitAt: 20, fromVoiceoverAt: 10, fromSfx: [], takes: [] },
  },
  ...o,
});

test("ready when everything is approved", () => {
  const r = part2Readiness(good());
  assert.deepEqual(r, { ready: true, left: [], warnings: [] });
});

test("left items, in order, with counts", () => {
  const s = {
    assets: [shot("HF-01", { approved: false }), shot("HF-02", { kind: "lineart", approved: false }), shot("HF-03"), clip("TC-01", { approved: false })],
    presenter: {},
    audio: { score: { approved: false }, sfx: [{ id: "a", approved: false }, { id: "b", approved: false }, { id: "c", approved: true }] },
    mix: {},
  };
  const r = part2Readiness(s);
  assert.equal(r.ready, false);
  assert.deepEqual(r.left, ["2 shots", "the portrait", "1 clip", "the score", "2 sound effects", "the voiceover join", "the mix"]);
});

test("singular forms", () => {
  const s = good({ assets: [shot("HF-01", { approved: false })], audio: { score: { approved: true, chosen: 1 }, sfx: [{ id: "a", approved: false }] } });
  assert.deepEqual(part2Readiness(s).left, ["1 shot", "1 sound effect"]);
});

test("portrait only counts when the film has clips; approved portrait is fine", () => {
  assert.ok(!part2Readiness(good()).left.includes("the portrait"));
  const withClip = good({ assets: [shot("HF-01"), clip("TC-01")] });
  assert.deepEqual(part2Readiness(withClip).left, ["the portrait"]);
  withClip.presenter = { portrait: { hfId: "p", approved: true } };
  assert.equal(part2Readiness(withClip).ready, true);
});

test("removed shots and b-roll on to-camera lines don't count", () => {
  const line = "this is the line said to camera by Jon";
  const s = good({
    assets: [shot("HF-01"), shot("HF-02", { approved: false, line }), clip("TC-01", { line }), shot("HF-03", { approved: false, removedAt: 5 })],
    presenter: { portrait: { approved: true } },
    removed: [shot("HF-03", { approved: false })],
  });
  assert.equal(part2Readiness(s).ready, true);
});

test("mix unapproved or out of date is left; voiceover missing is left", () => {
  const s = good();
  s.mix.mix.approved = false;
  assert.deepEqual(part2Readiness(s).left, ["the mix"]);
  const t = good();
  t.mix.voiceover.at = 11; // fit and mix were made from the older join
  assert.deepEqual(part2Readiness(t).left, ["the mix"]);
  const u = good();
  delete u.mix.voiceover;
  assert.ok(part2Readiness(u).left.includes("the voiceover join"));
});

test("warnings: clips out of step / earlier portrait, flagged lines joined anyway", () => {
  const s = good({ assets: [shot("HF-01"), clip("TC-01", { voiceoverChanged: true }), clip("TC-02", { staleReason: "portrait" }), clip("TC-03", { approved: false, voiceoverChanged: true })], presenter: { portrait: { approved: true } } });
  s.mix.voiceover.allowFlagged = true;
  const r = part2Readiness(s);
  assert.deepEqual(r.left, ["1 clip"]);
  assert.equal(r.warnings.length, 3);
  assert.match(r.warnings[0], /TC-01/);
  assert.match(r.warnings[1], /TC-02/);
  assert.match(r.warnings[2], /flagged/);
});

test("leftText sentences", () => {
  assert.equal(leftText(["3 shots", "the score", "2 sound effects"]), "3 shots, the score and 2 sound effects still to approve");
  assert.equal(leftText(["the mix"]), "the mix still to approve");
  assert.equal(leftText(["1 shot", "the mix"]), "1 shot and the mix still to approve");
  assert.equal(leftText([]), "");
});

test("hfJobIdFor", () => {
  assert.equal(hfJobIdFor({ hfId: "abc", jobId: "j1" }, [{ id: "j1", jobRef: "zzz" }]), "abc");
  assert.equal(hfJobIdFor({ jobId: "j1" }, [{ id: "j0", jobRef: "no" }, { id: "j1", jobRef: "zzz" }]), "zzz");
  assert.equal(hfJobIdFor({ jobId: "j9" }, [{ id: "j1", jobRef: "zzz" }]), null);
  assert.equal(hfJobIdFor({}, []), null);
  assert.equal(hfJobIdFor({ jobId: "j1" }, [{ id: "j1" }]), null);
});
