import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { handoverFacts, checkFiles, sfxCues, mixSettings, renderHandover, openingMessage } from "../js/part2handover.js";

const DIR = "S:\\Youtube video ideas\\Christmas Tree";
const take = (n, file, o = {}) => ({ n, file, status: "done", ...o });
const state = () => ({
  assets: [
    { id: "HF-01", kind: "broll", tool: "higgsfield", line: "L1", approved: true, chosen: 2, takes: [take(1, "a1.mp4", { hfId: "x" }), take(2, `${DIR}\\studio\\media\\HF-01_2.mp4`, { hfId: "hf-job-1" })] },
    { id: "HF-02", kind: "blender", tool: "blender", line: "L2", approved: true, chosen: 1, takes: [take(1, `${DIR}\\studio\\media\\HF-02_1.mp4`, { script: `${DIR}\\studio\\scripts\\HF-02.py` })] },
    { id: "HF-03", kind: "animated", tool: "comfyui", line: "L3", approved: true, chosen: 1, takes: [take(1, `${DIR}\\studio\\media\\HF-03_1.mp4`, { local: { workflow: "S:\\w\\broll_ltx.json", seed: 42 } })] },
    { id: "HF-04", kind: "lineart", tool: "higgsfield", line: "L4", approved: true, chosen: 1, takes: [take(1, `${DIR}\\studio\\media\\HF-04_1.png`, {}), { n: 2, status: "failed", tool: "higgsfield" }] },
    { id: "TC-01", kind: "presenter", tool: "higgsfield", lineId: "L5", line: "Said to camera", approved: true, chosen: 1, takes: [take(1, `${DIR}\\studio\\media\\TC-01_1.mp4`, { jobId: "j9" })] },
  ],
  presenter: { portrait: { n: 1, hfId: "port-1", file: `${DIR}\\studio\\media\\portrait.png`, approved: true } },
  audio: {
    flowId: "flow-1",
    score: { id: "SCORE", approved: true, chosen: 1, node: { id: "n-score" }, takes: [take(1, `${DIR}\\studio\\audio\\score_1.mp3`, { source: "elevenlabs" })] },
    sfx: [{ id: "SFX-01", cue: "door", approved: true, chosen: 1, startS: 12.5, loop: true, node: { id: "n-sfx1" }, takes: [take(1, `${DIR}\\studio\\audio\\sfx1.wav`, { source: "stableaudio" })] }],
  },
  mix: {
    voiceover: { status: "done", wav: `${DIR}\\studio\\voiceover\\v.wav`, csv: `${DIR}\\studio\\voiceover\\v.csv`, transcript: `${DIR}\\studio\\voiceover\\v.json` },
    fit: { status: "done", file: `${DIR}\\studio\\fit\\fit.wav`, measureFile: `${DIR}\\studio\\fit\\measure.json` },
    mix: { status: "done", approved: true, files: { wav: `${DIR}\\studio\\mix\\m.wav`, mp3: `${DIR}\\studio\\mix\\m.mp3` }, sfx: [{ id: "SFX-01", gainDb: -3.5 }] },
  },
});
const args = (o = {}) => ({
  state: state(), dir: DIR, root: "S:\\Youtube video ideas",
  lineScript: { name: "christmas_tree", path: `${DIR}\\narration\\christmas_tree_line_script.txt` },
  part1: { topic: "Christmas Trees", episode: "012" }, jobs: [{ id: "j9", jobRef: "hf-clip-9" }],
  brIds: new Map([["HF-01", "BR-602"], ["HF-02", "BR-603"]]),
  settings: { autocueRecordings: "C:\\Rec" },
  transcript: { sentences: [{ sentence: "L5", start: 30.04, end: 36.5 }] }, ...o,
});

