import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { writeBlenderScript, makeBlenderRunner, blenderRunner, ensureVideoMediaType } from "../js/tools/blender.js";

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
  assert.deepEqual(t.calls[0].args, ["-b", "--python-exit-code", "1", "-P", t.job.input.script, "--", SRC, OUT]);
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

test("a pre-existing output is moved aside and cannot make a failed run pass", async () => {
  const t = setup(async (p) => { p.out("Traceback\n"); p.exit(0); });
  await t.host.fs.mkdir(DIR + "\\studio\\media");
  await t.host.fs.write(OUT, "partial");
  await assert.rejects(t.runner.start(t.job, t.ctx), /didn't write an output file/);
  assert.equal(await t.host.fs.exists(OUT), false);
  const stale = DIR + "\\studio\\media\\HF-03_t2.stale-" + t.host.now() + ".mp4";
  assert.equal(await t.host.fs.read(stale, "utf8"), "partial");
});

test("progress is reported only when it moves by at least 1 %", async () => {
  const t = setup(async (p, host) => {
    for (let i = 1; i <= 200; i++) p.out(`Fra:${i} Mem:1M | Rendering\nFra:${i} Mem:1M | Sample 1/64\n`);
    await host.fs.mkdir(DIR + "\\studio\\media");
    await host.fs.write(OUT, "x");
    p.exit(0);
  });
  t.job.input.frames = 200;
  await t.runner.start(t.job, t.ctx);
  assert.ok(t.progress.length <= 101, `reported ${t.progress.length} times`);
  assert.equal(t.progress.at(-1), 1);
});

// Seen on Jon's PC (Blender 5.2): enum "FFMPEG" not found until media_type is 'VIDEO'.
test("ensureVideoMediaType switches to video before FFMPEG, keeps indentation, leaves good scripts alone", () => {
  const bad = "import bpy\nscene = bpy.context.scene\nscene.render.image_settings.file_format = 'FFMPEG'\n";
  const fixed = ensureVideoMediaType(bad);
  assert.match(fixed, /if hasattr\(scene\.render\.image_settings, "media_type"\):\n    scene\.render\.image_settings\.media_type = 'VIDEO'\nscene\.render\.image_settings\.file_format = 'FFMPEG'/);
  const inner = "def setup(s):\n    img = s.render.image_settings\n    img.file_format = \"FFMPEG\"\n";
  assert.match(ensureVideoMediaType(inner), /    if hasattr\(img, "media_type"\):\n        img\.media_type = 'VIDEO'\n    img\.file_format = "FFMPEG"/);
  const good = "img.media_type = 'VIDEO'\nimg.file_format = 'FFMPEG'\n";
  assert.equal(ensureVideoMediaType(good), good);
  assert.equal(ensureVideoMediaType("img.file_format = 'PNG'\n"), "img.file_format = 'PNG'\n");
});

test("Run again on an old script adds the Blender 5 video switch before Blender starts", async () => {
  let seen = null;
  const t = setup(async (p, host) => { seen = await host.fs.read(t.job.input.script, "utf8"); await host.fs.mkdir(DIR + "\\studio\\media"); await host.fs.write(OUT, "x"); p.exit(0); });
  await t.host.fs.mkdir(DIR + "\\studio\\blender");
  await t.host.fs.write(t.job.input.script, "img = bpy.context.scene.render.image_settings\nimg.file_format = 'FFMPEG'\n");
  await t.runner.start(t.job, t.ctx);
  assert.match(seen, /img\.media_type = 'VIDEO'\nimg\.file_format = 'FFMPEG'/);
});
