import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { writeBlenderScript, makeBlenderRunner, blenderRunner } from "../js/tools/blender.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const OUT = DIR + "\\studio\\media\\HF-03_t2.mp4";
const SRC = DIR + "\\studio\\media\\HF-02_t1.png";
const settings = { videoModel: "kling3_0", imageModel: "gpt_image_2", blenderPath: "C:\\Blender\\blender.exe" };
const asset = { id: "HF-03", desc: "3D version of the harbour", line: "The harbour was quiet." };

function setup(spawnFn) {
  const host = new FakeHost();
  const calls = [];
  host.spawnScript((cmd, args, opts, p) => { calls.push({ cmd, args, opts }); return spawnFn(p, host); });
  const progress = [];
  const ctx = { host, progress: (p) => progress.push(p), setRef: () => {} };
  const job = { id: "j", tool: "blender", input: { kind: "blender", script: DIR + "\\studio\\blender\\HF-03_t2.py", sourceFile: SRC, out: OUT, frames: 100 } };
  return { host, calls, progress, ctx, job, runner: makeBlenderRunner({ settings }) };
}

test("lane is gpu; default runner exported", () => {
  assert.equal(blenderRunner.lane, "gpu");
  assert.equal(makeBlenderRunner({ settings }).lane, "gpu");
  assert.equal(blenderRunner.resume, undefined);
});

test("progress follows Fra lines", async () => {
  const t = setup(async (p, host) => {
    p.out("Fra:10 Mem:5M\nFra:50 Mem:5M | Time\n");
    p.err("Fra:250 odd");
    await host.fs.mkdir(DIR + "\\studio\\media");
    await host.fs.write(OUT, "x");
    p.exit(0);
  });
  const r = await t.runner.start(t.job, t.ctx);
  assert.deepEqual(r, { file: OUT });
  assert.deepEqual(t.progress, [0.1, 0.5, 1]);
});

test("progress handles lines split across chunks", async () => {
  const t = setup(async (p, host) => {
    p.out("Fra:2"); p.out("0 Mem\n");
    await host.fs.mkdir(DIR + "\\studio\\media"); await host.fs.write(OUT, "x");
    p.exit(0);
  });
  await t.runner.start(t.job, t.ctx);
  assert.deepEqual(t.progress, [0.2]);
});

test("script path and args are passed after --", async () => {
  const t = setup(async (p, host) => { await host.fs.mkdir(DIR + "\\studio\\media"); await host.fs.write(OUT, "x"); p.exit(0); });
  await t.runner.start(t.job, t.ctx);
  assert.equal(t.calls[0].cmd, settings.blenderPath);
  assert.deepEqual(t.calls[0].args, ["-b", "-P", t.job.input.script, "--", SRC, OUT]);
});

test("non-zero exit marks take failed with log tail", async () => {
  const t = setup(async (p) => {
    for (let i = 1; i <= 30; i++) p.out(`line ${i}\n`);
    p.exit(1);
  });
  await assert.rejects(t.runner.start(t.job, t.ctx), (e) => {
    assert.match(e.message, /line 30/);
    assert.match(e.message, /line 11/);
    assert.doesNotMatch(e.message, /line 10\b/);
    return true;
  });
});

test("exit 0 without output file fails", async () => {
  const t = setup(async (p) => { p.out("done\n"); p.exit(0); });
  await assert.rejects(t.runner.start(t.job, t.ctx), /no output file|didn't write/i);
});

test("exit code null means Blender didn't start", async () => {
  const t = setup(async (p) => { p.err("spawn blender ENOENT"); p.exit(null); });
  await assert.rejects(t.runner.start(t.job, t.ctx), /^Error: Blender didn't start: spawn blender ENOENT\. Check the Blender path in \.studio-settings\.json\.$/);
});

test("writeBlenderScript writes script, sends no output path, validates", async () => {
  const host = new FakeHost();
  const store = await openFilm(host, DIR);
  const seen = [];
  host.claudeScript((kind, input, opts) => { seen.push({ input, opts }); return { script: "import bpy\n", frames: 240 }; });
  let frames;
  const p = await writeBlenderScript(host, store, asset, 2, { onFrames: (f) => (frames = f) });
  assert.equal(frames, 240);
  assert.equal(p, DIR + "\\studio\\blender\\HF-03_t2.py");
  assert.equal(await host.fs.read(p, "utf8"), "import bpy\n");
  assert.equal(seen[0].opts.tier, "default");
  assert.match(seen[0].input, /sys\.argv/);
  assert.match(seen[0].input, /"take":2/);
  assert.match(seen[0].input, /HF-03/);
});

test("redo uses quick tier and sends previous script and note", async () => {
  const host = new FakeHost();
  const store = await openFilm(host, DIR);
  const seen = [];
  host.claudeScript((kind, input, opts) => { seen.push({ input, opts }); return { script: "s2", frames: 48 }; });
  await writeBlenderScript(host, store, asset, 3, { note: "slower camera", previous: "OLD SCRIPT" });
  assert.equal(seen[0].opts.tier, "quick");
  assert.match(seen[0].input, /slower camera/);
  assert.match(seen[0].input, /OLD SCRIPT/);
});

test("writeBlenderScript rejects bad replies and writes nothing", async () => {
  for (const bad of [{ script: "", frames: 10 }, { script: "x", frames: 0 }, { script: "x", frames: 2401 }, { script: "x", frames: 1.5 }, { script: 5, frames: 10 }]) {
    const host = new FakeHost();
    const store = await openFilm(host, DIR);
    host.claudeScript(() => bad);
    await assert.rejects(writeBlenderScript(host, store, asset, 1), (e) => e.code === "invalid");
    assert.equal(await host.fs.exists(DIR + "\\studio\\blender\\HF-03_t1.py"), false);
  }
});