test("facts: project, voice and every group", () => {
  const f = handoverFacts(args());
  assert.deepEqual(f.project, { film: "Christmas Tree", topic: "Christmas Trees", prefix: "christmas_tree", episode: "012", folder: DIR });
  assert.deepEqual(f.voice, { kind: "own", recordings: "C:\\Rec\\christmas_tree" });
  assert.deepEqual([...new Set(f.files.map((x) => x.group))], ["Voiceover", "Score", "Sound effects", "Mix preview", "B-roll and art", "On camera"]);
  const br = f.files.filter((x) => x.group === "B-roll and art");
  assert.match(br[0].label, /HF-01 \(BR-602\)/);
  assert.equal(br[0].path, `${DIR}\\studio\\media\\HF-01_2.mp4`);
  assert.equal(br.length, 4);
  const tc = f.files.find((x) => x.label.startsWith("TC-01"));
  assert.match(tc.label, /line L5, film time 30.04–36.5 s/);
  assert.match(tc.note, /mute the clip: the voice is already in the voiceover/);
  assert.ok(f.files.some((x) => x.label === "Approved portrait"));
  assert.ok(f.files.some((x) => x.path.endsWith("sfx_cues.json") && x.extra));
});

test("facts: ids, usage, cloned voice", () => {
  const f = handoverFacts(args());
  const v = (l) => f.ids.find((i) => i.label === l)?.value;
  assert.equal(v("HF-01 take 2"), "hf-job-1");
  assert.match(v("HF-02 take 1"), /^made locally \(Blender\): script .*HF-02\.py$/);
  assert.equal(v("HF-03 take 1"), "made locally (ComfyUI): workflow broll_ltx.json, seed 42");
  assert.equal(v("TC-01 take 1"), "hf-clip-9");
  assert.equal(v("Portrait"), "port-1");
  assert.equal(v("ElevenLabs flow"), "flow-1");
  assert.equal(v("Score node"), "n-score");
  assert.equal(f.usage.find((u) => u.tool === "higgsfield").takes, 5);
  assert.equal(f.usage.find((u) => u.tool === "blender").takes, 1);
  const c = handoverFacts(args({ lineScript: null }));
  assert.deepEqual(c.voice, { kind: "cloned", recordings: "S:\\Youtube video ideas\\voice files" });
});

test("facts: unrecorded ids and ComfyUI seed", () => {
  const s = state();
  s.assets[0].takes[1].hfId = undefined;
  s.assets[2].takes[0].local = undefined;
  const f = handoverFacts(args({ state: s }));
  assert.equal(f.ids.find((i) => i.label === "HF-01 take 2").value, "not recorded");
  assert.equal(f.ids.find((i) => i.label === "HF-03 take 1").value, "made locally (ComfyUI): workflow not recorded, seed not recorded");
});

test("missing episode: shown and an open item", () => {
  const f = handoverFacts(args({ part1: { topic: "Christmas Trees", episode: null } }));
  assert.equal(f.project.episode, null);
  assert.ok(f.warnings.includes("Episode: not found in part1_handover.md"));
  const md = renderHandover(f, { decisions: [], openItems: [] });
  assert.match(md, /- Episode: not found in part1_handover\.md/);
  assert.match(md.split("## Open items")[1], /Episode: not found in part1_handover\.md/);
});

test("checkFiles throws on the first missing file (Review Focus 3)", async () => {
  const host = new FakeHost();
  const f = handoverFacts(args());
  for (const x of f.files) if (!x.extra && !x.path.includes("HF-02") && !x.path.includes("TC-01")) { host.files.set(x.path.replace(/\\/g, "/").toLowerCase(), "x"); }
  await assert.rejects(checkFiles(host, f.files), (e) => /^Missing file: .*HF-02_1\.mp4$/.test(e.message));
  await assert.doesNotReject(checkFiles(host, []));
});

