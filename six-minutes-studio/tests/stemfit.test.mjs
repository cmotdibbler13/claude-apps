import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeStemFitRunner, MSG_NO_STEM_REMIXER } from "../js/tools/stemfit.js";

const SR = "C:\\Apps\\Stem Remixer";
const PY = SR + "\\.venv\\Scripts\\python.exe";
const MEDIA = "S:\\Film A\\studio\\media";
const MIX = "S:\\Film A\\studio\\mix";
const SCORE = MEDIA + "\\film_a_score_t2.wav";
const OUT = MIX + "\\film_a_score_fitted.wav";
const MEASURE = { done: true, duration_s: 200, loud: [-20, -19], beats: [0.5, 1], bpm: 120, moves: [] };
const PLAN = { steps: [{ from_s: 0, to_s: 100, tempo: 1, xfade_s: 0.03 }, { from_s: 120, to_s: 200, tempo: 1.05, xfade_s: 2.5 }] };

async function setup(script, settings = { stemRemixerDir: SR }) {
  const host = new FakeHost();
  await host.fs.mkdir(MEDIA);
  await host.fs.write(SCORE, "score");
  const spawns = [], progress = [];
  host.spawnScript((cmd, args, opts, p) => { spawns.push({ cmd, args, opts }); script(cmd, args, p, host); });
  const runner = makeStemFitRunner({ settings });
  return { host, spawns, progress, runner, ctx: { host, progress: (v) => progress.push(v) } };
}
const measureScript = (cmd, args, p) => { p.out('{"progress":0.5,"text":"Beats"}\n'); p.out(JSON.stringify(MEASURE) + "\n"); p.exit(0); };

test("no stemRemixerDir gives the exact message", async () => {
  const s = await setup(() => {}, { stemRemixerDir: null });
  await assert.rejects(s.runner.start({ input: { score: SCORE, measureOnly: true } }, s.ctx), { message: MSG_NO_STEM_REMIXER });
  assert.equal(MSG_NO_STEM_REMIXER, "Set where Stem Remixer is (stemRemixerDir in .studio-settings.json, or the Probe screen).");
  assert.equal(s.spawns.length, 0);
});

test("measureOnly runs measure.py with the .venv python and caches the JSON beside the score", async () => {
  const s = await setup(measureScript);
  const r = await s.runner.start({ input: { score: SCORE, measureOnly: true } }, s.ctx);
  assert.equal(s.spawns.length, 1);
  assert.equal(s.spawns[0].cmd, PY);
  assert.deepEqual(s.spawns[0].args, [SR + "\\measure.py", SCORE]);
  assert.equal(s.spawns[0].opts.cwd, SR);
  assert.deepEqual(s.progress, [0.5]);
  const cache = SCORE + ".measure.json";
  assert.equal(r.file, cache);
  assert.equal(r.meta.measureFile, cache);
  const { done, ...rest } = MEASURE; void done;
  assert.deepEqual(JSON.parse(await s.host.fs.read(cache, "utf8")), rest);
});

test("fit writes plan.json in the mix folder, runs fit.py, then measures the fitted score", async () => {
  const s = await setup((cmd, args, p, host) => {
    if (args[0].endsWith("fit.py")) {
      p.out('{"progress":0.5,"text":"Rendering"}\n');
      host.fs.write(OUT, "fitted").then(() => { p.out(JSON.stringify({ done: true, out: OUT, length_s: 200.2 }) + "\n"); p.exit(0); });
    } else measureScript(cmd, args, p);
  });
  const r = await s.runner.start({ input: { score: SCORE, plan: PLAN, out: OUT } }, s.ctx);
  assert.deepEqual(s.spawns.map((x) => x.args), [[SR + "\\fit.py", SCORE, MIX + "\\plan.json", OUT], [SR + "\\measure.py", OUT]]);
  assert.deepEqual(JSON.parse(await s.host.fs.read(MIX + "\\plan.json", "utf8")), PLAN);
  assert.equal(r.file, OUT);
  assert.equal(r.meta.lengthS, 200.2);
  assert.equal(r.meta.measureFile, OUT + ".measure.json");
  assert.ok(await s.host.fs.exists(OUT + ".measure.json"));
  assert.ok(s.progress[0] > 0.4 && s.progress[0] < 0.45, "fit progress scaled into the first part");
  assert.ok(s.progress.at(-1) > 0.9);
});

test("a second fit moves the earlier fitted score, its measure and plan aside", async () => {
  const s = await setup((cmd, args, p, host) => {
    if (args[0].endsWith("fit.py")) host.fs.write(OUT, "new").then(() => { p.out(JSON.stringify({ done: true, out: OUT, length_s: 1 })); p.exit(0); });
    else measureScript(cmd, args, p);
  });
  await s.host.fs.mkdir(MIX);
  await s.host.fs.write(OUT, "old");
  await s.host.fs.write(OUT + ".measure.json", "{}");
  await s.host.fs.write(MIX + "\\plan.json", "{}");
  await s.runner.start({ input: { score: SCORE, plan: PLAN, out: OUT } }, s.ctx);
  const names = (await s.host.fs.list(MIX)).map((e) => e.name).sort();
  assert.equal(names.filter((n) => /\.old-\d{8}-\d{6}/.test(n)).length, 3);
  assert.ok(names.some((n) => /^film_a_score_fitted\.old-\d{8}-\d{6}\.wav$/.test(n)));
  const old = names.find((n) => /^film_a_score_fitted\.old-.*\.wav$/.test(n));
  assert.equal(await s.host.fs.read(MIX + "\\" + old, "utf8"), "old");
  assert.equal(await s.host.fs.read(OUT, "utf8"), "new");
});

test("an error line from fit.py becomes the error", async () => {
  const s = await setup((cmd, args, p) => { p.out('{"error":"Could not fit the score: bad plan"}\n'); p.exit(1); });
  await assert.rejects(s.runner.start({ input: { score: SCORE, plan: PLAN, out: OUT } }, s.ctx), { message: "Could not fit the score: bad plan" });
});

test("resume asks for a fresh run", async () => {
  const s = await setup(() => {});
  await assert.rejects(s.runner.resume(), { message: "Interrupted; run it again." });
});