test("sfxCues and mixSettings shapes", () => {
  const s = state();
  const cues = sfxCues(s, [{ id: "jm", input: { sfx: [{ id: "SFX-01", endS: 40 }] } }]);
  assert.deepEqual(cues, [{ id: "SFX-01", file: `${DIR}\\studio\\audio\\sfx1.wav`, startS: 12.5, loop: true, endS: null, gainDb: -3.5 }]);
  s.mix.mix.jobId = "jm";
  assert.equal(sfxCues(s, [{ id: "jm", input: { sfx: [{ id: "SFX-01", endS: 40 }] } }])[0].endS, 40);
  s.audio.sfx[0].approved = false;
  assert.deepEqual(sfxCues(s), []);
  const m = mixSettings(state(), { mixMusicDb: -24 });
  assert.deepEqual(Object.keys(m), ["mixMusicDb", "mixSfxDb", "ride", "voiceover", "score"]);
  assert.equal(m.mixMusicDb, -24);
  assert.equal(m.mixSfxDb, -18);
  assert.equal(m.score.file, `${DIR}\\studio\\fit\\fit.wav`);
});

test("rendered markdown: headings in order, groups, exact opening message", () => {
  const f = handoverFacts(args());
  const md = renderHandover(f, { decisions: ["Take 2 of HF-01"], openItems: ["Check HF-05"] });
  const heads = md.split("\n").filter((l) => /^#{1,2} /.test(l));
  assert.deepEqual(heads, ["# Part 2 handover: Six minutes on… Christmas Trees", "## Project details", "## Voice choice", "## His decisions", "## File index", "## Settings and IDs", "## Open items", "## Usage", "## Opening message"]);
  assert.deepEqual(md.split("\n").filter((l) => l.startsWith("### ")), ["### Voiceover", "### Score", "### Sound effects", "### Mix preview", "### B-roll and art", "### On camera"]);
  assert.match(md, /- Take 2 of HF-01/);
  assert.match(md, /- higgsfield: 5 takes/);
  const msg = `Part 3 of Six minutes on… Christmas Trees. Load /documentary-explainer-video, read ${DIR}\\handover\\part2_handover.md, and carry on.`;
  assert.equal(openingMessage("Christmas Trees", DIR), msg);
  assert.ok(md.trimEnd().endsWith("```\n" + msg + "\n```"));
});

test("no silent gaps: an item without a file is an error naming it", () => {
  const miss = (edit, re) => { const s = state(); edit(s); assert.throws(() => handoverFacts(args({ state: s })), (e) => re.test(e.message)); };
  miss((s) => { s.assets[2].takes[0].status = "failed"; }, /^Missing file: HF-03 chosen take$/);
  miss((s) => { s.assets[4].takes[0].file = ""; }, /^Missing file: TC-01 chosen take$/);
  miss((s) => { delete s.mix.voiceover.csv; }, /^Missing file: the voiceover timings$/);
  miss((s) => { delete s.mix.fit.file; }, /^Missing file: the fitted score$/);
  miss((s) => { s.audio.sfx[0].takes[0].status = "failed"; }, /^Missing file: SFX-01 chosen take$/);
  miss((s) => { s.mix.mix.files = null; }, /^Missing file: the mix preview$/);
});

test("rendered file index: On camera line with mute text and path; checkFiles skips extras", async () => {
  const md = renderHandover(handoverFacts(args()), { decisions: [], openItems: [] });
  assert.ok(md.includes(`- TC-01, line L5, film time 30.04–36.5 s: ${DIR}\\studio\\media\\TC-01_1.mp4 (mute the clip: the voice is already in the voiceover)`));
  await assert.doesNotReject(checkFiles(new FakeHost(), [{ group: "Score", label: "x", path: "S:\\nowhere\\mix_settings.json", extra: true }]));
  await assert.rejects(checkFiles(new FakeHost(), [{ group: "Score", label: "x", path: "S:\\nowhere\\a.wav" }]), /^Error: Missing file: S:\\nowhere\\a\.wav$/);
});
